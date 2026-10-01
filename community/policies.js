// Extension points for the community systems that are NOT built yet:
// moderation, spam prevention, duplicate detection and reputation.
//
// Nothing is registered here by default, on purpose. An empty registry means
// every check passes and every event goes nowhere, and the app says nothing
// about spam filtering, duplicates or reputation anywhere in its UI. When one
// of those systems is built it plugs in here, without touching the routes or
// the store:
//
//   Gates — run inside the write path, before anything is stored. A gate
//   returns null to allow, or { code, message, status? } to refuse. The first
//   refusal wins and becomes the API error.
//     stage 'create'   ctx { viewer, draft }               spam, duplicates
//     stage 'update'   ctx { viewer, proposal, draft }     spam, moderation
//     stage 'vote'     ctx { viewer, proposal, value }     vote-ring checks
//     stage 'status'   ctx { viewer, proposal, to }        moderation rules
//
//   Listeners — told about every committed change, after the transaction.
//   A listener that throws is logged and ignored: it can never undo a write.
//     'proposal.created' | 'proposal.updated' | 'proposal.status_changed'
//     'vote.cast' | 'vote.changed' | 'vote.removed'
//   Reputation is a listener over these events; moderation tooling reads the
//   proposal_status_events history the store already records, and can hide a
//   proposal through the proposals.hidden_at column every feed query honours.
'use strict';

function createPolicies() {
  const gates = { create: [], update: [], vote: [], status: [] };
  const listeners = new Map();

  function registerGate(stage, name, check) {
    if (!gates[stage]) throw new Error(`Unknown policy stage: ${stage}`);
    gates[stage].push({ name, check });
  }

  async function runGates(stage, ctx) {
    for (const { name, check } of gates[stage] || []) {
      const verdict = await check(ctx);
      if (verdict) return { policy: name, ...verdict };
    }
    return null;
  }

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(fn);
  }

  async function emit(event, payload) {
    for (const fn of listeners.get(event) || []) {
      try {
        await fn(payload);
      } catch (err) {
        console.warn(`[community] listener for ${event} failed: ${err && err.message}`);
      }
    }
  }

  return { registerGate, runGates, on, emit };
}

module.exports = { createPolicies };
