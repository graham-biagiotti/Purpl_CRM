// Wave 22 backtests — v249 LF site refresh: new product photos, syrup
// 16 oz packaging (copy + seed + ONE-SHOT live-SKU rename migration,
// owner-approved), order-form what's-new banner + per-row badges, new
// Aromatherapy Sleep Mask card.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const ws = fs.readFileSync(path.join(__dirname, '../../public/wholesale.html'), 'utf8');
const ord = fs.readFileSync(path.join(__dirname, '../../public/order.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] images + wholesale site');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const imgDir = path.join(__dirname, '../../public/images');
  ['lf-syrup.jpg', 'lf-sleepmask.jpg', 'lf-rollon.jpg', 'lf-refresh-powder.jpg', 'lf-scrunchies.jpg']
    .forEach(f => ok(fs.existsSync(path.join(imgDir, f)), `new photo in place: ${f}`));
  ['lf-syrup.PNG', 'lf-rollon.PNG', 'lf-refresh-powder.PNG', 'lf-scrunchies.PNG']
    .forEach(f => ok(!fs.existsSync(path.join(imgDir, f)), `replaced PNG removed: ${f}`));
  ok(!/lf-(syrup|rollon|refresh-powder|scrunchies)\.PNG/.test(ws), 'wholesale.html references no removed images');
  ok(ws.includes('/images/lf-sleepmask.jpg') && ws.includes('Aromatherapy Sleep Mask'),
    'new Sleep Mask card on the wholesale site');
  ok(ws.includes('16 oz · culinary') && !ws.includes('12.7'), 'syrup copy reads 16 oz, no stale 12.7');
  ok((ws.match(/<div/g) || []).length === (ws.match(/<\/div>/g) || []).length, 'wholesale.html divs balanced');
}

console.log('[B] order form — fallback, banner, badges');
{
  ok(ord.includes("name:'Lavender Simple Syrup 16oz'") && !ord.includes('12.7'),
    'fallback catalog renamed, no stale 12.7');
  ok(ord.includes("What's new:") && ord.includes('16&nbsp;oz glass bottle') && ord.includes('fresh new packaging'),
    'what\'s-new banner announces mask + 16oz + refresh packaging');
  ok(ord.includes('function lfNewBadge'), 'badge helper exists');
  ok(ord.includes("s.name+lfNewBadge(s.name)") && ord.includes('s.name + lfNewBadge(s.name)'),
    'BOTH row renderers (variant + simple) show the badge');
  // Badge matcher truth table — run the REAL helper.
  const badge = new Function(slc(ord, 'function lfNewBadge', '\n    }') + '\n}\nreturn lfNewBadge;')();
  ok(badge('Aromatherapy Sleep Mask').includes('NEW') && !badge('Aromatherapy Sleep Mask').includes('16 OZ'),
    'mask → NEW badge');
  ok(badge('Lavender Simple Syrup 16oz').includes('NEW 16 OZ BOTTLE'), 'syrup → 16oz badge');
  ok(badge('Lavender Refresh Powder').includes('NEW PACKAGING'), 'refresh → packaging badge');
  ok(badge('Soy Candle') === '' && badge('Seatbelt Sachet') === '' && badge('') === '',
    'everything else unbadged');
  // Gate F1: the gallon ALSO matches /syrup/ — it must never claim 16oz.
  ok(badge('Lavender Simple Syrup 1 gal') === '', 'gallon jug stays unbadged (gate F1)');
}

console.log('[C] live-SKU rename migration (one-shot, owner-approved)');
{
  ok(src.includes("{id:uid(),name:'Lavender Simple Syrup 16oz'"), 'seed renamed');
  ok(src.includes("'Lavender Simple Syrup 16oz': {wholesalePrice:8.99"), 'price catalog key renamed');
  ok(src.includes('migrateLfSyrupSize(); // v249') &&
     src.includes('migrateLfSyrupSize(); // retried here'),
    'migration wired at boot AND the refresh retry (10s boot-window gap covered)');
  // Run the REAL migration against a stub DB.
  const fnSrc = slc(src, 'function migrateLfSyrupSize()', '\n}') + '\n}';
  const mk = (skus, ready = true) => {
    const updates = [];
    const DB = {
      _firestoreReady: ready,
      a: k => k === 'lf_skus' ? skus : [],
      update: (k, id, fn) => { const i = skus.findIndex(x => x.id === id); skus[i] = fn(skus[i]); updates.push(id); return true; },
    };
    new Function('DB', 'console', fnSrc + '\nmigrateLfSyrupSize();')(DB, { log: () => {} });
    return { skus, updates };
  };
  const r1 = mk([{ id: 'a', name: 'Lavender Simple Syrup 12.7oz', wholesalePrice: 8.99, msrp: 17.99 }, { id: 'b', name: 'Soy Candle' }]);
  ok(r1.skus[0].name === 'Lavender Simple Syrup 16oz' && r1.updates.length === 1,
    'renames the live syrup SKU exactly once');
  ok(r1.skus[0].wholesalePrice === 8.99 && r1.skus[0].msrp === 17.99, 'price/MSRP untouched (owner: same)');
  ok(r1.skus[1].name === 'Soy Candle', 'other SKUs untouched');
  const r2 = mk(r1.skus); // run again on already-renamed data
  ok(r2.updates.length === 0, 'IDEMPOTENT: second run is a no-op');
  const r3 = mk([{ id: 'c', name: 'Lavender Simple Syrup 16oz (hand-edited)' }]);
  ok(r3.updates.length === 0, 'never touches a hand-edited name');
  const r4 = mk([{ id: 'a', name: 'Lavender Simple Syrup 12.7oz' }], false);
  ok(r4.updates.length === 0, 'waits for Firestore readiness (no blind write)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
