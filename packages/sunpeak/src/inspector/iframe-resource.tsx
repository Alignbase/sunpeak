import * as React from 'react';
import { useEffect, useRef, useMemo, useCallback, useLayoutEffect, useState } from 'react';
import { McpAppHost, type McpAppHostOptions } from './mcp-app-host';
import { MOCK_OPENAI_RUNTIME_SCRIPT } from './mock-openai-runtime';
import { generateSandboxProxyHtml } from './sandbox-proxy';
import { SUNPEAK_INLINE_HELPER_SCRIPT } from './inline-helper-script';
import type { McpUiHostContext, McpUiResourcePermissions } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Allowed origins for cross-origin script loading.
 * - Production: sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com (serves user scripts)
 *
 * Loopback script URLs are handled separately in isAllowedUrl() so hosted
 * inspectors cannot be tricked into loading scripts from a visitor's machine.
 */
const ALLOWED_SCRIPT_ORIGINS = ['https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com'];

/**
 * Escapes HTML special characters to prevent XSS via attribute injection.
 */
function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (c) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[c] ?? c;
  });
}

/**
 * Returns true when the inspector itself is running on a loopback hostname.
 * Used to decide whether to honor `localhost`/`127.0.0.1` script URLs supplied
 * by the connected MCP server. When the inspector is hosted on a public domain,
 * a remote MCP server should not be able to coerce the inspector into loading
 * scripts from arbitrary services running on the visitor's machine
 * (e.g. http://127.0.0.1:11434/...).
 */
function isInspectorOnLoopback(): boolean {
  if (typeof window === 'undefined') return true;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/**
 * Validates that a URL is from an allowed origin.
 * Allows same-origin URLs and URLs from whitelisted domains.
 */
function isAllowedUrl(src: string): boolean {
  if (!src) return false;

  // Allow relative paths (same-origin) - must start with / but not //
  if (src.startsWith('/') && !src.startsWith('//')) return true;

  // Reject strings that don't look like URLs (no protocol)
  if (!src.includes('://')) return false;

  try {
    const url = new URL(src);

    // Allow same-origin
    if (url.origin === window.location.origin) return true;

    // Allow localhost with any port — but only when the inspector itself is
    // running on loopback. Otherwise a hosted inspector would happily load
    // scripts from the visitor's local machine.
    if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1') && isInspectorOnLoopback()) {
      return true;
    }

    // Check against allowed origins (strict origin comparison only)
    return ALLOWED_SCRIPT_ORIGINS.some((allowed) => {
      try {
        return url.origin === new URL(allowed).origin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * Content Security Policy configuration for iframe resources.
 * Matches McpUiResourceCsp from the MCP Apps spec.
 */
export interface ResourceCSP {
  /** Domains allowed for fetch/XHR/WebSocket connections */
  connectDomains?: string[];
  /** Domains allowed for scripts, images, styles, fonts */
  resourceDomains?: string[];
  /** Domains allowed for nested iframes */
  frameDomains?: string[];
  /** Domains allowed for the base-uri directive */
  baseUriDomains?: string[];
}

/**
 * Extract CSP configuration from a resource's _meta.ui.csp field.
 */
export function extractResourceCSP(resource: { _meta?: unknown }): ResourceCSP | undefined {
  const meta = resource._meta as Record<string, unknown> | undefined;
  const ui = meta?.ui as { csp?: ResourceCSP } | undefined;
  return ui?.csp;
}

/**
 * Validates a CSP source entry is a safe origin URL (scheme + host + optional port).
 * Rejects wildcards, CSP keywords, and whitespace that could inject extra directives.
 */
function isValidCspSource(source: string): boolean {
  // Block CSP keywords like 'unsafe-inline', wildcards like *, and whitespace injection
  if (!source || /[\s;,']/.test(source) || source === '*') return false;
  try {
    const url = new URL(source);
    return (
      url.protocol === 'http:' ||
      url.protocol === 'https:' ||
      url.protocol === 'ws:' ||
      url.protocol === 'wss:'
    );
  } catch {
    return false;
  }
}

/**
 * Generates a Content Security Policy string.
 */
function generateCSP(csp: ResourceCSP | undefined, scriptSrc: string): string {
  let scriptOrigin = '';
  try {
    scriptOrigin = new URL(scriptSrc, window.location.origin).origin;
  } catch {
    // Invalid URL, skip
  }

  // frame-src: default to 'none', but allow declared frame domains
  const frameSources = new Set<string>();
  if (csp?.frameDomains) {
    for (const domain of csp.frameDomains) {
      if (isValidCspSource(domain)) {
        frameSources.add(domain);
      } else {
        console.warn('[IframeResource] Ignoring invalid CSP frame domain:', domain);
      }
    }
  }
  const frameSrc =
    frameSources.size > 0 ? `frame-src ${Array.from(frameSources).join(' ')}` : "frame-src 'none'";

  // base-uri: default to 'self', but allow declared base-uri domains
  const baseSources = new Set<string>(["'self'"]);
  if (csp?.baseUriDomains) {
    for (const domain of csp.baseUriDomains) {
      if (isValidCspSource(domain)) {
        baseSources.add(domain);
      } else {
        console.warn('[IframeResource] Ignoring invalid CSP base-uri domain:', domain);
      }
    }
  }

  const directives: string[] = [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: ${scriptOrigin}`.trim(),
    `style-src 'self' 'unsafe-inline' ${scriptOrigin}`.trim(),
    frameSrc,
    "object-src 'none'",
    "form-action 'none'",
    `base-uri ${Array.from(baseSources).join(' ')}`,
  ];

  const connectSources = new Set<string>(["'self'"]);
  if (scriptOrigin) connectSources.add(scriptOrigin);
  if (csp?.connectDomains) {
    for (const domain of csp.connectDomains) {
      if (isValidCspSource(domain)) {
        connectSources.add(domain);
      } else {
        console.warn('[IframeResource] Ignoring invalid CSP connect domain:', domain);
      }
    }
  }
  directives.push(`connect-src ${Array.from(connectSources).join(' ')}`);

  const resourceSources = new Set<string>(["'self'", 'data:', 'blob:']);
  if (scriptOrigin) resourceSources.add(scriptOrigin);
  if (csp?.resourceDomains) {
    for (const domain of csp.resourceDomains) {
      if (isValidCspSource(domain)) {
        resourceSources.add(domain);
      } else {
        console.warn('[IframeResource] Ignoring invalid CSP resource domain:', domain);
      }
    }
  }
  const resourceList = Array.from(resourceSources).join(' ');
  directives.push(`img-src ${resourceList}`);
  directives.push(`font-src ${resourceList}`);
  directives.push(`media-src ${resourceList}`);

  return directives.join('; ');
}

/**
 * Paint fence responder script body.
 * Embedded in the generated HTML for scriptSrc mode. The sandbox proxy
 * handles fence injection for src-mode iframes.
 */
const PAINT_FENCE_SCRIPT = `window.addEventListener("message",function(e){
if(e.data&&e.data.method==="sunpeak/fence"){
var fid=e.data.params&&e.data.params.fenceId;
requestAnimationFrame(function(){
e.source.postMessage({jsonrpc:"2.0",method:"sunpeak/fence-ack",params:{fenceId:fid}},"*");
});}});`;

/**
 * Inject the paint-fence responder and (optionally) a platform runtime script
 * into a user-provided HTML document. Used for the `html` prop mode where the
 * embedder hands us a complete document from `mcpClient.readResource(...)` and
 * we need to splice in the same infrastructure that the `scriptSrc` wrapper
 * provides. The injection is placed before `</head>` when present, falling
 * back to the start of `<body>` or the document start.
 */
export function injectInfraScripts(html: string, platformScript?: string): string {
  const fenceTag = `<script data-sunpeak-fence>${PAINT_FENCE_SCRIPT}</script>`;
  const platformTag = platformScript ? `<script>${platformScript}</script>` : '';
  // Inline MCP Apps SDK shim — completes the initialize handshake on behalf
  // of plain-HTML resources and exposes window.sunpeak.{onToolInput,
  // onToolResult, onHostContextChange}. The helper bails out if the real
  // SDK is already loaded.
  const helperTag = `<script data-sunpeak-helper>${SUNPEAK_INLINE_HELPER_SCRIPT}</script>`;
  const injection = `${platformTag}${fenceTag}${helperTag}`;
  // Tag matching is case-insensitive per the HTML spec. Most apps use the
  // lowercase form, but be tolerant of `</HEAD>` / `<BODY>` so an upstream
  // generator quirk doesn't silently skip the injection.
  const headMatch = html.match(/<\/head\s*>/i);
  if (headMatch) {
    return html.replace(headMatch[0], `${injection}${headMatch[0]}`);
  }
  const bodyMatch = html.match(/<body([^>]*)>/i);
  if (bodyMatch) {
    return html.replace(bodyMatch[0], `${bodyMatch[0]}${injection}`);
  }
  return injection + html;
}

/**
 * Generates HTML wrapper for a script URL.
 * The MCP Apps SDK in the loaded script handles communication via PostMessageTransport.
 */
function generateScriptHtml(
  scriptSrc: string,
  theme: string,
  cspPolicy: string,
  platformScript?: string
): string {
  const safeScriptSrc = escapeHtml(scriptSrc);
  const safeCsp = escapeHtml(cspPolicy);
  const safeTheme = escapeHtml(theme);
  // Platform runtime script (e.g. mock window.openai) runs before the app
  // script so that isChatGPT() and platform hooks work from first render.
  const platformTag = platformScript ? `\n  <script>${platformScript}</script>` : '';
  return `<!DOCTYPE html>
<html lang="en" data-theme="${safeTheme}" style="color-scheme:${safeTheme};background:Canvas">
<head>
  <meta charset="UTF-8" />
  <meta name="color-scheme" content="${safeTheme}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${safeCsp}" />
  <title>Resource</title>
  <style>
    html {
      /* Use the MCP App background variable once JS sets it, otherwise
         Canvas (the system color that auto-adapts to color-scheme). */
      background-color: var(--color-background-primary, Canvas);
    }
    body, #root {
      margin: 0;
      padding: 0;
      width: 100%;
      background: transparent;
    }
  </style>
  <script>${PAINT_FENCE_SCRIPT}</script>${platformTag}
</head>
<body>
  <div id="root"></div>
  <script src="${safeScriptSrc}"></script>
</body>
</html>`;
}

/**
 * Build the iframe `allow` attribute from resource-declared permissions.
 * Maps McpUiResourcePermissions to Permission Policy directives and
 * combines them with inspector baseline permissions.
 */
function buildIframeAllow(permissions: McpUiResourcePermissions | undefined): string {
  const parts: string[] = [];

  // Local-network-access is required for `sunpeak dev` because the app iframe
  // loads from local Vite/MCP servers. Do not grant it from hosted inspectors:
  // untrusted app resources should not get extra private-network reachability
  // in a visitor's browser just because the inspector is remote.
  if (isInspectorOnLoopback()) {
    parts.push('local-network-access *');
  }

  // Map spec permissions to their Permission Policy names
  const permMap: [keyof McpUiResourcePermissions, string][] = [
    ['camera', 'camera'],
    ['microphone', 'microphone'],
    ['geolocation', 'geolocation'],
    ['clipboardWrite', 'clipboard-write'],
  ];

  for (const [key, directive] of permMap) {
    if (permissions?.[key]) {
      parts.push(directive);
    }
  }

  return parts.join('; ');
}

interface IframeResourceProps {
  /**
   * URL to an HTML page to load directly in the iframe.
   * Used for dev mode where Vite serves the resource page.
   * Mutually exclusive with scriptSrc.
   */
  src?: string;
  /**
   * URL to a built resource to load in the iframe via srcdoc.
   * Used for production builds where we generate the HTML wrapper.
   * Mutually exclusive with src.
   */
  scriptSrc?: string;
  /**
   * Resource HTML to render directly — typically the string returned by
   * `mcpClient.readResource(...)`. The Inspector hands the HTML to the
   * sandbox proxy via PostMessage; the host page never hosts it at a URL.
   * The Inspector injects its paint-fence responder and (when enabled) the
   * platform runtime script before delivery.
   * Mutually exclusive with src and scriptSrc.
   */
  html?: string;
  /** Initial host context for the MCP Apps bridge */
  hostContext?: McpUiHostContext;
  /** Tool input arguments to send after connection */
  toolInput?: Record<string, unknown>;
  /** Partial/streaming tool input to send as a tool-input-partial notification */
  toolInputPartial?: Record<string, unknown>;
  /** Tool result to send after connection */
  toolResult?: CallToolResult;
  /** Optional callbacks for the MCP Apps host */
  hostOptions?: McpAppHostOptions;
  /** Optional CSP configuration (only used with scriptSrc) */
  csp?: ResourceCSP;
  /** Resource-declared sandbox permissions (camera, microphone, etc.) */
  permissions?: McpUiResourcePermissions;
  /** Whether the host should render a border around the resource */
  prefersBorder?: boolean;
  /** Optional className for the iframe container */
  className?: string;
  /** Optional style for the iframe */
  style?: React.CSSProperties;
  /**
   * Called after the iframe has rendered following a display mode change.
   * The callback receives the display mode that was confirmed.
   * Used by the inspector to hide content during transitions and only
   * reveal it once the app has committed its DOM for the new mode.
   */
  onDisplayModeReady?: (mode: string) => void;
  /**
   * Debug: State to inject directly into the app's useAppState hook.
   * This bypasses the normal MCP Apps protocol and is for inspector testing.
   */
  debugInjectState?: Record<string, unknown> | null;
  /**
   * Whether to inject a mock ChatGPT runtime (window.openai) into the iframe.
   * When true, ChatGPT-specific hooks (useUploadFile, useRequestModal, etc.)
   * and isChatGPT() will work inside the iframe.
   */
  injectOpenAIRuntime?: boolean;
  /**
   * Base URL of the separate-origin sandbox server (e.g., "http://localhost:24680").
   * When provided, the outer iframe loads from this server instead of using srcdoc,
   * giving real cross-origin isolation that matches production hosts like ChatGPT.
   * Falls back to srcdoc when not provided (unit tests, embedded usage).
   */
  sandboxUrl?: string;
}

function computePreviewScale(
  availableWidth: number,
  availableHeight: number,
  frameWidth: number,
  frameHeight: number
): number {
  if (availableWidth <= 0 || availableHeight <= 0 || frameWidth <= 0 || frameHeight <= 0) {
    return 1;
  }
  return Math.min(1, availableWidth / frameWidth, availableHeight / frameHeight);
}

/**
 * IframeResource renders MCP Apps in an iframe, communicating via the
 * MCP Apps protocol (PostMessageTransport + AppBridge).
 *
 * Supports two modes:
 * - `src`: Load an HTML page directly (dev mode with Vite HMR)
 * - `scriptSrc`: Generate HTML wrapper for a JS file (production builds)
 *
 * The loaded app uses the MCP Apps SDK's useApp() hook which automatically
 * connects via PostMessageTransport to window.parent. The parent side uses
 * McpAppHost (wrapping AppBridge) to communicate.
 */
export function IframeResource({
  src,
  scriptSrc,
  html,
  hostContext,
  toolInput,
  toolInputPartial,
  toolResult,
  hostOptions,
  csp,
  permissions,
  prefersBorder,
  className,
  style,
  onDisplayModeReady,
  debugInjectState,
  injectOpenAIRuntime,
  sandboxUrl,
}: IframeResourceProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const previewStageRef = useRef<HTMLDivElement>(null);
  const [previewScale, setPreviewScale] = useState(1);
  const hostRef = useRef<McpAppHost | null>(null);

  // Determine which URL to validate (html mode has no URL — embedder supplies
  // the document body directly).
  const resourceUrl = src ?? scriptSrc;

  // Refs for resource data so the stable onSandboxReady callback can access current values
  // Refs for values that the stable onSandboxReady callback needs to access.
  // Without refs, the callback would capture stale values from the initial render.
  const srcRef = useRef(src);
  srcRef.current = src;
  const scriptSrcRef = useRef(scriptSrc);
  scriptSrcRef.current = scriptSrc;
  const htmlRef = useRef(html);
  htmlRef.current = html;
  const cspRef = useRef(csp);
  cspRef.current = csp;
  const hostContextRef = useRef(hostContext);
  hostContextRef.current = hostContext;
  const injectOpenAIRuntimeRef = useRef(injectOpenAIRuntime);
  injectOpenAIRuntimeRef.current = injectOpenAIRuntime;
  const permissionsRef = useRef(permissions);
  permissionsRef.current = permissions;

  // Track whether we've received an initial size report
  const hasReceivedSizeRef = useRef(false);

  // Track current display mode so the stable onSizeChanged callback can
  // skip auto-resizing in fullscreen (where the host container is fixed).
  const displayModeRef = useRef(hostContext?.displayMode);
  displayModeRef.current = hostContext?.displayMode;

  // Remember the last content-driven height so we can restore it when
  // leaving fullscreen (the app won't re-report until content changes).
  const lastContentHeightRef = useRef<number | null>(null);

  // Create the MCP Apps host
  const host = useMemo(
    () =>
      new McpAppHost({
        hostContext,
        ...hostOptions,
        onSizeChanged: (params) => {
          hostOptions?.onSizeChanged?.(params);
          if (params.height != null) {
            lastContentHeightRef.current = params.height;
          }
          // Skip auto-resizing in fullscreen mode where the host provides a
          // fixed container — auto-sizing would create a feedback loop with
          // viewport-relative units like dvh. PIP and inline use content-driven sizing.
          if (displayModeRef.current === 'fullscreen') return;
          const iframe = iframeRef.current;
          if (!iframe) return;

          // Border-box compensation: if the iframe has borders, add their
          // width/height so the content area matches the reported size.
          // Pattern from ext-apps basic-host reference implementation.
          const style = getComputedStyle(iframe);
          const isBorderBox = style.boxSizing === 'border-box';

          const from: Record<string, string> = {};
          const to: Record<string, string> = {};

          if (params.width != null) {
            let w = params.width;
            if (isBorderBox) {
              w += parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth);
            }
            // Use min-width with min() to allow responsive growing while
            // respecting the content's minimum width.
            from.minWidth = `${iframe.offsetWidth}px`;
            iframe.style.minWidth = `min(${w}px, 100%)`;
            to.minWidth = `min(${w}px, 100%)`;
          }
          if (params.height != null) {
            hasReceivedSizeRef.current = true;
            let h = params.height;
            if (isBorderBox) {
              h += parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
            }
            from.height = `${iframe.offsetHeight}px`;
            iframe.style.height = `${h}px`;
            to.height = `${h}px`;
          }

          // Smooth animated transition for size changes.
          if (Object.keys(from).length > 0) {
            iframe.animate([from, to], { duration: 300, easing: 'ease-out' });
          }
        },
        onDisplayModeReady: (mode) => onDisplayModeReady?.(mode),
        onSandboxReady: () => {
          // The sandbox proxy is ready. Deliver the app content.
          const currentSrc = srcRef.current;
          const currentScriptSrc = scriptSrcRef.current;
          const currentHtml = htmlRef.current;
          const currentHost = hostRef.current;
          if (!currentHost) return;

          if (currentHtml) {
            // html mode: the embedder handed us a complete HTML document
            // (typically from mcpClient.readResource). Inject the paint-fence
            // responder and (when enabled) the mock platform runtime, then
            // hand the document to the proxy via the existing
            // sandbox-resource-ready protocol.
            const platformScriptStr = injectOpenAIRuntimeRef.current
              ? MOCK_OPENAI_RUNTIME_SCRIPT
              : undefined;
            const finalHtml = injectInfraScripts(currentHtml, platformScriptStr);
            currentHost.sendSandboxResourceReady({
              html: finalHtml,
              sandbox:
                'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
            });
            if (iframeRef.current) {
              iframeRef.current.style.opacity = '1';
              iframeRef.current.style.transition = 'opacity 100ms';
            }
          } else if (currentScriptSrc) {
            // scriptSrc mode (prod): use the official sandbox-resource-ready protocol.
            // Generate the full app HTML and send it to the proxy.
            const absoluteScriptSrc = currentScriptSrc.startsWith('/')
              ? `${window.location.origin}${currentScriptSrc}`
              : currentScriptSrc;
            const cspPolicy = generateCSP(cspRef.current, absoluteScriptSrc);
            const theme = hostContextRef.current?.theme ?? 'dark';
            const platformScriptStr = injectOpenAIRuntimeRef.current
              ? MOCK_OPENAI_RUNTIME_SCRIPT
              : undefined;
            const appHtml = generateScriptHtml(
              absoluteScriptSrc,
              theme,
              cspPolicy,
              platformScriptStr
            );

            currentHost.sendSandboxResourceReady({
              html: appHtml,
              sandbox:
                'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox',
            });

            // Fade in the outer iframe
            if (iframeRef.current) {
              iframeRef.current.style.opacity = '1';
              iframeRef.current.style.transition = 'opacity 100ms';
            }
          } else if (currentSrc) {
            // src mode (dev): send the URL to the proxy for inner iframe src loading.
            // This is a inspector-specific extension — the proxy creates an inner iframe
            // with src pointing to the Vite dev server, preserving HMR.
            //
            // When using a separate-origin sandbox server, the src must be absolute
            // (relative paths would resolve against the sandbox origin, not the Vite server).
            const absoluteSrc = currentSrc.startsWith('/')
              ? `${window.location.origin}${currentSrc}`
              : currentSrc;
            const allowAttr = buildIframeAllow(permissionsRef.current);
            currentHost.sendRawMessage({
              jsonrpc: '2.0',
              method: 'sunpeak/sandbox-load-src',
              params: {
                src: absoluteSrc,
                allow: allowAttr,
                theme: hostContextRef.current?.theme,
                styleVars: hostContextRef.current?.styles?.variables,
              },
            });
          }
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // Stable - create once
  );
  hostRef.current = host;

  // Connect bridge transport as soon as the iframe element exists in the DOM,
  // before the browser loads the iframe content. For built HTML files with
  // inline scripts (same-origin), React effects inside the iframe can fire
  // before the parent's onLoad event, causing the app's `initialize` request
  // to be lost if the bridge transport isn't listening yet.
  const setIframeRef = useCallback(
    (node: HTMLIFrameElement | null) => {
      iframeRef.current = node;
      if (node?.contentWindow) {
        host.connectToIframe(node.contentWindow);
      }
    },
    [host]
  );

  // The outer iframe loads the sandbox proxy HTML. Show it immediately since
  // it's just the proxy shell. The proxy handles inner iframe creation and content.
  const handleLoad = useCallback(() => {
    if (iframeRef.current) {
      iframeRef.current.style.opacity = '1';
      iframeRef.current.style.transition = 'opacity 100ms';
    }
  }, []);

  // Sync mutable host options (e.g. onCallTool) into the existing host
  // instance when they change, without recreating the connection.
  useEffect(() => {
    if (hostOptions) {
      host.updateOptions(hostOptions);
    }
  }, [host, hostOptions]);

  // Update host context when props change.
  // McpAppHost.setHostContext() internally detects display mode changes
  // and waits for the iframe to commit its DOM before firing onDisplayModeReady.
  useEffect(() => {
    if (hostContext) {
      host.setHostContext(hostContext);
    }
    // In fullscreen the host provides a fixed container, so the iframe
    // should fill it. When leaving fullscreen, restore the last content-driven
    // height so the iframe isn't stuck at 100% or collapsed.
    if (iframeRef.current) {
      if (hostContext?.displayMode === 'fullscreen') {
        iframeRef.current.style.height = '100%';
      } else if (lastContentHeightRef.current != null) {
        iframeRef.current.style.height = `${lastContentHeightRef.current}px`;
      }
    }
  }, [host, hostContext]);

  // Send tool input updates
  // Note: Don't check host.initialized here - McpAppHost handles queueing internally
  useEffect(() => {
    if (toolInput) {
      host.sendToolInput(toolInput);
    }
  }, [host, toolInput]);

  // Send partial/streaming tool input
  useEffect(() => {
    if (toolInputPartial) {
      host.sendToolInputPartial(toolInputPartial);
    }
  }, [host, toolInputPartial]);

  // Send tool result updates
  // Note: Don't check host.initialized here - McpAppHost handles queueing internally
  useEffect(() => {
    if (toolResult) {
      host.sendToolResult(toolResult);
    }
  }, [host, toolResult]);

  // Debug: Inject state directly into app's useAppState hook
  useEffect(() => {
    if (debugInjectState != null) {
      host.injectState(debugInjectState);
    }
  }, [host, debugInjectState]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      hostRef.current?.close();
    };
  }, []);

  // Validate URL
  const isValidUrl = useMemo(() => resourceUrl && isAllowedUrl(resourceUrl), [resourceUrl]);

  // Build iframe allow attribute from resource permissions
  const allowAttribute = useMemo(() => buildIframeAllow(permissions), [permissions]);

  // Border style when resource declares prefersBorder
  const borderStyle: React.CSSProperties = prefersBorder
    ? { border: '1px solid var(--color-border-primary, #e5e7eb)' }
    : { border: 'none' };

  // Build sandbox proxy content. When a separate-origin sandbox server is available,
  // use its URL for real cross-origin isolation (matching production hosts).
  // Otherwise fall back to srcdoc with the proxy HTML (for unit tests, embedded use).
  // Build sandbox proxy URL/HTML. These must NOT depend on theme — changing
  // theme should not reload the iframe (which would destroy app state and
  // show a loading flash). Theme is propagated to the app via hostContext
  // through PostMessage, not via iframe src/srcdoc.
  const sandboxSrc = useMemo(() => {
    if (!sandboxUrl) return undefined;
    // Two supported shapes for sandboxUrl:
    //   1. Host root, e.g. "http://localhost:24680" — append "/proxy" (the
    //      CLI dev server convention from `startSandboxServer`).
    //   2. Full URL, e.g. "https://sandbox.example.com/sandbox-proxy.html"
    //      — use as-is. Embedders hosting the static `dist/sandbox-proxy.html`
    //      pass the file's full URL.
    // We treat anything with a path beyond "/" as a full URL.
    let url: URL;
    try {
      const parsed = new URL(sandboxUrl);
      const hasPath = parsed.pathname && parsed.pathname !== '/';
      url = hasPath ? parsed : new URL('/proxy', sandboxUrl);
    } catch {
      return undefined;
    }
    // Reject anything that isn't http(s). The URL constructor accepts
    // `javascript:` and `data:` schemes; while modern browsers block
    // `javascript:` in cross-origin iframe src, treating non-http(s) values
    // here as invalid matches the precedent set by the OAuth flow and the
    // mock `openExternal` runtime, and removes a class of footguns.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      console.warn('[IframeResource] Ignoring non-http(s) sandboxUrl:', sandboxUrl);
      return undefined;
    }
    if (injectOpenAIRuntime) url.searchParams.set('platform', 'chatgpt');
    return url.toString();
  }, [sandboxUrl, injectOpenAIRuntime]);

  const proxyHtml = useMemo(() => {
    if (sandboxSrc) return undefined;
    const platformScript = injectOpenAIRuntime ? MOCK_OPENAI_RUNTIME_SCRIPT : undefined;
    return generateSandboxProxyHtml(platformScript);
  }, [sandboxSrc, injectOpenAIRuntime]);

  const iframeStyle: React.CSSProperties = {
    ...borderStyle,
    background: 'transparent',
    colorScheme: hostContext?.theme === 'light' ? 'light dark' : 'dark light',
    // Start hidden; handleLoad fades in via direct DOM update
    opacity: 0,
    width: '100%',
    // In fullscreen, fill the container immediately. In other modes, use
    // minHeight to prevent collapse while waiting for the app to report size.
    ...(hostContext?.displayMode === 'fullscreen' ? { height: '100%' } : { minHeight: '200px' }),
    ...style,
  };

  // Apply containerDimensions constraints as a host-side wrapper so the app
  // reports its natural size via sizechange (no feedback loop) while the
  // inspector visually enforces the configured dimensions.
  //
  // height / maxHeight → clip the iframe vertically with overflow:hidden.
  //   Using a wrapper (not SafeArea inside the app) is intentional: if the
  //   app were to apply the height constraint internally, sizechange would
  //   echo the constrained value back and the host would lock in that size.
  // width / maxWidth → constrain the wrapper's width; the iframe fills 100%.
  //
  // The wrapper div is always rendered (never conditional) so that adding or
  // removing constraints is a style update, not a tree change. Conditionally
  // toggling the wrapper would unmount/remount the iframe mid-handshake,
  // which causes the tool result to never reach the app.
  const dims = hostContext?.containerDimensions;
  const wrapperStyle: React.CSSProperties = {};
  let frameWidth: number | undefined;
  let frameHeight: number | undefined;
  if (dims) {
    const h = 'height' in dims ? dims.height : undefined;
    const mh = 'maxHeight' in dims ? dims.maxHeight : undefined;
    const w = 'width' in dims ? dims.width : undefined;
    const mw = 'maxWidth' in dims ? dims.maxWidth : undefined;
    frameWidth = w;
    frameHeight = h;
    if (h != null) {
      wrapperStyle.height = h;
      wrapperStyle.overflow = 'hidden';
    }
    if (mh != null) {
      wrapperStyle.maxHeight = mh;
      wrapperStyle.overflow = 'hidden';
    }
    if (w != null) wrapperStyle.width = w;
    if (mw != null) wrapperStyle.maxWidth = mw;
  }

  const shouldScalePreview =
    hostContext?.displayMode === 'fullscreen' && frameWidth != null && frameHeight != null;

  useLayoutEffect(() => {
    if (!shouldScalePreview || frameWidth == null || frameHeight == null) {
      setPreviewScale(1);
      return;
    }

    const stage = previewStageRef.current;
    if (!stage) return;
    const updateScale = () => {
      const bounds = stage.getBoundingClientRect();
      const nextScale = computePreviewScale(bounds.width, bounds.height, frameWidth, frameHeight);
      setPreviewScale((current) => (Math.abs(current - nextScale) < 0.0001 ? current : nextScale));
    };

    updateScale();
    const observer = new ResizeObserver(updateScale);
    observer.observe(stage);
    window.addEventListener('resize', updateScale);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateScale);
    };
  }, [shouldScalePreview, frameWidth, frameHeight]);

  const previewStageStyle: React.CSSProperties = shouldScalePreview
    ? {
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
      }
    : { display: 'contents' };
  const previewFrameStyle: React.CSSProperties = shouldScalePreview
    ? {
        ...wrapperStyle,
        flex: '0 0 auto',
        transform: `scale(${previewScale})`,
        transformOrigin: 'top center',
      }
    : wrapperStyle;

  // Validate URL for src mode
  if (src && !isValidUrl) {
    console.error('[IframeResource] URL not allowed:', src);
    return <div style={{ color: 'red', padding: 20 }}>Error: URL not allowed: {src}</div>;
  }
  if (scriptSrc && !isValidUrl) {
    console.error('[IframeResource] Script source not allowed:', scriptSrc);
    return <div style={{ color: 'red', padding: 20 }}>Error: Script source not allowed.</div>;
  }

  // Both src and scriptSrc modes use the sandbox proxy. The proxy creates
  // the inner iframe after receiving content via onSandboxReady.
  return (
    <div ref={previewStageRef} data-sunpeak-preview-stage style={previewStageStyle}>
      <div className={className} data-sunpeak-preview-frame style={previewFrameStyle}>
        <iframe
          ref={setIframeRef}
          onLoad={handleLoad}
          style={iframeStyle}
          title="Resource Preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          allow={allowAttribute}
          src={sandboxSrc ?? undefined}
          srcDoc={sandboxSrc ? undefined : proxyHtml}
        />
      </div>
    </div>
  );
}

// Export security helpers for testing
export const _testExports = {
  escapeHtml,
  isAllowedUrl,
  isValidCspSource,
  generateCSP,
  generateScriptHtml,
  buildIframeAllow,
  computePreviewScale,
  ALLOWED_SCRIPT_ORIGINS,
};
