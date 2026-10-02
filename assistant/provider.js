// AI provider — the ONE outbound AI path: the platform's LLM proxy.
//
// There is no third-party key here and none is ever read from the
// environment: the proxy is billed to the signed-in user under their own
// consent grant, and this app forwards the user's iframe token so the proxy
// knows whose budget to charge. Both proxy values are platform-injected and
// neither is declared in dapp.json.
//
// The adapter is deliberately thin. It speaks the Anthropic Messages shape
// the proxy mirrors, and it turns every way the call can fail into the app's
// typed error codes so routes.js can map them to HTTP statuses:
//
//   not_configured  -> the proxy values are absent (staging, standalone)
//   grant_required  -> the user has not granted this app AI access
//   app_cap_exceeded-> the user's per-app daily cap is spent
//   budget_exceeded -> the user's overall daily budget is spent
//   rate_limited    -> the app's own per-user bucket is empty (routes.js)
//   provider_error  -> a proxy timeout, 5xx or unreadable body
//
// `fetchImpl` is injectable so tests never touch the network, exactly like
// the search and routing adapters.
'use strict';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 1024;

function llmError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// `proxyUrl`/`proxyToken` default to the process environment but can be
// overridden so a test can exercise both-configured/grant/error paths.
function isConfigured() {
  return Boolean(process.env.USERNODE_LLM_PROXY_URL && process.env.USERNODE_LLM_PROXY_TOKEN);
}

// Parse the spend meter the proxy returns on every authenticated response.
// Values are optional and may be fractional; a missing/garbled header is
// simply absent, never a zero we would report as real spend.
function parseSpend(headers) {
  const read = (name) => {
    const raw = headers && typeof headers.get === 'function' ? headers.get(name) : null;
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    spentCents: read('x-usernode-llm-spent-cents'),
    capCents: read('x-usernode-llm-cap-cents'),
  };
}

// Map a non-OK proxy answer to the typed code server.js/routes.js surface.
// The proxy sends `{ code }` for the three documented conditions; anything
// else (including upstream 5xx) is an honest provider_error.
function mapErrorStatus(status, body) {
  const code = body && (body.code || (body.error && body.error.code));
  if (code === 'grant_required') return 'grant_required';
  if (code === 'app_cap_exceeded') return 'app_cap_exceeded';
  if (code === 'budget_exceeded') return 'budget_exceeded';
  if (status === 401 || status === 403) return 'grant_required';
  if (status === 429) return 'app_cap_exceeded';
  return 'provider_error';
}

// The provider object the registry exposes. `complete()` takes the already
// assembled Anthropic request and the user's forwarded token.
function createAnthropicProxy({
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const name = 'anthropic-proxy';

  function configured() {
    return Boolean(
      (env.USERNODE_LLM_PROXY_URL || '').trim() &&
        (env.USERNODE_LLM_PROXY_TOKEN || '').trim(),
    );
  }

  async function complete({ system, messages, tools, maxTokens = MAX_TOKENS, userToken } = {}) {
    if (!configured()) {
      throw llmError(
        'not_configured',
        'AI features are unavailable in this environment.',
      );
    }
    const url = String(env.USERNODE_LLM_PROXY_URL).trim().replace(/\/+$/, '') + '/v1/messages';
    const body = { model, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    if (tools && tools.length) body.tools = tools;

    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          'x-usernode-app-token': String(env.USERNODE_LLM_PROXY_TOKEN).trim(),
          // Billing identity only; never logged and never persisted.
          ...(userToken ? { 'x-usernode-user-token': userToken } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw llmError('provider_error', 'The AI service did not answer in time.');
      }
      throw llmError('provider_error', 'The AI service could not be reached.');
    }

    const spend = parseSpend(res.headers);

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const code = mapErrorStatus(res.status, payload);
      const message =
        code === 'grant_required'
          ? 'This app needs your permission to use AI.'
          : code === 'app_cap_exceeded'
            ? 'The daily AI cap for this app is reached. It resets at midnight UTC.'
            : code === 'budget_exceeded'
              ? 'Your daily AI budget is spent. It resets at midnight UTC.'
              : 'The AI service answered with an error.';
      const err = llmError(code, message);
      err.status = res.status;
      err.spend = spend;
      throw err;
    }

    // A success body must carry the content blocks the caller reads; an
    // unreadable one is a provider error, never an empty fake answer.
    if (!payload || !Array.isArray(payload.content)) {
      throw llmError('provider_error', 'The AI service sent an unreadable answer.');
    }
    return { content: payload.content, stopReason: payload.stop_reason || null, spend, usage: payload.usage || null };
  }

  return { name, isConfigured: configured, complete };
}

module.exports = {
  llmError,
  parseSpend,
  mapErrorStatus,
  isConfigured,
  createAnthropicProxy,
  DEFAULT_MODEL,
  MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
};
