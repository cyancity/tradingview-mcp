/**
 * Shared MCP response formatting helpers.
 * All tool definitions use these instead of manually constructing MCP responses.
 */

// Compact JSON by default (saves ~10-15% output tokens on large payloads like OHLCV).
// Set TV_MCP_PRETTY=1 for human-readable output while debugging.
const PRETTY = /^(1|true|yes)$/i.test(process.env.TV_MCP_PRETTY ?? '');

export function jsonResult(obj, isError = false) {
  return {
    content: [{ type: 'text', text: PRETTY ? JSON.stringify(obj, null, 2) : JSON.stringify(obj) }],
    ...(isError && { isError: true }),
  };
}

/**
 * Wrap a raw handler (args -> data) into an MCP tool handler with uniform
 * error handling. Single choke point for every tool result.
 */
export function wrap(fn, { hint } = {}) {
  return async (args) => {
    try {
      return jsonResult(await fn(args ?? {}));
    } catch (err) {
      return jsonResult({ success: false, error: err.message, ...(hint && { hint }) }, true);
    }
  };
}
