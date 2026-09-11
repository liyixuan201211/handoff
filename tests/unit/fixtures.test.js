/**
 * 演示数据（src/demo/fixtures.js）的形状与一致性校验。
 *
 * 为什么这个文件值得单独存在：
 *   整个团队（前端、引擎、冒烟脚本、演示按钮）都依赖 `demoJob()` 的形状。
 *   这里一旦漂了，别人的代码会以最难查的方式坏掉 —— 所以我们用 CONTRACT.md §2
 *   的字段清单**逐个比对**，多一个字段、少一个字段都算失败。
 *
 * 除了形状，还校验「自洽性」：安全审查结论必须能被 src/security/guard.js 复算出来，
 * 交付物正文必须真的含有那条 PII（否则 fixture 就是在撒谎）。
 */
import { describe, it, expect } from 'vitest';
import { demoJob, DEMO_GOALS, DEFAULT_DEMO_GOAL, runDemoPipeline, demoJobSummary } from '../../src/demo/fixtures.js';
import { auditJob, auditOutput } from '../../src/security/guard.js';
import { events } from '../../src/store/events.js';
import { looksLikeSecret } from '../../src/llm/errors.js';

/* CONTRACT.md §2 冻结字段 —— 一个不多一个不少 */
const JOB_KEYS = ['id', 'goal', 'templateId', 'status', 'createdAt', 'updatedAt', 'plan', 'stages', 'artifacts', 'review', 'security', 'usage', 'clarifyQuestions', 'error'];
const STAGE_KEYS = ['id', 'key', 'title', 'role', 'status', 'startedAt', 'endedAt', 'ms', 'reason', 'log', 'output', 'error'];
const LOG_KEYS = ['at', 'level', 'text'];
const ARTIFACT_KEYS = ['id', 'deliverableId', 'name', 'format', 'content', 'assumptions', 'confidence', 'basedOn', 'createdAt'];
const REVIEW_KEYS = ['verdict', 'issues', 'checklist'];
const ISSUE_KEYS = ['severity', 'where', 'problem', 'fix'];
const CHECK_KEYS = ['item', 'ok', 'note'];
const SECURITY_KEYS = ['level', 'findings'];
const FINDING_KEYS = ['kind', 'detail', 'action'];
const PLAN_KEYS = ['title', 'intent', 'assumptions', 'risks', 'deliverables'];
const USAGE_KEYS = ['calls', 'promptTokens', 'completionTokens', 'ms'];

/** CONTRACT.md §3 的 8 个阶段，必须子集且保序 */
const STAGE_ORDER = ['intake', 'plan', 'research', 'draft', 'critique', 'revise', 'verify', 'deliver'];

const sorted = (o) => Object.keys(o).sort();

describe('demoJob() — 形状严格符合 CONTRACT §2', () => {
  const job = demoJob();

  it('顶层字段与契约完全一致（不多不少）', () => {
    expect(Object.keys(job).sort()).toEqual([...JOB_KEYS].sort());
  });

  it('基本字段：done / 时间戳 / 空 clarifyQuestions / 无 error', () => {
    expect(job.id).toMatch(/^job_[0-9a-f]{16}$/);
    expect(job.status).toBe('done');
    expect(job.templateId).toBeNull();
    expect(job.clarifyQuestions).toEqual([]);
    expect(job.error).toBeNull();
    expect(typeof job.goal).toBe('string');
    expect(job.goal.length).toBeGreaterThan(0);
    expect(job.createdAt).toBeLessThanOrEqual(job.updatedAt);
  });

  it('阶段：8 个 / 保序 / 全 done / 每个阶段都有 reason、log、output、耗时', () => {
    expect(job.stages.map((s) => s.key)).toEqual(STAGE_ORDER);
    job.stages.forEach((s, i) => {
      expect(Object.keys(s).sort()).toEqual([...STAGE_KEYS].sort());
      expect(s.id).toBe(`stage_${i + 1}`);
      expect(s.status).toBe('done');
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.role.length).toBeGreaterThan(0); // 前端要展示「虚拟员工姓名+角色」
      expect(s.reason.length).toBeGreaterThan(4); // 为什么有这个阶段，给用户看
      expect(s.ms).toBeGreaterThan(0);
      expect(s.startedAt).toBeGreaterThanOrEqual(job.createdAt);
      expect(s.endedAt).toBe(s.startedAt + s.ms);
      expect(s.output).toBeTypeOf('object');
      expect(s.error).toBeNull();
      expect(s.log.length).toBeGreaterThanOrEqual(1);
      s.log.forEach((l) => {
        expect(Object.keys(l).sort()).toEqual([...LOG_KEYS].sort());
        expect(['info', 'warn', 'error']).toContain(l.level);
        expect(l.text.length).toBeGreaterThan(0);
        expect(l.at).toBeGreaterThanOrEqual(s.startedAt);
      });
    });
  });

  it('阶段时间线不重叠（看起来像真的在一个一个跑）', () => {
    for (let i = 1; i < job.stages.length; i += 1) {
      expect(job.stages[i].startedAt).toBeGreaterThanOrEqual(job.stages[i - 1].endedAt);
    }
    expect(job.updatedAt).toBeGreaterThanOrEqual(job.stages.at(-1).endedAt);
  });

  it('plan：字段完整、4 条假设、交付物 3 个', () => {
    expect(Object.keys(job.plan).sort()).toEqual([...PLAN_KEYS].sort());
    expect(job.plan.title.length).toBeGreaterThan(0);
    expect(job.plan.intent.length).toBeGreaterThan(10);
    expect(job.plan.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(job.plan.assumptions.length).toBeLessThanOrEqual(4);
    job.plan.assumptions.forEach((a) => expect(a.length).toBeGreaterThan(4));
    expect(job.plan.risks.length).toBeGreaterThanOrEqual(1);
    expect(job.plan.deliverables.length).toBeGreaterThanOrEqual(2);
    job.plan.deliverables.forEach((d) => {
      expect(d.id).toMatch(/^d\d+$/);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.format).toBe('markdown');
    });
  });

  it('artifacts：2-3 个、正文是有用的中文 markdown 且 > 80 字、id 唯一', () => {
    expect(job.artifacts.length).toBeGreaterThanOrEqual(2);
    expect(job.artifacts.length).toBeLessThanOrEqual(3);
    const ids = job.artifacts.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const deliverableIds = new Set(job.plan.deliverables.map((d) => d.id));

    job.artifacts.forEach((a) => {
      expect(Object.keys(a).sort()).toEqual([...ARTIFACT_KEYS].sort());
      expect(a.id).toMatch(/^art_[0-9a-f]{16}$/);
      expect(deliverableIds.has(a.deliverableId)).toBe(true);
      expect(a.format).toBe('markdown');
      expect(a.confidence).toBe('high');
      expect(a.content.length).toBeGreaterThan(80);
      expect(a.content).toContain('#'); // 真的是 markdown
      expect(a.content).not.toMatch(/lorem ipsum|TODO|占位/i);
      expect(a.basedOn.length).toBeGreaterThan(0);
      a.basedOn.forEach((sid) => expect(job.stages.some((s) => s.id === sid)).toBe(true));
      expect(a.assumptions.length).toBeGreaterThan(0);
      expect(a.createdAt).toBeGreaterThanOrEqual(job.createdAt);
    });
  });

  it('场景就是「租房合同风险审查」：产物名称与内容对得上', () => {
    const names = job.artifacts.map((a) => a.name);
    expect(names).toContain('合同风险清单');
    expect(names).toContain('给你的行动建议');
    const risk = job.artifacts.find((a) => a.name === '合同风险清单');
    expect(risk.content).toContain('押金');
    expect(risk.content).toContain('维修');
    expect(risk.content).toContain('违约金');
  });

  it('review：pass_with_notes + 2-3 个 issues + 5-6 条 checklist', () => {
    expect(Object.keys(job.review).sort()).toEqual([...REVIEW_KEYS].sort());
    expect(job.review.verdict).toBe('pass_with_notes');
    expect(job.review.issues.length).toBeGreaterThanOrEqual(2);
    expect(job.review.issues.length).toBeLessThanOrEqual(3);
    const artifactIds = job.artifacts.map((a) => a.id);
    job.review.issues.forEach((i) => {
      expect(Object.keys(i).sort()).toEqual([...ISSUE_KEYS].sort());
      expect(['high', 'medium', 'low']).toContain(i.severity);
      expect(artifactIds).toContain(i.where); // where 必须指向真实产物 id
      expect(i.problem.length).toBeGreaterThan(6);
      expect(i.fix.length).toBeGreaterThan(6);
    });
    expect(job.review.checklist.length).toBeGreaterThanOrEqual(5);
    expect(job.review.checklist.length).toBeLessThanOrEqual(6);
    job.review.checklist.forEach((c) => {
      expect(Object.keys(c).sort()).toEqual([...CHECK_KEYS].sort());
      expect(typeof c.ok).toBe('boolean');
      expect(c.item.length).toBeGreaterThan(3);
    });
    // pass_with_notes 的语义：确实有没通过的自检项
    expect(job.review.checklist.some((c) => c.ok === false)).toBe(true);
  });

  it('security：notice + 1-2 条 findings（含手机号这类 PII）', () => {
    expect(Object.keys(job.security).sort()).toEqual([...SECURITY_KEYS].sort());
    expect(job.security.level).toBe('notice');
    expect(job.security.findings.length).toBeGreaterThanOrEqual(1);
    expect(job.security.findings.length).toBeLessThanOrEqual(2);
    job.security.findings.forEach((f) => {
      expect(Object.keys(f).sort()).toEqual([...FINDING_KEYS].sort());
      expect(['prompt_injection', 'pii', 'unsafe_request', 'secret_leak']).toContain(f.kind);
      expect(f.detail.length).toBeGreaterThan(4);
      expect(f.action.length).toBeGreaterThan(1);
    });
    expect(job.security.findings.some((f) => f.kind === 'pii')).toBe(true);
  });

  it('security 结论能被 src/security/guard.js 独立复算出来（fixture 没有撒谎）', () => {
    const recomputed = auditJob({ artifacts: job.artifacts, review: job.review, plan: job.plan, security: job.security });
    expect(recomputed.level).toBe(job.security.level);
    expect(recomputed.findings.map((f) => f.kind)).toContain('pii');
    // 交付物里确实有手机号（不是我们凭空说「发现 PII」）
    expect(job.artifacts.some((a) => /1[3-9]\d{9}/.test(a.content))).toBe(true);
  });

  it('交付物里没有密钥形态的内容（fixture 自己先过一遍安全底线）', () => {
    for (const a of job.artifacts) {
      expect(looksLikeSecret(a.content)).toBe(false);
      expect(auditOutput(a.content).findings.some((f) => f.kind === 'secret_leak')).toBe(false);
    }
  });

  it('usage：字段完整、数字合理、模型耗时不超过阶段总耗时', () => {
    expect(Object.keys(job.usage).sort()).toEqual([...USAGE_KEYS].sort());
    expect(job.usage.calls).toBeGreaterThan(0);
    expect(job.usage.promptTokens).toBeGreaterThan(0);
    expect(job.usage.completionTokens).toBeGreaterThan(0);
    const stageMs = job.stages.reduce((s, x) => s + x.ms, 0);
    expect(job.usage.ms).toBeGreaterThan(0);
    expect(job.usage.ms).toBeLessThanOrEqual(stageMs);
  });

  it('满足 CONTRACT §7 的全部 5 条验收标准（演示任务必须真的算「交付成功」）', () => {
    expect(job.status).toBe('done'); // 1
    expect(job.artifacts.length).toBeGreaterThanOrEqual(1); // 2
    job.artifacts.forEach((a) => expect(a.content.length).toBeGreaterThan(80));
    expect(job.review).not.toBeNull(); // 3
    expect(job.review.verdict).not.toBe('needs_revision');
    expect(job.security.level).not.toBe('blocked'); // 4
    const deliver = job.stages.find((s) => s.key === 'deliver'); // 5
    expect(typeof deliver.output.howToUse).toBe('string');
    expect(deliver.output.howToUse.length).toBeGreaterThan(20);
  });

  it('每次调用都是全新对象 + 全新 id（并发创建演示任务不会互相污染）', () => {
    const a = demoJob();
    const b = demoJob();
    expect(a).not.toBe(b);
    expect(a.id).not.toBe(b.id);
    expect(a.artifacts[0].id).not.toBe(b.artifacts[0].id);
    // 改一个不能影响另一个
    a.stages[0].status = 'failed';
    expect(b.stages[0].status).toBe('done');
  });

  it('自定义 goal 会被采用；空/非法 goal 回落到默认演示目标', () => {
    expect(demoJob('帮我看劳动合同').goal).toBe('帮我看劳动合同');
    expect(demoJob('   ').goal).toBe(DEFAULT_DEMO_GOAL);
    expect(demoJob(undefined).goal).toBe(DEFAULT_DEMO_GOAL);
  });
});

describe('DEMO_GOALS — 一键体验按钮的数据源', () => {
  it('是若干条普通人说的话，长度合法（1..4000）', () => {
    expect(Array.isArray(DEMO_GOALS)).toBe(true);
    expect(DEMO_GOALS.length).toBeGreaterThanOrEqual(3);
    for (const g of DEMO_GOALS) {
      expect(typeof g).toBe('string');
      expect(g.trim().length).toBeGreaterThan(0);
      expect(g.length).toBeLessThanOrEqual(4000);
    }
    expect(DEMO_GOALS).toContain(DEFAULT_DEMO_GOAL);
  });

  it('每条示例目标都能直接喂给 demoJob()', () => {
    for (const g of DEMO_GOALS) {
      const job = demoJob(g);
      expect(job.goal).toBe(g);
      expect(job.status).toBe('done');
    }
  });
});

describe('runDemoPipeline() — 演出给用户看的流水线', () => {
  it('按阶段顺序 emit，事件种类齐全，最后返回完成态 job', async () => {
    const seen = [];
    const job = await runDemoPipeline('帮我把这份租房合同看一遍', (e) => seen.push(e), { stepMs: 1 });

    expect(job.status).toBe('done');
    expect(job.stages.map((s) => s.key)).toEqual(STAGE_ORDER);
    job.stages.forEach((s) => {
      expect(s.status).toBe('done');
      expect(s.ms).toBeGreaterThan(0);
    });

    const types = new Set(seen.map((e) => e.type));
    for (const t of ['job', 'stage', 'log', 'artifact', 'review', 'security', 'done']) {
      expect(types.has(t)).toBe(true);
    }

    // 阶段 running 的顺序必须与契约一致
    const running = seen.filter((e) => e.type === 'stage' && e.status === 'running').map((e) => e.stageId);
    expect(running).toEqual(STAGE_ORDER.map((_, i) => `stage_${i + 1}`));

    // 产物事件数量与最终产物数量一致
    const artifactEvents = seen.filter((e) => e.type === 'artifact');
    expect(artifactEvents.length).toBe(job.artifacts.length);
    artifactEvents.forEach((e) => {
      expect(job.artifacts.some((a) => a.id === e.artifactId)).toBe(true);
      expect(typeof e.name).toBe('string');
    });

    expect(seen.at(-1)).toEqual({ type: 'done', status: 'done' });
    expect(seen.find((e) => e.type === 'review').review.verdict).toBe('pass_with_notes');
    expect(seen.find((e) => e.type === 'security').security.level).toBe('notice');
  });

  it('emit 的 payload 与 events.publish 兼容（事件能被事件总线按序读回）', async () => {
    const jobId = `job_demo_compat_${Date.now()}`;
    const job = await runDemoPipeline('兼容性测试', (payload) => events.publish(jobId, payload), { stepMs: 1 });
    try {
      const logged = events.since(jobId, 0);
      expect(events.cursor(jobId)).toBe(logged.length);
      // seq 严格递增，at 都被补上了
      logged.forEach((e, i) => {
        expect(e.seq).toBe(i + 1);
        expect(typeof e.at).toBe('number');
        expect(typeof e.type).toBe('string');
      });
      expect(logged.at(-1).type).toBe('done');
      expect(logged.filter((e) => e.type === 'log').length).toBeGreaterThan(8);
      expect(job.id).toMatch(/^job_/);
    } finally {
      events.drop(jobId);
    }
  });

  it('中途取消 → 抛 AbortError，且不再继续 emit', async () => {
    const ac = new AbortController();
    const seen = [];
    // 确定性做法：在「第一个阶段开始」这一条事件里就取消，而不是靠 sleep 猜时机。
    // 靠 setTimeout 猜时机的话，机器一慢就会变成 flaky 测试。
    const p = runDemoPipeline('取消测试', (e) => {
      seen.push(e);
      if (e.type === 'stage' && e.status === 'running' && e.stageId === 'stage_1') ac.abort();
    }, { stepMs: 5, signal: ac.signal });

    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    const countAtAbort = seen.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(seen.length).toBe(countAtAbort); // 取消之后一条事件都不许再发
    expect(seen.some((e) => e.type === 'done')).toBe(false);
    expect(seen.some((e) => e.stageId === 'stage_2')).toBe(false);
  });

  it('一开始就取消 → 立刻抛 AbortError', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(runDemoPipeline('x', () => {}, { stepMs: 1, signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('emit 不是函数 → 明确报错（而不是静默什么都不发生）', async () => {
    await expect(runDemoPipeline('x', null, { stepMs: 1 })).rejects.toThrow(TypeError);
  });

  it('stepMs 控制节奏：stepMs 更大 → 总耗时更长', async () => {
    const t0 = Date.now();
    await runDemoPipeline('快', () => {}, { stepMs: 1 });
    const fast = Date.now() - t0;
    const t1 = Date.now();
    await runDemoPipeline('慢', () => {}, { stepMs: 12 });
    const slow = Date.now() - t1;
    expect(slow).toBeGreaterThan(fast);
  });

  it('demoJobSummary：够前端渲染，但不带产物正文（事件日志不能被正文撑爆）', () => {
    const job = demoJob();
    const sum = demoJobSummary(job);
    expect(sum.id).toBe(job.id);
    expect(sum.stages.length).toBe(8);
    expect(sum.artifacts.length).toBe(job.artifacts.length);
    expect(sum.artifacts[0].content).toBeUndefined();
    expect(JSON.stringify(sum)).not.toContain(job.artifacts[0].content.slice(0, 40));
  });
});
