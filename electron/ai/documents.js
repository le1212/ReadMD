'use strict';

const path = require('node:path');
const JSZip = require('jszip');

const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 120000;
const MAX_DOCX_XML_BYTES = 20 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.mdown', '.mkd', '.text']);

function decodeXmlEntities(text) {
  return String(text)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

async function extractDocxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('这个 DOCX 文件没有正文内容');

  const declaredSize = Number(documentFile._data?.uncompressedSize || 0);
  if (declaredSize > MAX_DOCX_XML_BYTES) {
    throw new Error('Word 文档解压后过大，请换一个小一点的文件');
  }

  const xml = await documentFile.async('string');
  if (xml.length > MAX_DOCX_XML_BYTES) {
    throw new Error('Word 文档解压后过大，请换一个小一点的文件');
  }
  const paragraphs = [];
  const paragraphPattern = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let paragraphMatch;

  while ((paragraphMatch = paragraphPattern.exec(xml))) {
    const inner = paragraphMatch[1];
    let text = '';
    const tokenPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:br|cr)\s*\/>|<w:tab\s*\/>/g;
    let tokenMatch;

    while ((tokenMatch = tokenPattern.exec(inner))) {
      if (tokenMatch[1] !== undefined) {
        text += decodeXmlEntities(tokenMatch[1]);
      } else if (tokenMatch[0].includes('<w:tab')) {
        text += '\t';
      } else {
        text += '\n';
      }
    }

    const normalized = text.replace(/\u0000/g, '').trimEnd();
    if (normalized.trim()) paragraphs.push(normalized);
  }

  return paragraphs.join('\n');
}

async function extractPdfText(buffer) {
  const { extractText } = await import('unpdf');
  const result = await extractText(new Uint8Array(buffer), { mergePages: true });
  return {
    text: result.text || '',
    pages: result.totalPages || 0
  };
}

async function parseDocument(name, bytes) {
  const declaredBytes = Buffer.isBuffer(bytes)
    ? bytes.length
    : Number(bytes?.byteLength ?? bytes?.length ?? 0);
  if (declaredBytes > MAX_DOCUMENT_BYTES) {
    throw new Error('文件超过 10 MB，请换一个小一点的文件');
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (!buffer.length) throw new Error('文件是空的');
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new Error('文件超过 10 MB，请换一个小一点的文件');
  }

  const extension = path.extname(String(name || '')).toLowerCase();
  let text = '';
  let pages = null;

  if (extension === '.pdf') {
    const result = await extractPdfText(buffer);
    text = result.text;
    pages = result.pages;
    if (!text.trim()) {
      throw new Error('没有从这份 PDF 提取到文字，它可能是扫描件。请上传页面截图，或换一个带文字层的 PDF。');
    }
  } else if (extension === '.docx') {
    text = await extractDocxText(buffer);
    if (!text.trim()) throw new Error('没有从这份 Word 文档提取到文字');
  } else if (TEXT_EXTENSIONS.has(extension)) {
    text = buffer.toString('utf8');
  } else {
    throw new Error('目前支持 PDF、DOCX、TXT、Markdown 文档');
  }

  text = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  const totalChars = text.length;
  const truncated = totalChars > MAX_DOCUMENT_CHARS;
  if (truncated) text = text.slice(0, MAX_DOCUMENT_CHARS);

  return {
    name: String(name || '文档'),
    extension,
    pages,
    chars: totalChars,
    truncated,
    text
  };
}

module.exports = {
  parseDocument,
  extractDocxText,
  extractPdfText,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_CHARS
};
