import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { Inspector, type InspectorModelChatRequest } from './inspector';
import type { Simulation } from '../types/simulation';

// Mock fetch for useMcpConnection
let fetchSpy: ReturnType<typeof vi.spyOn>;
const PREFS_KEY = 'sunpeak-inspector-prefs';

beforeEach(() => {
  localStorage.clear();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  // Default: health check succeeds
  fetchSpy.mockResolvedValue(new Response('{"tools":[]}', { status: 200 }));
});

afterEach(() => {
  fetchSpy.mockRestore();
  window.history.replaceState(null, '', '/');
  document.documentElement.style.backgroundColor = '';
  document.documentElement.style.colorScheme = '';
  document.body.style.backgroundColor = '';
});

/**
 * Create a minimal Simulation for testing.
 */
function createSim(overrides: Partial<Simulation> = {}): Simulation {
  return {
    name: 'test-tool',
    tool: { name: 'test-tool', inputSchema: { type: 'object' } },
    resource: { uri: 'test://resource', name: 'test-resource', mimeType: 'text/html' },
    resourceUrl: '/test-resource.html',
    ...overrides,
  };
}

describe('Inspector', () => {
  describe('Standalone page chrome', () => {
    it('sets the document background to the conversation background in dark mode', () => {
      window.history.replaceState(null, '', '/?theme=dark');

      const { unmount } = render(<Inspector simulations={{ test: createSim() }} />);

      expect(document.documentElement.style.backgroundColor).toBe('rgb(0, 0, 0)');
      expect(document.body.style.backgroundColor).toBe('rgb(0, 0, 0)');

      unmount();
    });
  });

  describe('Tool dropdown', () => {
    it('shows Tool dropdown when tools exist', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      expect(screen.getByTestId('tool-selector')).toBeInTheDocument();
    });

    it('does not show Tool dropdown when no tools exist', () => {
      render(<Inspector simulations={{}} />);

      expect(screen.queryByTestId('tool-selector')).not.toBeInTheDocument();
    });

    it('deduplicates tools by name', () => {
      render(
        <Inspector
          simulations={{
            'sim-a': createSim({
              name: 'sim-a',
              tool: { name: 'my-tool', inputSchema: { type: 'object' } },
            }),
            'sim-b': createSim({
              name: 'sim-b',
              tool: { name: 'my-tool', inputSchema: { type: 'object' } },
              toolResult: { content: [], structuredContent: { variant: 'b' } },
            }),
          }}
          onCallTool={vi.fn()}
        />
      );

      // Should show one tool entry, not two
      const toolOptions = screen.getAllByRole('option').filter((o) => o.textContent === 'my-tool');
      expect(toolOptions).toHaveLength(1);
    });

    it('includes backend-only tools (no resource)', () => {
      render(
        <Inspector
          simulations={{
            'backend-tool': createSim({
              name: 'backend-tool',
              tool: { name: 'backend-tool', inputSchema: { type: 'object' } },
              resource: undefined,
              resourceUrl: undefined,
            }),
            'ui-tool': createSim(),
          }}
          onCallTool={vi.fn()}
        />
      );

      const allOptions = screen.getAllByRole('option');
      const backendOption = allOptions.find((o) => o.textContent?.includes('backend-tool'));
      expect(backendOption).toBeDefined();
      const toolSelect = screen.getByTestId('tool-selector').querySelector('select')!;
      expect(toolSelect.value).toBe('test-tool');
      expect(screen.queryByText('Tool does not render a UI')).not.toBeInTheDocument();
    });
  });

  describe('Simulation dropdown', () => {
    it('shows Simulation dropdown with fixture options when fixtures exist', () => {
      render(
        <Inspector
          simulations={{
            test: createSim({
              toolResult: { content: [], structuredContent: { data: 'mock' } },
            }),
          }}
          onCallTool={vi.fn()}
        />
      );

      const simSelector = screen.getByTestId('simulation-selector');
      expect(simSelector).toBeInTheDocument();
      // Should have "None (call server)" + the fixture
      const options = simSelector.querySelectorAll('option');
      expect(options.length).toBeGreaterThan(1);
    });

    it('shows Simulation dropdown with only "None" when no fixtures exist', () => {
      render(
        <Inspector
          simulations={{
            test: createSim(), // No toolInput, toolResult, or serverTools
          }}
          onCallTool={vi.fn()}
        />
      );

      const simSelector = screen.getByTestId('simulation-selector');
      expect(simSelector).toBeInTheDocument();
      // Should only have "None"
      const options = simSelector.querySelectorAll('option');
      expect(options).toHaveLength(1);
      expect(options[0].textContent).toBe('None');
    });

    it('makes "Simulation" label a link to docs when no fixtures exist', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      const link = screen
        .getByTestId('simulation-selector')
        .closest('[data-testid]')
        ?.querySelector('a[href*="simulations"]');
      expect(link).toBeInTheDocument();
    });

    it('includes "None (call server)" option in simulation dropdown', () => {
      render(
        <Inspector
          simulations={{
            test: createSim({
              toolResult: { content: [], structuredContent: { mock: true } },
            }),
          }}
          onCallTool={vi.fn()}
        />
      );

      const noneOption = screen.getAllByRole('option').find((o) => o.textContent?.includes('None'));
      expect(noneOption).toBeDefined();
    });

    it('pre-populates mock data when simulation with toolResult is selected', () => {
      render(
        <Inspector
          simulations={{
            test: createSim({
              toolResult: { content: [], structuredContent: { data: 'mock' } },
            }),
          }}
          onCallTool={vi.fn()}
        />
      );

      const textarea = screen.getByTestId('tool-result-textarea') as HTMLTextAreaElement;
      expect(textarea.value).toContain('mock');
    });

    it('clears mock data when "None" is selected', async () => {
      const user = userEvent.setup();

      render(
        <Inspector
          simulations={{
            test: createSim({
              toolResult: { content: [], structuredContent: { data: 'mock' } },
            }),
          }}
          onCallTool={vi.fn()}
        />
      );

      // Initially has mock data
      expect((screen.getByTestId('tool-result-textarea') as HTMLTextAreaElement).value).toContain(
        'mock'
      );

      // Select "None (call server)"
      const simSelect = screen.getByTestId('simulation-selector')!.querySelector('select')!;
      await user.selectOptions(simSelect, '__none__');

      // Mock data should be cleared
      await waitFor(() => {
        expect((screen.getByTestId('tool-result-textarea') as HTMLTextAreaElement).value).toBe('');
      });
    });
  });

  describe('Run button', () => {
    it('shows Run button when a tool is selected and onCallTool is provided', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
    });

    it('does not show Run button when no tools exist', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }));

      render(
        <Inspector simulations={{}} mcpServerUrl="http://localhost:8000/mcp" onCallTool={vi.fn()} />
      );

      await waitFor(() => {
        expect(screen.getByTestId('connection-status')).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument();
    });

    it('calls onCallTool when Run is clicked', async () => {
      const user = userEvent.setup();
      const onCallTool = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'real result' }],
      });

      render(<Inspector simulations={{ test: createSim() }} onCallTool={onCallTool} />);

      await user.click(screen.getByRole('button', { name: /run/i }));

      await waitFor(() => {
        expect(onCallTool).toHaveBeenCalledWith({
          name: 'test-tool',
          arguments: expect.any(Object),
        });
      });
    });

    it('hides Run button when a simulation with fixture data is selected', () => {
      render(
        <Inspector
          simulations={{
            test: createSim({
              toolResult: { content: [], structuredContent: { mocked: true } },
            }),
          }}
          onCallTool={vi.fn()}
        />
      );

      // Simulation with toolResult is auto-selected → Run button hidden
      expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument();
    });

    it('shows Run button after selecting "None" from simulation dropdown', async () => {
      const user = userEvent.setup();

      render(
        <Inspector
          simulations={{
            test: createSim({
              toolResult: { content: [], structuredContent: { mocked: true } },
            }),
          }}
          onCallTool={vi.fn()}
        />
      );

      // Initially hidden (simulation with fixture selected)
      expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument();

      // Select "None (call server)"
      const simSelect = screen.getByTestId('simulation-selector').querySelector('select')!;
      await user.selectOptions(simSelect, '__none__');

      // Run button should now be visible
      expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
    });
  });

  describe('Prod Resources', () => {
    it('shows Prod Resources checkbox when hideInspectorModes is false', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      const prodResourcesCheckbox = screen.getByRole('checkbox', { name: /prod resources/i });
      expect(prodResourcesCheckbox).toBeInTheDocument();
      expect(prodResourcesCheckbox.closest('header')).not.toBeInTheDocument();
      expect(
        screen
          .getByRole('link', { name: /Load resources from dist\/ builds instead of HMR/i })
          .closest('header')
      ).not.toBeInTheDocument();
      expect(
        screen
          .getByRole('link', { name: /Load resources from dist\/ builds instead of HMR/i })
          .closest('label')
      ).not.toBeInTheDocument();
    });

    it('hides Prod Resources checkbox when hideInspectorModes is true', () => {
      render(
        <Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} hideInspectorModes />
      );

      expect(screen.queryByRole('checkbox', { name: /prod resources/i })).not.toBeInTheDocument();
    });
  });

  describe('Demo mode', () => {
    it('shows a static example URL in a disabled input', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} demoMode />);

      const input = screen.getByDisplayValue('http://localhost:8000/mcp');
      expect(input).toBeDisabled();
    });

    it('hides connection status indicator', () => {
      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
          demoMode
        />
      );

      expect(screen.queryByTestId('connection-status')).not.toBeInTheDocument();
    });

    it('hides Prod Resources checkbox', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} demoMode />);

      expect(screen.queryByRole('checkbox', { name: /prod resources/i })).not.toBeInTheDocument();
    });

    it('hides Run button even when no simulation is active', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} demoMode />);

      // Without demoMode this would show the Run button (no fixture data = no active sim)
      expect(screen.queryByRole('button', { name: /run/i })).not.toBeInTheDocument();
    });

    it('hides "None (call server)" option from simulation dropdown', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} demoMode />);

      const simSelect = screen.getByTestId('simulation-selector').querySelector('select')!;
      const options = Array.from(simSelect.options).map((o) => o.textContent);
      expect(options).not.toContain('None (call server)');
      expect(options).not.toContain('None');
    });

    it('still renders simulation content normally', () => {
      render(
        <Inspector
          simulations={{
            test: createSim({
              toolResult: { content: [], structuredContent: { demo: true } },
            }),
          }}
          demoMode
        />
      );

      // Tool Result section should be present with mock data
      expect(screen.getByTestId('tool-result-section')).toBeInTheDocument();
    });
  });

  describe('Authentication', () => {
    const openAuthentication = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: /^Authentication/ }));
      return screen.getByText('Authentication').closest('[class*="space-y"]')!;
    };

    const openOAuthSettings = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: /^OAuth settings/ }));
    };

    it('shows Authentication collapsed with a status summary when not in demo mode', async () => {
      const user = userEvent.setup();
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      expect(screen.getByText('Authentication')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Authentication None/ })).toBeInTheDocument();
      expect(
        screen.getByText('Authentication').closest('[class*="space-y"]')!.querySelector('select')
      ).toBeNull();
      const authSection = await openAuthentication(user);
      expect(authSection.querySelector('select')).toHaveDisplayValue('None');
    });

    it('hides Authentication section in demo mode', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} demoMode />);

      expect(screen.queryByText('Authentication')).not.toBeInTheDocument();
    });

    it('shows auth type selector with None, Bearer Token, and OAuth options', async () => {
      const user = userEvent.setup();
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      const authSection = await openAuthentication(user);
      const authSelect = authSection.querySelector('select')!;
      const options = Array.from(authSelect.options).map((o) => o.textContent);
      expect(options).toContain('None');
      expect(options).toContain('Bearer Token');
      expect(options).toContain('OAuth');
    });

    it('shows password-masked input when Bearer Token is selected', async () => {
      const user = userEvent.setup();
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      const authSection = await openAuthentication(user);
      const authSelect = authSection.querySelector('select')!;
      await user.selectOptions(authSelect, 'bearer');

      // Should show a password input
      const tokenInput = screen.getByPlaceholderText('Paste your token');
      expect(tokenInput).toHaveAttribute('type', 'password');
    });

    it('shows generic OAuth registration inputs when OAuth is selected', async () => {
      const user = userEvent.setup();
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      const authSection = await openAuthentication(user);
      const authSelect = authSection.querySelector('select')!;
      await user.selectOptions(authSelect, 'oauth');

      expect(screen.getByRole('button', { name: 'Authorize' })).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Scopes (optional)')).not.toBeInTheDocument();
      await openOAuthSettings(user);
      expect(screen.getByPlaceholderText('Scopes (optional)')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Client ID (optional)')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Client metadata URL (optional)')).toBeInTheDocument();
    });

    it('expands Authentication when a tool requests OAuth', async () => {
      const user = userEvent.setup();
      const onCallTool = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Authorization required' }],
        _meta: { _sunpeak: { oauthRequired: true } },
      });
      render(<Inspector simulations={{ test: createSim() }} onCallTool={onCallTool} />);

      expect(
        screen.getByText('Authentication').closest('[class*="space-y"]')!.querySelector('select')
      ).toBeNull();
      await user.click(screen.getByRole('button', { name: /run/i }));

      await waitFor(() => {
        expect(screen.getByDisplayValue('OAuth')).toBeInTheDocument();
        expect(screen.getByText(/Additional authorization is required/)).toBeInTheDocument();
      });
    });

    it('sends a URL-based OAuth client ID when provided', async () => {
      const user = userEvent.setup();
      const popup = { close: vi.fn(), closed: false, location: { href: '' } };
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

      fetchSpy
        .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'Stopped for test' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          })
        );

      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );

      const authSection = await openAuthentication(user);
      await user.selectOptions(authSection.querySelector('select')!, 'oauth');
      await openOAuthSettings(user);
      await user.type(
        screen.getByPlaceholderText('Client metadata URL (optional)'),
        'https://client.example.com/oauth/metadata.json'
      );
      await user.tab();
      await user.click(screen.getByRole('button', { name: 'Authorize' }));

      await waitFor(() => {
        const startCall = fetchSpy.mock.calls.find((call: unknown[]) =>
          String(call[0]).includes('/__sunpeak/oauth/start')
        );
        expect(startCall).toBeDefined();
        expect(JSON.parse(String(startCall?.[1]?.body))).toMatchObject({
          clientMetadataUrl: 'https://client.example.com/oauth/metadata.json',
        });
      });
      openSpy.mockRestore();
    });

    it('sends the selected confidential-client authentication method', async () => {
      const user = userEvent.setup();
      const popup = { close: vi.fn(), closed: false, location: { href: '' } };
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
      fetchSpy
        .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'Stopped for test' }), { status: 400 })
        );

      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );
      const authSection = await openAuthentication(user);
      await user.selectOptions(authSection.querySelector('select')!, 'oauth');
      await openOAuthSettings(user);
      await user.type(screen.getByPlaceholderText('Client ID (optional)'), 'registered-client');
      await user.tab();
      await user.type(screen.getByPlaceholderText('Client Secret (optional)'), 'secret');
      await user.selectOptions(screen.getByDisplayValue('Client auth: Auto'), 'client_secret_post');
      await user.click(screen.getByRole('button', { name: 'Authorize' }));

      await waitFor(() => {
        const startCall = fetchSpy.mock.calls.find((call: unknown[]) =>
          String(call[0]).includes('/__sunpeak/oauth/start')
        );
        expect(JSON.parse(String(startCall?.[1]?.body))).toMatchObject({
          clientId: 'registered-client',
          clientSecret: 'secret',
          tokenEndpointAuthMethod: 'client_secret_post',
        });
      });
      openSpy.mockRestore();
    });

    it('prompts for an authorization server when the resource advertises several', async () => {
      const user = userEvent.setup();
      const popup = { close: vi.fn(), closed: false, location: { href: '' } };
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
      fetchSpy
        .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              status: 'authorization_server_required',
              authorizationServers: [
                'https://auth-one.example.com',
                'https://auth-two.example.com',
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'Stopped for test' }), { status: 400 })
        );

      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );
      const authSection = await openAuthentication(user);
      await user.selectOptions(authSection.querySelector('select')!, 'oauth');
      await user.click(screen.getByRole('button', { name: 'Authorize' }));

      const issuerSelect = await screen.findByDisplayValue('https://auth-one.example.com');
      await user.selectOptions(issuerSelect, 'https://auth-two.example.com');
      await user.click(screen.getByRole('button', { name: 'Authorize' }));

      await waitFor(() => {
        const startCalls = fetchSpy.mock.calls.filter((call: unknown[]) =>
          String(call[0]).includes('/__sunpeak/oauth/start')
        );
        expect(startCalls).toHaveLength(2);
        expect(JSON.parse(String(startCalls[1][1]?.body))).toMatchObject({
          authorizationServer: 'https://auth-two.example.com',
        });
      });
      openSpy.mockRestore();
    });

    it('clears cached OAuth authorization from the inspector', async () => {
      const user = userEvent.setup();
      const popup = { close: vi.fn(), closed: false, location: { href: '' } };
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
      fetchSpy
        .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'authorized', simulations: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'cleared' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );

      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );
      const authSection = await openAuthentication(user);
      await user.selectOptions(authSection.querySelector('select')!, 'oauth');
      await user.click(screen.getByRole('button', { name: 'Authorize' }));
      await user.click(await screen.findByRole('button', { name: 'Clear local authorization' }));

      await waitFor(() => {
        expect(
          fetchSpy.mock.calls.some((call: unknown[]) =>
            String(call[0]).includes('/__sunpeak/oauth/reset')
          )
        ).toBe(true);
        expect(screen.getByRole('button', { name: 'Authorize' })).toBeInTheDocument();
      });
      openSpy.mockRestore();
    });

    it('surfaces a clear error when OAuth start returns non-JSON', async () => {
      const user = userEvent.setup();
      const popup = { close: vi.fn(), closed: false, location: { href: '' } };
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

      fetchSpy
        .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response('Fractal ChatGPT App MCP Server. Connect to /mcp', {
            status: 200,
            headers: { 'Content-Type': 'text/plain' },
          })
        );

      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );

      const authSection = await openAuthentication(user);
      const authSelect = authSection.querySelector('select')!;
      await user.selectOptions(authSelect, 'oauth');
      await user.click(screen.getByRole('button', { name: 'Authorize' }));

      await waitFor(() => {
        expect(
          screen.getByText(/Expected JSON from \/__sunpeak\/oauth\/start/)
        ).toBeInTheDocument();
      });
      expect(popup.close).toHaveBeenCalled();

      openSpy.mockRestore();
    });

    it('uses inspectorApiBaseUrl for OAuth start requests', async () => {
      const user = userEvent.setup();
      const popup = { close: vi.fn(), closed: false, location: { href: '' } };
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

      fetchSpy
        .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'No auth configured' }), { status: 400 })
        );

      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          inspectorApiBaseUrl="https://preview.example/api"
          onCallTool={vi.fn()}
        />
      );

      const authSection = await openAuthentication(user);
      const authSelect = authSection.querySelector('select')!;
      await user.selectOptions(authSelect, 'oauth');
      await user.click(screen.getByRole('button', { name: 'Authorize' }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          'https://preview.example/api/__sunpeak/oauth/start',
          expect.objectContaining({ method: 'POST' })
        );
      });

      openSpy.mockRestore();
    });

    it('severs the OAuth popup opener before navigating to remote authorization', async () => {
      const user = userEvent.setup();
      const popup = {
        close: vi.fn(),
        closed: false,
        location: { href: '' },
        opener: window,
      };
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);

      fetchSpy
        .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              status: 'redirect',
              authUrl: 'https://auth.example.test/authorize?state=state-123',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }
          )
        );

      const { unmount } = render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );

      const authSection = await openAuthentication(user);
      const authSelect = authSection.querySelector('select')!;
      await user.selectOptions(authSelect, 'oauth');
      await user.click(screen.getByRole('button', { name: 'Authorize' }));

      await waitFor(() => {
        expect(popup.location.href).toBe('https://auth.example.test/authorize?state=state-123');
      });
      expect(popup.opener).toBeNull();

      unmount();
      openSpy.mockRestore();
    });

    it('ignores OAuth callback notifications from another flow', async () => {
      const user = userEvent.setup();
      const popup = {
        close: vi.fn(),
        closed: false,
        location: { href: '' },
        opener: window,
      };
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
      fetchSpy
        .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              status: 'redirect',
              authUrl: 'https://auth.example.test/authorize?state=expected-state',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );

      const { unmount } = render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );
      const authSection = await openAuthentication(user);
      await user.selectOptions(authSection.querySelector('select')!, 'oauth');
      await user.click(screen.getByRole('button', { name: 'Authorize' }));
      await waitFor(() => expect(popup.location.href).toContain('state=expected-state'));

      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: popup as unknown as WindowProxy,
          data: { type: 'sunpeak-oauth-callback', state: 'other-state', success: true },
        })
      );
      expect(
        screen.getByRole('button', { name: /Authentication OAuth · Authorizing/ })
      ).toBeInTheDocument();

      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: popup as unknown as WindowProxy,
          data: { type: 'sunpeak-oauth-callback', state: 'expected-state', success: true },
        })
      );
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: /Authentication OAuth · Authorized/ })
        ).toBeInTheDocument()
      );

      unmount();
      openSpy.mockRestore();
    });

    it('clears authorization-server choices when the MCP server URL changes', async () => {
      const user = userEvent.setup();
      const onCallTool = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Authorization required' }],
        _meta: {
          _sunpeak: {
            oauthRequired: true,
            authorizationServers: ['https://auth-one.example.com', 'https://auth-two.example.com'],
          },
        },
      });
      fetchSpy.mockResolvedValue(new Response('{"tools":[]}', { status: 200 }));

      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={onCallTool}
        />
      );
      await user.click(screen.getByRole('button', { name: /run/i }));
      expect(await screen.findByDisplayValue('https://auth-one.example.com')).toBeInTheDocument();

      const serverInput = screen.getByDisplayValue('http://localhost:8000/mcp');
      await user.clear(serverInput);
      await user.type(serverInput, 'http://localhost:9000/mcp');
      await user.tab();

      await waitFor(() => {
        expect(screen.queryByDisplayValue('https://auth-one.example.com')).not.toBeInTheDocument();
      });
    });

    it('reconnects with bearer token when token is entered', async () => {
      const user = userEvent.setup();

      fetchSpy
        .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
        .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }));

      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('connection-status')).toBeInTheDocument();
      });

      // Select Bearer Token
      const authSection = await openAuthentication(user);
      const authSelect = authSection.querySelector('select')!;
      await user.selectOptions(authSelect, 'bearer');

      // Enter a token and blur to apply
      const tokenInput = screen.getByPlaceholderText('Paste your token');
      await user.type(tokenInput, 'secret-token');
      await user.tab(); // blur

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          '/__sunpeak/connect',
          expect.objectContaining({
            body: expect.stringContaining('"bearerToken":"secret-token"'),
          })
        );
      });
    });
  });

  describe('MCP Server URL', () => {
    it('always shows MCP Server URL input', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      const serverUrlControl = screen.getByTestId('server-url');
      expect(serverUrlControl).toBeInTheDocument();
      expect(serverUrlControl.closest('header')).not.toBeInTheDocument();
    });

    it('pre-populates server URL from mcpServerUrl prop', async () => {
      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByDisplayValue('http://localhost:8000/mcp')).toBeInTheDocument();
      });
    });

    it('shows connection status indicator when URL is set', async () => {
      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );

      expect(screen.getByTestId('connection-status')).toBeInTheDocument();
    });
  });

  describe('Server reconnection', () => {
    it('updates simulations when reconnecting to a new server', async () => {
      const user = userEvent.setup();
      const newSimulations = {
        'new-tool-a': createSim({
          name: 'new-tool-a',
          tool: { name: 'new-tool-a', inputSchema: { type: 'object' } },
          resource: { uri: 'test://res-a', name: 'res-a', mimeType: 'text/html' },
          resourceUrl: '/res-a.html',
        }),
        'new-tool-b': createSim({
          name: 'new-tool-b',
          tool: { name: 'new-tool-b', inputSchema: { type: 'object' } },
          resource: { uri: 'test://res-b', name: 'res-b', mimeType: 'text/html' },
          resourceUrl: '/res-b.html',
        }),
      };

      fetchSpy
        .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'ok', simulations: newSimulations }), {
            status: 200,
          })
        );

      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('connection-status')).toBeInTheDocument();
      });

      const urlInput = screen.getByDisplayValue('http://localhost:8000/mcp');
      await user.clear(urlInput);
      await user.type(urlInput, 'http://localhost:9999/mcp{Enter}');

      await waitFor(() => {
        const allOptions = screen.getAllByRole('option');
        const newOption = allOptions.find((o) => o.textContent?.includes('new-tool-a'));
        expect(newOption).toBeDefined();
      });
    });

    it('shows error status and clears tools when reconnect fails', async () => {
      const user = userEvent.setup();

      fetchSpy
        .mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'Connection refused' }), { status: 500 })
        );

      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTestId('connection-status')).toBeInTheDocument();
      });

      const urlInput = screen.getByDisplayValue('http://localhost:8000/mcp');
      await user.clear(urlInput);
      await user.type(urlInput, 'http://bad-server:9999/mcp{Enter}');

      await waitFor(() => {
        const statusDot = screen.getByTestId('connection-status');
        expect(statusDot).toHaveAttribute('title', 'Connection refused');
      });

      expect(screen.getByText('Could not connect to MCP server')).toBeInTheDocument();
    });

    it('preserves initial simulations when initial health check fails', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('', { status: 500 }));

      render(
        <Inspector
          simulations={{ test: createSim() }}
          mcpServerUrl="http://localhost:8000/mcp"
          onCallTool={vi.fn()}
        />
      );

      await waitFor(() => {
        const statusDot = screen.getByTestId('connection-status');
        expect(statusDot).toHaveAttribute('title', expect.stringContaining('Health check failed'));
      });

      // Simulations from props should still be present
      expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
    });
  });

  describe('Empty state', () => {
    it('shows "Enter an MCP server URL" when no URL and no simulations', () => {
      render(<Inspector simulations={{}} />);
      expect(screen.getByText('Enter an MCP server URL to get started')).toBeInTheDocument();
    });

    it('shows "No tools found" when connected but no simulations', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('{"tools":[]}', { status: 200 }));

      render(
        <Inspector simulations={{}} mcpServerUrl="http://localhost:8000/mcp" onCallTool={vi.fn()} />
      );

      await waitFor(() => {
        expect(screen.getByText('No tools found on this server')).toBeInTheDocument();
      });
    });
  });

  describe('Tool Result visibility', () => {
    it('shows Tool Result section', () => {
      render(
        <Inspector
          simulations={{
            test: createSim({ toolResult: { content: [], structuredContent: { foo: 1 } } }),
          }}
        />
      );

      expect(screen.getByTestId('tool-result-section')).toBeInTheDocument();
    });

    it('runs backend-only tools and shows results in the sidebar without rendering UI', async () => {
      const onCallTool = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'backend ok' }],
        structuredContent: { status: 'ok' },
      });
      render(
        <Inspector
          simulations={{
            'backend-tool': createSim({
              name: 'backend-tool',
              tool: { name: 'backend-tool', inputSchema: { type: 'object' } },
              resource: undefined,
              resourceUrl: undefined,
            }),
          }}
          onCallTool={onCallTool}
        />
      );

      expect(screen.getByText('Tool does not render a UI')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: /run/i }));

      await waitFor(() => {
        expect(onCallTool).toHaveBeenCalledWith({ name: 'backend-tool', arguments: {} });
      });
      expect(screen.getByText('Tool does not render a UI')).toBeInTheDocument();
      expect((screen.getByTestId('tool-result-textarea') as HTMLTextAreaElement).value).toContain(
        'backend ok'
      );
    });

    it('loads backend-only simulation fixtures into the sidebar', () => {
      render(
        <Inspector
          simulations={{
            'backend-fixture': createSim({
              name: 'backend-fixture',
              tool: { name: 'backend-fixture', inputSchema: { type: 'object' } },
              resource: undefined,
              resourceUrl: undefined,
              toolInput: { query: 'pizza' },
              toolResult: {
                content: [{ type: 'text', text: 'fixture ok' }],
                structuredContent: { count: 3 },
              },
            }),
          }}
          onCallTool={vi.fn()}
        />
      );

      expect(screen.getByText('Tool does not render a UI')).toBeInTheDocument();
      expect((screen.getByTestId('tool-input-textarea') as HTMLTextAreaElement).value).toContain(
        'pizza'
      );
      expect((screen.getByTestId('tool-result-textarea') as HTMLTextAreaElement).value).toContain(
        'fixture ok'
      );
    });
  });

  // ── Story 1: Framework user (sunpeak dev) ──
  describe('Framework: multi-tool workflow', () => {
    const multiToolSims = {
      'albums-default': createSim({
        name: 'albums-default',
        tool: { name: 'show-albums', inputSchema: { type: 'object' } },
        resource: { uri: 'test://albums', name: 'albums', mimeType: 'text/html' },
        resourceUrl: '/albums.html',
        toolInput: { category: 'food' },
        toolResult: { content: [], structuredContent: { albums: ['A'] } },
      }),
      'albums-empty': createSim({
        name: 'albums-empty',
        tool: { name: 'show-albums', inputSchema: { type: 'object' } },
        resource: { uri: 'test://albums', name: 'albums', mimeType: 'text/html' },
        resourceUrl: '/albums.html',
        toolInput: { category: 'none' },
        toolResult: { content: [], structuredContent: { albums: [] } },
      }),
      'map-default': createSim({
        name: 'map-default',
        tool: { name: 'show-map', inputSchema: { type: 'object' } },
        resource: { uri: 'test://map', name: 'map', mimeType: 'text/html' },
        resourceUrl: '/map.html',
        toolInput: { location: 'NYC' },
        toolResult: { content: [], structuredContent: { pins: [1] } },
      }),
    };

    it('switching tools updates the simulation dropdown', () => {
      render(<Inspector simulations={multiToolSims} onCallTool={vi.fn()} />);

      // albums tool selected by default (alphabetical) — should have 2 fixture sims
      const simSelector = screen.getByTestId('simulation-selector');
      const simOptions = simSelector.querySelectorAll('option');
      // "None" + "albums-default" + "albums-empty" = 3
      expect(simOptions).toHaveLength(3);

      // Switch to map tool
      const toolSelect = screen.getByTestId('tool-selector').querySelector('select')!;
      fireEvent.change(toolSelect, { target: { value: 'show-map' } });

      // Simulation dropdown should now show map's fixtures
      const updatedSimOptions = screen
        .getByTestId('simulation-selector')
        .querySelectorAll('option');
      // "None" + "map-default" = 2
      expect(updatedSimOptions).toHaveLength(2);
    });

    it('switching simulations updates tool result', async () => {
      const user = userEvent.setup();

      render(<Inspector simulations={multiToolSims} onCallTool={vi.fn()} />);

      const resultTextarea = screen.getByTestId('tool-result-textarea') as HTMLTextAreaElement;

      // First fixture auto-selected (albums-default) — should have its mock data
      expect(resultTextarea.value).toContain('"albums"');

      // Switch to albums-empty simulation
      const simSelect = screen.getByTestId('simulation-selector').querySelector('select')!;
      await user.selectOptions(simSelect, 'albums-empty');

      // Tool result should update to the empty simulation's data
      await waitFor(() => {
        expect(resultTextarea.value).toContain('"albums": []');
      });
    });

    it('switching simulations refreshes app context', async () => {
      const user = userEvent.setup();

      render(<Inspector simulations={multiToolSims} onCallTool={vi.fn()} />);

      const appContextTextarea = screen.getByTestId('app-context-textarea') as HTMLTextAreaElement;
      fireEvent.change(appContextTextarea, {
        target: { value: '{"selectedAlbum":"Pizza Tour"}' },
      });
      fireEvent.blur(appContextTextarea);
      expect(appContextTextarea.value).toContain('Pizza Tour');

      const simSelect = screen.getByTestId('simulation-selector').querySelector('select')!;
      await user.selectOptions(simSelect, 'albums-empty');

      await waitFor(() => {
        expect(appContextTextarea.value).toBe('null');
      });
    });

    it('selecting no simulation refreshes app context', async () => {
      const user = userEvent.setup();

      render(<Inspector simulations={multiToolSims} onCallTool={vi.fn()} />);

      const appContextTextarea = screen.getByTestId('app-context-textarea') as HTMLTextAreaElement;
      fireEvent.change(appContextTextarea, {
        target: { value: '{"selectedAlbum":"Pizza Tour"}' },
      });
      fireEvent.blur(appContextTextarea);
      expect(appContextTextarea.value).toContain('Pizza Tour');

      const simSelect = screen.getByTestId('simulation-selector').querySelector('select')!;
      await user.selectOptions(simSelect, '__none__');

      await waitFor(() => {
        expect(appContextTextarea.value).toBe('null');
      });
    });

    it('switching simulations for the same tool does not show empty state', async () => {
      const user = userEvent.setup();

      render(<Inspector simulations={multiToolSims} onCallTool={vi.fn()} />);

      // albums-default is auto-selected — should show content (mock data), not "Press Run"
      expect(screen.queryByText(/Press.*Run/)).not.toBeInTheDocument();

      // Switch to albums-empty simulation (same tool, same resource)
      const simSelect = screen.getByTestId('simulation-selector').querySelector('select')!;
      await user.selectOptions(simSelect, 'albums-empty');

      // Should still show content (new mock data), NOT "Press Run" empty state.
      // This catches the bug where the iframe key included simulationName,
      // causing a full iframe remount and permanent "Loading..." state.
      await waitFor(() => {
        expect(screen.queryByText(/Press.*Run/)).not.toBeInTheDocument();
      });
    });

    it('switching simulations does not cause iframe remount when resource URL is the same', async () => {
      const user = userEvent.setup();

      const { container } = render(<Inspector simulations={multiToolSims} onCallTool={vi.fn()} />);

      // Get a reference to the outer iframe element (if rendered).
      // Since unit tests use srcdoc fallback, we check the iframe wrapper div.
      const getIframeWrapper = () => container.querySelector('[class*="h-full w-full"]');

      const initialWrapper = getIframeWrapper();

      // Switch to albums-empty simulation (same tool, same resource URL)
      const simSelect = screen.getByTestId('simulation-selector').querySelector('select')!;
      await user.selectOptions(simSelect, 'albums-empty');

      // The wrapper should be the same DOM node (no remount)
      await waitFor(() => {
        expect(getIframeWrapper()).toBe(initialWrapper);
      });
    });

    it('switching tools changes the Tool Result to the new tool fixture', async () => {
      const user = userEvent.setup();

      render(<Inspector simulations={multiToolSims} onCallTool={vi.fn()} />);

      const resultTextarea = screen.getByTestId('tool-result-textarea') as HTMLTextAreaElement;

      // Initially albums tool — has "albums" in the result
      expect(resultTextarea.value).toContain('"albums"');

      // Switch to map tool
      const toolSelect = screen.getByTestId('tool-selector').querySelector('select')!;
      await user.selectOptions(toolSelect, 'show-map');

      // Should now have map's mock data
      await waitFor(() => {
        expect(resultTextarea.value).toContain('"pins"');
      });
    });

    it('switching tools refreshes app context', async () => {
      const user = userEvent.setup();

      render(<Inspector simulations={multiToolSims} onCallTool={vi.fn()} />);

      const appContextTextarea = screen.getByTestId('app-context-textarea') as HTMLTextAreaElement;
      fireEvent.change(appContextTextarea, {
        target: { value: '{"selectedAlbum":"Pizza Tour"}' },
      });
      fireEvent.blur(appContextTextarea);
      expect(appContextTextarea.value).toContain('Pizza Tour');

      const toolSelect = screen.getByTestId('tool-selector').querySelector('select')!;
      await user.selectOptions(toolSelect, 'show-map');

      await waitFor(() => {
        expect(appContextTextarea.value).toBe('null');
      });
    });

    it('selecting "None" then selecting a simulation restores mock data', async () => {
      const user = userEvent.setup();

      render(<Inspector simulations={multiToolSims} onCallTool={vi.fn()} />);

      const resultTextarea = screen.getByTestId('tool-result-textarea') as HTMLTextAreaElement;

      // Initially has mock data from albums-default
      expect(resultTextarea.value).toContain('"albums"');

      // Select "None"
      const simSelect = screen.getByTestId('simulation-selector').querySelector('select')!;
      await user.selectOptions(simSelect, '__none__');

      await waitFor(() => {
        expect(resultTextarea.value).toBe('');
      });

      // Select albums-default again
      await user.selectOptions(simSelect, 'albums-default');

      // Mock data should be restored
      await waitFor(() => {
        expect(resultTextarea.value).toContain('"albums"');
      });
    });

    it('prefers onCallToolDirect over onCallTool when both provided', async () => {
      const user = userEvent.setup();
      const onCallTool = vi.fn();
      const onCallToolDirect = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'direct result' }],
      });

      render(
        <Inspector
          simulations={{ test: createSim() }}
          onCallTool={onCallTool}
          onCallToolDirect={onCallToolDirect}
        />
      );

      await user.click(screen.getByRole('button', { name: /run/i }));

      await waitFor(() => {
        expect(onCallToolDirect).toHaveBeenCalled();
      });
      expect(onCallTool).not.toHaveBeenCalled();
    });
  });

  describe('Run button timing', () => {
    it('does not leak _sunpeak timing into the tool result JSON textarea', async () => {
      const user = userEvent.setup();
      const onCallTool = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'timed result' }],
      });

      render(<Inspector simulations={{ test: createSim() }} onCallTool={onCallTool} />);

      await user.click(screen.getByRole('button', { name: /run/i }));

      await waitFor(() => {
        const textarea = screen.getByTestId('tool-result-textarea') as HTMLTextAreaElement;
        // The JSON textarea shows the clean result (no _sunpeak timing)
        expect(textarea.value).toContain('timed result');
        expect(textarea.value).not.toContain('requestTimeMs');
      });
    });

    it('shows tool result even when the handler throws', async () => {
      const user = userEvent.setup();
      const onCallTool = vi.fn().mockRejectedValue(new Error('boom'));

      render(<Inspector simulations={{ test: createSim() }} onCallTool={onCallTool} />);

      await user.click(screen.getByRole('button', { name: /run/i }));

      await waitFor(() => {
        const textarea = screen.getByTestId('tool-result-textarea') as HTMLTextAreaElement;
        expect(textarea.value).toContain('Error: boom');
      });
    });

    it('preserves existing _meta from tool result in the JSON textarea', async () => {
      const user = userEvent.setup();
      const onCallTool = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        _meta: { existing: 'value' },
      });

      render(<Inspector simulations={{ test: createSim() }} onCallTool={onCallTool} />);

      await user.click(screen.getByRole('button', { name: /run/i }));

      // The result textarea shows the original _meta (without _sunpeak)
      await waitFor(() => {
        const textarea = screen.getByTestId('tool-result-textarea') as HTMLTextAreaElement;
        expect(textarea.value).toContain('"existing"');
      });
    });
  });

  describe('Tool result data element', () => {
    it('renders __tool-result script element with simulation data', () => {
      const sim = createSim({
        toolResult: { content: [{ type: 'text', text: 'hello' }], structuredContent: { v: 1 } },
      });
      render(<Inspector simulations={{ test: sim }} />);

      const script = document.getElementById('__tool-result');
      expect(script).toBeInTheDocument();
      expect(script?.getAttribute('type')).toBe('application/json');
      const data = JSON.parse(script?.textContent || 'null');
      expect(data.content).toEqual([{ type: 'text', text: 'hello' }]);
      expect(data.structuredContent).toEqual({ v: 1 });
      expect(data.source).toBe('fixture');
    });

    it('renders null when no tool result exists', () => {
      render(<Inspector simulations={{ test: createSim() }} />);

      const script = document.getElementById('__tool-result');
      expect(script).toBeInTheDocument();
      expect(JSON.parse(script?.textContent || 'null')).toBeNull();
    });

    it('sets source to server after calling real tool handler', async () => {
      const user = userEvent.setup();
      const onCallTool = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'server response' }],
      });

      // Use a sim without fixture data so "None (call server)" is the default
      const sim = createSim({ toolInput: undefined, toolResult: undefined });
      render(<Inspector simulations={{ test: sim }} onCallTool={onCallTool} />);

      await user.click(screen.getByRole('button', { name: /run/i }));

      await waitFor(() => {
        const script = document.getElementById('__tool-result');
        const data = JSON.parse(script?.textContent || 'null');
        expect(data?.source).toBe('server');
        expect(data?.content[0]?.text).toBe('server response');
      });
    });

    it('escapes < in tool result to prevent script injection', () => {
      const sim = createSim({
        toolResult: { content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
      });
      render(<Inspector simulations={{ test: sim }} />);

      const script = document.getElementById('__tool-result');
      // The raw innerHTML should not contain unescaped <
      expect(script?.innerHTML).not.toContain('</script>');
      // But parsing should recover the original text
      const data = JSON.parse(script?.textContent || 'null');
      expect(data.content[0].text).toBe('<script>alert(1)</script>');
    });
  });

  // ── Story 2: Inspect-only user ──
  describe('Inspect-only: exploring external servers', () => {
    it('starts empty, then populates after reconnect', async () => {
      const user = userEvent.setup();
      const serverSimulations = {
        'remote-tool': createSim({
          name: 'remote-tool',
          tool: { name: 'remote-tool', inputSchema: { type: 'object' } },
          resource: { uri: 'test://remote', name: 'remote', mimeType: 'text/html' },
          resourceUrl: '/remote.html',
        }),
      };

      // No initial health check — starts without URL
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'ok', simulations: serverSimulations }), {
            status: 200,
          })
        );

      render(<Inspector simulations={{}} onCallTool={vi.fn()} />);

      // Initially: no tools, shows empty state
      expect(screen.getByText('Enter an MCP server URL to get started')).toBeInTheDocument();
      expect(screen.queryByTestId('tool-selector')).not.toBeInTheDocument();

      // User enters a URL
      const urlInput = screen.getByPlaceholderText('http://localhost:8000/mcp');
      await user.type(urlInput, 'http://remote:3000/mcp{Enter}');

      // After reconnect: tools appear
      await waitFor(() => {
        expect(screen.getByTestId('tool-selector')).toBeInTheDocument();
      });
      const allOptions = screen.getAllByRole('option');
      expect(allOptions.find((o) => o.textContent === 'remote-tool')).toBeDefined();
    });

    it('shows simulation dropdown with "None" only for discovered tools without fixtures', async () => {
      const user = userEvent.setup();
      const discoveredSims = {
        'discovered-tool': createSim({
          name: 'discovered-tool',
          tool: { name: 'discovered-tool', inputSchema: { type: 'object' } },
          // No toolInput, toolResult, or serverTools — just discovered from MCP
        }),
      };

      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'ok', simulations: discoveredSims }), {
            status: 200,
          })
        );

      render(<Inspector simulations={{}} onCallTool={vi.fn()} />);

      const urlInput = screen.getByPlaceholderText('http://localhost:8000/mcp');
      await user.type(urlInput, 'http://remote:3000/mcp{Enter}');

      await waitFor(() => {
        expect(screen.getByTestId('simulation-selector')).toBeInTheDocument();
      });
      // Should only have "None" (no fixture simulations)
      const options = screen.getByTestId('simulation-selector').querySelectorAll('option');
      expect(options).toHaveLength(1);
      expect(options[0].textContent).toBe('None');
    });

    it('handles network failure gracefully', async () => {
      const user = userEvent.setup();

      // Network-level failure (fetch throws, not HTTP error)
      fetchSpy
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ hasKey: false }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));

      render(<Inspector simulations={{}} onCallTool={vi.fn()} />);

      const urlInput = screen.getByPlaceholderText('http://localhost:8000/mcp');
      await user.type(urlInput, 'http://unreachable:3000/mcp{Enter}');

      await waitFor(() => {
        expect(screen.getByText('Could not connect to MCP server')).toBeInTheDocument();
      });
    });
  });

  // Note: integration of the `app` prop with the iframe lifecycle is covered
  // by the flattener unit tests (`app-flatten.test.ts`) and the e2e suite,
  // not here. jsdom's iframe semantics differ enough from real browsers that
  // rendering a populated app through the iframe stack adds noise without
  // catching anything the unit + e2e layers don't already cover.

  // ── Story 3: Programmatic testing (URL params) ──
  // URL param tests are covered by E2E tests (inspector-modes.spec.ts) which
  // navigate to real URLs. Unit-testing URL params in jsdom is unreliable because
  // jsdom's window.location is read-only. The createInspectorUrl function is
  // tested separately in inspector-url.test.ts.
  describe('Programmatic: createInspectorUrl', () => {
    it('generates tool-only URL (no mock data)', async () => {
      // This is tested at the URL level — the Inspector reads the URL on mount.
      // The E2E test "Tool Result starts collapsed and empty when no simulation selected"
      // navigates to createInspectorUrl({ tool: 'show-albums' }) and verifies the behavior.
      const { createInspectorUrl } = await import('./inspector-url');
      const url = createInspectorUrl({ tool: 'show-albums', theme: 'dark' });
      expect(url).toContain('tool=show-albums');
      expect(url).not.toContain('simulation=');
    });

    it('generates simulation URL (with mock data)', async () => {
      const { createInspectorUrl } = await import('./inspector-url');
      const url = createInspectorUrl({ simulation: 'show-albums', theme: 'dark' });
      expect(url).toContain('simulation=show-albums');
      expect(url).not.toContain('tool=');
    });

    it('generates combined tool + simulation URL', async () => {
      const { createInspectorUrl } = await import('./inspector-url');
      const url = createInspectorUrl({ tool: 'show-albums', simulation: 'show-albums' });
      expect(url).toContain('tool=show-albums');
      expect(url).toContain('simulation=show-albums');
    });

    it('does not include removed prodTools param', async () => {
      const { createInspectorUrl } = await import('./inspector-url');
      // @ts-expect-error — prodTools was removed from the type
      const url = createInspectorUrl({ simulation: 'test', prodTools: true });
      expect(url).not.toContain('prodTools');
    });
  });

  // ── Embedded mode: the `app` prop drives a self-contained instance ──
  // These tests use an empty-tools app so the Inspector renders the empty
  // state (no iframe lifecycle to drive in jsdom). Sidebar gating and root
  // sizing are observable without rendering an actual resource.
  describe('Embedded mode (`app` prop)', () => {
    const emptyApp = { name: 'My Embed', resources: [], tools: [] };
    const modelApp = {
      name: 'Model Embed',
      resources: [{ uri: 'ui://albums', html: '<html><body>albums</body></html>' }],
      tools: [
        {
          tool: {
            name: 'show-albums',
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
            _meta: { openai: { outputTemplate: 'ui://albums' } },
          },
        },
        {
          tool: {
            name: 'app-only-action',
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
            _meta: {
              openai: { outputTemplate: 'ui://albums' },
              ui: { visibility: ['app'] },
            },
          },
        },
        {
          tool: {
            name: 'lookup-album-metadata',
            inputSchema: { type: 'object' as const, properties: {}, required: [] },
          },
        },
      ],
    };

    it('hides the MCP Server URL input', () => {
      render(<Inspector app={emptyApp} onCallTool={vi.fn()} />);
      expect(screen.queryByTestId('server-url')).not.toBeInTheDocument();
    });

    it('hides the Authentication section', () => {
      render(<Inspector app={emptyApp} onCallTool={vi.fn()} />);
      expect(screen.queryByText('Authentication')).not.toBeInTheDocument();
    });

    it('hides the Prod Resources checkbox', () => {
      render(<Inspector app={emptyApp} onCallTool={vi.fn()} />);
      expect(screen.queryByRole('checkbox', { name: /prod resources/i })).not.toBeInTheDocument();
    });

    it('does not call /__sunpeak/list-tools on mount', () => {
      render(<Inspector app={emptyApp} onCallTool={vi.fn()} />);
      expect(fetchSpy).not.toHaveBeenCalledWith('/__sunpeak/list-tools');
    });

    it('uses h-full w-full instead of viewport sizing on the root element', () => {
      const { container } = render(<Inspector app={emptyApp} onCallTool={vi.fn()} />);
      const root = container.querySelector('.sunpeak-inspector-root');
      expect(root?.className).toMatch(/\bh-full\b/);
      expect(root?.className).not.toMatch(/\bh-screen\b/);
    });

    it('shows the embedded-mode empty-state message when no tools exist', () => {
      render(<Inspector app={emptyApp} onCallTool={vi.fn()} />);
      expect(screen.getByText('No tools in this app')).toBeInTheDocument();
    });

    it('keeps model chat and the bottom composer hidden in embedded mode', () => {
      render(<Inspector app={emptyApp} onCallTool={vi.fn()} />);
      expect(screen.queryByText('Model Chat')).not.toBeInTheDocument();
      expect(document.querySelector('input[name="userInput"]')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Message sunpeak.ai')).not.toBeInTheDocument();
    });

    it('keeps embedded model chat UI hidden even when modelChat is configured', async () => {
      const onChat = vi.fn(async () => ({
        text: 'Custom model response from embedder.',
        toolCalls: [],
      }));
      const getStatus = vi.fn(async () => ({ hasKey: false, storage: 'Fractal vault' }));
      render(
        <Inspector
          app={modelApp}
          onCallTool={vi.fn()}
          modelChat={{
            providers: [
              {
                id: 'fractal',
                label: 'Fractal Models',
                models: ['fractal-fast', 'fractal-careful'],
                defaultModel: 'fractal-careful',
              },
            ],
            apiKey: { getStatus },
            onChat,
          }}
        />
      );

      const toolSelect = screen.getByTestId('tool-selector').querySelector('select')!;
      await userEvent.selectOptions(toolSelect, 'lookup-album-metadata');
      expect(screen.getByText('Tool does not render a UI')).toBeInTheDocument();
      expect(screen.queryByText('Model Chat')).not.toBeInTheDocument();
      expect(screen.queryByText('API Key')).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue('Fractal Models')).not.toBeInTheDocument();
      expect(screen.queryByDisplayValue('fractal-careful')).not.toBeInTheDocument();
      expect(document.querySelector('input[name="userInput"]')).not.toBeInTheDocument();
      expect(onChat).not.toHaveBeenCalled();
      expect(getStatus).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('lets testing embedders explicitly opt into model chat with their own handler', async () => {
      const onChat = vi.fn(async () => ({
        text: 'Custom model response from embedder.',
        toolCalls: [],
      }));
      render(
        <Inspector
          app={modelApp}
          onCallTool={vi.fn()}
          modelChat={{
            enabled: true,
            providers: [
              {
                id: 'fractal',
                label: 'Fractal Models',
                models: ['fractal-fast', 'fractal-careful'],
                defaultModel: 'fractal-careful',
              },
            ],
            onChat,
          }}
        />
      );

      expect(screen.getByText('Model Chat')).toBeInTheDocument();
      expect(screen.queryByText('API Key')).not.toBeInTheDocument();

      expect(screen.getByDisplayValue('Fractal Models')).toBeInTheDocument();
      expect(screen.getByDisplayValue('fractal-careful')).toBeInTheDocument();

      const composer = document.querySelector<HTMLInputElement>('input[name="userInput"]')!;
      await userEvent.type(composer, 'Render this app{enter}');

      await waitFor(() => expect(onChat).toHaveBeenCalledTimes(1));
      expect(onChat).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'fractal',
          modelId: 'fractal-careful',
          host: 'chatgpt',
          messages: [{ role: 'user', content: 'Render this app' }],
          tools: expect.arrayContaining([expect.objectContaining({ name: 'show-albums' })]),
        })
      );
      const [chatRequest] = (
        onChat.mock.calls as unknown as Array<[{ tools: Array<{ name: string }> }]>
      )[0]!;
      expect(chatRequest.tools.map((tool) => tool.name)).toContain('lookup-album-metadata');
      expect(chatRequest.tools.map((tool) => tool.name)).not.toContain('app-only-action');
      expect(screen.getByText('Custom model response from embedder.')).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('resets model chat with a new backend conversation id', async () => {
      const onChat = vi.fn(async (_request: InspectorModelChatRequest) => ({
        text: 'Model reply.',
        toolCalls: [],
      }));
      render(
        <Inspector
          app={modelApp}
          onCallTool={vi.fn()}
          modelChat={{
            enabled: true,
            providers: [{ id: 'fractal', label: 'Fractal', defaultModel: 'fractal-careful' }],
            onChat,
          }}
        />
      );

      const resetButton = screen.getByRole('button', { name: 'Reset model conversation' });
      expect(resetButton).toHaveAttribute('title', 'Reset conversation');
      expect(resetButton).toHaveClass('cursor-pointer');
      expect(screen.getByRole('tooltip')).toHaveTextContent('Reset conversation');
      expect(resetButton).toBeDisabled();

      const composer = document.querySelector<HTMLInputElement>('input[name="userInput"]')!;
      await userEvent.type(composer, 'First prompt{enter}');
      await waitFor(() => expect(onChat).toHaveBeenCalledTimes(1));
      expect(screen.getByText('First prompt')).toBeInTheDocument();
      expect(resetButton).toBeEnabled();

      await userEvent.click(resetButton);
      expect(screen.queryByText('First prompt')).not.toBeInTheDocument();
      expect(screen.queryByText('Model reply.')).not.toBeInTheDocument();
      expect(resetButton).toBeDisabled();

      await userEvent.type(composer, 'Second prompt{enter}');
      await waitFor(() => expect(onChat).toHaveBeenCalledTimes(2));

      const requests = onChat.mock.calls.map(([request]) => request);
      expect(requests[0].conversationId).toMatch(/^model-chat-/);
      expect(requests[1].conversationId).toMatch(/^model-chat-/);
      expect(requests[1].conversationId).not.toBe(requests[0].conversationId);
      expect(requests[1].messages).toEqual([{ role: 'user', content: 'Second prompt' }]);
    });

    it('ignores an in-flight model response after resetting model chat', async () => {
      let resolveFirst: (value: { text: string; toolCalls: [] }) => void = () => {};
      const firstResponse = new Promise<{ text: string; toolCalls: [] }>((resolve) => {
        resolveFirst = resolve;
      });
      let requestCount = 0;
      const onChat = vi.fn(async (_request: InspectorModelChatRequest) => {
        requestCount += 1;
        if (requestCount === 1) return await firstResponse;
        return { text: 'Second reply.', toolCalls: [] };
      });

      render(
        <Inspector
          app={modelApp}
          onCallTool={vi.fn()}
          modelChat={{
            enabled: true,
            providers: [{ id: 'fractal', label: 'Fractal', defaultModel: 'fractal-careful' }],
            onChat,
          }}
        />
      );

      const resetButton = screen.getByRole('button', { name: 'Reset model conversation' });
      const composer = document.querySelector<HTMLInputElement>('input[name="userInput"]')!;
      await userEvent.type(composer, 'Slow prompt{enter}');
      await waitFor(() => expect(onChat).toHaveBeenCalledTimes(1));
      expect(screen.getByText('Slow prompt')).toBeInTheDocument();

      await userEvent.click(resetButton);
      expect(screen.queryByText('Slow prompt')).not.toBeInTheDocument();

      await act(async () => {
        resolveFirst({ text: 'Stale reply.', toolCalls: [] });
        await firstResponse;
      });
      expect(screen.queryByText('Stale reply.')).not.toBeInTheDocument();

      await userEvent.type(composer, 'Fresh prompt{enter}');
      await waitFor(() => expect(onChat).toHaveBeenCalledTimes(2));
      expect(screen.getByText('Second reply.')).toBeInTheDocument();

      const requests = onChat.mock.calls.map(([request]) => request);
      expect(requests[1].conversationId).not.toBe(requests[0].conversationId);
      expect(requests[1].messages).toEqual([{ role: 'user', content: 'Fresh prompt' }]);
    });

    it('does not claim a backend-only model tool call rendered an app', async () => {
      const onChat = vi.fn(async () => ({
        toolCalls: [
          {
            name: 'lookup-album-metadata',
            arguments: {},
            result: { content: [] },
          },
        ],
      }));
      render(
        <Inspector
          app={modelApp}
          onCallTool={vi.fn()}
          modelChat={{
            enabled: true,
            providers: [{ id: 'fractal', label: 'Fractal', defaultModel: 'fractal-careful' }],
            onChat,
          }}
        />
      );

      const toolSelect = screen.getByTestId('tool-selector').querySelector('select')!;
      await userEvent.selectOptions(toolSelect, 'lookup-album-metadata');
      expect(screen.getByText('Tool does not render a UI')).toBeInTheDocument();
      const composer = document.querySelector<HTMLInputElement>('input[name="userInput"]')!;
      await userEvent.type(composer, 'Look this up{enter}');

      await waitFor(() => expect(onChat).toHaveBeenCalledTimes(1));
      expect(screen.queryByText('Tool does not render a UI')).toBeNull();
      expect(screen.getByText('I called the MCP tool.')).toBeInTheDocument();
      expect(screen.queryByText('I called the MCP tool and rendered the app below.')).toBeNull();
    });

    it('keeps selected models inside the configured provider model list outside embedded mode', async () => {
      render(
        <Inspector
          simulations={{ test: createSim() }}
          onCallTool={vi.fn()}
          modelChat={{
            defaultModel: 'fractal-deprecated',
            providers: [
              {
                id: 'fractal',
                label: 'Fractal Models',
                models: ['fractal-fast', 'fractal-careful'],
                defaultModel: 'fractal-careful',
              },
            ],
            onChat: vi.fn(async () => ({ text: 'ok' })),
          }}
        />
      );

      expect(screen.getByDisplayValue('fractal-careful')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('fractal-deprecated')).not.toBeInTheDocument();
    });

    it('passes app context to model chat handlers', async () => {
      const onChat = vi.fn(async () => ({ text: 'ok' }));
      render(
        <Inspector
          simulations={{ test: createSim() }}
          onCallTool={vi.fn()}
          modelChat={{
            providers: [{ id: 'fractal', label: 'Fractal', defaultModel: 'fractal-careful' }],
            onChat,
          }}
        />
      );

      const appContext = screen.getByDisplayValue('null');
      fireEvent.change(appContext, { target: { value: '{"selectedAlbum":"Pizza Tour"}' } });
      fireEvent.blur(appContext);

      const composer = document.querySelector<HTMLInputElement>('input[name="userInput"]')!;
      await userEvent.type(composer, 'What is selected?{enter}');

      await waitFor(() => expect(onChat).toHaveBeenCalledTimes(1));
      expect(onChat).toHaveBeenCalledWith(
        expect.objectContaining({
          appContext: {
            content: [],
            structuredContent: { selectedAlbum: 'Pizza Tour' },
          },
        })
      );
    });

    it('prefers provider-specific default models over the global model default', async () => {
      render(
        <Inspector
          simulations={{ test: createSim() }}
          onCallTool={vi.fn()}
          modelChat={{
            defaultModel: 'global-default',
            providers: [
              { id: 'fractal-fast', label: 'Fractal Fast', defaultModel: 'fractal-small' },
              { id: 'fractal-careful', label: 'Fractal Careful', defaultModel: 'fractal-large' },
            ],
            onChat: vi.fn(async () => ({ text: 'ok' })),
          }}
        />
      );

      expect(screen.getByDisplayValue('fractal-small')).toBeInTheDocument();
      await userEvent.selectOptions(screen.getByDisplayValue('Fractal Fast'), 'fractal-careful');
      expect(screen.getByDisplayValue('fractal-large')).toBeInTheDocument();
    });

    it('defaults OpenAI model chat to the current ChatGPT default model id', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      expect(screen.getByDisplayValue('gpt-5.5')).toBeInTheDocument();
    });

    it('restores persisted Model Chat and Prod Resources values', () => {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          modelProvider: 'fractal',
          modelId: 'fractal-careful',
          prodResources: true,
        })
      );

      render(
        <Inspector
          simulations={{ test: createSim() }}
          onCallTool={vi.fn()}
          modelChat={{
            providers: [
              {
                id: 'fractal',
                label: 'Fractal Models',
                models: ['fractal-fast', 'fractal-careful'],
              },
            ],
            onChat: vi.fn(async () => ({ text: 'ok' })),
          }}
        />
      );

      expect(screen.getByDisplayValue('Fractal Models')).toBeInTheDocument();
      expect(screen.getByDisplayValue('fractal-careful')).toBeInTheDocument();
      expect(screen.getByLabelText('Prod Resources')).toBeChecked();
    });

    it('lets persisted Prod Resources override the default prop', () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ prodResources: false }));

      render(
        <Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} defaultProdResources />
      );

      expect(screen.getByLabelText('Prod Resources')).not.toBeChecked();
    });

    it('persists Model Chat and Prod Resources changes without dropping host prefs', async () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: 'light', activeHost: 'claude' }));

      render(
        <Inspector
          simulations={{ test: createSim() }}
          onCallTool={vi.fn()}
          modelChat={{
            providers: [
              {
                id: 'fractal',
                label: 'Fractal Models',
                models: ['fractal-fast', 'fractal-careful'],
              },
            ],
            onChat: vi.fn(async () => ({ text: 'ok' })),
          }}
        />
      );

      await userEvent.selectOptions(screen.getByDisplayValue('fractal-fast'), 'fractal-careful');
      await userEvent.click(screen.getByLabelText('Prod Resources'));

      await waitFor(() => {
        const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Record<
          string,
          unknown
        >;
        expect(prefs.modelProvider).toBe('fractal');
        expect(prefs.modelId).toBe('fractal-careful');
        expect(prefs.prodResources).toBe(true);
        expect(prefs.theme).toBe('light');
        expect(prefs.activeHost).toBe('claude');
      });
    });

    it('lets host pages own API key status and save behavior for model chat outside embedded mode', async () => {
      const getStatus = vi.fn(async () => ({ hasKey: false, storage: 'Fractal vault' }));
      const save = vi.fn(async () => ({ hasKey: true, storage: 'Fractal vault' }));
      render(
        <Inspector
          simulations={{ test: createSim() }}
          onCallTool={vi.fn()}
          modelChat={{
            providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-test' }],
            apiKey: { getStatus, save },
            onChat: vi.fn(async () => ({ text: 'ok' })),
          }}
        />
      );

      await waitFor(() => expect(getStatus).toHaveBeenCalledWith('openai'));
      const keyInput = screen.getByPlaceholderText('Paste openai key');
      expect(keyInput).toHaveAttribute('autocomplete', 'new-password');
      await userEvent.type(keyInput, 'sk-fractal-test');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() =>
        expect(save).toHaveBeenCalledWith({ provider: 'openai', apiKey: 'sk-fractal-test' })
      );
      expect(screen.getByText('Saved Fractal vault')).toBeInTheDocument();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reacts to a new `app` prop — swapping in a different app updates the tool list', async () => {
      const appA = {
        name: 'A',
        resources: [],
        tools: [],
      };
      const appB = {
        name: 'B',
        resources: [{ uri: 'ui://b', html: '<html><body>B</body></html>' }],
        tools: [
          {
            tool: {
              name: 'tool_b',
              inputSchema: { type: 'object' as const, properties: {}, required: [] },
              _meta: { openai: { outputTemplate: 'ui://b' } },
            },
          },
        ],
      };
      const { rerender } = render(<Inspector app={appA} onCallTool={vi.fn()} />);
      // No tools in appA — embedded empty state.
      expect(screen.getByText('No tools in this app')).toBeInTheDocument();
      // Swap to appB. The Inspector should pick up the new tool without errors.
      rerender(<Inspector app={appB} onCallTool={vi.fn()} />);
      await waitFor(() => {
        const opts = screen.getAllByRole('option').filter((o) => o.textContent === 'tool_b');
        expect(opts.length).toBe(1);
      });
    });

    it('warns when both `app` and `simulations` are supplied', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        render(
          <Inspector app={emptyApp} simulations={{ stray: createSim() }} onCallTool={vi.fn()} />
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Both `app` and `simulations` were provided')
        );
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe('Model chat API key status', () => {
    it('defaults Model Chat to expanded', () => {
      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      expect(screen.getByText('Model Chat')).toBeInTheDocument();
      expect(screen.getByText('Provider')).toBeInTheDocument();
    });

    it('surfaces local API key status errors in the sidebar', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ hasKey: false, error: 'macOS Keychain is locked' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      await expect(screen.findByText('macOS Keychain is locked')).resolves.toBeInTheDocument();
    });

    it('surfaces API key status fetch failures in the sidebar', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('Key status request failed'));

      render(<Inspector simulations={{ test: createSim() }} onCallTool={vi.fn()} />);

      await expect(screen.findByText('Key status request failed')).resolves.toBeInTheDocument();
    });
  });
});
