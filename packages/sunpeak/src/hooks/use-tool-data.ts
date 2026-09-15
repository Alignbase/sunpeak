import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import type { App } from '@modelcontextprotocol/ext-apps';
import { useApp } from './use-app';
import { initToolDataStore, type ToolData, type ToolDataStore } from './tool-data-store';

export type { ToolData };

const stores = new WeakMap<App, ToolDataStore>();

function getStore<TInput, TOutput>(
  app: App,
  defaultInput?: TInput,
  defaultOutput?: TOutput
): ToolDataStore<TInput, TOutput> {
  // Prefer the eager store created by AppProvider before connect(). Doing so
  // avoids a race where a host fires `ui/notifications/tool-result` between
  // the initialize response and the first React commit — see the comment in
  // tool-data-store.ts for the full background.
  const eager = app.__toolDataStore as ToolDataStore<TInput, TOutput> | undefined;
  if (eager) {
    if (defaultInput !== undefined && eager.data.input === null) {
      eager.data = { ...eager.data, input: defaultInput };
    }
    if (defaultOutput !== undefined && eager.data.output === null) {
      eager.data = { ...eager.data, output: defaultOutput, isLoading: false };
    }
    return eager;
  }

  // Lazy path for App instances created outside <AppProvider> (tests, direct
  // SDK usage). Same shape as the eager store, just attached via WeakMap.
  let store = stores.get(app) as ToolDataStore<TInput, TOutput> | undefined;
  if (!store) {
    const lazy: ToolDataStore<TInput, TOutput> = {
      data: {
        input: defaultInput ?? null,
        inputPartial: null,
        output: defaultOutput === undefined ? null : defaultOutput,
        isError: false,
        isLoading: defaultOutput === undefined,
        isCancelled: false,
        cancelReason: null,
      },
      listeners: new Set(),
    };
    stores.set(app, lazy as ToolDataStore);
    store = lazy;

    const notify = () => {
      for (const fn of lazy.listeners) fn();
    };

    app.addEventListener('toolinput', (_params) => {
      lazy.data = {
        ...lazy.data,
        input: _params.arguments as TInput,
        inputPartial: null,
      };
      notify();
    });

    app.addEventListener('toolinputpartial', (_params) => {
      lazy.data = {
        ...lazy.data,
        inputPartial: _params.arguments as TInput,
      };
      notify();
    });

    app.addEventListener('toolresult', (_params) => {
      lazy.data = {
        ...lazy.data,
        output: ('structuredContent' in _params
          ? _params.structuredContent
          : _params.content) as TOutput,
        isError: _params.isError ?? false,
        isLoading: false,
      };
      notify();
    });

    app.addEventListener('toolcancelled', (_params) => {
      lazy.data = {
        ...lazy.data,
        isCancelled: true,
        cancelReason: _params.reason ?? null,
        isLoading: false,
      };
      notify();
    });
  }
  return store;
}

// Re-export the eager initializer so callers (AppProvider) and tests can
// pre-register handlers on an App before connect().
export { initToolDataStore };

/**
 * Reactive access to tool input and output data from the MCP Apps host.
 *
 * @param defaultInput - Optional default input value before host sends data.
 * @param defaultOutput - Optional default output value before host sends data.
 */
export function useToolData<TInput = unknown, TOutput = unknown>(
  defaultInput?: TInput,
  defaultOutput?: TOutput
): ToolData<TInput, TOutput> {
  const app = useApp();
  const defaultInputRef = useRef(defaultInput);
  const defaultOutputRef = useRef(defaultOutput);

  // Cache the null-app snapshot so getSnapshot returns a stable reference.
  // useSyncExternalStore compares with Object.is — a new object each call
  // would cause an infinite re-render loop.
  const nullSnapshot = useMemo<ToolData<TInput, TOutput>>(
    () => ({
      input: defaultInput ?? null,
      inputPartial: null,
      output: defaultOutput === undefined ? null : defaultOutput,
      isError: false,
      isLoading: defaultOutput === undefined,
      isCancelled: false,
      cancelReason: null,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // Intentionally empty - only compute once on first render
  );

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!app) return () => {};
      const store = getStore<TInput, TOutput>(
        app,
        defaultInputRef.current,
        defaultOutputRef.current
      );
      store.listeners.add(onChange);
      return () => {
        store.listeners.delete(onChange);
      };
    },
    [app]
  );

  const getSnapshot = useCallback((): ToolData<TInput, TOutput> => {
    if (!app) {
      return nullSnapshot;
    }
    return getStore<TInput, TOutput>(app, defaultInputRef.current, defaultOutputRef.current).data;
  }, [app, nullSnapshot]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
