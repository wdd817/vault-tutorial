# 第 13 章 审计设备：合规的底线

## 需求

> 安全审计问："我怎么证明**没有人**在凌晨三点读过生产库的管理员密码？"
>
> 你要能回答：**每一次请求和响应都被记录，且记录本身不可被悄悄篡改，敏感值不会明文落盘。**

Vault 的审计设备（audit device）就是为此存在的。它的定位是：**审计是 Vault 的一部分，不是可选项。**

## 动手

### 13.1 打开一个文件审计设备

```powershell
vault audit list
```

```text
No audit devices are enabled.
```

（注意：没有审计设备时，`vault audit list` 会打印这行并**返回退出码 2**，脚本里别把它当成致命错误。）

```powershell
vault audit enable file file_path="C:\vault\audit.log"
```

```text
Success! Enabled the file audit device at: file/
```

```powershell
vault audit list
```

```text
Path     Type    Description
----     ----    -----------
file/    file    n/a
```

带详细配置的查看：

```powershell
vault audit list -detailed
```

```text
Path     Type    Description    Replication    Options
----     ----    -----------    -----------    -------
file/    file    n/a            replicated     file_path=C:\vault\audit.log
```

> **注意**：审计设备**按路径**管理，`vault audit enable file ...` 默认落在 `file/`。第二次在同名路径启用会失败（`path already in use`）；想挂多个设备用 `-path`：
> ```powershell
> vault audit enable -path=file2 file file_path="D:\audit\vault2.log"
> ```
> （`-path` 是命令的 flag，必须写在设备类型 `file` **前面**——这是 PowerShell/CLI 的通用规则。）

### 13.2 看一眼审计日志长什么样

```powershell
vault kv put -mount=app audit-demo password=topsecret
vault kv get -mount=app audit-demo
```

审计日志是 **JSON Lines**（每行一条记录），一条请求会产生 `request` 和 `response` 两条。实测结构（截取关键字段）：

```json
{
  "auth": {
    "client_token": "hmac-sha256:e4733bde4a568dcaba48696419d3155cd153f5096c3c8e94839d1a70957860ba",
    "display_name": "token",
    "policies": ["root"],
    "policy_results": { "allowed": true, "granting_policies": [{"name": "root", "type": "acl"}] },
    "token_type": "service"
  },
  "request": {
    "client_id": "0DHqvq2D77kL2/JTPSZkTMJbkFVmUu0TzMi0jiXcFy8=",
    "client_token": "hmac-sha256:e4733bde...",
    "client_token_accessor": "hmac-sha256:7ef5a2a5...",
    "mount_point": "app/",
    "mount_type": "kv",
    "operation": "create",
    "path": "app/data/audit-demo",
    "remote_address": "127.0.0.1",
    "namespace": { "id": "root" },
    "data": { "data": { "password": "hmac-sha256:..." }, "options": {} }
  },
  "type": "request"
}
```

**关键结论（实测验证）**：

```text
audit lines=8  raw-secret-present=False  hmac-present=True
```

- 写入的明文 `topsecret` **不会**以明文出现在日志里；
- 值、token、accessor 都以 `hmac-sha256:<hash>` 形式记录；
- 但**路径、操作类型、时间、来源 IP、使用的策略**都是明文——这正是审计需要的"谁在何时碰了哪个路径"。

配套的两个字段特别有用：

| 字段 | 用途 |
| --- | --- |
| `policy_results.granting_policies` | **是哪个策略放行的**；排查"为什么这个 token 能读到"时一眼看出 |
| `client_token_accessor`（HMAC） | 可以把多次操作归并到同一个 token 上（用同一个 salt 计算即可比对） |

### 13.3 其他审计设备

```powershell
# syslog（Linux/macOS 常见，Windows 不支持）
vault audit enable syslog tag="vault" facility="AUTH"

# socket（发到远端日志收集器，例如 Fluentd / Vector）
vault audit enable socket address="10.0.0.9:8200" socket_type="tcp" log_raw=false

# 多设备并行：`vault audit enable -path=file2 file file_path=/var/log/vault2.log`
```

三种设备的取舍：

| 类型 | 特点 | 适用 |
| --- | --- | --- |
| `file` | 最简单，落本地磁盘 | 单机/起步阶段 |
| `syslog` | 接入系统日志设施 | Linux 服务器统一收集 |
| `socket` | 实时推送到日志平台 | 生产推荐（ELK/Loki/Splunk） |

### 13.4 一个重要但反直觉的事实：Vault 允许你关掉最后一个审计设备

实测：

```powershell
vault audit disable file
```

```text
Success! Disabled audit device (if it was enabled) at: file/
```

在 Vault 2.1.1 (OSS) 上，**关闭最后一个审计设备是成功的**（旧文档中"必须保留至少一个审计设备"的说法不能作为依赖）。这意味着：

> **"审计一直在开着"这件事必须靠制度和权限来保证，而不是靠 Vault 自己拦你。**

工程上的对策：

1. 把 `sys/audit/*` 的权限只给极少数管理身份；
2. 用外部监控定期断言审计设备仍然开启（例如每分钟调 `vault audit list`，发现为空就告警）；
3. 审计日志写到**Vault 机器之外**（socket/syslog 或挂载的远端卷），避免"删日志"和"关设备"一步到位。

### 13.5 审计日志的运维

- **轮转**：Vault 不会自动轮转 `file` 设备的日志。用 `logrotate`（Linux）或计划任务（Windows）+ **`SIGHUP`**（`kill -HUP <pid>`）让 Vault 重新打开文件句柄。
- **权限**：日志文件含路径与操作元数据（虽无明文密钥），应按敏感数据管理，限制读取。
- **容量**：每个请求两条 JSON（request + response），高频场景下量很大。先估算再决定 `socket` 收集还是本地落盘。
- **`log_raw`**：设为 `true` 会**记录未哈希的原始值**（包括密钥明文）。除非有强合规要求且已确保日志通道安全，否则**保持 false**。

## 原理：审计为什么"不可绕过"

```text
任何请求 ──▶ 认证 ──▶ 授权 ──▶ 引擎
                │        │        │
                └────────┴────────┴──▶ 审计设备（request 条目）
                                            │
                       引擎返回结果 ─────────┴──▶ 审计设备（response 条目）
                                            │
                                            ▼
                                  file / syslog / socket
```

三个设计保证：

1. **审计发生在 Vault 内部**，客户端无法选择"这次不记录"；
2. **敏感值 HMAC 化**，既能比对又不泄露内容；
3. **请求与响应分两条记录**，所以"操作成功/失败""返回了哪些字段名"都可追溯。

## 踩坑与检查清单

- **`vault audit list` 为空时退出码是 2**，脚本里要区分"没有设备"和"命令失败"。
- **`file` 设备不会自动轮转**，不做轮转迟早撑爆磁盘；轮转后记得 `SIGHUP`。
- **不要用 `log_raw=true`**（除非你明确需要明文并已保护日志通道）。
- **别把审计设备只放在 Vault 本机**：攻击者拿到 root 后第一步就是关审计、删日志。推到远端日志平台是第一优先。
- **`policy_results` 是排障神器**：它直接告诉你是哪条策略放行的。
- **审计失败会被拒绝**：如果所有审计设备都不可写，Vault 会拒绝处理请求（避免"静默不记录"）。生产上要监控审计设备的可用性——**这也是为什么配置第二个设备要谨慎**：多一个设备就多一个"写不进去就整体不可用"的风险点。

下一章开始进入生产话题：为什么 Vault 启动后是"锁着"的。
