'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Logger, MAX_BYTES, errorDetails } = require('../logger');

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-reload-log-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const output = [];
  return { dir, output, channel: { appendLine: line => output.push(line) } };
}

test('writes ordered JSONL to a custom path, creates parents, restricts new file permissions', async t => {
  const { dir, channel } = await setup(t);
  const file = path.join(dir, 'nested', 'custom.jsonl');
  const logger = new Logger(channel, dir);
  logger.configure(file, 'debug');
  for (let i = 0; i < 20; i++) logger.log('debug', 'probe', { i });
  await logger.flush();
  const records = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.slice(1).map(r => r.i), Array.from({ length: 20 }, (_, i) => i));
  assert.ok(records.every(r => r.time && r.session === logger.session && r.pid === process.pid));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('default directory, live path changes, and level filtering', async t => {
  const { dir, channel, output } = await setup(t);
  const logger = new Logger(channel, dir);
  logger.configure('', 'info');
  logger.log('debug', 'hidden');
  logger.log('warn', 'first');
  const second = path.join(dir, 'second.jsonl');
  logger.configure(second, 'error');
  logger.log('error', 'second', { error: errorDetails(new Error('diagnostic')) });
  await logger.flush();
  assert.match(await fs.readFile(path.join(dir, 'local-ssh-reload.jsonl'), 'utf8'), /first/);
  const secondText = await fs.readFile(second, 'utf8');
  assert.match(secondText, /diagnostic/);
  assert.doesNotMatch(secondText, /first/);
  assert.ok(output.every(line => !line.includes('hidden')));
  logger.configure('', 'off');
  const before = output.length;
  logger.log('error', 'off');
  assert.equal(output.length, before);
});

test('unwritable target falls back to Output and can recover after reconfiguration', async t => {
  const { dir, channel, output } = await setup(t);
  const logger = new Logger(channel, dir);
  logger.configure(dir, 'debug'); // A directory cannot be appended to as a file.
  logger.log('info', 'still running');
  await logger.flush();
  assert.ok(output.some(line => line.includes('log.write.failed')));
  logger.configure(path.join(dir, 'recovered.jsonl'), 'debug');
  logger.log('info', 'recovered');
  await logger.flush();
  assert.match(await fs.readFile(logger.file, 'utf8'), /recovered/);
});

test('relative paths are rejected; ~/ is expanded', async t => {
  const { dir, channel, output } = await setup(t);
  const logger = new Logger(channel, dir, {
    mkdir: async () => {}, stat: async () => ({ size: 0 }), appendFile: async () => {}
  });
  logger.configure('relative/log.jsonl', 'debug');
  assert.equal(logger.file, undefined);
  assert.ok(output.some(line => line.includes('log.path.invalid')));
  logger.configure('~/my-log.jsonl', 'debug');
  assert.equal(logger.file, path.join(os.homedir(), 'my-log.jsonl'));
  await logger.flush();
});

test('size cap rotates into .1 without dropping the new record', async t => {
  const { dir, channel } = await setup(t);
  const file = path.join(dir, 'rotate.jsonl');
  await fs.writeFile(file, 'x'.repeat(MAX_BYTES));
  const logger = new Logger(channel, dir);
  logger.configure(file, 'debug');
  logger.log('info', 'after rotation');
  await logger.flush();
  assert.equal((await fs.stat(file + '.1')).size, MAX_BYTES);
  assert.match(await fs.readFile(file, 'utf8'), /after rotation/);
});

test('flush is bounded even when file I/O stalls', async t => {
  const { dir, channel } = await setup(t);
  const logger = new Logger(channel, dir, { mkdir: () => new Promise(() => {}) });
  logger.configure('', 'debug');
  await logger.flush(10);
});
