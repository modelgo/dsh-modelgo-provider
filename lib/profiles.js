/**
 * Turning a catalog entry into the pi-ai model DSH serves.
 *
 * Every fact is taken from the first source that has it:
 *
 *   1. the user's entry for that model id in `sites.<id>.models`;
 *   2. what the site itself publishes (`/v1/models`, `/v1/models/{id}/endpoints`);
 *   3. the snapshot shipped in `data/model-profiles.json` — the wire quirks no
 *      listing discloses (thinking format, level map, compat switches, output
 *      caps), with per-site corrections where the two sites differ;
 *   4. a conservative default: text only, no reasoning levels.
 *
 * The default under-claims on purpose. DSH refuses an effort a model did not
 * advertise and a provider rejects an image it cannot read, so an unknown model
 * is offered plain rather than with capabilities nobody verified.
 */
import { readFileSync } from 'node:fs';
import { PROTOCOL_TO_API } from './catalog.js';
import { baseUrlFor } from './util.js';

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 32_768;
export const APIS = Object.freeze(['openai-completions', 'anthropic-messages', 'openai-responses']);
export const LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

let shipped;
const snapshot = () => shipped ??= JSON.parse(readFileSync(new URL('../data/model-profiles.json', import.meta.url), 'utf8'));

/** The shipped snapshot, keyed by model id. */
export function shippedProfiles() { return snapshot().models; }

/**
 * Corrections that hold on one site only, keyed by model id. The two sites do
 * not always admit the same limits for the same model id.
 */
export function shippedSiteProfiles(siteId) { return snapshot().sites?.[siteId] ?? {}; }

const isClaude = (id) => /(^|\/)claude/i.test(id);

/**
 * The wire API for one model.
 * @param id - model id.
 * @param protocols - codes the site advertises for it, when known.
 * @param preferred - the snapshot's (or user's) choice, honoured while the site allows it.
 * @returns a pi-ai API id, or `undefined` when the site advertises no chat protocol.
 */
export function pickApi(id, protocols, preferred) {
  const fallback = preferred ?? (isClaude(id) ? 'anthropic-messages' : 'openai-completions');
  if (!protocols) return fallback;
  const offered = protocols.map((code) => PROTOCOL_TO_API[code]).filter(Boolean);
  if (!offered.length) return undefined;
  if (offered.includes(fallback)) return fallback;
  return APIS.find((api) => offered.includes(api));
}

/** A pi-ai `thinkingLevelMap` exposing exactly `levels`. */
function levelMap(levels) {
  const allowed = new Set(levels);
  return Object.fromEntries(LEVELS.map((level) => [level, allowed.has(level) ? level : null]));
}

/**
 * Resolve one model.
 * @param site - the resolved site (`id`, `baseURL`).
 * @param entry - the site's catalog entry; `{ id }` alone for a model the user added by hand.
 * @param options.override - the user's entry for this id, if any.
 * @param options.protocols - codes read from the endpoints listing, if it was asked.
 * @returns the pi-ai model plus which fields the user pinned, or `undefined`
 *   when the site offers this model on no chat protocol.
 */
export function resolveModel(site, entry, { override = {}, protocols, profiles = shippedProfiles(), siteProfiles = shippedSiteProfiles(site.id) } = {}) {
  const known = { ...profiles[entry.id], ...siteProfiles[entry.id] };
  const api = pickApi(entry.id, protocols ?? entry.protocols, override.api ?? known.api);
  if (!api) return undefined;

  const published = entry.input?.filter((m) => m === 'text' || m === 'image');
  const input = override.input?.length ? override.input : published?.length ? published : known.input ?? ['text'];

  const levels = override.reasoningLevels;
  const reasoning = levels ? levels.some((level) => level !== 'off') : Boolean(known.reasoning);
  const thinkingLevelMap = levels ? levelMap(levels) : known.thinkingLevelMap;

  return {
    pinnedMaxTokens: override.maxTokens,
    model: {
      id: entry.id,
      name: override.name || entry.id,
      api,
      provider: site.id,
      baseUrl: baseUrlFor(site.baseURL, api),
      reasoning,
      input,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: override.contextWindow ?? entry.contextWindow ?? known.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: override.maxTokens ?? entry.maxTokens ?? known.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(reasoning && thinkingLevelMap ? { thinkingLevelMap } : {}),
      ...(known.compat ? { compat: known.compat } : {}),
    },
  };
}
