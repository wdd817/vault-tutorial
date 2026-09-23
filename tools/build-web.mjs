#!/usr/bin/env node
/**
 * Vault 教程静态站点打包器
 * ------------------------------------------------------------------
 * 输入：README.md + SUMMARY.md + chapters/*.md（GitBook 源文件）
 * 输出：dist/  ← 纯静态 HTML/CSS/JS，无运行时依赖，可直接发包
 *
 * 用法：
 *   node tools/build-web.mjs            # 构建到 dist/
 *   node tools/build-web.mjs --out web  # 自定义输出目录
 *
 * 特性：
 *   - 零第三方依赖（markdown 解析、语法高亮、搜索索引全部内置）
 *   - 每章生成独立 .html，配合 hash 路由，可在 file:// 直接双击打开
 *   - 侧边目录、上下章、页内 TOC、明暗主题、中文全文搜索（含简单 AND 语义）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugify } from './md-utils.mjs';
import { highlightCode } from './highlight.mjs';
import { indentedOutsideFences } from './md-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const outArgIdx = process.argv.indexOf('--out');
const OUT = path.resolve(ROOT, outArgIdx > -1 ? process.argv[outArgIdx + 1] : 'dist');

// ------------------------------------------------------------------
// 第 0 步：从 SUMMARY.md 解析章节目录（GitBook 的唯一事实来源）
// ------------------------------------------------------------------
function parseSummary(md) {
  const chapters = [];
  const re = /^\s*\*\s*\[([^\]]+)\]\(([^)]+)\)\s*$/;
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(re);
    if (!m) continue;
    const [, title, href] = m;
    const clean = href.replace(/^\.\//, '');
    chapters.push({ title, file: clean, isReadme: /readme\.md$/i.test(clean) });
  }
  return chapters;
}

const summaryMd = fs.readFileSync(path.join(ROOT, 'SUMMARY.md'), 'utf8');
const summary = parseSummary(summaryMd);

function slugFor(file, i) {
  if (/readme\.md$/i.test(file)) return 'index';
  const m = file.match(/^chapters\/(\d+)/);
  return m ? `ch-${m[1]}` : `page-${i}`;
}

const pages = summary.map((s, i) => {
  const slug = slugFor(s.file, i);
  const src = fs.readFileSync(path.join(ROOT, s.file), 'utf8');
  return { ...s, slug, src, outFile: `${slug}.html` };
});

// ------------------------------------------------------------------
// 第 1 步：极简 Markdown 解析器（覆盖本教程实际用到的语法）
// ------------------------------------------------------------------
const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

/** 生成稳定的锚点 id：保留中英文与数字，去掉标点（实现见 md-utils.mjs，与校验器共用） */

/**
 * 行内语法渲染器：单次从左到右扫描，直接产出 HTML 片段。
 *
 * 这里踩过两个坑，都已由 tools/verify-web.mjs 覆盖回归：
 *  1. "先用正则生成 HTML、再整体 escapeHtml" → 刚生成的 <strong> 被转义成
 *     &lt;strong&gt;，表现为**全文粗体都显示成字面星号**。
 *  2. 用"depth 计数"匹配成对分隔符，在 open === close（如 `**`）时同一位置
 *     既算 open 又算 close，depth 直接变 2 且回不到 0 → **所有粗体都匹配不上**。
 */

/** 查找成对标记的收尾：跳过开头标记后线性寻找下一个标记，并跳过转义字符 */
function findClosing(s, from, marker) {
  for (let j = from; j < s.length; j += 1) {
    if (s[j] === '\\') {
      j += 1;
      continue;
    }
    if (s.startsWith(marker, j)) {
      return { inner: s.slice(from, j), end: j + marker.length };
    }
  }
  return null;
}

/** 匹配 [label](href "title") / ![alt](src) */
function readLink(s, i) {
  const image = s[i] === '!' && s[i + 1] === '[';
  const bracket = image ? i + 1 : i;
  if (s[bracket] !== '[') return null;
  const label = findClosing(s, bracket + 1, ']');
  if (!label || s[label.end] !== '(') return null;
  const target = findClosing(s, label.end + 1, ')');
  if (!target) return null;

  const raw = target.inner.trim();
  const m = raw.match(/^(\S+)(?:\s+"([^"]*)")?$/);
  if (!m) return null;
  return { image, label: label.inner, href: m[1], title: m[2] || '', end: target.end };
}

function inline(text) {
  const s = String(text);
  const out = [];
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    // 行内代码（最高优先级：内容不参与任何格式化）
    if (ch === '`') {
      const d = findClosing(s, i + 1, '`');
      if (d && d.inner.trim() !== '') {
        out.push(`<code>${escapeHtml(d.inner)}</code>`);
        i = d.end;
        continue;
      }
    }

    // 图片 / 链接
    if (ch === '!' || ch === '[') {
      const l = readLink(s, i);
      if (l) {
        if (l.image) {
          out.push(
            `<img src="${escapeAttr(l.href)}" alt="${escapeAttr(l.label)}"${l.title ? ` title="${escapeAttr(l.title)}"` : ''} loading="lazy">`
          );
        } else {
          out.push(
            `<a href="${escapeAttr(l.href)}"${l.title ? ` title="${escapeAttr(l.title)}"` : ''}>${inline(l.label)}</a>`
          );
        }
        i = l.end;
        continue;
      }
    }

    // 粗体
    if (ch === '*' && s.startsWith('**', i)) {
      const d = findClosing(s, i + 2, '**');
      if (d && d.inner.trim() !== '') {
        out.push(`<strong>${inline(d.inner)}</strong>`);
        i = d.end;
        continue;
      }
    }

    // 删除线
    if (ch === '~' && s.startsWith('~~', i)) {
      const d = findClosing(s, i + 2, '~~');
      if (d && d.inner.trim() !== '') {
        out.push(`<del>${inline(d.inner)}</del>`);
        i = d.end;
        continue;
      }
    }

    // 斜体（要求紧跟在 * 后面的不是空白，避免误吃 "a * b * c"）
    if (ch === '*' && s[i + 1] !== undefined && s[i + 1] !== ' ' && s[i + 1] !== '*') {
      const d = findClosing(s, i + 1, '*');
      if (d && d.inner.trim() !== '') {
        out.push(`<em>${inline(d.inner)}</em>`);
        i = d.end;
        continue;
      }
    }

    // 普通字符：累积到下一个特殊字符为止，一次性转义
    let j = i + 1;
    while (j < s.length && !'*`[!~\\'.includes(s[j])) j += 1;
    out.push(escapeHtml(s.slice(i, j)));
    i = j;
  }

  return out.join('');
}

const CALLOUTS = {
  note: ['提示', 'note'],
  info: ['说明', 'info'],
  tip: ['技巧', 'tip'],
  warning: ['注意', 'warning'],
  danger: ['警告', 'danger'],
  important: ['重要', 'important'],
  caution: ['当心', 'warning'],
  success: ['实战通过', 'success'],
  quote: ['摘录', 'quote'],
};

const highlight = (code, lang) => highlightCode(code, lang);

/** 去掉每行最多 n 个前导空格（用于把列表项里缩进的代码块还原成原始缩进） */
function dedent(line, n) {
  let k = 0;
  while (k < n && (line[k] === ' ' || line[k] === '\t')) k += 1;
  return line.slice(k);
}

/** 渲染代码块，并登记到 ctx.codeBlocks（构建报告与自检要用） */
function renderCodeBlock(code, lang, ctx) {
  const cls = lang ? ` class="language-${escapeAttr(lang)}"` : '';
  ctx.codeBlocks.push({ lang, code });
  return (
    `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(lang || 'text')}</span>` +
    `<button class="copy-btn" type="button" data-copy>复制</button></div>` +
    `<pre><code${cls}>${highlight(code, lang)}</code></pre></div>`
  );
}

/** 主要解析函数 */
function parseMarkdown(src, ctx) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  const headings = [];
  let i = 0;
  const usedIds = new Set();

  const uniqueId = (text) => {
    let id = slugify(text);
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    usedIds.add(id);
    return id;
  };

  const flushParagraph = (buf) => {
    if (!buf.length) return;
    const text = buf.join('\n').trim();
    if (text) html.push(`<p>${inline(text)}</p>`);
    buf.length = 0;
  };

  const para = [];

  while (i < lines.length) {
    const line = lines[i];

    // ---- 代码块 ----
    const fence = line.match(/^\s*(```+|~~~+)\s*([A-Za-z0-9#+._-]*)\s*$/);
    if (fence) {
      flushParagraph(para);
      const indent = line.match(/^\s*/)[0].length;
      const marker = fence[1][0].repeat(fence[1].length);
      const lang = fence[2] || '';
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        body.push(dedent(lines[i], indent));
        i += 1;
      }
      i += 1; // 跳过结束围栏
      html.push(renderCodeBlock(body.join('\n'), lang, ctx));
      continue;
    }

    // ---- 标题 ----
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flushParagraph(para);
      const level = h[1].length;
      const raw = h[2];
      const id = uniqueId(raw);
      headings.push({ level, text: raw.replace(/[`*_]/g, ''), id });
      ctx.plain.push(raw.replace(/[`*_>]/g, ''));
      html.push(`<h${level} id="${id}"><a class="anchor" href="#${id}" aria-label="链接到此节">#</a>${inline(raw)}</h${level}>`);
      i += 1;
      continue;
    }

    // ---- 分隔线 ----
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph(para);
      html.push('<hr>');
      i += 1;
      continue;
    }

    // ---- 引用 / callout ----
    if (/^\s*>/.test(line)) {
      flushParagraph(para);
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      const inner = parseMarkdown(buf.join('\n'), ctx).html;
      const callout = buf[0] && buf[0].match(/^\[!(\w+)\]\s*(.*)$/);
      if (callout) {
        const key = callout[1].toLowerCase();
        const [label, variant] = CALLOUTS[key] || [callout[1], 'note'];
        const rest = parseMarkdown([callout[2], ...buf.slice(1)].join('\n'), ctx).html;
        html.push(
          `<blockquote class="callout callout-${variant}"><p class="callout-title">${escapeHtml(label)}</p><div class="callout-body">${rest}</div></blockquote>`
        );
      } else {
        html.push(`<blockquote>${inner}</blockquote>`);
      }
      continue;
    }

    // ---- 表格 ----
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      flushParagraph(para);
      // 先保护行内代码里的竖线（例如 `a \| b`），再按竖线切分单元格
      const splitRow = (l) => {
        const stash = [];
        const guarded = l.replace(/`[^`]*`/g, (m) => {
          stash.push(m);
          return `\u0000${stash.length - 1}\u0000`;
        });
        return guarded
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim().replace(/\u0000(\d+)\u0000/g, (_, k) => stash[Number(k)]));
      };
      const head = splitRow(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        body.push(splitRow(lines[i]));
        i += 1;
      }
      const thead = `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`;
      const tbody = `<tbody>${body
        .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`;
      html.push(`<div class="table-wrap"><table>${thead}${tbody}</table></div>`);
      continue;
    }

    // ---- 列表（有序 / 无序，支持嵌套与复选框）----
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flushParagraph(para);
      const block = [];
      while (
        i < lines.length &&
        (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && lines[i].trim() !== ''))
      ) {
        block.push(lines[i]);
        i += 1;
      }
      html.push(renderList(block, ctx));
      continue;
    }

    // ---- 原始 HTML 块 ----
    if (/^\s*<(div|table|details|p|img|br|hr)\b/i.test(line)) {
      flushParagraph(para);
      html.push(line);
      i += 1;
      continue;
    }

    // ---- 空行 ----
    if (line.trim() === '') {
      flushParagraph(para);
      i += 1;
      continue;
    }

    para.push(line);
    i += 1;
  }

  flushParagraph(para);
  return { html: html.join('\n'), headings };
}

/**
 * 列表渲染：两空格缩进视为一层嵌套。
 *
 * 注意：Markdown 里很常见的写法是"列表项 + 缩进的围栏代码块"（本教程大量使用，
 * 例如「生产上要把 destroy 单独排除：」后面跟两空格缩进的 ```hcl 块）。
 * 这种块必须真的渲染成代码块 —— 早期版本会把它当成普通续行文本，
 * 结果页面里直接漏出 ``` 字面量。
 */
function renderList(block, ctx) {
  const items = [];
  let pendingCode = null; // 归属于上一个列表项的代码块 HTML

  for (let k = 0; k < block.length; k += 1) {
    const raw = block[k];

    // 嵌套围栏代码块
    const fence = raw.match(/^\s*(```+|~~~+)\s*([A-Za-z0-9#+._-]*)\s*$/);
    if (fence) {
      const indent = raw.match(/^\s*/)[0].length;
      const marker = fence[1][0].repeat(fence[1].length);
      const body = [];
      k += 1;
      while (k < block.length && !new RegExp(`^\\s*${marker}\\s*$`).test(block[k])) {
        body.push(dedent(block[k], indent));
        k += 1;
      }
      const htmlCode = renderCodeBlock(body.join('\n'), fence[2] || '', ctx);
      if (items.length) items[items.length - 1].extra.push(htmlCode);
      else pendingCode = htmlCode;
      continue;
    }

    const m = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (m) {
      items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3], extra: [] });
      if (pendingCode) {
        items[items.length - 1].extra.push(pendingCode);
        pendingCode = null;
      }
    } else if (items.length) {
      items[items.length - 1].text += '\n' + raw.trim();
    }
  }

  const out = [];
  let idx = 0;
  const renderLevel = (level) => {
    if (idx >= items.length) return '';
    const ordered = items[idx].ordered;
    let inner = '';
    while (idx < items.length && items[idx].indent === level) {
      const item = items[idx];
      idx += 1;
      let child = '';
      if (idx < items.length && items[idx].indent > level) child = renderLevel(items[idx].indent);
      const extra = item.extra.join('\n');
      const checkbox = item.text.match(/^\[( |x|X)\]\s+(.*)$/);
      if (checkbox) {
        const checked = checkbox[1].toLowerCase() === 'x';
        inner += `<li class="task${checked ? ' done' : ''}"><input type="checkbox" disabled${checked ? ' checked' : ''}> ${inline(checkbox[2])}${child}${extra}</li>`;
      } else {
        inner += `<li>${inline(item.text)}${child}${extra}</li>`;
      }
    }
    out.push(ordered ? `<ol>${inner}</ol>` : `<ul>${inner}</ul>`);
    return out.pop();
  };
  let result = pendingCode || '';
  while (idx < items.length) result += renderLevel(items[idx].indent);
  return result;
}

// ------------------------------------------------------------------
// 第 2 步：链接重写（.md → .html，#锚点 → slug#锚点）
// ------------------------------------------------------------------
function rewriteLinks(html, currentSlug, byFile) {
  return html.replace(/href="([^"]+)"/g, (whole, href) => {
    if (/^(https?:|mailto:|#)/i.test(href)) return whole;
    const [rawPath, rawHash] = href.split('#');
    if (!rawPath) return whole;
    const target = byFile.get(rawPath.replace(/^\.\//, ''));
    if (!target) return whole;
    const file = target.slug === currentSlug ? '' : `${target.slug}.html`;
    return `href="${file}${rawHash ? `#${rawHash}` : ''}"`;
  });
}

// ------------------------------------------------------------------
// 第 3 步：解析所有页面
// ------------------------------------------------------------------
const byFile = new Map(pages.map((p) => [p.file, p]));

for (const page of pages) {
  const ctx = { codeBlocks: [], plain: [] };
  const parsed = parseMarkdown(page.src, ctx);
  page.headings = parsed.headings;
  page.codeBlocks = ctx.codeBlocks;
  page.codeBlocks = ctx.codeBlocks;
  page.plain = ctx.plain;
  page.body = rewriteLinks(parsed.html, page.slug, byFile);
  // 收集纯文本：既用于搜索索引，也用于 meta description
  const textOnly = parsed.html
    .replace(/<div class="code-block">[\s\S]*?<\/div>\s*<\/div>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  page.text = textOnly;
  // meta description 必须是纯文本，不能混入 Markdown 标记
  page.summary = textOnly.replace(/[#*`>|~_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150);
}

// ------------------------------------------------------------------
// 第 4 步：渲染模板
// ------------------------------------------------------------------
const siteTitle = 'Vault 入门教程';
const siteTagline = '从一个个真实需求出发';

const nav = pages.map((p, idx) => ({ ...p, idx }));
const isChapter = (p) => /^ch-/.test(p.slug);
const groups = [
  { label: '开始', items: nav.filter((p) => !isChapter(p)) },
  {
    label: '基础篇',
    items: nav.filter((p) => isChapter(p) && p.idx <= 4),
  },
  {
    label: '核心篇',
    items: nav.filter((p) => isChapter(p) && p.idx >= 5 && p.idx <= 9),
  },
  {
    label: '进阶篇',
    items: nav.filter((p) => isChapter(p) && p.idx >= 10 && p.idx <= 13),
  },
  {
    label: '生产篇',
    items: nav.filter((p) => isChapter(p) && p.idx >= 14),
  },
].filter((g) => g.items.length);

/** 侧边导航：当前页的 .active 直接渲染进 HTML，这样禁用 JS 或 file:// 打开时也正确 */
function navHtmlFor(currentSlug) {
  return groups
    .map(
      (g) =>
        `<div class="nav-group"><p class="nav-label">${escapeHtml(g.label)}</p><ul>` +
        g.items
          .map((p) => {
            const short = p.title.replace(/^第\s*\d+\s*章\s*/, '');
            const num = p.title.match(/^第\s*(\d+)\s*章/);
            const active = p.slug === currentSlug ? ' class="active" aria-current="page"' : '';
            return `<li><a href="${p.outFile}"${active}${
              p.slug === 'index' ? ' data-home' : ''
            }>${
              num ? `<span class="nav-num">${num[1]}</span>` : '<span class="nav-num nav-num-dot">•</span>'
            }<span class="nav-text">${escapeHtml(short)}</span></a></li>`;
          })
          .join('') +
        '</ul></div>'
    )
    .join('\n');
}

const esc = escapeHtml;

function renderPage(page, idx, options = {}) {
  const prev = options.pager === false ? null : nav[idx - 1];
  const next = options.pager === false ? null : nav[idx + 1];
  const navHtml = navHtmlFor(page.slug);
  const toc = page.headings.filter((h) => h.level === 2 || h.level === 3);
  const tocHtml = toc.length
    ? `<nav class="toc" aria-label="本页目录"><p class="toc-title">本页目录</p><ul>${toc
        .map((h) => `<li class="toc-l${h.level}"><a href="#${h.id}">${esc(h.text)}</a></li>`)
        .join('')}</ul></nav>`
    : '';
  const pager =
    options.pager === false
      ? ''
      : `<nav class="pager">
    ${prev ? `<a class="pager-prev" href="${prev.outFile}"><span>上一章</span><strong>${esc(prev.title)}</strong></a>` : '<span></span>'}
    ${next ? `<a class="pager-next" href="${next.outFile}"><span>下一章</span><strong>${esc(next.title)}</strong></a>` : '<span></span>'}
  </nav>`;

  return `<!doctype html>
<html lang="zh-CN" data-page="${page.slug}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} · ${siteTitle}</title>
<meta name="description" content="${esc(page.summary)}">
<meta name="generator" content="vault-tutorial static builder">
<meta property="og:title" content="${esc(page.title)} · ${siteTitle}">
<meta property="og:type" content="article">
<link rel="stylesheet" href="assets/style.css">
<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">
<script>(function(){try{var t=localStorage.getItem('vt-theme');if(!t){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.dataset.theme=t;}catch(e){}})();</script>
</head>
<body>
<a class="skip" href="#main">跳到正文</a>
<header class="topbar">
  <button class="icon-btn" id="navToggle" aria-label="切换目录" aria-expanded="false">☰</button>
  <a class="brand" href="index.html"><span class="brand-mark">◇</span><span class="brand-text">${siteTitle}<em>${siteTagline}</em></span></a>
  <div class="topbar-actions">
    <button class="search-open" id="searchOpen" type="button"><span>搜索</span><kbd>/</kbd></button>
    <button class="icon-btn" id="themeToggle" aria-label="切换主题">◐</button>
  </div>
</header>
<div class="layout">
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-inner">
      <p class="sidebar-head">目录</p>
      ${navHtml}
      <p class="sidebar-foot">Vault v2.1.1 实测 · 17 章</p>
    </div>
  </aside>
  <div class="scrim" id="scrim" hidden></div>
  <main id="main" class="content">
    <article class="prose">
${page.body}
    </article>
    ${pager}
    <footer class="site-foot">
      <p>本页内容源自本仓库 Markdown 源文件；全部命令在 HashiCorp Vault v2.1.1 上实测。</p>
      <p>生产环境请以 <a href="https://developer.hashicorp.com/vault/docs" rel="noopener">官方文档</a> 为准。</p>
    </footer>
  </main>
  <div class="toc-rail">${tocHtml}</div>
</div>
<div class="search-modal" id="searchModal" hidden>
  <div class="search-box" role="dialog" aria-modal="true" aria-label="站内搜索">
    <input id="searchInput" type="search" placeholder="搜索章节、命令、报错信息…（支持多个关键词，空格分隔）" autocomplete="off">
    <button class="icon-btn" id="searchClose" aria-label="关闭搜索">✕</button>
  </div>
  <div class="search-results" id="searchResults"><p class="search-hint">输入关键词开始搜索，例如：动态密钥 / AppRole / sealed / check-and-set</p></div>
</div>
<script src="assets/app.js" defer></script>
</body>
</html>`;
}

// ------------------------------------------------------------------
// 第 5 步：搜索索引（每页按段落切块，附带标题上下文）
// ------------------------------------------------------------------
const searchDocs = [];
for (const page of pages) {
  const blocks = page.text
    .split(/(?<=[。！？；:：])|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12);
  const chunks = [];
  for (let i = 0; i < blocks.length; i += 2) {
    const merged = [blocks[i], blocks[i + 1]].filter(Boolean).join(' ');
    if (merged) chunks.push(merged.slice(0, 240));
  }
  searchDocs.push({
    slug: page.slug,
    title: page.title,
    file: page.outFile,
    headings: page.headings.map((h) => h.text),
    chunks: chunks.slice(0, 400),
  });
}

// ------------------------------------------------------------------
// 第 6 步：资源（CSS / JS / favicon），自包含、零外部请求
// ------------------------------------------------------------------
const CSS = String.raw`:root{
  --bg:#ffffff; --bg-soft:#f6f8fa; --bg-elev:#ffffff; --border:#e3e6ea; --border-strong:#d0d7de;
  --text:#1f2328; --text-soft:#59636e; --text-faint:#818b98;
  --accent:#7b42bc; --accent-soft:#f3ecfb; --accent-ink:#5b2d91;
  --warn:#9a6700; --warn-bg:#fff8c5; --danger:#b42318; --danger-bg:#ffebe9; --ok:#1a7f37; --ok-bg:#dafbe1;
  --code-bg:#f6f8fa; --tok-com:#6e7781; --tok-str:#0a3069; --tok-var:#953800; --tok-cmd:#8250df; --tok-key:#0550ae; --tok-flag:#116329; --tok-num:#0550ae; --tok-const:#8250df;
  --sidebar-w:296px; --rail-w:240px; --radius:10px;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","PingFang SC","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono","Courier New",monospace;
}
html[data-theme="dark"]{
  --bg:#0d1117; --bg-soft:#161b22; --bg-elev:#161b22; --border:#30363d; --border-strong:#3d444d;
  --text:#e6edf3; --text-soft:#9198a1; --text-faint:#6e7681;
  --accent:#a371f7; --accent-soft:#1f1833; --accent-ink:#c9a6ff;
  --warn:#d29922; --warn-bg:#2e2411; --danger:#f85149; --danger-bg:#2d1214; --ok:#3fb950; --ok-bg:#0f2417;
  --code-bg:#161b22; --tok-com:#8b949e; --tok-str:#a5d6ff; --tok-var:#ffa657; --tok-cmd:#d2a8ff; --tok-key:#79c0ff; --tok-flag:#7ee787; --tok-num:#79c0ff; --tok-const:#d2a8ff;
}
*,*::before,*::after{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);font-size:16px;line-height:1.75;-webkit-font-smoothing:antialiased}
a{color:var(--accent-ink);text-decoration:none}
a:hover{text-decoration:underline}
.skip{position:absolute;left:-9999px}
.skip:focus{left:12px;top:12px;z-index:100;background:var(--bg-elev);padding:8px 14px;border:1px solid var(--border);border-radius:8px}
.topbar{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:12px;height:60px;padding:0 16px;
  background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:saturate(180%) blur(12px);border-bottom:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:10px;color:var(--text);font-weight:650;text-decoration:none}
.brand:hover{text-decoration:none}
.brand-mark{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#4c2889);color:#fff;font-size:15px}
.brand-text{display:flex;flex-direction:column;line-height:1.15;font-size:15px}
.brand-text em{font-style:normal;font-weight:450;font-size:11.5px;color:var(--text-faint)}
.topbar-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.icon-btn{display:grid;place-items:center;width:34px;height:34px;border:1px solid var(--border);border-radius:9px;background:var(--bg-elev);color:var(--text-soft);cursor:pointer;font-size:15px}
.icon-btn:hover{border-color:var(--border-strong);color:var(--text)}
#navToggle{display:none}
.search-open{display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:9px;background:var(--bg-elev);color:var(--text-soft);cursor:pointer;font-size:13px;font-family:inherit}
.search-open:hover{border-color:var(--border-strong);color:var(--text)}
kbd{font-family:var(--mono);font-size:11px;padding:1px 5px;border:1px solid var(--border);border-bottom-width:2px;border-radius:5px;color:var(--text-faint);background:var(--bg-soft)}
.layout{display:grid;grid-template-columns:var(--sidebar-w) minmax(0,1fr) var(--rail-w);gap:0;align-items:start;max-width:1680px;margin:0 auto}
.sidebar{position:sticky;top:60px;height:calc(100vh - 60px);overflow-y:auto;border-right:1px solid var(--border);background:var(--bg-soft)}
.sidebar-inner{padding:18px 14px 40px}
.sidebar-head{margin:0 8px 10px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-faint);font-weight:650}
.nav-group{margin-bottom:14px}
.nav-label{margin:12px 8px 6px;font-size:11.5px;font-weight:650;color:var(--text-faint);letter-spacing:.06em}
.sidebar ul{list-style:none;margin:0;padding:0}
.sidebar a{display:flex;gap:9px;align-items:baseline;padding:6px 9px;border-radius:8px;color:var(--text-soft);font-size:13.6px;line-height:1.5}
.sidebar a:hover{background:var(--bg-elev);color:var(--text);text-decoration:none}
.sidebar a.active{background:var(--accent-soft);color:var(--accent-ink);font-weight:600}
.nav-num{flex:0 0 20px;text-align:right;font-family:var(--mono);font-size:11.5px;color:var(--text-faint)}
.sidebar a.active .nav-num{color:var(--accent-ink)}
.nav-num-dot{opacity:.6}
.sidebar-foot{margin:22px 8px 0;font-size:11.5px;color:var(--text-faint)}
.content{min-width:0;padding:34px 40px 80px;max-width:960px}
.prose{max-width:860px}
.prose h1{margin:0 0 22px;font-size:31px;line-height:1.3;font-weight:700;letter-spacing:-.01em}
.prose h2{margin:46px 0 14px;padding-top:14px;font-size:23px;line-height:1.35;border-top:1px solid var(--border)}
.prose h3{margin:32px 0 10px;font-size:18.5px}
.prose h4{margin:24px 0 8px;font-size:16.5px;color:var(--text-soft)}
.prose p{margin:14px 0}
.prose ul,.prose ol{margin:14px 0;padding-left:26px}
.prose li{margin:6px 0}
.prose li.task{list-style:none;margin-left:-22px}
.prose li.task input{margin-right:7px}
.prose li.done{color:var(--text-faint)}
.prose hr{margin:34px 0;border:0;border-top:1px solid var(--border)}
.prose blockquote{margin:18px 0;padding:12px 18px;border-left:3px solid var(--border-strong);background:var(--bg-soft);border-radius:0 8px 8px 0;color:var(--text-soft)}
.prose blockquote p{margin:6px 0}
.callout{margin:20px 0;padding:14px 18px 6px;border-radius:10px;border:1px solid var(--border);border-left-width:4px;background:var(--bg-soft);color:var(--text)}
.callout-title{margin:0 0 4px!important;font-weight:700;font-size:13.5px;letter-spacing:.02em}
.callout-note,.callout-info{border-left-color:#0969da}
.callout-tip,.callout-success{border-left-color:var(--ok)}
.callout-success{background:var(--ok-bg)}
.callout-warning{border-left-color:#bf8700;background:var(--warn-bg)}
.callout-danger{border-left-color:var(--danger);background:var(--danger-bg)}
html[data-theme="dark"] .callout-warning{background:var(--warn-bg)}
html[data-theme="dark"] .callout-success{background:var(--ok-bg)}
html[data-theme="dark"] .callout-danger{background:var(--danger-bg)}
.prose code{font-family:var(--mono);font-size:13.4px;padding:2px 5px;background:var(--code-bg);border:1px solid var(--border);border-radius:5px;word-break:break-word}
.prose a code{color:inherit}
.code-block{position:relative;margin:16px 0;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--code-bg)}
.code-head{display:flex;align-items:center;justify-content:space-between;padding:5px 10px;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--bg-soft) 70%,transparent)}
.code-lang{font-family:var(--mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-faint)}
.copy-btn{font-family:inherit;font-size:11.5px;padding:2px 9px;border:1px solid var(--border);border-radius:6px;background:var(--bg-elev);color:var(--text-soft);cursor:pointer}
.copy-btn:hover{color:var(--text);border-color:var(--border-strong)}
.copy-btn.ok{color:var(--ok);border-color:var(--ok)}
.code-block pre{margin:0;padding:14px 16px;overflow-x:auto}
.code-block code{display:block;padding:0;border:0;background:none;font-size:13.2px;line-height:1.62;white-space:pre;color:var(--text)}
.tok-com{color:var(--tok-com);font-style:italic}
.tok-str{color:var(--tok-str)}
.tok-var{color:var(--tok-var)}
.tok-cmd{color:var(--tok-cmd);font-weight:600}
.tok-key{color:var(--tok-key)}
.tok-flag{color:var(--tok-flag)}
.tok-num{color:var(--tok-num)}
.tok-const{color:var(--tok-const)}
.table-wrap{overflow-x:auto;margin:20px 0;border:1px solid var(--border);border-radius:var(--radius)}
.prose table{border-collapse:collapse;width:100%;font-size:14.2px}
.prose th,.prose td{padding:9px 13px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
.prose thead th{background:var(--bg-soft);font-weight:650;white-space:nowrap}
.prose tbody tr:last-child td{border-bottom:0}
.prose tbody tr:hover{background:var(--bg-soft)}
.anchor{float:left;margin-left:-1.1em;padding-right:.3em;color:var(--text-faint);opacity:0;font-weight:400;text-decoration:none}
.prose h2:hover .anchor,.prose h3:hover .anchor,.prose h4:hover .anchor{opacity:1}
.toc-rail{position:sticky;top:60px;height:calc(100vh - 60px);overflow-y:auto;padding:34px 18px}
.toc-title{margin:0 0 10px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--text-faint);font-weight:650}
.toc ul{list-style:none;margin:0;padding:0;border-left:1px solid var(--border)}
.toc li{margin:0}
.toc a{display:block;padding:4px 0 4px 12px;margin-left:-1px;border-left:2px solid transparent;font-size:12.8px;color:var(--text-soft);line-height:1.5}
.toc a:hover{color:var(--text);text-decoration:none}
.toc a.active{color:var(--accent-ink);border-left-color:var(--accent);font-weight:600}
.toc-l3 a{padding-left:24px;font-size:12.2px;color:var(--text-faint)}
.pager{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:52px 0 0;max-width:860px}
.pager a{display:flex;flex-direction:column;gap:3px;padding:13px 16px;border:1px solid var(--border);border-radius:var(--radius);color:var(--text);background:var(--bg-elev)}
.pager a:hover{border-color:var(--accent);text-decoration:none}
.pager span{font-size:11.5px;color:var(--text-faint);letter-spacing:.06em}
.pager strong{font-size:14px;font-weight:600}
.pager-next{text-align:right;align-items:flex-end}
.site-foot{max-width:860px;margin:46px 0 0;padding-top:18px;border-top:1px solid var(--border);font-size:12.6px;color:var(--text-faint)}
.site-foot p{margin:4px 0}
.search-modal{position:fixed;inset:0;z-index:60;background:color-mix(in srgb,var(--bg) 70%,transparent);backdrop-filter:blur(3px);padding:8vh 16px 16px;overflow-y:auto}
.search-box{display:flex;gap:8px;max-width:720px;margin:0 auto 14px}
.search-box input{flex:1;height:46px;padding:0 16px;font-family:inherit;font-size:15px;color:var(--text);background:var(--bg-elev);border:1px solid var(--border-strong);border-radius:11px;outline:none}
.search-box input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.search-results{max-width:720px;margin:0 auto;background:var(--bg-elev);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.search-hint{margin:0;padding:22px 18px;color:var(--text-faint);font-size:13.5px}
.search-item{display:block;padding:12px 16px;border-bottom:1px solid var(--border);color:var(--text)}
.search-item:last-child{border-bottom:0}
.search-item:hover,.search-item.sel{background:var(--bg-soft);text-decoration:none}
.search-item .si-title{font-size:12.4px;color:var(--accent-ink);font-weight:650}
.search-item .si-text{font-size:13.6px;color:var(--text-soft);line-height:1.6;margin-top:2px}
.search-item mark{background:var(--warn-bg);color:inherit;padding:0 2px;border-radius:3px}
.scrim{position:fixed;inset:60px 0 0;background:rgba(0,0,0,.42);z-index:30}
@media(max-width:1380px){.layout{grid-template-columns:var(--sidebar-w) minmax(0,1fr)}.toc-rail{display:none}}
@media(max-width:980px){
  #navToggle{display:grid}
  .layout{grid-template-columns:minmax(0,1fr)}
  .sidebar{position:fixed;top:60px;left:0;width:min(88vw,var(--sidebar-w));z-index:35;transform:translateX(-102%);transition:transform .2s ease}
  .sidebar.open{transform:none;box-shadow:0 12px 40px rgba(0,0,0,.28)}
  .content{padding:24px 18px 70px}
  .prose h1{font-size:25px}
  .prose h2{font-size:20px}
  .brand-text em{display:none}
  .search-open span{display:none}
  .pager{grid-template-columns:1fr}
  .pager-next{text-align:left;align-items:flex-start}
}
@media print{
  .topbar,.sidebar,.toc-rail,.pager,.search-modal,.copy-btn,.anchor{display:none!important}
  .layout{display:block}
  .content{max-width:none;padding:0}
  .code-block{break-inside:avoid}
  a{color:inherit}
}
`;

const JS = String.raw`(function(){
  'use strict';
  var html = document.documentElement;
  var pageSlug = html.dataset.page;
  var SIDEBAR_KEY = 'vt-sidebar';

  function qs(s, r){ return (r||document).querySelector(s); }
  function qsa(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); }

  /* ---------- 主题 ---------- */
  var themeBtn = qs('#themeToggle');
  if (themeBtn) themeBtn.addEventListener('click', function(){
    var next = html.dataset.theme === 'dark' ? 'light' : 'dark';
    html.dataset.theme = next;
    try { localStorage.setItem('vt-theme', next); } catch(e){}
  });

  /* ---------- 侧边栏 ---------- */
  var sidebar = qs('#sidebar'), scrim = qs('#scrim'), navToggle = qs('#navToggle');
  function setNav(open){
    if(!sidebar) return;
    sidebar.classList.toggle('open', open);
    if(scrim) scrim.hidden = !open;
    if(navToggle) navToggle.setAttribute('aria-expanded', String(open));
    try { sessionStorage.setItem(SIDEBAR_KEY, open ? '1' : '0'); } catch(e){}
  }
  if(navToggle) navToggle.addEventListener('click', function(){ setNav(!sidebar.classList.contains('open')); });
  if(scrim) scrim.addEventListener('click', function(){ setNav(false); });

  /* 当前页高亮：正常由服务端渲染好 class="active"，这里只做兜底 */
  var current = qs('.sidebar a.active') || qs('.sidebar a[href="' + pageSlug + '.html"]');
  if(current){
    current.classList.add('active');
    if(window.innerWidth <= 980){
      var saved = null;
      try { saved = sessionStorage.getItem(SIDEBAR_KEY); } catch(e){}
      if(saved === '1') setNav(true);
    }
    var box = qs('.sidebar');
    if(box && current.offsetTop > box.clientHeight * 0.7){
      box.scrollTop = Math.max(0, current.offsetTop - box.clientHeight * 0.35);
    }
  }

  /* ---------- 复制代码 ---------- */
  qsa('[data-copy]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var wrap = btn.closest('.code-block');
      var code = wrap && wrap.querySelector('code');
      if(!code) return;
      var text = code.innerText;
      var done = function(){
        btn.textContent = '已复制'; btn.classList.add('ok');
        setTimeout(function(){ btn.textContent = '复制'; btn.classList.remove('ok'); }, 1600);
      };
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(done, function(){ fallback(text, done); });
      } else { fallback(text, done); }
    });
  });
  function fallback(text, done){
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly',''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch(e){}
    document.body.removeChild(ta);
  }

  /* ---------- 页内 TOC 高亮 ---------- */
  var tocLinks = qsa('.toc a');
  if(tocLinks.length && 'IntersectionObserver' in window){
    var map = {};
    tocLinks.forEach(function(a){ map[decodeURIComponent(a.getAttribute('href').slice(1))] = a; });
    var targets = Object.keys(map).map(function(id){ return document.getElementById(id); }).filter(Boolean);
    var seen = new Set();
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if(en.isIntersecting){ seen.add(en.target.id); }
        else { seen.delete(en.target.id); }
      });
      var firstId = null;
      for(var i=0;i<targets.length;i++){ if(seen.has(targets[i].id)){ firstId = targets[i].id; break; } }
      tocLinks.forEach(function(a){ a.classList.remove('active'); });
      if(firstId && map[firstId]) map[firstId].classList.add('active');
    }, { rootMargin: '-72px 0px -72% 0px', threshold: 0 });
    targets.forEach(function(t){ io.observe(t); });
  }

  /* ---------- 站内搜索 ---------- */
  var modal = qs('#searchModal'), input = qs('#searchInput'), results = qs('#searchResults'),
      openBtn = qs('#searchOpen'), closeBtn = qs('#searchClose');
  var INDEX = null, loading = null, selected = -1, currentItems = [];

  function loadIndex(){
    if(INDEX) return Promise.resolve(INDEX);
    if(loading) return loading;
    loading = fetch('assets/search-index.json', { cache: 'force-cache' })
      .then(function(r){ if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j){ INDEX = j; return j; })
      .catch(function(err){ loading = null; throw err; });
    return loading;
  }

  function openSearch(){
    if(!modal) return;
    modal.hidden = false;
    input.value = ''; renderHint('正在加载索引…');
    setTimeout(function(){ input.focus(); }, 20);
    loadIndex().then(function(){
      renderHint('输入关键词开始搜索，例如：动态密钥 / AppRole / sealed / check-and-set');
    }).catch(function(err){
      renderHint('无法加载搜索索引（' + err.message + '）。如果你是通过 file:// 直接打开页面，浏览器会拦截本地 fetch —— 请用任意静态服务器预览，例如：npx serve 或 python -m http.server。');
    });
  }
  function closeSearch(){ if(modal){ modal.hidden = true; } }
  function renderHint(text){ results.innerHTML = '<p class="search-hint"></p>'; qs('.search-hint', results).textContent = text; }

  if(openBtn) openBtn.addEventListener('click', openSearch);
  if(closeBtn) closeBtn.addEventListener('click', closeSearch);
  if(modal) modal.addEventListener('click', function(e){ if(e.target === modal) closeSearch(); });

  document.addEventListener('keydown', function(e){
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if(e.key === '/' && !typing){ e.preventDefault(); openSearch(); return; }
    if(e.key === 'Escape' && modal && !modal.hidden){ closeSearch(); return; }
    if((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'){ e.preventDefault(); openSearch(); return; }
    if(!modal || modal.hidden) return;
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      if(!currentItems.length) return;
      e.preventDefault();
      selected = e.key === 'ArrowDown'
        ? Math.min(selected + 1, currentItems.length - 1)
        : Math.max(selected - 1, 0);
      currentItems.forEach(function(el, i){ el.classList.toggle('sel', i === selected); });
      currentItems[selected].scrollIntoView({ block: 'nearest' });
    } else if(e.key === 'Enter' && currentItems[selected]) {
      e.preventDefault(); window.location.href = currentItems[selected].getAttribute('href');
    }
  });

  function tokenize(q){
    return q.toLowerCase().split(/\s+/).map(function(t){ return t.trim(); }).filter(function(t){ return t.length > 0; });
  }
  function highlight(text, terms){
    var out = text;
    terms.forEach(function(t){
      if(t.length < 2) return;
      try {
        out = out.replace(new RegExp('(' + t.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>');
      } catch(e){}
    });
    return out;
  }

  var timer = null;
  if(input) input.addEventListener('input', function(){
    clearTimeout(timer);
    var q = input.value;
    timer = setTimeout(function(){ runSearch(q); }, 90);
  });

  function runSearch(q){
    var terms = tokenize(q);
    if(!terms.length){ renderHint('输入关键词开始搜索'); currentItems = []; selected = -1; return; }
    loadIndex().then(function(docs){
      var hits = [];
      docs.forEach(function(doc){
        var titleL = doc.title.toLowerCase();
        var headL = (doc.headings || []).join(' ').toLowerCase();
        doc.chunks.forEach(function(chunk, ci){
          var low = chunk.toLowerCase();
          var score = 0, matched = true;
          terms.forEach(function(t){
            var inChunk = low.indexOf(t) > -1;
            if(inChunk) score += 3;
            if(titleL.indexOf(t) > -1) score += 6;
            if(headL.indexOf(t) > -1) score += 2;
            if(!inChunk && titleL.indexOf(t) < 0 && headL.indexOf(t) < 0) matched = false;
          });
          if(matched) hits.push({ doc: doc, chunk: chunk, score: score, ci: ci });
        });
      });
      hits.sort(function(a, b){ return b.score - a.score; });
      hits = hits.slice(0, 40);
      if(!hits.length){ renderHint('没有匹配结果，试试更短的关键词。'); currentItems = []; selected = -1; return; }
      results.innerHTML = hits.map(function(h){
        return '<a class="search-item" href="' + h.doc.file + '">' +
          '<div class="si-title">' + escHtml(h.doc.title) + '</div>' +
          '<div class="si-text">' + highlight(escHtml(h.chunk), terms) + '</div></a>';
      }).join('');
      currentItems = qsa('.search-item', results);
      selected = -1;
    }).catch(function(){ /* 打开时已经提示过 */ });
  }
  function escHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* ---------- 局部锚点滚动偏移（顶部栏遮挡） ---------- */
  function scrollToHash(){
    if(!location.hash) return;
    var id = decodeURIComponent(location.hash.slice(1));
    var el = document.getElementById(id);
    if(!el) return;
    var y = el.getBoundingClientRect().top + window.pageYOffset - 72;
    window.scrollTo({ top: y, behavior: 'auto' });
  }
  window.addEventListener('hashchange', scrollToHash);
  if(location.hash) setTimeout(scrollToHash, 60);
})();
`;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#a371f7"/><stop offset="1" stop-color="#4c2889"/></linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#g)"/>
<path d="M32 12l16 10v20L32 52 16 42V22z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/>
<circle cx="32" cy="32" r="6" fill="#fff"/>
</svg>
`;

// ------------------------------------------------------------------
// 第 7 步：写盘
// ------------------------------------------------------------------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });

let htmlBytes = 0;
for (const [idx, page] of nav.entries()) {
  const out = renderPage(page, idx);
  fs.writeFileSync(path.join(OUT, page.outFile), out, 'utf8');
  htmlBytes += Buffer.byteLength(out);
}

fs.writeFileSync(path.join(OUT, 'assets', 'style.css'), CSS, 'utf8');
fs.writeFileSync(path.join(OUT, 'assets', 'app.js'), JS, 'utf8');
fs.writeFileSync(path.join(OUT, 'assets', 'favicon.svg'), FAVICON, 'utf8');
fs.writeFileSync(path.join(OUT, 'assets', 'search-index.json'), JSON.stringify(searchDocs), 'utf8');

// 静态托管的兜底配置：404 页复用整站版式，但不把"前言"标成当前页
const notFound = renderPage(
  {
    ...nav[0],
    slug: '404',
    title: '页面不存在',
    summary: '页面不存在，请从左侧目录重新进入。',
    headings: [],
    body: [
      '<h1 id="not-found">页面不存在</h1>',
      '<p>你访问的地址没有对应的内容。可能是链接过期，或者文件名拼写有误。</p>',
      '<ul>',
      '<li>从左侧目录挑选一章继续阅读；</li>',
      '<li>或者按 <code>Ctrl</code> / <code>Cmd</code> + <code>K</code> 搜索关键词；</li>',
      '<li>也可以直接回到 <a href="index.html">前言</a>。</li>',
      '</ul>',
    ].join('\n'),
  },
  -1,
  { pager: false }
);
fs.writeFileSync(path.join(OUT, '404.html'), notFound, 'utf8');
fs.writeFileSync(path.join(OUT, '.nojekyll'), '', 'utf8');
fs.writeFileSync(path.join(OUT, 'robots.txt'), 'User-agent: *\nAllow: /\n', 'utf8');
fs.writeFileSync(
  path.join(OUT, 'README.txt'),
  [
    'Vault 入门教程 · 静态 Web 包',
    '',
    '用法一（推荐，支持全文搜索）：任意静态服务器指向本目录，例如',
    '  python -m http.server 8080    → http://127.0.0.1:8080',
    '  npx serve .                    → http://localhost:3000',
    '用法二：直接双击 index.html（file:// 打开）。导航与样式全部可用，',
    '        浏览器会拦截本地 fetch，因此站内搜索会提示改用 HTTP 方式。',
    '',
    '部署：把本目录整体上传到任意静态托管（GitHub Pages / Netlify / Vercel /',
    '      Nginx / 对象存储 + CDN）即可，无需构建步骤、无需后端。',
    '入口文件：index.html（404.html 为兜底，可省略）。',
    '',
  ].join('\n'),
  'utf8'
);

// 静态托管平台的即用配置（不想要可以直接删掉，站点本身不依赖它们）
fs.writeFileSync(
  path.join(OUT, 'netlify.toml'),
  [
    '# Netlify：把本目录拖到 https://app.netlify.com/drop 即可上线',
    '[build]',
    '  publish = "."',
    '  command = ""',
    '',
    '[[headers]]',
    '  for = "/assets/*"',
    '  [headers.values]',
    '    Cache-Control = "public, max-age=31536000, immutable"',
    '',
    '[[headers]]',
    '  for = "/*.html"',
    '  [headers.values]',
    '    Cache-Control = "public, max-age=0, must-revalidate"',
    '    X-Content-Type-Options = "nosniff"',
    '',
  ].join('\n'),
  'utf8'
);
fs.writeFileSync(
  path.join(OUT, 'vercel.json'),
  `${JSON.stringify(
    {
      $schema: 'https://openapi.vercel.sh/vercel.json',
      cleanUrls: false,
      headers: [
        {
          source: '/assets/(.*)',
          headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
        },
        {
          source: '/(.*).html',
          headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
        },
      ],
    },
    null,
    2
  )}\n`,
  'utf8'
);
fs.writeFileSync(
  path.join(OUT, 'Dockerfile'),
  [
    '# 可选：把静态包做成一个 nginx 镜像',
    '#   docker build -t vault-tutorial .',
    '#   docker run --rm -p 8080:80 vault-tutorial',
    'FROM nginx:1.27-alpine',
    'COPY . /usr/share/nginx/html',
    'RUN rm -f /usr/share/nginx/html/Dockerfile \\',
    ' && sed -i "s|location / {|location / { try_files $uri $uri/ /404.html;|" /etc/nginx/conf.d/default.conf',
    'EXPOSE 80',
    '',
  ].join('\n'),
  'utf8'
);

// ------------------------------------------------------------------
// 第 8 步：高亮往返自检 + 构建报告
// ------------------------------------------------------------------
const sizes = {};
for (const f of fs.readdirSync(OUT, { withFileTypes: true })) {
  if (f.isFile()) sizes[f.name] = fs.statSync(path.join(OUT, f.name)).size;
}
const assetsSize = fs
  .readdirSync(path.join(OUT, 'assets'))
  .reduce((acc, f) => acc + fs.statSync(path.join(OUT, 'assets', f)).size, 0);
const total = Object.values(sizes).reduce((a, b) => a + b, 0) + assetsSize;

// 高亮是唯一"会改写代码块内容"的环节：去掉标签并还原实体后必须与原文逐字节一致。
// 这里在构建期直接断言，避免把内容损坏的产物发出去。
const unescape = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const stripTags = (s) => s.replace(/<\/?[A-Za-z][^>]*>/g, '');

let checkedBlocks = 0;
const highlightErrors = [];
for (const page of nav) {
  for (const b of page.codeBlocks) {
    const rendered = highlightCode(b.code, b.lang);
    const roundTrip = unescape(stripTags(rendered));
    checkedBlocks += 1;
    if (roundTrip !== b.code) {
      highlightErrors.push({ page: page.slug, lang: b.lang || 'text', preview: b.code.slice(0, 60) });
    }
  }
}
if (highlightErrors.length) {
  console.error('❌ 高亮往返校验失败（产物内容与源文件不一致）：');
  console.error(JSON.stringify(highlightErrors.slice(0, 10), null, 2));
  process.exit(1);
}

// 行内渲染自检：粗体/行内代码必须真的渲染成标签，而不是留下字面标记
const inlineErrors = [];
for (const page of nav) {
  const strongExpected = /\*\*[^*\n]+\*\*/.test(page.src);
  if (strongExpected && !/<strong>/.test(page.body)) {
    inlineErrors.push({ page: page.slug, reason: '源文件有 **粗体**，但正文没有 <strong>' });
  }
  if (/`[^`\n]+`/.test(page.src) && !/<code>/.test(page.body)) {
    inlineErrors.push({ page: page.slug, reason: '源文件有 `行内代码`，但正文没有 <code>' });
  }
  if (/&lt;\/?(strong|em|code|del)\b/.test(page.body)) {
    inlineErrors.push({ page: page.slug, reason: '正文出现被转义的自产标签' });
  }
}
if (inlineErrors.length) {
  console.error('❌ 行内渲染自检失败：');
  console.error(JSON.stringify(inlineErrors.slice(0, 10), null, 2));
  process.exit(1);
}

const report = {
  pages: nav.length,
  headings: pages.reduce((a, p) => a + p.headings.length, 0),
  codeBlocks: pages.reduce((a, p) => a + p.codeBlocks.length, 0),
  highlightRoundTripOK: checkedBlocks,
  inlineRenderOK: nav.length,
  searchDocs: searchDocs.length,
  searchChunks: searchDocs.reduce((a, d) => a + d.chunks.length, 0),
  htmlBytes,
  assetsBytes: assetsSize,
  totalBytes: total,
  out: path.relative(ROOT, OUT) || '.',
};
console.log(JSON.stringify(report, null, 2));
