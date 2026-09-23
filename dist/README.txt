Vault 入门教程 · 静态 Web 包

用法一（推荐，支持全文搜索）：任意静态服务器指向本目录，例如
  python -m http.server 8080    → http://127.0.0.1:8080
  npx serve .                    → http://localhost:3000
用法二：直接双击 index.html（file:// 打开）。导航与样式全部可用，
        浏览器会拦截本地 fetch，因此站内搜索会提示改用 HTTP 方式。

部署：把本目录整体上传到任意静态托管（GitHub Pages / Netlify / Vercel /
      Nginx / 对象存储 + CDN）即可，无需构建步骤、无需后端。
入口文件：index.html（404.html 为兜底，可省略）。
