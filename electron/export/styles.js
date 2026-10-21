'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 导出排版的统一尺度：
// - 正文 12pt（小四），1.5 倍行距，段后 6pt
// - A4，上下 2.54cm，左右 3.17cm（中文文档常用版心）
// - 标题用黑体，正文用宋体，拉丁文分别配 Arial / Times New Roman
const BODY_FONT_STACK = '"Songti SC", "SimSun", "STSong", "Noto Serif CJK SC", serif';
const HEADING_FONT_STACK = '"PingFang SC", "Microsoft YaHei", "SimHei", "Noto Sans CJK SC", sans-serif';
const MONO_FONT_STACK = '"Cascadia Code", Consolas, "SFMono-Regular", Menlo, monospace';

// GitHub 浅色代码配色，降低饱和度，打印时也不刺眼。
const HIGHLIGHT_CSS = `
.hljs-comment, .hljs-quote { color: #6e7781; font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-subst { color: #cf222e; }
.hljs-string, .hljs-doctag, .hljs-regexp { color: #0a3069; }
.hljs-title, .hljs-section, .hljs-selector-id { color: #8250df; font-weight: 600; }
.hljs-type, .hljs-class .hljs-title { color: #953800; }
.hljs-number, .hljs-literal, .hljs-variable, .hljs-template-variable { color: #0550ae; }
.hljs-attr, .hljs-attribute, .hljs-property { color: #0550ae; }
.hljs-built_in, .hljs-builtin-name { color: #953800; }
.hljs-meta, .hljs-meta .hljs-keyword { color: #8250df; }
.hljs-symbol, .hljs-bullet, .hljs-link { color: #0969da; }
.hljs-deletion { color: #82071e; background-color: #ffebe9; }
.hljs-addition { color: #116329; background-color: #dafbe1; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 600; }
`;

/**
 * PDF / 独立 HTML 共用的排版样式。
 * 屏幕上显示为一张居中的“纸”，打印时去掉卡片外观，交给页面边距。
 */
const PAPER_CSS = `
:root {
  --readmd-ink: #1f2328;
  --readmd-heading: #111827;
  --readmd-muted: #57606a;
  --readmd-faint: #8c959f;
  --readmd-line: #d0d7de;
  --readmd-line-soft: #e5e7eb;
  --readmd-soft: #f6f8fa;
  --readmd-softer: #fafbfc;
  --readmd-accent: #0969da;
}

* { box-sizing: border-box; }

html {
  font-size: 12pt;
}

body {
  margin: 0;
  padding: 0;
  background: #eef1f5;
  color: var(--readmd-ink);
  font-family: ${BODY_FONT_STACK};
  font-size: 12pt;
  line-height: 1.8;
  letter-spacing: 0.02em;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.readmd-doc {
  max-width: 820px;
  margin: 24px auto;
  padding: 56px 64px 72px;
  background: #ffffff;
  border-radius: 18px;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08);
  overflow-wrap: break-word;
}

.readmd-doc > :first-child { margin-top: 0; }
.readmd-doc > :last-child { margin-bottom: 0; }

p {
  margin: 0 0 0.55em;
  text-align: justify;
  text-justify: inter-ideograph;
  overflow-wrap: break-word;
}

h1, h2, h3, h4, h5, h6 {
  margin: 0;
  color: var(--readmd-heading);
  font-family: ${HEADING_FONT_STACK};
  font-weight: 700;
  line-height: 1.35;
  letter-spacing: 0.03em;
  break-after: avoid-page;
  page-break-after: avoid;
  overflow-wrap: break-word;
}

h1 {
  margin: 0 0 16pt;
  padding: 0 0 8pt;
  border-bottom: 0.75pt solid var(--readmd-line-soft);
  font-size: 22pt;
  letter-spacing: 0.04em;
}

h2 { margin: 24pt 0 10pt; font-size: 17pt; }
h3 { margin: 18pt 0 8pt; font-size: 15pt; }
h4 { margin: 14pt 0 6pt; font-size: 13pt; }
h5 { margin: 12pt 0 6pt; font-size: 12pt; }
h6 { margin: 12pt 0 6pt; font-size: 11pt; color: var(--readmd-muted); }

h1 + h2 { margin-top: 0; }

ul, ol {
  margin: 0 0 0.7em;
  padding-left: 1.7em;
}

li {
  margin: 0 0 0.3em;
  overflow-wrap: break-word;
}

li > p { margin: 0 0 0.3em; }
li > ul, li > ol { margin: 0.2em 0 0.4em; }
li::marker { color: var(--readmd-muted); }

ul.vditor-task,
ul.contains-task-list,
ul[data-type="taskList"] {
  padding-left: 1.2em;
  list-style: none;
}

input[type="checkbox"] {
  margin: 0 0.45em 0 0;
  vertical-align: middle;
}

blockquote {
  margin: 1em 0;
  padding: 0.7em 1em;
  border-left: 3pt solid var(--readmd-line);
  background: #f8f9fa;
  color: var(--readmd-muted);
}

blockquote > :first-child { margin-top: 0; }
blockquote > :last-child { margin-bottom: 0; }
blockquote p { margin: 0; }

pre {
  margin: 1em 0;
  padding: 10pt 12pt;
  border: 0.5pt solid var(--readmd-line);
  border-radius: 4pt;
  background: var(--readmd-soft);
  font-family: ${MONO_FONT_STACK};
  font-size: 9.5pt;
  line-height: 1.55;
  letter-spacing: 0;
  white-space: pre-wrap;
  overflow-wrap: break-word;
  break-inside: avoid;
  page-break-inside: avoid;
}

pre code {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: inherit;
  letter-spacing: 0;
}

code, kbd, samp {
  font-family: ${MONO_FONT_STACK};
}

code {
  padding: 0.1em 0.32em;
  border-radius: 3pt;
  background: rgba(175, 184, 193, 0.22);
  font-size: 0.88em;
  letter-spacing: 0;
}

kbd {
  padding: 0.12em 0.4em;
  border: 0.5pt solid var(--readmd-line);
  border-bottom-width: 1.5pt;
  border-radius: 3pt;
  background: var(--readmd-soft);
  font-size: 0.85em;
}

table {
  width: 100%;
  margin: 1em 0;
  border-collapse: collapse;
  font-size: 10.5pt;
  line-height: 1.55;
  letter-spacing: 0.01em;
  break-inside: auto;
}

thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }

th, td {
  padding: 5pt 8pt;
  border: 0.5pt solid var(--readmd-line);
  text-align: left;
  vertical-align: top;
  overflow-wrap: break-word;
}

th {
  background: #f3f4f6;
  font-weight: 600;
  text-align: center;
}

tbody tr:nth-child(even) { background: var(--readmd-softer); }

img, svg {
  max-width: 100%;
  height: auto;
}

img {
  display: block;
  margin: 12pt auto;
  break-inside: avoid;
  page-break-inside: avoid;
}

figure {
  margin: 1em 0;
  text-align: center;
  break-inside: avoid;
}

figcaption {
  margin-top: 4pt;
  color: var(--readmd-muted);
  font-size: 9.5pt;
}

a {
  color: var(--readmd-accent);
  text-decoration: underline;
  text-underline-offset: 2pt;
  overflow-wrap: break-word;
}

hr {
  margin: 18pt 0;
  border: 0;
  border-top: 0.5pt solid var(--readmd-line);
}

mark {
  padding: 0 0.12em;
  background: #fff8c5;
}

sup, sub { line-height: 0; }

/* ------------------------------ 封面与目录 ------------------------------ */

.readmd-cover {
  min-height: 238mm;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 24mm 0 16mm;
  break-after: page;
  page-break-after: always;
}

.readmd-cover__accent {
  width: 18mm;
  height: 3pt;
  margin-bottom: 18pt;
  background: var(--readmd-heading);
}

.readmd-cover__main { margin-top: 48mm; }

.readmd-cover__title {
  max-width: 90%;
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 32pt;
  line-height: 1.28;
  letter-spacing: 0.04em;
}

.readmd-cover__subtitle {
  margin: 14pt 0 0;
  color: var(--readmd-muted);
  font-size: 15pt;
  line-height: 1.5;
  letter-spacing: 0.02em;
  text-align: left;
  text-indent: 0;
}

.readmd-cover__meta {
  display: flex;
  justify-content: space-between;
  gap: 16pt;
  padding-top: 9pt;
  border-top: 0.5pt solid var(--readmd-line-soft);
  color: var(--readmd-muted);
  font-size: 10pt;
  letter-spacing: 0.02em;
}

.readmd-toc {
  break-after: page;
  page-break-after: always;
}

.readmd-toc__title {
  margin: 0 0 18pt;
  padding: 0 0 10pt;
  border-bottom: 0.75pt solid var(--readmd-line-soft);
  color: var(--readmd-heading);
  font-family: ${HEADING_FONT_STACK};
  font-size: 22pt;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.readmd-toc ol {
  margin: 0;
  padding: 0;
  list-style: none;
}

.readmd-toc li {
  margin: 0 0 7pt;
  line-height: 1.6;
}

.readmd-toc a {
  color: var(--readmd-ink);
  text-decoration: none;
}

.readmd-toc .toc-level-2 { padding-left: 1.4em; }
.readmd-toc .toc-level-3 { padding-left: 2.8em; }
.readmd-toc .toc-level-4 { padding-left: 4.2em; }

@media screen {
  .readmd-cover,
  .readmd-toc {
    margin-bottom: 24px;
    padding-bottom: 24px;
    border-bottom: 0.5pt solid var(--readmd-line-soft);
  }
}

.vditor-footnotes,
.footnotes {
  margin-top: 24pt;
  padding-top: 8pt;
  border-top: 0.5pt solid var(--readmd-line);
  color: var(--readmd-muted);
  font-size: 9.5pt;
  line-height: 1.6;
}

.vditor-footnotes ol,
.footnotes ol { padding-left: 1.4em; }

.katex-display {
  margin: 1em 0;
  break-inside: avoid;
  page-break-inside: avoid;
}

${HIGHLIGHT_CSS}

@media print {
  @page { size: A4; }

  body { background: #ffffff; }

  .readmd-doc {
    max-width: none;
    margin: 0;
    padding: 0;
    border-radius: 0;
    box-shadow: none;
  }
}
`;

/**
 * 转 Word 时只保留 Word 需要、且样式系统无法表达的规则。
 * 正文、标题、引用、代码块等交给 Word 样式（styles.js 里的 STYLE_MAP），
 * 这样用户在 Word 里改样式时仍然是“一套规范”，而不是满篇硬编码。
 */
const DOCX_CSS = `
@media print {
  pre, code, kbd, samp { font-family: Consolas, "Courier New", monospace; }

  blockquote { margin: 0; }
  blockquote p { margin: 0; text-indent: 0; }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 10pt 0;
    font-size: 10.5pt;
  }

  th, td {
    padding: 5pt 7pt;
    border: 0.5pt solid #d0d7de;
    text-align: left;
    vertical-align: top;
  }

  th {
    background-color: #f3f4f6;
    font-weight: bold;
    text-align: center;
  }

  tr { break-inside: avoid; }

  img { max-width: 100%; }

  hr {
    border: none;
    border-top: 0.5pt solid #d0d7de;
    margin: 16pt 0;
  }

  ul, ol { margin: 0 0 6pt 0; }
  li { margin: 0 0 3pt 0; }

  a { color: #0969da; text-decoration: underline; }

  ${HIGHLIGHT_CSS}
}
`;

const vendorCssCache = new Map();

function vendorDistDir() {
  return path.join(__dirname, '..', '..', 'renderer', 'vendor', 'vditor', 'dist');
}

/**
 * 把 CSS 里的相对 url() 改写成绝对 file:// 地址，
 * 这样导出的 HTML/PDF 即使被复制到临时目录，KaTeX 字体也能找到。
 */
function rewriteCssUrls(css, baseDir) {
  return String(css).replace(/url\(([^)]+)\)/g, (match, raw) => {
    let value = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!value) return match;
    if (/^(data:|https?:|file:|#|\/\/)/i.test(value)) return match;
    const hashIndex = value.indexOf('#');
    if (hashIndex >= 0) value = value.slice(0, hashIndex);
    const absolute = path.resolve(baseDir, value);
    return `url("${pathToFileURL(absolute).href}")`;
  });
}

async function readVendorCss(theme = 'light') {
  const key = theme === 'dark' ? 'dark' : 'light';
  if (vendorCssCache.has(key)) return vendorCssCache.get(key);

  const dist = vendorDistDir();
  const codeStyle = key === 'dark' ? 'monokai' : 'github';
  const candidates = [
    path.join(dist, 'index.css'),
    path.join(dist, 'css', 'content-theme', `${key}.css`),
    path.join(dist, 'js', 'highlight.js', 'styles', `${codeStyle}.min.css`)
  ];

  const chunks = [];
  for (const file of candidates) {
    try {
      const css = await fsp.readFile(file, 'utf8');
      chunks.push(rewriteCssUrls(css, path.dirname(file)));
    } catch {
      // 主题文件缺失时忽略，不影响导出
    }
  }

  const css = chunks.join('\n');
  vendorCssCache.set(key, css);
  return css;
}

function buildExportCss(vendorCss, settings = {}) {
  let css = `${vendorCss || ''}\n${PAPER_CSS}`;
  if (settings.formal) {
    css += `\n.readmd-doc > p { text-indent: 2em; }\n`;
  }
  return css;
}

function buildDocxCss(settings = {}) {
  if (!settings.formal) return DOCX_CSS;
  return `${DOCX_CSS}
@media print {
  p { text-indent: 2em; }
  li p, blockquote p, td p, th p { text-indent: 0; }
}
`;
}

module.exports = {
  DOCX_CSS,
  buildDocxCss,
  readVendorCss,
  buildExportCss
};
