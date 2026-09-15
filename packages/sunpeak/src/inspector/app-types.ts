/**
 * Public input shape for embedding the Inspector inside another React app.
 *
 * Mirrors the MCP App data model: one App contains Resources, Tools, and
 * saved Simulations for testing states. UI tools link to resources via
 * `_meta.openai.outputTemplate`; backend-only tools can omit that link and
 * still be selected, called, inspected, and offered to model chat.
 *
 * The Inspector flattens this hierarchy into its internal `Simulation` map
 * at runtime, so callers can construct the structure they already have from
 * MCP `listTools` + `listResources` without translating between formats.
 */
import type { Tool, CallToolResult } from '@modelcontextprotocol/client';
import type { ServerToolMock } from '../types/simulation';

/** A resource owned by the App. The URI links it to one or more Tools. */
export interface InspectorAppResource {
  /**
   * URI that uniquely identifies this resource within the App. Tools refer
   * to it via `tool._meta.openai.outputTemplate`. Typically `ui://...`.
   */
  uri: string;
  /**
   * The HTML document for this resource. Pass the string returned by
   * `mcpClient.readResource({ uri })`; the Inspector hands it to the
   * sandbox iframe via PostMessage and never hosts it at a URL.
   */
  html: string;
  /**
   * Optional MIME type. Defaults to `text/html`. The current Inspector only
   * renders HTML — other types are reserved for future use.
   */
  mimeType?: string;
  /**
   * Optional MCP `_meta` payload carried through to the iframe. Used by the
   * MCP Apps SDK for resource-declared sandbox permissions, CSP, etc.
   *
   * Type is intentionally loose (`Record<string, unknown>`) — the Inspector
   * doesn't validate the shape, it only reads specific subkeys defensively
   * (`_meta.ui.permissions`, `_meta.ui.prefersBorder`, `_meta.ui.csp`). The
   * embedder is responsible for shape correctness if they want those
   * features. Other fields are ignored.
   */
  _meta?: Record<string, unknown>;
}

/** A simulation: one saved test state for a tool. */
export interface InspectorAppSimulation {
  /**
   * Unique simulation name within the tool — surfaced in the sidebar's
   * Simulation picker.
   */
  name: string;
  /**
   * Optional user prompt to display in the conversation chrome. When omitted,
   * the Inspector shows a generic "Call my <tool> tool" message.
   */
  userMessage?: string;
  /** Tool arguments — sent to the resource via the MCP Apps protocol. */
  toolInput?: Record<string, unknown>;
  /** Pre-canned tool result — what the model would receive. */
  toolResult?: CallToolResult;
  /**
   * Mock responses for `callServerTool` calls the resource makes back to the
   * server. Same shape as the existing `ServerToolMock` API.
   */
  serverTools?: Record<string, ServerToolMock>;
}

/** A tool defined by the App, plus any simulations testing its states. */
export interface InspectorAppTool {
  /**
   * MCP `Tool` definition. For UI tools, `_meta.openai.outputTemplate`
   * selects which resource the Inspector renders when this tool runs.
   * Backend-only tools can omit it; they stay available in the sidebar and
   * model chat, with a no-UI placeholder in the preview.
   */
  tool: Tool;
  /** Optional saved test states for this tool. */
  simulations?: InspectorAppSimulation[];
}

/**
 * One MCP App's data, in the shape the Inspector renders. Pass via the
 * `app` prop on `<Inspector />` when embedding inside another React app.
 */
export interface InspectorApp {
  /** Optional display name shown in the conversation chrome header. */
  name?: string;
  /**
   * Optional icon shown next to the name. Accepts either short text (e.g.
   * an emoji like `🎵`) or an `https://` URL — the host shells render the
   * URL as an `<img>` when it validates as an allowed origin, otherwise
   * fall back to rendering the value as text.
   */
  icon?: string;
  /** Resources this App exposes — typically one entry per UI surface. */
  resources: InspectorAppResource[];
  /** Tools this App exposes, including UI tools and backend-only tools. */
  tools: InspectorAppTool[];
}
