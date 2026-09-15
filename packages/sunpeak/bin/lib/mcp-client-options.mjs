/**
 * MCP SDK 2 defaults to the legacy 2025 handshake. Auto negotiation probes
 * modern servers first and falls back to that legacy handshake when needed.
 */
const STDIO_PROBE_TIMEOUT_MS = 3_000;

/** @param {string} serverArg */
export function getMcpClientOptions(serverArg) {
  const isHttp = serverArg.startsWith('http://') || serverArg.startsWith('https://');
  return {
    versionNegotiation: {
      mode: 'auto',
      ...(isHttp ? {} : { probe: { timeoutMs: STDIO_PROBE_TIMEOUT_MS } }),
    },
  };
}
