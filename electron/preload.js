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
  vendorCss: (theme) => ipcRenderer.invoke('export:vendor-css', theme),
  exportHtml: (html, defaultName, currentPath) =>
    ipcRenderer.invoke('export:html', html, defaultName, currentPath),
  exportPdf: (html, defaultName, currentPath) =>
    ipcRenderer.invoke('export:pdf', html, defaultName, currentPath),
  exportPdfTest: (html, target) => ipcRenderer.invoke('export:pdf-test', html, target),

  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

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
