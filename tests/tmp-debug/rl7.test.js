import { describe, it } from 'vitest';
import express from 'express';
import request from 'supertest';

describe('bare express 5 ordering', () => {
  it('middleware registered after a router still runs?', async () => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    const r = express.Router();
    r.post('/jobs', (req, res) => res.status(201).json({ ok: 1 }));
    app.use('/api', r);
    app.use((req, res, next) => { console.log('AFTER-ROUTER mw ran'); next(); });
    const res = await request(app).post('/api/jobs').send({ goal: 'x' });
    console.log('status', res.status);
  });
  it('middleware registered before a router runs?', async () => {
    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.use((req, res, next) => { console.log('BEFORE-ROUTER mw ran'); next(); });
    const r = express.Router();
    r.post('/jobs', (req, res) => res.status(201).json({ ok: 1 }));
    app.use('/api', r);
    const res = await request(app).post('/api/jobs').send({ goal: 'x' });
    console.log('status2', res.status);
  });
});
