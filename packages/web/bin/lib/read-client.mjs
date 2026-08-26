import fs from 'node:fs';
import { requestJson } from './cli-http.js';
import { OPENCHAMBER_BROWSER_READ_ACTIONS } from '../../server/lib/openchamber-control/actions.js';

export const READ_ACTIONS = Object.freeze([...OPENCHAMBER_BROWSER_READ_ACTIONS]);
export const READ_EXIT = Object.freeze({ SUCCESS: 0, USAGE: 2, UNREACHABLE: 3, REJECTED: 4, TIMEOUT: 5, TOO_LARGE: 8 });

const MUTATIONS = new Set(['browser.click', 'browser.type', 'browser.capture']);
if (READ_ACTIONS.some((action) => MUTATIONS.has(action))) throw new Error('read action boundary contains a mutating action');

const scrub = (message) => {
  let result = String(message ?? 'Request failed');
  const secrets = [process.env.OPENCHAMBER_TOKEN, process.env.OPENCHAMBER_UI_PASSWORD].filter(Boolean);
  for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
  return result.replace(/(authorization|token|password|secret)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]');
};
const redactToken = (message, token) => token ? String(message).split(token).join('[REDACTED]') : String(message);

export const readSpec = (file) => {
  let raw;
  try {
    raw = file === '-' || !file ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  } catch {
    throw Object.assign(new Error('could not read extract spec'), { exitCode: READ_EXIT.USAGE });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('extract spec is not valid JSON'), { exitCode: READ_EXIT.USAGE });
  }
};

export async function executeRead(port, action, input, options = {}) {
  if (!READ_ACTIONS.includes(action)) {
    throw Object.assign(new Error(`Unsupported read action: ${action}`), { exitCode: READ_EXIT.USAGE });
  }
  const token = options.token || process.env.OPENCHAMBER_TOKEN;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  try {
    const { response, body } = await requestJson(port, '/api/openchamber/control', {
      ...options, headers, timeoutMs: action === 'browser.open' || action === 'browser.navigate' ? 45_000 : 20_000, method: 'POST',
      body: JSON.stringify({ action, input, mode: 'read' }),
    });
    if (response?.ok && body?.ok !== false) return body;
    const status = Number(response?.status);
    const error = redactToken(scrub(body?.error || `browser action ${action} failed`), token);
    const code = status === 413 ? READ_EXIT.TOO_LARGE : (status >= 400 && status < 500 ? READ_EXIT.REJECTED : READ_EXIT.UNREACHABLE);
    const failure = new Error(error); failure.exitCode = code; throw failure;
  } catch (error) {
    if (error?.exitCode) throw error;
    const message = redactToken(scrub(error?.message), token);
    const failure = new Error(message); failure.exitCode = /timed out/i.test(message) ? READ_EXIT.TIMEOUT : READ_EXIT.UNREACHABLE;
    throw failure;
  }
}

export const success = (action, result) => ({ ok: true, action, result });
export const failure = (error) => ({ ok: false, error: scrub(error?.message || error) });
