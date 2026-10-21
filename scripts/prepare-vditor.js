/**
 * 把 Vditor 的 dist 复制到 renderer/vendor，保证应用离线可用。
 * 仅依赖 Node 内置模块，postinstall 时自动执行。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'node_modules', 'vditor', 'dist');
const targetRoot = path.join(root, 'renderer', 'vendor', 'vditor');

if (!fs.existsSync(source)) {
  console.error('[prepare-vditor] 找不到 node_modules/vditor/dist，请先执行 npm install');
  process.exit(1);
}

fs.rmSync(targetRoot, { recursive: true, force: true });
fs.mkdirSync(targetRoot, { recursive: true });
fs.cpSync(source, path.join(targetRoot, 'dist'), { recursive: true });

const license = path.join(root, 'node_modules', 'vditor', 'LICENSE');
if (fs.existsSync(license)) {
  fs.copyFileSync(license, path.join(targetRoot, 'LICENSE'));
}

console.log('[prepare-vditor] Vditor 离线资源已复制到 renderer/vendor/vditor');
