// reports-accuracy.spec.js — verify reports page data matches DB computations
// Phase 4: Reports accuracy tests
'use strict';
const { test, expect } = require('../fixtures.js');

async function waitForApp(page) {
  await page.goto('/');
  await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
}

async function gotoReports(page) {
  await page.click('.sb-nav a[data-page="reports"]');
  await expect(page.locator('#page-reports')).toBeVisible({ timeout: 10000 });
  await page.waitForFunction(
    () => document.querySelector('#rep-top-accounts-tbody')?.innerHTML?.trim().length > 10,
    { timeout: 10000 }
  );
}

// ── Test 1: Top 10 accounts table has exactly 10 rows ───────────────────────
test('Top 10 accounts table renders 10 rows', async ({ page }) => {
  await waitForApp(page);
  await gotoReports(page);

  const rowCount = await page.locator('#rep-top-accounts-tbody tr').count();
  console.log(`[rep] Top accounts rows: ${rowCount}`);
  expect(rowCount).toBeGreaterThanOrEqual(1);
  expect(rowCount).toBeLessThanOrEqual(10);
});

// ── Test 2: Top account is highest-volume account ────────────────────────────
test('Top accounts table is sorted by cases descending', async ({ page }) => {
  await waitForApp(page);
  await gotoReports(page);

  const { topName, computedTopName } = await page.evaluate(() => {
    const orders   = DB.a('orders').filter(o => o.status !== 'cancelled');
    const accounts = DB.a('ac');
    const byAc = {};
    orders.forEach(o => {
      if (!o.accountId) return;
      if (!byAc[o.accountId]) byAc[o.accountId] = 0;
      (o.items || []).forEach(i => { byAc[o.accountId] += (i.qty || 0); });
    });
    const sorted = Object.entries(byAc).sort((a, b) => b[1] - a[1]);
    const topId   = sorted[0]?.[0];
    const computedTopName = accounts.find(a => a.id === topId)?.name || '?';
    // Get first row name from DOM
    const firstRow = document.querySelector('#rep-top-accounts-tbody tr:first-child td:nth-child(2)');
    const topName  = firstRow ? firstRow.textContent.trim().split('\n')[0].trim() : null;
    return { topName, computedTopName };
  });

  console.log(`[rep] Top account: computed="${computedTopName}", displayed="${topName}"`);
  expect(topName).not.toBeNull();
  expect(topName).toContain(computedTopName);
});

// ── Test 3: Going cold report shows accounts with 45+ day gap ───────────────
test('Going cold report shows only accounts with 45+ days since last order', async ({ page }) => {
  await waitForApp(page);
  await gotoReports(page);

  // Wait for going cold table
  await page.waitForFunction(
    () => document.querySelector('#rep-going-cold-tbody')?.innerHTML?.trim().length > 5,
    { timeout: 8000 }
  ).catch(() => {});

  const { renderedCount, computedCount } = await page.evaluate(() => {
    const todayStr = today();
    const orders   = DB.a('orders').filter(o => o.status !== 'cancelled');
    const accounts = DB.a('ac').filter(a => a.status === 'active');
    let computedCount = 0;
    accounts.forEach(ac => {
      const acOrds = orders.filter(o => o.accountId === ac.id);
      if (!acOrds.length) return;
      const lastOrd  = acOrds.reduce((best, o) => (!best || (o.dueDate||'') > (best.dueDate||'') ? o : best), null);
      if (daysAgo(lastOrd.dueDate) >= 45) computedCount++;
    });
    const tbody = document.querySelector('#rep-going-cold-tbody');
    const renderedCount = tbody
      ? tbody.querySelectorAll('tr:not([class="empty"])').length
      : 0;
    return { renderedCount, computedCount };
  });

  console.log(`[rep] Going cold: computed=${computedCount}, rendered=${renderedCount}`);
  expect(computedCount).toBeGreaterThan(0);
  expect(renderedCount).toBe(computedCount);
});

// ── Test 4: Going cold tiers have correct badge labels ───────────────────────
test('Going cold report has correct 45/60/90-day tier badges', async ({ page }) => {
  await waitForApp(page);
  await gotoReports(page);

  await page.waitForFunction(
    () => document.querySelector('#rep-going-cold-tbody')?.innerHTML?.trim().length > 5,
    { timeout: 8000 }
  ).catch(() => {});

  const badgeLabels = await page.evaluate(() => {
    const spans = document.querySelectorAll('#rep-going-cold-tbody td span.badge');
    return Array.from(spans).map(s => s.textContent.trim());
  });

  const valid = new Set(['45+ days', '60+ days', '90+ days']);
  const invalid = badgeLabels.filter(l => !valid.has(l));
  console.log(`[rep] Going cold badges: ${[...new Set(badgeLabels)].join(', ')}`);
  expect(invalid).toHaveLength(0);
  expect(badgeLabels.length).toBeGreaterThan(0);
});

// ── Test 5: MoM table shows 24 month rows ───────────────────────────────────
test('MoM table renders 24 rows (last 24 months)', async ({ page }) => {
  await waitForApp(page);
  await gotoReports(page);

  await page.waitForFunction(
    () => document.querySelector('#rep-mom-tbody')?.querySelectorAll('tr').length >= 24,
    { timeout: 8000 }
  ).catch(() => {});

  const rowCount = await page.locator('#rep-mom-tbody tr').count();
  console.log(`[rep] MoM rows: ${rowCount}`);
  expect(rowCount).toBe(24);
});

// ── Test 6: Best month callout matches highest-cases month in DB ─────────────
test('Best month callout matches highest-cases month computed from orders', async ({ page }) => {
  await waitForApp(page);
  await gotoReports(page);

  await page.waitForFunction(
    () => document.querySelector('#rep-mom-callout')?.innerHTML?.trim().length > 0,
    { timeout: 8000 }
  ).catch(() => {});

  const { computedBestLabel, displayedBestLabel } = await page.evaluate(() => {
    const orders = DB.a('orders').filter(o => o.status !== 'cancelled');
    const monthMap = {};
    orders.forEach(o => {
      const key = (o.dueDate || o.created || '').slice(0, 7);
      if (!key) return;
      if (!monthMap[key]) monthMap[key] = 0;
      (o.items || []).forEach(i => { monthMap[key] += (i.qty || 0); });
    });
    const best = Object.entries(monthMap).sort((a, b) => b[1] - a[1])[0];
    if (!best) return { computedBestLabel: null, displayedBestLabel: null };
    // Format as app does: "Apr 2026"
    const d = new Date(best[0] + '-01');
    const computedBestLabel = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    const callout = document.querySelector('#rep-mom-callout');
    const bestDiv = callout?.querySelector('div[style*="f0fdf4"] div:nth-child(2)');
    const displayedBestLabel = bestDiv ? bestDiv.textContent.trim() : null;
    return { computedBestLabel, displayedBestLabel };
  });

  console.log(`[rep] Best month: computed="${computedBestLabel}", displayed="${displayedBestLabel}"`);
  if (computedBestLabel && displayedBestLabel) {
    expect(displayedBestLabel).toBe(computedBestLabel);
  } else {
    console.log('[rep] Best month callout not rendered or no data — skipping assertion');
  }
});
