/**
 * ModelGo provider for DeepSeek Harness.
 *
 * Registers one provider route per ModelGo site — `modelgo` (api.modelgo.com)
 * and `modelgo-ai` (api.modelgo.ai) — so each site is its own group in the
 * model picker with its own key. Models come from the site's `/v1/models`,
 * filtered to what that key may use.
 *
 * Keys are credential references resolved per request through the DSH
 * credential service; this plugin never stores or logs a key value.
 */
import z from '@deepseek-ai/schemastery';
import {
  LlmError, RetryPolicySchema, assertUsableApiKey, attributionHeaders, resolveImageAttachmentAccess, resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { ModelGoAdapter } from './lib/adapter.js';
import { Catalog, DEFAULT_TTL_MS, isChatModel } from './lib/catalog.js';
import { APIS, LEVELS, resolveModel } from './lib/profiles.js';
import { SITES, resolveSites } from './lib/sites.js';
import { redact, siteRoot } from './lib/util.js';

export const name = 'modelgo';
export const inject = ['llm'];

const Model = z.object({
  id: z.string().required().description('Model id as the site lists it.'),
  name: z.string().description('Display name in the model picker.'),
  contextWindow: z.number().step(1).min(1).description('Context window in tokens; overrides what the site publishes.'),
  maxTokens: z.number().step(1).min(1).description('Maximum output tokens, sent as the per-request cap.'),
  input: z.array(z.union(['text', 'image'])).default(undefined).description('Input types the model accepts.'),
  reasoningLevels: z.array(z.union([...LEVELS])).default(undefined).description('Reasoning levels to offer. Only list levels the model accepts.'),
  api: z.union([...APIS]).description('Force the wire protocol for this model.'),
});

// A factory, not a shared instance: each site carries its own description and key reference.
const siteSchema = (site) => z.object({
  enabled: z.boolean().default(true).description('Show this site in the model picker.'),
  displayName: z.string().description('Group heading in the model picker.'),
  baseURL: z.string().description('Site address, with or without /v1.'),
  // Defaulted here, not only in code, so Settings → Models can show whether this site's key is set.
  apiKeyEnv: z.string().role('credential-ref').default(site.apiKeyEnv).description('Credential reference holding this site\'s key.'),
  headers: z.dict(z.string()).description('Extra HTTP headers for this site only.'),
  models: z.array(Model).default([]).description('Empty serves every chat model the site lists for your key. A non-empty list serves exactly these.'),
});

export const Config = z.object({
  sites: z.object(Object.fromEntries(SITES.map((site) => [site.id, siteSchema(site).description(`${site.displayName} — ${site.baseURL}`)])))
    .description('The two ModelGo sites. Their keys are separate.'),
  catalogTtlMs: z.number().min(10_000).default(DEFAULT_TTL_MS).description('How long a fetched model list is reused before the site is asked again.'),
  streamIdleTimeoutMs: z.number().min(1000).max(2147483647).default(300_000).description('Abort a model stream that stays silent this long.'),
  retryPolicy: RetryPolicySchema,
}).volatile();

export function apply(ctx, config) {
  const settingsNs = ctx.fiber.entry?.options.id ?? name;
  const current = () => (typeof config?.get === 'function' ? config.get() : config) ?? {};
  // One log line per distinct failure per site, not one per picker refresh.
  const lastError = new Map();
  const reportError = (scope, error) => {
    const line = `${error?.code ?? 'ERROR'}: ${redact(error?.message ?? error)}`;
    if (lastError.get(scope) === line) return;
    lastError.set(scope, line);
    ctx.logger.warn(`modelgo: ${scope}: ${line}`);
  };

  let sitesMemo;
  const sites = () => {
    const raw = current();
    if (sitesMemo?.raw !== raw) sitesMemo = { raw, value: resolveSites(raw) };
    return sitesMemo.value;
  };
  const siteFor = (provider) => {
    const site = sites().find((s) => s.id === provider);
    if (!site) throw new LlmError(`modelgo: no site owns the provider route "${provider}"`, 'UNKNOWN_PROVIDER');
    return site;
  };

  const keyFor = async (site) => {
    const ref = credentialRef(site.apiKeyEnv);
    const stored = (await ctx.get('credentials')?.resolve(ref))?.value;
    // Headless and bare compositions may mount no credential service; the launching environment still answers.
    const value = stored ?? process.env[site.apiKeyEnv];
    if (!value) {
      throw new LlmError(
        `modelgo: no key for ${site.displayName}. Open Settings → Models, expand "${site.displayName}" and paste a key (create one at ${site.console}). Keys from the other ModelGo site do not work here.`,
        'MISSING_CREDENTIAL',
      );
    }
    return assertUsableApiKey(value, 'modelgo', ref);
  };

  const catalog = new Catalog({
    ttlMs: current().catalogTtlMs ?? DEFAULT_TTL_MS,
    headers: () => attributionHeaders(),
    onChange: (siteId) => { try { ctx.emit('llm/models-updated', siteId); } catch (error) { ctx.logger.warn(error); } },
    onError: (siteId, error) => reportError(siteId, error),
  });

  const listFor = async (site, apiKey, opts) => {
    try {
      const listed = await catalog.get(site, apiKey, opts);
      lastError.delete(site.id);
      return listed;
    } catch (error) {
      // The caller gave up; that is not a site failure.
      if (opts?.signal?.aborted) throw error;
      throw new LlmError(redact(`modelgo: cannot read the model list from ${site.baseURL}: ${error.message}`, apiKey), error.code === 'AUTH' ? 'AUTH' : 'TRANSPORT', { cause: error });
    }
  };

  /** The models one site serves for this key, resolved to pi-ai models. */
  const modelsFor = async (site, apiKey, { signal } = {}) => {
    const explicit = site.models;
    let listed;
    try { listed = await listFor(site, apiKey, { signal }); } catch (error) { if (!explicit.length || signal?.aborted) throw error; }
    const byId = new Map((listed?.entries ?? []).map((entry) => [entry.id, entry]));
    const wanted = explicit.length
      ? explicit.map((override) => ({ entry: byId.get(override.id) ?? { id: override.id }, override }))
      : [...byId.values()].filter(isChatModel).map((entry) => ({ entry, override: undefined }));
    const items = wanted.map(({ entry, override }) => resolveModel(site, entry, { override })).filter(Boolean);
    const caps = (listed?.entries ?? []).map((e) => e.maxRequestBytes).filter(Boolean);
    return { items, stamp: listed?.fetchedAt ?? 0, maxRequestBytes: caps.length ? Math.min(...caps) : undefined };
  };

  // Capture site, address, headers, overrides and credential reference before any await.
  const capture = (provider) => {
    const site = structuredClone(siteFor(provider));
    let key;
    const requireApiKey = () => key ??= keyFor(site);
    return {
      site,
      apiKeyRef: credentialRef(site.apiKeyEnv),
      requireApiKey,
      models: async (opts) => modelsFor(site, await requireApiKey(), opts),
    };
  };

  const adapter = new ModelGoAdapter({
    site: siteFor,
    capture,
    reportError,
    logger: ctx.logger,
    retryPolicy: () => resolveRetryPolicy(current().retryPolicy, 'modelgo retryPolicy'),
    streamIdleTimeoutMs: () => current().streamIdleTimeoutMs ?? 300_000,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
  });

  // ------------------------------------------------------------ provider routes
  // One route per enabled site. Both registrations are kept and replaced in
  // place, so enabling or disabling a site never remounts the plugin.
  let registration;
  let registeredRoutes = [];
  let directory;
  let directoryKey;
  // Registering publishes `llm/adapters-updated` synchronously, which lands back here.
  let registering = false;
  const ensureRegistration = () => {
    if (registering) return;
    registering = true;
    try { syncRegistration(); } finally { registering = false; }
  };
  const syncRegistration = () => {
    const enabled = sites().filter((site) => site.enabled);
    const routes = enabled.map((site) => site.id);
    const entries = enabled.map((site) => ({
      provider: site.id,
      displayName: site.displayName,
      settingsNs,
      settingsPath: ['sites', site.id],
      declared: false,
      defaultBaseURL: site.baseURL,
    }));
    const key = JSON.stringify(entries);
    try {
      if (directoryKey !== key) {
        if (!entries.length) { directory?.(); directory = undefined; }
        else if (directory) directory.replace(entries);
        else directory = ctx.llm.registerConfigurableProviders(entries);
        directoryKey = key;
      }
    } catch (error) {
      ctx.logger.warn(`modelgo: provider directory not updated: ${error.message}`);
    }
    if (registeredRoutes.length === routes.length && registeredRoutes.every((r, i) => r === routes[i])) return;
    try {
      if (!routes.length) { registration?.(); registration = undefined; }
      else if (registration) registration.replace(routes);
      else registration = ctx.llm.registerAdapter(routes, adapter);
      registeredRoutes = routes;
    } catch (error) {
      // Another adapter holds a route; `llm/adapters-updated` retries once it is released.
      ctx.logger.warn(`modelgo: provider routes are not all available yet (${error.code ?? error.message})`);
    }
  };
  ensureRegistration();
  ctx.effect(() => () => {
    registration?.(); registration = undefined; registeredRoutes = [];
    directory?.(); directory = undefined; directoryKey = undefined;
  });
  ctx.on('llm/adapters-updated', () => {
    const routes = sites().filter((site) => site.enabled).map((site) => site.id);
    if (routes.length !== registeredRoutes.length || routes.some((r, i) => r !== registeredRoutes[i])) ensureRegistration();
  });
  // A key saved or removed in Settings changes what a site offers: tell the picker.
  ctx.on('credentials/reference-updated', (ref) => {
    for (const site of sites()) {
      if (site.apiKeyEnv !== String(ref)) continue;
      lastError.delete(site.id);
      try { ctx.emit('llm/models-updated', site.id); } catch (error) { ctx.logger.warn(error); }
    }
  });
  ctx.on('loader/volatile-update', () => {
    sitesMemo = undefined;
    catalog.ttlMs = current().catalogTtlMs ?? DEFAULT_TTL_MS;
    catalog.invalidate();
    try { ensureRegistration(); } catch (error) { ctx.logger.error(error); }
  });

  // ------------------------------------------------------------ model discovery
  // Answers the settings surface's "fetch available models" for either site.
  if (typeof ctx.llm.registerModelDiscovery === 'function') {
    ctx.effect(() => ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
      const root = request.baseURL ? siteRoot(request.baseURL) : undefined;
      const known = sites().find((s) => s.id === request.provider) ?? sites().find((s) => s.baseURL === root);
      if (!known) throw new LlmError('modelgo: model discovery needs one of the two ModelGo sites', 'UNKNOWN_PROVIDER');
      const site = { ...structuredClone(known), ...(root ? { baseURL: root } : {}) };
      const apiKey = request.apiKey ? assertUsableApiKey(request.apiKey, 'modelgo', site.apiKeyEnv) : await keyFor(site);
      const listed = await listFor(site, apiKey, { signal, force: true });
      return listed.entries.filter(isChatModel).map((entry) => {
        const { model } = resolveModel(site, entry) ?? {};
        return model && { id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens, inputModalities: model.input };
      }).filter(Boolean);
    }));
  }
}
