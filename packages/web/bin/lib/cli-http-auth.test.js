import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { requestJson } from './cli-http.js';

describe('CLI credential egress boundary', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('does not contact a foreign server when a bearer token is configured', async () => {
    let contacted = false;
    globalThis.fetch = async () => {
      contacted = true;
      throw new Error('attacker listener contacted');
    };

    await expect(requestJson(3000, '/api/openchamber/control', {
      server: 'http://attacker.invalid:39991',
      token: 'secret-token',
      headers: { Authorization: 'Bearer secret-token' },
    })).rejects.toThrow(/untrusted server/);
    expect(contacted).toBe(false);
  });

  test('does not contact a foreign server when only a UI password is configured', async () => {
    let contacted = false;
    globalThis.fetch = async () => {
      contacted = true;
      throw new Error('attacker listener contacted');
    };

    await expect(requestJson(3000, '/api/openchamber/control', {
      server: 'https://attacker.invalid',
      uiPassword: 'secret-password',
    })).rejects.toThrow(/untrusted server/);
    expect(contacted).toBe(false);
  });

  test('treats credential header names case-insensitively', async () => {
    let contacted = false;
    globalThis.fetch = async () => {
      contacted = true;
      throw new Error('attacker listener contacted');
    };

    await expect(requestJson(3000, '/api/openchamber/control', {
      server: 'https://attacker.invalid',
      headers: { aUtHoRiZaTiOn: 'Bearer secret-token' },
    })).rejects.toThrow(/untrusted server/);
    expect(contacted).toBe(false);
  });

  test('does not retry an off-policy 401', async () => {
    const requests = [];
    const realFetch = globalThis.fetch;
    const server = createServer((request, response) => {
      requests.push({ url: request.url, headers: request.headers });
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'UI authentication required' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      // Keep the URL under test off-policy while routing the probe to a local
      // listener, so this exercises the real fetch boundary without network.
      globalThis.fetch = (input, init) => {
        const localUrl = new URL(input);
        localUrl.protocol = 'http:';
        localUrl.hostname = '127.0.0.1';
        localUrl.port = String(port);
        return realFetch(localUrl, init);
      };
      const result = await requestJson(3000, '/api/openchamber/control', { server: 'https://attacker.invalid' });
      expect(result.response.status).toBe(401);
      expect(requests).toHaveLength(1);
      expect(requests[0].headers.cookie).toBeUndefined();
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
