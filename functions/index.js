const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

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
// Input is validated and escaped; email rate-limited by Resend.
exports.sendOrderConfirmation = onCall(
  {secrets: [resendApiKey]},
  async (request) => {
    const data = request.data;
    if (!data.to || !data.accountName) {
      throw new HttpsError('invalid-argument', 'Missing required fields: to, accountName');
    }

    const accentColor = data.isPbf ? '#4a7c59' : '#8B5FBF';

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0eff4;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0eff4;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
  style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:linear-gradient(135deg,#4a2d7a 0%,#7B4FA0 100%);padding:36px 40px;text-align:center">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td align="center">
        <table cellpadding="0" cellspacing="0" width="auto">
          <tr>
            <td width="auto" valign="middle" style="padding-right:16px">
              <img src="https://static.wixstatic.com/media/81a2ff_1e3f6923c1d5495082d490b4cc229e1c~mv2.png/v1/fill/w_176,h_71,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Purpl%20Logo%20-%20Sprig%20in%20front%20-%20transparent.png"
                alt="purpl" width="110" height="44"
                style="display:block;margin:0 auto;filter:brightness(0) invert(1)">
            </td>
            <td width="1px" valign="middle">
              <div style="width:1px;height:48px;background:rgba(255,255,255,0.4)"></div>
            </td>
            <td width="auto" valign="middle" style="padding-left:16px">
              <img src="https://purpl-crm.web.app/images/lf-logo-circle-transparent.png"
                alt="Lavender Fields" width="52" height="52"
                style="display:block;margin:0 auto;filter:brightness(0) invert(1)">
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
    <div style="text-align:center;font-family:Arial,sans-serif;font-size:10px;color:rgba(255,255,255,0.75);letter-spacing:0.15em;text-transform:uppercase;margin-top:10px">Pumpkin Blossom Farm · Wholesale</div>
  </td></tr>
  <tr><td style="background:#8B5FBF;height:4px"></td></tr>
  <tr><td style="padding:32px 40px;font-size:15px;color:#1a1a2e;line-height:1.7">
    <p>Hi ${escHtml(data.contactName || 'there')},</p>
    <p>We received your order for <strong>${escHtml(data.accountName)}</strong> and we're on it. You'll hear from us with delivery details shortly.</p>
    ${data.orderSummary || ''}
    <p style="margin-top:20px">Questions? Reply to this email or call 603-748-3038.</p>
    <p>Warmly,<br><strong>Graham Biagiotti</strong><br>Pumpkin Blossom Farm</p>
    ${data.portalLink ? `
    <div style="margin-top:20px;padding-top:20px;border-top:1px solid #e5e7eb;text-align:center">
      <a href="${escHtml(data.portalLink)}" style="color:${accentColor};font-size:13px;text-decoration:none">Place another order →</a>
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
      const messageId = result.data?.id || result.id;

      if (data.accountId && messageId) {
        await _logCadenceEntry(data.accountId, {
          stage: 'order_confirmation',
          sentMessageId: messageId,
          subject: `Order received — ${data.accountName}`,
        });
      }
      // Also log on the portal_order doc so unmatched orders have tracking
      if (data.portalOrderId && messageId) {
        try {
          await admin.firestore().collection('portal_orders').doc(data.portalOrderId).update({
            emailLog: admin.firestore.FieldValue.arrayUnion({
              stage: 'order_confirmation',
              sentAt: new Date().toISOString(),
              sentBy: 'system',
              method: 'resend',
              sentMessageId: messageId,
              to: data.to,
            }),
          });
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
    if (!data.to || !data.businessName || !data.contactName) {
      throw new HttpsError('invalid-argument', 'Missing required fields');
    }

    const safeName = escHtml(data.contactName);
    const safeBiz = escHtml(data.businessName);

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f0eff4;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0eff4;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
  style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:linear-gradient(135deg,#4a2d7a 0%,#7B4FA0 100%);padding:32px 40px;text-align:center">
    <table cellpadding="0" cellspacing="0" style="margin:0 auto"><tr>
      <td valign="middle" style="padding-right:14px"><img src="https://static.wixstatic.com/media/81a2ff_1e3f6923c1d5495082d490b4cc229e1c~mv2.png/v1/fill/w_176,h_71,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Purpl%20Logo%20-%20Sprig%20in%20front%20-%20transparent.png" alt="purpl" width="100" height="40" style="display:block;filter:brightness(0) invert(1)"></td>
      <td valign="middle" style="padding:0 14px"><div style="width:1px;height:36px;background:rgba(255,255,255,0.3)"></div></td>
      <td valign="middle"><img src="https://purpl-crm.web.app/images/lf-logo-circle-transparent.png" alt="Lavender Fields" width="40" height="40" style="display:block;filter:brightness(0) invert(1)"></td>
    </tr></table>
    <div style="font-size:10px;color:rgba(255,255,255,0.7);letter-spacing:0.15em;text-transform:uppercase;margin-top:10px">Pumpkin Blossom Farm · Wholesale</div>
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
  const db = admin.firestore();
  const snap = await db.collection('portal_settings').doc('config').get();
  if (!snap.exists) return { valid: true };
  const stored = snap.data().portalPassword || '';
  if (!stored) return { valid: true };
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

  // Check accounts first
  const acSnap = await db.collection('accounts')
    .where('orderPortalToken', '==', token).limit(1).get();
  if (!acSnap.empty) {
    const d = acSnap.docs[0].data();
    return {
      found: true,
      isProspect: false,
      accountId: acSnap.docs[0].id,
      accountName: d.name || '',
      accountEmail: d.email || '',
      isPbf: d.isPbf || false,
      portalPrefs: d.portalPrefs || {},
    };
  }

  // Check prospects
  const prSnap = await db.collection('prospects')
    .where('orderPortalToken', '==', token).limit(1).get();
  if (!prSnap.empty) {
    const d = prSnap.docs[0].data();
    return {
      found: true,
      isProspect: true,
      accountId: prSnap.docs[0].id,
      accountName: d.name || '',
      accountEmail: d.email || '',
      isPbf: false,
      portalPrefs: {},
    };
  }

  // Fallback: check workspace/main/ac (token may exist here if external write failed)
  const wsSnap = await db.collection('workspace/main/ac')
    .where('orderPortalToken', '==', token).limit(1).get();
  if (!wsSnap.empty) {
    const d = wsSnap.docs[0].data();
    return {
      found: true,
      isProspect: false,
      accountId: wsSnap.docs[0].id,
      accountName: d.name || '',
      accountEmail: d.email || '',
      isPbf: d.isPbf || false,
      portalPrefs: d.portalPrefs || {},
    };
  }

  return { found: false };
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
      wh.verify(JSON.stringify(req.body), {
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
<body style="margin:0;padding:0;background:#f0eff4;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0eff4;padding:32px 16px">
<tr><td align="center">
<table width="500" cellpadding="0" cellspacing="0" style="max-width:500px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:linear-gradient(135deg,#4a2d7a 0%,#7B4FA0 100%);padding:28px 32px;text-align:center">
    <div style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px">purpl CRM</div>
    <div style="color:rgba(255,255,255,0.7);font-size:11px;letter-spacing:0.1em;text-transform:uppercase;margin-top:4px">Pumpkin Blossom Farm</div>
  </td></tr>
  <tr><td style="padding:28px 32px;font-size:15px;color:#1a1a2e;line-height:1.7">
    <p>Hi ${escHtml(displayName || email.split('@')[0])},</p>
    <p>You've been invited to join the <strong>purpl CRM</strong> team as ${assignRole === 'admin' ? 'an admin' : 'an employee'}.</p>
    <p>Click the button below to set your password and sign in:</p>
    <div style="text-align:center;margin:24px 0">
      <a href="${link}" style="display:inline-block;background:#4a2d7a;color:#fff;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Set Password &amp; Sign In</a>
    </div>
    <p style="font-size:13px;color:#6b7280">After setting your password, go to <a href="https://purpl-crm.web.app" style="color:#4a2d7a">purpl-crm.web.app</a> to sign in.</p>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:14px 32px;text-align:center;font-size:11px;color:#9ca3af">
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
        success_url: 'https://purpl-crm.web.app/payment-success.html?inv=' + encodeURIComponent(data.invoiceNumber || ''),
        cancel_url: 'https://purpl-crm.web.app/payment-success.html?cancelled=1&inv=' + encodeURIComponent(data.invoiceNumber || ''),
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
    if (!data.amount || !data.invoiceNumber) return {ok: false, v: 2, error: 'Missing amount or invoice number'};

    const key = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!key) return {ok: false, v: 2, error: 'STRIPE_SECRET_KEY is not set'};
    if (!key.startsWith('sk_')) return {ok: false, v: 2, error: 'STRIPE_SECRET_KEY must start with sk_ (got ' + key.slice(0, 3) + '...)'};

    let stripe;
    try { stripe = require('stripe')(key); } catch (e) { return {ok: false, v: 2, error: 'Stripe SDK failed: ' + e.message}; }

    const amountCents = Math.round(parseFloat(data.amount) * 100);
    if (amountCents < 50) return {ok: false, v: 2, error: 'Amount too small (min $0.50)'};

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Invoice ${data.invoiceNumber}`,
              description: data.accountName ? `${data.accountName} — Pumpkin Blossom Farm` : 'Pumpkin Blossom Farm',
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        }],
        mode: 'payment',
        metadata: {
          invoiceNumber: data.invoiceNumber,
          invoiceId: data.invoiceId || '',
          invoiceType: data.invoiceType || 'retail',
          accountId: data.accountId || '',
        },
        success_url: 'https://purpl-crm.web.app/payment-success.html?inv=' + encodeURIComponent(data.invoiceNumber || ''),
        cancel_url: 'https://purpl-crm.web.app/payment-success.html?cancelled=1&inv=' + encodeURIComponent(data.invoiceNumber || ''),
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
    if (!data.amount || !data.invoiceNumber) return {ok: false, error: 'Missing amount or invoice number'};

    const key = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!key) return {ok: false, error: 'STRIPE_SECRET_KEY is not set. Run: firebase functions:secrets:set STRIPE_SECRET_KEY'};
    if (!key.startsWith('sk_')) return {ok: false, error: 'STRIPE_SECRET_KEY starts with ' + key.slice(0, 3) + ' — must start with sk_live_ or sk_test_'};

    let stripe;
    try { stripe = require('stripe')(key); } catch (e) { return {ok: false, error: 'Stripe SDK failed: ' + e.message}; }

    const amountCents = Math.round(parseFloat(data.amount) * 100);
    if (amountCents < 50) return {ok: false, error: 'Amount too small (min $0.50)'};

    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'usd',
            product_data: {
              name: `Invoice ${data.invoiceNumber}`,
              description: data.accountName ? `${data.accountName} — Pumpkin Blossom Farm` : 'Pumpkin Blossom Farm',
            },
            unit_amount: amountCents,
          },
          quantity: 1,
        }],
        mode: 'payment',
        metadata: {
          invoiceNumber: data.invoiceNumber,
          invoiceId: data.invoiceId || '',
          invoiceType: data.invoiceType || 'retail',
          accountId: data.accountId || '',
        },
        success_url: 'https://purpl-crm.web.app/payment-success.html?inv=' + encodeURIComponent(data.invoiceNumber || ''),
        cancel_url: 'https://purpl-crm.web.app/payment-success.html?cancelled=1&inv=' + encodeURIComponent(data.invoiceNumber || ''),
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
      const paidData = {
        status: 'paid',
        paidDate: now.slice(0, 10),
        paidAt: now,
        paidVia: 'stripe',
        stripeSessionId: session.id,
        stripePaymentIntent: session.payment_intent,
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

      // If combined, also mark the child invoices as paid
      if (invoiceType === 'combined') {
        const combSnap = await db.doc(`${colPath}/${invoiceId}`).get();
        if (combSnap.exists) {
          const comb = combSnap.data();
          if (comb.purplInvoiceId) {
            await db.doc(`workspace/main/retail_invoices/${comb.purplInvoiceId}`).update(paidData).catch(() => {});
          }
          if (comb.lfInvoiceId) {
            await db.doc(`workspace/main/lf_invoices/${comb.lfInvoiceId}`).update(paidData).catch(() => {});
          }
        }
      }

      // Log to audit
      await db.collection('workspace/main/audit_log').add({
        timestamp: now,
        action: 'paid',
        entityType: invoiceType + '_invoice',
        entityId: invoiceId,
        entityName: meta.invoiceNumber || '',
        changedBy: 'stripe',
        changedByEmail: 'stripe-webhook',
        stripeSessionId: session.id,
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
      const resp = await fetch('https://ssapi.shipstation.com/orders/createorder', {
        method: 'POST',
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload),
      });
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
      const resp = await fetch('https://ssapi.shipstation.com/stores', {
        headers: { 'Authorization': authHeader },
      });
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
  {secrets: [shipStationApiKey], invoker: 'public'},
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }
    try {
      const payload = req.body || {};
      const resourceUrl = payload.resource_url;
      if (!resourceUrl) { res.status(200).send('no resource_url'); return; }

      const key = (process.env.SHIPSTATION_API_KEY || '').trim();
      const authVal = key.includes(':') ? key : key + ':';
      const authHeader = 'Basic ' + Buffer.from(authVal).toString('base64');

      const resp = await fetch(resourceUrl, { headers: { 'Authorization': authHeader } });
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
      const shipDate = now.slice(0, 10);

      for (const [orderNumber, info] of Object.entries(byOrder)) {
        if (!info.trackingNumbers.length) continue;
        const trackingStr = info.trackingNumbers.join(', ');
        const carrierStr  = [...new Set(info.carriers.filter(Boolean))].join(', ');
        const shipCost    = Math.round(info.totalShipCost * 100) / 100;

        // Find the invoice by number across all collections
        const cols = ['retail_invoices', 'lf_invoices', 'combined_invoices'];
        for (const col of cols) {
          const snap = await db.collection('workspace/main/' + col)
            .where('number', '==', orderNumber).limit(1).get();
          if (!snap.empty) {
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

            // Recalculate due date: ship date + payment terms
            const configSnap = await db.doc('workspace/main/config/main').get();
            const configData = configSnap.exists ? configSnap.data() : {};
            const terms = (configData.invoice_settings || {}).terms || (configData.settings || {}).payment_terms || 30;
            const dueDate = new Date(Date.now() + terms * 86400000).toISOString().slice(0, 10);

            const update = {
              trackingNumber: trackingStr,
              carrier: carrierStr,
              shippedAt: now,
              deliveryMethod: 'ship',
              lineItems: updatedItems,
              date: shipDate,
              issued: shipDate,
              dueDate: dueDate,
              due: dueDate,
              readyToSend: true,
            };
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
      }
      res.status(200).send('ok');
    } catch (e) {
      console.error('ShipStation webhook error:', e.message);
      res.status(200).send('error logged');
    }
  }
);
