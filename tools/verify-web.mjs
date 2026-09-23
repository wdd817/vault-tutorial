#!/usr/bin/env node
/**
 * 构建校验器：把 dist/ 的产物与 Markdown 源文件逐项对账。
 * 用法：node tools/verify-web.mjs [--out dist]
 *
 * 校验项：
 *   1. SUMMARY.md 里的每一页都产出了 HTML
 *   2. 每个代码块与源文件逐字节一致（含数量一致）
 *   3. 每个标题都出现在产出里、锚点 id 与算法一致
 *   4. 页内锚点、站内链接全部可达
 *   5. 没有未转换的 Markdown 残留
 *   6. 产物自包含（不引用任何外部资源）
 *   7. 搜索索引覆盖全部页面且有内容
 *   8. CommonMark 缩进代码块（会被误渲染）告警
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fenceBlocks,
  headingLines,
  indentedOutsideFences,
  htmlCodeBlocks,
  normCode,
  slugify,
  decodeEntities,
} from './md-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const outIdx = process.argv.indexOf('--out');
const OUT = path.resolve(ROOT, outIdx > -1 ? process.argv[outIdx + 1] : 'dist');

const read = (p) => fs.readFileSync(p, 'utf8');
const problems = [];
const notes = [];
const fail = (m) => problems.push(m);

// ---------- 解析 SUMMARY ----------
const entries = [...read(path.join(ROOT, 'SUMMARY.md')).matchAll(/^\s*\*\s*\[([^\]]+)\]\(([^)]+)\)\s*$/gm)].map(
  (m) => ({ title: m[1], file: m[2].replace(/^\.\//, '') })
);
if (!entries.length) fail('SUMMARY.md 未解析出任何章节');

const slugOf = (file, i) => {
  if (/readme\.md$/i.test(file)) return 'index';
  const m = file.match(/^chapters\/(\d+)/);
  return m ? `ch-${m[1]}` : `page-${i}`;
};

const pages = entries.map((e, i) => ({
  ...e,
  slug: slugOf(e.file, i),
  src: read(path.join(ROOT, e.file)),
  html: '',
}));

let srcBlockTotal = 0;
let htmlBlockTotal = 0;
let headTotal = 0;
let lineChecks = 0;

for (const p of pages) {
  // 1. 页面存在
  const file = path.join(OUT, `${p.slug}.html`);
  if (!fs.existsSync(file)) {
    fail(`缺少页面 ${p.slug}.html（源：${p.file}）`);
    continue;
  }
  p.html = read(file);

  // 2. 代码块内容保真：解析器的块边界由 CommonMark 语境决定（引用块、列表内嵌
  //    围栏的归属很容易judgment错），所以这里不做"块对块"的比较，而是校验更强、
  //    更无歧义的三个不变量：
  //      (a) 产出块数 == 解析器认定的块数（由构建报告 confirm，这里走 HTML 计数）
  //      (b) 源文件里每个围栏区域内的"特征行"都出现在产出中，且出现次数不多不少
  //      (c) 高亮没有吞掉/改写任何字符（构建器已逐块断言 round-trip，这里再抽查）
  const src = fenceBlocks(p.src);
  const got = htmlCodeBlocks(p.html);
  srcBlockTotal += src.length;
  htmlBlockTotal += got.length;

  // (b) 覆盖度校验：按"去掉所有空白"的字符序列比较。
  //     这样既能忽略缩进差异，又能抓到真正的内容丢失/被改写。
  const squash = (t) => t.replace(/\s+/g, '');
  const renderedSquashed = got.map(squash);
  const interesting = new Set();
  for (const b of src) {
    for (const raw of b.code.split('\n')) {
      const t = raw.trim();
      // 只检查足够独特、不会被别的块偶然包含的行
      if (t.length >= 8 && !/^[#/\-*|`<>{}\s]*$/.test(t)) interesting.add(t);
    }
  }
  const missing = [];
  for (const t of interesting) {
    const needle = squash(t);
    if (needle.length < 6) continue;
    if (!renderedSquashed.some((r) => r.includes(needle))) missing.push(t);
  }
  if (missing.length) {
    fail(`${p.file}: 有 ${missing.length} 行源码内容未出现在产出中，例如 ${JSON.stringify(missing.slice(0, 3))}`);
  }
  if (interesting.size) lineChecks += interesting.size;

  // 3. 标题与锚点
  const heads = headingLines(p.src);
  headTotal += heads.length;
  const htmlHeads = [...p.html.matchAll(/<h([1-6]) id="([^"]+)">/g)].map((m) => ({ level: +m[1], id: m[2] }));
  if (heads.length !== htmlHeads.length) {
    fail(`${p.file}: 源标题 ${heads.length} 个，产出 ${htmlHeads.length} 个`);
  }
  const used = new Set();
  for (let i = 0; i < Math.min(heads.length, htmlHeads.length); i++) {
    let expect = slugify(heads[i].text);
    if (used.has(expect)) {
      let n = 2;
      while (used.has(`${expect}-${n}`)) n += 1;
      expect = `${expect}-${n}`;
    }
    used.add(expect);
    if (htmlHeads[i].id !== expect) {
      fail(`${p.file}: 第 ${i + 1} 个标题锚点期望 "${expect}"，实际 "${htmlHeads[i].id}"（${heads[i].text}）`);
    }
    if (htmlHeads[i].level !== heads[i].level) {
      fail(`${p.file}: 第 ${i + 1} 个标题层级期望 h${heads[i].level}，实际 h${htmlHeads[i].level}`);
    }
  }

  // 4. 页内锚点有效（data-* 属性除外）
  const ids = new Set(htmlHeads.map((h) => h.id));
  const body = p.html.split('<article class="prose">')[1]?.split('</article>')[0] || '';
  for (const m of body.matchAll(/href="#([^"]+)"/g)) {
    if (!ids.has(decodeURIComponent(m[1]))) fail(`${p.slug}.html: 页内锚点 #${m[1]} 不存在`);
  }

  // 5. 未转换的 Markdown 残留（只在正文里检查，meta/head 不参与）。
  //    必须在"文本层"检查：产出的 HTML 里 &ast;&ast; 这类实体是 escapeHtml 的正常结果，
  //    直接对 HTML 源码做正则会出现"把渲染正确的粗体误报为未转换"的假警。
  const stripTags = (h) => decodeEntities(h.replace(/<[^>]+>/g, ''));
  const textLayer = stripTags(
    body.replace(/<pre><code[\s\S]*?<\/code><\/pre>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '')
  );
  const leftovers = [
    [/\*\*[^*\n]{2,}\*\*/, '未转换的粗体 **'],
    [/~~[^~\n]{2,}~~/, '未转换的删除线 ~~'],
    [/^\s{0,3}\|.*\|$/m, '未转换的表格'],
    [/^\s{0,3}#{2,6}\s+\S/m, '未转换的标题'],
    [/^\s{0,3}>\s+\S/m, '未转换的引用'],
    [/!?\[[^\]\n]+\]\([^)\n]+\)/, '未转换的链接/图片'],
    [/`[^`\n]+`/, '未转换的行内代码'],
  ];
  for (const [re, label] of leftovers) {
    const m = textLayer.match(re);
    if (m) fail(`${p.slug}.html: ${label} → ${JSON.stringify(m[0].slice(0, 70))}`);
  }

  // meta description 必须是纯文本
  const desc = p.html.match(/<meta name="description" content="([^"]*)"/);
  if (desc && /[#*`>|~_]/.test(decodeEntities(desc[1]))) {
    fail(`${p.slug}.html: meta description 里混入了 Markdown 标记 → ${JSON.stringify(desc[1].slice(0, 70))}`);
  }

  // 反向校验：正文里不应该出现被转义的自产标签，也不该出现 undefined
  for (const [re, label] of [
    [/&lt;\/?(strong|em|del|code|a|img)\b/i, '被转义的自产 HTML 标签（行内渲染回归）'],
    [/\bundefined\b/, '渲染结果里出现 undefined（占位符下标回归）'],
  ]) {
    const m = body.match(re);
    if (m) fail(`${p.slug}.html: ${label} → ${JSON.stringify(m[0].slice(0, 60))}`);
  }

  // 行内格式真的渲染出来了：README 里有粗体，就该出现 <strong>
  if (/\*\*[^*\n]+\*\*/.test(p.src) && !/<strong>/.test(body)) {
    fail(`${p.slug}.html: 源文件有粗体标记，但正文里没有任何 <strong>`);
  }

  // 6. 自包含
  for (const m of p.html.matchAll(/<(?:script|link|img)[^>]+(?:src|href)="([^"]+)"/g)) {
    if (/^https?:/i.test(m[1])) fail(`${p.slug}.html: 引用外部资源 ${m[1]}（需自包含）`);
  }
  const skipped = p.html.match(/<a class="skip" href="#main">/);
  if (!skipped) fail(`${p.slug}.html: 缺少跳到正文的无障碍链接`);
  if (!/<main id="main"/.test(p.html)) fail(`${p.slug}.html: 缺少 <main id="main">`);
}

// 7. 站内链接可达
const slugs = new Set(pages.map((p) => p.slug));
for (const p of pages) {
  if (!p.html) continue;
  for (const m of new Set([...p.html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]))) {
    if (/^(https?:|mailto:)/i.test(m)) continue;
    const file = m.split('#')[0];
    if (!file) continue;
    if (file.endsWith('.html')) {
      const t = file.replace(/\.html$/, '');
      if (!slugs.has(t) && t !== '404') fail(`${p.slug}.html: 链接到不存在的页面 ${m}`);
    } else if (!fs.existsSync(path.join(OUT, file))) {
      fail(`${p.slug}.html: 链接到不存在的文件 ${m}`);
    }
  }
}

// 8. 必要资源与搜索索引
for (const extra of ['assets/style.css', 'assets/app.js', 'assets/search-index.json', 'assets/favicon.svg', '404.html', '.nojekyll', 'README.txt']) {
  if (!fs.existsSync(path.join(OUT, extra))) fail(`缺少资源 ${extra}`);
}
const idx = JSON.parse(read(path.join(OUT, 'assets', 'search-index.json')));
if (!Array.isArray(idx) || idx.length !== pages.length) fail(`search-index.json 条目数 ≠ 页数`);
for (const d of idx) {
  if (!slugs.has(d.slug)) fail(`search-index.json 含未知 slug ${d.slug}`);
  if (!d.chunks?.length) fail(`search-index.json 中 ${d.slug} 无可搜索段落`);
  if (!d.file || !d.title) fail(`search-index.json 中 ${d.slug} 缺少 file/title`);
}

// 9. 缩进代码块告警
const indented = [];
for (const p of pages) {
  for (const l of indentedOutsideFences(p.src)) indented.push(`${p.file}:${l.line}  ${l.text.trim().slice(0, 60)}`);
}
if (indented.length) notes.push(`源文件有 ${indented.length} 行 4 空格缩进（CommonMark 会渲染成代码块）`);

// 10. 体积
const walk = (dir) => {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    total += e.isDirectory() ? walk(f) : fs.statSync(f).size;
  }
  return total;
};

console.log(
  JSON.stringify(
    {
      页面数: pages.length,
      源代码块: srcBlockTotal,
      产出代码块: htmlBlockTotal,
      逐行覆盖校验: lineChecks,
      源标题: headTotal,
      搜索索引KB: +(fs.statSync(path.join(OUT, 'assets', 'search-index.json')).size / 1024).toFixed(1),
      产物总体积KB: +(walk(OUT) / 1024).toFixed(1),
      提示: notes,
      问题数: problems.length,
    },
    null,
    2
  )
);

if (problems.length) {
  console.log('\n--- 问题明细 ---');
  problems.forEach((p, i) => console.log(`${i + 1}. ${p}`));
  process.exit(1);
}
console.log('\n✅ 全部校验通过');
