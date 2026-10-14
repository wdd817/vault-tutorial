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

```bash
vault secrets enable pki
vault secrets tune -max-lease-ttl=87600h pki      # 10 年
vault write pki/root/generate/internal \
  common_name="example.internal Root CA" \
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
issuer_name      n/a
issuing_ca       -----BEGIN CERTIFICATE-----
MIIDNzCCAh+gAwIBAgIUUMYa8XE6SZfCBRmQMI0xVZkQCfIwDQYJKoZIhvcNAQEL
...
-----END CERTIFICATE-----
key_id           74a25763-29f3-ccc3-b4a2-3f8a19371d3a
key_name         n/a
serial_number    50:c6:1a:f1:71:3a:49:97:c2:05:19:90:30:8d:31:55:99:10:09:f2
```

（节选：完整返回一共 8 个字段——`certificate`、`expiration`、`issuer_id`、`issuer_name`、`issuing_ca`、`key_id`、`key_name`、`serial_number`。自签根 CA 的 `issuing_ca` 就是它自己；`issuer_name` 和 `key_name` 未设置时，CLI 都会渲染成 `n/a`——注意 JSON 里它们其实是空字符串 `""`，`n/a` 只是表格输出的显示方式。）

记住三条：

- 挂载点的 `max_lease_ttl` **不约束** `pki/issue/*` 签出来的叶子证书 TTL：实测把它调到 1h 之后再签 `ttl=24h`，照样全额签发，既没有错误也没有警告。它对**根/中间 CA 的生成**才生效，而且是**静默截断**——1h 的挂载点上写 `root/generate/internal ttl=87600h` 会成功返回，但签出来的 CA 证书只有 1h 有效期；
- 根 CA 的私钥只存在 Vault 内、不会回传（`root/generate/internal` 的返回体里没有 `private_key`）——它不是靠 `exportable` 参数控制的，这个参数在这个端点上根本不存在，传了会被忽略并警告 `* Endpoint ignored these unrecognized parameters: [exportable]`；要把私钥拿出来必须显式改用 `pki/root/generate/exported`；
- 生产上更常见的做法是**根 CA 离线**，Vault 里只放中间 CA（见 11.6）。

叶子证书真正受两道闸门约束，两道都不在挂载点上：

- **角色的 `max_ttl`**——超出**不报错**，只封顶并给警告；同一条警告会**打印两遍**（实测：stderr 上两条，`-format=json` 的 `.warnings` 数组里也是长度 2 的两条相同内容）：

  ```text
  WARNING! The following warnings were returned from Vault:

    * TTL "800h0m0s" is longer than permitted maxTTL "720h0m0s", so maxTTL is
    being used

    * TTL "800h0m0s" is longer than permitted maxTTL "720h0m0s", so maxTTL is
    being used
  ```

- **CA 证书自身的到期时间**——这是唯一的硬报错（实测）：

  ```text
  Error writing data to pki/issue/web-server: Error making API request.

  URL: PUT http://127.0.0.1:8200/v1/pki/issue/web-server
  Code: 400. Errors:

  * cannot satisfy request, as TTL would result in notAfter of 2026-10-15T08:34:04.843412792Z that is beyond the expiration of the CA certificate at 2026-10-14T09:34:04Z
  ```

### 11.2 定义签发角色

角色决定"能签什么证书"：

```bash
vault write pki/roles/web-server \
  allowed_domains="example.internal" \
  allow_subdomains=true \
  max_ttl=720h \
  key_type=rsa \
  key_bits=2048
```

```text
Key                                   Value
---                                   -----
allow_any_name                        false
allow_bare_domains                    false
allow_glob_domains                    false
allow_ip_sans                         true
...
use_csr_common_name                   true
use_csr_sans                          true
use_pss                               false
```

（节选：`vault write pki/roles/web-server` 的回显就是这个端点的返回体，等同于 `vault read pki/roles/web-server` 的完整字段表，一共 50 行——不是 `Success! Data written to: ...`。想少看点输出可以把 `-field` 放在位置参数**之前**，例如 `vault write -field=allowed_domains pki/roles/web-server ...`，或者写完再单独 `vault read`。）

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

```bash
vault write pki/issue/web-server common_name="api.example.internal" ttl=24h
```

返回里有 `certificate`、`private_key`、`ca_chain`、`serial_number`、`expiration`。用 JSON 格式便于脚本处理：

```bash
CERT_JSON=$(vault write -format=json pki/issue/web-server common_name="web.example.internal" ttl=24h)

echo "$CERT_JSON" | jq -r '.data.serial_number'      # 15:c6:77:c6:0d:33:53:04:...
echo "$CERT_JSON" | jq -r '.data.ca_chain | length'  # 1（本例是自签根，直接签叶子）
echo "$CERT_JSON" | jq -r '.data.private_key_type'   # rsa

echo "$CERT_JSON" | jq -r '.data.certificate' > web.crt
echo "$CERT_JSON" | jq -r '.data.private_key' > web.key
```

> **换行提示**：`> web.crt` 写出的是 LF 换行，绝大多数工具都能接受；如果某个工具报"格式错误"，先用 `file web.crt` 看是不是被转成了 CRLF，必要时 `sed -i 's/\r$//' web.crt` 转成 LF。

### 11.4 吊销与 CRL

按序列号吊销：

```bash
SERIAL=$(echo "$CERT_JSON" | jq -r '.data.serial_number')    # 证书序列号（上一步签发时拿到的）
vault write pki/revoke serial_number="$SERIAL"
```

```text
Key                        Value
---                        -----
revocation_time            1790165828
revocation_time_rfc3339    2026-09-23T12:17:08.3159029Z
state                      revoked
```

下载 CRL（供下游服务校验吊销状态）：

```bash
vault read -format=json pki/cert/crl > crl.json
jq -r '.data.certificate' crl.json > crl.pem
```

> 注意是 **`pki/cert/crl`**（PEM 格式的 CRL）。`vault read pki/crl/pem` 这种写法在 CLI 里会被当成数字比较而报错（`invalid character '-' in numeric literal`）。

配置 AIA / CRL 分发点，让下游能自动找到吊销列表：

```bash
vault write pki/config/urls \
  issuing_certificates="http://127.0.0.1:8200/v1/pki/ca" \
  crl_distribution_points="http://127.0.0.1:8200/v1/pki/crl"
```

> 不配这个会收到警告（实测）：
> ```text
> WARNING! The following warnings were returned from Vault:
>
>   * This mount hasn't configured any authority information access (AIA)
>   fields; this may make it harder for systems to find missing certificates
>   in the chain or to validate revocation status of certificates. Consider
>   updating /config/urls or the newly generated issuer with this information.
> ```

### 11.5 域名越权会被拦下

```bash
vault write pki/issue/web-server common_name="evil.example.com" ttl=24h
```

```text
Error writing data to pki/issue/web-server: Error making API request.

URL: PUT http://127.0.0.1:8200/v1/pki/issue/web-server
Code: 400. Errors:

* common name evil.example.com not allowed by this role
```

这就是 `allowed_domains` 的价值：**没有它，任何能调用 `pki/issue/*` 的服务都能给自己签一张任意域名的证书。**

### 11.6 生产架构：根 CA 离线 + 中间 CA

不要用根 CA 直接签叶子证书。推荐做法（下面用 `pki_int/` 作为中间 CA 的挂载点——**不要**把中间 CA 塞回 11.1 那个根 CA 的 `pki/`；11.7、11.8 里的 `pki/issue/web-server` 请按你实际的挂载点替换）：

```text
① 离线机器上生成根 CA（或用企业 PKI / HSM）
② 在 Vault 里另开一个挂载点，生成 CSR：
     vault secrets enable -path=pki_int pki
     vault secrets tune -max-lease-ttl=43800h pki_int
     vault write -field=csr pki_int/intermediate/generate/internal common_name="example.internal Intermediate CA" > int.csr
③ 用根 CA 签这个 CSR（离线操作），得到 intermediate CA 证书
④ 把证书导入 Vault：
     vault write pki_int/intermediate/set-signed certificate=@int.pem
⑤ 之后所有签发都由中间 CA 完成；根 CA 私钥永远不联网
```

导入完用两条命令确认"确实换成中间 CA 在签"：

```bash
vault read pki_int/issuer/default          # 这里应该是中间 CA，不是根 CA

vault write -format=json pki_int/issue/web-server common_name="svc.example.internal" ttl=24h \
  | jq -r '.data.certificate' | openssl x509 -noout -issuer
# issuer=CN = example.internal Intermediate CA
```

> ⚠️ **实测踩坑一：别在原挂载点上混着做。** 如果 `pki/` 已经按 11.1 生成了根 CA，再对它执行 `intermediate/generate` + `intermediate/set-signed`，两个 issuer 会同住一个挂载点，而 `default` **仍然是根**——签出来的证书 issuer 还是根 CA，⑤ 并没有成立（实测）：
>
> ```text
> $ vault list pki/issuers
> a29ff54c-bed6-0cdc-7018-edae9c28ac03      ← 刚导入的中间 CA
> fe871275-c9e8-67e8-16da-63d0e609adfe      ← 11.1 生成的那个根 CA
> $ vault read -format=json pki/issuer/default | jq -r '.data.issuer_id'
> fe871275-c9e8-67e8-16da-63d0e609adfe
> $ vault write -format=json pki/issue/web-server common_name=mix.example.internal ttl=24h \
>     | jq -r '.data.certificate' | openssl x509 -noout -issuer
> issuer=CN = example.internal Root CA
> ```
>
> 要在同一个挂载点上真的切过去，必须再补一条。**别想靠 `issuer_name` 分辨这两个 issuer**——`intermediate/generate/internal` 的 `common_name` 只写进 CSR，两个 issuer 的 `issuer_name` 实测都是空的，得看证书主体来认（实测）：
>
> ```bash
> for id in $(vault list -format=json pki/issuers | jq -r '.[]'); do
>   printf '%s  ' "$id"
>   vault read -field=certificate pki/issuer/$id | openssl x509 -noout -subject
> done
> # a29ff54c-bed6-0cdc-7018-edae9c28ac03  subject=CN = example.internal Intermediate CA
> # fe871275-c9e8-67e8-16da-63d0e609adfe  subject=CN = example.internal Root CA
>
> vault write pki/config/issuers default=a29ff54c-bed6-0cdc-7018-edae9c28ac03
> ```
>
> 然后再按上面两条命令复验：`vault read pki/issuer/default` 应该是中间 CA，签出来的证书 issuer 应该是 `CN = example.internal Intermediate CA`。

> ⚠️ **实测踩坑二：中间 CA 是「外部/离线 CA」签的时候，`set-signed` 之后别立刻签发。** 叶子证书默认带 `not_before_duration=30s`（notBefore 往前回填 30 秒），于是 Vault 要求「叶子的 notBefore ≥ 签名者（中间 CA）的 notBefore」，等价于**签发时刻要比中间 CA 的签署时刻至少晚 `not_before_duration`**。只有中间 CA 的 notBefore 恰好等于"签署那一刻"（外部/离线 CA 的常见行为）时才会撞上（实测）：
>
> ```text
> Error writing data to pki_int/issue/introle: Error making API request.
>
> URL: PUT http://127.0.0.1:8200/v1/pki_int/issue/introle
> Code: 400. Errors:
>
> * notBefore before signer's notBefore
> ```
>
> **用 Vault 自己的根 CA 签 CSR（`pki/root/sign-intermediate`）不会踩到这条**：Vault 给中间证书的 notBefore 同样回填 30 秒（等于"签署时刻 − 30s"），所以 `set-signed` 完立刻签发也照样成功（实测连续 3 次 `rc=0`，中间证书 `notBefore=09:13:26`、签署时刻 `09:13:56`）。
>
> 判据是**距"签署中间 CA"那一刻是否满 `not_before_duration`**，跟你什么时候 `set-signed` 无关：实测在同一个刚 `set-signed` 的挂载点上，把角色改成 `not_before_duration=60` 立刻签发报同一个错误，距签署 40 秒时仍然失败，70 秒后才成功。
>
> 补救办法二选一：**等够 `not_before_duration`（默认 30 秒）再签**，或者把角色的 `not_before_duration=0` 关掉这个回填。

这样即使 Vault 被攻破，攻击者也只能用中间 CA 签证书，而**根 CA 可以在不重建整个信任链的前提下吊销它**。

### 11.7 角色的最小权限：给"能签发"的调用方一份策略

```hcl
# pki-issuer.hcl
path "pki/issue/web-server" {
  capabilities = ["update"]
}
```

```bash
vault policy write pki-issuer pki-issuer.hcl
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
> [WARN]  agent: (view) vault.pki(pki/issue/web-server->...): Error making API request.
>
> URL: PUT http://127.0.0.1:8200/v1/pki/issue/web-server
> Code: 403. Errors:
>
> * 1 error occurred:
> 	* permission denied
> ```
> 正确做法是给这个角色同时挂上"读配置"和"签发证书"两个策略，例如：
> ```bash
> vault write auth/approle/role/nginx-agent \
>   token_policies="app-read,pki-issuer" \
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

- **`secrets tune -max-lease-ttl` 忘了调**：它**静默截断根/中间 CA 证书**的有效期（1h 的挂载点上生成的"10 年"根 CA 实际只有 1h），但**不影响** `pki/issue/*` 的叶子 TTL——叶子签发不会因为这个参数报错，只受角色 `max_ttl`（超出封顶 + WARNING）和 CA 证书到期时间（唯一硬报错）约束。
- **`allowed_domains` 必须写**，否则等于开放了一个任意域名 CA。
- **`allow_bare_domains` / `allow_subdomains` 的默认值**要确认清楚：只写 `allowed_domains` 时，裸域默认是**不允许**的。
- **CRL 路径是 `pki/cert/crl`**，不是 `pki/crl/pem`。
- **吊销需要知道证书内容**：按 `serial_number` 最方便，所以**签发时把 serial 记进配置管理**（否则只能事后扫 CRL）。
- **默认 `no_store=false` 会把所有签发记录存在 Vault 里**，量大时要注意存储增长；不需要追溯可以设 `no_store=true`（代价是无法吊销）。
- **TTL 要短。** PKI + Agent 的组合就是为了实现"24 小时证书"，别又签成一年。
- **生产环境把根 CA 留在线下**，Vault 只做中间 CA。

下一章处理一个贯穿全书但一直没正面讲的概念：**租约**——它决定了"动态密钥什么时候被收回"。
