# 第 6 章 拿到密钥的凭证：数据库动态密钥

## 需求

> 第 1 章那个泄露事故的根因不是"密码存错了地方"，而是**这个密码本来就不该长期存在**。
>
> 需求升级为：应用启动时向数据库申请一个**只能用一小时、只对这个应用库有只读权限、用完自动删除**的账号。配置文件里再也找不到任何数据库密码。

这就是 **Dynamic Secrets（动态密钥）**——Vault 最有价值、也最容易被忽略的能力。

## 动手

### 6.1 准备一个真实数据库（可选）

动态密钥必须对着**真实后端**才有意义，所以这一步需要一个 MySQL。用 Docker 起一个最省事：

```yaml
# docker-compose.yml
services:
  mysql:
    image: mysql:8.4
    environment:
      MYSQL_ROOT_PASSWORD: rootpw
      MYSQL_DATABASE: orders
    ports:
      - "3306:3306"
```

> MySQL 8.4 里 `caching_sha2_password` 已经是默认认证插件，而旧的 `--default-authentication-plugin` 选项在 8.4 已被移除（带上它 mysqld 会以 `unknown variable` 直接退出），所以这里不需要任何额外的启动参数。

```bash
docker compose up -d
docker compose exec mysql mysql -uroot -prootpw -e "SELECT VERSION();"
```

> 如果你手边没有 Docker，本章的**配置类命令**（策略、角色、语法）依然可以完整练习；只有"真正生成账号并连接数据库"这一步需要后端。

### 6.2 挂载 database 引擎并配置连接

```bash
vault secrets enable database

vault write database/config/mysql-app \
  plugin_name=mysql-database-plugin \
  connection_url="{{username}}:{{password}}@tcp(127.0.0.1:3306)/" \
  allowed_roles="app-readonly,legacy-report" \
  username=root \
  password=rootpw
```

```text
Success! Data written to: database/config/mysql-app
```

几个参数值得说明：

| 参数 | 含义 |
| --- | --- |
| `plugin_name` | 数据库类型插件：`mysql-database-plugin`、`postgresql-database-plugin`、`mssql-database-plugin`… |
| `connection_url` | 带管理员凭据的连接串，管理员账号密码用 `{{username}}` / `{{password}}` 占位（不同插件格式不同） |
| `allowed_roles` | 白名单：只有列在这里的角色才能使用这条连接（**别省略**；动态角色和静态角色都算） |
| `username` / `password` | 管理员账号，Vault 用它去建/删普通账号 |

> **实测会遇到的真实报错**：如果后端连不上，`vault write database/config/...` 会**直接失败**，因为 Vault 会立刻验证连接：
> ```text
> Code: 400. Errors:
>
> * error creating database object: error verifying - ping: dial tcp 127.0.0.1:3306: connect: connection refused
> ```
> 这是好事：配置阶段就把"连不上"暴露出来，而不是等到应用启动才发现。

### 6.3 定义角色：申请账号时动态执行的 SQL

```bash
vault write database/roles/app-readonly \
  db_name=mysql-app \
  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT SELECT ON orders.* TO '{{name}}'@'%';" \
  default_ttl=1h \
  max_ttl=24h
```

```text
Success! Data written to: database/roles/app-readonly
```

`{{name}}` 和 `{{password}}` 是 Vault 在每次申请时随机生成的占位符。角色的语义：

```text
default_ttl=1h   → 每个账号默认活 1 小时（到期 Vault 自动 DROP USER）
max_ttl=24h      → 续期最多续到 24 小时，之后必须重新申请
```

验证角色配置：

```bash
vault read database/roles/app-readonly
```

```text
Key                      Value
---                      -----
creation_statements      [CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT SELECT ON orders.* TO '{{name}}'@'%';]
credential_type          password
db_name                  mysql-app
default_ttl              1h
max_ttl                  24h
renew_statements         []
revocation_statements    []
rollback_statements      []
```

### 6.4 申请一个账号（真正的动态密钥）

```bash
vault read database/creds/app-readonly
```

```text
Key                Value
---                -----
lease_id           database/creds/app-readonly/AbC123...
lease_duration     1h
lease_renewable    true
password           A1a-xxxxxxxxxxxxxxxx
username           v-token-app-readon-XyZ9...
```

这三行是关键：

- `username` / `password` 是**刚刚在 MySQL 里创建出来的真实账号**；MySQL 用户名上限 32 字符，Vault 会把角色名截断（`app-readonly` 被截成 `app-readon`），别拿完整的角色名去匹配；
- `lease_duration` 是它的生存期；
- `lease_id` 是它的"租约编号"，后续续期/撤销都靠它（第 12 章）。

拿这个账号真连一次数据库，然后等它过期（或手动撤销）再看一眼：

```bash
# 撤销这条租约 → Vault 执行 revocation_statements → DROP USER
vault lease revoke database/creds/app-readonly/AbC123...
```

```sql
-- 在数据库里确认账号被删掉了
SELECT user, host FROM mysql.user WHERE user LIKE 'v-token-%';
```

### 6.5 静态角色：适用于"不能改密码的遗留账号"

有些遗留系统的账号是写死在别处的，不能动态创建。这时用 **static role**：Vault 接管它的密码并在固定周期轮换。

```bash
vault write database/static-roles/legacy-report \
  db_name=mysql-app \
  username=report_user \
  rotation_period=24h
```

```text
Success! Data written to: database/static-roles/legacy-report
```

> **实测坑点**：`allowed_roles` 不只管动态角色，**静态角色名也必须出现在里面**。如果你在 6.2 里只写了 `allowed_roles="app-readonly"`，上面这条命令会**直接失败**：
> ```text
> Code: 500. Errors:
>
> * 1 error occurred:
> 	* "legacy-report" is not an allowed role
> ```
> 补上就好：`allowed_roles="app-readonly,legacy-report"`。

> **实测提示**：创建 static role 会**立刻轮换一次**密码（`last_vault_rotation` 就是创建时刻），`report_user` 原来的密码马上失效，别再用旧密码连库。

```bash
vault read database/static-roles/legacy-report
vault read database/static-creds/legacy-report    # 每次读取都返回当前密码
vault write -f database/rotate-role/legacy-report # 手动触发轮换
```

> **实测提示**：`static-role` 依赖已存在的连接配置。如果 `database/config/mysql-app` 没写成功，会看到：
> ```text
> Code: 500. Errors:
>
> * 1 error occurred:
> 	* failed to find entry for connection with name: "mysql-app"
> ```
> —— 先解决连接配置，再创建角色。按本章顺序照抄时这里更常见的失败其实是上面的 `allowed_roles`，"连接缺失"一般是手滑删了配置才会撞到。

### 6.6 给应用一份最小策略

应用只需要读一个路径：

```hcl
# app-db-creds.hcl
path "database/creds/app-readonly" {
  capabilities = ["read"]
}
```

```bash
vault policy write app-db-creds ./app-db-creds.hcl
```

注意这里**只有 `read`**：应用连"看角色配置"都不需要，更不该有 `database/config/*` 或 `database/roles/*` 的任何权限。

### 6.7 其他常用数据库配置

**PostgreSQL**（把三处替换掉即可）：

```bash
vault write database/config/pg-app \
  plugin_name=postgresql-database-plugin \
  connection_url="postgresql://{{username}}:{{password}}@127.0.0.1:5432/orders?sslmode=disable" \
  allowed_roles="app-readonly" \
  username="postgres" \
  password="rootpw"
```

**轮换管理员密码**（让 Vault 自己保管"建号用的管理员密码"）：

```bash
vault write -f database/rotate-root/mysql-app
```

这一步有两个前提，不知道的话大概率会失败。

**第一，连接串要用占位符写法。** 6.2 里写的是 `{{username}}:{{password}}@tcp(127.0.0.1:3306)/`，Vault 会把 `username` / `password` 两个参数填进去，轮换完再**自动更新**它们。如果你图省事写成字面量 `root:rootpw@tcp(127.0.0.1:3306)/`，Vault 不认识串里的密码，轮换后还拿旧的去连库。

注意 **`rotate-root` 这一步本身会打印 `Success!`**——它只负责改密码，不管这条连接以后还能不能用。坑在后面：从此这条连接就废了，再 `vault read database/creds/<角色>` 会拿到 `Code: 500` 加 `Error 1045 (28000): Access denied for user 'vaultadmin'@'localhost'`（这条 500 的包装在不同环境下不完全一致，有时带 `* error verifying - ping:` 前缀，有时直接就是 `* Error 1045 ...`，不用纠结它的措辞）。

下面这条则是稳定复现的：**重写 config 时**——比如把那份字面量配置照原样再写一遍——直接失败，`error verifying - ping:` 一样在，但 Code 变成了 400：

```text
Code: 400. Errors:

* error creating database object: error verifying - ping: Error 1045 (28000): Access denied for user 'vaultadmin'@'localhost' (using password: YES)
```

顺带一句：字面量写法的那份 config，`vault read database/config/<名字>` 会把明文密码原样回显（本章 `mysql-app` 用的是占位符写法，读出来只有 `{{username}}:{{password}}`，没有密码字段）。

**第二，管理员账号必须以 `'user'@'%'` 的形式存在。** mysql 插件执行的是 `ALTER USER '<连接配置里的 username>'@'%'`，它不会去解析 `user@host`。用包管理器装在 Linux 上的 MySQL 通常只有 `root@localhost`，于是你会看到：

```text
Code: 500. Errors:

* 1 error occurred:
	* failed to update user: failed to change password: Error 1396 (HY000): Operation ALTER USER failed for 'root'@'%'
```

执行成功后，**Vault 所用那个 `'user'@'%'` 账号的原密码在 Vault 之外就失效了**（Vault 把新密码只存在自己的存储里）。但要注意它**只改 `'%'` 这一条**，所以"旧密码还能不能用"取决于你的客户端**命中哪条记录**，而这与 MySQL 的 `skip_name_resolve` 有关（以下三条都在本章的 docker-compose 环境里实测过）：

- **本章 docker-compose 用的官方 mysql 镜像 `skip_name_resolve=1`**：从 TCP 连 `127.0.0.1` **不会**被解析成 `localhost`，于是命中 `root@'%'` —— `mysql -h127.0.0.1 -uroot -prootpw` 实测**直接被拒**（1045）；
- 走容器内的**本地 socket**（`docker compose exec mysql mysql -uroot -prootpw`）命中的是没被动过的 `root@localhost`，旧密码**仍然可用**——"明明改了密码却好像还能连"的错觉多半来自这里；
- 用包管理器装在 Linux 上的 MySQL 通常会把 `127.0.0.1` 解析成 `localhost`，那种环境 TCP 也会命中 `root@localhost`，旧密码同样还能用。

所以生产上更稳的做法是给 Vault 一个**专职管理员账号**（比如 `vaultadmin`，只以 `'%'` 形式存在），而不是直接用 `root`。这是把"最敏感的那把钥匙"也交给 Vault 管理的标准做法。请在测试环境先演练，并确认自己有别的途径恢复（第 15 章的备份）。

## 原理：动态密钥把"密钥"变成了"会话"

对比一下两种模型：

```text
静态密钥模型
  密码生命：永久
  泄露窗口：永久
  轮换成本：改 7 个地方（第 1 章的清单）
  权限粒度：一个账号全库通用

动态密钥模型
  密码生命：default_ttl（本例 1 小时）
  泄露窗口：≤ 1 小时，且租约可即时撤销
  轮换成本：0（每次申请都是新账号）
  权限粒度：每个角色一套 SQL，可以是只读/单库/单表
```

数据库引擎内部做的事：

```text
应用 ── read database/creds/app-readonly ──▶ Vault
                                              │ 1. 生成随机用户名/密码
                                              │ 2. 执行 creation_statements（CREATE USER/GRANT）
                                              │ 3. 把凭据返回给应用，同时登记 Lease（1h）
                                              ▼
                                    到期或撤销时执行 revocation_statements（DROP USER）
```

两类可选的额外语句值得知道：

- `revocation_statements`：默认是 `DROP USER`，需要额外清理时自己写；
- `renew_statements`：某些数据库（如 MongoDB）续期时需要额外操作。

## 踩坑与检查清单

- **`allowed_roles` 别漏，也别只写动态角色。** 它限制"哪些角色能用这条连接"，漏配会让任何有权限的人都能借这条连接去建高权账号。注意它**同时约束动态角色和静态角色**，`static-roles` 里用到的角色名也必须列进去。
- **管理员账号权限要刚好够用。** 建号/删号 + 授权即可，不要给它 `SUPER` 之类。
- **`default_ttl` 别设太长。** 动态密钥的全部价值就在"短"。业务侧必须能接受"启动时取一次凭据、到期前重新取"。
- **应用要处理"凭据到期"。** 动态密钥会消失，应用必须支持重新申请（第 9 章的 Vault Agent 可以帮你自动完成）。
- **`rotate-root` 是不可逆操作**：在非生产环境先练，确认 Vault 可访问、备份可用。
- **记得给应用策略只留 `read database/creds/<role>`。** 顺便把 `database/config/*`、`database/roles/*` 用 `deny` 显式封掉。
- **不是所有场景都适合动态密钥。** 老系统不支持改密码时用静态角色；需要固定账号的地方用 KV + 定期轮换流程。

到这里，"密钥从哪来"已经解决了。但应用拿到的那个 `vault read` 靠什么身份？答案是 token——第 7 章。
