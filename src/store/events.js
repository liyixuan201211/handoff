/**
 * 事件总线 + 游标式读日志。
 *
 * 设计取舍：为什么不用纯 EventEmitter？
 * 因为普通人会刷新页面、会关掉浏览器再回来。纯内存广播会丢事件，
 * 前端就会永远停在「运行中」。所以每个事件既广播给在线订阅者，
 * 也按 游标(seq) 追加进内存日志，重连时用 Last-Event-ID 补发。
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

/** 每个 job 最多保留多少条事件（防止长跑任务把内存吃光） */
const MAX_LOG_PER_JOB = 500;

class JobEvents {
  #emitter = new EventEmitter();
  /** @type {Map<string, {seq:number, events:Array}>} */
  #logs = new Map();

  constructor() {
    // 一个 job 可能有很多浏览器标签页在听，别让 Node 报 MaxListeners 警告
    this.#emitter.setMaxListeners(0);
  }

  /**
   * 追加事件并广播。
   * @returns {{seq:number, at:number, payload:object}} 已带 seq/at 的完整事件
   */
  publish(jobId, payload) {
    const entry = this.#logs.get(jobId) ?? { seq: 0, events: [] };
    entry.seq += 1;
    const full = { ...payload, seq: entry.seq, at: Date.now() };
    entry.events.push(full);
    if (entry.events.length > MAX_LOG_PER_JOB) {
      entry.events.splice(0, entry.events.length - MAX_LOG_PER_JOB);
    }
    this.#logs.set(jobId, entry);
    this.#emitter.emit(jobId, full);
    return full;
  }

  /** 读 seq 之后的事件（用于断线重连补发） */
  since(jobId, seq = 0) {
    const entry = this.#logs.get(jobId);
    if (!entry) return [];
    return entry.events.filter((e) => e.seq > seq);
  }

  /** 当前游标 */
  cursor(jobId) {
    return this.#logs.get(jobId)?.seq ?? 0;
  }

  /**
   * 订阅。返回退订函数（务必在响应关闭时调用，否则内存泄漏）。
   */
  subscribe(jobId, listener) {
    this.#emitter.on(jobId, listener);
    return () => this.#emitter.off(jobId, listener);
  }

  /** job 被删除时清理 */
  drop(jobId) {
    this.#logs.delete(jobId);
    this.#emitter.removeAllListeners(jobId);
  }

  /** 测试辅助：当前在线监听数 */
  listenerCount(jobId) {
    return this.#emitter.listenerCount(jobId);
  }
}

export const events = new JobEvents();

export const newId = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
