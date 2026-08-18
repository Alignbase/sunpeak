#!/usr/bin/env node

// Minimal headless client used to exercise the inspector's OAuth provider
// against the official MCP conformance runner. The runner appends its MCP URL
// as the final argument and selects behavior through MCP_CONFORMANCE_*.

import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { _securityTestExports } from '../bin/commands/inspect.mjs';

const serverUrl = process.argv.at(-1);
if (!serverUrl?.startsWith('http')) {
  throw new Error('The conformance runner must supply an MCP server URL');
}

const scenario = process.env.MCP_CONFORMANCE_SCENARIO ?? '';
const protocolVersion = process.env.MCP_CONFORMANCE_PROTOCOL_VERSION ?? '2026-07-28';
const context = JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT ?? '{}');
const redirectUrl = 'http://localhost:24681/oauth/callback';

const tokenEndpointAuthMethod = scenario.endsWith('-basic')
  ? 'client_secret_basic'
  : scenario.endsWith('-post')
    ? 'client_secret_post'
    : scenario.endsWith('-none')
      ? 'none'
      : undefined;

const oauthState = _securityTestExports.createInMemoryOAuthProvider(redirectUrl, {
  ...(context.client_id ? { clientId: context.client_id } : {}),
  ...(context.client_secret ? { clientSecret: context.client_secret } : {}),
  ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
  ...(scenario === 'auth/basic-cimd'
    ? { clientMetadataUrl: 'https://conformance-test.local/client-metadata.json' }
    : {}),
});
const oauthFetch = _securityTestExports.createOAuthAwareFetch(oauthState);

function requestMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': protocolVersion,
    'io.modelcontextprotocol/clientInfo': {
      name: 'sunpeak-oauth-conformance',
      version: '1.0.0',
    },
    'io.modelcontextprotocol/clientCapabilities': {},
  };
}

let requestId = 0;
let resourceMetadataUrl;
async function mcpRequest(method, token) {
  const params =
    method === 'tools/call'
      ? { name: 'conformance-test', arguments: {}, _meta: requestMeta() }
      : { _meta: requestMeta() };
  const response = await oauthFetch(serverUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': protocolVersion,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
  });
  const challenge = response.headers.get('www-authenticate') ?? '';
  const match = challenge.match(/resource_metadata=(?:"([^"]+)"|([^\s,]+))/i);
  const value = match?.[1] ?? match?.[2];
  if (value) resourceMetadataUrl = new URL(value);
  return response;
}

async function authorize() {
  const result = await auth(oauthState.provider, {
    serverUrl: new URL(serverUrl),
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(oauthState.provider.clientMetadata.scope
      ? { scope: oauthState.provider.clientMetadata.scope }
      : {}),
    fetchFn: oauthFetch,
  });
  if (result === 'AUTHORIZED') return;
  if (result !== 'REDIRECT') throw new Error(`Unexpected OAuth result: ${result}`);

  const authorizationUrl = oauthState.getAuthUrl();
  if (!authorizationUrl) throw new Error('OAuth authorization URL was not captured');
  const code = await _securityTestExports.tryAnonymousOAuth(
    authorizationUrl.toString(),
    redirectUrl,
    oauthState.stateParam,
    fetch,
    oauthState.getDiscoveryState()
  );
  if (!code) throw new Error('Conformance authorization did not redirect with a code');

  const tokenResult = await auth(oauthState.provider, {
    serverUrl: new URL(serverUrl),
    authorizationCode: code,
    fetchFn: oauthFetch,
  });
  if (tokenResult !== 'AUTHORIZED') {
    throw new Error(`Unexpected OAuth token result: ${tokenResult}`);
  }
}

async function accessToken() {
  return (await oauthState.provider.tokens())?.access_token;
}

async function run() {
  let response = await mcpRequest('tools/list');
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    await authorize();
    response = await mcpRequest('tools/list', await accessToken());
  }
  await response.body?.cancel();

  // Scope step-up and authorization-server migration happen only after a
  // successful authenticated request, so make a tool call and handle a small,
  // bounded number of new challenges.
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await mcpRequest('tools/call', await accessToken());
    if (response.status !== 401 && response.status !== 403) {
      await response.body?.cancel();
      break;
    }
    await response.body?.cancel();
    await authorize();
  }
}

await run();
