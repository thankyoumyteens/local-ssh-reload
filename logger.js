'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, off: 4 };
const MAX_BYTES = 5 * 1024 * 1024;

function errorDetails(err) {
  return { name: err?.name, code: err?.code,
    message: err?.message ?? String(err), stack: err?.stack };
}

class Logger {
  constructor(output, defaultDir, io = fs) {
    this.output = output;
    this.defaultDir = defaultDir;
    this.io = io;
    this.session = randomUUID();
    this.queue = Promise.resolve();
    this.failed = false;
    this.level = 'debug';
  }

  configure(configuredPath, level) {
    this.level = Object.hasOwn(LEVELS, level) ? level : 'debug';
    const expanded = configuredPath.startsWith('~/')
      ? path.join(os.homedir(), configuredPath.slice(2)) : configuredPath;
    if (expanded && !path.isAbsolute(expanded)) {
      this.file = undefined;
      this.output.appendLine('ERROR log.path.invalid: logFilePath must be absolute or start with ~/; file logging disabled.');
      return;
    }
    this.file = expanded || path.join(this.defaultDir, 'local-ssh-reload.jsonl');
    this.failed = false;
    this.log('info', 'log.configured', { file: this.file, level: this.level });
  }

  log(level, event, details = {}) {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level,
      session: this.session, pid: process.pid, event, ...details });
    this.output.appendLine(line);
    const file = this.file;
    if (!file || this.failed) return;
    this.queue = this.queue.then(async () => {
      // Retry only after configuration changes, rather than producing an I/O error every tick.
      if (this.failed && file === this.file) return;
      await this.io.mkdir(path.dirname(file), { recursive: true });
      let size = 0;
      try { size = (await this.io.stat(file)).size; }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (size + Buffer.byteLength(line) + 1 > MAX_BYTES) {
        await this.io.rm(file + '.1', { force: true });
        try { await this.io.rename(file, file + '.1'); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
      await this.io.appendFile(file, line + '\n', { encoding: 'utf8', mode: 0o600 });
    }).catch(err => {
      if (file === this.file) this.failed = true;
      this.output.appendLine(JSON.stringify({ time: new Date().toISOString(), level: 'error',
        session: this.session, event: 'log.write.failed', file, error: errorDetails(err) }));
    });
  }

  async flush(timeoutMs = 1000) {
    let timer;
    try {
      await Promise.race([this.queue, new Promise(resolve => {
        timer = setTimeout(resolve, timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
}

module.exports = { Logger, errorDetails, MAX_BYTES };
