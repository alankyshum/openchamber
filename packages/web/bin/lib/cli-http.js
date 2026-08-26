import { buildLocalUrl } from './cli-network.js';
import { readDesktopLocalClientTokenFromSettings, readDesktopLocalPortFromSettings } from './cli-paths.js';
import { getInstanceFilePath, readInstanceOptions } from './cli-process.js';

const UI_SESSION_COOKIE_NAME = 'oc_ui_session';

const isTrustedAuthOrigin = (requestUrl) => {
  try {
    const parsed = new URL(requestUrl);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname === 'localhost' || hostname === '::1') return true;
    // URL canonicalizes IPv4 shorthand and leading-zero forms (for example
    // `127.1.2` becomes `127.1.0.2`). Inspect the authority as supplied too,
    // so only an actual four-octet IPv4 literal is trusted.
    const authority = requestUrl.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1] ?? '';
    const rawHostname = authority.replace(/^[^@]*@/, '').replace(/^\[([^\]]+)\](?::\d*)?$/, '$1').split(':')[0].toLowerCase();
    if (rawHostname !== hostname && rawHostname.startsWith('127.')) return false;
    const octets = hostname.split('.');
    return octets.length === 4
      && octets[0] === '127'
      && octets.slice(1).every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet)
        && Number(octet) <= 255);
  } catch {
    return false;
  }
};

export { isTrustedAuthOrigin };

function extractUiSessionCookie(response) {
  const values = [];
  const direct = response?.headers?.get?.('set-cookie');
  if (typeof direct === 'string' && direct.length > 0) {
    values.push(direct);
  }
  const getSetCookie = response?.headers?.getSetCookie;
  if (typeof getSetCookie === 'function') {
    const setCookies = getSetCookie.call(response.headers);
    if (Array.isArray(setCookies)) {
      values.push(...setCookies.filter((value) => typeof value === 'string' && value.length > 0));
    }
  }
  const raw = response?.headers?.raw?.();
  if (Array.isArray(raw?.['set-cookie'])) {
    values.push(...raw['set-cookie'].filter((value) => typeof value === 'string' && value.length > 0));
  }

  for (const setCookie of values) {
    const match = setCookie.match(new RegExp(`(?:^|,\\s*)(${UI_SESSION_COOKIE_NAME}=[^;]+)`));
    if (match?.[1]) return match[1];
  }
  return null;
}

async function resolveUiPasswordForPort(port, options = {}) {
  if (options.explicitUiPassword && typeof options.uiPassword === 'string' && options.uiPassword.trim().length > 0) {
    return options.uiPassword;
  }
  const instanceOptions = readInstanceOptions(await getInstanceFilePath(port));
  if (typeof instanceOptions?.uiPassword === 'string' && instanceOptions.uiPassword.trim().length > 0) {
    return instanceOptions.uiPassword;
  }
  return typeof options.uiPassword === 'string' && options.uiPassword.trim().length > 0
    ? options.uiPassword
    : null;
}

async function createUiSessionCookie(port, password, timeoutMs) {
  if (typeof password !== 'string' || password.length === 0) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildLocalUrl(port, '/auth/session'), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password }),
      signal: controller.signal,
      redirect: 'manual',
    });
    if (!response.ok) {
      return null;
    }
    return extractUiSessionCookie(response);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function getDesktopLocalAuthHeader(port, requestHeaders) {
  if (requestHeaders.Authorization || requestHeaders.authorization) {
    return null;
  }
  const desktopPort = readDesktopLocalPortFromSettings();
  if (desktopPort !== port) {
    return null;
  }
  const token = readDesktopLocalClientTokenFromSettings();
  return token ? `Bearer ${token}` : null;
}

async function requestServerShutdown(port, hostOverride) {
  if (!Number.isFinite(port) || port <= 0) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const resp = await fetch(buildLocalUrl(port, '/api/system/shutdown', hostOverride), {
      method: 'POST',
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(port, endpoint, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : 4000;
  const fetchOptions = { ...options };
  delete fetchOptions.timeoutMs;
  delete fetchOptions.uiPassword;
  delete fetchOptions.server;
  delete fetchOptions.token;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const requestUrl = typeof options.server === 'string' && options.server.trim()
      ? new URL(endpoint, `${options.server.replace(/\/$/, '')}/`).toString()
      : buildLocalUrl(port, endpoint);
    const requestHeaders = {
      Accept: 'application/json',
      ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
      ...(fetchOptions.headers || {}),
    };
    const desktopAuth = getDesktopLocalAuthHeader(port, requestHeaders);
    if (desktopAuth) {
      requestHeaders.Authorization = desktopAuth;
    }
    // An explicitly selected server is untrusted until proven local. Never let
    // a token, desktop credential, or session password turn an arbitrary URL
    // into a credential sink (this also covers OPENCHAMBER_URL).
    const hasCredential = Boolean(requestHeaders.Authorization || requestHeaders.authorization
      || requestHeaders.Cookie || requestHeaders.cookie
      || options.uiPassword || options.token || process.env.OPENCHAMBER_TOKEN);
    if (hasCredential && !isTrustedAuthOrigin(requestUrl)) {
      throw new Error('Refusing to send credentials to an untrusted server; use a trusted loopback or desktop origin.');
    }
    const response = await fetch(requestUrl, {
      ...fetchOptions,
      headers: requestHeaders,
      signal: controller.signal,
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Refusing redirected response from ${requestUrl}.`);
    }
    const body = await response.json().catch(() => null);
    if (response.status === 401 && body?.error === 'UI authentication required') {
      const uiPassword = await resolveUiPasswordForPort(port, options);
      const cookie = await createUiSessionCookie(port, uiPassword, timeoutMs);
      if (cookie) {
        const retryResponse = await fetch(requestUrl, {
          ...fetchOptions,
          headers: {
            ...requestHeaders,
            Cookie: cookie,
          },
          signal: controller.signal,
          redirect: 'manual',
        });
        if (retryResponse.status >= 300 && retryResponse.status < 400) {
          throw new Error(`Refusing redirected response from ${requestUrl}.`);
        }
        const retryBody = await retryResponse.json().catch(() => null);
        return { response: retryResponse, body: retryBody };
      }
    }
    return { response, body };
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) {
      throw new Error(`Request to ${endpoint} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function isServerHealthReady(port, timeoutMs = 1000) {
  if (!Number.isFinite(port) || port <= 0) {
    return false;
  }
  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 1000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeout);
  try {
    const response = await fetch(buildLocalUrl(port, '/health'), {
      headers: { Accept: 'text/plain' },
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServerHealth(port, {
  timeoutMs = 60000,
  intervalMs = 250,
  onTick,
} = {}) {
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const elapsedMs = Date.now() - start;
    if (typeof onTick === 'function') {
      onTick({ elapsedMs, timeoutMs });
    }
    if (await isServerHealthReady(port, Math.min(1000, intervalMs * 2))) {
      if (typeof onTick === 'function') {
        onTick({ elapsedMs: Math.min(Date.now() - start, timeoutMs), timeoutMs, complete: true });
      }
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (typeof onTick === 'function') {
    onTick({ elapsedMs: timeoutMs, timeoutMs, timedOut: true });
  }
  return false;
}


async function fetchTunnelProvidersFromPort(port, fetchImpl = globalThis.fetch) {
  if (!Number.isFinite(port) || port <= 0 || typeof fetchImpl !== 'function') {
    return null;
  }
  try {
    const response = await fetchImpl(buildLocalUrl(port, '/api/openchamber/tunnel/providers'));
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || !Array.isArray(body.providers)) return null;
    return body.providers;
  } catch {
    return null;
  }
}

async function fetchSystemInfoFromPort(port, fetchImpl = globalThis.fetch, hostOverride) {
  if (!Number.isFinite(port) || port <= 0 || typeof fetchImpl !== 'function') {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(buildLocalUrl(port, '/api/system/info', hostOverride), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    if (!body || typeof body.runtime !== 'string') return null;

    return {
      runtime: body.runtime,
      pid: Number.isFinite(body.pid) ? body.pid : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}


export {
  requestServerShutdown,
  requestJson,
  isServerHealthReady,
  waitForServerHealth,
  fetchTunnelProvidersFromPort,
  fetchSystemInfoFromPort,
};
