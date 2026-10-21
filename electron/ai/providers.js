'use strict';

const { net } = require('electron');

let modulesPromise = null;

function loadModules() {
  if (!modulesPromise) {
    modulesPromise = Promise.all([
      import('ai'),
      import('@ai-sdk/openai-compatible'),
      import('@ai-sdk/openai'),
      import('@ai-sdk/anthropic'),
      import('@ai-sdk/google')
    ]).then(([ai, openaiCompatible, openai, anthropic, google]) => ({
      ai,
      openaiCompatible,
      openai,
      anthropic,
      google
    }));
  }
  return modulesPromise;
}

function netFetch(input, init) {
  // 走 Chromium 网络栈，自动使用系统代理和证书设置
  return net.fetch(input, init);
}

async function createLanguageModel(config, apiKey) {
  if (!apiKey) throw new Error('请先填写 API Key');
  const modules = await loadModules();
  const common = { apiKey, fetch: netFetch };
  const baseURL = config.baseURL || undefined;

  switch (config.type) {
    case 'openai': {
      const provider = modules.openai.createOpenAI({
        ...common,
        ...(baseURL ? { baseURL } : {})
      });
      return provider(config.model);
    }
    case 'anthropic': {
      const provider = modules.anthropic.createAnthropic({
        ...common,
        ...(baseURL ? { baseURL } : {})
      });
      return provider(config.model);
    }
    case 'google': {
      const provider = modules.google.createGoogle({
        ...common,
        ...(baseURL ? { baseURL } : {})
      });
      return provider(config.model);
    }
    case 'openai-compatible':
    default: {
      const provider = modules.openaiCompatible.createOpenAICompatible({
        name: config.name || 'readmd',
        baseURL: config.baseURL,
        ...common
      });
      return provider(config.model);
    }
  }
}

function friendlyAIError(error, apiKey = '') {
  let raw = String(error && error.message ? error.message : error || '未知错误');
  if (apiKey) raw = raw.split(apiKey).join('***');

  const status = Number(error && (error.statusCode || error.status || error.response?.status)) || 0;
  const lower = raw.toLowerCase();

  if (/image_invalid|图片无法识别|image not recognized/.test(lower)) {
    return '图片无法识别，请换一张 JPG/PNG 图片再试。';
  }
  if (/tool|function call|function_call|tools/.test(lower) && /not support|不支持|unsupported/.test(lower)) {
    return '当前模型不支持工具调用。请在 AI 设置里关闭“支持工具调用”，或换一个模型。';
  }
  if (status === 401 || status === 403 || /invalid.*(key|api)|unauthorized|authentication/.test(lower)) {
    return 'API Key 无效或没有权限，请检查 Key 是否填写正确。';
  }
  if (status === 404 || /model.*not found|no such model|模型不存在/.test(lower)) {
    return '接口地址或模型名不正确，请检查 Base URL 和模型名。';
  }
  if (status === 429 || /rate limit|too many requests|quota|额度|频率/.test(lower)) {
    return '请求太频繁或额度不足，请稍后再试，或检查服务商余额。';
  }
  if (/context|too long|maximum.*token|token.*limit/.test(lower)) {
    return '内容太长，超过模型上下文限制。请减少附件、缩短文档，或换一个上下文更大的模型。';
  }
  if (/abort|canceled|cancelled/.test(lower)) {
    return '已停止生成。';
  }
  if (/fetch failed|network|econn|timeout|timed out|socket|tls|certificate/.test(lower)) {
    return '网络连接失败，请检查接口地址、系统代理或网络。';
  }
  if (/reasoning_content|reasoning/.test(lower) && /400|invalid/.test(lower)) {
    return '当前接口与模型返回格式不兼容，请换一个模型或检查接口地址。';
  }

  const brief = raw.replace(/\s+/g, ' ').trim().slice(0, 240);
  return brief ? `模型调用失败：${brief}` : '模型调用失败，请检查模型设置。';
}

function logAIError(error, apiKey = '') {
  let text = String(error && error.stack ? error.stack : error || '');
  if (apiKey) text = text.split(apiKey).join('***');
  console.error('[ReadMD AI]', text.slice(0, 2000));
}

async function testConnection(config, apiKey) {
  const modules = await loadModules();
  const model = await createLanguageModel(config, apiKey);
  const startedAt = Date.now();
  const result = await modules.ai.generateText({
    model,
    prompt: '请只回复：OK',
    maxOutputTokens: 32,
    abortSignal: AbortSignal.timeout(30000)
  });
  return {
    ok: true,
    latencyMs: Date.now() - startedAt,
    model: config.model,
    preview: String(result.text || '').slice(0, 80)
  };
}

module.exports = {
  loadModules,
  createLanguageModel,
  testConnection,
  friendlyAIError,
  logAIError,
  netFetch
};
