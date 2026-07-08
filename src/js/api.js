/* ============================================================
   api.js —— 封装对 Python FastAPI 后端的 fetch 调用
   后端地址: http://127.0.0.1:19800
   ============================================================ */

const API_BASE = 'http://127.0.0.1:19800';

/**
 * 基础请求封装
 * @param {string} endpoint - API 路径 (如 /v1/chat/completions)
 * @param {object} options - fetch 选项
 * @returns {Promise<Response>}
 */
async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  };

  try {
    const response = await fetch(url, config);
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new ApiError(response.status, error.detail || '请求失败');
    }
    return response;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, `无法连接到后端服务 (${API_BASE})，请确认后端已启动`);
  }
}

/** API 错误类 */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// ===== 聊天 API =====

/**
 * 发送聊天消息（流式 SSE）
 * @param {Array} messages - 消息历史
 * @param {object} options - { model, stream, onDelta, onDone, onError }
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
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new ApiError(response.status, err.detail || '请求失败');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';   // 剩余不完整的放回 buffer

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
  const res = await request('/health');
  return res.json();
}

// ===== 知识库 API =====
const knowledgeAPI = {
  upload: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE}/knowledge/upload`, {
      method: 'POST',
      body: formData,
    });
    return res.json();
  },
  ask: async (question, topK = 5) => {
    const res = await request('/knowledge/ask', {
      method: 'POST',
      body: JSON.stringify({ question, top_k: topK }),
    });
    return res.json();
  },
  listFiles: async () => {
    const res = await request('/knowledge/files');
    return res.json();
  },
  deleteFile: async (fileName) => {
    const res = await request(`/knowledge/files/${encodeURIComponent(fileName)}`, {
      method: 'DELETE',
    });
    return res.json();
  },
};

// ===== 配置 API =====
const configAPI = {
  get: async (key) => {
    const res = await request(`/config/${key}`);
    return res.json();
  },
  set: async (key, value) => {
    const res = await request(`/config/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
    return res.json();
  },
  getAll: async () => {
    const res = await request('/config');
    return res.json();
  },
};
