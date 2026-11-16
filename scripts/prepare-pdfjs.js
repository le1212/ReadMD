/**
 * 把 pdf.js 的运行时文件复制到 renderer/vendor，保证离线可用。
 * 仅复制渲染所需的最小集合：主模块、Worker、CMaps、标准字体、WASM 解码器与许可证。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'node_modules', 'pdfjs-dist');
const targetRoot = path.join(root, 'renderer', 'vendor', 'pdfjs');

if (!fs.existsSync(sourceRoot)) {
  console.error('[prepare-pdfjs] 找不到 node_modules/pdfjs-dist，请先执行 npm install');
  process.exit(1);
}

if (fs.existsSync(targetRoot)) {
  fs.rmSync(targetRoot, { recursive: true, force: true });
}
fs.mkdirSync(targetRoot, { recursive: true });

const copyFile = (from, to) => {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
};

copyFile(path.join(sourceRoot, 'build', 'pdf.min.mjs'), path.join(targetRoot, 'pdf.min.mjs'));
copyFile(path.join(sourceRoot, 'build', 'pdf.worker.min.mjs'), path.join(targetRoot, 'pdf.worker.min.mjs'));
copyFile(path.join(sourceRoot, 'LICENSE'), path.join(targetRoot, 'LICENSE'));

for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const source = path.join(sourceRoot, dir);
  if (fs.existsSync(source)) {
    fs.cpSync(source, path.join(targetRoot, dir), { recursive: true });
  }
}

console.log('[prepare-pdfjs] pdf.js 离线资源已复制到 renderer/vendor/pdfjs');
