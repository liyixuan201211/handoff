import { describe, it, vi } from 'vitest';
import request from 'supertest';
const engine = vi.hoisted(() => ({ startJob: vi.fn(), sendMessage: vi.fn(), retryJob: vi.fn(), cancelJob: vi.fn() }));
vi.mock('/Users/imac/260912/handoff/src/pipeline/engine.js', () => engine);
const { createApp, createRateLimiter, RATE_RULES } = await import('/Users/imac/260912/handoff/src/server.js');

describe('probe4', () => {
  it('inject A', async () => {
    engine.startJob.mockResolvedValue({ id: 'job_0123456789abcdef' });
    const app = createApp({ rateLimit: false });
    const limiter = createRateLimiter({ rules: RATE_RULES });
    app.use((req, res, next) => { console.log('A'); next(); });
    app.use(limiter);
    app.use((req, res, next) => { console.log('B'); next(); });
    for (let i = 0; i < 12; i++) { await request(app).post('/api/jobs').send({ goal: 'x' }); }
    console.log('hits', limiter.hits.size);
    limiter.dispose();
  });
  it('inject B (limiter first)', async () => {
    engine.startJob.mockResolvedValue({ id: 'job_0123456789abcdef' });
    const app = createApp({ rateLimit: false });
    const limiter = createRateLimiter({ rules: RATE_RULES });
    app.use(limiter);
    app.use((req, res, next) => { console.log('after-limiter'); next(); });
    let last;
    for (let i = 0; i < 12; i++) { last = (await request(app).post('/api/jobs').send({ goal: 'x' })).status; }
    console.log('last', last, 'hits', limiter.hits.size);
    limiter.dispose();
  });
});
