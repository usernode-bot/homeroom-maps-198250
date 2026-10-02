// Assistant HTTP routes, mounted at /api/assistant. All three sit behind the
// app's existing deny-by-default auth gate (server.js), so req.user is always
// present here and is the ONLY viewer any tool receives. Locale comes from
// the body `context.lang`, else the verified token's `locale`.
//
//   POST /turn    -> { reply, actions, usage }  (proposals only, never executed)
//   POST /act     -> { action }                 (validation/normalization ONLY)
//   GET  /status  -> { enabled, provider, capCents?, spentCents?, demo? }
//
// The demo path (`IS_STAGING && ?demo=1`) is a fixed, read-only transcript and
// one fixed action proposal. It calls no LLM proxy, no /act, and no write
// endpoint, and it touches no database row. It exists so before/after
// captures and a declared check can exercise the transcript and the
// confirmation card deterministically without the proxy, which is absent in
// staging by design.
'use strict';

const express = require('express');
const { TokenBucket } = require('../search/rate-limit');
const { isConfigured } = require('./provider');
const { buildSystemPrompt, buildContextNote } = require('./prompt');
const { TOOL_DEFINITIONS, dispatch } = require('./tools');
const { ACTION_DEFINITIONS, ActionError, normalizeAction } = require('./actions');

// One per-process bucket per user: a person cannot burst-spend even though
// the proxy also enforces the daily cap. Capacity 8, refill 1 per 4 seconds.
const buckets = new Map();
const BUCKET_CAPACITY = 8;
const BUCKET_REFILL_PER_SECOND = 0.25;
const MAX_TOOL_ROUNDS = 4;

function sameOriginAction(action) {
  return { tool: action.tool, args: action.args, summary: action.summary };
}

function createAssistantRouter({ services, isStaging = false, provider, spendState } = {}) {
  const router = express.Router();
  const proxy = provider || null;

  function viewerOf(req) {
    return { id: String(req.user.id), username: String(req.user.username || '') };
  }

  function bucketFor(userId) {
    let bucket = buckets.get(userId);
    if (!bucket) {
      bucket = new TokenBucket({ capacity: BUCKET_CAPACITY, refillPerSecond: BUCKET_REFILL_PER_SECOND });
      buckets.set(userId, bucket);
    }
    return bucket;
  }

  function enabled() {
    return proxy ? proxy.isConfigured() : isConfigured();
  }

  function mapStatus(code) {
    switch (code) {
      case 'grant_required':
        return 403;
      case 'app_cap_exceeded':
      case 'budget_exceeded':
      case 'rate_limited':
        return 429;
      case 'not_configured':
        return 503;
      default:
        return 502;
    }
  }

  function sendError(res, code, message, extra = {}) {
    return res.status(mapStatus(code)).json({ error: { code, message, ...extra } });
  }

  // Resolve the locale: explicit context wins, then the verified token claim.
  function resolveLang(req) {
    const ctx = req.body && req.body.context;
    const lang = (ctx && typeof ctx.lang === 'string' && ctx.lang) || (req.user && req.user.locale) || 'en';
    return String(lang).slice(0, 16);
  }

  // A canned, deterministic transcript. Read-only: no proxy, no /act, no
  // write, no database access. The one action is display-only in the demo.
  function demoResponse() {
    return {
      demo: true,
      reply: 'This is a demo of the map assistant. AI is unavailable in staging, so this preview is fixed and does not call the AI service.',
      actions: [
        {
          tool: 'save_place',
          summary: 'Save Staging demo cafe to favorites',
          args: { place: { id: 'demo-place-1', name: 'Staging demo cafe' }, listRef: 'favorites' },
        },
      ],
      usage: { spentCents: null, capCents: null, demo: true },
    };
  }

  // ── POST /turn ──────────────────────────────────────────────────────────
  router.post('/turn', async (req, res) => {
    const viewer = viewerOf(req);
    const context = (req.body && req.body.context) || {};
    const lang = resolveLang(req);

    if (isStaging && req.query.demo === '1') return res.json(demoResponse());
    if (!enabled()) {
      return sendError(res, 'not_configured', 'AI features are unavailable in this environment.');
    }

    // The transcript is client-held and in-memory only; here it is validated
    // into the Anthropic messages shape with a bounded window. No transcript
    // is ever persisted.
    const messages = normalizeMessages(req.body && req.body.messages);
    if (!messages.length) {
      return res.status(400).json({
        error: { code: 'invalid_request', message: 'A message is required.' },
      });
    }

    if (!bucketFor(viewer.id).tryTake()) {
      return sendError(res, 'rate_limited', 'The assistant is busy right now. Try again in a moment.');
    }

    const system = buildSystemPrompt({ lang });
    const contextNote = buildContextNote(context);
    const working = contextNote
      ? [{ role: 'user', content: contextNote }, ...messages]
      : messages.slice();

    let spend = null;
    let actions = [];
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const out = await proxy.complete({
          system,
          messages: working,
          tools: [...TOOL_DEFINITIONS, ...ACTION_DEFINITIONS],
          userToken: req.headers['x-usernode-token'],
        });
        spend = out.spend || spend;

        const textParts = [];
        const toolCalls = [];
        const actionCalls = [];
        for (const block of out.content) {
          if (block.type === 'text' && block.text) textParts.push(block.text);
          else if (block.type === 'tool_use') {
            if (ACTION_DEFINITIONS.some((d) => d.name === block.name)) actionCalls.push(block);
            else toolCalls.push(block);
          }
        }

        // Collect action proposals. An action tool call is a proposal only:
        // it is validated here and returned to the client, never executed.
        for (const call of actionCalls) {
          try {
            const normalized = await normalizeAction(
              { tool: call.name, args: call.input },
              { viewer, getTrip: services.getTrip },
            );
            actions.push(sameOriginAction(normalized));
          } catch (err) {
            if (!(err instanceof ActionError)) throw err;
            // A malformed proposal is dropped, not surfaced as a failure.
          }
        }

        if (!toolCalls.length) {
          return finish(res, viewer.id, textParts.join('\n').trim(), actions, spend);
        }

        // Run the read tools and feed their real results back to the model.
        working.push({ role: 'assistant', content: out.content });
        const results = [];
        for (const call of toolCalls) {
          const result = await dispatch(call.name, call.input, { viewer, services });
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(result),
          });
        }
        working.push({ role: 'user', content: results });
      }

      // Tool loop exhausted: answer honestly rather than loop forever.
      return finish(
        res,
        viewer.id,
        'I could not finish that in a single answer. Try asking something more specific.',
        actions,
        spend,
      );
    } catch (err) {
      const code = err && err.code ? err.code : 'provider_error';
      spend = (err && err.spend) || spend;
      const message =
        code === 'not_configured'
          ? 'AI features are unavailable in this environment.'
          : code === 'grant_required'
            ? 'This app needs your permission to use AI.'
            : code === 'app_cap_exceeded'
              ? 'The daily AI cap for this app is reached. It resets at midnight UTC.'
              : code === 'budget_exceeded'
                ? 'Your daily AI budget is spent. It resets at midnight UTC.'
                : (err && err.message) || 'The AI service answered with an error.';
      // Record the meter so a later /status can show it even when the turn
      // itself failed with a cap/budget condition.
      if (spendState && spend) spendState.set(viewer.id, spend);
      return sendError(res, code, message, spend ? { usage: spend } : {});
    }
  });

  function finish(res, viewerId, reply, actions, spend) {
    if (spendState && spend) spendState.set(String(viewerId), spend);
    return res.json({
      reply: reply || 'I do not have an answer for that.',
      actions,
      usage: { spentCents: spend ? spend.spentCents : null, capCents: spend ? spend.capCents : null },
    });
  }

  // ── POST /act ───────────────────────────────────────────────────────────
  // Validation and normalization ONLY. It re-validates one action object
  // against assistant/actions.js and returns the normalized call the client
  // should issue, or rejects it. It performs NO domain mutation: no
  // transaction, no INSERT/UPDATE/DELETE, no domain store write method is
  // called. The only side effect is the optional ownership pre-check against
  // the viewer's own trip.
  router.post('/act', async (req, res) => {
    const viewer = viewerOf(req);
    if (isStaging && req.query.demo === '1') {
      return res.status(403).json({
        error: { code: 'demo_read_only', message: 'The demo does not perform actions.' },
      });
    }
    try {
      const normalized = await normalizeAction(req.body, { viewer, getTrip: services.getTrip });
      return res.json({ action: sameOriginAction(normalized), write: normalized.write, endpoint: normalized.endpoint });
    } catch (err) {
      if (err instanceof ActionError) {
        return res.status(400).json({
          error: {
            code: err.code,
            message: err.message,
            ...(err.fields ? { fields: err.fields } : {}),
          },
        });
      }
      throw err;
    }
  });

  // ── GET /status ─────────────────────────────────────────────────────────
  router.get('/status', (req, res) => {
    if (isStaging && req.query.demo === '1') {
      return res.json({ enabled: false, provider: null, capCents: null, spentCents: null, demo: true });
    }
    if (!enabled()) {
      return res.json({ enabled: false, provider: null, capCents: null, spentCents: null });
    }
    const viewer = viewerOf(req);
    const spend = (spendState && spendState.get(viewer.id)) || null;
    res.json({
      enabled: true,
      provider: proxy ? proxy.name : 'anthropic-proxy',
      capCents: spend ? spend.capCents : null,
      spentCents: spend ? spend.spentCents : null,
    });
  });

  return router;
}

// Trim and validate the client transcript into the Anthropic messages shape.
// Bounded to the last 20 turns so a long conversation cannot grow unbounded;
// content is coerced to text and never trusted as instructions.
function normalizeMessages(raw) {
  const list = Array.isArray(raw) ? raw.slice(-20) : [];
  const out = [];
  for (const m of list) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (!text) continue;
    out.push({ role: m.role, content: text.slice(0, 8000) });
  }
  // The API requires the first turn to be a user turn.
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

module.exports = {
  createAssistantRouter,
  normalizeMessages,
  sameOriginAction,
  BUCKET_CAPACITY,
  BUCKET_REFILL_PER_SECOND,
  MAX_TOOL_ROUNDS,
};
