# 第 16 章 生产清单、升级与常见坑

## 需求

> "内部试点跑通了，下周上生产。"
>
> 在上线评审前，你需要一份能逐条打勾的清单，以及一份"出问题时先看什么"的排障手册。

本章把前面 15 章的内容压缩成**可执行**的清单，并给出升级与排障流程。

## 一、上线前检查清单

### 1. 部署与存储

- [ ] 使用 **Raft（集成存储）**，3 或 5 个节点；节点分布在不同可用区/机架；
- [ ] 存储路径、配置文件路径全部使用**绝对路径**；
- [ ] 配置里显式设置 `api_addr` 与 `cluster_addr`（避免启动日志里的 fallback 警告）；
- [ ] 每个节点的 `node_id` 唯一；
- [ ] 明确**谁负责解封**，以及重启时的操作顺序（先解封再放流量）。

### 2. TLS 与网络

- [ ] listener 启用 TLS（`tls_cert_file` / `tls_key_file`），证书有自动续期方案；
- [ ] 客户端使用 `VAULT_CACERT` 或系统信任链，**不要**用 `VAULT_SKIP_VERIFY=true` 图省事；
- [ ] 只有必要来源能访问 8200/8201（安全组/防火墙）；
- [ ] 若跨机房，确认 Raft 心跳所需的低延迟与带宽。

### 3. Seal / Unseal

- [ ] `vault operator init` 在**安全环境**执行，`-format=json` 的输出不落盘；
- [ ] unseal key 按门限方案**分人分地保管**（例如 3-of-5），并记录"谁能提供哪一份"；
- [ ] 生产优先用**自动解封**（云 KMS / HSM / Transit），并把 KMS 权限纳入评审；
- [ ] **root token 已撤销**；日常靠受限身份，必要时 `vault operator generate-root`；
- [ ] 演练过：真重启 + 真解封 + 数据可读。

### 4. 认证与授权

- [ ] 人用 **OIDC/LDAP**（不是 userpass），离职即失效；
- [ ] 机器按场景选 **Kubernetes / JWT-OIDC / AppRole**，优先无长期密钥的方案；
- [ ] 没有长期存在的 root 或高权 token；
- [ ] 所有 token 都设置了 `ttl` 或 `period`（没有"永不过期"的 token）；
- [ ] AppRole 的 `secret_id` 一律设置 `secret_id_ttl` 与 `secret_id_num_uses`（建议 1）；
- [ ] 策略按**最小权限**编写，并对 `app/destroy/*`、`sys/*`、`database/config/*` 等危险路径显式 `deny`；
- [ ] 关键策略有单元测试（`vault token capabilities` 断言）。

### 5. 密钥与轮换

- [ ] 能用动态密钥的地方**不用静态密码**（数据库、云凭据优先动态）；
- [ ] 静态密钥有明确的**轮换周期和责任人**；
- [ ] 数据库引擎用 `rotate-root` 接管管理员密码（并演练过恢复）；
- [ ] Transit 密钥配置了 `auto_rotate_period`，历史密文有 `rewrap` 计划；
- [ ] PKI 证书 TTL 短（小时/天级），有自动续期（Agent 模板）；
- [ ] PKI 角色设置了 `allowed_domains`，**不允许任意域名**。

### 6. 审计与监控

- [ ] **至少一个审计设备**，且日志推到 Vault 主机之外；
- [ ] 监控"审计设备是否仍然启用"（Vault 允许关闭最后一个设备，见第 13 章）；
- [ ] 监控：节点解封状态、active/standby、Raft quorum、存储容量、请求延迟与 5xx；
- [ ] 对"root 登录""策略变更""审计设备变更""revoke-prefix"这类高危操作设置告警。

### 7. 备份与恢复

- [ ] Raft 快照自动化（频率、保留期、异地保存）；
- [ ] 快照与 unseal key **分开保存**；
- [ ] **做过至少一次真实恢复演练**，并记录耗时；
- [ ] 升级前必做快照（Raft 不支持降级）。

### 8. 版本与变更

- [ ] 版本在受支持范围内（写作时 **2.1.x** 是当前受支持线，2.0 与 1.21 的标准维护已结束）；
- [ ] 有预发环境，且升级前在预发跑过一遍本教程的关键验证命令；
- [ ] `vault version-history` 输出已归档。

## 二、升级流程

```text
① 阅读目标版本的 release notes / breaking changes
     https://developer.hashicorp.com/vault/docs/updates/release-notes
② 备份：vault operator raft snapshot save pre-upgrade.snap
③ 预发环境升级 + 回归（至少覆盖：KV 读写、动态凭据申请、Agent 渲染、审计持续写入）
④ 生产逐个节点升级：先 standby，再 active
     每升一个节点：等它重新加入集群 → 解封 → 确认 vault operator raft list-peers 正常
⑤ 全量验证：auth list / secrets list / 关键业务读写 / 动态凭据可用
⑥ 观察 24 小时：错误率、延迟、租约撤销是否正常
```

**升级路径规则**：不要跨大版本跳（例如 1.20 直接到 2.1）。按 `1.20 → 1.21 → 2.0 → 2.1` 逐级走。

**升级后可能看到的"正常变化"**（以 1.21 → 2.1 为例）：

| 变化 | 说明 |
| --- | --- |
| `vault secrets list` 多出 `agent-registry/` | 2.x 新增的默认挂载 |
| `vault policy list` 多出 `default-ceiling` | 2.x 新增的默认策略 |
| 部分企业版能力出现在 UI | 仅企业版可用，OSS 不生效 |

## 三、常见坑速查（按症状查）

| 症状 | 最可能的原因 | 先做什么 |
| --- | --- | --- |
| `connection refused` / TLS 报错 | `VAULT_ADDR` 没设或协议错（默认是 https） | `echo "$VAULT_ADDR"`，确认 http/https 与端口 |
| `Code: 503 ... Vault is sealed` | 服务被加封（重启后未解封） | `vault status` → `vault operator unseal` |
| `Code: 403 permission denied` | 策略路径与实际 API 路径不一致 | 看报错里的 URL；用 `vault token capabilities` 对照 |
| `Code: 404 unsupported path` | 路径/引擎类型写错（例如 raft 命令用在 file 存储） | 用 `vault path-help <path>` 查真实路由 |
| KV v2 `kv get` 无数据但退出码 0 | 该版本被**软删除** | 看 metadata 的 `deletion_time`；必要时 `kv undelete` |
| `Error: check-and-set parameter did not match` | 挂载设置了 `cas_required`，写入没带正确版本 | 先 `kv metadata get` 看 `current_version` |
| `Command flags must be provided before positional arguments` | Vault CLI 要求 flag 写在位置参数之前 | 把 `-field=`、`-mount=` 等提前 |
| Agent 报 `error creating file sink` / 找不到文件 | 相对路径基于**进程工作目录**而非配置文件目录 | 全部改绝对路径 |
| `database/config` 写入失败 | 后端连不上（Vault 会立即验证连接） | 先确认数据库可达与凭据正确 |
| `secret-id/accessor/.../destroy` 返回 404 | AppRole 正确路径是 `secret-id-accessor/destroy` | 参照第 8 章 |
| 用假 JWT 登录报 `malformed jwt` / 缺 bound 约束 | 角色没配 `bound_audiences` 等绑定条件 | 至少加一个绑定条件 |
| 全部请求突然 403 且 token 无效 | `-prefix` 撤销误伤了自己的父 token | 用另一个身份登录并审计 `sys/leases/revoke-prefix` |
| 重启后数据"消失" | 用了 dev 模式（inmem） | 换非 dev + Raft/file 持久化存储 |
| `raft snapshot save` 报 404 | 存储不是 Raft | 确认存储类型，或改用文件级备份 |

## 四、日常运维节奏建议

| 频率 | 事项 |
| --- | --- |
| 每日 | 检查未解封节点、审计设备、快照是否成功、异常 5xx |
| 每周 | 巡检长生命周期 token/租约；检查即将过期的 TLS 证书 |
| 每月 | 清理无用策略与角色；复核 AppRole / K8s 角色的绑定范围 |
| 每季度 | 轮换静态密钥；Transit `rewrap` 推进；恢复演练 |
| 每半年 | 版本升级评估；unseal key 保管方案复核（人员变动后 rekey） |

## 五、把本教程变成你自己的验证脚本

前面每一章的命令都可以固化成脚本，在预发环境定期跑一遍。最小集合：

```bash
#!/usr/bin/env bash
# vault-smoke-test.sh（示意：需要按环境替换地址与身份）
set -euo pipefail

export VAULT_ADDR=https://vault.example.internal:8200

# 1. 服务可用且已解封
vault status >/dev/null || { echo 'vault unavailable or sealed' >&2; exit 1; }

# 2. 关键路径可读（用受限身份，不用 root）
vault kv get -mount=app demo >/dev/null || { echo 'app/data/demo unreadable' >&2; exit 1; }

# 3. 越权必须被拒
if vault kv get -mount=app db/prod >/dev/null 2>&1; then
  echo 'over-permission detected' >&2; exit 1
fi

# 4. 动态凭据能申请
vault read database/creds/app-readonly >/dev/null || { echo 'dynamic creds failed' >&2; exit 1; }

# 5. 审计设备仍然启用（注意：没有设备时返回的是 {} 且退出码为 0）
[ "$(vault audit list -format=json | jq 'length')" -ne 0 ] \
  || { echo 'no audit device enabled' >&2; exit 1; }

# 6. Agent 渲染出的密钥文件是最新的
#    （在你的部署里替换为实际检查）

echo '所有冒烟检查通过'
```

**把这套脚本接进 CI/定时任务**，你就在"上线之后"仍然持续验证本书讲过的每一条保证。

## 踩坑与检查清单（本章元清单）

- **不要跳过恢复演练**：没恢复过的备份等于没有备份。
- **不要把 root token 存在运维的 `.bashrc` / 环境变量里**。
- **不要用 `VAULT_SKIP_VERIFY=true` 绕过 TLS 问题**（它把中间人攻击变成可能）。
- **不要给应用 `transit/decrypt` 之外的权限**——权限应该是"刚好够用"。
- **不要忘记 `deny` 危险路径**：`app/destroy/*`、`sys/audit/*`、`sys/leases/revoke-prefix/*`。
- **不要忽略升级日志里的 deprecation 警告**：它们就是下一个大版本的 breaking change。
