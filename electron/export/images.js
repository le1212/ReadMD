'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { parse } = require('node-html-parser');

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 100 * 1024 * 1024;
const MAX_REMOTE_IMAGES = 30;
const REMOTE_TIMEOUT_MS = 8000;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function isInsideDir(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  // 单标签主机名和 IPv6 字面量基本只用于内网，保守拒绝
  if (!host.includes('.') || host.includes(':')) return true;
  if (!/^\d+(?:\.\d+){3}$/.test(host)) return false;
  const parts = host.split('.');
  // 只接受规范的十进制写法，避免 0177.0.0.1、2130706433 这类绕过
  if (parts.some((part) => String(Number(part)) !== part)) return true;
  const [a, b] = parts.map(Number);
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function validateRemoteUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('图片地址无效');
  }
  if (parsed.protocol !== 'https:') throw new Error('只允许 https 图片');
  if (isPrivateHost(parsed.hostname)) throw new Error('不允许访问本机或内网图片');
  return parsed;
}

function isWebp(buffer, source) {
  if (/\.webp(?:[?#]|$)/i.test(source || '')) return true;
  return buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

/**
 * Word 2016 以前不能稳定显示 WebP。这里尝试用 Chromium 的图片解码器转成 PNG；
 * 失败时保留原数据，让 docx 的 HTML 转换器给出明确警告。
 */
function normalizeImage(buffer, source) {
  if (!isWebp(buffer, source)) return buffer;
  try {
    const { nativeImage } = require('electron');
    const image = nativeImage.createFromBuffer(buffer);
    if (!image.isEmpty()) {
      const png = image.toPNG();
      if (png && png.length) return png;
    }
  } catch {
    // 交给转换器处理
  }
  return buffer;
}

async function readLocalImage(filePath, notes) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_IMAGE_BYTES) {
      notes.push(`图片超过 25 MB，已跳过：${path.basename(filePath)}`);
      return null;
    }
    const buffer = await fsp.readFile(filePath);
    return normalizeImage(buffer, filePath);
  } catch {
    notes.push(`找不到图片，已跳过：${filePath}`);
    return null;
  }
}

async function fetchRemoteImage(url, notes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const fetchImpl = typeof fetch === 'function'
      ? fetch
      : require('electron').net.fetch;
    let current = url;

    for (let redirects = 0; redirects < 4; redirects += 1) {
      validateRemoteUrl(current);
      const response = await fetchImpl(current, {
        signal: controller.signal,
        redirect: 'manual'
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('重定向地址缺失');
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const length = Number(response.headers.get('content-length') || 0);
      if (length > MAX_IMAGE_BYTES) {
        notes.push(`网络图片超过 25 MB，已跳过：${url}`);
        return null;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length > MAX_IMAGE_BYTES) {
        notes.push(`网络图片超过 25 MB，已跳过：${url}`);
        return null;
      }
      return normalizeImage(buffer, current);
    }
    throw new Error('重定向次数过多');
  } catch (error) {
    notes.push(`网络图片已跳过（${error.message || '下载失败'}）：${url}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function localPathFromSource(source, baseDir) {
  if (/^file:/i.test(source)) {
    try {
      return fileURLToPath(new URL(source));
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return null;
  if (!baseDir) return null;

  const clean = source.split('#')[0].split('?')[0];
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // 保留原样
  }
  return path.resolve(baseDir, decoded);
}

/**
 * 找出 HTML 里的图片并预先读成 Buffer。
 * docx 的 htmlToContent 不会联网，也不会读磁盘，必须由我们提供图片数据。
 */
async function collectImages(html, baseDir) {
  const notes = [];
  const images = new Map();
  if (!html) return { images, notes };

  let root;
  try {
    root = parse(html, { comment: false });
  } catch {
    return { images, notes };
  }

  let realBase = null;
  if (baseDir) {
    try {
      realBase = await fsp.realpath(baseDir);
    } catch {
      realBase = null;
    }
  }

  const sources = new Set();
  for (const element of root.querySelectorAll('img[src]')) {
    const source = element.getAttribute('src');
    if (source && !source.startsWith('data:')) sources.add(source);
  }

  let totalBytes = 0;
  let remoteCount = 0;
  let remoteSkipped = false;
  const remoteDeadline = Date.now() + 30000;

  for (const source of sources) {
    let buffer = null;
    if (/^https?:/i.test(source)) {
      if (/^http:/i.test(source)) {
        notes.push(`只支持 https 网络图片，已跳过：${source}`);
        continue;
      }
      if (remoteCount >= MAX_REMOTE_IMAGES || Date.now() > remoteDeadline) {
        if (!remoteSkipped) {
          notes.push('网络图片过多或下载超时，已跳过剩余网络图片');
          remoteSkipped = true;
        }
        continue;
      }
      remoteCount += 1;
      buffer = await fetchRemoteImage(source, notes);
    } else {
      if (!realBase) {
        notes.push(`没有可用的文档目录，已跳过图片：${source}`);
        continue;
      }
      const filePath = localPathFromSource(source, baseDir);
      if (!filePath || !IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        notes.push(`不支持的图片路径，已跳过：${source}`);
        continue;
      }

      let realFile;
      try {
        realFile = await fsp.realpath(filePath);
      } catch {
        notes.push(`找不到图片，已跳过：${source}`);
        continue;
      }
      if (!isInsideDir(realBase, realFile)) {
        notes.push(`图片不在文档目录内，已跳过：${source}`);
        continue;
      }
      if (!IMAGE_EXTENSIONS.has(path.extname(realFile).toLowerCase())) {
        notes.push(`不支持的图片格式，已跳过：${source}`);
        continue;
      }
      buffer = await readLocalImage(realFile, notes);
    }

    if (!buffer) continue;
    if (totalBytes + buffer.length > MAX_TOTAL_IMAGE_BYTES) {
      notes.push('图片总量超过 100 MB，已跳过剩余图片');
      break;
    }
    totalBytes += buffer.length;
    images.set(source, { data: buffer });
  }

  return { images, notes };
}

module.exports = {
  collectImages
};
