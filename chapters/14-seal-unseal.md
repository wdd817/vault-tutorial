# 第 14 章 Seal 与 Unseal：Vault 的保险柜逻辑

## 需求

> 第 2 章的 dev 模式"开箱即用"，但生产不可能这样：
>
> - 服务器重启后，Vault 必须**先锁着**，等人（或云 KMS）解封才能用；
> - 解封所需的"钥匙"要**分开保管**，一个人凑不齐；
> - 数据在磁盘上必须是**静态加密**的，拿到硬盘也没用。

这一章用一个**非 dev** 的 Vault 把 Seal/Unseal 的完整生命周期走一遍。所有命令与输出均实测于 Vault 2.1.1。

## 动手

### 14.1 写一份最小生产式配置

```hcl
# prod.hcl
ui = true

storage "file" {
  path = "C:/Users/BigFoot/Workspace/self/vault-tutorial/.lab/prod-data"
}

listener "tcp" {
  address     = "127.0.0.1:8300"
  tls_disable = true          # 生产必须改成 TLS，见 14.6
}

disable_mlock = true
```

> ⚠️ **实测踩坑（非常重要）**：`storage "file" { path = "./prod-data" }` 这种**相对路径是相对于 vault 进程的工作目录**，而**不是相对于配置文件所在目录**。我用 `-config=.lab/prod.hcl` 启动时，数据落到了工作目录下的 `./prod-data`，导致"删掉配置文件旁边的目录后，服务仍然显示已初始化"。**生产上路径一律写绝对路径。**

启动（把 `VAULT_ADDR` 指向新实例）：

```powershell
vault server -config=.lab/prod.hcl
```

服务端启动横幅里会打印监听地址、存储类型：

```text
              Listener 1: tcp (addr: "127.0.0.1:8300", cluster address: "127.0.0.1:8301", ...)
                 Storage: file
                 Version: Vault v2.1.1, built 2026-09-15T21:21:56Z
```

### 14.2 第一次状态检查：已启动，但未初始化且已加封

```powershell
$env:VAULT_ADDR = 'http://127.0.0.1:8300'
vault status
```

```text
Key                Value
---                -----
Seal Type          shamir
Initialized        false     ← 还没 operator init
Sealed             true      ← 保险柜是锁着的
Total Shares       0
Threshold          0
Unseal Progress    0/0
Version            2.1.1
Storage Type       file
HA Enabled         false
```

`vault status` 在**已加封时返回退出码 2**。（刚启动的瞬间可能返回 1，因为监听还没就绪，等一两秒再查。）

### 14.3 初始化：把钥匙切开

```powershell
vault operator init -key-shares=3 -key-threshold=2 -format=json
```

```json
{
  "unseal_keys_b64": ["OAALPPDN2U...", "EgqmlmC1ic...", "sGOhNYlv7N..."],
  "unseal_keys_hex": ["...", "...", "..."],
  "unseal_shares": 3,
  "unseal_threshold": 2,
  "recovery_keys_b64": [],
  "root_token": "hvs.dBs3..."
}
```

实测输出（脱敏）：

```text
unseal key count = 3
keys sample     = OAALPPDN2U... / EgqmlmC1ic... / sGOhNYlv7N...
root token len  = 28
```

这一步发生了什么：

1. Vault 生成**根密钥（root key）**，用它加密"加密密钥"，所有数据在磁盘上都是密文；
2. 根密钥被 Shamir 算法切成 **3 份**，**任意 2 份**可以还原（3-of-2 阈值方案）；
3. 同时签发一个 **root token**——这是唯一一个"能创建一切"的身份。

**把这两样东西当作最高机密处理**：

- unseal key 分给不同的人/不同的保管库（例如 1 份给运维负责人、1 份进公司保险柜、1 份离线加密存）；
- root token **用完立刻撤销**（`vault token revoke <root>`），需要时用 `vault operator generate-root` 按需生成；
- `-format=json` 的输出**不要**留在磁盘上；生产上可以用 `-pgp-keys` 让每份 key 只对特定人可见。

### 14.4 加封状态下什么都不能做

```powershell
$env:VAULT_TOKEN = '<root token>'
vault kv put -mount=secret hello value=world
```

```text
Error making API request.
URL: GET http://127.0.0.1:8300/v1/sys/internal/ui/mounts/secret/hello
Code: 503. Errors:
* Vault is sealed
```

**503 + "Vault is sealed"** 是加封状态的标准症状。看到它就别查权限了，去解封。

### 14.5 解封：逐把钥匙插进去

```powershell
vault operator unseal OAALPPDN2U...
```

```text
Key                Value
---                -----
Seal Type          shamir
Initialized        true
Sealed             true          ← 还锁着
Total Shares       3
Threshold          2
Unseal Progress    1/2           ← 进度 1/2
Unseal Nonce       3672f5c4-a1ac-91d0-84da-5afb18e925d4
```

```powershell
vault operator unseal EgqmlmC1ic...
```

```text
Key             Value
---             -----
Seal Type       shamir
Initialized     true
Sealed          false         ← 解封成功
Total Shares    3
Threshold       2
Version         2.1.1
Cluster Name    vault-cluster-18f797ba
Storage Type    file
HA Enabled      false
```

要点：

- **每把 key 是独立的**，Vault 用 `Unseal Nonce` 关联同一次解封过程；
- 提供**多余的 key**（比如给第 3 把）会重置进度或报错，按提示数量给；
- 解封是**内存操作**：Vault 从不把 unseal key 写到磁盘。

### 14.6 重启后：数据还在，但必须重新解封（核心验证）

```powershell
# 写入数据
vault secrets enable -path=biz kv-v2
vault kv put -mount=biz orders db_password=prod-secret-42
vault kv get -mount=biz orders
```

```text
======= Data =======
Key            Value
---            -----
db_password    prod-secret-42
```

现在**直接杀掉进程**（模拟宕机/重启）：

```powershell
Stop-Process -Id <vault 进程 id> -Force
vault status
```

```text
Error checking seal status: ... dial tcp 127.0.0.1:8300: connectex: No connection could be made ...
```

重新启动同一个配置：

```powershell
vault server -config=.lab/prod.hcl
vault status
```

```text
Initialized        true      ← 还记得自己已初始化
Sealed             true      ← 但锁着
Total Shares       3
Threshold          2
Storage Type       file
```

再插两把钥匙（这次用第 2、3 把）：

```powershell
vault operator unseal EgqmlmC1ic...
vault operator unseal sGOhNYlv7N...
vault status
```

```text
Sealed          false
```

**关键验证：数据还在。**

```powershell
$env:VAULT_TOKEN = '<root token>'
vault kv get -mount=biz orders
```

```text
= Secret Path =
biz/data/orders

======= Metadata =======
Key                Value
---                -----
created_time       2026-09-23T12:18:51.6524219Z
custom_metadata    <nil>
deletion_time      n/a
destroyed          false
version            1

======= Data =======
Key            Value
---            -----
db_password    prod-secret-42
```

```powershell
vault secrets list
```

```text
Path               Type              Accessor                   Description
----               ----              --------                   -----------
agent-registry/    agent_registry    agent-registry_b456b124    agent registry
biz/               kv                kv_aa4992a7                n/a
cubbyhole/         cubbyhole         cubbyhole_1a1be6e5         per-token private secret storage
identity/          identity          identity_be436796          identity store
sys/               system            system_b3a50988            system endpoints used for control, policy and debugging
```

**这三个事实同时成立，就是 Seal/Unseal 设计的目标**：

1. 数据持久化（重启不丢）；
2. 未解封前数据不可用（磁盘被拿走也没用）；
3. 解封需要达到阈值的多把钥匙。

### 14.7 手动加封

```powershell
vault operator seal
```

```text
Success! Vault is sealed.
```

加封常用于维护窗口（例如升级前）。注意：**加封后所有 token 立即失效**（内存里的密钥被清掉）。

### 14.8 自动解封（Auto-unseal）

每次都靠人去插钥匙在生产上不现实。Vault 支持**自动解封**：把根密钥交给外部可信系统保管。

```hcl
# AWS KMS 自动解封（示意）
seal "awskms" {
  region     = "cn-north-1"
  kms_key_id = "abcd1234-..."
}
```

支持的 seal 类型包括各家云 KMS（AWS/GCP/Azure/阿里云等）、**PKCS#11 HSM**，以及 **Transit 自动解封**（用另一个 Vault 集群来保护本集群的根密钥）。

```hcl
# Transit 自动解封（用"上游 Vault"当保险柜）
seal "transit" {
  address         = "https://vault-upstream.example.internal:8200"
  token           = "<具有 transit/encrypt+decrypt 权限的 token>"
  disable_renewal = "false"
  key_name        = "autounseal"
  mount_path      = "transit/"
}
```

使用自动解封后：

- `vault status` 里 `Seal Type` 会显示对应的类型（如 `awskms`）；
- **不再有 unseal key**，取而代之的是 `recovery keys`（用于 `generate-root` 等恢复操作）；
- 服务重启后**自动解封，无需人工**——这通常是在 K8s 里跑 Vault 的前提。

### 14.9 重新切分钥匙（rekey）

人员变动后应该重新分钥匙：

```powershell
# 启动一次 rekey（需要达到当前阈值数量的现有 key）
vault operator rekey -init -key-shares=5 -key-threshold=3

# 按提示依次提交现有 key，然后 Vault 会输出新的 key 份额
vault operator rekey <当前 key 1>
vault operator rekey <当前 key 2>

# 可选：备份当前密钥（谨慎使用）
vault operator rekey -backup-retrieve
vault operator rekey -backup-delete
```

> `-backup` 会生成一份"用于回滚的旧密钥备份"，使用后应当立刻 `-backup-delete`。

## 原理：为什么 Vault 必须"上锁启动"

```text
磁盘上                Vault 进程内存            解封后
┌──────────────┐     ┌──────────────┐        ┌──────────────┐
│ 密文数据      │ ←── │  根密钥      │ ←──── │ 2 of 3 keys  │
│ （静态加密）  │     │ （解封后加载）│        │ 或 KMS       │
└──────────────┘     └──────────────┘        └──────────────┘
        ▲                    ▲
        └──── 没有根密钥，谁都读不出来（包括拿到磁盘的人）
```

- **静态加密**：Vault 的数据在存储层已经是密文，密钥层次是"unseal key → root key → encryption key → 数据"；
- **Shamir 门限**：避免"一把钥匙丢了一切完蛋"或"一个人就能独吞全部数据"；
- **上锁启动**：Vault 不假设自己运行在可信环境，重启后必须有人/有 KMS 明确授权才能加载密钥。

## 踩坑与检查清单

- **`storage.path` 的相对路径基于进程工作目录**（实测踩坑），生产写绝对路径。
- **`disable_mlock` 在 Windows 上必须为 true**；Linux 上建议保留 mlock（避免密钥被换页到磁盘），此时需要 `IPC_LOCK` 能力或 root。
- **生产必须开 TLS**：`tls_cert_file` / `tls_key_file`，并配 `api_addr`、`cluster_addr`（日志里会有 `no api_addr value specified` 的警告）。
- **unseal key 与 root token 分开保管**，且**不要**把 `-format=json` 的 init 输出留在同一台机器上。
- **root token 用完即撤**：日常运维用受限身份；需要时 `vault operator generate-root`。
- **阈值要选得现实**：3-of-5 比 2-of-3 更适合分布式团队，但要保证"任何时刻都能凑齐"（别把 3 份放在同一个人手里）。
- **自动解封把信任转移给了 KMS**：KMS 权限、网络、密钥轮换同样要纳入安全评审。
- **定期演练**：真的重启一次、真的解封一次，确认流程和保管方式都还可用（第 16 章有演练清单）。

下一章把存储、HA 和备份补完。
