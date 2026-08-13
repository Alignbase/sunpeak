import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { deriveContainerDimensions, useInspectorState } from './use-inspector-state';
import type { Simulation } from '../types/simulation';
import '../chatgpt/chatgpt-host';
import '../claude/claude-host';

function createSim(name: string, hasResource: boolean): Simulation {
  return {
    name,
    tool: { name, inputSchema: { type: 'object' } },
    resource: hasResource
      ? { uri: `test://${name}`, name: `${name}-resource`, mimeType: 'text/html' }
      : undefined,
    resourceUrl: hasResource ? `/${name}.html` : undefined,
  };
}

const PREFS_KEY = 'sunpeak-inspector-prefs';

describe('useInspectorState', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('includes backend-only simulations', () => {
    const simulations = {
      'ui-tool': createSim('ui-tool', true),
      'backend-tool': createSim('backend-tool', false),
    };

    const { result } = renderHook(() => useInspectorState({ simulations }));

    expect(result.current.simulationNames).toContain('ui-tool');
    expect(result.current.simulationNames).toContain('backend-tool');
  });

  it('defaults to the first simulation with a UI resource', () => {
    const simulations = {
      'backend-tool': createSim('backend-tool', false),
      'ui-tool': createSim('ui-tool', true),
    };

    const { result } = renderHook(() => useInspectorState({ simulations }));

    expect(result.current.selectedSimulationName).toBe('ui-tool');
  });

  it('uses the viewport width for fullscreen container dimensions', () => {
    expect(
      deriveContainerDimensions({
        displayMode: 'fullscreen',
        measuredContentWidth: 512,
        viewportHeight: 900,
        viewportWidth: 1440,
      })
    ).toEqual({ height: 848, width: 512 });
  });

  it('falls back to viewport width for fullscreen container dimensions before measuring', () => {
    expect(
      deriveContainerDimensions({
        displayMode: 'fullscreen',
        viewportHeight: 900,
        viewportWidth: 1440,
      })
    ).toEqual({ height: 848, width: 1440 });
  });

  it('applies a mobile fullscreen device preset from the URL', () => {
    window.history.replaceState({}, '', '/?devicePreset=iphone-15-pro-max');
    const simulations = { 'ui-tool': createSim('ui-tool', true) };

    const { result } = renderHook(() => useInspectorState({ simulations }));

    expect(result.current.devicePreset).toBe('iphone-15-pro-max');
    expect(result.current.displayMode).toBe('fullscreen');
    expect(result.current.screenWidth).toBe('mobile-xl');
    expect(result.current.platform).toBe('mobile');
    expect(result.current.hover).toBe(false);
    expect(result.current.touch).toBe(true);
    expect(result.current.containerWidth).toBe(430);
    expect(result.current.containerHeight).toBe(932);
    expect(result.current.safeAreaInsets).toEqual({ top: 59, bottom: 150, left: 0, right: 0 });
    expect(result.current.hostContext.containerDimensions).toEqual({ height: 932, width: 430 });
  });

  it('applies a device preset from the state API', () => {
    const simulations = { 'ui-tool': createSim('ui-tool', true) };
    const { result } = renderHook(() => useInspectorState({ simulations }));

    act(() => {
      result.current.applyDevicePreset('iphone-15');
    });

    expect(result.current.devicePreset).toBe('iphone-15');
    expect(result.current.displayMode).toBe('fullscreen');
    expect(result.current.platform).toBe('mobile');
    expect(result.current.containerWidth).toBe(393);
    expect(result.current.containerHeight).toBe(852);
    expect(result.current.safeAreaInsets).toEqual({ top: 59, bottom: 150, left: 0, right: 0 });
  });

  it.each([
    ['chatgpt', { top: 59, right: 0, bottom: 150, left: 0 }],
    ['claude', { top: 59, right: 16, bottom: 138, left: 16 }],
  ] as const)('merges iPhone 15 and %s fullscreen safe areas per edge', (host, expected) => {
    window.history.replaceState(
      {},
      '',
      `/?devicePreset=iphone-15&host=${host}&displayMode=fullscreen`
    );

    const { result } = renderHook(() => useInspectorState({ simulations: {} }));

    expect(result.current.deviceSafeArea).toEqual({
      top: 59,
      right: 0,
      bottom: 34,
      left: 0,
    });
    expect(result.current.effectiveSafeArea).toEqual(expected);
    expect(result.current.hostContext.safeAreaInsets).toEqual(expected);
  });

  it('keeps URL safe-area values as an explicit override over device and host insets', () => {
    window.history.replaceState(
      {},
      '',
      '/?devicePreset=iphone-15&host=chatgpt&displayMode=fullscreen&safeAreaTop=1&safeAreaRight=2&safeAreaBottom=3&safeAreaLeft=4'
    );

    const { result } = renderHook(() => useInspectorState({ simulations: {} }));

    expect(result.current.safeAreaOverride).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
    expect(result.current.effectiveSafeArea).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
    expect(result.current.hostContext.safeAreaInsets).toEqual({
      top: 1,
      right: 2,
      bottom: 3,
      left: 4,
    });
  });

  it('keeps a stored manual safe-area override above a device preset selected by URL', () => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        devicePreset: 'custom',
        safeAreaOverride: { top: 1, right: 2, bottom: 3, left: 4 },
      })
    );
    window.history.replaceState(
      {},
      '',
      '/?devicePreset=iphone-15&host=chatgpt&displayMode=fullscreen'
    );

    const { result } = renderHook(() => useInspectorState({ simulations: {} }));

    expect(result.current.safeAreaOverride).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
    expect(result.current.effectiveSafeArea).toEqual({
      top: 1,
      right: 2,
      bottom: 3,
      left: 4,
    });
  });

  it('marks the device preset custom when dimensions are edited manually', () => {
    window.history.replaceState({}, '', '/?devicePreset=iphone-15');
    const simulations = { 'ui-tool': createSim('ui-tool', true) };
    const { result } = renderHook(() => useInspectorState({ simulations }));

    act(() => {
      result.current.setContainerWidth(390);
    });

    expect(result.current.devicePreset).toBe('custom');
    expect(result.current.containerWidth).toBe(390);
    expect(result.current.safeAreaInsets).toEqual({ top: 59, bottom: 150, left: 0, right: 0 });
  });

  it('keeps device and host safe areas reactive after an unrelated preset field is edited', () => {
    window.history.replaceState(
      {},
      '',
      '/?devicePreset=iphone-15&host=chatgpt&displayMode=fullscreen'
    );

    const { result } = renderHook(() => useInspectorState({ simulations: {} }));

    act(() => result.current.setContainerWidth(390));
    expect(result.current.devicePreset).toBe('custom');
    expect(result.current.safeAreaOverride).toBeUndefined();
    expect(result.current.deviceSafeArea).toEqual({ top: 59, bottom: 34, left: 0, right: 0 });

    act(() => result.current.setActiveHost('claude'));
    expect(result.current.effectiveSafeArea).toEqual({
      top: 59,
      right: 16,
      bottom: 138,
      left: 16,
    });
  });

  it('preserves current preview values when selecting custom after a device preset', () => {
    const simulations = { 'ui-tool': createSim('ui-tool', true) };
    const { result } = renderHook(() => useInspectorState({ simulations }));

    act(() => {
      result.current.applyDevicePreset('iphone-15');
    });
    act(() => {
      result.current.applyDevicePreset('custom');
    });

    expect(result.current.devicePreset).toBe('custom');
    expect(result.current.displayMode).toBe('fullscreen');
    expect(result.current.containerWidth).toBe(393);
    expect(result.current.containerHeight).toBe(852);
    expect(result.current.safeAreaInsets).toEqual({ top: 59, bottom: 150, left: 0, right: 0 });
  });

  it('stores structured model context for future model turns without changing resource state', () => {
    const simulations = { 'ui-tool': createSim('ui-tool', true) };
    const { result } = renderHook(() => useInspectorState({ simulations }));

    act(() => {
      result.current.handleUpdateModelContext([], { selectedAlbum: 'Pizza Tour' });
    });

    expect(result.current.modelContext).toBeNull();
    expect(result.current.modelAppContext).toEqual({
      content: [],
      structuredContent: { selectedAlbum: 'Pizza Tour' },
    });
  });

  it('stores text-only model context without injecting it as resource state', () => {
    const simulations = { 'ui-tool': createSim('ui-tool', true) };
    const { result } = renderHook(() => useInspectorState({ simulations }));

    act(() => {
      result.current.handleUpdateModelContext([{ type: 'text', text: 'Viewing page 2 of 4' }]);
    });

    expect(result.current.modelContext).toBeNull();
    expect(result.current.modelAppContext).toEqual({
      content: [{ type: 'text', text: 'Viewing page 2 of 4' }],
    });
  });

  it('clears model context when the app writes empty content', () => {
    const simulations = { 'ui-tool': createSim('ui-tool', true) };
    const { result } = renderHook(() => useInspectorState({ simulations }));

    act(() => {
      result.current.handleUpdateModelContext([], { selectedAlbum: 'Pizza Tour' });
    });
    act(() => {
      result.current.handleUpdateModelContext([]);
    });

    expect(result.current.modelContext).toBeNull();
    expect(result.current.modelAppContext).toBeNull();
  });

  it('refreshes app context across simulation changes', () => {
    const simulations = {
      first: createSim('first', true),
      second: createSim('second', true),
    };
    const { result } = renderHook(() => useInspectorState({ simulations }));

    act(() => {
      result.current.handleUpdateModelContext([], { selectedAlbum: 'Pizza Tour' });
    });
    act(() => {
      result.current.setSelectedSimulationName('second');
    });

    expect(result.current.modelAppContext).toBeNull();
    expect(result.current.modelContextJson).toBe('null');
  });

  describe('preference persistence', () => {
    const simulations = { 'ui-tool': createSim('ui-tool', true) };

    it('restores valid stored preferences', () => {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          theme: 'light',
          locale: 'ja-JP',
          activeHost: 'claude',
          containerHeight: 480,
          containerWidth: 720,
          containerMaxHeight: 600,
          containerMaxWidth: 800,
          screenWidth: 'tablet',
          sidebarWidth: 340,
          rightSidebarWidth: 420,
          timeZone: 'Asia/Tokyo',
        })
      );

      const { result } = renderHook(() => useInspectorState({ simulations }));

      expect(result.current.theme).toBe('light');
      expect(result.current.locale).toBe('ja-JP');
      expect(result.current.activeHost).toBe('claude');
      expect(result.current.containerHeight).toBe(480);
      expect(result.current.containerWidth).toBe(720);
      expect(result.current.containerMaxHeight).toBe(600);
      expect(result.current.containerMaxWidth).toBe(800);
      expect(result.current.screenWidth).toBe('tablet');
      expect(result.current.sidebarWidth).toBe(340);
      expect(result.current.rightSidebarWidth).toBe(420);
      expect(result.current.timeZone).toBe('Asia/Tokyo');
    });

    it('ignores invalid values in stored preferences', () => {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          theme: 'neon-pink',
          displayMode: 'magic',
          devicePreset: 'shoe-phone',
          platform: 'console',
          screenWidth: 'enormous',
          sidebarWidth: 'wide',
          rightSidebarWidth: 120,
          containerHeight: 'huge',
          containerWidth: 'wide',
          containerMaxHeight: 'tall',
          hover: 'yes',
          safeAreaInsets: { top: 10 },
          timeZone: 42,
          modelProvider: 'openai\nforged',
          modelId: 'gpt-test\u0000forged',
        })
      );

      const { result } = renderHook(() => useInspectorState({ simulations }));

      // Bad values are dropped; defaults are used.
      expect(result.current.theme).toBe('dark');
      expect(result.current.displayMode).toBe('inline');
      expect(result.current.devicePreset).toBe('custom');
      expect(result.current.platform).toBe('desktop');
      expect(result.current.screenWidth).toBe('full');
      expect(result.current.sidebarWidth).toBe(260);
      expect(result.current.rightSidebarWidth).toBe(260);
      expect(result.current.containerHeight).toBeUndefined();
      expect(result.current.containerWidth).toBeUndefined();
      expect(result.current.containerMaxHeight).toBeUndefined();
      expect(result.current.hover).toBe(true);
      expect(result.current.safeAreaInsets).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });

      act(() => {
        result.current.setLocale('en-GB');
      });

      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
      expect(prefs.modelProvider).toBeUndefined();
      expect(prefs.modelId).toBeUndefined();
    });

    it('falls back to defaults when stored JSON is corrupt', () => {
      localStorage.setItem(PREFS_KEY, 'not-json{');

      const { result } = renderHook(() => useInspectorState({ simulations }));

      expect(result.current.theme).toBe('dark');
      expect(result.current.activeHost).toBe('chatgpt');
    });

    it('restores a stored device preset', () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ devicePreset: 'ipad' }));

      const { result } = renderHook(() => useInspectorState({ simulations }));

      expect(result.current.devicePreset).toBe('ipad');
      expect(result.current.displayMode).toBe('fullscreen');
      expect(result.current.screenWidth).toBe('tablet-l');
      expect(result.current.platform).toBe('mobile');
      expect(result.current.containerWidth).toBe(820);
      expect(result.current.containerHeight).toBe(1180);
    });

    it('skips persistence when autoRun=true (test fixture mode)', () => {
      window.history.replaceState({}, '', '/?autoRun=true');
      localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'light', activeHost: 'claude' }));

      const { result } = renderHook(() => useInspectorState({ simulations }));

      // autoRun mode ignores storage entirely.
      expect(result.current.theme).toBe('dark');
      expect(result.current.activeHost).toBe('chatgpt');
    });

    it('URL params take precedence over stored preferences', () => {
      window.history.replaceState({}, '', '/?theme=light&host=claude');
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ theme: 'dark', activeHost: 'chatgpt', locale: 'fr-FR' })
      );

      const { result } = renderHook(() => useInspectorState({ simulations }));

      expect(result.current.theme).toBe('light');
      expect(result.current.activeHost).toBe('claude');
      // Storage still wins for fields not in the URL.
      expect(result.current.locale).toBe('fr-FR');
    });

    it('persists sidebar width changes', () => {
      const { result } = renderHook(() => useInspectorState({ simulations }));

      act(() => {
        result.current.setSidebarWidth(360);
        result.current.setRightSidebarWidth(390);
      });

      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
      expect(prefs.sidebarWidth).toBe(360);
      expect(prefs.rightSidebarWidth).toBe(390);
    });

    it('persists device preset changes', () => {
      const { result } = renderHook(() => useInspectorState({ simulations }));

      act(() => {
        result.current.applyDevicePreset('iphone-se');
      });

      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
      expect(prefs.devicePreset).toBe('iphone-se');
      expect(prefs.displayMode).toBe('fullscreen');
      expect(prefs.containerWidth).toBe(375);
      expect(prefs.containerHeight).toBe(667);
    });

    it('persists the rest of the configured host-context values without dropping inspector prefs', () => {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({ modelProvider: 'openai', modelId: 'gpt-test', prodResources: true })
      );
      const { result } = renderHook(() => useInspectorState({ simulations }));

      act(() => {
        result.current.setContainerHeight(512);
        result.current.setContainerWidth(768);
        result.current.setTimeZone('Europe/London');
      });

      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<string, unknown>;
      expect(prefs.containerHeight).toBe(512);
      expect(prefs.containerWidth).toBe(768);
      expect(prefs.timeZone).toBe('Europe/London');
      expect(prefs.modelProvider).toBe('openai');
      expect(prefs.modelId).toBe('gpt-test');
      expect(prefs.prodResources).toBe(true);
    });
  });
});
