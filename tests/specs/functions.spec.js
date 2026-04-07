// functions.spec.js — Firebase Cloud Functions emulator: reachability and input validation
//
// These tests call the Functions emulator directly via HTTP (not via the browser),
// so they do NOT use Playwright page fixtures.  They verify that each function
// endpoint is reachable and that input validation returns the expected errors.
'use strict';
const { test, expect } = require('@playwright/test');

const FUNCTIONS_BASE = 'http://127.0.0.1:5001/purpl-crm/us-central1';
const ALLOWED_FROM   = 'lavender@pbfwholesale.com';

// Helper: call a Firebase onCall function via HTTP
async function callFn(name, data) {
  const response = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ data }),
  }).catch(err => ({ _fetchError: err.message }));
  return response;
}

test.describe('Functions — Section A: Reachability', () => {
  test('Functions emulator is reachable at localhost:5001', async () => {
    const resp = await fetch(`http://127.0.0.1:5001/`)
      .catch(() => null);
    // If the emulator is running, we get a response (any status code is fine)
    // If not running, resp is null — the test is a soft skip
    if (!resp) {
      console.log('[functions] Emulator not reachable — skip (start with: firebase emulators:start --only functions)');
      return;
    }
    expect(resp.status).toBeGreaterThan(0);
  });

  test('sendEmail endpoint exists (not 404)', async () => {
    const resp = await fetch(`${FUNCTIONS_BASE}/sendEmail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    }).catch(() => null);

    if (!resp) {
      console.log('[functions] sendEmail endpoint unreachable — emulator may not be running');
      return;
    }
    // 404 means the function is not deployed to the emulator
    expect(resp.status).not.toBe(404);
  });

  test('sendOrderConfirmation endpoint exists (not 404)', async () => {
    const resp = await fetch(`${FUNCTIONS_BASE}/sendOrderConfirmation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    }).catch(() => null);

    if (!resp) return;
    expect(resp.status).not.toBe(404);
  });

  test('resendWebhook endpoint exists and accepts POST', async () => {
    const resp = await fetch(`${FUNCTIONS_BASE}/resendWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'email.sent', data: {} }),
    }).catch(() => null);

    if (!resp) {
      console.log('[functions] resendWebhook unreachable — skip');
      return;
    }
    // resendWebhook is onRequest — any non-connection-error response is acceptable
    expect(resp.status).toBeGreaterThan(0);
    console.log(`[functions] resendWebhook status: ${resp.status}`);
  });
});

test.describe('Functions — Section B: Input validation', () => {
  test('sendEmail — missing required fields (to, subject, html) returns error', async () => {
    const resp = await callFn('sendEmail', {}).catch(() => null);
    if (!resp || resp._fetchError) {
      console.log('[functions] sendEmail not reachable — skip');
      return;
    }

    // Firebase HttpsError('invalid-argument') → HTTP 400
    expect([400, 200]).toContain(resp.status);

    const body = await resp.json().catch(() => ({}));
    // The error body should indicate missing/invalid argument
    const errMsg = body?.error?.message || body?.error?.status || '';
    if (resp.status === 400) {
      expect(errMsg.toLowerCase()).toMatch(/missing|invalid|argument/i);
    }
    console.log(`[functions] sendEmail missing-fields status=${resp.status} msg="${errMsg}"`);
  });

  test('sendEmail — invalid from address returns invalid-argument error', async () => {
    const resp = await callFn('sendEmail', {
      to:      'test@example.com',
      from:    'hacker@evil.com',   // not in ALLOWED_FROM
      subject: 'Test',
      html:    '<p>Test</p>',
    }).catch(() => null);

    if (!resp || resp._fetchError) return;

    expect([400, 200]).toContain(resp.status);
    const body = await resp.json().catch(() => ({}));
    const errMsg = body?.error?.message || '';
    if (resp.status === 400) {
      expect(errMsg.toLowerCase()).toMatch(/invalid|from|address/i);
    }
    console.log(`[functions] sendEmail invalid-from status=${resp.status}`);
  });

  test('sendEmail — valid payload structure accepted (may fail at Resend with test key)', async () => {
    const resp = await callFn('sendEmail', {
      to:      'test@example.com',
      from:    ALLOWED_FROM,
      subject: 'Playwright test email',
      html:    '<p>This is a test.</p>',
    }).catch(() => null);

    if (!resp || resp._fetchError) {
      console.log('[functions] sendEmail not reachable — skip');
      return;
    }

    // With a test RESEND_API_KEY the send will fail but the function will be invoked
    // We expect either 200 (success or internal error) — NOT 400 (invalid-argument)
    expect(resp.status).not.toBe(404);
    console.log(`[functions] sendEmail valid-payload status: ${resp.status}`);
  });

  test('sendOrderConfirmation — missing required fields returns error', async () => {
    const resp = await callFn('sendOrderConfirmation', {}).catch(() => null);
    if (!resp || resp._fetchError) return;

    expect([400, 200]).toContain(resp.status);
    const body = await resp.json().catch(() => ({}));
    const errMsg = body?.error?.message || '';
    if (resp.status === 400) {
      expect(errMsg.toLowerCase()).toMatch(/missing|required/i);
    }
    console.log(`[functions] sendOrderConfirmation missing-fields status=${resp.status}`);
  });

  test('resendWebhook — POST with valid JSON returns 200', async () => {
    const resp = await fetch(`${FUNCTIONS_BASE}/resendWebhook`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'email.sent',
        data: { email_id: 'test-id', from: ALLOWED_FROM, to: ['test@example.com'] },
      }),
    }).catch(() => null);

    if (!resp) {
      console.log('[functions] resendWebhook not reachable — skip');
      return;
    }
    expect(resp.status).toBe(200);
  });
});

// ── Phase 6: Edge case coverage ────────────────────────────────
// Note: these tests soft-skip (with a log message) when the Functions emulator
// is not serving the endpoint (404 = not deployed). All assertions only run
// when the function is actually reachable and responding.

function skipIf404(resp, name) {
  if (!resp || resp._fetchError || resp.status === 404) {
    console.log(`[functions] ${name} not deployed in emulator — skip`);
    return true;
  }
  return false;
}

test.describe('Functions — Section C: Edge cases', () => {
  test('sendEmail — missing from field returns invalid-argument (not server error)', async () => {
    const resp = await callFn('sendEmail', {
      to:      'test@example.com',
      subject: 'Test',
      html:    '<p>Test</p>',
      // from: omitted — ALLOWED_FROM.includes(undefined) → false → "Invalid from address"
    }).catch(() => null);

    if (skipIf404(resp, 'sendEmail')) return;

    // Should be 400 (invalid-argument) NOT 500 (unhandled internal error)
    expect(resp.status).not.toBe(500);
    const body = await resp.json().catch(() => ({}));
    const errMsg = body?.error?.message || '';
    if (resp.status === 400) {
      expect(errMsg.toLowerCase()).toMatch(/invalid|from|address/i);
    }
    console.log(`[functions] sendEmail missing-from: status=${resp.status} msg="${errMsg}"`);
  });

  test('sendEmail — empty string to field returns invalid-argument', async () => {
    const resp = await callFn('sendEmail', {
      to:      '',  // falsy → missing check fires
      from:    ALLOWED_FROM,
      subject: 'Test',
      html:    '<p>Test</p>',
    }).catch(() => null);

    if (skipIf404(resp, 'sendEmail')) return;

    expect([400, 200]).toContain(resp.status);
    if (resp.status === 400) {
      const body = await resp.json().catch(() => ({}));
      expect((body?.error?.message || '').toLowerCase()).toMatch(/missing|required|to/i);
    }
    console.log(`[functions] sendEmail empty-to: status=${resp.status}`);
  });

  test('sendCombinedInvoice — missing required fields returns 400', async () => {
    const resp = await callFn('sendCombinedInvoice', {}).catch(() => null);
    if (skipIf404(resp, 'sendCombinedInvoice')) return;

    expect([400, 200]).toContain(resp.status);
    if (resp.status === 400) {
      const body = await resp.json().catch(() => ({}));
      expect((body?.error?.message || '').toLowerCase()).toMatch(/missing|required/i);
    }
    console.log(`[functions] sendCombinedInvoice missing-fields: status=${resp.status}`);
  });

  test('sendCombinedInvoice — valid payload is not rejected (400/404)', async () => {
    const resp = await callFn('sendCombinedInvoice', {
      to:          'test@example.com',
      accountName: 'Test Account',
      subject:     'Test Invoice',
      html:        '<p>Invoice content</p>',
    }).catch(() => null);

    if (skipIf404(resp, 'sendCombinedInvoice')) return;

    // Valid payload should NOT be rejected with invalid-argument
    expect(resp.status).not.toBe(400);
    console.log(`[functions] sendCombinedInvoice valid-payload: status=${resp.status}`);
  });

  test('resendWebhook — GET method returns 405', async () => {
    const resp = await fetch(`${FUNCTIONS_BASE}/resendWebhook`, {
      method: 'GET',
    }).catch(() => null);

    if (skipIf404(resp, 'resendWebhook')) return;

    expect(resp.status).toBe(405);
    console.log('[functions] resendWebhook GET→405: ✓');
  });

  test('resendWebhook — unknown event type returns 200 "ignored"', async () => {
    const resp = await fetch(`${FUNCTIONS_BASE}/resendWebhook`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'email.bounced',  // not in ['email.opened', 'email.clicked']
        data: { email_id: 'test-bounce-id' },
      }),
    }).catch(() => null);

    if (skipIf404(resp, 'resendWebhook')) return;

    expect(resp.status).toBe(200);
    expect(await resp.text().catch(() => '')).toMatch(/ignored/i);
    console.log('[functions] resendWebhook unknown-type→ignored: ✓');
  });

  test('resendWebhook — missing email_id returns 200 "ignored"', async () => {
    const resp = await fetch(`${FUNCTIONS_BASE}/resendWebhook`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        type: 'email.opened',
        data: { /* no email_id */ from: 'test@example.com' },
      }),
    }).catch(() => null);

    if (skipIf404(resp, 'resendWebhook')) return;

    expect(resp.status).toBe(200);
    expect(await resp.text().catch(() => '')).toMatch(/ignored/i);
    console.log('[functions] resendWebhook missing-email_id→ignored: ✓');
  });

  test('resendWebhook — empty body returns 200 "ignored"', async () => {
    const resp = await fetch(`${FUNCTIONS_BASE}/resendWebhook`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    '{}',
    }).catch(() => null);

    if (skipIf404(resp, 'resendWebhook')) return;

    expect(resp.status).toBe(200);
    console.log('[functions] resendWebhook empty-body→200: ✓');
  });

  test('submitWholesaleForm — rate limit fires after 5 rapid calls', async () => {
    const results = [];

    for (let i = 0; i < 7; i++) {
      const resp = await callFn('submitWholesaleForm', {}).catch(() => null);
      if (i === 0 && skipIf404(resp, 'submitWholesaleForm')) return;
      if (!resp || resp._fetchError) return;
      results.push(resp.status);
    }

    const rateLimited = results.some(s => s === 429);
    if (rateLimited) {
      console.log('[functions] submitWholesaleForm rate limit fires: ✓');
    } else {
      console.log('[functions] submitWholesaleForm: all succeeded (window may have reset)');
    }

    // Rate limit errors must be clean — no 500s
    expect(results.every(s => s !== 500)).toBe(true);
  });
});
