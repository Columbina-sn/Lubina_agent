/* ============================================================
   api.js v2 —— 统一 fetch 封装，对接后端 {code, message, data} 格式

   后端地址: http://127.0.0.1:19800
   后端所有响应遵循: { "code": 200, "message": "ok", "data": {...} }
     - code=200  → 成功，request() 自动解包返回 data
     - code≠200  → 失败，request() 抛出 ApiError(code, message)
   ============================================================ */

const API_BASE = 'http://127.0.0.1:19800';

// ===== 错误类 =====

/** API 错误 */
class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ApiError';
    this.code = code;        // 后端返回的 code 字段（0=成功，非0=失败）
    this.status = code;       // 兼容旧代码中 .status 的使用
  }
}

// ===== 核心封装 =====

/**
 * 统一请求函数 —— 自动解析后端 {code, message, data} 格式
 *
 * 成功时（code=0）：返回 data 字段（解包后的实际数据）
 * 失败时（code≠0）：抛出 ApiError(code, message)
 * 网络断开时：抛出 ApiError(0, "无法连接到后端...")
 *
 * @param {string} endpoint - API 路径，如 '/health'
 * @param {object} options - fetch 选项（method, body, headers 等）
 * @returns {Promise<any>} 后端返回的 data 字段
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;

  // 自动设置 Content-Type（FormData 除外）
  const isFormData = options.body instanceof FormData;
  const config = {
    headers: {},
    ...options,
  };
  if (!isFormData && !config.headers['Content-Type']) {
    config.headers['Content-Type'] = 'application/json';
  }

  // ===== 1. 发起请求 =====
  let response;
  try {
    response = await fetch(url, config);
  } catch (err) {
    throw new ApiError(0, `无法连接到后端服务 (${API_BASE})，请确认后端已启动`);
  }

  // ===== 2. 解析 JSON =====
  let body;
  try {
    body = await response.json();
  } catch (_) {
    throw new ApiError(response.status, '服务器返回数据异常');
  }

  // ===== 3. 检查统一响应格式 {code, message, data} =====
  if (body && typeof body.code === 'number') {
    if (body.code !== 200) {
      throw new ApiError(body.code, body.message || '请求失败');
    }
    // 成功 → 解包，只返回 data 部分
    return body.data !== undefined ? body.data : body;
  }

  // ===== 4. 兼容非标准响应（如第三方 API 直接透传）=====
  if (!response.ok) {
    throw new ApiError(
      response.status,
      body.detail || body.message || `请求失败 (${response.status})`
    );
  }
  return body;
}

// ===== 便捷方法 =====

const api = {
  /** GET 请求 */
  get(endpoint) {
    return request(endpoint);
  },

  /** POST 请求 */
  post(endpoint, data) {
    return request(endpoint, {
      method: 'POST',
      body: data instanceof FormData ? data : JSON.stringify(data),
    });
  },

  /** PUT 请求 */
  put(endpoint, data) {
    return request(endpoint, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  /** DELETE 请求 */
  del(endpoint) {
    return request(endpoint, { method: 'DELETE' });
  },
};

// ===== 聊天 API（流式 SSE）=====

/**
 * 发送聊天消息（流式 SSE）
 *
 * 注意：SSE 是流式协议，不使用 {code, message, data} 包装。
 * 后端直接返回 OpenAI 兼容的 SSE 流：data: {...}\n\ndata: [DONE]\n\n
 *
 * @param {Array} messages - 消息历史
 * @param {object} options - { model, onDelta, onDone, onError }
 * @returns {AbortController} 用于取消请求
 */
function chatStream(messages, options = {}) {
  const {
    model = 'deepseek-chat',
    onDelta = () => {},
    onDone = () => {},
    onError = () => {},
  } = options;

  const controller = new AbortController();

  fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        // 后端异常响应也是 {code, message, data} 格式
        const message = err.message || err.detail || `请求失败 (${response.status})`;
        throw new ApiError(response.status, message);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') {
            onDone();
            return;
          }
          try {
            const json = JSON.parse(data);
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) onDelta(delta);
          } catch (_) { /* 忽略解析失败的行 */ }
        }
      }
      onDone();
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        onError(err);
      }
    });

  return controller;
}

// ===== 健康检查 =====

async function healthCheck() {
  return request('/health');
}

// ===== 知识库 API =====

const knowledgeAPI = {
  /** 上传文件到知识库（旧版，直接存储） */
  upload: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/api/knowledge/upload', formData);
  },

  /** AI 提取上传（新版，文件 → AI 提取 → 去重 → 存储） */
  aiUpload: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post('/api/knowledge/ai-upload', formData);
  },

  /** 列出知识条目（visible: 1=显式 0=隐藏） */
  listItems: async (visible = 1) => {
    return api.get(`/api/knowledge/items?visible=${visible}`);
  },

  /** 列出结构化信息条目 */
  listInfos: async (visible = 1) => {
    return api.get(`/api/knowledge/infos?visible=${visible}`);
  },

  /** 获取单条详情 */
  getItem: async (id) => {
    return api.get(`/api/knowledge/items/${id}`);
  },

  /** 获取单条结构化信息 */
  getInfo: async (id) => {
    return api.get(`/api/knowledge/infos/${id}`);
  },

  /** 编辑条目 */
  updateItem: async (id, data) => {
    return api.put(`/api/knowledge/items/${id}`, data);
  },

  /** 编辑结构化信息 */
  updateInfo: async (id, data) => {
    return api.put(`/api/knowledge/infos/${id}`, data);
  },

  /** 切换显隐 */
  toggleItem: async (id) => {
    return api.put(`/api/knowledge/items/${id}/toggle`);
  },

  /** 切换结构化信息显隐 */
  toggleInfo: async (id) => {
    return api.put(`/api/knowledge/infos/${id}/toggle`);
  },

  /** 删除条目 */
  deleteItem: async (id) => {
    return api.del(`/api/knowledge/items/${id}`);
  },

  /** 删除结构化信息 */
  deleteInfo: async (id) => {
    return api.del(`/api/knowledge/infos/${id}`);
  },

  /** 搜索知识库 */
  searchInfos: async (query) => {
    return api.get(`/api/knowledge/infos/search?q=${encodeURIComponent(query)}`);
  },
};

// ===== 配置 API =====

const configAPI = {
  /** 读取单个配置 */
  get: async (key) => {
    return api.get(`/api/config/${key}`);
  },

  /** 写入配置 */
  set: async (key, value) => {
    return api.put(`/api/config/${key}`, { value });
  },

  /** 读取所有配置 */
  getAll: async () => {
    return api.get('/api/config');
  },
};
