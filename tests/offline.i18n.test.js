// Locale parity for the offline strings (Phase 12A) and the offline search
// strings (Phase 12B). The Indonesian bundle must fully cover the English
// offline.* and profile.offline* keys, placeholders must match, and no
// user-facing string carries an em dash. The offline.search* keys are covered
// by the same offline. prefix.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let en;
let id;

test.before(async () => {
  en = (await import('../public/js/i18n/locales/en.js')).default;
  id = (await import('../public/js/i18n/locales/id.js')).default;
});

const PREFIXES = ['offline.', 'profile.offline'];

function keysOf(bundle) {
  return Object.keys(bundle).filter((k) => PREFIXES.some((p) => k.startsWith(p)));
}

test('every offline string in English exists in Indonesian', () => {
  const keys = keysOf(en);
  assert.ok(keys.length >= 30, `the offline section is present (${keys.length} keys)`);
  const missing = keys.filter((k) => typeof id[k] !== 'string' || !id[k].trim());
  assert.deepEqual(missing, []);
});

test('no offline string exists only in Indonesian', () => {
  const orphaned = keysOf(id).filter((k) => typeof en[k] !== 'string');
  assert.deepEqual(orphaned, []);
});

test('the spec word table is used verbatim', () => {
  assert.equal(en['offline.title'], 'Offline Areas');
  assert.equal(id['offline.title'], 'Area Offline');
  assert.equal(en['offline.open'], 'Open offline areas');
  assert.equal(id['offline.open'], 'Buka area offline');
  assert.equal(en['offline.chooseRegion'], 'Choose a region');
  assert.equal(id['offline.chooseRegion'], 'Pilih wilayah');
  assert.equal(en['offline.download'], 'Download');
  assert.equal(id['offline.download'], 'Unduh');
  assert.equal(en['offline.cancel'], 'Cancel');
  assert.equal(id['offline.cancel'], 'Batalkan');
  assert.equal(en['offline.delete'], 'Delete');
  assert.equal(id['offline.delete'], 'Hapus');
  assert.equal(en['offline.readyOffline'], 'Ready offline');
  assert.equal(id['offline.readyOffline'], 'Siap digunakan offline');
  assert.equal(en['offline.emptyTitle'], 'No offline areas yet');
  assert.equal(id['offline.emptyTitle'], 'Belum ada area offline');
  assert.equal(en['offline.tryAgain'], 'Try again');
  assert.equal(id['offline.tryAgain'], 'Coba lagi');
  assert.equal(en['offline.checkAgain'], 'Check again');
  assert.equal(id['offline.checkAgain'], 'Periksa lagi');
  assert.equal(en['offline.blockedTitle'], 'Offline downloads are unavailable');
  assert.equal(id['offline.blockedTitle'], 'Pengunduhan offline tidak tersedia');
});

test('the offline search word table is used verbatim', () => {
  // Phase 12B shares the Phase 12A words and adds no synonyms.
  assert.equal(en['offline.searchBadge'], 'Offline');
  assert.equal(id['offline.searchBadge'], 'Offline');
  assert.equal(en['offline.searchNoResultsTitle'], 'No results');
  assert.equal(id['offline.searchNoResultsTitle'], 'Tidak ada hasil');
  assert.equal(en['offline.open'], 'Open offline areas');
  assert.equal(id['offline.open'], 'Buka area offline');
});

test('offline interpolation placeholders match between the bundles', () => {
  const placeholders = (tpl) => [...String(tpl).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of keysOf(en)) {
    assert.deepEqual(placeholders(id[key]), placeholders(en[key]), `placeholders of ${key} must match`);
  }
});

test('no offline string carries an em dash (user-facing copy rule)', () => {
  for (const bundle of [en, id]) {
    for (const [key, value] of Object.entries(bundle)) {
      if (!PREFIXES.some((p) => key.startsWith(p))) continue;
      assert.ok(!String(value).includes('—'), `${key} must not contain an em dash`);
    }
  }
});

test('every offline key the screen and components call exists in both bundles', () => {
  // Pulled from the t('...') call sites in the offline screen, the download
  // rows and the picker, so a renamed key cannot silently render undefined.
  const used = [
    'offline.title', 'offline.intro', 'offline.loading', 'offline.open',
    'offline.chooseRegion', 'offline.chooseRegionBody', 'offline.download',
    'offline.downloading', 'offline.preparing', 'offline.progressTiles',
    'offline.downloadedBytes', 'offline.cancel', 'offline.delete',
    'offline.deleteTitle', 'offline.deleteBody', 'offline.readyOffline',
    'offline.completedOn', 'offline.regionDetail', 'offline.emptyTitle',
    'offline.emptyBody', 'offline.areasTitle', 'offline.storageUsed',
    'offline.tryAgain', 'offline.checkAgain', 'offline.blockedTitle',
    'offline.blockedBody', 'offline.unsupportedTitle', 'offline.unsupportedBody',
    'offline.storedTitle', 'offline.interruptedTitle', 'offline.interruptedBody',
    'offline.failedTitle', 'offline.failedBody', 'offline.storageLimitTitle',
    'offline.storageLimitBody', 'offline.presetZoom', 'offline.presetSize',
    'profile.offlineTitle', 'profile.offlineBody',
    // Phase 12B offline search. Every key the search service, the results
    // panel, the Place card and the two screens call.
    'offline.searchBadge', 'offline.searchScope', 'offline.searchNoResultsTitle',
    'offline.searchNoResults', 'offline.searchNoAreasTitle', 'offline.searchNoAreasBody',
    'offline.searchUnsupportedTitle', 'offline.searchUnsupportedBody',
    'offline.searchDisabledTitle', 'offline.searchDisabledBody',
    'offline.searchAttribution', 'offline.searchDegraded',
    'offline.searchKindCountry', 'offline.searchKindRegion', 'offline.searchKindCity',
    'offline.searchKindTown', 'offline.searchKindVillage', 'offline.searchKindSuburb',
    'offline.searchKindPlace',
  ];
  const missingEn = used.filter((k) => typeof en[k] !== 'string');
  const missingId = used.filter((k) => typeof id[k] !== 'string');
  assert.deepEqual(missingEn, []);
  assert.deepEqual(missingId, []);
});