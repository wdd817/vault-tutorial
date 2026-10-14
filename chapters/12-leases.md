# 第 12 章 租约、续期与撤销

## 需求

> 第 6 章我们给应用发了"1 小时过期的数据库账号"，第 11 章发了"24 小时过期的证书"。安全同学接着问：
>
> - 这些临时凭证**现在有多少条在生效**？
> - 出了事能不能**立刻全部收回**？
> - 服务需要更长时间能不能**续期**，续期有没有上限？

答案都在 **Lease（租约）** 这个概念里：Vault 对"有寿命的东西"都会登记一条租约。

## 动手

### 12.1 什么有租约，什么没有

| 对象 | 有租约吗 | 说明 |
| --- | --- | --- |
| KV v2 的静态密钥 | ❌ 无 | 它不会"过期"，Vault 不需要跟踪 |
| 动态数据库凭据 | ✅ 有 | 到期/撤销时要执行 `DROP USER` |
| Transit 的 datakey | ❌ 无 | v2.1.1 实测不登记租约（见下） |
| PKI 签发的证书 | ⚠️ 视配置 | `generate_lease=true` 时产生租约 |
| Token | ⚠️ 部分 | token 自己有 TTL，但它不受 `sys/leases/*` 管理：`vault token lookup` 的 `.data` 里**根本没有** `lease_id` 字段（实测 `has("lease_id")` 为 `false`、取值是 `null`）；`vault token create` 的顶层虽然有 `lease_id`，但恒为空串、`lease_duration` 恒为 0 |

> **实测更正：Transit 在 v2.1.1 不产生租约。** `transit/datakey/plaintext`、`datakey/wrapped`、`transit/random`、`transit/encrypt`、`transit/rewrap` 的返回体里 `lease_id` 都是空、`lease_duration` 都是 `0`、`renewable` 都是 `false`，`vault list sys/leases/lookup/transit` 也报 `No value found`。作为对照，同一次实验里 database 的动态凭据是 `lease_id=database/creds/app-readonly/... lease_duration=3600 renewable=true`。

实测一个容易被误解的点——**token 不是"租约对象"**：

```bash
TOKEN=$(vault token create -policy=default -ttl=30m -field=token)
vault token lookup -format=json "$TOKEN" | jq -r '.data | [.accessor, .lease_id, .ttl, .type, .renewable] | @tsv'
```

```text
accessor  : npSvzphcJz3rv66D79BTvRSG
lease_id  :          ← 字段不存在（取值为 null）
ttl       : 1800
type      : service
renewable : True
```

所以 token 的续期/撤销用的是 **`vault token renew` / `vault token revoke`**（第 7 章），而动态密钥用的是 **`vault lease ...`**。

### 12.2 列出当前租约

租约以**挂载路径**为前缀组织，可以逐层列出来：

```bash
vault list sys/leases/lookup/auth/token/create
```

```text
Keys
----
1e318ae77adf4b81cb10f9c1a776232dfab115b3
h015fb9e77632396687c12925c6b7ddff1faef87d732fcc64b40c47abfee9dcf5
h2cff73eed4d17fef79d0e01cba68cd3f2a7751d2bdc9f43195aa2ff7bc80997d
h3d3e7912326d47d1049219d893781f2c292cbbf0a1d1387d767e5515f2fc5d27
haaaad5b3d1db80271652ef6a6232af0c5b4be9a06a96f5ba36311e8e99c75d6c
hba57cbd0577490a833ad157df7e8b9b23ff2bd6c6d0a8f1620df96523e9d57f9
```

数据库凭据的租约长这样：

```bash
vault list sys/leases/lookup/database/creds/app-readonly
# 返回一批 lease id 的末段
```

查看单条租约的详情（需要完整的 lease ID）：

```bash
vault write sys/leases/lookup lease_id=database/creds/app-readonly/AbC123...
# 或
vault lease lookup database/creds/app-readonly/AbC123...
```

```text
Key             Value
---             -----
expire_time     2026-09-23T21:30:00+08:00
id              database/creds/app-readonly/AbC123...
issue_time      2026-09-23T20:30:00+08:00
last_renewal    <nil>
renewable       true
ttl             59m59s
```

### 12.3 续期

```bash
vault lease renew -increment=1h database/creds/app-readonly/AbC123...
```

```text
Key                Value
---                -----
lease_id           database/creds/app-readonly/AbC123...
lease_duration     1h
lease_renewable    true
```

要点：

- `-increment` 是**请求**值，Vault **不保证**满足——最终受角色的 `max_ttl` 限制（第 6 章的 `max_ttl=24h` 就是这里起作用）；
- 续期不会改变密钥内容，只是延长寿命；
- token 的续期走 `vault token renew`，而且**周期 token 可以无限续期**（第 7 章）。

### 12.4 撤销：单个、按前缀

```bash
# 撤销一条（Vault 会执行 revocation_statements，例如 DROP USER）
vault lease revoke database/creds/app-readonly/AbC123...

# 按前缀批量撤销（需要 sudo 能力）
vault lease revoke -prefix database/creds/app-readonly
```

**`-prefix` 是最猛的止损手段**：`-prefix database/creds/app-readonly` 会撤销该角色签发的**全部**凭据。数据库里对应的账号会被逐个删除。

实测：没有 `sudo` 时会被拦下：

```bash
export VAULT_TOKEN='<只有 update 的 token>'
vault lease revoke -prefix auth/token/create
```

```text
Error revoking leases with prefix auth/token/create: Error making API request.

URL: PUT http://127.0.0.1:8200/v1/sys/leases/revoke-prefix/auth/token/create
Code: 403. Errors:

* 1 error occurred:
	* permission denied
```

而带 `sudo` 的策略就成功了：

```hcl
path "sys/leases/revoke-prefix/*" {
  capabilities = ["sudo", "update"]
}
```

```text
All revocation operations queued successfully!
```

> **想亲手验证"有 `sudo` / 没有 `sudo`"这件事？** 第 5 章 5.5 给了一套完整可复现的对照实验：先用 `vault token capabilities` 做零副作用的静态查证，再在同一台一次性 dev Vault 上跑"无 sudo → 403 / 带 sudo → queued successfully"的动态对照，并用可弃 token 逐条确认撤销是否真的落地。**在真按这个按钮之前，建议先照着 5.5 演练一遍**——尤其是它在实验设计上避开"调用者把自己也撤掉"的那个坑。

> ⚠️ **我在写这一章时踩到的真实教训**：执行 `vault lease revoke -prefix auth/token/create` 之后，**我自己正在使用的 token 也被撤销了**（dev 环境的 root token 同样在里面），整个实验环境当场失效，只能重启 Vault。
>
> 这不是 bug，而是"按前缀撤销"的语义：**它撤销的是 `lease_id` 命中该前缀的所有租约，包括你和你的自动化正在用的那个**。触发条件在 5.5 实测过：**只看前缀有没有命中某条租约的 `lease_id`，与"谁在调用"无关**——token store 创建的 token（`vault token create`，**含 root、含带 `sudo` 的调用者自己**）租约都登记在 `auth/token/create` 下，所以**无论谁来按这个按钮，root 都会一起失效**。全新 dev 实例上只有 root 一个身份时，`vault list sys/leases/lookup/auth/token/create` 只列出一条 `auth/token/create/34e737a9…`，它的 `issue_time` 正好等于 root token 的 `creation_time`（`expire_time` 为 null）——这就是 root 一起失效的原因。唯一能活下来的是**通过其它认证方式登录**得到的身份（userpass / AppRole 等，租约在 `auth/userpass/login/<user>` 下）。生产上请把它当作"核按钮"：
> - 只给极少数值班人/自动化；
> - 执行前确认自己要撤销的**精确前缀**；
> - 确保有别的可用身份（否则会把自己锁在门外）；
> - 事后立刻审计谁在什么时候按的按钮（第 13 章）。

### 12.5 撤销的连锁反应

撤销一条动态凭据会触发对应引擎的"清理逻辑"：

```text
vault lease revoke database/creds/app-readonly/AbC123...
   │
   ├─ 1. 标记租约为已撤销
   ├─ 2. 调用数据库插件执行 revocation_statements
   │      → DROP USER 'v-token-...'@'%'
   └─ 3. 记录审计事件

vault lease revoke -prefix auth/token/create
   │
   └─ 递归撤销前缀下的所有 token（第 7 章的"树"结构）
```

这条链路解释了为什么"**撤销要真的落到后端**"——撤销一条数据库租约，MySQL 里的账号是真的不见了。反过来，如果数据库此时不可用，撤销会失败并重试，审计日志里能看到失败记录（排查"为什么账号还在"的第一站）。

### 12.6 租约相关的策略

给应用/值班人员配租约权限时，常用的几条路径：

| 路径 | 能力 | 用途 |
| --- | --- | --- |
| `sys/leases/renew` | `update` | 续期（`default` 策略已包含） |
| `sys/leases/lookup` | `update` | 查询租约（`default` 策略已包含） |
| `sys/leases/revoke/*` | `update` | 撤销单条（**不需要 `sudo`**） |
| `sys/leases/revoke-prefix/*` | `sudo` + `update` | 批量撤销（危险，**必须 `sudo`**） |
| `sys/leases/lookup/*` | `list` + `sudo` | 浏览租约清单（**两者缺一即 403**） |

> **实测对照，别把这两行的权限记混**：同一条 `vault lease revoke` 命令，走哪个端点决定了要不要 `sudo`。
>
> - **单条**（`vault lease revoke <lease_id>` → `sys/leases/revoke/*`）：只需要 `update`。实测把调用者的 `sudo` 去掉，行为一模一样；反过来只给 `read`/`list` 会 403。
> - **按前缀**（`vault lease revoke -prefix <prefix>` → `sys/leases/revoke-prefix/*`）：`update` 不够，**必须显式带 `sudo`**，否则 403。验证方法见第 5 章 5.5。
>
> 所以"只给 `sys/leases/*` 全开"是典型的过度授权——等于把核按钮发给每个值班同事。给单条撤销就写 `sys/leases/revoke/*`，批量撤销再单独、按前缀地开 `sudo`。
>
> **还有一行容易被漏掉：列清单要 `sudo`。** `vault list sys/leases/lookup/<prefix>` 需要 `list` **和** `sudo` 两个能力，只给其中任何一个都是 403（实测穷举）：`["list"]` → 403、`["sudo"]` → 403、`["list","sudo"]` → `Keys`。而**查单条**（`vault lease lookup <id>` / `vault write sys/leases/lookup lease_id=...`，走的是 `sys/leases/lookup` 这个精确路径的 `update`）**不需要 `sudo`**，`default` 策略里已经带了。所以"看得到租约清单"和"能查一条租约"是两种不同的授权，别记混。

一条实用的值班策略：

```hcl
# lease-operator.hcl
path "sys/leases/lookup/database/creds/*" {
  capabilities = ["list", "sudo"]
}

path "sys/leases/renew" {
  capabilities = ["update"]
}

path "sys/leases/revoke-prefix/database/creds/app-readonly" {
  capabilities = ["sudo", "update"]
}
```

注意最后一条：**把 `-prefix` 的权限收窄到具体前缀**，而不是 `sys/leases/revoke-prefix/*`。这样值班同事能处理业务故障，但无法一键清空整个 Vault 的 token。同理，列租约清单的 `list` + `sudo` 也按前缀收窄到 `sys/leases/lookup/database/creds/*`，而不是 `sys/leases/lookup/*` 全开。

## 原理：租约是"临时性的账本"

```text
签发临时凭证 ──▶ Vault 写一条 Lease 记录
                  ├─ lease_id（唯一标识）
                  ├─ issue_time / expire_time / ttl
                  ├─ renewable
                  └─ 撤销时需要执行的语句（由引擎提供）

到期时刻 ────▶ Vault 的 expiration manager 自动撤销
手动撤销 ────▶ 同上，立即执行
```

三个设计要点：

1. **租约让"临时"变得可管理**：知道有多少条、分别属于谁、什么时候到期。
2. **续期是有边界的**：`max_ttl` 是硬顶，防止"续着续着变成永久密钥"。
3. **撤销是幂等且可追溯的**：重复撤销一条已经撤销的租约不会报错，审计里两次都有记录。

## 踩坑与检查清单

- **`vault lease revoke -prefix <prefix>` 前先三思**：它会撤销该前缀下的**所有**租约，包括你自己。
- **别混淆 token 与 lease**：token 用 `vault token renew/revoke`；动态密钥用 `vault lease renew/revoke`。
- **续期请求可能被"打折"**：`-increment` 只是请求值，以返回的 `lease_duration` 为准。
- **`max_ttl` 是安全阀**：给角色配 `max_ttl` 时要想清楚"最坏情况下这个凭据能活多久"。
- **动态凭据的业务侧要能处理"到期"**：至少要能重新申请；更好的做法是用 Agent 自动续期/重取（第 9 章）。
- **租约撤销失败要告警**：数据库连不上时账号删不掉，这是"看似撤销、实际还在"的隐患。
- **定期巡检 `sys/leases/lookup` 下的异常长租约**，尤其是 `auth/token/create` 下数量异常的情况。

下一章回答"谁在什么时候做了什么"——审计设备。
