// ═══════════════════════════════════════════════════════
//  app.js  —  purpl CRM  all business logic
//  Called via window.onAppReady() after auth + DB init
// ═══════════════════════════════════════════════════════

// ── Unit conversion constant ─────────────────────────────
// Orders and deliveries are tracked in CASES.
// Inventory (iv collection) is tracked in individual CANS.
// Always use CANS_PER_CASE when converting between them.
const CANS_PER_CASE = 12;

// ── Helpers ─────────────────────────────────────────────
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const today = () => new Date().toISOString().slice(0,10);
const fmt   = (n, d=0) => (+n||0).toLocaleString(undefined, {minimumFractionDigits:d, maximumFractionDigits:d});
const fmtC  = (n) => '$' + fmt(n,2);
const fmtD  = (s) => s ? new Date(s+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
const daysAgo = (s) => s ? Math.floor((Date.now()-new Date(s+'T12:00:00'))/(864e5)) : 999;
const weeksAgo = (s) => Math.floor(daysAgo(s)/7);

function toast(msg, dur=3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), dur);
}

function confirm2(msg) { return window.confirm(msg); }

// ── DB loading placeholder ───────────────────────────────
// Shows a shimmer skeleton while Firestore hasn't yet delivered its first snapshot.
function _dbLoadingHTML(rows = 3) {
  const items = Array.from({length: rows}, () =>
    '<div class="loading-skeleton"></div>').join('');
  return `<div class="db-loading-placeholder">${items}</div>`;
}

// ── Offline / online banner ──────────────────────────────
(function _initOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  function update() {
    const offline = !navigator.onLine;
    banner.classList.toggle('visible', offline);
    document.body.classList.toggle('offline-mode', offline);
  }
  window.addEventListener('offline', update);
  window.addEventListener('online',  update);
  update(); // apply immediately on boot
}());

// ── SKU definitions ──────────────────────────────────────
// ── Fulfillment helpers ──────────────────────────────────
function _getFulfillBadge(a) {
  const fb = a.fulfilledBy;
  if (!fb || fb === 'direct') {
    return `<span class="badge purple" style="font-size:10px">Direct</span>`;
  }
  const dist = DB.a('dist_profiles').find(d=>d.id===fb);
  return `<span class="badge amber" style="font-size:10px">via ${dist?.name||'Distributor'}</span>`;
}

function _populateFulfillFilter() {
  const sel = qs('#ac-fulfill-filter');
  if (!sel) return;
  const dists = DB.a('dist_profiles').filter(d=>d.status==='active');
  const current = sel.value;
  sel.innerHTML = '<option value="">All Fulfillment</option><option value="direct">Direct</option>' +
    dists.map(d=>`<option value="${d.id}">${d.name}</option>`).join('');
  if (current) sel.value = current;
}

const SKUS = [
  {id:'classic',    label:'Classic',    cls:'sku-classic',    bg:'classic-bg'},
  {id:'blueberry',  label:'Blueberry',  cls:'sku-blueberry',  bg:'blueberry-bg'},
  {id:'peach',      label:'Peach',      cls:'sku-peach',       bg:'peach-bg'},
  {id:'raspberry',  label:'Raspberry',  cls:'sku-raspberry',   bg:'raspberry-bg'},
  {id:'variety',    label:'Variety',    cls:'sku-variety',     bg:'variety-bg'},
];
const SKU_MAP = Object.fromEntries(SKUS.map(s=>[s.id,s]));
const skuBadge = (id) => {
  const s = SKU_MAP[id] || {label:id||'—', cls:'sku-classic'};
  return `<span class="badge ${s.cls}">${s.label}</span>`;
};

// ── Navigation ───────────────────────────────────────────
let currentPage = 'dashboard';
let _currentDistId = null;  // tracks which distributor detail is open
// ── Accounts view state ──────────────────────────────────
let _acBrandFilter = '';   // '' | 'purpl' | 'lf' | 'both'
let _acCompact = false;
let _distGroupExpanded = new Set(); // distIds explicitly expanded; empty = all collapsed

function toggleDistGroup(distId) {
  if (_distGroupExpanded.has(distId)) _distGroupExpanded.delete(distId);
  else _distGroupExpanded.add(distId);
  renderAccounts();
}
let _repBrand = 'purpl';   // 'purpl' | 'lf'
let _lfRepPeriod = 30;     // days; 0 = all time
function nav(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sb-nav a').forEach(a => a.classList.remove('active'));
  const pg = document.getElementById('page-'+page);
  if (pg) pg.classList.add('active');
  const lnk = document.querySelector(`.sb-nav a[data-page="${page}"]`);
  if (lnk) lnk.classList.add('active');
  // Sync mobile bottom nav
  document.querySelectorAll('.mobile-bottom-nav a').forEach(a=>{
    a.classList.toggle('active', a.dataset.page===page);
  });
  const titles = {
    dashboard:'Dashboard', accounts:'Accounts', distributors:'Distributors',
    prospects:'Prospects', inventory:'Inventory', orders:'Orders',
    production:'Production', delivery:'Today\'s Run', projections:'Projections',
    reports:'Reports', integrations:'Integrations', settings:'Settings',
    'pre-orders':'Forms & Submissions', invoices:'Invoices', emails:'Emails'
  };
  const tb = document.getElementById('topbar-title');
  if (tb) {
    if (page === 'dashboard') {
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric', year:'numeric'});
      tb.innerHTML = 'Dashboard <span style="font-size:12px;font-weight:400;color:var(--muted);margin-left:8px">' + dateStr + '</span>';
    } else {
      tb.textContent = titles[page] || page;
    }
  }
  const ta = document.getElementById('topbar-actions');
  if (ta) ta.innerHTML = '';
  currentPage = page;
  renders[page]?.();
}

const renders = {
  dashboard:        renderDash,
  accounts:         renderAccounts,
  distributors:     renderDistributors,
  prospects:        renderProspects,
  inventory:        renderInventory,
  'orders-delivery':renderOrdersDelivery,
  // legacy redirects — keep so any deep-link or old nav still works
  orders:           ()=>nav('orders-delivery'),
  delivery:         ()=>{ nav('orders-delivery'); switchODTab('route-builder'); },
  production:       renderProduction,
  map:              renderMap,
  projections:      renderProjectionsPage,
  reports:          renderReports,
  integrations:     renderIntegrations,
  settings:         renderSettings,
  'pre-orders':     renderPreOrders,
  invoices:         () => { renderInvoicesPage(); loadInvoiceSettings(); },
  emails:           renderEmailsPage,
};

// ── STATUS CONFIG ────────────────────────────────────────
const AC_STATUS = {
  active:   {label:'Active',   cls:'green'},
  inactive: {label:'Inactive', cls:'gray'},
  paused:   {label:'Paused',   cls:'amber'},
};
const PR_STATUS = {
  lead:       {label:'Lead',       cls:'gray'},
  contacted:  {label:'Contacted',  cls:'blue'},
  sampling:   {label:'Sampling',   cls:'purple'},
  negotiating:{label:'Negotiating',cls:'amber'},
  won:        {label:'Won',        cls:'green'},
  lost:       {label:'Lost',       cls:'red'},
};
const ORD_STATUS = {
  pending:    {label:'Pending',    cls:'amber'},
  confirmed:  {label:'Confirmed',  cls:'blue'},
  in_transit: {label:'In Transit', cls:'purple'},
  delivered:  {label:'Delivered',  cls:'green'},
  cancelled:  {label:'Cancelled',  cls:'red'},
};

function statusBadge(map, val) {
  const s = map[val] || {label:val||'—', cls:'gray'};
  return `<span class="badge ${s.cls}">${s.label}</span>`;
}

// ── Email template HTML constants ───────────────────────
const SIGNATURE_HTML = `
<table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td style="padding-top:16px;border-top:1px solid #e5e7eb;
      font-family:Inter,Arial,sans-serif;font-size:13px;
      color:#6b7280;line-height:1.6">
      <strong style="color:#1a1a2e">Graham Biagiotti</strong>
      — Director of Sales<br>
      603-748-3038 · Warner, NH<br>
      Pumpkin Blossom Farm | purpl &amp; Lavender Fields
      <div style="margin-top:8px;font-size:13px;
        color:#6b7280">
        Reply to this email or contact Graham directly:<br>
        <a href="mailto:graham@pumpkinblossomfarm.com"
          style="color:#8B5FBF;text-decoration:none">
          graham@pumpkinblossomfarm.com
        </a> · 603-748-3038
      </div>
    </td>
  </tr>
</table>`;

const PBF_HEADER_HTML = `
<table width="100%" cellpadding="0" cellspacing="0"
  style="background:linear-gradient(135deg,#4a2d7a 0%,#7B4FA0 100%);border-radius:8px 8px 0 0">
  <tr>
    <td style="padding:36px 40px;text-align:center">
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
      <div style="text-align:center;font-family:Arial,sans-serif;font-size:10px;
        color:rgba(255,255,255,0.75);letter-spacing:0.15em;
        text-transform:uppercase;margin-top:10px">
        Pumpkin Blossom Farm · Wholesale
      </div>
    </td>
  </tr>
  <tr><td style="background:#8B5FBF;height:4px"></td></tr>
</table>`;

// ── Firebase Functions client helpers ─────────────────────
async function callSendEmail(to, from, subject, html) {
  try {
    const fn = firebase.functions().httpsCallable('sendEmail');
    const result = await fn({to, from, subject, html});
    return result.data;
  } catch (err) {
    console.error('Send email error:', err);
    throw err;
  }
}

async function callSendCombinedInvoice(to, accountName, subject, html) {
  try {
    const fn = firebase.functions().httpsCallable('sendCombinedInvoice');
    const result = await fn({to, accountName, subject, html});
    return result.data;
  } catch (err) {
    console.error('Send combined invoice error:', err);
    throw err;
  }
}

async function callSendOrderConfirmation(to, accountName, contactName, orderSummary, portalLink, isPbf) {
  try {
    const fn = firebase.functions().httpsCallable('sendOrderConfirmation');
    const result = await fn({to, accountName, contactName, orderSummary, portalLink, isPbf});
    return result.data;
  } catch (err) {
    console.error('Send order confirmation error:', err);
    throw err;
  }
}

function buildEmailHTML(headerHTML, accentColor, bodyHTML) {
  return `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head><body style="margin:0;padding:0;background:#f4f4f5;
font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"
  style="background:#f4f4f5;padding:32px 16px">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0"
      style="max-width:600px;width:100%;background:#ffffff;
      border-radius:8px;overflow:hidden;
      box-shadow:0 2px 8px rgba(0,0,0,0.08)">
      <tr><td>${headerHTML}</td></tr>
      <tr><td style="padding:36px 40px;font-family:Inter,
        Arial,sans-serif;font-size:15px;color:#1a1a2e;
        line-height:1.7">
        ${bodyHTML}
        <br><br>${SIGNATURE_HTML}
      </td></tr>
      <tr><td style="background:#f9fafb;padding:20px 40px;
        border-top:1px solid #e5e7eb;text-align:center;
        font-size:11px;color:#9ca3af;line-height:1.6">
        Pumpkin Blossom Farm LLC<br>
        393 Pumpkin Hill Rd · Warner, NH 03278<br>
        <a href="mailto:lavender@pbfwholesale.com"
          style="color:#9ca3af">lavender@pbfwholesale.com</a>
        &nbsp;·&nbsp;603-748-3038<br>
        <a href="https://drinkpurpl.com"
          style="color:#9ca3af">drinkpurpl.com</a>
        &nbsp;·&nbsp;
        <a href="https://pumpkinblossomfarm.com"
          style="color:#9ca3af">pumpkinblossomfarm.com</a>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}

function getCadenceEmailTemplate(stage, account, extra={}) {
  const header = PBF_HEADER_HTML;
  const accentColor = '#8B5FBF';
  const contacts = account.contacts||[];
  const primary = contacts.find(c=>c.isPrimary)||contacts[0]||{};
  const contactName = primary.name||account.contact||'there';
  const businessName = account.name||'your store';
  const portalLink = account.orderPortalToken
    ? `https://purpl-crm.web.app/order?t=${account.orderPortalToken}`
    : 'https://purpl-crm.web.app/order';

  const templates = {
    'application-received': {
      subject: `Thank you for your wholesale application — Pumpkin Blossom Farm`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>Thank you for your interest in carrying our products at <strong>${businessName}</strong>. We've received your application and will be in touch within 1 business day.</p>
        <p>In the meantime, feel free to reach out with any questions.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
          <tr><td style="background:#f9fafb;border-left:3px solid ${accentColor};padding:16px 20px;border-radius:0 6px 6px 0">
            <div style="font-size:13px;color:#6b7280;margin-bottom:4px;font-weight:500">WHAT HAPPENS NEXT</div>
            <div style="font-size:14px;color:#1a1a2e">We review every application personally. You'll hear from us within 1 business day.</div>
          </td></tr>
        </table>
        <p>Warmly,</p>`)
    },
    'approved': {
      subject: `Welcome to the wholesale program — your retailer portal is ready`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>We're thrilled to welcome <strong>${businessName}</strong> as a retail partner. Your wholesale account has been approved.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
          <tr><td align="center" style="padding:24px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb">
            <div style="font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px">YOUR RETAILER PORTAL</div>
            <a href="${portalLink}" style="display:inline-block;background:${accentColor};color:#ffffff;padding:14px 32px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:500">Access Your Portal →</a>
            <div style="font-size:12px;color:#9ca3af;margin-top:12px">Bookmark this link for easy access</div>
          </td></tr>
        </table>
        <p>Payment terms: Net 30. Invoices from lavender@pbfwholesale.com.</p>
        <p>Warmly,</p>`)
    },
    'rejected': {
      subject: `Re: Your wholesale application — Pumpkin Blossom Farm`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>Thank you for your interest in carrying our products at <strong>${businessName}</strong>.</p>
        <p>After reviewing your application, we don't think it's the right fit at this time — but we genuinely appreciate you reaching out and wish you all the best.</p>
        <p>Please don't hesitate to apply again in the future if circumstances change.</p>
        <p>Warmly,</p>`)
    },
    'invoice-sent': {
      subject: `Invoice ${extra.invoiceNumber||''} from Pumpkin Blossom Farm`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>Please find your invoice for <strong>${businessName}</strong> below.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
          <tr><td style="background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;padding:24px">
            <table width="100%">
              <tr>
                <td style="font-size:13px;color:#6b7280;padding-bottom:8px">Invoice Number</td>
                <td align="right" style="font-size:13px;font-weight:600;color:#1a1a2e;padding-bottom:8px">${extra.invoiceNumber||'—'}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#6b7280;padding-bottom:8px">Amount Due</td>
                <td align="right" style="font-size:16px;font-weight:700;color:#1a1a2e">${extra.invoiceTotal||'—'}</td>
              </tr>
              <tr>
                <td style="font-size:13px;color:#6b7280">Payment Terms</td>
                <td align="right" style="font-size:13px;color:#1a1a2e">Net 30</td>
              </tr>
            </table>
            ${extra.invoiceLink?`<div style="margin-top:16px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center"><a href="${extra.invoiceLink}" style="color:${accentColor};font-size:14px;font-weight:500">View Invoice →</a></div>`:''}
          </td></tr>
        </table>
        <p>Please reach out with any questions.</p>
        <p>Warmly,</p>`)
    },
    'first-order': {
      subject: `Thanks for your order — we're on it`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>Thank you for placing your first order with us. We're getting it ready and will be in touch with delivery details shortly.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
          <tr><td style="background:#f9fafb;border-left:3px solid ${accentColor};padding:16px 20px;border-radius:0 6px 6px 0">
            <div style="font-size:14px;color:#1a1a2e">We're excited to have <strong>${businessName}</strong> as a retail partner.</div>
          </td></tr>
        </table>
        <p>Warmly,</p>`)
    }
  };
  return templates[stage] || null;
}

// ── Default demo data (first run only) ──────────────────
function seedIfEmpty() {
  // SAFETY: never seed if Firestore hasn't confirmed document state yet.
  // The 10-second startup timeout can fire before the snapshot arrives — without
  // this guard, seedIfEmpty would see an empty cache and overwrite real data.
  if (!DB._firestoreReady) return;
  // Seed LF SKUs independently — happens once regardless of other data state
  if (!DB.a('lf_skus').length) {
    DB.set('lf_skus', [
      {id:uid(),name:'Lavender Simple Syrup 12.7oz',wholesalePrice:8.99, caseSize:12,msrp:17.99,archived:false},
      {id:uid(),name:'Lavender Simple Syrup 1 gal',  wholesalePrice:49.99,caseSize:1, msrp:null, archived:false},
      {id:uid(),name:'Aromatherapy Scrunchie',        wholesalePrice:7.49, caseSize:6, msrp:14.99,archived:false},
      {id:uid(),name:'Seatbelt Sachet',               wholesalePrice:4.99, caseSize:12,msrp:9.99, archived:false},
      {id:uid(),name:'Soy Candle',                    wholesalePrice:14.99,caseSize:12,msrp:24.99,archived:false},
      {id:uid(),name:'Lavender Refresh Powder',       wholesalePrice:4.99, caseSize:12,msrp:9.99, archived:false},
      {id:uid(),name:'Aromatherapy Roll-On',          wholesalePrice:9.99, caseSize:24,msrp:19.99,archived:false},
      {id:uid(),name:'Dryer Sachet 2-Pack',           wholesalePrice:5.49, caseSize:12,msrp:9.99, archived:false},
    ]);
  }
  // Only seed on the very first run — never again, even if all data is deleted
  const _s = DB.obj('settings', null);
  if (_s !== null && !_s.seeded) { DB.setObj('settings', {..._s, seeded:true}); return; }
  if (_s?.seeded) return;
  if (DB.a('ac').length || DB.a('pr').length) return;
  const accs = [
    {id:uid(),name:'Whole Foods Market – Oak Park',contact:'Lisa Park',phone:'708-555-0100',email:'lisa@wf-oakpark.com',type:'Grocery',status:'active',skus:['classic','blueberry'],par:{classic:48,blueberry:24},territory:'North',since:'2023-03-01',notes:[],lastOrder:today()},
    {id:uid(),name:'Mariano\'s – Lincoln Square',contact:'Tom Ruiz',phone:'773-555-0120',email:'tom@marianos-ls.com',type:'Grocery',status:'active',skus:['classic','peach'],par:{classic:36,peach:24},territory:'North',since:'2023-06-15',notes:[],lastOrder:today()},
    {id:uid(),name:'Central Gym & Fitness',contact:'Rachel Kim',phone:'312-555-0140',email:'rachel@centralgym.com',type:'Gym',status:'active',skus:['classic','raspberry'],par:{classic:24,raspberry:12},territory:'Central',since:'2024-01-10',notes:[],lastOrder:today()},
    {id:uid(),name:'Sunrise Café',contact:'Marco Soto',phone:'773-555-0160',email:'marco@sunrisecafe.com',type:'Café',status:'paused',skus:['variety'],par:{variety:12},territory:'South',since:'2023-09-01',notes:[],lastOrder:'2024-11-15'},
  ];
  const prs = [
    {id:uid(),name:'Green Earth Market',contact:'Amy Chen',phone:'312-555-0200',email:'amy@greenearthmarket.com',type:'Grocery',status:'sampling',territory:'North',source:'Trade Show',notes:[],lastContact:today(),nextAction:'Follow up on sample order',nextDate:today()},
    {id:uid(),name:'FitZone Studios',contact:'Jake Monroe',phone:'708-555-0210',email:'jake@fitzonefit.com',type:'Gym',status:'contacted',territory:'West',source:'Cold Call',notes:[],lastContact:today(),nextAction:'Send product info packet',nextDate:today()},
  ];
  DB.set('ac', accs);
  DB.set('pr', prs);

  const costs = {cogs:{classic:2.10,blueberry:2.20,peach:2.15,raspberry:2.18,variety:2.25},overhead_monthly:1200,target_margin:0.60};
  DB.setObj('costs', costs);
  const settings = {company:'purpl Beverages',currency:'USD',territory_labels:['North','South','Central','West'],payment_terms:30,seeded:true};
  DB.setObj('settings', settings);
}

// ── LF SKU variant migration (idempotent) ─────────────────
function migrateLfSkuVariants() {
  if (!DB._firestoreReady) return;
  const VARIANT_DEFS = {
    'Aromatherapy Scrunchie': [
      'Blossom Satin','Blossom Corduroy','Blossom Velvet',
      'Sage Satin','Sage Corduroy','Sage Velvet',
      'Dusk Satin','Dusk Corduroy','Dusk Velvet',
      'Chai Satin','Chai Corduroy','Chai Velvet',
    ],
    'Seatbelt Sachet': ['Sage Corduroy','Blue Floral','Chai Corduroy','Purple Floral'],
    'Soy Candle':      ['Simply Lavender','Lavender Lemonade','Lavender White Birch'],
  };
  DB.a('lf_skus').forEach(s => {
    if (s.variants !== undefined) return; // already migrated
    const names = VARIANT_DEFS[s.name] || [];
    DB.update('lf_skus', s.id, sk => ({
      ...sk,
      variants: names.map(n => ({id: uid(), name: n, archived: false})),
    }));
  });
}

// ── LF SKU price migration (idempotent) ───────────────────
function migrateLfSkuPrices() {
  if (!DB._firestoreReady) return;
  const PRICE_CATALOG = {
    'Lavender Simple Syrup 12.7oz': {wholesalePrice:8.99,  caseSize:12, msrp:17.99},
    'Lavender Simple Syrup 1 gal':  {wholesalePrice:49.99, caseSize:1,  msrp:null},
    'Aromatherapy Scrunchie':        {wholesalePrice:7.49,  caseSize:6,  msrp:14.99},
    'Seatbelt Sachet':               {wholesalePrice:4.99,  caseSize:12, msrp:9.99},
    'Soy Candle':                    {wholesalePrice:14.99, caseSize:12, msrp:24.99},
    'Lavender Refresh Powder':       {wholesalePrice:4.99,  caseSize:12, msrp:9.99},
    'Aromatherapy Roll-On':          {wholesalePrice:9.99,  caseSize:24, msrp:19.99},
    'Dryer Sachet 2-Pack':           {wholesalePrice:5.49,  caseSize:12, msrp:9.99},
  };
  DB.a('lf_skus').forEach(s => {
    const catalog = PRICE_CATALOG[s.name];
    if (!catalog) return;
    const needsUpdate = s.wholesalePrice !== catalog.wholesalePrice ||
                        s.caseSize !== catalog.caseSize ||
                        s.msrp !== catalog.msrp;
    if (!needsUpdate) return;
    DB.update('lf_skus', s.id, sk => ({...sk, ...catalog}));
  });
}

// ══════════════════════════════════════════════════════════
//  DASHBOARD
// ══════════════════════════════════════════════════════════
function renderDash() {
  const ac  = DB.a('ac').filter(x=>x.status==='active');
  const pr  = DB.a('pr');
  const ord = DB.a('orders');
  const inv = DB.a('iv');

  const revenue30 = ord.filter(o=>daysAgo(o.created)<=30&&o.status!=='cancelled')
    .reduce((s,o)=>s+calcOrderValue(o), 0);
  const pipeline  = pr.filter(x=>!['won','lost'].includes(x.status)).length;
  const overdue   = ord.filter(o=>o.status==='pending'&&o.dueDate<today()).length;
  const lowStock  = SKUS.filter(s=>{
    const oh = inv.filter(i=>i.sku===s.id&&i.type==='in').reduce((t,i)=>t+i.qty,0)
             - inv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
    return oh < 48;
  }).length;

  const allAc  = DB.a('ac');
  const lfCount      = allAc.filter(a=>!!a.isPbf).length;
  const purplOnly    = allAc.filter(a=>!a.isPbf).length;
  const directCount  = allAc.filter(a=>!a.fulfilledBy||a.fulfilledBy==='direct').length;
  const viaDistCount = allAc.filter(a=>a.fulfilledBy&&a.fulfilledBy!=='direct').length;

  // ── Combined 6-card KPI row ──────────────────────────────
  loadScratchpad();
  const purplAcCount = allAc.filter(a => !a.isPbf).length;
  const lfAcCount    = allAc.filter(a => !!a.isPbf).length;
  const purplOutstanding = DB.a('iv').filter(x => (x.accountId || x.number) && x.status !== 'paid').reduce((s,x) => s + parseFloat(x.amount||0), 0);
  const lfOutstanding    = DB.a('lf_invoices').filter(i => i.status !== 'paid').reduce((s,i) => s + (i.total||0), 0);
  const combinedOutstanding  = purplOutstanding + lfOutstanding;
  const purplOverdueCount    = DB.a('iv').filter(x => (x.accountId || x.number) && x.status !== 'paid' && x.due && x.due < today()).length;
  const lfOverdueCount       = DB.a('lf_invoices').filter(i => i.status !== 'paid' && i.due && i.due < today()).length;
  const combinedOverdueCount = purplOverdueCount + lfOverdueCount;
  const pendingWixCount      = DB.a('lf_wix_deductions').filter(d => !d.confirmed).length;
  if (qs('#dash-kpi-total-ac'))             qs('#dash-kpi-total-ac').innerHTML             = kpiHtml('Active Accounts', ac.length, 'purple');
  if (qs('#dash-kpi-purpl-ac'))             qs('#dash-kpi-purpl-ac').innerHTML             = kpiHtml('💜 purpl', purplAcCount, 'purple');
  if (qs('#dash-kpi-lf-ac'))                qs('#dash-kpi-lf-ac').innerHTML                = kpiHtml('🌿 LF', lfAcCount, 'green');
  if (qs('#dash-kpi-combined-outstanding')) qs('#dash-kpi-combined-outstanding').innerHTML = kpiHtml('Outstanding', fmtC(combinedOutstanding), combinedOutstanding > 0 ? 'amber' : 'gray');
  if (qs('#dash-kpi-combined-overdue'))     qs('#dash-kpi-combined-overdue').innerHTML     = kpiHtml('Overdue', combinedOverdueCount, combinedOverdueCount > 0 ? 'red' : 'gray');
  if (qs('#dash-kpi-wix'))                  qs('#dash-kpi-wix').innerHTML                  = kpiHtml('Wix Pulls', pendingWixCount, pendingWixCount > 0 ? 'amber' : 'gray');

  // Low inventory KPI
  const totalCans = SKUS.reduce((sum, sk) => {
    const oh = inv.filter(i => i.sku === sk.id && i.type === 'in').reduce((t, i) => t + i.qty, 0)
             - inv.filter(i => i.sku === sk.id && i.type === 'out').reduce((t, i) => t + i.qty, 0);
    return sum + Math.max(0, oh);
  }, 0);
  const lowStockThreshold = DB.obj('settings', {}).lowStockThreshold || 500;
  const kpiInvEl = qs('#dash-kpi-inv-cans');
  if (kpiInvEl) {
    kpiInvEl.innerHTML = kpiHtml('Total Inventory', totalCans + ' cans', totalCans < lowStockThreshold ? 'red' : 'gray');
    kpiInvEl.style.border = totalCans < lowStockThreshold ? '1.5px solid var(--red)' : '';
  }

  // ── Low stock alert card ──────────────────────────────────
  const alertEl = qs('#dash-low-stock-alert');
  if (alertEl) {
    if (totalCans < lowStockThreshold) {
      alertEl.style.display = '';
      alertEl.innerHTML = `
        <div style="background:#fef3c7;border:1.5px solid #d97706;border-radius:10px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <div style="font-weight:600;font-size:14px;color:#92400e;margin-bottom:2px">&#9888;&#xFE0E; Low Stock &mdash; ${fmt(totalCans)} cans remaining</div>
            <div style="font-size:13px;color:#78350f">Below your alert threshold of ${fmt(lowStockThreshold)} cans. Consider scheduling a production run.</div>
          </div>
          <button class="btn xs" style="background:#d97706;color:#fff;border:none;flex-shrink:0" onclick="nav('inventory')">View Inventory</button>
        </div>`;
    } else {
      alertEl.style.display = 'none';
      alertEl.innerHTML = '';
    }
  }

  const allPr      = DB.a('pr');
  const prPurplCount = allPr.filter(p => !p.isPbf).length;
  const prLfCount    = allPr.filter(p => !!p.isPbf).length;
  const prDueCount   = allPr.filter(p => !['won','lost'].includes(p.status) && p.nextDate && p.nextDate <= today()).length;
  if (qs('#dash-kpi-pr-total')) qs('#dash-kpi-pr-total').innerHTML = kpiHtml('Prospects', allPr.length, 'blue');
  if (qs('#dash-kpi-pr-purpl')) qs('#dash-kpi-pr-purpl').innerHTML = kpiHtml('💜 purpl Prospects', prPurplCount, 'purple');
  if (qs('#dash-kpi-pr-lf'))    qs('#dash-kpi-pr-lf').innerHTML    = kpiHtml('🌿 LF Prospects', prLfCount, 'green');
  if (qs('#dash-kpi-pr-due'))   qs('#dash-kpi-pr-due').innerHTML   = kpiHtml('Follow-up Due', prDueCount, prDueCount > 0 ? 'red' : 'gray');

  qs('#dash-kpi-revenue').innerHTML  = kpiHtml('Revenue (30d)',   fmtC(revenue30), 'green');
  qs('#dash-kpi-accounts').innerHTML = kpiHtml('Active Accounts', ac.length,       'purple') +
    `<div style="margin-top:8px;padding:0 4px;display:flex;flex-direction:column;gap:4px">
      <div class="dash-brand-stat" onclick="dashFilterBrand('lf')" title="View Lavender Fields + purpl accounts" style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px;color:#166534;background:#dcfce7;border-radius:6px;padding:3px 8px">
        <span>🌿</span><span><strong>${lfCount}</strong> carry both purpl + Lavender Fields</span>
      </div>
      <div class="dash-brand-stat" onclick="dashFilterBrand('purpl')" title="View purpl-only accounts" style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px;color:#4B2082;background:#ede4f5;border-radius:6px;padding:3px 8px">
        <span>🟣</span><span><strong>${purplOnly}</strong> carry purpl only</span>
      </div>
      <div class="dash-brand-stat" onclick="dashFilterFulfill('direct')" title="View direct accounts" style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px;color:#4B2082;background:#ede4f5;border-radius:6px;padding:3px 8px">
        <span>🚗</span><span><strong>${directCount}</strong> direct accounts</span>
      </div>
      ${viaDistCount>0?`<div class="dash-brand-stat" onclick="dashFilterFulfill('dist')" title="View distributor-fulfilled accounts" style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px;color:#92400e;background:#fef3c7;border-radius:6px;padding:3px 8px">
        <span>🚚</span><span><strong>${viaDistCount}</strong> via distributor</span>
      </div>`:''}
    </div>`;
  qs('#dash-kpi-pipeline').innerHTML = kpiHtml('Open Prospects',  pipeline,        'blue');
  qs('#dash-kpi-alerts').innerHTML   = kpiHtml('Alerts', overdue+lowStock, overdue+lowStock>0?'red':'gray');

  renderAttention();
  renderReorderPredictions();
  renderInvoiceReminders();

  // Pending combined invoice notifications (portal orders awaiting invoicing)
  const pendingInvs = DB.a('pending_invoices').filter(x => x.status === 'pending');
  if (pendingInvs.length) {
    const el = qs('#dash-attention');
    if (el) {
      el.innerHTML = pendingInvs.map(n => `
        <div class="attn-item" style="border-left:3px solid #4a7c59">
          <div class="attn-icon">📄</div>
          <div class="attn-info" style="flex:1">
            <div class="attn-name">${escHtml(n.accountName||'')} — ready to invoice</div>
            <div class="attn-reason">New combined order · purpl + LF</div>
          </div>
          <button class="btn xs primary" onclick="nav('invoices')">Review &amp; Invoice</button>
        </div>`).join('') + el.innerHTML;
    }
  }

  renderFollowUps();
  renderPendingOrders();
  renderInvoiceStatus();
  renderProjections();
  renderProdPlan();
  renderCadenceOverdue();
  renderDistDashKPIs();
  renderLfDashKpis();
}

function renderQuickNotes() {
  const el = qs('#dash-quick-notes');
  if (!el) return;
  const notes = DB.a('quick_notes').slice().sort((a,b)=>b.ts-a.ts).slice(0,8);
  if (!notes.length) { el.innerHTML = '<div class="empty" style="padding:16px">No notes yet.</div>'; return; }
  el.innerHTML = notes.map(n=>`
    <div class="qn-item">
      <div class="qn-meta">${n.author||'Team'} &nbsp;·&nbsp; ${fmtDt(n.ts)}</div>
      <div class="qn-text">${escHtml(n.text)}</div>
      <button class="btn xs red" style="margin-top:4px" onclick="deleteQuickNote('${n.id}')">Delete</button>
    </div>`).join('');
}

// ── Dashboard personal scratchpad (localStorage) ─────────
let _scratchDebounceTimer = null;
function loadScratchpad() {
  const el = qs('#dash-scratchpad');
  if (!el) return;
  el.value = localStorage.getItem('pbf_dash_notes') || '';
}
function debounceSaveScratchpad() {
  clearTimeout(_scratchDebounceTimer);
  _scratchDebounceTimer = setTimeout(() => {
    const el = qs('#dash-scratchpad');
    if (!el) return;
    localStorage.setItem('pbf_dash_notes', el.value);
    const savedEl = qs('#dash-scratchpad-saved');
    if (savedEl) { savedEl.style.opacity = '1'; setTimeout(() => { savedEl.style.opacity = '0'; }, 1200); }
  }, 500);
}

function addQuickNote() {
  const inp = qs('#qn-input');
  const text = (inp?.value||'').trim();
  if (!text) return;
  const note = { id: uid(), text, author: window._currentUser?.email||'Team', ts: Date.now() };
  DB.push('quick_notes', note);
  inp.value = '';
  renderQuickNotes();
}

function deleteQuickNote(id) {
  DB.remove('quick_notes', id);
  renderQuickNotes();
}

function fmtDt(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' ' +
         d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function kpiHtml(label, val, color) {
  return `<div class="kpi ${color}"><div class="num">${val}</div><div class="label">${label}</div></div>`;
}

function dashFilterBrand(val) {
  nav('accounts');
  const el = qs('#ac-brand-filter');
  if (el) { el.value = val; renderAccounts(); }
}

function dashFilterFulfill(val) {
  nav('accounts');
  _populateFulfillFilter();
  const el = qs('#ac-fulfill-filter');
  if (el) {
    // 'dist' means show all distributor-linked; pick first distributor or leave as ''
    if (val === 'dist') {
      const dists = DB.a('dist_profiles').filter(d=>d.status==='active');
      el.value = dists.length ? dists[0].id : '';
    } else {
      el.value = val;
    }
    renderAccounts();
  }
}

// Price an order. Items qty is in CASES.
// Account pricing (ac.pricing[sku]) should be price-per-case.
// Fallback: COGS per can × 2.2 markup × CANS_PER_CASE = price per case.
function calcOrderValue(o) {
  const costs = DB.obj('costs', {cogs:{}});
  const ac2   = DB.a('ac').find(a=>a.id===o.accountId);
  return (o.items||[]).reduce((s,i)=>{
    // pricePerCase: account-specific or default (COGS × markup × cans per case)
    const pricePerCase = ac2?.pricing?.[i.sku]
      || (costs.cogs[i.sku]||2.15) * 2.2 * CANS_PER_CASE;
    return s + pricePerCase * i.qty; // i.qty = cases
  }, 0);
}

// ── Needs Attention (30+ days no contact) ────────────────
function renderAttention() {
  const items = [];
  const ac = DB.a('ac');
  const todayStr = today();

  ac.filter(a=>a.status==='active').forEach(a=>{
    const last = a.lastOrder;
    const days = daysAgo(last);
    if (days >= 30) {
      const urgency = days >= 60 ? 'red' : 'amber';
      const borderColor = urgency === 'red' ? '#dc2626' : '#d97706';
      const isDistFulfilled = a.fulfilledBy && a.fulfilledBy !== 'direct';
      if (isDistFulfilled) {
        const dist = DB.a('dist_profiles').find(d=>d.id===a.fulfilledBy);
        items.push({icon:'⚠️', name:a.name, reason:`No order in ${days} days — fulfilled via ${dist?.name||'distributor'}`, action:`openAccount('${a.id}')`, accountId:a.id, borderColor});
      } else {
        items.push({icon:'🕐', name:a.name, reason:`No order in ${days} days`, action:`openAccount('${a.id}')`, accountId:a.id, borderColor});
      }
    }
  });

  SKUS.forEach(s=>{
    const inv = DB.a('iv');
    const oh = inv.filter(i=>i.sku===s.id&&i.type==='in').reduce((t,i)=>t+i.qty,0)
             - inv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
    if (oh < 48) items.push({icon:'📦', name:`${s.label} — Low Stock`, reason:`${oh} units on hand`, action:`nav('inventory')`, borderColor:'#d97706'});
  });

  DB.a('pr').filter(p=>p.nextDate&&p.nextDate<todayStr&&!['won','lost'].includes(p.status)).forEach(p=>{
    items.push({icon:'🎯', name:p.name, reason:`Follow-up overdue: ${p.nextAction||'check in'}`, action:`openProspect('${p.id}')`, borderColor:'#d97706'});
  });

  // Accounts with overdue follow-up dates and no newer contact logged
  ac.filter(a=>a.status==='active'&&a.nextFollowUp&&a.nextFollowUp<todayStr).forEach(a=>{
    const lastContact = acLastContacted(a);
    if (!lastContact || lastContact < a.nextFollowUp) {
      items.push({icon:'📅', name:a.name, reason:`Follow-up overdue — was due ${fmtD(a.nextFollowUp)}`, action:`openAccount('${a.id}')`, accountId:a.id, borderColor:'#d97706'});
    }
  });

  // Overdue distributor invoices
  DB.a('dist_invoices').filter(i=>i.status==='unpaid'&&i.dueDate&&i.dueDate<todayStr).forEach(i=>{
    const d = DB.a('dist_profiles').find(x=>x.id===i.distId);
    items.push({icon:'💸', name:`${d?.name||'Distributor'} — Invoice Overdue`, reason:`${fmtC(i.total)} due ${fmtD(i.dueDate)}`, action:`openDistributor('${i.distId}')`, borderColor:'#dc2626'});
  });

  // Distributors with no contact in 30+ days
  DB.a('dist_profiles').filter(d=>d.status==='active').forEach(d=>{
    const out = (d.outreach||[]).slice().sort((a,b)=>b.date>a.date?1:-1);
    const lastDate = out[0]?.date || d.lastContacted || null;
    if (daysAgo(lastDate) >= 30) {
      items.push({icon:'🚚', name:`${d.name} — No Recent Contact`, reason:`Last contacted ${lastDate?daysAgo(lastDate)+' days ago':'never'}`, action:`openDistributor('${d.id}')`, borderColor:'#d97706'});
    }
  });

  // Overdue distributor follow-ups
  DB.a('dist_profiles').filter(d=>d.nextFollowup&&d.nextFollowup<todayStr).forEach(d=>{
    items.push({icon:'📅', name:`${d.name} — Follow-Up Overdue`, reason:`Scheduled ${fmtD(d.nextFollowup)}`, action:`openDistributor('${d.id}')`, borderColor:'#d97706'});
  });

  // Sample follow-ups — prospects/accounts where a sample was sent 14+ days ago and follow-up is not done
  const _smpSources = [
    ...DB.a('pr').filter(p=>!['won','lost'].includes(p.status)),
    ...DB.a('ac').filter(a=>a.status==='active'),
  ];
  _smpSources.forEach(r=>{
    (r.samples||[]).forEach(s=>{
      if (s.followUpDone) return;
      const age = daysAgo(s.date);
      if (age < 14) return;
      const isPr = !!DB.a('pr').find(x=>x.id===r.id);
      items.push({
        icon:'🧪',
        name: r.name,
        reason:`Sample sent ${age} days ago — follow-up pending`,
        action: isPr ? `openProspect('${r.id}')` : `openAccount('${r.id}')`,
        borderColor:'#d97706',
      });
    });
  });

  // Update badge
  const badge = qs('#dash-attention-badge');
  if (badge) {
    if (items.length > 0) {
      badge.textContent = items.length;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  const el = qs('#dash-attention');
  if (!el) return;
  if (!items.length) {
    el.innerHTML = '<div class="empty" style="color:var(--green)">✓ All clear — no immediate action needed.</div>';
    return;
  }
  el.innerHTML = items.slice(0,10).map(i=>`
    <div class="attn-item" style="cursor:pointer;border-left:3px solid ${i.borderColor||'#d97706'}" onclick="${i.action}">
      <div class="attn-icon">${i.icon}</div>
      <div class="attn-info" style="flex:1"><div class="attn-name">${escHtml(i.name)}</div><div class="attn-reason">${escHtml(i.reason)}</div></div>
      ${i.accountId ? `<button class="btn xs" onclick="event.stopPropagation();openAccount('${i.accountId}')" title="Log contact">Log Contact</button>` : ''}
    </div>`).join('');
}

// ── Upcoming Follow-ups (next 14 days from notes / prospects) ─
function renderFollowUps() {
  const items = [];
  const now   = today();
  const in14  = new Date(Date.now()+14*864e5).toISOString().slice(0,10);

  DB.a('ac').forEach(a=>{
    if (a.nextFollowUp && a.nextFollowUp <= in14) {
      const daysUntil = Math.ceil((new Date(a.nextFollowUp+'T12:00:00')-Date.now())/864e5);
      items.push({type:'account', name:a.name, date:a.nextFollowUp, action:'Follow up', id:a.id, daysUntil});
      return;
    }
    if (!a.notes?.length) return;
    const ln = a.notes[a.notes.length-1];
    if (ln?.nextDate && ln.nextDate <= in14) {
      const daysUntil = Math.ceil((new Date(ln.nextDate+'T12:00:00')-Date.now())/864e5);
      items.push({type:'account', name:a.name, date:ln.nextDate, action:ln.nextAction||'Follow up', id:a.id, daysUntil});
    }
  });

  DB.a('pr').filter(p=>!['won','lost'].includes(p.status)).forEach(p=>{
    if (p.nextDate && p.nextDate <= in14) {
      const daysUntil = Math.ceil((new Date(p.nextDate+'T12:00:00')-Date.now())/864e5);
      items.push({type:'prospect', name:p.name, date:p.nextDate, action:p.nextAction||'Follow up', id:p.id, daysUntil});
    }
  });

  items.sort((a,b)=>a.date>b.date?1:-1);

  // Update badge
  const badge = qs('#dash-followup-badge');
  if (badge) {
    if (items.length > 0) { badge.textContent = items.length; badge.style.display = 'inline-flex'; }
    else { badge.style.display = 'none'; }
  }

  const el = qs('#dash-followups');
  if (!el) return;

  function chipHtml(daysUntil) {
    let color, label;
    if (daysUntil <= 0)      { color='background:#fee2e2;color:#991b1b'; label = daysUntil===0?'Today':'Overdue'; }
    else if (daysUntil <= 2) { color='background:#fef3c7;color:#92400e'; label = daysUntil===1?'Tomorrow':'in 2d'; }
    else if (daysUntil <= 7) { color='background:#dbeafe;color:#1e40af'; label = 'in '+daysUntil+'d'; }
    else                     { color='background:#f3f4f6;color:#6b7280'; label = 'in '+daysUntil+'d'; }
    return `<span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:12px;${color}">${label}</span>`;
  }

  el.innerHTML = items.length ? items.slice(0,10).map(i=>`
    <div class="attn-item" onclick="${i.type==='account'?`openAccount('${i.id}')`:`openProspect('${i.id}')`}" style="cursor:pointer">
      <div class="attn-icon">${i.type==='account'?'📅':'🎯'}</div>
      <div class="attn-info" style="flex:1">
        <div class="attn-name">${escHtml(i.name)}</div>
        <div class="attn-reason">${escHtml(i.action)} &middot; ${fmtD(i.date)}</div>
      </div>
      ${chipHtml(i.daysUntil)}
      <button class="btn xs green" onclick="event.stopPropagation();dashMarkFollowUpDone('${i.id}','${i.type}')" title="Mark done">Done</button>
    </div>`).join('') : '<div class="empty">No follow-ups scheduled in the next 14 days</div>';
}

function dashMarkFollowUpDone(id, type) {
  if (type === 'account') {
    const entry = { id: uid(), date: today(), type: 'outreach', note: 'Follow-up completed', ts: Date.now() };
    DB.update('ac', id, x => ({...x, nextFollowUp: null, outreach: [...(x.outreach||[]), entry]}));
  } else {
    const entry = { id: uid(), date: today(), type: 'outreach', note: 'Follow-up completed', ts: Date.now() };
    DB.update('pr', id, x => ({...x, nextDate: null, nextAction: null, outreach: [...(x.outreach||[]), entry]}));
  }
  renderFollowUps();
  toast('Follow-up marked done');
}

// ── Reorder Predictions ───────────────────────────────────
function renderReorderPredictions() {
  const el = qs('#dash-reorder');
  if (!el) return;
  const accounts = DB.a('ac').filter(a => a.status === 'active');
  const orders = DB.a('orders').filter(o => o.status !== 'cancelled');
  const predictions = [];

  accounts.forEach(a => {
    const acOrds = orders.filter(o => o.accountId === a.id)
      .sort((x, y) => x.created > y.created ? 1 : -1);
    if (acOrds.length < 2) return;

    const intervals = [];
    for (let i = 1; i < acOrds.length; i++) {
      const d1 = new Date(acOrds[i-1].created);
      const d2 = new Date(acOrds[i].created);
      const diff = Math.round((d2 - d1) / 86400000);
      if (diff > 0) intervals.push(diff);
    }
    if (!intervals.length) return;

    const avgInterval = Math.round(intervals.reduce((s, v) => s + v, 0) / intervals.length);
    const lastOrdDate = acOrds[acOrds.length - 1].created;
    const daysUntilDue = avgInterval - daysAgo(lastOrdDate);

    if (daysUntilDue <= 14) {
      predictions.push({ a, avgInterval, daysUntilDue, lastOrdDate });
    }
  });

  predictions.sort((a, b) => a.daysUntilDue - b.daysUntilDue);

  if (!predictions.length) {
    el.innerHTML = '<div class="empty" style="padding:16px">No reorders predicted in the next 14 days.</div>';
    return;
  }

  el.innerHTML = predictions.slice(0, 6).map(({ a, avgInterval, daysUntilDue, lastOrdDate }) => {
    const overdue = daysUntilDue < 0;
    const color = overdue ? 'var(--red)' : daysUntilDue <= 7 ? '#d97706' : 'var(--green)';
    const label = overdue ? `${Math.abs(daysUntilDue)}d overdue` : daysUntilDue === 0 ? 'due today' : `in ${daysUntilDue}d`;
    return `<div class="attn-item" style="cursor:pointer" onclick="openAccount('${a.id}')">
      <div class="attn-icon">🔄</div>
      <div class="attn-info" style="flex:1">
        <div class="attn-name">${escHtml(a.name)}</div>
        <div class="attn-reason">Every ~${avgInterval}d · last ${fmtD(lastOrdDate)}</div>
      </div>
      <span style="font-size:12px;font-weight:600;color:${color}">${label}</span>
    </div>`;
  }).join('');
}

// ── Cadence Overdue ───────────────────────────────────────
function renderCadenceOverdue() {
  const card = qs('#dash-cadence-card');
  const el   = qs('#dash-cadence-overdue');
  if (!el) return;

  const flags = [];

  // Active accounts with no welcome email sent
  DB.a('ac').filter(a=>a.status==='active').forEach(a=>{
    const cadence = a.cadence||[];
    if (!cadence.some(c=>c.stage==='approved_welcome') && daysAgo(a.created)>=1) {
      flags.push({id:a.id, name:a.name, reason:'Welcome email not sent', invoiceId:null});
    }
  });

  // Invoices without a sent notification
  DB.a('ac').forEach(a=>{
    const sentIds = new Set((a.cadence||[]).filter(c=>c.stage==='invoice_sent').map(c=>c.invoiceId));
    DB.a('iv').filter(x=>x.accountId===a.id&&x.number&&!sentIds.has(x.id)).forEach(inv=>{
      flags.push({id:a.id, name:a.name, reason:`Invoice ${inv.number} not sent to retailer`, invoiceId:inv.id});
    });
    DB.a('lf_invoices').filter(x=>x.accountId===a.id&&!sentIds.has(x.id)).forEach(inv=>{
      flags.push({id:a.id, name:a.name, reason:`Invoice ${inv.number||inv.id} not sent to retailer`, invoiceId:inv.id});
    });
  });

  if (!flags.length) { if (card) card.style.display='none'; return; }
  if (card) card.style.display='';
  el.innerHTML = flags.slice(0,8).map(f=>`
    <div class="attn-item">
      <div class="attn-icon">⚠️</div>
      <div class="attn-info" style="flex:1">
        <div class="attn-name">${escHtml(f.name)}</div>
        <div class="attn-reason">${escHtml(f.reason)}</div>
      </div>
      <button class="btn xs primary" onclick="openAccountToEmailsTab('${f.id}')">Send Now</button>
    </div>`).join('');
}

// ── Pending Orders (with reschedule button) ───────────────
function renderPendingOrders() {
  const pending = DB.a('orders').filter(o=>o.status==='pending').sort((a,b)=>a.dueDate>b.dueDate?1:-1);
  const el = qs('#dash-pending-orders');
  if (!el) return;
  el.innerHTML = pending.length ? pending.slice(0,8).map(o=>{
    const ac2      = DB.a('ac').find(a=>a.id===o.accountId);
    const isOverdue = o.dueDate < today();
    return `<div class="attn-item">
      <div class="attn-icon" onclick="openOrderDetail('${o.id}')" style="cursor:pointer">${isOverdue?'⚠️':'📋'}</div>
      <div class="attn-info" style="flex:1;cursor:pointer" onclick="openOrderDetail('${o.id}')">
        <div class="attn-name">${escHtml(ac2?.name||'Unknown')}</div>
        <div class="attn-reason">${(o.items||[]).map(i=>`${skuBadge(i.sku)} ×${i.qty}`).join(' ')} &middot; Due ${fmtD(o.dueDate)}${isOverdue?' <span class="badge red">Overdue</span>':''}</div>
      </div>
      <button class="btn xs" onclick="rescheduleOrder('${o.id}')" title="Change due date">Reschedule</button>
    </div>`;
  }).join('') : '<div class="empty">No pending orders</div>';
}

function rescheduleOrder(id) {
  const o = DB.a('orders').find(x=>x.id===id);
  if (!o) return;
  const newDate = prompt('New due date (YYYY-MM-DD):', o.dueDate);
  if (!newDate || newDate===o.dueDate) return;
  DB.update('orders', id, x=>({...x, dueDate:newDate}));
  renderDash();
  toast('Due date updated');
}

// ── Invoice Status ────────────────────────────────────────
const INVOICE_STATUS = {
  none:     {label:'Not Invoiced',    cls:'gray'},
  invoiced: {label:'Invoiced',        cls:'blue'},
  paid:     {label:'Paid',            cls:'green'},
  overdue:  {label:'Invoice Overdue', cls:'red'},
};

function renderInvoiceStatus() {
  const delivered = DB.a('orders').filter(o=>o.status==='delivered');
  const terms     = DB.obj('settings',{payment_terms:30}).payment_terms || 30;

  let notInvoiced=0, invoiced=0, paid=0, overdueList=[];

  delivered.forEach(o=>{
    const st = o.invoiceStatus||'none';
    if (st==='paid')     { paid++; return; }
    if (st==='invoiced') {
      if (daysAgo(o.invoiceDate||o.dueDate) > terms) overdueList.push(o);
      else invoiced++;
      return;
    }
    notInvoiced++;
  });

  const el = qs('#dash-invoice-status');
  if (!el) return;

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">
      <div style="text-align:center;padding:10px;background:var(--surface);border-radius:8px;border:1px solid var(--border)">
        <div style="font-size:20px;font-weight:700">${notInvoiced}</div>
        <div style="font-size:11px;color:var(--muted)">Not Invoiced</div>
      </div>
      <div style="text-align:center;padding:10px;background:var(--surface);border-radius:8px;border:1px solid var(--border)">
        <div style="font-size:20px;font-weight:700;color:var(--blue)">${invoiced}</div>
        <div style="font-size:11px;color:var(--muted)">Invoiced</div>
      </div>
      <div style="text-align:center;padding:10px;background:var(--surface);border-radius:8px;border:1px solid var(--border)">
        <div style="font-size:20px;font-weight:700;color:var(--green)">${paid}</div>
        <div style="font-size:11px;color:var(--muted)">Paid</div>
      </div>
      <div style="text-align:center;padding:10px;background:var(--surface);border-radius:8px;border:1px solid var(--border)">
        <div style="font-size:20px;font-weight:700;color:var(--red)">${overdueList.length}</div>
        <div style="font-size:11px;color:var(--muted)">Overdue</div>
      </div>
    </div>
    ${overdueList.length ? overdueList.map(o=>{
      const ac2 = DB.a('ac').find(a=>a.id===o.accountId);
      return `<div class="attn-item">
        <div class="attn-icon">💰</div>
        <div class="attn-info"><div class="attn-name">${escHtml(ac2?.name||'Unknown')}</div><div class="attn-reason">Invoice overdue &middot; ${fmtD(o.dueDate)}</div></div>
        <button class="btn xs green" onclick="setInvStatus('${o.id}','paid')">Mark Paid</button>
      </div>`;
    }).join('') : '<div class="empty">No invoice issues</div>'}
    ${(()=>{
      const rInvs = DB.a('retail_invoices').sort((a,b)=>b.date>a.date?1:-1);
      if (!rInvs.length) return '';
      const rows = rInvs.map(inv=>{
        const acName = DB.a('ac').find(a=>a.id===inv.accountId)?.name || '—';
        const statusCls = inv.status==='paid'?'green': daysAgo(inv.dueDate)>0?'red':'blue';
        return `<tr>
          <td>${inv.invoiceNumber||'—'}</td>
          <td>${fmtD(inv.date)}</td>
          <td>${acName}</td>
          <td>${fmtD(inv.dueDate)}</td>
          <td>${fmtC(inv.total||0)}</td>
          <td><span class="badge ${statusCls}">${inv.status==='paid'?'Paid':daysAgo(inv.dueDate)>0?'Overdue':'Unpaid'}</span></td>
          <td style="white-space:nowrap">
            <button class="btn xs" onclick="generateInvoicePrint('${inv.id}')">🖨️ Print / PDF</button>
            ${inv.status!=='paid'?`<button class="btn xs green" onclick="markRetailInvPaid('${inv.id}')">Mark Paid</button>`:''}
            <button class="btn xs red" onclick="deleteRetailInv('${inv.id}')">✕</button>
          </td>
        </tr>`;
      }).join('');
      return `<div style="margin-top:16px">
        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Invoices</div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>Invoice #</th><th>Date</th><th>Account</th><th>Due</th><th>Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
    })()}`;
}

// ── Invoice Reminders ─────────────────────────────────────
// Surfaces unpaid invoices due in 7 days or already overdue,
// with a Send Reminder button that fires a Resend email and
// marks the invoice so it won't resurface.
function renderInvoiceReminders() {
  const queue = [];

  DB.a('iv').forEach(inv => {
    if (inv.status === 'paid' || !inv.due || !inv.accountId || !inv.number) return;
    if (inv.reminderSentAt) return;
    const days = daysAgo(inv.due); // negative = future, positive = past
    if (days !== -7 && days <= 0) return;
    const ac = DB.a('ac').find(x => x.id === inv.accountId);
    if (!ac || !ac.email) return;
    queue.push({ inv, ac, collection: 'iv', isOverdue: days > 0, amount: inv.amount });
  });

  DB.a('lf_invoices').forEach(inv => {
    if (inv.status === 'paid' || !inv.due || !inv.accountId) return;
    if (inv.reminderSentAt) return;
    const days = daysAgo(inv.due);
    if (days !== -7 && days <= 0) return;
    const ac = DB.a('ac').find(x => x.id === inv.accountId);
    if (!ac || !ac.email) return;
    queue.push({ inv, ac, collection: 'lf_invoices', isOverdue: days > 0, amount: inv.total });
  });

  // Find or create container, inserted before #dash-dist-kpis
  let el = document.getElementById('dash-invoice-reminders');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dash-invoice-reminders';
    el.className = 'card';
    el.style.marginBottom = '20px';
    const anchor = document.getElementById('dash-dist-kpis');
    if (anchor) anchor.parentNode.insertBefore(el, anchor);
    else document.getElementById('page-dash')?.appendChild(el);
  }

  if (!queue.length) { el.style.display = 'none'; return; }
  el.style.display = '';

  el.innerHTML = `
    <div class="section-hdr">
      <h2>💌 Invoice Reminders <span style="display:inline-block;min-width:20px;height:20px;line-height:20px;text-align:center;border-radius:10px;font-size:11px;font-weight:700;padding:0 5px;background:var(--red);color:#fff;margin-left:6px;vertical-align:middle">${queue.length}</span></h2>
      <small style="color:var(--muted);font-size:12px">Unpaid invoices due soon or overdue</small>
    </div>
    <div id="dash-inv-reminders-list">
      ${queue.map(({ inv, ac, collection, isOverdue, amount }) => `
        <div class="attn-item" id="dir-${inv.id}">
          <div class="attn-icon">${isOverdue ? '🔴' : '🟡'}</div>
          <div class="attn-info" style="flex:1">
            <div class="attn-name">${escHtml(ac.name)} — ${escHtml(inv.number || '')}</div>
            <div class="attn-reason">${isOverdue ? 'Overdue' : 'Due in 7 days'} · ${fmtC(amount || 0)} · Due ${fmtD(inv.due)}</div>
          </div>
          <button class="btn xs primary" onclick="sendInvoiceReminder('${inv.id}','${collection}')">Send Reminder</button>
        </div>
      `).join('')}
    </div>`;
}

async function sendInvoiceReminder(invId, collection) {
  const inv = DB.a(collection).find(x => x.id === invId);
  if (!inv) return;
  const ac = DB.a('ac').find(x => x.id === inv.accountId);
  if (!ac || !ac.email) { toast('No email on file for this account'); return; }

  const isOverdue = daysAgo(inv.due) > 0;
  const subject = isOverdue
    ? `Payment reminder — ${inv.number || ''} (${ac.name})`
    : `Invoice due soon — ${inv.number || ''} (${ac.name})`;
  const html = buildInvoiceReminderHTML(inv, collection, isOverdue);

  try {
    const result = await callSendEmail(ac.email, 'lavender@pbfwholesale.com', subject, html);
    toast('Reminder sent ✓');
    DB.update(collection, invId, x => ({ ...x, reminderSentAt: new Date().toISOString() }));
    const entry = {
      id: uid(), stage: 'invoice_reminder',
      sentAt: new Date().toISOString(),
      sentBy: 'graham', method: 'resend',
      invoiceId: invId, invoiceRef: inv.number || '',
    };
    if (result?.id) entry.sentMessageId = result.id;
    DB.update('ac', ac.id, a => ({
      ...a,
      lastContacted: today(),
      cadence: [...(a.cadence || []), entry],
    }));
    // Remove row without full re-render
    const row = document.getElementById('dir-' + invId);
    if (row) row.remove();
    const list = document.getElementById('dash-inv-reminders-list');
    if (list && !list.children.length) {
      document.getElementById('dash-invoice-reminders').style.display = 'none';
    }
  } catch (err) {
    toast('Failed to send reminder — ' + (err.message || 'unknown error'));
  }
}

function buildInvoiceReminderHTML(inv, collection, isOverdue) {
  const ac = DB.a('ac').find(x => x.id === inv.accountId) || {};
  const amount = collection === 'lf_invoices' ? (inv.total || 0) : (inv.amount || 0);
  const invSettings = DB.obj('invoice_settings') || {};
  const dueLabel = inv.due ? new Date(inv.due+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}) : 'Net 30';
  const isLf = collection === 'lf_invoices';
  const accentColor = isLf ? '#4a7c59' : '#2D1B4E';
  const accentLight = isLf ? '#dcfce7' : '#ede4f5';
  const headerGrad = isLf
    ? 'background:linear-gradient(135deg,#2d5a3d 0%,#4a7c59 100%)'
    : 'background:linear-gradient(135deg,#2D1B4E 0%,#4a2d7a 100%)';
  const contacts = ac.contacts || [];
  const primary = contacts.find(c => c.isPrimary) || contacts[0] || {};
  const contactName = primary.name || ac.contact || 'there';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0eff4;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0eff4;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="${headerGrad};padding:24px 40px">
    <div style="color:rgba(255,255,255,0.75);font-size:11px;text-transform:uppercase;letter-spacing:0.15em;margin-bottom:4px">Pumpkin Blossom Farm · Wholesale</div>
    <div style="color:#fff;font-size:22px;font-weight:700">${isOverdue ? 'Payment Overdue' : 'Invoice Due Soon'}</div>
  </td></tr>
  <tr><td style="background:${accentColor};height:4px"></td></tr>
  <tr><td style="padding:28px 40px">
    <p style="font-size:15px;color:#1a1a2e;margin:0 0 16px">Hi ${escHtml(contactName)},</p>
    <p style="font-size:15px;color:#1a1a2e;margin:0 0 16px">
      ${isOverdue
        ? `This is a friendly reminder that invoice <strong>${escHtml(inv.number||'')}</strong> for <strong>${escHtml(ac.name||'')}</strong> was due on <strong>${dueLabel}</strong> and remains unpaid.`
        : `Invoice <strong>${escHtml(inv.number||'')}</strong> for <strong>${escHtml(ac.name||'')}</strong> is due on <strong>${dueLabel}</strong> — just a heads up!`}
    </p>
    <div style="background:${accentLight};border-radius:8px;padding:20px 24px;margin:20px 0;text-align:center">
      <div style="font-size:13px;color:#6b7280;margin-bottom:4px">Amount Due</div>
      <div style="font-size:30px;font-weight:700;color:${accentColor}">$${parseFloat(amount).toFixed(2)}</div>
      <div style="font-size:12px;color:#9ca3af;margin-top:4px">Invoice ${escHtml(inv.number||'')} · Due ${dueLabel}</div>
    </div>
    ${invSettings.stripeLink ? `<div style="margin:20px 0;text-align:center"><a href="${escHtml(invSettings.stripeLink)}" style="display:inline-block;background:${accentColor};color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:500">Pay Now →</a></div>` : ''}
    <p style="font-size:14px;color:#374151;margin:16px 0 0">Questions? Reply to this email or call 603-748-3038.</p>
    <p style="font-size:14px;color:#374151;margin:8px 0 0">Thank you,<br><strong>Graham Biagiotti</strong><br>Pumpkin Blossom Farm</p>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:16px 40px;text-align:center;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb">
    Pumpkin Blossom Farm LLC · 393 Pumpkin Hill Rd · Warner, NH 03278<br>
    lavender@pbfwholesale.com · 603-748-3038
  </td></tr>
</table></td></tr></table></body></html>`;
}

function setInvStatus(id, status) {
  const extra = status==='invoiced' ? {invoiceDate:today()} : status==='paid' ? {paidDate:today()} : {};
  DB.update('orders', id, o=>({...o, invoiceStatus:status, ...extra}));
  // Only refresh the order detail modal if it's already open (don't pop it open from dashboard)
  const detailModal = document.getElementById('modal-order-detail');
  if (detailModal && detailModal.classList.contains('open')) openOrderDetail(id);
  renderInvoiceStatus();
  toast(status==='paid'?'Marked as paid':'Invoice updated');
}

// ══════════════════════════════════════════════════════════
//  RETAIL INVOICES (standalone customer invoices)
// ══════════════════════════════════════════════════════════

// purpl invoice SKUs
const IV_SKUS = [
  {id:'classic',   name:'Classic 12-pack'},
  {id:'blueberry', name:'Blueberry 12-pack'},
  {id:'peach',     name:'Peach 12-pack'},
  {id:'raspberry', name:'Raspberry 12-pack'},
  {id:'variety',   name:'Variety 12-pack'},
];

// openAddInv kept as entry-point alias (called from portal approval flows etc.)
function openAddInv(accountId=null, priceType='direct', cases=null, notesText='') {
  openInvModal(null, accountId, priceType, notesText);
}

function openInvModal(id, prefillAccountId=null, prefillTier='direct', prefillNotes='') {
  const isNew = !id;
  const inv   = id ? DB.a('iv').find(x => x.id === id) : null;

  qs('#iv-modal-title').textContent = isNew ? 'New purpl Invoice' : 'Edit purpl Invoice';

  if (isNew) {
    const existing = DB.a('iv').filter(x => x.number);
    const num = existing.length + 1;
    if (qs('#iv-number')) qs('#iv-number').value = 'INV-' + String(num).padStart(3,'0');
    if (qs('#iv-date'))   qs('#iv-date').value   = today();
    const terms  = DB.obj('invoice_settings',{}).terms || 30;
    const dueStr = new Date(Date.now() + terms * 864e5).toISOString().slice(0,10);
    if (qs('#iv-due'))    qs('#iv-due').value    = dueStr;
    if (qs('#iv-status')) qs('#iv-status').value = 'draft';
    if (qs('#iv-notes'))  qs('#iv-notes').value  = prefillNotes || '';
    if (qs('#iv-delete-btn')) qs('#iv-delete-btn').style.display = 'none';
  } else if (inv) {
    if (qs('#iv-number')) qs('#iv-number').value = inv.number||'';
    if (qs('#iv-date'))   qs('#iv-date').value   = inv.date||today();
    if (qs('#iv-due'))    qs('#iv-due').value    = inv.due||'';
    if (qs('#iv-status')) qs('#iv-status').value = inv.status||'draft';
    if (qs('#iv-notes'))  qs('#iv-notes').value  = inv.notes||'';
    if (qs('#iv-delete-btn')) {
      qs('#iv-delete-btn').style.display = '';
      qs('#iv-delete-btn').onclick = () => deleteInvRecord(id);
    }
  }

  // Account selector
  const acSel = qs('#iv-account');
  if (acSel) {
    const accounts = DB.a('ac').filter(a => a.status !== 'inactive').sort((a,b) => (a.name||'') < (b.name||'') ? -1 : 1);
    acSel.innerHTML = '<option value="">— Select Account —</option>' +
      accounts.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
    const acId = inv?.accountId || prefillAccountId;
    if (acId) acSel.value = acId;
  }

  // Pricing tier
  const tierSel = qs('#iv-tier');
  if (tierSel) tierSel.value = inv?.priceType || prefillTier || 'direct';

  // Line items
  _ivRenderLineRows(inv?.lineItems || []);

  qs('#iv-save-btn').onclick = () => saveInv(id, isNew);

  const ivSendBtn = qs('#iv-send-btn');
  if (ivSendBtn) {
    ivSendBtn.style.display = isNew ? 'none' : '';
    ivSendBtn.onclick = () => {
      const inv = DB.a('iv').find(x => x.id === id);
      if (!inv) { toast('Save the invoice before sending'); return; }
      const ac = DB.a('ac').find(x => x.id === inv.accountId) || {};
      const to = ac.email || '';
      if (!to) { toast('No email address on file for this account'); return; }
      const html    = buildPurplInvoiceEmailHTML(inv);
      const subject = `Invoice ${inv.number||''} from Pumpkin Blossom Farm — ${ac.name||inv.accountName||''}`;
      ivSendBtn.disabled = true; ivSendBtn.textContent = 'Sending…';
      callSendEmail(to, 'lavender@pbfwholesale.com', subject, html)
        .then((result) => {
          toast('Invoice sent ✓');
          const entry = {
            id: uid(), stage: 'invoice_sent',
            sentAt: new Date().toISOString(),
            sentBy: 'graham', method: 'resend',
            invoiceId: inv.id, invoiceRef: inv.number,
          };
          if (result?.id) entry.sentMessageId = result.id;
          DB.update('ac', ac.id, a => ({
            ...a, lastContacted: today(),
            cadence: [...(a.cadence||[]), entry],
          }));
          renderAccounts();
          const updatedAc = DB.a('ac').find(x => x.id === ac.id);
          if (updatedAc) { renderAccountOutreach(updatedAc); renderMacEmailsTab(ac.id); }
        })
        .catch(() => { toast('Failed to send — check connection'); })
        .finally(() => { ivSendBtn.disabled = false; ivSendBtn.textContent = 'Send Email'; });
    };
  }

  openModal('modal-add-inv');
}

function _ivGetPrice(ac, tier) {
  if (!ac) return 0;
  if (tier === 'direct') return parseFloat(ac.pricePerCaseDirect) || 0;
  if (tier === 'dist')   return parseFloat(ac.pricePerCaseDist)   || 0;
  if (tier === 'custom') return parseFloat(ac.pricePerCaseCustom) || 0;
  return 0;
}

function _ivRenderLineRows(existingItems) {
  const container = qs('#iv-line-items');
  if (!container) return;
  container.innerHTML = '';
  const acId = qs('#iv-account')?.value;
  const tier = qs('#iv-tier')?.value || 'direct';
  const ac   = acId ? DB.a('ac').find(x => x.id === acId) : null;
  const basePrice = _ivGetPrice(ac, tier);
  IV_SKUS.forEach(sku => {
    const existing  = existingItems.find(x => x.skuId === sku.id);
    const ppc       = existing?.pricePerCase ?? basePrice;
    const cases     = existing?.cases || 0;
    const lineTotal = cases * ppc;
    const row = document.createElement('div');
    row.className     = 'lfi-item-row';
    row.dataset.skuId = sku.id;
    row.innerHTML = `
      <span style="flex:1;font-size:13px;font-weight:500">${escHtml(sku.name)}</span>
      <input class="iv-cases" type="number" min="0" step="1" value="${cases}" style="width:70px" oninput="_ivRowCalc('${sku.id}')">
      <span class="lfi-cases-label">cases</span>
      <span class="lfi-units-display">= <strong class="iv-units">${cases * CANS_PER_CASE}</strong> cans</span>
      <input class="iv-ppc" type="number" min="0" step="0.01" value="${ppc||''}" placeholder="$/cs" style="width:76px" oninput="_ivRowCalc('${sku.id}')">
      <span class="lfi-line-amt iv-line-total">${fmtC(lineTotal)}</span>`;
    container.appendChild(row);
  });
  _ivCalcTotal();
}

function ivAccountChange() {
  const acId = qs('#iv-account')?.value;
  const ac   = acId ? DB.a('ac').find(x => x.id === acId) : null;
  const tier = qs('#iv-tier')?.value || 'direct';
  const basePrice = _ivGetPrice(ac, tier);
  qs('#iv-line-items')?.querySelectorAll('.lfi-item-row').forEach(row => {
    const ppcEl = row.querySelector('.iv-ppc');
    if (ppcEl && (!ppcEl.value || ppcEl.value === '0')) {
      ppcEl.value = basePrice || '';
    }
    _ivRowCalc(row.dataset.skuId);
  });
}

function ivTierChange() {
  const acId = qs('#iv-account')?.value;
  const ac   = acId ? DB.a('ac').find(x => x.id === acId) : null;
  const tier = qs('#iv-tier')?.value || 'direct';
  const basePrice = _ivGetPrice(ac, tier);
  qs('#iv-line-items')?.querySelectorAll('.lfi-item-row').forEach(row => {
    const ppcEl = row.querySelector('.iv-ppc');
    if (ppcEl) ppcEl.value = basePrice || '';
    _ivRowCalc(row.dataset.skuId);
  });
}

function _ivRowCalc(skuId) {
  const container = qs('#iv-line-items');
  if (!container) return;
  const row = container.querySelector(`[data-sku-id="${skuId}"]`);
  if (!row) return;
  const cases = parseInt(row.querySelector('.iv-cases')?.value || 0);
  const ppc   = parseFloat(row.querySelector('.iv-ppc')?.value || 0);
  const units = cases * CANS_PER_CASE;
  const lt    = cases * ppc;
  const unitsEl = row.querySelector('.iv-units');
  const ltEl    = row.querySelector('.iv-line-total');
  if (unitsEl) unitsEl.textContent = units;
  if (ltEl)    ltEl.textContent    = fmtC(lt);
  _ivCalcTotal();
}

function _ivCalcTotal() {
  const container = qs('#iv-line-items');
  if (!container) return;
  let total = 0;
  container.querySelectorAll('.lfi-item-row').forEach(row => {
    const cases = parseInt(row.querySelector('.iv-cases')?.value || 0);
    const ppc   = parseFloat(row.querySelector('.iv-ppc')?.value || 0);
    total += cases * ppc;
  });
  const el = qs('#iv-total');
  if (el) el.textContent = fmtC(total);
}

// Legacy alias called from old oninput handlers
function calcInvTotal() { _ivCalcTotal(); }


function markRetailInvPaid(id) {
  DB.update('retail_invoices', id, i=>({...i, status:'paid', paidDate:today()}));
  renderInvoiceStatus();
  toast('Marked as paid');
}

function deleteRetailInv(id) {
  if (!confirm2('Delete this invoice?')) return;
  DB.remove('retail_invoices', id);
  renderInvoiceStatus();
  toast('Invoice deleted');
}


// ══════════════════════════════════════════════════════════
//  INVOICES PAGE
// ══════════════════════════════════════════════════════════
let _invSortKey = 'date';
let _invSortDir = -1; // -1 = desc

function sortInv(key) {
  if (_invSortKey === key) { _invSortDir *= -1; }
  else { _invSortKey = key; _invSortDir = -1; }
  renderInvoicesPage();
}


// ── Revenue Projections ───────────────────────────────────
function renderProjections() {
  const {proj30, proj60, proj90, accountsWithData} = calcProjections();
  const pendingVal = DB.a('orders').filter(o=>o.status==='pending').reduce((s,o)=>s+calcOrderValue(o),0);

  const el = qs('#dash-projections');
  if (!el) return;
  el.innerHTML = `
    <div>${kpiHtml('Projected 30d', fmtC(proj30), 'green')}</div>
    <div>${kpiHtml('Projected 60d', fmtC(proj60), 'blue')}</div>
    <div>${kpiHtml('Projected 90d', fmtC(proj90), 'purple')}</div>
    <div>${kpiHtml('Pending Orders', fmtC(pendingVal), 'amber')}</div>`;

  const note = qs('#dash-projection-notes');
  if (note) note.textContent = `Based on order history from ${accountsWithData} account${accountsWithData!==1?'s':''} with 2+ orders. Pending orders value shown separately.`;
}

function calcProjections() {
  const allOrders = DB.a('orders').filter(o=>o.status!=='cancelled');
  const accounts  = DB.a('ac').filter(a=>a.status==='active');
  const now = Date.now();
  const d30 = now+30*864e5, d60 = now+60*864e5, d90 = now+90*864e5;

  let proj30=0, proj60=0, proj90=0, accountsWithData=0;
  const velocities = [];

  accounts.forEach(ac=>{
    const acOrds = allOrders.filter(o=>o.accountId===ac.id).sort((a,b)=>a.dueDate>b.dueDate?1:-1);

    // Units in last 90 days for velocity table
    const recentOrds = acOrds.filter(o=>daysAgo(o.dueDate)<=90);
    const totalUnits = Object.fromEntries(SKUS.map(s=>[s.id,0]));
    recentOrds.forEach(o=>(o.items||[]).forEach(i=>{ totalUnits[i.sku]=(totalUnits[i.sku]||0)+i.qty; }));

    const periodDays = Math.max(7, Math.min(90, acOrds.length>0 ? Math.max(1, daysAgo(acOrds[0].dueDate)) : 90));
    const weeksInPeriod = periodDays/7;
    const weeklyUnits   = Object.fromEntries(SKUS.map(s=>[s.id, Math.round((totalUnits[s.id]||0)/weeksInPeriod*10)/10]));

    let avgDays=null, nextProjected=null, avgOrderValue=0;

    if (acOrds.length >= 2) {
      const intervals = [];
      for (let i=1;i<acOrds.length;i++) {
        const diff = (new Date(acOrds[i].dueDate+'T12:00:00')-new Date(acOrds[i-1].dueDate+'T12:00:00'))/864e5;
        if (diff>0) intervals.push(diff);
      }
      if (intervals.length) {
        avgDays        = Math.round(intervals.reduce((a,b)=>a+b,0)/intervals.length);
        avgOrderValue  = acOrds.reduce((s,o)=>s+calcOrderValue(o),0)/acOrds.length;
        accountsWithData++;

        const lastMs = new Date(acOrds[acOrds.length-1].dueDate+'T12:00:00').getTime();
        let next = lastMs + avgDays*864e5;
        while (next <= d90) {
          if (next > now) {
            if (next<=d30) proj30+=avgOrderValue;
            if (next<=d60) proj60+=avgOrderValue;
            proj90+=avgOrderValue;
            if (!nextProjected) nextProjected = new Date(next).toISOString().slice(0,10);
          }
          next += avgDays*864e5;
        }
      }
    }

    velocities.push({account:ac, avgDays, avgOrderValue, nextProjected, weeklyUnits, ordCount:acOrds.length});
  });

  return {proj30, proj60, proj90, accountsWithData, velocities};
}

// ── Production Planning dashboard card ───────────────────────
function renderProdPlan() {
  const el = qs('#dash-prod-plan');
  if (!el) return;

  // Current on-hand cans (same calculation used in renderDash KPI)
  const inv = DB.a('iv');
  const currentCans = SKUS.reduce((sum, sk) => {
    const totalIn  = inv.filter(i => i.sku === sk.id && (i.type === 'in'  || i.type === 'return')).reduce((t, i) => t + (i.qty || 0), 0);
    const totalOut = inv.filter(i => i.sku === sk.id &&  i.type === 'out').reduce((t, i) => t + (i.qty || 0), 0);
    return sum + Math.max(0, totalIn - totalOut);
  }, 0);

  // Projected 30-day demand in cans from velocity data
  const { velocities } = calcProjections();
  const totalWeeklyCases = velocities.reduce((sum, v) => {
    return sum + SKUS.reduce((s, sk) => s + (v.weeklyUnits[sk.id] || 0), 0);
  }, 0);
  const projected30Cases = Math.round(totalWeeklyCases * (30 / 7));
  const projected30Cans  = projected30Cases * CANS_PER_CASE;

  const surplus = currentCans - projected30Cans;
  const hasSurplus = surplus >= 0;

  const surplusColor  = hasSurplus ? 'var(--green)' : 'var(--red)';
  const surplusLabel  = hasSurplus
    ? `<span style="color:var(--green);font-weight:600">+${fmt(surplus)} cans buffer</span>`
    : `<span style="color:var(--red);font-weight:600">&minus;${fmt(Math.abs(surplus))} cans deficit</span>`;

  el.innerHTML = `
    <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start;margin-bottom:16px">
      <div style="flex:1;min-width:140px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px">Current Inventory</div>
        <div style="font-size:28px;font-weight:700;color:var(--text)">${fmt(currentCans)}</div>
        <div style="font-size:12px;color:var(--muted)">cans on hand</div>
      </div>
      <div style="flex:1;min-width:140px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px">Projected 30-Day Demand</div>
        <div style="font-size:28px;font-weight:700;color:var(--text)">${fmt(projected30Cans)}</div>
        <div style="font-size:12px;color:var(--muted)">${fmt(projected30Cases)} cases at ${CANS_PER_CASE} cans/case</div>
      </div>
      <div style="flex:1;min-width:140px">
        <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:4px">Surplus / Deficit</div>
        <div style="font-size:28px;font-weight:700;color:${surplusColor}">${hasSurplus ? '+' : ''}${fmt(surplus)}</div>
        <div style="font-size:12px;color:var(--muted)">cans (current &minus; projected)</div>
      </div>
    </div>
    <div style="padding:12px 16px;border-radius:8px;background:${hasSurplus ? '#f0fdf4' : '#fef3c7'};border:1px solid ${hasSurplus ? '#bbf7d0' : '#fde68a'};font-size:13px;color:${hasSurplus ? '#166534' : '#92400e'}">
      ${hasSurplus
        ? `${surplusLabel} &mdash; you have enough stock to cover projected 30-day demand.`
        : `${surplusLabel} &mdash; Schedule a production run. You need <strong>${fmt(Math.abs(surplus))} more cans</strong> (${fmt(Math.ceil(Math.abs(surplus) / CANS_PER_CASE))} cases) to meet projected demand.`}
    </div>`;
}

// ── Store by Store Velocity ───────────────────────────────
function renderVelocities() {
  const {velocities} = calcProjections();
  const el = qs('#dash-velocities');
  if (!el) return;

  el.innerHTML = velocities.length ? velocities.map(v=>{
    const totalWkly = Math.round(SKUS.reduce((s,sk)=>s+(v.weeklyUnits[sk.id]||0),0)*10)/10;
    const nextCls   = v.nextProjected && v.nextProjected < today() ? 'color:var(--red)' : 'color:var(--blue)';
    return `<tr onclick="openAccount('${v.account.id}')" style="cursor:pointer">
      <td><strong>${v.account.name}</strong><br><small style="color:var(--muted)">${v.account.territory||''}</small></td>
      <td>${v.avgDays ? v.avgDays+'d' : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${v.nextProjected ? `<span style="${nextCls}">${fmtD(v.nextProjected)}</span>` : '<span style="color:var(--muted)">—</span>'}</td>
      ${SKUS.map(s=>`<td>${v.weeklyUnits[s.id]||0}</td>`).join('')}
      <td><strong>${totalWkly}</strong></td>
      <td>${v.avgOrderValue ? fmtC(v.avgOrderValue) : '<span style="color:var(--muted)">—</span>'}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="10" class="empty">No active accounts</td></tr>';
}

// ══════════════════════════════════════════════════════════
//  PROJECTIONS PAGE (Phase 5)
// ══════════════════════════════════════════════════════════
function renderProjectionsPage() {
  // Read velocity window setting from dropdown
  const windowDays = parseInt(qs('#proj-velocity-source')?.value || '90') || 90;
  const {proj30, proj60, proj90, accountsWithData, velocities} = calcProjectionsWindow(windowDays);

  // ── Revenue Scenarios ──────────────────────────────────
  const scenarios = [
    {label:'Conservative', pct:0.75, color:'amber'},
    {label:'Expected',     pct:1.00, color:'blue'},
    {label:'Optimistic',   pct:1.25, color:'green'},
  ];
  const cards = qs('#proj-scenario-cards');
  if (cards) {
    cards.innerHTML = scenarios.map(sc=>`
      <div>${kpiHtml(sc.label+' 90d', fmtC(proj90*sc.pct), sc.color)}</div>`).join('');
  }
  const tbody = qs('#proj-scenario-body');
  if (tbody) {
    tbody.innerHTML = scenarios.map(sc=>`
      <tr>
        <td><strong>${sc.label}</strong></td>
        <td>${fmtC(proj30*sc.pct)}</td>
        <td>${fmtC(proj60*sc.pct)}</td>
        <td>${fmtC(proj90*sc.pct)}</td>
        <td style="color:var(--muted);font-size:12px">${Math.round(sc.pct*100)}% of expected velocity</td>
      </tr>`).join('');
  }
  const notes = qs('#proj-notes');
  if (notes) notes.textContent = `Based on ${accountsWithData} account${accountsWithData!==1?'s':''} with 2+ orders, using last ${windowDays==='all'?'all':windowDays} days of history.`;

  // ── SKU Demand Forecast ────────────────────────────────
  const weeklyBySku = Object.fromEntries(SKUS.map(s=>[s.id,0]));
  velocities.forEach(v=>{ SKUS.forEach(s=>{ weeklyBySku[s.id] += (v.weeklyUnits[s.id]||0); }); });

  const inv = DB.a('iv');
  function stockFor(skuId) {
    const ins  = inv.filter(i=>i.sku===skuId&&i.type==='in').reduce((t,i)=>t+i.qty,0);
    const outs = inv.filter(i=>i.sku===skuId&&i.type==='out').reduce((t,i)=>t+i.qty,0);
    return Math.max(0, ins-outs);
  }

  const skuTbody = qs('#proj-sku-body');
  if (skuTbody) {
    skuTbody.innerHTML = SKUS.map(s=>{
      const wk = Math.round(weeklyBySku[s.id]*10)/10;
      const d30u = Math.round(wk*(30/7));
      const d60u = Math.round(wk*(60/7));
      const d90u = Math.round(wk*(90/7));
      return `<tr>
        <td>${skuBadge(s.id)}</td>
        <td>${wk}/wk</td>
        <td>${fmt(d30u)}</td>
        <td>${fmt(d60u)}</td>
        <td>${fmt(d90u)}</td>
      </tr>`;
    }).join('');
  }

  // ── Production Planning ────────────────────────────────
  const prodTbody = qs('#proj-prod-body');
  if (prodTbody) {
    let prodNotes = [];
    prodTbody.innerHTML = SKUS.map(s=>{
      const wk    = Math.round(weeklyBySku[s.id]*10)/10;
      const stock = stockFor(s.id);
      const d30u  = Math.round(wk*(30/7));
      const gap   = (d30u * CANS_PER_CASE) - stock;
      const daysSupply = wk > 0 ? Math.round(stock/((wk * CANS_PER_CASE)/7)) : null;
      const gapCls = gap > 0 ? 'color:var(--red);font-weight:600' : 'color:var(--green)';
      if (gap > 0) prodNotes.push(`${s.label}: need ${fmt(gap)} more units for 30d demand`);
      return `<tr>
        <td>${skuBadge(s.id)}</td>
        <td>${fmt(stock)}</td>
        <td>${fmt(d30u)}</td>
        <td style="${gapCls}">${gap > 0 ? '+'+fmt(gap)+' short' : 'Covered'}</td>
        <td>${daysSupply !== null ? daysSupply+'d' : '—'}</td>
      </tr>`;
    }).join('');
    const pn = qs('#proj-prod-notes');
    if (pn) pn.textContent = prodNotes.length ? prodNotes.join(' · ') : 'Current stock covers 30-day demand for all SKUs.';
  }

  // ── Account Velocity Table ─────────────────────────────
  const acctTbody = qs('#proj-acct-body');
  if (acctTbody) {
    const sorted = [...velocities].sort((a,b)=>(b.avgOrderValue||0)-(a.avgOrderValue||0));
    acctTbody.innerHTML = sorted.length ? sorted.map(v=>{
      const totalWk = Math.round(SKUS.reduce((s,sk)=>s+(v.weeklyUnits[sk.id]||0),0)*10)/10;
      const nextCls = v.nextProjected && v.nextProjected < today() ? 'color:var(--red)' : 'color:var(--blue)';
      return `<tr onclick="openAccount('${v.account.id}')" style="cursor:pointer">
        <td><strong>${v.account.name}</strong><small style="display:block;color:var(--muted)">${v.account.territory||''}</small></td>
        <td>${v.avgDays ? v.avgDays+'d' : '—'}</td>
        <td>${v.avgOrderValue ? fmtC(v.avgOrderValue) : '—'}</td>
        <td>${v.nextProjected ? `<span style="${nextCls}">${fmtD(v.nextProjected)}</span>` : '—'}</td>
        <td>${totalWk}/wk</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="empty">No active accounts with order history</td></tr>';
  }

  // ── Distributor Demand ─────────────────────────────────
  const distTbody = qs('#proj-dist-body');
  if (distTbody) {
    const dists  = DB.a('dist_profiles').filter(d=>d.status==='active');
    const allPOs = DB.a('dist_pos');
    const now    = Date.now();

    distTbody.innerHTML = dists.length ? dists.map(d=>{
      const pos = allPOs.filter(p=>p.distId===d.id).sort((a,b)=>a.dateReceived>b.dateReceived?1:-1);
      if (!pos.length) return `<tr><td onclick="openDistributor('${d.id}')" style="cursor:pointer"><strong>${d.name}</strong></td><td colspan="4" style="color:var(--muted)">No PO history</td></tr>`;

      const avgVal = pos.reduce((s,p)=>s+(p.total||0),0)/pos.length;
      let avgFreq = null, nextEst = null;
      if (pos.length >= 2) {
        const intervals = [];
        for (let i=1;i<pos.length;i++) {
          const diff = (new Date(pos[i].dateReceived+'T12:00:00')-new Date(pos[i-1].dateReceived+'T12:00:00'))/864e5;
          if (diff>0) intervals.push(diff);
        }
        if (intervals.length) {
          avgFreq = Math.round(intervals.reduce((a,b)=>a+b,0)/intervals.length);
          const lastMs = new Date(pos[pos.length-1].dateReceived+'T12:00:00').getTime();
          nextEst = new Date(lastMs + avgFreq*864e5).toISOString().slice(0,10);
        }
      }
      const proj30dist = avgFreq ? Math.round(30/avgFreq)*avgVal : (avgVal||0);
      const nextCls    = nextEst && nextEst < today() ? 'color:var(--red)' : 'color:var(--blue)';
      return `<tr onclick="openDistributor('${d.id}')" style="cursor:pointer">
        <td><strong>${d.name}</strong></td>
        <td>${fmtC(avgVal)}</td>
        <td>${avgFreq ? avgFreq+'d' : '—'}</td>
        <td>${fmtC(proj30dist)}</td>
        <td>${nextEst ? `<span style="${nextCls}">${fmtD(nextEst)}</span>` : '—'}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="empty">No active distributors</td></tr>';

    const dn = qs('#proj-dist-notes');
    if (dn) dn.textContent = dists.length ? `${dists.length} active distributor${dists.length!==1?'s':''} · 30-day projections based on PO frequency.` : '';
  }
}

// Variant of calcProjections that accepts a custom day window
function calcProjectionsWindow(windowDays) {
  const allOrders = DB.a('orders').filter(o=>o.status!=='cancelled');
  const accounts  = DB.a('ac').filter(a=>a.status==='active');
  const now = Date.now();
  const d30 = now+30*864e5, d60 = now+60*864e5, d90 = now+90*864e5;
  const win = windowDays==='all' ? Infinity : (parseInt(windowDays)||90);

  let proj30=0, proj60=0, proj90=0, accountsWithData=0;
  const velocities = [];

  accounts.forEach(ac=>{
    const acOrds = allOrders.filter(o=>o.accountId===ac.id).sort((a,b)=>a.dueDate>b.dueDate?1:-1);
    const windowOrds = win===Infinity ? acOrds : acOrds.filter(o=>daysAgo(o.dueDate)<=win);

    const totalUnits = Object.fromEntries(SKUS.map(s=>[s.id,0]));
    windowOrds.forEach(o=>(o.items||[]).forEach(i=>{ totalUnits[i.sku]=(totalUnits[i.sku]||0)+i.qty; }));

    const periodDays = Math.max(7, Math.min(win===Infinity?90:win, acOrds.length>0 ? Math.max(1, daysAgo(acOrds[0].dueDate)) : 90));
    const weeklyUnits = Object.fromEntries(SKUS.map(s=>[s.id, Math.round((totalUnits[s.id]||0)/(periodDays/7)*10)/10]));

    let avgDays=null, nextProjected=null, avgOrderValue=0;
    if (acOrds.length >= 2) {
      const intervals = [];
      for (let i=1;i<acOrds.length;i++) {
        const diff = (new Date(acOrds[i].dueDate+'T12:00:00')-new Date(acOrds[i-1].dueDate+'T12:00:00'))/864e5;
        if (diff>0) intervals.push(diff);
      }
      if (intervals.length) {
        avgDays       = Math.round(intervals.reduce((a,b)=>a+b,0)/intervals.length);
        avgOrderValue = acOrds.reduce((s,o)=>s+calcOrderValue(o),0)/acOrds.length;
        accountsWithData++;
        const lastMs  = new Date(acOrds[acOrds.length-1].dueDate+'T12:00:00').getTime();
        let next = lastMs + avgDays*864e5;
        while (next <= d90) {
          if (next > now) {
            if (next<=d30) proj30+=avgOrderValue;
            if (next<=d60) proj60+=avgOrderValue;
            proj90+=avgOrderValue;
            if (!nextProjected) nextProjected = new Date(next).toISOString().slice(0,10);
          }
          next += avgDays*864e5;
        }
      }
    }
    velocities.push({account:ac, avgDays, avgOrderValue, nextProjected, weeklyUnits, ordCount:acOrds.length});
  });

  return {proj30, proj60, proj90, accountsWithData, velocities};
}

// ══════════════════════════════════════════════════════════
//  ACCOUNTS
// ══════════════════════════════════════════════════════════
function acLastContacted(a) {
  const noteDate     = a.notes?.length ? a.notes[a.notes.length-1].date : null;
  const outreachDate = a.outreach?.length ? a.outreach[a.outreach.length-1].date : null;
  if (noteDate && outreachDate) return noteDate > outreachDate ? noteDate : outreachDate;
  return noteDate || outreachDate || null;
}

function setAcBrandFilter(val) {
  _acBrandFilter = val;
  document.querySelectorAll('.ac-brand-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.brand === val));
  renderAccounts();
}

function toggleAcCompact() {
  _acCompact = !_acCompact;
  const cards = qs('#ac-cards');
  if (cards) cards.classList.toggle('ac-compact', _acCompact);
  const btn = qs('#ac-compact-btn');
  if (btn) btn.classList.toggle('active', _acCompact);
}

function toggleAccountStar(id) {
  const a = DB.a('ac').find(x=>x.id===id);
  if (!a) return;
  DB.update('ac', id, x=>({...x, starred: !x.starred}));
  renderAccounts();
}

function _acCardHTML(a, muted) {
  const lastContact  = acLastContacted(a);
  const needsAttn    = !muted && (daysAgo(a.lastOrder)>=30 || daysAgo(lastContact)>=30);

  const lastOrderHtml = a.lastOrder
    ? `<span class="ac-metric-val${daysAgo(a.lastOrder)>=30?' red':''}">${fmtD(a.lastOrder)} (${daysAgo(a.lastOrder)}d)</span>`
    : `<span class="ac-metric-val red">Never</span>`;

  const lastContactHtml = lastContact
    ? `<span class="ac-metric-val${daysAgo(lastContact)>=30?' red':''}">${fmtD(lastContact)} (${daysAgo(lastContact)}d)</span>`
    : `<span class="ac-metric-val" style="color:var(--muted)">—</span>`;

  const acOrds = DB.a('orders').filter(o=>o.accountId===a.id&&o.status!=='cancelled')
    .sort((x,y)=>x.dueDate>y.dueDate?1:-1);
  let velocityHtml = `<span class="ac-metric-val" style="color:var(--muted)">—</span>`;
  if (acOrds.length>=2) {
    const intervals=[];
    for (let i=1;i<acOrds.length;i++){
      const d=(new Date(acOrds[i].dueDate+'T12:00:00')-new Date(acOrds[i-1].dueDate+'T12:00:00'))/864e5;
      if(d>0) intervals.push(d);
    }
    if (intervals.length) {
      const avg=Math.round(intervals.reduce((a,b)=>a+b,0)/intervals.length);
      velocityHtml=`<span class="ac-metric-val">Every ${avg}d</span>`;
    }
  }

  const outstanding = DB.a('orders').filter(o=>o.accountId===a.id&&o.status==='delivered'&&(o.invoiceStatus||'none')!=='paid');
  const outstandingHtml = outstanding.length
    ? `<span class="ac-metric-val red">${outstanding.length} unpaid</span>`
    : `<span class="ac-metric-val green">Clear</span>`;

  const lastNote     = a.notes?.length ? a.notes[a.notes.length-1] : null;
  const lastOutreach = a.outreach?.length ? a.outreach[a.outreach.length-1] : null;
  const locs = (a.locs && a.locs.length) ? a.locs
    : (a.address ? [{id:'legacy', label:'', address:a.address, contact:'', phone:'', dropOffRules:a.dropOffRules||''}] : []);

  const nfu = a.nextFollowUp;
  let nfuHtml = '';
  if (nfu) {
    const nfuColor = nfu < today() ? '#dc2626' : nfu === today() ? '#d97706' : '#1d4ed8';
    const nfuLabel = nfu < today() ? 'Overdue' : nfu === today() ? 'Today' : fmtD(nfu);
    nfuHtml = `<div class="pr-card-nextsteps" style="border-left-color:${nfuColor}"><div class="ac-card-section-label" style="color:${nfuColor}">📅 Next Follow-Up</div><div class="pr-card-nextsteps-text" style="color:${nfuColor};font-weight:600">${nfuLabel}${nfu < today() || nfu === today() ? ' — '+fmtD(nfu) : ''}</div></div>`;
  }

  return `<div class="ac-card${needsAttn?' needs-attention':''}${muted?' ac-dist-served':''}">
    <div class="ac-card-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;flex-wrap:wrap">
          <span class="ac-card-name">${escHtml(a.name)}</span>
          ${a.isPbf?`<span class="badge green" style="font-size:10px">🌿 LF</span>`:''}
          ${(a.skus||[]).map(s=>`<span class="badge ${SKU_MAP[s]?.cls||'gray'}" style="font-size:10px">${SKU_MAP[s]?.label||s}</span>`).join('')}
          ${muted ? _getFulfillBadge(a) : ''}
        </div>
        <div class="ac-card-sub">${[a.type, locs.length===1&&locs[0].address ? locs[0].address : ''].filter(Boolean).map(escHtml).join(' · ')}</div>
        ${a.contact||a.phone?`<div class="ac-card-sub">${[a.contact,a.phone].filter(Boolean).map(escHtml).join(' · ')}</div>`:''}
        ${a.email?`<div class="ac-card-email">✉ ${escHtml(a.email)}</div>`:''}
        ${lastNote?.text?`<div class="ac-compact-notes">${escHtml(lastNote.text.slice(0,80))}</div>`:''}
        ${locs.length>1?`<button id="ac-locs-btn-${a.id}" class="btn sm" style="margin-top:4px" onclick="toggleAcLocs('${a.id}')">▼ ${locs.length} Locations</button>`:''}
      </div>
      <div class="ac-card-badges">
        <button class="ac-star${a.starred?' active':''}" onclick="event.stopPropagation();toggleAccountStar('${a.id}')" title="${a.starred?'Unpin':'Pin to top'}">${a.starred?'★':'☆'}</button>
        ${a.type?`<span class="badge gray">${a.type}</span>`:''}
        ${statusBadge(AC_STATUS,a.status)}
        ${needsAttn?`<span class="badge amber">⚠ Needs Attention</span>`:''}
        ${(()=>{const ls=(a.samples||[]).slice().sort((x,y)=>y.date>x.date?1:-1)[0];if(!ls)return '';const pending=ls&&!ls.followUpDone&&ls.followUpDate;if(pending&&ls.followUpDate<today())return `<span class="badge red" style="font-size:10px">🧪 Follow-up overdue</span>`;if(pending)return `<span class="badge amber" style="font-size:10px">🧪 Sample sent</span>`;return `<span class="badge" style="background:#e0f2fe;color:#0369a1;font-size:10px">🧪 ${fmtD(ls.date)}</span>`;})()}
      </div>
    </div>
    ${locs.length>1?`<div id="ac-locs-${a.id}" class="ac-locs-drawer" style="display:none">${locs.map(l=>`
      <div class="ac-loc-item">
        <div class="ac-loc-dot"></div>
        <div style="flex:1;min-width:0">
          ${l.label?`<div class="ac-loc-label">${l.label}</div>`:''}
          ${l.address?`<div class="ac-loc-addr">${l.address}</div>`:''}
          ${l.contact||l.phone?`<div class="ac-loc-addr" style="margin-top:2px">${[l.contact,l.phone].filter(Boolean).join(' · ')}</div>`:''}
          ${l.dropOffRules?`<div class="ac-loc-drop">🚚 ${l.dropOffRules}</div>`:''}
        </div>
      </div>`).join('')}</div>`:''}
    <div class="ac-card-metrics">
      <div><div class="ac-metric-label">Last Order</div>${lastOrderHtml}</div>
      <div><div class="ac-metric-label">Last Contacted</div>${lastContactHtml}</div>
      <div><div class="ac-metric-label">Velocity</div>${velocityHtml}</div>
      <div><div class="ac-metric-label">Outstanding</div>${outstandingHtml}</div>
    </div>
    ${nfuHtml}
    ${lastNote?`<div class="ac-card-section"><div class="ac-card-section-label">Notes</div><div style="font-size:13px">${escHtml(lastNote.text)}</div></div>`:''}
    ${lastNote?.nextAction?`<div class="pr-card-nextsteps"><div class="ac-card-section-label" style="color:#1e40af">☑ Next Steps</div><div class="pr-card-nextsteps-text">${lastNote.nextAction}${lastNote.nextDate?' — '+fmtD(lastNote.nextDate):''}</div></div>`:''}
    ${!lastNote&&lastOutreach?`<div class="ac-card-section"><div class="ac-card-section-label">Recent Outreach</div><div style="font-size:13px">${lastOutreach.type} · ${fmtD(lastOutreach.date)}${(lastOutreach.notes||lastOutreach.note)?' — '+(lastOutreach.notes||lastOutreach.note):''}</div></div>`:''}
    ${locs.length===1&&locs[0].dropOffRules?`<div class="ac-card-rules"><div class="ac-card-section-label">🚚 Drop-Off Rules</div><div class="ac-card-rules-text">${locs[0].dropOffRules}</div></div>`:a.dropOffRules&&!locs.length?`<div class="ac-card-rules"><div class="ac-card-section-label">🚚 Drop-Off Rules</div><div class="ac-card-rules-text">${a.dropOffRules}</div></div>`:''}
    <div class="ac-card-actions">
      <button class="btn sm primary" onclick="openAccount('${a.id}')">View</button>
      <button class="btn sm" onclick="quickNote('${a.id}')">Note</button>
      <button class="btn sm" onclick="logOutreach('${a.id}')">Log Follow-Up</button>
      <button class="btn sm run" onclick="addAccountToRun('${a.id}')">+ Run</button>
      <button class="btn sm" onclick="editAccount('${a.id}')">Edit</button>
      <button class="btn sm" onclick="generateOrderLink('${a.id}','${a.name}','${a.email||''}')">🔗 Copy Link</button>
    </div>
  </div>`;
}

function renderAccounts() {
  _populateFulfillFilter();
  let list = DB.a('ac');
  const search        = qs('#ac-search')?.value?.toLowerCase().trim() || '';
  const typeFilter    = qs('#ac-type-filter')?.value || '';
  const fulfillFilter = qs('#ac-fulfill-filter')?.value || '';
  const sortVal       = qs('#ac-sort')?.value || 'name';

  if (search) list = list.filter(a=>
    a.name?.toLowerCase().includes(search) ||
    a.contact?.toLowerCase().includes(search) ||
    a.territory?.toLowerCase().includes(search) ||
    a.address?.toLowerCase().includes(search));
  if (typeFilter) list = list.filter(a=>a.type===typeFilter);
  if (_acBrandFilter === 'lf')    list = list.filter(a=>!!a.isPbf);
  else if (_acBrandFilter === 'purpl') list = list.filter(a=>!a.isPbf);
  else if (_acBrandFilter === 'both')  list = list.filter(a=>!!a.isPbf); // refine when brands[] field added
  if (fulfillFilter === 'direct') list = list.filter(a=>!a.fulfilledBy||a.fulfilledBy==='direct');
  else if (fulfillFilter) list = list.filter(a=>a.fulfilledBy===fulfillFilter);

  list = list.slice().sort((a,b)=>{
    // Starred always floats to top
    if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
    if (sortVal==='name')          return (a.name||'') < (b.name||'') ? -1 : 1;
    if (sortVal==='lastOrder')     return (a.lastOrder||'') < (b.lastOrder||'') ? 1 : -1;
    if (sortVal==='lastContacted') return (acLastContacted(a)||'') < (acLastContacted(b)||'') ? 1 : -1;
    if (sortVal==='territory')     return (a.territory||'') < (b.territory||'') ? -1 : 1;
    return 0;
  });

  const el = qs('#ac-cards');
  if (!el) return;

  if (!DB._firestoreReady) {
    el.innerHTML = _dbLoadingHTML(4);
    return;
  }

  if (qs('#ac-count')) qs('#ac-count').textContent = `${list.length} account${list.length!==1?'s':''}`;

  if (!list.length) {
    el.innerHTML = '<div class="empty">No accounts match your filters. Click "+ Add Account" to get started.</div>';
    el.classList.toggle('ac-compact', _acCompact);
    return;
  }

  // Determine if any filter is active (for auto-expand logic)
  const hasActiveFilter = !!(search || typeFilter || fulfillFilter || (_acBrandFilter && _acBrandFilter !== ''));

  // Split into direct and per-distributor
  const directList = list.filter(a => !a.fulfilledBy || a.fulfilledBy === 'direct');
  const distMap    = new Map(); // distId → account[]
  list.filter(a => a.fulfilledBy && a.fulfilledBy !== 'direct').forEach(a => {
    if (!distMap.has(a.fulfilledBy)) distMap.set(a.fulfilledBy, []);
    distMap.get(a.fulfilledBy).push(a);
  });

  const allDists = DB.a('dist_profiles');
  const parts = [];

  // ── Direct Accounts group (always expanded, no toggle) ────
  if (directList.length > 0 || distMap.size === 0) {
    parts.push(`<div class="ac-group">
      <div class="ac-group-hdr ac-group-hdr-direct">
        <h3>Direct Accounts</h3>
        <span class="ac-group-count">${directList.length}</span>
      </div>
      <div class="ac-group-cards">${directList.map(a=>_acCardHTML(a,false)).join('')}</div>
    </div>`);
  }

  // ── Per-distributor groups (collapsible, collapsed by default) ──
  distMap.forEach((accounts, distId) => {
    const d = allDists.find(x=>x.id===distId);
    const distName  = d?.name || 'Unknown Distributor';
    const chains    = DB.a('dist_chains').filter(c=>c.distId===distId);
    const doorCount = chains.reduce((s,c)=>s+(c.doorCount||0),0) || d?.doorCount || 0;
    // Auto-expand when a filter is active and this group has matches; else use persisted state
    const isExpanded = hasActiveFilter ? true : _distGroupExpanded.has(distId);
    parts.push(`<div class="ac-group" id="ac-group-${distId}">
      <div class="ac-group-hdr" onclick="toggleDistGroup('${distId}')">
        <span class="ac-group-toggle">${isExpanded?'▼':'▶'}</span>
        <h3>${escHtml(distName)}</h3>
        <span class="ac-group-count">${accounts.length}</span>
        ${doorCount?`<span class="badge amber" style="font-size:10px">${fmt(doorCount)} doors</span>`:''}
      </div>
      <div class="ac-group-cards"${isExpanded?'':' style="display:none"'}>
        ${accounts.map(a=>_acCardHTML(a,true)).join('')}
      </div>
    </div>`);
  });

  el.innerHTML = parts.join('');
  el.classList.toggle('ac-compact', _acCompact);
}

function toggleAcLocs(id) {
  const drawer = document.getElementById('ac-locs-'+id);
  const btn    = document.getElementById('ac-locs-btn-'+id);
  if (!drawer) return;
  const opening = drawer.style.display === 'none';
  drawer.style.display = opening ? '' : 'none';
  if (btn) btn.innerHTML = opening
    ? btn.innerHTML.replace('▼','▲')
    : btn.innerHTML.replace('▲','▼');
}

function _macShowLoc(locs, idx) {
  const loc = locs[idx] || locs[0] || {};
  const addrRow = qs('#mac-address-row');
  const dropRow = qs('#mac-drop-row');
  if (addrRow) {
    const addr = loc.address || '';
    qs('#mac-address').textContent = addr || '—';
    addrRow.style.display = addr ? '' : 'none';
  }
  if (dropRow) {
    const dr = loc.dropOffRules || '';
    qs('#mac-drop-rules').textContent = dr;
    dropRow.style.display = dr ? '' : 'none';
  }
}

function openAccount(id) {
  const a = DB.a('ac').find(x=>x.id===id);
  if (!a) return;
  const m = document.getElementById('modal-account');
  if (!m) return;

  // Header
  qs('#mac-name').textContent = a.name;
  qs('#mac-status-badge').innerHTML = statusBadge(AC_STATUS, a.status);
  const brandBadgeEl = qs('#mac-brand-badge');
  if (brandBadgeEl) {
    brandBadgeEl.innerHTML = a.isPbf
      ? `<span class="badge green">🌿 Lavender Fields wholesaler + purpl</span>`
      : `<span class="badge purple">purpl only</span>`;
  }

  // Overview tab
  qs('#mac-contact').textContent = a.contact||'—';
  qs('#mac-phone').textContent = a.phone||'—';
  qs('#mac-email').textContent = a.email||'—';
  qs('#mac-type').textContent = a.type||'—';
  qs('#mac-territory').textContent = a.territory||'—';
  qs('#mac-since').textContent = fmtD(a.since);
  qs('#mac-last-order').textContent = a.lastOrder ? `${fmtD(a.lastOrder)} (${daysAgo(a.lastOrder)}d ago)` : '—';
  qs('#mac-skus').innerHTML = (a.skus||[]).map(skuBadge).join(' ');
  qs('#mac-par').innerHTML = Object.entries(a.par||{}).map(([k,v])=>`${skuBadge(k)} par: <strong>${v}</strong>`).join('&nbsp;&nbsp;');

  // Locations
  const locs = (a.locs && a.locs.length) ? a.locs
    : (a.address ? [{id:'legacy', label:'', address:a.address, dropOffRules:a.dropOffRules||''}] : []);
  const locsRow = qs('#mac-locs-row');
  const locSelect = qs('#mac-loc-select');
  if (locsRow && locSelect) {
    if (locs.length > 1) {
      locSelect.innerHTML = locs.map((l,i)=>
        `<option value="${i}">${l.label || ('Location '+(i+1))}: ${l.address||'(no address)'}</option>`).join('');
      locSelect.value = '0';
      locsRow.style.display = '';
      locSelect.onchange = () => _macShowLoc(locs, parseInt(locSelect.value));
    } else {
      locsRow.style.display = 'none';
    }
    _macShowLoc(locs, 0);
  }

  // Order history
  const acOrders = DB.a('orders').filter(o=>o.accountId===id).sort((a,b)=>b.created>a.created?1:-1).slice(0,8);
  qs('#mac-order-hist').innerHTML = acOrders.length ? acOrders.map(o=>`
    <tr><td>${fmtD(o.dueDate)}</td>
    <td>${(o.items||[]).map(i=>`${skuBadge(i.sku)} ×${i.qty}`).join(' ')}</td>
    <td>${statusBadge(ORD_STATUS,o.status)}</td>
    <td>${o.notes||''}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No orders yet</td></tr>';

  // Last Contacted + Next Follow-Up in overview
  const lastContactedVal = acLastContacted(a);
  const lastContactedEl = qs('#mac-last-contacted');
  if (lastContactedEl) {
    lastContactedEl.textContent = lastContactedVal ? `${fmtD(lastContactedVal)} (${daysAgo(lastContactedVal)}d ago)` : '—';
  }
  const nfuEl = qs('#mac-next-followup');
  if (nfuEl) {
    if (a.nextFollowUp) {
      const nfuColor = a.nextFollowUp < today() ? '#dc2626' : a.nextFollowUp === today() ? '#d97706' : '#1d4ed8';
      nfuEl.innerHTML = `<span style="color:${nfuColor};font-weight:600">${fmtD(a.nextFollowUp)}</span>`;
    } else {
      nfuEl.textContent = '—';
    }
  }
  const fbEl = qs('#mac-fulfilled-by');
  if (fbEl) {
    const fb = a.fulfilledBy;
    if (!fb || fb === 'direct') {
      fbEl.innerHTML = `<span class="badge purple" style="font-size:11px">Direct</span>`;
    } else {
      const dist = DB.a('dist_profiles').find(d=>d.id===fb);
      fbEl.innerHTML = dist
        ? `<span class="badge amber" style="font-size:11px;cursor:pointer" onclick="closeModal('modal-account');openDistributor('${dist.id}')">via ${dist.name}</span>`
        : `<span class="badge amber" style="font-size:11px">via Distributor</span>`;
    }
  }

  // Notes
  renderAccountNotes(a);

  // Samples
  const smpList = qs('#mac-samples-list');
  if (smpList) {
    const samples = (a.samples||[]).slice().reverse();
    smpList.innerHTML = samples.length
      ? samples.map(s=>`<div class="note-item" style="margin-bottom:8px">
          <div class="note-date">${fmtD(s.date)}${s.flavors?` — ${escHtml(s.flavors)}`:''}</div>
          ${s.notes?`<div style="font-size:12px">${escHtml(s.notes)}</div>`:''}
          ${s.followUpDate?`<div style="font-size:12px;color:${s.followUpDone?'var(--muted)':s.followUpDate<today()?'var(--red)':'var(--blue)'}">Follow-up: ${fmtD(s.followUpDate)}${s.followUpDone?' ✓':''}</div>`:''}
          ${!s.followUpDone&&s.followUpDate?`<button class="btn xs" style="margin-top:4px" onclick="markSampleFollowUpDone('ac','${id}','${s.id}')">Mark Done</button>`:''}
        </div>`).join('')
      : '<div style="color:var(--muted);font-size:13px">No samples logged.</div>';
  }
  const smpBtn = qs('#mac-log-sample-btn');
  if (smpBtn) smpBtn.onclick = () => openLogSampleModal('ac', id);

  // Outreach tab
  renderAccountOutreach(a);
  const logOutreachBtn = qs('#mac-log-outreach-btn');
  if (logOutreachBtn) logOutreachBtn.onclick = () => openLogOutreachModal('ac', id);

  // Set edit button
  qs('#mac-edit-btn').onclick = () => { closeModal('modal-account'); editAccount(id); };
  qs('#mac-order-btn').onclick = () => { closeModal('modal-account'); openNewOrder(id); };
  const draftBtn = qs('#mac-draft-btn');
  if (draftBtn) draftBtn.onclick = () => openDraftOutreachModal(id);

  // Copy link button
  const copyLinkBtn = qs('#mac-copy-link-btn');
  if (copyLinkBtn) copyLinkBtn.onclick = () => copyOrderLink(id);

  // Tab switching
  document.querySelectorAll('#modal-account .tab').forEach(t=>{
    t.onclick = () => {
      document.querySelectorAll('#modal-account .tab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('#modal-account .tab-pane').forEach(x=>x.style.display='none');
      t.classList.add('active');
      const pane = document.getElementById('mac-tab-'+t.dataset.tab);
      if (pane) pane.style.display='block';
      if (t.dataset.tab === 'portal-orders') renderMacPortalOrdersTab(id);
      if (t.dataset.tab === 'invoices') renderMacInvoicesTab(id);
      if (t.dataset.tab === 'emails') renderMacEmailsTab(id);
    };
  });
  // Default to first tab
  document.querySelectorAll('#modal-account .tab')[0]?.click();

  openModal('modal-account');
}

function openAccountToEmailsTab(id) {
  openAccount(id);
  setTimeout(() => {
    const emailTab = document.querySelector('#modal-account .tab[data-tab="emails"]');
    if (emailTab) emailTab.click();
  }, 50);
}

function renderAccountNotes(a) {
  const nl = qs('#mac-notes-list');
  if (!nl) return;
  nl.innerHTML = (a.notes||[]).slice().reverse().map((n,i)=>`
    <div class="note-item">
      <div class="note-date">${fmtD(n.date)} — ${n.author||'you'}</div>
      <div>${escHtml(n.text||'')}</div>
      ${n.nextAction?`<div class="note-next">📅 Next: ${n.nextAction}${n.nextDate?' on '+fmtD(n.nextDate):''}</div>`:''}
    </div>`).join('') || '<div class="empty" style="padding:16px">No notes yet</div>';

  const addBtn = qs('#mac-add-note-btn');
  if (addBtn) addBtn.onclick = () => addAccountNote(a.id);
}

function addAccountNote(id) {
  const text = qs('#mac-note-text')?.value?.trim();
  if (!text) return;
  const next = qs('#mac-note-next')?.value?.trim();
  const nextDate = qs('#mac-note-next-date')?.value;
  const note = {id:uid(), date:today(), text, author:'you', nextAction:next, nextDate};
  DB.update('ac', id, a=>({...a, lastContacted: today(), notes:[...(a.notes||[]), note]}));
  if (qs('#mac-note-text')) qs('#mac-note-text').value='';
  if (qs('#mac-note-next')) qs('#mac-note-next').value='';
  if (qs('#mac-note-next-date')) qs('#mac-note-next-date').value='';
  const a = DB.a('ac').find(x=>x.id===id);
  renderAccountNotes(a);
  toast('Note saved');
}

function renderAccountOutreach(a) {
  const ol = qs('#mac-outreach-list');
  if (!ol) return;
  const entries = (a.outreach||[]).slice().sort((x,y)=>y.date>x.date?1:-1);
  if (!entries.length) {
    ol.innerHTML = '<div class="empty" style="padding:16px">No follow-ups logged yet. Use the button above to log your first one.</div>';
    return;
  }
  const TYPE_LABELS = {call:'Call',email:'Email','in-person':'In Person',text:'Text',other:'Other',Call:'Call',Email:'Email',Visit:'Visit',Text:'Text',Social:'Social'};
  const TYPE_CLS    = {call:'blue',email:'green','in-person':'purple',text:'gray',other:'gray',Call:'blue',Email:'green',Visit:'purple',Text:'gray',Social:'gray'};
  const OUT_CLS     = {'Interested':'green','Ordered':'green','Needs Follow-Up':'amber','No Response':'gray','Not Interested':'red','Left Voicemail':'gray','Other':'gray'};
  const REG_LABEL   = {purpl:'💜 purpl', lf:'🌿 LF', both:'Both'};
  const REG_CLS     = {purpl:'purple', lf:'green', both:'blue'};
  ol.innerHTML = entries.map(e=>`
    <div class="note-item">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--muted)">${fmtD(e.date)}</span>
        <span class="badge ${TYPE_CLS[e.type]||'gray'}" style="font-size:10px">${escHtml(TYPE_LABELS[e.type]||e.type||'Other')}</span>
        ${e.regarding?`<span class="badge ${REG_CLS[e.regarding]||'gray'}" style="font-size:10px">${escHtml(REG_LABEL[e.regarding]||e.regarding)}</span>`:''}
        ${e.outcome?`<span class="badge ${OUT_CLS[e.outcome]||'gray'}" style="font-size:10px">${escHtml(e.outcome)}</span>`:''}
      </div>
      ${e.contact?`<div style="font-size:13px;color:var(--muted);margin-bottom:2px">Spoke with: <strong>${escHtml(e.contact)}</strong></div>`:''}
      ${(e.notes||e.note)?`<div style="font-size:13px">${escHtml(e.notes||e.note)}</div>`:''}
      ${e.nextFollowUp?`<div style="font-size:12px;color:#1d4ed8;margin-top:4px">📅 Next follow-up: <strong>${fmtD(e.nextFollowUp)}</strong></div>`:''}
    </div>`).join('');
}

// ── Stage ID ↔ template ID mapping ─────────────────────
// CADENCE_STAGES uses underscore IDs; email templates use hyphen IDs.
const _STAGE_TEMPLATE_IDS = {
  application_received:  'application-received',
  approved_welcome:      'approved',
  rejected_decline:      'rejected',
  invoice_sent:          'invoice-sent',
  first_order_followup:  'first-order',
};
const _TEMPLATE_STAGE_IDS = Object.fromEntries(
  Object.entries(_STAGE_TEMPLATE_IDS).map(([k,v])=>[v,k])
);

// ── Email preview modal state + functions ────────────────
let _currentEmailPreview = null;

function openEmailPreview(stage, accountId, extra={}) {
  const account = DB.a('ac').find(x=>x.id===accountId);
  if (!account) return;
  const template = getCadenceEmailTemplate(stage, account, extra);
  if (!template) return;
  const contacts = account.contacts||[];
  const primary = contacts.find(c=>c.isPrimary)||contacts[0]||{};
  const toEmail = primary.email||account.email||'';
  _currentEmailPreview = {stage, accountId, template, toEmail};
  document.getElementById('email-preview-title').textContent = template.subject;
  document.getElementById('email-preview-from').textContent = template.from;
  document.getElementById('email-preview-to').textContent = toEmail||'No email on file';
  document.getElementById('email-preview-subject').value = template.subject;
  document.getElementById('email-preview-frame').srcdoc = template.body;
  document.getElementById('email-preview-body-textarea').value = template.body;
  document.getElementById('email-preview-body-edit').style.display = 'none';
  openModal('modal-email-preview');
}

function _openInvEmailPreview(accountId) {
  const invId = _latestAccountInvoiceId(accountId);
  const inv = invId
    ? (DB.a('iv').find(x=>x.id===invId) || DB.a('lf_invoices').find(x=>x.id===invId))
    : null;
  openEmailPreview('invoice-sent', accountId, {
    invoiceNumber: inv?.number || '',
    invoiceTotal:  fmtC(inv?.amount || inv?.total || 0),
    invoiceLink:   inv?.link || '',
  });
}

function openEmailPreviewTab() {
  if (!_currentEmailPreview) return;
  const blob = new Blob([_currentEmailPreview.template.body], {type:'text/html'});
  window.open(URL.createObjectURL(blob), '_blank');
}

function toggleEmailBodyEdit() {
  const el = document.getElementById('email-preview-body-edit');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
  if (el.style.display === 'block') {
    const ta = document.getElementById('email-preview-body-textarea');
    const frame = document.getElementById('email-preview-frame');
    if (ta._liveHandler) {
      ta.removeEventListener('input', ta._liveHandler);
    }
    ta._liveHandler = function() {
      frame.srcdoc = this.value;
    };
    ta.addEventListener('input', ta._liveHandler);
  }
}

function copyEmailHTML() {
  if (!_currentEmailPreview) return;
  const body = document.getElementById('email-preview-body-textarea').value
    || _currentEmailPreview.template.body;
  navigator.clipboard.writeText(body)
    .then(()=>toast('HTML copied to clipboard'))
    .catch(()=>toast('Copy failed'));
}

function openEmailMailto() {
  if (!_currentEmailPreview) return;
  const t = _currentEmailPreview.template;
  const to = _currentEmailPreview.toEmail || '';
  const subject = document.getElementById('email-preview-subject').value || t.subject;
  if (!to) return;
  window.open(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}`, '_blank');
}

function sendEmailViaResend() {
  if (!_currentEmailPreview) return;
  const t   = _currentEmailPreview.template;
  const to  = _currentEmailPreview.toEmail || '';
  const subject = document.getElementById('email-preview-subject').value || t.subject;
  const html    = document.getElementById('email-preview-body-textarea').value || t.body;
  if (!to) { toast('No recipient email on file'); return; }
  const from = 'lavender@pbfwholesale.com';
  const btn = document.querySelector('#modal-email-preview .btn.primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  callSendEmail(to, from, subject, html)
    .then((result) => {
      toast('Email sent ✓');
      markCadenceEmailSent(result?.id);
    })
    .catch(() => {
      toast('Resend unavailable — opening Gmail');
      window.open(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}`, '_blank');
    })
    .finally(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Email'; }
    });
}

function markCadenceEmailSent(sentMessageId) {
  if (!_currentEmailPreview) return;
  const {stage, accountId} = _currentEmailPreview;
  // Map template hyphen-ID back to underscore stage ID for cadence log consistency
  const stageId = _TEMPLATE_STAGE_IDS[stage] || stage;
  const entry = {
    id: uid(), stage: stageId,
    sentAt: new Date().toISOString(),
    sentBy: 'graham',
    method: 'manual',
  };
  if (sentMessageId) entry.sentMessageId = sentMessageId;
  DB.update('ac', accountId, a => ({...a, cadence: [...(a.cadence||[]), entry]}));
  closeModal('modal-email-preview');
  openAccountToEmailsTab(accountId);
  renderCadenceOverdue();
  toast('Email marked as sent');
}

// ══════════════════════════════════════════════════════════
//  EMAIL CADENCE TAB
// ══════════════════════════════════════════════════════════

function renderMacEmailsTab(id) {
  const a     = DB.a('ac').find(x=>x.id===id);
  const stEl  = qs('#mac-cadence-stages');
  const logEl = qs('#mac-cadence-log');
  if (!stEl || !a) return;

  const cadence = a.cadence || [];

  stEl.innerHTML = '<div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">Email Cadence</div>' +
    CADENCE_STAGES.map(stage=>{
      const sent = cadence.filter(c=>c.stage===stage.id).sort((x,y)=>y.sentAt>x.sentAt?1:-1);
      const last = sent[0];
      const isSent = !!last;
      const dotCls = isSent ? 'cadence-dot sent' : 'cadence-dot pending';
      const btnLabel = isSent ? 'Resend' : 'Send ✉️';
      const btnCls = isSent ? 'btn xs' : 'btn xs primary';
      const _btnCall = stage.id === 'invoice_sent'
        ? `_openInvEmailPreview('${id}')`
        : `openEmailPreview('${_STAGE_TEMPLATE_IDS[stage.id]||stage.id}','${id}')`;
      return `<div class="cadence-stage">
        <div class="${dotCls}"></div>
        <div class="cadence-info">
          <div class="cadence-label">${stage.label}</div>
          <div class="cadence-desc">${stage.desc}</div>
          ${isSent?`<div class="cadence-date">Sent ${fmtD(last.sentAt)} · ${last.method||'manual'}${last.opened?` · 👁 Opened ${fmtD(last.openedAt)}`:''}${last.clicked?` · 🔗 Clicked ${fmtD(last.clickedAt)}`:''}</div>`:''}
        </div>
        <button class="${btnCls}" onclick="${_btnCall}">${btnLabel}</button>
      </div>`;
    }).join('');

  if (cadence.length) {
    const rows = cadence.slice().sort((a,b)=>b.sentAt>a.sentAt?1:-1).map(c=>{
      const s = CADENCE_STAGES.find(x=>x.id===c.stage);
      const status = ['Sent ✓', c.opened ? `👁 Opened ${fmtD(c.openedAt)}` : '', c.clicked ? `🔗 Clicked ${fmtD(c.clickedAt)}` : ''].filter(Boolean).join(' · ');
      return `<tr><td>${fmtD(c.sentAt)}</td><td>${s?.label||c.stage}</td><td>${c.method||'—'}</td><td>${c.sentBy||'graham'}</td><td>${status}</td></tr>`;
    }).join('');
    logEl.innerHTML = `<div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Email History</div>
      <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Stage</th><th>Method</th><th>Sent By</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } else {
    logEl.innerHTML = '<div class="empty" style="padding:12px 0">No cadence emails sent yet</div>';
  }
}

function _latestAccountInvoiceId(accountId) {
  const purpl = DB.a('iv').filter(x=>x.accountId===accountId&&x.number).sort((a,b)=>b.created>a.created?1:-1)[0];
  const lf    = DB.a('lf_invoices').filter(x=>x.accountId===accountId).sort((a,b)=>b.created>a.created?1:-1)[0];
  if (!purpl && !lf) return '';
  if (!purpl) return lf.id;
  if (!lf)   return purpl.id;
  return (purpl.created||'') >= (lf.created||'') ? purpl.id : lf.id;
}


function markCadenceSent(accountId, stageId, method, invoiceId) {
  const entry = { id: uid(), stage: stageId, sentAt: today(), sentBy: 'graham', method: method||'manual' };
  if (invoiceId) entry.invoiceId = invoiceId;
  DB.update('ac', accountId, a => ({...a, cadence: [...(a.cadence||[]), entry]}));
  renderMacEmailsTab(accountId);
  renderCadenceOverdue();
  toast('Email logged as sent');
}

// ══════════════════════════════════════════════════════════
//  AI EMAIL DRAFTING
// ══════════════════════════════════════════════════════════
const _AI_SYSTEM_PROMPT = `You are a sales assistant for Graham Biagiotti at Pumpkin Blossom Farm. Graham sells two wholesale product lines: purpl (lavender lemonade, 12-pack cases, MSRP $3.29/can) and Lavender Fields (farm lavender products including simple syrup, candles, scrunchies, sachets, roll-ons, refresh powder, dryer sachets). Write professional, warm, concise wholesale outreach emails. Never use emojis in the email body. Always end with the signature block provided. Respond with JSON only: {"subject": "...", "body": "..."}`;

const _AI_SIGNATURE = `Graham Biagiotti — Director of Sales
603-748-3038 · Warner, NH
Pumpkin Blossom Farm | purpl & Lavender Fields`;

const SIGNATURE = _AI_SIGNATURE;

const CADENCE_STAGES = [
  {
    id: 'application_received',
    label: 'Application Received',
    desc: 'Thank you for applying',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Thank you for your wholesale application — Pumpkin Blossom Farm',
    body: (a) => `Hi ${a.contact||a.name},\n\nThank you for your interest in carrying our products at ${a.name}. We've received your application and will be in touch within 1 business day.\n\nIn the meantime, feel free to reach out with any questions.\n\nWarmly,\n${SIGNATURE}`
  },
  {
    id: 'approved_welcome',
    label: 'Approved — Welcome + Login',
    desc: 'Welcome + portal access',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Welcome to the purpl wholesale program — your retailer portal is ready',
    body: (a) => {
      const token = a.orderPortalToken || '';
      const portalLink = token ? `https://purpl-crm.web.app/order?t=${token}` : '[portal link not yet generated — use the Emails page to generate before sending]';
      return `Hi ${a.contact||a.name},\n\nWe're thrilled to welcome ${a.name} as a retail partner. Your wholesale account has been approved.\n\nYou can access your retailer order portal here:\n${portalLink}\n\nUse this link to place orders, view order history, and manage your account. Bookmark it for easy access.\n\nPayment terms are Net 30. Invoices will be sent from lavender@pbfwholesale.com.\n\nLooking forward to growing together.\n\nWarmly,\n${SIGNATURE}`;
    }
  },
  {
    id: 'rejected_decline',
    label: 'Rejected — Polite Decline',
    desc: 'Polite decline',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Re: Your wholesale application — Pumpkin Blossom Farm',
    body: (a) => `Hi ${a.contact||a.name},\n\nThank you for your interest in carrying our products. After reviewing your application, we don't think it's the right fit at this time — but we appreciate you reaching out and wish you all the best.\n\nPlease don't hesitate to apply again in the future if circumstances change.\n\nWarmly,\n${SIGNATURE}`
  },
  {
    id: 'invoice_sent',
    label: 'Invoice Sent Notification',
    desc: 'Invoice notification to retailer',
    from: 'lavender@pbfwholesale.com',
    subject: (inv) => `Invoice ${inv?.number||''} from Pumpkin Blossom Farm`,
    body: (a, inv) => `Hi ${a.contact||a.name},\n\nPlease find your invoice ${inv?.number||''} for ${fmtC(inv?.amount||inv?.total||0)} attached. Payment is due within 30 days per our Net 30 terms.\n\n${inv?.link?`View invoice: ${inv.link}\n\n`:''}Please reach out with any questions.\n\nWarmly,\n${SIGNATURE}`
  },
  {
    id: 'first_order_followup',
    label: 'First Order Follow-Up',
    desc: 'Thank you for your first order',
    from: 'lavender@pbfwholesale.com',
    subject: () => "Thanks for your order — we're on it",
    body: (a) => `Hi ${a.contact||a.name},\n\nThank you for placing your first order with us. We're getting it ready and will be in touch with delivery details shortly.\n\nWe're excited to have ${a.name} as a retail partner and look forward to supporting your success with purpl on your shelves.\n\nWarmly,\n${SIGNATURE}`
  }
];

async function _callAnthropicApi(userPrompt) {
  const key = DB.obj('api_settings', {}).anthropicKey || '';
  if (!key) {
    toast('Add your Anthropic API key in Settings → AI to enable AI features', 5000);
    throw new Error('No API key configured');
  }
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: _AI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(()=>({}));
    throw new Error(err?.error?.message || `API error ${response.status}`);
  }
  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  // Strip markdown code fences if present
  const clean = text.replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
  return JSON.parse(clean);
}

function _defaultFromForRegarding(r) {
  return 'lavender@pbfwholesale.com';
}

function setMdoRegarding(val) {
  qs('#mdo-regarding-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.val === val);
  });
  setMdoFrom(_defaultFromForRegarding(val));
}

function setMdoFrom(val) {
  qs('#mdo-from-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.val === val);
  });
}

function openDraftOutreachModal(accountId) {
  const a = DB.a('ac').find(x=>x.id===accountId);
  if (!a) return;
  qs('#mdo-account-id').value = accountId;
  qs('#mdo-title').textContent = `Draft Outreach — ${a.name}`;
  qs('#mdo-context').value = '';
  qs('#mdo-log-check').checked = true;
  qs('#mdo-output').style.display = 'none';
  // Default regarding
  setMdoRegarding(a.isPbf ? 'lf' : 'purpl');
  // Recent history
  const entries = (a.outreach||[]).slice().sort((x,y)=>y.date>x.date?1:-1).slice(0,3);
  const histEl = qs('#mdo-history');
  if (histEl) {
    histEl.innerHTML = entries.length
      ? entries.map(e=>`<div style="margin-bottom:6px;padding:6px;background:var(--surface-2,#f9f8ff);border-radius:4px">
          <span style="color:var(--muted)">${fmtD(e.date)}</span> · ${e.type||'—'}
          ${e.notes||e.note ? `<div style="margin-top:2px">${escHtml((e.notes||e.note||'').slice(0,120))}</div>` : ''}
        </div>`).join('')
      : '<span style="color:var(--muted)">No outreach history yet.</span>';
  }
  openModal('modal-draft-outreach');
}

async function generateOutreachDraft() {
  const accountId = qs('#mdo-account-id').value;
  const a = DB.a('ac').find(x=>x.id===accountId);
  if (!a) return;
  const regarding = qs('#mdo-regarding-btns')?.querySelector('.ac-brand-btn.active')?.dataset?.val || 'purpl';
  const context   = qs('#mdo-context')?.value?.trim() || '';
  const entries   = (a.outreach||[]).slice().sort((x,y)=>y.date>x.date?1:-1).slice(0,3);

  const btn = qs('#mdo-generate-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }

  const historyText = entries.length
    ? entries.map(e=>`- ${e.date} (${e.type||'—'}): ${e.notes||e.note||'—'}`).join('\n')
    : 'No prior outreach.';

  const brandLabel = regarding === 'purpl' ? 'purpl (lavender lemonade)' : regarding === 'lf' ? 'Lavender Fields (farm products)' : 'purpl and Lavender Fields';
  const userPrompt = `Write a wholesale outreach email for the following account:

Account: ${a.name}
Type: ${a.type || 'Wholesale Account'}
Territory: ${a.territory || 'New Hampshire'}
Brand: ${brandLabel}
Last order: ${a.lastOrder ? fmtD(a.lastOrder) : 'Never'}
Last contacted: ${a.lastContacted ? fmtD(a.lastContacted) : 'Never'}

Recent outreach history:
${historyText}

${context ? `Goal / context: ${context}` : ''}

End the email with this exact signature:
${_AI_SIGNATURE}`;

  try {
    const result = await _callAnthropicApi(userPrompt);
    if (qs('#mdo-subject')) qs('#mdo-subject').value = result.subject || '';
    if (qs('#mdo-body'))    qs('#mdo-body').value    = result.body    || '';
    qs('#mdo-output').style.display = '';

    // Auto-log if checkbox checked
    if (qs('#mdo-log-check')?.checked) {
      const subject = result.subject || '';
      DB.update('ac', accountId, ac=>({
        ...ac,
        lastContacted: today(),
        outreach: [...(ac.outreach||[]), {
          id: uid(), date: today(), type: 'email',
          regarding, notes: `Draft generated: ${subject}`, outcome: '',
        }],
      }));
    }
  } catch(e) {
    toast('Error: ' + e.message, 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Generate Draft'; }
  }
}

function mdoRegenerateClick() {
  qs('#mdo-output').style.display = 'none';
  generateOutreachDraft();
}

function mdoOpenMailto() {
  const subject = encodeURIComponent(qs('#mdo-subject')?.value || '');
  const body    = encodeURIComponent(qs('#mdo-body')?.value || '');
  const accountId = qs('#mdo-account-id').value;
  const a = DB.a('ac').find(x=>x.id===accountId);
  const email   = (a?.contacts||[]).find(c=>c.email)?.email || a?.email || '';
  const fromAddr = qs('#mdo-from-btns')?.querySelector('.ac-brand-btn.active')?.dataset?.val || 'lavender@pbfwholesale.com';
  // Show which account to use before opening
  toast(`Opening — send from: ${fromAddr}`, 3500);
  window.open(`mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`);
}

function mdoCopyBody() {
  const body = qs('#mdo-body')?.value || '';
  navigator.clipboard.writeText(body).then(()=>toast('Body copied ✓')).catch(()=>toast('Copy failed'));
}

// ══════════════════════════════════════════════════════════
//  MASS EMAIL PAGE
// ══════════════════════════════════════════════════════════
let _meSelectedIds = new Set();
// ══════════════════════════════════════════════════════════
//  EMAILS PAGE
// ══════════════════════════════════════════════════════════

let _emailsSelectedTemplate = null;
let _emailsSelectedAccountId = null;

function renderEmailsPage() {
  const accounts = DB.a('ac');

  const totalSent = accounts.reduce((s,a) => s + (a.cadence||[]).length, 0);
  const overdue   = getOverdueCadence(accounts);
  const neverContacted = accounts.filter(a => !a.cadence || a.cadence.length === 0).length;
  const cutoff = new Date(Date.now() - 7*86400000).toISOString();
  const thisWeek = accounts.reduce((s,a) => {
    return s + (a.cadence||[]).filter(c => (c.sentAt||'') >= cutoff).length;
  }, 0);

  const kpiEl = document.getElementById('emails-kpis');
  if (kpiEl) kpiEl.innerHTML = `
    <div class="kpi purple"><div class="num">${totalSent}</div><div class="label">Total Emails Sent</div></div>
    <div class="kpi amber"><div class="num">${overdue.length}</div><div class="label">Overdue Actions</div></div>
    <div class="kpi green"><div class="num">${thisWeek}</div><div class="label">Sent This Week</div></div>
    <div class="kpi red"><div class="num">${neverContacted}</div><div class="label">No Email Sent Yet</div></div>
  `;

  _renderEmailsTemplatesCol();
  _renderEmailsRightCol();
  renderEmailsTabOverview(accounts);
  renderEmailsTabHistory(accounts);
  renderMassEmail();
}

function _renderEmailsTemplatesCol() {
  const el = document.getElementById('emails-templates-col');
  if (!el) return;
  const TEMPLATES = [
    {id:'application-received', name:'Application Received',  desc:'Auto-sent on form submit',     from:'lavender@pbfwholesale.com'},
    {id:'approved',             name:'Approved — Welcome',    desc:'Portal link + next steps',      from:'lavender@pbfwholesale.com'},
    {id:'rejected',             name:'Rejected — Decline',    desc:'Polite decline email',          from:'lavender@pbfwholesale.com'},
    {id:'invoice-sent',         name:'Invoice Sent',          desc:'Sends latest invoice details',  from:'lavender@pbfwholesale.com'},
    {id:'first-order',          name:'First Order Follow-up', desc:'Post-first-order check-in',     from:'lavender@pbfwholesale.com'},
  ];
  const cards = TEMPLATES.map(t => `
    <div class="email-template-card${_emailsSelectedTemplate === t.id ? ' active' : ''}"
         onclick="selectEmailTemplate('${t.id}')">
      <div class="etc-name">${t.name}</div>
      <div class="etc-desc">${t.desc}</div>
      <div class="etc-from">${t.from}</div>
    </div>`).join('');
  el.innerHTML = cards + `
    <div class="email-template-card" onclick="switchEmailsTab('mass')" style="border-style:dashed;margin-top:4px">
      <div class="etc-name">📢 Mass Email</div>
      <div class="etc-desc">Broadcast to all accounts</div>
    </div>`;
}

function selectEmailTemplate(templateId) {
  _emailsSelectedTemplate = templateId;
  _renderEmailsTemplatesCol();
  _renderEmailsRightCol();
}

function selectEmailsAccount(accountId) {
  _emailsSelectedAccountId = accountId;
  _renderEmailsRightCol();
}

function _renderEmailsRightCol() {
  const el = document.getElementById('emails-preview-col');
  if (!el) return;

  if (!_emailsSelectedTemplate) {
    el.innerHTML = `<div class="emails-placeholder">
      <div style="font-size:32px">📧</div>
      <div>Select a template to get started</div>
    </div>`;
    return;
  }

  const accounts = DB.a('ac');
  const acctOptions = accounts.map(a =>
    `<option value="${a.id}"${_emailsSelectedAccountId === a.id ? ' selected' : ''}>${escHtml(a.name)}</option>`
  ).join('');

  const account = _emailsSelectedAccountId
    ? accounts.find(x => x.id === _emailsSelectedAccountId)
    : null;

  let previewHtml = '';
  if (account) {
    const extra = {};
    if (_emailsSelectedTemplate === 'invoice-sent') {
      const invId = _latestAccountInvoiceId(account.id);
      const inv = invId ? (DB.a('iv').find(x=>x.id===invId) || DB.a('lf_invoices').find(x=>x.id===invId)) : null;
      if (inv) {
        extra.invoiceNumber = inv.number || inv.invoiceNumber || '';
        extra.invoiceTotal = inv.total || inv.grandTotal || 0;
      }
    }
    const tpl = getCadenceEmailTemplate(_emailsSelectedTemplate, account, extra);
    if (tpl) {
      const isApproved = _emailsSelectedTemplate === 'approved';
      const hasToken   = !!(account.orderPortalToken);
      const tokenUi = isApproved
        ? (hasToken
            ? `<div style="margin-top:8px;font-size:12px;color:#16a34a">✓ Portal link included — token exists</div>`
            : `<div style="margin-top:8px;padding:10px 12px;background:#fef3c7;border:1px solid #fcd34d;border-radius:6px;font-size:12px;color:#92400e;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                <span>⚠️ No portal link yet — generate one before sending</span>
                <button class="btn xs" onclick="_emailsApprovedGenerateToken()">Generate Portal Link</button>
               </div>`)
        : '';
      previewHtml = `
        <div style="margin-bottom:8px">
          <div style="font-size:11px;color:var(--muted);margin-bottom:4px">Subject</div>
          <div style="font-size:13px;font-weight:600;padding:8px 10px;background:var(--bg);border:1px solid var(--border);border-radius:6px">${escHtml(tpl.subject)}</div>
        </div>
        <iframe class="emails-preview-frame" srcdoc="${tpl.body.replace(/"/g,'&quot;')}"></iframe>
        ${tokenUi}
        <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;flex-wrap:wrap">
          <button class="btn xs" onclick="emailsPageCopyHTML()">📋 Copy HTML</button>
          <button class="btn xs" onclick="emailsPageOpenGmail()">✉️ Open in Gmail</button>
          <button class="btn xs primary" id="emails-page-send-btn" onclick="emailsPageSendEmail()"${isApproved && !hasToken ? ' disabled' : ''}>Send Email</button>
        </div>`;
    } else {
      previewHtml = `<div class="emails-placeholder"><div>No template available for this combination</div></div>`;
    }
  } else {
    previewHtml = `<div class="emails-placeholder" style="height:200px">
      <div style="font-size:24px">👆</div>
      <div>Select an account to preview</div>
    </div>`;
  }

  el.innerHTML = `
    <div style="margin-bottom:12px">
      <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px">ACCOUNT</label>
      <select onchange="selectEmailsAccount(this.value)" style="width:100%">
        <option value="">Select account...</option>
        ${acctOptions}
      </select>
    </div>
    ${previewHtml}`;
}

function emailsPageCopyHTML() {
  if (!_emailsSelectedTemplate || !_emailsSelectedAccountId) return;
  const account = DB.a('ac').find(x => x.id === _emailsSelectedAccountId);
  if (!account) return;
  const tpl = getCadenceEmailTemplate(_emailsSelectedTemplate, account);
  if (tpl) navigator.clipboard.writeText(tpl.body).then(() => toast('HTML copied'));
}

function emailsPageOpenGmail() {
  if (!_emailsSelectedTemplate || !_emailsSelectedAccountId) return;
  const account = DB.a('ac').find(x => x.id === _emailsSelectedAccountId);
  if (!account) return;
  const tpl = getCadenceEmailTemplate(_emailsSelectedTemplate, account);
  if (tpl) window.open(`mailto:${encodeURIComponent(account.email||'')}?subject=${encodeURIComponent(tpl.subject)}`, '_blank');
}

function emailsPageSendEmail() {
  if (!_emailsSelectedTemplate || !_emailsSelectedAccountId) return;
  const account = DB.a('ac').find(x => x.id === _emailsSelectedAccountId);
  if (!account) return;
  const extra = {};
  if (_emailsSelectedTemplate === 'invoice-sent') {
    const invId = _latestAccountInvoiceId(account.id);
    const inv = invId ? (DB.a('iv').find(x=>x.id===invId) || DB.a('lf_invoices').find(x=>x.id===invId)) : null;
    if (inv) {
      extra.invoiceNumber = inv.number || inv.invoiceNumber || '';
      extra.invoiceTotal = inv.total || inv.grandTotal || 0;
    }
  }
  const tpl = getCadenceEmailTemplate(_emailsSelectedTemplate, account, extra);
  if (!tpl) return;
  const contacts = account.contacts || [];
  const primary = contacts.find(c => c.isPrimary) || contacts[0] || {};
  const toEmail = primary.email || account.email || '';
  if (!toEmail) { toast('No recipient email on file'); return; }

  const btn = document.getElementById('emails-page-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  callSendEmail(toEmail, 'lavender@pbfwholesale.com', tpl.subject, tpl.body)
    .then((result) => {
      const stageId = _TEMPLATE_STAGE_IDS[_emailsSelectedTemplate] || _emailsSelectedTemplate;
      const entry = {id: uid(), stage: stageId, sentAt: new Date().toISOString(), sentBy: 'graham', method: 'resend'};
      if (result?.id) entry.sentMessageId = result.id;
      DB.update('ac', account.id, a => ({
        ...a,
        lastContacted: today(),
        cadence: [...(a.cadence||[]), entry]
      }));
      toast('Email sent ✓');
      renderEmailsPage();
    })
    .catch(() => {
      toast('Resend unavailable — opening Gmail');
      window.open(`mailto:${encodeURIComponent(toEmail)}?subject=${encodeURIComponent(tpl.subject)}`, '_blank');
      if (btn) { btn.disabled = false; btn.textContent = 'Send Email'; }
    });
}

function emailsPageMarkSent() {
  if (!_emailsSelectedTemplate || !_emailsSelectedAccountId) return;
  const stageId = _TEMPLATE_STAGE_IDS[_emailsSelectedTemplate] || _emailsSelectedTemplate;
  DB.update('ac', _emailsSelectedAccountId, a => ({
    ...a,
    cadence: [...(a.cadence||[]), {id: uid(), stage: stageId, sentAt: new Date().toISOString(), sentBy: 'graham', method: 'manual'}]
  }));
  toast('Email marked as sent');
  renderEmailsPage();
}

async function _emailsApprovedGenerateToken() {
  if (!_emailsSelectedAccountId) return;
  const account = DB.a('ac').find(x => x.id === _emailsSelectedAccountId);
  if (!account) return;
  const token = btoa(account.id + ':' + Math.random().toString(36).slice(2))
    .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  try {
    await firebase.firestore().collection('accounts').doc(account.id).set({
      orderPortalToken: token,
      orderPortalTokenCreatedAt: new Date().toISOString().slice(0,10)
    }, { merge: true });
    DB.update('ac', account.id, a => ({...a, orderPortalToken: token, orderPortalTokenCreatedAt: new Date().toISOString().slice(0,10)}));
    const link = window.location.origin + '/order?t=' + token;
    await navigator.clipboard.writeText(link);
    toast('Portal link generated & copied ✓');
    _renderEmailsRightCol();
  } catch(e) {
    console.error(e);
    toast('Error generating portal link');
  }
}

function getOverdueCadence(accounts) {
  const overdue = [];
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  accounts.forEach(a => {
    const cadence = a.cadence || [];
    const hasSent = stage => cadence.some(c =>
      c.stage === stage || c.stage === stage.replace(/-/g,'_'));
    if ((a.status === 'active' || !a.status) &&
        !hasSent('approved') &&
        (a.since || a.createdAt || '') < oneDayAgo) {
      overdue.push({account: a, reason: 'Welcome email not sent', stage: 'approved', priority: 'high'});
    }
  });
  return overdue;
}

function renderEmailsTabOverview(accounts) {
  const overdue = getOverdueCadence(accounts);
  const el = document.getElementById('emails-tab-overview');
  if (!el) return;

  let overdueHtml = '';
  if (overdue.length) {
    const items = overdue.map(o => `
      <div class="attn-item" style="border-left:3px solid var(--red);margin-bottom:8px">
        <div class="attn-info">
          <div class="attn-name">${escHtml(o.account.name)}</div>
          <div class="attn-reason">${escHtml(o.reason)}</div>
        </div>
        <button class="btn xs primary" onclick="selectEmailTemplate('${o.stage}');selectEmailsAccount('${o.account.id}');switchEmailsTab('compose')">Compose Now</button>
        <button class="btn xs" onclick="openAccount('${o.account.id}')">View</button>
      </div>`).join('');
    overdueHtml = `<div class="card" style="margin-bottom:16px;border-left:3px solid var(--red)">
      <div class="section-hdr" style="margin-bottom:8px"><h3 style="color:var(--red)">⚠️ Overdue (${overdue.length})</h3></div>
      ${items}
    </div>`;
  }

  const STAGES = [
    {id:'application-received', label:'Received'},
    {id:'approved',             label:'Approved'},
    {id:'invoice-sent',         label:'Invoice'},
    {id:'first-order',          label:'1st Order'},
  ];
  const rows = accounts.map(a => {
    const cadence = a.cadence || [];
    const stageCells = STAGES.map(s => {
      const entry = cadence.find(c =>
        c.stage === s.id || c.stage === s.id.replace(/-/g,'_'));
      if (entry) {
        const d = entry.sentAt
          ? new Date(entry.sentAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})
          : '';
        return `<td style="text-align:center">
          <span style="color:var(--green);font-size:16px">✓</span>
          <div style="font-size:10px;color:var(--muted)">${d}</div>
        </td>`;
      }
      return `<td style="text-align:center"><span style="color:#d1d5db;font-size:16px">○</span></td>`;
    }).join('');
    const brand = a.isPbf
      ? '<span class="badge green">🌿 LF</span>'
      : '<span class="badge purple">💜 purpl</span>';
    return `<tr>
      <td><strong>${escHtml(a.name)}</strong></td>
      <td>${brand}</td>
      ${stageCells}
      <td><button class="btn xs primary" onclick="openAccount('${a.id}')">View</button></td>
    </tr>`;
  }).join('');

  el.innerHTML = overdueHtml + `
    <div class="card">
      <div class="tbl-wrap">
        <table>
          <thead><tr>
            <th>Account</th><th>Brand</th>
            <th style="text-align:center">Received</th>
            <th style="text-align:center">Approved</th>
            <th style="text-align:center">Invoice</th>
            <th style="text-align:center">1st Order</th>
            <th>Actions</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="empty">No accounts yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function renderEmailsTabHistory(accounts) {
  const STAGE_LABELS = {
    'application-received': 'Application Received',
    'application_received': 'Application Received',
    'approved':             'Approved — Welcome',
    'approved_welcome':     'Approved — Welcome',
    'rejected':             'Rejected',
    'rejected_decline':     'Rejected',
    'invoice-sent':         'Invoice Sent',
    'invoice_sent':         'Invoice Sent',
    'first-order':          'First Order Follow-up',
    'first_order_followup': 'First Order Follow-up',
  };
  const allEntries = [];
  accounts.forEach(a => {
    (a.cadence||[]).forEach(c => {
      allEntries.push({...c, accountName: a.name, accountId: a.id});
    });
  });
  allEntries.sort((a,b) => (b.sentAt||'') > (a.sentAt||'') ? 1 : -1);

  const rows = allEntries.map(e => `<tr>
    <td>${e.sentAt ? new Date(e.sentAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—'}</td>
    <td><strong>${escHtml(e.accountName||'?')}</strong></td>
    <td>${escHtml(STAGE_LABELS[e.stage]||e.stage||'—')}</td>
    <td><span class="badge gray">${e.method||'manual'}</span></td>
    <td><button class="btn xs" onclick="openAccount('${e.accountId}')">View Account</button></td>
  </tr>`).join('');

  const el = document.getElementById('emails-tab-history');
  if (el) el.innerHTML = `
    <div class="card">
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Date</th><th>Account</th><th>Template</th><th>Method</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="5" class="empty">No emails sent yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function switchEmailsTab(tab) {
  ['compose','overview','history','mass'].forEach(t => {
    const el = document.getElementById('emails-tab-'+t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('#page-emails .tab').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tab));
  });
  if (tab === 'mass') renderMassEmail();
}

let _meBatchQueue  = [];
let _meBatchIdx    = 0;

function renderMassEmail() {
  // Wire mode tabs once
  const tabs = qs('#me-mode-tabs');
  if (tabs && !tabs.dataset.wired) {
    tabs.dataset.wired = '1';
    tabs.querySelectorAll('.tab').forEach(t=>{
      t.addEventListener('click', ()=>{
        tabs.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
        t.classList.add('active');
        const mode = t.dataset.mode;
        qs('#me-broadcast').style.display = mode === 'broadcast' ? '' : 'none';
        qs('#me-batch').style.display     = mode === 'batch'     ? '' : 'none';
      });
    });
  }
  // Wire brand filter buttons
  qs('#me-brand-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.onclick = () => { setMeBrandBtn('#me-brand-btns', b.dataset.val); renderMeAccountList(); };
  });
  qs('#me-batch-brand-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.onclick = () => { setMeBrandBtn('#me-batch-brand-btns', b.dataset.val); renderMeBatchList(); };
  });
  renderMeAccountList();
  renderMeBatchList();
}

function setMeBrandBtn(containerSel, val) {
  qs(containerSel)?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.val === val);
  });
}

function _getMeFilteredAccounts(brandSel, lastContactSel, statusSel) {
  const brand       = qs(brandSel)?.querySelector('.ac-brand-btn.active')?.dataset?.val ?? '';
  const lastContact = qs(lastContactSel)?.value || '';
  const status      = qs(statusSel)?.value || '';
  let list = DB.a('ac');
  if (status === 'active') list = list.filter(a=>a.status==='active');
  if (brand === 'lf')    list = list.filter(a=>a.isPbf);
  if (brand === 'purpl') list = list.filter(a=>!a.isPbf);
  if (lastContact === 'never') list = list.filter(a=>!a.lastContacted);
  else if (lastContact) {
    const days = parseInt(lastContact);
    list = list.filter(a=>!a.lastContacted || daysAgo(a.lastContacted) >= days);
  }
  return list;
}

function renderMeAccountList() {
  const list = _getMeFilteredAccounts('#me-brand-btns', '#me-last-contact-filter', '#me-status-filter');
  const el = qs('#me-account-list');
  if (!el) return;
  el.innerHTML = list.map(a=>`
    <div style="display:flex;align-items:center;gap:8px;padding:5px 4px;border-bottom:1px solid var(--border)">
      <input type="checkbox" id="me-chk-${a.id}" ${_meSelectedIds.has(a.id)?'checked':''} onchange="meToggleAccount('${a.id}',this.checked)" style="width:14px;height:14px;flex-shrink:0">
      <label for="me-chk-${a.id}" style="flex:1;cursor:pointer;font-size:13px">
        <div>${escHtml(a.name)}</div>
        <div style="font-size:11px;color:var(--muted)">${a.lastContacted ? fmtD(a.lastContacted) : 'Never contacted'}</div>
      </label>
    </div>`).join('') || '<div style="color:var(--muted);font-size:13px;padding:8px">No accounts match filters.</div>';
  _updateMeCount();
}

function renderMeBatchList() {
  const list = _getMeFilteredAccounts('#me-batch-brand-btns', '#me-batch-last-contact', null);
  const el = qs('#me-batch-list');
  if (!el) return;
  el.innerHTML = list.map(a=>`
    <div style="display:flex;align-items:center;gap:8px;padding:5px 4px;border-bottom:1px solid var(--border)">
      <input type="checkbox" id="meb-chk-${a.id}" ${_meSelectedIds.has(a.id)?'checked':''} onchange="meToggleAccount('${a.id}',this.checked)" style="width:14px;height:14px;flex-shrink:0">
      <label for="meb-chk-${a.id}" style="flex:1;cursor:pointer;font-size:13px">
        <div>${escHtml(a.name)}</div>
        <div style="font-size:11px;color:var(--muted)">${a.lastContacted ? fmtD(a.lastContacted) : 'Never contacted'}</div>
      </label>
    </div>`).join('') || '<div style="color:var(--muted);font-size:13px;padding:8px">No accounts match filters.</div>';
  _updateMeBatchCount();
}

function meToggleAccount(id, checked) {
  if (checked) _meSelectedIds.add(id); else _meSelectedIds.delete(id);
  _updateMeCount();
  _updateMeBatchCount();
  // sync checkboxes in both lists
  const bc = qs('#meb-chk-'+id); if (bc) bc.checked = checked;
  const mc = qs('#me-chk-'+id);  if (mc) mc.checked  = checked;
}

function meSelectAll() {
  _getMeFilteredAccounts('#me-brand-btns','#me-last-contact-filter','#me-status-filter')
    .forEach(a=>_meSelectedIds.add(a.id));
  renderMeAccountList();
}
function meDeselectAll() {
  _getMeFilteredAccounts('#me-brand-btns','#me-last-contact-filter','#me-status-filter')
    .forEach(a=>_meSelectedIds.delete(a.id));
  renderMeAccountList();
}
function meBatchSelectAll() {
  _getMeFilteredAccounts('#me-batch-brand-btns','#me-batch-last-contact',null)
    .forEach(a=>_meSelectedIds.add(a.id));
  renderMeBatchList();
}
function meBatchDeselectAll() {
  _getMeFilteredAccounts('#me-batch-brand-btns','#me-batch-last-contact',null)
    .forEach(a=>_meSelectedIds.delete(a.id));
  renderMeBatchList();
}

function _updateMeCount() {
  const n = _meSelectedIds.size;
  const countEl = qs('#me-selected-count'); if (countEl) countEl.textContent = `${n} selected`;
  const sendEl  = qs('#me-send-count');     if (sendEl)  sendEl.textContent  = n;
}
function _updateMeBatchCount() {
  const el = qs('#me-batch-count'); if (el) el.textContent = `${_meSelectedIds.size} selected`;
}

function setMeFilter() { renderMeAccountList(); }
function setMeBatchFilter() { renderMeBatchList(); }

function setMeRegarding(val) {
  qs('#me-regarding-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.val === val);
  });
  setMeFrom(_defaultFromForRegarding(val));
}

function setMeFrom(val) {
  qs('#me-from-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.val === val);
  });
}

async function meBroadcastGenerate() {
  const n        = _meSelectedIds.size;
  const regarding = qs('#me-regarding-btns')?.querySelector('.ac-brand-btn.active')?.dataset?.val || 'purpl';
  const goal     = qs('#me-goal')?.value?.trim() || '';
  const brandLabel = regarding === 'purpl' ? 'purpl (lavender lemonade)' : regarding === 'lf' ? 'Lavender Fields (farm products)' : 'purpl and Lavender Fields';
  const userPrompt = `Write a broadcast wholesale email to ${n} accounts. Regarding: ${brandLabel}. ${goal ? 'Goal: ' + goal + '.' : ''} Keep it under 150 words, professional, no emojis. End with this exact signature:\n${_AI_SIGNATURE}`;
  const statusEl = qs('#me-broadcast-status');
  if (statusEl) statusEl.textContent = '⏳ Generating…';
  try {
    const result = await _callAnthropicApi(userPrompt);
    if (qs('#me-subject')) qs('#me-subject').value = result.subject || '';
    if (qs('#me-body'))    qs('#me-body').value    = result.body    || '';
    if (statusEl) statusEl.textContent = '✓ Draft generated';
  } catch(e) {
    if (statusEl) statusEl.textContent = '';
    toast('Error: ' + e.message, 5000);
  }
}

async function meBroadcastSend() {
  const accounts = DB.a('ac').filter(a=>_meSelectedIds.has(a.id));
  if (!accounts.length) { toast('No accounts selected'); return; }
  const subject   = qs('#me-subject')?.value?.trim() || '';
  const body      = qs('#me-body')?.value?.trim()    || '';
  const regarding = qs('#me-regarding-btns')?.querySelector('.ac-brand-btn.active')?.dataset?.val || 'purpl';
  const statusEl  = qs('#me-broadcast-status');
  const sendBtn   = qs('#me-send-btn');

  if (!subject || !body) { toast('Enter a subject and body before sending'); return; }

  // Build email HTML once — body is plain text with possible newlines
  const bodyHtml  = body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  const html      = buildEmailHTML(PBF_HEADER_HTML, '#8B5FBF', `<p style="white-space:pre-wrap;margin:0">${bodyHtml}</p>`);

  if (sendBtn) sendBtn.disabled = true;
  let sent = 0, failed = 0;

  for (let i = 0; i < accounts.length; i++) {
    const a     = accounts[i];
    const email = (a.contacts||[]).find(c=>c.email)?.email || a.email || '';
    if (statusEl) statusEl.textContent = `Sending ${i+1} of ${accounts.length}…`;

    if (!email) { failed++; }
    else {
      try {
        const result = await callSendEmail(email, 'lavender@pbfwholesale.com', subject, html);
        const entry = {
          id: uid(), stage: 'broadcast',
          sentAt: new Date().toISOString(),
          sentBy: 'graham', method: 'resend',
          invoiceRef: subject,
        };
        if (result?.id) entry.sentMessageId = result.id;
        DB.update('ac', a.id, ac => ({
          ...ac,
          lastContacted: today(),
          cadence: [...(ac.cadence||[]), entry],
        }));
        sent++;
      } catch(_) { failed++; }
    }

    if (i < accounts.length - 1) await new Promise(r=>setTimeout(r, 300));
  }

  const summary = `Broadcast complete — ${sent} sent${failed ? `, ${failed} failed` : ''}`;
  if (statusEl) statusEl.textContent = `✓ ${summary}`;
  if (sendBtn) sendBtn.disabled = false;
  toast(summary, 5000);
}

// ── Batch Session ─────────────────────────────────────────
function meBatchStart() {
  const queue = DB.a('ac').filter(a=>_meSelectedIds.has(a.id));
  if (!queue.length) { toast('Select accounts first'); return; }
  _meBatchQueue = queue;
  _meBatchIdx   = 0;
  _renderBatchWorker();
}

function _renderBatchWorker() {
  const worker = qs('#me-batch-worker');
  if (!worker) return;
  if (_meBatchIdx >= _meBatchQueue.length) {
    worker.innerHTML = `<div style="text-align:center;padding:32px">
      <div style="font-size:24px;margin-bottom:8px">✓</div>
      <div style="font-size:16px;font-weight:600">Session complete!</div>
      <div style="color:var(--muted);margin-top:4px">${_meBatchQueue.length} accounts drafted</div>
      <button class="btn secondary" style="margin-top:16px" onclick="meBatchReset()">Start New Session</button>
    </div>`;
    return;
  }
  const a = _meBatchQueue[_meBatchIdx];
  const entries = (a.outreach||[]).slice().sort((x,y)=>y.date>x.date?1:-1).slice(0,2);
  const histHtml = entries.map(e=>`<div style="font-size:12px;color:var(--muted);margin-bottom:4px">${fmtD(e.date)} · ${e.type||'—'} — ${escHtml((e.notes||e.note||'').slice(0,80))}</div>`).join('') || '<div style="font-size:12px;color:var(--muted)">No history</div>';
  const defaultReg  = a.isPbf ? 'lf' : 'purpl';
  const defaultFrom = _defaultFromForRegarding(defaultReg);

  worker.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <span style="font-size:12px;color:var(--muted)">Account ${_meBatchIdx+1} of ${_meBatchQueue.length}</span>
      <button class="btn sm secondary" onclick="meBatchEnd()">End Session</button>
    </div>
    <div style="margin-bottom:10px">
      <div style="font-size:16px;font-weight:700">${escHtml(a.name)}</div>
      <div style="font-size:12px;color:var(--muted)">${a.type||''} · Last contacted: ${a.lastContacted?fmtD(a.lastContacted):'Never'}</div>
    </div>
    <div style="margin-bottom:8px">${histHtml}</div>
    <div class="form-row" style="margin-bottom:8px">
      <label>Regarding</label>
      <div class="ac-brand-btns" id="mebw-regarding-btns">
        <button type="button" class="ac-brand-btn ${defaultReg==='purpl'?'active':''}" data-val="purpl" onclick="setMebwRegarding('purpl')">💜 purpl</button>
        <button type="button" class="ac-brand-btn ${defaultReg==='lf'?'active':''}" data-val="lf" onclick="setMebwRegarding('lf')">🌿 LF</button>
        <button type="button" class="ac-brand-btn" data-val="both" onclick="setMebwRegarding('both')">Both</button>
      </div>
    </div>
    <div class="form-row" style="margin-bottom:8px">
      <label>Send from</label>
      <div id="mebw-from-btns">
        <span class="badge purple" style="font-size:12px">lavender@pbfwholesale.com</span>
      </div>
    </div>
    <div class="form-row" style="margin-bottom:8px">
      <label>Context <span style="color:var(--muted);font-weight:400">(optional)</span></label>
      <input type="text" id="mebw-context" placeholder="e.g. Sample follow-up...">
    </div>
    <button class="btn secondary" id="mebw-gen-btn" onclick="meBatchGenerate('${a.id}')" style="margin-bottom:10px">✨ Generate Draft</button>
    <div id="mebw-output" style="display:none">
      <div class="form-row" style="margin-bottom:6px">
        <label>Subject</label>
        <input type="text" id="mebw-subject" style="background:var(--surface-2,#f9f8ff)">
      </div>
      <div class="form-row" style="margin-bottom:8px">
        <label>Body</label>
        <textarea id="mebw-body" rows="8" style="background:var(--surface-2,#f9f8ff);font-size:13px;line-height:1.5"></textarea>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <button class="btn secondary" onclick="mebwOpenMailto('${a.id}')">📧 Open in Email Client</button>
        <button class="btn secondary" onclick="mebwCopyBody()">📋 Copy Body</button>
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:8px">
      <button class="btn primary" onclick="meBatchNext('${a.id}')">Next → <span style="font-size:11px;opacity:.7">(logs outreach)</span></button>
    </div>`;
}

function setMebwRegarding(val) {
  qs('#mebw-regarding-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.val === val);
  });
  setMebwFrom(_defaultFromForRegarding(val));
}

function setMebwFrom(val) {
  qs('#mebw-from-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.val === val);
  });
}

async function meBatchGenerate(accountId) {
  const a = DB.a('ac').find(x=>x.id===accountId);
  if (!a) return;
  const regarding = qs('#mebw-regarding-btns')?.querySelector('.ac-brand-btn.active')?.dataset?.val || 'purpl';
  const context   = qs('#mebw-context')?.value?.trim() || '';
  const entries   = (a.outreach||[]).slice().sort((x,y)=>y.date>x.date?1:-1).slice(0,3);
  const historyText = entries.length ? entries.map(e=>`- ${e.date} (${e.type||'—'}): ${e.notes||e.note||'—'}`).join('\n') : 'No prior outreach.';
  const brandLabel = regarding === 'purpl' ? 'purpl (lavender lemonade)' : regarding === 'lf' ? 'Lavender Fields (farm products)' : 'purpl and Lavender Fields';

  const btn = qs('#mebw-gen-btn');
  if (btn) { btn.disabled=true; btn.textContent='⏳ Generating…'; }

  const userPrompt = `Write a wholesale outreach email for the following account:\n\nAccount: ${a.name}\nType: ${a.type||'Wholesale Account'}\nTerritory: ${a.territory||'New Hampshire'}\nBrand: ${brandLabel}\nLast order: ${a.lastOrder?fmtD(a.lastOrder):'Never'}\nLast contacted: ${a.lastContacted?fmtD(a.lastContacted):'Never'}\n\nRecent outreach history:\n${historyText}\n\n${context?'Goal / context: '+context+'\n':''}\nEnd the email with this exact signature:\n${_AI_SIGNATURE}`;

  try {
    const result = await _callAnthropicApi(userPrompt);
    if (qs('#mebw-subject')) qs('#mebw-subject').value = result.subject || '';
    if (qs('#mebw-body'))    qs('#mebw-body').value    = result.body    || '';
    qs('#mebw-output').style.display = '';
  } catch(e) {
    toast('Error: '+e.message, 5000);
  } finally {
    if (btn) { btn.disabled=false; btn.textContent='✨ Generate Draft'; }
  }
}

function mebwOpenMailto(accountId) {
  const a = DB.a('ac').find(x=>x.id===accountId);
  const email    = (a?.contacts||[]).find(c=>c.email)?.email || a?.email || '';
  const subject  = encodeURIComponent(qs('#mebw-subject')?.value||'');
  const body     = encodeURIComponent(qs('#mebw-body')?.value||'');
  const fromAddr = qs('#mebw-from-btns')?.querySelector('.ac-brand-btn.active')?.dataset?.val || 'lavender@pbfwholesale.com';
  toast(`Opening — send from: ${fromAddr}`, 3500);
  window.open(`mailto:${encodeURIComponent(email)}?subject=${subject}&body=${body}`);
}

function mebwCopyBody() {
  const body = qs('#mebw-body')?.value||'';
  navigator.clipboard.writeText(body).then(()=>toast('Body copied ✓')).catch(()=>toast('Copy failed'));
}

function meBatchNext(accountId) {
  // Log outreach on current account
  const regarding = qs('#mebw-regarding-btns')?.querySelector('.ac-brand-btn.active')?.dataset?.val || 'purpl';
  const subject   = qs('#mebw-subject')?.value || '';
  if (accountId) {
    DB.update('ac', accountId, ac=>({
      ...ac,
      lastContacted: today(),
      outreach: [...(ac.outreach||[]), {
        id: uid(), date: today(), type: 'email', regarding,
        notes: subject ? `Draft: ${subject}` : 'Batch session draft', outcome: '',
      }],
    }));
  }
  _meBatchIdx++;
  _renderBatchWorker();
}

function meBatchEnd() {
  _meBatchIdx = _meBatchQueue.length;
  _renderBatchWorker();
}

function meBatchReset() {
  _meBatchQueue = [];
  _meBatchIdx   = 0;
  _meSelectedIds.clear();
  const worker = qs('#me-batch-worker');
  if (worker) worker.innerHTML = '<div style="text-align:center;padding:32px;color:var(--muted)">Select accounts and click Start Session.</div>';
  renderMeBatchList();
}

// ── Multi-location helpers (Edit Account) ─────────────────
function _eacLocRow(loc, canRemove) {
  const esc = s => (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  return `
    <div class="eac-loc-row" data-loc-id="${loc.id}" style="background:var(--surface-2,#f9f8ff);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">
      <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">
        <input class="eac-loc-label" placeholder="Location name (e.g. Downtown)" value="${esc(loc.label)}" style="flex:1">
        ${canRemove?`<button type="button" class="btn sm red" onclick="eacRemoveLoc('${loc.id}')">✕ Remove</button>`:''}
      </div>
      <div style="margin-bottom:8px">
        <input class="eac-loc-address" placeholder="123 Main St, City, State" value="${esc(loc.address)}" style="width:100%;box-sizing:border-box">
      </div>
      <div class="form-row col2" style="margin-bottom:8px">
        <div><input class="eac-loc-contact" placeholder="Contact (optional)" value="${esc(loc.contact)}"></div>
        <div><input class="eac-loc-phone" type="tel" placeholder="Phone (optional)" value="${esc(loc.phone)}"></div>
      </div>
      <textarea class="eac-loc-droprules" placeholder="Drop-off / delivery rules for this location" style="width:100%;box-sizing:border-box;min-height:40px;resize:vertical">${esc(loc.dropOffRules)}</textarea>
    </div>`;
}

function _eacAttachPlaces(container) {
  if (!window.PlacesAC) return;
  PlacesAC.load().then(ok => {
    if (!ok) return;
    container.querySelectorAll('.eac-loc-address').forEach(el => PlacesAC.attach(el));
  });
}

function eacRenderLocs(locs) {
  const container = qs('#eac-locs-list');
  if (!container) return;
  container.innerHTML = locs.map((loc, i) => _eacLocRow(loc, locs.length > 1)).join('');
  _eacAttachPlaces(container);
}

function eacAddLoc() {
  const container = qs('#eac-locs-list');
  if (!container) return;
  const loc = {id: uid(), label:'', address:'', contact:'', phone:'', dropOffRules:''};
  const rows = container.querySelectorAll('.eac-loc-row');
  // If this is the second location being added, show Remove on the first row too
  if (rows.length === 1) {
    const firstRow = rows[0];
    const firstId = firstRow.dataset.locId;
    const headerDiv = firstRow.querySelector('div');
    if (headerDiv && !firstRow.querySelector('button[onclick^="eacRemoveLoc"]')) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn sm red';
      btn.setAttribute('onclick', `eacRemoveLoc('${firstId}')`);
      btn.textContent = '✕ Remove';
      headerDiv.appendChild(btn);
    }
  }
  const div = document.createElement('div');
  div.innerHTML = _eacLocRow(loc, true);
  const row = div.firstElementChild;
  container.appendChild(row);
  _eacAttachPlaces(row);
}

function eacRemoveLoc(locId) {
  const container = qs('#eac-locs-list');
  if (!container) return;
  container.querySelector(`[data-loc-id="${locId}"]`)?.remove();
  const remaining = container.querySelectorAll('.eac-loc-row');
  if (remaining.length === 1) {
    remaining[0].querySelectorAll('button[onclick^="eacRemoveLoc"]').forEach(b => b.remove());
  }
}

// ── Multi-contact helpers (Edit Account) ─────────────────
function _eacContactRow(c, isOnly) {
  const esc = s => (s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  return `
    <div class="eac-contact-row" data-contact-id="${c.id}" style="background:var(--surface-2,#f9f8ff);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">
      <div style="display:flex;gap:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap">
        <input class="eac-ct-name" placeholder="Name" value="${esc(c.name)}" style="flex:1;min-width:110px">
        <input class="eac-ct-role" placeholder="Role" value="${esc(c.role||'')}" style="flex:1;min-width:90px">
        <label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap;cursor:pointer">
          <input type="radio" name="eac-ct-primary" class="eac-ct-primary" value="${c.id}" ${c.isPrimary?'checked':''}> Primary
        </label>
        ${!isOnly?`<button type="button" class="btn sm red" onclick="eacRemoveContact('${c.id}')">✕</button>`:''}
      </div>
      <div class="form-row col2" style="margin:0">
        <div><input class="eac-ct-email" type="email" placeholder="Email" value="${esc(c.email||'')}"></div>
        <div><input class="eac-ct-phone" type="tel" placeholder="Phone" value="${esc(c.phone||'')}"></div>
      </div>
    </div>`;
}

function eacRenderContacts(contacts) {
  const container = qs('#eac-contacts-list');
  if (!container) return;
  container.innerHTML = contacts.map(c => _eacContactRow(c, contacts.length === 1)).join('');
}

function eacAddContact() {
  const container = qs('#eac-contacts-list');
  if (!container) return;
  const rows = container.querySelectorAll('.eac-contact-row');
  // When going from 1→2, show remove button on the first row too
  if (rows.length === 1) {
    const firstRow = rows[0];
    const firstId = firstRow.dataset.contactId;
    const headerDiv = firstRow.querySelector('div');
    if (headerDiv && !firstRow.querySelector('.btn.red')) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn sm red';
      btn.setAttribute('onclick', `eacRemoveContact('${firstId}')`);
      btn.textContent = '✕';
      headerDiv.appendChild(btn);
    }
  }
  const c = {id: uid(), name:'', role:'', email:'', phone:'', isPrimary: rows.length === 0};
  const div = document.createElement('div');
  div.innerHTML = _eacContactRow(c, false);
  container.appendChild(div.firstElementChild);
}

function eacRemoveContact(id) {
  const container = qs('#eac-contacts-list');
  if (!container) return;
  container.querySelector(`[data-contact-id="${id}"]`)?.remove();
  const remaining = container.querySelectorAll('.eac-contact-row');
  if (remaining.length === 1) {
    remaining[0].querySelectorAll('.btn.red').forEach(b => b.remove());
    const radio = remaining[0].querySelector('.eac-ct-primary');
    if (radio) radio.checked = true;
  }
}

function editAccount(id) {
  const a = DB.a('ac').find(x=>x.id===id) || {id:uid()};
  const isNew = !DB.a('ac').find(x=>x.id===id);
  const m = document.getElementById('modal-edit-account');
  if (!m) return;

  qs('#eac-name').value = a.name||'';
  // Populate contacts (migrate single-contact accounts on the fly)
  const _editContacts = (a.contacts && a.contacts.length)
    ? a.contacts
    : [{id: uid(), name: a.contact||'', role:'', email: a.email||'', phone: a.phone||'', isPrimary: true}];
  eacRenderContacts(_editContacts);
  qs('#eac-type').value = a.type||'Grocery';
  qs('#eac-territory').value = a.territory||'';
  qs('#eac-status').value = a.status||'active';
  qs('#eac-since').value = a.since||today();
  if (qs('#eac-ispbf')) qs('#eac-ispbf').checked = !!a.isPbf;

  // Populate fulfilled-by dropdown with active distributors
  const ffSel = qs('#eac-fulfilled-by');
  if (ffSel) {
    const dists = DB.a('dist_profiles').filter(d=>d.status==='active');
    ffSel.innerHTML = '<option value="direct">Direct (self-deliver)</option>' +
      dists.map(d=>`<option value="${d.id}">${d.name}</option>`).join('');
    ffSel.value = a.fulfilledBy || 'direct';
  }

  // Build locations list (migrate old single-address accounts on the fly)
  const locs = (a.locs && a.locs.length)
    ? a.locs
    : [{id: uid(), label:'', address: a.address||'', contact:'', phone:'', dropOffRules: a.dropOffRules||''}];
  eacRenderLocs(locs);

  // SKU checkboxes
  qs('#eac-skus').innerHTML = SKUS.map(s=>`
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
      <input type="checkbox" value="${s.id}" ${(a.skus||[]).includes(s.id)?'checked':''}> ${s.label}
    </label>`).join('');

  // Par inputs
  renderParInputs(a);

  // Pricing fields
  if (qs('#ac-price-direct')) qs('#ac-price-direct').value = a.pricePerCaseDirect||'';
  if (qs('#ac-price-dist'))   qs('#ac-price-dist').value   = a.pricePerCaseDist||'';
  if (qs('#ac-price-custom')) qs('#ac-price-custom').value = a.pricePerCaseCustom||'';

  qs('#eac-save-btn').onclick = () => saveAccount(id, isNew);
  if (!isNew) {
    const delBtn = qs('#eac-delete-btn');
    if (delBtn) { delBtn.style.display=''; delBtn.onclick = ()=>deleteAccount(id); }
  } else {
    const delBtn = qs('#eac-delete-btn');
    if (delBtn) delBtn.style.display='none';
  }

  openModal('modal-edit-account');
}

function renderParInputs(a) {
  const el = qs('#eac-par');
  if (!el) return;
  const checked = [...document.querySelectorAll('#eac-skus input:checked')].map(x=>x.value);
  el.innerHTML = checked.length ? checked.map(s=>`
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      ${skuBadge(s)}
      <input type="number" id="par-${s}" value="${a.par?.[s]||24}" min="0" step="6" style="width:80px">
      <span style="font-size:12px;color:var(--muted)">units par</span>
    </div>`).join('') : '<div style="font-size:12px;color:var(--muted)">Select SKUs above</div>';
}

async function saveAccount(id, isNew) {
  const name = qs('#eac-name')?.value?.trim();
  if (!name) { toast('Account name required'); return; }
  const skus = [...document.querySelectorAll('#eac-skus input:checked')].map(x=>x.value);
  const par = {};
  skus.forEach(s=>{par[s]=parseInt(qs('#par-'+s)?.value)||24;});

  const existing = DB.a('ac').find(x=>x.id===id);

  // Collect & geocode all location rows
  const locs = [];
  for (const row of document.querySelectorAll('#eac-locs-list .eac-loc-row')) {
    const locId      = row.dataset.locId || uid();
    const label      = row.querySelector('.eac-loc-label')?.value?.trim()||'';
    const addrEl     = row.querySelector('.eac-loc-address');
    const address    = addrEl?.value?.trim()||'';
    const contact    = row.querySelector('.eac-loc-contact')?.value?.trim()||'';
    const phone      = row.querySelector('.eac-loc-phone')?.value?.trim()||'';
    const dropOffRules = row.querySelector('.eac-loc-droprules')?.value?.trim()||'';
    let lat = null, lng = null;
    if (address && window.PlacesAC) {
      const coords = await PlacesAC.getCoords(addrEl).catch(()=>null);
      if (coords) { lat = coords.lat; lng = coords.lng; }
    }
    locs.push({id: locId, label, address, lat, lng, contact, phone, dropOffRules});
  }

  // Collect contacts from the contacts section
  const contacts = [];
  let primaryRadioVal = document.querySelector('#eac-contacts-list input[name="eac-ct-primary"]:checked')?.value || '';
  for (const row of document.querySelectorAll('#eac-contacts-list .eac-contact-row')) {
    const cId = row.dataset.contactId || uid();
    contacts.push({
      id:        cId,
      name:      row.querySelector('.eac-ct-name')?.value?.trim()||'',
      role:      row.querySelector('.eac-ct-role')?.value?.trim()||'',
      email:     row.querySelector('.eac-ct-email')?.value?.trim()||'',
      phone:     row.querySelector('.eac-ct-phone')?.value?.trim()||'',
      isPrimary: cId === primaryRadioVal,
    });
  }
  // If nothing marked primary, mark first
  if (contacts.length && !contacts.some(c=>c.isPrimary)) contacts[0].isPrimary = true;
  const primaryContact = contacts.find(c=>c.isPrimary) || contacts[0] || {};

  const rec = {
    // Preserve ALL existing fields first — avoids data loss on save
    ...(existing||{}),
    id, name,
    contacts,
    // Backward-compat flat fields derived from primary contact
    contact:      primaryContact.name||'',
    phone:        primaryContact.phone||'',
    email:        primaryContact.email||'',
    // top-level address/lat/lng from first location (backward compat for display)
    address:      locs[0]?.address||'',
    lat:          locs[0]?.lat||null,
    lng:          locs[0]?.lng||null,
    locs,
    type:         qs('#eac-type')?.value||'Grocery',
    territory:    qs('#eac-territory')?.value?.trim()||'',
    status:       qs('#eac-status')?.value||'active',
    since:        qs('#eac-since')?.value||today(),
    dropOffRules: locs[0]?.dropOffRules||'',
    isPbf:        qs('#eac-ispbf')?.checked || false,
    fulfilledBy:  qs('#eac-fulfilled-by')?.value || 'direct',
    skus, par,
    pricePerCaseDirect: (v=>isNaN(v)?null:v)(parseFloat(qs('#ac-price-direct')?.value)),
    pricePerCaseDist:   (v=>isNaN(v)?null:v)(parseFloat(qs('#ac-price-dist')?.value)),
    pricePerCaseCustom: (v=>isNaN(v)?null:v)(parseFloat(qs('#ac-price-custom')?.value)),
    notes:     existing?.notes||[],
    outreach:  existing?.outreach||[],
    lastOrder: existing?.lastOrder||null,
  };

  if (isNew) DB.push('ac', rec);
  else DB.update('ac', id, ()=>rec);
  closeModal('modal-edit-account');
  renderAccounts();
  toast(isNew?'Account added':'Account updated');
}

function deleteAccount(id) {
  if (!confirm2('Delete this account? This cannot be undone.')) return;
  DB.atomicUpdate(cache => {
    cache['ac']              = (cache['ac']             ||[]).filter(r=>r.id!==id);
    cache['iv']              = (cache['iv']             ||[]).filter(r=>r.accountId!==id);
    cache['orders']          = (cache['orders']         ||[]).filter(r=>r.accountId!==id);
    cache['retail_invoices'] = (cache['retail_invoices']||[]).filter(r=>r.accountId!==id);
    cache['returns']         = (cache['returns']        ||[]).filter(r=>r.accountId!==id);
  });
  closeModal('modal-edit-account');
  renderAccounts();
  toast('Account deleted');
}

// ══════════════════════════════════════════════════════════
//  PROSPECTS
// ══════════════════════════════════════════════════════════
const PRIORITY_CFG = {
  high:   {label:'High',   cls:'red'},
  medium: {label:'Medium', cls:'amber'},
  low:    {label:'Low',    cls:'gray'},
};
const PRIORITY_ORDER = {high:0, medium:1, low:2};

let _prCompact = localStorage.getItem('pbf_pr_compact') === '1';
function togglePrCompact() {
  _prCompact = !_prCompact;
  localStorage.setItem('pbf_pr_compact', _prCompact ? '1' : '0');
  const btn = qs('#pr-compact-btn');
  if (btn) btn.classList.toggle('active', _prCompact);
  const el = qs('#pr-cards');
  if (el) el.classList.toggle('pr-compact', _prCompact);
}

function renderProspects() {
  let list = DB.a('pr');
  const search       = qs('#pr-search')?.value?.toLowerCase().trim() || '';
  const stageFilter  = qs('#pr-stage-filter')?.value || '';
  const brandFilter  = qs('#pr-brand-filter')?.value || '';
  const sortVal      = qs('#pr-sort')?.value || 'priority';

  if (search) list = list.filter(p=>
    p.name?.toLowerCase().includes(search) ||
    p.contact?.toLowerCase().includes(search) ||
    p.address?.toLowerCase().includes(search));
  if (stageFilter) list = list.filter(p=>p.status===stageFilter);
  if (brandFilter === 'lf')    list = list.filter(p=>!!p.isPbf);
  if (brandFilter === 'purpl') list = list.filter(p=>!p.isPbf);

  list = list.slice().sort((a,b)=>{
    if (sortVal==='priority') return (PRIORITY_ORDER[a.priority||'medium']||1)-(PRIORITY_ORDER[b.priority||'medium']||1);
    if (sortVal==='nextDate') return (a.nextDate||'9999')<(b.nextDate||'9999')?-1:1;
    if (sortVal==='name')     return (a.name||'')<(b.name||'')?-1:1;
    return 0;
  });

  const el = qs('#pr-cards');
  if (!el) return;

  if (!DB._firestoreReady) {
    el.innerHTML = _dbLoadingHTML(4);
    return;
  }

  el.classList.toggle('pr-compact', _prCompact);
  const btn = qs('#pr-compact-btn');
  if (btn) btn.classList.toggle('active', _prCompact);
  if (qs('#pr-count')) qs('#pr-count').textContent = `${list.length} prospect${list.length!==1?'s':''}`;

  el.innerHTML = list.map(p=>{
    const priCfg        = PRIORITY_CFG[p.priority||'medium']||PRIORITY_CFG.medium;
    const lastNote      = p.notes?.length ? p.notes[p.notes.length-1] : null;
    const latestSample  = (p.samples||[]).slice().sort((a,b)=>b.date>a.date?1:-1)[0];
    const smpFuDate     = latestSample?.followUpDate;
    const in7d          = new Date(Date.now()+7*86400000).toISOString().slice(0,10);
    const smpFollowBadge = latestSample && !latestSample.followUpDone && smpFuDate
      ? (smpFuDate < today()
          ? `<span class="badge red" style="font-size:10px">🧪 Follow-up overdue</span>`
          : smpFuDate <= in7d
            ? `<span class="badge amber" style="font-size:10px">🧪 Follow-up ${fmtD(smpFuDate)}</span>`
            : '')
      : '';
    const lastOutreach  = p.outreach?.length ? p.outreach[p.outreach.length-1] : null;
    const lastContactStr= p.lastContact
      ? `${fmtD(p.lastContact)} (${daysAgo(p.lastContact)}d)`
      : (lastOutreach ? `${fmtD(lastOutreach.date)} (${daysAgo(lastOutreach.date)}d)` : '—');
    const nextFollowHtml= p.nextDate
      ? `<span style="color:${p.nextDate<today()?'var(--red)':'var(--blue)'}">${fmtD(p.nextDate)}</span>`
      : (p.nextFollowUpLabel
          ? `<span style="color:var(--blue);font-style:italic">${p.nextFollowUpLabel}</span>`
          : '<span style="color:var(--muted)">—</span>');

    return `<div class="pr-card stage-${p.status||'lead'}" ${p.status==='lost'?'style="opacity:0.75;background:#f9fafb;border-color:#d1d5db"':''}>

      <div class="pr-card-hdr">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span class="pr-card-name">${escHtml(p.name)}</span>
            ${p.isPbf?`<span class="badge green" style="font-size:10px">🌿 LF</span>`:''}
          </div>
          <div class="ac-card-sub">${[p.type,p.address||p.territory].filter(Boolean).map(escHtml).join(' · ')}</div>
          ${p.contact||p.phone?`<div class="ac-card-sub">${[p.contact,p.phone].filter(Boolean).map(escHtml).join(' · ')}</div>`:''}
          ${p.email?`<div class="ac-card-email">✉ ${escHtml(p.email)}</div>`:''}
        </div>
        <div class="ac-card-badges">
          ${statusBadge(PR_STATUS,p.status)}
          <span class="badge ${priCfg.cls}">${priCfg.label}</span>
          ${latestSample?`<span class="badge" style="background:#e0f2fe;color:#0369a1;font-size:10px">🧪 ${fmtD(latestSample.date)}</span>`:''}
          ${smpFollowBadge}
        </div>
      </div>
      <div class="ac-card-metrics cols3">
        <div><div class="ac-metric-label">Last Contacted</div><div class="ac-metric-val">${lastContactStr}</div></div>
        <div><div class="ac-metric-label">Next Follow-Up</div><div class="ac-metric-val">${nextFollowHtml}</div></div>
        <div><div class="ac-metric-label">Stage</div><div class="ac-metric-val">${PR_STATUS[p.status]?.label||p.status||'—'}</div></div>
      </div>
      ${lastNote?`<div class="ac-card-section"><div class="ac-card-section-label">Notes</div><div style="font-size:13px">${escHtml(lastNote.text)}</div></div>`:''}
      ${!lastNote&&lastOutreach?`<div class="ac-card-section"><div class="ac-card-section-label">Recent Outreach</div><div style="font-size:13px">${lastOutreach.type} · ${fmtD(lastOutreach.date)}</div></div>`:''}
      ${p.status==='lost'&&p.lostReason?`<div class="ac-card-section"><div class="ac-card-section-label" style="color:var(--red)">Lost — ${escHtml(p.lostReason)}</div>${p.lostNotes?`<div style="font-size:13px">${escHtml(p.lostNotes)}</div>`:''}</div>`:''}
      <div class="pr-card-nextsteps pr-card-nextsteps-tap" onclick="openLogOutreachModal('pr','${p.id}')">
        <div class="ac-card-section-label" style="color:#1e40af">☑ Next Steps <span style="font-size:10px;color:#93c5fd">(tap to log)</span></div>
        <div class="pr-card-nextsteps-text">${p.nextAction||'<span style="color:#93c5fd">No next steps set — tap to add</span>'}${p.nextDate?' &nbsp;·&nbsp; <strong>'+fmtD(p.nextDate)+'</strong>':''}</div>
      </div>
      <div class="ac-card-actions">
        <button class="btn sm primary" onclick="openProspect('${p.id}')">View</button>
        <button class="btn sm" onclick="logProspectOutreach('${p.id}')">📞 Log</button>
        <button class="btn sm" onclick="editProspect('${p.id}')">Edit</button>
        <button class="btn sm green" onclick="if(confirm2('Convert to account?'))convertProspect('${p.id}')">→ Convert</button>
        <button class="btn xs" onclick="openLogSampleModal('pr','${p.id}')">🧪 Sample</button>
        ${p.status==='lost'
          ?`<button class="btn sm green" onclick="reactivateProspect('${p.id}')">↩ Reactivate</button>`
          :`<button class="btn sm red" onclick="markProspectLost('${p.id}')">✕</button>`}
      </div>
    </div>`;
  }).join('')||'<div class="empty">No prospects yet. Click "+ Add Prospect" to get started.</div>';
}

function openProspect(id) {
  const p = DB.a('pr').find(x=>x.id===id);
  if (!p) return;
  const m = document.getElementById('modal-prospect');
  if (!m) return;

  // Header
  qs('#mpr-name').textContent = p.name;
  qs('#mpr-status-badge').innerHTML = statusBadge(PR_STATUS, p.status);
  const priCfg = PRIORITY_CFG[p.priority||'medium'] || PRIORITY_CFG.medium;
  const priBadgeEl = qs('#mpr-priority-badge');
  if (priBadgeEl) priBadgeEl.innerHTML = `<span class="badge ${priCfg.cls}">${priCfg.label}</span>`;

  // Overview fields
  qs('#mpr-contact').textContent = p.contact||'—';
  qs('#mpr-phone').textContent = p.phone||'—';
  qs('#mpr-email').textContent = p.email||'—';
  qs('#mpr-type').textContent = p.type||'—';
  qs('#mpr-territory').textContent = p.territory||'—';
  qs('#mpr-source').textContent = p.source||'—';
  qs('#mpr-last-contact').textContent = p.lastContact
    ? `${fmtD(p.lastContact)} (${daysAgo(p.lastContact)}d ago)` : '—';
  const nextDateEl = qs('#mpr-next-date');
  if (nextDateEl) {
    if (p.nextDate) {
      const nfuColor = p.nextDate < today() ? '#dc2626' : p.nextDate === today() ? '#d97706' : '#1d4ed8';
      nextDateEl.innerHTML = `<span style="color:${nfuColor};font-weight:600">${fmtD(p.nextDate)}</span>`;
    } else {
      nextDateEl.textContent = p.nextFollowUpLabel || '—';
    }
  }
  qs('#mpr-next-action').textContent = p.nextAction||'—';

  // Lost row
  const lostRow = qs('#mpr-lost-row');
  if (lostRow) {
    if (p.status === 'lost') {
      lostRow.style.display = '';
      if (qs('#mpr-lost-reason')) qs('#mpr-lost-reason').textContent = p.lostReason ? `Lost — ${p.lostReason}` : 'Marked as lost';
      if (qs('#mpr-lost-notes')) qs('#mpr-lost-notes').textContent = p.lostNotes || '';
      const reactBtn = qs('#mpr-reactivate-btn');
      if (reactBtn) reactBtn.onclick = () => { closeModal('modal-prospect'); reactivateProspect(id); };
    } else {
      lostRow.style.display = 'none';
    }
  }

  // Samples section
  const smpList = qs('#mpr-samples-list');
  if (smpList) {
    const samples = (p.samples||[]).slice().reverse();
    smpList.innerHTML = samples.length
      ? samples.map(s=>`<div class="note-item" style="margin-bottom:8px">
          <div class="note-date">${fmtD(s.date)}${s.flavors?` — ${escHtml(s.flavors)}`:''}</div>
          ${s.notes?`<div style="font-size:12px">${escHtml(s.notes)}</div>`:''}
          ${s.followUpDate?`<div style="font-size:12px;color:${s.followUpDone?'var(--muted)':s.followUpDate<today()?'var(--red)':'var(--blue)'}">Follow-up: ${fmtD(s.followUpDate)}${s.followUpDone?' ✓':''}</div>`:''}
          ${!s.followUpDone&&s.followUpDate?`<button class="btn xs" style="margin-top:4px" onclick="markSampleFollowUpDone('pr','${id}','${s.id}')">Mark Done</button>`:''}
        </div>`).join('')
      : '<div style="color:var(--muted);font-size:13px">No samples logged.</div>';
  }
  const smpBtn = qs('#mpr-log-sample-btn');
  if (smpBtn) smpBtn.onclick = () => openLogSampleModal('pr', id);

  // Outreach tab
  renderProspectOutreach(p);
  const logOutreachBtn = qs('#mpr-log-outreach-btn');
  if (logOutreachBtn) logOutreachBtn.onclick = () => {
    openLogOutreachModal('pr', id);
  };

  // Notes tab
  _renderProspectNotes(p);
  if (qs('#mpr-note-text')) qs('#mpr-note-text').value = '';
  if (qs('#mpr-note-next')) qs('#mpr-note-next').value = '';
  if (qs('#mpr-note-next-date')) qs('#mpr-note-next-date').value = '';

  qs('#mpr-edit-btn').onclick = () => { closeModal('modal-prospect'); editProspect(id); };
  qs('#mpr-add-note-btn').onclick = () => addProspectNote(id);
  qs('#mpr-convert-btn').onclick = () => { if(confirm2('Convert to active account?')) convertProspect(id); };

  // Tab switching
  document.querySelectorAll('#modal-prospect .tab').forEach(t=>{
    t.onclick = () => {
      document.querySelectorAll('#modal-prospect .tab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('#modal-prospect .tab-pane').forEach(x=>x.style.display='none');
      t.classList.add('active');
      const pane = document.getElementById('mpr-tab-'+t.dataset.tab);
      if (pane) pane.style.display='';
    };
  });
  document.querySelectorAll('#modal-prospect .tab')[0]?.click();

  openModal('modal-prospect');
}

function _renderProspectNotes(p) {
  const nl = qs('#mpr-notes-list');
  if (!nl) return;
  nl.innerHTML = (p.notes||[]).slice().reverse().map(n=>`
    <div class="note-item">
      <div class="note-date">${fmtD(n.date)}</div>
      <div>${escHtml(n.text||'')}</div>
      ${n.nextAction?`<div class="note-next">📅 Next: ${escHtml(n.nextAction)}${n.nextDate?' on '+fmtD(n.nextDate):''}</div>`:''}
    </div>`).join('') || '<div class="empty" style="padding:16px">No notes yet</div>';
}

function renderProspectOutreach(p) {
  const ol = qs('#mpr-outreach-list');
  if (!ol) return;
  const entries = (p.outreach||[]).slice().sort((x,y)=>y.date>x.date?1:-1);
  if (!entries.length) {
    ol.innerHTML = '<div class="empty" style="padding:16px">No follow-ups logged yet. Use the button above to log your first one.</div>';
    return;
  }
  const TYPE_LABELS = {call:'Call',email:'Email','in-person':'In Person',text:'Text',other:'Other'};
  const TYPE_CLS    = {call:'blue',email:'green','in-person':'purple',text:'gray',other:'gray'};
  const OUT_CLS     = {'Interested':'green','Ordered':'green','Needs Follow-Up':'amber','No Response':'gray','Not Interested':'red','Left Voicemail':'gray','Other':'gray'};
  ol.innerHTML = entries.map(e=>`
    <div class="note-item">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--muted)">${fmtD(e.date)}</span>
        <span class="badge ${TYPE_CLS[e.type]||'gray'}" style="font-size:10px">${TYPE_LABELS[e.type]||e.type||'Other'}</span>
        ${e.outcome?`<span class="badge ${OUT_CLS[e.outcome]||'gray'}" style="font-size:10px">${escHtml(e.outcome)}</span>`:''}
      </div>
      ${(e.notes||e.note)?`<div style="font-size:13px">${escHtml(e.notes||e.note||'')}</div>`:''}
      ${e.nextSteps?`<div style="font-size:12px;color:var(--muted);margin-top:2px">Next: ${escHtml(e.nextSteps)}</div>`:''}
      ${e.nextFollowUp?`<div style="font-size:12px;color:#1d4ed8;margin-top:4px">📅 Next follow-up: <strong>${fmtD(e.nextFollowUp)}</strong></div>`:''}
    </div>`).join('');
}

function addProspectNote(id) {
  const text = qs('#mpr-note-text')?.value?.trim();
  if (!text) return;
  const next     = qs('#mpr-note-next')?.value?.trim() || '';
  const nextDate = qs('#mpr-note-next-date')?.value || '';
  const note = {id:uid(), date:today(), text, nextAction:next, nextDate};
  DB.update('pr', id, p=>({
    ...p,
    notes: [...(p.notes||[]), note],
    lastContact: today(),
    ...(next     ? {nextAction: next}     : {}),
    ...(nextDate ? {nextDate}             : {}),
  }));
  if (qs('#mpr-note-text'))      qs('#mpr-note-text').value = '';
  if (qs('#mpr-note-next'))      qs('#mpr-note-next').value = '';
  if (qs('#mpr-note-next-date')) qs('#mpr-note-next-date').value = '';
  const p = DB.a('pr').find(x=>x.id===id);
  if (p) _renderProspectNotes(p);
  toast('Note saved');
}

function convertProspect(id) {
  const p = DB.a('pr').find(x=>x.id===id);
  if (!p) return;

  // Build new account preserving ALL prospect fields
  const newAc = {
    id:         uid(),
    name:       p.name,
    contact:    p.contact||'',
    phone:      p.phone||'',
    email:      p.email||'',
    address:    p.address||'',
    lat:        p.lat||null,
    lng:        p.lng||null,
    type:       p.type||'Grocery',
    territory:  p.territory||'',
    status:     'active',
    since:      today(),
    // Preserve prospect metadata as account context
    source:     p.source||'',
    priority:   p.priority||'',
    nextAction: p.nextAction||'',
    nextDate:   p.nextDate||'',
    skus:       [],
    par:        {},
    // Carry over all notes and outreach history
    notes:      p.notes||[],
    outreach:   p.outreach||[],
    lastOrder:  null,
    // Record conversion
    convertedFrom: 'prospect',
    convertedDate: today(),
    isPbf:      p.isPbf || false,
  };

  // Atomic: mark prospect won + create account in one Firestore write
  DB.atomicUpdate(cache => {
    cache['pr'] = (cache['pr']||[]).map(x => x.id===id ? {...x, status:'won'} : x);
    cache['ac'] = [...(cache['ac']||[]), newAc];
  });

  closeModal('modal-prospect');
  renderProspects();
  toast('Converted to account! Edit to add SKUs & par levels.');
}

function editProspect(id) {
  const p = DB.a('pr').find(x=>x.id===id) || {id:uid()};
  const isNew = !DB.a('pr').find(x=>x.id===id);
  const m = document.getElementById('modal-edit-prospect');
  if (!m) return;

  qs('#epr-name').value = p.name||'';
  qs('#epr-contact').value = p.contact||'';
  qs('#epr-phone').value = p.phone||'';
  qs('#epr-email').value = p.email||'';
  qs('#epr-address').value = p.address||'';
  qs('#epr-type').value = p.type||'Grocery';
  qs('#epr-territory').value = p.territory||'';
  qs('#epr-status').value = p.status||'lead';
  qs('#epr-source').value = p.source||'';
  qs('#epr-next-action').value = p.nextAction||'';
  qs('#epr-priority').value = p.priority||'medium';
  qs('#epr-next-date').value = p.nextDate||'';
  if (qs('#epr-ispbf')) qs('#epr-ispbf').checked = !!p.isPbf;

  qs('#epr-save-btn').onclick = () => saveProspect(id, isNew);
  const delBtn = qs('#epr-delete-btn');
  if (delBtn) {
    delBtn.style.display = isNew ? 'none' : '';
    delBtn.onclick = () => { closeModal('modal-edit-prospect'); markProspectLost(id); };
  }

  openModal('modal-edit-prospect');
  if (window.PlacesAC) PlacesAC.load().then(ok => { if (ok) PlacesAC.reattach(); });
}

async function saveProspect(id, isNew) {
  const name = qs('#epr-name')?.value?.trim();
  if (!name) { toast('Name required'); return; }

  const addrEl  = qs('#epr-address');
  const address = addrEl?.value?.trim()||'';

  // Silently capture lat/lng
  let lat = null, lng = null;
  if (address && window.PlacesAC) {
    const coords = await PlacesAC.getCoords(addrEl).catch(()=>null);
    if (coords) { lat = coords.lat; lng = coords.lng; }
  } else if (addrEl?.dataset?.lat) {
    lat = parseFloat(addrEl.dataset.lat);
    lng = parseFloat(addrEl.dataset.lng);
  }

  const existing = DB.a('pr').find(x=>x.id===id);
  const rec = {
    ...(existing||{}),
    id, name,
    contact:    qs('#epr-contact')?.value?.trim()||'',
    phone:      qs('#epr-phone')?.value?.trim()||'',
    email:      qs('#epr-email')?.value?.trim()||'',
    address,
    lat, lng,                       // stored for future map use
    type:       qs('#epr-type')?.value||'Grocery',
    territory:  qs('#epr-territory')?.value?.trim()||'',
    status:     qs('#epr-status')?.value||'lead',
    source:     qs('#epr-source')?.value?.trim()||'',
    nextAction: qs('#epr-next-action')?.value?.trim()||'',
    priority:   qs('#epr-priority')?.value||'medium',
    nextDate:   qs('#epr-next-date')?.value||'',
    isPbf:      qs('#epr-ispbf')?.checked || false,
    notes:      existing?.notes||[],
    outreach:   existing?.outreach||[],
    lastContact: existing?.lastContact||'',
  };
  if (isNew) DB.push('pr', rec);
  else DB.update('pr', id, ()=>rec);
  closeModal('modal-edit-prospect');
  renderProspects();
  toast(isNew?'Prospect added':'Prospect updated');
}

// ── Quick actions from card buttons ──────────────────────
function quickNote(id) {
  const text = prompt('Note:');
  if (!text?.trim()) return;
  const next = prompt('Next action (leave blank to skip):') || '';
  const nextDate = next ? prompt('Next action date (YYYY-MM-DD):') || '' : '';
  const note = {id:uid(), date:today(), text:text.trim(), author:'you', nextAction:next.trim(), nextDate};
  DB.update('ac', id, a=>({...a, notes:[...(a.notes||[]),note]}));
  renderAccounts();
  toast('Note saved');
}

function logOutreach(id) {
  openLogOutreachModal('ac', id);
}

function logProspectOutreach(id) {
  openLogOutreachModal('pr', id);
}

function setMloRegarding(val) {
  qs('#mlo-regarding-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.val === val);
  });
}

function openLogOutreachModal(kind, id) {
  const rec = kind === 'ac' ? DB.a('ac').find(x=>x.id===id) : DB.a('pr').find(x=>x.id===id);
  const name = rec?.name;
  qs('#mlo-title').textContent = (kind === 'ac' ? 'Log Follow-Up' : 'Log Outreach') + (name ? ` — ${name}` : '');
  qs('#mlo-id').value = id;
  qs('#mlo-kind').value = kind;
  qs('#mlo-type').value = 'call';
  qs('#mlo-date').value = today();
  qs('#mlo-note').value = '';
  qs('#mlo-nextsteps').value = '';
  qs('#mlo-nextdate').value = '';
  if (qs('#mlo-contact')) qs('#mlo-contact').value = '';
  if (qs('#mlo-outcome')) qs('#mlo-outcome').value = '';
  // Default "regarding" based on isPbf flag
  const defaultRegarding = rec?.isPbf ? 'lf' : 'purpl';
  setMloRegarding(defaultRegarding);
  const isAccount  = kind === 'ac';
  const isProspect = kind === 'pr';
  // contact: accounts only; outcome: accounts + prospects
  const contactRow = qs('#mlo-contact-row');
  const outcomeRow = qs('#mlo-outcome-row');
  if (contactRow) contactRow.style.display = isAccount ? '' : 'none';
  if (outcomeRow) outcomeRow.style.display = (isAccount || isProspect) ? '' : 'none';
  // regarding row: accounts only (prospects are always purpl)
  const regRow = qs('#mlo-regarding-row');
  if (regRow) regRow.style.display = isAccount ? '' : 'none';
  // next steps text: prospects only
  qs('#mlo-nextsteps-row').style.display = isProspect ? '' : 'none';
  // next date: both accounts and prospects
  qs('#mlo-nextdate-row').style.display = (isAccount || isProspect) ? '' : 'none';
  openModal('modal-log-outreach');
}

function saveLogOutreach() {
  const id      = qs('#mlo-id').value;
  const kind    = qs('#mlo-kind').value;
  const type    = qs('#mlo-type').value;
  const date    = qs('#mlo-date').value || today();
  const note    = qs('#mlo-note').value.trim();
  const next    = qs('#mlo-nextsteps').value.trim();
  const nextDate = qs('#mlo-nextdate').value;
  const contact = qs('#mlo-contact')?.value?.trim() || '';
  const outcome = qs('#mlo-outcome')?.value || '';
  const regarding = qs('#mlo-regarding-btns')?.querySelector('.ac-brand-btn.active')?.dataset?.val || 'purpl';

  if (kind === 'ac') {
    const entry = {
      id: uid(),
      date,
      type,
      contact,
      outcome,
      notes: note,
      nextSteps: next,
      nextFollowUp: nextDate || null,
      regarding,
    };
    DB.update('ac', id, a=>({
      ...a,
      lastContacted: date,
      outreach: [...(a.outreach||[]), entry],
      ...(nextDate ? {nextFollowUp: nextDate} : {}),
    }));
    renderAccounts();
    // Refresh outreach tab if account modal is still open
    const acc = DB.a('ac').find(x=>x.id===id);
    if (acc) renderAccountOutreach(acc);
    closeModal('modal-log-outreach');
    toast('Follow-up logged ✓');
  } else if (kind === 'dist') {
    const entry = {
      id: uid(),
      type,
      date,
      contact,
      outcome,
      note,
      nextFollowUp: nextDate || null,
    };
    DB.update('dist_profiles', id, d=>({
      ...d,
      outreach: [...(d.outreach||[]), entry],
      lastContacted: date,
      ...(nextDate ? {nextFollowup: nextDate} : {}),
    }));
    renderDistributors();
    // Refresh outreach tab if dist modal is open
    if (_currentDistId === id) {
      const dist = DB.a('dist_profiles').find(x=>x.id===id);
      if (dist) {
        const pane = qs('#mdist-tab-outreach');
        if (pane && pane.style.display!=='none') pane.innerHTML = renderDistOutreachHTML(dist);
      }
    }
    closeModal('modal-log-outreach');
    toast('Contact logged ✓');
  } else {
    const entry = {id:uid(), type, date, note, outcome, nextSteps:next, nextFollowUp: nextDate||null};
    DB.update('pr', id, p=>({
      ...p,
      outreach:[...(p.outreach||[]),entry],
      lastContact: date,
      ...(next ? {nextAction: next} : {}),
      ...(nextDate ? {nextDate} : {}),
    }));
    renderProspects();
    // Refresh outreach tab if prospect modal is still open
    const pr = DB.a('pr').find(x=>x.id===id);
    if (pr) renderProspectOutreach(pr);
    closeModal('modal-log-outreach');
    toast('Outreach logged');
  }
}

function deleteProspect(id) {
  markProspectLost(id);
}

// ── Prospect Import from CSV ────────────────────────────────
let _importProspectsCsvText = '';

function openImportProspects() {
  _importProspectsCsvText = '';
  if (qs('#imp-pr-paste')) qs('#imp-pr-paste').value = '';
  if (qs('#imp-pr-file-name')) qs('#imp-pr-file-name').textContent = '';
  if (qs('#imp-pr-preview')) qs('#imp-pr-preview').textContent = '';
  if (qs('#imp-pr-file-input')) qs('#imp-pr-file-input').value = '';
  const tabs = qs('#imp-pr-tabs');
  if (tabs && !tabs.dataset.wired) {
    tabs.dataset.wired = '1';
    tabs.querySelectorAll('.tab').forEach(t => {
      t.onclick = () => {
        tabs.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        if (qs('#imp-pr-tab-paste')) qs('#imp-pr-tab-paste').style.display = t.dataset.tab === 'paste' ? '' : 'none';
        if (qs('#imp-pr-tab-file')) qs('#imp-pr-tab-file').style.display = t.dataset.tab === 'file' ? '' : 'none';
      };
    });
  }
  openModal('modal-import-prospects');
}

function _parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];
  function parseRow(line) {
    const cols = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cols.push(cur.trim());
    return cols;
  }
  const headers = parseRow(lines[0]).map(h => h.toLowerCase().replace(/[^a-z ]/g, '').trim());
  return lines.slice(1).map(line => {
    const vals = parseRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
    return obj;
  });
}

function _csvMapProspect(row) {
  const get = (...keys) => { for (const k of keys) { if (row[k] !== undefined && row[k] !== '') return row[k]; } return ''; };
  const name = get('business name', 'name', 'company', 'business');
  if (!name) return null;
  const stageRaw = get('stage', 'status').toLowerCase();
  const stageMap = { cold:'lead', lead:'lead', new:'lead', contacted:'contacted', sampling:'sampling', negotiating:'negotiating', won:'won', lost:'lost' };
  const status = stageMap[stageRaw] || 'lead';
  const priRaw = get('priority').toLowerCase();
  const priority = ({ high:'high', medium:'medium', med:'medium', low:'low' })[priRaw] || 'medium';
  const noteText = get('notes', 'note');
  return {
    id: uid(), name,
    contact: get('contact name', 'contact', 'owner', 'contact person'),
    email:   get('email', 'email address'),
    phone:   get('phone', 'phone number', 'tel'),
    address: get('address', 'location', 'city'),
    type:    get('type', 'business type') || 'Grocery',
    status, priority,
    notes:    noteText ? [{ id: uid(), date: today(), text: noteText }] : [],
    outreach: [], lastContact: '', isPbf: false, samples: [],
  };
}

function _onImportProspectsFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (qs('#imp-pr-file-name')) qs('#imp-pr-file-name').textContent = file.name;
  const reader = new FileReader();
  reader.onload = ev => {
    _importProspectsCsvText = ev.target.result;
    const rows  = _parseCSV(_importProspectsCsvText);
    const valid = rows.map(_csvMapProspect).filter(Boolean).length;
    if (qs('#imp-pr-preview')) qs('#imp-pr-preview').textContent = `${rows.length} rows detected — ${valid} valid prospects found.`;
  };
  reader.readAsText(file);
}

function _runImportProspects() {
  const text = _importProspectsCsvText || qs('#imp-pr-paste')?.value?.trim() || '';
  if (!text) { toast('No CSV data to import'); return; }
  const rows = _parseCSV(text);
  const prospects = rows.map(_csvMapProspect).filter(Boolean);
  const skipped   = rows.length - prospects.length;
  if (!prospects.length) { toast('No valid rows — ensure a "Business Name" column is present'); return; }
  DB.atomicUpdate(cache => { cache['pr'] = [...(cache['pr'] || []), ...prospects]; });
  closeModal('modal-import-prospects');
  renderProspects();
  toast(`${prospects.length} prospect${prospects.length !== 1 ? 's' : ''} imported, ${skipped} skipped`);
}

// ── Sample Tracking ─────────────────────────────────────────
let _logSampleCtx = null;

function openLogSampleModal(type, id) {
  _logSampleCtx = { type, id };
  if (qs('#lsmp-date'))    qs('#lsmp-date').value    = today();
  if (qs('#lsmp-followup')) qs('#lsmp-followup').value = '';
  if (qs('#lsmp-flavors')) qs('#lsmp-flavors').value  = '';
  if (qs('#lsmp-notes'))   qs('#lsmp-notes').value    = '';
  openModal('modal-log-sample');
}

function saveLogSample() {
  if (!_logSampleCtx) return;
  const { type, id } = _logSampleCtx;
  const sample = {
    id: uid(),
    date:          qs('#lsmp-date')?.value     || today(),
    flavors:       qs('#lsmp-flavors')?.value?.trim() || '',
    notes:         qs('#lsmp-notes')?.value?.trim()   || '',
    followUpDate:  qs('#lsmp-followup')?.value || '',
    followUpDone:  false,
  };
  const col = type === 'pr' ? 'pr' : 'ac';
  DB.update(col, id, r => ({ ...r, samples: [...(r.samples || []), sample] }));
  closeModal('modal-log-sample');
  if (type === 'pr') renderProspects();
  else openAccount(id);
  toast('Sample logged');
}

function markSampleFollowUpDone(type, id, sampleId) {
  const col = type === 'pr' ? 'pr' : 'ac';
  DB.update(col, id, r => ({
    ...r,
    samples: (r.samples || []).map(s => s.id === sampleId ? { ...s, followUpDone: true } : s),
  }));
  if (type === 'pr') renderProspects();
  else openAccount(id);
  toast('Follow-up marked done');
}

// ── Win/Loss Tracking ────────────────────────────────────────
let _markLostId = null;

function markProspectLost(id) {
  _markLostId = id;
  const p = DB.a('pr').find(x => x.id === id);
  if (!p) return;
  if (qs('#mml-prospect-name')) qs('#mml-prospect-name').textContent = p.name;
  if (qs('#mml-reason')) qs('#mml-reason').value = 'No response';
  if (qs('#mml-notes'))  qs('#mml-notes').value  = '';
  openModal('modal-mark-lost');
}

function confirmMarkLost() {
  if (!_markLostId) return;
  const reason = qs('#mml-reason')?.value || 'Other';
  const notes  = qs('#mml-notes')?.value?.trim() || '';
  DB.update('pr', _markLostId, p => ({ ...p, status: 'lost', lostAt: today(), lostReason: reason, lostNotes: notes }));
  closeModal('modal-mark-lost');
  renderProspects();
  toast('Marked as lost');
}

function _deleteProspectPermanent() {
  if (!_markLostId) return;
  if (!confirm2('Permanently delete this prospect? This cannot be undone.')) return;
  DB.remove('pr', _markLostId);
  closeModal('modal-mark-lost');
  renderProspects();
  toast('Prospect deleted');
}

function reactivateProspect(id) {
  if (!confirm2('Reactivate this prospect?')) return;
  DB.update('pr', id, p => ({ ...p, status: 'lead', lostAt: '', lostReason: '', lostNotes: '' }));
  renderProspects();
  toast('Prospect reactivated');
}

// ══════════════════════════════════════════════════════════
//  DISTRIBUTORS  (Phase 4)
// ══════════════════════════════════════════════════════════

const DIST_STATUS = {
  in_conversation: {label:'In Conversation', cls:'blue'},
  submitted:       {label:'Submitted',       cls:'purple'},
  under_review:    {label:'Under Review',    cls:'amber'},
  active:          {label:'Active',          cls:'green'},
  inactive:        {label:'Inactive',        cls:'gray'},
  // legacy values — kept for backward compat
  negotiating:     {label:'Negotiating',     cls:'amber'},
  on_hold:         {label:'On Hold',         cls:'gray'},
};
const DIST_PIPELINE_ORDER = ['in_conversation','submitted','under_review','active','inactive'];

const DIST_PO_STATUS = {
  pending:   {label:'Pending',   cls:'amber'},
  fulfilled: {label:'Fulfilled', cls:'green'},
  partial:   {label:'Partial',   cls:'blue'},
  cancelled: {label:'Cancelled', cls:'red'},
};

const DIST_INV_STATUS = {
  unpaid:  {label:'Unpaid',  cls:'amber'},
  paid:    {label:'Paid',    cls:'green'},
  partial: {label:'Partial', cls:'blue'},
  overdue: {label:'Overdue', cls:'red'},
};

// ── Distributor List KPIs + Needs Attention (Phase 4) ────
function _renderDistListKPIs() {
  const kpiEl  = qs('#dist-list-kpis');
  const attnEl = qs('#dist-list-attention');
  if (!kpiEl && !attnEl) return;

  const all      = DB.a('dist_profiles');
  const active   = all.filter(d=>d.status==='active');
  const chains   = DB.a('dist_chains');
  const allPOs   = DB.a('dist_pos');
  const allInvs  = DB.a('dist_invoices');

  const totalDoors = active.reduce((s,d)=>{
    const dc = chains.filter(c=>c.distId===d.id).reduce((a,c)=>a+(c.doorCount||0),0);
    return s + (dc||d.doorCount||0);
  }, 0);
  const outstanding = allInvs.filter(i=>['unpaid','overdue'].includes(i.status));
  const outstandingVal = outstanding.reduce((s,i)=>s+(i.total||0),0);

  // Cases moved this month (sum dist_pos cases where dateReceived >= first of month)
  const now = new Date();
  const fom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const casesThisMonth = allPOs
    .filter(p=>p.dateReceived&&p.dateReceived>=fom&&p.status!=='cancelled')
    .reduce((s,p)=>{
      const c = (p.items||[]).reduce((a,i)=>a+(parseInt(i.cases)||parseInt(i.qty)||0),0);
      return s + (c || parseInt(p.total)||0);
    },0);

  // Overdue reorders: active distributors where today > lastOrderDate + reorderCycleDays
  const todayStr = today();
  const overdueReorders = active.filter(d=>{
    if (!d.reorderCycleDays || !d.lastOrderDate) return false;
    const nextDate = new Date(d.lastOrderDate);
    nextDate.setDate(nextDate.getDate() + parseInt(d.reorderCycleDays));
    return nextDate.toISOString().slice(0,10) < todayStr;
  }).length;

  if (kpiEl) {
    kpiEl.innerHTML = `
      <div>${kpiHtml('Active Distributors', active.length, 'purple')}</div>
      <div>${kpiHtml('Total Doors (Active)', fmt(totalDoors)||'—', 'blue')}</div>
      <div>${kpiHtml('Cases This Month', fmt(casesThisMonth)||'0', 'green')}</div>
      <div>${kpiHtml('Overdue Reorders', overdueReorders, overdueReorders>0?'red':'gray')}</div>
      <div>${kpiHtml('Outstanding Inv.', fmtC(outstandingVal), outstandingVal>0?'amber':'green')}</div>`;
  }

  if (attnEl) {
    const items = [];
    // Overdue invoices
    outstanding.filter(i=>i.dueDate&&i.dueDate<today()).forEach(i=>{
      const d = all.find(x=>x.id===i.distId);
      items.push(`<div class="attn-item" onclick="openDistributor('${i.distId}')" style="cursor:pointer">
        <div class="attn-icon">💸</div>
        <div class="attn-info">
          <div class="attn-name">${escHtml(d?.name||'Distributor')}</div>
          <div class="attn-reason">Invoice overdue: ${fmtC(i.total||0)} — due ${fmtD(i.dueDate)}</div>
        </div>
        <span class="badge red">Overdue</span>
      </div>`);
    });
    // No PO in 60+ days (active only)
    active.forEach(d=>{
      const pos = allPOs.filter(p=>p.distId===d.id).sort((a,b)=>b.dateReceived>a.dateReceived?1:-1);
      const lastDist = pos[0]?.dateReceived||null;
      if (!lastDist || daysAgo(lastDist) >= 60) {
        items.push(`<div class="attn-item" onclick="openDistributor('${d.id}')" style="cursor:pointer">
          <div class="attn-icon">📦</div>
          <div class="attn-info">
            <div class="attn-name">${escHtml(d.name)}</div>
            <div class="attn-reason">${lastDist?`No PO in ${daysAgo(lastDist)} days`:'No POs on record'}</div>
          </div>
          <span class="badge amber">No PO 60d+</span>
        </div>`);
      }
    });
    attnEl.style.display = items.length ? '' : 'none';
    const inner = attnEl.querySelector('#dist-attention-items');
    if (inner) inner.innerHTML = items.join('') || '<div class="empty">All clear</div>';
  }
}

// ── List Page ─────────────────────────────────────────────
function _distCardHTML(d) {
  const pos    = DB.a('dist_pos').filter(p=>p.distId===d.id).sort((a,b)=>b.dateReceived>a.dateReceived?1:-1);
  const invs   = DB.a('dist_invoices').filter(i=>i.distId===d.id&&['unpaid','overdue'].includes(i.status));
  const chains = DB.a('dist_chains').filter(c=>c.distId===d.id);
  const totalDoors = chains.reduce((s,c)=>s+(c.doorCount||0),0) || d.doorCount || 0;
  const pendingVal = invs.reduce((s,i)=>s+(i.total||0),0);
  const lastOrder = d.lastOrderDate || pos[0]?.dateReceived || null;

  // Cases moved this month
  const now = new Date();
  const fom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const casesThisMonth = pos
    .filter(p=>p.dateReceived&&p.dateReceived>=fom&&p.status!=='cancelled')
    .reduce((s,p)=>{
      return s + (p.items||[]).reduce((a,i)=>a+(parseInt(i.cases)||parseInt(i.qty)||0),0);
    },0);

  // Overdue reorder flag
  let isReorderOverdue = false;
  let nextOrderDate = null;
  if (d.reorderCycleDays && lastOrder) {
    const next = new Date(lastOrder);
    next.setDate(next.getDate() + parseInt(d.reorderCycleDays));
    nextOrderDate = next.toISOString().slice(0,10);
    isReorderOverdue = nextOrderDate < today();
  }

  // Brands carried badges
  const brands = d.brandsCarried || [];
  const brandBadges = [
    brands.includes('purpl')||brands.includes('both') ? '<span class="badge purple" style="font-size:10px">purpl</span>' : '',
    brands.includes('lf')||brands.includes('both')    ? '<span class="badge green"  style="font-size:10px">LF</span>'    : '',
  ].filter(Boolean).join('');

  return `<div class="ac-card">
    <div class="ac-card-hdr">
      <div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px">
          <span class="ac-card-name">${escHtml(d.name)}</span>
          ${d.platformType?`<span class="badge gray" style="font-size:10px">${escHtml(d.platformType)}</span>`:''}
          ${brandBadges}
        </div>
        <div class="ac-card-sub">${d.territory||'No territory set'}</div>
      </div>
      <div class="ac-card-badges" style="align-items:flex-start;gap:4px">
        ${statusBadge(DIST_STATUS, d.status)}
        ${isReorderOverdue?'<span class="dist-overdue-flag">⚠ Reorder Overdue</span>':''}
      </div>
    </div>
    <div class="ac-card-metrics" style="grid-template-columns:repeat(4,1fr)">
      <div><div class="ac-metric-label">Doors</div><div class="ac-metric-val">${fmt(totalDoors)||'—'}</div></div>
      <div><div class="ac-metric-label">Last Order</div><div class="ac-metric-val${lastOrder&&daysAgo(lastOrder)>60?' red':''}">${lastOrder?fmtD(lastOrder):'—'}</div></div>
      <div><div class="ac-metric-label">Next Expected</div><div class="ac-metric-val${isReorderOverdue?' red':''}">${nextOrderDate?fmtD(nextOrderDate):'—'}</div></div>
      <div><div class="ac-metric-label">Cases This Mo.</div><div class="ac-metric-val">${casesThisMonth||'0'}</div></div>
    </div>
    ${pendingVal>0?`<div class="ac-card-section"><div class="ac-card-section-label">Outstanding Invoices</div><div style="font-size:13px;color:var(--red)">${fmtC(pendingVal)}</div></div>`:''}
    ${d.nextSteps?`<div class="ac-card-section"><div class="ac-card-section-label">Next Steps</div><div style="font-size:13px">${escHtml(d.nextSteps)}</div></div>`:''}
    <div class="ac-card-actions">
      <button class="btn sm primary" onclick="openDistributor('${d.id}')">View</button>
      <button class="btn sm" onclick="logDistContact('${d.id}')">Log Contact</button>
      <button class="btn sm" onclick="addDistInvoice('${d.id}')">+ Invoice</button>
      <button class="btn sm" onclick="addDistPO('${d.id}')">+ Log PO</button>
    </div>
  </div>`;
}

function renderDistributors() {
  let list   = DB.a('dist_profiles');
  const search = qs('#dist-search')?.value?.toLowerCase().trim()||'';
  const sf   = qs('#dist-status-filter')?.value||'';

  if (search) list = list.filter(d=>
    d.name?.toLowerCase().includes(search) ||
    d.territory?.toLowerCase().includes(search));
  if (sf) list = list.filter(d=>d.status===sf);

  const cnt = qs('#dist-count');
  if (cnt) cnt.textContent = `${list.length} distributor${list.length!==1?'s':''}`;

  _renderDistListKPIs();

  const el = qs('#dist-cards');
  if (!el) return;

  if (!DB._firestoreReady) {
    el.innerHTML = _dbLoadingHTML(3);
    return;
  }

  if (!list.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">🚚</div>No distributors yet. Add your first distributor to get started.</div>`;
    return;
  }

  // Group by pipeline status
  const groups = [];
  const pipelineOrder = [...DIST_PIPELINE_ORDER];
  // Include any legacy statuses present in data
  list.forEach(d=>{ if (!pipelineOrder.includes(d.status)) pipelineOrder.push(d.status); });

  pipelineOrder.forEach(status=>{
    const group = list.filter(d=>d.status===status);
    if (!group.length) return;
    const info = DIST_STATUS[status] || {label: status, cls:'gray'};
    groups.push(`<div class="dist-pipeline-group">
      <div class="dist-pipeline-group-hdr">
        <h3>${info.label}</h3>
        <span class="dist-pipeline-count">${group.length}</span>
      </div>
      <div>${group.map(_distCardHTML).join('')}</div>
    </div>`);
  });

  // Any distributors with no status
  const noStatus = list.filter(d=>!d.status);
  if (noStatus.length) {
    groups.push(`<div class="dist-pipeline-group">
      <div class="dist-pipeline-group-hdr"><h3>No Status</h3><span class="dist-pipeline-count">${noStatus.length}</span></div>
      <div>${noStatus.map(_distCardHTML).join('')}</div>
    </div>`);
  }

  el.innerHTML = groups.join('');
}

// ── Log Contact (Phase 6 / 7) ─────────────────────────────
function logDistContact(id) {
  const d = DB.a('dist_profiles').find(x=>x.id===id);
  if (!d) return;
  qs('#mlo-title').textContent = `Log Contact — ${d.name}`;
  qs('#mlo-id').value = id;
  qs('#mlo-kind').value = 'dist';
  qs('#mlo-type').value = 'call';
  qs('#mlo-date').value = today();
  qs('#mlo-note').value = '';
  if (qs('#mlo-nextsteps')) qs('#mlo-nextsteps').value = '';
  if (qs('#mlo-contact'))   qs('#mlo-contact').value   = '';
  if (qs('#mlo-outcome'))   qs('#mlo-outcome').value   = '';
  qs('#mlo-nextdate').value = d.nextFollowup || '';
  // Show all fields for distributors
  const contactRow = qs('#mlo-contact-row');
  const outcomeRow = qs('#mlo-outcome-row');
  if (contactRow) contactRow.style.display = '';
  if (outcomeRow) outcomeRow.style.display = '';
  qs('#mlo-nextsteps-row').style.display = 'none';
  qs('#mlo-nextdate-row').style.display  = '';
  openModal('modal-log-outreach');
}

function _switchDistTab(tab) {
  const btn = document.querySelector(`#modal-distributor .tab[data-dtab="${tab}"]`);
  if (btn) btn.click();
}

// ── Detail Modal ──────────────────────────────────────────
function openDistributor(id) {
  const d = DB.a('dist_profiles').find(x=>x.id===id);
  if (!d) return;
  _currentDistId = id;

  qs('#mdist-name').textContent = d.name;
  qs('#mdist-status-badge').innerHTML = statusBadge(DIST_STATUS, d.status);

  // Tab switching
  document.querySelectorAll('#modal-distributor .tab[data-dtab]').forEach(t=>{
    t.onclick = ()=>{
      document.querySelectorAll('#modal-distributor .tab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.dtab-pane').forEach(x=>x.style.display='none');
      t.classList.add('active');
      const pane = qs('#mdist-tab-'+t.dataset.dtab);
      if (pane) pane.style.display='block';
      renderDistTab(t.dataset.dtab, id);
    };
  });

  // Footer buttons
  if (qs('#mdist-edit-btn'))    qs('#mdist-edit-btn').onclick    = ()=>{ closeModal('modal-distributor'); editDistributor(id); };
  if (qs('#mdist-po-btn'))      qs('#mdist-po-btn').onclick      = ()=>{ closeModal('modal-distributor'); addDistPO(id); };
  if (qs('#mdist-invoice-btn')) qs('#mdist-invoice-btn').onclick = ()=>{ closeModal('modal-distributor'); addDistInvoice(id); };

  // Default tab
  document.querySelectorAll('#modal-distributor .tab[data-dtab]')[0]?.click();
  openModal('modal-distributor');
}

function renderDistTab(tab, distId) {
  const d = DB.a('dist_profiles').find(x=>x.id===distId);
  const pane = qs('#mdist-tab-'+tab);
  if (!d || !pane) return;
  switch(tab) {
    case 'overview':  pane.innerHTML = renderDistOverviewHTML(d); break;
    case 'reps':      pane.innerHTML = renderDistRepsHTML(d); break;
    case 'pricing':   pane.innerHTML = renderDistPricingHTML(d); break;
    case 'orders':    pane.innerHTML = renderDistOrdersHTML(d); break;
    case 'invoices':  pane.innerHTML = renderDistInvoicesHTML(d); break;
    case 'stores':    pane.innerHTML = renderDistStoresHTML(d); break;
    case 'imports':   pane.innerHTML = renderDistImportsHTML(d); break;
    case 'outreach':  pane.innerHTML = renderDistOutreachHTML(d); break;
    case 'accounts':  pane.innerHTML = renderDistAccountsHTML(d); break;
    case 'velocity':  pane.innerHTML = renderDistVelocityHTML(d); break;
  }
}

function renderDistOverviewHTML(d) {
  const terms = d.paymentTerms==='custom' ? `Custom (${d.paymentTermsDays||'?'} days)` : d.paymentTerms||'Net 30';
  const linkedAccounts = DB.a('ac').filter(a=>a.fulfilledBy===d.id);
  const linkedCount = linkedAccounts.length;
  const distInvs = DB.a('dist_invoices').filter(i=>i.distId===d.id&&['unpaid','overdue'].includes(i.status));
  const outstandingInvVal = distInvs.reduce((s,i)=>s+(i.total||0),0);
  const recentPO = DB.a('dist_pos').filter(p=>p.distId===d.id).sort((a,b)=>b.dateReceived>a.dateReceived?1:-1)[0];
  const outreach = (d.outreach||[]).slice().sort((a,b)=>b.date>a.date?1:-1);
  const lastContact = outreach[0]?.date || d.lastContacted || null;
  const staleAccounts = linkedAccounts.filter(a=>daysAgo(a.lastOrder)>=30);

  // Brands carried
  const brands = d.brandsCarried||[];
  const brandsStr = brands.length ? brands.join(', ') : '—';

  // Pricing model
  const pricingModel = d.pricing?.model || 'standard';

  // Reorder cycle / next expected
  const lastOrder = d.lastOrderDate || recentPO?.dateReceived || null;
  let nextOrderDate = null;
  if (d.reorderCycleDays && lastOrder) {
    const next = new Date(lastOrder);
    next.setDate(next.getDate() + parseInt(d.reorderCycleDays));
    nextOrderDate = next.toISOString().slice(0,10);
  }
  const isOverdue = nextOrderDate && nextOrderDate < today();

  // Contacts
  const contacts = d.contacts||[];

  return `
  <div class="card-grid grid-2" style="margin-bottom:14px">
    <div><span style="font-size:11px;color:var(--muted)">Platform Type</span><div>${escHtml(d.platformType||'—')}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Payment Terms</span><div>${escHtml(terms)}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Contract Start</span><div>${d.contractStart?fmtD(d.contractStart):'—'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Brands Carried</span><div>${escHtml(brandsStr)}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Doors (Current / Target)</span><div><strong>${fmt(d.doorCount||0)}</strong>${d.targetDoorCount?` / ${fmt(d.targetDoorCount)} target`:''}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Reorder Cycle</span><div>${d.reorderCycleDays?`${d.reorderCycleDays} days`:'—'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Last Order</span><div>${lastOrder?fmtD(lastOrder):'—'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Next Expected</span><div class="${isOverdue?'red':''}">${nextOrderDate?`${fmtD(nextOrderDate)}${isOverdue?' ⚠ Overdue':''}` :'—'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">DC Address</span><div>${escHtml(d.dcAddress||'—')}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Pricing Model</span><div>${pricingModel==='custom'?'Custom rates':'Standard'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Linked Accounts</span><div><strong style="cursor:pointer;color:var(--lavblue)" onclick="_switchDistTab('accounts')">${linkedCount}</strong></div></div>
    <div><span style="font-size:11px;color:var(--muted)">Outstanding Inv.</span><div>${distInvs.length>0?`<span style="color:var(--red);font-weight:600">${fmtC(outstandingInvVal)}</span>`:'<span style="color:var(--green)">Clear</span>'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Last Contacted</span><div>${lastContact?`${fmtD(lastContact)} (${daysAgo(lastContact)}d ago)`:'—'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Linked Accounts</span><div><strong style="cursor:pointer;color:var(--lavblue)" onclick="_switchDistTab('accounts')">${linkedCount}</strong></div></div>
  </div>
  ${staleAccounts.length>0?`<div style="background:#fef3c7;border:1px solid #d97706;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px">⚠ ${staleAccounts.length} linked account${staleAccounts.length!==1?'s have':' has'} not ordered in 30+ days: ${staleAccounts.map(a=>`<strong>${escHtml(a.name)}</strong>`).join(', ')}</div>`:''}
  <div style="margin-bottom:12px"><span style="font-size:11px;color:var(--muted)">Territory</span><div style="margin-top:4px">${escHtml(d.territory||'—')}</div></div>
  ${d.nextSteps?`<div class="highlight-box" style="margin-bottom:12px"><div class="ac-card-section-label">Next Steps</div><div style="font-size:13px;margin-top:4px">${escHtml(d.nextSteps)}</div></div>`:''}
  ${d.notes?`<div class="highlight-box" style="margin-bottom:12px"><div class="ac-card-section-label">Internal Notes</div><div style="font-size:13px;margin-top:4px">${escHtml(d.notes)}</div></div>`:''}
  <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
    <span style="font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Contacts</span>
    <button class="btn xs" onclick="_openDistContactForm('${d.id}',null)">+ Add Contact</button>
  </div>
  ${contacts.length ? contacts.map((c,i)=>`
    <div class="attn-item" style="margin-bottom:6px">
      <div class="attn-info" style="flex:1">
        <div class="attn-name">${escHtml(c.name||'—')} ${c.role?`<span style="font-size:11px;color:var(--muted);font-weight:400">· ${escHtml(c.role)}</span>`:''}</div>
        <div class="attn-reason">${c.email?`✉ ${escHtml(c.email)}`:''} ${c.phone?`📞 ${escHtml(c.phone)}`:''}</div>
      </div>
      <button class="btn xs" onclick="_openDistContactForm('${d.id}',${i})">Edit</button>
    </div>`).join('') : '<div class="empty" style="padding:10px 0;font-size:13px">No contacts added yet</div>'}`;
}

function _openDistContactForm(distId, idx) {
  const d = DB.a('dist_profiles').find(x=>x.id===distId);
  if (!d) return;
  const contacts = d.contacts||[];
  const c = idx !== null ? (contacts[idx]||{}) : {};
  const nameVal   = escHtml(c.name||'');
  const roleVal   = escHtml(c.role||'');
  const emailVal  = escHtml(c.email||'');
  const phoneVal  = escHtml(c.phone||'');
  const idxAttr   = idx !== null ? idx : -1;
  // Show a simple inline prompt via a tiny overlay injected into body
  const html = `<div id="dist-contact-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9999;display:flex;align-items:center;justify-content:center">
    <div style="background:#fff;border-radius:12px;padding:24px;width:400px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,.18)">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <strong style="font-size:15px">${idx!==null?'Edit':'Add'} Contact</strong>
        <button class="btn sm" onclick="document.getElementById('dist-contact-overlay').remove()">✕</button>
      </div>
      <div class="form-row col2" style="margin-bottom:10px">
        <div class="form-group"><label>Name *</label><input id="dct-name" value="${nameVal}"></div>
        <div class="form-group"><label>Role</label><input id="dct-role" value="${roleVal}" placeholder="Buyer, AP, etc."></div>
      </div>
      <div class="form-row col2" style="margin-bottom:16px">
        <div class="form-group"><label>Email</label><input id="dct-email" type="email" value="${emailVal}"></div>
        <div class="form-group"><label>Phone</label><input id="dct-phone" type="tel" value="${phoneVal}"></div>
      </div>
      <div style="display:flex;justify-content:space-between">
        ${idx!==null?`<button class="btn red" onclick="_deleteDistContact('${distId}',${idxAttr})">Delete</button>`:'<span></span>'}
        <div style="display:flex;gap:8px">
          <button class="btn" onclick="document.getElementById('dist-contact-overlay').remove()">Cancel</button>
          <button class="btn primary" onclick="_saveDistContact('${distId}',${idxAttr})">Save</button>
        </div>
      </div>
    </div>
  </div>`;
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el.firstElementChild);
}

function _saveDistContact(distId, idx) {
  const name = qs('#dct-name')?.value?.trim();
  if (!name) { toast('Contact name required'); return; }
  const c = {
    name,
    role:  qs('#dct-role')?.value?.trim()||'',
    email: qs('#dct-email')?.value?.trim()||'',
    phone: qs('#dct-phone')?.value?.trim()||'',
  };
  DB.update('dist_profiles', distId, d=>{
    const contacts = [...(d.contacts||[])];
    if (idx < 0) contacts.push(c);
    else contacts[idx] = c;
    return {...d, contacts};
  });
  qs('#dist-contact-overlay')?.remove();
  if (_currentDistId) { renderDistTab('overview', _currentDistId); }
}

function _deleteDistContact(distId, idx) {
  if (!confirm2('Remove this contact?')) return;
  DB.update('dist_profiles', distId, d=>{
    const contacts = (d.contacts||[]).filter((_,i)=>i!==idx);
    return {...d, contacts};
  });
  qs('#dist-contact-overlay')?.remove();
  if (_currentDistId) { renderDistTab('overview', _currentDistId); }
}

function renderDistVelocityHTML(d) {
  const reports = (d.velocityReports||[]).slice().sort((a,b)=>b.date.localeCompare(a.date));

  // Summary: cases and doors this month vs last month
  const now = new Date();
  const fom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const lom = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const fomLast = `${lom.getFullYear()}-${String(lom.getMonth()+1).padStart(2,'0')}-01`;
  const fomNext = fom; // current month start is previous month's cutoff

  const thisMonthReps = reports.filter(r=>r.date>=fom);
  const lastMonthReps = reports.filter(r=>r.date>=fomLast&&r.date<fomNext);
  const casesTM = thisMonthReps.reduce((s,r)=>s+(r.cases||0),0);
  const casesLM = lastMonthReps.reduce((s,r)=>s+(r.cases||0),0);
  const doorsTM = thisMonthReps.reduce((s,r)=>s+Math.max(s, r.doors||0),0);
  const totalCases = reports.reduce((s,r)=>s+(r.cases||0),0);

  const skuOpts = SKUS.map(s=>`<option value="${s.id}">${s.label}</option>`).join('');

  const trend = casesLM>0 ? ((casesTM-casesLM)/casesLM*100).toFixed(0) : null;
  const trendHtml = trend!==null
    ? `<span class="badge ${+trend>=0?'green':'red'}" style="font-size:11px">${+trend>=0?'▲':'▼'} ${Math.abs(+trend)}% vs last mo</span>`
    : '';

  const histRows = reports.length ? reports.map(r=>`
    <tr>
      <td>${fmtD(r.date)}</td>
      <td>${r.sku ? (SKUS.find(s=>s.id===r.sku)?.label||r.sku) : '<span style="color:var(--muted)">—</span>'}</td>
      <td style="text-align:right">${r.doors||0}</td>
      <td style="text-align:right">${r.cases||0}</td>
      <td style="text-align:right">${r.units||0}</td>
      <td style="color:var(--muted);font-size:12px">${escHtml(r.notes||'')}</td>
      <td><button class="btn xs red" onclick="deleteDistVelocityEntry('${d.id}','${r.id}')">✕</button></td>
    </tr>`).join('') :
    `<tr><td colspan="7" class="empty" style="padding:16px">No velocity data yet — add an entry below</td></tr>`;

  return `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px">
      <div class="kpi purple"><div class="num">${fmt(casesTM)}</div><div class="label">Cases This Month ${trendHtml}</div></div>
      <div class="kpi green"><div class="num">${fmt(totalCases)}</div><div class="label">Total Cases Logged</div></div>
      <div class="kpi"><div class="num">${reports.length}</div><div class="label">Velocity Reports</div></div>
    </div>

    <div style="overflow-x:auto;margin-bottom:20px">
      <table class="data-table" style="width:100%;font-size:13px">
        <thead><tr>
          <th>Date</th><th>SKU</th>
          <th style="text-align:right">Doors</th>
          <th style="text-align:right">Cases</th>
          <th style="text-align:right">Units</th>
          <th>Notes</th><th></th>
        </tr></thead>
        <tbody id="vel-hist-${d.id}">${histRows}</tbody>
      </table>
    </div>

    <details style="margin-bottom:12px">
      <summary style="font-weight:600;font-size:14px;cursor:pointer;padding:8px 0">+ Add Velocity Entry</summary>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-top:10px;align-items:end" id="vel-form-${d.id}">
        <div>
          <label style="font-size:12px;color:var(--muted)">Date</label>
          <input type="date" id="vel-date-${d.id}" class="form-inp" value="${today()}" style="width:100%">
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted)">SKU (optional)</label>
          <select id="vel-sku-${d.id}" class="form-inp" style="width:100%"><option value="">All SKUs</option>${skuOpts}</select>
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted)">Active Doors</label>
          <input type="number" id="vel-doors-${d.id}" class="form-inp" min="0" placeholder="0" style="width:100%">
        </div>
        <div>
          <label style="font-size:12px;color:var(--muted)">Cases Sold</label>
          <input type="number" id="vel-cases-${d.id}" class="form-inp" min="0" placeholder="0" style="width:100%">
        </div>
        <div style="grid-column:1/3">
          <label style="font-size:12px;color:var(--muted)">Units Sold (cans)</label>
          <input type="number" id="vel-units-${d.id}" class="form-inp" min="0" placeholder="0" style="width:100%">
        </div>
        <div style="grid-column:3/5">
          <label style="font-size:12px;color:var(--muted)">Notes</label>
          <input type="text" id="vel-notes-${d.id}" class="form-inp" placeholder="Optional notes" style="width:100%">
        </div>
        <div style="grid-column:1/5;display:flex;gap:8px;margin-top:4px">
          <button class="btn sm primary" onclick="saveDistVelocityEntry('${d.id}')">Save Entry</button>
          <label class="btn sm" style="cursor:pointer">
            📥 Import CSV
            <input type="file" accept=".csv" style="display:none" onchange="_parseDistVelocityCSV('${d.id}',this)">
          </label>
          <span style="font-size:11px;color:var(--muted);align-self:center">CSV: date,sku,doors,cases,units,notes</span>
        </div>
      </div>
    </details>`;
}

function saveDistVelocityEntry(distId) {
  const date  = qs(`#vel-date-${distId}`)?.value;
  const sku   = qs(`#vel-sku-${distId}`)?.value||'';
  const doors = parseInt(qs(`#vel-doors-${distId}`)?.value)||0;
  const cases = parseInt(qs(`#vel-cases-${distId}`)?.value)||0;
  const units = parseInt(qs(`#vel-units-${distId}`)?.value)||0;
  const notes = qs(`#vel-notes-${distId}`)?.value?.trim()||'';
  if (!date) { toast('Date is required'); return; }
  if (!cases && !units) { toast('Enter cases or units'); return; }
  const entry = { id: uid(), date, sku, doors, cases, units, notes };
  DB.update('dist_profiles', distId, d=>({ ...d, velocityReports: [...(d.velocityReports||[]), entry] }));
  // Reset form fields
  if (qs(`#vel-doors-${distId}`)) qs(`#vel-doors-${distId}`).value='';
  if (qs(`#vel-cases-${distId}`)) qs(`#vel-cases-${distId}`).value='';
  if (qs(`#vel-units-${distId}`)) qs(`#vel-units-${distId}`).value='';
  if (qs(`#vel-notes-${distId}`)) qs(`#vel-notes-${distId}`).value='';
  if (_currentDistId===distId) renderDistTab('velocity', distId);
  toast('Velocity entry saved');
}

function deleteDistVelocityEntry(distId, entryId) {
  if (!confirm2('Remove this velocity entry?')) return;
  DB.update('dist_profiles', distId, d=>({
    ...d, velocityReports: (d.velocityReports||[]).filter(r=>r.id!==entryId)
  }));
  if (_currentDistId===distId) renderDistTab('velocity', distId);
}

function _parseDistVelocityCSV(distId, inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const lines = e.target.result.split(/\r?\n/).filter(l=>l.trim());
    // Skip header row if first cell is not a date
    const start = /^\d{4}-\d{2}/.test(lines[0]) ? 0 : 1;
    const entries = [];
    for (let i=start; i<lines.length; i++) {
      const cols = lines[i].split(',');
      const date = (cols[0]||'').trim();
      if (!date || !/^\d{4}-\d{2}/.test(date)) continue;
      entries.push({
        id: uid(),
        date,
        sku:   (cols[1]||'').trim(),
        doors: parseInt(cols[2])||0,
        cases: parseInt(cols[3])||0,
        units: parseInt(cols[4])||0,
        notes: (cols[5]||'').trim(),
      });
    }
    if (!entries.length) { toast('No valid rows found in CSV'); return; }
    DB.update('dist_profiles', distId, d=>({
      ...d, velocityReports: [...(d.velocityReports||[]), ...entries]
    }));
    inputEl.value = '';
    if (_currentDistId===distId) renderDistTab('velocity', distId);
    toast(`${entries.length} velocity entries imported`);
  };
  reader.readAsText(file);
}

function renderDistRepsHTML(d) {
  const reps = DB.a('dist_reps').filter(r=>r.distId===d.id);
  const rows = reps.map(r=>`
    <div class="attn-item" style="flex-wrap:wrap;gap:8px">
      <div class="attn-info" style="flex:1;min-width:180px">
        <div class="attn-name">${escHtml(r.name)}</div>
        <div class="attn-reason">${[r.title, r.territory].filter(Boolean).map(escHtml).join(' · ')}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:3px">
          ${r.phone?`📞 ${r.phone} &nbsp;`:''}
          ${r.email?`✉ ${r.email}`:''}
        </div>
        ${r.lastContacted?`<div style="font-size:11px;color:var(--muted);margin-top:2px">Last contacted: ${fmtD(r.lastContacted)}</div>`:''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        ${r.email?`<a href="mailto:${r.email}?subject=purpl%20Beverages" class="btn xs">✉ Gmail</a>`:''}
        <button class="btn xs" onclick="editDistRep('${r.id}','${d.id}')">Edit</button>
      </div>
    </div>`).join('');
  return `
    <div style="margin-bottom:12px;display:flex;justify-content:flex-end">
      <button class="btn sm primary" onclick="addDistRep('${d.id}')">+ Add Rep</button>
    </div>
    ${rows || '<div class="empty">No sales reps added yet</div>'}`;
}

function renderDistPricingHTML(d) {
  const costs  = DB.obj('costs',{cogs:{}});
  const rows = SKUS.map(s=>{
    const p = DB.a('dist_pricing').find(x=>x.distId===d.id&&x.sku===s.id);
    const pricePerCase = p?.pricePerCase || null;
    const pricePerCan  = pricePerCase ? pricePerCase/CANS_PER_CASE : null;
    const costPerCan   = costs.cogs?.[s.id] || 0;
    const gpPerCan     = pricePerCan ? pricePerCan - costPerCan : null;
    const marginPct    = pricePerCan && pricePerCan>0 ? gpPerCan/pricePerCan : null;
    const statusCls    = pricePerCase ? '' : 'amber';
    const statusLabel  = pricePerCase ? '' : '<span class="badge amber">Pending</span>';
    return `<tr>
      <td>${skuBadge(s.id)}</td>
      <td><input type="number" class="dist-price-input" data-sku="${s.id}" data-dist="${d.id}"
           value="${pricePerCase||''}" placeholder="—" step="0.01" min="0" style="width:90px">
          <small style="color:var(--muted);font-size:10px">/case</small>
      </td>
      <td>${pricePerCan?fmtC(pricePerCan):'—'}</td>
      <td>${costPerCan?fmtC(costPerCan):'—'}</td>
      <td>${gpPerCan!=null?`<span style="color:${gpPerCan>=0?'var(--green)':'var(--red)'}">${fmtC(gpPerCan)}</span>`:'—'}</td>
      <td>${marginPct!=null?`<span class="badge ${marginPct>=.4?'green':marginPct>=.2?'amber':'red'}">${fmt(marginPct*100,1)}%</span>`:'—'}</td>
      <td>${statusLabel}</td>
    </tr>`;
  }).join('');

  return `
    <div class="highlight-box" style="margin-bottom:14px">
      <div style="font-size:13px">Set the price per case (12-pack) you charge this distributor for each SKU. Margins calculated against your COGS from Settings.</div>
    </div>
    <div class="tbl-wrap" style="margin-bottom:14px">
      <table>
        <thead><tr><th>SKU</th><th>Price/Case</th><th>Price/Can</th><th>My Cost/Can</th><th>Margin/Can</th><th>Margin %</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <button class="btn primary" onclick="saveDistPricing('${d.id}')">Save Pricing</button>
    <small style="color:var(--muted);font-size:12px;margin-left:10px">Changes apply immediately and are saved to your account</small>`;
}

function renderDistOrdersHTML(d) {
  const pos = DB.a('dist_pos').filter(p=>p.distId===d.id).sort((a,b)=>b.dateReceived>a.dateReceived?1:-1);
  const rows = pos.map(p=>{
    const totalCases = (p.items||[]).reduce((s,i)=>s+i.cases,0);
    return `<tr>
      <td>${p.poNumber||'—'}</td>
      <td>${fmtD(p.dateReceived)}</td>
      <td>${p.expectedShipDate?fmtD(p.expectedShipDate):'—'}</td>
      <td>${(p.items||[]).map(i=>`${skuBadge(i.sku)} ×${i.cases}`).join(' ')}</td>
      <td>${fmt(totalCases)} cases</td>
      <td>${p.totalValue?fmtC(p.totalValue):'—'}</td>
      <td>${statusBadge(DIST_PO_STATUS,p.status)}</td>
      <td>
        <button class="btn xs" onclick="cycleDistPOStatus('${p.id}','${d.id}')">→ Next</button>
        <button class="btn xs red" onclick="deleteDistPO('${p.id}','${d.id}')">✕</button>
      </td>
    </tr>`;
  }).join('');

  return `
    <div style="margin-bottom:12px;display:flex;gap:8px;justify-content:flex-end">
      <button class="btn sm primary" onclick="openDistShipmentModal('${d.id}')">🚚 Log Shipment</button>
      <button class="btn sm" onclick="addDistPOInModal('${d.id}')">+ Log PO</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>PO #</th><th>Received</th><th>Ship Date</th><th>Items</th><th>Cases</th><th>Value</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows||'<tr><td colspan="8" class="empty">No purchase orders yet</td></tr>'}</tbody>
      </table>
    </div>`;
}

function renderDistInvoicesHTML(d) {
  const invs = DB.a('dist_invoices').filter(i=>i.distId===d.id).sort((a,b)=>b.dateIssued>a.dateIssued?1:-1);
  const totalOutstanding = invs.filter(i=>['unpaid','overdue'].includes(i.status)).reduce((s,i)=>s+(i.total||0),0);

  const rows = invs.map(inv=>`<tr>
    <td>${inv.invoiceNumber||'—'}</td>
    <td>${fmtD(inv.dateIssued)}</td>
    <td>${inv.dueDate?fmtD(inv.dueDate):'—'}</td>
    <td>${fmtC(inv.total||0)}</td>
    <td>${statusBadge(DIST_INV_STATUS,inv.status)}</td>
    <td>${inv.externalRef?`<small style="color:var(--lavblue)">${inv.externalRef}</small>`:'—'}</td>
    <td>
      ${inv.status!=='paid'?`<button class="btn xs green" onclick="markDistInvoicePaid('${inv.id}','${d.id}')">Mark Paid</button>`:''}
      <button class="btn xs red" onclick="deleteDistInvoice('${inv.id}','${d.id}')">✕</button>
    </td>
  </tr>`).join('');

  return `
    <div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
      ${totalOutstanding>0?`<span style="font-size:13px;color:var(--red);font-weight:600">Outstanding: ${fmtC(totalOutstanding)}</span>`:'<span style="color:var(--green);font-size:13px">✓ No outstanding invoices</span>'}
      <button class="btn sm primary" onclick="addDistInvoiceInModal('${d.id}')">+ Add Invoice</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Invoice #</th><th>Issued</th><th>Due</th><th>Amount</th><th>Status</th><th>Ref</th><th></th></tr></thead>
        <tbody>${rows||'<tr><td colspan="7" class="empty">No invoices yet</td></tr>'}</tbody>
      </table>
    </div>`;
}

function renderDistStoresHTML(d) {
  const chains = DB.a('dist_chains').filter(c=>c.distId===d.id);
  const totalDoors = chains.reduce((s,c)=>s+(c.doorCount||0),0);
  const rows = chains.map(c=>`
    <div class="attn-item">
      <div class="attn-info" style="flex:1">
        <div class="attn-name">${escHtml(c.chainName)}</div>
        <div class="attn-reason">${c.doorCount||0} doors &nbsp;·&nbsp; ${(c.authorizedSkus||[]).map(s=>skuBadge(s)).join(' ')}</div>
        ${c.notes?`<div style="font-size:12px;color:var(--muted)">${c.notes}</div>`:''}
      </div>
      <button class="btn xs" onclick="editDistChain('${c.id}','${d.id}')">Edit</button>
    </div>`).join('');

  return `
    <div style="margin-bottom:12px;display:flex;align-items:center;justify-content:space-between">
      <div style="font-size:13px;color:var(--muted)">Total: <strong>${fmt(totalDoors)} doors</strong> across ${chains.length} chain${chains.length!==1?'s':''}</div>
      <button class="btn sm primary" onclick="addDistChain('${d.id}')">+ Add Chain</button>
    </div>
    ${rows||'<div class="empty">No store coverage added yet</div>'}`;
}

function renderDistImportsHTML(d) {
  const imports = DB.a('dist_imports').filter(i=>i.distId===d.id);
  const byDate = {};
  imports.forEach(r=>{
    const key = r.importDate||'unknown';
    if (!byDate[key]) byDate[key] = [];
    byDate[key].push(r);
  });
  const importBatches = Object.entries(byDate).sort((a,b)=>b[0]>a[0]?1:-1);

  return `
    <div style="margin-bottom:16px">
      <div class="highlight-box">
        <strong style="font-size:13px">CSV Import — Local Line & other platforms</strong>
        <div style="font-size:13px;color:var(--muted);margin-top:4px">
          Import order data from Local Line CSV exports. Records are tagged by source and import date.
          Duplicates are detected and skipped on re-import.
        </div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn primary" onclick="openCSVImport('${d.id}')">📄 Import CSV</button>
        ${d.webhookEnabled?'<span class="badge green">🔗 Webhook Active</span>':'<span class="badge gray">Webhook: Not configured</span>'}
      </div>
    </div>
    ${importBatches.length ? importBatches.map(([date, recs])=>`
      <div class="card" style="margin-bottom:10px;padding:14px 16px">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px">
          <strong style="font-size:13px">Import: ${fmtD(date)}</strong>
          <span class="badge gray">${recs.length} records · ${recs[0]?.source||'CSV'}</span>
        </div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>Date</th><th>Buyer</th><th>SKU</th><th>Cases</th><th>Value</th></tr></thead>
            <tbody>${recs.slice(0,5).map(r=>`<tr>
              <td>${fmtD(r.orderDate)}</td><td>${r.buyerName||'—'}</td>
              <td>${skuBadge(r.sku)}</td><td>${r.cases||r.qty||'—'}</td>
              <td>${r.value?fmtC(r.value):'—'}</td></tr>`).join('')}
            ${recs.length>5?`<tr><td colspan="5" style="color:var(--muted);font-size:12px">… and ${recs.length-5} more records</td></tr>`:''}</tbody>
          </table>
        </div>
      </div>`).join('') : '<div class="empty">No imported data yet. Click "Import CSV" to get started.</div>'}`;
}

function renderDistOutreachHTML(d) {
  const outreach = (d.outreach||[]).slice().sort((a,b)=>b.date>a.date?1:-1);
  const nextFollowup = d.nextFollowup;
  const TYPE_CLS = {call:'purple', email:'blue', 'in-person':'green', text:'amber', other:'gray'};
  const rows = outreach.map(e=>{
    const nfu = e.nextFollowUp;
    const nfuHtml = nfu ? `<span style="color:${nfu<today()?'var(--red)':nfu===today()?'var(--amber)':'var(--muted)'};font-size:11px">${fmtD(nfu)}</span>` : '—';
    return `<tr>
      <td>${fmtD(e.date)}</td>
      <td><span class="badge ${TYPE_CLS[e.type]||'gray'}">${e.type||'—'}</span></td>
      <td>${e.contact||'—'}</td>
      <td>${e.outcome?`<span class="badge gray">${e.outcome}</span>`:'—'}</td>
      <td style="max-width:200px">${e.note||'—'}</td>
      <td>${nfuHtml}</td>
    </tr>`;
  }).join('');
  return `
    <div style="margin-bottom:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      ${nextFollowup?`<span class="badge ${nextFollowup<today()?'red':'blue'}">Next follow-up: ${fmtD(nextFollowup)}</span>`:''}
      <button class="btn sm primary" onclick="logDistContact('${d.id}')">📞 Log Contact</button>
    </div>
    ${outreach.length ? `<div class="tbl-wrap"><table>
      <thead><tr><th>Date</th><th>Type</th><th>Contact</th><th>Outcome</th><th>Notes</th><th>Next Follow-Up</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : '<div class="empty">No outreach logged yet.</div>'}`;
}

function renderDistAccountsHTML(d) {
  const linked = DB.a('ac').filter(a=>a.fulfilledBy===d.id);
  if (!linked.length) return `<div class="empty">No accounts are linked to this distributor yet.<br><small style="color:var(--muted)">Edit an account and set "Fulfilled By" to ${d.name} to link it here.</small></div>`;

  const todayStr = today();
  const rows = linked.map(a=>{
    const outstanding = DB.a('orders').filter(o=>o.accountId===a.id&&o.status==='delivered'&&(o.invoiceStatus||'none')!=='paid').length;
    const nfu = a.nextFollowUp;
    const nfuHtml = nfu
      ? `<span style="color:${nfu<todayStr?'var(--red)':nfu===todayStr?'var(--amber)':'var(--blue)'};">${fmtD(nfu)}</span>`
      : '—';
    return `<tr>
      <td><strong style="cursor:pointer;color:var(--lavblue)" onclick="openAccount('${a.id}')">${a.name}</strong></td>
      <td>${a.type||'—'}</td>
      <td style="font-size:12px">${a.address||'—'}</td>
      <td>${a.lastOrder?fmtD(a.lastOrder):'<span style="color:var(--red)">Never</span>'}</td>
      <td>${acLastContacted(a)?fmtD(acLastContacted(a)):'—'}</td>
      <td>${outstanding>0?`<span class="badge red">${outstanding} unpaid</span>`:'<span class="badge green">Clear</span>'}</td>
      <td>${nfuHtml}</td>
      <td>
        <button class="btn xs primary" onclick="openAccount('${a.id}')">View</button>
        <button class="btn xs" onclick="logOutreach('${a.id}')">Follow-Up</button>
      </td>
    </tr>`;
  }).join('');

  const totalOutstanding = linked.reduce((s,a)=>{
    return s + DB.a('orders').filter(o=>o.accountId===a.id&&o.status==='delivered'&&(o.invoiceStatus||'none')!=='paid').length;
  }, 0);

  return `
    <div style="margin-bottom:10px;font-size:13px;color:var(--muted)">${linked.length} account${linked.length!==1?'s':''} fulfilled via ${d.name}${totalOutstanding>0?` &nbsp;·&nbsp; <span style="color:var(--red);font-weight:600">${totalOutstanding} unpaid invoice${totalOutstanding!==1?'s':''}</span>`:''}</div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Account</th><th>Type</th><th>Address</th><th>Last Order</th><th>Last Contacted</th><th>Outstanding</th><th>Next Follow-Up</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Log Shipment to Distributor (Phase 5) ────────────────
function openDistShipmentModal(distId) {
  const d = DB.a('dist_profiles').find(x=>x.id===distId);
  if (!d) return;
  qs('#dship-dist-id').value = distId;
  qs('#dship-dist-name').textContent = d.name;
  qs('#dship-date').value = today();
  qs('#dship-po-ref').value = '';
  qs('#dship-notes').value = '';
  qs('#dship-status').value = 'fulfilled';

  // Build qty inputs using CANS_PER_CASE constant
  const qtyDiv = qs('#dship-qty-inputs');
  if (qtyDiv) {
    qtyDiv.innerHTML = SKUS.map(s=>`
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        ${skuBadge(s.id)}
        <input type="number" id="dship-qty-${s.id}" value="0" min="0" step="1" style="width:80px">
        <span style="font-size:12px;color:var(--muted)">cases (×${CANS_PER_CASE} cans)</span>
      </div>`).join('');
  }
  openModal('modal-dist-shipment');
}

function saveDistShipment() {
  const distId  = qs('#dship-dist-id').value;
  const date    = qs('#dship-date').value || today();
  const poRef   = qs('#dship-po-ref').value.trim();
  const notes   = qs('#dship-notes').value.trim();
  const status  = qs('#dship-status').value;

  const items = SKUS.map(s=>({
    sku: s.id,
    cases: parseInt(qs(`#dship-qty-${s.id}`)?.value)||0
  })).filter(i=>i.cases>0);

  if (!items.length) { toast('Add at least one SKU qty'); return; }

  const totalCases = items.reduce((s,i)=>s+i.cases, 0);
  const totalCans  = totalCases * CANS_PER_CASE;

  // Build batch write: PO record + inventory deductions + stock transfer + dist lastOrder
  const shipId = uid();
  const poId   = uid();
  const stId   = uid();

  const dist = DB.a('dist_profiles').find(x=>x.id===distId);

  // 1. Create dist PO record
  const poRec = {
    id: poId,
    distId,
    poNumber: poRef || `SHIP-${date}`,
    dateReceived: date,
    expectedShipDate: date,
    items,
    totalCases,
    totalValue: null,
    status,
    notes,
    isShipment: true,
  };
  DB.push('dist_pos', poRec);

  // 2. Deduct inventory (one inv entry per SKU)
  items.forEach(item=>{
    DB.push('iv', {
      id: uid(),
      sku: item.sku,
      type: 'out',
      qty: item.cases * CANS_PER_CASE,
      date,
      source: 'dist_shipment',
      ref: shipId,
      note: `Shipment to ${dist?.name||'distributor'}${poRef?' — '+poRef:''}`,
    });
  });

  // 3. Stock transfer record
  DB.push('stock_transfers', {
    id: stId,
    date,
    fromLocation: 'warehouse',
    toLocation: `dist:${distId}`,
    items,
    ref: poRef || poId,
    notes,
  });

  // 4. Update distributor lastOrder date
  DB.update('dist_profiles', distId, d=>({
    ...d,
    lastOrder: date,
  }));

  closeModal('modal-dist-shipment');
  // Refresh dist modal orders tab if open
  const openDistPane = qs('#mdist-tab-orders');
  if (openDistPane && openDistPane.style.display!=='none' && _currentDistId===distId) {
    openDistPane.innerHTML = renderDistOrdersHTML(DB.a('dist_profiles').find(x=>x.id===distId));
  }
  toast(`Shipment logged — ${totalCases} cases (${totalCans} cans) deducted from inventory`);
}

// ── Edit / Save Distributor ───────────────────────────────
function editDistributor(id) {
  const isNew = (id==='_new_');
  const d = isNew ? {id:uid()} : (DB.a('dist_profiles').find(x=>x.id===id)||{id:uid()});

  qs('#edist-title').textContent = isNew?'Add Distributor':'Edit Distributor';
  qs('#edist-name').value          = d.name||'';
  qs('#edist-platform').value      = d.platformType||'Local Line';
  qs('#edist-territory').value     = d.territory||'';
  qs('#edist-dc-address').value    = d.dcAddress||'';
  if (qs('#edist-territory-radius')) qs('#edist-territory-radius').value = d.territoryRadiusMiles||'';
  qs('#edist-doors').value         = d.doorCount||'';
  qs('#edist-target-doors').value  = d.targetDoorCount||'';
  qs('#edist-contract').value      = d.contractStart||'';
  qs('#edist-status').value        = d.status||'active';
  qs('#edist-terms').value         = d.paymentTerms||'Net 30';
  qs('#edist-terms-days').value    = d.paymentTermsDays||30;
  qs('#edist-reorder-days').value  = d.reorderCycleDays||'';
  qs('#edist-last-order').value    = d.lastOrderDate||'';
  qs('#edist-nextsteps').value     = d.nextSteps||'';
  qs('#edist-notes').value         = d.notes||'';

  // Brands carried checkboxes
  const brands = d.brandsCarried||[];
  const bp = qs('#edist-brands-purpl');
  const bl = qs('#edist-brands-lf');
  if (bp) bp.checked = brands.includes('purpl')||brands.includes('both');
  if (bl) bl.checked = brands.includes('lf')||brands.includes('both');

  const delBtn = qs('#edist-delete-btn');
  if (delBtn) { delBtn.style.display = isNew?'none':''; delBtn.onclick=()=>deleteDistributor(d.id); }
  qs('#edist-save-btn').onclick = ()=>saveDistributor(d.id, isNew);
  openModal('modal-edit-distributor');
  // Attach Places autocomplete to DC address field
  if (window.PlacesAC) PlacesAC.load().then(ok=>{ if (ok) PlacesAC.attach(qs('#edist-dc-address')); });
}

async function saveDistributor(id, isNew) {
  const name = qs('#edist-name')?.value?.trim();
  if (!name) { toast('Distributor name required'); return; }
  const terms = qs('#edist-terms')?.value||'Net 30';
  const existing = DB.a('dist_profiles').find(x=>x.id===id);

  // Brands carried
  const brandsPurpl = qs('#edist-brands-purpl')?.checked;
  const brandsLf    = qs('#edist-brands-lf')?.checked;
  const brandsCarried = brandsPurpl&&brandsLf ? ['both'] : brandsPurpl ? ['purpl'] : brandsLf ? ['lf'] : [];

  // Geocode DC address if changed
  const dcAddress = qs('#edist-dc-address')?.value?.trim()||'';
  let dcLat = existing?.dcLat||null, dcLng = existing?.dcLng||null;
  if (dcAddress && dcAddress !== (existing?.dcAddress||'') && window.PlacesAC) {
    const coords = await PlacesAC.getCoords(qs('#edist-dc-address')).catch(()=>null);
    if (coords) { dcLat = coords.lat; dcLng = coords.lng; }
  } else if (!dcAddress) { dcLat = null; dcLng = null; }

  const rec = {
    id, name,
    platformType:      qs('#edist-platform')?.value||'other',
    territory:         qs('#edist-territory')?.value?.trim()||'',
    dcAddress,
    dcLat, dcLng,
    territoryRadiusMiles: (v=>isNaN(v)||v<=0?0:v)(parseInt(qs('#edist-territory-radius')?.value)),
    doorCount:         (v=>isNaN(v)?0:v)(parseInt(qs('#edist-doors')?.value)),
    targetDoorCount:   (v=>isNaN(v)?0:v)(parseInt(qs('#edist-target-doors')?.value)),
    contractStart:     qs('#edist-contract')?.value||'',
    status:            qs('#edist-status')?.value||'active',
    paymentTerms:      terms,
    paymentTermsDays:  (v=>isNaN(v)?30:v)(terms==='custom'?parseInt(qs('#edist-terms-days')?.value):parseInt(terms.replace('Net ',''))),
    reorderCycleDays:  (v=>isNaN(v)||v<=0?0:v)(parseInt(qs('#edist-reorder-days')?.value)),
    lastOrderDate:     qs('#edist-last-order')?.value||'',
    brandsCarried,
    nextSteps:         qs('#edist-nextsteps')?.value?.trim()||'',
    notes:             qs('#edist-notes')?.value?.trim()||'',
    createdAt:         existing?.createdAt || today(),
    // Preserve fields not editable in this form
    outreach:          existing?.outreach || [],
    contacts:          existing?.contacts || [],
    pricing:           existing?.pricing || {model:'standard'},
    nextFollowup:      existing?.nextFollowup || '',
    lastContacted:     existing?.lastContacted || '',
    brokerFees:        existing?.brokerFees || [],
    billbacks:         existing?.billbacks || [],
    chargebacks:       existing?.chargebacks || [],
    velocityReports:   existing?.velocityReports || [],
  };
  if (isNew) DB.push('dist_profiles', rec);
  else DB.update('dist_profiles', id, ()=>rec);
  closeModal('modal-edit-distributor');
  renderDistributors();
  toast(isNew?'Distributor added':'Distributor updated');
}

function deleteDistributor(id) {
  if (!confirm2('Delete this distributor? This will also remove all associated reps, pricing, POs, and invoices.')) return;
  DB.atomicUpdate(cache => {
    cache['dist_profiles'] = (cache['dist_profiles']||[]).filter(r=>r.id!==id);
    ['dist_reps','dist_pricing','dist_pos','dist_invoices','dist_chains','dist_imports'].forEach(k=>{
      cache[k] = (cache[k]||[]).filter(r=>r.distId!==id);
    });
  });
  closeModal('modal-edit-distributor');
  renderDistributors();
  toast('Distributor deleted');
}

// ── Sales Reps ────────────────────────────────────────────
function addDistRep(distId) { _editDistRepOpen(uid(), distId, true); }

function editDistRep(repId, distId) {
  _editDistRepOpen(repId, distId, false);
}

function _editDistRepOpen(repId, distId, isNew) {
  const rep = DB.a('dist_reps').find(x=>x.id===repId) || {};
  qs('#mrep-title').textContent = isNew?'Add Sales Rep':'Edit Sales Rep';
  qs('#mrep-name').value         = rep.name||'';
  qs('#mrep-title-field').value  = rep.title||'';
  qs('#mrep-phone').value        = rep.phone||'';
  qs('#mrep-email').value        = rep.email||'';
  qs('#mrep-territory').value    = rep.territory||'';
  qs('#mrep-last-contacted').value = rep.lastContacted||'';
  qs('#mrep-notes').value        = rep.notes||'';

  const delBtn = qs('#mrep-delete-btn');
  if (delBtn) { delBtn.style.display=isNew?'none':''; delBtn.onclick=()=>deleteDistRep(repId,distId); }
  qs('#mrep-save-btn').onclick = ()=>saveDistRep(repId, distId, isNew);
  openModal('modal-add-rep');
}

function saveDistRep(repId, distId, isNew) {
  const name = qs('#mrep-name')?.value?.trim();
  if (!name) { toast('Rep name required'); return; }
  const rec = {
    id:repId, distId, name,
    title:        qs('#mrep-title-field')?.value?.trim()||'',
    phone:        qs('#mrep-phone')?.value?.trim()||'',
    email:        qs('#mrep-email')?.value?.trim()||'',
    territory:    qs('#mrep-territory')?.value?.trim()||'',
    lastContacted:qs('#mrep-last-contacted')?.value||'',
    notes:        qs('#mrep-notes')?.value?.trim()||'',
  };
  if (isNew) DB.push('dist_reps', rec);
  else DB.update('dist_reps', repId, ()=>rec);
  closeModal('modal-add-rep');
  if (_currentDistId) openDistributor(_currentDistId);
  toast(isNew?'Rep added':'Rep updated');
}

function deleteDistRep(repId, distId) {
  if (!confirm2('Remove this rep?')) return;
  DB.remove('dist_reps', repId);
  closeModal('modal-add-rep');
  if (_currentDistId) openDistributor(_currentDistId);
  toast('Rep removed');
}

// ── Pricing ───────────────────────────────────────────────
function saveDistPricing(distId) {
  const inputs = document.querySelectorAll(`.dist-price-input[data-dist="${distId}"]`);
  inputs.forEach(inp=>{
    const sku = inp.dataset.sku;
    const val = parseFloat(inp.value);
    const existing = DB.a('dist_pricing').find(x=>x.distId===distId&&x.sku===sku);
    if (val > 0) {
      const rec = {id:(existing?.id||uid()), distId, sku, pricePerCase:val, updatedAt:today()};
      if (existing) DB.update('dist_pricing', existing.id, ()=>rec);
      else DB.push('dist_pricing', rec);
    } else if (existing) {
      DB.remove('dist_pricing', existing.id);
    }
  });
  if (_currentDistId) {
    const pane = qs('#mdist-tab-pricing');
    if (pane && pane.style.display!=='none') {
      const d = DB.a('dist_profiles').find(x=>x.id===distId);
      if (d) pane.innerHTML = renderDistPricingHTML(d);
    }
  }
  toast('Pricing saved');
}

// ── Purchase Orders ───────────────────────────────────────
function addDistPO(distId) { _openDistPOModal(distId); }
function addDistPOInModal(distId) { closeModal('modal-distributor'); _openDistPOModal(distId); }

function _openDistPOModal(distId) {
  const el = qs('#mpo-sku-inputs');
  if (el) el.innerHTML = SKUS.map(s=>`
    <div class="sku-row ${s.bg}" style="margin-bottom:4px">
      ${skuBadge(s.id)}
      <input type="number" id="mpo-cases-${s.id}" min="0" step="1" placeholder="0" style="width:80px">
      <span style="font-size:12px;color:var(--muted)">cases</span>
    </div>`).join('');

  qs('#mpo-number').value    = '';
  qs('#mpo-date').value      = today();
  qs('#mpo-ship-date').value = '';
  qs('#mpo-status').value    = 'pending';
  qs('#mpo-notes').value     = '';
  qs('#mpo-save-btn').onclick = ()=>saveDistPO(distId);
  openModal('modal-add-po');
}

function saveDistPO(distId) {
  const date = qs('#mpo-date')?.value;
  if (!date) { toast('Date required'); return; }
  const items = SKUS.map(s=>({sku:s.id, cases:parseInt(qs('#mpo-cases-'+s.id)?.value)||0})).filter(i=>i.cases>0);
  if (!items.length) { toast('Enter at least one SKU quantity'); return; }

  const costs = DB.obj('costs',{cogs:{}});
  const pricing = DB.a('dist_pricing').filter(p=>p.distId===distId);
  const totalCases = items.reduce((s,i)=>s+i.cases,0);
  const totalValue = items.reduce((s,i)=>{
    const p = pricing.find(x=>x.sku===i.sku);
    return s + (p?.pricePerCase||0)*i.cases;
  },0);

  const rec = {
    id:uid(), distId,
    poNumber:       qs('#mpo-number')?.value?.trim()||'',
    dateReceived:   date,
    expectedShipDate: qs('#mpo-ship-date')?.value||'',
    items, totalCases, totalValue,
    status:  qs('#mpo-status')?.value||'pending',
    notes:   qs('#mpo-notes')?.value?.trim()||'',
  };
  DB.push('dist_pos', rec);
  closeModal('modal-add-po');
  if (_currentDistId) openDistributor(_currentDistId);
  renderDistributors();
  toast('PO logged');
}

function cycleDistPOStatus(poId, distId) {
  const seq = ['pending','fulfilled','partial','cancelled'];
  DB.update('dist_pos', poId, p=>{ const i=seq.indexOf(p.status); return {...p, status:seq[Math.min(i+1,seq.length-1)]}; });
  if (_currentDistId===distId) {
    const d = DB.a('dist_profiles').find(x=>x.id===distId);
    const pane = qs('#mdist-tab-orders');
    if (d&&pane) pane.innerHTML = renderDistOrdersHTML(d);
  }
  toast('PO status updated');
}

function deleteDistPO(poId, distId) {
  if (!confirm2('Delete this PO?')) return;
  DB.remove('dist_pos', poId);
  const d = DB.a('dist_profiles').find(x=>x.id===distId);
  const pane = qs('#mdist-tab-orders');
  if (d&&pane) pane.innerHTML = renderDistOrdersHTML(d);
  toast('PO deleted');
}

// ── Invoices ──────────────────────────────────────────────
function addDistInvoice(distId) { _openDistInvModal(distId); }
function addDistInvoiceInModal(distId) { closeModal('modal-distributor'); _openDistInvModal(distId); }

function _openDistInvModal(distId) {
  const el = qs('#mdinv-sku-inputs');
  if (el) el.innerHTML = SKUS.map(s=>`
    <div class="sku-row ${s.bg}" style="margin-bottom:4px">
      ${skuBadge(s.id)}
      <input type="number" id="mdinv-cases-${s.id}" min="0" step="1" placeholder="0" style="width:80px">
      <span style="font-size:12px;color:var(--muted)">cases</span>
    </div>`).join('');

  const now = today();
  const terms = DB.a('dist_profiles').find(x=>x.id===distId)?.paymentTermsDays||30;
  const dueDate = new Date(Date.now()+terms*864e5).toISOString().slice(0,10);

  qs('#mdinv-number').value  = '';
  qs('#mdinv-date').value    = now;
  qs('#mdinv-due').value     = dueDate;
  qs('#mdinv-po-ref').value  = '';
  qs('#mdinv-ext-ref').value = '';
  qs('#mdinv-status').value  = 'unpaid';
  qs('#mdinv-notes').value   = '';
  qs('#mdinv-save-btn').onclick = ()=>saveDistInvoice(distId);
  openModal('modal-add-dist-invoice');
}

function saveDistInvoice(distId) {
  const invNum = qs('#mdinv-number')?.value?.trim();
  const date   = qs('#mdinv-date')?.value;
  if (!invNum||!date) { toast('Invoice number and date required'); return; }

  const pricing = DB.a('dist_pricing').filter(p=>p.distId===distId);
  const items = SKUS.map(s=>({
    sku:s.id,
    cases: parseInt(qs('#mdinv-cases-'+s.id)?.value)||0,
    pricePerCase: (v=>isNaN(v)?0:v)(parseFloat(pricing.find(p=>p.sku===s.id)?.pricePerCase))
  })).filter(i=>i.cases>0);
  if (!items.length) { toast('Enter at least one SKU quantity'); return; }

  const total = items.reduce((s,i)=>s+i.cases*i.pricePerCase, 0);

  const rec = {
    id:uid(), distId,
    invoiceNumber: invNum,
    dateIssued:    date,
    dueDate:       qs('#mdinv-due')?.value||'',
    poRef:         qs('#mdinv-po-ref')?.value?.trim()||'',
    externalRef:   qs('#mdinv-ext-ref')?.value?.trim()||'',
    items, total,
    status:  qs('#mdinv-status')?.value||'unpaid',
    notes:   qs('#mdinv-notes')?.value?.trim()||'',
  };
  DB.push('dist_invoices', rec);
  closeModal('modal-add-dist-invoice');
  if (_currentDistId) openDistributor(_currentDistId);
  renderDistributors();
  toast('Invoice saved');
}

function markDistInvoicePaid(invId, distId) {
  DB.update('dist_invoices', invId, i=>({...i, status:'paid', paidDate:today()}));
  const d = DB.a('dist_profiles').find(x=>x.id===distId);
  const pane = qs('#mdist-tab-invoices');
  if (d&&pane) pane.innerHTML = renderDistInvoicesHTML(d);
  // Refresh invoice page column if open
  if (qs('#inv-col-dist')) renderInvColDist();
  toast('Marked as paid');
}

function deleteDistInvoice(invId, distId) {
  if (!confirm2('Delete this invoice?')) return;
  DB.remove('dist_invoices', invId);
  const d = DB.a('dist_profiles').find(x=>x.id===distId);
  const pane = qs('#mdist-tab-invoices');
  if (d&&pane) pane.innerHTML = renderDistInvoicesHTML(d);
  toast('Invoice deleted');
}

// ── Store / Chain Coverage ────────────────────────────────
function addDistChain(distId) { _openChainModal(uid(), distId, true); }

function editDistChain(chainId, distId) { _openChainModal(chainId, distId, false); }

function _openChainModal(chainId, distId, isNew) {
  const c = DB.a('dist_chains').find(x=>x.id===chainId)||{};
  qs('#mchain-title').textContent = isNew?'Add Store Group / Chain':'Edit Store Group';
  qs('#mchain-name').value  = c.chainName||'';
  qs('#mchain-doors').value = c.doorCount||'';
  qs('#mchain-notes').value = c.notes||'';

  qs('#mchain-skus').innerHTML = SKUS.map(s=>`
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
      <input type="checkbox" value="${s.id}" ${(c.authorizedSkus||[]).includes(s.id)?'checked':''}> ${s.label}
    </label>`).join('');

  const delBtn = qs('#mchain-delete-btn');
  if (delBtn) { delBtn.style.display=isNew?'none':''; delBtn.onclick=()=>deleteDistChain(chainId,distId); }
  qs('#mchain-save-btn').onclick = ()=>saveDistChain(chainId, distId, isNew);
  openModal('modal-add-chain');
}

function saveDistChain(chainId, distId, isNew) {
  const name = qs('#mchain-name')?.value?.trim();
  if (!name) { toast('Chain name required'); return; }
  const rec = {
    id:chainId, distId,
    chainName:    name,
    doorCount:    (v=>isNaN(v)?0:v)(parseInt(qs('#mchain-doors')?.value)),
    authorizedSkus: [...document.querySelectorAll('#mchain-skus input:checked')].map(x=>x.value),
    notes:        qs('#mchain-notes')?.value?.trim()||'',
  };
  if (isNew) DB.push('dist_chains', rec);
  else DB.update('dist_chains', chainId, ()=>rec);
  closeModal('modal-add-chain');
  if (_currentDistId) openDistributor(_currentDistId);
  toast(isNew?'Store group added':'Store group updated');
}

function deleteDistChain(chainId, distId) {
  if (!confirm2('Remove this chain?')) return;
  DB.remove('dist_chains', chainId);
  closeModal('modal-add-chain');
  if (_currentDistId) openDistributor(_currentDistId);
  toast('Chain removed');
}

// ── CSV Import (Phase 8 foundation) ──────────────────────
function openCSVImport(distId) {
  const inp = qs('#csv-file-input');
  const preview = qs('#csv-preview');
  if (preview) preview.style.display='none';
  const confirmBtn = qs('#csv-import-confirm-btn');
  if (confirmBtn) confirmBtn.style.display='none';

  if (inp) {
    inp.value = '';
    inp.onchange = ()=>handleCSVFile(inp, distId);
  }
  openModal('modal-csv-import');
}

function handleCSVFile(input, distId) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e=>{
    try {
      const rows = parseCSV(e.target.result);
      showCSVPreview(rows, distId);
    } catch(err) {
      toast('Could not parse CSV — please check the file format');
    }
  };
  reader.readAsText(file);
}

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (!lines.length) return [];
  const headers = lines[0].split(',').map(h=>h.trim().replace(/"/g,''));
  return lines.slice(1).map(line=>{
    const vals = line.split(',').map(v=>v.trim().replace(/"/g,''));
    return Object.fromEntries(headers.map((h,i)=>[h, vals[i]||'']));
  }).filter(r=>Object.values(r).some(v=>v));
}

function showCSVPreview(rows, distId) {
  const preview = qs('#csv-preview');
  const confirmBtn = qs('#csv-import-confirm-btn');
  if (!preview||!rows.length) return;

  const headers = Object.keys(rows[0]);
  preview.style.display='block';
  preview.innerHTML = `
    <div style="margin-bottom:10px">
      <strong>${rows.length} records found</strong>
      <span style="color:var(--muted);font-size:13px;margin-left:8px">Preview (first 5 rows):</span>
    </div>
    <div class="tbl-wrap" style="margin-bottom:12px">
      <table>
        <thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0,5).map(r=>`<tr>${headers.map(h=>`<td>${r[h]||'—'}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;

  if (confirmBtn) {
    confirmBtn.style.display='';
    confirmBtn.onclick = ()=>confirmCSVImport(rows, distId);
  }
}

function confirmCSVImport(rows, distId) {
  const importDate = today();
  const existing = DB.a('dist_imports').filter(i=>i.distId===distId);

  let imported=0, skipped=0;
  rows.forEach(row=>{
    // Map common column names to our fields
    const orderDate = row['Order Date']||row['Date']||row['date']||row['order_date']||'';
    const buyerName = row['Buyer']||row['Buyer Name']||row['buyer']||row['Account']||'';
    const skuRaw    = row['Product']||row['SKU']||row['Item']||row['product']||'';
    const qty       = parseFloat(row['Quantity']||row['Cases']||row['qty']||0)||0;
    const value     = parseFloat(row['Total']||row['Value']||row['Amount']||row['Revenue']||0)||0;

    // Map SKU name to our IDs
    const skuLower = skuRaw.toLowerCase();
    let sku = 'classic';
    if (skuLower.includes('blue')) sku='blueberry';
    else if (skuLower.includes('peach')) sku='peach';
    else if (skuLower.includes('rasp')) sku='raspberry';
    else if (skuLower.includes('var')) sku='variety';

    // Dedup: skip if same date+buyer+sku+qty already imported
    const dupe = existing.some(e=>e.orderDate===orderDate&&e.buyerName===buyerName&&e.sku===sku&&e.qty===qty);
    if (dupe) { skipped++; return; }

    DB.push('dist_imports', {
      id:uid(), distId, orderDate, buyerName, sku, qty, cases:qty, value,
      rawData: row, source:'CSV', importDate,
    });
    imported++;
  });

  closeModal('modal-csv-import');
  if (_currentDistId) openDistributor(_currentDistId);
  toast(`Imported ${imported} records${skipped?` (${skipped} duplicates skipped)`:''}`);
}

// ── Dashboard KPI Integration ─────────────────────────────
function renderDistDashKPIs() {
  const el = qs('#dash-dist-kpis');
  if (!el) return;

  const dists    = DB.a('dist_profiles');
  const active   = dists.filter(d=>d.status==='active');
  const chains   = DB.a('dist_chains');
  const totalDoors = active.reduce((s,d)=>{
    const dc = chains.filter(c=>c.distId===d.id).reduce((a,c)=>a+(c.doorCount||0),0);
    return s + (dc||d.doorCount||0);
  }, 0);
  const outstandingInvs = DB.a('dist_invoices').filter(i=>['unpaid','overdue'].includes(i.status));
  const outstandingVal  = outstandingInvs.reduce((s,i)=>s+(i.total||0),0);
  const allPOs = DB.a('dist_pos').sort((a,b)=>b.dateReceived>a.dateReceived?1:-1);
  const lastPO  = allPOs[0]?.dateReceived || null;

  const viaDistAcCount = DB.a('ac').filter(a=>a.fulfilledBy&&a.fulfilledBy!=='direct').length;
  el.innerHTML = `
    <div>${kpiHtml('Active Distributors', active.length, 'purple')}</div>
    <div>${kpiHtml('Total Doors', fmt(totalDoors)||'—', 'blue')}</div>
    <div>${kpiHtml('Dist. Accounts', viaDistAcCount, 'amber')}</div>
    <div>${kpiHtml('Outstanding Inv.', fmtC(outstandingVal), outstandingVal>0?'red':'green')}</div>
    <div>${kpiHtml('Last PO', lastPO?fmtD(lastPO):'None', 'gray')}</div>`;
}

// ══════════════════════════════════════════════════════════
//  INVENTORY
// ══════════════════════════════════════════════════════════
// ── Inventory Tab State ───────────────────────────────────
let _invTab = 'summary';

function renderInventory() {
  // Wire tabs once
  const tabBar = qs('#inv-tabs');
  if (tabBar && !tabBar.dataset.wired) {
    tabBar.dataset.wired = '1';
    tabBar.querySelectorAll('.tab').forEach(t=>{
      t.addEventListener('click', ()=>{
        tabBar.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
        t.classList.add('active');
        _invTab = t.dataset.invTab;
        _renderInvPane();
      });
    });
    // Populate SKU dropdowns
    ['#recv-loose-sku','#recv-pack-sku'].forEach(sel=>{
      const el = qs(sel);
      if (el) el.innerHTML = '<option value="">— Select SKU —</option>'+SKUS.map(s=>`<option value="${s.id}">${s.label}</option>`).join('');
    });
  }
  _renderInvPane();
}

function _renderInvPane() {
  // Show/hide panes
  ['summary','locations','receive','repack','pallets','supplies','log','returns'].forEach(t=>{
    const p = qs(`#inv-pane-${t}`);
    if (p) p.style.display = t===_invTab ? '' : 'none';
  });
  const handlers = {
    summary:   _invSummary,
    locations: _invLocations,
    receive:   _invReceive,
    repack:    _invRepack,
    pallets:   _invPallets,
    supplies:  _invSupplies,
    log:       _invLog,
    returns:   _invReturns,
  };
  (handlers[_invTab]||_invSummary)();
}

// ── Stock Summary ─────────────────────────────────────────
function _invSummary() {
  const iv      = DB.a('iv');
  const loose   = DB.a('loose_cans');
  const pallets = DB.a('pallets');
  const costs   = DB.obj('costs',{cogs:{}});

  // KPI cards
  const cards = qs('#inv-stock-cards');
  if (cards) {
    const totalPacks = SKUS.reduce((s,sk)=>{
      const ins  = iv.filter(i=>i.sku===sk.id&&i.type==='in').reduce((t,i)=>t+i.qty,0);
      const outs = iv.filter(i=>i.sku===sk.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
      return s + Math.max(0, ins-outs);
    },0);
    const totalLoose = SKUS.reduce((s,sk)=>s+loose.filter(l=>l.sku===sk.id).reduce((t,l)=>t+l.qty,0),0);
    const activePallets = pallets.filter(p=>p.status==='ready').length;
    const totalVal = SKUS.reduce((s,sk)=>{
      const ins  = iv.filter(i=>i.sku===sk.id&&i.type==='in').reduce((t,i)=>t+i.qty,0);
      const outs = iv.filter(i=>i.sku===sk.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
      return s+Math.max(0,ins-outs)*(costs.cogs[sk.id]||2.15);
    },0);
    cards.innerHTML = `
      <div>${kpiHtml('Finished Packs', fmt(totalPacks)+' units', 'green')}</div>
      <div>${kpiHtml('Loose Cans', fmt(totalLoose), 'purple')}</div>
      <div>${kpiHtml('Ready Pallets', activePallets, 'blue')}</div>
      <div>${kpiHtml('Stock Value (COGS)', fmtC(totalVal), 'amber')}</div>`;
  }

  const el = qs('#inv-table-body');
  if (!el) return;
  el.innerHTML = SKUS.map(s=>{
    const ins      = iv.filter(i=>i.sku===s.id&&i.type==='in').reduce((t,i)=>t+i.qty,0);
    const outs     = iv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
    const packs    = Math.max(0, ins-outs);
    const looseCt  = loose.filter(l=>l.sku===s.id).reduce((t,l)=>t+l.qty,0);
    const palletCt = pallets.filter(p=>p.status==='ready').reduce((t,p)=>t+(p.contents?.[s.id]||0),0);
    const val      = packs*(costs.cogs[s.id]||2.15);
    const status   = packs<24?{label:'Critical',cls:'red'}:packs<48?{label:'Low',cls:'amber'}:{label:'OK',cls:'green'};
    return `<tr>
      <td>${skuBadge(s.id)}</td>
      <td>${fmt(looseCt)}</td>
      <td><strong>${fmt(packs)}</strong></td>
      <td>${fmt(palletCt)}</td>
      <td>${fmtC(val)}</td>
      <td><span class="badge ${status.cls}">${status.label}</span></td>
      <td>
        <button class="btn xs primary" onclick="invAdjust('${s.id}','in')">+ Add</button>
        <button class="btn xs" onclick="invAdjust('${s.id}','out')">− Use</button>
      </td>
    </tr>`;
  }).join('');
}

// ── Receive Tab ───────────────────────────────────────────
function _invReceive() {
  const allReceipts = [
    ...DB.a('loose_cans').map(l=>({...l, form:'Loose Cans'})),
    ...DB.a('iv').filter(i=>i.type==='in').map(i=>({...i, form:'Finished Packs'})),
  ].sort((a,b)=>b.date>a.date?1:-1).slice(0,25);

  const log = qs('#inv-recv-log');
  if (log) log.innerHTML = allReceipts.map(r=>`<tr>
    <td>${fmtD(r.date)}</td>
    <td><span class="badge ${r.form==='Loose Cans'?'amber':'green'}">${r.form}</span></td>
    <td>${skuBadge(r.sku)}</td>
    <td>${fmt(r.qty)}</td>
    <td>${r.source||r.note||'—'}</td>
    <td><button class="btn xs red" onclick="delLooseCan('${r.id}','${r.form}')">✕</button></td>
  </tr>`).join('') || '<tr><td colspan="6" class="empty">No receipts yet</td></tr>';
}

function receiveLooseCans() {
  const sku = qs('#recv-loose-sku')?.value;
  const qty = parseInt(qs('#recv-loose-qty')?.value);
  if (!sku) { toast('Select a SKU'); return; }
  if (!qty||qty<=0) { toast('Enter a valid quantity'); return; }
  DB.push('loose_cans', {id:uid(), date:today(), sku, qty, source:qs('#recv-loose-source')?.value?.trim()||'', note:qs('#recv-loose-note')?.value?.trim()||''});
  qs('#recv-loose-qty').value=''; qs('#recv-loose-source').value=''; qs('#recv-loose-note').value='';
  _invReceive();
  toast('Loose cans logged');
}

function receiveFinishedPacks() {
  const sku = qs('#recv-pack-sku')?.value;
  const qty = parseInt(qs('#recv-pack-qty')?.value);
  const packType = qs('#recv-pack-type')?.value||'6pack';
  if (!sku) { toast('Select a SKU'); return; }
  if (!qty||qty<=0) { toast('Enter a valid quantity'); return; }
  DB.push('iv', {id:uid(), date:today(), sku, type:'in', qty, note:`${packType} receipt — ${qs('#recv-pack-note')?.value?.trim()||''}`});
  qs('#recv-pack-qty').value=''; qs('#recv-pack-note').value='';
  _invReceive();
  toast('Finished packs logged');
}

function delLooseCan(id, form) {
  if (!confirm2('Remove this receipt?')) return;
  if (form==='Loose Cans') DB.remove('loose_cans', id);
  else DB.remove('iv', id);
  _invReceive();
  toast('Receipt removed');
}

// ── Repack Jobs ───────────────────────────────────────────
function _invRepack() {
  const jobs = DB.a('repack_jobs').slice().sort((a,b)=>b.date>a.date?1:-1);
  const tbody = qs('#inv-repack-body');
  if (!tbody) return;
  tbody.innerHTML = jobs.map(j=>{
    const inputs = Object.entries(j.inputs||{}).map(([sku,qty])=>`${skuBadge(sku)} ×${qty}`).join(' ');
    return `<tr>
      <td>${fmtD(j.date)}</td>
      <td>${inputs||'—'}</td>
      <td>${skuBadge(j.outputSku)} ×${j.outputQty} packs</td>
      <td>${j.note||'—'}</td>
      <td><button class="btn xs red" onclick="deleteRepackJob('${j.id}')">✕</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="empty">No repack jobs yet</td></tr>';
}

function openRepackModal() {
  qs('#repack-date').value = today();
  const inputsEl = qs('#repack-inputs');
  if (inputsEl) {
    inputsEl.innerHTML = SKUS.map(s=>`
      <div class="form-row col2" style="margin-bottom:6px">
        <div>${skuBadge(s.id)}</div>
        <div><input type="number" class="input repack-input" data-sku="${s.id}" min="0" placeholder="0 cans" style="width:100%"></div>
      </div>`).join('');
  }
  const outSku = qs('#repack-out-sku');
  if (outSku) outSku.innerHTML = SKUS.map(s=>`<option value="${s.id}">${s.label}</option>`).join('');
  qs('#repack-out-qty').value='';
  qs('#repack-note').value='';
  qs('#repack-save-btn').onclick = saveRepackJob;
  openModal('modal-repack');
}

function saveRepackJob() {
  const date = qs('#repack-date')?.value || today();
  const outSku = qs('#repack-out-sku')?.value;
  const outQty = parseInt(qs('#repack-out-qty')?.value);
  if (!outSku||!outQty||outQty<=0) { toast('Output SKU and quantity required'); return; }
  const inputs = {};
  document.querySelectorAll('.repack-input').forEach(el=>{
    const q = parseInt(el.value);
    if (q>0) inputs[el.dataset.sku] = q;
  });
  const job = {id:uid(), date, inputs, outputSku:outSku, outputQty:outQty, note:qs('#repack-note')?.value?.trim()||''};
  DB.push('repack_jobs', job);
  // Deduct loose cans (best-effort)
  Object.entries(inputs).forEach(([sku,qty])=>{
    const loose = DB.a('loose_cans').filter(l=>l.sku===sku);
    let remaining = qty;
    loose.sort((a,b)=>a.date>b.date?1:-1).forEach(l=>{
      if (remaining<=0) return;
      const use = Math.min(l.qty, remaining);
      remaining -= use;
      if (use===l.qty) DB.remove('loose_cans', l.id);
      else DB.update('loose_cans', l.id, x=>({...x, qty:x.qty-use}));
    });
  });
  // Add to finished packs inventory
  DB.push('iv', {id:uid(), date, sku:outSku, type:'in', qty:outQty, note:`Repack job — ${Object.entries(inputs).map(([s,q])=>`${q} ${s}`).join(', ')}`});
  closeModal('modal-repack');
  _invRepack();
  toast('Repack job saved');
}

function deleteRepackJob(id) {
  if (!confirm2('Delete this repack job? (inventory changes are not reversed)')) return;
  DB.remove('repack_jobs', id);
  _invRepack();
  toast('Job deleted');
}

// ── Pallets ───────────────────────────────────────────────
function _invPallets() {
  const pallets = DB.a('pallets').slice().sort((a,b)=>b.created>a.created?1:-1);
  const tbody = qs('#inv-pallets-body');
  if (!tbody) return;
  tbody.innerHTML = pallets.map(p=>{
    const contents = Object.entries(p.contents||{}).map(([sku,qty])=>`${skuBadge(sku)} ×${qty}`).join(' ');
    const statusCls = p.status==='shipped'?'green':p.status==='ready'?'blue':'amber';
    return `<tr>
      <td><strong>${p.label||p.id.slice(-6)}</strong></td>
      <td>${fmtD(p.created)}</td>
      <td>${contents||'—'}</td>
      <td><span class="badge ${statusCls}">${p.status||'building'}</span></td>
      <td>${p.shipTo||'—'}</td>
      <td>${p.shipDate?fmtD(p.shipDate):'—'}</td>
      <td>
        ${p.status!=='shipped'?`<button class="btn xs primary" onclick="shipPallet('${p.id}')">Ship</button>`:''}
        <button class="btn xs" onclick="openPalletModal('${p.id}')">Edit</button>
        <button class="btn xs red" onclick="deletePallet('${p.id}')">✕</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No pallets tracked yet</td></tr>';
}

function openPalletModal(palletId) {
  const p = palletId ? DB.a('pallets').find(x=>x.id===palletId)||{} : {};
  const isNew = !palletId;
  qs('#pallet-modal-title').textContent = isNew ? 'Build Pallet' : 'Edit Pallet';
  qs('#pallet-label').value  = p.label||'';
  qs('#pallet-date').value   = p.created||today();
  qs('#pallet-ship-to').value= p.shipTo||'';
  qs('#pallet-notes').value  = p.notes||'';
  const skuInputs = qs('#pallet-sku-inputs');
  if (skuInputs) {
    skuInputs.innerHTML = SKUS.map(s=>`
      <div class="form-row col2" style="margin-bottom:6px">
        <div>${skuBadge(s.id)}</div>
        <input type="number" class="input pallet-sku-input" data-sku="${s.id}" min="0" placeholder="0 units" value="${p.contents?.[s.id]||''}" style="width:100%">
      </div>`).join('');
  }
  qs('#pallet-save-btn').onclick = ()=>savePallet(palletId||uid(), isNew);
  openModal('modal-pallet');
}

function savePallet(palletId, isNew) {
  const label = qs('#pallet-label')?.value?.trim();
  if (!label) { toast('Pallet label required'); return; }
  const contents = {};
  document.querySelectorAll('.pallet-sku-input').forEach(el=>{
    const q = parseInt(el.value);
    if (q>0) contents[el.dataset.sku] = q;
  });
  const rec = {id:palletId, label, created:qs('#pallet-date')?.value||today(), contents, status:'ready', shipTo:qs('#pallet-ship-to')?.value?.trim()||'', notes:qs('#pallet-notes')?.value?.trim()||''};
  if (isNew) DB.push('pallets', rec);
  else DB.update('pallets', palletId, ()=>rec);
  closeModal('modal-pallet');
  _invPallets();
  toast(isNew?'Pallet created':'Pallet updated');
}

function shipPallet(palletId) {
  const dest = prompt('Ship to (distributor / account):') || '';
  const shipDate = prompt('Ship date (YYYY-MM-DD):', today()) || today();
  DB.update('pallets', palletId, p=>({...p, status:'shipped', shipTo:dest||p.shipTo, shipDate}));
  // Deduct from inventory
  const p = DB.a('pallets').find(x=>x.id===palletId);
  Object.entries(p?.contents||{}).forEach(([sku,qty])=>{
    DB.push('iv', {id:uid(), date:shipDate, sku, type:'out', qty, note:`Pallet ${p.label||palletId} shipped to ${dest||p.shipTo}`});
  });
  _invPallets();
  toast('Pallet marked as shipped');
}

function deletePallet(palletId) {
  if (!confirm2('Delete this pallet record?')) return;
  DB.remove('pallets', palletId);
  _invPallets();
  toast('Pallet deleted');
}

// ── Packaging Supplies ────────────────────────────────────
function _invSupplies() {
  const supplies = DB.a('pack_supply');
  const tbody = qs('#inv-supply-body');
  if (!tbody) return;
  tbody.innerHTML = supplies.map(s=>{
    const low = s.reorderPoint && s.qty <= s.reorderPoint;
    return `<tr>
      <td><strong>${s.item}</strong></td>
      <td>${s.category||'—'}</td>
      <td ${low?'style="color:var(--red);font-weight:600"':''}>${fmt(s.qty)}</td>
      <td>${s.unit||'units'}</td>
      <td>${s.lastRestocked?fmtD(s.lastRestocked):'—'}</td>
      <td>${s.note||'—'}</td>
      <td>
        <button class="btn xs" onclick="openSupplyModal('${s.id}')">Edit</button>
        <button class="btn xs red" onclick="deleteSupply('${s.id}')">✕</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No supplies tracked — add packaging materials to monitor stock</td></tr>';
}

function openSupplyModal(supplyId) {
  const s = supplyId ? DB.a('pack_supply').find(x=>x.id===supplyId)||{} : {};
  const isNew = !supplyId;
  qs('#supply-modal-title').textContent = isNew?'Add Supply':'Edit Supply';
  qs('#supply-id').value       = supplyId||'';
  qs('#supply-item').value     = s.item||'';
  qs('#supply-qty').value      = s.qty||'';
  qs('#supply-reorder').value  = s.reorderPoint||'';
  qs('#supply-note').value     = s.note||'';
  if(qs('#supply-category')) qs('#supply-category').value = s.category||'labels';
  if(qs('#supply-unit'))     qs('#supply-unit').value     = s.unit||'units';
  qs('#supply-save-btn').onclick = ()=>saveSupply(isNew);
  openModal('modal-supply');
}

function saveSupply(isNew) {
  const item = qs('#supply-item')?.value?.trim();
  if (!item) { toast('Item name required'); return; }
  const id = qs('#supply-id')?.value||uid();
  const rec = {id, item, category:qs('#supply-category')?.value||'other', qty:parseInt(qs('#supply-qty')?.value)||0, reorderPoint:parseInt(qs('#supply-reorder')?.value)||0, unit:qs('#supply-unit')?.value||'units', lastRestocked:today(), note:qs('#supply-note')?.value?.trim()||''};
  if (isNew) DB.push('pack_supply', rec);
  else DB.update('pack_supply', id, ()=>rec);
  closeModal('modal-supply');
  _invSupplies();
  toast(isNew?'Supply added':'Supply updated');
}

function deleteSupply(id) {
  if (!confirm2('Remove this supply item?')) return;
  DB.remove('pack_supply', id);
  _invSupplies();
  toast('Supply removed');
}

// ── Log Tab ───────────────────────────────────────────────
function _invLog() {
  const inv = DB.a('iv');
  const log = inv.filter(e=>e.type==='in'||e.type==='out'||e.type==='return').sort((a,b)=>b.date>a.date?1:-1).slice(0,60);
  const tbody = qs('#inv-log-body');
  if (!tbody) return;
  tbody.innerHTML = log.map(entry=>{
    const typeBadge = entry.type==='in'
      ? '<span class="badge green">+In</span>'
      : entry.type==='return'
        ? '<span class="badge" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa">↩ Return</span>'
        : '<span class="badge red">−Out</span>';
    return `
    <tr>
      <td>${fmtD(entry.date)}</td>
      <td>${skuBadge(entry.sku)}</td>
      <td>${typeBadge}</td>
      <td>${fmt(entry.qty)}</td>
      <td>${entry.note||'—'}</td>
      <td><button class="btn xs red" onclick="delInvEntry('${entry.id}')">✕</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No log entries</td></tr>';
}

// ── Returns Tab ───────────────────────────────────────────
function _invReturns() {
  // Populate account dropdown once
  const acSel = qs('#ret-account');
  if (acSel) {
    acSel.innerHTML = '<option value="">— Select Account —</option>' +
      DB.a('ac').filter(a=>a.status==='active').sort((a,b)=>a.name>b.name?1:-1)
        .map(a=>`<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
  }
  // Populate SKU dropdown once
  const skuSel = qs('#ret-sku');
  if (skuSel && !skuSel.dataset.wired) {
    skuSel.dataset.wired = '1';
    skuSel.innerHTML = '<option value="">— Select SKU —</option>' +
      SKUS.map(s=>`<option value="${s.id}">${s.label}</option>`).join('');
  }
  if (qs('#ret-date') && !qs('#ret-date').value) qs('#ret-date').value = today();

  // Return history table
  const tbody = qs('#ret-history-body');
  if (tbody) {
    const returns = DB.a('returns').slice().sort((a,b)=>b.date>a.date?1:-1);
    tbody.innerHTML = returns.length
      ? returns.map(r=>`<tr>
          <td>${fmtD(r.date)}</td>
          <td>${escHtml(r.accountName||'—')}</td>
          <td>${r.skuId ? skuBadge(r.skuId) : '—'}</td>
          <td>${r.cans||0}</td>
          <td>${escHtml(r.reason||'—')}</td>
          <td>${r.creditIssued?`$${parseFloat(r.creditAmount||0).toFixed(2)}`:'—'}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty">No returns logged</td></tr>';
  }
}

function saveReturn() {
  const accountId = qs('#ret-account')?.value;
  const skuId     = qs('#ret-sku')?.value;
  const cans      = parseInt(qs('#ret-cans')?.value)||0;
  if (!accountId) { toast('Select an account'); return; }
  if (!skuId)     { toast('Select a SKU'); return; }
  if (cans <= 0)  { toast('Enter number of cans'); return; }

  const account     = DB.a('ac').find(a=>a.id===accountId);
  const date        = qs('#ret-date')?.value || today();
  const reason      = qs('#ret-reason')?.value || 'Other';
  const notes       = qs('#ret-notes')?.value?.trim() || '';
  const creditIssued= qs('#ret-credit-issued')?.checked || false;
  const creditAmount= creditIssued ? parseFloat(qs('#ret-credit-amount')?.value)||0 : 0;

  const ret = {
    id: uid(), date, accountId,
    accountName: account?.name || '',
    skuId, cans, reason, notes,
    creditIssued, creditAmount,
  };
  const ivEntry = {
    id: uid(), date, sku: skuId,
    type: 'return', qty: cans,
    note: `Return from ${account?.name||accountId}: ${reason}`,
  };

  DB.atomicUpdate(cache => {
    cache['returns'] = [...(cache['returns']||[]), ret];
    cache['iv']      = [...(cache['iv']||[]), ivEntry];
  });

  // Reset form
  if (qs('#ret-cans')) qs('#ret-cans').value = '';
  if (qs('#ret-notes')) qs('#ret-notes').value = '';
  if (qs('#ret-credit-issued')) qs('#ret-credit-issued').checked = false;
  if (qs('#ret-credit-amount')) qs('#ret-credit-amount').value = '';
  if (qs('#ret-credit-amount-row')) qs('#ret-credit-amount-row').style.display = 'none';

  _invReturns();
  toast('Return logged and inventory updated');
}

function toggleReturnCredit() {
  const row = qs('#ret-credit-amount-row');
  if (row) row.style.display = qs('#ret-credit-issued')?.checked ? '' : 'none';
}

function invAdjust(sku, type) {
  const skuVal = sku || prompt('SKU (classic/blueberry/peach/raspberry/variety):');
  if (!skuVal || !SKU_MAP[skuVal]) { if(skuVal) toast('Unknown SKU'); return; }
  const qty = parseInt(prompt(`Enter quantity to ${type==='in'?'receive':'use'} for ${SKU_MAP[skuVal]?.label}:`));
  if (!qty || qty <= 0) return;
  const note = prompt('Note (optional):') || '';
  DB.push('iv', {id:uid(), date:today(), sku:skuVal, type, qty, note});
  _invSummary();
  toast('Inventory updated');
}

function delInvEntry(id) {
  if (!confirm2('Remove this entry?')) return;
  DB.remove('iv', id);
  _invLog();
  toast('Entry removed');
}

// ── Stock Locations (Phase 5) ─────────────────────────────
function _invLocations() {
  // Ensure Warehouse default location exists
  const locs = DB.a('stock_locations');
  if (!locs.find(l=>l.name==='Warehouse')) {
    DB.push('stock_locations', {id:uid(), name:'Warehouse', address:'', notes:'Default', created:today()});
  }
  _renderLocationsTable();
  _populateXferSelects();
}

function _renderLocationsTable() {
  const locs = DB.a('stock_locations');
  const transfers = DB.a('stock_transfers');
  const iv = DB.a('iv');
  const el = qs('#inv-locations-table');
  if (!el) return;

  if (!locs.length) { el.innerHTML='<div class="empty">No locations yet.</div>'; return; }

  // Build stock-by-location: start from Warehouse = all iv stock
  // Transfers move qty between locations
  const stockAt = {}; // { locId: { sku: cases } }
  locs.forEach(l=>{ stockAt[l.id] = {}; SKUS.forEach(s=>{ stockAt[l.id][s.id] = 0; }); });

  // Seed warehouse with current inventory
  const warehouseLoc = locs.find(l=>l.name==='Warehouse');
  if (warehouseLoc) {
    SKUS.forEach(s=>{
      const ins  = iv.filter(i=>i.sku===s.id&&i.type==='in').reduce((t,i)=>t+i.qty,0);
      const outs = iv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
      stockAt[warehouseLoc.id][s.id] = Math.max(0, Math.floor((ins-outs)/CANS_PER_CASE));
    });
  }

  // Apply transfers
  transfers.forEach(t=>{
    if (stockAt[t.fromId]) stockAt[t.fromId][t.sku] = Math.max(0, (stockAt[t.fromId][t.sku]||0) - t.qty);
    if (stockAt[t.toId])   stockAt[t.toId][t.sku]   = (stockAt[t.toId][t.sku]||0) + t.qty;
  });

  const skuCols = SKUS.map(s=>`<th>${s.label}</th>`).join('');
  const rows = locs.map(l=>{
    const skuVals = SKUS.map(s=>`<td>${stockAt[l.id]?.[s.id]||0} cs</td>`).join('');
    const total   = SKUS.reduce((sum,s)=>sum+(stockAt[l.id]?.[s.id]||0),0);
    return `<tr>
      <td><strong>${l.name}</strong>${l.address?`<br><small style="color:var(--muted)">${l.address}</small>`:''}</td>
      ${skuVals}
      <td><strong>${total} cs</strong></td>
      ${l.name!=='Warehouse'?`<td><button class="btn xs red" onclick="deleteStockLocation('${l.id}')">✕</button></td>`:'<td></td>'}
    </tr>`;
  }).join('');

  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>Location</th>${skuCols}<th>Total</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function _populateXferSelects() {
  const locs = DB.a('stock_locations');
  const opts = locs.map(l=>`<option value="${l.id}">${l.name}</option>`).join('');
  const fromEl = qs('#xfer-from'); if (fromEl) fromEl.innerHTML = opts;
  const toEl   = qs('#xfer-to');   if (toEl)   toEl.innerHTML   = opts;
  const skuEl  = qs('#xfer-sku');
  if (skuEl) skuEl.innerHTML = SKUS.map(s=>`<option value="${s.id}">${s.label}</option>`).join('');
}

function addStockLocation() {
  const name = (qs('#loc-name')?.value||'').trim();
  if (!name) { toast('Name required'); return; }
  const address = (qs('#loc-address')?.value||'').trim();
  const notes   = (qs('#loc-notes')?.value||'').trim();
  DB.push('stock_locations', {id:uid(), name, address, notes, created:today()});
  qs('#loc-name').value = '';
  qs('#loc-address').value = '';
  qs('#loc-notes').value = '';
  _renderLocationsTable();
  _populateXferSelects();
  toast('Location added');
}

function deleteStockLocation(id) {
  if (!confirm2('Delete this location? Stock data will be lost.')) return;
  DB.remove('stock_locations', id);
  _renderLocationsTable();
  _populateXferSelects();
  toast('Location deleted');
}

function transferStock() {
  const fromId = qs('#xfer-from')?.value;
  const toId   = qs('#xfer-to')?.value;
  const sku    = qs('#xfer-sku')?.value;
  const qty    = parseInt(qs('#xfer-qty')?.value||'0');
  const note   = (qs('#xfer-note')?.value||'').trim();
  if (!fromId||!toId||!sku||!qty||qty<1) { toast('Fill all transfer fields'); return; }
  if (fromId===toId) { toast('From and To must be different'); return; }
  DB.push('stock_transfers', {id:uid(), fromId, toId, sku, qty, note, date:today()});
  qs('#xfer-qty').value = '';
  qs('#xfer-note').value = '';
  _renderLocationsTable();
  toast('Transfer logged');
}

// ══════════════════════════════════════════════════════════
//  ORDERS & DELIVERY  (Phase 4 combined page)
// ══════════════════════════════════════════════════════════

let _odCurrentTab = 'all-orders';

function renderOrdersDelivery() {
  // Wire top-level tabs
  const mainTabs = qs('#od-main-tabs');
  if (mainTabs && !mainTabs._wired) {
    mainTabs._wired = true;
    mainTabs.querySelectorAll('[data-od-tab]').forEach(btn=>{
      btn.addEventListener('click', ()=>switchODTab(btn.dataset.odTab));
    });
  }
  switchODTab(_odCurrentTab);
  // Also wire orders status filter tabs once
  const filterTabs = qs('#orders-filter');
  if (filterTabs && !filterTabs._wired) {
    filterTabs._wired = true;
    filterTabs.querySelectorAll('[data-status]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        filterTabs.querySelectorAll('[data-status]').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        ordFilter = btn.dataset.status;
        renderOrders();
      });
    });
  }
  const newOrdBtn = qs('#new-order-btn');
  if (newOrdBtn && !newOrdBtn._wired) {
    newOrdBtn._wired = true;
    newOrdBtn.addEventListener('click', ()=>openNewOrder(null));
  }
}

function switchODTab(tab) {
  _odCurrentTab = tab;
  ['all-orders','route-builder','dist-orders'].forEach(t=>{
    const el = qs(`#od-tab-${t}`);
    if (el) el.style.display = t===tab ? '' : 'none';
  });
  const mainTabs = qs('#od-main-tabs');
  if (mainTabs) {
    mainTabs.querySelectorAll('[data-od-tab]').forEach(btn=>{
      btn.classList.toggle('active', btn.dataset.odTab===tab);
    });
  }
  if (tab==='all-orders')    renderOrders();
  if (tab==='route-builder') renderDelivery();
  if (tab==='dist-orders')   renderDistOrders();
}

function renderDistOrders() {
  const el = qs('#od-dist-orders-content');
  if (!el) return;
  const pos = DB.a('dist_pos').slice().sort((a,b)=>b.dateReceived>a.dateReceived?1:-1);
  if (!pos.length) { el.innerHTML='<div class="empty">No distributor orders yet.</div>'; return; }
  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>Date</th><th>Distributor</th><th>Items</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${pos.map(po=>{
      const dist = DB.a('dist_profiles').find(d=>d.id===po.distId);
      const itemSummary = (po.items||[]).map(i=>`${i.qty}cs ${i.sku}`).join(', ');
      return `<tr>
        <td>${fmtD(po.dateReceived)}</td>
        <td>${dist?.name||po.distId||'—'}</td>
        <td>${itemSummary||'—'}</td>
        <td>${statusBadge(DIST_PO_STATUS, po.status)}</td>
        <td><button class="btn xs" onclick="openDistributor('${po.distId}')">View</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

// ══════════════════════════════════════════════════════════
//  ORDERS
// ══════════════════════════════════════════════════════════
let ordFilter = 'all';
function renderOrders() {
  let list = DB.a('orders').slice().sort((a,b)=>b.created>a.created?1:-1);
  if (ordFilter !== 'all') list = list.filter(o=>o.status===ordFilter);

  const tbody = qs('#orders-tbody');
  if (!tbody) return;
  const SOURCE_BADGE = {
    run:         '<span class="badge purple" style="font-size:10px">Run</span>',
    manual:      '<span class="badge gray"   style="font-size:10px">Manual</span>',
    import:      '<span class="badge blue"   style="font-size:10px">Import</span>',
    local_line:  '<span class="badge blue"   style="font-size:10px">Local Line</span>',
    distributor: '<span class="badge amber"  style="font-size:10px">Distributor</span>',
  };

  tbody.innerHTML = list.map(o=>{
    const ac2 = DB.a('ac').find(a=>a.id===o.accountId);
    const isOverdue = o.status==='pending' && o.dueDate < today();
    const srcBadge  = SOURCE_BADGE[o.source] || '';
    // qty in items is CASES; show with 'cs' label
    return `<tr class="${isOverdue?'overdue-row':''}">
      <td>${fmtD(o.created)}</td>
      <td>${ac2?.name||'Unknown'} ${srcBadge}</td>
      <td>${(o.items||[]).map(i=>`${skuBadge(i.sku)} ×${i.qty}cs`).join(' ')}</td>
      <td>${fmtD(o.dueDate)}${isOverdue?' <span class="badge red">Overdue</span>':''}</td>
      <td>${statusBadge(ORD_STATUS, o.status)}</td>
      <td>
        <button class="btn xs" onclick="openOrderDetail('${o.id}')">View</button>
        <button class="btn xs" onclick="cycleOrderStatus('${o.id}')">→ Next</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">No orders</td></tr>';

  qs('#orders-count').textContent = `${list.length} order${list.length!==1?'s':''}`;
}

function openNewOrder(accountId) {
  const m = document.getElementById('modal-new-order');
  if (!m) return;
  const sel = qs('#nord-account');
  if (sel) {
    // Blank first option so user must choose
    sel.innerHTML = '<option value="">— Select account —</option>' +
      DB.a('ac').filter(a=>a.status==='active').map(a=>`<option value="${a.id}" ${a.id===accountId?'selected':''}>${a.name}</option>`).join('');
    if (accountId) sel.value = accountId;
    populateOrderSkus();
  }
  // Pre-fill today's date as default
  if (qs('#nord-due')) qs('#nord-due').value = today();
  if (qs('#nord-notes')) qs('#nord-notes').value = '';
  qs('#nord-save-btn').onclick = saveNewOrder;
  openModal('modal-new-order');
}

function populateOrderSkus() {
  const sel = qs('#nord-account');
  const ac2 = sel ? DB.a('ac').find(a=>a.id===sel.value) : null;
  const skus = ac2?.skus?.length ? ac2.skus : SKUS.map(s=>s.id);
  const el = qs('#nord-items');
  if (!el) return;
  // par is stored in CANS; convert to CASES for display
  el.innerHTML = skus.map(s=>{
    const parCans  = ac2?.par?.[s] || 0;
    const parCases = parCans > 0 ? Math.ceil(parCans / CANS_PER_CASE) : null;
    return `
    <div class="order-item-row">
      ${skuBadge(s)}
      <input type="number" id="nord-qty-${s}" placeholder="0" min="0" step="1" style="width:80px">
      <span style="font-size:12px;color:var(--muted)">cases${parCases?' (par: '+parCases+'cs)':''}</span>
      ${parCases?`<button class="btn xs" onclick="qs('#nord-qty-${s}').value=${parCases}">Fill par</button>`:''}
    </div>`;
  }).join('');
  // Add footnote
  el.insertAdjacentHTML('beforeend', `<div style="font-size:11px;color:var(--muted);margin-top:8px">1 case = ${CANS_PER_CASE} cans</div>`);
}

// ── Consolidated order creation (Phase 6) ────────────────
// All order creation paths use this one function.
// items: [{sku, qty}] where qty is in CASES.
// canCount is computed automatically (qty × CANS_PER_CASE).
function createOrder({accountId, dueDate, notes='', items, source='manual', status='pending'}) {
  if (!accountId || !dueDate || !items?.length) return null;
  const canCount = items.reduce((s,i) => s + (i.qty * CANS_PER_CASE), 0);
  const ord = {
    id: uid(), accountId, dueDate, notes, items, status,
    source, // 'manual' | 'run' | 'import' | 'distributor'
    canCount, // total cans — for reference only, derived from items × CANS_PER_CASE
    created: today(),
  };
  DB.atomicUpdate(cache => {
    cache['orders'] = [...(cache['orders']||[]), ord];
    cache['ac'] = (cache['ac']||[]).map(a => a.id===accountId ? {...a, lastOrder:today()} : a);
  });
  return ord;
}

function saveNewOrder() {
  const accountId = qs('#nord-account')?.value;
  const dueDate   = qs('#nord-due')?.value || today();
  const notes     = qs('#nord-notes')?.value?.trim()||'';
  if (!accountId) { toast('Select an account'); return; }
  if (!dueDate)   { toast('Due date required'); return; }

  // qty entered in CASES
  const items = [];
  SKUS.forEach(s=>{
    const qty = parseInt(qs('#nord-qty-'+s.id)?.value)||0;
    if (qty > 0) items.push({sku:s.id, qty}); // qty = cases
  });
  if (!items.length) { toast('Add at least one SKU quantity'); return; }

  const ord = createOrder({accountId, dueDate, notes, items, source:'manual'});

  closeModal('modal-new-order');
  renderOrders();
  toast('Order created');

  // Offer to create invoice immediately
  if (ord && confirm2('Create an invoice for this order now?')) {
    setInvStatus(ord.id, 'invoiced');
    toast('Marked as invoiced');
  }
}

function openOrderDetail(id) {
  const o = DB.a('orders').find(x=>x.id===id);
  if (!o) return;
  const ac2 = DB.a('ac').find(a=>a.id===o.accountId);
  const m = document.getElementById('modal-order-detail');
  if (!m) return;
  qs('#mod-account').textContent = ac2?.name||'—';
  qs('#mod-due').textContent = fmtD(o.dueDate);
  qs('#mod-status').innerHTML = statusBadge(ORD_STATUS, o.status);
  qs('#mod-notes').textContent = o.notes||'—';
  // i.qty = cases; show with 'cs' label and can equivalent
  qs('#mod-items').innerHTML = (o.items||[]).map(i=>`<div>${skuBadge(i.sku)} × <strong>${i.qty} cs</strong> <span style="font-size:11px;color:var(--muted)">(${i.qty*CANS_PER_CASE} cans)</span></div>`).join('');
  if (o.canCount) {
    qs('#mod-items').insertAdjacentHTML('beforeend', `<div style="font-size:12px;color:var(--muted);margin-top:4px">Total: ${o.canCount} cans</div>`);
  }

  // Invoice status
  const invEl = qs('#mod-invoice-status');
  if (invEl) {
    if (o.status==='delivered') {
      const st = o.invoiceStatus||'none';
      const cfg = INVOICE_STATUS[st]||INVOICE_STATUS.none;
      invEl.innerHTML = `<span class="badge ${cfg.cls}">${cfg.label}</span>`
        + (st==='none'     ? `<button class="btn xs blue"  onclick="setInvStatus('${id}','invoiced')">Mark Invoiced</button>` : '')
        + (st==='invoiced' ? `<button class="btn xs green" onclick="setInvStatus('${id}','paid')">Mark Paid</button>` : '')
        + (o.paidDate      ? `<span style="font-size:12px;color:var(--muted)">Paid ${fmtD(o.paidDate)}</span>` : '');
    } else {
      invEl.innerHTML = `<span style="font-size:12px;color:var(--muted)">Invoice tracking available after delivery</span>`;
    }
  }

  qs('#mod-delete-btn').onclick = ()=>{
    if (!confirm2('Delete this order?')) return;
    // Remove linked inventory out-entries (from run delivery or manual delivery)
    DB.a('iv').filter(e=>e.ordId===id).forEach(e=>DB.remove('iv',e.id));
    DB.remove('orders', id);
    closeModal('modal-order-detail');
    renderOrders();
    renderInventory();
    renderDash();
    toast('Order and linked inventory entries removed');
  };
  qs('#mod-status-btn').onclick    = ()=>{ cycleOrderStatus(id); openOrderDetail(id); };
  qs('#mod-reschedule-btn').onclick = ()=>{
    const newDate = prompt('New due date (YYYY-MM-DD):', o.dueDate);
    if (!newDate || newDate===o.dueDate) return;
    DB.update('orders', id, x=>({...x, dueDate:newDate}));
    openOrderDetail(id);
    renderOrders();
    toast('Due date updated');
  };
  openModal('modal-order-detail');
}

function cycleOrderStatus(id) {
  const seq = ['pending','confirmed','in_transit','delivered'];
  const o = DB.a('orders').find(x=>x.id===id);
  if (!o) return;
  const newStatus = seq[Math.min(seq.indexOf(o.status)+1, seq.length-1)];
  DB.update('orders', id, x=>({...x, status:newStatus}));
  // If just reached 'delivered' on a non-run order, deduct stock now
  if (newStatus==='delivered' && o.status!=='delivered' && o.source!=='run') {
    (o.items||[]).forEach(item=>{
      DB.push('iv', {id:uid(), date:today(), sku:item.sku, type:'out',
        qty: item.qty * CANS_PER_CASE, note:'Order delivered', ordId:id});
    });
    renderInventory();
  }
  renderOrders();
  renderDash();
  toast('Status updated');
}

// ══════════════════════════════════════════════════════════
//  PRODUCTION
// ══════════════════════════════════════════════════════════
function renderProduction() {
  const ships = DB.a('shipments').slice().sort((a,b)=>a.date>b.date?1:-1).filter(x=>x.date>=today());
  const hist  = DB.a('prod_hist').slice().sort((a,b)=>b.date>a.date?1:-1).slice(0,15);

  // Upcoming shipments
  const el = qs('#prod-upcoming');
  if (el) {
    el.innerHTML = ships.length ? ships.map(s=>`
      <div class="order-card ${s.date===today()?'urgent':daysAgo(today())-daysAgo(s.date)<3?'due-soon':''}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:13px;font-weight:600">${s.customer||'Customer'}</div>
            <div style="font-size:12px;color:var(--muted)">${fmtD(s.date)} · ${s.type||'Shipment'}</div>
          </div>
          <button class="btn xs red" onclick="delShipment('${s.id}')">✕</button>
        </div>
        <div style="margin-top:8px">${SKUS.map(sk=>s[sk.id]>0?`${skuBadge(sk.id)} ×${s[sk.id]}`:'').filter(Boolean).join(' ')}</div>
        ${s.notes?`<div style="font-size:12px;color:var(--muted);margin-top:6px">${s.notes}</div>`:''}
      </div>`).join('') : '<div class="empty">No upcoming shipments scheduled</div>';
  }

  // Production history
  const hel = qs('#prod-history-body');
  if (hel) {
    hel.innerHTML = hist.map(h=>`
      <tr>
        <td>${fmtD(h.date)}</td>
        <td>${SKUS.map(s=>h[s.id]>0?`${skuBadge(s.id)} ×${h[s.id]}`:'').filter(Boolean).join(' ')}</td>
        <td>${h.notes||'—'}</td>
        <td><button class="btn xs red" onclick="delProdHist('${h.id}')">✕</button></td>
      </tr>`).join('') || '<tr><td colspan="4" class="empty">No production runs logged</td></tr>';
  }

  // Today's schedule (from prod_sched)
  renderTodaySchedule();
  renderProductionRecommendation();
}

// ── Production Recommendation ────────────────────────────
function renderProductionRecommendation() {
  const el = qs('#prod-recommendation');
  if (!el) return;

  // Current on-hand stock per SKU (in + return − out)
  const inv = DB.a('iv');
  const stockBySku = {};
  SKUS.forEach(s => {
    const totalIn  = inv.filter(e => e.sku===s.id && (e.type==='in'||e.type==='return')).reduce((t,e)=>t+(e.qty||0), 0);
    const totalOut = inv.filter(e => e.sku===s.id &&  e.type==='out').reduce((t,e)=>t+(e.qty||0), 0);
    stockBySku[s.id] = totalIn - totalOut;
  });
  const totalStock = Object.values(stockBySku).reduce((a,b)=>a+b, 0);

  // 30-day projected demand: scale 90-day order history to 30 days
  const cutoff = new Date(Date.now()-90*86400000).toISOString().slice(0,10);
  const recentOrds = DB.a('orders').filter(o=>o.status!=='cancelled' && o.created>=cutoff);
  const demandBySku = {};
  SKUS.forEach(s=>{ demandBySku[s.id]=0; });
  recentOrds.forEach(o=>{
    (o.items||[]).forEach(i=>{
      demandBySku[i.sku] = (demandBySku[i.sku]||0) + (i.qty||0)*CANS_PER_CASE;
    });
  });
  SKUS.forEach(s=>{ demandBySku[s.id] = Math.round(demandBySku[s.id]*(30/90)); });
  const totalDemand = Object.values(demandBySku).reduce((a,b)=>a+b, 0);

  const buffer  = Math.round(totalDemand*0.20);
  const needed  = Math.max(0, totalDemand - totalStock + buffer);
  const neededCases = Math.ceil(needed/CANS_PER_CASE);
  const stockCases  = Math.floor(totalStock/CANS_PER_CASE);

  if (needed <= 0) {
    el.innerHTML = `
      <div style="color:var(--green);font-weight:600;margin-bottom:10px">✓ Stock looks good for 30 days</div>
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;font-size:13px">
        <div>Current stock: <strong>${fmt(totalStock)} cans (${stockCases} cases)</strong></div>
        <div>30-day projected demand: <strong>${fmt(totalDemand)} cans</strong></div>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:14px;font-size:13px">
      <div>Current stock: <strong>${fmt(totalStock)} cans (${stockCases} cases)</strong></div>
      <div>30-day projected demand: <strong>${fmt(totalDemand)} cans</strong></div>
      <div>Recommended production run: <strong style="color:var(--red)">${fmt(needed)} cans (${neededCases} cases)</strong></div>
      <div>Safety buffer included: <strong>20%</strong></div>
    </div>
    <button class="btn primary sm" onclick="_scheduleRecommendedRun(${neededCases})">Schedule This Run</button>`;
}

function _scheduleRecommendedRun(totalCasesNeeded) {
  // Distribute evenly across non-variety SKUs; pre-fill shipment modal
  const baseSkus = SKUS.filter(s=>s.id!=='variety');
  const perSku = Math.round(totalCasesNeeded / SKUS.length);
  SKUS.forEach(s=>{
    const input = qs('#ship-'+s.id);
    if (input) input.value = perSku > 0 ? perSku : '';
  });
  const dt = new Date(Date.now()+7*86400000).toISOString().slice(0,10);
  if (qs('#ship-date')) qs('#ship-date').value = dt;
  if (qs('#ship-customer')) qs('#ship-customer').value = 'Production Run';
  openModal('modal-shipment');
}

function renderTodaySchedule() {
  const sched = DB.obj('today_run', {date:'', items:{}});
  const el = qs('#prod-today-sched');
  if (!el) return;
  el.innerHTML = SKUS.map(s=>`
    <div class="sku-row ${s.bg}">
      <div>${skuBadge(s.id)}</div>
      <div style="display:flex;align-items:center;gap:8px">
        <input type="number" id="sched-${s.id}" value="${sched.items?.[s.id]||''}" min="0" step="6" style="width:80px" placeholder="0">
        <span style="font-size:12px;color:var(--muted)">units</span>
      </div>
    </div>`).join('');
}

function saveTodayRun() {
  const items = {};
  SKUS.forEach(s=>{ const v=parseInt(qs('#sched-'+s.id)?.value)||0; if(v>0) items[s.id]=v; });
  if (!Object.keys(items).length) { toast('Enter at least one quantity'); return; }
  const notes = qs('#sched-notes')?.value?.trim()||'';
  const entry = {id:uid(), date:today(), notes, ...items};
  DB.push('prod_hist', entry);
  // Also update inventory — store prodId so we can clean up on delete
  Object.entries(items).forEach(([sku, qty])=>{
    DB.push('iv', {id:uid(), date:today(), sku, type:'in', qty, note:'Production run', prodId:entry.id});
  });
  if(qs('#sched-notes')) qs('#sched-notes').value='';
  renderProduction();
  renderInventory();
  toast('Production run logged & inventory updated');
}

function delShipment(id) {
  if (!confirm2('Remove this shipment?')) return;
  DB.remove('shipments', id);
  renderProduction();
  toast('Removed');
}

function delProdHist(id) {
  if (!confirm2('Remove this production record?')) return;
  // Remove linked inventory entries (by prodId; fallback: match by date+qty for legacy records)
  const rec = DB.a('prod_hist').find(p=>p.id===id);
  DB.a('iv').filter(e=>
    e.prodId===id ||
    (!e.prodId && e.note==='Production run' && e.type==='in' && e.date===rec?.date && rec?.[e.sku]==e.qty)
  ).forEach(e=>DB.remove('iv',e.id));
  DB.remove('prod_hist', id);
  renderProduction();
  renderInventory();
  renderDash();
  toast('Production record and inventory entries removed');
}

function saveShipment() {
  const customer = qs('#ship-customer')?.value?.trim();
  const date     = qs('#ship-date')?.value;
  const type     = qs('#ship-type')?.value||'Standard';
  const notes    = qs('#ship-notes')?.value?.trim()||'';
  if (!customer || !date) { toast('Customer and date required'); return; }
  const ship = {id:uid(), customer, date, type, notes};
  SKUS.forEach(s=>{ ship[s.id]=parseInt(qs('#ship-'+s.id)?.value)||0; });
  DB.push('shipments', ship);
  closeModal('modal-shipment');
  renderProduction();
  toast('Shipment scheduled');
  _showInvoiceSuggestion(ship);
}

function _showInvoiceSuggestion(ship) {
  const banner = document.getElementById('inv-suggest-banner');
  if (!banner) return;
  const totalCases = SKUS.reduce((s,sk)=>s+(ship[sk.id]||0), 0);
  const msg = document.getElementById('inv-suggest-msg');
  if (msg) msg.textContent = `Create invoice for ${ship.customer} (${totalCases} case${totalCases!==1?'s':''})?`;

  banner.style.display = 'flex';

  const yesBtn = document.getElementById('inv-suggest-yes');
  const noBtn  = document.getElementById('inv-suggest-no');

  const dismiss = () => { banner.style.display = 'none'; };

  if (noBtn)  { noBtn.onclick  = dismiss; }
  if (yesBtn) {
    yesBtn.onclick = () => {
      dismiss();
      // Try to match customer name to an account
      const ac = DB.a('ac').find(a=>(a.name||'').toLowerCase()===(ship.customer||'').toLowerCase())
              || DB.a('ac').find(a=>(a.name||'').toLowerCase().includes((ship.customer||'').toLowerCase()));
      openAddInv(
        ac?.id || null,
        'dist',
        totalCases,
        `Distributor shipment to ${ship.customer} on ${ship.date}.`
      );
    };
  }
  // Auto-dismiss after 15 seconds
  clearTimeout(banner._t);
  banner._t = setTimeout(dismiss, 15000);
}

// ══════════════════════════════════════════════════════════
//  DELIVERY
// ══════════════════════════════════════════════════════════
let _deliveryFulfillFilter = 'direct';

function toggleDelLfSection() {
  const sec = qs('#del-lf-section');
  if (!sec) return;
  const showing = sec.style.display !== 'none';
  sec.style.display = showing ? 'none' : '';
  if (!showing) _renderDelLfInputs();
}

function _renderDelLfInputs() {
  const container = qs('#del-lf-inputs');
  if (!container) return;
  const skus = DB.a('lf_skus').filter(s=>!s.archived);
  if (!skus.length) {
    container.innerHTML = '<div style="color:var(--muted);font-size:13px">No LF SKUs configured. Add them in Settings.</div>';
    return;
  }
  container.innerHTML = skus.map(s=>`
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <label style="flex:1;font-size:13px">${escHtml(s.name)}</label>
      <input type="number" id="del-lf-${s.id}" min="0" value="0" style="width:64px;text-align:center">
      <span style="font-size:12px;color:var(--muted)">cs</span>
    </div>`).join('');
}

function addAccountToRun(accountId) {
  nav('orders-delivery');
  switchODTab('route-builder');
  setTimeout(() => {
    const sel = qs('#del-account-sel');
    if (sel) {
      sel.value = accountId;
      prefillStop(accountId);
    }
    qs('#del-stop-name')?.scrollIntoView({behavior:'smooth', block:'center'});
  }, 120);
}

function setDeliveryFulfillFilter(mode) {
  _deliveryFulfillFilter = mode;
  ['direct','all','dist'].forEach(m=>{
    const btn = qs('#del-ff-'+m);
    if (btn) btn.classList.toggle('active', m===mode);
  });
  renderDelivery();
}

function renderDelivery() {
  const run = DB.obj('today_run', {date:'', stops:[]});
  const stops = run.stops || [];

  const el = qs('#del-stops');
  if (!el) return;
  el.innerHTML = stops.length ? stops.map((s,i)=>{
    // Look up account for dropOffRules (by stored accountId, then by name fallback)
    const ac = (s.accountId ? DB.a('ac').find(a=>a.id===s.accountId) : null)
             || DB.a('ac').find(a=>a.name===s.name);
    const rules = ac?.dropOffRules || '';
    const isDistFulfilled = ac?.fulfilledBy && ac.fulfilledBy !== 'direct';
    const distName = isDistFulfilled ? DB.a('dist_profiles').find(d=>d.id===ac.fulfilledBy)?.name : null;
    return `
    <div class="order-card ${s.done?'done':''}">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <input type="checkbox" ${s.done?'checked':''} onchange="toggleStop(${i})" style="width:16px;height:16px;margin-top:2px;cursor:pointer">
        <div style="flex:1">
          <div style="font-size:14px;font-weight:700;${s.done?'text-decoration:line-through;opacity:.5':''}">${s.name}</div>
          ${isDistFulfilled&&!s.done?`<div style="font-size:11px;color:#d97706;background:#fef3c7;padding:3px 8px;border-radius:4px;margin-bottom:4px">⚠ Fulfilled via ${distName||'distributor'} — confirm direct delivery is intentional</div>`:''}
          ${rules && !s.done ? `<div class="delivery-rules-box">
            <div class="delivery-rules-label">⚠ Delivery Instructions:</div>
            <div class="delivery-rules-text">${rules}</div>
          </div>` : ''}
          <div style="font-size:12px;color:var(--muted)">${s.address||''}</div>
          <div style="margin-top:6px">${SKUS.map(sk=>s[sk.id]>0?`${skuBadge(sk.id)} ×${s[sk.id]} cs`:'').filter(Boolean).join(' ')}</div>
          ${(s.lfItems||[]).length?`<div style="margin-top:4px;font-size:12px;color:#15803d">🌿 ${(s.lfItems).map(it=>`${escHtml(it.skuName)} ×${it.cases} cs`).join(' · ')}</div>`:''}
          ${s.notes?`<div style="font-size:12px;color:var(--muted);margin-top:4px">${s.notes}</div>`:''}
        </div>
        <button class="btn xs red no-print" onclick="removeStop(${i})">✕</button>
      </div>
    </div>`;
  }).join('') : '<div class="empty">No stops on today\'s route. Add stops below.</div>';

  // Stats
  const done = stops.filter(s=>s.done).length;
  qs('#del-progress').innerHTML = stops.length ? `${done}/${stops.length} stops complete` : '';

  // Pre-fill add-stop form with accounts filtered by fulfillment mode
  const acSel = qs('#del-account-sel');
  if (acSel) {
    let acList = DB.a('ac').filter(a=>a.status==='active');
    if (_deliveryFulfillFilter === 'direct') {
      acList = acList.filter(a=>!a.fulfilledBy||a.fulfilledBy==='direct');
    } else if (_deliveryFulfillFilter === 'dist') {
      acList = acList.filter(a=>a.fulfilledBy&&a.fulfilledBy!=='direct');
    }
    acSel.innerHTML = '<option value="">— Select account —</option>' +
      acList.map(a=>`<option value="${a.id}">${a.name}</option>`).join('');
    acSel.onchange = () => prefillStop(acSel.value);
  }
  // Pre-populate LF inputs (hidden until toggled)
  _renderDelLfInputs();
}

function prefillStop(accountId) {
  const ac2 = DB.a('ac').find(a=>a.id===accountId);
  if (!ac2) return;
  if (qs('#del-stop-name')) qs('#del-stop-name').value = ac2.name;
  if (qs('#del-stop-addr')) qs('#del-stop-addr').value = ac2.address||'';
  if (qs('#del-stop-notes') && ac2.dropOffRules) qs('#del-stop-notes').value = ac2.dropOffRules;
  SKUS.forEach(s=>{
    const el = qs('#del-qty-'+s.id);
    if (el) {
      // par stored in CANS; convert to CASES for delivery quantity entry
      const parCans  = ac2.par?.[s.id] || 0;
      el.value = parCans > 0 ? Math.ceil(parCans / CANS_PER_CASE) : 0;
    }
  });
  // Auto-show LF section for isPbf accounts, hide for others
  const lfSec = qs('#del-lf-section');
  if (lfSec) {
    if (ac2.isPbf) {
      lfSec.style.display = '';
      _renderDelLfInputs();
    } else {
      lfSec.style.display = 'none';
    }
  }
}

function addStop() {
  const name = qs('#del-stop-name')?.value?.trim();
  if (!name) { toast('Name required'); return; }
  const accountId = qs('#del-account-sel')?.value || null;
  const stop = {name, address:qs('#del-stop-addr')?.value?.trim()||'', notes:qs('#del-stop-notes')?.value?.trim()||'', done:false, accountId};
  SKUS.forEach(s=>{ stop[s.id]=parseInt(qs('#del-qty-'+s.id)?.value)||0; });

  // Collect LF items if section is visible
  const lfItems = [];
  if (qs('#del-lf-section')?.style.display !== 'none') {
    DB.a('lf_skus').filter(s=>!s.archived).forEach(s=>{
      const cases = parseInt(qs('#del-lf-'+s.id)?.value) || 0;
      if (cases > 0) lfItems.push({skuId: s.id, skuName: s.name, cases});
    });
  }
  if (lfItems.length) stop.lfItems = lfItems;

  const run = DB.obj('today_run', {date:today(), stops:[]});
  run.stops = [...(run.stops||[]), stop];
  DB.setObj('today_run', run);

  // Clear form
  if(qs('#del-stop-name')) qs('#del-stop-name').value='';
  if(qs('#del-stop-addr')) qs('#del-stop-addr').value='';
  if(qs('#del-stop-notes')) qs('#del-stop-notes').value='';
  SKUS.forEach(s=>{ if(qs('#del-qty-'+s.id)) qs('#del-qty-'+s.id).value=''; });
  if(qs('#del-account-sel')) { qs('#del-account-sel').value=''; }
  // Hide LF section and clear inputs
  const lfSec = qs('#del-lf-section');
  if (lfSec) { lfSec.style.display='none'; }
  DB.a('lf_skus').filter(s=>!s.archived).forEach(s=>{ const el=qs('#del-lf-'+s.id); if(el) el.value=''; });

  renderDelivery();
  toast('Stop added');
}

function toggleStop(i) {
  const run = DB.obj('today_run', {date:today(), stops:[]});
  if (!run.stops[i]) { renderDelivery(); return; }
  const wasDone = run.stops[i].done;
  run.stops[i].done = !wasDone;
  const stop = run.stops[i];

  // Look up account (prefer stored accountId, fallback to name match)
  const ac2 = (stop.accountId ? DB.a('ac').find(a=>a.id===stop.accountId) : null)
            || DB.a('ac').find(a=>a.name===stop.name);

  if (!wasDone && stop.done && ac2) {
    // ── Atomic delivery confirmation ──────────────────────
    // All four side-effects in one Firestore write:
    //  1. today_run updated above (done flag)
    //  2. account lastOrder
    //  3. inventory deduction in CANS (stop qty × CANS_PER_CASE)
    //  4. delivery order record in CASES
    const ordItems = SKUS.filter(s=>stop[s.id]>0).map(s=>({sku:s.id, qty:stop[s.id]}));
    const canCount = ordItems.reduce((sum,i)=>sum + i.qty * CANS_PER_CASE, 0);
    const newOrd = {
      id: uid(), accountId: ac2.id, created: today(), dueDate: today(),
      status: 'delivered', source: 'run', items: ordItems, canCount,
      notes: stop.notes||'',
    };
    const newIvEntries = ordItems.map(i=>({
      id: uid(), date: today(), sku: i.sku, type: 'out',
      // inventory is in CANS — multiply cases × CANS_PER_CASE
      qty: i.qty * CANS_PER_CASE,
      note: 'Delivery: ' + stop.name,
      ordId: newOrd.id,
    }));

    // Build LF wix deduction record for this stop (if any LF items)
    const stopLfItems = stop.lfItems || [];
    const newWixDeduction = stopLfItems.length ? {
      id: uid(), date: today(),
      runName: (DB.obj('today_run',{}).date || today()) + ' run',
      note: 'Delivery: ' + stop.name,
      items: stopLfItems,
      confirmed: false,
    } : null;

    DB.atomicUpdate(cache => {
      cache['today_run'] = run;
      cache['ac'] = (cache['ac']||[]).map(a => a.id===ac2.id ? {...a, lastOrder:today()} : a);
      cache['iv'] = [...(cache['iv']||[]), ...newIvEntries];
      cache['orders'] = [...(cache['orders']||[]), newOrd];
      if (newWixDeduction) {
        cache['lf_wix_deductions'] = [...(cache['lf_wix_deductions']||[]), newWixDeduction];
      }
    });

    // Show Wix pull reminder if this stop had LF items
    if (newWixDeduction) {
      setTimeout(()=>showWixPullModal(null, newWixDeduction.id), 300);
    }

    // Offer invoice (non-blocking — renders after DB write)
    setTimeout(()=>offerDeliveryInvoice(stop, ac2, newOrd.id), 200);

    // Check if all stops are now done — offer batch invoicing
    const updatedRun = DB.obj('today_run', {stops:[]});
    const allDone = updatedRun.stops.length > 0 && updatedRun.stops.every(s=>s.done);
    if (allDone) setTimeout(()=>openDeliveryCostModal(updatedRun.stops), 800);

  } else {
    // Just toggling undone — simple update, no side-effects
    DB.setObj('today_run', run);
  }

  renderDelivery();
}

// ── Post-stop invoice offer (Phase 3) ────────────────────
function offerDeliveryInvoice(stop, ac, ordId) {
  // Show a non-blocking banner at top of delivery page
  const existing = document.getElementById('del-invoice-offer');
  if (existing) existing.remove();

  const items = SKUS.filter(s=>stop[s.id]>0);
  if (!items.length || !ac) return;

  const costs  = DB.obj('costs', {cogs:{}});
  const terms  = DB.obj('settings',{payment_terms:30}).payment_terms || 30;
  const dueDate = new Date(Date.now() + terms*864e5).toISOString().slice(0,10);

  const banner = document.createElement('div');
  banner.id = 'del-invoice-offer';
  banner.className = 'invoice-offer-banner';
  banner.innerHTML = `
    <div class="invoice-offer-text">
      <strong>Create invoice for ${ac.name}?</strong>
      <span style="font-size:12px;color:var(--muted)">Due ${fmtD(dueDate)}</span>
    </div>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button class="btn sm primary" onclick="createDeliveryInvoice('${ac.id}','${ordId}')">Create Invoice</button>
      <button class="btn sm" onclick="document.getElementById('del-invoice-offer')?.remove()">Skip</button>
    </div>`;

  const page = document.getElementById('page-orders-delivery');
  if (page) page.insertBefore(banner, page.firstChild);
}

function createDeliveryInvoice(accountId, ordId) {
  const ac      = DB.a('ac').find(a=>a.id===accountId);
  const ord     = DB.a('orders').find(o=>o.id===ordId);
  if (!ac || !ord) return;

  const costs   = DB.obj('costs', {cogs:{}});
  const terms   = DB.obj('settings',{payment_terms:30}).payment_terms || 30;
  const dueDate = new Date(Date.now() + terms*864e5).toISOString().slice(0,10);

  // Auto-increment invoice number from the single invoice collection
  const lastNum = DB.a('retail_invoices').reduce((max,inv)=>{
    const n = parseInt((inv.invoiceNumber||'').replace(/\D/g,'')) || 0;
    return Math.max(max, n);
  }, 0);
  const invoiceNumber = 'INV-' + String(lastNum + 1).padStart(4, '0');

  // Build line items in CASES with pricing
  // pricePerCase = account-specific rate OR (COGS per can × 2.2 markup × CANS_PER_CASE)
  const lineItems = (ord.items||[]).map(i=>{
    const pricePerCase = ac.pricing?.[i.sku] || (costs.cogs?.[i.sku]||2.15) * 2.2 * CANS_PER_CASE;
    return {sku: i.sku, cases: i.qty, pricePerCase, amount: i.qty * pricePerCase};
  });
  const totalCases = lineItems.reduce((s,l)=>s+l.cases, 0);
  const total      = lineItems.reduce((s,l)=>s+l.amount, 0);
  const pricePerCase = totalCases > 0 ? total / totalCases : 0;

  const invoice = {
    id: uid(), accountId, orderId: ordId, invoiceNumber,
    date: today(), dueDate, lineItems,
    cases: totalCases, cans: totalCases * CANS_PER_CASE,
    pricePerCase, total,
    status: 'unpaid', source: 'delivery_run', notes: '',
    accountName: ac.name,
  };

  DB.push('retail_invoices', invoice);
  // Mark the order as invoiced
  DB.update('orders', ordId, o=>({...o, invoiceStatus:'invoiced', invoiceDate:today(), invoiceNumber}));

  document.getElementById('del-invoice-offer')?.remove();
  toast(`Invoice ${invoiceNumber} created for ${ac.name}`);
}

// ── After full run — offer batch invoicing ────────────────
function offerBatchInvoice(stops) {
  const existing = document.getElementById('del-batch-invoice-offer');
  if (existing) return; // already showing

  const uninvoiced = stops.filter(s=>{
    const ac = (s.accountId ? DB.a('ac').find(a=>a.id===s.accountId) : null)
             || DB.a('ac').find(a=>a.name===s.name);
    return ac && s.done;
  });
  if (!uninvoiced.length) return;

  const banner = document.createElement('div');
  banner.id = 'del-batch-invoice-offer';
  banner.className = 'invoice-offer-banner';
  banner.style.cssText = 'background:#f0fdf4;border-color:#16a34a';
  banner.innerHTML = `
    <div class="invoice-offer-text">
      <strong>Run complete! 🎉</strong>
      <span style="font-size:12px;color:var(--muted)">Create invoices for all ${uninvoiced.length} stops?</span>
    </div>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button class="btn sm primary" onclick="createBatchDeliveryInvoices()">Create All Invoices</button>
      <button class="btn sm" onclick="document.getElementById('del-batch-invoice-offer')?.remove()">Skip</button>
    </div>`;

  const page = document.getElementById('page-orders-delivery');
  if (page) page.insertBefore(banner, page.firstChild);
}

function createBatchDeliveryInvoices() {
  const run  = DB.obj('today_run', {stops:[]});
  const stops = run.stops.filter(s=>s.done);
  let created = 0;
  stops.forEach(s=>{
    const ac = (s.accountId ? DB.a('ac').find(a=>a.id===s.accountId) : null)
             || DB.a('ac').find(a=>a.name===s.name);
    if (!ac) return;
    // Find the delivery order for this stop (most recent run order for this account today)
    const ord = DB.a('orders').filter(o=>o.accountId===ac.id&&o.source==='run'&&o.created===today())
                               .sort((a,b)=>b.id>a.id?1:-1)[0];
    if (!ord) return;
    // Skip if already invoiced
    if (ord.invoiceStatus==='invoiced'||ord.invoiceStatus==='paid') return;
    createDeliveryInvoice(ac.id, ord.id);
    created++;
  });
  document.getElementById('del-batch-invoice-offer')?.remove();
  toast(`Created ${created} invoice${created!==1?'s':''}`);
}

function removeStop(i) {
  const run = DB.obj('today_run', {date:today(), stops:[]});
  run.stops = run.stops.filter((_,idx)=>idx!==i);
  DB.setObj('today_run', run);
  renderDelivery();
}

function clearRoute() {
  if (!confirm2('Clear today\'s route?')) return;
  // Archive completed run to history before clearing
  const run = DB.obj('today_run', {stops:[]});
  if (run.stops && run.stops.length > 0) {
    const totalCases = run.stops.reduce((sum,s)=>sum+SKUS.reduce((c,sk)=>c+(s[sk.id]||0),0),0);
    DB.push('runs', {
      id: uid(),
      date: run.date || today(),
      stops: run.stops,
      totalCases,
      milesDriven: run.milesDriven || 0,
      fuelCost: run.fuelCost || 0,
      costPerCase: run.costPerCase || 0,
    });
  }
  DB.setObj('today_run', {date:today(), stops:[]});
  const acSel = qs('#del-account-sel');
  if (acSel) acSel.dataset.loaded = '';
  renderDelivery();
  toast('Route cleared');
}

// ── Delivery Cost Modal ───────────────────────────────────
let _deliveryCostStops = [];
function openDeliveryCostModal(stops) {
  _deliveryCostStops = stops;
  const s = DB.obj('settings', {});
  if (qs('#dcm-mpg'))   qs('#dcm-mpg').value   = s.mpg      || 25;
  if (qs('#dcm-gas'))   qs('#dcm-gas').value   = s.gasPrice || 3.50;
  if (qs('#dcm-miles')) qs('#dcm-miles').value = '';
  if (qs('#dcm-fuel'))  qs('#dcm-fuel').value  = '';
  if (qs('#dcm-cost-per-case')) qs('#dcm-cost-per-case').textContent = '';
  const totalCases = stops.reduce((sum,s)=>sum+SKUS.reduce((c,sk)=>c+(s[sk.id]||0),0),0);
  if (qs('#dcm-summary')) qs('#dcm-summary').textContent = `${stops.length} stop${stops.length!==1?'s':''} · ${totalCases} case${totalCases!==1?'s':''} delivered`;
  openModal('modal-delivery-cost');
}
function _calcDeliveryFuel() {
  const miles = parseFloat(qs('#dcm-miles')?.value) || 0;
  const mpg   = parseFloat(qs('#dcm-mpg')?.value)   || 25;
  const gas   = parseFloat(qs('#dcm-gas')?.value)   || 3.50;
  const fuel  = miles > 0 ? miles / mpg * gas : 0;
  if (qs('#dcm-fuel')) qs('#dcm-fuel').value = fuel > 0 ? fuel.toFixed(2) : '';
  const totalCases = _deliveryCostStops.reduce((sum,s)=>sum+SKUS.reduce((c,sk)=>c+(s[sk.id]||0),0),0);
  if (qs('#dcm-cost-per-case')) qs('#dcm-cost-per-case').textContent =
    totalCases > 0 && fuel > 0 ? `Cost per case: $${(fuel/totalCases).toFixed(2)}` : '';
}
function saveDeliveryCost() {
  const miles      = parseFloat(qs('#dcm-miles')?.value) || 0;
  const fuel       = parseFloat(qs('#dcm-fuel')?.value)  || 0;
  const totalCases = _deliveryCostStops.reduce((sum,s)=>sum+SKUS.reduce((c,sk)=>c+(s[sk.id]||0),0),0);
  const costPerCase = totalCases > 0 && fuel > 0 ? fuel / totalCases : 0;
  const run = DB.obj('today_run', {});
  DB.setObj('today_run', {...run, milesDriven: miles, fuelCost: fuel, costPerCase});
  closeModal('modal-delivery-cost');
  if (miles > 0) toast(`Delivery cost logged: ${miles} mi · $${fuel.toFixed(2)}`);
  offerBatchInvoice(_deliveryCostStops);
}
function _skipDeliveryCost() {
  closeModal('modal-delivery-cost');
  offerBatchInvoice(_deliveryCostStops);
}

// ══════════════════════════════════════════════════════════
//  REPORTS
// ══════════════════════════════════════════════════════════
// ── Report Builder (Phase 6) ──────────────────────────────
let _reportChart = null;
let _reportType  = 'revenue';
let _reportData  = null; // cached for CSV export

function setRepBrand(brand) {
  _repBrand = brand;
  qs('#rep-purpl-section').style.display = brand === 'purpl' ? '' : 'none';
  qs('#rep-lf-section').style.display    = brand === 'lf'    ? '' : 'none';
  qs('#rep-brand-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.val === brand);
  });
  if (brand === 'lf') renderLfReports();
}

function renderReports() {
  // Combined total KPI — all brands, all time (injected above existing KPI row)
  const kpiRow = qs('#rep-kpi-row');
  if (kpiRow) {
    let combinedEl = qs('#rep-combined-kpi');
    if (!combinedEl) {
      combinedEl = document.createElement('div');
      combinedEl.id = 'rep-combined-kpi';
      combinedEl.style.marginBottom = '12px';
      kpiRow.parentNode.insertBefore(combinedEl, kpiRow);
    }
    const purplInvoiced = DB.a('iv').reduce((s,x) => s + parseFloat(x.amount||0), 0);
    const lfInvoiced    = DB.a('lf_invoices').reduce((s,x) => s + parseFloat(x.total||0), 0);
    combinedEl.innerHTML = `<div class="kpi green" style="max-width:260px">` +
      `<div class="num">${fmtC(purplInvoiced + lfInvoiced)}</div>` +
      `<div class="label">Total Invoiced (All Brands)</div>` +
      `<div style="font-size:10px;color:var(--muted);margin-top:2px">purpl + LF combined</div></div>`;
  }

  // Set default date range if blank (last 90 days)
  const fromEl = qs('#rep-date-from');
  const toEl   = qs('#rep-date-to');
  if (fromEl && !fromEl.value) fromEl.value = new Date(Date.now()-90*864e5).toISOString().slice(0,10);
  if (toEl   && !toEl.value)   toEl.value   = today();

  // Populate year-end filter dropdown (once)
  const yrSel = qs('#rep-year-filter');
  if (yrSel && !yrSel.dataset.built) {
    yrSel.dataset.built = '1';
    const curYear = new Date().getFullYear();
    yrSel.innerHTML = [curYear, curYear-1].map(y => `<option value="${y}">${y}</option>`).join('') +
      `<option value="all">All time</option>`;
  }

  // Wire tabs (once — guard with dataset flag)
  const tabs = qs('#rep-type-tabs');
  if (tabs && !tabs.dataset.wired) {
    tabs.dataset.wired = '1';
    tabs.querySelectorAll('.tab').forEach(t=>{
      t.addEventListener('click', ()=>{
        tabs.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
        t.classList.add('active');
        _reportType = t.dataset.rep;
        renderReportContent();
      });
    });
    fromEl?.addEventListener('change', renderReportContent);
    toEl?.addEventListener('change', renderReportContent);
  }

  // Show/hide purpl vs LF based on current brand
  const purplSec = qs('#rep-purpl-section');
  const lfSec    = qs('#rep-lf-section');
  if (purplSec) purplSec.style.display = _repBrand === 'purpl' ? '' : 'none';
  if (lfSec)    lfSec.style.display    = _repBrand === 'lf'    ? '' : 'none';
  qs('#rep-brand-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.classList.toggle('active', b.dataset.val === _repBrand);
  });

  if (_repBrand === 'lf') {
    renderLfReports();
    return;
  }

  _reportType = tabs?.querySelector('.tab.active')?.dataset.rep || 'revenue';
  renderReportContent();
  renderSavedReports();
  renderTopAccountsReport();
  renderGoingColdReport();
  renderMomReport();
}

// ── Top 10 Accounts by Volume ─────────────────────────────
function renderTopAccountsReport() {
  const tb = qs('#rep-top-accounts-tbody');
  if (!tb) return;

  const orders   = DB.a('orders').filter(o => o.status !== 'cancelled');
  const accounts = DB.a('ac');

  const byAc = {};
  orders.forEach(o => {
    if (!o.accountId) return;
    if (!byAc[o.accountId]) byAc[o.accountId] = { cases: 0, revenue: 0, lastOrder: '' };
    const e = byAc[o.accountId];
    (o.items || []).forEach(i => { e.cases += (i.qty || 0); });
    e.revenue  += calcOrderValue(o);
    if (!e.lastOrder || (o.dueDate || '') > e.lastOrder) e.lastOrder = o.dueDate || '';
  });

  const rows = Object.entries(byAc)
    .map(([id, d]) => {
      const ac = accounts.find(a => a.id === id);
      return { name: ac?.name || '(deleted)', territory: ac?.territory || '', ...d };
    })
    .sort((a, b) => b.cases - a.cases)
    .slice(0, 10);

  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty">No order data yet</td></tr>';
    return;
  }

  tb.innerHTML = rows.map((r, i) => `<tr>
    <td>${i + 1}</td>
    <td>${escHtml(r.name)}<br><small style="color:var(--muted)">${escHtml(r.territory)}</small></td>
    <td>${fmt(r.cases * CANS_PER_CASE)}</td>
    <td>${fmt(r.cases)}</td>
    <td>${fmtC(r.revenue)}</td>
    <td>${r.lastOrder ? fmtD(r.lastOrder) : '—'}</td>
  </tr>`).join('');
}

// ── Accounts Going Cold ───────────────────────────────────
function renderGoingColdReport() {
  const tb = qs('#rep-going-cold-tbody');
  if (!tb) return;

  const COLD_DAYS   = 45;
  const todayStr    = today();
  const orders      = DB.a('orders').filter(o => o.status !== 'cancelled');
  const accounts    = DB.a('ac').filter(a => a.status === 'active');
  const invoices    = DB.a('iv');

  const rows = [];
  accounts.forEach(ac => {
    const acOrds = orders.filter(o => o.accountId === ac.id);
    if (!acOrds.length) return; // must have at least one order

    const lastOrd = acOrds.reduce((best, o) => (!best || (o.dueDate || '') > (best.dueDate || '') ? o : best), null);
    const daysSince = lastOrd ? daysAgo(lastOrd.dueDate) : 999;
    if (daysSince < COLD_DAYS) return;

    const outstanding = invoices.filter(i => i.accountId === ac.id && i.status !== 'paid').reduce((s, i) => s + parseFloat(i.amount || 0), 0);
    rows.push({ name: ac.name, lastOrder: lastOrd?.dueDate || '', daysSince, outstanding });
  });

  rows.sort((a, b) => b.daysSince - a.daysSince);

  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="4" class="empty">No accounts going cold &mdash; great!</td></tr>';
    return;
  }

  tb.innerHTML = rows.map(r => `<tr>
    <td>${escHtml(r.name)}</td>
    <td>${r.lastOrder ? fmtD(r.lastOrder) : '—'}</td>
    <td><span style="color:var(--red);font-weight:600">${r.daysSince}d</span></td>
    <td>${r.outstanding > 0 ? fmtC(r.outstanding) : '<span style="color:var(--muted)">—</span>'}</td>
  </tr>`).join('');
}

// ── Month over Month ──────────────────────────────────────
function renderMomReport() {
  const tb = qs('#rep-mom-tbody');
  if (!tb) return;

  const orders = DB.a('orders').filter(o => o.status !== 'cancelled');
  const months = [];
  const now    = new Date();

  for (let i = 5; i >= 0; i--) {
    const d     = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key   = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    months.push({ key, label, orderCount: 0, cases: 0, revenue: 0 });
  }

  orders.forEach(o => {
    const dateStr = o.dueDate || o.created || '';
    if (!dateStr) return;
    const key = dateStr.slice(0, 7);
    const m   = months.find(x => x.key === key);
    if (!m) return;
    m.orderCount++;
    (o.items || []).forEach(i => { m.cases += (i.qty || 0); });
    m.revenue += calcOrderValue(o);
  });

  tb.innerHTML = months.map(m => `<tr>
    <td>${m.label}</td>
    <td>${m.orderCount}</td>
    <td>${fmt(m.cases)}</td>
    <td>${fmtC(m.revenue)}</td>
  </tr>`).join('');
}

function _repDateRange() {
  const from = qs('#rep-date-from')?.value || new Date(Date.now()-90*864e5).toISOString().slice(0,10);
  const to   = qs('#rep-date-to')?.value   || today();
  return {from, to};
}

function _repFilterOrders(orders) {
  const {from, to} = _repDateRange();
  return orders.filter(o=>o.status!=='cancelled'&&o.dueDate>=from&&o.dueDate<=to);
}

function _drawChart(type, labels, datasets, title) {
  const ct = qs('#rep-chart-title');
  if (ct) ct.textContent = title;
  const canvas = qs('#rep-chart');
  if (!canvas) return;
  if (_reportChart) { _reportChart.destroy(); _reportChart = null; }
  if (!window.Chart) return;
  _reportChart = new Chart(canvas, {
    type,
    data:{ labels, datasets },
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ position:'bottom', labels:{ boxWidth:12, font:{size:11} } } },
      scales: type==='pie'||type==='doughnut' ? {} : {
        y:{ beginAtZero:true, ticks:{ font:{size:11} } },
        x:{ ticks:{ font:{size:11}, maxRotation:40 } }
      }
    }
  });
}

function renderReportContent() {
  if (qs('#rep-extra')) qs('#rep-extra').innerHTML = '';
  const handlers = {
    revenue:     repRevenue,
    accounts:    repAccounts,
    sku_perf:    repSkuPerf,
    inventory:   repInventory,
    distributor: repDistributor,
    profit:      repProfit,
    win_loss:    repWinLoss,
    returns:     repReturns,
    delivery:    repDelivery,
  };
  (handlers[_reportType]||repRevenue)();
}

// ── Returns Report ──────────────────────────────────────
function repReturns() {
  const from = qs('#rep-date-from')?.value || '';
  const to   = qs('#rep-date-to')?.value   || '';
  const all  = DB.a('returns').filter(r=>(!from||r.date>=from)&&(!to||r.date<=to));

  const totalCans   = all.reduce((s,r)=>s+(r.cans||0), 0);
  const totalCredit = all.reduce((s,r)=>s+(r.creditIssued?r.creditAmount||0:0), 0);
  _setKPIs(all.length, totalCans+' cans', fmtC(totalCredit), '—');

  const byAc = {};
  all.forEach(r=>{ byAc[r.accountName||'Unknown']=(byAc[r.accountName||'Unknown']||0)+(r.cans||0); });
  const acRows = Object.entries(byAc).sort((a,b)=>b[1]-a[1]).map(([n,c])=>[escHtml(n), c+' cans']);
  _setTable(['Account','Cans Returned'], acRows, 'Returns by Account');

  const byReason = {};
  all.forEach(r=>{ byReason[r.reason||'Other']=(byReason[r.reason||'Other']||0)+1; });
  const reasons = Object.entries(byReason).sort((a,b)=>b[1]-a[1]);
  const extraEl = qs('#rep-extra');
  if (extraEl) {
    extraEl.innerHTML = reasons.length ? `<div class="card"><div style="font-weight:600;margin-bottom:10px">By Reason</div>${
      reasons.map(([r,c])=>`<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:13px">
        <div style="min-width:180px">${escHtml(r)}</div>
        <div style="flex:1;background:#f3f4f6;border-radius:4px;height:18px">
          <div style="background:#f97316;height:100%;width:${(c/reasons[0][1]*100).toFixed(0)}%;border-radius:4px"></div>
        </div>
        <div style="min-width:24px;text-align:right">${c}</div>
      </div>`).join('')
    }</div>` : '';
  }
  if (reasons.length) {
    _drawChart('bar', reasons.map(([r])=>r),
      [{label:'Count', data:reasons.map(([,c])=>c), backgroundColor:'rgba(249,115,22,0.7)', borderRadius:4}],
      'Returns by Reason');
  }
}

// ── Delivery Cost Report ────────────────────────────────
function repDelivery() {
  const runs = DB.a('runs');
  const totalMiles  = runs.reduce((s,r)=>s+(r.milesDriven||0), 0);
  const totalFuel   = runs.reduce((s,r)=>s+(r.fuelCost||0), 0);
  const totalCases  = runs.reduce((s,r)=>s+(r.totalCases||0), 0);
  const avgCostCase = totalCases>0 ? '$'+(totalFuel/totalCases).toFixed(2) : '—';
  _setKPIs(fmt(totalMiles)+' mi', fmtC(totalFuel), avgCostCase, runs.length+' runs');
  const rows = runs.slice().sort((a,b)=>b.date>a.date?1:-1).map(r=>[
    fmtD(r.date),
    fmt(r.totalCases||0)+' cs',
    fmt(r.milesDriven||0)+' mi',
    r.fuelCost?fmtC(r.fuelCost):'—',
    r.costPerCase?'$'+parseFloat(r.costPerCase).toFixed(2):'—',
  ]);
  _setTable(['Date','Cases','Miles','Fuel Cost','Cost/Case'], rows, 'Delivery Run History');
}

// ── Win/Loss Report ─────────────────────────────────────────
function repWinLoss() {
  const allPr = DB.a('pr');
  const won   = allPr.filter(p=>p.status==='won');
  const lost  = allPr.filter(p=>p.status==='lost');
  const total = won.length + lost.length;
  const winRatePct = total > 0 ? ((won.length/total)*100).toFixed(1) : '—';

  _setKPIs(
    won.length,
    lost.length,
    winRatePct + (winRatePct !== '—' ? '%' : ''),
    total + ' evaluated'
  );

  const reasons = {};
  lost.forEach(p=>{ const r = p.lostReason||'Unknown'; reasons[r]=(reasons[r]||0)+1; });
  const sorted = Object.entries(reasons).sort((a,b)=>b[1]-a[1]);

  const thead = qs('#rep-table-head');
  const tbody = qs('#rep-table-body');
  const tt = qs('#rep-table-title'); if (tt) tt.textContent = 'Loss Reasons';
  if (thead) thead.innerHTML = '<tr><th>Reason</th><th>Count</th></tr>';
  if (tbody) tbody.innerHTML = sorted.length
    ? sorted.map(([r,c])=>`<tr><td>${escHtml(r)}</td><td>${c}</td></tr>`).join('')
    : '<tr><td colspan="2" class="empty">No lost prospects yet</td></tr>';

  const extraEl = qs('#rep-extra');
  if (extraEl && won.length) {
    extraEl.innerHTML = `<div class="card"><div style="font-weight:600;margin-bottom:8px">Converted Prospects (${won.length})</div><div style="font-size:13px;color:var(--muted)">${won.map(p=>escHtml(p.name)).join(', ')}</div></div>`;
  }

  if (sorted.length) {
    _drawChart('bar',
      sorted.map(([r])=>r),
      [{label:'Count', data:sorted.map(([,c])=>c), backgroundColor:'rgba(220,38,38,0.7)', borderRadius:4}],
      'Loss Reasons'
    );
  } else {
    const ct = qs('#rep-chart-title'); if (ct) ct.textContent = 'Win/Loss';
  }
}

// ── Revenue & Sales ────────────────────────────────────────
function repRevenue() {
  const orders = _repFilterOrders(DB.a('orders'));
  const costs  = DB.obj('costs', {cogs:{}});

  const bySkuRev={}, bySkuCases={};
  SKUS.forEach(s=>{bySkuRev[s.id]=0;bySkuCases[s.id]=0;});
  orders.forEach(o=>{
    const ac2 = DB.a('ac').find(a=>a.id===o.accountId);
    (o.items||[]).forEach(i=>{
      // i.qty = cases; pricePerCase = account pricing or COGS × markup × CANS_PER_CASE
      const pricePerCase = ac2?.pricing?.[i.sku]||(costs.cogs[i.sku]||2.15)*2.2*CANS_PER_CASE;
      bySkuRev[i.sku]   = (bySkuRev[i.sku]||0)   + pricePerCase * i.qty;
      bySkuCases[i.sku] = (bySkuCases[i.sku]||0) + i.qty;
    });
  });

  const totalRev   = Object.values(bySkuRev).reduce((a,b)=>a+b,0);
  const totalCases = Object.values(bySkuCases).reduce((a,b)=>a+b,0);
  // COGS is per-can; total COGS = cans = cases × CANS_PER_CASE
  const totalCogs  = SKUS.reduce((s,sk)=>s+(costs.cogs[sk.id]||2.15)*((bySkuCases[sk.id]||0)*CANS_PER_CASE),0);
  const totalGP    = totalRev - totalCogs;

  _setKPIs(fmtC(totalRev), fmt(totalCases)+' cases', fmtC(totalGP), totalRev>0?fmt((totalGP/totalRev)*100,1)+'%':'—');

  _drawChart('bar',
    SKUS.map(s=>s.label),
    [{label:'Revenue', data:SKUS.map(s=>+(bySkuRev[s.id]||0).toFixed(2)), backgroundColor:'rgba(75,32,130,0.75)', borderRadius:4}],
    'Revenue by SKU'
  );

  const rows = SKUS.map(s=>{
    const rev=bySkuRev[s.id]||0, cases=bySkuCases[s.id]||0;
    const cogs=(costs.cogs[s.id]||2.15)*cases*CANS_PER_CASE; // COGS in cans
    const gp=rev-cogs, margin=rev>0?gp/rev:0;
    return [s.label, fmt(cases)+' cs', fmtC(rev), fmtC(cogs), fmtC(gp), fmt(margin*100,1)+'%'];
  });
  _setTable(['SKU','Cases','Revenue','COGS','Gross Profit','Margin'], rows, 'Revenue by SKU');
  _reportData = {headers:['SKU','Cases','Revenue','COGS','Gross Profit','Margin'], rows};
}

// ── Account Performance ────────────────────────────────────
function repAccounts() {
  const orders = _repFilterOrders(DB.a('orders'));
  const costs  = DB.obj('costs', {cogs:{}});
  const acMap  = {};
  DB.a('ac').filter(a=>a.status==='active').forEach(a=>{ acMap[a.id]={name:a.name, rev:0, qty:0, orderCount:0}; });

  orders.forEach(o=>{
    if (!acMap[o.accountId]) return;
    const ac2 = DB.a('ac').find(a=>a.id===o.accountId);
    acMap[o.accountId].orderCount++;
    (o.items||[]).forEach(i=>{
      // i.qty = cases; price per case
      const pricePerCase = ac2?.pricing?.[i.sku]||(costs.cogs[i.sku]||2.15)*2.2*CANS_PER_CASE;
      acMap[o.accountId].rev += pricePerCase * i.qty;
      acMap[o.accountId].qty += i.qty; // cases
    });
  });

  const sorted = Object.values(acMap).sort((a,b)=>b.rev-a.rev);
  const totalRev = sorted.reduce((s,a)=>s+a.rev,0);

  _setKPIs(fmtC(totalRev), sorted.filter(a=>a.orderCount>0).length+' accounts', fmt(sorted.reduce((s,a)=>s+a.qty,0))+' units', sorted.reduce((s,a)=>s+a.orderCount,0)+' orders');

  const colors=['#4B2082','#7B5CA7','#A78BD4','#D4BEF0','#EDE4F5','#805074818841'];
  _drawChart('doughnut',
    sorted.slice(0,8).map(a=>a.name),
    [{data:sorted.slice(0,8).map(a=>+a.rev.toFixed(2)), backgroundColor:sorted.slice(0,8).map((_,i)=>`hsl(${270+i*18},60%,${40+i*5}%)`)}],
    'Revenue by Account'
  );

  const rows = sorted.map(a=>[a.name, fmt(a.orderCount), fmt(a.qty), fmtC(a.rev), totalRev>0?fmt((a.rev/totalRev)*100,1)+'%':'—']);
  _setTable(['Account','Orders','Units','Revenue','% of Total'], rows, 'Account Performance');
  _reportData = {headers:['Account','Orders','Units','Revenue','% of Total'], rows};
}

// ── SKU Performance ────────────────────────────────────────
function repSkuPerf() {
  const orders = _repFilterOrders(DB.a('orders'));
  const acLookup = Object.fromEntries(DB.a('ac').map(a => [a.id, a.name]));
  const acMap = {}; // { accountId: { name, [sku]: cases, total } }

  orders.forEach(o => {
    if (!acMap[o.accountId]) {
      acMap[o.accountId] = { name: acLookup[o.accountId] || 'Unknown' };
      SKUS.forEach(sk => { acMap[o.accountId][sk.id] = 0; });
      acMap[o.accountId].total = 0;
    }
    (o.items||[]).forEach(i => {
      if (acMap[o.accountId][i.sku] !== undefined) {
        acMap[o.accountId][i.sku] += i.qty;
        acMap[o.accountId].total += i.qty;
      }
    });
  });

  const rows = Object.values(acMap).filter(r => r.total > 0).sort((a, b) => b.total - a.total);
  const skuTotals = {};
  SKUS.forEach(sk => { skuTotals[sk.id] = rows.reduce((s, r) => s + (r[sk.id]||0), 0); });
  const totalAllCases = rows.reduce((s, r) => s + r.total, 0);

  const bestSku = SKUS.reduce((best, sk) => (skuTotals[sk.id]||0) > (skuTotals[best.id]||0) ? sk : best, SKUS[0]);
  const topAc = rows[0];

  _setKPIs(
    fmt(totalAllCases) + ' cases',
    bestSku.label + ' (' + fmt(skuTotals[bestSku.id]||0) + ' cs)',
    topAc ? topAc.name : '—',
    rows.length + ' accounts'
  );

  _drawChart('bar',
    SKUS.map(s => s.label),
    [{ label: 'Cases', data: SKUS.map(s => skuTotals[s.id]||0), backgroundColor: 'rgba(75,32,130,0.75)', borderRadius: 4 }],
    'Cases by SKU'
  );

  const headers = ['Account', ...SKUS.map(s => s.label), 'Total Cases'];
  const tableRows = rows.map(r => [r.name, ...SKUS.map(sk => r[sk.id]||0), r.total]);
  _setTable(headers, tableRows, 'SKU Performance by Account');

  // Footer totals row
  const tb = qs('#rep-table-body');
  if (tb) {
    tb.innerHTML += `<tr style="font-weight:600;border-top:2px solid var(--border);background:#fafafa">
      <td>TOTAL</td>${SKUS.map(sk => `<td>${skuTotals[sk.id]||0}</td>`).join('')}<td>${totalAllCases}</td>
    </tr>`;
  }
  _reportData = { headers, rows: tableRows };
}

// ── Inventory ──────────────────────────────────────────────
function repInventory() {
  const inv   = DB.a('iv');
  const costs = DB.obj('costs', {cogs:{}});

  const rows = SKUS.map(s=>{
    const ins  = inv.filter(i=>i.sku===s.id&&i.type==='in').reduce((t,i)=>t+i.qty,0);
    const outs = inv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
    const oh   = Math.max(0, ins-outs);
    const val  = oh*(costs.cogs[s.id]||2.15);
    const status = oh<24?'Critical':oh<48?'Low':'OK';
    return [s.label, fmt(ins), fmt(outs), fmt(oh), fmtC(val), status];
  });
  const totalOH = SKUS.reduce((s,sk)=>{ const i=DB.a('iv').filter(x=>x.sku===sk.id); const ins=i.filter(x=>x.type==='in').reduce((a,b)=>a+b.qty,0); const outs=i.filter(x=>x.type==='out').reduce((a,b)=>a+b.qty,0); return s+Math.max(0,ins-outs); },0);
  const totalVal= SKUS.reduce((s,sk)=>{ const i=DB.a('iv').filter(x=>x.sku===sk.id); const ins=i.filter(x=>x.type==='in').reduce((a,b)=>a+b.qty,0); const outs=i.filter(x=>x.type==='out').reduce((a,b)=>a+b.qty,0); return s+Math.max(0,ins-outs)*(costs.cogs[sk.id]||2.15); },0);

  _setKPIs(fmt(totalOH)+' units', fmtC(totalVal), rows.filter(r=>r[5]==='Low').length+' low', rows.filter(r=>r[5]==='Critical').length+' critical');

  _drawChart('bar',
    SKUS.map(s=>s.label),
    [{label:'On Hand', data:rows.map(r=>parseInt(r[3].replace(/,/g,''))||0), backgroundColor:'rgba(75,32,130,0.75)', borderRadius:4}],
    'Inventory On Hand'
  );

  _setTable(['SKU','Received','Shipped','On Hand','COGS Value','Status'], rows, 'Inventory Snapshot');
  _reportData = {headers:['SKU','Received','Shipped','On Hand','COGS Value','Status'], rows};
}

// ── Distributor ────────────────────────────────────────────
function repDistributor() {
  const dists  = DB.a('dist_profiles');
  const allPOs = DB.a('dist_pos');
  const allInv = DB.a('dist_invoices');
  const {from, to} = _repDateRange();

  const rows = dists.map(d=>{
    const pos = allPOs.filter(p=>p.distId===d.id&&p.dateReceived>=from&&p.dateReceived<=to);
    const inv = allInv.filter(i=>i.distId===d.id&&i.dateIssued>=from&&i.dateIssued<=to);
    const poTotal  = pos.reduce((s,p)=>s+(p.totalValue||0),0);
    const invTotal = inv.reduce((s,i)=>s+(i.total||0),0);
    const paid     = inv.filter(i=>i.status==='paid').reduce((s,i)=>s+(i.total||0),0);
    return [d.name, d.status, pos.length, fmtC(poTotal), fmtC(invTotal), fmtC(paid), fmtC(invTotal-paid)];
  });

  const totalPOs = rows.reduce((s,r)=>s+parseInt(r[2])||0,0);
  const totalOut = allInv.filter(i=>['unpaid','overdue'].includes(i.status)).reduce((s,i)=>s+(i.total||0),0);

  _setKPIs(dists.filter(d=>d.status==='active').length+' active', totalPOs+' POs', fmtC(allPOs.reduce((s,p)=>s+(p.total||0),0)), fmtC(totalOut)+' outstanding');

  _drawChart('bar',
    dists.map(d=>d.name),
    [{label:'PO Value', data:dists.map(d=>allPOs.filter(p=>p.distId===d.id&&p.dateReceived>=from&&p.dateReceived<=to).reduce((s,p)=>s+(p.total||0),0)), backgroundColor:'rgba(75,32,130,0.75)', borderRadius:4}],
    'PO Value by Distributor'
  );

  _setTable(['Distributor','Status','POs','PO Total','Invoiced','Paid','Outstanding'], rows, 'Distributor Performance');
  _reportData = {headers:['Distributor','Status','POs','PO Total','Invoiced','Paid','Outstanding'], rows};

  // ── Velocity sub-section ──────────────────────────────────
  const repExtra = qs('#rep-extra');
  if (!repExtra) return;
  const now2 = new Date();
  const fom2 = `${now2.getFullYear()}-${String(now2.getMonth()+1).padStart(2,'0')}-01`;
  const lom2 = new Date(now2.getFullYear(), now2.getMonth()-1, 1);
  const fomLast2 = `${lom2.getFullYear()}-${String(lom2.getMonth()+1).padStart(2,'0')}-01`;

  const velRows = dists.map(d=>{
    const reports = (d.velocityReports||[]);
    const inRange = reports.filter(r=>r.date>=from&&r.date<=to);
    const thisMo  = reports.filter(r=>r.date>=fom2);
    const lastMo  = reports.filter(r=>r.date>=fomLast2&&r.date<fom2);
    const casesTM = thisMo.reduce((s,r)=>s+(r.cases||0),0);
    const casesLM = lastMo.reduce((s,r)=>s+(r.cases||0),0);
    const casesRange = inRange.reduce((s,r)=>s+(r.cases||0),0);
    const maxDoors = inRange.length ? Math.max(...inRange.map(r=>r.doors||0)) : 0;
    const trend = casesLM>0 ? ((casesTM-casesLM)/casesLM*100).toFixed(0)+'%' : '—';
    return [
      escHtml(d.name),
      maxDoors||'—',
      fmt(casesRange)+' cs',
      fmt(casesTM)+' cs',
      fmt(casesLM)+' cs',
      trend,
    ];
  });

  const totalCasesRange = dists.reduce((s,d)=>{
    const inRange = (d.velocityReports||[]).filter(r=>r.date>=from&&r.date<=to);
    return s + inRange.reduce((ss,r)=>ss+(r.cases||0),0);
  },0);

  repExtra.innerHTML = `
    <div class="card" style="margin-top:20px">
      <div style="font-weight:600;font-size:15px;margin-bottom:12px">Distributor Velocity</div>
      <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <div class="kpi purple" style="flex:1;min-width:120px"><div class="num">${fmt(totalCasesRange)}</div><div class="label">Cases Moved (range)</div></div>
        <div class="kpi" style="flex:1;min-width:120px"><div class="num">${dists.filter(d=>(d.velocityReports||[]).length>0).length}</div><div class="label">Dists with Velocity Data</div></div>
      </div>
      <div style="overflow-x:auto">
        <table class="data-table" style="width:100%">
          <thead><tr>
            <th>Distributor</th>
            <th>Max Doors</th>
            <th>Cases (range)</th>
            <th>Cases This Mo</th>
            <th>Cases Last Mo</th>
            <th>MoM Trend</th>
          </tr></thead>
          <tbody>${velRows.length ? velRows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('') :
            '<tr><td colspan="6" class="empty">No velocity data — log reports in each distributor\'s Velocity tab</td></tr>'
          }</tbody>
        </table>
      </div>
    </div>`;
}

// ── Gross Profit ───────────────────────────────────────────
function repProfit() {
  const orders = _repFilterOrders(DB.a('orders'));
  const costs  = DB.obj('costs', {cogs:{}});

  const bySkuRev={}, bySkuCases={};
  SKUS.forEach(s=>{bySkuRev[s.id]=0;bySkuCases[s.id]=0;});
  orders.forEach(o=>{
    const ac2 = DB.a('ac').find(a=>a.id===o.accountId);
    (o.items||[]).forEach(i=>{
      // i.qty = cases; price per case
      const pricePerCase = ac2?.pricing?.[i.sku]||(costs.cogs[i.sku]||2.15)*2.2*CANS_PER_CASE;
      bySkuRev[i.sku]   = (bySkuRev[i.sku]||0)   + pricePerCase * i.qty;
      bySkuCases[i.sku] = (bySkuCases[i.sku]||0) + i.qty;
    });
  });

  const rows = SKUS.map(s=>{
    const rev=bySkuRev[s.id]||0, cases=bySkuCases[s.id]||0;
    // COGS per can × cans = COGS per case × cases
    const cogs=(costs.cogs[s.id]||2.15)*cases*CANS_PER_CASE;
    const gp=rev-cogs, margin=rev>0?gp/rev:0;
    return [s.label, fmt(cases)+' cs', fmtC(rev), fmtC(cogs), fmtC(gp), fmt(margin*100,1)+'%'];
  });

  const totalRev  = Object.values(bySkuRev).reduce((a,b)=>a+b,0);
  const totalCogs = SKUS.reduce((s,sk)=>s+(costs.cogs[sk.id]||2.15)*((bySkuCases[sk.id]||0)*CANS_PER_CASE),0);
  const totalGP   = totalRev-totalCogs;
  const overhead  = costs.overhead_monthly||1200;

  _setKPIs(fmtC(totalRev), fmtC(totalGP), fmtC(totalGP-overhead), totalRev>0?fmt((totalGP/totalRev)*100,1)+'%':'—');

  _drawChart('bar',
    SKUS.map(s=>s.label),
    [
      {label:'Revenue', data:SKUS.map(s=>+(bySkuRev[s.id]||0).toFixed(2)), backgroundColor:'rgba(75,32,130,0.5)', borderRadius:4},
      {label:'Gross Profit', data:SKUS.map(s=>{ const qty=bySkuCases[s.id]||0; return +((bySkuRev[s.id]||0)-(costs.cogs[s.id]||2.15)*qty*CANS_PER_CASE).toFixed(2); }), backgroundColor:'rgba(0,180,100,0.7)', borderRadius:4},
    ],
    'Revenue vs Gross Profit by SKU'
  );

  _setTable(['SKU','Units','Revenue','COGS','Gross Profit','Margin'], rows, 'Gross Profit by SKU');
  _reportData = {headers:['SKU','Units','Revenue','COGS','Gross Profit','Margin'], rows};
}

// ── Helpers ────────────────────────────────────────────────
function _setKPIs(rev, qty, gp, margin) {
  if(qs('#rep-total-rev')) qs('#rep-total-rev').textContent = rev;
  if(qs('#rep-total-qty')) qs('#rep-total-qty').textContent = qty;
  if(qs('#rep-total-gp'))  qs('#rep-total-gp').textContent  = gp;
  if(qs('#rep-margin'))    qs('#rep-margin').textContent    = margin;
}

function _setTable(headers, rows, title) {
  const tt = qs('#rep-table-title');
  if (tt) tt.textContent = title;
  const th = qs('#rep-table-head');
  if (th) th.innerHTML = '<tr>'+headers.map(h=>`<th>${h}</th>`).join('')+'</tr>';
  const tb = qs('#rep-table-body');
  if (tb) tb.innerHTML = rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('') ||
    `<tr><td colspan="${headers.length}" class="empty">No data in selected range</td></tr>`;
}

// ── Export CSV ─────────────────────────────────────────────
function exportReportCSV() {
  if (!_reportData) return;
  const {from, to} = _repDateRange();
  const lines = [_reportData.headers.join(','), ..._reportData.rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(','))];
  const blob  = new Blob([lines.join('\n')], {type:'text/csv'});
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href = url; a.download = `purpl-report-${_reportType}-${from}-${to}.csv`;
  a.click(); URL.revokeObjectURL(url);
  toast('CSV downloaded');
}

// ── Year-End / Tax Export ──────────────────────────────────
function exportYearEnd() {
  const yr = qs('#rep-year-filter')?.value || String(new Date().getFullYear());
  const inYear = d => yr === 'all' ? true : (d||'').slice(0,4) === yr;
  const acLookup = Object.fromEntries(DB.a('ac').map(a => [a.id, a.name]));
  const rows = [];

  // purpl invoices (exclude those that are part of a combined invoice to avoid double-counting)
  DB.a('iv').filter(x => x.number && x.status === 'paid' && !x.combinedInvoiceId).forEach(x => {
    const pd = x.paidDate || '';
    if (!inYear(pd)) return;
    const acName = x.accountName || acLookup[x.accountId] || x.accountId || '—';
    rows.push([pd, x.number, 'purpl', acName, parseFloat(x.amount||0).toFixed(2), 'Invoice']);
  });

  // LF invoices (exclude those that are part of a combined invoice)
  DB.a('lf_invoices').filter(x => x.status === 'paid' && !x.combinedInvoiceId).forEach(x => {
    const pd = (x.paidAt||'').slice(0,10);
    if (!inYear(pd)) return;
    const acName = x.accountName || acLookup[x.accountId] || '—';
    rows.push([pd, x.number||'—', 'LF', acName, parseFloat(x.total||0).toFixed(2), 'Invoice']);
  });

  // Combined invoices → two rows each (purpl subtotal + LF subtotal)
  DB.a('combined_invoices').filter(x => x.status === 'paid').forEach(x => {
    const pd = (x.paidAt||'').slice(0,10);
    if (!inYear(pd)) return;
    const acName = x.accountName || acLookup[x.accountId] || '—';
    rows.push([pd, x.number, 'purpl', acName, parseFloat(x.purplSubtotal||0).toFixed(2), 'Combined - purpl']);
    rows.push([pd, x.number, 'LF',    acName, parseFloat(x.lfSubtotal||0).toFixed(2),    'Combined - LF']);
  });

  rows.sort((a, b) => a[0] > b[0] ? 1 : -1);

  const headers = ['Date Paid', 'Invoice #', 'Brand', 'Account', 'Amount', 'Type'];
  const lines = [headers.join(','), ...rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `purpl-year-end-${yr}-${today()}.csv`;
  a.click(); URL.revokeObjectURL(url);
  toast(`Year-end export downloaded — ${rows.length} records`);
}

// ── Save Report ────────────────────────────────────────────
function saveReport() {
  const {from, to} = _repDateRange();
  const name = prompt(`Name this report (${_reportType}, ${from} → ${to}):`);
  if (!name?.trim()) return;
  const rec = { id: uid(), name: name.trim(), type: _reportType, from, to, savedAt: today() };
  DB.push('saved_reports', rec);
  renderSavedReports();
  toast('Report saved');
}

function renderSavedReports() {
  const el = qs('#rep-saved-list');
  if (!el) return;
  const saved = DB.a('saved_reports');
  if (!saved.length) {
    el.innerHTML = '<span style="color:var(--muted);font-size:13px">No saved reports yet. Configure a report and click 💾 Save.</span>';
    return;
  }
  el.innerHTML = saved.map(r=>`
    <div style="display:inline-flex;align-items:center;gap:6px;background:var(--brand-purple-soft);border-radius:6px;padding:6px 10px;font-size:13px">
      <span style="cursor:pointer" onclick="loadSavedReport('${r.id}')"><strong>${r.name}</strong> <span style="color:var(--muted)">${r.type} · ${r.from} to ${r.to}</span></span>
      <span style="cursor:pointer;color:var(--muted);margin-left:4px" onclick="deleteSavedReport('${r.id}')">✕</span>
    </div>`).join('');
}

function loadSavedReport(id) {
  const r = DB.a('saved_reports').find(x=>x.id===id);
  if (!r) return;
  const fromEl = qs('#rep-date-from'), toEl = qs('#rep-date-to');
  if (fromEl) fromEl.value = r.from;
  if (toEl)   toEl.value   = r.to;
  _reportType = r.type;
  const tabs = qs('#rep-type-tabs');
  tabs?.querySelectorAll('.tab').forEach(t=>{ t.classList.toggle('active', t.dataset.rep===r.type); });
  renderReportContent();
}

function deleteSavedReport(id) {
  DB.remove('saved_reports', id);
  renderSavedReports();
}

// ══════════════════════════════════════════════════════════
//  LF REPORTS
// ══════════════════════════════════════════════════════════
function setLfRepPeriod(days) {
  _lfRepPeriod = days;
  qs('#lf-rep-period-btns')?.querySelectorAll('.ac-brand-btn').forEach(b=>{
    b.classList.toggle('active', +b.dataset.val === days);
  });
  renderLfReports();
}

function _lfRepCutoff() {
  if (!_lfRepPeriod) return null; // all time
  return new Date(Date.now() - _lfRepPeriod * 864e5).toISOString().slice(0,10);
}

function renderLfReports() {
  const cutoff = _lfRepCutoff();
  const invs = DB.a('lf_invoices').filter(inv => !cutoff || (inv.issued || inv.date || inv.created || '') >= cutoff);
  const paid = invs.filter(i => i.status === 'paid');
  const outstanding = invs.filter(i => i.status !== 'paid');

  // KPIs
  const totalRev = paid.reduce((s,i)=>s+(i.total||0),0);
  const totalUnits = paid.reduce((s,i)=>s+(i.lineItems||[]).reduce((ss,l)=>ss+(l.cases||0),0),0);
  const collected = paid.reduce((s,i)=>s+(i.total||0),0);
  const outstandingAmt = outstanding.reduce((s,i)=>s+(i.total||0),0);
  if (qs('#lf-rep-revenue'))     qs('#lf-rep-revenue').textContent     = fmtC(totalRev);
  if (qs('#lf-rep-units'))       qs('#lf-rep-units').textContent       = fmt(totalUnits);
  if (qs('#lf-rep-collected'))   qs('#lf-rep-collected').textContent   = fmtC(collected);
  if (qs('#lf-rep-outstanding')) qs('#lf-rep-outstanding').textContent = fmtC(outstandingAmt);

  // Revenue by SKU (from paid invoices)
  const skuMap = {};
  paid.forEach(inv=>{
    (inv.lineItems||[]).forEach(l=>{
      const key = l.skuName;
      if (!skuMap[key]) skuMap[key] = {cases:0, rev:0, variants:{}};
      if (l.hasVariants && l.variantLines?.length) {
        l.variantLines.forEach(vl=>{
          skuMap[key].cases += (vl.cases||0);
          skuMap[key].rev   += (vl.lineTotal||0);
          if (vl.variantName) {
            if (!skuMap[key].variants[vl.variantName]) skuMap[key].variants[vl.variantName] = {cases:0, rev:0};
            skuMap[key].variants[vl.variantName].cases += (vl.cases||0);
            skuMap[key].variants[vl.variantName].rev   += (vl.lineTotal||0);
          }
        });
      } else {
        skuMap[key].cases += (l.cases||0);
        skuMap[key].rev   += (l.lineTotal||0);
      }
    });
  });
  const skuRows = Object.entries(skuMap).sort((a,b)=>b[1].rev-a[1].rev);
  const skuTbody = qs('#lf-rep-sku-tbody');
  if (skuTbody) {
    skuTbody.innerHTML = skuRows.length
      ? skuRows.map(([name,d])=>{
          const varEntries = Object.entries(d.variants||{}).sort((a,b)=>b[1].rev-a[1].rev);
          const varHtml = varEntries.map(([vn,vd])=>
            `<tr><td style="padding-left:28px;color:var(--muted);font-size:12px">${escHtml(vn)}</td><td style="color:var(--muted);font-size:12px">${fmt(vd.cases)}</td><td style="color:var(--muted);font-size:12px">${fmtC(vd.rev)}</td></tr>`
          ).join('');
          return `<tr><td>${escHtml(name)}</td><td>${fmt(d.cases)}</td><td>${fmtC(d.rev)}</td></tr>${varHtml}`;
        }).join('')
      : '<tr><td colspan="3" style="color:var(--muted);text-align:center">No paid LF invoices in period</td></tr>';
  }

  // Orders by Account
  const acctMap = {};
  paid.forEach(inv=>{
    const name = inv.accountName || inv.accountId || '—';
    if (!acctMap[name]) acctMap[name] = {cases:0, rev:0};
    (inv.lineItems||[]).forEach(l=>{ acctMap[name].cases+=(l.cases||0); acctMap[name].rev+=(l.lineTotal||0); });
  });
  const acctRows = Object.entries(acctMap).sort((a,b)=>b[1].rev-a[1].rev);
  const acctTbody = qs('#lf-rep-accts-tbody');
  if (acctTbody) {
    acctTbody.innerHTML = acctRows.length
      ? acctRows.map(([name,d])=>`<tr><td>${escHtml(name)}</td><td>${fmt(d.cases)}</td><td>${fmtC(d.rev)}</td></tr>`).join('')
      : '<tr><td colspan="3" style="color:var(--muted);text-align:center">No paid invoices in period</td></tr>';
  }

  // Outstanding by Account
  const outTbody = qs('#lf-rep-out-tbody');
  if (outTbody) {
    const outRows = outstanding.sort((a,b)=>(a.dueDate||'')>(b.dueDate||'')?1:-1);
    outTbody.innerHTML = outRows.length
      ? outRows.map(i=>{
          const overdue = i.dueDate && i.dueDate < today();
          return `<tr>
            <td>${escHtml(i.accountName||'—')}</td>
            <td>${escHtml(i.number||i.invoiceNumber||'INV')}</td>
            <td style="${overdue?'color:var(--red);font-weight:600':''}">${fmtD(i.dueDate)}</td>
            <td>${fmtC(i.total||0)}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4" style="color:var(--muted);text-align:center">No outstanding invoices</td></tr>';
  }

  // Wix Deduction Log
  const wixTbody = qs('#lf-rep-wix-tbody');
  if (wixTbody) {
    const deductions = DB.a('lf_wix_deductions').filter(d => !cutoff || (d.date||'') >= cutoff)
                         .sort((a,b)=>(b.date||'')>(a.date||'')?1:-1);
    wixTbody.innerHTML = deductions.length
      ? deductions.flatMap(d=>{
          const items = d.items || [{skuName: d.skuName||'—', cases: d.cases||0}];
          return items.map((it,idx)=>`<tr>
            <td>${idx===0 ? fmtD(d.date) : ''}</td>
            <td>${idx===0 ? escHtml(d.runName||d.note||'—') : ''}</td>
            <td>${escHtml(it.skuName||'—')}</td>
            <td>${it.cases||0}</td>
            <td><span class="badge ${d.confirmed?'green':'amber'}" style="font-size:10px">${d.confirmed?'Confirmed':'Pending'}</span></td>
          </tr>`);
        }).join('')
      : '<tr><td colspan="5" style="color:var(--muted);text-align:center">No Wix deductions in period</td></tr>';
  }
}

function exportLfReportCSV(section) {
  let rows, headers, filename;
  const cutoff = _lfRepCutoff();
  const invs = DB.a('lf_invoices').filter(inv => !cutoff || (inv.issued || inv.date || inv.created || '') >= cutoff);
  const paid = invs.filter(i => i.status === 'paid');

  if (section === 'sku') {
    headers = ['SKU','Cases','Revenue'];
    const skuMap = {};
    paid.forEach(inv=>{ (inv.lineItems||[]).forEach(l=>{ if(!skuMap[l.skuName])skuMap[l.skuName]={cases:0,rev:0}; skuMap[l.skuName].cases+=(l.cases||0); skuMap[l.skuName].rev+=(l.lineTotal||0); }); });
    rows = Object.entries(skuMap).sort((a,b)=>b[1].rev-a[1].rev).map(([n,d])=>[n,d.cases,d.rev.toFixed(2)]);
    filename = 'lf-revenue-by-sku.csv';
  } else if (section === 'accounts') {
    headers = ['Account','Cases','Revenue'];
    const acctMap = {};
    paid.forEach(inv=>{ const name=inv.accountName||'—'; if(!acctMap[name])acctMap[name]={cases:0,rev:0}; (inv.lineItems||[]).forEach(l=>{acctMap[name].cases+=(l.cases||0);acctMap[name].rev+=(l.lineTotal||0);}); });
    rows = Object.entries(acctMap).sort((a,b)=>b[1].rev-a[1].rev).map(([n,d])=>[n,d.cases,d.rev.toFixed(2)]);
    filename = 'lf-orders-by-account.csv';
  } else if (section === 'outstanding') {
    headers = ['Account','Invoice','Due Date','Amount'];
    rows = invs.filter(i=>i.status!=='paid').map(i=>[i.accountName||'—', i.number||i.invoiceNumber||'', i.dueDate||'', (i.total||0).toFixed(2)]);
    filename = 'lf-outstanding.csv';
  } else if (section === 'wix') {
    headers = ['Date','Run','SKU','Cases','Status'];
    rows = DB.a('lf_wix_deductions').filter(d=>!cutoff||(d.date||'')>=cutoff)
      .flatMap(d=>{ const items=d.items||[{skuName:d.skuName||'—',cases:d.cases||0}]; return items.map(it=>[d.date||'',d.runName||d.note||'—',it.skuName||'—',it.cases||0,d.confirmed?'Confirmed':'Pending']); });
    filename = 'lf-wix-deductions.csv';
  } else return;

  const csv = [headers, ...rows].map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = filename;
  a.click();
}

// ══════════════════════════════════════════════════════════
//  INTEGRATIONS — Phase 8: Local Line
// ══════════════════════════════════════════════════════════
function renderIntegrations() {
  // Load webhook URL from settings if saved
  const settings = DB.obj('settings', {});
  const urlInput = qs('#zapier-url-input');
  if (urlInput && settings.zapierWebhookUrl) urlInput.value = settings.zapierWebhookUrl;
  const urlDisplay = qs('#zapier-webhook-url');
  if (urlDisplay && settings.zapierWebhookUrl) urlDisplay.textContent = settings.zapierWebhookUrl;
  _renderLLImportHistory();
}

function saveWebhookUrl() {
  const url = qs('#zapier-url-input')?.value?.trim();
  if (!url) { toast('Paste a URL first'); return; }
  const settings = DB.obj('settings',{});
  DB.setObj('settings', {...settings, zapierWebhookUrl: url});
  const display = qs('#zapier-webhook-url');
  if (display) display.textContent = url;
  toast('Webhook URL saved');
}

// ── Local Line CSV Import (Phase 8.1) ─────────────────────
// Expected Local Line CSV columns (flexible auto-detect):
//   Order ID/Number, Customer/Buyer/Account, Product, Variant, Qty/Quantity,
//   Unit Price/Price, Total, Status, Date/Order Date

const LL_COLUMN_MAP = {
  orderId:    ['order id','order number','order #','#'],
  buyer:      ['customer','buyer','account','company','name','customer name'],
  product:    ['product','item','product name'],
  variant:    ['variant','sku','size','format'],
  qty:        ['qty','quantity','ordered','units'],
  unitPrice:  ['unit price','price','unit cost'],
  total:      ['total','order total','subtotal'],
  status:     ['status','order status'],
  date:       ['date','order date','created','created at','placed'],
};

let _llParsedRows = [];

function handleLLCSV(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => _parseLLCSV(e.target.result);
  reader.readAsText(file);
}

function _parseLLCSV(text) {
  const lines = text.trim().split('\n').filter(l=>l.trim());
  if (lines.length < 2) { toast('CSV appears empty'); return; }

  // Parse CSV respecting quoted fields
  const parseRow = line => {
    const result=[]; let cur='', inQ=false;
    for(let i=0;i<line.length;i++){
      const ch=line[i];
      if(ch==='"'&&!inQ){inQ=true;}
      else if(ch==='"'&&inQ&&line[i+1]==='"'){cur+='"';i++;}
      else if(ch==='"'&&inQ){inQ=false;}
      else if(ch===','&&!inQ){result.push(cur.trim());cur='';}
      else{cur+=ch;}
    }
    result.push(cur.trim());
    return result;
  };

  const headers = parseRow(lines[0]).map(h=>h.toLowerCase().replace(/['"]/g,'').trim());
  const dataRows = lines.slice(1).map(l=>parseRow(l));

  // Auto-detect column indices
  const colIdx = {};
  Object.entries(LL_COLUMN_MAP).forEach(([key, candidates])=>{
    for(const cand of candidates) {
      const idx = headers.findIndex(h=>h.includes(cand));
      if(idx>=0){ colIdx[key]=idx; break; }
    }
  });

  const get = (row, key) => (colIdx[key]!==undefined ? (row[colIdx[key]]||'').trim() : '');

  _llParsedRows = dataRows.map((row,i)=>({
    _rowNum: i+2,
    orderId:   get(row,'orderId'),
    buyer:     get(row,'buyer'),
    product:   get(row,'product'),
    variant:   get(row,'variant'),
    qty:       parseFloat(get(row,'qty'))||0,
    unitPrice: parseFloat(get(row,'unitPrice').replace(/[$,]/g,''))||0,
    total:     parseFloat(get(row,'total').replace(/[$,]/g,''))||0,
    status:    get(row,'status')||'pending',
    date:      get(row,'date')||today(),
  })).filter(r=>r.buyer||r.orderId);

  // Group rows by order ID (or buyer+date)
  const grouped = {};
  _llParsedRows.forEach(r=>{
    const key = r.orderId || `${r.buyer}-${r.date}`;
    if(!grouped[key]) grouped[key]={...r, items:[]};
    if(r.product) grouped[key].items.push({product:r.product, variant:r.variant, qty:r.qty, unitPrice:r.unitPrice});
    grouped[key].total = (grouped[key].total||0) || r.total;
  });
  const orders = Object.values(grouped);

  // Preview
  const preview = qs('#ll-preview');
  const countEl = qs('#ll-preview-count');
  const head    = qs('#ll-preview-head');
  const tbody   = qs('#ll-preview-body');
  if (!preview) return;

  preview.style.display = '';
  if (countEl) countEl.textContent = `${orders.length} order${orders.length!==1?'s':''} detected`;
  if (head) head.innerHTML = '<tr><th>Buyer</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th></tr>';
  if (tbody) tbody.innerHTML = orders.map(o=>`<tr>
    <td><strong>${o.buyer||'Unknown'}</strong></td>
    <td>${o.date}</td>
    <td>${o.items.map(i=>`${i.product}${i.variant?' ('+i.variant+')':''} ×${i.qty}`).join(', ')||'—'}</td>
    <td>${fmtC(o.total||o.items.reduce((s,i)=>s+i.unitPrice*i.qty,0))}</td>
    <td><span class="badge ${o.status.includes('complet')||o.status.includes('deliver')?'green':o.status.includes('cancel')?'red':'amber'}">${o.status}</span></td>
  </tr>`).join('') || '<tr><td colspan="5" class="empty">No orders detected</td></tr>';

  const importBtn = qs('#ll-import-btn');
  if (importBtn) importBtn.onclick = ()=>importLLOrders(orders);
  const msgEl = qs('#ll-import-msg');
  if (msgEl) msgEl.textContent = `Columns detected: ${Object.entries(colIdx).map(([k,i])=>`${k}=col${i+1}`).join(', ')}`;
}

function importLLOrders(orders) {
  let newAccounts=0, newOrders=0, skipped=0;
  const existingOrders = DB.a('orders');

  orders.forEach(o=>{
    // Find or create account
    let acct = DB.a('ac').find(a=>a.name.toLowerCase()===o.buyer.toLowerCase());
    if (!acct) {
      acct = {id:uid(), name:o.buyer, status:'active', type:'retail', source:'Local Line Import', created:today(), notes:[], outreach:[], pricing:{}};
      DB.push('ac', acct);
      newAccounts++;
    }

    // Detect duplicate
    const isDup = existingOrders.some(ex=>ex.accountId===acct.id && ex.created===o.date && ex.source==='local_line' && ex.externalId===o.orderId);
    if (isDup) { skipped++; return; }

    // Map product name → SKU (fuzzy)
    const mapSku = (product, variant)=>{
      const p = (product+' '+(variant||'')).toLowerCase();
      if(p.includes('blueberry')) return 'blueberry';
      if(p.includes('peach'))     return 'peach';
      if(p.includes('raspberry')) return 'raspberry';
      if(p.includes('variety'))   return 'variety';
      return 'classic'; // default
    };

    // items.qty = cases (imported quantity treated as cases)
    const items = o.items.map(i=>({sku:mapSku(i.product,i.variant), qty:i.qty||1}));
    const canCount = items.reduce((s,i)=>s + i.qty * CANS_PER_CASE, 0);
    const ord = {
      id:uid(), accountId:acct.id, created:o.date, dueDate:o.date,
      status: o.status.toLowerCase().includes('complet')||o.status.toLowerCase().includes('deliver') ? 'delivered' : 'pending',
      items, canCount, source:'local_line', externalId:o.orderId||'', importedAt:today(),
    };
    DB.push('orders', ord);
    newOrders++;
  });

  // Log import
  DB.push('saved_reports', {id:uid(), name:`LL Import ${today()}`, type:'ll_import', from:today(), to:today(), savedAt:today(), meta:`${newOrders} orders, ${newAccounts} new accounts, ${skipped} skipped`});

  const msgEl = qs('#ll-import-msg');
  if (msgEl) msgEl.textContent = `✓ Imported: ${newOrders} orders, ${newAccounts} new accounts. ${skipped} duplicates skipped.`;
  _renderLLImportHistory();
  toast(`Imported ${newOrders} orders from Local Line`);
}

function _renderLLImportHistory() {
  const el = qs('#ll-import-history');
  if (!el) return;
  const imports = DB.a('saved_reports').filter(r=>r.type==='ll_import').slice().sort((a,b)=>b.savedAt>a.savedAt?1:-1);
  if (!imports.length) { el.innerHTML = '<div class="empty" style="font-size:13px">No imports yet</div>'; return; }
  el.innerHTML = imports.map(r=>`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">
      <span><strong>${r.name}</strong> &nbsp;<span style="color:var(--muted)">${r.meta||''}</span></span>
      <button class="btn xs red" onclick="deleteLLImportLog('${r.id}')">✕</button>
    </div>`).join('');
}

function deleteLLImportLog(id) {
  DB.remove('saved_reports', id);
  _renderLLImportHistory();
}

// ══════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════
function renderSettings() {
  const s = DB.obj('settings', {});
  const c = DB.obj('costs', {cogs:{},overhead_monthly:1200,target_margin:.6});

  // Company
  if(qs('#set-company'))            qs('#set-company').value            = s.company||'';
  if(qs('#set-payment-terms'))     qs('#set-payment-terms').value     = s.payment_terms||30;
  if(qs('#set-lead-time'))         qs('#set-lead-time').value         = s.production_lead_time||14;
  if(qs('#set-low-inv-threshold')) qs('#set-low-inv-threshold').value = s.lowStockThreshold||500;
  if(qs('#set-mpg'))              qs('#set-mpg').value              = s.mpg||25;
  if(qs('#set-gas-price'))        qs('#set-gas-price').value        = s.gasPrice||3.50;

  // COGS
  SKUS.forEach(sk=>{
    if(qs('#cost-'+sk.id)) qs('#cost-'+sk.id).value = c.cogs?.[sk.id]||'';
  });
  if(qs('#cost-overhead'))      qs('#cost-overhead').value      = c.overhead_monthly||1200;
  if(qs('#cost-target-margin')) qs('#cost-target-margin').value = (c.target_margin||.6)*100;

  // Territory defaults
  if(qs('#set-default-state'))        qs('#set-default-state').value        = s.default_state||'';
  if(qs('#set-default-account-type')) qs('#set-default-account-type').value = s.default_account_type||'Grocery';
  if(qs('#set-default-terms'))        qs('#set-default-terms').value        = s.default_payment_terms||30;

  // Units info panel — update display
  if(qs('#set-cans-per-case')) qs('#set-cans-per-case').textContent = CANS_PER_CASE;

  // Variety pack recipe
  const recipe = s.variety_recipe || {};
  const recipeEl = qs('#set-variety-recipe');
  if (recipeEl) {
    recipeEl.innerHTML = SKUS.filter(sk=>sk.id!=='variety').map(sk=>`
      <div style="display:flex;align-items:center;gap:10px">
        ${skuBadge(sk.id)}
        <input type="number" id="variety-recipe-${sk.id}" value="${recipe[sk.id]||0}" min="0" max="${CANS_PER_CASE}" step="1" style="width:70px" oninput="_updateVarietyTotal()">
        <span style="font-size:12px;color:var(--muted)">cans</span>
      </div>`).join('');
    _updateVarietyTotal();
  }

  // Trade show import button — hide once import has run
  const tsBtn = qs('#tradeshow-import-card');
  if (tsBtn) tsBtn.style.display = s.tradeshow_2026_imported ? 'none' : '';
  // NEM show accounts import button — hide once import has run
  const nemBtn = qs('#nem-import-card');
  if (nemBtn) nemBtn.style.display = s.nem_show_2026_imported ? 'none' : '';

  // User list (read-only — show known signed-in users from settings)
  const usersEl = qs('#set-users-list');
  if (usersEl && s.known_users?.length) {
    usersEl.innerHTML = `<div class="tbl-wrap"><table>
      <thead><tr><th>Email / Name</th><th>Last Seen</th><th>Provider</th></tr></thead>
      <tbody>${s.known_users.map(u=>`<tr>
        <td>${u.email||u.displayName||u.uid}</td>
        <td>${u.lastSeen?fmtD(u.lastSeen):'—'}</td>
        <td><span class="badge gray">${u.provider||'email'}</span></td>
      </tr>`).join('')}</tbody>
    </table></div>`;
  }

  // LF SKU catalog
  renderLfSkuSettings();
}

function _updateVarietyTotal() {
  const total = SKUS.filter(sk=>sk.id!=='variety')
    .reduce((s,sk)=>s+(parseInt(qs('#variety-recipe-'+sk.id)?.value)||0), 0);
  const el = qs('#set-variety-total');
  if (!el) return;
  const ok = total === CANS_PER_CASE;
  el.innerHTML = `Total: <strong style="color:${ok?'var(--green)':'var(--red)'}">${total} / ${CANS_PER_CASE} cans</strong>${ok?' ✓':' (must equal '+CANS_PER_CASE+')'}`;
}

function saveSettings() {
  // Variety pack recipe validation
  const recipe = {};
  let recipeTotal = 0;
  SKUS.filter(sk=>sk.id!=='variety').forEach(sk=>{
    const v = parseInt(qs('#variety-recipe-'+sk.id)?.value)||0;
    recipe[sk.id] = v;
    recipeTotal += v;
  });
  if (recipeTotal > 0 && recipeTotal !== CANS_PER_CASE) {
    toast(`Variety recipe must total ${CANS_PER_CASE} cans (currently ${recipeTotal})`);
    return;
  }

  const s = {
    company:               qs('#set-company')?.value?.trim()||'',
    payment_terms:         parseInt(qs('#set-payment-terms')?.value)||30,
    production_lead_time:  parseInt(qs('#set-lead-time')?.value)||14,
    default_state:         qs('#set-default-state')?.value?.trim()||'',
    default_account_type:  qs('#set-default-account-type')?.value||'Grocery',
    default_payment_terms: parseInt(qs('#set-default-terms')?.value)||30,
    variety_recipe:        recipeTotal === CANS_PER_CASE ? recipe : (DB.obj('settings',{}).variety_recipe||{}),
    lowStockThreshold:       parseInt(qs('#set-low-inv-threshold')?.value)||500,
    mpg:                   parseFloat(qs('#set-mpg')?.value)||25,
    gasPrice:              parseFloat(qs('#set-gas-price')?.value)||3.50,
    // Preserve existing fields (known_users etc.)
    ...Object.fromEntries(
      Object.entries(DB.obj('settings',{})).filter(([k])=>!['company','payment_terms','production_lead_time','default_state','default_account_type','default_payment_terms','variety_recipe','lowStockThreshold','mpg','gasPrice'].includes(k))
    ),
  };
  DB.setObj('settings', s);

  const cogs = {};
  SKUS.forEach(sk=>{ cogs[sk.id]=parseFloat(qs('#cost-'+sk.id)?.value)||2.15; });
  const c = {
    cogs,
    overhead_monthly: parseFloat(qs('#cost-overhead')?.value)||1200,
    target_margin:    (parseFloat(qs('#cost-target-margin')?.value)||60)/100,
  };
  DB.setObj('costs', c);
  toast('Settings saved');
}


// ══════════════════════════════════════════════════════════
//  MODAL HELPERS
// ══════════════════════════════════════════════════════════
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('open');
}
function closeModal(id) {
  const m = id ? document.getElementById(id) : null;
  if (m) { m.classList.remove('open'); return; }
  // Close all modals
  document.querySelectorAll('.overlay').forEach(o=>o.classList.remove('open'));
}

function qs(sel) { return document.querySelector(sel); }

// ── Wire filter/search controls ──────────────────────────
function setupFilters() {
  // Accounts
  ['#ac-search','#ac-type-filter','#ac-brand-filter','#ac-fulfill-filter','#ac-sort'].forEach(sel=>{
    const el = qs(sel);
    if (el) el.addEventListener('input', renderAccounts);
  });
  // Prospects
  ['#pr-search','#pr-stage-filter','#pr-brand-filter','#pr-sort'].forEach(sel=>{
    const el = qs(sel);
    if (el) el.addEventListener('input', renderProspects);
  });
  // Distributors
  ['#dist-search','#dist-status-filter'].forEach(sel=>{
    const el = qs(sel);
    if (el) el.addEventListener('input', renderDistributors);
  });
  // Projections velocity window
  const projVelSrc = qs('#proj-velocity-source');
  if (projVelSrc) projVelSrc.addEventListener('change', renderProjectionsPage);
  // Global search (also feeds accounts)
  const gs = qs('#global-search');
  if (gs) gs.addEventListener('input', ()=>{
    const q = gs.value.toLowerCase().trim();
    if (currentPage==='accounts') {
      const inp = qs('#ac-search');
      if (inp) { inp.value=q; renderAccounts(); }
    }
  });
}

// ══════════════════════════════════════════════════════════
//  DATA RESTORE  (one-time auto-migration on deploy;
//                 restores the 16 accounts + 14 prospects
//                 wiped by the March 2026 seed-overwrite bug)
// ══════════════════════════════════════════════════════════
function restoreMyData() {
  // SAFETY: never run before Firestore confirms data is loaded.
  // The 10s startup timeout can fire before the snapshot arrives — without
  // this guard, restoreMyData would see an empty cache and overwrite real data.
  if (!DB._firestoreReady) return;
  // Already done — skip
  if (DB.obj('settings',{}).data_restored) return;

  const mkId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

  const ACCOUNTS = [
    {id:mkId(),name:'GoodVibes Gift Shop',type:'Specialty / Gift',contact:'Rebecca',phone:'',email:'4goodvibessomerville@gmail.com',address:'',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'Drop off at Medford Location * See Contract for Details',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-02-26',text:'Uses service Consigner Access. Interested in purpl.',author:'you',nextAction:'',nextDate:''}],outreach:[{id:mkId(),type:'Email',date:'2026-02-26',note:''}],lastOrder:null,lastContacted:'2026-02-26'},
    {id:mkId(),name:'Artisans New London',type:'Specialty / Gift',contact:'Amy and Macy',phone:'603-526-4227',email:'info@artisansnewlondon.com',address:'11 South Pleasant St, New London, NH',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[],outreach:[{id:mkId(),type:'Email',date:'2025-12-11',note:''}],lastOrder:null,lastContacted:'2025-12-11'},
    {id:mkId(),name:'Barrel and Baskit',type:'Café',contact:'Beth',phone:'603-340-2488',email:'beth@localbaskit.com',address:'',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[],outreach:[],lastOrder:'2026-02-01',lastContacted:null},
    {id:mkId(),name:'Calefs Country Store',type:'Farm / Country Store',contact:'Melanie Giehl',phone:'800-462-2118',email:'melanie@calefs.com',address:'606 Franklin Pierce Highway, Barrington, NH',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[],outreach:[{id:mkId(),type:'Email',date:'2025-11-12',note:''}],lastOrder:null,lastContacted:'2025-11-12'},
    {id:mkId(),name:'Dry Celler',type:'Specialty / Gift',contact:'Kate Boyle',phone:'',email:'',address:'',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-09',text:'NA store. Maybe market as mixer botanical.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:null},
    {id:mkId(),name:'Gilford Country Store',type:'Specialty / Gift',contact:'Kathy',phone:'603-366-6250',email:'gilfordcountrystore@gmail.com',address:'1934 Lake Shore Rd, Gilford, NH',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-01-14',text:'Interested in purpl. Order for PBF too.',author:'you',nextAction:'',nextDate:''}],outreach:[{id:mkId(),type:'Email',date:'2026-01-14',note:''}],lastOrder:'2025-09-19',lastContacted:'2026-01-14'},
    {id:mkId(),name:'Goffstown Green Thumb',type:'Farm / Country Store',contact:'Jennifer Conroy',phone:'603-497-3131',email:'goffstowngreenthumbgc@gmail.com',address:'278 Mast Road, Goffstown, NH 03045',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-01-29',text:'Interested in purpl.',author:'you',nextAction:'',nextDate:''}],outreach:[{id:mkId(),type:'Email',date:'2026-01-29',note:''}],lastOrder:'2026-01-29',lastContacted:'2026-01-29'},
    {id:mkId(),name:'Granite State Naturals',type:'Grocery',contact:'Robin',phone:'603-224-9341',email:'robin@granitestatenaturals.com',address:'170 North State Street, Concord, NH 03301',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2025-11-25',text:'Has space for purpl.',author:'you',nextAction:'',nextDate:''}],outreach:[{id:mkId(),type:'Email',date:'2025-11-25',note:''}],lastOrder:null,lastContacted:'2025-11-25'},
    {id:mkId(),name:'Green Envy',type:'Specialty / Gift',contact:'Helen Ryba',phone:'603-722-3885',email:'Info@greenenvywellness.com',address:'377 Elm Street, Manchester, NH 03104',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[],outreach:[{id:mkId(),type:'Email',date:'2026-01-07',note:''}],lastOrder:'2026-01-07',lastContacted:'2026-01-07'},
    {id:mkId(),name:'Lavender Fields at Pumpkin Blossom Farm',type:'Other',contact:'',phone:'',email:'',address:'393 Pumpkin Hill Rd, Warner, NH',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[],outreach:[],lastOrder:null,lastContacted:null},
    {id:mkId(),name:'Little Red Hen Farm and Market',type:'Farm / Country Store',contact:'Jill Fudala',phone:'603-568-5540',email:'',address:'',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[],outreach:[{id:mkId(),type:'Email',date:'2026-01-27',note:''}],lastOrder:null,lastContacted:'2026-01-27'},
    {id:mkId(),name:'Littleton Co Op',type:'Co-op',contact:'Rebecka Daniels',phone:'',email:'rdaniels@littletoncoop.org',address:'43 Bethlehem Road, Littleton, NH 03561',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-02-25',text:'PBF customer.',author:'you',nextAction:'',nextDate:''}],outreach:[{id:mkId(),type:'Email',date:'2026-02-25',note:''}],lastOrder:null,lastContacted:'2026-02-25'},
    {id:mkId(),name:'Something Wonderful Shop',type:'Specialty / Gift',contact:'Kristin',phone:'603-722-3885',email:'Somethingwonderfulshop@gmail.com',address:'5326 Vermont Route 14, Sharon, VT 05065',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-01-08',text:'Interested in Purpl.',author:'you',nextAction:'',nextDate:''}],outreach:[{id:mkId(),type:'Email',date:'2026-01-08',note:''}],lastOrder:'2026-01-08',lastContacted:'2026-01-08'},
    {id:mkId(),name:'Sunapee Cellar and Pantry',type:'Specialty / Gift',contact:'Julie Woodworth',phone:'802-236-4695',email:'',address:'',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[],outreach:[],lastOrder:null,lastContacted:null},
    {id:mkId(),name:'Sweet Beet Market',type:'Co-op',contact:'Cassie',phone:'603-938-5323',email:'cassie@kearsargefoodhub.org',address:'11 West Main St, Bradford, NH',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-02-25',text:'Reach out for first purpl order.',author:'you',nextAction:'',nextDate:''}],outreach:[{id:mkId(),type:'Email',date:'2026-02-25',note:'interested'}],lastOrder:'2026-01-20',lastContacted:'2026-02-25'},
    {id:mkId(),name:'Zebs General Store',type:'Specialty / Gift',contact:'Ray',phone:'',email:'shop@zebs.com',address:'North Conway, NH',lat:null,lng:null,territory:'',status:'active',since:'',dropOffRules:'',skus:[],par:{},pricing:{},notes:[],outreach:[{id:mkId(),type:'Email',date:'2025-09-06',note:''}],lastOrder:null,lastContacted:'2025-09-06'},
  ];

  const PROSPECTS = [
    {id:mkId(),name:'Tip Top Co Op',type:'Co-op / Natural',contact:'Lisa Boragine',phone:'508-867-0460',email:'tiptopbrookfield@icloud.com',address:'8 Central Street, Brookfield, MA',lat:null,lng:null,territory:'',status:'contacted',priority:'medium',source:'migrated from v5',lastContact:'2026-02-27',nextDate:'2026-03-21',nextAction:'Member meeting March 28th — need samples before then.',notes:[{id:mkId(),date:'2026-02-27',text:'Need samples for both brands.',author:'you',nextAction:'Member meeting March 28th — need samples before then.',nextDate:'2026-03-21'}],outreach:[]},
    {id:mkId(),name:'Lavender Sense Relaxation Retreat',type:'Spa / Wellness',contact:'Jen (Owner)',phone:'',email:'jen@lavendersenseretreat.com',address:'Alton Bay, NH',lat:null,lng:null,territory:'',status:'contacted',priority:'medium',source:'migrated from v5',lastContact:'2026-02-26',nextDate:'',nextAction:'Interested in purpl when launch.',notes:[{id:mkId(),date:'2026-02-26',text:'PBF sign up.',author:'you',nextAction:'Interested in purpl when launch.',nextDate:''}],outreach:[]},
    {id:mkId(),name:'Franklin Community Co Op',type:'Co-op / Natural',contact:'',phone:'',email:'',address:'',lat:null,lng:null,territory:'',status:'lead',priority:'medium',source:'migrated from v5',lastContact:'2026-02-26',nextDate:'',nextAction:'Get in contact.',notes:[{id:mkId(),date:'2026-02-26',text:'Max Barnett — Wellness Buyer — sent cold about PBF. Wendi Byther — Grocery Buyer — About purpl.',author:'you',nextAction:'Get in contact.',nextDate:''}],outreach:[{id:mkId(),type:'Email',date:'2026-02-26',note:'Filled out contact form specific for grocery buyer'}]},
    {id:mkId(),name:'The Local Grocer',type:'Co-op / Natural',contact:'Alexandria Small',phone:'603-356-6068',email:'alexandria@nhlocalgrocer.com',address:'3358 White Mountain Highway, Conway, NH 03860',lat:null,lng:null,territory:'',status:'lead',priority:'high',source:'migrated from v5',lastContact:'2026-02-26',nextDate:'',nextAction:'Sample meeting with Alexandria and owners + purpl buyer.',notes:[{id:mkId(),date:'2026-02-26',text:'',author:'you',nextAction:'Sample meeting with Alexandria and owners + purpl buyer.',nextDate:''}],outreach:[]},
    {id:mkId(),name:'Wegmans',type:'Grocery',contact:'Melissa',phone:'',email:'',address:'',lat:null,lng:null,territory:'',status:'contacted',priority:'high',source:'migrated from v5',lastContact:'2026-02-25',nextDate:'2026-03-04',nextAction:'Wait to hear anything.',notes:[{id:mkId(),date:'2026-02-25',text:'Email sent to Melissa introducing purpl, asking for correct buyer.',author:'you',nextAction:'Wait to hear anything.',nextDate:'2026-03-04'}],outreach:[{id:mkId(),type:'Email',date:'2026-02-25',note:'Expressed interest. Sent information to VP and category manager.'}]},
    {id:mkId(),name:'Concord Co Op',type:'Co-op / Natural',contact:'Rianna',phone:'',email:'Rianna@concordfoodcoop.coop',address:'24 1/2 S Main St, Concord, NH',lat:null,lng:null,territory:'',status:'contacted',priority:'high',source:'migrated from v5',lastContact:'2026-02-25',nextDate:'2026-03-04',nextAction:'Get in contact with buyer.',notes:[{id:mkId(),date:'2026-02-25',text:'Spoke to Autumn from the bakery. Gave me buyer contact. Both PBF and Purpl.',author:'you',nextAction:'Get in contact with buyer.',nextDate:'2026-03-04'}],outreach:[]},
    {id:mkId(),name:'Common Man Roadsides',type:'Convenience',contact:'Ashley (Bev Manager)',phone:'',email:'ashley@thecman.com',address:'',lat:null,lng:null,territory:'',status:'contacted',priority:'medium',source:'migrated from v5',lastContact:'2026-02-19',nextDate:'2026-03-05',nextAction:'',notes:[{id:mkId(),date:'2026-02-19',text:'Got contact from Christine at home office.',author:'you',nextAction:'',nextDate:'2026-03-05'}],outreach:[]},
    {id:mkId(),name:'Assabet Co Op Market',type:'Co-op / Natural',contact:'Dawn (Buyer)',phone:'978-243-8374',email:'vendor@assabetmarket.coop',address:'86 Powder Mill Road, Maynard, MA 01754',lat:null,lng:null,territory:'',status:'contacted',priority:'medium',source:'migrated from v5',lastContact:'2026-02-18',nextDate:'2026-03-18',nextAction:'Get in contact with Dawn or another buyer for purpl.',notes:[{id:mkId(),date:'2026-02-18',text:'Referred from general inquiries email. Pitched both brands.',author:'you',nextAction:'Get in contact with Dawn or another buyer for purpl.',nextDate:'2026-03-18'}],outreach:[]},
    {id:mkId(),name:'Hannafords',type:'Grocery',contact:'',phone:'',email:'',address:'',lat:null,lng:null,territory:'',status:'contacted',priority:'medium',source:'migrated from v5',lastContact:'2026-02-17',nextDate:'',nextAction:'',notes:[{id:mkId(),date:'2026-02-17',text:'Local application resubmitted.',author:'you',nextAction:'',nextDate:''}],outreach:[]},
    {id:mkId(),name:'Rutland Co Op',type:'Co-op / Natural',contact:'Heather Sevrie',phone:'802-773-0737',email:'wellness@rutlandcoop.com',address:'77 Wales Street, Rutland, VT 05701',lat:null,lng:null,territory:'',status:'sampling',priority:'medium',source:'migrated from v5',lastContact:'2026-02-09',nextDate:'2026-02-27',nextAction:'Reach back out for first order.',notes:[{id:mkId(),date:'2026-02-09',text:'Dropped off PBF samples, met Heather, interested in Purpl when launching.',author:'you',nextAction:'Reach back out for first order.',nextDate:'2026-02-27'}],outreach:[]},
    {id:mkId(),name:'Co Op Food Stores',type:'Co-op / Natural',contact:'Caitlin Woodbury',phone:'',email:'president@coopfoodstore.com',address:'',lat:null,lng:null,territory:'',status:'sampling',priority:'high',source:'migrated from v5',lastContact:'2026-02-09',nextDate:'',nextAction:'Wait for reply. Push purpl when update.',notes:[{id:mkId(),date:'2026-02-09',text:'Submitted PBF samples + coming soon purpl sheet.',author:'you',nextAction:'Wait for reply. Push purpl when update.',nextDate:''}],outreach:[]},
    {id:mkId(),name:'Monadnock Food Co Op',type:'Co-op / Natural',contact:'Kalliope Kalombratsos',phone:'603-355-8008',email:'superwellness@monadnockfood.coop',address:'34 Cypress Street, Keene, NH 03431',lat:null,lng:null,territory:'',status:'contacted',priority:'high',source:'migrated from v5',lastContact:'2026-01-19',nextDate:'',nextAction:'Need to follow up and reach out for new contact in correct category.',notes:[{id:mkId(),date:'2026-01-19',text:'Current PBF retailer.',author:'you',nextAction:'Need to follow up and reach out for new contact in correct category.',nextDate:''}],outreach:[]},
    {id:mkId(),name:'Newberry Deli',type:'Café',contact:'Jay',phone:'',email:'',address:'',lat:null,lng:null,territory:'',status:'contacted',priority:'medium',source:'migrated from v5',lastContact:'',nextDate:'',nextAction:'Purpl reach out.',notes:[{id:mkId(),date:'2026-03-09',text:'',author:'you',nextAction:'Purpl reach out.',nextDate:''}],outreach:[]},
    {id:mkId(),name:'Northeast Shared Services',type:'Grocery',contact:'Maisy',phone:'',email:'',address:'',lat:null,lng:null,territory:'',status:'negotiating',priority:'high',source:'migrated from v5',lastContact:'',nextDate:'2026-03-04',nextAction:'',notes:[{id:mkId(),date:'2026-03-09',text:'Key distribution partner covering Price Chopper / Market 32 and Tops Markets.',author:'you',nextAction:'',nextDate:'2026-03-04'}],outreach:[]},
  ];

  // Demo account/prospect names seeded by the bug — remove them
  const DEMO_AC = new Set(['whole foods market – oak park','mariano\'s – lincoln square','central gym & fitness','sunrise café']);
  const DEMO_PR = new Set(['green earth market','fitzzone studios']);

  const realAcNames = new Set(ACCOUNTS.map(x=>x.name.toLowerCase().trim()));
  const realPrNames = new Set(PROSPECTS.map(x=>x.name.toLowerCase().trim()));

  // Keep any accounts that aren't demo placeholders and aren't in our restore list (user may have added others)
  const kept = DB.a('ac').filter(x=>!DEMO_AC.has(x.name.toLowerCase().trim())&&!realAcNames.has(x.name.toLowerCase().trim()));
  const keptPr = DB.a('pr').filter(x=>!DEMO_PR.has(x.name.toLowerCase().trim())&&!realPrNames.has(x.name.toLowerCase().trim()));

  const newAc = [...kept, ...ACCOUNTS];
  const newPr = [...keptPr, ...PROSPECTS];

  DB.atomicUpdate(cache=>{
    cache.ac = newAc;
    cache.pr = newPr;
    cache.settings = {...(cache.settings||{}), data_restored: true, seeded: true};
    return cache;
  });

  console.log(`[restore] ${ACCOUNTS.length} accounts + ${PROSPECTS.length} prospects restored.`);
}

// ══════════════════════════════════════════════════════════
//  TRADE SHOW IMPORT (one-time, 2026 spring show)
// ══════════════════════════════════════════════════════════
function importTradeShowProspects() {
  if (!DB._firestoreReady) { toast('⚠️ Database not ready yet — please wait a moment and try again.'); return; }
  if (!confirm('Import 34 trade show prospects? Duplicates will be skipped.')) return;

  const TODAY = today();
  const mk = () => uid();
  const RECORDS = [
    {name:'Oropa',contact:'Sandra Meiggs',phone:'508-207-5442',email:'oropaduxbury@gmail.com',address:'35B Depot Street, Duxbury, MA',type:'Specialty / Gift'},
    {name:'Lubec Coastal Gifts',contact:'',phone:'207-733-4484',email:'lubecgifts@gmail.com',address:'20 Water Street, Lubec, ME',type:'Specialty / Gift'},
    {name:'Ellie Anna Gift Shop',contact:'Sarah Legare',phone:'',email:'sarahlegare@hotmail.com',address:'785 Main St, Lewiston, ME',type:'Specialty / Gift'},
    {name:'Artemisia Botanicals',contact:'Meghan and Teri Kalgren',phone:'978-745-0065',email:'artemisiabotanicalssalem@gmail.com',address:'3 Hawthorne Blvd., Salem, MA',type:'Specialty / Gift'},
    {name:'Gunnison Orchards',contact:'Will Gunnison',phone:'518-597-9222',email:'gunnisonorchards@yahoo.com',address:'PO Box 276, Crown Point, NY',type:'Farm / Country Store'},
    {name:'Norseman Beach Store',contact:'Richard Rainville',phone:'978-809-4381',email:'Retail@ogunquitbeach.com',address:'135 Beach St., Ogunquit, ME 03097',type:'Specialty / Gift'},
    {name:'Kennebec Cabin Company',contact:'',phone:'',email:'isidora@mainecabinmasters.com',address:'Maine',type:'Specialty / Gift'},
    {name:'Wild Blueberry Land',contact:'Dell Emerson / Chef Marie',phone:'207-483-2583',email:'wescogus@yahoo.com',address:'1067 US Highway 1, Columbia Falls, ME',type:'Farm / Country Store'},
    {name:'Amolette Herbal Apothecary',contact:'Nicolette Janelle',phone:'207-625-9230',email:'amoletteherbalapothecary@gmail.com',address:'20 Main Street, Cornish, ME',type:'Specialty / Gift'},
    {name:'Fuller Gardens',contact:'Victoria Kaiser',phone:'603-431-6024',email:'vkaiser71@gmail.com',address:'10 Willow Ave., North Hampton, NH',type:'Farm / Country Store'},
    {name:'Brown Paper Packages',contact:'Alyssa Schoenfeld',phone:'603-739-9036',email:'alyssa@brownpaperpkg.com',address:'2053 Main Street, Bethlehem, NH',type:'Specialty / Gift'},
    {name:'Giving Home',contact:'Leslie Smith',phone:'207-517-1719',email:'givinghomefreeport@gmail.com',address:'27 Bow Street, Freeport, ME',type:'Specialty / Gift'},
    {name:'Senator Inn and Spa',contact:'Pamela Stone',phone:'207-622-3138',email:'boutique@senatorinn.com',address:'284 Western Ave., Augusta, ME',type:'Spa / Wellness'},
    {name:'Air BNB Services',contact:'Kerri Osbone',phone:'',email:'experiences@stayohm.com',address:'Maine',type:'Other'},
    {name:"Flaherty's Family Farm",contact:'',phone:'207-883-5494',email:'flahertyfarm@gmail.com',address:'123 Payne Rd, Scarborough, ME',type:'Farm / Country Store'},
    {name:'Main Street Gift and Cafe',contact:'',phone:'978-534-5090',email:'hello@mainstreetgiftandcafe.com',address:'40 Main St., Leominster, MA',type:'Café'},
    {name:'Island Closet',contact:'Jeannie Conway',phone:'207-248-1484',email:'theislandcloset@gmail.com',address:'61 Main Street, Vinalhaven, ME',type:'Specialty / Gift'},
    {name:'Berry Vines',contact:'',phone:'207-255-4455',email:'',address:'247 Main Street, Machias, ME',type:'Specialty / Gift'},
    {name:'PJS Trading',contact:'Paul and Jennifer Rich',phone:'978-604-1597',email:'pjstrading1775@gmail.com',address:'6 Temple Street, Tewksbury, MA',type:'Specialty / Gift'},
    {name:'The Farm Truck at Hein Farm',contact:'Jennifer Woods',phone:'860-952-2767',email:'grow@farmingtonfarmtruck.farm',address:'303 Meadow Road, Farmington, CT',type:'Farm / Country Store'},
    {name:'Brookfield Orchards',contact:'Diana Sears',phone:'508-867-6858',email:'diana.brookfieldorchards@gmail.com',address:'12 Lincoln Rd, North Brookfield, MA',type:'Farm / Country Store'},
    {name:'Kays Cafe',contact:'Cindy Kobylarz',phone:'603-674-8385',email:'kobys@comcast.net',address:'325 Lafayette Rd, Hampton, NH',type:'Café'},
    {name:'Waltham Fields Community Farm',contact:'Ana Strayton',phone:'781-899-2403',email:'ana@communityfarms.org',address:'240 Beaver Street, Waltham, MA',type:'Farm / Country Store'},
    {name:'Wallingford Farm',contact:'Lisa',phone:'508-241-4066',email:'contact@wallingfordfarm.com',address:'21 York St, Kennebunk, ME',type:'Farm / Country Store'},
    {name:'Country Collectibles',contact:'',phone:'207-764-8060',email:'countrycollecibles@gmail.com',address:'387 Main St., Presque Isle, ME',type:'Specialty / Gift'},
    {name:'Pauls Marina',contact:'Helene Marsh Harrower',phone:'207-729-3067',email:'helene.harrower@paulsmarina.com',address:'36 Eastern Shore Rd., Brunswick, ME',type:'Other'},
    {name:'Colonial Pharmacy',contact:'Nancy Rechisky',phone:'603-526-2233',email:'sales@colonialpharmacy.com',address:'28 Newport Rd, New London, NH',type:'Specialty / Gift'},
    {name:'Tipped Trailer Co.',contact:'',phone:'',email:'tippedtrailerco@gmail.com',address:'5 Water St., Newport, NH',type:'Other'},
    {name:'Country Keepsakes',contact:'Tiffany Pierson',phone:'207-667-6967',email:'tiffsckgifts@gmail.com',address:'282 Bar Harbor Rd, Trenton, ME',type:'Specialty / Gift'},
    {name:'Rockywold Deephaven Camps',contact:'Claire Hekking',phone:'603-968-3313',email:'claire@RDCsquam.com',address:'18 Bacon Rd, Holderness, NH',type:'Spa / Wellness'},
    {name:'Bedrock Gardens',contact:'Jodie Curtis',phone:'',email:'retail@bedrockgardens.org',address:'45 High Road, Lee, NH',type:'Farm / Country Store'},
    {name:'Perkins Cove Pottery Shop',contact:'Rob Haslam',phone:'617-429-2120',email:'rob@perkinscovepottery.com',address:'104 Perkins Cove Rd., Ogunquit, ME',type:'Specialty / Gift'},
    {name:'Fiddleheads',contact:'',phone:'207-767-5595',email:'bloomersmaine@gmail.com',address:'546 Shore Rd., Cape Elizabeth, ME',type:'Specialty / Gift'},
    {name:'Whispering Sands Gifts',contact:'Ann Thomson',phone:'207-752-4675',email:'',address:'3 Main Street, York Beach, ME',type:'Specialty / Gift'},
  ];

  const existing = new Set(DB.a('pr').map(x => x.name.toLowerCase().trim()));
  const toImport = RECORDS.filter(r => !existing.has(r.name.toLowerCase().trim()));
  const skipped  = RECORDS.length - toImport.length;

  if (toImport.length === 0) {
    alert(`All ${RECORDS.length} records already exist — nothing imported.`);
    return;
  }

  const prospects = toImport.map(r => ({
    id:               mk(),
    name:             r.name,
    contact:          r.contact||'',
    phone:            r.phone||'',
    email:            r.email||'',
    address:          r.address||'',
    lat:              null,
    lng:              null,
    territory:        '',
    type:             r.type,
    status:           'contacted',
    priority:         'medium',
    source:           'Trade Show',
    isPbf:            false,
    lastContact:      TODAY,
    nextAction:       'Follow up at purpl launch',
    nextDate:         null,
    nextFollowUpLabel:'purpl launch',
    notes:            [],
    outreach:         [],
  }));

  DB.atomicUpdate(cache => {
    cache.pr = [...(cache.pr || []), ...prospects];
    cache.settings = {...(cache.settings || {}), tradeshow_2026_imported: true};
    return cache;
  });

  renderSettings();
  renderProspects();
  alert(`✓ ${toImport.length} prospects imported, ${skipped} skipped (duplicates).`);
}

// ══════════════════════════════════════════════════════════
//  NEM SHOW ACCOUNTS IMPORT (one-time, March 2026 NEM show)
// ══════════════════════════════════════════════════════════
function importNEMShowAccounts() {
  if (!DB._firestoreReady) { toast('⚠️ Database not ready yet — please wait a moment and try again.'); return; }
  if (!confirm('Import 18 NEM show accounts? Duplicates will be skipped.')) return;

  const mk = () => uid();
  const SHOW_DATE = '2026-03-17';

  const RECORDS = [
    {name:"Osbornes",contact:'Gretchen Wolfe',phone:'603-228-8561',email:'gretchen@osbornesfarm.com',address:'258 Sheep Davis Road, Concord, NH',type:'Farm / Country Store',note:'NEM show order.'},
    {name:'Poland Provisions',contact:'Sheila Foley',phone:'207-402-7123',email:'info@polandprovisions.com',address:'1220 Maine St., Poland, ME',type:'Specialty / Gift',note:'NEM show order.'},
    {name:'New England Mercantile',contact:'Kyle Eldridge',phone:'603-772-0263',email:'keldridge.nemercantile@gmail.com',address:'Water St., Exeter, NH',type:'Specialty / Gift',note:'Cash and carry. NEM show order.'},
    {name:'Wild Oats Bakery and Cafe',contact:'Colleen Gilliatt',phone:'207-725-6287',email:'market@wildoatsbakery.com',address:'166 Admiral Fitch Avenue, Brunswick, ME',type:'Café',note:'NEM show order.'},
    {name:'Douglas Brook Farm',contact:'Kim Bragdon',phone:'207-659-9581',email:'douglasbrookfarm@gmail.com',address:'21 Files Rd, Gorham, ME',type:'Farm / Country Store',note:'NEM show order. Mid April invoice.'},
    {name:'New Morning Natural Foods',contact:'Ariel Peacock',phone:'207-985-6774',email:'ariel@newmorningme.com',address:'3 York Street, Kennebunk, ME',type:'Specialty / Gift',note:'NEM show order.'},
    {name:'Harpswell Collective',contact:'Liz Negler',phone:'617-653-6960',email:'liz@harpswellcollective.com',address:'1906 Harpswell Neck Rd, Harpswell, ME',type:'Specialty / Gift',note:'NEM show order. Late May invoice.'},
    {name:'Portsmouth Soap Co',contact:'Lauren',phone:'207-451-7904',email:'lauren@portsmouthsoaps.com',address:'175 Market St., Portsmouth, NH',type:'Specialty / Gift',note:'NEM show order.'},
    {name:'Enfield Shaker Museum',contact:'Carolyn Smith (Acting Director)',phone:'603-632-4346',email:'director@sharkermuseum.org',address:'477 NH Route 4A, Enfield, NH',type:'Specialty / Gift',note:"Mothers Day? NEM show order."},
    {name:"Singleton's Store",contact:'Allison and Danielle Singleton',phone:'802-226-7666',email:'store@singletonvt.com',address:'356 Main St, Proctorsville, VT',type:'Specialty / Gift',note:'NEM show order.'},
    {name:'Maine Homestead Market',contact:'',phone:'207-499-4292',email:'mainehomsteadstore@gmail.com',address:'1773 Alfred Rd, Lyman, ME',type:'Farm / Country Store',note:'NEM show order.'},
    {name:'Beachside Variety',contact:'Sheila Gillian',phone:'207-450-0753',email:'',address:'124 W Grand Ave, Old Orchard Beach, ME',type:'Specialty / Gift',note:'NEM show order. CASH ON DELIVERY — mid May. Text when close, notify before delivery.'},
    {name:'Wild Goose Country Store',contact:'Sharon Parsons',phone:'',email:'wildgoosecountrystore@hotmail.com',address:'77 Main St, Sunapee, NH 03782',type:'Farm / Country Store',note:'NEM show order. CC info on order form. Ship to 511 North Road, Sunapee NH — mid May. Was signed up for wholesale already.'},
    {name:'The Seagull Shop',contact:'Brooke Cotter (Partner/GM)',phone:'207-677-2374',email:'seagullbrooke@gmail.com',address:'3119 Bristol Rd, New Harbor, ME',type:'Specialty / Gift',note:'NEM show order. May invoice.'},
    {name:'Original General Store',contact:'Lauren Foley',phone:'802-746-8888',email:'ogs802@gmail.com',address:'3963 VT RT 100, Pittsfield, VT',type:'Specialty / Gift',note:'NEM show order.'},
    {name:'Whimsical Wishes',contact:'Joanne Meeks / Richard Torrey',phone:'508-317-0659',email:'joannemeeks@msn.com',address:'170 Water St, Plymouth, MA',type:'Specialty / Gift',note:'NEM show order.'},
    {name:'Love at First Light',contact:'Tammy Fairchild',phone:'207-213-5867',email:'loveatfirstlight@yahoo.com',address:'77 Water St, Lubec, ME',type:'Specialty / Gift',note:'NEM show order. May invoice.'},
    {name:'Nesting Dusk',contact:'Mary Thurlow and Ruth Brown',phone:'',email:'nestduck@aol.com',address:'17 Perkins Cove, Ogunquit, ME',type:'Specialty / Gift',note:'NEM show order.'},
  ];

  const existing = new Set(DB.a('ac').map(x => x.name.toLowerCase().trim()));
  const toImport = RECORDS.filter(r => !existing.has(r.name.toLowerCase().trim()));
  const skipped  = RECORDS.length - toImport.length;

  if (toImport.length === 0) {
    alert(`All ${RECORDS.length} records already exist — nothing imported.`);
    return;
  }

  const accounts = toImport.map(r => ({
    id:            mk(),
    name:          r.name,
    contact:       r.contact||'',
    phone:         r.phone||'',
    email:         r.email||'',
    address:       r.address||'',
    lat:           null,
    lng:           null,
    territory:     '',
    type:          r.type,
    status:        'active',
    since:         SHOW_DATE,
    dropOffRules:  '',
    skus:          [],
    par:           {},
    pricing:       {},
    notes:         [{id:mk(), date:SHOW_DATE, text:r.note, author:'you', nextAction:'', nextDate:''}],
    outreach:      [],
    lastOrder:     null,
    lastContacted: SHOW_DATE,
  }));

  DB.atomicUpdate(cache => {
    cache.ac = [...(cache.ac || []), ...accounts];
    cache.settings = {...(cache.settings || {}), nem_show_2026_imported: true};
    return cache;
  });

  renderSettings();
  renderAccounts();
  alert(`✓ ${toImport.length} accounts imported, ${skipped} skipped (duplicates).`);
}

// ══════════════════════════════════════════════════════════
//  LAVENDER FIELDS — SKU CATALOG (Settings)
// ══════════════════════════════════════════════════════════

function renderLfSkuSettings() {
  const tbody = qs('#lf-sku-tbody');
  if (!tbody) return;
  const showArchived = qs('#lf-sku-show-archived')?.checked || false;
  let skus = DB.a('lf_skus').slice();
  if (!showArchived) skus = skus.filter(s => !s.archived);
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;');
  if (!skus.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No SKUs yet. Click "+ Add SKU" to get started.</td></tr>';
    return;
  }
  tbody.innerHTML = skus.map(s => {
    const activeV = (s.variants||[]).filter(v => !v.archived).length;
    const totalV  = (s.variants||[]).length;
    const varBtnLabel = totalV > 0
      ? `▸ Variants (${activeV}${activeV < totalV ? '/'+totalV : ''})`
      : '+ Variants';
    const variantRowsHtml = (s.variants||[]).map(v => `
      <tr data-variant-id="${v.id}" class="${v.archived?'lf-sku-archived':''}">
        <td style="padding-left:32px"><input class="lfv-name" value="${esc(v.name)}" style="width:200px"></td>
        <td colspan="3" style="color:var(--muted);font-size:12px">variant</td>
        <td style="white-space:nowrap">
          <button class="btn sm primary" onclick="saveLfVariantRow('${s.id}','${v.id}')">Save</button>
          <button class="btn sm ${v.archived?'':'amber'}" onclick="toggleLfVariantArchive('${s.id}','${v.id}')">${v.archived?'Restore':'Archive'}</button>
          <button class="btn sm red" onclick="deleteLfVariant('${s.id}','${v.id}')">✕</button>
        </td>
        <td></td>
      </tr>`).join('');
    return `
      <tr data-sku-id="${s.id}" class="${s.archived ? 'lf-sku-archived' : ''}">
        <td><input class="lfs-name" value="${esc(s.name)}" style="width:220px"></td>
        <td><input class="lfs-price" type="number" step="0.01" value="${s.wholesalePrice||''}" style="width:80px"> /unit</td>
        <td><input class="lfs-case" type="number" step="1" value="${s.caseSize||''}" style="width:60px"></td>
        <td><input class="lfs-msrp" type="number" step="0.01" value="${s.msrp||''}" placeholder="—" style="width:80px"></td>
        <td style="white-space:nowrap">
          <button class="btn sm primary" onclick="saveLfSkuRow('${s.id}')">Save</button>
          <button class="btn sm ${s.archived?'':'amber'}" onclick="toggleLfSkuArchive('${s.id}')">${s.archived?'Restore':'Archive'}</button>
        </td>
        <td>
          <button class="btn sm" onclick="toggleLfVariantPanel('${s.id}')" style="font-size:11px">${varBtnLabel}</button>
        </td>
      </tr>
      <tr id="lf-var-panel-${s.id}" style="display:none">
        <td colspan="6" style="padding:0 0 4px 0;background:var(--bg-alt,#f9fafb)">
          <table style="width:100%;border-collapse:collapse">
            <tbody>
              ${variantRowsHtml}
              <tr><td colspan="6" style="padding:6px 0 6px 32px">
                <button class="btn sm green" onclick="addLfVariant('${s.id}')">+ Add Variant</button>
              </td></tr>
            </tbody>
          </table>
        </td>
      </tr>`;
  }).join('');
}

function saveLfSkuRow(id) {
  const row = qs(`#lf-sku-tbody [data-sku-id="${id}"]`);
  if (!row) return;
  const name = row.querySelector('.lfs-name')?.value?.trim();
  if (!name) { toast('SKU name required'); return; }
  const wholesalePrice = parseFloat(row.querySelector('.lfs-price')?.value) || 0;
  const caseSize       = parseInt(row.querySelector('.lfs-case')?.value)    || 1;
  const msrpRaw        = parseFloat(row.querySelector('.lfs-msrp')?.value);
  const msrp           = isNaN(msrpRaw) ? null : msrpRaw || null;
  DB.update('lf_skus', id, s => ({...s, name, wholesalePrice, caseSize, msrp}));
  toast('SKU saved ✓');
}

function toggleLfSkuArchive(id) {
  const sku = DB.a('lf_skus').find(s => s.id === id);
  if (!sku) return;
  DB.update('lf_skus', id, s => ({...s, archived: !s.archived}));
  renderLfSkuSettings();
  toast(sku.archived ? 'SKU restored' : 'SKU archived');
}

function addLfSku() {
  const newSku = {id:uid(), name:'New SKU', wholesalePrice:0, caseSize:1, msrp:null, archived:false, variants:[]};
  DB.push('lf_skus', newSku);
  renderLfSkuSettings();
  toast('New SKU added — edit name and save');
}

function toggleLfVariantPanel(skuId) {
  const panel = qs(`#lf-var-panel-${skuId}`);
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? '' : 'none';
}

function addLfVariant(skuId) {
  const newVariant = {id: uid(), name: 'New Variant', archived: false};
  DB.update('lf_skus', skuId, s => ({...s, variants: [...(s.variants||[]), newVariant]}));
  renderLfSkuSettings();
  const panel = qs(`#lf-var-panel-${skuId}`);
  if (panel) panel.style.display = '';
  toast('Variant added — edit name and save');
}

function saveLfVariantRow(skuId, variantId) {
  const panel = qs(`#lf-var-panel-${skuId}`);
  const row = panel?.querySelector(`[data-variant-id="${variantId}"]`);
  if (!row) return;
  const name = row.querySelector('.lfv-name')?.value?.trim();
  if (!name) { toast('Variant name required'); return; }
  DB.update('lf_skus', skuId, s => ({
    ...s,
    variants: (s.variants||[]).map(v => v.id === variantId ? {...v, name} : v),
  }));
  toast('Variant saved ✓');
}

function deleteLfVariant(skuId, variantId) {
  if (!confirm2('Delete this variant?')) return;
  DB.update('lf_skus', skuId, s => ({...s, variants: (s.variants||[]).filter(v => v.id !== variantId)}));
  renderLfSkuSettings();
  const panel = qs(`#lf-var-panel-${skuId}`);
  if (panel) panel.style.display = '';
}

function toggleLfVariantArchive(skuId, variantId) {
  const sku = DB.a('lf_skus').find(s => s.id === skuId);
  const variant = sku?.variants?.find(v => v.id === variantId);
  if (!variant) return;
  DB.update('lf_skus', skuId, s => ({
    ...s,
    variants: (s.variants||[]).map(v => v.id === variantId ? {...v, archived: !v.archived} : v),
  }));
  renderLfSkuSettings();
  const panel = qs(`#lf-var-panel-${skuId}`);
  if (panel) panel.style.display = '';
  toast(variant.archived ? 'Variant restored' : 'Variant archived');
}

// ══════════════════════════════════════════════════════════
//  LAVENDER FIELDS — INVOICES PAGE
// ══════════════════════════════════════════════════════════

let _lfInvStatusFilter = '';
let _wixPullDeductionId = null;
let _wixPullInvoiceId   = null;

const LF_INV_STATUS = {
  unpaid:  {label:'Unpaid',  cls:'amber'},
  paid:    {label:'Paid',    cls:'green'},
  overdue: {label:'Overdue', cls:'red'},
  partial: {label:'Partial', cls:'blue'},
};

function setLfInvFilter(status) {
  _lfInvStatusFilter = status;
  document.querySelectorAll('#lf-inv-tabs .ac-brand-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.status === status));
  renderLfInvoicesPage();
}

function renderLfInvoicesPage() {
  const all = DB.a('lf_invoices');
  const todayStr = today();

  // KPIs — outstanding, overdue, pending Wix pulls
  const overdueList = all.filter(i => i.status === 'overdue' || (i.status !== 'paid' && i.due && i.due < todayStr));
  const outstanding = all.filter(i => i.status !== 'paid').reduce((s,i) => s + (i.total||0), 0);
  const overdueAmt  = overdueList.reduce((s,i) => s + (i.total||0), 0);
  const pendingWix  = DB.a('lf_wix_deductions').filter(d => !d.confirmed).length;

  if (qs('#lf-inv-kpi-outstanding')) qs('#lf-inv-kpi-outstanding').innerHTML = kpiHtml('Outstanding', fmtC(outstanding), 'blue');
  if (qs('#lf-inv-kpi-overdue'))     qs('#lf-inv-kpi-overdue').innerHTML     = kpiHtml('Overdue', fmtC(overdueAmt), overdueAmt > 0 ? 'red' : 'gray');
  if (qs('#lf-inv-kpi-wix'))         qs('#lf-inv-kpi-wix').innerHTML         = kpiHtml('Pending Wix Pulls', pendingWix, pendingWix > 0 ? 'amber' : 'gray');

  // Overdue list
  const overdueCard = qs('#inv-lf-overdue-card');
  const overdueEl   = qs('#inv-lf-overdue-list');
  if (overdueCard) overdueCard.style.display = overdueList.length ? '' : 'none';
  if (overdueEl) {
    overdueEl.innerHTML = overdueList.map(inv => {
      const days = daysAgo(inv.due||'');
      return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
        <div>
          <div style="font-weight:600;font-size:13px">${escHtml(inv.accountName||'—')} · ${escHtml(inv.number||'—')}</div>
          <div style="font-size:11px;color:var(--muted)">Due ${fmtD(inv.due)} · ${days}d overdue</div>
        </div>
        <div style="display:flex;gap:4px;align-items:center">
          <span style="font-weight:700;color:var(--red);font-size:13px">${fmtC(inv.total||0)}</span>
          <button class="btn xs green" onclick="markLfInvPaid('${inv.id}')">✓ Paid</button>
        </div>
      </div>`;
    }).join('');
  }

  // Filter + sort
  let list = all.slice();
  if (_lfInvStatusFilter) list = list.filter(i => i.status === _lfInvStatusFilter);
  list.sort((a,b) => (b.issued||'') > (a.issued||'') ? 1 : -1);

  const tbody = qs('#lf-inv-tbody');
  if (!tbody) return;

  tbody.innerHTML = list.map(inv => {
    const sc = LF_INV_STATUS[inv.status] || {label: inv.status||'—', cls:'gray'};
    const wixHtml = inv.wixPulled
      ? `<span style="color:var(--green,#16a34a);font-weight:600">✓</span>`
      : `<span style="color:#f59e0b;font-weight:600">⚠</span>`;
    return `<tr>
      <td><strong>${escHtml(inv.number||'—')}</strong></td>
      <td>${escHtml(inv.accountName||'—')}</td>
      <td>${fmtD(inv.due)}</td>
      <td><strong>${fmtC(inv.total||0)}</strong></td>
      <td><span class="badge ${sc.cls}">${sc.label}</span></td>
      <td>${wixHtml}</td>
      <td style="white-space:nowrap">
        <button class="btn xs" onclick="openLfInvoiceModal('${inv.id}')">Edit</button>
        <button class="btn xs ${inv.status==='paid'?'':'primary'}" onclick="markLfInvPaid('${inv.id}')">${inv.status==='paid'?'Unpay':'✓ Paid'}</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">No LF invoices yet</td></tr>';
}

function markLfInvPaid(id) {
  const inv = DB.a('lf_invoices').find(x => x.id === id);
  if (!inv) return;
  const newStatus = inv.status === 'paid' ? 'unpaid' : 'paid';
  DB.update('lf_invoices', id, x => ({...x, status: newStatus, paidAt: newStatus === 'paid' ? today() : null}));
  renderInvoicesPage();
  toast(newStatus === 'paid' ? 'Marked paid ✓' : 'Marked unpaid');
}

// ── LF Invoice modal ─────────────────────────────────────

function openLfInvoiceModal(id) {
  const isNew = !id;
  const inv   = id ? DB.a('lf_invoices').find(x => x.id === id) : null;

  qs('#lfi-modal-title').textContent = isNew ? 'New LF Invoice' : 'Edit LF Invoice';

  // Auto-number / load fields
  if (isNew) {
    const num = DB.a('lf_invoices').length + 1;
    if (qs('#lfi-number')) qs('#lfi-number').value = 'LF-' + String(num).padStart(3,'0');
    if (qs('#lfi-issued')) qs('#lfi-issued').value  = today();
    const terms  = DB.obj('invoice_settings',{}).terms || 30;
    const dueStr = new Date(Date.now() + terms * 864e5).toISOString().slice(0,10);
    if (qs('#lfi-due'))    qs('#lfi-due').value    = dueStr;
    if (qs('#lfi-status')) qs('#lfi-status').value = 'unpaid';
    if (qs('#lfi-notes'))  qs('#lfi-notes').value  = '';
    if (qs('#lfi-link'))   qs('#lfi-link').value   = '';
    if (qs('#lfi-delete-btn')) qs('#lfi-delete-btn').style.display = 'none';
  } else {
    if (qs('#lfi-number')) qs('#lfi-number').value = inv.number||'';
    if (qs('#lfi-issued')) qs('#lfi-issued').value  = inv.issued||today();
    if (qs('#lfi-due'))    qs('#lfi-due').value    = inv.due||'';
    if (qs('#lfi-status')) qs('#lfi-status').value = inv.status||'unpaid';
    if (qs('#lfi-notes'))  qs('#lfi-notes').value  = inv.notes||'';
    if (qs('#lfi-link'))   qs('#lfi-link').value   = inv.link||'';
    if (qs('#lfi-delete-btn')) {
      qs('#lfi-delete-btn').style.display = '';
      qs('#lfi-delete-btn').onclick = () => deleteLfInvoice(id);
    }
  }

  // Account selector (all non-inactive accounts)
  const acSel = qs('#lfi-account');
  if (acSel) {
    const accounts = DB.a('ac').filter(a => a.status !== 'inactive').sort((a,b) => (a.name||'') < (b.name||'') ? -1 : 1);
    acSel.innerHTML = '<option value="">— Select Account —</option>' +
      accounts.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
    if (inv?.accountId) acSel.value = inv.accountId;
  }

  // Line items
  const container = qs('#lfi-line-items');
  if (container) {
    container.innerHTML = '';
    const rows = inv?.lineItems?.length ? inv.lineItems : [];
    if (rows.length) {
      rows.forEach(item => _lfInvRenderLineRow(item));
    } else {
      _lfInvRenderLineRow(null); // one blank row
    }
    _lfInvCalcTotal();
  }

  qs('#lfi-save-btn').onclick = () => saveLfInvoice(id, isNew);

  const lfiSendBtn = qs('#lfi-send-btn');
  if (lfiSendBtn) {
    lfiSendBtn.style.display = isNew ? 'none' : '';
    lfiSendBtn.onclick = () => {
      const inv = DB.a('lf_invoices').find(x => x.id === id);
      if (!inv) { toast('Save the invoice before sending'); return; }
      const ac = DB.a('ac').find(x => x.id === inv.accountId) || {};
      const to = ac.email || '';
      if (!to) { toast('No email address on file for this account'); return; }
      const html    = buildLfInvoiceEmailHTML(inv);
      const subject = `Invoice ${inv.number||''} from Lavender Fields at Pumpkin Blossom Farm — ${ac.name||inv.accountName||''}`;
      lfiSendBtn.disabled = true; lfiSendBtn.textContent = 'Sending…';
      callSendEmail(to, 'lavender@pbfwholesale.com', subject, html)
        .then((result) => {
          toast('Invoice sent ✓');
          const entry = {
            id: uid(), stage: 'invoice_sent',
            sentAt: new Date().toISOString(),
            sentBy: 'graham', method: 'resend',
            invoiceId: inv.id, invoiceRef: inv.number,
          };
          if (result?.id) entry.sentMessageId = result.id;
          DB.update('ac', ac.id, a => ({
            ...a, lastContacted: today(),
            cadence: [...(a.cadence||[]), entry],
          }));
          renderAccounts();
          const updatedAc = DB.a('ac').find(x => x.id === ac.id);
          if (updatedAc) { renderAccountOutreach(updatedAc); renderMacEmailsTab(ac.id); }
        })
        .catch(() => { toast('Failed to send — check connection'); })
        .finally(() => { lfiSendBtn.disabled = false; lfiSendBtn.textContent = 'Send Email'; });
    };
  }

  openModal('modal-lf-invoice');
}

function _lfInvRenderLineRow(item) {
  const container = qs('#lfi-line-items');
  if (!container) return;
  const skus  = DB.a('lf_skus').filter(s => !s.archived);
  const rowId = uid();
  const row   = document.createElement('div');
  row.className     = 'lfi-item-row';
  row.dataset.rowId = rowId;
  const selOpts = skus.map(s => {
    const sel = item && s.id === item.skuId ? 'selected' : '';
    return `<option value="${s.id}" data-price="${s.wholesalePrice}" data-case="${s.caseSize}" ${sel}>${escHtml(s.name)}</option>`;
  }).join('');
  row.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <select class="lfi-sku-sel" onchange="_lfInvSkuChanged('${rowId}')">
        <option value="">— Select SKU —</option>${selOpts}
      </select>
      <button type="button" class="btn sm red" onclick="_lfInvRemoveRow('${rowId}')">✕</button>
    </div>
    <div class="lfi-variant-area" style="margin-top:6px"></div>
    <div style="display:flex;justify-content:flex-end;font-size:13px;margin-top:4px">
      Row total: <strong class="lfi-line-amt" style="margin-left:6px">${fmtC(item?.lineTotal||0)}</strong>
    </div>`;
  container.appendChild(row);
  if (item?.skuId) _lfInvBuildVariantArea(rowId, item);
}

function _lfInvSkuChanged(rowId) {
  _lfInvBuildVariantArea(rowId, null);
  _lfInvCalcTotal();
}

function _lfInvBuildVariantArea(rowId, item) {
  const row  = qs(`#lfi-line-items [data-row-id="${rowId}"]`);
  if (!row) return;
  const sel    = row.querySelector('.lfi-sku-sel');
  const skuId  = sel?.value;
  const area   = row.querySelector('.lfi-variant-area');
  if (!area) return;
  if (!skuId) { area.innerHTML = ''; return; }

  const skuObj   = DB.a('lf_skus').find(s => s.id === skuId);
  const variants = (skuObj?.variants||[]).filter(v => !v.archived);

  if (variants.length > 0) {
    const varRows = variants.map(v => {
      const vl = item?.variantLines?.find(x => x.variantId === v.id);
      return `
        <div class="lfi-variant-row" data-variant-id="${v.id}"
          style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px">
          <span style="width:180px;flex-shrink:0">${escHtml(v.name)}</span>
          <input class="lfi-var-cases" type="number" min="0" step="1" value="${vl?.cases||0}"
            style="width:60px" oninput="_lfInvRowCalc('${rowId}')">
          <span>cases</span>
          <span>= <strong class="lfi-var-units">${vl?.units||0}</strong> units</span>
          <span class="lfi-var-total" style="margin-left:auto">${fmtC(vl?.lineTotal||0)}</span>
        </div>`;
    }).join('');
    area.innerHTML = `
      <div style="font-size:12px;color:var(--muted);margin-bottom:4px">
        Variants — $${parseFloat(skuObj.wholesalePrice).toFixed(2)}/case · ${skuObj.caseSize} units/case
      </div>
      <div class="lfi-variants-container">${varRows}</div>`;
  } else {
    area.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;font-size:13px">
        <input class="lfi-cases" type="number" min="0" step="1" value="${item?.cases||0}"
          style="width:70px" oninput="_lfInvRowCalc('${rowId}')">
        <span>cases</span>
        <span>= <strong class="lfi-units">${item?.units||0}</strong> units</span>
      </div>`;
  }
  _lfInvRowCalc(rowId);
}

function lfInvAddLineItem() {
  _lfInvRenderLineRow(null);
  _lfInvCalcTotal();
}

function _lfInvRowCalc(rowId) {
  const row = qs(`#lfi-line-items [data-row-id="${rowId}"]`);
  if (!row) return;
  const sel       = row.querySelector('.lfi-sku-sel');
  const opt       = sel?.options[sel?.selectedIndex];
  const unitPrice = parseFloat(opt?.dataset?.price || 0);
  const caseSize  = parseInt(opt?.dataset?.case    || 0);
  let rowTotal = 0;

  const variantRows = row.querySelectorAll('.lfi-variant-row');
  if (variantRows.length > 0) {
    variantRows.forEach(vr => {
      const cases     = parseInt(vr.querySelector('.lfi-var-cases')?.value || 0);
      const units     = cases * caseSize;
      const lineTotal = units * unitPrice;
      const unitsEl   = vr.querySelector('.lfi-var-units');
      if (unitsEl) unitsEl.textContent = units;
      const ltEl = vr.querySelector('.lfi-var-total');
      if (ltEl) ltEl.textContent = fmtC(lineTotal);
      rowTotal += lineTotal;
    });
  } else {
    const cases   = parseInt(row.querySelector('.lfi-cases')?.value || 0);
    const unitsEl = row.querySelector('.lfi-units');
    if (unitsEl) unitsEl.textContent = cases * caseSize;
    rowTotal = cases * caseSize * unitPrice;
  }

  const ltEl = row.querySelector('.lfi-line-amt');
  if (ltEl) ltEl.textContent = fmtC(rowTotal);
  _lfInvCalcTotal();
}

function _lfInvRemoveRow(rowId) {
  qs(`#lfi-line-items [data-row-id="${rowId}"]`)?.remove();
  _lfInvCalcTotal();
}

function _lfInvCalcTotal() {
  const container = qs('#lfi-line-items');
  if (!container) return;
  let total = 0;
  container.querySelectorAll('.lfi-item-row').forEach(row => {
    const sel       = row.querySelector('.lfi-sku-sel');
    const opt       = sel?.options[sel?.selectedIndex];
    const unitPrice = parseFloat(opt?.dataset?.price || 0);
    const caseSize  = parseInt(opt?.dataset?.case    || 0);
    const variantRows = row.querySelectorAll('.lfi-variant-row');
    if (variantRows.length > 0) {
      variantRows.forEach(vr => {
        const cases = parseInt(vr.querySelector('.lfi-var-cases')?.value || 0);
        total += cases * caseSize * unitPrice;
      });
    } else {
      const cases = parseInt(row.querySelector('.lfi-cases')?.value || 0);
      total += cases * caseSize * unitPrice;
    }
  });
  const el = qs('#lfi-total');
  if (el) el.textContent = fmtC(total);
}

function saveLfInvoice(id, isNew) {
  const number    = qs('#lfi-number')?.value?.trim() || '';
  const accountId = qs('#lfi-account')?.value;
  const issued    = qs('#lfi-issued')?.value || today();
  const due       = qs('#lfi-due')?.value || '';
  const status    = qs('#lfi-status')?.value || 'unpaid';
  const notes     = qs('#lfi-notes')?.value?.trim() || '';
  const link      = qs('#lfi-link')?.value?.trim() || '';

  if (!accountId) { toast('Select an account'); return; }

  const ac   = DB.a('ac').find(x => x.id === accountId) || {};
  const skus = DB.a('lf_skus');

  // Collect line items from DOM
  const lineItems = [];
  qs('#lfi-line-items').querySelectorAll('.lfi-item-row').forEach(row => {
    const sel     = row.querySelector('.lfi-sku-sel');
    const skuId   = sel?.value;
    if (!skuId) return;
    const opt       = sel.options[sel.selectedIndex];
    const unitPrice = parseFloat(opt?.dataset?.price || 0);
    const caseSize  = parseInt(opt?.dataset?.case    || 0);
    const skuObj    = skus.find(s => s.id === skuId);
    const variantRows = row.querySelectorAll('.lfi-variant-row');
    if (variantRows.length > 0) {
      const variantLines = [];
      variantRows.forEach(vr => {
        const variantId  = vr.dataset.variantId;
        const variantObj = skuObj?.variants?.find(v => v.id === variantId);
        const cases      = parseInt(vr.querySelector('.lfi-var-cases')?.value || 0);
        if (!cases) return;
        const units     = cases * caseSize;
        const lineTotal = units * unitPrice;
        variantLines.push({variantId, variantName: variantObj?.name || '', cases, units, lineTotal});
      });
      if (!variantLines.length) return;
      const totalCases = variantLines.reduce((s,v)=>s+v.cases, 0);
      const totalUnits = variantLines.reduce((s,v)=>s+v.units, 0);
      const totalLine  = variantLines.reduce((s,v)=>s+v.lineTotal, 0);
      lineItems.push({
        skuId, skuName: skuObj?.name || opt?.textContent?.trim() || '',
        unitPrice, caseSize, hasVariants: true,
        variantLines, cases: totalCases, units: totalUnits, lineTotal: totalLine,
      });
    } else {
      const cases = parseInt(row.querySelector('.lfi-cases')?.value || 0);
      if (!cases) return;
      const units = cases * caseSize;
      lineItems.push({
        skuId, skuName: skuObj?.name || opt?.textContent?.trim() || '',
        unitPrice, caseSize, cases, units, lineTotal: units * unitPrice,
      });
    }
  });

  if (!lineItems.length) { toast('Add at least one line item'); return; }

  const total    = lineItems.reduce((s, l) => s + l.lineTotal, 0);
  const existing = isNew ? null : DB.a('lf_invoices').find(x => x.id === id);
  const saveId   = isNew ? uid() : id;

  const rec = {
    ...(existing||{}),
    id: saveId, number,
    accountId, accountName: ac.name||'',
    issued, due, lineItems, total, status,
    wixPulled:   existing?.wixPulled   || false,
    wixPulledAt: existing?.wixPulledAt || null,
    notes, link,
  };

  if (isNew) DB.push('lf_invoices', rec);
  else DB.update('lf_invoices', id, () => rec);

  // Generate Wix pull deduction record
  const deduction = {
    id: uid(),
    invoiceId:     saveId,
    invoiceNumber: rec.number,
    accountId:     rec.accountId,
    accountName:   rec.accountName,
    date:          today(),
    items:         lineItems.flatMap(l => l.hasVariants
      ? l.variantLines.map(vl => ({skuName: l.skuName, variantName: vl.variantName, cases: vl.cases, units: vl.units}))
      : [{skuName: l.skuName, cases: l.cases, units: l.units}]),
    confirmed:     false,
  };
  if (isNew) DB.push('lf_wix_deductions', deduction);

  closeModal('modal-lf-invoice');
  if (currentPage === 'invoices') renderInvoicesPage();
  renderLfDashKpis();
  toast(`Invoice ${rec.number} saved ✓`);
  showWixPullModal(rec, deduction.id);
}

function deleteLfInvoice(id) {
  if (!confirm2('Delete this LF invoice? This cannot be undone.')) return;
  DB.remove('lf_invoices', id);
  const orphans = DB.a('lf_wix_deductions').filter(d => d.invoiceId === id);
  orphans.forEach(d => DB.remove('lf_wix_deductions', d.id));
  closeModal('modal-lf-invoice');
  if (currentPage === 'invoices') renderInvoicesPage();
  renderLfDashKpis();
  toast('Invoice deleted');
}

// ── Combined invoices (purpl + LF cross-brand) ────────────

function createCombinedInvoice(purplInvId, lfInvId, accountId, portalOrderId=null) {
  const purplInv = DB.a('iv').find(x => x.id === purplInvId);
  const lfInv    = DB.a('lf_invoices').find(x => x.id === lfInvId);
  if (!purplInv || !lfInv) {
    toast('Could not find invoices to combine');
    return null;
  }
  const id = uid();
  const rec = {
    id,
    purplInvoiceId: purplInvId,
    lfInvoiceId:    lfInvId,
    accountId,
    accountName:    purplInv.accountName || '',
    status:         'draft',
    createdAt:      new Date().toISOString(),
    sentAt:         null,
    paidAt:         null,
    portalOrderId:  portalOrderId || null,
    purplSubtotal:  parseFloat(purplInv.amount||0),
    lfSubtotal:     parseFloat(lfInv.total||0),
    grandTotal:     parseFloat(purplInv.amount||0) + parseFloat(lfInv.total||0),
  };
  DB.atomicUpdate(cache => {
    cache.combined_invoices = [...(cache.combined_invoices||[]), rec];
    const pi = (cache.iv||[]).findIndex(x => x.id === purplInvId);
    if (pi >= 0) cache.iv[pi] = {...cache.iv[pi], combinedInvoiceId: id};
    const li = (cache.lf_invoices||[]).findIndex(x => x.id === lfInvId);
    if (li >= 0) cache.lf_invoices[li] = {...cache.lf_invoices[li], combinedInvoiceId: id};
  });
  return id;
}

function markCombinedPaid(combinedId) {
  const rec = DB.a('combined_invoices').find(x => x.id === combinedId);
  if (!rec) return;
  const now = new Date().toISOString();
  DB.update('combined_invoices', combinedId, x => ({...x, status: 'paid', paidAt: now}));
  DB.update('iv',          rec.purplInvoiceId, x => ({...x, status: 'paid', paidDate: now.slice(0,10)}));
  DB.update('lf_invoices', rec.lfInvoiceId,    x => ({...x, status: 'paid', paidAt: now}));
  renderInvoicesPage();
  toast('✓ Combined invoice marked as paid');
}

// ── Invoice numbering ─────────────────────────────────────

function getNextInvoiceNumber(type) {
  const prefix     = { purpl: 'INV', lf: 'LF', combined: 'COMB' }[type];
  const collection = { purpl: 'iv', lf: 'lf_invoices', combined: 'combined_invoices' }[type];
  const nums = DB.a(collection).map(x => {
    const n = parseInt((x.number||'').replace(/[^0-9]/g,''));
    return isNaN(n) ? 0 : n;
  });
  const next = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}-${String(next).padStart(3,'0')}`;
}

// ── New combined invoice modal ────────────────────────────

let _ncivPurplLines = [];
let _ncivLfLines    = [];

function openNewCombinedModal() {
  _ncivPurplLines = [];
  _ncivLfLines    = [];

  const accts = DB.a('ac').filter(a => a.isPbf);
  const sel = document.getElementById('nciv-account');
  sel.innerHTML = '<option value="">Select account...</option>' +
    accts.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');

  const d30 = new Date(Date.now() + 30*86400000);
  document.getElementById('nciv-due').value   = d30.toISOString().slice(0,10);
  document.getElementById('nciv-notes').value = '';

  ncivAddLine('purpl');
  ncivAddLine('lf');
  ncivRender();
  openModal('modal-new-combined');
}

function ncivAddLine(brand) {
  const line = { id: uid(), description: '', qty: 0, unitPrice: 0, total: 0 };
  if (brand === 'purpl') _ncivPurplLines.push(line);
  else                   _ncivLfLines.push(line);
  ncivRender();
}

function ncivRemoveLine(brand, id) {
  if (brand === 'purpl') _ncivPurplLines = _ncivPurplLines.filter(l => l.id !== id);
  else                   _ncivLfLines    = _ncivLfLines.filter(l => l.id !== id);
  ncivRender();
}

function ncivUpdateLine(brand, id, field, val) {
  const lines = brand === 'purpl' ? _ncivPurplLines : _ncivLfLines;
  const line = lines.find(l => l.id === id);
  if (!line) return;
  line[field] = val;
  line.total = (parseFloat(line.qty)||0) * (parseFloat(line.unitPrice)||0);
  ncivCalcTotals();
}

function ncivCalcTotals() {
  const purplSub = _ncivPurplLines.reduce((s,l) => s + (l.total||0), 0);
  const lfSub    = _ncivLfLines.reduce((s,l) => s + (l.total||0), 0);
  document.getElementById('nciv-purpl-sub').textContent   = '$' + purplSub.toFixed(2);
  document.getElementById('nciv-lf-sub').textContent      = '$' + lfSub.toFixed(2);
  document.getElementById('nciv-grand-total').textContent = '$' + (purplSub + lfSub).toFixed(2);
}

function ncivRender() {
  const renderLines = (lines, brand, containerId) => {
    document.getElementById(containerId).innerHTML = lines.map(l => `
      <div style="display:grid;grid-template-columns:1fr 60px 80px 24px;gap:6px;margin-bottom:6px;align-items:center">
        <input placeholder="Description..." value="${escHtml(l.description)}"
          style="font-size:12px;padding:5px 8px"
          oninput="ncivUpdateLine('${brand}','${l.id}','description',this.value)">
        <input type="number" placeholder="Qty" value="${l.qty||''}"
          style="font-size:12px;padding:5px 8px"
          oninput="ncivUpdateLine('${brand}','${l.id}','qty',this.value)">
        <input type="number" placeholder="Price" value="${l.unitPrice||''}" step="0.01"
          style="font-size:12px;padding:5px 8px"
          oninput="ncivUpdateLine('${brand}','${l.id}','unitPrice',this.value)">
        <button class="btn xs red" onclick="ncivRemoveLine('${brand}','${l.id}')">✕</button>
      </div>
      <div style="text-align:right;font-size:11px;color:var(--muted);margin-bottom:4px">
        $${(l.total||0).toFixed(2)}
      </div>`).join('');
  };
  renderLines(_ncivPurplLines, 'purpl', 'nciv-purpl-lines');
  renderLines(_ncivLfLines,    'lf',    'nciv-lf-lines');
  ncivCalcTotals();
}

function saveNewCombinedInvoice() {
  const accountId = document.getElementById('nciv-account').value;
  if (!accountId) { toast('Select an account'); return; }

  const purplLines = _ncivPurplLines.filter(l => l.description || l.total > 0);
  const lfLines    = _ncivLfLines.filter(l => l.description || l.total > 0);
  if (!purplLines.length && !lfLines.length) { toast('Add at least one line item'); return; }

  const account  = DB.a('ac').find(x => x.id === accountId) || {};
  const due      = document.getElementById('nciv-due').value;
  const notes    = document.getElementById('nciv-notes').value;
  const issued   = new Date().toISOString().slice(0,10);
  const purplSub = purplLines.reduce((s,l) => s + (l.total||0), 0);
  const lfSub    = lfLines.reduce((s,l) => s + (l.total||0), 0);

  // Read next numbers before any write so they're accurate
  const purplNum = getNextInvoiceNumber('purpl');
  const lfNum    = getNextInvoiceNumber('lf');
  const combNum  = getNextInvoiceNumber('combined');
  const purplId  = uid();
  const lfId     = uid();
  const combId   = uid();

  const purplInv = {
    id: purplId, number: purplNum, accountId, accountName: account.name||'',
    issued, due, amount: purplSub, status: 'unpaid', lineItems: purplLines,
    notes, combinedInvoiceId: combId, source: 'manual',
  };
  const lfInv = {
    id: lfId, number: lfNum, accountId, accountName: account.name||'',
    issued, due, total: lfSub, status: 'unpaid',
    lineItems: lfLines.map(l => ({
      ...l, skuName: l.description, units: l.qty, lineTotal: l.total, hasVariants: false,
    })),
    notes, wixPulled: false, combinedInvoiceId: combId, source: 'manual',
  };
  const combInv = {
    id: combId, number: combNum, purplInvoiceId: purplId, lfInvoiceId: lfId,
    accountId, accountName: account.name||'', status: 'unpaid',
    createdAt: new Date().toISOString(), sentAt: null, paidAt: null, portalOrderId: null,
    purplSubtotal: purplSub, lfSubtotal: lfSub, grandTotal: purplSub + lfSub,
    notes, source: 'manual',
  };

  DB.atomicUpdate(cache => {
    cache.iv               = [...(cache.iv||[]),               purplInv];
    cache.lf_invoices      = [...(cache.lf_invoices||[]),      lfInv];
    cache.combined_invoices = [...(cache.combined_invoices||[]), combInv];
  });

  closeModal('modal-new-combined');
  renderInvoicesPage();
  toast('Combined invoice created — ' + combNum);
  setTimeout(() => openCombinedInvoicePreview(combId), 300);
}

// ── Combined invoice HTML builder ─────────────────────────

function buildCombinedInvoiceHTML(combinedId) {
  const rec = DB.a('combined_invoices').find(x => x.id === combinedId);
  if (!rec) return '';

  const purplInv   = DB.a('iv').find(x => x.id === rec.purplInvoiceId) || {};
  const lfInv      = DB.a('lf_invoices').find(x => x.id === rec.lfInvoiceId) || {};
  const account    = DB.a('ac').find(x => x.id === rec.accountId) || {};
  const invSettings = DB.obj('invoice_settings') || {};

  const portalLink = account.orderPortalToken
    ? `https://purpl-crm.web.app/order?t=${account.orderPortalToken}`
    : null;

  const issueDate = new Date().toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'});
  const dueDate   = new Date(Date.now() + 30*86400000).toLocaleDateString('en-US', {month:'long',day:'numeric',year:'numeric'});

  const itemTableHeader = `<thead><tr>
    <th style="text-align:left;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Item</th>
    <th style="text-align:right;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Qty</th>
    <th style="text-align:right;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Unit Price</th>
    <th style="text-align:right;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Total</th>
  </tr></thead>`;

  const itemCellStyle = 'padding:8px 0;font-size:13px;border-bottom:1px solid #f3f4f6';
  const purplRows = (purplInv.lineItems||[]).map(li => `<tr>
    <td style="${itemCellStyle}">${escHtml(li.sku||li.description||'Item')}</td>
    <td style="${itemCellStyle};text-align:right">${li.qty||li.cases||0}</td>
    <td style="${itemCellStyle};text-align:right">$${parseFloat(li.unitPrice||0).toFixed(2)}</td>
    <td style="${itemCellStyle};text-align:right;font-weight:500">$${parseFloat(li.total||li.lineTotal||0).toFixed(2)}</td>
  </tr>`).join('');

  const lfRows = (lfInv.lineItems||[]).map(li => {
    if (li.hasVariants && li.variantLines) {
      return li.variantLines.map(vl => `<tr>
        <td style="${itemCellStyle}">${escHtml(li.skuName)} — ${escHtml(vl.variantName)}</td>
        <td style="${itemCellStyle};text-align:right">${vl.units||0}</td>
        <td style="${itemCellStyle};text-align:right">$${parseFloat(li.unitPrice||0).toFixed(2)}</td>
        <td style="${itemCellStyle};text-align:right;font-weight:500">$${parseFloat(vl.lineTotal||0).toFixed(2)}</td>
      </tr>`).join('');
    }
    return `<tr>
      <td style="${itemCellStyle}">${escHtml(li.skuName||'Item')}</td>
      <td style="${itemCellStyle};text-align:right">${li.units||0}</td>
      <td style="${itemCellStyle};text-align:right">$${parseFloat(li.unitPrice||0).toFixed(2)}</td>
      <td style="${itemCellStyle};text-align:right;font-weight:500">$${parseFloat(li.lineTotal||0).toFixed(2)}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0eff4;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0eff4;padding:32px 16px">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">

  <tr><td style="background:linear-gradient(135deg,#2D1B4E 0%,#4a2d7a 100%);padding:24px 40px">
    <table width="100%"><tr>
      <td style="vertical-align:middle">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:middle;padding-right:16px">
              <img src="https://static.wixstatic.com/media/81a2ff_1e3f6923c1d5495082d490b4cc229e1c~mv2.png/v1/fill/w_176,h_71,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Purpl%20Logo%20-%20Sprig%20in%20front%20-%20transparent.png"
                alt="purpl" width="100" height="40" style="display:block">
            </td>
            <td style="vertical-align:middle;padding:0 2px">
              <div style="width:1px;height:44px;background:rgba(255,255,255,0.3)"></div>
            </td>
            <td style="vertical-align:middle;padding-left:16px">
              <img src="https://purpl-crm.web.app/images/lf-logo-circle-transparent.png"
                alt="Lavender Fields" width="44" height="44" style="display:block">
            </td>
          </tr>
        </table>
        <div style="font-family:Arial,sans-serif;font-size:9px;color:rgba(255,255,255,0.5);
          letter-spacing:0.12em;text-transform:uppercase;margin-top:8px">
          Pumpkin Blossom Farm · Wholesale
        </div>
      </td>
      <td align="right" style="vertical-align:middle">
        <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:-0.5px">INVOICE</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px">${escHtml(purplInv.number||'')}${lfInv.number ? ' · '+escHtml(lfInv.number) : ''}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#8B5FBF;height:4px"></td></tr>

  <tr><td style="padding:28px 40px 0">
    <table width="100%"><tr>
      <td style="vertical-align:top;width:50%">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;margin-bottom:8px;font-weight:600">Billed To</div>
        <div style="font-size:15px;font-weight:600;color:#1a1a2e">${escHtml(rec.accountName)}</div>
        ${account.email ? `<div style="font-size:13px;color:#6b7280;margin-top:4px">${escHtml(account.email)}</div>` : ''}
        ${account.address ? `<div style="font-size:13px;color:#6b7280;margin-top:2px">${escHtml(account.address)}</div>` : ''}
      </td>
      <td style="vertical-align:top;text-align:right">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;margin-bottom:8px;font-weight:600">Details</div>
        <div style="font-size:13px;color:#6b7280">Issued: ${issueDate}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:2px">Due: ${dueDate}</div>
        <div style="font-size:13px;color:#6b7280;margin-top:2px">Terms: Net 30</div>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:24px 40px 0">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#8B5FBF;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid #8B5FBF">purpl Lemonade</div>
    <table width="100%" cellpadding="0" cellspacing="0">${itemTableHeader}<tbody>${purplRows||`<tr><td colspan="4" style="font-size:13px;color:#9ca3af;padding:8px 0">purpl lemonade order</td></tr>`}</tbody></table>
    <div style="text-align:right;padding:10px 0;border-top:1px solid #e5e7eb;margin-top:4px">
      <span style="font-size:13px;color:#6b7280">purpl Subtotal: </span>
      <span style="font-size:15px;font-weight:600;color:#8B5FBF">$${rec.purplSubtotal.toFixed(2)}</span>
    </div>
  </td></tr>

  <tr><td style="padding:16px 40px 0">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#4a7c59;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid #4a7c59">Lavender Fields at Pumpkin Blossom Farm</div>
    <table width="100%" cellpadding="0" cellspacing="0">${itemTableHeader}<tbody>${lfRows||`<tr><td colspan="4" style="font-size:13px;color:#9ca3af;padding:8px 0">Lavender Fields order</td></tr>`}</tbody></table>
    <div style="text-align:right;padding:10px 0;border-top:1px solid #e5e7eb;margin-top:4px">
      <span style="font-size:13px;color:#6b7280">LF Subtotal: </span>
      <span style="font-size:15px;font-weight:600;color:#4a7c59">$${rec.lfSubtotal.toFixed(2)}</span>
    </div>
  </td></tr>

  <tr><td style="padding:20px 40px">
    <div style="background:#f9fafb;border-radius:8px;padding:20px 24px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:16px;font-weight:700;color:#1a1a2e">Grand Total</div>
        <div style="font-size:26px;font-weight:700;color:#2D1B4E">$${rec.grandTotal.toFixed(2)}</div>
      </div>
      <div style="font-size:12px;color:#9ca3af;margin-top:6px">Payment due within 30 days · Net 30</div>
      ${invSettings.stripeLink ? `<div style="margin-top:16px;text-align:center"><a href="${escHtml(invSettings.stripeLink)}" style="display:inline-block;background:#2D1B4E;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">Pay Now →</a></div>` : ''}
    </div>
  </td></tr>

  ${portalLink ? `<tr><td style="padding:0 40px 16px;text-align:center"><a href="${portalLink}" style="font-size:13px;color:#8B5FBF;text-decoration:none">Place your next order →</a></td></tr>` : ''}

  <tr><td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#9ca3af;line-height:1.8">
    Pumpkin Blossom Farm LLC<br>
    393 Pumpkin Hill Rd · Warner, NH 03278<br>
    <a href="mailto:lavender@pbfwholesale.com" style="color:#9ca3af">lavender@pbfwholesale.com</a> · 603-748-3038<br>
    <a href="https://drinkpurpl.com" style="color:#9ca3af">drinkpurpl.com</a>&nbsp;·&nbsp;<a href="https://pumpkinblossomfarm.com" style="color:#9ca3af">pumpkinblossomfarm.com</a>
  </td></tr>

</table></td></tr></table></body></html>`;
}

function buildPurplInvoiceEmailHTML(inv) {
  const ac          = DB.a('ac').find(x => x.id === inv.accountId) || {};
  const invSettings = DB.obj('invoice_settings') || {};
  const itemCellStyle = 'padding:8px 0;font-size:13px;border-bottom:1px solid #f3f4f6';
  const itemRows = (inv.lineItems||[]).map(li => `<tr>
    <td style="${itemCellStyle}">${escHtml(li.skuName||li.sku||'Item')}</td>
    <td style="${itemCellStyle};text-align:right">${li.cases||li.qty||0} cs</td>
    <td style="${itemCellStyle};text-align:right">$${parseFloat(li.pricePerCase||li.unitPrice||0).toFixed(2)}/cs</td>
    <td style="${itemCellStyle};text-align:right;font-weight:500">$${parseFloat(li.lineTotal||0).toFixed(2)}</td>
  </tr>`).join('');
  const dueLabel = inv.due ? new Date(inv.due+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}) : 'Net 30';
  const portalLink = ac.orderPortalToken ? `https://purpl-crm.web.app/order?t=${ac.orderPortalToken}` : null;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0eff4;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0eff4;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:linear-gradient(135deg,#2D1B4E 0%,#4a2d7a 100%);padding:24px 40px">
    <table width="100%"><tr>
      <td><img src="https://static.wixstatic.com/media/81a2ff_1e3f6923c1d5495082d490b4cc229e1c~mv2.png/v1/fill/w_176,h_71,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Purpl%20Logo%20-%20Sprig%20in%20front%20-%20transparent.png" alt="purpl" width="100" height="40" style="display:block"></td>
      <td align="right"><div style="font-size:22px;font-weight:700;color:#fff">INVOICE</div><div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px">${escHtml(inv.number||'')}</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#8B5FBF;height:4px"></td></tr>
  <tr><td style="padding:24px 40px 0">
    <table width="100%"><tr>
      <td style="vertical-align:top;width:50%">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;margin-bottom:6px;font-weight:600">Billed To</div>
        <div style="font-size:15px;font-weight:600;color:#1a1a2e">${escHtml(ac.name||inv.accountName||'')}</div>
        ${ac.email ? `<div style="font-size:13px;color:#6b7280;margin-top:4px">${escHtml(ac.email)}</div>` : ''}
      </td>
      <td style="vertical-align:top;text-align:right">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;margin-bottom:6px;font-weight:600">Details</div>
        ${inv.date ? `<div style="font-size:13px;color:#6b7280">Issued: ${new Date(inv.date+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>` : ''}
        <div style="font-size:13px;color:#6b7280;margin-top:2px">Due: ${dueLabel}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:20px 40px 0">
    <table width="100%" cellpadding="0" cellspacing="0">
      <thead><tr>
        <th style="text-align:left;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Item</th>
        <th style="text-align:right;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Qty</th>
        <th style="text-align:right;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Price</th>
        <th style="text-align:right;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Total</th>
      </tr></thead>
      <tbody>${itemRows||`<tr><td colspan="4" style="font-size:13px;color:#9ca3af;padding:8px 0">purpl lemonade order</td></tr>`}</tbody>
    </table>
  </td></tr>
  <tr><td style="padding:16px 40px">
    <div style="background:#f9fafb;border-radius:8px;padding:16px 24px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:15px;font-weight:700;color:#1a1a2e">Total Due</div>
        <div style="font-size:24px;font-weight:700;color:#2D1B4E">$${parseFloat(inv.amount||0).toFixed(2)}</div>
      </div>
      ${invSettings.stripeLink ? `<div style="margin-top:14px;text-align:center"><a href="${escHtml(invSettings.stripeLink)}" style="display:inline-block;background:#2D1B4E;color:#fff;padding:10px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">Pay Now →</a></div>` : ''}
    </div>
  </td></tr>
  ${inv.notes ? `<tr><td style="padding:0 40px 16px;font-size:13px;color:#6b7280">${escHtml(inv.notes)}</td></tr>` : ''}
  ${portalLink ? `<tr><td style="padding:0 40px 16px;text-align:center"><a href="${portalLink}" style="font-size:13px;color:#8B5FBF;text-decoration:none">Place your next order →</a></td></tr>` : ''}
  <tr><td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#9ca3af;line-height:1.8">
    Pumpkin Blossom Farm LLC · 393 Pumpkin Hill Rd · Warner, NH 03278<br>
    <a href="mailto:lavender@pbfwholesale.com" style="color:#9ca3af">lavender@pbfwholesale.com</a> · 603-748-3038 ·
    <a href="https://drinkpurpl.com" style="color:#9ca3af">drinkpurpl.com</a>
  </td></tr>
</table></td></tr></table></body></html>`;
}

function buildLfInvoiceEmailHTML(inv) {
  const ac          = DB.a('ac').find(x => x.id === inv.accountId) || {};
  const invSettings = DB.obj('invoice_settings') || {};
  const itemCellStyle = 'padding:8px 0;font-size:13px;border-bottom:1px solid #f3f4f6';
  const itemRows = (inv.lineItems||[]).map(li => {
    if (li.hasVariants && li.variantLines) {
      return li.variantLines.map(vl => `<tr>
        <td style="${itemCellStyle}">${escHtml(li.skuName)} — ${escHtml(vl.variantName)}</td>
        <td style="${itemCellStyle};text-align:right">${vl.units||0}</td>
        <td style="${itemCellStyle};text-align:right">$${parseFloat(li.unitPrice||0).toFixed(2)}</td>
        <td style="${itemCellStyle};text-align:right;font-weight:500">$${parseFloat(vl.lineTotal||0).toFixed(2)}</td>
      </tr>`).join('');
    }
    return `<tr>
      <td style="${itemCellStyle}">${escHtml(li.skuName||'Item')}</td>
      <td style="${itemCellStyle};text-align:right">${li.units||0}</td>
      <td style="${itemCellStyle};text-align:right">$${parseFloat(li.unitPrice||0).toFixed(2)}</td>
      <td style="${itemCellStyle};text-align:right;font-weight:500">$${parseFloat(li.lineTotal||0).toFixed(2)}</td>
    </tr>`;
  }).join('');
  const dueLabel = inv.due ? new Date(inv.due+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}) : 'Net 30';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0eff4;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0eff4;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="background:linear-gradient(135deg,#2a5c3f 0%,#4a7c59 100%);padding:24px 40px">
    <table width="100%"><tr>
      <td><img src="https://purpl-crm.web.app/images/lf-logo-circle-transparent.png" alt="Lavender Fields" width="44" height="44" style="display:block;filter:brightness(0) invert(1)">
        <div style="font-size:13px;color:rgba(255,255,255,0.9);margin-top:8px;font-weight:600">Lavender Fields at Pumpkin Blossom Farm</div>
      </td>
      <td align="right"><div style="font-size:22px;font-weight:700;color:#fff">INVOICE</div><div style="font-size:12px;color:rgba(255,255,255,0.6);margin-top:4px">${escHtml(inv.number||'')}</div></td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#4a7c59;height:4px"></td></tr>
  <tr><td style="padding:24px 40px 0">
    <table width="100%"><tr>
      <td style="vertical-align:top;width:50%">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;margin-bottom:6px;font-weight:600">Billed To</div>
        <div style="font-size:15px;font-weight:600;color:#1a1a2e">${escHtml(ac.name||inv.accountName||'')}</div>
        ${ac.email ? `<div style="font-size:13px;color:#6b7280;margin-top:4px">${escHtml(ac.email)}</div>` : ''}
      </td>
      <td style="vertical-align:top;text-align:right">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#9ca3af;margin-bottom:6px;font-weight:600">Details</div>
        ${inv.issued ? `<div style="font-size:13px;color:#6b7280">Issued: ${new Date(inv.issued+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div>` : ''}
        <div style="font-size:13px;color:#6b7280;margin-top:2px">Due: ${dueLabel}</div>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:20px 40px 0">
    <table width="100%" cellpadding="0" cellspacing="0">
      <thead><tr>
        <th style="text-align:left;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Item</th>
        <th style="text-align:right;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Qty</th>
        <th style="text-align:right;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Price</th>
        <th style="text-align:right;font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;padding-bottom:8px">Total</th>
      </tr></thead>
      <tbody>${itemRows||`<tr><td colspan="4" style="font-size:13px;color:#9ca3af;padding:8px 0">Lavender Fields order</td></tr>`}</tbody>
    </table>
  </td></tr>
  <tr><td style="padding:16px 40px">
    <div style="background:#f9fafb;border-radius:8px;padding:16px 24px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="font-size:15px;font-weight:700;color:#1a1a2e">Total Due</div>
        <div style="font-size:24px;font-weight:700;color:#2a5c3f">$${parseFloat(inv.total||0).toFixed(2)}</div>
      </div>
      ${invSettings.stripeLink ? `<div style="margin-top:14px;text-align:center"><a href="${escHtml(invSettings.stripeLink)}" style="display:inline-block;background:#2a5c3f;color:#fff;padding:10px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">Pay Now →</a></div>` : ''}
    </div>
  </td></tr>
  ${inv.notes ? `<tr><td style="padding:0 40px 16px;font-size:13px;color:#6b7280">${escHtml(inv.notes)}</td></tr>` : ''}
  <tr><td style="background:#f9fafb;padding:20px 40px;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#9ca3af;line-height:1.8">
    Pumpkin Blossom Farm LLC · 393 Pumpkin Hill Rd · Warner, NH 03278<br>
    <a href="mailto:lavender@pbfwholesale.com" style="color:#9ca3af">lavender@pbfwholesale.com</a> · 603-748-3038 ·
    <a href="https://pumpkinblossomfarm.com" style="color:#9ca3af">pumpkinblossomfarm.com</a>
  </td></tr>
</table></td></tr></table></body></html>`;
}

// ── Combined invoice preview modal ────────────────────────

function openCombinedInvoicePreview(combinedId) {
  const rec = DB.a('combined_invoices').find(x => x.id === combinedId);
  if (!rec) return;

  const html     = buildCombinedInvoiceHTML(combinedId);
  const account  = DB.a('ac').find(x => x.id === rec.accountId) || {};
  const purplInv = DB.a('iv').find(x => x.id === rec.purplInvoiceId) || {};
  const lfInv    = DB.a('lf_invoices').find(x => x.id === rec.lfInvoiceId) || {};

  qs('#civ-account-name').textContent = rec.accountName;
  qs('#civ-invoice-nums').textContent = [purplInv.number, lfInv.number].filter(Boolean).join(' · ');
  qs('#civ-purpl-sub').textContent    = '$' + rec.purplSubtotal.toFixed(2);
  qs('#civ-lf-sub').textContent       = '$' + rec.lfSubtotal.toFixed(2);
  qs('#civ-grand-total').textContent  = '$' + rec.grandTotal.toFixed(2);

  qs('#civ-preview-frame').srcdoc = html;

  qs('#civ-btn-newtab').onclick = () => {
    const blob = new Blob([html], {type:'text/html'});
    window.open(URL.createObjectURL(blob), '_blank');
  };
  qs('#civ-btn-copy').onclick = () => {
    navigator.clipboard.writeText(html)
      .then(() => toast('HTML copied'))
      .catch(() => toast('Copy failed'));
  };
  qs('#civ-btn-gmail').onclick = () => {
    const subject = 'Invoice from Pumpkin Blossom Farm — ' + rec.accountName;
    const to = account.email || '';
    if (!to) { toast('No email address on file for this account'); return; }
    callSendCombinedInvoice(to, rec.accountName, subject, html)
      .then((result) => {
        toast('Invoice sent ✓');
        const invoiceRef = [purplInv.number, lfInv.number].filter(Boolean).join(' · ');
        const entry = {
          id: uid(), stage: 'invoice_sent',
          sentAt: new Date().toISOString(),
          sentBy: 'graham', method: 'resend',
          invoiceId: rec.id, invoiceRef,
        };
        if (result?.id) entry.sentMessageId = result.id;
        DB.update('ac', rec.accountId, a => ({
          ...a,
          lastContacted: today(),
          cadence: [...(a.cadence||[]), entry],
        }));
        renderAccounts();
        const updatedAc = DB.a('ac').find(x => x.id === rec.accountId);
        if (updatedAc) {
          renderAccountOutreach(updatedAc);
          renderMacEmailsTab(rec.accountId);
        }
      })
      .catch(() => {
        // Fall back to mailto
        window.open(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}`, '_blank');
      });
  };
  qs('#civ-btn-paid').onclick = () => {
    markCombinedPaid(combinedId);
    closeModal('modal-combined-invoice');
  };

  openModal('modal-combined-invoice');
}

// ── Manual combined invoice creation from account detail ──

function renderMacInvoicesTab(accountId) {
  const a       = DB.a('ac').find(x => x.id === accountId);
  const el      = qs('#mac-invoices-content');
  if (!el || !a) return;

  const purplInvs = DB.a('iv').filter(x => x.accountId === accountId);
  const lfInvs    = DB.a('lf_invoices').filter(x => x.accountId === accountId);
  const combined  = DB.a('combined_invoices').filter(x => x.accountId === accountId);

  const statBadge = (st, cls) => `<span class="badge ${cls||'gray'}" style="font-size:11px">${st}</span>`;
  const statColor = {paid:'green',draft:'gray',sent:'blue',overdue:'red',partial:'amber',unpaid:'blue'};

  const purplRows = purplInvs.length
    ? purplInvs.map(iv => `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px">
        <div>
          <span style="font-weight:600">${escHtml(iv.number||iv.invoiceNumber||'—')}</span>
          ${iv.combinedInvoiceId ? ' <span style="font-size:11px;color:var(--muted)">(combined)</span>' : ''}
          <div style="font-size:11px;color:var(--muted)">Due ${fmtD(iv.due||iv.dueDate)}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${statBadge(iv.status||'unpaid', statColor[iv.status]||'blue')}
          <strong>${fmtC(iv.amount||0)}</strong>
        </div>
      </div>`).join('')
    : '<div style="font-size:13px;color:var(--muted);padding:8px 0">No purpl invoices</div>';

  const lfRows = lfInvs.length
    ? lfInvs.map(inv => `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px">
        <div>
          <span style="font-weight:600">${escHtml(inv.number||'—')}</span>
          ${inv.combinedInvoiceId ? ' <span style="font-size:11px;color:var(--muted)">(combined)</span>' : ''}
          <div style="font-size:11px;color:var(--muted)">Due ${fmtD(inv.due)}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${statBadge(inv.status||'unpaid', LF_INV_STATUS[inv.status]?.cls||'gray')}
          <strong>${fmtC(inv.total||0)}</strong>
        </div>
      </div>`).join('')
    : '<div style="font-size:13px;color:var(--muted);padding:8px 0">No LF invoices</div>';

  const combinedRows = combined.length
    ? combined.map(ci => `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px">
        <div>
          <span style="font-weight:600">${fmtC(ci.grandTotal||0)}</span>
          <div style="font-size:11px;color:var(--muted)">purpl ${fmtC(ci.purplSubtotal||0)} + LF ${fmtC(ci.lfSubtotal||0)}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${statBadge(ci.status||'draft', ci.status==='paid'?'green':ci.status==='sent'?'blue':'amber')}
          <button class="btn xs" onclick="openCombinedInvoicePreview('${ci.id}')">Preview</button>
        </div>
      </div>`).join('')
    : '<div style="font-size:13px;color:var(--muted);padding:8px 0">No combined invoices</div>';

  // For isPbf accounts: build the manual creation selectors
  let manualSection = '';
  if (a.isPbf) {
    const unpaidPurpl = purplInvs.filter(x => x.status !== 'paid' && !x.combinedInvoiceId);
    const unpaidLf    = lfInvs.filter(x => x.status !== 'paid' && !x.combinedInvoiceId);
    if (unpaidPurpl.length && unpaidLf.length) {
      const purplOpts = unpaidPurpl.map(iv =>
        `<option value="${iv.id}">${escHtml(iv.number||iv.invoiceNumber||iv.id)} — ${fmtC(iv.amount||0)}</option>`).join('');
      const lfOpts = unpaidLf.map(inv =>
        `<option value="${inv.id}">${escHtml(inv.number||inv.id)} — ${fmtC(inv.total||0)}</option>`).join('');
      manualSection = `<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
        <div style="font-size:13px;font-weight:600;margin-bottom:10px">Create Combined Invoice</div>
        <div class="form-row col2">
          <div class="form-group">
            <label>purpl Invoice</label>
            <select id="civ-sel-purpl">${purplOpts}</select>
          </div>
          <div class="form-group">
            <label>LF Invoice</label>
            <select id="civ-sel-lf">${lfOpts}</select>
          </div>
        </div>
        <button class="btn primary" onclick="manualCreateCombined('${accountId}')">Create Combined Invoice</button>
      </div>`;
    }
  }

  el.innerHTML = `
    <div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--purple);margin-bottom:8px">purpl Invoices</div>
      ${purplRows}
    </div>
    ${a.isPbf ? `<div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#4a7c59;margin-bottom:8px">LF Invoices</div>
      ${lfRows}
    </div>
    <div style="margin-bottom:16px">
      <div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--amber,#d97706);margin-bottom:8px">Combined Invoices</div>
      ${combinedRows}
    </div>` : ''}
    ${manualSection}`;
}

function manualCreateCombined(accountId) {
  const purplId = qs('#civ-sel-purpl')?.value;
  const lfId    = qs('#civ-sel-lf')?.value;
  if (!purplId || !lfId) { toast('Select both invoices'); return; }
  const combinedId = createCombinedInvoice(purplId, lfId, accountId);
  if (!combinedId) return;
  toast('Combined invoice created');
  openCombinedInvoicePreview(combinedId);
}

// ── Wix pull modal ────────────────────────────────────────

function showWixPullModal(inv, deductionId) {
  _wixPullDeductionId = deductionId;
  _wixPullInvoiceId   = inv.id;
  const acEl = qs('#wix-pull-account');
  if (acEl) acEl.textContent = inv.accountName || '—';
  const numEl = qs('#wix-pull-inv-number');
  if (numEl) numEl.textContent = inv.number || '—';
  const itemsEl = qs('#wix-pull-items');
  if (itemsEl) {
    itemsEl.innerHTML = (inv.lineItems||[]).map(l => {
      if (l.hasVariants && l.variantLines?.length) {
        const varHtml = l.variantLines.map(vl => `
          <div style="display:flex;justify-content:space-between;padding:3px 0 3px 24px;font-size:12px;color:var(--muted)">
            <span>${escHtml(vl.variantName)}</span>
            <span>${vl.cases} case${vl.cases!==1?'s':''} (${vl.units} units)</span>
          </div>`).join('');
        return `
          <div style="padding:6px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:600">
              <span>${escHtml(l.skuName)}</span>
              <span>${l.cases} cases (${l.units} units)</span>
            </div>${varHtml}
          </div>`;
      }
      return `
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
          <span>${escHtml(l.skuName)}</span>
          <span><strong>${l.cases}</strong> case${l.cases!==1?'s':''} (${l.units} units)</span>
        </div>`;
    }).join('') || '<div style="color:var(--muted)">No items</div>';
  }
  openModal('modal-wix-pull');
}

function confirmWixPull(confirmed) {
  if (_wixPullDeductionId) {
    DB.update('lf_wix_deductions', _wixPullDeductionId, d => ({...d, confirmed}));
  }
  if (confirmed && _wixPullInvoiceId) {
    DB.update('lf_invoices', _wixPullInvoiceId, inv => ({...inv, wixPulled: true, wixPulledAt: today()}));
  }
  closeModal('modal-wix-pull');
  if (currentPage === 'invoices') renderInvoicesPage();
  renderLfDashKpis();
  toast(confirmed ? '✓ Wix pull confirmed' : 'Reminder set — pull when ready');
  _wixPullDeductionId = null;
  _wixPullInvoiceId   = null;
}

// ── LF KPIs on dashboard ──────────────────────────────────

function renderLfDashKpis() {
  const el = qs('#dash-lf-kpis');
  if (!el) return;
  const lfAc       = DB.a('ac').filter(a => !!a.isPbf).length;
  const lfInvs     = DB.a('lf_invoices');
  const outstanding = lfInvs
    .filter(i => i.status === 'unpaid' || i.status === 'overdue')
    .reduce((s,i) => s + (i.total||0), 0);
  const lfOverdue  = lfInvs.filter(i => i.status === 'overdue').length;
  const pendingWix = DB.a('lf_wix_deductions').filter(d => !d.confirmed).length;

  if (qs('#dash-kpi-lf-accounts'))    qs('#dash-kpi-lf-accounts').innerHTML    = kpiHtml('🌿 LF Accounts', lfAc, 'green');
  if (qs('#dash-kpi-lf-outstanding')) qs('#dash-kpi-lf-outstanding').innerHTML = kpiHtml('LF Outstanding', fmtC(outstanding), outstanding > 0 ? 'amber' : 'gray');
  if (qs('#dash-kpi-lf-overdue'))     qs('#dash-kpi-lf-overdue').innerHTML     = kpiHtml('LF Overdue', lfOverdue, lfOverdue > 0 ? 'red' : 'gray');
  if (qs('#dash-kpi-lf-wix'))         qs('#dash-kpi-lf-wix').innerHTML         = kpiHtml('Pending Wix Pulls', pendingWix, pendingWix > 0 ? 'amber' : 'gray');
}

// ══════════════════════════════════════════════════════════
//  ACCOUNT MIGRATIONS
// ══════════════════════════════════════════════════════════
function migrateAccountContacts() {
  if (!DB._firestoreReady) return;
  DB.a('ac').forEach(a => {
    if (!a.contacts || !a.contacts.length) {
      if (a.contact || a.email || a.phone) {
        DB.update('ac', a.id, x => ({
          ...x,
          contacts: [{id: uid(), name: x.contact||'', role:'', email: x.email||'', phone: x.phone||'', isPrimary: true}],
        }));
      }
    }
  });
}

// ══════════════════════════════════════════════════════════
//  PASTE-TO-CREATE ACCOUNT
// ══════════════════════════════════════════════════════════
let _pastePreviewData = null;

function openPasteAccountModal() {
  const inp = qs('#paste-ac-input');
  if (inp) inp.value = '';
  const prev = qs('#paste-ac-preview');
  if (prev) prev.innerHTML = '';
  const btn = qs('#paste-ac-confirm-btn');
  if (btn) btn.style.display = 'none';
  openModal('modal-paste-account');
}

function parsePasteRow(text) {
  const parts = text.includes('__') ? text.split('__') : text.split('\t');
  const [name='', phone='', email='', address='', city='', state='', dateContacted='', ...noteParts] = parts.map(s=>s.trim());
  const notes = noteParts.join(' ').trim();
  const fullAddress = [address, city, state].filter(Boolean).join(', ');
  return { name, phone, email, address: fullAddress, dateContacted, notes };
}

function previewPasteAccount() {
  const text = (qs('#paste-ac-input')?.value || '').trim();
  if (!text) { toast('Paste something first'); return; }
  const parsed = parsePasteRow(text);
  _pastePreviewData = parsed;
  const prev = qs('#paste-ac-preview');
  if (prev) {
    prev.innerHTML = `
      <div style="background:var(--surface-2,#f9f8ff);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:13px;display:flex;flex-direction:column;gap:4px">
        <div><strong>Name:</strong> ${escHtml(parsed.name)||'<em style="color:var(--muted)">blank</em>'}</div>
        ${parsed.phone?`<div><strong>Phone:</strong> ${escHtml(parsed.phone)}</div>`:''}
        ${parsed.email?`<div><strong>Email:</strong> ${escHtml(parsed.email)}</div>`:''}
        ${parsed.address?`<div><strong>Address:</strong> ${escHtml(parsed.address)}</div>`:''}
        ${parsed.dateContacted?`<div><strong>Date Contacted:</strong> ${escHtml(parsed.dateContacted)}</div>`:''}
        ${parsed.notes?`<div><strong>Notes:</strong> ${escHtml(parsed.notes)}</div>`:''}
      </div>`;
  }
  const btn = qs('#paste-ac-confirm-btn');
  if (btn) btn.style.display = '';
}

function confirmPasteAccount() {
  if (!_pastePreviewData) return;
  const d = _pastePreviewData;
  _pastePreviewData = null;
  closeModal('modal-paste-account');
  // Open edit modal with a fresh ID
  const newId = uid();
  editAccount(newId);
  // Pre-fill name
  if (qs('#eac-name')) qs('#eac-name').value = d.name;
  // Pre-fill contacts section with name + phone/email
  if (d.name || d.phone || d.email) {
    eacRenderContacts([{id: uid(), name: d.name||'', role:'', email: d.email||'', phone: d.phone||'', isPrimary: true}]);
  }
  // Pre-fill address into first location row
  const firstLocAddr = qs('#eac-locs-list .eac-loc-address');
  if (firstLocAddr && d.address) firstLocAddr.value = d.address;
}

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.onAppReady = function() {
  seedIfEmpty();
  migrateLfSkuVariants();
  migrateLfSkuPrices();
  restoreMyData(); // one-time: restores real accounts/prospects; guarded by _firestoreReady
  migrateAccountContacts(); // one-time: populates contacts[] array from single contact fields

  // Allow db.js real-time listener to refresh whichever page is open.
  // Also used to retry one-time migrations that were skipped because the
  // 10s startup timeout fired before Firestore data arrived.
  window.refreshCurrentPage = () => {
    migrateLfSkuVariants();
    restoreMyData();
    migrateAccountContacts();
    renders[currentPage]?.();
  };

  // Address autocomplete only activates on the territory map page

  // Wire nav links
  document.querySelectorAll('.sb-nav a[data-page]').forEach(a=>{
    a.addEventListener('click', ()=>nav(a.dataset.page));
  });

  // Wire modal close (click backdrop or ✕)
  document.querySelectorAll('.overlay').forEach(o=>{
    o.addEventListener('click', e=>{ if(e.target===o) closeModal(o.id); });
  });
  document.querySelectorAll('.modal-close').forEach(b=>{
    b.addEventListener('click', ()=>closeModal(b.closest('.overlay')?.id));
  });

  // Wire production buttons
  const saveRunBtn = qs('#save-run-btn');
  if (saveRunBtn) saveRunBtn.addEventListener('click', saveTodayRun);
  const addShipBtn = qs('#add-ship-btn');
  if (addShipBtn) addShipBtn.addEventListener('click', ()=>openModal('modal-shipment'));
  const saveShipBtn = qs('#save-ship-btn');
  if (saveShipBtn) saveShipBtn.addEventListener('click', saveShipment);

  // Wire order buttons
  const newOrdBtn = qs('#new-order-btn');
  if (newOrdBtn) newOrdBtn.addEventListener('click', ()=>openNewOrder(null));
  const acSelOrd = qs('#nord-account');
  if (acSelOrd) acSelOrd.addEventListener('change', populateOrderSkus);

  // Wire delivery
  const addStopBtn = qs('#add-stop-btn');
  if (addStopBtn) addStopBtn.addEventListener('click', addStop);
  const clearRouteBtn = qs('#clear-route-btn');
  if (clearRouteBtn) clearRouteBtn.addEventListener('click', clearRoute);

  // Wire settings
  const saveSetBtn = qs('#save-settings-btn');
  if (saveSetBtn) saveSetBtn.addEventListener('click', saveSettings);

  // Wire order filter
  document.querySelectorAll('#orders-filter .tab').forEach(t=>{
    t.addEventListener('click', ()=>{
      document.querySelectorAll('#orders-filter .tab').forEach(x=>x.classList.remove('active'));
      t.classList.add('active');
      ordFilter = t.dataset.status||'all';
      renderOrders();
    });
  });

  // Wire account SKU checkboxes → update par inputs
  const acSkuBox = qs('#eac-skus');
  if (acSkuBox) acSkuBox.addEventListener('change', ()=>{
    // Capture any par values already typed before rebuilding inputs
    const currentPar = {};
    SKUS.forEach(s=>{ const el=qs('#par-'+s.id); if(el) currentPar[s.id]=parseInt(el.value)||24; });
    renderParInputs({par: currentPar});
  });

  // Wire shipment SKU inputs
  if (qs('#modal-shipment')) {
    qs('#modal-shipment').querySelector('.sku-inputs')?.insertAdjacentHTML('beforeend',
      SKUS.map(s=>`<div class="sku-row ${s.bg}">${skuBadge(s.id)}<input type="number" id="ship-${s.id}" min="0" step="6" placeholder="0" style="width:80px"></div>`).join('')
    );
  }

  setupFilters();

  // ── Mobile hamburger + sidebar overlay ──────────────────
  const hamburger = qs('#topbar-hamburger');
  const sidebar   = qs('.sidebar');
  const overlay   = qs('#sidebar-overlay');
  function openMobileSidebar()  { sidebar?.classList.add('mobile-open');  overlay?.classList.add('open'); }
  function closeMobileSidebar() { sidebar?.classList.remove('mobile-open'); overlay?.classList.remove('open'); }
  if (hamburger) hamburger.addEventListener('click', openMobileSidebar);
  if (overlay)   overlay.addEventListener('click', closeMobileSidebar);
  // Close sidebar after navigating on mobile
  document.querySelectorAll('.sb-nav a[data-page]').forEach(a=>{
    a.addEventListener('click', ()=>{ if(window.innerWidth<768) closeMobileSidebar(); });
  });

  // ── Mobile bottom nav ────────────────────────────────────
  document.querySelectorAll('.mobile-bottom-nav a[data-page]').forEach(a=>{
    a.addEventListener('click', ()=>{
      document.querySelectorAll('.mobile-bottom-nav a').forEach(x=>x.classList.remove('active'));
      a.classList.add('active');
      nav(a.dataset.page);
    });
  });

  // Sync mobile bottom nav active state with sidebar nav
  const _originalNav = nav;

  // Navigate to dashboard
  nav('dashboard');
};

// ══════════════════════════════════════════════════════════
//  TERRITORY MAP  (Phase 8)
// ══════════════════════════════════════════════════════════

let _mapInstance    = null;
let _mapMarkers     = [];
let _mapRunMode     = false;
let _mapClusterer   = null;
let _mapDistLayers  = {};       // distId -> boolean (visible)
let _mapCoverageOverlays = [];  // google.maps.Circle or Polygon instances

function renderMap() {
  if (!window.GOOGLE_PLACES_KEY) {
    qs('#map-no-key')?.style && (qs('#map-no-key').style.display='flex');
    return;
  }
  qs('#map-no-key')?.style && (qs('#map-no-key').style.display='none');

  PlacesAC.load().then(ok=>{
    if (!ok) return;
    if (_mapInstance) { _renderMapPins(); return; }

    _mapInstance = new google.maps.Map(qs('#map-canvas'), {
      center: { lat: 42.3601, lng: -71.0589 }, // Boston default
      zoom: 9,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
    });
    _renderMapPins();
    _renderDistMapLegend();
  });
}

const MAP_PIN_COLORS = {
  account:     '#8b5cf6', // purple — direct
  accountDist: '#d97706', // amber  — via distributor
  prospect:    '#3b82f6', // blue
  run:         '#10b981', // green
};

function _renderMapPins() {
  if (!_mapInstance) return;

  // Clear existing markers
  _mapMarkers.forEach(m=>m.setMap(null));
  _mapMarkers = [];

  const bounds = new google.maps.LatLngBounds();
  let hasPoints = false;

  const addPin = (lat, lng, opts) => {
    if (!lat||!lng||isNaN(lat)||isNaN(lng)) return;
    const marker = new google.maps.Marker({
      position: { lat, lng },
      map: _mapInstance,
      title: opts.name,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 9,
        fillColor: opts.color,
        fillOpacity: 0.9,
        strokeColor: '#fff',
        strokeWeight: 2,
      },
    });

    // Info window
    const iw = new google.maps.InfoWindow({ content: `
      <div style="font-family:sans-serif;min-width:160px">
        <div style="font-weight:700;font-size:14px;margin-bottom:4px">${opts.name}</div>
        <div style="font-size:12px;color:#666">${opts.sub||''}</div>
        ${opts.action?`<div style="margin-top:8px"><a href="#" onclick="${opts.action};return false" style="color:#8b5cf6;font-weight:600;font-size:12px">${opts.actionLabel||'View'}</a></div>`:''}
        ${opts.action2&&opts.actionLabel2?`<div style="margin-top:4px"><a href="#" onclick="${opts.action2};return false" style="color:#d97706;font-weight:600;font-size:12px">${opts.actionLabel2}</a></div>`:''}
        ${_mapRunMode&&opts.runAction?`<div style="margin-top:4px"><a href="#" onclick="${opts.runAction};return false" style="color:#10b981;font-weight:600;font-size:12px">+ Add to Run</a></div>`:''}
      </div>` });

    marker.addListener('click', ()=> iw.open(_mapInstance, marker));

    if (_mapRunMode && opts.runAction) {
      marker.addListener('dblclick', ()=>{ eval(opts.runAction); });
    }

    _mapMarkers.push(marker);
    bounds.extend({ lat, lng });
    hasPoints = true;
  };

  // Accounts — plot each location as its own pin; color by fulfillment
  {
    DB.a('ac').filter(a=>a.status==='active').forEach(a=>{
      const locs = (a.locs && a.locs.length) ? a.locs
        : (a.lat && a.lng ? [{id:'legacy', label:'', address:a.address||'', lat:a.lat, lng:a.lng, dropOffRules:''}] : []);
      const isDistFulfilled = a.fulfilledBy && a.fulfilledBy !== 'direct';
      const distName = isDistFulfilled ? DB.a('dist_profiles').find(d=>d.id===a.fulfilledBy)?.name : null;
      const pinColor = isDistFulfilled ? MAP_PIN_COLORS.accountDist : MAP_PIN_COLORS.account;
      locs.filter(l=>l.lat&&l.lng).forEach(l=>{
        const pinName = locs.length > 1 ? `${a.name} – ${l.label||l.address||'Location'}` : a.name;
        addPin(parseFloat(l.lat), parseFloat(l.lng), {
          name: pinName,
          sub: isDistFulfilled ? `via ${distName||'distributor'} · ${l.address||a.type||''}` : (l.address||a.type||''),
          color: pinColor,
          action: `openAccount('${a.id}')`,
          actionLabel: 'View Account',
          actionLabel2: isDistFulfilled && distName ? `View ${distName}` : null,
          action2: isDistFulfilled ? `openDistributor('${a.fulfilledBy}')` : null,
          runAction: `mapAddToRun('${a.id}')`,
        });
      });
    });
  }

  // Prospects
  {
    DB.a('pr').filter(p=>!['won','lost'].includes(p.status)&&p.lat&&p.lng).forEach(p=>{
      addPin(parseFloat(p.lat), parseFloat(p.lng), {
        name: p.name,
        sub: p.address||p.type||'',
        color: MAP_PIN_COLORS.prospect,
        action: `editProspect('${p.id}')`,
        actionLabel: 'View Prospect',
      });
    });
  }

  // Today's run stops
  {
    const run = DB.obj('today_run', {stops:[]});
    (run.stops||[]).filter(s=>s.lat&&s.lng).forEach(s=>{
      addPin(parseFloat(s.lat), parseFloat(s.lng), {
        name: s.name,
        sub: s.address||'',
        color: MAP_PIN_COLORS.run,
      });
    });
  }

  // Distributor DC pins + coverage overlays
  _clearCoverageOverlays();
  // Assign a distinct color per distributor (cycle through palette)
  const DIST_PIN_PALETTE = ['#e11d48','#0891b2','#16a34a','#9333ea','#ea580c','#0d9488'];
  DB.a('dist_profiles').filter(d=>['active','submitted','under_review'].includes(d.status)).forEach((d,idx)=>{
    const visible = _mapDistLayers[d.id] !== false; // default visible
    if (!visible) return;
    const color = DIST_PIN_PALETTE[idx % DIST_PIN_PALETTE.length];
    // DC pin — larger, distinct icon
    if (d.dcLat && d.dcLng) {
      const lat = parseFloat(d.dcLat), lng = parseFloat(d.dcLng);
      if (!isNaN(lat)&&!isNaN(lng)) {
        const marker = new google.maps.Marker({
          position: {lat, lng},
          map: _mapInstance,
          title: `${d.name} DC`,
          icon: {
            path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW,
            scale: 7,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 2,
          },
          zIndex: 999,
        });
        const iw = new google.maps.InfoWindow({ content: `
          <div style="font-family:sans-serif;min-width:160px">
            <div style="font-weight:700;font-size:14px;margin-bottom:4px">🏭 ${escHtml(d.name)}</div>
            <div style="font-size:12px;color:#666">${escHtml(d.dcAddress||'Distribution Center')}</div>
            <div style="font-size:11px;color:#999;margin-top:3px">${d.doorCount||0} doors · ${d.territory||''}</div>
            <div style="margin-top:8px"><a href="#" onclick="openDistributor('${d.id}');return false" style="color:${color};font-weight:600;font-size:12px">View Distributor</a></div>
          </div>` });
        marker.addListener('click', ()=>iw.open(_mapInstance, marker));
        _mapMarkers.push(marker);
        bounds.extend({lat, lng});
        hasPoints = true;
        // Coverage circle for radius-type territory
        if (d.territoryRadiusMiles && d.territoryRadiusMiles > 0) {
          const circle = new google.maps.Circle({
            map: _mapInstance,
            center: {lat, lng},
            radius: d.territoryRadiusMiles * 1609.34,
            fillColor: color,
            fillOpacity: 0.07,
            strokeColor: color,
            strokeOpacity: 0.4,
            strokeWeight: 1.5,
          });
          _mapCoverageOverlays.push(circle);
        }
      }
    }
  });

  if (hasPoints) _mapInstance.fitBounds(bounds);
  _updateRunModeBar();
  _renderDistMapLegend();
}

function _clearCoverageOverlays() {
  _mapCoverageOverlays.forEach(o=>o.setMap(null));
  _mapCoverageOverlays = [];
}

function _renderDistMapLegend() {
  const legend = qs('#map-dist-legend');
  if (!legend) return;
  const DIST_PIN_PALETTE = ['#e11d48','#0891b2','#16a34a','#9333ea','#ea580c','#0d9488'];
  const dists = DB.a('dist_profiles').filter(d=>['active','submitted','under_review'].includes(d.status));
  if (!dists.length) { legend.innerHTML=''; return; }
  legend.innerHTML = `
    <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
      <div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--muted)">Distributors</div>
      <div style="display:flex;flex-direction:column;gap:4px">
        ${dists.map((d,idx)=>{
          const color = DIST_PIN_PALETTE[idx%DIST_PIN_PALETTE.length];
          const visible = _mapDistLayers[d.id] !== false;
          return `<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="checkbox" ${visible?'checked':''} onchange="toggleDistMapLayer('${d.id}',this.checked)" style="accent-color:${color}">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></span>
            ${escHtml(d.name)}
          </label>`;
        }).join('')}
      </div>
      <div style="margin-top:8px;display:flex;gap:12px;font-size:11px;color:var(--muted)">
        <span>▲ DC location</span>
        <span>● Account (direct)</span>
        <span style="color:#d97706">● Account (via dist)</span>
      </div>
    </div>`;
}

function toggleDistMapLayer(distId, visible) {
  _mapDistLayers[distId] = visible;
  if (_mapInstance) _renderMapPins();
}

function toggleMapRunMode() {
  _mapRunMode = !_mapRunMode;
  const btn = qs('#map-run-mode-btn');
  if (btn) {
    btn.textContent = _mapRunMode ? '✕ Exit Run Mode' : 'Route Builder Mode';
    btn.classList.toggle('primary', !_mapRunMode);
    btn.classList.toggle('green', _mapRunMode);
  }
  const bar = qs('#map-run-bar');
  if (bar) bar.style.display = _mapRunMode ? '' : 'none';
  _renderMapPins();
}

function mapAddToRun(accountId) {
  const a = DB.a('ac').find(x=>x.id===accountId);
  if (!a) return;
  const run = DB.obj('today_run', {stops:[]});
  const already = (run.stops||[]).find(s=>s.accountId===accountId);
  if (already) { toast('Already on today\'s run'); return; }
  const stop = {
    id: uid(),
    name: a.name,
    accountId: a.id,
    address: a.address||'',
    lat: a.lat||'',
    lng: a.lng||'',
    notes: '',
    done: false,
  };
  // Pre-fill par quantities per SKU (stored as cases), matching addStop() format
  SKUS.forEach(s=>{
    const parCans = a.par?.[s.id] || 0;
    stop[s.id] = parCans > 0 ? Math.ceil(parCans / CANS_PER_CASE) : 0;
  });
  DB.atomicUpdate(d=>{ d.today_run=d.today_run||{stops:[]}; d.today_run.stops=[...(d.today_run.stops||[]),stop]; return d; });
  _updateRunModeBar();
  toast(`${a.name} added to run`);
}

function _updateRunModeBar() {
  const run = DB.obj('today_run', {stops:[]});
  const cnt = (run.stops||[]).length;
  const el = qs('#map-run-count');
  if (el) el.textContent = cnt ? `${cnt} stop${cnt!==1?'s':''} in today's run` : '';
}

// ══════════════════════════════════════════════════════════
//  WHOLESALE ORDER PORTAL — CRM SIDE (Phases 3–6)
// ══════════════════════════════════════════════════════════


// ── PortalDB — direct Firestore access for portal collections ──
// Uses firebase compat SDK (loaded in index.html) directly.
const PortalDB = {
  _orders: [],
  _notify: [],
  _loaded: false,

  _db() { return firebase.firestore(); },

  async load() {
    try {
      const [ordSnap, notSnap] = await Promise.all([
        this._db().collection('portal_orders').get(),
        this._db().collection('portal_notify').get(),
      ]);
      this._orders = ordSnap.docs.map(d => ({ id: d.id, ...d.data(),
        submittedAt: d.data().submittedAt?.toDate?.() || null }));
      this._orders.sort((a,b) => (b.submittedAt||0) - (a.submittedAt||0));
      this._notify = notSnap.docs.map(d => ({ id: d.id, ...d.data(),
        submittedAt: d.data().submittedAt?.toDate?.() || null }));
      this._loaded = true;
    } catch(e) {
      console.error('PortalDB.load error:', e);
    }
    return this;
  },

  async setToken(token, data) {
    await this._db().collection('portal_tokens').doc(token).set({
      ...data, createdAt: new Date().toISOString()
    });
  },

  async saveConfig(config) {
    await this._db().collection('portal_config').doc('main').set(config);
  },

  async getConfig() {
    try {
      const snap = await this._db().collection('portal_config').doc('main').get();
      return snap.exists ? snap.data() : { mode:'preorder', pricePerCase:null, deadlineEnabled:false, deadline:null };
    } catch(e) { return { mode:'preorder', pricePerCase:null, deadlineEnabled:false, deadline:null }; }
  },

  async updateOrder(id, data) {
    await this._db().collection('portal_orders').doc(id).update(data);
    const idx = this._orders.findIndex(o => o.id === id);
    if (idx >= 0) this._orders[idx] = { ...this._orders[idx], ...data };
  },

  getOrders() { return this._orders; },
  getNotify() { return this._notify; },
  getAccountOrders(accountId) { return this._orders.filter(o => o.accountId === accountId); },
};

// ── Phase 3: Link generator ────────────────────────────────

async function generateOrderLink(entityId, entityName, entityEmail, entityType) {
  entityType = entityType || 'accounts';
  try {
    const token = btoa(entityId + ':' + Math.random().toString(36).slice(2))
      .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    await firebase.firestore().collection(entityType).doc(entityId).set({
      orderPortalToken: token,
      name: entityName,
      email: entityEmail || '',
      orderPortalTokenCreatedAt: new Date().toISOString().slice(0,10)
    }, { merge: true });
    const link = window.location.origin + '/order?t=' + token;
    await navigator.clipboard.writeText(link);
    toast('Order link copied ✓');
  } catch(e) {
    console.error(e);
    toast('Error generating link');
  }
}

async function copyOrderLink(accountId) {
  const accounts = DB.a('ac');
  const account = accounts.find(a => a.id === accountId);
  if (!account) { toast('Account not found'); return; }
  await generateOrderLink(accountId, account.name, account.email || '');
}

// ── Phase 4: Pre-Orders page ──────────────────────────────

let _poCurrentTab = 'all';

async function renderPreOrders(forceReload) {
  const el = qs('#page-pre-orders');
  if (!el) return;
  if (forceReload || !PortalDB._loaded) {
    qs('#po-kpis').innerHTML = '<div style="color:var(--muted);font-size:13px;grid-column:1/-1">Loading portal orders…</div>';
    await PortalDB.load();
  }
  _renderPoKpis();
  _renderPoTabs();
  _switchPoTab(_poCurrentTab);
}

function _renderPoKpis() {
  const orders = PortalDB.getOrders();
  const total   = orders.length;
  const matched = orders.filter(o => o.isMatched).length;
  const unmatched = orders.filter(o => !o.isMatched).length;
  const totalCases = orders.reduce((s,o) => {
    return s + (o.items||[]).reduce((ss,i) => ss + (i.cases||0), 0);
  }, 0);
  const totalCans = totalCases * CANS_PER_CASE;
  const multiFlag = orders.filter(o => o.hasMultipleSubmissions).length;

  const kpiHtml = (label, val, sub, cls) => `<div class="kpi-card kpi-${cls||'gray'}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${val}</div>
    ${sub?`<div class="kpi-sub">${sub}</div>`:''}
  </div>`;

  const el = qs('#po-kpis');
  if (el) el.innerHTML =
    kpiHtml('Total Submissions', total, '', 'purple') +
    kpiHtml('Matched Accounts', matched, '', 'green') +
    kpiHtml('Unmatched', unmatched, '', unmatched>0?'amber':'gray') +
    kpiHtml('Total Cases', fmt(totalCases), `${fmt(totalCans)} cans · ${CANS_PER_CASE} cans/case`, 'blue') +
    (multiFlag ? kpiHtml('Multiple Submissions', multiFlag, 'same account/email', 'amber') : '');
}

function _renderPoTabs() {
  document.querySelectorAll('#po-tabs .tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('#po-tabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      _poCurrentTab = t.dataset.poTab;
      _switchPoTab(_poCurrentTab);
    };
  });
}

function _switchPoTab(tab) {
  ['all','unmatched','confirmed','notify','links','lf'].forEach(id => {
    const el = qs(`#po-pane-${id}`);
    if (el) el.style.display = id === tab ? '' : 'none';
  });
  if (tab === 'all')       _renderPoAll();
  if (tab === 'unmatched') _renderPoUnmatched();
  if (tab === 'confirmed') _renderPoConfirmed();
  if (tab === 'notify')    _renderPoNotify();
  if (tab === 'links')     _renderPoLinks();
  if (tab === 'lf')        _renderPoLf();
}

const PO_STATUS_LABELS = {
  new:'New', reviewed:'Reviewed', confirmed:'Confirmed', declined:'Declined'
};
const PO_STATUS_CLS = {
  new:'amber', reviewed:'blue', confirmed:'green', declined:'red'
};

function _poStatusBadge(s) {
  const cls = PO_STATUS_CLS[s]||'gray';
  return `<span class="badge ${cls}">${PO_STATUS_LABELS[s]||s}</span>`;
}

function _fmtPoDate(d) {
  if (!d) return '—';
  if (d instanceof Date) return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
  return d;
}

function _renderPoAll() {
  const el = qs('#po-pane-all');
  if (!el) return;
  const orders = PortalDB.getOrders();
  if (!orders.length) {
    el.innerHTML = '<div class="card"><div class="empty" style="padding:32px">No portal submissions yet.</div></div>';
    return;
  }
  el.innerHTML = `<div class="card"><div class="tbl-wrap"><table>
    <thead><tr>
      <th>Submitted</th><th>Account</th><th>Match</th>
      <th>Cases</th><th>Cans</th><th>Delivery Window</th><th>PO#</th>
      <th>Distributor</th><th>Status</th><th>Flags</th><th>Actions</th>
    </tr></thead>
    <tbody>${orders.map(o => {
      const cases = (o.items||[]).reduce((s,i)=>s+(i.cases||0),0);
      const cans  = cases * CANS_PER_CASE;
      const acLink = o.isMatched && o.accountId
        ? `<strong style="cursor:pointer;color:var(--lavblue)" onclick="openAccount('${o.accountId}')">${escHtml(o.accountName||'')}</strong>`
        : escHtml(o.accountName||'');
      const multiFlag = o.hasMultipleSubmissions
        ? `<span class="badge amber">↻ Updated</span>` : '';
      return `<tr>
        <td style="white-space:nowrap;font-size:12px">${_fmtPoDate(o.submittedAt)}</td>
        <td>${acLink}</td>
        <td>${o.isMatched ? '<span class="badge green">✓ Matched</span>' : '<span class="badge red">? Unmatched</span>'}</td>
        <td>${cases||'—'}</td>
        <td>${cans||'—'}</td>
        <td style="font-size:12px">${escHtml(o.deliveryWindow||'—')}</td>
        <td style="font-size:12px">${escHtml(o.poNumber||'—')}</td>
        <td style="font-size:12px">${escHtml(o.distributor||'—')}</td>
        <td>${_poStatusBadge(o.status||'new')}</td>
        <td>${multiFlag}</td>
        <td style="white-space:nowrap">
          <button class="btn xs" onclick="reviewPortalOrder('${o.id}')">Review</button>
          ${o.status!=='confirmed'&&o.status!=='declined'&&o.isMatched
            ? `<button class="btn xs primary" onclick="openConfirmPortalOrder('${o.id}')">Confirm</button>` : ''}
          ${o.status!=='declined'&&o.status!=='confirmed'
            ? `<button class="btn xs red" onclick="declinePortalOrder('${o.id}')">Decline</button>` : ''}
          <button class="btn xs red" onclick="deletePortalOrder('${o.id}')">✕</button>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div></div>`;
}

function _renderPoUnmatched() {
  const el = qs('#po-pane-unmatched');
  if (!el) return;
  const orders = PortalDB.getOrders().filter(o => !o.isMatched);
  if (!orders.length) {
    el.innerHTML = '<div class="card"><div class="empty" style="padding:32px">No unmatched submissions.</div></div>';
    return;
  }
  el.innerHTML = `<div class="card"><div class="tbl-wrap"><table>
    <thead><tr><th>Submitted</th><th>Business Name</th><th>Email</th><th>Cases</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>${orders.map(o => {
      const cases = (o.items||[]).reduce((s,i)=>s+(i.cases||0),0);
      return `<tr>
        <td style="font-size:12px">${_fmtPoDate(o.submittedAt)}</td>
        <td>${escHtml(o.accountName||'')}</td>
        <td style="font-size:12px">${escHtml(o.billingEmail||'')}</td>
        <td>${cases||'—'}</td>
        <td>${_poStatusBadge(o.status||'new')}</td>
        <td style="white-space:nowrap">
          <button class="btn xs" onclick="reviewPortalOrder('${o.id}')">Review &amp; Link</button>
          <button class="btn xs" onclick="createProspectFromPoId('${o.id}')">→ Prospect</button>
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div></div>`;
}

function _renderPoConfirmed() {
  const el = qs('#po-pane-confirmed');
  if (!el) return;
  const orders = PortalDB.getOrders().filter(o => o.status === 'confirmed');
  if (!orders.length) {
    el.innerHTML = '<div class="card"><div class="empty" style="padding:32px">No confirmed orders yet.</div></div>';
    return;
  }
  el.innerHTML = `<div class="card"><div class="tbl-wrap"><table>
    <thead><tr><th>Submitted</th><th>Account</th><th>Cases</th><th>Confirmed</th><th>Order ID</th></tr></thead>
    <tbody>${orders.map(o => {
      const cases = (o.items||[]).reduce((s,i)=>s+(i.cases||0),0);
      const confirmDate = o.confirmedAt instanceof Date ? fmtD(o.confirmedAt.toISOString().slice(0,10)) : (o.confirmedAt||'—');
      return `<tr>
        <td style="font-size:12px">${_fmtPoDate(o.submittedAt)}</td>
        <td>${o.isMatched&&o.accountId
          ? `<span style="cursor:pointer;color:var(--lavblue)" onclick="openAccount('${o.accountId}')">${escHtml(o.accountName||'')}</span>`
          : escHtml(o.accountName||'')}</td>
        <td>${cases}</td>
        <td style="font-size:12px">${confirmDate}</td>
        <td style="font-size:11px;color:var(--muted)">${o.convertedOrderId||'—'}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div></div>`;
}

function _renderPoNotify() {
  const el = qs('#po-pane-notify');
  if (!el) return;
  const notifyList = PortalDB.getNotify();
  if (!notifyList.length) {
    el.innerHTML = '<div class="card"><div class="empty" style="padding:32px">No notification signups yet.</div></div>';
    return;
  }
  el.innerHTML = `<div class="card">
    <div class="section-hdr" style="margin-bottom:12px">
      <h2>Coming Soon Notification Signups</h2>
      <button class="btn sm" onclick="_exportNotifyCSV()">Export CSV</button>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Email</th><th>Flavor</th><th>Account</th><th>Submitted</th></tr></thead>
      <tbody>${notifyList.map(n => `<tr>
        <td>${escHtml(n.email||'')}</td>
        <td>${skuBadge(n.sku||'')}</td>
        <td>${n.accountName ? escHtml(n.accountName) : '<span style="color:var(--muted)">—</span>'}</td>
        <td style="font-size:12px">${_fmtPoDate(n.submittedAt)}</td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;
}

function _exportNotifyCSV() {
  const rows = [['Email','Flavor','Account Name','Submitted']];
  PortalDB.getNotify().forEach(n => {
    rows.push([n.email||'', n.sku||'', n.accountName||'', n.submittedAt ? n.submittedAt.toISOString().slice(0,10) : '']);
  });
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv,' + encodeURIComponent(csv);
  a.download = 'portal-notify-list.csv';
  a.click();
}

function _renderPoLinks() {
  const el = qs('#po-pane-links');
  if (!el) return;
  el.innerHTML = '<div style="padding:16px;color:var(--muted)">Loading...</div>';
  firebase.firestore().collection('accounts').get()
    .then(snap => {
      const allAc  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      const orders = PortalDB.getOrders();

      // Show all accounts (with and without token)
      const rows = allAc.map(a => {
        const token = a.orderPortalToken;
        const url   = token ? `https://purpl-crm.web.app/order?t=${token}` : null;
        const subs  = orders.filter(o => o.accountId === a.id);
        return { a, token, url, subCount: subs.length };
      });

      el.innerHTML = `<div class="card">
    <div class="section-hdr" style="margin-bottom:12px">
      <h2>All Account Links</h2>
      <span style="font-size:12px;color:var(--muted)">${rows.filter(r=>r.token).length} links generated</span>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Account</th><th>Link</th><th>Generated</th><th>Submitted</th><th>Actions</th></tr></thead>
      <tbody>${rows.map(({a, token, url, subCount}) => `<tr>
        <td><strong>${escHtml(a.name)}</strong></td>
        <td style="font-size:11px;color:var(--muted)">
          ${url ? `<span style="cursor:pointer;color:var(--lavblue)" onclick="generateOrderLink('${a.id}','${a.name}','${a.email||''}')" title="${url}">${url.slice(0,50)}…</span>` : '<span style="color:var(--muted)">Not generated yet</span>'}
        </td>
        <td style="font-size:12px">${a.orderPortalTokenCreatedAt ? fmtD(a.orderPortalTokenCreatedAt) : '—'}</td>
        <td>${subCount > 0
          ? `<span class="badge green">Yes (${subCount})</span>`
          : '<span class="badge gray">No</span>'}</td>
        <td><button class="btn xs" onclick="generateOrderLink('${a.id}','${a.name}','${a.email||''}')">🔗 Copy Link</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;
    })
    .catch(e => {
      console.error('_renderPoLinks error:', e);
      el.innerHTML = '<div style="padding:16px;color:var(--red)">Failed to load accounts.</div>';
    });
}

// ── LF Submissions tab ────────────────────────────────────
function _renderPoLf() {
  const el = qs('#po-pane-lf');
  if (!el) return;
  el.innerHTML = '<div style="padding:16px;color:var(--muted)">Loading LF submissions…</div>';
  firebase.firestore().collection('portal_orders')
    .where('brand', '==', 'lf')
    .orderBy('submittedAt', 'desc')
    .limit(100)
    .get()
    .then(snap => {
      const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!orders.length) {
        el.innerHTML = '<div class="card"><div style="padding:24px;text-align:center;color:var(--muted)">No LF portal submissions yet.</div></div>';
        return;
      }
      el.innerHTML = `<div class="card">
        <div class="section-hdr" style="margin-bottom:12px"><h2>🌿 LF Form Submissions</h2></div>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Date</th><th>Account</th><th>Items</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>${orders.map(o => {
            const dt = o.submittedAt?.toDate ? o.submittedAt.toDate().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—';
            const items = (o.lineItems||[]).map(i=>`${escHtml(i.skuName||'?')} ×${i.cases}`).join(', ');
            const total = fmtC(o.total||0);
            const stCls = o.status === 'pending' ? 'amber' : o.status === 'discarded' ? 'red' : 'green';
            return `<tr>
              <td style="font-size:12px">${dt}</td>
              <td><strong>${escHtml(o.accountName||'—')}</strong><br><span style="font-size:11px;color:var(--muted)">${o.billingEmail||''}</span></td>
              <td style="font-size:12px">${items||'—'}</td>
              <td style="font-weight:600">${total}</td>
              <td><span class="badge ${stCls}" style="font-size:10px">${o.status||'pending'}</span></td>
              <td>
                <div style="display:flex;gap:4px;flex-wrap:wrap">
                  ${o.status !== 'discarded' ? `<button class="btn xs primary" onclick="createLfInvoiceFromPortal('${o.id}')">Create Invoice</button>` : ''}
                  ${!o.accountId ? `<button class="btn xs secondary" onclick="linkPortalLfToAccount('${o.id}')">Link Account</button>` : ''}
                  ${o.status !== 'discarded' ? `<button class="btn xs red" onclick="discardLfPortalOrder('${o.id}')">Discard</button>` : ''}
                </div>
              </td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>
      </div>`;
    })
    .catch(e => {
      el.innerHTML = '<div style="padding:16px;color:var(--red)">Failed to load LF submissions: '+escHtml(e.message)+'</div>';
    });
}

function createLfInvoiceFromPortal(portalOrderId) {
  firebase.firestore().collection('portal_orders').doc(portalOrderId).get()
    .then(doc => {
      if (!doc.exists) { toast('Order not found'); return; }
      const o = doc.data();
      nav('invoices');
      // Open blank new invoice modal, then fill in from portal order data
      setTimeout(() => {
        openLfInvoiceModal(null);
        // Set account if known
        const acSel = qs('#lfi-account');
        if (acSel && o.accountId) acSel.value = o.accountId;
        // Set notes
        if (qs('#lfi-notes')) qs('#lfi-notes').value = 'From portal: ' + (o.billingEmail||'');
        // Clear default line items and add portal items
        const tbody = qs('#lfi-line-items');
        if (tbody) {
          tbody.innerHTML = '';
          (o.lineItems||[]).forEach(it => {
            lfInvAddLineItem();
            // find the last row added and fill it
            const rows = tbody.querySelectorAll('[data-row-id]');
            const lastRow = rows[rows.length-1];
            if (!lastRow) return;
            const rowId = lastRow.dataset.rowId;
            // Set SKU name and price manually
            const skuSel = qs('#lfi-sku-'+rowId);
            if (skuSel) {
              // Try to find matching SKU by name
              const matchOpt = Array.from(skuSel.options).find(opt => opt.text.includes(it.skuName||''));
              if (matchOpt) {
                skuSel.value = matchOpt.value;
                skuSel.dispatchEvent(new Event('change'));
              }
            }
            const casesEl = qs('#lfi-cases-'+rowId);
            if (casesEl) { casesEl.value = it.cases||0; _lfInvRowCalc(rowId); }
            const priceEl = qs('#lfi-price-'+rowId);
            if (priceEl && it.unitPrice) { priceEl.value = parseFloat(it.unitPrice).toFixed(2); _lfInvRowCalc(rowId); }
          });
          _lfInvCalcTotal();
        }
      }, 350);
    })
    .catch(e => toast('Error: '+e.message));
}

function linkPortalLfToAccount(portalOrderId) {
  const accounts = DB.a('ac').filter(a=>a.status==='active');
  const sel = accounts.map(a=>`${a.id}|${a.name}`).join('\n');
  const chosen = window.prompt('Enter account name to link:\n\n'+accounts.map(a=>a.name).join('\n'));
  if (!chosen) return;
  const ac = accounts.find(a=>a.name.toLowerCase()===chosen.toLowerCase().trim());
  if (!ac) { toast('Account not found'); return; }
  firebase.firestore().collection('portal_orders').doc(portalOrderId)
    .update({ accountId: ac.id, accountName: ac.name })
    .then(() => { toast('Linked to '+ac.name); _renderPoLf(); })
    .catch(e => toast('Error: '+e.message));
}

function discardLfPortalOrder(portalOrderId) {
  if (!confirm2('Mark this LF submission as discarded?')) return;
  firebase.firestore().collection('portal_orders').doc(portalOrderId)
    .update({ status: 'discarded' })
    .then(() => { toast('Discarded'); _renderPoLf(); })
    .catch(e => toast('Error: '+e.message));
}

// ── Review modal ──────────────────────────────────────────

let _currentReviewOrderId = null;

async function reviewPortalOrder(id) {
  _currentReviewOrderId = id;
  const o = PortalDB.getOrders().find(x => x.id === id);
  if (!o) return;

  // Mark as reviewed
  if (o.status === 'new') {
    await PortalDB.updateOrder(id, { status:'reviewed', reviewedAt: new Date() });
  }

  const cases = (o.items||[]).reduce((s,i)=>s+(i.cases||0),0);
  const cans  = cases * CANS_PER_CASE;
  const notifySkus = (o.notifyMe||[]).map(n => n.sku).join(', ');

  qs('#mpr-body').innerHTML = `
    <div class="card-grid grid-2" style="gap:12px;margin-bottom:12px">
      <div><div style="font-size:11px;color:var(--muted)">Business</div><div style="font-weight:600">${escHtml(o.accountName||'—')}</div></div>
      <div><div style="font-size:11px;color:var(--muted)">Billing Email</div><div>${escHtml(o.billingEmail||'—')}</div></div>
      <div><div style="font-size:11px;color:var(--muted)">Submitted</div><div style="font-size:13px">${_fmtPoDate(o.submittedAt)}</div></div>
      <div><div style="font-size:11px;color:var(--muted)">Mode</div><div>${o.mode==='liveorder'?'<span class="badge green">Live Order</span>':'<span class="badge amber">Pre-Order</span>'}</div></div>
      <div><div style="font-size:11px;color:var(--muted)">Classic Lavender Lemonade</div><div style="font-weight:600">${cases} case${cases!==1?'s':''} <span style="color:var(--muted);font-size:12px">(${cans} cans)</span></div></div>
      <div><div style="font-size:11px;color:var(--muted)">PO Number</div><div>${escHtml(o.poNumber||'—')}</div></div>
      <div><div style="font-size:11px;color:var(--muted)">Delivery Window</div><div>${escHtml(o.deliveryWindow||'—')}</div></div>
      <div><div style="font-size:11px;color:var(--muted)">Notes</div><div style="font-size:13px">${escHtml(o.notes||'—')}</div></div>
      ${notifySkus?`<div><div style="font-size:11px;color:var(--muted)">Notify Me</div><div style="font-size:13px">${escHtml(notifySkus)}</div></div>`:''}
      <div><div style="font-size:11px;color:var(--muted)">Status</div><div>${_poStatusBadge(o.status||'new')}</div></div>
    </div>
    ${o.hasMultipleSubmissions ? `<div style="background:#fef3c7;border-radius:8px;padding:8px 12px;font-size:12px;color:#92400e;margin-bottom:8px">⚠ This account/email has multiple submissions.</div>` : ''}
  `;

  // Show link-to-account for unmatched
  const linkRow = qs('#mpr-link-account-row');
  if (linkRow) {
    linkRow.style.display = o.isMatched ? 'none' : '';
    const sel = qs('#mpr-account-select');
    if (sel && !o.isMatched) {
      sel.innerHTML = '<option value="">— Select existing account —</option>' +
        DB.a('ac').map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
    }
  }

  const confirmBtn = qs('#mpr-confirm-btn');
  const declineBtn = qs('#mpr-decline-btn');
  if (confirmBtn) confirmBtn.onclick = () => { closeModal('modal-portal-review'); openConfirmPortalOrder(id); };
  if (declineBtn) declineBtn.onclick = () => { declinePortalOrder(id); closeModal('modal-portal-review'); };

  openModal('modal-portal-review');
}

async function linkPortalOrderToAccount() {
  const o = PortalDB.getOrders().find(x => x.id === _currentReviewOrderId);
  if (!o) return;
  const accountId = qs('#mpr-account-select')?.value;
  if (!accountId) { toast('Select an account first'); return; }
  const a = DB.a('ac').find(x => x.id === accountId);
  if (!a) return;
  await PortalDB.updateOrder(o.id, { accountId, accountName: a.name, isMatched: true, isUnmatched: false });
  toast('Linked to account ✓');
  closeModal('modal-portal-review');
  renderPreOrders(true);
}

async function createProspectFromPortalOrder() {
  const o = PortalDB.getOrders().find(x => x.id === _currentReviewOrderId);
  if (!o) return;
  const pr = {
    id: uid(), name: o.accountName||'', contact: o.contactName||'',
    email: o.billingEmail||'', status:'lead', source:'Portal',
    priority:'medium', notes:[], outreach:[],
  };
  DB.push('pr', pr);
  await PortalDB.updateOrder(o.id, { status:'reviewed', reviewedAt: new Date() });
  toast('Prospect created ✓');
  closeModal('modal-portal-review');
  renderPreOrders(true);
}

async function createProspectFromPoId(id) {
  _currentReviewOrderId = id;
  await createProspectFromPortalOrder();
}

async function declinePortalOrder(id) {
  if (!confirm('Mark this submission as declined?')) return;
  await PortalDB.updateOrder(id, { status:'declined' });
  toast('Submission declined');
  renderPreOrders(true);
}

async function deletePortalOrder(orderId) {
  if (!confirm('Delete this submission? Cannot be undone.')) return;
  try {
    await firebase.firestore()
      .collection('portal_orders').doc(orderId).delete();
    toast('Deleted ✓');
    renderPreOrders(true);
  } catch(e) {
    console.error(e);
    toast('Error deleting');
  }
}

// ── Confirm portal order flow ─────────────────────────────

let _confirmPortalOrderId = null;
let _portalOrderId = null;

function openConfirmPortalOrder(id) {
  _confirmPortalOrderId = id;
  _portalOrderId = id;
  const o = PortalDB.getOrders().find(x => x.id === id);
  if (!o) return;
  if (!o.accountId) {
    toast('Link this submission to an account before confirming');
    reviewPortalOrder(id);
    return;
  }
  const cases = (o.items||[]).reduce((s,i)=>s+(i.cases||0),0);
  const a = DB.a('ac').find(x => x.id === o.accountId);

  qs('#mcpo-body').innerHTML = `
    <div style="font-size:14px;margin-bottom:12px">
      <div style="font-weight:600;font-size:15px;margin-bottom:4px">${escHtml(o.accountName)}</div>
      <div style="font-size:12px;color:var(--muted)">Portal submission · ${_fmtPoDate(o.submittedAt)}</div>
      ${o.poNumber?`<div style="font-size:12px;margin-top:4px">PO# ${escHtml(o.poNumber)}</div>`:''}
      ${o.distributor?`<div style="font-size:12px;margin-top:4px"><strong>Distributor:</strong> ${escHtml(o.distributor)}</div>`:''}
    </div>
  `;

  const qtyInput = qs('#mcpo-classic-qty');
  if (qtyInput) {
    qtyInput.value = cases;
    qtyInput.oninput = () => {
      const q = parseInt(qtyInput.value)||0;
      const cc = qs('#mcpo-can-count');
      if (cc) cc.textContent = q > 0 ? `= ${q * CANS_PER_CASE} cans` : '';
    };
    qtyInput.oninput();
  }

  const notesInput = qs('#mcpo-notes');
  if (notesInput) notesInput.value = o.deliveryWindow ? `Delivery: ${o.deliveryWindow}` : '';

  const dueDateInput = qs('#mcpo-due-date');
  if (dueDateInput) dueDateInput.value = today();

  const saveBtn = qs('#mcpo-save-btn');
  if (saveBtn) saveBtn.onclick = () => confirmPortalOrder();

  openModal('modal-confirm-portal-order');
}

async function confirmPortalOrder() {
  if (!_portalOrderId) return;
  try {
    const portalRef = firebase.firestore()
      .collection('portal_orders').doc(_portalOrderId);
    const portalSnap = await portalRef.get();
    const d = portalSnap.data();

    const casesEl = document.getElementById('confirm-cases');
    const cases = parseInt(casesEl?.value || qs('#mcpo-classic-qty')?.value || 0);
    if (cases < 1) { toast('Enter at least 1 case'); return; }

    const cans = cases * CANS_PER_CASE;
    const orderId = uid();
    const todayStr = today();

    // 1. Build order record (matches delivery run order format)
    const orderData = {
      id: orderId,
      accountId: d.accountId || null,
      accountName: d.accountName,
      created: todayStr,
      dueDate: todayStr,
      cases,
      cans,
      status: 'pending',
      source: 'portal',
      linkedPortalOrderId: _portalOrderId,
      notes: d.notes || '',
      poNumber: d.poNumber || '',
      deliveryWindow: d.deliveryWindow || '',
      distributor: d.distributor || '',
    };

    // 3. Build inventory deduction entry (matches toggleStop format — qty in cans, type 'out')
    const ivEntry = {
      id: uid(),
      date: todayStr,
      sku: 'classic',
      type: 'out',
      qty: cans,
      note: 'Portal order: ' + d.accountName,
      ordId: orderId,
    };

    // 4. Build draft invoice using the single retail_invoices collection
    const lastInvNum = DB.a('retail_invoices').reduce((max, inv) => {
      const n = parseInt((inv.invoiceNumber || '').replace(/\D/g, '')) || 0;
      return Math.max(max, n);
    }, 0);
    const invoiceNumber = 'INV-' + String(lastInvNum + 1).padStart(4, '0');
    const invTerms = DB.obj('invoice_settings', { terms: 30 }).terms
                  || DB.obj('settings', { payment_terms: 30 }).payment_terms || 30;
    const dueDateStr = new Date(Date.now() + invTerms * 864e5).toISOString().slice(0, 10);
    const acct = DB.a('ac').find(x => x.id === d.accountId) || {};
    const pricePerCase = acct.pricePerCaseDirect || null;

    // 1–3: Write order, account lastOrder, inventory deduction in one Firestore write
    DB.atomicUpdate(cache => {
      // 1. Create order
      cache['orders'] = [...(cache['orders'] || []), orderData];
      // 2. Update account (or prospect) lastOrder
      if (d.accountId) {
        const key = d.isProspect ? 'pr' : 'ac';
        cache[key] = (cache[key] || []).map(a =>
          a.id === d.accountId ? { ...a, lastOrder: todayStr } : a
        );
      }
      // 3. Deduct inventory — 'iv' is the inventory log (same array used by renderInventory)
      cache['iv'] = [...(cache['iv'] || []), ivEntry];
    });

    // 4. Create single draft invoice in retail_invoices (the authoritative invoice collection)
    DB.push('retail_invoices', {
      id: uid(),
      invoiceNumber,
      accountId: d.accountId || null,
      accountName: d.accountName,
      orderId: orderId,
      date: todayStr,
      dueDate: dueDateStr,
      cases,
      cans,
      pricePerCase,
      total: pricePerCase ? cases * pricePerCase : null,
      priceType: 'direct',
      status: 'draft',
      source: 'portal',
      billingEmail: d.billingEmail || acct.email || '',
      notes: 'Auto-drafted from portal order approval.',
      linkedPortalOrderId: _portalOrderId,
    });

    // 5. Update portal_orders status — stays as direct Firestore (not in DB cache)
    await portalRef.update({
      status: 'confirmed',
      confirmedAt: firebase.firestore.FieldValue.serverTimestamp(),
      convertedOrderId: orderId,
    });

    closeModal('modal-confirm-portal-order');
    renderPreOrders(true);
    toast('✓ Order confirmed · Invoice draft created · Inventory updated');

    // Send order confirmation email and log to cadence
    const emailTo = d.billingEmail || acct.email;
    if (emailTo && d.accountId && !d.isProspect) {
      const contacts = acct.contacts || [];
      const primary = contacts.find(c => c.isPrimary) || contacts[0] || {};
      const contactName = primary.name || acct.contact || 'there';
      const portalLink = acct.orderPortalToken
        ? `https://purpl-crm.web.app/order?t=${acct.orderPortalToken}`
        : null;
      const orderSummary = `<p style="margin:12px 0 4px"><strong>Order ref:</strong> ${d.poNumber || orderId}</p><p style="margin:4px 0"><strong>Cases:</strong> ${cases}</p>`;
      callSendOrderConfirmation(emailTo, acct.name || d.accountName, contactName, orderSummary, portalLink, false)
        .then(result => {
          const entry = {
            id: uid(),
            stage: 'order_confirmation',
            sentAt: new Date().toISOString(),
            sentBy: 'graham',
            method: 'resend',
            orderRef: d.poNumber || orderId,
          };
          if (result?.id) entry.sentMessageId = result.id;
          DB.update('ac', d.accountId, a => ({
            ...a,
            lastContacted: today(),
            cadence: [...(a.cadence || []), entry],
          }));
        })
        .catch(err => console.warn('Order confirmation email failed:', err));
    }

    // If prospect — prompt to convert
    if (d.isProspect && d.accountId) {
      setTimeout(() => {
        if (confirm(d.accountName + ' is a prospect. Convert to active account now?')) {
          convertProspect(d.accountId);
        }
      }, 500);
    }

  } catch(e) {
    console.error('confirmPortalOrder error:', e);
    toast('Error confirming order — check console');
  }
}

// ── Phase 5: Portal Settings ──────────────────────────────

function togglePortalDeadline() {
  const enabled = qs('#portal-deadline-enabled')?.checked;
  const row = qs('#portal-deadline-row');
  if (row) row.style.display = enabled ? '' : 'none';
}

async function renderPortalSettings() {
  const config = await PortalDB.getConfig();
  const modeEl = qs('#portal-mode');
  if (modeEl) modeEl.value = config.mode || 'preorder';
  const priceEl = qs('#portal-price-per-case');
  if (priceEl) priceEl.value = config.pricePerCase || '';
  const dlEnabled = qs('#portal-deadline-enabled');
  if (dlEnabled) { dlEnabled.checked = !!config.deadlineEnabled; togglePortalDeadline(); }
  const dlDate = qs('#portal-deadline');
  if (dlDate) dlDate.value = config.deadline || '';

  // Status card
  await _renderPortalStatusCard(config);
}

async function _renderPortalStatusCard(config) {
  const el = qs('#portal-status-body');
  if (!el) return;
  if (!PortalDB._loaded) await PortalDB.load();
  const orders  = PortalDB.getOrders();
  const total   = orders.length;
  const lastOrd = orders[0];
  const lastStr = lastOrd?.submittedAt
    ? `${Math.floor((Date.now()-lastOrd.submittedAt.getTime())/60000)} min ago`
    : 'Never';
  el.innerHTML = `
    <div style="display:grid;gap:6px">
      <div>Mode: <strong>${config?.mode==='liveorder'?'Live Orders':'Pre-Order'}</strong></div>
      <div>Total submissions: <strong>${total}</strong></div>
      <div>Last submission: <strong>${lastStr}</strong></div>
    </div>
  `;
}

async function savePortalSettings() {
  const mode      = qs('#portal-mode')?.value || 'preorder';
  const price     = parseFloat(qs('#portal-price-per-case')?.value)||null;
  const dlEnabled = qs('#portal-deadline-enabled')?.checked || false;
  const deadline  = qs('#portal-deadline')?.value || null;
  const config    = { mode, pricePerCase: price, deadlineEnabled: dlEnabled, deadline: dlEnabled ? deadline : null };
  try {
    await PortalDB.saveConfig(config);
    toast('Portal settings saved ✓');
    await _renderPortalStatusCard(config);
  } catch(e) {
    toast('Save failed — ' + (e.message||e));
    console.error(e);
  }
}

// ── Phase 6: Portal Orders tab in account modal ───────────

async function renderMacPortalOrdersTab(accountId) {
  const el = qs('#mac-portal-orders-content');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted)">Loading…</div>';
  if (!PortalDB._loaded) await PortalDB.load();
  const orders = PortalDB.getAccountOrders(accountId);
  if (!orders.length) {
    el.innerHTML = `
      <div style="padding:16px">
        <p style="color:var(--muted);font-size:13px;margin-bottom:14px">
          No portal orders yet. Copy this account's personalized link and send it to them.
        </p>
        <button class="btn sm primary" onclick="copyOrderLink('${accountId}')">🔗 Copy Order Link</button>
      </div>
    `;
    return;
  }
  el.innerHTML = `
    <div style="margin-bottom:12px">
      <button class="btn sm primary" onclick="copyOrderLink('${accountId}')">🔗 Copy Order Link</button>
    </div>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Submitted</th><th>Cases</th><th>Cans</th><th>Status</th><th>Delivery Window</th><th>Notes</th></tr></thead>
      <tbody>${orders.map(o => {
        const cases = (o.items||[]).reduce((s,i)=>s+(i.cases||0),0);
        const cans  = cases * CANS_PER_CASE;
        return `<tr>
          <td style="font-size:12px">${_fmtPoDate(o.submittedAt)}</td>
          <td>${cases||'—'}</td>
          <td>${cans||'—'}</td>
          <td>${_poStatusBadge(o.status||'new')}</td>
          <td style="font-size:12px">${escHtml(o.deliveryWindow||'—')}</td>
          <td style="font-size:12px">${escHtml(o.notes||'—')}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
  `;
}

// ── Wire portal settings render into renderSettings ───────
// Extend renderSettings to also load portal settings.
// Use IIFE + variable assignment (not function declaration) to avoid
// hoisting — a function declaration would capture itself as _orig,
// causing infinite recursion / Maximum call stack size exceeded.
(function () {
  const _orig = renderSettings;
  renderSettings = function () {
    _orig();
    renderPortalSettings();
    loadInvoiceSettings();
    loadApiSettings();
  };
}());


// ═══════════ INVOICES PAGE (v2 — reads from iv collection) ═══════════

// Helper aliases used by invoice functions below
const fmt$      = (n) => fmtC(n);
const fmtDate   = (s) => fmtD(s);
const daysSince = (s) => daysAgo(s);
const esc       = (s) => escHtml(String(s||''));

// markPaid alias (iv collection invoice records)
function markPaid(id) {
  DB.update('iv', id, x => ({...x, status:'paid', paidDate:today()}));
  renderInvoicesPage();
  toast('Marked as paid ✓');
}

// editInv — open invoice modal pre-filled
function editInv(id) {
  openInvModal(id);
}

function renderInvoicesPage() {
  if (!DB._firestoreReady) {
    ['#inv-col-purpl-compact','#inv-col-lf-compact','#inv-col-combined-compact','#inv-col-dist-compact'].forEach(sel => {
      const el = qs(sel);
      if (el) el.innerHTML = _dbLoadingHTML(3);
    });
    return;
  }
  const actionsEl = qs('#inv-page-actions');
  if (actionsEl) {
    actionsEl.innerHTML = DB.a('ac').some(a => a.isPbf)
      ? `<button class="btn primary" onclick="openNewCombinedModal()">+ New Combined Invoice</button>`
      : '';
  }
  renderInvKpis();
  renderInvColPurpl();
  renderInvColLf();
  renderInvColCombined();
  renderInvColDist();
}

function renderInvKpis() {
  const todayStr = today();
  const purplInvs = DB.a('iv').filter(x => x.accountId || x.number || x.invoiceNumber);
  const lfInvs    = DB.a('lf_invoices');
  const distInvs  = DB.a('dist_invoices');

  function purplStatus(inv) {
    if (inv.status === 'paid' || inv.status === 'draft') return inv.status;
    const due = inv.due || inv.dueDate || '';
    if (due && due < todayStr) return 'overdue';
    return inv.status || 'unpaid';
  }

  const now = new Date();
  const fom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

  const totalInvoiced = purplInvs.reduce((s,x) => s + parseFloat(x.amount||0), 0)
                      + lfInvs.reduce((s,x) => s + parseFloat(x.total||0), 0)
                      + distInvs.reduce((s,x) => s + parseFloat(x.total||0), 0);
  const outstanding   = purplInvs.filter(x => !['paid','draft'].includes(purplStatus(x)))
                          .reduce((s,x) => s + parseFloat(x.amount||0), 0)
                      + lfInvs.filter(x => x.status !== 'paid')
                          .reduce((s,x) => s + parseFloat(x.total||0), 0)
                      + distInvs.filter(x => ['unpaid','overdue'].includes(x.status))
                          .reduce((s,x) => s + parseFloat(x.total||0), 0);
  const overdue       = purplInvs.filter(x => purplStatus(x) === 'overdue')
                          .reduce((s,x) => s + parseFloat(x.amount||0), 0)
                      + lfInvs.filter(x => x.status !== 'paid' && (x.due||'') < todayStr && x.due)
                          .reduce((s,x) => s + parseFloat(x.total||0), 0)
                      + distInvs.filter(x => x.status==='overdue' || (x.status!=='paid'&&x.dueDate&&x.dueDate<todayStr))
                          .reduce((s,x) => s + parseFloat(x.total||0), 0);
  const collected     = purplInvs.filter(x => x.status === 'paid' && (x.paidDate||'') >= fom)
                          .reduce((s,x) => s + parseFloat(x.amount||0), 0)
                      + lfInvs.filter(x => x.status === 'paid' && (x.paidAt||'').slice(0,10) >= fom)
                          .reduce((s,x) => s + parseFloat(x.total||0), 0)
                      + distInvs.filter(x => x.status === 'paid' && (x.paidDate||'') >= fom)
                          .reduce((s,x) => s + parseFloat(x.total||0), 0);

  const el = qs('#inv-page-kpis');
  if (!el) return;
  el.innerHTML = `
    <div>${kpiHtml('Total Invoiced', fmtC(totalInvoiced), 'blue')}</div>
    <div>${kpiHtml('Outstanding', fmtC(outstanding), outstanding > 0 ? 'amber' : 'gray')}</div>
    <div>${kpiHtml('Overdue', fmtC(overdue), overdue > 0 ? 'red' : 'gray')}</div>
    <div>${kpiHtml('Collected This Month', fmtC(collected), 'green')}</div>`;
}

function renderInvColPurpl() {
  const todayStr = today();
  // Exclude iv records that are part of a combined invoice
  const invs = DB.a('iv')
    .filter(x => (x.accountId || x.number || x.invoiceNumber) && !x.combinedInvoiceId);

  function effectiveStatus(inv) {
    if (inv.status === 'paid' || inv.status === 'draft') return inv.status;
    const due = inv.due || inv.dueDate || '';
    if (due && due < todayStr) return 'overdue';
    return inv.status || 'unpaid';
  }

  const outstanding = invs.filter(x => !['paid','draft'].includes(effectiveStatus(x)))
                        .reduce((s,x) => s + parseFloat(x.amount||0), 0);
  const overdueAmt  = invs.filter(x => effectiveStatus(x) === 'overdue')
                        .reduce((s,x) => s + parseFloat(x.amount||0), 0);

  const summEl = qs('#inv-col-purpl-summary');
  if (summEl) summEl.textContent = `${invs.length} invoices · ${fmtC(outstanding)} outstanding${overdueAmt > 0 ? ` · ${fmtC(overdueAmt)} overdue` : ''}`;

  // Compact view — top 5 non-paid sorted by due asc
  const compactEl = qs('#inv-col-purpl-compact');
  if (compactEl) {
    const urgent = invs
      .filter(x => effectiveStatus(x) !== 'paid' && effectiveStatus(x) !== 'draft')
      .sort((a,b) => (a.due||a.dueDate||'') < (b.due||b.dueDate||'') ? -1 : 1)
      .slice(0,5);
    if (!urgent.length) {
      compactEl.innerHTML = '<div style="padding:12px 16px;font-size:13px;color:var(--muted)">No open purpl invoices</div>';
    } else {
      compactEl.innerHTML = urgent.map(iv => {
        const st  = effectiveStatus(iv);
        const due = iv.due || iv.dueDate || '';
        const acName = iv.accountName || DB.a('ac').find(a=>a.id===iv.accountId)?.name || '?';
        const statColor = {paid:'green',draft:'gray',sent:'blue',overdue:'red',partial:'amber',unpaid:'blue'};
        return `<div class="inv-col-compact-row">
          <div>
            <div style="font-weight:600">${escHtml(acName)}</div>
            <div style="font-size:11px;color:var(--muted)">${escHtml(iv.number||iv.invoiceNumber||'—')} · Due ${fmtD(due)}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="badge ${statColor[st]||'gray'}">${st}</span>
            <strong style="font-size:13px">${fmtC(iv.amount||iv.total||0)}</strong>
          </div>
        </div>`;
      }).join('');
    }
  }

  // Expanded view — full sortable table
  const expandedEl = qs('#inv-col-purpl-expanded');
  if (!expandedEl) return;
  if (!qs('#inv-col-purpl').classList.contains('expanded')) return;

  const statColor = {paid:'green',draft:'gray',sent:'blue',overdue:'red',partial:'amber',unpaid:'blue'};
  const SORT_KEY_MAP = {number:'number', accountName:'_accountName', due:'_due', amount:'amount'};
  let sorted = invs.map(x => ({
    ...x,
    _status:      effectiveStatus(x),
    _due:         x.due || x.dueDate || '',
    _accountName: x.accountName || DB.a('ac').find(a=>a.id===x.accountId)?.name || '?',
  }));
  sorted.sort((a,b) => {
    const k  = SORT_KEY_MAP[_invSortKey] || '_due';
    const av = a[k] ?? '';
    const bv = b[k] ?? '';
    return av < bv ? -_invSortDir : av > bv ? _invSortDir : 0;
  });

  expandedEl.innerHTML = `
    <div style="overflow-x:auto">
    <table class="data-table" style="width:100%;font-size:13px">
      <thead><tr>
        <th onclick="_invSort('number')" style="cursor:pointer">#</th>
        <th onclick="_invSort('accountName')" style="cursor:pointer">Account</th>
        <th onclick="_invSort('due')" style="cursor:pointer">Due</th>
        <th onclick="_invSort('amount')" style="cursor:pointer">Amount</th>
        <th>Status</th>
        <th></th>
      </tr></thead>
      <tbody>${!sorted.length
        ? '<tr><td colspan="6" class="empty">No purpl invoices yet</td></tr>'
        : sorted.map(iv => {
            const st  = iv._status;
            const due = iv._due;
            const amt = iv.amount != null ? iv.amount : iv.total;
            return `<tr>
              <td><strong>${escHtml(iv.number||iv.invoiceNumber||'—')}</strong></td>
              <td>${escHtml(iv._accountName)}</td>
              <td style="color:${due&&due<todayStr&&st!=='paid'?'var(--red)':'inherit'}">${fmtD(due)}</td>
              <td><strong>${amt != null ? fmtC(amt) : '<span style="color:var(--muted)">Draft</span>'}</strong></td>
              <td><span class="badge ${statColor[st]||'gray'}">${st}</span></td>
              <td><div style="display:flex;gap:4px;flex-wrap:wrap">
                ${st!=='paid' ? `<button class="btn xs green" onclick="markPaid('${iv.id}')">✓ Paid</button>` : ''}
                ${st==='draft' ? `<button class="btn xs blue" onclick="markInvoiceSent('${iv.id}')">✉ Sent</button>` : ''}
                <button class="btn xs" onclick="generateInvoicePrint('${iv.id}')">🖨️</button>
                <button class="btn xs" onclick="editInv('${iv.id}')">Edit</button>
                <button class="btn xs red" onclick="deleteInvoice('${iv.id}')">✕</button>
              </div></td>
            </tr>`;
          }).join('')}
      </tbody>
    </table></div>`;
}

function _invSort(key) {
  if (_invSortKey === key) _invSortDir *= -1;
  else { _invSortKey = key; _invSortDir = -1; }
  renderInvColPurpl();
}

function renderInvColLf() {
  const todayStr = today();
  // Exclude lf_invoices records that are part of a combined invoice
  const all = DB.a('lf_invoices').filter(x => !x.combinedInvoiceId);

  const outstanding = all.filter(x => x.status !== 'paid').reduce((s,x) => s + parseFloat(x.total||0), 0);
  const overdueAmt  = all.filter(x => x.status !== 'paid' && (x.due||'') < todayStr && x.due)
                        .reduce((s,x) => s + parseFloat(x.total||0), 0);

  const summEl = qs('#inv-col-lf-summary');
  if (summEl) summEl.textContent = `${all.length} invoices · ${fmtC(outstanding)} outstanding${overdueAmt > 0 ? ` · ${fmtC(overdueAmt)} overdue` : ''}`;

  // Compact view
  const compactEl = qs('#inv-col-lf-compact');
  if (compactEl) {
    const urgent = all
      .filter(x => x.status !== 'paid')
      .sort((a,b) => (a.due||'') < (b.due||'') ? -1 : 1)
      .slice(0,5);
    if (!urgent.length) {
      compactEl.innerHTML = '<div style="padding:12px 16px;font-size:13px;color:var(--muted)">No open LF invoices</div>';
    } else {
      compactEl.innerHTML = urgent.map(inv => {
        const sc = LF_INV_STATUS[inv.status] || {label: inv.status||'—', cls:'gray'};
        return `<div class="inv-col-compact-row">
          <div>
            <div style="font-weight:600">${escHtml(inv.accountName||'—')}</div>
            <div style="font-size:11px;color:var(--muted)">${escHtml(inv.number||'—')} · Due ${fmtD(inv.due)}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="badge ${sc.cls}">${sc.label}</span>
            <strong style="font-size:13px">${fmtC(inv.total||0)}</strong>
          </div>
        </div>`;
      }).join('');
    }
  }

  // Expanded view
  const expandedEl = qs('#inv-col-lf-expanded');
  if (!expandedEl) return;
  if (!qs('#inv-col-lf').classList.contains('expanded')) return;

  const sorted = all.slice().sort((a,b) => (b.issued||'') > (a.issued||'') ? 1 : -1);
  expandedEl.innerHTML = `
    <div style="overflow-x:auto">
    <table class="data-table" style="width:100%;font-size:13px">
      <thead><tr>
        <th>#</th><th>Account</th><th>Due</th><th>Amount</th><th>Status</th><th>Wix</th><th></th>
      </tr></thead>
      <tbody>${!sorted.length
        ? '<tr><td colspan="7" class="empty">No LF invoices yet</td></tr>'
        : sorted.map(inv => {
            const sc = LF_INV_STATUS[inv.status] || {label: inv.status||'—', cls:'gray'};
            const wixHtml = inv.wixPulled
              ? `<span style="color:var(--green,#16a34a);font-weight:600">✓</span>`
              : `<span style="color:#f59e0b;font-weight:600">⚠</span>`;
            return `<tr>
              <td><strong>${escHtml(inv.number||'—')}</strong></td>
              <td>${escHtml(inv.accountName||'—')}</td>
              <td>${fmtD(inv.due)}</td>
              <td><strong>${fmtC(inv.total||0)}</strong></td>
              <td><span class="badge ${sc.cls}">${sc.label}</span></td>
              <td>${wixHtml}</td>
              <td style="white-space:nowrap">
                <button class="btn xs" onclick="openLfInvoiceModal('${inv.id}')">Edit</button>
                <button class="btn xs ${inv.status==='paid'?'':'primary'}" onclick="markLfInvPaid('${inv.id}')">${inv.status==='paid'?'Unpay':'✓ Paid'}</button>
              </td>
            </tr>`;
          }).join('')}
      </tbody>
    </table></div>`;
}

function renderInvColCombined() {
  const all = DB.a('combined_invoices');

  const outstanding = all.filter(x => x.status !== 'paid').reduce((s,x) => s + parseFloat(x.grandTotal||0), 0);

  const summEl = qs('#inv-col-combined-summary');
  if (summEl) summEl.textContent = all.length
    ? `${all.length} combined · ${fmtC(outstanding)} outstanding`
    : 'No combined invoices';

  // Compact view
  const compactEl = qs('#inv-col-combined-compact');
  if (compactEl) {
    if (!all.length) {
      compactEl.innerHTML = '<div style="padding:12px 16px;font-size:13px;color:var(--muted)">No combined invoices yet. Combined invoices are created automatically when an isPbf account orders both brands, or manually from the account detail modal.</div>';
    } else {
      const pending = all.filter(x => x.status !== 'paid').slice(0,5);
      if (!pending.length) {
        compactEl.innerHTML = '<div style="padding:12px 16px;font-size:13px;color:var(--muted)">All combined invoices paid</div>';
      } else {
        compactEl.innerHTML = pending.map(ci => `<div class="inv-col-compact-row">
          <div>
            <div style="font-weight:600">${escHtml(ci.accountName||'—')}</div>
            <div style="font-size:11px;color:var(--muted)">purpl ${fmtC(ci.purplSubtotal||0)} + LF ${fmtC(ci.lfSubtotal||0)}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <span class="badge ${ci.status==='paid'?'green':'amber'}">${ci.status||'draft'}</span>
            <strong style="font-size:13px">${fmtC(ci.grandTotal||0)}</strong>
          </div>
        </div>`).join('');
      }
    }
  }

  // Expanded view
  const expandedEl = qs('#inv-col-combined-expanded');
  if (!expandedEl) return;
  if (!qs('#inv-col-combined').classList.contains('expanded')) return;

  if (!all.length) {
    expandedEl.innerHTML = '<div style="padding:12px 0;font-size:13px;color:var(--muted)">No combined invoices yet. Combined invoices are created automatically when an isPbf account orders both brands, or manually from the account detail modal.</div>';
    return;
  }

  const sorted = all.slice().sort((a,b) => (b.createdAt||'') > (a.createdAt||'') ? 1 : -1);
  expandedEl.innerHTML = `
    <div style="overflow-x:auto">
    <table class="data-table" style="width:100%;font-size:13px">
      <thead><tr>
        <th>Account</th><th>purpl</th><th>LF</th><th>Total</th><th>Status</th><th></th>
      </tr></thead>
      <tbody>${sorted.map(ci => `<tr>
        <td><strong>${escHtml(ci.accountName||'—')}</strong></td>
        <td>${fmtC(ci.purplSubtotal||0)}</td>
        <td>${fmtC(ci.lfSubtotal||0)}</td>
        <td><strong>${fmtC(ci.grandTotal||0)}</strong></td>
        <td><span class="badge ${ci.status==='paid'?'green':ci.status==='sent'?'blue':'amber'}">${ci.status||'draft'}</span></td>
        <td style="white-space:nowrap">
          ${ci.status!=='paid' ? `<button class="btn xs green" onclick="markCombinedPaid('${ci.id}')">✓ Paid</button>` : ''}
        </td>
      </tr>`).join('')}
      </tbody>
    </table></div>`;
}

function toggleInvCol(col) {
  const el = qs(`#inv-col-${col}`);
  if (!el) return;
  el.classList.toggle('expanded');
  // Render expanded content on open
  if (el.classList.contains('expanded')) {
    if (col === 'purpl')         renderInvColPurpl();
    else if (col === 'lf')       renderInvColLf();
    else if (col === 'combined') renderInvColCombined();
    else if (col === 'dist')     renderInvColDist();
  }
}

function renderInvColDist() {
  const todayStr = today();
  const dists = DB.a('dist_profiles');
  const allInvs = DB.a('dist_invoices').slice().sort((a,b)=>a.dueDate>b.dueDate?1:-1);

  function effectiveStatus(inv) {
    if (inv.status === 'paid') return 'paid';
    if (inv.dueDate && inv.dueDate < todayStr) return 'overdue';
    return inv.status || 'unpaid';
  }

  const unpaidInvs = allInvs.filter(i => effectiveStatus(i) !== 'paid');
  const totalOut   = unpaidInvs.reduce((s,i) => s + parseFloat(i.total||0), 0);
  const overdueAmt = unpaidInvs.filter(i=>effectiveStatus(i)==='overdue').reduce((s,i)=>s+(i.total||0),0);

  const summaryEl = qs('#inv-col-dist-summary');
  if (summaryEl) summaryEl.textContent = `${unpaidInvs.length} outstanding · ${fmtC(totalOut)}${overdueAmt>0?' · '+fmtC(overdueAmt)+' overdue':''}`;

  // Compact: top 5 urgent
  const compactEl = qs('#inv-col-dist-compact');
  if (compactEl) {
    const top5 = unpaidInvs.slice(0,5);
    compactEl.innerHTML = top5.length ? top5.map(inv=>{
      const d = dists.find(x=>x.id===inv.distId);
      const st = effectiveStatus(inv);
      return `<div class="inv-col-compact-row" onclick="openDistributor('${inv.distId}')" style="cursor:pointer">
        <div>
          <div style="font-size:13px;font-weight:500">${escHtml(d?.name||inv.distId)}</div>
          <div style="font-size:11px;color:var(--muted)">${inv.invoiceNumber||'—'} · Due ${inv.dueDate?fmtD(inv.dueDate):'—'}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:13px;font-weight:600">${fmtC(inv.total||0)}</span>
          <span class="badge ${DIST_INV_STATUS[st]?.cls||'gray'}">${DIST_INV_STATUS[st]?.label||st}</span>
        </div>
      </div>`;
    }).join('') : '<div class="empty" style="padding:16px">No outstanding distributor invoices</div>';
  }

  // Expanded: full table
  const expandedEl = qs('#inv-col-dist-expanded');
  if (expandedEl) {
    expandedEl.innerHTML = `
    <div style="padding:0 4px 8px;display:flex;justify-content:flex-end">
      <button class="btn xs" onclick="event.stopPropagation()">+ New (open distributor)</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Invoice #</th><th>Distributor</th><th>Issued</th><th>Due</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${allInvs.map(inv=>{
          const d = dists.find(x=>x.id===inv.distId);
          const st = effectiveStatus(inv);
          return `<tr>
            <td>${escHtml(inv.invoiceNumber||'—')}</td>
            <td style="cursor:pointer;color:var(--lavblue)" onclick="openDistributor('${inv.distId}')">${escHtml(d?.name||inv.distId)}</td>
            <td>${inv.dateIssued?fmtD(inv.dateIssued):'—'}</td>
            <td class="${st==='overdue'?'red':''}">${inv.dueDate?fmtD(inv.dueDate):'—'}</td>
            <td>${fmtC(inv.total||0)}</td>
            <td>${statusBadge(DIST_INV_STATUS, st)}</td>
            <td style="white-space:nowrap">
              ${st!=='paid'?`<button class="btn xs" onclick="markDistInvoicePaid('${inv.id}','${inv.distId}')">✓ Paid</button>`:''}
              <button class="btn xs" onclick="_sendDistInvoiceReminder('${inv.id}')">✉ Remind</button>
            </td>
          </tr>`;
        }).join('')||'<tr><td colspan="7" class="empty">No distributor invoices</td></tr>'}
        </tbody>
      </table>
    </div>`;
  }
}

function _sendDistInvoiceReminder(invId) {
  const inv = DB.a('dist_invoices').find(x=>x.id===invId);
  if (!inv) return;
  const d = DB.a('dist_profiles').find(x=>x.id===inv.distId);
  const name = d?.name || 'Distributor';
  const subject = `Invoice Reminder — ${inv.invoiceNumber||'Outstanding Balance'}`;
  const html = `<p>Hi ${escHtml(name)},</p><p>This is a friendly reminder that invoice <strong>${escHtml(inv.invoiceNumber||'—')}</strong> for <strong>${fmtC(inv.total||0)}</strong> is due ${inv.dueDate?`on ${fmtD(inv.dueDate)}`:''}.</p><p>Please remit payment at your earliest convenience. Reply to this email with any questions.</p><p>Thank you,<br>Pumpkin Blossom Farm</p>`;
  // Find a contact email on the distributor
  const contacts = d?.contacts||[];
  const repEmail = (DB.a('dist_reps').find(r=>r.distId===inv.distId&&r.email))?.email || '';
  const to = contacts.find(c=>c.email)?.email || repEmail;
  if (!to) { toast('No contact email found for this distributor'); return; }
  callSendEmail(to, 'lavender@pbfwholesale.com', subject, html).then(()=>{
    DB.update('dist_invoices', invId, i=>({...i, reminderSentAt:today()}));
    toast('Reminder sent ✓');
    renderInvColDist();
  }).catch(()=>toast('Failed to send reminder'));
}

function markInvoiceSent(id) {
  DB.update('iv', id, x => ({...x, status:'sent', sentAt: today()}));
  renderInvoicesPage();
  toast('Marked as sent ✓');
}

function deleteInvoice(id) {
  if (!confirm('Delete this invoice?')) return;
  DB.remove('iv', id);
  renderInvoicesPage();
  toast('Deleted');
}

function saveInvoiceSettings() {
  const s = {
    fromName: document.getElementById('inv-from-name')?.value ||
      'Pumpkin Blossom Farm LLC',
    fromEmail: document.getElementById('inv-from-email')?.value ||
      'lavender@pbfwholesale.com',
    fromAddress: document.getElementById('inv-from-address')?.value ||
      '393 Pumpkin Hill Rd, Warner, NH 03278',
    terms: parseInt(document.getElementById('inv-terms')?.value)||30,
    stripeLink: document.getElementById('inv-stripe-link')?.value||'',
    achRouting: document.getElementById('inv-ach-routing')?.value||'',
    achAccount: document.getElementById('inv-ach-account')?.value||'',
    checkInstructions: document.getElementById(
      'inv-check-instructions')?.value||''
  };
  DB.setObj('invoice_settings', s);
  toast('Invoice settings saved ✓');
}

function loadInvoiceSettings() {
  const s = DB.obj('invoice_settings', {});
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el && val != null) el.value = val;
  };
  set('inv-from-name',          s.fromName);
  set('inv-from-email',         s.fromEmail);
  set('inv-from-address',       s.fromAddress);
  set('inv-terms',              s.terms);
  set('inv-stripe-link',        s.stripeLink);
  set('inv-ach-routing',        s.achRouting);
  set('inv-ach-account',        s.achAccount);
  set('inv-check-instructions', s.checkInstructions);
  // legacy field aliases
  set('inv-payment-instructions', s.checkInstructions || s.paymentInstructions);
}

function saveApiSettings() {
  DB.setObj('api_settings', {
    anthropicKey: document.getElementById('set-anthropic-key')?.value?.trim() || '',
  });
  toast('API settings saved ✓');
}

function loadApiSettings() {
  const s = DB.obj('api_settings', {});
  const el = document.getElementById('set-anthropic-key');
  if (el && s.anthropicKey) el.value = s.anthropicKey;
}

function generateInvoicePrint(invoiceId) {
  // Search both iv and retail_invoices collections
  const iv = DB.a('iv').find(x => x.id === invoiceId)
          || DB.a('retail_invoices').find(x => x.id === invoiceId);
  if (!iv) { toast('Invoice not found'); return; }
  const s = DB.obj('invoice_settings', {});
  const ac = DB.a('ac').find(x => x.id === iv.accountId) || {};
  const fromName  = s.fromName  || 'Pumpkin Blossom Farm LLC';
  const fromEmail = s.fromEmail || 'lavender@pbfwholesale.com';
  const fromAddr  = s.fromAddress || '393 Pumpkin Hill Rd, Warner, NH 03278';
  const cans      = iv.cans || ((iv.cases||0) * CANS_PER_CASE);
  const invNum    = iv.number || iv.invoiceNumber || '—';
  const dueDate   = iv.due   || iv.dueDate || '';
  const amt       = iv.amount != null ? iv.amount : (iv.total != null ? iv.total : null);
  const status    = iv.status || 'draft';

  const paymentHtml = `
    ${s.stripeLink ?
      `<div style="margin-bottom:8px">
        <a href="${s.stripeLink}"
          style="background:#7B4FA0;color:#fff;padding:10px 20px;
          border-radius:8px;text-decoration:none;font-weight:600;
          display:inline-block">
          💳 Pay Now Online →</a></div>` : ''}
    ${s.achRouting ?
      `<div style="margin-bottom:4px">
        <strong>ACH Transfer:</strong>
        Routing: ${s.achRouting} ·
        Account: ${s.achAccount}</div>` : ''}
    ${(s.checkInstructions || s.paymentInstructions) ?
      `<div style="white-space:pre-line">${s.checkInstructions || s.paymentInstructions}</div>`
      : `<div>Make checks payable to <strong>Pumpkin Blossom Farm LLC</strong></div>`}`;

  const w = window.open('', '_blank');
  if (!w) { toast('Pop-up blocked — allow pop-ups for this site'); return; }
  w.document.write(`<!DOCTYPE html>
<html><head><title>Invoice ${invNum}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    max-width:800px;margin:40px auto;padding:0 20px;
    color:#1a1a2e;font-size:13px}
  .header{display:flex;justify-content:space-between;
    align-items:flex-start;margin-bottom:32px;
    padding-bottom:20px;border-bottom:2px solid #7B4FA0}
  .logo{height:50px}
  .inv-label{font-size:32px;font-weight:700;
    color:#7B4FA0;letter-spacing:-1px}
  .inv-meta div{margin-bottom:4px;font-size:12px}
  .bill-to{display:grid;grid-template-columns:1fr 1fr;
    gap:20px;margin-bottom:24px}
  .section-label{font-size:10px;font-weight:700;
    text-transform:uppercase;letter-spacing:.08em;
    color:#9ca3af;margin-bottom:6px}
  table{width:100%;border-collapse:collapse;margin-bottom:20px}
  th{background:#f9fafb;padding:8px 12px;text-align:left;
    font-size:11px;font-weight:600;text-transform:uppercase;
    letter-spacing:.05em;color:#6b7280;
    border-bottom:2px solid #e5e7eb}
  td{padding:10px 12px;border-bottom:1px solid #f3f4f6}
  .total-row td{font-weight:700;font-size:15px;
    color:#7B4FA0;border-top:2px solid #7B4FA0;border-bottom:none}
  .payment-box{background:#f5f0ff;border-radius:8px;
    padding:16px;margin-bottom:20px}
  .footer{text-align:center;color:#9ca3af;font-size:11px;
    margin-top:32px;padding-top:16px;
    border-top:1px solid #e5e7eb}
  .status-badge{display:inline-block;padding:3px 10px;
    border-radius:20px;font-size:11px;font-weight:600;
    background:${status==='paid'?'#dcfce7':
      status==='overdue'?'#fee2e2':'#fef3c7'};
    color:${status==='paid'?'#166534':
      status==='overdue'?'#991b1b':'#92400e'}}
  @media print{button{display:none}}
</style></head><body>

<div class="header">
  <div>
    <img src="https://static.wixstatic.com/media/81a2ff_1e3f6923c1d5495082d490b4cc229e1c~mv2.png/v1/fill/w_176,h_71,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Purpl%20Logo%20-%20Sprig%20in%20front%20-%20transparent.png"
      class="logo" alt="purpl">
    <div style="margin-top:8px;font-size:12px;color:#6b7280">
      ${fromName}<br>${fromAddr}<br>${fromEmail} · 603-748-3038
    </div>
  </div>
  <div style="text-align:right">
    <div class="inv-label">INVOICE</div>
    <div class="inv-meta" style="margin-top:8px">
      <div><strong>#${invNum}</strong></div>
      <div>Date: ${fmtDate(iv.date)}</div>
      <div>Due: ${fmtDate(dueDate)}</div>
      <div style="margin-top:6px">
        <span class="status-badge">${status.toUpperCase()}</span>
      </div>
    </div>
  </div>
</div>

<div class="bill-to">
  <div>
    <div class="section-label">Bill To</div>
    <div style="font-weight:600;font-size:14px">
      ${esc(iv.accountName || ac.name || '?')}</div>
    ${ac.address ?
      `<div style="color:#6b7280;font-size:12px;margin-top:4px">
        ${esc(ac.address)}</div>` : ''}
    ${iv.billingEmail ?
      `<div style="color:#6b7280;font-size:12px">
        ${esc(iv.billingEmail)}</div>` : ''}
  </div>
  <div>
    <div class="section-label">Payment Terms</div>
    <div>Net ${s.terms||30} days</div>
    ${iv.linkedOrderId ?
      `<div style="font-size:11px;color:#9ca3af;margin-top:4px">
        Order ref: ${iv.linkedOrderId}</div>` : ''}
  </div>
</div>

<table>
  <thead><tr>
    <th>Product</th>
    <th style="text-align:center">Cases</th>
    <th style="text-align:center">Cans</th>
    <th style="text-align:right">Price/Case</th>
    <th style="text-align:right">Total</th>
  </tr></thead>
  <tbody>
    ${(iv.lineItems||[]).length
      ? iv.lineItems.map(li => `
        <tr>
          <td><strong>${esc(li.skuName||li.skuId||'purpl')}</strong>
            <div style="font-size:11px;color:#9ca3af">purpl · 12 fl oz · ${CANS_PER_CASE} cans/case</div>
          </td>
          <td style="text-align:center">${li.cases||'—'}</td>
          <td style="text-align:center">${(li.cases||0)*CANS_PER_CASE}</td>
          <td style="text-align:right">${li.pricePerCase ? fmt$(li.pricePerCase) : '—'}</td>
          <td style="text-align:right">${li.lineTotal != null ? fmt$(li.lineTotal) : '—'}</td>
        </tr>`).join('')
      : `<tr>
          <td>
            <strong>Classic Lavender Lemonade</strong>
            <div style="font-size:11px;color:#9ca3af">purpl · 12 fl oz · ${CANS_PER_CASE} cans/case</div>
            ${iv.notes ? `<div style="font-size:11px;color:#6b7280;margin-top:2px">${esc(iv.notes)}</div>` : ''}
          </td>
          <td style="text-align:center">${iv.cases||'—'}</td>
          <td style="text-align:center">${cans||'—'}</td>
          <td style="text-align:right">${iv.pricePerCase ? fmt$(iv.pricePerCase) : '—'}</td>
          <td style="text-align:right">${amt != null ? fmt$(amt) : '<span style="color:#9ca3af">TBD</span>'}</td>
        </tr>`}
  </tbody>
  <tfoot>
    <tr class="total-row">
      <td colspan="4">Total Due</td>
      <td style="text-align:right">
        ${amt != null ? fmt$(amt) :
          '<span style="color:#9ca3af">Amount Pending</span>'}</td>
    </tr>
  </tfoot>
</table>

<div class="payment-box">
  <div class="section-label" style="margin-bottom:10px">Payment Options</div>
  ${paymentHtml}
</div>

<div style="text-align:center;margin:20px 0">
  <button onclick="window.print()"
    style="background:#7B4FA0;color:#fff;border:none;
    padding:10px 24px;border-radius:8px;font-size:14px;
    font-weight:600;cursor:pointer">
    🖨️ Print / Save as PDF</button>
</div>

<div class="footer">
  Thank you for your business — purpl by Pumpkin Blossom Farm
  <br>drinkpurpl.com · lavender@pbfwholesale.com
</div>

</body></html>`);
  w.document.close();
}

// ── Invoice modal helpers (v2 — iv collection) ─────────────

function saveInv(id, isNew) {
  const number    = qs('#iv-number')?.value?.trim() || '';
  const accountId = qs('#iv-account')?.value;
  const date      = qs('#iv-date')?.value || today();
  const due       = qs('#iv-due')?.value || '';
  const status    = qs('#iv-status')?.value || 'draft';
  const notes     = qs('#iv-notes')?.value?.trim() || '';
  const tier      = qs('#iv-tier')?.value || 'direct';

  if (!accountId) { toast('Select an account'); return; }

  const ac          = DB.a('ac').find(x => x.id === accountId) || {};
  const invSettings = DB.obj('invoice_settings', {});

  // Collect line items from DOM
  const lineItems = [];
  qs('#iv-line-items')?.querySelectorAll('.lfi-item-row').forEach(row => {
    const skuId = row.dataset.skuId;
    const cases = parseInt(row.querySelector('.iv-cases')?.value || 0);
    if (!cases) return;
    const ppc    = parseFloat(row.querySelector('.iv-ppc')?.value || 0);
    const skuObj = IV_SKUS.find(s => s.id === skuId);
    lineItems.push({
      skuId,
      skuName:      skuObj?.name || skuId,
      cases,
      units:        cases * CANS_PER_CASE,
      pricePerCase: ppc,
      lineTotal:    cases * ppc,
    });
  });

  if (!lineItems.length) { toast('Enter at least one case quantity'); return; }

  const totalCases = lineItems.reduce((s, l) => s + l.cases, 0);
  const totalCans  = totalCases * CANS_PER_CASE;
  const totalAmt   = lineItems.reduce((s, l) => s + l.lineTotal, 0);

  // isNew may be undefined if called from old code paths — treat missing id as new
  const _isNew   = isNew !== false && !id;
  const existing = _isNew ? null : DB.a('iv').find(x => x.id === id);
  const saveId   = _isNew ? uid() : id;

  const rec = {
    ...(existing||{}),
    id:           saveId,
    number:       number || existing?.number || ('INV-' + String(DB.a('iv').filter(x=>x.number).length+1).padStart(3,'0')),
    accountId,
    accountName:  ac.name || '',
    date,
    due,
    cases:        totalCases,
    cans:         totalCans,
    pricePerCase: lineItems[0]?.pricePerCase || null,
    amount:       totalAmt,
    priceType:    tier,
    status,
    notes,
    lineItems,
    source:       existing?.source || 'manual',
    fromEmail:    invSettings.fromEmail || 'lavender@pbfwholesale.com',
  };

  if (_isNew) DB.push('iv', rec);
  else DB.update('iv', id, () => rec);

  closeModal('modal-add-inv');
  if (currentPage === 'invoices') renderInvoicesPage();
  renderInvoiceStatus();
  toast('Invoice saved ✓');
}

function deleteInvRecord(id) {
  if (!confirm2('Delete this invoice?')) return;
  DB.remove('iv', id);
  closeModal('modal-add-inv');
  if (currentPage === 'invoices') renderInvoicesPage();
  renderInvoiceStatus();
  toast('Invoice deleted');
}

async function importWholesaleInquiries() {
  try {
    const snap = await firebase.firestore()
      .collection('portal_inquiries')
      .where('status', '==', 'new')
      .get();
    if (snap.empty) {
      toast('No new wholesale inquiries');
      return;
    }
    let count = 0;
    for (const doc of snap.docs) {
      const d = doc.data();
      const existing = DB.a('pr').find(function(p) {
        return p.name && d.businessName &&
          p.name.toLowerCase() ===
            d.businessName.toLowerCase();
      });
      if (existing) {
        await firebase.firestore()
          .collection('portal_inquiries')
          .doc(doc.id).update({status:'duplicate'});
        continue;
      }
      DB.push('pr', {
        id: uid(),
        name: d.businessName || '',
        contact: d.contactName || '',
        email: d.email || '',
        phone: d.phone || '',
        address: d.address || '',
        type: d.storeType || 'Other',
        isPbf: (d.brandsInterested || []).includes('lf'),
        status: 'lead',
        priority: 'Medium',
        source: 'Wholesale Page',
        lastContacted: null,
        nextFollowUp: null,
        notes: (function() {
          var noteText = [
            d.storeDescription ? 'Store: ' + d.storeDescription : '',
            d.howHeard ? 'How they heard: ' + d.howHeard : '',
            d.monthlyVolume ? 'Monthly volume: ' + d.monthlyVolume : '',
            d.usesDistributor ? 'Uses distributor: ' + d.usesDistributor : '',
            d.distributorName ? 'Distributor: ' + d.distributorName : '',
            d.contactPreference ? 'Contact pref: ' + d.contactPreference : ''
          ].filter(Boolean).join('\n');
          return noteText ? [{ id: uid(), text: noteText, date: today() }] : [];
        })(),
        nextSteps: 'Follow up within 2 business days — wholesale page application',
        createdAt: today()
      });
      await firebase.firestore()
        .collection('portal_inquiries')
        .doc(doc.id).update({
          status: 'imported',
          importedAt: firebase.firestore
            .FieldValue.serverTimestamp()
        });
      count++;
    }
    renderProspects('');
    toast('Imported ' + count + ' wholesale inquiries as prospects');
  } catch(e) {
    console.error(e);
    toast('Error importing inquiries');
  }
}
