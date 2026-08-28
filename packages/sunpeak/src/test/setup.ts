import '@testing-library/jest-dom/vitest';

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });

  class MockIntersectionObserver {
    observe = () => {};
    unobserve = () => {};
    disconnect = () => {};
  }

  Object.defineProperty(window, 'IntersectionObserver', {
    writable: true,
    value: MockIntersectionObserver,
  });

  class MockResizeObserver {
    observe = () => {};
    unobserve = () => {};
    disconnect = () => {};
  }

  Object.defineProperty(window, 'ResizeObserver', {
    writable: true,
    value: MockResizeObserver,
  });

  // Mock scrollIntoView for Select component
  Element.prototype.scrollIntoView = () => {};

  // Node 22+ ships a stubbed `localStorage` on globalThis with no methods, and
  // happy-dom doesn't override it. Install a Map-backed shim so tests can use
  // localStorage normally.
  const localStorageStore = new Map<string, string>();
  const localStorageShim: Storage = {
    get length() {
      return localStorageStore.size;
    },
    clear: () => localStorageStore.clear(),
    getItem: (key) => localStorageStore.get(key) ?? null,
    key: (index) => Array.from(localStorageStore.keys())[index] ?? null,
    removeItem: (key) => {
      localStorageStore.delete(key);
    },
    setItem: (key, value) => {
      localStorageStore.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorageShim,
    configurable: true,
  });
  Object.defineProperty(window, 'localStorage', {
    value: localStorageShim,
    configurable: true,
  });
}
