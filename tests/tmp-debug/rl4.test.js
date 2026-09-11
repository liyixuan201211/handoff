import { describe, it, vi } from 'vitest';
import request from 'supertest';
const engine = vi.hoisted(() => ({ startJob: vi.fn(), sendMessage: vi.fn(), retryJob: vi.fn(), cancelJob: vi.fn() }));
vi.mock('/Users/imac/260912/handoff/src/pipeline/engine.js', () => engine);
const { createApp, createRateLimiter, RATE_RULES } = await import('/Users/imac/260912/handoff/src/server.js');

describe('probe2', () => {
  it('injected on real app', async () => {
    engine.startJob.mockResolvedValue({ id: 'job_0123456789abcdef' });
    const app = createApp({ rateLimit: false });
    const now = 1000000;
    const limiter = createRateLimiter({ rules: RATE_RULES, now: () => now });
    app.use((req, res, next) => { console.log('probe path=', JSON.stringify(req.path), req.method); next(); });
    app.use(limiter);
    const st = [];
    for (let i = 0; i < 11; i++) { const r = await request(app).post('/api/jobs').send({ goal: 'x' }); st.push(r.status); }
    console.log('statuses', st.join(','), 'hits', [...limiter.hits.entries()].map(([k, v]) => k + ':' + v.length));
    limiter.dispose();
  });
});
