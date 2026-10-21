'use strict';

const { app, BrowserWindow } = require('electron');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { buildExportHtml } = require('./html');

const PRINT_MARGIN = {
  top: 1,
  bottom: 1,
  left: 1.25, // 3.17cm
  right: 1.25
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHeaderTemplate(title) {
  const safeTitle = escapeHtml(String(title || '').slice(0, 80));
  return `<div style="width:100%; padding:0 3.17cm; font-family:'SimSun','Songti SC',serif; font-size:9px; color:#8c959f; text-align:right; letter-spacing:0.3px;">
  <div style="border-bottom:0.5px solid #e5e7eb; padding-bottom:5px;">${safeTitle}</div>
</div>`;
}

function buildFooterTemplate() {
  return `<div style="width:100%; padding:0 3.17cm; font-family:'SimSun','Songti SC',serif; font-size:9px; color:#8c959f; text-align:center;">
  <div style="border-top:0.5px solid #e5e7eb; padding-top:5px; letter-spacing:0.3px;">
    第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页
  </div>
</div>`;
}

function waitForPrintReady(win, timeoutMs = 5000) {
  const script = `(async () => {
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const images = Array.from(document.images || []);
      await Promise.all(images.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 2500);
        });
      }));
    } catch (_) {}
    return true;
  })()`;

  return Promise.race([
    win.webContents.executeJavaScript(script, true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

async function renderPdfFromPayload(payload, target) {
  const settings = payload.settings || {};
  const showHeader = Boolean(settings.header);
  const showFooter = settings.footer !== false;
  const html = await buildExportHtml(payload, { forPrint: true });
  const tempHtml = path.join(app.getPath('temp'), `readmd-export-${process.pid}-${Date.now()}.html`);
  await fsp.writeFile(tempHtml, html, 'utf8');

  const printWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    backgroundColor: '#ffffff',
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
    await waitForPrintReady(printWindow);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const pdf = await printWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: PRINT_MARGIN,
      displayHeaderFooter: showHeader || showFooter,
      headerTemplate: showHeader ? buildHeaderTemplate(payload.title) : '<div></div>',
      footerTemplate: showFooter ? buildFooterTemplate() : '<div></div>',
      scale: 1,
      preferCSSPageSize: false,
      generateDocumentOutline: true
    });

    await fsp.writeFile(target, pdf);
    return { path: target, bytes: pdf.length };
  } finally {
    if (!printWindow.isDestroyed()) printWindow.destroy();
    await fsp.rm(tempHtml, { force: true }).catch(() => {});
  }
}

module.exports = {
  renderPdfFromPayload
};
