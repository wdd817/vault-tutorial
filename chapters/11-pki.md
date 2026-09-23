# 第 11 章 PKI：把证书签发变成一次 API 调用

## 需求

> 内网服务之间要上 TLS，但现状是：
>
> - 证书靠人手动申请，**有效期一年，到期前没人记得换**，出过两次线上事故；
> - 私钥在邮件里传过；
> - 想上 mTLS（双向认证）时，发现根本没有统一的 CA 可以信任。
>
> 目标：**任何服务都能在启动时自己申请一张 24 小时有效的证书，到期自动续，人不用参与。**

Vault 的 PKI 引擎是一个**内置的 CA**：它签发、吊销证书，并对外提供 CRL。

## 动手

### 11.1 生成根 CA

```powershell
vault secrets enable pki
vault secrets tune -max-lease-ttl=87600h pki      # 10 年
vault write pki/root/generate/internal `
  common_name="example.internal Root CA" `
  ttl=87600h
```

```text
Key              Value
---              -----
certificate      -----BEGIN CERTIFICATE-----
MIIDNzCCAh+gAwIBAgIUUMYa8XE6SZfCBRmQMI0xVZkQCfIwDQYJKoZIhvcNAQEL
...
-----END CERTIFICATE-----
expiration       2105525234
issuer_id        8e340a0b-fcdb-df78-f5da-6412d1045770
serial_number    50:c6:1a:f1:71:3a:49:97:c2:05:19:90:30:8d:31:55:99:10:09:f2
```

记住三条：

- `secrets tune -max-lease-ttl` 必须**大于等于**证书 TTL，否则签发时会报"超出了挂载点的 max_lease_ttl"；
- 根 CA 的私钥由 Vault 保管（`exportable` 默认 false）；
- 生产上更常见的做法是**根 CA 离线**，Vault 里只放中间 CA（见 11.6）。

### 11.2 定义签发角色

角色决定"能签什么证书"：

```powershell
vault write pki/roles/web-server `
  allowed_domains="example.internal" `
  allow_subdomains=true `
  max_ttl=720h `
  key_type=rsa `
  key_bits=2048
```

```text
Success! Data written to: pki/roles/web-server
```

关键字段（`vault read pki/roles/web-server` 实测）：

| 字段 | 含义 |
| --- | --- |
| `allowed_domains` | 允许签发的域名白名单（**最重要的安全边界**） |
| `allow_subdomains` | 是否允许 `*.example.internal` 这类子域 |
| `allow_bare_domains` | 是否允许签发裸域 `example.internal` |
| `allow_ip_sans` | 是否允许把 IP 放进 SAN |
| `max_ttl` | 单张证书的 TTL 上限 |
| `key_type` / `key_bits` | 密钥算法（rsa/ecdsa/ed25519） |
| `require_cn` | 是否强制 CN |
| `enforce_hostnames` | 是否校验 CN 必须是合法主机名 |

### 11.3 签发一张证书

```powershell
vault write pki/issue/web-server common_name="api.example.internal" ttl=24h
```

返回里有 `certificate`、`private_key`、`ca_chain`、`serial_number`、`expiration`。用 JSON 格式便于脚本处理：

```powershell
$cert = (vault write -format=json pki/issue/web-server common_name="web.example.internal" ttl=24h | ConvertFrom-Json).data
$cert.serial_number      # 15:c6:77:c6:0d:33:53:04:...
$cert.ca_chain.Count     # 1（本例是自签根，直接签叶子）
$cert.private_key_type   # rsa

$cert.certificate | Set-Content .\web.crt -Encoding ascii
$cert.private_key | Set-Content .\web.key -Encoding ascii
```

> **Windows 提示**：用 `Set-Content -Encoding ascii` 写出的 PEM 是 CRLF 换行，多数工具能接受；如果某个工具报"格式错误"，把文件转成 LF 再试。

### 11.4 吊销与 CRL

按序列号吊销：

```powershell
vault write pki/revoke serial_number=$($cert.serial_number)
```

```text
Key                        Value
---                        -----
revocation_time            1790165235
revocation_time_rfc3339    2026-09-23T12:17:08.3159029Z
state                      revoked
```

下载 CRL（供下游服务校验吊销状态）：

```powershell
vault read -field=certificate pki/cert/crl | Set-Content .\crl.pem -Encoding ascii
```

> 注意是 **`pki/cert/crl`**（PEM 格式的 CRL）。`vault read pki/crl/pem` 这种写法在 CLI 里会被当成数字比较而报错（`invalid character '-' in numeric literal`）。

配置 AIA / CRL 分发点，让下游能自动找到吊销列表：

```powershell
vault write pki/config/urls `
  issuing_certificates="http://127.0.0.1:8200/v1/pki/ca" `
  crl_distribution_points="http://127.0.0.1:8200/v1/pki/crl"
```

> 不配这个会收到警告（实测）：
> ```text
> WARNING! The following warnings were returned from Vault:
> * This mount hasn't configured any authority information access (AIA) fields;
>   this may make it harder for systems to find missing certificates in the chain
>   or to validate revocation status of certificates.
> ```

### 11.5 域名越权会被拦下

```powershell
vault write pki/issue/web-server common_name="evil.example.com" ttl=24h
```

```text
Error writing data to pki/issue/web-server: Error making API request.
Code: 400. Errors:

* common name evil.example.com not allowed by this role
```

这就是 `allowed_domains` 的价值：**没有它，任何能调用 `pki/issue/*` 的服务都能给自己签一张任意域名的证书。**

### 11.6 生产架构：根 CA 离线 + 中间 CA

不要用根 CA 直接签叶子证书。推荐做法：

```text
① 离线机器上生成根 CA（或用企业 PKI / HSM）
② 在 Vault 里生成 CSR：
     vault write -field=csr pki/intermediate/generate/internal common_name="example.internal Intermediate CA" > int.csr
③ 用根 CA 签这个 CSR（离线操作），得到 intermediate CA 证书
④ 把证书导入 Vault：
     vault write pki/intermediate/set-signed certificate=@int.pem
⑤ 之后所有签发都由中间 CA 完成；根 CA 私钥永远不联网
```

这样即使 Vault 被攻破，攻击者也只能用中间 CA 签证书，而**根 CA 可以在不重建整个信任链的前提下吊销它**。

### 11.7 角色的最小权限：给"能签发"的调用方一份策略

```hcl
# pki-issuer.hcl
path "pki/issue/web-server" {
  capabilities = ["update"]
}
```

```powershell
vault policy write pki-issuer .\pki-issuer.hcl
```

应用侧只需要这一条。**绝对不要**把 `pki/root/*`、`pki/roles/*`、`pki/intermediate/*` 给业务服务。

### 11.8 结合 Agent 做自动续期

把"签发"和"落地成文件"合起来，就是完整的自动证书方案：

```hcl
template {
  destination = "/etc/nginx/tls/server.pem"
  contents = <<EOT
{{- with pkiCert "pki/issue/web-server" "common_name=svc.example.internal" "ttl=24h" -}}
{{ .Cert }}
{{ .CA }}
{{- end -}}
EOT
}
```

实测（Vault 2.1.1）渲染出的 `server.pem` 里包含 **2 个 `BEGIN CERTIFICATE` 块**：第一个是叶子证书，第二个是 CA（可以直接作为 nginx 的 `ssl_certificate` 使用，因为 nginx 要求"叶子 + 链"在同一个文件里）。日志里能看到：

```text
[INFO]  agent: (runner) rendered "(dynamic)" => "/etc/nginx/tls/server.pem"
```

Agent 会在证书接近过期时**自动重新签发并重写文件**，配合 `nginx -s reload` 就能做到"证书永不过期"。

> **权限提醒（实测踩坑）**：渲染 `pkiCert` 的那个身份必须拥有 `pki/issue/web-server` 的 `update` 权限。如果它只有第 5 章的 `app-read`，Agent 会一直报：
> ```text
> [WARN] agent: (view) vault.pki(pki/issue/web-server->...): Error making API request.
> URL: PUT http://127.0.0.1:8200/v1/pki/issue/web-server
> Code: 403. Errors:
> * permission denied
> ```
> 正确做法是给这个角色同时挂上"读配置"和"签发证书"两个策略，例如：
> ```powershell
> vault write auth/approle/role/nginx-agent `
>   token_policies="app-read,pki-issuer" `
>   token_ttl=20m token_max_ttl=1h
> ```

## 原理：PKI 把"证书生命周期"变成了状态机

```text
                  ┌─ root/generate ──▶ 根 CA（离线）
                  ├─ intermediate/generate + set-signed ──▶ 中间 CA
                  ├─ roles/<name> ───▶ 签发规则（域名/TTL/算法）
                  ├─ issue/<role> ───▶ 签发（返回 cert + key + chain）
                  ├─ sign/<role> ────▶ 用已有 CSR 签发（更安全：私钥不经过 Vault）
                  ├─ revoke ─────────▶ 吊销（按 serial 或证书内容）
                  └─ cert/crl ───────▶ 分发吊销列表
```

两个工程上的重要选择：

| 方式 | 私钥在哪生成 | 适用 |
| --- | --- | --- |
| `pki/issue/<role>` | Vault 生成，返回给调用方 | 简单、常见；返回报文里含私钥 |
| `pki/sign/<role>` | **调用方本地生成**，只把 CSR 给 Vault | 私钥永不经过网络，安全性更高 |

对安全要求高的场景优先用 `sign`（Vault 只签发，不接触私钥）。

## 踩坑与检查清单

- **`secrets tune -max-lease-ttl` 忘了调**，签发长有效期证书会失败。
- **`allowed_domains` 必须写**，否则等于开放了一个任意域名 CA。
- **`allow_bare_domains` / `allow_subdomains` 的默认值**要确认清楚：只写 `allowed_domains` 时，裸域默认是**不允许**的。
- **CRL 路径是 `pki/cert/crl`**，不是 `pki/crl/pem`。
- **吊销需要知道证书内容**：按 `serial_number` 最方便，所以**签发时把 serial 记进配置管理**（否则只能事后扫 CRL）。
- **默认 `no_store=false` 会把所有签发记录存在 Vault 里**，量大时要注意存储增长；不需要追溯可以设 `no_store=true`（代价是无法吊销）。
- **TTL 要短。** PKI + Agent 的组合就是为了实现"24 小时证书"，别又签成一年。
- **生产环境把根 CA 留在线下**，Vault 只做中间 CA。

下一章处理一个贯穿全书但一直没正面讲的概念：**租约**——它决定了"动态密钥什么时候被收回"。
