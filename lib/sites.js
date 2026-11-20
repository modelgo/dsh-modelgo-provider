/**
 * The two ModelGo sites this plugin serves.
 *
 * Route ids are fixed, never derived: a provider route is recorded in every
 * session that used it, so renaming one orphans that history. The two sites
 * issue separate keys, hence one credential reference each.
 */
import { siteRoot } from './util.js';

export const SITES = Object.freeze([
  Object.freeze({
    id: 'modelgo',
    displayName: 'ModelGo (modelgo.com)',
    baseURL: 'https://api.modelgo.com',
    apiKeyEnv: 'MODELGO_API_KEY',
    console: 'https://modelgo.com',
  }),
  Object.freeze({
    id: 'modelgo-ai',
    displayName: 'ModelGo (modelgo.ai)',
    baseURL: 'https://api.modelgo.ai',
    apiKeyEnv: 'MODELGO_AI_API_KEY',
    console: 'https://modelgo.ai',
  }),
]);

export const SITE_IDS = Object.freeze(SITES.map((site) => site.id));

/**
 * Merge the shipped site facts with the stored configuration.
 * @param raw - the plugin's resolved config section.
 * @returns every site, shipped order, with `enabled` resolved (default true).
 */
export function resolveSites(raw) {
  const stored = raw?.sites ?? {};
  return SITES.map((site) => {
    const conf = stored[site.id] ?? {};
    return {
      id: site.id,
      console: site.console,
      enabled: conf.enabled !== false,
      displayName: conf.displayName || site.displayName,
      baseURL: siteRoot(conf.baseURL || site.baseURL),
      apiKeyEnv: conf.apiKeyEnv || site.apiKeyEnv,
      headers: { ...(conf.headers ?? {}) },
      // Explicit list replaces discovery, as on the built-in providers; empty serves what the site lists.
      models: Array.isArray(conf.models) ? conf.models.filter((m) => m && typeof m.id === 'string' && m.id) : [],
    };
  });
}
