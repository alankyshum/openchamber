import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRead, failure, READ_ACTIONS, READ_EXIT, readSpec } from './read-client.mjs';
import * as http from './cli-http.js';

vi.mock('./cli-http.js', () => ({ requestJson: vi.fn() }));

describe('read browser client boundary', () => {
  it('contains only the server read allowlist', () => {
    expect(READ_ACTIONS).toEqual([
      'browser.open', 'browser.navigate', 'browser.snapshot', 'browser.extract',
      'browser.scroll', 'browser.scrollWithin', 'browser.inspect',
      'browser.back', 'browser.forward', 'browser.resize',
    ]);
    expect(READ_ACTIONS).not.toContain('browser.click');
    expect(READ_ACTIONS).not.toContain('browser.type');
    expect(READ_ACTIONS).not.toContain('browser.capture');
  });

  it('cannot smuggle a mutating action through the client', async () => {
    await expect(executeRead(3000, 'browser.click', { selector: '#submit' }))
      .rejects.toThrow('Unsupported read action');
    expect(http.requestJson).not.toHaveBeenCalled();
  });

  it('always sends read mode and never prints the bearer token', async () => {
    process.env.OPENCHAMBER_TOKEN = 'super-secret-token';
    http.requestJson.mockResolvedValue({ response: { ok: false, status: 400 }, body: { error: 'bad super-secret-token' } });
    await expect(executeRead(3000, 'browser.snapshot', {})).rejects.toMatchObject({ exitCode: READ_EXIT.REJECTED });
    const request = http.requestJson.mock.calls[0][2];
    expect(request.headers.Authorization).toBe('Bearer super-secret-token');
    expect(request.body).toContain('"mode":"read"');
    expect(failure(new Error('bad super-secret-token')).error).not.toContain('super-secret-token');
    delete process.env.OPENCHAMBER_TOKEN;
  });

  it('turns a browser-level read failure into the stable error envelope', async () => {
    http.requestJson.mockResolvedValue({ response: { ok: true, status: 200 }, body: { ok: false, error: 'invalid selector' } });
    await expect(executeRead(3000, 'browser.snapshot', {})).rejects.toMatchObject({ exitCode: READ_EXIT.UNREACHABLE });
  });

  it('reads an extract spec from a JSON file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'openchamber-read-cli-'));
    const file = join(directory, 'spec.json');
    try {
      writeFileSync(file, '{"itemSelector":"article","fields":[{"name":"title","from":"text"}]}');
      expect(readSpec(file)).toEqual({
        itemSelector: 'article',
        fields: [{ name: 'title', from: 'text' }],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('classifies only loopback origins as credential-trusted', () => {
    expect(http.isTrustedAuthOrigin('http://127.0.0.1:39991')).toBe(true);
    expect(http.isTrustedAuthOrigin('http://localhost:39991')).toBe(true);
    expect(http.isTrustedAuthOrigin('http://attacker.invalid:39991')).toBe(false);
    expect(http.isTrustedAuthOrigin('https://192.168.1.10:39991')).toBe(false);
  });
});
