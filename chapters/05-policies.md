# 第 5 章 策略：把"能读什么"写成代码

## 需求

> 北极星电商现在有四类消费者，要求各不相同：
>
> | 谁 | 要求 |
> | --- | --- |
> | `alice`（应用开发） | 只能读 `app/data/demo`，不能读生产库密码 |
> | 订单服务 | 能读自己的配置，能列目录（便于排查），但不能写 |
> | CI 流水线 | 能在自己的前缀下建/改/删密钥，但碰不到别人的 |
> | 值班同事 | 能在紧急情况下撤销某类租约，但不能读任何业务密钥 |
>
> 而且这份权限清单要能进 Git、能被 review、能被测试。

Vault 的答案是一份 **HCL/JSON 策略文件**。本章把策略的语法、匹配规则、优先级和验证手段讲透。

## 动手

### 5.1 最小可用策略：只读一个路径

```bash
# Linux/macOS 下写出来就是 UTF-8 无 BOM，可以放心落盘再上传
cat > app-read.hcl <<'EOF'
path "app/data/demo" {
  capabilities = ["read"]
}

path "app/metadata/demo" {
  capabilities = ["read", "list"]
}
EOF
vault policy write app-read app-read.hcl
```

```text
Success! Uploaded policy: app-read
```

> **为什么是这两条路径？** 因为 KV v2 读值走 `data/`，看元数据/列目录走 `metadata/`。只用 `vault kv get -mount=app demo` 的人会只写第一条，然后发现 `vault kv list` 报 403。

用 `vault kv` 自己的提示来"反推"策略，是本章最实用的技巧——`-output-policy` 会打印**满足这次操作所需的最小策略**：

```bash
vault kv get -mount=app -output-policy demo
```

```text
path "app/data/demo" {
  capabilities = ["read"]
}
```

```bash
vault kv put -mount=app -output-policy demo password=x
```

```text
path "app/data/demo" {
  capabilities = ["create", "update"]
}
```

```bash
vault kv list -mount=app -output-policy
```

```text
path "app/metadata" {
  capabilities = ["list"]
}
```

**把 `-output-policy` 当成"策略生成器"**：先在测试环境用高权限 token 跑一遍真实命令，收集输出，再拼成最终策略。这比手写策略然后反复试错快得多。

### 5.2 挂上身份并验证

```bash
vault auth enable userpass
vault write auth/userpass/users/alice password=alice-pw policies=app-read
```

```bash
# 用 alice 登录并拿到她的 token
ALICE_TOKEN=$(vault login -field=token -method=userpass username=alice password=alice-pw)
export VAULT_TOKEN=$ALICE_TOKEN

vault kv get -mount=app demo
```

```text
== Secret Path ==
app/data/demo
...
====== Data ======
Key         Value
---         -----
password    s3cr3t
username    demo
```

越权访问会被明确拒绝：

```bash
vault kv get -mount=app db/prod
```

```text
Error reading app/data/db/prod: Error making API request.

URL: GET http://127.0.0.1:8200/v1/app/data/db/prod
Code: 403. Errors:

* 1 error occurred:
	* permission denied
```

> **看错误里的 URL**：`/v1/app/data/db/prod`。Vault 报错时一定会告诉你**它实际请求的路径**，这是排查 403 的第一手线索。
>
> **退出码**：权限拒绝时 CLI 返回 `2`（不是 1）。脚本里判断"是不是权限问题"可以用它。

用 root 替 alice 做能力查询（排障必备）：

```bash
export VAULT_TOKEN=root
vault token capabilities $ALICE_TOKEN app/data/demo      # read
vault token capabilities $ALICE_TOKEN app/data/db/prod   # deny
vault token capabilities $ALICE_TOKEN app/metadata/demo  # list, read
```

### 5.3 路径匹配：`+` 与 `*`

策略的路径支持两种通配符，语义差别很大：

| 写法 | 含义 | `kvteam/a/config` | `kvteam/a/b/config` |
| --- | --- | --- | --- |
| `kvteam/+/config` | `+` 匹配**恰好一个**路径段 | ✅ | ❌ |
| `kvteam/*` | `*` 匹配**任意长度的剩余部分**（只能出现在末尾） | ✅ | ✅ |

实测：

```bash
cat > wildcard-demo.hcl <<'EOF'
path "kvteam/+/config" {
  capabilities = ["read"]
}

path "kvteam/*" {
  capabilities = ["list"]
}
EOF
vault policy write wildcard-demo wildcard-demo.hcl
TOKEN=$(vault token create -policy=wildcard-demo -ttl=10m -field=token)
vault token capabilities $TOKEN kvteam/a/config      # read
vault token capabilities $TOKEN kvteam/a/b/config    # list
vault token capabilities $TOKEN kvteam/a             # list
```

注意第三条：`kvteam/a` 只命中 `kvteam/*` 的 `list`，不会命中 `+/config` 的 `read`。**`*` 是"前缀通配"，不是"递归目录通配"**——它同时也匹配中间层级的路径。

### 5.4 capabilities 全表与优先级

策略块里的 `capabilities` 可以取这些值：

| 能力 | 含义 | 典型用途 |
| --- | --- | --- |
| `create` | 创建新条目 | KV 写入新 key |
| `read` | 读取 | 读密钥、读配置 |
| `update` | 修改已有条目 | KV 覆盖写、transit 加密（**注意：加密也用 update**） |
| `patch` | 局部修改 | KV v2 `patch` |
| `delete` | 删除 | 软删除 |
| `list` | 列目录 | `vault kv list` |
| `sudo` | 访问受保护的 `sys/` 端点 | 撤销租约、管理挂载 |
| `deny` | 显式拒绝 | 覆盖更宽的通配规则 |

**优先级规则（实测验证）：`deny` 永远赢。**

```bash
cat > deny-wins.hcl <<'EOF'
path "app/data/secret-x" {
  capabilities = ["deny"]
}

path "app/data/*" {
  capabilities = ["read", "update"]
}
EOF
vault policy write deny-wins deny-wins.hcl
TOKEN=$(vault token create -policy=deny-wins -ttl=10m -field=token)
vault token capabilities $TOKEN app/data/secret-x   # deny
vault token capabilities $TOKEN app/data/demo       # read, update
```

```text
deny
read, update
```

这条规则非常有用：你可以先给一个宽泛的 `app/data/*` 读写，再用 `deny` 把几个敏感 key（例如 `app/data/root-credential`）单独挖掉。

反过来，**多个策略之间不会相互削减**：如果一个 token 同时有 `app-read` 和 `app-admin`，它取并集。想削权要靠 `deny` 或 ceiling policy（见 5.7）。

### 5.5 用 `sudo` 有意识地开放控制面

有些 `sys/` 端点被 Vault 保护，必须显式给 `sudo`。典型例子是"值班同事要能紧急批量撤销租约"：

```bash
cat > lease-admin.hcl <<'EOF'
path "sys/leases/revoke-prefix/*" {
  capabilities = ["sudo", "update"]
}
EOF
vault policy write lease-admin lease-admin.hcl
```

实测对照：给 `sudo` 时命令成功；去掉 `sudo` 只留 `update` 则被拒绝：

```text
Error revoking leases with prefix auth/token/create: Error making API request.
URL: PUT http://127.0.0.1:8200/v1/sys/leases/revoke-prefix/auth/token/create
Code: 403. Errors:
* 1 error occurred:
	* permission denied
```

> ⚠️ **真实演练中的教训**：`vault lease revoke -prefix auth/token/create` 会撤销**该前缀下的所有 token**。我在实验中执行它之后，连自己正在用的 token（以及 dev root token）都被撤销了，环境当场失效。这正是"按前缀撤销"的威力，也正是它需要 `sudo` 的原因。生产上请把这类能力限制到极少数人，并配合审计（第 13 章）。

### 5.6 模板化策略：让一个策略适配所有团队

当 CI 有成百上千个 job 时，为每个 job 写一份策略不现实。Vault 允许在策略路径里用**模板变量**，取值来自登录身份（identity）：

```bash
cat > ci-template.hcl <<'EOF'
path "ci/data/{{identity.entity.aliases.auth_approle_12345678.name}}/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
EOF
vault policy write ci-template ci-template.hcl
vault policy read ci-template
```

```text
path "ci/data/{{identity.entity.aliases.auth_approle_12345678.name}}/*" {
  capabilities = ["create", "read", "update", "delete", "list"]
}
```

关键点：

- `{{identity.entity.aliases.<auth_accessor>.name}}` 里的 accessor 要用**实际挂载的 accessor**（`vault auth list` 可以看到，例如 `auth_approle_b1e4acc1`），写成猜测的值不会生效；
- 模板变量只在有 identity entity 的认证方式下才有值（AppRole、JWT、Kubernetes 等都会有）；
- 结果就是：**同一个策略文件**，每个 job 登录后只能访问自己名字前缀下的密钥。这比给每个 job 单独建策略安全得多，也省事得多。

### 5.7 默认策略与 ceiling

两个"不写也会有"的策略，值得认识：

```bash
vault policy list
```

```text
app-read
default
default-ceiling
root
```

- **`default`**：所有 token 自动附带。内容可以在 `vault policy read default` 看到，它给了每个 token 一些必要的自助能力：`auth/token/lookup-self`、`auth/token/renew-self`、`sys/capabilities-self`、管理自己的 `cubbyhole/*`、以及 response wrapping 相关端点。**不要试图删掉默认策略**——很多客户端（包括 Vault Agent）依赖它。
- **`default-ceiling`**（Vault 2.x 新增）：默认策略的"上限"。ceiling policy 的概念是"**子 token 无论被授予什么，都不能超过这个上限**"，是企业版做集中管控的常用手段；在 OSS 里它默认只包含极小的读权限，用来给 Agent 注册表等服务自助读取。

### 5.8 策略的工程化：格式化与验证

```bash
vault policy fmt ./app-read.hcl      # 统一缩进（只改本地文件）
vault policy write app-read ./app-read.hcl
vault policy read app-read
vault policy delete app-read
```

> **实测踩坑：从外部拷过来的策略文件可能带 BOM。** Linux/macOS 下自己写出的策略文件默认就是 UTF-8 无 BOM（`cat > app-read.hcl <<'EOF' ... EOF` 写出来的一定干净），直接 `vault policy write` 就行；但如果文件是别人用会写 BOM 的编辑器保存后拷过来的，开头可能混进 `EF BB BF`，Vault 解析时会报：
> ```text
> failed to parse policy: At 1:1: illegal char
> ```
> 排查与修复：
> 1. 看开头三个字节：`head -c 3 app-read.hcl | xxd` 打出 `efbb bf` 就是带 BOM；
> 2. 去掉 BOM：`sed -i '1s/^\xEF\xBB\xBF//' app-read.hcl`；
> 3. **最省事**：把内容从标准输入喂给 Vault，不落盘：
>    ```bash
>    vault policy write app-read - < app-read.hcl
>    ```

把策略文件放进 Git，并在 CI 里做两件事：

1. `vault policy fmt` + `git diff --exit-code`：禁止未格式化的策略合入；
2. 在**隔离的测试 Vault**上 `vault policy write` + 针对关键路径跑一组 `vault token capabilities` 断言（下节给脚本）。

## 原理：一次请求的策略判定过程

```text
请求：GET /v1/app/data/demo（token 携带策略 app-read、default）
  │
  ├─ 1. 合并 token 的所有策略（app-read + default + 身份附加策略）
  ├─ 2. 找出所有能匹配 "app/data/demo" 的 path 规则
  │       命中：app-read 的 path "app/data/demo" → read
  ├─ 3. 若任意一条命中规则包含 deny → 直接拒绝（deny 优先）
  ├─ 4. 否则取并集，判断是否包含本次操作需要的能力（GET → read）
  └─ 5. 允许 → 交给 KV 引擎；拒绝 → 403 并写审计
```

"能力检查"永远发生在**引擎之前**，所以策略是 Vault 里唯一的授权真相来源。这也是为什么路由错、路径错会表现为"策略不生效"——它其实一直在生效，只是匹配的路径和你以为的不一样。

## 踩坑与检查清单

- **只写 `data/` 不写 `metadata/`**，结果 `vault kv list` 403。列目录需要 `metadata/` 的 `list`。
- **路径用 CLI 别名而不是 API 真实路径**。`app/demo` 不等于 `app/data/demo`。
- **`+` 与 `*` 混用导致过宽授权**。例如 `path "app/*"` 会让你意外拿到 `app/metadata/*`、`app/delete/*`、`app/destroy/*` 的权限，包括**彻底销毁**——生产上要把 `destroy` 单独排除：
  ```hcl
  path "app/destroy/*" {
    capabilities = ["deny"]
  }
  ```
- **update 不等于只读**：`transit/encrypt/<key>` 用的是 `update` 能力，别给成 `read`。
- **`sudo` 是最危险的能力**，只给自动化或极少数值班账号，并确保审计开启。
- **策略变更不会自动重建 token**：token 的权限在请求时按**当前策略**实时计算，所以改了策略立即生效（不需要重新登录），反过来说——**下线权限时别忘了同时撤销旧 token**（第 7 章）。
- **验证方式固定为 `vault token capabilities`**：新写一份策略，至少对"该允许的路径"和"该拒绝的路径"各断言一次。

下一章我们把"应用怎么自己拿到密钥"这件事推到极致：让数据库密码根本不存在。
