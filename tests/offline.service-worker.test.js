// The map-resource policy and the service worker that enforces it (Phase
// 12A). The policy module is the single ruleset shared by the client and the
// worker, so it is tested directly; the worker file itself is asserted
// statically to prove it delegates to that policy and never touches anything
// else.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let policy;

test.before(async () => {
  policy = await import('../public/js/services/offline-cache-policy.js');
});

const TILE_HOSTS = ['tiles.openfreemap.org'];

function req(url, { method = 'GET' } = {}) {
  return { url, method };
}

test('map resource classification: tiles, glyphs, sprites, metadata', () => {
  assert.equal(policy.classifyMapResource(new URL('https://t.org/12/3/4.pbf')), 'tile');
  assert.equal(policy.classifyMapResource(new URL('https://t.org/12/3/4@2x.png')), 'tile');
  assert.equal(policy.classifyMapResource(new URL('https://t.org/12/3/4.mvt')), 'tile');
  assert.equal(policy.classifyMapResource(new URL('https://t.org/font/Noto%20Sans/0-255.pbf')), 'glyph');
  assert.equal(policy.classifyMapResource(new URL('https://t.org/sprite.json')), 'sprite');
  assert.equal(policy.classifyMapResource(new URL('https://t.org/sprite@2x.png')), 'sprite');
  assert.equal(policy.classifyMapResource(new URL('https://t.org/planet/tiles.json')), 'metadata');
  // A style document lives at an arbitrary path: it is metadata only when the
  // caller knows its exact URL (the client's style URL or the stored set).
  assert.equal(policy.classifyMapResource(new URL('https://t.org/styles/liberty')), null);
  assert.equal(
    policy.classifyMapResource(new URL('https://t.org/styles/liberty'), {
      metadataUrls: ['https://t.org/styles/liberty'],
    }),
    'metadata',
  );
});

test('parseTilePath reads z/x/y from tile-shaped paths only', () => {
  assert.deepEqual(policy.parseTilePath('/12/3/4.pbf'), { z: 12, x: 3, y: 4 });
  assert.deepEqual(policy.parseTilePath('/12/3/4@2x.png'), { z: 12, x: 3, y: 4 });
  assert.equal(policy.parseTilePath('/planet/tiles.json'), null);
  assert.equal(policy.parseTilePath('/styles/liberty'), null);
  // A zoom above 22 is not a tile zoom.
  assert.equal(policy.parseTilePath('/23/3/4.pbf'), null);
});

test('the app API is excluded on ANY host, and non-GET requests always', () => {
  for (const url of [
    'https://app.example.com/api/config',
    'https://app.example.com/api/saved/lists',
    'https://tiles.openfreemap.org/api/something',
  ]) {
    assert.equal(policy.isMapResourceRequest(new URL(url), { method: 'GET', allowedHosts: TILE_HOSTS }), false);
    assert.equal(policy.isExcludedUrl(new URL(url)), true);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal(
      policy.isMapResourceRequest(new URL('https://tiles.openfreemap.org/12/3/4.pbf'), {
        method,
        allowedHosts: TILE_HOSTS,
      }),
      false,
    );
  }
});

test('a host not on the allowlist is never eligible, even if it serves tile-shaped paths', () => {
  assert.equal(
    policy.isMapResourceRequest(new URL('https://elsewhere.example/12/3/4.pbf'), {
      method: 'GET',
      allowedHosts: TILE_HOSTS,
    }),
    false,
  );
  assert.equal(
    policy.isMapResourceRequest(new URL('https://tiles.openfreemap.org/12/3/4.pbf'), {
      method: 'GET',
      allowedHosts: TILE_HOSTS,
    }),
    'tile',
  );
});

test('an empty allowlist makes nothing eligible', () => {
  assert.equal(
    policy.isMapResourceRequest(new URL('https://tiles.openfreemap.org/12/3/4.pbf'), {
      method: 'GET',
      allowedHosts: [],
    }),
    false,
  );
});

test('non-http schemes are excluded', () => {
  assert.equal(policy.isExcludedUrl(new URL('data:image/png;base64,AAAA')), true);
  assert.equal(policy.isExcludedUrl(new URL('blob:https://app.example/uuid')), true);
});

test('allowedHostsFor collects only usable hosts and skips unusable values', () => {
  const hosts = policy.allowedHostsFor({
    styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
    tileTemplates: ['https://tiles.openfreemap.org/planet/{z}/{x}/{y}{ratio}.pbf', 'not a url'],
    spriteUrls: ['https://sprites.example/sprite'],
    glyphTemplates: ['https://fonts.example/fonts/{fontstack}/{range}.pbf'],
  });
  assert.deepEqual(hosts.sort(), ['fonts.example', 'sprites.example', 'tiles.openfreemap.org']);
});

// ---- the worker file itself ----

const SW_PATH = path.join(__dirname, '..', 'public', 'sw.js');
const SW_SOURCE = fs.readFileSync(SW_PATH, 'utf8');

test('the service worker delegates eligibility to the shared policy module', () => {
  assert.match(SW_SOURCE, /import .*offline-cache-policy\.js/);
  assert.match(SW_SOURCE, /isMapResourceRequest\(/);
});

test('the service worker only ever handles GET requests', () => {
  assert.match(SW_SOURCE, /request\.method !== 'GET'\)?\s*\n?\s*return/);
  // And it never installs a cache: persistence is the IndexedDB store only.
  assert.doesNotMatch(SW_SOURCE, /caches\.open|cache\.addAll|CacheStorage/);
});

test('the service worker never calls respondWith for a non-map resource', () => {
  // The single gate: `if (!kind) return;` precedes the only respondWith call.
  assert.match(SW_SOURCE, /if \(!kind\) return;/);
  const calls = SW_SOURCE.match(/event\.respondWith\(/g) || [];
  assert.equal(calls.length, 1, 'exactly one respondWith call site');
  assert.match(SW_SOURCE, /event\.respondWith\(serve\(request, url, kind\)\)/);
});

test('the worker serves from the region store with an offline marker header, and falls back to the network on a miss', () => {
  assert.match(SW_SOURCE, /x-homeroom-offline/);
  assert.match(SW_SOURCE, /return fetch\(request\);/);
});

test('the worker ignores API traffic even on allowed hosts, by policy', () => {
  // Belt-and-braces: the worker's own gate is isMapResourceRequest, whose
  // exclusion of /api/* is asserted above. This pins that the worker passes
  // the whole URL (not just the path) into that gate.
  assert.match(SW_SOURCE, /isMapResourceRequest\(url, \{/);
});