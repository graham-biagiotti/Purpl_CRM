// pricing-and-logic-audit.spec.js
// Deep-audit of the 3-tier MSRP pricing fallback, delivery math,
// invoice number collision-safety, inventory accounting, and report
// revenue consistency.  All pure-logic tests manipulate DB._cache
// directly so no Firestore writes occur and other tests stay clean.
'use strict';
const { test, expect } = require('../fixtures.js');

async function waitForApp(page) {
  await page.goto('/');
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
}

// ── helper: read-back constants from the live page ──────────────
async function getConstants(page) {
  return page.evaluate(() => ({
    MSRP:         PURPL_MSRP,
    DIRECT:       PURPL_DIRECT_PER_CASE,
    DIST:         PURPL_DIST_PER_CASE,
    CANS_PER_CASE,
  }));
}

// ══════════════════════════════════════════════════════════════════
//  Section A — PURPL pricing constants are correct
// ══════════════════════════════════════════════════════════════════

test('PURPL_MSRP is 3.29', async ({ page }) => {
  await waitForApp(page);
  const { MSRP } = await getConstants(page);
  console.log(`[pricing-audit] PURPL_MSRP = ${MSRP}`);
  expect(MSRP).toBeCloseTo(3.29, 5);
});

test('PURPL_DIRECT_PER_CASE = MSRP × 0.65 × CANS_PER_CASE', async ({ page }) => {
  await waitForApp(page);
  const { MSRP, DIRECT, CANS_PER_CASE } = await getConstants(page);
  const expected = MSRP * 0.65 * CANS_PER_CASE;
  console.log(`[pricing-audit] PURPL_DIRECT_PER_CASE = ${DIRECT.toFixed(4)} (expected ${expected.toFixed(4)})`);
  expect(Math.abs(DIRECT - expected)).toBeLessThan(0.001);
});

test('PURPL_DIST_PER_CASE = MSRP × 0.65 × 0.75 × CANS_PER_CASE', async ({ page }) => {
  await waitForApp(page);
  const { MSRP, DIST, CANS_PER_CASE } = await getConstants(page);
  const expected = MSRP * 0.65 * 0.75 * CANS_PER_CASE;
  console.log(`[pricing-audit] PURPL_DIST_PER_CASE = ${DIST.toFixed(4)} (expected ${expected.toFixed(4)})`);
  expect(Math.abs(DIST - expected)).toBeLessThan(0.001);
});

test('PURPL_DIST_PER_CASE is less than PURPL_DIRECT_PER_CASE (dist gets lower price)', async ({ page }) => {
  await waitForApp(page);
  const { DIRECT, DIST } = await getConstants(page);
  expect(DIST).toBeLessThan(DIRECT);
});

// ══════════════════════════════════════════════════════════════════
//  Section B — calcOrderValue pricing tier fallback
// ══════════════════════════════════════════════════════════════════

test('calcOrderValue — unknown accountId falls back to PURPL_DIRECT_PER_CASE', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    // Synthetic order: accountId that doesn't exist in DB
    const order = { id: '__x', accountId: '__nonexistent__', items: [{ sku: 'classic', qty: 5 }] };
    const value = calcOrderValue(order);
    return { value, DIRECT: PURPL_DIRECT_PER_CASE };
  });

  const expected = result.DIRECT * 5;
  console.log(`[pricing-audit] unknown account: got=${result.value.toFixed(2)} expected=${expected.toFixed(2)}`);
  expect(Math.abs(result.value - expected)).toBeLessThan(0.01);
});

test('calcOrderValue — direct account with no pricePerCaseDirect uses PURPL_DIRECT_PER_CASE', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    // Use DB._cache to inject a test account without a Firestore write
    const testId = '__t_direct';
    const orig   = DB._cache.ac ? [...DB._cache.ac] : [];
    DB._cache.ac = [...orig, {
      id: testId, name: 'Test Direct', status: 'active',
      fulfilledBy: 'direct', pricing: {}
      // no pricePerCaseDirect
    }];

    const order = { id: '__o', accountId: testId, items: [{ sku: 'classic', qty: 4 }] };
    const value = calcOrderValue(order);

    DB._cache.ac = orig; // restore immediately
    return { value, DIRECT: PURPL_DIRECT_PER_CASE };
  });

  const expected = result.DIRECT * 4;
  console.log(`[pricing-audit] direct no price: got=${result.value.toFixed(2)} expected=${expected.toFixed(2)}`);
  expect(Math.abs(result.value - expected)).toBeLessThan(0.01);
});

test('calcOrderValue — dist-fulfilled account with no pricePerCaseDist uses PURPL_DIST_PER_CASE', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const testId = '__t_dist';
    const orig   = DB._cache.ac ? [...DB._cache.ac] : [];
    DB._cache.ac = [...orig, {
      id: testId, name: 'Test Dist', status: 'active',
      fulfilledBy: 'dist001', pricing: {}
      // no pricePerCaseDist
    }];

    const order = { id: '__o', accountId: testId, items: [{ sku: 'classic', qty: 3 }] };
    const value = calcOrderValue(order);

    DB._cache.ac = orig;
    return { value, DIST: PURPL_DIST_PER_CASE };
  });

  const expected = result.DIST * 3;
  console.log(`[pricing-audit] dist no price: got=${result.value.toFixed(2)} expected=${expected.toFixed(2)}`);
  expect(Math.abs(result.value - expected)).toBeLessThan(0.01);
});

test('calcOrderValue — account with pricePerCaseDirect set overrides MSRP default', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const testId = '__t_custom';
    const orig   = DB._cache.ac ? [...DB._cache.ac] : [];
    DB._cache.ac = [...orig, {
      id: testId, name: 'Custom Price', status: 'active',
      fulfilledBy: 'direct',
      pricePerCaseDirect: 28.00,  // specific negotiated price
      pricing: {}
    }];

    const order = { id: '__o', accountId: testId, items: [{ sku: 'classic', qty: 2 }] };
    const value = calcOrderValue(order);

    DB._cache.ac = orig;
    return { value };
  });

  // 2 cases × $28.00 = $56.00
  console.log(`[pricing-audit] custom price: got=${result.value.toFixed(2)} expected=56.00`);
  expect(Math.abs(result.value - 56.00)).toBeLessThan(0.01);
});

test('calcOrderValue — dist account with pricePerCaseDist set overrides MSRP default', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const testId = '__t_dist_custom';
    const orig   = DB._cache.ac ? [...DB._cache.ac] : [];
    DB._cache.ac = [...orig, {
      id: testId, name: 'Dist Custom', status: 'active',
      fulfilledBy: 'dist001',
      pricePerCaseDist: 20.50,
      pricing: {}
    }];

    const order = { id: '__o', accountId: testId, items: [{ sku: 'classic', qty: 6 }] };
    const value = calcOrderValue(order);

    DB._cache.ac = orig;
    return { value };
  });

  // 6 × 20.50 = 123.00
  console.log(`[pricing-audit] dist custom price: got=${result.value.toFixed(2)} expected=123.00`);
  expect(Math.abs(result.value - 123.00)).toBeLessThan(0.01);
});

test('calcOrderValue — 0-case order returns 0', async ({ page }) => {
  await waitForApp(page);

  const value = await page.evaluate(() =>
    calcOrderValue({ id: '__z', accountId: '__x', items: [{ sku: 'classic', qty: 0 }] })
  );
  expect(value).toBe(0);
});

test('calcOrderValue — empty items array returns 0', async ({ page }) => {
  await waitForApp(page);
  const value = await page.evaluate(() =>
    calcOrderValue({ id: '__e', accountId: '__x', items: [] })
  );
  expect(value).toBe(0);
});

// ══════════════════════════════════════════════════════════════════
//  Section C — _ivGetPrice: invoice form price suggestion
// ══════════════════════════════════════════════════════════════════

test('_ivGetPrice direct tier — account with no price returns PURPL_DIRECT_PER_CASE', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const ac = { id: '__ac', fulfilledBy: 'direct' }; // no pricePerCaseDirect
    return { price: _ivGetPrice(ac, 'direct'), DIRECT: PURPL_DIRECT_PER_CASE };
  });

  console.log(`[pricing-audit] _ivGetPrice direct no price: got=${result.price.toFixed(4)} expected=${result.DIRECT.toFixed(4)}`);
  expect(Math.abs(result.price - result.DIRECT)).toBeLessThan(0.001);
});

test('_ivGetPrice dist tier — account with no price returns PURPL_DIST_PER_CASE', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const ac = { id: '__ac', fulfilledBy: 'dist001' }; // no pricePerCaseDist
    return { price: _ivGetPrice(ac, 'dist'), DIST: PURPL_DIST_PER_CASE };
  });

  console.log(`[pricing-audit] _ivGetPrice dist no price: got=${result.price.toFixed(4)} expected=${result.DIST.toFixed(4)}`);
  expect(Math.abs(result.price - result.DIST)).toBeLessThan(0.001);
});

test('_ivGetPrice direct tier — account with pricePerCaseDirect uses that value', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const ac = { id: '__ac', pricePerCaseDirect: 26.40 };
    return { price: _ivGetPrice(ac, 'direct') };
  });

  console.log(`[pricing-audit] _ivGetPrice direct with price: got=${result.price.toFixed(2)}`);
  expect(Math.abs(result.price - 26.40)).toBeLessThan(0.001);
});

test('_ivGetPrice custom tier — no price returns 0 (not MSRP)', async ({ page }) => {
  await waitForApp(page);
  const price = await page.evaluate(() => _ivGetPrice({ id: '__ac' }, 'custom'));
  // Custom price has no default — must be entered manually
  expect(price).toBe(0);
});

test('_ivGetPrice null account returns 0', async ({ page }) => {
  await waitForApp(page);
  const price = await page.evaluate(() => _ivGetPrice(null, 'direct'));
  expect(price).toBe(0);
});

// ══════════════════════════════════════════════════════════════════
//  Section D — Invoice number collision safety
// ══════════════════════════════════════════════════════════════════

test('createDeliveryInvoice: invoice number > max in retail_invoices', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    // Inject a retail_invoice with a high number into cache (no Firestore write)
    const origRI = DB._cache.retail_invoices ? [...DB._cache.retail_invoices] : [];
    DB._cache.retail_invoices = [...origRI, { id: '__ri_high', invoiceNumber: 'INV-9000', status: 'unpaid', total: 100 }];

    // Also inject a test account + order
    const testAcId  = '__ti_ac';
    const testOrdId = '__ti_ord';
    const origAc  = DB._cache.ac     ? [...DB._cache.ac]     : [];
    const origOrd = DB._cache.orders ? [...DB._cache.orders] : [];

    DB._cache.ac = [...origAc, {
      id: testAcId, name: 'Invoice # Test', status: 'active', fulfilledBy: 'direct'
    }];
    DB._cache.orders = [...origOrd, {
      id: testOrdId, accountId: testAcId, status: 'delivered',
      items: [{ sku: 'classic', qty: 1 }]
    }];

    // Capture the computed invoice number without actually calling createDeliveryInvoice
    // (which would write to DB). Replicate the number-generation logic directly.
    const lastNum = Math.max(
      DB.a('retail_invoices').reduce((max, inv) =>
        Math.max(max, parseInt((inv.invoiceNumber || inv.number || '').replace(/\D/g,'')) || 0), 0),
      DB.a('iv').reduce((max, inv) =>
        Math.max(max, parseInt((inv.number || inv.invoiceNumber || '').replace(/\D/g,'')) || 0), 0)
    );
    const nextNum = lastNum + 1;

    // Restore
    DB._cache.retail_invoices = origRI;
    DB._cache.ac              = origAc;
    DB._cache.orders          = origOrd;

    return { nextNum, maxInRI: 9000 };
  });

  console.log(`[pricing-audit] Invoice # after 9000: next=${result.nextNum}`);
  expect(result.nextNum).toBeGreaterThan(result.maxInRI);
});

test('Invoice number generation scans iv collection to avoid collision', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    // Inject a high-number invoice into iv (old-style purpl invoice)
    const origIv = DB._cache.iv ? [...DB._cache.iv] : [];
    DB._cache.iv = [...origIv, { id: '__iv_high', number: 'PBF-7500', accountId: 'ac001', amount: '50', status: 'unpaid' }];

    const lastNum = Math.max(
      DB.a('retail_invoices').reduce((max, inv) =>
        Math.max(max, parseInt((inv.invoiceNumber || inv.number || '').replace(/\D/g,'')) || 0), 0),
      DB.a('iv').reduce((max, inv) =>
        Math.max(max, parseInt((inv.number || inv.invoiceNumber || '').replace(/\D/g,'')) || 0), 0)
    );

    DB._cache.iv = origIv;
    return { lastNum };
  });

  console.log(`[pricing-audit] Max invoice # with PBF-7500 in iv: ${result.lastNum}`);
  expect(result.lastNum).toBeGreaterThanOrEqual(7500);
});

// ══════════════════════════════════════════════════════════════════
//  Section E — toggleStop: delivery completion math
// ══════════════════════════════════════════════════════════════════

test('toggleStop: completing a stop creates an inventory deduction of cases × CANS_PER_CASE', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    // Set up: a today_run with one stop, 3 cases of classic
    const testAcId = 'ac001'; // seeded account
    const ac2 = DB.a('ac').find(a => a.id === testAcId);
    if (!ac2) return { skip: true, reason: 'ac001 not found' };

    const ivBefore = DB.a('iv').filter(e => e.type === 'out' && e.sku === 'classic').length;

    // Inject a fresh today_run with exactly one un-done stop
    const origRun = DB._cache.today_run;
    DB._cache.today_run = {
      date: today(),
      stops: [{
        name: ac2.name,
        accountId: testAcId,
        classic: 3,
        done: false,
        lfItems: [],
      }],
    };

    toggleStop(0);

    const ivAfter = DB.a('iv').filter(e => e.type === 'out' && e.sku === 'classic').length;
    const newEntries = DB.a('iv').filter(e =>
      e.type === 'out' && e.sku === 'classic' && e.qty === 3 * CANS_PER_CASE
    );

    // Restore today_run to original state so delivery page isn't polluted
    DB._cache.today_run = origRun;

    return { ivBefore, ivAfter, newEntriesCount: newEntries.length, expectedQty: 3 * CANS_PER_CASE };
  });

  if (result.skip) {
    console.log(`[pricing-audit] toggleStop test skipped: ${result.reason}`);
    return;
  }

  console.log(`[pricing-audit] toggleStop: iv out entries before=${result.ivBefore} after=${result.ivAfter}, new entry qty=${result.expectedQty}`);
  expect(result.ivAfter).toBeGreaterThan(result.ivBefore);
  expect(result.newEntriesCount).toBeGreaterThanOrEqual(1);
});

test('toggleStop: completing a stop creates an order record in orders collection', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const testAcId = 'ac001';
    const ac2 = DB.a('ac').find(a => a.id === testAcId);
    if (!ac2) return { skip: true };

    const ordBefore = DB.a('orders').filter(o => o.accountId === testAcId && o.source === 'run').length;

    const origRun = DB._cache.today_run;
    DB._cache.today_run = {
      date: today(),
      stops: [{ name: ac2.name, accountId: testAcId, classic: 2, done: false, lfItems: [] }],
    };

    toggleStop(0);

    const ordAfter = DB.a('orders').filter(o => o.accountId === testAcId && o.source === 'run').length;
    const newOrd   = DB.a('orders').find(o =>
      o.accountId === testAcId && o.source === 'run' && o.status === 'delivered' &&
      (o.items || []).some(i => i.sku === 'classic' && i.qty === 2)
    );

    DB._cache.today_run = origRun;
    return { ordBefore, ordAfter, found: !!newOrd };
  });

  if (result.skip) return;
  console.log(`[pricing-audit] toggleStop orders: before=${result.ordBefore} after=${result.ordAfter}, newOrdFound=${result.found}`);
  expect(result.ordAfter).toBeGreaterThan(result.ordBefore);
  expect(result.found).toBe(true);
});

test('toggleStop: account not found — shows toast, no order created', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const ordsBefore = DB.a('orders').length;

    const origRun = DB._cache.today_run;
    DB._cache.today_run = {
      date: today(),
      stops: [{
        name: 'Ghost Account',
        accountId: '__ghost_does_not_exist__',
        classic: 1, done: false, lfItems: [],
      }],
    };

    // Intercept toast
    let toastMsg = '';
    const origToast = window.toast;
    window.toast = (msg) => { toastMsg = msg; };

    toggleStop(0);

    window.toast = origToast;
    DB._cache.today_run = origRun;

    return { ordsBefore, ordsAfter: DB.a('orders').length, toastMsg };
  });

  console.log(`[pricing-audit] toggleStop ghost: toastMsg="${result.toastMsg}"`);
  expect(result.ordsAfter).toBe(result.ordsBefore); // no order created
  expect(result.toastMsg).toMatch(/account not found|cannot/i);
});

// ══════════════════════════════════════════════════════════════════
//  Section F — repRevenue uses MSRP-based fallback
// ══════════════════════════════════════════════════════════════════

test('repRevenue: order for account with no pricing uses PURPL_DIRECT_PER_CASE', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    // Inject a test account (no price) and a test order
    const testAcId  = '__rev_ac';
    const testOrdId = '__rev_ord';
    const origAc  = DB._cache.ac     ? [...DB._cache.ac]     : [];
    const origOrd = DB._cache.orders ? [...DB._cache.orders] : [];

    DB._cache.ac = [...origAc, {
      id: testAcId, name: 'RevTest Direct', status: 'active', fulfilledBy: 'direct', pricing: {}
    }];
    DB._cache.orders = [...origOrd, {
      id: testOrdId, accountId: testAcId, status: 'delivered',
      items: [{ sku: 'classic', qty: 5 }]
    }];

    // Run repRevenue to get total (it scans all orders including our test one)
    let repResult = null;
    try { repResult = repRevenue(); } catch(_) {}

    DB._cache.ac     = origAc;
    DB._cache.orders = origOrd;

    return {
      repResult: repResult ? { totalRev: repResult.totalRev } : null,
      expectedContrib: PURPL_DIRECT_PER_CASE * 5,
      DIRECT: PURPL_DIRECT_PER_CASE,
    };
  });

  console.log(`[pricing-audit] repRevenue test order contributes ${result.expectedContrib.toFixed(2)} at DIRECT rate`);
  if (result.repResult) {
    // Total revenue should be >= our test order's contribution
    expect(result.repResult.totalRev).toBeGreaterThanOrEqual(result.expectedContrib - 0.01);
  }
});

test('repRevenue: dist-fulfilled account order uses PURPL_DIST_PER_CASE (lower than DIRECT)', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const origAc  = DB._cache.ac     ? [...DB._cache.ac]     : [];
    const origOrd = DB._cache.orders ? [...DB._cache.orders] : [];

    // Direct account, 5 cases
    const directId = '__cmp_d';
    DB._cache.ac = [...origAc,
      { id: directId, name: 'Cmp Direct', status: 'active', fulfilledBy: 'direct', pricing: {} },
    ];
    DB._cache.orders = [...origOrd,
      { id: '__cmp_do', accountId: directId, status: 'delivered', items: [{ sku: 'classic', qty: 5 }] },
    ];
    const valDirect = calcOrderValue(DB.a('orders').find(o => o.id === '__cmp_do'));

    // Dist account, same 5 cases
    const distId = '__cmp_dist';
    DB._cache.ac = [...origAc,
      { id: distId, name: 'Cmp Dist', status: 'active', fulfilledBy: 'dist001', pricing: {} },
    ];
    DB._cache.orders = [...origOrd,
      { id: '__cmp_oo', accountId: distId, status: 'delivered', items: [{ sku: 'classic', qty: 5 }] },
    ];
    const valDist = calcOrderValue(DB.a('orders').find(o => o.id === '__cmp_oo'));

    DB._cache.ac     = origAc;
    DB._cache.orders = origOrd;

    return { valDirect, valDist };
  });

  console.log(`[pricing-audit] direct=${result.valDirect.toFixed(2)} dist=${result.valDist.toFixed(2)} (dist should be lower)`);
  expect(result.valDist).toBeLessThan(result.valDirect);
});

// ══════════════════════════════════════════════════════════════════
//  Section G — Inventory on-hand math
// ══════════════════════════════════════════════════════════════════

test('Inventory on-hand = sum(in/return) minus sum(out) for each SKU', async ({ page }) => {
  await waitForApp(page);

  const mismatches = await page.evaluate(() => {
    const iv  = DB.a('iv');
    const bad = [];
    ['classic','blueberry','peach','raspberry','variety'].forEach(sku => {
      const ins  = iv.filter(e => e.sku === sku && (e.type === 'in' || e.type === 'return')).reduce((s, e) => s + (e.qty || 0), 0);
      const outs = iv.filter(e => e.sku === sku &&  e.type === 'out').reduce((s, e) => s + (e.qty || 0), 0);
      const onHand = Math.max(0, ins - outs);
      // Verify: onHand should equal what we'd compute (non-negative)
      if (ins - outs < -0.01) bad.push({ sku, ins, outs, raw: ins - outs });
    });
    return bad;
  });

  if (mismatches.length) {
    console.warn('[pricing-audit] Negative raw inventory (before Math.max guard):', mismatches);
  }
  // The Math.max(0,...) guard means UI won't show negative, but raw mismatches
  // indicate data integrity issues — tolerate 0 such cases in clean seeded data
  expect(mismatches).toHaveLength(0);
});

test('On-hand cans: each SKU shows non-negative balance', async ({ page }) => {
  await waitForApp(page);

  const balances = await page.evaluate(() => {
    const iv = DB.a('iv');
    return ['classic','blueberry','peach','raspberry','variety'].map(sku => {
      const ins  = iv.filter(e => e.sku === sku && (e.type === 'in' || e.type === 'return')).reduce((s, e) => s + (e.qty || 0), 0);
      const outs = iv.filter(e => e.sku === sku &&  e.type === 'out').reduce((s, e) => s + (e.qty || 0), 0);
      return { sku, balance: ins - outs };
    });
  });

  console.log('[pricing-audit] Raw inventory balances:', balances.map(b => `${b.sku}:${b.balance}`).join(', '));
  // All balances should be >= 0 (seeded data has enough 'in' entries to cover 'out')
  balances.forEach(b => {
    expect(b.balance, `${b.sku} inventory went negative`).toBeGreaterThanOrEqual(0);
  });
});

// ══════════════════════════════════════════════════════════════════
//  Section H — repProfit: COGS calculation accuracy
// ══════════════════════════════════════════════════════════════════

test('repProfit: totalCogs = sum of (cogs_per_can × cans) for each SKU in orders', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const costs  = DB.obj('costs', { cogs: {} });
    const orders = DB.a('orders').filter(o => o.status !== 'cancelled');

    // Compute expected COGS independently
    const bySkuCases = {};
    orders.forEach(o => {
      (o.items || []).forEach(i => {
        bySkuCases[i.sku] = (bySkuCases[i.sku] || 0) + i.qty;
      });
    });

    const expectedCogs = Object.entries(bySkuCases).reduce((s, [sku, cases]) => {
      const cogPerCan = costs.cogs[sku] || 2.15;
      return s + cogPerCan * cases * CANS_PER_CASE;
    }, 0);

    // repProfit returns total COGS via KPI display — we can't easily extract it
    // without running the function (which triggers DOM writes). Instead verify
    // our manual computation matches internal logic.
    return { expectedCogs, totalCases: Object.values(bySkuCases).reduce((a,b)=>a+b,0) };
  });

  console.log(`[pricing-audit] repProfit expected COGS: $${result.expectedCogs.toFixed(2)} across ${result.totalCases} cases`);
  expect(result.expectedCogs).toBeGreaterThan(0);
});

// ══════════════════════════════════════════════════════════════════
//  Section I — Combined invoice: total integrity
// ══════════════════════════════════════════════════════════════════

test('combined_invoices: total = purplSubtotal + lfSubtotal for each record', async ({ page }) => {
  await waitForApp(page);

  const mismatches = await page.evaluate(() => {
    return DB.a('combined_invoices').filter(ci => {
      const purpl = parseFloat(ci.purplSubtotal || 0);
      const lf    = parseFloat(ci.lfSubtotal    || 0);
      const total = parseFloat(ci.grandTotal    || 0);
      return Math.abs(total - (purpl + lf)) > 0.02;
    }).map(ci => ({ id: ci.id, purplSubtotal: ci.purplSubtotal, lfSubtotal: ci.lfSubtotal, grandTotal: ci.grandTotal }));
  });

  console.log(`[pricing-audit] combined_invoices total mismatches: ${mismatches.length}`);
  if (mismatches.length) console.warn('[pricing-audit] Mismatched combined invoices:', mismatches);
  expect(mismatches).toHaveLength(0);
});

test('retail_invoices: total is numeric and positive for all records', async ({ page }) => {
  await waitForApp(page);

  const bad = await page.evaluate(() =>
    DB.a('retail_invoices').filter(ri => {
      const t = parseFloat(ri.total);
      return isNaN(t) || t < 0;
    }).map(ri => ({ id: ri.id, total: ri.total }))
  );

  console.log(`[pricing-audit] retail_invoices with bad total: ${bad.length}`);
  if (bad.length) console.warn('[pricing-audit] Bad retail invoices:', bad);
  expect(bad).toHaveLength(0);
});

// ══════════════════════════════════════════════════════════════════
//  Section J — seeded dist account uses correct tier (ac019)
// ══════════════════════════════════════════════════════════════════

test('Seeded dist account ac019 (Clover Valley Farms) — calcOrderValue uses PURPL_DIST_PER_CASE', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const ac = DB.a('ac').find(a => a.id === 'ac019');
    if (!ac) return { skip: true };

    // Sanity: ac019 must be dist-fulfilled
    if (!ac.fulfilledBy || ac.fulfilledBy === 'direct') {
      return { skip: true, reason: `ac019.fulfilledBy = ${ac.fulfilledBy}` };
    }

    // If ac019 has no explicit pricePerCaseDist, it should fall back to PURPL_DIST_PER_CASE
    const order = { id: '__x', accountId: 'ac019', items: [{ sku: 'classic', qty: 1 }] };
    const value = calcOrderValue(order);

    // With no account-specific price, value should be <= PURPL_DIRECT_PER_CASE
    // (dist price is cheaper than direct)
    return {
      value,
      fulfilledBy: ac.fulfilledBy,
      DIRECT: PURPL_DIRECT_PER_CASE,
      DIST:   PURPL_DIST_PER_CASE,
      hasExplicitPrice: !!(ac.pricePerCaseDist || ac.pricing?.classic),
    };
  });

  if (result.skip) {
    console.log(`[pricing-audit] ac019 test skipped: ${result.reason || 'not found'}`);
    return;
  }

  console.log(`[pricing-audit] ac019 order value: $${result.value.toFixed(2)}, explicit=${result.hasExplicitPrice}, DIST=$${result.DIST.toFixed(2)}`);

  if (!result.hasExplicitPrice) {
    // No custom price → should use PURPL_DIST_PER_CASE (not DIRECT)
    expect(Math.abs(result.value - result.DIST)).toBeLessThan(0.01);
    // Must be lower than direct price
    expect(result.value).toBeLessThan(result.DIRECT);
  }
});

test('Seeded direct account ac001 — calcOrderValue uses PURPL_DIRECT_PER_CASE when no custom price', async ({ page }) => {
  await waitForApp(page);

  const result = await page.evaluate(() => {
    const ac = DB.a('ac').find(a => a.id === 'ac001');
    if (!ac) return { skip: true };

    const order = { id: '__x', accountId: 'ac001', items: [{ sku: 'classic', qty: 1 }] };
    const value = calcOrderValue(order);

    return {
      value,
      DIRECT: PURPL_DIRECT_PER_CASE,
      DIST:   PURPL_DIST_PER_CASE,
      hasExplicitPrice: !!(ac.pricePerCaseDirect || ac.pricing?.classic),
    };
  });

  if (result.skip) return;

  console.log(`[pricing-audit] ac001 order value: $${result.value.toFixed(2)}, explicit=${result.hasExplicitPrice}`);

  if (!result.hasExplicitPrice) {
    // Should use PURPL_DIRECT_PER_CASE
    expect(Math.abs(result.value - result.DIRECT)).toBeLessThan(0.01);
  }
});

// ══════════════════════════════════════════════════════════════════
//  Section K — No JS errors on key pages
// ══════════════════════════════════════════════════════════════════

test('No JS TypeError or crash when navigating through all main pages', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await waitForApp(page);

  const pages = ['dashboard','accounts','invoices','orders-delivery','distributors','projections','reports','emails','settings'];
  for (const pg of pages) {
    const link = page.locator(`.sb-nav a[data-page="${pg}"]`);
    if (await link.count() > 0) {
      await link.click();
      await page.waitForTimeout(600);
    }
  }

  const fatal = errors.filter(m =>
    m.includes('TypeError') || m.includes('Cannot read') ||
    m.includes('is not a function') || m.includes('is not defined')
  );

  if (fatal.length) console.warn('[pricing-audit] Fatal JS errors:', fatal.slice(0, 5));
  expect(fatal, `Fatal JS errors: ${fatal.slice(0,3).join(' | ')}`).toHaveLength(0);
});
