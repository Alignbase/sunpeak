import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { App } from '@modelcontextprotocol/ext-apps';
import { AppContext } from './app-context';
import { useToolData } from './use-tool-data';
import { initToolDataStore } from './tool-data-store';
import type { ReactNode } from 'react';

type ToolEvent = 'toolinput' | 'toolinputpartial' | 'toolresult' | 'toolcancelled';
type FakeApp = App & {
  emit: (type: ToolEvent, params: Record<string, unknown>) => void;
};

function fakeApp(): FakeApp {
  const listeners = new Map<ToolEvent, Set<(params: Record<string, unknown>) => void>>();
  const obj: Record<string, unknown> = {
    addEventListener(type: ToolEvent, fn: (params: Record<string, unknown>) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener(type: ToolEvent, fn: (params: Record<string, unknown>) => void) {
      listeners.get(type)?.delete(fn);
    },
    emit(type: ToolEvent, params: Record<string, unknown>) {
      for (const fn of listeners.get(type) ?? []) fn(params);
      const handler = obj[`on${type}`];
      if (typeof handler === 'function') handler(params);
    },
  };
  return obj as unknown as FakeApp;
}

function wrapper(app: App | null) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AppContext.Provider value={{ app, isConnected: !!app, error: null }}>
        {children}
      </AppContext.Provider>
    );
  };
}

describe('useToolData eager-store integration', () => {
  it('picks up a tool result that arrived before the component mounted', () => {
    const app = fakeApp();
    initToolDataStore(app);
    // Host fires the result before any React commit — the bug this PR fixes.
    app.emit('toolresult', {
      structuredContent: { greeting: 'hello' },
      content: [],
      isError: false,
    });

    const { result } = renderHook(() => useToolData(), {
      wrapper: wrapper(app),
    });

    expect(result.current.output).toEqual({ greeting: 'hello' });
    expect(result.current.isLoading).toBe(false);
  });

  it('re-renders when a notification arrives after the component mounted', () => {
    const app = fakeApp();
    initToolDataStore(app);

    const { result } = renderHook(() => useToolData(), {
      wrapper: wrapper(app),
    });

    expect(result.current.output).toBeNull();
    expect(result.current.isLoading).toBe(true);

    act(() => {
      app.emit('toolresult', {
        structuredContent: { greeting: 'late' },
        content: [],
        isError: false,
      });
    });

    expect(result.current.output).toEqual({ greeting: 'late' });
    expect(result.current.isLoading).toBe(false);
  });

  it('preserves explicit null structured content in the lazy store', () => {
    const app = fakeApp();
    const { result } = renderHook(() => useToolData(), {
      wrapper: wrapper(app),
    });

    act(() => {
      app.emit('toolresult', {
        structuredContent: null,
        content: [{ type: 'text', text: 'fallback' }],
        isError: false,
      });
    });

    expect(result.current.output).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('falls back to a lazy WeakMap store when no eager store is attached', () => {
    // App created outside AppProvider — e.g. in tests or direct SDK usage.
    const app = fakeApp();
    expect(app.__toolDataStore).toBeUndefined();

    const { result } = renderHook(() => useToolData(), {
      wrapper: wrapper(app),
    });

    expect(result.current.output).toBeNull();
    expect(result.current.isLoading).toBe(true);

    act(() => {
      app.emit('toolresult', {
        structuredContent: { lazy: true },
        content: [],
        isError: false,
      });
    });

    expect(result.current.output).toEqual({ lazy: true });
  });

  it('applies useToolData defaults to an empty eager store', () => {
    const app = fakeApp();
    initToolDataStore(app);

    const { result } = renderHook(
      () => useToolData<{ q: string }, { items: string[] }>({ q: 'seed' }, { items: ['a'] }),
      { wrapper: wrapper(app) }
    );

    expect(result.current.input).toEqual({ q: 'seed' });
    expect(result.current.output).toEqual({ items: ['a'] });
    expect(result.current.isLoading).toBe(false);
  });

  it.each([false, 0, '', null])('treats falsy default output as loaded: %j', (defaultOutput) => {
    const app = fakeApp();

    const { result } = renderHook(() => useToolData<unknown, unknown>(undefined, defaultOutput), {
      wrapper: wrapper(app),
    });

    expect(result.current.output).toBe(defaultOutput);
    expect(result.current.isLoading).toBe(false);
  });

  it('keeps useToolData subscribed when a user also assigns ontoolresult', () => {
    const app = fakeApp();
    initToolDataStore(app);
    let userResult: Record<string, unknown> | undefined;
    app.ontoolresult = (params) => {
      userResult = params as Record<string, unknown>;
    };

    const { result } = renderHook(() => useToolData(), {
      wrapper: wrapper(app),
    });

    const payload = {
      structuredContent: { composed: true },
      content: [],
      isError: false,
    };
    act(() => {
      app.emit('toolresult', payload);
    });

    expect(userResult).toBe(payload);
    expect(result.current.output).toEqual({ composed: true });
    expect(result.current.isLoading).toBe(false);
  });
});
