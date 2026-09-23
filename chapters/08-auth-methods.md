# 第 8 章 认证方法：从人到机器

## 需求

> 现在 Vault 里存着密钥、也有策略，但"谁能登录"这件事还停在手工阶段：
>
> - 开发同学要能用自己的账号登录，走公司统一身份（LDAP/OIDC），**离职即失效**；
> - CI 流水线**不能有人值守的密码**，要能自动拿到一个 20 分钟就过期的 token；
> - K8s 里的 Pod 要能凭"我就是这个 ServiceAccount"拿到凭据，**不放任何长期密钥**；
> - 云上/第三方的 workload 要能用它已经持有的 JWT 换成 Vault token。

`auth` 路径下挂载的每一种认证方法，都是"把某种已有身份翻译成 Vault token"的适配器。

## 动手

### 8.1 人：userpass（练手用）与 LDAP/OIDC（生产用）

**userpass** 用来理解机制最合适——它就是"用户名 + 密码 → token"：

```powershell
vault auth enable userpass
vault write auth/userpass/users/alice password=alice-pw policies=app-read
vault list auth/userpass/users
```

```text
Keys
----
alice
```

登录并查看身份：

```powershell
$token = vault login -field=token -method=userpass username=alice password=alice-pw
vault token lookup $token
```

```text
display_name        userpass-alice
path                auth/userpass/login/alice
policies            [app-read default]
ttl                 767h59m59s
```

> **Windows/PowerShell 坑**：`-field=token` 是 flag，**必须写在位置参数 `username=...` 前面**。写成 `vault login -method=userpass username=alice password=alice-pw -field=token` 会报：
> ```text
> Command flags must be provided before positional arguments. The following arguments will not be parsed as flags: [-field=token]
> ```

**生产上不建议用 userpass**：它自带密码库，意味着你要在 Vault 里再维护一套密码和轮换流程。正确做法是接公司已有身份：

```powershell
# LDAP（Active Directory / OpenLDAP）
vault auth enable ldap
vault write auth/ldap/config `
  url="ldaps://ldap.example.internal" `
  userdn="ou=people,dc=example,dc=internal" `
  userattr="uid" `
  groupdn="ou=groups,dc=example,dc=internal" `
  groupattr="cn" `
  binddn="cn=vault,ou=service,dc=example,dc=internal" `
  bindpass="<bind 密码>" `
  userfilter="(&(uid={{.Username}})(memberOf=cn=vault-users,ou=groups,dc=example,dc=internal))"

# 把 LDAP 组映射成 Vault 策略
vault write auth/ldap/groups/vault-app-devs policies=app-read

# OIDC（Okta / Azure AD / Google / Keycloak）
vault auth enable oidc
vault write auth/oidc/config `
  oidc_discovery_url="https://example.okta.com" `
  oidc_client_id="<client id>" `
  oidc_client_secret="<client secret>" `
  default_role="developer"
vault write auth/oidc/role/developer `
  allowed_redirect_uris="http://localhost:8250/oidc/callback" `
  user_claim="email" `
  groups_claim="groups" `
  policies=app-read `
  ttl=8h
```

OIDC 登录的流程：浏览器打开 `vault login -method=oidc` → 跳转 IdP → 回调换取 Vault token。**证书/组映射都在 IdP 侧维护，离职即失效**，这才满足需求。

### 8.2 机器（一）：AppRole —— 为自动化而生

AppRole 的核心思路：**把"身份"拆成两个可以分开投递的部分**。

| 凭证 | 性质 | 分发方式 |
| --- | --- | --- |
| `role_id` | 半公开，类似用户名 | 可以放配置、镜像、环境变量 |
| `secret_id` | 真正的秘密 | 通过安全通道一次性投递（CI secret store / response wrapping / 文件） |

搭一个"CI 只读应用密钥"的角色：

```powershell
vault auth enable approle

vault write auth/approle/role/ci-runner `
  token_policies=app-read `
  token_ttl=20m `
  token_max_ttl=1h `
  secret_id_ttl=10m `
  secret_id_num_uses=1
```

```text
Success! Data written to: auth/approle/role/ci-runner
```

```powershell
vault read auth/approle/role/ci-runner
```

```text
Key                        Value
---                        -----
bind_secret_id             true
secret_id_num_uses         1          ← secret_id 只能用 1 次
secret_id_ttl              10m        ← secret_id 10 分钟失效
secret_id_bound_cidrs      <nil>
token_bound_cidrs          []
token_explicit_max_ttl     0s
token_max_ttl              1h
token_no_default_policy    false
token_num_uses             0
token_period               0s
token_policies             [app-read]
token_ttl                  20m
token_type                 default
```

拿凭证并登录：

```powershell
$rid = vault read -field=role_id auth/approle/role/ci-runner/role-id
$sid = vault write -f -field=secret_id auth/approle/role/ci-runner/secret-id
$appToken = vault write -field=token auth/approle/login role_id=$rid secret_id=$sid
```

验证它确实只有该有的权限：

```powershell
$env:VAULT_TOKEN = $appToken
vault token lookup
```

```text
display_name        approle
path                auth/approle/login
policies            [app-read default]
ttl                 19m59s
type                service
```

```powershell
vault kv get -mount=app demo        # 允许 → 成功
vault kv get -mount=app db/prod     # 越权 → exit 2, permission denied
```

**`secret_id_num_uses=1` 的意义**（实测）：

```powershell
vault write -field=token auth/approle/login role_id=$rid secret_id=$sid
```

```text
Error writing data to auth/approle/login: Error making API request.
URL: PUT http://127.0.0.1:8200/v1/auth/approle/login
Code: 400. Errors:
* invalid role or secret ID
```

凭证用过即焚。即使 CI 日志里泄漏了 `secret_id`，也只能用一次。

**用 response wrapping 安全投递 secret_id**（第 9 章 Vault Agent 也会用到）：

```powershell
vault write -wrap-ttl=120s -f auth/approle/role/ci-runner/secret-id
```

```text
Key                              Value
---                              -----
wrapping_token:                  hvs.CAESIIfTlQW...
wrapping_accessor:               L31t9RfWjIKkh1tbtghfzx6W
wrapping_token_ttl:              2m
wrapping_token_creation_path:    auth/approle/role/ci-runner/secret-id
wrapped_accessor:                5f44f7f5-16cf-d71d-b691-de5fb2c51d54
```

收到 wrapping token 的一方执行 `vault unwrap` 才能拿到真正的 `secret_id`：

```powershell
vault unwrap <wrapping_token>
```

```text
Key                   Value
---                   -----
secret_id             b186b9c2-af0a-5f85-e887-f547bc478016
secret_id_accessor    5f44f7f5-16cf-d71d-b691-de5fb2c51d54
secret_id_num_uses    1
secret_id_ttl         10m
```

这条链路的意义：**投递通道上流动的是一次性、2 分钟过期的信封**，而不是长期密钥。

**按 accessor 撤销 secret_id**（正确路径，实测通过）：

```powershell
vault write auth/approle/role/ci-runner/secret-id-accessor/destroy secret_id_accessor=$sidAcc
```

```text
Success! Data written to: auth/approle/role/ci-runner/secret-id-accessor/destroy
```

> **实测踩坑**：`.../secret-id/accessor/<acc>/destroy` 是**错误路径**，会返回 `404 unsupported path`。正确路径是 `secret-id-accessor/destroy`，accessor 放在请求体里。同理，lookup 用 `vault write .../secret-id-accessor/lookup secret_id_accessor=<acc>`（用 `read` 会得到 405）。

### 8.3 机器（二）：Kubernetes —— Pod 不放任何密钥

K8s 里每个 Pod 都自动持有一个 **ServiceAccount JWT**。Kubernetes 认证方法就是拿这个 JWT 去换 Vault token：

```powershell
vault auth enable kubernetes

vault write auth/kubernetes/config `
  kubernetes_host="https://kubernetes.default.svc:443" `
  token_reviewer_jwt="<reviewer JWT>" `
  kubernetes_ca_cert=@ca.crt
```

```powershell
vault write auth/kubernetes/role/webapp `
  bound_service_account_names=webapp `
  bound_service_account_namespaces=prod `
  audience=vault `
  token_policies=app-read `
  token_ttl=20m
```

```text
Success! Data written to: auth/kubernetes/role/webapp
```

```powershell
vault read auth/kubernetes/role/webapp
```

```text
bound_service_account_names                 [webapp]
bound_service_account_namespaces            [prod]
token_policies                              [app-read]
token_ttl                                   20m
```

Pod 内的应用只需：

```bash
# 在 Pod 内
vault write -field=token auth/kubernetes/login \
  role=webapp jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)"
```

**实测踩坑**：配置 `auth/kubernetes/config` 时如果**不显式提供 CA**，Vault 会去读**它自己所在主机**的 `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`，在 K8s 之外运行必然报错：

```text
Error writing data to auth/kubernetes/config: Error making API request.
Code: 400. Errors:
* open /var/run/secrets/kubernetes.io/serviceaccount/ca.crt: The system cannot find the path specified.
```

显式传 `kubernetes_ca_cert` 后就成功了。生产上通常配合 `disable_local_ca_jwt=true`、`token_reviewer_jwt` 用长期 reviewer token（或 Vault 1.21+/2.x 也支持用自身的 SA 方式），并给 reviewer 绑定 `system:auth-delegator` 权限。

### 8.4 机器（三）：JWT/OIDC —— 信任你已经信任的签发者

任何能签发 JWT 的系统（GitHub Actions、GitLab CI、云厂商 workload identity、你的 API 网关）都可以直接作为身份来源：

```powershell
vault auth enable jwt

vault write auth/jwt/config `
  oidc_discovery_url="https://example.okta.com" `
  bound_issuer="https://example.okta.com"

vault write auth/jwt/role/ci `
  role_type=jwt `
  user_claim=sub `
  bound_audiences="vault" `
  token_policies=app-read `
  token_ttl=15m
```

```text
bound_audiences            [vault]
role_type                  jwt
token_policies             [app-read]
token_ttl                  15m
user_claim                 sub
```

两个"必须要有的约束"（实测）：

- **角色必须有至少一个绑定条件**（`bound_audiences` / `bound_claims` / `bound_subject` 之一），否则写入直接被拒：
  ```text
  Code: 400. Errors:
  * must have at least one bound constraint when creating/updating a role
  ```
  这是防呆设计：没有约束的 JWT 角色等于"谁都能换到 token"。
- **JWT 的签名必须能被验证**。用假 token 登录会看到：
  ```text
  Code: 400. Errors:
  * error validating token: error verifying token signature: oidc: malformed jwt: ...
  ```

GitHub Actions 的典型组合是 `oidc_discovery_url="https://token.actions.githubusercontent.com"` + `bound_issuer` + `bound_claims`（限定 `repository`、`ref`、`environment`）。**这样 CI 里完全没有任何长期密钥。**

### 8.5 把多种登录方式合并成同一个"人"

同一个人可能既用 LDAP 登录、又用 OIDC 登录。Vault 的 **identity（实体）** 机制可以把多个 alias 归并到同一个 entity，从而统一挂策略、统一审计：

```powershell
# 概念性流程（需要先存在来自不同 auth 的 alias）
vault list identity/entity/id
vault write identity/entity/name/alice `
  policies=app-read
# 把 userpass 的别名挂到该实体上
vault write identity/entity-alias/id/<alias_id> \
  name=alice canonical_id=<entity_id> mount_accessor=<userpass_accessor>
```

归并后有两个直接好处：

1. 策略可以挂在 entity 上，换登录方式不换权限；
2. 审计日志里能按"人"聚合，而不是按"登录方式"。

## 原理：认证 = 身份 → 策略集合 → token

```text
                ┌── userpass / ldap / oidc   （人）
auth/<方法> ────┼── approle                  （自动化：role_id + secret_id）
                ├── kubernetes               （Pod：ServiceAccount JWT）
                └── jwt / cert / cloud       （已有 JWT / 证书 / 云身份）
                        │
                        ▼
              校验通过 → 生成 Token
              附带：方法上配置的策略 + 实体(entity)策略 + default
```

三种机器认证的取舍（选型表）：

| 认证方法 | 身份来源 | 长期密钥 | 适用场景 |
| --- | --- | --- | --- |
| **AppRole** | role_id + secret_id | 有（secret_id 需保管/一次性投递） | CI、脚本、非云环境、无法拿到平台身份的系统 |
| **Kubernetes** | ServiceAccount JWT | ❌ 无（K8s 自动注入并轮换） | 所有跑在 K8s 里的应用 |
| **JWT/OIDC** | IdP / 平台签发的 JWT | ❌ 无 | GitHub/GitLab CI、云上 workload、有 IdP 的组织 |

> **选型口诀**：能不用长期密钥就不用。跑在 K8s 上 → Kubernetes 认证；跑在 CI/云上且平台能签 OIDC → JWT/OIDC；都不满足 → AppRole + 一次性 secret_id。

## 踩坑与检查清单

- **AppRole 的 `role_id` 不是秘密，`secret_id` 才是。** 把 secret_id 提交进 Git 等于把钥匙贴在门上。用 `secret_id_ttl` + `secret_id_num_uses=1` + response wrapping 三重限制。
- **别用 `ttl`/`max_ttl` 配置角色**：AppRole（以及 K8s/JWT）现在的参数名是 `token_ttl` / `token_max_ttl`，旧名已废弃。
- **K8s 认证的绑定条件要三个维度都写**：`bound_service_account_names` + `bound_service_account_namespaces` + `audience`。只写名字很容易被别的命名空间蹭到。
- **JWT 角色必须有绑定约束**，否则 Vault 直接拒绝写入（上文的 400 报错）。
- **LDAP 的 `userfilter` 决定了"谁算 Vault 用户"**，别忘了把 group 映射到策略，否则登录进来是个没有任何权限的空 token。
- **OIDC 的 `allowed_redirect_uris` 必须与实际回调地址完全一致**，多一个斜杠都可能失败。
- **记得开启审计**（第 13 章）：认证方法的每一次成功/失败登录都是安全事件，必须有记录。
- **MFA 是企业版能力**（登录 MFA / Sentinel 等），OSS 侧通常靠 IdP 的 MFA 兜底。

下一章把认证和数据读取合起来，让应用"完全不知道 Vault 的存在"。
