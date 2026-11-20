#!/usr/bin/env node
/**
 * Live check against the real sites, using keys from the environment:
 *
 *   MODELGO_API_KEY=... MODELGO_AI_API_KEY=... node scripts/smoke-live.mjs
 *
 * For each site with a key it reads /v1/models, resolves every chat model the
 * way the plugin does, and reports what the shipped snapshot does not cover.
 * Read-only: it lists models and their endpoints, and sends no model request.
 * Prints model ids and counts only — never a key.
 */
import { Catalog, isChatModel } from '../lib/catalog.js';
import { resolveModel, shippedProfiles } from '../lib/profiles.js';
import { resolveSites } from '../lib/sites.js';

const catalog = new Catalog();
const profiles = shippedProfiles();
let failed = false;

for (const site of resolveSites({})) {
  const apiKey = process.env[site.apiKeyEnv];
  if (!apiKey) { console.log(`- ${site.id}: skipped, ${site.apiKeyEnv} is not set`); continue; }
  try {
    const { entries } = await catalog.get(site, apiKey);
    const chat = entries.filter(isChatModel);
    const resolved = chat.map((entry) => resolveModel(site, entry)).filter(Boolean);
    const byApi = Object.groupBy(resolved, (r) => r.model.api);
    const unknown = chat.filter((entry) => !profiles[entry.id]).map((entry) => entry.id);
    const gone = Object.keys(profiles).filter((id) => !entries.some((entry) => entry.id === id));
    console.log(`- ${site.id} (${site.baseURL}): ${entries.length} listed, ${chat.length} chat`);
    for (const [api, items] of Object.entries(byApi)) console.log(`    ${api}: ${items.length}`);
    console.log(`    publishes context_length on ${entries.filter((e) => e.contextWindow).length}, public_protocols on ${entries.filter((e) => e.protocols).length}`);
    if (unknown.length) console.log(`    not in the shipped snapshot (offered text-only, no reasoning): ${unknown.join(', ')}`);
    if (gone.length) console.log(`    in the snapshot but not listed for this key: ${gone.join(', ')}`);
    // One endpoints read per wire API, to confirm the snapshot's protocol choice is admitted.
    for (const [api, items] of Object.entries(byApi)) {
      const sample = items[0].model.id;
      const protocols = await catalog.protocolsFor(site, apiKey, sample);
      console.log(`    ${sample} → ${api}; site advertises: ${protocols ? protocols.join(', ') || '(none)' : 'endpoints listing unavailable'}`);
    }
  } catch (error) {
    failed = true;
    console.log(`- ${site.id}: FAILED ${error.code ?? ''} ${error.message}`);
  }
}
process.exitCode = failed ? 1 : 0;
