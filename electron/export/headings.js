'use strict';

const { parse } = require('node-html-parser');

function headingText(element) {
  try {
    const clone = element.clone();
    clone.querySelectorAll('.katex-mathml').forEach((node) => node.remove());
    return (clone.textContent || '').replace(/\s+/g, ' ').trim();
  } catch {
    return (element.textContent || '').replace(/\s+/g, ' ').trim();
  }
}

function collectHeadings(root) {
  const headings = [];
  const usedIds = new Set();

  root.querySelectorAll('h1, h2, h3, h4').forEach((element, index) => {
    const level = Number(String(element.tagName || '').slice(1));
    const text = headingText(element);
    if (!text) return;

    let id = (element.getAttribute('id') || '').trim();
    if (!id || usedIds.has(id)) {
      id = `readmd-heading-${index + 1}`;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `readmd-heading-${index + 1}-${suffix}`;
        suffix += 1;
      }
      element.setAttribute('id', id);
    }

    usedIds.add(id);
    headings.push({ level, text, id });
  });

  return headings;
}

/**
 * 解析 HTML，返回标题列表和补齐 id 后的 HTML。
 * 目录链接和 Word 目录都依赖同一份标题数据，避免两套解析结果不一致。
 */
function parseWithHeadings(html) {
  const root = parse(html || '', { comment: false });
  const headings = collectHeadings(root);
  return { root, headings, content: root.toString() };
}

module.exports = {
  collectHeadings,
  headingText,
  parseWithHeadings
};
