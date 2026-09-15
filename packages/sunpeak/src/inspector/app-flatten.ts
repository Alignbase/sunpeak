/**
 * Convert the public `InspectorApp` shape into the internal flat `Simulation`
 * map the Inspector's existing code already operates on. The hierarchical
 * shape (App → resources + tools → simulations) is just a more ergonomic
 * surface; flattening here means the rest of the component is unchanged.
 *
 * Linkage: each tool's `_meta.openai.outputTemplate` URI selects the matching
 * resource. Tools without a matching resource are still flattened so users can
 * select, call, and inspect backend-only tools from the sidebar, and model
 * chat can call them too.
 *
 * A tool with no `simulations` still produces one entry so the inspector has
 * a stable tool definition for sidebar selection (when renderable) and model
 * chat. That entry carries no fixture data, so live calls flow through
 * `onCallTool`.
 *
 * Naming split — `Simulation.name` vs `Simulation.displayName`:
 *
 * - `name` is the unique internal key used everywhere the Inspector indexes
 *   simulations (state, dropdown `value`, the simulations map keys). For the
 *   flattened embed path it's `<toolName>__<userSimName>` so two tools can
 *   share a simulation name without colliding.
 * - `displayName` is the user-facing label shown in the sidebar's Simulation
 *   dropdown. Set to the embedder's raw `sim.name` so users see what they
 *   wrote, not the internal composite. Sidebar code falls back to `name`
 *   when `displayName` is omitted (the legacy CLI path).
 *
 * Don't collapse these — the URL-param deep-link path (`?simulation=X`) and
 * the rest of the Inspector code rely on `name` being a stable unique key.
 */
import type { Resource } from '@modelcontextprotocol/client';
import type { Simulation } from '../types/simulation';
import type { InspectorApp, InspectorAppResource } from './app-types';

/** Pull the output-template URI off a tool's _meta, if present. */
function getOutputTemplate(toolMeta: unknown): string | undefined {
  if (!toolMeta || typeof toolMeta !== 'object') return undefined;
  const openai = (toolMeta as Record<string, unknown>).openai;
  if (!openai || typeof openai !== 'object') return undefined;
  const template = (openai as Record<string, unknown>).outputTemplate;
  return typeof template === 'string' ? template : undefined;
}

/** Build an MCP-shaped `Resource` from the embedder's input. Used purely for
 * sidebar metadata (CSP, permissions, prefersBorder); the actual HTML render
 * goes through `resourceHtml` on the resulting Simulation. */
function toMcpResource(r: InspectorAppResource): Resource {
  return {
    uri: r.uri,
    mimeType: r.mimeType ?? 'text/html',
    name: r.uri,
    ...(r._meta ? { _meta: r._meta } : {}),
  } as Resource;
}

/**
 * Flatten an `InspectorApp` to the `Record<string, Simulation>` shape the
 * Inspector consumes internally. Returns an empty map if `app` is missing.
 */
export function flattenAppToSimulations(app: InspectorApp | undefined): Record<string, Simulation> {
  if (!app) return {};
  const result: Record<string, Simulation> = {};

  // Index resources by URI so each tool can resolve its output template.
  // Duplicate URIs are almost always typos — warn so the embedder notices
  // (the silent last-write semantics would hide the bug otherwise).
  const resourcesByUri = new Map<string, InspectorAppResource>();
  for (const r of app.resources) {
    if (resourcesByUri.has(r.uri)) {
      console.warn(
        `[Inspector] Duplicate resource URI '${r.uri}' in app.resources — the second entry replaces the first.`
      );
    }
    resourcesByUri.set(r.uri, r);
  }

  for (const appTool of app.tools) {
    const uri = getOutputTemplate(appTool.tool._meta);
    const resource = uri ? resourcesByUri.get(uri) : undefined;
    if (uri && !resource) {
      console.warn(
        `[Inspector] Tool '${appTool.tool.name}' references unknown resource URI '${uri}'. The tool remains callable but has no UI to render.`
      );
    }

    const mcpResource = resource ? toMcpResource(resource) : undefined;
    const sims =
      appTool.simulations && appTool.simulations.length > 0
        ? appTool.simulations
        : [{ name: appTool.tool.name }];

    for (const sim of sims) {
      // Compose a key unique across the whole app. Multiple tools may share
      // a resource and multiple sims may share a name across tools; prefix
      // with the tool name to keep keys stable.
      const key = `${appTool.tool.name}__${sim.name}`;
      // Same name twice under one tool is almost always a typo — second
      // would silently replace the first. Warn so the embedder catches it.
      if (key in result) {
        console.warn(
          `[Inspector] Duplicate simulation name '${sim.name}' under tool '${appTool.tool.name}' — the second entry replaces the first.`
        );
      }
      result[key] = {
        name: key,
        // Pretty label for the sidebar. The internal `name` is the unique
        // composite key; the embedder's chosen simulation name surfaces here.
        displayName: sim.name,
        ...(resource ? { resourceHtml: resource.html, resource: mcpResource } : {}),
        userMessage: sim.userMessage,
        tool: appTool.tool,
        toolInput: sim.toolInput,
        toolResult: sim.toolResult,
        serverTools: sim.serverTools,
      };
    }
  }

  return result;
}
