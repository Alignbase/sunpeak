import type { McpUiHostCapabilities } from '@modelcontextprotocol/ext-apps';
import { registerHostShell } from '../inspector/hosts';
import { DEFAULT_STYLE_VARIABLES } from '../inspector/host-styles';
import { Conversation } from './chatgpt-conversation';

/**
 * ChatGPT host version info — matches what ChatGPT reports via the MCP protocol.
 * Verified against production ChatGPT on 2026-08-18.
 */
const CHATGPT_HOST_INFO = {
  name: 'chatgpt',
  version: '0.0.1',
};

const CHATGPT_HOST_CAPABILITIES: McpUiHostCapabilities = {
  openLinks: {},
  serverTools: {},
  serverResources: {},
  logging: {},
  updateModelContext: {},
  message: {},
  sandbox: {
    permissions: {
      microphone: {},
    },
  },
};

/**
 * Apply ChatGPT-style theming to the document.
 * Sets data-theme attribute and color-scheme for light-dark() CSS support.
 */
function applyChatGPTTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
}

/**
 * ChatGPT style variable overrides.
 * Verified against production ChatGPT on 2026-08-18.
 *
 * Only overrides values that differ from DEFAULT_STYLE_VARIABLES. In light
 * mode ChatGPT omits the state background and border variables, so their
 * light values retain the framework defaults while their dark values match
 * the values ChatGPT sends.
 */
const CHATGPT_STYLE_VARIABLES = {
  ...DEFAULT_STYLE_VARIABLES,

  // ── Background colors ──
  '--color-background-primary': 'light-dark(#fff, #212121)',
  '--color-background-secondary': 'light-dark(#f9f9f9, #181818)',
  '--color-background-tertiary': 'light-dark(#f3f3f3, #131313)',
  '--color-background-inverse': 'light-dark(#181818, #f3f3f3)',
  '--color-background-ghost':
    'light-dark(color-mix(in oklab,#0d0d0d 0.0%,transparent), color-mix(in oklab,#fff 0.0%,transparent))',
  '--color-background-info': 'light-dark(#eff6ff, #0285ff21)',
  '--color-background-danger': 'light-dark(#fef2f2, #fa423e29)',
  '--color-background-success': 'light-dark(#f0fdf4, #04b84c26)',
  '--color-background-warning': 'light-dark(#fefce8, #fb6a2229)',
  '--color-background-disabled':
    'light-dark(color-mix(in oklab,#0d0d0d 5.0%,transparent), color-mix(in oklab,#fff 5.0%,transparent))',

  // ── Text colors ──
  '--color-text-primary': 'light-dark(#0d0d0d, #fff)',
  '--color-text-secondary': 'light-dark(#5d5d5d, #cdcdcd)',
  '--color-text-tertiary': '#8f8f8f',
  '--color-text-inverse': 'light-dark(#fff, #0d0d0d)',
  '--color-text-ghost': 'light-dark(#0d0d0d, #fff)',
  '--color-text-info': 'light-dark(#3a83f7, #539af8)',
  '--color-text-danger': 'light-dark(#fa423e, #ff6764)',
  '--color-text-success': 'light-dark(#2c6732, #53b559)',
  '--color-text-warning': 'light-dark(#87401d, #d25e28)',
  '--color-text-disabled': 'light-dark(#8f8f8f, #5d5d5d)',

  // ── Border colors ──
  '--color-border-primary':
    'light-dark(color-mix(in oklab,#0d0d0d 10.0%,transparent), color-mix(in oklab,#fff 12.0%,transparent))',
  '--color-border-secondary':
    'light-dark(color-mix(in oklab,#0d0d0d 5.0%,transparent), color-mix(in oklab,#fff 6.0%,transparent))',
  '--color-border-tertiary':
    'light-dark(color-mix(in oklab,#0d0d0d 15%,transparent), color-mix(in oklab,#fff 20.0%,transparent))',
  '--color-border-inverse': 'light-dark(#fff, #0d0d0d)',
  '--color-border-ghost':
    'light-dark(color-mix(in oklab,#0d0d0d 0.0%,transparent), color-mix(in oklab,#fff 0.0%,transparent))',
  '--color-border-info': 'light-dark(#93c5fd, #0285ff21)',
  '--color-border-danger': 'light-dark(#fca5a5, #fa423e29)',
  '--color-border-success': 'light-dark(#86efac, #04b84c26)',
  '--color-border-warning': 'light-dark(#fde047, #fb6a2229)',
  '--color-border-disabled':
    'light-dark(color-mix(in oklab,#0d0d0d 6.0%,transparent), color-mix(in oklab,#fff 6.0%,transparent))',

  // ── Ring colors ──
  '--color-ring-primary': 'light-dark(#2c67c5, #3a83f7)',
  '--color-ring-secondary': 'light-dark(#2c67c5, #3a83f7)',
  '--color-ring-inverse': 'light-dark(#2c67c5, #3a83f7)',
  '--color-ring-info': 'light-dark(#2c67c5, #3a83f7)',
  '--color-ring-danger': '#ff8583',
  '--color-ring-success': 'light-dark(#2c67c5, #3a83f7)',
  '--color-ring-warning': 'light-dark(#2c67c5, #3a83f7)',

  // ── Typography ──
  '--font-sans':
    '"ui-sans-serif", "-apple-system", "system-ui", "Segoe UI", "Helvetica", "Apple Color Emoji", "Arial", "sans-serif", "Segoe UI Emoji", "Segoe UI Symbol"',
  '--font-mono':
    '"ui-monospace", "SFMono-Regular", "SF Mono", "Menlo", "Consolas", "Liberation Mono", "monospace"',
  '--font-heading-xs-size': '1rem',
  '--font-heading-sm-size': '1.125rem',
  '--font-heading-md-size': '1.25rem',
  '--font-heading-lg-size': '1.5rem',
  '--font-heading-xl-size': '2rem',
  '--font-heading-2xl-size': '2.25rem',
  '--font-heading-3xl-size': '3rem',
  '--font-text-xs-line-height': '1.125rem',
  '--font-text-sm-line-height': '1.25rem',
  '--font-text-md-line-height': '1.5rem',
  '--font-text-lg-line-height': '1.8125rem',
  '--font-heading-xs-line-height': '1.5rem',
  '--font-heading-sm-line-height': '1.625rem',
  '--font-heading-md-line-height': '1.625rem',
  '--font-heading-lg-line-height': '1.75rem',
  '--font-heading-xl-line-height': '2.375rem',
  '--font-heading-2xl-line-height': '2.625rem',
  '--font-heading-3xl-line-height': '3rem',

  // ── Shape and shadow ──
  '--border-radius-xs': '.25rem',
  '--border-radius-sm': '.375rem',
  '--border-radius-md': '.5rem',
  '--border-radius-lg': '.625rem',
  '--shadow-hairline': 'light-dark(0 0 0 1px #00000014, 0 0 0 1px #ffffff1a)',
  '--shadow-sm': 'light-dark(0 1px 2px -1px rgb(0 0 0 / .08), 0 1px 2px -1px rgb(0 0 0 / .2))',
  '--shadow-md': 'light-dark(0 2px 4px -1px rgb(0 0 0 / .08), 0 2px 4px -1px rgb(0 0 0 / .2))',
  '--shadow-lg': 'light-dark(0 4px 8px -2px rgb(0 0 0 / .1), 0 4px 8px -2px rgb(0 0 0 / .36))',
};

registerHostShell({
  id: 'chatgpt',
  label: 'ChatGPT',
  Conversation,
  applyTheme: applyChatGPTTheme,
  hostInfo: CHATGPT_HOST_INFO,
  hostCapabilities: CHATGPT_HOST_CAPABILITIES,
  userAgent: 'chatgpt',
  styleVariables: CHATGPT_STYLE_VARIABLES,
  safeAreaByDisplayMode: {
    inline: {},
    fullscreen: { bottom: 92 },
    pip: {},
  },
  pageStyles: {
    '--sim-bg-sidebar': 'light-dark(rgb(252, 252, 252), rgb(0, 0, 0))',
    '--sim-bg-conversation': 'light-dark(rgb(252, 252, 252), rgb(0, 0, 0))',
    '--sim-bg-user-bubble': 'light-dark(rgb(232, 243, 254), rgb(23, 62, 118))',
    '--sim-text-user-bubble': 'light-dark(rgb(12, 39, 74), rgb(246, 250, 254))',
    '--sim-bg-reply-input': 'light-dark(rgb(255, 255, 255), rgb(33, 33, 33))',
  },
});
