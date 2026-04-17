const {onCall, onRequest, HttpsError} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const resendApiKey = defineSecret('RESEND_API_KEY');
const resendWebhookSecret = defineSecret('RESEND_WEBHOOK_SECRET');

const ALLOWED_FROM = [
  'lavender@pbfwholesale.com',
];

// ── 1. Send Email ─────────────────────────────────────────
exports.sendEmail = onCall(
  {secrets: [resendApiKey]},
  async (request) => {
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
      const messageId = result.data?.id || result.id;

      if (data.accountId && messageId) {
        await _logCadenceEntry(data.accountId, {
          stage: 'order_confirmation',
          sentMessageId: messageId,
          subject: `Order received — ${data.accountName}`,
        });
      }

      return {success: true, id: messageId};
    } catch (err) {
      throw new HttpsError('internal', err.message);
    }
  }
);

// ── 4. Resend Webhook ─────────────────────────────────────
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
      const ref = db.doc('workspace/main/data/store');
      const snap = await ref.get();
      if (!snap.exists) { res.status(200).send('no data'); return; }

      const data     = snap.data();
      const accounts = data.ac || [];
      const ts       = event.data.created_at || new Date().toISOString();
      let updated    = false;

      const updatedAccounts = accounts.map(account => {
        const cadence = (account.cadence || []).map(entry => {
          if (entry.sentMessageId !== emailId) return entry;
          if (type === 'email.opened' && !entry.opened) {
            updated = true;
            return {...entry, opened: true, openedAt: ts};
          }
          if (type === 'email.clicked' && !entry.clicked) {
            updated = true;
            return {...entry, clicked: true, clickedAt: ts};
          }
          return entry;
        });
        return {...account, cadence};
      });

      if (updated) {
        await ref.update({ac: updatedAccounts});
      }
      res.status(200).send('ok');
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
    const ref = db.doc('workspace/main/data/store');
    const snap = await ref.get();
    if (!snap.exists) return;

    const data = snap.data();
    const accounts = data.ac || [];
    let updated = false;

    const updatedAccounts = accounts.map(account => {
      if (account.id !== accountId) return account;
      updated = true;
      const entry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2),
        sentAt: new Date().toISOString(),
        sentBy: 'system',
        method: 'resend',
        ...entryData,
      };
      return {
        ...account,
        lastContacted: new Date().toISOString().slice(0, 10),
        cadence: [...(account.cadence || []), entry],
      };
    });

    if (updated) {
      await ref.update({ac: updatedAccounts});
    }
  } catch (err) {
    console.warn('_logCadenceEntry error:', err.message);
  }
}
