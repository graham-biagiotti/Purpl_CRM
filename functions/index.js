const {onCall, HttpsError} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');

const resendApiKey = defineSecret('RESEND_API_KEY');

// ── Allowed sender addresses ──────────────────────────────
const ALLOWED_FROM = [
  'lavender@pbfwholesale.com',
];

// ── In-memory rate limiter ────────────────────────────────
const rateLimitMap = new Map();

function checkRateLimit(ip, limit = 5, windowMs = 60000) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || {count: 0, start: now};
  if (now - entry.start > windowMs) {
    rateLimitMap.set(ip, {count: 1, start: now});
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  rateLimitMap.set(ip, entry);
  return true;
}

// ── 1. Send Email ─────────────────────────────────────────
// Generic transactional email via Resend.
// data: { to, from, subject, html, accountId? }
exports.sendEmail = onCall(
  {secrets: [resendApiKey]},
  async (request) => {
    const data = request.data;
    if (!data.to || !data.subject || !data.html) {
      throw new HttpsError(
        'invalid-argument',
        'Missing required fields: to, subject, html'
      );
    }
    if (!ALLOWED_FROM.includes(data.from)) {
      throw new HttpsError(
        'invalid-argument',
        'Invalid from address'
      );
    }

    const {Resend} = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    try {
      const result = await resend.emails.send({
        from: data.from,
        to: data.to,
        subject: data.subject,
        html: data.html,
      });
      return {success: true, id: result.data?.id || result.id};
    } catch (err) {
      throw new HttpsError('internal', err.message);
    }
  }
);

// ── 2. Send Combined Invoice ──────────────────────────────
// Sends a full combined invoice HTML email from the farm address.
// data: { to, accountName, subject, html }
exports.sendCombinedInvoice = onCall(
  {secrets: [resendApiKey]},
  async (request) => {
    const data = request.data;
    if (!data.to || !data.html) {
      throw new HttpsError(
        'invalid-argument',
        'Missing required fields: to, html'
      );
    }

    const {Resend} = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    try {
      const result = await resend.emails.send({
        from: 'lavender@pbfwholesale.com',
        to: data.to,
        subject: data.subject || 'Invoice from Pumpkin Blossom Farm',
        html: data.html,
      });
      return {success: true, id: result.data?.id || result.id};
    } catch (err) {
      throw new HttpsError('internal', err.message);
    }
  }
);

// ── 3. Send Order Confirmation ────────────────────────────
// Sends a branded order confirmation to the customer.
// data: { to, accountName, contactName, orderSummary, portalLink, isPbf }
exports.sendOrderConfirmation = onCall(
  {secrets: [resendApiKey]},
  async (request) => {
    const data = request.data;
    if (!data.to || !data.accountName) {
      throw new HttpsError(
        'invalid-argument',
        'Missing required fields: to, accountName'
      );
    }

    const accentColor = data.isPbf ? '#4a7c59' : '#8B5FBF';
    const brandName = data.isPbf
      ? 'Lavender Fields at Pumpkin Blossom Farm'
      : 'purpl';

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0eff4;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0eff4;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
  style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:${accentColor};padding:24px 40px;text-align:center">
    <div style="font-size:18px;font-weight:600;color:#fff">Order Received</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:4px">${brandName}</div>
  </td></tr>
  <tr><td style="padding:32px 40px;font-size:15px;color:#1a1a2e;line-height:1.7">
    <p>Hi ${data.contactName || 'there'},</p>
    <p>We received your order for <strong>${data.accountName}</strong> and we're on it. You'll hear from us with delivery details shortly.</p>
    ${data.orderSummary || ''}
    <p style="margin-top:20px">Questions? Reply to this email or call 603-748-3038.</p>
    <p>Warmly,<br><strong>Graham Biagiotti</strong><br>Pumpkin Blossom Farm</p>
    ${data.portalLink ? `
    <div style="margin-top:20px;padding-top:20px;border-top:1px solid #e5e7eb;text-align:center">
      <a href="${data.portalLink}" style="color:${accentColor};font-size:13px;text-decoration:none">Place another order →</a>
    </div>` : ''}
  </td></tr>
  <tr><td style="background:#f9fafb;padding:16px 40px;text-align:center;font-size:11px;color:#9ca3af">
    Pumpkin Blossom Farm LLC · 393 Pumpkin Hill Rd · Warner, NH 03278<br>
    lavender@pbfwholesale.com
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

    const {Resend} = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    try {
      const result = await resend.emails.send({
        from: 'lavender@pbfwholesale.com',
        to: data.to,
        subject: `Order received — ${data.accountName}`,
        html,
      });
      return {success: true, id: result.data?.id || result.id};
    } catch (err) {
      throw new HttpsError('internal', err.message);
    }
  }
);

// ── 4. Rate-limited wholesale form wrapper ────────────────
// Wholesale form still writes directly to Firestore from the browser.
// This callable is a rate-limited wrapper for future use.
exports.submitWholesaleForm = onCall(
  {secrets: [resendApiKey]},
  async (request) => {
    const ip = request.rawRequest?.ip || 'unknown';
    if (!checkRateLimit(ip)) {
      throw new HttpsError(
        'resource-exhausted',
        'Too many requests. Please try again later.'
      );
    }
    return {success: true};
  }
);
