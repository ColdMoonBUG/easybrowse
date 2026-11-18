/**
 * 极简 Chrome DevTools Protocol 客户端（基于 WebSocket 的 JSON-RPC）。
 * 只实现本项目需要的部分：请求/响应关联、会话（sessionId）扁平化、事件订阅。
 */
import WebSocket from 'ws';

export class CDPConnection extends EventTarget {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();
  closed = false;

  constructor(ws) {
    super();
    this.#ws = ws;
    ws.on('message', (raw) => this.#onMessage(raw));
    ws.on('close', () => {
      this.closed = true;
      for (const { reject } of this.#pending.values()) reject(new Error('CDP 连接已关闭'));
      this.#pending.clear();
      this.dispatchEvent(new Event('close'));
    });
    ws.on('error', () => {
      /* close 事件会统一处理 */
    });
  }

  static connect(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('连接 CDP 超时'));
      }, timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(new CDPConnection(ws));
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message}`));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const key = `${msg.sessionId || ''}:${msg.method}`;
      for (const fn of this.#listeners.get(key) || []) {
        try {
          fn(msg.params, msg.sessionId);
        } catch {
          /* 单个订阅者异常不影响其它订阅者 */
        }
      }
      for (const fn of this.#listeners.get(`*:${msg.method}`) || []) {
        try {
          fn(msg.params, msg.sessionId);
        } catch {
          /* ignore */
        }
      }
    }
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.#id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} 执行超时`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.#ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** 订阅某个 CDP 会话的事件；sessionId 为 * 表示所有会话 */
  on(sessionId, method, handler) {
    const key = `${sessionId || ''}:${method}`;
    if (!this.#listeners.has(key)) this.#listeners.set(key, new Set());
    this.#listeners.get(key).add(handler);
    return () => this.#listeners.get(key)?.delete(handler);
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      /* ignore */
    }
  }
}
