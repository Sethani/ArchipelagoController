import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { caddyfile, validateGatewayConfig } = require('./https-gateway.cjs');

describe('managed HTTPS gateway', () => {
  it('validates and renders a constrained localhost proxy', () => {
    expect(validateGatewayConfig({ hostname: 'Rooms.Example.net', email: 'host@example.net', upstreamPort: 38282, gamePort: 38290, compatibilityBindHost: '192.168.1.20' }))
      .toEqual({ hostname: 'rooms.example.net', email: 'host@example.net', upstreamPort: 38282, gamePort: 38290, compatibilityBindHost: '192.168.1.20', compatibilityPort: 38281 });
    const config = caddyfile({ hostname: 'rooms.example.net', email: 'host@example.net', upstreamPort: 38282, gamePort: 38290, compatibilityBindHost: '192.168.1.20' });
    expect(config).toContain('rooms.example.net {');
    expect(config).toContain('reverse_proxy 127.0.0.1:38282');
    expect(config).toContain('reverse_proxy @archipelago_websocket 127.0.0.1:38290');
    expect(config).toContain('https://rooms.example.net:38281');
    expect(config).toContain('bind 192.168.1.20');
    expect(config).toContain('reverse_proxy 127.0.0.1:38290');
    expect(config).not.toContain('0.0.0.0:38282');
  });

  it('rejects values that could escape the generated configuration', () => {
    expect(() => validateGatewayConfig({ hostname: 'example.net\nimport bad', email: 'host@example.net', upstreamPort: 38282, gamePort: 38281 })).toThrow();
    expect(() => validateGatewayConfig({ hostname: 'example.net', email: 'bad\n}', upstreamPort: 38282, gamePort: 38281 })).toThrow();
    expect(() => validateGatewayConfig({ hostname: 'localhost', email: 'host@example.net', upstreamPort: 38282, gamePort: 38281 })).toThrow();
    expect(() => validateGatewayConfig({ hostname: 'example.net', email: 'host@example.net', upstreamPort: 38282, gamePort: 38281, compatibilityBindHost: 'not-an-ip' })).toThrow();
  });
});
