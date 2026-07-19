const TERMINAL_ERROR_PATTERNS = [
  /^\s*Error:\s*T:\s*\[[^\]]+\]/im,
  /\[(permission_denied|routing_unsupported|authentication_failed|resource_exhausted)\]/i,
  /Cursor Router .+ disabled for your team/i,
];

const TRANSIENT_CONNECTION_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /socket hang up/i,
];

/**
 * Reject terminal errors that Cursor returned as ordinary message chunks.
 * @author Amadeus
 */
function isTransientConnectionError(errOrText) {
  const text = String(errOrText?.message || errOrText || '');
  return TRANSIENT_CONNECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function isAgentAbortSummary(text) {
  const raw = String(text || '');
  return /Error:\s*T:\s*\[aborted\]/i.test(raw)
    || (/\[aborted\]/i.test(raw) && isTransientConnectionError(raw));
}

function isModelUnavailableError(errOrText) {
  const text = String(errOrText?.message || errOrText || '');
  return /\[unavailable\]/i.test(text);
}

function formatAgentTerminalError(text) {
  const raw = String(text || '').trim();
  if (isTransientConnectionError(raw) || isAgentAbortSummary(raw)) {
    return 'Agent 连接中断，请稍后重试';
  }
  return raw;
}

function assertAgentResultSucceeded(summary, { cancelled = false } = {}) {
  const text = String(summary || '');
  if (cancelled && isAgentAbortSummary(text)) {
    throw new Error('用户终止任务');
  }
  if (TERMINAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`Agent 执行失败: ${formatAgentTerminalError(text)}`);
  }
}

module.exports = {
  assertAgentResultSucceeded,
  formatAgentTerminalError,
  isAgentAbortSummary,
  isModelUnavailableError,
  isTransientConnectionError,
};
