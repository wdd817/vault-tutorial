#!/usr/bin/env node
/**
 * 零依赖静态服务器：用于本地预览 dist/，支持中文全文搜索（file:// 下会被浏览器拦截）。
 *
 * 用法：
 *   node tools/serve.mjs              # http://127.0.0.1:8080
 *   node tools/serve.mjs --port 9000
 *   node tools/serve.mjs --dir web    # 预览其它输出目录
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const PORT = Number(argOf('--port', '8080'));
const DIR = path.resolve(ROOT, argOf('--dir', 'dist'));
const HOST = argOf('--host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

if (!fs.existsSync(DIR)) {
  console.error(`❌ 找不到目录 ${DIR}\n   先运行：node tools/build-web.mjs`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0].split('#')[0]);
  let filePath = path.join(DIR, urlPath);

  // 防目录穿越
  if (!filePath.startsWith(DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const fallback = path.join(DIR, '404.html');
    const body = fs.existsSync(fallback) ? fs.readFileSync(fallback) : Buffer.from('404 Not Found');
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
  headers['Cache-Control'] = ext === '.html' ? 'no-store' : 'public, max-age=3600';
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`Vault 教程预览： http://${HOST}:${PORT}/`);
  console.log(`服务目录：     ${path.relative(ROOT, DIR) || '.'}`);
  console.log('按 Ctrl+C 停止');
});
