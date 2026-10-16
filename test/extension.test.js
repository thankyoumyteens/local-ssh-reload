'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness({ code = 'Unavailable', dirty = false, attempts = [], hang = false } = {}) {
  const jobs = [];
  const commands = new Map();
  const calls = [];
  const records = [];
  const subscriptions = [];
  let probes = 0;
  let release;
  const uri = { scheme: 'vscode-remote', authority: 'ssh-remote+test', toString: () => 'test-uri' };
  const noop = () => {};
  const disposable = () => ({ dispose: noop });
  const vscode = {
    env: { remoteName: 'ssh-remote' }, StatusBarAlignment: { Left: 1 },
    window: {
      createOutputChannel: () => ({ appendLine: noop, show: noop, dispose: noop }),
      createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop }),
      tabGroups: { all: [] }
    },
    workspace: {
      workspaceFolders: [{ uri }], textDocuments: [{ isDirty: dirty }],
      getConfiguration: () => ({ get: (_key, value) => value }),
      onDidChangeConfiguration: disposable, onDidChangeWorkspaceFolders: disposable,
      fs: { stat: () => {
        probes++;
        if (hang) return new Promise(resolve => { release = resolve; });
        return code ? Promise.reject({ code }) : Promise.resolve({});
      } }
    },
    debug: { onDidStartDebugSession: disposable, onDidTerminateDebugSession: disposable },
    commands: {
      registerCommand: (name, fn) => { commands.set(name, fn); return disposable(); },
      executeCommand: async name => { calls.push(name); }
    }
  };
  const context = { subscriptions, logUri: { fsPath: '/unused/test-logs' }, workspaceState: {
    get: () => attempts,
    update: async (_key, value) => { attempts = value; }
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8'), {
    module, require: name => {
      if (name === 'vscode') return vscode;
      if (name === './logger') return {
        errorDetails: require('../logger').errorDetails,
        Logger: class {
          configure() {}
          log(level, event, details) { records.push({ level, event, ...details }); }
          async flush() {}
        }
      };
      return require('../policy');
    },
    setTimeout: (fn, ms) => { const job = { fn, ms }; jobs.push(job); return job; },
    clearTimeout: job => { const i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1); },
    Date, Promise
  });
  module.exports.activate(context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    calls, commands, settle, records,
    get probes() { return probes; },
    get attempts() { return attempts; },
    release: () => release?.({}),
    async next(ms = 5000) {
      await settle();
      const i = jobs.findIndex(job => job.ms === ms);
      assert.ok(i >= 0, `no ${ms}ms timer`);
      const [job] = jobs.splice(i, 1);
      job.fn();
      await settle();
    },
    dispose() { subscriptions.forEach(s => s.dispose()); }
  };
}

test('failed connection reloads once and persists limit before command', async () => {
  const h = harness();
  await h.next(); await h.next();
  assert.deepEqual(h.calls, ['workbench.action.reloadWindow']);
  assert.equal(h.attempts.length, 1);
  assert.ok(h.records.some(r => r.event === 'probe.rejected' && r.error.code === 'Unavailable'));
  assert.ok(h.records.some(r => r.event === 'reload.decision' && r.reason === 'reload'));
  assert.ok(h.records.some(r => r.event === 'reload.executing'));
  await h.next();
  assert.equal(h.calls.length, 1);
  h.dispose();
});
test('dirty editors, healthy connection and unrelated errors never reload', async () => {
  for (const options of [{ dirty: true }, { code: null }, { code: 'NoPermissions' }]) {
    const h = harness(options);
    await h.next(); await h.next(); await h.next();
    assert.deepEqual(h.calls, []);
    h.dispose();
  }
});
test('pause prevents recovery actions', async () => {
  const h = harness();
  await h.settle();
  h.commands.get('localSshReload.pause')();
  await h.next(); await h.next();
  assert.deepEqual(h.calls, []);
  h.dispose();
});
test('hung probe is inconclusive, never multiplied or used after pause', async () => {
  const h = harness({ hang: true });
  await h.next(10000);
  await h.next();
  await h.next(10000);
  assert.equal(h.probes, 1);
  assert.ok(h.records.some(r => r.event === 'probe.timeout'));
  h.commands.get('localSshReload.pause')();
  h.release();
  await h.settle();
  assert.deepEqual(h.calls, []);
  h.dispose();
});
test('three persisted recent attempts prevent reload after activation', async () => {
  const now = Date.now();
  const h = harness({ attempts: [now - 180000, now - 120000, now - 61000] });
  await h.next(); await h.next();
  assert.deepEqual(h.calls, []);
  h.dispose();
});
