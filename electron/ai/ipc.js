'use strict';

const fsp = require('node:fs/promises');
const { diffLines } = require('diff');
const {
  listAIConfigs,
  getAIConfig,
  getAIConfigSecret,
  normalizeAIState,
  normalizeAIConfig,
  validateAIConfig,
  sameAIEndpoint,
  saveAIConfig,
  deleteAIConfig,
  setActiveAIConfig
} = require('./config');
const { testConnection, friendlyAIError, logAIError } = require('./providers');
const { runAgent } = require('./agent');
const { parseDocument } = require('./documents');

function hasImages(messages) {
  return Array.isArray(messages)
    && messages.some((message) => Array.isArray(message.images) && message.images.length > 0);
}

function registerAIHandlers({ ipcMain, appState, persistState, assertAllowed }) {
  const chatRequests = new Map();

  const ensureState = () => {
    appState.ai = normalizeAIState(appState.ai);
    return appState.ai;
  };

  const allowedRoot = async (rootPath) => {
    if (!rootPath) return null;
    try {
      const resolved = require('node:path').resolve(String(rootPath));
      await assertAllowed(resolved);
      const stat = await fsp.stat(resolved);
      return stat.isDirectory() ? resolved : null;
    } catch {
      return null;
    }
  };

  ipcMain.handle('ai:list-configs', () => listAIConfigs(ensureState()));

  ipcMain.handle('ai:save-config', (_event, input) => {
    saveAIConfig(ensureState(), input);
    appState.ai = normalizeAIState(appState.ai);
    persistState();
    return listAIConfigs(appState.ai);
  });

  ipcMain.handle('ai:delete-config', (_event, configId) => {
    deleteAIConfig(ensureState(), String(configId || ''));
    appState.ai = normalizeAIState(appState.ai);
    persistState();
    return listAIConfigs(appState.ai);
  });

  ipcMain.handle('ai:set-active-config', (_event, configId) => {
    setActiveAIConfig(ensureState(), String(configId || ''));
    persistState();
    return listAIConfigs(appState.ai);
  });

  ipcMain.handle('ai:test-config', async (_event, input) => {
    const source = input && typeof input === 'object' ? input : {};
    const state = ensureState();
    const existing = source.id
      ? state.configs.find((config) => config.id === source.id) || null
      : null;
    if (source.id && !existing) throw new Error('模型配置不存在');

    const draft = normalizeAIConfig({
      ...existing,
      ...source,
      apiKeyEnc: '',
      id: existing ? existing.id : (source.id || 'test-config')
    });
    validateAIConfig(draft);

    const typedKey = String(source.apiKey || '').trim();
    let apiKey = typedKey;
    if (!apiKey && existing) {
      if (!sameAIEndpoint(existing, draft)) {
        throw new Error('接口地址或类型已更改，请重新填写 API Key 后再测试');
      }
      apiKey = getAIConfigSecret(existing);
    }
    if (!apiKey) throw new Error('请先填写 API Key');

    try {
      return await testConnection(draft, apiKey);
    } catch (error) {
      logAIError(error, apiKey);
      throw new Error(friendlyAIError(error, apiKey));
    }
  });

  ipcMain.handle('ai:parse-document', async (_event, name, bytes) => {
    return parseDocument(name, bytes);
  });

  ipcMain.handle('ai:diff', (_event, oldText, newText) => {
    return diffLines(String(oldText || ''), String(newText || '')).map((part) => ({
      value: part.value,
      added: Boolean(part.added),
      removed: Boolean(part.removed),
      count: part.count || 0
    }));
  });

  ipcMain.on('ai:chat', async (event, request) => {
    const requestId = String(request?.requestId || '');
    if (!requestId) return;

    const send = (payload) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('ai:event', { requestId, ...payload });
      }
    };

    const state = ensureState();
    const config = getAIConfig(state, request?.configId);
    if (!config) {
      send({ type: 'error', message: '还没有配置模型，请先在 AI 设置里添加。' });
      send({ type: 'done' });
      return;
    }
    if (!Array.isArray(request.messages) || !request.messages.length) {
      send({ type: 'error', message: '没有可发送的消息。' });
      send({ type: 'done' });
      return;
    }
    if (hasImages(request.messages) && !config.supportsVision) {
      send({ type: 'error', message: '当前模型没有开启图片识别。请在 AI 设置中换一个支持图片的模型，或移除图片。' });
      send({ type: 'done' });
      return;
    }

    const apiKey = getAIConfigSecret(config);
    if (!apiKey) {
      send({ type: 'error', message: '这个模型还没有填写 API Key。请打开 AI 设置填写并保存。' });
      send({ type: 'done' });
      return;
    }

    const controller = new AbortController();
    chatRequests.set(requestId, controller);

    try {
      const context = {
        ...(request.context && typeof request.context === 'object' ? request.context : {}),
        rootPath: await allowedRoot(request.context?.rootPath)
      };
      await runAgent({
        request: { ...request, context },
        config,
        apiKey,
        send,
        signal: controller.signal
      });
    } catch (error) {
      if (error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')))) {
        send({ type: 'aborted' });
      } else {
        logAIError(error, apiKey);
        send({ type: 'error', message: friendlyAIError(error, apiKey) });
      }
    } finally {
      chatRequests.delete(requestId);
      send({ type: 'done' });
    }
  });

  ipcMain.on('ai:abort', (_event, requestId) => {
    const controller = chatRequests.get(String(requestId || ''));
    if (controller) controller.abort();
  });
}

module.exports = {
  registerAIHandlers
};
