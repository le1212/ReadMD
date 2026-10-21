'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('readmd', {
  init: () => ipcRenderer.invoke('app:init'),
  rendererReady: () => ipcRenderer.send('app:renderer-ready'),

  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  openFile: () => ipcRenderer.invoke('dialog:open-file'),

  readDir: (dirPath) => ipcRenderer.invoke('fs:read-dir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('fs:read-file', filePath),
  writeFile: (filePath, content, eol) => ipcRenderer.invoke('fs:write-file', filePath, content, eol),
  saveAs: (content, defaultName, currentPath, eol) =>
    ipcRenderer.invoke('fs:save-as', content, defaultName, currentPath, eol),
  createFile: (parentDir, name) => ipcRenderer.invoke('fs:create-file', parentDir, name),
  createFolder: (parentDir, name) => ipcRenderer.invoke('fs:create-folder', parentDir, name),
  rename: (oldPath, newName) => ipcRenderer.invoke('fs:rename', oldPath, newName),
  trash: (targetPath) => ipcRenderer.invoke('fs:trash', targetPath),
  reveal: (targetPath) => ipcRenderer.invoke('fs:reveal', targetPath),
  stat: (targetPath) => ipcRenderer.invoke('fs:stat', targetPath),
  resolveRelative: (docPath, href) => ipcRenderer.invoke('path:resolve-relative', docPath, href),
  dirUrl: (targetPath) => ipcRenderer.invoke('path:dir-url', targetPath),

  saveImage: (docPath, fileName, bytes) => ipcRenderer.invoke('image:save', docPath, fileName, bytes),
  exportHtml: (payload, defaultName, currentPath) =>
    ipcRenderer.invoke('export:html', payload, defaultName, currentPath),
  exportPdf: (payload, defaultName, currentPath) =>
    ipcRenderer.invoke('export:pdf', payload, defaultName, currentPath),
  exportDocx: (payload, defaultName, currentPath) =>
    ipcRenderer.invoke('export:docx', payload, defaultName, currentPath),
  exportHtmlString: (payload) => ipcRenderer.invoke('export:html-string', payload),
  exportPdfTest: (payload, target) => ipcRenderer.invoke('export:pdf-test', payload, target),
  exportDocxTest: (payload, target) => ipcRenderer.invoke('export:docx-test', payload, target),
  chooseExportFolder: () => ipcRenderer.invoke('export:choose-folder'),
  listMarkdownFiles: (rootDir) => ipcRenderer.invoke('export:list-markdown', rootDir),
  exportBatchItem: (format, payload, outputDir, relativePath) =>
    ipcRenderer.invoke('export:batch-item', format, payload, outputDir, relativePath),
  exportAuthorizeTestFolder: (dir) => ipcRenderer.invoke('export:authorize-test-folder', dir),

  aiListConfigs: () => ipcRenderer.invoke('ai:list-configs'),
  aiSaveConfig: (config) => ipcRenderer.invoke('ai:save-config', config),
  aiDeleteConfig: (configId) => ipcRenderer.invoke('ai:delete-config', configId),
  aiSetActiveConfig: (configId) => ipcRenderer.invoke('ai:set-active-config', configId),
  aiTestConfig: (config) => ipcRenderer.invoke('ai:test-config', config),
  aiStartChat: (request) => ipcRenderer.send('ai:chat', request),
  aiAbortChat: (requestId) => ipcRenderer.send('ai:abort', requestId),
  aiParseDocument: (name, bytes) => ipcRenderer.invoke('ai:parse-document', name, bytes),
  aiDiff: (oldText, newText) => ipcRenderer.invoke('ai:diff', oldText, newText),
  onAIEvent: (callback) => subscribe('ai:event', callback),

  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  fileAssociationStatus: () => ipcRenderer.invoke('app:file-association-status'),
  fileAssociationRegister: () => ipcRenderer.invoke('app:file-association-register'),
  fileAssociationRemove: () => ipcRenderer.invoke('app:file-association-remove'),
  fileAssociationSetup: (activeFile) => ipcRenderer.invoke('app:file-association-setup', activeFile),
  fileAssociationOpenSettings: () => ipcRenderer.invoke('app:file-association-open-settings'),

  saveState: (patch) => ipcRenderer.invoke('state:save', patch),
  setDirty: (dirty) => ipcRenderer.send('app:set-dirty', Boolean(dirty)),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  setTitle: (title) => ipcRenderer.invoke('window:set-title', title),
  setNativeTheme: (theme) => ipcRenderer.invoke('theme:set-native', theme),

  findInPage: (text, options) => ipcRenderer.invoke('find:start', text, options),
  stopFindInPage: (action) => ipcRenderer.invoke('find:stop', action),

  onMenuCommand: (callback) => subscribe('menu:command', callback),
  onOpenPaths: (callback) => subscribe('app:open-paths', callback),
  onSaveAndClose: (callback) => subscribe('app:save-and-close', callback),
  onFindResult: (callback) => subscribe('find:result', callback)
});
