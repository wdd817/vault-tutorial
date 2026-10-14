# 第 13 章 审计设备：合规的底线

## 需求

> 安全审计问："我怎么证明**没有人**在凌晨三点读过生产库的管理员密码？"
>
> 你要能回答：**每一次请求和响应都被记录，且记录本身不可被悄悄篡改，敏感值不会明文落盘。**

Vault 的审计设备（audit device）就是为此存在的。它的定位是：**审计是 Vault 的一部分，不是可选项。**

## 动手

### 13.1 打开一个文件审计设备

```bash
vault audit list
```

```text
No audit devices are enabled.
```

（注意：没有审计设备时，`vault audit list` 会打印这行并**返回退出码 2**，脚本里别把它当成致命错误。）

```bash
vault audit enable file file_path=/tmp/vault-audit.log
```

```text
Success! Enabled the file audit device at: file/
```

**踩坑：`file_path` 必须是 Vault 服务进程自己能写的路径。** enable 阶段 Vault 会先做一次 sanity check 写入，写不进去就当场失败、设备不会启用（`vault audit list` 依旧打印 `No audit devices are enabled.`，退出码 2）。以普通用户跑 dev server（本书的玩法）时照抄 `/var/log/vault-audit.log` 会得到：

```text
Error enabling audit device: Error making API request.

URL: PUT http://127.0.0.1:8200/v1/sys/audit/file
Code: 400. Errors:

* unable to create new audit backend: file sink creation failed for path "/var/log/vault-audit.log": sanity check failed; unable to open "/var/log/vault-audit.log" for writing: unable to open file for sink "/var/log/vault-audit.log": open /var/log/vault-audit.log: permission denied
```

```bash
vault audit list
```

```text
Path     Type    Description
----     ----    -----------
file/    file    n/a
```

带详细配置的查看：

```bash
vault audit list -detailed
```

```text
Path     Type    Description    Replication    Options
----     ----    -----------    -----------    -------
file/    file    n/a            replicated     file_path=/tmp/vault-audit.log
```

> **注意**：审计设备**按路径**管理，`vault audit enable file ...` 默认落在 `file/`。第二次在同名路径启用会失败（`path already in use`）；想挂多个设备用 `-path`：
> ```bash
> vault audit enable -path=file2 file file_path=/tmp/vault-audit2.log
> ```
> （`-path` 是命令的 flag，必须写在设备类型 `file` **前面**——这是 Vault CLI（Go flag 解析）自身的规则，与操作系统、shell 无关。）

### 13.2 看一眼审计日志长什么样

先确认前面章节建好的 `app/` KV v2 挂载还在：kv CLI 的每条命令都会先请求一次挂载预检，全新 dev server 上直接跑会卡在预检这一步（还没碰到读写）：

```text
Error making API request.

URL: GET http://127.0.0.1:8200/v1/sys/internal/ui/mounts/app
Code: 403. Errors:

* preflight capability check returned 403, please ensure client's policies grant access to path "app/"
```

```bash
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
    "policy_results": { "allowed": true, "granting_policies": [{"type": ""}, {"name": "root", "namespace_id": "root", "type": "acl"}] },
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

`granting_policies` 的真实形状：数组第一个元素是只有 `"type": ""` 的占位对象，真正放行的策略条目还带 `namespace_id`——root token 是 `[{"type": ""}, {"name": "root", "namespace_id": "root", "type": "acl"}]`，换成只读策略的 token 就是 `[{"type": ""}, {"name": "app-read", "namespace_id": "root", "type": "acl"}]`；而 **preflight 记录里没有 `granting_policies` 字段**，是 `{"allowed": true}`，**被拒绝的请求则是 `{"allowed": false}`**。

**关键结论（实测验证）**：

```text
audit lines=8  raw-secret-present=False  hmac-present=True
```

（这 8 行不是"两条命令 × 2"：kv CLI 每条命令都先请求一次 `sys/internal/ui/mounts/app` 做预检，所以 8 = 预检(2) + put(2) + 预检(2) + get(2)。）

- 写入的明文 `topsecret` **不会**以明文出现在日志里；
- 值、token、accessor 都以 `hmac-sha256:<hash>` 形式记录；
- 但**路径、操作类型、时间、来源 IP、使用的策略**都是明文——这正是审计需要的"谁在何时碰了哪个路径"；
- HMAC 的范围比"请求"更广：**响应里的字符串值同样被哈希**（kv get 的 `response.data.data.password`，以及 `created_time`、`deletion_time`、`description`、`options.file_path` 等），而布尔/数字/null（`version`、`destroyed`、`local`、`custom_metadata:null`）与 `headers.user-agent`、`client_id`、`mount_accessor`、`auth.display_name`、`namespace.id` 保持明文。

配套的两个字段特别有用：

| 字段 | 用途 |
| --- | --- |
| `policy_results.granting_policies` | **是哪个策略放行的**；排查"为什么这个 token 能读到"时一眼看出 |
| `client_token_accessor`（HMAC） | 可以把多次操作归并到同一个 token 上（用同一个 salt 计算即可比对） |

### 13.3 其他审计设备

```bash
# syslog（Linux/macOS 常见）
vault audit enable syslog tag="vault" facility="AUTH"

# socket（发到远端日志收集器，例如 Fluentd / Vector）
vault audit enable socket address="10.0.0.9:8200" socket_type="tcp" log_raw=false

# 多设备并行：`vault audit enable -path=file2 file file_path=/tmp/vault-audit2.log`
```

**socket 设备在 enable 时会先写一条测试消息**，所以收集端必须**已经在监听**，否则当场失败（设备不会启用，`vault audit list` 不变）：

```text
Error enabling audit device: Error making API request.

URL: PUT http://127.0.0.1:8200/v1/sys/audit/socket
Code: 400. Errors:

* audit backend failed test message: error writing to socket "10.0.0.9:8200": 2 errors occurred:
	* error connecting to "tcp" address "10.0.0.9:8200": dial tcp 10.0.0.9:8200: i/o timeout
	* error connecting to "tcp" address "10.0.0.9:8200": dial tcp 10.0.0.9:8200: i/o timeout
```

本机端口没人监听时也一样（换成 `connection refused`）：

```text
* audit backend failed test message: error writing to socket "127.0.0.1:8399": 2 errors occurred:
	* error connecting to "tcp" address "127.0.0.1:8399": dial tcp 127.0.0.1:8399: connect: connection refused
	* error connecting to "tcp" address "127.0.0.1:8399": dial tcp 127.0.0.1:8399: connect: connection refused
```

本机可复现的例子（用系统自带的 `nc`，**先监听再 enable**）：

```bash
# 终端 A：在 8399 端口起一个最小收集端，把收到的条目落到文件
nc -l 127.0.0.1 8399 > /tmp/vault-socket-audit.log

# 终端 B：收集端已在监听，enable 才会成功（不写 -path 时设备落在 socket/）
vault audit enable socket address="127.0.0.1:8399" socket_type="tcp" log_raw=false

# 之后随便做一个操作，条目会被推过去；文件里的第一条就是 enable 时的测试记录
vault kv get -mount=app audit-demo
head -c 300 /tmp/vault-socket-audit.log
```

```text
Success! Enabled the socket audit device at: socket/
```

三种设备的取舍：

| 类型 | 特点 | 适用 |
| --- | --- | --- |
| `file` | 最简单，落本地磁盘 | 单机/起步阶段 |
| `syslog` | 接入系统日志设施 | Linux 服务器统一收集 |
| `socket` | 实时推送到日志平台 | 生产推荐（ELK/Loki/Splunk） |

### 13.4 一个重要但反直觉的事实：Vault 允许你关掉最后一个审计设备

实测：

```bash
vault audit disable file
```

```text
Success! Disabled audit device (if it was enabled) at: file/
```

在 Vault 2.1.1 (OSS) 上，**关闭最后一个审计设备是成功的**（旧文档中"必须保留至少一个审计设备"的说法不能作为依赖）。这意味着：

> **"审计一直在开着"这件事必须靠制度和权限来保证，而不是靠 Vault 自己拦你。**

工程上的对策：

1. 把 `sys/audit/*` 的权限只给极少数管理身份；
2. 用外部监控定期断言审计设备仍然开启（例如每分钟调 `vault audit list`，发现为空就告警；**记得把"命令报错"也算成故障**——所有审计设备都写不进去时，它返回的是 500 而不是空列表）；
3. 审计日志写到**Vault 机器之外**（socket/syslog 或挂载的远端卷），避免"删日志"和"关设备"一步到位。

### 13.5 审计日志的运维

- **轮转**：Vault 不会自动轮转 `file` 设备的日志。用 `logrotate` + **`SIGHUP`**（`kill -HUP <pid>`）让 Vault 重新打开文件句柄。实测：只把日志 `mv` 走（不发 `SIGHUP`）时 Vault 仍继续写旧 inode，`SIGHUP` 之后才会按 `file_path` 新建文件（inode 变化），而且 `SIGHUP` 不影响 token 与挂载。
- **权限**：日志文件含路径与操作元数据（虽无明文密钥），应按敏感数据管理，限制读取。Vault 以 `0600` 创建日志文件，所以生产上要先建好目录并交给 Vault 运行用户（例如 `sudo install -d -o vault -g vault /var/log/vault`），再把 `file_path` 指向目录里的文件。
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
- **`vault audit disable <不存在的路径>` 也返回退出码 0** 并打印 `(if it was enabled)`——所以"disable 成功"不能证明设备存在。
- **审计失败的后果分两层**：只有**所有**审计设备都写不进去时才会 fail-closed，所有请求立刻变成：

```text
Error making API request.

URL: GET http://127.0.0.1:8200/v1/sys/internal/ui/mounts/app
Code: 500. Errors:

* internal error
```

而且此时连 `vault audit list` / `vault audit disable` 也一起 500，**没法通过 API 摘掉坏设备**，只能先修好坏设备（比如腾出磁盘空间），修好后自动恢复：

```text
Error disabling audit device: Error making API request.

URL: DELETE http://127.0.0.1:8200/v1/sys/audit/file
Code: 500. Errors:

* internal error
```

只要**还有一台健康设备**，坏掉那台的记录就会被**静默丢弃**（只体现在 Vault 服务端日志的 `audit: ... underlying pipeline error(s)` 里），客户端照样拿到 200（**注意：这条只适用于普通请求；"摘设备"的动作不适用——见下面那条实测**）：实测 socket 收集端已死 + 健康 `file` 设备时连打 500 个请求 0 失败、收集端一条都没收到；两个 `file` 设备其中一个落在满盘 tmpfs 上时连打 2000 个请求同样 0 失败。所以"配置第二个设备要谨慎"是双向的：它既是**可用性**风险点（多一个"写不进去就整体不可用"的点），也会带来**静默丢审计**的风险。

**还有一个更坑的实测结果**：坏设备还在的时候去 `vault audit disable <健康设备>`，会拿到一个**骗人的 500**——Vault 其实**已经把那台健康设备删掉了**（服务端日志里能看到 `[INFO] core: disabled audit backend: path=file/`），只是在写这次请求的 response 条目时撞上坏设备：

```text
Error disabling audit device: Error making API request.

URL: DELETE http://127.0.0.1:8200/v1/sys/audit/file
Code: 500. Errors:

* internal error
```

于是设备集合里只剩那台坏设备，等同于"所有审计设备都不可写"：此后 `vault kv put`、`vault audit list`、`vault audit enable` 全部变成 `Code: 500`、`* internal error`，**无法通过 API 自救**，而且不会像磁盘满那样腾出空间就自愈。正确的顺序是**先让坏设备恢复健康、再摘它**：实测重新把监听端拉起来后 `vault audit list` 立刻恢复 200（列表里只剩 `socket/`，正好证实健康的那台确实已经被删掉），随后 `vault audit disable socket` 退出码 0。反过来，坏设备还在时**先摘坏的那台**完全正常（实测退出码 0，剩下的 `file` 继续工作）。

所以监控不能只看"设备在不在列表里"：服务端日志一出现 `audit: ... underlying pipeline error(s)` 就要立刻处理（修收集端、腾空间，必要时重启 Vault），别等哪次配置顺手删掉一台健康设备，把整台 Vault 拖进 500。

下一章开始进入生产话题：为什么 Vault 启动后是"锁着"的。
