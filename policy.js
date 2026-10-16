'use strict';

const WINDOW_MS = 15 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_RELOADS = 3;
const FAILURE_THRESHOLD = 3;

function recentAttempts(value, now) {
  return Array.isArray(value)
    ? value.filter(t => Number.isFinite(t) && t > now - WINDOW_MS && t <= now)
    : [];
}

function decide({ failures, dirty, debugging, attempts, now }) {
  if (failures < FAILURE_THRESHOLD) return 'wait';
  if (dirty) return 'unsaved changes';
  if (debugging) return 'active debug session';
  const recent = recentAttempts(attempts, now);
  if (recent.length >= MAX_RELOADS) return 'reload limit reached';
  if (recent.some(t => now - t < COOLDOWN_MS)) return 'cooldown';
  return 'reload';
}

module.exports = { recentAttempts, decide };
