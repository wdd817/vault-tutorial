/**
 * 语法高亮：先扫描出"字符串 / 注释"片段，再只对片段之间的代码区应用关键字规则。
 * 每一段都是独立生成的纯文本，因此任何一次替换都不可能命中自己刚生成的标签。
 *
 * 关键保证：highlightCode(code, lang) 去掉标签、还原实体后 === 原始 code。
 * 该保证由 tools/verify-web.mjs 的"高亮往返校验"逐块检查。
 */

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const KEYWORDS = {
  powershell:
    /\b(vault|Select-String|ForEach-Object|ConvertFrom-Json|ConvertTo-Json|Set-Content|Get-Content|Get-FileHash|Invoke-WebRequest|Expand-Archive|Start-Process|Stop-Process|New-Item|Remove-Item|Get-ChildItem|Test-Path|Compress-Archive|Write-Output|Get-Process|Set-Location|New-Object)\b/g,
  bash: /\b(vault|curl|sha256sum|unzip|docker|systemctl|export|echo|cat|nginx|chmod|mkdir|tee|apt-get|brew)\b/g,
  hcl: /\b(path|capabilities|storage|listener|seal|template|auto_auth|sink|vault|ui|address|tls_disable|disable_mlock|api_addr|cluster_addr|node_id|retry_join|leader_api_addr|region|kms_key_id|key_name|mount_path|contents|destination|config|method|pid_file|policy|policies|type|options|default_lease_ttl|max_lease_ttl)\b/g,
  json: /\b(true|false|null)\b/g,
  yaml: /\b(true|false|null)\b/g,
  sql: /\b(SELECT|FROM|WHERE|CREATE|USER|IDENTIFIED|BY|GRANT|ON|TO|DROP|ALTER|TABLE|DATABASE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|LIKE|REVOKE|PRIVILEGES)\b/gi,
};

/**
 * 语言附加规则：{ re, cls, lead }
 * lead = true 表示第 1 个捕获组是"前缀"（空白或标点），应保留在标签之外。
 */
const EXTRAS = {
  powershell: [
    { re: /(\$env:)?\$[A-Za-z_][\w:]*/g, cls: 'tok-var' },
    { re: /(^|[\s|;&(])(-{1,2}[A-Za-z][\w-]*)/g, cls: 'tok-flag', lead: true },
  ],
  bash: [
    { re: /(\$\{?[A-Za-z_][\w]*\}?)/g, cls: 'tok-var' },
    { re: /(^|[\s|;&(])(--?[A-Za-z][\w-]*)/g, cls: 'tok-flag', lead: true },
  ],
  json: [{ re: /(-?\b\d+(?:\.\d+)?\b)/g, cls: 'tok-num' }],
  hcl: [
    { re: /(^|\n)([ \t]*)([A-Za-z_][\w-]*)([ \t]*=)/g, cls: 'tok-key', lead: true },
    { re: /("(?:create|read|update|patch|delete|list|sudo|deny)")/g, cls: 'tok-const' },
  ],
  ini: [
    { re: /(\[[^\]]+\])/g, cls: 'tok-key' },
    { re: /(^|\n)([ \t]*)([A-Za-z_][\w.]*)(?==)/g, cls: 'tok-key', lead: true },
  ],
};

/** 变量引用 regex 的首个捕获组可能只包住变量本身，此时整段都要上色 */
function isSelfGroup(g1, m) {
  return g1 !== undefined && g1 === m;
}

function applyRule(text, { re, cls, lead }) {
  return text.replace(re, (...args) => {
    const m = args[0];
    const groups = args.slice(1, -2);
    const g1 = groups[0];
    if (lead && g1 !== undefined && g1 !== '' && m.startsWith(g1) && m.length > g1.length) {
      return `${g1}<span class="${cls}">${m.slice(g1.length)}</span>`;
    }
    return `<span class="${cls}">${m}</span>`;
  });
}

/** 扫描一行，切分为 代码 / 字符串 / 注释 片段 */
function lineSegments(line, lang) {
  const marks = [];
  const n = line.length;
  let i = 0;

  while (i < n) {
    const ch = line[i];

    const commentStarts =
      ((lang === 'powershell' || lang === 'bash') && ch === '#') ||
      (lang === 'yaml' && ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) ||
      (lang === 'hcl' && (ch === '#' || (ch === '/' && line[i + 1] === '/'))) ||
      (lang === 'ini' && i === 0 && (ch === '#' || ch === ';')) ||
      (lang === 'sql' && ch === '-' && line[i + 1] === '-');

    if (commentStarts) {
      marks.push({ start: i, end: n, kind: 'comment' });
      break;
    }

    if (ch === '"' || (ch === "'" && lang !== 'json')) {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === quote) break;
        j += 1;
      }
      marks.push({ start: i, end: Math.min(j + 1, n), kind: 'string' });
      i = Math.min(j + 1, n);
      continue;
    }

    i += 1;
  }

  const segs = [];
  let cursor = 0;
  for (const m of marks.sort((a, b) => a.start - b.start)) {
    if (m.start > cursor) segs.push({ start: cursor, end: m.start, kind: 'code' });
    segs.push(m);
    cursor = Math.max(cursor, m.end);
  }
  if (cursor < n) segs.push({ start: cursor, end: n, kind: 'code' });
  return segs;
}

const CLASS_OF = { string: 'tok-str', comment: 'tok-com' };
const SUPPORTED = new Set(['powershell', 'bash', 'hcl', 'json', 'yaml', 'ini', 'sql']);

export function highlightCode(code, lang) {
  const key = String(lang || '').toLowerCase();
  const lines = code.split('\n');
  if (!SUPPORTED.has(key)) return lines.map((l) => escapeHtml(l)).join('\n');

  const kw = KEYWORDS[key];
  const extras = EXTRAS[key];

  return lines
    .map((line) => {
      const segs = lineSegments(line, key);
      let firstCode = true;
      return segs
        .map((s) => {
          const raw = line.slice(s.start, s.end);
          if (s.kind !== 'code') {
            return `<span class="${CLASS_OF[s.kind]}">${escapeHtml(raw)}</span>`;
          }
          let out = escapeHtml(raw);
          if (firstCode && extras) for (const rule of extras) out = applyRule(out, rule);
          firstCode = false;
          if (kw) out = applyRule(out, { re: kw, cls: 'tok-cmd' });
          return out;
        })
        .join('');
    })
    .join('\n');
}
