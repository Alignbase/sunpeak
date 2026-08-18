import * as React from 'react';
import type {
  McpUiDisplayMode,
  McpUiTheme,
  McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { readStoredPrefs, useInspectorState, writeStoredPrefs } from './use-inspector-state';
import { useMcpConnection, type AuthType, type AuthConfig } from './use-mcp-connection';
import { IframeResource } from './iframe-resource';
import { ThemeProvider } from './theme-provider';
import {
  SimpleSidebar,
  SidebarControl,
  SidebarCollapsibleControl,
  SidebarSelect,
  SidebarInput,
  SidebarCheckbox,
  SidebarTextarea,
  SidebarToggle,
} from './simple-sidebar';
import { getHostShell, getRegisteredHosts, type HostChatMessage, type HostId } from './hosts';
import { resolveServerToolResult } from '../types/simulation';
import type { Simulation } from '../types/simulation';
import type { ScreenWidth } from './inspector-types';
import { DEVICE_PRESETS, type DevicePresetSelection } from './device-presets';
import type { InspectorApp } from './app-types';
import { flattenAppToSimulations } from './app-flatten';
import { inspectorApiEndpoint, readInspectorJson } from './inspector-api';

// Register built-in host shells. These imports live here (in the component file)
// rather than in the barrel index.ts because Rollup code-splitting can separate
// side-effect imports from barrel exports, letting consumer bundlers tree-shake
// them. Importing here makes registration part of the Inspector component's
// dependency graph, which can't be tree-shaken since the component is used.
import '../chatgpt/chatgpt-host';
import '../claude/claude-host';

const DOCS_BASE_URL = 'https://sunpeak.ai/docs';

export interface InspectorModelProvider {
  id: string;
  label?: string;
  models?: string[];
  defaultModel?: string;
}

export interface InspectorModelChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface InspectorModelChatToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  result?: CallToolResult;
  isError?: boolean;
}

export interface InspectorModelAppContext {
  content?: unknown[];
  structuredContent?: unknown;
}

export interface InspectorModelChatResponse {
  text?: string;
  toolCalls?: InspectorModelChatToolCall[];
  error?: string;
}

export interface InspectorModelKeyStatus {
  hasKey: boolean;
  storage?: string;
  error?: string;
}

export interface InspectorModelChatRequest {
  /**
   * Stable identifier for the current visible model-chat transcript. It rotates
   * when the user resets model chat so backend-backed handlers can start a
   * fresh provider conversation.
   */
  conversationId?: string;
  provider: string;
  modelId: string;
  host?: HostId;
  messages: InspectorModelChatMessage[];
  tools: Simulation['tool'][];
  appContext?: InspectorModelAppContext;
}

export interface InspectorModelApiKeyController {
  /**
   * Whether chat submission should require a saved API key before enabling the
   * composer. Defaults to true when an apiKey controller is provided.
   */
  required?: boolean;
  /** Load whether this provider has a usable key in the embedder's backend. */
  getStatus?: (provider: string) => Promise<InspectorModelKeyStatus> | InspectorModelKeyStatus;
  /**
   * Save or clear a key in the embedder's backend. The Inspector never stores
   * this value when a custom controller is provided.
   */
  save?: (params: {
    provider: string;
    apiKey: string;
  }) => Promise<InspectorModelKeyStatus> | InspectorModelKeyStatus;
}

export interface InspectorModelChatOptions {
  enabled?: boolean;
  providers?: InspectorModelProvider[];
  defaultProvider?: string;
  defaultModel?: string;
  apiKey?: InspectorModelApiKeyController;
  onChat?: (request: InspectorModelChatRequest) => Promise<InspectorModelChatResponse>;
}

export interface InspectorProps {
  children?: React.ReactNode;
  /**
   * Hierarchical input for embedding: an MCP App with its resources, tools,
   * and saved simulations. Mirrors the MCP App data model — resources are
   * keyed by URI, UI tools link to resources with `_meta.openai.outputTemplate`,
   * and backend-only tools can be selected, called, and inspected without
   * rendering an iframe. The Inspector flattens this internally; pass the shape
   * you already have from `listTools` + `listResources` + your fixture store
   * and the component renders it. See `InspectorApp`.
   *
   * Mutually exclusive with `simulations`. When both are provided, `app`
   * wins — `simulations` stays for back-compat with the CLI codepath.
   */
  app?: InspectorApp;
  simulations?: Record<string, Simulation>;
  appName?: string;
  appIcon?: string;
  /** Which host shell to use initially. Defaults to 'chatgpt'. */
  defaultHost?: HostId;
  /** Override callServerTool resolution. When provided, bypasses simulation serverTools mocks. Routes through MCP which returns simulation fixture data for UI tools. */
  onCallTool?: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<CallToolResult> | CallToolResult;
  /** Direct tool handler call, bypassing MCP server mock data. Falls back to onCallTool if not provided. */
  onCallToolDirect?: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<CallToolResult> | CallToolResult;
  /** Live MCP tool calls used by AI/eval renders. Bypasses simulation fixtures. */
  onCallToolLive?: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<CallToolResult> | CallToolResult;
  /** Initial prod-resources mode state. When true, resources load from dist/ instead of HMR. Defaults to false. */
  defaultProdResources?: boolean;
  /** Hide framework-only controls (Prod Resources) in the inspector chrome. */
  hideInspectorModes?: boolean;
  /**
   * Demo mode for embedding on marketing sites. When true:
   * - Hides Prod Resources control
   * - Disables the MCP Server URL input (shows a static example URL)
   * - Hides the Run button (prevents sending real MCP requests)
   * - Hides connection status indicator
   */
  demoMode?: boolean;
  /**
   * Base URL of the separate-origin sandbox server (e.g., "http://localhost:24680").
   * When provided, the outer iframe loads from this URL instead of using srcdoc,
   * giving real cross-origin isolation that matches production hosts.
   */
  sandboxUrl?: string;
  /**
   * MCP server URL. Pre-populates the server URL field in the sidebar and
   * shows connection status. Users can edit this URL at any time to connect
   * to a different server.
   */
  mcpServerUrl?: string;
  /**
   * Base URL for the sunpeak inspector backend endpoints (`/__sunpeak/*`).
   * Defaults to same-origin. Embedders that serve the React Inspector from
   * their own app can point this at a same-origin proxy or hosted inspector
   * backend, for example `/api/sunpeak`.
   */
  inspectorApiBaseUrl?: string;
  /**
   * Programmatic model-chat integration. Embedders can provide their own
   * backend-backed `onChat` handler, provider/model list, and optional API-key
   * status/save callbacks. When omitted, the CLI inspector uses its local
   * `/__sunpeak/model-*` endpoints. Embedded inspectors enable model chat only
   * when this prop supplies `onChat`.
   */
  modelChat?: InspectorModelChatOptions;
}

type Platform = 'mobile' | 'desktop' | 'web';

/** Info about a unique tool, derived from simulations. */
interface ToolInfo {
  tool: Simulation['tool'];
  resource?: Simulation['resource'];
  /** All simulation names for this tool (first entry is the "base" for resource URL). */
  simNames: string[];
  /** Simulation names that have fixture data (toolInput, toolResult, or serverTools). */
  fixtureSimNames: string[];
}

const DEFAULT_MODEL_PROVIDERS: InspectorModelProvider[] = [
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.5' },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
  },
];

function createModelConversationId() {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `model-chat-${Date.now()}-${random}`;
}

function splitCssArgs(value: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) {
      args.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(value.slice(start).trim());
  return args;
}

function resolveLightDarkValue(value: string, theme: 'light' | 'dark'): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('light-dark(') || !trimmed.endsWith(')')) return value;
  const args = splitCssArgs(trimmed.slice('light-dark('.length, -1));
  if (args.length !== 2) return value;
  return theme === 'dark' ? args[1] : args[0];
}

/** Check whether a simulation has user-authored fixture data. */
function hasFixtureData(sim: Simulation): boolean {
  return sim.toolResult != null || sim.toolInput != null || sim.serverTools != null;
}

function isToolVisibleToModel(tool: Simulation['tool']): boolean {
  const meta = tool._meta as
    | {
        ui?: { visibility?: unknown };
        'ui/visibility'?: unknown;
      }
    | undefined;
  const visibility = meta?.ui?.visibility ?? meta?.['ui/visibility'];
  if (visibility == null) return true;
  return Array.isArray(visibility) && visibility.includes('model');
}

// Reference-stable empty default. A destructuring default of `= {}` creates a
// fresh object on every render — when combined with `useMemo(..., [..., props])`
// downstream that drives a `useEffect(setState(...), [memo])`, that produces
// an infinite render loop. Don't reinline this.
const EMPTY_SIMULATIONS: Readonly<Record<string, Simulation>> = Object.freeze({});

export function Inspector({
  children,
  app,
  simulations: initialSimulationsProp = EMPTY_SIMULATIONS,
  appName: appNameProp,
  appIcon: appIconProp,
  defaultHost = 'chatgpt',
  onCallTool,
  onCallToolDirect,
  onCallToolLive,
  defaultProdResources = false,
  hideInspectorModes = false,
  demoMode = false,
  sandboxUrl,
  mcpServerUrl,
  inspectorApiBaseUrl,
  modelChat,
}: InspectorProps) {
  // When `app` is provided it drives both the simulation map and the header
  // name/icon. Falling back to the legacy props keeps existing callers working.
  const initialSimulations = React.useMemo(
    () => (app ? flattenAppToSimulations(app) : initialSimulationsProp),
    [app, initialSimulationsProp]
  );
  const appName = app?.name ?? appNameProp ?? 'Sunpeak';
  const appIcon = app?.icon ?? appIconProp;
  // `!!app` (rather than `app !== undefined`) so a slipped-in `null` doesn't
  // flip the inspector into embedded mode while delivering no actual app.
  const isEmbedded = !!app;

  // Warn at most once per component instance when both inputs are supplied.
  // Without the ref guard the useEffect dep `initialSimulationsProp` changes
  // reference each parent render (when `simulations` is passed inline), which
  // would cause the warning to spam the console repeatedly.
  const conflictWarnedRef = React.useRef(false);
  React.useEffect(() => {
    if (conflictWarnedRef.current) return;
    if (app && initialSimulationsProp && Object.keys(initialSimulationsProp).length > 0) {
      conflictWarnedRef.current = true;
      console.warn(
        '[Inspector] Both `app` and `simulations` were provided. `app` takes precedence; `simulations` is ignored.'
      );
    }
  }, [app, initialSimulationsProp]);
  // Root element ref — host theming, CSS variables, and page-style overrides
  // are applied here rather than on `document.documentElement`. This keeps the
  // Inspector self-contained when embedded inside another React app: the host
  // page's `<button>`/`<input>`/typography stay untouched, and the inspector's
  // colors/fonts apply only to its own subtree.
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  // Simulations can be updated when the user reconnects to a different server.
  const [simulations, setSimulations] = React.useState(initialSimulations);
  // Sync with prop changes (e.g., HMR during development).
  React.useEffect(() => {
    setSimulations(initialSimulations);
  }, [initialSimulations]);

  // ── Derive tools from simulations ──
  // Each unique tool name becomes a ToolInfo with all its associated simulations.
  const toolMap = React.useMemo(() => {
    const map = new Map<string, ToolInfo>();
    for (const [simName, sim] of Object.entries(simulations)) {
      const toolName = sim.tool.name;
      if (!map.has(toolName)) {
        map.set(toolName, {
          tool: sim.tool,
          resource: sim.resource,
          simNames: [],
          fixtureSimNames: [],
        });
      }
      const info = map.get(toolName)!;
      if (!info.resource && sim.resource) {
        info.resource = sim.resource;
      }
      info.simNames.push(simName);
      if (hasFixtureData(sim)) {
        info.fixtureSimNames.push(simName);
      }
    }
    return map;
  }, [simulations]);

  const toolNames = React.useMemo(
    () =>
      Array.from(toolMap.keys()).sort((a, b) => {
        const infoA = toolMap.get(a)!;
        const infoB = toolMap.get(b)!;
        const labelA = (infoA.tool.title as string | undefined) || a;
        const labelB = (infoB.tool.title as string | undefined) || b;
        return labelA.localeCompare(labelB);
      }),
    [toolMap]
  );
  const defaultToolName = React.useMemo(
    () => toolNames.find((name) => !!toolMap.get(name)?.resource) ?? toolNames[0] ?? '',
    [toolMap, toolNames]
  );

  // Parse URL params once for tool/simulation initialization.
  const initUrlParams = React.useMemo(() => {
    if (typeof window === 'undefined')
      return { tool: null, simulation: null, noMockData: false, autoRun: false };
    const params = new URLSearchParams(window.location.search);
    return {
      tool: params.get('tool'),
      simulation: params.get('simulation'),
      noMockData: false,
      // autoRun: test fixtures set this to call the tool immediately on load
      // when no fixture data exists. Interactive users don't set this.
      autoRun: params.get('autoRun') === 'true',
    };
  }, []);
  const storedPrefs = React.useMemo(
    () => (initUrlParams.autoRun ? {} : readStoredPrefs()),
    [initUrlParams.autoRun]
  );

  // ── Tool selection ──
  // ?tool=X explicitly selects a tool. ?simulation=X infers the tool from the simulation.
  const [selectedToolName, setSelectedToolName] = React.useState(() => {
    if (initUrlParams.tool && toolMap.has(initUrlParams.tool)) return initUrlParams.tool;
    if (initUrlParams.simulation) {
      for (const [toolName, info] of toolMap) {
        if (info.simNames.includes(initUrlParams.simulation)) return toolName;
      }
    }
    return defaultToolName;
  });

  // Reset tool selection when tools change (e.g., after reconnect)
  const prevToolNamesRef = React.useRef(toolNames);
  if (prevToolNamesRef.current !== toolNames) {
    prevToolNamesRef.current = toolNames;
    if (toolNames.length > 0 && !toolMap.has(selectedToolName)) {
      setSelectedToolName(defaultToolName);
    }
  }

  const selectedToolInfo = toolMap.get(selectedToolName);

  // ── Simulation selection ──
  // null = "None" (no mock data, call the real server)
  // string = a specific simulation with fixture data
  // ?tool=X without ?simulation=Y means "select tool, no mock data"
  const [activeSimulationName, setActiveSimulationName] = React.useState<string | null>(() => {
    if (!selectedToolInfo) return null;
    if (initUrlParams.noMockData) return null;
    if (initUrlParams.tool && !initUrlParams.simulation) return null;
    // ?simulation=X explicitly selects a simulation (if it exists and has fixture data)
    if (
      initUrlParams.simulation &&
      selectedToolInfo.fixtureSimNames.includes(initUrlParams.simulation)
    ) {
      return initUrlParams.simulation;
    }
    return selectedToolInfo.fixtureSimNames[0] ?? null;
  });
  const [isLiveMcpRender, setIsLiveMcpRender] = React.useState(false);

  // When tool changes, auto-select first fixture simulation (or null)
  const prevToolNameRef = React.useRef(selectedToolName);
  if (prevToolNameRef.current !== selectedToolName) {
    prevToolNameRef.current = selectedToolName;
    const newInfo = toolMap.get(selectedToolName);
    setActiveSimulationName(isLiveMcpRender ? null : (newInfo?.fixtureSimNames[0] ?? null));
  }

  // The effective simulation name for useInspectorState:
  // - If a fixture simulation is active, use it (for tool input, tool result, resource URL)
  // - Otherwise, use the base simulation for the tool (for resource URL, tool definition)
  const effectiveSimulationName = activeSimulationName ?? selectedToolInfo?.simNames[0] ?? '';

  // Derive the current simulation directly from simulations + effectiveSimulationName.
  // This avoids the one-render lag from the useEffect sync to state.selectedSimulationName.
  const currentSim = simulations[effectiveSimulationName];

  const state = useInspectorState({
    simulations,
    defaultHost,
    preserveToolDataOnSimulationChange: isLiveMcpRender,
  });
  const resetAppContextForSelectionChange = () => {
    state.setModelContext(null);
    state.setModelAppContext(null);
    state.setModelContextJson('null');
    state.setModelContextError('');
  };
  const [serverUrl, setServerUrl] = React.useState(mcpServerUrl ?? '');
  const [authType, setAuthType] = React.useState<AuthType>('none');
  const [bearerToken, setBearerToken] = React.useState('');
  const [oauthScopes, setOauthScopes] = React.useState('');
  const [oauthClientId, setOauthClientId] = React.useState('');
  const [oauthClientSecret, setOauthClientSecret] = React.useState('');
  const [oauthClientMetadataUrl, setOauthClientMetadataUrl] = React.useState('');
  const [oauthTokenEndpointAuthMethod, setOauthTokenEndpointAuthMethod] = React.useState('auto');
  const [oauthAuthorizationServer, setOauthAuthorizationServer] = React.useState('');
  const [oauthAuthorizationServers, setOauthAuthorizationServers] = React.useState<string[]>([]);
  const [oauthStatus, setOauthStatus] = React.useState<
    'none' | 'authorizing' | 'authorized' | 'error'
  >('none');
  const [oauthError, setOauthError] = React.useState<string | undefined>();
  const [isAuthenticationExpanded, setIsAuthenticationExpanded] = React.useState(false);

  React.useEffect(() => {
    if (oauthError || oauthStatus === 'error') setIsAuthenticationExpanded(true);
  }, [oauthError, oauthStatus]);

  const handleOAuthRequired = React.useCallback((sunpeakMeta: Record<string, unknown>) => {
    setAuthType('oauth');
    const authorizationServers = Array.isArray(sunpeakMeta.authorizationServers)
      ? sunpeakMeta.authorizationServers.filter(
          (issuer): issuer is string => typeof issuer === 'string'
        )
      : [];
    setOauthAuthorizationServers(authorizationServers);
    setOauthAuthorizationServer((current) =>
      authorizationServers.length > 1
        ? authorizationServers.includes(current)
          ? current
          : authorizationServers[0]
        : ''
    );
    setOauthStatus('none');
    setOauthError('Additional authorization is required. Click Authorize to continue.');
  }, []);

  // useMcpConnection does a mount-only health check for the initial URL.
  // URL changes are handled below via connection.reconnect().
  // In embedded mode (`app` prop) the Inspector never talks to /__sunpeak/*
  // endpoints — connection state lives in the embedding app's MCP client.
  const connection = useMcpConnection(
    isEmbedded ? undefined : mcpServerUrl || undefined,
    inspectorApiBaseUrl
  );
  const [prodResources, setProdResources] = React.useState(
    state.urlProdResources ?? storedPrefs.prodResources ?? defaultProdResources
  );
  const showSidebar = state.urlSidebar !== false;
  const showDevOverlay = state.urlDevOverlay !== false;
  const [isRunning, setIsRunning] = React.useState(false);
  const [hasRun, setHasRun] = React.useState(false);
  const [showCheck, setShowCheck] = React.useState(false);
  const [serverPreviewGeneration, setServerPreviewGeneration] = React.useState(0);
  const checkTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const oauthCleanupRef = React.useRef<(() => void) | undefined>(undefined);
  const modelProviderOptions = React.useMemo(
    () => (modelChat?.providers?.length ? modelChat.providers : DEFAULT_MODEL_PROVIDERS),
    [modelChat?.providers]
  );
  const modelChatHandler = modelChat?.onChat;
  const customApiKey = modelChat?.apiKey;
  const modelChatRequested = modelChat?.enabled ?? true;
  const canUseModelChat =
    !demoMode &&
    (isEmbedded
      ? modelChat?.enabled === true && typeof modelChatHandler === 'function'
      : modelChatRequested);
  const usesLocalModelEndpoints = canUseModelChat && typeof modelChatHandler !== 'function';
  const usesApiKeyUi = canUseModelChat && (usesLocalModelEndpoints || !!customApiKey);
  const requiresModelApiKey = usesApiKeyUi && (customApiKey?.required ?? true);
  const defaultModelProvider = React.useMemo(() => {
    const requested = modelChat?.defaultProvider;
    if (requested && modelProviderOptions.some((provider) => provider.id === requested)) {
      return requested;
    }
    return modelProviderOptions[0]?.id ?? 'openai';
  }, [modelChat?.defaultProvider, modelProviderOptions]);
  const initialModelProvider = React.useMemo(() => {
    const stored = storedPrefs.modelProvider;
    if (stored && modelProviderOptions.some((provider) => provider.id === stored)) {
      return stored;
    }
    return defaultModelProvider;
  }, [defaultModelProvider, modelProviderOptions, storedPrefs.modelProvider]);
  const getDefaultModelId = React.useCallback(
    (provider: string) => {
      const option = modelProviderOptions.find((item) => item.id === provider);
      const candidates = [
        option?.defaultModel,
        modelChat?.defaultModel,
        DEFAULT_MODEL_PROVIDERS.find((item) => item.id === provider)?.defaultModel,
      ];
      const providerModels = option?.models ?? [];
      if (providerModels.length === 0) {
        return candidates.find(Boolean) ?? '';
      }
      return (
        candidates.find((model) => model && providerModels.includes(model)) ?? providerModels[0]
      );
    },
    [modelChat?.defaultModel, modelProviderOptions]
  );
  const getInitialModelId = React.useCallback(
    (provider: string) => {
      const stored = storedPrefs.modelId;
      if (storedPrefs.modelProvider && storedPrefs.modelProvider !== provider) {
        return getDefaultModelId(provider);
      }
      const option = modelProviderOptions.find((item) => item.id === provider);
      const providerModels = option?.models ?? [];
      if (stored && (providerModels.length === 0 || providerModels.includes(stored))) {
        return stored;
      }
      return getDefaultModelId(provider);
    },
    [getDefaultModelId, modelProviderOptions, storedPrefs.modelId, storedPrefs.modelProvider]
  );
  const [modelProvider, setModelProvider] = React.useState(initialModelProvider);
  const [modelId, setModelId] = React.useState(() => getInitialModelId(initialModelProvider));
  const [apiKeyDraft, setApiKeyDraft] = React.useState('');
  const [keyStatus, setKeyStatus] = React.useState<InspectorModelKeyStatus>({ hasKey: false });
  const [isKeyStatusLoading, setIsKeyStatusLoading] = React.useState(usesApiKeyUi);
  const [keyMessage, setKeyMessage] = React.useState('');
  const [chatMessages, setChatMessages] = React.useState<HostChatMessage[]>([]);
  const [chatInput, setChatInput] = React.useState('');
  const [isChatting, setIsChatting] = React.useState(false);
  const [chatStatus, setChatStatus] = React.useState('');
  const modelConversationIdRef = React.useRef(createModelConversationId());
  const currentModelProvider = React.useMemo(
    () => modelProviderOptions.find((provider) => provider.id === modelProvider),
    [modelProvider, modelProviderOptions]
  );
  const selectedProviderModelOptions = React.useMemo(
    () => currentModelProvider?.models ?? [],
    [currentModelProvider?.models]
  );
  const modelCallableTools = React.useMemo(() => {
    const map = new Map<string, Simulation['tool']>();
    for (const sim of Object.values(simulations)) {
      if (!isToolVisibleToModel(sim.tool) || map.has(sim.tool.name)) continue;
      map.set(sim.tool.name, sim.tool);
    }
    return Array.from(map.values());
  }, [simulations]);

  const isFirstInspectorPrefsRender = React.useRef(true);
  React.useEffect(() => {
    if (isFirstInspectorPrefsRender.current) {
      isFirstInspectorPrefsRender.current = false;
      return;
    }
    if (initUrlParams.autoRun) return;
    writeStoredPrefs({
      ...readStoredPrefs(),
      prodResources,
      modelProvider,
      modelId,
    });
  }, [initUrlParams.autoRun, modelId, modelProvider, prodResources]);

  React.useEffect(() => {
    const nextServerUrl = mcpServerUrl ?? '';
    setServerUrl(nextServerUrl);
  }, [mcpServerUrl]);

  const handleModelProviderChange = React.useCallback(
    (provider: string) => {
      setModelProvider(provider);
      setApiKeyDraft('');
      setKeyMessage('');
      setKeyStatus({ hasKey: false });
      setIsKeyStatusLoading(usesApiKeyUi);
      setModelId(getDefaultModelId(provider));
    },
    [getDefaultModelId, usesApiKeyUi]
  );

  React.useEffect(() => {
    if (modelProviderOptions.some((provider) => provider.id === modelProvider)) return;
    handleModelProviderChange(defaultModelProvider);
  }, [defaultModelProvider, handleModelProviderChange, modelProvider, modelProviderOptions]);

  React.useEffect(() => {
    if (
      selectedProviderModelOptions.length === 0 ||
      selectedProviderModelOptions.includes(modelId)
    ) {
      return;
    }
    setModelId(getDefaultModelId(modelProvider));
  }, [getDefaultModelId, modelId, modelProvider, selectedProviderModelOptions]);

  React.useEffect(() => {
    if (!canUseModelChat || !usesApiKeyUi) {
      setIsKeyStatusLoading(false);
      setKeyStatus({ hasKey: false });
      setKeyMessage('');
      return;
    }
    let cancelled = false;
    setIsKeyStatusLoading(true);
    const loadStatus = async () => {
      if (customApiKey?.getStatus) {
        return await customApiKey.getStatus(modelProvider);
      }
      if (!usesLocalModelEndpoints) {
        return { hasKey: false };
      }
      const endpoint = inspectorApiEndpoint(
        `/__sunpeak/model-key?provider=${encodeURIComponent(modelProvider)}`,
        inspectorApiBaseUrl
      );
      const res = await fetch(endpoint);
      return await readInspectorJson<InspectorModelKeyStatus>(res, endpoint);
    };
    loadStatus()
      .then((data) => {
        if (cancelled) return;
        setKeyStatus(data);
        setKeyMessage(data.error ?? '');
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setKeyStatus({
          hasKey: false,
          error: message,
        });
        setKeyMessage(message);
      })
      .finally(() => {
        if (!cancelled) setIsKeyStatusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    canUseModelChat,
    customApiKey,
    inspectorApiBaseUrl,
    modelProvider,
    usesApiKeyUi,
    usesLocalModelEndpoints,
  ]);

  const handleSaveApiKey = React.useCallback(async () => {
    if (!canUseModelChat || !usesApiKeyUi) return;
    setKeyMessage('Saving...');
    try {
      let data: InspectorModelKeyStatus;
      if (customApiKey?.save) {
        data = await customApiKey.save({ provider: modelProvider, apiKey: apiKeyDraft });
      } else if (usesLocalModelEndpoints) {
        const endpoint = inspectorApiEndpoint('/__sunpeak/model-key', inspectorApiBaseUrl);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: modelProvider, apiKey: apiKeyDraft }),
        });
        data = await readInspectorJson<InspectorModelKeyStatus>(res, endpoint);
        if (!res.ok || data.error) {
          throw new Error(data.error ?? `Save failed (${res.status})`);
        }
      } else {
        throw new Error('No API key save handler is configured.');
      }
      if (data.error) {
        throw new Error(data.error);
      }
      setKeyStatus(data);
      setIsKeyStatusLoading(false);
      setApiKeyDraft('');
      setKeyMessage(data.hasKey ? `Saved ${data.storage ?? 'locally'}` : 'Cleared');
    } catch (err) {
      setKeyMessage(err instanceof Error ? err.message : String(err));
    }
  }, [
    apiKeyDraft,
    canUseModelChat,
    customApiKey,
    inspectorApiBaseUrl,
    modelProvider,
    usesApiKeyUi,
    usesLocalModelEndpoints,
  ]);

  const handleResetModelConversation = React.useCallback(() => {
    const nextConversationId = createModelConversationId();
    modelConversationIdRef.current = nextConversationId;
    setChatMessages([]);
    setChatInput('');
    setChatStatus('');
    setIsChatting(false);
  }, []);

  // Keep useInspectorState's selection in sync with our tool/simulation selection.
  React.useEffect(() => {
    state.setSelectedSimulationName(effectiveSimulationName);
  }, [effectiveSimulationName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build the current auth config for reconnects
  const currentAuthConfig = React.useMemo<AuthConfig | undefined>(() => {
    if (authType === 'bearer' && bearerToken) {
      return { type: 'bearer', bearerToken };
    }
    if (authType === 'oauth') {
      return { type: 'oauth' };
    }
    return undefined;
  }, [authType, bearerToken]);

  // Handle URL changes: when the user edits the server URL, reconnect to the new server.
  // The hook's mount-only health check handles the initial URL — this effect handles changes.
  const prevServerUrlRef = React.useRef(serverUrl);
  React.useEffect(() => {
    const urlChanged = serverUrl !== prevServerUrlRef.current;
    prevServerUrlRef.current = serverUrl;
    if (!urlChanged) return;
    oauthCleanupRef.current?.();
    setOauthStatus('none');
    setOauthError(undefined);
    setOauthAuthorizationServer('');
    setOauthAuthorizationServers([]);
    if (serverUrl) {
      if (authType === 'oauth') {
        // Don't auto-connect for OAuth — user must click Authorize
        return;
      }
      connection.reconnect(serverUrl, currentAuthConfig);
    }
  }, [serverUrl, connection.reconnect, authType, currentAuthConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  // OAuth flow handler (disabled in demo mode)
  const handleStartOAuth = React.useCallback(async () => {
    if (!serverUrl || demoMode) return;
    oauthCleanupRef.current?.();
    setOauthStatus('authorizing');
    setOauthError(undefined);

    // Open a blank popup immediately (synchronous, inside the click handler)
    // so browsers treat it as a user-initiated action and don't block it.
    // We'll navigate it to the auth URL after the server responds.
    const popup = window.open(
      'about:blank',
      `sunpeak-oauth-${Date.now()}`,
      'width=600,height=700,popup=yes'
    );

    try {
      const endpoint = inspectorApiEndpoint('/__sunpeak/oauth/start', inspectorApiBaseUrl);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: serverUrl,
          scope: oauthScopes || undefined,
          clientId: oauthClientId || undefined,
          clientSecret: oauthClientSecret || undefined,
          clientMetadataUrl: oauthClientMetadataUrl || undefined,
          tokenEndpointAuthMethod:
            oauthTokenEndpointAuthMethod === 'auto' ? undefined : oauthTokenEndpointAuthMethod,
          authorizationServer: oauthAuthorizationServer || undefined,
        }),
      });
      const data = await readInspectorJson<{
        error?: string;
        status?: string;
        authUrl?: string;
        authorizationServers?: string[];
        simulations?: Record<string, unknown>;
      }>(res, endpoint);
      if (!res.ok) {
        let message = `OAuth start failed (${res.status})`;
        if (data.error) message = data.error;
        throw new Error(message);
      }

      if (data.error) {
        popup?.close();
        setOauthError(data.error);
        setOauthStatus('error');
        return;
      }

      if (data.status === 'authorized') {
        // Already authorized (tokens were cached)
        popup?.close();
        setOauthStatus('authorized');
        connection.setConnected(data.simulations);
        return;
      }

      if (data.status === 'authorization_server_required' && data.authorizationServers?.length) {
        popup?.close();
        setOauthAuthorizationServers(data.authorizationServers);
        setOauthAuthorizationServer((current) =>
          data.authorizationServers!.includes(current) ? current : data.authorizationServers![0]
        );
        setOauthError('Select an authorization server, then click Authorize again.');
        setOauthStatus('none');
        return;
      }

      if (data.status === 'redirect' && data.authUrl) {
        // Defense in depth: refuse to navigate the popup to anything that
        // isn't a real http(s) URL. The server validates this too, but a
        // `javascript:` URL slipping through here would execute attacker
        // code in the inspector's origin (popup inherits opener origin).
        let parsedAuthUrl: URL | null = null;
        try {
          parsedAuthUrl = new URL(data.authUrl);
        } catch {
          // fall through to error below
        }
        if (
          !parsedAuthUrl ||
          (parsedAuthUrl.protocol !== 'http:' && parsedAuthUrl.protocol !== 'https:')
        ) {
          popup?.close();
          setOauthError('OAuth authorization URL is not a valid http(s) URL.');
          setOauthStatus('error');
          return;
        }
        const expectedState = parsedAuthUrl.searchParams.get('state');
        if (!expectedState) {
          popup?.close();
          setOauthError('OAuth authorization URL is missing the state parameter.');
          setOauthStatus('error');
          return;
        }
        // Navigate the pre-opened popup to the authorization URL.
        // If the popup was blocked, show an error.
        if (!popup || popup.closed) {
          setOauthError('Popup was blocked. Allow popups for this site and try again.');
          setOauthStatus('error');
          return;
        }
        // The popup starts as same-origin about:blank so browsers count it as
        // user-initiated, but the remote authorization page must not keep an
        // opener reference back to the inspector. Cross-origin pages cannot
        // read the inspector, but they can navigate window.opener.
        try {
          popup.opener = null;
        } catch {
          // Some browser/window shims expose opener as read-only. The callback
          // still validates origin/state; this is best-effort hardening.
        }
        popup.location.href = parsedAuthUrl.toString();

        // Listen for the popup's callback via two channels:
        // 1. postMessage — works when window.opener is available
        // 2. BroadcastChannel — fallback for OAuth providers that set
        //    Cross-Origin-Opener-Policy (COOP) which nullifies window.opener
        let checkClosed: ReturnType<typeof setInterval>;
        let bc: BroadcastChannel | undefined;
        const cleanup = () => {
          clearInterval(checkClosed);
          window.removeEventListener('message', handleMessage);
          bc?.close();
          oauthCleanupRef.current = undefined;
        };
        // Store cleanup so it runs on unmount if the popup is still open.
        oauthCleanupRef.current?.();
        oauthCleanupRef.current = cleanup;
        const handleOAuthResult = (result: Record<string, unknown>) => {
          if (result.state !== expectedState) return;
          cleanup();
          if (result.error) {
            setOauthError((result.errorDescription || result.error) as string);
            setOauthStatus('error');
          } else if (result.success) {
            setOauthStatus('authorized');
            connection.setConnected(result.simulations as Record<string, unknown> | undefined);
          }
        };
        // Channel 1: postMessage (origin-verified)
        const handleMessage = (event: MessageEvent) => {
          if (event.origin !== window.location.origin) return;
          if (event.source !== popup) return;
          if (event.data?.type !== 'sunpeak-oauth-callback') return;
          handleOAuthResult(event.data);
        };
        window.addEventListener('message', handleMessage);
        // Channel 2: BroadcastChannel (same-origin by spec, no extra check needed)
        if (typeof BroadcastChannel !== 'undefined') {
          bc = new BroadcastChannel('sunpeak-oauth');
          bc.onmessage = (event) => {
            if (event.data?.type !== 'sunpeak-oauth-callback') return;
            handleOAuthResult(event.data);
          };
        }

        // Clean up if popup is closed without completing
        checkClosed = setInterval(() => {
          if (popup?.closed) {
            cleanup();
            // Only reset if still authorizing (not yet completed)
            setOauthStatus((prev) => (prev === 'authorizing' ? 'none' : prev));
          }
        }, 500);
      }
    } catch (err) {
      popup?.close();
      setOauthError(err instanceof Error ? err.message : String(err));
      setOauthStatus('error');
    }
  }, [
    serverUrl,
    oauthScopes,
    oauthClientId,
    oauthClientSecret,
    oauthClientMetadataUrl,
    oauthTokenEndpointAuthMethod,
    oauthAuthorizationServer,
    demoMode,
    connection,
    inspectorApiBaseUrl,
  ]);

  const handleClearOAuth = React.useCallback(async () => {
    if (!serverUrl || demoMode) return;
    const endpoint = inspectorApiEndpoint('/__sunpeak/oauth/reset', inspectorApiBaseUrl);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: serverUrl }),
      });
      const data = await readInspectorJson<{ error?: string }>(response, endpoint);
      if (!response.ok) throw new Error(data.error || `OAuth reset failed (${response.status})`);
      setOauthStatus('none');
      setOauthError(undefined);
      setOauthAuthorizationServer('');
      setOauthAuthorizationServers([]);
    } catch (error) {
      setOauthStatus('error');
      setOauthError(error instanceof Error ? error.message : String(error));
    }
  }, [serverUrl, demoMode, inspectorApiBaseUrl]);

  // When reconnecting to a new server succeeds, update simulations.
  // Only clear on error after a user-initiated reconnect (URL change), not on the
  // initial health check — so prop-based simulations from fixture files survive
  // a server that happens to be unreachable on mount.
  React.useEffect(() => {
    if (connection.simulations) {
      setSimulations(connection.simulations as Record<string, Simulation>);
      setServerPreviewGeneration((generation) => generation + 1);
    } else if (connection.status === 'error' && connection.hasReconnected) {
      setSimulations({});
    }
  }, [connection.simulations, connection.status, connection.hasReconnected]);

  // Sync mock data based on the active simulation selection.
  // - "None" (null): clear toolResult so the "Press Run" empty state shows.
  // - Simulation selected: restore toolResult from the fixture. This handles the
  //   case where effectiveSimulationName didn't change (e.g., None → same fixture),
  //   so useInspectorState's internal sync wouldn't re-run.
  const { setToolResult, setToolResultJson, setToolResultError } = state;
  React.useEffect(() => {
    if (activeSimulationName === null) {
      if (isLiveMcpRender) return;
      setToolResult(undefined);
      setToolResultJson('');
      setToolResultError('');
    } else {
      setIsLiveMcpRender(false);
      const sim = simulations[activeSimulationName];
      const result = (sim?.toolResult as CallToolResult | undefined) ?? undefined;
      setToolResult(result);
      setToolResultJson(result ? JSON.stringify(result, null, 2) : '');
      setToolResultError('');
    }
  }, [
    activeSimulationName,
    effectiveSimulationName,
    isLiveMcpRender,
    simulations,
    setToolResult,
    setToolResultJson,
    setToolResultError,
  ]);

  // Reset hasRun and timing when tool or simulation changes.
  React.useEffect(() => {
    if (isLiveMcpRender) return;
    setHasRun(false);
  }, [effectiveSimulationName, isLiveMcpRender]);

  // Cleanup timers and OAuth listeners on unmount
  React.useEffect(
    () => () => {
      clearTimeout(checkTimerRef.current);
      oauthCleanupRef.current?.();
    },
    []
  );

  // Run button handler: call the real tool handler with current toolInput.
  // Uses currentSim (derived directly from simulations + effectiveSimulationName)
  // rather than state.selectedSim, which lags one render behind due to the
  // useEffect sync from effectiveSimulationName → state.setSelectedSimulationName.
  const handleRun = React.useCallback(async () => {
    const caller = onCallToolDirect ?? onCallTool;
    const sim = simulations[effectiveSimulationName];
    if (!caller || !sim) return;
    const toolName = sim.tool.name;
    setIsRunning(true);
    setIsLiveMcpRender(false);
    const startTime = performance.now();
    try {
      const result = await caller({ name: toolName, arguments: state.toolInput });
      const clientMs = Math.round((performance.now() - startTime) * 10) / 10;
      // Prefer server-reported timing (_meta._sunpeak.requestTimeMs) when available,
      // since it measures actual handler execution. Fall back to client round-trip
      // for non-sunpeak servers that don't include server-side timing.
      const resultMeta = (result as Record<string, unknown>)?._meta as
        Record<string, unknown> | undefined;
      const sunpeakMeta = resultMeta?._sunpeak as Record<string, unknown> | undefined;
      if (sunpeakMeta?.oauthRequired === true) {
        handleOAuthRequired(sunpeakMeta);
      }
      const serverMs = sunpeakMeta?.requestTimeMs;
      const durationMs = typeof serverMs === 'number' ? serverMs : clientMs;
      const resultWithTiming = {
        ...result,
        _meta: { ...resultMeta, _sunpeak: { ...sunpeakMeta, requestTimeMs: durationMs } },
      };
      state.setToolResult(resultWithTiming);
      // Strip _sunpeak timing from the display JSON so the textarea shows the
      // clean result the app would receive. The server may include _meta._sunpeak.
      const displayResult = resultMeta?._sunpeak
        ? (() => {
            const { _sunpeak: _, ...cleanMeta } = resultMeta;
            const clean = { ...result } as Record<string, unknown>;
            clean._meta = Object.keys(cleanMeta).length > 0 ? cleanMeta : undefined;
            if (clean._meta === undefined) delete clean._meta;
            return clean;
          })()
        : result;
      state.setToolResultJson(JSON.stringify(displayResult, null, 2));
      state.setToolResultError('');
      setHasRun(true);
      setShowCheck(true);
      clearTimeout(checkTimerRef.current);
      checkTimerRef.current = setTimeout(() => setShowCheck(false), 2000);
    } catch (err) {
      const durationMs = Math.round((performance.now() - startTime) * 10) / 10;
      const message = err instanceof Error ? err.message : String(err);
      state.setToolResult({
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
        _meta: { _sunpeak: { requestTimeMs: durationMs } },
      });
      state.setToolResultJson(
        JSON.stringify(
          { content: [{ type: 'text', text: `Error: ${message}` }], isError: true },
          null,
          2
        )
      );
      setHasRun(true);
    } finally {
      setIsRunning(false);
    }
  }, [
    onCallTool,
    onCallToolDirect,
    simulations,
    effectiveSimulationName,
    state,
    handleOAuthRequired,
  ]);

  const handleChatSubmit = React.useCallback(async () => {
    const prompt = chatInput.trim();
    if (
      !prompt ||
      isChatting ||
      isKeyStatusLoading ||
      !canUseModelChat ||
      (requiresModelApiKey && !keyStatus.hasKey) ||
      !modelId.trim()
    ) {
      return;
    }

    const userMessage: HostChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: prompt,
    };
    const nextMessages = [...chatMessages, userMessage];
    setChatMessages(nextMessages);
    setChatInput('');
    setIsChatting(true);
    setChatStatus('Thinking...');
    setIsLiveMcpRender(false);
    setActiveSimulationName(null);
    state.setToolResult(undefined);
    state.setToolResultJson('');
    state.setToolResultError('');
    setHasRun(false);
    const requestConversationId = modelConversationIdRef.current;

    try {
      const messages = nextMessages
        .map((message) => ({
          role: message.role,
          content: message.content.trim(),
        }))
        .filter((message) => message.content.length > 0);
      let data: InspectorModelChatResponse;
      if (modelChatHandler) {
        data = await modelChatHandler({
          conversationId: requestConversationId,
          provider: modelProvider,
          modelId,
          host: state.activeHost,
          messages,
          tools: modelCallableTools,
          appContext: state.modelAppContext ?? undefined,
        });
      } else {
        const endpoint = inspectorApiEndpoint('/__sunpeak/model-chat', inspectorApiBaseUrl);
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: requestConversationId,
            provider: modelProvider,
            modelId,
            host: state.activeHost,
            messages,
            appContext: state.modelAppContext ?? undefined,
          }),
        });
        data = await readInspectorJson<InspectorModelChatResponse>(res, endpoint);
        if (!res.ok || data.error) {
          throw new Error(data.error ?? `Model request failed (${res.status})`);
        }
      }
      if (data.error) {
        throw new Error(data.error);
      }
      if (requestConversationId !== modelConversationIdRef.current) return;

      let rendersApp = false;
      const toolCalls = data.toolCalls ?? [];
      for (let index = toolCalls.length - 1; index >= 0; index--) {
        const call = toolCalls[index];
        const info = toolMap.get(call.name);
        if (!info?.resource || !call.result) continue;
        setSelectedToolName(call.name);
        setActiveSimulationName(null);
        setIsLiveMcpRender(true);
        state.setToolInput(call.arguments ?? {});
        state.setToolInputJson(JSON.stringify(call.arguments ?? {}, null, 2));
        state.setToolInputError('');
        state.setToolResult(call.result);
        state.setToolResultJson(JSON.stringify(call.result, null, 2));
        state.setToolResultError('');
        setHasRun(true);
        rendersApp = true;
        break;
      }

      const assistantMessage: HostChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content:
          data.text ??
          (rendersApp
            ? 'I called the MCP tool and rendered the app below.'
            : toolCalls.length > 0
              ? 'I called the MCP tool.'
              : 'The model returned an empty response.'),
        toolCalls: toolCalls.map((call) => ({
          name: call.name,
          arguments: call.arguments,
          isError: call.isError || call.result?.isError,
        })),
        rendersApp,
      };
      setChatMessages((messages) => {
        const base = rendersApp
          ? messages.map((message) =>
              message.rendersApp ? { ...message, rendersApp: false } : message
            )
          : messages;
        return [...base, assistantMessage];
      });
      setChatStatus('');
    } catch (err) {
      if (requestConversationId !== modelConversationIdRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setChatMessages((messages) => [
        ...messages,
        {
          id: `assistant-error-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${message}`,
        },
      ]);
      setChatStatus(message);
    } finally {
      if (requestConversationId === modelConversationIdRef.current) {
        setIsChatting(false);
      }
    }
  }, [
    canUseModelChat,
    chatInput,
    chatMessages,
    inspectorApiBaseUrl,
    isChatting,
    isKeyStatusLoading,
    keyStatus.hasKey,
    modelCallableTools,
    modelChatHandler,
    modelId,
    modelProvider,
    requiresModelApiKey,
    state,
    toolMap,
  ]);

  // Auto-run: when ?autoRun=true is set (by test fixtures) and no fixture data
  // is active, call the tool immediately with the current toolInput. Interactive
  // users don't set this flag, so browsing tools in the sidebar never triggers
  // an automatic server call. Only fires once on mount.
  const autoRunFired = React.useRef(false);
  React.useEffect(() => {
    if (
      initUrlParams.autoRun &&
      !autoRunFired.current &&
      activeSimulationName === null &&
      (onCallTool || onCallToolDirect)
    ) {
      autoRunFired.current = true;
      handleRun();
    }
  }, [initUrlParams.autoRun, activeSimulationName, onCallTool, onCallToolDirect, handleRun]);

  // Resolve the active host shell
  const activeShell = getHostShell(state.activeHost);
  const registeredHosts = getRegisteredHosts();
  const ShellConversation = activeShell?.Conversation;

  // Merge host style variables, userAgent, and availableDisplayModes into hostContext.
  const hostContext = React.useMemo(() => {
    const styleVars = activeShell?.styleVariables;
    const userAgent = activeShell?.userAgent;
    const ctx = { ...state.hostContext };
    if (styleVars) {
      (ctx as McpUiHostContext).styles = { variables: styleVars };
    }
    if (userAgent) {
      (ctx as McpUiHostContext).userAgent = userAgent;
    }
    if (activeShell?.availableDisplayModes) {
      (ctx as McpUiHostContext).availableDisplayModes = activeShell.availableDisplayModes;
    }
    return ctx as McpUiHostContext;
  }, [state.hostContext, activeShell]);

  // Reset display mode to inline if the active host doesn't support it.
  const { displayMode, setDisplayMode } = state;
  React.useEffect(() => {
    const modes = activeShell?.availableDisplayModes;
    if (modes && !modes.includes(displayMode)) {
      setDisplayMode('inline');
    }
  }, [activeShell, displayMode, setDisplayMode]);

  // Apply host theming + CSS variables + page styles to the inspector root.
  // Scoped to the root element (not document.documentElement) so the host page
  // is unaffected when the Inspector is embedded inside another React app.
  // Uses useLayoutEffect so values are set BEFORE paint, preventing a flash
  // of stale colors when switching hosts or toggling theme.
  //
  // Both `styleVariables` (--color-* tokens) and `pageStyles` keys are tracked
  // so they can be removed when switching to a host that doesn't define them.
  // Necessary for third-party HostShells; the two built-in shells happen to
  // define the same set of keys so this would otherwise look like it works
  // by overwriting.
  const prevStyleVarKeysRef = React.useRef<string[]>([]);
  const prevPageStyleKeysRef = React.useRef<string[]>([]);
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    // Data attributes — `data-theme` drives the Tailwind `dark` variant via
    // the `@custom-variant` rule in globals.css. `color-scheme` is set so
    // `light-dark()` CSS functions resolve correctly inside the subtree.
    root.setAttribute('data-theme', state.theme);
    root.style.colorScheme = state.theme;

    // Style variables (e.g. host-specific --color-* tokens).
    for (const key of prevStyleVarKeysRef.current) {
      root.style.removeProperty(key);
    }
    const vars = activeShell?.styleVariables;
    if (vars) {
      const keys: string[] = [];
      for (const [key, value] of Object.entries(vars)) {
        if (value) {
          root.style.setProperty(key, value);
          keys.push(key);
        }
      }
      prevStyleVarKeysRef.current = keys;
    } else {
      prevStyleVarKeysRef.current = [];
    }

    // Page-level style overrides.
    for (const key of prevPageStyleKeysRef.current) {
      root.style.removeProperty(key);
    }
    const pageStyles = activeShell?.pageStyles;
    if (pageStyles) {
      const keys: string[] = [];
      for (const [key, value] of Object.entries(pageStyles)) {
        root.style.setProperty(key, value);
        keys.push(key);
      }
      prevPageStyleKeysRef.current = keys;
    } else {
      prevPageStyleKeysRef.current = [];
    }
  }, [activeShell, state.theme]);

  // In standalone inspector pages, the browser overscroll area comes from the
  // document canvas rather than the Inspector root. Match it to the active
  // conversation surface so dark-mode overscroll never flashes white. Embedded
  // inspectors stay scoped to their root and do not mutate the host document.
  React.useLayoutEffect(() => {
    if (isEmbedded) return;

    const html = document.documentElement;
    const body = document.body;
    const previous = {
      htmlBackground: html.style.backgroundColor,
      bodyBackground: body.style.backgroundColor,
      htmlColorScheme: html.style.colorScheme,
    };
    const background = resolveLightDarkValue(
      activeShell?.pageStyles?.['--sim-bg-conversation'] ??
        activeShell?.styleVariables?.['--color-background-primary'] ??
        (state.theme === 'dark' ? '#212121' : '#ffffff'),
      state.theme
    );

    html.style.colorScheme = state.theme;
    html.style.backgroundColor = background;
    body.style.backgroundColor = background;

    return () => {
      html.style.backgroundColor = previous.htmlBackground;
      body.style.backgroundColor = previous.bodyBackground;
      html.style.colorScheme = previous.htmlColorScheme;
    };
  }, [activeShell, isEmbedded, state.theme]);

  // Inject host font CSS (@font-face rules) so the conversation chrome uses
  // the same font as the real host (e.g., Anthropic Sans for Claude).
  // @font-face rules can't be scoped to a subtree, so this is the one
  // document-level injection the Inspector makes. The font itself is only
  // referenced by host shells inside the Inspector subtree, so the host page
  // sees a defined-but-unused @font-face — harmless.
  React.useLayoutEffect(() => {
    const fontCss = activeShell?.fontCss;
    const id = 'sunpeak-host-fonts';
    const existing = document.getElementById(id);
    if (!fontCss) {
      existing?.remove();
      return;
    }
    if (existing) {
      existing.textContent = fontCss;
    } else {
      const style = document.createElement('style');
      style.id = id;
      style.textContent = fontCss;
      document.head.appendChild(style);
    }
  }, [activeShell]);

  // Handle callServerTool from the iframe.
  // When a simulation is active: prefer serverTools mocks, fall back to MCP.
  // When "None": always use MCP (real handlers).
  // Uses simulations[activeSimulationName] directly rather than state.selectedSim,
  // which lags one render behind due to the useEffect sync.
  const handleCallTool = React.useCallback(
    (params: {
      name: string;
      arguments?: Record<string, unknown>;
    }): CallToolResult | Promise<CallToolResult> => {
      if (isLiveMcpRender && onCallToolLive) {
        return onCallToolLive(params);
      }
      if (activeSimulationName) {
        const activeSim = simulations[activeSimulationName];
        const mock = activeSim?.serverTools?.[params.name];
        if (mock) {
          const result = resolveServerToolResult(mock, params.arguments);
          if (result) return result;
        }
      }
      if (onCallTool) {
        const result = onCallTool(params);
        return Promise.resolve(result).then((resolved) => {
          const meta = (resolved as Record<string, unknown>)?._meta as
            Record<string, unknown> | undefined;
          const sunpeakMeta = meta?._sunpeak as Record<string, unknown> | undefined;
          if (sunpeakMeta?.oauthRequired === true) {
            handleOAuthRequired(sunpeakMeta);
          }
          return resolved;
        });
      }
      return {
        content: [
          {
            type: 'text',
            text: `[Inspector] Tool "${params.name}" called — no serverTools mock found in simulation "${effectiveSimulationName}".`,
          },
        ],
      };
    },
    [
      onCallTool,
      onCallToolLive,
      isLiveMcpRender,
      activeSimulationName,
      simulations,
      effectiveSimulationName,
      handleOAuthRequired,
    ]
  );

  // Derive user message for the conversation shell
  const userMessage = currentSim
    ? (currentSim.userMessage ??
      `Call my ${(currentSim.tool.title as string | undefined) || currentSim.tool.name} tool`)
    : undefined;

  // ── Prod resources ──
  const prodResourcesPath = React.useMemo(() => {
    if (!prodResources || !state.selectedSim?.resource) return undefined;
    const name = state.selectedSim.resource.name as string;
    return `/dist/${name}/${name}.html`;
  }, [prodResources, state.selectedSim?.resource]);

  const [prodResourcesReady, setProdResourcesReady] = React.useState(false);
  const [prodResourcesGeneration, setProdResourcesGeneration] = React.useState(0);
  const prodResourcesWasReady = React.useRef(false);
  React.useEffect(() => {
    if (!prodResourcesPath) {
      setProdResourcesReady(false);
      prodResourcesWasReady.current = false;
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const check = async () => {
      let ok = false;
      try {
        const res = await fetch(prodResourcesPath, { method: 'HEAD' });
        ok = res.ok;
      } catch {
        // network error → not ready
      }
      if (cancelled) return;
      if (ok) {
        if (!prodResourcesWasReady.current) {
          setProdResourcesGeneration((g) => g + 1);
        }
        prodResourcesWasReady.current = true;
        setProdResourcesReady(true);
      } else {
        prodResourcesWasReady.current = false;
        setProdResourcesReady(false);
      }
      timer = setTimeout(check, 1000);
    };

    check();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [prodResourcesPath]);

  const baseResourceUrl =
    (prodResourcesPath && prodResourcesReady ? prodResourcesPath : undefined) ?? state.resourceUrl;
  // Append devOverlay=false to the resource URL so the server can strip the overlay script
  const effectiveResourceUrl =
    baseResourceUrl && !showDevOverlay
      ? `${baseResourceUrl}${baseResourceUrl.includes('?') ? '&' : '?'}devOverlay=false`
      : baseResourceUrl;
  const prodResourcesLoading = !!prodResourcesPath && !prodResourcesReady;

  // ── Content rendering ──
  const hasTools = toolNames.length > 0;
  const hasMockData = activeSimulationName !== null && currentSim?.toolResult != null;
  const showEmptyState = !hasMockData && !hasRun;
  let content: React.ReactNode;
  const iframeBg = 'var(--sim-bg-conversation, var(--color-background-primary, transparent))';

  if (!hasTools) {
    const isConnected = connection.status === 'connected';
    const isError = connection.status === 'error';
    content = (
      <div
        className="h-full w-full flex items-center justify-center"
        style={{ background: iframeBg }}
      >
        <span
          className="text-sm text-center max-w-xs"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {isEmbedded
            ? 'No tools in this app'
            : isError
              ? 'Could not connect to MCP server'
              : isConnected
                ? 'No tools found on this server'
                : serverUrl
                  ? 'Connecting\u2026'
                  : 'Enter an MCP server URL to get started'}
        </span>
      </div>
    );
  } else if (!selectedToolInfo?.resource) {
    content = (
      <div
        className="h-full w-full flex items-center justify-center"
        style={{ background: iframeBg }}
      >
        <span
          className="text-sm text-center max-w-xs"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          Tool does not render a UI
        </span>
      </div>
    );
  } else if (showEmptyState) {
    content = (
      <div
        className="h-full w-full flex items-center justify-center"
        style={{ background: iframeBg }}
      >
        <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Press <strong>Run</strong> to call the tool
        </span>
      </div>
    );
  } else if (prodResourcesLoading) {
    content = (
      <div
        className="h-full w-full flex items-center justify-center"
        style={{ background: iframeBg }}
      >
        <span className="text-sm" style={{ color: 'var(--color-text-secondary)' }}>
          Building&hellip;
        </span>
      </div>
    );
  } else if (state.resourceHtml) {
    // Embedded path — caller supplied the resource HTML directly (e.g. from
    // `mcpClient.readResource(...)`). The Inspector forwards it to the
    // sandbox iframe via PostMessage; no URL hosting required.
    content = (
      <div className="h-full w-full" style={{ background: iframeBg }}>
        <IframeResource
          key={`${state.activeHost}-${state.selectedSimulationName}-html`}
          html={state.resourceHtml}
          hostContext={hostContext}
          toolInput={state.toolInput}
          toolResult={state.effectiveToolResult}
          hostOptions={{
            hostInfo: activeShell?.hostInfo,
            hostCapabilities: activeShell?.hostCapabilities,
            onDisplayModeChange: state.handleDisplayModeChange,
            onUpdateModelContext: state.handleUpdateModelContext,
            onCallTool: handleCallTool,
          }}
          permissions={state.permissions}
          prefersBorder={state.prefersBorder}
          onDisplayModeReady={state.handleDisplayModeReady}
          debugInjectState={state.modelContext}
          injectOpenAIRuntime={state.activeHost === 'chatgpt'}
          sandboxUrl={sandboxUrl}
          className="h-full w-full"
        />
      </div>
    );
  } else if (effectiveResourceUrl) {
    content = (
      <div className="h-full w-full" style={{ background: iframeBg }}>
        <IframeResource
          key={`${state.activeHost}-${state.selectedSimulationName}-${effectiveResourceUrl}-${prodResources}-${prodResourcesGeneration}-${serverPreviewGeneration}`}
          src={effectiveResourceUrl}
          hostContext={hostContext}
          toolInput={state.toolInput}
          toolResult={state.effectiveToolResult}
          hostOptions={{
            hostInfo: activeShell?.hostInfo,
            hostCapabilities: activeShell?.hostCapabilities,
            onDisplayModeChange: state.handleDisplayModeChange,
            onUpdateModelContext: state.handleUpdateModelContext,
            onCallTool: handleCallTool,
          }}
          permissions={state.permissions}
          prefersBorder={state.prefersBorder}
          onDisplayModeReady={state.handleDisplayModeReady}
          debugInjectState={state.modelContext}
          injectOpenAIRuntime={state.activeHost === 'chatgpt'}
          sandboxUrl={sandboxUrl}
          className="h-full w-full"
        />
      </div>
    );
  } else if (!prodResources && state.resourceScript) {
    content = (
      <div className="h-full w-full" style={{ background: iframeBg }}>
        <IframeResource
          key={`${state.activeHost}-${state.selectedSimulationName}-${state.resourceScript}`}
          scriptSrc={state.resourceScript}
          hostContext={hostContext}
          toolInput={state.toolInput}
          toolResult={state.effectiveToolResult}
          csp={state.csp}
          hostOptions={{
            hostInfo: activeShell?.hostInfo,
            hostCapabilities: activeShell?.hostCapabilities,
            onDisplayModeChange: state.handleDisplayModeChange,
            onUpdateModelContext: state.handleUpdateModelContext,
            onCallTool: handleCallTool,
          }}
          permissions={state.permissions}
          prefersBorder={state.prefersBorder}
          onDisplayModeReady={state.handleDisplayModeReady}
          debugInjectState={state.modelContext}
          injectOpenAIRuntime={state.activeHost === 'chatgpt'}
          sandboxUrl={sandboxUrl}
          className="h-full w-full"
        />
      </div>
    );
  } else {
    content = children;
  }

  // Theme is applied to rootRef directly via useLayoutEffect above. Override
  // ThemeProvider's default (which would set data-theme on documentElement)
  // with a no-op so the embed stays scoped to the Inspector's subtree. The
  // ThemeProvider default behavior is preserved for callers using it outside
  // the bundled Inspector.
  const applyTheme = React.useCallback((_theme: 'light' | 'dark') => {
    // intentionally empty — applied via rootRef useLayoutEffect above
  }, []);

  // ── Run button (shown in conversation header when no simulation is active) ──
  // Visible when "None (call server)" is selected OR when no fixtures exist for the tool.
  // Hidden in demo mode to prevent sending real MCP requests from embedded contexts.
  const runButton =
    !demoMode && onCallTool && currentSim && activeSimulationName === null ? (
      <button
        type="button"
        onClick={handleRun}
        disabled={isRunning}
        className="rounded-full px-3 py-1 text-sm font-medium transition-opacity disabled:opacity-40 flex items-center gap-1.5 cursor-pointer"
        style={{
          backgroundColor: 'var(--color-text-primary)',
          color: 'var(--color-background-primary)',
        }}
      >
        {showCheck ? (
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M2 6L5 9L10 3" />
          </svg>
        ) : (
          <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor">
            <path d="M0 0L10 6L0 12V0Z" />
          </svg>
        )}
        Run
      </button>
    ) : undefined;

  const headerAction = runButton ? (
    <div className="flex min-w-0 items-center">{runButton}</div>
  ) : undefined;

  const conversationContent = ShellConversation ? (
    <ShellConversation
      screenWidth={state.screenWidth}
      displayMode={state.displayMode}
      platform={state.platform}
      onRequestDisplayMode={state.handleDisplayModeChange}
      appName={appName}
      appIcon={appIcon}
      userMessage={userMessage}
      chatMessages={canUseModelChat ? chatMessages : undefined}
      chatInput={canUseModelChat ? chatInput : undefined}
      onChatInputChange={canUseModelChat ? setChatInput : undefined}
      onChatSubmit={canUseModelChat ? handleChatSubmit : undefined}
      chatDisabled={
        isChatting ||
        isKeyStatusLoading ||
        (requiresModelApiKey && !keyStatus.hasKey) ||
        !modelId.trim()
      }
      chatPlaceholder={
        canUseModelChat
          ? isKeyStatusLoading
            ? `Checking ${modelProvider} key...`
            : !requiresModelApiKey || keyStatus.hasKey
              ? `Message ${modelId}`
              : `Add an API key to chat with ${modelId}`
          : undefined
      }
      chatStatus={canUseModelChat ? chatStatus : undefined}
      hideChatComposer={isEmbedded && !canUseModelChat}
      onContentWidthChange={state.handleContentWidthChange}
      headerAction={headerAction}
    >
      {content}
    </ShellConversation>
  ) : (
    content
  );

  // Embedded mode: fill the parent container instead of the viewport so the
  // host React app can place the Inspector inside a sized region (a sidebar,
  // a modal, a dashboard panel) without it escaping its container.
  const rootSizing = isEmbedded ? 'h-full w-full' : 'h-screen w-screen';
  const getJsonPanelFlexGrow = (value: string) => {
    const text = value || '';
    const lineCount = text.split('\n').length;
    return Math.max(1, Math.min(8, lineCount + Math.floor(text.length / 500)));
  };

  if (!showSidebar) {
    return (
      <ThemeProvider theme={state.theme} applyTheme={applyTheme}>
        <div ref={rootRef} className={`sunpeak-inspector-root flex ${rootSizing}`}>
          {conversationContent}
        </div>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={state.theme} applyTheme={applyTheme}>
      <SimpleSidebar
        rootRef={rootRef}
        fillParent={isEmbedded}
        sidebarWidth={state.sidebarWidth}
        rightSidebarWidth={state.rightSidebarWidth}
        onSidebarWidthChange={state.setSidebarWidth}
        onRightSidebarWidthChange={state.setRightSidebarWidth}
        controls={
          <div className="space-y-1">
            {/*
             * MCP Server URL + Authentication only appear in the CLI codepath.
             * When `app` is provided (embedded mode), connection and auth are
             * owned by the embedding application's MCP client.
             */}
            {!isEmbedded && (
              <>
                <SidebarControl
                  label={
                    <span className="flex items-center gap-1.5">
                      MCP Server
                      {serverUrl && !demoMode && (
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          data-testid="connection-status"
                          style={{
                            backgroundColor:
                              connection.status === 'connected'
                                ? '#22c55e'
                                : connection.status === 'connecting'
                                  ? '#eab308'
                                  : connection.status === 'error'
                                    ? '#ef4444'
                                    : '#6b7280',
                          }}
                          title={connection.error ?? connection.status}
                        />
                      )}
                    </span>
                  }
                  tooltip="MCP server URL"
                  data-testid="server-url"
                >
                  <SidebarInput
                    value={demoMode ? 'http://localhost:8000/mcp' : serverUrl}
                    onChange={demoMode ? () => {} : setServerUrl}
                    applyOnBlur
                    placeholder="http://localhost:8000/mcp"
                    disabled={demoMode}
                  />
                </SidebarControl>

                {/* ── Authentication (hidden in demo mode) ── */}
                {!demoMode && (
                  <SidebarCollapsibleControl
                    label={
                      <span className="flex items-center gap-1.5">
                        <span>Authentication</span>
                        <span
                          className="rounded px-1 py-0.5 text-[8px] font-normal leading-none"
                          style={{
                            backgroundColor: 'var(--color-background-secondary)',
                            color:
                              oauthStatus === 'error'
                                ? 'var(--color-text-danger, #dc2626)'
                                : oauthStatus === 'authorized'
                                  ? '#22c55e'
                                  : 'var(--color-text-secondary)',
                          }}
                        >
                          {authType === 'none'
                            ? 'None'
                            : authType === 'bearer'
                              ? 'Bearer'
                              : oauthStatus === 'authorized'
                                ? 'OAuth · Authorized'
                                : oauthStatus === 'authorizing'
                                  ? 'OAuth · Authorizing'
                                  : oauthStatus === 'error'
                                    ? 'OAuth · Error'
                                    : 'OAuth'}
                        </span>
                      </span>
                    }
                    expanded={isAuthenticationExpanded}
                    onExpandedChange={setIsAuthenticationExpanded}
                  >
                    <div className="space-y-1">
                      <SidebarSelect
                        value={authType}
                        onChange={(value) => {
                          const newType = value as AuthType;
                          setAuthType(newType);
                          setOauthStatus('none');
                          setOauthError(undefined);
                          // Reconnect without auth when switching to "none"
                          if (newType === 'none' && serverUrl) {
                            connection.reconnect(serverUrl);
                          }
                        }}
                        options={[
                          { value: 'none', label: 'None' },
                          { value: 'bearer', label: 'Bearer Token' },
                          { value: 'oauth', label: 'OAuth' },
                        ]}
                      />

                      {authType === 'bearer' && (
                        <SidebarInput
                          type="password"
                          value={bearerToken}
                          onChange={(value) => {
                            setBearerToken(value);
                            // Reconnect with the new token when applied
                            if (serverUrl && value) {
                              connection.reconnect(serverUrl, {
                                type: 'bearer',
                                bearerToken: value,
                              });
                            }
                          }}
                          applyOnBlur
                          placeholder="Paste your token"
                        />
                      )}

                      {authType === 'oauth' && (
                        <div className="space-y-1">
                          <SidebarCollapsibleControl label="OAuth settings">
                            <div className="space-y-1">
                              <SidebarInput
                                value={oauthClientId}
                                onChange={setOauthClientId}
                                applyOnBlur
                                placeholder="Client ID (optional)"
                              />
                              {!oauthClientId && (
                                <SidebarInput
                                  value={oauthClientMetadataUrl}
                                  onChange={setOauthClientMetadataUrl}
                                  applyOnBlur
                                  placeholder="Client metadata URL (optional)"
                                />
                              )}
                              {oauthClientId && (
                                <>
                                  <SidebarInput
                                    type="password"
                                    value={oauthClientSecret}
                                    onChange={setOauthClientSecret}
                                    applyOnBlur
                                    placeholder="Client Secret (optional)"
                                  />
                                  <SidebarSelect
                                    value={oauthTokenEndpointAuthMethod}
                                    onChange={setOauthTokenEndpointAuthMethod}
                                    options={[
                                      { value: 'auto', label: 'Client auth: Auto' },
                                      {
                                        value: 'client_secret_basic',
                                        label: 'Client auth: HTTP Basic',
                                      },
                                      {
                                        value: 'client_secret_post',
                                        label: 'Client auth: Request body',
                                      },
                                      { value: 'none', label: 'Client auth: None' },
                                    ]}
                                  />
                                </>
                              )}
                              <SidebarInput
                                value={oauthScopes}
                                onChange={setOauthScopes}
                                applyOnBlur
                                placeholder="Scopes (optional)"
                              />
                            </div>
                          </SidebarCollapsibleControl>
                          {oauthAuthorizationServers.length > 1 && (
                            <SidebarSelect
                              value={oauthAuthorizationServer}
                              onChange={setOauthAuthorizationServer}
                              options={oauthAuthorizationServers.map((issuer) => ({
                                value: issuer,
                                label: issuer,
                              }))}
                            />
                          )}
                          <button
                            type="button"
                            onClick={handleStartOAuth}
                            disabled={!serverUrl || oauthStatus === 'authorizing'}
                            className="w-full h-7 text-xs rounded-md px-2 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            style={{
                              backgroundColor:
                                oauthStatus === 'authorized'
                                  ? '#22c55e'
                                  : 'var(--color-text-primary)',
                              color: 'var(--color-background-primary)',
                            }}
                          >
                            {oauthStatus === 'authorizing'
                              ? 'Authorizing\u2026'
                              : oauthStatus === 'authorized'
                                ? 'Authorized'
                                : 'Authorize'}
                          </button>
                          {(oauthStatus === 'authorized' ||
                            oauthAuthorizationServers.length > 0) && (
                            <button
                              type="button"
                              onClick={handleClearOAuth}
                              className="w-full h-7 text-xs rounded-md px-2 transition-colors cursor-pointer"
                              style={{
                                border: '1px solid var(--color-border-primary)',
                                color: 'var(--color-text-secondary)',
                              }}
                            >
                              Clear local authorization
                            </button>
                          )}
                          {oauthError && (
                            <div
                              className="text-[9px]"
                              style={{ color: 'var(--color-text-danger, #dc2626)' }}
                            >
                              {oauthError}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </SidebarCollapsibleControl>
                )}
              </>
            )}

            {/* ── Tool + Simulation row ── */}
            {hasTools && (
              <div className="grid grid-cols-2 gap-2" data-testid="tool-simulation-row">
                <SidebarControl
                  label="Tool"
                  tooltip="Tool to inspect"
                  docsPath="app-framework/cli/dev"
                  data-testid="tool-selector"
                >
                  <SidebarSelect
                    value={selectedToolName}
                    onChange={(value) => {
                      setIsLiveMcpRender(false);
                      resetAppContextForSelectionChange();
                      setSelectedToolName(value);
                    }}
                    options={toolNames.map((name) => {
                      const info = toolMap.get(name)!;
                      return {
                        value: name,
                        label: (info.tool.title as string | undefined) || name,
                      };
                    })}
                  />
                </SidebarControl>
                <SidebarControl
                  label={
                    selectedToolInfo && selectedToolInfo.fixtureSimNames.length > 0 ? (
                      'Simulation'
                    ) : (
                      <a
                        href={`${DOCS_BASE_URL}/testing/simulations`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="no-underline transition-colors"
                        style={{ color: 'var(--color-text-secondary)' }}
                        onMouseEnter={(e) => {
                          (e.target as HTMLElement).style.color = 'var(--color-text-primary)';
                        }}
                        onMouseLeave={(e) => {
                          (e.target as HTMLElement).style.color = 'var(--color-text-secondary)';
                        }}
                      >
                        Simulation
                      </a>
                    )
                  }
                  tooltip={
                    selectedToolInfo && selectedToolInfo.fixtureSimNames.length > 0
                      ? 'Test fixture with mock data'
                      : 'Create simulations for faster testing'
                  }
                  docsPath="testing/simulations"
                  data-testid="simulation-selector"
                >
                  <SidebarSelect
                    value={isLiveMcpRender ? '__live__' : (activeSimulationName ?? '__none__')}
                    onChange={(value) => {
                      if (value === '__live__') return;
                      setIsLiveMcpRender(false);
                      resetAppContextForSelectionChange();
                      setActiveSimulationName(value === '__none__' ? null : value);
                    }}
                    options={[
                      ...(isLiveMcpRender
                        ? [
                            {
                              value: '__live__',
                              label: 'Live MCP (model)',
                            },
                          ]
                        : []),
                      ...(demoMode
                        ? []
                        : [
                            {
                              value: '__none__',
                              label:
                                selectedToolInfo && selectedToolInfo.fixtureSimNames.length > 0
                                  ? 'None (call server)'
                                  : 'None',
                            },
                          ]),
                      ...(selectedToolInfo?.fixtureSimNames ?? []).map((simName) => ({
                        value: simName,
                        // Prefer the user-facing displayName (set by the
                        // `app` prop's flattener) over the internal key.
                        label: simulations[simName]?.displayName ?? simName,
                      })),
                    ]}
                  />
                </SidebarControl>
              </div>
            )}

            {/* ── Host + Width row ── */}
            <div className="grid grid-cols-2 gap-2">
              {registeredHosts.length > 1 && (
                <SidebarControl
                  label="Host"
                  tooltip="Host runtime to simulate"
                  docsPath="app-framework/functions/host-detection"
                >
                  <SidebarSelect
                    value={state.activeHost}
                    onChange={(value) => state.setActiveHost(value as HostId)}
                    options={registeredHosts.map((h) => ({
                      value: h.id,
                      label: h.label,
                    }))}
                  />
                </SidebarControl>
              )}
              <SidebarControl label="Width" tooltip="Chat width" docsPath="testing/inspector">
                <SidebarSelect
                  value={state.screenWidth}
                  onChange={(value) => state.setScreenWidth(value as ScreenWidth)}
                  options={[
                    { value: 'mobile-s', label: 'Mobile S (375px)' },
                    { value: 'mobile-m', label: 'Mobile M (393px)' },
                    { value: 'mobile-l', label: 'Mobile L (425px)' },
                    { value: 'mobile-xl', label: 'Mobile XL (430px)' },
                    { value: 'tablet', label: 'Tablet (768px)' },
                    { value: 'tablet-l', label: 'Tablet L (820px)' },
                    { value: 'full', label: '100% (Full)' },
                  ]}
                />
              </SidebarControl>
            </div>

            {!hideInspectorModes && !demoMode && !isEmbedded && (
              <div className="py-1">
                <SidebarCheckbox
                  checked={prodResources}
                  onChange={setProdResources}
                  label="Prod Resources"
                  tooltip="Load resources from dist/ builds instead of HMR"
                  docsPath="app-framework/cli/dev#prod-tools-and-prod-resources-flags"
                />
              </div>
            )}

            {canUseModelChat && (
              <SidebarCollapsibleControl
                label="Model Chat"
                defaultCollapsed={false}
                tooltip="Talk to this MCP server through a model"
                docsPath="testing/evals"
              >
                <div className="space-y-1">
                  <div className="grid grid-cols-[0.7fr_minmax(0,1fr)_1.75rem] items-end gap-2">
                    <SidebarControl label="Provider">
                      <SidebarSelect
                        value={modelProvider}
                        onChange={handleModelProviderChange}
                        options={modelProviderOptions.map((provider) => ({
                          value: provider.id,
                          label: provider.label ?? provider.id,
                        }))}
                      />
                    </SidebarControl>
                    <SidebarControl label="Model">
                      {selectedProviderModelOptions.length > 0 ? (
                        <SidebarSelect
                          value={modelId}
                          onChange={setModelId}
                          options={selectedProviderModelOptions.map((model) => ({
                            value: model,
                            label: model,
                          }))}
                        />
                      ) : (
                        <SidebarInput
                          value={modelId}
                          onChange={setModelId}
                          applyOnBlur
                          placeholder={getDefaultModelId(modelProvider)}
                        />
                      )}
                    </SidebarControl>
                    <div className="group relative flex h-7 items-center self-end">
                      <button
                        type="button"
                        onClick={handleResetModelConversation}
                        disabled={chatMessages.length === 0 && !isChatting && !chatStatus}
                        aria-label="Reset model conversation"
                        aria-describedby="reset-model-conversation-tooltip"
                        title="Reset conversation"
                        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                        style={{
                          backgroundColor: 'var(--color-background-primary)',
                          color: 'var(--color-text-primary)',
                        }}
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h8V3z" />
                        </svg>
                      </button>
                      <span
                        id="reset-model-conversation-tooltip"
                        role="tooltip"
                        className="pointer-events-none absolute right-0 top-full z-[1000] mt-1 hidden whitespace-nowrap rounded px-2 py-1 text-[11px] font-normal leading-tight group-focus-within:block group-hover:block"
                        style={{
                          backgroundColor: 'var(--color-text-primary)',
                          color: 'var(--color-background-primary)',
                        }}
                      >
                        Reset conversation
                      </span>
                    </div>
                  </div>
                  {usesApiKeyUi && (
                    <SidebarControl label="API Key">
                      <div className="flex gap-1">
                        <SidebarInput
                          type="password"
                          autoComplete="new-password"
                          value={apiKeyDraft}
                          onChange={setApiKeyDraft}
                          placeholder={
                            keyStatus.hasKey ? 'Saved locally' : `Paste ${modelProvider} key`
                          }
                        />
                        <button
                          type="button"
                          onClick={handleSaveApiKey}
                          disabled={isKeyStatusLoading || (!apiKeyDraft && !keyStatus.hasKey)}
                          className="h-7 rounded-md px-2 text-xs font-medium transition-opacity disabled:opacity-40"
                          style={{
                            backgroundColor: 'var(--color-text-primary)',
                            color: 'var(--color-background-primary)',
                          }}
                        >
                          {apiKeyDraft ? 'Save' : 'Clear'}
                        </button>
                      </div>
                      <div
                        className="mt-1 text-[9px]"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        {keyMessage ||
                          (isKeyStatusLoading
                            ? 'Checking saved key...'
                            : keyStatus.hasKey
                              ? `Key saved ${keyStatus.storage ?? 'locally'}`
                              : 'Paste a key or use one already saved on this machine')}
                      </div>
                    </SidebarControl>
                  )}
                </div>
              </SidebarCollapsibleControl>
            )}

            <SidebarCollapsibleControl
              label="Host Context"
              defaultCollapsed={false}
              tooltip="Host-provided environment"
              docsPath="app-framework/hooks/use-host-context"
            >
              <div className="space-y-1">
                <div className="grid grid-cols-[2fr_1fr] gap-2">
                  <SidebarControl
                    label="Theme"
                    tooltip="Host color theme"
                    docsPath="app-framework/hooks/use-theme"
                  >
                    <SidebarToggle
                      value={state.theme}
                      onChange={(value) => state.setTheme(value as McpUiTheme)}
                      options={[
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                      ]}
                    />
                  </SidebarControl>

                  <SidebarControl
                    label="Locale"
                    tooltip="BCP 47 language tag"
                    docsPath="app-framework/hooks/use-locale"
                  >
                    <SidebarInput
                      applyOnBlur
                      value={state.locale}
                      onChange={(value) => state.setLocale(value)}
                      placeholder="en-US"
                    />
                  </SidebarControl>
                </div>

                <SidebarControl
                  label="Display Mode"
                  tooltip="Host resource rendering paradigm"
                  docsPath="app-framework/hooks/use-display-mode"
                >
                  <SidebarToggle
                    value={state.displayMode}
                    onChange={(value) => state.setDisplayMode(value as McpUiDisplayMode)}
                    options={[
                      { value: 'inline', label: 'Inline' },
                      { value: 'pip', label: 'PiP' },
                      { value: 'fullscreen', label: 'Full' },
                    ].filter(
                      (opt) =>
                        !activeShell?.availableDisplayModes ||
                        activeShell.availableDisplayModes.includes(opt.value as McpUiDisplayMode)
                    )}
                  />
                </SidebarControl>

                <SidebarControl
                  label="Device"
                  tooltip="Apply a mobile fullscreen host-context preset"
                  docsPath="testing/inspector"
                >
                  <SidebarSelect
                    value={state.devicePreset}
                    onChange={(value) => state.applyDevicePreset(value as DevicePresetSelection)}
                    options={[
                      { value: 'custom', label: 'Custom' },
                      ...DEVICE_PRESETS.map((preset) => ({
                        value: preset.id,
                        label: `${preset.label} (${preset.containerWidth} x ${preset.containerHeight})`,
                      })),
                    ]}
                  />
                </SidebarControl>

                <div className="grid grid-cols-7 gap-2">
                  <div className="col-span-3">
                    <SidebarControl
                      label="Platform"
                      tooltip="End user device platform"
                      docsPath="app-framework/hooks/use-platform"
                    >
                      <SidebarSelect
                        value={state.platform}
                        onChange={(value) => {
                          const p = value as Platform;
                          state.setPlatform(p);
                          if (p === 'mobile') {
                            state.setHover(false);
                            state.setTouch(true);
                          } else if (p === 'desktop') {
                            state.setHover(true);
                            state.setTouch(false);
                          } else {
                            state.setHover(true);
                            state.setTouch(false);
                          }
                        }}
                        options={[
                          { value: 'mobile', label: 'Mobile' },
                          { value: 'desktop', label: 'Desktop' },
                          { value: 'web', label: 'Web' },
                        ]}
                      />
                    </SidebarControl>
                  </div>

                  <div className="col-span-4">
                    <SidebarControl
                      label="Capabilities"
                      tooltip="End user device capabilities"
                      docsPath="app-framework/hooks/use-device-capabilities"
                    >
                      <div className="flex gap-2">
                        <SidebarCheckbox
                          checked={state.hover}
                          onChange={state.setHover}
                          label="Hover"
                        />
                        <SidebarCheckbox
                          checked={state.touch}
                          onChange={state.setTouch}
                          label="Touch"
                        />
                      </div>
                    </SidebarControl>
                  </div>
                </div>

                <SidebarControl
                  label="Time Zone"
                  tooltip="End user IANA time zone"
                  docsPath="app-framework/hooks/use-time-zone"
                >
                  <SidebarInput
                    applyOnBlur
                    value={state.timeZone}
                    onChange={(value) => state.setTimeZone(value)}
                    placeholder="e.g. America/New_York"
                  />
                </SidebarControl>

                <SidebarControl
                  label="Container Dimensions"
                  tooltip="Host-enforced size constraints (px)"
                  docsPath="app-framework/hooks/use-viewport"
                >
                  <div className="grid grid-cols-4 gap-1">
                    <SidebarControl label="Height">
                      <SidebarInput
                        type="number"
                        applyOnBlur
                        placeholder="-"
                        value={state.containerHeight != null ? String(state.containerHeight) : ''}
                        onChange={(value) =>
                          state.setContainerHeight(value ? Number(value) : undefined)
                        }
                      />
                    </SidebarControl>
                    <SidebarControl label="Width">
                      <SidebarInput
                        type="number"
                        applyOnBlur
                        placeholder="-"
                        value={state.containerWidth != null ? String(state.containerWidth) : ''}
                        onChange={(value) =>
                          state.setContainerWidth(value ? Number(value) : undefined)
                        }
                      />
                    </SidebarControl>
                    <SidebarControl label="Max H">
                      <SidebarInput
                        type="number"
                        applyOnBlur
                        placeholder="-"
                        value={
                          state.containerMaxHeight != null ? String(state.containerMaxHeight) : ''
                        }
                        onChange={(value) =>
                          state.setContainerMaxHeight(value ? Number(value) : undefined)
                        }
                      />
                    </SidebarControl>
                    <SidebarControl label="Max W">
                      <SidebarInput
                        type="number"
                        applyOnBlur
                        placeholder={
                          state.measuredContentWidth != null
                            ? String(state.measuredContentWidth)
                            : '-'
                        }
                        value={
                          state.containerMaxWidth != null ? String(state.containerMaxWidth) : ''
                        }
                        onChange={(value) =>
                          state.setContainerMaxWidth(value ? Number(value) : undefined)
                        }
                      />
                    </SidebarControl>
                  </div>
                </SidebarControl>

                <SidebarControl
                  label="Safe Area Insets"
                  tooltip="Device safe area padding (px)"
                  docsPath="app-framework/hooks/use-safe-area"
                >
                  <div className="grid grid-cols-4 gap-1">
                    <div className="flex items-center gap-0.5">
                      <span
                        className="text-[10px]"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        &uarr;
                      </span>
                      <SidebarInput
                        type="number"
                        applyOnBlur
                        placeholder="-"
                        value={state.safeAreaInsets.top ? String(state.safeAreaInsets.top) : ''}
                        onChange={(value) =>
                          state.setSafeAreaInsets((prev) => ({ ...prev, top: Number(value) || 0 }))
                        }
                      />
                    </div>
                    <div className="flex items-center gap-0.5">
                      <span
                        className="text-[10px]"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        &darr;
                      </span>
                      <SidebarInput
                        type="number"
                        applyOnBlur
                        placeholder="-"
                        value={
                          state.safeAreaInsets.bottom ? String(state.safeAreaInsets.bottom) : ''
                        }
                        onChange={(value) =>
                          state.setSafeAreaInsets((prev) => ({
                            ...prev,
                            bottom: Number(value) || 0,
                          }))
                        }
                      />
                    </div>
                    <div className="flex items-center gap-0.5">
                      <span
                        className="text-[10px]"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        &larr;
                      </span>
                      <SidebarInput
                        type="number"
                        applyOnBlur
                        placeholder="-"
                        value={state.safeAreaInsets.left ? String(state.safeAreaInsets.left) : ''}
                        onChange={(value) =>
                          state.setSafeAreaInsets((prev) => ({ ...prev, left: Number(value) || 0 }))
                        }
                      />
                    </div>
                    <div className="flex items-center gap-0.5">
                      <span
                        className="text-[10px]"
                        style={{ color: 'var(--color-text-secondary)' }}
                      >
                        &rarr;
                      </span>
                      <SidebarInput
                        type="number"
                        applyOnBlur
                        placeholder="-"
                        value={state.safeAreaInsets.right ? String(state.safeAreaInsets.right) : ''}
                        onChange={(value) =>
                          state.setSafeAreaInsets((prev) => ({
                            ...prev,
                            right: Number(value) || 0,
                          }))
                        }
                      />
                    </div>
                  </div>
                </SidebarControl>
              </div>
            </SidebarCollapsibleControl>
          </div>
        }
        rightControls={
          <div className="flex h-full min-h-0 flex-col gap-3">
            <SidebarCollapsibleControl
              label="App Context"
              defaultCollapsed={false}
              tooltip="App-provided context shared with the model"
              docsPath="app-framework/hooks/use-app-state"
              className="flex min-h-0 flex-col"
              contentClassName="min-h-0 flex-1"
              style={{ flex: `${getJsonPanelFlexGrow(state.modelContextJson)} 1 0` }}
              tooltipPlacement="left"
            >
              <SidebarTextarea
                value={state.modelContextJson}
                data-testid="app-context-textarea"
                onChange={(json) =>
                  state.validateJSON(json, state.setModelContextJson, state.setModelContextError)
                }
                onFocus={() => state.setEditingField('modelContext')}
                onBlur={() =>
                  state.commitJSON(state.modelContextJson, state.setModelContextError, (parsed) => {
                    state.setModelContext(
                      parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
                        ? (parsed as Record<string, unknown>)
                        : null
                    );
                    state.setModelAppContext(
                      parsed == null ? null : { content: [], structuredContent: parsed }
                    );
                  })
                }
                error={state.modelContextError}
                fill
              />
            </SidebarCollapsibleControl>

            <SidebarCollapsibleControl
              label="Tool Input (JSON)"
              defaultCollapsed={false}
              tooltip="Arguments passed to the tool"
              docsPath="app-framework/hooks/use-tool-data"
              className="flex min-h-0 flex-col"
              contentClassName="min-h-0 flex-1"
              style={{ flex: `${getJsonPanelFlexGrow(state.toolInputJson)} 1 0` }}
              tooltipPlacement="left"
            >
              <SidebarTextarea
                value={state.toolInputJson}
                data-testid="tool-input-textarea"
                onChange={(json) =>
                  state.validateJSON(json, state.setToolInputJson, state.setToolInputError)
                }
                onFocus={() => state.setEditingField('toolInput')}
                onBlur={() =>
                  state.commitJSON(state.toolInputJson, state.setToolInputError, (parsed) =>
                    state.setToolInput((parsed as Record<string, unknown>) ?? {})
                  )
                }
                error={state.toolInputError}
                fill
              />
            </SidebarCollapsibleControl>

            <SidebarCollapsibleControl
              label="Tool Result (JSON)"
              defaultCollapsed={false}
              tooltip="Structured content returned by the tool"
              docsPath="app-framework/hooks/use-tool-data"
              data-testid="tool-result-section"
              className="flex min-h-0 flex-col"
              contentClassName="min-h-0 flex-1"
              style={{ flex: `${getJsonPanelFlexGrow(state.toolResultJson)} 1 0` }}
              tooltipPlacement="left"
            >
              <SidebarTextarea
                value={state.toolResultJson}
                data-testid="tool-result-textarea"
                onChange={(json) =>
                  state.validateJSON(json, state.setToolResultJson, state.setToolResultError)
                }
                onFocus={() => state.setEditingField('toolResult')}
                onBlur={() =>
                  state.commitJSON(state.toolResultJson, state.setToolResultError, (parsed) => {
                    if (parsed === null) {
                      state.setToolResult(undefined);
                    } else {
                      const result = parsed as Record<string, unknown>;
                      if ('content' in result || 'structuredContent' in result) {
                        state.setToolResult(
                          result as import('@modelcontextprotocol/sdk/types.js').CallToolResult
                        );
                      } else {
                        state.setToolResult({ content: [], structuredContent: result });
                      }
                    }
                  })
                }
                error={state.toolResultError}
                fill
              />
            </SidebarCollapsibleControl>
          </div>
        }
      >
        {conversationContent}
      </SimpleSidebar>
      {/* Expose tool result as structured data for test fixtures to read.
          This is the authoritative source — test matchers read from here,
          not from sidebar textarea values. Includes `source` so tests can
          distinguish fixture data from real server responses. */}
      <script
        type="application/json"
        id="__tool-result"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(
            state.toolResult
              ? {
                  ...state.toolResult,
                  source: isLiveMcpRender
                    ? 'live-mcp'
                    : activeSimulationName
                      ? 'fixture'
                      : 'server',
                }
              : null
          ).replace(/</g, '\\u003c'),
        }}
      />
    </ThemeProvider>
  );
}
