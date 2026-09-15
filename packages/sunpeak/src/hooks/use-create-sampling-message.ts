import { useCallback } from 'react';
import type {
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
} from '@modelcontextprotocol/client';
import { useApp } from './use-app';

export type CreateSamplingMessageParams = CreateMessageRequest['params'];
export type { CreateMessageResult, CreateMessageResultWithTools };

export function useCreateSamplingMessage(): (
  params: CreateSamplingMessageParams
) => Promise<CreateMessageResult | CreateMessageResultWithTools | undefined> {
  const app = useApp();
  return useCallback(
    async (params: CreateSamplingMessageParams) => {
      if (!app) {
        console.warn('[useCreateSamplingMessage] App not connected');
        return undefined;
      }
      return app.createSamplingMessage(params);
    },
    [app]
  );
}
