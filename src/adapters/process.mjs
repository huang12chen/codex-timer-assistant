import { spawn as nodeSpawn } from 'node:child_process';
import { access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export class AdapterError extends Error {
  constructor(message, code = 'ADAPTER_ERROR', extra = {}) { super(message); this.name = 'AdapterError'; this.code = code; Object.assign(this, extra); }
}

// Every invocation uses an argv array. No shell, cmd /c, encoded script, or
// interpolated PowerShell command is used, including paths containing & or $.
export function runHidden(executable, argv, { timeoutMs = 12000, maxBytes = 1024 * 1024, spawn = nodeSpawn, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, stdoutBytes = 0, stderrBytes = 0;
    const output = [], errors = [];
    const stop = () => { if (child && child.exitCode === null && !child.killed) { try { child.kill(); } catch {} } };
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { stop(); reject(error); } else resolve(result); };
    try {
      child = spawn(executable, argv, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    } catch { finish(new AdapterError('无法启动本机辅助进程，请检查程序路径', 'PROCESS_START')); return; }
    child.on('error', () => finish(new AdapterError('本机辅助进程启动失败，请检查程序路径和系统权限', 'PROCESS_START')));
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) { finish(new AdapterError('辅助进程输出超过安全上限', 'OUTPUT_LIMIT')); return; }
      output.push(Buffer.from(chunk));
    });
    child.stderr.on('data', chunk => {
      // Always drain stderr, but retain only a small bounded amount internally.
      if (stderrBytes < 16384) errors.push(Buffer.from(chunk).subarray(0, 16384 - stderrBytes));
      stderrBytes += chunk.length;
    });
    child.on('close', code => finish(null, { exitCode: code, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') }));
    timer = setTimeout(() => finish(new AdapterError('本机辅助进程响应超时，已结束本助手创建的进程', 'PROCESS_TIMEOUT')), timeoutMs);
  });
}

export function nativeArguments(script, action, payload = {}) {
  if (typeof script !== 'string' || !script || /[\0\r\n]/u.test(script)) throw new AdapterError('Windows 助手路径无效', 'INVALID_TARGET');
  if (!['ListWindows', 'CaptureLink', 'Capabilities', 'InspectQuestions'].includes(action)) throw new AdapterError('不支持的 Windows 操作', 'UNSUPPORTED');
  return ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'RemoteSigned', '-File', script, '-Action', action, '-PayloadBase64', Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')];
}

export async function callNative(script, action, payload = {}, { run = runHidden, platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') throw new AdapterError('当前版本的窗口关联仅支持 Windows', 'UNSUPPORTED');
  const executable = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // A PowerShell 7 -> Node/Electron -> Windows PowerShell chain otherwise
  // inherits Core-only modules. Let WinPS build its own normal module paths;
  // never mutate the parent/user environment or relax signature verification.
  const helperEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  const result = await run(executable, nativeArguments(script, action, payload), { timeoutMs: action === 'CaptureLink' ? 12000 : 18000, maxBytes: 256 * 1024, env: helperEnv });
  let parsed;
  try { parsed = JSON.parse(result.stdout.trim().replace(/^\uFEFF/u, '')); }
  catch { throw new AdapterError('Windows 助手未返回有效结果，请在连接诊断中检查窗口支持', 'NATIVE_PROTOCOL'); }
  if (result.exitCode !== 0 || parsed.ok === false) throw new AdapterError(typeof parsed.message === 'string' ? parsed.message.slice(0, 500) : 'Windows 助手操作失败', parsed.code || 'NATIVE_FAILED');
  return parsed;
}

const validVersion = output => /(?:^|\n)codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][0-9a-zA-Z.+-]+)?)(?:\s|$)/u.exec(output)?.[1] ?? null;
export function versionAtLeast(version, minimum) {
  const split = value => { const match = /^(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?/u.exec(value || ''); return match ? { numbers: match.slice(1, 4).map(Number), pre: match[4]?.split('.') ?? [] } : null; };
  const a = split(version), b = split(minimum); if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length || b.pre.length > 0;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return false; if (b.pre[i] === undefined) return true;
    if (a.pre[i] === b.pre[i]) continue;
    const na = /^\d+$/u.test(a.pre[i]), nb = /^\d+$/u.test(b.pre[i]);
    return na && nb ? Number(a.pre[i]) > Number(b.pre[i]) : na !== nb ? !na : a.pre[i] > b.pre[i];
  }
  return true;
}

export async function discoverCli({ explicitPath = '', platform = process.platform, env = process.env, run = runHidden, exists = async file => { try { await access(file); return (await stat(file)).isFile(); } catch { return false; } } } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const expected = platform === 'win32' ? 'codex.exe' : 'codex';
  const validate = candidate => typeof candidate === 'string' && paths.isAbsolute(candidate) && paths.basename(candidate).toLowerCase() === expected && !/[\0\r\n"<>|*?]/u.test(candidate);
  const probe = async candidate => {
    if (!validate(candidate) || !await exists(candidate)) return null;
    try {
      const result = await run(candidate, ['--version'], { timeoutMs: 4000, maxBytes: 16384 });
      const version = result.exitCode === 0 ? validVersion(result.stdout) : null;
      return version ? { path: candidate, version } : null;
    } catch { return null; }
  };
  if (explicitPath) {
    if (!validate(explicitPath)) throw new AdapterError(`请选择绝对路径的 ${expected} 程序`, 'CLI_INVALID');
    const chosen = await probe(explicitPath);
    if (!chosen) throw new AdapterError('所选 Codex CLI 不存在或版本验证失败，请重新选择 codex.exe', 'CLI_NOT_FOUND');
    return chosen;
  }
  const candidates = [];
  for (const segment of String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').slice(0, 128)) {
    const directory = segment.trim().replace(/^"|"$/gu, '');
    if (directory && paths.isAbsolute(directory)) candidates.push(paths.join(directory, expected));
  }
  // Prefer the executable resolved from the normal PATH, as Get-Command would.
  for (const candidate of [...new Set(candidates)]) { const found = await probe(candidate); if (found) return found; }
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const directory = paths.join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    let entries = [];
    try { entries = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory()).slice(0, 64); } catch {}
    const found = [];
    for (const entry of entries) { const result = await probe(paths.join(directory, entry.name, expected)); if (result) found.push(result); }
    found.sort((a, b) => versionAtLeast(a.version, b.version) ? -1 : 1);
    if (found.length) return found[0];
  }
  throw new AdapterError('没有找到可用的 Codex CLI。请先安装并登录 Codex，或在设置中选择 codex.exe', 'CLI_NOT_FOUND');
}

export class AppServerClient {
  constructor({ cliPath, spawn = nodeSpawn, timeoutMs = 18000, env = process.env, onDisconnect = () => {} } = {}) {
    this.cliPath = cliPath; this.spawn = spawn; this.timeoutMs = timeoutMs; this.env = env; this.onDisconnect = onDisconnect;
    this.child = null; this.nextId = 1; this.pending = new Map(); this.buffer = ''; this.decoder = new StringDecoder('utf8'); this.stderr = ''; this.isAlive = false; this.starting = null; this.closing = false;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.isAlive) return;
    this.starting = this._start();
    try { await this.starting; } finally { this.starting = null; }
  }
  async _start() {
    this.closing = false; this.buffer = ''; this.decoder = new StringDecoder('utf8');
    try { this.child = this.spawn(this.cliPath, ['app-server', '--listen', 'stdio://'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: this.env }); }
    catch { throw new AdapterError('无法启动 Codex 读取连接，请检查 CLI 路径', 'PROCESS_START'); }
    const child = this.child;
    this.isAlive = true;
    // A terminated child can emit delayed pipe/exit events after a reconnect.
    // Those events belong only to that child, never to its replacement.
    child.stdout.on('data', chunk => { if (this.child === child) this._data(chunk); });
    child.stderr.on('data', chunk => { if (this.child === child) this.stderr = (this.stderr + chunk.toString('utf8')).slice(-16384); });
    child.stdin.on('error', () => { if (this.child === child) this._fail(new AdapterError('Codex 连接写入中断', 'RPC_DISCONNECTED')); });
    child.on('error', () => { if (this.child === child) this._fail(new AdapterError('Codex 读取进程启动失败', 'PROCESS_START')); });
    child.on('exit', () => { if (this.child === child) this._fail(new AdapterError('Codex 读取连接已关闭，请重新检查连接', 'RPC_DISCONNECTED')); });
    try {
      const result = await this.request('initialize', { clientInfo: { name: 'codex_timer_assistant', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      this.notify('initialized', {});
      return result;
    } catch (error) { this._fail(error); throw error; }
  }
  notify(method, params) {
    if (!this.isAlive) throw new AdapterError('Codex 连接尚未建立', 'RPC_DISCONNECTED');
    try { this.child.stdin.write(`${JSON.stringify({ method, params })}\n`); }
    catch { this._fail(new AdapterError('Codex 连接写入失败', 'RPC_DISCONNECTED')); }
  }
  request(method, params, { write = false, timeoutMs = this.timeoutMs } = {}) {
    if (!this.isAlive) return Promise.reject(new AdapterError('Codex 连接尚未建立', 'RPC_DISCONNECTED', { possibleWrite: false }));
    if (this.pending.size >= 32) return Promise.reject(new AdapterError('Codex 待处理请求过多', 'RPC_BUSY', { possibleWrite: false }));
    const id = this.nextId++, child = this.child;
    let line;
    try { line = `${JSON.stringify({ id, method, params })}\n`; }
    catch { return Promise.reject(new AdapterError('Codex 请求格式无效', 'RPC_PARAMS', { possibleWrite: false })); }
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, write, sent: false, timer: null };
      this.pending.set(id, pending);
      pending.timer = setTimeout(() => { if (this.child === child && this.pending.get(id) === pending) this._fail(new AdapterError('Codex 协议响应超时；写入操作的结果可能尚未返回', 'RPC_TIMEOUT')); }, timeoutMs);
      try {
        pending.sent = true;
        child.stdin.write(line, error => { if (error && this.child === child) this._fail(new AdapterError('Codex 协议连接中断', 'RPC_DISCONNECTED')); });
      } catch { if (this.child === child) this._fail(new AdapterError('Codex 协议写入失败', 'RPC_DISCONNECTED')); }
    });
  }
  _data(chunk) {
    if (!this.isAlive) return;
    this.buffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.buffer, 'utf8') > 4 * 1024 * 1024) { this._fail(new AdapterError('Codex 协议输出超出上限', 'RPC_PROTOCOL')); return; }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim(); this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); } catch { this._fail(new AdapterError('Codex 返回了无法识别的协议内容', 'RPC_PROTOCOL')); return; }
      if (!value || Array.isArray(value) || typeof value !== 'object') { this._fail(new AdapterError('Codex 协议对象无效', 'RPC_PROTOCOL')); return; }
      if (typeof value.method === 'string') {
        if (Object.hasOwn(value, 'id')) {
          // This connection never owns desktop turns and must not grant a server
          // request, approval, permission, or question on the desktop's behalf.
          try { this.child.stdin.write(`${JSON.stringify({ id: value.id, error: { code: -32601, message: 'This read-only client does not handle server requests.' } })}\n`); }
          catch { this._fail(new AdapterError('Codex 连接已中断', 'RPC_DISCONNECTED')); }
        }
        continue;
      }
      const pending = this.pending.get(value.id);
      if (!pending) continue;
      this.pending.delete(value.id); clearTimeout(pending.timer);
      if (value.error) {
        const definite = [-32601, -32602].includes(value.error.code);
        pending.reject(new AdapterError('Codex 拒绝此协议请求，请检查 CLI 版本、登录状态和队列支持', 'RPC_REMOTE', { rpcCode: value.error.code, possibleWrite: pending.write && pending.sent && !definite }));
      } else if (Object.hasOwn(value, 'result')) pending.resolve(value.result);
      else { pending.reject(new AdapterError('Codex 响应缺少结果', 'RPC_PROTOCOL', { possibleWrite: pending.write && pending.sent })); this._fail(new AdapterError('Codex 协议响应无效', 'RPC_PROTOCOL')); return; }
    }
  }
  _fail(error) {
    const wasAlive = this.isAlive; this.isAlive = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AdapterError(error.message, error.code, { possibleWrite: pending.write && pending.sent }));
    }
    this.pending.clear();
    if (this.child && this.child.exitCode === null && !this.child.killed) { try { this.child.kill(); } catch {} }
    if (wasAlive && !this.closing) { try { this.onDisconnect(error); } catch {} }
  }
  async close() { this.closing = true; this._fail(new AdapterError('助手连接已关闭', 'RPC_CLOSED')); }
}
