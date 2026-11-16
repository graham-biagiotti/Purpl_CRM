// v273 wholesale application form browser test.
// Run: node tests/portal/apply-form-browser-test.js "$PWD/public" <screenshot-dir>
// Needs Playwright + Chromium (not part of the dependency-free backtest arsenal).
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PUB = process.argv[2], OUT = process.argv[3];
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.jpg':'image/jpeg', '.png':'image/png', '.PNG':'image/png', '.pdf':'application/pdf' };
const srv = http.createServer((req, res) => {
  const f = path.join(PUB, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const STUB = `window.__added = [];
  var fsFn = function(){ return { collection: function(){ return { add: function(doc){ window.__added.push(doc); return Promise.resolve({ id: 'x1' }); } }; } }; };
  fsFn.FieldValue = { serverTimestamp: function(){ return '__ts__'; } };
  window.firebase = { initializeApp(){}, firestore: fsFn,
    functions(){ return { httpsCallable(name){ return function(){ return Promise.resolve({ data: {} }); }; } }; } };`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };

(async () => {
  await new Promise(r => srv.listen(0, r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/firebasejs/**', r => r.fulfill({ contentType: 'text/javascript', body: STUB }));
  await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
  await page.route('**/maps.googleapis.com/**', r => r.abort());
  await page.route('https://purpl-crm.web.app/images/**', r => { const f = path.join(PUB, 'images', r.request().url().split('/images/')[1]); fs.existsSync(f) ? r.fulfill({ path: f }) : r.abort(); });
  await page.goto(base + '/wholesale.html');

  for (const id of ['ws-address', 'ws-address2', 'ws-city', 'ws-state', 'ws-zip']) ok(await page.locator('#' + id).count() === 1, 'field #' + id + ' present');
  await page.evaluate(() => wsToggleBrand('purpl'));
  await page.fill('#ws-business', 'Test Market'); await page.fill('#ws-name', 'Pat Tester'); await page.fill('#ws-email', 'pat@example.com');

  // no address → blocked
  await page.evaluate(() => wsSubmitApplication());
  ok((await page.evaluate(() => window.__added.length)) === 0, 'no address → application is NOT submitted');
  ok(await page.locator('#e-ws-address').isVisible() && await page.locator('#e-ws-zip').isVisible(), 'address errors are shown');

  // city + state only (the old "City, State is fine") → still blocked
  await page.fill('#ws-city', 'Warner'); await page.fill('#ws-state', 'nh');
  await page.evaluate(() => wsSubmitApplication());
  ok((await page.evaluate(() => window.__added.length)) === 0, 'city + state alone is no longer enough');

  // bad zip → blocked
  await page.fill('#ws-address', '12 Main St'); await page.fill('#ws-zip', '0327');
  await page.evaluate(() => wsSubmitApplication());
  ok((await page.evaluate(() => window.__added.length)) === 0 && await page.locator('#e-ws-zip').isVisible(), 'a 4-digit zip is rejected');

  // picking a dropdown suggestion splits it into the boxes
  await page.evaluate(() => {
    const el = document.getElementById('ws-address');
    el.value = '99 Depot Rd, Concord, NH 03301, USA';
    el.dataset.addrParts = JSON.stringify({ street1: '99 Depot Rd', street2: '', city: 'Concord', state: 'NH', zip: '03301' });
    el.dataset.lat = '43.2'; el.dataset.lng = '-71.5';
    el.dispatchEvent(new Event('addressSelected', { bubbles: true }));
  });
  ok((await page.inputValue('#ws-address')) === '99 Depot Rd' && (await page.inputValue('#ws-city')) === 'Concord' && (await page.inputValue('#ws-zip')) === '03301',
    'a picked suggestion fills street, city and zip separately');
  await page.screenshot({ path: path.join(OUT, 'apply-form-phone.png'), fullPage: false });
  // The page already scrolls sideways a little on phones because of the
  // product cards higher up (present before v273). This checks only that the
  // new address fields stay inside the screen.
  const addrFits = await page.evaluate(() => { const W = document.documentElement.clientWidth; return ['ws-address','ws-address2','ws-city','ws-state','ws-zip'].every(id => document.getElementById(id).getBoundingClientRect().right <= W + 1); });
  ok(addrFits, 'the new address fields fit a phone screen');

  await page.evaluate(() => wsSubmitApplication());
  await page.waitForFunction(() => window.__added.length === 1, null, { timeout: 5000 });
  const doc = await page.evaluate(() => window.__added[0]);
  ok(doc.address === '99 Depot Rd, Concord, NH 03301', 'application address line: ' + doc.address);
  ok(JSON.stringify(doc.addrParts) === JSON.stringify({ street1: '99 Depot Rd', street2: '', city: 'Concord', state: 'NH', zip: '03301' }), 'application carries street/city/state/zip separately');
  ok(doc.lat === 43.2 && doc.lng === -71.5, 'map location from the picked suggestion is kept');
  ok(Object.keys(doc).length < 20, 'application has ' + Object.keys(doc).length + ' fields (security rules allow fewer than 20)');
  ok(doc.businessName === 'Test Market' && doc.email === 'pat@example.com' && doc.status === 'new', 'the rest of the application is unchanged');
  ok(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); srv.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
