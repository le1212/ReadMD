'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { z } = require('zod');

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn']);
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt', '.text']);
const MAX_SEARCH_FILES = 300;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_MATCHES = 20;
const MAX_READ_CHARS = 60000;

function isInside(root, target) {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.toLowerCase().startsWith(prefix.toLowerCase());
}

async function collectTextFiles(root) {
  const files = [];

  const walk = async (dir, depth) => {
    if (files.length >= MAX_SEARCH_FILES || depth > 12) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_SEARCH_FILES) return;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      try {
        const stat = await fsp.stat(fullPath);
        if (stat.size <= MAX_SEARCH_FILE_BYTES) files.push(fullPath);
      } catch {
        // 忽略无法读取的文件
      }
    }
  };

  await walk(root, 0);
  return files;
}

async function searchFiles(root, query) {
  const needle = String(query || '').trim();
  if (!needle) return { matches: [], truncated: false };

  const files = await collectTextFiles(root);
  const matches = [];
  let truncated = false;

  for (const file of files) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].toLowerCase().includes(needle.toLowerCase())) continue;
      matches.push({
        file: path.relative(root, file).replace(/\\/g, '/'),
        line: index + 1,
        snippet: lines[index].trim().slice(0, 220)
      });
      if (matches.length >= MAX_SEARCH_MATCHES) {
        truncated = true;
        return { matches, truncated };
      }
    }
  }

  return { matches, truncated };
}

async function readFile(root, relativePath) {
  const clean = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const realRoot = await fsp.realpath(root);
  const target = path.resolve(realRoot, clean);
  if (!isInside(realRoot, target)) throw new Error('文件不在当前打开的文件夹内');
  if (!TEXT_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    throw new Error('只能读取 Markdown/文本文件');
  }

  let realTarget;
  try {
    realTarget = await fsp.realpath(target);
  } catch {
    throw new Error('文件不存在');
  }
  if (!isInside(realRoot, realTarget)) throw new Error('文件不在当前打开的文件夹内');
  if (!TEXT_EXTENSIONS.has(path.extname(realTarget).toLowerCase())) {
    throw new Error('只能读取 Markdown/文本文件');
  }

  const stat = await fsp.stat(realTarget);
  if (!stat.isFile()) throw new Error('目标不是文件');
  if (stat.size > MAX_SEARCH_FILE_BYTES) throw new Error('文件太大，无法读取');

  const text = await fsp.readFile(realTarget, 'utf8');
  const truncated = text.length > MAX_READ_CHARS;
  return {
    path: path.relative(realRoot, realTarget).replace(/\\/g, '/'),
    content: truncated ? text.slice(0, MAX_READ_CHARS) : text,
    truncated
  };
}

function buildTools(ai, root) {
  const { tool } = ai;
  const tools = {};

  if (root) {
    tools.search_files = tool({
      description: '在当前打开的文件夹里搜索 Markdown/文本内容，返回文件路径、行号和匹配片段。',
      inputSchema: z.object({
        query: z.string().min(1).describe('要搜索的文字')
      }),
      execute: async ({ query }) => searchFiles(root, query)
    });

    tools.read_file = tool({
      description: '读取当前文件夹内的一个 Markdown/文本文件。path 使用相对路径，例如 notes/foo.md。',
      inputSchema: z.object({
        path: z.string().min(1).describe('相对当前文件夹的文件路径')
      }),
      execute: async ({ path: relativePath }) => readFile(root, relativePath)
    });
  }

  tools.propose_edit = tool({
    description: '提出一个局部修改建议。oldText 必须是当前文档中连续且唯一的原文；newText 是替换后的文字。不会直接写入文件。',
    inputSchema: z.object({
      oldText: z.string().min(1).describe('当前文档中要替换的原文，必须唯一'),
      newText: z.string().describe('替换后的文字，可以为空表示删除'),
      explanation: z.string().optional().describe('一句话说明修改理由')
    }),
    execute: async ({ oldText, newText, explanation }) => ({
      kind: 'edit',
      oldText,
      newText,
      explanation: explanation || ''
    })
  });

  tools.propose_document = tool({
    description: '提出整篇文档的新版本。适合大范围改写；content 是完整的 Markdown 新内容。不会直接写入文件。',
    inputSchema: z.object({
      content: z.string().min(1).describe('完整的修改后 Markdown 文档'),
      explanation: z.string().optional().describe('一句话说明修改理由')
    }),
    execute: async ({ content, explanation }) => ({
      kind: 'document',
      content,
      explanation: explanation || ''
    })
  });

  tools.propose_create_file = tool({
    description: '提出在当前文件夹新建一个 Markdown 文件。path 使用相对路径，content 是文件内容。不会直接写入文件。',
    inputSchema: z.object({
      path: z.string().min(1).describe('相对当前文件夹的新文件名，例如 会议纪要.md'),
      content: z.string().describe('文件内容'),
      explanation: z.string().optional().describe('一句话说明用途')
    }),
    execute: async ({ path: relativePath, content, explanation }) => {
      const clean = String(relativePath).replace(/\\/g, '/').replace(/^\/+/, '');
      if (!clean || clean.includes('..')) throw new Error('文件路径不合法');
      return {
        kind: 'create',
        path: clean,
        content,
        explanation: explanation || ''
      };
    }
  });

  return tools;
}

module.exports = {
  buildTools,
  searchFiles,
  readFile,
  collectTextFiles
};
