/**
 * SSE 路由（CONTRACT §2 的 GET /api/jobs/:id/stream）。
 *
 * 这里只做三件事：确认 job 存在 → 把连接交给 sseHandler → 不管了。
 * 业务逻辑（推什么、什么时候推）全在 engine 里，通过 events 总线过来。
 */
import express from 'express';
import { sseHandler } from '../util/sse.js';
import { ERR } from '../llm/errors.js';
import { getJob, isValidJobId } from '../store/json-store.js';

export function createStreamRouter() {
  const router = express.Router();

  router.get('/jobs/:id/stream', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!isValidJobId(id)) {
        res.status(404).json({ error: { code: ERR.NOT_FOUND, message: '找不到这个任务。' } });
        return;
      }
      const job = await getJob(id);
      if (!job) {
        res.status(404).json({ error: { code: ERR.NOT_FOUND, message: '找不到这个任务。' } });
        return;
      }
      // sseHandler 内部自己管 headers / 心跳 / 清理，这里不 await，连接会一直挂着
      sseHandler({ jobId: id, req, res });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default createStreamRouter;
