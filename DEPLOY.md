# 发包说明（Vault 入门教程 · Web 版）

本目录的 `dist/` 就是**可直接上线**的静态站点，`vault-tutorial-web.zip` 是它的压缩包。
不需要 Node、不需要 npm install、不需要后端，解压即用。

---

## 一、包里有什么

```
index.html              前言/入口
ch-01.html … ch-17.html 17 章正文（每章一个独立 HTML）
404.html                托管平台的兜底页（本地文件服务器不会用到）
assets/
  style.css             全站样式（明暗双主题，含打印样式）
  app.js                侧边目录、页内 TOC、主题切换、复制代码、Ctrl+K 搜索
  search-index.json     全文搜索索引（18 页 / 732 个片段）
  favicon.svg           站点图标
robots.txt              允许抓取
.nojekyll               告诉 GitHub Pages 不要跑 Jekyll
netlify.toml            可选：Netlify 缓存策略
vercel.json             可选：Vercel 缓存策略
Dockerfile              可选：把包做成 nginx 镜像
README.txt              给最终用户看的极简说明
```

体积：解压后约 **623 KB**，压缩包约 **205 KB**。18 个页面、317 个代码块。

**零外部依赖**：页面只引用同目录 `assets/` 下的文件，没有任何 CDN、字体或统计脚本。
正文里指向 `developer.hashicorp.com` 的链接是文档引用，不影响离线浏览。

---

## 二、本地看一眼（三种方式）

```bash
# 方式 1：Python（几乎每台机器都有）
python -m http.server 8080          # → http://127.0.0.1:8080

# 方式 2：npx
npx serve .

# 方式 3：本仓库自带的零依赖服务器
node tools/serve.mjs --dir dist --port 8080
```

也可以直接**双击 `index.html`**（`file://` 打开）：导航、目录、样式、代码复制全部正常，
只有站内搜索会提示"请用 HTTP 方式打开"——这是浏览器的同源限制，属于预期行为。

---

## 三、部署到静态托管

### Netlify（最省事）

把 `vault-tutorial-web.zip` 直接拖到 <https://app.netlify.com/drop> 即可。
包内已带 `netlify.toml`，静态资源会自动获得长缓存。

### Vercel

```bash
vercel deploy --prod
```

包内已带 `vercel.json`。

### GitHub Pages

```bash
# 假设已建好仓库
git add dist && git commit -m "add web bundle"
git subtree push --prefix dist origin gh-pages
```

或者把 `dist/` 的内容推到仓库根目录，然后在 Settings → Pages 里选择分支。
`.nojekyll` 已经放好，避免下划线开头的资源被 Jekyll 忽略。

### Nginx

```nginx
server {
    listen 80;
    root /var/www/vault-tutorial;
    index index.html;

    location / { try_files $uri $uri/ /404.html; }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

### Docker

```bash
docker build -t vault-tutorial .
docker run --rm -p 8080:80 vault-tutorial   # → http://localhost:8080
```

### 对象存储 + CDN（阿里云 OSS / 腾讯云 COS / AWS S3）

把 `dist/` 里的文件全部上传，开启静态网站托管，把默认首页设为 `index.html`、
默认 404 页设为 `404.html` 即可。

---

## 四、重新构建与改内容

包是基于仓库里的 GitBook 源文件生成的，改完内容重新构建即可：

```bash
node tools/build-web.mjs     # 重新生成 dist/
node tools/verify-web.mjs    # 独立校验（链接、锚点、代码块覆盖、自包含性）
node tools/pack.mjs          # 重新打 zip
```

也可以走 npm 别名：`npm run check`（构建 + 校验）、`npm run pack`。

构建器有**构建期自检**：任何一处代码高亮渲染后无法逐字节还原、或者行内格式
（`**粗体**`、`` `代码` ``）没渲染成标签，都会直接以非零退出码失败，不会产出坏包。

---

## 五、常见问题

**搜索没反应？**
`file://` 下浏览器禁止 `fetch` 本地文件，请用 HTTP 方式打开（见第二节）。站点会给出提示。

**打开是空白页 / 样式丢失？**
确认整包一起上传了，`assets/` 目录必须和 HTML 在同一层。这是纯静态包，不涉及跨域。

**每章的网址是什么？**
直接是 `ch-05.html` 这样的文件名。不上不存在的路径就能直接访问，方便分享。

**可以放到子路径下吗（例如 `example.com/vault/`）？**
可以。包内全部是相对路径，放在任意子目录都能正常工作。
