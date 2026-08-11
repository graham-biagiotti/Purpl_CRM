#!/usr/bin/env node
// ─────────────────────────────────────────────────────────
// sync-wholesale.js
// Auto-copies the shared public/ files into public-wholesale/
// so the pbfwholesale.com site always matches the source.
//
// Runs automatically before `firebase deploy` (predeploy hook in
// firebase.json). You only ever edit files in public/ — this keeps
// public-wholesale/ in sync so you never have to copy by hand.
// ─────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'public');
const DST = path.join(__dirname, 'public-wholesale');

// Files copied as-is from public/ → public-wholesale/
const COPY_AS_IS = [
  'order.html',
  'find-us.html',
  'sampling.html',
  'privacy.html',
  'terms.html',
  '404.html',
  'firebase-config.js',
  'places.js',
];

// wholesale.html becomes the wholesale site's index.html
const INDEX_SOURCE = 'wholesale.html';

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function copyFile(srcPath, dstPath) {
  fs.copyFileSync(srcPath, dstPath);
}

// 1. wholesale.html → public-wholesale/index.html
ensureDir(DST);
copyFile(path.join(SRC, INDEX_SOURCE), path.join(DST, 'index.html'));

// 2. shared pages, with the one transform order.html needs:
//    on the wholesale site, the "apply" link points at / (the wholesale
//    page IS index.html there), not /wholesale.html
for (const f of COPY_AS_IS) {
  const srcPath = path.join(SRC, f);
  if (!fs.existsSync(srcPath)) continue;
  if (f === 'order.html') {
    let html = fs.readFileSync(srcPath, 'utf8');
    html = html.replace(/href="\/wholesale\.html"/g, 'href="/"');
    fs.writeFileSync(path.join(DST, f), html);
  } else {
    copyFile(srcPath, path.join(DST, f));
  }
}

// 3. images (all of them)
const srcImg = path.join(SRC, 'images');
const dstImg = path.join(DST, 'images');
if (fs.existsSync(srcImg)) {
  ensureDir(dstImg);
  for (const img of fs.readdirSync(srcImg)) {
    copyFile(path.join(srcImg, img), path.join(dstImg, img));
  }
}

console.log('✓ Synced public/ → public-wholesale/ (wholesale site ready)');
