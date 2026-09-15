import { describe, it, expect } from 'vitest';
import type { App } from '@modelcontextprotocol/ext-apps';
import { initToolDataStore } from './tool-data-store';

type ToolEvent = 'toolinput' | 'toolinputpartial' | 'toolresult' | 'toolcancelled';
type FakeApp = App & {
  emit: (type: ToolEvent, params: Record<string, unknown>) => void;
  listenerCount: (type: ToolEvent) => number;
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
    listenerCount(type: ToolEvent) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  return obj as unknown as FakeApp;
}

describe('initToolDataStore', () => {
  it('attaches a store with the loading initial state', () => {
    const app = fakeApp();
    const store = initToolDataStore(app);

    expect(store).toBe(app.__toolDataStore);
    expect(store.data).toEqual({
      input: null,
      inputPartial: null,
      output: null,
      isError: false,
      isLoading: true,
      isCancelled: false,
      cancelReason: null,
    });
  });

  it('is idempotent - second call returns the same store and does not rewire listeners', () => {
    const app = fakeApp();
    const first = initToolDataStore(app);
    expect(app.listenerCount('toolresult')).toBe(1);

    const second = initToolDataStore(app);

    expect(second).toBe(first);
    expect(app.listenerCount('toolresult')).toBe(1);
  });

  it('updates the store and notifies listeners when toolresult fires before any consumer renders', () => {
    // Reproduces the production race: handler is invoked between the
    // ui/initialize response and the first React commit. useToolData never
    // got a chance to wire its listener yet — but when it eventually
    // subscribes, the store should already hold the result.
    const app = fakeApp();
    const store = initToolDataStore(app);

    app.emit('toolresult', {
      structuredContent: { items: [1, 2, 3] },
      content: [],
      isError: false,
    });

    expect(store.data.output).toEqual({ items: [1, 2, 3] });
    expect(store.data.isLoading).toBe(false);
    expect(store.data.isError).toBe(false);
  });

  it('notifies subscribers when a notification updates the store', () => {
    const app = fakeApp();
    const store = initToolDataStore(app);
    let calls = 0;
    store.listeners.add(() => {
      calls++;
    });

    app.emit('toolinput', { arguments: { q: 'hi' } });
    app.emit('toolresult', { structuredContent: { ok: true }, content: [], isError: false });

    expect(calls).toBe(2);
    expect(store.data.input).toEqual({ q: 'hi' });
    expect(store.data.output).toEqual({ ok: true });
  });

  it('preserves explicit null structured content instead of falling back to content', () => {
    const app = fakeApp();
    const store = initToolDataStore(app);

    app.emit('toolresult', {
      structuredContent: null,
      content: [{ type: 'text', text: 'fallback' }],
      isError: false,
    });

    expect(store.data.output).toBeNull();
    expect(store.data.isLoading).toBe(false);
  });

  it('marks the store as cancelled with the reason from ontoolcancelled', () => {
    const app = fakeApp();
    const store = initToolDataStore(app);

    app.emit('toolcancelled', { reason: 'user_aborted' });

    expect(store.data.isCancelled).toBe(true);
    expect(store.data.cancelReason).toBe('user_aborted');
    expect(store.data.isLoading).toBe(false);
  });

  it('tracks streaming partials via ontoolinputpartial without clobbering input', () => {
    const app = fakeApp();
    const store = initToolDataStore(app);

    app.emit('toolinputpartial', { arguments: { q: 'he' } });
    expect(store.data.inputPartial).toEqual({ q: 'he' });
    expect(store.data.input).toBeNull();

    app.emit('toolinput', { arguments: { q: 'hello' } });
    expect(store.data.input).toEqual({ q: 'hello' });
    expect(store.data.inputPartial).toBeNull();
  });

  it('keeps receiving events when a user assigns an ontoolresult handler', () => {
    const app = fakeApp();
    const store = initToolDataStore(app);
    let userResult: Record<string, unknown> | undefined;

    app.ontoolresult = (params) => {
      userResult = params as Record<string, unknown>;
    };

    const payload = { structuredContent: { ok: true }, content: [], isError: false };
    app.emit('toolresult', payload);

    expect(userResult).toBe(payload);
    expect(store.data.output).toEqual({ ok: true });
    expect(store.data.isLoading).toBe(false);
  });
});
