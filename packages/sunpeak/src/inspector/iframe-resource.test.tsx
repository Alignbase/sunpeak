import { act, render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IframeResource, _testExports } from './iframe-resource';

const {
  escapeHtml,
  isAllowedUrl,
  isValidCspSource,
  generateCSP,
  generateScriptHtml,
  buildIframeAllow,
  computePreviewScale,
  ALLOWED_SCRIPT_ORIGINS,
} = _testExports;

function withWindowLocation(url: string, callback: () => void) {
  const originalLocation = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL(url),
  });
  try {
    callback();
  } finally {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  }
}

describe('IframeResource', () => {
  it('applies and updates the fullscreen frame transform from stage geometry', () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe = observe;
        disconnect = disconnect;
      }
    );
    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    rectSpy.mockReturnValue({
      width: 393,
      height: 668,
      top: 0,
      right: 393,
      bottom: 668,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const { unmount } = render(
      <IframeResource
        scriptSrc="/dist/carousel/carousel.js"
        hostContext={{
          theme: 'dark',
          displayMode: 'fullscreen',
          containerDimensions: { width: 393, height: 852 },
        }}
      />
    );

    const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
    const frame = iframe.closest('[data-sunpeak-preview-frame]') as HTMLElement;
    const stage = iframe.closest('[data-sunpeak-preview-stage]') as HTMLElement;
    expect(observe).toHaveBeenCalledWith(stage);
    expect(frame.style.transform).toBe(`scale(${668 / 852})`);
    expect(iframe.style.width).toBe('100%');
    expect(iframe.style.height).toBe('100%');

    rectSpy.mockReturnValue({
      width: 393,
      height: 900,
      top: 0,
      right: 393,
      bottom: 900,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    act(() => resizeCallback?.([], {} as ResizeObserver));
    expect(frame.style.transform).toBe('scale(1)');

    unmount();
    expect(disconnect).toHaveBeenCalled();
    rectSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('renders an iframe with srcDoc', () => {
    render(<IframeResource scriptSrc="/dist/carousel/carousel.js" />);

    const iframe = screen.getByTitle('Resource Preview');
    expect(iframe).toBeInTheDocument();
    expect(iframe.tagName).toBe('IFRAME');
    expect(iframe.getAttribute('srcDoc')).not.toBeNull();
  });

  it('loads sandbox proxy in outer iframe (double-iframe architecture)', () => {
    render(<IframeResource scriptSrc="/dist/carousel/carousel.js" />);

    const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
    const srcDoc = iframe.getAttribute('srcDoc') ?? '';

    // The outer iframe loads the sandbox proxy, not the app HTML directly.
    // The proxy relays messages and creates the inner iframe at runtime.
    expect(srcDoc).toContain('sandbox-proxy-ready');
    expect(srcDoc).toContain('sandbox-resource-ready');
    expect(srcDoc).toContain('createInnerFrame');
    expect(srcDoc).toContain('<!DOCTYPE html>');
  });

  it('does not inject app HTML directly in outer iframe srcdoc', () => {
    render(<IframeResource scriptSrc="/dist/carousel/carousel.js" />);

    const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
    const srcDoc = iframe.getAttribute('srcDoc') ?? '';

    // App HTML is delivered via sendSandboxResourceReady, not embedded in srcdoc
    expect(srcDoc).not.toContain('<div id="root"></div>');
    expect(srcDoc).not.toContain('carousel.js');
  });

  it('sets appropriate sandbox attributes', () => {
    render(<IframeResource scriptSrc="/dist/carousel/carousel.js" />);

    const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
    );
  });

  it('sets default permissions policy with local-network-access', () => {
    render(<IframeResource scriptSrc="/dist/carousel/carousel.js" />);

    const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
    const allow = iframe.getAttribute('allow');
    expect(allow).toContain('local-network-access *');
    // Without resource permissions declared, only local-network-access is allowed
    expect(allow).toBe('local-network-access *');
  });

  it('adds resource-declared permissions to allow attribute', () => {
    render(
      <IframeResource
        scriptSrc="/dist/carousel/carousel.js"
        permissions={{ microphone: {}, clipboardWrite: {} }}
      />
    );

    const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
    const allow = iframe.getAttribute('allow');
    expect(allow).toContain('local-network-access *');
    expect(allow).toContain('microphone');
    expect(allow).toContain('clipboard-write');
    expect(allow).not.toContain('camera');
    expect(allow).not.toContain('geolocation');
  });

  it('applies custom className and style', () => {
    render(
      <IframeResource
        scriptSrc="/dist/carousel/carousel.js"
        className="custom-class"
        style={{ maxHeight: '500px' }}
      />
    );

    const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
    expect(iframe.parentElement?.className).toContain('custom-class');
    expect(iframe.style.maxHeight).toBe('500px');
  });

  it('sets default iframe styles', () => {
    render(<IframeResource scriptSrc="/dist/carousel/carousel.js" />);

    const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
    expect(iframe.style.width).toBe('100%');
    // Uses minHeight instead of height to allow auto-resize based on content
    expect(iframe.style.minHeight).toBe('200px');
  });

  it('applies container dimensions in fullscreen mode', () => {
    render(
      <IframeResource
        scriptSrc="/dist/carousel/carousel.js"
        hostContext={{
          theme: 'dark',
          displayMode: 'fullscreen',
          containerDimensions: { width: 430, height: 932 },
        }}
      />
    );

    const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
    expect(iframe.parentElement?.style.width).toBe('430px');
    expect(iframe.parentElement?.style.height).toBe('932px');
    expect(iframe.style.height).toBe('100%');
  });

  it.each([
    {
      name: 'iPhone 15 in a 1280x720 inspector stage',
      stage: { width: 393, height: 668 },
      frame: { width: 393, height: 852 },
      expected: 668 / 852,
    },
    {
      name: 'iPhone SE when the full device frame fits',
      stage: { width: 375, height: 668 },
      frame: { width: 375, height: 667 },
      expected: 1,
    },
    {
      name: 'iPad constrained by inspector width and height',
      stage: { width: 760, height: 668 },
      frame: { width: 820, height: 1180 },
      expected: 668 / 1180,
    },
  ])('scales $name without changing its internal viewport', ({ stage, frame, expected }) => {
    expect(computePreviewScale(stage.width, stage.height, frame.width, frame.height)).toBeCloseTo(
      expected,
      6
    );
  });

  it('keeps fullscreen iframe dimensions inside a separate scale-to-fit stage', () => {
    render(
      <IframeResource
        scriptSrc="/dist/carousel/carousel.js"
        hostContext={{
          theme: 'dark',
          displayMode: 'fullscreen',
          containerDimensions: { width: 393, height: 852 },
        }}
      />
    );

    const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
    const frame = iframe.closest('[data-sunpeak-preview-frame]') as HTMLElement | null;
    const stage = iframe.closest('[data-sunpeak-preview-stage]') as HTMLElement | null;
    expect(frame?.style.width).toBe('393px');
    expect(frame?.style.height).toBe('852px');
    expect(stage?.style.width).toBe('100%');
    expect(stage?.style.height).toBe('100%');
  });

  it('generates app HTML with theme via generateScriptHtml (used by sandbox delivery)', () => {
    // The app HTML is generated by generateScriptHtml and delivered to the
    // proxy via sendSandboxResourceReady at runtime. Test the function directly.
    const html = generateScriptHtml('/dist/carousel/carousel.js', 'dark', '');
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('style="color-scheme:dark;background:Canvas"');
    expect(html).toContain('<meta name="color-scheme" content="dark" />');
    expect(html).toContain('background: transparent');
  });
});

describe('IframeResource Security', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('XSS Prevention - escapeHtml', () => {
    it('escapes < and > to prevent script injection', () => {
      const malicious = '<script>alert("xss")</script>';
      const escaped = escapeHtml(malicious);
      expect(escaped).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
      expect(escaped).not.toContain('<script>');
    });

    it('escapes double quotes to prevent attribute breakout', () => {
      const malicious = '"></script><script>evil()</script><script x="';
      const escaped = escapeHtml(malicious);
      expect(escaped).toBe(
        '&quot;&gt;&lt;/script&gt;&lt;script&gt;evil()&lt;/script&gt;&lt;script x=&quot;'
      );
      expect(escaped).not.toContain('"><');
    });

    it('escapes single quotes', () => {
      const malicious = "javascript:alert('xss')";
      const escaped = escapeHtml(malicious);
      expect(escaped).toBe('javascript:alert(&#39;xss&#39;)');
    });

    it('escapes ampersands to prevent entity injection', () => {
      const malicious = '&lt;script&gt;';
      const escaped = escapeHtml(malicious);
      expect(escaped).toBe('&amp;lt;script&amp;gt;');
    });

    it('handles combined attack vectors', () => {
      const malicious = `"><img src=x onerror="alert('xss')"><"`;
      const escaped = escapeHtml(malicious);
      expect(escaped).not.toContain('<img');
      expect(escaped).toContain('&lt;img');
      expect(escaped).toBe(
        `&quot;&gt;&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt;&lt;&quot;`
      );
    });
  });

  describe('XSS Prevention - Component Integration', () => {
    it('escapes malicious scriptSrc in generateScriptHtml', () => {
      // With the sandbox proxy, malicious scriptSrc is escaped in the HTML
      // delivered via sendSandboxResourceReady, tested via the function directly.
      const malicious = '/dist/"></script><script>alert("xss")</script><script x=".js';
      const html = generateScriptHtml(malicious, 'dark', '');
      expect(html).not.toContain('><script>alert');
      expect(html).toContain('&lt;script&gt;');
    });

    it('blocks javascript: protocol attempts', () => {
      const malicious = 'javascript:alert(document.cookie)';
      render(<IframeResource scriptSrc={malicious} />);

      // With invalid URLs, the component renders an error div, not an iframe
      expect(screen.getByText(/Script source not allowed/)).toBeInTheDocument();
    });

    it('blocks data: URL attempts', () => {
      const malicious = 'data:text/javascript,alert(1)';
      render(<IframeResource scriptSrc={malicious} />);

      expect(screen.getByText(/Script source not allowed/)).toBeInTheDocument();
    });
  });

  describe('Script Origin Validation - isAllowedUrl', () => {
    it('allows relative paths starting with /', () => {
      expect(isAllowedUrl('/dist/carousel/carousel.js')).toBe(true);
      expect(isAllowedUrl('/scripts/widget.js')).toBe(true);
    });

    it('rejects protocol-relative URLs (//)', () => {
      expect(isAllowedUrl('//evil.com/malware.js')).toBe(false);
    });

    it('allows same-origin absolute URLs', () => {
      expect(isAllowedUrl('http://localhost:3000/dist/widget.js')).toBe(true);
    });

    it('allows localhost with any port', () => {
      expect(isAllowedUrl('http://localhost:8080/script.js')).toBe(true);
      expect(isAllowedUrl('http://localhost:5173/script.js')).toBe(true);
      expect(isAllowedUrl('https://localhost:3000/script.js')).toBe(true);
    });

    it('allows 127.0.0.1 with any port', () => {
      expect(isAllowedUrl('http://127.0.0.1:8080/script.js')).toBe(true);
      expect(isAllowedUrl('http://127.0.0.1:5173/script.js')).toBe(true);
    });

    it('rejects loopback scripts when the inspector is hosted remotely', () => {
      withWindowLocation('https://inspector.example.com/', () => {
        expect(isAllowedUrl('http://localhost/script.js')).toBe(false);
        expect(isAllowedUrl('https://localhost/script.js')).toBe(false);
        expect(isAllowedUrl('http://127.0.0.1/script.js')).toBe(false);
        expect(isAllowedUrl('http://localhost:5173/script.js')).toBe(false);
      });
    });

    it('allows same-origin absolute URLs when the inspector is hosted remotely', () => {
      withWindowLocation('https://inspector.example.com/', () => {
        expect(isAllowedUrl('https://inspector.example.com/dist/widget.js')).toBe(true);
      });
    });

    it('allows sunpeak-prod-app-storage S3 bucket', () => {
      expect(
        isAllowedUrl(
          'https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com/widgets/carousel.js'
        )
      ).toBe(true);
    });

    it('rejects arbitrary external domains', () => {
      expect(isAllowedUrl('https://evil.com/malware.js')).toBe(false);
      expect(isAllowedUrl('https://attacker.io/script.js')).toBe(false);
      expect(isAllowedUrl('http://malicious-cdn.net/widget.js')).toBe(false);
    });

    it('rejects similar-looking domains (typosquatting)', () => {
      expect(
        isAllowedUrl(
          'https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com.evil.com/script.js'
        )
      ).toBe(false);
      expect(
        isAllowedUrl('https://sunpeak-fake-app-storage.s3.us-east-2.amazonaws.com/script.js')
      ).toBe(false);
      expect(isAllowedUrl('https://s3.us-east-2.amazonaws.com/script.js')).toBe(false);
    });

    it('rejects data: URLs', () => {
      expect(isAllowedUrl('data:text/javascript,alert(1)')).toBe(false);
    });

    it('rejects blob: URLs from other origins', () => {
      expect(isAllowedUrl('blob:https://evil.com/12345')).toBe(false);
    });

    it('rejects invalid URLs', () => {
      expect(isAllowedUrl('not-a-valid-url')).toBe(false);
      expect(isAllowedUrl('')).toBe(false);
    });
  });

  describe('Script Origin Validation - Component Integration', () => {
    it('blocks scripts from disallowed origins', () => {
      render(<IframeResource scriptSrc="https://evil.com/malware.js" />);

      // Invalid URLs render an error div instead of an iframe
      expect(screen.getByText(/Script source not allowed/)).toBeInTheDocument();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[IframeResource] Script source not allowed:',
        'https://evil.com/malware.js'
      );
    });

    it('allows scripts from sunpeak-prod-app-storage S3 bucket', () => {
      render(
        <IframeResource scriptSrc="https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com/widgets/test.js" />
      );

      // Valid URL renders the sandbox proxy iframe (not an error)
      const iframe = screen.getByTitle('Resource Preview');
      expect(iframe).toBeInTheDocument();
    });
  });

  describe('Iframe Sandbox Restrictions', () => {
    it('has sandbox permissions matching ChatGPT iframe model', () => {
      render(<IframeResource scriptSrc="/dist/carousel/carousel.js" />);

      const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
      const sandbox = iframe.getAttribute('sandbox');

      expect(sandbox).toContain('allow-scripts');
      expect(sandbox).toContain('allow-same-origin');
      expect(sandbox).toContain('allow-forms');
      expect(sandbox).toContain('allow-popups');
      expect(sandbox).toContain('allow-popups-to-escape-sandbox');
      expect(sandbox).not.toContain('allow-top-navigation');
    });

    it('builds allow attribute from resource permissions', () => {
      render(
        <IframeResource
          scriptSrc="/dist/carousel/carousel.js"
          permissions={{ camera: {}, geolocation: {} }}
        />
      );

      const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
      const allow = iframe.getAttribute('allow');

      expect(allow).toContain('local-network-access *');
      expect(allow).toContain('camera');
      expect(allow).toContain('geolocation');
      // Permissions not declared should not appear
      expect(allow).not.toContain('microphone');
      expect(allow).not.toContain('clipboard-write');
    });

    it('defaults to local-network-access only without permissions', () => {
      render(<IframeResource scriptSrc="/dist/carousel/carousel.js" />);

      const iframe = screen.getByTitle('Resource Preview') as HTMLIFrameElement;
      const allow = iframe.getAttribute('allow');

      expect(allow).toBe('local-network-access *');
    });

    it('does not grant local-network-access from hosted inspectors', () => {
      withWindowLocation('https://inspector.example.com/', () => {
        expect(buildIframeAllow(undefined)).toBe('');
        expect(buildIframeAllow({ microphone: {}, clipboardWrite: {} })).toBe(
          'microphone; clipboard-write'
        );
      });
    });
  });

  describe('Allowed Origins Configuration', () => {
    it('ALLOWED_SCRIPT_ORIGINS contains sunpeak-prod-app-storage S3 bucket', () => {
      expect(ALLOWED_SCRIPT_ORIGINS).toContain(
        'https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com'
      );
    });

    it('ALLOWED_SCRIPT_ORIGINS does not contain loopback origins', () => {
      expect(ALLOWED_SCRIPT_ORIGINS).not.toContain('http://localhost');
      expect(ALLOWED_SCRIPT_ORIGINS).not.toContain('https://localhost');
      expect(ALLOWED_SCRIPT_ORIGINS).not.toContain('http://127.0.0.1');
      expect(ALLOWED_SCRIPT_ORIGINS).not.toContain('https://127.0.0.1');
    });
  });

  describe('Content Security Policy - generateCSP', () => {
    it('generates restrictive default CSP without config', () => {
      const csp = generateCSP(
        undefined,
        'https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com/widget.js'
      );

      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:");
      expect(csp).toContain("style-src 'self' 'unsafe-inline'");
      expect(csp).toContain("frame-src 'none'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("form-action 'none'");
      expect(csp).toContain("base-uri 'self'");
    });

    it('includes script origin in connect-src', () => {
      const csp = generateCSP(
        undefined,
        'https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com/widget.js'
      );

      expect(csp).toContain('connect-src');
      expect(csp).toContain('https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com');
    });

    it('adds custom connect domains to connect-src', () => {
      const csp = generateCSP(
        {
          connectDomains: ['https://api.mapbox.com', 'https://events.mapbox.com'],
        },
        'https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com/widget.js'
      );

      expect(csp).toContain('https://api.mapbox.com');
      expect(csp).toContain('https://events.mapbox.com');
    });

    it('adds custom resource domains to img-src and font-src', () => {
      const csp = generateCSP(
        {
          resourceDomains: ['https://cdn.sunpeak.ai'],
        },
        'https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com/widget.js'
      );

      expect(csp).toContain('img-src');
      expect(csp).toContain('https://cdn.sunpeak.ai');
      expect(csp).toContain('font-src');
    });

    it('includes data: and blob: in resource sources', () => {
      const csp = generateCSP(
        undefined,
        'https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com/widget.js'
      );

      expect(csp).toContain('data:');
      expect(csp).toContain('blob:');
    });

    it('disallows nested iframes', () => {
      const csp = generateCSP(
        undefined,
        'https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com/widget.js'
      );

      expect(csp).toContain("frame-src 'none'");
    });

    it('disallows form submissions', () => {
      const csp = generateCSP(
        undefined,
        'https://sunpeak-prod-app-storage.s3.us-east-2.amazonaws.com/widget.js'
      );

      expect(csp).toContain("form-action 'none'");
    });
  });

  describe('Content Security Policy - Component Integration', () => {
    it('CSP is included in generated app HTML (delivered via sandbox proxy)', () => {
      // With the double-iframe architecture, CSP is in the app HTML
      // delivered via sendSandboxResourceReady, not in the outer srcdoc.
      // Test the generation function directly.
      const csp = generateCSP(undefined, '/dist/carousel/carousel.js');
      const html = generateScriptHtml('/dist/carousel/carousel.js', 'dark', csp);
      expect(html).toContain('http-equiv="Content-Security-Policy"');
    });

    it('applies custom CSP in generated app HTML', () => {
      const csp = generateCSP(
        {
          connectDomains: ['https://api.example.com'],
          resourceDomains: ['https://images.example.com'],
        },
        '/dist/carousel/carousel.js'
      );
      expect(csp).toContain('https://api.example.com');
      expect(csp).toContain('https://images.example.com');
    });
  });

  describe('generateScriptHtml', () => {
    it('includes CSP meta tag with escaped content', () => {
      const html = generateScriptHtml(
        'https://example.com/script.js',
        'dark',
        "default-src 'self'"
      );

      expect(html).toContain('http-equiv="Content-Security-Policy"');
      expect(html).toContain('content="default-src &#39;self&#39;"');
    });

    it('escapes malicious CSP content', () => {
      const maliciousCSP = '"><script>alert("xss")</script>';
      const html = generateScriptHtml('https://example.com/script.js', 'dark', maliciousCSP);

      expect(html).not.toContain('><script>alert');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes theme attribute to prevent injection', () => {
      const maliciousTheme = '"><script>alert("xss")</script><div x="';
      const html = generateScriptHtml('https://example.com/script.js', maliciousTheme, '');

      expect(html).not.toContain('"><script>');
      expect(html).toContain('data-theme="&quot;&gt;&lt;script&gt;');
    });
  });

  describe('CSP Domain Validation - isValidCspSource', () => {
    it('allows valid http(s) URLs', () => {
      expect(isValidCspSource('https://api.example.com')).toBe(true);
      expect(isValidCspSource('http://localhost:3000')).toBe(true);
      expect(isValidCspSource('https://cdn.example.com')).toBe(true);
    });

    it('allows WebSocket URLs', () => {
      expect(isValidCspSource('ws://localhost:24678')).toBe(true);
      expect(isValidCspSource('wss://api.example.com')).toBe(true);
    });

    it('rejects wildcard *', () => {
      expect(isValidCspSource('*')).toBe(false);
    });

    it('rejects CSP keywords that could weaken the policy', () => {
      expect(isValidCspSource("'unsafe-inline'")).toBe(false);
      expect(isValidCspSource("'unsafe-eval'")).toBe(false);
      expect(isValidCspSource("'none'")).toBe(false);
    });

    it('rejects entries with whitespace that could inject directives', () => {
      expect(isValidCspSource('https://ok.com ; script-src *')).toBe(false);
      expect(isValidCspSource('https://ok.com unsafe-inline')).toBe(false);
    });

    it('rejects empty strings', () => {
      expect(isValidCspSource('')).toBe(false);
    });

    it('rejects non-URL strings', () => {
      expect(isValidCspSource('not-a-url')).toBe(false);
    });
  });

  describe('CSP Domain Validation - generateCSP integration', () => {
    it('filters out invalid connectDomains', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const csp = generateCSP(
        { connectDomains: ['https://api.example.com', '*', "'unsafe-inline'"] },
        '/script.js'
      );

      expect(csp).toContain('https://api.example.com');
      expect(csp).not.toMatch(/connect-src[^;]*\*/);
      expect(csp).not.toMatch(/connect-src[^;]*unsafe-inline/);
      expect(warnSpy).toHaveBeenCalledTimes(2);
      warnSpy.mockRestore();
    });

    it('filters out invalid resourceDomains', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const csp = generateCSP(
        { resourceDomains: ['https://images.example.com', '* ; script-src *'] },
        '/script.js'
      );

      expect(csp).toContain('https://images.example.com');
      expect(csp).not.toMatch(/img-src[^;]*script-src/);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });
});
