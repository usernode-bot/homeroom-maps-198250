// Service-worker registration — idempotent, capability-controlled.
//
// The worker at /sw.js is registered ONLY while the effective capability is
// 'ready' (the provider gate open and the device supported), and is actively
// unregistered otherwise, so a device that changes capability (a config
// change, a revoked provider permission) converges to the right state no
// matter how many times this runs. Repeated calls with the same capability
// are no-ops: the module checks the existing registration before touching
// navigator.serviceWorker, so boot, navigation and re-checks never stack
// registrations.
//
// The worker itself never intercepts anything but allowlisted map resources;
// see offline-cache-policy.js for the single ruleset both sides share.
'use strict';

const WORKER_URL = '/sw.js';

export const REGISTRATION_STATE = {
  REGISTERED: 'registered',
  UNREGISTERED: 'unregistered',
  UNCHANGED: 'unchanged',
  UNSUPPORTED: 'unsupported',
  FAILED: 'failed',
};

function serviceWorkerContainer(navigatorRef) {
  const scope = navigatorRef || (typeof globalThis !== 'undefined' ? globalThis.navigator : null);
  return scope && scope.serviceWorker ? scope.serviceWorker : null;
}

export async function syncRegistration({ capability, navigatorRef } = {}) {
  const container = serviceWorkerContainer(navigatorRef);
  if (!container) {
    return { state: REGISTRATION_STATE.UNSUPPORTED };
  }

  const desired = Boolean(capability && capability.stage === 'ready' && capability.swRequired);

  try {
    const existing = await container.getRegistration(WORKER_URL);
    if (desired) {
      if (existing && (existing.active || existing.installing || existing.waiting)) {
        return { state: REGISTRATION_STATE.UNCHANGED, registration: existing };
      }
      const registration = await container.register(WORKER_URL, {
        scope: '/',
        type: 'module',
      });
      return { state: REGISTRATION_STATE.REGISTERED, registration };
    }
    if (existing) {
      const unregistered = await existing.unregister();
      return { state: REGISTRATION_STATE.UNREGISTERED, unregistered };
    }
    return { state: REGISTRATION_STATE.UNCHANGED };
  } catch (err) {
    // Registration must never break boot: report and let the caller decide.
    return { state: REGISTRATION_STATE.FAILED, error: err };
  }
}

// Tell the active worker which hosts the current map source uses. The worker
// keeps no persistent allowlist of its own: the client re-announces after
// every registration and config load, and anything not announced is not
// eligible. Fire-and-forget; a worker that is not yet controlling simply
// misses the message until the next announce.
export function announceAllowedHosts(hosts, { navigatorRef } = {}) {
  const container = serviceWorkerContainer(navigatorRef);
  if (!container || !container.controller) return false;
  try {
    container.controller.postMessage({ type: 'offline:allowed-hosts', hosts: [...hosts] });
    return true;
  } catch {
    return false;
  }
}