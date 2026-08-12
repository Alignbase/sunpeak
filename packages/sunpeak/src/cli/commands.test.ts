/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck - CLI command modules are .mjs files without TypeScript declarations
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';

// Helper functions to import CLI modules dynamically
const importUpgrade = () => import('../../bin/commands/upgrade.mjs');
const importNew = () => import('../../bin/commands/new.mjs');
const importTestInit = () => import('../../bin/commands/test-init.mjs');
const importTest = () => import('../../bin/commands/test.mjs');

// Mock console for all tests
const createMockConsole = () => ({
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
});

// Mock process for tests that call process.exit
const createMockProcess = () => ({
  exit: vi.fn(),
  cwd: () => '/test/project',
});

// Mock process that throws on exit (to stop execution in tests)
const createThrowingMockProcess = () => ({
  exit: vi.fn().mockImplementation((code: number) => {
    throw new Error(`process.exit(${code})`);
  }),
  cwd: () => '/test/project',
});

// No-op clack mocks for tests
const noopIntro = vi.fn();
const noopOutro = vi.fn();
const noopSpinner = () => ({ start: vi.fn(), stop: vi.fn() });
const noopConfirm = vi.fn().mockResolvedValue(false);
const noopExecAsync = vi.fn().mockResolvedValue({});

describe('CLI Commands', () => {
  describe('test command', () => {
    it('strips sunpeak flags and separator before forwarding runner args', async () => {
      const { filterRunnerArgs } = await importTest();

      expect(filterRunnerArgs(['--visual', '--update', '--', 'tests/e2e/visual.spec.ts'])).toEqual([
        'tests/e2e/visual.spec.ts',
      ]);
    });
  });

  describe('dev command security', () => {
    it('does not splice virtual entry query params into executable strings', async () => {
      const { readFileSync } = await import('fs');
      const { join } = await import('path');

      const source = readFileSync(join(process.cwd(), 'bin/commands/dev.mjs'), 'utf-8');

      expect(source).toContain('const safeSrcPath = JSON.stringify(srcPath)');
      expect(source).toContain('const safeComponentName = JSON.stringify(componentName)');
      expect(source).toContain('const ResourceModule = await import(${safeSrcPath})');
      expect(source).toContain(
        'const Component = ResourceModule.default || ResourceModule[componentName]'
      );
      expect(source).toContain('error.textContent =');
      expect(source).not.toContain("import * as ResourceModule from '${srcPath}'");
      expect(source).not.toContain("ResourceModule['${componentName}']");
      expect(source).not.toContain('Component not found: ${componentName}');
    });
  });

  describe('new command', () => {
    it('should error when no resources are discovered', async () => {
      const { init } = await importNew();
      const mockConsole = createMockConsole();
      const mockProcess = createThrowingMockProcess();

      await expect(
        init('my-project', 'carousel', {
          discoverResources: () => [],
          console: mockConsole,
          process: mockProcess,
          intro: noopIntro,
          outro: noopOutro,
          spinner: noopSpinner,
        })
      ).rejects.toThrow('process.exit(1)');

      expect(mockConsole.error).toHaveBeenCalledWith(
        'Error: No resources found in template/src/resources/'
      );
    });

    it('should error when project name is "template"', async () => {
      const { init } = await importNew();
      const mockConsole = createMockConsole();
      const mockProcess = createThrowingMockProcess();

      await expect(
        init('template', 'carousel', {
          discoverResources: () => ['carousel', 'review'],
          console: mockConsole,
          process: mockProcess,
          intro: noopIntro,
          outro: noopOutro,
          spinner: noopSpinner,
        })
      ).rejects.toThrow('process.exit(1)');

      expect(mockConsole.error).toHaveBeenCalledWith(
        'Error: "template" is a reserved name. Please choose another name.'
      );
    });

    it('should error when directory already exists', async () => {
      const { init } = await importNew();
      const mockConsole = createMockConsole();
      const mockProcess = createThrowingMockProcess();

      await expect(
        init('my-project', 'carousel', {
          discoverResources: () => ['carousel', 'review'],
          existsSync: (path: string) => path.includes('my-project'),
          cwd: () => '/test',
          console: mockConsole,
          process: mockProcess,
          intro: noopIntro,
          outro: noopOutro,
          spinner: noopSpinner,
        })
      ).rejects.toThrow('process.exit(1)');

      expect(mockConsole.error).toHaveBeenCalledWith(
        'Error: Directory "my-project" already exists'
      );
    });

    it('should prompt for project name if not provided', async () => {
      const { init } = await importNew();
      const mockConsole = createMockConsole();
      const mockProcess = createThrowingMockProcess();

      await expect(
        init(undefined, 'carousel', {
          discoverResources: () => ['carousel', 'review'],
          promptName: async () => 'prompted-name',
          existsSync: (path: string) => path.includes('prompted-name'), // Target dir exists
          cwd: () => '/test',
          console: mockConsole,
          process: mockProcess,
          intro: noopIntro,
          outro: noopOutro,
          spinner: noopSpinner,
        })
      ).rejects.toThrow('process.exit(1)');

      // Should have prompted and then failed on existing directory
      expect(mockConsole.error).toHaveBeenCalledWith(
        'Error: Directory "prompted-name" already exists'
      );
    });

    it('should install both skills when user confirms in interactive mode', async () => {
      const { init } = await importNew();
      const mockConsole = createMockConsole();
      const mockProcess = createMockProcess();
      const execSyncMock = vi.fn();

      await init('my-project', undefined, {
        discoverResources: () => ['carousel'],
        detectPackageManager: () => 'npm',
        selectResources: vi.fn().mockResolvedValue(['carousel']),
        selectProviders: vi.fn().mockResolvedValue([]),
        password: vi.fn().mockResolvedValue(''),
        existsSync: () => false,
        mkdirSync: vi.fn(),
        cpSync: vi.fn(),
        readFileSync: () => JSON.stringify({ version: '1.0.0', name: 'test' }),
        writeFileSync: vi.fn(),
        renameSync: vi.fn(),
        execSync: execSyncMock,
        execAsync: noopExecAsync,
        confirm: vi.fn().mockResolvedValue(true),
        cwd: () => '/test',
        templateDir: '/template',
        rootPkgPath: '/root/package.json',
        console: mockConsole,
        process: mockProcess,
        intro: noopIntro,
        outro: noopOutro,
        spinner: noopSpinner,
      });

      expect(execSyncMock).toHaveBeenCalledWith(
        'npx skills add Alignbase/sunpeak@create-sunpeak-app Alignbase/sunpeak@test-mcp-server',
        expect.objectContaining({ cwd: path.join('/test', 'my-project'), stdio: 'inherit' })
      );
    });

    it('should use interactive multiselect when no resources arg provided', async () => {
      const { init } = await importNew();
      const mockConsole = createMockConsole();
      const mockProcess = createMockProcess();
      const selectResources = vi.fn().mockResolvedValue(['carousel']);

      let cpSyncFilter: ((src: string) => boolean) | null = null;

      await init('my-project', undefined, {
        discoverResources: () => ['carousel', 'review'],
        detectPackageManager: () => 'npm',
        selectResources,
        selectProviders: vi.fn().mockResolvedValue([]),
        password: vi.fn().mockResolvedValue(''),
        existsSync: () => false,
        mkdirSync: vi.fn(),
        cpSync: (_src: string, _dest: string, options: { filter: (src: string) => boolean }) => {
          cpSyncFilter = options.filter;
        },
        readFileSync: () => JSON.stringify({ version: '1.0.0', name: 'test' }),
        writeFileSync: vi.fn(),
        renameSync: vi.fn(),
        execSync: vi.fn(),
        execAsync: noopExecAsync,
        confirm: noopConfirm,
        cwd: () => '/test',
        templateDir: '/template',
        rootPkgPath: '/root/package.json',
        console: mockConsole,
        process: mockProcess,
        intro: noopIntro,
        outro: noopOutro,
        spinner: noopSpinner,
      });

      expect(selectResources).toHaveBeenCalledWith(['carousel', 'review']);
      expect(cpSyncFilter).not.toBeNull();
      expect(cpSyncFilter!('/template/src/resources/carousel')).toBe(true);
      expect(cpSyncFilter!('/template/src/resources/review')).toBe(false);
    });

    it('should create project with selected resources', async () => {
      const { init } = await importNew();
      const mockConsole = createMockConsole();
      const mockProcess = createMockProcess();

      let cpSyncFilter: ((src: string) => boolean) | null = null;
      let writtenPkg: { name: string; dependencies?: { sunpeak?: string } } | null = null;
      const renamedFiles: Array<{ from: string; to: string }> = [];

      await init('my-project', 'carousel', {
        discoverResources: () => ['carousel', 'review', 'map'],
        detectPackageManager: () => 'pnpm',
        existsSync: (path: string) => {
          // Target dir doesn't exist, but dotfiles do
          if (path === '/test/my-project') return false;
          if (path.includes('_gitignore')) return true;
          if (path.includes('_prettierignore')) return true;
          if (path.includes('_prettierrc')) return true;
          return false;
        },
        mkdirSync: vi.fn(),
        cpSync: (_src: string, _dest: string, options: { filter: (src: string) => boolean }) => {
          cpSyncFilter = options.filter;
        },
        readFileSync: (path: string) => {
          if (path.includes('package.json') && path.includes('my-project')) {
            return JSON.stringify({ name: 'template', dependencies: { sunpeak: 'workspace:*' } });
          }
          return JSON.stringify({ version: '1.0.0' });
        },
        writeFileSync: (_path: string, content: string) => {
          writtenPkg = JSON.parse(content);
        },
        renameSync: (from: string, to: string) => {
          renamedFiles.push({ from, to });
        },
        execSync: vi.fn(),
        execAsync: noopExecAsync,
        confirm: noopConfirm,
        cwd: () => '/test',
        templateDir: '/template',
        rootPkgPath: '/root/package.json',
        console: mockConsole,
        process: mockProcess,
        intro: noopIntro,
        outro: noopOutro,
        spinner: noopSpinner,
      });

      // Verify filter excludes non-selected resources
      expect(cpSyncFilter).not.toBeNull();
      expect(cpSyncFilter!('/template/src/resources/carousel')).toBe(true);
      expect(cpSyncFilter!('/template/src/resources/review')).toBe(false);
      expect(cpSyncFilter!('/template/src/resources/map')).toBe(false);

      // Verify filter excludes flat simulation files for non-selected resources
      expect(cpSyncFilter!('/template/tests/simulations/show-carousel.json')).toBe(true);
      expect(cpSyncFilter!('/template/tests/simulations/review-diff.json')).toBe(false);
      expect(cpSyncFilter!('/template/tests/simulations/show-map.json')).toBe(false);

      // Verify filter excludes e2e tests for non-selected resources
      expect(cpSyncFilter!('/template/tests/e2e/carousel.spec.ts')).toBe(true);
      expect(cpSyncFilter!('/template/tests/e2e/review.spec.ts')).toBe(false);
      expect(cpSyncFilter!('/template/tests/e2e/map.spec.ts')).toBe(false);

      // Verify filter always excludes node_modules and lock file
      expect(cpSyncFilter!('/template/node_modules')).toBe(false);
      expect(cpSyncFilter!('/template/pnpm-lock.yaml')).toBe(false);

      // Verify package.json was updated
      expect(writtenPkg).not.toBeNull();
      expect(writtenPkg!.name).toBe('my-project');
      expect(writtenPkg!.dependencies?.sunpeak).toBe('^1.0.0');

      // Verify dotfiles were renamed
      expect(renamedFiles).toContainEqual({
        from: path.join('/test/my-project', '_gitignore'),
        to: path.join('/test/my-project', '.gitignore'),
      });

      // Verify outro was called
      expect(noopOutro).toHaveBeenCalled();
    });

    it('should skip dependency install when requested', async () => {
      const { init } = await importNew();
      const execAsync = vi.fn();

      await init('my-project', 'carousel', {
        discoverResources: () => ['carousel'],
        detectPackageManager: () => 'pnpm',
        existsSync: () => false,
        mkdirSync: vi.fn(),
        cpSync: vi.fn(),
        readFileSync: () =>
          JSON.stringify({ version: '1.0.0', dependencies: { sunpeak: 'workspace:*' } }),
        writeFileSync: vi.fn(),
        renameSync: vi.fn(),
        execSync: vi.fn(),
        execAsync,
        skipInstall: true,
        confirm: noopConfirm,
        cwd: () => '/test',
        templateDir: '/template',
        rootPkgPath: '/root/package.json',
        console: createMockConsole(),
        process: createMockProcess(),
        intro: noopIntro,
        outro: noopOutro,
        spinner: noopSpinner,
      });

      expect(execAsync).not.toHaveBeenCalled();
    });

    it('should include all resources when empty string passed as arg', async () => {
      const { init } = await importNew();
      const mockConsole = createMockConsole();
      const mockProcess = createMockProcess();

      let cpSyncFilter: ((src: string) => boolean) | null = null;

      await init('my-project', '', {
        discoverResources: () => ['carousel', 'review'],
        detectPackageManager: () => 'npm',
        existsSync: () => false,
        mkdirSync: vi.fn(),
        cpSync: (_src: string, _dest: string, options: { filter: (src: string) => boolean }) => {
          cpSyncFilter = options.filter;
        },
        readFileSync: () => JSON.stringify({ version: '1.0.0', name: 'test' }),
        writeFileSync: vi.fn(),
        renameSync: vi.fn(),
        execSync: vi.fn(),
        execAsync: noopExecAsync,
        confirm: noopConfirm,
        cwd: () => '/test',
        templateDir: '/template',
        rootPkgPath: '/root/package.json',
        console: mockConsole,
        process: mockProcess,
        intro: noopIntro,
        outro: noopOutro,
        spinner: noopSpinner,
      });

      // All resources should be included
      expect(cpSyncFilter).not.toBeNull();
      expect(cpSyncFilter!('/template/src/resources/carousel')).toBe(true);
      expect(cpSyncFilter!('/template/src/resources/review')).toBe(true);
    });
  });

  describe('parseResourcesInput', () => {
    it('should return all resources when input is empty', async () => {
      const { parseResourcesInput } = await importNew();

      const result = parseResourcesInput('', ['carousel', 'review', 'map']);
      expect(result).toEqual(['carousel', 'review', 'map']);
    });

    it('should parse comma-separated resources', async () => {
      const { parseResourcesInput } = await importNew();

      const result = parseResourcesInput('carousel,review', ['carousel', 'review', 'map']);
      expect(result).toEqual(['carousel', 'review']);
    });

    it('should parse space-separated resources', async () => {
      const { parseResourcesInput } = await importNew();

      const result = parseResourcesInput('carousel review', ['carousel', 'review', 'map']);
      expect(result).toEqual(['carousel', 'review']);
    });

    it('should handle mixed separators', async () => {
      const { parseResourcesInput } = await importNew();

      const result = parseResourcesInput('carousel, review map', ['carousel', 'review', 'map']);
      expect(result).toEqual(['carousel', 'review', 'map']);
    });

    it('should deduplicate resources', async () => {
      const { parseResourcesInput } = await importNew();

      const result = parseResourcesInput('carousel,carousel,review', ['carousel', 'review', 'map']);
      expect(result).toEqual(['carousel', 'review']);
    });

    it('should be case-insensitive', async () => {
      const { parseResourcesInput } = await importNew();

      const result = parseResourcesInput('CAROUSEL,Review', ['carousel', 'review', 'map']);
      expect(result).toEqual(['carousel', 'review']);
    });

    it('should error on invalid resources', async () => {
      const { parseResourcesInput } = await importNew();
      const mockConsole = createMockConsole();
      const mockProcess = createMockProcess();

      parseResourcesInput('carousel,invalid', ['carousel', 'review'], {
        console: mockConsole,
        process: mockProcess,
      });

      expect(mockConsole.error).toHaveBeenCalledWith('Error: Invalid resource(s): invalid');
      expect(mockProcess.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('upgrade command', () => {
    it('should show help when requested', async () => {
      const { upgrade } = await importUpgrade();
      const mockConsole = createMockConsole();

      await upgrade(
        { help: true },
        {
          console: mockConsole,
        }
      );

      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('sunpeak upgrade'));
      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('--check'));
    });

    it('should report when already on latest version', async () => {
      const { upgrade } = await importUpgrade();
      const mockConsole = createMockConsole();

      await upgrade(
        {},
        {
          getCurrentVersion: () => '1.0.0',
          fetchLatestVersion: async () => '1.0.0',
          console: mockConsole,
        }
      );

      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining('already on the latest version')
      );
    });

    it('should report when newer version is available with --check', async () => {
      const { upgrade } = await importUpgrade();
      const mockConsole = createMockConsole();

      await upgrade(
        { check: true },
        {
          getCurrentVersion: () => '1.0.0',
          fetchLatestVersion: async () => '2.0.0',
          console: mockConsole,
        }
      );

      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining('New version available')
      );
      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('2.0.0'));
      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining('Run "sunpeak upgrade" to upgrade')
      );
    });

    it('should upgrade when newer version is available', async () => {
      const { upgrade } = await importUpgrade();
      const mockConsole = createMockConsole();
      let upgradeRan = false;

      await upgrade(
        {},
        {
          getCurrentVersion: () => '1.0.0',
          fetchLatestVersion: async () => '2.0.0',
          detectPackageManager: () => 'npm',
          runUpgrade: async () => {
            upgradeRan = true;
          },
          console: mockConsole,
        }
      );

      expect(upgradeRan).toBe(true);
      expect(mockConsole.log).toHaveBeenCalledWith(
        expect.stringContaining('Successfully upgraded')
      );
    });

    it('should handle upgrade failure gracefully', async () => {
      const { upgrade } = await importUpgrade();
      const mockConsole = createMockConsole();
      const mockProcess = createMockProcess();

      await upgrade(
        {},
        {
          getCurrentVersion: () => '1.0.0',
          fetchLatestVersion: async () => '2.0.0',
          detectPackageManager: () => 'npm',
          runUpgrade: async () => {
            throw new Error('Network error');
          },
          console: mockConsole,
          process: mockProcess,
        }
      );

      expect(mockConsole.error).toHaveBeenCalledWith(expect.stringContaining('Error upgrading'));
      expect(mockConsole.log).toHaveBeenCalledWith(expect.stringContaining('manually upgrade'));
      expect(mockProcess.exit).toHaveBeenCalledWith(1);
    });

    it('should handle fetch error gracefully', async () => {
      const { upgrade } = await importUpgrade();
      const mockConsole = createMockConsole();
      const mockProcess = createMockProcess();

      await upgrade(
        {},
        {
          getCurrentVersion: () => '1.0.0',
          fetchLatestVersion: async () => {
            throw new Error('Failed to fetch');
          },
          console: mockConsole,
          process: mockProcess,
        }
      );

      expect(mockConsole.error).toHaveBeenCalledWith(
        expect.stringContaining('Error checking for updates')
      );
      expect(mockProcess.exit).toHaveBeenCalledWith(1);
    });
  });

  describe('compareVersions', () => {
    it('should correctly compare semver versions', async () => {
      const { compareVersions } = await importUpgrade();

      expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
      expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
      expect(compareVersions('2.0.0', '1.0.0')).toBe(1);
      expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
      expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
      expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
      expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    });
  });

  describe('test init command', () => {
    const noopLog = {
      info: vi.fn(),
      success: vi.fn(),
      step: vi.fn(),
      message: vi.fn(),
      warn: vi.fn(),
    };

    const createTestInitDeps = (overrides = {}) => ({
      existsSync: () => false,
      readFileSync: () => '{}',
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      execSync: vi.fn(),
      cwd: () => '/test/project',
      isTTY: () => true,
      intro: vi.fn(),
      outro: vi.fn(),
      confirm: vi.fn().mockResolvedValue(false),
      isCancel: () => false,
      select: vi.fn().mockResolvedValue('later'),
      text: vi.fn().mockResolvedValue(''),
      selectProviders: vi.fn().mockResolvedValue([]),
      password: vi.fn().mockResolvedValue(''),
      detectPackageManager: () => 'pnpm',
      log: noopLog,
      ...overrides,
    });

    it('should prompt to install test-mcp-server skill', async () => {
      const { testInit } = await importTestInit();
      const confirmMock = vi.fn().mockResolvedValue(false);

      await testInit([], createTestInitDeps({ confirm: confirmMock }));

      // The skill install confirm should be called (it's the only confirm in the flow for external projects)
      expect(confirmMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Install the test-mcp-server skill? (helps your coding agent write tests)',
        })
      );
    });

    it('should run pnpm dlx skills add when user confirms skill install', async () => {
      const { testInit } = await importTestInit();
      const execSyncMock = vi.fn();

      await testInit(
        [],
        createTestInitDeps({
          confirm: vi.fn().mockResolvedValue(true),
          execSync: execSyncMock,
        })
      );

      expect(execSyncMock).toHaveBeenCalledWith(
        'pnpm dlx skills add Alignbase/sunpeak@test-mcp-server',
        expect.objectContaining({ cwd: '/test/project', stdio: 'inherit' })
      );
    });

    it('should not run pnpm dlx skills add when user declines', async () => {
      const { testInit } = await importTestInit();
      const execSyncMock = vi.fn();

      await testInit(
        [],
        createTestInitDeps({
          confirm: vi.fn().mockResolvedValue(false),
          execSync: execSyncMock,
        })
      );

      expect(execSyncMock).not.toHaveBeenCalledWith(
        'pnpm dlx skills add Alignbase/sunpeak@test-mcp-server',
        expect.anything()
      );
    });

    it('should handle skill install failure gracefully', async () => {
      const { testInit } = await importTestInit();
      const logInfoMock = vi.fn();
      const execSyncMock = vi.fn().mockImplementation(() => {
        throw new Error('pnpm not found');
      });

      await testInit(
        [],
        createTestInitDeps({
          confirm: vi.fn().mockResolvedValue(true),
          execSync: execSyncMock,
          log: { ...noopLog, info: logInfoMock },
        })
      );

      expect(logInfoMock).toHaveBeenCalledWith(
        'Skill install skipped. Install later: pnpm dlx skills add Alignbase/sunpeak@test-mcp-server'
      );
    });

    it('should skip interactive prompts without a TTY', async () => {
      const { testInit } = await importTestInit();
      const confirmMock = vi.fn().mockResolvedValue(true);
      const selectProvidersMock = vi.fn().mockResolvedValue([]);
      const selectMock = vi.fn().mockResolvedValue('later');
      const writeFileSync = vi.fn();

      await testInit(
        [],
        createTestInitDeps({
          isTTY: () => false,
          confirm: confirmMock,
          selectProviders: selectProvidersMock,
          select: selectMock,
          writeFileSync,
        })
      );

      // Server config prompt, eval providers, and skill install should all be skipped
      expect(selectMock).not.toHaveBeenCalled();
      expect(selectProvidersMock).not.toHaveBeenCalled();
      expect(confirmMock).not.toHaveBeenCalled();

      // But the scaffold should still be created (with "configure later" default)
      const configCall = writeFileSync.mock.calls.find(([path]: [string]) =>
        path.includes('playwright.config.ts')
      );
      expect(configCall).toBeDefined();
      expect(configCall[1]).toContain('// TODO: Configure your MCP server');
    });

    it('should detect sunpeak project type', async () => {
      const { testInit } = await importTestInit();
      const writeFileSync = vi.fn();

      await testInit(
        [],
        createTestInitDeps({
          existsSync: (path: string) => path.includes('package.json') || false,
          readFileSync: (path: string) => {
            if (path.includes('package.json')) {
              return JSON.stringify({ dependencies: { sunpeak: '*' } });
            }
            return '{}';
          },
          writeFileSync,
        })
      );

      // For sunpeak projects, it writes playwright.config.ts with defineConfig()
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('playwright.config.ts'),
        expect.stringContaining('defineConfig()')
      );
    });

    it('should warn when sunpeak project has non-sunpeak playwright config', async () => {
      const { testInit } = await importTestInit();
      const logWarnMock = vi.fn();
      const logMessageMock = vi.fn();

      await testInit(
        [],
        createTestInitDeps({
          existsSync: (path: string) =>
            path.includes('package.json') || path.includes('playwright.config.ts'),
          readFileSync: (path: string) => {
            if (path.includes('package.json')) {
              return JSON.stringify({ dependencies: { sunpeak: '*' } });
            }
            // Config exists but uses raw @playwright/test, not sunpeak
            return "import { defineConfig } from '@playwright/test';";
          },
          log: { ...noopLog, warn: logWarnMock, message: logMessageMock },
        })
      );

      expect(logWarnMock).toHaveBeenCalledWith(
        expect.stringContaining('does not use sunpeak/test/config')
      );
      expect(logMessageMock).toHaveBeenCalledWith(expect.stringContaining('defineConfig'));
    });

    it('should detect JS project type and use CLI server arg', async () => {
      const { testInit } = await importTestInit();
      const writeFileSync = vi.fn();

      await testInit(
        ['--server', 'http://localhost:9000/mcp'],
        createTestInitDeps({
          existsSync: (path: string) => path.includes('package.json') || false,
          readFileSync: () => JSON.stringify({ dependencies: { express: '*' } }),
          writeFileSync,
        })
      );

      // For JS projects with URL server, writes config with server URL
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('playwright.config.ts'),
        expect.stringContaining('http://localhost:9000/mcp')
      );
    });

    /** Extract written file content. Pass enough trailing path to be unique. */
    function getWrittenContent(
      mock: ReturnType<typeof vi.fn>,
      pathSuffix: string
    ): string | undefined {
      const call = mock.mock.calls.find((c: [string, string]) =>
        (c[0] as string).replace(/\\/g, '/').endsWith(pathSuffix)
      );
      return call ? (call[1] as string) : undefined;
    }

    it('should scaffold e2e, visual, live, and eval tests for external projects', async () => {
      const { testInit } = await importTestInit();
      const writeFileSync = vi.fn();
      const mkdirSync = vi.fn();

      await testInit(
        ['--server', 'http://localhost:8000/mcp'],
        createTestInitDeps({
          writeFileSync,
          mkdirSync,
        })
      );

      const writtenPaths = writeFileSync.mock.calls.map((c: [string, string]) =>
        (c[0] as string).replace(/\\/g, '/')
      );

      // All expected files
      expect(writtenPaths).toContainEqual(expect.stringContaining('smoke.test.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('visual.test.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('live/playwright.config.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('live/example.test.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('evals/eval.config.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('evals/example.eval.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('package.json'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('tsconfig.json'));

      // No unit tests for external projects (server is in another language)
      expect(writtenPaths).not.toContainEqual(expect.stringContaining('unit/'));

      // Server URL flows through to root config (not live/playwright.config.ts)
      const config = getWrittenContent(writeFileSync, 'sunpeak/playwright.config.ts');
      expect(config).toContain('http://localhost:8000/mcp');
      expect(config).toContain("from 'sunpeak/test/config'");

      // Eval config has server URL
      const evalConfig = getWrittenContent(writeFileSync, 'evals/eval.config.ts');
      expect(evalConfig).toContain('http://localhost:8000/mcp');

      // Live config has server option for non-sunpeak projects
      const liveConfig = getWrittenContent(writeFileSync, 'live/playwright.config.ts');
      expect(liveConfig).toContain('server: { url: "http://localhost:8000/mcp" }');
      expect(liveConfig).toContain("from 'sunpeak/test/live/config'");
    });

    it('should scaffold 4 test types for JS projects (no unit tests)', async () => {
      const { testInit } = await importTestInit();
      const writeFileSync = vi.fn();

      await testInit(
        ['--server', 'http://localhost:8000/mcp'],
        createTestInitDeps({
          existsSync: (path: string) => path.includes('package.json') || false,
          readFileSync: () => JSON.stringify({ dependencies: { express: '*' } }),
          writeFileSync,
        })
      );

      const writtenPaths = writeFileSync.mock.calls.map((c: [string, string]) =>
        (c[0] as string).replace(/\\/g, '/')
      );

      // 4 test types (no unit tests — those are app-framework-only)
      expect(writtenPaths).toContainEqual(expect.stringContaining('e2e/smoke.test.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('e2e/visual.test.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('live/playwright.config.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('live/example.test.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('evals/eval.config.ts'));
      expect(writtenPaths).not.toContainEqual(expect.stringContaining('unit/example.test.ts'));
      expect(writtenPaths).not.toContainEqual(expect.stringContaining('vitest.config.ts'));

      // Verify correct imports
      const smoke = getWrittenContent(writeFileSync, 'e2e/smoke.test.ts');
      expect(smoke).toContain("from 'sunpeak/test'");

      const visual = getWrittenContent(writeFileSync, 'e2e/visual.test.ts');
      expect(visual).toContain("from 'sunpeak/test'");
      expect(visual).toContain('result.screenshot');

      const liveTest = getWrittenContent(writeFileSync, 'live/example.test.ts');
      expect(liveTest).toContain("from 'sunpeak/test/live'");
      expect(liveTest).toContain('live.invoke');

      const evalTest = getWrittenContent(writeFileSync, 'evals/example.eval.ts');
      expect(evalTest).toContain("from 'sunpeak/eval'");
      expect(evalTest).toContain('defineEval');

      // Sets "type": "module" in package.json
      const pkgJson = getWrittenContent(writeFileSync, 'package.json');
      expect(JSON.parse(pkgJson).type).toBe('module');
    });

    it('should scaffold all test types for sunpeak projects without NOTE in live config', async () => {
      const { testInit } = await importTestInit();
      const writeFileSync = vi.fn();

      await testInit(
        [],
        createTestInitDeps({
          existsSync: (path: string) => path.includes('package.json') || false,
          readFileSync: (path: string) => {
            if (path.includes('package.json')) {
              return JSON.stringify({ dependencies: { sunpeak: '*' } });
            }
            return '{}';
          },
          writeFileSync,
        })
      );

      const writtenPaths = writeFileSync.mock.calls.map((c: [string, string]) =>
        (c[0] as string).replace(/\\/g, '/')
      );

      // All test types (no unit tests — those come from sunpeak new)
      expect(writtenPaths).toContainEqual(expect.stringContaining('playwright.config.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('visual.test.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('live/playwright.config.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('evals/eval.config.ts'));
      expect(writtenPaths).not.toContainEqual(expect.stringContaining('unit/example.test.ts'));

      // Config uses defineConfig() with no args (root config, not live/)
      const config = getWrittenContent(writeFileSync, 'project/playwright.config.ts');
      expect(config).toContain('defineConfig()');

      // Live config should NOT have server option (this IS a sunpeak project)
      const liveConfig = getWrittenContent(writeFileSync, 'live/playwright.config.ts');
      expect(liveConfig).not.toContain('server:');

      // Eval config has sunpeak-specific comment
      const evalConfig = getWrittenContent(writeFileSync, 'evals/eval.config.ts');
      expect(evalConfig).toContain('Omit server for sunpeak projects');
    });

    it('should skip existing files without overwriting', async () => {
      const { testInit } = await importTestInit();
      const writeFileSync = vi.fn();

      await testInit(
        ['--server', 'http://localhost:8000/mcp'],
        createTestInitDeps({
          existsSync: (p: string) => {
            const normalized = p.replace(/\\/g, '/');
            if (normalized.includes('package.json')) return true;
            if (normalized.includes('visual.test.ts')) return true;
            if (normalized.includes('live/playwright.config.ts')) return true;
            return false;
          },
          readFileSync: () => JSON.stringify({ dependencies: { express: '*' } }),
          writeFileSync,
        })
      );

      const writtenPaths = writeFileSync.mock.calls.map((c: [string, string]) =>
        (c[0] as string).replace(/\\/g, '/')
      );

      // Should NOT have written visual or live config (they already exist)
      expect(writtenPaths).not.toContainEqual(expect.stringContaining('visual.test.ts'));
      expect(writtenPaths).not.toContainEqual(expect.stringContaining('live/playwright.config.ts'));
      expect(writtenPaths).not.toContainEqual(expect.stringContaining('live/example.test.ts'));

      // Should still have written smoke test and evals (they don't exist in the mock)
      expect(writtenPaths).toContainEqual(expect.stringContaining('smoke.test.ts'));
      expect(writtenPaths).toContainEqual(expect.stringContaining('evals/eval.config.ts'));
    });

    it('should parse command-based server into command and args', async () => {
      const { testInit } = await importTestInit();
      const writeFileSync = vi.fn();

      await testInit(['--server', 'python src/server.py'], createTestInitDeps({ writeFileSync }));

      const config = getWrittenContent(writeFileSync, 'sunpeak/playwright.config.ts');
      expect(config).toContain('command: "python"');
      expect(config).toContain('"src/server.py"');
    });

    it('should not scaffold test bodies that would fail on missing tools', async () => {
      const { testInit } = await importTestInit();
      const writeFileSync = vi.fn();

      await testInit(
        ['--server', 'http://localhost:8000/mcp'],
        createTestInitDeps({
          existsSync: (path: string) => path.includes('package.json') || false,
          readFileSync: () => JSON.stringify({ dependencies: { express: '*' } }),
          writeFileSync,
        })
      );

      // Visual test: all callTool/screenshot lines should be commented
      const visual = getWrittenContent(writeFileSync, 'visual.test.ts');
      expect(visual).toBeDefined();
      // Should not have uncommented callTool (which would crash on 'your-tool')
      const uncommentedLines = visual!
        .split('\n')
        .filter(
          (l) =>
            !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')
        );
      expect(uncommentedLines.join('\n')).not.toContain('callTool');
      expect(uncommentedLines.join('\n')).not.toContain('screenshot');

      // Live test: invoke should be commented
      const liveTest = getWrittenContent(writeFileSync, 'live/example.test.ts');
      expect(liveTest).toBeDefined();
      const liveUncommented = liveTest!
        .split('\n')
        .filter(
          (l) =>
            !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')
        );
      expect(liveUncommented.join('\n')).not.toContain('live.invoke');

      // Unit tests are not scaffolded for standalone testing framework
      const writtenPaths = writeFileSync.mock.calls.map((c: [string, string]) =>
        (c[0] as string).replace(/\\/g, '/')
      );
      expect(writtenPaths).not.toContainEqual(expect.stringContaining('unit/'));
    });

    it('should include multi-language hints in "configure later" config', async () => {
      const { testInit } = await importTestInit();
      const writeFileSync = vi.fn();

      await testInit([], createTestInitDeps({ writeFileSync }));

      const config = getWrittenContent(writeFileSync, 'sunpeak/playwright.config.ts');
      expect(config).toBeDefined();
      // Should contain TODO and language-specific examples
      expect(config).toContain('TODO: Configure your MCP server');
      expect(config).toContain('Python (uv)');
      expect(config).toContain('Python (venv)');
      expect(config).toContain('Go:');
      expect(config).toContain('Node.js:');
      expect(config).toContain('HTTP server');
    });

    it('should warn when server is "configure later" for external projects', async () => {
      const { testInit } = await importTestInit();
      const logWarnMock = vi.fn();

      await testInit(
        [],
        createTestInitDeps({
          log: { ...noopLog, warn: logWarnMock },
        })
      );

      expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining('Server not configured'));
    });

    it('should warn when server is "configure later" for JS projects', async () => {
      const { testInit } = await importTestInit();
      const logWarnMock = vi.fn();

      await testInit(
        [],
        createTestInitDeps({
          existsSync: (path: string) => path.includes('package.json') || false,
          readFileSync: () => JSON.stringify({ dependencies: { express: '*' } }),
          log: { ...noopLog, warn: logWarnMock },
        })
      );

      expect(logWarnMock).toHaveBeenCalledWith(expect.stringContaining('Server not configured'));
    });

    it('should show run commands in external project next steps', async () => {
      const { testInit } = await importTestInit();
      const logMessageMock = vi.fn();

      await testInit(
        ['--server', 'http://localhost:8000/mcp'],
        createTestInitDeps({
          log: { ...noopLog, message: logMessageMock },
        })
      );

      expect(logMessageMock).toHaveBeenCalledWith(expect.stringContaining('sunpeak test'));
    });
  });

  describe('version command', () => {
    it('should output a valid semver version', async () => {
      const { execSync } = await import('child_process');
      const { join } = await import('path');
      const cliPath = join(process.cwd(), 'bin/sunpeak.js');

      const output = execSync(`node ${cliPath} version`, { encoding: 'utf-8' }).trim();

      // Should be a valid semver version (e.g., "0.9.3")
      expect(output).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('should output same version with --version flag', async () => {
      const { execSync } = await import('child_process');
      const { join } = await import('path');
      const cliPath = join(process.cwd(), 'bin/sunpeak.js');

      const versionOutput = execSync(`node ${cliPath} version`, { encoding: 'utf-8' }).trim();
      const flagOutput = execSync(`node ${cliPath} --version`, { encoding: 'utf-8' }).trim();
      const shortFlagOutput = execSync(`node ${cliPath} -v`, { encoding: 'utf-8' }).trim();

      expect(versionOutput).toBe(flagOutput);
      expect(versionOutput).toBe(shortFlagOutput);
    });

    it('should match version in package.json', async () => {
      const { execSync } = await import('child_process');
      const { join } = await import('path');
      const { readFileSync } = await import('fs');
      const cliPath = join(process.cwd(), 'bin/sunpeak.js');
      const pkgPath = join(process.cwd(), 'package.json');

      const output = execSync(`node ${cliPath} version`, { encoding: 'utf-8' }).trim();
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

      expect(output).toBe(pkg.version);
    });
  });

  describe('docs navigation', () => {
    it('testing/getting-started should be in docs.json and the file should exist', async () => {
      const { readFileSync, existsSync } = await import('fs');
      const { join } = await import('path');

      // Check docs.json includes the page
      const docsJsonPath = join(process.cwd(), '../../docs/docs.json');
      const docsJson = JSON.parse(readFileSync(docsJsonPath, 'utf-8'));
      const testingTab = docsJson.navigation.tabs.find(
        (t: { tab: string }) => t.tab === 'MCP Testing Framework'
      );
      const overviewGroup = testingTab.groups.find(
        (g: { group: string }) => g.group === 'Overview'
      );
      expect(overviewGroup.pages).toContain('testing/getting-started');

      // Check the file exists
      const filePath = join(process.cwd(), '../../docs/testing/getting-started.mdx');
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe('eval providers sync', () => {
    it('template eval.config.ts model lines should match eval-providers.mjs', async () => {
      const { readFileSync } = await import('fs');
      const { join } = await import('path');
      const { generateModelLines } = await import('../../bin/lib/eval/eval-providers.mjs');

      const templatePath = join(process.cwd(), 'template/tests/evals/eval.config.ts');
      const templateContent = readFileSync(templatePath, 'utf-8');

      // Extract model lines from template (between "// Uncomment models" and "]")
      const modelSection = templateContent.match(/\/\/ Uncomment models.*\n([\s\S]*?)\n\s*\]/);
      expect(modelSection).not.toBeNull();
      const templateLines = modelSection![1].split('\n').map((l: string) => l.trimEnd());

      const generatedLines = generateModelLines();

      expect(templateLines).toEqual(generatedLines);
    });
  });

  describe('eval vitest config generation', () => {
    it('should import eval plugin and reporter from package exports, not absolute paths', async () => {
      const { readFileSync, existsSync } = await import('fs');
      const { join } = await import('path');

      // The generated vitest config must use package imports (sunpeak/eval/plugin)
      // not absolute paths, so vitest resolves from the project's node_modules.
      // We can't easily run runEvals, but we can check the package exports exist.
      const pkgPath = join(process.cwd(), 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      const exports = pkg.exports;

      expect(exports['./eval']).toBeDefined();
      expect(exports['./eval/plugin']).toBeDefined();
      expect(exports['./eval/reporter']).toBeDefined();

      // Verify the exported files exist
      const pluginPath = exports['./eval/plugin'].import;
      const reporterPath = exports['./eval/reporter'].import;
      expect(existsSync(join(process.cwd(), pluginPath))).toBe(true);
      expect(existsSync(join(process.cwd(), reporterPath))).toBe(true);
    });

    it('eval vitest plugin should import from sunpeak/eval, not absolute paths', async () => {
      const { readFileSync } = await import('fs');
      const { join } = await import('path');

      const pluginSource = readFileSync(
        join(process.cwd(), 'bin/lib/eval/eval-vitest-plugin.mjs'),
        'utf-8'
      );

      // The transformed code must import from 'sunpeak/eval' (package export)
      expect(pluginSource).toContain("from 'sunpeak/eval'");
      // Must NOT use resolveRunnerPath or absolute file paths for imports
      expect(pluginSource).not.toContain('resolveRunnerPath');
      expect(pluginSource).not.toContain('fileURLToPath');
    });
  });
});
