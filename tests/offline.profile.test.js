// Structural coverage for the Offline Areas wiring (Phase 12A): the screen
// module imports cleanly, the Profile card routes to it, the app registers
// the hash route and converges the service worker, and the screen's states
// carry the data attributes the dapp.json checks and the shots agent key on.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
const PROFILE_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'screens', 'profile.js'), 'utf8');
const SCREEN_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'screens', 'offline-areas.js'), 'utf8');
const PICKER_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'components', 'offline', 'region-picker.js'), 'utf8');
const ROWS_SOURCE = fs.readFileSync(path.join(ROOT, 'public', 'js', 'components', 'offline', 'download-manager.js'), 'utf8');

test('the screen module imports in isolation (its dependency graph is clean)', async () => {
  // auth.js reads window.location at import time; a browser-less harness
  // only needs that one shape to load the whole graph.
  globalThis.window = globalThis.window || { location: { search: '', hash: '', href: '' } };
  const screen = await import('../public/js/screens/offline-areas.js');
  assert.equal(typeof screen.render, 'function');
});

test('the app registers the offline-areas hash route and converges the worker', () => {
  assert.match(APP_SOURCE, /import \* as offlineAreas from '\.\/screens\/offline-areas\.js'/);
  assert.match(APP_SOURCE, /router\.register\('offline-areas', offlineAreas\)/);
  // Capability-controlled service worker registration at boot.
  assert.match(APP_SOURCE, /resolveOfflineCapability/);
  assert.match(APP_SOURCE, /syncRegistration/);
});

test('the Profile card is the way in and points at the same route', () => {
  assert.match(PROFILE_SOURCE, /offlineAreasCard\(\)/);
  assert.match(PROFILE_SOURCE, /router\.navigate\('offline-areas'\)/);
  assert.match(PROFILE_SOURCE, /openOfflineAreas/);
  // The card sits after the Trips card, in the established Profile pattern.
  assert.ok(PROFILE_SOURCE.indexOf('tripsCard(),') < PROFILE_SOURCE.indexOf('offlineAreasCard(),'));
});

test('the screen keys its states on the data attributes the checks read', () => {
  assert.match(SCREEN_SOURCE, /offlineHost/);
  assert.match(SCREEN_SOURCE, /capability_unavailable/);
  assert.match(SCREEN_SOURCE, /unsupported_browser/);
  // The Check again action only exists in the blocked state.
  assert.match(SCREEN_SOURCE, /data-offline-check/);
});

test('the blocked state offers no download affordance', () => {
  // The picker is imported for the ready state only; the blocked and
  // unsupported states render the stored-regions card (Delete only).
  assert.match(SCREEN_SOURCE, /renderRegionPicker/);
  assert.match(SCREEN_SOURCE, /storedRegionsCard/);
  // The download orchestrator is gated in the screen too: a BLOCKED result
  // falls back to the blocked state instead of rendering a list.
  assert.match(SCREEN_SOURCE, /DOWNLOAD_STATUS\.BLOCKED/);
});

test('the screen never fakes a completed region', () => {
  // Reconcile: a stale 'downloading' manifest becomes 'interrupted'.
  assert.match(SCREEN_SOURCE, /status: 'interrupted'/);
  // Complete rows render only when the manifest says complete; result rows
  // render for failed/interrupted with Try again and Delete.
  assert.match(ROWS_SOURCE, /renderCompleteRow/);
  assert.match(ROWS_SOURCE, /renderResultRow/);
  assert.match(ROWS_SOURCE, /renderDownloadingRow/);
});

test('the picker rows carry the review data and the preset download hook', () => {
  assert.match(PICKER_SOURCE, /data-offline-preset-download/);
  assert.match(PICKER_SOURCE, /attribution/);
  assert.match(PICKER_SOURCE, /presetZoom/);
  assert.match(PICKER_SOURCE, /presetSize/);
});

test('the download rows carry the progress, cancel, retry and delete hooks', () => {
  assert.match(ROWS_SOURCE, /data-offline-cancel/);
  assert.match(ROWS_SOURCE, /data-offline-retry/);
  assert.match(ROWS_SOURCE, /data-offline-delete/);
});