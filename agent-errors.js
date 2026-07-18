const TERMINAL_ERROR_PATTERNS = [
  /^\s*Error:\s*T:\s*\[[^\]]+\]/im,
  /\[(permission_denied|routing_unsupported|authentication_failed|resource_exhausted)\]/i,
  /Cursor Router .+ disabled for your team/i,
];

/**
 * Reject terminal errors that Cursor returned as ordinary message chunks.
 * @author Amadeus
 */
function assertAgentResultSucceeded(summary) {
  const text = String(summary || '');
  if (TERMINAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`Agent 执行失败: ${text.trim()}`);
  }
}

module.exports = {
  assertAgentResultSucceeded,
};
