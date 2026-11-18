/**
 * React Context for sharing the MCP App instance across the component tree.
 *
 * AppProvider handles connecting to the MCP Apps host and provides the App
 * instance via context. All sunpeak hooks read from this context internally,
 * so consumers never need to pass `app` as a parameter.
 *
 * The provider preserves the App instance across React Fast Refresh (HMR)
 * by storing it at module scope, matching the previous useApp() behavior.
 *
 * Connection resilience: if the initial PostMessage handshake doesn't complete
 * within a timeout, the provider automatically retries with exponential backoff.
 * This handles race conditions where the host iframe bridge isn't ready when the
 * app first mounts (common on first load in ChatGPT and Claude).
 */
import { createContext, useState, useEffect, type ReactNode } from 'react';
import { App, PostMessageTransport, type AppOptions } from '@modelcontextprotocol/ext-apps';
import { initToolDataStore } from './tool-data-store';

export interface AppProviderProps {
  appInfo: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  /**
   * Options forwarded to the SDK `App` constructor, such as `autoResize`,
   * `strict`, or `webMcpBridge`. `autoResize` stays `true` unless you set it.
   * Read once when the first connection starts.
   */
  options?: AppOptions;
  onAppCreated?: (app: App) => void;
  children: ReactNode;
}

export interface AppState {
  app: App | null;
  isConnected: boolean;
  error: Error | null;
}

const defaultState: AppState = { app: null, isConnected: false, error: null };

export const AppContext = createContext<AppState>(defaultState);

// Module-level App persistence.
// During React Fast Refresh the component file is hot-swapped but this module
// is NOT re-evaluated, so these variables survive across HMR cycles.
// On a full page reload they reset to null, triggering a fresh connection.
let _app: App | null = null;
let _connecting: Promise<App> | null = null;

/** Timeout for a single connection attempt (ms). */
const CONNECT_TIMEOUT_MS = 5_000;
/** Maximum number of retry attempts before giving up. */
const MAX_RETRIES = 3;
/** Base delay for exponential backoff between retries (ms). */
const RETRY_BASE_DELAY_MS = 500;

/**
 * Race a promise against a timeout. Rejects with a TimeoutError if the
 * promise doesn't settle within `ms` milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timed out')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Attempt to connect to the host with timeout and retries.
 * Each attempt creates a fresh transport + App instance so stale PostMessage
 * listeners from a previous failed attempt don't interfere.
 */
async function connectWithRetry(
  appInfo: { name: string; version: string },
  capabilities: Record<string, unknown>,
  onAppCreated?: (app: App) => void,
  options?: AppOptions
): Promise<App> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }

    let transport: PostMessageTransport | null = null;
    try {
      transport = new PostMessageTransport(window.parent, window.parent);
      const newApp = new App(appInfo, capabilities, {
        // The SDK applies its autoResize default only when the whole options
        // object is omitted, so keep it on for partial options.
        ...options,
        autoResize: options?.autoResize ?? true,
      });
      // Pre-register useToolData's notification handlers BEFORE connect()
      // runs the ui/initialize handshake. Hosts that fire
      // `ui/notifications/tool-result` immediately after the initialize
      // response (ChatGPT on production Safari) would otherwise race the
      // first React commit and drop the result. See tool-data-store.ts.
      initToolDataStore(newApp);
      onAppCreated?.(newApp);
      await withTimeout(newApp.connect(transport), CONNECT_TIMEOUT_MS);
      return newApp;
    } catch (err) {
      // Clean up the transport's PostMessage listener so it doesn't linger.
      if (transport) {
        try {
          await transport.close();
        } catch {
          /* ignore close errors */
        }
      }
      lastError = err instanceof Error ? err : new Error('Connection failed');
      if (attempt < MAX_RETRIES) {
        console.warn(
          `[sunpeak] Connection attempt ${attempt + 1}/${MAX_RETRIES + 1} failed, retrying...`,
          lastError.message
        );
      }
    }
  }

  console.error(
    '[sunpeak] All connection attempts failed. Try refreshing the page or opening a new chat.\n' +
      'Troubleshooting: https://sunpeak.ai/docs/app-framework/guides/troubleshooting'
  );
  throw lastError ?? new Error('Failed to connect');
}

export function AppProvider({
  appInfo,
  capabilities,
  options,
  onAppCreated,
  children,
}: AppProviderProps) {
  const [state, setState] = useState<AppState>(() =>
    _app ? { app: _app, isConnected: true, error: null } : defaultState
  );

  useEffect(() => {
    let cancelled = false;

    // Already connected (HMR re-run or StrictMode double-mount) — reuse.
    if (_app) {
      setState({ app: _app, isConnected: true, error: null });
      return () => {
        cancelled = true;
      };
    }

    // Connection already in flight (StrictMode double-mount) — wait for it.
    if (!_connecting) {
      _connecting = connectWithRetry(appInfo, capabilities ?? {}, onAppCreated, options);
    }

    _connecting.then(
      (connectedApp) => {
        _app = connectedApp;
        if (!cancelled) {
          setState({ app: connectedApp, isConnected: true, error: null });
        }
      },
      (err) => {
        _connecting = null;
        if (!cancelled) {
          setState({
            app: null,
            isConnected: false,
            error: err instanceof Error ? err : new Error('Failed to connect'),
          });
        }
      }
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- connect once, persist across HMR
  }, []);

  return <AppContext.Provider value={state}>{children}</AppContext.Provider>;
}
