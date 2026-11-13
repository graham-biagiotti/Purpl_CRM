// v269 order-portal browser test. Run: node tests/portal/portal-browser-test.js "$PWD/public" <screenshot-dir>
// Needs Playwright + Chromium (not part of the backtest arsenal, which is dependency-free).
// Drives the real order.html in Chromium with Firebase stubbed out.
// Args: <publicDir> <outDir>
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PUB = process.argv[2], OUT = process.argv[3];
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.jpg':'image/jpeg', '.png':'image/png', '.PNG':'image/png', '.pdf':'application/pdf' };
const srv = http.createServer((req, res) => {
  const f = path.join(PUB, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const STUB = `window.firebase = { initializeApp(){}, firestore(){ return {}; },
  functions(){ return { httpsCallable(name){ return function(){ window.__calls=(window.__calls||[]); window.__calls.push(name); return Promise.reject(new Error('stub:'+name)); }; } }; } };`;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };

(async () => {
  await new Promise(r => srv.listen(0, r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await chromium.launch();
  for (const vp of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 390, height: 844 }]) {
    console.log('[' + vp.name + ']');
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/firebasejs/**', r => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.route('**/fonts.googleapis.com/**', r => r.fulfill({ contentType: 'text/css', body: '' }));
    await page.route('https://purpl-crm.web.app/images/**', r => { const f = path.join(PUB, 'images', r.request().url().split('/images/')[1]); fs.existsSync(f) ? r.fulfill({ path: f }) : r.abort(); });
    await page.goto(base + '/order.html');
    // Same steps the password gate takes on a correct password.
    await page.evaluate(() => {
      document.getElementById('password-gate').style.display = 'none';
      document.getElementById('order-form').style.display = '';
      pricePerCase = 27.6; portalMode = 'live';
      document.getElementById('price-display').textContent = '$27.60 per case'; document.getElementById('price-display').style.display = 'block';
      _brandPurpl = true; _brandLf = true; updateBrandVisibility();
    });
    await page.waitForSelector('#lf-sku-list .pcard');
    ok((await page.locator('#lf-sku-list .pcard').count()) === 8, 'fallback catalog renders 8 product cards');
    ok((await page.locator('#lf-vmodal-host .vmodal').count()) === 3, 'three products have a variety pop-up');
    const firstThree = await page.evaluate(() => [...document.querySelectorAll('#lf-sku-list .pcard')].slice(0, 3).map(c => !!c.querySelector('.pbtn')));
    ok(firstThree.every(Boolean), 'the three products with varieties are listed first');
    ok(await page.locator('#submit-btn').isDisabled(), 'submit starts disabled');

    // purpl stepper
    await page.click('#purpl-classic-card button[aria-label^="One more"]');
    await page.click('#purpl-classic-card button[aria-label^="One more"]');
    ok((await page.inputValue('#classic-cases')) === '2', 'purpl + button sets 2 cases');
    await page.click('#purpl-classic-card button[aria-label^="One less"]');
    await page.click('#purpl-classic-card button[aria-label^="One less"]');
    await page.click('#purpl-classic-card button[aria-label^="One less"]');
    ok((await page.inputValue('#classic-cases')) === '0', 'purpl − never goes below zero');
    await page.fill('#classic-cases', '4');

    // plain LF product
    await page.click('#lf-row-lf-roll-on button[aria-label^="One more"]');
    ok((await page.inputValue('#lf-qty-lf-roll-on')) === '1', 'plain product + adds a case');

    // gate F2: a pop-up opened just to look closes with X and orders nothing
    await page.click('#lf-vbtn-lf-candle');
    await page.click('#lf-vmodal-lf-candle .vclose');
    ok(!(await page.locator('#lf-vmodal-lf-candle').isVisible()) && (await page.inputValue('#lf-qty-lf-candle')) === '0', 'opening a pop-up and closing it with X orders nothing');

    // variety pop-up
    await page.click('#lf-vbtn-lf-scrunchie');
    ok(await page.locator('#lf-vmodal-lf-scrunchie').isVisible(), 'Choose varieties opens the pop-up');
    ok((await page.inputValue('#lf-qty-lf-scrunchie')) === '1', 'pop-up opens at 1 case');
    const plus = id => page.click('#lf-vrow-lf-scrunchie-' + id + ' button[aria-label^="One more"]');
    await plus('blossom-satin'); await plus('blossom-satin'); await plus('sage-velvet');
    await page.click('#lf-vdone-lf-scrunchie');
    ok(await page.locator('#lf-vmodal-lf-scrunchie').isVisible(), 'a half-chosen case (3 of 6) will NOT close');
    ok((await page.textContent('#lf-verr-lf-scrunchie')).includes('Choose 3 more'), 'it says how many are left');
    await page.keyboard.press('Escape');
    ok(await page.locator('#lf-vmodal-lf-scrunchie').isVisible(), 'Escape cannot dismiss a half-chosen case either');
    await plus('sage-velvet'); await plus('dusk-corduroy'); await plus('chai-satin');
    await plus('chai-satin'); // 7th click must be capped at 6
    ok((await page.textContent('#lf-vtally-lf-scrunchie')).trim() === '6 of 6 chosen', 'cannot over-fill a case (capped at 6 of 6)');
    if (vp.name === 'desktop') await page.screenshot({ path: path.join(OUT, 'popup-desktop.png') });
    else await page.screenshot({ path: path.join(OUT, 'popup-phone.png') });
    await page.click('#lf-vdone-lf-scrunchie');
    ok(!(await page.locator('#lf-vmodal-lf-scrunchie').isVisible()), 'a full case closes the pop-up');
    ok((await page.textContent('#lf-vsum-lf-scrunchie')).includes('1 case: 2 Blossom Satin, 2 Sage Velvet, 1 Dusk Corduroy, 1 Chai Satin'), 'card shows what was chosen');
    ok((await page.textContent('#lf-vbtn-lf-scrunchie')).trim() === 'Change varieties', 'button becomes Change varieties');

    // remove flow on another product
    await page.click('#lf-vbtn-lf-candle');
    await page.click('#lf-vmodal-lf-candle .pbtn.ghost');
    ok(!(await page.locator('#lf-vmodal-lf-candle').isVisible()) && (await page.inputValue('#lf-qty-lf-candle')) === '0', 'Remove clears the product and closes');

    // the data the page will submit — must be the pre-redesign shape
    const items = await page.evaluate(() => getLfItems());
    const scr = items.find(i => i.skuId === 'lf-scrunchie'), roll = items.find(i => i.skuId === 'lf-roll-on');
    ok(items.length === 2 && !!scr && !!roll, 'order holds exactly the two LF products chosen');
    ok(scr.hasVariants === true && scr.cases === 1 && scr.units === 6 && Math.abs(scr.lineTotal - 44.94) < 0.001
       && JSON.stringify(scr.variantLines.map(v => [v.variantId, v.units])) === JSON.stringify([['blossom-satin',2],['sage-velvet',2],['dusk-corduroy',1],['chai-satin',1]]),
       'variety line: 1 case, 6 units, $44.94, per-variety units intact');
    ok(roll.cases === 1 && roll.units === 24 && Math.abs(roll.lineTotal - 239.76) < 0.001 && !roll.hasVariants, 'plain line: 1 case of 24, $239.76');

    // summary
    const sumSel = vp.name === 'desktop' ? '#order-summary' : '#order-summary-inline';
    const sum = await page.textContent(sumSel);
    ok(sum.includes('Classic · 4 cases') && sum.includes('$110.40'), 'summary shows purpl line and amount');
    ok(sum.includes('$395.10'), 'summary total = 110.40 + 44.94 + 239.76');
    ok(sum.includes('Free delivery'), 'over $250 → free delivery');
    await page.evaluate(() => { document.getElementById('lf-qty-lf-roll-on').value = 0; updateLfCalc('lf-roll-on'); });
    ok((await page.textContent(sumSel)).includes('charge applies'), 'under 8 cases and under $250 → delivery charge note');
    await page.fill('#classic-cases', '8');
    ok((await page.textContent(sumSel)).includes('Free delivery'), '8 cases of purpl → free delivery');
    // gate F1: purpl ALONE under 8 cases is never free, even above $250
    await page.evaluate(() => { removeLfSku('lf-scrunchie'); pricePerCase = 60; document.getElementById('classic-cases').value = 5; updateCans(); });
    ok((await page.textContent(sumSel)).includes('$300.00') && (await page.textContent(sumSel)).includes('charge applies'), 'purpl-only, 5 cases worth $300 → still a delivery charge (matches the written terms)');
    await page.evaluate(() => { pricePerCase = 27.6; document.getElementById('classic-cases').value = 8; updateCans(); });

    // submit gating unchanged
    ok(await page.locator('#submit-btn').isDisabled(), 'submit still disabled until terms are agreed');
    await page.check('#agree-terms');
    ok(!(await page.locator('#submit-btn').isDisabled()), 'agreeing to terms enables submit');
    await page.evaluate(() => { document.getElementById('lf-qty-lf-sachet').value = 1; updateLfVariantCases('lf-sachet'); });
    ok(await page.locator('#submit-btn').isDisabled(), 'an unfinished case anywhere blocks submit (safety net)');
    ok((await page.textContent('#lf-vsum-lf-sachet')).includes('Not finished'), 'the unfinished card says so');
    await page.evaluate(() => removeLfSku('lf-sachet'));
    ok(!(await page.locator('#submit-btn').isDisabled()), 'removing it re-enables submit');

    if (vp.name === 'phone') {
      ok(await page.locator('#op-mobile-bar').isVisible(), 'phone shows the order bar');
      ok(!(await page.locator('.op-side').isVisible()), 'phone hides the side panel');
    } else {
      ok(await page.locator('.op-side').isVisible() && !(await page.locator('#op-mobile-bar').isVisible()), 'computer shows the side panel, no bar');
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(overflow <= 0, 'no sideways scrolling (' + overflow + 'px)');
    ok(errors.length === 0, 'no script errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(OUT, 'page-' + vp.name + '.png'), fullPage: true });
    await ctx.close();
  }
  await browser.close(); srv.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
