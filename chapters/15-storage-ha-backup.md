# 第 15 章 存储、HA 与备份恢复

## 需求

> Vault 要上生产了，运维问了三个问题：
>
> 1. 数据存在哪？会不会像 dev 模式那样一重启就没了？
> 2. 一台机器挂了怎么办？能多节点吗？
> 3. **删错了/存坏了，怎么恢复？**

本章把存储后端、集成存储（Raft）与 HA、以及备份恢复的完整链路讲清楚。

## 动手

### 15.1 存储后端怎么选

Vault 自己不实现"分布式数据库"，它把**加密后的密文**交给存储后端。选型原则只有一条：

> **优先选"集成存储（Integrated Storage / Raft）"**——它是 HashiCorp 官方主推、与 Vault 一起演进的方案，自带 HA、快照和集群管理。

| 后端 | 类型 | HA | 快照备份 | 适用 |
| --- | --- | --- | --- | --- |
| `raft`（集成存储） | 内置 | ✅ 原生 | ✅ `operator raft snapshot` | **生产首选**，自建环境 |
| `file` | 单机文件 | ❌ | 文件级 | 单机实验、极简部署 |
| `consul` | 外部 KV | ✅ | Consul snapshot | 已有 Consul 的团队 |
| 云托管存储（DynamoDB/Spanner 等） | 云服务 | 视服务 | 云侧备份 | 已有云基础设施 |

`file` 与本教程第 14 章用的一致，适合先把 Seal/Unseal 概念跑通。

### 15.2 单节点 Raft 上手（最接近生产的形态）

```hcl
# raft-single.hcl
ui = true

storage "raft" {
  path    = "/vault/data"        # 绝对路径！
  node_id = "vault-1"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true               # 生产改 TLS
}

api_addr     = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"
disable_mlock = true
```

> 说明：这里的 `disable_mlock = true` 是为了**免 root 直接跑实验**。生产上应保留 mlock
> （即去掉这一行或设为 `false`），并给 Vault 进程 `IPC_LOCK` 能力
> （systemd 里加 `AmbientCapabilities=CAP_IPC_LOCK`）或 root——原因见第 14 章。

启动、初始化、解封的流程与第 14 章完全相同：

```bash
# raft 后端不会自动创建 path 目录（file 后端会），先建好并授权
sudo mkdir -p /vault/data && sudo chown vault:vault /vault/data

vault server -config=raft-single.hcl
vault operator init -key-shares=3 -key-threshold=2
vault operator unseal '<key1>'
vault operator unseal '<key2>'
```

查看 Raft 成员：

```bash
vault operator raft list-peers
```

```text
Node       Address           State     Voter
----       -------           -----     -----
vault-1    127.0.0.1:8201    leader    true
```

### 15.3 三节点 HA 集群

HA 的形态是"**一个 active + 多个 standby**"：所有节点都能接收请求，只有 active 会写存储；standby 会自动转发或重定向。

三个节点各自的配置片段（关键是 `node_id` 与地址不同）：

```hcl
# vault-2.hcl
storage "raft" {
  path    = "/vault/data"
  node_id = "vault-2"

  retry_join {
    leader_api_addr = "https://vault-1.internal:8200"
  }
  retry_join {
    leader_api_addr = "https://vault-3.internal:8200"
  }
}

api_addr     = "https://vault-2.internal:8200"
cluster_addr = "https://vault-2.internal:8201"
```

也可以先启动再手动加入：

```bash
vault operator raft join https://vault-1.internal:8200
```

**HA 的关键运维事实**：

- **每个节点都要解封**（除非用自动解封）——重启后逐个 `vault operator unseal`，或用 KMS 自动解封；
- **未解封的节点不会参与选举**，3 节点里挂了 2 个就失去 quorum，无法写入；
- standby 节点**只是同构副本**，不是"只读副本"——它会转发请求给 active。

### 15.4 备份：Raft 快照

```bash
vault operator raft snapshot save backup-$(date +%Y%m%d-%H%M).snap
```

实测：这条命令**成功时没有任何输出**（退出码 0），用 `ls -l *.snap` 确认文件已生成。

**这条命令只能在 Raft 存储（或企业版的 DR 复制）上使用**。在 `file` 存储上执行会得到 404（实测）：

```text
Error taking the snapshot: Error making API request.

URL: GET http://127.0.0.1:8200/v1/sys/storage/raft/snapshot
Code: 404. Errors:

* 1 error occurred:
	* unsupported path
```

同理，`vault operator raft list-peers` 在非 Raft 存储上会输出：

```text
No raft cluster configuration found
```

（如果 Vault 处于**加封**状态，这两个命令都会先返回 `Code: 503 ... Vault is sealed`——所以看到 503 请先解封，再判断是不是存储类型的问题。）

顺手可以查集群的版本历史（版本追踪 1.9.0 引入，该命令本身要求服务端 ≥ 1.10.0）：

```bash
vault version-history
```

```text
Version  Installation Time     Build Date
-------  -----------------     ----------
2.1.1    2026-09-23T12:30:13Z  2026-09-15T21:21:56Z
```

检查快照内容（不恢复就能看）：

```bash
vault operator raft snapshot inspect backup-20260923-2030.snap
```

```text
 ID           bolt-snapshot
 Size         14846
 Index        45
 Term         3
 Version      1
```

（节选：真实输出后面还有一张 `Key Name / Count / Size` 明细表，逐项列出 `sys/policy`、`core/keyring`、`core/mounts` 等条目。）

备份策略建议：

| 项 | 建议 |
| --- | --- |
| 频率 | 至少每天一次；密钥变更频繁的环境可以每小时 |
| 保留 | 快照包含**所有**密钥密文，按最敏感数据对待；离线/异地保存 |
| 权限 | 能读快照 ≈ 能读全部数据（虽然还是密文，但结合 unseal key 就能解密） |
| 自动化 | 由具备 `sys/storage/raft/snapshot` 读权限的**专用身份**执行 |
| 演练 | **定期做一次真实恢复**，否则备份等于没有 |

### 15.5 恢复：把快照装回去

```bash
vault operator raft snapshot restore backup-20260923-2030.snap
```

实测：同样**成功时没有任何输出**（退出码 0）。

要点与踩坑：

- **restore 会覆盖当前集群的全部状态**（包括现有 token、策略、密钥）。这是"回到过去"，不是"合并"；
- 恢复后**旧集群的成员信息会一并回来**。跨集群恢复（例如灾备到新环境）会先撞上 keyring 校验，需要人工确认；
- **keyring 不同的快照不能直接恢复**：`vault operator raft snapshot restore` 会被服务端直接拒绝。实测输出：

```text
Error installing the snapshot: Error making API request.

URL: POST http://127.0.0.1:8200/v1/sys/storage/raft/snapshot
Code: 400. Errors:

* could not verify hash file, possibly the snapshot is using a different set of unseal keys; use the snapshot-force API to bypass this check
```

- **CLI 没有 `-force` 这类参数**：`vault operator raft snapshot restore` 的 flag 表里没有它，`vault operator raft snapshot-force` 也不是子命令——要绕过上面的校验，只能走 API `POST /v1/sys/storage/raft/snapshot-force`，别照着敲一个不存在的 flag；
- 实测旁证：这次失败的跨 keyring 恢复之后，目标集群**自己的 root token 也变成了 `403 invalid token`**；
- **同一集群、同一 keyring 的快照恢复后，节点通常仍是解封状态**（实测 `Sealed false`、root token 仍可用、数据立刻可读；三节点集群同样是 `Sealed false` / `HA Mode active`）；只有 keyring 不同的快照（用上面那个 force API 强行装进去）才需要（重新）解封；
- **restore 需要强权限**，不要给普通运维身份。

### 15.6 file 存储的备份方式

`file` 后端没有快照 API，只能靠**文件系统级备份**：

```bash
# 停服（或至少暂停写入）后打包数据目录
sudo systemctl stop vault
sudo tar czf /backup/vault-file-20260923.tar.gz -C /vault/data .
sudo systemctl start vault
```

务必同时保存：

1. **数据目录**（密文）；
2. **unseal key**（否则备份等于一堆乱码）；
3. **配置文件**（listener/storage/TLS 路径）。

这三样缺一不可，而且**不要放在同一台机器上**。

### 15.7 集群升级与回滚（概念）

```text
升级顺序（Raft）：
  ① 备份快照（务必）
  ② 逐个节点升级（先 standby，再 active），每次升级后确认节点重新加入并解封
  ③ 升级完成后验证：auth list / secrets list / 关键密钥可读
回滚：
  Raft 不支持"降级二进制"。要回退只能恢复到升级前的快照。
  → 所以升级前的那次备份是唯一的退路。
```

版本侧的注意点（与本教程的版本校准相关）：

- **1.21 → 2.x 的升级路径**：官方要求逐大版本升级（1.20 → 1.21 → 2.0 → 2.1），不要跳版本；
- 升级前用 `vault version-history`（版本追踪 1.9.0 引入，该命令本身要求服务端 ≥ 1.10.0）确认集群的版本历史；
- 2.x 会新增默认挂载（如 `agent-registry/`）与默认策略（如 `default-ceiling`），升级后 `vault secrets list` / `vault policy list` 的变化是**正常的**，不要误删；
- 不要依赖"跨大版本还能原样跑"——先在预发环境把本教程第 4-13 章的验证脚本跑一遍。

## 原理：存储后端与 HA 的边界

```text
            ┌──────────── 应用 / Agent ────────────┐
            ▼                                      ▼
      ┌──────────┐       转发写请求          ┌──────────┐
      │ standby  │ ────────────────────────▶ │  active  │
      └──────────┘                           └────┬─────┘
                                                  │ 加密后的数据
                                                  ▼
                                        ┌──────────────────┐
                                        │ storage backend  │ ← raft / file / consul
                                        └──────────────────┘
```

- Vault **只把密文**交给存储：**存储后端被攻破 ≠ 数据泄露**，攻击者还需要 unseal key；
- 因此**备份快照的安全等级 ≈ 密文等级**，"快照 + unseal key"才是完整的数据；
- HA 解决的是**可用性**，不是**数据安全性**；安全性靠 Seal/Unseal 与 TLS。

## 踩坑与检查清单

- **`file` 存储只能单机**，永远不要用它做"生产高可用"。
- **`storage "raft"` 不会自动创建 `path` 目录**（`file` 后端会自动建），目录不存在时进程直接起不来：`Error initializing storage of type raft: failed to create fsm: failed to open bolt file: open /vault/data/vault.db: no such file or directory`——先 `mkdir -p` 并把目录 `chown` 给 vault 用户。
- **备份必须与 unseal key 分开保存**：只备份数据目录是最常见的"以为备份了其实没备份"。
- **快照要定期做恢复演练**（第 16 章清单里有）。
- **Raft 集群升级后记得逐个解封**，别以为"进程起来了就是好的"。
- **升级前必须备份**（Raft 不支持降级）。
- **`api_addr` / `cluster_addr` 要显式配置**。只配 `cluster_addr`、漏掉 `api_addr` 时，日志会警告（实测原文，`api_addr` 一词是带反引号的）：
  ```text
  [WARN]  no `api_addr` value specified in config or in VAULT_API_ADDR; falling back to detection if possible, but this value should be manually set
  ```
  而在 **Raft 存储下这不止是警告——进程直接起不来**：`Error initializing core: missing API address, please set in configuration or via environment`（`file` 存储才是"只警告、照常启动"）。`cluster_addr` 同样不能漏，否则 Raft 直接拒绝启动：`Cluster address must be set when using raft storage`。
- **监控**：至少监控"节点是否解封""是否 active""Raft 是否失去 quorum""审计设备是否可用"。

下一章把所有"别忘的事"合并成一份可执行的上线清单。
