'use strict';

/**
 * Windows 文件关联（按当前用户注册，不需要管理员权限）。
 *
 * 全部写入 HKCU（HKEY_CURRENT_USER），不会修改系统级 HKLM，也不会碰
 * Windows 的 UserChoice（默认程序由用户亲自选择，系统不允许程序代改）。
 */

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_PROG_ID = 'ReadMD.md';
const DEFAULT_APP_KEY = 'Software\\ReadMD';
const DEFAULT_CLASSES_KEY = 'Software\\Classes';
const DEFAULT_REGISTERED_APPS_KEY = 'Software\\RegisteredApplications';
const DEFAULT_REGISTERED_APP_NAME = 'ReadMD';
const DEFAULT_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'];
const TYPE_DESCRIPTION = 'ReadMD Markdown 文档';
const APP_DESCRIPTION = '本地 Markdown 阅读与编辑工具';

const KNOWN_HANDLERS = new Map([
  ['typora.md', 'Typora'],
  ['vscode.md', 'Visual Studio Code'],
  ['applications\\code.exe', 'Visual Studio Code'],
  ['applications\\notepad.exe', '记事本'],
  ['applications\\wordpad.exe', '写字板'],
  ['applications\\obsidian.exe', 'Obsidian'],
  ['applications\\marktext.exe', 'MarkText'],
  ['applications\\typora.exe', 'Typora'],
  ['applications\\sublime_text.exe', 'Sublime Text'],
  ['applications\\atom.exe', 'Atom']
]);

function normalizeOptions(options = {}) {
  return {
    hive: options.hive || 'HKCU',
    progId: options.progId || DEFAULT_PROG_ID,
    appKey: options.appKey || DEFAULT_APP_KEY,
    classesKey: options.classesKey || DEFAULT_CLASSES_KEY,
    registeredAppsKey: options.registeredAppsKey || DEFAULT_REGISTERED_APPS_KEY,
    registeredAppName: options.registeredAppName || DEFAULT_REGISTERED_APP_NAME,
    extensions: Array.from(new Set((options.extensions || DEFAULT_EXTENSIONS).map((ext) => String(ext).toLowerCase()))),
    exePath: path.resolve(options.exePath || process.execPath),
    appPath: options.appPath ? path.resolve(options.appPath) : null,
    isPackaged: options.isPackaged !== false,
    portable: Boolean(options.portable)
  };
}

function isSupportedExtension(extension) {
  return DEFAULT_EXTENSIONS.includes(String(extension || '').toLowerCase());
}

function hiveKey(config, ...parts) {
  return [config.hive, ...parts].join('\\');
}

function progIdKey(config, ...parts) {
  return hiveKey(config, config.classesKey, config.progId, ...parts);
}

function openWithProgIdsKey(config, extension) {
  return hiveKey(config, config.classesKey, extension, 'OpenWithProgids');
}

function buildOpenCommand(config) {
  const exe = `"${config.exePath}"`;
  // 开发模式下 Electron 需要额外传入项目目录；打包后直接可执行文件 + 文件路径。
  if (!config.isPackaged && config.appPath) return `${exe} "${config.appPath}" "%1"`;
  return `${exe} "%1"`;
}

function normalizeCommand(command) {
  return String(command || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

async function runReg(args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync('reg.exe', args, {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024
    });
    return stdout;
  } catch (error) {
    if (allowFailure) return null;
    const detail = String(error.stderr || error.message || '').trim();
    throw new Error(detail ? `修改 Windows 文件关联失败：${detail}` : '修改 Windows 文件关联失败');
  }
}

async function addValue(keyPath, name, type, data) {
  const args = ['add', keyPath];
  if (name === null) args.push('/ve');
  else args.push('/v', name);
  args.push('/t', type);
  if (data !== undefined) args.push('/d', data);
  args.push('/f');
  await runReg(args);
}

async function deleteValue(keyPath, name) {
  await runReg(['delete', keyPath, '/v', name, '/f'], { allowFailure: true });
}

async function deleteKey(keyPath) {
  await runReg(['delete', keyPath, '/f'], { allowFailure: true });
}

/**
 * 读取注册表值。name 为 null 时读取默认值。
 * 返回 null 表示值或键不存在；空字符串表示值存在但内容为空。
 */
async function queryValue(keyPath, name = null) {
  const args = ['query', keyPath];
  if (name !== null) args.push('/v', name);
  // /ve 只取默认值。中文 Windows 会把默认值名称本地化成“(默认)”，
  // 所以这里不能按名称匹配，直接取返回行里的数据列。
  else args.push('/ve');
  const stdout = await runReg(args, { allowFailure: true });
  if (!stdout) return null;

  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s{2,}(.+?)\s{2,}(REG_[A-Z_]+)(?:\s{2,}(.*))?$/.exec(line);
    if (!match) continue;
    if (name === null) return match[3] ? match[3].trim() : '';
    if (match[1].trim().toLowerCase() === name.toLowerCase()) {
      return match[3] ? match[3].trim() : '';
    }
  }
  return null;
}

async function readDefaultProgId(extension = '.md') {
  return queryValue(
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\UserChoice`,
    'ProgId'
  );
}

function isReadMDProgId(progId, config) {
  if (!progId) return false;
  const value = String(progId).toLowerCase();
  if (value === config.progId.toLowerCase()) return true;
  // 用户可能通过“浏览”直接选择 exe，Windows 会写成 Applications\<exe 文件名>
  if (value.startsWith('applications\\')) {
    if (value.includes('readmd')) return true;
    const exeName = path.basename(config.exePath).toLowerCase();
    if (value === `applications\\${exeName}`) return true;
  }
  return false;
}

function describeHandler(progId) {
  if (!progId) return '尚未设置（Windows 会询问）';
  const value = String(progId);
  const known = KNOWN_HANDLERS.get(value.toLowerCase());
  if (known) return known;
  if (/^applications\\/i.test(value)) {
    const exe = value.split('\\').pop() || value;
    return exe.replace(/\.exe$/i, '');
  }
  return value;
}

async function getStatus(options = {}) {
  const config = normalizeOptions(options);
  if (process.platform !== 'win32') {
    return {
      supported: false,
      platform: process.platform,
      registered: false,
      commandMatches: false,
      isDefault: false,
      defaultProgId: null,
      handlerLabel: '仅支持 Windows',
      exePath: config.exePath,
      portable: config.portable,
      extensions: config.extensions
    };
  }

  const command = await queryValue(progIdKey(config, 'shell\\open\\command'));
  const registered = command !== null;
  const expectedCommand = buildOpenCommand(config);
  const defaultProgId = await readDefaultProgId('.md');
  const isDefault = isReadMDProgId(defaultProgId, config);

  return {
    supported: true,
    platform: 'win32',
    registered,
    commandMatches: registered && normalizeCommand(command) === normalizeCommand(expectedCommand),
    command,
    isDefault,
    defaultProgId,
    handlerLabel: isDefault ? 'ReadMD' : describeHandler(defaultProgId),
    exePath: config.exePath,
    portable: config.portable,
    extensions: config.extensions
  };
}

/**
 * 通知资源管理器刷新关联缓存。失败不影响注册结果，只是少数系统上
 * “打开方式”列表可能延后出现 ReadMD。
 */
function notifyShell() {
  try {
    const child = spawn('ie4uinit.exe', ['-show'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 忽略刷新失败
  }
}

async function register(options = {}) {
  const config = normalizeOptions(options);
  if (process.platform !== 'win32') throw new Error('文件关联设置目前仅支持 Windows');
  if (!fs.existsSync(config.exePath)) throw new Error('找不到 ReadMD 程序文件，无法注册文件关联');

  const command = buildOpenCommand(config);
  const capabilityKey = hiveKey(config, config.appKey, 'Capabilities');

  for (const extension of config.extensions) {
    // 只加入候选列表，不修改 .md 的默认值，也不碰 UserChoice。
    await addValue(openWithProgIdsKey(config, extension), config.progId, 'REG_NONE');
  }

  await addValue(progIdKey(config), null, 'REG_SZ', TYPE_DESCRIPTION);
  await addValue(progIdKey(config), 'FriendlyTypeName', 'REG_SZ', TYPE_DESCRIPTION);
  await addValue(progIdKey(config), 'FriendlyAppName', 'REG_SZ', 'ReadMD');
  await addValue(progIdKey(config, 'DefaultIcon'), null, 'REG_SZ', `"${config.exePath}",0`);
  await addValue(progIdKey(config, 'shell', 'open'), 'FriendlyAppName', 'REG_SZ', 'ReadMD');
  await addValue(progIdKey(config, 'shell', 'open', 'command'), null, 'REG_SZ', command);

  // “默认应用”设置页通过 Capabilities + RegisteredApplications 识别本应用。
  await addValue(capabilityKey, 'ApplicationName', 'REG_SZ', 'ReadMD');
  await addValue(capabilityKey, 'ApplicationDescription', 'REG_SZ', APP_DESCRIPTION);
  await addValue(capabilityKey, 'ApplicationIcon', 'REG_SZ', `"${config.exePath}",0`);
  for (const extension of config.extensions) {
    await addValue(`${capabilityKey}\\FileAssociations`, extension, 'REG_SZ', config.progId);
  }
  await addValue(
    hiveKey(config, config.registeredAppsKey),
    config.registeredAppName,
    'REG_SZ',
    `${config.appKey}\\Capabilities`
  );

  notifyShell();
  return getStatus(config);
}

async function unregister(options = {}) {
  const config = normalizeOptions(options);
  if (process.platform !== 'win32') throw new Error('文件关联设置目前仅支持 Windows');

  for (const extension of config.extensions) {
    await deleteValue(openWithProgIdsKey(config, extension), config.progId);
  }
  await deleteKey(progIdKey(config));
  await deleteKey(hiveKey(config, config.appKey));
  await deleteValue(hiveKey(config, config.registeredAppsKey), config.registeredAppName);

  notifyShell();
  // 不删除 UserChoice：默认程序由用户自己决定，系统也不允许程序代改。
  return getStatus(config);
}

function openWithDialog(filePath) {
  if (process.platform !== 'win32') throw new Error('文件关联设置目前仅支持 Windows');
  const resolved = path.resolve(String(filePath || ''));
  if (!fs.existsSync(resolved)) throw new Error('找不到用于设置关联的示例文件');

  const child = spawn('rundll32.exe', ['shell32.dll,OpenAs_RunDLL', resolved], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.on('error', () => {});
  child.unref();
  return true;
}

module.exports = {
  DEFAULT_EXTENSIONS,
  DEFAULT_PROG_ID,
  buildOpenCommand,
  describeHandler,
  getStatus,
  isSupportedExtension,
  openWithDialog,
  register,
  unregister
};
