import { callModel } from '/Users/imac/260912/handoff/src/llm/gateway.js';
import { inspectChain } from '/Users/imac/260912/handoff/src/llm/providers.js';

console.log('链状况:', inspectChain().map(c => `${c.provider}/${c.model}:${c.configured ? c.keySource : '未配置'}`).join('  '));

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'confidence'],
  properties: {
    intent: { type: 'string', minLength: 5 },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

const r = await callModel({
  system: '你是一名接待员。只输出 JSON。',
  user: '用户说：「帮我把这份租房合同看一遍，我怕有坑」。请输出 {intent, confidence}',
  schema,
  maxTokens: 3000,
  purpose: 'gateway-selftest',
  role: '接待员',
  onNotice: (n) => console.log('  [通知]', n.text),
});
console.log('provider:', r.provider, '| model:', r.model, '| degraded:', r.degraded, '| ms:', r.ms);
console.log('usage:', JSON.stringify(r.usage));
console.log('json:', JSON.stringify(r.json));
