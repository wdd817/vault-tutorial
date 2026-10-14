# 第 3 章 Hello Vault：状态、登录与第一个 secret

## 需求

> 昨天我照文档敲了三行命令，其中一行报错、一行没输出，我不知道问题出在哪。我需要知道：**怎么在 30 秒内判断"Vault 是不是好的、我现在是谁、我能不能读这个路径"**。

本章的目标是把"排障三连"练成肌肉记忆，并建立对 **路径（path）** 这一核心抽象的正确直觉。

## 动手

### 3.1 排障三连之一：Vault 活着吗

```bash
export VAULT_ADDR=http://127.0.0.1:8200
vault status
```

看四行就够：

```text
Initialized     true     ← 是否已初始化（false 说明还没 operator init）
Sealed          false    ← 是否已解封（true 时任何数据操作都会被拒绝）
Version         2.1.1    ← 服务端版本
Storage Type    inmem    ← 存储类型（inmem = dev 模式，重启即丢）
```

如果你看到的不是这张表，而是：

```text
Error checking seal status: Get "http://127.0.0.1:8200/v1/sys/seal-status": dial tcp 127.0.0.1:8200: connect: connection refused
```

——服务端没起来，或 `VAULT_ADDR` 写错了，去启动 Vault 的那个窗口看日志。

退出码也有含义：`vault status` 在 **未解封时返回 2**，在 **连不上时返回 1**。脚本里可以直接用：

```bash
vault status >/dev/null 2>&1
case $? in
  0) echo 'unsealed and ready' ;;
  2) echo 'sealed' ;;
  *) echo 'unreachable' ;;
esac
```

### 3.2 排障三连之二：我现在是谁

```bash
vault token lookup
```

```text
Key                 Value
---                 -----
accessor            xxxxxxxx
creation_time       1790165125
creation_ttl        768h
display_name        userpass-alice
entity_id           b09d924d-...
expire_time         2026-10-25T20:05:25.7154581+08:00
id                  hvs.CAESIHh8...
meta                map[username:alice]
num_uses            0
orphan              true
path                auth/userpass/login/alice
policies            [app-read default]
renewable           true
ttl                 767h59m59s
type                service
```

这四行是本教程后面反复要用到的定位信息：

- `policies` —— 你**实际**拿到的策略（读不到路径时先看这里）；
- `path` —— 这个 token 是谁签发的（`auth/userpass/login/alice` 说明是 alice 用密码登录来的）；
- `ttl` / `creation_ttl` —— 还剩多久和最初多久；
- `type` —— `service` 还是 `batch`（第 7 章细讲）。

### 3.3 排障三连之三：这个路径我能做什么

```bash
vault token capabilities secret/data/hello
# read
```

还可以替**别人**问（需要 root 或相应的 `sys/capabilities` 权限），这在排查"某个服务的 token 为什么读不到"时极其好用：

```bash
vault token capabilities hvs.CAESIHh8... secret/data/hello
```

返回的是最小能力集合，可能的值：`deny`、`create`、`read`、`update`、`patch`、`delete`、`list`、`sudo`。

### 3.4 第一次读写：看清楚"路径"是什么

```bash
vault kv put -mount=secret hello message="hello vault" env=dev
vault kv get -mount=secret hello
vault kv list -mount=secret
vault kv delete -mount=secret hello
```

`vault kv` 是 KV 引擎的**专用子命令**，它会在底下悄悄地把路径加上 `data/` 前缀。等价的原生 API 路径是：

```bash
vault read secret/data/hello
```

```text
Key         Value
---         -----
data        map[env:dev message:hello vault]
metadata    map[created_time:... deletion_time: destroyed:false version:1]
```

理解这条对应关系，后面写策略时就不会写出"看起来对但永远 403"的规则。

### 3.5 看看 Vault 里到底挂了哪些"柜子"

```bash
vault secrets list
vault auth list
```

```text
Path               Type              Accessor                   Description
----               ----              --------                   -----------
agent-registry/    agent_registry    agent-registry_c7e72d4b    agent registry
cubbyhole/         cubbyhole         cubbyhole_b06ffeee         per-token private secret storage
identity/          identity          identity_0d6ba9d2          identity store
secret/            kv                kv_ef799836                key/value secret storage
sys/               system            system_926c7e3c             system endpoints used for control, policy and debugging

Path        Type       Accessor                 Description                Version
----        ----       --------                 -----------                -------
token/      token      auth_token_f152e1ef      token based credentials    n/a
```

逐个认识（这是 Vault 的"出厂默认值"）：

| 路径 | 类型 | 作用 | 在本教程中 |
| --- | --- | --- | --- |
| `secret/` | kv（v2） | 默认的 KV 存储，"柜子" | 第 4 章 |
| `cubbyhole/` | cubbyhole | **只属于当前 token** 的私有空间，token 失效即消失 | 3.6 节 |
| `identity/` | identity | 实体（entity）与组，把人/机器的多种登录方式合并成一个身份 | 第 8 章 |
| `sys/` | system | 系统管理端点：策略、挂载、租约、审计 | 全书 |
| `agent-registry/` | agent_registry | Vault 2.x 新增的 Agent 注册表（主要在企业版能力中使用） | 忽略即可 |
| `token/`（auth） | token | 所有认证方式最终都会签发 token | 第 7 章 |

### 3.6 cubbyhole：一个有意思的特例

```bash
vault write cubbyhole/only-mine value="just for my token"
vault read cubbyhole/only-mine
```

```text
Key      Value
---      -----
value    just for my token
```

cubbyhole 的关键特性：**它以 token 为单位隔离**。换个 token 就看别人的 cubbyhole 了。实测验证一下（alice 是第 5 章会创建的用户，这里先演示现象）：

```bash
export VAULT_TOKEN=root
vault write cubbyhole/root-only value=secret
# 换成 alice 的 token 再读
export VAULT_TOKEN='<alice-token>'
vault read cubbyhole/root-only
vault read -field=value cubbyhole/root-only
```

```text
No value found at cubbyhole/root-only
```

注意即使有 `root` 也一样：cubbyhole 的隔离是"每个 token 一个独立命名空间"，root 权限也无法跨 token 读取。这一特性常被用来做 **token 交换/包装**（第 8 章的 response wrapping 就是基于它）。

### 3.7 顺带认识：`vault path-help`

忘了某个路径的参数？不用翻文档：

```bash
vault path-help secret/data
```

```text
Request:        data
Matching Route: ^.*$

<no synopsis>


## DESCRIPTION

This backend provides a versioned key-value store. The kv backend reads and
writes arbitrary secrets to the storage backend. The secrets are
encrypted/decrypted by Vault: they are never stored unencrypted in the backend
and the backend never has an opportunity to see the unencrypted value. ...

## PATHS

    ^config$
        Configures settings for the KV store

    ^data/.*$
        Write, Read, and Delete data in the KV store.

    ^delete/.*$
        Marks one or more versions as deleted in the KV store.

    ^destroy/.*$
        Permanently removes one or more versions in the KV store

    ^metadata/.*$
        Configures settings for the KV store

    ^undelete/.*$
        Undeletes one or more versions from the KV store.
```

注意 `PATHS` 这一段：KV v2 对外暴露了 5 组路径（`data/`、`delete/`、`destroy/`、`undelete/`、`metadata/`），这正是第 4 章要逐条讲的"版本与删除语义"。而 `vault kv get` 只是帮你把这 5 组路径包装成了友好子命令。

`vault path-help` 读的是**服务端**的插件描述，所以它永远和你的 Vault 版本一致，比记忆更可靠。

## 原理：为什么一切都以"路径"为中心

Vault 的 API 是一个巨大的 **路径树**，所有能力都可以归纳成一句话：

> **对某个路径发起某个操作（read/write/list/delete），Vault 先检查策略，再交给挂载在该路径上的插件。**

```text
                     ┌── secret/     → kv 插件
路径树的根 ── 挂载点 ─┼── transit/    → transit 插件
                     ├── database/   → database 插件
                     ├── auth/       → 认证方法（登录端点）
                     └── sys/        → Vault 自身的控制面
```

由此推出三条实用结论：

1. **策略写的是路径，不是"资源名"。** 所以策略的粒度完全取决于你怎么划分路径（第 5 章会用"每个团队一个前缀"的方式演示）。
2. **同一个插件可以挂载多次。** 例如 `kv-prod/` 和 `kv-dev/` 可以是两个独立的 KV，各有各的权限（第 4 章）。
3. **排障永远从路径开始。** 报 403 时，先问"CLI 实际请求的是哪个 API 路径"——`vault kv` 会帮你加 `data/`，这是最常见的错配来源。

## 踩坑与检查清单

- **403 不一定是策略写错了，可能是路径写错了。** 用 `vault kv get -mount=app demo` 时实际请求 `app/data/demo`；用 `vault kv get app/demo` 时实际请求 `app/data/data/demo`。策略要按**真实 API 路径**写。
- **`No value found at ...` 通常意味着"路径不存在或已删除"**，而不是权限问题。权限问题会明确报 `403 permission denied`。
- **排查顺序固定为：`vault status` → `vault token lookup` → `vault token capabilities <path>`。** 90% 的"读不到密钥"问题这三步就能定位。
- **别在生产用 `vault read` 直接读 KV v2 的 `data/` 路径去改数据**：它绕过了 `vault kv` 的版本校验，容易写出非预期版本。用 `vault kv put/patch`。
- **`VAULT_TOKEN` 与本地 token helper 会打架。** 设了 `VAULT_TOKEN` 时它以环境变量为准；`vault login` 会提示你不要重复登录，这是正常的。

下一章进入第一个真正有用的引擎：KV v2。
