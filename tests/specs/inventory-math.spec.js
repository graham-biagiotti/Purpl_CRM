// inventory-math.spec.js — verify inventory KPIs match computed values
// Phase 2: Inventory math correctness tests
'use strict';
const { test, expect } = require('../fixtures.js');

const CANS_PER_CASE = 12;

async function waitForApp(page) {
  await page.goto('/');
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
}

async function gotoInventory(page) {
  await page.click('.sb-nav a[data-page="inventory"]');
  await expect(page.locator('#page-inventory')).toBeVisible({ timeout: 10000 });
  await page.waitForFunction(
    () => document.querySelector('#inv-stock-cards')?.innerHTML?.trim().length > 0,
    { timeout: 10000 }
  );
}

// ── Test 1: CANS_PER_CASE constant is 12 ────────────────────────────────────
test('CANS_PER_CASE constant equals 12', async ({ page }) => {
  await waitForApp(page);
  const cpc = await page.evaluate(() => typeof CANS_PER_CASE !== 'undefined' ? CANS_PER_CASE : null);
  expect(cpc).toBe(12);
});

// ── Test 2: Finished Packs KPI matches in minus out from iv array ────────────
test('Inventory Finished Packs KPI matches sum(in+return) - sum(out) from iv', async ({ page }) => {
  await waitForApp(page);
  await gotoInventory(page);

  const { expected, displayed } = await page.evaluate(() => {
    const iv = DB.a('iv');
    const SKUS_LIST = SKUS.map(s => s.id);
    let expected = 0;
    for (const sku of SKUS_LIST) {
      const ins  = iv.filter(e => e.sku === sku && (e.type === 'in' || e.type === 'return')).reduce((t, e) => t + e.qty, 0);
      const outs = iv.filter(e => e.sku === sku && e.type === 'out').reduce((t, e) => t + e.qty, 0);
      expected += Math.max(0, ins - outs);
    }
    // Find displayed value from #inv-stock-cards first kpi .num element
    const el = document.querySelector('#inv-stock-cards .kpi .num');
    const displayed = el ? parseInt(el.textContent.replace(/,/g, '').replace(/\s.*/, ''), 10) : null;
    return { expected, displayed };
  });

  console.log(`[inv-math] Finished Packs: expected=${expected}, displayed=${displayed}`);
  expect(displayed).not.toBeNull();
  expect(Math.abs(displayed - expected)).toBeLessThanOrEqual(1);
});

// ── Test 3: Running total per SKU never goes negative ────────────────────────
test('Running inventory total never goes negative for any SKU', async ({ page }) => {
  await waitForApp(page);

  const negativeEntries = await page.evaluate(() => {
    const iv = DB.a('iv');
    const SKUS_LIST = SKUS.map(s => s.id);
    const problems = [];
    for (const sku of SKUS_LIST) {
      const entries = iv
        .filter(e => e.sku === sku && (e.type === 'in' || e.type === 'out' || e.type === 'return'))
        .sort((a, b) => (a.date || '') < (b.date || '') ? -1 : 1);
      let running = 0;
      for (const e of entries) {
        if (e.type === 'in' || e.type === 'return') running += e.qty;
        else running -= e.qty;
        if (running < 0) {
          problems.push({ sku, date: e.date, running, entryId: e.id });
          break;
        }
      }
    }
    return problems;
  });

  if (negativeEntries.length > 0) {
    console.warn('[inv-math] Negative balance entries:', JSON.stringify(negativeEntries));
  }
  expect(negativeEntries).toHaveLength(0);
});

// ── Test 4: canCount on every order equals items × CANS_PER_CASE ─────────────
test('Order canCount equals items.qty sum × CANS_PER_CASE for all orders', async ({ page }) => {
  await waitForApp(page);

  const mismatches = await page.evaluate((CPC) => {
    const orders = DB.a('orders');
    return orders.filter(o => {
      if (!o.items || !o.canCount) return false;
      const computed = o.items.reduce((s, i) => s + (i.qty || 0), 0) * CPC;
      return Math.abs(computed - o.canCount) > 0;
    }).map(o => ({ id: o.id, canCount: o.canCount, computed: o.items.reduce((s, i) => s + i.qty, 0) * CPC }));
  }, CANS_PER_CASE);

  if (mismatches.length > 0) {
    console.warn('[inv-math] canCount mismatches:', JSON.stringify(mismatches.slice(0, 5)));
  }
  expect(mismatches).toHaveLength(0);
});

// ── Test 5: Dashboard "Total Inventory" KPI matches computed total ───────────
test('Dashboard Total Inventory KPI matches iv sum(in+return) - sum(out)', async ({ page }) => {
  await waitForApp(page);

  const { expected, kpiText } = await page.evaluate(() => {
    const iv = DB.a('iv');
    const SKUS_LIST = SKUS.map(s => s.id);
    let expected = 0;
    for (const sku of SKUS_LIST) {
      const ins  = iv.filter(e => e.sku === sku && (e.type === 'in' || e.type === 'return')).reduce((t, e) => t + e.qty, 0);
      const outs = iv.filter(e => e.sku === sku && e.type === 'out').reduce((t, e) => t + e.qty, 0);
      expected += Math.max(0, ins - outs);
    }
    const el = document.querySelector('#dash-kpi-inv-cans .num');
    const kpiText = el ? el.textContent.trim() : null;
    return { expected, kpiText };
  });

  console.log(`[inv-math] Dash inv KPI: expected=${expected}, kpiText="${kpiText}"`);
  expect(kpiText).not.toBeNull();
  const kpiNum = parseInt(String(kpiText).replace(/,/g, '').replace(/\s.*/, ''), 10);
  expect(Math.abs(kpiNum - expected)).toBeLessThanOrEqual(1);
});

// ── Test 6: Total produced (prod_hist) is positive and > total sold ──────────
test('Total produced cases exceeds total delivered cases (inventory positive)', async ({ page }) => {
  await waitForApp(page);

  const { produced, delivered } = await page.evaluate((CPC) => {
    const SKU_KEYS = ['classic', 'blueberry', 'raspberry', 'peach', 'variety'];
    const prod = DB.a('prod_hist');
    let produced = 0;
    for (const run of prod) {
      if (run.cans) produced += run.cans / CPC;
      else for (const k of SKU_KEYS) if (run[k]) produced += run[k];
    }
    const orders = DB.a('orders').filter(o => o.status === 'delivered');
    const delivered = orders.reduce((s, o) => s + (o.canCount || 0), 0) / CPC;
    return { produced, delivered };
  }, CANS_PER_CASE);

  console.log(`[inv-math] Produced=${produced} cases, Delivered=${delivered} cases, Balance=${produced - delivered}`);
  expect(produced).toBeGreaterThan(0);
  expect(delivered).toBeGreaterThan(0);
  expect(produced).toBeGreaterThan(delivered);
});
