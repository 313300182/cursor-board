const TERMINAL_ERROR_PATTERNS = [
  /^\s*Error:\s*T:\s*\[[^\]]+\]/im,
  /\[(permission_denied|routing_unsupported|authentication_failed|resource_exhausted)\]/i,
  /Cursor Router .+ disabled for your team/i,
  // Cursor SDK 把连接类错误作为普通消息块返回，格式为 Error: RetriableError: xxx，
  // 重试仍失败时必须识别为失败，否则会被误判为"已完成"。
  /^\s*Error:\s*RetriableError:/im,
];

const TRANSIENT_CONNECTION_PATTERNS = [
  /ECONNRESET/i,
  /ECONNREFUSED/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /socket hang up/i,
  // RetriableError（如 Connection stalled）属于可重试连接错误，先重试再判失败。
  /RetriableError:/i,
  /Connection stalled/i,
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
  const parts = [];
  if (errOrText && typeof errOrText === 'object') {
    if (errOrText.message) parts.push(String(errOrText.message));
    if (errOrText.data && errOrText.data.message) parts.push(String(errOrText.data.message));
  }
  const text = parts.length ? parts.join(' ') : String(errOrText || '');
  return /\[unavailable\]/i.test(text) || /invalid\s+model\s+value/i.test(text);
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
