import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { AppServerClient, discoverCli, runHidden, nativeArguments, callNative } from '../src/adapters/process.mjs';

function fakeProcess(handler) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 123; child.exitCode = null; child.killed = false;
  child.stdin = new Writable({ write(chunk, _encoding, done) { for (const line of chunk.toString().trim().split('\n')) handler(JSON.parse(line), child); done(); } });
  child.kill = () => { child.killed = true; child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); return true; };
  return child;
}
const reply = (child, request, result) => queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`));

test('RPC uses a hidden process and safely routes interleaved ids without approving requests', async () => {
  const writes = []; let spawnArgs;
  const child = fakeProcess((request, proc) => {
    writes.push(request);
    if (request.method === 'initialize') reply(proc, request, { userAgent: 'codex' });
    if (request.method === 'first') { proc.stdout.write('{"id":"approval","method":"item/commandExecution/requestApproval","params":{}}\n'); setTimeout(() => reply(proc, request, { first: true }), 5); }
    if (request.method === 'second') reply(proc, request, { second: true });
  });
  const client = new AppServerClient({ cliPath: 'C:\\space & $(x)\\codex.exe', spawn: (...args) => { spawnArgs = args; return child; }, timeoutMs: 100 });
  await client.start();
  const [a, b] = await Promise.all([client.request('first', {}), client.request('second', {})]);
  assert.equal(a.first, true); assert.equal(b.second, true);
  assert.deepEqual(spawnArgs[1], ['app-server', '--listen', 'stdio://']);
  assert.equal(spawnArgs[2].shell, false); assert.equal(spawnArgs[2].windowsHide, true);
  const denied = writes.find(value => value.id === 'approval');
  assert.ok(denied.error); assert.equal(denied.result, undefined);
  await client.close(); assert.equal(child.killed, true);
});
test('malformed RPC output fails visibly and a queue timeout is explicitly uncertain', async () => {
  const malformed = fakeProcess((request, proc) => { if (request.method === 'initialize') proc.stdout.write('not-json\n'); });
  const a = new AppServerClient({ cliPath: 'codex.exe', spawn: () => malformed, timeoutMs: 100 });
  await assert.rejects(a.start(), /协议/); assert.equal(malformed.killed, true);
  const child = fakeProcess((request, proc) => { if (request.method === 'initialize') reply(proc, request, {}); });
  const b = new AppServerClient({ cliPath: 'codex.exe', spawn: () => child, timeoutMs: 25 }); await b.start();
  await assert.rejects(b.request('thread/queue/add', {}, { write: true }), error => error.possibleWrite === true && error.code === 'RPC_TIMEOUT');
  assert.equal(child.killed, true);
});
test('native payload is base64 argv and never becomes executable PowerShell', () => {
  const payload = { windowId: 'x', message: '$(Remove-Item x); ` & 中文' };
  const argv = nativeArguments('C:\\with spaces & x\\windows.ps1', 'CaptureLink', payload);
  assert.deepEqual(argv.slice(0, 7), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'RemoteSigned', '-File', 'C:\\with spaces & x\\windows.ps1']);
  assert.deepEqual(JSON.parse(Buffer.from(argv.at(-1), 'base64').toString('utf8')), payload);
  assert.ok(!argv.includes(payload.message));
});
test('discovery prefers a validated explicit exe and does not execute a command string', async () => {
  const seen = [];
  const chosen = await discoverCli({ explicitPath: 'C:\\Program Files\\Codex & Co\\codex.exe', platform: 'win32', exists: async () => true, run: async (exe, argv, options) => { seen.push({ exe, argv, options }); return { stdout: 'codex-cli 0.164.0-alpha.11.1\n', exitCode: 0 }; } });
  assert.equal(chosen.version, '0.164.0-alpha.11.1');
  assert.deepEqual(seen[0].argv, ['--version']);
  await assert.rejects(discoverCli({ explicitPath: 'cmd.exe', platform: 'win32', exists: async () => true, run: async () => assert.fail('must not execute') }), /codex\.exe/);
});
test('bounded hidden helper timeout only terminates the owned process', async () => {
  let args; const child = fakeProcess(() => {});
  await assert.rejects(runHidden('helper.exe', ['argument with &'], { spawn: (...value) => { args = value; return child; }, timeoutMs: 15 }), /超时/);
  assert.equal(child.killed, true); assert.equal(args[2].shell, false); assert.equal(args[2].windowsHide, true);
});
test('late events from an old child cannot disconnect a newer RPC connection', async () => {
  const children = [];
  const client = new AppServerClient({ cliPath: 'codex.exe', timeoutMs: 100, spawn: () => { const child = fakeProcess((request, proc) => { if (request.method === 'initialize') reply(proc, request, {}); }); children.push(child); return child; } });
  await client.start(); const old = children[0];
  old.emit('error', new Error('lost')); await client.start(); const current = children[1];
  old.emit('exit', 0); old.stdout.write('old malformed data\n'); old.stdin.emit('error', new Error('old pipe'));
  assert.equal(client.isAlive, true); assert.equal(current.killed, false);
  await client.close();
});
test('concurrent start waits for the same initialize handshake', async () => {
  let initialize; const child = fakeProcess((request, proc) => { if (request.method === 'initialize') initialize = () => reply(proc, request, {}); });
  const client = new AppServerClient({ cliPath: 'codex.exe', spawn: () => child, timeoutMs: 100 });
  const first = client.start(); let secondDone = false; const second = client.start().then(() => { secondDone = true; });
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(secondDone, false);
  initialize(); await Promise.all([first, second]); await client.close();
});
test('a delayed write callback from a terminated child cannot kill its replacement', async () => {
  const children = []; let held;
  const client = new AppServerClient({ cliPath: 'codex.exe', timeoutMs: 100, spawn: () => {
    const child = fakeProcess((request, proc) => { if (request.method === 'initialize') reply(proc, request, {}); });
    if (!children.length) { const original = child.stdin.write.bind(child.stdin); child.stdin.write = (chunk, callback) => { const request = JSON.parse(chunk); if (request.method === 'initialize') { held = callback; reply(child, request, {}); return true; } return original(chunk, callback); }; }
    children.push(child); return child;
  } });
  await client.start(); children[0].emit('error', new Error('disconnected')); await client.start();
  held(new Error('old delayed write error'));
  assert.equal(client.isAlive, true); assert.equal(children[1].killed, false); await client.close();
});
test('Windows helper rebuilds its own PSModulePath without changing the parent environment', async () => {
  const inherited = { SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', psmodulepath: 'C:\\another-core-module-path', USERPROFILE: 'C:\\Users\\Example', CODEX_HOME: 'G:\\CodexHome', NORMAL_SETTING: 'preserved' };
  let received;
  await callNative('C:\\app\\windows.ps1', 'ListWindows', {}, { platform: 'win32', env: inherited, run: async (_exe, _argv, options) => { received = options.env; return { exitCode: 0, stdout: '{"ok":true,"windows":[]}' }; } });
  assert.ok(received, 'child environment must be explicitly bounded to the helper');
  assert.ok(!Object.keys(received).some(key => key.toLowerCase() === 'psmodulepath'));
  assert.equal(received.CODEX_HOME, inherited.CODEX_HOME); assert.equal(received.USERPROFILE, inherited.USERPROFILE); assert.equal(received.NORMAL_SETTING, 'preserved');
  assert.equal(inherited.PSModulePath, 'C:\\Program Files\\PowerShell\\7\\Modules');
  assert.equal(inherited.psmodulepath, 'C:\\another-core-module-path');
});
