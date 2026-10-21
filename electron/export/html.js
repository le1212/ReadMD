'use strict';

const { buildExportCss, readVendorCss } = require('./styles');
const { parseWithHeadings } = require('./headings');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(date = new Date()) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function buildCover(title, settings) {
  const subtitle = settings.coverSubtitle
    ? `<p class="readmd-cover__subtitle">${escapeHtml(settings.coverSubtitle)}</p>`
    : '';
  const meta = [settings.coverAuthor, formatDate()]
    .filter(Boolean)
    .map((value) => `<span>${escapeHtml(value)}</span>`)
    .join('');

  return `<section class="readmd-cover">
  <div class="readmd-cover__main">
    <div class="readmd-cover__accent"></div>
    <h1 class="readmd-cover__title">${escapeHtml(title)}</h1>
    ${subtitle}
  </div>
  <div class="readmd-cover__meta">${meta}</div>
</section>`;
}

function buildToc(headings) {
  const items = headings.map((heading) => (
    `<li class="toc-level-${heading.level}"><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`
  )).join('\n');

  return `<nav class="readmd-toc">
  <div class="readmd-toc__title">目录</div>
  <ol>${items}</ol>
</nav>`;
}

function prepareDocumentHtml(payload) {
  const settings = payload.settings || {};
  const { headings, content } = parseWithHeadings(payload.html);
  const front = [];

  if (settings.cover) front.push(buildCover(payload.title, settings));
  if (settings.toc && headings.length >= 2) front.push(buildToc(headings));

  return `${front.join('\n')}\n${content}`;
}

const PRINT_OVERRIDE_CSS = `
html[data-print="true"] body { background: #ffffff; }
html[data-print="true"] .readmd-doc {
  max-width: none;
  margin: 0;
  padding: 0;
  border-radius: 0;
  box-shadow: none;
}
`;

const EXPORT_CSP = [
  "default-src 'none'",
  "img-src file: data: https: blob:",
  "style-src 'unsafe-inline'",
  "font-src data: file:",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

/**
 * 生成独立 HTML / PDF 共用的文档。
 * vendorCss 里包含 KaTeX 与代码高亮，缺失时只是公式/代码颜色退化。
 */
async function buildExportHtml(payload, { forPrint = false } = {}) {
  const vendorCss = await readVendorCss('light');
  const css = `${buildExportCss(vendorCss, payload.settings)}${forPrint ? PRINT_OVERRIDE_CSS : ''}`;
  const safeTitle = escapeHtml(payload.title || '未命名文档');

  return `<!doctype html>
<html lang="zh-CN"${forPrint ? ' data-print="true"' : ''}>
<head>
<meta charset="utf-8">
<meta name="generator" content="ReadMD">
<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">
<title>${safeTitle}</title>
<style>${css}</style>
</head>
<body>
<article class="readmd-doc">
${prepareDocumentHtml(payload)}
</article>
</body>
</html>`;
}

module.exports = {
  buildExportHtml
};
