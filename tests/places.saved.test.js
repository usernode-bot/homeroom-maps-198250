// Tests for the SavedPlacesAdapter contract (public/js/services/saved.js):
// the placeholder service refuses honestly (not_configured, no fake saved
// data), a real adapter is validated at the wiring site, and a wired adapter
// passes through untouched.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Browser ESM module, loaded lazily inside each test: a CommonJS file may
// not carry a top-level await (Node 22 refuses the mix).
let SavedPlacesUnavailableError = null;
let createSavedPlacesService = null;
let savedModule = null;
async function loadModule() {
  if (savedModule) return;
  savedModule = await import('../public/js/services/saved.js');
  ({ SavedPlacesUnavailableError, createSavedPlacesService } = savedModule);
}
function savedTest(name, fn) {
  return test(name, async (t) => {
    await loadModule();
    return fn(t);
  });
}

function memoryAdapter() {
  const ids = new Set();
  return {
    save: async (id) => ids.add(id),
    unsave: async (id) => ids.delete(id),
    isSaved: async (id) => ids.has(id),
    list: async () => [...ids],
  };
}

savedTest('the placeholder service refuses every action with a typed not_configured error', async () => {
  const saved = createSavedPlacesService(null);
  await assert.rejects(() => saved.save('p1'), (err) => {
    assert.ok(err instanceof SavedPlacesUnavailableError);
    assert.equal(err.code, 'not_configured');
    return true;
  });
  await assert.rejects(() => saved.unsave('p1'), (err) => err.code === 'not_configured');
  await assert.rejects(() => saved.isSaved('p1'), (err) => err.code === 'not_configured');
  await assert.rejects(() => saved.list(), (err) => err.code === 'not_configured');
});

savedTest('the error is recognisable without instanceof, too', async () => {
  const saved = createSavedPlacesService(null);
  try {
    await saved.list();
    assert.fail('list() should have thrown');
  } catch (err) {
    assert.equal(err.name, 'SavedPlacesUnavailableError');
    assert.match(err.message, /not built yet/);
  }
});

savedTest('a wired adapter must implement the whole contract, named at the wiring site', () => {
  const full = memoryAdapter();
  for (const missing of ['save', 'unsave', 'isSaved', 'list']) {
    const broken = { ...full };
    delete broken[missing];
    assert.throws(() => createSavedPlacesService(broken), (err) => {
      assert.match(err.message, new RegExp(missing));
      return true;
    });
  }
  assert.doesNotThrow(() => createSavedPlacesService(full));
});

savedTest('a wired adapter passes calls through and keeps its own state', async () => {
  const adapter = memoryAdapter();
  const saved = createSavedPlacesService(adapter);
  assert.equal(await saved.isSaved('p1'), false);
  await saved.save('p1');
  assert.equal(await saved.isSaved('p1'), true);
  assert.deepEqual(await saved.list(), ['p1']);
  await saved.unsave('p1');
  assert.equal(await saved.isSaved('p1'), false);
  assert.deepEqual(await saved.list(), []);
});