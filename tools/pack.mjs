#!/usr/bin/env node
/**
 * 把 dist/ 打包成可直接发包的 zip。
 *
 * 用法：
 *   node tools/pack.mjs                      # → vault-tutorial-web.zip
 *   node tools/pack.mjs --out release.zip
 *
 * 说明：不依赖任何第三方库，zip 容器与 deflate 压缩都用 node:zlib 自己写，
 * 这样在没有 npm install 的机器上也能出包。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const SRC = path.resolve(ROOT, argOf('--dir', 'dist'));
const OUT = path.resolve(ROOT, argOf('--out', 'vault-tutorial-web.zip'));

if (!fs.existsSync(SRC)) {
  console.error(`❌ 找不到 ${SRC}\n   先运行：node tools/build-web.mjs`);
  process.exit(1);
}

// ---------------- 极简 ZIP 写入器 ----------------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** 收集文件（相对 zip 根目录的 POSIX 路径） */
function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(abs, rel));
    else if (entry.isFile()) out.push({ abs, rel });
  }
  return out;
}

const entries = walk(SRC);
if (!entries.length) {
  console.error('❌ 目录是空的，先构建');
  process.exit(1);
}

// DOS 时间戳（zip 需要）
const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

const locals = [];
const centrals = [];
let offset = 0;

for (const { abs, rel } of entries) {
  const data = fs.readFileSync(abs);
  const nameBuf = Buffer.from(rel, 'utf8');
  const crc = crc32(data);
  // 已压缩格式（png/jpg/zip）再 deflate 没意义，但仍然安全；这里统一压缩
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const payload = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  locals.push(local, nameBuf, payload);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30); // extra
  central.writeUInt16LE(0, 32); // comment
  central.writeUInt16LE(0, 34); // disk
  central.writeUInt16LE(0, 36); // internal attrs
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs：普通文件 644（必须无符号）
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);

  offset += local.length + nameBuf.length + payload.length;
}

const centralBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

fs.writeFileSync(OUT, Buffer.concat([...locals, centralBuf, eocd]));

const rawBytes = entries.reduce((a, e) => a + fs.statSync(e.abs).size, 0);
const zipBytes = fs.statSync(OUT).size;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log(`✅ 已打包 ${entries.length} 个文件`);
console.log(`   输出：${path.relative(ROOT, OUT)}`);
console.log(`   原始：${kb(rawBytes)}  →  压缩后：${kb(zipBytes)}（省 ${(100 - (zipBytes / rawBytes) * 100).toFixed(1)}%）`);
console.log('');
console.log('发包方式：');
console.log('  1) 解压后把整个目录上传到任意静态托管（GitHub Pages / Netlify / Vercel / Nginx / OSS+CDN）');
console.log('  2) Netlify Drop：直接把 zip 拖到 https://app.netlify.com/drop');
console.log('  3) 本地预览：解压后任选其一');
console.log('       python -m http.server 8080');
console.log('       node tools/serve.mjs --dir <解压目录>');
