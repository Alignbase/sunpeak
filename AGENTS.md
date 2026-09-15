# sunpeak

Note that "sunpeak", except where required in URLs or code, is always lowercase.

sunpeak is a framework for building MCP Apps with interactive UIs that run inside AI chat hosts (ChatGPT, Claude, and future major hosts). Built on top of the MCP Apps SDK (`@modelcontextprotocol/ext-apps`).

ChatGPT apps are now submitted and published as plugins. The app portion is still based on MCP Apps or the OpenAI Apps SDK, so sunpeak's protocol and runtime architecture do not change. Adding a custom app requires ChatGPT Developer mode, enabled from the bottom-left user menu under `Settings > Security and login > Developer mode`. Local developer-mode apps are then created from the ChatGPT homepage under `Plugins > +`, while public apps are submitted as MCP-backed plugins through the OpenAI Platform.

The value proposition of the sunpeak framework is to help developers and their agents:

1. Test MCP Apps locally and automatically (in CI/CD) using a replica of the ChatGPT and Claude runtimes.
   1. Save time manually testing all possible host, server, app, ui, and backend states.
   2. Protect developers from 4-click manual refreshes on every code change in each host.
   3. Cancel all the $20 per person per host per month testing accounts.
   4. Avoid burning host credits on every test and code change.
2. Verify MCP tools work across multiple LLM models via the eval framework. Evals connect to the MCP server, discover tools, and send prompts to multiple models (GPT-4o, GPT-4o-mini, o4-mini, Claude Sonnet, Gemini 2.0 Flash) via the Vercel AI SDK. Cases can include App Context for follow-up turns that depend on model-visible UI state. Each case runs N times per model and reports pass/fail counts, so developers can confirm that tool descriptions, schemas, and App Context work reliably on smaller and cheaper models. Opt-in via `sunpeak test --eval` because evals cost money.
3. Automate the real-host testing loop with **live tests** (`sunpeak test --live`): scripts that drive a real browser into ChatGPT (and other hosts as they're supported), send prompts that trigger MCP tool calls against the developer's server, and assert against the actually-rendered app via Playwright. Live tests catch what the inspector can't (real MCP connection behavior, real LLM tool invocation, host-specific iframe rendering, production resource loading) and replace the manual prompt-and-click loop. Opt-in because they hit real accounts.
4. Build multi-platform MCP Apps in a structured way that's easy to understand and get started.
5. Test their MCPs in ChatGPT with HMR and Claude with automatic rebuilds and refresh notifications.
6. **Embed the Inspector as a React component** inside any third-party React app to render arbitrary MCP Apps. The `<Inspector app={...} onCallTool={...} />` shape exposes the same double-iframe runtime, host shells, and conversation chrome as the CLI inspector, but without any sunpeak-owned servers or `/__sunpeak/*` runtime dependencies. Tool calls flow through a callback the embedder owns; resource HTML is passed as a string. Embedders host the static sandbox proxy (`dist/sandbox-proxy.html`) on a separate origin from their own app — or fall back to the same-origin `srcdoc` variant for zero deployment. This is a first-class use case; treat it as load-bearing when designing changes.

## Embedded Inspector — design constraints

Maintain these properties when changing the Inspector or its supporting code:

- **Public hierarchical API**: the `app` prop on `<Inspector />` is the public input shape for embedders (`InspectorApp` → resources + tools → simulations). Flatten internally; never require embedders to learn the legacy flat `simulations` map.
- **No `/__sunpeak/*` runtime dependencies in the React component**: the bundled Inspector must not assume any sunpeak-owned HTTP endpoints exist in the embedder's origin. Health checks, tool calls, simulation discovery, and OAuth all flow through props (`onCallTool`, `app.resources[].html`) or are gated off in embedded mode.
- **Two CSS entries — keep them aligned**: `sunpeak/style.css` ships full Tailwind preflight (used by resources loading into iframe documents — `pnpm dev` and the CLI / template path). `sunpeak/embed.css` ships the same Tailwind utilities + theme, but with preflight scoped under `.sunpeak-inspector-root` (used by embedders hosting the Inspector inside another React app). When changing the scoped preflight rules, update both files — `src/inspector/globals.css` (for style.css, full preflight via `@import "tailwindcss"`) and `src/embed.css` (scoped preflight, theme + utilities only). Embed mode invariant: the host page's `<button>`, `<input>`, typography, and `data-theme` attribute must be untouched. The one acknowledged document-level injection is host `@font-face` (inert to host pages).
- **Theme + host-context application stays root-scoped**: variables, color-scheme, `data-theme` go on the Inspector's root ref, not `document.documentElement`. The `ThemeProvider` default still targets the document for callers using it outside the bundled Inspector — the Inspector overrides with a no-op.
- **Sizing follows the parent in embedded mode**: when `app` is provided, the root uses `h-full w-full` (fills the container the embedder gives it) instead of `h-screen w-screen` (fills the viewport). Don't reintroduce viewport-relative sizing in the embedded path.
- **Sandbox proxy is delivered three ways**: hosted static file (`dist/sandbox-proxy.html`, ~7KB, runtime-configurable via URL params), CLI dev server (`startSandboxServer`), and `srcdoc` fallback (same-origin, lower fidelity). All three must stay behaviorally identical — see `src/inspector/sandbox-static.test.ts` for the drift guard.
- **Mutually exclusive props**: `app` and `simulations` are mutually exclusive; `app` wins and emits a one-time `console.warn`. Don't add a third way in.
- **Simulation `name` vs `displayName`**: `Simulation.name` is the unique internal key (`<toolName>__<userSimName>` for the embed path); `Simulation.displayName` is the user-facing sidebar label (the embedder's raw `sim.name`). Don't collapse them — `name` is what URL deep-links and state indexing rely on; `displayName` is purely cosmetic. Sidebar code falls back to `name` when `displayName` is absent.
- **Backend-only tools are first-class**: tools without UI resources stay visible in the tool picker and can be called from the sidebar or model chat. Show `Tool does not render a UI` only when a backend-only tool is selected and no model conversation is rendering; once a model conversation starts, show the transcript and tool-call metadata. If the model later calls a UI tool, render that UI as usual.
- **Security invariants (don't regress these)**:
  - The inline helper script (`src/inspector/inline-helper-script.ts`) must keep its `ev.source === window.parent` guard on incoming messages. Sibling iframes and extension content scripts could otherwise forge `ui/notifications/tool-result` and drive the embedder's callbacks with attacker-controlled data.
  - `sandboxUrl` validation rejects non-http(s) URLs — match this precedent if adding any new URL-accepting prop.
  - The Inspector does **no** sanitization of `app.resources[].html`. Don't add accidental innerHTML paths that read from resources, tool results, or other embedder-supplied strings — React's text-node escaping is the only XSS defense.
  - Tool result JSON is escaped (`<` → `<`) when injected into the `<script id="__tool-result">` data island. Don't switch to a less-escaped serialization.
  - The mock `openExternal` runtime in `mock-openai-runtime.ts` rejects non-http(s) URLs and uses `noopener,noreferrer`. Preserve both when changing the runtime.
  - The `srcdoc` fallback is documented as **not safe for untrusted HTML** (runs in the host's origin via `allow-same-origin` + same-origin srcdoc). Keep the separate-origin sandbox file as the recommended production path.
- **Data-source agnostic**: the same `app` + `onCallTool` API covers three patterns and the Inspector renders identically in all of them. (a) Live MCP server — `app.resources[].html` comes from `mcpClient.readResource(...)` and `onCallTool` forwards to `mcpClient.callTool(...)`. (b) Static / no-server — HTML is a string literal and `onCallTool` returns canned responses (or simulations carry pre-canned `toolResult`s so it's never called). (c) Hybrid — live MCP discovery plus saved simulations per tool, letting users flip between "None" (live call) and saved states (canned result). Don't add branches that assume one mode over the others; the Inspector should never know which it's in. Embedders proxying live MCP through their own backend (typical: `/api/mcp/...`) is the embedder's concern, not sunpeak's — the React component never makes outbound MCP calls itself.

## Quick Reference

```bash
pnpm --filter sunpeak test -- --run    # Unit tests (vitest)
pnpm --filter sunpeak lint             # ESLint
pnpm --filter sunpeak typecheck        # tsc --noEmit
pnpm --filter sunpeak build            # Vite build
pnpm --filter sunpeak validate         # Full validation (lint + build + test + examples)
pnpm --filter sunpeak generate-examples  # Regenerate examples/ from template
```

## Architecture

**All resource content renders inside iframes** — never directly in the host page. This matches how AI chat hosts (ChatGPT, Claude) display apps and enables direct re-export of SDK hooks.

### Multi-Host Inspector

The inspector supports multiple host platforms via a **HostShell** abstraction. Each host provides:
- **Conversation chrome** — the visual shell (message bubbles, headers, input areas)
- **Theme** — host-specific CSS variables and theme application
- **Host info & capabilities** — reported to the app via MCP protocol

Switching hosts in the sidebar changes the conversation chrome, theming, and reported host info/capabilities. The sidebar controls, iframe infrastructure, and state management are shared.

### Rendering Flow (Double-Iframe Sandbox Architecture)
1. `Inspector` (host page) → `HostShell.Conversation` → `IframeResource`
2. `IframeResource` creates an outer `<iframe>` containing a **sandbox proxy** that relays PostMessage between the host and an inner iframe holding the actual app. This two-level architecture matches how production hosts (ChatGPT, Claude) isolate app iframes on a separate origin (e.g., `web-sandbox.oaiusercontent.com`).
   - **Outer iframe**: Loads the sandbox proxy from a separate-origin server (port 24680) or via `srcdoc` (fallback for unit tests).
   - **Inner iframe**: Created by the proxy, loads the app HTML via `src` (dev: Vite HMR URL) or `document.write()` (prod: generated HTML).
3. `McpAppHost` wraps the SDK's `AppBridge` for host-side communication. Messages flow: host ↔ outer iframe (proxy) ↔ inner iframe (app), all via PostMessage relay.
4. Inside the inner iframe, the resource component uses `useApp()` which connects via `PostMessageTransport` to `window.parent` (the proxy), which relays to the host.

**The cross-origin relationship between iframes is intentional and must be preserved.** The outer iframe (sandbox proxy, port 24680), inner iframe (resource HTML, proxied through the inspector on port 3000), and the Vite dev server (port 8000) are deliberately on different origins. This replicates production CSP behavior where the host, sandbox, and app content live on separate origins. Do not "fix" cross-origin issues by collapsing these onto the same origin — that would make the inspector less representative of production and mask real CSP bugs.

**Safari is incompatible with `sunpeak dev`.** Safari upgrades cross-origin HTTP requests to HTTPS, which breaks the multi-port localhost architecture. This is a known limitation with no workaround. Use Chrome for development. Production deploys (`sunpeak start`) work in all browsers because the app is a single bundled page without cross-origin localhost dependencies.

### E2E Tests
Tests use `page.frameLocator('iframe').frameLocator('iframe')` to access resource content inside the double-iframe. Elements on the inspector chrome (header, `#root`) use `page.locator()` directly. Console error tests filter expected MCP handshake errors.

### Live Tests (`pnpm test:live`)
Automated tests against real ChatGPT using Playwright. Uses the same `ChatGPTPage` class for selectors, message sending, and iframe handling. Auth flow: saved session → manual login in the opened browser window. Sessions typically last only a few hours because Cloudflare's HttpOnly `cf_clearance` cookie cannot be persisted by `storageState()`. The `global-setup.mjs` handles auth + MCP server refresh in the same browser session (refresh must happen before the browser closes while `cf_clearance` is still valid).

## Package Structure

```
packages/sunpeak/
├── src/
│   ├── index.ts              # Main barrel: SDK re-exports + hooks + types
│   ├── inspector/            # Generic multi-host inspector core
│   │   ├── inspector.tsx     # Inspector component (host picker, sidebar, delegates to shell)
│   │   ├── use-inspector-state.ts  # All inspector state management
│   │   ├── hosts.ts          # HostShell interface + registry
│   │   ├── mcp-app-host.ts   # MCP Apps bridge wrapper (generic, supports streaming partials)
│   │   ├── iframe-resource.tsx  # Iframe rendering + double-iframe sandbox proxy
│   │   ├── sandbox-proxy.ts    # Sandbox proxy HTML generation (srcdoc fallback)
│   │   ├── simple-sidebar.tsx   # Dev control panel
│   │   └── theme-provider.tsx   # Pluggable theme provider
│   ├── chatgpt/              # ChatGPT host shell
│   │   ├── chatgpt-conversation.tsx  # ChatGPT conversation chrome
│   │   └── chatgpt-host.ts   # Host registration (theme, capabilities)
│   ├── claude/               # Claude host shell
│   │   ├── claude-conversation.tsx   # Claude conversation chrome
│   │   └── claude-host.ts    # Host registration (theme, capabilities)
│   ├── hooks/                # React hooks (useApp, useHostContext, useToolData, useAppState, useUpdateModelContext, useAppTools, useCreateSamplingMessage, useRegisterTool, useSendToolListChanged, etc.)
│   ├── mcp/                  # MCP server (runMCPServer, production-server, resource registration)
│   ├── host/                 # Host detection (detectHost, isChatGPT, isClaude)
│   │   └── chatgpt/          # ChatGPT-specific: useUploadFile, useRequestModal, useRequestCheckout
│   ├── eval/                 # Eval framework tests (implementation in bin/lib/eval/)
│   ├── lib/                  # Utilities (discovery, cn(), media queries)
│   ├── types/                # Type definitions (Simulation, runtime types)
│   └── cli/                  # CLI commands
├── template/                 # Scaffolded app template (also a workspace package)
│   ├── src/resources/        # Example resource components (albums, carousel, map, review)
│   ├── src/tools/            # Tool files with handlers and metadata
│   ├── src/server.ts         # Optional server entry (auth, config)
│   └── tests/                # Unit tests, E2E tests, simulations, live tests, evals
└── scripts/
    ├── validate.mjs           # Full validation pipeline
    └── generate-examples.mjs  # Generate examples/ from template resources
```

### Export Map (`sunpeak`)
- `sunpeak` — Hooks, types, SDK re-exports (`App`, `RESOURCE_MIME_TYPE`, `LATEST_PROTOCOL_VERSION`, etc.), `inspector` + `chatgpt` namespaces
- `sunpeak/inspector` — Generic Inspector, host shell system, infrastructure
- `sunpeak/chatgpt` — ChatGPT host shell registration + Inspector re-export
- `sunpeak/claude` — Claude host shell registration + Inspector re-export
- `sunpeak/mcp` — Server utilities (`runMCPServer`, `createMcpHandler`, `createHandler`, `createProductionMcpServer`, `startProductionHttpServer`, `setJsonLogging`, `detectClientFromHeaders`), tool types (`AppToolConfig`, `ToolHandlerExtra`, `CallToolResult`, `AuthInfo`), server config (`ServerConfig`, `MCPServerConfig`, `MCPServerHandle`), production types (`ProductionTool`, `ProductionResource`, `ProductionServerConfig`, `HttpServerOptions`, `AuthFunction`, `WebAuthFunction`, `WebHandlerConfig`), domain resolution (`resolveDomain`, `computeClaudeDomain`, `computeChatGPTDomain`, `injectResolvedDomain`, `injectDefaultDomain`, `DomainConfig`), favicon (`FAVICON_BASE64`, `FAVICON_DATA_URI`, `FAVICON_BUFFER`), SDK server helpers (`registerAppTool`, `registerAppResource`, `getUiCapability`, `EXTENSION_ID`, `RESOURCE_URI_META_KEY`, `RESOURCE_MIME_TYPE`, `McpUiAppToolConfig`, `McpUiAppResourceConfig`, `ToolConfig`, `ToolCallback`, `ReadResourceCallback`, `ResourceMetadata`)
- `sunpeak/host` — Host detection
- `sunpeak/host/chatgpt` — ChatGPT-specific hooks (file upload, modals, checkout)
- `sunpeak/test` — MCP-first Playwright fixtures (`test` with `mcp` fixture for protocol methods: `callTool(name, input?)`, `listTools()`, `listResources()`, `readResource(uri)`; and `inspector` fixture for rendering: `renderTool(name, input?, options?)` returning `InspectorResult` with `app()`, `source`, `screenshot()`; plus `inspector.host`, `inspector.page`; `expect` with MCP-native matchers)
- `sunpeak/test/config` — Playwright config factory (`defineConfig` — auto-detects sunpeak projects, or accepts `server` option for external MCP servers; `server` supports `command`, `args`, `url`, `env`, `cwd`; top-level `timeout` for server startup; `visual` option for visual regression config)
- `sunpeak/test/live` — Host-agnostic Playwright fixtures for live testing (`test` with `live` fixture, `expect`, `setColorScheme`)
- `sunpeak/test/live/config` — Live test config factory (`defineLiveConfig` with `hosts` array and optional `server` for external MCP servers)
- `sunpeak/test/live/chatgpt` — ChatGPT-specific Playwright fixtures (`test` with `chatgpt` fixture)
- `sunpeak/eval` — Eval framework (`defineEval`, `defineEvalConfig`, `checkExpectations`, `createMcpConnection`, `discoverAndConvertTools`, `normalizeEvalAppContext`, `formatEvalAppContextForModel`, `runEvalCaseAggregate`)
- `sunpeak/test/live/chatgpt/config` — ChatGPT-specific Playwright config factory
- `sunpeak/test/inspect/config` — Inspect config factory for external MCP servers (`defineInspectConfig`; supports `env`, `cwd`, `timeout`, `visual` options)
- `sunpeak/inspect` — Programmatic inspector server (`inspectServer` — start the inspector from code instead of CLI; accepts `server`, `port`, `env`, `cwd`, etc.)
- `sunpeak/style.css` — Full-preflight stylesheet for resources rendered inside iframe documents (CLI dev / template path)
- `sunpeak/embed.css` — Scoped-preflight stylesheet for embedders hosting the Inspector inside their own React app

## Key Types

```typescript
// Tool file export (src/tools/{name}.ts)
interface AppToolConfig extends ToolConfig {
  resource?: string;           // Resource name (derived from directory: src/resources/{name}/). Omit for tools without a UI.
}

// Simulation fixture (tests/simulations/*.json)
interface SimulationJson {
  tool: string;                // References tool filename (e.g., "show-albums")
  userMessage?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: { structuredContent?: unknown };
  serverTools?: Record<string, ServerToolMock>;  // Mock responses for callServerTool calls
}

// ServerToolMock: simple (single result) or conditional (when/result array)
type ServerToolMock =
  | CallToolResult
  | Array<{ when: Record<string, unknown>; result: CallToolResult }>;

// Internal simulation (dev server runtime)
interface Simulation {
  name: string;
  resourceUrl?: string;        // Dev: HTML page URL (Vite HMR)
  resourceScript?: string;     // Prod: JS bundle URL
  tool: Tool;
  resource?: Resource;                 // Undefined for tools without a UI
  toolInput?: Record<string, unknown>;
  toolResult?: { content?: [...]; structuredContent?: unknown };
  serverTools?: Record<string, ServerToolMock>;  // Mock responses for callServerTool
}

interface HostShell {
  id: string;                              // 'chatgpt' | 'claude'
  label: string;                           // Display name in sidebar
  Conversation: ComponentType<HostConversationProps>;
  applyTheme: (theme: 'light' | 'dark') => void;
  hostInfo: { name: string; version: string };
  hostCapabilities: McpUiHostCapabilities;
  userAgent?: string;                      // e.g. 'chatgpt', 'claude'
}
```

## Dev Server (`bin/commands/dev.mjs`)

`sunpeak dev` starts the local MCP server (with Vite HMR for resources) and then launches the inspector pointed at it. This means `sunpeak dev` and `sunpeak inspect` share the same inspector UI codepath — the inspector is the single entry point for all inspector use cases.

Architecture:
1. **MCP server** — Started via `runMCPServer()` with `viteMode: true`. Serves tools, resources (with Vite HMR scripts in `readResource` HTML), and simulation data via a custom `sunpeak/simulations` MCP method.
2. **Inspector** — `inspectServer()` from `inspect.mjs` connects to the MCP server URL, discovers tools/resources via MCP protocol, and serves the inspector UI with HMR.
3. **sandboxServer** — A minimal HTTP server on a separate port (default 24680) for cross-origin iframe isolation.

Port management: The MCP server prefers port 8000 (configurable via `SUNPEAK_MCP_PORT`, users typically have an ngrok tunnel on this port). The inspector's Vite dev server uses port 24679 for its HMR WebSocket. The sandboxServer uses port 24680 (configurable via `SUNPEAK_SANDBOX_PORT`). The main dev server listens on the user-facing port (default 3000). All ports use `getPort()` to find free alternatives if the preferred port is taken.

### `--prod-tools` and `--prod-resources` flags

Two orthogonal flags that toggle real tool handlers and production resource bundles independently:

| Flags | UI | Tools | Use case |
|-------|-----|-------|----------|
| *(none)* | HMR | Mocked | Day-to-day dev |
| `--prod-tools` | HMR | Real handlers | Integration testing |
| `--prod-resources` | Built | Mocked | CI/E2E, catch build regressions |
| `--prod-tools --prod-resources` | Built | Real handlers | Final smoke test |

**Implementation**: Tool calls flow through MCP protocol to the local server (no Vite middleware). `--prod-tools` sets the initial state of the Prod Tools sidebar checkbox. `--prod-resources` runs `sunpeak build` before starting and sets the initial Prod Resources checkbox state. Both are runtime-toggleable in the sidebar. The `Inspector` component accepts `mcpServerUrl`, `defaultProdResources`, `hideInspectorModes`, `demoMode`, and `sandboxUrl` props.

### Dev Overlay

In development mode (`viteMode`), a small overlay appears in the bottom-right corner of every resource showing:
- **Resource:** HH:MM:SS timestamp when the resource HTML was generated (detects stale cached resources in ChatGPT)
- **Tool:** millisecond duration of the most recent tool call

The overlay is injected at `readResource` time in `getDevOverlayScript()` (server.ts). Both values are baked into the HTML: `servedAt` from `Date.now()`, `toolMs` from the module-level `lastToolTimingMs` (set by tool handlers on completion). For inspector re-runs (same iframe, new tool call), a PostMessage listener updates the timing via `_meta._sunpeak.requestTimeMs`.

The overlay is **never** present in production builds (only injected when `viteMode` is true). It can be disabled via:
- `devOverlay=false` URL param on the inspector (strips via regex in `/__sunpeak/read-resource`)
- `SUNPEAK_DEV_OVERLAY=false` environment variable (disables server-side injection)
- `defineLiveConfig({ devOverlay: false })` in live test configs (passes the env var to the dev server)

### Inspector URL Parameters

The inspector reads URL params (parsed in `use-inspector-state.ts`):
- `sidebar=false` — hides the sidebar, renders only conversation content (useful for headless testing or embedding)
- `devOverlay=false` — strips the dev overlay from resource HTML (for e2e tests where the overlay could interfere with assertions)
- `toolInput=<json>` — JSON-encoded tool arguments that override the simulation fixture's default toolInput (used by the `inspector` fixture when `renderTool` receives an `input` argument)
- `autoRun=true` — call the tool on load when no fixture data exists (set by test fixtures to get results without clicking Run; not set during interactive use)

Template e2e tests use the `mcp` and `inspector` fixtures from `sunpeak/test`, which set `devOverlay: false` automatically. The `dev-overlay.spec.ts` test files (excluded from `sunpeak new` via `dev-` prefix filter in `new.mjs`) test the overlay explicitly and import `createInspectorUrl` directly from `sunpeak/chatgpt`.

### sunpeak Is Three Things

Each layer works independently. The inspector and testing framework work with any MCP server in any language and can be embedded within other frameworks.

#### 1. App Framework

Convention-over-configuration for building MCP Apps. The inspector and testing are built in. `defineConfig()` auto-detects sunpeak projects and starts `sunpeak dev` as the backend. Template tests use the testing framework's fixtures and configs. For evals, the dev server auto-starts with `--prod-tools`.

#### 2. Testing Framework

Automated testing powered by the inspector. Works with any MCP server in any language. sunpeak's long-term goal is to be the generic testing framework for all MCP servers, not just MCP Apps. MCP Apps (interactive UIs in chat) are the current specialty, but the testing framework should work for any server that implements the MCP protocol. Keep MCP protocol primitives as a clean, 1:1 layer that can evolve with the spec. Layer sunpeak-specific functionality (inspector rendering, visual regression, simulations, MCP Apps features) on top without mixing it into the protocol layer.

The framework covers two distinct testing needs: (1) **runtime correctness** via e2e, visual, and live tests that exercise the replicated ChatGPT and Claude runtimes, and (2) **model compatibility** via the eval framework (`sunpeak/eval`), which connects to your MCP server, discovers tools via MCP protocol, and sends prompts to multiple models (GPT-4o, GPT-4o-mini, o4-mini, Claude Sonnet, Gemini 2.0 Flash) via the Vercel AI SDK. Eval cases can include `appContext` to test follow-up prompts that rely on state shared through `updateModelContext` or `useAppState`. Each case runs N times per model and reports pass/fail counts so developers can confirm tool descriptions, schemas, and App Context work reliably on smaller and cheaper models. Evals are opt-in (`--eval`) because they cost money.

**`mcp` fixture** (`sunpeak/test`) — protocol-only methods:
- `callTool(name, input?)` — call a tool, return the MCP result
- `listTools()` — list tool definitions
- `listResources()` — list resource definitions
- `readResource(uri)` — read resource content

**`inspector` fixture** (`sunpeak/test`) — rendering in the inspector:
- `renderTool(name, input?, options?)` — call a tool, render in the inspector, return `InspectorResult` with `app()` locator, `source` field (`'fixture'` or `'server'`), and `screenshot(name?, options?)` method
- `host` — current host ID (`'chatgpt'` or `'claude'`)
- `page` — raw Playwright `Page` for chrome-level assertions

`renderTool` with `input` navigates via `?tool=X&toolInput=JSON&autoRun=true` (real server call, bypasses fixtures). Without `input`, it uses `?simulation=X&autoRun=true` (uses fixture data when available, falls back to real call). `autoRun` tells the inspector to call the tool on load when no fixture result exists; interactive users don't set this flag so browsing tools doesn't trigger server calls. The fixture reads the tool result from a `<script id="__tool-result">` data element so MCP-native matchers (`toBeError`, `toHaveTextContent`, `toHaveStructuredContent`, `toHaveContentType`) operate on real data. Fixture timeouts are configurable via `use: { mcpTimeout }` in Playwright config or per-call `{ timeout }` option.

**Server configuration**: `defineConfig({ server: { command, args, url, env, cwd }, timeout })` connects to any MCP server. For non-JS projects, `sunpeak test init` scaffolds a self-contained `tests/sunpeak/` directory with its own `package.json` (version-pinned), auto-installs dependencies, and is ready to run. `sunpeak test` auto-discovers this directory from the project root.

**Embedding**: Other frameworks import `defineConfig` from `sunpeak/test/config` to generate Playwright configs programmatically. Binary resolution checks local `node_modules/.bin` first so sunpeak doesn't need to be installed globally.

**Test types**: E2E (`sunpeak/test`), Visual regression (`result.screenshot()` on `InspectorResult`), Live tests (`sunpeak/test/live` for real ChatGPT/Claude), Evals (`sunpeak/eval` for multi-model tool calling via Vercel AI SDK).

**CLI**: `sunpeak test` runs unit + e2e tests by default (unit tests only run if vitest is configured, i.e. app framework projects), `sunpeak test --e2e` runs only Playwright e2e tests, `sunpeak test --visual` runs e2e with visual regression comparison, `sunpeak test --visual --update` updates visual baselines, `sunpeak test --live` runs live tests against real hosts, `sunpeak test --eval` runs multi-model evals, `sunpeak test --unit` runs vitest unit tests (app framework projects only, not scaffolded by `test init`), `sunpeak test init` scaffolds test infrastructure (e2e, visual, live, eval — no unit tests). Flags are additive. `--update` implies `--visual`. `--eval` and `--live` are never included in the default run (they cost money).

#### 3. Inspector

Test any MCP server in replicated ChatGPT and Claude runtimes. No sunpeak project required.

- **CLI**: `sunpeak inspect --server <url>` or `sunpeak inspect --server "python server.py"`. Supports `--env KEY=VALUE` (repeatable) and `--cwd <path>` for stdio servers.
- **Programmatic**: `inspectServer()` from `sunpeak/inspect` lets other frameworks start the inspector from their own CLI.
- **OAuth**: Auto-negotiates MCP OAuth when servers return 401. Handles anonymous/auto-approved OAuth without user interaction. For interactive OAuth, opens the authorization URL in the user's browser and waits for the callback. Uses the MCP SDK's standard `OAuthClientProvider` interface.
- Built into `sunpeak dev` for app framework users.

## Documentation (`docs/`)

Docs are built with [Mintlify](https://mintlify.com). Structure:

- **`docs/docs.json`** — Navigation config. Three tabs: Documentation, API Reference, MCP Apps.
- **`docs/api-reference/hooks/`** — One `.mdx` file per sunpeak hook. Badge: `<Badge color="yellow">sunpeak API</Badge>`.
- **`docs/mcp-apps/`** — MCP Apps SDK documentation (protocol-level, not sunpeak-specific). Badge: `<Badge color="green">MCP Apps SDK</Badge>`.
- **`docs/mcp-apps/types/protocol-reference.mdx`** — Complete protocol type/schema reference.

When adding new hooks or features, you must: create the hook doc page, add it to `docs.json` navigation (alphabetical within its group), and update cross-references (e.g., the `<Tip>` in `mcp-apps/app/requests.mdx` that lists convenience hooks).

**Path consistency**: File paths, `docs.json` group names, and resulting URL paths must stay consistent. When creating or moving doc pages, the file's directory should match the nav group it belongs to (e.g., a page in the "Server" group lives under `mcp-apps/server/`). If a file move changes a URL, add a Mintlify redirect in `docs.json` `"redirects"` to preserve SEO and update all internal links to the new path.

### Places to Update When User-Facing Functionality Changes

When sunpeak package APIs change (new hooks, new features, deprecations, etc.), these locations may need updating:

1. **`docs/`** — Mintlify docs pages (hook docs, MCP Apps SDK docs, cross-references)
2. **READMEs** — `README.md` files throughout the monorepo (`packages/sunpeak/README.md`, root `README.md`, template `README.md`)
3. **`skills/create-sunpeak-app/SKILL.md`** — Agent skill for building MCP Apps (hooks, patterns, simulations)
4. **`skills/test-mcp-server/SKILL.md`** — Agent skill for testing MCP servers (e2e, visual, live, evals)
5. **`bin/lib/eval/eval-providers.mjs`** — Single source of truth for eval provider packages, model IDs, and CLI labels. Both `sunpeak new` and `sunpeak test init` import from here. When adding/removing models or providers, update this file and `template/tests/evals/eval.config.ts` (must use the same spacing format so the uncomment regex works).
6. **This file**

## Upgrading Dependencies

### General Process
1. Update `packages/sunpeak/package.json` and any direct MCP dependencies in workspace packages
2. Run `pnpm install` from monorepo root
3. Verify: `pnpm --filter sunpeak typecheck && pnpm --filter sunpeak lint && pnpm --filter sunpeak test -- --run && pnpm --filter sunpeak build`
4. Regenerate examples: `pnpm --filter sunpeak generate-examples`

### Upgrading `@modelcontextprotocol/ext-apps` (MCP Apps SDK)

This is the upstream SDK that sunpeak wraps. Upgrades often introduce new `App` methods, types, schemas, and capabilities that sunpeak must surface. Follow this checklist:

1. **Find the exact diff** — Check the SDK's changelog or diff the installed package (`node_modules/@modelcontextprotocol/ext-apps/dist/`) to identify new exports: methods on `App`, types, Zod schemas, method constants, and host capabilities.
2. **New `App` methods → new hooks** — For each new method on the `App` class (e.g., `app.downloadFile()`, `app.readServerResource()`):
   - Create a hook in `src/hooks/` following the `useCallServerTool`/`useOpenLink` pattern: `useCallback` + `useApp()` null check + `console.warn` fallback.
   - Export from `src/hooks/index.ts` (alphabetical within the "Action hooks" section).
   - Create a doc page in `docs/api-reference/hooks/` and add to `docs.json`.
3. **New types/schemas/constants → re-exports** — Add to `src/index.ts` in the appropriate section (method constants, Zod schemas, or protocol types). Update `docs/mcp-apps/types/protocol-reference.mdx`.
4. **New host capabilities** — Add to `DEFAULT_HOST_CAPABILITIES` in `src/inspector/mcp-app-host.ts` and add the corresponding `bridge.on*` handler.
5. **Update docs version note** — Bump the SDK version in `docs/mcp-apps/introduction.mdx` and `docs/mcp-apps/types/protocol-reference.mdx`.
6. **Check for deprecations** — If new generic APIs supersede platform-specific hooks, remove the old hook and its docs.
7. **Update `requests.mdx`** — Add sections for new `App` methods in `docs/mcp-apps/app/requests.mdx` and update the `<Note>` listing convenience hooks.
8. **Keep split SDK packages aligned** — ext-apps 2.x requires the MCP 2.x client and Zod 4.2+. Server helpers also require `@modelcontextprotocol/server`; Node HTTP transport uses `@modelcontextprotocol/node`; runtime protocol schemas come from `@modelcontextprotocol/core`. Do not reintroduce the monolithic `@modelcontextprotocol/sdk`.
9. **Migrate breaking surfaces** — Wrap raw Zod shapes with `z.object()`, move request fields under `extra.mcpReq`, read HTTP auth from `extra.http?.authInfo`, and remove uses of the deleted `ProtocolWithEvents` class.

### SDK Export Structure

The SDK's main entry (`app.d.ts`) uses `export * from "./types"` to re-export all types, schemas, and constants. To discover available exports, check:
- `node_modules/@modelcontextprotocol/ext-apps/dist/src/types.d.ts` — All type definitions in current package builds
- `node_modules/@modelcontextprotocol/ext-apps/dist/src/app.d.ts` — `App` class methods in current package builds

## Global CLI vs Project Resolution

**Never generate code that imports from absolute paths to the CLI install.** sunpeak is installed globally but also as a project dependency. When the CLI generates config files, vitest configs, or transformed code that will run in the project's context, all imports must use package names (`sunpeak/eval`, `sunpeak/eval/plugin`) not absolute paths (`resolve(__dirname, ...)`). Otherwise `import('ai')` and other project-local deps resolve from the global pnpm store instead of the project's `node_modules`. Tests in `commands.test.ts` enforce this.

## Conventions
- pnpm workspace with packages at `packages/*` and `packages/sunpeak/template`
- ESM-first (`"type": "module"`)
- Tailwind CSS with MCP standard variables via arbitrary values (`text-[var(--color-text-primary)]`, `bg-[var(--color-background-primary)]`, `border-[var(--color-border-primary)]`)
- Resources discovered from `src/resources/{name}/{name}.tsx`
- Tools discovered from `src/tools/{name}.ts` (each exports `tool: AppToolConfig`, `schema`, optional `outputSchema`, `default` handler)
- Simulations discovered from `tests/simulations/*.json` (flat directory, `"tool"` string field references tool filename)
- Optional server entry at `src/server.ts` (exports `server: ServerConfig` for identity/icons/instructions, `auth()` for request authentication). `instructions` is a server-wide string sent in the MCP `initialize` response that hosts may inject into the model's system prompt — for cross-tool workflows and constraints.
- Hook file naming: `use-{kebab-name}.ts` → export `use{PascalName}` (e.g., `use-download-file.ts` → `useDownloadFile`)
- SDK re-exports in `src/index.ts` are organized into five sections: core classes/functions, app options/tool registration/Standard Schema types, method constants, Zod schemas, protocol types
