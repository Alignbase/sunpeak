import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import {
  createHandler,
  createMcpHandler,
  createOAuthChallenge,
  createOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
  type AuthorizationContext,
  type AuthorizationFailure,
  type ProductionServerConfig,
} from './production-server.js';

const oauth = {
  authorizationServers: ['https://auth.example.com'],
  scopesSupported: ['profile:read', 'files:write'],
  resourceName: 'Example MCP server',
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

describe('OAuth protected-resource helpers', () => {
  it('builds standard metadata while keeping canonical fields authoritative', () => {
    expect(
      createOAuthProtectedResourceMetadata(
        {
          ...oauth,
          additionalMetadata: {
            resource: 'https://attacker.example',
            dpop_bound_access_tokens_required: true,
          },
        },
        'https://mcp.example.com/mcp'
      )
    ).toEqual({
      resource: 'https://mcp.example.com/mcp',
      authorization_servers: ['https://auth.example.com'],
      scopes_supported: ['profile:read', 'files:write'],
      resource_name: 'Example MCP server',
      bearer_methods_supported: ['header'],
      dpop_bound_access_tokens_required: true,
    });
  });

  it('uses endpoint-specific discovery and emits scope challenges', () => {
    expect(getOAuthProtectedResourceMetadataUrl('https://mcp.example.com/api/mcp')).toBe(
      'https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp'
    );
    expect(
      createOAuthChallenge('https://mcp.example.com/mcp', oauth, {
        error: 'insufficient_scope',
        scopes: ['files:write'],
      })
    ).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="files:write", error="insufficient_scope"'
    );
  });

  it('preserves resource query components and rejects fragments', () => {
    expect(
      getOAuthProtectedResourceMetadataUrl('https://mcp.example.com/api/mcp?tenant=acme')
    ).toBe('https://mcp.example.com/.well-known/oauth-protected-resource/api/mcp?tenant=acme');
    expect(() =>
      createOAuthProtectedResourceMetadata(
        { authorizationServers: ['https://auth.example.com'] },
        'https://mcp.example.com/mcp#fragment'
      )
    ).toThrow('must not contain a fragment');
  });

  it('rejects insecure public OAuth metadata URLs', () => {
    expect(() =>
      createOAuthProtectedResourceMetadata(
        { authorizationServers: ['http://auth.example.com'] },
        'https://mcp.example.com/mcp'
      )
    ).toThrow('must use https unless it is on localhost');
    expect(() =>
      createOAuthProtectedResourceMetadata(
        { authorizationServers: ['https://user:secret@auth.example.com'] },
        'https://mcp.example.com/mcp'
      )
    ).toThrow('must not contain credentials');
  });
});

describe('OAuth-aware MCP handlers', () => {
  it('serves endpoint-specific and root metadata without authenticating', async () => {
    const auth = vi.fn(() => null);
    const config: ProductionServerConfig = {
      tools: [],
      resources: [],
      stateless: true,
      serverUrl: 'https://mcp.example.com/mcp',
      oauth,
      auth,
    };
    const mcpHandler = createMcpHandler(config);
    const server = createServer((req, res) => {
      void mcpHandler(req, res).then(() => {
        if (!res.headersSent) res.writeHead(404).end('fallthrough');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as { port: number };

    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const response = await fetch(`http://localhost:${address.port}${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toMatchObject({
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      });
    }
    expect(auth).not.toHaveBeenCalled();
  });

  it('returns an RFC 6750 challenge for unauthenticated requests', async () => {
    const handler = createHandler({
      tools: [],
      resources: [],
      stateless: true,
      serverUrl: 'https://mcp.example.com/mcp',
      oauth,
      auth: () => null,
    });
    const response = await handler(
      new Request('https://mcp.example.com/mcp', { method: 'POST', body: '{}' })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="profile:read files:write"'
    );
    expect(response.headers.get('access-control-expose-headers')).toContain('www-authenticate');
  });

  it('returns a 403 challenge with the scopes requested by an auth function', async () => {
    const auth = vi.fn((_req: Request, _context: AuthorizationContext): AuthorizationFailure => ({
      authorized: false,
      error: 'insufficient_scope',
      errorDescription: 'Writing files requires another scope',
      scopes: ['files:write'],
    }));
    const handler = createHandler({
      tools: [],
      resources: [],
      stateless: true,
      serverUrl: 'https://mcp.example.com/mcp',
      oauth,
      auth,
    });
    const response = await handler(
      new Request('https://mcp.example.com/mcp', {
        method: 'POST',
        body: JSON.stringify({ method: 'tools/call', params: { name: 'save-file' } }),
      })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(response.headers.get('www-authenticate')).toContain('scope="files:write"');
    expect(auth.mock.calls[0][1].body).toEqual({
      method: 'tools/call',
      params: { name: 'save-file' },
    });
  });

  it('defaults malformed authorization failures to 400', async () => {
    const handler = createHandler({
      tools: [],
      resources: [],
      stateless: true,
      serverUrl: 'https://mcp.example.com/mcp',
      oauth,
      auth: (): AuthorizationFailure => ({
        authorized: false,
        error: 'invalid_request',
        errorDescription: 'Malformed bearer credentials',
      }),
    });
    const response = await handler(
      new Request('https://mcp.example.com/mcp', { method: 'POST', body: '{}' })
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_request"');
  });

  it('does not accept arbitrary rejection status codes at runtime', async () => {
    const handler = createHandler({
      tools: [],
      resources: [],
      stateless: true,
      serverUrl: 'https://mcp.example.com/mcp',
      oauth,
      auth: () => ({ authorized: false, status: 200 }) as unknown as AuthorizationFailure,
    });
    const response = await handler(
      new Request('https://mcp.example.com/mcp', { method: 'POST', body: '{}' })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });
});
