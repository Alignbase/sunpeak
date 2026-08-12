# Development Guide

Refer to the [documentation](https://sunpeak.ai/docs) to ramp up on sunpeak.

## Quickstart

Requirements: Node (20+), pnpm (10+), git

```bash
git clone https://github.com/Alignbase/sunpeak.git
cd sunpeak && pnpm install
pnpm dev
```

## Local Testing

Run all the checks with the following:

```bash
pnpm validate
```

This will:

- Run linting, typechecking, and unit tests at the package level
- Build the package
- Generate per-resource example projects (via `sunpeak new`) in `examples/`
- For each example: link local sunpeak, run unit tests, build, and run E2E tests with Playwright

### Live Testing (against real ChatGPT)

Run the full validation pipeline plus automated tests against real ChatGPT:

```bash
# Start a tunnel first
ngrok http 8000

# Run validation with live tests
pnpm validate -- --live
```

This adds a final phase that runs `pnpm test:live` in the generated example project. Tests run fully in parallel (`fullyParallel: true`) — each test gets its own chat window. The MCP server refresh happens once in globalSetup before all workers. Requires:

- A tunnel running (e.g. `ngrok http 8000`)
- Being logged into ChatGPT in your browser (session is imported automatically)
- Developer mode enabled from the bottom-left user menu under `Settings > Security and login > Developer mode`
- Developer-mode app created under ChatGPT `Plugins` with the tunnel URL

Set `SUNPEAK_LIVE_BROWSER` (chrome/arc/brave/edge) to override browser detection.

For manual testing with live servers, you can also run:

- `pnpm dev`
- `pnpm mcp` (in template directory)

### ChatGPT Prod - Local Package

With the mcp server still running from the previous step, make sure to have a tunnel like ngrok running in another terminal using the mcp port:

```
ngrok http 8000
```

If Developer mode is not already enabled, click your user menu in the bottom-left corner and select `Settings > Security and login > Developer mode`.

Then return to the ChatGPT homepage and click `Plugins` in the sidebar. Open the app if it is already there, or select the `+` button and connect the tunnel forwarding URL at the `/mcp` path.

Once the app is connected, send the name of a tool simulation, like `show carousel`, to ChatGPT. Many changes require you to refresh the app from its plugin details.

## Deployment

On pushes to `main`, Github Actions automatically increments the version number and creates the git tag.

To deploy to npm, create a release in Github and Github Actions will automatically deploy to npm.

### Deployment Testing

Assuming `pwd` is this root sunpeak repo folder, run:

```bash
pnpm update -g sunpeak
rm -rf ../tmp && mkdir ../tmp && cd ../tmp
sunpeak new sunpeak-app && cd sunpeak-app
sunpeak build && pnpm test && sunpeak dev
```

## Coding Guidance

### Documentation

Only comment and add documentation if the added context or explanation significantly enhances understanding beyond a quick look at the source material itself.

Avoid updating the root README except to correct things that have changed or add context on a major new feature.

### The most important rule

Have fun.
