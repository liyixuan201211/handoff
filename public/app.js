/**
 * Handoff — 前端入口（[S5] 前端工程师）
 *
 * 设计要点
 *  - 原生 ES Module，无打包器 / 无 CDN / 无框架 / 无 npm 依赖，离线可用。
 *  - hash 路由：#/  #/new  #/job/:id  #/history
 *  - 任务详情：**先 GET 全量快照渲染，再挂 SSE 增量**（顺序决定不会闪空）。
 *  - SSE 增量只做**局部 patch**，不整页重渲染 —— 否则用户展开的日志会被收起。
 *  - 日志追加走 100ms 节流（requestAnimationFrame 合并），高频日志不触发布局抖动。
 */

import {
  escapeHtml, renderMarkdown, parseRoute, routeHash, createStore,
  statusLabel, stageStatusLabel, roleMeta, roleHue, formatElapsed, formatRelative,
  summarize, severityMeta, securityMeta, reviewMeta,
  el, clear, setText, setRenderedMarkdown, statusBadge, stageCard, pipelineRibbon,
  skeleton, emptyState, failureState, connectionBanner,
} from './ui.js';
import { createApi, friendlyError, FALLBACK_TEMPLATES } from './api.js';

const api = createApi({});

const store = createStore({
  route: { name: 'home', params: {} },
  templatesStatus: 'loading',
  templates: FALLBACK_TEMPLATES,
  templatesFallback: true,
  jobsStatus: 'loading',
  jobs: [],
  jobsError: null,
  jobStatus: 'loading',
  job: null,
  jobError: null,
  conn: 'connecting',
});

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

const root = typeof document !== 'undefined' ? document.getElementById('root') : null;

/** 用 textContent 建节点，绝不拼 HTML 字符串。 */
function text(tag, cls, value) {
  const node = el(tag, cls ? { class: cls } : null);
  setText(node, value);
  return node;
}

function btn(label, cls, onClick) {
  const b = el('button', { class: 'btn ' + (cls || ''), type: 'button' }, label);
  if (typeof onClick === 'function') b.addEventListener('click', onClick);
  return b;
}

function toast(message) {
  if (typeof document === 'undefined' || !document.body) return;
  const box = el('div', { class: 'toast', role: 'status', 'aria-live': 'polite' }, [
    el('span', { class: 'dot', 'aria-hidden': 'true' }),
    text('span', 'toast-text', message),
  ]);
  document.body.appendChild(box);
  setTimeout(() => { if (box.parentNode) box.parentNode.removeChild(box); }, 2400);
}

async function copyPlainText(value) {
  const s = String(value === null || value === undefined ? '' : value);
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try { await navigator.clipboard.writeText(s); return true; } catch (err) { /* 回落到旧办法 */ }
  }
  if (typeof document === 'undefined' || !document.body) return false;
  const ta = el('textarea', { class: 'copy-sink', readonly: true, 'aria-hidden': 'true' });
  ta.value = s;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

function triggerDownload(filename, content) {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return;
  const blob = new Blob([String(content || '')], { type: 'text/markdown;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const a = el('a', { href, download: filename || 'deliverable.md', class: 'sr-only' });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(href), 4000);
}

function niceFilename(name, format) {
  const base = String(name || '交付物').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || '交付物';
  return base + (format === 'markdown' || !format ? '.md' : '.' + String(format).replace(/[^a-z0-9]/gi, ''));
}

/** 状态色调 -> 直接给设计系统的 tone-* 类。 */
function toneClass(tone) { return 'tone-' + (tone || 'wait'); }

/* ------------------------------------------------------------------ *
 * 外壳
 * ------------------------------------------------------------------ */

function navLink(href, label, current) {
  const active = current === href;
  return el('a', {
    class: 'nav-link' + (active ? ' is-active' : ''),
    href,
    'aria-current': active ? 'page' : null,
  }, label);
}

function buildShell(state) {
  const wrap = el('div', { class: 'app' });
  const route = state.route || { name: 'home' };
  const current = routeHash(route.name, route.params);

  const header = el('header', { class: 'topbar' }, [
    el('a', { class: 'brand', href: '#/' }, [
      el('span', { class: 'brand-mark', 'aria-hidden': 'true' }, '交'),
      el('span', { class: 'brand-text' }, [
        el('span', { class: 'brand-name' }, '交接 Handoff'),
        el('span', { class: 'brand-tag' }, '你只管说想要什么'),
      ]),
    ]),
    el('nav', { class: 'nav', 'aria-label': '主导航' }, [
      navLink('#/', '首页', current),
      navLink('#/history', '历史任务', current),
    ]),
    el('div', { class: 'topbar-cta' }, [
      el('a', { class: 'btn btn-primary btn-sm', href: '#/new', role: 'button' }, '新建任务'),
    ]),
  ]);

  const main = el('main', { class: 'main', id: 'main', tabindex: '-1' });
  const footer = el('footer', { class: 'footer' }, [
    text('p', 'footer-line', '你的密钥和资料都只留在这台电脑上，我们不会上传到别的地方。'),
    text('p', 'footer-line muted', '断网也能用：整个界面没有任何外部资源。'),
  ]);

  wrap.appendChild(el('a', { class: 'skip-link', href: '#main' }, '跳到主要内容'));
  wrap.appendChild(header);
  wrap.appendChild(main);
  wrap.appendChild(footer);
  return { wrap, main };
}

/* ------------------------------------------------------------------ *
 * 首页
 * ------------------------------------------------------------------ */

function templateCard(tpl, onPick) {
  const role = tpl.role || '团队成员';
  const hue = roleHue(role);
  const card = el('button', {
    class: 'tpl', type: 'button',
    'data-template-id': String(tpl.id || ''),
  }, [
    el('span', { class: 'avatar', 'aria-hidden': 'true', style: '--hue:' + hue },
      String(tpl.icon || Array.from(String(role))[0] || '员').slice(0, 1)),
    el('span', { class: 'tpl-body' }, [
      text('span', 'tpl-title', tpl.title || '未命名模板'),
      text('span', 'tpl-desc', tpl.desc || tpl.description || ''),
    ]),
  ]);
  card.addEventListener('click', () => onPick(tpl));
  return card;
}

async function submitNewJob(goal, extra, ui) {
  const clean = String(goal || '').trim();
  if (!clean) {
    ui.showError('先写一句话，说明你想要什么。');
    ui.focus();
    return;
  }
  if (Array.from(clean).length > 4000) {
    ui.showError('太长了，请控制在 4000 字以内。');
    return;
  }
  ui.setBusy(true);
  ui.showError('');
  try {
    const job = await api.createJob(Object.assign({ goal: clean }, extra || {}));
    if (job && job.id) {
      ui.clearDraft && ui.clearDraft();
      location.hash = routeHash('job', { id: job.id });
    } else {
      ui.showError('任务创建了但没拿到编号，去历史里看看。');
    }
  } catch (err) {
    ui.showError(friendlyError(err));
  } finally {
    ui.setBusy(false);
  }
}

function newTaskForm(opts) {
  const o = opts || {};
  const ta = el('textarea', {
    class: 'composer-input', id: o.id || 'goal-input', rows: '3',
    placeholder: o.placeholder || '比如：帮我把这份租房合同看一遍，我怕有坑',
    'aria-label': '用你自己的话说清楚想要什么',
    maxlength: '4000',
  });
  if (o.initial) ta.value = o.initial;

  const hint = el('p', { class: 'composer-hint', role: 'status', 'aria-live': 'polite' });
  const counter = el('span', { class: 'composer-count mono' }, '0 / 4000');
  const errBox = el('p', { class: 'composer-error', role: 'alert', hidden: true });
  const submit = btn('开始，交给团队', 'btn-primary btn-lg');
  const demo = btn('看一个演示（不花钱）', 'btn-ghost');

  const audience = el('select', { class: 'field-select', id: (o.id || 'goal') + '-audience', 'aria-label': '这份成果给谁看' });
  [['我自己看', '我自己看'], ['给客户看', '给客户看'], ['给同事/领导看', '给同事、领导看'], ['给病人或家属看', '给病人或家属看']]
    .forEach(([value, label]) => audience.appendChild(el('option', { value }, label)));

  const tone = el('select', { class: 'field-select', id: (o.id || 'goal') + '-tone', 'aria-label': '用什么语气' });
  [['normal', '正常语气'], ['simple', '越简单越好'], ['formal', '正式一点']]
    .forEach(([value, label]) => tone.appendChild(el('option', { value }, label)));

  const updateCount = () => {
    const n = Array.from(ta.value).length;
    setText(counter, n + ' / 4000');
    counter.classList.toggle('is-over', n > 4000);
  };
  ta.addEventListener('input', updateCount);
  updateCount();

  const ui = {
    setBusy(busy) {
      submit.disabled = busy;
      demo.disabled = busy;
      submit.textContent = busy ? '正在安排团队…' : '开始，交给团队';
      submit.setAttribute('aria-busy', busy ? 'true' : 'false');
    },
    showError(message) {
      if (!message) { errBox.hidden = true; setText(errBox, ''); return; }
      errBox.hidden = false;
      setText(errBox, message);
    },
    focus() { ta.focus(); },
    clearDraft() { ta.value = ''; updateCount(); },
  };

  const run = (demoMode) => submitNewJob(ta.value, {
    audience: audience.value,
    tone: tone.value,
    templateId: o.templateId || undefined,
    demo: demoMode === true,
  }, ui);

  submit.addEventListener('click', () => run(false));
  demo.addEventListener('click', () => run(true));
  ta.addEventListener('keydown', (ev) => {
    // Enter 直接提交，Shift+Enter 换行 —— 少让用户点一次
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      run(false);
    }
  });

  const form = el('section', { class: 'composer', 'aria-label': '新建任务' }, [
    el('label', { class: 'sr-only', for: o.id || 'goal-input' }, '用你自己的话说清楚想要什么'),
    ta,
    el('div', { class: 'composer-row' }, [
      el('div', { class: 'composer-fields' }, [
        el('span', { class: 'field' }, [text('span', 'field-label', '给谁看'), audience]),
        el('span', { class: 'field' }, [text('span', 'field-label', '语气'), tone]),
      ]),
      el('div', { class: 'composer-actions' }, [counter, demo, submit]),
    ]),
    hint,
    errBox,
  ]);

  if (o.caption) form.insertBefore(text('p', 'composer-caption', o.caption), ta);
  return { form, ui, textarea: ta };
}

function renderHome(main, state) {
  const page = el('div', { class: 'page page-home' });

  page.appendChild(el('section', { class: 'hero' }, [
    text('h1', 'hero-title', '你只管说想要什么，剩下的交给一支 AI 团队'),
    text('p', 'hero-sub', '说人话就行。我们派一支看得见的团队接手：接待员听懂你的意思，项目经理定方案，执行专员动手做，质检员验收，最后交付专员把成品交到你手上——每一步花了多久、做了什么，你都看得到。'),
  ]));

  const { form, ui, textarea } = newTaskForm({
    id: 'home-goal',
    placeholder: '比如：帮我把这份租房合同看一遍，我怕有坑',
  });
  textarea.value = state && state.draftGoal ? state.draftGoal : '';
  page.appendChild(form);

  page.appendChild(el('section', { class: 'ribbon-wrap', 'aria-label': '我们怎么工作' }, [
    text('h2', 'section-title', '这不是一次问答，是一支团队在干活'),
    text('p', 'section-sub', '八个步骤固定成一条流水线，你可以随时看到谁在忙、忙了多久。'),
    pipelineRibbon(),
  ]));

  const tplSection = el('section', { class: 'tpl-wrap' }, [
    text('h2', 'section-title', '不知道怎么说？挑一个常见场景'),
    text('p', 'section-sub', '点一下就会填进上面的框里，你还可以改成自己的说法。'),
  ]);

  if (state.templatesStatus === 'loading') {
    tplSection.appendChild(skeleton('templates'));
  } else {
    const grid = el('div', { class: 'tpl-grid' });
    (state.templates || []).forEach((tpl) => {
      grid.appendChild(templateCard(tpl, (picked) => {
        textarea.value = picked.goal || picked.title || '';
        textarea.dispatchEvent(new Event('input'));
        textarea.focus();
        toast('已填好，可以直接改或者点开始');
      }));
    });
    tplSection.appendChild(grid);
    if (state.templatesFallback) {
      tplSection.appendChild(el('p', { class: 'note' }, '没能从服务端拿到场景列表，先用内置的这几个。不影响使用。'));
    }
  }
  page.appendChild(tplSection);

  page.appendChild(el('section', { class: 'trust' }, [
    el('h2', { class: 'trust-title' }, '放心用的几件事'),
    el('ul', { class: 'trust-list' }, [
      el('li', {}, [el('strong', {}, '只在你自己的电脑上。'), '密钥和资料都不外传，界面里没有任何外部请求。']),
      el('li', {}, [el('strong', {}, '断网也能打开。'), '整个页面不依赖任何 CDN。']),
      el('li', {}, [el('strong', {}, '说清楚我们猜了什么。'), '每份交付物都会列出「我们替你做的假设」，不对就直接说。']),
      el('li', {}, [el('strong', {}, '不甩脸子给你看。'), '某一步失败会讲清楚卡在哪、为什么、你按一下就能重试。']),
    ]),
  ]));

  main.appendChild(page);
  setTimeout(() => textarea.focus(), 0);
}

function renderNew(main) {
  const page = el('div', { class: 'page page-new' });
  page.appendChild(el('section', { class: 'hero hero-compact' }, [
    text('h1', 'hero-title', '新开一个任务'),
    text('p', 'hero-sub', '一句话就够。说不清楚也没关系，接待员会先帮你把意思理清楚。'),
  ]));
  const { form } = newTaskForm({ id: 'new-goal' });
  page.appendChild(form);
  page.appendChild(el('p', { class: 'note' }, '不用写提示词，也不用选模型。写你平时会跟人说的话就行。'));
  main.appendChild(page);
  setTimeout(() => { const ta = document.getElementById('new-goal'); if (ta) ta.focus(); }, 0);
}

/* ------------------------------------------------------------------ *
 * 历史
 * ------------------------------------------------------------------ */

function jobCard(job) {
  const meta = statusLabel(job.status);
  const card = el('a', {
    class: 'job-card ' + toneClass(meta.tone),
    href: routeHash('job', { id: job.id }),
    'data-job-id': String(job.id || ''),
  }, [
    el('div', { class: 'job-card-head' }, [
      text('span', 'job-card-goal', summarize(job.goal, 70)),
      el('span', { class: 'badge ' + toneClass(meta.tone) }, [
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        meta.label,
      ]),
    ]),
    el('div', { class: 'job-card-foot' }, [
      el('span', { class: 'chip' }, (job.stages && job.stages.length ? job.stages.length + ' 个步骤' : '准备中')),
      job.plan && job.plan.title ? el('span', { class: 'chip' }, summarize(job.plan.title, 24)) : null,
      el('time', { class: 'muted mono', datetime: new Date(job.createdAt || Date.now()).toISOString() },
        formatRelative(job.createdAt, Date.now())),
    ]),
  ]);
  return card;
}

function renderHistory(main, state) {
  const page = el('div', { class: 'page page-history' });
  page.appendChild(el('section', { class: 'hero hero-compact' }, [
    text('h1', 'hero-title', '历史任务'),
    text('p', 'hero-sub', '你交出去的每一件事都在这里。点开看当时是怎么一步步做出来的。'),
  ]));

  const section = el('section', { class: 'history-wrap', 'aria-live': 'polite' });

  if (state.jobsStatus === 'loading') {
    section.appendChild(skeleton('history'));
  } else if (state.jobsStatus === 'error') {
    section.appendChild(failureState({
      title: '没能读到历史记录',
      where: '读取任务列表',
      why: friendlyError(state.jobsError || {}),
      next: '多半是本机服务没在跑。确认程序开着，然后点下面重试。',
      onRetry: () => { loadJobs(true); },
      onNew: () => { location.hash = '#/new'; },
    }));
  } else if (!state.jobs || !state.jobs.length) {
    section.appendChild(emptyState({
      title: '还没有任务',
      body: '这里会记下你交出去的每一件事和拿到的成果。第一件事想从哪儿开始？',
      cta: '现在就说一件想做的事',
      onCta: () => { location.hash = '#/new'; },
    }));
  } else {
    const list = el('div', { class: 'job-list' });
    state.jobs.forEach((job) => list.appendChild(jobCard(job)));
    section.appendChild(list);
  }

  page.appendChild(section);
  main.appendChild(page);
}

/* ------------------------------------------------------------------ *
 * 任务详情（产品灵魂）
 * ------------------------------------------------------------------ */

const DETAIL_TABS = [
  { key: 'artifact', label: '交付物' },
  { key: 'review', label: '验收' },
  { key: 'security', label: '安全检查' },
  { key: 'assume', label: '我们替你做的假设' },
];

class JobView {
  constructor(jobId, initialJob) {
    this.jobId = jobId;
    this.job = initialJob || null;
    this.stream = null;
    this.stageNodes = new Map();   // stageId -> { card, statusEl, elapsedEl, logList, logEmpty, rendered:number }
    this.pendingLogs = new Map();  // stageId -> [entry]
    this.rafHandle = null;
    this.flushTimer = null;
    this.ticker = null;
    this.lastLogAt = 0;
    this.artifactText = new Map();   // artifactId -> 正文（按需从下载端点取，取到就缓存）
    this.detailKey = '';
    this.clarifyKey = '';
    this.actionsKey = '';
    this.badSnapshot = false;
    this.dirtyClarify = false;
    this.destroyed = false;
    this.root = this.build();
  }

  /* ---------------- 结构 ---------------- */

  build() {
    const page = el('div', { class: 'page page-job' });
    page.appendChild(el('nav', { class: 'crumbs', 'aria-label': '面包屑' }, [
      el('a', { href: '#/' }, '首页'),
      el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'),
      el('a', { href: '#/history' }, '历史任务'),
      el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'),
      text('span', 'crumb-now', '任务详情'),
    ]));

    this.banner = connectionBanner('connecting');
    page.appendChild(this.banner);

    this.head = el('section', { class: 'job-head', 'aria-label': '任务概况' });
    page.appendChild(this.head);

    this.stagesList = el('ol', { class: 'stages', 'aria-label': '虚拟员工流水线', 'aria-live': 'polite' });
    this.stagesBox = el('section', { class: 'panel stages-panel' }, [
      text('h2', 'panel-title', '你的团队'),
      text('p', 'panel-sub', '点任意一位，看他具体做了什么。'),
      this.stagesList,
    ]);
    page.appendChild(this.stagesBox);

    this.detailBody = el('div', { class: 'detail-body' });
    this.tabs = el('div', { class: 'tabs', role: 'tablist', 'aria-label': '任务结果' });
    this.tabButtons = new Map();
    this.tabPanels = new Map();
    DETAIL_TABS.forEach((tab, index) => {
      const btnEl = el('button', {
        class: 'tab', type: 'button', role: 'tab', id: 'tab-' + tab.key,
        'aria-controls': 'panel-' + tab.key, 'aria-selected': index === 0 ? 'true' : 'false',
        tabindex: index === 0 ? '0' : '-1',
      }, tab.label);
      const panel = el('div', { class: 'panel tab-panel', role: 'tabpanel', id: 'panel-' + tab.key, 'aria-labelledby': 'tab-' + tab.key });
      if (index !== 0) panel.hidden = true;
      this.tabButtons.set(tab.key, btnEl);
      this.tabPanels.set(tab.key, panel);
      btnEl.addEventListener('click', () => this.selectTab(tab.key));
      btnEl.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
        const keys = DETAIL_TABS.map((t) => t.key);
        const at = keys.indexOf(tab.key);
        const next = ev.key === 'ArrowRight' ? (at + 1) % keys.length : (at - 1 + keys.length) % keys.length;
        this.selectTab(keys[next], true);
      });
      this.tabs.appendChild(btnEl);
    });
    this.tabs.addEventListener('keydown', (ev) => {
      if (ev.key === 'Home' || ev.key === 'End') {
        const keys = DETAIL_TABS.map((t) => t.key);
        this.selectTab(ev.key === 'Home' ? keys[0] : keys[keys.length - 1], true);
      }
    });
    this.detailBody.appendChild(this.tabs);
    DETAIL_TABS.forEach((tab) => this.detailBody.appendChild(this.tabPanels.get(tab.key)));
    this.detailBox = el('section', { class: 'detail', 'aria-label': '任务结果' }, [this.detailBody]);
    page.appendChild(this.detailBox);

    this.actionBox = el('section', { class: 'actions-panel', 'aria-live': 'polite' });
    page.appendChild(this.actionBox);

    return page;
  }

  selectTab(key, focus) {
    DETAIL_TABS.forEach((tab) => {
      const btnEl = this.tabButtons.get(tab.key);
      const active = tab.key === key;
      if (btnEl) {
        btnEl.setAttribute('aria-selected', active ? 'true' : 'false');
        btnEl.tabIndex = active ? 0 : -1;
        if (active && focus) btnEl.focus();
      }
      const panel = this.tabPanels.get(tab.key);
      if (panel) panel.hidden = !active;
    });
  }

  /* ---------------- 生命周期 ---------------- */

  mount(container) {
    clear(container);
    container.appendChild(this.root);
    this.applyJob(this.job, true);
    this.startStream();
    // 进行中的耗时每 250ms 走一次，只改 textContent，不触发重排连锁
    this.ticker = setInterval(() => this.tickElapsed(), 250);
  }

  destroy() {
    this.destroyed = true;
    if (this.stream) { this.stream.close(); this.stream = null; }
    if (this.ticker) { clearInterval(this.ticker); this.ticker = null; }
    if (this.rafHandle) { cancelAnimationFrame(this.rafHandle); this.rafHandle = null; }
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    this.stageNodes.clear();
    this.pendingLogs.clear();
  }

  setConn(state) {
    const banner = this.banner;
    clear(banner);
    const map = {
      live: { text: '已连接，进展会实时更新', tone: 'ok' },
      connecting: { text: '正在连接…', tone: 'wait' },
      reconnecting: { text: '连接中断，正在重连…', tone: 'warn' },
      offline: { text: '网络好像断了。检查一下 Wi-Fi，然后点重连。', tone: 'bad' },
    };
    const meta = map[state] || map.connecting;
    banner.setAttribute('class', 'conn ' + toneClass(meta.tone));
    banner.setAttribute('data-state', String(state));
    banner.appendChild(el('span', { class: 'dot', 'aria-hidden': 'true' }));
    banner.appendChild(text('span', 'conn-text', meta.text));
    if (state === 'offline') {
      const again = btn('重连', 'btn-sm');
      again.addEventListener('click', () => {
        this.setConn('connecting');
        if (this.stream) this.stream.reconnect();
        this.refreshSnapshot();
      });
      banner.appendChild(again);
    }
  }

  startStream() {
    this.stream = api.openStream(this.jobId, {
      onEvent: (evt) => this.onEvent(evt),
      onState: (s) => {
        store.set({ conn: s });
        this.setConn(s);
      },
    });
  }

  async refreshSnapshot() {
    try {
      const job = await api.getJob(this.jobId);
      // 防御：只接受本次任务自己的快照，别让串线的响应顶掉界面
      if (!job || (job.id && job.id !== this.jobId)) return;
      // 防御：请求返回时这个视图可能已经被销毁 / 已经被别的视图替换，
      // 那就只更新 store 供新视图使用，绝不再碰 DOM。
      store.set({ job, jobStatus: 'ready', jobError: null });
      if (!this.isOwner()) return;
      this.applyJob(job, false);
    } catch (err) {
      // ⚠️ 以前这里是空的 catch —— 后果是两个都很糟：
      //  1. 任务不存在（服务端明确返回 404 NOT_FOUND），界面却什么都不说，
      //     骨架屏 +「正在读取任务…」永远停在那里，用户一直等。
      //  2. 首次加载失败时，外层的错误处理把**任何**非 2xx 都当成网络故障，
      //     于是提示「网络好像断了。检查一下 Wi-Fi」—— 把一个"任务被删了"
      //     的问题，变成了用户跑去重启路由器。
      // 现在：区分"这个任务不存在"和"连不上服务"两种情况，分别说人话。
      const code = err && err.code ? String(err.code) : '';
      const status = err && err.status ? Number(err.status) : 0;
      const notFound = status === 404 || code === 'NOT_FOUND' || code === 'HTTP_404';
      store.set({
        jobStatus: 'error',
        jobError: notFound ? '这个任务不在了' : '暂时读不到这个任务',
      });
      if (!this.isOwner()) return;
      this.renderLoadFailure(notFound, err);
    }
  }

  /**
   * 快照读不到时，给一个**能行动**的界面，而不是永远转圈的骨架屏。
   * @param {boolean} notFound 是"任务不存在"还是"连不上服务"
   */
  renderLoadFailure(notFound, err) {
    clear(this.head);
    clear(this.stagesList);
    const title = notFound ? '找不到这个任务' : '暂时读不到这个任务';
    const body = notFound
      ? '它可能已经被删除了。你之前做好的东西如果还在，会出现在历史里。'
      : '可能是服务没在运行，或者网络断了。确认一下服务还在，然后重试。';
    this.head.appendChild(
      emptyState({
        title,
        body,
        cta: notFound ? '回历史看看' : '重试',
        onCta: () => {
          if (notFound) location.hash = '#/history';
          else this.refreshSnapshot();
        },
      }),
    );
    this.failedToLoad = true;
    void err;
  }

  /** 这个视图是否还是"当前在台上的那个"（DOM 更新只允许它来做）。 */
  isOwner() {
    return !this.destroyed && currentView === this;
  }

  /* ---------------- SSE 事件 ---------------- */

  onEvent(evt) {
    if (!evt || typeof evt.type !== 'string') return;
    if (!this.isOwner()) return;   // 已经被换掉的视图不再驱动界面
    const job = this.job;

    if (evt.type === 'log') {
      this.enqueueLog(evt);
      return;
    }

    if (evt.type === 'stage' && job && Array.isArray(job.stages)) {
      const stage = job.stages.find((s) => s.id === evt.stageId);
      if (stage) {
        if (evt.status) stage.status = evt.status;
        if (evt.title) stage.title = evt.title;
        if (evt.role) stage.role = evt.role;
        const now = Date.now();
        if (evt.status === 'running' && !stage.startedAt) stage.startedAt = now;
        if ((evt.status === 'done' || evt.status === 'failed') && !stage.endedAt) {
          stage.endedAt = now;
          if (!stage.ms && stage.startedAt) stage.ms = now - stage.startedAt;
        }
      }
      this.patchStage(evt.stageId);
      this.patchHead();
      return;
    }

    if (evt.type === 'job') {
      // 契约：连接时先补发全量快照（含完整 stages：status/role/ms/log/reason，
      // 但 **不含 stage.output 正文、artifacts 也不含 content**），再增量推送。
      // 合并要小心，别把本地已经收到的更细的日志冲掉。
      const incoming = evt.job || {};
      if (!Array.isArray(incoming.stages)) return;
      // 防御：SSE 的 job 必须就是本页订阅的这一个任务。
      // 否则重连/串线时会把别人的任务画到当前页面（曾经真的发生过）。
      if (incoming.id && incoming.id !== this.jobId) {
        this.badSnapshot = true;
        this.refreshSnapshot();   // 用权威快照纠正
        return;
      }
      this.badSnapshot = false;
      this.mergeJob(incoming);
      return;
    }

    if (evt.type === 'artifact') {
      // artifact 事件只带元信息（id/name/deliverableId），正文要回服务器取一次全量
      this.refreshSnapshot();
      return;
    }

    if (evt.type === 'review' && job) { job.review = evt.review || null; this.patchDetail(true); return; }
    if (evt.type === 'security' && job) { job.security = evt.security || null; this.patchDetail(true); return; }
    if (evt.type === 'clarify' && job) {
      job.clarifyQuestions = Array.isArray(evt.questions) ? evt.questions : [];
      job.status = 'awaiting_input';
      this.patchHead();
      this.patchActions();
      return;
    }
    if (evt.type === 'done') {
      if (job) job.status = evt.status || 'done';
      this.patchHead();
      this.refreshSnapshot();
      return;
    }
    if (evt.type === 'error') {
      if (job) { job.status = 'failed'; job.error = { message: evt.message, stageId: evt.stageId || null }; }
      this.patchHead();
      this.patchActions();
      const card = evt.stageId ? this.stageNodes.get(evt.stageId) : null;
      if (card) this.patchStage(evt.stageId);
      return;
    }
  }

  /** 用 SSE 快照合并本地状态：以服务器为准，但保留已经收下的日志。 */
  mergeJob(incoming) {
    const local = this.job;
    if (!local) { this.job = incoming; this.patchAll(true); return; }
    const localStageById = new Map();
    (local.stages || []).forEach((s) => localStageById.set(s.id, s));
    (incoming.stages || []).forEach((inc) => {
      const mine = localStageById.get(inc.id);
      if (!mine) return;
      // 日志：本地已有的一律保留（SSE log 事件可能比快照更细）
      if (Array.isArray(inc.log) && inc.log.length > (mine.log ? mine.log.length : 0)) {
        const seen = new Set((mine.log || []).map((l) => l.at + '|' + l.text));
        const merged = (mine.log || []).slice();
        inc.log.forEach((l) => { if (!seen.has(l.at + '|' + l.text)) merged.push(l); });
        inc.log = merged;
      } else {
        inc.log = mine.log || [];
      }
    });

    // 交付物正文必须以"已有的那份"为准：
    // 契约规定 SSE 的 job 快照里 artifacts[] **只有元信息（id/name/bytes），不含 content**，
    // 而 GET /api/jobs/:id 才有正文。如果这里直接覆盖，就会把已经取到的正文冲掉
    // （表现为：刷新后交付物变成"点一下展开看正文"）。
    if (Array.isArray(incoming.artifacts) && incoming.artifacts.length) {
      const localArtById = new Map();
      (local.artifacts || []).forEach((a) => localArtById.set(a.id, a));
      incoming.artifacts = incoming.artifacts.map((inc) => {
        const mine = localArtById.get(inc.id);
        if (!mine) return inc;
        const hasInc = typeof inc.content === 'string' && inc.content.length;
        const hasMine = typeof mine.content === 'string' && mine.content.length;
        if (hasInc || !hasMine) return inc;
        return Object.assign({}, inc, { content: mine.content });
      });
    }

    // 就地合并（保留 local 引用，日志数组不会被换掉）
    Object.assign(local, incoming);
    this.job = local;
    // 重建阶段卡片，但把用户已经展开的日志重新展开（绝不打断正在看日志的人）
    const openIds = new Set();
    this.stageNodes.forEach((node, id) => { if (node.open) openIds.add(id); });
    this.patchAll(true);
    openIds.forEach((id) => {
      const node = this.stageNodes.get(id);
      if (!node) return;
      node.open = true;
      if (node.logBox) node.logBox.hidden = false;
      if (node.head) node.head.setAttribute('aria-expanded', 'true');
      node.card.classList.add('is-open');
      this.flushStageLogs(id);
    });
  }

  /* ---------------- 渲染：概况 ---------------- */

  patchHead() {
    const job = this.job;
    if (!job) { clear(this.head); this.headKey = ''; return; }
    const headKey = [job.id, job.status, job.goal, job.updatedAt,
      (job.plan && job.plan.intent) || '',
      (job.plan && job.plan.title) || '',
      (job.stages || []).length,
      ((job.stages || []).filter((s) => s.status === 'running').length),
    ].join('|');
    if (headKey === this.headKey) return;
    this.headKey = headKey;
    clear(this.head);

    const meta = statusLabel(job.status);
    this.head.appendChild(el('div', { class: 'job-head-top' }, [
      text('h1', 'job-goal', job.goal || '（没有写下目标）'),
      el('div', { class: 'job-head-meta' }, [
        el('span', { class: 'badge badge-lg ' + toneClass(meta.tone), 'data-role': 'job-status' }, [
          el('span', { class: 'dot', 'aria-hidden': 'true' }),
          meta.label,
        ]),
        job.plan && job.plan.title ? text('span', 'job-plan-title', job.plan.title) : null,
      ]),
    ]));

    const facts = el('div', { class: 'job-facts' });
    const totalMs = (job.stages || []).reduce((sum, s) => sum + (typeof s.ms === 'number' ? s.ms : 0), 0);
    if (totalMs) facts.appendChild(el('span', { class: 'chip' }, '已经花了 ' + formatElapsed(totalMs)));
    if (job.usage && job.usage.calls) facts.appendChild(el('span', { class: 'chip' }, '问了模型 ' + job.usage.calls + ' 次'));
    if (job.plan && Array.isArray(job.plan.deliverables) && job.plan.deliverables.length) {
      facts.appendChild(el('span', { class: 'chip' }, '要做 ' + job.plan.deliverables.length + ' 份成果'));
    }
    if (job.updatedAt) {
      facts.appendChild(el('time', { class: 'chip muted', datetime: new Date(job.updatedAt).toISOString() },
        '更新于 ' + formatRelative(job.updatedAt, Date.now())));
    }
    if (facts.childNodes.length) this.head.appendChild(facts);

    if (job.plan && job.plan.intent) {
      this.head.appendChild(el('p', { class: 'job-intent' }, [
        el('strong', {}, '我们理解你要的是：'),
        document.createTextNode(String(job.plan.intent)),
      ]));
    }
  }

  /* ---------------- 渲染：流水线 ---------------- */

  buildStages() {
    const job = this.job;
    this.stagesList.replaceChildren();
    this.stageNodes.clear();
    if (!job || !Array.isArray(job.stages) || !job.stages.length) {
      this.stagesList.appendChild(el('li', { class: 'stage-waiting' }, '团队正在集结，马上就会出现在这里。'));
      return;
    }
    job.stages.forEach((stage) => {
      const card = stageCard(stage);
      const node = {
        card,
        open: false,
        rendered: 0,
        statusEl: card.querySelector('[data-role="status"]'),
        elapsedEl: card.querySelector('[data-role="elapsed"]'),
        logList: card.querySelector('[data-role="log-list"]'),
        logBox: card.querySelector('.stage-log'),
        logEmpty: card.querySelector('[data-role="log-empty"]'),
        head: card.querySelector('.stage-head'),
      };
      node.head.addEventListener('click', () => {
        node.open = !node.open;
        node.logBox.hidden = !node.open;
        node.head.setAttribute('aria-expanded', node.open ? 'true' : 'false');
        node.card.classList.toggle('is-open', node.open);
        if (node.open) this.flushLogs(true);
      });
      const stageId = stage.id;
      this.stageNodes.set(stageId, node);
      this.stagesList.appendChild(card);
      // 初始日志一把填进去
      this.pendingLogs.set(stageId, Array.isArray(stage.log) ? stage.log.slice() : []);
      this.flushStageLogs(stageId);
      this.patchStageElapsed(stageId);
    });
  }

  patchStage(stageId) {
    const node = this.stageNodes.get(stageId);
    const job = this.job;
    if (!node || !job) return;
    const stage = (job.stages || []).find((s) => s.id === stageId);
    if (!stage) return;
    const st = stageStatusLabel(stage.status);
    node.card.setAttribute('data-status', String(stage.status || 'pending'));
    node.card.setAttribute('class', 'stage ' + toneClass(st.tone) + (node.open ? ' is-open' : ''));
    if (node.statusEl) {
      node.statusEl.setAttribute('class', 'badge ' + toneClass(st.tone));
      clear(node.statusEl);
      node.statusEl.appendChild(el('span', { class: 'dot', 'aria-hidden': 'true' }));
      node.statusEl.appendChild(document.createTextNode(st.label));
    }
    this.patchStageElapsed(stageId);
  }

  patchStageElapsed(stageId) {
    const node = this.stageNodes.get(stageId);
    const job = this.job;
    if (!node || !job || !node.elapsedEl) return;
    const stage = (job.stages || []).find((s) => s.id === stageId);
    if (!stage) return;
    let value = '';
    if (stage.status === 'running') {
      value = formatElapsed(null, stage.startedAt || Date.now(), Date.now()) + ' …';
    } else if (typeof stage.ms === 'number') {
      value = formatElapsed(stage.ms);
    } else if (stage.status === 'pending' || stage.status === 'skipped') {
      value = stage.status === 'skipped' ? '已跳过' : '还没开始';
    }
    if (node.elapsedEl.textContent !== value) setText(node.elapsedEl, value);
  }

  tickElapsed() {
    const job = this.job;
    if (!job || this.destroyed) return;
    const running = (job.stages || []).filter((s) => s.status === 'running');
    running.forEach((s) => this.patchStageElapsed(s.id));
    // 空闲时降低刷新频率：每 10 秒才碰一次已完成的时长
    this.tickCount = (this.tickCount || 0) + 1;
    if (this.tickCount % 40 === 0) {
      (job.stages || []).forEach((s) => { if (s.status !== 'running') this.patchStageElapsed(s.id); });
    }
  }

  /* ---------------- 渲染：日志（节流批量追加） ---------------- */

  enqueueLog(evt) {
    const stageId = evt.stageId || (this.job && this.job.stages && this.job.stages[0] && this.job.stages[0].id);
    if (!stageId) return;
    const stage = this.job && this.job.stages ? this.job.stages.find((s) => s.id === stageId) : null;
    const entry = { at: evt.at || Date.now(), level: evt.level || 'info', text: evt.text || '' };
    // 回写本地状态，保证"离开再回来"日志还在
    if (stage) {
      if (!Array.isArray(stage.log)) stage.log = [];
      stage.log.push(entry);
    }
    if (!this.pendingLogs.has(stageId)) this.pendingLogs.set(stageId, []);
    this.pendingLogs.get(stageId).push(entry);
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.destroyed) return;
    const now = Date.now();
    const since = now - this.lastLogAt;
    if (since >= 100) {
      this.lastLogAt = now;
      this.flushLogs();
      return;
    }
    if (this.flushTimer || this.rafHandle) return;
    const wait = 100 - since;
    if (typeof requestAnimationFrame === 'function') {
      this.rafHandle = requestAnimationFrame(() => { this.rafHandle = null; this.flushLogs(); });
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushLogs();
    }, wait);
  }

  flushLogs() {
    if (this.destroyed) return;
    this.lastLogAt = Date.now();
    this.pendingLogs.forEach((_entries, stageId) => this.flushStageLogs(stageId));
  }

  flushStageLogs(stageId) {
    const node = this.stageNodes.get(stageId);
    const queue = this.pendingLogs.get(stageId);
    if (!node || !node.logList || !queue || !queue.length) return;
    // 日志区收起时不写入 DOM，等展开时一次补齐（避免无意义的布局）
    if (!node.open && queue.length < 40) return;
    const frag = document.createDocumentFragment();
    queue.forEach((entry) => {
      const tone = entry.level === 'error' ? 'bad' : entry.level === 'warn' ? 'warn' : 'info';
      frag.appendChild(el('li', { class: 'log-line ' + toneClass(tone) }, [
        el('time', { class: 'log-time mono', datetime: new Date(entry.at).toISOString() },
          new Date(entry.at).toLocaleTimeString('zh-CN', { hour12: false })),
        text('span', 'log-text', entry.text),
      ]));
    });
    node.logList.appendChild(frag);
    this.pendingLogs.set(stageId, []);
    if (node.logEmpty) node.logEmpty.hidden = true;
  }

  /* ---------------- 渲染：交付物 / 验收 / 安全 / 假设 ---------------- */

  patchDetail(force) {
    const job = this.job;
    if (!job) return;
    const key = JSON.stringify([
      (job.artifacts || []).map((a) => [a.id, (a.content || '').length, this.artifactText.has(a.id) ? 1 : 0, a.bytes || 0]),
      job.review ? [job.review.verdict, (job.review.issues || []).length] : null,
      job.security ? [job.security.level, (job.security.findings || []).length] : null,
      job.plan ? (job.plan.assumptions || []).length : 0,
    ]);
    if (!force && key === this.detailKey) return;
    this.detailKey = key;

    this.renderArtifacts(job);
    this.renderReview(job);
    this.renderSecurity(job);
    this.renderAssumptions(job);

    const counts = {
      artifact: (job.artifacts || []).length,
      review: job.review ? 1 : 0,
      security: job.security ? 1 : 0,
      assume: job.plan && job.plan.assumptions ? job.plan.assumptions.length : 0,
    };
    DETAIL_TABS.forEach((tab) => {
      const btnEl = this.tabButtons.get(tab.key);
      if (!btnEl) return;
      const badge = counts[tab.key];
      setText(btnEl, '');
      btnEl.appendChild(document.createTextNode(tab.label));
      if (badge) btnEl.appendChild(el('span', { class: 'tab-count mono' }, String(badge)));
    });
  }

  /**
   * 确保拿到交付物正文。
   * 详情响应里通常没有 content（只有 bytes），正文在下载端点里，按需取一次并缓存。
   * @returns {Promise<string|null>} 拿不到时返回 null，由调用方给出人话提示
   */
  async ensureArtifactText(art) {
    if (!art || !art.id) return null;
    if (this.artifactText.has(art.id)) return this.artifactText.get(art.id);
    if (typeof art.content === 'string' && art.content.length) {
      this.artifactText.set(art.id, art.content);
      return art.content;
    }
    try {
      const text = await api.getArtifactText(this.jobId, art.id);
      if (typeof text !== 'string' || !text.length) return null;
      this.artifactText.set(art.id, text);
      return text;
    } catch (err) {
      return null;
    }
  }

  renderArtifacts(job) {
    const panel = this.tabPanels.get('artifact');
    clear(panel);
    const list = job.artifacts || [];
    if (!list.length) {
      panel.appendChild(el('div', { class: 'soft-empty' }, [
        el('p', {}, job.status === 'done' ? '这次没有生成交付物，看看验收那一栏的说明。' : '成果正在写，写完会出现在这里。'),
      ]));
      return;
    }
    list.forEach((art) => {
      // 正常情况：正文随详情/事件一起来（契约 §2），**直接渲染，不要让用户多点一次**。
      // 兜底情况：正文只在下载端点里（详情不带 content），此时才显示"展开看正文"按钮。
      const cached = this.artifactText.get(art.id);
      const body0 = cached !== undefined ? cached : (typeof art.content === 'string' && art.content.length ? art.content : null);
      const knownBytes = typeof art.bytes === 'number' ? art.bytes : (body0 ? body0.length : 0);
      const hasBody = typeof body0 === 'string';

      const box = el('article', { class: 'artifact', 'data-artifact-id': String(art.id || '') });
      const head = el('header', { class: 'artifact-head' }, [
        text('h3', 'artifact-name', art.name || '未命名成果'),
        el('span', { class: 'artifact-actions' }),
      ]);
      const actions = head.querySelector('.artifact-actions');
      const copyBtn = btn('复制', 'btn-sm');
      copyBtn.addEventListener('click', async () => {
        const text = await this.ensureArtifactText(art);
        if (text === null) { toast('正文没能取到，用「下载 .md」试试'); return; }
        const ok = await copyPlainText(text);
        toast(ok ? '已经复制好了，直接粘贴就能用' : '这个浏览器不让自动复制，请手动选中文字');
      });
      const dlBtn = btn('下载 .md', 'btn-sm');
      dlBtn.addEventListener('click', async () => {
        const text = await this.ensureArtifactText(art);
        if (text === null) {
          // 取不到正文就直接让浏览器走服务端下载端点
          if (typeof window !== 'undefined') window.open(api.artifactDownloadUrl(this.jobId, art.id), '_blank', 'noopener');
          return;
        }
        triggerDownload(niceFilename(art.name, art.format), text);
        toast('开始下载');
      });
      const openBtn = btn('在服务端下载', 'btn-sm btn-ghost');
      openBtn.addEventListener('click', () => {
        if (typeof window !== 'undefined') window.open(api.artifactDownloadUrl(this.jobId, art.id), '_blank', 'noopener');
      });
      actions.appendChild(copyBtn);
      actions.appendChild(dlBtn);
      actions.appendChild(openBtn);
      if (art.confidence) {
        const conf = { high: '我们比较有把握', medium: '把握一般', low: '不太有把握，建议你核一下' }[art.confidence] || '';
        if (conf) actions.appendChild(el('span', { class: 'chip muted' }, conf));
      }
      box.appendChild(head);

      const meta = el('div', { class: 'artifact-meta' });
      if (art.createdAt) meta.appendChild(el('time', { class: 'chip muted mono', datetime: new Date(art.createdAt).toISOString() },
        new Date(art.createdAt).toLocaleString('zh-CN', { hour12: false })));
      if (knownBytes) meta.appendChild(el('span', { class: 'chip mono' }, knownBytes + ' 字'));
      if (Array.isArray(art.assumptions) && art.assumptions.length) {
        meta.appendChild(el('span', { class: 'chip warn' }, '含 ' + art.assumptions.length + ' 条假设，见「我们替你做的假设」'));
      }
      if (meta.childNodes.length) box.appendChild(meta);

      // markdown 渲染：只走 renderMarkdown()，其内部逐段 escapeHtml
      const body = el('div', { class: 'md' });
      box.appendChild(body);

      if (hasBody) {
        setRenderedMarkdown(body, body0);
      } else {
        // 正文还没到手：给一个明确的按钮，自动去取，不让用户看到空白
        const holder = el('div', { class: 'artifact-pending' }, [
          el('p', {}, '成果已经写好了（' + (knownBytes || 0) + ' 字），点一下展开看正文。'),
        ]);
        const loadBtn = btn(knownBytes ? '展开看正文' : '拉取正文', 'btn-sm btn-primary');
        loadBtn.addEventListener('click', async () => {
          setText(loadBtn, '正在取…');
          loadBtn.disabled = true;
          const text = await this.ensureArtifactText(art);
          if (text === null) {
            setText(loadBtn, '没取到，重试');
            loadBtn.disabled = false;
            toast('正文没能取到，可以点「在服务端下载」');
            return;
          }
          clear(body);
          setRenderedMarkdown(body, text);
          holder.hidden = true;
          this.renderArtifacts(job);   // 重建一次，让复制/下载拿到正文
        });
        holder.appendChild(loadBtn);
        box.appendChild(holder);
        box.appendChild(body);
      }

      const raw = el('details', { class: 'raw' }, [
        el('summary', {}, '查看原始文字（不确定格式时用这个）'),
      ]);
      const pre = el('pre', { class: 'raw-pre' });
      setText(pre, art.content || '');
      raw.appendChild(pre);
      box.appendChild(raw);
      panel.appendChild(box);
    });
  }

  renderReview(job) {
    const panel = this.tabPanels.get('review');
    clear(panel);
    const review = job.review;
    if (!review) {
      panel.appendChild(el('div', { class: 'soft-empty' }, [el('p', {}, '质检员还没开始验收。')]));
      return;
    }
    const meta = reviewMeta(review.verdict);
    panel.appendChild(el('div', { class: 'verdict ' + toneClass(meta.tone) }, [
      el('span', { class: 'verdict-label' }, '质检员的结论'),
      el('strong', { class: 'verdict-value' }, meta.label),
    ]));

    if (Array.isArray(review.checklist) && review.checklist.length) {
      const ul = el('ul', { class: 'checklist' });
      review.checklist.forEach((c) => {
        ul.appendChild(el('li', { class: c.ok ? 'ok' : 'bad' }, [
          el('span', { class: 'mark', 'aria-hidden': 'true' }, c.ok ? '✓' : '✕'),
          text('span', 'check-item', c.item || ''),
          el('span', { class: 'sr-only' }, c.ok ? '（通过）' : '（没通过）'),
          c.note ? text('span', 'check-note', c.note) : null,
        ]));
      });
      panel.appendChild(ul);
    }

    const issues = review.issues || [];
    if (!issues.length) {
      panel.appendChild(el('p', { class: 'note' }, '没有挑出问题。'));
      return;
    }
    panel.appendChild(text('h3', 'panel-sub-title', '挑出来的 ' + issues.length + ' 个问题'));
    const list = el('ul', { class: 'issues' });
    issues.forEach((issue) => {
      const sev = severityMeta(issue.severity);
      list.appendChild(el('li', { class: 'issue ' + toneClass(sev.tone) }, [
        el('div', { class: 'issue-head' }, [
          el('span', { class: 'badge ' + toneClass(sev.tone) }, sev.label),
          text('span', 'issue-problem', issue.problem || ''),
        ]),
        issue.fix ? el('p', { class: 'issue-fix' }, [el('strong', {}, '怎么改：'), document.createTextNode(String(issue.fix))]) : null,
      ]));
    });
    panel.appendChild(list);
  }

  renderSecurity(job) {
    const panel = this.tabPanels.get('security');
    clear(panel);
    const sec = job.security;
    if (!sec) {
      panel.appendChild(el('div', { class: 'soft-empty' }, [el('p', {}, '这次任务还没有做安全检查。')]));
      return;
    }
    const meta = securityMeta(sec.level);
    panel.appendChild(el('div', { class: 'verdict ' + toneClass(meta.tone) }, [
      el('span', { class: 'verdict-label' }, '安全检查'),
      el('strong', { class: 'verdict-value' }, meta.label),
    ]));
    panel.appendChild(text('p', 'note', meta.hint));

    const findings = sec.findings || [];
    if (!findings.length) return;
    const KIND_TEXT = {
      prompt_injection: '有人可能想借你的话指挥模型（通常只是你转述了别人的文字，不用紧张）',
      pii: '内容里出现了手机号、身份证号这类个人信息',
      unsafe_request: '这件事我们不能照做',
      secret_leak: '疑似密钥出现在内容里，已经打码处理',
    };
    const list = el('ul', { class: 'findings' });
    findings.forEach((f) => {
      list.appendChild(el('li', { class: 'finding' }, [
        text('p', 'finding-kind', KIND_TEXT[f.kind] || '需要留意的地方'),
        f.detail ? el('p', { class: 'finding-detail' }, [el('strong', {}, '具体是：'), document.createTextNode(String(f.detail))]) : null,
        f.action ? text('p', 'finding-action', '我们做了：' + f.action) : null,
      ]));
    });
    panel.appendChild(list);
  }

  renderAssumptions(job) {
    const panel = this.tabPanels.get('assume');
    clear(panel);
    const plan = job.plan;
    const assumptions = plan && Array.isArray(plan.assumptions) ? plan.assumptions : [];
    panel.appendChild(text('p', 'assume-lead',
      '你没说、但我们必须先定下来的事，都在这儿。如果哪条猜错了，直接告诉我们，我们重做。'));

    if (!assumptions.length) {
      panel.appendChild(el('div', { class: 'soft-empty' }, [el('p', {}, '这次不需要额外假设，你的描述已经够清楚了。')]));
    } else {
      const ul = el('ul', { class: 'assume-list' });
      assumptions.forEach((a) => ul.appendChild(el('li', {}, [el('span', { class: 'assume-mark', 'aria-hidden': 'true' }, '？'), document.createTextNode(String(a))])));
      panel.appendChild(ul);
    }

    if (plan && Array.isArray(plan.risks) && plan.risks.length) {
      panel.appendChild(text('h3', 'panel-sub-title', '可能出问题的地方'));
      const ul = el('ul', { class: 'risk-list' });
      plan.risks.forEach((r) => ul.appendChild(el('li', {}, String(r))));
      panel.appendChild(ul);
    }
  }

  /* ---------------- 渲染：等待回答 / 失败 ---------------- */

  patchActions() {
    const job = this.job;
    if (!job) { clear(this.actionBox); this.actionsKey = ''; return; }

    // 幂等：同样的状态不重建 DOM（避免重复调用把面板清空、也避免打断用户输入）
    const key = [
      job.status,
      Array.isArray(job.clarifyQuestions) ? job.clarifyQuestions.join('\u0001') : '',
      String(job.updatedAt || ''),
      (job.error && job.error.message) || '',
    ].join('|');
    if (key === this.actionsKey) return;
    this.actionsKey = key;
    clear(this.actionBox);

    if (job.status === 'awaiting_input') {
      const questions = Array.isArray(job.clarifyQuestions) ? job.clarifyQuestions : [];
      const key = JSON.stringify(questions) + '|' + String(job.updatedAt || '');
      const box = el('section', { class: 'ask', role: 'region', 'aria-label': '需要你回答' });
      box.appendChild(text('h2', 'ask-title', '有两个问题想跟你确认一下'));
      box.appendChild(text('p', 'ask-sub', '不想写长句子也没关系，一句半句就够。'));
      if (questions.length) {
        const ul = el('ul', { class: 'ask-list' });
        questions.forEach((q) => ul.appendChild(el('li', {}, String(q))));
        box.appendChild(ul);
      }
      const ta = el('textarea', {
        class: 'ask-input', id: 'clarify-input', rows: '3',
        placeholder: '在这写你的回答，或者补充要求…',
        'aria-label': '回答澄清问题',
      });
      const errBox = el('p', { class: 'composer-error', role: 'alert', hidden: true });
      const submit = btn('发给他们', 'btn-primary');
      const status = el('p', { class: 'ask-status', role: 'status', 'aria-live': 'polite' });
      const send = async () => {
        const value = ta.value.trim();
        if (!value) { errBox.hidden = false; setText(errBox, '先写一句回答再发。'); ta.focus(); return; }
        submit.disabled = true;
        setText(submit, '正在发…');
        errBox.hidden = true;
        try {
          await api.sendMessage(job.id, value);
          ta.value = '';
          setText(status, '收到了，团队继续干活。这些字会出现在下面的日志里。');
        } catch (err) {
          errBox.hidden = false;
          setText(errBox, friendlyError(err));
        } finally {
          submit.disabled = false;
          setText(submit, '发给他们');
        }
      };
      submit.addEventListener('click', send);
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); send(); }
      });
      box.appendChild(ta);
      box.appendChild(el('div', { class: 'ask-actions' }, [submit, text('span', 'muted small', 'Ctrl/⌘ + Enter 也能发送')]));
      box.appendChild(status);
      box.appendChild(errBox);
      this.actionBox.appendChild(box);
      if (this.clarifyKey !== key) {
        this.clarifyKey = key;
        if (!this.dirtyClarify) setTimeout(() => ta.focus(), 0);
      }
      ta.addEventListener('input', () => { this.dirtyClarify = true; });
      return;
    }

    if (job.status === 'failed') {
      const failedStage = (job.stages || []).find((s) => s.status === 'failed');
      const stageTitle = failedStage
        ? (failedStage.title || '') + '（' + (roleMeta(failedStage).role) + '）'
        : '准备阶段';
      this.actionBox.appendChild(failureState({
        title: '这一步没做成，但之前做的都留着',
        where: stageTitle,
        why: (job.error && job.error.message) ? String(job.error.message) : '模型那边没能给出结果。',
        next: '不用重头再来。点下面的按钮，团队会从卡住的那一步接着做，前面已经完成的部分不会丢。',
        onRetry: () => this.retry(),
        onNew: () => { location.hash = '#/new'; },
      }));
      return;
    }

    if (job.status === 'done') {
      this.actionBox.appendChild(el('p', { class: 'done-note' }, '任务完成了。上面的交付物可以直接复制或下载拿走。'));
    }
  }

  async retry() {
    const job = this.job;
    if (!job) return;
    this.actionsKey = 'retrying';
    clear(this.actionBox);
    this.actionBox.appendChild(el('p', { class: 'note', role: 'status', 'aria-live': 'polite' }, '正在让团队接着做，稍等…'));
    try {
      await api.retryJob(job.id);
      await this.refreshSnapshot();
      this.actionsKey = '';        // 让 patchActions 按新状态重建
      this.patchActions();
    } catch (err) {
      this.actionsKey = 'retry-failed';
      clear(this.actionBox);
      this.actionBox.appendChild(failureState({
        title: '重试没成功',
        where: '重新开始这一步',
        why: friendlyError(err),
        next: '等几十秒再点一次通常就好了。如果一直不行，把任务目标改得再具体一点重开一个。',
        onRetry: () => this.retry(),
        onNew: () => { location.hash = '#/new'; },
      }));
    }
  }

  /* ---------------- 总入口 ---------------- */

  patchAll(rebuildStages) {
    this.patchHead();
    if (rebuildStages || !this.stageNodes.size) this.buildStages();
    else (this.job.stages || []).forEach((s) => this.patchStage(s.id));
    this.patchDetail(true);
    this.patchActions();
  }

  applyJob(job, first) {
    if (!job) {
      // 已经确定读不到了就别再显示骨架屏（否则用户看到"正在读取"永远转下去）
      if (!this.job && !this.failedToLoad) { this.renderNoJobYet(); }
      return;
    }
    this.failedToLoad = false;
    // 已经渲染过、又收到一份同样的快照（SSE 重连补发）：
    // 契约保证它带完整 stages（status/role/ms/log/reason，但不含 stage.output），
    // 所以直接合并即可重新对齐，不必再等一次 GET。
    if (this.job && this.job.id === job.id) { this.mergeJob(job); return; }
    this.job = job;
    this.patchAll(first === true);
  }

  /** 还没拿到任务：给骨架屏，别给白屏。 */
  renderNoJobYet() {
    clear(this.head);
    this.head.appendChild(skeleton('job'));
    clear(this.stagesList);
    this.stagesList.appendChild(el('li', { class: 'stage-waiting' }, '正在读取任务…'));
  }
}

/* ------------------------------------------------------------------ *
 * 数据加载
 * ------------------------------------------------------------------ */

async function loadTemplates() {
  store.set({ templatesStatus: 'loading' });
  const res = await api.getTemplates();
  store.set({
    templatesStatus: 'ready',
    templates: res.templates && res.templates.length ? res.templates : FALLBACK_TEMPLATES,
    templatesFallback: res.fallback === true,
  });
}

async function loadJobs(force) {
  if (!force && store.get('jobsStatus') === 'ready') return;
  store.set({ jobsStatus: 'loading', jobsError: null });
  render();
  try {
    const body = await api.listJobs();
    const list = Array.isArray(body) ? body : (body && Array.isArray(body.jobs) ? body.jobs : []);
    store.set({ jobsStatus: 'ready', jobs: list, jobsError: null });
  } catch (err) {
    store.set({ jobsStatus: 'error', jobs: [], jobsError: err });
  }
}

/* ------------------------------------------------------------------ *
 * 路由分发
 * ------------------------------------------------------------------ */

let currentView = null;

function render() {
  if (!root) return;
  const state = store.getState();
  const route = state.route;
  const { wrap, main } = buildShell(state);

  if (route.name === 'home') {
    renderHome(main, state);
  } else if (route.name === 'new') {
    renderNew(main);
  } else if (route.name === 'history') {
    renderHistory(main, state);
  } else if (route.name === 'job') {
    const view = new JobView(route.params.id, state.job && state.job.id === route.params.id ? state.job : null);
    currentView = view;
    main.appendChild(el('div', { class: 'job-slot' }));
    view.mount(main.querySelector('.job-slot'));
    if (!view.job) view.refreshSnapshot();
  } else {
    main.appendChild(emptyState({
      title: '这个页面不存在',
      body: '地址可能拼错了。回首页重新开始就行，不会丢东西。',
      cta: '回首页',
      onCta: () => { location.hash = '#/'; },
    }));
  }

  clear(root);
  root.appendChild(wrap);
  document.title = route.name === 'job' && store.get('job')
    ? summarize(store.get('job').goal, 30) + ' · 交接 Handoff'
    : '交接 Handoff — 你只管说想要什么';
}

function handleRoute() {
  if (currentView) { currentView.destroy(); currentView = null; }
  const route = parseRoute(typeof location !== 'undefined' ? location.hash : '');
  store.set({ route, job: null, jobStatus: 'loading', jobError: null, conn: 'connecting' });
  render();
  if (route.name === 'home' && store.get('templatesStatus') === 'loading') loadTemplates().then(render);
  if (route.name === 'history') loadJobs(false);
}

function start() {
  if (typeof window === 'undefined' || !root) return;

  // store 里"哪些字段变了"决定要不要重渲染整个视图（视图内部另有细粒度 patch）
  let lastRouteKey = '';
  let lastJobsKey = '';
  store.subscribe((state) => {
    const routeKey = JSON.stringify(state.route);
    const jobsKey = state.jobsStatus + '|' + state.jobs.length;

    // 路由切换由 handleRoute 自己驱动渲染。这里只**记录**当前路由，
    // 不能直接 return —— 否则后面的 jobs / job 变更会被永久挡掉。
    if (routeKey !== lastRouteKey) {
      lastRouteKey = routeKey;
      return;
    }

    if (jobsKey !== lastJobsKey) {
      lastJobsKey = jobsKey;
      // 列表状态变了就重渲染历史页（骨架屏 -> 卡片 / 错误态 / 空状态）
      if (state.route.name === 'history') render();
      return;
    }

    // 任务详情页：不整页重渲染，交给 JobView 的局部 patch
    // （这样用户展开的日志、正在输入的回答都不会被打断）
    if (state.route.name === 'job' && currentView) {
      currentView.applyJob(state.job, false);
    }
  });

  window.addEventListener('hashchange', handleRoute);
  loadTemplates().then(() => { if (store.get('route').name === 'home') render(); });
  handleRoute();

  // 回到前台时补一次快照，避免后台标签页错过的事件
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentView) currentView.refreshSnapshot();
  });
}

start();

export { api, store, render, handleRoute, JobView, newTaskForm };
