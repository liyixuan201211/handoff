/**
 * Handoff — 前端 API 客户端（[S5] 前端工程师）
 *
 * 硬约束：本文件**绝不允许**出现顶层 window / document / fetch 调用。
 * fetch 只在函数体内取（并用 typeof 保护），这样测试可以在 Node 里 import 并注入假实现。
 *
 * 契约见 docs/CONTRACT.md §2。所有响应是 JSON；错误统一形状
 * { error: { code, message } }。
 */

/** 内置兜底模板：/api/templates 挂了或返回空时用，保证首页永远不空白。 */
export const FALLBACK_TEMPLATES = [
  { id: 'contract-review', title: '帮我看看这份合同有没有坑', desc: '把合同条款里的风险、对你不利的地方挑出来，用大白话讲。', icon: '陈', role: '项目经理' },
  { id: 'shop-promo', title: '给小店写一段促销文案', desc: '说清楚你的店卖什么、想发给谁，我们写好一段能直接用的文字。', icon: '王', role: '执行专员' },
  { id: 'patient-notes', title: '把专业术语翻译成病人能听懂的话', desc: '给病人或家属看的说明，去掉术语，保留重点。', icon: '李', role: '执行专员' },
  { id: 'lesson-plan', title: '帮我备一节课的教案', desc: '按课时给出目标、环节、练习和作业。', icon: '张', role: '项目经理' },
  { id: 'compare-options', title: '帮我比较几个选择该怎么选', desc: '把每个选择的优缺点、适合谁、要花多少钱列清楚。', icon: '刘', role: '调研员' },
  { id: 'summarize-doc', title: '把这份长资料读成三分钟能看完的摘要', desc: '提炼要点、结论和你要做的下一步。', icon: '赵', role: '调研员' },
];

/** 把后端错误对象翻译成普通人能看懂的一句话。 */
export function friendlyError(err) {
  const code = err && err.code ? String(err.code) : '';
  const table = {
    RATE_LIMITED: '你操作得有点快，等一分钟再试就好。',
    PAYLOAD_TOO_LARGE: '这次发的内容太长了，拆成两三次发可能更好。',
    VALIDATION_ERROR: '有一项没填对，检查一下输入框里的内容。',
    JOB_NOT_FOUND: '这个任务找不到了，可能已经被删掉。',
    LLM_TIMEOUT: '模型那边响应太慢，可以先重试一次。',
    LLM_ALL_PROVIDERS_FAILED: '所有模型都没连上，检查一下网络，我们待会儿再试。',
    NETWORK_ERROR: '连不上本机的服务，确认程序还在运行。',
    BAD_JSON: '服务返回的内容看不懂，稍后再试。',
  };
  if (table[code]) return table[code];
  const msg = err && err.message ? String(err.message) : '';
  if (msg && !/^[A-Z_]+$/.test(msg)) return msg;
  if (msg) return '出了点问题（' + msg + '），可以重试一次。';
  return '出了点问题，可以重试一次。';
}

/**
 * 创建 API 客户端。
 * @param {{origin?:string, fetchImpl?:Function, timeoutMs?:number}} options
 */
export function createApi(options) {
  const o = options || {};
  const origin = typeof o.origin === 'string' ? o.origin : '';
  const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : 20000;

  function pickFetch() {
    if (typeof o.fetchImpl === 'function') return o.fetchImpl;
    if (typeof fetch === 'function') return fetch;
    return null;
  }

  function url(path) {
    return origin + path;
  }

  async function request(path, init) {
    const f = pickFetch();
    if (!f) throw Object.assign(new Error('NETWORK_ERROR'), { code: 'NETWORK_ERROR' });

    const conf = Object.assign({ headers: {} }, init || {});
    conf.headers = Object.assign({ Accept: 'application/json' }, conf.headers || {});
    if (conf.body !== undefined && conf.body !== null) {
      conf.headers['Content-Type'] = 'application/json';
      conf.body = typeof conf.body === 'string' ? conf.body : JSON.stringify(conf.body);
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    if (controller && timeoutMs > 0) {
      conf.signal = controller.signal;
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    let res;
    try {
      res = await f(url(path), conf);
    } catch (err) {
      if (timer) clearTimeout(timer);
      const aborted = err && (err.name === 'AbortError');
      throw Object.assign(new Error(aborted ? '请求超时了' : '连接不上服务'), {
        code: aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
        cause: err,
      });
    }
    if (timer) clearTimeout(timer);

    const text = typeof res.text === 'function' ? await res.text() : '';
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (err) { body = null; }
    }
    if (text && body === null) {
      throw Object.assign(new Error('服务返回的内容看不懂'), { code: 'BAD_JSON', status: res.status });
    }
    if (!res.ok) {
      const info = (body && body.error) || {};
      throw Object.assign(new Error(info.message || '请求失败'), {
        code: info.code || 'HTTP_' + res.status,
        status: res.status,
      });
    }
    return body;
  }

  return {
    origin,

    /** POST /api/jobs —— 立即返回 job（后台跑流水线）。 */
    createJob(input) {
      const payload = { goal: String((input && input.goal) || '') };
      if (input && input.templateId) payload.templateId = input.templateId;
      if (input && input.audience) payload.audience = input.audience;
      if (input && input.tone) payload.tone = input.tone;
      if (input && input.deadline) payload.deadline = input.deadline;
      if (input && input.demo) payload.demo = true;
      return request('/api/jobs', { method: 'POST', body: payload });
    },

    /** GET /api/jobs */
    listJobs() {
      return request('/api/jobs', { method: 'GET' });
    },

    /** GET /api/jobs/:id */
    getJob(id) {
      return request('/api/jobs/' + encodeURIComponent(id), { method: 'GET' });
    },

    /** POST /api/jobs/:id/message */
    sendMessage(id, message) {
      return request('/api/jobs/' + encodeURIComponent(id) + '/message', {
        method: 'POST', body: { message: String(message || '') },
      });
    },

    /** POST /api/jobs/:id/retry */
    retryJob(id) {
      return request('/api/jobs/' + encodeURIComponent(id) + '/retry', { method: 'POST', body: {} });
    },

    /** DELETE /api/jobs/:id */
    deleteJob(id) {
      return request('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' });
    },

    /** GET /api/templates —— 失败或为空时返回内置兜底模板（绝不空白页）。 */
    async getTemplates() {
      try {
        const body = await request('/api/templates', { method: 'GET' });
        const list = Array.isArray(body) ? body : (body && Array.isArray(body.templates) ? body.templates : []);
        if (!list.length) return { templates: FALLBACK_TEMPLATES, fallback: true };
        return { templates: list, fallback: false };
      } catch (err) {
        return { templates: FALLBACK_TEMPLATES, fallback: true, error: err };
      }
    },

    /** GET /api/health */
    health() {
      return request('/api/health', { method: 'GET' });
    },

    /** 交付物下载地址（浏览器直接打开即可，服务端会带 Content-Disposition）。 */
    artifactDownloadUrl(jobId, artifactId) {
      return url('/api/jobs/' + encodeURIComponent(jobId) + '/artifacts/' + encodeURIComponent(artifactId) + '/download');
    },

    /**
     * 打开 SSE 事件流，返回控制器。
     * 断线由 EventSource 自动重连，这里补齐"给用户看的"状态反馈与手动重连。
     * @param {string} jobId
     * @param {{onEvent?:Function, onState?:Function}} handlers
     * @returns {{close:Function, reconnect:Function, state:Function}}
     */
    openStream(jobId, handlers) {
      const h = handlers || {};
      const ES = typeof EventSource !== 'undefined' ? EventSource : (typeof o.EventSourceImpl === 'function' ? o.EventSourceImpl : null);
      let source = null;
      let closed = false;
      let state = 'connecting';

      const setState = (next) => {
        state = next;
        if (typeof h.onState === 'function') h.onState(next);
      };

      const connect = () => {
        if (!ES || closed) {
          // 浏览器太老 / 测试环境：退化成"连不上"，界面会给手动重连按钮
          if (!ES) setState('offline');
          return;
        }
        setState('connecting');
        source = new ES(url('/api/jobs/' + encodeURIComponent(jobId) + '/stream'));
        source.onopen = () => setState('live');
        source.onmessage = (ev) => {
          if (closed) return;
          let data = null;
          try { data = JSON.parse(ev && ev.data ? ev.data : ''); } catch (err) { data = null; }
          if (data && typeof h.onEvent === 'function') h.onEvent(data);
        };
        source.onerror = () => {
          if (closed) return;
          // EventSource 的 readyState：0=CONNECTING（正在自动重连）1=OPEN 2=CLOSED（放弃）
          const rs = source ? source.readyState : 2;
          if (rs === 2) setState('offline');
          else setState('reconnecting');
        };
      };

      connect();

      return {
        close() {
          closed = true;
          if (source) { try { source.close(); } catch (err) { /* ignore */ } }
          source = null;
        },
        reconnect() {
          if (source) { try { source.close(); } catch (err) { /* ignore */ } }
          closed = false;
          connect();
        },
        state() { return state; },
      };
    },
  };
}

export default { createApi, FALLBACK_TEMPLATES, friendlyError };
