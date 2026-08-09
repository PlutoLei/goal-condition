import { spawn } from 'node:child_process';
import net from 'node:net';
import { appendFileSync, readFileSync } from 'node:fs';

// app-server 用 line-delimited JSON-RPC over stdio（每行一条 JSON）。
// sock 模式连 daemon 的 control socket，帧格式相同。
export class AppServerClient {
  constructor({ mode = 'stdio', sockPath, codexHome, cwd } = {}) {
    this.mode = mode;
    this.sockPath = sockPath;
    this.codexHome = codexHome;
    this.cwd = cwd;
    this._id = 0;
    this._pending = new Map();     // id -> {resolve, reject}
    this._notifyCbs = [];
    this._buf = '';
  }

  _wire(readable, writable) {
    this._writable = writable;
    readable.setEncoding('utf8');
    readable.on('data', (chunk) => {
      this._buf += chunk;
      let nl;
      while ((nl = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, nl).trim();
        this._buf = this._buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          this._pending.get(msg.id).resolve(msg);
          this._pending.delete(msg.id);
        } else if (msg.method) {
          for (const cb of this._notifyCbs) cb({ method: msg.method, params: msg.params });
        }
      }
    });
  }

  async start() {
    if (this.mode === 'stdio') {
      // 隔离铁律：codexHome 是硬约束，缺省不得静默继承 ambient/生产 CODEX_HOME（很可能是生产 ~/.codex）。
      if (!this.codexHome) throw new Error('CODEX_HOME isolation is mandatory: refusing to start app-server without an explicit codexHome');
      const env = { ...process.env, CODEX_HOME: this.codexHome };
      // --listen stdio:// 是默认值，显式写防未来默认漂移（实测 0.146 help 确认）
      this._proc = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
      this._wire(this._proc.stdout, this._proc.stdin);
    } else {
      this._sock = net.createConnection(this.sockPath);
      await new Promise((res, rej) => { this._sock.once('connect', res); this._sock.once('error', rej); });
      this._wire(this._sock, this._sock);
    }
  }

  rpc(method, params = {}) {
    const id = ++this._id;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._writable.write(line);
      // .unref()：实测发现悬空 timer 若不 unref，每次 rpc() 都会把进程挂到 60s 超时后才能自然退出
      // （已用响应仍会 resolve/delete pending，但 timer 本身继续持有事件循环）。unref 不改变超时语义。
      setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }
      }, 60000).unref();
    });
  }

  onNotification(cb) { this._notifyCbs.push(cb); }

  async initialize() {
    // 实测确认：app-server 需要 initialize 握手，clientInfo 为必填（schema InitializeParams.required = ["clientInfo"]）。
    const r = await this.rpc('initialize', { clientInfo: { name: 'goal-condition-spike', version: '0' } });
    return r.result ?? r;
  }

  async threadStart(params = {}) {
    // sandbox:'read-only' 是默认值——spike 默认只读最安全、符合隔离铁律；需要写的 spike（S2/S4）
    // 通过 ...params 显式传 sandbox:'workspace-write' 覆盖（展开顺序在后，能盖住默认）。
    const r = await this.rpc('thread/start', { ephemeral: true, sandbox: 'read-only', cwd: this.cwd, ...params });
    // 实测确认：threadId 在 result.thread.id（schema Thread 无 threadId 字段，只有 id）。
    const threadId = r.result?.thread?.threadId ?? r.result?.thread?.id;
    if (!threadId) throw new Error('thread/start returned no threadId: ' + JSON.stringify(r));
    return { threadId, raw: r };
  }

  async stop() {
    if (this._proc) this._proc.kill('SIGTERM');
    if (this._sock) this._sock.destroy();
  }
}

export function appendResult(path, row) {
  appendFileSync(path, row.endsWith('\n') ? row : row + '\n');
}
export function readResults(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
