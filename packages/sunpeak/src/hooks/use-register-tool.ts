import { useCallback } from 'react';
import type {
  RegisteredAppTool,
  AppToolCallback,
  StandardSchemaV1,
} from '@modelcontextprotocol/ext-apps';
import type { ToolAnnotations } from '@modelcontextprotocol/client';
import { useApp } from './use-app';

export interface RegisterToolConfig {
  title?: string;
  description?: string;
  inputSchema?: StandardSchemaV1;
  outputSchema?: StandardSchemaV1;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

export function useRegisterTool(): (
  name: string,
  config: RegisterToolConfig,
  cb: AppToolCallback<StandardSchemaV1 | undefined, StandardSchemaV1 | undefined>
) => RegisteredAppTool | undefined {
  const app = useApp();
  return useCallback(
    (
      name: string,
      config: RegisterToolConfig,
      cb: AppToolCallback<StandardSchemaV1 | undefined, StandardSchemaV1 | undefined>
    ) => {
      if (!app) {
        console.warn('[useRegisterTool] App not connected');
        return undefined;
      }
      return app.registerTool(name, config, cb);
    },
    [app]
  );
}
