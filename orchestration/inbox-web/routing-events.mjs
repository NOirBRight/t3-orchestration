import { privateText } from './config.mjs';
import { ROUTE_TYPES } from './routing.mjs';
import { deliverExternalReport, loadCampaignMeta } from '../scripts/orchestrator-target.mjs';

// Routing/model setting changes are reported to the Campaign orchestrator through the
// transports that already exist for Inbox answers and execution reports:
// - t3-thread: the Campaign's private webhook file (`webhooks/<id>.url`), same path as answers.
// - external: the signed queue-only report endpoint (`private/orchestrators/<ref>.json`),
//   sent by the same orch-report helper so `report.mjs verify` accepts it.
// The body carries only public routing data: no URLs, tokens, or webhook addresses.

export const ROUTING_EVENT_KIND = 'routing-change';
export const ROUTING_EVENT_SCHEMA = 'orch-report/1';
const DELIVERY_TIMEOUT_MS = 5000;
const ACTOR_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{0,31}$/;
const SCOPES = ['global', 'machine', 'campaign'];

/** UI saves send a browser Origin; CLI/Hub/API callers pass their own actor or fall back to api. */
export function routingActor(value, { origin } = {}) {
  const actor = typeof value === 'string' ? value.trim() : '';
  if (ACTOR_PATTERN.test(actor)) return actor;
  return origin ? 'ui' : 'api';
}

function routeTiers(layer, type) {
  const block = layer?.routes?.[type];
  if (!block || !Array.isArray(block.tiers)) return null;
  return block.tiers.map(tier => ({
    instanceId: tier.instanceId,
    model: tier.model,
    options: (tier.options || []).map(option => ({ id: option.id, value: option.value })),
  }));
}

function diffRoutes(before, after) {
  const routes = [];
  for (const type of ROUTE_TYPES) {
    const from = routeTiers(before, type);
    const to = routeTiers(after, type);
    if (JSON.stringify(from) !== JSON.stringify(to)) routes.push({ type, before: from, after: to });
  }
  return routes;
}

function diffLimits(before, after) {
  const limits = [];
  for (const key of ['execution', 'design']) {
    const from = Number.isInteger(before?.limits?.[key]) ? before.limits[key] : null;
    const to = Number.isInteger(after?.limits?.[key]) ? after.limits[key] : null;
    if (from !== to) limits.push({ key, before: from, after: to });
  }
  return limits;
}

// Quota marks live in the global layer and change which tiers are effectively used.
// Only the public mark state is exposed; actor/timestamp fields stay out of the event.
function quotaState(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return { exhausted: entry.exhausted === true, resumeAt: entry.resumeAt ?? null };
}

function diffQuota(before, after) {
  const from = before?.quota || {};
  const to = after?.quota || {};
  const quota = [];
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const beforeState = quotaState(from[key]);
    const afterState = quotaState(to[key]);
    if (JSON.stringify(beforeState) !== JSON.stringify(afterState)) quota.push({ key, before: beforeState, after: afterState });
  }
  return quota;
}

function describeTiers(tiers) {
  if (!tiers || !tiers.length) return 'none';
  return tiers.map(tier => {
    const options = (tier.options || []).map(option => `${option.id}=${option.value}`).join(',');
    return `${tier.instanceId}/${tier.model}${options ? `/${options}` : ''}`;
  }).join(' | ');
}

function summarize({ scope, campaignId, machine, version, changedBy, routes, limits, quota }) {
  const target = scope === 'campaign' ? `campaign ${campaignId}` : scope === 'machine' ? `machine ${machine}` : 'global';
  const parts = [];
  if (routes.length) parts.push(`routes ${routes.map(route => route.type).join(', ')}`);
  if (limits.length) parts.push(`limits ${limits.map(limit => `${limit.key} ${limit.before ?? '-'}->${limit.after ?? '-'}`).join(', ')}`);
  if (quota.length) parts.push(`quota ${quota.map(entry => `${entry.key} ${entry.before?.exhausted ? 'exhausted' : 'clear'}->${entry.after?.exhausted ? 'exhausted' : 'clear'}`).join(', ')}`);
  const changed = routes[0] ? ` (${routes[0].type}: ${describeTiers(routes[0].before)} -> ${describeTiers(routes[0].after)})` : '';
  return `Routing change ${target} v${version} by ${changedBy}: ${parts.join('; ')}${changed}`;
}

/**
 * Build the public change event for one layer. Returns null when the layer did not change,
 * so a save that only bumps the document version stays silent.
 */
export function buildRoutingChangeEvent({
  scope,
  campaignId = null,
  machine = null,
  beforeLayer = {},
  afterLayer = {},
  routingVersion = 0,
  changedBy = 'api',
  changedAt = new Date().toISOString(),
} = {}) {
  if (!SCOPES.includes(scope)) throw new Error('scope 必须是 global、machine 或 campaign');
  const routes = diffRoutes(beforeLayer, afterLayer);
  const limits = diffLimits(beforeLayer, afterLayer);
  const quota = diffQuota(beforeLayer, afterLayer);
  if (!routes.length && !limits.length && !quota.length) return null;
  return {
    schema: ROUTING_EVENT_SCHEMA,
    event: ROUTING_EVENT_KIND,
    campaign: campaignId || '*',
    phase: ROUTING_EVENT_KIND,
    summary: summarize({ scope, campaignId, machine, version: routingVersion, changedBy, routes, limits, quota }),
    routingChange: {
      scope,
      campaignId: scope === 'campaign' ? campaignId : null,
      machine: scope === 'machine' ? machine : null,
      changedBy,
      changedAt,
      routingVersion,
      routes,
      limits,
      quota,
    },
  };
}

async function post({ campaign, mode, url, body, headers, fetchImpl }) {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      redirect: 'error',
    });
    await response.body?.cancel?.();
    return { campaign: campaign.id, mode, result: response.ok ? 'accepted' : 'failed', status: response.status };
  } catch {
    // Never surface the endpoint or the fetch error text: it can contain the URL.
    return { campaign: campaign.id, mode, result: 'failed', reason: 'unreachable' };
  }
}

async function deliverOne({ config, event, campaign, fetchImpl, now }) {
  let mode = 't3-thread';
  try {
    mode = loadCampaignMeta(campaign.dir).kind;
    const report = { ...event, campaign: campaign.id };
    if (mode === 'external') {
      // Same sender, signing, headers and public-body guard as report.mjs.
      try {
        const sent = await deliverExternalReport({ home: config.home, campaignDir: campaign.dir, report, fetchImpl, now });
        return { campaign: campaign.id, mode, result: 'accepted', status: sent.status };
      } catch {
        return { campaign: campaign.id, mode, result: 'failed', reason: 'delivery' };
      }
    }
    const url = privateText(config.privateDir, `webhooks/${campaign.id}.url`);
    if (!url) return { campaign: campaign.id, mode, result: 'unconfigured' };
    return await post({
      campaign,
      mode,
      url,
      body: JSON.stringify(report),
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Orchestration-Inbox/1.0',
        'X-Inbox-Event': ROUTING_EVENT_KIND,
        'X-Orch-Queue': '1',
      },
      fetchImpl,
    });
  } catch {
    return { campaign: campaign.id, mode, result: 'failed', reason: 'config' };
  }
}

/** Deliver to every target; one failure never rejects the batch. */
export async function deliverRoutingChange({
  config,
  event,
  campaigns = config.campaigns || [],
  fetchImpl = fetch,
  now = Date.now,
  log = () => {},
} = {}) {
  const deliveries = await Promise.all(campaigns.map(campaign => deliverOne({ config, event, campaign, fetchImpl, now })));
  for (const delivery of deliveries) {
    log({ event: 'routing-event', scope: event.routingChange?.scope, ...delivery });
  }
  return deliveries;
}

/**
 * Build and deliver the change event for one routing write.
 * Never throws: a delivery problem is logged and the routing save still succeeds.
 */
export async function publishRoutingChange({
  config,
  scope,
  campaignId = null,
  machine = config.name,
  beforeLayer = {},
  afterLayer = {},
  routingVersion = 0,
  changedBy = 'api',
  changedAt = new Date().toISOString(),
  fetchImpl = fetch,
  now = Date.now,
  log = () => {},
} = {}) {
  try {
    const event = buildRoutingChangeEvent({ scope, campaignId, machine, beforeLayer, afterLayer, routingVersion, changedBy, changedAt });
    if (!event) return { event: null, deliveries: [] };
    const campaigns = scope === 'campaign'
      ? (config.campaigns || []).filter(campaign => campaign.id === campaignId)
      : (config.campaigns || []);
    const deliveries = await deliverRoutingChange({ config, event, campaigns, fetchImpl, now, log });
    return { event, deliveries };
  } catch {
    log({ event: 'routing-event', scope, campaign: campaignId || null, result: 'invalid' });
    return { event: null, deliveries: [] };
  }
}
