'use strict';

const vscode = require('vscode');
const { recentAttempts, decide } = require('./policy');
const { Logger, errorDetails } = require('./logger');
let activeLogger;

function activate(context) {
  const log = vscode.window.createOutputChannel('Local SSH Reload');
  context.subscriptions.push(log);
  const logger = new Logger(log, context.logUri.fsPath);
  activeLogger = logger;
  function configureLog() {
    const config = vscode.workspace.getConfiguration('localSshReload');
    logger.configure(config.get('logFilePath', ''), config.get('logLevel', 'debug'));
  }
  configureLog();
  logger.log('info', 'activation', { version: context.extension?.packageJSON.version,
    vscodeVersion: vscode.version, remoteName: vscode.env.remoteName,
    dialogStyle: vscode.workspace.getConfiguration('window').get('dialogStyle') });
  if (vscode.env.remoteName !== 'ssh-remote') {
    logger.log('info', 'activation.skipped', { reason: 'not an SSH window' });
    return;
  }

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  status.command = 'localSshReload.showLog';
  context.subscriptions.push(status);
  let paused = false;
  let disposed = false;
  let epoch = 0;
  let failures = 0;
  let busy = false;
  let pending;
  let timer;
  let lastMessage;
  let probeId = 0;
  let tickId = 0;
  let targetKey;
  const debuggers = new Set();
  if (vscode.debug.activeDebugSession) debuggers.add(vscode.debug.activeDebugSession.id);
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession(s => { debuggers.add(s.id); logger.log('info', 'debug.started', { id: s.id }); }),
    vscode.debug.onDidTerminateDebugSession(s => { debuggers.delete(s.id); logger.log('info', 'debug.ended', { id: s.id }); })
  );

  function note(message, visible = true) {
    if (message !== lastMessage) logger.log('info', 'state.changed', { message, failures });
    lastMessage = message;
    status.text = '$(sync) SSH Reload';
    status.tooltip = message;
    visible ? status.show() : status.hide();
  }

  function enabled() {
    return vscode.workspace.getConfiguration('localSshReload').get('enabled', true);
  }

  function target() {
    const folder = vscode.workspace.workspaceFolders?.find(f =>
      f.uri.scheme === 'vscode-remote' && f.uri.authority.startsWith('ssh-remote+'));
    const file = vscode.workspace.workspaceFile;
    return folder?.uri ?? (file?.scheme === 'vscode-remote' &&
      file.authority.startsWith('ssh-remote+') ? file : undefined);
  }

  function dirty() {
    return vscode.workspace.textDocuments.some(d => d.isDirty) ||
      vscode.window.tabGroups.all.some(g => g.tabs.some(t => t.isDirty));
  }

  // Keep at most one stat outstanding: VS Code's filesystem API cannot cancel it.
  async function health(uri) {
    const reused = pending !== undefined;
    if (!pending) {
      const id = ++probeId;
      const started = Date.now();
      logger.log('debug', 'probe.started', { id, uri: uri.toString() });
      const probe = Promise.resolve().then(() => vscode.workspace.fs.stat(uri)).then(
        () => {
          logger.log('debug', 'probe.succeeded', { id, durationMs: Date.now() - started });
          return 'healthy';
        },
        err => {
          const result = ['Unavailable', 'Unknown'].includes(err?.code) ? 'failed' : 'unknown';
          logger.log('warn', 'probe.rejected', { id, durationMs: Date.now() - started, result, error: errorDetails(err) });
          return result;
        }
      );
      pending = probe;
      void probe.finally(() => { if (pending === probe) pending = undefined; });
    }
    const awaitingId = probeId;
    logger.log('debug', 'probe.awaiting', { reused, probeId: awaitingId });
    let timeout;
    try {
      return await Promise.race([
        pending,
        new Promise(resolve => { timeout = setTimeout(() => {
          logger.log('warn', 'probe.timeout', { probeId: awaitingId, timeoutMs: 10000 });
          resolve('unknown');
        }, 10000); })
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function tick() {
    if (busy || disposed) return;
    busy = true;
    const token = epoch;
    const id = ++tickId;
    const started = Date.now();
    logger.log('debug', 'tick.started', { id, epoch, paused, enabled: enabled(), failures });
    try {
      if (paused || !enabled()) { note('Paused'); return; }
      const uri = target();
      if (!uri) { note('Waiting for a remote folder'); return; }
      if (uri.toString() !== targetKey) {
        targetKey = uri.toString();
        logger.log('info', 'target.changed', { uri: targetKey });
        failures = 0;
        // An older folder's pending result must not describe this one.
        pending = undefined;
      }
      const result = await health(uri);
      if (disposed || paused || token !== epoch || !enabled()) {
        logger.log('debug', 'tick.discarded', { id, disposed, paused, epoch, token });
        return;
      }
      logger.log('debug', 'health.result', { id, result, failures });
      if (result !== 'failed') {
        failures = 0;
        note(result === 'healthy' ? 'Connected' : 'Connection status inconclusive; waiting', result !== 'healthy');
        return;
      }
      failures++;
      const now = Date.now();
      const attempts = recentAttempts(context.workspaceState.get('reloadAttempts'), now);
      const decision = { failures, dirty: dirty(), debugging: debuggers.size > 0, attempts, now };
      const reason = decide(decision);
      logger.log('debug', 'reload.decision', { id, ...decision, reason });
      if (reason !== 'reload') { note(`Disconnected: ${reason}`); return; }
      // Persist before reload so a new extension host cannot reset the retry cap.
      logger.log('info', 'reload.recording', { id, attempt: attempts.length + 1 });
      await context.workspaceState.update('reloadAttempts', [...attempts, now]);
      if (disposed || paused || token !== epoch || !enabled() || dirty() || debuggers.size) {
        logger.log('info', 'reload.cancelled', { id, disposed, paused, epoch, token, dirty: dirty(), debugSessions: debuggers.size });
        return;
      }
      note('Reloading window');
      logger.log('info', 'reload.executing', { id });
      await logger.flush();
      // State can change while the file log is being flushed.
      if (disposed || paused || token !== epoch || !enabled() || dirty() || debuggers.size) {
        logger.log('info', 'reload.cancelled', { id, reason: 'state changed during log flush' });
        return;
      }
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } catch (err) {
      logger.log('error', 'tick.error', { id, error: errorDetails(err) });
      note(`Check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      logger.log('debug', 'tick.finished', { id, durationMs: Date.now() - started, nextCheckMs: disposed ? null : 5000 });
      busy = false;
      if (!disposed) timer = setTimeout(tick, 5000);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('localSshReload.showLog', () => log.show()),
    vscode.commands.registerCommand('localSshReload.pause', () => {
      logger.log('info', 'command.pause');
      paused = true; epoch++; failures = 0; note('Paused');
    }),
    vscode.commands.registerCommand('localSshReload.resume', () => {
      logger.log('info', 'command.resume');
      paused = false; epoch++; failures = 0; note('Watching connection');
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('localSshReload')) return;
      if (e.affectsConfiguration('localSshReload.logFilePath') || e.affectsConfiguration('localSshReload.logLevel')) configureLog();
      logger.log('info', 'configuration.changed', { enabled: enabled() });
      if (e.affectsConfiguration('localSshReload.enabled')) { epoch++; failures = 0; }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { epoch++; failures = 0; logger.log('info', 'workspace.changed'); }),
    { dispose() { disposed = true; epoch++; clearTimeout(timer); logger.log('info', 'deactivation'); void logger.flush(); } }
  );
  async function ensureCustomDialogs() {
    if (!enabled()) {
      logger.log('debug', 'dialog.setup.skipped', { reason: 'extension disabled' });
      return;
    }
    try {
      const config = vscode.workspace.getConfiguration('window');
      const previous = config.get('dialogStyle');
      if (previous === 'custom') {
        logger.log('debug', 'dialog.setup.unchanged', { value: previous });
        return;
      }
      // Global writes the local user's settings because this is a UI extension.
      // Do not modify workspace or remote settings, or force a reload here.
      logger.log('info', 'dialog.setup.updating', { previous, value: 'custom', target: 'Global' });
      await config.update('dialogStyle', 'custom', vscode.ConfigurationTarget.Global);
      const effective = vscode.workspace.getConfiguration('window').get('dialogStyle');
      logger.log(effective === 'custom' ? 'info' : 'warn', 'dialog.setup.updated', {
        previous, value: 'custom', effective, target: 'Global'
      });
    } catch (err) {
      logger.log('error', 'dialog.setup.failed', { error: errorDetails(err) });
      void vscode.window.showWarningMessage(
        'Local SSH Reload: Could not set window.dialogStyle to custom. ' +
        'Set it manually in local User Settings; automatic reconnect remains enabled.'
      );
    }
  }
  // Configuration writes must never block the connection watcher.
  void ensureCustomDialogs();
  void tick();
}

// VS Code awaits a returned deactivation promise, within its shutdown deadline.
function deactivate() { return activeLogger?.flush(); }
module.exports = { activate, deactivate };
