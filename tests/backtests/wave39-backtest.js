// Wave 39 backtests — v269 order portal redesign (customer-facing):
// photo cards, varieties in a pop-up, an order summary, the catalog link.
// The contract that matters most: the ORDER THAT IS SUBMITTED is built by
// the same functions from the same input ids as before — only the layout
// changed. (Behaviour is exercised in a real browser by
// tests/portal/portal-browser-test.js; this suite pins the contracts.)
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '../..');
const ord = fs.readFileSync(path.join(root, 'public/order.html'), 'utf8');
const src = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'sync-wholesale.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] the submitted order is built exactly as before');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const gi = slc(ord, 'function getLfItems()', '\nfunction getLfTotal');
  ok(gi.includes("document.getElementById('lf-vqty-'+s.id+'-'+v.id)") && gi.includes("document.getElementById('lf-qty-'+s.id)")
     && gi.includes('return {skuId:s.id, skuName:s.name, hasVariants:true, variantLines:variantLines,'),
    'getLfItems reads the same inputs and returns the same shape');
  const rl = slc(ord, 'function renderLfSkus(skus, prevOrder)', '\n// ── v269 steppers');
  ok(rl.includes('id="lf-qty-\'+s.id+\'"') && rl.includes("id=\"lf-qty-' + s.id + '\"") && rl.includes('id="lf-vqty-\'+s.id+\'-\'+v.id+\'"'),
    'the new cards + pop-ups still create those exact input ids');
  ok(ord.includes('id="classic-cases"') && ord.includes('id="notify-blueberry"') && ord.includes('id="notify-peach"')
     && ord.includes('id="request-sample"') && ord.includes('id="agree-terms"') && ord.includes('id="submit-btn"'),
    'purpl quantity, notify boxes, sample request, terms and submit keep their ids');
  const cs = slc(ord, 'function checkSubmitEnabled()', '\n// Distributor fields');
  ok(cs.includes('return assignedUnits !== requiredUnits;') && cs.includes('(!hasPurpl && !hasLf) || variantsMismatched'),
    'submit is still blocked by an unfinished case (full cases only)');
  ok((ord.match(/function submitOrder\(/g) || []).length === 1 && ord.includes("httpsCallable('getLfCatalog')"),
    'submit + live catalog load untouched');
}

console.log('[B] full cases only in the pop-up');
{
  const cl = slc(ord, 'function closeLfPicker(skuId)', '\nfunction removeLfSku');
  ok(cl.includes('if (st && st.cases > 0 && !st.matched)') && cl.indexOf('return;') < cl.indexOf('_hideLfPicker(skuId);'),
    'the pop-up refuses to close on a half-chosen case');
  ok(cl.includes("'Choose ' + left + ' more"), 'and says how many are left');
  const rm = slc(ord, 'function removeLfSku(skuId)', "\ndocument.addEventListener('keydown'");
  ok(rm.includes('q.value = 0') && rm.includes('updateLfVariantCases(skuId)'), 'Remove zeroes the cases and every variety');
  ok(ord.includes("if (e.key === 'Escape' && _lfPickerOpen) closeLfPicker(_lfPickerOpen);"), 'Escape goes through the same check');
  const su = slc(ord, 'function stepLfUnit(', '\nfunction updateLfVariantCalc');
  ok(su.includes('Math.min(current + delta, Math.max(0, requiredUnits - assignedOthers))'), 'the + button still cannot over-fill a case');
}

console.log('[C] photos, summary, catalog');
{
  const im = slc(ord, 'function lfSkuImage(s)', '\nvar LF_IMG_FALLBACK');
  ok(im.includes("/^\\/images\\/[A-Za-z0-9._-]+\\.(jpg|jpeg|png|webp)$/i.test(img)"), 'a per-product photo setting can only point at this site\'s /images/ folder');
  const F = new Function(im + '\nreturn lfSkuImage;')();
  ok(F({ name: 'Lavender Simple Syrup 1 gal' }).includes('gallon') && F({ name: 'Lavender Simple Syrup 16oz' }) === '/images/portal-lf-syrup.jpg',
    'gallon syrup gets the jug photo, 16oz the bottle');
  ok(F({ name: 'Dryer Sachet 2-Pack' }).includes('dryer') && F({ name: 'Seatbelt Sachet' }).includes('lf-sachets'), 'dryer sachet and seatbelt sachet are told apart');
  ok(F({ name: 'Aromatherapy Eye Pillow' }).includes('sleepmask') && F({ name: 'Something New' }) === '/images/lf-logo-circle-transparent.png',
    'eye pillow matched; an unknown product falls back to the logo');
  ok(F({ name: 'X', image: 'https://evil.example/x.jpg' }) === '/images/lf-logo-circle-transparent.png' && F({ name: 'X', image: '/images/new-thing.jpg' }) === '/images/new-thing.jpg',
    'off-site photo URLs are ignored; same-site ones are used');
  // v271: replaced photos must not be served from a browser's old copy.
  ok(ord.includes("var LF_IMG_VERSION = '?v=") && ord.includes('var img = lfSkuImageUrl(s);')
     && (ord.match(/src="\/images\/portal-can-[a-z]+\.jpg\?v=\d+"/g) || []).length === 3,
    'every product photo URL carries a version tag');
  const used = [...new Set((ord.match(/\/images\/portal-[a-z0-9-]+\.jpg/g) || []))];
  ok(used.length >= 12 && used.every(u => fs.existsSync(path.join(root, 'public', u))), `every product photo the page names exists (${used.length})`);
  ok(fs.statSync(path.join(root, 'public/images/wholesale-catalog.pdf')).size < 3e6 && ord.includes('href="/images/wholesale-catalog.pdf"'),
    'catalog button opens the new (smaller) 2026–27 PDF');
  ok(ord.indexOf('class="catalog-link"') > ord.indexOf('<div id="order-form"'), 'the catalog link sits inside the order form (behind the password / personal link)');
  // The predeploy sync copies image FILES only — a subfolder would crash every deploy.
  ok(sync.includes('copyFile(path.join(srcImg, img), path.join(dstImg, img));')
     && fs.readdirSync(path.join(root, 'public/images')).every(f => !fs.statSync(path.join(root, 'public/images', f)).isDirectory()),
    'no folders inside public/images (the deploy sync cannot copy them)');
  const sd = slc(ord, 'function orderSummaryData()', '\nfunction renderOrderSummary');
  // (gate F1: must match the written terms — $250 only counts once LF is on the order)
  ok(sd.includes('var free = cases >= FREE_DELIVERY_CASES || (lfTotal > 0 && known >= FREE_DELIVERY_DOLLARS);') && ord.includes('var FREE_DELIVERY_CASES = 8, FREE_DELIVERY_DOLLARS = 250;'),
    'free delivery: 8 cases of purpl, or $250 once Lavender Fields is on the order');
  ok(sd.includes('lfItems.reduce(function(sum, it){ return sum + (it.lineTotal || 0); }, 0)'), 'summary total adds up from the lines shown (gate F3)');
  ok(ord.includes("if (st && st.assigned === 0) return removeLfSku(skuId);"), 'a pop-up opened just to look can be closed (gate F2)');
  ok(ord.includes('if (!_lfSkusLoaded) loadLfSkus(null);'), 'the catalog is not re-rendered over typed quantities after the password (gate F5)');
  const rs = slc(ord, 'function renderOrderSummary()', '\nfunction goToCheckout');
  ok(rs.includes('a delivery or shipping charge applies. We will confirm the amount'), 'under the threshold: a charge applies, amount to be confirmed (no figure shown)');
  ok(rs.includes('try { d = orderSummaryData(); } catch (e) { return; }'), 'a summary error can never block ordering');
  ok(rs.includes('escHtml(it.skuName)') && rs.includes('escHtml(vl.variantName)'), 'summary escapes product and variety names');
  const rl = slc(ord, 'function renderLfSkus(skus, prevOrder)', '\n// ── v269 steppers');
  ok(rl.includes("var name = escHtml(s.name || '');") && rl.includes("var vn = escHtml(v.name || '');"), 'cards and pop-ups escape product and variety names');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
