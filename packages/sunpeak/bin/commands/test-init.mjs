import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as p from '@clack/prompts';
import { EVAL_PROVIDERS, generateModelLines } from '../lib/eval/eval-providers.mjs';
import { detectPackageManager } from '../utils.mjs';

/** Read the current sunpeak package version for pinning in scaffolded configs. */
function getSunpeakVersion() {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ? `^${pkg.version}` : 'latest';
  } catch {
    return 'latest';
  }
}

/**
 * Default dependencies (real implementations).
 * Override in tests via the `deps` parameter.
 */
async function defaultSelectProviders() {
  const selected = await p.multiselect({
    message: 'AI providers for evals (space to toggle, enter to skip)',
    options: EVAL_PROVIDERS.map((prov) => ({ value: prov, label: prov.label })),
    initialValues: [],
    required: false,
  });
  if (p.isCancel(selected)) return [];
  return selected;
}

export const defaultDeps = {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  execSync,
  cwd: () => process.cwd(),
  isTTY: () => !!process.stdin.isTTY,
  intro: p.intro,
  outro: p.outro,
  confirm: p.confirm,
  isCancel: p.isCancel,
  select: p.select,
  text: p.text,
  log: p.log,
  password: p.password,
  selectProviders: defaultSelectProviders,
  detectPackageManager,
};

/**
 * sunpeak test init — Scaffold test infrastructure for MCP servers.
 *
 * Detects project type and scaffolds accordingly:
 * - Non-JS projects: self-contained tests/sunpeak/ directory
 * - JS/TS projects: root-level config + test files
 * - sunpeak projects: migrate to defineConfig()
 *
 * Scaffolds 4 test types:
 * 1. E2E tests — Playwright-based inspector tests (mcp fixture)
 * 2. Visual regression — Screenshot comparison via result.screenshot()
 * 3. Live tests — Test against real ChatGPT/Claude hosts
 * 4. Evals — Multi-model tool calling reliability tests
 *
 * Unit tests are not scaffolded here — they're part of the sunpeak app
 * framework (`sunpeak new`) where tool handlers can be imported directly.
 */
export async function testInit(args = [], deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };

  d.intro('Setting up sunpeak tests');

  // Parse --server flag from CLI args
  const serverIdx = args.indexOf('--server');
  const cliServer = serverIdx !== -1 && args[serverIdx + 1] ? args[serverIdx + 1] : undefined;

  const projectType = detectProjectType(d);
  const interactive = d.isTTY();

  if (projectType === 'sunpeak') {
    await initSunpeakProject(d);
  } else if (projectType === 'js') {
    await initJsProject(cliServer, d);
  } else {
    await initExternalProject(cliServer, d);
  }

  // Offer to configure eval providers (skip without a TTY — prompts can't work)
  if (interactive) {
    const providers = await d.selectProviders();
    if (!d.isCancel(providers) && providers.length > 0) {
      const pm = d.detectPackageManager();
      const pkgsToInstall = ['ai', ...providers.map((p) => p.pkg)];
      const installCmd = `${pm} add -D ${pkgsToInstall.join(' ')}`;
      try {
        d.execSync(installCmd, { cwd: d.cwd(), stdio: 'inherit' });
      } catch {
        d.log.info(`Provider install failed. Install manually: ${installCmd}`);
      }

      // Uncomment selected models in eval.config.ts
      const evalDir = d.existsSync(join(d.cwd(), 'tests', 'evals'))
        ? join(d.cwd(), 'tests', 'evals')
        : d.existsSync(join(d.cwd(), 'tests', 'sunpeak', 'evals'))
          ? join(d.cwd(), 'tests', 'sunpeak', 'evals')
          : null;
      if (evalDir) {
        const configPath = join(evalDir, 'eval.config.ts');
        if (d.existsSync(configPath)) {
          let config = d.readFileSync(configPath, 'utf-8');
          for (const prov of providers) {
            for (const model of prov.models) {
              config = config.replace(
                new RegExp(
                  `^(\\s*)// ('${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',?.*)$`,
                  'm'
                ),
                '$1$2'
              );
            }
          }
          d.writeFileSync(configPath, config);
        }

        // Prompt for API keys and write .env
        const envLines = [];
        const seen = new Set();
        for (const prov of providers) {
          if (seen.has(prov.envVar)) continue;
          seen.add(prov.envVar);
          const key = await d.password({
            message: `${prov.envVar} (enter to skip)`,
            mask: '*',
          });
          if (!d.isCancel(key) && key) {
            // Strip newlines so a pasted value can't inject extra .env entries.
            const cleanKey = String(key)
              .replace(/[\r\n]+/g, '')
              .trim();
            if (cleanKey) envLines.push(`${prov.envVar}=${cleanKey}`);
          }
        }
        if (envLines.length > 0 && evalDir) {
          const relEnvPath = evalDir.startsWith(d.cwd())
            ? evalDir.slice(d.cwd().length + 1)
            : evalDir;
          d.writeFileSync(join(evalDir, '.env'), envLines.join('\n') + '\n');
          d.log.info(`API keys saved to ${relEnvPath}/.env (gitignored)`);
        }
      }
    }

    // Offer to install the testing skill
    const installSkill = await d.confirm({
      message: 'Install the test-mcp-server skill? (helps your coding agent write tests)',
      initialValue: true,
    });
    if (!d.isCancel(installSkill) && installSkill) {
      const pm = d.detectPackageManager();
      const dlx = pm === 'yarn' ? 'yarn dlx' : pm === 'npm' ? 'npx' : 'pnpm dlx';
      try {
        d.execSync(`${dlx} skills add Alignbase/sunpeak@test-mcp-server`, {
          cwd: d.cwd(),
          stdio: 'inherit',
        });
      } catch {
        d.log.info(
          `Skill install skipped. Install later: ${dlx} skills add Alignbase/sunpeak@test-mcp-server`
        );
      }
    }
  }

  d.outro('Done!');
}

function detectProjectType(d) {
  const cwd = d.cwd();
  const pkgPath = join(cwd, 'package.json');

  if (d.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(d.readFileSync(pkgPath, 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ('sunpeak' in deps) return 'sunpeak';
      return 'js';
    } catch {
      return 'js';
    }
  }

  // Non-JS project (Python, Go, Rust, etc.)
  return 'external';
}

async function getServerConfig(cliServer, d) {
  // If provided via --server flag, detect type automatically
  if (cliServer) {
    if (cliServer.startsWith('http://') || cliServer.startsWith('https://')) {
      return { type: 'url', value: cliServer };
    }
    return { type: 'command', value: cliServer };
  }

  // Without a TTY, interactive prompts can't work — default to "configure later".
  if (!d.isTTY()) {
    return { type: 'later' };
  }

  const serverType = await d.select({
    message: 'How does your MCP server start?',
    options: [
      { value: 'command', label: 'Command (e.g., python server.py)' },
      { value: 'url', label: 'HTTP URL (e.g., http://localhost:8000/mcp)' },
      { value: 'later', label: 'Configure later' },
    ],
  });

  if (d.isCancel(serverType)) process.exit(0);

  if (serverType === 'command') {
    const command = await d.text({
      message: 'Server start command:',
      placeholder: 'python src/server.py',
    });
    if (d.isCancel(command)) process.exit(0);
    return { type: 'command', value: command };
  }

  if (serverType === 'url') {
    const url = await d.text({
      message: 'Server URL:',
      placeholder: 'http://localhost:8000/mcp',
    });
    if (d.isCancel(url)) process.exit(0);
    return { type: 'url', value: url };
  }

  return { type: 'later' };
}

function generateServerConfigBlock(server, relativeTo = '.') {
  if (server.type === 'later') {
    return `  // TODO: Configure your MCP server connection before running tests.
  // Uncomment one of the options below:
  //
  // HTTP server (Python FastAPI, Go, etc.):
  // server: { url: 'http://localhost:8000/mcp' },
  //
  // Python (uv):
  // server: { command: 'uv', args: ['run', 'python', 'server.py'] },
  //
  // Python (venv):
  // server: { command: '.venv/bin/python', args: ['server.py'] },
  //
  // Go:
  // server: { command: 'go', args: ['run', './cmd/server'] },
  //
  // Node.js:
  // server: { command: 'node', args: ['server.js'] },
  //
  // Optional server options:
  // server: {
  //   command: 'python', args: ['server.py'],
  //   env: { API_KEY: 'test-key' },  // Extra environment variables
  //   cwd: './backend',               // Working directory
  // },
  //
  // timeout: 120_000,  // Server startup timeout in ms (default: 60s)`;
  }
  if (server.type === 'url') {
    return `  server: {
    url: ${JSON.stringify(server.value)},
  },`;
  }
  // Parse command into command + args
  const parts = server.value.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  // Make paths relative from test directory
  const relativeArgs = args.map((a) =>
    a.startsWith('/') || a.startsWith('./') || a.startsWith('../')
      ? JSON.stringify(`${relativeTo}/${a}`)
      : JSON.stringify(a)
  );
  return `  server: {
    command: ${JSON.stringify(cmd)},
    args: [${relativeArgs.join(', ')}],
  },`;
}

/**
 * Scaffold eval boilerplate into a directory.
 * @param {string} evalsDir - Directory to create eval files in
 * @param {{ server?: object, isSunpeak?: boolean, d?: object }} options
 */
function scaffoldEvals(evalsDir, { server, isSunpeak, d: deps } = {}) {
  const d = deps || defaultDeps;
  if (d.existsSync(join(evalsDir, 'eval.config.ts'))) {
    d.log.info('Eval config already exists. Skipping eval scaffold.');
    return;
  }

  d.mkdirSync(evalsDir, { recursive: true });

  // Generate server line for eval config
  let serverLine = "  // server: 'http://localhost:8000/mcp',";
  if (isSunpeak) {
    serverLine =
      "  // Omit server for sunpeak projects (auto-detected).\n  // server: 'http://localhost:8000/mcp',";
  } else if (server?.type === 'url') {
    serverLine = `  server: ${JSON.stringify(server.value)},`;
  } else if (server?.type === 'command') {
    serverLine = `  server: ${JSON.stringify(server.value)},`;
  }

  // Build the eval config content
  const configLines = [
    "import { defineEvalConfig } from 'sunpeak/eval';",
    '',
    '// API keys are loaded automatically from .env in this directory (gitignored).',
    '// See .env.example for the format.',
    '',
    'export default defineEvalConfig({',
    '  // MCP server to test.',
    serverLine,
    '',
    '  models: [',
    '    // Uncomment models and install their provider packages:',
    ...generateModelLines(),
    '  ],',
    '',
    '  defaults: {',
    '    runs: 5,           // Number of times to run each case per model',
    '    maxSteps: 1,       // Max tool call steps per run',
    '    temperature: 0,    // 0 for most deterministic results',
    '    timeout: 30_000,   // Timeout per run in ms',
    '  },',
    '});',
    '',
  ];

  d.writeFileSync(join(evalsDir, 'eval.config.ts'), configLines.join('\n'));

  // Scaffold .env template
  d.writeFileSync(
    join(evalsDir, '.env.example'),
    `# Copy this file to .env and fill in your API keys.
# .env is gitignored — never commit API keys.
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# GOOGLE_GENERATIVE_AI_API_KEY=...
`
  );

  d.writeFileSync(
    join(evalsDir, 'example.eval.ts'),
    `import { defineEval } from 'sunpeak/eval';

/**
 * Example eval — tests whether LLMs call your tools correctly.
 *
 * To get started:
 * 1. Configure models in eval.config.ts (uncomment the ones you want)
 * 2. Install the AI SDK and provider packages (e.g. pnpm add ai @ai-sdk/openai)
 * 3. Copy .env.example to .env and add your API keys
 * 4. Replace this file with evals for your own tools
 * 5. Run: npx sunpeak test --eval
 *
 * Each case sends a prompt to every configured model and checks
 * that the model calls the expected tool with the expected arguments.
 * Add appContext to test follow-up prompts that depend on state shared
 * by the rendered MCP App through updateModelContext or useAppState.
 * Cases run multiple times (configured via \`runs\` in eval.config.ts)
 * to measure reliability across non-deterministic LLM responses.
 */
export default defineEval({
  // This eval is skipped when no models are configured.
  // Delete this file and create your own evals to get started.
  cases: [
    {
      name: 'example (replace me)',
      prompt: 'Show me a demo',
      // Optional: seed model-visible App Context for follow-up prompts.
      // appContext: { structuredContent: { selectedItem: { id: 'demo' } } },
      // expect which tool gets called and (optionally) its arguments:
      expect: {
        tool: 'your-tool-name',
        // args: { key: 'value' },
      },
    },
  ],
});
`
  );

  d.log.success(`Created ${evalsDir}/ with eval config and example.`);
}

/**
 * Scaffold a visual regression test file.
 * @param {string} filePath - Full path to the visual test file
 * @param {object} d - Dependencies
 */
function scaffoldVisualTest(filePath, d) {
  if (d.existsSync(filePath)) {
    d.log.info('Visual test already exists. Skipping.');
    return;
  }

  d.writeFileSync(
    filePath,
    `import { test, expect } from 'sunpeak/test';

/**
 * Visual regression tests — compare screenshots against saved baselines.
 *
 * Screenshots only run with: npx sunpeak test --visual
 * Update baselines with:     npx sunpeak test --visual --update
 *
 * During normal \`npx sunpeak test\` runs, screenshot() calls are silently
 * skipped so these tests still pass without baselines.
 *
 * Uncomment the tests below and replace 'your-tool' with your tool name.
 */

// test('tool renders correctly in light mode', async ({ inspector }) => {
//   const result = await inspector.renderTool('your-tool', { key: 'value' }, { theme: 'light' });
//   expect(result).not.toBeError();
//
//   // Wait for UI to render, then screenshot:
//   // const app = result.app();
//   // await expect(app.getByText('Expected text')).toBeVisible();
//   // await result.screenshot('tool-light');
// });

// test('tool renders correctly in dark mode', async ({ inspector }) => {
//   const result = await inspector.renderTool('your-tool', { key: 'value' }, { theme: 'dark' });
//   expect(result).not.toBeError();
//
//   // const app = result.app();
//   // await expect(app.getByText('Expected text')).toBeVisible();
//   // await result.screenshot('tool-dark');
// });

// renderTool() hides inspector sidebars by default, and screenshot() captures only
// the MCP App iframe area, so inspector UI changes do not break your visual baselines.
`
  );
  d.log.success(`Created ${filePath}`);
}

/**
 * Scaffold live test boilerplate (test against real ChatGPT/Claude).
 * @param {string} liveDir - Directory to create live test files in
 * @param {{ isSunpeak?: boolean, server?: object, d: object }} options
 */
function scaffoldLiveTests(liveDir, { isSunpeak, server, d } = {}) {
  if (d.existsSync(join(liveDir, 'playwright.config.ts'))) {
    d.log.info('Live test config already exists. Skipping live test scaffold.');
    return;
  }

  d.mkdirSync(liveDir, { recursive: true });

  // Live test playwright config
  const liveConfigPreamble = `import { defineLiveConfig } from 'sunpeak/test/live/config';

/**
 * Live tests run against real AI hosts (ChatGPT, Claude).
 *
 * Prerequisites:
 * 1. Your MCP server must be accessible via a public URL (e.g., ngrok tunnel)
 * 2. The server must be registered as an MCP action in the host
 * 3. Run: npx sunpeak test --live
 *
 * On first run, a browser window opens for you to log in to the host.
 * The session is saved for subsequent runs (typically lasts a few hours).
 */`;

  // Build the server option for non-sunpeak projects
  let serverOption = '';
  if (!isSunpeak && server?.type === 'url') {
    serverOption = `\n  server: { url: ${JSON.stringify(server.value)} },`;
  } else if (!isSunpeak && server?.type === 'command') {
    const parts = server.value.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    serverOption =
      args.length > 0
        ? `\n  server: { command: ${JSON.stringify(cmd)}, args: [${args.map((a) => JSON.stringify(a)).join(', ')}] },`
        : `\n  server: { command: ${JSON.stringify(cmd)} },`;
  }

  const configContent = `${liveConfigPreamble}
export default defineLiveConfig({${serverOption}
  // hosts: ['chatgpt'],           // Which hosts to test against
  // colorScheme: 'light',         // Default color scheme
  // viewport: { width: 1280, height: 720 },
  devOverlay: false,
});
`;

  d.writeFileSync(join(liveDir, 'playwright.config.ts'), configContent);

  // Live test example
  d.writeFileSync(
    join(liveDir, 'example.test.ts'),
    `import { test, expect } from 'sunpeak/test/live';

/**
 * Live tests invoke tools through real AI hosts (ChatGPT, Claude).
 *
 * The \`live\` fixture provides:
 * - live.invoke(toolName) — invoke a tool and get the app locator
 * - live.setColorScheme('dark', app) — switch theme while app is visible
 * - live.page — the underlying Playwright page
 *
 * Run with: npx sunpeak test --live
 *
 * These tests are excluded from normal \`npx sunpeak test\` runs because
 * they require host accounts and cost API credits.
 */

// Uncomment and replace 'your-tool' with the tool name as it appears in the host.
// test('tool renders in the host', async ({ live }) => {
//   const app = await live.invoke('your-tool');
//
//   await expect(app.getByText('Expected text')).toBeVisible({ timeout: 15_000 });
//
//   // Test dark mode:
//   await live.setColorScheme('dark', app);
//   await expect(app.getByText('Expected text')).toBeVisible();
// });
`
  );

  d.log.success(`Created ${liveDir}/ with live test config and example.`);
}

async function initExternalProject(cliServer, d) {
  d.log.info('Detected non-JS project. Creating self-contained test directory.');

  const server = await getServerConfig(cliServer, d);
  const testDir = join(d.cwd(), 'tests', 'sunpeak');

  if (d.existsSync(testDir)) {
    d.log.warn('tests/sunpeak/ already exists. Skipping scaffold.');
    return;
  }

  d.mkdirSync(testDir, { recursive: true });

  // package.json
  d.writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        devDependencies: {
          '@types/node': 'latest',
          sunpeak: getSunpeakVersion(),
          '@playwright/test': 'latest',
          typescript: 'latest',
        },
        scripts: {
          test: 'sunpeak test',
        },
      },
      null,
      2
    ) + '\n'
  );

  d.writeFileSync(
    join(testDir, 'pnpm-workspace.yaml'),
    `allowBuilds:
  esbuild: true
`
  );

  // sunpeak.config.ts (used as playwright config)
  const serverBlock = generateServerConfigBlock(server, '../..');
  d.writeFileSync(
    join(testDir, 'playwright.config.ts'),
    `import { defineConfig } from 'sunpeak/test/config';

export default defineConfig({
${serverBlock}
});
`
  );

  // tsconfig.json
  d.writeFileSync(
    join(testDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ESNext', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'bundler',
          types: ['node'],
          strict: true,
          esModuleInterop: true,
        },
      },
      null,
      2
    ) + '\n'
  );

  // 1. E2E test — smoke test, verifies the server exposes tools
  d.writeFileSync(
    join(testDir, 'smoke.test.ts'),
    `import { test, expect } from 'sunpeak/test';

test('server exposes tools', async ({ mcp }) => {
  const tools = await mcp.listTools();
  expect(tools.length).toBeGreaterThan(0);
});

// Protocol-level test (no UI rendering):
// test('my tool returns data', async ({ mcp }) => {
//   const result = await mcp.callTool('your-tool', { key: 'value' });
//   expect(result.isError).toBeFalsy();
// });

// UI rendering test:
// test('my tool renders correctly', async ({ inspector }) => {
//   const result = await inspector.renderTool('your-tool', { key: 'value' });
//   expect(result).not.toBeError();
//   const app = result.app();
//   await expect(app.getByText('Hello')).toBeVisible();
// });
`
  );

  // 2. Visual regression test
  scaffoldVisualTest(join(testDir, 'visual.test.ts'), d);

  // 3. Live tests
  scaffoldLiveTests(join(testDir, 'live'), { isSunpeak: false, server, d });

  // 4. Eval boilerplate
  scaffoldEvals(join(testDir, 'evals'), { server, d });

  d.log.success('Created tests/sunpeak/ with all test types.');
  if (server.type === 'later') {
    d.log.warn(
      'Server not configured. Edit tests/sunpeak/playwright.config.ts before running tests.'
    );
  }

  // Auto-install dependencies so users can run tests immediately
  const pm = d.detectPackageManager();
  d.log.step('Installing dependencies...');
  try {
    d.execSync(`${pm} install`, { cwd: testDir, stdio: 'inherit' });
  } catch {
    d.log.warn(`Dependency install failed. Run manually: cd tests/sunpeak && ${pm} install`);
  }

  d.log.step('Installing Playwright browser...');
  try {
    d.execSync(`${pm} exec playwright install chromium`, { cwd: testDir, stdio: 'inherit' });
  } catch {
    d.log.warn(
      `Browser install failed. Run manually: cd tests/sunpeak && ${pm} exec playwright install chromium`
    );
  }

  d.log.step('Ready! Run tests with:');
  d.log.message('  npx sunpeak test              # E2E tests');
  d.log.message(
    '  npx sunpeak test --visual      # Visual regression (generates baselines on first run)'
  );
  d.log.message(
    '  npx sunpeak test --live         # Live tests against real hosts (requires login)'
  );
  d.log.message(
    '  npx sunpeak test --eval         # Multi-model evals (configure models in evals/eval.config.ts)'
  );
}

async function initJsProject(cliServer, d) {
  d.log.info('Detected JS/TS project. Adding test config at project root.');

  const server = await getServerConfig(cliServer, d);
  const cwd = d.cwd();

  // Ensure "type": "module" — sunpeak exports are ESM-only and Playwright's
  // CJS resolver won't find them without it.
  const pkgPath = join(cwd, 'package.json');
  if (d.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(d.readFileSync(pkgPath, 'utf-8'));
      if (pkg.type !== 'module') {
        pkg.type = 'module';
        d.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
        d.log.success('Set "type": "module" in package.json (required for sunpeak imports)');
      }
    } catch {
      d.log.warn('Could not read package.json. Make sure "type": "module" is set.');
    }
  }

  // Create playwright.config.ts
  const configPath = join(cwd, 'playwright.config.ts');
  if (d.existsSync(configPath)) {
    d.log.warn('playwright.config.ts already exists. Skipping config creation.');
  } else {
    const serverBlock = generateServerConfigBlock(server);
    d.writeFileSync(
      configPath,
      `import { defineConfig } from 'sunpeak/test/config';

export default defineConfig({
${serverBlock}
});
`
    );
    d.log.success('Created playwright.config.ts');
  }

  // 1. E2E test — smoke test
  const e2eDir = join(cwd, 'tests', 'e2e');
  d.mkdirSync(e2eDir, { recursive: true });

  const testPath = join(e2eDir, 'smoke.test.ts');
  if (!d.existsSync(testPath)) {
    d.writeFileSync(
      testPath,
      `import { test, expect } from 'sunpeak/test';

test('server exposes tools', async ({ mcp }) => {
  const tools = await mcp.listTools();
  expect(tools.length).toBeGreaterThan(0);
});

// Protocol-level test (no UI rendering):
// test('my tool returns data', async ({ mcp }) => {
//   const result = await mcp.callTool('your-tool', { key: 'value' });
//   expect(result.isError).toBeFalsy();
// });

// UI rendering test:
// test('my tool renders correctly', async ({ inspector }) => {
//   const result = await inspector.renderTool('your-tool', { key: 'value' });
//   expect(result).not.toBeError();
//   const app = result.app();
//   await expect(app.getByText('Hello')).toBeVisible();
// });
`
    );
    d.log.success('Created tests/e2e/smoke.test.ts');
  }

  // 2. Visual regression test
  scaffoldVisualTest(join(e2eDir, 'visual.test.ts'), d);

  // 3. Live tests
  scaffoldLiveTests(join(cwd, 'tests', 'live'), { isSunpeak: false, server, d });

  // 4. Eval boilerplate
  scaffoldEvals(join(cwd, 'tests', 'evals'), { server, d });

  if (server.type === 'later') {
    d.log.warn('Server not configured. Edit playwright.config.ts before running tests.');
  }
  const pkgMgr = d.detectPackageManager();
  d.log.step('Next steps:');
  d.log.message(`  ${pkgMgr} add -D sunpeak @playwright/test`);
  d.log.message(`  ${pkgMgr} exec playwright install chromium`);
  d.log.message('');
  d.log.message('  npx sunpeak test              # E2E tests');
  d.log.message('  npx sunpeak test --visual      # Visual regression');
  d.log.message('  npx sunpeak test --live         # Live tests against real hosts');
  d.log.message('  npx sunpeak test --eval         # Multi-model evals');
}

async function initSunpeakProject(d) {
  d.log.info('Detected sunpeak project. Updating config to use defineConfig().');

  const cwd = d.cwd();
  const configPath = join(cwd, 'playwright.config.ts');

  if (d.existsSync(configPath)) {
    const content = d.readFileSync(configPath, 'utf-8');
    if (content.includes('sunpeak/test/config')) {
      d.log.info('Config already uses sunpeak/test/config. Nothing to do.');
    } else {
      d.log.warn('playwright.config.ts exists but does not use sunpeak/test/config.');
      d.log.message('  To migrate, replace your config with:');
      d.log.message("    import { defineConfig } from 'sunpeak/test/config';");
      d.log.message('    export default defineConfig();');
    }
  } else {
    d.writeFileSync(
      configPath,
      `import { defineConfig } from 'sunpeak/test/config';

export default defineConfig();
`
    );
    d.log.success('Updated playwright.config.ts to use defineConfig()');
  }

  // Scaffold missing test types

  // 1. Visual regression test
  const e2eDir = join(cwd, 'tests', 'e2e');
  d.mkdirSync(e2eDir, { recursive: true });
  scaffoldVisualTest(join(e2eDir, 'visual.test.ts'), d);

  // 2. Live tests
  scaffoldLiveTests(join(cwd, 'tests', 'live'), { isSunpeak: true, d });

  // 3. Eval boilerplate
  scaffoldEvals(join(cwd, 'tests', 'evals'), { isSunpeak: true, d });

  d.log.step('Scaffolded test types:');
  d.log.message('  tests/e2e/visual.test.ts    — Visual regression (npx sunpeak test --visual)');
  d.log.message('  tests/live/                 — Live host tests (npx sunpeak test --live)');
  d.log.message('  tests/evals/                — Multi-model evals (npx sunpeak test --eval)');
  d.log.message('');
  d.log.message('  Migrate existing e2e tests:');
  d.log.message('  Replace: import { test, expect } from "@playwright/test"');
  d.log.message('  With:    import { test, expect } from "sunpeak/test"');
  d.log.message('');
  d.log.message('  Use the `mcp` and `inspector` fixtures instead of raw page navigation.');
  d.log.message('  See sunpeak docs for migration examples.');
}
