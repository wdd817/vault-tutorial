# 第 9 章 Vault Agent：让应用完全不知道 Vault 的存在

## 需求

> 我们有 30 个老服务，它们的配置读取方式五花八门：有的读环境变量、有的读 properties 文件、有的读 JSON。让每个团队都去改代码接入 Vault SDK，现实吗？
>
> 更现实的需求是：**应用照旧读本地文件/环境变量，Vault 负责把最新密钥"送到"那个位置，并且自动完成登录、续期、重新渲染。**

Vault Agent 就是干这个的：它是一个本地守护进程，负责 `auto-auth`（自动登录）+ `template`（把密钥渲染成文件）+ `sink`（把 token 落盘供本地使用）。

## 动手

### 9.1 准备 AppRole 凭证

Agent 需要一个能自动登录的身份。用第 8 章的 AppRole：

```bash
vault auth enable approle
vault policy write app-read ./app-read.hcl
vault write auth/approle/role/ci-runner \
  token_policies=app-read \
  token_ttl=20m \
  token_max_ttl=1h \
  secret_id_ttl=10m \
  secret_id_num_uses=1

vault read -field=role_id auth/approle/role/ci-runner/role-id > agent/role-id
vault write -f -field=secret_id auth/approle/role/ci-runner/secret-id > agent/secret-id
```

### 9.2 写一份 Agent 配置

```hcl
# agent/config.hcl
pid_file = "./agent/pid"

auto_auth {
  method "approle" {
    mount_path = "auth/approle"
    config = {
      role_id_file_path                   = "./agent/role-id"
      secret_id_file_path                 = "./agent/secret-id"
      remove_secret_id_file_after_reading = false
    }
  }

  sink "file" {
    config = {
      path = "./agent/token"
      mode = 0640
    }
  }
}

vault {
  address = "http://127.0.0.1:8200"
}

template {
  destination = "./agent/rendered.env"
  contents    = <<EOT
{{- with secret "app/data/demo" -}}
APP_USERNAME={{ .Data.data.username }}
APP_PASSWORD={{ .Data.data.password }}
{{- end -}}
EOT
}
```

> **路径约定**：本节所有命令都在**仓库根目录**执行，所以配置里的相对路径统一写成 `./agent/...`——它相对的是 **Agent 进程的工作目录**，不是配置文件所在目录（这个坑 9.3 会详细讲）。

逐一解释：

| 配置块 | 作用 |
| --- | --- |
| `auto_auth.method "approle"` | Agent 启动后自动用 AppRole 登录换取 token |
| `remove_secret_id_file_after_reading = false` | 读完 secret_id 后是否删除文件；生产上可设 `true` 进一步收窄暴露面 |
| `sink "file"` | 把 token 写到本地文件，供其他本地进程（或 Agent 的 API 代理）使用 |
| `vault.address` | 目标 Vault 地址；可用 `VAULT_ADDR` 覆盖 |
| `template` | 把密钥按 Go template 渲染到 `destination` |

### 9.3 跑起来并验证

```bash
vault agent -log-level=info -config=./agent/config.hcl
```

> **路径相关的两个实测坑**：
>
> 1. **`-config` 建议给绝对路径**：`vault agent -log-level=info -config=/etc/vault-agent/config.hcl`。
>    顺便澄清一个常见误解：**`vault agent` 的 flag 顺序随便写都行**——它没有位置参数，写成 `vault agent -config=config.hcl -log-level=info` 一样能正常启动。
>    `Command flags must be provided before positional arguments` 是 **Vault CLI 的通用规则**，只在**有位置参数**的子命令上触发，比如把 `vault kv get -mount=app demo` 写成 `vault kv get demo -mount=app`：
>    ```text
>    Command flags must be provided before positional arguments. The following arguments will not be parsed as flags: [-mount=app]
>    Too many arguments (expected 1, got 2)
>    ```
> 2. **配置里的相对路径是相对于 Agent 进程的工作目录，不是配置文件所在目录**。目录不存在时会看到（下面这个 `nodir` 就是你配置里写的目录，临时文件名每次不同）：
>    ```text
>    error creating file sink: error during write check: error opening temp file in dir nodir for writing:
>    open nodir/token.tmp.187d34c0: no such file or directory
>    ```
>    解决办法：在配置里用绝对路径，或者在正确的目录下启动（用 systemd 托管时工作目录默认是 `/`，更应该写绝对路径）。本节统一**在仓库根目录启动、配置里写 `./agent/...`**，两边对得上就不会踩这个坑。

启动成功后的关键日志：

```text
[INFO]  agent.template.server: starting template server
[INFO]  agent.template.server: template server received new token
[INFO]  agent: (runner) rendered "(dynamic)" => "./agent/rendered.env"
```

渲染产物（实测）：

```text
APP_USERNAME=demo
APP_PASSWORD=s3cr3t
```

token sink（实测，内容已脱敏）：

```text
hvs.CAESII...
```

**至此，应用侧只需要 `cat agent/rendered.env` 或 `source agent/rendered.env`，一行代码都不用改。**

### 9.4 它有"持续工作"的能力

Agent 不是一次性渲染就结束了，它做三件事：

1. **续期 token**：token 接近过期时自动 `renew`（周期 token 场景下可以长期运行）；
2. **监听密钥变化**：模板里的 secret 一旦版本更新，自动重新渲染文件；
3. **失败重试**：Vault 短暂不可用时按退避重试，而不是让应用崩掉。

验证"密钥变化自动重渲染"（Agent 还在运行时执行）。**但注意：KV v2 的读响应 `lease_duration` 是 0**（实测），Agent 没有租约可以盯，只能按固定间隔轮询，默认约 5 分钟——不配这个间隔，`sleep 3` 后文件**不会**变（实测要等约 280 秒）。所以在模板上加一段 `template_config`：

```hcl
template_config {
  static_secret_render_interval = "5s"
}
```

改完重启 Agent，再跑：

```bash
vault kv put -mount=app demo username=demo password=rotated-by-ops
sleep 10
cat agent/rendered.env
```

```text
APP_USERNAME=demo
APP_PASSWORD=rotated-by-ops
```

实测（`static_secret_render_interval = "5s"`）：轮换后约 4 秒文件就更新了；把间隔调成 `60s` 对照，两次 `rendered` 日志相隔 52 秒，说明这个间隔确实生效。

**原理**：Agent 对"静态密钥"（KV v2 这类没有 lease 的）是按 `static_secret_render_interval` 主动轮询的，默认约 5 分钟；把它调小，轮换到文件更新的延迟就相应变短。生产上按"能接受的密钥生效延迟"取值即可，不必照抄 5s。

对"轮换后要平滑生效"的服务，这比"重启才能加载新密码"安全得多。

不过上面这一套有个前提：**KV v2 的密钥没有租约**，Agent 只能按固定间隔轮询。数据库账号这类**动态凭据**是另一回事——它们带 `lease_id`，Agent 会替你做掉 6.6 里的 ① 和 ②。

### 9.5 有租约的密钥：Agent 自己续期、自己换号

对带 `lease_id` 的响应（比如 `database/creds/*`），Agent 不靠轮询，而是**续期**：快到点时 `renew`，续到角色的 `max_ttl` 续不动时**重新申请一份**并重写文件。

想亲手看这个节奏，把角色 TTL 调短即可（照 6.3 的样子建，只改两个 TTL；新角色名同样要加进连接的 `allowed_roles`）：

```bash
vault write database/roles/app-agent \
  db_name=mysql-app \
  creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; GRANT SELECT ON orders.* TO '{{name}}'@'%';" \
  default_ttl=20s \
  max_ttl=26s
```

实测（150 秒里渲染文件变了 9 次，每次用户名都是新的）：

```text
[INFO]  agent: (runner) rendered "(dynamic)" => "db.env"
[WARN]  agent: vault.read(database/creds/app-agent): renewer done (maybe the lease expired)
[DEBUG] agent: (runner) rendering "(dynamic)" => "db.env"
[INFO]  agent: (runner) rendered "(dynamic)" => "db.env"
```

模板只要把 secret 路径换掉（auto_auth、sink 等配置与 9.2 相同）：

```hcl
template {
  destination = "/etc/myapp/db.env"
  command     = ["systemctl", "reload", "myapp"]   # 每次渲染后执行，用来通知应用
  contents    = <<EOT
{{- with secret "database/creds/app-agent" -}}
DB_USER={{ .Data.username }}
DB_PASS={{ .Data.password }}
{{- end -}}
EOT
}
```

注意数据库凭据的字段是**平铺**的（`{{ .Data.username }}`），没有 KV v2 那层嵌套的 `data`，别照抄上面的 KV 写法。

> **Agent 只到文件为止。** 它保证文件里永远是当前有效的凭据，却不知道你的连接池在哪；"用新凭据重建连接"仍然要做在应用里。`command` 就是交接点：Agent 每次渲染后都会执行它（实测日志里是 `executing command ...`），换成你自己的 reload 脚本或 `systemctl reload <你的服务>` 即可。应用侧那三步（续期 → 重取 → 重建连接池）见 6.6。

### 9.6 一次性使用：`-exit-after-auth`

CI 里通常只需要"登录并渲染一次"，渲染完就可以退出：

```bash
vault agent -config=agent/config.hcl -exit-after-auth
```

配合 `secret_id_num_uses=1`，一次 CI 运行消耗一个一次性凭证，任务结束不留活 token。

### 9.7 作为服务常驻

生产上把 Agent 交给 init 系统管理：

```ini
# /etc/systemd/system/vault-agent.service（Linux）
[Unit]
Description=Vault Agent
After=network-online.target

[Service]
User=app
Environment=VAULT_ADDR=https://vault.example.internal:8200
ExecStart=/usr/bin/vault agent -config=/etc/vault-agent/config.hcl
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Linux 下用 systemd（上面的 unit）托管即可；macOS 上可以用 `launchd` 写一个等价的 plist。**注意**：用 systemd 托管时服务的工作目录默认是 `/`，与交互式终端不同，配置里的所有路径都请写绝对路径。

### 9.8 Vault Proxy：更"透明"的一种形态

`vault proxy` 是 Agent 的兄弟命令，适合想保留标准 Vault API 但需要本地缓存的场景：

```bash
vault proxy -config=proxy/config.hcl
# 应用把 VAULT_ADDR 指向 http://127.0.0.1:8100，其余代码不变
```

> 注意：这条命令是在**仓库根目录**执行的，而 `proxy/config.hcl` 里的相对路径（`./role-id` 等）解析到的是**进程工作目录**（也就是仓库根目录），不是配置文件所在的 `proxy/`。本节末尾给了两种起法，任选一种、并保持前后一致。

`proxy/config.hcl` 与 Agent 的配置很像，但有两点必须写对：

```hcl
# proxy/config.hcl
pid_file = "./pid"

auto_auth {
  method "approle" {
    mount_path = "auth/approle"
    config = {
      role_id_file_path   = "./role-id"
      secret_id_file_path = "./secret-id"
    }
  }

  sink "file" {
    config = {
      path = "./token"
      mode = 0640
    }
  }
}

vault {
  address = "https://vault.example.internal:8200"
}

listener "tcp" {
  address     = "127.0.0.1:8100"
  tls_disable = true
}

# 关键：允许客户端不带 token，直接用 Agent 的 token 访问
api_proxy {
  use_auto_auth_token = true
}
```

- **`use_auto_auth_token` 必须放在顶层的 `api_proxy {}` 块里**，放进 `cache {}` 块是无效的；
- **auto_auth 必须有一个出口**：sink、`api_proxy.use_auto_auth_token = true`、或 `cache.cache_static_secrets = true` 三者至少有一个。都没有会直接启动失败：
  ```text
  error validating configuration: auto_auth requires at least one sink, api_proxy.use_auto_auth_token=true, or cache.cache_static_secrets=true
  ```

**别忘了 9.3 那条路径规则在这里同样生效**：配置里的相对路径是相对**进程工作目录**的。上面的 `./role-id`、`./secret-id` 要求你在 `proxy/` 目录里启动，并在那里准备好这两个文件（沿用 9.1 生成的即可）：

```bash
cp agent/role-id agent/secret-id proxy/   # 复用 9.1 生成的凭证
cd proxy
vault proxy -config=./config.hcl
```

如果坚持在仓库根目录执行 `vault proxy -config=proxy/config.hcl`，就要把配置里的 `./role-id`、`./secret-id` 改成 `proxy/role-id`、`proxy/secret-id`（或绝对路径），否则文件读不到，日志里会一直重试：

```text
[ERROR] proxy.auth.handler: error getting path or data from method: error="no known role ID" backoff=960ms
```

实测效果：登录成功后监听 8100，**不带任何 token** 就能读到 KV：

```bash
curl -s http://127.0.0.1:8100/v1/app/data/demo
# {"request_id":"...","data":{"data":{"password":"s3cr3t","username":"demo"},"metadata":{...}},...}
```

`VAULT_ADDR=http://127.0.0.1:8100 vault kv get -mount=app demo` 也能正常返回，客户端侧不需要改任何代码。它可以在本地代答一部分读请求（降低延迟、减轻服务端压力），并统一处理认证。对"客户端不想改代码、但希望走本地代理"的场景更合适。

## 原理：Agent 把"最后一公里"接上了

```text
                    ┌──────────────────────── Vault 服务端
                    │
   Agent 进程 ──────┤ 1. auto_auth：用 AppRole/JWT/K8s 登录 → token
   (与应用同机)      │ 2. 用 token 读取 secret（app/data/demo）
                    │ 3. 监听 secret 版本变化
                    ▼
   ┌─ sink：把 token 写到文件（给本地工具用）
   ├─ template：把 secret 渲染成 .env / properties / JSON / 证书文件
   └─ 完成！应用继续读它的本地文件
```

这个设计解决了三个现实问题：

1. **改造量**：应用不需要 Vault SDK，甚至不需要知道 Vault 存在；
2. **凭据最小化**：AppRole 的 `secret_id` 只落在 Agent 的配置文件里（且可设为读完即删），应用拿到的是渲染后的文件；
3. **轮换自动化**：密钥更新 → 文件更新 → 应用重载，整条链自动。

## 踩坑与检查清单

- **路径问题排第一**：配置里一律用绝对路径，或用 `-config` 指定绝对路径并在正确的 cwd 下启动。
- **文件权限要收紧**：`sink` 的 `mode = 0640` 只是起点；还要确保文件属主是应用用户（`chown app:app ...`），必要时用 `chmod 0600` 进一步限制，别让密钥文件对同机其他账号可读。
- **模板语法用 Go template**：`{{ .Data.data.username }}` 中的 `.Data.data` 是 KV v2 的嵌套结构（`data` 里还有 `data`），写错不会报错，只会渲染出空值。
- **template 默认会"等待依赖就绪"**：依赖的 secret 不存在时 Agent 会重试而不是退出，排查时看日志里的 render 失败信息。
- **`secret_id` 文件用 `-f` 覆盖前先确认权限**：临时文件不要落在共享目录。
- **不写 `remove_secret_id_file_after_reading = false`，`secret_id` 文件会被删掉。** 这一项的默认值是 `true`：Agent 读一次就删，进程重启后只剩 `no known secret ID` 一直退避重试（实测）。需要重启后自动登录常驻服务，就显式写 `false`；CI 这种"用完就废"的场景反而应该保持 `true`，并配合 `secret_id_num_uses=1`。
- **不要把 rendered 文件放到 docker 镜像层里**：它包含明文密钥，应该在启动时挂卷渲染。
- **Agent 不是"密钥分发中心"**：它只是同机的一个客户端。跨主机的密钥投递仍然要靠 Vault 本身（各主机各自跑 Agent）。

到这里，应用侧就绪了。下一章我们把 Vault 当成"加密机"来用，让**数据在数据库里也是密文**。
