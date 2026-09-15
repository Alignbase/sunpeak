#!/usr/bin/env node

/**
 * Local Testing Script for Sunpeak
 * This script runs all local tests described in DEVELOPMENT.md
 *
 * Validation strategy:
 * - Package-level checks run sequentially
 * - Scaffold and generated example projects run in isolated temp directories
 * - Each example gets unique ports to avoid conflicts
 */

import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, sep } from 'path';
import { existsSync, readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync, cpSync } from 'fs';
import { discoverResources } from '../bin/lib/patterns.mjs';
import { getPort } from '../bin/lib/get-port.mjs';

// Color codes for output
const colors = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  blue: '\x1b[0;34m',
  yellow: '\x1b[1;33m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

// Get repo root and package root
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, '..');
const REPO_ROOT = join(__dirname, '..', '..', '..');
const TEMPLATE_ROOT = join(PACKAGE_ROOT, 'template');
const DOCS_ROOT = join(REPO_ROOT, 'docs');
const EXAMPLES_DIR = join(REPO_ROOT, 'examples');
const PRODUCTION_TMP = join(REPO_ROOT, '.tmp-validate-production');
const SUNPEAK_BIN = join(PACKAGE_ROOT, 'bin', 'sunpeak.js');
const GENERATED_PROJECT_PNPM_INSTALL = 'pnpm install --no-frozen-lockfile';

// Helper functions
function printSection(text) {
  console.log(`\n${colors.blue}${'='.repeat(40)}${colors.reset}`);
  console.log(`${colors.blue}${text}${colors.reset}`);
  console.log(`${colors.blue}${'='.repeat(40)}${colors.reset}\n`);
}

function printSuccess(text) {
  console.log(`${colors.green}✓ ${text}${colors.reset}`);
}

function removeDirIfExists(dir) {
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function runCommand(command, cwd, env) {
  try {
    execSync(command, {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1', ...env },
    });
    return true;
  } catch (error) {
    return false;
  }
}

function runCommandIsolated(command, cwd, env) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: true,
      stdio: 'inherit',
      env: { ...process.env, FORCE_COLOR: '1', ...env },
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Run a command capturing stdout+stderr. Returns { ok, output }.
 * Used for parallel tasks where stdio: 'inherit' would interleave.
 */
function runCommandCapture(command, cwd, env) {
  try {
    const output = execSync(command, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      maxBuffer: 50 * 1024 * 1024,
    });
    return { ok: true, output: output.toString() };
  } catch (error) {
    return { ok: false, output: (error.stdout?.toString() || '') + (error.stderr?.toString() || '') };
  }
}

async function fetchWithTimeout(url, options, timeoutMs = 10000) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function extractInspectorRequestToken(entryJs) {
  return entryJs.match(/[?&]__sunpeak_token=([^"'&\\]+)/)?.[1] ?? null;
}

function readResourceUrl(baseUrl, uri, requestToken) {
  const url = new URL('/__sunpeak/read-resource', baseUrl);
  url.searchParams.set('uri', uri);
  if (requestToken) url.searchParams.set('__sunpeak_token', requestToken);
  return url.toString();
}

/**
 * Run a sequence of commands, stopping on first failure. Returns { ok, step, output }.
 */
function runSteps(steps, cwd, env) {
  const allOutput = [];
  for (const { name, command } of steps) {
    const result = runCommandCapture(command, cwd, env);
    allOutput.push(`--- ${name} ---\n${result.output}`);
    if (!result.ok) {
      return { ok: false, step: name, output: allOutput.join('\n') };
    }
  }
  return { ok: true, step: null, output: allOutput.join('\n') };
}


// ============================================================================
// Validation checks (run after build, before examples)
// ============================================================================

/**
 * Verify every export path in package.json resolves to a real file in dist/.
 */
function validateExportsMap() {
  console.log('Validating package.json exports map...');

  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'));
  const exports = pkg.exports;
  const errors = [];

  function checkPath(exportKey, filePath) {
    const resolved = join(PACKAGE_ROOT, filePath);
    if (!existsSync(resolved)) {
      errors.push(`  ${exportKey} → ${filePath} (file not found)`);
    }
  }

  for (const [key, value] of Object.entries(exports)) {
    if (typeof value === 'string') {
      checkPath(key, value);
    } else if (typeof value === 'object') {
      for (const [condition, condValue] of Object.entries(value)) {
        if (typeof condValue === 'string') {
          checkPath(`${key}[${condition}]`, condValue);
        } else if (typeof condValue === 'object') {
          for (const [subKey, subValue] of Object.entries(condValue)) {
            if (typeof subValue === 'string') {
              checkPath(`${key}[${condition}][${subKey}]`, subValue);
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Exports map has ${errors.length} missing file(s):\n${errors.join('\n')}`);
  }

  const exportKeys = Object.keys(exports).filter(k => k !== './package.json');
  printSuccess(`Exports map verified (${exportKeys.length} entry points)`);
}

/**
 * Verify dist CSS files don't contain unprocessed Tailwind/PostCSS directives
 * that consumers can't resolve (e.g. @import "tailwindcss", @source, @custom-variant).
 */
function validateDistCss() {
  console.log('Validating dist CSS files...');

  const forbiddenPatterns = [
    { regex: /@import\s+["']tailwindcss["']/, label: '@import "tailwindcss"' },
    { regex: /@source\s+/, label: '@source' },
    { regex: /@custom-variant\s+/, label: '@custom-variant' },
    { regex: /@utility\s+/, label: '@utility' },
  ];

  const cssFiles = ['dist/style.css'];
  const errors = [];

  for (const file of cssFiles) {
    const fullPath = join(PACKAGE_ROOT, file);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, 'utf-8');
    for (const { regex, label } of forbiddenPatterns) {
      if (regex.test(content)) {
        errors.push(`  ${file} contains unprocessed ${label}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Dist CSS contains unprocessed directives:\n${errors.join('\n')}`);
  }

  printSuccess(`Dist CSS files verified (no unprocessed directives)`);
}

/**
 * Verify every page referenced in docs.json has a corresponding .mdx file.
 * Also checks that every exported hook has a docs page.
 */
function validateDocs() {
  console.log('Validating docs navigation...');

  const docsJson = JSON.parse(readFileSync(join(DOCS_ROOT, 'docs.json'), 'utf-8'));
  const errors = [];

  const referencedPages = [];
  function collectPages(obj) {
    if (Array.isArray(obj)) {
      for (const item of obj) collectPages(item);
    } else if (typeof obj === 'object' && obj !== null) {
      if (obj.pages) {
        for (const page of obj.pages) {
          if (typeof page === 'string') {
            referencedPages.push(page);
          } else {
            collectPages(page);
          }
        }
      }
      if (obj.groups) collectPages(obj.groups);
      if (obj.tabs) collectPages(obj.tabs);
    }
  }
  collectPages(docsJson.navigation);

  for (const page of referencedPages) {
    const mdxPath = join(DOCS_ROOT, `${page}.mdx`);
    if (!existsSync(mdxPath)) {
      errors.push(`  docs.json references "${page}" but ${page}.mdx not found`);
    }
  }

  const hooksIndex = readFileSync(join(PACKAGE_ROOT, 'src/hooks/index.ts'), 'utf-8');
  const hookExports = [...hooksIndex.matchAll(/export \{ (\w+) \}/g)].map(m => m[1]);

  const sdkReExports = new Set([
    'useAutoResize', 'useDocumentTheme', 'useHostStyleVariables', 'useHostFonts', 'useHostStyles',
  ]);
  const nonHookExports = new Set(['AppProvider', 'SafeArea']);

  const hooksMissingDocs = [];
  for (const hookName of hookExports) {
    if (sdkReExports.has(hookName) || nonHookExports.has(hookName)) continue;

    const kebab = hookName.replace(/^use/, 'use-').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
      .replace(/^use--/, 'use-');
    const expectedPage = `app-framework/hooks/${kebab}`;

    if (!referencedPages.includes(expectedPage)) {
      hooksMissingDocs.push(`  Hook "${hookName}" not in docs.json navigation (expected "${expectedPage}")`);
    }
    const mdxPath = join(DOCS_ROOT, `${expectedPage}.mdx`);
    if (!existsSync(mdxPath)) {
      hooksMissingDocs.push(`  Hook "${hookName}" has no doc page at ${expectedPage}.mdx`);
    }
  }
  errors.push(...hooksMissingDocs);

  if (errors.length > 0) {
    throw new Error(`Docs validation found ${errors.length} issue(s):\n${errors.join('\n')}`);
  }

  const hookCount = hookExports.filter(h => !sdkReExports.has(h) && !nonHookExports.has(h)).length;
  printSuccess(`Docs validated (${referencedPages.length} pages, ${hookCount} hooks verified)`);
}


// ============================================================================
// Parallel task runners
// ============================================================================

/**
 * Validate `sunpeak test init` across all 3 project types.
 *
 * For each type (external, JS, sunpeak), scaffolds into a temp directory
 * and verifies:
 * - All expected files are created
 * - File contents contain expected imports/exports
 * - Idempotency: running twice doesn't crash or overwrite
 * - Server config flows through to generated files
 */
function runTestInitSmokeTest() {
  const tmpBase = join(REPO_ROOT, '.tmp-validate-test-init');

  removeDirIfExists(tmpBase);
  mkdirSync(tmpBase, { recursive: true });

  try {
    const allOutput = [];

    // ── External project (empty dir, no package.json) ──
    {
      const dir = join(tmpBase, 'external');
      mkdirSync(dir, { recursive: true });

      const result = runCommandCapture(
        `node ${SUNPEAK_BIN} test init --server http://localhost:8000/mcp`,
        dir,
        { CI: '1' }
      );
      allOutput.push(`--- external: init ---\n${result.output}`);
      if (!result.ok) return { ok: false, step: 'test-init external', output: allOutput.join('\n') };

      const testDir = join(dir, 'tests', 'sunpeak');
      const expected = [
        'package.json',
        'playwright.config.ts',
        'tsconfig.json',
        'smoke.test.ts',
        'visual.test.ts',
        'live/playwright.config.ts',
        'live/example.test.ts',
        'evals/eval.config.ts',
        'evals/example.eval.ts',
        'evals/.env.example',
      ];

      for (const file of expected) {
        const fullPath = join(testDir, file);
        if (!existsSync(fullPath)) {
          return { ok: false, step: `test-init external: missing ${file}`, output: allOutput.join('\n') };
        }
      }

      // Verify server URL flows through
      const configContent = readFileSync(join(testDir, 'playwright.config.ts'), 'utf-8');
      if (!configContent.includes('http://localhost:8000/mcp')) {
        return { ok: false, step: 'test-init external: server URL missing from playwright.config.ts', output: allOutput.join('\n') };
      }

      const evalConfig = readFileSync(join(testDir, 'evals/eval.config.ts'), 'utf-8');
      if (!evalConfig.includes('http://localhost:8000/mcp')) {
        return { ok: false, step: 'test-init external: server URL missing from eval.config.ts', output: allOutput.join('\n') };
      }

      // Verify live config has server option for non-sunpeak projects
      const liveConfig = readFileSync(join(testDir, 'live/playwright.config.ts'), 'utf-8');
      if (!liveConfig.includes('server: { url: "http://localhost:8000/mcp" }')) {
        return { ok: false, step: 'test-init external: live config missing server option', output: allOutput.join('\n') };
      }

      // Idempotency: second run should not crash
      const result2 = runCommandCapture(
        `node ${SUNPEAK_BIN} test init --server http://localhost:8000/mcp`,
        dir,
        { CI: '1' }
      );
      allOutput.push(`--- external: idempotency ---\n${result2.output}`);
      if (!result2.ok) return { ok: false, step: 'test-init external: idempotency', output: allOutput.join('\n') };

      // ── Compile scaffolded files ──
      // This is the Testing Framework page user journey: after `sunpeak test init`,
      // the user installs deps and runs tests. Verify the scaffolded TypeScript
      // actually compiles against real sunpeak types.
      const testPkgPath = join(testDir, 'package.json');
      const testPkg = JSON.parse(readFileSync(testPkgPath, 'utf-8'));
      testPkg.devDependencies.sunpeak = `file:${PACKAGE_ROOT}`;
      writeFileSync(testPkgPath, JSON.stringify(testPkg, null, 2) + '\n');

      const compileResult = runSteps([
        { name: 'test-init install', command: GENERATED_PROJECT_PNPM_INSTALL },
        { name: 'test-init typecheck', command: 'pnpm exec tsc --noEmit' },
      ], testDir);
      allOutput.push(`--- external: compile ---\n${compileResult.output}`);
      if (!compileResult.ok) return { ok: false, step: `test-init external: ${compileResult.step}`, output: allOutput.join('\n') };
    }

    // ── JS project (package.json without sunpeak) ──
    {
      const dir = join(tmpBase, 'js');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'test-js-project',
        dependencies: { express: '*' },
      }, null, 2) + '\n');

      const result = runCommandCapture(
        `node ${SUNPEAK_BIN} test init --server http://localhost:9000/mcp`,
        dir,
        { CI: '1' }
      );
      allOutput.push(`--- js: init ---\n${result.output}`);
      if (!result.ok) return { ok: false, step: 'test-init js', output: allOutput.join('\n') };

      const expected = [
        'playwright.config.ts',
        'tests/e2e/smoke.test.ts',
        'tests/e2e/visual.test.ts',
        'tests/live/playwright.config.ts',
        'tests/live/example.test.ts',
        'tests/evals/eval.config.ts',
        'tests/evals/example.eval.ts',
        'tests/evals/.env.example',
      ];

      for (const file of expected) {
        if (!existsSync(join(dir, file))) {
          return { ok: false, step: `test-init js: missing ${file}`, output: allOutput.join('\n') };
        }
      }

      // Unit tests should NOT be scaffolded (they're app-framework-only)
      if (existsSync(join(dir, 'tests/unit/example.test.ts'))) {
        return { ok: false, step: 'test-init js: tests/unit/ should not be scaffolded', output: allOutput.join('\n') };
      }

      // Verify correct imports in scaffolded files
      const smokeContent = readFileSync(join(dir, 'tests/e2e/smoke.test.ts'), 'utf-8');
      if (!smokeContent.includes("from 'sunpeak/test'")) {
        return { ok: false, step: 'test-init js: smoke test missing sunpeak/test import', output: allOutput.join('\n') };
      }

      const visualContent = readFileSync(join(dir, 'tests/e2e/visual.test.ts'), 'utf-8');
      if (!visualContent.includes("from 'sunpeak/test'") || !visualContent.includes('result.screenshot')) {
        return { ok: false, step: 'test-init js: visual test missing expected content', output: allOutput.join('\n') };
      }

      const liveTest = readFileSync(join(dir, 'tests/live/example.test.ts'), 'utf-8');
      if (!liveTest.includes("from 'sunpeak/test/live'") || !liveTest.includes('live.invoke')) {
        return { ok: false, step: 'test-init js: live test missing expected content', output: allOutput.join('\n') };
      }

      const evalExample = readFileSync(join(dir, 'tests/evals/example.eval.ts'), 'utf-8');
      if (!evalExample.includes("from 'sunpeak/eval'") || !evalExample.includes('defineEval')) {
        return { ok: false, step: 'test-init js: eval test missing expected content', output: allOutput.join('\n') };
      }

      // JS project live config should have server option
      const liveConfig = readFileSync(join(dir, 'tests/live/playwright.config.ts'), 'utf-8');
      if (!liveConfig.includes('server: { url: "http://localhost:9000/mcp" }')) {
        return { ok: false, step: 'test-init js: live config missing server option', output: allOutput.join('\n') };
      }

      // Verify server URL in main config
      const mainConfig = readFileSync(join(dir, 'playwright.config.ts'), 'utf-8');
      if (!mainConfig.includes('http://localhost:9000/mcp')) {
        return { ok: false, step: 'test-init js: server URL missing from config', output: allOutput.join('\n') };
      }
    }

    // ── sunpeak project (package.json with sunpeak dep) ──
    {
      const dir = join(tmpBase, 'sunpeak-app');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'my-app',
        dependencies: { sunpeak: '*' },
      }, null, 2) + '\n');

      const result = runCommandCapture(
        `node ${SUNPEAK_BIN} test init`,
        dir,
        { CI: '1' }
      );
      allOutput.push(`--- sunpeak: init ---\n${result.output}`);
      if (!result.ok) return { ok: false, step: 'test-init sunpeak', output: allOutput.join('\n') };

      const expected = [
        'playwright.config.ts',
        'tests/e2e/visual.test.ts',
        'tests/live/playwright.config.ts',
        'tests/live/example.test.ts',
        'tests/evals/eval.config.ts',
        'tests/evals/example.eval.ts',
        'tests/evals/.env.example',
      ];

      for (const file of expected) {
        if (!existsSync(join(dir, file))) {
          return { ok: false, step: `test-init sunpeak: missing ${file}`, output: allOutput.join('\n') };
        }
      }

      // Unit tests should NOT be scaffolded by test init (they come from sunpeak new)
      if (existsSync(join(dir, 'tests/unit/example.test.ts'))) {
        return { ok: false, step: 'test-init sunpeak: tests/unit/ should not be scaffolded by test init', output: allOutput.join('\n') };
      }

      // Verify playwright.config uses defineConfig() (no server arg)
      const config = readFileSync(join(dir, 'playwright.config.ts'), 'utf-8');
      if (!config.includes('defineConfig()')) {
        return { ok: false, step: 'test-init sunpeak: config should use defineConfig()', output: allOutput.join('\n') };
      }

      // sunpeak project live config should NOT have a server option
      const liveConfig = readFileSync(join(dir, 'tests/live/playwright.config.ts'), 'utf-8');
      if (liveConfig.includes('server:')) {
        return { ok: false, step: 'test-init sunpeak: live config should NOT have server option', output: allOutput.join('\n') };
      }

      // Eval config should have sunpeak-specific comment
      const evalConfig = readFileSync(join(dir, 'tests/evals/eval.config.ts'), 'utf-8');
      if (!evalConfig.includes('Omit server for sunpeak projects')) {
        return { ok: false, step: 'test-init sunpeak: eval config missing sunpeak comment', output: allOutput.join('\n') };
      }
    }

    // ── Command-based server (external project) ──
    {
      const dir = join(tmpBase, 'command-server');
      mkdirSync(dir, { recursive: true });

      const result = runCommandCapture(
        `node ${SUNPEAK_BIN} test init --server "python src/server.py"`,
        dir,
        { CI: '1' }
      );
      allOutput.push(`--- command-server: init ---\n${result.output}`);
      if (!result.ok) return { ok: false, step: 'test-init command-server', output: allOutput.join('\n') };

      const config = readFileSync(join(dir, 'tests/sunpeak/playwright.config.ts'), 'utf-8');
      if (!config.includes('command: "python"') || !config.includes('"src/server.py"')) {
        return { ok: false, step: 'test-init command-server: config missing parsed command/args', output: allOutput.join('\n') };
      }
    }

    return { ok: true, step: null, output: allOutput.join('\n') };
  } finally {
    removeDirIfExists(tmpBase);
  }
}

/**
 * Start a server process, poll for health, return it.
 * Caller must kill the process when done.
 */
async function startServerProcess(command, args, cwd, env, label, maxWaitMs = 15000) {
  const proc = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (data) => { stdout += data.toString(); });
  proc.stderr.on('data', (data) => { stderr += data.toString(); });

  // Extract port from args for health check
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? args[portIdx + 1] : null;
  if (!port) throw new Error(`${label}: no --port in args`);

  let ready = false;
  const polls = Math.ceil(maxWaitMs / 500);
  for (let i = 0; i < polls; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const response = await fetch(`http://localhost:${port}/health`);
      if (response.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    if (proc.exitCode !== null) break;
  }

  if (!ready) {
    await killServer(proc);
    const reason = proc.exitCode !== null
      ? `exited with code ${proc.exitCode}`
      : `failed to start within ${maxWaitMs / 1000}s`;
    throw new Error(`${label}: ${reason}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }

  return { proc, port, stdout: () => stdout, stderr: () => stderr };
}

function waitForProcessExit(proc, timeoutMs = 5000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();

  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function killServer(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const childPgid = getProcessGroupId(proc.pid);
  const currentPgid = getProcessGroupId(process.pid);
  const canKillProcessGroup = childPgid && currentPgid && childPgid !== currentPgid;

  const signalProcessTree = (signal) => {
    const childPids = getChildProcessIds(proc.pid);
    if (canKillProcessGroup) {
      try {
        process.kill(-childPgid, signal);
      } catch {
        // Fall through to direct process signaling below.
      }
    }

    for (const childPid of childPids) {
      try {
        process.kill(childPid, signal);
      } catch {
        // Process already exited.
      }
    }

    try {
      proc.kill(signal);
    } catch {
      // Process already exited.
    }
  };

  signalProcessTree('SIGTERM');
  await new Promise(resolve => setTimeout(resolve, 500));
  if (proc.exitCode === null && proc.signalCode === null) {
    signalProcessTree('SIGKILL');
  }
  await waitForProcessExit(proc);
}

function getChildProcessIds(pid) {
  try {
    return execSync(`pgrep -P ${pid}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .split('\n')
      .map((line) => Number.parseInt(line, 10))
      .filter(Number.isFinite);
  } catch {
    return [];
  }
}

function getProcessGroupId(pid) {
  try {
    const output = execSync(`ps -o pgid= -p ${pid}`, { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const pgid = Number.parseInt(output, 10);
    return Number.isFinite(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

/**
 * Scaffold smoke test — validates the full `sunpeak new` user journey.
 *
 * Mirrors the marketing CTA path:
 *   sunpeak new → sunpeak dev (verify) → sunpeak test → sunpeak build → sunpeak start (verify)
 *
 * Runs captured (no stdio inherit) so it can run in parallel.
 */
async function runScaffoldSmokeTest() {
  const tmpDir = join(REPO_ROOT, '.tmp-validate-new');

  removeDirIfExists(tmpDir);
  mkdirSync(tmpDir, { recursive: true });

  try {
    const firstResource = discoverResources()[0];
    let result = runCommandCapture(`node ${SUNPEAK_BIN} new validate-test-app ${firstResource}`, tmpDir);
    if (!result.ok) return { ok: false, step: 'sunpeak new', output: result.output };

    const projectDir = join(tmpDir, 'validate-test-app');

    const pkgPath = join(projectDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    pkg.dependencies.sunpeak = `file:${PACKAGE_ROOT}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

    // ── Install + typecheck ──
    const setupResult = runSteps([
      { name: 'pnpm install', command: GENERATED_PROJECT_PNPM_INSTALL },
      { name: 'playwright install', command: 'pnpm exec playwright install chromium' },
      { name: 'tsc --noEmit', command: 'pnpm exec tsc --noEmit' },
    ], projectDir);
    if (!setupResult.ok) return setupResult;

    // ── sunpeak dev smoke test ──
    // This is the first command users run after `sunpeak new`. Verify the dev
    // server starts, discovers tools, and serves resource HTML.
    const devPort = await getPort(19100);
    const devMcpPort = await getPort(19110);
    const devSandboxPort = await getPort(24700);
    const devHmrPort = await getPort(24701);
    {
      let devServer;
      try {
        devServer = await startServerProcess(
          'node', [SUNPEAK_BIN, 'dev', '--port', String(devPort), '--no-begging'],
          projectDir,
          {
            CI: '1',
            SUNPEAK_MCP_PORT: String(devMcpPort),
            SUNPEAK_SANDBOX_PORT: String(devSandboxPort),
            SUNPEAK_HMR_PORT: String(devHmrPort),
          },
          'scaffold dev', 30000
        );

        // Verify tool discovery
        const listResp = await fetchWithTimeout(`http://localhost:${devPort}/__sunpeak/list-tools`);
        if (!listResp.ok) throw new Error(`scaffold dev: list-tools returned ${listResp.status}`);
        const { tools } = await listResp.json();
        if (!tools || tools.length === 0) throw new Error('scaffold dev: no tools discovered');
      } catch (e) {
        return { ok: false, step: 'sunpeak dev (scaffold)', output: e.message };
      } finally {
        if (devServer) await killServer(devServer.proc);
      }
    }

    // ── sunpeak unit tests with CLEAN Vite cache ──
    // Package-level e2e covers the inspector browser path. The scaffold smoke
    // test verifies generated unit tests and keeps dev/build/start checks below.
    const testPort = await getPort(19200);
    const testMcpPort = await getPort(19210);
    const testHmrPort = await getPort(24712);
    const testSandboxPort = await getPort(24710);
    const viteCacheDir = join(projectDir, 'node_modules', '.vite-mcp');
    removeDirIfExists(viteCacheDir);
    const scaffoldSunpeakBin = join(projectDir, 'node_modules', 'sunpeak', 'bin', 'sunpeak.js');
    const testResult = runCommandCapture(`node ${JSON.stringify(scaffoldSunpeakBin)} test --unit`, projectDir, {
      CI: '1',
      SUNPEAK_TEST_PORT: String(testPort),
      SUNPEAK_MCP_PORT: String(testMcpPort),
      SUNPEAK_HMR_PORT: String(testHmrPort),
      SUNPEAK_SANDBOX_PORT: String(testSandboxPort),
      SUNPEAK_TEST_WORKERS: '1',
      SUNPEAK_INSPECT_MCP_REQUEST_TIMEOUT_MS: '10000',
    });
    if (!testResult.ok) return { ok: false, step: 'sunpeak test --unit (scaffold)', output: testResult.output };

    // ── eval framework smoke test ──
    // Verify that `sunpeak test --eval` can start the dev server, connect,
    // discover tools with valid schemas, and convert them for AI providers.
    // Does NOT make actual API calls (no API key needed). Catches schema
    // conversion bugs (like the ai v6 inputSchema rename, or OpenAI-incompatible
    // JSON Schema fields) before users hit them.
    {
      const evalPort = await getPort(19250);
      const evalInspectorPort = await getPort(19251);
      const evalSandboxPort = await getPort(24714);
      let evalServer;
      try {
        evalServer = await startServerProcess(
          'node', [SUNPEAK_BIN, 'dev', '--port', String(evalInspectorPort), '--no-begging', '--', '--prod-tools'],
          projectDir,
          {
            SUNPEAK_MCP_PORT: String(evalPort),
            SUNPEAK_SANDBOX_PORT: String(evalSandboxPort),
            SUNPEAK_DEV_OVERLAY: 'false',
          },
          'scaffold eval schema', 30000
        );

        // Connect to MCP and discover tools (same flow as the eval runner)
        const mcpUrl = `http://localhost:${evalPort}/mcp`;
        const initResp = await fetch(mcpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'validate-eval', version: '0.0.1' } },
          }),
        });
        if (!initResp.ok) throw new Error(`eval schema: initialize returned ${initResp.status}`);
        const sessionId = initResp.headers.get('mcp-session-id');
        if (!sessionId) throw new Error('eval schema: no session ID');

        const toolsResp = await fetch(mcpUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream, application/json',
            'Mcp-Session-Id': sessionId,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        });
        const toolsText = await toolsResp.text();
        const dataLine = toolsText.split('\n').find(l => l.startsWith('data: '));
        const toolsBody = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(toolsText);
        const tools = toolsBody.result?.tools || [];
        if (tools.length === 0) throw new Error('eval schema: no tools discovered');

        // Verify all tool schemas are valid for AI providers:
        // - Must have type: "object"
        // - Must not have additionalProperties: {} (empty schema)
        // - Must have real properties (not empty)
        // - No required array (dev server makes all fields optional)
        for (const tool of tools) {
          const schema = tool.inputSchema;
          if (!schema) throw new Error(`eval schema: ${tool.name} has no inputSchema`);
          if (schema.type !== 'object') throw new Error(`eval schema: ${tool.name} has type "${schema.type}" instead of "object"`);
          if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && Object.keys(schema.additionalProperties).length === 0) {
            throw new Error(`eval schema: ${tool.name} has empty additionalProperties (breaks OpenAI)`);
          }
          const propCount = Object.keys(schema.properties || {}).length;
          if (propCount === 0) throw new Error(`eval schema: ${tool.name} has empty properties (real schemas should be populated)`);
          if (schema.required && schema.required.length > 0) {
            throw new Error(`eval schema: ${tool.name} has required fields ${JSON.stringify(schema.required)} (dev server should make all fields optional so partial args are accepted)`);
          }
        }

        // Verify the eval runner's tool conversion produces valid AI SDK tools.
        // This catches the ai v6 `parameters` → `inputSchema` rename and
        // schema cleanup issues without needing an API key.
        const { discoverAndConvertTools } = await import('../bin/lib/eval/eval-runner.mjs');
        const { Client, StreamableHTTPClientTransport } =
          await import('@modelcontextprotocol/client');
        const evalClient = new Client({ name: 'validate-eval-convert', version: '1.0.0' });
        const evalTransport = new StreamableHTTPClientTransport(new URL(mcpUrl));
        await evalClient.connect(evalTransport);
        try {
          const aiTools = await discoverAndConvertTools(evalClient);
          const toolNames = Object.keys(aiTools);
          if (toolNames.length === 0) throw new Error('eval convert: no tools converted');
          for (const name of toolNames) {
            const t = aiTools[name];
            // ai v6 reads `inputSchema`; ai v4/v5 reads `parameters`.
            // The eval runner must set both for cross-version compatibility.
            if (!('inputSchema' in t)) throw new Error(`eval convert: tool "${name}" missing inputSchema (ai v6 won't find schema)`);
            if (!('parameters' in t)) throw new Error(`eval convert: tool "${name}" missing parameters (ai v4/v5 won't find schema)`);
            // Verify the schema has real content (not the empty fallback)
            const schemaObj = t.inputSchema?.jsonSchema || t.parameters?.jsonSchema;
            if (!schemaObj || !schemaObj.properties || Object.keys(schemaObj.properties).length === 0) {
              throw new Error(`eval convert: tool "${name}" has empty schema after conversion`);
            }
            if (schemaObj.$schema) throw new Error(`eval convert: tool "${name}" still has $schema (breaks OpenAI)`);
            if (schemaObj.required) throw new Error(`eval convert: tool "${name}" still has required (models refuse to call with partial args)`);
          }
        } finally {
          try { await evalTransport.close(); } catch { /* best-effort */ }
        }

        // Verify the dev server accepts partial args (no SDK validation error).
        // makeSchemaOptional() makes all fields optional so tools accept any
        // subset of args. Without this, models sending partial args get rejected.
        const callResp = await fetch(mcpUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream, application/json',
            'Mcp-Session-Id': sessionId,
          },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 3, method: 'tools/call',
            params: { name: tools[0].name, arguments: {} },
          }),
        });
        const callText = await callResp.text();
        const callDataLine = callText.split('\n').find(l => l.startsWith('data: '));
        const callBody = callDataLine ? JSON.parse(callDataLine.slice(6)) : JSON.parse(callText);
        if (callBody.error?.message?.includes('validation error') || callBody.error?.message?.includes('Invalid arguments')) {
          throw new Error(`eval partial args: tool "${tools[0].name}" rejected empty args — makeSchemaOptional may be broken`);
        }
      } catch (e) {
        return { ok: false, step: 'eval schema (scaffold)', output: e.message };
      } finally {
        if (evalServer) await killServer(evalServer.proc);
      }
    }

    // ── sunpeak build ──
    const buildResult = runCommandCapture(`node ${SUNPEAK_BIN} build`, projectDir);
    if (!buildResult.ok) return { ok: false, step: 'sunpeak build (scaffold)', output: buildResult.output };

    // ── sunpeak start smoke test ──
    // Mirrors the `sunpeak build && sunpeak start` CTA. Verify production
    // server health and MCP initialize handshake.
    const startPort = await getPort(19300);
    {
      let startServer;
      try {
        startServer = await startServerProcess(
          'node', [SUNPEAK_BIN, 'start', '--port', String(startPort)],
          projectDir, {}, 'scaffold start'
        );

        // Verify MCP initialize
        const mcpResp = await fetch(`http://localhost:${startPort}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'validate', version: '0.0.1' } },
          }),
        });
        if (!mcpResp.ok) throw new Error(`scaffold start: MCP returned ${mcpResp.status}`);
        const respText = await mcpResp.text();
        const dataLine = respText.split('\n').find(l => l.startsWith('data: '));
        const mcpBody = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(respText);
        if (!mcpBody.result?.serverInfo) throw new Error(`scaffold start: MCP missing serverInfo`);
      } catch (e) {
        return { ok: false, step: 'sunpeak start (scaffold)', output: e.message };
      } finally {
        if (startServer) await killServer(startServer.proc);
      }
    }

    return { ok: true, step: null, output: '' };
  } finally {
    await killProcessesReferencingPath(tmpDir);
    removeDirIfExists(tmpDir);
  }
}

/**
 * Test a single example project — install, typecheck, test, build, e2e.
 * Runs captured so multiple examples can run in parallel.
 * Each example gets unique ports to avoid conflicts.
 */
async function testExample(resource, index) {
  const exampleName = `${resource}-example`;
  const sourceExampleDir = join(EXAMPLES_DIR, exampleName);
  const exampleDir = join(REPO_ROOT, `.tmp-validate-${exampleName}`);

  removeDirIfExists(exampleDir);

  const skippedCopyDirs = new Set(['node_modules', 'dist', 'test-results', 'playwright-report']);
  const skippedCopyFiles = new Set(['pnpm-lock.yaml']);
  cpSync(sourceExampleDir, exampleDir, {
    recursive: true,
    filter: (source) => {
      const parts = source.split(sep);
      return !parts.some(part => skippedCopyDirs.has(part) || skippedCopyFiles.has(part));
    },
  });

  // Find available ports for parallel execution.
  // Each parallel example gets its own preferred port range to minimize contention.
  const testPort = await getPort(6776 + index);
  const mcpPort = await getPort(18700 + index);
  const hmrPort = await getPort(24679 + index * 2);
  const sandboxPort = await getPort(24680 + index * 2);
  const env = {
    CI: '1',
    SUNPEAK_TEST_PORT: String(testPort),
    SUNPEAK_MCP_PORT: String(mcpPort),
    SUNPEAK_HMR_PORT: String(hmrPort),
    SUNPEAK_SANDBOX_PORT: String(sandboxPort),
    SUNPEAK_TEST_WORKERS: '1',
    SUNPEAK_WEB_SERVER_TIMEOUT_MS: '180000',
    SUNPEAK_INSPECT_MCP_REQUEST_TIMEOUT_MS: '10000',
  };

  // Link local sunpeak
  const pkgPath = join(exampleDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  pkg.dependencies.sunpeak = `file:${PACKAGE_ROOT}`;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  try {
    return runSteps([
      { name: 'pnpm install', command: GENERATED_PROJECT_PNPM_INSTALL },
      { name: 'tsc --noEmit', command: 'node node_modules/typescript/bin/tsc --noEmit' },
      { name: 'sunpeak build', command: `node ${SUNPEAK_BIN} build` },
      {
        name: 'sunpeak test --unit',
        command: `node ${JSON.stringify(join(exampleDir, 'node_modules', 'sunpeak', 'bin', 'sunpeak.js'))} test --unit`,
      },
    ], exampleDir, env);
  } finally {
    await killProcessesReferencingPath(exampleDir);
    removeDirIfExists(exampleDir);
  }
}

async function killProcessesReferencingPath(path) {
  const currentPid = process.pid;
  const parentPid = process.ppid;

  const pids = (() => {
    try {
      return execSync('ps -axo pid=,command=', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .split('\n')
        .map((line) => {
          const match = line.trim().match(/^(\d+)\s+(.+)$/);
          if (!match) return null;
          const pid = Number.parseInt(match[1], 10);
          const command = match[2];
          return Number.isFinite(pid) && command.includes(path) ? pid : null;
        })
        .filter((pid) => pid && pid !== currentPid && pid !== parentPid);
    } catch {
      return [];
    }
  })();

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Process already exited.
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

/**
 * Production server smoke test.
 */
async function validateProductionServer(exampleDir) {
  const port = await getPort(18765);

  const serverProcess = spawn('node', [SUNPEAK_BIN, 'start', '--port', String(port)], {
    cwd: exampleDir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  serverProcess.stdout.on('data', (data) => { stdout += data.toString(); });
  serverProcess.stderr.on('data', (data) => { stderr += data.toString(); });

  try {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const response = await fetch(`http://localhost:${port}/health`);
        if (response.ok) { ready = true; break; }
      } catch { /* not up yet */ }
      if (serverProcess.exitCode !== null) break;
    }

    if (!ready) {
      if (serverProcess.exitCode !== null) {
        throw new Error(`Production server exited with code ${serverProcess.exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`);
      }
      throw new Error(`Production server failed to start within 15s\nstdout: ${stdout}\nstderr: ${stderr}`);
    }

    printSuccess('Production server started');

    const healthResp = await fetch(`http://localhost:${port}/health`);
    if (!healthResp.ok) throw new Error(`Health check returned ${healthResp.status}`);
    printSuccess('Health check passed');

    const mcpResp = await fetch(`http://localhost:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'validate', version: '0.0.1' } },
      }),
    });
    if (!mcpResp.ok) throw new Error(`MCP endpoint returned ${mcpResp.status}`);

    const responseText = await mcpResp.text();
    // enableJsonResponse defaults to true, so the response is plain JSON.
    // Fall back to SSE parsing if the server was started with --sse.
    const dataLine = responseText.split('\n').find(l => l.startsWith('data: '));
    const mcpBody = dataLine ? JSON.parse(dataLine.slice(6)) : JSON.parse(responseText);
    if (!mcpBody.result?.serverInfo) throw new Error(`MCP initialize response missing serverInfo: ${JSON.stringify(mcpBody)}`);
    printSuccess(`MCP initialize responded (${mcpBody.result.serverInfo.name} v${mcpBody.result.serverInfo.version})`);
  } finally {
    serverProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL');
  }
}


/**
 * Inspect mode integration test.
 *
 * Starts `sunpeak start` (real MCP server) and `sunpeak inspect` pointing at it,
 * then verifies tool discovery, tool calling, and the inspect server health endpoint.
 * All ports are dynamically allocated via getPort() to support parallel runs.
 */
async function validateInspectMode(exampleDir) {
  const mcpPort = await getPort(18800);
  const inspectPort = await getPort(18900);
  const sandboxPort = await getPort(24690);

  // Start the MCP server
  console.log(`Starting MCP server on port ${mcpPort}...`);
  const mcpProcess = spawn('node', [SUNPEAK_BIN, 'start', '--port', String(mcpPort)], {
    cwd: exampleDir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let mcpStdout = '';
  let mcpStderr = '';
  mcpProcess.stdout.on('data', (data) => { mcpStdout += data.toString(); });
  mcpProcess.stderr.on('data', (data) => { mcpStderr += data.toString(); });

  try {
    // Wait for MCP server to be ready
    let mcpReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const response = await fetch(`http://localhost:${mcpPort}/health`);
        if (response.ok) { mcpReady = true; break; }
      } catch { /* not up yet */ }
      if (mcpProcess.exitCode !== null) break;
    }

    if (!mcpReady) {
      throw new Error(`MCP server failed to start\nstdout: ${mcpStdout}\nstderr: ${mcpStderr}`);
    }
    printSuccess('MCP server started');

    // Start sunpeak inspect pointing at the MCP server
    console.log(`Starting inspect server on port ${inspectPort}...`);
    const inspectProcess = spawn(
      'node',
      [SUNPEAK_BIN, 'inspect', '--server', `http://localhost:${mcpPort}/mcp`, '--port', String(inspectPort)],
      {
        cwd: exampleDir,
        env: { ...process.env, CI: '1', SUNPEAK_SANDBOX_PORT: String(sandboxPort) },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    let inspectStdout = '';
    let inspectStderr = '';
    inspectProcess.stdout.on('data', (data) => { inspectStdout += data.toString(); });
    inspectProcess.stderr.on('data', (data) => { inspectStderr += data.toString(); });

    try {
      // Wait for inspect server to be ready
      let inspectReady = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const response = await fetch(`http://localhost:${inspectPort}/health`);
          if (response.ok) { inspectReady = true; break; }
        } catch { /* not up yet */ }
        if (inspectProcess.exitCode !== null) break;
      }

      if (!inspectReady) {
        if (inspectProcess.exitCode !== null) {
          throw new Error(`Inspect server exited with code ${inspectProcess.exitCode}\nstdout: ${inspectStdout}\nstderr: ${inspectStderr}`);
        }
        throw new Error(`Inspect server failed to start within 15s\nstdout: ${inspectStdout}\nstderr: ${inspectStderr}`);
      }
      printSuccess('Inspect server started');

      const entryResp = await fetch(`http://localhost:${inspectPort}/@id/__x00__virtual:sunpeak-inspect-entry`);
      if (!entryResp.ok) throw new Error(`Virtual entry module returned ${entryResp.status}`);
      const inspectorRequestToken = extractInspectorRequestToken(await entryResp.text());

      // Verify tool discovery
      const listToolsResp = await fetch(`http://localhost:${inspectPort}/__sunpeak/list-tools`);
      if (!listToolsResp.ok) throw new Error(`list-tools returned ${listToolsResp.status}`);
      const { tools } = await listToolsResp.json();
      if (!tools || tools.length === 0) throw new Error('No tools discovered from MCP server');
      const toolNames = tools.map(t => t.name);
      printSuccess(`Discovered ${tools.length} tool(s): ${toolNames.join(', ')}`);

      // Verify tool calling — pick the first tool and call it with empty args
      const firstTool = tools[0];
      const callToolResp = await fetch(`http://localhost:${inspectPort}/__sunpeak/call-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: firstTool.name, arguments: {} }),
      });
      if (!callToolResp.ok) throw new Error(`call-tool returned ${callToolResp.status}`);
      const callResult = await callToolResp.json();
      // Result should have either content or structuredContent (or isError)
      if (!callResult.content && !callResult.structuredContent && !callResult.isError) {
        throw new Error(`call-tool returned unexpected shape: ${JSON.stringify(callResult).substring(0, 200)}`);
      }
      printSuccess(`Tool call succeeded: ${firstTool.name}`);

      // Verify resource reading endpoint responds (even if no resources matched)
      const readResourceResp = await fetch(
        readResourceUrl(`http://localhost:${inspectPort}`, 'nonexistent://test', inspectorRequestToken)
      );
      // Should return 404 or 500 (resource not found), not crash
      if (readResourceResp.status !== 404 && readResourceResp.status !== 500) {
        throw new Error(`read-resource returned unexpected status ${readResourceResp.status}`);
      }
      printSuccess('Resource endpoint responds correctly');

      // Verify the inspect UI serves HTML
      const indexResp = await fetch(`http://localhost:${inspectPort}/`);
      if (!indexResp.ok) throw new Error(`Index page returned ${indexResp.status}`);
      const indexHtml = await indexResp.text();
      if (!indexHtml.includes('<div id="root">')) throw new Error('Index page missing #root');
      if (!indexHtml.includes('sunpeak')) throw new Error('Index page missing sunpeak branding');
      printSuccess('Inspect UI serves correctly');

    } finally {
      inspectProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      if (inspectProcess.exitCode === null) inspectProcess.kill('SIGKILL');
    }
  } finally {
    mcpProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    if (mcpProcess.exitCode === null) mcpProcess.kill('SIGKILL');
  }
}


/**
 * Dev server integration test.
 *
 * Boots `sunpeak dev` and exercises every interaction surface that could
 * break silently: MCP discovery, tool calling, resource HTML, simulation
 * fixture data, prod resources, backend-only tools, sandbox server, server
 * identity, and framework mode props.
 */
async function validateDevServer(projectDir) {
  const devPort = await getPort(18950);
  const sandboxPort = await getPort(24695);
  const hmrPort = await getPort(24696);

  console.log(`Starting dev server on port ${devPort}...`);
  const devProcess = spawn(
    'node',
    [SUNPEAK_BIN, 'dev', '--port', String(devPort), '--no-begging'],
    {
      cwd: projectDir,
      env: {
        ...process.env,
        CI: '1',
        PORT: String(devPort),
        SUNPEAK_SANDBOX_PORT: String(sandboxPort),
        SUNPEAK_HMR_PORT: String(hmrPort),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );

  let devStdout = '';
  let devStderr = '';
  devProcess.stdout.on('data', (data) => { devStdout += data.toString(); });
  devProcess.stderr.on('data', (data) => { devStderr += data.toString(); });

  try {
    // ── 1. Health endpoint ──
    let ready = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const response = await fetch(`http://localhost:${devPort}/health`);
        if (response.ok) { ready = true; break; }
      } catch { /* not up yet */ }
      if (devProcess.exitCode !== null) break;
    }
    if (!ready) {
      const ctx = devProcess.exitCode !== null
        ? `exited with code ${devProcess.exitCode}`
        : 'failed to start within 30s';
      throw new Error(`Dev server ${ctx}\nstdout: ${devStdout}\nstderr: ${devStderr}`);
    }
    printSuccess('Dev server started');

    const entryResp = await fetch(`http://localhost:${devPort}/@id/__x00__virtual:sunpeak-inspect-entry`);
    if (!entryResp.ok) throw new Error(`Virtual entry module returned ${entryResp.status}`);
    const entryJs = await entryResp.text();
    const inspectorRequestToken = extractInspectorRequestToken(entryJs);

    // ── 2. Tool discovery ──
    const listToolsResp = await fetch(`http://localhost:${devPort}/__sunpeak/list-tools`);
    if (!listToolsResp.ok) throw new Error(`list-tools returned ${listToolsResp.status}`);
    const { tools } = await listToolsResp.json();
    if (!tools || tools.length === 0) throw new Error('No tools discovered');
    const toolNames = tools.map(t => t.name);
    printSuccess(`Discovered ${tools.length} tool(s): ${toolNames.join(', ')}`);

    // ── 3. All expected simulations present ──
    // Read simulation directory to know what we expect
    const simDir = join(projectDir, 'tests/simulations');
    const expectedSims = readdirSync(simDir)
      .filter(f => f.endsWith('.json'))
      .map(f => JSON.parse(readFileSync(join(simDir, f), 'utf-8')).tool);
    const missingTools = expectedSims.filter(name => !toolNames.includes(name));
    if (missingTools.length > 0) {
      throw new Error(`Tools from simulation files not discovered: ${missingTools.join(', ')}`);
    }
    printSuccess(`All ${expectedSims.length} simulation tools present`);

    // ── 4. UI tools have resource metadata ──
    const uiTools = tools.filter(t => t._meta?.ui?.resourceUri || t._meta?.['ui/resourceUri']);
    if (uiTools.length === 0) {
      throw new Error('Expected at least one UI tool with resourceUri metadata');
    }
    printSuccess(`${uiTools.length} UI tool(s) with resourceUri`);

    // ── 5. All UI resources have distinct URIs ──
    const resourceUris = uiTools.map(t => t._meta?.ui?.resourceUri ?? t._meta?.['ui/resourceUri']);
    const uniqueUris = new Set(resourceUris);
    // Multiple tools can share a resource (e.g., review-diff and review-post share review)
    // but every URI should be non-empty
    if (resourceUris.some(u => !u)) {
      throw new Error('Found UI tool with empty resourceUri');
    }
    printSuccess(`${uniqueUris.size} distinct resource URI(s)`);

    // ── 6. Backend-only tools registered and callable ──
    const backendTools = tools.filter(t => !t._meta?.ui?.resourceUri && !t._meta?.['ui/resourceUri']);
    if (backendTools.length === 0) {
      console.log('  (no backend-only tools found, skipping)');
    } else {
      const backendTool = backendTools[0];
      const backendResp = await fetch(`http://localhost:${devPort}/__sunpeak/call-tool`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: backendTool.name, arguments: {} }),
      });
      if (!backendResp.ok) throw new Error(`Backend tool call returned ${backendResp.status}`);
      const backendResult = await backendResp.json();
      if (!backendResult.content && !backendResult.isError) {
        throw new Error(`Backend tool returned unexpected shape: ${JSON.stringify(backendResult).substring(0, 200)}`);
      }
      printSuccess(`Backend-only tool callable: ${backendTool.name}`);
    }

    // ── 7. UI tool calling returns structured content ──
    const uiToolWithResult = uiTools[0];
    const callResp = await fetch(`http://localhost:${devPort}/__sunpeak/call-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: uiToolWithResult.name, arguments: {} }),
    });
    if (!callResp.ok) throw new Error(`call-tool returned ${callResp.status}`);
    const callResult = await callResp.json();
    if (!callResult.content && !callResult.structuredContent && !callResult.isError) {
      throw new Error(`UI tool call returned unexpected shape: ${JSON.stringify(callResult).substring(0, 200)}`);
    }
    printSuccess(`UI tool call succeeded: ${uiToolWithResult.name}`);

    // ── 8. Resource HTML served with Vite HMR ──
    const firstUri = uiTools[0]._meta?.ui?.resourceUri ?? uiTools[0]._meta?.['ui/resourceUri'];
    const readResp = await fetch(
      readResourceUrl(`http://localhost:${devPort}`, firstUri, inspectorRequestToken)
    );
    if (!readResp.ok) throw new Error(`read-resource returned ${readResp.status}`);
    const resourceHtml = await readResp.text();
    if (!resourceHtml.includes('<div id="root">')) throw new Error('Resource HTML missing #root');
    if (!resourceHtml.includes('@vite/client')) throw new Error('Resource HTML missing Vite HMR script');
    printSuccess('Resource HTML served with Vite HMR');

    // ── 9. All distinct resources readable ──
    for (const uri of uniqueUris) {
      const resp = await fetch(
        readResourceUrl(`http://localhost:${devPort}`, uri, inspectorRequestToken)
      );
      if (!resp.ok) throw new Error(`read-resource failed for ${uri}: ${resp.status}`);
      const html = await resp.text();
      if (!html.includes('<div id="root">')) throw new Error(`Resource ${uri} missing #root`);
    }
    printSuccess(`All ${uniqueUris.size} resources readable`);

    // ── 10. Inspector UI: framework mode (no server URL input) ──
    const indexResp = await fetch(`http://localhost:${devPort}/`);
    if (!indexResp.ok) throw new Error(`Index page returned ${indexResp.status}`);
    const indexHtml = await indexResp.text();
    if (!indexHtml.includes('<div id="root">')) throw new Error('Index page missing #root');
    // In framework mode, the virtual entry should NOT set mcpServerUrl (which shows
    // the server URL input). It should contain the simulations and onCallTool instead.
    if (indexHtml.includes('mcpServerUrl')) {
      throw new Error('Framework mode: index page should not contain mcpServerUrl');
    }
    printSuccess('Inspector UI in framework mode');

    // ── 11. Server identity in page title ──
    // The dev server reads name from server.ts or package.json. The template's
    // package.json name is "sunpeak-app". It should appear in the <title>.
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'));
    const expectedName = pkg.name || 'sunpeak-app';
    if (!indexHtml.includes(expectedName)) {
      throw new Error(`Page title should contain "${expectedName}"`);
    }
    printSuccess(`Server identity in title: "${expectedName}"`);

    // ── 12. Simulation fixture data flows through ──
    // Fixture data (toolInput, toolResult, serverTools, userMessage) from JSON
    // files is merged into the simulations object and serialized into the virtual
    // entry JS module. Fetch the module and check for fixture data.
    const sampleFixture = JSON.parse(readFileSync(join(simDir, 'show-albums.json'), 'utf-8'));
    if (sampleFixture.toolInput) {
      const fixtureKey = Object.keys(sampleFixture.toolInput)[0]; // e.g., "category"
      if (!entryJs.includes(fixtureKey)) {
        throw new Error(`Fixture toolInput missing from virtual entry (expected "${fixtureKey}")`);
      }
      printSuccess('Fixture data: toolInput flows through');
    }
    if (sampleFixture.userMessage) {
      if (!entryJs.includes(sampleFixture.userMessage.substring(0, 20))) {
        throw new Error(`Fixture userMessage missing from virtual entry`);
      }
      printSuccess('Fixture data: userMessage flows through');
    }
    if (sampleFixture.toolResult?.structuredContent) {
      // Verify the entry contains the structured content shape
      if (!entryJs.includes('structuredContent')) {
        throw new Error('Fixture toolResult.structuredContent missing from virtual entry');
      }
      printSuccess('Fixture data: toolResult flows through');
    }

    // ── 13. Sandbox server responds ──
    // The sandbox URL is embedded in the virtual entry module JS.
    // Extract it and verify the sandbox proxy is reachable.
    const sandboxUrlMatch = entryJs.match(/const sandboxUrl\s*=\s*"(http[^"]+)"/);
    if (!sandboxUrlMatch) {
      throw new Error('Sandbox URL not found in virtual entry module');
    }
    const sandboxUrl = sandboxUrlMatch[1];
    // The sandbox serves the proxy at /proxy and has a /health endpoint
    const sandboxHealthResp = await fetch(`${sandboxUrl}/health`);
    if (!sandboxHealthResp.ok) throw new Error(`Sandbox health returned ${sandboxHealthResp.status}`);
    const sandboxProxyResp = await fetch(`${sandboxUrl}/proxy`);
    if (!sandboxProxyResp.ok) throw new Error(`Sandbox proxy returned ${sandboxProxyResp.status}`);
    const sandboxHtml = await sandboxProxyResp.text();
    if (!sandboxHtml.includes('postMessage')) {
      throw new Error('Sandbox proxy HTML missing PostMessage relay');
    }
    if (!sandboxHtml.includes('sandbox-proxy-ready')) {
      throw new Error('Sandbox proxy HTML missing readiness signal');
    }
    printSuccess(`Sandbox server responds (${sandboxUrl})`);

    // ── 14. Prod resources: /dist/ served after build ──
    let buildDone = false;
    for (let i = 0; i < 60; i++) {
      if ((devStdout + devStderr).includes('Built resources for the MCP server')) {
        buildDone = true;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!buildDone) {
      throw new Error('Build watcher did not complete within 30s');
    }

    // Extract resource name from URI (ui://name-timestamp → name)
    const resourceName = firstUri.replace('ui://', '').replace(/-[a-z0-9]+$/, '');
    const distUrl = `http://localhost:${devPort}/dist/${resourceName}/${resourceName}.html`;

    // HEAD (the Inspector polls with HEAD to check readiness)
    const distHeadResp = await fetch(distUrl, { method: 'HEAD' });
    if (!distHeadResp.ok) {
      throw new Error(`Prod resources HEAD ${distUrl} returned ${distHeadResp.status}`);
    }

    // GET (the Inspector loads this in the iframe)
    const distGetResp = await fetch(distUrl);
    const distHtml = await distGetResp.text();
    if (!distHtml.includes('<div id="root">')) throw new Error('Prod resources HTML missing #root');
    if (!distHtml.includes('<script>')) throw new Error('Prod resources HTML missing inlined script');
    // Prod HTML should NOT contain Vite HMR (it's self-contained)
    if (distHtml.includes('@vite/client')) throw new Error('Prod resources HTML should not contain Vite HMR');
    printSuccess(`Prod resources served: /dist/${resourceName}/${resourceName}.html`);

    // ── 15. Missing dist file returns 404 (not SPA fallback) ──
    const missingDistResp = await fetch(`http://localhost:${devPort}/dist/nonexistent/nonexistent.html`, { method: 'HEAD' });
    if (missingDistResp.ok) {
      throw new Error('Missing dist file should return 404, not 200');
    }
    printSuccess('Missing dist file returns 404');

  } finally {
    devProcess.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 1000));
    if (devProcess.exitCode === null) devProcess.kill('SIGKILL');
  }
}


// ============================================================================
// Main testing flow
// ============================================================================

// Parse --live flag
const liveMode = process.argv.includes('--live');

const startTime = Date.now();

console.log(`${colors.yellow}Starting local testing for Sunpeak...${colors.reset}`);
console.log(`Repository root: ${REPO_ROOT}`);
console.log(`Package root: ${PACKAGE_ROOT}\n`);

try {
  // ==========================================================================
  // Phase 1: Package-level checks (sequential, fast)
  // ==========================================================================
  printSection('PACKAGE LEVEL TESTS');

  console.log('Running: pnpm install');
  if (!runCommand('pnpm install', REPO_ROOT)) throw new Error('pnpm install failed');
  printSuccess('pnpm install');

  console.log('\nRunning: pnpm format');
  if (!runCommand('pnpm format', PACKAGE_ROOT)) throw new Error('pnpm format failed');
  printSuccess('pnpm format');

  console.log('\nRunning: pnpm lint');
  if (!runCommand('pnpm lint', PACKAGE_ROOT)) throw new Error('pnpm lint failed');
  printSuccess('pnpm lint');

  console.log('\nRunning: pnpm build');
  if (!runCommand('pnpm build', PACKAGE_ROOT)) throw new Error('pnpm build failed');
  printSuccess('pnpm build');

  validateExportsMap();
  validateDistCss();

  console.log('\nRunning: pnpm typecheck');
  if (!runCommand('pnpm typecheck', PACKAGE_ROOT)) throw new Error('pnpm typecheck failed');
  printSuccess('pnpm typecheck');

  console.log('\nRunning: template typecheck');
  if (!runCommand('pnpm exec tsc --noEmit', TEMPLATE_ROOT)) throw new Error('Template typecheck failed');
  printSuccess('template typecheck');

  console.log('\nRunning: pnpm test');
  if (!runCommand('pnpm test', PACKAGE_ROOT)) throw new Error('pnpm test failed');
  printSuccess('pnpm test');

  console.log('\nInstalling Playwright browsers for package-level e2e...');
  if (!runCommand('pnpm exec playwright install chromium --with-deps', PACKAGE_ROOT)) {
    throw new Error('Playwright browser install failed');
  }
  printSuccess('Playwright browsers installed');

  console.log('\nRunning: pnpm test:e2e (package-level inspector e2e)');
  {
    const packageE2ePort = await getPort(6777);
    const packageE2eMcpPort = await getPort(18777);
    const packageE2eSandboxPort = await getPort(24681);
    const packageE2eHmrPort = await getPort(24679);
    if (!(await runCommandIsolated('pnpm test:e2e', PACKAGE_ROOT, {
      CI: '1',
      SUNPEAK_TEST_PORT: String(packageE2ePort),
      SUNPEAK_MCP_PORT: String(packageE2eMcpPort),
      SUNPEAK_SANDBOX_PORT: String(packageE2eSandboxPort),
      SUNPEAK_HMR_PORT: String(packageE2eHmrPort),
    }))) throw new Error('pnpm test:e2e failed');
  }
  printSuccess('pnpm test:e2e');

  // ==========================================================================
  // Phase 2: Static validations (instant)
  // ==========================================================================
  printSection('DOCS VALIDATION');
  validateDocs();

  // ==========================================================================
  // Phase 3: Generate examples + install Playwright (before parallel phase)
  // ==========================================================================
  printSection('EXAMPLE PROJECTS');

  const resources = discoverResources();
  console.log(`Discovered resources: ${resources.join(', ')}`);

  console.log('\nGenerating examples...');
  if (!runCommand(`node ${join(PACKAGE_ROOT, 'scripts', 'generate-examples.mjs')} --skip-install`, REPO_ROOT)) {
    throw new Error('Example generation failed');
  }
  printSuccess('Examples generated');

  // Install Playwright browsers once (using first example's node_modules after a quick link+install)
  {
    const firstDir = join(EXAMPLES_DIR, `${resources[0]}-example`);
    const pkgPath = join(firstDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const originalSunpeakDependency = pkg.dependencies.sunpeak;
    pkg.dependencies.sunpeak = `file:${PACKAGE_ROOT}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('\nInstalling Playwright browsers...');
    runCommand(GENERATED_PROJECT_PNPM_INSTALL, firstDir);
    runCommand('pnpm exec playwright install chromium --with-deps', firstDir);
    printSuccess('Playwright browsers installed');
    // Undo the link — testExample will re-link + install
    const origPkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    origPkg.dependencies.sunpeak = originalSunpeakDependency;
    writeFileSync(pkgPath, JSON.stringify(origPkg, null, 2) + '\n');
  }

  // ==========================================================================
  // Phase 4: Scaffold smoke test
  // ==========================================================================
  printSection('SCAFFOLD SMOKE TEST');

  const scaffoldStart = Date.now();
  console.log('Running scaffold smoke test (sunpeak new → dev → test → build → start)...\n');

  const scaffoldResult = await runScaffoldSmokeTest();
  if (scaffoldResult.ok) {
    const scaffoldDuration = ((Date.now() - scaffoldStart) / 1000).toFixed(1);
    printSuccess(`scaffold smoke test (new → dev → test → build → start) (${scaffoldDuration}s)`);
  } else {
    console.error(`\n${colors.red}✗ scaffold smoke test failed at: ${scaffoldResult.step}${colors.reset}`);
    console.error(`${colors.dim}${scaffoldResult.output.split('\n').slice(-30).join('\n')}${colors.reset}`);
    throw new Error(`Scaffold smoke test failed at: ${scaffoldResult.step}`);
  }

  // ==========================================================================
  // Phase 5: Test init + examples
  // ==========================================================================
  printSection('TEST INIT + EXAMPLES');

  const exampleStart = Date.now();
  console.log(`Running test init + ${resources.length} examples...\n`);

  for (const resource of resources) {
    const exampleTmpDir = join(REPO_ROOT, `.tmp-validate-${resource}-example`);
    removeDirIfExists(exampleTmpDir);
  }

  const testInitResult = runTestInitSmokeTest();
  const exampleResults = [];
  for (const [index, resource] of resources.entries()) {
    exampleResults.push(await testExample(resource, index));
  }

  if (testInitResult.ok) {
    printSuccess('test init smoke test (sunpeak test init)');
  } else {
    console.error(`\n${colors.red}✗ test init smoke test failed at: ${testInitResult.step}${colors.reset}`);
    console.error(`${colors.dim}${testInitResult.output.split('\n').slice(-30).join('\n')}${colors.reset}`);
    throw new Error(`Test init smoke test failed at: ${testInitResult.step}`);
  }

  // Report example results
  const failedExamples = [];
  resources.forEach((resource, index) => {
    const result = exampleResults[index];
    const name = `${resource}-example`;
    if (result.ok) {
      printSuccess(name);
    } else {
      failedExamples.push({ name, result });
    }
  });

  if (failedExamples.length > 0) {
    for (const { name, result } of failedExamples) {
      console.error(`\n${colors.red}✗ ${name} failed at: ${result.step}${colors.reset}`);
      console.error(`${colors.dim}${result.output.split('\n').slice(-40).join('\n')}${colors.reset}`);
    }
    throw new Error(`${failedExamples.length} example(s) failed: ${failedExamples.map(e => e.name).join(', ')}`);
  }

  const exampleDuration = ((Date.now() - exampleStart) / 1000).toFixed(1);
  printSuccess(`All test init + example tasks passed (${exampleDuration}s)`);

  // ==========================================================================
  // Phase 5: Visual regression testing (template)
  // ==========================================================================
  printSection('VISUAL REGRESSION TESTS');

  // Run visual tests against the template (which has all resources).
  // First pass: create baselines with --update.
  // Second pass: verify screenshots match baselines.
  {
    const visualPort = await getPort(6790);
    const visualSandboxPort = await getPort(24685);
    const visualEnv = {
      SUNPEAK_TEST_PORT: String(visualPort),
      SUNPEAK_SANDBOX_PORT: String(visualSandboxPort),
    };

    console.log('Creating visual baselines...');
    if (!runCommand('pnpm test:visual -- --update tests/e2e/visual.spec.ts', TEMPLATE_ROOT, visualEnv)) {
      throw new Error('Visual baseline creation failed');
    }
    printSuccess('Visual baselines created');

    console.log('\nVerifying visual snapshots match...');
    if (!runCommand('pnpm test:visual -- tests/e2e/visual.spec.ts', TEMPLATE_ROOT, visualEnv)) {
      throw new Error('Visual regression verification failed');
    }
    printSuccess('Visual snapshots verified');

    // Clean up baselines (template is part of the monorepo, not a user project)
    const screenshotsDir = join(TEMPLATE_ROOT, 'tests/e2e/__screenshots__');
    removeDirIfExists(screenshotsDir);
  }

  // ==========================================================================
  // Phase 6: Production server smoke test
  // ==========================================================================
  printSection('PRODUCTION SERVER');

  // Rebuild last example to ensure dist/ is fresh
  const lastResource = resources[resources.length - 1];
  const lastExampleDir = join(EXAMPLES_DIR, `${lastResource}-example`);
  const productionExampleDir = join(PRODUCTION_TMP, `${lastResource}-production-server`);
  removeDirIfExists(productionExampleDir);
  mkdirSync(PRODUCTION_TMP, { recursive: true });
  cpSync(lastExampleDir, productionExampleDir, {
    recursive: true,
    filter: (source) => !source.split(sep).some(part =>
      ['node_modules', 'dist', 'test-results', 'playwright-report', 'pnpm-lock.yaml'].includes(part)
    ),
  });

  try {
    const prodPkgPath = join(productionExampleDir, 'package.json');
    const prodPkg = JSON.parse(readFileSync(prodPkgPath, 'utf-8'));
    prodPkg.dependencies.sunpeak = `file:${PACKAGE_ROOT}`;
    writeFileSync(prodPkgPath, JSON.stringify(prodPkg, null, 2) + '\n');

    console.log(`Installing ${lastResource}-example for production server test...`);
    if (!runCommand(GENERATED_PROJECT_PNPM_INSTALL, productionExampleDir)) {
      throw new Error('Failed to install production server test example');
    }
    printSuccess('production server example installed');

    console.log(`Rebuilding ${lastResource}-example for production server test...`);
    if (!runCommand(`node ${SUNPEAK_BIN} build`, productionExampleDir)) {
      throw new Error('Failed to rebuild for production server test');
    }
    printSuccess('sunpeak build (for production server)');

    await validateProductionServer(productionExampleDir);
  } finally {
    removeDirIfExists(productionExampleDir);
  }

  // ==========================================================================
  // Phase 6b: Inspect mode integration test
  // ==========================================================================
  printSection('INSPECT MODE');

  // Use the template directory (already built during pnpm build) rather than an
  // example, because examples may lack esbuild and skip tool compilation.
  console.log('Building template for inspect test...');
  if (!runCommand(`node ${SUNPEAK_BIN} build`, TEMPLATE_ROOT)) {
    throw new Error('Template build failed for inspect test');
  }
  printSuccess('Template built');
  await validateInspectMode(TEMPLATE_ROOT);

  // ==========================================================================
  // Phase 6c: Dev server integration test
  // ==========================================================================
  printSection('DEV SERVER');

  await validateDevServer(TEMPLATE_ROOT);

  // ==========================================================================
  // Phase 7: Live tests (opt-in, requires tunnel)
  // ==========================================================================
  if (liveMode) {
    printSection('LIVE TESTS');

    if (!runCommand('pnpm test:live', TEMPLATE_ROOT)) {
      throw new Error('Live tests failed');
    }

    printSuccess('Live tests passed');
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================
  console.log('\nRegenerating clean examples...');
  if (!runCommand(`node ${join(PACKAGE_ROOT, 'scripts', 'generate-examples.mjs')} --skip-install`, REPO_ROOT)) {
    console.log('Note: Failed to regenerate clean examples');
  }
  printSuccess('Clean examples restored');

  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
  printSuccess(`SHIP IT! (${totalDuration}s total)\n\n`);
  process.exit(0);
} catch (error) {
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`\n${colors.red}Error (${totalDuration}s): ${error.message}${colors.reset}\n`);
  process.exit(1);
}
