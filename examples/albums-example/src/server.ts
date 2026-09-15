import type { IncomingMessage } from 'node:http';
import type { AuthInfo, ServerConfig } from 'sunpeak/mcp';

/**
 * Optional server entry point.
 *
 * Called on every MCP request. Return AuthInfo to authenticate, null to reject (401).
 * The returned AuthInfo is available as `extra.http?.authInfo` in tool handlers.
 */
export async function auth(req: IncomingMessage): Promise<AuthInfo | null> {
  const token = req.headers.authorization?.replace('Bearer ', '');
  // Allow unauthenticated requests (no token = anonymous access).
  // To require auth, return null here instead.
  return { token: token ?? '', clientId: 'anonymous', scopes: [] };
}

/**
 * Server identity sent in the MCP initialize response.
 * Hosts use this to display your app's name, description, and icon.
 *
 * Icons must be 64x64 PNG for ChatGPT compatibility. Use a data URI
 * to embed the icon inline (no external fetch required by the host):
 *
 *   icons: [{ src: 'data:image/png;base64,...', mimeType: 'image/png', sizes: ['64x64'] }]
 *
 * `instructions` is a server-wide hint hosts may inject into the model's
 * system prompt — useful for cross-tool workflows or constraints that
 * don't fit in any single tool's `description`.
 */
export const server: ServerConfig = {
  // name defaults to package.json "name" field when omitted
  version: '1.0.0',
  description: 'A sunpeak MCP app',
  // instructions: 'Always call get_user before update_user.',
  // icons: [{ src: 'data:image/png;base64,...', mimeType: 'image/png', sizes: ['64x64'] }],
};
