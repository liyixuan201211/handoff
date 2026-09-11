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

/**
 * 错误码 → 人话。
 *
 * ⚠️ 这张表以前是坏的：它映射的 `VALIDATION_ERROR` / `JOB_NOT_FOUND` /
 * `LLM_ALL_PROVIDERS_FAILED` **在服务端根本不存在**（是凭印象写的），
 * 而服务端最常抛的 `LLM_NO_PROVIDER`、`INTERRUPTED`、`LLM_EMPTY_RESPONSE`
 * 一个都没有 —— 于是它们全部落到兜底分支，把技术消息原样吐给用户。
 *
 * 现在这份清单**逐条对齐 `src/llm/errors.js` 的 ERR 表**。
 * 新增错误码时两边要一起改；`tests/unit/frontend.test.js` 有断言守着这份对齐。
 */
export const ERROR_COPY = {
  // —— 请求本身的问题（用户能自己修）——
  BAD_REQUEST: '这条内容我们收不了，检查一下是不是空着或者格式不对。',
  VALIDATION_ERROR: '有一项没填对，检查一下输入框里的内容。',
  RATE_LIMITED: '你点得有点快，等一分钟再来就好。',
  PAYLOAD_TOO_LARGE: '这次发的内容太长了。拆成两三次发，或者只把最要紧的部分发过来。',
  NOT_FOUND: '这个任务找不到了，可能已经被删掉。',
  JOB_NOT_FOUND: '这个任务找不到了，可能已经被删掉。',
  INTERNAL_ERROR: '我们这边出了点问题，已经记下来了。可以重试一次。',

  // —— 模型那边的问题（用户只能等或重试）——
  LLM_TIMEOUT: '模型这次想得太久了，我们没继续等。点重试通常就好了。',
  LLM_HTTP_ERROR: '连模型服务的时候卡住了。检查一下网络，然后重试。',
  LLM_NO_PROVIDER: '所有模型都没能连上。检查一下网络和 API Key，然后重试。',
  LLM_EMPTY_RESPONSE: '模型这次没写出东西来，重试一次通常就好。',
  LLM_JSON_INVALID: '模型这次答得乱七八糟，我们已经让它重做了。再试一次。',
  LLM_SCHEMA_INVALID: '模型这次没按规矩答题，我们已经让它重做了。再试一次。',
  LLM_ABORTED: '这个任务被取消了。',
  LLM_ALL_PROVIDERS_FAILED: '所有模型都没能连上。检查一下网络和 API Key，然后重试。',

  // —— 流水线与进程状态 ——
  PIPELINE_STAGE_FAILED: '有一步没做成，但前面做好的东西都留着。点重试可以接着做。',
  PIPELINE_CANCELLED: '这个任务被取消了。',
  INTERRUPTED: '这次运行被中断了（服务被关闭或者电脑休眠）。做好的部分都还在，点重试可以接着做完。',
  SECURITY_BLOCKED: '这次的内容被安全检查拦下来了。如果你觉得不该拦，可以换个说法再试。',

  // —— 网络层（前端自己产生的码）——
  NETWORK_ERROR: '连不上本机的服务，确认程序还在运行。',
  TIMEOUT: '等太久了，还没等到回应。可以重试一次。',
  BAD_JSON: '服务返回的内容看不懂，稍后再试。',
};

/** HTTP 状态码 → 人话（按类别，不逐条罗列） */
export function httpStatusCopy(status) {
  const n = Number(status);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n === 404) return ERROR_COPY.NOT_FOUND;
  if (n === 413) return ERROR_COPY.PAYLOAD_TOO_LARGE;
  if (n === 429) return ERROR_COPY.RATE_LIMITED;
  if (n >= 500) return ERROR_COPY.INTERNAL_ERROR;
  if (n >= 400) return ERROR_COPY.BAD_REQUEST;
  return '';
}

/** 把后端错误对象翻译成普通人能看懂的一句话。 */
export function friendlyError(err) {
  const code = err && err.code ? String(err.code) : '';
  if (ERROR_COPY[code]) return ERROR_COPY[code];

  // 有些码是 HTTP_404 这种由状态码拼出来的形式。
  // 注意：去掉前缀后拿到的是 "404" 这个**数字字符串**，ERROR_COPY 里没有这个键，
  // 所以要单独按状态码类别翻译 —— 否则「任务不存在」会被说成「出了点问题」，
  // 用户就不知道该干什么了。
  const bare = code.replace(/^HTTP_/, '');
  if (bare && ERROR_COPY[bare]) return ERROR_COPY[bare];
  const statusCopy = httpStatusCopy(err && err.status ? err.status : Number(bare));
  if (statusCopy) return statusCopy;

  const msg = err && err.message ? String(err.message) : '';
  // 全大写的消息多半是错误码而不是人话，别直接甩给用户
  if (msg && !/^[A-Z_]+$/.test(msg)) return msg;
  if (msg) return '出了点问题（' + msg + '），可以重试一次。';
  return '出了点问题，可以重试一次。';
}

/**
 * 把**流水线失败时记在 job.error 里的那句话**翻成人话。
 *
 * 为什么需要单独一个函数：`friendlyError` 处理的是"请求失败了"，
 * 而这里处理的是"任务跑到一半失败了"—— 两者的消息来源不同。
 * job.error.message 直接来自 `src/llm/gateway.js`，里面可能是
 * 「模型输出的结构不符合要求：$.confidence 取值必须是 high/medium/low 之一，实际是 0.95」
 * 这种东西。用户看到只会一脸问号，所以必须在展示前过一遍。
 *
 * @param {{code?:string, message?:string}|null} error job.error
 * @returns {string} 给用户看的一句话
 */
export function friendlyJobError(error) {
  if (!error) return '这次没能做完，可以点重试。';
  const code = error.code ? String(error.code) : '';
  if (ERROR_COPY[code]) return ERROR_COPY[code];
  const bare = code.replace(/^HTTP_/, '');
  if (bare && ERROR_COPY[bare]) return ERROR_COPY[bare];
  const byStatus = httpStatusCopy(error.status ? error.status : Number(bare));
  if (byStatus) return byStatus;
  // 没有认识的码：看看消息本身像不像人话。
  // 我们对自家文案有信心的一点是：**中文消息都是写好的用户文案**，
  // 而带 $ . _ { } 这些符号、或者夹着英文错误码的，都是技术消息。
  const msg = String(error.message || '');
  const looksTechnical = /[$]|\{|\}|_|Error|error|undefined|null|[A-Z]{3,}_[A-Z]/.test(msg);
  if (msg && !looksTechnical) return msg;
  return '这次没能做完。原因已经记下来了，点重试通常就好了。';
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

  /**
   * 把服务端的包装拆掉。
   *
   * ⚠️ 这是本项目代价最大的一个 bug，务必理解它为什么能藏这么久：
   * 服务端所有任务接口返回 `{ job: {...} }`（CONTRACT §2），
   * 而前端按**扁平对象**读（`job.id` / `job.status` / `job.artifacts`）。
   * 结果是一条**中间那根线**上的契约不一致：
   *   · 前端的单测只测 api.js 这一层 → 绿
   *   · 后端的 e2e 全部 `request(app)` 直打服务端，绕过了前端 → 绿
   *   · 真实浏览器里点「开始」→ `job.id` 是 undefined → 弹「任务创建了但没拿到编号」
   *     → 详情页永远显示"没有写下目标 / 未知状态 / 团队正在集结"，用户永远等下去
   *
   * 修法选择：**在这里统一拆包装**，而不是改 app.js 里的十几处调用点。
   * 一处修，四处好；而且以后服务端再加包装也只需要动这里。
   * 同样地，`{ jobs: [...] }` 和裸数组都兼容。
   */
  const unwrapJob = (body) =>
    body && typeof body === 'object' && body.job && typeof body.job === 'object'
      ? body.job
      : body;

  const unwrapJobs = (body) => {
    if (Array.isArray(body)) return body;
    if (body && Array.isArray(body.jobs)) return body.jobs;
    return [];
  };

  return {
    origin,

    /** POST /api/jobs —— 立即返回 job（后台跑流水线）。 */
    async createJob(input) {
      const payload = { goal: String((input && input.goal) || '') };
      if (input && input.templateId) payload.templateId = input.templateId;
      if (input && input.audience) payload.audience = input.audience;
      if (input && input.tone) payload.tone = input.tone;
      if (input && input.deadline) payload.deadline = input.deadline;
      if (input && input.demo) payload.demo = true;
      return unwrapJob(await request('/api/jobs', { method: 'POST', body: payload }));
    },

    /** GET /api/jobs */
    async listJobs() {
      return unwrapJobs(await request('/api/jobs', { method: 'GET' }));
    },

    /** GET /api/jobs/:id */
    async getJob(id) {
      return unwrapJob(await request('/api/jobs/' + encodeURIComponent(id), { method: 'GET' }));
    },

    /** POST /api/jobs/:id/message */
    async sendMessage(id, message) {
      // 注意：请求体字段名是 message，但服务端也接受契约里的 text（两个都通）。
      const body = await request('/api/jobs/' + encodeURIComponent(id) + '/message', {
        method: 'POST', body: { message: String(message || '') },
      });
      return unwrapJob(body);
    },

    /** POST /api/jobs/:id/retry */
    async retryJob(id) {
      const body = await request('/api/jobs/' + encodeURIComponent(id) + '/retry', {
        method: 'POST',
        body: {},
      });
      return unwrapJob(body);
    },

    /** DELETE /api/jobs/:id */
    async deleteJob(id) {
      const body = await request('/api/jobs/' + encodeURIComponent(id), { method: 'DELETE' });
      return body;
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

    /**
     * 取交付物正文（纯文本 markdown）。
     *
     * 说明：`GET /api/jobs/:id` **已经返回 content**（契约 §2 要求如此），
     * 所以正常情况下详情页不需要调这个方法 —— 调用方应当优先用 `art.content`。
     * 这里保留作为兜底路径：当拿到的 artifact 只有元信息（旧数据、或将来响应被裁剪）时，
     * 从下载端点补一次。正文在内存里缓存，复制/下载复用同一份。
     * @returns {Promise<string>}
     */
    async getArtifactText(jobId, artifactId) {
      const f = pickFetch();
      if (!f) throw Object.assign(new Error('NETWORK_ERROR'), { code: 'NETWORK_ERROR' });
      const href = url('/api/jobs/' + encodeURIComponent(jobId) + '/artifacts/' + encodeURIComponent(artifactId) + '/download');
      const res = await f(href);
      if (!res || !res.ok) {
        throw Object.assign(new Error('这个成果暂时拿不到正文'), {
          code: 'ARTIFACT_UNAVAILABLE', status: res ? res.status : 0,
        });
      }
      return typeof res.text === 'function' ? res.text() : '';
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

export default { createApi, FALLBACK_TEMPLATES, friendlyError, friendlyJobError, ERROR_COPY };
