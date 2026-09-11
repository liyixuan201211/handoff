/**
 * 端到端真跑：从一句话委托，到一份交付物。
 *
 * 这不是测试替身，是**真的调 DeepSeek-V4.1-Flash**。
 * 跑它需要网络和一个可用的 Key（会自动从 Cherry Studio 读）。
 *
 *   node scripts/dry-run.js "用三句话解释什么是复利，给一个初中生看"
 *
 * 退出码 0 = 全流程通过；1 = 有环节不达标（会打印具体哪一条）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用临时数据目录，绝不污染真实 data/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-dry-'));
process.env.HANDOFF_DATA_DIR = tmpDir;

const goal =
  process.argv.slice(2).join(' ').trim() ||
  '帮我把这份租房合同看一遍，我怕有坑。合同里写着：押金两个月共6000元，租期一年，提前退租押金不退，水电燃气由租客承担，房东可以在租期内随时带人看房，维修超过200元由租客承担。';

const { startJob } = await import('../src/pipeline/engine.js');
const { events } = await import('../src/store/events.js');
const { getJob, listJobs } = await import('../src/store/json-store.js');

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

console.log('═'.repeat(72));
console.log('委托：', goal.slice(0, 120) + (goal.length > 120 ? '…' : ''));
console.log('数据目录：', tmpDir);
console.log('─'.repeat(72));

const job = await startJob({ goal });
log(`任务已创建：${job.id}`);

// 实时订阅事件，模拟前端看到的东西
const seen = { stages: new Set(), logs: 0, artifacts: 0 };
const unsubscribe = events.subscribe(job.id, (e) => {
  if (e.type === 'stage') {
    if (e.status === 'running') log(`  ▶ ${e.name ?? ''}（${e.role}）开始：${e.title}`);
    if (e.status === 'done') log(`  ✓ ${e.role} 完成，用时 ${(e.ms / 1000).toFixed(1)}s`);
    if (e.status === 'failed') log(`  ✗ ${e.role} 失败`);
    seen.stages.add(e.stageId);
  } else if (e.type === 'log') {
    seen.logs += 1;
    if (e.level !== 'info') log(`  ! ${e.text}`);
  } else if (e.type === 'artifact') {
    seen.artifacts += 1;
    log(`  📄 产出交付物：${e.name}`);
  } else if (e.type === 'review') {
    log(`  ⚖ 质检结论：${e.review.verdict}（${e.review.issues.length} 个问题）`);
  } else if (e.type === 'security') {
    log(`  🛡 安全检查：${e.security.level}（${e.security.findings.length} 项）`);
  } else if (e.type === 'clarify') {
    log(`  ❓ 需要你确认：${e.questions.join(' / ')}`);
  } else if (e.type === 'error') {
    log(`  ✗ 错误：${e.message}`);
  }
});

// 等待结束
const DEADLINE_MS = Number(process.env.HANDOFF_DRYRUN_DEADLINE_MS) || 20 * 60 * 1000;
let final = null;
// 接待员偶尔会反问（默认策略是"先做、把假设亮出来"，但真的缺关键信息时会问）。
// 真实用户会在界面上回答，所以干跑脚本也要**扮演这个用户** ——
// 否则我们测的就不是"完整的一条路"，而是"半条路"。
// 这是脚本的职责，不是产品的缺陷：产品在这一步的行为是对的（停下来问，而不是瞎猜）。
let answered = false;
while (Date.now() - t0 < DEADLINE_MS) {
  await new Promise((r) => setTimeout(r, 500));
  const cur = await getJob(job.id);

  if (cur && cur.status === 'awaiting_input' && !answered) {
    answered = true;
    const questions = (cur.clarifyQuestions ?? []).join(' / ');
    log(`  ❓ 接待员想确认：${questions}`);
    log('  💬 我（作为用户）回答：我手上有合同原文，只给了你摘要。请按摘要先给出风险清单和应对动作，'
      + '并在交付物里提醒我拿原文逐条核对。我是租客，还没签字，最担心押金要不回来。');
    try {
      const { sendMessage } = await import('../src/pipeline/engine.js');
      await sendMessage(
        job.id,
        '我手上有合同原文，只是这次只给了你摘要。请先按摘要给出风险清单和具体应对动作，'
        + '并在交付物里提醒我拿原文逐条核对。我是租客，还没签字，最担心押金要不回来。',
      );
    } catch (err) {
      log(`  ⚠️ 回答没能提交：${err.code || err.message}`);
    }
    continue;
  }

  if (cur && ['done', 'failed', 'cancelled'].includes(cur.status)) {
    final = cur;
    break;
  }
}
unsubscribe();

if (!final) {
  console.error('\n超时：8 分钟内没有结束。');
  process.exit(1);
}

console.log('─'.repeat(72));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`状态：${final.status}   总耗时：${elapsed}s`);
console.log(`模型调用：${final.usage.calls} 次，输入 ${final.usage.promptTokens} tokens，输出 ${final.usage.completionTokens} tokens`);
console.log(`阶段：${final.stages.length} 个（完成 ${final.stages.filter((s) => s.status === 'done').length} 个）`);
console.log(`交付物：${final.artifacts.length} 份`);

for (const a of final.artifacts) {
  console.log(`\n   ── ${a.name}（${a.content.length} 字，把握度：${a.confidence}）`);
  console.log(
    a.content
      .split('\n')
      .slice(0, 12)
      .map((l) => `      ${l}`)
      .join('\n'),
  );
  if (a.content.split('\n').length > 12) console.log('      …');
}

if (final.review) {
  console.log(`\n质检（${final.review.verdict}）：`);
  for (const c of final.review.checklist) console.log(`   ${c.ok ? '✓' : '✗'} ${c.item}`);
  for (const i of final.review.issues) console.log(`   [${i.severity}] ${i.problem}`);
}
if (final.security) {
  console.log(`\n安全（${final.security.level}）：`);
  for (const f of final.security.findings) console.log(`   [${f.severity}] ${f.kind}: ${f.detail}`);
}
if (final.error) console.log(`\n错误：${final.error.code} ${final.error.message}`);

/* ── 验收（CONTRACT §7） ─────────────────────────────────────── */
console.log('\n' + '═'.repeat(72));
console.log('验收：');
const checks = [
  ['最终状态是 done', final.status === 'done'],
  ['至少 1 份交付物', final.artifacts.length > 0],
  [
    '每份交付物内容 > 80 字',
    final.artifacts.filter((a) => a.deliverableId !== '__handoff_guide__').every((a) => a.content.length > 80),
  ],
  ['质检结论不是 needs_revision', final.review && final.review.verdict !== 'needs_revision'],
  ['安全等级不是 blocked', final.security?.level !== 'blocked'],
  ['有「怎么用」说明', final.artifacts.some((a) => a.deliverableId === '__handoff_guide__')],
  ['阶段数 ≥ 5', final.stages.length >= 5],
];
let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) pass = false;
}

console.log(`\n数据目录里的文件：${listJobs ? (await listJobs()).length : '?'} 个任务`);
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(pass ? '\n全部通过 ✅' : '\n有环节不达标 ❌');
process.exit(pass ? 0 : 1);
