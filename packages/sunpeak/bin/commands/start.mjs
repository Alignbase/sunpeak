#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { getPort } from '../lib/get-port.mjs';

/**
 * Start a production MCP server from built artifacts.
 *
 * Discovers compiled tools from dist/tools/, resources from dist/{name}/,
 * and optional server entry from dist/server.js. Registers tools with
 * real handlers and Zod schemas, serves pre-built resource HTML.
 *
 * Run `sunpeak build` before `sunpeak start`.
 */
export async function start(projectRoot = process.cwd(), args = []) {
  const pkgJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    console.error('Error: No package.json found in current directory');
    console.error('Make sure you are in a Sunpeak project directory');
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const distDir = join(projectRoot, 'dist');

  if (!existsSync(distDir)) {
    console.error('Error: No dist/ directory found. Run `sunpeak build` first.');
    process.exit(1);
  }

  // Parse CLI flags
  let port = parseInt(process.env.PORT || '8000');
  const portArgIndex = args.findIndex(arg => arg === '--port' || arg === '-p');
  if (portArgIndex !== -1 && args[portArgIndex + 1]) {
    port = parseInt(args[portArgIndex + 1]);
  }

  let host = process.env.HOST || '0.0.0.0';
  const hostArgIndex = args.findIndex(arg => arg === '--host');
  if (hostArgIndex !== -1 && args[hostArgIndex + 1]) {
    host = args[hostArgIndex + 1];
  }

  const jsonLogs = args.includes('--json-logs');
  const sse = args.includes('--sse');
  const stateless = args.includes('--stateless');
  let sseKeepAliveMs;
  const sseKeepAliveArgIndex = args.findIndex(arg => arg === '--sse-keep-alive-ms');
  if (
    sseKeepAliveArgIndex !== -1 &&
    (!args[sseKeepAliveArgIndex + 1] || args[sseKeepAliveArgIndex + 1].startsWith('--'))
  ) {
    console.error('Error: --sse-keep-alive-ms requires a value');
    process.exit(1);
  }
  const sseKeepAliveRaw =
    sseKeepAliveArgIndex !== -1 && args[sseKeepAliveArgIndex + 1]
      ? args[sseKeepAliveArgIndex + 1]
      : process.env.SUNPEAK_SSE_KEEP_ALIVE_MS;
  if (sseKeepAliveRaw != null) {
    sseKeepAliveMs = Number(sseKeepAliveRaw);
    if (!Number.isFinite(sseKeepAliveMs)) {
      console.error('Error: --sse-keep-alive-ms must be a number');
      process.exit(1);
    }
  }

  // Import production server from sunpeak
  const isTemplate = projectRoot.endsWith('/template') || projectRoot.endsWith('\\template');
  let sunpeakMcp;
  if (isTemplate) {
    // In workspace dev mode — import from TypeScript source via dynamic import
    // We compile on the fly using the parent's Vite (same pattern as dev.mjs)
    const parentSrc = join(projectRoot, '../src');
    const require = createRequire(pkgJsonPath);
    const vite = await import(findEsmEntry(require, 'vite'));
    const loaderServer = await vite.createServer({
      root: join(projectRoot, '..'),
      server: { middlewareMode: true },
      appType: 'custom',
      logLevel: 'silent',
    });
    sunpeakMcp = await loaderServer.ssrLoadModule('./src/mcp/index.ts');
    await loaderServer.close();
  } else {
    const require = createRequire(pkgJsonPath);
    const sunpeakBase = require.resolve('sunpeak').replace(/dist\/index\.(c)?js$/, '');
    sunpeakMcp = await import(pathToFileURL(join(sunpeakBase, 'dist/mcp/index.js')).href);
  }

  const { startProductionHttpServer, setJsonLogging } = sunpeakMcp;

  // Enable structured JSON logging if requested
  if (jsonLogs) {
    setJsonLogging(true);
  }

  // ========================================================================
  // Discover built resources
  // ========================================================================

  const resources = [];
  const entries = readdirSync(distDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'tools' || entry.name === 'build-output') continue;

    const name = entry.name;
    const jsonPath = join(distDir, name, `${name}.json`);
    const htmlPath = join(distDir, name, `${name}.html`);

    if (!existsSync(jsonPath) || !existsSync(htmlPath)) continue;

    const meta = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    const html = readFileSync(htmlPath, 'utf-8');

    resources.push({
      name: meta.name ?? name,
      uri: meta.uri ?? `ui://${name}`,
      html,
      description: meta.description,
      _meta: meta._meta,
    });
  }

  if (resources.length > 0) {
    console.log(`Found ${resources.length} resource(s): ${resources.map(r => r.name).join(', ')}`);
  }

  // ========================================================================
  // Load compiled tool modules
  // ========================================================================

  const toolsDir = join(distDir, 'tools');
  const tools = [];

  if (existsSync(toolsDir)) {
    const toolFiles = readdirSync(toolsDir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));

    for (const file of toolFiles) {
      const toolName = file.replace(/\.js$/, '');
      const toolPath = pathToFileURL(join(toolsDir, file)).href;

      try {
        const mod = await import(toolPath);
        const tool = mod.tool;
        const schema = mod.schema;
        const outputSchema = mod.outputSchema;
        const handler = mod.default;

        if (!tool) {
          console.warn(`Warning: No "tool" export in ${file}. Skipping.`);
          continue;
        }
        if (!handler || typeof handler !== 'function') {
          console.warn(`Warning: No default handler export in ${file}. Skipping.`);
          continue;
        }

        tools.push({ name: toolName, tool, schema, outputSchema, handler });
      } catch (err) {
        console.error(`Failed to load tool ${toolName}:`, err.message);
        process.exit(1);
      }
    }
  }

  if (tools.length === 0 && resources.length === 0) {
    console.error('Error: No compiled tools or resources found in dist/. Run `sunpeak build` first.');
    process.exit(1);
  }

  if (tools.length > 0) {
    console.log(`Found ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);
  }

  // ========================================================================
  // Load server entry (optional)
  // ========================================================================

  const serverEntryPath = join(distDir, 'server.js');
  let auth = undefined;
  let oauth = undefined;
  let serverConfig = {};

  if (existsSync(serverEntryPath)) {
    try {
      const serverEntry = await import(pathToFileURL(serverEntryPath).href);
      if (typeof serverEntry.auth === 'function') {
        auth = serverEntry.auth;
        console.log('Loaded auth from server entry');
      }
      if (serverEntry.oauth && typeof serverEntry.oauth === 'object') {
        oauth = serverEntry.oauth;
        console.log('Loaded OAuth metadata from server entry');
      }
      if (serverEntry.server) {
        serverConfig = serverEntry.server;
      }
    } catch (err) {
      console.error('Failed to load server entry:', err.message);
      process.exit(1);
    }
  }

  // ========================================================================
  // Start production MCP server
  // ========================================================================

  const name = serverConfig.name ?? pkg.name ?? 'sunpeak-app';
  const version = serverConfig.version ?? pkg.version ?? '0.1.0';

  // Find an available port (prefer the configured one)
  port = await getPort(port);

  console.log(`\nStarting ${name} v${version} on ${host}:${port}...`);
  if (stateless) console.log('Stateless mode enabled (no session tracking)');

  startProductionHttpServer(
    {
      name,
      version,
      serverInfo: serverConfig,
      tools,
      resources,
      auth,
      oauth,
      stateless,
      ...(sse ? { enableJsonResponse: false } : {}),
      ...(sseKeepAliveMs !== undefined ? { sseKeepAliveMs } : {}),
    },
    { port, host }
  );
}

/**
 * Resolve ESM entry point for a package (same utility as build.mjs)
 */
function findEsmEntry(require, packageName) {
  const resolvedPath = require.resolve(packageName);
  let dir = dirname(resolvedPath);
  while (dir !== dirname(dir)) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.name === packageName) {
        const exports = pkg.exports;
        if (exports?.['.']?.import) {
          const importEntry = exports['.'].import;
          const esmPath = typeof importEntry === 'string' ? importEntry : importEntry.default;
          if (esmPath) return pathToFileURL(join(dir, esmPath)).href;
        }
        if (pkg.module) return pathToFileURL(join(dir, pkg.module)).href;
        break;
      }
    }
    dir = dirname(dir);
  }
  return pathToFileURL(resolvedPath).href;
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  start(process.cwd(), args).catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
