const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDataDir } = require('./db');

/**
 * Lightweight JSONL logger for ACP agent process lifecycle.
 * Never throws — logging must not break task execution.
 * @author Amadeus
 */
const DEFAULT_LOG_PATH = path.join(DATA_DIR, 'acp.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function createAcpLogger({
  logPath = DEFAULT_LOG_PATH,
  maxBytes = MAX_LOG_BYTES,
  enabled = true,
} = {}) {
  function rotateIfNeeded() {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > maxBytes) {
        fs.renameSync(logPath, `${logPath}.1`);
      }
    } catch {
      // no existing log file, nothing to rotate
    }
  }

  function write(event, data = {}) {
    if (!enabled) return;
    try {
      ensureDataDir();
      rotateIfNeeded();
      const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
      fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    } catch {
      // swallow: diagnostics logging is best-effort
    }
  }

  return { write, logPath };
}

module.exports = {
  createAcpLogger,
  DEFAULT_LOG_PATH,
};
