// Tests for the app's icon files and the head tags that point at them:
// the browser tab, phone home screens and installable browsers all read
// these, so a broken link or a wrong PNG header shows up outside the app.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (name) => fs.readFileSync(path.join(PUBLIC, name));

test('index.html links the icon file, apple touch icon and manifest, with theme colours', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /<link rel="icon" href="\/icon\.svg" type="image\/svg\+xml" sizes="any">/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/icon-192\.png">/);
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color" content="#0b0d12" media="\(prefers-color-scheme: dark\)">/);
  assert.match(html, /<meta name="theme-color" content="#f6f7f9" media="\(prefers-color-scheme: light\)">/);
  assert.doesNotMatch(html, /rel="icon"[^>]*href="data:/);
});

test('the manifest names the app and lists the icon files', () => {
  const manifest = JSON.parse(read('manifest.webmanifest').toString('utf8'));
  assert.equal(manifest.name, 'Homeroom Maps');
  assert.equal(manifest.short_name, 'Homeroom Maps');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.description, 'A global map and location platform built together with its community.');

  const bySrc = new Map(manifest.icons.map((icon) => [icon.src, icon]));
  for (const [src, size] of [['/icon-192.png', '192x192'], ['/icon-512.png', '512x512']]) {
    const icon = bySrc.get(src);
    assert.ok(icon, `${src} is listed`);
    assert.equal(icon.sizes, size);
    assert.equal(icon.type, 'image/png');
    assert.equal(icon.purpose, 'any maskable');
    assert.ok(fs.existsSync(path.join(PUBLIC, src)), `${src} exists`);
  }
  const svg = bySrc.get('/icon.svg');
  assert.ok(svg, '/icon.svg is listed');
  assert.equal(svg.type, 'image/svg+xml');
  assert.equal(svg.sizes, 'any');
  assert.ok(fs.existsSync(path.join(PUBLIC, 'icon.svg')));
});

test('icon.svg is the existing indigo mark with a white dot, and nothing executable', () => {
  const svg = read('icon.svg').toString('utf8');
  assert.match(svg, /viewBox="0 0 100 100"/);
  assert.match(svg, /<circle[^>]*fill="#6366f1"/);
  assert.match(svg, /<circle[^>]*fill="white"/);
  assert.doesNotMatch(svg, /<script/i);
  assert.doesNotMatch(svg, /<text/i);
});

test('the PNG icons are opaque RGBA images of the declared size', () => {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512]]) {
    const png = read(name);
    assert.deepEqual(png.subarray(0, 8), signature, `${name} starts with the PNG signature`);
    assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
    assert.equal(png.readUInt32BE(16), size, `${name} width`);
    assert.equal(png.readUInt32BE(20), size, `${name} height`);
    assert.equal(png[24], 8, `${name} bit depth`);
    assert.equal(png[25], 6, `${name} colour type is RGBA`);
  }
});
