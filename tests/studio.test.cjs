const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

async function studio(t, response = 'Offline test response.') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gravbot-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const executable = path.join(temp, 'fake-agy');
  fs.writeFileSync(executable, 'mock');
  const calls = [], handlers = new Map();
  let ready, requestHandler;
  class Window {
    constructor() { this.webContents = { on() {}, once() {}, send() {} }; }
    on() {} loadFile() {} isDestroyed() { return false; } isMaximized() { return false; }
  }
  const electron = {
    app: { setName() {}, requestSingleInstanceLock: () => true, getPath: () => temp,
      on() {}, whenReady: () => ({ then(fn) { ready = Promise.resolve().then(fn); return ready; } }) },
    BrowserWindow: Window, ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    shell: {}, nativeImage: {}, Menu: {}, systemPreferences: {}, dialog: {}, screen: {}
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return electron;
      if (name === 'child_process') return { execFile(bin, args, options, cb) {
        calls.push({ bin, args, options });
        queueMicrotask(() => cb(null, response, ''));
        return { stdin: { end() {} } };
      }};
      if (name === 'http') return { createServer(fn) { requestHandler = fn; return { on() {}, listen() {} }; } };
      return require(name);
    },
    __dirname: root, console, Buffer, URL, queueMicrotask,
    process: { argv: [], platform: 'test', env: { GRAV_BOT_DATA_DIR: path.join(temp, 'data'), GRAV_BOT_AGY_PATH: executable }, exit() { throw Error('Unexpected exit'); } },
    setTimeout() { return 0; }, clearTimeout() {}, module: { exports: {} }
  });
  const code = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  vm.runInContext(code + '\nmodule.exports = { resolveVirtualOrWorkspaceFile, runAntigravityCli, get settings() { return appSettings; }, get workspace() { return WORKSPACE_DIR; } };', context);
  await ready;
  return { api: context.module.exports, calls, handlers, temp, requestHandler };
}

test('startup seeds 21 empty seats and makes zero model calls', async t => {
  const s = await studio(t);
  const initial = await s.handlers.get('gb:get-initial-state')();
  assert.equal(initial.appState.roster.length, 21);
  assert.ok(Object.values(initial.appState.transcripts).every(entries => entries.length === 0));
  assert.equal(s.calls.length, 0);
  assert.equal(s.api.settings.skipPermissions, false);
  assert.equal(s.api.settings.autoRoute, false);
  assert.equal(s.api.settings.autoResume, false);
  assert.ok(initial.workspaceDir.startsWith(s.temp));
});

test('workspace resolution rejects traversal, external absolute paths, and symlink escape', async t => {
  const s = await studio(t);
  const file = path.join(s.api.workspace, 'example.md');
  fs.writeFileSync(file, 'example');
  const outside = path.join(s.temp, 'outside.md');
  fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(s.api.workspace, 'link.md'));
  assert.equal(s.api.resolveVirtualOrWorkspaceFile('example.md').full, fs.realpathSync(file));
  for (const p of [outside, '../outside.md', 'link.md', '@dropped/../../outside.md']) {
    assert.equal(s.api.resolveVirtualOrWorkspaceFile(p).full, '');
  }
});

test('sending uses sandboxed plan mode and records handoff without automatically executing it', async t => {
  const s = await studio(t, 'Done.\n```route\n{"toAgentName":"Architect","content":"Review this."}\n```');
  const initial = await s.handlers.get('gb:get-initial-state')();
  const result = await s.handlers.get('gb:send-message')(null, { agentId: initial.appState.primaryBotId, content: 'Test this draft.' });
  assert.equal(result.ok, true);
  assert.equal(s.calls.length, 1);
  assert.ok(s.calls[0].args.includes('--sandbox'));
  assert.ok(s.calls[0].args.includes('--mode=plan'));
  assert.ok(!s.calls[0].args.includes('--dangerously-skip-permissions'));
  const architect = initial.appState.roster.find(row => row.name === 'Architect');
  assert.equal(initial.appState.transcripts[architect.id].length, 1);
  assert.match(initial.appState.transcripts[architect.id][0].content, /Review this/);
});

test('HTTP interface cannot send model requests and rejects foreign origins', async t => {
  const s = await studio(t);
  function request(method, url, headers) {
    let code, body;
    const response = { setHeader() {}, writeHead(n) { code = n; }, end(value) { body = value; } };
    return s.requestHandler({ method, url, headers }, response).then(() => ({ code, body }));
  }
  assert.equal((await request('POST', '/api/send', { host: '127.0.0.1:61558' })).code, 403);
  assert.equal((await request('GET', '/health', { host: '127.0.0.1:61558', origin: 'https://example.com' })).code, 403);
  assert.equal((await request('GET', '/health', { host: 'attacker.example:61558' })).code, 403);
  assert.equal((await request('GET', '/workspace/%ZZ', { host: '127.0.0.1:61558' })).code, 400);
  assert.equal((await request('GET', '/roster', { host: '127.0.0.1:61558' })).code, 404);
  assert.equal(s.calls.length, 0);
});

test('public avatars render original SVG and reject injected color markup', async () => {
  const avatar = await import('../renderer/avatar-engine.mjs');
  const svg = avatar.renderSvgString({ body: 'hex' }, { color: '" onload="alert(1)' }, 36);
  assert.match(svg, /<svg/);
  assert.ok(!svg.includes('onload'));
  assert.match(svg, /#8d9eff/);
});
