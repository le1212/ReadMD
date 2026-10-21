'use strict';

(() => {
  const api = window.readmd;
  if (!api) return;

  const MAX_IMAGES = 4;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGE_DATA_URL = 12 * 1024 * 1024;
  const MAX_DOC_BYTES = 10 * 1024 * 1024;
  const MAX_DOCS = 3;
  const MAX_ATTACHMENT_CHARS = 60000;
  const MAX_CONTEXT_CHARS = 200000;

  const PRESETS = [
    {
      id: 'zhigui',
      name: '智桂 API',
      type: 'openai-compatible',
      baseURL: 'https://api.zhigui.icu/v1',
      model: 'cn:deepseek-v4.1-flash',
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true
    },
    {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      type: 'anthropic',
      baseURL: '',
      model: 'claude-sonnet-4-5',
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true
    },
    {
      id: 'gemini',
      name: 'Google Gemini',
      type: 'google',
      baseURL: '',
      model: 'gemini-2.5-pro',
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      type: 'openai-compatible',
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      supportsVision: false,
      supportsTools: true,
      supportsStreaming: true
    },
    {
      id: 'kimi',
      name: 'Kimi',
      type: 'openai-compatible',
      baseURL: 'https://api.moonshot.cn/v1',
      model: 'kimi-k3',
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true
    },
    {
      id: 'zhipu',
      name: '智谱 GLM',
      type: 'openai-compatible',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.3',
      supportsVision: true,
      supportsTools: true,
      supportsStreaming: true
    },
    {
      id: 'qwen',
      name: '阿里 Qwen',
      type: 'openai-compatible',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      supportsVision: false,
      supportsTools: true,
      supportsStreaming: false
    },
    {
      id: 'siliconflow',
      name: 'SiliconFlow',
      type: 'openai-compatible',
      baseURL: 'https://api.siliconflow.cn/v1',
      model: 'Pro/deepseek-ai/DeepSeek-R1',
      supportsVision: false,
      supportsTools: true,
      supportsStreaming: true
    },
    {
      id: 'ollama',
      name: 'Ollama（本地）',
      type: 'openai-compatible',
      baseURL: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b',
      apiKey: 'ollama',
      supportsVision: false,
      supportsTools: false,
      supportsStreaming: true
    },
    {
      id: 'lmstudio',
      name: 'LM Studio（本地）',
      type: 'openai-compatible',
      baseURL: 'http://localhost:1234/v1',
      model: 'local-model',
      apiKey: 'lmstudio',
      supportsVision: false,
      supportsTools: false,
      supportsStreaming: true
    },
    {
      id: 'custom',
      name: '自定义 OpenAI 兼容',
      type: 'openai-compatible',
      baseURL: '',
      model: '',
      supportsVision: false,
      supportsTools: true,
      supportsStreaming: true
    }
  ];

  const state = {
    bridge: null,
    configs: [],
    activeConfigId: null,
    messages: [],
    pendingImages: [],
    pendingDocs: [],
    streaming: false,
    requestId: null,
    assistant: null,
    completionResolvers: new Map(),
    settingsOpen: false,
    editingConfigId: null,
    activeConfigIdForForm: null,
    expandReasoning: new Set(),
    panelWidth: null
  };

  const els = {};

  const PANEL_WIDTH_KEY = 'readmd-ai-panel-width';
  const PANEL_DEFAULT_WIDTH = 440;

  function normalizePanelWidth(width) {
    return Math.min(720, Math.max(360, Math.round(width)));
  }

  function applyPanelWidth(width, persist = false) {
    if (!els.panel) return PANEL_DEFAULT_WIDTH;
    const next = normalizePanelWidth(width);
    state.panelWidth = next;
    els.panel.style.setProperty('--ai-panel-width', `${next}px`);
    if (persist) {
      try { localStorage.setItem(PANEL_WIDTH_KEY, String(next)); } catch { /* 忽略 */ }
    }
    return next;
  }

  function restorePanelWidth() {
    let saved = 0;
    try { saved = Number(localStorage.getItem(PANEL_WIDTH_KEY)) || 0; } catch { /* 忽略 */ }
    applyPanelWidth(saved > 0 ? saved : PANEL_DEFAULT_WIDTH);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(message, type, duration) {
    if (state.bridge && typeof state.bridge.toast === 'function') {
      state.bridge.toast(message, type, duration);
    }
  }

  function errorMessage(error) {
    const raw = String(error && error.message ? error.message : error || '未知错误');
    return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  }

  function currentConfig() {
    return state.configs.find((config) => config.id === state.activeConfigId)
      || state.configs[0]
      || null;
  }

  function uid(prefix = 'id') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function scrollMessages() {
    if (els.messages) els.messages.scrollTop = els.messages.scrollHeight;
  }

  function readBridgeContext() {
    if (!state.bridge) return {};
    try {
      return state.bridge.getContext() || {};
    } catch {
      return {};
    }
  }

  /* ------------------------------ 构建界面 ------------------------------ */

  function buildPanel() {
    const panel = document.createElement('aside');
    panel.id = 'ai-panel';
    panel.className = 'ai-panel hidden';
    panel.setAttribute('aria-label', 'AI 文档助手');
    panel.innerHTML = `
      <div class="ai-resize-handle" data-role="resize" title="拖动调整宽度，双击还原"></div>
      <header class="ai-panel-header">
        <div class="ai-panel-heading">
          <span class="ai-mark">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.2l1.7 5 5 1.7-5 1.7-1.7 5-1.7-5-5-1.7 5-1.7 1.7-5Z"/></svg>
          </span>
          <div class="ai-heading-copy">
            <span class="ai-title">AI 助手</span>
            <span class="ai-subtitle">阅读 · 识图 · 改文档</span>
          </div>
        </div>
        <div class="ai-header-actions">
          <button class="ai-icon-btn" data-action="clear" title="清空对话">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 2h6l1 2h3v2H3V4h3l1-2Zm-2 6h10l-1 10H6L5 8Zm3 2v6h1v-6H8Zm2 0v6h1v-6h-1Z"/></svg>
          </button>
          <button class="ai-icon-btn" data-action="settings" title="AI 设置">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.4 2h3.2l.4 2.1 1.6.9 2-.8 1.6 2.8-1.6 1.5v1.8l1.6 1.5-1.6 2.8-2-.8-1.6.9-.4 2.1H8.4l-.4-2.1-1.6-.9-2 .8L2.8 13l1.6-1.5v-1.8L2.8 8.2l1.6-2.8 2 .8 1.6-.9L8.4 2Zm1.6 4.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"/></svg>
          </button>
          <button class="ai-icon-btn" data-action="close" title="关闭 (Ctrl+J)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.3 4A1 1 0 0 0 3.9 5.4L8.6 10l-4.7 4.6a1 1 0 1 0 1.4 1.4l4.7-4.6 4.6 4.6a1 1 0 0 0 1.4-1.4L11.4 10l4.6-4.6A1 1 0 0 0 14.6 4L10 8.6 5.3 4Z"/></svg>
          </button>
        </div>
      </header>
      <div class="ai-panel-toolbar">
        <div class="ai-model-wrap">
          <select class="ai-model-select" data-role="model-select" title="选择模型"></select>
          <svg class="ai-select-caret" viewBox="0 0 20 20" aria-hidden="true"><path d="M5.2 7.2a.75.75 0 0 1 1.1 0L10 10.9l3.7-3.7a.75.75 0 1 1 1.1 1.1l-4.3 4.2a.75.75 0 0 1-1.1 0L5.2 8.3a.75.75 0 0 1 0-1.1Z"/></svg>
        </div>
        <div class="ai-context" data-role="context"></div>
      </div>
      <div class="ai-messages" data-role="messages"></div>
      <div class="ai-composer">
        <div class="ai-attachments" data-role="attachments"></div>
        <div class="ai-composer-box">
          <textarea data-role="input" rows="3" placeholder="描述你的需求，例如：把选中的段落改写得更简洁…"></textarea>
          <div class="ai-composer-bar">
            <div class="ai-composer-tools">
              <button class="ai-tool-btn" data-action="attach-image" title="上传或粘贴图片">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 3h14v14H3V3Zm2 2v8l3-3 2 2 2.5-3L15 13V5H5Zm2 1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg>
                <span>图片</span>
              </button>
              <button class="ai-tool-btn" data-action="attach-doc" title="上传 PDF / Word / 文本">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2h6l4 4v12H5V2Zm6 1.5V7h3.5L11 3.5Z"/></svg>
                <span>文档</span>
              </button>
            </div>
            <div class="ai-composer-send">
              <span class="ai-keyhint">Enter 发送</span>
              <button class="btn primary ai-send-btn" data-action="send">发送</button>
              <button class="btn ai-stop-btn hidden" data-action="stop">停止</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const overlay = document.createElement('div');
    overlay.className = 'ai-settings-overlay hidden';
    overlay.dataset.role = 'settings-overlay';
    overlay.innerHTML = `
      <div class="ai-settings-card" role="dialog" aria-modal="true" aria-label="AI 设置">
        <header class="ai-settings-header">
          <div class="ai-settings-heading">
            <span class="ai-settings-mark">
              <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.4 2h3.2l.4 2.1 1.6.9 2-.8 1.6 2.8-1.6 1.5v1.8l1.6 1.5-1.6 2.8-2-.8-1.6.9-.4 2.1H8.4l-.4-2.1-1.6-.9-2 .8L2.8 13l1.6-1.5v-1.8L2.8 8.2l1.6-2.8 2 .8 1.6-.9L8.4 2Zm1.6 4.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"/></svg>
            </span>
            <div>
              <h2>AI 设置</h2>
              <p>配置你自己的模型。API Key 只保存在本机，并使用系统加密。</p>
            </div>
          </div>
          <button class="ai-icon-btn" data-action="close-settings" title="关闭">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.3 4A1 1 0 0 0 3.9 5.4L8.6 10l-4.7 4.6a1 1 0 1 0 1.4 1.4l4.7-4.6 4.6 4.6a1 1 0 0 0 1.4-1.4L11.4 10l4.6-4.6A1 1 0 0 0 14.6 4L10 8.6 5.3 4Z"/></svg>
          </button>
        </header>
        <div class="ai-settings-body">
          <aside class="ai-config-list">
            <div class="ai-config-list-head">
              <span>模型</span>
              <button class="ai-add-btn" data-action="new-config">+ 添加</button>
            </div>
            <div data-role="config-items"></div>
            <div class="ai-config-list-foot">
              <p class="ai-config-note">对话内容会发送到你选择的模型服务商；选择本地模型时不会离开电脑。</p>
              <button class="ai-link-btn" data-action="restore-default">恢复默认配置</button>
            </div>
          </aside>
          <form class="ai-config-form" data-role="config-form">
            <div class="ai-form-body">
            <section class="ai-form-section">
              <div class="ai-form-section-head">连接</div>
              <div class="ai-form-row">
                <label>快速填充</label>
                <select data-role="preset"></select>
                <span class="ai-form-hint">选择常见服务商会自动填好接口地址和模型名。</span>
              </div>
              <div class="ai-form-grid">
                <div class="ai-form-row">
                  <label>名称</label>
                  <input data-field="name" maxlength="80" placeholder="例如：我的 DeepSeek">
                </div>
                <div class="ai-form-row">
                  <label>接口类型</label>
                  <select data-field="type">
                    <option value="openai-compatible">OpenAI 兼容</option>
                    <option value="openai">OpenAI 原生</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="google">Google Gemini</option>
                  </select>
                </div>
              </div>
              <div class="ai-form-row">
                <label>Base URL</label>
                <input data-field="baseURL" placeholder="https://api.example.com/v1">
                <span class="ai-form-hint">OpenAI 兼容服务必填；Anthropic/Gemini 可留空使用官方地址。</span>
              </div>
              <div class="ai-form-grid">
                <div class="ai-form-row">
                  <label>模型名</label>
                  <input data-field="model" placeholder="例如：cn:deepseek-v4.1-flash">
                </div>
                <div class="ai-form-row">
                  <label>API Key</label>
                  <input data-field="apiKey" type="password" autocomplete="off" placeholder="sk-...">
                  <span class="ai-form-hint" data-role="key-hint"></span>
                </div>
              </div>
            </section>
            <section class="ai-form-section">
              <div class="ai-form-section-head">能力</div>
              <div class="ai-toggle-list">
                <label class="ai-toggle-row">
                  <span class="ai-toggle-copy">
                    <span class="ai-toggle-title">图片识别</span>
                    <span class="ai-toggle-hint">允许粘贴或上传图片让模型理解</span>
                  </span>
                  <span class="switch"><input type="checkbox" data-field="supportsVision"><span></span></span>
                </label>
                <label class="ai-toggle-row">
                  <span class="ai-toggle-copy">
                    <span class="ai-toggle-title">工具调用</span>
                    <span class="ai-toggle-hint">允许搜索文件、读取文档并生成修改建议</span>
                  </span>
                  <span class="switch"><input type="checkbox" data-field="supportsTools"><span></span></span>
                </label>
                <label class="ai-toggle-row">
                  <span class="ai-toggle-copy">
                    <span class="ai-toggle-title">流式输出</span>
                    <span class="ai-toggle-hint">回答逐字显示，速度感更好</span>
                  </span>
                  <span class="switch"><input type="checkbox" data-field="supportsStreaming"><span></span></span>
                </label>
              </div>
              <span class="ai-form-hint">不确定时保持默认。关闭“工具调用”后，AI 只能用文本返回修改建议。</span>
            </section>
            <section class="ai-form-section">
              <div class="ai-form-section-head">上下文</div>
              <div class="ai-form-row">
                <label>上下文上限</label>
                <input data-field="maxContextChars" type="number" min="4000" max="300000" step="1000">
                <span class="ai-form-hint">发送给模型的文档最大字符数，默认 60000。</span>
              </div>
            </section>
            </div>
            <div class="ai-form-footer">
              <div class="ai-test-result" data-role="test-result"></div>
              <div class="ai-form-actions">
                <button type="button" class="btn" data-action="test-config">测试连接</button>
                <button type="submit" class="btn primary">保存配置</button>
                <button type="button" class="btn danger" data-action="delete-config">删除</button>
              </div>
            </div>
          </form>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const imageInput = document.createElement('input');
    imageInput.type = 'file';
    imageInput.accept = 'image/*';
    imageInput.multiple = true;
    imageInput.hidden = true;
    imageInput.dataset.role = 'image-input';
    document.body.appendChild(imageInput);

    const docInput = document.createElement('input');
    docInput.type = 'file';
    docInput.accept = '.pdf,.docx,.txt,.md,.markdown,.mdown,.mkd';
    docInput.multiple = true;
    docInput.hidden = true;
    docInput.dataset.role = 'doc-input';
    document.body.appendChild(docInput);

    els.panel = panel;
    els.overlay = overlay;
    els.messages = panel.querySelector('[data-role="messages"]');
    els.context = panel.querySelector('[data-role="context"]');
    els.input = panel.querySelector('[data-role="input"]');
    els.modelSelect = panel.querySelector('[data-role="model-select"]');
    els.attachments = panel.querySelector('[data-role="attachments"]');
    els.send = panel.querySelector('[data-action="send"]');
    els.stop = panel.querySelector('[data-action="stop"]');
    els.imageInput = imageInput;
    els.docInput = docInput;
    els.configItems = overlay.querySelector('[data-role="config-items"]');
    els.form = overlay.querySelector('[data-role="config-form"]');
    els.preset = overlay.querySelector('[data-role="preset"]');
    els.testResult = overlay.querySelector('[data-role="test-result"]');
    els.keyHint = overlay.querySelector('[data-role="key-hint"]');

    const presetOptions = PRESETS.map((preset) => `<option value="${preset.id}">${escapeHtml(preset.name)}</option>`).join('');
    els.preset.innerHTML = `<option value="">选择预设…</option>${presetOptions}`;
    restorePanelWidth();
  }

  function bindEvents() {
    const aiButton = document.getElementById('btn-ai');
    if (aiButton) aiButton.addEventListener('click', toggle);

    const resizeHandle = els.panel.querySelector('[data-role="resize"]');
    if (resizeHandle) {
      let drag = null;
      const endDrag = (event) => {
        if (!drag) return;
        drag = null;
        resizeHandle.classList.remove('dragging');
        document.body.classList.remove('ai-resizing');
        try { resizeHandle.releasePointerCapture(event.pointerId); } catch { /* 忽略 */ }
        if (state.panelWidth) {
          try { localStorage.setItem(PANEL_WIDTH_KEY, String(state.panelWidth)); } catch { /* 忽略 */ }
        }
      };
      resizeHandle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        drag = {
          startX: event.clientX,
          startWidth: state.panelWidth || els.panel.getBoundingClientRect().width
        };
        resizeHandle.classList.add('dragging');
        document.body.classList.add('ai-resizing');
        try { resizeHandle.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
        event.preventDefault();
      });
      resizeHandle.addEventListener('pointermove', (event) => {
        if (!drag) return;
        applyPanelWidth(drag.startWidth + (drag.startX - event.clientX));
      });
      resizeHandle.addEventListener('pointerup', endDrag);
      resizeHandle.addEventListener('pointercancel', endDrag);
      resizeHandle.addEventListener('dblclick', () => applyPanelWidth(PANEL_DEFAULT_WIDTH, true));
    }

    els.panel.addEventListener('click', (event) => {
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'close') close();
      else if (action === 'settings') openSettings();
      else if (action === 'clear') clearChat();
      else if (action === 'send') sendMessage();
      else if (action === 'stop') stopGeneration();
      else if (action === 'attach-image') els.imageInput.click();
      else if (action === 'attach-doc') els.docInput.click();
    });

    els.panel.addEventListener('keydown', (event) => {
      if (event.target === els.input) return;
      if (event.key === 'Escape') close();
    });

    els.modelSelect.addEventListener('change', async () => {
      const configId = els.modelSelect.value;
      if (!configId) return;
      try {
        const data = await api.aiSetActiveConfig(configId);
        state.activeConfigId = data.activeConfigId;
        state.configs = data.configs;
        updateReadyState();
      } catch (error) {
        toast(`切换模型失败：${errorMessage(error)}`, 'error', 5000);
      }
    });

    els.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
      } else if (event.key === 'Escape' && state.streaming) {
        event.preventDefault();
        stopGeneration();
      }
    });
    els.input.addEventListener('focus', updateContext);
    els.input.addEventListener('paste', handlePaste);
    els.panel.addEventListener('dragover', (event) => {
      event.preventDefault();
    });
    els.panel.addEventListener('drop', handleDrop);

    els.imageInput.addEventListener('change', async () => {
      const files = Array.from(els.imageInput.files || []);
      els.imageInput.value = '';
      await addImageFiles(files);
    });
    els.docInput.addEventListener('change', async () => {
      const files = Array.from(els.docInput.files || []);
      els.docInput.value = '';
      await addDocumentFiles(files);
    });

    els.overlay.addEventListener('click', (event) => {
      if (event.target === els.overlay) {
        closeSettings();
        return;
      }
      const action = event.target.closest('[data-action]')?.dataset.action;
      if (!action) return;
      if (action === 'close-settings') closeSettings();
      else if (action === 'new-config') startNewConfig();
      else if (action === 'delete-config') deleteConfig();
      else if (action === 'test-config') testConfig();
      else if (action === 'restore-default') restoreDefaultConfig();
    });

    els.overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSettings();
    });

    els.preset.addEventListener('change', () => {
      const preset = PRESETS.find((item) => item.id === els.preset.value);
      if (preset) applyPreset(preset);
    });

    els.form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveConfig();
    });
  }

  /* ------------------------------ 配置与状态 ------------------------------ */

  async function refreshConfigs() {
    try {
      const data = await api.aiListConfigs();
      state.configs = Array.isArray(data.configs) ? data.configs : [];
      state.activeConfigId = data.activeConfigId || state.configs[0]?.id || null;
      renderModelSelect();
      renderConfigList();
      updateReadyState();
    } catch (error) {
      toast(`读取 AI 配置失败：${errorMessage(error)}`, 'error', 5000);
    }
  }

  function renderModelSelect() {
    const config = currentConfig();
    if (!state.configs.length) {
      els.modelSelect.innerHTML = '<option value="">未配置模型</option>';
      els.modelSelect.disabled = true;
      return;
    }
    els.modelSelect.disabled = false;
    els.modelSelect.innerHTML = state.configs.map((item) => (
      `<option value="${escapeHtml(item.id)}"${item.id === state.activeConfigId ? ' selected' : ''}>${escapeHtml(item.name)} · ${escapeHtml(item.model)}${item.hasKey ? '' : '（未填 Key）'}</option>`
    )).join('');
    if (!config) els.modelSelect.value = state.configs[0].id;
  }

  function updateReadyState() {
    const config = currentConfig();
    const ready = Boolean(config && config.hasKey);
    els.send.disabled = state.streaming;
    els.stop.classList.toggle('hidden', !state.streaming);
    els.send.classList.toggle('hidden', state.streaming);
    els.input.placeholder = ready
      ? '描述你的需求，例如：把选中的段落改写得更简洁…'
      : '先在 AI 设置里填写模型和 API Key，然后在这里描述需求…';
    if (!state.messages.length) renderEmpty();
  }

  function updateContext() {
    const context = readBridgeContext();
    const documentText = String(context.document || '');
    const selection = String(context.selection || '');
    const name = context.fileName || '未命名文档';
    const label = documentText
      ? `${name} · ${documentText.length.toLocaleString()} 字`
      : '未打开文档';
    const detail = selection
      ? `选中 ${selection.length.toLocaleString()} 字`
      : (context.rootPath ? '可搜索文件夹' : '');
    els.context.textContent = detail ? `${label} · ${detail}` : label;
    els.context.title = [
      context.filePath || name,
      documentText ? `${documentText.length.toLocaleString()} 字` : '',
      selection ? `选中 ${selection.length.toLocaleString()} 字` : ''
    ].filter(Boolean).join(' · ');
  }

  function renderEmpty() {
    const config = currentConfig();
    const examplePrompts = [
      '总结当前文档',
      '把选中的段落改写得更简洁',
      '根据这张图片补一段说明',
      '把这个 PDF 整理成 Markdown'
    ];
    const empty = document.createElement('div');
    empty.className = 'ai-empty';

    const mark = document.createElement('div');
    mark.className = 'ai-empty-mark';
    mark.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.2l1.7 5 5 1.7-5 1.7-1.7 5-1.7-5-5-1.7 5-1.7 1.7-5Z"/></svg>';
    empty.appendChild(mark);

    const title = document.createElement('div');
    title.className = 'ai-empty-title';
    title.textContent = config ? '今天想处理哪份文档？' : '先配置一个模型';
    empty.appendChild(title);

    const desc = document.createElement('p');
    desc.className = 'ai-empty-desc';
    desc.textContent = config && config.hasKey
      ? '我可以阅读当前文档和选中内容，识图、读 PDF/Word，并在你确认后修改文档。'
      : '在 AI 设置里填写服务商、模型名和 API Key，就可以开始。API Key 只保存在本机。';
    empty.appendChild(desc);

    if (config && !config.hasKey) {
      const button = document.createElement('button');
      button.className = 'btn primary';
      button.textContent = '打开 AI 设置';
      button.addEventListener('click', () => openSettings(config.id));
      empty.appendChild(button);
    } else {
      const list = document.createElement('div');
      list.className = 'ai-example-list';
      for (const prompt of examplePrompts) {
        const item = document.createElement('button');
        item.className = 'ai-example';
        item.textContent = prompt;
        item.addEventListener('click', () => {
          els.input.value = prompt;
          els.input.focus();
        });
        list.appendChild(item);
      }
      empty.appendChild(list);
    }

    els.messages.innerHTML = '';
    els.messages.appendChild(empty);
  }

  /* ------------------------------ 面板交互 ------------------------------ */

  function open() {
    if (!els.panel) return;
    els.panel.classList.remove('hidden');
    document.getElementById('btn-ai')?.classList.add('active');
    updateContext();
    updateReadyState();
    if (!state.messages.length) renderEmpty();
    setTimeout(() => {
      scrollMessages();
      els.input.focus();
    }, 50);
  }

  function close() {
    if (!els.panel) return;
    els.panel.classList.add('hidden');
    document.getElementById('btn-ai')?.classList.remove('active');
  }

  function toggle() {
    if (!els.panel) return;
    if (els.panel.classList.contains('hidden')) open();
    else close();
  }

  function clearChat() {
    if (state.streaming) stopGeneration();
    const oldRequestId = state.requestId;
    const resolver = oldRequestId ? state.completionResolvers.get(oldRequestId) : null;
    if (resolver) {
      state.completionResolvers.delete(oldRequestId);
      resolver({ text: '', proposals: [], error: null, aborted: true });
    }
    state.streaming = false;
    state.requestId = null;
    state.assistant = null;
    state.messages = [];
    state.expandReasoning.clear();
    renderEmpty();
    updateReadyState();
    scrollMessages();
  }

  function extractFallbackProposal(text) {
    const match = String(text || '').match(/```json\s*([\s\S]*?)```/i);
    if (!match) return null;
    try {
      const value = JSON.parse(match[1]);
      if (!value || !['edit', 'document', 'create'].includes(value.type)) return null;
      if (value.type === 'edit') {
        if (!value.oldText || typeof value.newText !== 'string') return null;
        return {
          kind: 'edit',
          oldText: String(value.oldText),
          newText: String(value.newText),
          explanation: String(value.explanation || '')
        };
      }
      if (value.type === 'document') {
        if (!value.content) return null;
        return {
          kind: 'document',
          content: String(value.content),
          explanation: String(value.explanation || '')
        };
      }
      if (!value.path || !value.content) return null;
      return {
        kind: 'create',
        path: String(value.path),
        content: String(value.content),
        explanation: String(value.explanation || '')
      };
    } catch {
      return null;
    }
  }

  /* ------------------------------ 附件 ------------------------------ */

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('图片格式无法识别'));
      image.src = source;
    });
  }

  async function compressImage(file) {
    if (file.size > MAX_IMAGE_BYTES) throw new Error('图片超过 10 MB');
    const dataUrl = await readAsDataURL(file);
    if (file.type === 'image/gif' && dataUrl.length <= MAX_IMAGE_DATA_URL) {
      return { dataUrl, mediaType: 'image/gif' };
    }

    const image = await loadImage(dataUrl);
    const maxSide = 2048;
    if (image.width <= maxSide && image.height <= maxSide && dataUrl.length < 1.8 * 1024 * 1024) {
      return { dataUrl, mediaType: file.type || 'image/png' };
    }

    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), mediaType: 'image/jpeg' };
  }

  async function addImageFiles(files) {
    for (const file of files || []) {
      if (!file || !String(file.type || '').startsWith('image/')) continue;
      if (state.pendingImages.length >= MAX_IMAGES) {
        toast(`一次最多发送 ${MAX_IMAGES} 张图片`, 'error', 4000);
        break;
      }
      try {
        const { dataUrl, mediaType } = await compressImage(file);
        state.pendingImages.push({
          id: uid('image'),
          name: file.name || '图片',
          dataUrl,
          mediaType,
          size: file.size
        });
      } catch (error) {
        toast(`图片处理失败：${errorMessage(error)}`, 'error', 4000);
      }
    }
    renderAttachments();
    const config = currentConfig();
    if (state.pendingImages.length && config && !config.supportsVision) {
      toast('当前模型没有开启图片识别，请在 AI 设置里换一个支持图片的模型', 'error', 6000);
    }
  }

  async function addDocumentFiles(files) {
    for (const file of files || []) {
      if (!file) continue;
      if (state.pendingDocs.length >= MAX_DOCS) {
        toast(`一次最多上传 ${MAX_DOCS} 个文档`, 'error', 4000);
        break;
      }
      if (file.size > MAX_DOC_BYTES) {
        toast(`${file.name} 超过 10 MB，已跳过`, 'error', 4000);
        continue;
      }
      const chip = document.createElement('div');
      chip.className = 'ai-doc-chip loading';
      chip.textContent = `正在读取 ${file.name}…`;
      els.attachments.appendChild(chip);
      try {
        const bytes = await file.arrayBuffer();
        const parsed = await api.aiParseDocument(file.name, bytes);
        state.pendingDocs.push({
          id: uid('doc'),
          name: parsed.name,
          text: parsed.text,
          chars: parsed.chars,
          pages: parsed.pages,
          truncated: parsed.truncated
        });
        if (parsed.truncated) toast(`${parsed.name} 文字较多，已截取前 12 万字`, 'info', 5000);
      } catch (error) {
        toast(`读取 ${file.name} 失败：${errorMessage(error)}`, 'error', 6000);
      } finally {
        chip.remove();
      }
    }
    renderAttachments();
  }

  function renderAttachments() {
    els.attachments.innerHTML = '';
    for (const image of state.pendingImages) {
      const item = document.createElement('div');
      item.className = 'ai-image-chip';
      const img = document.createElement('img');
      img.src = image.dataUrl;
      img.alt = image.name;
      item.appendChild(img);
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.title = '移除图片';
      remove.addEventListener('click', () => {
        state.pendingImages = state.pendingImages.filter((item) => item.id !== image.id);
        renderAttachments();
      });
      item.appendChild(remove);
      els.attachments.appendChild(item);
    }
    for (const doc of state.pendingDocs) {
      const item = document.createElement('div');
      item.className = 'ai-doc-chip';
      const label = document.createElement('span');
      label.textContent = `${doc.name} · ${doc.chars.toLocaleString()} 字${doc.pages ? ` · ${doc.pages} 页` : ''}`;
      item.appendChild(label);
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.title = '移除文档';
      remove.addEventListener('click', () => {
        state.pendingDocs = state.pendingDocs.filter((item) => item.id !== doc.id);
        renderAttachments();
      });
      item.appendChild(remove);
      els.attachments.appendChild(item);
    }
  }

  async function handlePaste(event) {
    const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'));
    if (files.length) {
      event.preventDefault();
      await addImageFiles(files);
    }
  }

  async function handleDrop(event) {
    event.preventDefault();
    if (!event.target.closest('.ai-composer')) return;
    const files = Array.from(event.dataTransfer?.files || []);
    const images = files.filter((file) => file.type.startsWith('image/'));
    const docs = files.filter((file) => !file.type.startsWith('image/'));
    if (images.length) await addImageFiles(images);
    if (docs.length) await addDocumentFiles(docs);
  }

  /* ------------------------------ 发送与流式 ------------------------------ */

  function buildMessagesForRequest(currentUserMessage) {
    const messages = [];
    for (const message of state.messages) {
      if (message.role === 'assistant') {
        if (message.text.trim()) messages.push({ role: 'assistant', text: message.text });
        continue;
      }
      if (message === currentUserMessage) {
        messages.push({ role: 'user', text: message.text, images: message.images });
      } else {
        messages.push({ role: 'user', text: message.text });
      }
    }
    return messages;
  }

  function appendUserMessage(message) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-msg ai-msg-user';

    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble';
    if (message.displayText) {
      const text = document.createElement('div');
      text.className = 'ai-user-text';
      text.textContent = message.displayText;
      bubble.appendChild(text);
    }
    if (message.images?.length) {
      const gallery = document.createElement('div');
      gallery.className = 'ai-message-images';
      for (const image of message.images) {
        const img = document.createElement('img');
        img.src = image.dataUrl;
        img.alt = image.name;
        gallery.appendChild(img);
      }
      bubble.appendChild(gallery);
    }
    if (message.docs?.length) {
      const chips = document.createElement('div');
      chips.className = 'ai-message-docs';
      for (const doc of message.docs) {
        const chip = document.createElement('span');
        chip.textContent = `${doc.name} · ${doc.chars.toLocaleString()} 字`;
        chips.appendChild(chip);
      }
      bubble.appendChild(chips);
    }
    const avatar = document.createElement('div');
    avatar.className = 'ai-avatar ai-avatar-user';
    avatar.textContent = '你';
    wrapper.appendChild(avatar);
    wrapper.appendChild(bubble);
    els.messages.appendChild(wrapper);
    scrollMessages();
  }

  function appendAssistantMessage(message) {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-msg ai-msg-assistant';

    const avatar = document.createElement('div');
    avatar.className = 'ai-avatar ai-avatar-ai';
    avatar.textContent = 'R';
    wrapper.appendChild(avatar);

    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble ai-assistant-bubble';

    const reasoning = document.createElement('details');
    reasoning.className = 'ai-reasoning hidden';
    reasoning.innerHTML = '<summary>思考过程</summary><pre data-role="reasoning"></pre>';
    bubble.appendChild(reasoning);

    const status = document.createElement('div');
    status.className = 'ai-tool-status hidden';
    bubble.appendChild(status);

    const text = document.createElement('div');
    text.className = 'ai-text ai-stream-text';
    text.textContent = '';
    bubble.appendChild(text);

    const proposals = document.createElement('div');
    proposals.className = 'ai-proposals';
    bubble.appendChild(proposals);

    wrapper.appendChild(bubble);
    els.messages.appendChild(wrapper);

    message.dom = { wrapper, bubble, reasoning, reasoningText: reasoning.querySelector('[data-role="reasoning"]'), status, text, proposals };
    scrollMessages();
  }

  function removeEmpty() {
    const empty = els.messages.querySelector('.ai-empty');
    if (empty) empty.remove();
  }

  function updateStreamingText(message) {
    if (!message.dom) return;
    message.dom.text.textContent = message.text;
    scrollMessages();
  }

  async function finalizeAssistant(message) {
    if (!message.dom) return;
    if (!message.text.trim()) {
      if (message.proposals.length) {
        message.dom.text.textContent = '已生成修改建议，请在下方查看。';
      } else if (!message.error && !message.aborted) {
        message.dom.text.textContent = '模型没有返回文字内容。';
      }
    } else {
      try {
        const html = await state.bridge.renderMarkdown(message.text);
        message.dom.text.innerHTML = html;
        message.dom.text.classList.remove('ai-stream-text');
      } catch {
        message.dom.text.textContent = message.text;
      }
    }

    if (message.reasoning.trim()) {
      message.dom.reasoning.classList.remove('hidden');
      message.dom.reasoningText.textContent = message.reasoning;
      message.dom.reasoning.open = state.expandReasoning.has(message.id);
      message.dom.reasoning.addEventListener('toggle', () => {
        if (message.dom.reasoning.open) state.expandReasoning.add(message.id);
        else state.expandReasoning.delete(message.id);
      });
    }

    message.dom.status.classList.add('hidden');
    message.streaming = false;
    scrollMessages();
  }

  function sendMessage() {
    if (!els.input || !state.bridge) return null;
    if (state.streaming) return null;

    const typedText = els.input.value.trim();
    if (!typedText && !state.pendingImages.length && !state.pendingDocs.length) return null;

    const config = currentConfig();
    if (!config) {
      toast('请先在 AI 设置里添加一个模型', 'error', 5000);
      openSettings();
      return null;
    }
    if (!config.hasKey) {
      toast('请先在 AI 设置里填写 API Key', 'error', 5000);
      openSettings(config.id);
      return null;
    }
    if (state.pendingImages.length && !config.supportsVision) {
      toast('当前模型没有开启图片识别，请在 AI 设置里换一个支持图片的模型', 'error', 6000);
      openSettings(config.id);
      return null;
    }

    let attachmentText = '';
    let remaining = MAX_ATTACHMENT_CHARS;
    for (const doc of state.pendingDocs) {
      if (remaining <= 0) break;
      const text = doc.text.slice(0, remaining);
      attachmentText += `\n\n<attachment name="${doc.name}"${doc.pages ? ` pages="${doc.pages}"` : ''}>\n${text}\n</attachment>`;
      remaining -= text.length;
    }
    if (remaining <= 0 && state.pendingDocs.length) {
      toast('附件文字较多，已只发送前 6 万字符', 'info', 5000);
    }

    const context = readBridgeContext();
    const fullDocument = String(context.document || '');
    const documentText = fullDocument.slice(0, MAX_CONTEXT_CHARS);

    const userMessage = {
      id: uid('msg'),
      role: 'user',
      text: `${typedText}${attachmentText}`.trim() || '请阅读附件。',
      displayText: typedText,
      images: state.pendingImages.map((image) => ({ ...image })),
      docs: state.pendingDocs.map((doc) => ({ ...doc }))
    };
    state.messages.push(userMessage);
    removeEmpty();
    appendUserMessage(userMessage);

    const assistant = {
      id: uid('msg'),
      role: 'assistant',
      text: '',
      reasoning: '',
      proposals: [],
      error: null,
      aborted: false,
      streaming: true,
      usage: null,
      sourcePath: context.filePath || null,
      sourceDocument: fullDocument,
      sourceRoot: context.rootPath || null
    };
    state.messages.push(assistant);
    state.assistant = assistant;
    appendAssistantMessage(assistant);

    const requestId = uid('req');
    state.requestId = requestId;
    state.streaming = true;
    els.input.value = '';
    state.pendingImages = [];
    state.pendingDocs = [];
    renderAttachments();
    updateContext();
    updateReadyState();

    const request = {
      requestId,
      configId: config.id,
      messages: buildMessagesForRequest(userMessage),
      context: {
        document: documentText,
        selection: String(context.selection || '').slice(0, 8000),
        fileName: context.fileName || '',
        rootPath: context.rootPath || null
      }
    };

    const promise = new Promise((resolve) => {
      state.completionResolvers.set(requestId, resolve);
    });

    try {
      api.aiStartChat(request);
    } catch (error) {
      handleAIEvent({ requestId, type: 'error', message: errorMessage(error) });
      handleAIEvent({ requestId, type: 'done' });
    }

    return promise;
  }

  function handleAIEvent(payload) {
    if (!payload || payload.requestId !== state.requestId) return;
    const assistant = state.assistant;
    if (!assistant) return;

    if (payload.type === 'text-delta') {
      assistant.text += payload.text || '';
      if (assistant.dom?.status) assistant.dom.status.classList.add('hidden');
      updateStreamingText(assistant);
    } else if (payload.type === 'reasoning-delta') {
      assistant.reasoning += payload.text || '';
      if (assistant.dom?.status && !assistant.text) {
        assistant.dom.status.classList.remove('hidden');
        assistant.dom.status.textContent = '正在思考…';
      }
    } else if (payload.type === 'tool-call') {
      if (assistant.dom?.status) {
        assistant.dom.status.classList.remove('hidden');
        const labels = {
          search_files: '正在搜索文件夹…',
          read_file: '正在读取文件…',
          propose_edit: '正在准备修改建议…',
          propose_document: '正在整理整篇修改…',
          propose_create_file: '正在准备新文件…'
        };
        assistant.dom.status.textContent = labels[payload.toolName] || '正在使用工具…';
      }
    } else if (payload.type === 'tool-result') {
      const output = payload.output;
      if (output && output.kind) {
        bindProposalSource(assistant, output);
        assistant.proposals.push(output);
        addProposalCard(assistant, output);
      } else if (output && Array.isArray(output.matches)) {
        if (assistant.dom?.status) {
          assistant.dom.status.classList.remove('hidden');
          assistant.dom.status.textContent = output.matches.length
            ? `搜索到 ${output.matches.length} 处相关内容`
            : '没有搜索到相关内容';
        }
      } else if (output && output.path) {
        if (assistant.dom?.status) {
          assistant.dom.status.classList.remove('hidden');
          assistant.dom.status.textContent = `已读取 ${output.path}`;
        }
      }
    } else if (payload.type === 'finish') {
      assistant.usage = payload.usage || null;
    } else if (payload.type === 'error') {
      assistant.error = payload.message || '模型调用失败';
      if (assistant.dom) {
        const error = document.createElement('div');
        error.className = 'ai-error';
        error.textContent = assistant.error;
        assistant.dom.bubble.appendChild(error);
      }
    } else if (payload.type === 'aborted') {
      assistant.aborted = true;
      if (assistant.dom) {
        const aborted = document.createElement('div');
        aborted.className = 'ai-aborted';
        aborted.textContent = '已停止生成。';
        assistant.dom.bubble.appendChild(aborted);
      }
    } else if (payload.type === 'done') {
      state.streaming = false;
      state.requestId = null;

      if (!assistant.proposals.length && assistant.text.trim() && !assistant.error) {
        const fallback = extractFallbackProposal(assistant.text);
        if (fallback) {
          bindProposalSource(assistant, fallback);
          assistant.proposals.push(fallback);
          assistant.text = assistant.text.replace(/```json\s*[\s\S]*?```/i, '').trim();
          addProposalCard(assistant, fallback);
        }
      }

      if (assistant.text.trim() || assistant.proposals.length || assistant.error || assistant.aborted) {
        finalizeAssistant(assistant);
      }
      updateReadyState();
      const resolver = state.completionResolvers.get(payload.requestId);
      if (resolver) {
        state.completionResolvers.delete(payload.requestId);
        resolver({
          text: assistant.text,
          proposals: assistant.proposals.slice(),
          error: assistant.error,
          aborted: assistant.aborted
        });
      }
      state.assistant = null;
    }
  }

  function stopGeneration() {
    if (!state.streaming || !state.requestId) return;
    try {
      api.aiAbortChat(state.requestId);
    } catch {
      // 忽略
    }
  }

  /* ------------------------------ 修改建议 ------------------------------ */

  function bindProposalSource(assistant, proposal) {
    proposal.sourcePath = assistant.sourcePath || null;
    proposal.sourceDocument = assistant.sourceDocument || '';
    proposal.sourceRoot = assistant.sourceRoot || null;
    return proposal;
  }

  async function addProposalCard(assistant, proposal) {
    if (!assistant.dom) return;
    const card = document.createElement('div');
    card.className = 'ai-proposal-card';

    const header = document.createElement('div');
    header.className = 'ai-proposal-header';
    const title = document.createElement('div');
    title.className = 'ai-proposal-title';
    title.textContent = proposal.kind === 'document'
      ? '整篇修改建议'
      : proposal.kind === 'create'
        ? `新建文件：${proposal.path}`
        : '修改建议';
    header.appendChild(title);
    card.appendChild(header);

    if (proposal.explanation) {
      const explanation = document.createElement('p');
      explanation.className = 'ai-proposal-explanation';
      explanation.textContent = proposal.explanation;
      card.appendChild(explanation);
    }

    const diffBox = document.createElement('div');
    diffBox.className = 'ai-diff';
    diffBox.textContent = '正在计算差异…';
    card.appendChild(diffBox);

    const actions = document.createElement('div');
    actions.className = 'ai-proposal-actions';
    card.appendChild(actions);

    const copyButton = document.createElement('button');
    copyButton.className = 'btn small';
    copyButton.textContent = '复制';
    copyButton.addEventListener('click', async () => {
      const content = proposal.kind === 'document' ? proposal.content
        : proposal.kind === 'create' ? proposal.content
          : proposal.newText;
      try {
        await navigator.clipboard.writeText(content);
        toast('已复制', 'ok');
      } catch {
        toast('复制失败', 'error');
      }
    });
    actions.appendChild(copyButton);

    if (proposal.kind === 'create') {
      const createButton = document.createElement('button');
      createButton.className = 'btn primary small';
      createButton.textContent = '创建文件';
      createButton.addEventListener('click', () => createProposalFile(proposal, card, actions));
      actions.appendChild(createButton);
    } else {
      const applyButton = document.createElement('button');
      applyButton.className = 'btn primary small';
      applyButton.textContent = '应用修改';
      applyButton.addEventListener('click', () => applyProposal(proposal, card, actions));
      actions.appendChild(applyButton);
    }

    assistant.dom.proposals.appendChild(card);
    scrollMessages();

    let oldText = proposal.oldText || '';
    if (proposal.kind === 'document') {
      oldText = typeof proposal.sourceDocument === 'string'
        ? proposal.sourceDocument
        : String(state.bridge.getDocument() || '');
    }
    const newText = proposal.kind === 'create' ? proposal.content : (proposal.content || proposal.newText || '');
    try {
      const parts = await api.aiDiff(oldText, newText);
      renderDiff(diffBox, parts);
    } catch (error) {
      diffBox.textContent = errorMessage(error);
    }
  }

  function renderDiff(container, parts) {
    container.innerHTML = '';
    let lines = 0;
    for (const part of parts) {
      const value = String(part.value || '');
      const segments = value.split('\n');
      if (segments[segments.length - 1] === '') segments.pop();
      for (const line of segments) {
        lines += 1;
        if (lines > 500) {
          const more = document.createElement('div');
          more.className = 'ai-diff-more';
          more.textContent = '差异较多，仅显示前 500 行。应用前请确认修改内容。';
          container.appendChild(more);
          return;
        }
        const row = document.createElement('div');
        row.className = `ai-diff-line${part.added ? ' added' : ''}${part.removed ? ' removed' : ''}`;
        row.textContent = `${part.added ? '+ ' : part.removed ? '- ' : '  '}${line}`;
        container.appendChild(row);
      }
    }
  }

  function applyProposal(proposal, card, actions) {
    try {
      const context = readBridgeContext();
      if ((context.filePath || null) !== (proposal.sourcePath || null)) {
        toast('这条建议是为另一份文档生成的。请切换回原文档后再应用。', 'error', 7000);
        return;
      }

      const current = String(context.document || '');
      if (proposal.kind === 'document' && current !== (proposal.sourceDocument || '')) {
        toast('文档内容已经变化，请重新让 AI 生成修改建议。', 'error', 7000);
        return;
      }

      let next;
      if (proposal.kind === 'document') {
        next = proposal.content;
      } else {
        const oldText = proposal.oldText;
        const index = current.indexOf(oldText);
        if (index < 0) {
          toast('文档里找不到这段原文，可能已经被修改。请重新让 AI 生成建议。', 'error', 7000);
          return;
        }
        if (current.indexOf(oldText, index + oldText.length) >= 0) {
          toast('这段原文在文档里出现了多次，无法确定改哪一处。请先选中目标段落，再让 AI 修改。', 'error', 7000);
          return;
        }
        next = current.slice(0, index) + proposal.newText + current.slice(index + oldText.length);
      }

      const before = state.bridge.applyDocument(next);
      if (before == null) {
        toast('请先打开一个文档', 'error', 5000);
        return;
      }
      proposal.applied = true;
      proposal.before = before;
      proposal.after = String(state.bridge.getDocument() || next);

      actions.innerHTML = '';
      const applied = document.createElement('span');
      applied.className = 'ai-applied-label';
      applied.textContent = '已应用';
      actions.appendChild(applied);

      const undo = document.createElement('button');
      undo.className = 'btn small';
      undo.textContent = '撤销';
      undo.addEventListener('click', () => {
        const undoContext = readBridgeContext();
        if ((undoContext.filePath || null) !== (proposal.sourcePath || null)) {
          toast('请先切换回应用这条建议的文档，再撤销。', 'error', 6000);
          return;
        }
        if (String(undoContext.document || '') !== proposal.after) {
          toast('应用后文档又有修改，无法自动撤销。请手动恢复或重新生成建议。', 'error', 7000);
          return;
        }
        const currentBefore = state.bridge.applyDocument(proposal.before);
        if (currentBefore == null) return;
        proposal.applied = false;
        actions.innerHTML = '';
        const apply = document.createElement('button');
        apply.className = 'btn primary small';
        apply.textContent = '应用修改';
        apply.addEventListener('click', () => applyProposal(proposal, card, actions));
        actions.appendChild(apply);
        const copy = document.createElement('button');
        copy.className = 'btn small';
        copy.textContent = '复制';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(proposal.kind === 'document' ? proposal.content : proposal.newText);
            toast('已复制', 'ok');
          } catch {
            toast('复制失败', 'error');
          }
        });
        actions.appendChild(copy);
        toast('已撤销本次修改', 'ok');
      });
      actions.appendChild(undo);
      toast('已应用修改，可继续编辑或撤销', 'ok', 4000);
    } catch (error) {
      toast(`应用修改失败：${errorMessage(error)}`, 'error', 6000);
    }
  }

  async function createProposalFile(proposal, card, actions) {
    try {
      const context = readBridgeContext();
      if (!context.rootPath) {
        toast('请先打开一个文件夹，再创建文件', 'error', 5000);
        return;
      }
      if ((context.rootPath || null) !== (proposal.sourceRoot || null)) {
        toast('这条新建建议是为另一个文件夹生成的。请切换回原文件夹后再创建。', 'error', 7000);
        return;
      }

      const clean = String(proposal.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!clean || clean.includes('..')) {
        toast('文件路径不合法', 'error', 5000);
        return;
      }
      const withExtension = /\.(md|markdown|txt)$/i.test(clean) ? clean : `${clean}.md`;
      const parts = withExtension.split('/').filter(Boolean);
      const fileName = parts.pop();
      let directory = context.rootPath;

      for (const part of parts) {
        const nextDirectory = `${directory.replace(/[\\/]+$/, '')}/${part}`;
        try {
          await api.createFolder(directory, part);
        } catch {
          // 已存在时继续使用这个目录
        }
        directory = nextDirectory;
      }

      const created = await api.createFile(directory, fileName);
      await api.writeFile(created.path, proposal.content, '\n');
      await state.bridge.refreshTree();
      await state.bridge.openFile(created.path);

      proposal.applied = true;
      actions.innerHTML = '';
      const applied = document.createElement('span');
      applied.className = 'ai-applied-label';
      applied.textContent = `已创建：${created.name}`;
      actions.appendChild(applied);
      toast(`已创建文件：${created.name}`, 'ok', 5000);
    } catch (error) {
      toast(`创建文件失败：${errorMessage(error)}`, 'error', 6000);
    }
  }

  /* ------------------------------ 设置面板 ------------------------------ */

  function openSettings(configId) {
    if (!els.overlay) return;
    state.settingsOpen = true;
    els.overlay.classList.remove('hidden');
    els.testResult.textContent = '';
    renderConfigList();
    const target = configId
      ? state.configs.find((config) => config.id === configId)
      : currentConfig();
    if (target) loadConfig(target);
    else startNewConfig();
    setTimeout(() => {
      const first = els.form.querySelector('[data-field="name"]');
      if (first) first.focus();
    }, 30);
  }

  function closeSettings() {
    state.settingsOpen = false;
    if (!els.overlay) return;
    els.overlay.classList.add('hidden');
    els.testResult.textContent = '';
  }

  function renderConfigList() {
    els.configItems.innerHTML = '';
    if (!state.configs.length) {
      const empty = document.createElement('div');
      empty.className = 'ai-config-empty';
      empty.textContent = '还没有配置模型。点击“添加”创建一个。';
      els.configItems.appendChild(empty);
      return;
    }
    for (const config of state.configs) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `ai-config-item${config.id === state.editingConfigId ? ' active' : ''}`;
      const name = document.createElement('span');
      name.className = 'ai-config-name';
      name.textContent = config.name;
      item.appendChild(name);
      const meta = document.createElement('span');
      meta.className = 'ai-config-meta';
      meta.textContent = `${config.model}${config.hasKey ? '' : ' · 未填 Key'}`;
      item.appendChild(meta);
      item.addEventListener('click', () => loadConfig(config));
      els.configItems.appendChild(item);
    }
  }

  function setFormValue(field, value) {
    const element = els.form.querySelector(`[data-field="${field}"]`);
    if (!element) return;
    if (element.type === 'checkbox') element.checked = Boolean(value);
    else element.value = value == null ? '' : value;
  }

  function getFormValue(field) {
    const element = els.form.querySelector(`[data-field="${field}"]`);
    if (!element) return '';
    return element.type === 'checkbox' ? element.checked : element.value;
  }

  function loadConfig(config) {
    if (!config) return;
    state.editingConfigId = config.id;
    state.activeConfigIdForForm = config.id;
    setFormValue('name', config.name);
    setFormValue('type', config.type);
    setFormValue('baseURL', config.baseURL);
    setFormValue('model', config.model);
    setFormValue('apiKey', '');
    setFormValue('supportsVision', config.supportsVision);
    setFormValue('supportsTools', config.supportsTools);
    setFormValue('supportsStreaming', config.supportsStreaming);
    setFormValue('maxContextChars', config.maxContextChars || 60000);
    const keyInput = els.form.querySelector('[data-field="apiKey"]');
    keyInput.placeholder = config.hasKey ? '已保存，留空不修改' : 'sk-...';
    els.keyHint.textContent = config.hasKey ? 'Key 已加密保存在本机；重新输入会覆盖。' : 'Key 只保存在本机，不会写进源码。';
    els.preset.value = '';
    els.testResult.textContent = '';
    renderConfigList();
  }

  function startNewConfig() {
    state.editingConfigId = null;
    state.activeConfigIdForForm = null;
    els.form.reset();
    setFormValue('type', 'openai-compatible');
    setFormValue('supportsTools', true);
    setFormValue('supportsStreaming', true);
    setFormValue('maxContextChars', 60000);
    const keyInput = els.form.querySelector('[data-field="apiKey"]');
    keyInput.placeholder = 'sk-...';
    els.keyHint.textContent = 'Key 只保存在本机，不会写进源码。';
    els.preset.value = '';
    els.testResult.textContent = '';
    renderConfigList();
  }

  function applyPreset(preset) {
    state.editingConfigId = null;
    state.activeConfigIdForForm = null;
    setFormValue('name', preset.name);
    setFormValue('type', preset.type);
    setFormValue('baseURL', preset.baseURL);
    setFormValue('model', preset.model);
    setFormValue('supportsVision', preset.supportsVision);
    setFormValue('supportsTools', preset.supportsTools);
    setFormValue('supportsStreaming', preset.supportsStreaming);
    setFormValue('maxContextChars', 60000);
    if (preset.apiKey) setFormValue('apiKey', preset.apiKey);
    renderConfigList();
  }

  function collectDraft() {
    return {
      id: state.editingConfigId || undefined,
      name: String(getFormValue('name') || '').trim(),
      type: getFormValue('type'),
      baseURL: String(getFormValue('baseURL') || '').trim(),
      model: String(getFormValue('model') || '').trim(),
      apiKey: String(getFormValue('apiKey') || '').trim(),
      supportsVision: Boolean(getFormValue('supportsVision')),
      supportsTools: Boolean(getFormValue('supportsTools')),
      supportsStreaming: Boolean(getFormValue('supportsStreaming')),
      maxContextChars: Number(getFormValue('maxContextChars')) || 60000
    };
  }

  async function saveConfig() {
    const draft = collectDraft();
    if (!draft.name) {
      toast('请填写配置名称', 'error', 4000);
      return;
    }
    if (!draft.model) {
      toast('请填写模型名', 'error', 4000);
      return;
    }
    try {
      const previous = state.editingConfigId
        ? state.configs.find((config) => config.id === state.editingConfigId)
        : null;
      const hadKey = Boolean(previous && previous.hasKey);
      const data = await api.aiSaveConfig(draft);
      state.configs = data.configs;
      state.activeConfigId = data.activeConfigId;
      const saved = state.editingConfigId
        ? state.configs.find((config) => config.id === state.editingConfigId)
        : state.configs[state.configs.length - 1];
      if (saved) {
        state.editingConfigId = saved.id;
        loadConfig(saved);
      }
      renderModelSelect();
      updateReadyState();
      if (hadKey && saved && !saved.hasKey && !String(draft.apiKey || '').trim()) {
        toast('接口地址或类型已更改，请重新填写 API Key', 'info', 7000);
      } else {
        toast('模型配置已保存', 'ok');
      }
    } catch (error) {
      toast(`保存失败：${errorMessage(error)}`, 'error', 6000);
    }
  }

  async function testConfig() {
    const draft = collectDraft();
    els.testResult.textContent = '正在测试连接…';
    els.testResult.className = 'ai-test-result';
    try {
      const result = await api.aiTestConfig(draft);
      els.testResult.className = 'ai-test-result ok';
      els.testResult.textContent = `连接成功 · ${result.latencyMs} ms${result.preview ? ` · ${result.preview}` : ''}`;
    } catch (error) {
      els.testResult.className = 'ai-test-result error';
      els.testResult.textContent = errorMessage(error);
    }
  }

  async function deleteConfig() {
    if (!state.editingConfigId) {
      toast('请先选择一个已保存的配置', 'error', 4000);
      return;
    }
    if (!window.confirm('确定删除这个模型配置吗？API Key 也会一起删除。')) return;
    try {
      const data = await api.aiDeleteConfig(state.editingConfigId);
      state.configs = data.configs;
      state.activeConfigId = data.activeConfigId;
      state.editingConfigId = null;
      renderModelSelect();
      updateReadyState();
      renderConfigList();
      startNewConfig();
      toast('已删除配置', 'ok');
    } catch (error) {
      toast(`删除失败：${errorMessage(error)}`, 'error', 5000);
    }
  }

  async function restoreDefaultConfig() {
    if (!window.confirm('恢复默认配置会重新添加“智桂 API”模板（不会覆盖其他配置），继续吗？')) return;
    try {
      const data = await api.aiSaveConfig({
        name: '智桂 API',
        type: 'openai-compatible',
        baseURL: 'https://api.zhigui.icu/v1',
        model: 'cn:deepseek-v4.1-flash',
        supportsVision: true,
        supportsTools: true,
        supportsStreaming: true,
        maxContextChars: 60000
      });
      state.configs = data.configs;
      state.activeConfigId = data.activeConfigId;
      renderModelSelect();
      renderConfigList();
      updateReadyState();
      toast('已恢复默认配置模板，请填写 API Key', 'ok', 5000);
    } catch (error) {
      toast(`恢复失败：${errorMessage(error)}`, 'error', 5000);
    }
  }

  /* ------------------------------ 初始化 ------------------------------ */

  function init(bridge) {
    if (state.bridge) return;
    state.bridge = bridge;
    buildPanel();
    bindEvents();
    api.onAIEvent(handleAIEvent);
    refreshConfigs();
    updateContext();
  }

  window.readmdAI = {
    init,
    open,
    close,
    toggle,
    openSettings,
    clear: clearChat
  };

  window.__readmdAISmoke = {
    open: () => { open(); return true; },
    close: () => { close(); return true; },
    openSettings: () => { openSettings(); return true; },
    closeSettings: () => { closeSettings(); return true; },
    refresh: () => refreshConfigs(),
    applyFirstProposal: () => {
      const button = document.querySelector('#ai-panel .ai-proposal-card .btn.primary');
      if (!button) return false;
      button.click();
      return true;
    },
    undoFirstProposal: () => {
      const buttons = Array.from(document.querySelectorAll('#ai-panel .ai-proposal-card .btn'));
      const undo = buttons.find((button) => button.textContent === '撤销');
      if (!undo) return false;
      undo.click();
      return true;
    },
    documentText: () => (state.bridge ? state.bridge.getDocument() : ''),
    chat: (text, options = {}) => {
      els.input.value = String(text || '');
      if (options.images) state.pendingImages = options.images.slice(0, MAX_IMAGES);
      if (options.docs) state.pendingDocs = options.docs.slice(0, MAX_DOCS);
      renderAttachments();
      return sendMessage();
    },
    state: () => ({
      configs: state.configs,
      activeConfigId: state.activeConfigId,
      messages: state.messages.map((message) => ({
        role: message.role,
        text: message.text,
        displayText: message.displayText,
        proposals: message.proposals,
        error: message.error,
        aborted: message.aborted
      }))
    })
  };
})();
