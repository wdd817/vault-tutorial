# 第 2 章 安装与第一个 Vault：dev 模式

## 需求

> 我想在**五分钟内**看到一个能用的 Vault：不用配 TLS、不用操心解封、不用申请服务器，只要能立刻验证"存一个值、读出来"这条链路是通的。

这个需求对应的正是 `vault server -dev`。本章先把它跑起来，同时说清楚它**故意省略了哪些生产必需的东西**——不理解这一点，是初学者最常见的翻车原因。

## 动手

### 2.1 安装

推荐用官方发布的二进制包（版本最新、校验和可验证）。本教程使用 **Vault v2.1.1**。

**Windows（winget 最省事）**

```powershell
winget install --id Hashicorp.Vault -e
```

> 实测提示：winget 源上的版本可能落后官方一两周（写作时 winget 上是 2.1.0，官方 releases 已是 2.1.1）。要精确控制版本，用下面的手动方式。

**Windows / macOS / Linux（手动下载，推荐用于指定版本）**

```powershell
# Windows PowerShell 示例：下载 2.1.1 并校验
$ver = '2.1.1'
$url = "https://releases.hashicorp.com/vault/$ver/vault_${ver}_windows_amd64.zip"
Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\vault.zip"
(Get-FileHash "$env:TEMP\vault.zip" -Algorithm SHA256).Hash
# 与官方发布的 SHA256SUMS 对比后再解压
Expand-Archive "$env:TEMP\vault.zip" -DestinationPath "$env:TEMP\vault211" -Force
```

```bash
# Linux (amd64) 等价写法
VER=2.1.1
curl -fsSLo vault.zip "https://releases.hashicorp.com/vault/${VER}/vault_${VER}_linux_amd64.zip"
sha256sum vault.zip   # 与官方 SHA256SUMS 核对
unzip -o vault.zip -d /usr/local/bin
```

**Docker（最干净，适合在服务器上试）**

```bash
docker run --cap-add=IPC_LOCK -e 'VAULT_DEV_ROOT_TOKEN_ID=root' \
  -p 8200:8200 hashicorp/vault:2.1.1 server -dev -dev-no-store-token
```

### 2.2 确认版本

```powershell
vault --version
```

```text
Vault v2.1.1 (d78bbbe2d2f3d289c1ec29d431071beb23668212), built 2026-09-15T21:21:56Z
```

### 2.3 启动 dev 模式

```powershell
$env:VAULT_DEV_ROOT_TOKEN_ID = 'root'
vault server -dev -dev-no-store-token
```

启动后终端里会打印一段自我介绍（下面是 2.1.1 的真实输出，节选）：

```text
==> Vault server configuration:

             Api Address: http://127.0.0.1:8200
                     Cgo: disabled
         Cluster Address: https://127.0.0.1:8201
   Environment Variables: ALL_PROXY, ...
              Go Version: go1.26.8
              Listener 1: tcp (addr: "127.0.0.1:8200", cluster address: "127.0.0.1:8201", ...)
               Log Level:
                   Mlock: supported: false, enabled: false
                 Storage: inmem
                 Version: Vault v2.1.1, built 2026-09-15T21:21:56Z

==> Vault server started! Log data will stream in below:

WARNING! dev mode is enabled! In this mode, Vault runs entirely in-memory
and starts unsealed with a single unseal key. The root token is already
authenticated to the CLI, so you can immediately begin using Vault.

You may need to set the following environment variables:

PowerShell:
    $env:VAULT_ADDR="http://127.0.0.1:8200"
cmd.exe:
    set VAULT_ADDR=http://127.0.0.1:8200

The unseal key and root token are displayed below in case you want to
seal/unseal the Vault or re-authenticate.

Unseal Key: 7mQ2vXk9pLzR4tNc8sWjYb3hFd6gAe1uKq0xZi5oPwE=
Root Token: root

Development mode should NOT be used in production installations!
```

> **注意**：`Unseal Key` 每次启动 dev 模式都会**重新随机生成**，所以你屏幕上看到的
> 一定和我这里不一样——上面这串是占位示例，不是固定的。dev 模式的密钥只存在内存里，
> 进程一停就没了，不需要你抄下来保管。（真实部署里恰恰相反：`operator init` 给出的
> unseal key 必须离线分开保管，第 14 章会讲。）

**新开一个终端**（保持 Vault 前台运行），设置连接信息：

```powershell
$env:VAULT_ADDR = 'http://127.0.0.1:8200'
$env:VAULT_TOKEN = 'root'
vault status
```

```text
Key             Value
---             -----
Seal Type       shamir
Initialized     true
Sealed          false
Total Shares    1
Threshold       1
Version         2.1.1
Build Date      2026-09-15T21:21:56Z
Storage Type    inmem
Cluster Name    vault-cluster-47f125b3
Cluster ID      371243ca-59e8-9629-7ff7-6a18c893f444
HA Enabled      false
```

### 2.4 冒烟测试

```powershell
vault kv put -mount=secret hello message="hello vault"
vault kv get -mount=secret hello
```

```text
== Secret Path ==
secret/data/hello

======= Metadata =======
Key                Value
---                -----
created_time       2026-09-23T12:16:58.5289107Z
custom_metadata    <nil>
deletion_time      n/a
destroyed          false
version            1

====== Data ======
Key        Value
---        -----
message    hello vault
```

看到 `version 1` 就说明你已经在用 KV v2 了（第 4 章的主角）。

## 原理：dev 模式省掉了什么

`-dev` 不是"生产服务器的简化版"，而是**一个完全不同用途的启动器**。它做了这些事：

| dev 模式的行为 | 生产为什么不能这样 |
| --- | --- |
| 存储使用 `inmem`（内存） | 进程退出 = 数据全丢；无法做持久化、备份、HA |
| 启动即 `Initialized=true, Sealed=false` | 生产必须 `vault operator init` 并把 unseal key 分开保管 |
| 自动生成 root token 并写入本地 token helper | 生产禁止长期使用 root token，必须建受限身份 |
| 单节点、`HA Enabled: false` | 生产至少要 3 节点 Raft 集群 |
| 不启用审计设备 | 合规环境必须有审计 |
| 默认只监听 `127.0.0.1`，无 TLS | 生产必须 TLS（监听地址 + 证书） |

`-dev-no-store-token` 的作用是：**不要把 dev 根 token 写进 `~/.vault-token`**。加上它以后，`vault` 命令只依赖 `VAULT_TOKEN` 环境变量，环境更干净，也便于在教程里反复重启。如果你不加这个参数，Vault 会把 token 存到本地 helper 文件（Windows 上是 `%APPDATA%\hashicorp\vault-token` 或 `~/.vault-token`），后续可能会出现"登录了但用的还是旧 token"的困惑。

dev 模式常用参数（`vault server -help` 实测可得）：

| 参数 | 作用 |
| --- | --- |
| `-dev-root-token-id=root` | 指定 root token 的值，便于自动化实验 |
| `-dev-listen-address=127.0.0.1:8200` | 改监听地址/端口 |
| `-dev-no-store-token` | 不把 token 写进本地 helper |
| `-dev-tls` | 生成临时证书并启用 TLS（用来练 TLS 相关配置） |

> **端口冲突提示（实测遇到的真实报错）**：如果你已经在跑别的 dev 实例，第二个实例会直接退出，日志里是：
> `Error initializing listener of type tcp: listen tcp 127.0.0.1:8200: bind: Only one usage of each socket address ... is normally permitted.`
> 解决办法：`-dev-listen-address=127.0.0.1:8400`（换个端口，同时改 `VAULT_ADDR`）。

## 环境变量速查

Vault CLI 的全部行为几乎都由环境变量决定，先记住这五个：

| 变量 | 含义 |
| --- | --- |
| `VAULT_ADDR` | 服务端地址，如 `http://127.0.0.1:8200` |
| `VAULT_TOKEN` | 请求携带的令牌 |
| `VAULT_NAMESPACE` | 企业版命名空间（OSS 不用管） |
| `VAULT_CACERT` / `VAULT_SKIP_VERIFY` | TLS 相关，生产章节会用到 |
| `VAULT_FORMAT=json` | 等价于每条命令加 `-format=json`，写脚本很省事 |

## 踩坑与检查清单

- **重启 dev 实例会清空所有数据。** 这是 in-memory 存储的必然结果，不是 bug。想保留数据请直接跳到第 14 章的非 dev 配置。
- **`VAULT_ADDR` 不设置时，CLI 默认去 `https://127.0.0.1:8200`**（注意是 https）。dev 模式是 http，所以不设 `VAULT_ADDR` 会得到 TLS 报错，这是新手最常见的第一个报错。
- **别把 dev 的 `Unseal Key` 和 `Root Token` 抄进任何文档或聊天记录。** 教程里让你写 `root` 只是为了演练方便。
- **PowerShell 里 flag 必须写在位置参数前面。** 例如 `vault login -field=token -method=userpass username=alice`；写成 `vault login -method=userpass username=alice -field=token` 会报 `Command flags must be provided before positional arguments`。
- **确认自己跑的是 2.1.x**：`vault --version`。若在 1.20 或更早，部分章节（Seal、PKI、Agent）的输出会与本教程不一致。

下一章我们在这个环境里把"请求是怎么走的"看一遍。
