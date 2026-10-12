// Recipient validation — the server-side client for the platform's member
// roster and user directory (Phase 12F Slice 2).
//
// "Who can I share with?" is the project's real member list, which the
// platform owns: GET /members returns it, and GET /users/lookup resolves one
// typed handle to its canonical { id, username }. Both are called
// server-side with the CALLER'S forwarded iframe token; in production the
// app's own token is added as well. A typed handle is never trusted as-is:
// every recipient must be resolved through the directory AND appear in the
// roster, and when either cannot be reached the answer is fail-closed —
// the caller gets `recipients_unavailable` (503), never "trust the typed
// handle".
//
// The roster is cached for 60 seconds per process: it changes on human
// timescales and the platform rate-limits these endpoints at 120/min per
// (app, user). Failures are not cached, so recovery starts on the next call.
'use strict';

const { SharingError } = require('./model');

const ROSTER_TTL_MS = 60_000;

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function createMembersClient({ platformApiBase, appToken, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const base = normalizeBase(platformApiBase);
  const token = String(appToken || '').trim();

  let rosterCache = null; // { members: [{id, username}], cachedAt }

  function headersFor(userToken) {
    const headers = { 'x-usernode-user-token': String(userToken || '') };
    // The app token exists in production only; staging previews authenticate
    // these reads from the forwarded user token itself (platform convention).
    if (token) headers['x-usernode-app-token'] = token;
    return headers;
  }

  // Whether the directory can be asked at all. Without a base (a standalone
  // deploy with no platform around) the answer is honest unavailability.
  function available() {
    return Boolean(base);
  }

  async function fetchMembers(userToken) {
    if (!base) return { available: false, reason: 'not_configured' };
    let resp;
    try {
      resp = await fetchImpl(`${base}/members`, { headers: headersFor(userToken) });
    } catch {
      return { available: false, reason: 'upstream_unreachable' };
    }
    if (resp.status === 403) {
      // not_a_member: the caller is not (or no longer) a project member.
      // Honest unavailability for them — never an empty roster treated as real.
      return { available: false, reason: 'not_a_member' };
    }
    if (!resp.ok) return { available: false, reason: 'upstream_error' };
    let body;
    try {
      body = await resp.json();
    } catch {
      return { available: false, reason: 'upstream_error' };
    }
    const members = Array.isArray(body && body.members)
      ? body.members
          .filter((m) => m && m.username != null)
          .map((m) => ({ id: String(m.id), username: String(m.username) }))
      : [];
    return { available: true, members };
  }

  // The roster, cached for ROSTER_TTL_MS. Never throws: the answer carries
  // availability so the route can fail closed with its typed error.
  async function roster(userToken) {
    if (rosterCache && now() - rosterCache.cachedAt < ROSTER_TTL_MS) {
      return { available: true, members: rosterCache.members };
    }
    const result = await fetchMembers(userToken);
    if (result.available) {
      rosterCache = { members: result.members, cachedAt: now() };
      return { available: true, members: result.members };
    }
    return result;
  }

  // One handle → its canonical { id, username }, or found: false. Network
  // and upstream failures surface as unavailable, not as "doesn't exist".
  async function lookup(userToken, handle) {
    if (!base) return { available: false };
    let resp;
    try {
      resp = await fetchImpl(
        `${base}/users/lookup?username=${encodeURIComponent(handle)}`,
        { headers: headersFor(userToken) },
      );
    } catch {
      return { available: false };
    }
    if (!resp.ok) return { available: false };
    try {
      const body = await resp.json();
      if (body && body.found && body.user && body.user.username != null) {
        return {
          available: true,
          found: true,
          user: { id: String(body.user.id), username: String(body.user.username) },
        };
      }
      return { available: true, found: false };
    } catch {
      return { available: false };
    }
  }

  // Resolve and validate a start request's handles into recipient rows.
  // Every handle must: resolve through the directory (canonical casing is
  // what gets persisted), appear in the roster, and not be the caller.
  // Anything else is invalid_request; an unreachable directory is
  // recipients_unavailable — the fail-closed direction.
  async function resolveRecipients(userToken, handles, { viewerId }) {
    const list = await roster(userToken);
    if (!list.available) {
      return { available: false, reason: list.reason || 'upstream_error' };
    }
    const rosterById = new Map(list.members.map((m) => [m.id, m]));
    const resolved = [];
    for (const handle of handles) {
      const found = await lookup(userToken, handle);
      if (!found.available) {
        return { available: false, reason: 'upstream_error' };
      }
      if (!found.found) {
        throw new SharingError(
          'invalid_request',
          `Nobody called ${handle} here.`,
          { fields: { recipients: `${handle} is not a member of this project.` } },
        );
      }
      const user = found.user;
      if (String(user.id) === String(viewerId)) {
        throw new SharingError(
          'invalid_request',
          'You cannot share with yourself.',
          { fields: { recipients: 'You cannot share with yourself.' } },
        );
      }
      if (!rosterById.has(String(user.id))) {
        throw new SharingError(
          'invalid_request',
          `${user.username} is not a member of this project.`,
          { fields: { recipients: `${user.username} is not a member of this project.` } },
        );
      }
      if (!resolved.some((r) => String(r.userId) === String(user.id))) {
        resolved.push({ userId: user.id, username: user.username });
      }
    }
    return { available: true, recipients: resolved };
  }

  return { available, roster, lookup, resolveRecipients };
}

module.exports = { createMembersClient, ROSTER_TTL_MS };
