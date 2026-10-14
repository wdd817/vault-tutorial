# Vault 入门教程：从一个个真实需求出发

> **在线版：<https://wdd817.github.io/vault-tutorial/>** —— 支持中文全文搜索（按 `Ctrl` / `Cmd` + `K`）、明暗主题与移动端阅读。源码仓库：[wdd817/vault-tutorial](https://github.com/wdd817/vault-tutorial)

这是一本以 **需求驱动** 的方式讲解 [HashiCorp Vault](https://developer.hashicorp.com/vault) 的中文入门教程。我们不按"功能清单"逐个介绍 API，而是先给出一个具体的、会让人头疼的需求（例如"数据库密码又出现在 Git 里了"），再引出解决它所需要的知识点，然后动手验证。

读完这本教程，你应该能够：

- 在自己机器上跑起一个 Vault，理解 dev 模式与真实部署的区别；
- 用 KV v2 管理静态密钥，并说清楚"软删除"和"彻底销毁"的区别；
- 写出**最小权限**策略，并用 `capabilities` 自查策略到底给了什么权限；
- 讲清楚 token 的生命周期：TTL、续期、撤销，以及 service / batch token 的取舍；
- 用 AppRole / JWT / Kubernetes / LDAP 让**机器**安全地登录 Vault；
- 用数据库动态凭据、Transit 加密服务、PKI 证书服务解决"密钥根本不该存在"的问题；
- 打开审计日志、看懂租约，并知道生产上 **Seal / Unseal、存储、备份** 意味着什么。

## 版本校准（重要）

本教程的所有命令都在 **Vault v2.1.1** 上逐条实测（Linux + Bash）：

```text
Vault v2.1.1 (d78bbbe2d2f3d289c1ec29d431071beb23668212), built 2026-09-15T21:21:56Z
```

版本背景，请在开始前先看一眼，避免踩到"教程和你的环境不是一个年代"的坑：

| 版本线 | 状态 | 最后版本 |
| --- | --- | --- |
| 2.1.x | **当前受支持（推荐）** | 2.1.1（2026-09-15） |
| 2.0.x | 标准维护已于 2026-08-31 结束 | 2.0.4 |
| 1.21.x | 标准维护已于 2026-04-13 结束 | 1.21.4 |

几点提醒：

- Vault 2.x 与 1.x 在**本教程覆盖的功能**上没有破坏性差异：KV v2、策略语法、token、AppRole、Transit、PKI、审计设备、Seal/Unseal 的用法完全一致。教程里的命令在 1.21 上同样能跑通。
- 2.x 的默认挂载表里多了一个 `agent-registry/`（Agent 注册表，主要服务企业版的 Agent 管理能力），在 `vault secrets list` 里看到它不用惊讶。
- 2.x 的默认策略列表里多了 `default-ceiling`（默认策略上限），本教程第 5 章会讲"ceiling policy"这个概念。
- 请**不要**使用 1.x 早期版本（1.20 及以前）照抄本教程：Seal/Unseal、PKI 等章节的部分行为在旧版本上不同。用 `vault --version` 确认自己是 2.1.x 或 1.21.x。
- Vault 2.x 有不少企业版（Enterprise）专属能力（Secrets Sync、MCP Server、Agent Registry 高级功能等）。本教程只讲 **OSS 开源版** 就能完整复现的内容，涉及企业版时都会显式标注。

## 需要准备什么

- 一台可以装软件的机器（Linux / macOS 均可，本教程命令默认给 Bash 写法）；
- 可选：Docker Desktop（第 6 章的 MySQL 实验需要它，其他章节不需要）；
- 大约 2 小时，以及一个**只用于练习**的环境。

> **警告**：教程中的 dev 模式和示例密钥全部仅用于学习。绝对不要把 dev 模式、明文 root token、示例 unseal key 带进任何真实环境。

## 贯穿全书的例子：一家小公司的三周

我们把"北极星电商"（虚构）当作主角。它的运维故事分成三幕，本教程的章节就是按这三幕里的需求推进的：

```text
第一幕（第 1-4 章）  "密钥都存在代码和 wiki 里"
  └─ 需求：集中存、能版本回滚、别到处贴密码
第二幕（第 5-9 章）  "谁能读哪些密钥？机器怎么自己拿密钥？"
  └─ 需求：最小权限、可审计、token 会过期、CI 不用人手的密码登录
第三幕（第 10-17 章）"密码不应该长期存在 / 合规 / 别把 Vault 玩坏"
  └─ 需求：动态数据库账号、加密即服务、证书自动签发、审计留痕、生产 Seal 与备份
```

每一章都遵循同一个结构：

1. **需求**：一个具体到可以立刻动手的场景；
2. **动手**：可以直接复制粘贴的命令，全部经过实测；
3. **原理**：解释刚才发生了什么，以及为什么这样设计；
4. **踩坑与检查清单**：真实环境里最容易出错的几点。

## 目录

- [第 1 章 为什么需要 Vault：一个泄露事故的复盘](chapters/01-why-vault.md)
- [第 2 章 安装与第一个 Vault：dev 模式](chapters/02-install-and-dev-mode.md)
- [第 3 章 Hello Vault：状态、登录与第一个 secret](chapters/03-hello-vault.md)
- [第 4 章 KV v2：给密钥加上版本和删除保护](chapters/04-kv-v2.md)
- [第 5 章 策略：把"能读什么"写成代码](chapters/05-policies.md)
- [第 6 章 拿到密钥的凭证：数据库动态密钥](chapters/06-database-dynamic-secrets.md)
- [第 7 章 Token：一切访问的通行证](chapters/07-tokens.md)
- [第 8 章 认证方法：从人到机器](chapters/08-auth-methods.md)
- [第 9 章 Vault Agent：让应用完全不知道 Vault 的存在](chapters/09-vault-agent.md)
- [第 10 章 Transit：加密即服务](chapters/10-transit.md)
- [第 11 章 PKI：把证书签发变成一次 API 调用](chapters/11-pki.md)
- [第 12 章 租约、续期与撤销](chapters/12-leases.md)
- [第 13 章 审计设备：合规的底线](chapters/13-audit.md)
- [第 14 章 Seal 与 Unseal：Vault 的保险柜逻辑](chapters/14-seal-unseal.md)
- [第 15 章 存储、HA 与备份恢复](chapters/15-storage-ha-backup.md)
- [第 16 章 生产清单、升级与常见坑](chapters/16-production-checklist.md)
- [第 17 章 附录：速查表与延伸学习](chapters/17-appendix.md)

## 关于本书的写作与验证方式

- 所有命令都先在本地 Vault 2.1.1 上跑过；正文里贴出的输出是真实回显（只替换了 token/key 这类敏感串）。
- 教程默认在 Linux / macOS 的 **Bash** 下运行，所有命令都可以直接复制粘贴。涉及 Vault CLI 自身的规则（例如 flag 必须写在位置参数之前）会在正文里单独说明。
- 生产环境请以 [官方文档](https://developer.hashicorp.com/vault/docs) 为准；本教程的目标是让你先"跑起来、看明白"，再去看官方文档时不再迷路。

## Web 版打包（可直接发包）

本书除了 GitBook 源文件，还带一个**零依赖**的静态站点打包器：不需要 `npm install`，
不引入任何第三方库，Markdown 解析、语法高亮、全文搜索全部内置。

```bash
node tools/build-web.mjs     # 构建 → dist/
node tools/verify-web.mjs    # 独立校验产物（链接、标题锚点、代码块覆盖、自包含性）
node tools/pack.mjs          # 打包 → vault-tutorial-web.zip
node tools/serve.mjs         # 本地预览 → http://127.0.0.1:8080
```

也可以直接用 npm 别名：`npm run build` / `npm run check` / `npm run pack` / `npm run serve`。

产物特点：

- **自包含**：18 个 HTML 页面 + `assets/`（样式、脚本、图标、搜索索引），无外部 CDN 依赖，可离线使用。
- **纯静态**：解压后丢进任意静态托管即可（GitHub Pages / Netlify / Vercel / Nginx / 对象存储 + CDN）。
  已附带 `netlify.toml`、`vercel.json`、`Dockerfile` 三个即用配置，不需要可以直接删除。
- **离线可读**：全部用相对路径，直接双击 `index.html` 也能正常翻阅；只有站内搜索依赖
  `fetch` 读取 `assets/search-index.json`，在 `file://` 下会被浏览器拦截并给出友好提示。
- **构建期自检**：高亮渲染做了逐字节往返校验（315 个代码块），行内格式做了渲染回归检查，
  任何一项不通过就直接以非零退出码失败，避免把内容损坏的产物发出去。
- **改完自动上线**：推送到 `main` 后，GitHub Actions 会自动重新构建、跑校验、发布到 Pages
  （见 `.github/workflows/pages.yml`）。流水线里还有一道额外关卡：拒绝任何以 `/` 开头的资源引用，
  因为站点部署在 `/vault-tutorial/` 子路径下，绝对路径会导致 404。

构建报告示例：

```json
{
  "pages": 18,
  "headings": 219,
  "codeBlocks": 315,
  "highlightRoundTripOK": 315,
  "inlineRenderOK": 18,
  "searchDocs": 18,
  "searchChunks": 718,
  "totalBytes": 636094
}
```

