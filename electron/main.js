'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  nativeTheme
} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildExportHtml } = require('./export/html');
const { renderPdfFromPayload } = require('./export/pdf');
const { defaultAIState, normalizeAIState } = require('./ai/config');
const { registerAIHandlers } = require('./ai/ipc');
const fileAssociation = require('./file-association');

const APP_NAME = 'ReadMD';
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt', '.text']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const MAX_FILE_SIZE = 32 * 1024 * 1024;
const MAX_IMAGE_SIZE = 25 * 1024 * 1024;
const IS_SMOKE_TEST = process.argv.includes('--smoke-test');

/**
 * 当前可执行文件信息。便携版解压后 process.execPath 指向临时目录，
 * 必须优先使用 electron-builder 提供的 PORTABLE_EXECUTABLE_FILE。
 */
function getExecutableInfo() {
  const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
  const hasPortableFile = Boolean(portableFile && fs.existsSync(portableFile));
  return {
    exePath: hasPortableFile ? portableFile : process.execPath,
    appPath: path.join(__dirname, '..'),
    isPackaged: app.isPackaged,
    portable: hasPortableFile
  };
}

if (IS_SMOKE_TEST) {
  app.setPath('userData', path.join(os.tmpdir(), `readmd-smoke-${process.pid}-${Date.now()}`));
}

const defaultState = {
  windowBounds: null,
  lastFolder: null,
  recentFolders: [],
  recentFiles: [],
  openFiles: [],
  activeFile: null,
  theme: 'light',
  sidebarVisible: true,
  sidebarWidth: 278,
  editorContentWidth: 920,
  outlineWidth: 230,
  exportSettings: {
    formal: false,
    header: false,
    footer: true,
    cover: false,
    toc: false,
    coverSubtitle: '',
    coverAuthor: ''
  },
  ai: defaultAIState()
};

let mainWindow = null;
let stateFile = null;
let appState = { ...defaultState };
let allowClose = false;
let rendererDirty = false;
let rendererReady = false;
let pendingOpenPaths = null;
let boundsTimer = null;

/** 允许读写的根目录（真实路径、统一小写、正斜杠） */
const allowedRoots = new Set();
/** 允许读写的单个文件（真实路径、统一小写、正斜杠） */
const allowedFiles = new Set();
/** 用户主动选择过的批量导出目录 */
const allowedExportDirs = new Set();
const EXPORT_FORMATS = new Set(['docx', 'pdf', 'html']);
const MAX_BATCH_FILES = 300;
const MAX_BATCH_DEPTH = 20;
const SKIP_BATCH_DIRS = new Set(['node_modules', '.git', '.svn']);

function normalizeKey(targetPath) {
  return path.resolve(targetPath).replace(/\\/g, '/').toLowerCase();
}

async function realKey(targetPath) {
  const resolved = path.resolve(targetPath);
  try {
    return normalizeKey(await fsp.realpath(resolved));
  } catch {
    return normalizeKey(resolved);
  }
}

async function realKeyForWrite(targetPath) {
  const resolved = path.resolve(targetPath);
  try {
    return normalizeKey(await fsp.realpath(resolved));
  } catch {
    const parentKey = await realKey(path.dirname(resolved));
    return `${parentKey.replace(/\/$/, '')}/${path.basename(resolved).toLowerCase()}`;
  }
}

async function addRoot(targetPath) {
  if (!targetPath) return;
  allowedRoots.add(await realKey(targetPath));
}

async function addFile(targetPath) {
  if (!targetPath) return;
  allowedFiles.add(await realKeyForWrite(targetPath));
}

async function assertAllowed(targetPath) {
  const key = await realKeyForWrite(targetPath);
  if (allowedFiles.has(key)) return key;
  for (const root of allowedRoots) {
    const prefix = root.replace(/\/$/, '');
    if (key === prefix || key.startsWith(`${prefix}/`)) return key;
  }
  throw new Error('没有权限访问该路径。请先打开它所在的文件夹或文件。');
}

async function canReadDirectory(targetPath) {
  try {
    await assertAllowed(targetPath);
    return true;
  } catch {
    // 单独打开的文件只登记了文件本身，导出时允许读取它所在目录
  }
  const key = await realKey(targetPath);
  for (const fileKey of allowedFiles) {
    if (path.dirname(fileKey) === key) return true;
  }
  return false;
}

function normalizeExportSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    formal: Boolean(source.formal),
    header: Boolean(source.header),
    footer: source.footer !== false,
    cover: Boolean(source.cover),
    toc: Boolean(source.toc),
    coverSubtitle: String(source.coverSubtitle || '').trim().slice(0, 120),
    coverAuthor: String(source.coverAuthor || '').trim().slice(0, 80)
  };
}

function readState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    const state = { ...defaultState, ...parsed };
    state.exportSettings = normalizeExportSettings(state.exportSettings);
    state.ai = normalizeAIState(state.ai);
    return state;
  } catch {
    return {
      ...defaultState,
      exportSettings: normalizeExportSettings(defaultState.exportSettings),
      ai: normalizeAIState(defaultState.ai)
    };
  }
}

function persistState() {
  if (!stateFile) return;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(appState, null, 2), 'utf8');
  } catch (error) {
    console.error('[ReadMD] 保存状态失败', error);
  }
}

function rememberFolder(folder) {
  if (!folder) return;
  appState.lastFolder = folder;
  appState.recentFolders = [folder, ...(appState.recentFolders || []).filter((item) => item !== folder)].slice(0, 8);
  persistState();
}

function rememberFile(filePath) {
  if (!filePath) return;
  appState.recentFiles = [filePath, ...(appState.recentFiles || []).filter((item) => item !== filePath)].slice(0, 8);
  persistState();
}

async function atomicWrite(filePath, data) {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.readmd-${process.pid}-${Date.now()}.tmp`);
  await fsp.writeFile(temp, data, 'utf8');
  try {
    await fsp.rename(temp, filePath);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES') {
      await fsp.rm(filePath, { force: true });
      await fsp.rename(temp, filePath);
    } else {
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }
}

function validateEntryName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('名称不能为空');
  if (trimmed === '.' || trimmed === '..') throw new Error('名称不合法');
  if (/[\\/:*?"<>|]/.test(trimmed)) throw new Error('名称不能包含 \\ / : * ? " < > |');
  if (trimmed.length > 120) throw new Error('名称太长（最多 120 个字符）');
  return trimmed;
}

function ensureMarkdownName(name) {
  const validated = validateEntryName(name);
  return path.extname(validated) ? validated : `${validated}.md`;
}

function safeImageName(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const finalExt = IMAGE_EXTENSIONS.has(ext) ? ext : '.png';
  const stem = path
    .basename(originalName || 'image', ext)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'image';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${stem}-${stamp}-${random}${finalExt}`;
}

function markdownFileInfo(filePath, stat) {
  return {
    path: filePath,
    name: path.basename(filePath),
    dirUrl: `${pathToFileURL(path.dirname(filePath)).href}/`,
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

async function readMarkdownFile(filePath) {
  await assertAllowed(filePath);
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw new Error('这不是一个文件');
  if (stat.size > MAX_FILE_SIZE) throw new Error('文件超过 32 MB，暂不支持打开');
  const buffer = await fsp.readFile(filePath);
  if (buffer.includes(0)) throw new Error('这看起来是二进制文件，无法作为 Markdown 打开');
  let content = buffer.toString('utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  await addFile(filePath);
  return {
    ...markdownFileInfo(filePath, stat),
    content,
    eol
  };
}

function createWindow() {
  const saved = appState.windowBounds;
  const bounds = saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)
    ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
    : { width: 1280, height: 840 };

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: appState.theme === 'dark' ? '#1e1e1e' : '#ffffff',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (IS_SMOKE_TEST) runSmokeTest();
  });

  mainWindow.on('resize', scheduleBoundsSave);
  mainWindow.on('move', scheduleBoundsSave);

  mainWindow.on('close', (event) => {
    if (allowClose) {
      persistWindowBounds();
      return;
    }
    event.preventDefault();
    if (!rendererDirty) {
      allowClose = true;
      mainWindow.close();
      return;
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: '还有未保存的修改',
      message: '有文件尚未保存，确定要关闭 ReadMD 吗？',
      detail: '选择“保存并关闭”会把所有修改写回原文件。',
      buttons: ['保存并关闭', '不保存，直接关闭', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    });
    if (choice === 0) {
      mainWindow.webContents.send('app:save-and-close');
    } else if (choice === 1) {
      allowClose = true;
      mainWindow.close();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (url !== current) {
      event.preventDefault();
      if (/^(https?:|mailto:)/i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  mainWindow.webContents.on('found-in-page', (_event, result) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('find:result', result);
    }
  });

  mainWindow.webContents.on('console-message', (details) => {
    if (!details || typeof details !== 'object') return;
    if (IS_SMOKE_TEST || details.level === 'warning' || details.level === 'error') {
      console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
    }
  });
}

function scheduleBoundsSave() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(persistWindowBounds, 300);
}

function persistWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized() || mainWindow.isMinimized()) return;
  appState.windowBounds = mainWindow.getBounds();
  persistState();
}

function buildMenu() {
  const send = (command) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('menu:command', command);
    }
  };

  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开文件…', accelerator: 'CmdOrCtrl+O', click: () => send('open-file') },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('open-folder') },
        { type: 'separator' },
        { label: '新建文件…', accelerator: 'CmdOrCtrl+N', click: () => send('new-file') },
        { label: '插入图片…', click: () => send('insert-image') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
        { type: 'separator' },
        { label: '关闭当前标签', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
        { label: '刷新文件树', accelerator: 'F5', click: () => send('refresh-tree') },
        { type: 'separator' },
        { label: '导出 Word 文档…', click: () => send('export-docx') },
        { label: '导出 PDF…', click: () => send('export-pdf') },
        { label: '导出 HTML…', click: () => send('export-html') },
        { label: '导出设置…', click: () => send('export-settings') },
        { label: '批量导出当前文件夹…', click: () => send('export-batch') },
        { type: 'separator' },
        ...(process.platform === 'win32'
          ? [
            { label: '设为默认 Markdown 打开方式…', click: () => send('default-app') },
            { type: 'separator' }
          ]
          : []),
        { label: '退出', accelerator: 'Alt+F4', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '查找', accelerator: 'CmdOrCtrl+F', click: () => send('find') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '显示/隐藏侧边栏', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('toggle-sidebar') },
        { label: '切换深色模式', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('toggle-theme') },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '实际大小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: 'AI',
      submenu: [
        { label: '打开/关闭 AI 助手', accelerator: 'CmdOrCtrl+J', click: () => send('toggle-ai') },
        { label: 'AI 设置…', click: () => send('ai-settings') }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 ReadMD',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: `关于 ${APP_NAME}`,
              message: `${APP_NAME} ${app.getVersion()}`,
              detail: `本地 Markdown 阅读与编辑工具\n\n编辑器内核：Vditor 4.0.1（MIT）\n运行时：Electron ${process.versions.electron}\n\n所有文档都以普通 Markdown 文件保存在你的磁盘上。`,
              buttons: ['好的'],
              noLink: true
            });
          }
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const files = findMarkdownArguments(argv);
    if (files.length) openPathsFromSystem(files);
  });
}

function findMarkdownArguments(argv) {
  const files = [];
  const seen = new Set();
  for (let i = 1; i < argv.length; i += 1) {
    const candidate = argv[i];
    if (!candidate) continue;
    if (!MARKDOWN_EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue;
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const resolved = path.resolve(candidate);
      const key = normalizeKey(resolved);
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(resolved);
    } catch {
      // 忽略不存在的参数
    }
  }
  return files;
}

function mergeOpenPayloads(base, extra) {
  if (!base) return extra;
  if (!extra) return base;
  const files = [];
  const seen = new Set();
  for (const file of [...(base.files || []), ...(extra.files || [])]) {
    if (!file) continue;
    const key = normalizeKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(file);
  }
  return { ...base, ...extra, files };
}

async function openPathsFromSystem(filePaths) {
  try {
    const resolvedFiles = [];
    for (const filePath of filePaths) {
      if (!filePath) continue;
      const resolved = path.resolve(filePath);
      await addRoot(path.dirname(resolved));
      await addFile(resolved);
      rememberFile(resolved);
      resolvedFiles.push(resolved);
    }
    if (!resolvedFiles.length) return;

    if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
      mainWindow.webContents.send('app:open-paths', { files: resolvedFiles });
    } else {
      pendingOpenPaths = mergeOpenPayloads(pendingOpenPaths, { files: resolvedFiles });
    }
  } catch (error) {
    console.error('[ReadMD] 打开系统文件失败', error);
  }
}

// 冒烟测试夹具在运行时生成，仓库中不保存任何测试数据。
const SMOKE_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=';

const SMOKE_SAMPLE_MARKDOWN = [
  '# 欢迎使用 ReadMD',
  '',
  '![ReadMD](assets/smoke-image.png)',
  '',
  '> ReadMD 让本地 Markdown 阅读更轻松。',
  '',
  '## 功能列表',
  '',
  '- 本地文件优先',
  '- 即时渲染编辑',
  '- 自动保存，支持**加粗**与`行内代码`',
  '',
  '公式：$E=mc^2$',
  '',
  '## 快捷键',
  '',
  '| 快捷键 | 功能 |',
  '| --- | --- |',
  '| Ctrl+S | 保存 |',
  '',
  '```js',
  "console.log('hello');",
  '```',
  '',
].join('\n');

function runSmokeTest() {
  const sampleDir = path.join(os.tmpdir(), `readmd-smoke-sample-${process.pid}`);
  const sampleFile = path.join(sampleDir, '欢迎使用 ReadMD.md');
  fs.rmSync(sampleDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(sampleDir, 'assets'), { recursive: true });
  fs.writeFileSync(sampleFile, SMOKE_SAMPLE_MARKDOWN, 'utf8');
  fs.writeFileSync(path.join(sampleDir, 'assets', 'smoke-image.png'), Buffer.from(SMOKE_IMAGE_BASE64, 'base64'));

  const screenshotDir = app.isPackaged
    ? path.join(os.tmpdir(), 'readmd-smoke-shots')
    : path.join(__dirname, '..', 'docs', 'screenshots');
  const failures = [];
  console.log('[smoke] executable info', JSON.stringify(getExecutableInfo()));

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = (script) => mainWindow.webContents.executeJavaScript(script);
  const capture = async () => {
    mainWindow.webContents.invalidate();
    await wait(180);
    return mainWindow.webContents.capturePage();
  };

  (async () => {
    try {
      await addRoot(sampleDir);
      await addFile(sampleFile);
      fs.mkdirSync(screenshotDir, { recursive: true });
      await wait(1500);
      const welcomeImage = await capture();
      const welcomeShot = path.join(screenshotDir, 'smoke-welcome.png');
      fs.writeFileSync(welcomeShot, welcomeImage.toPNG());
      console.log(`[ReadMD] 欢迎页截图已保存: ${welcomeShot}`);

      const smokePayload = { folder: sampleDir, files: [sampleFile] };
      if (rendererReady) {
        mainWindow.webContents.send('app:open-paths', smokePayload);
      } else {
        pendingOpenPaths = smokePayload;
      }
      await wait(5000);

      const diagnostics = await run('window.__readmdSmoke.diagnostics()');
      console.log('[smoke] diagnostics', JSON.stringify(diagnostics));

      if (!diagnostics || diagnostics.tabs < 1) failures.push('文档标签未打开');
      if (!diagnostics || diagnostics.treeRows < 2) failures.push('文件树未加载');
      if (!diagnostics || diagnostics.outlineItems < 1) failures.push('大纲未生成');
      if (!diagnostics || diagnostics.toolbarItems < 10) failures.push('工具栏未生成');
      if (!diagnostics || !diagnostics.exportButton) failures.push('缺少导出按钮');
      if (!diagnostics || diagnostics.toolbarTitled < diagnostics.toolbarButtons) failures.push('工具栏悬浮提示缺失');
      if (!diagnostics || diagnostics.outlineTitled < diagnostics.outlineSpans) failures.push('大纲悬浮提示缺失');
      if (!diagnostics || diagnostics.imageWidth <= 0) failures.push('相对路径图片未加载');
      if (!diagnostics || !diagnostics.editorReady) failures.push('编辑器未就绪');
      if (!diagnostics || !diagnostics.imageToolbarButton) failures.push('编辑器工具栏缺少图片按钮');
      if (!diagnostics || !diagnostics.imageToolbarInput) failures.push('图片按钮缺少文件选择输入框');

      fs.mkdirSync(screenshotDir, { recursive: true });
      const image = await capture();
      const lightShot = path.join(screenshotDir, 'smoke-light.png');
      fs.writeFileSync(lightShot, image.toPNG());
      console.log(`[ReadMD] 冒烟截图已保存: ${lightShot}`);

      await run("window.__readmdSmokeTheme && window.__readmdSmokeTheme('dark')");
      await wait(1800);
      const darkImage = await capture();
      const darkShot = path.join(screenshotDir, 'smoke-dark.png');
      fs.writeFileSync(darkShot, darkImage.toPNG());
      console.log(`[ReadMD] 深色截图已保存: ${darkShot}`);

      await run("window.__readmdSmokeTheme && window.__readmdSmokeTheme('light')");
      await wait(600);
      mainWindow.maximize();
      await wait(800);
      const maximizedLayout = await run('window.__readmdSmoke.layout()');
      console.log('[smoke] layout maximized', JSON.stringify(maximizedLayout));
      if (!maximizedLayout || !maximizedLayout.reset || !maximizedLayout.ir) {
        failures.push('未找到全屏正文布局');
      } else {
        const reset = maximizedLayout.reset;
        const ir = maximizedLayout.ir;
        const leftGap = reset.x - ir.x;
        const rightGap = (ir.x + ir.w) - (reset.x + reset.w);
        const padLeft = parseFloat(reset.paddingLeft);
        const padRight = parseFloat(reset.paddingRight);
        if (Math.abs(leftGap - rightGap) > 2) failures.push('全屏正文未水平居中');
        if (reset.w < ir.w * 0.95) failures.push('全屏正文没有自适应宽度');
        if (Math.abs(padLeft - padRight) > 2) failures.push('全屏正文左右留白不一致');
        console.log('[smoke] layout check', JSON.stringify({
          leftGap,
          rightGap,
          padLeft,
          padRight,
          resetWidth: reset.w,
          irWidth: ir.w
        }));
      }

      await run('window.__readmdSmoke.setContentWidth(1100)');
      await wait(250);
      const wideWidthState = await run('window.__readmdSmoke.diagnostics()');
      if (!wideWidthState || wideWidthState.editorContentWidth !== 1100) {
        failures.push('正文宽度调整无效');
      }
      await run('window.__readmdSmoke.setContentWidth(920)');

      await run('window.__readmdSmoke.setSidebarWidth(320)');
      await wait(300);
      const wideSidebar = await run('window.__readmdSmoke.layout()');
      if (!wideSidebar || !wideSidebar.sidebar || wideSidebar.sidebar.w !== 320) {
        failures.push('侧边栏宽度调整无效');
      }
      await run('window.__readmdSmoke.setSidebarWidth(278)');
      await wait(350);

      await run('window.__readmdSmoke.setContentWidth(1100)');
      const draggedContentWidth = await run('window.__readmdSmoke.dragContentWidth(-60)');
      if (!(draggedContentWidth < 1100)) failures.push('正文宽度拖拽手柄无效');
      await run('window.__readmdSmoke.setContentWidth(920)');
      await wait(200);

      const draggedSidebarWidth = await run('window.__readmdSmoke.dragSidebarWidth(40)');
      if (!(draggedSidebarWidth > 278)) failures.push('侧边栏拖拽手柄无效');
      await run('window.__readmdSmoke.setSidebarWidth(278)');
      await wait(350);

      await run('window.__readmdSmoke.setOutlineWidth(300)');
      await wait(300);
      const outlineSet = await run('window.__readmdSmoke.layout()');
      if (!outlineSet || !outlineSet.outline || outlineSet.outline.w !== 300) {
        failures.push('大纲宽度调整无效');
      }
      const draggedOutlineWidth = await run('window.__readmdSmoke.dragOutlineWidth(-40)');
      if (!(draggedOutlineWidth > 300)) failures.push('大纲宽度拖拽手柄无效');
      await run('window.__readmdSmoke.setOutlineWidth(230)');
      await wait(350);

      const fullscreenImage = await capture();
      const fullscreenShot = path.join(screenshotDir, 'smoke-fullscreen.png');
      fs.writeFileSync(fullscreenShot, fullscreenImage.toPNG());
      console.log(`[ReadMD] 全屏截图已保存: ${fullscreenShot}`);

      mainWindow.unmaximize();
      await wait(500);

      const findResult = await run("window.__readmdSmoke.find('ReadMD')");
      if (!findResult || !findResult.matches) failures.push('查找没有匹配结果');
      console.log('[smoke] find test', JSON.stringify(findResult));

      const exportPayload = await run('window.__readmdSmoke.exportPayload()');
      const exportHtml = await run('window.__readmdSmoke.exportHtmlString()');
      if (!exportHtml || !exportHtml.includes('<html') || !exportHtml.includes('readmd-doc') || !exportHtml.includes('line-height: 1.8')) {
        failures.push('HTML 导出内容不完整');
      }
      if (!exportPayload || !exportPayload.html || !exportPayload.html.includes('欢迎使用 ReadMD')) {
        failures.push('导出载荷不完整');
      }
      console.log('[smoke] export html length', exportHtml ? exportHtml.length : 0);

      const forbiddenDir = path.join(os.tmpdir(), `readmd-forbidden-${process.pid}`);
      fs.mkdirSync(forbiddenDir, { recursive: true });
      const exportGuard = await run(`window.readmd.exportHtmlString({
        html: '<p>guard</p>',
        title: 'guard',
        baseDir: ${JSON.stringify(forbiddenDir)}
      }).then(() => ({ ok: true })).catch((error) => ({ ok: false, message: error.message }))`);
      fs.rmSync(forbiddenDir, { recursive: true, force: true });
      console.log('[smoke] export dir guard', JSON.stringify(exportGuard));
      if (!exportGuard || exportGuard.ok || !/导出目录未授权/.test(exportGuard.message || '')) {
        failures.push('导出目录越权未拦截');
      }

      const { collectImages } = require('./export/images');
      const remoteGuard = await collectImages('<img src="http://127.0.0.1:9/x.png">', sampleDir);
      if (remoteGuard.images.size || !remoteGuard.notes.some((note) => /https/.test(note))) {
        failures.push('导出网络图片 http 限制失效');
      }
      const forbiddenImage = path.join(os.tmpdir(), `readmd-forbidden-${process.pid}.png`);
      fs.copyFileSync(path.join(__dirname, '..', 'docs', 'assets', 'logo.png'), forbiddenImage);
      const localGuard = await collectImages(
        `<img src="${pathToFileURL(forbiddenImage).href}">`,
        sampleDir
      );
      fs.rmSync(forbiddenImage, { force: true });
      if (localGuard.images.size || !localGuard.notes.some((note) => /不在文档目录/.test(note))) {
        failures.push('导出本地图片越界未拦截');
      }

      if (exportPayload) {
        const pdfPath = path.join(os.tmpdir(), `readmd-smoke-${process.pid}.pdf`);
        try {
          const pdfResult = await run(`window.readmd.exportPdfTest(${JSON.stringify(exportPayload)}, ${JSON.stringify(pdfPath)})`);
          const pdfBytes = fs.readFileSync(pdfPath);
          if (pdfBytes.subarray(0, 5).toString() !== '%PDF-' || pdfBytes.length < 1000) {
            failures.push('PDF 导出结果无效');
          }
          console.log('[smoke] pdf test', JSON.stringify({
            bytes: pdfBytes.length,
            header: pdfBytes.subarray(0, 5).toString(),
            result: pdfResult
          }));
        } catch (error) {
          failures.push(`PDF 导出失败：${error.message || error}`);
        } finally {
          fs.rmSync(pdfPath, { force: true });
        }

        const docxPath = path.join(os.tmpdir(), `readmd-smoke-${process.pid}.docx`);
        try {
          const docxResult = await run(`window.readmd.exportDocxTest(${JSON.stringify(exportPayload)}, ${JSON.stringify(docxPath)})`);
          const docxBytes = fs.readFileSync(docxPath);
          if (docxBytes.subarray(0, 2).toString() !== 'PK' || docxBytes.length < 5000) {
            failures.push('Word 导出结果无效');
          }

          const JSZip = require('jszip');
          const zip = await JSZip.loadAsync(docxBytes);
          const docXml = await zip.file('word/document.xml').async('string');
          const stylesXml = await zip.file('word/styles.xml').async('string');
          const footerXml = zip.file('word/footer1.xml')
            ? await zip.file('word/footer1.xml').async('string')
            : '';

          const checks = {
            title: docXml.includes('欢迎使用 ReadMD'),
            bodyFont: stylesXml.includes('w:eastAsia="宋体"'),
            headingFont: stylesXml.includes('w:eastAsia="黑体"'),
            lineSpacing: stylesXml.includes('w:line="360"'),
            characterSpacing: stylesXml.includes('w:spacing w:val="4"'),
            quoteStyle: docXml.includes('w:pStyle w:val="Quote"'),
            codeStyle: docXml.includes('w:pStyle w:val="SourceCode"'),
            tableHeader: docXml.includes('w:tblHeader'),
            image: docXml.includes('w:drawing'),
            math: docXml.includes('m:oMath'),
            pageNumbers: footerXml.includes('PAGE') && footerXml.includes('NUMPAGES')
          };
          for (const [key, ok] of Object.entries(checks)) {
            if (!ok) failures.push(`Word 导出缺少 ${key}`);
          }
          console.log('[smoke] docx test', JSON.stringify({
            bytes: docxBytes.length,
            warnings: docxResult && docxResult.warnings,
            checks
          }));
        } catch (error) {
          failures.push(`Word 导出失败：${error.message || error}`);
        } finally {
          fs.rmSync(docxPath, { force: true });
        }
      }

      // 完整导出设置：正式排版 + 页眉页脚 + 封面 + 目录
      const fullSettingsPayload = await run(`window.__readmdSmoke.exportPayload(${JSON.stringify({
        formal: true,
        header: true,
        footer: true,
        cover: true,
        toc: true,
        coverSubtitle: '排版规范与批量导出',
        coverAuthor: 'ReadMD'
      })})`);
      if (!fullSettingsPayload) failures.push('完整导出设置载荷生成失败');

      if (fullSettingsPayload) {
        const fullHtml = await run(`window.readmd.exportHtmlString(${JSON.stringify(fullSettingsPayload)})`);
        const htmlChecks = {
          cover: fullHtml.includes('readmd-cover'),
          toc: fullHtml.includes('readmd-toc'),
          indent: fullHtml.includes('text-indent: 2em')
        };
        for (const [key, ok] of Object.entries(htmlChecks)) {
          if (!ok) failures.push(`完整设置 HTML 缺少 ${key}`);
        }

        const fullDocxPath = path.join(os.tmpdir(), `readmd-smoke-full-${process.pid}.docx`);
        try {
          await run(`window.readmd.exportDocxTest(${JSON.stringify(fullSettingsPayload)}, ${JSON.stringify(fullDocxPath)})`);
          const fullBytes = fs.readFileSync(fullDocxPath);
          const JSZip = require('jszip');
          const zip = await JSZip.loadAsync(fullBytes);
          const docXml = await zip.file('word/document.xml').async('string');
          const headerXml = zip.file('word/header1.xml')
            ? await zip.file('word/header1.xml').async('string')
            : '';
          const footerXml = zip.file('word/footer1.xml')
            ? await zip.file('word/footer1.xml').async('string')
            : '';

          const checks = {
            coverTitle: docXml.includes('欢迎使用 ReadMD'),
            coverSubtitle: docXml.includes('排版规范与批量导出'),
            coverAuthor: docXml.includes('ReadMD'),
            tocField: docXml.includes('TOC') && docXml.includes('TOC1'),
            pageBreak: docXml.includes('w:br w:type="page"'),
            firstLine: docXml.includes('w:ind w:firstLine="480"'),
            header: headerXml.includes('欢迎使用 ReadMD'),
            footer: footerXml.includes('PAGE') && footerXml.includes('NUMPAGES')
          };
          for (const [key, ok] of Object.entries(checks)) {
            if (!ok) failures.push(`完整设置 Word 缺少 ${key}`);
          }
          console.log('[smoke] full docx test', JSON.stringify({ bytes: fullBytes.length, checks }));
        } catch (error) {
          failures.push(`完整设置 Word 导出失败：${error.message || error}`);
        } finally {
          fs.rmSync(fullDocxPath, { force: true });
        }

        const fullPdfPath = path.join(os.tmpdir(), `readmd-smoke-full-${process.pid}.pdf`);
        try {
          await run(`window.readmd.exportPdfTest(${JSON.stringify(fullSettingsPayload)}, ${JSON.stringify(fullPdfPath)})`);
          const fullPdf = fs.readFileSync(fullPdfPath);
          const countMatch = fullPdf.toString('latin1').match(/\/Count (\d+)/);
          const pages = countMatch ? Number(countMatch[1]) : 0;
          if (fullPdf.subarray(0, 5).toString() !== '%PDF-' || pages < 3) {
            failures.push('完整设置 PDF 页数不正确');
          }
          console.log('[smoke] full pdf test', JSON.stringify({ bytes: fullPdf.length, pages }));
        } catch (error) {
          failures.push(`完整设置 PDF 导出失败：${error.message || error}`);
        } finally {
          fs.rmSync(fullPdfPath, { force: true });
        }
      }

      // 批量导出：文件列表、Markdown 渲染、相对子目录写入
      const batchRoot = path.join(os.tmpdir(), `readmd-batch-src-${process.pid}`);
      const batchSecond = path.join(batchRoot, '批量第二篇.md');
      const batchOut = path.join(os.tmpdir(), `readmd-batch-out-${process.pid}`);
      try {
        fs.mkdirSync(batchRoot, { recursive: true });
        fs.writeFileSync(batchSecond, '# 批量第二篇\n\n用于验证批量导出。\n', 'utf8');
        await addRoot(batchRoot);
        await addFile(batchSecond);
        await run(`window.readmd.exportAuthorizeTestFolder(${JSON.stringify(batchOut)})`);
        fs.mkdirSync(batchOut, { recursive: true });

        const listing = await run(`window.readmd.listMarkdownFiles(${JSON.stringify(batchRoot)})`);
        if (!listing || listing.files.length < 1) failures.push('批量导出文件列表为空');

        const md2html = await run('window.__readmdSmoke.md2htmlTest()');
        if (!md2html || !md2html.includes('批量导出标题')) failures.push('批量 Markdown 渲染失败');

        const batchPayload = await run('window.__readmdSmoke.exportPayload()');
        const batchItem = await run(`window.readmd.exportBatchItem('docx', ${JSON.stringify(batchPayload)}, ${JSON.stringify(batchOut)}, '子目录/批量第二篇.md')`);
        const batchFile = path.join(batchOut, '子目录', '批量第二篇.docx');
        if (!fs.existsSync(batchFile) || fs.readFileSync(batchFile).subarray(0, 2).toString() !== 'PK') {
          failures.push('批量导出 Word 文件无效');
        }

        const batchLoop = await run(`window.__readmdSmoke.batchExportTest(${JSON.stringify(batchRoot)}, ${JSON.stringify(batchOut)}, 'docx')`);
        const loopFile = path.join(batchOut, '批量第二篇.docx');
        if (!batchLoop || batchLoop.done !== 1 || batchLoop.failed !== 0 || !fs.existsSync(loopFile)) {
          failures.push('批量导出流程失败');
        }
        console.log('[smoke] batch test', JSON.stringify({
          files: listing && listing.files.length,
          item: batchItem,
          loop: batchLoop
        }));
      } catch (error) {
        failures.push(`批量导出测试失败：${error.message || error}`);
      } finally {
        fs.rmSync(batchRoot, { recursive: true, force: true });
        fs.rmSync(batchOut, { recursive: true, force: true });
      }

      // 导出设置持久化与默认值
      await run(`window.readmd.saveState({ exportSettings: { formal: true } })`);
      const savedExportState = await run('window.readmd.init()');
      if (!savedExportState
        || !savedExportState.state.exportSettings.formal
        || savedExportState.state.exportSettings.footer !== true) {
        failures.push('导出设置未保存');
      }
      await run(`window.readmd.saveState({ exportSettings: { formal: false, header: false, footer: true, cover: false, toc: false, coverSubtitle: '', coverAuthor: '' } })`);

      // 设置面板截图
      const settingsOpened = await run('window.__readmdSmoke.openExportSettingsTest()');
      if (!settingsOpened) failures.push('导出设置面板未打开');
      await wait(250);
      const settingsShot = path.join(screenshotDir, 'smoke-export-settings.png');
      const settingsImage = await capture();
      fs.writeFileSync(settingsShot, settingsImage.toPNG());
      const closeModalResult = await run('window.__readmdSmoke.closeModalTest()');
      await wait(150);
      console.log('[ReadMD] 导出设置截图已保存:', settingsShot, JSON.stringify(closeModalResult));
      if (!closeModalResult || closeModalResult.after > 0 || !closeModalResult.hidden) {
        failures.push('导出设置面板未关闭');
      }

      // “设为默认打开方式”面板
      const assocOpened = await run('window.__readmdSmoke.openDefaultAppTest()');
      if (!assocOpened) failures.push('默认打开方式面板未打开');
      await wait(300);
      const assocShot = path.join(screenshotDir, 'smoke-default-app.png');
      fs.writeFileSync(assocShot, (await capture()).toPNG());
      const assocClosed = await run('window.__readmdSmoke.closeModalTest()');
      await wait(150);
      console.log('[ReadMD] 默认打开方式截图已保存:', assocShot, JSON.stringify(assocClosed));
      if (!assocClosed || assocClosed.after > 0 || !assocClosed.hidden) {
        failures.push('默认打开方式面板未关闭');
      }

      // AI 助手：mock provider -> 流式聊天 -> 修改建议 -> 应用 -> 图片
      const aiMock = await new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            let parsed = {};
            try { parsed = JSON.parse(body); } catch {}
            const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
            const users = messages.filter((message) => message.role === 'user');
            const lastUser = users[users.length - 1];
            const userText = JSON.stringify(lastUser?.content || '');
            const hasToolResult = messages.some((message) => message.role === 'tool');
            const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;

            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache'
            });
            const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({
              id: 'chatcmpl-smoke',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'mock-model',
              choices: [{ index: 0, delta, finish_reason: finish }]
            })}\n\n`);

            if (/改写|修改/.test(userText) && !hasToolResult && hasTools) {
              send({
                role: 'assistant',
                tool_calls: [{
                  index: 0,
                  id: 'call_smoke',
                  type: 'function',
                  function: {
                    name: 'propose_edit',
                    arguments: JSON.stringify({
                      oldText: '欢迎使用 ReadMD',
                      newText: '欢迎使用 ReadMD（AI 已修改）',
                      explanation: '把标题改成测试版本'
                    })
                  }
                }]
              });
              send({}, 'tool_calls');
            } else {
              let text;
              if (hasToolResult) {
                text = '已生成修改建议，请在下方确认。';
              } else if (/修改|改写/.test(userText) && !hasTools) {
                text = `已生成修改建议。\n\n\`\`\`json\n${JSON.stringify({
                  type: 'edit',
                  oldText: '欢迎使用 ReadMD',
                  newText: '欢迎使用 ReadMD（无工具修改）',
                  explanation: '无工具模式的文本建议'
                })}\n\`\`\``;
              } else if (/图片/.test(userText)) {
                text = '这张图片里有一个蓝色的 R 图标。';
              } else {
                text = '你好，我是测试模型。';
              }
              for (const char of text) send({ content: char });
              send({}, 'stop');
            }
            res.write('data: [DONE]\n\n');
            res.end();
          });
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
      });

      try {
        const mockConfigResult = await run(`window.readmd.aiSaveConfig(${JSON.stringify({
          name: 'Smoke Mock',
          type: 'openai-compatible',
          baseURL: `http://127.0.0.1:${aiMock.port}/v1`,
          model: 'mock-model',
          apiKey: 'smoke-key',
          supportsVision: true,
          supportsTools: true,
          supportsStreaming: true,
          maxContextChars: 60000
        })})`);
        const mockConfig = mockConfigResult.configs.find((config) => config.name === 'Smoke Mock');
        if (!mockConfig) failures.push('AI mock 配置保存失败');
        if (mockConfig) {
          await run(`window.readmd.aiSetActiveConfig(${JSON.stringify(mockConfig.id)})`);
        }

        const aiConfigList = await run('window.readmd.aiListConfigs()');
        if (!aiConfigList || aiConfigList.configs.some((config) => 'apiKeyEnc' in config)) {
          failures.push('AI 配置泄露到渲染进程');
        }
        const aiInitState = await run('window.readmd.init()');
        if (aiInitState.state && aiInitState.state.ai) {
          failures.push('AI 配置出现在 app:init 返回值中');
        }

        const aiKeyGuard = await run(`window.readmd.aiTestConfig(${JSON.stringify({
          id: mockConfig ? mockConfig.id : '',
          baseURL: 'http://127.0.0.1:1/v1'
        })}).then(() => ({ ok: true })).catch((error) => ({ ok: false, message: error.message }))`);
        console.log('[smoke] ai key guard', JSON.stringify(aiKeyGuard));
        if (!aiKeyGuard || aiKeyGuard.ok || !/重新填写 API Key/.test(aiKeyGuard.message || '')) {
          failures.push('AI 测试连接可改地址复用已保存 Key');
        }

        const aiRebindGuard = await run(`(async () => {
          const created = await window.readmd.aiSaveConfig({
            name: 'Smoke Rebind',
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:1/v1',
            model: 'mock-model',
            apiKey: 'smoke-key',
            supportsVision: true,
            supportsTools: true,
            supportsStreaming: true,
            maxContextChars: 60000
          });
          const config = created.configs.find((item) => item.name === 'Smoke Rebind');
          if (!config) return { error: 'missing' };
          const updated = await window.readmd.aiSaveConfig({
            id: config.id,
            name: 'Smoke Rebind',
            type: 'openai-compatible',
            baseURL: 'http://127.0.0.1:2/v1',
            model: 'mock-model',
            supportsVision: true,
            supportsTools: true,
            supportsStreaming: true,
            maxContextChars: 60000
          });
          const after = updated.configs.find((item) => item.id === config.id);
          await window.readmd.aiDeleteConfig(config.id);
          return { createdHasKey: config.hasKey, afterHasKey: Boolean(after && after.hasKey) };
        })()`);
        console.log('[smoke] ai rebind guard', JSON.stringify(aiRebindGuard));
        if (!aiRebindGuard || !aiRebindGuard.createdHasKey || aiRebindGuard.afterHasKey) {
          failures.push('AI 改接口地址后仍复用旧 Key');
        }

        const { readFile: readAIFile } = require('./ai/tools');
        let readTextOk = false;
        let readBinaryBlocked = false;
        try {
          const textFile = await readAIFile(sampleDir, '欢迎使用 ReadMD.md');
          readTextOk = typeof textFile.content === 'string' && textFile.content.includes('欢迎使用');
        } catch {
          readTextOk = false;
        }
        try {
          await readAIFile(sampleDir, 'assets/smoke-image.png');
        } catch {
          readBinaryBlocked = true;
        }
        if (!readTextOk || !readBinaryBlocked) {
          failures.push('AI read_file 只能读取文本的限制失效');
        }

        await run('window.__readmdAISmoke.refresh()');
        await run('window.__readmdAISmoke.open()');
        await wait(400);

        const aiResize = await run(`(() => {
          const panel = document.getElementById('ai-panel');
          const handle = panel.querySelector('[data-role="resize"]');
          if (!handle) return null;
          const before = panel.getBoundingClientRect().width;
          const rect = handle.getBoundingClientRect();
          handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: rect.x + 3, pointerId: 7 }));
          handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.x - 77, pointerId: 7 }));
          handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: rect.x - 77, pointerId: 7 }));
          const after = panel.getBoundingClientRect().width;
          handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          const reset = panel.getBoundingClientRect().width;
          return { before, after, reset };
        })()`);
        console.log('[smoke] ai resize', JSON.stringify(aiResize));
        if (!aiResize || aiResize.after <= aiResize.before || Math.abs(aiResize.reset - 440) > 2) {
          failures.push('AI 面板调宽失败');
        }
        await wait(200);

        const aiChat = await run(`window.__readmdAISmoke.chat('请总结当前文档')`);
        if (!aiChat || !String(aiChat.text || '').includes('你好，我是测试模型')) {
          failures.push('AI 聊天失败');
        }

        const aiEdit = await run(`window.__readmdAISmoke.chat('请改写文档标题')`);
        const editProposal = aiEdit && Array.isArray(aiEdit.proposals) ? aiEdit.proposals[0] : null;
        if (!editProposal || editProposal.kind !== 'edit' || editProposal.oldText !== '欢迎使用 ReadMD') {
          failures.push('AI 修改建议失败');
        }

        if (editProposal) {
          const applied = await run('window.__readmdAISmoke.applyFirstProposal()');
          await wait(400);
          const afterApply = await run('window.__readmdAISmoke.documentText()');
          if (!applied || !String(afterApply || '').includes('AI 已修改')) {
            failures.push('AI 修改应用失败');
          }
        }

        const aiLogo = fs.readFileSync(path.join(__dirname, '..', 'docs', 'assets', 'logo.png')).toString('base64');
        const aiImage = await run(`window.__readmdAISmoke.chat('请描述图片', ${JSON.stringify({
          images: [{ dataUrl: `data:image/png;base64,${aiLogo}`, mediaType: 'image/png' }]
        })})`);
        if (!aiImage || !String(aiImage.text || '').includes('R 图标')) {
          failures.push('AI 图片识别失败');
        }

        const { buildDocxBuffer } = getDocxExporter();
        const parseFixture = await buildDocxBuffer({
          title: 'AI 文档解析',
          baseDir: null,
          settings: {},
          html: '<h1>AI 文档解析</h1><p>这是用于验证文档上传的内容。</p>'
        });
        const parseBase64 = parseFixture.buffer.toString('base64');
        const parsedDocument = await run(`window.readmd.aiParseDocument('smoke.docx', Uint8Array.from(atob(${JSON.stringify(parseBase64)}), (char) => char.charCodeAt(0)).buffer)`);
        if (!parsedDocument || !String(parsedDocument.text || '').includes('用于验证文档上传')) {
          failures.push('AI 文档解析失败');
        }

        const aiPanelInfo = await run(`(() => {
          const panel = document.getElementById('ai-panel');
          const btn = document.getElementById('btn-ai');
          const style = panel ? getComputedStyle(panel) : null;
          const rect = panel ? panel.getBoundingClientRect() : null;
          return {
            count: document.querySelectorAll('#ai-panel').length,
            className: panel ? panel.className : null,
            rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
            display: style ? style.display : null,
            visibility: style ? style.visibility : null,
            opacity: style ? style.opacity : null,
            zIndex: style ? style.zIndex : null,
            btnClass: btn ? btn.className : null,
            messages: panel ? panel.querySelectorAll('.ai-msg').length : -1,
            bodyTail: Array.from(document.body.children).slice(-5).map((el) => el.id || el.className)
          };
        })()`);
        console.log('[smoke] ai panel info', JSON.stringify(aiPanelInfo));
        if (!aiPanelInfo || aiPanelInfo.count !== 1 || aiPanelInfo.display === 'none' || !aiPanelInfo.rect || aiPanelInfo.rect.w === 0) {
          failures.push('AI 面板未显示');
        }
        await run("document.getElementById('toast-host').innerHTML = ''");
        await wait(250);
        const aiShot = path.join(screenshotDir, 'smoke-ai-panel.png');
        const aiImageShot = await capture();
        fs.writeFileSync(aiShot, aiImageShot.toPNG());
        console.log('[ReadMD] AI 面板截图已保存:', aiShot);

        const undone = await run('window.__readmdAISmoke.undoFirstProposal()');
        await wait(300);
        const afterUndo = await run('window.__readmdAISmoke.documentText()');
        if (!undone || String(afterUndo || '').includes('AI 已修改')) {
          failures.push('AI 撤销修改失败');
        }

        const aiSettingsOpened = await run('window.__readmdAISmoke.openSettings()');
        if (!aiSettingsOpened) failures.push('AI 设置面板未打开');
        const aiOverlayInfo = await run(`(() => {
          const overlay = document.querySelector('[data-role="settings-overlay"]');
          const card = overlay ? overlay.querySelector('.ai-settings-card') : null;
          const style = overlay ? getComputedStyle(overlay) : null;
          const rect = overlay ? overlay.getBoundingClientRect() : null;
          return {
            className: overlay ? overlay.className : null,
            display: style ? style.display : null,
            zIndex: style ? style.zIndex : null,
            rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
            cardFound: Boolean(card),
            dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map((el) => el.className || el.id)
          };
        })()`);
        console.log('[smoke] ai overlay info', JSON.stringify(aiOverlayInfo));
        if (!aiOverlayInfo || !aiOverlayInfo.cardFound || aiOverlayInfo.display === 'none') {
          failures.push('AI 设置面板未显示');
        }
        await run("document.getElementById('toast-host').innerHTML = ''");
        await wait(300);
        const aiSettingsShot = path.join(screenshotDir, 'smoke-ai-settings.png');
        const aiSettingsImage = await capture();
        fs.writeFileSync(aiSettingsShot, aiSettingsImage.toPNG());
        await run('window.__readmdAISmoke.closeSettings()');

        const noToolsResult = await run(`window.readmd.aiSaveConfig(${JSON.stringify({
          name: 'Smoke NoTools',
          type: 'openai-compatible',
          baseURL: `http://127.0.0.1:${aiMock.port}/v1`,
          model: 'mock-model',
          apiKey: 'smoke-key',
          supportsVision: true,
          supportsTools: false,
          supportsStreaming: true,
          maxContextChars: 60000
        })})`);
        const noToolsConfig = noToolsResult.configs.find((config) => config.name === 'Smoke NoTools');
        if (!noToolsConfig) failures.push('AI 无工具配置保存失败');
        if (noToolsConfig) {
          await run(`window.readmd.aiSetActiveConfig(${JSON.stringify(noToolsConfig.id)})`);
          await run('window.__readmdAISmoke.refresh()');
          const fallbackResult = await run(`window.__readmdAISmoke.chat('请修改标题，不要使用工具')`);
          if (!fallbackResult
            || !Array.isArray(fallbackResult.proposals)
            || !fallbackResult.proposals.some((proposal) => proposal.kind === 'edit' && proposal.oldText === '欢迎使用 ReadMD')) {
            failures.push('AI 无工具模式失败');
          }
          console.log('[smoke] ai fallback test', JSON.stringify({
            text: fallbackResult && fallbackResult.text,
            proposals: fallbackResult && fallbackResult.proposals
          }));
        }

        await run('window.__readmdAISmoke.close()');
        await wait(150);
        console.log('[ReadMD] AI 设置截图已保存:', aiSettingsShot);
      } catch (error) {
        failures.push(`AI 测试失败：${error.message || error}`);
      } finally {
        aiMock.server.close();
      }

      const featureDir = path.join(os.tmpdir(), `readmd-feature-${process.pid}`);
      const featureFile = path.join(featureDir, 'second.md');
      try {
        fs.mkdirSync(featureDir, { recursive: true });
        fs.writeFileSync(featureFile, '# 第二篇示例\n\n用于验证多标签页。\n', 'utf8');
        await addRoot(featureDir);
        await addFile(featureFile);
        await run(`window.__readmdSmoke.openPath(${JSON.stringify(featureFile)})`);
        await wait(700);
        const multi = await run('window.__readmdSmoke.diagnostics()');
        if (!multi || multi.tabs !== 2) failures.push('多标签页打开失败');
        await run('window.__readmdSmoke.closeActive()');
        await wait(400);
        const single = await run('window.__readmdSmoke.diagnostics()');
        if (!single || single.tabs !== 1) failures.push('关闭标签后数量不正确');
        console.log('[smoke] tabs test', JSON.stringify({ multiTabs: multi && multi.tabs, singleTabs: single && single.tabs }));

        // 模拟“双击/系统打开多个文件”：走主进程 -> 渲染进程的完整链路
        const featureFile2 = path.join(featureDir, 'third.md');
        fs.writeFileSync(featureFile2, '# 第三篇示例\n\n用于验证一次打开多个文件。\n', 'utf8');
        await openPathsFromSystem([featureFile, featureFile2]);
        await wait(900);
        const systemMulti = await run('window.__readmdSmoke.diagnostics()');
        if (!systemMulti || systemMulti.tabs !== 3) failures.push('系统多文件打开失败');
        const activeTitle = await run("document.querySelector('.tab.active .tab-title')?.textContent || ''");
        if (!activeTitle.includes('third')) failures.push('系统打开后未激活最后一个文件');
        await run('window.__readmdSmoke.closeActiveWithoutSaving()');
        await wait(250);
        await run('window.__readmdSmoke.closeActiveWithoutSaving()');
        await wait(250);
        const restoredTabs = await run('window.__readmdSmoke.diagnostics()');
        if (!restoredTabs || restoredTabs.tabs !== 1) failures.push('系统多文件关闭后数量不正确');
        console.log('[smoke] system open test', JSON.stringify({
          tabs: systemMulti && systemMulti.tabs,
          activeTitle,
          restoredTabs: restoredTabs && restoredTabs.tabs
        }));
      } finally {
        fs.rmSync(featureDir, { recursive: true, force: true });
      }

      const before = await run('window.__readmdSmoke.diagnostics()');
      const appended = await run("window.__readmdSmoke.appendText('\\n\\n<!-- readmd smoke test -->')");
      if (!appended) failures.push('输入测试未执行');
      await wait(150);
      const afterInput = await run('window.__readmdSmoke.diagnostics()');
      if (!afterInput || !afterInput.dirty) failures.push('输入后未标记为未保存');

      await run('window.__readmdSmoke.save()');
      await wait(900);
      const afterSave = await run('window.__readmdSmoke.diagnostics()');
      const onDisk = fs.readFileSync(sampleFile, 'utf8');
      if (!onDisk.includes('readmd smoke test')) failures.push('保存后磁盘内容未更新');
      if (!afterSave || afterSave.dirty) failures.push('保存后仍标记为未保存');
      console.log('[smoke] save test', JSON.stringify({ before, afterInput, afterSave }));

      const outlineTooltipTest = await run(`(async () => {
        const before = document.querySelectorAll('.vditor-outline span[data-target-id]').length;
        await window.__readmdSmoke.appendText('\\n\\n## 超长标题用于验证悬浮提示可以完整显示\\n\\n正文');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const items = Array.from(document.querySelectorAll('.vditor-outline span[data-target-id]'));
        return {
          before,
          after: items.length,
          titled: items.filter((item) => item.title).length,
          longTitle: items.map((item) => item.title).find((title) => title.includes('超长标题')) || null
        };
      })()`);
      console.log('[smoke] outline tooltip test', JSON.stringify(outlineTooltipTest));
      if (!outlineTooltipTest || outlineTooltipTest.after <= outlineTooltipTest.before) {
        failures.push('新增大纲条目未生成');
      } else if (outlineTooltipTest.titled < outlineTooltipTest.after) {
        failures.push('大纲悬浮提示未随编辑更新');
      }
      if (!outlineTooltipTest || !outlineTooltipTest.longTitle) {
        failures.push('大纲条目缺少完整标题提示');
      }

      const imageDir = path.join(os.tmpdir(), `readmd-image-${process.pid}`);
      const imageFile = path.join(imageDir, 'image-test.md');
      try {
        fs.mkdirSync(imageDir, { recursive: true });
        fs.writeFileSync(imageFile, '# 图片插入测试\n\n', 'utf8');
        await addRoot(imageDir);
        await addFile(imageFile);
        await run(`window.__readmdSmoke.openPath(${JSON.stringify(imageFile)})`);
        await wait(700);
        const imageResult = await run('window.__readmdSmoke.insertImageTest()');
        await wait(2500);
        const assetsDir = path.join(imageDir, 'assets');
        const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir) : [];
        const diskMarkdown = fs.readFileSync(imageFile, 'utf8');
        if (!imageResult || !imageResult.ok || assets.length === 0 || !diskMarkdown.includes('assets/')) {
          failures.push('图片插入失败');
        }
        console.log('[smoke] image test', JSON.stringify({
          result: imageResult,
          assets,
          diskHasImage: diskMarkdown.includes('assets/')
        }));
        await run('window.__readmdSmoke.closeActiveWithoutSaving()');
        await wait(300);
      } catch (error) {
        failures.push(`图片插入测试异常：${error.message || error}`);
        console.error('[ReadMD] 图片插入测试异常', error);
      } finally {
        fs.rmSync(imageDir, { recursive: true, force: true });
      }

      // 回到顶部按钮：滚动后出现，回顶后自动隐藏
      try {
        const backTop = await run('window.__readmdSmoke.backTopTest()');
        console.log('[smoke] back top test', JSON.stringify(backTop));
        if (!backTop || !backTop.ok) failures.push('回到顶部按钮测试失败');
        await run(`(() => {
          const scroller = document.querySelector('.vditor-ir > .vditor-reset');
          if (scroller) scroller.scrollTop = 800;
        })()`);
        await wait(350);
        const backTopShot = path.join(screenshotDir, 'smoke-back-top.png');
        fs.writeFileSync(backTopShot, (await capture()).toPNG());
        console.log('[ReadMD] 回到顶部截图已保存:', backTopShot);
        await run(`(() => {
          const scroller = document.querySelector('.vditor-ir > .vditor-reset');
          if (scroller) scroller.scrollTop = 0;
        })()`);
      } catch (error) {
        failures.push(`回到顶部按钮测试异常：${error.message || error}`);
      }
    } catch (error) {
      failures.push(error && error.message ? error.message : String(error));
      console.error('[ReadMD] 冒烟测试异常', error);
    } finally {
      try {
        fs.rmSync(sampleDir, { recursive: true, force: true });
      } catch {
        // 忽略清理失败
      }
      console.log(`[smoke] 截图目录: ${screenshotDir}`);
      console.log(failures.length ? `[smoke] FAIL: ${failures.join('；')}` : '[smoke] PASS');
      try {
        fs.writeFileSync(
          path.join(screenshotDir, 'smoke-result.json'),
          JSON.stringify({ pass: failures.length === 0, failures, finishedAt: new Date().toISOString() }, null, 2),
          'utf8'
        );
      } catch {
        // 忽略结果写入失败
      }
      allowClose = true;
      app.exit(failures.length ? 1 : 0);
    }
  })();
}

function ensureAssociationSample(activeFile) {
  const candidate = activeFile ? path.resolve(String(activeFile)) : '';
  if (candidate && fileAssociation.isSupportedExtension(path.extname(candidate))) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 文件已被移动或删除时退回临时示例
    }
  }

  const dir = path.join(app.getPath('temp'), 'ReadMD');
  fs.mkdirSync(dir, { recursive: true });
  const sample = path.join(dir, 'ReadMD-默认打开方式示例.md');
  fs.writeFileSync(
    sample,
    '# ReadMD\n\n这是一个示例文件。选择 ReadMD 打开它，并勾选“始终使用此应用”，以后双击 .md 文件就会直接用 ReadMD 打开。\n',
    'utf8'
  );
  return sample;
}

/** 用户拖动过便携版 exe 后，把关联里的旧路径自动更新为新路径。 */
async function refreshPortableAssociation() {
  if (process.platform !== 'win32' || IS_SMOKE_TEST || !app.isPackaged) return;
  try {
    const info = getExecutableInfo();
    const status = await fileAssociation.getStatus(info);
    if (status.registered && !status.commandMatches) {
      await fileAssociation.register(info);
      console.log('[ReadMD] 已更新文件关联的程序路径:', info.exePath);
    }
  } catch (error) {
    console.error('[ReadMD] 更新文件关联失败', error);
  }
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  app.setAppUserModelId('com.readmd.app');

  stateFile = path.join(app.getPath('userData'), 'state.json');
  appState = readState();
  nativeTheme.themeSource = appState.theme === 'dark' ? 'dark' : 'light';

  registerAIHandlers({ ipcMain, appState, persistState, assertAllowed });

  // 恢复上次会话所需的最小权限
  if (appState.lastFolder) await addRoot(appState.lastFolder);
  for (const item of appState.openFiles || []) await addFile(item);
  for (const item of appState.recentFiles || []) await addRoot(path.dirname(item));

  buildMenu();
  createWindow();
  refreshPortableAssociation();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  allowClose = true;
  persistWindowBounds();
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  openPathsFromSystem([filePath]);
});

/* ------------------------------ IPC: 窗口与状态 ------------------------------ */

ipcMain.handle('app:init', () => {
  const { ai, ...safeState } = appState;
  return {
    version: app.getVersion(),
    platform: process.platform,
    state: safeState,
    smoke: IS_SMOKE_TEST
  };
});

ipcMain.on('app:renderer-ready', async () => {
  rendererReady = true;
  const argvFiles = findMarkdownArguments(process.argv);
  const payload = mergeOpenPayloads(
    pendingOpenPaths,
    argvFiles.length ? { files: argvFiles } : null
  );
  pendingOpenPaths = null;
  if (payload) {
    if (payload.folder) await addRoot(payload.folder);
    for (const file of payload.files || []) {
      await addRoot(path.dirname(file));
      await addFile(file);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:open-paths', payload);
    }
  }
});

ipcMain.handle('state:save', (_event, patch) => {
  if (!patch || typeof patch !== 'object') return false;
  const allowedKeys = new Set(Object.keys(defaultState));
  for (const [key, value] of Object.entries(patch)) {
    if (!allowedKeys.has(key) || key === 'ai') continue;
    appState[key] = key === 'exportSettings' ? normalizeExportSettings(value) : value;
  }
  persistState();
  return true;
});

ipcMain.on('app:set-dirty', (_event, dirty) => {
  rendererDirty = Boolean(dirty);
});

ipcMain.handle('window:close', () => {
  allowClose = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  return true;
});

ipcMain.handle('window:set-title', (_event, title) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(title ? `${title} - ${APP_NAME}` : APP_NAME);
  }
  return true;
});

ipcMain.handle('theme:set-native', (_event, theme) => {
  const dark = theme === 'dark';
  nativeTheme.themeSource = dark ? 'dark' : 'light';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(dark ? '#121316' : '#eef1f5');
  }
  return true;
});

ipcMain.handle('find:start', (event, text, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !text) return null;
  return win.webContents.findInPage(text, options || {});
});

ipcMain.handle('find:stop', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.webContents.stopFindInPage(action || 'clearSelection');
  return true;
});

/* ------------------------------ IPC: 文件与文件夹 ------------------------------ */

ipcMain.handle('dialog:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择包含 Markdown 的文件夹',
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const folder = path.resolve(result.filePaths[0]);
  await addRoot(folder);
  rememberFolder(folder);
  return { path: folder, name: path.basename(folder) || folder };
});

ipcMain.handle('dialog:open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '打开 Markdown 文件',
    properties: ['openFile'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] },
      { name: '所有文件', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = path.resolve(result.filePaths[0]);
  await addRoot(path.dirname(filePath));
  await addFile(filePath);
  rememberFile(filePath);
  return markdownFileInfo(filePath, await fsp.stat(filePath));
});

ipcMain.handle('fs:read-dir', async (_event, dirPath) => {
  await assertAllowed(dirPath);
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.svn') continue;
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dirPath, entry.name);
    const isDir = entry.isDirectory();
    items.push({
      name: entry.name,
      path: fullPath,
      isDir,
      ext: isDir ? '' : path.extname(entry.name).toLowerCase()
    });
  }
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
  });
  return items;
});

ipcMain.handle('fs:read-file', async (_event, filePath) => readMarkdownFile(filePath));

ipcMain.handle('fs:write-file', async (_event, filePath, content, eol) => {
  await assertAllowed(filePath);
  const normalized = eol === '\r\n'
    ? String(content).replace(/\r?\n/g, '\r\n')
    : String(content).replace(/\r\n/g, '\n');
  await atomicWrite(filePath, normalized);
  const stat = await fsp.stat(filePath);
  return { ...markdownFileInfo(filePath, stat), bytes: Buffer.byteLength(normalized, 'utf8') };
});

ipcMain.handle('fs:save-as', async (_event, content, defaultName, currentPath, eol) => {
  const suggestedDir = currentPath ? path.dirname(currentPath) : app.getPath('documents');
  const suggestedName = defaultName || (currentPath ? path.basename(currentPath) : '未命名.md');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '另存为',
    defaultPath: path.join(suggestedDir, suggestedName),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '文本文件', extensions: ['txt'] }
    ]
  });
  if (result.canceled || !result.filePath) return null;
  const filePath = path.resolve(result.filePath);
  await addRoot(path.dirname(filePath));
  await addFile(filePath);
  const normalized = eol === '\r\n'
    ? String(content).replace(/\r?\n/g, '\r\n')
    : String(content).replace(/\r\n/g, '\n');
  await atomicWrite(filePath, normalized);
  const stat = await fsp.stat(filePath);
  rememberFile(filePath);
  return { ...markdownFileInfo(filePath, stat), content, eol };
});

ipcMain.handle('fs:create-file', async (_event, parentDir, name) => {
  await assertAllowed(parentDir);
  const fileName = ensureMarkdownName(name);
  const target = path.join(parentDir, fileName);
  if (normalizeKey(path.dirname(target)) !== normalizeKey(parentDir)) throw new Error('文件名不合法');
  const handle = await fsp.open(target, 'wx');
  await handle.close();
  await addFile(target);
  return { path: target, name: fileName };
});

ipcMain.handle('fs:create-folder', async (_event, parentDir, name) => {
  await assertAllowed(parentDir);
  const folderName = validateEntryName(name);
  const target = path.join(parentDir, folderName);
  if (normalizeKey(path.dirname(target)) !== normalizeKey(parentDir)) throw new Error('文件夹名不合法');
  await fsp.mkdir(target);
  await addRoot(target);
  return { path: target, name: folderName };
});

ipcMain.handle('fs:rename', async (_event, oldPath, newName) => {
  await assertAllowed(oldPath);
  const finalName = validateEntryName(newName);
  const target = path.join(path.dirname(oldPath), finalName);
  if (normalizeKey(path.dirname(target)) !== normalizeKey(path.dirname(oldPath))) throw new Error('名称不合法');
  await fsp.rename(oldPath, target);
  allowedFiles.delete(await realKeyForWrite(oldPath));
  await addFile(target);
  return { path: target, name: finalName };
});

ipcMain.handle('fs:trash', async (_event, targetPath) => {
  await assertAllowed(targetPath);
  await shell.trashItem(targetPath);
  allowedFiles.delete(await realKeyForWrite(targetPath));
  return true;
});

ipcMain.handle('fs:reveal', async (_event, targetPath) => {
  await assertAllowed(targetPath);
  shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle('fs:stat', async (_event, targetPath) => {
  try {
    const stat = await fsp.stat(targetPath);
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
  } catch {
    return { exists: false };
  }
});

ipcMain.handle('path:resolve-relative', async (_event, docPath, href) => {
  if (!docPath || !href) throw new Error('参数不完整');
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) throw new Error('不是相对路径');
  const decoded = decodeURIComponent(href.split('#')[0].split('?')[0]);
  return path.resolve(path.dirname(docPath), decoded);
});

ipcMain.handle('path:dir-url', async (_event, targetPath) => {
  if (!targetPath) throw new Error('参数不完整');
  return `${pathToFileURL(path.dirname(targetPath)).href}/`;
});

/* ------------------------------ IPC: 图片与导出 ------------------------------ */

ipcMain.handle('image:save', async (_event, docPath, fileName, bytes) => {
  await assertAllowed(docPath);
  const buffer = Buffer.from(bytes);
  if (buffer.byteLength > MAX_IMAGE_SIZE) throw new Error('图片超过 25 MB，暂不支持');
  const assetsDir = path.join(path.dirname(docPath), 'assets');
  await fsp.mkdir(assetsDir, { recursive: true });
  await addRoot(assetsDir);
  const finalName = safeImageName(fileName);
  await fsp.writeFile(path.join(assetsDir, finalName), buffer);
  return `assets/${finalName}`;
});

let docxExporter = null;
function getDocxExporter() {
  if (!docxExporter) docxExporter = require('./export/docx');
  return docxExporter;
}

async function normalizeExportPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('导出内容无效');
  const html = typeof payload.html === 'string' ? payload.html : '';
  if (!html.trim()) throw new Error('当前文档没有可导出的内容');
  if (Buffer.byteLength(html, 'utf8') > 64 * 1024 * 1024) {
    throw new Error('文档超过 64 MB，暂不支持导出');
  }

  const title = String(payload.title || '未命名文档').trim().slice(0, 200) || '未命名文档';
  let baseDir = null;
  if (payload.baseDir) {
    const resolved = path.resolve(String(payload.baseDir));
    if (!(await canReadDirectory(resolved))) {
      throw new Error('导出目录未授权，请重新打开文档所在文件夹');
    }
    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch {
      throw new Error('导出目录不存在，请重新打开文档');
    }
    if (!stat.isDirectory()) throw new Error('导出目录无效');
    baseDir = resolved;
  }

  return { title, html, baseDir, settings: normalizeExportSettings(payload.settings) };
}

function ensureExtension(name, extension) {
  const suffix = extension.startsWith('.') ? extension : `.${extension}`;
  const raw = path.basename(String(name || '').trim() || `未命名${suffix}`);
  const stem = raw.toLowerCase().endsWith(suffix.toLowerCase())
    ? raw.slice(0, -suffix.length)
    : raw;
  let cleaned = stem
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  if (!cleaned) cleaned = '未命名';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) cleaned = `${cleaned}-文档`;
  return `${cleaned}${suffix}`;
}

async function chooseExportTarget(title, defaultName, currentPath, filterName, extension) {
  const suggestedDir = currentPath ? path.dirname(currentPath) : app.getPath('documents');
  const result = await dialog.showSaveDialog(mainWindow, {
    title,
    defaultPath: path.join(suggestedDir, ensureExtension(defaultName, extension)),
    filters: [{ name: filterName, extensions: [extension.replace(/^\./, '')] }]
  });
  if (result.canceled || !result.filePath) return null;

  let target = path.resolve(result.filePath);
  if (!target.toLowerCase().endsWith(extension)) target += extension;
  return target;
}

async function writeExportToTarget(format, payload, target) {
  if (!EXPORT_FORMATS.has(format)) throw new Error('不支持的导出格式');

  if (format === 'html') {
    const html = await buildExportHtml(payload);
    await fsp.writeFile(target, html, 'utf8');
    return { path: target, bytes: Buffer.byteLength(html, 'utf8'), warnings: [] };
  }

  if (format === 'pdf') {
    const result = await renderPdfFromPayload(payload, target);
    return { path: target, bytes: result.bytes, warnings: [] };
  }

  const { buildDocxBuffer } = getDocxExporter();
  const result = await buildDocxBuffer(payload);
  await fsp.writeFile(target, result.buffer);
  return { path: target, bytes: result.buffer.length, warnings: result.warnings };
}

async function uniqueTargetPath(target) {
  const extension = path.extname(target);
  const stem = extension ? target.slice(0, -extension.length) : target;
  let candidate = target;
  let index = 1;

  while (true) {
    try {
      await fsp.access(candidate);
      candidate = `${stem} (${index})${extension}`;
      index += 1;
    } catch {
      return candidate;
    }
  }
}

async function listMarkdownFiles(rootDir) {
  const files = [];
  let truncated = false;

  const walk = async (dir, relativeDir, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });

    for (const entry of entries) {
      if (files.length >= MAX_BATCH_FILES) {
        truncated = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(dir, entry.name);
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (SKIP_BATCH_DIRS.has(entry.name)) continue;
        if (depth >= MAX_BATCH_DEPTH) {
          truncated = true;
          continue;
        }
        await walk(fullPath, relative, depth + 1);
        continue;
      }

      if (!entry.isFile() || !MARKDOWN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      let stat;
      try {
        stat = await fsp.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_SIZE) continue;

      files.push({ path: fullPath, name: entry.name, relative, size: stat.size });
    }
  };

  await walk(path.resolve(rootDir), '', 0);
  files.sort((a, b) => a.relative.localeCompare(b.relative, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  return { files, truncated };
}

ipcMain.handle('export:html', async (_event, payload, defaultName, currentPath) => {
  const safe = await normalizeExportPayload(payload);
  const target = await chooseExportTarget('导出 HTML', defaultName, currentPath, 'HTML', '.html');
  if (!target) return null;
  return writeExportToTarget('html', safe, target);
});

ipcMain.handle('export:pdf', async (_event, payload, defaultName, currentPath) => {
  const safe = await normalizeExportPayload(payload);
  const target = await chooseExportTarget('导出 PDF', defaultName, currentPath, 'PDF', '.pdf');
  if (!target) return null;
  return writeExportToTarget('pdf', safe, target);
});

ipcMain.handle('export:docx', async (_event, payload, defaultName, currentPath) => {
  const safe = await normalizeExportPayload(payload);
  const target = await chooseExportTarget('导出 Word 文档', defaultName, currentPath, 'Word 文档', '.docx');
  if (!target) return null;
  return writeExportToTarget('docx', safe, target);
});

ipcMain.handle('export:html-string', async (_event, payload) => {
  return buildExportHtml(await normalizeExportPayload(payload));
});

ipcMain.handle('export:pdf-test', async (_event, payload, target) => {
  if (!IS_SMOKE_TEST) throw new Error('该接口仅用于冒烟测试');
  return writeExportToTarget('pdf', await normalizeExportPayload(payload), path.resolve(target));
});

ipcMain.handle('export:docx-test', async (_event, payload, target) => {
  if (!IS_SMOKE_TEST) throw new Error('该接口仅用于冒烟测试');
  return writeExportToTarget('docx', await normalizeExportPayload(payload), path.resolve(target));
});

ipcMain.handle('export:choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择批量导出位置',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const folder = path.resolve(result.filePaths[0]);
  allowedExportDirs.add(await realKeyForWrite(folder));
  return folder;
});

ipcMain.handle('export:list-markdown', async (_event, rootDir) => {
  const root = path.resolve(String(rootDir || ''));
  await assertAllowed(root);
  return listMarkdownFiles(root);
});

ipcMain.handle('export:authorize-test-folder', async (_event, dir) => {
  if (!IS_SMOKE_TEST) throw new Error('该接口仅用于冒烟测试');
  const folder = path.resolve(String(dir || ''));
  allowedExportDirs.add(await realKeyForWrite(folder));
  return folder;
});

ipcMain.handle('export:batch-item', async (_event, format, payload, outputDir, relativePath) => {
  if (!EXPORT_FORMATS.has(format)) throw new Error('不支持的导出格式');

  const safe = await normalizeExportPayload(payload);
  const root = path.resolve(String(outputDir || ''));
  if (!allowedExportDirs.has(await realKeyForWrite(root))) {
    throw new Error('导出位置未授权，请重新选择输出文件夹');
  }

  const normalizedRelative = String(relativePath || safe.title)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!normalizedRelative || normalizedRelative.includes('\0')) {
    throw new Error('导出文件名不合法');
  }

  const extension = `.${format}`;
  const withExtension = normalizedRelative.toLowerCase().endsWith(extension)
    ? normalizedRelative
    : normalizedRelative.replace(/\.[^./]+$/, '') + extension;

  const target = path.resolve(root, withExtension);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new Error('导出文件名不合法');
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  const finalTarget = await uniqueTargetPath(target);
  return writeExportToTarget(format, safe, finalTarget);
});

/* ------------------------------ IPC: 系统集成 ------------------------------ */

ipcMain.handle('shell:open-external', async (_event, url) => {
  if (!/^(https?:|mailto:)/i.test(String(url || ''))) throw new Error('只允许打开 http/https/mailto 链接');
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('app:show-item', async (_event, targetPath) => {
  shell.showItemInFolder(targetPath);
  return true;
});

ipcMain.handle('app:get-paths', () => ({
  documents: app.getPath('documents'),
  home: app.getPath('home'),
  userData: app.getPath('userData')
}));

ipcMain.handle('app:file-association-status', async () => {
  return fileAssociation.getStatus(getExecutableInfo());
});

ipcMain.handle('app:file-association-register', async () => {
  if (!app.isPackaged) {
    throw new Error('开发模式下不能注册文件关联，请使用打包后的 ReadMD 程序');
  }
  const info = getExecutableInfo();
  await fileAssociation.register(info);
  return fileAssociation.getStatus(info);
});

ipcMain.handle('app:file-association-remove', async () => {
  const info = getExecutableInfo();
  await fileAssociation.unregister(info);
  return fileAssociation.getStatus(info);
});

ipcMain.handle('app:file-association-setup', async (_event, activeFile) => {
  if (!app.isPackaged) {
    throw new Error('开发模式下不能注册文件关联，请使用打包后的 ReadMD 程序');
  }
  const info = getExecutableInfo();
  await fileAssociation.register(info);
  // 给资源管理器一点时间刷新“打开方式”候选列表
  await new Promise((resolve) => setTimeout(resolve, 250));
  fileAssociation.openWithDialog(ensureAssociationSample(activeFile));
  return fileAssociation.getStatus(info);
});

ipcMain.handle('app:file-association-open-settings', async () => {
  if (process.platform !== 'win32') throw new Error('文件关联设置目前仅支持 Windows');
  await shell.openExternal('ms-settings:defaultapps');
  return true;
});
