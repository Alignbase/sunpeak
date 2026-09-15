import type { Resource } from '@modelcontextprotocol/client';
import type { McpUiResourceMeta } from '@modelcontextprotocol/ext-apps';
import type { DomainConfig } from '../mcp/resolve-domain.js';

/**
 * Configuration for an MCP App resource, exported from resource .tsx files.
 *
 * Composes the official MCP SDK `Resource` type (without `uri` and `name`,
 * which are derived from the directory name at discovery time).
 *
 * `name` is optional — when omitted, it's derived from the directory name
 * (e.g., `src/resources/albums/albums.tsx` → `'albums'`).
 */
export type ResourceConfig = Omit<Resource, 'uri' | 'name'> & {
  name?: string;
  title?: string;
  _meta?: {
    ui?: Omit<McpUiResourceMeta, 'domain'> & {
      /**
       * Dedicated sandbox origin for this resource.
       *
       * Can be a single string (used for all hosts) or a map of
       * `clientInfo.name` → domain string for host-specific values.
       * Use `'default'` as a fallback key for unmatched hosts.
       *
       * @example
       * ```ts
       * domain: {
       *   claude: computeClaudeDomain('https://my-server.com/mcp'),
       *   'openai-mcp': computeChatGPTDomain('https://my-server.com/mcp'),
       *   default: 'fallback.example.com',
       * }
       * ```
       */
      domain?: DomainConfig;
    };
    [key: string]: unknown;
  };
};
