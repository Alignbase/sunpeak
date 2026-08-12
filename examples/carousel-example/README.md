# sunpeak-app

An MCP App built with [sunpeak](https://github.com/Alignbase/sunpeak).

For an initial overview of your new app and a detailed API reference, refer to the [documentation](https://sunpeak.ai/docs/app-framework/project-scaffold).

## Quickstart

```bash
pnpm dev
```

That's it! Edit the resource files in [./src/resources/](./src/resources/) to build your resource UI.

## Commands

**Testing:**

```bash
pnpm test                      # Run unit + e2e tests.
pnpm test:unit                 # Run unit tests only (Vitest).
pnpm test:e2e                  # Run e2e tests only (Playwright).
pnpm test:visual               # Run e2e tests with visual regression.
pnpm test:live                 # Run live tests against real ChatGPT.
pnpm test:eval                 # Run evals against multiple LLM models.
```

**Development and production:**

```bash
pnpm dev               # Start dev server + MCP endpoint.
pnpm build             # Build resources and compile tools for production.
pnpm start             # Start the production MCP server.
```

E2e tests use the `mcp` fixture from `sunpeak/test` to call tools and assert against rendered UI across ChatGPT and Claude hosts. Unit tests use Vitest with happy-dom.

**Evals** test whether LLMs (GPT-4o, Claude, Gemini, etc.) call your tools correctly. To set up evals:

1. Install the AI SDK and provider packages: `pnpm add ai @ai-sdk/openai`
2. Copy `tests/evals/.env.example` to `tests/evals/.env` and add your API keys
3. Uncomment models in `tests/evals/eval.config.ts`
4. Run: `pnpm test:eval`

The dev server starts automatically for evals. Each case runs multiple times per model to measure reliability. See the [Evals documentation](https://sunpeak.ai/docs/testing/evals) for details.

## Project Structure

Using a Review page as an example, sunpeak projects look like:

```bash
sunpeak-app/
├── src/resources/
│   └── review/
│       └── review.tsx            # Review UI component + resource metadata.
├── src/tools/
│   ├── review-diff.ts            # Tool: metadata, schema, handler.
│   ├── review-post.ts
│   └── review-purchase.ts
├── tests/simulations/
│   ├── review-diff.json          # Mock state for testing.
│   ├── review-post.json
│   └── review-purchase.json
└── package.json
```

## Testing in ChatGPT

Test your app directly in ChatGPT using the built-in [MCP](https://sunpeak.ai/docs/mcp-apps/mcp/overview) endpoint (starts automatically with `pnpm dev`):

```bash
# Start the dev server + MCP endpoint.
pnpm dev

# In another terminal, run a tunnel. For example:
ngrok http 8000
```

If Developer mode is not already enabled, click your user menu in the bottom-left corner and select `Settings > Security and login > Developer mode`.

Then return to the ChatGPT homepage and click `Plugins` in the sidebar. Open your app if it is already there, or select the `+` button and connect the tunnel forwarding URL at the `/mcp` path.

ChatGPT creates a developer-mode app backed by your MCP server. It appears under `Plugins`, but its MCP App UI and runtime do not change.

Once your app is connected, send the name of the app and a tool, like `/sunpeak show review`, to ChatGPT.

### Automated Live Testing

Run automated tests against real ChatGPT with `pnpm test:live`. This opens your browser, navigates to ChatGPT, sends messages that trigger your tools, and validates the rendered app — no manual testing required.

**One-time setup:**

1. If Developer mode is not already enabled, click your user menu in the bottom-left corner and select `Settings > Security and login > Developer mode`
2. Return to the ChatGPT homepage and click `Plugins` in the sidebar
3. Open your app if it is already there, or select `+` and add your tunnel URL at `/mcp`

**Run live tests:**

```bash
# Start a tunnel in one terminal
ngrok http 8000

# Run the tests
pnpm test:live
```

The test runner imports your browser session automatically, starts the dev server, and refreshes the MCP server connection once before all workers. Tests run fully in parallel — each test gets its own chat window and switches themes internally via `live.setColorScheme()`. The browser opens visibly to avoid bot detection on chatgpt.com.

## Build & Deploy

Build and start your app for production:

```bash
pnpm build && pnpm start
```

`pnpm build` creates optimized builds in `dist/`:

```bash
dist/
├── albums/
│   ├── albums.html           # Built resource bundle.
│   └── albums.json           # ResourceConfig (extracted from .tsx).
├── tools/
│   ├── show-albums.js        # Compiled tool handler + schema.
│   └── ...
├── server.js                 # Compiled server entry (if src/server.ts exists).
└── ...
```

`pnpm start` loads the compiled tools and resources, then starts a production MCP server with real handlers, Zod input validation, and optional auth.

```bash
pnpm start -- --port 3000              # Custom port (default: 8000)
pnpm start -- --host 127.0.0.1         # Bind to localhost only
pnpm start -- --json-logs              # Structured JSON logging for production
```

The server includes a `/health` endpoint for load balancer probes and monitoring. See the [Deployment Guide](https://sunpeak.ai/docs/app-framework/guides/deployment) for production operations details (reverse proxy, process management, Docker).

ChatGPT apps are submitted and published as plugins. Deploy this MCP server first, then create a `With MCP` submission in the [OpenAI Platform plugin portal](https://platform.openai.com/plugins). Submit the MCP server URL directly, not an existing ChatGPT app ID. See the [sunpeak publishing guide](https://sunpeak.ai/docs/app-framework/guides/deployment#publish-to-chatgpt) and OpenAI's [plugin submission guide](https://learn.chatgpt.com/docs/submit-plugins).

## Add a new UI (Resource)

To add a new UI ([MCP Resource](https://sunpeak.ai/docs/mcp-apps/mcp/resources)), create a new directory under `src/resources/` with the following files:

```
src/resources/NAME/
├── NAME.tsx                      # React component + resource metadata (required)
├── NAME.test.tsx                 # Unit tests (optional)
└── components/                   # UI components (optional)
```

Only the resource file (`.tsx`) is required to generate a production build and ship a UI. It must export a `resource` object (`ResourceConfig`) describing the resource metadata, and a React component that renders the UI. The resource name is auto-derived from the directory name.

Then create a tool file in `src/tools/` and simulation file(s) in `tests/simulations/` to preview your resource in `pnpm dev`.

## Coding Agent Skills

Install the sunpeak skills to give your coding agent built-in knowledge of sunpeak patterns, hooks, and testing:

```bash
pnpm dlx skills add Alignbase/sunpeak@create-sunpeak-app Alignbase/sunpeak@test-mcp-server
```

## Troubleshooting

If your app doesn't render in ChatGPT or Claude:

1. **Check your tunnel** is running and pointing to the correct port
2. **Restart `pnpm dev`** to clear stale connections
3. **Refresh or re-add the MCP server** from the host's app or plugin management page
4. **Hard refresh** the host page (`Cmd+Shift+R` / `Ctrl+Shift+R`)
5. **Open a new chat** in the host (cached iframes persist per-conversation)

Full guide: [sunpeak.ai/docs/app-framework/guides/troubleshooting](https://sunpeak.ai/docs/app-framework/guides/troubleshooting)

## Resources

- [sunpeak](https://github.com/Alignbase/sunpeak)
- [MCP Apps Documentation](https://sunpeak.ai/docs/mcp-apps/introduction)
- [MCP Overview](https://sunpeak.ai/docs/mcp-apps/mcp/overview) · [Tools](https://sunpeak.ai/docs/mcp-apps/mcp/tools) · [Resources](https://sunpeak.ai/docs/mcp-apps/mcp/resources)
- [MCP Apps SDK](https://github.com/modelcontextprotocol/ext-apps)
- [ChatGPT Apps SDK Design Guidelines](https://developers.openai.com/apps-sdk/concepts/design-guidelines)
- [Build ChatGPT Plugins](https://learn.chatgpt.com/docs/build-plugins) · [Submit ChatGPT Plugins](https://learn.chatgpt.com/docs/submit-plugins)
