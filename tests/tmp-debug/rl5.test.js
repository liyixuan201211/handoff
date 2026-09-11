import { describe, it, vi } from 'vitest';
import request from 'supertest';
const engine = vi.hoisted(() => ({ startJob: vi.fn(), sendMessage: vi.fn(), retryJob: vi.fn(), cancelJob: vi.fn() }));
vi.mock('/Users/imac/260912/handoff/src/pipeline/engine.js', () => engine);
const { createApp } = await import('/Users/imac/260912/handoff/src/server.js');

describe('probe3', () => {
  it('what handles the request', async () => {
    engine.startJob.mockResolvedValue({ id: 'job_0123456789abcdef' });
    const app = createApp({ rateLimit: false });
    console.log('stack len', app.router?.stack?.length ?? app._router?.stack?.length);
    const names = (app.router?.stack ?? app._router?.stack ?? []).map((l, i) => {
      const h = l.handle;
      return `${i}:${l.name}:${h?.name || 'anon'}`;
    });
    console.log(names.join(' | '));
    const r = await request(app).post('/api/jobs').send({ goal: 'x' });
    console.log('status', r.status, 'body', JSON.stringify(r.body).slice(0, 120));
  });
});
