// The LLM proxy adapter (Phase 11), with fetch injected so no test touches the
// network. Pins the spec's enablement rule (BOTH env values required), header
// forwarding, spend-header parsing, error-code mapping and timeout handling.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnthropicProxy, parseSpend, mapErrorStatus, isConfigured } = require('../assistant/provider');

function headers(map = {}) {
  return { get: (name) => (name.toLowerCase() in map ? map[name.toLowerCase()] : null) };
}

function jsonResponse(body, { ok = true, status = 200, hdrs = {} } = {}) {
  return { ok, status, headers: headers(hdrs), json: async () => body };
}

test('isConfigured is true only when BOTH proxy values are present', () => {
  const base = { ...process.env };
  try {
    delete process.env.USERNODE_LLM_PROXY_URL;
    delete process.env.USERNODE_LLM_PROXY_TOKEN;
    assert.equal(isConfigured(), false);
    process.env.USERNODE_LLM_PROXY_URL = 'http://proxy.test';
    assert.equal(isConfigured(), false, 'a URL alone must not enable AI');
    delete process.env.USERNODE_LLM_PROXY_URL;
    process.env.USERNODE_LLM_PROXY_TOKEN = 'tok';
    assert.equal(isConfigured(), false, 'a token alone must not enable AI');
    process.env.USERNODE_LLM_PROXY_URL = 'http://proxy.test';
    assert.equal(isConfigured(), true, 'both values enable AI');
  } finally {
    for (const k of ['USERNODE_LLM_PROXY_URL', 'USERNODE_LLM_PROXY_TOKEN']) {
      if (base[k] === undefined) delete process.env[k];
      else process.env[k] = base[k];
    }
  }
});

test('the adapter reports not_configured and never calls fetch when unconfigured', async () => {
  let called = false;
  const provider = createAnthropicProxy({ env: {}, fetchImpl: async () => { called = true; } });
  assert.equal(provider.isConfigured(), false);
  await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), (err) => {
    assert.equal(err.code, 'not_configured');
    return true;
  });
  assert.equal(called, false);
});

test('complete posts to /v1/messages with the app token and the forwarded user token', async () => {
  const calls = [];
  const provider = createAnthropicProxy({
    env: { USERNODE_LLM_PROXY_URL: 'http://proxy.test/', USERNODE_LLM_PROXY_TOKEN: 'apptok' },
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    },
  });
  const out = await provider.complete({
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'search_places', input_schema: { type: 'object' } }],
    userToken: 'usertok',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://proxy.test/v1/messages');
  assert.equal(calls[0].opts.headers['x-usernode-app-token'], 'apptok');
  assert.equal(calls[0].opts.headers['x-usernode-user-token'], 'usertok');
  assert.equal(calls[0].opts.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.system, 'sys');
  assert.equal(body.messages.length, 1);
  assert.equal(body.tools.length, 1);
  assert.equal(out.content[0].text, 'ok');
});

test('spend headers are parsed and returned, including fractional cents', async () => {
  const provider = createAnthropicProxy({
    env: { USERNODE_LLM_PROXY_URL: 'http://proxy.test', USERNODE_LLM_PROXY_TOKEN: 'apptok' },
    fetchImpl: async () =>
      jsonResponse(
        { content: [{ type: 'text', text: 'ok' }] },
        { hdrs: { 'x-usernode-llm-spent-cents': '4.7914', 'x-usernode-llm-cap-cents': '100' } },
      ),
  });
  const out = await provider.complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(out.spend.spentCents, 4.7914);
  assert.equal(out.spend.capCents, 100);
});

test('parseSpend tolerates missing and garbled headers', () => {
  assert.deepEqual(parseSpend(headers({})), { spentCents: null, capCents: null });
  assert.deepEqual(parseSpend(headers({ 'x-usernode-llm-spent-cents': 'nope' })), { spentCents: null, capCents: null });
});

test('error codes map faithfully: grant_required, app_cap_exceeded, budget_exceeded', async () => {
  const cases = [
    [403, 'grant_required'],
    [429, 'app_cap_exceeded'],
    [429, 'budget_exceeded'],
  ];
  for (const [status, code] of cases) {
    const provider = createAnthropicProxy({
      env: { USERNODE_LLM_PROXY_URL: 'http://proxy.test', USERNODE_LLM_PROXY_TOKEN: 'apptok' },
      fetchImpl: async () => jsonResponse({ code }, { ok: false, status }),
    });
    await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), (err) => {
      assert.equal(err.code, code);
      assert.equal(err.status, status);
      return true;
    });
  }
});

test('a 429 without a known code maps to app_cap_exceeded; a 5xx to provider_error', async () => {
  assert.equal(mapErrorStatus(429, {}), 'app_cap_exceeded');
  assert.equal(mapErrorStatus(401, {}), 'grant_required');
  assert.equal(mapErrorStatus(500, {}), 'provider_error');
  const provider = createAnthropicProxy({
    env: { USERNODE_LLM_PROXY_URL: 'http://proxy.test', USERNODE_LLM_PROXY_TOKEN: 'apptok' },
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 500 }),
  });
  await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), (err) => {
    assert.equal(err.code, 'provider_error');
    return true;
  });
});

test('an unreadable success body is a provider_error, never a fake answer', async () => {
  const provider = createAnthropicProxy({
    env: { USERNODE_LLM_PROXY_URL: 'http://proxy.test', USERNODE_LLM_PROXY_TOKEN: 'apptok' },
    fetchImpl: async () => ({ ok: true, status: 200, headers: headers(), json: async () => { throw new Error('bad'); } }),
  });
  await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), (err) => {
    assert.equal(err.code, 'provider_error');
    return true;
  });
});

test('a timeout/abort becomes provider_error', async () => {
  const provider = createAnthropicProxy({
    env: { USERNODE_LLM_PROXY_URL: 'http://proxy.test', USERNODE_LLM_PROXY_TOKEN: 'apptok' },
    fetchImpl: async () => {
      const err = new Error('aborted');
      err.name = 'TimeoutError';
      throw err;
    },
  });
  await assert.rejects(() => provider.complete({ messages: [{ role: 'user', content: 'hi' }] }), (err) => {
    assert.equal(err.code, 'provider_error');
    assert.match(err.message, /did not answer in time/);
    return true;
  });
});
