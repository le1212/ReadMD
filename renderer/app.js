'use strict';

const api = window.readmd;
const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt', '.text']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const AUTOSAVE_MS = 900;
const MAX_RECENT = 8;
const CDN = new URL('./vendor/vditor', location.href).href.replace(/\/$/, '');

const state = {
  root: null,
  rootName: '',
  recentFolders: [],
  recentFiles: [],
  tabs: [],
  activePath: null,
  vditor: null,
  vditorReady: false,
  vditorReadyPromise: null,
  theme: 'light',
  sidebarVisible: true,
  sidebarWidth: 278,
  editorContentWidth: 920,
  outlineWidth: 230,
  expandedDirs: new Set(),
  loadingDoc: false,
  docLoadToken: 0,
  autoSaveTimer: null,
  savingTabs: new Map(),
  openingPaths: new Set(),
  findText: '',
  findVisible: false,
  findDebounce: null,
  lastFindResult: null,
  smoke: false,
  platform: 'win32',
  associationStatus: null,
  lastTitle: null,
  batchExporting: false,
  exportSettings: {
    formal: false,
    header: false,
    footer: true,
    cover: false,
    toc: false,
    coverSubtitle: '',
    coverAuthor: ''
  }
};

const els = {
  sidebar: document.getElementById('sidebar'),
  sidebarResizer: document.getElementById('sidebar-resizer'),
  folderName: document.getElementById('folder-name'),
  fileTree: document.getElementById('file-tree'),
  sidebarEmpty: document.getElementById('sidebar-empty'),
  tabbar: document.getElementById('tabbar'),
  editorShell: document.querySelector('.editor-shell'),
  welcome: document.getElementById('welcome'),
  vditor: document.getElementById('vditor'),
  statusLeft: document.getElementById('status-left'),
  statusCount: document.getElementById('status-count'),
  statusSave: document.getElementById('status-save'),
  btnSave: document.getElementById('btn-save'),
  contentResizer: document.getElementById('content-resizer'),
  outlineResizer: document.getElementById('outline-resizer'),
  backTop: document.getElementById('btn-back-top'),
  findbar: document.getElementById('findbar'),
  findInput: document.getElementById('find-input'),
  findCount: document.getElementById('find-count'),
  contextMenu: document.getElementById('context-menu'),
  modalRoot: document.getElementById('modal-root'),
  toastHost: document.getElementById('toast-host'),
  recentFolders: document.getElementById('recent-folders'),
  recentFiles: document.getElementById('recent-files')
};

/* ------------------------------ 工具函数 ------------------------------ */

function normPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function samePath(a, b) {
  return Boolean(a) && Boolean(b) && normPath(a) === normPath(b);
}

function baseName(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || String(value || '');
}

function dirName(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/');
}

function extOf(name) {
  const index = String(name || '').lastIndexOf('.');
  return index >= 0 ? String(name).slice(index).toLowerCase() : '';
}

function isMarkdown(entry) {
  return MD_EXT.has(entry.ext || extOf(entry.name));
}

function isImage(entry) {
  return IMAGE_EXT.has(entry.ext || extOf(entry.name));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function errorMessage(error) {
  const raw = String(error && error.message ? error.message : error || '未知错误');
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
}

function activeTab() {
  return findTab(state.activePath);
}

function findTab(ref) {
  if (!ref) return null;
  return state.tabs.find((tab) => (tab.path && samePath(tab.path, ref)) || tab.id === ref) || null;
}

function anyDirty() {
  return state.tabs.some((tab) => tab.dirty);
}

function safe(fn) {
  return (...args) => {
    try {
      const result = fn(...args);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => toast(errorMessage(error), 'error', 5000));
      }
    } catch (error) {
      toast(errorMessage(error), 'error', 5000);
    }
  };
}

/* ------------------------------ 启动 ------------------------------ */

async function init() {
  bindStaticEvents();
  if (!api) {
    toast('预加载脚本没有加载成功，请重新启动应用', 'error', 8000);
    return;
  }

  try {
    const info = await api.init();
    state.theme = info.state.theme === 'dark' ? 'dark' : 'light';
    state.sidebarVisible = info.state.sidebarVisible !== false;
    state.sidebarWidth = clamp(Number(info.state.sidebarWidth) || 278, 220, 420);
    state.editorContentWidth = clamp(Number(info.state.editorContentWidth) || 920, 560, 1600);
    state.outlineWidth = clamp(Number(info.state.outlineWidth) || 230, 160, 480);
    state.recentFolders = Array.isArray(info.state.recentFolders) ? info.state.recentFolders : [];
    state.recentFiles = Array.isArray(info.state.recentFiles) ? info.state.recentFiles : [];
    state.smoke = Boolean(info.smoke);
    state.platform = info.platform || 'win32';

    const savedExport = info.state.exportSettings || {};
    state.exportSettings = {
      formal: Boolean(savedExport.formal),
      header: Boolean(savedExport.header),
      footer: savedExport.footer !== false,
      cover: Boolean(savedExport.cover),
      toc: Boolean(savedExport.toc),
      coverSubtitle: String(savedExport.coverSubtitle || ''),
      coverAuthor: String(savedExport.coverAuthor || '')
    };

    applyTheme(state.theme, false);
    applySidebar(false);
    applyContentWidth(state.editorContentWidth, false);
    applyOutlineWidth(state.outlineWidth, false);
    renderTree();
    renderRecent();
    updateSaveButton();
    updateStatus();
    updateTitle();

    createVditor();
    initAIBridge();
    if (state.smoke) attachSmokeHooks();
    // 先恢复上次会话，再通知主进程投递“双击打开”的文件，
    // 避免恢复会话把用户刚双击的文档切走。
    await restoreSession(info.state);
    api.rendererReady();
    refreshAssociationEntry();
  } catch (error) {
    toast(`初始化失败：${errorMessage(error)}`, 'error', 8000);
    console.error('[ReadMD] init failed', error);
  }
}

async function restoreSession(savedState) {
  if (savedState.lastFolder) {
    const stat = await api.stat(savedState.lastFolder).catch(() => ({ exists: false }));
    if (stat.exists && stat.isDirectory) {
      try {
        await loadFolder(savedState.lastFolder, { remember: false, silent: true });
      } catch (error) {
        console.warn('[ReadMD] 恢复文件夹失败', error);
      }
    }
  }

  const files = Array.isArray(savedState.openFiles) ? savedState.openFiles : [];
  for (const file of files) {
    if (!file) continue;
    await openFile(file, { silent: true });
  }

  if (savedState.activeFile) {
    const tab = findTab(savedState.activeFile);
    if (tab) await activateTab(tab.path || tab.id, { skipFocus: true });
  }

  if (!state.tabs.length) showWelcome();
}

/* ------------------------------ 编辑器 ------------------------------ */

function createVditor() {
  state.vditorReadyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('编辑器加载超时。请检查 renderer/vendor/vditor 是否存在。'));
    }, 12000);

    try {
      if (!window.Vditor) throw new Error('Vditor 没有加载成功');
      state.vditor = new window.Vditor('vditor', {
        mode: 'ir',
        value: '',
        height: '100%',
        width: '100%',
        lang: 'zh_CN',
        icon: 'ant',
        cdn: CDN,
        theme: state.theme === 'dark' ? 'dark' : 'classic',
        placeholder: '在这里开始写作…',
        cache: { enable: false },
        counter: { enable: false },
        outline: { enable: true, position: 'right' },
        toolbar: [
          'headings', 'bold', 'italic', 'strike', '|',
          'list', 'ordered-list', 'check', '|',
          'quote', 'line', 'code', 'inline-code', '|',
          'link',
          {
            name: 'upload',
            tip: '插入图片（支持选择、拖拽、粘贴）',
            tipPosition: 'n',
            icon: '<svg viewBox="0 0 20 20" aria-hidden="true"><path fill-rule="evenodd" d="M0 0h20v20H0V0Zm2.5 2.5v11l4.2-4.2 3.3 3.3 2.5-2.5 5 5V2.5H2.5Zm2.3 1.4a1.7 1.7 0 1 0 0 3.4 1.7 1.7 0 0 0 0-3.4Z"/></svg>'
          },
          'table', '|',
          'undo', 'redo', '|',
          'outline', 'fullscreen'
        ],
        preview: {
          delay: 260,
          maxWidth: 920,
          theme: {
            current: state.theme === 'dark' ? 'dark' : 'light',
            path: `${CDN}/dist/css/content-theme`
          },
          hljs: {
            style: state.theme === 'dark' ? 'monokai' : 'github',
            lineNumber: true
          },
          math: { engine: 'KaTeX' },
          markdown: {
            sanitize: true,
            codeBlockPreview: false,
            linkBase: ''
          }
        },
        upload: {
          accept: 'image/*',
          multiple: true,
          handler: handleImageUpload
        },
        link: {
          isOpen: false,
          click: handleLinkClick
        },
        input: (value) => handleEditorInput(value),
        after: () => {
          clearTimeout(timer);
          state.vditorReady = true;
          observeEditorLayout();
          bindBackTop();
          setTimeout(() => {
            updateContentResizer();
            updateOutlineResizer();
            updateBackTopPosition();
            applyToolbarTitles();
            observeOutlineTitles();
          }, 200);
          resolve();
        }
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

/* ---------------------------- 回到顶部 ---------------------------- */

const BACK_TOP_THRESHOLD = 240;
let backTopScroller = null;

// Vditor 各模式的滚动容器不同：IR/WYSIWYG 是可编辑的 pre，预览模式是 preview 面板。
function editorScroller() {
  const core = state.vditor && state.vditor.vditor;
  if (!core) return null;
  if (core.preview && core.preview.element && core.preview.element.style.display === 'block') {
    return core.preview.element;
  }
  const mode = core.currentMode;
  return (core[mode] && core[mode].element) || null;
}

function updateBackTopPosition() {
  if (!els.backTop) return;
  // 按钮停在大纲左侧，避免遮住大纲和控制柄；大纲隐藏时自动贴回正文右缘。
  const outline = document.querySelector('.vditor-outline');
  const outlineWidth = outline && outline.offsetWidth > 0 ? outline.offsetWidth : 0;
  els.backTop.style.right = `${outlineWidth + 20}px`;
}

function updateBackTopState() {
  if (!els.backTop) return;
  const scroller = editorScroller();
  const show = Boolean(
    scroller &&
    scroller.scrollTop > BACK_TOP_THRESHOLD &&
    els.editorShell.classList.contains('has-doc')
  );
  els.backTop.classList.toggle('is-visible', show);
  els.backTop.setAttribute('aria-hidden', show ? 'false' : 'true');
  els.backTop.tabIndex = show ? 0 : -1;
}

function bindBackTop() {
  const scroller = editorScroller();
  if (scroller && scroller !== backTopScroller) {
    if (backTopScroller) backTopScroller.removeEventListener('scroll', updateBackTopState);
    backTopScroller = scroller;
    scroller.addEventListener('scroll', updateBackTopState, { passive: true });
  }
  updateBackTopPosition();
  updateBackTopState();
}

function scrollEditorToTop() {
  const scroller = editorScroller();
  if (!scroller) return;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  scroller.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}

/* ---------------------------- 悬浮提示 ---------------------------- */

// Vditor 的提示是画在按钮上方的伪元素，会被工具栏的 overflow-y: hidden 裁掉，
// 这里改写成原生 title，原生提示不受裁剪影响。
function applyToolbarTitles() {
  document.querySelectorAll('.vditor-toolbar__item > [aria-label]').forEach((item) => {
    const raw = (item.getAttribute('aria-label') || '').trim();
    if (!raw) return;
    // 「粗体 <Ctrl+B>」统一成应用其他按钮的「粗体 (Ctrl+B)」写法
    const title = raw.replace(/\s*<([^<>]+)>\s*$/, ' ($1)');
    if (item.title !== title) item.title = title;
  });
}

// 大纲条目超长时只显示一行，补 title 让悬浮能看到完整标题。
function outlineItemTitle(item) {
  const label = item.querySelector(':scope > span');
  if (!label) return (item.textContent || '').replace(/\s+/g, ' ').trim();
  // KaTeX 会同时输出一份 MathML 和一份可见公式，去掉前者避免提示文字重复
  const clone = label.cloneNode(true);
  clone.querySelectorAll('.katex-mathml').forEach((node) => node.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

function applyOutlineTitles() {
  document.querySelectorAll('.vditor-outline span[data-target-id]').forEach((item) => {
    const title = outlineItemTitle(item);
    if (title && item.title !== title) item.title = title;
  });
}

let outlineTitleObserver = null;
let outlineTitleTarget = null;
let outlineContentObserver = null;
let outlineContentTarget = null;
let outlineTitleFrame = 0;
let outlineRetryTimer = null;
let outlineRetryCount = 0;
let outlineTitleInterval = null;

function scheduleOutlineTitles(attempt = 0) {
  if (outlineTitleFrame) return;
  outlineTitleFrame = requestAnimationFrame(() => {
    outlineTitleFrame = 0;
    applyOutlineTitles();

    // Vditor 的大纲可能比正文晚一拍更新；条目为空或缺少 title 时继续补。
    const items = Array.from(document.querySelectorAll('.vditor-outline span[data-target-id]'));
    if (attempt < 10 && (items.length === 0 || items.some((item) => !item.title))) {
      setTimeout(() => scheduleOutlineTitles(attempt + 1), 200);
    }
  });
}

// Vditor 每次输入都会重建大纲的 HTML，甚至可能替换大纲容器本身。
// 同时观察编辑器根节点，确保大纲晚出现或晚更新时 title 也能跟上。
function observeOutlineTitles() {
  // 兜底轮询：Vditor 重建大纲的时机不完全可预测，观察器偶发漏事件时也能补上。
  if (!outlineTitleInterval) {
    outlineTitleInterval = setInterval(() => {
      if (state.vditor) applyOutlineTitles();
    }, 600);
  }

  const outline = document.querySelector('.vditor-outline');
  if (outline && outline !== outlineTitleTarget) {
    outlineTitleObserver?.disconnect();
    outlineTitleTarget = outline;
    outlineTitleObserver = new MutationObserver(() => scheduleOutlineTitles());
    outlineTitleObserver.observe(outline, { childList: true, subtree: true, characterData: true });
    outlineRetryCount = 0;
  } else if (!outline && !outlineRetryTimer && outlineRetryCount < 20) {
    // after() 回调可能比大纲 DOM 更早执行；短间隔重试，直到大纲出现。
    outlineRetryCount += 1;
    outlineRetryTimer = setTimeout(() => {
      outlineRetryTimer = null;
      observeOutlineTitles();
    }, 200);
  }

  const editor = document.querySelector('.vditor');
  if (editor && editor !== outlineContentTarget) {
    outlineContentObserver?.disconnect();
    outlineContentTarget = editor;
    outlineContentObserver = new MutationObserver(() => {
      observeOutlineTitles();
      scheduleOutlineTitles();
    });
    outlineContentObserver.observe(editor, { childList: true, subtree: true });
  }

  scheduleOutlineTitles();
}

async function activateTab(ref, options = {}) {
  const tab = findTab(ref);
  if (!tab) return;

  const previous = activeTab();
  if (previous && !samePath(previous.path || previous.id, tab.path || tab.id)) {
    syncActiveContent();
    clearTimeout(state.autoSaveTimer);
    if (previous.dirty && previous.path) {
      await saveTab(previous, { silent: true, auto: true });
    }
  }

  if (state.findVisible) closeFind();

  state.activePath = tab.path || tab.id;
  await state.vditorReadyPromise;

  const wasDirty = tab.dirty;
  tab.loadingBaseline = true;
  tab.userMutation = false;
  state.loadingDoc = true;
  const token = ++state.docLoadToken;

  try {
    setLinkBase(tab.dirUrl);
    state.vditor.setValue(tab.content || '', true);
  } catch (error) {
    toast(`打开文档失败：${errorMessage(error)}`, 'error', 5000);
    console.error('[ReadMD] setValue failed', error);
  } finally {
    setTimeout(() => {
      if (token !== state.docLoadToken) return;
      state.loadingDoc = false;
      // Vditor 会把 Markdown 规范化（空行、列表符号等）。刚打开且没有未保存修改时，
      // 把规范化结果当作新的基线，避免“只切换标签页就触发自动保存”。
      // 如果这段时间里用户已经编辑（例如插入图片），不能再改基线，否则会漏保存。
      if (!wasDirty && tab.loadingBaseline && !tab.userMutation) {
        try {
          const normalized = state.vditor.getValue();
          if (normalized !== tab.content) {
            tab.content = normalized;
            tab.savedContent = normalized;
            tab.dirty = false;
            updateStatus();
            updateSaveButton();
            updateTitle();
          }
        } catch {
          // 保留原内容
        }
      }
      tab.loadingBaseline = false;
      tab.userMutation = false;
      updateContentResizer();
      updateBackTopState();
    }, 80);
  }

  els.editorShell.classList.add('has-doc');
  bindBackTop();
  renderTabs();
  updateActiveTree();
  updateStatus();
  updateSaveButton();
  updateTitle();
  updateContentResizer();
  updateOutlineResizer();
  saveSession();

  if (!options.skipFocus) {
    setTimeout(() => {
      try {
        state.vditor.focus();
      } catch {
        // 忽略焦点错误
      }
    }, 30);
  }
}

function setLinkBase(dirUrl) {
  try {
    if (state.vditor && state.vditor.vditor && state.vditor.vditor.lute) {
      state.vditor.vditor.lute.SetLinkBase(dirUrl || '');
    }
    if (state.vditor && state.vditor.options && state.vditor.options.preview) {
      state.vditor.options.preview.markdown.linkBase = dirUrl || '';
    }
  } catch (error) {
    console.warn('[ReadMD] 设置链接基准失败', error);
  }
}

function syncActiveContent() {
  if (state.loadingDoc || !state.vditor) return;
  const tab = activeTab();
  if (!tab) return;
  let value;
  try {
    value = state.vditor.getValue();
  } catch {
    return;
  }
  if (value !== tab.content) {
    tab.content = value;
    const dirty = value !== tab.savedContent;
    if (dirty !== tab.dirty) {
      tab.dirty = dirty;
      renderTabs();
      updateSaveButton();
      updateTitle();
    } else {
      tab.dirty = dirty;
    }
    updateStatus();
    api.setDirty(anyDirty());
  }
}

function handleEditorInput(value) {
  if (state.loadingDoc) return;
  const tab = activeTab();
  if (!tab) return;
  const content = typeof value === 'string' ? value : state.vditor.getValue();
  if (content === tab.content) return;
  tab.loadingBaseline = false;
  tab.userMutation = true;
  tab.content = content;
  const dirty = content !== tab.savedContent;
  if (dirty !== tab.dirty) {
    tab.dirty = dirty;
    renderTabs();
    updateSaveButton();
    updateTitle();
  }
  updateStatus();
  api.setDirty(anyDirty());
  if (tab.path) scheduleAutoSave(tab);
}

function scheduleAutoSave(tab) {
  clearTimeout(state.autoSaveTimer);
  state.autoSaveTimer = setTimeout(() => {
    const current = findTab(tab.path);
    if (current && current.dirty) {
      saveTab(current, { silent: true, auto: true });
    }
  }, AUTOSAVE_MS);
}

async function saveActive(options = {}) {
  const tab = activeTab();
  if (!tab) {
    toast('当前没有打开的文件');
    return false;
  }
  syncActiveContent();
  return saveTab(tab, options);
}

function saveTab(tab, options = {}) {
  if (!tab) return Promise.resolve(false);
  const key = tab.path ? normPath(tab.path) : tab.id;
  if (state.savingTabs.has(key)) return state.savingTabs.get(key);
  const promise = doSaveTab(tab, options).finally(() => {
    state.savingTabs.delete(key);
  });
  state.savingTabs.set(key, promise);
  return promise;
}

async function doSaveTab(tab, options = {}) {
  if (!tab.path && options.auto) return false;

  const wasActive = activeTab() === tab;
  const oldPath = tab.path;
  syncTabContent(tab);
  const content = tab.content || '';
  if (!options.saveAs && tab.path && content === tab.savedContent) {
    if (!options.silent) toast('没有需要保存的修改');
    return true;
  }

  updateStatus('保存中…');

  try {
    let result;
    if (options.saveAs || !tab.path) {
      result = await api.saveAs(content, tab.name || '未命名.md', tab.path, tab.eol);
      if (!result) {
        updateStatus();
        updateSaveButton();
        return false;
      }
      tab.path = result.path;
      tab.name = result.name || baseName(result.path);
      tab.dirUrl = result.dirUrl;
      tab.eol = result.eol || tab.eol;
      if (wasActive || !oldPath) state.activePath = tab.path;
      rememberRecentFile(tab.path);
    } else {
      result = await api.writeFile(tab.path, content, tab.eol);
      if (result && result.dirUrl) tab.dirUrl = result.dirUrl;
    }

    tab.content = content;
    tab.savedContent = content;
    tab.dirty = false;
    if (result && Number.isFinite(result.size)) tab.size = result.size;

    if (!options.silent) toast('已保存', 'ok');
    renderTabs();
    updateSaveButton();
    updateStatus();
    updateTitle();
    updateActiveTree();
    api.setDirty(anyDirty());
    saveSession();
    return true;
  } catch (error) {
    toast(`保存失败：${errorMessage(error)}`, 'error', 6000);
    updateStatus();
    updateSaveButton();
    return false;
  }
}

function syncTabContent(tab) {
  if (!tab) return '';
  if (samePath(tab.path, state.activePath) && !state.loadingDoc && state.vditor) {
    try {
      tab.content = state.vditor.getValue();
    } catch {
      // 保留已有内容
    }
  }
  return tab.content || '';
}

async function saveAll() {
  syncActiveContent();
  const dirtyTabs = state.tabs.filter((tab) => tab.dirty);
  for (const tab of dirtyTabs) {
    const ok = await saveTab(tab, { silent: true });
    if (!ok) return false;
  }
  return true;
}

async function saveAndClose() {
  const ok = await saveAll();
  if (!ok) {
    toast('保存失败，已取消关闭。请检查文件是否被占用。', 'error', 6000);
    return;
  }
  await api.closeWindow();
}

/* ------------------------------ 文档打开与标签页 ------------------------------ */

async function openFile(filePath, options = {}) {
  if (!filePath) return;
  const existing = findTab(filePath);
  if (existing) {
    await activateTab(existing.path || existing.id);
    return;
  }

  const key = normPath(filePath);
  if (state.openingPaths.has(key)) return;
  state.openingPaths.add(key);

  try {
    const data = await api.readFile(filePath);
    const duplicate = findTab(data.path);
    if (duplicate) {
      await activateTab(duplicate.path);
      return;
    }

    const tab = {
      id: crypto.randomUUID(),
      path: data.path,
      name: data.name || baseName(data.path),
      content: data.content || '',
      savedContent: data.content || '',
      eol: data.eol || '\n',
      dirUrl: data.dirUrl,
      dirty: false,
      size: data.size
    };

    state.tabs.push(tab);
    rememberRecentFile(tab.path);
    await activateTab(tab.path);
    updateActiveTree();
  } catch (error) {
    if (!options.silent) {
      toast(`无法打开文件：${errorMessage(error)}`, 'error', 5000);
    }
    console.warn('[ReadMD] openFile failed', filePath, error);
  } finally {
    state.openingPaths.delete(key);
  }
}

async function closeTab(ref) {
  const tab = findTab(ref);
  if (!tab) return;

  if (tab.dirty) {
    syncActiveContent();
    const choice = await showChoice(
      '是否保存修改？',
      `“${tab.name}”有未保存的修改。`,
      [
        { label: '保存', value: 'save', primary: true },
        { label: '不保存', value: 'discard', danger: true },
        { label: '取消', value: 'cancel' }
      ],
      'cancel'
    );
    if (!choice || choice === 'cancel') return;
    if (choice === 'save') {
      const ok = await saveTab(tab);
      if (!ok) return;
    }
  }

  const index = state.tabs.indexOf(tab);
  const wasActive = samePath(state.activePath, tab.path || tab.id);
  state.tabs.splice(index, 1);

  if (wasActive) {
    state.activePath = null;
    state.docLoadToken += 1;
    const next = state.tabs[Math.min(index, state.tabs.length - 1)];
    if (next) {
      await activateTab(next.path || next.id);
    } else {
      try {
        state.vditor.setValue('', true);
      } catch {
        // 忽略
      }
      showWelcome();
    }
  }

  renderTabs();
  updateSaveButton();
  updateStatus();
  updateTitle();
  updateActiveTree();
  api.setDirty(anyDirty());
  saveSession();
}

async function cycleTab(direction) {
  if (state.tabs.length < 2) return;
  const current = activeTab();
  const index = current ? state.tabs.indexOf(current) : 0;
  const next = state.tabs[(index + direction + state.tabs.length) % state.tabs.length];
  await activateTab(next.path || next.id);
}

function renderTabs() {
  els.tabbar.innerHTML = '';
  if (!state.tabs.length) {
    els.tabbar.classList.add('empty');
    return;
  }
  els.tabbar.classList.remove('empty');

  for (const tab of state.tabs) {
    const ref = tab.path || tab.id;
    const tabEl = document.createElement('div');
    tabEl.className = 'tab';
    tabEl.dataset.ref = ref;
    tabEl.title = tab.path || tab.name;
    if (samePath(state.activePath, ref)) tabEl.classList.add('active');
    if (tab.dirty) tabEl.classList.add('dirty');

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.name;

    const dot = document.createElement('span');
    dot.className = 'tab-dot';

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = '关闭 (Ctrl+W)';
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(ref);
    });

    tabEl.append(title, dot, close);
    tabEl.addEventListener('click', () => activateTab(ref));
    tabEl.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        closeTab(ref);
      }
    });
    els.tabbar.appendChild(tabEl);
  }

  const activeEl = els.tabbar.querySelector('.tab.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function showWelcome() {
  state.docLoadToken += 1;
  els.editorShell.classList.remove('has-doc');
  if (els.contentResizer) els.contentResizer.classList.add('hidden');
  if (els.outlineResizer) els.outlineResizer.classList.add('hidden');
  updateBackTopState();
  renderRecent();
  updateStatus();
  updateSaveButton();
  updateTitle();
}

function updateSaveButton() {
  const tab = activeTab();
  els.btnSave.disabled = !tab || !tab.dirty;
}

function updateStatus(message) {
  if (message) {
    els.statusLeft.textContent = message;
    return;
  }

  const tab = activeTab();
  if (!tab) {
    els.statusLeft.textContent = state.root ? `文件夹：${state.root}` : '就绪';
    els.statusLeft.title = state.root || '';
    els.statusCount.textContent = '';
    els.statusSave.textContent = '';
    els.statusSave.className = 'status-item';
    return;
  }

  els.statusLeft.textContent = tab.path || tab.name;
  els.statusLeft.title = tab.path || tab.name;
  const text = tab.content || '';
  const chars = Array.from(text).length;
  const lines = text ? text.split(/\r?\n/).length : 0;
  els.statusCount.textContent = `${chars} 字符 · ${lines} 行`;
  els.statusSave.textContent = tab.dirty ? '未保存' : '已保存';
  els.statusSave.className = `status-item ${tab.dirty ? 'dirty' : 'saved'}`;
}

function updateTitle() {
  const tab = activeTab();
  const title = tab ? `${tab.dirty ? '● ' : ''}${tab.name}` : '';
  if (title === state.lastTitle) return;
  state.lastTitle = title;
  api.setTitle(title).catch(() => {});
}

let sessionTimer = null;
function saveSession() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    api.saveState({
      openFiles: state.tabs.map((tab) => tab.path).filter(Boolean),
      activeFile: activeTab()?.path || null
    }).catch(() => {});
  }, 350);
}

/* ------------------------------ 文件树 ------------------------------ */

const ICONS = {
  chevron: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h4l1.5 2H16a1.5 1.5 0 0 1 1.5 1.5V15A1.5 1.5 0 0 1 16 16.5H4A1.5 1.5 0 0 1 2.5 15V4.5Z"/></svg>',
  markdown: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2h6l4 4v12H5V2Zm6 1.5V7h3.5L11 3.5ZM7 10h6v1.2H7V10Zm0 3h6v1.2H7V13Z"/></svg>',
  text: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2h10v16H5V2Zm2 4h6v1.2H7V6Zm0 3h6v1.2H7V9Zm0 3h4v1.2H7V12Z"/></svg>',
  image: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 4h14v12H3V4Zm2 2v8h10V6H5Zm1.8 6.8 2.4-2.9 1.5 1.7 1.6-2.1 2.2 3.3H6.8Z"/></svg>',
  file: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2h6l4 4v12H5V2Zm6 1.5V7h3.5L11 3.5Z"/></svg>'
};

let treeToken = 0;

async function loadFolder(folderPath, options = {}) {
  state.root = folderPath;
  state.rootName = baseName(folderPath) || folderPath;
  state.expandedDirs = new Set();
  els.folderName.textContent = state.rootName;
  els.folderName.title = folderPath;
  await renderTree();

  api.saveState({ lastFolder: folderPath }).catch(() => {});
  if (options.remember !== false) rememberRecentFolder(folderPath);
}

async function renderTree() {
  const hasRoot = Boolean(state.root);
  const openFolderBtn = document.getElementById('btn-open-folder');
  const sidebarFolder = document.querySelector('.sidebar-folder');
  const sectionLabel = document.querySelector('.section-label');
  if (openFolderBtn) openFolderBtn.style.display = hasRoot ? '' : 'none';
  if (sidebarFolder) sidebarFolder.style.display = hasRoot ? '' : 'none';
  if (sectionLabel) sectionLabel.style.display = hasRoot ? '' : 'none';

  if (!state.root) {
    els.fileTree.innerHTML = '';
    els.fileTree.style.display = 'none';
    els.sidebarEmpty.style.display = 'flex';
    return;
  }

  els.sidebarEmpty.style.display = 'none';
  els.fileTree.style.display = '';
  const token = ++treeToken;
  els.fileTree.innerHTML = '<div class="tree-loading">正在读取…</div>';

  try {
    const entries = await api.readDir(state.root);
    if (token !== treeToken) return;
    els.fileTree.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = '这个文件夹是空的';
      els.fileTree.appendChild(empty);
      return;
    }
    await appendEntries(els.fileTree, entries, 0, token);
    updateActiveTree();
  } catch (error) {
    if (token !== treeToken) return;
    els.fileTree.innerHTML = '';
    const failed = document.createElement('div');
    failed.className = 'tree-empty';
    failed.textContent = `无法读取文件夹：${errorMessage(error)}`;
    els.fileTree.appendChild(failed);
  }
}

async function appendEntries(container, entries, depth, token) {
  for (const entry of entries) {
    if (token !== treeToken) return;
    const row = makeTreeRow(entry, depth);
    container.appendChild(row);

    const expanded = entry.isDir && state.expandedDirs.has(normPath(entry.path));
    if (expanded && depth < 12) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      container.appendChild(children);
      try {
        const items = await api.readDir(entry.path);
        if (token !== treeToken) return;
        if (!items.length) {
          const empty = document.createElement('div');
          empty.className = 'tree-empty';
          empty.textContent = '空文件夹';
          children.appendChild(empty);
        } else {
          await appendEntries(children, items, depth + 1, token);
        }
      } catch (error) {
        const failed = document.createElement('div');
        failed.className = 'tree-empty';
        failed.textContent = '无法读取';
        children.appendChild(failed);
      }
    }
  }
}

function makeTreeRow(entry, depth) {
  const row = document.createElement('div');
  row.className = 'tree-row';
  row.dataset.path = entry.path;
  row.dataset.kind = entry.isDir ? 'dir' : 'file';
  row.style.setProperty('--depth', String(depth));
  row.title = entry.path;

  if (entry.isDir) {
    row.classList.add('is-dir');
    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    if (state.expandedDirs.has(normPath(entry.path))) chevron.classList.add('open');
    chevron.innerHTML = ICONS.chevron;
    row.appendChild(chevron);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'tree-chevron';
    row.appendChild(spacer);
  }

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  const iconClass = iconClassFor(entry);
  if (iconClass) icon.classList.add(iconClass);
  icon.innerHTML = iconFor(entry);
  row.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = entry.name;
  row.appendChild(name);

  if (!entry.isDir && !isMarkdown(entry)) row.classList.add('unsupported');

  row.addEventListener('click', () => {
    if (entry.isDir) {
      toggleDir(entry);
    } else if (isMarkdown(entry)) {
      openFile(entry.path);
    } else if (isImage(entry)) {
      toast('图片文件请在资源管理器中查看，或直接把图片拖进 Markdown 文档。');
    } else {
      toast('当前只支持打开 Markdown / 文本文件。');
    }
  });

  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showEntryContext(entry, event.clientX, event.clientY);
  });

  return row;
}

function iconFor(entry) {
  if (entry.isDir) return ICONS.folder;
  const ext = entry.ext || extOf(entry.name);
  if (MD_EXT.has(ext)) return ICONS.markdown;
  if (IMAGE_EXT.has(ext)) return ICONS.image;
  return ICONS.file;
}

function iconClassFor(entry) {
  if (entry.isDir) return '';
  const ext = entry.ext || extOf(entry.name);
  if (MD_EXT.has(ext)) return 'md';
  if (IMAGE_EXT.has(ext)) return 'image';
  return '';
}

async function toggleDir(entry) {
  const key = normPath(entry.path);
  if (state.expandedDirs.has(key)) state.expandedDirs.delete(key);
  else state.expandedDirs.add(key);
  await renderTree();
}

function updateActiveTree() {
  if (!state.activePath) return;
  els.fileTree.querySelectorAll('.tree-row').forEach((row) => {
    row.classList.toggle('active', samePath(row.dataset.path, state.activePath));
  });
}

/* ------------------------------ 右键菜单与文件操作 ------------------------------ */

function showEntryContext(entry, x, y) {
  if (entry.isDir) {
    showContextMenu(x, y, [
      { label: '新建 Markdown 文件…', action: () => createFileIn(entry.path) },
      { label: '新建文件夹…', action: () => createFolderIn(entry.path) },
      { sep: true },
      { label: '在资源管理器中显示', action: () => api.reveal(entry.path) },
      { sep: true },
      { label: '重命名…', action: () => renameEntry(entry) },
      { label: '移到回收站', danger: true, action: () => deleteEntry(entry) }
    ]);
    return;
  }

  showContextMenu(x, y, [
    { label: '打开', action: () => openFile(entry.path) },
    { label: '在资源管理器中显示', action: () => api.reveal(entry.path) },
    { sep: true },
    { label: '重命名…', action: () => renameEntry(entry) },
    { label: '移到回收站', danger: true, action: () => deleteEntry(entry) }
  ]);
}

function showRootContext(x, y) {
  if (!state.root) return;
  showContextMenu(x, y, [
    { label: '新建 Markdown 文件…', action: () => createFileIn(state.root) },
    { label: '新建文件夹…', action: () => createFolderIn(state.root) },
    { sep: true },
    { label: '刷新文件树', hint: 'F5', action: () => renderTree() },
    { label: '在资源管理器中显示', action: () => api.reveal(state.root) }
  ]);
}

function showContextMenu(x, y, items) {
  hideContextMenu();
  els.contextMenu.innerHTML = '';

  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'context-sep';
      els.contextMenu.appendChild(sep);
      continue;
    }
    const row = document.createElement('div');
    row.className = `context-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`;
    const label = document.createElement('span');
    label.textContent = item.label;
    row.appendChild(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'context-hint';
      hint.textContent = item.hint;
      row.appendChild(hint);
    }
    row.addEventListener('click', () => {
      hideContextMenu();
      if (!item.disabled && item.action) safe(item.action)();
    });
    els.contextMenu.appendChild(row);
  }

  els.contextMenu.classList.remove('hidden');
  const rect = els.contextMenu.getBoundingClientRect();
  els.contextMenu.style.left = `${Math.max(6, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  els.contextMenu.style.top = `${Math.max(6, Math.min(y, window.innerHeight - rect.height - 8))}px`;
}

function hideContextMenu() {
  els.contextMenu.classList.add('hidden');
}

async function createFileIn(parentDir) {
  if (!parentDir) {
    await newFile();
    return;
  }
  const name = await showPrompt('新建 Markdown 文件', '未命名.md', '输入文件名，可以省略 .md 后缀');
  if (!name) return;

  try {
    const created = await api.createFile(parentDir, name);
    state.expandedDirs.add(normPath(parentDir));
    await renderTree();
    await openFile(created.path);
  } catch (error) {
    toast(`新建文件失败：${errorMessage(error)}`, 'error', 5000);
  }
}

async function createFolderIn(parentDir) {
  if (!parentDir) {
    toast('请先打开一个文件夹');
    return;
  }
  const name = await showPrompt('新建文件夹', '新文件夹', '输入文件夹名称');
  if (!name) return;

  try {
    await api.createFolder(parentDir, name);
    state.expandedDirs.add(normPath(parentDir));
    await renderTree();
  } catch (error) {
    toast(`新建文件夹失败：${errorMessage(error)}`, 'error', 5000);
  }
}

async function renameEntry(entry) {
  const name = await showPrompt('重命名', entry.name, '输入新名称');
  if (!name || name === entry.name) return;

  try {
    const result = await api.rename(entry.path, name);
    await updatePathsAfterRename(entry, result.path);
    await renderTree();
    renderTabs();
    updateStatus();
    updateTitle();
    saveSession();
  } catch (error) {
    toast(`重命名失败：${errorMessage(error)}`, 'error', 5000);
  }
}

async function updatePathsAfterRename(entry, newPath) {
  const oldKey = normPath(entry.path);
  const newKey = normPath(newPath);

  if (entry.isDir) {
    const expandedUpdates = [];
    for (const key of state.expandedDirs) {
      if (key === oldKey || key.startsWith(`${oldKey}/`)) {
        expandedUpdates.push([key, `${newKey}${key.slice(oldKey.length)}`]);
      }
    }
    for (const [oldDir, newDir] of expandedUpdates) {
      state.expandedDirs.delete(oldDir);
      state.expandedDirs.add(newDir);
    }

    if (state.activePath) {
      const activeKey = normPath(state.activePath);
      if (activeKey === oldKey || activeKey.startsWith(`${oldKey}/`)) {
        state.activePath = newPath + state.activePath.slice(entry.path.length);
      }
    }

    for (const tab of state.tabs) {
      if (!tab.path) continue;
      const tabKey = normPath(tab.path);
      if (tabKey === oldKey || tabKey.startsWith(`${oldKey}/`)) {
        tab.path = newPath + tab.path.slice(entry.path.length);
        tab.name = baseName(tab.path);
        tab.dirUrl = await api.dirUrl(dirName(tab.path));
      }
    }
  } else {
    const tab = findTab(entry.path);
    if (tab) {
      tab.path = newPath;
      tab.name = baseName(newPath);
    }
    if (samePath(state.activePath, entry.path)) state.activePath = newPath;
  }

  const active = activeTab();
  if (active) {
    setLinkBase(active.dirUrl);
    updateTitle();
  }
}

async function deleteEntry(entry) {
  const prefix = normPath(entry.path);
  const affected = state.tabs.filter((tab) => {
    if (!tab.path) return false;
    const tabKey = normPath(tab.path);
    return tabKey === prefix || tabKey.startsWith(`${prefix}/`);
  });
  const dirtyCount = affected.filter((tab) => tab.dirty).length;

  const choice = await showChoice(
    '移到回收站？',
    `“${entry.name}”将被移到系统回收站。${affected.length ? `\n会同时关闭 ${affected.length} 个已打开的标签。` : ''}${dirtyCount ? `\n其中有 ${dirtyCount} 个文件有未保存的修改。` : ''}`,
    [
      { label: '取消', value: 'cancel' },
      { label: '移到回收站', value: 'trash', danger: true }
    ],
    'cancel'
  );
  if (choice !== 'trash') return;

  try {
    await api.trash(entry.path);
    const activeAffected = affected.some((tab) => samePath(state.activePath, tab.path || tab.id));
    state.tabs = state.tabs.filter((tab) => !affected.includes(tab));
    if (activeAffected) {
      state.activePath = null;
      const next = state.tabs[0];
      if (next) await activateTab(next.path || next.id);
      else {
        try {
          state.vditor.setValue('', true);
        } catch {
          // 忽略
        }
        showWelcome();
      }
    }
    renderTabs();
    updateSaveButton();
    updateStatus();
    updateTitle();
    api.setDirty(anyDirty());
    await renderTree();
    saveSession();
    toast('已移到回收站', 'ok');
  } catch (error) {
    toast(`删除失败：${errorMessage(error)}`, 'error', 5000);
  }
}

/* ------------------------------ 打开/新建 ------------------------------ */

async function openFolderDialog() {
  try {
    const result = await api.openFolder();
    if (!result) return;
    await loadFolder(result.path);
    rememberRecentFolder(result.path);
  } catch (error) {
    toast(`打开文件夹失败：${errorMessage(error)}`, 'error', 5000);
  }
}

async function openFileDialog() {
  try {
    const result = await api.openFile();
    if (!result) return;
    await openFile(result.path);
    rememberRecentFile(result.path);
  } catch (error) {
    toast(`打开文件失败：${errorMessage(error)}`, 'error', 5000);
  }
}

async function newFile() {
  try {
    if (!state.root) {
      const result = await api.saveAs('', '未命名.md', null, '\n');
      if (!result) return;
      const tab = {
        id: crypto.randomUUID(),
        path: result.path,
        name: result.name || baseName(result.path),
        content: result.content || '',
        savedContent: result.content || '',
        eol: result.eol || '\n',
        dirUrl: result.dirUrl,
        dirty: false,
        size: result.size
      };
      state.tabs.push(tab);
      rememberRecentFile(tab.path);
      await activateTab(tab.path);
      return;
    }
    await createFileIn(state.root);
  } catch (error) {
    toast(`新建文件失败：${errorMessage(error)}`, 'error', 5000);
  }
}

async function saveAsActive() {
  const tab = activeTab();
  if (!tab) {
    toast('当前没有打开的文件');
    return;
  }
  syncActiveContent();
  await saveTab(tab, { saveAs: true });
}

/* ------------------------------ 最近记录 ------------------------------ */

function rememberRecentFolder(folder) {
  if (!folder) return;
  state.recentFolders = [folder, ...state.recentFolders.filter((item) => !samePath(item, folder))].slice(0, MAX_RECENT);
  api.saveState({ recentFolders: state.recentFolders }).catch(() => {});
  renderRecent();
}

function rememberRecentFile(filePath) {
  if (!filePath) return;
  state.recentFiles = [filePath, ...state.recentFiles.filter((item) => !samePath(item, filePath))].slice(0, MAX_RECENT);
  api.saveState({ recentFiles: state.recentFiles }).catch(() => {});
  renderRecent();
}

function renderRecent() {
  renderRecentList(els.recentFolders, state.recentFolders, 'folder');
  renderRecentList(els.recentFiles, state.recentFiles, 'file');
}

function renderRecentList(container, items, kind) {
  container.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('li');
    empty.className = 'recent-empty';
    empty.textContent = '暂无记录';
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = kind === 'folder' ? baseName(item) || item : baseName(item);
    const pathEl = document.createElement('span');
    pathEl.className = 'recent-path';
    pathEl.textContent = item;
    li.append(name, pathEl);
    li.title = item;
    li.addEventListener('click', () => {
      if (kind === 'folder') {
        loadFolder(item).then(() => rememberRecentFolder(item)).catch((error) => {
          toast(`无法打开文件夹：${errorMessage(error)}`, 'error', 5000);
        });
      } else {
        openFile(item);
      }
    });
    container.appendChild(li);
  }
}

/* ------------------------------ 主题与侧边栏 ------------------------------ */

function applyTheme(theme, persist = true) {
  state.theme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = state.theme;
  document.documentElement.style.colorScheme = state.theme;
  api.setNativeTheme(state.theme).catch(() => {});

  if (state.vditor) {
    try {
      state.vditor.setTheme(
        state.theme === 'dark' ? 'dark' : 'classic',
        state.theme === 'dark' ? 'dark' : 'light',
        state.theme === 'dark' ? 'monokai' : 'github',
        `${CDN}/dist/css/content-theme`
      );
    } catch (error) {
      console.warn('[ReadMD] 切换编辑器主题失败', error);
    }
  }

  if (persist) api.saveState({ theme: state.theme }).catch(() => {});
}

function toggleTheme() {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
}

function applySidebar(persist = true) {
  state.sidebarWidth = clamp(Number(state.sidebarWidth) || 278, 220, 420);
  els.sidebar.classList.toggle('hidden', !state.sidebarVisible);
  els.sidebarResizer.style.display = state.sidebarVisible ? '' : 'none';
  document.documentElement.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`);
  scheduleContentResizer();
  if (persist) {
    api.saveState({
      sidebarVisible: state.sidebarVisible,
      sidebarWidth: state.sidebarWidth
    }).catch(() => {});
  }
}

function setSidebarWidth(width) {
  state.sidebarWidth = clamp(Math.round(width), 220, 420);
  document.documentElement.style.setProperty('--sidebar-width', `${state.sidebarWidth}px`);
  scheduleContentResizer();
}

let editorResizeObserver = null;
let contentResizerFrame = null;

function observeEditorLayout() {
  if (typeof ResizeObserver === 'undefined') return;
  const ir = document.querySelector('.vditor-ir') || document.querySelector('.vditor-wysiwyg');
  if (!ir) return;
  if (editorResizeObserver) editorResizeObserver.disconnect();
  editorResizeObserver = new ResizeObserver(() => scheduleContentResizer());
  editorResizeObserver.observe(ir);
  editorResizeObserver.observe(els.editorShell);
  const outline = document.querySelector('.vditor-outline');
  if (outline) editorResizeObserver.observe(outline);
}

function scheduleContentResizer() {
  if (contentResizerFrame) cancelAnimationFrame(contentResizerFrame);
  contentResizerFrame = requestAnimationFrame(() => {
    updateContentResizer();
    updateOutlineResizer();
    updateBackTopPosition();
  });
}

function applyContentWidth(width, persist = true) {
  state.editorContentWidth = clamp(Math.round(Number(width) || 920), 560, 1600);
  document.documentElement.style.setProperty('--editor-content-width', `${state.editorContentWidth}px`);
  if (persist) {
    api.saveState({ editorContentWidth: state.editorContentWidth }).catch(() => {});
  }
  updateContentResizer();
}

function applyOutlineWidth(width, persist = true) {
  state.outlineWidth = clamp(Math.round(Number(width) || 230), 160, 480);
  document.documentElement.style.setProperty('--outline-width', `${state.outlineWidth}px`);
  if (persist) {
    api.saveState({ outlineWidth: state.outlineWidth }).catch(() => {});
  }
  scheduleContentResizer();
}

function updateOutlineResizer() {
  const handle = els.outlineResizer;
  const outline = document.querySelector('.vditor-outline');
  if (!handle) return;
  if (!activeTab() || !outline || outline.offsetWidth === 0 || !els.editorShell.classList.contains('has-doc')) {
    handle.classList.add('hidden');
    return;
  }

  const shellRect = els.editorShell.getBoundingClientRect();
  const outlineRect = outline.getBoundingClientRect();
  handle.style.left = `${Math.max(0, outlineRect.left - shellRect.left - 5)}px`;
  handle.style.top = `${outlineRect.top - shellRect.top}px`;
  handle.style.height = `${outlineRect.height}px`;
  handle.classList.remove('hidden');
}

function updateContentResizer() {
  const handle = els.contentResizer;
  if (!handle) return;
  const tab = activeTab();
  const ir = document.querySelector('.vditor-ir') || document.querySelector('.vditor-wysiwyg');
  if (!tab || !ir || !els.editorShell.classList.contains('has-doc')) {
    handle.classList.add('hidden');
    return;
  }

  const shellRect = els.editorShell.getBoundingClientRect();
  const irRect = ir.getBoundingClientRect();
  // 小窗口下正文会先占满可用宽度（左右各保留 32px），拖拽手柄要贴在实际正文右边缘。
  const maxAvailable = Math.max(560, irRect.width - 64);
  const effectiveWidth = Math.min(state.editorContentWidth, maxAvailable);
  const contentRight = irRect.width / 2 + effectiveWidth / 2;
  const left = irRect.left - shellRect.left + contentRight;

  handle.style.left = `${Math.max(0, left - 7)}px`;
  handle.style.top = `${irRect.top - shellRect.top}px`;
  handle.style.height = `${irRect.height}px`;
  handle.classList.remove('hidden');
}

function initOutlineResizer() {
  const handle = els.outlineResizer;
  if (!handle) return;

  handle.addEventListener('mousedown', (event) => {
    if (!activeTab() || event.button !== 0 || handle.classList.contains('hidden')) return;
    event.preventDefault();

    const startX = event.clientX;
    const maxWidth = Math.max(160, Math.min(480, window.innerWidth - 560));
    const startWidth = Math.min(state.outlineWidth, maxWidth);

    const onMove = (moveEvent) => {
      const next = clamp(startWidth - (moveEvent.clientX - startX), 160, maxWidth);
      applyOutlineWidth(next, false);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.classList.remove('dragging');
      applyOutlineWidth(state.outlineWidth, true);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  handle.addEventListener('dblclick', () => applyOutlineWidth(230, true));
}

function initContentResizer() {
  const handle = els.contentResizer;
  if (!handle) return;

  handle.addEventListener('mousedown', (event) => {
    if (!activeTab() || event.button !== 0) return;
    event.preventDefault();

    const startX = event.clientX;
    const ir = document.querySelector('.vditor-ir') || document.querySelector('.vditor-wysiwyg');
    const maxWidth = ir
      ? Math.max(560, Math.min(1600, Math.round(ir.getBoundingClientRect().width - 64)))
      : 1600;
    const startWidth = Math.min(state.editorContentWidth, maxWidth);

    const onMove = (moveEvent) => {
      const next = clamp(startWidth + (moveEvent.clientX - startX) * 2, 560, maxWidth);
      applyContentWidth(next, false);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.classList.remove('dragging');
      applyContentWidth(state.editorContentWidth, true);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    handle.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  handle.addEventListener('dblclick', () => applyContentWidth(920, true));
}

function toggleSidebar() {
  state.sidebarVisible = !state.sidebarVisible;
  applySidebar();
}

function initResizer() {
  els.sidebarResizer.addEventListener('mousedown', (event) => {
    if (!state.sidebarVisible) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = state.sidebarWidth;

    const onMove = (moveEvent) => {
      setSidebarWidth(startWidth + moveEvent.clientX - startX);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      els.sidebarResizer.classList.remove('dragging');
      api.saveState({ sidebarWidth: state.sidebarWidth }).catch(() => {});
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    els.sidebarResizer.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  els.sidebarResizer.addEventListener('dblclick', () => {
    setSidebarWidth(278);
    applySidebar();
  });
}

/* ------------------------------ 查找 ------------------------------ */

function openFind() {
  if (!activeTab()) {
    toast('请先打开一个文件');
    return;
  }
  state.findVisible = true;
  els.findbar.classList.remove('hidden');
  els.findInput.focus();
  els.findInput.select();
  if (els.findInput.value) runFind(true, false);
}

function closeFind() {
  state.findVisible = false;
  els.findbar.classList.add('hidden');
  els.findCount.textContent = '0/0';
  state.findText = '';
  api.stopFindInPage('clearSelection').catch(() => {});
}

async function runFind(forward, followUp) {
  const text = els.findInput.value;
  if (!text) {
    state.findText = '';
    els.findCount.textContent = '0/0';
    await api.stopFindInPage('clearSelection').catch(() => {});
    return;
  }

  const isNewSearch = text !== state.findText;
  if (isNewSearch) state.findText = text;

  try {
    // Electron 的 findNext=true 表示“开始新的查找会话”，false 表示继续上一个会话。
    await api.findInPage(text, {
      forward,
      findNext: isNewSearch ? true : !followUp,
      matchCase: false
    });
  } catch (error) {
    console.warn('[ReadMD] find failed', error);
  }
}

function onFindResult(result) {
  if (!result) return;
  state.lastFindResult = result;
  if (!state.findVisible) return;
  if (!result.matches) {
    els.findCount.textContent = '无结果';
    return;
  }
  els.findCount.textContent = `${result.activeMatchOrdinal || 0}/${result.matches}`;
}

/* ------------------------------ 导出 ------------------------------ */

/* ------------------------------ AI 助手桥接 ------------------------------ */

function aiGetDocument() {
  try {
    return state.vditor ? state.vditor.getValue() : '';
  } catch {
    return '';
  }
}

function aiGetSelection() {
  try {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return '';
    const text = selection.toString().trim();
    if (!text) return '';
    const anchor = selection.anchorNode;
    const element = anchor && anchor.nodeType === 3 ? anchor.parentElement : anchor;
    if (element && els.vditor.contains(element)) return text.slice(0, 8000);
  } catch {
    // 忽略
  }
  return '';
}

function aiGetContext() {
  const tab = activeTab();
  return {
    document: aiGetDocument(),
    selection: aiGetSelection(),
    fileName: tab ? tab.name : '',
    filePath: tab && tab.path ? tab.path : null,
    rootPath: state.root || null
  };
}

function applyAIDocument(content) {
  const tab = activeTab();
  if (!tab || !state.vditor) return null;

  const before = state.vditor.getValue();
  const next = String(content);
  state.loadingDoc = true;
  tab.loadingBaseline = false;
  tab.userMutation = true;
  state.docLoadToken += 1;

  try {
    state.vditor.setValue(next, true);
  } finally {
    state.loadingDoc = false;
  }

  tab.content = next;
  tab.dirty = next !== tab.savedContent;
  renderTabs();
  updateSaveButton();
  updateStatus();
  updateTitle();
  api.setDirty(anyDirty());
  if (tab.path) scheduleAutoSave(tab);
  return before;
}

async function renderAIMarkdown(text) {
  if (window.Vditor && typeof window.Vditor.md2html === 'function') {
    try {
      const html = await window.Vditor.md2html(String(text || ''), { cdn: CDN });
      const container = document.createElement('div');
      container.innerHTML = html;
      container.querySelectorAll('script, iframe, object, embed, link, meta, style').forEach((node) => node.remove());
      container.querySelectorAll('*').forEach((element) => {
        for (const attribute of Array.from(element.attributes)) {
          if (/^on/i.test(attribute.name)) element.removeAttribute(attribute.name);
        }
      });
      return container.innerHTML;
    } catch {
      // 退回纯文本
    }
  }
  return escapeHtmlText(text).replace(/\n/g, '<br>');
}

function initAIBridge() {
  if (!window.readmdAI || typeof window.readmdAI.init !== 'function') {
    window.addEventListener('load', initAIBridge, { once: true });
    return;
  }
  window.readmdAI.init({
    getDocument: aiGetDocument,
    getSelection: aiGetSelection,
    getContext: aiGetContext,
    applyDocument: applyAIDocument,
    renderMarkdown: renderAIMarkdown,
    toast,
    openFile: (filePath) => openFile(filePath, { silent: true }),
    refreshTree: () => renderTree()
  });
}

function escapeHtmlText(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function ensureKatex() {
  if (window.katex && typeof window.katex.renderToString === 'function') return window.katex;

  // Vditor 会在第一次遇到公式时异步加载 KaTeX；导出前给它一点时间。
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1500) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (window.katex && typeof window.katex.renderToString === 'function') {
      return window.katex;
    }
  }

  await new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = `${CDN}/dist/js/katex/katex.min.js`;
    script.onload = resolve;
    script.onerror = resolve;
    document.head.appendChild(script);
  });

  return window.katex && typeof window.katex.renderToString === 'function' ? window.katex : null;
}

/**
 * Vditor 的公式节点只带 data-math 和 KaTeX 的 HTML，没有 MathML。
 * Word 需要 MathML 才能转成原生公式，所以导出前用 KaTeX 重新渲染成
 * “HTML + MathML”：PDF 用 HTML 显示，Word 用 MathML 转公式。
 */
async function upgradeMathForExport(container) {
  const elements = Array.from(container.querySelectorAll('[data-math], .language-math'));
  if (!elements.length) return;

  const katex = await ensureKatex();
  for (const element of elements) {
    const latex = element.getAttribute('data-math') || element.textContent || '';
    if (!latex.trim()) continue;

    if (katex) {
      try {
        element.innerHTML = katex.renderToString(latex, {
          displayMode: element.tagName === 'DIV',
          output: 'htmlAndMathml',
          throwOnError: false,
          strict: 'ignore'
        });
        continue;
      } catch {
        // 退回下面的纯文本公式
      }
    }

    element.innerHTML = `<math xmlns="http://www.w3.org/1998/Math/MathML"><mtext>${escapeHtmlText(latex)}</mtext></math>`;
  }
}

function exportTitleFromHtml(html, fallback) {
  try {
    const container = document.createElement('div');
    container.innerHTML = html;
    const heading = container.querySelector('h1');
    if (heading) {
      heading.querySelectorAll('.katex-mathml').forEach((node) => node.remove());
      const text = (heading.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 200);
    }
  } catch {
    // 使用文件名兜底
  }
  return fallback;
}

function resolveExportLinks(container, dirUrl) {
  if (!dirUrl) return;

  container.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src || /^(https?:|data:|file:|blob:)/i.test(src)) return;
    try {
      img.setAttribute('src', new URL(src, dirUrl).href);
    } catch {
      // 保留原值
    }
  });

  container.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href');
    if (!href || /^(https?:|mailto:|#|file:)/i.test(href)) return;
    try {
      anchor.setAttribute('href', new URL(href, dirUrl).href);
    } catch {
      // 保留原值
    }
  });
}

async function buildExportPayloadFromHtml({ html, title, dirUrl, baseDir, settings }) {
  const container = document.createElement('div');
  container.innerHTML = html;

  await upgradeMathForExport(container);
  resolveExportLinks(container, dirUrl);

  return {
    title,
    html: container.innerHTML,
    baseDir,
    settings: settings ? { ...state.exportSettings, ...settings } : { ...state.exportSettings }
  };
}

async function buildExportPayload(tab, overrideSettings) {
  const contentHtml = state.vditor.getHTML();
  const fallbackTitle = tab.name.replace(/\.(md|markdown|mdown|mkd|txt|text)$/i, '');
  return buildExportPayloadFromHtml({
    html: contentHtml,
    title: exportTitleFromHtml(contentHtml, fallbackTitle),
    dirUrl: tab.dirUrl,
    baseDir: tab.path ? dirName(tab.path) : null,
    settings: overrideSettings
  });
}

async function exportActive(kind) {
  const tab = activeTab();
  if (!tab) {
    toast('请先打开一个文件');
    return;
  }

  syncActiveContent();
  const payload = await buildExportPayload(tab);
  if (!payload.html.trim()) {
    toast('当前文档没有可导出的内容');
    return;
  }

  const stem = (payload.title || '未命名文档').slice(0, 80);
  const labels = { docx: 'Word 文档', pdf: 'PDF', html: 'HTML' };
  try {
    toast(`正在生成 ${labels[kind] || '文档'}…`);
    let result;
    if (kind === 'docx') {
      result = await api.exportDocx(payload, `${stem}.docx`, tab.path);
    } else if (kind === 'pdf') {
      result = await api.exportPdf(payload, `${stem}.pdf`, tab.path);
    } else {
      result = await api.exportHtml(payload, `${stem}.html`, tab.path);
    }

    if (!result) return;
    const warningCount = Array.isArray(result.warnings) ? result.warnings.length : 0;
    if (warningCount) {
      console.warn('[ReadMD] 导出警告', result.warnings);
      toast(`已导出：${result.path}（${warningCount} 处内容未完整转换）`, 'ok', 7000);
    } else {
      toast(`已导出：${result.path}`, 'ok', 4500);
    }
  } catch (error) {
    toast(`导出失败：${errorMessage(error)}`, 'error', 6000);
  }
}

function showExportMenu(anchor) {
  const rect = anchor.getBoundingClientRect();
  showContextMenu(rect.left, rect.bottom + 6, [
    { label: '导出 Word 文档', hint: '.docx', action: () => exportActive('docx') },
    { label: '导出 PDF 文档', hint: '.pdf', action: () => exportActive('pdf') },
    { label: '导出网页', hint: '.html', action: () => exportActive('html') },
    { sep: true },
    { label: '导出设置…', action: openExportSettings },
    { label: '批量导出当前文件夹…', action: batchExportFolder }
  ]);
}

function exportSettingsSummary() {
  const parts = [state.exportSettings.formal ? '正式排版（首行缩进）' : '通用排版'];
  parts.push(state.exportSettings.header ? '有页眉' : '无页眉');
  parts.push(state.exportSettings.footer ? '有页码' : '无页码');
  if (state.exportSettings.cover) parts.push('有封面');
  if (state.exportSettings.toc) parts.push('有目录');
  return parts.join(' · ');
}

function openExportSettings() {
  const root = els.modalRoot;
  root.innerHTML = '';
  root.classList.remove('hidden');

  const modal = document.createElement('div');
  modal.className = 'modal wide';
  modal.innerHTML = `
    <h2>导出设置</h2>
    <p>设置会应用到 Word、PDF 和 HTML，并记住你的选择。</p>
    <div class="modal-form">
      <div class="form-block">
        <div class="form-label">排版风格</div>
        <div class="segmented" data-role="style">
          <button type="button" data-style="general">通用文档</button>
          <button type="button" data-style="formal">正式文档</button>
        </div>
        <div class="form-hint" data-role="style-hint"></div>
      </div>
      <label class="form-row">
        <span class="form-copy"><span class="form-label">页眉</span><span class="form-hint">在每页顶部显示文档标题</span></span>
        <span class="switch"><input type="checkbox" data-setting="header"><span></span></span>
      </label>
      <label class="form-row">
        <span class="form-copy"><span class="form-label">页脚</span><span class="form-hint">在每页底部显示“第 X 页 / 共 Y 页”</span></span>
        <span class="switch"><input type="checkbox" data-setting="footer"><span></span></span>
      </label>
      <label class="form-row">
        <span class="form-copy"><span class="form-label">封面</span><span class="form-hint">生成独立封面页，标题使用文档一级标题</span></span>
        <span class="switch"><input type="checkbox" data-setting="cover"><span></span></span>
      </label>
      <div class="form-grid" data-role="cover-fields">
        <div class="form-field"><label for="export-cover-subtitle">封面副标题（可选）</label><input id="export-cover-subtitle" type="text" data-cover="subtitle" maxlength="120" placeholder="例如：2026 年第三季度"></div>
        <div class="form-field"><label for="export-cover-author">封面署名（可选）</label><input id="export-cover-author" type="text" data-cover="author" maxlength="80" placeholder="例如：张三 / 产品部"></div>
      </div>
      <label class="form-row">
        <span class="form-copy"><span class="form-label">目录</span><span class="form-hint">Word 目录带页码并由 Word 更新；PDF 目录可点击跳转，不含页码</span></span>
        <span class="switch"><input type="checkbox" data-setting="toc"><span></span></span>
      </label>
      <div class="form-hint form-note">提示：启用封面时，PDF 的封面页也会显示页眉/页脚；Word 会自动跳过封面页。</div>
    </div>
    <div class="modal-actions">
      <button class="btn" type="button" data-action="cancel">取消</button>
      <button class="btn primary" type="button" data-action="save">保存设置</button>
    </div>`;
  root.appendChild(modal);

  const styleButtons = Array.from(modal.querySelectorAll('[data-style]'));
  const styleHint = modal.querySelector('[data-role="style-hint"]');
  const headerInput = modal.querySelector('[data-setting="header"]');
  const footerInput = modal.querySelector('[data-setting="footer"]');
  const coverInput = modal.querySelector('[data-setting="cover"]');
  const tocInput = modal.querySelector('[data-setting="toc"]');
  const coverFields = modal.querySelector('[data-role="cover-fields"]');
  const subtitleInput = modal.querySelector('[data-cover="subtitle"]');
  const authorInput = modal.querySelector('[data-cover="author"]');

  let formal = Boolean(state.exportSettings.formal);

  const updateStyle = () => {
    styleButtons.forEach((button) => {
      button.classList.toggle('active', (button.dataset.style === 'formal') === formal);
    });
    styleHint.textContent = formal
      ? '正文首行缩进 2 字符，适合报告、论文和正式材料。'
      : '不缩进，用段间距区分段落，适合大多数 Markdown 文档。';
  };

  const updateCoverFields = () => {
    const disabled = !coverInput.checked;
    coverFields.classList.toggle('disabled', disabled);
    subtitleInput.disabled = disabled;
    authorInput.disabled = disabled;
  };

  headerInput.checked = Boolean(state.exportSettings.header);
  footerInput.checked = state.exportSettings.footer !== false;
  coverInput.checked = Boolean(state.exportSettings.cover);
  tocInput.checked = Boolean(state.exportSettings.toc);
  subtitleInput.value = state.exportSettings.coverSubtitle || '';
  authorInput.value = state.exportSettings.coverAuthor || '';
  updateStyle();
  updateCoverFields();

  styleButtons.forEach((button) => {
    button.addEventListener('click', () => {
      formal = button.dataset.style === 'formal';
      updateStyle();
    });
  });
  coverInput.addEventListener('change', updateCoverFields);

  const close = () => {
    root.removeEventListener('keydown', onKey);
    root.classList.add('hidden');
    root.innerHTML = '';
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const save = () => {
    state.exportSettings = {
      formal,
      header: headerInput.checked,
      footer: footerInput.checked,
      cover: coverInput.checked,
      toc: tocInput.checked,
      coverSubtitle: subtitleInput.value.trim().slice(0, 120),
      coverAuthor: authorInput.value.trim().slice(0, 80)
    };
    api.saveState({ exportSettings: { ...state.exportSettings } }).catch(() => {});
    close();
    toast('导出设置已保存', 'ok');
  };

  root.addEventListener('keydown', onKey);
  modal.querySelector('[data-action="cancel"]').addEventListener('click', close);
  modal.querySelector('[data-action="save"]').addEventListener('click', save);
  setTimeout(() => styleButtons[formal ? 1 : 0].focus(), 0);
}

/* ------------------------------ 默认打开方式 ------------------------------ */

async function refreshAssociationEntry() {
  const button = document.getElementById('welcome-default-app');
  if (!button) return;
  if (state.platform !== 'win32') {
    button.hidden = true;
    return;
  }

  try {
    const status = await api.fileAssociationStatus();
    state.associationStatus = status;
    button.hidden = false;
    button.classList.toggle('is-default', Boolean(status.isDefault));
    button.textContent = status.isDefault
      ? 'ReadMD 已是默认 Markdown 打开方式'
      : '双击 .md 文件时用 ReadMD 打开 →';
  } catch {
    button.hidden = true;
  }
}

async function openDefaultAppDialog() {
  if (state.platform !== 'win32') {
    toast('文件关联设置目前只支持 Windows 版本', 'info', 5000);
    return;
  }

  try {
    const status = await api.fileAssociationStatus();
    showAssociationModal(status);
  } catch (error) {
    toast(`读取文件关联失败：${errorMessage(error)}`, 'error', 5000);
  }
}

function showAssociationModal(initialStatus) {
  const root = els.modalRoot;
  root.innerHTML = '';
  root.classList.remove('hidden');

  const modal = document.createElement('div');
  modal.className = 'modal wide';
  modal.innerHTML = `
    <h2>双击 .md 文件时用 ReadMD 打开</h2>
    <p>Windows 不允许软件自己修改默认程序。点击“去设置”后，系统会弹出“打开方式”窗口：请选择 <strong>ReadMD</strong>，并勾选“始终使用此应用打开 .md 文件”。</p>
    <div class="assoc-status">
      <div class="assoc-row"><span>当前默认程序</span><strong data-role="handler">读取中…</strong></div>
      <div class="assoc-row"><span>ReadMD 注册状态</span><strong data-role="registered">读取中…</strong></div>
    </div>
    <p class="form-hint" data-role="hint"></p>
    <button class="assoc-remove" type="button" data-role="remove" hidden>从“打开方式”列表移除 ReadMD</button>
    <div class="modal-actions">
      <button class="btn" type="button" data-action="cancel">关闭</button>
      <button class="btn" type="button" data-action="settings">打开 Windows 设置</button>
      <button class="btn primary" type="button" data-action="setup">去设置</button>
    </div>`;
  root.appendChild(modal);

  const handlerEl = modal.querySelector('[data-role="handler"]');
  const registeredEl = modal.querySelector('[data-role="registered"]');
  const hintEl = modal.querySelector('[data-role="hint"]');
  const removeButton = modal.querySelector('[data-role="remove"]');
  const settingsButton = modal.querySelector('[data-action="settings"]');
  const setupButton = modal.querySelector('[data-action="setup"]');
  let pollTimer = null;
  let pollCount = 0;
  let current = initialStatus;

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const close = () => {
    stopPolling();
    root.removeEventListener('keydown', onKey);
    root.classList.add('hidden');
    root.innerHTML = '';
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  const render = (status) => {
    current = status;
    handlerEl.textContent = status.isDefault ? 'ReadMD（已是默认）' : (status.handlerLabel || '尚未设置');
    handlerEl.classList.toggle('ok', Boolean(status.isDefault));

    if (status.registered) {
      registeredEl.textContent = status.commandMatches ? '已注册' : '已注册（程序位置已变化，将自动更新）';
    } else {
      registeredEl.textContent = '未注册';
    }
    registeredEl.classList.toggle('ok', Boolean(status.registered));

    removeButton.hidden = !status.registered;
    if (status.isDefault) {
      hintEl.textContent = '设置完成。以后双击 .md、.markdown、.mdown、.mkd 文件都会用 ReadMD 打开；.txt 不受影响。';
      setupButton.textContent = '重新设置';
    } else {
      hintEl.textContent = '支持 .md、.markdown、.mdown、.mkd；不会接管 .txt 文件。';
      setupButton.textContent = '去设置';
    }
  };

  const startPolling = () => {
    stopPolling();
    pollCount = 0;
    pollTimer = setInterval(async () => {
      pollCount += 1;
      try {
        const status = await api.fileAssociationStatus();
        render(status);
        state.associationStatus = status;
        if (status.isDefault) {
          stopPolling();
          refreshAssociationEntry();
          toast('已设为默认：以后双击 Markdown 文件会直接用 ReadMD 打开', 'ok', 5000);
        }
      } catch {
        // 读取失败时继续轮询，用户可能正在系统窗口里操作
      }
      if (pollCount >= 20) stopPolling();
    }, 1500);
  };

  setupButton.addEventListener('click', async () => {
    setupButton.disabled = true;
    settingsButton.disabled = true;
    try {
      const status = await api.fileAssociationSetup(state.activePath);
      render(status);
      toast('请在系统弹出的“打开方式”窗口里选择 ReadMD，并勾选“始终使用”', 'info', 6000);
      startPolling();
    } catch (error) {
      toast(`设置失败：${errorMessage(error)}`, 'error', 6000);
    } finally {
      setupButton.disabled = false;
      settingsButton.disabled = false;
    }
  });

  settingsButton.addEventListener('click', async () => {
    try {
      await api.fileAssociationOpenSettings();
      toast('已打开 Windows 的“默认应用”设置，请把 .md 关联到 ReadMD', 'info', 6000);
      startPolling();
    } catch (error) {
      toast(`打开设置失败：${errorMessage(error)}`, 'error', 5000);
    }
  });

  removeButton.addEventListener('click', async () => {
    stopPolling();
    root.removeEventListener('keydown', onKey);
    const confirmed = await showChoice(
      '移除 ReadMD 关联？',
      '这会把 ReadMD 从“打开方式”候选列表里移除，不会删除任何文档。之后仍可重新设置。',
      [
        { label: '取消', value: false },
        { label: '移除', value: true, danger: true }
      ],
      false
    );
    if (!confirmed) {
      showAssociationModal(current);
      return;
    }

    try {
      await api.fileAssociationRemove();
      toast('已从“打开方式”列表移除 ReadMD', 'ok');
      refreshAssociationEntry();
      await openDefaultAppDialog();
    } catch (error) {
      toast(`移除失败：${errorMessage(error)}`, 'error', 5000);
      await openDefaultAppDialog();
    }
  });

  render(initialStatus);
  root.addEventListener('keydown', onKey);
  modal.querySelector('[data-action="cancel"]').addEventListener('click', close);
  setTimeout(() => setupButton.focus(), 0);
}

async function runBatchExport({ outputDir, format, files, truncated = false }) {
  if (!window.Vditor || typeof window.Vditor.md2html !== 'function') {
    throw new Error('Markdown 渲染器尚未就绪');
  }

  const total = files.length;
  const labels = { docx: 'Word', pdf: 'PDF', html: 'HTML' };
  const errors = [];
  let done = 0;
  let failed = 0;

  state.batchExporting = true;
  toast(`开始批量导出 ${total} 个文件（${labels[format] || format}）…`, 'info', 5000);

  try {
    for (const file of files) {
      els.statusLeft.textContent = `批量导出 ${done + failed + 1}/${total}：${file.relative}`;
      try {
        const data = await api.readFile(file.path);
        const html = await window.Vditor.md2html(data.content, { cdn: CDN });
        const dirUrl = await api.dirUrl(file.path);
        const fallbackTitle = file.name.replace(/\.(md|markdown|mdown|mkd|txt|text)$/i, '');
        const payload = await buildExportPayloadFromHtml({
          html,
          title: exportTitleFromHtml(html, fallbackTitle),
          dirUrl,
          baseDir: dirName(file.path)
        });
        await api.exportBatchItem(format, payload, outputDir, file.relative);
        done += 1;
      } catch (error) {
        failed += 1;
        errors.push(`${file.relative}：${errorMessage(error)}`);
        console.error('[ReadMD] 批量导出失败', file.path, error);
      }
    }
  } finally {
    state.batchExporting = false;
    updateStatus();
  }

  return { done, failed, errors, total, truncated };
}

async function batchExportFolder() {
  if (state.batchExporting) {
    toast('已有批量导出任务在进行');
    return;
  }
  if (!state.root) {
    toast('请先打开一个文件夹');
    return;
  }

  const format = await showChoice(
    '批量导出当前文件夹',
    `将把“${state.rootName}”里的 Markdown 按当前设置导出。\n\n当前设置：${exportSettingsSummary()}`,
    [
      { label: '取消', value: null },
      { label: 'Word', value: 'docx', primary: true },
      { label: 'PDF', value: 'pdf' },
      { label: 'HTML', value: 'html' }
    ]
  );
  if (!format) return;

  let outputDir;
  try {
    outputDir = await api.chooseExportFolder();
  } catch (error) {
    toast(`选择输出文件夹失败：${errorMessage(error)}`, 'error', 5000);
    return;
  }
  if (!outputDir) return;

  let listing;
  try {
    listing = await api.listMarkdownFiles(state.root);
  } catch (error) {
    toast(`读取文件夹失败：${errorMessage(error)}`, 'error', 5000);
    return;
  }
  if (!listing.files.length) {
    toast('这个文件夹里没有可导出的 Markdown');
    return;
  }

  if (!window.Vditor || typeof window.Vditor.md2html !== 'function') {
    toast('Markdown 渲染器尚未就绪，请稍后再试', 'error', 5000);
    return;
  }

  let result;
  try {
    result = await runBatchExport({
      outputDir,
      format,
      files: listing.files,
      truncated: listing.truncated
    });
  } catch (error) {
    toast(`批量导出失败：${errorMessage(error)}`, 'error', 5000);
    return;
  }

  const summary = `成功 ${result.done} 个${result.failed ? `，失败 ${result.failed} 个` : ''}。\n输出位置：${outputDir}${result.truncated ? `\n\n文件较多，本次只导出了前 ${result.total} 个。` : ''}${result.errors.length ? `\n\n失败示例：\n${result.errors.slice(0, 3).join('\n')}` : ''}`;
  const choice = await showChoice('批量导出完成', summary, [
    { label: '打开文件夹', value: 'open' },
    { label: '好的', value: 'ok', primary: true }
  ]);
  if (choice === 'open') {
    api.reveal(outputDir).catch(() => {});
  }
}

/* ------------------------------ 图片与链接 ------------------------------ */

function isImageFile(file) {
  return Boolean(file) && (
    (file.type && file.type.startsWith('image/')) ||
    /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.name || '')
  );
}

function triggerImagePicker() {
  const tab = activeTab();
  if (!tab) {
    toast('请先打开一个 Markdown 文件');
    return;
  }
  if (!tab.path) {
    toast('请先保存当前文件，再插入图片');
    return;
  }
  // 统一复用编辑器工具栏里的图片按钮，避免出现第二个“独树一帜”的入口。
  const button = document.querySelector('.vditor-toolbar__item [data-type="upload"]')
    || document.querySelector('.vditor-toolbar [data-type="upload"]');
  const fileInput = button && button.querySelector('input[type="file"]');
  if (fileInput) {
    fileInput.click();
  } else if (button) {
    button.click();
  } else {
    toast('请使用编辑器工具栏中的图片按钮');
  }
}

async function handleImageUpload(files) {
  const tab = activeTab();
  if (!tab) return '请先打开一个 Markdown 文件';
  if (!tab.path) return '请先保存当前文件，再插入图片';

  // 图片插入可能发生在“打开文档后的 80ms 基线校准”之前；
  // 提前标记为用户修改，避免校准逻辑把新内容当成已保存内容。
  tab.userMutation = true;
  tab.loadingBaseline = false;

  const inserts = [];
  const relativePaths = [];
  try {
    for (const file of files) {
      if (!isImageFile(file)) continue;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const relative = await api.saveImage(tab.path, file.name, bytes);
      const alt = (file.name || 'image').replace(/\.[^.]+$/, '').replace(/[[\]]/g, '') || 'image';
      inserts.push(`![${alt}](${relative})`);
      relativePaths.push(relative);
    }
  } catch (error) {
    return `图片保存失败：${errorMessage(error)}`;
  }

  if (!inserts.length) return '没有识别到可插入的图片文件';

  const markdown = inserts.join('\n');
  const before = state.vditor.getValue();
  state.vditor.focus();
  state.vditor.insertValue(markdown);

  // 如果当前光标/选区导致插入失败，兜底追加到文档末尾。
  setTimeout(() => {
    const current = activeTab();
    if (current !== tab) return;

    const persist = () => {
      syncActiveContent();
      scheduleAutoSave(tab);
      // 图片刚插入时立即落盘，避免用户以为已经保存但 Markdown 尚未写回。
      saveTab(tab, { silent: true, auto: true }).then((saved) => {
        if (saved) toast(`已插入 ${inserts.length} 张图片，保存到 assets/`, 'ok');
      });
    };

    let value = '';
    try {
      value = state.vditor.getValue();
    } catch {
      // 忽略
    }
    if (!relativePaths.every((relative) => value.includes(relative))) {
      state.loadingDoc = true;
      state.vditor.setValue(`${before}\n\n${markdown}`, true);
      setTimeout(() => {
        state.loadingDoc = false;
        persist();
      }, 80);
    } else {
      persist();
    }
  }, 80);

  return null;
}

async function handleLinkClick(element) {
  const href = element && element.getAttribute ? element.getAttribute('href') : '';
  if (!href) return;

  if (/^(https?:|mailto:)/i.test(href)) {
    api.openExternal(href).catch((error) => toast(errorMessage(error), 'error'));
    return;
  }
  if (href.startsWith('#')) return;

  const tab = activeTab();
  if (!tab) return;

  try {
    const target = await api.resolveRelative(tab.path, href);
    if (MD_EXT.has(extOf(target))) {
      await openFile(target);
    } else {
      toast('这个链接指向的不是 Markdown 文件。');
    }
  } catch (error) {
    console.warn('[ReadMD] 打开相对链接失败', error);
  }
}

/* ------------------------------ 弹窗与提示 ------------------------------ */

function openModal(options) {
  return new Promise((resolve) => {
    const root = els.modalRoot;
    root.innerHTML = '';

    const modal = document.createElement('div');
    modal.className = 'modal';

    const title = document.createElement('h2');
    title.textContent = options.title || '';
    modal.appendChild(title);

    if (options.message) {
      const message = document.createElement('p');
      message.textContent = options.message;
      modal.appendChild(message);
    }

    let input = null;
    if (options.input) {
      input = document.createElement('input');
      input.type = 'text';
      input.value = options.defaultValue || '';
      input.placeholder = options.placeholder || '';
      input.spellcheck = false;
      modal.appendChild(input);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    modal.appendChild(actions);

    const cancelValue = Object.prototype.hasOwnProperty.call(options, 'cancelValue')
      ? options.cancelValue
      : null;

    const finish = (value) => {
      root.removeEventListener('keydown', onKey);
      root.classList.add('hidden');
      root.innerHTML = '';
      resolve(value);
    };

    const submit = () => {
      if (input) {
        const value = input.value.trim();
        if (!value) {
          input.focus();
          return;
        }
        finish(value);
      } else {
        finish('ok');
      }
    };

    const buttons = options.buttons || [
      { label: '取消', value: cancelValue },
      { label: '确定', value: '__submit__', primary: true }
    ];

    for (const button of buttons) {
      const btn = document.createElement('button');
      btn.className = `btn${button.primary ? ' primary' : ''}${button.danger ? ' danger' : ''}`;
      btn.textContent = button.label;
      btn.addEventListener('click', () => {
        if (button.value === '__submit__') submit();
        else finish(button.value);
      });
      actions.appendChild(btn);
    }

    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(cancelValue);
      } else if (event.key === 'Enter' && input) {
        event.preventDefault();
        submit();
      }
    };
    root.addEventListener('keydown', onKey);

    root.classList.remove('hidden');
    setTimeout(() => {
      if (input) {
        input.focus();
        input.select();
      } else {
        const primary = actions.querySelector('.btn.primary');
        if (primary) primary.focus();
      }
    }, 0);
  });
}

function showPrompt(title, defaultValue, message) {
  return openModal({
    title,
    message,
    input: true,
    defaultValue,
    placeholder: defaultValue,
    cancelValue: null,
    buttons: [
      { label: '取消', value: null },
      { label: '确定', value: '__submit__', primary: true }
    ]
  });
}

function showChoice(title, message, buttons, cancelValue = 'cancel') {
  return openModal({
    title,
    message,
    cancelValue,
    buttons
  });
}

function toast(message, type = 'info', duration = 2800) {
  if (!els.toastHost) return;
  const item = document.createElement('div');
  item.className = `toast${type === 'error' ? ' error' : type === 'ok' ? ' ok' : ''}`;
  item.textContent = message;
  els.toastHost.appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transition = 'opacity 0.2s ease';
    setTimeout(() => item.remove(), 220);
  }, duration);
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindStaticEvents() {
  const onClick = (id, handler) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener('click', safe(handler));
  };

  onClick('btn-open-folder', openFolderDialog);
  onClick('btn-open-file', openFileDialog);
  onClick('btn-save', () => saveActive());

  const exportButton = document.getElementById('btn-export');
  if (exportButton) {
    exportButton.addEventListener('click', (event) => {
      event.stopPropagation();
      showExportMenu(exportButton);
    });
  }

  onClick('btn-theme', toggleTheme);
  onClick('btn-sidebar', toggleSidebar);
  onClick('btn-find', openFind);
  onClick('btn-new-file', newFile);
  onClick('btn-new-folder', () => createFolderIn(state.root));
  onClick('btn-refresh', () => renderTree());
  onClick('btn-sidebar-open', openFolderDialog);
  onClick('welcome-open-folder', openFolderDialog);
  onClick('welcome-open-file', openFileDialog);
  onClick('welcome-default-app', openDefaultAppDialog);

  if (els.backTop) {
    // 按下时阻止默认行为，回顶后焦点和光标留在编辑器里
    els.backTop.addEventListener('mousedown', (event) => event.preventDefault());
    els.backTop.addEventListener('click', safe(scrollEditorToTop));
  }

  onClick('find-prev', () => runFind(false, true));
  onClick('find-next', () => runFind(true, true));
  onClick('find-close', closeFind);

  els.findInput.addEventListener('input', () => {
    clearTimeout(state.findDebounce);
    state.findDebounce = setTimeout(() => runFind(true, false), 180);
  });

  els.findInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runFind(!event.shiftKey, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeFind();
    }
  });

  els.folderName.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    showRootContext(event.clientX, event.clientY);
  });

  els.fileTree.addEventListener('contextmenu', (event) => {
    if (event.target === els.fileTree) {
      event.preventDefault();
      showRootContext(event.clientX, event.clientY);
    }
  });

  document.addEventListener('click', hideContextMenu);
  document.addEventListener('scroll', hideContextMenu, true);
  window.addEventListener('resize', hideContextMenu);
  document.addEventListener('keydown', handleGlobalKeydown, true);

  initResizer();
  initContentResizer();
  initOutlineResizer();
  window.addEventListener('resize', scheduleContentResizer);

  api.onMenuCommand((command) => {
    switch (command) {
      case 'open-file': openFileDialog(); break;
      case 'open-folder': openFolderDialog(); break;
      case 'new-file': newFile(); break;
      case 'insert-image': triggerImagePicker(); break;
      case 'save': saveActive(); break;
      case 'save-as': saveAsActive(); break;
      case 'close-tab': if (state.activePath) closeTab(state.activePath); break;
      case 'refresh-tree': renderTree(); break;
      case 'export-docx': exportActive('docx'); break;
      case 'export-html': exportActive('html'); break;
      case 'export-pdf': exportActive('pdf'); break;
      case 'export-settings': openExportSettings(); break;
      case 'export-batch': batchExportFolder(); break;
      case 'default-app': openDefaultAppDialog(); break;
      case 'toggle-ai': window.readmdAI?.toggle(); break;
      case 'ai-settings': window.readmdAI?.openSettings(); break;
      case 'toggle-sidebar': toggleSidebar(); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'find': openFind(); break;
      default: break;
    }
  });

  api.onOpenPaths(async (payload) => {
    try {
      if (payload && payload.folder) {
        await loadFolder(payload.folder);
      }
      for (const file of (payload && payload.files) || []) {
        await openFile(file);
      }
    } catch (error) {
      toast(`打开失败：${errorMessage(error)}`, 'error', 5000);
    }
  });

  api.onSaveAndClose(() => {
    saveAndClose().catch((error) => {
      toast(`保存失败：${errorMessage(error)}`, 'error', 6000);
    });
  });

  api.onFindResult(onFindResult);
}

function handleGlobalKeydown(event) {
  if (event.isComposing) return;

  if (event.ctrlKey && event.key === 'Tab') {
    event.preventDefault();
    cycleTab(event.shiftKey ? -1 : 1);
    return;
  }

  if (event.key === 'Escape') {
    if (state.findVisible) {
      event.preventDefault();
      closeFind();
    } else if (!els.contextMenu.classList.contains('hidden')) {
      event.preventDefault();
      hideContextMenu();
    }
  }
}

/* ------------------------------ 启动入口 ------------------------------ */

init();

// 冒烟测试钩子只在 --smoke-test 模式下挂载，生产环境不暴露。
function attachSmokeHooks() {
  window.__readmdSmokeTheme = (theme) => applyTheme(theme, false);

  window.__readmdSmoke = {
  appendText(text) {
    const tab = activeTab();
    if (!tab || !state.vditor) return Promise.resolve(false);
    const initial = tab.content || '';
    state.loadingDoc = true;
    state.docLoadToken += 1;
    state.vditor.setValue(`${initial}${text}`, true);

    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        let value = initial;
        try {
          value = state.vditor.getValue();
        } catch {
          // Vditor 还在渲染时继续等待
        }
        if (value !== initial) {
          state.loadingDoc = false;
          syncActiveContent();
          updateStatus();
          updateSaveButton();
          updateTitle();
          resolve(true);
          return;
        }
        if (Date.now() - startedAt > 4000) {
          state.loadingDoc = false;
          syncActiveContent();
          resolve(false);
          return;
        }
        setTimeout(check, 50);
      };
      setTimeout(check, 50);
    });
  },
  async backTopTest() {
    const filler = Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段用于验证回到顶部按钮。`).join('\n\n');
    await this.appendText(`\n\n${filler}`);
    const scroller = editorScroller();
    if (!scroller) return { ok: false, reason: 'no-scroller' };

    // 等 Vditor 完成渲染并让正文足够长，避免滚动位置被后续渲染重置。
    for (let i = 0; i < 20 && scroller.scrollHeight - scroller.clientHeight < 900; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));

    const metrics = () => ({
      top: Math.round(scroller.scrollTop),
      height: scroller.scrollHeight,
      client: scroller.clientHeight,
      visible: els.backTop.classList.contains('is-visible')
    });
    const initial = metrics();

    scroller.scrollTop = 800;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterScroll = metrics();

    scroller.scrollTop = 0;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const afterTop = metrics();

    scroller.scrollTop = 800;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const beforeClick = metrics();
    els.backTop.click();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const afterClick = metrics();

    return {
      ok: afterScroll.visible && !afterTop.visible && afterClick.top <= 1 && !afterClick.visible,
      initial,
      afterScroll,
      afterTop,
      beforeClick,
      afterClick
    };
  },
  save() {
    return saveActive({ silent: true });
  },
  openPath(filePath) {
    return openFile(filePath);
  },
  closeActive() {
    return closeTab(state.activePath);
  },
  async find(text) {
    state.lastFindResult = null;
    await api.findInPage(text, { forward: true, findNext: true, matchCase: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    return state.lastFindResult;
  },
  async insertImageTest() {
    const tab = activeTab();
    if (!tab || !tab.path) return { ok: false, reason: 'no-file' };
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=';
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const file = new File([bytes], 'smoke-image.png', { type: 'image/png' });
    const error = await handleImageUpload([file]);
    await new Promise((resolve) => setTimeout(resolve, 450));
    let content = '';
    try {
      content = state.vditor.getValue();
    } catch {
      // 忽略
    }
    return {
      ok: !error && content.includes('assets/'),
      error,
      dirty: tab.dirty,
      path: tab.path,
      contentTail: content.slice(-240)
    };
  },
  async closeActiveWithoutSaving() {
    const tab = activeTab();
    if (!tab) return false;
    const index = state.tabs.indexOf(tab);
    state.tabs.splice(index, 1);
    state.activePath = null;
    state.docLoadToken += 1;
    const next = state.tabs[Math.min(index, state.tabs.length - 1)];
    if (next) await activateTab(next.path || next.id);
    else {
      try {
        state.vditor.setValue('', true);
      } catch {
        // 忽略
      }
      showWelcome();
    }
    renderTabs();
    updateSaveButton();
    updateStatus();
    updateTitle();
    api.setDirty(anyDirty());
    saveSession();
    return true;
  },
  exportPayload(settings) {
    const tab = activeTab();
    return tab ? buildExportPayload(tab, settings) : null;
  },
  async exportHtmlString(settings) {
    const tab = activeTab();
    return tab ? api.exportHtmlString(await buildExportPayload(tab, settings)) : '';
  },
  async md2htmlTest() {
    if (!window.Vditor || typeof window.Vditor.md2html !== 'function') return '';
    return window.Vditor.md2html('# 批量导出标题\n\n正文 **加粗**', { cdn: CDN });
  },
  async batchExportTest(root, outputDir, format) {
    const listing = await api.listMarkdownFiles(root);
    return runBatchExport({
      outputDir,
      format,
      files: listing.files,
      truncated: listing.truncated
    });
  },
  openExportSettingsTest() {
    openExportSettings();
    return Boolean(document.querySelector('.modal.wide'));
  },
  async openDefaultAppTest() {
    await openDefaultAppDialog();
    return Boolean(document.querySelector('.modal.wide .assoc-status'));
  },
  closeModalTest() {
    const cancel = document.querySelector('.modal [data-action="cancel"]');
    const before = document.querySelectorAll('.modal').length;
    if (cancel) cancel.click();
    else {
      els.modalRoot.classList.add('hidden');
      els.modalRoot.innerHTML = '';
    }
    return {
      cancelFound: Boolean(cancel),
      before,
      after: document.querySelectorAll('.modal').length,
      hidden: els.modalRoot.classList.contains('hidden')
    };
  },
  setContentWidth(width) {
    applyContentWidth(width, false);
    return true;
  },
  setOutlineWidth(width) {
    applyOutlineWidth(width, false);
    return true;
  },
  setSidebarWidth(width) {
    setSidebarWidth(width);
    applySidebar();
    return true;
  },
  dragOutlineWidth(dx) {
    const handle = els.outlineResizer;
    const box = handle.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + dx, clientY: y }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + dx, clientY: y }));
    return state.outlineWidth;
  },
  dragContentWidth(dx) {
    const handle = els.contentResizer;
    const box = handle.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + dx, clientY: y }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + dx, clientY: y }));
    return state.editorContentWidth;
  },
  dragSidebarWidth(dx) {
    const handle = els.sidebarResizer;
    const box = handle.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y, button: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + dx, clientY: y }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x + dx, clientY: y }));
    return state.sidebarWidth;
  },
  layout() {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(box.width),
        h: Math.round(box.height),
        maxWidth: style.maxWidth,
        width: style.width,
        marginLeft: style.marginLeft,
        marginRight: style.marginRight,
        display: style.display,
        flex: style.flex,
        position: style.position
      };
    };
    const describe = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        cls: String(element.className || '').slice(0, 120),
        x: Math.round(box.x),
        y: Math.round(box.y),
        w: Math.round(box.width),
        h: Math.round(box.height),
        maxWidth: style.maxWidth,
        width: style.width,
        margin: `${style.marginLeft}/${style.marginRight}`,
        padding: style.padding,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        display: style.display,
        flex: style.flex
      };
    };
    const visibleReset = Array.from(document.querySelectorAll('.vditor-reset'))
      .find((element) => element.getBoundingClientRect().width > 0);
    const point = document.elementFromPoint(600, 300);
    const ancestors = [];
    let node = point;
    while (node && node !== document.body) {
      ancestors.push(describe(node));
      node = node.parentElement;
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      sidebar: rect('#sidebar'),
      commandbar: rect('.commandbar'),
      documentCard: rect('.document-card'),
      editorShell: rect('.editor-shell'),
      vditor: rect('#vditor'),
      content: rect('.vditor-content'),
      ir: rect('.vditor-ir'),
      reset: visibleReset ? describe(visibleReset) : null,
      outline: rect('.vditor-outline'),
      resets: Array.from(document.querySelectorAll('.vditor-reset')).map(describe),
      irChildren: Array.from(document.querySelector('.vditor-ir')?.children || []).map(describe),
      pointAncestors: ancestors
    };
  },
  diagnostics() {
    const tab = activeTab();
    const image = document.querySelector('#vditor img');
    const outline = document.querySelector('.vditor-outline');
    return {
      tabs: state.tabs.length,
      treeRows: document.querySelectorAll('.tree-row').length,
      outlineItems: outline ? outline.innerText.split(/\r?\n/).filter((line) => line.trim()).length : 0,
      toolbarItems: document.querySelectorAll('.vditor-toolbar__item').length,
      exportButton: Boolean(document.getElementById('btn-export')),
      toolbarButtons: document.querySelectorAll('.vditor-toolbar__item > [aria-label]').length,
      toolbarTitled: document.querySelectorAll('.vditor-toolbar__item > [aria-label][title]').length,
      outlineSpans: document.querySelectorAll('.vditor-outline span[data-target-id]').length,
      outlineTitled: document.querySelectorAll('.vditor-outline span[data-target-id][title]').length,
      toolbarSampleTitle: document.querySelector('.vditor-toolbar [data-type="bold"]')?.title || null,
      outlineSampleTitle: document.querySelector('.vditor-outline span[data-target-id]')?.title || null,
      imageWidth: image ? image.naturalWidth : 0,
      activeTitle: tab ? tab.name : null,
      dirty: tab ? tab.dirty : null,
      chars: tab ? tab.content.length : 0,
      statusLeft: els.statusLeft.textContent,
      statusSave: els.statusSave.textContent,
      hasVditor: Boolean(state.vditor),
      editorReady: state.vditorReady,
      editorContentWidth: state.editorContentWidth,
      contentWidthCss: getComputedStyle(document.documentElement).getPropertyValue('--editor-content-width').trim(),
      outlineWidth: state.outlineWidth,
      outlineWidthCss: getComputedStyle(document.documentElement).getPropertyValue('--outline-width').trim(),
      imageToolbarButton: Boolean(document.querySelector('.vditor-toolbar__item [data-type="upload"]')),
      imageToolbarInput: Boolean(document.querySelector('.vditor-toolbar__item [data-type="upload"] input[type="file"]'))
    };
  }
}

}
