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
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_NAME = 'ReadMD';
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt', '.text']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const MAX_FILE_SIZE = 32 * 1024 * 1024;
const MAX_IMAGE_SIZE = 25 * 1024 * 1024;
const IS_SMOKE_TEST = process.argv.includes('--smoke-test');

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
  outlineWidth: 230
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

function readState() {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...defaultState, ...parsed };
  } catch {
    return { ...defaultState };
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
        { label: '导出 HTML…', click: () => send('export-html') },
        { label: '导出 PDF…', click: () => send('export-pdf') },
        { type: 'separator' },
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
    const filePath = findMarkdownArgument(argv);
    if (filePath) {
      openPathFromSystem(filePath);
    }
  });
}

function findMarkdownArgument(argv) {
  for (let i = argv.length - 1; i >= 1; i -= 1) {
    const candidate = argv[i];
    if (!candidate || candidate.startsWith('-')) continue;
    if (!MARKDOWN_EXTENSIONS.has(path.extname(candidate).toLowerCase())) continue;
    try {
      if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
    } catch {
      // 忽略不存在的参数
    }
  }
  return null;
}

async function openPathFromSystem(filePath) {
  try {
    const resolved = path.resolve(filePath);
    await addRoot(path.dirname(resolved));
    await addFile(resolved);
    rememberFile(resolved);
    if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
      mainWindow.webContents.send('app:open-paths', { files: [resolved] });
    } else {
      pendingOpenPaths = { files: [resolved] };
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
  '## 功能列表',
  '',
  '- 本地文件优先',
  '- 即时渲染编辑',
  '- 自动保存',
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

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const run = (script) => mainWindow.webContents.executeJavaScript(script);

  (async () => {
    try {
      await addRoot(sampleDir);
      await addFile(sampleFile);
      fs.mkdirSync(screenshotDir, { recursive: true });
      await wait(1500);
      const welcomeImage = await mainWindow.webContents.capturePage();
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
      if (!diagnostics || diagnostics.imageWidth <= 0) failures.push('相对路径图片未加载');
      if (!diagnostics || !diagnostics.editorReady) failures.push('编辑器未就绪');
      if (!diagnostics || !diagnostics.imageToolbarButton) failures.push('编辑器工具栏缺少图片按钮');
      if (!diagnostics || !diagnostics.imageToolbarInput) failures.push('图片按钮缺少文件选择输入框');

      fs.mkdirSync(screenshotDir, { recursive: true });
      const image = await mainWindow.webContents.capturePage();
      const lightShot = path.join(screenshotDir, 'smoke-light.png');
      fs.writeFileSync(lightShot, image.toPNG());
      console.log(`[ReadMD] 冒烟截图已保存: ${lightShot}`);

      await run("window.__readmdSmokeTheme && window.__readmdSmokeTheme('dark')");
      await wait(1800);
      const darkImage = await mainWindow.webContents.capturePage();
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

      const fullscreenImage = await mainWindow.webContents.capturePage();
      const fullscreenShot = path.join(screenshotDir, 'smoke-fullscreen.png');
      fs.writeFileSync(fullscreenShot, fullscreenImage.toPNG());
      console.log(`[ReadMD] 全屏截图已保存: ${fullscreenShot}`);

      mainWindow.unmaximize();
      await wait(500);

      const findResult = await run("window.__readmdSmoke.find('ReadMD')");
      if (!findResult || !findResult.matches) failures.push('查找没有匹配结果');
      console.log('[smoke] find test', JSON.stringify(findResult));

      const exportHtml = await run('window.__readmdSmoke.exportHtmlString()');
      if (!exportHtml || !exportHtml.includes('<html') || !exportHtml.includes('ReadMD') || !exportHtml.includes('<style>')) {
        failures.push('HTML 导出内容不完整');
      }
      console.log('[smoke] export html length', exportHtml ? exportHtml.length : 0);

      if (exportHtml) {
        const pdfPath = path.join(os.tmpdir(), `readmd-smoke-${process.pid}.pdf`);
        try {
          await run(`window.readmd.exportPdfTest(${JSON.stringify(exportHtml)}, ${JSON.stringify(pdfPath)})`);
          const pdfBytes = fs.readFileSync(pdfPath);
          if (pdfBytes.subarray(0, 5).toString() !== '%PDF-' || pdfBytes.length < 1000) {
            failures.push('PDF 导出结果无效');
          }
          console.log('[smoke] pdf test', JSON.stringify({ bytes: pdfBytes.length, header: pdfBytes.subarray(0, 5).toString() }));
        } catch (error) {
          failures.push(`PDF 导出失败：${error.message || error}`);
        } finally {
          fs.rmSync(pdfPath, { force: true });
        }
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
        await wait(1200);
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
      allowClose = true;
      app.exit(failures.length ? 1 : 0);
    }
  })();
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  app.setAppUserModelId('com.readmd.app');

  stateFile = path.join(app.getPath('userData'), 'state.json');
  appState = readState();
  nativeTheme.themeSource = appState.theme === 'dark' ? 'dark' : 'light';

  // 恢复上次会话所需的最小权限
  if (appState.lastFolder) await addRoot(appState.lastFolder);
  for (const item of appState.openFiles || []) await addFile(item);
  for (const item of appState.recentFiles || []) await addRoot(path.dirname(item));

  buildMenu();
  createWindow();

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
  openPathFromSystem(filePath);
});

/* ------------------------------ IPC: 窗口与状态 ------------------------------ */

ipcMain.handle('app:init', () => ({
  version: app.getVersion(),
  platform: process.platform,
  state: appState,
  smoke: IS_SMOKE_TEST
}));

ipcMain.on('app:renderer-ready', async () => {
  rendererReady = true;
  const argvFile = findMarkdownArgument(process.argv);
  const payload = pendingOpenPaths || (argvFile ? { files: [argvFile] } : null);
  if (payload) {
    if (payload.folder) await addRoot(payload.folder);
    for (const file of payload.files || []) {
      await addRoot(path.dirname(file));
      await addFile(file);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:open-paths', payload);
    }
    pendingOpenPaths = null;
  }
});

ipcMain.handle('state:save', (_event, patch) => {
  if (!patch || typeof patch !== 'object') return false;
  const allowedKeys = new Set(Object.keys(defaultState));
  for (const [key, value] of Object.entries(patch)) {
    if (allowedKeys.has(key)) appState[key] = value;
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

ipcMain.handle('export:vendor-css', async (_event, theme) => {
  const dist = path.join(__dirname, '..', 'renderer', 'vendor', 'vditor', 'dist');
  const codeStyle = theme === 'dark' ? 'monokai' : 'github';
  const candidates = [
    path.join(dist, 'index.css'),
    path.join(dist, 'css', 'content-theme', `${theme === 'dark' ? 'dark' : 'light'}.css`),
    path.join(dist, 'js', 'highlight.js', 'styles', `${codeStyle}.min.css`)
  ];
  const chunks = [];
  for (const file of candidates) {
    try {
      chunks.push(await fsp.readFile(file, 'utf8'));
    } catch {
      // 主题文件缺失时忽略，不影响导出
    }
  }
  return chunks.join('\n');
});

ipcMain.handle('export:html', async (_event, html, defaultName, currentPath) => {
  const suggestedDir = currentPath ? path.dirname(currentPath) : app.getPath('documents');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出 HTML',
    defaultPath: path.join(suggestedDir, defaultName || '未命名.html'),
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });
  if (result.canceled || !result.filePath) return null;
  const target = path.resolve(result.filePath);
  await fsp.writeFile(target, String(html), 'utf8');
  return target;
});

async function renderPdfFromHtml(html, target) {
  const tempHtml = path.join(app.getPath('temp'), `readmd-export-${process.pid}-${Date.now()}.html`);
  await fsp.writeFile(tempHtml, String(html), 'utf8');

  const printWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: false,
      backgroundThrottling: false
    }
  });

  try {
    await printWindow.loadFile(tempHtml);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const pdf = await printWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'none' }
    });
    await fsp.writeFile(target, pdf);
    return target;
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
    await fsp.rm(tempHtml, { force: true }).catch(() => {});
  }
}

ipcMain.handle('export:pdf', async (_event, html, defaultName, currentPath) => {
  const suggestedDir = currentPath ? path.dirname(currentPath) : app.getPath('documents');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '导出 PDF',
    defaultPath: path.join(suggestedDir, defaultName || '未命名.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (result.canceled || !result.filePath) return null;
  return renderPdfFromHtml(html, path.resolve(result.filePath));
});

ipcMain.handle('export:pdf-test', async (_event, html, target) => {
  if (!IS_SMOKE_TEST) throw new Error('该接口仅用于冒烟测试');
  return renderPdfFromHtml(html, target);
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
