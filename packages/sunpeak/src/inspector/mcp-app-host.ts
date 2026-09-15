import {
  AppBridge,
  PostMessageTransport,
  type McpUiHostContext,
  type McpUiDisplayMode,
  type McpUiHostCapabilities,
  type McpUiToolInputNotification,
  type McpUiToolInputPartialNotification,
  type McpUiToolResultNotification,
  type McpUiToolCancelledNotification,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import type {
  CallToolRequest,
  CallToolResult,
  CreateMessageRequest,
  CreateMessageResult,
  CreateMessageResultWithTools,
  LoggingMessageNotification,
} from '@modelcontextprotocol/client';

const DEFAULT_HOST_INFO = { name: 'SunpeakInspector', version: '1.0.0' };

/**
 * Debug logger for MCP bridge messages. Uses CSS-formatted console.log in browsers,
 * no-ops during unit tests (Vitest) where the output is just noise.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const debugLog: (...args: any[]) => void =
  typeof process !== 'undefined' && process.env?.VITEST ? () => {} : console.log;

const DEFAULT_HOST_CAPABILITIES: McpUiHostCapabilities = {
  openLinks: {},
  serverTools: {},
  serverResources: {},
  downloadFile: {},
  logging: {},
  updateModelContext: { text: {} },
  message: { text: {} },
  sandbox: {},
  sampling: { tools: {} },
};

export interface McpAppHostOptions {
  hostContext?: McpUiHostContext;
  /** Host info reported to the app via MCP protocol. Defaults to SunpeakInspector. */
  hostInfo?: { name: string; version: string };
  /** Host capabilities reported to the app. Defaults to baseline MCP capabilities. */
  hostCapabilities?: McpUiHostCapabilities;
  onDisplayModeChange?: (mode: McpUiDisplayMode) => void;
  onMessage?: (role: string, content: unknown[]) => void;
  onOpenLink?: (url: string) => void;
  onUpdateModelContext?: (content: unknown[], structuredContent?: unknown) => void;
  onSizeChanged?: (params: { width?: number; height?: number }) => void;
  onLog?: (params: LoggingMessageNotification['params']) => void;
  onCallTool?: (params: CallToolRequest['params']) => CallToolResult | Promise<CallToolResult>;
  onCreateSamplingMessage?: (
    params: CreateMessageRequest['params']
  ) => Promise<CreateMessageResult | CreateMessageResultWithTools>;
  onDownloadFile?: (contents: unknown[]) => void;
  /** Called when the app requests teardown (app-initiated close). */
  onRequestTeardown?: () => void;
  /** Called after the iframe confirms rendering in a new display mode (paint fence resolved). */
  onDisplayModeReady?: (mode: string) => void;
  /**
   * Called when the sandbox proxy signals readiness (double-iframe mode).
   * The host should respond by sending HTML content via sendSandboxResourceReady().
   */
  onSandboxReady?: () => void;
}

/**
 * MCP Apps host for the Sunpeak inspector.
 * Wraps AppBridge to provide a simpler API for the inspector.
 * Connects to an iframe via PostMessageTransport.
 */
export class McpAppHost {
  private bridge: AppBridge;
  private options: McpAppHostOptions;
  private _initialized = false;
  private _contentWindow: Window | null = null;
  private _fenceId = 0;
  private _fenceCleanup: (() => void) | null = null;
  private _prevDisplayMode: string | undefined;
  private _pendingToolInput: McpUiToolInputNotification['params'] | null = null;
  private _pendingToolResult: McpUiToolResultNotification['params'] | null = null;
  private _messageListener: ((event: MessageEvent) => void) | null = null;

  constructor(options: McpAppHostOptions = {}) {
    this.options = options;
    this._prevDisplayMode = options.hostContext?.displayMode;

    const hostInfo = options.hostInfo ?? DEFAULT_HOST_INFO;
    const hostCapabilities = options.hostCapabilities ?? DEFAULT_HOST_CAPABILITIES;
    this.bridge = new AppBridge(null, hostInfo, hostCapabilities, {
      hostContext: options.hostContext,
    });

    this.bridge.oninitialized = () => {
      this._initialized = true;

      // Flush any data that was sent before initialization completed
      if (this._pendingToolInput) {
        this.bridge.sendToolInput(this._pendingToolInput);
        this._pendingToolInput = null;
      }
      if (this._pendingToolResult) {
        this.bridge.sendToolResult(this._pendingToolResult);
        this._pendingToolResult = null;
      }
    };

    this.bridge.onopenlink = async ({ url }) => {
      if (this.options.onOpenLink) {
        this.options.onOpenLink(url);
      } else {
        // Validate URL scheme to prevent javascript: and data: URLs
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            console.warn('[MCP App] openLink blocked non-http(s) URL:', url);
          } else {
            // noopener+noreferrer prevents the new tab from reaching this
            // window via window.opener (Safari does not auto-apply this for
            // same-origin destinations).
            window.open(url, '_blank', 'noopener,noreferrer');
          }
        } catch {
          console.warn('[MCP App] openLink blocked invalid URL:', url);
        }
      }
      const ack = {};
      debugLog(
        `%c[MCP ↓]%c host → app: %copenLink ack`,
        'color:#f9a8d4',
        'color:inherit',
        'color:#93c5fd',
        ack
      );
      return ack;
    };

    this.bridge.onmessage = async ({ role, content }) => {
      if (this.options.onMessage) {
        this.options.onMessage(role, content);
      }
      const ack = {};
      debugLog(
        `%c[MCP ↓]%c host → app: %csendMessage ack`,
        'color:#f9a8d4',
        'color:inherit',
        'color:#93c5fd',
        ack
      );
      return ack;
    };

    this.bridge.onrequestdisplaymode = async ({ mode }) => {
      this.options.onDisplayModeChange?.(mode);
      const result = { mode };
      debugLog(
        `%c[MCP ↓]%c host → app: %crequestDisplayMode result`,
        'color:#f9a8d4',
        'color:inherit',
        'color:#93c5fd',
        result
      );
      return result;
    };

    this.bridge.onupdatemodelcontext = async ({ content, structuredContent }) => {
      this.options.onUpdateModelContext?.(content ?? [], structuredContent);
      const ack = {};
      debugLog(
        `%c[MCP ↓]%c host → app: %cupdateModelContext ack`,
        'color:#f9a8d4',
        'color:inherit',
        'color:#93c5fd',
        ack
      );
      return ack;
    };

    this.bridge.onsizechange = (params) => {
      this.options.onSizeChanged?.(params);
    };

    this.bridge.onloggingmessage = (params) => {
      if (this.options.onLog) {
        this.options.onLog(params);
      } else {
        // Default: log to console with appropriate level
        const level = params.level ?? 'info';
        const prefix = `[MCP App${params.logger ? ` ${params.logger}` : ''}]`;
        if (
          level === 'error' ||
          level === 'critical' ||
          level === 'alert' ||
          level === 'emergency'
        ) {
          console.error(prefix, params.data);
        } else if (level === 'warning') {
          console.warn(prefix, params.data);
        } else if (level === 'debug') {
          console.debug(prefix, params.data);
        } else {
          console.log(prefix, params.data);
        }
      }
    };

    this.bridge.oncalltool = async (params) => {
      let result: CallToolResult;
      if (this.options.onCallTool) {
        result = await this.options.onCallTool(params);
      } else {
        result = {
          content: [
            {
              type: 'text',
              text: `[Inspector] Tool "${params.name}" called (no handler configured)`,
            },
          ],
        };
      }
      debugLog(
        `%c[MCP ↓]%c host → app: %ccallServerTool result(${params.name})`,
        'color:#f9a8d4',
        'color:inherit',
        'color:#93c5fd',
        result
      );
      return result;
    };

    this.bridge.oncreatesamplingmessage = async (params) => {
      if (this.options.onCreateSamplingMessage) {
        const result = await this.options.onCreateSamplingMessage(params);
        debugLog(
          `%c[MCP ↓]%c host → app: %ccreateSamplingMessage result`,
          'color:#f9a8d4',
          'color:inherit',
          'color:#93c5fd',
          result
        );
        return result;
      }
      const fallback: CreateMessageResult = {
        model: 'inspector-stub',
        stopReason: 'endTurn',
        role: 'assistant',
        content: {
          type: 'text',
          text: '[Inspector] Sampling not configured',
        },
      };
      debugLog(
        `%c[MCP ↓]%c host → app: %ccreateSamplingMessage result (stub)`,
        'color:#f9a8d4',
        'color:inherit',
        'color:#93c5fd',
        fallback
      );
      return fallback;
    };

    this.bridge.ondownloadfile = async ({ contents }) => {
      if (this.options.onDownloadFile) {
        this.options.onDownloadFile(contents);
      }
      const ack = {};
      debugLog(
        `%c[MCP ↓]%c host → app: %cdownloadFile ack`,
        'color:#f9a8d4',
        'color:inherit',
        'color:#93c5fd',
        ack
      );
      return ack;
    };

    this.bridge.onrequestteardown = () => {
      if (this.options.onRequestTeardown) {
        this.options.onRequestTeardown();
      } else {
        debugLog('[MCP App] requestTeardown (app requested close)');
      }
    };

    // Double-iframe sandbox support: when the proxy signals readiness,
    // notify the host so it can deliver the app HTML.
    // The proxy retries the ready signal periodically, so we guard against
    // calling onSandboxReady more than once.
    let sandboxReadyFired = false;
    this.bridge.onsandboxready = () => {
      if (sandboxReadyFired) return;
      sandboxReadyFired = true;
      this.options.onSandboxReady?.();
    };
  }

  /**
   * Connect to an iframe's contentWindow.
   */
  async connectToIframe(contentWindow: Window): Promise<void> {
    // Clean up previous listener if reconnecting
    if (this._messageListener) {
      window.removeEventListener('message', this._messageListener);
    }

    this._contentWindow = contentWindow;

    // Log incoming MCP protocol messages from the app (skip sunpeak internals)
    this._messageListener = (event: MessageEvent) => {
      if (event.source !== contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const method: string | undefined = data.method;
      // Skip sunpeak-internal and sandbox infrastructure messages
      if (method?.startsWith('sunpeak/') || method === 'ui/notifications/sandbox-proxy-ready')
        return;
      const label = method ?? (data.id != null ? `response #${data.id}` : 'unknown');
      debugLog(
        `%c[MCP ↑]%c app → host: %c${label}`,
        'color:#6ee7b7',
        'color:inherit',
        'color:#93c5fd',
        data
      );
    };
    window.addEventListener('message', this._messageListener);

    const transport = new PostMessageTransport(contentWindow, contentWindow);
    await this.bridge.connect(transport);
  }

  /**
   * Wait for the iframe to process all pending messages and commit its DOM.
   *
   * Uses a postMessage fence: since messages to the same target are delivered
   * in FIFO order, a fence message sent after setHostContext is guaranteed to
   * be processed after the host context change. The iframe's fence responder
   * waits for requestAnimationFrame before acking, ensuring the DOM has been
   * committed for the re-render triggered by the context change.
   *
   * Returns immediately if the iframe is not connected.
   */
  waitForPaint(): Promise<void> {
    const win = this._contentWindow;
    if (!win) return Promise.resolve();

    // Cancel any previous pending fence
    this._fenceCleanup?.();

    const id = ++this._fenceId;

    return new Promise<void>((resolve) => {
      const handler = (event: MessageEvent) => {
        if (event.source !== win) return;
        if (event.data?.method === 'sunpeak/fence-ack' && event.data.params?.fenceId === id) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        window.removeEventListener('message', handler);
        if (this._fenceCleanup === cleanup) {
          this._fenceCleanup = null;
        }
      };

      this._fenceCleanup = cleanup;
      window.addEventListener('message', handler);

      try {
        // Format as a valid JSON-RPC 2.0 notification so the SDK's
        // PostMessageTransport parses it without error. Unknown notification
        // methods are silently ignored by the bridge.
        const fenceMsg = { jsonrpc: '2.0', method: 'sunpeak/fence', params: { fenceId: id } };
        win.postMessage(fenceMsg, '*');
      } catch {
        // Detached or cross-origin window
        cleanup();
        resolve();
      }
    });
  }

  /**
   * Update the host context and notify the connected app.
   * Automatically detects display mode changes and waits for the iframe
   * to commit its DOM before firing onDisplayModeReady.
   */
  setHostContext(context: McpUiHostContext): void {
    debugLog(
      `%c[MCP ↓]%c host → app: %csetHostContext`,
      'color:#f9a8d4',
      'color:inherit',
      'color:#93c5fd',
      context
    );
    this.bridge.setHostContext(context);

    const currentMode = context.displayMode;
    if (currentMode && currentMode !== this._prevDisplayMode) {
      this._prevDisplayMode = currentMode;
      const mode = currentMode;
      this.waitForPaint().then(() => {
        this.options.onDisplayModeReady?.(mode);
      });
    }
  }

  /**
   * Send tool input to the app.
   * If the app hasn't initialized yet, the input is queued.
   */
  sendToolInput(args: Record<string, unknown>): void {
    const params: McpUiToolInputNotification['params'] = { arguments: args };
    debugLog(
      `%c[MCP ↓]%c host → app: %csendToolInput`,
      'color:#f9a8d4',
      'color:inherit',
      'color:#93c5fd',
      params
    );
    if (this._initialized) {
      this.bridge.sendToolInput(params);
    } else {
      this._pendingToolInput = params;
    }
  }

  /**
   * Send tool result to the app.
   * If the app hasn't initialized yet, the result is queued.
   */
  sendToolResult(result: CallToolResult): void {
    debugLog(
      `%c[MCP ↓]%c host → app: %csendToolResult`,
      'color:#f9a8d4',
      'color:inherit',
      'color:#93c5fd',
      result
    );
    if (this._initialized) {
      this.bridge.sendToolResult(result);
    } else {
      this._pendingToolResult = result;
    }
  }

  /**
   * Send partial/streaming tool input to the app.
   * Useful for simulating streaming tool arguments.
   */
  sendToolInputPartial(args: Record<string, unknown>): void {
    const params: McpUiToolInputPartialNotification['params'] = { arguments: args };
    debugLog(
      `%c[MCP ↓]%c host → app: %csendToolInputPartial`,
      'color:#f9a8d4',
      'color:inherit',
      'color:#93c5fd',
      params
    );
    if (this._initialized) {
      this.bridge.sendToolInputPartial(params);
    }
    // Don't queue partials - they're only meaningful during streaming
  }

  /**
   * Send tool cancellation notification to the app.
   * Simulates user or host cancelling a tool execution.
   */
  sendToolCancelled(reason?: string): void {
    const params: McpUiToolCancelledNotification['params'] = reason ? { reason } : {};
    debugLog(
      `%c[MCP ↓]%c host → app: %csendToolCancelled`,
      'color:#f9a8d4',
      'color:inherit',
      'color:#93c5fd',
      params
    );
    if (this._initialized) {
      this.bridge.sendToolCancelled(params);
    }
  }

  /**
   * Send HTML resource to the sandbox proxy for secure loading.
   * Used in the double-iframe architecture after the proxy signals readiness.
   */
  sendSandboxResourceReady(params: { html: string; sandbox?: string }): void {
    this.bridge.sendSandboxResourceReady(params);
  }

  /**
   * Send a custom message to the connected iframe (for sandbox proxy commands).
   */
  sendRawMessage(data: unknown): void {
    const win = this._contentWindow;
    if (!win) return;
    try {
      win.postMessage(data, '*');
    } catch {
      // Detached or cross-origin window
    }
  }

  /**
   * Close the connection.
   */
  async close(): Promise<void> {
    if (this._messageListener) {
      window.removeEventListener('message', this._messageListener);
      this._messageListener = null;
    }
    this._fenceCleanup?.();
    this._fenceCleanup = null;
    try {
      if (this._initialized) {
        await this.bridge.teardownResource({});
      }
    } catch {
      // Ignore teardown errors
    }
    await this.bridge.close();
    this._initialized = false;
    // Note: _contentWindow is intentionally NOT cleared here.
    // In React strict mode, close() runs asynchronously during the cleanup
    // phase of double-mount, completing after effects have re-run. Clearing
    // _contentWindow would break injectState() and waitForPaint() which
    // use it directly (unlike sendToolResult which goes through the bridge).
    // The reference becomes harmless on real unmount since no code calls
    // methods on a host whose component has been removed from the tree.
  }

  /**
   * Debug: Inject state directly into the app's useAppState hook.
   * This bypasses the normal MCP Apps protocol and is intended for
   * inspector testing/debugging only.
   */
  injectState(state: Record<string, unknown>): void {
    const win = this._contentWindow;
    if (!win) return;

    try {
      win.postMessage({ jsonrpc: '2.0', method: 'sunpeak/injectState', params: { state } }, '*');
    } catch {
      // Detached or cross-origin window - ignore
    }
  }

  /**
   * Update mutable options (callbacks) after construction.
   * Allows the inspector to swap handlers (e.g. onCallTool) without
   * recreating the host and tearing down the iframe connection.
   */
  updateOptions(partial: Partial<McpAppHostOptions>): void {
    Object.assign(this.options, partial);
  }

  get initialized(): boolean {
    return this._initialized;
  }
}
