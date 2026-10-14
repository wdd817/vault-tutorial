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
pid_file = "./pid"

auto_auth {
  method "approle" {
    mount_path = "auth/approle"
    config = {
      role_id_file_path                   = "./role-id"
      secret_id_file_path                 = "./secret-id"
      remove_secret_id_file_after_reading = false
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
  address = "http://127.0.0.1:8200"
}

template {
  destination = "./rendered.env"
  contents    = <<EOT
{{- with secret "app/data/demo" -}}
APP_USERNAME={{ .Data.data.username }}
APP_PASSWORD={{ .Data.data.password }}
{{- end -}}
EOT
}
```

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

> **相对路径的两个实测坑**（都会让 Agent 直接启动失败）：
>
> 1. **flag 必须在位置参数前**（Vault CLI 的通用规则），且 `-config` 建议给绝对路径：
>    `vault agent -log-level=info -config=/etc/vault-agent/config.hcl`
>    如果写成 `vault agent -config=config.hcl -log-level=info`，会报 `Command flags must be provided before positional arguments`。
> 2. **配置里的相对路径是相对于 Agent 进程的工作目录，不是配置文件所在目录**。工作目录不对会看到：
>    ```text
>    error creating file sink: error during write check: error opening temp file in dir .lab/agent for writing:
>    open .lab/agent/token.tmp.51e3a71f: no such file or directory
>    ```
>    解决办法：在配置里用绝对路径，或者在正确的目录下启动（用 systemd 托管时工作目录默认是 `/`，更应该写绝对路径）。

启动成功后的关键日志：

```text
[INFO]  agent.template.server: starting template server
[INFO]  agent.template.server: template server received new token
[INFO]  agent: (runner) rendered "(dynamic)" => "./rendered.env"
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

**至此，应用侧只需要 `cat rendered.env` 或 `source rendered.env`，一行代码都不用改。**

### 9.4 它有"持续工作"的能力

Agent 不是一次性渲染就结束了，它做三件事：

1. **续期 token**：token 接近过期时自动 `renew`（周期 token 场景下可以长期运行）；
2. **监听密钥变化**：模板里的 secret 一旦版本更新，自动重新渲染文件；
3. **失败重试**：Vault 短暂不可用时按退避重试，而不是让应用崩掉。

验证"密钥变化自动重渲染"（Agent 还在运行时执行）：

```bash
vault kv put -mount=app demo username=demo password=rotated-by-ops
sleep 3
cat agent/rendered.env
```

```text
APP_USERNAME=demo
APP_PASSWORD=rotated-by-ops
```

对"轮换后要平滑生效"的服务，这比"重启才能加载新密码"安全得多。

### 9.5 一次性使用：`-exit-after-auth`

CI 里通常只需要"登录并渲染一次"，渲染完就可以退出：

```bash
vault agent -config=agent/config.hcl -exit-after-auth
```

配合 `secret_id_num_uses=1`，一次 CI 运行消耗一个一次性凭证，任务结束不留活 token。

### 9.6 作为服务常驻

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

### 9.7 Vault Proxy：更"透明"的一种形态

`vault proxy` 是 Agent 的兄弟命令，适合想保留标准 Vault API 但需要本地缓存的场景：

```bash
vault proxy -config=proxy/config.hcl
# 应用把 VAULT_ADDR 指向 http://127.0.0.1:8100，其余代码不变
```

它可以在本地代答一部分读请求（降低延迟、减轻服务端压力），并统一处理认证。对"客户端不想改代码、但希望走本地代理"的场景更合适。

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
- **不要把 rendered 文件放到 docker 镜像层里**：它包含明文密钥，应该在启动时挂卷渲染。
- **Agent 不是"密钥分发中心"**：它只是同机的一个客户端。跨主机的密钥投递仍然要靠 Vault 本身（各主机各自跑 Agent）。

到这里，应用侧就绪了。下一章我们把 Vault 当成"加密机"来用，让**数据在数据库里也是密文**。
