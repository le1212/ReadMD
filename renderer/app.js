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
  vendorCssCache: new Map(),
  lastTitle: null
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
    if (state.smoke) attachSmokeHooks();
    api.rendererReady();
    await restoreSession(info.state);
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
          setTimeout(() => {
            updateContentResizer();
            updateOutlineResizer();
            const imageButton = document.querySelector('.vditor-toolbar__item [data-type="upload"]');
            if (imageButton) {
              imageButton.title = '插入图片（支持选择、拖拽、粘贴）';
            }
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
      if (!wasDirty) {
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
      updateContentResizer();
    }, 80);
  }

  els.editorShell.classList.add('has-doc');
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

  handle.style.left = `${Math.max(0, left - 5)}px`;
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

async function buildExportHtml(tab) {
  const contentHtml = state.vditor.getHTML();
  const container = document.createElement('div');
  container.innerHTML = contentHtml;

  container.querySelectorAll('img[src]').forEach((img) => {
    const src = img.getAttribute('src');
    if (!src || /^(https?:|data:|file:|blob:)/i.test(src)) return;
    try {
      img.setAttribute('src', new URL(src, tab.dirUrl).href);
    } catch {
      // 保留原值
    }
  });

  container.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href');
    if (!href || /^(https?:|mailto:|#|file:)/i.test(href)) return;
    try {
      anchor.setAttribute('href', new URL(href, tab.dirUrl).href);
    } catch {
      // 保留原值
    }
  });

  let vendorCss = state.vendorCssCache.get('light');
  if (!vendorCss) {
    vendorCss = await api.vendorCss('light');
    state.vendorCssCache.set('light', vendorCss);
  }

  const title = escapeHtml(tab.name.replace(/\.(md|markdown|mdown|mkd|txt|text)$/i, ''));
  const extraCss = `
    @page { size: A4; margin: 16mm; }
    html, body { background: #ffffff; }
    body { margin: 0; }
    body.vditor-reset { max-width: 860px; margin: 0 auto; padding: 32px 24px 64px; color: #1f2328; }
    body.vditor-reset img { max-width: 100%; height: auto; }
    body.vditor-reset pre { white-space: pre-wrap; }
    @media print {
      body.vditor-reset { max-width: none; padding: 0; }
    }
  `;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${vendorCss}\n${extraCss}</style>
</head>
<body class="vditor-reset">
${container.innerHTML}
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function exportActive(kind) {
  const tab = activeTab();
  if (!tab) {
    toast('请先打开一个文件');
    return;
  }

  syncActiveContent();
  try {
    toast(kind === 'pdf' ? '正在生成 PDF…' : '正在导出 HTML…');
    const html = await buildExportHtml(tab);
    const stem = tab.name.replace(/\.(md|markdown|mdown|mkd|txt|text)$/i, '');
    const target = kind === 'pdf'
      ? await api.exportPdf(html, `${stem}.pdf`, tab.path)
      : await api.exportHtml(html, `${stem}.html`, tab.path);
    if (target) {
      toast(`已导出：${target}`, 'ok', 4500);
    }
  } catch (error) {
    toast(`导出失败：${errorMessage(error)}`, 'error', 6000);
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
  onClick('btn-theme', toggleTheme);
  onClick('btn-sidebar', toggleSidebar);
  onClick('btn-find', openFind);
  onClick('btn-new-file', newFile);
  onClick('btn-new-folder', () => createFolderIn(state.root));
  onClick('btn-refresh', () => renderTree());
  onClick('btn-sidebar-open', openFolderDialog);
  onClick('welcome-open-folder', openFolderDialog);
  onClick('welcome-open-file', openFileDialog);

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
      case 'export-html': exportActive('html'); break;
      case 'export-pdf': exportActive('pdf'); break;
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
  exportHtmlString() {
    const tab = activeTab();
    return tab ? buildExportHtml(tab) : '';
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
