import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  McpUiHostContext,
  McpUiDisplayMode,
  McpUiTheme,
  McpUiResourcePermissions,
} from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Simulation } from '../types/simulation';
import type { ScreenWidth } from './inspector-types';
import type { HostId } from './hosts';
import { getHostShell } from './hosts';
import { extractResourceCSP, type ResourceCSP } from './iframe-resource';
import {
  CUSTOM_DEVICE_PRESET,
  getDevicePreset,
  isDevicePresetSelection,
  type DevicePresetSelection,
} from './device-presets';

type Platform = NonNullable<McpUiHostContext['platform']>;
type SafeAreaInsets = Required<NonNullable<McpUiHostContext['safeAreaInsets']>>;

interface ModelAppContext {
  content?: unknown[];
  structuredContent?: unknown;
}

const DEFAULT_THEME: McpUiTheme = 'dark';
const DEFAULT_DISPLAY_MODE: McpUiDisplayMode = 'inline';
const DEFAULT_PLATFORM: Platform = 'desktop';
const DEFAULT_SIDEBAR_WIDTH = 260;
function normalizeSafeArea(insets?: Partial<SafeAreaInsets>): SafeAreaInsets {
  return {
    top: insets?.top ?? 0,
    right: insets?.right ?? 0,
    bottom: insets?.bottom ?? 0,
    left: insets?.left ?? 0,
  };
}

function deriveEffectiveSafeArea(
  deviceSafeArea: SafeAreaInsets,
  hostSafeArea: SafeAreaInsets,
  safeAreaOverride?: SafeAreaInsets
): SafeAreaInsets {
  if (safeAreaOverride) return safeAreaOverride;
  return {
    top: Math.max(deviceSafeArea.top, hostSafeArea.top),
    right: Math.max(deviceSafeArea.right, hostSafeArea.right),
    bottom: Math.max(deviceSafeArea.bottom, hostSafeArea.bottom),
    left: Math.max(deviceSafeArea.left, hostSafeArea.left),
  };
}

export interface UseInspectorStateOptions {
  simulations: Record<string, Simulation>;
  defaultHost?: HostId;
  preserveToolDataOnSimulationChange?: boolean;
}

export interface InspectorState {
  // ── Simulation selection ──
  simulationNames: string[];
  selectedSimulationName: string;
  setSelectedSimulationName: (name: string) => void;
  selectedSim: Simulation | undefined;

  // ── Host selection ──
  activeHost: HostId;
  setActiveHost: (host: HostId) => void;

  // ── Screen width ──
  screenWidth: ScreenWidth;
  setScreenWidth: (width: ScreenWidth) => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  rightSidebarWidth: number;
  setRightSidebarWidth: (width: number) => void;

  // ── Host context ──
  theme: McpUiTheme;
  setTheme: (theme: McpUiTheme) => void;
  displayMode: McpUiDisplayMode;
  setDisplayMode: (mode: McpUiDisplayMode) => void;
  devicePreset: DevicePresetSelection;
  applyDevicePreset: (preset: DevicePresetSelection) => void;
  locale: string;
  setLocale: (locale: string) => void;
  containerHeight: number | undefined;
  setContainerHeight: (height: number | undefined) => void;
  containerWidth: number | undefined;
  setContainerWidth: (width: number | undefined) => void;
  containerMaxHeight: number | undefined;
  setContainerMaxHeight: (height: number | undefined) => void;
  containerMaxWidth: number | undefined;
  setContainerMaxWidth: (width: number | undefined) => void;
  platform: Platform;
  setPlatform: (platform: Platform) => void;
  hover: boolean;
  setHover: (hover: boolean) => void;
  touch: boolean;
  setTouch: (touch: boolean) => void;
  /** Explicit URL/manual override. When absent, device and host insets are merged per edge. */
  safeAreaOverride: SafeAreaInsets | undefined;
  deviceSafeArea: SafeAreaInsets;
  hostSafeArea: SafeAreaInsets;
  effectiveSafeArea: SafeAreaInsets;
  /** Backward-compatible alias for effectiveSafeArea. */
  safeAreaInsets: SafeAreaInsets;
  setSafeAreaInsets: React.Dispatch<React.SetStateAction<SafeAreaInsets>>;
  timeZone: string;
  setTimeZone: (tz: string) => void;
  // ── Computed host context ──
  hostContext: McpUiHostContext;

  // ── Display mode ready callback (for IframeResource paint fence) ──
  handleDisplayModeReady: (mode: string) => void;

  // ── Tool data ──
  toolInput: Record<string, unknown>;
  setToolInput: (input: Record<string, unknown>) => void;
  toolResult: CallToolResult | undefined;
  setToolResult: (result: CallToolResult | undefined) => void;
  effectiveToolResult: CallToolResult | undefined;

  // ── Model context ──
  modelContext: Record<string, unknown> | null;
  setModelContext: (ctx: Record<string, unknown> | null) => void;
  modelAppContext: ModelAppContext | null;
  setModelAppContext: (ctx: ModelAppContext | null) => void;

  // ── JSON editing state (for sidebar) ──
  toolInputJson: string;
  setToolInputJson: (json: string) => void;
  toolInputError: string;
  setToolInputError: (error: string) => void;
  toolResultJson: string;
  setToolResultJson: (json: string) => void;
  toolResultError: string;
  setToolResultError: (error: string) => void;
  modelContextJson: string;
  setModelContextJson: (json: string) => void;
  modelContextError: string;
  setModelContextError: (error: string) => void;
  editingField: string | null;
  setEditingField: (field: string | null) => void;

  // ── JSON helpers ──
  validateJSON: (
    json: string,
    setJson: (value: string) => void,
    setError: (error: string) => void
  ) => void;
  commitJSON: (
    json: string,
    setError: (error: string) => void,
    updateFn: (value: Record<string, unknown> | null) => void
  ) => void;

  // ── Content width (from conversation ResizeObserver) ──
  measuredContentWidth: number | undefined;
  handleContentWidthChange: (width: number) => void;

  // ── Host callbacks ──
  handleDisplayModeChange: (mode: McpUiDisplayMode) => void;
  handleUpdateModelContext: (content: unknown[], structuredContent?: unknown) => void;

  // ── Content props (for IframeResource) ──
  resourceUrl: string | undefined;
  resourceScript: string | undefined;
  resourceHtml: string | undefined;
  csp: ResourceCSP | undefined;
  permissions: McpUiResourcePermissions | undefined;
  prefersBorder: boolean;
  // ── URL param overrides ──
  urlTool: string | undefined;
  urlProdResources: boolean | undefined;
  urlSidebar: boolean | undefined;
  urlDevOverlay: boolean | undefined;
}

/**
 * Parse URL params for initial inspector values.
 * Supported params:
 * - simulation: simulation name (e.g., 'show-albums')
 * - theme: 'light' | 'dark'
 * - displayMode: 'inline' | 'pip' | 'fullscreen'
 * - devicePreset: 'iphone-se' | 'iphone-15' | 'iphone-15-pro-max' | 'ipad' | 'custom'
 * - locale: e.g., 'en-US'
 * - maxHeight: number (containerDimensions.maxHeight)
 * - maxWidth: number (containerDimensions.maxWidth)
 * - deviceType: 'mobile' | 'tablet' | 'desktop' → maps to platform
 * - hover: 'true' | 'false'
 * - touch: 'true' | 'false'
 * - safeAreaTop, safeAreaBottom, safeAreaLeft, safeAreaRight: number
 * - host: 'chatgpt' | 'claude'
 * - tool: tool name (e.g., 'show-albums') — selects tool without mock data
 * - toolInput: JSON-encoded tool arguments (overrides simulation fixture data)
 * - autoRun: 'true' — call the tool on load when no fixture data exists (set by test fixtures)
 * - prodResources: 'true' | 'false'
 */
function parseUrlParams(): {
  simulation?: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  theme?: McpUiTheme;
  displayMode?: McpUiDisplayMode;
  devicePreset?: DevicePresetSelection;
  locale?: string;
  containerMaxHeight?: number;
  containerMaxWidth?: number;
  platform?: Platform;
  deviceCapabilities?: { hover?: boolean; touch?: boolean };
  safeAreaInsets?: { top: number; bottom: number; left: number; right: number };
  host?: HostId;
  prodResources?: boolean;
  sidebar?: boolean;
  devOverlay?: boolean;
  autoRun?: boolean;
} {
  if (typeof window === 'undefined') return {};

  const params = new URLSearchParams(window.location.search);

  const simulation = params.get('simulation') ?? undefined;
  const tool = params.get('tool') ?? undefined;
  const toolInputParam = params.get('toolInput');
  let toolInput: Record<string, unknown> | undefined;
  if (toolInputParam) {
    try {
      toolInput = JSON.parse(toolInputParam);
    } catch {
      // Invalid JSON — ignore, simulation data will be used instead
    }
  }
  const themeRaw = params.get('theme');
  const theme: McpUiTheme | null =
    themeRaw && VALID_THEMES.has(themeRaw as McpUiTheme) ? (themeRaw as McpUiTheme) : null;
  const displayModeRaw = params.get('displayMode');
  const displayMode: McpUiDisplayMode | null =
    displayModeRaw && VALID_DISPLAY_MODES.has(displayModeRaw as McpUiDisplayMode)
      ? (displayModeRaw as McpUiDisplayMode)
      : null;
  const devicePresetRaw = params.get('devicePreset');
  const devicePreset =
    devicePresetRaw && isDevicePresetSelection(devicePresetRaw) ? devicePresetRaw : undefined;
  const locale = params.get('locale');
  const maxHeightParam = params.get('maxHeight');
  const containerMaxHeight = maxHeightParam ? Number(maxHeightParam) : undefined;
  const maxWidthParam = params.get('maxWidth');
  const containerMaxWidth = maxWidthParam ? Number(maxWidthParam) : undefined;
  const host = (params.get('host') as HostId) ?? undefined;

  const prodResourcesParam = params.get('prodResources');
  const prodResources =
    prodResourcesParam === 'true' ? true : prodResourcesParam === 'false' ? false : undefined;

  const sidebarParam = params.get('sidebar');
  const sidebar = sidebarParam === 'false' ? false : sidebarParam === 'true' ? true : undefined;

  const devOverlayParam = params.get('devOverlay');
  const devOverlay =
    devOverlayParam === 'false' ? false : devOverlayParam === 'true' ? true : undefined;

  // Map deviceType param to MCP Apps platform
  const deviceType = params.get('deviceType');
  let platform: Platform | undefined;
  if (deviceType === 'mobile' || deviceType === 'tablet') {
    platform = 'mobile';
  } else if (deviceType === 'desktop') {
    platform = 'desktop';
  }

  // Device capabilities
  const hoverParam = params.get('hover');
  const touchParam = params.get('touch');
  const hasCapParams = hoverParam || touchParam;
  const deviceCapabilities = hasCapParams
    ? {
        hover: hoverParam === 'false' ? false : true,
        touch: touchParam === 'true' ? true : false,
      }
    : undefined;

  // Safe area insets
  const safeAreaTop = params.get('safeAreaTop');
  const safeAreaBottom = params.get('safeAreaBottom');
  const safeAreaLeft = params.get('safeAreaLeft');
  const safeAreaRight = params.get('safeAreaRight');
  const hasSafeAreaParams = safeAreaTop || safeAreaBottom || safeAreaLeft || safeAreaRight;
  const safeAreaInsets = hasSafeAreaParams
    ? {
        top: safeAreaTop ? Number(safeAreaTop) : 0,
        bottom: safeAreaBottom ? Number(safeAreaBottom) : 0,
        left: safeAreaLeft ? Number(safeAreaLeft) : 0,
        right: safeAreaRight ? Number(safeAreaRight) : 0,
      }
    : undefined;

  const autoRun = params.get('autoRun') === 'true' ? true : undefined;

  return {
    simulation,
    tool,
    toolInput,
    theme: theme ?? undefined,
    displayMode: displayMode ?? undefined,
    devicePreset,
    locale: locale ?? undefined,
    containerMaxHeight,
    containerMaxWidth,
    platform,
    deviceCapabilities,
    safeAreaInsets,
    host: host ?? undefined,
    prodResources,
    sidebar,
    devOverlay,
    autoRun,
  };
}

const PREFS_KEY = 'sunpeak-inspector-prefs';

export interface StoredPrefs {
  theme?: McpUiTheme;
  locale?: string;
  displayMode?: McpUiDisplayMode;
  devicePreset?: DevicePresetSelection;
  containerHeight?: number;
  containerWidth?: number;
  containerMaxHeight?: number;
  containerMaxWidth?: number;
  safeAreaInsets?: { top: number; bottom: number; left: number; right: number };
  deviceSafeArea?: { top: number; bottom: number; left: number; right: number };
  safeAreaOverride?: { top: number; bottom: number; left: number; right: number };
  activeHost?: HostId;
  platform?: Platform;
  hover?: boolean;
  touch?: boolean;
  screenWidth?: ScreenWidth;
  sidebarWidth?: number;
  rightSidebarWidth?: number;
  timeZone?: string;
  prodResources?: boolean;
  modelProvider?: string;
  modelId?: string;
}

const VALID_THEMES: ReadonlySet<McpUiTheme> = new Set(['light', 'dark']);
const VALID_DISPLAY_MODES: ReadonlySet<McpUiDisplayMode> = new Set(['inline', 'pip', 'fullscreen']);
const VALID_PLATFORMS: ReadonlySet<Platform> = new Set(['web', 'desktop', 'mobile']);
const VALID_SCREEN_WIDTHS: ReadonlySet<ScreenWidth> = new Set([
  'mobile-s',
  'mobile-m',
  'mobile-l',
  'mobile-xl',
  'tablet',
  'tablet-l',
  'full',
]);

function isSafeStoredString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

// Validate the parsed JSON one field at a time so a corrupt or stale entry
// (older sunpeak version, manual edit) can't seed bad values into state.
function sanitizeStoredPrefs(raw: unknown): StoredPrefs {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const prefs: StoredPrefs = {};

  if (typeof obj.theme === 'string' && VALID_THEMES.has(obj.theme as McpUiTheme)) {
    prefs.theme = obj.theme as McpUiTheme;
  }
  if (typeof obj.locale === 'string') {
    prefs.locale = obj.locale;
  }
  if (
    typeof obj.displayMode === 'string' &&
    VALID_DISPLAY_MODES.has(obj.displayMode as McpUiDisplayMode)
  ) {
    prefs.displayMode = obj.displayMode as McpUiDisplayMode;
  }
  if (typeof obj.devicePreset === 'string' && isDevicePresetSelection(obj.devicePreset)) {
    prefs.devicePreset = obj.devicePreset;
  }
  if (typeof obj.containerHeight === 'number' && Number.isFinite(obj.containerHeight)) {
    prefs.containerHeight = obj.containerHeight;
  }
  if (typeof obj.containerWidth === 'number' && Number.isFinite(obj.containerWidth)) {
    prefs.containerWidth = obj.containerWidth;
  }
  if (typeof obj.containerMaxHeight === 'number' && Number.isFinite(obj.containerMaxHeight)) {
    prefs.containerMaxHeight = obj.containerMaxHeight;
  }
  if (typeof obj.containerMaxWidth === 'number' && Number.isFinite(obj.containerMaxWidth)) {
    prefs.containerMaxWidth = obj.containerMaxWidth;
  }
  if (obj.safeAreaInsets && typeof obj.safeAreaInsets === 'object') {
    const insets = obj.safeAreaInsets as Record<string, unknown>;
    if (
      typeof insets.top === 'number' &&
      typeof insets.bottom === 'number' &&
      typeof insets.left === 'number' &&
      typeof insets.right === 'number'
    ) {
      prefs.safeAreaInsets = {
        top: insets.top,
        bottom: insets.bottom,
        left: insets.left,
        right: insets.right,
      };
    }
  }
  if (obj.deviceSafeArea && typeof obj.deviceSafeArea === 'object') {
    const insets = obj.deviceSafeArea as Record<string, unknown>;
    if (
      typeof insets.top === 'number' &&
      typeof insets.bottom === 'number' &&
      typeof insets.left === 'number' &&
      typeof insets.right === 'number'
    ) {
      prefs.deviceSafeArea = {
        top: insets.top,
        bottom: insets.bottom,
        left: insets.left,
        right: insets.right,
      };
    }
  }
  if (obj.safeAreaOverride && typeof obj.safeAreaOverride === 'object') {
    const insets = obj.safeAreaOverride as Record<string, unknown>;
    if (
      typeof insets.top === 'number' &&
      typeof insets.bottom === 'number' &&
      typeof insets.left === 'number' &&
      typeof insets.right === 'number'
    ) {
      prefs.safeAreaOverride = {
        top: insets.top,
        bottom: insets.bottom,
        left: insets.left,
        right: insets.right,
      };
    }
  }
  if (typeof obj.activeHost === 'string') {
    prefs.activeHost = obj.activeHost;
  }
  if (typeof obj.platform === 'string' && VALID_PLATFORMS.has(obj.platform as Platform)) {
    prefs.platform = obj.platform as Platform;
  }
  if (typeof obj.hover === 'boolean') prefs.hover = obj.hover;
  if (typeof obj.touch === 'boolean') prefs.touch = obj.touch;
  if (
    typeof obj.screenWidth === 'string' &&
    VALID_SCREEN_WIDTHS.has(obj.screenWidth as ScreenWidth)
  ) {
    prefs.screenWidth = obj.screenWidth as ScreenWidth;
  }
  if (typeof obj.sidebarWidth === 'number' && Number.isFinite(obj.sidebarWidth)) {
    prefs.sidebarWidth = Math.max(DEFAULT_SIDEBAR_WIDTH, Math.round(obj.sidebarWidth));
  }
  if (typeof obj.rightSidebarWidth === 'number' && Number.isFinite(obj.rightSidebarWidth)) {
    prefs.rightSidebarWidth = Math.max(DEFAULT_SIDEBAR_WIDTH, Math.round(obj.rightSidebarWidth));
  }
  if (typeof obj.timeZone === 'string') {
    prefs.timeZone = obj.timeZone;
  }
  if (typeof obj.prodResources === 'boolean') {
    prefs.prodResources = obj.prodResources;
  }
  if (isSafeStoredString(obj.modelProvider)) {
    prefs.modelProvider = obj.modelProvider;
  }
  if (isSafeStoredString(obj.modelId)) {
    prefs.modelId = obj.modelId;
  }

  return prefs;
}

export function readStoredPrefs(): StoredPrefs {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    return sanitizeStoredPrefs(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function writeStoredPrefs(prefs: StoredPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage may be unavailable (private browsing, storage quota) — ignore
  }
}

type ContainerDimensions = NonNullable<McpUiHostContext['containerDimensions']>;

export function deriveContainerDimensions({
  displayMode,
  containerHeight,
  containerWidth,
  containerMaxHeight,
  containerMaxWidth,
  measuredContentWidth,
  viewportHeight = 800,
  viewportWidth = 1280,
}: {
  displayMode: McpUiDisplayMode;
  containerHeight?: number;
  containerWidth?: number;
  containerMaxHeight?: number;
  containerMaxWidth?: number;
  measuredContentWidth?: number;
  viewportHeight?: number;
  viewportWidth?: number;
}): ContainerDimensions | undefined {
  if (
    containerHeight != null ||
    containerWidth != null ||
    containerMaxHeight != null ||
    containerMaxWidth != null
  ) {
    return {
      ...(containerHeight != null ? { height: containerHeight } : {}),
      ...(containerWidth != null ? { width: containerWidth } : {}),
      ...(containerMaxHeight != null ? { maxHeight: containerMaxHeight } : {}),
      ...(containerMaxWidth != null ? { maxWidth: containerMaxWidth } : {}),
    };
  }

  if (displayMode === 'fullscreen') {
    return { height: viewportHeight - 52, width: measuredContentWidth ?? viewportWidth };
  }

  if (displayMode === 'pip') {
    return {
      maxHeight: Math.round(viewportHeight * 0.5 - 38),
      ...(measuredContentWidth != null ? { maxWidth: measuredContentWidth } : {}),
    };
  }

  if (measuredContentWidth != null) {
    return { maxWidth: measuredContentWidth };
  }

  return undefined;
}

export function useInspectorState({
  simulations,
  defaultHost = 'chatgpt',
  preserveToolDataOnSimulationChange = false,
}: UseInspectorStateOptions): InspectorState {
  // List every simulation so backend-only tools can still be selected, called,
  // and inspected through the sidebar even though they have no resource to render.
  const simulationNames = Object.keys(simulations).sort((a, b) => {
    const simA = simulations[a];
    const simB = simulations[b];
    const resourceLabelA = simA.resource
      ? `${(simA.resource.title as string) || simA.resource.name}: `
      : '';
    const resourceLabelB = simB.resource
      ? `${(simB.resource.title as string) || simB.resource.name}: `
      : '';
    const labelA = `${resourceLabelA}${(simA.tool.title as string) || simA.tool.name}`;
    const labelB = `${resourceLabelB}${(simB.tool.title as string) || simB.tool.name}`;
    return labelA.localeCompare(labelB);
  });
  const defaultSimulationName =
    simulationNames.find((name) => !!simulations[name]?.resource) ?? simulationNames[0] ?? '';
  const urlParams = useMemo(() => parseUrlParams(), []);
  const autoRun = urlParams.autoRun === true;
  const storedPrefs = useMemo(() => (autoRun ? {} : readStoredPrefs()), [autoRun]);
  const initialDevicePreset =
    urlParams.devicePreset ?? storedPrefs.devicePreset ?? CUSTOM_DEVICE_PRESET;
  const initialDevicePresetConfig = getDevicePreset(initialDevicePreset);
  const [devicePreset, setDevicePreset] = useState<DevicePresetSelection>(initialDevicePreset);
  const [screenWidth, _setScreenWidth] = useState<ScreenWidth>(
    initialDevicePresetConfig?.screenWidth ?? storedPrefs.screenWidth ?? 'full'
  );
  const [sidebarWidth, setSidebarWidth] = useState(
    storedPrefs.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH
  );
  const [rightSidebarWidth, setRightSidebarWidth] = useState(
    storedPrefs.rightSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH
  );

  const isMobileWidth = (width: ScreenWidth) => width.startsWith('mobile-');

  // ── Host selection ──
  const [activeHost, setActiveHost] = useState<HostId>(
    urlParams.host ?? storedPrefs.activeHost ?? defaultHost
  );

  // ── Simulation selection ──
  const initialSimulationName = useMemo(() => {
    if (!urlParams.simulation) return defaultSimulationName;
    return urlParams.simulation in simulations ? urlParams.simulation : defaultSimulationName;
  }, [urlParams.simulation, simulations, defaultSimulationName]);

  const [selectedSimulationName, setSelectedSimulationName] =
    useState<string>(initialSimulationName);

  const selectedSim = simulations[selectedSimulationName];

  // ── Host context state ──

  const [theme, setTheme] = useState<McpUiTheme>(
    urlParams.theme ?? storedPrefs.theme ?? DEFAULT_THEME
  );
  const [displayMode, _setDisplayMode] = useState<McpUiDisplayMode>(
    urlParams.displayMode ??
      initialDevicePresetConfig?.displayMode ??
      storedPrefs.displayMode ??
      DEFAULT_DISPLAY_MODE
  );
  const [locale, setLocale] = useState(urlParams.locale ?? storedPrefs.locale ?? 'en-US');
  const [containerHeight, _setContainerHeight] = useState<number | undefined>(
    initialDevicePresetConfig?.containerHeight ?? storedPrefs.containerHeight
  );
  const [containerWidth, _setContainerWidth] = useState<number | undefined>(
    initialDevicePresetConfig?.containerWidth ?? storedPrefs.containerWidth
  );
  const [containerMaxHeight, _setContainerMaxHeight] = useState<number | undefined>(
    urlParams.containerMaxHeight ??
      initialDevicePresetConfig?.containerMaxHeight ??
      storedPrefs.containerMaxHeight
  );
  const [containerMaxWidth, _setContainerMaxWidth] = useState<number | undefined>(
    urlParams.containerMaxWidth ??
      initialDevicePresetConfig?.containerMaxWidth ??
      storedPrefs.containerMaxWidth
  );
  const [platform, _setPlatform] = useState<Platform>(
    urlParams.platform ??
      initialDevicePresetConfig?.platform ??
      storedPrefs.platform ??
      DEFAULT_PLATFORM
  );
  const [hover, _setHover] = useState(
    urlParams.deviceCapabilities?.hover ??
      initialDevicePresetConfig?.hover ??
      storedPrefs.hover ??
      true
  );
  const [touch, _setTouch] = useState(
    urlParams.deviceCapabilities?.touch ??
      initialDevicePresetConfig?.touch ??
      storedPrefs.touch ??
      false
  );
  // URL values are an explicit, immutable initial override. Manual values use
  // separate state so device presets and host chrome remain independently
  // observable and can be merged when no override exists.
  const urlSafeAreaOverride = urlParams.safeAreaInsets;
  const [manualSafeAreaOverride, setManualSafeAreaOverride] = useState<SafeAreaInsets | undefined>(
    () =>
      storedPrefs.safeAreaOverride ??
      (initialDevicePreset === CUSTOM_DEVICE_PRESET ? storedPrefs.safeAreaInsets : undefined)
  );
  const [deviceSafeArea, setDeviceSafeArea] = useState<SafeAreaInsets>(() =>
    normalizeSafeArea(initialDevicePresetConfig?.safeAreaInsets ?? storedPrefs.deviceSafeArea)
  );
  const [timeZone, setTimeZone] = useState(
    () => storedPrefs.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  );

  const hostSafeArea = useMemo(
    () => normalizeSafeArea(getHostShell(activeHost)?.safeAreaByDisplayMode?.[displayMode]),
    [activeHost, displayMode]
  );
  // Precedence is explicit URL override -> manual override -> per-edge max of
  // the selected device and host display-mode insets.
  const safeAreaOverride = urlSafeAreaOverride ?? manualSafeAreaOverride;
  const effectiveSafeArea = useMemo(
    () => deriveEffectiveSafeArea(deviceSafeArea, hostSafeArea, safeAreaOverride),
    [deviceSafeArea, hostSafeArea, safeAreaOverride]
  );
  const safeAreaInsets = effectiveSafeArea;

  const markCustomDevicePreset = useCallback(() => {
    setDevicePreset(CUSTOM_DEVICE_PRESET);
  }, []);

  const setScreenWidth = useCallback(
    (width: ScreenWidth) => {
      markCustomDevicePreset();
      _setScreenWidth(width);
    },
    [markCustomDevicePreset]
  );
  const setContainerHeight = useCallback(
    (height: number | undefined) => {
      markCustomDevicePreset();
      _setContainerHeight(height);
    },
    [markCustomDevicePreset]
  );
  const setContainerWidth = useCallback(
    (width: number | undefined) => {
      markCustomDevicePreset();
      _setContainerWidth(width);
    },
    [markCustomDevicePreset]
  );
  const setContainerMaxHeight = useCallback(
    (height: number | undefined) => {
      markCustomDevicePreset();
      _setContainerMaxHeight(height);
    },
    [markCustomDevicePreset]
  );
  const setContainerMaxWidth = useCallback(
    (width: number | undefined) => {
      markCustomDevicePreset();
      _setContainerMaxWidth(width);
    },
    [markCustomDevicePreset]
  );
  const setPlatform = useCallback(
    (nextPlatform: Platform) => {
      markCustomDevicePreset();
      _setPlatform(nextPlatform);
    },
    [markCustomDevicePreset]
  );
  const setHover = useCallback(
    (value: boolean) => {
      markCustomDevicePreset();
      _setHover(value);
    },
    [markCustomDevicePreset]
  );
  const setTouch = useCallback(
    (value: boolean) => {
      markCustomDevicePreset();
      _setTouch(value);
    },
    [markCustomDevicePreset]
  );
  const setSafeAreaInsets = useCallback(
    (value: React.SetStateAction<SafeAreaInsets>) => {
      setDevicePreset(CUSTOM_DEVICE_PRESET);
      setManualSafeAreaOverride(typeof value === 'function' ? value(effectiveSafeArea) : value);
    },
    [effectiveSafeArea]
  );

  const applyDevicePreset = useCallback((presetId: DevicePresetSelection) => {
    const preset = getDevicePreset(presetId);
    if (!preset) {
      setDevicePreset(CUSTOM_DEVICE_PRESET);
      return;
    }

    setManualSafeAreaOverride(undefined);
    setDeviceSafeArea(normalizeSafeArea(preset.safeAreaInsets));
    setDevicePreset(presetId);
    _setDisplayMode(preset.displayMode);
    _setScreenWidth(preset.screenWidth);
    _setContainerHeight(preset.containerHeight);
    _setContainerWidth(preset.containerWidth);
    _setContainerMaxHeight(preset.containerMaxHeight);
    _setContainerMaxWidth(preset.containerMaxWidth);
    _setPlatform(preset.platform);
    _setHover(preset.hover);
    _setTouch(preset.touch);
  }, []);

  // Skip persisting on the first render — only write when the user actually changes something.
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (autoRun) return;
    writeStoredPrefs({
      ...readStoredPrefs(),
      theme,
      locale,
      displayMode,
      devicePreset,
      containerHeight,
      containerWidth,
      containerMaxHeight,
      containerMaxWidth,
      safeAreaInsets,
      deviceSafeArea,
      safeAreaOverride: manualSafeAreaOverride,
      activeHost,
      platform,
      hover,
      touch,
      screenWidth,
      sidebarWidth,
      rightSidebarWidth,
      timeZone,
    });
  }, [
    autoRun,
    theme,
    locale,
    displayMode,
    devicePreset,
    containerHeight,
    containerWidth,
    containerMaxHeight,
    containerMaxWidth,
    safeAreaInsets,
    deviceSafeArea,
    manualSafeAreaOverride,
    activeHost,
    platform,
    hover,
    touch,
    screenWidth,
    sidebarWidth,
    rightSidebarWidth,
    timeZone,
  ]);

  // Content width measured from the conversation component's ResizeObserver.
  // Used as containerDimensions.maxWidth unless the user manually sets one.
  const [measuredContentWidth, setMeasuredContentWidth] = useState<number | undefined>(undefined);
  const handleContentWidthChange = useCallback((width: number) => {
    setMeasuredContentWidth(width);
  }, []);

  // Display mode setter that respects mobile width constraints
  const setDisplayMode = useCallback(
    (mode: McpUiDisplayMode) => {
      markCustomDevicePreset();
      if (isMobileWidth(screenWidth) && mode === 'pip') {
        _setDisplayMode('fullscreen');
      } else {
        _setDisplayMode(mode);
      }
    },
    [markCustomDevicePreset, screenWidth]
  );

  // Callback for IframeResource's onDisplayModeReady (paint fence ack).
  // Currently a no-op — the inspector doesn't need to track the confirmed
  // display mode. Kept as a stable reference to avoid unnecessary re-renders.
  const handleDisplayModeReady = useCallback((_mode: string) => {}, []);

  // Build containerDimensions based on the current display mode.
  // Real hosts (ChatGPT) report different shapes per mode:
  //   inline:     { height: <content height>, maxWidth: <column width> }
  //   fullscreen: { height: <viewport height>, width: <viewport width> }
  //   pip:        { height: <pip height>, maxWidth: <pip max width> }
  //
  // User-set sidebar values always take priority. When not set, we derive
  // values from the measured content width (ResizeObserver) and the
  // browser viewport for fullscreen mode.
  const containerDimensions = useMemo(() => {
    return deriveContainerDimensions({
      displayMode,
      containerHeight,
      containerWidth,
      containerMaxHeight,
      containerMaxWidth,
      measuredContentWidth,
      viewportHeight: typeof window !== 'undefined' ? window.innerHeight : undefined,
      viewportWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
    });
  }, [
    containerHeight,
    containerWidth,
    containerMaxHeight,
    containerMaxWidth,
    measuredContentWidth,
    displayMode,
  ]);

  const hostContext = useMemo<McpUiHostContext>(
    () => ({
      theme,
      displayMode,
      availableDisplayModes: ['inline', 'pip', 'fullscreen'],
      locale,
      timeZone,
      platform,
      deviceCapabilities: { hover, touch },
      safeAreaInsets,
      ...(containerDimensions ? { containerDimensions } : {}),
    }),
    [
      theme,
      displayMode,
      locale,
      timeZone,
      platform,
      hover,
      touch,
      safeAreaInsets,
      containerDimensions,
    ]
  );

  // ── Tool data state ──

  const [toolInput, setToolInput] = useState<Record<string, unknown>>(
    () => urlParams.toolInput ?? selectedSim?.toolInput ?? {}
  );
  const [toolResult, setToolResult] = useState<CallToolResult | undefined>(
    () => selectedSim?.toolResult as CallToolResult | undefined
  );

  // Editable JSON strings for sidebar
  const [toolInputJson, setToolInputJson] = useState(() => JSON.stringify(toolInput, null, 2));
  const [toolResultJson, setToolResultJson] = useState(() =>
    JSON.stringify(toolResult ?? null, null, 2)
  );

  // Model context
  const [modelContextJson, setModelContextJson] = useState<string>('null');
  const [modelContext, setModelContext] = useState<Record<string, unknown> | null>(null);
  const [modelAppContext, setModelAppContext] = useState<ModelAppContext | null>(null);

  // Track which field is being edited
  const [editingField, setEditingField] = useState<string | null>(null);

  // JSON validation errors
  const [toolInputError, setToolInputError] = useState('');
  const [toolResultError, setToolResultError] = useState('');
  const [modelContextError, setModelContextError] = useState('');

  // Reset tool data when simulation changes. URL-provided toolInput takes
  // precedence over the simulation fixture data, allowing tests to pass
  // dynamic arguments to the server.
  useEffect(() => {
    if (preserveToolDataOnSimulationChange) return;
    const newInput = urlParams.toolInput ?? selectedSim?.toolInput ?? {};
    const newResult = (selectedSim?.toolResult as CallToolResult | undefined) ?? undefined;
    setToolInput(newInput);
    setToolResult(newResult);
    if (editingField !== 'toolInput') {
      setToolInputJson(JSON.stringify(newInput, null, 2));
      setToolInputError('');
    }
    if (editingField !== 'toolResult') {
      setToolResultJson(JSON.stringify(newResult ?? null, null, 2));
      setToolResultError('');
    }
    if (editingField !== 'modelContext') {
      setModelContext(null);
      setModelAppContext(null);
      setModelContextJson('null');
      setModelContextError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSimulationName, selectedSim, preserveToolDataOnSimulationChange]);

  // Disallow PiP on mobile widths
  useEffect(() => {
    if (isMobileWidth(screenWidth) && displayMode === 'pip') {
      _setDisplayMode('fullscreen');
    }
  }, [screenWidth, displayMode]);

  // ── Host callbacks ──

  const handleDisplayModeChange = (mode: McpUiDisplayMode) => {
    setDisplayMode(mode);
  };

  const handleUpdateModelContext = (content: unknown[], structuredContent?: unknown) => {
    setModelContextJson(JSON.stringify(structuredContent ?? content, null, 2));
    setModelAppContext(
      structuredContent === undefined && content.length === 0
        ? null
        : {
            content,
            ...(structuredContent !== undefined ? { structuredContent } : {}),
          }
    );
  };

  // ── JSON helpers ──

  const validateJSON = (
    json: string,
    setJson: (value: string) => void,
    setError: (error: string) => void
  ) => {
    setJson(json);
    try {
      if (json.trim() !== '') JSON.parse(json);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  const commitJSON = (
    json: string,
    setError: (error: string) => void,
    updateFn: (value: Record<string, unknown> | null) => void
  ) => {
    try {
      const parsed = json.trim() === '' ? null : JSON.parse(json);
      setError('');
      updateFn(parsed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
    } finally {
      setEditingField(null);
    }
  };

  // ── Content props ──

  const effectiveToolResult = useMemo((): CallToolResult | undefined => {
    if (!toolResult && !modelContext) return undefined;
    if (!modelContext) return toolResult;

    const baseResult = toolResult ?? { content: [] };
    const baseStructured = (baseResult.structuredContent as Record<string, unknown>) ?? {};
    return {
      ...baseResult,
      structuredContent: { ...baseStructured, ...modelContext },
    };
  }, [toolResult, modelContext]);

  const resourceUrl = selectedSim?.resourceUrl;
  const resourceScript = selectedSim?.resourceScript;
  const resourceHtml = selectedSim?.resourceHtml;
  const csp = selectedSim?.resource ? extractResourceCSP(selectedSim.resource) : undefined;
  const resourceMeta = (selectedSim?.resource?._meta as Record<string, unknown> | undefined)?.ui as
    | { permissions?: McpUiResourcePermissions; prefersBorder?: boolean; domain?: string }
    | undefined;
  const permissions = resourceMeta?.permissions;
  const prefersBorder = resourceMeta?.prefersBorder ?? false;

  return {
    simulationNames,
    selectedSimulationName,
    setSelectedSimulationName,
    selectedSim,

    activeHost,
    setActiveHost,

    screenWidth,
    setScreenWidth,
    sidebarWidth,
    setSidebarWidth,
    rightSidebarWidth,
    setRightSidebarWidth,

    theme,
    setTheme,
    displayMode,
    setDisplayMode,
    devicePreset,
    applyDevicePreset,
    locale,
    setLocale,
    containerHeight,
    setContainerHeight,
    containerWidth,
    setContainerWidth,
    containerMaxHeight,
    setContainerMaxHeight,
    containerMaxWidth,
    setContainerMaxWidth,
    platform,
    setPlatform,
    hover,
    setHover,
    touch,
    setTouch,
    safeAreaOverride,
    deviceSafeArea,
    hostSafeArea,
    effectiveSafeArea,
    safeAreaInsets,
    setSafeAreaInsets,
    timeZone,
    setTimeZone,

    hostContext,

    handleDisplayModeReady,

    toolInput,
    setToolInput,
    toolResult,
    setToolResult,
    effectiveToolResult,

    modelContext,
    setModelContext,
    modelAppContext,
    setModelAppContext,

    toolInputJson,
    setToolInputJson,
    toolInputError,
    setToolInputError,
    toolResultJson,
    setToolResultJson,
    toolResultError,
    setToolResultError,
    modelContextJson,
    setModelContextJson,
    modelContextError,
    setModelContextError,
    editingField,
    setEditingField,

    validateJSON,
    commitJSON,

    measuredContentWidth,
    handleContentWidthChange,

    handleDisplayModeChange,
    handleUpdateModelContext,

    resourceUrl,
    resourceScript,
    resourceHtml,
    csp,
    permissions,
    prefersBorder,
    urlTool: urlParams.tool,
    urlProdResources: urlParams.prodResources,
    urlSidebar: urlParams.sidebar,
    urlDevOverlay: urlParams.devOverlay,
  };
}
