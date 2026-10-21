'use strict';

const { safeStorage } = require('electron');

const DEFAULT_AI_CONFIG = {
  id: 'zhigui-deepseek',
  name: '智桂 API',
  type: 'openai-compatible',
  baseURL: 'https://api.zhigui.icu/v1',
  model: 'cn:deepseek-v4.1-flash',
  apiKeyEnc: '',
  supportsVision: true,
  supportsTools: true,
  supportsStreaming: true,
  maxContextChars: 60000
};

const AI_TYPES = new Set(['openai-compatible', 'openai', 'anthropic', 'google']);
const memorySecrets = new Map();

function defaultAIState() {
  return {
    configs: [{ ...DEFAULT_AI_CONFIG }],
    activeConfigId: DEFAULT_AI_CONFIG.id
  };
}

function normalizeAIConfig(input, index = 0) {
  const source = input && typeof input === 'object' ? input : {};
  const type = AI_TYPES.has(source.type) ? source.type : 'openai-compatible';
  const id = String(source.id || `ai-${Date.now()}-${index}`).trim().slice(0, 100);

  return {
    id,
    name: String(source.name || '未命名模型').trim().slice(0, 80) || '未命名模型',
    type,
    baseURL: String(source.baseURL || '').trim().slice(0, 500),
    model: String(source.model || '').trim().slice(0, 200),
    apiKeyEnc: typeof source.apiKeyEnc === 'string' ? source.apiKeyEnc : '',
    supportsVision: Boolean(source.supportsVision),
    supportsTools: source.supportsTools !== false,
    supportsStreaming: source.supportsStreaming !== false,
    maxContextChars: Math.min(Math.max(Number(source.maxContextChars) || 60000, 4000), 300000)
  };
}

function normalizeAIState(input) {
  const source = input && typeof input === 'object' ? input : {};
  let configs = Array.isArray(source.configs)
    ? source.configs.map((config, index) => normalizeAIConfig(config, index))
    : [];

  // 去掉重复 id，避免保存/切换时指向错误配置
  const seen = new Set();
  configs = configs.filter((config) => {
    if (!config.id || seen.has(config.id)) return false;
    seen.add(config.id);
    return true;
  });

  if (!configs.length) configs = [{ ...DEFAULT_AI_CONFIG }];
  const activeConfigId = configs.some((config) => config.id === source.activeConfigId)
    ? source.activeConfigId
    : configs[0].id;

  return { configs, activeConfigId };
}

function encryptSecret(secret, configId) {
  if (!secret) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return `safe:${safeStorage.encryptString(secret).toString('base64')}`;
  }
  // 没有系统密钥环时不落盘，只在本次运行的内存里保留
  memorySecrets.set(configId, secret);
  return 'memory:';
}

function decryptSecret(record, configId) {
  if (!record) return '';
  if (record === 'memory:') return memorySecrets.get(configId) || '';
  if (record.startsWith('safe:')) {
    try {
      return safeStorage.decryptString(Buffer.from(record.slice(5), 'base64'));
    } catch {
      return '';
    }
  }
  return '';
}

function configHasSecret(config) {
  if (!config.apiKeyEnc) return false;
  if (config.apiKeyEnc === 'memory:') return memorySecrets.has(config.id);
  return config.apiKeyEnc.startsWith('safe:');
}

function publicConfig(config) {
  return {
    id: config.id,
    name: config.name,
    type: config.type,
    baseURL: config.baseURL,
    model: config.model,
    supportsVision: config.supportsVision,
    supportsTools: config.supportsTools,
    supportsStreaming: config.supportsStreaming,
    maxContextChars: config.maxContextChars,
    hasKey: configHasSecret(config)
  };
}

function listAIConfigs(state) {
  return {
    configs: state.configs.map(publicConfig),
    activeConfigId: state.activeConfigId
  };
}

function getAIConfig(state, configId) {
  return state.configs.find((config) => config.id === configId)
    || state.configs.find((config) => config.id === state.activeConfigId)
    || state.configs[0]
    || null;
}

function getAIConfigSecret(config) {
  return config ? decryptSecret(config.apiKeyEnc, config.id) : '';
}

function normalizeEndpoint(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function sameAIEndpoint(a, b) {
  if (!a || !b) return false;
  return a.type === b.type && normalizeEndpoint(a.baseURL) === normalizeEndpoint(b.baseURL);
}

function validateAIConfig(config) {
  if (!config.name) throw new Error('请填写配置名称');
  if (!config.model) throw new Error('请填写模型名');
  if (config.type === 'openai-compatible' && !config.baseURL) {
    throw new Error('请填写 OpenAI 兼容接口地址');
  }
  if (config.baseURL) {
    let parsed;
    try {
      parsed = new URL(config.baseURL);
    } catch {
      throw new Error('接口地址格式不正确');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('接口地址必须以 http:// 或 https:// 开头');
    }
  }
}

function saveAIConfig(state, input) {
  const source = input && typeof input === 'object' ? input : {};
  const existing = source.id
    ? state.configs.find((config) => config.id === source.id)
    : null;
  const config = normalizeAIConfig({
    ...source,
    apiKeyEnc: '',
    id: existing ? existing.id : (source.id || `ai-${Date.now()}`)
  });

  validateAIConfig(config);

  if (typeof source.apiKey === 'string' && source.apiKey.trim()) {
    config.apiKeyEnc = encryptSecret(source.apiKey.trim(), config.id);
  } else if (source.clearKey) {
    config.apiKeyEnc = '';
  } else if (existing) {
    // 接口地址/类型变了就不能继续复用旧 Key，避免把 Key 发到新地址
    config.apiKeyEnc = sameAIEndpoint(existing, config) ? existing.apiKeyEnc : '';
  }

  const index = state.configs.findIndex((item) => item.id === config.id);
  if (index >= 0) state.configs[index] = config;
  else state.configs.push(config);

  if (!state.activeConfigId || !state.configs.some((item) => item.id === state.activeConfigId)) {
    state.activeConfigId = config.id;
  }

  return state;
}

function deleteAIConfig(state, configId) {
  state.configs = state.configs.filter((config) => config.id !== configId);
  if (!state.configs.some((config) => config.id === state.activeConfigId)) {
    state.activeConfigId = state.configs[0]?.id || null;
  }
  return state;
}

function setActiveAIConfig(state, configId) {
  if (!state.configs.some((config) => config.id === configId)) {
    throw new Error('模型配置不存在');
  }
  state.activeConfigId = configId;
  return state;
}

module.exports = {
  DEFAULT_AI_CONFIG,
  defaultAIState,
  normalizeAIState,
  normalizeAIConfig,
  validateAIConfig,
  sameAIEndpoint,
  publicConfig,
  listAIConfigs,
  getAIConfig,
  getAIConfigSecret,
  saveAIConfig,
  deleteAIConfig,
  setActiveAIConfig
};
