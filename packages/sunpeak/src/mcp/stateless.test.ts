// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { createHandler, createMcpHandler, detectClientFromHeaders } from './production-server.js';
import type { WebHandlerConfig, ProductionServerConfig } from './production-server.js';

// Minimal config for tests — no real tools or resources needed for transport-level behavior
const baseWebConfig: WebHandlerConfig = {
  tools: [],
  resources: [],
  stateless: true,
};

const baseNodeConfig: ProductionServerConfig = {
  tools: [],
  resources: [],
  stateless: true,
};

// Config with a tool registered (needed for tools/list and tools/call tests).
// No schema = plain tool with no input validation.
const configWithTool: WebHandlerConfig = {
  tools: [
    {
      name: 'test-tool',
      tool: { description: 'A test tool' },
      handler: () => 'hello world',
    },
  ],
  resources: [],
  stateless: true,
};

// Helper to create a JSON-RPC request body
function jsonRpcBody(method: string, params?: Record<string, unknown>, id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id });
}

function initializeBody(clientName = 'openai-mcp') {
  return jsonRpcBody('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: clientName, version: '1.0' },
  });
}

function makePostRequest(body: string, headers?: Record<string, string>): Request {
  return new Request('http://localhost:8000/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body,
  });
}

describe('createHandler stateless mode', () => {
  it('handles initialize requests without session tracking', async () => {
    const handler = createHandler(baseWebConfig);
    const req = makePostRequest(initializeBody());
    const res = await handler(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();

    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
    expect(body.result.serverInfo).toBeDefined();
  });

  it('ignores mcp-session-id header in stateless mode', async () => {
    const handler = createHandler(baseWebConfig);

    const req = makePostRequest(initializeBody('claude'), { 'mcp-session-id': 'fake-session-id' });
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result?.serverInfo).toBeDefined();
  });

  it('rejects GET requests in stateless mode', async () => {
    const handler = createHandler(baseWebConfig);
    const req = new Request('http://localhost:8000/mcp', {
      method: 'GET',
      headers: { accept: 'text/event-stream' },
    });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  it('rejects DELETE requests in stateless mode', async () => {
    const handler = createHandler(baseWebConfig);
    const req = new Request('http://localhost:8000/mcp', { method: 'DELETE' });
    const res = await handler(req);
    expect(res.status).toBe(405);
  });

  it('handles CORS preflight in stateless mode', async () => {
    const handler = createHandler(baseWebConfig);
    const req = new Request('http://localhost:8000/mcp', { method: 'OPTIONS' });
    const res = await handler(req);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('handles tools/list without prior initialize (cold start)', async () => {
    const handler = createHandler(configWithTool);
    const req = makePostRequest(jsonRpcBody('tools/list'));
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result.tools).toHaveLength(1);
    expect(body.result.tools[0].name).toBe('test-tool');
  });

  it('handles tools/call without prior initialize (cold start)', async () => {
    const handler = createHandler(configWithTool);
    const req = makePostRequest(
      jsonRpcBody('tools/call', {
        name: 'test-tool',
      })
    );
    const res = await handler(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result.content).toBeDefined();
    expect(body.result.content[0].text).toBe('hello world');
  });

  it('returns 401 when auth rejects', async () => {
    const handler = createHandler({
      ...baseWebConfig,
      auth: () => null,
    });
    const req = makePostRequest(initializeBody());
    const res = await handler(req);
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid JSON body', async () => {
    const handler = createHandler(baseWebConfig);
    const req = new Request('http://localhost:8000/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: 'not json',
    });
    const res = await handler(req);
    expect(res.status).toBe(400);
  });
});

describe('serverInfo.instructions', () => {
  it('includes instructions in initialize result when set', async () => {
    const text = 'Always call get_user before update_user.';
    const handler = createHandler({
      ...baseWebConfig,
      serverInfo: { name: 'test', version: '1.0.0', instructions: text },
    });
    const res = await handler(makePostRequest(initializeBody()));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.result?.instructions).toBe(text);
  });

  it('omits instructions from initialize result when unset', async () => {
    const handler = createHandler({
      ...baseWebConfig,
      serverInfo: { name: 'test', version: '1.0.0' },
    });
    const res = await handler(makePostRequest(initializeBody()));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.result?.instructions).toBeUndefined();
  });
});

describe('createHandler stateful mode (default)', () => {
  it('returns 404 for unknown session ID', async () => {
    const handler = createHandler({ ...baseWebConfig, stateless: false });
    const req = makePostRequest(jsonRpcBody('tools/list'), { 'mcp-session-id': 'nonexistent' });
    const res = await handler(req);
    expect(res.status).toBe(404);
  });

  it('creates a session on initialize and returns session ID', async () => {
    const handler = createHandler({ ...baseWebConfig, stateless: false });
    const req = makePostRequest(initializeBody());
    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();

    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result?.serverInfo).toBeDefined();
  });
});

describe('detectClientFromHeaders', () => {
  it('detects ChatGPT from user-agent: openai-mcp/1.0.0', () => {
    expect(detectClientFromHeaders(new Headers({ 'user-agent': 'openai-mcp/1.0.0' }))).toBe(
      'openai-mcp'
    );
  });

  it('detects Claude from user-agent: Claude-User', () => {
    expect(detectClientFromHeaders(new Headers({ 'user-agent': 'Claude-User' }))).toBe('claude');
  });

  it('detects Claude from x-anthropic-client header', () => {
    expect(
      detectClientFromHeaders(
        new Headers({
          'user-agent': 'node',
          'x-anthropic-client': 'ClaudeAI',
        })
      )
    ).toBe('claude');
  });

  it('detects ChatGPT from x-openai-session header', () => {
    expect(
      detectClientFromHeaders(
        new Headers({
          'user-agent': 'node',
          'x-openai-session': 'v1/abc123',
        })
      )
    ).toBe('openai-mcp');
  });

  it('returns undefined for unknown clients', () => {
    expect(detectClientFromHeaders(new Headers({ 'user-agent': 'node' }))).toBeUndefined();
  });

  it('returns undefined for empty headers', () => {
    expect(detectClientFromHeaders(new Headers())).toBeUndefined();
  });

  it('works with Node.js-style header objects', () => {
    expect(detectClientFromHeaders({ 'user-agent': 'openai-mcp/1.0.0' })).toBe('openai-mcp');
    expect(detectClientFromHeaders({ 'user-agent': 'Claude-User' })).toBe('claude');
    expect(detectClientFromHeaders({ 'user-agent': ['openai-mcp/1.0.0'] })).toBe('openai-mcp');
  });

  it('detects fallback headers with Node.js-style objects', () => {
    expect(
      detectClientFromHeaders({ 'user-agent': 'node', 'x-anthropic-client': 'ClaudeAI' })
    ).toBe('claude');
    expect(detectClientFromHeaders({ 'user-agent': 'node', 'x-openai-session': 'v1/abc' })).toBe(
      'openai-mcp'
    );
  });

  it('matches case-insensitively', () => {
    expect(detectClientFromHeaders(new Headers({ 'user-agent': 'OPENAI-MCP/2.0' }))).toBe(
      'openai-mcp'
    );
    expect(detectClientFromHeaders(new Headers({ 'user-agent': 'claude-user' }))).toBe('claude');
    expect(detectClientFromHeaders(new Headers({ 'user-agent': 'CLAUDE-USER' }))).toBe('claude');
  });

  it('handles undefined values in Node.js-style objects', () => {
    expect(detectClientFromHeaders({ 'user-agent': undefined })).toBeUndefined();
    expect(
      detectClientFromHeaders({ 'user-agent': undefined, 'x-anthropic-client': 'ClaudeAI' })
    ).toBe('claude');
  });
});

describe('createMcpHandler stateless mode', () => {
  it('handles initialize requests without session tracking', async () => {
    const handler = createMcpHandler(baseNodeConfig);
    const http = await import('node:http');
    const server = http.createServer(handler);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };

    try {
      const res = await fetch(`http://localhost:${addr.port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: initializeBody(),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeNull();

      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.result?.serverInfo).toBeDefined();
    } finally {
      server.close();
    }
  });

  it('rejects non-POST methods in stateless mode', async () => {
    const handler = createMcpHandler(baseNodeConfig);
    const http = await import('node:http');
    const server = http.createServer(handler);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };

    try {
      const res = await fetch(`http://localhost:${addr.port}/mcp`, {
        method: 'GET',
        headers: { accept: 'text/event-stream' },
      });
      expect(res.status).toBe(405);
    } finally {
      server.close();
    }
  });

  it('ignores non-/mcp paths', async () => {
    const handler = createMcpHandler(baseNodeConfig);
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      handler(req, res).then(() => {
        if (!res.headersSent) {
          res.writeHead(200).end('fallthrough');
        }
      });
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };

    try {
      const res = await fetch(`http://localhost:${addr.port}/other`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('fallthrough');
    } finally {
      server.close();
    }
  });
});
