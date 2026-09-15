/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck - Eval modules are .mjs files without TypeScript declarations
import { describe, it, expect, vi } from 'vitest';
import { resolve } from 'node:path';

const importRunner = () => import('../../bin/lib/eval/eval-runner.mjs');
const importRegistry = () => import('../../bin/lib/eval/model-registry.mjs');
const importPlugin = () => import('../../bin/lib/eval/eval-vitest-plugin.mjs');

describe('MCP client options', () => {
  it('enables modern protocol negotiation with legacy fallback', async () => {
    const { getMcpClientOptions } = await import('../../bin/lib/mcp-client-options.mjs');

    expect(getMcpClientOptions('https://example.com/mcp')).toEqual({
      versionNegotiation: { mode: 'auto' },
    });
    expect(getMcpClientOptions('node server.mjs')).toEqual({
      versionNegotiation: { mode: 'auto', probe: { timeoutMs: 3_000 } },
    });
  });

  it('falls back promptly when a legacy stdio server ignores discovery', async () => {
    const { createMcpConnection } = await importRunner();
    const serverPath = resolve(process.cwd(), 'src/eval/fixtures/silent-legacy-stdio-server.mjs');
    const startedAt = Date.now();
    const { client } = await createMcpConnection(`${process.execPath} ${serverPath}`);

    expect(client.getServerVersion()).toMatchObject({ name: 'silent-legacy' });
    expect(Date.now() - startedAt).toBeLessThan(8_000);
    await client.close();
  }, 10_000);
});

describe('discoverAndConvertTools', () => {
  it.each([false, 0, '', null])('preserves falsy structured content: %j', async (value) => {
    const { discoverAndConvertTools } = await importRunner();
    const client = {
      listTools: vi.fn().mockResolvedValue({
        tools: [{ name: 'falsy-result', inputSchema: { type: 'object', properties: {} } }],
      }),
      callTool: vi.fn().mockResolvedValue({
        structuredContent: value,
        content: [{ type: 'text', text: 'fallback' }],
      }),
    };

    const tools = await discoverAndConvertTools(client);

    await expect(tools['falsy-result'].execute({})).resolves.toBe(value);
  });
});
const importReporter = () => import('../../bin/lib/eval/eval-reporter.mjs');

// ── checkExpectations ──────────────────────────────────────────────

describe('checkExpectations', () => {
  const makeResult = (toolCalls = []) => ({
    toolCalls,
    toolResults: [],
    text: '',
    steps: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    finishReason: 'stop',
  });

  it('passes when no expect or assert is defined', async () => {
    const { checkExpectations } = await importRunner();
    expect(() => checkExpectations(makeResult(), { name: 'test', prompt: 'hi' })).not.toThrow();
  });

  it('passes when tool name matches', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([{ name: 'show-albums', args: { category: 'food' } }]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'show-albums' },
      })
    ).not.toThrow();
  });

  it('fails when tool name does not match', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([{ name: 'get-photos', args: {} }]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'show-albums' },
      })
    ).toThrow('expected tool "show-albums", got "get-photos"');
  });

  it('fails when no tool calls but one expected', async () => {
    const { checkExpectations } = await importRunner();
    expect(() =>
      checkExpectations(makeResult([]), {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'show-albums' },
      })
    ).toThrow('Expected 1 tool call(s), but got 0');
  });

  it('passes with partial args match', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([
      { name: 'show-albums', args: { category: 'food', search: 'pizza', limit: 10 } },
    ]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'show-albums', args: { category: 'food' } },
      })
    ).not.toThrow();
  });

  it('fails when expected arg value does not match', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([{ name: 'show-albums', args: { category: 'travel' } }]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'show-albums', args: { category: 'food' } },
      })
    ).toThrow('expected "food", got "travel"');
  });

  it('passes with ordered multi-step expectations', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([
      { name: 'review-post', args: {} },
      { name: 'publish-post', args: {} },
    ]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: [{ tool: 'review-post' }, { tool: 'publish-post' }],
      })
    ).not.toThrow();
  });

  it('fails when multi-step order is wrong', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([
      { name: 'publish-post', args: {} },
      { name: 'review-post', args: {} },
    ]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: [{ tool: 'review-post' }, { tool: 'publish-post' }],
      })
    ).toThrow('Step 1: expected tool "review-post", got "publish-post"');
  });

  it('fails when too few tool calls for multi-step', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([{ name: 'review-post', args: {} }]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: [{ tool: 'review-post' }, { tool: 'publish-post' }],
      })
    ).toThrow('Expected 2 tool call(s), but got 1');
  });

  it('allows extra tool calls beyond expectations', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([
      { name: 'review-post', args: {} },
      { name: 'publish-post', args: {} },
      { name: 'notify', args: {} },
    ]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: [{ tool: 'review-post' }, { tool: 'publish-post' }],
      })
    ).not.toThrow();
  });

  it('uses custom assert function', async () => {
    const { checkExpectations } = await importRunner();
    const assertFn = vi.fn();
    const result = makeResult([{ name: 'foo', args: {} }]);
    checkExpectations(result, {
      name: 'test',
      prompt: 'hi',
      assert: assertFn,
    });
    expect(assertFn).toHaveBeenCalledWith(result);
  });

  it('custom assert takes precedence over expect', async () => {
    const { checkExpectations } = await importRunner();
    const assertFn = vi.fn();
    const result = makeResult([{ name: 'wrong-tool', args: {} }]);
    // assert is called, expect is ignored even though tool name wouldn't match
    checkExpectations(result, {
      name: 'test',
      prompt: 'hi',
      expect: { tool: 'right-tool' },
      assert: assertFn,
    });
    expect(assertFn).toHaveBeenCalled();
  });

  it('handles nested object args matching', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([
      { name: 'search', args: { filter: { type: 'photo', tags: ['vacation'] }, limit: 10 } },
    ]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'search', args: { filter: { type: 'photo' } } },
      })
    ).not.toThrow();
  });

  it('fails on nested object mismatch', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([{ name: 'search', args: { filter: { type: 'video' } } }]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'search', args: { filter: { type: 'photo' } } },
      })
    ).toThrow('expected "photo", got "video"');
  });

  it('handles array args matching', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([
      { name: 'post', args: { platforms: ['x', 'linkedin', 'threads'] } },
    ]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'post', args: { platforms: ['x', 'linkedin'] } },
      })
    ).not.toThrow();
  });

  it('fails when expected array element does not match', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([{ name: 'post', args: { platforms: ['x', 'facebook'] } }]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'post', args: { platforms: ['x', 'linkedin'] } },
      })
    ).toThrow('expected "linkedin", got "facebook"');
  });

  it('fails when actual array is too short', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([{ name: 'post', args: { platforms: ['x'] } }]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'post', args: { platforms: ['x', 'linkedin'] } },
      })
    ).toThrow('array only has 1 elements');
  });

  it('fails when expected array but got non-array', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([{ name: 'post', args: { platforms: 'x' } }]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'post', args: { platforms: ['x'] } },
      })
    ).toThrow('expected array, got "x"');
  });

  it('handles missing arg key in actual', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([{ name: 'show-albums', args: {} }]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: { tool: 'show-albums', args: { category: 'food' } },
      })
    ).toThrow('expected "food", got undefined');
  });

  it('supports asymmetric matchers', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([{ name: 'show-albums', args: { category: 'food and drinks' } }]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: {
          tool: 'show-albums',
          args: { category: expect.stringContaining('food') },
        },
      })
    ).not.toThrow();
  });

  it('fails when asymmetric matcher does not match', async () => {
    const { checkExpectations } = await importRunner();
    const result = makeResult([{ name: 'show-albums', args: { category: 'travel' } }]);
    expect(() =>
      checkExpectations(result, {
        name: 'test',
        prompt: 'hi',
        expect: {
          tool: 'show-albums',
          args: { category: expect.stringContaining('food') },
        },
      })
    ).toThrow();
  });
});

// ── defineEval / defineEvalConfig ──────────────────────────────────

describe('defineEval / defineEvalConfig', () => {
  it('returns the spec unchanged', async () => {
    const { defineEval } = await importRunner();
    const spec = { cases: [{ name: 'a', prompt: 'b', expect: { tool: 'c' } }] };
    expect(defineEval(spec)).toBe(spec);
  });

  it('returns the config unchanged', async () => {
    const { defineEvalConfig } = await importRunner();
    const config = { models: ['gpt-4o'], defaults: { runs: 5 } };
    expect(defineEvalConfig(config)).toBe(config);
  });
});

// ── App Context ────────────────────────────────────────────────────

describe('eval appContext', () => {
  it('normalizes structured app context for model-visible state', async () => {
    const { normalizeEvalAppContext } = await importRunner();
    expect(
      normalizeEvalAppContext({
        content: [],
        structuredContent: { selectedFlight: { carrier: 'delta', flightNumber: 'DL123' } },
      })
    ).toEqual({
      structuredContent: { selectedFlight: { carrier: 'delta', flightNumber: 'DL123' } },
    });
  });

  it('keeps non-empty content blocks in app context', async () => {
    const { normalizeEvalAppContext } = await importRunner();
    expect(
      normalizeEvalAppContext({
        content: [{ type: 'text', text: 'Viewing Delta flight DL123' }],
      })
    ).toEqual({
      content: [{ type: 'text', text: 'Viewing Delta flight DL123' }],
    });
  });

  it('ignores empty app context', async () => {
    const { normalizeEvalAppContext, formatEvalAppContextForModel } = await importRunner();
    expect(normalizeEvalAppContext({ content: [] })).toBeUndefined();
    expect(formatEvalAppContextForModel(null)).toBeUndefined();
  });

  it('formats app context as a system prompt fragment', async () => {
    const { formatEvalAppContextForModel } = await importRunner();
    const formatted = formatEvalAppContextForModel({
      structuredContent: { selectedFlight: { carrier: 'delta' } },
    });

    expect(formatted).toContain('Shared MCP App context');
    expect(formatted).toContain('"carrier":"delta"');
  });

  it('truncates large app context before sending it to the model', async () => {
    const { formatEvalAppContextForModel } = await importRunner();
    const formatted = formatEvalAppContextForModel({
      structuredContent: { text: 'x'.repeat(25_000) },
    });

    expect(formatted?.length).toBeLessThan(21_000);
    expect(formatted?.endsWith('...')).toBe(true);
  });

  it('passes app context to the AI SDK system prompt', async () => {
    const generateText = vi.fn().mockResolvedValue({
      steps: [],
      text: '',
      usage: {},
      finishReason: 'stop',
    });
    vi.doMock('ai', () => ({ generateText }));

    try {
      const { runSingleEval } = await importRunner();
      await runSingleEval({
        prompt: 'Book this one',
        model: 'model',
        tools: {},
        maxSteps: 1,
        temperature: 0,
        timeout: 1000,
        appContext: {
          structuredContent: { selectedFlight: { carrier: 'delta' } },
        },
      });

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Book this one',
          system: expect.stringContaining('"carrier":"delta"'),
        })
      );
    } finally {
      vi.doUnmock('ai');
    }
  });

  it('omits the AI SDK system prompt when app context is empty', async () => {
    const generateText = vi.fn().mockResolvedValue({
      steps: [],
      text: '',
      usage: {},
      finishReason: 'stop',
    });
    vi.doMock('ai', () => ({ generateText }));

    try {
      const { runSingleEval } = await importRunner();
      await runSingleEval({
        prompt: 'Show me albums',
        model: 'model',
        tools: {},
        maxSteps: 1,
        temperature: 0,
        timeout: 1000,
        appContext: { content: [] },
      });

      expect(generateText.mock.calls[0][0]).not.toHaveProperty('system');
    } finally {
      vi.doUnmock('ai');
    }
  });

  it('disables strict OpenAI tool schemas for arbitrary MCP schemas', async () => {
    const generateText = vi.fn().mockResolvedValue({
      steps: [],
      text: '',
      usage: {},
      finishReason: 'stop',
    });
    vi.doMock('ai', () => ({ generateText }));

    try {
      const { runSingleEval } = await importRunner();
      await runSingleEval({
        prompt: 'Show me albums',
        model: { provider: 'openai.chat', modelId: 'gpt-5.5' },
        tools: {},
        maxSteps: 1,
        temperature: 0,
        timeout: 1000,
        appContext: { content: [] },
      });

      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: { openai: { strictJsonSchema: false } },
        })
      );
    } finally {
      vi.doUnmock('ai');
    }
  });
});

// ── Model Registry ─────────────────────────────────────────────────

describe('model registry', () => {
  // resolveModel either returns a model (if the provider is installed) or
  // throws with the provider package name in the error message. Both outcomes
  // confirm the routing logic mapped the model ID to the right provider.

  it('routes gpt- models to openai', async () => {
    const mod = await importRegistry();
    const result = await mod.resolveModel('gpt-4o').catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toContain('@ai-sdk/openai');
    } else {
      expect(result).toHaveProperty('modelId', 'gpt-4o');
    }
  });

  it('disables OpenAI structured outputs for reasoning model tool schemas', async () => {
    const mod = await importRegistry();
    const result = await mod.resolveModel('gpt-5.5').catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toContain('@ai-sdk/openai');
    } else {
      expect(result).toHaveProperty('modelId', 'gpt-5.5');
      expect(result).toHaveProperty('provider', 'openai.chat');
    }
  });

  it('routes claude- models to anthropic', async () => {
    const mod = await importRegistry();
    const result = await mod.resolveModel('claude-sonnet-4-20250514').catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toContain('@ai-sdk/anthropic');
    } else {
      expect(result).toHaveProperty('modelId', 'claude-sonnet-4-20250514');
    }
  });

  it('routes gemini- models to google', async () => {
    const mod = await importRegistry();
    const result = await mod.resolveModel('gemini-2.0-flash').catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toContain('@ai-sdk/google');
    } else {
      expect(result).toHaveProperty('modelId', 'gemini-2.0-flash');
    }
  });

  it('routes o1- models to openai', async () => {
    const mod = await importRegistry();
    const result = await mod.resolveModel('o1-preview').catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toContain('@ai-sdk/openai');
    } else {
      expect(result).toHaveProperty('modelId', 'o1-preview');
    }
  });

  it('routes o3- models to openai', async () => {
    const mod = await importRegistry();
    const result = await mod.resolveModel('o3-mini').catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toContain('@ai-sdk/openai');
    } else {
      expect(result).toHaveProperty('modelId', 'o3-mini');
    }
  });

  it('routes o4- models to openai', async () => {
    const mod = await importRegistry();
    const result = await mod.resolveModel('o4-mini').catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toContain('@ai-sdk/openai');
    } else {
      expect(result).toHaveProperty('modelId', 'o4-mini');
    }
  });

  it('throws for unknown model prefix', async () => {
    const mod = await importRegistry();
    await expect(mod.resolveModel('llama-3')).rejects.toThrow('Unknown model: "llama-3"');
  });

  it('checkAiSdkInstalled succeeds or rejects with clear message', async () => {
    const mod = await importRegistry();
    const result = await mod
      .checkAiSdkInstalled()
      .then(() => 'ok')
      .catch((e: Error) => e);
    if (result instanceof Error) {
      expect(result.message).toContain('"ai" package is not installed');
    } else {
      expect(result).toBe('ok');
    }
  });
});

// ── Vitest Plugin ──────────────────────────────────────────────────

describe('evalVitestPlugin', () => {
  it('creates a plugin with the correct name', async () => {
    const { evalVitestPlugin } = await importPlugin();
    const plugin = evalVitestPlugin({
      server: 'http://localhost:8000/mcp',
      models: ['gpt-4o'],
      defaults: { runs: 5 },
    });
    expect(plugin.name).toBe('sunpeak-eval');
    expect(plugin.enforce).toBe('pre');
  });

  it('ignores non-eval files', async () => {
    const { evalVitestPlugin } = await importPlugin();
    const plugin = evalVitestPlugin({
      server: 'http://localhost:8000/mcp',
      models: [],
      defaults: {},
    });
    const result = plugin.transform('const x = 1;', '/path/to/regular.test.ts');
    expect(result).toBeNull();
  });

  it('transforms .eval.ts files', async () => {
    const { evalVitestPlugin } = await importPlugin();
    const plugin = evalVitestPlugin({
      server: 'http://localhost:8000/mcp',
      models: ['gpt-4o'],
      defaults: { runs: 3, maxSteps: 2 },
    });
    const result = plugin.transform('export default { cases: [] }', '/path/to/my-tool.eval.ts');
    expect(result).not.toBeNull();
    expect(result.code).toContain('describe');
    expect(result.code).toContain('beforeAll');
    expect(result.code).toContain('createMcpConnection');
    expect(result.code).toContain('"http://localhost:8000/mcp"');
    expect(result.code).toContain('"gpt-4o"');
    expect(result.code).toContain('checkAiSdkInstalled');
  });

  it('transforms .eval.js files', async () => {
    const { evalVitestPlugin } = await importPlugin();
    const plugin = evalVitestPlugin({
      server: 'http://localhost:8000/mcp',
      models: [],
      defaults: {},
    });
    const result = plugin.transform('export default { cases: [] }', '/path/to/my.eval.js');
    expect(result).not.toBeNull();
  });

  it('does not transform virtual modules', async () => {
    const { evalVitestPlugin } = await importPlugin();
    const plugin = evalVitestPlugin({
      server: 'http://localhost:8000/mcp',
      models: [],
      defaults: {},
    });
    const result = plugin.transform('export default {}', '\0sunpeak-eval-spec:foo.eval.ts');
    expect(result).toBeNull();
  });

  it('resolves virtual module IDs', async () => {
    const { evalVitestPlugin } = await importPlugin();
    const plugin = evalVitestPlugin({
      server: 'http://localhost:8000/mcp',
      models: [],
      defaults: {},
    });
    const resolved = plugin.resolveId('\0sunpeak-eval-spec:/path/to/foo.eval.ts');
    expect(resolved).toBe('\0sunpeak-eval-spec:/path/to/foo.eval.ts');
  });

  it('does not resolve non-virtual IDs', async () => {
    const { evalVitestPlugin } = await importPlugin();
    const plugin = evalVitestPlugin({
      server: 'http://localhost:8000/mcp',
      models: [],
      defaults: {},
    });
    expect(plugin.resolveId('/path/to/foo.eval.ts')).toBeNull();
  });

  it('injects describe.skipIf for empty models', async () => {
    const { evalVitestPlugin } = await importPlugin();
    const plugin = evalVitestPlugin({
      server: 'http://localhost:8000/mcp',
      models: [],
      defaults: {},
    });
    const result = plugin.transform('export default { cases: [] }', '/foo.eval.ts');
    expect(result.code).toContain('describe.skipIf(shouldSkip)');
    expect(result.code).toContain('MODELS = []');
  });

  it('extracts test name from filename', async () => {
    const { evalVitestPlugin } = await importPlugin();
    const plugin = evalVitestPlugin({
      server: 'http://localhost:8000/mcp',
      models: [],
      defaults: {},
    });
    const result = plugin.transform(
      'export default { cases: [] }',
      '/tests/evals/show-albums.eval.ts'
    );
    expect(result.code).toContain('"show-albums"');
  });

  it('includes default export validation', async () => {
    const { evalVitestPlugin } = await importPlugin();
    const plugin = evalVitestPlugin({
      server: 'http://localhost:8000/mcp',
      models: [],
      defaults: {},
    });
    const result = plugin.transform('export default { cases: [] }', '/foo.eval.ts');
    expect(result.code).toContain('Eval file must use');
  });
});

// ── Reporter ───────────────────────────────────────────────────────

describe('EvalReporter', () => {
  it('parses eval results from console logs', async () => {
    const mod = await importReporter();
    const Reporter = mod.default;
    const reporter = new Reporter();

    reporter.onUserConsoleLog({
      type: 'stdout',
      content:
        '__SUNPEAK_EVAL__{"type":"eval-result","caseName":"test","modelId":"gpt-4o","runs":3,"passed":2,"failed":1,"passRate":0.67,"avgDurationMs":500,"failures":[{"error":"wrong tool","count":1}]}',
    });

    expect(reporter.results).toHaveLength(1);
    expect(reporter.results[0].caseName).toBe('test');
    expect(reporter.results[0].modelId).toBe('gpt-4o');
    expect(reporter.results[0].passed).toBe(2);
  });

  it('ignores non-eval log lines', async () => {
    const mod = await importReporter();
    const reporter = new mod.default();

    reporter.onUserConsoleLog({ type: 'stdout', content: 'regular log line' });
    reporter.onUserConsoleLog({ type: 'stderr', content: '__SUNPEAK_EVAL__{}' });

    expect(reporter.results).toHaveLength(0);
  });

  it('ignores malformed JSON', async () => {
    const mod = await importReporter();
    const reporter = new mod.default();

    reporter.onUserConsoleLog({ type: 'stdout', content: '__SUNPEAK_EVAL__{not json' });

    expect(reporter.results).toHaveLength(0);
  });

  it('ignores logs without eval-result type', async () => {
    const mod = await importReporter();
    const reporter = new mod.default();

    reporter.onUserConsoleLog({
      type: 'stdout',
      content: '__SUNPEAK_EVAL__{"type":"other","data":"foo"}',
    });

    expect(reporter.results).toHaveLength(0);
  });

  it('prints summary when results exist', async () => {
    const mod = await importReporter();
    const reporter = new mod.default();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    reporter.results = [
      {
        caseName: 'test-a',
        modelId: 'gpt-4o',
        runs: 10,
        passed: 10,
        failed: 0,
        passRate: 1,
        avgDurationMs: 100,
        failures: [],
      },
      {
        caseName: 'test-a',
        modelId: 'claude',
        runs: 10,
        passed: 8,
        failed: 2,
        passRate: 0.8,
        avgDurationMs: 200,
        failures: [{ error: 'wrong tool', count: 2 }],
      },
    ];

    reporter.printSummary();

    const output = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Eval Results');
    expect(output).toContain('test-a');
    expect(output).toContain('gpt-4o');
    expect(output).toContain('10/10');
    expect(output).toContain('8/10');
    expect(output).toContain('Summary: 18/20 passed (90%) across 2 model(s)');

    logSpy.mockRestore();
  });

  it('does not print when no results', async () => {
    const mod = await importReporter();
    const reporter = new mod.default();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    reporter.printSummary();

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
