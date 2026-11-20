#!/usr/bin/env node
/**
 * Regenerate data/model-profiles.json from a pi `models.json`.
 *
 * The snapshot holds the wire quirks no model listing discloses (thinking
 * format, level map, compat switches). Its source of truth is the pi config
 * ModelGo already maintains in github.com/modelgo/clients; this script only
 * reshapes it, so the two cannot drift by hand-editing.
 *
 *   node scripts/import-pi-models.mjs ~/.pi/agent/models.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const source = process.argv[2];
if (!source) { console.error('usage: node scripts/import-pi-models.mjs <pi models.json>'); process.exit(2); }

const KEPT = ['contextWindow', 'maxTokens', 'input', 'reasoning', 'thinkingLevelMap', 'compat'];
const models = {};
for (const provider of Object.values(JSON.parse(readFileSync(source, 'utf8')).providers ?? {})) {
  for (const model of provider.models ?? []) {
    models[model.id] = { api: provider.api, ...Object.fromEntries(KEPT.filter((k) => k in model).map((k) => [k, model[k]])) };
  }
}
const sorted = Object.fromEntries(Object.entries(models).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const target = new URL('../data/model-profiles.json', import.meta.url);
// Per-site corrections are maintained here, not in the pi config; keep them across a regeneration.
let sites = {};
try { sites = JSON.parse(readFileSync(target, 'utf8')).sites ?? {}; } catch { /* first generation */ }
writeFileSync(target, `${JSON.stringify({ source: 'github.com/modelgo/clients pi/install.sh', models: sorted, sites }, null, 2)}\n`);
console.log(`wrote ${Object.keys(sorted).length} models`);
