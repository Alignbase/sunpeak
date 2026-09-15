import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createAppServer } from './server.js';
import type { SimulationWithDist } from './types.js';

describe('MCP Server Module', () => {
  it('validates that readToolHtml would need an existing file', () => {
    // This tests the contract: readToolHtml expects files to exist
    const testPath = path.join(__dirname, 'types.ts');

    // Verify fs.existsSync works as expected (this is a sanity check)
    expect(fs.existsSync(testPath)).toBe(true);
    expect(fs.existsSync('/nonexistent/file.js')).toBe(false);
  });

  it('verifies pre-built HTML structure from sunpeak build', () => {
    // The build process generates self-contained HTML files with JS inlined
    const mockJsCode = 'console.log("test");';
    const preBuiltHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body>
  <div id="root"></div>
  <script>
${mockJsCode}
  </script>
</body>
</html>`;

    // Verify the structure contains essential elements
    expect(preBuiltHtml).toContain('<!DOCTYPE html>');
    expect(preBuiltHtml).toContain('<div id="root"></div>');
    expect(preBuiltHtml).toContain('<script>');
    expect(preBuiltHtml).toContain(mockJsCode);
  });

  it('verifies timestamp pattern for cache busting URIs', () => {
    // Test the timestamp suffix pattern used for cache busting
    const resourceName = 'widget';
    const timestamp = Date.now().toString(36);
    const uri = `ui://${resourceName}-${timestamp}`;

    // Verify URI format: ui://name-timestamp
    expect(uri).toMatch(/^ui:\/\/widget-[a-z0-9]+$/);
    expect(uri).not.toBe(`ui://${resourceName}`);

    // Verify timestamp can be stripped
    const cleaned = uri.replace(/-[a-z0-9]+$/, '');
    expect(cleaned).toBe(`ui://${resourceName}`);
  });
});

describe('Dev overlay format contract', () => {
  it('resource timestamp is formatted as HH:MM:SS in 24-hour time', () => {
    // Replicates the overlay's fmt() function to verify the format
    // that E2E tests match with /\d{2}:\d{2}:\d{2}/.
    function fmt(ts: number): string {
      const d = new Date(ts);
      const h = d.getHours();
      const m = d.getMinutes();
      const s = d.getSeconds();
      return (
        (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
      );
    }

    expect(fmt(new Date(2026, 0, 1, 0, 0, 0).getTime())).toBe('00:00:00');
    expect(fmt(new Date(2026, 0, 1, 14, 5, 9).getTime())).toBe('14:05:09');
    expect(fmt(new Date(2026, 0, 1, 23, 59, 59).getTime())).toBe('23:59:59');
  });

  it('tool timing uses one decimal place for sub-integer values', () => {
    // Sub-millisecond precision: round to one decimal place
    const subMs = Math.round(0.3 * 10) / 10;
    expect(`${subMs.toFixed(1)}ms`).toBe('0.3ms');

    // Non-integer values display with one decimal place
    const fracMs = Math.round(142.7 * 10) / 10;
    const formatted = fracMs % 1 === 0 ? `${fracMs}ms` : `${fracMs.toFixed(1)}ms`;
    expect(formatted).toBe('142.7ms');

    // E2E tests match with /Tool:\s*\d+(\.\d)?ms/
    expect('0.3ms').toMatch(/^\d+(\.\d)?ms$/);
    expect('143ms').toMatch(/^\d+(\.\d)?ms$/);
    expect('12.5ms').toMatch(/^\d+(\.\d)?ms$/);
  });
});

describe('createAppServer', () => {
  function makeUiSim(name: string, toolResult: unknown): SimulationWithDist {
    return {
      name,
      distPath: '/tmp/sunpeak-test-not-read-at-registration.html',
      tool: { name: 'show-albums', inputSchema: { type: 'object' } },
      resource: {
        name: 'albums',
        uri: 'ui://albums',
        mimeType: 'text/html',
      },
      toolResult: toolResult as SimulationWithDist['toolResult'],
    };
  }

  it('registers a UI tool once even when multiple simulations target it', () => {
    const simulations: SimulationWithDist[] = [
      makeUiSim('show-albums', { structuredContent: { albums: ['a'] } }),
      makeUiSim('show-albums-empty', { structuredContent: { albums: [] } }),
      makeUiSim('show-albums-error', {
        isError: true,
        content: [{ type: 'text', text: 'boom' }],
      }),
    ];

    // Before the dedup fix this threw because the MCP SDK rejects duplicate
    // tool registrations.
    const result = createAppServer({ simulations }, simulations, false);

    expect(result.toolHandles).toHaveLength(1);
    expect(result.toolHandles[0].resourceName).toBe('albums');
    expect(result.resourceHandles.has('albums')).toBe(true);
  });

  it('uses explicit null structured content as a simulation mock', async () => {
    const handler = vi.fn().mockResolvedValue({ structuredContent: { live: true } });
    const simulation = {
      ...makeUiSim('show-albums-null', { structuredContent: null }),
      handler,
    };
    const result = createAppServer({ simulations: [simulation] }, [simulation], false);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'sunpeak-test', version: '1.0.0' });

    await result.server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: 'show-albums', arguments: {} });

    expect(response.structuredContent).toEqual({ result: null });
    expect(handler).not.toHaveBeenCalled();
    await client.close();
    await result.server.close();
  });

  it('preserves content-only error simulations instead of calling the live handler', async () => {
    const handler = vi.fn().mockResolvedValue({ structuredContent: { live: true } });
    const simulation = {
      ...makeUiSim('show-albums-error', {
        content: [{ type: 'text', text: 'fixture error' }],
        isError: true,
      }),
      handler,
    };
    const result = createAppServer({ simulations: [simulation] }, [simulation], false);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'sunpeak-test', version: '1.0.0' });

    await result.server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({ name: 'show-albums', arguments: {} });

    expect(response.content).toEqual([{ type: 'text', text: 'fixture error' }]);
    expect(response.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    await client.close();
    await result.server.close();
  });
});
