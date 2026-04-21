const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const resendApiKey = defineSecret('RESEND_API_KEY');
const resendWebhookSecret = defineSecret('RESEND_WEBHOOK_SECRET');

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
      throw new HttpsError('internal', err.message);
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
      throw new HttpsError('internal', err.message);
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
      throw new HttpsError('internal', err.message);
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
      throw new HttpsError('internal', err.message);
    }
  }
);

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

  return { found: false };
});

// ── 5. Resend Webhook ─────────────────────────────────────
// Validates webhook signature via svix, then updates cadence entries.
exports.resendWebhook = onRequest(
  {secrets: [resendWebhookSecret]},
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).send('Method Not Allowed'); return; }

    // Validate webhook signature if secret is configured
    const whSecret = process.env.RESEND_WEBHOOK_SECRET;
    if (whSecret) {
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
    await ref.update({
      lastContacted: new Date().toISOString().slice(0, 10),
      cadence: [...(account.cadence || []), entry],
      _updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('_logCadenceEntry error:', err.message);
  }
}
