import { describe, expect, it, vi } from 'vitest';

// @ts-expect-error The live page object is shipped as JavaScript without a declaration file.
import { ChatGPTPage, CHATGPT_SELECTORS, CHATGPT_URLS } from '../../bin/lib/live/chatgpt-page.mjs';

function createLocator({
  visible = false,
  onClick,
}: { visible?: boolean; onClick?: () => void } = {}) {
  return {
    first() {
      return this;
    },
    isVisible: vi.fn().mockResolvedValue(visible),
    click: vi.fn(async () => onClick?.()),
    waitFor: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ChatGPTPage plugin navigation', () => {
  it('opens the Plugins page when refreshing an MCP server', async () => {
    const chatInput = createLocator();
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue(chatInput),
    };
    const hostPage = new ChatGPTPage(page);

    vi.spyOn(hostPage, '_findAndClickRefresh').mockResolvedValue(true);
    vi.spyOn(hostPage, '_waitForToast').mockResolvedValue({ hasError: false });

    await hostPage.refreshMcpServer({ appName: 'Acme Support' });

    expect(CHATGPT_URLS.plugins).toBe('https://chatgpt.com/plugins#settings/Plugins');
    expect(page.goto).toHaveBeenNthCalledWith(1, CHATGPT_URLS.plugins, {
      waitUntil: 'domcontentloaded',
    });
    expect(page.goto).toHaveBeenNthCalledWith(2, CHATGPT_URLS.base, {
      waitUntil: 'domcontentloaded',
    });
    expect(chatInput.waitFor).toHaveBeenCalledWith({ timeout: 10_000 });
  });

  it('selects the named app before clicking a visible refresh button', async () => {
    const clicks: string[] = [];
    const refresh = createLocator({ visible: true, onClick: () => clicks.push('refresh') });
    const reconnect = createLocator();
    const app = createLocator({ visible: true, onClick: () => clicks.push('app') });
    const missing = createLocator();
    const page = {
      locator: vi.fn((selector: string) => {
        if (selector === CHATGPT_SELECTORS.refreshButton) return refresh;
        if (selector === CHATGPT_SELECTORS.reconnectButton) return reconnect;
        throw new Error(`Unexpected selector: ${selector}`);
      }),
      getByText: vi.fn().mockReturnValue(app),
      getByRole: vi.fn().mockReturnValue(missing),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };
    const hostPage = new ChatGPTPage(page);

    await expect(hostPage._findAndClickRefresh('Acme "Support"')).resolves.toBe(true);

    expect(clicks).toEqual(['app', 'refresh']);
    expect(page.getByText).toHaveBeenCalledWith('Acme "Support"', { exact: true });
    expect(page.locator).toHaveBeenCalledTimes(2);
  });

  it('does not refresh a different plugin when the named app is missing', async () => {
    const refresh = createLocator({ visible: true });
    const missing = createLocator();
    const page = {
      locator: vi.fn((selector: string) => {
        if (selector === CHATGPT_SELECTORS.refreshButton) return refresh;
        if (selector === CHATGPT_SELECTORS.reconnectButton) return missing;
        throw new Error(`Unexpected selector: ${selector}`);
      }),
      getByText: vi.fn().mockReturnValue(missing),
      getByRole: vi.fn().mockReturnValue(missing),
    };
    const hostPage = new ChatGPTPage(page);

    await expect(hostPage._findAndClickRefresh('Acme Support')).resolves.toBe(false);

    expect(refresh.click).not.toHaveBeenCalled();
  });

  it('selects a plugin row whose accessible name includes its connection status', async () => {
    const refresh = createLocator({ visible: true });
    const pluginRow = createLocator({ visible: true });
    const missing = createLocator();
    const page = {
      locator: vi.fn((selector: string) => {
        if (selector === CHATGPT_SELECTORS.refreshButton) return refresh;
        if (selector === CHATGPT_SELECTORS.reconnectButton) return missing;
        throw new Error(`Unexpected selector: ${selector}`);
      }),
      getByText: vi.fn().mockReturnValue(missing),
      getByRole: vi.fn((role: string, options: { name: string | RegExp }) => {
        if (role === 'button' && options.name instanceof RegExp) return pluginRow;
        return missing;
      }),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };
    const hostPage = new ChatGPTPage(page);

    await expect(hostPage._findAndClickRefresh('host-inspector')).resolves.toBe(true);

    const rowName = page.getByRole.mock.calls.find(
      ([role, options]) => role === 'button' && options.name instanceof RegExp
    )?.[1].name as RegExp;
    expect(rowName.test('host-inspector Connected')).toBe(true);
    expect(rowName.test('OpenAI Developers Reconnect')).toBe(false);
    expect(pluginRow.click).toHaveBeenCalledOnce();
    expect(refresh.click).toHaveBeenCalledOnce();
  });

  it('explains the current setup flow when the app is missing', async () => {
    const createdByYou = createLocator();
    const buttons = {
      allTextContents: vi.fn().mockResolvedValue([]),
    };
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn((selector: string) => {
        if (selector === CHATGPT_SELECTORS.createdByYou) return createdByYou;
        if (selector === 'button') return buttons;
        throw new Error(`Unexpected selector: ${selector}`);
      }),
    };
    const hostPage = new ChatGPTPage(page);

    vi.spyOn(hostPage, '_findAndClickRefresh').mockResolvedValue(false);

    await expect(hostPage.refreshMcpServer({ appName: 'Acme Support' })).rejects.toThrow(
      'Settings > Security and login > Developer mode, then add the app from Plugins > +.'
    );
  });
});
