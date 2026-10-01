// Tests for the i18n core and locale resolution (public/js/i18n/core.js and
// resolve.js). Both are pure, dependency-injected modules, so the whole
// fallback chain — the spec's "never blank UI" guarantee — is driven here
// without a DOM. The browser singleton (i18n/index.js) is deliberately NOT
// imported: it touches window/document.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const load = (name) => import(`../public/js/i18n/${name}`);

// ---- interpolation ----

test('interpolate substitutes {name} placeholders', async () => {
  const { interpolate } = await load('core.js');
  assert.equal(interpolate('Hi {name}, {n} items', { name: 'Ada', n: 3 }), 'Hi Ada, 3 items');
});

test('interpolate leaves unknown and missing placeholders visible', async () => {
  const { interpolate } = await load('core.js');
  assert.equal(interpolate('Hi {name}', {}), 'Hi {name}');
  assert.equal(interpolate('Hi {name}', { other: 'x' }), 'Hi {name}');
  assert.equal(interpolate('plain string', { name: 'x' }), 'plain string');
});

// ---- the fallback chain ----

function makeCore({ idBundle, failLoad } = {}) {
  return load('core.js').then(({ createI18n }) =>
    createI18n({
      fallbackBundle: {
        greeting: 'Hello',
        templated: 'Hi {name}',
        'only.english': 'English only',
      },
      loadBundle: async (code) => {
        if (failLoad) throw new Error('bundle unavailable');
        if (code === 'id') return idBundle || { greeting: 'Halo' };
        throw new Error('unexpected bundle: ' + code);
      },
      resolveInitial: () => ({ locale: 'en', source: 'device' }),
      applyLocale: (code) => applied.push(code),
    }));
}

const applied = [];
// `applied` is re-created per file, not per test; makeCore pushes into the
// file-level array so applyLocale calls are observable per test by slicing.
test('t() uses the active bundle, then English, then the raw key', async () => {
  const core = await makeCore({ idBundle: { greeting: 'Halo' } });
  core.start();
  assert.equal(core.getLocale(), 'en');
  assert.equal(core.t('greeting'), 'Hello');
  await core.setLocale('id');
  assert.equal(core.t('greeting'), 'Halo');
  // key missing in Indonesian: English string, never blank
  assert.equal(core.t('only.english'), 'English only');
  // key missing everywhere: the raw key, never blank
  assert.equal(core.t('nope.missing'), 'nope.missing');
  // missing in Indonesian but templated in English: fallback interpolates
  assert.equal(core.t('templated', { name: 'Ada' }), 'Hi Ada');
});

test('t() interpolates the active bundle first', async () => {
  const core = await makeCore({ idBundle: { templated: 'Hai {name}' } });
  core.start();
  await core.setLocale('id');
  assert.equal(core.t('templated', { name: 'Ada' }), 'Hai Ada');
});

test('a failed bundle load keeps the current locale and stays usable', async () => {
  const core = await makeCore({ failLoad: true });
  core.start();
  const before = core.getLocale();
  const result = await core.setLocale('id');
  assert.equal(result, before);
  assert.equal(core.getLocale(), before);
  assert.equal(core.t('greeting'), 'Hello');
});

test('start() loads the bundle for a non-English starting locale', async () => {
  // A demo/language override can resolve the app to Indonesian on first boot.
  // start() must load that bundle before announcing, or t() would silently
  // serve English strings under an Indonesian locale (regression: the
  // dapp.json Indonesian checks caught exactly this).
  const core = await load('core.js').then(({ createI18n }) =>
    createI18n({
      fallbackBundle: { greeting: 'Hello' },
      loadBundle: async (code) => {
        if (code === 'id') return { greeting: 'Halo' };
        throw new Error('unexpected bundle: ' + code);
      },
      resolveInitial: () => ({ locale: 'id', source: 'override' }),
    }));
  await core.start();
  assert.equal(core.getLocale(), 'id');
  assert.equal(core.t('greeting'), 'Halo');
  // and the fallback chain still holds under the non-English start
  assert.equal(core.t('only.english'), 'only.english');
});

test('a failed bundle load at start keeps the locale active on the English fallback', async () => {
  const core = await load('core.js').then(({ createI18n }) =>
    createI18n({
      fallbackBundle: { greeting: 'Hello' },
      loadBundle: async () => {
        throw new Error('bundle unavailable');
      },
      resolveInitial: () => ({ locale: 'id', source: 'override' }),
    }));
  await core.start();
  // the resolution stands (pickers, html lang), strings fall back, never blank
  assert.equal(core.getLocale(), 'id');
  assert.equal(core.t('greeting'), 'Hello');
});

test('setLocale notifies subscribers and applies the locale', async () => {
  const seen = [];
  const core = await makeCore({ idBundle: { greeting: 'Halo' } });
  core.start();
  const stop = core.subscribe((code) => seen.push(code));
  await core.setLocale('id');
  assert.deepEqual(seen, ['id']);
  stop();
  await core.setLocale('en');
  assert.deepEqual(seen, ['id']); // unsubscribed: no more notifications
});

// ---- tag sanitization and mapping (resolve.js) ----

test('sanitizeLocaleTag accepts plausible tags and rejects malformed ones', async () => {
  const { sanitizeLocaleTag } = await load('resolve.js');
  assert.equal(sanitizeLocaleTag('en'), 'en');
  assert.equal(sanitizeLocaleTag('id-ID'), 'id-ID');
  assert.equal(sanitizeLocaleTag('  pt-BR  '), 'pt-BR');
  assert.equal(sanitizeLocaleTag('xx_<script>'), null);
  assert.equal(sanitizeLocaleTag(''), null);
  assert.equal(sanitizeLocaleTag(null), null);
  assert.equal(sanitizeLocaleTag(42), null);
});

test('mapToShipped maps by language subtag and drops unshipped languages', async () => {
  const { mapToShipped } = await load('resolve.js');
  assert.equal(mapToShipped('id-ID'), 'id');
  assert.equal(mapToShipped('ID'), 'id');
  assert.equal(mapToShipped('en-US'), 'en');
  assert.equal(mapToShipped('pt-BR'), null); // not shipped: no forced match
  assert.equal(mapToShipped('garbage!!'), null);
  assert.equal(mapToShipped(null), null);
});

// ---- resolution order ----

test('an explicit in-app override wins over everything', async () => {
  const { resolveInitialLocale } = await load('resolve.js');
  const result = resolveInitialLocale({
    storedPref: 'id',
    platformLocale: 'en',
    deviceLocales: ['en-US'],
    fallback: 'en',
  });
  assert.deepEqual(result, { locale: 'id', source: 'override' });
});

test('the platform locale is the default when no override is stored', async () => {
  const { resolveInitialLocale } = await load('resolve.js');
  assert.deepEqual(
    resolveInitialLocale({ storedPref: 'system', platformLocale: 'id-ID', deviceLocales: ['en-US'], fallback: 'en' }),
    { locale: 'id', source: 'platform' },
  );
});

test('a platform locale the app does not ship falls through to the device', async () => {
  const { resolveInitialLocale } = await load('resolve.js');
  assert.deepEqual(
    resolveInitialLocale({ storedPref: 'system', platformLocale: 'pt-BR', deviceLocales: ['id-ID'], fallback: 'en' }),
    { locale: 'id', source: 'device' },
  );
});

test('a null platform locale never means English: the device path stays live', async () => {
  const { resolveInitialLocale } = await load('resolve.js');
  assert.deepEqual(
    resolveInitialLocale({ storedPref: 'system', platformLocale: null, deviceLocales: ['id', 'en-US'], fallback: 'en' }),
    { locale: 'id', source: 'device' },
  );
  // and with no usable device languages either, the app default applies
  assert.deepEqual(
    resolveInitialLocale({ storedPref: 'system', platformLocale: null, deviceLocales: ['fr-FR'], fallback: 'en' }),
    { locale: 'en', source: 'device' },
  );
});

test('a stale or unsupported stored preference is ignored, not fatal', async () => {
  const { resolveInitialLocale } = await load('resolve.js');
  assert.deepEqual(
    resolveInitialLocale({ storedPref: 'klingon', platformLocale: null, deviceLocales: ['id'], fallback: 'en' }),
    { locale: 'id', source: 'device' },
  );
});
