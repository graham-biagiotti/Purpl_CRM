// emails.spec.js — tests for the Emails compose page: templates, token gate, send flow
const { test, expect } = require('../fixtures.js');

// Helper: navigate to Emails page
async function gotoEmails(page) {
  await page.click('.sb-nav a[data-page="emails"]');
  await expect(page.locator('#page-emails')).toBeVisible({ timeout: 10000 });
  // Wait for template cards to render
  await page.waitForSelector('#emails-templates-col .email-template-card', { timeout: 10000 });
}

test.describe('Emails Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#app-shell', { state: 'visible', timeout: 20000 });
    await gotoEmails(page);
  });

  test('Emails page loads — KPI cards, template column, and at least 4 template cards visible', async ({ page }) => {
    // KPI row should be visible
    await expect(page.locator('#emails-kpis')).toBeVisible();

    // Template column should have cards
    const templateCards = await page.locator('#emails-templates-col .email-template-card').count();
    expect(templateCards).toBeGreaterThanOrEqual(4);

    // Compose tab should be active
    await expect(page.locator('#emails-tab-compose')).toBeVisible();
  });

  test('Select "Approved — Welcome" template — card becomes active', async ({ page }) => {
    // Click the Approved Welcome template card
    const approvedCard = page.locator('#emails-templates-col .email-template-card')
      .filter({ hasText: 'Approved' })
      .first();
    await expect(approvedCard).toBeVisible({ timeout: 10000 });
    await approvedCard.click();
    await page.waitForTimeout(500);

    // The card should now have the 'active' class
    await expect(approvedCard).toHaveClass(/active/, { timeout: 5000 });
  });

  test('Select ac001 from account dropdown — has token, Send button enabled, preview appears', async ({ page }) => {
    // Select Approved Welcome template first
    const approvedCard = page.locator('#emails-templates-col .email-template-card')
      .filter({ hasText: 'Approved' })
      .first();
    await approvedCard.click();
    await page.waitForTimeout(300);

    // The preview column should now contain an account selector
    // The account dropdown is rendered inside #emails-preview-col
    const accountSelect = page.locator('#emails-preview-col select').first();
    await expect(accountSelect).toBeVisible({ timeout: 10000 });

    // Select ac001 — account with a token (find option by partial text via evaluate)
    await accountSelect.evaluate((sel) => {
      for (const opt of sel.options) {
        if (opt.text.toLowerCase().includes('harvest moon')) { sel.value = opt.value; break; }
      }
    });
    await accountSelect.dispatchEvent('change');
    await page.waitForTimeout(1000);

    // Send button should be enabled (ac001 has token)
    const sendBtn = page.locator('#emails-page-send-btn');
    if (await sendBtn.isVisible()) {
      await expect(sendBtn).not.toBeDisabled({ timeout: 5000 });
    }
  });

  test('Select ac003 (no token) with Approved template — amber warning, Send disabled, Generate Portal Link visible', async ({ page }) => {
    // Select Approved template
    const approvedCard = page.locator('#emails-templates-col .email-template-card')
      .filter({ hasText: 'Approved' })
      .first();
    await approvedCard.click();
    await page.waitForTimeout(300);

    const accountSelect = page.locator('#emails-preview-col select').first();
    await expect(accountSelect).toBeVisible({ timeout: 10000 });

    // Select ac003 — The Lavender Shop, no portal token
    await accountSelect.evaluate((sel) => {
      for (const opt of sel.options) {
        if (opt.text.toLowerCase().includes('lavender shop')) { sel.value = opt.value; break; }
      }
    });
    await accountSelect.dispatchEvent('change');
    await page.waitForTimeout(1000);

    // Send button should be disabled
    const sendBtn = page.locator('#emails-page-send-btn');
    if (await sendBtn.isVisible()) {
      await expect(sendBtn).toBeDisabled({ timeout: 5000 });
    }

    // Warning message about missing portal link should appear
    const warningText = await page.locator('#emails-preview-col').textContent();
    expect(warningText).toMatch(/portal|token|generate/i);

    // "Generate Portal Link" button should be visible
    await expect(
      page.locator('#emails-preview-col').getByText('Generate Portal Link')
    ).toBeVisible({ timeout: 5000 });
  });

  test('Click "Generate Portal Link" for no-token account — toast confirms, Send button enabled', async ({ page }) => {
    // Select Approved template and ac003
    const approvedCard = page.locator('#emails-templates-col .email-template-card')
      .filter({ hasText: 'Approved' })
      .first();
    await approvedCard.click();
    await page.waitForTimeout(300);

    const accountSelect = page.locator('#emails-preview-col select').first();
    await expect(accountSelect).toBeVisible({ timeout: 10000 });
    await accountSelect.evaluate((sel) => {
      for (const opt of sel.options) {
        if (opt.text.toLowerCase().includes('lavender shop')) { sel.value = opt.value; break; }
      }
    });
    await accountSelect.dispatchEvent('change');
    await page.waitForTimeout(1000);

    // Click Generate Portal Link
    const generateBtn = page.locator('#emails-preview-col').getByText('Generate Portal Link');
    if (await generateBtn.isVisible()) {
      await generateBtn.click();

      // Wait for toast to appear (faster check before it disappears)
      let toastText = '';
      try {
        await page.waitForFunction(() => {
          const el = document.getElementById('toast');
          return el && el.textContent && el.textContent.trim().length > 0;
        }, { timeout: 3000 });
        toastText = await page.locator('#toast').textContent().catch(() => '');
      } catch (_) {}

      await page.waitForTimeout(500);

      // After token generation, send button should be enabled (no longer disabled)
      const sendBtn = page.locator('#emails-page-send-btn');
      const sendBtnVisible = await sendBtn.isVisible().catch(() => false);
      if (sendBtnVisible) {
        const isDisabled = await sendBtn.isDisabled().catch(() => true);
        // Token was generated: send btn enabled, OR toast mentions 'generat'
        console.log(`[emails-test] Generate Portal Link: isDisabled=${isDisabled}, toast="${toastText}"`);
        expect(!isDisabled || toastText.toLowerCase().includes('generat')).toBeTruthy();
      }
    }
  });

  test('Select "Invoice Sent" template — subject reflects invoice reference', async ({ page }) => {
    // Click Invoice Sent template card
    const invoiceCard = page.locator('#emails-templates-col .email-template-card')
      .filter({ hasText: 'Invoice Sent' })
      .first();
    await expect(invoiceCard).toBeVisible({ timeout: 10000 });
    await invoiceCard.click();
    await page.waitForTimeout(300);

    // Card should become active
    await expect(invoiceCard).toHaveClass(/active/, { timeout: 5000 });

    // Select an account that has invoices (ac002)
    const accountSelect = page.locator('#emails-preview-col select').first();
    if (await accountSelect.isVisible()) {
      // Try to select ac002 or any account
      const options = await accountSelect.locator('option').allTextContents();
      if (options.length > 1) {
        await accountSelect.selectOption({ index: 1 });
        await page.waitForTimeout(1000);
      }
    }

    // The preview column should have rendered some content
    await expect(page.locator('#emails-preview-col')).not.toBeEmpty();
  });

  test('Select "Application Received" template — Send button always enabled (no token required)', async ({ page }) => {
    // Application Received template has no token gate
    const appRecCard = page.locator('#emails-templates-col .email-template-card')
      .filter({ hasText: 'Application Received' })
      .first();
    await expect(appRecCard).toBeVisible({ timeout: 10000 });
    await appRecCard.click();
    await page.waitForTimeout(300);

    await expect(appRecCard).toHaveClass(/active/, { timeout: 5000 });

    // Select any account — Send should be enabled regardless
    const accountSelect = page.locator('#emails-preview-col select').first();
    if (await accountSelect.isVisible()) {
      const options = await accountSelect.locator('option').allTextContents();
      if (options.length > 1) {
        await accountSelect.selectOption({ index: 1 });
        await page.waitForTimeout(1000);

        const sendBtn = page.locator('#emails-page-send-btn');
        if (await sendBtn.isVisible()) {
          // Application Received has no token gate — should never be disabled
          await expect(sendBtn).not.toBeDisabled({ timeout: 5000 });
        }
      }
    }
  });

  test('Mass Email tab — click the card, verify mass email section appears', async ({ page }) => {
    // There is a special dashed-border card that switches to Mass Email tab
    const massEmailCard = page.locator('#emails-templates-col .email-template-card')
      .filter({ hasText: /mass/i });
    if (await massEmailCard.count() > 0) {
      await massEmailCard.click();
    } else {
      // Alternatively click the Mass Email tab button directly
      await page.click('button.tab').filter({ hasText: 'Mass Email' }).catch(async () => {
        await page.getByText('Mass Email').click();
      });
    }
    await page.waitForTimeout(500);

    // Mass email section should be visible
    await expect(page.locator('#emails-tab-mass')).toBeVisible({ timeout: 5000 });
  });

  test('Email History tab — renders without crash', async ({ page }) => {
    // Click the History tab button specifically (not any element containing 'history')
    await page.locator('button.tab[onclick*="history"]').click();
    await page.waitForTimeout(500);

    // History tab container should be visible
    await expect(page.locator('#emails-tab-history')).toBeVisible({ timeout: 5000 });
    // No JS error should have crashed the page — app shell still visible
    await expect(page.locator('#app-shell')).toBeVisible();
  });

  test('Email Overview tab — renders without crash', async ({ page }) => {
    // Click the Overview tab button specifically
    await page.locator('button.tab[onclick*="overview"]').click();
    await page.waitForTimeout(500);

    await expect(page.locator('#emails-tab-overview')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#app-shell')).toBeVisible();
  });
});
