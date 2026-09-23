# 第 17 章 附录：速查表与延伸学习

## A. 环境变量速查

| 变量 | 作用 | 示例 |
| --- | --- | --- |
| `VAULT_ADDR` | 服务端地址（默认 `https://127.0.0.1:8200`） | `http://127.0.0.1:8200` |
| `VAULT_TOKEN` | 请求携带的 token | `hvs.xxxx` |
| `VAULT_FORMAT` | 默认输出格式 | `json` |
| `VAULT_CACERT` | 校验服务端证书的 CA | `/etc/vault/ca.pem` |
| `VAULT_CLIENT_CERT` / `VAULT_CLIENT_KEY` | 客户端证书（mTLS） | — |
| `VAULT_NAMESPACE` | 企业版命名空间 | `team-a` |
| `VAULT_SKIP_VERIFY` | 跳过 TLS 校验（**生产禁用**） | `false` |
| `VAULT_DEV_ROOT_TOKEN_ID` | dev 模式 root token | `root` |
| `VAULT_DEV_LISTEN_ADDRESS` | dev 模式监听地址 | `127.0.0.1:8400` |

## B. 命令速查（按主题）

### 服务与状态

```bash
vault status                       # 解封状态（sealed 时退出码 2）
vault --version                    # CLI 版本
vault version-history              # 集群安装过的版本（Vault 2.x）
vault server -dev                  # 开发模式
vault server -config=prod.hcl      # 生产模式
vault monitor -log-level=debug     # 流式日志（排障）
vault debug -duration=2m           # 生成诊断包
```

### Seal / Unseal

```bash
vault operator init -key-shares=5 -key-threshold=3
vault operator unseal <key>
vault operator seal
vault operator rekey -init -key-shares=5 -key-threshold=3
vault operator generate-root -init
```

### 存储与备份

```bash
vault operator raft list-peers
vault operator raft join https://vault-1:8200
vault operator raft snapshot save backup.snap
vault operator raft snapshot restore backup.snap
vault operator raft snapshot inspect backup.snap
```

### KV v2

```bash
vault secrets enable -path=app kv-v2
vault kv put   -mount=app demo username=demo password=s3cr3t
vault kv patch -mount=app demo username=new
vault kv get   -mount=app -version=2 demo
vault kv list  -mount=app
vault kv delete   -mount=app demo
vault kv undelete -mount=app -versions=2 demo
vault kv destroy  -mount=app -versions=1 demo
vault kv rollback -mount=app -version=2 demo
vault kv metadata get -mount=app demo
vault kv metadata put -mount=app -max-versions=3 -cas-required=true demo
vault kv metadata delete -mount=app demo
vault kv get -mount=app -output-policy demo      # 生成所需策略
```

### 策略

```bash
vault policy list
vault policy write app-read app-read.hcl
vault policy read app-read
vault policy fmt app-read.hcl
vault policy delete app-read
vault token capabilities <token> app/data/demo    # 查能力
vault token capabilities app/data/demo            # 查自己
```

### Token

```bash
vault token create -policy=app-read -ttl=20m -display-name=svc
vault token create -type=batch -policy=app-read -ttl=5m
vault token create -period=24h -policy=default
vault token create -use-limit=1 -policy=app-read -ttl=10m
vault token lookup <token>
vault token lookup -accessor <accessor>
vault token renew <token>
vault token renew -increment=1h <token>
vault token revoke <token|accessor>
vault token revoke -mode=orphan <token>
vault list auth/token/accessors
```

### 认证方法

```bash
vault auth enable approle
vault write auth/approle/role/ci-runner token_policies=app-read token_ttl=20m token_max_ttl=1h secret_id_ttl=10m secret_id_num_uses=1
vault read -field=role_id auth/approle/role/ci-runner/role-id
vault write -f -field=secret_id auth/approle/role/ci-runner/secret-id
vault write -field=token auth/approle/login role_id=<id> secret_id=<id>
vault write -wrap-ttl=120s -f auth/approle/role/ci-runner/secret-id
vault unwrap <wrapping_token>
vault write auth/approle/role/ci-runner/secret-id-accessor/destroy secret_id_accessor=<acc>
vault auth enable kubernetes
vault write auth/kubernetes/config kubernetes_host=... token_reviewer_jwt=... kubernetes_ca_cert=...
vault auth enable jwt
vault write auth/jwt/config oidc_discovery_url=... bound_issuer=...
vault list auth/userpass/users
vault write auth/userpass/users/alice password=... policies=app-read
vault login -method=userpass -field=token username=alice password=alice-pw
```

### 动态密钥与租约

```bash
vault secrets enable database
vault write database/config/mysql-app plugin_name=mysql-database-plugin connection_url=... allowed_roles=...
vault write database/roles/app-readonly db_name=mysql-app creation_statements="..." default_ttl=1h max_ttl=24h
vault read database/creds/app-readonly
vault write -f database/rotate-root/mysql-app
vault read database/static-creds/legacy-report
vault lease lookup <lease_id>
vault lease renew -increment=1h <lease_id>
vault lease revoke <lease_id>
vault lease revoke -prefix database/creds/app-readonly
vault list sys/leases/lookup/auth/token/create
vault write sys/leases/lookup lease_id=<lease_id>
```

### Transit

```bash
vault secrets enable transit
vault write -f transit/keys/payments
vault write -field=ciphertext transit/encrypt/payments plaintext=<base64>
vault write -field=plaintext  transit/decrypt/payments ciphertext=<vault:v1:...>
vault write -field=ciphertext transit/rewrap/payments ciphertext=<...>
vault write -f transit/keys/payments/rotate
vault write -field=hmac transit/hmac/payments algorithm=sha2-256 input=<base64>
vault write -f transit/datakey/plaintext/payments
vault read transit/keys/payments
vault write transit/keys/payments/config deletion_allowed=true
vault delete transit/keys/payments
```

### PKI

```bash
vault secrets enable pki
vault secrets tune -max-lease-ttl=87600h pki
vault write pki/root/generate/internal common_name="Root CA" ttl=87600h
vault write pki/roles/web-server allowed_domains=example.internal allow_subdomains=true max_ttl=720h
vault write pki/issue/web-server common_name=api.example.internal ttl=24h
vault write pki/revoke serial_number=<serial>
vault write pki/config/urls issuing_certificates=... crl_distribution_points=...
vault read -field=certificate pki/cert/crl
vault write pki/intermediate/generate/internal common_name="Intermediate CA"
vault write pki/intermediate/set-signed certificate=@int.pem
```

### 审计

```bash
vault audit list
vault audit list -detailed
vault audit enable file file_path=/var/log/vault-audit.log
vault audit enable -path=file2 file file_path=/var/log/vault-audit2.log
vault audit disable file
```

### 身份与工具

```bash
vault list identity/entity/id
vault write identity/entity/name/alice policies=app-read
vault path-help app/data                     # 服务端路由文档
vault kv get -mount=app -output-policy demo  # 反推所需策略
vault read sys/internal/ui/mounts/app/data/demo   # 查看路径解析结果
```

## C. 路径对照表（KV v2 最容易错的地方）

| 你的意图 | CLI 写法 | 实际 API 路径 | 策略需要的能力 |
| --- | --- | --- | --- |
| 读值 | `vault kv get -mount=app demo` | `app/data/demo` | `read` |
| 写值（新建） | `vault kv put -mount=app demo a=1` | `app/data/demo` | `create`、`update` |
| 局部改 | `vault kv patch -mount=app demo a=1` | `app/data/demo` | `patch` |
| 列目录 | `vault kv list -mount=app` | `app/metadata?list=true` | `list` |
| 看元数据 | `vault kv metadata get -mount=app demo` | `app/metadata/demo` | `read` |
| 软删除 | `vault kv delete -mount=app demo` | `app/delete/demo` | `delete` |
| 恢复 | `vault kv undelete -mount=app -versions=1 demo` | `app/undelete/demo` | `update` |
| 彻底销毁 | `vault kv destroy -mount=app -versions=1 demo` | `app/destroy/demo` | `update` |
| 删元数据 | `vault kv metadata delete -mount=app demo` | `app/metadata/demo` | `delete` |
| 用路径语法读 | `vault kv get app/demo` ❌ | 先预检 `sys/internal/ui/mounts/app/demo`，再请求 `app/data/demo` | `read` on `sys/internal/ui/mounts/*` + `read` on `app/data/demo` |

**结论**：写策略时以 **API 路径** 为准；用 CLI 时**优先用 `-mount=` 形式**，它跳过预检、路径更直观。

## D. 错误信息索引

| 错误片段 | 含义 | 排查方向 |
| --- | --- | --- |
| `connection refused` / `no such host` | 服务不可达 | 地址、端口、网络、进程是否在跑 |
| `Vault is sealed`（503） | 已加封 | `vault status` → 解封 |
| `permission denied`（403） | 策略不允许 | 对照真实 API 路径与 `token capabilities` |
| `bad token` | token 无效/已撤销/过期 | `vault token lookup` |
| `unsupported path`（404） | 路径或引擎类型错 | `vault path-help <path>` |
| `check-and-set parameter did not match` | CAS 冲突 | 先读当前版本号 |
| `path already in use` | 挂载/审计设备路径重复 | 换 `-path=` |
| `must have at least one bound constraint` | 认证角色缺少绑定条件 | 加 `bound_audiences`/`bound_claims` |
| `open /var/run/secrets/...` | K8s 认证未显式提供 CA | 传 `kubernetes_ca_cert` |
| `batch tokens cannot be renewed` | 对 batch token 续期 | batch 不支持续期，重建 token |
| `flag provided but not defined` | 参数名写错 | `vault <cmd> -help` |
| `Command flags must be provided before positional arguments` | flag 位置错（PowerShell 常见） | flag 提前 |
| `invalid character '-' in numeric literal` | CLI 把路径当数字解析（如 `pki/crl/pem`） | 用 `pki/cert/crl` |

## E. 概念对照：Vault 术语与"传统做法"

| Vault 术语 | 传统对应物 | 一句话理解 |
| --- | --- | --- |
| Secrets Engine | 一个专门的密钥库/服务 | 可挂载的"柜子"，如 KV、数据库、PKI、Transit |
| Auth Method | 统一登录入口 | 把外部身份换成 Vault token |
| Policy | IAM 策略 / sudoers | 路径 + 能力的白名单，默认拒绝 |
| Token | 会话票据 | 一切访问的凭证，有 TTL |
| Lease | 会话/租期 | 临时凭证的寿命与回收凭据 |
| Seal / Unseal | 开保险柜 | 启动即上锁，达到阈值才能解锁 |
| Barrier | 静态加密层 | 磁盘上只有密文 |
| Identity / Entity | 统一用户目录 | 多种登录方式归并到同一个"人" |
| Audit Device | 审计日志 | 请求+响应全量记录，敏感值 HMAC |
| Response Wrapping | 一次性取件码 | 用一次性 token 安全投递密钥 |

## F. 学习路径建议

**第一周（对应第 1-4 章）**

1. 安装 Vault 2.1.x，跑通 dev 模式；
2. 把 KV v2 的 5 组路径（data/delete/destroy/undelete/metadata）各敲一遍；
3. 用 `-output-policy` 反推并写出你的第一份策略。

**第二周（对应第 5-9 章）**

1. 建两个身份（人和机器），验证最小权限与越权拒绝；
2. 用 AppRole + Agent 让一个真实小服务从 Vault 拿配置；
3. 打开审计设备，观察一次完整请求的两条日志。

**第三周（对应第 10-13 章）**

1. 用 Transit 加密一列数据，并验证"只能加密不能解密"的策略；
2. 用 PKI 签发一张 24 小时证书，并用 Agent 自动续期；
3. 申请一个动态数据库账号，观察它被自动 `DROP`。

**第四周（对应第 14-16 章）**

1. 用 file 存储跑一遍 Seal/Unseal 与重启持久化；
2. 换 Raft 存储，做一次快照 + 恢复演练；
3. 按第 16 章清单为你的环境打分，补上缺口。

## G. 官方资源（按可信度排序）

- Vault 文档首页：[developer.hashicorp.com/vault/docs](https://developer.hashicorp.com/vault/docs)
- 发行说明（版本与破坏性变更）：[Release notes](https://developer.hashicorp.com/vault/docs/updates/release-notes)
- 重要变更与弃用：[Important changes](https://developer.hashicorp.com/vault/docs/updates/important-changes) / [Deprecation notices](https://developer.hashicorp.com/vault/docs/updates/deprecation)
- 公开 CHANGELOG（最细粒度）：[github.com/hashicorp/vault/blob/main/CHANGELOG.md](https://github.com/hashicorp/vault/blob/main/CHANGELOG.md)
- 二进制发布与校验和：[releases.hashicorp.com/vault](https://releases.hashicorp.com/vault)
- 版本支持周期：[endoflife.date/hashicorp-vault](https://endoflife.date/hashicorp-vault)
- 教程库（动手实验）：[developer.hashicorp.com/vault/tutorials](https://developer.hashicorp.com/vault/tutorials)
- API 参考（写 SDK 时查）：[developer.hashicorp.com/vault/api-docs](https://developer.hashicorp.com/vault/api-docs)
- CLI 参考：[developer.hashicorp.com/vault/docs/commands](https://developer.hashicorp.com/vault/docs/commands)
- 社区讨论：[discuss.hashicorp.com/c/vault](https://discuss.hashicorp.com/c/vault)

## H. 本书的版本基线（再强调一次）

- 全部命令实测于 **Vault v2.1.1（OSS）**，环境为 Windows 11 + PowerShell 7；
- 写作时的受支持版本线：**2.1.x**（2.0.x 与 1.21.x 的标准维护已结束）；
- 1.21.x 上本教程的命令同样适用，但 2.x 新增的 `agent-registry/` 挂载与 `default-ceiling` 策略不会出现；
- 涉及企业版能力（Secrets Sync、MCP Server、Agent Registry 高级功能、MFA 等）的地方都已显式标注。

祝你玩得开心，也祝你的密钥永远短暂、可撤销、有记录。
