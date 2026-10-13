// The browser module graph links: every static import under public/js names
// an export its target module really provides, and every imported file
// exists.
//
// The app's screens load through ONE static graph rooted at public/js/app.js,
// so a single import of a name a module no longer exports stops the browser
// before anything renders, on every screen at once. Unit tests that import a
// module directly never notice: they never load the importer. This test
// imports every module (app.js first) and fails on a link or parse error.
// Evaluation errors such as "window is not defined" are expected here, since
// Node has no DOM, and they only happen after the whole graph has linked.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', 'public', 'js');

function modules(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...modules(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

// A link or parse failure, as opposed to an error thrown while evaluating.
function isLinkError(err) {
  return err instanceof SyntaxError || (err && err.code === 'ERR_MODULE_NOT_FOUND');
}

test('every browser module links, starting from app.js', async () => {
  const entry = path.join(ROOT, 'app.js');
  const files = [entry, ...modules(ROOT).filter((f) => f !== entry)];
  assert.ok(files.length > 50, 'expected to find the app modules under public/js');
  const broken = [];
  for (const file of files) {
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      if (isLinkError(err)) {
        broken.push(`${path.relative(ROOT, file)}: ${String(err.message).split('\n')[0]}`);
      }
    }
  }
  assert.deepEqual(broken, [], `modules that fail to link:\n${broken.join('\n')}`);
});
