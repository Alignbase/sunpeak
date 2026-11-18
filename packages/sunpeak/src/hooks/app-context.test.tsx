import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

const constructed: unknown[][] = [];

vi.mock('@modelcontextprotocol/ext-apps', () => {
  class App {
    constructor(...args: unknown[]) {
      constructed.push(args);
    }
    // Never resolves, so the provider stays in its connecting state.
    connect() {
      return new Promise(() => {});
    }
  }
  class PostMessageTransport {
    close() {
      return Promise.resolve();
    }
  }
  return { App, PostMessageTransport };
});

vi.mock('./tool-data-store', () => ({ initToolDataStore: () => {} }));

describe('AppProvider', () => {
  afterEach(() => {
    cleanup();
    constructed.length = 0;
    // AppProvider keeps the in-flight connection at module scope.
    vi.resetModules();
  });

  const appInfo = { name: 'test-app', version: '1.0.0' };

  it('forwards options to the SDK App constructor', async () => {
    const { AppProvider } = await import('./app-context');

    render(
      <AppProvider
        appInfo={appInfo}
        capabilities={{ availableDisplayModes: ['inline'] }}
        options={{ webMcpBridge: false, autoResize: false }}
      >
        <div />
      </AppProvider>
    );

    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toEqual([
      appInfo,
      { availableDisplayModes: ['inline'] },
      { webMcpBridge: false, autoResize: false },
    ]);
  });

  it('keeps autoResize on when options omit it', async () => {
    const { AppProvider } = await import('./app-context');

    render(
      <AppProvider appInfo={appInfo} options={{ webMcpBridge: false }}>
        <div />
      </AppProvider>
    );

    expect(constructed).toHaveLength(1);
    expect(constructed[0][2]).toEqual({ autoResize: true, webMcpBridge: false });
  });

  it('keeps autoResize on when options are not passed', async () => {
    const { AppProvider } = await import('./app-context');

    render(
      <AppProvider appInfo={appInfo}>
        <div />
      </AppProvider>
    );

    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toEqual([appInfo, {}, { autoResize: true }]);
  });

  it('treats an undefined autoResize as the default', async () => {
    const { AppProvider } = await import('./app-context');

    render(
      <AppProvider appInfo={appInfo} options={{ autoResize: undefined, strict: true }}>
        <div />
      </AppProvider>
    );

    expect(constructed).toHaveLength(1);
    expect(constructed[0][2]).toEqual({ autoResize: true, strict: true });
  });
});
