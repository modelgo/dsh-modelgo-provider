/**
 * LLM adapter for the two ModelGo routes.
 *
 * Wire protocols are served by the pi-ai SDK that DeepSeek Harness itself
 * ships, and the harness ↔ pi-ai conversion is delegated to the official
 * `PiAiAdapter`, so streaming, tool calls, reasoning replay, image budgets and
 * error classification stay identical to the built-in providers and follow DSH
 * upgrades.
 *
 * This module only turns one site's catalog into one pi-ai provider profile.
 * Each operation captures its site and settings before its first await and
 * works on one immutable snapshot, so a settings change reaches the next
 * request and never the one in flight.
 */
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { fingerprint } from './util.js';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';

const MIB = 1024 * 1024;

function piProviderFor(site, models) {
  return createProvider({
    id: site.id,
    name: site.displayName,
    baseUrl: `${site.baseURL}/v1`,
    auth: {
      apiKey: {
        name: site.displayName,
        resolve: ({ credential }) => Promise.resolve({
          auth: credential?.key === undefined ? {} : { apiKey: credential.key },
          source: site.displayName,
        }),
      },
    },
    models,
    api: {
      'openai-completions': openAICompletionsApi(),
      'openai-responses': openAIResponsesApi(),
      'anthropic-messages': anthropicMessagesApi(),
    },
  });
}

/**
 * Image payload bound for one site. The gateway publishes its inbound body cap
 * (`max_request_bytes`); half of it is left for text, tools and JSON.
 */
export function imageBytesBudget(maxRequestBytes) {
  const ceiling = 20 * MIB;
  return maxRequestBytes ? Math.max(MIB, Math.min(ceiling, Math.floor(maxRequestBytes / 2))) : ceiling;
}

export class ModelGoAdapter extends LlmAdapter {
  /** @param host - the plugin's site/credential/catalog services (see index.js). */
  constructor(host) { super(); this.host = host; this.bound = new Map(); }

  /**
   * The request path downsizes images, so the host's accounting must see the
   * same target. Answered from the route's current snapshot; before the first
   * call there is none, and the unscaled default applies.
   */
  imageRequestTarget(provider, model, image) {
    const inner = this.bound.get(provider)?.value.inner;
    try { if (inner) return inner.imageRequestTarget(provider, model, image); } catch { /* model left the list */ }
    return super.imageRequestTarget(provider, model, image);
  }

  providerInfo(provider) { return { id: provider, name: this.host.site(provider).displayName }; }
  providerRetryPolicy() { return this.host.retryPolicy(); }

  /**
   * One immutable snapshot: site, key, resolved models, and the inner adapter
   * built from them. Rebuilt only when one of those changes, so the inner
   * adapter keeps its own memoized state across the steps of a turn.
   */
  async bind(provider, signal) {
    const bound = this.host.capture(provider);
    const site = bound.site;
    const retryPolicy = this.host.retryPolicy();
    const streamIdleTimeoutMs = this.host.streamIdleTimeoutMs();
    const apiKey = await bound.requireApiKey();
    const resolved = await bound.models({ signal });
    const stamp = JSON.stringify([site, fingerprint(apiKey), resolved.stamp, streamIdleTimeoutMs, retryPolicy]);
    const cached = this.bound.get(provider);
    if (cached?.stamp === stamp) return cached.value;
    const profile = {
      provider: site.id,
      displayName: site.displayName,
      apiKeyEnv: bound.apiKeyRef,
      headers: site.headers,
      streamIdleTimeoutMs,
      maxRequestImageBytes: imageBytesBudget(resolved.maxRequestBytes),
      maxRequestImages: 50,
      imageOffloadCountQuantum: 10,
      requestImagePixelBudget: 2048 * 2048,
      requestImageMaxBytes: MIB,
      retryPolicy,
      configuredMaxTokens: new Map(resolved.items.filter((r) => r.pinnedMaxTokens).map((r) => [r.model.id, r.pinnedMaxTokens])),
      modelErrors: new Map(),
      piProvider: piProviderFor(site, resolved.items.map((r) => r.model)),
    };
    const profiles = new Map([[site.id, profile]]);
    const inner = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => apiKey,
      auth: undefined,
      resolveAttachments: this.host.resolveAttachments,
      resolveImageAccess: this.host.resolveImageAccess,
      onReplayDegrade: ({ model: id, reason }) => this.host.logger?.warn?.(`modelgo: replay degraded for ${id}: ${reason}`),
    });
    const value = { inner, resolved };
    this.bound.set(provider, { stamp, value });
    return value;
  }

  async listModels(provider) {
    const bound = this.host.capture(provider);
    let resolved;
    // No key yet, or the site is unreachable: offer nothing rather than fail the picker.
    try { resolved = await bound.models(); } catch (error) { this.host.reportError(provider, error); return []; }
    return resolved.items.map(({ model }) => ({ provider, id: model.id, name: model.name, inputModalities: model.input }));
  }

  async resolveModel(provider, model, signal) {
    const { inner } = await this.bind(provider, signal);
    return inner.resolveModel(provider, model, signal);
  }

  async prepareCall(provider, model, signal) {
    const { inner } = await this.bind(provider, signal);
    return inner.prepareCall(provider, model, signal);
  }

  async *stream(options) {
    const { inner, resolved } = await this.bind(options.provider, options.signal);
    if (!resolved.items.some((r) => r.model.id === options.model)) {
      throw new LlmError(`modelgo: "${options.provider}" offers no chat model "${options.model}"`, 'UNKNOWN_MODEL');
    }
    yield* inner.stream(options);
  }
}
