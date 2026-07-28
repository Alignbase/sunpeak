---
name: create-sunpeak-app
description: Use when working with sunpeak, or when the user asks to "build an MCP App", "build a ChatGPT App", "add a UI to an MCP tool", "create an interactive resource for Claude Connector or ChatGPT", "build a React UI for an MCP server", or needs guidance on MCP App resources, tool-to-UI data flow, simulation files, host context, platform-specific ChatGPT/Claude features, or production builds. For testing (e2e, visual regression, live tests, evals), see the test-mcp-server skill.
---

# Create Sunpeak App

Sunpeak is a React framework built on `@modelcontextprotocol/ext-apps` for building MCP Apps with interactive UIs that run inside AI chat hosts (ChatGPT, Claude). It provides React hooks, a dev inspector, a CLI (`sunpeak dev` / `sunpeak build` / `sunpeak start`), and a structured project convention. ChatGPT apps are now submitted and published as plugins, but the app portion remains an MCP-backed app, so sunpeak's server, tools, resources, and runtime stay the same.

## Getting Reference Code

Clone the sunpeak repo for working examples:

```bash
git clone --depth 1 https://github.com/Sunpeak-AI/sunpeak /tmp/sunpeak
```

Template app lives at `/tmp/sunpeak/packages/sunpeak/template/`. This is the canonical project structure — read it first.

## Project Structure

```
sunpeak-app/
├── src/
│   ├── resources/
│   │   └── {name}/
│   │       └── {name}.tsx            # Resource component + ResourceConfig export
│   ├── tools/
│   │   └── {name}.ts                 # Tool metadata, Zod schema, handler
│   ├── server.ts                     # Optional server entry (auth, identity, icons, instructions)
│   └── styles/
│       └── globals.css               # Tailwind imports
├── tests/
│   ├── simulations/
│   │   └── *.json                    # Simulation fixture files (flat directory)
│   ├── e2e/
│   │   └── {name}.spec.ts            # Playwright inspector tests
│   ├── evals/
│   │   ├── eval.config.ts            # Eval config (models, runs, defaults)
│   │   ├── .env                      # API keys (gitignored)
│   │   └── {name}.eval.ts            # Eval specs (one per resource or tool)
│   └── live/
│       ├── playwright.config.ts      # Live test config (long timeouts, single worker)
│       └── {name}.spec.ts            # Live tests against real ChatGPT (one per resource)
├── package.json
└── (vite.config.ts, tsconfig.json, etc. managed by sunpeak CLI)
```

Discovery is convention-based:
- Resources: `src/resources/{name}/{name}.tsx` (name derived from directory)
- Tools: `src/tools/{name}.ts` (name derived from filename)
- Simulations: `tests/simulations/*.json` (flat directory, `"tool"` string references tool filename)

## Resource Component Pattern

Every resource file exports two things:

1. **`resource`** — A `ResourceConfig` object with [MCP resource](https://sunpeak.ai/docs/mcp-apps/mcp/resources) metadata (name is auto-derived from directory)
2. **A named React component** — The UI (`{Name}Resource`)

```tsx
import { useToolData, useHostContext, useDisplayMode, SafeArea } from 'sunpeak';
import type { ResourceConfig } from 'sunpeak';

// MCP resource metadata (name auto-derived from directory: src/resources/weather/)
export const resource: ResourceConfig = {
  title: 'Weather',
  description: 'Show current weather conditions',
  mimeType: 'text/html;profile=mcp-app',
  _meta: {
    ui: {
      csp: {
        resourceDomains: ['https://cdn.example.com'],
      },
    },
  },
};

// Type definitions
interface WeatherInput {
  city: string;
  units?: 'metric' | 'imperial';
}

interface WeatherOutput {
  temperature: number;
  condition: string;
  humidity: number;
}

// React component
export function WeatherResource() {
  // All hooks must be called before any early return
  const { input, output, isLoading } = useToolData<WeatherInput, WeatherOutput>();
  const context = useHostContext();
  const displayMode = useDisplayMode();

  if (isLoading) return <div className="p-4 text-[var(--color-text-secondary)]">Loading...</div>;

  const isFullscreen = displayMode === 'fullscreen';
  const hasTouch = context?.deviceCapabilities?.touch ?? false;

  return (
    <SafeArea className={isFullscreen ? 'flex flex-col h-screen' : undefined}>
      <div className="p-4">
        <h1 className="text-[var(--color-text-primary)] font-semibold">{input?.city}</h1>
        <p className={`${hasTouch ? 'text-base' : 'text-sm'} text-[var(--color-text-secondary)]`}>
          {output?.temperature}° — {output?.condition}
        </p>
      </div>
    </SafeArea>
  );
}
```

**Rules:**
- Always wrap in `<SafeArea>` to respect host insets
- Use MCP standard CSS variables via Tailwind arbitrary values: `text-[var(--color-text-primary)]`, `text-[var(--color-text-secondary)]`, `bg-[var(--color-background-primary)]`, `border-[var(--color-border-tertiary)]`
- `useToolData<TInput, TOutput>()` — provide types for both input and output
- All hooks must be called before any early `return` (React rules of hooks)
- Do NOT mutate `app` directly inside hooks — use `eslint-disable-next-line react-hooks/immutability` for class setters

## Tool Files

Each tool `.ts` file exports metadata, a Zod schema, an optional output schema, and a handler. The `resource` field links a tool to its UI — omit it for data-only tools:

```ts
// src/tools/show-weather.ts
import { z } from 'zod';
import type { AppToolConfig, ToolHandlerExtra } from 'sunpeak/mcp';

// 1. Tool metadata (resource links to src/resources/weather/ — omit for tools without a UI)
export const tool: AppToolConfig = {
  resource: 'weather',
  title: 'Show Weather',
  description: 'Show current weather conditions',
  annotations: { readOnlyHint: true },
  _meta: { ui: { visibility: ['model', 'app'] } },
};

// 2. Zod schema (auto-converted to JSON Schema for MCP)
export const schema = {
  city: z.string().describe('City name'),
  units: z.enum(['metric', 'imperial']).describe('Temperature units'),
};

// 3. Optional output schema (enables structured output validation)
export const outputSchema = {
  temperature: z.number(),
  condition: z.string(),
  humidity: z.number(),
};

// 4. Handler — return structured data for the UI
export default async function (args: { city: string; units?: string }, extra: ToolHandlerExtra) {
  return {
    structuredContent: {
      temperature: 72,
      condition: 'Partly Cloudy',
      humidity: 55,
    },
  };
}
```

### Backend-Only Tools (Confirmation Loop)

A common pattern pairs a UI tool (for review) with a backend-only tool (for execution). The UI tool's `structuredContent` includes a `reviewTool` field. The resource component reads it and calls the backend tool via `useCallServerTool` when the user confirms:

```ts
// src/tools/review.ts — no resource field, shared by all review variants
import { z } from 'zod';
import type { AppToolConfig, ToolHandlerExtra } from 'sunpeak/mcp';

export const tool: AppToolConfig = {
  title: 'Confirm Review',
  description: 'Execute or cancel a reviewed action after user approval',
  annotations: { readOnlyHint: false },
  _meta: { ui: { visibility: ['model', 'app'] } },
};

export const schema = {
  action: z.string().describe('Action identifier (e.g., "place_order", "apply_changes")'),
  confirmed: z.boolean().describe('Whether the user confirmed'),
  decidedAt: z.string().describe('ISO timestamp of decision'),
  payload: z.record(z.unknown()).optional().describe('Domain-specific data'),
};

type Args = z.infer<z.ZodObject<typeof schema>>;

export default async function (args: Args, _extra: ToolHandlerExtra) {
  if (!args.confirmed) {
    return {
      content: [{ type: 'text' as const, text: 'Cancelled.' }],
      structuredContent: { status: 'cancelled', message: 'Cancelled.' },
    };
  }
  return {
    content: [{ type: 'text' as const, text: 'Completed.' }],
    structuredContent: { status: 'success', message: 'Completed.' },
  };
}
```

The UI tool returns `reviewTool` in its response, and the resource calls `useCallServerTool` on accept/reject. The tool returns both `content` (human-readable text for the host model) and `structuredContent` (with `status` and `message` for the UI). The resource reads `structuredContent.status` to determine success/error styling and displays `structuredContent.message`. One `review` tool handles all review variants (purchases, diffs, posts) via the `action` field. The inspector returns mock simulation data for `callServerTool` calls, matching real host behavior. See the template's `review` resource for the full implementation.

## Simulation Files

Simulations are JSON fixtures that power the dev inspector. Place them in `tests/simulations/` as flat JSON files:

```json
{
  "tool": "show-weather",
  "userMessage": "Show me the weather in Austin, TX.",
  "toolInput": {
    "city": "Austin",
    "units": "imperial"
  },
  "toolResult": {
    "structuredContent": {
      "temperature": 72,
      "condition": "Partly Cloudy",
      "humidity": 55
    }
  }
}
```

Key fields:
- `tool` — String referencing a tool filename in `src/tools/` (without `.ts`)
- `userMessage` — Decorative text shown in inspector (no functional purpose)
- `toolInput` — Arguments sent to the tool (shown as input to `useToolData`)
- `toolResult.structuredContent` — The data rendered by `useToolData().output`
- `toolResult.content[]` — Text fallback for non-UI hosts
- `serverTools` — Mock responses for `callServerTool` calls. Keys are tool names. Values are either a single `CallToolResult` (always returned) or an array of `{ when, result }` entries for conditional matching against call arguments.

Example with `serverTools` (for resources that call backend-only tools):
```json
{
  "tool": "review-purchase",
  "toolResult": { "structuredContent": { "..." } },
  "serverTools": {
    "review": [
      { "when": { "confirmed": true }, "result": { "content": [{ "type": "text", "text": "Completed." }], "structuredContent": { "status": "success", "message": "Completed." } } },
      { "when": { "confirmed": false }, "result": { "content": [{ "type": "text", "text": "Cancelled." }], "structuredContent": { "status": "cancelled", "message": "Cancelled." } } }
    ]
  }
}
```

Multiple simulations per tool are supported: `review-diff.json`, `review-post.json` sharing the same resource via the same tool's `resource` field.

## Core Hooks Reference

All hooks are imported from `sunpeak`:

| Hook | Returns | Description |
|------|---------|-------------|
| `useToolData<TIn, TOut>()` | `{ input, inputPartial, output, isLoading, isError, isCancelled }` | Reactive tool data from host |
| `useHostContext()` | `McpUiHostContext \| null` | Host context (theme, locale, capabilities, etc.) |
| `useTheme()` | `'light' \| 'dark' \| undefined` | Current theme |
| `useDisplayMode()` | `'inline' \| 'pip' \| 'fullscreen'` | Current display mode (defaults to `'inline'`) |
| `useLocale()` | `string` | Host locale (e.g. `'en-US'`, defaults to `'en-US'`) |
| `useTimeZone()` | `string` | IANA time zone (falls back to browser time zone) |
| `usePlatform()` | `'web' \| 'desktop' \| 'mobile' \| undefined` | Host-reported platform type |
| `useDeviceCapabilities()` | `{ touch?, hover? }` | Device input capabilities |
| `useUserAgent()` | `string \| undefined` | Host application identifier |
| `useStyles()` | `McpUiHostStyles \| undefined` | Host style configuration (CSS variables, fonts) |
| `useToolInfo()` | `{ id?, tool } \| undefined` | Metadata about the tool call that created this app |
| `useSafeArea()` | `{ top, right, bottom, left }` | Safe area insets (px) |
| `useViewport()` | `{ width, height, maxWidth, maxHeight }` | Container dimensions (px) |
| `useIsMobile()` | `boolean` | True if viewport is mobile-sized |
| `useApp()` | `App \| null` | Raw [MCP App](https://sunpeak.ai/docs/mcp-apps/mcp/overview) instance for direct SDK calls |
| `useCallServerTool()` | `(params) => Promise<result>` | Returns a function to call a server-side tool by name |
| `useCreateSamplingMessage()` | `(params) => Promise<result>` | Request LLM completions from the host via sampling/createMessage |
| `useRegisterTool()` | `(name, config, cb) => handle` | Register app-side tools the host can call; returns handle with enable/disable/remove |
| `useSendMessage()` | `(params) => Promise<void>` | Returns a function to send a message to the conversation |
| `useOpenLink()` | `(params) => Promise<void>` | Returns a function to open a URL through the host |
| `useRequestDisplayMode()` | `{ requestDisplayMode, availableModes }` | Request `'inline'`, `'pip'`, or `'fullscreen'`; check `availableModes` first |
| `useDownloadFile()` | `(params) => Promise<result>` | Download files through the host (works cross-platform) |
| `useReadServerResource()` | `(params) => Promise<result>` | Read a resource from the MCP server by URI |
| `useListServerResources()` | `(params?) => Promise<result>` | List available resources on the MCP server |
| `useUpdateModelContext()` | `(params) => Promise<void>` | Push state to the host's model context directly |
| `useSendLog()` | `(params) => Promise<void>` | Send debug log to host |
| `useSendToolListChanged()` | `() => Promise<void>` | Notify host that app's tool list changed (after register/remove/enable/disable) |
| `useHostInfo()` | `{ hostVersion, hostCapabilities }` | Host name, version, and supported capabilities |
| `useTeardown(fn)` | `void` | Register a teardown handler |
| `useAppTools(config)` | `void` | Register tools the app provides to the host (bidirectional tool calling) |
| `useRequestTeardown()` | `() => Promise<void>` | Request the host to tear down this app instance |
| `useAppState(initial)` | `[state, setState]` | React state that auto-syncs to host model context via `updateModelContext()` |

### `useRequestDisplayMode` details

```tsx
const { requestDisplayMode, availableModes } = useRequestDisplayMode();

// Always check availability before requesting
if (availableModes?.includes('fullscreen')) {
  await requestDisplayMode('fullscreen');
}
if (availableModes?.includes('pip')) {
  await requestDisplayMode('pip');
}
```

### `useCallServerTool` details

```tsx
const callTool = useCallServerTool();

const result = await callTool({ name: 'get-weather', arguments: { city: 'Austin' } });
// result: { content?: [...], isError?: boolean }
```

### `useSendMessage` details

```tsx
const sendMessage = useSendMessage();

await sendMessage({
  role: 'user',
  content: [{ type: 'text', text: 'Please refresh the data.' }],
});
```

### `useAppState` details

State is preserved in React and automatically sent to the host via `updateModelContext()` after each update, so the LLM can see the current UI state in its context window. For model evals, seed the same state with the eval case `appContext` field so follow-up prompts such as "Book this one" can be tested against the selected app state.

```tsx
const [state, setState] = useAppState<{ decision: 'accepted' | 'rejected' | null }>({
  decision: null,
});
// setState triggers a re-render AND pushes state to the model context
setState({ decision: 'accepted' });
```

### `useToolData` details

```tsx
const {
  input,         // TInput | null — final tool input arguments
  inputPartial,  // TInput | null — partial (streaming) input as it generates
  output,        // TOutput | null — tool result (structuredContent ?? content)
  isLoading,     // boolean — true until first toolResult arrives
  isError,       // boolean — true if tool returned an error
  isCancelled,   // boolean — true if tool was cancelled
  cancelReason,  // string | null
} = useToolData<MyInput, MyOutput>(defaultInput, defaultOutput);
```

Use `inputPartial` for progressive rendering during LLM generation. Use `output` for the final data.

### `useDownloadFile` details

```tsx
const downloadFile = useDownloadFile();

// Download embedded text content
await downloadFile({
  contents: [{
    type: 'resource',
    resource: {
      uri: 'file:///export.json',
      mimeType: 'application/json',
      text: JSON.stringify(data, null, 2),
    },
  }],
});

// Download embedded binary content
await downloadFile({
  contents: [{
    type: 'resource',
    resource: {
      uri: 'file:///image.png',
      mimeType: 'image/png',
      blob: base64EncodedPng,
    },
  }],
});
```

### `useReadServerResource` / `useListServerResources` details

```tsx
const readResource = useReadServerResource();
const listResources = useListServerResources();

// List available resources
const result = await listResources();
for (const resource of result?.resources ?? []) {
  console.log(resource.name, resource.uri);
}

// Read a specific resource by URI
const content = await readResource({ uri: 'videos://bunny-1mb' });
```

### `useAppTools` details

Register tools the app provides to the host for bidirectional tool calling. Tool metadata goes in `tools[]`; a single `onCallTool` callback dispatches every invocation.

```tsx
import { useAppTools } from 'sunpeak';

function MyResource() {
  useAppTools({
    tools: [
      {
        name: 'get-selection',
        description: 'Get current user selection',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
    onCallTool: async ({ name, arguments: args }) => {
      if (name === 'get-selection') {
        return { content: [{ type: 'text', text: selectedText }] };
      }
      return { content: [], isError: true };
    },
  });
}
```

## Commands

```bash
sunpeak new         # Scaffold a new sunpeak app project
sunpeak dev         # Start dev server (Vite + MCP server, port 3000 web / 8000 MCP)
sunpeak build       # Build resources + compile tools to dist/
sunpeak start       # Start production MCP server (real handlers, auth, Zod validation)
sunpeak upgrade     # Upgrade sunpeak to the latest version
```

The `sunpeak dev` command starts both the Vite dev server and the MCP server together. The inspector runs at `http://localhost:3000`. Connect ChatGPT to `http://localhost:8000/mcp` (or use ngrok for remote testing).

For real ChatGPT testing, Developer mode must be enabled. If needed, click the bottom-left user menu and select `Settings > Security and login > Developer mode`. Then return to the ChatGPT homepage, click `Plugins` in the sidebar, and open the app if it is already there or select `+` to create it with the tunneled `/mcp` URL.

Use `sunpeak build && sunpeak start` to test production behavior locally with real handlers instead of simulation fixtures.

The `sunpeak dev` command supports two orthogonal flags for testing different combinations:
- `--prod-tools` — Route `callServerTool` to real tool handlers instead of simulation mocks
- `--prod-resources` — Serve production-built HTML from `dist/` instead of Vite HMR
- `--prod-tools --prod-resources` — Full smoke test: production bundles with real handlers

### Production Server Options

```bash
sunpeak start                          # Default: port 8000, all interfaces
sunpeak start --port 3000              # Custom port
sunpeak start --host 127.0.0.1         # Bind to localhost only
sunpeak start --json-logs              # Structured JSON logging
sunpeak start --sse                    # SSE streaming with 15s keep-alives
sunpeak start --sse-keep-alive-ms 0    # Disable SSE keep-alives
PORT=3000 HOST=127.0.0.1 sunpeak start # Via environment variables
```

The production server provides:
- `/health` — Health check endpoint (`{"status":"ok","uptime":N}`) for load balancer probes and monitoring
- `/mcp` — MCP Streamable HTTP endpoint
- Graceful shutdown on SIGTERM/SIGINT (5-second drain)
- Structured JSON logging (`--json-logs`) for log aggregation (Datadog, CloudWatch, etc.)
- SSE keep-alive comments when `--sse` is enabled (`--sse-keep-alive-ms` or `SUNPEAK_SSE_KEEP_ALIVE_MS` to tune)

## Production Build Output

`sunpeak build` generates optimized bundles in `dist/`:

```
dist/
├── weather/
│   ├── weather.html   # Self-contained bundle (JS + CSS inlined)
│   └── weather.json   # ResourceConfig with generated uri for cache-busting
├── tools/
│   ├── show-weather.js  # Compiled tool handler + Zod schema
│   └── ...
├── server.js          # Compiled server entry (if src/server.ts exists)
└── ...
```

`sunpeak start` loads everything from `dist/` and starts a production MCP server with real tool handlers, Zod input validation, and optional auth from `src/server.ts`.

## Publishing to ChatGPT

ChatGPT apps are submitted and published as plugins. After deploying the production MCP server:

1. Open the OpenAI Platform plugin submission portal at `https://platform.openai.com/plugins`.
2. Create a `With MCP` submission for an app-only plugin or app-plus-skills plugin.
3. Submit the production MCP server URL directly. Do not submit an existing ChatGPT app ID.
4. Complete publisher identity, listing, authentication, CSP, domain verification, tool metadata, prompts, five positive tests, three negative tests, availability, and release notes.
5. Submit for review, then publish after approval.

Every MCP tool needs accurate `readOnlyHint`, `openWorldHint`, and `destructiveHint` values. Reviewer credentials must work without MFA, SMS, email confirmation, or private-network access. Published apps appear in the shared Plugins Directory, not a separate Apps Directory.

Use `https://learn.chatgpt.com/docs/build-plugins` for local plugin packaging and optional bundled skills. Use `https://learn.chatgpt.com/docs/submit-plugins` for the current public review requirements.

## Host Detection

```tsx
import { isChatGPT, isClaude, detectHost } from 'sunpeak/host';

// In a resource component
function MyResource() {
  const host = detectHost(); // 'chatgpt' | 'claude' | 'unknown'

  if (isChatGPT()) {
    // Safe to use ChatGPT-specific hooks
  }
}
```

## ChatGPT-Specific Hooks

Import from `sunpeak/host/chatgpt`. Always feature-detect before use.

```tsx
import { useUploadFile, useRequestModal, useRequestCheckout } from 'sunpeak/host/chatgpt';
import { isChatGPT } from 'sunpeak/host';

function MyResource() {
  // Only call these when on ChatGPT
  const uploadFile = useUploadFile();
  const requestModal = useRequestModal();
  const requestCheckout = useRequestCheckout();
}
```

| Hook | Description |
|------|-------------|
| `useUploadFile()` | Returns `(file: File) => Promise<{ fileId }>` to upload a file to ChatGPT |
| `useRequestModal()` | Returns `(params) => Promise<void>` to open a host-native modal dialog |
| `useRequestCheckout()` | Returns `(session) => Promise<...>` to trigger ChatGPT instant checkout |

## SafeArea Component

Always wrap resource content in `<SafeArea>` to respect host insets:

```tsx
import { SafeArea } from 'sunpeak';

export function MyResource() {
  return (
    <SafeArea>
      {/* your content */}
    </SafeArea>
  );
}
```

`SafeArea` applies `padding` equal to `useSafeArea()` insets automatically.

## Styling with MCP Standard Variables

Use MCP standard CSS variables via Tailwind arbitrary values instead of raw colors. These variables adapt automatically to each host's theme (ChatGPT, Claude):

| Tailwind Class | CSS Variable | Usage |
|-------|-------|-------|
| `text-[var(--color-text-primary)]` | `--color-text-primary` | Primary text |
| `text-[var(--color-text-secondary)]` | `--color-text-secondary` | Secondary/muted text |
| `bg-[var(--color-background-primary)]` | `--color-background-primary` | Card/surface background |
| `bg-[var(--color-background-secondary)]` | `--color-background-secondary` | Secondary/nested surface background |
| `bg-[var(--color-background-tertiary)]` | `--color-background-tertiary` | Tertiary background |
| `bg-[var(--color-ring-primary)]` | `--color-ring-primary` | Primary action color (e.g. badge fill) |
| `border-[var(--color-border-tertiary)]` | `--color-border-tertiary` | Subtle border |
| `border-[var(--color-border-primary)]` | `--color-border-primary` | Default border |
| `dark:` variant | — | Dark mode via `[data-theme="dark"]` |

These variables use CSS `light-dark()` so they respond to theme changes automatically. The `dark:` Tailwind variant also works via `[data-theme="dark"]`.

## Testing

For all testing capabilities (e2e tests, visual regression, live tests against real ChatGPT, multi-model evals, Playwright config), install the `test-mcp-server` skill:

```bash
pnpm dlx skills add Sunpeak-AI/sunpeak@test-mcp-server
```

The testing skill works with any MCP server (not just sunpeak projects). Simulations (above) are part of the dev workflow and defined here. Tests consume them via the `mcp` fixture.

For testing commands, see the `test-mcp-server` skill. Quick reference: `sunpeak test` (unit + e2e), `sunpeak test --visual` (visual regression), `sunpeak test --live` (real ChatGPT), `sunpeak test --eval` (multi-model evals).

## ResourceConfig Fields

```typescript
import type { ResourceConfig } from 'sunpeak';

// name is auto-derived from the directory (src/resources/my-resource/)
export const resource: ResourceConfig = {
  title: 'My Resource',           // Human-readable title
  description: 'What it shows',   // Description for MCP hosts
  mimeType: 'text/html;profile=mcp-app',  // Required for MCP App resources
  _meta: {
    ui: {
      csp: {
        resourceDomains: ['https://cdn.example.com'],    // Image/script CDNs
        connectDomains: ['https://api.example.com'],     // API fetch targets
      },
    },
  },
};
```

## Common Mistakes

1. **Hooks before early returns** — All hooks must run unconditionally. Move `useMemo`/`useEffect` above any `if (...) return` blocks.
2. **Missing `<SafeArea>`** — Always wrap content in `<SafeArea>` to respect host safe area insets.
3. **Hardcoded colors** — Use MCP standard CSS variables via Tailwind arbitrary values (`text-[var(--color-text-primary)]`, `bg-[var(--color-background-primary)]`) not raw colors.
4. **Simulation tool mismatch** — The `"tool"` field in simulation JSON must match a tool filename in `src/tools/` (e.g. `"tool": "show-weather"` matches `src/tools/show-weather.ts`).
5. **Mutating hook params** — Use `eslint-disable-next-line react-hooks/immutability` for `app.onteardown = ...` (class setter, not a mutation).
6. **Forgetting text fallback** — Include `toolResult.content[]` in simulations for non-UI hosts.

## Troubleshooting: App Not Rendering in ChatGPT/Claude

If the app doesn't show up after the tool is called, follow these steps:

1. **Check your tunnel** — verify ngrok (or equivalent) is running, pointing to the right port, and using `http` not `https` upstream (`ngrok http 8000`).
2. **Check your dev server** — make sure `sunpeak dev` is running and the MCP server started on the expected port (watch for "port was in use" messages).
3. **Restart `sunpeak dev`** — stops the dev server (`Ctrl+C`) and starts fresh. This clears stale connections.
4. **Refresh or re-add the MCP server.** In ChatGPT, open the developer-mode app under `Plugins` and refresh it from the plugin details. In other hosts, use their app or connector management page. If refresh fails, remove and re-add it with the tunnel URL.
5. **Hard refresh the host page** — `Cmd+Shift+R` / `Ctrl+Shift+R` clears cached MCP connections.
6. **Open a new chat** — both hosts cache iframe content per-conversation. A new chat forces a fresh connection.

Full troubleshooting guide: https://sunpeak.ai/docs/app-framework/guides/troubleshooting

## Export Paths

| Import | Contents |
|--------|----------|
| `sunpeak` | Hooks, types, SDK re-exports, `SafeArea`, `inspector` + `chatgpt` namespaces |
| `sunpeak/mcp` | Server utilities (`runMCPServer`, `createMcpHandler`, `createProductionMcpServer`), tool types (`AppToolConfig`, `ToolHandlerExtra`), server config (`ServerConfig`) |
| `sunpeak/inspector` | Generic Inspector, host shell system, infrastructure |
| `sunpeak/chatgpt` | ChatGPT host shell + Inspector re-export |
| `sunpeak/claude` | Claude host shell + Inspector re-export |
| `sunpeak/host` | Host detection (`isChatGPT`, `isClaude`, `detectHost`) |
| `sunpeak/host/chatgpt` | ChatGPT-specific hooks (`useUploadFile`, `useRequestModal`, `useRequestCheckout`) |
| `sunpeak/style.css` | Main stylesheet |

For testing export paths (`sunpeak/test`, `sunpeak/eval`, etc.), see the `test-mcp-server` skill.

## References

- [sunpeak Documentation](https://sunpeak.ai/docs)
- [MCP Apps Documentation](https://sunpeak.ai/docs/mcp-apps/introduction)
- [MCP Overview](https://sunpeak.ai/docs/mcp-apps/mcp/overview) · [Tools](https://sunpeak.ai/docs/mcp-apps/mcp/tools) · [Resources](https://sunpeak.ai/docs/mcp-apps/mcp/resources)
- [MCP Apps SDK](https://github.com/modelcontextprotocol/ext-apps)
- [ChatGPT Apps SDK Design Guidelines](https://developers.openai.com/apps-sdk/concepts/design-guidelines)
- [Build ChatGPT Plugins](https://learn.chatgpt.com/docs/build-plugins)
- [Submit ChatGPT Plugins](https://learn.chatgpt.com/docs/submit-plugins)
