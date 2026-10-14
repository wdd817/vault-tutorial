# 第 10 章 Transit：加密即服务

## 需求

> 合规要求：用户的身份证号、银行卡号**在数据库里必须是密文**；但业务又需要"按卡号后四位查询"之外的检索能力。
>
> 团队第一反应是"在应用里加解密"。反对意见也很直接：**密钥要下发到每台应用服务器**、每个语言一套实现、密钥轮换要重新加密全表——第 1 章的那 7 个存放点又回来了。

Transit 引擎的答案是：**密钥永远不离开 Vault，加解密变成一次 API 调用。**

## 动手

### 10.1 挂载引擎并创建密钥

```bash
vault secrets enable transit
vault write -f transit/keys/payments
vault read transit/keys/payments
```

```text
Key                       Value
---                       -----
allow_plaintext_backup    false
auto_rotate_period        0s
deletion_allowed          false
derived                   false
exportable                false
imported_key              false
keys                      map[1:1790165225]
latest_version            1
min_available_version     0
min_decryption_version    1
min_encryption_version    0
name                      payments
supports_decryption       true
supports_derivation       true
supports_encryption       true
supports_signing          false
type                      aes256-gcm96
```

命名说明：这里的 `payments` 是**密钥的名字**，不是数据。默认算法 `aes256-gcm96`，且 `exportable: false`——**连 root 也导不出这段密钥材料**（这才是 Transit 的核心保证）。

### 10.2 加密与解密

Transit 的输入输出都是 **base64**：

```bash
PT=$(printf '%s' '4111-1111-1111-1111' | base64)

CT=$(vault write -field=ciphertext transit/encrypt/payments plaintext="$PT")
echo "$CT"
```

```text
vault:v1:ZSlqoSqB2cf3BhBBOjHSc1f+PfFbxGhhk6WXH70B7cW5gcE/0ICTDOJXYLAq7dk=
```

注意密文的前缀 **`vault:v1:`**——它标明了"由哪个密钥的哪个版本加密"。这个前缀让密钥轮换变得极其简单（见 10.4）。

解密：

```bash
vault write -field=plaintext transit/decrypt/payments ciphertext="$CT"
```

```text
NDExMS0xMTExLTExMTEtMTExMQ==
```

解码回原文验证：

```bash
printf '%s' 'NDExMS0xMTExLTExMTEtMTExMQ==' | base64 -d
# 4111-1111-1111-1111
```

### 10.3 永远不用解密的校验：HMAC

如果只是要"判断两条数据是不是同一个"（去重、比对、完整性校验），根本不需要解密：

```bash
vault write -field=hmac transit/hmac/payments algorithm=sha2-256 input="$PT"
```

```text
vault:v1:BKQV4qLwQ+OVbo4wbzWI1pOj+6TRtGkrbmgwK6n1cq4=
```

注意前缀里的版本号：这一步还没轮换，所以是 `vault:v1:`（轮换后才会变成 `vault:v2:`，见 10.4）。同样的输入、同样的密钥版本，HMAC 恒定；密钥轮换后 HMAC 会变。这个能力常用于"**加密存储 + 密文索引**"：数据库里存 HMAC 作为检索列，存密文作为数据列。

（`algorithm` 可以省略，默认就是 `sha2-256`。）

### 10.4 密钥轮换：不用重新加密历史数据

```bash
vault write -f transit/keys/payments/rotate
vault read -field=latest_version transit/keys/payments
# 2
```

轮换后：

- **新数据用 v2 加密**（密文前缀变成 `vault:v2:`）；
- **旧数据仍然是 `vault:v1:...`，依旧可以解密**（因为 Vault 保留了历史密钥版本）；
- HMAC 的前缀也跟着变成 `vault:v2:`：
  ```text
  vault:v2:chuRornuLwinvoKRhNMMAhjVBH+JhmC7JAwrkIjXPj8=
  ```
- 想统一升级到新版本，用 `rewrap`——它**解密再加密，但明文从不离开 Vault**：

```bash
vault write -field=ciphertext transit/rewrap/payments ciphertext="$CT"
# vault:v2:...
```

对比"应用侧加密"：那边轮换意味着**全表重写**和一次高风险的批处理；这边只是 `rotate` + 后台慢慢 `rewrap`。

### 10.5 信封加密：datakey

对**大对象**（文件、日志、备份），不要直接走 Transit API（每次都要网络往返）。用 `datakey` 拿一把数据密钥，本地加密，只把"被 Vault 加密过的数据密钥"存起来：

```bash
vault write -f transit/datakey/plaintext/payments
```

```text
Key            Value
---            -----
ciphertext     vault:v2:5/x1UoT9pOsUKGmVqvRAI0HcJggLX+c0V1nQWu4pHYW6hiw6Qzb7iIfJOxJ90Mo5Cm1xfyZ1/nvHO9jk
key_version    2
plaintext      ZBQFFnhHk9UFdZK78AvlabfAZ7H2ez2s6sBWzul22z0=
```

这里的 `key_version 2` / `vault:v2:` 是因为上一节刚 `rotate` 过；**如果你没跑 10.4 的 `rotate`，这里会是 `key_version 1` / `vault:v1:`**，属正常现象（`plaintext` 解码后固定是 32 字节）。

用法：

```text
① 应用拿到 plaintext（数据密钥）和 ciphertext（被 Vault 包起来的同一把密钥）
② 用 plaintext 在本地加密大文件（AES-GCM）
③ 丢掉 plaintext，只把 Vault 的 ciphertext 与文件存一起
④ 解密时：把 ciphertext 交给 Vault → 拿回 plaintext → 本地解密文件
```

这样密钥永不落盘，而每个对象都有自己的数据密钥。

### 10.6 批量操作

一次请求加密多条，减少往返：

```bash
cat > payload.json <<EOF
{"batch_input":[{"plaintext":"$PT"},{"plaintext":"$PT"}]}
EOF
vault write transit/encrypt/payments @payload.json
```

```text
Key              Value
---              -----
batch_results    [map[ciphertext:vault:v2:sGgZBI3v... key_version:2 reference:] map[ciphertext:vault:v2:H+hDoG4... key_version:2 reference:]]
```

> **`@file` 用法**：Vault CLI 的 `@file` 参数语法（如上 `vault write transit/encrypt/payments @payload.json`）在 Linux/macOS 的 bash 下可以直接用，是最推荐的方式。如果拿到的是别的 shell 的写法、`@file` 被吞掉了，可以改用标准输入：`vault write transit/encrypt/payments - < payload.json`。

### 10.7 让应用"只能加密，不能解密"

这是 Transit 最漂亮的安全属性之一——**加解密权限可以分离**：

```hcl
# transit-encryptor.hcl
path "transit/encrypt/payments" {
  capabilities = ["update"]
}

path "transit/decrypt/payments" {
  capabilities = ["deny"]
}
```

```bash
vault policy write transit-encryptor transit-encryptor.hcl
TOKEN=$(vault token create -policy=transit-encryptor -ttl=10m -field=token)
export VAULT_TOKEN=$TOKEN

vault write -field=ciphertext transit/encrypt/payments plaintext="$PT"
# ✅ 成功（exit 0）

vault write -field=plaintext transit/decrypt/payments ciphertext="$CT"
```

```text
Error writing data to transit/decrypt/payments: Error making API request.
URL: PUT http://127.0.0.1:8200/v1/transit/decrypt/payments
Code: 403. Errors:
* 1 error occurred:
	* permission denied
```

可以把这套权限分配给**采集端服务**：它们能写入密文，但即使被攻破也无法解密历史数据。解密权限只给少数"读服务"。

> 注意：`transit/encrypt/*` 用的是 **`update`** 能力，不是 `read`。这是策略里最容易写错的一处。

## 原理：为什么"密钥不出 Vault"这么重要

```text
应用侧加密（传统）                  Transit 加密（加密即服务）
┌──────────────┐                  ┌──────────────┐
│ 应用 + 密钥   │ ← 密钥散布在各处   │ 应用          │
│ 自己实现 AES  │                  │ 调 encrypt API│
└──────────────┘                  └──────┬───────┘
      │                                  │
      ▼                                  ▼
  数据库里是密文，                   Vault 持有密钥
  但密钥也在应用服务器上             数据库里是密文（vault:v1:...）
```

关键差异：

| 维度 | 应用侧加密 | Transit |
| --- | --- | --- |
| 密钥位置 | 每台应用服务器 | 只在 Vault 内存/存储 |
| 轮换成本 | 全量重加密 | `rotate` + 逐步 `rewrap` |
| 权限粒度 | "能加密"= "能解密" | 可分离（encrypt ≠ decrypt） |
| 审计 | 无 | 每次加解密都进审计日志 |
| 语言/实现一致性 | 各自实现 | 统一由 Vault 保证 |
| 性能 | 本地最快 | 每次调用一次网络往返（可用批量/datakey 优化） |

**什么时候不该用 Transit**：超高频、超低延迟的字段级加解密。每一次 `encrypt` 都是一次网络往返，在每秒数万次以上的场景会成为瓶颈——这时用 datakey + 本地加密更合适。**具体阈值请用自己的压测数据判断**，不要照搬经验值。

## 踩坑与检查清单

- **输入必须是 base64。** 直接把明文丢进 `transit/encrypt/*` 会报 `* illegal base64 data at input byte 4`（字节位置随输入而变）；`transit/hmac/*` 上则是 `* unable to decode input as base64: illegal base64 data at input byte 0`。bash 里用 `printf '%s' '明文' | base64`。
- **别把 `rotate` 当成 `rewrap`。** `rotate` 只影响**新**数据；历史密文需要显式 `rewrap` 才会升级版本。
- **`min_decryption_version` 是"作废旧版本"的开关**：把它调高，旧密文就再也解不开了。这是**不可逆**的，用于"确认所有历史数据都已升级"之后的收尾。
- **`allow_plaintext_backup=true` 会让密钥可导出**，出事后影响面完全不同。除非有明确需求，保持 `false`。
- **想彻底删除密钥**需要先 `vault write transit/keys/<name>/config deletion_allowed=true`，然后 `vault delete transit/keys/<name>`。删除后**所有历史密文永久无法解密**——务必先确认数据已经不再需要。
- **策略里 `encrypt`/`decrypt`/`hmac`/`rewrap` 是不同路径**，按需要分别授予，别用 `transit/*` 一把梭。
- **`convergent_encryption` 可以让相同明文得到相同密文**（便于等值查询），但它会**削弱语义安全性**（可做频率分析）。除非确实需要密文索引，否则不要开。

下一章把"证书"也变成一次 API 调用。
