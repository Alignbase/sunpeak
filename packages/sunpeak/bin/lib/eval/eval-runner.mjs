/**
 * Core eval runner — connects to MCP server, converts tools to AI SDK format,
 * runs eval cases against models, and collects results.
 */

import { resolveModel, checkAiSdkInstalled } from './model-registry.mjs';
import { getMcpClientOptions } from '../mcp-client-options.mjs';

// Re-export for use in generated test code
export { checkAiSdkInstalled };

/**
 * Strip AI SDK retry wrapper from error messages for cleaner output.
 * "Failed after 3 attempts. Last error: <actual error>" → "<actual error>"
 * @param {string} message
 * @returns {string}
 */
export function cleanErrorMessage(message) {
  return message.replace(/^Failed after \d+ attempts?\. Last error: /i, '');
}

/**
 * Check if an error message indicates a fatal API error that won't resolve on retry.
 * @param {string} message
 * @returns {boolean}
 */
export function isFatalApiError(message) {
  const lower = message.toLowerCase();
  const patterns = [
    'exceeded your current quota',
    'credit balance is too low',
    'insufficient_quota',
    'billing_hard_limit_reached',
    'check your plan and billing details',
    'add a payment method',
    'invalid api key',
    'invalid_api_key',
    'incorrect api key',
    'unauthorized',
    'permission denied',
    'access denied',
    'authentication failed',
    'account deactivated',
    'account suspended',
  ];
  return patterns.some((p) => lower.includes(p));
}

/**
 * Define an eval spec. Identity function for type safety.
 * @param {import('./eval-types.d.mts').EvalSpec} spec
 * @returns {import('./eval-types.d.mts').EvalSpec}
 */
export function defineEval(spec) {
  return spec;
}

/**
 * Define eval configuration. Identity function for type safety.
 * @param {import('./eval-types.d.mts').EvalConfig} config
 * @returns {import('./eval-types.d.mts').EvalConfig}
 */
export function defineEvalConfig(config) {
  return config;
}

/**
 * Create an MCP client connection.
 * Reuses the same pattern as inspect.mjs createMcpConnection.
 * @param {string} serverArg - URL or stdio command string
 * @returns {Promise<{ client: import('@modelcontextprotocol/client').Client, transport: import('@modelcontextprotocol/client').Transport }>}
 */
export async function createMcpConnection(serverArg) {
  const { Client } = await import('@modelcontextprotocol/client');
  const client = new Client(
    { name: 'sunpeak-eval', version: '1.0.0' },
    getMcpClientOptions(serverArg)
  );

  if (serverArg.startsWith('http://') || serverArg.startsWith('https://')) {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/client'
    );
    // Follow redirects (e.g. /mcp → /mcp/) before creating the transport.
    let finalUrl = serverArg;
    try {
      const resp = await fetch(serverArg, { method: 'HEAD', redirect: 'follow' });
      if (resp.url && resp.url !== serverArg) finalUrl = resp.url;
    } catch { /* use original URL */ }
    const transport = new StreamableHTTPClientTransport(new URL(finalUrl));
    await client.connect(transport);
    return { client, transport };
  } else {
    const parts = serverArg.split(/\s+/);
    const command = parts[0];
    const cmdArgs = parts.slice(1);
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/client/stdio'
    );
    const transport = new StdioClientTransport({ command, args: cmdArgs });
    await client.connect(transport);
    return { client, transport };
  }
}

/**
 * Discover tools from an MCP server and convert them to AI SDK format.
 * @param {import('@modelcontextprotocol/client').Client} client
 * @returns {Promise<Record<string, import('ai').CoreTool>>}
 */
export async function discoverAndConvertTools(client) {
  const { tool: aiTool } = await import('ai');
  const { jsonSchema } = await import('ai');

  const { tools: mcpTools } = await client.listTools();
  const tools = {};

  for (const t of mcpTools) {
    // Clean up the MCP inputSchema for AI provider compatibility.
    // OpenAI rejects $schema, additionalProperties: {} (empty schema has no type),
    // and other JSON Schema features that MCP servers may include.
    const rawSchema = t.inputSchema || { type: 'object', properties: {} };
    const cleanSchema = { ...rawSchema };
    delete cleanSchema.$schema;
    if (
      cleanSchema.additionalProperties != null &&
      typeof cleanSchema.additionalProperties === 'object' &&
      Object.keys(cleanSchema.additionalProperties).length === 0
    ) {
      // Empty additionalProperties ({}) causes OpenAI to report type: "None".
      // Remove it so the schema is a plain { type: "object", properties: {...} }.
      delete cleanSchema.additionalProperties;
    }
    if (!cleanSchema.type) cleanSchema.type = 'object';
    if (!cleanSchema.properties) cleanSchema.properties = {};
    // Remove `required` so the model isn't forced to ask the user for every
    // parameter before calling a tool. Eval prompts are intentionally vague
    // ("show me photo albums") and the model should call the tool with
    // reasonable defaults, not refuse because required fields are missing.
    delete cleanSchema.required;

    tools[t.name] = aiTool({
      description: t.description || '',
      // Set both so the tool works with ai v4/v5 (reads `parameters`)
      // and ai v6 (reads `inputSchema`). tool() passes through both.
      inputSchema: jsonSchema(cleanSchema),
      parameters: jsonSchema(cleanSchema),
      execute: async (args) => {
        const result = await client.callTool({ name: t.name, arguments: args });
        // Return a simplified version for the model to consume
        if (result.structuredContent !== undefined) {
          return result.structuredContent;
        }
        if (result.content && result.content.length > 0) {
          const textParts = result.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text);
          return textParts.join('\n') || JSON.stringify(result.content);
        }
        return 'Tool executed successfully.';
      },
    });
  }

  return tools;
}

const MODEL_VISIBLE_JSON_LIMIT_BYTES = 20000;

/**
 * Normalize MCP App Context into the same shape hosts expose to the model.
 * Empty context is treated as absent.
 * @param {unknown} appContext
 * @returns {{ content?: unknown[], structuredContent?: unknown } | undefined}
 */
export function normalizeEvalAppContext(appContext) {
  if (!appContext || typeof appContext !== 'object') return undefined;
  const normalized = {};
  if (Array.isArray(appContext.content) && appContext.content.length > 0) {
    normalized.content = appContext.content;
  }
  if (appContext.structuredContent !== undefined) {
    normalized.structuredContent = appContext.structuredContent;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Build the system prompt fragment that makes app context visible to the model.
 * @param {unknown} appContext
 * @returns {string | undefined}
 */
export function formatEvalAppContextForModel(appContext) {
  const normalized = normalizeEvalAppContext(appContext);
  if (!normalized) return undefined;
  const json = JSON.stringify(normalized);
  const visibleJson =
    json.length <= MODEL_VISIBLE_JSON_LIMIT_BYTES
      ? json
      : `${json.slice(0, MODEL_VISIBLE_JSON_LIMIT_BYTES)}...`;
  return `Shared MCP App context from the currently rendered app, available for this turn:\n${visibleJson}`;
}

/**
 * Run a single eval case once against a model.
 * @param {object} params
 * @param {string} params.prompt
 * @param {import('ai').LanguageModel} params.model
 * @param {Record<string, import('ai').CoreTool>} params.tools
 * @param {number} params.maxSteps
 * @param {number} params.temperature
 * @param {number} params.timeout
 * @param {{ content?: unknown[], structuredContent?: unknown }} [params.appContext]
 * @returns {Promise<import('./eval-types.d.mts').EvalRunResult>}
 */
export async function runSingleEval({
  prompt,
  model,
  tools,
  maxSteps,
  temperature,
  timeout,
  appContext,
}) {
  const { generateText } = await import('ai');
  const system = formatEvalAppContextForModel(appContext);
  const providerOptions = model?.provider?.startsWith('openai.')
    ? { openai: { strictJsonSchema: false } }
    : undefined;

  const result = await generateText({
    model,
    tools,
    prompt,
    ...(system ? { system } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    maxSteps,
    temperature,
    maxRetries: 0, // We manage runs ourselves; AI SDK retries compound rate limits
    abortSignal: AbortSignal.timeout(timeout),
  });

  // Normalize the result into our EvalRunResult shape
  const allToolCalls = [];
  const allToolResults = [];
  const steps = [];

  for (const step of result.steps || []) {
    const stepToolCalls = (step.toolCalls || []).map((tc) => ({
      name: tc.toolName,
      args: tc.args,
    }));
    const stepToolResults = (step.toolResults || []).map((tr) => tr.result);

    allToolCalls.push(...stepToolCalls);
    allToolResults.push(...stepToolResults);
    steps.push({
      toolCalls: stepToolCalls,
      toolResults: stepToolResults,
      text: step.text || '',
    });
  }

  return {
    toolCalls: allToolCalls,
    toolResults: allToolResults,
    text: result.text || '',
    steps,
    usage: {
      promptTokens: result.usage?.promptTokens || 0,
      completionTokens: result.usage?.completionTokens || 0,
      totalTokens: result.usage?.totalTokens || 0,
    },
    finishReason: result.finishReason || 'unknown',
  };
}

/**
 * Check a single eval result against expectations.
 * @param {import('./eval-types.d.mts').EvalRunResult} result
 * @param {import('./eval-types.d.mts').EvalCase} evalCase
 * @throws {Error} if the assertion fails
 */
export function checkExpectations(result, evalCase) {
  if (evalCase.assert) {
    evalCase.assert(result);
    return;
  }

  if (!evalCase.expect) return;

  const expectations = Array.isArray(evalCase.expect) ? evalCase.expect : [evalCase.expect];

  if (result.toolCalls.length < expectations.length) {
    let msg = `Expected ${expectations.length} tool call(s), but got ${result.toolCalls.length}`;
    if (result.toolCalls.length === 0 && result.text) {
      const truncated = result.text.length > 200 ? result.text.slice(0, 200) + '...' : result.text;
      msg += `. Model responded with text: "${truncated}"`;
    }
    throw new Error(msg);
  }

  for (let i = 0; i < expectations.length; i++) {
    const expected = expectations[i];
    const actual = result.toolCalls[i];

    if (expected.tool !== actual.name) {
      throw new Error(
        `Step ${i + 1}: expected tool "${expected.tool}", got "${actual.name}"`
      );
    }

    if (expected.args) {
      checkPartialMatch(expected.args, actual.args, `Step ${i + 1} args`);
    }
  }
}

/**
 * Deep partial match — checks that all keys in `expected` exist in `actual`
 * with matching values. Extra keys in `actual` are allowed.
 * Supports vitest asymmetric matchers (expect.stringContaining, etc.).
 * @param {Record<string, unknown>} expected
 * @param {Record<string, unknown>} actual
 * @param {string} path
 */
function checkPartialMatch(expected, actual, path) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual?.[key];

    // Support vitest asymmetric matchers
    if (expectedValue && typeof expectedValue === 'object' && typeof expectedValue.asymmetricMatch === 'function') {
      if (!expectedValue.asymmetricMatch(actualValue)) {
        throw new Error(
          `${path}.${key}: expected ${expectedValue.toString()}, got ${JSON.stringify(actualValue)}`
        );
      }
      continue;
    }

    if (typeof expectedValue === 'object' && expectedValue !== null && !Array.isArray(expectedValue)) {
      checkPartialMatch(expectedValue, actualValue, `${path}.${key}`);
    } else if (Array.isArray(expectedValue)) {
      if (!Array.isArray(actualValue)) {
        throw new Error(
          `${path}.${key}: expected array, got ${JSON.stringify(actualValue)}`
        );
      }
      // For arrays, check that each expected element exists in actual
      for (let i = 0; i < expectedValue.length; i++) {
        if (i >= actualValue.length) {
          throw new Error(
            `${path}.${key}[${i}]: expected ${JSON.stringify(expectedValue[i])}, but array only has ${actualValue.length} elements`
          );
        }
        if (typeof expectedValue[i] === 'object' && expectedValue[i] !== null) {
          checkPartialMatch(expectedValue[i], actualValue[i], `${path}.${key}[${i}]`);
        } else if (expectedValue[i] !== actualValue[i]) {
          throw new Error(
            `${path}.${key}[${i}]: expected ${JSON.stringify(expectedValue[i])}, got ${JSON.stringify(actualValue[i])}`
          );
        }
      }
    } else if (expectedValue !== actualValue) {
      throw new Error(
        `${path}.${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`
      );
    }
  }
}

/**
 * Run an eval case N times against a model and collect aggregate results.
 * @param {object} params
 * @param {import('./eval-types.d.mts').EvalCase} params.evalCase
 * @param {string} params.modelId
 * @param {Record<string, import('ai').CoreTool>} params.tools
 * @param {number} params.runs
 * @param {number} params.maxSteps
 * @param {number} params.temperature
 * @param {number} params.timeout
 * @returns {Promise<import('./eval-types.d.mts').EvalCaseResult>}
 */
export async function runEvalCaseAggregate({
  evalCase,
  modelId,
  tools,
  runs,
  maxSteps,
  temperature,
  timeout,
}) {
  const model = await resolveModel(modelId);
  let passed = 0;
  let failed = 0;
  let executedRuns = 0;
  let totalDurationMs = 0;
  const failureMap = new Map();

  for (let i = 0; i < runs; i++) {
    // Small delay between runs to avoid rate limits (skip before first run)
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));

    executedRuns++;
    const start = performance.now();
    try {
      const result = await runSingleEval({
        prompt: evalCase.prompt,
        model,
        tools,
        maxSteps: evalCase.maxSteps ?? maxSteps,
        temperature,
        timeout,
        appContext: evalCase.appContext,
      });
      checkExpectations(result, evalCase);
      passed++;
    } catch (err) {
      failed++;
      const msg = cleanErrorMessage(err.message || String(err));
      failureMap.set(msg, (failureMap.get(msg) || 0) + 1);

      if (isFatalApiError(msg)) {
        // Count remaining runs as failed and stop early
        const remaining = runs - i - 1;
        failed += remaining;
        failureMap.set(msg, (failureMap.get(msg) || 0) + remaining);
        totalDurationMs += performance.now() - start;
        break;
      }
    }
    totalDurationMs += performance.now() - start;
  }

  const failures = Array.from(failureMap.entries()).map(([error, count]) => ({
    error,
    count,
  }));

  return {
    caseName: evalCase.name,
    modelId,
    runs,
    passed,
    failed,
    passRate: runs > 0 ? passed / runs : 0,
    avgDurationMs: executedRuns > 0 ? totalDurationMs / executedRuns : 0,
    failures,
  };
}
