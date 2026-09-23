/**
 * 源文件解析工具：构建器与校验器共用，保证"判定标准"完全一致。
 */

/** 提取 Markdown 中的围栏代码块（``` / ~~~，支持更长围栏） */

/**
 * 把引用块内容"抬平"：去掉每行开头的 `>` 与一个可选空格。
 * 解析器对 blockquote 是递归解析的，所以引用块内部的 ``` 围栏同样是真正的代码块。
 * 源文件抽取必须做同样的抬平，否则会漏掉/错并引用块里的代码块。
 */
export function dequoteLines(md) {
  return md
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => {
      const m = l.match(/^\s*>(\s?)(.*)$/);
      return m ? m[2] : l;
    });
}

export function fenceBlocks(md) {
  const lines = dequoteLines(md);
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9#+._-]*)\s*$/);
    if (m) {
      const marker = m[1][0].repeat(m[1].length);
      const lang = m[2] || '';
      const body = [];
      i += 1;
      while (i < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ lang, code: body.join('\n') });
    }
    i += 1;
  }
  return blocks;
}

/** 提取围栏之外的行级标题（返回 {level, text, line}） */
export function headingLines(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  lines.forEach((raw, idx) => {
    const f = raw.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      const marker = f[1][0].repeat(f[1].length);
      if (!fence) fence = marker;
      else if (raw.trim().startsWith(marker)) fence = null;
      return;
    }
    if (fence) return;
    const m = raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2], line: idx + 1 });
  });
  return out;
}

/** 围栏之外、以 4 空格 / Tab 缩进的非空行（CommonMark 会渲染成代码块） */
export function indentedOutsideFences(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fence = null;
  lines.forEach((raw, idx) => {
    const f = raw.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      const marker = f[1][0].repeat(f[1].length);
      if (!fence) fence = marker;
      else if (raw.trim().startsWith(marker)) fence = null;
      return;
    }
    if (fence) return;
    if (/^(?: {4,}|\t)/.test(raw) && raw.trim() !== '') out.push({ line: idx + 1, text: raw });
  });
  return out;
}

export const decodeEntities = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

/**
 * 从产出 HTML 里提取代码块的纯文本。
 * 关键：先把标签整体替换成不可见占位符，再解实体；顺序颠倒会把 `&gt;` 之类的
 * 文本实体误当成标签边界，导致内容被吃掉。
 */
export function htmlCodeBlocks(html) {
  const MARK = '\uE000';
  return [...html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) =>
    decodeEntities(m[1].replace(/<\/?[A-Za-z][^>]*>/g, MARK)).replaceAll(MARK, '')
  );
}

/** 比较用归一化：统一换行、去行尾空白、去首尾空白 */
export const normCode = (s) => s.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();

/** 稳定锚点 id 生成（与构建器同一算法） */
export function slugify(text) {
  const base = text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'section';
}
