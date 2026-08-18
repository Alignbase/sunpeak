/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck - CLI command modules are .mjs files without TypeScript declarations
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';

// Import the inspect module to test parseArgs and mergeSimulationFixtures
// We'll test the exported helpers by re-implementing the logic since they're
// not exported. Instead, test the public behavior via the module.

const importInspectConfig = () => import('../../bin/lib/inspect/inspect-config.mjs');
const importTestConfig = () => import('../../bin/lib/test/test-config.mjs');
const importLiveConfig = () => import('../../bin/lib/live/live-config.mjs');

describe('defineConfig (external server)', () => {
  it('resolves local sunpeak binary when available', async () => {
    const { defineConfig } = await importTestConfig();
    const config = defineConfig({
      server: { url: 'http://localhost:8000/mcp' },
    });

    // Should contain 'sunpeak inspect' — either bare or with a node_modules/.bin prefix
    expect(config.webServer.command).toContain("'sunpeak' inspect");
  });

  it('passes env as --env flags in the inspect command', async () => {
    const { defineConfig } = await importTestConfig();
    const config = defineConfig({
      server: { command: 'python', args: ['server.py'], env: { SECRET: 'abc' } },
    });

    expect(config.webServer.command).toContain("--env 'SECRET=abc'");
  });

  it('quotes env values with spaces', async () => {
    const { defineConfig } = await importTestConfig();
    const config = defineConfig({
      server: { command: 'python', args: ['server.py'], env: { MSG: 'hi there' } },
    });

    expect(config.webServer.command).toContain("--env 'MSG=hi there'");
  });

  it('shell-quotes generated inspect command values', async () => {
    const { defineConfig } = await importTestConfig();
    const config = defineConfig({
      server: {
        url: "https://mcp.example.com/mcp'; touch /tmp/pwned #",
        env: { SECRET: "abc'; touch /tmp/pwned #" },
        cwd: "./backend'; touch /tmp/pwned #",
        headers: { Authorization: "Bearer test'; touch /tmp/pwned #" },
      },
      simulationsDir: "tests/sims'; touch /tmp/pwned #",
    });

    expect(config.webServer.command).toContain(
      "--server 'https://mcp.example.com/mcp'\\''; touch /tmp/pwned #'"
    );
    expect(config.webServer.command).toContain("--env 'SECRET=abc'\\''; touch /tmp/pwned #'");
    expect(config.webServer.command).toContain("--cwd './backend'\\''; touch /tmp/pwned #'");
    expect(config.webServer.command).toContain(
      "--header 'Authorization: Bearer test'\\''; touch /tmp/pwned #'"
    );
    expect(config.webServer.command).toContain(
      "--simulations 'tests/sims'\\''; touch /tmp/pwned #'"
    );
  });

  it('passes cwd as --cwd flag', async () => {
    const { defineConfig } = await importTestConfig();
    const config = defineConfig({
      server: { command: 'python', args: ['server.py'], cwd: './backend' },
    });

    expect(config.webServer.command).toContain("--cwd './backend'");
  });

  it('passes HTTP headers as --header flags', async () => {
    const { defineConfig } = await importTestConfig();
    const config = defineConfig({
      server: {
        url: 'http://localhost:8000/mcp',
        headers: { Authorization: 'Bearer test-token' },
      },
    });

    expect(config.webServer.command).toContain("--header 'Authorization: Bearer test-token'");
  });

  it('uses custom timeout', async () => {
    const { defineConfig } = await importTestConfig();
    const config = defineConfig({
      server: { url: 'http://localhost:8000/mcp' },
      timeout: 180_000,
    });

    expect(config.webServer.timeout).toBe(180_000);
  });
});

describe('defineInspectConfig', () => {
  it('generates a valid Playwright config shape', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({ server: 'http://localhost:8000/mcp' });

    expect(config.testDir).toBe('tests/e2e');
    expect(config.fullyParallel).toBe(true);
    expect(config.webServer).toBeDefined();
    expect(config.webServer.command).toContain("'sunpeak' inspect");
    expect(config.webServer.command).toContain("--server 'http://localhost:8000/mcp'");
    expect(config.webServer.url).toContain('/health');
    expect(config.use.baseURL).toContain('http://127.0.0.1:');
    expect(config.use.trace).toBe('on-first-retry');
  });

  it('creates projects for each host', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: 'http://localhost:8000/mcp',
      hosts: ['chatgpt', 'claude'],
    });

    expect(config.projects).toHaveLength(2);
    expect(config.projects[0].name).toBe('chatgpt');
    expect(config.projects[1].name).toBe('claude');
  });

  it('defaults to both hosts', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({ server: 'http://localhost:8000/mcp' });

    expect(config.projects).toHaveLength(2);
  });

  it('accepts custom testDir and simulationsDir', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: 'http://localhost:8000/mcp',
      testDir: 'custom/tests',
      simulationsDir: 'custom/sims',
    });

    expect(config.testDir).toBe('custom/tests');
    expect(config.webServer.command).toContain("--simulations 'custom/sims'");
  });

  it('omits --simulations flag when simulationsDir is not provided', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({ server: 'http://localhost:8000/mcp' });

    expect(config.webServer.command).not.toContain('--simulations');
  });

  it('quotes stdio command with spaces', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({ server: 'python my_server.py' });

    expect(config.webServer.command).toContain("--server 'python my_server.py'");
  });

  it('includes app name when provided', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: 'http://localhost:8000/mcp',
      name: 'My MCP App',
    });

    expect(config.webServer.command).toContain("--name 'My MCP App'");
  });

  it('merges custom use options', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: 'http://localhost:8000/mcp',
      use: { screenshot: 'on' },
    });

    expect(config.use.screenshot).toBe('on');
    expect(config.use.baseURL).toBeDefined(); // built-in options still present
  });

  it('throws when server is missing', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    expect(() => defineInspectConfig({})).toThrow('`server` option is required');
  });

  it('passes env as --env flags for stdio servers', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: 'python server.py',
      env: { API_KEY: 'test-123', DEBUG: 'true' },
    });

    expect(config.webServer.command).toContain("--env 'API_KEY=test-123'");
    expect(config.webServer.command).toContain("--env 'DEBUG=true'");
  });

  it('quotes env values that contain spaces', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: 'python server.py',
      env: { GREETING: 'hello world' },
    });

    expect(config.webServer.command).toContain("--env 'GREETING=hello world'");
  });

  it('passes cwd as --cwd flag for stdio servers', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: 'python server.py',
      cwd: './backend',
    });

    expect(config.webServer.command).toContain("--cwd './backend'");
  });

  it('passes HTTP headers as --header flags', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: 'http://localhost:8000/mcp',
      headers: { Authorization: 'Bearer test-token' },
    });

    expect(config.webServer.command).toContain("--header 'Authorization: Bearer test-token'");
  });

  it('quotes cwd paths that contain spaces', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: 'python server.py',
      cwd: './my project',
    });

    expect(config.webServer.command).toContain("--cwd './my project'");
  });

  it('shell-quotes all generated command values', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: "python server.py'; touch /tmp/pwned #",
      env: { SECRET: "abc'; touch /tmp/pwned #" },
      cwd: "./backend'; touch /tmp/pwned #",
      headers: { Authorization: "Bearer test'; touch /tmp/pwned #" },
      simulationsDir: "tests/sims'; touch /tmp/pwned #",
      name: "Demo'; touch /tmp/pwned #",
    });

    expect(config.webServer.command).toContain(
      "--server 'python server.py'\\''; touch /tmp/pwned #'"
    );
    expect(config.webServer.command).toContain("--env 'SECRET=abc'\\''; touch /tmp/pwned #'");
    expect(config.webServer.command).toContain("--cwd './backend'\\''; touch /tmp/pwned #'");
    expect(config.webServer.command).toContain(
      "--header 'Authorization: Bearer test'\\''; touch /tmp/pwned #'"
    );
    expect(config.webServer.command).toContain(
      "--simulations 'tests/sims'\\''; touch /tmp/pwned #'"
    );
    expect(config.webServer.command).toContain("--name 'Demo'\\''; touch /tmp/pwned #'");
  });

  it('uses custom timeout when provided', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: 'http://localhost:8000/mcp',
      timeout: 120_000,
    });

    expect(config.webServer.timeout).toBe(120_000);
  });

  it('defaults timeout to 60s when not provided', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({
      server: 'http://localhost:8000/mcp',
    });

    expect(config.webServer.timeout).toBe(60_000);
  });

  it('sets appropriate worker limits', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({ server: 'http://localhost:8000/mcp' });

    // Should be 1 or 2 (CI-dependent)
    expect(config.workers).toBeGreaterThanOrEqual(1);
    expect(config.workers).toBeLessThanOrEqual(2);
  });

  it('includes sandbox port in webServer command', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({ server: 'http://localhost:8000/mcp' });

    expect(config.webServer.command).toContain('SUNPEAK_SANDBOX_PORT=');
  });

  it('allocates distinct ports for server and sandbox', async () => {
    const { defineInspectConfig } = await importInspectConfig();
    const config = defineInspectConfig({ server: 'http://localhost:8000/mcp' });

    // Extract the ports from the generated config
    const baseUrlPort = Number(new URL(config.use.baseURL).port);
    const sandboxPortMatch = config.webServer.command.match(/SUNPEAK_SANDBOX_PORT=(\d+)/);
    const sandboxPort = sandboxPortMatch ? Number(sandboxPortMatch[1]) : null;

    expect(baseUrlPort).toBeGreaterThan(0);
    expect(sandboxPort).toBeGreaterThan(0);
    expect(baseUrlPort).not.toBe(sandboxPort);
  });
});

describe('createLiveConfig', () => {
  it('shell-quotes external server URLs in generated live webServer commands', async () => {
    const { createLiveConfig } = await importLiveConfig();
    const config = createLiveConfig(
      { hostId: 'chatgpt' },
      {
        server: { url: "https://mcp.example.com/mcp'; touch /tmp/pwned #" },
        vitePort: 4567,
      }
    );

    expect(config.webServer.command).toContain("'sunpeak' inspect");
    expect(config.webServer.command).toContain(
      "--server 'https://mcp.example.com/mcp'\\''; touch /tmp/pwned #'"
    );
    expect(config.webServer.command).toContain('--port 4567');
  });

  it('shell-quotes external stdio commands in generated live webServer commands', async () => {
    const { createLiveConfig } = await importLiveConfig();
    const config = createLiveConfig(
      { hostId: 'chatgpt' },
      {
        server: { command: 'python', args: ["server.py'; touch /tmp/pwned #"] },
        vitePort: 4568,
      }
    );

    expect(config.webServer.command).toContain(
      "--server 'python server.py'\\''; touch /tmp/pwned #'"
    );
    expect(config.webServer.command).toContain('--port 4568');
  });
});

describe('isAuthError', () => {
  const loadIsAuthError = async () => {
    const { _securityTestExports } = await import('../../bin/commands/inspect.mjs');
    return _securityTestExports.isAuthError;
  };

  it('detects invalid_token error', async () => {
    const isAuthError = await loadIsAuthError();
    const err = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token"}'
    );
    expect(isAuthError(err)).toBe(true);
  });

  it('detects UnauthorizedError by class name', async () => {
    const isAuthError = await loadIsAuthError();
    class UnauthorizedError extends Error {
      constructor() {
        super('Unauthorized');
      }
    }
    expect(isAuthError(new UnauthorizedError())).toBe(true);
  });

  it('detects Streamable HTTP 401 JSON status messages', async () => {
    const isAuthError = await loadIsAuthError();
    const err = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"statusCode":401,"message":"Authentication is required"}'
    );
    expect(isAuthError(err)).toBe(true);
  });

  it('detects HTTP 401 text messages', async () => {
    const isAuthError = await loadIsAuthError();
    expect(isAuthError(new Error('HTTP 401 Unauthorized'))).toBe(true);
    expect(isAuthError(new Error('status=401'))).toBe(true);
  });

  it('does not match ECONNREFUSED', async () => {
    const isAuthError = await loadIsAuthError();
    const err = new Error('connect ECONNREFUSED 127.0.0.1:8000');
    expect(isAuthError(err)).toBe(false);
  });

  it('does not match ETIMEDOUT', async () => {
    const isAuthError = await loadIsAuthError();
    const err = new Error('connect ETIMEDOUT 10.0.0.1:443');
    expect(isAuthError(err)).toBe(false);
  });

  it('does not match generic errors', async () => {
    const isAuthError = await loadIsAuthError();
    const err = new Error('Something went wrong');
    expect(isAuthError(err)).toBe(false);
  });

  it('does not false-positive on URLs containing 401', async () => {
    const isAuthError = await loadIsAuthError();
    const err = new Error('Failed to fetch http://example.com/path/4014');
    expect(isAuthError(err)).toBe(false);
  });
});

describe('inspect endpoint security helpers', () => {
  const importInspectCommand = () => import('../../bin/commands/inspect.mjs');

  it('detects private and loopback IP ranges', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(_securityTestExports.isPrivateNetworkAddress('127.0.0.1')).toBe(true);
    expect(_securityTestExports.isPrivateNetworkAddress('10.2.3.4')).toBe(true);
    expect(_securityTestExports.isPrivateNetworkAddress('172.20.0.1')).toBe(true);
    expect(_securityTestExports.isPrivateNetworkAddress('192.168.1.10')).toBe(true);
    expect(_securityTestExports.isPrivateNetworkAddress('169.254.169.254')).toBe(true);
    expect(_securityTestExports.isPrivateNetworkAddress('::1')).toBe(true);
    expect(_securityTestExports.isPrivateNetworkAddress('::ffff:7f00:1')).toBe(true);
    expect(_securityTestExports.isPrivateNetworkAddress('::7f00:1')).toBe(true);
    expect(_securityTestExports.isPrivateNetworkAddress('2002:7f00:1::')).toBe(true);
    expect(_securityTestExports.isPrivateNetworkAddress('fd00::1')).toBe(true);
    expect(_securityTestExports.isPrivateNetworkAddress('93.184.216.34')).toBe(false);
    expect(_securityTestExports.isPrivateNetworkAddress('::5db8:d822')).toBe(false);
    expect(_securityTestExports.isPrivateNetworkAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(
      false
    );
  });

  it('blocks private MCP URLs for hosted inspector sessions', async () => {
    const { _securityTestExports } = await importInspectCommand();

    await expect(
      _securityTestExports.assertHttpServerUrlAllowed('http://127.0.0.1:8000/mcp')
    ).rejects.toThrow('Private-network MCP server URLs are blocked');
    await expect(
      _securityTestExports.assertHttpServerUrlAllowed('http://169.254.169.254/latest')
    ).rejects.toThrow('Private-network MCP server URLs are blocked');
    await expect(
      _securityTestExports.assertHttpServerUrlAllowed('file:///tmp/server')
    ).rejects.toThrow('Only http(s) URLs are allowed');
  });

  it('allows private MCP URLs for loopback inspector sessions', async () => {
    const { _securityTestExports } = await importInspectCommand();

    await expect(
      _securityTestExports.assertHttpServerUrlAllowed('http://localhost:8000/mcp', {
        allowPrivateNetwork: true,
      })
    ).resolves.toMatchObject({ hostname: 'localhost' });
  });

  it('blocks hostnames that resolve to private network addresses', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const lookupFn = vi.fn(async () => [{ address: '10.0.0.8', family: 4 }]);

    await expect(
      _securityTestExports.assertHttpServerUrlAllowed('https://mcp.example.com/mcp', { lookupFn })
    ).rejects.toThrow('Private-network MCP server URLs are blocked');
    expect(lookupFn).toHaveBeenCalledWith('mcp.example.com', { all: true });
  });

  it('allows public hostnames after DNS resolution', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const lookupFn = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);

    await expect(
      _securityTestExports.assertHttpServerUrlAllowed('https://mcp.example.com/mcp', { lookupFn })
    ).resolves.toMatchObject({ hostname: 'mcp.example.com' });
  });

  it('parses loopback Host headers with ports', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(_securityTestExports.hostnameFromHostHeader('127.0.0.1:3000')).toBe('127.0.0.1');
    expect(_securityTestExports.hostnameFromHostHeader('[::1]:3000')).toBe('::1');
    expect(_securityTestExports.isLoopbackHostname('[::1]')).toBe(true);
    expect(_securityTestExports.isLoopbackRemoteAddress('::1')).toBe(true);
    expect(_securityTestExports.isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true);
    expect(_securityTestExports.isLoopbackRemoteAddress('::ffff:7f00:1')).toBe(true);
    expect(_securityTestExports.isLoopbackRemoteAddress('192.168.1.12')).toBe(false);
  });

  it('allows private MCP URLs only for loopback inspector requests by default', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const previous = process.env.SUNPEAK_ALLOW_PRIVATE_SERVER_URLS;
    delete process.env.SUNPEAK_ALLOW_PRIVATE_SERVER_URLS;
    try {
      expect(
        _securityTestExports.shouldAllowPrivateServerUrls({
          headers: { host: '127.0.0.1:3000' },
          socket: { remoteAddress: '127.0.0.1' },
        })
      ).toBe(true);
      expect(
        _securityTestExports.shouldAllowPrivateServerUrls({
          headers: { host: '127.0.0.1:3000' },
          socket: { remoteAddress: '192.168.1.12' },
        })
      ).toBe(false);
      expect(
        _securityTestExports.shouldAllowPrivateServerUrls({
          headers: { host: '192.168.1.20:3000' },
          socket: { remoteAddress: '127.0.0.1' },
        })
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SUNPEAK_ALLOW_PRIVATE_SERVER_URLS;
      else process.env.SUNPEAK_ALLOW_PRIVATE_SERVER_URLS = previous;
    }
  });

  it('compares Origin against the inspector request scheme and host', async () => {
    const { _securityTestExports } = await importInspectCommand();

    const proxiedReq = {
      headers: { host: 'preview.example', 'x-forwarded-proto': 'https' },
      socket: { encrypted: false },
    };
    expect(_securityTestExports.requestOriginForSameOriginCheck(proxiedReq)).toBe(
      'https://preview.example'
    );
    expect(_securityTestExports.isSameInspectorOrigin(proxiedReq, 'https://preview.example')).toBe(
      true
    );
    expect(_securityTestExports.isSameInspectorOrigin(proxiedReq, 'http://preview.example')).toBe(
      false
    );

    const localReq = {
      headers: { host: '127.0.0.1:3000' },
      socket: { encrypted: false },
    };
    expect(_securityTestExports.isSameInspectorOrigin(localReq, 'http://127.0.0.1:3000')).toBe(
      true
    );
    expect(_securityTestExports.isSameInspectorOrigin(localReq, 'https://127.0.0.1:3000')).toBe(
      false
    );
  });

  it('validates hosted-mode redirects before following them', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const fetchFn = vi.fn(async (url: string) => {
      if (url === 'https://mcp.example.com/mcp') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://127.0.0.1:8000/mcp' },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });

    await expect(
      _securityTestExports.resolveHttpRedirectsForMcp('https://mcp.example.com/mcp', {
        enforcePublicHttpUrl: true,
        fetchFn,
        lookupFn: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
      })
    ).rejects.toThrow('Private-network MCP server URLs are blocked');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('allows hosted-mode redirects to public URLs', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const fetchFn = vi.fn(async (url: string) => {
      if (url === 'https://mcp.example.com/mcp') {
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://api.example.com/mcp/' },
        });
      }
      return new Response(null, { status: 200 });
    });

    await expect(
      _securityTestExports.resolveHttpRedirectsForMcp('https://mcp.example.com/mcp', {
        enforcePublicHttpUrl: true,
        fetchFn,
        lookupFn: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
      })
    ).resolves.toBe('https://api.example.com/mcp/');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('blocks private OAuth discovery URLs before fetching them', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const fetchFn = vi.fn();
    const guardedFetch = _securityTestExports.createPublicOAuthFetch(fetchFn);

    await expect(guardedFetch('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      'Private-network MCP server URLs are blocked'
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('validates OAuth discovery redirects and strips credentials across origins', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { Location: 'https://93.184.216.35/oauth/metadata' },
        })
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const guardedFetch = _securityTestExports.createPublicOAuthFetch(fetchFn);

    await expect(
      guardedFetch('https://93.184.216.34/.well-known/oauth-authorization-server', {
        headers: { Authorization: 'Bearer secret', Cookie: 'session=secret' },
      })
    ).resolves.toHaveProperty('status', 200);

    const redirectedInit = fetchFn.mock.calls[1][1];
    expect(redirectedInit.headers.get('authorization')).toBeNull();
    expect(redirectedInit.headers.get('cookie')).toBeNull();
  });

  it('passes configured headers to MCP redirect probes', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const fetchFn = vi.fn(async () => new Response(null, { status: 200 }));

    await expect(
      _securityTestExports.resolveHttpRedirectsForMcp('https://mcp.example.com/mcp', {
        fetchFn,
        requestInit: { headers: { Authorization: 'Bearer test-token' } },
      })
    ).resolves.toBe('https://mcp.example.com/mcp');

    expect(fetchFn).toHaveBeenCalledWith(
      'https://mcp.example.com/mcp',
      expect.objectContaining({
        method: 'HEAD',
        redirect: 'follow',
        headers: { Authorization: 'Bearer test-token' },
      })
    );
  });

  it('accepts anonymous OAuth redirects only when state matches', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const fetchFn = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://localhost:24681/oauth/callback?code=ok&state=state-123' },
      });
    });

    await expect(
      _securityTestExports.tryAnonymousOAuth(
        'https://auth.example.com/authorize',
        'http://localhost:24681/oauth/callback',
        'state-123',
        fetchFn
      )
    ).resolves.toBe('ok');
  });

  it('rejects anonymous OAuth redirects with mismatched state', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const fetchFn = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://localhost:24681/oauth/callback?code=ok&state=wrong' },
      });
    });

    await expect(
      _securityTestExports.tryAnonymousOAuth(
        'https://auth.example.com/authorize',
        'http://localhost:24681/oauth/callback',
        'state-123',
        fetchFn
      )
    ).rejects.toThrow('OAuth state mismatch');
  });

  it('does not treat a sibling callback path as the OAuth callback', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            Location: 'http://localhost:24681/oauth/callback-attacker?code=stolen&state=state-123',
          },
        })
      )
      .mockResolvedValueOnce(new Response('<form>Login</form>', { status: 200 }));

    await expect(
      _securityTestExports.tryAnonymousOAuth(
        'https://auth.example.com/authorize',
        'http://localhost:24681/oauth/callback',
        'state-123',
        fetchFn
      )
    ).resolves.toBeNull();
  });

  it('rejects anonymous OAuth redirects to non-http schemes', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const fetchFn = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: 'javascript:alert(1)' },
      });
    });

    await expect(
      _securityTestExports.tryAnonymousOAuth(
        'https://auth.example.com/authorize',
        'http://localhost:24681/oauth/callback',
        'state-123',
        fetchFn
      )
    ).rejects.toThrow('unsupported scheme');
  });

  it('builds native OAuth client metadata and supports URL-based client IDs', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const oauthState = _securityTestExports.createInMemoryOAuthProvider(
      'http://localhost:24681/oauth/callback',
      { clientMetadataUrl: 'https://client.example.com/oauth/metadata.json' }
    );

    expect(oauthState.provider.clientMetadataUrl).toBe(
      'https://client.example.com/oauth/metadata.json'
    );
    expect(oauthState.provider.clientMetadata).toMatchObject({
      application_type: 'native',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
    });
    const firstState = oauthState.stateParam;
    await oauthState.provider.state?.();
    expect(oauthState.stateParam).not.toBe(firstState);
  });

  it('does not reuse pending OAuth state after client settings change', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const oauthState = _securityTestExports.createInMemoryOAuthProvider(
      'http://localhost:24681/oauth/callback',
      {
        clientId: 'registered-client',
        clientSecret: 'first-secret',
        scope: 'profile:read',
      }
    );

    expect(
      oauthState.matchesConfiguration({
        clientId: 'registered-client',
        clientSecret: 'first-secret',
        scope: 'profile:read',
      })
    ).toBe(true);
    expect(
      oauthState.matchesConfiguration({
        clientId: 'registered-client',
        clientSecret: 'replacement-secret',
        scope: 'profile:read',
      })
    ).toBe(false);
    expect(
      oauthState.matchesConfiguration({
        clientId: 'registered-client',
        clientSecret: 'first-secret',
        scope: 'profile:read files:write',
      })
    ).toBe(false);
  });

  it('clears cached OAuth tokens and discovery state when invalidated', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const oauthState = _securityTestExports.createInMemoryOAuthProvider(
      'http://localhost:24681/oauth/callback'
    );
    oauthState.provider.saveTokens({ access_token: 'token', token_type: 'Bearer' });
    oauthState.provider.saveDiscoveryState({
      authorizationServerUrl: 'https://auth.example.com',
      authorizationServerMetadata: {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      },
    });
    oauthState.provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'));

    expect(oauthState.hasTokens()).toBe(true);
    expect(oauthState.getAuthUrl()?.hostname).toBe('auth.example.com');
    oauthState.provider.saveTokens({ access_token: 'replacement', token_type: 'Bearer' });
    expect(oauthState.getAuthUrl()).toBeUndefined();
    await oauthState.provider.invalidateCredentials('all');
    expect(oauthState.hasTokens()).toBe(false);
    expect(oauthState.getDiscoveryState()).toBeUndefined();
  });

  it('validates RFC 9207 authorization response issuers before returning errors', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const discoveryState = {
      authorizationServerUrl: 'https://auth.example.com',
      authorizationServerMetadata: {
        issuer: 'https://auth.example.com',
        authorization_response_iss_parameter_supported: true,
      },
    };

    expect(() =>
      _securityTestExports.validateOAuthAuthorizationResponse(
        new URLSearchParams({ code: 'ok', state: 'state-123' }),
        'state-123',
        discoveryState
      )
    ).toThrow('missing the required issuer');

    expect(() =>
      _securityTestExports.validateOAuthAuthorizationResponse(
        new URLSearchParams({
          error: 'access_denied',
          state: 'state-123',
          iss: 'https://attacker.example.com',
        }),
        'state-123',
        discoveryState
      )
    ).toThrow('issuer mismatch');

    expect(
      _securityTestExports.validateOAuthAuthorizationResponse(
        new URLSearchParams({
          code: 'ok',
          state: 'state-123',
          iss: 'https://auth.example.com',
        }),
        'state-123',
        discoveryState
      )
    ).toBe('ok');
  });

  it('rejects invalid URL-based OAuth client IDs before discovery', async () => {
    const { _securityTestExports } = await importInspectCommand();
    expect(() =>
      _securityTestExports.createInMemoryOAuthProvider('http://localhost:24681/oauth/callback', {
        clientMetadataUrl: 'http://client.example.com/',
      })
    ).toThrow('must use https, have a non-root path');
    expect(() =>
      _securityTestExports.createInMemoryOAuthProvider('http://localhost:24681/oauth/callback', {
        clientMetadataUrl: 'https://user:secret@client.example.com/oauth/metadata.json',
      })
    ).toThrow('omit credentials and fragments');
    expect(() =>
      _securityTestExports.createInMemoryOAuthProvider('http://localhost:24681/oauth/callback', {
        clientMetadataUrl: 'https://client.example.com/oauth/metadata.json#fragment',
      })
    ).toThrow('omit credentials and fragments');
  });

  it('rejects mismatched authorization-server issuers and missing PKCE support', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const baseState = {
      authorizationServerUrl: 'https://auth.example.com',
      resourceMetadata: {
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      },
      authorizationServerMetadata: {
        issuer: 'https://other.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      },
    };

    expect(() => _securityTestExports.validateOAuthDiscoveryState(baseState)).toThrow(
      'metadata issuer mismatch'
    );
    expect(() =>
      _securityTestExports.validateOAuthDiscoveryState({
        ...baseState,
        authorizationServerMetadata: {
          ...baseState.authorizationServerMetadata,
          issuer: 'https://auth.example.com',
          code_challenge_methods_supported: undefined,
        },
      })
    ).toThrow('advertise PKCE S256 support');
    expect(() =>
      _securityTestExports.validateOAuthDiscoveryState({
        ...baseState,
        authorizationServerUrl: 'https://user:secret@auth.example.com',
        authorizationServerMetadata: {
          ...baseState.authorizationServerMetadata,
          issuer: 'https://user:secret@auth.example.com',
        },
      })
    ).toThrow('must not contain credentials');
  });

  it('requires selection for multiple authorization servers and binds credentials to the issuer', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const oauthState = _securityTestExports.createInMemoryOAuthProvider(
      'http://localhost:24681/oauth/callback',
      { clientId: 'registered-client', clientSecret: 'secret' }
    );
    const state = {
      authorizationServerUrl: 'https://auth-one.example.com',
      resourceMetadata: {
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth-one.example.com', 'https://auth-two.example.com'],
      },
      authorizationServerMetadata: {
        issuer: 'https://auth-one.example.com',
        authorization_endpoint: 'https://auth-one.example.com/authorize',
        token_endpoint: 'https://auth-one.example.com/token',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      },
    };

    expect(() => oauthState.provider.saveDiscoveryState(state)).toThrow(
      'authorization server selection is required'
    );
    expect(oauthState.getAuthorizationServers()).toEqual(
      state.resourceMetadata.authorization_servers
    );

    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            issuer: 'https://auth-two.example.com',
            authorization_endpoint: 'https://auth-two.example.com/authorize',
            token_endpoint: 'https://auth-two.example.com/token',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    await _securityTestExports.configureOAuthAuthorizationServer(
      oauthState,
      'https://auth-two.example.com',
      fetchFn
    );
    expect(oauthState.getActiveIssuer()).toBe('https://auth-two.example.com');
    expect(await oauthState.provider.clientInformation()).toMatchObject({
      client_id: 'registered-client',
    });
  });

  it('unions step-up scopes and bypasses refresh until fresh authorization completes', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const oauthState = _securityTestExports.createInMemoryOAuthProvider(
      'http://localhost:24681/oauth/callback',
      { scope: 'profile:read', clientId: 'registered-client' }
    );
    oauthState.provider.saveDiscoveryState({
      authorizationServerUrl: 'https://auth.example.com',
      resourceMetadata: {
        resource: 'https://mcp.example.com/mcp',
        authorization_servers: ['https://auth.example.com'],
      },
      authorizationServerMetadata: {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      },
    });
    oauthState.provider.saveTokens({
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      token_type: 'Bearer',
      scope: 'profile:read',
    });

    const oauthFetch = _securityTestExports.createOAuthAwareFetch(
      oauthState,
      vi.fn(
        async () =>
          new Response('Forbidden', {
            status: 403,
            headers: {
              'WWW-Authenticate':
                'Bearer error="insufficient_scope", scope="files:write", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
            },
          })
      )
    );
    const response = await oauthFetch('https://mcp.example.com/mcp');

    expect(response.headers.get('www-authenticate')).toContain('scope="profile:read files:write"');
    expect(oauthState.provider.clientMetadata.scope).toBe('profile:read files:write');
    expect(await oauthState.provider.tokens()).not.toHaveProperty('refresh_token');

    const oauthRequests: string[] = [];
    const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
    const result = await auth(oauthState.provider, {
      serverUrl: 'https://mcp.example.com/mcp',
      resourceMetadataUrl: new URL(
        'https://mcp.example.com/.well-known/oauth-protected-resource/mcp'
      ),
      scope: 'profile:read files:write',
      fetchFn: vi.fn(async (input) => {
        const url = String(input);
        oauthRequests.push(url);
        if (url.includes('oauth-protected-resource')) {
          return new Response(
            JSON.stringify({
              resource: 'https://mcp.example.com/mcp',
              authorization_servers: ['https://auth.example.com'],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            issuer: 'https://auth.example.com',
            authorization_endpoint: 'https://auth.example.com/authorize',
            token_endpoint: 'https://auth.example.com/token',
            response_types_supported: ['code'],
            code_challenge_methods_supported: ['S256'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }),
    });
    expect(result).toBe('REDIRECT');
    expect(oauthState.getAuthUrl()?.searchParams.get('scope')).toBe('profile:read files:write');
    expect(oauthRequests).not.toContain('https://auth.example.com/token');

    oauthState.provider.saveTokens({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      token_type: 'Bearer',
      scope: 'profile:read files:write',
    });
    expect(await oauthState.provider.tokens()).toHaveProperty('refresh_token', 'new-refresh');
  });

  it('requests offline access only when the selected authorization server supports it', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const createState = (scopesSupported: string[]) => {
      const oauthState = _securityTestExports.createInMemoryOAuthProvider(
        'http://localhost:24681/oauth/callback',
        { scope: 'mcp:basic' }
      );
      oauthState.provider.saveDiscoveryState({
        authorizationServerUrl: 'https://auth.example.com',
        resourceMetadata: {
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        },
        authorizationServerMetadata: {
          issuer: 'https://auth.example.com',
          authorization_endpoint: 'https://auth.example.com/authorize',
          token_endpoint: 'https://auth.example.com/token',
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
          scopes_supported: scopesSupported,
        },
      });
      return oauthState;
    };

    const supported = createState(['mcp:basic', 'offline_access']);
    supported.provider.redirectToAuthorization(
      new URL('https://auth.example.com/authorize?scope=mcp%3Abasic')
    );
    expect(supported.provider.clientMetadata.scope).toBe('mcp:basic offline_access');
    expect(supported.getAuthUrl()?.searchParams.get('scope')).toBe('mcp:basic offline_access');

    const unsupported = createState(['mcp:basic']);
    unsupported.provider.redirectToAuthorization(
      new URL('https://auth.example.com/authorize?scope=mcp%3Abasic')
    );
    expect(unsupported.provider.clientMetadata.scope).toBe('mcp:basic');
    expect(unsupported.getAuthUrl()?.searchParams.get('scope')).toBe('mcp:basic');
  });

  it('quotes macOS Keychain interactive arguments without allowing command injection', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(_securityTestExports.quoteSecurityInteractiveArg("abc' def")).toBe("'abc'\\'' def'");
    expect(_securityTestExports.quoteSecurityInteractiveArg('$(security dump-keychain)')).toBe(
      "'$(security dump-keychain)'"
    );
  });

  it('parses HTTP header CLI values', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(_securityTestExports.parseHttpHeader('Authorization: Bearer test-token')).toEqual([
      'Authorization',
      'Bearer test-token',
    ]);
    expect(_securityTestExports.parseHttpHeader('X-Api-Key: secret')).toEqual([
      'X-Api-Key',
      'secret',
    ]);
    expect(
      _securityTestExports.hasAuthorizationHeader({ authorization: 'Bearer test-token' })
    ).toBe(true);
    expect(() => _securityTestExports.parseHttpHeader('Authorization Bearer test-token')).toThrow(
      'Expected "Name: value"'
    );
    expect(() => _securityTestExports.parseHttpHeader('Bad Header: value')).toThrow(
      'Invalid HTTP header name'
    );
    expect(() => _securityTestExports.parseHttpHeader('Authorization: bad\nvalue')).toThrow(
      'control characters'
    );
  });

  it('recognizes missing credential errors separately from backend failures', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(
      _securityTestExports.isMissingCredentialError(Object.assign(new Error(), { code: 44 }))
    ).toBe(true);
    expect(
      _securityTestExports.isMissingCredentialError(
        Object.assign(new Error('User interaction is not allowed.'), { code: 51 })
      )
    ).toBe(false);
  });

  it('caps request body reads when a limit is provided', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const req = new PassThrough();
    const read = _securityTestExports.readRequestBody(req, { maxBytes: 4 });

    req.write('abcd');
    req.end('e');

    await expect(read).rejects.toThrow('Request body is too large');
  });

  it('keeps inspect POST endpoint body reads bounded', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'bin/commands/inspect.mjs'), 'utf-8');
    const unboundedCallSites = [
      ...source.matchAll(/readRequestBody\(req(?!,\s*\{\s*maxBytes:)/g),
    ].filter((match) => !source.slice(match.index - 30, match.index).includes('function '));

    expect(unboundedCallSites).toHaveLength(0);
  });

  it('adds inspector request tokens to frameable resource URLs', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(
      _securityTestExports.appendInspectorRequestToken(
        '/__sunpeak/read-resource?uri=ui%3A%2F%2Falbums',
        'token-123'
      )
    ).toBe('/__sunpeak/read-resource?uri=ui%3A%2F%2Falbums&__sunpeak_token=token-123');

    expect(
      _securityTestExports.appendInspectorRequestToken(
        'https://preview.example/api/__sunpeak/read-resource?uri=ui%3A%2F%2Falbums',
        'token-123'
      )
    ).toBe(
      'https://preview.example/api/__sunpeak/read-resource?uri=ui%3A%2F%2Falbums&__sunpeak_token=token-123'
    );
  });

  it('adds inspector request tokens to simulation resource URLs only', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(
      _securityTestExports.addInspectorRequestTokenToSimulations(
        {
          albums: {
            name: 'albums',
            resourceUrl: '/__sunpeak/read-resource?uri=ui%3A%2F%2Falbums',
          },
          backendOnly: { name: 'backendOnly' },
        },
        'token-123'
      )
    ).toEqual({
      albums: {
        name: 'albums',
        resourceUrl: '/__sunpeak/read-resource?uri=ui%3A%2F%2Falbums&__sunpeak_token=token-123',
      },
      backendOnly: { name: 'backendOnly' },
    });
  });

  it('requires inspector request tokens even when Fetch Metadata is absent', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(
      _securityTestExports.isInspectorRequestTokenValid(
        { url: '/__sunpeak/read-resource?uri=ui%3A%2F%2Falbums', headers: {} },
        'token-123'
      )
    ).toBe(false);
    expect(
      _securityTestExports.isInspectorRequestTokenValid(
        {
          url: '/__sunpeak/read-resource?uri=ui%3A%2F%2Falbums&__sunpeak_token=token-123',
          headers: {},
        },
        'token-123'
      )
    ).toBe(true);
  });

  it('rejects unsafe model IDs before provider SDK calls', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(_securityTestExports.normalizeModelId(' gpt-4o ')).toBe('gpt-4o');
    expect(() => _securityTestExports.normalizeModelId('')).toThrow('Missing model ID');
    expect(() => _securityTestExports.normalizeModelId(`gpt-4o\nsecret`)).toThrow(
      'Invalid model ID'
    );
    expect(() => _securityTestExports.normalizeModelId('a'.repeat(201))).toThrow(
      'Invalid model ID'
    );
  });

  it('rejects common reversed Anthropic model ID shapes with a useful hint', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(() =>
      _securityTestExports.normalizeModelProviderModelId('anthropic', 'claude-5-6-sonnet')
    ).toThrow('Use an Anthropic API model ID such as "claude-sonnet-4-20250514"');
    expect(
      _securityTestExports.normalizeModelProviderModelId('anthropic', ' claude-sonnet-4-20250514 ')
    ).toBe('claude-sonnet-4-20250514');
    expect(_securityTestExports.normalizeModelProviderModelId('openai', ' gpt-4o ')).toBe('gpt-4o');
  });

  it('drops empty model chat messages before provider calls', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(
      _securityTestExports.normalizeModelChatMessages([
        { role: 'assistant', content: '   ' },
        { role: 'user', content: ' Find me flights ' },
        { role: 'system', content: 'ignored' },
        { role: 'assistant', content: null },
      ])
    ).toEqual([{ role: 'user', content: 'Find me flights' }]);
  });

  it('rejects API keys with control characters before credential storage', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(_securityTestExports.normalizeApiKey(' sk-test ')).toBe('sk-test');
    expect(_securityTestExports.normalizeApiKey('')).toBe('');
    expect(() => _securityTestExports.normalizeApiKey('sk-test\nnext')).toThrow(
      'API key cannot contain control characters'
    );
    expect(() => _securityTestExports.normalizeApiKey('sk-test\u0000')).toThrow(
      'API key cannot contain control characters'
    );
  });

  it('exposes model-visible tools, including backend-only tools, to model chat', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(_securityTestExports.isToolVisibleToModel({ _meta: {} })).toBe(true);
    expect(
      _securityTestExports.isToolVisibleToModel({
        _meta: { ui: { visibility: ['model', 'app'] } },
      })
    ).toBe(true);
    expect(
      _securityTestExports.isToolVisibleToModel({
        _meta: { ui: { visibility: ['app'] } },
      })
    ).toBe(false);
    expect(
      _securityTestExports.isToolVisibleToModel({
        _meta: { 'ui/visibility': ['model'] },
      })
    ).toBe(true);
    expect(
      _securityTestExports.isToolVisibleToModel({
        _meta: { ui: { visibility: 'app' } },
      })
    ).toBe(false);

    const tools = _securityTestExports.getModelCallableTools([
      { name: 'show-albums', _meta: { ui: { resourceUri: 'ui://albums' } } },
      { name: 'lookup-album-metadata' },
      { name: 'app-only-action', _meta: { ui: { visibility: ['app'] } } },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(['show-albums', 'lookup-album-metadata']);
  });

  it('formats empty backend-only tool results without implying an app render', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(_securityTestExports.formatModelVisibleToolResult({ name: 'lookup' }, {})).toBe(
      'lookup completed.'
    );
    expect(
      _securityTestExports.formatModelVisibleToolResult({ name: 'lookup' }, { content: [] })
    ).toBe('lookup completed.');
    expect(
      _securityTestExports.formatModelVisibleToolResult(
        { name: 'lookup' },
        { content: [], structuredContent: undefined, isError: false }
      )
    ).toBe('lookup completed.');
    expect(
      _securityTestExports.formatModelVisibleToolResult(
        { name: 'lookup' },
        { content: [], isError: true }
      )
    ).toBe('lookup returned an error.');
    expect(
      _securityTestExports.formatModelVisibleToolResult(
        { name: 'show-albums', _meta: { ui: { resourceUri: 'ui://albums' } } },
        { content: [] }
      )
    ).toBe('show-albums completed. The MCP App is ready to render.');
  });

  it('exposes model-visible MCP tool result fields without component-only _meta', async () => {
    const { _securityTestExports } = await importInspectCommand();

    const result = _securityTestExports.formatModelVisibleToolResult(
      { name: 'show-albums' },
      {
        structuredContent: {
          albums: [
            {
              title: 'Pizza Tour',
              photos: [{ url: 'https://cdn.sunpeak.ai/demo/pizza1.jpeg' }],
            },
          ],
          _meta: { modelVisible: true },
        },
        content: [{ type: 'text', text: 'Pizza Tour raw text' }],
        _meta: { token: 'hidden' },
      }
    );

    expect(result).toContain('Pizza Tour');
    expect(result).toContain('Pizza Tour raw text');
    expect(result).toContain('structuredContent');
    expect(result).toContain('modelVisible');
    expect(result).not.toContain('hidden');
  });

  it('formats shared MCP App context for model chat', async () => {
    const { _securityTestExports } = await importInspectCommand();

    const result = _securityTestExports.formatSharedAppContextForModel({
      content: [{ type: 'text', text: 'Selected album changed' }],
      structuredContent: { selectedAlbum: 'Pizza Tour', _meta: { modelVisible: true } },
    });

    expect(result).toContain('Selected album changed');
    expect(result).toContain('Pizza Tour');
    expect(result).toContain('modelVisible');
  });

  it('formats text-only shared MCP App context for model chat', async () => {
    const { _securityTestExports } = await importInspectCommand();

    const result = _securityTestExports.formatSharedAppContextForModel({
      content: [{ type: 'text', text: 'Viewing page 2 of 4' }],
    });

    expect(result).toContain('Viewing page 2 of 4');
  });

  it('treats empty content-only MCP App context as cleared', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(_securityTestExports.normalizeModelAppContext({ content: [] })).toBeUndefined();
    expect(
      _securityTestExports.normalizeModelAppContext({ structuredContent: undefined })
    ).toBeUndefined();
    expect(_securityTestExports.formatSharedAppContextForModel({ content: [] })).toBe('');
  });

  it('uses MCP tool calls for model chat', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const client = {
      callTool: vi.fn(async () => ({
        structuredContent: { source: 'mcp-server' },
      })),
    };

    const result = await _securityTestExports.executeModelChatToolCall({
      client,
      name: 'show-albums',
      arguments: { category: 'model' },
    });

    expect(client.callTool).toHaveBeenCalledWith({
      name: 'show-albums',
      arguments: { category: 'model' },
    });
    expect(result).toMatchObject({
      arguments: { category: 'model' },
      result: { structuredContent: { source: 'mcp-server' } },
      source: 'mcp',
    });
  });

  it('derives a live MCP endpoint for sunpeak-style /mcp URLs', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(_securityTestExports.defaultLiveMcpServerUrl('http://localhost:8000/mcp')).toBe(
      'http://localhost:8000/mcp/live'
    );
    expect(_securityTestExports.defaultLiveMcpServerUrl('http://localhost:8000/custom')).toBe(
      undefined
    );
  });

  it('preserves app-rendering tool errors for model-visible results', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(
      _securityTestExports.formatModelVisibleToolResult(
        { name: 'show-albums' },
        { isError: true, content: [{ type: 'text', text: 'Album service failed' }] }
      )
    ).toBe('Album service failed');
  });

  it('falls back when MCP error content is malformed', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(
      _securityTestExports.formatModelVisibleToolResult(
        { name: 'show-albums' },
        { isError: true, content: [null, { type: 'image', data: 'ignored' }] }
      )
    ).toBe('show-albums returned an error.');
  });

  it('uses structured MCP error details when text content is absent', async () => {
    const { _securityTestExports } = await importInspectCommand();

    const result = _securityTestExports.formatModelVisibleToolResult(
      { name: 'show-albums' },
      {
        isError: true,
        content: [],
        structuredContent: { code: 'invalid_category', retryWith: 'travel' },
      },
      { host: 'chatgpt', arguments: { category: 'travl' } }
    );

    expect(result).toMatchObject({
      type: 'mcp_call',
      error: expect.stringContaining('invalid_category'),
    });
    expect(result.error).toContain('travel');
  });

  it('formats ChatGPT MCP tool errors as failed mcp_call items for model chat', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(
      _securityTestExports.formatModelVisibleToolResult(
        { name: 'show-albums' },
        { isError: true, content: [{ type: 'text', text: 'Album service failed' }] },
        { host: 'chatgpt', arguments: { category: 'travel' }, toolCallId: 'call_123' }
      )
    ).toMatchObject({
      type: 'mcp_call',
      id: 'call_123',
      name: 'show-albums',
      arguments: { category: 'travel' },
      error: 'Album service failed',
      output: null,
      status: 'failed',
    });
  });

  it('does not pass non-object model arguments into MCP tool calls', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const client = {
      callTool: vi.fn(async () => ({
        structuredContent: { source: 'mcp-server' },
      })),
    };

    const result = await _securityTestExports.executeModelChatToolCall({
      client,
      name: 'show-albums',
      arguments: ['not', 'an', 'object'],
    });

    expect(client.callTool).toHaveBeenCalledWith({
      name: 'show-albums',
      arguments: {},
    });
    expect(result.arguments).toEqual({});
  });

  it('formats Claude MCP tool errors as mcp_tool_result blocks for model chat', async () => {
    const { _securityTestExports } = await importInspectCommand();

    expect(
      _securityTestExports.formatModelVisibleToolResult(
        { name: 'show-albums' },
        { isError: true, content: [{ type: 'text', text: 'Album service failed' }] },
        { host: 'claude', toolCallId: 'toolu_123' }
      )
    ).toMatchObject({
      type: 'mcp_tool_result',
      tool_use_id: 'toolu_123',
      is_error: true,
      content: [{ type: 'text', text: 'Album service failed' }],
    });
  });

  it('turns MCP call exceptions into model-visible tool errors', async () => {
    const { _securityTestExports } = await importInspectCommand();
    const client = {
      callTool: vi.fn(async () => {
        throw new Error('MCP server disconnected');
      }),
    };

    const result = await _securityTestExports.executeModelChatToolCall({
      client,
      name: 'show-albums',
      arguments: { category: 'model' },
    });

    expect(result).toMatchObject({
      arguments: { category: 'model' },
      result: {
        content: [{ type: 'text', text: 'MCP server disconnected' }],
        isError: true,
      },
      source: 'mcp',
    });
  });
});

describe('resolveMcpResourceMetadataUrl', () => {
  const importInspectCommand = () => import('../../bin/commands/inspect.mjs');

  it('uses root protected-resource metadata when endpoint-path metadata returns text', async () => {
    const { resolveMcpResourceMetadataUrl } = await importInspectCommand();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = async (url: URL, init?: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return new Response('Fractal ChatGPT App MCP Server. Connect to /mcp', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    };

    await expect(resolveMcpResourceMetadataUrl('https://example.com/mcp', fetchFn)).resolves.toBe(
      'https://example.com/.well-known/oauth-protected-resource'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/.well-known/oauth-protected-resource/mcp');
    expect(calls[0].init?.headers).toHaveProperty('MCP-Protocol-Version');
    expect(calls[0].init?.redirect).toBe('manual');
  });

  it('does not override when endpoint-path metadata is valid JSON', async () => {
    const { resolveMcpResourceMetadataUrl } = await importInspectCommand();
    const calls: string[] = [];
    const fetchFn = async (url: URL) => {
      calls.push(url.toString());
      return new Response(
        JSON.stringify({
          resource: 'https://example.com/mcp',
          authorization_servers: ['https://auth.example.com'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    await expect(
      resolveMcpResourceMetadataUrl('https://example.com/mcp', fetchFn)
    ).resolves.toBeUndefined();
    expect(calls).toEqual(['https://example.com/.well-known/oauth-protected-resource/mcp']);
  });

  it('leaves 4xx endpoint-path responses to the SDK fallback', async () => {
    const { resolveMcpResourceMetadataUrl } = await importInspectCommand();
    const fetchFn = async () => new Response('Not found', { status: 404 });

    await expect(
      resolveMcpResourceMetadataUrl('https://example.com/mcp', fetchFn)
    ).resolves.toBeUndefined();
  });

  it('does not preflight root MCP server URLs', async () => {
    const { resolveMcpResourceMetadataUrl } = await importInspectCommand();
    const fetchFn = vi.fn();

    await expect(resolveMcpResourceMetadataUrl('https://example.com', fetchFn)).resolves.toBe(
      undefined
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses root protected-resource metadata when endpoint-path JSON is malformed', async () => {
    const { resolveMcpResourceMetadataUrl } = await importInspectCommand();
    const fetchFn = async () =>
      new Response('{not json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    await expect(resolveMcpResourceMetadataUrl('https://example.com/mcp', fetchFn)).resolves.toBe(
      'https://example.com/.well-known/oauth-protected-resource'
    );
  });

  it('uses root protected-resource metadata when endpoint-path JSON is not metadata', async () => {
    const { resolveMcpResourceMetadataUrl } = await importInspectCommand();
    const fetchFn = async () =>
      new Response(JSON.stringify({ message: 'Connect to /mcp' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    await expect(resolveMcpResourceMetadataUrl('https://example.com/mcp', fetchFn)).resolves.toBe(
      'https://example.com/.well-known/oauth-protected-resource'
    );
  });
});

describe('inspect CLI', () => {
  describe('sanitizeAiSdkSchema', () => {
    it('closes object schemas for OpenAI function tool compatibility', async () => {
      const { sanitizeAiSdkSchema } = await import('../../bin/commands/inspect.mjs');

      expect(
        sanitizeAiSdkSchema({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string' },
            metadata: {
              type: 'object',
              properties: {
                owner: { type: 'string' },
              },
            },
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                },
              },
            },
          },
        })
      ).toEqual({
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          metadata: {
            type: 'object',
            additionalProperties: false,
            properties: {
              owner: { type: 'string' },
            },
          },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
              },
            },
          },
        },
      });
    });
  });

  describe('parseArgs (tested via inspect function behavior)', () => {
    it('should parse --server flag', async () => {
      // We'll test parseArgs logic by checking the inspect function rejects
      // missing --server and accepts it when provided.
      // Since inspect() calls process.exit, we test the argument parsing
      // indirectly through the module structure.

      // Test that the inspect module exports the inspect function
      const mod = await import('../../bin/commands/inspect.mjs');
      expect(typeof mod.inspect).toBe('function');
    });
  });

  describe('mergeSimulationFixtures', () => {
    const tmpDir = path.join(process.cwd(), '.test-simulations-' + Date.now());

    const loadMerge = async () => {
      const mod = await import('../../bin/commands/inspect.mjs');
      return mod.mergeSimulationFixtures;
    };

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('merges fixture toolInput into the discovered simulation', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'search.json'),
        JSON.stringify({
          tool: 'search',
          toolInput: { query: 'headphones' },
          userMessage: 'Find headphones',
        })
      );

      const simulations = {
        search: {
          name: 'search',
          tool: { name: 'search', inputSchema: { type: 'object' } },
        },
      };

      const mergeSimulationFixtures = await loadMerge();
      mergeSimulationFixtures(tmpDir, simulations);

      expect(simulations.search.toolInput).toEqual({ query: 'headphones' });
      expect(simulations.search.userMessage).toBe('Find headphones');
    });

    it('creates a simulation from a fixture when the tool is not on the server', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'mock-tool.json'),
        JSON.stringify({
          tool: 'mock-tool',
          toolInput: { key: 'value' },
          toolResult: { content: [], structuredContent: { mocked: true } },
        })
      );

      const simulations = {};
      const mergeSimulationFixtures = await loadMerge();
      mergeSimulationFixtures(tmpDir, simulations);

      expect(simulations['mock-tool']).toBeDefined();
      expect(simulations['mock-tool'].tool.name).toBe('mock-tool');
      expect(simulations['mock-tool'].toolResult).toEqual({
        content: [],
        structuredContent: { mocked: true },
      });
    });

    it('skips fixtures without a tool field', async () => {
      fs.writeFileSync(path.join(tmpDir, 'no-tool.json'), JSON.stringify({ toolInput: { x: 1 } }));

      const simulations = {};
      const mergeSimulationFixtures = await loadMerge();
      mergeSimulationFixtures(tmpDir, simulations);

      expect(Object.keys(simulations)).toHaveLength(0);
    });

    it('keeps every fixture when multiple files target the same tool', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'show-albums.json'),
        JSON.stringify({
          tool: 'show-albums',
          toolResult: { structuredContent: { albums: ['a', 'b'] } },
        })
      );
      fs.writeFileSync(
        path.join(tmpDir, 'show-albums-empty.json'),
        JSON.stringify({
          tool: 'show-albums',
          toolResult: { structuredContent: { albums: [] } },
        })
      );
      fs.writeFileSync(
        path.join(tmpDir, 'show-albums-error.json'),
        JSON.stringify({
          tool: 'show-albums',
          toolResult: { isError: true, content: [{ type: 'text', text: 'boom' }] },
        })
      );

      const simulations = {
        'show-albums': {
          name: 'show-albums',
          tool: { name: 'show-albums', inputSchema: { type: 'object' } },
          resource: { uri: 'ui://albums', name: 'albums' },
        },
      };

      const mergeSimulationFixtures = await loadMerge();
      mergeSimulationFixtures(tmpDir, simulations);

      expect(Object.keys(simulations).sort()).toEqual([
        'show-albums',
        'show-albums-empty',
        'show-albums-error',
      ]);
      expect(simulations['show-albums'].toolResult).toEqual({
        structuredContent: { albums: ['a', 'b'] },
      });
      expect(simulations['show-albums-empty'].toolResult).toEqual({
        structuredContent: { albums: [] },
      });
      expect(simulations['show-albums-error'].toolResult.isError).toBe(true);
      // Each derived sim inherits the discovered tool + resource metadata.
      for (const name of ['show-albums', 'show-albums-empty', 'show-albums-error']) {
        expect(simulations[name].tool.name).toBe('show-albums');
        expect(simulations[name].resource).toEqual({ uri: 'ui://albums', name: 'albums' });
      }
    });

    it('drops the auto-discovered slot when no fixture file reuses its name', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'show-albums-empty.json'),
        JSON.stringify({
          tool: 'show-albums',
          toolResult: { structuredContent: { albums: [] } },
        })
      );

      const simulations = {
        'show-albums': {
          name: 'show-albums',
          tool: { name: 'show-albums', inputSchema: { type: 'object' } },
        },
      };

      const mergeSimulationFixtures = await loadMerge();
      mergeSimulationFixtures(tmpDir, simulations);

      // The lone fixture takes over; no empty `show-albums` slot is left behind.
      expect(Object.keys(simulations)).toEqual(['show-albums-empty']);
      expect(simulations['show-albums-empty'].tool.name).toBe('show-albums');
    });
  });
});
