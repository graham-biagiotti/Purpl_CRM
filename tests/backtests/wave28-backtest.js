// Wave 28 backtests — v256 platform wave: Firebase SDK unified across every
// page (public pages were two majors behind the CRM), functions dependency
// bumps (deploy warning + audit criticals), service worker caches the
// versioned CDN files so the app can cold-start offline (while Firestore/
// auth/Maps traffic stays strictly network-only), and a VERIFIABLE SRI hash
// on Chart.js (npm-shipped file; jsdelivr's .min was their re-minification).
// The legacy Maps control migration is deliberately NOT in this wave (v257).
'use strict';
const fs = require('fs');
const path = require('path');
const pub = p => fs.readFileSync(path.join(__dirname, '../../public', p), 'utf8');
const src = pub('app.js');
const swSrc = pub('sw.js');
const idx = pub('index.html');
const fnPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../functions/package.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] version + one SDK version everywhere');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const pages = fs.readdirSync(path.join(__dirname, '../../public')).filter(f => f.endsWith('.html'));
  const versions = new Set();
  pages.forEach(f => {
    const m = pub(f).match(/firebasejs\/(\d+\.\d+\.\d+)/g) || [];
    m.forEach(x => versions.add(x.replace('firebasejs/', '')));
  });
  ok(versions.size === 1 && versions.has('10.12.2'),
    `every page loads the SAME Firebase SDK (${[...versions].join(', ')})`);
}

console.log('[B] service worker — offline cold-start without caching live data');
{
  ok(swSrc.includes("'/field.html'"), 'field app shell precached');
  // Run the REAL allowlist.
  const fnSrc = slc(swSrc, 'function _cacheableCdn(url)', '\n}') + '\n}';
  const cdn = new Function('URL', fnSrc + '\nreturn _cacheableCdn;')(URL);
  ok(cdn('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js') === true,
    'firebase SDK files cacheable');
  ok(cdn('https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.js') === true, 'Chart.js cacheable');
  ok(cdn('https://fonts.googleapis.com/css2?family=Inter') === true
     && cdn('https://fonts.gstatic.com/s/inter/v12/x.woff2') === true, 'fonts cacheable');
  ok(cdn('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel') === false,
    'Firestore traffic NEVER cacheable (live data)');
  ok(cdn('https://maps.googleapis.com/maps/api/js?key=x') === false,
    'Maps NEVER cacheable (auth/quota dynamic)');
  ok(cdn('https://www.gstatic.com/recaptcha/whatever.js') === false,
    'gstatic is only cacheable under /firebasejs/');
  ok(cdn('not a url') === false, 'malformed input fails closed');
  // Handler shape: cache-first for the allowlist, untouched for other
  // cross-origin, network-first for same-origin.
  const fh = slc(swSrc, "self.addEventListener('fetch'", '\n});');
  ok(/if \(_cacheableCdn\(e\.request\.url\)\) \{[\s\S]{0,400}caches\.match\(e\.request\)\.then\(hit => hit \|\| fetch/.test(fh),
    'allowlisted CDN files are cache-first (immutable per version)');
  ok(/res\.type === 'cors' \|\| res\.type === 'basic'/.test(fh),
    'cors responses now cached (the type===basic filter was the offline-blank bug)');
  ok(fh.includes("new URL(e.request.url).origin !== self.location.origin) return;"),
    'all other cross-origin traffic untouched');
  ok(/fetch\(e\.request\)\.then\(res => \{\s*\n\s*if \(res && res\.status === 200 && res\.type === 'basic'\)/.test(fh),
    'same-origin network-first behavior unchanged');
}

console.log('[C] Chart.js SRI — verifiable bytes');
{
  ok(idx.includes('chart.js@4.4.0/dist/chart.umd.js'),
    'loads the npm-shipped file (not the unverifiable jsdelivr re-min)');
  ok(idx.includes('integrity="sha384-FcQlsUOd0TJjROrBxhJdUhXTUgNJQxTMcxZe6nHbaEfFL1zjQ+bq/uRoBQxb0KMo"'),
    'integrity hash present (computed from the npm package bytes)');
  ok(/chart\.umd\.js"\s*\n\s*integrity="sha384-[^"]+"[\s\S]{0,40}crossorigin="anonymous"/.test(idx),
    'crossorigin set (required for cross-origin SRI)');
  ok(!idx.includes('chart.umd.min.js'), 'no stray reference to the old file');
}

console.log('[B2] gate F1/F2 — ESM chromium shape + CORS-mode script tags');
{
  const fnSrc = fs.readFileSync(path.join(__dirname, '../../functions/index.js'), 'utf8');
  // Gate F1: chromium 153 is ESM — the bare require() returned the module
  // namespace and every invoice-PDF render threw. Shape-tolerant unwrap.
  ok(fnSrc.includes("const _chr = require('@sparticuz/chromium');")
     && fnSrc.includes('const chromium = _chr.default || _chr;'),
    '_htmlToPdf unwraps the ESM default export (gate F1 — PDF emails)');
  // Gate F2: without crossorigin the browser fetches these no-cors → OPAQUE
  // responses the SW can never cache — the offline cold-start fix was inert.
  const fld = pub('field.html');
  [['index.html', idx], ['field.html', fld]].forEach(([name, t]) => {
    const tags = t.match(/<script src="https:\/\/www\.gstatic\.com\/firebasejs\/[^"]+"[^>]*>/g) || [];
    ok(tags.length === 4 && tags.every(x => x.includes('crossorigin="anonymous"')),
      `${name}: all 4 SDK scripts fetch in CORS mode (cacheable by the SW, gate F2)`);
    ok(/fonts\.googleapis\.com[^>]+rel="stylesheet" crossorigin="anonymous"/.test(t),
      `${name}: font stylesheet fetches in CORS mode`);
  });
}

console.log('[D] functions dependencies');
{
  const dep = n => fnPkg.dependencies[n] || '';
  ok(/\^?7\.(4|[5-9])|\^?[89]\./.test(dep('firebase-functions')),
    `firebase-functions bumped (${dep('firebase-functions')}) — deploy warning cleared`);
  ok(/\^?25\./.test(dep('puppeteer-core')) && /\^?153/.test(dep('@sparticuz/chromium')),
    `puppeteer pair bumped together (${dep('puppeteer-core')} / ${dep('@sparticuz/chromium')})`);
  ok(/\^?6\.(3[7-9]|[4-9]\d)/.test(dep('resend')), `resend current (${dep('resend')})`);
  ok(/\^?17\./.test(dep('stripe')), 'stripe DELIBERATELY stays on 17 (money code; majors pin API versions)');
  ok(/\^?1\./.test(dep('svix')), 'svix deliberately stays on 1 (webhook verify API)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
