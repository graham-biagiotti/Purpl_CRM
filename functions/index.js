const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
// Business-local (US Eastern) calendar date. Webhooks stamped UTC dates, which
// after 8pm ET land on TOMORROW — evening payments booked into next month's
// Collected and (Dec 31) the next tax year. en-CA gives YYYY-MM-DD.
const etDate = (d) => new Date(d || Date.now()).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

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

// ── 1. Send Email ─────────────────────────────────────────
exports.sendEmail = onCall(
  {secrets: [resendApiKey]},
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

    try {
      const result = await resend.emails.send({
        from: data.from,
        to: data.to,
        subject: data.subject,
        html: data.html,
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

      if (data.accountId && messageId) {
        await _logCadenceEntry(data.accountId, {
          stage: 'invoice_sent',
          sentMessageId: messageId,
          subject: data.subject || 'Invoice from Pumpkin Blossom Farm',
          invoiceNumber: data.invoiceNumber || null,
        });
      }

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

    const accentColor = data.isPbf ? '#4a7c59' : '#8B5FBF';

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
  style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:#6B4F9A;background:linear-gradient(135deg,#6B4F9A 0%,#9B73C4 100%);padding:32px 40px;text-align:center">
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
  <tr><td style="background:#8B5FBF;height:4px"></td></tr>
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
  <tr><td style="background:#6B4F9A;background:linear-gradient(135deg,#6B4F9A 0%,#9B73C4 100%);padding:32px 40px;text-align:center">
    <table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
      <td valign="middle" style="padding-right:16px"><img src="https://purpl-crm.web.app/images/purpl-wordmark-white.png" alt="purpl" width="170" height="65" style="display:block"></td>
      <td valign="middle" style="padding:0 16px"><div style="width:1px;height:44px;background:rgba(255,255,255,0.5)"></div></td>
      <td valign="middle"><img src="https://purpl-crm.web.app/images/lf-logo-white.png" alt="Lavender Fields" width="84" height="78" style="display:block"></td>
    </tr></table>
    <div style="font-size:10px;color:rgba(255,255,255,0.9);letter-spacing:0.15em;text-transform:uppercase;margin-top:10px">Pumpkin Blossom Farm · Wholesale</div>
  </td></tr>
  <tr><td style="background:#8B5FBF;height:4px"></td></tr>
  <tr><td style="padding:32px 40px;font-size:15px;color:#1a1a2e;line-height:1.7">
    <p style="font-size:17px;font-weight:500;margin:0 0 20px">Hi ${safeName},</p>
    <p>Thank you for your interest in carrying our products at <strong>${safeBiz}</strong>. We've received your application and will be in touch within 1 business day.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
      <tr><td style="background:#f9fafb;border-left:3px solid #8B5FBF;padding:16px 20px;border-radius:0 6px 6px 0">
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
    `<div style="font-size:13px;letter-spacing:.15em;text-transform:uppercase;color:#8B5FBF;margin-bottom:16px">Pumpkin Blossom Farm</div>` +
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
      res.status(401).send('Invalid signature');
      return;
    }

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
    await ref.update({
      lastContacted: new Date().toISOString().slice(0, 10),
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
  <tr><td style="background:#6B4F9A;background:linear-gradient(135deg,#6B4F9A 0%,#9B73C4 100%);padding:28px 32px;text-align:center">
    <div style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px">purpl CRM</div>
    <div style="color:rgba(255,255,255,0.9);font-size:11px;letter-spacing:0.1em;text-transform:uppercase;margin-top:4px">Pumpkin Blossom Farm</div>
  </td></tr>
  <tr><td style="padding:28px 32px;font-size:15px;color:#1a1a2e;line-height:1.7">
    <p>Hi ${escHtml(displayName || email.split('@')[0])},</p>
    <p>You've been invited to join the <strong>purpl CRM</strong> team as ${assignRole === 'admin' ? 'an admin' : 'an employee'}.</p>
    <p>Click the button below to set your password and sign in:</p>
    <div style="text-align:center;margin:24px 0">
      <a href="${link}" style="display:inline-block;background:#6B4F9A;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Set Password &amp; Sign In</a>
    </div>
    <p style="font-size:13px;color:#6b7280">After setting your password, go to <a href="https://purpl-crm.web.app" style="color:#6B4F9A">purpl-crm.web.app</a> to sign in.</p>
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
      res.status(400).send('Invalid signature');
      return;
    }

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

      // Update the correct invoice collection based on type
      const colMap = {
        retail: 'workspace/main/retail_invoices',
        lf: 'workspace/main/lf_invoices',
        combined: 'workspace/main/combined_invoices',
        dist: 'workspace/main/dist_invoices',
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
        // Legacy purpl invoices live in workspace/main/iv — try there before
        // declaring the payment orphaned.
        let recovered = false;
        if (invoiceType === 'retail') {
          try {
            await db.doc(`workspace/main/iv/${invoiceId}`).update(paidData);
            recovered = true;
          } catch (e2) { /* fall through to orphan handling */ }
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
        res.status(403).send('Forbidden');
        return;
      }

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
  <tr><td style="background:#6B4F9A;background:linear-gradient(135deg,#6B4F9A 0%,#9B73C4 100%);padding:32px 40px;text-align:center">
    <table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
      <td valign="middle" style="padding-right:16px"><img src="https://purpl-crm.web.app/images/purpl-wordmark-white.png" alt="purpl" width="170" height="65" style="display:block"></td>
      <td valign="middle" style="padding:0 16px"><div style="width:1px;height:44px;background:rgba(255,255,255,0.5)"></div></td>
      <td valign="middle"><img src="https://purpl-crm.web.app/images/lf-logo-white.png" alt="Lavender Fields" width="84" height="78" style="display:block"></td>
    </tr></table>
    <div style="font-size:10px;color:rgba(255,255,255,0.9);letter-spacing:0.15em;text-transform:uppercase;margin-top:10px">Pumpkin Blossom Farm · Wholesale</div>
  </td></tr>
  <tr><td style="background:#8B5FBF;height:4px"></td></tr>
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
        const cols = ['retail_invoices', 'lf_invoices', 'combined_invoices'];
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
            const newTotal = Math.round(updatedItems.reduce((s, li) => s + parseFloat(li.lineTotal || li.total || 0), 0) * 100) / 100;

            const update = {
              trackingNumber: trackingStr,
              carrier: carrierStr,
              deliveryMethod: 'ship',
              lineItems: updatedItems,
              readyToSend: true,
            };
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
            // Update total on the right field(s) depending on collection
            if (col === 'combined_invoices') {
              // For combined: shipping goes on grand total; product subtotals unchanged
              update.grandTotal = (parseFloat(inv.purplSubtotal || 0) + parseFloat(inv.lfSubtotal || 0) + shipCost);
            } else {
              update.total = newTotal;
              update.amount = newTotal;
            }

            await doc.ref.update(update);

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
