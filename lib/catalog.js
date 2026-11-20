/**
 * What one ModelGo site offers to one key.
 *
 * `GET /v1/models` is filtered by the key's policy, so the cache is keyed by
 * site AND key fingerprint: two keys on the same site may see different lists.
 * Each entry carries the facts the gateway publishes about a model
 * (`context_length`, `input_modalities`, `output_modalities`,
 * `max_request_bytes`). The wire protocols a model accepts are not in that
 * listing, so they are read from `GET /v1/models/{model}/endpoints` — once per
 * model per day — because the gateway refuses a call made on a protocol the
 * model does not advertise, and because modalities alone cannot tell a chat
 * model from one served only on a non-chat surface.
 */
import { fetchJson, fingerprint, siteRoot } from './util.js';

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 1000;
// A model's protocols change far less often than the list does, and reading them costs one request per model.
const PROTOCOL_TTL_MS = 24 * 60 * 60 * 1000;
const PROTOCOL_CONCURRENCY = 8;

/** Gateway protocol code → pi-ai wire API. Only the chat surfaces DSH can drive. */
export const PROTOCOL_TO_API = Object.freeze({
  openai_chat_completions: 'openai-completions',
  anthropic_messages: 'anthropic-messages',
  openai_responses: 'openai-responses',
});

const NON_CHAT_ID = /(embedding|rerank|whisper|tts|speech|transcri|image|imagen|video|veo|seedance|seedream|kling|wan\d|t2a|sora)/i;

const stringList = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : undefined);
const positiveInt = (value) => (Number.isInteger(value) && value > 0 ? value : undefined);

/**
 * Normalize a `/v1/models` body into catalog entries, in site order.
 * @param body - `{ object: 'list', data: [...] }` as the gateway returns it.
 * @returns entries; fields the site did not publish are `undefined`.
 */
export function parseModelList(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  const seen = new Set();
  const entries = [];
  for (const item of data) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      contextWindow: positiveInt(item.context_length),
      // Not published today; read when the gateway starts sending them.
      maxTokens: positiveInt(item.max_output_tokens),
      protocols: stringList(item.public_protocols),
      input: stringList(item.input_modalities),
      output: stringList(item.output_modalities),
      maxRequestBytes: positiveInt(item.max_request_bytes),
    });
  }
  return entries;
}

/**
 * Whether an entry could be a chat model, judged from the listing alone:
 * text-only output, or the id pattern for an entry that publishes no
 * modalities. Only these are worth an endpoints read.
 */
export function mayBeChatModel(entry) {
  if (entry.output?.length) return entry.output.every((m) => m === 'text');
  return !NON_CHAT_ID.test(entry.id);
}

/**
 * Whether the picker should offer an entry. Advertised protocols decide when
 * they are known — an empty list is the gateway saying the model is offered on
 * no public surface — and the listing decides otherwise.
 */
export function isChatModel(entry) {
  if (!mayBeChatModel(entry)) return false;
  if (entry.protocols) return entry.protocols.some((code) => code in PROTOCOL_TO_API);
  return true;
}

/** Protocol codes from a `/v1/models/{model}/endpoints` body. */
export function parseEndpoints(body) {
  const data = Array.isArray(body?.data) ? body.data : [];
  return data.map((item) => item?.code).filter((code) => typeof code === 'string');
}

/** The gateway takes the query form for ids containing `/`. */
export function endpointsUrl(baseURL, model) {
  const root = siteRoot(baseURL);
  return model.includes('/')
    ? `${root}/v1/models/endpoints?model=${encodeURIComponent(model)}`
    : `${root}/v1/models/${encodeURIComponent(model)}/endpoints`;
}

export class Catalog {
  /**
   * @param options.ttlMs - how long a fetched list is served without asking again.
   * @param options.fetchImpl - injectable fetch, for tests.
   * @param options.now - injectable clock, for tests.
   * @param options.onChange - called with the site id when a refresh changed its model ids.
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, fetchImpl, now = Date.now, headers = () => ({}), onChange } = {}) {
    this.ttlMs = ttlMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.headers = headers;
    this.onChange = onChange;
    this.lists = new Map();
    this.inflight = new Map();
    this.protocols = new Map();
  }

  keyOf(site, apiKey) { return `${site.id}|${site.baseURL}|${fingerprint(apiKey)}`; }

  /** The last list fetched for this site and key, however old. */
  peek(site, apiKey) { return this.lists.get(this.keyOf(site, apiKey))?.value; }

  /** Forget fetched lists. Protocol answers are kept: they are keyed by site address and key. */
  invalidate() { this.lists.clear(); }

  /**
   * The site's model list for this key. A fresh cached list is returned as is;
   * a failed refresh serves the previous list rather than emptying the picker.
   */
  async get(site, apiKey, { signal, force = false } = {}) {
    const key = this.keyOf(site, apiKey);
    const hit = this.lists.get(key);
    const age = hit ? this.now() - hit.at : Infinity;
    if (!force && hit && age < (hit.failed ? RETRY_AFTER_FAILURE_MS : this.ttlMs)) return hit.value;
    const running = this.inflight.get(key);
    if (running) return running;
    const task = (async () => {
      try {
        const body = await fetchJson(`${site.baseURL}/v1/models`, {
          apiKey, signal, headers: { ...site.headers, ...this.headers() }, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        });
        const value = { siteId: site.id, fetchedAt: this.now(), entries: parseModelList(body) };
        await this.fillProtocols(site, apiKey, value.entries, signal);
        const before = hit?.value.entries.map((e) => e.id).join('\n');
        this.lists.set(key, { at: this.now(), value });
        if (before !== undefined && before !== value.entries.map((e) => e.id).join('\n')) this.onChange?.(site.id);
        return value;
      } catch (error) {
        if (!hit) throw error;
        // Keep serving the previous list, and ask again soon rather than on every call.
        this.lists.set(key, { at: this.now(), value: hit.value, failed: true });
        return hit.value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    return task;
  }

  /** Attach advertised protocols to every chat candidate the listing left without them. */
  async fillProtocols(site, apiKey, entries, signal) {
    const pending = entries.filter((entry) => !entry.protocols && mayBeChatModel(entry));
    for (let i = 0; i < pending.length; i += PROTOCOL_CONCURRENCY) {
      await Promise.all(pending.slice(i, i + PROTOCOL_CONCURRENCY).map(async (entry) => {
        entry.protocols = await this.protocolsFor(site, apiKey, entry.id, { signal });
      }));
    }
  }

  /**
   * Protocol codes one model advertises, or `undefined` when the site could not
   * be asked — the caller then falls back to what it ships for that model.
   */
  async protocolsFor(site, apiKey, model, { signal } = {}) {
    const key = `${this.keyOf(site, apiKey)}|${model}`;
    const hit = this.protocols.get(key);
    if (hit && this.now() - hit.at < PROTOCOL_TTL_MS) return hit.value;
    try {
      const body = await fetchJson(endpointsUrl(site.baseURL, model), {
        apiKey, signal, headers: { ...site.headers, ...this.headers() }, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      });
      const value = parseEndpoints(body);
      this.protocols.set(key, { at: this.now(), value });
      return value;
    } catch {
      return hit?.value;
    }
  }
}
