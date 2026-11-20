/**
 * Shared helpers: site URLs, bounded HTTP, secret redaction.
 */

/** Site root without trailing slash or version segment (`https://api.modelgo.com`). */
export function siteRoot(baseURL) {
  return String(baseURL ?? '').trim().replace(/\/+$/, '').replace(/\/v\d+$/, '');
}

/** SDK base per pi-ai wire API: OpenAI protocols under /v1, Anthropic Messages at the root. */
export function baseUrlFor(baseURL, api) {
  const root = siteRoot(baseURL);
  return api === 'anthropic-messages' ? root : `${root}/v1`;
}

/** Replace every occurrence of a secret (and anything shaped like a ModelGo key) in text. */
export function redact(text, secret) {
  let out = String(text ?? '');
  if (secret) out = out.split(secret).join('<redacted>');
  return out.replace(/mgk_[A-Za-z0-9_-]{8,}/g, 'mgk_<redacted>');
}

/** Stable short fingerprint of a secret, for cache keys (never the secret itself). */
export function fingerprint(secret) {
  let h = 2166136261;
  for (const ch of String(secret ?? '')) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * Wait for a shared promise on behalf of one caller: the caller's abort ends
 * its wait without cancelling the work others are waiting on.
 */
export function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class SiteError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'SiteError';
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * Fetch JSON from a ModelGo site. Redirects are not followed, so the bearer
 * token is never replayed to another host. Every error message is redacted.
 */
export async function fetchJson(url, { apiKey, headers = {}, timeoutMs = 15_000, signal, maxBytes = 8 * 1024 * 1024, fetchImpl = fetch } = {}) {
  const clean = (message) => redact(message, apiKey);
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.any(signals),
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...headers,
      },
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError';
    throw new SiteError(clean(`${timedOut ? 'timed out' : 'network error'} calling ${url}: ${error?.message ?? error}`), timedOut ? 'TIMEOUT' : 'UNREACHABLE');
  }
  if (res.status >= 300 && res.status < 400) {
    throw new SiteError(clean(`${url} redirected to ${res.headers.get('location') ?? '?'}; check the base URL`), 'REDIRECT', { status: res.status });
  }
  const text = await res.text();
  if (text.length > maxBytes) throw new SiteError(`response from ${url} is larger than ${maxBytes} bytes`, 'TOO_LARGE', { status: res.status });
  let json;
  try { json = text.length > 0 ? JSON.parse(text) : undefined; } catch { json = undefined; }
  if (!res.ok) {
    const message = json?.error?.message ?? json?.message ?? text.slice(0, 300);
    const code = res.status === 401 || res.status === 403 ? 'AUTH' : res.status === 429 ? 'RATE_LIMIT' : res.status >= 500 ? 'SERVER' : 'HTTP';
    throw new SiteError(clean(`HTTP ${res.status} from ${url}: ${message}`), code, { status: res.status });
  }
  if (json === undefined) throw new SiteError(`${url} returned a non-JSON body`, 'BAD_RESPONSE', { status: res.status });
  return json;
}
