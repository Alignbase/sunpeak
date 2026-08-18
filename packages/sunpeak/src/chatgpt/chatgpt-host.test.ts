import { describe, expect, it } from 'vitest';
import { getHostShell } from '../inspector/hosts';
import './chatgpt-host';

describe('ChatGPT host shell', () => {
  it('matches the latest production host palette and safe area', () => {
    const shell = getHostShell('chatgpt');

    expect(shell?.pageStyles).toMatchObject({
      '--sim-bg-conversation': 'light-dark(rgb(252, 252, 252), rgb(0, 0, 0))',
      '--sim-bg-user-bubble': 'light-dark(rgb(232, 243, 254), rgb(23, 62, 118))',
      '--sim-text-user-bubble': 'light-dark(rgb(12, 39, 74), rgb(246, 250, 254))',
      '--sim-bg-reply-input': 'light-dark(rgb(255, 255, 255), rgb(33, 33, 33))',
    });
    expect(shell?.safeAreaByDisplayMode?.fullscreen).toEqual({ bottom: 92 });
    expect(shell?.styleVariables?.['--color-background-primary']).toBe('light-dark(#fff, #212121)');
  });
});
