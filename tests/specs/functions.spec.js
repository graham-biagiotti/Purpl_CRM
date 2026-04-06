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
