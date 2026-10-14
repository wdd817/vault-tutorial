# 第 7 章 Token：一切访问的通行证

## 需求

> 安全同学问了你三个问题：
>
> 1. "你们那个 CI 用的 Vault token，是**永久的**吗？"
> 2. "一个 token 泄露了，怎么把它和它派生出来的一串 token **一次性**干掉？"
> 3. "有些 job 只跑一次，能不能给它一个**用完就废**的凭证？"
>
> 这三个问题的答案都在 token 的**生命周期**里。

## 动手

### 7.1 先看清楚一个 token 的"户口本"

```bash
export VAULT_TOKEN=root
TOKEN=$(vault token create -policy=app-read -ttl=30m -display-name=svc-api -field=token)
vault token lookup "$TOKEN"
```

```text
Key                 Value
---                 -----
accessor            SEFeK167s3XRQuS5BTB6NgUp
creation_time       1790165111
creation_ttl        1h
display_name        svc-api
entity_id           n/a
expire_time         2026-09-23T21:05:11.9447149+08:00
explicit_max_ttl    0s
id                  hvs.CAESIGqsQero...
issue_time          2026-09-23T20:05:11.9447149+08:00
meta                <nil>
num_uses            0
orphan              false
path                auth/token/create
policies            [app-read default]
renewable           true
ttl                 59m59s
type                service
```

四个字段决定了它的"权力范围与寿命"：

| 字段 | 含义 | 注意 |
| --- | --- | --- |
| `policies` | 附带的策略 | 建 token 时只能是**创建者自身策略的子集**（除非有 `sudo`） |
| `ttl` / `creation_ttl` | 剩余寿命 / 初始寿命 | `ttl` 会随时间递减 |
| `explicit_max_ttl` | 硬上限，续期也突破不了 | `0s` 表示没有硬上限 |
| `renewable` | 是否可续期 | 无 TTL 创建的 token 不可续期，永不过期（危险） |

### 7.2 TTL 与续期

```bash
vault token renew "$TOKEN"
vault token renew -increment=1h "$TOKEN"   # 请求"再给 1 小时"，但受 max_ttl 约束
```

```text
Key                  Value
---                  -----
token                hvs.CAES...
token_duration       30m
...
```

要点：

- **续期是"重置时钟"，不是"累加"**：`token_duration` 会回到请求的增量（受服务端 `max_lease_ttl` 与 token 的 `explicit_max_ttl` 限制）。
- **每个挂载点都有 `default_lease_ttl` / `max_lease_ttl`**，token 的 TTL 不能超过对应上限（token 挂载点的上限可用 `vault read sys/auth/token/tune` 查看）。
- **`-period` 创建的周期 token 可以无限续期**（下一节）。

### 7.3 三种 token：service / batch / periodic

#### service token（默认）

普通 token，Vault 会把它的信息存进存储，因此**可续期、可查、可撤销**，代价是每次校验都有存储/索引开销。

#### batch token

```bash
BT=$(vault token create -type=batch -policy=app-read -ttl=5m -field=token)
export VAULT_TOKEN=$BT
vault token lookup
```

```text
Key                 Value
---                 -----
accessor            n/a          ← 批量 token 没有 accessor
creation_ttl        5m
display_name        token
policies            [app-read default]
renewable           false        ← 不可续期
ttl                 4m59s
type                batch
```

批量 token 的特点：

| 特性 | batch | service |
| --- | --- | --- |
| 是否落盘 | 否（加密后自带信息） | 是 |
| 可续期 | ❌（`batch tokens cannot be renewed`） | ✅ |
| 可撤销（单个） | ❌（只能靠过期满） | ✅ |
| 可否 `token lookup` | ✅（只读自己的信息，`accessor: n/a`） | ✅ |
| 性能 | 高（无存储写入） | 一般 |
| 适用 | 高频、短命、无需撤销 | 需要撤销/续期的场景 |

> **决策口诀**：**需要"随时能撤销"就用 service；只追求吞吐且能接受"等它自然过期"就用 batch。**

#### periodic token

```bash
PER=$(vault token create -policy=default -period=24h -field=token)
vault token lookup "$PER"      # creation_ttl 24h, period 24h
vault token renew "$PER"       # token_duration 仍然是 24h
vault token renew "$PER"       # 再续还是 24h —— 只要按期续期，它永不过期
```

周期 token 是"**永不失效但需要定期露面**"的设计：只要应用/Agent 每 24 小时续一次，token 就长期有效；一旦续期停止（服务下线、被隔离），24 小时后自动失效。这对长期运行的守护进程很友好（第 9 章的 Vault Agent 就是这么用的）。

> ⚠️ **安全提示**：周期 token 本质上把"过期"变成了"心跳"。它适合 Agent/服务，不适合人；而且一定要设置 `explicit_max_ttl` 之外的撤销渠道（撤销父 token / accessor）。

### 7.4 父子关系与级联撤销（重点）

用当前 token 创建的 token 是它的**子 token**，形成一棵树：

```bash
# 用 root 建父 token
PARENT=$(vault token create -policy=app-read -ttl=30m -display-name=parent -field=token)
# 用父 token 建子 token
export VAULT_TOKEN=$PARENT
CHILD_TOKEN=$(vault token create -policy=app-read -ttl=15m -display-name=child -field=token)
```

> **注意**：父 token 必须有 `auth/token/create` 的权限（`update`）。只带 `app-read` 的 token 去建子 token 会得到 403：
> ```text
> Error creating token: Error making API request.
> URL: POST http://127.0.0.1:8200/v1/auth/token/create
> Code: 403. Errors:
> * permission denied
> ```

撤销父 token 会**连同所有子 token 一起失效**：

```bash
export VAULT_TOKEN=root
vault token revoke "$PARENT"
vault token lookup "$CHILD_TOKEN"
```

```text
Error looking up token: Error making API request.
URL: POST http://127.0.0.1:8200/v1/auth/token/lookup
Code: 403. Errors:
* bad token
```

这就是回答安全同学第二个问题的机制：**撤销树根 = 撤销整棵树**。设计上应该做到"一条业务链路只认一个根 token"（例如一个服务实例一个父 token），泄密时一次撤销即可止损。

如果只想撤销父而保留子（较少用，例如"换发父 token 但不影响在跑的子任务"）：

```bash
vault token revoke -mode=orphan "$P2"
vault token lookup "$C2"        # 仍然可用
vault token revoke "$C2"        # 记得手动收回
```

### 7.5 accessor：平时用它，别用 token 本身

`token id` 是一把可以拿来直接用的钥匙；`accessor` 只能用来**查询/续期/撤销**，不能拿它去访问数据。因此日常运维应该只暴露 accessor：

```bash
ACC=$(vault token lookup -format=json "$TOKEN" | jq -r '.data.accessor')
vault token lookup -accessor "$ACC"
vault token renew -accessor "$ACC"
vault token revoke -accessor "$ACC"     # 撤销后原 token 立刻失效
vault list auth/token/accessors         # 列出所有 accessor（需要权限）
```

这条设计原则在审计和排障时非常重要：**把 accessor 写进工单和日志是安全的，把 token id 写进去等于泄密。**

### 7.6 一次性 token：`-use-limit`

```bash
ONE=$(vault token create -policy=app-read -ttl=10m -use-limit=1 -display-name=one-shot -field=token)
export VAULT_TOKEN=$ONE
vault kv get -mount=app demo    # 第一次：成功
vault kv get -mount=app demo    # 第二次：失败
```

```text
second use exit=2 (2 = token 已耗尽)
```

`-use-limit=1` 常用于"分发一次就作废"的引导场景，配合 response wrapping（第 9 章）效果更好。

### 7.7 其他常用参数（`vault token create -help` 实测）

| 参数 | 用途 |
| --- | --- |
| `-ttl=1h` | 初始 TTL |
| `-explicit-max-ttl=24h` | 硬上限，续期无法突破 |
| `-period=24h` | 周期 token |
| `-orphan` | 不挂在当前 token 下（撤销父不影响它） |
| `-no-default-policy` | 不附带 `default` 策略（**慎用**，很多客户端依赖它） |
| `-policy=...` | 指定策略（可多次传） |
| `-use-limit=N` | 最多使用 N 次 |
| `-type=batch` | 批量 token |
| `-metadata=k=v` | 附加元数据，会进入审计日志（便于归属追踪） |
| `-display-name=...` | 人类可读的名字 |

## 原理：token 是怎么被验证的

```text
请求 ── Header: X-Vault-Token: hvs.xxxx ──▶ Vault
   │
   ├─ service token：用 token id 查到存储中的记录
   │     → 得到 policies、ttl、use 计数、父 token
   │     → 检查是否过期 / 超次数 / 被撤销
   ├─ batch token：解密 token 自带的信息（无需存储查询）
   │     → 检查过期时间
   └─ 通过后把 policies 交给策略引擎做授权（第 5 章）
```

由此可以解释几个"反直觉"的现象：

- 为什么 batch token 没有 accessor、不能撤销：**它的状态不在服务端**。
- 为什么撤销父 token 会连带撤销子 token：**树关系需要维护一致性**（Vault 会递归清理）。
- 为什么改了策略无需重新登录：**授权时实时按路径计算**，token 只带"策略名单"。

## 踩坑与检查清单

- **不设 TTL 创建 token = 永不过期。** 生产上必须显式设 TTL 或 period，并把它写进代码模板。
- **root token 只能用于"初始化 + 建人/建策略"**，用完立刻撤销。更稳妥的是用 `vault operator generate-root` 流程按需生成（第 14 章）。
- **token 的 `id` 与 `accessor` 要区别对待**：日志、工单只写 accessor。
- **`-no-default-policy` 会让 Vault Agent、CLI 自省等功能失效**，除非你清楚后果，否则别加。
- **撤销要"从根上撤"**：只撤子 token 而放着父 token，等于没撤（父 token 可以再建新的子 token）。
- **批量 token 无法单独撤销**：设计上不要把 batch token 用于"需要即时止损"的场景。
- **`vault list auth/token/accessors` 需要权限**（`auth/token/accessors` 的 `list`），用 root 或专门的管理 token 执行。
- **注意 token 也会出现在审计日志里**（HMAC 之后，第 13 章），所以"用了哪个 token"是可追溯的。

下一章解决"token 从哪来"：把人的登录方式换成机器的登录方式。
