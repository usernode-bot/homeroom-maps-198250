// Location sharing client core (Phase 12F) — the update loop and consent
// memory, with the clock, timers and network state injected. No DOM, no
// fetch. Mirrors navigation.session.test.js's pure-core style.
//
// What is proven here: posts happen only while the share is active AND the
// app is visible AND the device is online; a permission decision stops the
// loop for good; the server saying the share is over stops the loop; offline
// is an honest pause that recovers by itself; and consent dies with the page
// load, so a reload never resumes posting by itself.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

let core;

test.before(async () => {
  core = await import('../public/js/services/sharing-core.js');
});

// An injected clock whose scheduled callbacks fire on advance().
function makeClock() {
  const timers = [];
  let t = 0;
  return {
    t,
    now: () => t,
    schedule(fn, ms) {
      const timer = { at: t + ms, fn, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    advance(ms) {
      t += ms;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= t) {
          timer.cancelled = true;
          timer.fn();
        }
      }
    },
    pending() {
      return timers.filter((x) => !x.cancelled).length;
    },
  };
}

// Let the loop's promise chain settle without letting real timers run.
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(setImmediate);
}

const fakeT = (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key);

function makeLoop(overrides = {}) {
  const calls = { fixes: 0, posts: 0 };
  const clock = overrides.clock || makeClock();
  const online = overrides.isOnline || (() => true);
  const getFix =
    overrides.getFix ||
    (async () => {
      calls.fixes += 1;
      return { lat: 52.52, lng: 13.405, accuracy: 12 };
    });
  const postLocation =
    overrides.postLocation ||
    (async () => {
      calls.posts += 1;
    });
  const states = [];
  const loop = core.createSharingLoop({
    sessionId: '7',
    getFix,
    postLocation,
    isOnline: online,
    schedule: clock.schedule,
    now: clock.now,
    intervalMs: 30000,
    onState: (s) => states.push(s.state),
    ...overrides.config,
  });
  return { loop, calls, clock, states, online };
}

test('consent memory dies with the page load, so a reload never resumes', () => {
  assert.equal(core.consentedTo(7), false);
  core.consentToSession('7');
  assert.equal(core.consentedTo(7), true);
  assert.equal(core.consentedTo('7'), true);
  assert.equal(core.consentedTo(8), false);
  core.forgetConsent();
  assert.equal(core.consentedTo(7), false);
});

test('the loop posts one fix immediately and then on the cadence', async () => {
  const { loop, calls, clock } = makeLoop();
  loop.start();
  await settle();
  assert.equal(calls.fixes, 1);
  assert.equal(calls.posts, 1);
  assert.equal(core.consentedTo(7), false); // the loop itself grants nothing

  clock.advance(30000);
  await settle();
  assert.equal(calls.posts, 2);

  // Stopping cancels the pending tick: no further posts, ever.
  loop.stop();
  clock.advance(30000);
  await settle();
  assert.equal(calls.posts, 2);
  assert.equal(clock.pending(), 0);
});

test('a hidden app posts nothing; showing it resumes the same share', async () => {
  const { loop, calls, clock } = makeLoop();
  loop.start();
  await settle();
  assert.equal(calls.posts, 1);

  loop.setVisible(false);
  clock.advance(120000);
  await settle();
  assert.equal(calls.posts, 1);

  loop.setVisible(true);
  await settle();
  assert.equal(calls.posts, 2);
  assert.equal(loop.snapshot().state, core.SHARING_LOOP.ACTIVE);
});

test('offline is an honest pause: no fixes, no posts, and it recovers alone', async () => {
  let online = false;
  const { loop, calls, clock } = makeLoop({ isOnline: () => online });
  loop.start();
  await settle();
  assert.equal(loop.snapshot().state, core.SHARING_LOOP.OFFLINE);
  assert.equal(calls.fixes, 0);
  assert.equal(calls.posts, 0);

  // Coming back online, the next check posts without anyone asking.
  online = true;
  clock.advance(5000);
  await settle();
  assert.equal(calls.posts, 1);
  assert.equal(loop.snapshot().state, core.SHARING_LOOP.ACTIVE);
});

test('a permission decision stops the loop for good — no silent retry', async () => {
  let fixAttempts = 0;
  const { loop, clock } = makeLoop({
    getFix: async () => {
      fixAttempts += 1;
      const err = new Error('User denied geolocation');
      err.reason = 'denied';
      throw err;
    },
  });
  loop.start();
  await settle();
  assert.equal(loop.snapshot().state, core.SHARING_LOOP.PERMISSION_LOST);

  // Neither time nor visibility brings it back: that is a person's decision.
  clock.advance(300000);
  await settle();
  assert.equal(fixAttempts, 1);
  loop.setVisible(true);
  await settle();
  assert.equal(fixAttempts, 1);
  assert.equal(clock.pending(), 0);
});

test('the server saying the share ended stops the loop and reports it', async () => {
  let postAttempts = 0;
  const { loop, clock } = makeLoop({
    postLocation: async () => {
      postAttempts += 1;
      const err = new Error('That share has already ended.');
      err.code = 'session_ended';
      throw err;
    },
  });
  loop.start();
  await settle();
  assert.equal(loop.snapshot().state, core.SHARING_LOOP.ENDED);
  assert.equal(postAttempts, 1);
  clock.advance(300000);
  await settle();
  assert.equal(postAttempts, 1);
  assert.equal(clock.pending(), 0);
});

test('a transient failure keeps trying on the cadence', async () => {
  let fail = true;
  const { loop, calls, clock } = makeLoop({
    postLocation: async () => {
      if (fail) {
        fail = false;
        const err = new Error('We could not reach the server.');
        err.code = 'network_error';
        throw err;
      }
    },
  });
  loop.start();
  await settle();
  assert.equal(loop.snapshot().state, core.SHARING_LOOP.FIX_FAILED);
  assert.equal(loop.snapshot().lastError, 'We could not reach the server.');

  clock.advance(30000);
  await settle();
  assert.equal(loop.snapshot().state, core.SHARING_LOOP.ACTIVE);
  assert.equal(loop.snapshot().lastPostedAt, 30000);
});

test('staleness helpers: the honest ages the screen words are built from', () => {
  assert.equal(core.isStale(null), false);
  assert.equal(core.isStale(60), false);
  assert.equal(core.isStale(301), true);
  assert.equal(core.isVeryStale(3599), false);
  assert.equal(core.isVeryStale(3600), true);

  assert.equal(core.ageLabel(null, { t: fakeT }), 'sharing.noUpdateYet');
  // The minute word is itself a translated key, so the fake t() shows it.
  assert.equal(core.ageLabel(30, { t: fakeT }), 'sharing.lastSeen:{"age":"1 sharing.minShort"}');
  assert.equal(core.ageLabel(300, { t: fakeT }), 'sharing.lastSeen:{"age":"5 sharing.minShort"}');
  assert.equal(core.ageLabel(3600, { t: fakeT }), 'sharing.noUpdateHour');

  assert.equal(
    core.expiresInLabel(42 * 60, { t: fakeT }),
    'sharing.expiresIn:{"age":"42 sharing.minShort"}',
  );
  assert.equal(
    core.expiresInLabel(185 * 60, { t: fakeT }),
    'sharing.expiresIn:{"age":"3 sharing.hourShort 5 sharing.minShort"}',
  );
  assert.equal(core.expiresInLabel(0, { t: fakeT }), 'sharing.sessionEndedNote');
});

test('the consent line names the people and the end time, and nothing else', () => {
  const line = core.consentText(['bob', 'carol'], '18:30', { t: fakeT });
  assert.equal(
    line,
    'sharing.consent:{"names":"bob, carol","ends":"18:30"}',
  );
});

test('the device status line maps every loop state to its words', () => {
  const L = core.SHARING_LOOP;
  assert.equal(core.deviceStatusText(null, { t: fakeT }), null);
  assert.equal(core.deviceStatusText({ state: L.ACTIVE }, { t: fakeT }), 'sharing.postingOn');
  assert.equal(core.deviceStatusText({ state: L.OFFLINE }, { t: fakeT }), 'sharing.postingPausedOffline');
  assert.equal(core.deviceStatusText({ state: L.FIX_FAILED }, { t: fakeT }), 'sharing.postingFailed');
  assert.equal(
    core.deviceStatusText({ state: L.PERMISSION_LOST }, { t: fakeT }),
    'sharing.locationOffTitle',
  );
  assert.equal(core.deviceStatusText({ state: L.ENDED }, { t: fakeT }), 'sharing.sessionEndedNote');
});
