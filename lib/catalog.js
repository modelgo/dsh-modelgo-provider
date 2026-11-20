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
import { fetchJson, fingerprint, raceAbort, siteRoot } from './util.js';

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
// How soon a failed or incomplete refresh is tried again.
const RETRY_MS = 30 * 1000;
// A model's protocols change far less often than the list does, and reading them costs one request per model.
const PROTOCOL_TTL_MS = 24 * 60 * 60 * 1000;
const PROTOCOL_CONCURRENCY = 8;
// A model whose endpoints read failed is not asked again within this window.
const PROTOCOL_RETRY_MS = 60 * 1000;
// Total time one refresh may spend reading protocols before serving what it has.
const PROTOCOL_FILL_DEADLINE_MS = 20 * 1000;

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
   * @param options.onError - called with the site id and error when a refresh fails.
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, fetchImpl, now = Date.now, headers = () => ({}), onChange, onError } = {}) {
    this.ttlMs = ttlMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.headers = headers;
    this.onChange = onChange;
    this.onError = onError;
    this.lists = new Map();
    this.inflight = new Map();
    this.protocols = new Map();
  }

  keyOf(site, apiKey) { return `${site.id}|${site.baseURL}|${fingerprint(apiKey)}`; }

  /** Forget fetched lists. Protocol answers are kept: they are keyed by site address and key. */
  invalidate() { this.lists.clear(); }

  /** Resolves once every refresh in flight has finished, whatever its outcome. */
  async settled() { await Promise.allSettled([...this.inflight.values()]); }

  /**
   * The site's model list for this key.
   *
   * A cached list is returned at once. Past its TTL it is still returned at
   * once and refreshed in the background, so only the first read for a key
   * waits on the network. `force` always asks the site and reports its failure.
   * A key the site rejects drops the cached list: a revoked key must not keep
   * a full picker.
   */
  async get(site, apiKey, { signal, force = false } = {}) {
    const key = this.keyOf(site, apiKey);
    const hit = this.lists.get(key);
    if (hit && !force) {
      const lifetime = hit.failed || hit.partial ? RETRY_MS : this.ttlMs;
      if (this.now() - hit.at >= lifetime) this.refresh(site, apiKey, key).catch(() => {});
      return hit.value;
    }
    return raceAbort(this.refresh(site, apiKey, key), signal);
  }

  /**
   * One shared refresh per site and key. It is bound to no caller's signal: a
   * caller that gives up stops waiting, and the others still get the list.
   */
  refresh(site, apiKey, key) {
    const running = this.inflight.get(key);
    if (running) return running;
    const task = (async () => {
      const hit = this.lists.get(key);
      try {
        const body = await fetchJson(`${site.baseURL}/v1/models`, this.request(site, apiKey));
        const value = { siteId: site.id, fetchedAt: this.now(), entries: parseModelList(body) };
        const complete = await this.fillProtocols(site, apiKey, value.entries);
        this.lists.set(key, { at: this.now(), value, partial: !complete });
        const ids = (list) => list.entries.filter(isChatModel).map((e) => e.id).join('\n');
        if (hit && ids(hit.value) !== ids(value)) this.onChange?.(site.id);
        return value;
      } catch (error) {
        if (error.code === 'AUTH') this.lists.delete(key);
        else if (hit) this.lists.set(key, { at: this.now(), value: hit.value, failed: true });
        this.onError?.(site.id, error);
        throw error;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, task);
    return task;
  }

  request(site, apiKey, signal) {
    return { apiKey, signal, headers: { ...site.headers, ...this.headers() }, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) };
  }

  /**
   * Attach advertised protocols to every chat candidate the listing left without them.
   * @returns whether every candidate got an answer; a `false` list is retried soon.
   */
  async fillProtocols(site, apiKey, entries) {
    const pending = entries.filter((entry) => !entry.protocols && mayBeChatModel(entry));
    const deadline = AbortSignal.timeout(PROTOCOL_FILL_DEADLINE_MS);
    for (let i = 0; i < pending.length; i += PROTOCOL_CONCURRENCY) {
      await Promise.all(pending.slice(i, i + PROTOCOL_CONCURRENCY).map(async (entry) => {
        entry.protocols = await this.protocolsFor(site, apiKey, entry.id, { signal: deadline });
      }));
    }
    return pending.every((entry) => entry.protocols);
  }

  /**
   * Protocol codes one model advertises, or `undefined` when the site could not
   * be asked — the caller then falls back to what it ships for that model.
   */
  async protocolsFor(site, apiKey, model, { signal } = {}) {
    const key = `${this.keyOf(site, apiKey)}|${model}`;
    const hit = this.protocols.get(key);
    if (hit && this.now() - hit.at < (hit.failed ? PROTOCOL_RETRY_MS : PROTOCOL_TTL_MS)) return hit.value;
    if (signal?.aborted) return hit?.value;
    try {
      const value = parseEndpoints(await fetchJson(endpointsUrl(site.baseURL, model), this.request(site, apiKey, signal)));
      this.protocols.set(key, { at: this.now(), value });
      return value;
    } catch {
      // Remember the miss briefly, keeping an earlier answer if there was one.
      this.protocols.set(key, { at: this.now(), value: hit?.value, failed: true });
      return hit?.value;
    }
  }
}
