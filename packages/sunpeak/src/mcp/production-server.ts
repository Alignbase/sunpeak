import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import { FAVICON_BUFFER, FAVICON_DATA_URI } from './favicon.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { injectResolvedDomain, injectDefaultDomain } from './resolve-domain.js';

import type { AuthInfo, CallToolResult, ServerConfig, ToolHandlerExtra } from './types.js';

// ============================================================================
// Structured logging
// ============================================================================

let jsonLogging = false;

/**
 * Enable or disable structured JSON logging.
 *
 * When enabled, all server log messages are written as JSON lines to stdout/stderr,
 * making them easy to parse with log aggregation tools (Datadog, CloudWatch,
 * Loki, etc.).
 */
export function setJsonLogging(enabled: boolean): void {
  jsonLogging = enabled;
}

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>): void {
  if (jsonLogging) {
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...extra,
    };
    const line = JSON.stringify(entry) + '\n';
    if (level === 'error') {
      process.stderr.write(line);
    } else {
      process.stdout.write(line);
    }
  } else {
    const prefix = '[MCP]';
    if (level === 'error') {
      console.error(extra ? `${prefix} ${msg} ${JSON.stringify(extra)}` : `${prefix} ${msg}`);
    } else if (level === 'warn') {
      console.warn(extra ? `${prefix} ${msg} ${JSON.stringify(extra)}` : `${prefix} ${msg}`);
    } else {
      console.log(extra ? `${prefix} ${msg} ${JSON.stringify(extra)}` : `${prefix} ${msg}`);
    }
  }
}

// ============================================================================
// Public types
// ============================================================================

/**
 * A tool loaded from a compiled tool module (`dist/tools/*.js`).
 */
export interface ProductionTool {
  /** Tool name (derived from filename, e.g. 'show-albums') */
  name: string;
  /** Tool config from the `tool` export */
  tool: {
    resource?: string;
    title?: string;
    description?: string;
    annotations?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
  /** Zod shape from the `schema` export (passed to SDK as inputSchema) */
  schema?: Record<string, unknown>;
  /** Zod shape from the `outputSchema` export (passed to SDK as outputSchema) */
  outputSchema?: Record<string, unknown>;
  /** Handler from the `default` export */
  handler: (
    args: Record<string, unknown>,
    extra: ToolHandlerExtra
  ) => CallToolResult | Promise<CallToolResult> | string | Promise<string>;
}

/**
 * A resource loaded from the build output (`dist/{name}/{name}.html` + `.json`).
 */
export interface ProductionResource {
  /** Resource name (from .json metadata) */
  name: string;
  /** Resource URI (from .json metadata, includes cache-bust timestamp) */
  uri: string;
  /** Pre-built HTML content (self-contained, JS+CSS inlined) */
  html: string;
  /** Resource _meta (CSP, permissions, domain, etc.) */
  _meta?: Record<string, unknown>;
  /** Resource description */
  description?: string;
}

/**
 * OAuth 2.0 Protected Resource Metadata served by the MCP resource server.
 *
 * `resource` defaults to `serverUrl`. Standard extension fields can be supplied
 * through `additionalMetadata` without waiting for a sunpeak release.
 */
export interface OAuthProtectedResourceConfig {
  /** Authorization server issuer URLs that can issue tokens for this resource. */
  authorizationServers: string[];
  /** Canonical resource identifier. Defaults to `serverUrl`. */
  resource?: string;
  /** Scopes understood by this MCP server. */
  scopesSupported?: string[];
  /** Human-readable resource name. */
  resourceName?: string;
  /** Documentation URL for this resource server. */
  resourceDocumentation?: string;
  /** Supported bearer-token presentation methods. Defaults to `['header']`. */
  bearerMethodsSupported?: string[];
  /** Additional RFC 9728 or extension metadata fields. */
  additionalMetadata?: Record<string, unknown>;
}

/** Standard protected-resource metadata document shape. */
export interface OAuthProtectedResourceMetadata extends Record<string, unknown> {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  resource_name?: string;
  resource_documentation?: string;
  bearer_methods_supported?: string[];
}

/** Optional details for an OAuth bearer challenge. */
export interface OAuthChallengeOptions {
  error?: 'invalid_request' | 'invalid_token' | 'insufficient_scope' | string;
  errorDescription?: string;
  scopes?: string[];
}

/** A structured auth rejection used for invalid tokens and scope upgrades. */
export interface AuthorizationFailure extends OAuthChallengeOptions {
  authorized: false;
  /** Defaults by error: invalid_request=400, insufficient_scope=403, otherwise 401. */
  status?: 400 | 401 | 403;
}

/** Parsed request context supplied to auth functions. */
export interface AuthorizationContext {
  /** Parsed JSON request body for MCP POST requests. */
  body?: unknown;
}

/**
 * Auth function signature for `src/server.ts` (Node.js).
 * Return AuthInfo to authenticate, null for an initial 401, or a structured failure.
 */
export type AuthFunction = (
  req: IncomingMessage,
  context: AuthorizationContext
) => Promise<AuthInfo | AuthorizationFailure | null> | AuthInfo | AuthorizationFailure | null;

/** Auth function signature for Web Standard handlers. */
export type WebAuthFunction = (
  req: Request,
  context: AuthorizationContext
) => Promise<AuthInfo | AuthorizationFailure | null> | AuthInfo | AuthorizationFailure | null;

/**
 * Configuration for creating a production MCP server and Node.js handler.
 */
export interface ProductionServerConfig {
  /** Server name reported to hosts */
  name?: string;
  /** Server version reported to hosts */
  version?: string;
  /** Full server identity (overrides name/version when provided). */
  serverInfo?: ServerConfig;
  /** Tool registrations with real handlers */
  tools: ProductionTool[];
  /** Resource registrations with pre-built HTML */
  resources: ProductionResource[];
  /** Auth function from server entry (populates extra.authInfo via req.auth) */
  auth?: AuthFunction;
  /** OAuth protected-resource discovery and bearer challenge configuration. */
  oauth?: OAuthProtectedResourceConfig;
  /**
   * Public URL of the MCP server (e.g. `'https://example.com/mcp'`).
   * Used to auto-compute a default `_meta.ui.domain` for resources that
   * don't specify one. Without this, resources without an explicit domain
   * may trigger host warnings (e.g. ChatGPT's "Widget domain is not set").
   */
  serverUrl?: string;
  /**
   * Respond with JSON instead of SSE streams.
   * Recommended for serverless environments (Lambda, Workers, Vercel Edge)
   * where holding open SSE connections is unreliable. Defaults to `true`.
   */
  enableJsonResponse?: boolean;
  /**
   * Interval in milliseconds between SSE keep-alive comments.
   * Only applies when `enableJsonResponse` is `false`. Defaults to the MCP SDK
   * transport default (15000ms). Values below 1 disable keep-alives.
   */
  sseKeepAliveMs?: number;
  /**
   * Enable stateless mode for serverless and horizontally-scaled deployments.
   *
   * When `true`, every request creates a fresh MCP server instance with no
   * session tracking. This means:
   * - No in-memory session map (works across Lambda invocations, multiple instances)
   * - No `mcp-session-id` validation (requests aren't tied to a specific instance)
   * - The MCP SDK's stateless transport is used (`sessionIdGenerator: undefined`)
   */
  stateless?: boolean;
}

/**
 * Configuration for creating a Web Standard MCP handler (serverless/edge).
 */
export interface WebHandlerConfig {
  /** Server name reported to hosts */
  name?: string;
  /** Server version reported to hosts */
  version?: string;
  /** Full server identity (overrides name/version when provided). */
  serverInfo?: ServerConfig;
  /** Tool registrations with real handlers */
  tools: ProductionTool[];
  /** Resource registrations with pre-built HTML */
  resources: ProductionResource[];
  /** Auth function for Web Standard Request objects */
  auth?: WebAuthFunction;
  /** OAuth protected-resource discovery and bearer challenge configuration. */
  oauth?: OAuthProtectedResourceConfig;
  /**
   * Public URL of the MCP server (e.g. `'https://example.com/mcp'`).
   * Used to auto-compute a default `_meta.ui.domain` for resources that
   * don't specify one. Without this, resources without an explicit domain
   * may trigger host warnings (e.g. ChatGPT's "Widget domain is not set").
   */
  serverUrl?: string;
  /**
   * Respond with JSON instead of SSE streams.
   * Recommended for serverless environments (Lambda, Workers, Vercel Edge)
   * where holding open SSE connections is unreliable. Defaults to `true`.
   */
  enableJsonResponse?: boolean;
  /**
   * Interval in milliseconds between SSE keep-alive comments.
   * Only applies when `enableJsonResponse` is `false`. Defaults to the MCP SDK
   * transport default (15000ms). Values below 1 disable keep-alives.
   */
  sseKeepAliveMs?: number;
  /**
   * Enable stateless mode for serverless and horizontally-scaled deployments.
   *
   * When `true`, every request creates a fresh MCP server instance with no
   * session tracking. This means:
   * - No in-memory session map (works across Lambda invocations, multiple instances)
   * - No `mcp-session-id` validation (requests aren't tied to a specific instance)
   * - The MCP SDK's stateless transport is used (`sessionIdGenerator: undefined`)
   */
  stateless?: boolean;
}

/**
 * Internal config extension — handlers pass detected client name to the server factory.
 * Not part of the public API.
 */
interface InternalServerConfig extends ProductionServerConfig {
  /** Detected client name from HTTP headers (e.g. 'openai-mcp', 'claude') */
  _clientName?: string;
}

/** Build an InternalServerConfig from any handler config + detected client name. */
function toInternalConfig(
  config: ProductionServerConfig | WebHandlerConfig,
  clientName: string | undefined
): InternalServerConfig {
  return {
    name: config.name,
    version: config.version,
    serverInfo: config.serverInfo,
    tools: config.tools,
    resources: config.resources,
    serverUrl: config.serverUrl,
    oauth: config.oauth,
    enableJsonResponse: config.enableJsonResponse,
    sseKeepAliveMs: config.sseKeepAliveMs,
    stateless: config.stateless,
    _clientName: clientName,
  };
}

function assertAbsoluteHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }
  if (url.hash) {
    throw new Error(`${label} must not contain a fragment`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol === 'http:' && !isLoopback) {
    throw new Error(`${label} must use https unless it is on localhost`);
  }
  return url;
}

/** Build the RFC 9728 metadata document for an MCP resource server. */
export function createOAuthProtectedResourceMetadata(
  config: OAuthProtectedResourceConfig,
  serverUrl?: string
): OAuthProtectedResourceMetadata {
  const resource = config.resource ?? serverUrl;
  if (!resource) {
    throw new Error('OAuth protected-resource metadata requires `resource` or `serverUrl`');
  }
  if (config.authorizationServers.length === 0) {
    throw new Error('OAuth protected-resource metadata requires an authorization server');
  }
  assertAbsoluteHttpUrl(resource, 'OAuth resource');
  for (const authorizationServer of config.authorizationServers) {
    assertAbsoluteHttpUrl(authorizationServer, 'OAuth authorization server');
  }

  return {
    ...config.additionalMetadata,
    resource,
    authorization_servers: config.authorizationServers,
    ...(config.scopesSupported?.length ? { scopes_supported: config.scopesSupported } : {}),
    ...(config.resourceName ? { resource_name: config.resourceName } : {}),
    ...(config.resourceDocumentation
      ? { resource_documentation: config.resourceDocumentation }
      : {}),
    bearer_methods_supported: config.bearerMethodsSupported ?? ['header'],
  };
}

/** Return the endpoint-specific RFC 9728 well-known URL for an MCP server URL. */
export function getOAuthProtectedResourceMetadataUrl(serverUrl: string): string {
  const resource = assertAbsoluteHttpUrl(serverUrl, 'MCP server URL');
  const path = resource.pathname === '/' ? '' : resource.pathname.replace(/\/$/, '');
  const metadataUrl = new URL(`/.well-known/oauth-protected-resource${path}`, resource.origin);
  metadataUrl.search = resource.search;
  return metadataUrl.toString();
}

function quoteChallengeValue(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('OAuth challenge values cannot contain control characters');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isAuthorizationFailure(value: unknown): value is AuthorizationFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    'authorized' in value &&
    value.authorized === false
  );
}

function authorizationFailureStatus(failure?: AuthorizationFailure): 400 | 401 | 403 {
  if (failure?.status === 400 || failure?.status === 401 || failure?.status === 403) {
    return failure.status;
  }
  if (failure?.error === 'invalid_request') return 400;
  if (failure?.error === 'insufficient_scope') return 403;
  return 401;
}

/** Build an RFC 6750 bearer challenge with MCP protected-resource discovery. */
export function createOAuthChallenge(
  serverUrl: string,
  config: OAuthProtectedResourceConfig,
  options: OAuthChallengeOptions = {}
): string {
  const parts = [
    `resource_metadata=${quoteChallengeValue(getOAuthProtectedResourceMetadataUrl(serverUrl))}`,
  ];
  const scopes = options.scopes ?? config.scopesSupported;
  if (scopes?.length) parts.push(`scope=${quoteChallengeValue(scopes.join(' '))}`);
  if (options.error) parts.push(`error=${quoteChallengeValue(options.error)}`);
  if (options.errorDescription) {
    parts.push(`error_description=${quoteChallengeValue(options.errorDescription)}`);
  }
  return `Bearer ${parts.join(', ')}`;
}

function isOAuthMetadataPath(pathname: string, serverUrl?: string): boolean {
  if (pathname === '/.well-known/oauth-protected-resource') return true;
  if (!serverUrl) return false;
  return pathname === new URL(getOAuthProtectedResourceMetadataUrl(serverUrl)).pathname;
}

// ============================================================================
// MCP server creation
// ============================================================================

/**
 * Create an MCP server with production tool handlers and pre-built resources.
 *
 * Tools are registered with real Zod schemas (input validation) and handlers.
 * Resources serve pre-built HTML with their _meta preserved.
 */
export function createProductionMcpServer(config: ProductionServerConfig): McpServer {
  const {
    name = 'sunpeak-app',
    version = '0.1.0',
    serverInfo,
    tools,
    resources,
    serverUrl,
  } = config;
  // Handlers detect the host from HTTP headers and pass it via _clientName.
  const clientName = (config as InternalServerConfig)._clientName;

  const mcpServer = new McpServer(
    {
      name: serverInfo?.name ?? name,
      version: serverInfo?.version ?? version,
      ...(serverInfo?.title ? { title: serverInfo.title } : {}),
      ...(serverInfo?.description ? { description: serverInfo.description } : {}),
      ...(serverInfo?.websiteUrl ? { websiteUrl: serverInfo.websiteUrl } : {}),
      icons: serverInfo?.icons ?? [
        {
          src: FAVICON_DATA_URI,
          mimeType: 'image/png',
          sizes: ['64x64'],
        },
      ],
    },
    {
      capabilities: { resources: {}, tools: {} },
      ...(serverInfo?.instructions ? { instructions: serverInfo.instructions } : {}),
    }
  );

  // Build resource lookup: resource name → ProductionResource
  const resourceByName = new Map<string, ProductionResource>();
  for (const res of resources) {
    resourceByName.set(res.name, res);
  }

  // Track registered resource URIs to avoid duplicates
  // (multiple tools can reference the same resource, e.g. review-diff and review-post)
  const registeredResources = new Set<string>();

  let toolCount = 0;

  for (const tool of tools) {
    // Build the handler callback (shared by UI and plain tools)
    const makeCallback = () => {
      return async (
        ...cbArgs: [Record<string, unknown>, ToolHandlerExtra] | [ToolHandlerExtra]
      ) => {
        const hasSchema = !!tool.schema;
        const args: Record<string, unknown> = hasSchema
          ? (cbArgs[0] as Record<string, unknown>)
          : {};
        const extra = (hasSchema ? cbArgs[1] : cbArgs[0]) as ToolHandlerExtra;

        const argKeys = Object.keys(args);
        const argsStr = argKeys.length > 0 ? `{${argKeys.join(', ')}}` : '{}';
        log('info', `CallTool: ${tool.name}${argsStr}`);

        const result = await tool.handler(args, extra);

        // Normalize string returns to CallToolResult
        if (typeof result === 'string') {
          return { content: [{ type: 'text' as const, text: result }] };
        }
        return result;
      };
    };

    const resourceName = tool.tool.resource;
    const res = resourceName ? resourceByName.get(resourceName) : undefined;

    if (resourceName && !res) {
      log('warn', `Resource "${resourceName}" not found for tool "${tool.name}". Skipping.`);
      continue;
    }

    if (res) {
      // ── UI tool: register resource + tool via ext-apps helper ──

      // Register resource (once per URI)
      if (!registeredResources.has(res.uri)) {
        registeredResources.add(res.uri);

        // Resolve domain maps and auto-compute defaults at registration time.
        // clientName is detected from HTTP headers by the handler.
        const resolvedMeta = injectResolvedDomain(res._meta, clientName) ?? res._meta;
        const finalMeta = serverUrl
          ? injectDefaultDomain(resolvedMeta, clientName, serverUrl)
          : resolvedMeta;

        registerAppResource(
          mcpServer,
          res.name,
          res.uri,
          {
            description: res.description,
            _meta: finalMeta,
          },
          async () => ({
            contents: [
              {
                uri: res.uri,
                mimeType: RESOURCE_MIME_TYPE,
                text: res.html,
                _meta: finalMeta,
              },
            ],
          })
        );
      }

      // Register tool with UI metadata via registerAppTool
      const toolConfig: Record<string, unknown> = {
        title: tool.tool.title,
        description: tool.tool.description,
        annotations: tool.tool.annotations,
        ...(tool.schema ? { inputSchema: tool.schema } : {}),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        _meta: {
          ...tool.tool._meta,
          ui: {
            resourceUri: res.uri,
            ...((tool.tool._meta?.ui as Record<string, unknown>) ?? {}),
          },
        },
      };
      // Cast config and callback — tool modules are loaded dynamically at runtime,
      // so Zod shapes and callback generics can't be statically verified.
      registerAppTool(
        mcpServer,
        tool.name,
        toolConfig as unknown as Parameters<typeof registerAppTool>[2],
        makeCallback() as unknown as Parameters<typeof registerAppTool>[3]
      );
    } else {
      // ── Plain tool (no UI): register directly via mcpServer.registerTool() ──
      const cb = makeCallback();
      const toolConfig: Record<string, unknown> = {
        description: tool.tool.description,
        annotations: tool.tool.annotations,
        _meta: tool.tool._meta,
        ...(tool.schema ? { inputSchema: tool.schema } : {}),
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      };
      mcpServer.registerTool(tool.name, toolConfig, async (...args: unknown[]) => {
        if (tool.schema) {
          return cb(args[0] as Record<string, unknown>, args[1] as ToolHandlerExtra);
        }
        return cb(args[0] as ToolHandlerExtra);
      });
    }
    toolCount++;
  }

  const resourceCount = registeredResources.size;
  log('info', `Registered ${toolCount} tool(s) and ${resourceCount} resource(s)`);

  return mcpServer;
}

// ============================================================================
// Constants
// ============================================================================

const MCP_PATH = '/mcp';

/** How long an idle session lives before being cleaned up (5 minutes). */
const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

interface JsonRpcMessage {
  method: string;
  params?: Record<string, unknown>;
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as JsonRpcMessage).method === 'string'
  );
}

/**
 * Detect the MCP host from HTTP request headers.
 *
 * ChatGPT sends `user-agent: openai-mcp/1.0.0` on all MCP HTTP requests.
 * Claude sends `user-agent: Claude-User` and `x-anthropic-client: ClaudeAI`.
 *
 * Returns the `clientInfo.name` equivalent: `'openai-mcp'` or `'claude'`.
 * Returns undefined if the host can't be identified.
 */
export function detectClientFromHeaders(headers: Headers): string | undefined;
export function detectClientFromHeaders(
  headers: Record<string, string | string[] | undefined>
): string | undefined;
export function detectClientFromHeaders(
  headers: Headers | Record<string, string | string[] | undefined>
): string | undefined {
  const get = (name: string): string | undefined => {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    const raw = headers[name];
    return typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : undefined;
  };

  const ua = get('user-agent');
  if (ua) {
    if (/claude/i.test(ua)) return 'claude';
    if (/openai/i.test(ua)) return 'openai-mcp';
  }

  // Fallback: Claude also sends x-anthropic-client header
  if (get('x-anthropic-client')) return 'claude';
  // Fallback: ChatGPT sends x-openai-session header on tool calls
  if (get('x-openai-session')) return 'openai-mcp';

  return undefined;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'content-type, accept, authorization, mcp-session-id, ngrok-skip-browser-warning',
  'Access-Control-Expose-Headers': 'mcp-session-id, www-authenticate',
} as const;

// Cap on POST body size for MCP requests. Without a cap, an unauthenticated
// client (auth runs after the body is read in some modes, and many servers
// don't configure auth at all) could stream gigabytes of garbage and OOM the
// server. 4 MiB is generous for JSON-RPC payloads; override via
// SUNPEAK_MAX_BODY_BYTES.
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
function getMaxBodyBytes(): number {
  const raw = process.env.SUNPEAK_MAX_BODY_BYTES;
  if (!raw) return DEFAULT_MAX_BODY_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

async function readBodyWithLimit(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer | string) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buf.length;
      if (total > maxBytes) {
        aborted = true;
        resolve(null);
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * Compress a Web Standard Response with gzip when the request accepts it
 * and the response is JSON (not SSE). Returns the response unchanged otherwise.
 */
async function maybeCompressResponse(
  response: Response,
  acceptEncoding: string | null
): Promise<Response> {
  if (!acceptEncoding || !/\bgzip\b/.test(acceptEncoding)) return response;
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return response;
  if (!response.body) return response;

  const bodyBytes = new Uint8Array(await response.arrayBuffer());
  const compressed = gzipSync(bodyBytes);
  const headers = new Headers(response.headers);
  headers.set('content-encoding', 'gzip');
  headers.set('content-length', String(compressed.byteLength));
  return new Response(compressed, { status: response.status, headers });
}

// ============================================================================
// Node.js ↔ Web Standard conversion helpers
// ============================================================================

/** Convert a Node.js IncomingMessage to a minimal Web Standard Request (body is passed separately). */
function nodeReqToWebRequest(req: IncomingMessage): Request {
  const url = new URL(req.url!, `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value != null) {
      headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
  }
  return new Request(url.toString(), { method: req.method, headers });
}

/**
 * Pipe a Web Standard Response back to a Node.js ServerResponse.
 * Applies gzip compression for JSON responses when the client accepts it.
 * SSE (streaming) responses are left uncompressed since they stream incrementally.
 */
async function pipeWebResponseToNode(
  webResponse: Response,
  res: ServerResponse,
  acceptEncoding?: string
): Promise<void> {
  const headers: Record<string, string> = {};
  webResponse.headers.forEach((value, key) => {
    headers[key] = value;
  });

  // Compress JSON responses when the client supports gzip.
  // SSE (text/event-stream) is streamed incrementally and must not be compressed here.
  const contentType = webResponse.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');
  const clientAcceptsGzip = !!acceptEncoding && /\bgzip\b/.test(acceptEncoding);

  if (isJson && clientAcceptsGzip && webResponse.body) {
    const bodyBytes = new Uint8Array(await webResponse.arrayBuffer());
    const compressed = gzipSync(bodyBytes);
    headers['content-encoding'] = 'gzip';
    headers['content-length'] = String(compressed.byteLength);
    res.writeHead(webResponse.status, headers);
    res.end(compressed);
    return;
  }

  res.writeHead(webResponse.status, headers);

  if (!webResponse.body) {
    res.end();
    return;
  }

  const reader = webResponse.body.getReader();
  res.on('close', () => reader.cancel());
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.destroyed) res.write(value);
    }
  } finally {
    if (!res.destroyed) res.end();
  }
}

// ============================================================================
// Composable Node.js MCP request handler (Streamable HTTP)
// ============================================================================

/**
 * Create a request handler that manages MCP sessions over Streamable HTTP.
 *
 * The returned handler responds to:
 * - `POST /mcp` — Initialize a session or send messages
 * - `GET /mcp` — Open an SSE stream for server-initiated notifications
 * - `DELETE /mcp` — Terminate a session
 * - `OPTIONS /mcp` — CORS preflight
 *
 * For any other request, the handler does nothing (doesn't write to `res`),
 * so callers can chain it with their own routing.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { createMcpHandler } from 'sunpeak/mcp';
 *
 * const app = express();
 * app.get('/health', (req, res) => res.json({ ok: true }));
 *
 * const mcpHandler = createMcpHandler({ tools, resources, auth });
 * app.use((req, res, next) => {
 *   mcpHandler(req, res).then(() => {
 *     if (!res.headersSent) next();
 *   });
 * });
 *
 * app.listen(3000);
 * ```
 */
export function createMcpHandler(
  config: ProductionServerConfig
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const authFn = config.auth;

  function publicServerUrl(requestUrl: URL): string {
    return (
      config.serverUrl ?? config.oauth?.resource ?? new URL(MCP_PATH, requestUrl.origin).toString()
    );
  }

  // ── Shared request preamble (path check, CORS, auth, body parsing) ──
  async function preamble(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<{ authInfo?: AuthInfo; parsedBody?: unknown; webRequest: Request } | null> {
    if (!req.url) return null;

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (
      config.oauth &&
      req.method === 'GET' &&
      isOAuthMetadataPath(url.pathname, publicServerUrl(url))
    ) {
      const metadata = createOAuthProtectedResourceMetadata(config.oauth, publicServerUrl(url));
      res.writeHead(200, {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      });
      res.end(JSON.stringify(metadata));
      return null;
    }
    if (url.pathname !== MCP_PATH) return null;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return null;
    }

    let parsedBody: unknown;
    if (req.method === 'POST') {
      const rawBody = await readBodyWithLimit(req, getMaxBodyBytes());
      if (rawBody === null) {
        res.writeHead(413, CORS_HEADERS);
        res.end('Payload Too Large');
        return null;
      }
      try {
        parsedBody = JSON.parse(rawBody);
        if (isJsonRpcMessage(parsedBody)) {
          const sid = req.headers['mcp-session-id'] as string | undefined;
          const sidStr = sid ? ` (${sid.substring(0, 8)}...)` : '';
          const extra =
            parsedBody.method === 'resources/read'
              ? ` uri=${JSON.stringify(parsedBody.params?.uri)}`
              : '';
          log('info', `← ${parsedBody.method}${extra}${sidStr}`);
        }
        // Log request headers when SUNPEAK_LOG_HEADERS is set (for debugging host detection)
        if (process.env.SUNPEAK_LOG_HEADERS) {
          const headerEntries: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            if (value != null) {
              headerEntries[key] = Array.isArray(value) ? value.join(', ') : value;
            }
          }
          log('info', `Headers: ${JSON.stringify(headerEntries, null, 2)}`);
        }
      } catch {
        res.writeHead(400).end('Invalid JSON');
        return null;
      }
    }

    let authInfo: AuthInfo | undefined;
    if (authFn) {
      const result = await authFn(req, { body: parsedBody });
      if (!result || isAuthorizationFailure(result)) {
        const options = isAuthorizationFailure(result) ? result : undefined;
        const challenge = config.oauth
          ? createOAuthChallenge(publicServerUrl(url), config.oauth, options)
          : 'Bearer';
        const status = authorizationFailureStatus(options);
        res.writeHead(status, { ...CORS_HEADERS, 'WWW-Authenticate': challenge });
        res.end('Unauthorized');
        return null;
      }
      authInfo = result;
    }

    return { authInfo, parsedBody, webRequest: nodeReqToWebRequest(req) };
  }

  // ── Stateless mode: fresh server + transport per request ──
  if (config.stateless) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const ctx = await preamble(req, res);
      if (!ctx) return;

      if (req.method !== 'POST') {
        res.writeHead(405, CORS_HEADERS);
        res.end('Method Not Allowed: stateless mode only supports POST');
        return;
      }

      const detected = detectClientFromHeaders(req.headers);
      const server = createProductionMcpServer(toInternalConfig(config, detected));
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — no session tracking
        enableJsonResponse: config.enableJsonResponse ?? true,
        keepAliveMs: config.sseKeepAliveMs,
      });

      transport.onerror = (error) => {
        log('error', 'Transport error (stateless)', { error: String(error) });
      };

      await server.connect(transport);
      const webResponse = await transport.handleRequest(ctx.webRequest, {
        parsedBody: ctx.parsedBody,
        authInfo: ctx.authInfo,
      });
      await pipeWebResponseToNode(
        addCorsHeaders(webResponse),
        res,
        req.headers['accept-encoding'] as string | undefined
      );
    };
  }

  // ── Stateful mode: session-based routing ──
  interface Session {
    server: McpServer;
    transport: WebStandardStreamableHTTPServerTransport;
    lastActivity: number;
  }

  const sessions = new Map<string, Session>();

  // Periodically clean up idle sessions.
  // Closing the server triggers transport.onclose which handles session map cleanup.
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
        log('info', `Session expired: ${id.substring(0, 8)}...`, {
          sessionId: id,
          active: sessions.size - 1,
        });
        void session.server.close();
      }
    }
  }, 60_000);
  cleanupInterval.unref(); // Don't prevent process exit

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const ctx = await preamble(req, res);
    if (!ctx) return;

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Route to existing session
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404).end('Unknown session');
        return;
      }
      session.lastActivity = Date.now();
      const webResponse = await session.transport.handleRequest(ctx.webRequest, {
        parsedBody: ctx.parsedBody,
        authInfo: ctx.authInfo,
      });
      await pipeWebResponseToNode(
        addCorsHeaders(webResponse),
        res,
        req.headers['accept-encoding'] as string | undefined
      );
      return;
    }

    // New session (POST without session ID = initialization)
    if (req.method === 'POST') {
      const detected = detectClientFromHeaders(req.headers);
      const server = createProductionMcpServer(toInternalConfig(config, detected));
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: config.enableJsonResponse ?? true,
        keepAliveMs: config.sseKeepAliveMs,
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport, lastActivity: Date.now() });
          log('info', `Session started: ${id.substring(0, 8)}...`, {
            sessionId: id,
            active: sessions.size,
          });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          log('info', `Session closed: ${id.substring(0, 8)}...`, {
            sessionId: id,
            active: sessions.size,
          });
        },
      });

      transport.onerror = (error) => {
        const id = transport.sessionId;
        log('error', `Transport error${id ? ` (${id.substring(0, 8)}...)` : ''}`, {
          sessionId: id,
          error: String(error),
        });
      };

      // Clean up session map on disconnect (don't call server.close — it triggers
      // transport.close which calls onclose again, causing infinite recursion)
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.has(id)) {
          sessions.delete(id);
          log('info', `Session closed: ${id.substring(0, 8)}...`, {
            sessionId: id,
            active: sessions.size,
          });
        }
      };

      await server.connect(transport);
      const webResponse = await transport.handleRequest(ctx.webRequest, {
        parsedBody: ctx.parsedBody,
        authInfo: ctx.authInfo,
      });
      await pipeWebResponseToNode(
        addCorsHeaders(webResponse),
        res,
        req.headers['accept-encoding'] as string | undefined
      );
      return;
    }

    // No session ID and not POST → invalid
    res.writeHead(400).end('Bad Request: session ID required');
  };
}

// ============================================================================
// Composable Web Standard MCP handler (serverless / edge)
// ============================================================================

/**
 * Create a Web Standard request handler for MCP over Streamable HTTP.
 *
 * Returns a `(req: Request) => Promise<Response>` handler that works on any
 * Web Standard runtime: Cloudflare Workers, Deno, Bun, Vercel Edge, etc.
 *
 * Unlike `createMcpHandler`, this handler does NOT do path matching — it handles
 * every request it receives. Mount it behind your own router.
 *
 * @example
 * ```ts
 * // Cloudflare Worker
 * import { createHandler } from 'sunpeak/mcp';
 *
 * const handler = createHandler({ tools, resources, auth });
 * export default { fetch: handler };
 * ```
 *
 * @example
 * ```ts
 * // Hono
 * import { Hono } from 'hono';
 * import { createHandler } from 'sunpeak/mcp';
 *
 * const app = new Hono();
 * const handler = createHandler({ tools, resources });
 * app.all('/mcp', (c) => handler(c.req.raw));
 * export default app;
 * ```
 */
export function createHandler(config: WebHandlerConfig): (req: Request) => Promise<Response> {
  const authFn = config.auth;

  function publicServerUrl(req: Request): string {
    return config.serverUrl ?? config.oauth?.resource ?? req.url;
  }

  // ── Shared request preamble (CORS, auth, body parsing) ──
  async function webPreamble(
    req: Request
  ): Promise<{ authInfo?: AuthInfo; parsedBody?: unknown } | Response> {
    const url = new URL(req.url);
    if (
      config.oauth &&
      req.method === 'GET' &&
      isOAuthMetadataPath(url.pathname, publicServerUrl(req))
    ) {
      const metadata = createOAuthProtectedResourceMetadata(config.oauth, publicServerUrl(req));
      return new Response(JSON.stringify(metadata), {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=300',
        },
      });
    }
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    let parsedBody: unknown;
    if (req.method === 'POST') {
      const maxBytes = getMaxBodyBytes();
      const contentLength = req.headers.get('content-length');
      if (contentLength && Number(contentLength) > maxBytes) {
        return new Response('Payload Too Large', { status: 413 });
      }
      let rawBody: string;
      try {
        const buf = new Uint8Array(await req.arrayBuffer());
        if (buf.byteLength > maxBytes) {
          return new Response('Payload Too Large', { status: 413 });
        }
        rawBody = new TextDecoder().decode(buf);
      } catch {
        return new Response('Invalid request body', { status: 400 });
      }
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      if (isJsonRpcMessage(parsedBody)) {
        const sid = req.headers.get('mcp-session-id');
        const sidStr = sid ? ` (${sid.substring(0, 8)}...)` : '';
        const extra =
          parsedBody.method === 'resources/read'
            ? ` uri=${JSON.stringify(parsedBody.params?.uri)}`
            : '';
        log('info', `← ${parsedBody.method}${extra}${sidStr}`);
      }
      // Log request headers when SUNPEAK_LOG_HEADERS is set (for debugging host detection)
      if (
        typeof globalThis.process !== 'undefined' &&
        globalThis.process.env?.SUNPEAK_LOG_HEADERS
      ) {
        const headerEntries: Record<string, string> = {};
        req.headers.forEach((value, key) => {
          headerEntries[key] = value;
        });
        log('info', `Headers: ${JSON.stringify(headerEntries, null, 2)}`);
      }
    }

    let authInfo: AuthInfo | undefined;
    if (authFn) {
      const result = await authFn(req, { body: parsedBody });
      if (!result || isAuthorizationFailure(result)) {
        const options = isAuthorizationFailure(result) ? result : undefined;
        const challenge = config.oauth
          ? createOAuthChallenge(publicServerUrl(req), config.oauth, options)
          : 'Bearer';
        return new Response('Unauthorized', {
          status: authorizationFailureStatus(options),
          headers: {
            ...CORS_HEADERS,
            'WWW-Authenticate': challenge,
          },
        });
      }
      authInfo = result;
    }

    return { authInfo, parsedBody };
  }

  // ── Stateless mode: fresh server + transport per request ──
  if (config.stateless) {
    return async (req: Request): Promise<Response> => {
      const ctx = await webPreamble(req);
      if (ctx instanceof Response) return ctx;

      if (req.method !== 'POST') {
        return addCorsHeaders(
          new Response('Method Not Allowed: stateless mode only supports POST', { status: 405 })
        );
      }

      const detected = detectClientFromHeaders(req.headers);
      const server = createProductionMcpServer(toInternalConfig(config, detected));
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless — no session tracking
        enableJsonResponse: config.enableJsonResponse ?? true,
        keepAliveMs: config.sseKeepAliveMs,
      });

      transport.onerror = (error) => {
        log('error', 'Transport error (stateless)', { error: String(error) });
      };

      await server.connect(transport);
      const response = await transport.handleRequest(req, {
        parsedBody: ctx.parsedBody,
        authInfo: ctx.authInfo,
      });
      return maybeCompressResponse(addCorsHeaders(response), req.headers.get('accept-encoding'));
    };
  }

  // ── Stateful mode: session-based routing ──
  interface WebSession {
    server: McpServer;
    transport: WebStandardStreamableHTTPServerTransport;
    lastActivity: number;
  }

  const sessions = new Map<string, WebSession>();

  // Periodically clean up idle sessions.
  // Closing the server triggers transport.onclose which handles session map cleanup.
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
        log('info', `Session expired: ${id.substring(0, 8)}...`, {
          sessionId: id,
          active: sessions.size - 1,
        });
        void session.server.close();
      }
    }
  }, 60_000);
  cleanupInterval.unref();

  return async (req: Request): Promise<Response> => {
    const ctx = await webPreamble(req);
    if (ctx instanceof Response) return ctx;

    const sessionId = req.headers.get('mcp-session-id');

    // Route to existing session
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return new Response('Unknown session', { status: 404 });
      }
      session.lastActivity = Date.now();
      const response = await session.transport.handleRequest(req, {
        parsedBody: ctx.parsedBody,
        authInfo: ctx.authInfo,
      });
      return maybeCompressResponse(addCorsHeaders(response), req.headers.get('accept-encoding'));
    }

    // New session (POST without session ID = initialization)
    if (req.method === 'POST') {
      const detected = detectClientFromHeaders(req.headers);
      const server = createProductionMcpServer(toInternalConfig(config, detected));
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: config.enableJsonResponse ?? true,
        keepAliveMs: config.sseKeepAliveMs,
        onsessioninitialized: (id) => {
          sessions.set(id, { server, transport, lastActivity: Date.now() });
          log('info', `Session started: ${id.substring(0, 8)}...`, {
            sessionId: id,
            active: sessions.size,
          });
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          log('info', `Session closed: ${id.substring(0, 8)}...`, {
            sessionId: id,
            active: sessions.size,
          });
        },
      });

      transport.onerror = (error) => {
        const id = transport.sessionId;
        log('error', `Transport error${id ? ` (${id.substring(0, 8)}...)` : ''}`, {
          sessionId: id,
          error: String(error),
        });
      };

      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.has(id)) {
          sessions.delete(id);
          log('info', `Session closed: ${id.substring(0, 8)}...`, {
            sessionId: id,
            active: sessions.size,
          });
        }
      };

      await server.connect(transport);
      const response = await transport.handleRequest(req, {
        parsedBody: ctx.parsedBody,
        authInfo: ctx.authInfo,
      });
      return maybeCompressResponse(addCorsHeaders(response), req.headers.get('accept-encoding'));
    }

    return new Response('Bad Request: session ID required', { status: 400 });
  };
}

/** Add CORS headers to a response (including streaming SSE responses). */
function addCorsHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ============================================================================
// Built-in HTTP server (used by `sunpeak start`)
// ============================================================================

/**
 * Options for `startProductionHttpServer`.
 */
export interface HttpServerOptions {
  /** HTTP port to listen on (default: 8000) */
  port?: number;
  /** Host/interface to bind to (default: '0.0.0.0') */
  host?: string;
}

/**
 * Start a production HTTP server with Streamable HTTP transport.
 *
 * This is a convenience wrapper around `createMcpHandler` that adds
 * a health check endpoint, root HTML page, favicon, and graceful shutdown.
 * For custom HTTP servers (Express, Fastify, etc.), use `createMcpHandler` directly.
 *
 * @param config - Production server configuration (tools, resources, auth)
 * @param portOrOptions - HTTP port number, or an options object with port and host
 */
export function startProductionHttpServer(
  config: ProductionServerConfig,
  portOrOptions: number | HttpServerOptions
): void {
  const options: HttpServerOptions =
    typeof portOrOptions === 'number' ? { port: portOrOptions } : portOrOptions;
  const port = options.port ?? 8000;
  const host = options.host ?? '0.0.0.0';

  const startTime = Date.now();
  const mcpHandler = createMcpHandler(config);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url) {
      res.writeHead(400).end('Missing URL');
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    // OPTIONS preflight for non-MCP paths
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // Health check endpoint — for load balancer probes, k8s liveness/readiness,
    // and uptime monitoring
    if (req.method === 'GET' && url.pathname === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        uptime: Math.floor((Date.now() - startTime) / 1000),
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
      return;
    }

    // Root path
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<link rel="icon" type="image/png" href="/favicon.png" />
<title>Sunpeak MCP Server</title>
</head>
<body><h1>Sunpeak MCP Server</h1><p>Connect via <a href="/mcp">/mcp</a></p></body>
</html>`);
      return;
    }

    // Favicon — serve PNG at /favicon.png and /favicon.ico only.
    // Do NOT serve PNG data at /favicon.svg — wrong content type confuses host icon resolvers.
    // Support both GET and HEAD — ChatGPT sends HEAD to check existence before fetching.
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      (url.pathname === '/favicon.png' || url.pathname === '/favicon.ico')
    ) {
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': FAVICON_BUFFER.length,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(req.method === 'HEAD' ? undefined : FAVICON_BUFFER);
      return;
    }

    // MCP handler
    await mcpHandler(req, res);

    // 404 if handler didn't respond
    if (!res.headersSent) {
      log('info', `${req.method} ${url.pathname} → 404`);
      res.writeHead(404).end('Not Found');
    }
  });

  httpServer.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    if (err.code === 'ECONNRESET') {
      // Normal when clients close connections abruptly
    } else if (
      err.code === 'HPE_INVALID_METHOD' &&
      'rawPacket' in err &&
      Buffer.isBuffer((err as Record<string, unknown>).rawPacket) &&
      ((err as Record<string, unknown>).rawPacket as Buffer)[0] >= 0x14 &&
      ((err as Record<string, unknown>).rawPacket as Buffer)[0] <= 0x18
    ) {
      log(
        'error',
        'Received HTTPS request on HTTP server. ' +
          "If you're using ngrok, make sure the upstream is http:// (not https://). " +
          'Example: ngrok http 8000'
      );
    } else {
      log('error', 'HTTP client error', { error: err.message });
    }
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  const requestedPort = port;

  const onListening = () => {
    const addr = httpServer.address() as { port: number };
    if (addr.port !== requestedPort) {
      log(
        'info',
        `Server listening on http://${displayHost}:${addr.port} (port ${requestedPort} was in use)`
      );
    } else {
      log('info', `Server listening on http://${displayHost}:${addr.port}`);
    }
    log('info', `MCP endpoint: http://${displayHost}:${addr.port}${MCP_PATH}`);
    log('info', `Health check: http://${displayHost}:${addr.port}/health`);
  };

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log('warn', `Port ${requestedPort} is in use, trying another port...`);
      // onListening is already registered as a .once('listening') from the first .listen() call
      httpServer.listen(0, host);
    } else {
      throw err;
    }
  });

  httpServer.listen(port, host, onListening);

  // Graceful shutdown
  const shutdown = async () => {
    log('info', 'Shutting down MCP server...');
    httpServer.close(() => {
      log('info', 'MCP server closed');
      process.exit(0);
    });
    setTimeout(() => {
      log('error', 'Force closing MCP server');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}
