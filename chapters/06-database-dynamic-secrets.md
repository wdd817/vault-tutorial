# 第 6 章 拿到密钥的凭证：数据库动态密钥

## 需求

> 第 1 章那个泄露事故的根因不是"密码存错了地方"，而是**这个密码本来就不该长期存在**。
>
> 需求升级为：应用向数据库申请一个**只对这个应用库有只读权限、有寿命、用完自动删除**的账号。配置文件里再也找不到任何数据库密码。

把这句话落到一个**长期运行**的服务上，需求会露出第二层：应用不会每小时重启一次，而账号只活一小时。

```text
租约时间线（Vault 管）
  ├─ default_ttl 1h    ← 到点自动 DROP USER
  └─ max_ttl    24h    ← 续期的硬顶：一份凭据最多活这么久

进程时间线（你的应用管）
  └─ 上线 → 运行几天 → 连接池老化 / 断线重连 / 数据库重启 → 继续运行
```

所以本章要交付的不是"一条申请凭据的命令"，而是**一个能长期跑下去的取号流程**：

1. **申请**：拿到一份有寿命的凭据（`lease_id` + 用户名 + 密码）；
2. **续期**：在它过期前延长寿命，密码不变；
3. **重取**：续到硬顶就换一份新的，用新账号重建连接；
4. **重连**：断线自动重连撞上 `Access denied` 时，认出这是"凭据过期"，重新申请而不是原地重试。

少任何一步，服务都会在运行满一小时或一天的时候以一个很难查的方式挂掉。6.4 到 6.6 把这条链路整个走一遍——**这是动态密钥从 demo 走向生产之间最容易被跳过的一段**。

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

`{{name}}` 和 `{{password}}` 是 Vault 在每次申请时随机生成的占位符。两个 TTL 分工不同，先分清楚，后面 6.5 全靠它们：

```text
default_ttl=1h   → 每个账号默认活 1 小时；到点 Vault 执行 DROP USER
max_ttl=24h      → 续期的硬顶：一份凭据再续也活不过 24 小时
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
rollback_statements       []
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

这几行是关键：

- `username` / `password` 是**刚刚在 MySQL 里创建出来的真实账号**；MySQL 用户名上限 32 字符，Vault 会把角色名截断（`app-readonly` 被截成 `app-readon`），别拿完整的角色名去匹配；
- `lease_duration` 是它的生存期（还可以用 `lease_renewable` 判断能不能续）；
- `lease_id` 是它的"租约编号"，后续**续期、查询、撤销都靠它**（第 12 章）。

拿这个账号真连一次数据库，确认它确实能读 `orders` 库：

```bash
docker compose exec mysql mysql -h127.0.0.1 -u<username> -p<password> orders -e "SELECT CURRENT_USER();"
```

```text
CURRENT_USER()
v-token-app-readon-XyZ9...@%
```

接下来要关心的就是：这份凭据能活多久，以及怎么让它活下去。

### 6.5 一份凭据的一生：续期、重取、到期、撤销

前面拿到的是"出生证明"，这一节把它的一生走完。

**先准备一份短命的凭据。** 把 TTL 调短，后面每一步两分钟内就能看到（生产照旧用 1h / 24h）：

```bash
vault write database/roles/app-short \
  db_name=mysql-app \
  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT SELECT ON orders.* TO '{{name}}'@'%';" \
  default_ttl=30s \
  max_ttl=2m

# 新角色名要补进连接的 allowed_roles，否则申请时会报 `"app-short" is not an allowed role`（6.7 那个坑）
vault write database/config/mysql-app \
  plugin_name=mysql-database-plugin \
  connection_url="{{username}}:{{password}}@tcp(127.0.0.1:3306)/" \
  allowed_roles="app-readonly,legacy-report,app-short" \
  username=root \
  password=rootpw

vault read database/creds/app-short      # 记下返回的 lease_id
```

```text
Key                Value
---                -----
lease_id           database/creds/app-short/AbC123...
lease_duration     30s
lease_renewable    true
password           Zx9-xxxxxxxxxxxxxxxx
username           v-token-app-short-XyZ9...
```

**续期：延长寿命，密码不变。** 在过期之前续一次（短命的那份展现不出"续满 1 小时"，所以这里用 6.4 里那份 1 小时的凭据）：

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

实测：续期之后用同一个用户名、同一个密码仍然能连库——**续期不换密码**，只是把 `expire_time` 往后推。

`-increment` 只是**请求**值，上限是角色的 `max_ttl`（本例 24 小时）：到顶时 Vault 会明确警告、把时长打折。被"打折"的完整实测输出见第 12 章 12.3。

**到期：租约和账号一起消失。** 等 `expire_time` 过去，四件事同时发生（都实测过）：

```bash
# 1) 租约查不到了
vault lease lookup database/creds/app-short/<lease-id>
```

```text
Code: 400. Errors:

* invalid lease
```

```bash
# 2) 也不能再续期了
vault lease renew database/creds/app-short/<lease-id>
```

```text
Code: 400. Errors:

* lease not found
```

```sql
-- 3) 账号已经被 DROP USER 掉了
SELECT COUNT(*) FROM mysql.user WHERE user = 'v-token-app-short-...';   -- 0
```

```text
-- 4) 拿这份凭据新建连接
ERROR 1045 (28000): Access denied for user 'v-token-app-short-...'@'127.0.0.1' (using password: YES)
```

注意第 4 条说的是**新建**连接：已经建好的那条连接仍然能用（为什么，见 6.6）。

**重取：过期没有"救回来"这一说。** 租约一消失，`renew` 和 `lookup` 都只会给你 400；唯一的出路是重新申请一份——新账号的用户名和密码跟上一份毫无关系：

```bash
vault read database/creds/app-short
```

**撤销：不等它到期，立刻收口。** 用 6.4 里那份还没到期的凭据演示（刚过期的那份已经没什么可撤的了）：

```bash
# 撤销这条租约 → Vault 执行 revocation_statements → DROP USER
vault lease revoke database/creds/app-readonly/AbC123...
```

```sql
-- 在数据库里确认账号被删掉了
SELECT user, host FROM mysql.user WHERE user LIKE 'v-token-%';
```

撤销走的是和"到期"**完全相同的清理链路**（第 12 章），区别只是谁按的按钮：一个是时间，一个是你。所以 `vault lease revoke -prefix database/creds/app-readonly` 是最猛的止损手段，也会把**你自己**正在用的凭据一起收走——按之前先读第 12 章。

### 6.6 应用侧：接住"到期"和"断线重连"

**先看一个会让排障方向跑偏的坑：连接还活着，凭据已经死了。**

Vault 到期执行的是 `DROP USER`，而 MySQL 的 `DROP USER` **不会掐掉已经建立的会话**。实测（同一个 mysql 会话，先查一次，睡 45 秒跨过 30 秒的租约到期，再查一次）：

```text
08:57:49 start (lease still valid)
+------------------------------------+---------------------+
| whoami                             | ts                  |
+------------------------------------+---------------------+
| v-token-app-short-rou7kW904AEuta@% | 2026-10-15 08:57:49 |
+------------------------------------+---------------------+
+-----------------------------+---------------------+
| phase                       | ts                  |
+-----------------------------+---------------------+
| still-alive-after-DROP-USER | 2026-10-15 08:58:34 |
+-----------------------------+---------------------+
```

第二张表里的那次查询，发生在租约到期（账号已被删除，`mysql.user` 里已经查不到）**之后**，但这条老连接照样能用。于是连接池里的 `SELECT 1` 探活一直成功、监控一片绿，直到某次断线重连、或者池子扩容要**新建**一条连接，才突然 `1045`——看着像"数据库抽风"，其实是租约到期那一刻就埋下的问题。

所以：**别用"连接还活着"判断凭据是否有效**，判断依据只有租约的 `expire_time` / `lease_duration`。（这是 MySQL 的行为；别的数据库对已建立会话的处理不一定相同，但"不要依赖老连接"这条建议是通用的。）

**应用要做的三件事，缺一不可。**

```text
① 续期（保住现有账号）
   在 ttl 的 1/2 ~ 2/3 处 renew —— 留出提前量，失败还有时间重取
② 重取（续不动时）
   renew 拿到 invalid lease / lease not found，或者 Vault 不可达
     → read database/creds/<role> 换一份新凭据
③ 重建连接池（把新凭据真正用上）
   新凭据建新池 → 探活 → 切换流量 → 排干旧池
   （旧池里那些还活着的连接，已经不属于任何一条租约了）
```

**重连钩子：把"认证失败"当成信号，而不是一个要重试的错误。**

```text
连不上 / 连接被断
  ├─ 网络类错误（超时、连接重置）→ 退避重试，继续用当前凭据
  └─ 认证类错误（MySQL 1045/28000、PostgreSQL 28P01）
       → 用户名或密码已经不在库里了，重试一万次也没用
       → 先 read database/creds/<role> 换新凭据，再重建连接
```

两个经验值：**续期要留提前量**（别等到 `expire_time` 前几秒才续，Vault 抖一下就直接过期了）；**重取可以并发，重建池要错开**（所有实例同时重取凭据 Vault 撑得住，同时重建连接池则会让数据库收下一波新建连接，按实例加一点抖动更稳）。

**谁来替你换？Vault Agent 能到哪一步。**

Agent **会先续期**，续到 `max_ttl` 续不动时**重新申请一份并重写文件**——也就是 ① 和 ② 它全包了（实测见 9.5）。**但它只知道文件，不知道你的连接池**：③ 永远要做在应用里，`command` 那一行就是交接点——Agent 每次渲染后都会执行它，换成 `systemctl reload <你的服务>` 或你自己的 reload 脚本即可。完整的配置见 9.2，动态凭据这部分见 9.5。

> 万一监控真的抓到"已经拿过期凭据在连"：能做的只有重新申请。旧用户名不会复活（`invalid lease` / `lease not found` / `Access denied` 已经说明了），也**不要**去数据库里手工把用户加回来——那等于造了一个没有租约、没人负责删除的永久账号，正好是第 1 章的事故。（撤销失败导致账号留在库里的情形，见第 12 章。）

### 6.7 静态角色：适用于"不能改密码的遗留账号"

有些遗留系统的账号是写死在别处的，不能动态创建。这时用 **static role**：Vault 接管一个**已经存在**的账号，并按固定周期轮换它的密码。

```bash
# 前提：这个账号要已经在数据库里（Vault 会去 ALTER USER 改它的密码）
docker compose exec mysql mysql -uroot -prootpw \
  -e "CREATE USER IF NOT EXISTS 'report_user'@'%' IDENTIFIED BY 'oldpw';"

vault write database/static-roles/legacy-report \
  db_name=mysql-app \
  username=report_user \
  rotation_period=24h
```

```text
Success! Data written to: database/static-roles/legacy-report
```

> **实测坑点**：`allowed_roles` 不只管动态角色，**静态角色名也必须出现在里面**。如果你在 6.2 里只写了 `allowed_roles="app-readonly"`，上面这条 `vault write database/static-roles/...` 会**直接失败**（实测，Vault 2.1.1）：
> ```text
> Code: 500. Errors:
>
> * 1 error occurred:
> 	* "legacy-report" is not an allowed role
> ```
> 补上就好：`allowed_roles="app-readonly,legacy-report"`。

> **实测坑点**：`allowed_roles` 补对之后，如果 `report_user` 在数据库里并不存在，报错会换成下面这条——因为创建 static role 会**立刻轮换一次密码**：
> ```text
> Code: 500. Errors:
>
> * 1 error occurred:
> 	* error setting credentials: failed to change password: Error 1396 (HY000): Operation ALTER USER failed for 'nosuchuser'@'%'
> ```
> 所以顺序是：先把账号建好，再交给 Vault 接管。

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

### 6.8 给应用一份最小策略

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

### 6.9 其他数据库后端与管理员密码轮换

**PostgreSQL**（换掉三处：`plugin_name`、`connection_url`、管理员的 `username` / `password`）：

```bash
vault write database/config/pg-app \
  plugin_name=postgresql-database-plugin \
  connection_url="postgresql://{{username}}:{{password}}@127.0.0.1:5432/orders?sslmode=disable" \
  allowed_roles="app-readonly" \
  username="postgres" \
  password="rootpw"
```

> 连接和角色是分开的：这条连接配好后，还得有一个 `db_name=pg-app` 的角色（把 6.3 的命令改一处 `db_name`，或直接换 `db_name=pg-app`），`database/creds/<角色>` 才有东西可发。上面 `allowed_roles` 里写的角色名要和它一致。

**轮换管理员密码**（让 Vault 自己保管"建号用的管理员密码"）：

```bash
vault write -f database/rotate-root/mysql-app
```

这一步有两个前提，不知道的话大概率会失败。

**第一，连接串要用占位符写法。** 6.2 里写的是 `{{username}}:{{password}}@tcp(127.0.0.1:3306)/`，Vault 会把 `username` / `password` 两个参数填进去，轮换完再**自动更新**它们。如果你图省事写成字面量 `root:rootpw@tcp(127.0.0.1:3306)/`，Vault 不认识串里的密码，轮换后还拿旧的去连库。

注意 **`rotate-root` 这一步本身会打印 `Success!`**——它只负责改密码。之后这条连接还能不能用，取决于你有没有用占位符写法：

- **占位符写法（本章 `mysql-app` 就是）**：Vault 会把新密码写回自己存的配置里，所以轮换之后照旧能 `vault read database/creds/<角色>`（实测）；
- **字面量写法**：Vault 不认识串里的密码，轮换后还拿旧的去连库，这条连接就废了——再读凭据会拿到 `Code: 500` 加 `Error 1045 (28000): Access denied for user '<你配置里的管理员>'@'localhost'`（这条 500 的包装在不同环境下不完全一致，有时带 `* error verifying - ping:` 前缀，有时直接就是 `* Error 1045 ...`，不用纠结它的措辞；示例输出里的 `vaultadmin` 来自那次实验的配置，换成你自己的管理员名即可）。

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
  密码生命：default_ttl（本例 1 小时），每次续期最多活到 max_ttl（本例 24 小时）
  泄露窗口：≤ max_ttl，且租约可即时撤销
            （注意不是 ≤ default_ttl：只要应用还在续期，一份泄露出去的密码就能活到硬顶）
  轮换成本：0（每次申请都是新账号）
  权限粒度：每个角色一套 SQL，可以是只读/单库/单表
```

**密码会过期，所以应用必须把它当成"会话"而不是"密码"来对待**——上面"泄露窗口""轮换成本""权限粒度"三行，都是这一条设计的副产品。把需求里的四步（申请 → 续期 → 重取 → 重连）摊开，一份凭据的完整一生就是这个状态机：

```text
read database/creds/<role>
   │  建账号 + 登记租约（default_ttl 1h，硬顶 max_ttl 24h）        ← 6.4
   ▼
使用中 ── renew：只推 expire_time，密码不变，最多推到 max_ttl      ← 6.5
   │
   ├─ 到期 expire ─┐
   ├─ 撤销 revoke ─┴─▶ 执行 revocation_statements（DROP USER），租约消失
   │                    lookup → invalid lease / renew → lease not found
   └─ 续到硬顶 ───────▶ 只能重新申请一份（回到最上面），重建连接      ← 6.6
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
- **`rotate-root` 是不可逆操作**：在非生产环境先练，确认 Vault 可访问、备份可用。
- **`default_ttl` 别设太长，`max_ttl` 要想清"最坏能活多久"。** 动态密钥的全部价值就在"短"；而 `max_ttl` 决定一份泄露出去的凭据最坏能撑多久，也是应用不得不换号的周期。
- **别把"申请到凭据"当成终点。** 应用必须在运行期完成续期 → 重取 → 重建连接池三件事；Vault Agent 只替你把新凭据渲染到文件，**它不碰你的连接池**（6.5、6.6、第 9 章）。
- **别用"连接还活着"判断凭据是否有效。** MySQL 的 `DROP USER` 不掐已建立的会话，探活全绿也可能早就过期了（6.6）。
- **重连钩子要认得出"凭据过期"。** 把 MySQL `1045`/`28000`、PostgreSQL `28P01` 这类认证失败接到"重新申请凭据"分支，不要拿旧密码原地重试——那只会刷出一片 `Access denied`，还可能撞上数据库的失败计数。
- **记得给应用策略只留 `read database/creds/<role>`。** 顺便把 `database/config/*`、`database/roles/*` 用 `deny` 显式封掉。
- **不是所有场景都适合动态密钥。** 老系统不支持改密码时用静态角色；需要固定账号的地方用 KV + 定期轮换流程。

到这里，"密钥从哪来"已经解决了。但应用拿到的那个 `vault read` 靠什么身份？答案是 token——第 7 章。
