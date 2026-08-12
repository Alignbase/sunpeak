#!/usr/bin/env node
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import * as clack from '@clack/prompts';
import { discoverResources } from '../lib/patterns.mjs';
import { detectPackageManager } from '../utils.mjs';
import { EVAL_PROVIDERS } from '../lib/eval/eval-providers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Default prompt for project name using clack text input.
 * @returns {Promise<string>}
 */
async function defaultPromptName() {
  const value = await clack.text({
    message: 'Project name',
    placeholder: 'sunpeak-app',
    defaultValue: 'sunpeak-app',
    validate: (v) => {
      if (v === 'template') return '"template" is a reserved name';
    },
  });
  if (clack.isCancel(value)) {
    clack.cancel('Cancelled.');
    process.exit(0);
  }
  return value;
}

/**
 * Default resource selection using clack multiselect.
 * @param {string[]} availableResources
 * @returns {Promise<string[]>}
 */
async function defaultSelectResources(availableResources) {
  const selected = await clack.multiselect({
    message: 'Resources (UIs) to include (space to toggle)',
    options: (() => {
      const maxLen = Math.max(...availableResources.map((r) => r.length));
      return availableResources.map((r) => ({
        value: r,
        label: `${r.padEnd(maxLen)}  (https://sunpeak.ai/docs/app-framework/resources/${r})`,
      }));
    })(),
    initialValues: availableResources,
    required: true,
  });
  if (clack.isCancel(selected)) {
    clack.cancel('Cancelled.');
    process.exit(0);
  }
  return selected;
}

/**
 * Default prompt for eval provider selection.
 * @returns {Promise<Array<{ pkg: string, models: string[] }>>}
 */
async function defaultSelectProviders() {
  const selected = await clack.multiselect({
    message: 'AI providers for evals (space to toggle, enter to skip)',
    options: EVAL_PROVIDERS.map((p) => ({ value: p, label: p.label })),
    initialValues: [],
    required: false,
  });
  if (clack.isCancel(selected)) return [];
  return selected;
}

/**
 * Default dependencies (real implementations)
 */
export const defaultDeps = {
  discoverResources,
  detectPackageManager,
  existsSync,
  mkdirSync,
  cpSync,
  readFileSync,
  writeFileSync,
  renameSync,
  execSync,
  execAsync,
  skipInstall: false,
  promptName: defaultPromptName,
  selectResources: defaultSelectResources,
  selectProviders: defaultSelectProviders,
  password: clack.password,
  confirm: clack.confirm,
  intro: clack.intro,
  outro: clack.outro,
  spinner: clack.spinner,
  console,
  process,
  cwd: () => process.cwd(),
  templateDir: join(__dirname, '..', '..', 'template'),
  rootPkgPath: join(__dirname, '..', '..', 'package.json'),
};

/**
 * Parse and validate resources input
 * @param {string} input - Comma or space separated resource names
 * @param {string[]} validResources - List of valid resource names
 * @param {Object} deps - Dependencies for testing
 * @returns {string[]} - Validated and deduplicated resource names
 */
export function parseResourcesInput(input, validResources, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };

  // If no input, return all resources
  if (!input || input.trim() === '') {
    return validResources;
  }

  // Split by comma or space and trim
  const tokens = input
    .toLowerCase()
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Validate tokens
  const invalid = tokens.filter((t) => !validResources.includes(t));
  if (invalid.length > 0) {
    d.console.error(`Error: Invalid resource(s): ${invalid.join(', ')}`);
    d.console.error(`Valid resources are: ${validResources.join(', ')}`);
    d.process.exit(1);
  }

  // Remove duplicates
  return [...new Set(tokens)];
}

/**
 * Create a new Sunpeak project
 * @param {string} projectName - Name of the project directory
 * @param {string} resourcesArg - Optional comma/space separated resources to include
 * @param {Object} deps - Dependencies for testing
 */
export async function init(projectName, resourcesArg, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };

  d.intro('☀️ sunpeak');

  // Discover available resources from template
  const availableResources = d.discoverResources();
  if (availableResources.length === 0) {
    d.console.error('Error: No resources found in template/src/resources/');
    d.process.exit(1);
  }

  if (!projectName) {
    projectName = await d.promptName();
  }

  if (projectName === 'template') {
    d.console.error('Error: "template" is a reserved name. Please choose another name.');
    d.process.exit(1);
  }

  // Reject path-traversal characters and leading dots so the project is always
  // created as a direct child of the cwd. Without this, `sunpeak new ../foo`
  // would resolve outside the intended directory.
  if (/[\\/]/.test(projectName) || projectName.startsWith('.') || projectName.includes('\0')) {
    d.console.error(
      `Error: Invalid project name "${projectName}". The name must not contain path separators or start with a dot.`
    );
    d.process.exit(1);
  }

  // Use resources from args or interactively select them
  let selectedResources;
  if (resourcesArg !== undefined) {
    selectedResources = parseResourcesInput(resourcesArg, availableResources, d);
  } else {
    selectedResources = await d.selectResources(availableResources);
  }

  const targetDir = join(d.cwd(), projectName);

  if (d.existsSync(targetDir)) {
    d.console.error(`Error: Directory "${projectName}" already exists`);
    d.process.exit(1);
  }

  // Filter resource directories based on selection
  const excludedResources = availableResources.filter((r) => !selectedResources.includes(r));

  d.mkdirSync(targetDir, { recursive: true });

  d.cpSync(d.templateDir, targetDir, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);

      // Skip node_modules, lock file, and legacy dev bootstrap files
      if (name === 'node_modules' || name === 'pnpm-lock.yaml' || name === '.sunpeak' || name === 'index.html') {
        return false;
      }

      // Skip framework-internal test files (dev overlay tests are for sunpeak development, not user projects)
      // Skip visual.spec.ts — it references specific resources and serves as a template/example.
      // Users should write their own visual tests for their selected resources.
      if ((src.includes('/tests/e2e/') || src.includes('/tests/live/')) && (name.startsWith('dev-') || name === 'visual.spec.ts')) {
        return false;
      }

      // Skip deps.json files (build-time metadata, not needed in scaffolded projects)
      if (name === 'deps.json' && src.includes('/resources/')) {
        return false;
      }

      for (const resource of excludedResources) {
        // Skip entire resource directory: src/resources/{resource}/
        if (src.includes('/resources/') && name === resource) {
          return false;
        }
        // Skip flat simulation files for excluded resources: tests/simulations/*.json
        if (src.includes('/tests/simulations/') && name.endsWith('.json')) {
          const baseName = name.replace(/\.json$/, '');
          if (baseName === resource || baseName.startsWith(resource + '-') || baseName.endsWith('-' + resource)) {
            return false;
          }
        }
        // Skip tool files (and their tests) for excluded resources: src/tools/*.ts
        if (src.includes('/src/tools/') && name.endsWith('.ts')) {
          const baseName = name.replace(/\.(test\.)?ts$/, '');
          if (baseName === resource || baseName.startsWith(resource + '-') || baseName.endsWith('-' + resource)) {
            return false;
          }
        }
        // Skip e2e test files for excluded resources
        if (src.includes('/tests/e2e/') && name === `${resource}.spec.ts`) {
          return false;
        }
        // Skip live test files for excluded resources
        if (src.includes('/tests/live/') && name === `${resource}.spec.ts`) {
          return false;
        }
        // Skip eval files for excluded resources
        if (src.includes('/tests/evals/') && name === `${resource}.eval.ts`) {
          return false;
        }
      }

      return true;
    },
  });

  // Rename underscore-prefixed files to dotfiles
  const dotfiles = ['_gitignore', '_prettierignore', '_prettierrc'];
  for (const file of dotfiles) {
    const srcPath = join(targetDir, file);
    const destPath = join(targetDir, file.replace(/^_/, '.'));
    if (d.existsSync(srcPath)) {
      d.renameSync(srcPath, destPath);
    }
  }
  // Rename nested dotfiles (underscore convention for npm compatibility)
  const nestedDotfiles = [['tests/evals/_env.example', 'tests/evals/.env.example']];
  for (const [from, to] of nestedDotfiles) {
    const srcPath = join(targetDir, from);
    const destPath = join(targetDir, to);
    if (d.existsSync(srcPath)) {
      d.renameSync(srcPath, destPath);
    }
  }

  // Read sunpeak version from root package.json
  const rootPkg = JSON.parse(d.readFileSync(d.rootPkgPath, 'utf-8'));
  const sunpeakVersion = `^${rootPkg.version}`;

  // Update project package.json
  const pkgPath = join(targetDir, 'package.json');
  const pkg = JSON.parse(d.readFileSync(pkgPath, 'utf-8'));
  pkg.name = projectName;

  // Replace workspace:* with actual version
  if (pkg.dependencies?.sunpeak === 'workspace:*') {
    pkg.dependencies.sunpeak = sunpeakVersion;
  }

  // Prune dependencies not needed by selected resources
  if (excludedResources.length > 0 && pkg.dependencies) {
    const resourcesDir = join(d.templateDir, 'src', 'resources');
    const readDeps = (resource) => {
      const depsPath = join(resourcesDir, resource, 'deps.json');
      try { return JSON.parse(d.readFileSync(depsPath, 'utf-8')); } catch { return {}; }
    };

    // Deps needed by selected resources
    const needed = new Set(selectedResources.flatMap((r) => Object.keys(readDeps(r))));
    // Deps from excluded resources that no selected resource needs
    const removable = excludedResources
      .flatMap((r) => Object.keys(readDeps(r)))
      .filter((dep) => !needed.has(dep));

    for (const dep of removable) {
      delete pkg.dependencies[dep];
    }
  }

  d.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  // Install dependencies with spinner
  const pm = d.detectPackageManager();

  // Replace package manager references in README
  if (pm !== 'pnpm') {
    const readmePath = join(targetDir, 'README.md');
    if (d.existsSync(readmePath)) {
      const run = pm === 'npm' ? 'npm run' : pm;
      const dlx = pm === 'npm' ? 'npx' : 'yarn dlx';
      let readme = d.readFileSync(readmePath, 'utf-8');
      readme = readme.replace(/pnpm dev\b/g, `${run} dev`);
      readme = readme.replace(/pnpm build\b/g, `${run} build`);
      readme = readme.replace(/pnpm start\b/g, `${run} start`);
      readme = readme.replace(/pnpm test\b/g, `${run} test`);
      readme = readme.replace(/pnpm test:unit\b/g, `${run} test:unit`);
      readme = readme.replace(/pnpm test:e2e\b/g, `${run} test:e2e`);
      readme = readme.replace(/pnpm test:visual\b/g, `${run} test:visual`);
      readme = readme.replace(/pnpm test:live\b/g, `${run} test:live`);
      readme = readme.replace(/pnpm test:eval\b/g, `${run} test:eval`);
      readme = readme.replace(/pnpm add\b/g, pm === 'npm' ? 'npm install' : `${pm} add`);
      readme = readme.replace(/pnpm dlx\b/g, dlx);
      d.writeFileSync(readmePath, readme);
    }
  }
  if (!d.skipInstall) {
    const s = d.spinner();
    s.start(`Installing dependencies with ${pm}...`);

    try {
      await d.execAsync(`${pm} install`, { cwd: targetDir });
      s.stop(`Installed dependencies with ${pm}`);
    } catch {
      s.stop(`Install failed. You can try running "${pm} install" manually.`);
    }
  }

  // Offer to configure eval providers (only in interactive mode)
  if (resourcesArg === undefined) {
    const providers = await d.selectProviders();
    if (!clack.isCancel(providers) && providers.length > 0) {
      // Install AI SDK core + selected provider packages
      const pkgsToInstall = ['ai', ...providers.map((p) => p.pkg)];
      try {
        await d.execAsync(`${pm} add -D ${pkgsToInstall.join(' ')}`, { cwd: targetDir });
      } catch {
        d.console.log(`Provider install failed. Install manually: ${pm} add -D ${pkgsToInstall.join(' ')}`);
      }

      // Uncomment selected models in eval.config.ts
      const evalConfigPath = join(targetDir, 'tests', 'evals', 'eval.config.ts');
      if (d.existsSync(evalConfigPath)) {
        let config = d.readFileSync(evalConfigPath, 'utf-8');
        for (const p of providers) {
          for (const model of p.models) {
            // Uncomment lines matching this model (e.g., "    // 'gpt-4o'," → "    'gpt-4o',")
            config = config.replace(
              new RegExp(`^(\\s*)// ('${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',?.*)$`, 'm'),
              '$1$2'
            );
          }
        }
        d.writeFileSync(evalConfigPath, config);
      }

      // Prompt for API keys and write .env
      const envLines = [];
      const seen = new Set();
      for (const p of providers) {
        if (seen.has(p.envVar)) continue;
        seen.add(p.envVar);
        const key = await d.password({
          message: `${p.envVar} (enter to skip)`,
          mask: '*',
        });
        if (!clack.isCancel(key) && key) {
          // Strip newlines so a pasted value can't inject extra .env entries.
          const cleanKey = String(key).replace(/[\r\n]+/g, '').trim();
          if (cleanKey) envLines.push(`${p.envVar}=${cleanKey}`);
        }
      }
      const envPath = join(targetDir, 'tests', 'evals', '.env');
      if (envLines.length > 0) {
        d.writeFileSync(envPath, envLines.join('\n') + '\n');
        clack.log.info(`API keys saved to tests/evals/.env (gitignored)`);
      }
    }
  }

  // Offer to install the sunpeak skills (only in interactive mode)
  if (resourcesArg === undefined) {
    const installSkill = await d.confirm({
      message: 'Install the sunpeak skills? (helps your coding agent build and test your app)',
      initialValue: true,
    });
    if (!clack.isCancel(installSkill) && installSkill) {
      const dlx = pm === 'yarn' ? 'yarn dlx' : pm === 'npm' ? 'npx' : 'pnpm dlx';
      try {
        d.execSync(`${dlx} skills add Alignbase/sunpeak@create-sunpeak-app Alignbase/sunpeak@test-mcp-server`, {
          cwd: targetDir,
          stdio: 'inherit',
        });
      } catch {
        d.console.log(`Skill install skipped. You can install later with: ${dlx} skills add Alignbase/sunpeak@create-sunpeak-app Alignbase/sunpeak@test-mcp-server`);
      }
    }
  }

  const run = pm === 'npm' ? 'npm run' : pm;
  d.outro(`Done! To get started:

  cd ${projectName}
  ${run} dev

Your project commands:

  ${run} dev              # Start dev server + MCP endpoint
  ${run} build            # Build for production
  ${run} test             # Run unit + e2e tests
  ${run} test:eval        # Run LLM evals (configure models in tests/evals/eval.config.ts)
  ${run} test:visual      # Run visual regression tests
  ${run} test:live        # Run live tests against real AI hosts`);
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const [projectName, resources] = process.argv.slice(2);
  init(projectName, resources).catch((error) => {
    console.error('Error:', error.message);
    process.exit(1);
  });
}
