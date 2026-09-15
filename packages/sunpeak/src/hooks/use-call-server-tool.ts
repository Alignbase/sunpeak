import { useCallback } from 'react';
import type { App } from '@modelcontextprotocol/ext-apps';
import { useApp } from './use-app';

/**
 * Parameters for calling a server tool.
 */
export interface CallServerToolParams {
  /** Name of the tool to call */
  name: string;
  /** Arguments to pass to the tool */
  arguments?: Record<string, unknown>;
}

/**
 * Result from a server tool call.
 */
export interface CallServerToolResult {
  /** Content array from the tool response */
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  /** Structured data from the tool response */
  structuredContent?: unknown;
  /** Whether the tool call resulted in an error */
  isError?: boolean;
}

/**
 * Hook to call other MCP server tools from within an app.
 *
 * Returns a function that invokes a tool on the MCP server and returns its result.
 *
 * @example
 * ```tsx
 * function MyApp() {
 *   const callServerTool = useCallServerTool();
 *
 *   const handleRefresh = async () => {
 *     const result = await callServerTool({
 *       name: 'get_weather',
 *       arguments: { city: 'Tokyo' }
 *     });
 *     console.log('Weather:', result?.content);
 *   };
 *
 *   return <button onClick={handleRefresh}>Refresh Weather</button>;
 * }
 * ```
 */
export function useCallServerTool(): (
  params: CallServerToolParams
) => Promise<CallServerToolResult | undefined> {
  const app = useApp();
  return useCallback(
    async (params: CallServerToolParams) => {
      if (!app) {
        console.warn('[useCallServerTool] App not connected');
        return undefined;
      }
      return app.callServerTool(params as Parameters<App['callServerTool']>[0]);
    },
    [app]
  );
}
