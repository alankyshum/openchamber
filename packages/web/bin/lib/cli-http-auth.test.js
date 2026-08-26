import { afterEach, describe, expect, test } from 'bun:test';
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
});
