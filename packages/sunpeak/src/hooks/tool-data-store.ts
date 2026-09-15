/**
 * Tool-data store shared between AppProvider and the useToolData hook.
 *
 * AppProvider eagerly creates the store and wires the App's tool-event
 * listeners BEFORE running the ui/initialize handshake. Without that, hosts
 * that fire `ui/notifications/tool-result` immediately after the initialize
 * response (ChatGPT in production Safari is the known offender) race the
 * React commit that lets <AppProvider> children render and call
 * `useToolData()` — the lazy registration runs after the host has already
 * dispatched the notification, the result is dropped, and the widget is
 * stranded on its loading skeleton forever. sunpeak's own console warning
 * flagged exactly this:
 *   "toolresult handler registered after connect() completed the
 *    ui/initialize handshake".
 *
 * `useToolData` still falls back to a lazy WeakMap registration for App
 * instances created outside `AppProvider` (tests, direct SDK usage).
 */
import type { App } from '@modelcontextprotocol/ext-apps';

export interface ToolData<TInput = unknown, TOutput = unknown> {
  input: TInput | null;
  inputPartial: TInput | null;
  output: TOutput | null;
  isError: boolean;
  isLoading: boolean;
  isCancelled: boolean;
  cancelReason: string | null;
}

export interface ToolDataStore<TInput = unknown, TOutput = unknown> {
  data: ToolData<TInput, TOutput>;
  listeners: Set<() => void>;
}

declare module '@modelcontextprotocol/ext-apps' {
  interface App {
    /** @internal Eager store attached by AppProvider before connect(). */
    __toolDataStore?: ToolDataStore;
  }
}

/**
 * Initialize the tool-data store on an App instance and wire its event
 * listeners. Idempotent - returns the existing store if one is already
 * attached.
 */
export function initToolDataStore(app: App): ToolDataStore {
  if (app.__toolDataStore) return app.__toolDataStore;

  const store: ToolDataStore = {
    data: {
      input: null,
      inputPartial: null,
      output: null,
      isError: false,
      isLoading: true,
      isCancelled: false,
      cancelReason: null,
    },
    listeners: new Set(),
  };
  app.__toolDataStore = store;

  const notify = () => {
    for (const fn of store.listeners) fn();
  };

  app.addEventListener('toolinput', (_params) => {
    store.data = {
      ...store.data,
      input: _params.arguments,
      inputPartial: null,
    };
    notify();
  });

  app.addEventListener('toolinputpartial', (_params) => {
    store.data = {
      ...store.data,
      inputPartial: _params.arguments,
    };
    notify();
  });

  app.addEventListener('toolresult', (_params) => {
    store.data = {
      ...store.data,
      output: 'structuredContent' in _params ? _params.structuredContent : _params.content,
      isError: _params.isError ?? false,
      isLoading: false,
    };
    notify();
  });

  app.addEventListener('toolcancelled', (_params) => {
    store.data = {
      ...store.data,
      isCancelled: true,
      cancelReason: _params.reason ?? null,
      isLoading: false,
    };
    notify();
  });

  return store;
}
