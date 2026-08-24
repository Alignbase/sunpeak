/**
 * `sunpeak inspect` — Connect to an external MCP server and launch the inspector.
 *
 * This command lets users test their own MCP server in the sunpeak inspector
 * without adopting the sunpeak framework conventions. It connects to the server
 * via MCP protocol, discovers tools and resources, and serves the inspector UI.
 *
 * The core logic lives in `inspectServer()`, which is also used by `sunpeak dev`
 * to serve the inspector UI pointed at the local MCP server.
 *
 * Usage:
 *   sunpeak inspect --server http://localhost:8000/mcp
 *   sunpeak inspect --server "python my_server.py"
 *   sunpeak inspect --server http://localhost:8000/mcp --simulations tests/simulations
 */
import * as fs from 'fs';
import * as path from 'path';
const { existsSync, readdirSync, readFileSync } = fs;
const { join, resolve, dirname, sep } = path;
import { fileURLToPath, pathToFileURL } from 'url';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer as createHttpServer } from 'http';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { OAuthProtectedResourceMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { getPort } from '../lib/get-port.mjs';
import { startSandboxServer } from '../lib/sandbox-server.mjs';
import { getDevOverlayScript } from '../lib/dev-overlay.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUNPEAK_PKG_DIR = resolve(__dirname, '..', '..');

/**
 * Parse CLI arguments.
 * @param {string[]} args
 */
function parseArgs(args) {
  const opts = {
    server: undefined,
    simulations: undefined,
    port: undefined,
    name: undefined,
    env: undefined,
    cwd: undefined,
    headers: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '--server' || arg === '-s') && i + 1 < args.length) {
      opts.server = args[++i];
    } else if (arg === '--simulations' && i + 1 < args.length) {
      opts.simulations = args[++i];
    } else if ((arg === '--port' || arg === '-p') && i + 1 < args.length) {
      opts.port = Number(args[++i]);
    } else if (arg === '--name' && i + 1 < args.length) {
      opts.name = args[++i];
    } else if (arg === '--env' && i + 1 < args.length) {
      // Repeatable: --env KEY=VALUE --env KEY2=VALUE2
      const pair = args[++i];
      const eqIdx = pair.indexOf('=');
      if (eqIdx > 0) {
        opts.env = opts.env || {};
        opts.env[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
      }
    } else if (arg === '--cwd' && i + 1 < args.length) {
      opts.cwd = args[++i];
    } else if ((arg === '--header' || arg === '-H') && i + 1 < args.length) {
      opts.headers = opts.headers || {};
      const [name, value] = parseHttpHeader(args[++i]);
      setHttpHeader(opts.headers, name, value);
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
sunpeak inspect — Test an external MCP server in the inspector

Usage:
  sunpeak inspect --server <url-or-command>

Options:
  --server, -s <url|cmd>     MCP server URL or stdio command (required)
  --simulations <dir>        Simulation JSON directory (opt-in, no default)
  --port, -p <number>        Dev server port (default: 3000)
  --name <string>            App name in inspector chrome
  --env <KEY=VALUE>          Environment variable for stdio servers (repeatable)
  --cwd <path>               Working directory for stdio servers
  --header, -H <Name: value> HTTP header for HTTP MCP servers (repeatable)
  --help, -h                 Show this help

Examples:
  sunpeak inspect --server http://localhost:8000/mcp
  sunpeak inspect --server http://localhost:8000/mcp -H "Authorization: Bearer $TOKEN"
  sunpeak inspect --server "python my_server.py"
  sunpeak inspect --server "python server.py" --env API_KEY=sk-123 --cwd ./backend
  sunpeak inspect --server http://localhost:8000/mcp --simulations tests/simulations
`);
}

function setHttpHeader(headers, name, value) {
  const lowerName = name.toLowerCase();
  for (const existingName of Object.keys(headers)) {
    if (existingName.toLowerCase() === lowerName) {
      delete headers[existingName];
    }
  }
  headers[name] = value;
}

function parseHttpHeader(raw) {
  if (typeof raw !== 'string') {
    throw new Error('Invalid --header value. Expected "Name: value".');
  }
  const separator = raw.indexOf(':');
  if (separator <= 0) {
    throw new Error('Invalid --header value. Expected "Name: value".');
  }

  const name = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new Error(`Invalid HTTP header name: ${name || '(empty)'}`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid HTTP header value for ${name}: control characters are not allowed`);
  }
  return [name, value];
}

function hasAuthorizationHeader(headers) {
  return Object.keys(headers || {}).some((name) => name.toLowerCase() === 'authorization');
}

/**
 * Create an in-memory OAuth client provider for the inspector.
 * The provider stores tokens, client info, and code verifier in memory.
 * When `redirectToAuthorization()` is called, it stores the URL for retrieval.
 *
 * @param {string} redirectUrl - The callback URL for OAuth redirects
 * @param {{ clientId?: string, clientSecret?: string, clientMetadataUrl?: string, tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'none', applicationType?: 'native' | 'web', scope?: string, authorizationServer?: string }} [opts]
 * @returns {{ provider: import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider, getAuthUrl: () => URL | undefined }}
 */
function createInMemoryOAuthProvider(redirectUrl, opts = {}) {
  let _authUrl;
  let _discoveryState;
  let _candidateDiscoveryState;
  let _activeIssuer;
  let _selectedAuthorizationServer = opts.authorizationServer;
  const _credentialStores = new Map();
  // Cryptographic state parameter for CSRF protection on the OAuth callback.
  let _stateParam = crypto.randomUUID();
  const redirect = new URL(redirectUrl);
  const applicationType =
    opts.applicationType ??
    (redirect.hostname === 'localhost' ||
    redirect.hostname === '127.0.0.1' ||
    redirect.hostname === '[::1]'
      ? 'native'
      : 'web');
  let clientMetadataUrl;
  if (opts.clientMetadataUrl) {
    clientMetadataUrl = new URL(opts.clientMetadataUrl);
    if (
      clientMetadataUrl.protocol !== 'https:' ||
      clientMetadataUrl.pathname === '/' ||
      clientMetadataUrl.hash ||
      clientMetadataUrl.username ||
      clientMetadataUrl.password
    ) {
      throw new Error(
        'OAuth client metadata URL must use https, have a non-root path, and omit credentials and fragments'
      );
    }
  }

  const configuredScopes = new Set((opts.scope ?? '').split(/\s+/).filter(Boolean));
  const configuration = JSON.stringify({
    clientId: opts.clientId ?? '',
    clientSecret: opts.clientSecret ?? '',
    clientMetadataUrl: opts.clientMetadataUrl ?? '',
    tokenEndpointAuthMethod: opts.tokenEndpointAuthMethod ?? '',
    applicationType: opts.applicationType ?? '',
    scope: opts.scope ?? '',
  });
  const unboundStore = {
    clientInfo: opts.clientId
      ? {
          client_id: opts.clientId,
          ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
          ...(opts.tokenEndpointAuthMethod
            ? { token_endpoint_auth_method: opts.tokenEndpointAuthMethod }
            : {}),
        }
      : undefined,
    tokens: undefined,
    codeVerifier: undefined,
    requestedScopes: new Set(configuredScopes),
    forceReauthorization: false,
  };

  function currentStore() {
    if (!_activeIssuer) return unboundStore;
    let store = _credentialStores.get(_activeIssuer);
    if (!store) {
      store = {
        clientInfo: undefined,
        tokens: undefined,
        codeVerifier: undefined,
        requestedScopes: new Set(configuredScopes),
        forceReauthorization: false,
      };
      _credentialStores.set(_activeIssuer, store);
    }
    return store;
  }

  function bindToIssuer(issuer) {
    if (!_credentialStores.has(issuer)) {
      _credentialStores.set(issuer, {
        ...unboundStore,
        requestedScopes: new Set(unboundStore.requestedScopes),
      });
      unboundStore.clientInfo = undefined;
      unboundStore.tokens = undefined;
      unboundStore.codeVerifier = undefined;
    }
    _activeIssuer = issuer;
  }

  function requestedScope() {
    const scopes = [...currentStore().requestedScopes];
    return scopes.length ? scopes.join(' ') : undefined;
  }

  function noteChallenge(scope, error, resourceMetadataUrl) {
    const store = currentStore();
    for (const value of (scope ?? '').split(/\s+/).filter(Boolean)) {
      store.requestedScopes.add(value);
    }
    if (error === 'insufficient_scope') store.forceReauthorization = true;
    if (_discoveryState && resourceMetadataUrl) _discoveryState = undefined;
    return requestedScope();
  }

  const provider = {
    ...(clientMetadataUrl ? { clientMetadataUrl: clientMetadataUrl.toString() } : {}),
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return {
        redirect_uris: [new URL(redirectUrl)],
        client_name: 'sunpeak Inspector',
        application_type: applicationType,
        token_endpoint_auth_method:
          opts.tokenEndpointAuthMethod ?? (opts.clientSecret ? 'client_secret_basic' : 'none'),
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        ...(requestedScope() ? { scope: requestedScope() } : {}),
      };
    },
    // Return the state parameter so the SDK includes it in the authorization URL.
    state() {
      _stateParam = crypto.randomUUID();
      return _stateParam;
    },
    clientInformation() {
      return currentStore().clientInfo;
    },
    saveClientInformation(info) {
      currentStore().clientInfo = info;
    },
    tokens() {
      const store = currentStore();
      if (!store.forceReauthorization || !store.tokens) return store.tokens;
      const { refresh_token: _refreshToken, ...tokensWithoutRefresh } = store.tokens;
      return tokensWithoutRefresh;
    },
    saveTokens(tokens) {
      const store = currentStore();
      store.tokens = tokens;
      store.forceReauthorization = false;
      for (const scope of (tokens.scope ?? '').split(/\s+/).filter(Boolean)) {
        store.requestedScopes.add(scope);
      }
      _authUrl = undefined;
    },
    redirectToAuthorization(url) {
      const authorizationUrl = new URL(url);
      const scopes = new Set(
        (authorizationUrl.searchParams.get('scope') ?? '').split(/\s+/).filter(Boolean)
      );
      for (const scope of currentStore().requestedScopes) scopes.add(scope);
      if (scopes.size) authorizationUrl.searchParams.set('scope', [...scopes].join(' '));
      _authUrl = authorizationUrl;
    },
    saveCodeVerifier(verifier) {
      currentStore().codeVerifier = verifier;
    },
    codeVerifier() {
      return currentStore().codeVerifier;
    },
    // Cache discovery state so the second auth() call (token exchange)
    // doesn't re-discover metadata from scratch.
    saveDiscoveryState(state) {
      _candidateDiscoveryState = state;
      const authorizationServers = state?.resourceMetadata?.authorization_servers ?? [];
      const selectedAuthorizationServer = String(state?.authorizationServerUrl ?? '');
      if (
        _selectedAuthorizationServer &&
        authorizationServers.length === 1 &&
        !authorizationServers.includes(_selectedAuthorizationServer)
      ) {
        _selectedAuthorizationServer = authorizationServers[0];
      }
      if (_selectedAuthorizationServer) {
        if (
          authorizationServers.length > 0 &&
          !authorizationServers.includes(_selectedAuthorizationServer)
        ) {
          throw new Error('Selected OAuth authorization server is not advertised by the resource');
        }
        if (selectedAuthorizationServer !== _selectedAuthorizationServer) {
          throw new Error('OAuth authorization server selection is required');
        }
      } else if (authorizationServers.length > 1) {
        throw new Error('OAuth authorization server selection is required');
      }

      validateOAuthDiscoveryState(state, opts.tokenEndpointAuthMethod);
      const nextIssuer = getOAuthIssuer(state);
      bindToIssuer(nextIssuer);
      // This client advertises the refresh_token grant. Request offline_access
      // only when the selected server explicitly supports it, as required by
      // the MCP refresh-token guidance.
      if (state.authorizationServerMetadata?.scopes_supported?.includes('offline_access')) {
        currentStore().requestedScopes.add('offline_access');
      }
      _discoveryState = state;
    },
    discoveryState() {
      return _discoveryState;
    },
    invalidateCredentials(scope) {
      if (scope === 'all') {
        _credentialStores.clear();
        _activeIssuer = undefined;
        unboundStore.clientInfo = undefined;
        unboundStore.tokens = undefined;
        unboundStore.codeVerifier = undefined;
        unboundStore.requestedScopes = new Set(configuredScopes);
        unboundStore.forceReauthorization = false;
        _authUrl = undefined;
        _discoveryState = undefined;
        _candidateDiscoveryState = undefined;
        return;
      }
      const store = currentStore();
      if (scope === 'tokens') store.tokens = undefined;
      if (scope === 'verifier') store.codeVerifier = undefined;
      if (scope === 'discovery') _discoveryState = undefined;
      if (scope === 'client') store.clientInfo = undefined;
    },
    _sunpeakNoteChallenge: noteChallenge,
  };

  return {
    provider,
    getAuthUrl: () => _authUrl,
    hasTokens: () => !!currentStore().tokens,
    getDiscoveryState: () => _discoveryState,
    getCandidateDiscoveryState: () => _candidateDiscoveryState,
    getAuthorizationServers: () =>
      _candidateDiscoveryState?.resourceMetadata?.authorization_servers ?? [],
    getActiveIssuer: () => _activeIssuer,
    matchesConfiguration(candidate) {
      return (
        configuration ===
        JSON.stringify({
          clientId: candidate.clientId ?? '',
          clientSecret: candidate.clientSecret ?? '',
          clientMetadataUrl: candidate.clientMetadataUrl ?? '',
          tokenEndpointAuthMethod: candidate.tokenEndpointAuthMethod ?? '',
          applicationType: candidate.applicationType ?? '',
          scope: candidate.scope ?? '',
        })
      );
    },
    selectAuthorizationServer(authorizationServer) {
      _selectedAuthorizationServer = authorizationServer;
    },
    noteChallenge,
    get stateParam() {
      return _stateParam;
    },
  };
}

function assertSecureOAuthUrl(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${label} must use https unless it is on localhost`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  if (url.hash) {
    throw new Error(`${label} must not contain a fragment`);
  }
  return url;
}

function validateOAuthDiscoveryState(state, tokenEndpointAuthMethod) {
  const authorizationServer = String(state?.authorizationServerUrl ?? '');
  const metadata = state?.authorizationServerMetadata;
  if (!authorizationServer || !metadata) {
    throw new Error('OAuth authorization server metadata is required');
  }
  assertSecureOAuthUrl(authorizationServer, 'OAuth authorization server');
  if (!metadata.issuer || metadata.issuer !== authorizationServer) {
    throw new Error('OAuth authorization server metadata issuer mismatch');
  }
  assertSecureOAuthUrl(metadata.issuer, 'OAuth authorization server issuer');
  assertSecureOAuthUrl(metadata.authorization_endpoint, 'OAuth authorization endpoint');
  assertSecureOAuthUrl(metadata.token_endpoint, 'OAuth token endpoint');
  if (metadata.registration_endpoint) {
    assertSecureOAuthUrl(metadata.registration_endpoint, 'OAuth registration endpoint');
  }
  if (!metadata.code_challenge_methods_supported?.includes('S256')) {
    throw new Error('OAuth authorization server metadata must advertise PKCE S256 support');
  }
  if (
    tokenEndpointAuthMethod &&
    metadata.token_endpoint_auth_methods_supported?.length &&
    !metadata.token_endpoint_auth_methods_supported.includes(tokenEndpointAuthMethod)
  ) {
    throw new Error(
      `OAuth authorization server does not support ${tokenEndpointAuthMethod} client authentication`
    );
  }
}

function rewriteOAuthChallenge(response, oauthState) {
  if (response.status !== 401 && response.status !== 403) return response;
  const header = response.headers.get('www-authenticate');
  if (!header || !/^Bearer\s/i.test(header)) return response;
  const scopeMatch = header.match(/(?:^|[,\s])scope=(?:"([^"]*)"|([^\s,]+))/i);
  const errorMatch = header.match(/(?:^|[,\s])error=(?:"([^"]*)"|([^\s,]+))/i);
  const resourceMetadataMatch = header.match(
    /(?:^|[,\s])resource_metadata=(?:"([^"]*)"|([^\s,]+))/i
  );
  const scope = scopeMatch?.[1] ?? scopeMatch?.[2];
  const error = errorMatch?.[1] ?? errorMatch?.[2];
  const resourceMetadataUrl = resourceMetadataMatch?.[1] ?? resourceMetadataMatch?.[2];
  const accumulatedScope = oauthState.noteChallenge(scope, error, resourceMetadataUrl);
  if (!accumulatedScope || accumulatedScope === scope) return response;

  const nextHeader = scopeMatch
    ? header.replace(scopeMatch[0], scopeMatch[0].replace(scope, accumulatedScope))
    : `${header}, scope="${accumulatedScope.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const headers = new Headers(response.headers);
  headers.set('www-authenticate', nextHeader);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function createOAuthAwareFetch(oauthState, fetchFn = fetch) {
  return async (input, init) => rewriteOAuthChallenge(await fetchFn(input, init), oauthState);
}

function createOAuthProviderAwareFetch(provider, fetchFn = fetch) {
  if (typeof provider?._sunpeakNoteChallenge !== 'function') return fetchFn;
  return async (input, init) => {
    const response = await fetchFn(input, init);
    return rewriteOAuthChallenge(response, {
      noteChallenge: provider._sunpeakNoteChallenge,
    });
  };
}

function createPublicOAuthFetch(fetchFn = fetch) {
  return async (input, init = {}) => {
    let currentInput = input;
    let currentInit = { ...init, redirect: 'manual' };

    for (let redirects = 0; redirects <= 5; redirects++) {
      const currentUrl =
        currentInput instanceof Request
          ? currentInput.url
          : currentInput instanceof URL
            ? currentInput.toString()
            : String(currentInput);
      await assertHttpServerUrlAllowed(currentUrl);

      const response = await fetchFn(currentInput, currentInit);
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) return response;

      const method = String(
        currentInit.method ?? (currentInput instanceof Request ? currentInput.method : 'GET')
      ).toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        await response.body?.cancel?.();
        throw new Error('OAuth endpoint redirects are not allowed for requests with a body');
      }
      if (redirects === 5) {
        await response.body?.cancel?.();
        throw new Error('OAuth endpoint exceeded the redirect limit');
      }

      const nextUrl = new URL(location, currentUrl);
      await assertHttpServerUrlAllowed(nextUrl.toString());
      const headers = new Headers(
        currentInit.headers ?? (currentInput instanceof Request ? currentInput.headers : undefined)
      );
      if (nextUrl.origin !== new URL(currentUrl).origin) {
        headers.delete('authorization');
        headers.delete('cookie');
        headers.delete('proxy-authorization');
      }
      await response.body?.cancel?.();
      currentInput = nextUrl;
      currentInit = { ...currentInit, method, headers, body: undefined, redirect: 'manual' };
    }

    throw new Error('OAuth endpoint exceeded the redirect limit');
  };
}

async function configureOAuthAuthorizationServer(oauthState, authorizationServer, fetchFn = fetch) {
  const candidate = oauthState.getCandidateDiscoveryState();
  const advertised = candidate?.resourceMetadata?.authorization_servers ?? [];
  if (!advertised.includes(authorizationServer)) {
    throw new Error('Selected OAuth authorization server is not advertised by the resource');
  }
  const { discoverAuthorizationServerMetadata } =
    await import('@modelcontextprotocol/sdk/client/auth.js');
  const metadata = await discoverAuthorizationServerMetadata(authorizationServer, { fetchFn });
  oauthState.selectAuthorizationServer(authorizationServer);
  await oauthState.provider.saveDiscoveryState({
    ...candidate,
    authorizationServerUrl: authorizationServer,
    authorizationServerMetadata: metadata,
  });
}

async function selectOAuthAuthorizationServer(authorizationServers) {
  if (authorizationServers.length === 1 || !process.stdin.isTTY || !process.stdout.isTTY) {
    return authorizationServers[0];
  }
  console.log('The resource advertises multiple OAuth authorization servers:');
  authorizationServers.forEach((issuer, index) => console.log(`  ${index + 1}. ${issuer}`));
  const { createInterface } = await import('node:readline/promises');
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question('Select an authorization server [1]: ');
    const index = answer.trim() === '' ? 0 : Number(answer) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= authorizationServers.length) {
      throw new Error('Invalid OAuth authorization server selection');
    }
    return authorizationServers[index];
  } finally {
    prompt.close();
  }
}

function getOAuthIssuer(discoveryState) {
  const metadataIssuer = discoveryState?.authorizationServerMetadata?.issuer;
  if (typeof metadataIssuer === 'string') return metadataIssuer;
  const issuer = discoveryState?.authorizationServerUrl;
  return issuer instanceof URL
    ? issuer.toString()
    : typeof issuer === 'string'
      ? issuer
      : undefined;
}

/**
 * Validate an OAuth authorization response before using its code or error.
 * RFC 9207 requires exact issuer matching, without URL normalization.
 *
 * @param {URLSearchParams | Record<string, string | null | undefined>} params
 * @param {string} expectedState
 * @param {unknown} discoveryState
 * @returns {string}
 */
function validateOAuthAuthorizationResponse(params, expectedState, discoveryState) {
  const get = (name) =>
    params instanceof URLSearchParams ? params.get(name) : (params[name] ?? null);
  const state = get('state');
  if (!state || state !== expectedState) {
    throw new Error('OAuth state mismatch: callback rejected');
  }

  const expectedIssuer = getOAuthIssuer(discoveryState);
  const issuer = get('iss');
  const issuerRequired =
    discoveryState?.authorizationServerMetadata?.authorization_response_iss_parameter_supported ===
    true;
  if (issuer && (!expectedIssuer || issuer !== expectedIssuer)) {
    throw new Error('OAuth issuer mismatch: callback rejected');
  }
  if (issuerRequired && !issuer) {
    throw new Error('OAuth callback is missing the required issuer parameter');
  }

  const error = get('error');
  if (error) {
    const description = get('error_description');
    throw new Error(`OAuth authorization failed: ${error}${description ? `: ${description}` : ''}`);
  }
  const code = get('code');
  if (!code) throw new Error('OAuth callback did not include an authorization code');
  return code;
}

/**
 * @param {URL} serverUrl
 * @returns {{ pathMetadataUrl: URL, rootMetadataUrl: URL } | undefined}
 */
function getMcpResourceMetadataUrls(serverUrl) {
  if (serverUrl.protocol !== 'http:' && serverUrl.protocol !== 'https:') return undefined;
  if (serverUrl.pathname === '/' || serverUrl.pathname === '') return undefined;

  const pathname = serverUrl.pathname.endsWith('/')
    ? serverUrl.pathname.slice(0, -1)
    : serverUrl.pathname;

  const pathMetadataUrl = new URL(`/.well-known/oauth-protected-resource${pathname}`, serverUrl);
  pathMetadataUrl.search = serverUrl.search;

  const rootMetadataUrl = new URL('/.well-known/oauth-protected-resource', serverUrl.origin);
  return { pathMetadataUrl, rootMetadataUrl };
}

/**
 * MCP auth discovery supports both endpoint-path and root protected-resource
 * metadata. When no WWW-Authenticate resource_metadata URL is available, the
 * current MCP authorization draft says clients must try the endpoint path
 * first, then the root well-known URI.
 *
 * The SDK already falls back from endpoint-path to root on 4xx responses. This
 * helper detects the remaining common invalid-endpoint case before OAuth starts:
 * the endpoint-path URL returns 200 but serves a text/html or text/plain landing
 * page instead of protected-resource metadata JSON. In that case, start OAuth
 * directly with the root metadata URL so no partial provider state is carried
 * across a failed SDK auth attempt.
 *
 * @param {string | URL} serverUrl
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<string | undefined>}
 */
export async function resolveMcpResourceMetadataUrl(serverUrl, fetchFn = fetch) {
  let parsed;
  try {
    parsed = serverUrl instanceof URL ? serverUrl : new URL(serverUrl);
  } catch {
    return undefined;
  }

  const urls = getMcpResourceMetadataUrls(parsed);
  if (!urls) return undefined;

  let response;
  try {
    response = await fetchFn(urls.pathMetadataUrl, {
      headers: { 'MCP-Protocol-Version': LATEST_PROTOCOL_VERSION },
      redirect: 'manual',
    });
  } catch {
    return undefined;
  }

  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    await response.body?.cancel();
    return urls.rootMetadataUrl.toString();
  }

  try {
    OAuthProtectedResourceMetadataSchema.parse(await response.json());
  } catch {
    return urls.rootMetadataUrl.toString();
  }

  return undefined;
}

/**
 * Negotiate OAuth with an MCP server and return an authenticated provider.
 *
 * Handles two cases:
 * 1. Anonymous/auto-approved OAuth: the authorization endpoint redirects
 *    immediately back with a code (no user interaction needed).
 * 2. Interactive OAuth: opens the authorization URL in the user's browser
 *    and waits for the callback.
 *
 * @param {string} serverUrl - The MCP server URL
 * @returns {Promise<import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider>}
 */
async function negotiateOAuth(serverUrl) {
  const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');

  // Start a temporary callback server for receiving the OAuth code.
  const callbackPort = await getPort(24681);
  const callbackUrl = `http://127.0.0.1:${callbackPort}/oauth/callback`;

  const oauthState = createInMemoryOAuthProvider(callbackUrl);
  const { provider } = oauthState;
  // Let the transport process the real bearer challenge first so its
  // resource_metadata and scope values remain authoritative.
  try {
    const connection = await createMcpConnection(serverUrl, {
      type: 'oauth',
      authProvider: provider,
    });
    await connection.client.close();
    return provider;
  } catch {
    const authorizationServers = oauthState.getAuthorizationServers();
    if (authorizationServers.length > 1) {
      const selected = await selectOAuthAuthorizationServer(authorizationServers);
      await configureOAuthAuthorizationServer(
        oauthState,
        selected,
        createOAuthAwareFetch(oauthState)
      );
      const result = await auth(provider, {
        serverUrl: new URL(serverUrl),
        fetchFn: createOAuthProviderAwareFetch(provider),
      });
      if (result === 'AUTHORIZED') return provider;
    } else if (!oauthState.getAuthUrl()) {
      const resourceMetadataUrl = await resolveMcpResourceMetadataUrl(serverUrl);
      const result = await auth(provider, {
        serverUrl: new URL(serverUrl),
        ...(resourceMetadataUrl ? { resourceMetadataUrl: new URL(resourceMetadataUrl) } : {}),
        fetchFn: createOAuthProviderAwareFetch(provider),
      });
      if (result === 'AUTHORIZED') return provider;
    }
  }

  const authUrl = oauthState.getAuthUrl();
  if (!authUrl) {
    throw new Error('OAuth flow returned REDIRECT but no authorization URL was captured');
  }
  // A malicious MCP server can publish OAuth metadata whose
  // `authorization_endpoint` is a `javascript:` (or other non-http) URL.
  // Refuse to follow or open anything that isn't http(s) so we never feed a
  // `javascript:` URL to the OS opener or assign it to a popup location.
  if (authUrl.protocol !== 'http:' && authUrl.protocol !== 'https:') {
    throw new Error(`OAuth authorization URL has unsupported scheme: ${authUrl.protocol}`);
  }

  // Try the anonymous/auto-approved path first: follow the authorization URL
  // without a browser and see if it immediately redirects with a code.
  const code = await tryAnonymousOAuth(
    authUrl.toString(),
    callbackUrl,
    oauthState.stateParam,
    fetch,
    oauthState.getDiscoveryState()
  );
  if (code) {
    // Complete the flow with the authorization code.
    const tokenResult = await auth(provider, {
      serverUrl: new URL(serverUrl),
      authorizationCode: code,
      fetchFn: createOAuthProviderAwareFetch(provider),
    });
    if (tokenResult === 'AUTHORIZED') {
      return provider;
    }
    throw new Error('OAuth token exchange failed after anonymous authorization');
  }

  // Anonymous path didn't work — this server requires interactive login.
  // Start a callback server and open the auth URL in the user's browser.
  const interactiveCode = await waitForInteractiveOAuth(
    authUrl.toString(),
    callbackUrl,
    callbackPort,
    oauthState.stateParam,
    oauthState.getDiscoveryState()
  );

  const tokenResult = await auth(provider, {
    serverUrl: new URL(serverUrl),
    authorizationCode: interactiveCode,
    fetchFn: createOAuthProviderAwareFetch(provider),
  });
  if (tokenResult === 'AUTHORIZED') {
    return provider;
  }
  throw new Error('OAuth token exchange failed after interactive authorization');
}

/**
 * Try to complete OAuth without user interaction by following redirects.
 * Returns the authorization code if the server auto-approves, or null if
 * the server requires interactive login (returns an HTML page).
 *
 * @param {string} authUrl - The authorization URL
 * @param {string} callbackUrl - The expected callback URL prefix
 * @param {string} [expectedState] - OAuth state value that must be echoed by the callback
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<string | null>}
 */
async function tryAnonymousOAuth(
  authUrl,
  callbackUrl,
  expectedState,
  fetchFn = fetch,
  discoveryState
) {
  // Follow redirects manually to detect when the server redirects back
  // to our callback URL with a code parameter.
  let url = authUrl;
  const maxRedirects = 10;
  for (let i = 0; i < maxRedirects; i++) {
    const response = await fetchFn(url, { redirect: 'manual' });
    const location = response.headers.get('location');

    if (!location) {
      // No redirect — server returned a page (login form). Not auto-approved.
      // Drain the response body to free the socket.
      await response.text().catch(() => {});
      return null;
    }

    await response.body?.cancel?.();

    // Resolve relative redirects.
    const resolvedUrl = new URL(location, url);
    if (resolvedUrl.protocol !== 'http:' && resolvedUrl.protocol !== 'https:') {
      throw new Error(
        `OAuth authorization redirect has unsupported scheme: ${resolvedUrl.protocol}`
      );
    }
    const resolved = resolvedUrl.toString();

    // Check if the redirect goes to our callback URL.
    const callback = new URL(callbackUrl);
    if (resolvedUrl.origin === callback.origin && resolvedUrl.pathname === callback.pathname) {
      const params = new URL(resolved).searchParams;
      return validateOAuthAuthorizationResponse(params, expectedState, discoveryState);
    }

    url = resolved;
  }

  return null;
}

/**
 * Wait for the user to complete an interactive OAuth flow in their browser.
 * Starts a temporary HTTP server to receive the callback, opens the auth URL,
 * and resolves with the authorization code.
 *
 * @param {string} authUrl - The authorization URL to open in the browser
 * @param {string} callbackUrl - Our callback URL
 * @param {number} callbackPort - Port for the callback server
 * @returns {Promise<string>}
 */
async function waitForInteractiveOAuth(
  authUrl,
  callbackUrl,
  callbackPort,
  expectedState,
  discoveryState
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      fn(value);
    };

    const server = createHttpServer((req, res) => {
      const reqUrl = new URL(req.url, callbackUrl);
      if (reqUrl.pathname !== '/oauth/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      let code;
      try {
        code = validateOAuthAuthorizationResponse(
          reqUrl.searchParams,
          expectedState,
          discoveryState
        );
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(
          '<!DOCTYPE html><html><body><p>Authorization response was rejected.</p></body></html>'
        );
        settle(reject, error);
        return;
      }

      // Serve a simple page that tells the user they can close the tab.
      const message = 'Authorization complete. You can close this tab.';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body><p>${message}</p></body></html>`);

      settle(resolve, code);
    });

    server.on('error', (err) => {
      settle(reject, new Error(`OAuth callback server failed: ${err.message}`));
    });

    server.listen(callbackPort, '127.0.0.1', async () => {
      console.log('Opening browser for OAuth authorization...');
      // Use execFile with array args to avoid shell injection from the auth URL.
      const { execFile } = await import('child_process');
      const cmd =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';
      execFile(cmd, [authUrl], (err) => {
        if (err) console.error(`Failed to open browser: ${err.message}`);
      });
    });

    // Timeout after 2 minutes.
    const timer = setTimeout(() => {
      settle(reject, new Error('OAuth authorization timed out (2 minutes)'));
    }, 120_000);
  });
}

/**
 * Detect if an error from createMcpConnection is an auth error (401/Unauthorized).
 * @param {Error} err
 * @returns {boolean}
 */
function isAuthError(err) {
  // The MCP SDK throws UnauthorizedError for auth failures.
  if (err.constructor?.name === 'UnauthorizedError') return true;

  // StreamableHTTPError exposes the HTTP status as `code`. Some servers return
  // a plain-text body such as "Unauthorized", so the numeric status may be the
  // only reliable signal available to the caller. Keep the adjacent status
  // properties for compatibility with other HTTP client error shapes.
  if (err.code === 401 || err.status === 401 || err.statusCode === 401) return true;

  // StreamableHTTPError includes a status code in its message.
  // Check for the specific "401" HTTP status pattern, not substring matches.
  const msg = err.message || '';
  if (/"statusCode"\s*:\s*401\b/.test(msg)) return true;
  if (/\bstatus(?:Code)?\s*[:=]\s*401\b/i.test(msg)) return true;
  if (/\bHTTP\s+401\b/i.test(msg)) return true;
  if (msg.includes('invalid_token')) return true;

  // Connection errors (ECONNREFUSED, ETIMEDOUT, etc.) are never auth errors.
  if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')) {
    return false;
  }

  return false;
}

function normalizeHostname(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function hostnameFromHostHeader(hostHeader) {
  if (!hostHeader) return '';
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end >= 0 ? host.slice(1, end) : host;
  }
  return host.split(':')[0];
}

function isLoopbackHostname(hostname) {
  const host = normalizeHostname(hostname);
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function expandIpv6Hextets(address) {
  const host = normalizeHostname(address);
  if (isIP(host) !== 6) return undefined;
  if ((host.match(/::/g) || []).length > 1) return undefined;

  const [left = '', right = ''] = host.split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const missing = 8 - leftParts.length - rightParts.length;
  if (missing < 0) return undefined;
  const parts = [...leftParts, ...Array(missing).fill('0'), ...rightParts].map((part) =>
    Number.parseInt(part || '0', 16)
  );
  if (
    parts.length !== 8 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)
  ) {
    return undefined;
  }
  return parts;
}

function embeddedIpv4FromIpv6(address) {
  const parts = expandIpv6Hextets(address);
  if (!parts) return undefined;
  const firstFiveZero = parts.slice(0, 5).every((part) => part === 0);
  const firstSixZero = firstFiveZero && parts[5] === 0;
  const hasEmbedded = (firstFiveZero && parts[5] === 0xffff) || firstSixZero;
  if (!hasEmbedded || (parts[6] === 0 && parts[7] === 0)) return undefined;
  return `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`;
}

function isLoopbackRemoteAddress(address) {
  const host = normalizeHostname(address);
  if (host === '::1') return true;
  const dottedMappedIpv4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : undefined;
  if (dottedMappedIpv4 && isIP(dottedMappedIpv4) === 4) {
    return isLoopbackRemoteAddress(dottedMappedIpv4);
  }
  const embeddedIpv4 = embeddedIpv4FromIpv6(host);
  if (embeddedIpv4) {
    return isLoopbackRemoteAddress(embeddedIpv4);
  }
  if (isIP(host) === 4) {
    return host.split('.')[0] === '127';
  }
  return host === '::1';
}

function isPrivateNetworkAddress(address) {
  const host = normalizeHostname(address);

  const dottedMappedIpv4 = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : undefined;
  if (dottedMappedIpv4 && isIP(dottedMappedIpv4) === 4) {
    return isPrivateNetworkAddress(dottedMappedIpv4);
  }
  const embeddedIpv4 = embeddedIpv4FromIpv6(host);
  if (embeddedIpv4) {
    return isPrivateNetworkAddress(embeddedIpv4);
  }

  if (isIP(host) === 4) {
    const parts = host.split('.').map((part) => Number(part));
    const [a, b, c] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  if (isIP(host) === 6) {
    const parts = expandIpv6Hextets(host);
    return (
      host === '::' ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb') ||
      host.startsWith('ff') ||
      host.startsWith('2001:db8:') ||
      parts?.[0] === 0x2002
    );
  }

  return false;
}

function shouldAllowPrivateServerUrls(req) {
  if (process.env.SUNPEAK_ALLOW_PRIVATE_SERVER_URLS === 'true') return true;
  return (
    isLoopbackHostname(hostnameFromHostHeader(req.headers.host)) &&
    isLoopbackRemoteAddress(req.socket?.remoteAddress)
  );
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeForwardedProto(value) {
  const proto = firstHeaderValue(value)?.split(',')[0]?.trim().toLowerCase();
  return proto === 'http' || proto === 'https' ? proto : undefined;
}

function requestOriginForSameOriginCheck(req) {
  const host = firstHeaderValue(req.headers?.host);
  if (!host) return undefined;
  const proto =
    normalizeForwardedProto(req.headers?.['x-forwarded-proto']) ??
    (req.socket?.encrypted ? 'https' : 'http');
  try {
    return new URL(`${proto}://${host}`).origin;
  } catch {
    return undefined;
  }
}

function isSameInspectorOrigin(req, origin) {
  if (!origin) return true;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(firstHeaderValue(origin));
  } catch {
    return false;
  }
  return parsedOrigin.origin === requestOriginForSameOriginCheck(req);
}

async function assertHttpServerUrlAllowed(
  urlValue,
  { allowPrivateNetwork = false, lookupFn = dnsLookup } = {}
) {
  if (typeof urlValue !== 'string' || !/^https?:\/\//i.test(urlValue)) {
    throw new Error('Only http(s) URLs are allowed');
  }

  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    throw new Error('Invalid server URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http(s) URLs are allowed');
  }

  if (allowPrivateNetwork) return parsed;

  const hostname = normalizeHostname(parsed.hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Private-network MCP server URLs are blocked for hosted inspector sessions');
  }

  if (isIP(hostname)) {
    if (isPrivateNetworkAddress(hostname)) {
      throw new Error('Private-network MCP server URLs are blocked for hosted inspector sessions');
    }
    return parsed;
  }

  let addresses;
  try {
    addresses = await lookupFn(hostname, { all: true });
  } catch {
    throw new Error('Could not resolve MCP server host');
  }

  if (addresses.some((entry) => isPrivateNetworkAddress(entry.address))) {
    throw new Error('Private-network MCP server URLs are blocked for hosted inspector sessions');
  }

  return parsed;
}

async function resolveHttpRedirectsForMcp(
  serverArg,
  { enforcePublicHttpUrl = false, fetchFn = fetch, lookupFn = dnsLookup, requestInit } = {}
) {
  if (!enforcePublicHttpUrl) {
    try {
      const probeResponse = await fetchFn(serverArg, {
        ...(requestInit ?? {}),
        method: 'HEAD',
        redirect: 'follow',
      });
      await probeResponse.body?.cancel?.();
      return probeResponse.url && probeResponse.url !== serverArg ? probeResponse.url : serverArg;
    } catch {
      return serverArg;
    }
  }

  let currentUrl = serverArg;
  const maxRedirects = 5;
  for (let i = 0; i < maxRedirects; i++) {
    let probeResponse;
    try {
      probeResponse = await fetchFn(currentUrl, {
        ...(requestInit ?? {}),
        method: 'HEAD',
        redirect: 'manual',
      });
    } catch {
      return currentUrl;
    }
    await probeResponse.body?.cancel?.();

    const status = probeResponse.status;
    const location = probeResponse.headers.get('location');
    if (status < 300 || status >= 400 || !location) {
      return currentUrl;
    }

    const nextUrl = new URL(location, currentUrl).toString();
    await assertHttpServerUrlAllowed(nextUrl, { lookupFn });
    currentUrl = nextUrl;
  }

  return currentUrl;
}

/**
 * Create an MCP client connection.
 * @param {string} serverArg - URL or command string
 * @param {{ type?: 'none' | 'bearer' | 'oauth', bearerToken?: string, authProvider?: import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider, headers?: Record<string, string>, env?: Record<string, string>, cwd?: string, enforcePublicHttpUrl?: boolean }} [authConfig]
 * @returns {Promise<{ client: import('@modelcontextprotocol/sdk/client/index.js').Client, transport: import('@modelcontextprotocol/sdk/types.js').Transport, serverUrl?: string, stderrOutput?: string[] }>}
 */
async function createMcpConnection(serverArg, authConfig) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const client = new Client(
    { name: 'sunpeak-inspector', version: '1.0.0' },
    {
      capabilities: {
        extensions: {
          'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
        },
      },
    }
  );

  if (serverArg.startsWith('http://') || serverArg.startsWith('https://')) {
    if (authConfig?.enforcePublicHttpUrl) {
      await assertHttpServerUrlAllowed(serverArg);
    }

    // HTTP/SSE transport
    const { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

    const requestHeaders = { ...(authConfig?.headers ?? {}) };
    if (authConfig?.type === 'bearer' && authConfig.bearerToken) {
      requestHeaders.Authorization = `Bearer ${authConfig.bearerToken}`;
    }

    // Follow redirects (e.g. /mcp → /mcp/) before creating the transport.
    // The MCP SDK transport doesn't follow redirects on its own.
    const finalUrl = await resolveHttpRedirectsForMcp(serverArg, {
      enforcePublicHttpUrl: !!authConfig?.enforcePublicHttpUrl,
      ...(Object.keys(requestHeaders).length > 0
        ? { requestInit: { headers: requestHeaders } }
        : {}),
    });

    if (authConfig?.enforcePublicHttpUrl) {
      await assertHttpServerUrlAllowed(finalUrl);
    }

    const transportOpts = {};
    if (authConfig?.enforcePublicHttpUrl) {
      transportOpts.requestInit = { redirect: 'manual' };
    }
    if (Object.keys(requestHeaders).length > 0) {
      transportOpts.requestInit = {
        ...(transportOpts.requestInit ?? {}),
        headers: {
          ...(transportOpts.requestInit?.headers ?? {}),
          ...requestHeaders,
        },
      };
    }

    if (authConfig?.type === 'oauth' && authConfig.authProvider) {
      transportOpts.authProvider = authConfig.authProvider;
      const oauthFetch = authConfig.enforcePublicHttpUrl ? createPublicOAuthFetch() : fetch;
      transportOpts.fetch = createOAuthProviderAwareFetch(authConfig.authProvider, oauthFetch);
    }

    const transport = new StreamableHTTPClientTransport(new URL(finalUrl), transportOpts);
    await client.connect(transport);
    return { client, transport, serverUrl: finalUrl };
  } else {
    // Stdio transport — parse command string
    const parts = serverArg.split(/\s+/);
    const command = parts[0];
    const cmdArgs = parts.slice(1);
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

    const transportOpts = {
      command,
      args: cmdArgs,
      stderr: 'pipe',
      ...(authConfig?.env ? { env: { ...process.env, ...authConfig.env } } : {}),
      ...(authConfig?.cwd ? { cwd: authConfig.cwd } : {}),
    };

    const transport = new StdioClientTransport(transportOpts);

    // Buffer stderr lines so we can surface them on connection failure,
    // while still printing them in real time (preserving the SDK's default
    // 'inherit' behavior for interactive use).
    const stderrOutput = [];
    const MAX_STDERR_LINES = 50;
    if (transport.stderr) {
      transport.stderr.on('data', (chunk) => {
        process.stderr.write(chunk);
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (line) {
            stderrOutput.push(line);
            if (stderrOutput.length > MAX_STDERR_LINES) {
              stderrOutput.shift();
            }
          }
        }
      });
    }

    try {
      await client.connect(transport);
    } catch (err) {
      // Attach captured stderr so callers can surface it for diagnostics.
      err._stderrOutput = stderrOutput;
      // Clean up the spawned process so it doesn't linger.
      try {
        await transport.close();
      } catch {
        /* best-effort */
      }
      throw err;
    }
    return { client, transport, stderrOutput };
  }
}

function defaultLiveMcpServerUrl(serverUrl) {
  try {
    const url = new URL(serverUrl);
    const mcpPath = url.pathname.replace(/\/$/, '');
    if (!mcpPath.endsWith('/mcp')) return undefined;
    url.pathname = `${mcpPath}/live`;
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Discover tools and resources from the MCP server and build Simulation objects.
 * @param {import('@modelcontextprotocol/sdk/client/index.js').Client} client
 * @returns {Promise<Record<string, object>>} Map of simulation name → Simulation-shaped objects
 */
async function discoverSimulations(client) {
  const { tools } = await client.listTools();

  // Try to list resources (server may not support them)
  let resources = [];
  try {
    const result = await client.listResources();
    resources = result.resources || [];
  } catch {
    // Server doesn't support resources — that's fine
  }

  // Build resource URI map
  const resourceByUri = new Map();
  for (const resource of resources) {
    resourceByUri.set(resource.uri, resource);
  }

  const simulations = {};

  for (const tool of tools) {
    const simName = tool.name;

    // Match tool to resource via _meta.ui.resourceUri (MCP Apps extension).
    // Supports both nested format (_meta.ui.resourceUri) and deprecated flat
    // format (_meta["ui/resourceUri"]).
    let resource;
    let resourceUrl;
    const uri = tool._meta?.ui?.resourceUri ?? tool._meta?.['ui/resourceUri'];
    if (uri) {
      resource = resourceByUri.get(uri);
      // Always create a resource URL when a tool declares a resourceUri,
      // even if it wasn't found in listResources(). The server may use
      // resource templates (e.g., ui://counter/{ui}) that resolve dynamically.
      // The /__sunpeak/read-resource endpoint calls client.readResource()
      // which handles template resolution server-side.
      resourceUrl = `/__sunpeak/read-resource?uri=${encodeURIComponent(uri)}`;
      // Create a synthetic resource object when not found via listResources().
      // The inspector UI needs .resource to include the tool in the simulation list.
      if (!resource) {
        resource = {
          uri,
          name: tool.name,
          title: tool.title || tool.name,
          mimeType: 'text/html',
        };
      }
    }

    simulations[simName] = {
      name: simName,
      tool,
      resource,
      resourceUrl,
    };
  }

  return simulations;
}

function createInspectorRequestToken() {
  return randomBytes(32).toString('base64url');
}

function appendInspectorRequestToken(resourceUrl, requestToken) {
  if (!resourceUrl || !requestToken) return resourceUrl;
  try {
    const parsed = new URL(resourceUrl, 'http://sunpeak.local');
    parsed.searchParams.set('__sunpeak_token', requestToken);
    if (resourceUrl.startsWith('http://') || resourceUrl.startsWith('https://')) {
      return parsed.toString();
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return resourceUrl;
  }
}

function isInspectorRequestTokenValid(req, requestToken) {
  if (!requestToken) return true;
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('__sunpeak_token') === requestToken;
}

function addInspectorRequestTokenToSimulations(simulations, requestToken) {
  if (!requestToken || !simulations || typeof simulations !== 'object') return simulations;
  return Object.fromEntries(
    Object.entries(simulations).map(([name, sim]) => {
      if (!sim || typeof sim !== 'object' || typeof sim.resourceUrl !== 'string') {
        return [name, sim];
      }
      return [
        name,
        {
          ...sim,
          resourceUrl: appendInspectorRequestToken(sim.resourceUrl, requestToken),
        },
      ];
    })
  );
}

/**
 * Load simulation JSON fixtures from a directory and merge into discovered simulations.
 *
 * Each fixture becomes a simulation keyed by its filename, so a tool can have
 * multiple fixtures (e.g. `show-albums.json` and `show-albums-empty.json`
 * both targeting tool `show-albums`). Auto-discovered slots are kept only for
 * tools that have no fixture file.
 *
 * @param {string} dir - Simulation directory path
 * @param {Record<string, object>} simulations - Discovered simulations to merge into
 */
export function mergeSimulationFixtures(dir, simulations) {
  if (!existsSync(dir)) return;

  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

  // Load every fixture first so we can group by tool name. We need the grouping
  // to decide whether to keep the auto-discovered slot (no fixtures) or replace
  // it with one entry per fixture file (one or more fixtures).
  const fixtures = [];
  for (const file of files) {
    try {
      const fixture = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
      if (!fixture.tool) continue;
      fixtures.push({ file, fixture });
    } catch (err) {
      console.warn(`Warning: Failed to parse simulation fixture ${file}:`, err.message);
    }
  }

  const byTool = new Map();
  for (const item of fixtures) {
    const tool = item.fixture.tool;
    if (!byTool.has(tool)) byTool.set(tool, []);
    byTool.get(tool).push(item);
  }

  for (const [toolName, items] of byTool) {
    const discovered = simulations[toolName];

    // Drop the auto-discovered slot if none of the fixtures will reuse its
    // key (filename === tool name). Otherwise the named fixture overwrites
    // it in place below.
    const reusesSlot = items.some(({ file }) => file.replace(/\.json$/, '') === toolName);
    if (discovered && !reusesSlot) {
      delete simulations[toolName];
    }

    for (const { file, fixture } of items) {
      const simName = file.replace(/\.json$/, '');
      const sim = discovered
        ? { ...discovered, name: simName }
        : {
            name: simName,
            tool: { name: toolName, inputSchema: { type: 'object' } },
          };
      if (fixture.toolInput !== undefined) sim.toolInput = fixture.toolInput;
      if (fixture.toolResult !== undefined) sim.toolResult = fixture.toolResult;
      if (fixture.serverTools !== undefined) sim.serverTools = fixture.serverTools;
      if (fixture.userMessage !== undefined) sim.userMessage = fixture.userMessage;
      if (fixture.hostContext !== undefined) sim.hostContext = fixture.hostContext;
      simulations[simName] = sim;
    }
  }
}

const MODEL_PROVIDERS = new Set(['openai', 'anthropic']);
const CREDENTIAL_SERVICE = 'sunpeak.inspector.api-key';
const CREDENTIAL_COMMAND_TIMEOUT_MS = 5000;
const MODEL_KEY_BODY_LIMIT_BYTES = 64 * 1024;
const MODEL_CHAT_BODY_LIMIT_BYTES = 512 * 1024;
const RESOURCE_SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-downloads';
const memoryApiKeys = new Map();

function assertModelProvider(provider) {
  if (!MODEL_PROVIDERS.has(provider)) {
    throw new Error('Unsupported provider. Expected "openai" or "anthropic".');
  }
}

function keychainAccount(provider) {
  return `sunpeak-inspector-${provider}`;
}

function quoteSecurityInteractiveArg(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function isMissingCredentialError(err) {
  const text = `${err?.message ?? ''}\n${err?.stderr ?? ''}`.toLowerCase();
  return (
    err?.code === 3 ||
    err?.code === 44 ||
    text.includes('could not be found') ||
    text.includes('no such secret') ||
    text.includes('no matching items')
  );
}

function credentialAccessError(storage, operation) {
  return new Error(`Failed to ${operation} API key in ${storage}.`);
}

async function runCredentialCommand(
  command,
  args,
  { input, timeout = CREDENTIAL_COMMAND_TIMEOUT_MS } = {}
) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      rejectPromise(new Error(`${path.basename(command)} timed out`));
    }, timeout);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise({ stdout, stderr });
      } else {
        const err = new Error(
          stderr.trim() || `${path.basename(command)} exited with code ${code}`
        );
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        rejectPromise(err);
      }
    });
    if (typeof input === 'string') child.stdin.end(input);
    else child.stdin.end();
  });
}

async function commandExists(command) {
  return await new Promise((resolvePromise) => {
    const child = execFile(
      process.platform === 'win32' ? 'where.exe' : 'which',
      [command],
      { windowsHide: true },
      (err) => resolvePromise(!err)
    );
    child.stdin?.end();
  });
}

async function getPowerShellCommand() {
  if (await commandExists('powershell.exe')) return 'powershell.exe';
  if (await commandExists('pwsh.exe')) return 'pwsh.exe';
  if (await commandExists('pwsh')) return 'pwsh';
  return undefined;
}

function getWindowsCredentialPath(provider) {
  const baseDir =
    process.env.LOCALAPPDATA || process.env.APPDATA || path.join(homedir(), 'AppData', 'Local');
  return path.join(baseDir, 'Sunpeak', 'inspector-api-keys', `${provider}.txt`);
}

async function readMacOSKeychain(provider) {
  let stdout;
  try {
    ({ stdout } = await runCredentialCommand('/usr/bin/security', [
      'find-generic-password',
      '-a',
      keychainAccount(provider),
      '-s',
      CREDENTIAL_SERVICE,
      '-w',
    ]));
  } catch (err) {
    if (isMissingCredentialError(err)) return undefined;
    throw err;
  }
  const value = stdout.replace(/\r?\n$/, '');
  return value || undefined;
}

async function writeMacOSKeychain(provider, apiKey) {
  if (!apiKey) {
    try {
      await runCredentialCommand('/usr/bin/security', [
        'delete-generic-password',
        '-a',
        keychainAccount(provider),
        '-s',
        CREDENTIAL_SERVICE,
      ]);
    } catch (err) {
      if (!isMissingCredentialError(err)) throw err;
    }
    return;
  }

  const command = [
    'add-generic-password',
    '-a',
    quoteSecurityInteractiveArg(keychainAccount(provider)),
    '-s',
    quoteSecurityInteractiveArg(CREDENTIAL_SERVICE),
    '-U',
    '-w',
    quoteSecurityInteractiveArg(apiKey),
  ].join(' ');
  await runCredentialCommand('/usr/bin/security', ['-i'], { input: `${command}\n` });
}

async function readLinuxSecretService(provider) {
  let stdout;
  try {
    ({ stdout } = await runCredentialCommand('secret-tool', [
      'lookup',
      'service',
      CREDENTIAL_SERVICE,
      'account',
      keychainAccount(provider),
    ]));
  } catch (err) {
    if (isMissingCredentialError(err)) return undefined;
    throw err;
  }
  const value = stdout.replace(/\r?\n$/, '');
  return value || undefined;
}

async function writeLinuxSecretService(provider, apiKey) {
  if (!apiKey) {
    try {
      await runCredentialCommand('secret-tool', [
        'clear',
        'service',
        CREDENTIAL_SERVICE,
        'account',
        keychainAccount(provider),
      ]);
    } catch (err) {
      if (!isMissingCredentialError(err)) throw err;
    }
    return;
  }

  await runCredentialCommand(
    'secret-tool',
    [
      'store',
      '--label',
      `Sunpeak inspector ${provider} API key`,
      'service',
      CREDENTIAL_SERVICE,
      'account',
      keychainAccount(provider),
    ],
    { input: apiKey }
  );
}

async function readWindowsDpapiSecret(provider) {
  const powershell = await getPowerShellCommand();
  if (!powershell) throw new Error('PowerShell is not available');
  const script = `
$ErrorActionPreference = 'Stop'
$file = $args[0]
if (-not (Test-Path -LiteralPath $file)) { exit 3 }
$encrypted = Get-Content -LiteralPath $file -Raw
$secure = ConvertTo-SecureString $encrypted
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
`;
  const { stdout } = await runCredentialCommand(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', script, getWindowsCredentialPath(provider)],
    { timeout: 10000 }
  ).catch((err) => {
    if (isMissingCredentialError(err)) return { stdout: '' };
    throw err;
  });
  return stdout || undefined;
}

async function writeWindowsDpapiSecret(provider, apiKey) {
  const file = getWindowsCredentialPath(provider);
  if (!apiKey) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
    return;
  }

  const powershell = await getPowerShellCommand();
  if (!powershell) throw new Error('PowerShell is not available');
  const script = `
$ErrorActionPreference = 'Stop'
$file = $args[0]
$secret = [Console]::In.ReadToEnd()
$secure = ConvertTo-SecureString $secret -AsPlainText -Force
$encrypted = ConvertFrom-SecureString $secure
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $file)) | Out-Null
Set-Content -LiteralPath $file -Value $encrypted -NoNewline
`;
  await runCredentialCommand(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', script, file],
    { input: apiKey, timeout: 10000 }
  );
}

async function getOsCredentialAdapter() {
  if (process.platform === 'darwin' && existsSync('/usr/bin/security')) {
    return {
      storage: 'macOS Keychain',
      read: readMacOSKeychain,
      write: writeMacOSKeychain,
    };
  }

  if (process.platform === 'linux' && (await commandExists('secret-tool'))) {
    return {
      storage: 'Linux Secret Service',
      read: readLinuxSecretService,
      write: writeLinuxSecretService,
    };
  }

  if (process.platform === 'win32' && (await getPowerShellCommand())) {
    return {
      storage: 'Windows DPAPI file',
      read: readWindowsDpapiSecret,
      write: writeWindowsDpapiSecret,
    };
  }

  return undefined;
}

function getFallbackKeyPath() {
  return path.join(homedir(), '.sunpeak', 'inspector-api-keys.json');
}

function readFallbackKeys() {
  const file = getFallbackKeyPath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return {};
  }
}

function writeFallbackKeys(keys) {
  const file = getFallbackKeyPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

function clearFallbackStoredApiKey(provider) {
  memoryApiKeys.delete(provider);
  if (process.env.SUNPEAK_INSECURE_FILE_KEY_STORE !== 'true') return;
  const keys = readFallbackKeys();
  if (Object.prototype.hasOwnProperty.call(keys, provider)) {
    delete keys[provider];
    writeFallbackKeys(keys);
  }
}

async function readStoredApiKey(provider) {
  assertModelProvider(provider);
  const adapter = await getOsCredentialAdapter();
  if (adapter) {
    try {
      const apiKey = await adapter.read(provider);
      if (apiKey) return apiKey;
    } catch {
      throw credentialAccessError(adapter.storage, 'read');
    }
    return undefined;
  }

  if (process.env.SUNPEAK_INSECURE_FILE_KEY_STORE === 'true') {
    const keys = readFallbackKeys();
    return typeof keys[provider] === 'string' ? keys[provider] : undefined;
  }

  return memoryApiKeys.get(provider);
}

function normalizeApiKey(apiKey) {
  const trimmed = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    throw new Error('API key cannot contain control characters.');
  }
  return trimmed;
}

async function writeStoredApiKey(provider, apiKey) {
  assertModelProvider(provider);
  const trimmed = normalizeApiKey(apiKey);

  const adapter = await getOsCredentialAdapter();
  if (adapter) {
    try {
      await adapter.write(provider, trimmed);
      clearFallbackStoredApiKey(provider);
      return { hasKey: !!trimmed, storage: adapter.storage };
    } catch {
      throw credentialAccessError(adapter.storage, trimmed ? 'save' : 'clear');
    }
  }

  if (process.env.SUNPEAK_INSECURE_FILE_KEY_STORE === 'true') {
    const keys = readFallbackKeys();
    if (trimmed) keys[provider] = trimmed;
    else delete keys[provider];
    writeFallbackKeys(keys);
    return { hasKey: !!trimmed, storage: '0600 file' };
  }

  if (trimmed) memoryApiKeys.set(provider, trimmed);
  else memoryApiKeys.delete(provider);
  return { hasKey: !!trimmed, storage: 'this process' };
}

async function getApiKeyStatus(provider) {
  assertModelProvider(provider);
  const adapter = await getOsCredentialAdapter();
  const storage =
    adapter?.storage ||
    (process.env.SUNPEAK_INSECURE_FILE_KEY_STORE === 'true' ? '0600 file' : 'this process');
  return {
    hasKey: !!(await readStoredApiKey(provider)),
    storage,
  };
}

function isToolVisibleToModel(tool) {
  const visibility = tool?._meta?.ui?.visibility ?? tool?._meta?.['ui/visibility'];
  if (visibility == null) return true;
  return Array.isArray(visibility) && visibility.includes('model');
}

function getModelCallableTools(tools) {
  return tools.filter((tool) => isToolVisibleToModel(tool));
}

function toolRendersApp(tool) {
  return !!(tool?._meta?.ui?.resourceUri ?? tool?._meta?.['ui/resourceUri']);
}

function sanitizeAiSdkSchemaNode(schema) {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeAiSdkSchemaNode(item));
  }
  if (!schema || typeof schema !== 'object') return schema;

  const clean = { ...schema };
  delete clean.$schema;
  if (
    clean.properties &&
    typeof clean.properties === 'object' &&
    !Array.isArray(clean.properties)
  ) {
    clean.properties = Object.fromEntries(
      Object.entries(clean.properties).map(([key, value]) => [key, sanitizeAiSdkSchemaNode(value)])
    );
  }
  if (clean.items !== undefined) {
    clean.items = sanitizeAiSdkSchemaNode(clean.items);
  }
  for (const key of ['anyOf', 'allOf', 'oneOf']) {
    if (Array.isArray(clean[key])) {
      clean[key] = clean[key].map((item) => sanitizeAiSdkSchemaNode(item));
    }
  }

  const isObjectSchema = clean.type === 'object' || clean.properties != null;
  if (isObjectSchema) {
    if (!clean.type) clean.type = 'object';
    if (!clean.properties) clean.properties = {};
    clean.additionalProperties = false;
    return clean;
  }

  if (
    clean.additionalProperties != null &&
    typeof clean.additionalProperties === 'object' &&
    Object.keys(clean.additionalProperties).length === 0
  ) {
    delete clean.additionalProperties;
  }
  return clean;
}

export function sanitizeAiSdkSchema(schema) {
  const clean = sanitizeAiSdkSchemaNode(schema || { type: 'object', properties: {} });
  if (!clean.type) clean.type = 'object';
  if (!clean.properties) clean.properties = {};
  clean.additionalProperties = false;
  return clean;
}

function normalizeModelId(modelId) {
  if (typeof modelId !== 'string') {
    throw new Error('Missing model ID.');
  }
  const trimmed = modelId.trim();
  if (!trimmed) {
    throw new Error('Missing model ID.');
  }
  if (trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error('Invalid model ID.');
  }
  return trimmed;
}

function normalizeModelProviderModelId(provider, modelId) {
  const normalizedModelId = normalizeModelId(modelId);
  if (
    provider === 'anthropic' &&
    /^claude-\d+(?:-\d+)+-(opus|sonnet|haiku)$/i.test(normalizedModelId)
  ) {
    throw new Error(
      `Unsupported Anthropic model ID "${normalizedModelId}". Use an Anthropic API model ID such as "claude-sonnet-4-20250514".`
    );
  }
  return normalizedModelId;
}

function normalizeModelConversationId(conversationId) {
  if (typeof conversationId !== 'string') return undefined;
  const trimmed = conversationId.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error('Invalid model conversation ID.');
  }
  return trimmed;
}

async function createModelInstance(provider, modelId, apiKey) {
  assertModelProvider(provider);
  const normalizedModelId = normalizeModelProviderModelId(provider, modelId);
  if (provider === 'openai') {
    const { createOpenAI } = await import('@ai-sdk/openai');
    const openai = createOpenAI({ apiKey });
    const settings = { structuredOutputs: false };
    return typeof openai.chat === 'function'
      ? openai.chat(normalizedModelId, settings)
      : openai(normalizedModelId, settings);
  }
  const { createAnthropic } = await import('@ai-sdk/anthropic');
  return createAnthropic({ apiKey })(normalizedModelId);
}

const MODEL_VISIBLE_JSON_LIMIT_BYTES = 20000;

function formatJsonForModel(value) {
  const json = JSON.stringify(value);
  if (json.length <= MODEL_VISIBLE_JSON_LIMIT_BYTES) return json;
  return `${json.slice(0, MODEL_VISIBLE_JSON_LIMIT_BYTES)}...`;
}

function normalizeModelChatHost(host) {
  if (host === 'chatgpt' || host === 'claude') return host;
  return 'generic';
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function normalizeToolArguments(args) {
  return isPlainObject(args) ? args : {};
}

function normalizeModelAppContext(appContext) {
  if (!appContext || typeof appContext !== 'object') return undefined;
  const normalized = {};
  if (Array.isArray(appContext.content) && appContext.content.length > 0) {
    normalized.content = appContext.content;
  }
  if (appContext.structuredContent !== undefined) {
    normalized.structuredContent = appContext.structuredContent;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function formatSharedAppContextForModel(appContext) {
  const normalized = normalizeModelAppContext(appContext);
  if (!normalized) return '';
  return formatJsonForModel(normalized);
}

function normalizeModelChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) => message?.role === 'user' || message?.role === 'assistant')
    .map((message) => ({
      role: message.role,
      content: String(message.content ?? '')
        .slice(0, 20000)
        .trim(),
    }))
    .filter((message) => message.content.length > 0);
}

function getToolErrorText(tool, result) {
  const toolName = tool?.name || 'MCP tool';
  const text = (result?.content || [])
    .filter((part) => part && typeof part === 'object' && part.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n')
    .trim();
  if (text) return text;
  if (result?.structuredContent !== undefined) {
    return formatJsonForModel({ structuredContent: result.structuredContent });
  }
  return text || `${toolName} returned an error.`;
}

function formatModelVisibleToolError(tool, result, { host, arguments: args, toolCallId } = {}) {
  const toolName = tool?.name || 'MCP tool';
  const errorText = getToolErrorText(tool, result);
  const id = typeof toolCallId === 'string' && toolCallId.trim() ? toolCallId : toolName;

  switch (normalizeModelChatHost(host)) {
    case 'chatgpt':
      return {
        type: 'mcp_call',
        id,
        name: toolName,
        arguments: normalizeToolArguments(args),
        error: errorText,
        output: null,
        status: 'failed',
      };
    case 'claude':
      return {
        type: 'mcp_tool_result',
        tool_use_id: id,
        is_error: true,
        content: [{ type: 'text', text: errorText }],
      };
    default:
      return {
        isError: true,
        content: [{ type: 'text', text: errorText }],
      };
  }
}

function formatModelVisibleToolResult(tool, result, options = {}) {
  const toolName = tool?.name || 'MCP tool';
  if (result?.isError) {
    if (options.host) return formatModelVisibleToolError(tool, result, options);
    return getToolErrorText(tool, result);
  }

  const visibleResult = {};
  if (Array.isArray(result?.content) && result.content.length > 0) {
    visibleResult.content = result.content;
  }
  if (result?.structuredContent !== undefined) {
    visibleResult.structuredContent = result.structuredContent;
  }
  return Object.keys(visibleResult).length > 0
    ? formatJsonForModel(visibleResult)
    : toolRendersApp(tool)
      ? `${toolName} completed. The MCP App is ready to render.`
      : `${toolName} completed.`;
}

function errorToMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'Unknown MCP tool error');
}

function createModelChatToolErrorResult(error) {
  const message = errorToMessage(error);
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

async function executeModelChatToolCall({ client, name, arguments: args }) {
  const safeArgs = normalizeToolArguments(args);
  try {
    return {
      arguments: safeArgs,
      result: await client.callTool({ name, arguments: safeArgs }),
      source: 'mcp',
    };
  } catch (error) {
    return {
      arguments: safeArgs,
      result: createModelChatToolErrorResult(error),
      source: 'mcp',
    };
  }
}

function getModelChatHostInstructions(host) {
  switch (normalizeModelChatHost(host)) {
    case 'chatgpt':
      return 'ChatGPT surfaces failed MCP calls as mcp_call items with an error field. When a tool result object has type "mcp_call", status "failed", or a non-empty error field, treat it as a failed MCP call, not a successful result.';
    case 'claude':
      return 'Claude surfaces failed MCP calls as mcp_tool_result blocks with is_error=true. When a tool result object has type "mcp_tool_result" and is_error is true, treat it as a failed MCP call, not a successful result.';
    default:
      return 'MCP tool failures are model-visible tool results. When a tool result has isError=true or describes a failed MCP call, treat it as a failed tool call, not a successful result.';
  }
}

function getModelChatRetryInstructions() {
  return 'After a failed MCP tool call, use the error text to decide the next step. Retry with corrected arguments for validation or business-logic errors. For transient service, timeout, or connectivity errors, you may retry once if the user request still needs the tool. Do not repeat the same failing tool call with the same arguments more than once.';
}

async function runModelChat({
  client,
  provider,
  modelId,
  messages,
  apiKey,
  appContext,
  host,
  conversationId,
}) {
  assertModelProvider(provider);
  const normalizedHost = normalizeModelChatHost(host);
  const { generateText, tool: aiTool, jsonSchema } = await import('ai');
  const model = await createModelInstance(provider, modelId, apiKey);
  const { tools: mcpTools } = await client.listTools();
  const capturedToolCalls = [];
  const tools = {};

  for (const mcpTool of getModelCallableTools(mcpTools)) {
    tools[mcpTool.name] = aiTool({
      description: mcpTool.description || mcpTool.title || '',
      inputSchema: jsonSchema(sanitizeAiSdkSchema(mcpTool.inputSchema)),
      parameters: jsonSchema(sanitizeAiSdkSchema(mcpTool.inputSchema)),
      execute: async (args, options) => {
        const { arguments: safeArgs, result } = await executeModelChatToolCall({
          client,
          name: mcpTool.name,
          arguments: args,
        });
        capturedToolCalls.push({
          name: mcpTool.name,
          arguments: safeArgs,
          result,
          isError: !!result?.isError,
        });
        return formatModelVisibleToolResult(mcpTool, result, {
          host: normalizedHost,
          arguments: safeArgs,
          toolCallId: options?.toolCallId,
        });
      },
    });
  }

  const sharedAppContext = formatSharedAppContextForModel(appContext);

  const result = await generateText({
    model,
    tools,
    system: [
      'You are chatting inside the sunpeak Inspector. When you call an MCP tool that renders an app, the host will render the app below your message. Do not repeat raw tool output, JSON, image URLs, markdown image lists, or full item inventories. Keep any narration brief and let the app carry the visual result.',
      getModelChatHostInstructions(normalizedHost),
      getModelChatRetryInstructions(),
      sharedAppContext
        ? `Shared MCP App context from the currently rendered app, available for this turn:\n${sharedAppContext}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    messages: normalizeModelChatMessages(messages),
    // AI SDK v4 can send an empty assistant text block to Anthropic when a
    // tool-only response is followed by another model step. We only need the
    // tool result for inspector rendering, so skip that follow-up call.
    maxSteps: provider === 'anthropic' ? 1 : 5,
    maxRetries: 0,
  });

  return {
    ...(conversationId ? { conversationId } : {}),
    text: result.text || '',
    toolCalls: capturedToolCalls,
    finishReason: result.finishReason,
    usage: result.usage,
  };
}

/**
 * Vite plugin that serves virtual modules for the inspect entry point.
 *
 * @param {Record<string, object>} simulations - Simulation objects
 * @param {string} serverUrl - MCP server URL
 * @param {string} appName - Display name
 * @param {string|null} appIcon - Icon URL or emoji
 * @param {string} sandboxUrl - Sandbox server URL
 * @param {string} requestToken - Unguessable token for frameable inspector resource URLs
 * @param {{ defaultProdResources?: boolean, hideInspectorModes?: boolean }} [modeFlags] - Mode toggles
 */
function sunpeakInspectVirtualPlugin(
  simulations,
  serverUrl,
  appName,
  appIcon,
  sandboxUrl,
  requestToken,
  modeFlags = {}
) {
  const ENTRY_ID = 'virtual:sunpeak-inspect-entry';
  const RESOLVED_ENTRY_ID = '\0' + ENTRY_ID;

  return {
    name: 'sunpeak-inspect-virtual',
    resolveId(id) {
      if (id === ENTRY_ID) return RESOLVED_ENTRY_ID;
    },
    load(id) {
      if (id !== RESOLVED_ENTRY_ID) return;

      return `
import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Inspector } from 'sunpeak/inspector';
import 'sunpeak/style.css';

const simulations = ${JSON.stringify(addInspectorRequestTokenToSimulations(simulations, requestToken))};
const appName = ${JSON.stringify(appName ?? 'MCP Inspector')};
const appIcon = ${JSON.stringify(appIcon ?? null)};
const sandboxUrl = ${JSON.stringify(sandboxUrl)};
const defaultProdResources = ${JSON.stringify(modeFlags.defaultProdResources ?? false)};
const hideInspectorModes = ${JSON.stringify(modeFlags.hideInspectorModes ?? false)};

const onCallTool = async (params) => {
  const res = await fetch('/__sunpeak/call-tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
};

const onCallToolDirect = async (params) => {
  const res = await fetch('/__sunpeak/call-tool-direct', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
};

const onCallToolLive = async (params) => {
  const res = await fetch('/__sunpeak/call-tool-live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
};

const root = createRoot(document.getElementById('root'));
root.render(
  createElement(StrictMode, null,
    createElement(Inspector, {
      simulations,
      mcpServerUrl: ${JSON.stringify(serverUrl)},
      appName,
      appIcon,
      sandboxUrl,
      onCallTool,
      onCallToolDirect,
      onCallToolLive,
      defaultProdResources,
      hideInspectorModes,
    })
  )
);
`;
    },
  };
}

/**
 * Vite plugin for MCP server proxy endpoints.
 * @param {() => import('@modelcontextprotocol/sdk/client/index.js').Client} getClient
 * @param {(client: import('@modelcontextprotocol/sdk/client/index.js').Client) => void} setClient
 * @param {{ callToolDirect?: (name: string, args: Record<string, unknown>) => Promise<object>, simulationsDir?: string | null, serverUrl?: string, liveServerUrl?: string, requestToken?: string }} [pluginOpts]
 */
function sunpeakInspectEndpointsPlugin(getClient, setClient, pluginOpts = {}) {
  // Server URL and options for automatic session recovery.
  // Set by inspectServer() after creating the initial connection.
  let _serverUrl = '';
  let _liveServerUrl = '';
  /** @type {Record<string, unknown>} */
  let _connectionOpts = {};

  /**
   * Check if an error is a dead-session error (MCP server no longer recognizes
   * the session ID). This happens when the MCP server restarts, the session
   * times out, or the connection is interrupted.
   * @param {Error} err
   */
  function isDeadSession(err) {
    const msg = err?.message ?? '';
    return (
      msg.includes('Unknown session') ||
      msg.includes('404') ||
      msg.includes('fetch failed') ||
      msg.includes('MCP request timed out')
    );
  }

  function getMcpRequestTimeoutMs() {
    const raw = process.env.SUNPEAK_INSPECT_MCP_REQUEST_TIMEOUT_MS;
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  async function withMcpRequestTimeout(promise) {
    const timeoutMs = getMcpRequestTimeoutMs();
    if (!timeoutMs) return await promise;

    let timer;
    try {
      return await Promise.race([
        promise.catch((err) => {
          throw err;
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`MCP request timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Attempt to reconnect to the MCP server and replace the current client.
   * Returns true if reconnection succeeded.
   */
  async function tryReconnect() {
    if (!_serverUrl) return false;
    try {
      console.warn(`[inspect] MCP session lost, reconnecting to ${_serverUrl}...`);
      const newConn = await createMcpConnection(_serverUrl, _connectionOpts);
      setClient(newConn.client);
      console.log('[inspect] MCP session re-established');
      return true;
    } catch (err) {
      console.error(`[inspect] MCP reconnection failed: ${err?.message ?? err}`);
      return false;
    }
  }

  // Initialize reconnection state from plugin options.
  if (pluginOpts.serverUrl) _serverUrl = pluginOpts.serverUrl;
  if (pluginOpts.liveServerUrl) _liveServerUrl = pluginOpts.liveServerUrl;
  if (pluginOpts.connectionOpts) _connectionOpts = pluginOpts.connectionOpts;

  function sendTokenedSimulations(res, payload) {
    const body = {
      ...payload,
      ...(payload.simulations
        ? {
            simulations: addInspectorRequestTokenToSimulations(
              payload.simulations,
              pluginOpts.requestToken
            ),
          }
        : {}),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function requireInspectorRequestToken(req, res) {
    if (isInspectorRequestTokenValid(req, pluginOpts.requestToken)) return true;
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden: missing or invalid inspector request token');
    return false;
  }

  async function withModelChatClient(callback) {
    const targetUrl = _liveServerUrl || _serverUrl;
    if (!targetUrl?.startsWith('http://') && !targetUrl?.startsWith('https://')) {
      return await callback(getClient());
    }

    let connection;
    try {
      connection = await createMcpConnection(targetUrl, _connectionOpts);
      return await callback(connection.client);
    } finally {
      try {
        await connection?.transport?.close?.();
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  // In-memory OAuth state keyed by server URL, persisted across reconnects.
  /** @type {Map<string, { provider: any, getAuthUrl: () => URL | undefined, hasTokens: () => boolean, stateParam: string }>} */
  const oauthProviders = new Map();
  // Map OAuth state parameter → { serverUrl, oauthState } for CSRF-safe callback matching.
  // Stores a direct reference to the provider that initiated the flow, so even if
  // oauthProviders[serverUrl] is overwritten by a concurrent flow, the callback
  // still completes with the correct provider (which holds the right codeVerifier
  // and clientInformation).
  /** @type {Map<string, { serverUrl: string, oauthState: any, allowPrivateNetwork: boolean }>} */
  const pendingOAuthFlows = new Map();

  function formatInspectorToolError(error) {
    const oauthState = [...oauthProviders.entries()].find(
      ([url, state]) => url === _serverUrl || state.provider === _connectionOpts.authProvider
    )?.[1];
    const authorizationServers = oauthState?.getAuthorizationServers() ?? [];
    const pendingOAuth = oauthState?.getAuthUrl() || authorizationServers.length > 1;
    return {
      content: [
        {
          type: 'text',
          text: pendingOAuth
            ? 'Additional authorization is required. Click Authorize to continue.'
            : `Error: ${error.message}`,
        },
      ],
      isError: true,
      ...(pendingOAuth
        ? {
            _meta: {
              _sunpeak: {
                oauthRequired: true,
                ...(authorizationServers.length > 1 ? { authorizationServers } : {}),
              },
            },
          }
        : {}),
    };
  }
  /**
   * Reject browser requests that are not same-origin with the inspector.
   * This blocks CSRF, cross-site image/script GETs, and DNS rebinding attacks
   * that would otherwise reach the privileged /__sunpeak/* endpoints.
   * Requests from non-browser clients usually omit Origin and Fetch Metadata
   * headers, so local CLI/test callers continue to work.
   * @param {import('http').IncomingMessage} req
   * @param {import('http').ServerResponse} res
   */
  function requireSameOrigin(req, res, { allowCrossSiteIframeNavigation = false } = {}) {
    const fetchSite = firstHeaderValue(req.headers['sec-fetch-site']);
    if (fetchSite === 'cross-site') {
      const fetchDest = firstHeaderValue(req.headers['sec-fetch-dest']);
      const fetchMode = firstHeaderValue(req.headers['sec-fetch-mode']);
      if (allowCrossSiteIframeNavigation && fetchDest === 'iframe' && fetchMode === 'navigate') {
        return true;
      }
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: cross-site request blocked' }));
      return false;
    }

    const origin = firstHeaderValue(req.headers.origin);
    if (!origin) return true;
    if (!isSameInspectorOrigin(req, origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: cross-origin request blocked' }));
      return false;
    }
    return true;
  }

  return {
    name: 'sunpeak-inspect-endpoints',
    configureServer(server) {
      // List tools from connected server (with automatic session recovery)
      server.middlewares.use('/__sunpeak/list-tools', async (req, res) => {
        if (!requireSameOrigin(req, res)) return;
        try {
          const client = getClient();
          const result = await withMcpRequestTimeout(client.listTools());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          // If the session died (server restarted, timeout, etc.), try to reconnect once.
          if (isDeadSession(err) && (await tryReconnect())) {
            try {
              const result = await withMcpRequestTimeout(getClient().listTools());
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
              return;
            } catch {
              /* fall through to error response */
            }
          }
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      // List resources from connected server
      server.middlewares.use('/__sunpeak/list-resources', async (req, res) => {
        if (!requireSameOrigin(req, res)) return;
        try {
          const client = getClient();
          const result = await client.listResources();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          // Server may not support resources — return empty list
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ resources: [] }));
        }
      });

      // Call tool on connected server
      server.middlewares.use('/__sunpeak/call-tool', async (req, res) => {
        if (!requireSameOrigin(req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }

        let body;
        try {
          body = await readRequestBody(req, { maxBytes: MODEL_KEY_BODY_LIMIT_BYTES });
        } catch (err) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON in request body' }));
          return;
        }

        try {
          const { name, arguments: args } = parsed;
          const client = getClient();
          const result = await withMcpRequestTimeout(client.callTool({ name, arguments: args }));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          // Try reconnecting on dead session before returning error
          if (isDeadSession(err) && (await tryReconnect())) {
            try {
              const { name, arguments: args } = parsed;
              const result = await withMcpRequestTimeout(
                getClient().callTool({ name, arguments: args })
              );
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
              return;
            } catch {
              /* fall through */
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(formatInspectorToolError(err)));
        }
      });

      // Call tool handler directly, bypassing MCP server mock data.
      // Used by the Prod Tools Run button so the real handler executes even
      // when the MCP server would return simulation fixture data.
      server.middlewares.use('/__sunpeak/call-tool-direct', async (req, res) => {
        if (!requireSameOrigin(req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }

        if (!pluginOpts.callToolDirect) {
          // No direct handler available (pure inspect mode) — fall back to MCP
          let body;
          try {
            body = await readRequestBody(req, { maxBytes: MODEL_CHAT_BODY_LIMIT_BYTES });
          } catch (err) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }
          try {
            const client = getClient();
            const result = await client.callTool({
              name: parsed.name,
              arguments: parsed.arguments,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(formatInspectorToolError(err)));
          }
          return;
        }

        let body;
        try {
          body = await readRequestBody(req, { maxBytes: MODEL_CHAT_BODY_LIMIT_BYTES });
        } catch (err) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        try {
          const result = await pluginOpts.callToolDirect(parsed.name, parsed.arguments ?? {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(formatInspectorToolError(err)));
        }
      });

      // Call a tool through the live MCP execution plane. In sunpeak dev this
      // points at /mcp/live, where UI tools execute real handlers even when
      // normal /mcp still serves simulation fixture data.
      server.middlewares.use('/__sunpeak/call-tool-live', async (req, res) => {
        if (!requireSameOrigin(req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }

        let body;
        try {
          body = await readRequestBody(req, { maxBytes: MODEL_CHAT_BODY_LIMIT_BYTES });
        } catch (err) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        try {
          const result = await withModelChatClient((client) =>
            client.callTool({ name: parsed.name, arguments: parsed.arguments ?? {} })
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(formatInspectorToolError(err)));
        }
      });

      // Reconnect to a new MCP server URL.
      // Creates a new MCP client connection and replaces the current one.
      server.middlewares.use('/__sunpeak/connect', async (req, res) => {
        if (!requireSameOrigin(req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }

        let body;
        try {
          body = await readRequestBody(req, { maxBytes: MODEL_KEY_BODY_LIMIT_BYTES });
        } catch (err) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        const url = parsed.url;
        if (!url) {
          // No URL provided — just verify current connection
          try {
            const client = getClient();
            await client.listTools();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // Only http(s) URLs are accepted via the HTTP endpoint. Stdio servers
        // (which spawn child processes) are reachable only by the CLI caller of
        // `inspectServer()`, never by an HTTP client — otherwise a malicious
        // page or untrusted app iframe could trigger arbitrary command
        // execution via this endpoint.
        const allowPrivateNetwork = shouldAllowPrivateServerUrls(req);
        try {
          await assertHttpServerUrlAllowed(url, { allowPrivateNetwork });
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }

        try {
          // Close old connection (best effort)
          try {
            await getClient().close();
          } catch {
            /* ignore */
          }

          // Build auth config from request
          const authConfig = parsed.auth;
          let connectionAuth;
          if (authConfig?.type === 'bearer' && authConfig.bearerToken) {
            connectionAuth = { type: 'bearer', bearerToken: authConfig.bearerToken };
          } else if (authConfig?.type === 'oauth') {
            // Reuse existing OAuth provider if we have one for this server
            const existing = oauthProviders.get(url);
            if (existing?.hasTokens()) {
              connectionAuth = { type: 'oauth', authProvider: existing.provider };
            }
          }

          // Create new connection
          const newConnection = await createMcpConnection(url, {
            ...connectionAuth,
            enforcePublicHttpUrl: !allowPrivateNetwork,
          });
          setClient(newConnection.client);
          _serverUrl = newConnection.serverUrl || url;
          _liveServerUrl = '';
          _connectionOpts = { enforcePublicHttpUrl: !allowPrivateNetwork };
          if (connectionAuth) {
            _connectionOpts = { ..._connectionOpts, ...connectionAuth };
          }

          // Discover tools and resources from the new server
          const simulations = await discoverSimulations(newConnection.client);
          // Merge fixture data so simulations have mock toolInput/toolResult
          if (pluginOpts.simulationsDir) {
            mergeSimulationFixtures(pluginOpts.simulationsDir, simulations);
          }
          sendTokenedSimulations(res, { status: 'ok', simulations });
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      // ── OAuth flow endpoints ──

      server.middlewares.use('/__sunpeak/oauth/reset', async (req, res) => {
        if (!requireSameOrigin(req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(await readRequestBody(req, { maxBytes: MODEL_KEY_BODY_LIMIT_BYTES }));
        } catch (err) {
          res.writeHead(err instanceof SyntaxError ? 400 : 413, {
            'Content-Type': 'application/json',
          });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        const serverUrl = parsed?.url;
        if (!serverUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing url' }));
          return;
        }
        const oauthState = oauthProviders.get(serverUrl);
        await oauthState?.provider.invalidateCredentials?.('all');
        oauthProviders.delete(serverUrl);
        for (const [key, value] of pendingOAuthFlows) {
          if (value.serverUrl === serverUrl) pendingOAuthFlows.delete(key);
        }
        if (_connectionOpts.authProvider === oauthState?.provider) {
          _connectionOpts = {
            enforcePublicHttpUrl: _connectionOpts.enforcePublicHttpUrl,
          };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'cleared' }));
      });

      // Start OAuth: discover metadata, register client, return authorization URL
      server.middlewares.use('/__sunpeak/oauth/start', async (req, res) => {
        if (!requireSameOrigin(req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }

        let body;
        try {
          body = await readRequestBody(req, { maxBytes: MODEL_KEY_BODY_LIMIT_BYTES });
        } catch (err) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        const {
          url: serverUrl,
          scope,
          clientId,
          clientSecret,
          clientMetadataUrl,
          tokenEndpointAuthMethod,
          authorizationServer,
        } = parsed;
        if (!serverUrl) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing url' }));
          return;
        }
        if (
          tokenEndpointAuthMethod &&
          !['client_secret_basic', 'client_secret_post', 'none'].includes(tokenEndpointAuthMethod)
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unsupported OAuth token endpoint auth method' }));
          return;
        }
        // Only http(s) URLs are accepted. Without this check a stdio-like
        // string (e.g. "node ./malicious.js") could later reach
        // createMcpConnection's stdio branch via cached pending flow state.
        const allowPrivateNetwork = shouldAllowPrivateServerUrls(req);
        try {
          await assertHttpServerUrlAllowed(serverUrl, { allowPrivateNetwork });
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        if (!allowPrivateNetwork && process.env.SUNPEAK_ALLOW_HOSTED_OAUTH !== 'true') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error:
                'OAuth is disabled for hosted inspector sessions. Set SUNPEAK_ALLOW_HOSTED_OAUTH=true only on trusted deployments.',
            })
          );
          return;
        }

        try {
          // Determine callback URL from the Vite server's address
          const addr = server.httpServer?.address();
          const port = typeof addr === 'object' && addr ? addr.port : 3000;
          const callbackUrl = `http://localhost:${port}/__sunpeak/oauth/callback`;

          // Check if we already have a working provider with tokens for this server.
          // If so, try to connect directly before creating a fresh provider.
          const existingState = oauthProviders.get(serverUrl);
          const providerConfiguration = {
            clientId,
            clientSecret,
            clientMetadataUrl,
            tokenEndpointAuthMethod,
            scope,
          };
          const existingMatchesConfiguration =
            existingState?.matchesConfiguration(providerConfiguration) ?? false;
          const existingMatchesIssuer =
            !authorizationServer || existingState?.getActiveIssuer() === authorizationServer;
          const pendingAuthUrl =
            existingMatchesIssuer && existingMatchesConfiguration
              ? existingState?.getAuthUrl()
              : undefined;
          if (pendingAuthUrl) {
            if (pendingAuthUrl.protocol !== 'http:' && pendingAuthUrl.protocol !== 'https:') {
              throw new Error(
                `OAuth authorization URL has unsupported scheme: ${pendingAuthUrl.protocol}`
              );
            }
            for (const [key, val] of pendingOAuthFlows) {
              if (val.serverUrl === serverUrl) pendingOAuthFlows.delete(key);
            }
            pendingOAuthFlows.set(existingState.stateParam, {
              serverUrl,
              oauthState: existingState,
              allowPrivateNetwork,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'redirect', authUrl: pendingAuthUrl.toString() }));
            return;
          }
          if (existingMatchesIssuer && existingMatchesConfiguration && existingState?.hasTokens()) {
            try {
              // Close old connection (best effort)
              try {
                await getClient().close();
              } catch {
                /* ignore */
              }

              const newConnection = await createMcpConnection(serverUrl, {
                type: 'oauth',
                authProvider: existingState.provider,
                enforcePublicHttpUrl: !allowPrivateNetwork,
              });
              setClient(newConnection.client);
              _serverUrl = newConnection.serverUrl || serverUrl;
              _liveServerUrl = '';
              _connectionOpts = {
                type: 'oauth',
                authProvider: existingState.provider,
                enforcePublicHttpUrl: !allowPrivateNetwork,
              };
              const simulations = await discoverSimulations(newConnection.client);
              if (pluginOpts.simulationsDir) {
                mergeSimulationFixtures(pluginOpts.simulationsDir, simulations);
              }
              sendTokenedSimulations(res, { status: 'authorized', simulations });
              return;
            } catch {
              // Tokens may be expired, fall through to fresh auth below
            }
          }

          const canReuseForIssuerSelection =
            authorizationServer &&
            existingState?.getAuthorizationServers().includes(authorizationServer) &&
            existingState.matchesConfiguration(providerConfiguration);
          const oauthState = canReuseForIssuerSelection
            ? existingState
            : createInMemoryOAuthProvider(callbackUrl, {
                ...providerConfiguration,
                authorizationServer,
              });
          if (canReuseForIssuerSelection) {
            await configureOAuthAuthorizationServer(
              oauthState,
              authorizationServer,
              allowPrivateNetwork ? fetch : createPublicOAuthFetch()
            );
          }
          oauthProviders.set(serverUrl, oauthState);

          // Let the MCP transport see the server's real WWW-Authenticate response.
          // This preserves its resource_metadata and scope values, which take
          // priority over discovery defaults and the user-configured fallback.
          let newConnection;
          try {
            newConnection = await createMcpConnection(serverUrl, {
              type: 'oauth',
              authProvider: oauthState.provider,
              enforcePublicHttpUrl: !allowPrivateNetwork,
            });
          } catch (connectionError) {
            const authorizationServers = oauthState.getAuthorizationServers();
            if (authorizationServers.length > 1 && !authorizationServer) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  status: 'authorization_server_required',
                  authorizationServers,
                })
              );
              return;
            }
            if (
              authorizationServer &&
              authorizationServers.includes(authorizationServer) &&
              !oauthState.getDiscoveryState()
            ) {
              await configureOAuthAuthorizationServer(
                oauthState,
                authorizationServer,
                allowPrivateNetwork ? fetch : createPublicOAuthFetch()
              );
              try {
                newConnection = await createMcpConnection(serverUrl, {
                  type: 'oauth',
                  authProvider: oauthState.provider,
                  enforcePublicHttpUrl: !allowPrivateNetwork,
                });
              } catch {
                if (!oauthState.getAuthUrl()) throw connectionError;
              }
            }
            if (!newConnection && !oauthState.getAuthUrl()) {
              // Some servers return a successful non-metadata page at the
              // endpoint-specific well-known path. Keep the root fallback for
              // that compatibility case when no challenge URL was captured.
              const resourceMetadataUrl = await resolveMcpResourceMetadataUrl(serverUrl);
              const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
              await auth(oauthState.provider, {
                serverUrl,
                scope,
                ...(resourceMetadataUrl
                  ? { resourceMetadataUrl: new URL(resourceMetadataUrl) }
                  : {}),
                fetchFn: createOAuthProviderAwareFetch(
                  oauthState.provider,
                  allowPrivateNetwork ? fetch : createPublicOAuthFetch()
                ),
              });
            }
          }

          const authUrl = oauthState.getAuthUrl();
          if (authUrl) {
            // Reject non-http(s) authorization URLs. A malicious MCP server can
            // publish OAuth metadata whose `authorization_endpoint` is a
            // `javascript:` URL; if we forwarded that to the client, the popup
            // navigation would execute attacker JS in the inspector's origin.
            if (authUrl.protocol !== 'http:' && authUrl.protocol !== 'https:') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: `OAuth authorization URL has unsupported scheme: ${authUrl.protocol}`,
                })
              );
              return;
            }
            // Register the state parameter so the callback can find the right provider.
            // Clean up any stale pending flows for the same server URL first
            // (e.g., user closed the popup without completing the previous attempt).
            for (const [key, val] of pendingOAuthFlows) {
              if (val.serverUrl === serverUrl) pendingOAuthFlows.delete(key);
            }
            pendingOAuthFlows.set(oauthState.stateParam, {
              serverUrl,
              oauthState,
              allowPrivateNetwork,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'redirect', authUrl: authUrl.toString() }));
          } else if (newConnection) {
            // The transport either completed a non-interactive grant or the
            // resource did not require authorization.
            try {
              await getClient().close();
            } catch {
              /* ignore */
            }
            setClient(newConnection.client);
            _serverUrl = newConnection.serverUrl || serverUrl;
            _liveServerUrl = '';
            _connectionOpts = {
              type: 'oauth',
              authProvider: oauthState.provider,
              enforcePublicHttpUrl: !allowPrivateNetwork,
            };
            const simulations = await discoverSimulations(newConnection.client);
            if (pluginOpts.simulationsDir) {
              mergeSimulationFixtures(pluginOpts.simulationsDir, simulations);
            }
            sendTokenedSimulations(res, { status: 'authorized', simulations });
          } else {
            throw new Error('OAuth flow did not produce an authorization redirect or connection');
          }
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      // OAuth callback: serves an HTML page that sends the code back to the inspector.
      // The state parameter is validated server-side in /__sunpeak/oauth/complete.
      server.middlewares.use('/__sunpeak/oauth/callback', async (req, res) => {
        // Parse code + state from query params
        const reqUrl = new URL(req.url, 'http://localhost');
        const code = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');
        const error = reqUrl.searchParams.get('error');
        const errorDescription = reqUrl.searchParams.get('error_description');
        const errorUri = reqUrl.searchParams.get('error_uri');
        const issuer = reqUrl.searchParams.get('iss');

        // Escape values for safe embedding in <script> — JSON.stringify alone
        // doesn't escape "</script>" sequences which would break out of the tag.
        const safeJson = (val) => JSON.stringify(val).replace(/</g, '\\u003c');

        const html = `<!DOCTYPE html>
<html><head><title>OAuth Callback</title></head>
<body>
<script>
(function() {
  var code = ${safeJson(code)};
  var state = ${safeJson(state)};
  var error = ${safeJson(error)};
  var errorDescription = ${safeJson(errorDescription)};
  var errorUri = ${safeJson(errorUri)};
  var issuer = ${safeJson(issuer)};

  // Use our own origin as the postMessage targetOrigin to prevent leaking data cross-origin.
  var origin = location.origin;

  // Send a message to the opener window. Uses postMessage when window.opener is
  // available, falls back to BroadcastChannel for OAuth providers that set
  // Cross-Origin-Opener-Policy (COOP) which nullifies window.opener.
  function notify(msg) {
    if (window.opener) {
      window.opener.postMessage(msg, origin);
    } else if (typeof BroadcastChannel !== 'undefined') {
      var bc = new BroadcastChannel('sunpeak-oauth');
      bc.postMessage(msg);
      bc.close();
    }
  }

  document.body.textContent = 'Validating authorization response...';

  // Post the code + state to the server to exchange for tokens.
  // The state is validated server-side to prevent CSRF.
  fetch('/__sunpeak/oauth/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: code,
      state: state,
      error: error,
      errorDescription: errorDescription,
      errorUri: errorUri,
      issuer: issuer
    })
  })
  .then(function(res) { return res.json(); })
  .then(function(data) {
    if (data.error) {
      notify({ type: 'sunpeak-oauth-callback', state: state, error: data.error });
      document.body.textContent = 'Authorization failed: ' + data.error;
    } else {
      notify({
        type: 'sunpeak-oauth-callback',
        state: state,
        success: true,
        simulations: data.simulations
      });
      document.body.textContent = 'Authorized! You can close this window.';
    }
    setTimeout(function() { window.close(); }, 1000);
  })
  .catch(function(err) {
    notify({ type: 'sunpeak-oauth-callback', state: state, error: err.message });
    document.body.textContent = 'Error: ' + err.message;
  });
})();
</script>
</body></html>`;

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });

      // Complete OAuth: exchange authorization code for tokens and connect
      server.middlewares.use('/__sunpeak/oauth/complete', async (req, res) => {
        if (!requireSameOrigin(req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }

        let body;
        try {
          body = await readRequestBody(req, { maxBytes: MODEL_KEY_BODY_LIMIT_BYTES });
        } catch (err) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        const { code, state, error, errorDescription, errorUri, issuer } = parsed;
        if (!state) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing state parameter' }));
          return;
        }

        // Look up the provider via the state parameter (CSRF protection).
        // Uses the direct provider reference from the pending flow, not the
        // oauthProviders map, so concurrent flows for the same server URL
        // don't clobber each other's codeVerifier/clientInformation.
        const pending = pendingOAuthFlows.get(state);
        pendingOAuthFlows.delete(state); // Consume — single-use

        if (!pending) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: 'Invalid or expired OAuth state. Start the flow again.' })
          );
          return;
        }

        const { serverUrl, oauthState, allowPrivateNetwork } = pending;

        let validatedCode;
        try {
          validatedCode = validateOAuthAuthorizationResponse(
            {
              code,
              state,
              error,
              error_description: errorDescription,
              error_uri: errorUri,
              iss: issuer,
            },
            oauthState.stateParam,
            oauthState.getDiscoveryState()
          );
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }

        try {
          // Exchange the code for tokens
          const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
          const result = await auth(oauthState.provider, {
            serverUrl,
            authorizationCode: validatedCode,
            fetchFn: createOAuthProviderAwareFetch(
              oauthState.provider,
              allowPrivateNetwork ? fetch : createPublicOAuthFetch()
            ),
          });

          if (result !== 'AUTHORIZED') {
            throw new Error('Token exchange did not result in authorization');
          }

          // Store the now-authorized provider so reconnects can reuse tokens.
          oauthProviders.set(serverUrl, oauthState);

          // Create MCP connection with the authorized provider
          try {
            await getClient().close();
          } catch {
            /* ignore */
          }
          const newConnection = await createMcpConnection(serverUrl, {
            type: 'oauth',
            authProvider: oauthState.provider,
            enforcePublicHttpUrl: !allowPrivateNetwork,
          });
          setClient(newConnection.client);
          _serverUrl = newConnection.serverUrl || serverUrl;
          _liveServerUrl = '';
          _connectionOpts = {
            type: 'oauth',
            authProvider: oauthState.provider,
            enforcePublicHttpUrl: !allowPrivateNetwork,
          };

          const simulations = await discoverSimulations(newConnection.client);
          if (pluginOpts.simulationsDir) {
            mergeSimulationFixtures(pluginOpts.simulationsDir, simulations);
          }

          sendTokenedSimulations(res, { status: 'ok', simulations });
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      // Store and inspect local model API keys. Keys are never returned to the
      // browser; the UI only receives whether a key exists and where it is kept.
      server.middlewares.use('/__sunpeak/model-key', async (req, res) => {
        if (!requireSameOrigin(req, res)) return;

        if (req.method === 'GET') {
          const url = new URL(req.url, 'http://localhost');
          const provider = url.searchParams.get('provider') || 'openai';
          try {
            const status = await getApiKeyStatus(provider);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(status));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hasKey: false, error: err.message }));
          }
          return;
        }

        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }

        let body;
        try {
          body = await readRequestBody(req, { maxBytes: MODEL_KEY_BODY_LIMIT_BYTES });
        } catch (err) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        try {
          const status = await writeStoredApiKey(parsed.provider || 'openai', parsed.apiKey || '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(status));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      // Ask a ChatGPT/OpenAI or Claude/Anthropic model to converse with the
      // connected MCP server. API keys stay on the local inspect server.
      server.middlewares.use('/__sunpeak/model-chat', async (req, res) => {
        if (!requireSameOrigin(req, res)) return;
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end('Method not allowed');
          return;
        }

        let body;
        try {
          body = await readRequestBody(req, { maxBytes: MODEL_CHAT_BODY_LIMIT_BYTES });
        } catch (err) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }

        try {
          const provider = parsed.provider || 'openai';
          assertModelProvider(provider);
          const apiKey = await readStoredApiKey(provider);
          if (!apiKey) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No ${provider} API key saved.` }));
            return;
          }
          const safeMessages = normalizeModelChatMessages(parsed.messages);
          if (safeMessages.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing chat messages.' }));
            return;
          }
          const conversationId = normalizeModelConversationId(parsed.conversationId);

          const result = await withModelChatClient((client) =>
            runModelChat({
              client,
              provider,
              modelId: parsed.modelId,
              messages: safeMessages,
              apiKey,
              host: parsed.host,
              appContext: normalizeModelAppContext(parsed.appContext),
              conversationId,
            })
          );
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      // Read resource from connected server
      server.middlewares.use('/__sunpeak/read-resource', async (req, res) => {
        if (!requireSameOrigin(req, res, { allowCrossSiteIframeNavigation: true })) return;
        if (!requireInspectorRequestToken(req, res)) return;
        const url = new URL(req.url, 'http://localhost');
        const uri = url.searchParams.get('uri');
        if (!uri) {
          res.writeHead(400);
          res.end('Missing uri parameter');
          return;
        }

        try {
          const client = getClient();
          const result = await withMcpRequestTimeout(client.readResource({ uri }));
          const content = result.contents?.[0];
          if (!content) {
            res.writeHead(404);
            res.end('Resource not found');
            return;
          }

          const mimeType = sanitizeMimeType(content.mimeType);
          res.writeHead(200, {
            'Content-Type': `${mimeType}; charset=utf-8`,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': RESOURCE_SANDBOX_CSP,
          });
          if (typeof content.text === 'string') {
            const stripOverlay = url.searchParams.get('devOverlay') === 'false';
            let text = content.text;
            if (stripOverlay) {
              // Strip dev overlay (e.g., for e2e tests)
              text = text.replace(
                /<script>(?:(?!<\/script>)[\s\S])*?__sunpeak-dev-timing(?:(?!<\/script>)[\s\S])*?<\/script>/g,
                ''
              );
            } else if (
              process.env.SUNPEAK_DEV_OVERLAY !== 'false' &&
              !text.includes('__sunpeak-dev-timing') &&
              text.includes('</body>')
            ) {
              // Inject dev overlay into resources from non-sunpeak servers.
              // The overlay shows resource served timestamp and tool timing (from
              // _meta._sunpeak.requestTimeMs on the PostMessage tool-result notification).
              text = text.replace('</body>', `${getDevOverlayScript(Date.now(), null)}\n</body>`);
            }
            res.end(text);
          } else if (content.blob) {
            res.end(Buffer.from(content.blob, 'base64'));
          } else {
            res.end('');
          }
        } catch (err) {
          // Try reconnecting on dead session before returning error
          if (isDeadSession(err) && (await tryReconnect())) {
            try {
              const retryResult = await withMcpRequestTimeout(getClient().readResource({ uri }));
              const retryContent = retryResult.contents?.[0];
              if (retryContent) {
                const mimeType = sanitizeMimeType(retryContent.mimeType);
                res.writeHead(200, {
                  'Content-Type': `${mimeType}; charset=utf-8`,
                  'X-Content-Type-Options': 'nosniff',
                  'Content-Security-Policy': RESOURCE_SANDBOX_CSP,
                });
                res.end(typeof retryContent.text === 'string' ? retryContent.text : '');
                return;
              }
            } catch {
              /* fall through */
            }
          }
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Error reading resource: ${err.message}`);
        }
      });
    },
  };
}

/**
 * Parse the SUNPEAK_ALLOWED_HOSTS env var into a value Vite accepts for its
 * `server.allowedHosts` option. Empty/undefined → use Vite's default
 * (localhost loopback only). The literal string "all" maps to Vite's
 * "allow everything" mode, which disables DNS-rebinding protection.
 * Otherwise the value is split on commas and trimmed.
 *
 * @param {string | undefined} raw
 */
function parseAllowedHosts(raw) {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'all') return 'all';
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate and normalize a Content-Type value supplied by the upstream MCP
 * server. The mimeType is reflected back into our HTTP response, so a
 * malformed or unexpected value would let an attacker influence how callers
 * interpret the response (e.g. force `text/html` rendering of opaque blobs).
 *
 * Accepts simple `type/subtype` shapes only (RFC 7231 token chars).
 * Anything else falls back to `text/html`, which is the protocol's documented
 * default mime type for resources that omit one.
 *
 * @param {unknown} mimeType
 */
function sanitizeMimeType(mimeType) {
  if (typeof mimeType !== 'string' || mimeType.length === 0) return 'text/html';
  // RFC 7231 token chars, no parameters/whitespace allowed here.
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) return 'text/html';
  return mimeType;
}

export const _securityTestExports = {
  assertHttpServerUrlAllowed,
  defaultLiveMcpServerUrl,
  hostnameFromHostHeader,
  isMissingCredentialError,
  isLoopbackHostname,
  isLoopbackRemoteAddress,
  isPrivateNetworkAddress,
  isToolVisibleToModel,
  getModelCallableTools,
  toolRendersApp,
  executeModelChatToolCall,
  formatModelVisibleToolResult,
  formatSharedAppContextForModel,
  addInspectorRequestTokenToSimulations,
  appendInspectorRequestToken,
  isInspectorRequestTokenValid,
  normalizeApiKey,
  normalizeModelChatMessages,
  normalizeModelAppContext,
  normalizeModelId,
  normalizeModelProviderModelId,
  quoteSecurityInteractiveArg,
  parseHttpHeader,
  hasAuthorizationHeader,
  isAuthError,
  readRequestBody,
  resolveHttpRedirectsForMcp,
  shouldAllowPrivateServerUrls,
  createInMemoryOAuthProvider,
  createOAuthAwareFetch,
  createPublicOAuthFetch,
  configureOAuthAuthorizationServer,
  validateOAuthDiscoveryState,
  validateOAuthAuthorizationResponse,
  tryAnonymousOAuth,
  requestOriginForSameOriginCheck,
  isSameInspectorOrigin,
};

/**
 * Read the full body of an HTTP request.
 */
function readRequestBody(req, { maxBytes = Infinity } = {}) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        settled = true;
        reject(new Error('Request body is too large.'));
        req.pause();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(data);
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Core inspect server logic. Connects to an MCP server, discovers tools/resources,
 * merges simulation fixtures, and serves the inspector UI via Vite.
 *
 * Used by both `sunpeak inspect` (CLI) and `sunpeak dev` (programmatic).
 *
 * @param {object} opts
 * @param {string} opts.server - MCP server URL or stdio command
 * @param {string} [opts.liveServer] - MCP server URL for live AI/eval tool calls
 * @param {string|null} [opts.simulationsDir] - Path to simulation fixtures directory
 * @param {number} [opts.port] - Dev server port (default: 3000)
 * @param {string} [opts.name] - App name override
 * @param {string} [opts.sandboxUrl] - Existing sandbox server URL (skips creating one)
 * @param {boolean} [opts.frameworkMode] - If true, show framework-only controls (Prod Resources)
 * @param {boolean} [opts.defaultProdResources] - Initial prod resources state
 * @param {string} [opts.projectRoot] - Project directory for serving /dist/ files (prod resources)
 * @param {boolean} [opts.noBegging] - Suppress star message
 * @param {boolean} [opts.open] - Whether to open browser (default: !CI && !SUNPEAK_LIVE_TEST)
 * @param {(name: string, args: Record<string, unknown>) => Promise<object>} [opts.callToolDirect] - Direct handler call (bypasses MCP, for prod-tools)
 * @param {() => Promise<void>} [opts.onCleanup] - Additional cleanup callback on exit
 * @param {Record<string, string>} [opts.resolveAlias] - Vite resolve aliases (e.g., to map sunpeak imports to source)
 * @param {object[]} [opts.vitePlugins] - Additional Vite plugins (e.g., Tailwind for source CSS)
 * @param {object} [opts.viteCssConfig] - Vite css config override (e.g., lightningcss customAtRules)
 * @param {Record<string, string>} [opts.env] - Extra environment variables for stdio server processes
 * @param {string} [opts.cwd] - Working directory for stdio server processes
 * @param {Record<string, string>} [opts.headers] - Extra HTTP headers for HTTP MCP server requests
 */
export async function inspectServer(opts) {
  const {
    server: serverArg,
    liveServer: liveServerArg,
    simulationsDir = null,
    port: preferredPort,
    name: nameOverride,
    sandboxUrl: existingSandboxUrl,
    frameworkMode = false,
    defaultProdResources = false,
    projectRoot = null,
    noBegging = false,
    open,
    onCleanup,
    resolveAlias,
    vitePlugins: extraVitePlugins = [],
    viteCssConfig,
    env: serverEnv,
    cwd: serverCwd,
    headers: serverHeaders,
  } = opts;

  // Load favicon from sunpeak package for the inspector UI.
  let faviconDataUri = null;
  let faviconBuffer = null;
  try {
    const distMcp = join(SUNPEAK_PKG_DIR, 'dist/mcp/index.js');
    if (existsSync(distMcp)) {
      const mod = await import(pathToFileURL(distMcp).href);
      faviconDataUri = mod.FAVICON_DATA_URI;
      faviconBuffer = mod.FAVICON_BUFFER;
    }
  } catch {
    // Non-fatal — inspector will just not have a favicon
  }

  console.log(`Connecting to MCP server: ${serverArg}`);

  // Connect to the MCP server (with retry for local servers that may still be starting)
  let mcpConnection;
  let lastStderrOutput = [];
  // Track the resolved URL (after following redirects like /mcp → /mcp/).
  let resolvedServerUrl = serverArg;
  const maxRetries = 5;
  const connectionOpts = {};
  if (serverEnv) connectionOpts.env = serverEnv;
  if (serverCwd) connectionOpts.cwd = serverCwd;
  if (serverHeaders) connectionOpts.headers = serverHeaders;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      mcpConnection = await createMcpConnection(resolvedServerUrl, connectionOpts);
      if (mcpConnection.serverUrl) resolvedServerUrl = mcpConnection.serverUrl;
      break;
    } catch (err) {
      // Capture stderr from the failed connection attempt for diagnostics.
      if (err._stderrOutput?.length) {
        lastStderrOutput = err._stderrOutput;
      }

      // If the server requires OAuth, negotiate it and retry once.
      if (
        isAuthError(err) &&
        resolvedServerUrl.startsWith('http') &&
        !hasAuthorizationHeader(connectionOpts.headers)
      ) {
        console.log('Server requires authentication. Negotiating OAuth...');
        try {
          const authProvider = await negotiateOAuth(resolvedServerUrl);
          console.log('OAuth authorized. Reconnecting...');
          mcpConnection = await createMcpConnection(resolvedServerUrl, {
            ...connectionOpts,
            type: 'oauth',
            authProvider,
          });
          if (mcpConnection.serverUrl) resolvedServerUrl = mcpConnection.serverUrl;
          break;
        } catch (oauthErr) {
          console.error(`OAuth negotiation failed: ${oauthErr.message}`);
          process.exit(1);
        }
      }

      if (attempt === maxRetries) {
        console.error(`Failed to connect to MCP server: ${err.message}`);
        if (lastStderrOutput.length) {
          console.error('\nServer stderr output:');
          for (const line of lastStderrOutput) {
            console.error(`  ${line}`);
          }
        }
        process.exit(1);
      }
      console.log(`Connection attempt ${attempt}/${maxRetries} failed, retrying...`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log('Connected. Discovering tools and resources...');

  // Monitor transport health. The MCP SDK opens a background SSE stream after
  // initialization. If this stream drops, the server may purge the session,
  // causing "Unknown session" errors on subsequent requests. Log lifecycle
  // events so we can diagnose connection issues when they occur.
  if (mcpConnection.transport) {
    const origOnError = mcpConnection.transport.onerror;
    mcpConnection.transport.onerror = (err) => {
      console.warn(`[inspect] MCP transport error: ${err?.message ?? err}`);
      origOnError?.(err);
    };
    const origOnClose = mcpConnection.transport.onclose;
    mcpConnection.transport.onclose = () => {
      console.warn('[inspect] MCP transport closed (session may be lost)');
      origOnClose?.();
    };
  }

  // Extract app name and icon from server info (reported during MCP initialize)
  const serverInfo = mcpConnection.client.getServerVersion();
  const serverAppName = nameOverride ?? serverInfo?.name;
  const serverAppIcon = serverInfo?.icons?.[0]?.src;

  // Discover tools/resources and build simulations
  const simulations = await discoverSimulations(mcpConnection.client);
  const toolCount = Object.keys(simulations).length;
  const resourceCount = Object.values(simulations).filter((s) => s.resource).length;
  console.log(`Found ${toolCount} tool(s), ${resourceCount} resource(s).`);

  // Merge simulation fixtures when a directory is provided
  if (simulationsDir) {
    mergeSimulationFixtures(simulationsDir, simulations);
  }

  // Start or reuse sandbox server
  let sandbox;
  let ownsSandbox = false;
  if (existingSandboxUrl) {
    sandbox = { url: existingSandboxUrl, close: async () => {} };
  } else {
    const sandboxPort = Number(process.env.SUNPEAK_SANDBOX_PORT) || undefined;
    sandbox = await startSandboxServer({
      preferredPort: sandboxPort ?? 24680,
    });
    ownsSandbox = true;
  }

  // Determine server port.
  // Track whether the port was explicitly requested (via option or env var) vs
  // auto-discovered. When explicit, use strictPort so Vite fails fast instead of
  // silently picking another port — Playwright tests set baseURL from the same port
  // and a silent fallback causes ERR_CONNECTION_REFUSED. When auto-discovered,
  // the port is guaranteed free so strictPort is irrelevant.
  const explicitPort = preferredPort || (process.env.PORT ? Number(process.env.PORT) : null);
  const port = explicitPort || (await getPort(3000));

  // Import Vite
  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;

  // Build the virtual index.html
  const appTitle = (serverAppName ?? 'MCP Inspector').replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]
  );
  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${appTitle} — sunpeak</title>${faviconDataUri ? `\n  <link rel="icon" type="image/png" href="${faviconDataUri}" />` : ''}
  <style>html, body, #root { margin: 0; padding: 0; height: 100%; }</style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/@id/__x00__virtual:sunpeak-inspect-entry"></script>
</body>
</html>`;

  const inspectorServerUrl = resolvedServerUrl;
  const liveInspectorServerUrl =
    liveServerArg ?? defaultLiveMcpServerUrl(resolvedServerUrl) ?? resolvedServerUrl;
  const inspectorRequestToken = createInspectorRequestToken();

  // Create the Vite server.
  // Use the sunpeak package dir as root to avoid scanning the user's project
  // files for dependencies (which can cause resolution errors for @ aliases etc.)
  const server = await createServer({
    root: SUNPEAK_PKG_DIR,
    configFile: false,
    ...(resolveAlias ? { resolve: { alias: resolveAlias } } : {}),
    ...(viteCssConfig ? { css: { lightningcss: viteCssConfig } } : {}),
    plugins: [
      // Security headers must run before any response is written so that
      // setHeader() is in effect when downstream middlewares call writeHead().
      // Node merges setHeader values with writeHead's headers argument; values
      // explicitly passed to writeHead win, but our defaults stick for headers
      // downstream code doesn't touch.
      {
        name: 'sunpeak-security-headers',
        configureServer(server) {
          // The inspector's top-level UI must not be framable by untrusted
          // origins — clickjacking would let an attacker drive the privileged
          // /__sunpeak/* endpoints in an authenticated session. Override via
          // SUNPEAK_FRAME_ANCESTORS for legitimate embedding (e.g. demos).
          //
          // Resource content (/dist/*.html, /__sunpeak/read-resource) must
          // stay framable so the inspector's own outer sandbox iframe (on
          // port 24680) can load it as inner-iframe content. Those paths are
          // not sensitive on their own; the iframe sandbox flags are the
          // boundary, not these headers.
          const frameAncestors = process.env.SUNPEAK_FRAME_ANCESTORS || "'none'";
          const isFrameableContent = (url) =>
            !!url && (url.startsWith('/dist/') || url.startsWith('/__sunpeak/read-resource'));
          server.middlewares.use((req, res, next) => {
            if (!isFrameableContent(req.url)) {
              if (!res.hasHeader('X-Frame-Options') && frameAncestors === "'none'") {
                res.setHeader('X-Frame-Options', 'DENY');
              }
              if (!res.hasHeader('Content-Security-Policy')) {
                res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
              }
            }
            if (!res.hasHeader('X-Content-Type-Options')) {
              res.setHeader('X-Content-Type-Options', 'nosniff');
            }
            if (!res.hasHeader('Referrer-Policy')) {
              res.setHeader('Referrer-Policy', 'no-referrer');
            }
            next();
          });
        },
      },
      react(),
      ...extraVitePlugins,
      sunpeakInspectVirtualPlugin(
        simulations,
        inspectorServerUrl,
        serverAppName,
        serverAppIcon,
        sandbox.url,
        inspectorRequestToken,
        { defaultProdResources, hideInspectorModes: !frameworkMode }
      ),
      sunpeakInspectEndpointsPlugin(
        () => mcpConnection.client,
        (newClient) => {
          mcpConnection.client = newClient;
        },
        {
          callToolDirect: opts.callToolDirect,
          simulationsDir,
          serverUrl: resolvedServerUrl,
          liveServerUrl: liveInspectorServerUrl,
          requestToken: inspectorRequestToken,
          connectionOpts,
        }
      ),
      // Serve /dist/{name}/{name}.html from the project directory (for Prod Resources mode).
      // The Inspector polls these paths via HEAD to check if built resources exist.
      // Only intercepts .html files under /dist/ — other /dist/ paths (like sunpeak's
      // own dist/inspector/index.js) must fall through to Vite's module resolution.
      ...(projectRoot
        ? [
            {
              name: 'sunpeak-dist-serve',
              configureServer(server) {
                const distRoot = resolve(projectRoot, 'dist');
                server.middlewares.use((req, res, next) => {
                  if (!req.url?.startsWith('/dist/') || !req.url.endsWith('.html')) return next();
                  // Strip query/hash before joining to avoid `?` or `#` confusing path parsers.
                  const pathOnly = req.url.split('?')[0].split('#')[0];
                  // Resolve the target path and require it to stay inside `<projectRoot>/dist`.
                  // Without this, a request like `/dist/../../etc/anything.html` would resolve
                  // outside the project and serve arbitrary readable files as HTML.
                  const filePath = resolve(projectRoot, pathOnly.replace(/^\/+/, ''));
                  const distRootWithSep = distRoot.endsWith(sep) ? distRoot : distRoot + sep;
                  if (filePath !== distRoot && !filePath.startsWith(distRootWithSep)) {
                    res.writeHead(403);
                    res.end('Forbidden');
                    return;
                  }
                  if (existsSync(filePath)) {
                    const content = readFileSync(filePath, 'utf-8');
                    res.writeHead(200, {
                      'Content-Type': 'text/html; charset=utf-8',
                      'X-Content-Type-Options': 'nosniff',
                      'Content-Security-Policy': RESOURCE_SANDBOX_CSP,
                    });
                    res.end(content);
                  } else {
                    res.writeHead(404);
                    res.end('Not found');
                  }
                });
              },
            },
          ]
        : []),
      // Serve virtual index.html
      {
        name: 'sunpeak-inspect-index-html',
        configureServer(server) {
          // Serve index.html for all non-API, non-asset requests (SPA fallback)
          server.middlewares.use((req, res, next) => {
            if (
              req.url === '/' ||
              req.url === '/index.html' ||
              (!req.url.startsWith('/__sunpeak/') &&
                !req.url.startsWith('/@') &&
                !req.url.startsWith('/node_modules/') &&
                req.url !== '/health' &&
                !req.url.includes('.'))
            ) {
              // Transform through Vite to resolve module imports
              server
                .transformIndexHtml(req.url, indexHtml)
                .then((html) => {
                  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                  res.end(html);
                })
                .catch(next);
              return;
            }
            next();
          });
        },
      },
      // Paint fence responder
      {
        name: 'sunpeak-fence-responder',
        transformIndexHtml(html) {
          const fenceScript = `<script>window.addEventListener("message",function(e){if(e.data&&e.data.method==="sunpeak/fence"){var fid=e.data.params&&e.data.params.fenceId;requestAnimationFrame(function(){e.source.postMessage({jsonrpc:"2.0",method:"sunpeak/fence-ack",params:{fenceId:fid}},"*");});}});</script>`;
          return html.replace('</head>', fenceScript + '</head>');
        },
      },
      // Favicon
      ...(faviconBuffer
        ? [
            {
              name: 'sunpeak-favicon',
              configureServer(server) {
                server.middlewares.use('/favicon.ico', (_req, res) => {
                  res.writeHead(200, {
                    'Content-Type': 'image/png',
                    'Content-Length': faviconBuffer.length,
                    'Cache-Control': 'public, max-age=86400',
                  });
                  res.end(faviconBuffer);
                });
              },
            },
          ]
        : []),
      // Health endpoint
      {
        name: 'sunpeak-health',
        configureServer(server) {
          server.middlewares.use('/health', (_req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          });
        },
      },
    ],
    server: {
      port,
      // When the port was explicitly requested (Playwright tests, --port flag, PORT env),
      // fail fast if busy instead of silently picking another port. Playwright tests
      // configure baseURL from the same port, so a silent fallback causes
      // ERR_CONNECTION_REFUSED. When auto-discovered via getPort(), the port is
      // already free so this doesn't apply.
      ...(explicitPort ? { strictPort: true } : {}),
      // Bind to 127.0.0.1 by default so the inspector is not reachable from the
      // LAN. The /__sunpeak/* endpoints can call the connected MCP server, so
      // exposing them on 0.0.0.0 lets any device on the same network drive the
      // developer's tools. Set SUNPEAK_HOST=0.0.0.0 (or another address) to opt in.
      host: process.env.SUNPEAK_HOST || '127.0.0.1',
      // Vite's DNS-rebinding protection rejects requests whose Host header
      // isn't in this allowlist, which closes the residual rebinding attack
      // even when the server is bound to 0.0.0.0. Set SUNPEAK_ALLOWED_HOSTS
      // (comma-separated, or "all") to allow tunnels, containers, or custom
      // /etc/hosts entries.
      allowedHosts: parseAllowedHosts(process.env.SUNPEAK_ALLOWED_HOSTS),
      open: open ?? (!process.env.CI && !process.env.SUNPEAK_LIVE_TEST),
    },
    optimizeDeps: {
      // Only pre-bundle React — the virtual entry module imports sunpeak from
      // node_modules, so no user source scanning needed.
      include: ['react', 'react-dom', 'react/jsx-runtime'],
      // Disable scanning user's project files (avoids @ alias resolution errors)
      entries: [],
    },
  });

  await server.listen();
  server.printUrls();
  server.bindCLIShortcuts({ print: true });

  // Print troubleshooting link (dimmed)
  console.log(
    '\n  \x1b[2mApp not loading? \u2192 https://sunpeak.ai/docs/app-framework/guides/troubleshooting\x1b[0m'
  );

  // Print star-begging message unless suppressed
  if (!noBegging) {
    // #FFB800 in 24-bit ANSI color
    console.log(
      '\n\x1b[38;2;255;184;0m\u2b50\ufe0f \u2192 \u2764\ufe0f  https://github.com/Alignbase/sunpeak\x1b[0m\n'
    );
  }

  // Cleanup on exit
  const cleanup = async () => {
    if (ownsSandbox) await sandbox.close();
    try {
      await mcpConnection.client.close();
    } catch {
      // Ignore close errors
    }
    await server.close();
    if (onCleanup) await onCleanup();
  };

  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(0);
  });
}

/**
 * CLI entry point for `sunpeak inspect`.
 */
export async function inspect(args) {
  const opts = parseArgs(args);

  if (!opts.server) {
    console.error('Error: --server is required.');
    console.error('Run "sunpeak inspect --help" for usage.');
    process.exit(1);
  }

  const projectRoot = process.cwd();
  const simulationsDir = opts.simulations ? resolve(projectRoot, opts.simulations) : null;

  await inspectServer({
    server: opts.server,
    simulationsDir,
    port: opts.port,
    name: opts.name,
    env: opts.env,
    cwd: opts.cwd,
    headers: opts.headers,
  });
}
