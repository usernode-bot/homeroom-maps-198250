// Route tests for the two place routes as server.js actually wires them:
// the real server process, a real database (its own throwaway schema) and a
// real RS256 iframe token. No place provider is configured, so both routes
// must answer the honest typed not_configured (501) — this pins the wiring
// (server.js must call the bound service from createPlaceService, not the
// module, which only exports the factory) without depending on any upstream.
//
// Needs a database: TEST_DATABASE_URL, else INLOOP_DATABASE_URL. Skipped,
// loudly, when neither is set.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const DB_URL = process.env.TEST_DATABASE_URL || process.env.INLOOP_DATABASE_URL;
const skip = DB_URL ? false : 'set TEST_DATABASE_URL to run the Postgres tests';

const APP_ID = '4242';
const schema = `places_routes_test_${process.pid}_${Date.now()}`;

// server.js reads the PEM from the env; node-postgres takes extra connection
// options through the connection string's `options` parameter.
function dbUrlForSchema() {
  const sep = DB_URL.includes('?') ? '&' : '?';
  return `${DB_URL}${sep}options=-c%20search_path%3D${schema}`;
}

function mintToken(privatePem) {
  return jwt.sign(
    { id: 501, username: 'routes-test-user', locale: null, pur: 'iframe' },
    privatePem,
    { algorithm: 'RS256', issuer: 'usernode', audience: `usernode:app:${APP_ID}`, expiresIn: '10m' },
  );
}

async function waitForHealth(base, child, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {}
    if (Date.now() > deadline) throw new Error('server did not become healthy in time');
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('the place routes answer the typed not_configured, not a TypeError', { skip }, async () => {
  // Throwaway keypair, generated per run: the server verifies tokens with the
  // public half exactly as production does; nothing here is a credential.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'places-routes-'));
  const pubPath = path.join(dir, 'pub.pem');
  const privPath = path.join(dir, 'priv.pem');
  fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
  fs.writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const pool = new (require('pg').Pool)({ connectionString: DB_URL });
  await pool.query(`CREATE SCHEMA ${schema}`);

  const port = 18000 + (process.pid % 2000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      USERNODE_ENV: 'production',
      DATABASE_URL: dbUrlForSchema(),
      USERNODE_JWT_PUBLIC_KEY: fs.readFileSync(pubPath, 'utf8'),
      USERNODE_APP_ID: APP_ID,
      // Deliberately unset: PLACE_PROVIDER has no adapter yet, which is the
      // state the routes must answer honestly about.
      PLACE_PROVIDER: '',
    },
    stdio: 'ignore',
  });

  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForHealth(base, child);
    const headers = { 'x-usernode-token': mintToken(fs.readFileSync(privPath, 'utf8')) };

    for (const [path_, expectQuery] of [
      ['/api/places?q=berlin', /No place provider is connected yet/],
      ['/api/places/some-id', /No place provider is connected yet/],
    ]) {
      const res = await fetch(base + path_, { headers });
      const body = await res.json();
      assert.equal(res.status, 501, `${path_} should be the honest 501`);
      assert.equal(body.error && body.error.code, 'not_configured');
      assert.match(body.error && body.error.message, expectQuery);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => {
      if (child.exitCode !== null) return r();
      child.on('exit', r);
      setTimeout(() => {
        child.kill('SIGKILL');
        r();
      }, 3000).unref();
    });
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
