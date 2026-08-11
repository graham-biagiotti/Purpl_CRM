const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
// Business-local (US Eastern) calendar date. Webhooks stamped UTC dates, which
// after 8pm ET land on TOMORROW — evening payments booked into next month's
// Collected and (Dec 31) the next tax year. en-CA gives YYYY-MM-DD.
const etDate = (d) => new Date(d || Date.now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
// Webhook health ledger: every accepted/rejected inbound call stamps
// integration_health/{service} so a dead or misconfigured callback is visible
// in Settings instead of silently invisible (the ShipStation secret misconfig
// hid for weeks because rejections left no trace).
async function recordWebhookHealth(service, ok, note) {
  try {
    await admin.firestore().collection('workspace/main/integration_health').doc(service).set(
      ok ? { lastReceivedAt: new Date().toISOString(), lastResult: 'ok', lastNote: note || '' }
        : { lastRejectedAt: new Date().toISOString(), lastResult: 'rejected', lastRejectNote: note || '' },
      { merge: true });
  } catch (e) { console.warn('health record failed:', e.message); }
}

const resendApiKey = defineSecret('RESEND_API_KEY');
const resendWebhookSecret = defineSecret('RESEND_WEBHOOK_SECRET');
const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');
const shipStationApiKey = defineSecret('SHIPSTATION_API_KEY');

const ALLOWED_FROM = [
  'lavender@pbfwholesale.com',
];

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Render an HTML document to a PDF buffer (headless Chromium). Lazy-required
// so ordinary sends never pay the chromium startup cost.
async function _htmlToPdf(html) {
  const chromium = require('@sparticuz/chromium');
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, {waitUntil: 'networkidle0', timeout: 30000});
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: {top: '0.35in', bottom: '0.35in', left: '0.35in', right: '0.35in'},
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

// ── 1. Send Email ─────────────────────────────────────────
exports.sendEmail = onCall(
  {secrets: [resendApiKey], memory: '1GiB', timeoutSeconds: 120},
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
    const data = request.data;
    if (!data.to || !data.subject || !data.html) {
      throw new HttpsError('invalid-argument', 'Missing required fields: to, subject, html');
    }
    if (!ALLOWED_FROM.includes(data.from)) {
      throw new HttpsError('invalid-argument', 'Invalid from address');
    }

    const {Resend} = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    // Optional attachments — max 5, ~5MB total base64. Two shapes:
    //   {filename, content(base64)}  → passed through to Resend as-is
    //   {filename, htmlToPdf(base64 HTML)} → rendered to a PDF server-side
    let attachments;
    if (Array.isArray(data.attachments) && data.attachments.length) {
      attachments = data.attachments
        .filter(a => a && typeof a.filename === 'string' &&
          (typeof a.content === 'string' || typeof a.htmlToPdf === 'string'))
        .slice(0, 5);
      const totalLen = attachments.reduce((s, a) => s + (a.content || a.htmlToPdf).length, 0);
      if (!attachments.length) attachments = undefined;
      // Refuse loudly rather than silently sending without the file the body
      // tells the recipient to open.
      else if (totalLen > 5 * 1024 * 1024) {
        throw new HttpsError('invalid-argument', 'Attachment too large (5MB max) — email NOT sent');
      } else {
        const out = [];
        for (const a of attachments) {
          if (a.htmlToPdf) {
            const html = Buffer.from(a.htmlToPdf, 'base64').toString('utf8');
            try {
              out.push({filename: a.filename, content: await _htmlToPdf(html)});
            } catch (err) {
              console.error('PDF render error:', err.message);
              throw new HttpsError('internal', 'PDF render failed — email NOT sent: ' + (err.message || 'unknown'));
            }
          } else {
            out.push({filename: a.filename, content: a.content});
          }
        }
        attachments = out;
      }
    }

    try {
      const result = await resend.emails.send({
        from: data.from,
        to: data.to,
        subject: data.subject,
        html: data.html,
        ...(attachments ? {attachments} : {}),
      });
      const messageId = result.data?.id || result.id;

      // Log cadence entry if accountId provided
      if (data.accountId && messageId) {
        await _logCadenceEntry(data.accountId, {
          stage: data.cadenceStage || 'email_sent',
          sentMessageId: messageId,
          subject: data.subject,
        });
      }

      return {success: true, id: messageId};
    } catch (err) {
      console.error('Email send error:', err.message);
      throw new HttpsError('internal', 'Email send failed: ' + (err.message || 'unknown error'));
    }
  }
);

// ── 2. Send Combined Invoice ──────────────────────────────
exports.sendCombinedInvoice = onCall(
  {secrets: [resendApiKey]},
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
    const data = request.data;
    if (!data.to || !data.html) {
      throw new HttpsError('invalid-argument', 'Missing required fields: to, html');
    }

    const {Resend} = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    try {
      const result = await resend.emails.send({
        from: 'lavender@pbfwholesale.com',
        to: data.to,
        replyTo: 'graham@pumpkinblossomfarm.com',
        subject: data.subject || 'Invoice from Pumpkin Blossom Farm',
        html: data.html,
      });
      const messageId = result.data?.id || result.id;

      // No server-side cadence log here: the CRM client logs this send itself
      // (with sentBy/method/invoiceRef). Logging in both places produced two
      // "Invoice Sent" history rows for every combined send.

      return {success: true, id: messageId};
    } catch (err) {
      console.error('Email send error:', err.message);
      throw new HttpsError('internal', 'Email send failed: ' + (err.message || 'unknown error'));
    }
  }
);

// ── 3. Send Order Confirmation ────────────────────────────
// Intentionally public — called from order.html portal (unauthenticated customers).
// TB-3 FIX: orderSummary is now structured data rendered server-side (no raw HTML).
// accountId/portalOrderId validated before writing.
exports.sendOrderConfirmation = onCall(
  {secrets: [resendApiKey]},
  async (request) => {
    const data = request.data;
    if (!data.accountName) {
      throw new HttpsError('invalid-argument', 'Missing required field: accountName');
    }
    // HIGH-8: this callable is intentionally public (the unauthenticated portal
    // sends its own confirmation). To stop it being an open branded-email relay,
    // bind the recipient to a real portal order: require portalOrderId, look it
    // up, and send ONLY to the email stored on that order — never an arbitrary
    // client-supplied data.to. Also make it idempotent so one order can't be
    // re-triggered as an email-bombing vector.
    if (!data.portalOrderId || typeof data.portalOrderId !== 'string') {
      throw new HttpsError('invalid-argument', 'Missing portalOrderId');
    }
    const _poRef = admin.firestore().collection('portal_orders').doc(data.portalOrderId);
    const _poSnap = await _poRef.get();
    if (!_poSnap.exists) {
      throw new HttpsError('not-found', 'Order not found');
    }
    const _po = _poSnap.data();
    const recipient = _po.billingEmail || _po.contactEmail || '';
    if (!recipient || typeof recipient !== 'string' || recipient.length > 200) {
      throw new HttpsError('failed-precondition', 'Order has no valid email on file');
    }
    // Idempotency: don't re-send if this order already got a confirmation.
    if ((_po.emailLog || []).some(e => e && e.stage === 'order_confirmation')) {
      return { success: true, alreadySent: true };
    }
    data.to = recipient; // server-authoritative recipient

    // MED-3: portalLink is interpolated into an href. escHtml blocks quote
    // breakout but NOT dangerous URI schemes (javascript:, data:). Only allow
    // http(s); drop anything else so the link can't be a phishing/script vector.
    if (data.portalLink && !/^https?:\/\//i.test(String(data.portalLink))) {
      data.portalLink = null;
    }

    // TB-3 FIX: render order summary server-side from structured items
    let orderSummaryHtml = '';
    if (Array.isArray(data.items)) {
      for (const item of data.items.slice(0, 50)) {
        orderSummaryHtml += `<p style="margin:0 0 6px;color:#374151">${escHtml(String(item.name || ''))} &mdash; ${escHtml(String(item.qty || ''))}${item.total ? ' &mdash; $' + escHtml(String(item.total)) : ''}</p>`;
      }
    }
    if (data.poNumber) {
      orderSummaryHtml += `<p style="margin:10px 0 0;color:#374151"><strong>PO Number:</strong> ${escHtml(String(data.poNumber))}</p>`;
    }

    const accentColor = data.isPbf ? '#4F5D80' : '#4D2A6F';

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
  style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:#4D2A6F;background:linear-gradient(135deg,#4D2A6F 0%,#7A5C9E 100%);padding:32px 40px;text-align:center">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table cellpadding="0" cellspacing="0" width="auto">
          <tr>
            <td width="auto" valign="middle" style="padding-right:16px">
              <img src="https://purpl-crm.web.app/images/purpl-wordmark-white.png" alt="purpl" width="170" height="65" style="display:block">
            </td>
            <td width="1px" valign="middle">
              <div style="width:1px;height:44px;background:rgba(255,255,255,0.5)"></div>
            </td>
            <td width="auto" valign="middle" style="padding-left:16px">
              <img src="https://purpl-crm.web.app/images/lf-logo-white.png" alt="Lavender Fields" width="84" height="78" style="display:block">
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
    <div style="text-align:center;font-family:Arial,sans-serif;font-size:10px;color:rgba(255,255,255,0.9);letter-spacing:0.15em;text-transform:uppercase;margin-top:10px">Pumpkin Blossom Farm · Wholesale</div>
  </td></tr>
  <tr><td style="background:#B3C8C1;height:4px"></td></tr>
  <tr><td style="padding:32px 40px;font-size:15px;color:#1a1a2e;line-height:1.7">
    <p>Hi ${escHtml(data.contactName || 'there')},</p>
    <p style="line-height:1.7">Thanks for your ${data.mode === 'preorder' ? 'pre-order' : 'order'} for <strong>${escHtml(data.accountName)}</strong>. I've got it and I'm on it personally.</p>
    ${orderSummaryHtml}
    ${data.shipAddress && data.shipAddress.street1 ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0">
      <tr><td style="padding:14px 18px;background:#f9fafb;border-radius:6px;border:1px solid #e5e7eb;font-size:13px;color:#374151">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;font-weight:600">Shipping To</div>
        ${escHtml(data.shipAddress.street1)}${data.shipAddress.street2 ? '<br>' + escHtml(data.shipAddress.street2) : ''}<br>
        ${escHtml(data.shipAddress.city || '')}${data.shipAddress.state ? ', ' + escHtml(data.shipAddress.state) : ''} ${escHtml(data.shipAddress.zip || '')}
      </td></tr>
    </table>` : ''}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0">
      <tr><td style="padding:14px 18px;background:#f9fafb;border-radius:6px;border-left:3px solid #1a1a2e;font-size:13px;color:#374151;line-height:1.8">
        <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px;font-weight:600">What Happens Next</div>
        ${data.mode === 'preorder'
          ? 'I\'ll confirm availability and reach out with delivery timing. Your invoice will be sent closer to the ship date — payment is Net 30 from the invoice date.'
          : 'I\'ll confirm your order and schedule delivery. Your invoice will come from lavender@pbfwholesale.com — payment is Net 30 from the invoice date.'}
        ${data.requestSample ? '<br><br><strong>Sample box:</strong> I\'ll review your request and get a 3-can taster shipped out. You\'ll receive a tracking number by email once it goes out.' : ''}
      </td></tr>
    </table>
    <p style="line-height:1.7;font-size:14px;margin-top:16px">I'm your direct contact for this account — reply to this email, call, or text anytime.</p>
    <p>Graham Biagiotti<br>Pumpkin Blossom Farm<br>603-748-3038 · graham@pumpkinblossomfarm.com</p>
    <div style="margin-top:20px;padding-top:20px;border-top:1px solid #e5e7eb;text-align:center;font-size:13px;color:#6b7280">
      ${data.portalLink ? `<a href="${escHtml(data.portalLink)}" style="color:${accentColor};text-decoration:none">Place another order →</a><br>` : ''}
      Wholesale info: <a href="https://pbfwholesale.com" style="color:${accentColor};text-decoration:none">pbfwholesale.com</a>
    </div>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:16px 40px;text-align:center;font-size:11px;color:#6b7280">
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
      const messageId = result.data?.id || result.id;

      // TB-3 FIX: validate portalOrderId exists before writing to it
      if (data.portalOrderId && typeof data.portalOrderId === 'string' && messageId) {
        try {
          const poDoc = await admin.firestore().collection('portal_orders').doc(data.portalOrderId).get();
          if (poDoc.exists) {
            await poDoc.ref.update({
              emailLog: admin.firestore.FieldValue.arrayUnion({
                stage: 'order_confirmation',
                sentAt: new Date().toISOString(),
                sentBy: 'system',
                method: 'resend',
                sentMessageId: messageId,
                to: data.to,
              }),
            });
            // Only write cadence if accountId matches the portal order's account
            const poData = poDoc.data();
            if (poData.accountId && poData.accountId === data.accountId && messageId) {
              await _logCadenceEntry(poData.accountId, {
                stage: 'order_confirmation',
                sentMessageId: messageId,
                subject: `Order received — ${escHtml(data.accountName)}`,
              });
            }
          }
        } catch(e) { console.warn('Failed to log portal order email:', e.message); }
      }

      return {success: true, id: messageId};
    } catch (err) {
      console.error('Email send error:', err.message);
      // Flag the portal order so the CRM can see the customer never got
      // a confirmation — otherwise this failure is invisible to everyone.
      if (data.portalOrderId) {
        await admin.firestore().collection('portal_orders').doc(String(data.portalOrderId))
          .update({confirmationEmailFailed: true}).catch(() => {});
      }
      throw new HttpsError('internal', 'Email send failed: ' + (err.message || 'unknown error'));
    }
  }
);

// ── 3b. Send Application Confirmation ──────────────────────
// Public callable (no auth) — sends the predefined "application received"
// email to the applicant. Only sends the fixed template, not arbitrary HTML.
// Rate-limited by requiring the portal_inquiries docId to exist.
exports.sendApplicationConfirmation = onCall(
  {secrets: [resendApiKey]},
  async (request) => {
    const data = request.data;
    if (!data.businessName || !data.contactName) {
      throw new HttpsError('invalid-argument', 'Missing required fields');
    }
    // MED-2: public callable — bind it to a real inquiry so it can't be an open
    // branded-email relay or an arbitrary portal_inquiries tamper primitive.
    // Require inquiryDocId, load it, send ONLY to the email stored on it, and
    // make it idempotent. Never trust client data.to.
    if (!data.inquiryDocId || typeof data.inquiryDocId !== 'string') {
      throw new HttpsError('invalid-argument', 'Missing inquiryDocId');
    }
    const _inqRef = admin.firestore().collection('portal_inquiries').doc(data.inquiryDocId);
    const _inqSnap = await _inqRef.get();
    if (!_inqSnap.exists) throw new HttpsError('not-found', 'Inquiry not found');
    const _inq = _inqSnap.data();
    const recipient = _inq.email || '';
    if (!recipient || typeof recipient !== 'string' || recipient.length > 200) {
      throw new HttpsError('failed-precondition', 'Inquiry has no valid email');
    }
    if ((_inq.emailLog || []).some(e => e && e.stage === 'application_received')) {
      return { success: true, alreadySent: true };
    }
    data.to = recipient; // server-authoritative recipient

    const safeName = escHtml(data.contactName);
    const safeBiz = escHtml(data.businessName);

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
  style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:#4D2A6F;background:linear-gradient(135deg,#4D2A6F 0%,#7A5C9E 100%);padding:32px 40px;text-align:center">
    <table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
      <td valign="middle" style="padding-right:16px"><img src="https://purpl-crm.web.app/images/purpl-wordmark-white.png" alt="purpl" width="170" height="65" style="display:block"></td>
      <td valign="middle" style="padding:0 16px"><div style="width:1px;height:44px;background:rgba(255,255,255,0.5)"></div></td>
      <td valign="middle"><img src="https://purpl-crm.web.app/images/lf-logo-white.png" alt="Lavender Fields" width="84" height="78" style="display:block"></td>
    </tr></table>
    <div style="font-size:10px;color:rgba(255,255,255,0.9);letter-spacing:0.15em;text-transform:uppercase;margin-top:10px">Pumpkin Blossom Farm · Wholesale</div>
  </td></tr>
  <tr><td style="background:#B3C8C1;height:4px"></td></tr>
  <tr><td style="padding:32px 40px;font-size:15px;color:#1a1a2e;line-height:1.7">
    <p style="font-size:17px;font-weight:500;margin:0 0 20px">Hi ${safeName},</p>
    <p>Thank you for your interest in carrying our products at <strong>${safeBiz}</strong>. We've received your application and will be in touch within 1 business day.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
      <tr><td style="background:#f9fafb;border-left:3px solid #4D2A6F;padding:16px 20px;border-radius:0 6px 6px 0">
        <div style="font-size:13px;color:#6b7280;margin-bottom:4px;font-weight:500">WHAT HAPPENS NEXT</div>
        <div style="font-size:14px;color:#1a1a2e">We review every application personally. You'll hear from us within 1 business day with next steps.</div>
      </td></tr>
    </table>
    <p>In the meantime, feel free to reach out with any questions.</p>
    <p>Warmly,<br><strong>Graham Biagiotti</strong><br>Pumpkin Blossom Farm<br>603-748-3038</p>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:16px 40px;text-align:center;font-size:11px;color:#6b7280">
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
        subject: `Thank you for your wholesale application — Pumpkin Blossom Farm`,
        html,
      });
      const messageId = result.data?.id || result.id;
      // Log email to inquiry doc so it shows in tracking (admin SDK bypasses rules)
      if (data.inquiryDocId) {
        try {
          await admin.firestore().collection('portal_inquiries').doc(data.inquiryDocId).update({
            emailLog: admin.firestore.FieldValue.arrayUnion({
              stage: 'application_received',
              sentAt: new Date().toISOString(),
              sentBy: 'system',
              method: 'resend',
              sentMessageId: messageId,
              to: data.to,
            }),
          });
        } catch(e) { console.warn('Failed to log application email:', e.message); }
      }
      return {success: true, id: messageId};
    } catch (err) {
      console.error('Email send error:', err.message);
      // Flag the inquiry so the CRM shows the applicant never got a confirmation.
      if (data.inquiryDocId) {
        await admin.firestore().collection('portal_inquiries').doc(String(data.inquiryDocId))
          .update({confirmationEmailFailed: true}).catch(() => {});
      }
      throw new HttpsError('internal', 'Email send failed: ' + (err.message || 'unknown error'));
    }
  }
);

// ── 3c. AI Proxy — keeps Anthropic key server-side ───────
exports.callAnthropic = onCall(
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
    const data = request.data;
    if (!data.prompt || typeof data.prompt !== 'string') {
      throw new HttpsError('invalid-argument', 'Missing prompt');
    }
    if (data.prompt.length > 5000) {
      throw new HttpsError('invalid-argument', 'Prompt too long');
    }
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new HttpsError('failed-precondition', 'AI features not configured — ask admin to set ANTHROPIC_API_KEY');
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: data.systemPrompt || '',
          messages: [{ role: 'user', content: data.prompt }],
        }),
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err?.error?.message || `API error ${response.status}`);
      }
      const result = await response.json();
      return { text: result.content?.[0]?.text || '' };
    } catch (err) {
      console.error('Anthropic API error:', err.message);
      throw new HttpsError('internal', 'AI service unavailable');
    }
  }
);

// ── 3e. Check Duplicate Application ──────────────────────
exports.checkDuplicateApplication = onCall(async (request) => {
  const email = request.data?.email;
  if (!email || typeof email !== 'string') return { exists: false };
  const db = admin.firestore();
  const snap = await db.collection('portal_inquiries')
    .where('email', '==', email.toLowerCase().trim()).limit(1).get();
  return { exists: !snap.empty };
});

// ── 3f. Get Portal Config (public, no password) ──────────
// ── 3g. Get LF Catalog (public) ───────────────────────────
// The portal cannot read workspace/* (rules are staff-only), so customers
// always saw the hardcoded LF_SKU_FALLBACK — staff price/catalog edits never
// reached the order form. Product catalog only; no PII.
exports.getLfCatalog = onCall(async () => {
  const db = admin.firestore();
  const doc = await db.collection("workspace").doc("main").collection("config").doc("main").get();
  const skus = doc.exists ? (doc.data().lf_skus || []) : [];
  return { skus: skus.filter(s => !s.archived) };
});

// ── Public stockist list for the Where to Find Us page ────
// Whitelist by construction: entries are built field-by-field — name,
// address, lat, lng, brands. Nothing else on an account (emails, tokens,
// pricing) can ever reach the response.
exports.getStockists = onCall(async () => {
  const db = admin.firestore();
  const out = [];
  let skipped = 0;
  // Returns true when the entry made it onto the public list — the CALLER
  // owns skip accounting (the old push-side global counter made the
  // fallback arithmetic wrong and could consume other accounts' skips).
  const push = (name, address, lat, lng, brands) => {
    if (!name) return false;
    const la = parseFloat(lat), ln = parseFloat(lng);
    if (!la || !ln) return false;
    out.push({
      name: String(name),
      address: String(address || ''),
      lat: la, lng: ln,
      brands: Array.isArray(brands) ? brands.filter(b => b === 'purpl' || b === 'lf') : [],
    });
    return true;
  };
  const acSnap = await db.collection('workspace/main/ac').get();
  acSnap.forEach(d => {
    const a = d.data();
    if (!a.stockistListed || a.status === 'inactive') return;
    const locs = (Array.isArray(a.locs) && a.locs.length)
      ? a.locs
      : [{ address: a.address, lat: a.lat, lng: a.lng, label: '' }];
    let pushed = 0, missedHere = 0;
    locs.forEach(l => {
      if (push(a.name + (l.label ? ' — ' + l.label : ''), l.address || a.address, l.lat, l.lng, a.stockistBrands)) pushed++;
      else missedHere++;
    });
    // The Territory Map batch geocoder writes coordinates at the TOP LEVEL of
    // the account; a locs[] entry without its own coords must not hide the
    // store. If NO location produced a pin, fall back to the account pin —
    // and only then does the fallback absorb this account's misses.
    if (!pushed && a.lat && a.lng) {
      if (push(a.name, a.address || (locs[0] && locs[0].address) || '', a.lat, a.lng, a.stockistBrands)) missedHere = 0;
    }
    skipped += missedHere;
  });
  const stSnap = await db.collection('workspace/main/stockist_locations').get();
  stSnap.forEach(d => {
    const s = d.data();
    if (s.active === false) return;
    if (!push(s.name, s.address, s.lat, s.lng, s.brands)) skipped++;
  });
  return { stockists: out, skipped };
});

// Returns only public-safe fields from portal_settings.
exports.getPortalConfig = onCall(async (request) => {
  const db = admin.firestore();
  const snap = await db.collection('portal_settings').doc('config').get();
  if (!snap.exists) return { mode: 'preorder', pricePerCase: null };
  const data = snap.data();
  return {
    mode: data.mode || 'preorder',
    pricePerCase: data.pricePerCase || null,
  };
});

// ── 3d. Verify Portal Password (public) ──────────────────
// Checks password server-side — never exposes the password to the client.
exports.verifyPortalPassword = onCall(async (request) => {
  const pw = request.data?.password;
  if (!pw || typeof pw !== 'string') return { valid: false };
  // The wholesale portal password is permanently "purpleherb". Accept it
  // directly so the manual-entry path can never break from config drift —
  // the Settings field and the gate historically read different Firestore
  // docs, which could make the stored password appear unset and lock people
  // out. (Personalized ?t= links bypass this gate entirely.)
  if (pw.trim().toLowerCase() === 'purpleherb') return { valid: true };
  // A custom stored password still works too, if one is ever configured.
  const db = admin.firestore();
  const snap = await db.collection('portal_settings').doc('config').get();
  if (!snap.exists) return { valid: false };
  const stored = snap.data().portalPassword || '';
  if (!stored) return { valid: false };
  return { valid: pw === stored };
});

// ── 4. Portal Token Lookup ─────────────────────────────────
// Public callable — takes a token, returns account info for the portal.
// Queries Firestore server-side so accounts/prospects collections can
// have restricted read rules (no PII exposed to unauthenticated clients).
exports.lookupPortalToken = onCall(async (request) => {
  const token = request.data?.token;
  if (!token || typeof token !== 'string' || token.length < 5) {
    throw new HttpsError('invalid-argument', 'Invalid token');
  }

  const db = admin.firestore();

  // DM-3 FIX: find token in top-level collections (fast indexed query),
  // then read fresh data from workspace (always up-to-date).
  // Top-level accounts/prospects only store the token for lookup.

  // Check accounts token index
  const acSnap = await db.collection('accounts')
    .where('orderPortalToken', '==', token).limit(1).get();
  if (!acSnap.empty) {
    const acId = acSnap.docs[0].id;
    const wsDoc = await db.collection('workspace/main/ac').doc(acId).get();
    const d = wsDoc.exists ? wsDoc.data() : acSnap.docs[0].data();
    return {
      found: true, isProspect: false, accountId: acId,
      accountName: d.name || '', accountEmail: d.email || '',
      isPbf: d.isPbf || false,
      address: d.address || d.shipAddress || '',
      portalPrefs: d.portalPrefs || {},
    };
  }

  // Check prospects token index
  const prSnap = await db.collection('prospects')
    .where('orderPortalToken', '==', token).limit(1).get();
  if (!prSnap.empty) {
    const prId = prSnap.docs[0].id;
    const wsDoc = await db.collection('workspace/main/pr').doc(prId).get();
    const d = wsDoc.exists ? wsDoc.data() : prSnap.docs[0].data();
    return {
      found: true, isProspect: true, accountId: prId,
      accountName: d.name || '', accountEmail: d.email || '',
      isPbf: d.isPbf || false, portalPrefs: d.portalPrefs || {},
    };
  }

  // Fallback: check workspace directly (token may only exist here)
  for (const col of ['workspace/main/ac', 'workspace/main/pr']) {
    const wsSnap = await db.collection(col)
      .where('orderPortalToken', '==', token).limit(1).get();
    if (!wsSnap.empty) {
      const d = wsSnap.docs[0].data();
      return {
        found: true, isProspect: col.endsWith('/pr'),
        accountId: wsSnap.docs[0].id,
        accountName: d.name || '', accountEmail: d.email || '',
        isPbf: d.isPbf || false,
        address: d.address || d.shipAddress || '',
        portalPrefs: d.portalPrefs || {},
      };
    }
  }

  return { found: false };
});

// ── 4b. Get Portal Order History ─────────────────────────
// Public callable — portal uses token to prove account ownership,
// then fetches order history server-side (portal can't read portal_orders directly).
exports.getPortalOrderHistory = onCall(async (request) => {
  const accountId = request.data?.accountId;
  const token = request.data?.token;
  if (!accountId || !token) return { orders: [] };
  const db = admin.firestore();
  const valid = await db.collection('accounts').where('orderPortalToken', '==', token).limit(1).get()
    .then(s => !s.empty && s.docs[0].id === accountId);
  if (!valid) {
    const wsValid = await db.collection('workspace/main/ac').where('orderPortalToken', '==', token).limit(1).get()
      .then(s => !s.empty && s.docs[0].id === accountId);
    if (!wsValid) return { orders: [] };
  }
  const snap = await db.collection('portal_orders')
    .where('accountId', '==', accountId)
    .orderBy('submittedAt', 'desc')
    .limit(10)
    .get();
  return {
    orders: snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id, status: data.status || 'new',
        accountName: data.accountName || '',
        items: data.items || [], lineItems: data.lineItems || [],
        submittedAt: data.submittedAt?.toDate?.()?.toISOString() || null,
        brand: data.brand || '', total: data.total || 0,
      };
    }),
  };
});

// ── 4b. Public Unsubscribe endpoint ───────────────────────
// One-click unsubscribe for marketing emails. The link in the email points
// here (via the /unsubscribe hosting rewrite). Runs with Admin SDK so it works
// for unauthenticated recipients — the old client-side ?optout handler only
// worked for logged-in CRM users, so external customers' clicks silently did
// nothing. Sets emailOptOut on the account; always returns a friendly page.
exports.unsubscribe = onRequest({ invoker: 'public' }, async (req, res) => {
  const id = String((req.query && (req.query.id || req.query.optout)) || '').trim();
  const page = (title, msg) => `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>` +
    `<body style="font-family:Inter,Arial,sans-serif;background:#f4f4f5;margin:0;padding:48px 16px;text-align:center">` +
    `<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:40px 32px;box-shadow:0 2px 8px rgba(0,0,0,.08)">` +
    `<div style="font-size:13px;letter-spacing:.15em;text-transform:uppercase;color:#4D2A6F;margin-bottom:16px">Pumpkin Blossom Farm</div>` +
    `<h1 style="font-size:20px;color:#1a1a2e;margin:0 0 12px">${title}</h1>` +
    `<p style="color:#4b5563;font-size:15px;line-height:1.6;margin:0">${msg}</p></div></body></html>`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  if (!id) { res.status(400).send(page('Invalid link', 'This unsubscribe link is missing its account reference.')); return; }
  try {
    const ref = admin.firestore().collection('workspace/main/ac').doc(id);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.update({ emailOptOut: true, emailOptOutAt: new Date().toISOString() });
    }
    const name = snap.exists ? (snap.data().name || 'your account') : 'your account';
    res.status(200).send(page("You're unsubscribed",
      `${escHtml(name)} has been removed from our marketing email list. You may still receive order and invoice confirmations. ` +
      `Changed your mind? Just reply to any email and we'll add you back.`));
  } catch (e) {
    console.error('unsubscribe error:', e);
    // Never show an error to the recipient — fail to a reassuring message.
    res.status(200).send(page('All set', "You won't receive further marketing emails from us."));
  }
});

// ── 4c. Init User Role ──────────────────────────────────
// Called on first sign-in to create the users/{uid} doc with the correct role.
// Uses Admin SDK so it bypasses security rules (client can't set role directly).
//
// LAYER 1: Allowlist check — rejects callers not on the list.
// LAYER 3: First-admin in transaction with bootstrapAdminAssigned flag.
//
// Allowlist lives in Firestore: app_config/access_control { allowedEmails: [...] }
// To add a new employee: use inviteEmployee (auto-adds to allowlist),
// or manually add their email to the allowedEmails array in that doc.
// Permanent fallback admin — can never be locked out regardless of allowlist state
const FALLBACK_ADMIN_EMAILS = [
  'grahambiagiotti@gmail.com',
];

exports.initUserRole = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;
  const email = (request.auth.token.email || '').toLowerCase().trim();
  if (!email) throw new HttpsError('permission-denied', 'No email on account');

  const isFallbackAdmin = FALLBACK_ADMIN_EMAILS.includes(email);
  const db = admin.firestore();

  // Existing user — return stored role (skip allowlist check; they were already approved)
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (userSnap.exists) {
    return { role: userSnap.data().role || 'employee' };
  }

  // LAYER 1: check allowlist before creating any user doc
  const configRef = db.collection('app_config').doc('access_control');
  const configSnap = await configRef.get();
  const config = configSnap.exists ? configSnap.data() : {};
  const allowedEmails = (config.allowedEmails || []).map(e => String(e).toLowerCase().trim());

  if (!configSnap.exists) {
    // No allowlist doc yet — seed it with fallback admins only
    await configRef.set({ allowedEmails: [...FALLBACK_ADMIN_EMAILS], bootstrapAdminAssigned: false });
    if (!isFallbackAdmin) {
      throw new HttpsError('permission-denied', 'Access not authorized — contact your admin');
    }
  } else if (!allowedEmails.includes(email)) {
    // Not on the list — fallback admins always get through
    if (!isFallbackAdmin) {
      throw new HttpsError('permission-denied', 'Access not authorized — contact your admin');
    }
    // Fallback admin: add self to allowlist so future checks pass directly
    await configRef.update({
      allowedEmails: admin.firestore.FieldValue.arrayUnion(email),
    });
  }

  // LAYER 3: first-admin assignment in a transaction with persistent flag
  // Fallback admins always get admin role regardless of first-user check
  const role = await db.runTransaction(async (tx) => {
    const cfgSnap = await tx.get(configRef);
    const cfgData = cfgSnap.exists ? cfgSnap.data() : {};
    const alreadyBootstrapped = cfgData.bootstrapAdminAssigned === true;
    const usersSnap = await db.collection('users').limit(1).get();
    const isFirstUser = usersSnap.empty && !alreadyBootstrapped;

    const assignedRole = (isFirstUser || isFallbackAdmin) ? 'admin' : 'employee';
    tx.set(userRef, {
      email,
      displayName: request.auth.token.name || email.split('@')[0] || '',
      role: assignedRole,
      createdAt: new Date().toISOString(),
    });
    if (isFirstUser) {
      tx.update(configRef, { bootstrapAdminAssigned: true });
    }
    return assignedRole;
  });

  return { role };
});

// ── 5. Resend Webhook ─────────────────────────────────────
// Validates webhook signature via svix, then updates cadence entries.
exports.resendWebhook = onRequest(
  {secrets: [resendWebhookSecret], invoker: 'public'},
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    // Validate webhook signature — reject if secret is missing or verification fails
    const whSecret = process.env.RESEND_WEBHOOK_SECRET;
    if (!whSecret) {
      console.error('RESEND_WEBHOOK_SECRET not configured — rejecting webhook');
      res.status(500).send('Webhook secret not configured');
      return;
    }
    try {
      const {Webhook} = require('svix');
      const wh = new Webhook(whSecret);
      // svix signs the RAW request bytes. Verifying JSON.stringify(req.body)
      // re-serializes the parsed body (different key order/whitespace) and the
      // signature won't match — so every open/click event was being 401'd and
      // dropped. Use req.rawBody, same as the Stripe webhook does.
      const rawPayload = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
      wh.verify(rawPayload, {
        'svix-id': req.headers['svix-id'],
        'svix-timestamp': req.headers['svix-timestamp'],
        'svix-signature': req.headers['svix-signature'],
      });
    } catch (err) {
      console.warn('Webhook signature verification failed:', err.message);
      await recordWebhookHealth('resend', false, 'signature verification failed');
      res.status(401).send('Invalid signature');
      return;
    }

    await recordWebhookHealth('resend', true, 'event received');
    const event = req.body;
    const type    = event?.type;
    const emailId = event?.data?.email_id;

    if (!emailId || !['email.opened', 'email.clicked'].includes(type)) {
      res.status(200).send('ignored');
      return;
    }

    try {
      const db  = admin.firestore();
      const ts  = event.data.created_at || new Date().toISOString();
      let updated = false;

      // 1. Check account cadence entries (workspace/main/ac)
      const acSnap = await db.collection('workspace/main/ac').get();
      for (const doc of acSnap.docs) {
        const account = doc.data();
        const cadence = (account.cadence || []);
        const entry = cadence.find(e => e.sentMessageId === emailId);
        if (!entry) continue;
        if (type === 'email.opened' && !entry.opened) { entry.opened = true; entry.openedAt = ts; updated = true; }
        else if (type === 'email.clicked' && !entry.clicked) { entry.clicked = true; entry.clickedAt = ts; updated = true; }
        if (updated) { await doc.ref.update({ cadence }); break; }
      }

      // 2. Check portal_inquiries emailLog (application confirmations, rejections)
      if (!updated) {
        const inqSnap = await db.collection('portal_inquiries').get();
        for (const doc of inqSnap.docs) {
          const inq = doc.data();
          const log = (inq.emailLog || []);
          const entry = log.find(e => e.sentMessageId === emailId);
          if (!entry) continue;
          if (type === 'email.opened' && !entry.opened) { entry.opened = true; entry.openedAt = ts; updated = true; }
          else if (type === 'email.clicked' && !entry.clicked) { entry.clicked = true; entry.clickedAt = ts; updated = true; }
          if (updated) { await doc.ref.update({ emailLog: log }); break; }
        }
      }

      // 3. Check portal_orders emailLog (order confirmations)
      if (!updated) {
        const ordSnap = await db.collection('portal_orders').get();
        for (const doc of ordSnap.docs) {
          const ord = doc.data();
          const log = (ord.emailLog || []);
          const entry = log.find(e => e.sentMessageId === emailId);
          if (!entry) continue;
          if (type === 'email.opened' && !entry.opened) { entry.opened = true; entry.openedAt = ts; updated = true; }
          else if (type === 'email.clicked' && !entry.clicked) { entry.clicked = true; entry.clickedAt = ts; updated = true; }
          if (updated) { await doc.ref.update({ emailLog: log }); break; }
        }
      }

      res.status(200).send(updated ? 'ok' : 'no match');
    } catch (err) {
      console.error('resendWebhook error:', err);
      res.status(500).send('error');
    }
  }
);

// ── Helper: Log cadence entry on an account ───────────────
async function _logCadenceEntry(accountId, entryData) {
  try {
    const db = admin.firestore();
    const ref = db.collection('workspace/main/ac').doc(accountId);
    const snap = await ref.get();
    if (!snap.exists) return;

    const account = snap.data();
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      sentAt: new Date().toISOString(),
      sentBy: 'system',
      method: 'resend',
      ...entryData,
    };
    const cadence = [...(account.cadence || []), entry];
    // Cap at 500 entries to stay well under the 1MB Firestore doc limit
    const trimmed = cadence.length > 500 ? cadence.slice(-500) : cadence;
    // NO lastContacted stamp here: everything the server logs is
    // transactional (order confirmations, application receipts) — a customer
    // placing an order is not the owner contacting the customer. This was the
    // server half of the "I didn't contact this account" bug; the client
    // stamps lastContacted for real outreach only.
    await ref.update({
      cadence: trimmed,
      _updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('_logCadenceEntry error:', err.message);
  }
}

// ── 7. Invite Employee ───────────────────────────────────
// Admin-only: creates a Firebase Auth user and users/{uid} doc with role.
exports.inviteEmployee = onCall(
  {secrets: [resendApiKey]},
  async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

  const db = admin.firestore();
  const callerSnap = await db.collection('users').doc(request.auth.uid).get();
  if (!callerSnap.exists || callerSnap.data().role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only admins can invite employees');
  }

  const {email, displayName, role} = request.data || {};
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new HttpsError('invalid-argument', 'Valid email required');
  }
  const assignRole = (role === 'admin') ? 'admin' : 'employee';

  try {
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email,
        displayName: displayName || email.split('@')[0],
      });
    } catch (createErr) {
      if (createErr.code === 'auth/email-already-exists') {
        userRecord = await admin.auth().getUserByEmail(email);
      } else {
        throw createErr;
      }
    }
    // Never downgrade an existing admin via re-invite; merge preserves other fields
    const existingDoc = await db.collection('users').doc(userRecord.uid).get();
    const existingRole = existingDoc.exists ? existingDoc.data().role : null;
    await db.collection('users').doc(userRecord.uid).set({
      email,
      displayName: displayName || userRecord.displayName || email.split('@')[0],
      role: existingRole === 'admin' ? 'admin' : assignRole,
      invitedBy: request.auth.token.email || request.auth.uid,
      ...(existingDoc.exists ? {} : { createdAt: new Date().toISOString() }),
    }, { merge: true });

    // LAYER 1: add invited email to allowlist so they can sign in
    const _acRef = db.collection('app_config').doc('access_control');
    await _acRef.set({
      allowedEmails: admin.firestore.FieldValue.arrayUnion(email.toLowerCase().trim()),
    }, { merge: true });

    const link = await admin.auth().generatePasswordResetLink(email);

    // Send invite email via Resend
    try {
      const {Resend} = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'lavender@pbfwholesale.com',
        to: email,
        subject: 'You\'re invited to purpl CRM — Pumpkin Blossom Farm',
        html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table width="500" cellpadding="0" cellspacing="0" style="max-width:500px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:#4D2A6F;background:linear-gradient(135deg,#4D2A6F 0%,#7A5C9E 100%);padding:28px 32px;text-align:center">
    <div style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px">purpl CRM</div>
    <div style="color:rgba(255,255,255,0.9);font-size:11px;letter-spacing:0.1em;text-transform:uppercase;margin-top:4px">Pumpkin Blossom Farm</div>
  </td></tr>
  <tr><td style="padding:28px 32px;font-size:15px;color:#1a1a2e;line-height:1.7">
    <p>Hi ${escHtml(displayName || email.split('@')[0])},</p>
    <p>You've been invited to join the <strong>purpl CRM</strong> team as ${assignRole === 'admin' ? 'an admin' : 'an employee'}.</p>
    <p>Click the button below to set your password and sign in:</p>
    <div style="text-align:center;margin:24px 0">
      <a href="${link}" style="display:inline-block;background:#4D2A6F;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Set Password &amp; Sign In</a>
    </div>
    <p style="font-size:13px;color:#6b7280">After setting your password, go to <a href="https://purpl-crm.web.app" style="color:#4D2A6F">purpl-crm.web.app</a> to sign in.</p>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:14px 32px;text-align:center;font-size:11px;color:#6b7280">
    Pumpkin Blossom Farm LLC · Warner, NH
  </td></tr>
</table>
</td></tr></table>
</body></html>`,
      });
    } catch (emailErr) {
      console.warn('Invite email failed (account still created):', emailErr.message);
    }

    return { success: true, uid: userRecord.uid, resetLink: link };
  } catch (err) {
    console.error('inviteEmployee error:', err.message);
    throw new HttpsError('internal', 'Invite failed: ' + (err.message || 'unknown error'));
  }
});

// ── 8a. Stripe Diagnostic ────────────────────────────────
// Returns a step-by-step report instead of throwing — so the CRM always
// gets a readable answer even if require('stripe') itself crashes.
exports.stripeStatus = onCall(
  {secrets: [stripeSecretKey]},
  async (request) => {
    if (!request.auth) return {ok: false, step: 'auth', msg: 'Not signed in'};
    const steps = [];
    // 1. Check key
    const raw = process.env.STRIPE_SECRET_KEY;
    if (!raw) return {ok: false, step: 'secret', msg: 'STRIPE_SECRET_KEY env var is empty/missing. Run: firebase functions:secrets:set STRIPE_SECRET_KEY', steps};
    const key = raw.trim();
    steps.push('Key exists: ' + key.slice(0, 7) + '...' + key.slice(-4) + ' (' + key.length + ' chars)');
    if (raw !== key) steps.push('WARNING: key had leading/trailing whitespace — trimmed');
    if (!key.startsWith('sk_')) return {ok: false, step: 'key_format', msg: 'Key starts with "' + key.slice(0, 3) + '" — must start with sk_live_ or sk_test_. You may have saved the publishable key by mistake.', steps};
    steps.push('Key format OK (starts with sk_)');
    // 2. Load stripe
    let stripe;
    try {
      stripe = require('stripe')(key);
      steps.push('Stripe SDK loaded OK');
    } catch (e) {
      return {ok: false, step: 'require', msg: 'require("stripe") failed: ' + (e.message || String(e)), steps};
    }
    // 3. Test API call
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{price_data: {currency: 'usd', product_data: {name: 'Connection Test'}, unit_amount: 100}, quantity: 1}],
        mode: 'payment',
        success_url: 'https://purpl-crm.web.app/payment-success.html?inv=TEST',
        cancel_url: 'https://purpl-crm.web.app/payment-success.html?cancelled=1&inv=TEST',
      });
      steps.push('Checkout session created: ' + session.id);
      return {ok: true, url: session.url, steps};
    } catch (e) {
      return {ok: false, step: 'stripe_api', msg: (e.type || '') + ': ' + (e.message || String(e)), steps};
    }
  }
);

// ── 8c. Create Pay Link (v2) ─────────────────────────────
// Fresh function name — replaces createStripePaymentLink, whose deployed
// revision was stuck returning opaque 'internal' errors. Same never-throw
// pattern as stripeStatus (which is proven working in production).
exports.createPayLink = onCall(
  {secrets: [stripeSecretKey]},
  async (request) => {
    if (!request.auth) return {ok: false, v: 2, error: 'Not signed in'};
    const data = request.data || {};
    if (!data.invoiceId || !data.invoiceType) return {ok: false, v: 2, error: 'Missing invoiceId or invoiceType'};

    // TB-2 FIX: look up the invoice server-side — never trust client-supplied amount
    const db = admin.firestore();
    const colMap = { retail: 'workspace/main/retail_invoices', lf: 'workspace/main/lf_invoices',
      combined: 'workspace/main/combined_invoices', dist: 'workspace/main/dist_invoices', iv: 'workspace/main/iv' };
    const col = colMap[data.invoiceType] || colMap.retail;
    let invoiceSnap;
    try { invoiceSnap = await db.collection(col).doc(data.invoiceId).get(); } catch(e) {}
    if (!invoiceSnap || !invoiceSnap.exists) return {ok: false, v: 2, error: 'Invoice not found'};
    const inv = invoiceSnap.data();
    const serverTotal = parseFloat(inv.grandTotal || inv.total || inv.amount || 0);
    if (!serverTotal || serverTotal < 0.50) return {ok: false, v: 2, error: 'Invoice total too small or zero'};
    const invoiceNumber = inv.number || inv.invoiceNumber || data.invoiceNumber || '';
    const accountName = inv.accountName || data.accountName || '';

    const key = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!key) return {ok: false, v: 2, error: 'STRIPE_SECRET_KEY is not set'};
    if (!key.startsWith('sk_')) return {ok: false, v: 2, error: 'STRIPE_SECRET_KEY must start with sk_ (got ' + key.slice(0, 3) + '...)'};

    let stripe;
    try { stripe = require('stripe')(key); } catch (e) { return {ok: false, v: 2, error: 'Stripe SDK failed: ' + e.message}; }

    const amountCents = Math.round(serverTotal * 100);

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Invoice ${invoiceNumber}`,
              description: accountName ? `${accountName} — Pumpkin Blossom Farm` : 'Pumpkin Blossom Farm',
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        }],
        mode: 'payment',
        metadata: {
          invoiceNumber,
          invoiceId: data.invoiceId,
          invoiceType: data.invoiceType,
          accountId: inv.accountId || data.accountId || '',
        },
        success_url: 'https://purpl-crm.web.app/payment-success.html?inv=' + encodeURIComponent(invoiceNumber),
        cancel_url: 'https://purpl-crm.web.app/payment-success.html?cancelled=1&inv=' + encodeURIComponent(invoiceNumber),
      });
      return {ok: true, v: 2, url: session.url, sessionId: session.id};
    } catch (err) {
      console.error('createPayLink Stripe error:', err.type, err.code, err.message);
      return {ok: false, v: 2, error: 'Stripe: ' + (err.message || err.type || 'unknown error')};
    }
  }
);

// ── 8a½. Evergreen pay link ──────────────────────────────
// Public GET /pay?inv=<docId>&t=<type> (hosting rewrite on purpl-crm.web.app).
// Emails used to embed a Checkout Session URL minted at send time — Stripe
// sessions expire after 24h, so every Net-30 invoice's Pay button was dead by
// the time customers clicked. This mints a FRESH session per click, with the
// amount read server-side from the invoice at click time (edits after send
// charge the current total). The random doc id in the URL is the bearer
// credential — same trust model as the emailed session URL it replaces.
exports.payInvoice = onRequest(
  {secrets: [stripeSecretKey], invoker: 'public'},
  async (req, res) => {
    const esc = s => String(s || '').replace(/[<>&"]/g, '');
    const page = (title, body) => res.status(200).send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="font-family:Arial,sans-serif;background:#f4f4f5;margin:0;padding:40px 16px;text-align:center">
<div style="max-width:460px;margin:0 auto;background:#fff;border-radius:10px;padding:36px 28px;box-shadow:0 2px 8px rgba(0,0,0,.08)">
<div style="font-size:22px;font-weight:700;color:#4D2A6F;margin-bottom:10px">${esc(title)}</div>
<div style="font-size:15px;color:#374151;line-height:1.6">${body}</div>
<div style="margin-top:18px;font-size:13px;color:#6b7280">Pumpkin Blossom Farm · <a href="mailto:lavender@pbfwholesale.com" style="color:#4D2A6F">lavender@pbfwholesale.com</a></div>
</div></body></html>`);
    try {
      const invId = String(req.query.inv || '').trim();
      const typeHint = String(req.query.t || 'retail').trim();
      if (!invId) return page('Payment link problem', 'This link is missing its invoice reference. Please reply to your invoice email and we\'ll send a fresh one.');
      const db = admin.firestore();
      const COLS = { retail: 'retail_invoices', lf: 'lf_invoices', combined: 'combined_invoices', dist: 'dist_invoices', iv: 'iv' };
      const TYPE_OF = Object.fromEntries(Object.entries(COLS).map(([k, v]) => [v, k]));
      const firstCol = COLS[typeHint] || 'retail_invoices';
      const tryCols = [firstCol, ...Object.values(COLS).filter(c => c !== firstCol)];
      let inv = null, matchedCol = null;
      for (const c of tryCols) {
        const snap = await db.collection('workspace/main/' + c).doc(invId).get();
        if (snap.exists) { inv = snap.data(); matchedCol = c; break; }
      }
      if (!inv) return page('Invoice not found', 'We couldn\'t find this invoice — it may have been replaced. Please reply to your invoice email and we\'ll send a fresh link.');
      const invoiceNumber = inv.number || inv.invoiceNumber || '';
      if (inv.status === 'paid') return page('Already paid — thank you! 💜', `Invoice <strong>${esc(invoiceNumber)}</strong> is marked paid. No further payment is needed.`);
      if (inv.status === 'void') return page('Invoice no longer active', `Invoice <strong>${esc(invoiceNumber)}</strong> has been cancelled. If that seems wrong, just reply to your invoice email.`);
      const serverTotal = parseFloat(inv.grandTotal || inv.total || inv.amount || 0);
      if (!serverTotal || serverTotal < 0.50) return page('Nothing due', 'This invoice has no payable balance. Questions? Reply to your invoice email.');
      const key = (process.env.STRIPE_SECRET_KEY || '').trim();
      const stripe = require('stripe')(key);
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Invoice ${invoiceNumber}`,
              description: inv.accountName ? `${inv.accountName} — Pumpkin Blossom Farm` : 'Pumpkin Blossom Farm',
            },
            unit_amount: Math.round(serverTotal * 100),
          },
          quantity: 1,
        }],
        mode: 'payment',
        metadata: {
          invoiceNumber,
          invoiceId: invId,
          invoiceType: TYPE_OF[matchedCol] || 'retail',
          accountId: inv.accountId || '',
        },
        success_url: 'https://purpl-crm.web.app/payment-success.html?inv=' + encodeURIComponent(invoiceNumber),
        cancel_url: 'https://purpl-crm.web.app/payment-success.html?cancelled=1&inv=' + encodeURIComponent(invoiceNumber),
      });
      return res.redirect(302, session.url);
    } catch (err) {
      console.error('payInvoice error:', err.message);
      return page('Payment page hiccup', 'We couldn\'t open the payment page just now. Please try again in a minute, or reply to your invoice email — we\'re on it.');
    }
  }
);

// ── 8b. Create Stripe Payment Link ───────────────────────
// Auth-required. Generates a unique Stripe Checkout Session link for an invoice.
// Returns {ok, url, error} instead of throwing — Firebase v2 onCall wraps
// thrown errors as opaque "internal", hiding the real message.
exports.createStripePaymentLink = onCall(
  {secrets: [stripeSecretKey]},
  async (request) => {
    if (!request.auth) return {ok: false, error: 'Not signed in'};
    const data = request.data;
    if (!data.invoiceId || !data.invoiceType) return {ok: false, error: 'Missing invoiceId or invoiceType'};

    // TB-2 FIX: server-side invoice lookup — never trust client amount
    const db = admin.firestore();
    const colMap = { retail: 'workspace/main/retail_invoices', lf: 'workspace/main/lf_invoices',
      combined: 'workspace/main/combined_invoices', dist: 'workspace/main/dist_invoices', iv: 'workspace/main/iv' };
    const col = colMap[data.invoiceType] || colMap.retail;
    let invoiceSnap;
    try { invoiceSnap = await db.collection(col).doc(data.invoiceId).get(); } catch(e) {}
    if (!invoiceSnap || !invoiceSnap.exists) return {ok: false, error: 'Invoice not found'};
    const inv = invoiceSnap.data();
    const serverTotal = parseFloat(inv.grandTotal || inv.total || inv.amount || 0);
    if (!serverTotal || serverTotal < 0.50) return {ok: false, error: 'Invoice total too small or zero'};
    const invoiceNumber = inv.number || inv.invoiceNumber || data.invoiceNumber || '';
    const accountName = inv.accountName || data.accountName || '';

    const key = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!key) return {ok: false, error: 'STRIPE_SECRET_KEY is not set. Run: firebase functions:secrets:set STRIPE_SECRET_KEY'};
    if (!key.startsWith('sk_')) return {ok: false, error: 'STRIPE_SECRET_KEY starts with ' + key.slice(0, 3) + ' — must start with sk_live_ or sk_test_'};

    let stripe;
    try { stripe = require('stripe')(key); } catch (e) { return {ok: false, error: 'Stripe SDK failed: ' + e.message}; }

    const amountCents = Math.round(serverTotal * 100);

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Invoice ${invoiceNumber}`,
              description: accountName ? `${accountName} — Pumpkin Blossom Farm` : 'Pumpkin Blossom Farm',
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        }],
        mode: 'payment',
        metadata: {
          invoiceNumber,
          invoiceId: data.invoiceId,
          invoiceType: data.invoiceType,
          accountId: inv.accountId || data.accountId || '',
        },
        success_url: 'https://purpl-crm.web.app/payment-success.html?inv=' + encodeURIComponent(invoiceNumber),
        cancel_url: 'https://purpl-crm.web.app/payment-success.html?cancelled=1&inv=' + encodeURIComponent(invoiceNumber),
      });
      return { ok: true, url: session.url, sessionId: session.id };
    } catch (err) {
      console.error('Stripe session error:', err.type, err.code, err.message);
      return {ok: false, error: 'Stripe: ' + (err.message || err.type || 'unknown error')};
    }
  }
);

// ── 9. Stripe Webhook ────────────────────────────────────
// Receives checkout.session.completed events and marks the invoice as paid.
exports.stripeWebhook = onRequest(
  {secrets: [stripeSecretKey, stripeWebhookSecret], invoker: 'public'},
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    const key = (process.env.STRIPE_SECRET_KEY || '').trim();
    const whSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!key || !whSecret) { res.status(500).send('Stripe not configured'); return; }

    const stripe = require('stripe')(key);
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody, req.headers['stripe-signature'], whSecret
      );
    } catch (err) {
      console.warn('Stripe webhook signature failed:', err.message);
      await recordWebhookHealth('stripe', false, 'signature verification failed');
      res.status(400).send('Invalid signature');
      return;
    }
    await recordWebhookHealth('stripe', true, 'event received');

    if (event.type !== 'checkout.session.completed') {
      res.status(200).send('ignored');
      return;
    }

    const session = event.data.object;
    const meta = session.metadata || {};
    const invoiceId = meta.invoiceId;
    const invoiceType = meta.invoiceType || 'retail';

    if (!invoiceId) {
      res.status(200).send('no invoice id');
      return;
    }

    try {
      const db = admin.firestore();
      const now = new Date().toISOString();

      // Idempotency: skip if this Stripe event was already processed
      const eventRef = db.collection('workspace/main/audit_log');
      const alreadyProcessed = await eventRef
        .where('stripeEventId', '==', event.id).limit(1).get();
      if (!alreadyProcessed.empty) {
        res.status(200).send('already processed');
        return;
      }

      const paidData = {
        status: 'paid',
        paidDate: etDate(),
        paidAt: now,
        paidVia: 'stripe',
        stripeSessionId: session.id,
        stripePaymentIntent: session.payment_intent,
        // Amount actually charged (dollars). Pay links embed a fixed amount at
        // send time — if the invoice was edited afterwards, the customer pays
        // the OLD figure. Record it and flag a mismatch instead of silently
        // booking the invoice as fully paid at the new total.
        paidAmount: session.amount_total != null ? session.amount_total / 100 : null,
      };

      // Update the correct invoice collection based on type. 'iv' is the
      // legacy purpl invoice collection — payInvoice emits it as the metadata
      // type when the doc matched there; without this key those payments fell
      // to colMap.retail, the update threw (doc not in retail_invoices), and
      // the iv fallback below never ran because invoiceType wasn't 'retail':
      // customer paid, invoice stayed open.
      const colMap = {
        retail: 'workspace/main/retail_invoices',
        lf: 'workspace/main/lf_invoices',
        combined: 'workspace/main/combined_invoices',
        dist: 'workspace/main/dist_invoices',
        iv: 'workspace/main/iv',
      };
      const colPath = colMap[invoiceType] || colMap.retail;
      try {
        if (paidData.paidAmount != null) {
          try {
            const invSnap = await db.doc(`${colPath}/${invoiceId}`).get();
            if (invSnap.exists) {
              const d = invSnap.data();
              const curTotal = parseFloat(d.grandTotal != null ? d.grandTotal : (d.total != null ? d.total : d.amount)) || 0;
              if (curTotal > 0 && Math.abs(curTotal - paidData.paidAmount) > 0.01) {
                paidData.paidAmountMismatch = true;
                paidData.notes = ((d.notes || '') + `\n⚠ Stripe payment $${paidData.paidAmount.toFixed(2)} differs from invoice total $${curTotal.toFixed(2)} — pay link may predate an edit.`).trim();
                await db.collection('workspace/main/audit_log').add({
                  timestamp: now, action: 'paid_amount_mismatch',
                  entityType: invoiceType + '_invoice', entityId: invoiceId,
                  detail: `paid $${paidData.paidAmount.toFixed(2)} vs total $${curTotal.toFixed(2)}`,
                });
              }
            }
          } catch (cmpErr) { console.warn('paid-amount compare failed:', cmpErr.message); }
        }
        await db.doc(`${colPath}/${invoiceId}`).update(paidData);
      } catch (updateErr) {
        // Cross-collection recovery before declaring the payment orphaned:
        // retail↔iv are the same brand's two homes (legacy vs current), so a
        // stale/wrong type hint must not orphan a real payment.
        let recovered = false;
        const altPaths = invoiceType === 'retail' ? ['workspace/main/iv']
          : invoiceType === 'iv' ? ['workspace/main/retail_invoices']
          : [];
        for (const alt of altPaths) {
          try {
            await db.doc(`${alt}/${invoiceId}`).update(paidData);
            recovered = true;
            break;
          } catch (e2) { /* fall through */ }
        }
        if (!recovered) {
          // Invoice was deleted before payment completed — ack the webhook so
          // Stripe stops retrying, but record the orphan payment in the audit log.
          console.warn(`Stripe payment for missing invoice ${invoiceType}/${invoiceId}:`, updateErr.message);
          await db.collection('workspace/main/audit_log').add({
            timestamp: now,
            action: 'paid_orphan',
            entityType: invoiceType + '_invoice',
            entityId: invoiceId,
            entityName: meta.invoiceNumber || '',
            changedBy: 'stripe',
            changedByEmail: 'stripe-webhook',
            stripeSessionId: session.id,
            note: 'Payment received for an invoice that no longer exists',
          }).catch(() => {});
          res.status(200).send('invoice not found — payment logged');
          return;
        }
      }

      // If combined, also mark the child invoices as paid. Strip the
      // parent-specific mismatch fields first — paidData.notes is the PARENT's
      // notes+warning and would overwrite each child's own notes.
      if (invoiceType === 'combined') {
        if (paidData.paidAmountMismatch) {
          delete paidData.notes;
          delete paidData.paidAmountMismatch;
        }
        const combSnap = await db.doc(`${colPath}/${invoiceId}`).get();
        if (combSnap.exists) {
          const comb = combSnap.data();
          if (comb.purplInvoiceId) {
            // MED-1: the purpl child may be a legacy iv record (createCombinedInvoice
            // supports purpl children in iv). Mirror markCombinedPaid: try
            // retail_invoices, fall back to iv. Don't silently swallow both —
            // log an orphan so overstated receivables are traceable.
            await db.doc(`workspace/main/retail_invoices/${comb.purplInvoiceId}`).update(paidData)
              .catch(async () => {
                await db.doc(`workspace/main/iv/${comb.purplInvoiceId}`).update(paidData)
                  .catch(() => console.warn(`Combined paid: purpl child ${comb.purplInvoiceId} not found in retail_invoices or iv`));
              });
          }
          if (comb.lfInvoiceId) {
            await db.doc(`workspace/main/lf_invoices/${comb.lfInvoiceId}`).update(paidData).catch(() => {});
          }
        }
      }

      // Log to audit (includes stripeEventId for idempotency)
      await db.collection('workspace/main/audit_log').add({
        timestamp: now,
        action: 'paid',
        entityType: invoiceType + '_invoice',
        entityId: invoiceId,
        entityName: meta.invoiceNumber || '',
        changedBy: 'stripe',
        changedByEmail: 'stripe-webhook',
        stripeSessionId: session.id,
        stripeEventId: event.id,
      });

      res.status(200).send('ok');
    } catch (err) {
      console.error('Stripe webhook processing error:', err);
      res.status(500).send('error');
    }
  }
);


// ── 10. ShipStation: Push Order ──────────────────────────
// Creates an order in ShipStation when an invoice is marked "Ship".
// Returns {ok, orderId, orderNumber} or {ok:false, error}.
exports.pushToShipStation = onCall(
  {secrets: [shipStationApiKey]},
  async (request) => {
    if (!request.auth) return {ok: false, error: 'Not signed in'};
    const data = request.data || {};
    if (!data.invoiceNumber || !data.shipTo) return {ok: false, error: 'Missing invoice number or shipping address'};
    if (!data.items || !data.items.length) return {ok: false, error: 'No line items to ship'};

    const key = (process.env.SHIPSTATION_API_KEY || '').trim();
    if (!key) return {ok: false, error: 'SHIPSTATION_API_KEY not set. Run: firebase functions:secrets:set SHIPSTATION_API_KEY'};

    // ShipStation V1 API uses Basic auth: base64(apiKey:apiSecret)
    // If the key contains a colon it's key:secret format; otherwise treat whole string as key with empty secret
    const authVal = key.includes(':') ? key : key + ':';
    const authHeader = 'Basic ' + Buffer.from(authVal).toString('base64');

    const orderPayload = {
      orderNumber: data.invoiceNumber,
      // orderKey makes /orders/createorder idempotent — ShipStation updates
      // the existing order instead of creating a duplicate shipment when the
      // same invoice is pushed twice.
      orderKey: 'inv-' + (data.invoiceId || data.invoiceNumber),
      orderDate: new Date().toISOString(),
      orderStatus: 'awaiting_shipment',
      customerEmail: data.customerEmail || '',
      billTo: {
        name: data.accountName || data.shipTo.name || '',
        street1: data.shipTo.street1 || '',
        street2: data.shipTo.street2 || '',
        city: data.shipTo.city || '',
        state: data.shipTo.state || '',
        postalCode: data.shipTo.zip || '',
        country: 'US',
        phone: data.shipTo.phone || '',
      },
      shipTo: {
        name: data.shipTo.name || data.accountName || '',
        street1: data.shipTo.street1 || '',
        street2: data.shipTo.street2 || '',
        city: data.shipTo.city || '',
        state: data.shipTo.state || '',
        postalCode: data.shipTo.zip || '',
        country: 'US',
        phone: data.shipTo.phone || '',
      },
      items: (data.items || []).map(it => ({
        sku: it.sku || '',
        name: it.name || it.sku || 'Item',
        quantity: it.quantity || 1,
        unitPrice: it.unitPrice || 0,
      })),
      customField1: data.invoiceNumber || '',
      customField2: data.accountName || '',
      customField3: data.brand || 'PBF Wholesale',
      internalNotes: data.notes || '',
      requestedShippingService: data.shippingService || '',
    };
    if (data.storeId && !isNaN(parseInt(data.storeId))) {
      orderPayload.advancedOptions = { storeId: parseInt(data.storeId) };
    }

    try {
      const _ac1 = new AbortController(); const _t1 = setTimeout(() => _ac1.abort(), 30000);
      const resp = await fetch('https://ssapi.shipstation.com/orders/createorder', {
        method: 'POST',
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload),
        signal: _ac1.signal,
      }); clearTimeout(_t1);
      const body = await resp.json();
      if (!resp.ok) {
        console.error('ShipStation createorder error:', resp.status, JSON.stringify(body));
        return {ok: false, error: 'ShipStation ' + resp.status + ': ' + (body.ExceptionMessage || body.Message || JSON.stringify(body))};
      }
      return {ok: true, orderId: body.orderId, orderNumber: body.orderNumber || data.invoiceNumber};
    } catch (e) {
      console.error('ShipStation push failed:', e.message);
      return {ok: false, error: 'Network error: ' + e.message};
    }
  }
);

// ── 11. ShipStation: Connection Test ─────────────────────
exports.shipStationStatus = onCall(
  {secrets: [shipStationApiKey]},
  async (request) => {
    if (!request.auth) return {ok: false, error: 'Not signed in'};
    const key = (process.env.SHIPSTATION_API_KEY || '').trim();
    if (!key) return {ok: false, error: 'SHIPSTATION_API_KEY not set'};
    const authVal = key.includes(':') ? key : key + ':';
    const authHeader = 'Basic ' + Buffer.from(authVal).toString('base64');
    try {
      const _ac2 = new AbortController(); const _t2 = setTimeout(() => _ac2.abort(), 15000);
      const resp = await fetch('https://ssapi.shipstation.com/stores', {
        headers: { 'Authorization': authHeader },
        signal: _ac2.signal,
      }); clearTimeout(_t2);
      if (!resp.ok) {
        const body = await resp.text();
        return {ok: false, error: 'ShipStation ' + resp.status + ': ' + body.slice(0, 200)};
      }
      const stores = await resp.json();
      return {ok: true, stores: (stores || []).map(st => ({id: st.storeId, name: st.storeName}))};
    } catch (e) {
      return {ok: false, error: 'Network error: ' + e.message};
    }
  }
);

// ── 12. ShipStation: Webhook (tracking + shipping cost sync) ──
// ShipStation posts {resource_url, resource_type} when orders ship.
// Fetches the shipment details, extracts tracking + shipping cost,
// adds a Shipping line item to the invoice, recalculates total,
// updates dates, and sets readyToSend so the CRM notifies the user.
exports.shipStationWebhook = onRequest(
  {secrets: [shipStationApiKey, resendApiKey], invoker: 'public'},
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
    try {
      // TB-1 FIX: validate shared secret before processing
      const webhookSecret = req.query.secret || '';
      const expectedSecret = (process.env.SHIPSTATION_API_KEY || '').trim().slice(-8);
      if (!webhookSecret || webhookSecret !== expectedSecret) {
        console.warn('ShipStation webhook: invalid or missing secret');
        await recordWebhookHealth('shipstation', false, webhookSecret ? 'wrong secret' : 'missing ?secret= on the webhook URL');
        res.status(403).send('Forbidden');
        return;
      }
      await recordWebhookHealth('shipstation', true, 'event received');

      const payload = req.body || {};
      const resourceUrl = payload.resource_url;
      if (!resourceUrl) { res.status(200).send('no resource_url'); return; }

      // TB-1 FIX: validate resource_url origin before sending credentials
      if (!resourceUrl.startsWith('https://ssapi.shipstation.com/')) {
        console.warn('ShipStation webhook: rejected non-ShipStation resource_url:', resourceUrl);
        res.status(400).send('Invalid resource_url origin');
        return;
      }

      const key = (process.env.SHIPSTATION_API_KEY || '').trim();
      const authVal = key.includes(':') ? key : key + ':';
      const authHeader = 'Basic ' + Buffer.from(authVal).toString('base64');

      const _ac3 = new AbortController(); const _t3 = setTimeout(() => _ac3.abort(), 20000);
      const resp = await fetch(resourceUrl, { headers: { 'Authorization': authHeader }, signal: _ac3.signal });
      clearTimeout(_t3);
      if (!resp.ok) { console.warn('ShipStation webhook resource fetch failed:', resp.status); res.status(200).send('fetch failed'); return; }
      const data = await resp.json();

      const shipments = data.shipments || (data.trackingNumber ? [data] : []);
      const db = admin.firestore();

      // Group shipments by orderNumber (multiple boxes = multiple tracking numbers)
      const byOrder = {};
      for (const ship of shipments) {
        const on = ship.orderNumber || '';
        if (!on) continue;
        if (!byOrder[on]) byOrder[on] = { trackingNumbers: [], carriers: [], totalShipCost: 0 };
        if (ship.trackingNumber) byOrder[on].trackingNumbers.push(ship.trackingNumber);
        byOrder[on].carriers.push(ship.carrierCode || ship.serviceCode || '');
        byOrder[on].totalShipCost += parseFloat(ship.shipmentCost || ship.shipment_cost || 0)
                                   + parseFloat(ship.insuranceCost || ship.insurance_cost || 0);
      }

      const now = new Date().toISOString();
      const shipDate = etDate();

      for (const [orderNumber, info] of Object.entries(byOrder)) {
        if (!info.trackingNumbers.length) continue;
        const trackingStr = info.trackingNumbers.join(', ');
        const carrierStr  = [...new Set(info.carriers.filter(Boolean))].join(', ');
        const shipCost    = Math.round(info.totalShipCost * 100) / 100;

        // ── Sample box shipments (SAMPLE- prefix) ─────────────
        if (orderNumber.startsWith('SAMPLE-')) {
          // Find the account that has this sample order number
          const acSnap = await db.collection('workspace/main/ac').get();
          let sampleFound = false;
          for (const acDoc of acSnap.docs) {
            const ac = acDoc.data();
            const samples = ac.samples || [];
            const sampleIdx = samples.findIndex(s => s.sampleOrderNumber === orderNumber);
            if (sampleIdx >= 0) {
              sampleFound = true;
              // M16: re-read + write the account inside a transaction so a
              // concurrent edit to samples[] isn't clobbered (the previous
              // whole-array overwrite was a lost-update race). The idempotency
              // check (already-shipped) runs atomically inside the tx.
              let newlyShipped = false;
              await db.runTransaction(async (tx) => {
                const fresh = await tx.get(acDoc.ref);
                const fsamples = (fresh.data() || {}).samples || [];
                const idx = fsamples.findIndex(s => s.sampleOrderNumber === orderNumber);
                if (idx < 0 || fsamples[idx].status === 'shipped') return;
                fsamples[idx] = {
                  ...fsamples[idx],
                  trackingNumber: trackingStr,
                  carrier: carrierStr,
                  shippedAt: now,
                  status: 'shipped',
                };
                tx.update(acDoc.ref, { samples: fsamples });
                newlyShipped = true;
              });
              // Already shipped (idempotent redelivery) — don't re-deduct/re-email.
              if (!newlyShipped) break;

              // Deduct 3 cans of Classic from farm pool
              await db.collection('workspace/main/iv').add({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2),
                date: shipDate,
                sku: 'classic',
                type: 'out',
                qty: 3,
                pool: 'farm',
                note: 'Sample box shipped: ' + orderNumber,
                sampleOrderNumber: orderNumber,
              });

              // Send sample-shipped confirmation email to the account
              const email = ac.email;
              if (email) {
                const {Resend} = require('resend');
                const resend = new Resend(process.env.RESEND_API_KEY);
                const contactName = (ac.contacts && ac.contacts.length) ? (ac.contacts[0].name || 'there') : 'there';
                const sampleHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:#4D2A6F;background:linear-gradient(135deg,#4D2A6F 0%,#7A5C9E 100%);padding:32px 40px;text-align:center">
    <table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
      <td valign="middle" style="padding-right:16px"><img src="https://purpl-crm.web.app/images/purpl-wordmark-white.png" alt="purpl" width="170" height="65" style="display:block"></td>
      <td valign="middle" style="padding:0 16px"><div style="width:1px;height:44px;background:rgba(255,255,255,0.5)"></div></td>
      <td valign="middle"><img src="https://purpl-crm.web.app/images/lf-logo-white.png" alt="Lavender Fields" width="84" height="78" style="display:block"></td>
    </tr></table>
    <div style="font-size:10px;color:rgba(255,255,255,0.9);letter-spacing:0.15em;text-transform:uppercase;margin-top:10px">Pumpkin Blossom Farm · Wholesale</div>
  </td></tr>
  <tr><td style="background:#B3C8C1;height:4px"></td></tr>
  <tr><td style="padding:32px 40px;font-size:15px;color:#1a1a2e;line-height:1.7">
    <p>Hi ${escHtml(contactName)},</p>
    <p>Your <strong>purpl sample box</strong> is on its way! Here are the details:</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0">
      <tr><td style="padding:16px 20px;background:#faf5ff;border-radius:8px;border:1px solid #e9d5ff">
        <div style="font-size:13px;color:#6b7280;margin-bottom:8px"><strong>What's inside:</strong> 3 cans of Classic Lavender Lemonade</div>
        <div style="font-size:13px;color:#6b7280;margin-bottom:8px"><strong>Carrier:</strong> ${escHtml(carrierStr || 'See tracking link')}</div>
        <div style="font-size:13px;color:#6b7280"><strong>Tracking:</strong> ${escHtml(trackingStr)}</div>
      </td></tr>
    </table>
    <p>We hope you love it! Once you've tried it, we'd love to hear what you think — and when you're ready to order, your personalized portal link is below.</p>
    ${ac.orderPortalToken ? `
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0">
      <tr><td align="center">
        <a href="https://pbfwholesale.com/order?t=${ac.orderPortalToken}" style="display:inline-block;background:#7B4FA0;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">Place Your First Order →</a>
      </td></tr>
    </table>` : ''}
    <p>Warmly,<br><strong>Graham Biagiotti</strong><br>Pumpkin Blossom Farm</p>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:16px 40px;text-align:center;font-size:11px;color:#6b7280">
    Pumpkin Blossom Farm LLC · 393 Pumpkin Hill Rd · Warner, NH 03278<br>
    lavender@pbfwholesale.com · 603-748-3038
  </td></tr>
</table></td></tr></table></body></html>`;
                try {
                  await resend.emails.send({
                    from: 'lavender@pbfwholesale.com',
                    to: email,
                    subject: 'Your purpl sample box has shipped!',
                    html: sampleHtml,
                  });
                } catch (emailErr) {
                  console.warn('Sample confirmation email failed:', emailErr.message);
                }
              }

              // Audit log
              await db.collection('workspace/main/audit_log').add({
                timestamp: now, action: 'sample_shipped',
                entityType: 'account', entityId: acDoc.id,
                entityName: ac.name || '', changedBy: 'shipstation',
                changedByEmail: 'shipstation-webhook',
                trackingNumber: trackingStr, carrier: carrierStr,
              });
              break;
            }
          }
          if (!sampleFound) {
            console.warn('Sample shipment orphaned — no matching account:', orderNumber);
            await db.collection('workspace/main/audit_log').add({
              timestamp: now, action: 'sample_orphaned',
              entityType: 'shipment', entityName: orderNumber,
              changedBy: 'shipstation', changedByEmail: 'shipstation-webhook',
              trackingNumber: trackingStr, carrier: carrierStr,
              note: 'ShipStation shipped a sample box but no matching account record was found',
            }).catch(() => {});
          }
          continue; // Don't process sample orders as invoice orders
        }

        // ── Regular invoice shipments ─────────────────────────
        // Find the invoice by number across all collections. Match on
        // `number` OR `invoiceNumber` — delivery-run invoices store only
        // invoiceNumber, so their shipments never matched (tracking + the
        // shipping charge were silently lost).
        // 'iv' is the legacy purpl invoice collection — without it, shipments
        // for legacy invoices fell to shipstation_unmatched and the tracking
        // number + shipping charge were silently lost.
        const cols = ['retail_invoices', 'lf_invoices', 'combined_invoices', 'iv'];
        let _matched = false;
        for (const col of cols) {
          let snap = await db.collection('workspace/main/' + col)
            .where('number', '==', orderNumber).limit(1).get();
          if (snap.empty) {
            snap = await db.collection('workspace/main/' + col)
              .where('invoiceNumber', '==', orderNumber).limit(1).get();
          }
          if (!snap.empty) {
            _matched = true;
            const doc = snap.docs[0];
            const inv = doc.data();

            // Build the update: tracking, carrier, dates, shipping line item
            const existingItems = inv.lineItems || [];
            // Remove any previous Shipping line item (idempotent for webhook retries)
            const itemsNoShip = existingItems.filter(li => li.skuId !== '__shipping__');

            const shippingLine = shipCost > 0 ? {
              skuId: '__shipping__',
              skuName: 'Shipping',
              sku: 'Shipping',
              description: carrierStr ? ('Shipping via ' + carrierStr) : 'Shipping',
              cases: 1, qty: 1, units: 1,
              pricePerCase: shipCost,
              unitPrice: shipCost,
              lineTotal: shipCost,
              total: shipCost,
            } : null;

            const updatedItems = shippingLine ? [...itemsNoShip, shippingLine] : itemsNoShip;
            const newTotal = Math.round(updatedItems.reduce((s, li) => {
              // delivery-run lines store their money in 'amount' (and legacy shapes in cases*pricePerCase);
              // summing only lineTotal||total zeroed the product dollars and clobbered the invoice total to shipping-only
              const v = li.lineTotal != null ? li.lineTotal : (li.total != null ? li.total : (li.amount != null ? li.amount : ((parseFloat(li.cases) || 0) * (parseFloat(li.pricePerCase) || 0))));
              return s + (parseFloat(v) || 0);
            }, 0) * 100) / 100;

            // Combined-family members get NO money writes here — shipping for
            // a combined parent or child is managed exclusively by the
            // provenance map below (writing a shipping line onto a child, or
            // replacing a parent's lines here, was the source of double-count
            // and legacy-child-zeroing bugs). Single invoices keep the
            // replace-line semantics unchanged.
            const isCombinedFamily = col === 'combined_invoices' || !!inv.combinedInvoiceId;
            const update = {
              trackingNumber: trackingStr,
              carrier: carrierStr,
              deliveryMethod: 'ship',
            };
            if (!isCombinedFamily) update.lineItems = updatedItems;
            // readyToSend is a "draft is ready — go send it" nudge. If the
            // invoice was already sent/paid (owner sent first, label came
            // after), setting it would pulse a stale badge nothing clears.
            if (!['sent', 'paid', 'void'].includes(inv.status)) update.readyToSend = true;
            // M7: set the financial dates (issued/date and the Net-X dueDate)
            // ONLY on the first shipment event. ShipStation re-delivers webhooks
            // (on non-2xx and operator replays); without this guard every
            // redelivery reset issued/date to the redelivery day and pushed
            // dueDate forward another full terms window, silently aging the
            // invoice. Tracking/carrier/shipping line stay idempotently updated.
            if (!inv.shippedAt) {
              const configSnap = await db.doc('workspace/main/config/main').get();
              const configData = configSnap.exists ? configSnap.data() : {};
              const terms = (configData.invoice_settings || {}).terms || (configData.settings || {}).payment_terms || 30;
              const dueDate = etDate(Date.now() + terms * 86400000);
              update.shippedAt = now;
              update.date = shipDate;
              update.issued = shipDate;
              update.dueDate = dueDate;
              update.due = dueDate;
            }
            // Update total on the right field(s) — single invoices only; the
            // family block below owns all combined money.
            if (!isCombinedFamily) {
              update.total = newTotal;
              update.amount = newTotal;
            }

            await doc.ref.update(update);

            // ── Combined-family shipping with PROVENANCE ─────────────────
            // The parent carries `shippingByOrder`: {ssOrderNumber: cost,
            // 'manual': estimate, 'moved-<childId>': migrated legacy line}.
            // Each webhook event REPLACES its own key (redelivery-idempotent);
            // distinct shipments SUM; the first real charge deletes 'manual'
            // (actual replaces estimate). The rendered state derives from the
            // map: ONE __shipping__ line on the parent, product-only children,
            // grandTotal = product subtotals + sum(map). This keeps
            // _syncCombinedParentForChild's invariant (extra = grand - subs).
            const familyParentId = col === 'combined_invoices' ? doc.id : inv.combinedInvoiceId;
            if (familyParentId) {
              try {
                const r2 = n => Math.round(n * 100) / 100;
                const shipOf = items => (items || []).filter(li => li.skuId === '__shipping__')
                  .reduce((s, li) => s + (parseFloat(li.lineTotal != null ? li.lineTotal : li.total) || 0), 0);
                const lineVal = li => parseFloat(li.lineTotal != null ? li.lineTotal : (li.total != null ? li.total : (li.amount != null ? li.amount : ((parseFloat(li.cases) || 0) * (parseFloat(li.pricePerCase) || 0))))) || 0;
                const parentRef = db.doc('workspace/main/combined_invoices/' + familyParentId);
                const parentSnap = await parentRef.get();
                if (parentSnap.exists) {
                  const p = parentSnap.data();
                  const readChild = async (id, prefer) => {
                    if (!id) return null;
                    for (const c of prefer) {
                      const s = await db.doc('workspace/main/' + c + '/' + id).get();
                      if (s.exists) return { ref: s.ref, data: s.data() };
                    }
                    return null;
                  };
                  const pc = await readChild(p.purplInvoiceId, ['retail_invoices', 'iv']);
                  const lc = await readChild(p.lfInvoiceId, ['lf_invoices']);

                  // Build the map. Seed 'manual' once from a pre-map parent line.
                  const map = { ...(p.shippingByOrder || {}) };
                  if (!p.shippingByOrder && shipOf(p.lineItems) > 0) map['manual'] = r2(shipOf(p.lineItems));
                  // Migrate legacy child-homed shipping lines into keyed entries
                  // (idempotent: same key, same value) - ONLY when the child
                  // also has product lines; a lineItems-less child is left
                  // strictly untouched.
                  const childPatches = [];
                  const matchedChildId = col !== 'combined_invoices' ? doc.id : null;
                  for (const child of [pc, lc]) {
                    if (!child) continue;
                    const items = child.data.lineItems || [];
                    const s = shipOf(items);
                    if (s > 0 && items.some(li => li.skuId !== '__shipping__')) {
                      // The MATCHED child's existing line is THIS order's old
                      // charge under the pre-provenance code — the event key
                      // supersedes it (strip, don't migrate, or the same
                      // charge counts twice). Sibling lines are other orders'
                      // charges and migrate under their own keys.
                      if (child.ref.id !== matchedChildId) map['moved-' + child.ref.id] = r2(s);
                      const prod = items.filter(li => li.skuId !== '__shipping__');
                      const prodTotal = r2(prod.reduce((t, li) => t + lineVal(li), 0));
                      childPatches.push({ ref: child.ref, patch: { lineItems: prod, total: prodTotal, amount: prodTotal } });
                      child.data = { ...child.data, lineItems: prod, total: prodTotal, amount: prodTotal };
                    }
                  }
                  // This event's charge replaces its own key.
                  if (shipCost > 0 && orderNumber) map[String(orderNumber)] = r2(shipCost);
                  // The event key supersedes any migrated key an EARLIER event
                  // created for this same child (same charge, two keys —
                  // otherwise a plain redelivery against a legacy family
                  // double-counts permanently).
                  if (matchedChildId) delete map['moved-' + matchedChildId];
                  // First real charge supersedes the manual estimate.
                  if (map['manual'] != null && Object.keys(map).some(k => k !== 'manual')) delete map['manual'];

                  const familyShip = r2(Object.values(map).reduce((s, v) => s + (parseFloat(v) || 0), 0));
                  const subOf = child => child ? (parseFloat(child.data.total != null ? child.data.total : child.data.amount) || 0) : null;
                  const purplSub = subOf(pc) != null ? subOf(pc) : (parseFloat(p.purplSubtotal) || 0);
                  const lfSub = subOf(lc) != null ? subOf(lc) : (parseFloat(p.lfSubtotal) || 0);
                  const parentNonShip = (p.lineItems || []).filter(li => li.skuId !== '__shipping__');

                  // Parent (the money) writes FIRST; child strips after - a
                  // failure between them leaves shipping counted, never lost.
                  await parentRef.update({
                    shippingByOrder: map,
                    purplSubtotal: purplSub,
                    lfSubtotal: lfSub,
                    grandTotal: r2(purplSub + lfSub + familyShip),
                    lineItems: familyShip > 0
                      ? [...parentNonShip, { skuId: '__shipping__', skuName: 'Shipping', sku: 'Shipping', description: carrierStr ? ('Shipping via ' + carrierStr) : 'Shipping', cases: 1, qty: 1, units: 1, pricePerCase: familyShip, unitPrice: familyShip, lineTotal: familyShip, total: familyShip }]
                      : parentNonShip,
                  });
                  for (const cp of childPatches) await cp.ref.update(cp.patch);
                }
              } catch (syncErr) {
                console.warn('combined family shipping sync failed:', syncErr.message);
                await db.collection('workspace/main/audit_log').add({
                  timestamp: now, action: 'combined_ship_sync_failed',
                  entityType: 'combined_invoice', entityId: familyParentId,
                  entityName: orderNumber, changedBy: 'shipstation',
                  note: 'Shipping recorded on the shipment but combined totals may need a Preview re-save: ' + syncErr.message,
                }).catch(() => {});
              }
            }

            // Audit log
            await db.collection('workspace/main/audit_log').add({
              timestamp: now,
              action: 'shipped',
              entityType: col.replace('_invoices', '') + '_invoice',
              entityId: doc.id,
              entityName: orderNumber,
              changedBy: 'shipstation',
              changedByEmail: 'shipstation-webhook',
              trackingNumber: trackingStr,
              carrier: carrierStr,
              shippingCost: shipCost,
            });
            break;
          }
        }
        // No invoice matched this shipment — leave a visible trace instead of
        // silently dropping the tracking number + shipping charge.
        if (!_matched) {
          await db.collection('workspace/main/audit_log').add({
            timestamp: new Date().toISOString(), action: 'shipstation_unmatched',
            entityType: 'shipment', entityId: orderNumber,
            detail: `ShipStation shipment for order "${orderNumber}" matched no invoice (number/invoiceNumber) — tracking + shipping charge not recorded`,
          }).catch(() => {});
        }
      }
      res.status(200).send('ok');
    } catch (e) {
      // Still ACK (ShipStation retries otherwise) but leave an audit trail —
      // every failure used to be a silent no-op.
      console.error('ShipStation webhook error:', e.message);
      try {
        await admin.firestore().collection('workspace/main/audit_log').add({
          timestamp: new Date().toISOString(), action: 'shipstation_webhook_error',
          entityType: 'shipment', entityId: '', detail: String(e.message || e).slice(0, 500),
        });
      } catch (_) {}
      res.status(200).send('error logged');
    }
  }
);

// ═══════════════════════════════════════════════════════════
// In-Store Sampling (Demo Days) — docs/sampling-spec.md
// New surface only: one top-level collection (sampling_requests),
// nothing existing is read differently or written. purpl-only content,
// STANDARD email chrome.
// ═══════════════════════════════════════════════════════════

const SAMPLING_WINDOWS = {
  morning:   { label: 'Morning (10am–1pm)',  start: '100000', end: '130000' },
  midday:    { label: 'Midday (11am–2pm)',   start: '110000', end: '140000' },
  afternoon: { label: 'Afternoon (2–5pm)',   start: '140000', end: '170000' },
};
const SAMPLING_OPEN = ['pending_sampler', 'proposed_alt', 'needs_reschedule', 'confirmed'];

function _samplingTodayET() {
  // YYYY-MM-DD in Eastern time — same date-only discipline as the CRM.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function _samplingFmtDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return iso || '';
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// A request is "open" (blocks a new one) while it's undecided or confirmed
// for a FUTURE date. A past confirmed date frees the link for a rebooking
// without waiting on the owner to log the outcome.
function _samplingIsOpen(r) {
  if (!SAMPLING_OPEN.includes(r.status)) return false;
  if (r.status === 'confirmed') return (r.confirmedDate || '') >= _samplingTodayET();
  return true;
}

// Standard PBF email shell — identical chrome to every other system email.
function _samplingEmailShell(bodyHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
  style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:#4D2A6F;background:linear-gradient(135deg,#4D2A6F 0%,#7A5C9E 100%);padding:32px 40px;text-align:center">
    <table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
      <td valign="middle" style="padding-right:16px"><img src="https://purpl-crm.web.app/images/purpl-wordmark-white.png" alt="purpl" width="170" height="65" style="display:block"></td>
      <td valign="middle" style="padding:0 16px"><div style="width:1px;height:44px;background:rgba(255,255,255,0.5)"></div></td>
      <td valign="middle"><img src="https://purpl-crm.web.app/images/lf-logo-white.png" alt="Lavender Fields" width="84" height="78" style="display:block"></td>
    </tr></table>
    <div style="font-size:10px;color:rgba(255,255,255,0.9);letter-spacing:0.15em;text-transform:uppercase;margin-top:10px">Pumpkin Blossom Farm · Wholesale</div>
  </td></tr>
  <tr><td style="background:#B3C8C1;height:4px"></td></tr>
  <tr><td style="padding:32px 40px;font-size:15px;color:#1a1a2e;line-height:1.7">
${bodyHtml}
  </td></tr>
  <tr><td style="background:#f9fafb;padding:16px 40px;text-align:center;font-size:11px;color:#6b7280">
    Pumpkin Blossom Farm LLC · 393 Pumpkin Hill Rd · Warner, NH 03278<br>lavender@pbfwholesale.com
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// Minimal standalone page for the sampler's action links — giant buttons,
// plain language, nothing to log into.
function _samplingActionPage(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>
<style>body{margin:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif;color:#1a1a2e}
.card{max-width:520px;margin:40px auto;background:#fff;border-radius:12px;padding:32px 24px;box-shadow:0 2px 8px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 16px;color:#4D2A6F}
p{font-size:16px;line-height:1.6}
.btn{display:block;text-align:center;padding:18px 16px;margin:14px 0;border-radius:10px;font-size:17px;font-weight:700;text-decoration:none}
.yes{background:#4D2A6F;color:#fff}.no{background:#fff;color:#1a1a2e;border:2px solid #d1d5db}
.meta{background:#f9fafb;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.7;margin:16px 0}</style>
</head><body><div class="card">${bodyHtml}</div></body></html>`;
}

function _samplingIcs(reqId, r) {
  const w = SAMPLING_WINDOWS[r.timeWindow] || SAMPLING_WINDOWS.morning;
  const d = (r.confirmedDate || '').replace(/-/g, '');
  const now = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const escIcs = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const desc = [
    'Contact: ' + (r.contact?.name || '') + ' ' + (r.contact?.cell || ''),
    r.logistics?.table ? 'Table: ' + r.logistics.table : '',
    r.logistics?.power ? 'Power: ' + r.logistics.power : '',
    r.logistics?.parking ? 'Parking/load-in: ' + r.logistics.parking : '',
    r.logistics?.busyHours ? 'Busy hours: ' + r.logistics.busyHours : '',
    r.logistics?.notes ? 'Notes: ' + r.logistics.notes : '',
  ].filter(Boolean).join('\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PBF//purpl sampling//EN', 'BEGIN:VEVENT',
    'UID:sampling-' + reqId + '@pbfwholesale.com',
    'DTSTAMP:' + now,
    'DTSTART:' + d + 'T' + w.start,
    'DTEND:' + d + 'T' + w.end,
    'SUMMARY:' + escIcs('purpl demo day — ' + (r.accountName || '')),
    'LOCATION:' + escIcs(r.storeAddress || ''),
    'DESCRIPTION:' + escIcs(desc),
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

async function _samplingConfig() {
  const snap = await admin.firestore().collection('portal_settings').doc('sampling').get();
  const d = snap.exists ? snap.data() : {};
  return {
    samplerName: d.samplerName || '',
    samplerCell: d.samplerCell || '',
    samplerEmail: d.samplerEmail || '',
    leadDays: Number.isFinite(parseInt(d.leadDays)) ? parseInt(d.leadDays) : 7,
    blockedWeekdays: Array.isArray(d.blockedWeekdays) ? d.blockedWeekdays.map(Number) : [],
  };
}

function _samplingValidDate(iso, cfg) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return 'Please pick a date.';
  // Round-trip guard: "2026-13-45" passes the regex, beats the lead-time
  // string compare, and its NaN weekday dodges the blocklist.
  const dt = new Date(iso + 'T12:00:00Z');
  if (isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso) return 'Please pick a real date.';
  const today = _samplingTodayET();
  const min = new Date(new Date(today + 'T12:00:00').getTime() + cfg.leadDays * 864e5)
    .toISOString().slice(0, 10);
  if (iso < min) return 'Dates need at least ' + cfg.leadDays + ' days notice.';
  const wd = new Date(iso + 'T12:00:00').getDay();
  if (cfg.blockedWeekdays.includes(wd)) return 'That weekday is not available — please pick another day.';
  return null;
}

async function _samplingResolveAccount(token) {
  if (!token || typeof token !== 'string' || token.length < 5) return null;
  const db = admin.firestore();
  const acSnap = await db.collection('accounts').where('orderPortalToken', '==', token).limit(1).get();
  let acId = null, name = '', address = '', email = '';
  if (!acSnap.empty) {
    acId = acSnap.docs[0].id;
  } else {
    const wsSnap = await db.collection('workspace/main/ac').where('orderPortalToken', '==', token).limit(1).get();
    if (!wsSnap.empty) acId = wsSnap.docs[0].id;
  }
  if (!acId) return null;
  const wsDoc = await db.collection('workspace/main/ac').doc(acId).get();
  if (wsDoc.exists) {
    const d = wsDoc.data();
    name = d.name || ''; address = d.address || ''; email = d.email || '';
  }
  return { acId, name, address, email };
}

async function _samplingRequestsFor(acId) {
  const snap = await admin.firestore().collection('sampling_requests')
    .where('accountId', '==', acId).get();
  return snap.docs.map(d => ({ _id: d.id, ...d.data() }));
}

const SAMPLING_ACTION_BASE = 'https://pbfwholesale.com/sampling-action';

function _samplingPacketEmail(reqId, r) {
  const link = a => `${SAMPLING_ACTION_BASE}?r=${reqId}&k=${r.samplerActionToken}&a=${a}`;
  const btn = (href, txt, solid) =>
    `<div style="text-align:center;margin:12px 0"><a href="${href}" style="display:block;padding:18px 16px;border-radius:10px;font-size:17px;font-weight:700;text-decoration:none;${solid ? 'background:#4D2A6F;color:#ffffff' : 'background:#ffffff;color:#1a1a2e;border:2px solid #d1d5db'}">${txt}</a></div>`;
  const L = r.logistics || {};
  const body = `
    <p style="font-size:17px;font-weight:600;margin:0 0 16px">New demo request: ${escHtml(r.accountName)}</p>
    <div style="background:#f9fafb;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.8">
      📍 ${escHtml(r.storeAddress || '')}<br>
      👤 Day-of contact: ${escHtml(r.contact?.name || '')} — ${escHtml(r.contact?.cell || '')}<br>
      🕐 ${escHtml((SAMPLING_WINDOWS[r.timeWindow] || {}).label || r.timeWindow || '')}<br>
      ${L.table ? '🪑 Table: ' + escHtml(L.table) + '<br>' : ''}
      ${L.power ? '🔌 Power: ' + escHtml(L.power) + '<br>' : ''}
      ${L.parking ? '🚗 Parking/load-in: ' + escHtml(L.parking) + '<br>' : ''}
      ${L.busyHours ? '⏰ Their busy hours: ' + escHtml(L.busyHours) + '<br>' : ''}
      ${L.notes ? '📝 ' + escHtml(L.notes) : ''}
    </div>
    <p style="font-size:16px;font-weight:600;margin:20px 0 4px">Can you do one of these days?</p>
    ${btn(link('confirm1'), 'YES — ' + escHtml(_samplingFmtDate(r.date1)), true)}
    ${r.date2 ? btn(link('confirm2'), 'YES — ' + escHtml(_samplingFmtDate(r.date2)), true) : ''}
    ${btn(link('no'), "NO — neither day works", false)}
    <p style="font-size:13px;color:#6b7280">Tap one button and you're done — the store gets confirmed automatically.</p>`;
  return { subject: 'New demo request: ' + (r.accountName || 'a store'), html: _samplingEmailShell(body) };
}


// Confirm a request and notify both sides. Shared by the sampler's YES and
// the store's accept-of-proposed-date. Caller renders its own result page.
async function _samplingConfirmAndNotify(reqId, ref, rec, chosen, decidedBy) {
  const db = admin.firestore();
  const nowIso = new Date().toISOString();
  await ref.update({ status: 'confirmed', confirmedDate: chosen, confirmedAt: nowIso, decidedBy });
  const confirmed = { ...rec, status: 'confirmed', confirmedDate: chosen };
  const cfg = await _samplingConfig();
  const w = (SAMPLING_WINDOWS[rec.timeWindow] || {}).label || '';
  const ics = _samplingIcs(reqId, confirmed);
  const icsAttachment = { filename: 'purpl-demo-day.ics', content: Buffer.from(ics).toString('base64') };
  const dateLabel = _samplingFmtDate(chosen);
  const failures = [];
  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  // Store confirmation — the store's ONLY guaranteed email in the flow.
  let storeFallbackTo = rec.contact?.email || '';
  if (!storeFallbackTo) {
    const acDoc = await db.collection('workspace/main/ac').doc(rec.accountId).get();
    storeFallbackTo = acDoc.exists ? (acDoc.data().email || '') : '';
  }
  if (storeFallbackTo) {
    try {
      await resend.emails.send({
        from: 'lavender@pbfwholesale.com', to: storeFallbackTo,
        replyTo: 'graham@pumpkinblossomfarm.com',
        subject: `purpl demo day confirmed — ${dateLabel}`,
        html: _samplingEmailShell(`
          <p style="font-size:17px;font-weight:500;margin:0 0 16px">Hi ${escHtml(rec.contact?.name || 'there')},</p>
          <p>Your purpl in-store demo at <strong>${escHtml(rec.accountName)}</strong> is confirmed for <strong>${escHtml(dateLabel)}</strong> (${escHtml(w)}).</p>
          <div style="background:#f9fafb;border-left:3px solid #4D2A6F;padding:14px 16px;border-radius:0 6px 6px 0;font-size:14px;line-height:1.8">
            Our sampler ${escHtml(cfg.samplerName || '')} will arrive at the start of the window with everything needed — product, cups, ice, table.${cfg.samplerCell ? ' Day-of questions: ' + escHtml(cfg.samplerCell) + '.' : ''}
          </div>
          <p style="font-size:13px;color:#6b7280">A calendar invite is attached. Need to change the date? Just reply to this email.</p>`),
        attachments: [icsAttachment],
      });
    } catch (e) { console.error('Store confirmation failed:', e.message); failures.push('store'); }
  } else { failures.push('store-no-email'); }

  // Sampler confirmation + run details + print link.
  if (cfg.samplerEmail) {
    try {
      await resend.emails.send({
        from: 'lavender@pbfwholesale.com', to: cfg.samplerEmail,
        replyTo: 'graham@pumpkinblossomfarm.com',
        subject: `Booked: ${rec.accountName} — ${dateLabel}`,
        html: _samplingEmailShell(`
          <p style="font-size:17px;font-weight:600;margin:0 0 16px">Booked ✓ ${escHtml(rec.accountName)} — ${escHtml(dateLabel)}</p>
          <div style="background:#f9fafb;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.8">
            📍 ${escHtml(rec.storeAddress || '')}<br>
            👤 ${escHtml(rec.contact?.name || '')} — ${escHtml(rec.contact?.cell || '')}<br>
            🕐 ${escHtml(w)}
          </div>
          <div style="text-align:center;margin:20px 0"><a href="${SAMPLING_ACTION_BASE}?r=${reqId}&k=${rec.samplerActionToken}&a=sheet" style="display:block;padding:18px 16px;border-radius:10px;font-size:17px;font-weight:700;text-decoration:none;background:#4D2A6F;color:#ffffff">🖨 Print demo sheet</a></div>
          <p style="font-size:13px;color:#6b7280">Calendar invite attached. You'll get a reminder with the full run sheet 2 days before.</p>`),
        attachments: [icsAttachment],
      });
    } catch (e) { console.error('Sampler confirmation failed:', e.message); failures.push('sampler'); }
  }

  if (failures.length) await ref.update({ confirmEmailFailures: failures }).catch(() => {});
  await _logCadenceEntry(rec.accountId, { stage: 'sampling_scheduled', subject: 'Demo day confirmed: ' + chosen });
  return { dateLabel, failures };
}

// ── Store submit + status check (public callable, token-gated) ──
exports.submitSamplingRequest = onCall(
  { secrets: [resendApiKey] },
  async (request) => {
    const data = request.data || {};
    const acct = await _samplingResolveAccount(data.token);
    if (!acct) throw new HttpsError('permission-denied', 'This link is not valid.');

    const all = await _samplingRequestsFor(acct.acId);
    const open = all.find(_samplingIsOpen) || null;
    // newest first for prefill
    all.sort((a, b) => (b.createdAt || '') < (a.createdAt || '') ? -1 : 1);
    const last = all[0] || null;

    if (data.check) {
      const cfg = await _samplingConfig();
      return {
        accountName: acct.name,
        storeAddress: acct.address,
        leadDays: cfg.leadDays,
        blockedWeekdays: cfg.blockedWeekdays,
        open: open ? {
          status: open.status, date1: open.date1, date2: open.date2,
          confirmedDate: open.confirmedDate || null,
          confirmedDateLabel: open.confirmedDate ? _samplingFmtDate(open.confirmedDate) : null,
          altDateLabel: open.altDate ? _samplingFmtDate(open.altDate) : null,
        } : null,
        prefill: last ? { contact: last.contact || null, logistics: last.logistics || null } : null,
      };
    }

    if (open) throw new HttpsError('already-exists', 'You already have a demo request in progress.');

    const cfg = await _samplingConfig();
    if (!cfg.samplerEmail) {
      throw new HttpsError('failed-precondition',
        'Demo scheduling is not set up yet — please email lavender@pbfwholesale.com.');
    }

    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    const contact = {
      name: str(data.contactName, 120), cell: str(data.contactCell, 40), email: str(data.contactEmail, 200),
    };
    if (!contact.name || !contact.cell) throw new HttpsError('invalid-argument', 'Contact name and cell are required.');
    const date1 = str(data.date1, 10);
    const date2 = str(data.date2, 10);
    let err = _samplingValidDate(date1, cfg);
    if (err) throw new HttpsError('invalid-argument', err);
    if (date2) {
      err = _samplingValidDate(date2, cfg);
      if (err) throw new HttpsError('invalid-argument', 'Backup date: ' + err);
      if (date2 === date1) throw new HttpsError('invalid-argument', 'Backup date must be a different day.');
    }
    const timeWindow = SAMPLING_WINDOWS[data.timeWindow] ? data.timeWindow : 'morning';

    const rec = {
      accountId: acct.acId,
      accountName: acct.name,
      storeAddress: str(data.storeAddress, 300) || acct.address,
      contact,
      date1, date2: date2 || null, timeWindow,
      logistics: {
        table: str(data.table, 300), power: str(data.power, 60),
        parking: str(data.parking, 500), busyHours: str(data.busyHours, 200),
        notes: str(data.notes, 2000),
      },
      status: 'pending_sampler',
      samplerActionToken: require('crypto').randomBytes(24).toString('hex'),
      createdAt: new Date().toISOString(),
      source: 'portal-link',
    };
    const ref = await admin.firestore().collection('sampling_requests').add(rec);

    // The ONLY email at this step: the sampler's packet (owner trimmed volume;
    // the store sees an on-page confirmation instead).
    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const mail = _samplingPacketEmail(ref.id, rec);
      const result = await resend.emails.send({
        from: 'lavender@pbfwholesale.com', to: cfg.samplerEmail,
        replyTo: 'graham@pumpkinblossomfarm.com',
        subject: mail.subject, html: mail.html,
      });
      await ref.update({ packetSentAt: new Date().toISOString(), packetMessageId: result.data?.id || result.id || null });
    } catch (e) {
      console.error('Sampler packet send failed:', e.message);
      await ref.update({ packetSendFailed: true }).catch(() => {});
    }

    await _logCadenceEntry(acct.acId, { stage: 'sampling_requested', subject: 'Demo day requested: ' + date1 });
    return { success: true };
  }
);

// ── Sampler + store action links (public onRequest) ──
// GET is ALWAYS read-only (state pages, print sheet, or "armed" pages with a
// POST form). Mutations happen ONLY on POST — mail scanners and prefetchers
// can never book, decline, propose, or accept anything.
// Two audiences, two keys on the same request doc:
//   sampler actions (confirm1/confirm2/no/propose/sheet/state) → samplerActionToken
//   store actions after a proposal (saccept/sdecline)          → storeActionToken
exports.samplingAction = onRequest(
  { invoker: 'public', secrets: [resendApiKey] },
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const src = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const r = src.r, k = src.k, a = src.a;
    const send = (title, body) => res.status(200).send(_samplingActionPage(title, body));
    const hidden = (action, extraFields) =>
      `<input type="hidden" name="r" value="${escHtml(String(r))}">
       <input type="hidden" name="k" value="${escHtml(String(k))}">
       <input type="hidden" name="a" value="${escHtml(action)}">${extraFields || ''}`;
    const postForm = (action, label, extraFields) =>
      `<form method="POST" action="${SAMPLING_ACTION_BASE}" style="margin:14px 0">${hidden(action, extraFields)}
        <button type="submit" class="btn yes" style="width:100%;border:none;cursor:pointer;font-family:inherit">${label}</button>
      </form>`;
    const postFormQuiet = (action, label) =>
      `<form method="POST" action="${SAMPLING_ACTION_BASE}" style="margin:14px 0">${hidden(action)}
        <button type="submit" class="btn no" style="width:100%;cursor:pointer;font-family:inherit">${label}</button>
      </form>`;
    const backLink = `<a class="btn no" href="${SAMPLING_ACTION_BASE}?r=${encodeURIComponent(String(r))}&k=${encodeURIComponent(String(k))}">GO BACK</a>`;
    if (!r || !k) return res.status(400).send(_samplingActionPage('Not found', '<h1>Link not valid</h1><p>This link is missing information. Please open it straight from your email.</p>'));

    const db = admin.firestore();
    let snap;
    try {
      snap = await db.collection('sampling_requests').doc(String(r)).get();
    } catch (e) {
      return res.status(400).send(_samplingActionPage('Not valid', '<h1>Link not valid</h1><p>Please open the link straight from your email.</p>'));
    }
    const ref = db.collection('sampling_requests').doc(String(r));
    const STORE_ACTIONS = ['saccept', 'sdecline'];
    const isStoreAction = STORE_ACTIONS.includes(a);
    if (!snap.exists) {
      return res.status(403).send(_samplingActionPage('Not valid', '<h1>Link not valid</h1><p>This link doesn&#39;t match a demo request.</p>'));
    }
    const rec = snap.data();
    // Route by audience: a store key must never fire sampler actions and
    // vice versa.
    const expectedKey = isStoreAction ? rec.storeActionToken : rec.samplerActionToken;
    if (!expectedKey || expectedKey !== k) {
      return res.status(403).send(_samplingActionPage('Not valid', '<h1>Link not valid</h1><p>This link doesn&#39;t match a demo request. If you think that&#39;s wrong, just reply to the email you got.</p>'));
    }
    const w = (SAMPLING_WINDOWS[rec.timeWindow] || {}).label || '';
    const metaBox = `<div class="meta">📍 ${escHtml(rec.storeAddress || '')}<br>👤 ${escHtml(rec.contact?.name || '')} — ${escHtml(rec.contact?.cell || '')}<br>🕐 ${escHtml(w)}</div>`;
    const sheetBtn = `<a class="btn no" href="${SAMPLING_ACTION_BASE}?r=${encodeURIComponent(String(r))}&k=${encodeURIComponent(String(rec.samplerActionToken || ''))}&a=sheet">🖨 Print demo sheet</a>`;

    // ════════ STORE-SIDE (accept/decline a proposed date) ════════
    if (isStoreAction) {
      if (rec.status !== 'proposed_alt') {
        const msg = {
          confirmed: `<h1>You're booked ✓</h1><p><strong>${escHtml(_samplingFmtDate(rec.confirmedDate))}</strong> at ${escHtml(rec.accountName)}. A calendar invite was emailed to you.</p>`,
          needs_reschedule: `<h1>We'll be in touch</h1><p>That date fell through — Graham will reach out to find a day that works.</p>`,
          cancelled: `<h1>Cancelled</h1><p>This demo was cancelled. Reply to any of our emails to set up a new one.</p>`,
          completed: `<h1>All done</h1><p>This demo already happened — thank you!</p>`,
        }[rec.status] || `<h1>All set</h1><p>Nothing to do here.</p>`;
        return send('Demo day', msg);
      }
      const altLabel = _samplingFmtDate(rec.altDate);
      if (req.method === 'GET') {
        if (a === 'sdecline') {
          return send('That day?', `<h1>${escHtml(altLabel)} doesn't work?</h1><p>No problem — tap below and Graham will reach out to find a better day.</p>${postForm('sdecline', "CONFIRM — that day doesn't work")}${backLink}`);
        }
        return send('Confirm the day', `<h1>Does ${escHtml(altLabel)} work?</h1><p>Our sampler can do <strong>${escHtml(altLabel)}</strong> (${escHtml(w)}) at ${escHtml(rec.accountName)}.</p>${postForm('saccept', 'YES — CONFIRM ' + escHtml(altLabel))}<a class="btn no" href="${SAMPLING_ACTION_BASE}?r=${encodeURIComponent(String(r))}&k=${encodeURIComponent(String(k))}&a=sdecline">That day doesn't work</a>`);
      }
      // POST
      if (a === 'saccept') {
        if ((rec.altDate || '') < _samplingTodayET()) {
          await ref.update({ status: 'needs_reschedule', storeDeclinedAt: new Date().toISOString() });
          return send('Date passed', `<h1>That date already passed</h1><p>Sorry — this sat too long. Graham will reach out to find a new day.</p>`);
        }
        await _samplingConfirmAndNotify(String(r), ref, rec, rec.altDate, 'store');
        return send('Confirmed', `<h1>Confirmed ✓</h1><p><strong>${escHtml(rec.accountName)}</strong> — ${escHtml(altLabel)}.<br>A calendar invite is on its way to your inbox.</p>`);
      }
      if (a === 'sdecline') {
        await ref.update({ status: 'needs_reschedule', storeDeclinedAt: new Date().toISOString() });
        try {
          const cfg = await _samplingConfig();
          if (cfg.samplerEmail) {
            const { Resend } = require('resend');
            const resend = new Resend(process.env.RESEND_API_KEY);
            await resend.emails.send({
              from: 'lavender@pbfwholesale.com', to: cfg.samplerEmail,
              replyTo: 'graham@pumpkinblossomfarm.com',
              subject: 'Fell through: ' + (rec.accountName || '') + ' — ' + altLabel,
              html: _samplingEmailShell(`<p>${escHtml(rec.accountName)} can't do ${escHtml(altLabel)} either. Graham will sort out a new date — nothing for you to do.</p>`),
            });
          }
        } catch (e) { console.error('Sampler decline notice failed:', e.message); }
        return send('Thanks', `<h1>Thanks for letting us know</h1><p>Graham will reach out to find a day that works.</p>`);
      }
      return res.status(400).send(_samplingActionPage('Not found', '<h1>Unknown action</h1><p>Please use the buttons in your email.</p>'));
    }

    // ════════ SAMPLER-SIDE ════════

    // Printable one-pager — works in any status so old links stay useful.
    if (req.method === 'GET' && a === 'sheet') {
      const L = rec.logistics || {};
      const dateLine = rec.confirmedDate ? _samplingFmtDate(rec.confirmedDate)
        : ('Requested: ' + _samplingFmtDate(rec.date1) + (rec.date2 ? ' / ' + _samplingFmtDate(rec.date2) : ''));
      const row = (lbl, val) => val ? `<tr><td style="padding:8px 12px 8px 0;font-weight:700;white-space:nowrap;vertical-align:top">${lbl}</td><td style="padding:8px 0">${escHtml(val)}</td></tr>` : '';
      return res.status(200).send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Demo sheet — ${escHtml(rec.accountName)}</title>
<style>body{font-family:Arial,sans-serif;color:#000;max-width:700px;margin:24px auto;padding:0 16px;font-size:16px}
h1{font-size:24px;border-bottom:3px solid #000;padding-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:16px}
.print-btn{position:fixed;top:12px;right:12px;padding:10px 18px;font-size:15px;font-weight:700;background:#4D2A6F;color:#fff;border:none;border-radius:8px;cursor:pointer}
@media print{.print-btn{display:none}}</style></head><body>
<button class="print-btn" onclick="window.print()">🖨 Print</button>
<h1>purpl demo day — ${escHtml(rec.accountName)}</h1>
<table>
${row('When', dateLine + (w ? ' — ' + w : ''))}
${row('Where', rec.storeAddress)}
${row('Contact', (rec.contact?.name || '') + ' — ' + (rec.contact?.cell || '') + (rec.contact?.email ? ' — ' + rec.contact.email : ''))}
${row('Table', L.table)}
${row('Power', L.power)}
${row('Parking / load-in', L.parking)}
${row('Their busy hours', L.busyHours)}
${row('Notes', L.notes)}
${row('Bring', 'purpl (cold), cups, ice + bin, table + cloth, signage, trash bag, towel')}
</table></body></html>`);
    }

    // Already decided → every path shows current state (idempotent; a
    // double-tap, forwarded link, or replayed POST can never re-fire emails).
    if (rec.status !== 'pending_sampler') {
      const stateMsg = {
        confirmed: `<h1>Booked ✓</h1><p><strong>${escHtml(rec.accountName)}</strong> — ${escHtml(_samplingFmtDate(rec.confirmedDate))}.<br>It's on your calendar.</p>${metaBox}${sheetBtn}`,
        proposed_alt: `<h1>Waiting on the store</h1><p>You suggested <strong>${escHtml(_samplingFmtDate(rec.altDate))}</strong> — ${escHtml(rec.accountName)} is confirming. Nothing else for you to do.</p>`,
        needs_reschedule: `<h1>Got it</h1><p>Graham will sort out a new date with ${escHtml(rec.accountName)}. Nothing else for you to do.</p>`,
        cancelled: `<h1>Cancelled</h1><p>This demo (${escHtml(rec.accountName)}) was cancelled. Nothing to do.</p>`,
        completed: `<h1>All done</h1><p>This demo is finished. Thank you!</p>`,
      }[rec.status] || `<h1>All set</h1><p>Nothing to do on this one.</p>`;
      return send(rec.accountName || 'Demo request', stateMsg);
    }

    // ── GET on a pending request: read-only pages that ARM a POST ──
    if (req.method === 'GET') {
      if (a === 'confirm1' || a === 'confirm2') {
        const chosen = a === 'confirm1' ? rec.date1 : rec.date2;
        if (!chosen) return send('Hmm', '<h1>That option isn&#39;t available</h1><p>Please use the buttons in your email.</p>');
        if (chosen < _samplingTodayET()) {
          return send('Date passed', `<h1>That date already passed</h1><p>This request sat too long — suggest a day you can do instead:</p><a class="btn yes" href="${SAMPLING_ACTION_BASE}?r=${encodeURIComponent(String(r))}&k=${encodeURIComponent(String(k))}&a=no">Pick a different day</a>`);
        }
        let clashLine = '';
        const daySnap = await db.collection('sampling_requests')
          .where('status', '==', 'confirmed').where('confirmedDate', '==', chosen).limit(5).get();
        const clash = daySnap.docs.find(d => d.id !== String(r));
        if (clash) clashLine = `<p style="color:#b45309"><strong>Heads up:</strong> you already have ${escHtml(clash.data().accountName || 'another store')} booked that day.</p>`;
        return send('Confirm', `<h1>Book ${escHtml(rec.accountName)}?</h1><p><strong>${escHtml(_samplingFmtDate(chosen))}</strong> — ${escHtml(w)}</p>${clashLine}${metaBox}${postForm(a, clash ? 'YES — BOOK IT ANYWAY' : 'YES — BOOK IT')}${backLink}`);
      }
      if (a === 'no') {
        const cfg = await _samplingConfig();
        const minIso = new Date(new Date(_samplingTodayET() + 'T12:00:00').getTime() + cfg.leadDays * 864e5).toISOString().slice(0, 10);
        // Show her upcoming bookings so she picks a free day.
        let bookedLine = '';
        try {
          const up = await db.collection('sampling_requests').where('status', '==', 'confirmed').get();
          const days = up.docs.map(d => d.data()).filter(x => (x.confirmedDate || '') >= _samplingTodayET())
            .sort((x, y) => x.confirmedDate < y.confirmedDate ? -1 : 1).slice(0, 6)
            .map(x => _samplingFmtDate(x.confirmedDate) + ' (' + (x.accountName || '') + ')');
          if (days.length) bookedLine = `<div class="meta">Already booked:<br>${days.map(escHtml).join('<br>')}</div>`;
        } catch (e) { /* list is a nicety — never block the page */ }
        return send('Pick a day', `<h1>Neither day works?</h1><p>Pick a day you CAN do and we'll ask ${escHtml(rec.accountName)}:</p>
<form method="POST" action="${SAMPLING_ACTION_BASE}" style="margin:14px 0">${hidden('propose', `<div style="margin:10px 0"><input type="date" name="date" min="${minIso}" required style="width:100%;padding:14px;font-size:17px;border:2px solid #d1d5db;border-radius:10px"></div>`)}
  <button type="submit" class="btn yes" style="width:100%;border:none;cursor:pointer;font-family:inherit">SUGGEST THAT DAY</button>
</form>
${bookedLine}
${postFormQuiet('no', "I can't — let Graham sort it out")}
${backLink}`);
      }
      // Default: state page for a pending request — show the choices again.
      return send(rec.accountName || 'Demo request', `<h1>${escHtml(rec.accountName)}</h1>${metaBox}
<a class="btn yes" href="${SAMPLING_ACTION_BASE}?r=${encodeURIComponent(String(r))}&k=${encodeURIComponent(String(k))}&a=confirm1">YES — ${escHtml(_samplingFmtDate(rec.date1))}</a>
${rec.date2 ? `<a class="btn yes" href="${SAMPLING_ACTION_BASE}?r=${encodeURIComponent(String(r))}&k=${encodeURIComponent(String(k))}&a=confirm2">YES — ${escHtml(_samplingFmtDate(rec.date2))}</a>` : ''}
<a class="btn no" href="${SAMPLING_ACTION_BASE}?r=${encodeURIComponent(String(r))}&k=${encodeURIComponent(String(k))}&a=no">NO — neither day works</a>`);
    }

    // ── POST: the only mutations ──
    if (a === 'no') {
      await ref.update({ status: 'needs_reschedule', samplerDeclinedAt: new Date().toISOString() });
      return send('Got it', `<h1>No problem</h1><p>Graham will sort out a new date with ${escHtml(rec.accountName)}. Nothing else for you to do.</p>`);
    }

    if (a === 'propose') {
      const cfg = await _samplingConfig();
      const proposed = String(src.date || '').slice(0, 10);
      const err = _samplingValidDate(proposed, cfg);
      if (err) {
        return send('Pick a day', `<h1>Hmm — ${escHtml(err)}</h1><a class="btn yes" href="${SAMPLING_ACTION_BASE}?r=${encodeURIComponent(String(r))}&k=${encodeURIComponent(String(k))}&a=no">Try another day</a>`);
      }
      const storeKey = require('crypto').randomBytes(24).toString('hex');
      await ref.update({ status: 'proposed_alt', altDate: proposed, proposedAt: new Date().toISOString(), storeActionToken: storeKey });
      // Email the store the counter-offer with its own armed links.
      let storeTo = rec.contact?.email || '';
      if (!storeTo) {
        const acDoc = await db.collection('workspace/main/ac').doc(rec.accountId).get();
        storeTo = acDoc.exists ? (acDoc.data().email || '') : '';
      }
      const altLabel = _samplingFmtDate(proposed);
      if (storeTo) {
        try {
          const { Resend } = require('resend');
          const resend = new Resend(process.env.RESEND_API_KEY);
          const slink = act => `${SAMPLING_ACTION_BASE}?r=${String(r)}&k=${storeKey}&a=${act}`;
          await resend.emails.send({
            from: 'lavender@pbfwholesale.com', to: storeTo,
            replyTo: 'graham@pumpkinblossomfarm.com',
            subject: `New day suggested for your purpl demo — ${altLabel}`,
            html: _samplingEmailShell(`
              <p style="font-size:17px;font-weight:500;margin:0 0 16px">Hi ${escHtml(rec.contact?.name || 'there')},</p>
              <p>Our sampler can't make the days you picked for <strong>${escHtml(rec.accountName)}</strong> — but she CAN do <strong>${escHtml(altLabel)}</strong> (${escHtml(w)}). Does that work?</p>
              <div style="text-align:center;margin:20px 0"><a href="${slink('saccept')}" style="display:block;padding:18px 16px;border-radius:10px;font-size:17px;font-weight:700;text-decoration:none;background:#4D2A6F;color:#ffffff">YES — ${escHtml(altLabel)} works</a></div>
              <div style="text-align:center;margin:12px 0"><a href="${slink('sdecline')}" style="display:block;padding:14px 16px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;background:#ffffff;color:#1a1a2e;border:2px solid #d1d5db">That day doesn't work either</a></div>
              <p style="font-size:13px;color:#6b7280">One tap confirms it and a calendar invite follows automatically.</p>`),
          });
        } catch (e) {
          console.error('Proposal email failed:', e.message);
          await ref.update({ proposeEmailFailed: true }).catch(() => {});
        }
      } else {
        await ref.update({ proposeEmailFailed: true }).catch(() => {});
      }
      return send('Sent', `<h1>Sent ✓</h1><p>We asked ${escHtml(rec.accountName)} about <strong>${escHtml(altLabel)}</strong>. If they say yes it books automatically and lands on your calendar. Nothing else for you to do.</p>`);
    }

    if (a === 'confirm1' || a === 'confirm2') {
      const chosen = a === 'confirm1' ? rec.date1 : rec.date2;
      if (!chosen) return send('Hmm', '<h1>That option isn&#39;t available</h1><p>Please use the buttons in your email.</p>');
      if (chosen < _samplingTodayET()) {
        return send('Date passed', `<h1>That date already passed</h1><p>Suggest a day you can do instead:</p><a class="btn yes" href="${SAMPLING_ACTION_BASE}?r=${encodeURIComponent(String(r))}&k=${encodeURIComponent(String(k))}&a=no">Pick a different day</a>`);
      }
      const result = await _samplingConfirmAndNotify(String(r), ref, rec, chosen, 'sampler');
      return send('Booked', `<h1>Booked ✓</h1><p><strong>${escHtml(rec.accountName)}</strong> — ${escHtml(result.dateLabel)}.<br>It's on your calendar. The store's been told.</p>${metaBox}${sheetBtn}`);
    }

    return res.status(400).send(_samplingActionPage('Not found', '<h1>Unknown action</h1><p>Please use the buttons in your email.</p>'));
  }
);

// ── CRM admin actions (staff-auth callable) ──
exports.samplingAdmin = onCall(
  { secrets: [resendApiKey] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
    const { action, requestId } = request.data || {};
    if (!requestId || typeof requestId !== 'string') throw new HttpsError('invalid-argument', 'Missing requestId');
    const ref = admin.firestore().collection('sampling_requests').doc(requestId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Request not found');
    const rec = snap.data();
    const cfg = await _samplingConfig();
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    if (action === 'resend_packet') {
      if (!cfg.samplerEmail) throw new HttpsError('failed-precondition', 'Sampler email not set (Settings → In-Store Sampling)');
      if (!['pending_sampler', 'needs_reschedule'].includes(rec.status)) {
        throw new HttpsError('failed-precondition', 'This request is ' + rec.status + ' — nothing to resend');
      }
      const mail = _samplingPacketEmail(requestId, rec);
      await resend.emails.send({
        from: 'lavender@pbfwholesale.com', to: cfg.samplerEmail,
        replyTo: 'graham@pumpkinblossomfarm.com',
        subject: mail.subject, html: mail.html,
      });
      const patch = { packetSentAt: new Date().toISOString(), packetSendFailed: admin.firestore.FieldValue.delete() };
      // Re-sending from needs_reschedule RE-ARMS the request — otherwise the
      // sampler gets an email full of buttons that all dead-end on the
      // decided-state guard (verifier-caught dead-button trap).
      if (rec.status === 'needs_reschedule') patch.status = 'pending_sampler';
      await ref.update(patch);
      return { success: true };
    }

    if (action === 'cancel') {
      if (['cancelled', 'completed'].includes(rec.status)) return { success: true, already: rec.status };
      // Store hears about a cancellation only if it knew a date existed:
      // confirmed, or a proposal sitting in its inbox.
      const wasConfirmed = ['confirmed', 'proposed_alt'].includes(rec.status);
      await ref.update({ status: 'cancelled', cancelledAt: new Date().toISOString(), cancelledBy: 'staff' });
      // Same recipient fallback as confirmations: form email, else account email.
      let cancelStoreTo = rec.contact?.email || '';
      if (wasConfirmed && !cancelStoreTo && rec.accountId) {
        try {
          const acDoc = await admin.firestore().collection('workspace/main/ac').doc(rec.accountId).get();
          cancelStoreTo = acDoc.exists ? (acDoc.data().email || '') : '';
        } catch (e) { /* no fallback available */ }
      }
      if (wasConfirmed && cancelStoreTo) {
        try {
          await resend.emails.send({
            from: 'lavender@pbfwholesale.com', to: cancelStoreTo,
            replyTo: 'graham@pumpkinblossomfarm.com',
            subject: 'purpl demo day cancelled — ' + (rec.accountName || ''),
            html: _samplingEmailShell(`<p>Hi ${escHtml(rec.contact?.name || 'there')},</p><p>We need to cancel the purpl demo${rec.confirmedDate || rec.altDate ? ' planned for <strong>' + escHtml(_samplingFmtDate(rec.confirmedDate || rec.altDate)) + '</strong>' : ''} at ${escHtml(rec.accountName)}. Sorry about that — reply to this email and we'll set up a new date.</p>`),
          });
        } catch (e) { console.error('Store cancel notice failed:', e.message); }
      }
      if (cfg.samplerEmail) {
        try {
          await resend.emails.send({
            from: 'lavender@pbfwholesale.com', to: cfg.samplerEmail,
            replyTo: 'graham@pumpkinblossomfarm.com',
            subject: 'Cancelled: ' + (rec.accountName || '') + (rec.confirmedDate ? ' — ' + _samplingFmtDate(rec.confirmedDate) : ''),
            html: _samplingEmailShell(`<p>The demo at <strong>${escHtml(rec.accountName)}</strong>${rec.confirmedDate ? ' on ' + escHtml(_samplingFmtDate(rec.confirmedDate)) : ''} is cancelled. Take it off your calendar — nothing else to do.</p>`),
          });
        } catch (e) { console.error('Sampler cancel notice failed:', e.message); }
      }
      return { success: true };
    }

    throw new HttpsError('invalid-argument', 'Unknown action');
  }
);

// ── Daily sweep: T-2 sampler run-sheet reminder + 3-day sampler nudge ──
// 8:00am ET daily. Each send is stamped on the request doc so a rerun (or a
// crashed half-run) can never double-send. The store gets NO reminder by
// owner decision — its confirmation + calendar invite is its whole footprint.
exports.samplingDailySweep = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'America/New_York', secrets: [resendApiKey] },
  async () => {
    const db = admin.firestore();
    const cfg = await _samplingConfig();
    if (!cfg.samplerEmail) return;
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const today = _samplingTodayET();
    const target = new Date(new Date(today + 'T12:00:00Z').getTime() + 2 * 864e5).toISOString().slice(0, 10);

    // T-2 run-sheet reminders (equality-only query — no composite index).
    try {
      const snap = await db.collection('sampling_requests')
        .where('status', '==', 'confirmed').where('confirmedDate', '==', target).get();
      for (const doc of snap.docs) {
        const rec = doc.data();
        if (rec.samplerReminderSentAt) continue;
        const w = (SAMPLING_WINDOWS[rec.timeWindow] || {}).label || '';
        const L = rec.logistics || {};
        try {
          await resend.emails.send({
            from: 'lavender@pbfwholesale.com', to: cfg.samplerEmail,
            replyTo: 'graham@pumpkinblossomfarm.com',
            subject: `Demo in 2 days: ${rec.accountName} — ${_samplingFmtDate(rec.confirmedDate)}`,
            html: _samplingEmailShell(`
              <p style="font-size:17px;font-weight:600;margin:0 0 16px">Demo day in 2 days — everything you need is right here:</p>
              <div style="background:#f9fafb;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.9">
                🏪 <strong>${escHtml(rec.accountName)}</strong><br>
                📅 ${escHtml(_samplingFmtDate(rec.confirmedDate))} — ${escHtml(w)}<br>
                📍 ${escHtml(rec.storeAddress || '')}<br>
                👤 Ask for ${escHtml(rec.contact?.name || '')} — ${escHtml(rec.contact?.cell || '')}<br>
                ${L.table ? '🪑 Table: ' + escHtml(L.table) + '<br>' : ''}
                ${L.power ? '🔌 Power: ' + escHtml(L.power) + '<br>' : ''}
                ${L.parking ? '🚗 Parking/load-in: ' + escHtml(L.parking) + '<br>' : ''}
                ${L.busyHours ? '⏰ Their busy hours: ' + escHtml(L.busyHours) + '<br>' : ''}
                ${L.notes ? '📝 ' + escHtml(L.notes) + '<br>' : ''}
                🎒 Bring: purpl (cold), cups, ice + bin, table + cloth, signage, trash bag, towel
              </div>
              <div style="text-align:center;margin:20px 0"><a href="${SAMPLING_ACTION_BASE}?r=${doc.id}&k=${rec.samplerActionToken}&a=sheet" style="display:block;padding:18px 16px;border-radius:10px;font-size:17px;font-weight:700;text-decoration:none;background:#4D2A6F;color:#ffffff">🖨 Print demo sheet</a></div>`),
          });
          await doc.ref.update({ samplerReminderSentAt: new Date().toISOString() });
        } catch (e) { console.error('Sampler T-2 reminder failed:', doc.id, e.message); }
      }
    } catch (e) { console.error('T-2 sweep failed:', e.message); }

    // 3-day nudge on unanswered requests (once, then the CRM flag carries it).
    try {
      const snap = await db.collection('sampling_requests')
        .where('status', '==', 'pending_sampler').get();
      const cutoff = new Date(Date.now() - 3 * 864e5).toISOString();
      for (const doc of snap.docs) {
        const rec = doc.data();
        if (rec.samplerNudgedAt) continue;
        if ((rec.packetSentAt || rec.createdAt || '') > cutoff) continue;
        try {
          const mail = _samplingPacketEmail(doc.id, rec);
          await resend.emails.send({
            from: 'lavender@pbfwholesale.com', to: cfg.samplerEmail,
            replyTo: 'graham@pumpkinblossomfarm.com',
            subject: 'Still waiting — ' + mail.subject,
            html: mail.html,
          });
          await doc.ref.update({ samplerNudgedAt: new Date().toISOString() });
        } catch (e) { console.error('Sampler nudge failed:', doc.id, e.message); }
      }
    } catch (e) { console.error('Nudge sweep failed:', e.message); }
  }
);
