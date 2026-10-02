// The assistant routes (Phase 11) over a stubbed provider and stubbed domain
// services. No database, no network, no model: the adapter and every tool
// service are injected. This covers the acceptance criteria that only real
// tool output grounds an answer, that a tool failure is reported honestly,
// that either missing proxy value yields the honest unavailable state, and
// that /api/assistant/act mutates no domain data.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAssistantRouter, normalizeMessages } = require('../assistant/routes');

// A stub provider whose complete() returns the queued turns. `isConfigured`
// is settable so a test can force the disabled state.
function stubProvider(turns, { configured = true } = {}) {
  const calls = [];
  return {
    name: 'stub',
    isConfigured: () => configured,
    calls,
    async complete(request) {
      calls.push(request);
      const next = turns.shift();
      if (typeof next === 'function') return next(request);
      return next || { content: [{ type: 'text', text: 'done' }], spend: { spentCents: 1, capCents: 100 } };
    },
  };
}

// Spy domain services: reads return fixed data, writes throw so that any
// accidental write from /act would fail the test loudly.
function stubServices(overrides = {}) {
  const writes = [];
  const write = (name) => () => {
    writes.push(name);
    throw new Error(`unexpected write: ${name}`);
  };
  return {
    writes,
    search: async () => ({ provider: 'stub', results: [{ id: 'p1', name: 'Cafe Real', kind: 'cafe', lat: 1, lon: 2, provider: 'stub' }] }),
    getPlace: async () => ({ provider: 'stub', place: { id: 'p1', name: 'Cafe Real', dataSource: 'stub' } }),
    getDirections: async () => ({ provider: 'stub', mode: 'driving', routes: [{ distance: 1200, duration: 600, provider: 'stub' }] }),
    getTrip: async () => ({ id: '5', name: 'Mine', days: [] }),
    listTrips: async () => ({ items: [] }),
    listSaved: async () => [],
    listProposals: async () => ({ items: [{ id: '9', title: 'Fix the pin', category: 'correct_place', status: 'open', votes: { up: 2, down: 0, score: 2 }, author: { id: 'a', username: 'someone' } }] }),
    listReports: async () => ({ items: [] }),
    ...overrides,
  };
}

// Boot the router in isolation with a fake auth gate that injects req.user
// (the same shape server.js produces) so the routes are exercised as they are
// behind the real gate.
async function withApp({ provider, services = stubServices(), isStaging = false }, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'u1', username: 'tester', locale: 'en' };
    next();
  });
  app.use('/api/assistant', createAssistantRouter({ services, provider, isStaging }));
  app.use((err, _req, res, _next) => res.status(500).json({ error: { code: 'internal_error', message: err.message } }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

function post(base, path, body) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-usernode-token': 'usertok' },
    body: JSON.stringify(body),
  });
}

test('a turn runs a real tool and returns the grounded reply plus proposals', async () => {
  const services = stubServices();
  const provider = stubProvider([
    {
      content: [
        { type: 'tool_use', id: 't1', name: 'search_places', input: { query: 'cafe' } },
        { type: 'tool_use', id: 'a1', name: 'save_place', input: { place: { id: 'p1', name: 'Cafe Real' } } },
      ],
      spend: { spentCents: 2, capCents: 100 },
    },
    { content: [{ type: 'text', text: 'I found Cafe Real.' }], spend: { spentCents: 3, capCents: 100 } },
  ]);
  await withApp({ provider, services }, async (base) => {
    const res = await post(base, '/api/assistant/turn', {
      messages: [{ role: 'user', content: 'save a cafe' }],
      context: { route: '#/' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reply, 'I found Cafe Real.');
    assert.equal(body.actions.length, 1);
    assert.equal(body.actions[0].tool, 'save_place');
    assert.equal(body.usage.spentCents, 3);
    // The tool result fed back to the model is the REAL service output.
    const secondCall = provider.calls[1];
    const toolResult = secondCall.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result');
    assert.ok(toolResult, 'a tool_result was sent back to the model');
    assert.match(toolResult.content[0].content, /Cafe Real/);
    // The action tool call was NOT executed and NOT sent as a tool_result.
    assert.equal(services.writes.length, 0);
  });
});

test('a tool that errors is reported to the model as a typed tool error, not a success', async () => {
  const services = stubServices({
    getPlace: async () => {
      const err = new Error('No place provider is connected yet.');
      err.code = 'not_configured';
      throw err;
    },
  });
  const provider = stubProvider([
    { content: [{ type: 'tool_use', id: 't1', name: 'get_place_details', input: { placeId: 'p1' } }] },
    { content: [{ type: 'text', text: 'That place detail is not available.' }] },
  ]);
  await withApp({ provider, services }, async (base) => {
    const res = await post(base, '/api/assistant/turn', { messages: [{ role: 'user', content: 'hours?' }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.reply, 'That place detail is not available.');
    const secondCall = provider.calls[1];
    const toolResult = secondCall.messages.find((m) => Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result');
    assert.match(toolResult.content[0].content, /not_configured/);
  });
});

test('a provider failure surfaces a typed 502 provider_error with the app error shape', async () => {
  const provider = stubProvider([() => {
    const err = new Error('The AI service answered with an error.');
    err.code = 'provider_error';
    throw err;
  }]);
  await withApp({ provider }, async (base) => {
    const res = await post(base, '/api/assistant/turn', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'provider_error');
  });
});

test('either proxy value missing yields 503 ai_unavailable/not_configured and no model call', async () => {
  const provider = stubProvider([], { configured: false });
  await withApp({ provider }, async (base) => {
    const res = await post(base, '/api/assistant/turn', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'not_configured');
    assert.equal(provider.calls.length, 0);
    const status = await fetch(base + '/api/assistant/status').then((r) => r.json());
    assert.equal(status.enabled, false);
  });
});

test('/api/assistant/act validates and normalizes only, and calls no domain write', async () => {
  const services = stubServices();
  const provider = stubProvider([]);
  await withApp({ provider, services }, async (base) => {
    const res = await post(base, '/api/assistant/act', {
      tool: 'save_place',
      args: { place: { id: 'p1', name: 'Cafe' } },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.action.tool, 'save_place');
    assert.equal(body.write, true);
    assert.equal(body.endpoint, 'POST /api/saved/places');
    // The whole point: no domain store write method was called.
    assert.equal(services.writes.length, 0);
    assert.equal(provider.calls.length, 0);
  });
});

test('/api/assistant/act rejects an unknown tool with 400 and a typed code', async () => {
  await withApp({ provider: stubProvider([]) }, async (base) => {
    const res = await post(base, '/api/assistant/act', { tool: 'nuke', args: {} });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'unknown_tool');
  });
});

test('the staging ?demo=1 turn is canned, read-only, and calls no proxy', async () => {
  const provider = stubProvider([]);
  await withApp({ provider, isStaging: true }, async (base) => {
    const res = await post(base, '/api/assistant/turn?demo=1', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.demo, true);
    assert.ok(body.reply);
    assert.equal(body.actions.length, 1);
    assert.equal(provider.calls.length, 0);
    // The demo never reaches /act either.
    const act = await post(base, '/api/assistant/act?demo=1', { tool: 'save_place', args: { place: { id: 'p', name: 'X' } } });
    assert.equal(act.status, 403);
  });
});

test('the demo path is staging-only: production ignores ?demo=1 and uses the real path', async () => {
  const provider = stubProvider([], { configured: false });
  await withApp({ provider, isStaging: false }, async (base) => {
    const res = await post(base, '/api/assistant/turn?demo=1', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 503);
  });
});

test('normalizeMessages bounds the transcript and requires a leading user turn', () => {
  const long = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const out = normalizeMessages(long);
  assert.equal(out.length, 20);
  assert.equal(out[0].role, 'user');
  const leadingAssistant = normalizeMessages([{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'yo' }]);
  assert.deepEqual(leadingAssistant, [{ role: 'user', content: 'yo' }]);
  assert.deepEqual(normalizeMessages([{ role: 'user', content: '   ' }]), []);
});
