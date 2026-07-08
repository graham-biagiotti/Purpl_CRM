// ═══════════════════════════════════════════════════════
//  app.js  —  purpl CRM  all business logic
//  Called via window.onAppReady() after auth + DB init
// ═══════════════════════════════════════════════════════

// ── Unit conversion constant ─────────────────────────────
// Orders and deliveries are tracked in CASES.
// Inventory (iv collection) is tracked in individual CANS.
// Always use CANS_PER_CASE when converting between them.
const CANS_PER_CASE = 12;
const PURPL_MSRP = 3.29;                          // suggested retail, per can
const PURPL_WHOLESALE_PER_CAN = 2.30;             // standard wholesale, per can
const PURPL_DIRECT_PER_CASE = PURPL_WHOLESALE_PER_CAN * CANS_PER_CASE; // $27.60

function _costs() { return DB?.obj?.('costs', {cogs:{}, target_margin:0.60, overhead_monthly:1200}) || {cogs:{}, target_margin:0.60, overhead_monthly:1200}; }
function _cogs(sku) { return _costs().cogs?.[sku] || 2.15; }
function _margin() { return _costs().target_margin || 0.60; }
function _payTerms() { return DB?.obj?.('settings',{})?.default_payment_terms || DB?.obj?.('settings',{})?.payment_terms || 30; }
function _gasPrice() { return DB?.obj?.('settings',{})?.gasPrice || 3.50; }
function _lowStock() { return DB?.obj?.('settings',{})?.lowStockThreshold || 500; }

// ── Pricing helper — single fallback chain ──────────────
function _calcPricePerCase(account) {
  const ac = account || {};
  const isDist = ac.fulfilledBy && ac.fulfilledBy !== 'direct';
  const acPrice = parseFloat(isDist ? ac.pricePerCaseDist : (ac.pricePerCaseDirect || ac.pricePerCaseCustom)) || 0;
  return acPrice || PURPL_DIRECT_PER_CASE;
}

// ── Account lookup helper ───────────────────────────────
function _findAccount(accountId, fallbackName) {
  if (accountId) { const a = DB.a('ac').find(x => x.id === accountId); if (a) return a; }
  if (fallbackName) return DB.a('ac').find(a => (a.name||'').toLowerCase().trim() === (fallbackName||'').toLowerCase().trim());
  return null;
}

// ── Overdue helper ──────────────────────────────────────
function _isOverdue(inv) {
  if (['paid','draft','void'].includes(inv.status)) return false;
  const due = inv.dueDate || inv.due;
  return !!due && due < today();
}

// ── Invoice helpers — single source of truth ────────────
const _INV_COLS = ['retail_invoices', 'lf_invoices', 'combined_invoices', 'dist_invoices', 'iv'];

function _allPurplInvoices() {
  const ids = new Set(DB.a('retail_invoices').map(x => x.id));
  return [...DB.a('retail_invoices'), ...DB.a('iv').filter(x => (x.number || x.invoiceNumber) && !ids.has(x.id))];
}

function _allInvoices(opts) {
  const o = opts || {};
  const retailIds = new Set(DB.a('retail_invoices').map(x => x.id));
  const all = [
    ...DB.a('retail_invoices').map(x => ({...x, _col: 'retail_invoices', _brand: 'purpl'})),
    ...DB.a('iv').filter(x => (x.number || x.invoiceNumber) && !retailIds.has(x.id)).map(x => ({...x, _col: 'iv', _brand: 'purpl'})),
    ...DB.a('lf_invoices').map(x => ({...x, _col: 'lf_invoices', _brand: 'lf'})),
    ...DB.a('combined_invoices').map(x => ({...x, _col: 'combined_invoices', _brand: 'combined'})),
    ...DB.a('dist_invoices').map(x => ({...x, _col: 'dist_invoices', _brand: 'dist'})),
  ];
  let result = all;
  if (o.excludeChildren) result = result.filter(x => !x.combinedInvoiceId);
  if (o.brand) result = result.filter(x => x._brand === o.brand);
  if (o.status) result = result.filter(x => x.status === o.status);
  if (o.accountId) result = result.filter(x => x.accountId === o.accountId);
  return result;
}

function findInvoice(id) {
  for (const col of _INV_COLS) {
    const found = DB.a(col).find(x => x.id === id);
    if (found) return found;
  }
  return null;
}

function _invoiceCol(id) {
  for (const col of _INV_COLS) {
    if (DB.a(col).some(x => x.id === id)) return col;
  }
  return 'retail_invoices';
}

function updateInvoice(id, fn) { DB.update(_invoiceCol(id), id, fn); }

function deleteInvoiceWithCleanup(id) {
  DB.atomicUpdate(cache => {
    for (const col of _INV_COLS) {
      const i = (cache[col]||[]).findIndex(x => x.id === id);
      if (i >= 0) { cache[col].splice(i, 1); break; }
    }
    cache.iv = (cache.iv||[]).filter(e => !(e.invoiceId === id && e.type === 'out'));
    cache.lf_wix_deductions = (cache.lf_wix_deductions||[]).filter(d => d.invoiceId !== id);
    // HIGH-5: if the deleted invoice is a child of a combined invoice, remove
    // the combined parent AND dissolve the combination on the surviving
    // sibling — otherwise the sibling keeps combinedInvoiceId pointing at a
    // deleted parent, so reports (which filter !combinedInvoiceId) exclude it
    // and its dollars vanish entirely.
    const ci = (cache.combined_invoices||[]).findIndex(x => x.purplInvoiceId === id || x.lfInvoiceId === id);
    if (ci >= 0) {
      const parent = cache.combined_invoices[ci];
      const siblingId = parent.purplInvoiceId === id ? parent.lfInvoiceId : parent.purplInvoiceId;
      if (siblingId) {
        for (const col of ['retail_invoices','lf_invoices','iv','dist_invoices']) {
          const si = (cache[col]||[]).findIndex(x => x.id === siblingId);
          if (si >= 0) { cache[col][si] = { ...cache[col][si], combinedInvoiceId: null }; break; }
        }
      }
      cache.combined_invoices.splice(ci, 1);
    }
    cache.ac = (cache.ac||[]).map(a =>
      (a.cadence||[]).some(c => c.invoiceId === id)
        ? { ...a, cadence: a.cadence.filter(c => c.invoiceId !== id) }
        : a
    );
  });
}

function _invAmt(inv) { return parseFloat(inv.grandTotal || inv.amount || inv.total || 0); }

function _onHand(skuId, pool) {
  return Math.max(0, _onHandRaw(skuId, pool));
}
// Unclamped balance — negative means more was deducted from a pool than it
// held (deductions never check availability). _onHand hides this, which makes
// Warehouse + Farm quietly stop summing to Total; the inventory page surfaces
// raw negatives as an explicit warning instead.
function _onHandRaw(skuId, pool) {
  const iv = DB.a('iv');
  const match = i => i.sku === skuId && (pool ? (i.pool || 'warehouse') === pool : true);
  const ins  = iv.filter(i => match(i) && (i.type === 'in' || i.type === 'return')).reduce((t, i) => t + i.qty, 0);
  const outs = iv.filter(i => match(i) && i.type === 'out').reduce((t, i) => t + i.qty, 0);
  return ins - outs;
}

// Look up email tracking status for an invoice from the account's cadence array
// Returns a small HTML badge string or '' if no send event
function _invEmailBadge(inv) {
  if (!inv?.accountId) return '';
  const ac = DB.a('ac').find(x => x.id === inv.accountId);
  if (!ac) return '';
  const entry = (ac.cadence||[]).find(c => c.invoiceId === inv.id && (c.stage === 'invoice_sent' || c.stage === 'invoice_reminder'));
  if (!entry) return '';
  if (entry.opened) return `<span class="badge green" title="Opened ${entry.openedAt||''}" style="font-size:9px;margin-left:4px">👁</span>`;
  if (entry.clicked) return `<span class="badge blue" title="Clicked ${entry.clickedAt||''}" style="font-size:9px;margin-left:4px">🔗</span>`;
  return `<span class="badge gray" title="Sent ${entry.sentAt||''}, not yet opened" style="font-size:9px;margin-left:4px">✉</span>`;
}

// ── Helpers ─────────────────────────────────────────────
function _once(fn) {
  let running = false;
  return async function(...args) {
    if (running) return;
    running = true;
    try { await fn.apply(this, args); }
    finally { setTimeout(() => { running = false; }, 400); }
  };
}
function _pushCadence(existing, entry) {
  const arr = [...(existing || []), entry];
  return arr.length > 500 ? arr.slice(-500) : arr;
}
const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const today = () => new Date().toISOString().slice(0,10);
const fmt   = (n, d=0) => (+n||0).toLocaleString(undefined, {minimumFractionDigits:d, maximumFractionDigits:d});
const fmtC  = (n) => '$' + fmt(n,2);
const _parseD = (s) => { if (!s) return NaN; return s.includes('T') ? new Date(s) : new Date(s+'T12:00:00'); };
const fmtD  = (s) => { const d = _parseD(s); return isNaN(d) ? '—' : d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); };
const fmtDLong = (s) => { const d = _parseD(s); return isNaN(d) ? '—' : d.toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}); };
const daysAgo = (s) => { const d = _parseD(s); return isNaN(d) ? 999 : Math.floor((Date.now()-d)/(864e5)); };

function _currentUserName() {
  const u = window._currentUser;
  return u?.displayName || u?.email?.split('@')[0] || 'unknown';
}
function _currentUserEmail() {
  return window._currentUser?.email || '';
}
function _isAdmin() {
  return window._userRole === 'admin';
}

function toast(msg, dur=3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), dur);
}

function confirm2(msg) { return window.confirm(msg); }

function generateSecureToken(prefix) {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes).map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
  return btoa((prefix || '') + ':' + rand).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

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
const SKUS = [
  {id:'classic',    label:'Classic',    cls:'sku-classic',    bg:'classic-bg'},
  {id:'blueberry',  label:'Blueberry',  cls:'sku-blueberry',  bg:'blueberry-bg'},
  {id:'peach',      label:'Peach',      cls:'sku-peach',       bg:'peach-bg'},
  {id:'variety',    label:'Variety',    cls:'sku-variety',     bg:'variety-bg'},
];
// Discontinued SKUs — excluded from all entry forms, but kept here so
// historical invoices/orders/inventory still render with correct badges.
const ARCHIVED_SKUS = [
  {id:'raspberry',  label:'Raspberry',  cls:'sku-raspberry',   bg:'raspberry-bg'},
];
const SKU_MAP = Object.fromEntries([...SKUS, ...ARCHIVED_SKUS].map(s=>[s.id,s]));
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
  document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
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
    'pre-orders':'Portal Orders', invoices:'Invoices', emails:'Emails'
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
  settings:         () => { renderSettings(); loadShipStationSettings(); },
  'pre-orders':     renderPreOrders,
  invoices:         () => { renderInvoicesPage(); loadInvoiceSettings(); },
  emails:           renderEmailsPage,
};

// ── Audit Log ────────────────────────────────────────────
function auditLog(action, entityType, entityId, entityName, extra) {
  if (!DB._firestoreReady) return;
  DB.push('audit_log', {
    id:         uid(),
    timestamp:  new Date().toISOString(),
    action,
    entityType,
    entityId,
    entityName: entityName || '',
    changedBy:  _currentUserName(),
    changedByEmail: _currentUserEmail(),
    ...(extra || {}),
  });
}
function _requireAdmin(action) {
  if (_isAdmin()) return true;
  toast(`Only admins can ${action}`);
  return false;
}

// ── STATUS CONFIG ────────────────────────────────────────
const AC_STATUS = {
  active:   {label:'Active',   cls:'green'},
  pending:  {label:'Pending',  cls:'blue'},
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
function _signatureHTML() {
  return `<table width="100%" cellpadding="0" cellspacing="0">
  <tr>
    <td style="padding-top:16px;border-top:1px solid #e5e7eb;
      font-family:Inter,Arial,sans-serif;font-size:13px;
      color:#6b7280;line-height:1.6">
      <strong style="color:#1a1a2e">Graham Biagiotti</strong>
      — Director of Sales<br>
      603-748-3038 · Warner, NH<br>
      Pumpkin Blossom Farm | purpl &amp; Lavender Fields
      <div style="margin-top:8px;font-size:13px;color:#6b7280">
        <a href="mailto:lavender@pbfwholesale.com"
          style="color:#8B5FBF;text-decoration:none">
          lavender@pbfwholesale.com
        </a> · 603-748-3038
      </div>
    </td>
  </tr>
</table>`;
}

const PBF_HEADER_HTML = `
<table width="100%" cellpadding="0" cellspacing="0"
  style="background:#6B4F9A;background:linear-gradient(135deg,#6B4F9A 0%,#9B73C4 100%);border-radius:8px 8px 0 0">
  <tr>
    <td style="padding:32px 40px;text-align:center">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr><td align="center">
          <table cellpadding="0" cellspacing="0" width="auto">
            <tr>
              <td width="auto" valign="middle" style="padding-right:16px">
                <span style="font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:700;color:#ffffff;letter-spacing:1px">purpl</span>
              </td>
              <td width="1px" valign="middle">
                <div style="width:1px;height:44px;background:rgba(255,255,255,0.5)"></div>
              </td>
              <td width="auto" valign="middle" style="padding-left:16px">
                <span style="font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#ffffff;white-space:nowrap">Lavender Fields</span>
              </td>
            </tr>
          </table>
        </td></tr>
      </table>
      <div style="text-align:center;font-family:Arial,sans-serif;font-size:10px;
        color:rgba(255,255,255,0.9);letter-spacing:0.15em;
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

function _stripeErrHint(e) {
  const code = String(e?.code || '');
  if (code.includes('not-found'))           return 'the createStripePaymentLink function is not deployed — run: firebase deploy --only functions';
  if (code.includes('failed-precondition')) return 'STRIPE_SECRET_KEY is not set — run: firebase functions:secrets:set STRIPE_SECRET_KEY, then redeploy functions';
  if (code.includes('unauthenticated'))     return 'you are signed out — refresh the page and sign in';
  if (code.includes('invalid-argument'))    return e?.message || 'invalid invoice data';
  return e?.message || 'unknown error';
}

// Sticky error banner — stays on screen until dismissed, unlike toasts.
function _stickyError(msg) {
  let el = document.getElementById('sticky-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sticky-error';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:#fef3c7;color:#92400e;border-bottom:2px solid #f59e0b;padding:12px 44px 12px 16px;font-size:13px;font-weight:500;line-height:1.5;box-shadow:0 2px 12px rgba(0,0,0,.15)';
    const x = document.createElement('button');
    x.textContent = '✕';
    x.style.cssText = 'position:absolute;top:8px;right:10px;background:none;border:none;font-size:16px;cursor:pointer;color:#92400e;padding:4px';
    x.onclick = () => el.remove();
    el.appendChild(x);
    const span = document.createElement('span');
    span.id = 'sticky-error-msg';
    el.insertBefore(span, x);
    document.body.appendChild(el);
  }
  const span = el.querySelector('#sticky-error-msg');
  if (span) span.textContent = msg;
}

// ── ShipStation integration ────────────────────────────────
function saveShipStationSettings() {
  const storeId = document.getElementById('set-shipstation-store')?.value || '';
  const fromAddr = document.getElementById('set-shipstation-from')?.value || '';
  DB.setObj('shipstation_settings', { ...DB.obj('shipstation_settings', {}), storeId, fromAddress: fromAddr });
  toast('ShipStation settings saved ✓');
}
function loadShipStationSettings() {
  const s2 = DB.obj('shipstation_settings', {});
  const set = (id, val) => { const el=document.getElementById(id); if(el&&val!=null) el.value=val; };
  set('set-shipstation-store', s2.storeId);
  set('set-shipstation-from', s2.fromAddress);
}

async function testShipStationConnection() {
  const el = document.getElementById('shipstation-test-result');
  if (!el) return;
  el.style.color = 'var(--muted)'; el.textContent = 'Testing…';
  try {
    const fn = firebase.functions().httpsCallable('shipStationStatus');
    const d = (await fn({})).data;
    if (d.ok) {
      const storeList = (d.stores||[]).map(st => st.name + ' (ID: ' + st.id + ')').join(', ') || 'none found';
      el.style.color = '#16a34a';
      el.textContent = '✓ Connected. Stores: ' + storeList;
    } else {
      el.style.color = '#dc2626'; el.textContent = '✗ ' + (d.error||'unknown');
    }
  } catch (e) {
    el.style.color = '#dc2626';
    el.textContent = '✗ ' + (String(e?.code||'').includes('not-found')
      ? 'shipStationStatus not deployed — run: firebase deploy --only functions' : (e?.message||'error'));
  }
}

function _parseAddress(addr) {
  const out = {street1:'', street2:'', city:'', state:'', zip:''};
  if (!addr || typeof addr !== 'string') return out;
  // Robust: strip a trailing country, pull the zip then the 2-letter state off
  // the end (commas optional, any case), then the last comma-segment is the
  // city and the rest is the street. Handles "...NH 03278, USA", "...NH 03278",
  // "...Warner NH 03278" (no comma), and lowercase states.
  let rest = addr.trim().replace(/,?\s*(USA|United States)\.?\s*$/i, '').trim();
  const zipM = rest.match(/(\d{5}(?:-\d{4})?)\s*$/);
  if (zipM) { out.zip = zipM[1]; rest = rest.slice(0, zipM.index).replace(/[,\s]+$/, ''); }
  const stM = rest.match(/[,\s]+([A-Za-z]{2})\s*$/);
  if (stM) { out.state = stM[1].toUpperCase(); rest = rest.slice(0, stM.index).replace(/[,\s]+$/, ''); }
  const segs = rest.split(',').map(p => p.trim()).filter(Boolean);
  if (segs.length >= 2) {
    out.city = segs[segs.length - 1];
    out.street1 = segs.slice(0, segs.length - 1).join(', ');
  } else {
    out.street1 = segs[0] || rest;
  }
  return out;
}

async function pushInvoiceToShipStation(invoiceId, collection) {
  const inv = collection === 'lf_invoices'
    ? DB.a('lf_invoices').find(x => x.id === invoiceId)
    : (collection === 'combined_invoices'
        ? DB.a('combined_invoices').find(x => x.id === invoiceId)
        : findInvoice(invoiceId));
  if (!inv) { toast('Invoice not found'); return false; }
  if (inv.shipStationOrderId) { toast('Already pushed to ShipStation'); return true; }
  const ac = DB.a('ac').find(a => a.id === inv.accountId) || {};
  if (!ac.address && !ac.shipAddress) { _stickyError('Cannot push to ShipStation: no shipping address on this account. Add one in the account first.'); return false; }

  const addr = _parseAddress(ac.shipAddress || ac.address || '');
  const ss = DB.obj('shipstation_settings', {});
  const invNum = inv.number || inv.invoiceNumber || '';
  const brand = collection === 'combined_invoices' ? 'purpl + LF' : (collection === 'lf_invoices' ? 'Lavender Fields' : 'purpl');

  // A combined invoice's parent has NO lineItems of its own — its items live in
  // the two child invoices (purpl + LF). Gather from both, same as the preview.
  let _lineItems = inv.lineItems || [];
  if (collection === 'combined_invoices') {
    const _purplInv = findInvoice(inv.purplInvoiceId) || {};
    const _lfInv    = DB.a('lf_invoices').find(x => x.id === inv.lfInvoiceId) || {};
    _lineItems = [...( _purplInv.lineItems || _purplInv.items || [] ), ...( _lfInv.lineItems || [] )];
  }

  const items = [];
  _lineItems.forEach(li => {
    if (li.hasVariants && li.variantLines) {
      li.variantLines.forEach(vl => items.push({
        sku: (li.skuId||li.skuName||'') + '-' + (vl.variantId||vl.variantName||''),
        name: (li.skuName||'') + ' — ' + (vl.variantName||''),
        quantity: vl.units || vl.cases || 1,
        unitPrice: parseFloat(li.unitPrice || 0),
      }));
    } else {
      items.push({
        sku: li.skuId || li.sku || '',
        name: li.skuName || li.sku || li.description || 'Item',
        quantity: li.cases || li.qty || li.units || 1,
        unitPrice: parseFloat(li.pricePerCase || li.unitPrice || 0),
      });
    }
  });
  if (!items.length) { toast('Invoice has no line items'); return false; }

  toast('Pushing to ShipStation…');
  try {
    const fn = firebase.functions().httpsCallable('pushToShipStation');
    const result = await fn({
      invoiceNumber: invNum,
      invoiceId: inv.id || null,
      accountName: ac.name || inv.accountName || '',
      customerEmail: ac.email || '',
      brand,
      storeId: ss.storeId || null,
      notes: inv.notes || '',
      shipTo: { name: ac.name || '', ...addr, phone: ac.phone || '' },
      items,
    });
    const d = result.data || {};
    if (d.ok) {
      DB.update(collection || _invoiceCol(invoiceId), invoiceId, x => ({
        ...x,
        deliveryMethod: 'ship',
        shipStationOrderId: d.orderId,
        shipStationPushedAt: new Date().toISOString(),
      }));
      auditLog('ship_push', collection.replace('_invoices','')+'_invoice', invoiceId, invNum, {shipStationOrderId: d.orderId});
      toast('Pushed to ShipStation ✓ — order #' + (d.orderNumber || invNum));
      if (currentPage === 'invoices') renderInvoicesPage();
      return true;
    } else {
      _stickyError('ShipStation push failed: ' + (d.error || 'unknown'));
      return false;
    }
  } catch (e) {
    _stickyError('ShipStation push failed: ' + (e?.message || 'unknown'));
    return false;
  }
}

// ── Shipped-invoice notification ───────────────────────────
// Called on every snapshot refresh. Checks for invoices that the
// ShipStation webhook just updated (readyToSend=true) and shows a
// sticky banner so the user can review and send.
const _notifiedShipIds = new Set();
function _checkShippedInvoices() {
  if (_notifiedShipIds.size > 500) _notifiedShipIds.clear();
  const allInvs = [
    ..._allPurplInvoices().filter(x => x.readyToSend && !_notifiedShipIds.has(x.id)),
    ...DB.a('lf_invoices').filter(x => x.readyToSend && !_notifiedShipIds.has(x.id)),
    ...DB.a('combined_invoices').filter(x => x.readyToSend && !_notifiedShipIds.has(x.id)),
  ];
  if (!allInvs.length) return;
  allInvs.forEach(inv => _notifiedShipIds.add(inv.id));
  const names = allInvs.map(inv => (inv.number || inv.invoiceNumber || '—') + ' · ' + (inv.accountName || '')).join(', ');
  _showShippedBanner(allInvs, names);
}

function _showShippedBanner(invoices, names) {
  let el = document.getElementById('shipped-banner');
  if (el) el.remove();
  el = document.createElement('div');
  el.id = 'shipped-banner';
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:#dcfce7;color:#166534;border-bottom:2px solid #86efac;padding:14px 50px 14px 18px;font-size:13.5px;font-weight:500;line-height:1.5;box-shadow:0 4px 16px rgba(0,0,0,.12);display:flex;align-items:center;gap:14px;flex-wrap:wrap';
  const msg = document.createElement('span');
  msg.innerHTML = '📦 <strong>Shipped!</strong> ' + escHtml(names) + ' — shipping cost + tracking added. Review and send when ready.';
  el.appendChild(msg);
  invoices.forEach(inv => {
    const col = DB.a('combined_invoices').find(x => x.id === inv.id) ? 'combined_invoices'
      : DB.a('lf_invoices').find(x => x.id === inv.id) ? 'lf_invoices' : 'retail_invoices';
    const btn = document.createElement('button');
    btn.className = 'btn sm primary';
    btn.textContent = 'Open ' + (inv.number || inv.invoiceNumber || '');
    btn.onclick = () => {
      el.remove();
      if (col === 'combined_invoices') { nav('invoices'); openCombinedInvoicePreview(inv.id); }
      else if (col === 'lf_invoices')  { nav('invoices'); openLfInvoiceModal(inv.id); }
      else                             { nav('invoices'); openInvModal(inv.id); }
    };
    el.appendChild(btn);
  });
  const x = document.createElement('button');
  x.textContent = '✕';
  x.style.cssText = 'position:absolute;top:10px;right:12px;background:none;border:none;font-size:18px;cursor:pointer;color:#166534;padding:4px';
  x.onclick = () => el.remove();
  el.appendChild(x);
  document.body.appendChild(el);
}

// When the user sends a "readyToSend" invoice, clear the flag so the
// banner doesn't reappear.
function _clearReadyToSend(invoiceId, collection) {
  DB.update(collection, invoiceId, x => {
    const copy = { ...x };
    delete copy.readyToSend;
    return copy;
  });
}

function ivDeliveryMethodChange() {
  const method = qs('#iv-delivery-method')?.value || 'deliver';
  const statusEl = qs('#iv-ship-status');
  if (statusEl) statusEl.style.display = method === 'ship' ? '' : 'none';
  if (method === 'ship' && statusEl) {
    const acId = qs('#iv-account')?.value;
    const ac = acId ? DB.a('ac').find(x => x.id === acId) : null;
    statusEl.innerHTML = ac?.address
      ? `<div style="font-size:12px;color:var(--muted);padding:6px 0;border-bottom:1px solid var(--border)">📦 Will ship to: <strong>${escHtml(ac.address)}</strong></div>`
      : `<div style="font-size:12px;color:#dc2626;padding:6px 0">⚠ No address on file for this account</div>`;
  }
}
function lfiDeliveryMethodChange() {
  const method = qs('#lfi-delivery-method')?.value || 'deliver';
  const statusEl = qs('#lfi-ship-status');
  if (statusEl) statusEl.style.display = method === 'ship' ? '' : 'none';
  if (method === 'ship' && statusEl) {
    const acId = qs('#lfi-account')?.value;
    const ac = acId ? DB.a('ac').find(x => x.id === acId) : null;
    statusEl.innerHTML = ac?.address
      ? `<div style="font-size:12px;color:var(--muted);padding:6px 0;border-bottom:1px solid var(--border)">📦 Will ship to: <strong>${escHtml(ac.address)}</strong></div>`
      : `<div style="font-size:12px;color:#dc2626;padding:6px 0">⚠ No address on file for this account</div>`;
  }
}

async function _getStripePayLink(invoice, type) {
  if (!invoice?.id || !parseFloat(invoice.total || invoice.amount || invoice.grandTotal)) return null;
  try {
    const fn = firebase.functions().httpsCallable('createPayLink');
    const result = await fn({
      amount: parseFloat(invoice.total || invoice.amount || invoice.grandTotal || 0),
      invoiceNumber: invoice.number || invoice.invoiceNumber ||
        ('INV-' + String(invoice.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase()),
      invoiceId: invoice.id,
      invoiceType: type || 'retail',
      accountName: invoice.accountName || '',
      accountId: invoice.accountId || '',
    });
    const d = result.data || {};
    if (d.ok && d.url) {
      const old = document.getElementById('sticky-error');
      if (old) old.remove();
      return d.url;
    }
    _stickyError('Stripe pay link failed: ' + (d.error || 'no link returned') + ' — the invoice will send without a pay button.');
    return null; // no generic-link fallback — unmatchable payments
  } catch (e) {
    console.error('Stripe link generation failed:', e);
    const hint = String(e?.code || '').includes('not-found')
      ? 'The createPayLink function is not deployed yet — run: firebase deploy --only functions --project default'
      : (e?.message || 'unknown error');
    _stickyError('⚠ Stripe pay link failed: ' + hint + ' — the invoice will go out WITHOUT a pay button.');
    return null; // no generic-link fallback — unmatchable payments
  }
}

async function callSendCombinedInvoice(to, accountName, subject, html, accountId, invoiceNumber) {
  try {
    const fn = firebase.functions().httpsCallable('sendCombinedInvoice');
    const result = await fn({to, accountName, subject, html, accountId: accountId || null, invoiceNumber: invoiceNumber || null});
    return result.data;
  } catch (err) {
    console.error('Send combined invoice error:', err);
    throw err;
  }
}

async function callSendOrderConfirmation(to, accountName, contactName, orderSummary, portalLink, isPbf, portalOrderId, accountId, shipAddress, requestSample, mode) {
  try {
    const fn = firebase.functions().httpsCallable('sendOrderConfirmation');
    const result = await fn({to, accountName, contactName, orderSummary, portalLink, isPbf, portalOrderId: portalOrderId || null, accountId: accountId || null, shipAddress: shipAddress || null, requestSample: requestSample || false, mode: mode || 'preorder'});
    return result.data;
  } catch (err) {
    console.error('Send order confirmation error:', err);
    throw err;
  }
}

function _sendWithCadence({to, subject, html, accountId, stage, extra={}, sendFn}) {
  const fn = sendFn || ((t,s,h) => callSendEmail(t, 'lavender@pbfwholesale.com', s, h));
  return fn(to, subject, html)
    .then(result => {
      if (accountId && stage) {
        const entry = {id: uid(), stage, sentAt: new Date().toISOString(), sentBy: _currentUserName(), method: 'resend', ...extra};
        if (result?.id) entry.sentMessageId = result.id;
        DB.update('ac', accountId, a => ({...a, lastContacted: today(), cadence: _pushCadence(a.cadence, entry)}));
      }
      toast('Email sent ✓');
      return result;
    })
    .catch(err => {
      console.warn('Resend failed, opening Gmail:', err);
      toast('Resend unavailable — opening Gmail');
      window.open(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}`, '_blank');
      if (accountId && stage) {
        const entry = {id: uid(), stage, sentAt: new Date().toISOString(), sentBy: _currentUserName(), method: 'gmail', ...extra};
        DB.update('ac', accountId, a => ({...a, lastContacted: today(), cadence: _pushCadence(a.cadence, entry)}));
      }
      return null;
    });
}

function buildEmailHTML(headerHTML, accentColor, bodyHTML, unsubscribeAccountId) {
  const unsubRow = unsubscribeAccountId
    ? `<tr><td style="background:#f9fafb;padding:10px 40px 16px;
        border-top:1px solid #e5e7eb;text-align:center;
        font-size:11px;color:#6b7280">
        <a href="https://purpl-crm.web.app/unsubscribe?id=${encodeURIComponent(unsubscribeAccountId)}"
          style="color:#6b7280">Unsubscribe from marketing emails</a>
      </td></tr>`
    : '';
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
        <br><br>${_signatureHTML()}
      </td></tr>
      <tr><td style="background:#f9fafb;padding:20px 40px;
        border-top:1px solid #e5e7eb;text-align:center;
        font-size:11px;color:#6b7280;line-height:1.6">
        Pumpkin Blossom Farm LLC<br>
        393 Pumpkin Hill Rd · Warner, NH 03278<br>
        <a href="mailto:lavender@pbfwholesale.com"
          style="color:#6b7280">lavender@pbfwholesale.com</a>
        &nbsp;·&nbsp;603-748-3038<br>
        <a href="https://drinkpurpl.com"
          style="color:#6b7280">drinkpurpl.com</a>
        &nbsp;·&nbsp;
        <a href="https://pumpkinblossomfarm.com"
          style="color:#6b7280">pumpkinblossomfarm.com</a>
      </td></tr>
      ${unsubRow}
    </table>
  </td></tr>
</table></body></html>`;
}

function getCadenceEmailTemplate(stage, account, extra={}) {
  const header = PBF_HEADER_HTML;
  const accentColor = '#8B5FBF';
  const contacts = account.contacts||[];
  const primary = contacts.find(c=>c.isPrimary)||contacts[0]||{};
  const contactName = escHtml(primary.name||account.contact||'there');
  const businessName = escHtml(account.name||'your store');
  const businessNameRaw = account.name || 'your store'; // subjects are plain text — escHtml entities (&#39;) render literally there
  const _hasPortalToken = !!account.orderPortalToken; // copy below adapts — never claim 'no password needed' on the password-gated URL
  const portalLink = account.orderPortalToken
    ? `https://pbfwholesale.com/order?t=${account.orderPortalToken}`
    : 'https://pbfwholesale.com/order';
  // Pre-order first-delivery estimate, formatted "Month Day". Configurable via
  // extra.launchDate (Portal Settings launch date); defaults to the launch week.
  const _launchWk = (() => {
    try { return new Date((extra.launchDate || '2026-07-27') + 'T12:00:00')
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric' }); }
    catch(_) { return 'July 27'; }
  })();

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
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`)
    },
    'preorder-announcement': {
      subject: `Something new from the farm — purpl lavender lemonade`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p style="line-height:1.7">It's Graham from Pumpkin Blossom Farm. I hope this finds you well. I wanted to share something we've been working on that I'm really excited about.</p>
        <p style="line-height:1.7">We're launching <strong>purpl</strong>, a classic lemonade crafted with real lavender, born out of our love for lavender here at Pumpkin Blossom Farm. If you've carried our Lavender Fields products, you already know our commitment to quality. purpl is that same care in a can. Simple ingredients, gentle lavender, refreshing lemonade. The kind of product that sells itself once someone tries it.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
          <tr><td style="padding:20px 24px;background:#faf5ff;border-radius:8px;border:1px solid #e9d5ff">
            <div style="font-size:16px;font-weight:600;color:#4B2082;margin-bottom:10px">Classic Lavender Lemonade</div>
            <table cellpadding="0" cellspacing="0" style="font-size:14px;color:#374151;line-height:2">
              <tr><td style="padding-right:24px">Wholesale price</td><td style="font-weight:600">$2.30/can</td></tr>
              <tr><td style="padding-right:24px">Case (12-pack)</td><td style="font-weight:600">$27.60</td></tr>
              <tr><td style="padding-right:24px">Suggested retail</td><td style="font-weight:600">$3.29</td></tr>
              <tr><td style="padding-right:24px">Format</td><td>12 fl oz cans</td></tr>
            </table>
          </td></tr>
        </table>
        <p style="line-height:1.7">We're taking pre-orders now so you can be first in line when we launch. No commitment, just let us know you're interested and I'll personally follow up to confirm availability and work out delivery.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr><td style="padding:12px 20px;background:#faf5ff;border-radius:8px;border:1px solid #e9d5ff;text-align:center;font-size:15px;color:#4B2082;font-weight:600">📦 First delivery the week of ${_launchWk}</td></tr></table>
        <p style="line-height:1.7">If you already carry our <strong>Lavender Fields</strong> line (scrunchies, sachets, candles), your wholesale portal now includes purpl as well, one link for both brands. If you're new to us, welcome! I've set up an account for you.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
          <tr><td style="padding:20px 24px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb">
            <div style="font-size:13px;font-weight:600;color:#1a1a2e;margin-bottom:12px">Two ways to order:</div>
            <div style="margin-bottom:16px">
              <div style="font-size:13px;color:#374151;margin-bottom:8px"><strong>Option 1:</strong> ${_hasPortalToken ? 'Click your personalized link below. Goes straight to your order form, no password needed.' : 'Click the button below to open the order form, then enter the wholesale password from Option 2.'}</div>
              <div style="text-align:center"><a href="${portalLink}" style="display:inline-block;background:#8B5FBF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">Place a Pre-Order</a></div>
            </div>
            <div style="border-top:1px solid #e5e7eb;padding-top:12px">
              <div style="font-size:13px;color:#374151"><strong>Option 2:</strong> Visit <a href="https://pbfwholesale.com/order" style="color:#8B5FBF">pbfwholesale.com/order</a> and enter the wholesale password:</div>
              <div style="font-size:15px;font-weight:700;color:#1a1a2e;margin-top:6px;letter-spacing:0.5px">${escHtml(extra.portalPassword || 'purpleherb')}</div>
            </div>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
          <tr><td style="padding:16px 20px;background:#f9fafb;border-radius:6px;border-left:3px solid #1a1a2e">
            <div style="font-size:13px;color:#374151;line-height:1.8">
              <strong>purpl orders:</strong> Free delivery on 8+ cases throughout NH, MA, Southern ME, and Southern VT. Smaller orders — warehouse pickup or parcel ship (billed at cost).<br>
              <strong>Lavender Fields orders:</strong> Free delivery on orders of $250 or more in those areas; smaller orders by pickup or parcel.<br>
              <strong>Ordering both:</strong> purpl and Lavender Fields combine — free delivery once you hit 8 cases of purpl or $250 total, in one drop.<br>
              <strong>Payment:</strong> Net 30 from invoice date.<br>
              <strong>Samples:</strong> Request a free 3-can taster right on the order form, no obligation.<br>
              <strong>Wholesale site:</strong> <a href="https://pbfwholesale.com" style="color:${accentColor}">pbfwholesale.com</a>
            </div>
          </td></tr>
        </table>
        <p style="line-height:1.7;font-size:14px">I'd love to have purpl on your shelves. Reply to this email, give me a call, or just click the link above. Whatever's easiest, I'm here for anything you need.</p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`, account.id)
    },
    'approved': {
      subject: `Your wholesale account is ready — ${businessNameRaw}`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p style="line-height:1.7">Great news! Your wholesale account for <strong>${businessName}</strong> has been approved. You're all set to start ordering.</p>
        <p style="line-height:1.7">I've set up a personalized order portal for you below. You can also visit <a href="https://pbfwholesale.com" style="color:${accentColor}">pbfwholesale.com</a> for product info and our sell sheet.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0">
          <tr><td style="padding:20px 24px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb">
            <div style="font-size:13px;font-weight:600;color:#1a1a2e;margin-bottom:12px">Two ways to order:</div>
            <div style="margin-bottom:16px">
              <div style="font-size:13px;color:#374151;margin-bottom:8px"><strong>Option 1:</strong> ${_hasPortalToken ? 'Click your personalized link below. Goes straight to your order form, no password needed.' : 'Click the button below to open the order form, then enter the wholesale password from Option 2.'}</div>
              <div style="text-align:center"><a href="${portalLink}" style="display:inline-block;background:#8B5FBF;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">Place Your First Order</a></div>
            </div>
            <div style="border-top:1px solid #e5e7eb;padding-top:12px">
              <div style="font-size:13px;color:#374151"><strong>Option 2:</strong> Visit <a href="https://pbfwholesale.com/order" style="color:#8B5FBF">pbfwholesale.com/order</a> and enter the wholesale password:</div>
              <div style="font-size:15px;font-weight:700;color:#1a1a2e;margin-top:6px;letter-spacing:0.5px">${escHtml(extra.portalPassword || 'purpleherb')}</div>
            </div>
          </td></tr>
        </table>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px">
          <tr><td style="padding:16px 20px;background:#f9fafb;border-radius:6px;border-left:3px solid #1a1a2e">
            <div style="font-size:13px;color:#374151;line-height:1.8">
              <strong>purpl orders:</strong> Free delivery on 8+ cases throughout NH, MA, Southern ME, and Southern VT. Smaller orders — warehouse pickup or parcel ship (billed at cost).<br>
              <strong>Lavender Fields orders:</strong> Free delivery on orders of $250 or more in those areas; smaller orders by pickup or parcel.<br>
              <strong>Ordering both:</strong> purpl and Lavender Fields combine — free delivery once you hit 8 cases of purpl or $250 total, in one drop.<br>
              <strong>Payment:</strong> Net 30 from invoice date. Invoices from lavender@pbfwholesale.com.<br>
              <strong>Lead time:</strong> Please allow 7 business days.
            </div>
          </td></tr>
        </table>
        <p style="line-height:1.7;font-size:14px">I'm your direct contact for everything. Just reply to this email, call, or text. Whatever's easiest.</p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`, account.id)
    },
    'rejected': {
      subject: `Re: Your wholesale application — Pumpkin Blossom Farm`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>Thank you for your interest in carrying our products at <strong>${businessName}</strong>.</p>
        <p>After reviewing your application, we don't think it's the right fit at this time. We genuinely appreciate you reaching out and wish you all the best.</p>
        <p>Please don't hesitate to apply again in the future if circumstances change.</p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`)
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
                <td align="right" style="font-size:13px;color:#1a1a2e">${extra.paymentTerms||'Net 30'}</td>
              </tr>
            </table>
            ${extra.invoiceLink?`<div style="margin-top:16px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center"><a href="${extra.invoiceLink}" style="color:${accentColor};font-size:14px;font-weight:500">View Invoice →</a></div>`:''}
          </td></tr>
        </table>
        <p>Please reach out with any questions.</p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`)
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
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`)
    },
    'order-confirmation': {
      subject: `Order confirmed — ${businessNameRaw}`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>Your order for <strong>${businessName}</strong> has been confirmed and is being prepared.</p>
        ${extra.orderSummary||''}
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
          <tr><td style="background:#f0f7f1;border-left:3px solid #22c55e;padding:16px 20px;border-radius:0 6px 6px 0">
            <div style="font-size:14px;color:#1a4731">We'll be in touch shortly with delivery details. Your invoice will come from <strong>lavender@pbfwholesale.com</strong> upon delivery.</div>
          </td></tr>
        </table>
        <p>Questions? Just reply to this email.</p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`)
    },
    'invoice-reminder': {
      subject: `Friendly reminder — Invoice ${extra.invoiceNumber||''} due soon`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>Just a quick heads up, invoice <strong>${extra.invoiceNumber||''}</strong> for <strong>${businessName}</strong> is coming due.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
          <tr><td style="background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;padding:20px 24px">
            <table width="100%">
              <tr><td style="font-size:13px;color:#6b7280">Invoice</td><td align="right" style="font-weight:600">${extra.invoiceNumber||'—'}</td></tr>
              <tr><td style="font-size:13px;color:#6b7280;padding-top:8px">Amount</td><td align="right" style="font-weight:600;padding-top:8px">${extra.invoiceTotal||'—'}</td></tr>
            </table>
          </td></tr>
        </table>
        <p>If you've already sent payment, please disregard this note. Otherwise, please remit at your earliest convenience.</p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`)
    },
    'payment-overdue': {
      subject: `Past due — Invoice ${extra.invoiceNumber||''} for ${businessNameRaw}`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>We wanted to follow up on invoice <strong>${extra.invoiceNumber||''}</strong> for <strong>${businessName}</strong>, which is now past due.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
          <tr><td style="background:#fef2f2;border-left:3px solid #ef4444;padding:16px 20px;border-radius:0 6px 6px 0">
            <div style="font-size:13px;color:#991b1b;font-weight:500">PAST DUE</div>
            <div style="font-size:14px;color:#1a1a2e;margin-top:4px">Invoice ${extra.invoiceNumber||''} · ${extra.invoiceTotal||'—'}</div>
          </td></tr>
        </table>
        <p>If payment has already been sent, we apologize for the reminder. Otherwise, we'd appreciate payment as soon as possible.</p>
        <p>Please don't hesitate to reach out if you have any questions or need to discuss payment arrangements.</p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`)
    },
    'reorder-reminder': {
      subject: `Time to restock? — ${businessNameRaw}`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>It's been a while since your last order. Just checking in to see if <strong>${businessName}</strong> is ready to restock.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
          <tr><td align="center" style="padding:20px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb">
            <a href="${portalLink}" style="display:inline-block;background:${accentColor};color:#ffffff;padding:12px 28px;border-radius:6px;text-decoration:none;font-size:14px;font-weight:500">Place a Reorder →</a>
          </td></tr>
        </table>
        <p>If you need anything adjusted (quantities, delivery schedule, or product mix) just let us know.</p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`, account.id)
    },
    'delivery-followup': {
      subject: `How did your delivery go? — ${businessNameRaw}`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>We hope your recent delivery to <strong>${businessName}</strong> went smoothly. We wanted to check in and make sure everything arrived in great condition.</p>
        <p>A few quick questions:</p>
        <ul style="color:#374151;padding-left:20px">
          <li style="margin-bottom:6px">Did everything arrive as expected?</li>
          <li style="margin-bottom:6px">Is the product merchandised and ready to sell?</li>
          <li>Any feedback on the delivery process?</li>
        </ul>
        <p>Your feedback helps us serve you better. Just reply to this email with any thoughts.</p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`, account.id)
    },
    'new-product': {
      subject: `New from Pumpkin Blossom Farm — you'll want to see this`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>We're excited to share something new with <strong>${businessName}</strong>.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
          <tr><td style="background:#fdf9ff;border:1px solid #e9d5ff;border-radius:8px;padding:24px;text-align:center">
            <div style="font-size:20px;font-weight:600;color:#4B2082;margin-bottom:8px">🆕 New Product Launch</div>
            <div style="font-size:14px;color:#374151">Details coming soon. Stay tuned for pricing and availability.</div>
          </td></tr>
        </table>
        <p>Interested in adding this to your next order? Reply to this email or place an order through your portal:</p>
        <p style="text-align:center"><a href="${portalLink}" style="color:${accentColor};font-weight:500">Open Your Portal →</a></p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`, account.id)
    },
    'thank-you': {
      subject: `Thank you, ${businessNameRaw} — we appreciate your partnership`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>We just wanted to take a moment to say <strong>thank you</strong> for being a valued retail partner. Your support of <strong>${businessName}</strong> carrying our products means the world to our small farm.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:28px 0">
          <tr><td style="background:#f0f7f1;border-radius:8px;padding:20px 24px;text-align:center">
            <div style="font-size:15px;color:#166534;font-weight:500">🪻 Every can sold supports a family farm in Warner, NH</div>
          </td></tr>
        </table>
        <p>If there's ever anything we can do better, please don't hesitate to let us know.</p>
        <p>With gratitude,</p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`, account.id)
    },
    'custom': {
      subject: `A message from Pumpkin Blossom Farm`,
      from: 'lavender@pbfwholesale.com',
      body: buildEmailHTML(header, accentColor, `
        <p style="font-size:17px;font-weight:500;color:#1a1a2e;margin:0 0 20px">Hi ${contactName},</p>
        <p>[Your message here]</p>
        <p>Graham Biagiotti<br>
        Pumpkin Blossom Farm<br>
        <a href="tel:6037483038" style="color:${accentColor}">603-748-3038</a> · <a href="mailto:graham@pumpkinblossomfarm.com" style="color:${accentColor}">graham@pumpkinblossomfarm.com</a></p>`)
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
    {id:uid(),name:'Central Gym & Fitness',contact:'Rachel Kim',phone:'312-555-0140',email:'rachel@centralgym.com',type:'Gym',status:'active',skus:['classic','peach'],par:{classic:24,peach:12},territory:'Central',since:'2024-01-10',notes:[],lastOrder:today()},
    {id:uid(),name:'Sunrise Café',contact:'Marco Soto',phone:'773-555-0160',email:'marco@sunrisecafe.com',type:'Café',status:'paused',skus:['variety'],par:{variety:12},territory:'South',since:'2023-09-01',notes:[],lastOrder:'2024-11-15'},
  ];
  const prs = [
    {id:uid(),name:'Green Earth Market',contact:'Amy Chen',phone:'312-555-0200',email:'amy@greenearthmarket.com',type:'Grocery',status:'sampling',territory:'North',source:'Trade Show',notes:[],lastContacted:today(),nextAction:'Follow up on sample order',nextDate:today()},
    {id:uid(),name:'FitZone Studios',contact:'Jake Monroe',phone:'708-555-0210',email:'jake@fitzonefit.com',type:'Gym',status:'contacted',territory:'West',source:'Cold Call',notes:[],lastContacted:today(),nextAction:'Send product info packet',nextDate:today()},
  ];
  DB.set('ac', accs);
  DB.set('pr', prs);

  const costs = {cogs:{classic:2.10,blueberry:2.20,peach:2.15,variety:2.25},overhead_monthly:1200,target_margin:0.60};
  DB.setObj('costs', costs);
  const settings = {company:'purpl Beverages',currency:'USD',territory_labels:['North','South','Central','West'],payment_terms:30,seeded:true};
  DB.setObj('settings', settings);
}

// Returns true for satin Aromatherapy Scrunchie variants that are refillable
function _isRefillable(variantName) { return /satin/i.test(variantName || ''); }

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
// ── Global search (topbar) ─────────────────────────────────
function _gsNavigate(type, id) {
  const box = document.getElementById('global-search-results');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  const inp = document.getElementById('global-search');
  if (inp) inp.value = '';
  if      (type === 'ac')           { nav('accounts');      openAccount(id); }
  else if (type === 'pr')           { nav('prospects');     openProspect(id); }
  else if (type === 'dist')         { nav('distributors');  openDistributor(id); }
  else if (type === 'inv-retail')   { nav('invoices');      openInvModal(id); }
  else if (type === 'inv-lf')       { nav('invoices');      openLfInvoiceModal(id); }
  else if (type === 'inv-combined') { nav('invoices');      openCombinedInvoicePreview(id); }
  else if (type === 'inv-dist')     { nav('invoices');      editDistInvoice(id); }
}

function _globalSearchRun() {
  const inp = document.getElementById('global-search');
  const box = document.getElementById('global-search-results');
  if (!inp || !box) return;
  const q = inp.value.toLowerCase().trim();
  if (q.length < 2) { box.style.display = 'none'; box.innerHTML = ''; return; }

  const hits = [];
  DB.a('ac').forEach(a => {
    if ((a.name||'').toLowerCase().includes(q) || (a.email||'').toLowerCase().includes(q))
      hits.push({t:'ac', id:a.id, label:a.name||'—', sub:a.email||a.address||'Account', badge:'Account', cls:'purple'});
  });
  DB.a('pr').forEach(p2 => {
    if ((p2.name||'').toLowerCase().includes(q))
      hits.push({t:'pr', id:p2.id, label:p2.name||'—', sub:'Prospect · '+(p2.status||p2.stage||''), badge:'Prospect', cls:'blue'});
  });
  DB.a('dist_profiles').forEach(d => {
    if ((d.name||'').toLowerCase().includes(q))
      hits.push({t:'dist', id:d.id, label:d.name||'—', sub:'Distributor', badge:'Distributor', cls:'cyan'});
  });
  const invMatch = x => ((x.number||x.invoiceNumber||'') + ' ' + (x.accountName||x.distName||'')).toLowerCase().includes(q);
  DB.a('retail_invoices').forEach(x => { if (invMatch(x)) hits.push({t:'inv-retail', id:x.id, label:(x.number||x.invoiceNumber||'—')+' · '+(x.accountName||''), sub:fmtC(x.amount||x.total||0)+' · '+(x.status||'draft'), badge:'purpl inv', cls:'purple'}); });
  DB.a('lf_invoices').forEach(x => { if (invMatch(x)) hits.push({t:'inv-lf', id:x.id, label:(x.number||x.invoiceNumber||'—')+' · '+(x.accountName||''), sub:fmtC(x.total||0)+' · '+(x.status||'draft'), badge:'LF inv', cls:'green'}); });
  DB.a('combined_invoices').forEach(x => { if (invMatch(x)) hits.push({t:'inv-combined', id:x.id, label:(x.number||x.invoiceNumber||'—')+' · '+(x.accountName||''), sub:fmtC(x.grandTotal||0)+' · '+(x.status||'draft'), badge:'Combined', cls:'amber'}); });
  DB.a('dist_invoices').forEach(x => { if (invMatch(x)) hits.push({t:'inv-dist', id:x.id, label:(x.number||x.invoiceNumber||'—')+' · '+(x.distName||''), sub:fmtC(x.total||0)+' · '+(x.status||'draft'), badge:'Dist inv', cls:'gray'}); });

  const top = hits.slice(0, 8);
  box.innerHTML = top.length
    ? top.map(h => `<div class="gs-item" onclick="_gsNavigate('${h.t}','${h.id}')">
        <div style="min-width:0"><div class="gs-label">${escHtml(h.label)}</div><div class="gs-sub">${escHtml(h.sub)}</div></div>
        <span class="badge ${h.cls}" style="flex-shrink:0">${h.badge}</span>
      </div>`).join('')
    : '<div class="gs-empty">No matches</div>';
  box.style.display = '';
}

// ── Dashboard: quick actions + activity feed ───────────────
function renderDashQuickActions() {
  const el = document.getElementById('dash-quick-actions');
  if (!el) return;
  const todayStr = today();
  const od = x => { const due = x.dueDate || x.due || ''; return !['paid','draft','void'].includes(x.status) && due && due < todayStr; };
  const overdue = _allInvoices({excludeChildren: true}).filter(od).length;
  const drafts = _allInvoices({status: 'draft', excludeChildren: true}).length;
  const pendingOrders = (() => {
    const pending = DB.a('orders').filter(o => o.status === 'pending');
    const seen = new Set();
    let n = 0;
    for (const o of pending) {
      const key = o.combinedOrderGroupId || o.id;
      if (!seen.has(key)) { seen.add(key); n++; }
    }
    return n;
  })();
  const wix = DB.a('lf_wix_deductions').filter(d => !d.confirmed).length;
  const cards = [];
  if (overdue)       cards.push({n:overdue, label:'Overdue invoice'+(overdue>1?'s':''), cls:'qa-red', go:"nav('invoices')"});
  if (drafts)        cards.push({n:drafts, label:'Draft invoice'+(drafts>1?'s':'')+' to send', cls:'qa-amber', go:"nav('invoices')"});
  if (pendingOrders) cards.push({n:pendingOrders, label:'Order'+(pendingOrders>1?'s':'')+' to schedule', cls:'qa-blue', go:"nav('orders-delivery')"});
  if (wix)           cards.push({n:wix, label:'LF deduction'+(wix>1?'s':'')+' pending', cls:'qa-green', go:"nav('invoices')"});
  if (!cards.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'flex';
  el.innerHTML = cards.map(c => `<button class="qa-card ${c.cls}" onclick="${c.go}">
    <span class="qa-num">${c.n}</span><span class="qa-label">${c.label}</span><span class="qa-go">→</span>
  </button>`).join('');
}

function _timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : d + 'd ago';
}

function renderDashPayments() {
  const el = document.getElementById('dash-payments');
  if (!el) return;
  const paidKey = x => x.paidAt || x.paidDate || '';
  const pays = [];
  _allPurplInvoices().forEach(x => {
    if (x.status === 'paid' && !x.combinedInvoiceId && paidKey(x))
      pays.push({key:paidKey(x), num:x.number||x.invoiceNumber||'—', name:x.accountName||'', amt:parseFloat(x.amount||x.total||0), via:x.paidVia||'manual', open:`openInvModal('${x.id}')`});
  });
  DB.a('lf_invoices').forEach(x => {
    if (x.status === 'paid' && !x.combinedInvoiceId && paidKey(x))
      pays.push({key:paidKey(x), num:x.number||x.invoiceNumber||'—', name:x.accountName||'', amt:parseFloat(x.total||0), via:x.paidVia||'manual', open:`openLfInvoiceModal('${x.id}')`});
  });
  DB.a('combined_invoices').forEach(x => {
    if (x.status === 'paid' && paidKey(x))
      pays.push({key:paidKey(x), num:x.number||x.invoiceNumber||'—', name:x.accountName||'', amt:parseFloat(x.grandTotal||0), via:x.paidVia||'manual', open:`openCombinedInvoicePreview('${x.id}')`});
  });
  DB.a('dist_invoices').forEach(x => {
    if (x.status === 'paid' && paidKey(x))
      pays.push({key:paidKey(x), num:x.number||x.invoiceNumber||'—', name:x.distName||'', amt:parseFloat(x.total||0), via:x.paidVia||'manual', open:`editDistInvoice('${x.id}')`});
  });
  pays.sort((a,b) => b.key.localeCompare(a.key));
  const top = pays.slice(0, 6);
  if (!top.length) { el.innerHTML = '<div class="empty" style="padding:20px">No payments yet</div>'; return; }
  el.innerHTML = top.map(p2 => {
    const when = p2.key.length > 10 ? _timeAgo(p2.key) : fmtD(p2.key);
    const viaBadge = p2.via === 'stripe'
      ? '<span class="badge purple" style="font-size:10px">Stripe</span>'
      : '<span class="badge gray" style="font-size:10px">Manual</span>';
    return `<div class="act-row" style="cursor:pointer;align-items:center" onclick="${p2.open}">
      <span class="act-icon" style="color:#16a34a;font-weight:700">✓</span>
      <div class="act-body"><strong>${fmtC(p2.amt)}</strong> · ${escHtml(p2.name)} <span style="color:var(--muted);font-size:11.5px">${escHtml(p2.num)}</span></div>
      <span style="display:flex;align-items:center;gap:6px;flex-shrink:0">${viaBadge}<span class="act-time">${when}</span></span>
    </div>`;
  }).join('');
}

function renderDashActivity() {
  const el = document.getElementById('dash-activity');
  if (!el) return;
  const icons = {create:'✚', update:'✎', delete:'🗑', paid:'💵', paid_orphan:'⚠️', invite:'👤'};
  const verbs = {create:'created', update:'updated', delete:'deleted', paid:'received payment for', paid_orphan:'orphan payment for', invite:'invited'};
  const entries = DB.a('audit_log').slice()
    .sort((a,b) => (b.timestamp||'').localeCompare(a.timestamp||''))
    .slice(0, 10);
  if (!entries.length) { el.innerHTML = '<div class="empty" style="padding:20px">No activity yet</div>'; return; }
  el.innerHTML = entries.map(e => {
    const who  = (e.changedBy || e.changedByEmail || 'Someone').split(' ')[0];
    const what = (verbs[e.action] || e.action || '') + ' ' + String(e.entityType||'').replace(/_/g, ' ');
    return `<div class="act-row">
      <span class="act-icon">${icons[e.action]||'·'}</span>
      <div class="act-body"><strong>${escHtml(who)}</strong> ${escHtml(what)} <strong>${escHtml(e.entityName||'')}</strong></div>
      <span class="act-time">${_timeAgo(e.timestamp)}</span>
    </div>`;
  }).join('');
}

// ── Dark mode ──────────────────────────────────────────────
function _syncThemeLabel() {
  const lbl = document.getElementById('theme-toggle-label');
  if (lbl) lbl.textContent = document.body.classList.contains('dark') ? 'Light mode' : 'Dark mode';
}
function toggleTheme() {
  document.body.classList.toggle('dark');
  try { localStorage.setItem('purpl_theme', document.body.classList.contains('dark') ? 'dark' : 'light'); } catch (e) {}
  _syncThemeLabel();
}

// Switch the open account modal to the Emails tab (used by header quick action)
function _macGoToEmailsTab() {
  document.querySelector('#modal-account .tab[data-tab="emails"]')?.click();
}

function renderDash() {
  if (!DB._firestoreReady) return;
  renderDashQuickActions();
  renderDashPayments();
  renderDashActivity();
  const ac  = DB.a('ac').filter(x=>x.status==='active');
  const pendingAc = DB.a('ac').filter(x=>x.status==='pending').length;
  const pr  = DB.a('pr');
  const ord = DB.a('orders');
  const inv = DB.a('iv');

  const revenue30 = ord.filter(o=>daysAgo(o.created)<=30&&o.status!=='cancelled')
    .reduce((s,o)=>s+calcOrderValue(o), 0);
  const pipeline  = pr.filter(x=>!['won','lost'].includes(x.status)).length;
  const overdue   = ord.filter(o=>o.status==='pending'&&o.dueDate<today()).length;
  const lowStock  = SKUS.filter(s => _onHand(s.id, null) < 48).length;

  const allAc  = DB.a('ac');
  // Brand/fulfillment sub-counts use ACTIVE accounts (like the Active Accounts
  // KPI), so the breakdown reconciles with the headline instead of silently
  // including pending/inactive/paused accounts.
  const lfCount      = ac.filter(a=>!!a.isPbf).length;
  const purplOnly    = ac.filter(a=>!a.isPbf).length;
  const directCount  = ac.filter(a=>!a.fulfilledBy||a.fulfilledBy==='direct').length;
  const viaDistCount = ac.filter(a=>a.fulfilledBy&&a.fulfilledBy!=='direct').length;

  // ── Combined 6-card KPI row ──────────────────────────────
  loadScratchpad();
  // Brand counts filter to active accounts so they line up with the main
  // "Active Accounts" KPI — pulling from allAc included churned accounts.
  const purplAcCount = ac.filter(a => !a.isPbf).length;
  const lfAcCount    = ac.filter(a => !!a.isPbf).length;
  const allPurplInv = _allPurplInvoices();
  const purplOutstanding = allPurplInv.filter(x => !['paid','draft','void'].includes(x.status)).reduce((s,x) => s + parseFloat(x.total||x.amount||0), 0);
  const lfOutstanding    = DB.a('lf_invoices').filter(i => !['paid','draft','void'].includes(i.status)).reduce((s,i) => s + (i.total||0), 0);
  const combinedOutstanding  = purplOutstanding + lfOutstanding;
  const purplOverdueCount    = allPurplInv.filter(x => !['paid','draft','void'].includes(x.status) && (x.dueDate||x.due) && (x.dueDate||x.due) < today()).length;
  const lfOverdueCount       = DB.a('lf_invoices').filter(i => !['paid','draft','void'].includes(i.status) && (i.dueDate||i.due) && (i.dueDate||i.due) < today()).length;
  const combinedOverdueCount = purplOverdueCount + lfOverdueCount;
  const pendingWixCount      = DB.a('lf_wix_deductions').filter(d => !d.confirmed).length;
  if (qs('#dash-kpi-total-ac'))             qs('#dash-kpi-total-ac').innerHTML             = kpiHtml('Active Accounts', ac.length, 'purple') + (pendingAc>0?`<div style="font-size:11px;color:#1e40af;margin-top:4px;text-align:center">+${pendingAc} pending</div>`:'');
  if (qs('#dash-kpi-purpl-ac'))             qs('#dash-kpi-purpl-ac').innerHTML             = kpiHtml('💜 purpl', purplAcCount, 'purple');
  if (qs('#dash-kpi-lf-ac'))                qs('#dash-kpi-lf-ac').innerHTML                = kpiHtml('🪻 LF', lfAcCount, 'green');
  if (qs('#dash-kpi-combined-outstanding')) qs('#dash-kpi-combined-outstanding').innerHTML = kpiHtml('Outstanding', fmtC(combinedOutstanding), combinedOutstanding > 0 ? 'amber' : 'gray');
  if (qs('#dash-kpi-combined-overdue'))     qs('#dash-kpi-combined-overdue').innerHTML     = kpiHtml('Overdue', combinedOverdueCount, combinedOverdueCount > 0 ? 'red' : 'gray');
  if (qs('#dash-kpi-wix'))                  qs('#dash-kpi-wix').innerHTML                  = kpiHtml('LF Deductions', pendingWixCount, pendingWixCount > 0 ? 'amber' : 'gray');

  // Low inventory KPI
  const totalCans = SKUS.reduce((sum, sk) => sum + _onHand(sk.id, null), 0);
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
  if (qs('#dash-kpi-pr-lf'))    qs('#dash-kpi-pr-lf').innerHTML    = kpiHtml('🪻 LF Prospects', prLfCount, 'green');
  if (qs('#dash-kpi-pr-due'))   qs('#dash-kpi-pr-due').innerHTML   = kpiHtml('Follow-up Due', prDueCount, prDueCount > 0 ? 'red' : 'gray');

  qs('#dash-kpi-revenue').innerHTML  = kpiHtml('Revenue (30d)',   fmtC(revenue30), 'green');
  qs('#dash-kpi-accounts').innerHTML = kpiHtml('Active Accounts', ac.length,       'purple') +
    `<div style="margin-top:8px;padding:0 4px;display:flex;flex-direction:column;gap:4px">
      ${pendingAc>0?`<div class="dash-brand-stat" onclick="dashFilterStatus('pending')" title="View pending accounts (no order yet)" style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px;color:#1e40af;background:#dbeafe;border-radius:6px;padding:3px 8px">
        <span>⏳</span><span><strong>${pendingAc}</strong> pending (no order yet)</span>
      </div>`:''}
      <div class="dash-brand-stat" onclick="dashFilterBrand('lf')" title="View Lavender Fields + purpl accounts" style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px;color:#166534;background:#dcfce7;border-radius:6px;padding:3px 8px">
        <span>🪻</span><span><strong>${lfCount}</strong> carry both purpl + Lavender Fields</span>
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

  // Check for new wholesale applications (async, non-blocking)
  firebase.firestore().collection('portal_inquiries')
    .where('status', '==', 'new').get()
    .then(snap => _updateApplicationsBadge(snap.size))
    .catch(() => {});

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

// ── Dashboard notes scratchpad (sectioned, Firestore) ─────
const _NOTE_DEFAULTS = [
  { id: 'general',       name: 'General',            content: '' },
  { id: 'follow-ups',    name: 'Follow-Up Reminders', content: '' },
  { id: 'sales-ideas',   name: 'Sales Ideas',         content: '' },
  { id: 'production',    name: 'Production Notes',    content: '' },
];
let _noteDebounceTimer = null;
let _noteActiveSectionId = 'general';

function loadScratchpad() {
  // Migrate old localStorage content into General on first load
  const settings = DB.obj('settings', {});
  let sections = settings.noteSections;

  if (!sections || !sections.length) {
    const legacy = localStorage.getItem('pbf_dash_notes') || '';
    sections = _NOTE_DEFAULTS.map(s => ({ ...s }));
    if (legacy) sections[0].content = legacy;
    DB.setObj('settings', { ...settings, noteSections: sections });
  }

  // Ensure active section still exists
  if (!sections.find(s => s.id === _noteActiveSectionId)) {
    _noteActiveSectionId = sections[0]?.id || 'general';
  }

  _renderNoteSidebar(sections);
  _renderNoteContent(sections);
}

function _renderNoteSidebar(sections) {
  const el = qs('#dash-notes-sidebar');
  if (!el) return;
  const canDelete = sections.length > 1;
  const items = sections.map(s => {
    const isActive = s.id === _noteActiveSectionId;
    const bg    = isActive ? 'var(--primary,#2D1B4E)' : 'transparent';
    const color = isActive ? '#fff' : 'inherit';
    const delColor = isActive ? 'rgba(255,255,255,0.55)' : 'var(--muted)';
    const delBtn = canDelete
      ? `<span onclick="event.stopPropagation();deleteNoteSection('${s.id}')"
               title="Delete section"
               style="margin-left:auto;padding-left:6px;cursor:pointer;color:${delColor};font-size:14px;line-height:1;flex-shrink:0">×</span>`
      : '';
    return `<div onclick="selectNoteSection('${s.id}')"
                 ondblclick="renameNoteSection('${s.id}')"
                 title="Double-click to rename"
                 style="display:flex;align-items:center;padding:7px 8px;font-size:12px;cursor:pointer;
                        border-bottom:1px solid var(--border);user-select:none;
                        background:${bg};color:${color}">
               <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${escHtml(s.name)}</span>
               ${delBtn}
             </div>`;
  }).join('');

  el.innerHTML = items + `
    <div style="padding:7px 10px;margin-top:auto">
      <button class="btn xs" style="width:100%;font-size:11px" onclick="addNoteSection()">+ Add Section</button>
    </div>`;
}

function _renderNoteContent(sections) {
  const el = qs('#dash-notes-content');
  if (!el) return;
  const sec = sections.find(s => s.id === _noteActiveSectionId) || sections[0];
  if (sec) el.value = sec.content || '';
}

function selectNoteSection(id) {
  // Flush any pending save for current section first
  clearTimeout(_noteDebounceTimer);
  _flushNoteSave();

  _noteActiveSectionId = id;
  const sections = DB.obj('settings', {}).noteSections || _NOTE_DEFAULTS.map(s => ({ ...s }));
  _renderNoteSidebar(sections);
  _renderNoteContent(sections);
}

function debounceNoteSectionSave() {
  clearTimeout(_noteDebounceTimer);
  _noteDebounceTimer = setTimeout(_flushNoteSave, 800);
}

function _flushNoteSave() {
  const el = qs('#dash-notes-content');
  if (!el) return;
  const settings = DB.obj('settings', {});
  const sections = (settings.noteSections || _NOTE_DEFAULTS.map(s => ({ ...s }))).map(s =>
    s.id === _noteActiveSectionId ? { ...s, content: el.value } : s
  );
  DB.setObj('settings', { ...settings, noteSections: sections });
  const savedEl = qs('#dash-notes-saved');
  if (savedEl) { savedEl.style.opacity = '1'; setTimeout(() => { savedEl.style.opacity = '0'; }, 1200); }
}

function addNoteSection() {
  const name = prompt('Section name:');
  if (!name || !name.trim()) return;
  const settings = DB.obj('settings', {});
  const sections = settings.noteSections || _NOTE_DEFAULTS.map(s => ({ ...s }));
  const newSec = { id: uid(), name: name.trim(), content: '' };
  const updated = [...sections, newSec];
  DB.setObj('settings', { ...settings, noteSections: updated });
  _noteActiveSectionId = newSec.id;
  _renderNoteSidebar(updated);
  _renderNoteContent(updated);
}

function renameNoteSection(id) {
  const settings = DB.obj('settings', {});
  const sections = settings.noteSections || _NOTE_DEFAULTS.map(s => ({ ...s }));
  const sec = sections.find(s => s.id === id);
  if (!sec) return;
  const newName = prompt('Rename section:', sec.name);
  if (!newName || !newName.trim() || newName.trim() === sec.name) return;
  const updated = sections.map(s => s.id === id ? { ...s, name: newName.trim() } : s);
  DB.setObj('settings', { ...settings, noteSections: updated });
  _renderNoteSidebar(updated);
}

function deleteNoteSection(id) {
  const settings = DB.obj('settings', {});
  const sections = settings.noteSections || _NOTE_DEFAULTS.map(s => ({ ...s }));
  if (sections.length <= 1) { toast('Cannot delete the last section'); return; }
  if (!confirm('Delete this section and its content?')) return;
  const updated = sections.filter(s => s.id !== id);
  if (_noteActiveSectionId === id) _noteActiveSectionId = updated[0].id;
  DB.setObj('settings', { ...settings, noteSections: updated });
  _renderNoteSidebar(updated);
  _renderNoteContent(updated);
}

// Keep old name callable (renderDash calls loadScratchpad)
// debounceSaveScratchpad kept as alias for any stale references
function debounceSaveScratchpad() { debounceNoteSectionSave(); }

function addQuickNote() {
  if (!DB._firestoreReady) return;
  const inp = qs('#qn-input');
  const text = (inp?.value||'').trim();
  if (!text) return;
  const note = { id: uid(), text, author: _currentUserName(), ts: Date.now() };
  DB.push('quick_notes', note);
  inp.value = '';
  renderQuickNotes();
}

function deleteQuickNote(id) {
  if (!DB._firestoreReady) return;
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
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function kpiHtml(label, val, color) {
  return `<div class="kpi ${color}"><div class="num">${val}</div><div class="label">${label}</div></div>`;
}

function dashFilterBrand(val) {
  _acBrandFilter = val;
  nav('accounts');
  renderAccounts();
}

function dashFilterStatus(val) {
  nav('accounts');
  const el = qs('#ac-status-filter');
  if (el) el.value = val;
  renderAccounts();
}

function dashFilterFulfill(val) {
  nav('accounts');
  const el = qs('#ac-fulfill-filter');
  if (el) {
    // 'dist' means show all distributor-linked; pick first distributor or leave as ''
    if (val === 'dist') {
      el.value = '__any_dist__'; // "Via distributor (any)" — renderAccounts adds this option
    } else {
      el.value = val;
    }
    renderAccounts();
  }
}

// Price an order. Items qty is in CASES.
// Account pricing takes priority. Fallback: COGS × markup from target_margin × cans per case.
function calcOrderValue(o) {
  const ac2 = DB.a('ac').find(a=>a.id===o.accountId);
  return (o.items||[]).reduce((s,i) => s + _calcPricePerCase(ac2) * i.qty, 0);
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
    const whOh = _onHand(s.id, 'warehouse');
    const fmOh = _onHand(s.id, 'farm');
    if (whOh < 48) items.push({icon:'📦', name:`${s.label} — Low (Warehouse)`, reason:`${whOh} cans in warehouse`, action:`nav('inventory')`, borderColor:'#d97706'});
    if (fmOh < 48) items.push({icon:'📦', name:`${s.label} — Low (Farm)`, reason:`${fmOh} cans at farm`, action:`nav('inventory')`, borderColor:'#d97706'});
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
  DB.a('dist_invoices').filter(i=>!['paid','draft','void'].includes(i.status)&&i.dueDate&&i.dueDate<todayStr).forEach(i=>{
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

  // Sample follow-ups — due within 7 days or overdue
  const _smpSources = [
    ...DB.a('pr').filter(p=>!['won','lost'].includes(p.status)),
    ...DB.a('ac').filter(a=>a.status==='active'),
  ];
  const _7daysOut = new Date(); _7daysOut.setDate(_7daysOut.getDate()+7);
  const _7dStr = _7daysOut.toISOString().slice(0,10);
  _smpSources.forEach(r=>{
    (r.samples||[]).forEach(s=>{
      if (s.followUpDone || !s.followUpDate) return;
      if (s.followUpDate > _7dStr) return; // not due within 7 days
      const isPr = !!DB.a('pr').find(x=>x.id===r.id);
      const overdue = s.followUpDate < todayStr;
      items.push({
        icon:'🧪',
        name: r.name,
        reason: overdue
          ? `Sample follow-up overdue (due ${fmtD(s.followUpDate)})`
          : `Sample follow-up due ${fmtD(s.followUpDate)}`,
        action: isPr ? `openProspect('${r.id}')` : `openAccount('${r.id}')`,
        borderColor: overdue ? '#dc2626' : '#d97706',
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
    if ((a.status||'active') !== 'active') return; // only active accounts nag, matching Needs-Attention
    if (a.nextFollowUp && a.nextFollowUp <= in14) {
      const daysUntil = Math.ceil((new Date(a.nextFollowUp+'T12:00:00')-Date.now())/864e5);
      items.push({type:'account', name:a.name, date:a.nextFollowUp, action:'Follow up', id:a.id, daysUntil});
      return;
    }
    if (!a.notes?.length) return;
    // MED-8: scan ALL notes for the soonest pending follow-up — reading only
    // the last appended note dropped earlier pending follow-ups whenever a
    // later note without a nextDate was added.
    let ln = null;
    for (const n of a.notes) {
      if (n?.nextDate && n.nextDate <= in14 && (!ln || n.nextDate < ln.nextDate)) ln = n;
    }
    if (ln) {
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
  if (!DB._firestoreReady) return;
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

  // Invoices without a sent notification. Skip: drafts (nothing to send yet),
  // paid/void (moot), anything already status sent/sentAt (markInvoiceSent
  // logs no cadence), and combined children (the SEND logs the parent id, so
  // children were flagged forever after every combined send).
  DB.a('ac').forEach(a=>{
    const sentIds = new Set((a.cadence||[]).filter(c=>c.stage==='invoice_sent').map(c=>c.invoiceId));
    const needsFlag = inv => !sentIds.has(inv.id) && !inv.combinedInvoiceId &&
      !['draft','paid','void','sent'].includes(inv.status || 'draft') && !inv.sentAt;
    _allPurplInvoices().filter(x=>x.accountId===a.id&&needsFlag(x)).forEach(inv=>{
      flags.push({id:a.id, name:a.name, reason:`Invoice ${inv.number} not sent to retailer`, invoiceId:inv.id});
    });
    DB.a('lf_invoices').filter(x=>x.accountId===a.id&&needsFlag(x)).forEach(inv=>{
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
  if (!DB._firestoreReady) return;
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
  const terms     = _payTerms();

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
      const _invStatusBadge = inv => {
        const isDraft = inv.status === 'draft';
        const isVoid  = inv.status === 'void';
        const isPaid  = inv.status === 'paid';
        const od      = !isDraft && !isVoid && !isPaid && _isOverdue(inv);
        const cls     = isPaid ? 'green' : isDraft ? 'gray' : isVoid ? 'red' : od ? 'red' : 'blue';
        const label   = isPaid ? 'Paid' : isDraft ? 'Draft' : isVoid ? 'Void' : od ? 'Overdue' : 'Sent';
        return `<span class="badge ${cls}">${label}</span>`;
      };
      const rInvs = DB.a('retail_invoices').filter(x => !x.combinedInvoiceId).sort((a,b)=>b.date>a.date?1:-1);
      const lInvs = DB.a('lf_invoices').filter(x => !x.combinedInvoiceId).sort((a,b)=>(b.issued||b.date||'')>(a.issued||a.date||'')?1:-1);
      const cInvs = DB.a('combined_invoices').sort((a,b)=>(b.date||'')>(a.date||'')?1:-1);
      if (!rInvs.length && !lInvs.length && !cInvs.length) return '';

      const purplRows = rInvs.map(inv=>{
        const acName = DB.a('ac').find(a=>a.id===inv.accountId)?.name || '—';
        return `<tr>
          <td><span class="badge purple" style="font-size:10px;margin-right:4px">purpl</span> ${escHtml(inv.invoiceNumber||inv.number||'—')}</td>
          <td>${escHtml(acName)}</td>
          <td>${fmtD(inv.dueDate||inv.due)}</td>
          <td>${fmtC(inv.total||inv.amount||0)}</td>
          <td>${_invStatusBadge(inv)}</td>
          <td style="white-space:nowrap">
            <button class="btn xs" onclick="generateInvoicePrint('${inv.id}')">🖨️</button>
            ${inv.status!=='paid'?`<button class="btn xs green" onclick="markRetailInvPaid('${inv.id}')">✓ Paid</button>`:''}
          </td>
        </tr>`;
      }).join('');

      const lfRows = lInvs.map(inv=>{
        const acName = DB.a('ac').find(a=>a.id===inv.accountId)?.name || '—';
        return `<tr>
          <td><span class="badge" style="font-size:10px;margin-right:4px;background:#dcfce7;color:#166534">LF</span> ${escHtml(inv.number||inv.invoiceNumber||'—')}</td>
          <td>${escHtml(acName)}</td>
          <td>${fmtD(inv.due)}</td>
          <td>${fmtC(inv.total||0)}</td>
          <td>${_invStatusBadge(inv)}</td>
          <td style="white-space:nowrap">
            <button class="btn xs" onclick="generateLfInvoicePrint('${inv.id}')">🖨️</button>
            <button class="btn xs" onclick="openLfInvoiceModal('${inv.id}')">Edit</button>
          </td>
        </tr>`;
      }).join('');

      const combRows = cInvs.map(ci=>{
        return `<tr>
          <td><span class="badge amber" style="font-size:10px;margin-right:4px">Combined</span> ${escHtml(ci.number||ci.invoiceNumber||'—')}</td>
          <td>${escHtml(ci.accountName||'—')}</td>
          <td>${fmtD(ci.dueDate||ci.due)}</td>
          <td>${fmtC(ci.grandTotal||0)}</td>
          <td>${_invStatusBadge(ci)}</td>
          <td style="white-space:nowrap">
            <button class="btn xs" onclick="openCombinedInvoicePreview('${ci.id}')">Preview</button>
          </td>
        </tr>`;
      }).join('');

      return `<div style="margin-top:16px">
        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Recent Invoices</div>
        <div class="tbl-wrap">
          <table>
            <thead><tr><th>Invoice</th><th>Account</th><th>Due</th><th>Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>${purplRows}${lfRows}${combRows}</tbody>
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

  // Check both retail_invoices and legacy iv for purpl invoices.
  // Combined CHILDREN are excluded — reminding from a child quotes the
  // customer half of what they owe; the combined parent is the real bill.
  _allPurplInvoices().forEach(inv => {
    if (inv.combinedInvoiceId) return;
    if (['paid','draft','void'].includes(inv.status) || !(inv.dueDate||inv.due) || !inv.accountId) return;
    if (inv.reminderSentAt) return;
    const days = daysAgo(inv.dueDate||inv.due);
    if (days < -7) return;
    const ac = DB.a('ac').find(x => x.id === inv.accountId);
    if (!ac || !ac.email) return;
    const coll = DB.a('retail_invoices').find(x => x.id === inv.id) ? 'retail_invoices' : 'iv';
    queue.push({ inv, ac, collection: coll, isOverdue: days > 0, amount: inv.total||inv.amount });
  });

  DB.a('lf_invoices').forEach(inv => {
    if (inv.combinedInvoiceId) return;
    // due||dueDate: portal-confirmed LF invoices store dueDate only — they
    // never surfaced in this card at all.
    if (['paid','draft','void'].includes(inv.status) || !(inv.due||inv.dueDate) || !inv.accountId) return;
    if (inv.reminderSentAt) return;
    const days = daysAgo(inv.due||inv.dueDate);
    if (days < -7) return;
    const ac = DB.a('ac').find(x => x.id === inv.accountId);
    if (!ac || !ac.email) return;
    queue.push({ inv, ac, collection: 'lf_invoices', isOverdue: days > 0, amount: inv.total });
  });

  // Combined PARENTS — the real bill for a dual-brand order. Children are
  // excluded above, so without this an overdue combined invoice got no
  // automated reminder at all. sendInvoiceReminder already supports the
  // combined_invoices collection.
  DB.a('combined_invoices').forEach(inv => {
    if (['paid','draft','void'].includes(inv.status) || !(inv.dueDate||inv.due) || !inv.accountId) return;
    if (inv.reminderSentAt) return;
    const days = daysAgo(inv.dueDate||inv.due);
    if (days < -7) return;
    const ac = DB.a('ac').find(x => x.id === inv.accountId);
    if (!ac || !ac.email) return;
    queue.push({ inv, ac, collection: 'combined_invoices', isOverdue: days > 0, amount: inv.grandTotal });
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
            <div class="attn-reason">${isOverdue ? 'Overdue' : 'Due in 7 days'} · ${fmtC(amount || 0)} · Due ${fmtD(inv.dueDate || inv.due)}</div>
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

  const type = collection === 'lf_invoices' ? 'lf' : collection === 'combined_invoices' ? 'combined' : 'retail';
  const payLink = await _getStripePayLink(inv, type);
  const sendInv = payLink ? { ...inv, _payLink: payLink } : inv;

  const _dueStr = inv.dueDate || inv.due || '';
  const isOverdue = !!_dueStr && daysAgo(_dueStr) > 0;
  const subject = isOverdue
    ? `Payment reminder — ${inv.number || ''} (${ac.name})`
    : `Invoice due soon — ${inv.number || ''} (${ac.name})`;
  const html = buildInvoiceReminderHTML(sendInv, collection, isOverdue);

  _sendWithCadence({
    to: ac.email, subject, html, accountId: ac.id,
    stage: 'invoice_reminder',
    extra: { invoiceId: invId, invoiceRef: inv.number || '' },
  }).then(result => {
    if (result) {
      DB.update(collection, invId, x => ({ ...x, reminderSentAt: new Date().toISOString() }));
      const row = document.getElementById('dir-' + invId);
      if (row) row.remove();
      const list = document.getElementById('dash-inv-reminders-list');
      if (list && !list.children.length) {
        document.getElementById('dash-invoice-reminders').style.display = 'none';
      }
    }
  });
}

function buildInvoiceReminderHTML(inv, collection, isOverdue) {
  const ac = DB.a('ac').find(x => x.id === inv.accountId) || {};
  const amount = collection === 'lf_invoices' ? (inv.total || 0) : (parseFloat(inv.grandTotal != null ? inv.grandTotal : (inv.amount != null ? inv.amount : inv.total)) || 0); // combined parents carry grandTotal only — omitting it emailed "Amount Due $0.00"
  const invSettings = DB.obj('invoice_settings') || {};
  const _remDue = inv.dueDate || inv.due;
  const dueLabel = _remDue ? new Date(_remDue+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}) : 'Net 30';
  const isLf = collection === 'lf_invoices';
  const accentColor = isLf ? '#4a7c59' : '#6B4F9A';
  const accentLight = isLf ? '#dcfce7' : '#ede4f5';
  const headerGrad = isLf
    ? 'background:linear-gradient(135deg,#3d6b4d 0%,#5a8c69 100%)'
    : 'background:#6B4F9A;background:linear-gradient(135deg,#6B4F9A 0%,#9B73C4 100%)';
  const contacts = ac.contacts || [];
  const primary = contacts.find(c => c.isPrimary) || contacts[0] || {};
  const contactName = primary.name || ac.contact || 'there';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">
  <tr><td style="${headerGrad};padding:32px 40px">
    <table width="100%"><tr>
      <td>
        <table cellpadding="0" cellspacing="0"><tr>
          <td valign="middle" style="padding-right:16px"><span style="font-family:Georgia,'Times New Roman',serif;font-size:30px;font-weight:700;color:#ffffff;letter-spacing:1px">purpl</span></td>
          <td valign="middle" style="padding:0 16px"><div style="width:1px;height:44px;background:rgba(255,255,255,0.5)"></div></td>
          <td valign="middle"><span style="font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#ffffff;white-space:nowrap">Lavender Fields</span></td>
        </tr></table>
        <div style="font-size:10px;color:rgba(255,255,255,0.9);letter-spacing:0.15em;text-transform:uppercase;margin-top:10px">Pumpkin Blossom Farm · Wholesale</div>
      </td>
      <td align="right"><div style="color:#fff;font-size:22px;font-weight:700">${isOverdue ? 'Payment Overdue' : 'Invoice Due Soon'}</div></td>
    </tr></table>
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
      <div style="font-size:12px;color:#6b7280;margin-top:4px">Invoice ${escHtml(inv.number||'')} · Due ${dueLabel}</div>
    </div>
    ${inv._payLink ? `<div style="margin:20px 0;text-align:center"><a href="${escHtml(inv._payLink)}" style="display:inline-block;background:${accentColor};color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-size:15px;font-weight:500">Pay Now →</a></div>` : ''}
    <p style="font-size:14px;color:#374151;margin:16px 0 0">Questions? Reply to this email or call 603-748-3038.</p>
    <p style="font-size:14px;color:#374151;margin:8px 0 0">Thank you,<br><strong>Graham Biagiotti</strong><br>Pumpkin Blossom Farm</p>
  </td></tr>
  <tr><td style="background:#f9fafb;padding:16px 40px;text-align:center;font-size:11px;color:#6b7280;border-top:1px solid #e5e7eb">
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

// ── Searchable account selects (invoice modals) ───────────
// Keeps the native <select> (so all existing .value reads/writes work)
// and pairs it with a "<selectId>-search" text input that filters options.

function _populateAccountSelect(selectId, accounts, selectedId, placeholder) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel._accounts = accounts.map(a => ({ id: a.id, name: a.name || '' }));
  sel._placeholder = placeholder || '— Select Account —';
  const search = document.getElementById(selectId + '-search');
  if (search) search.value = '';
  _renderAccountSelectOptions(sel, '');
  if (selectedId) sel.value = selectedId;
}

function _renderAccountSelectOptions(sel, q) {
  const ql = (q || '').trim().toLowerCase();
  const list = (sel._accounts || []).filter(a => !ql || a.name.toLowerCase().includes(ql));
  const prev = sel.value;
  sel.innerHTML = `<option value="">${escHtml(sel._placeholder || '— Select Account —')}</option>` +
    list.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
  if (prev && list.some(a => a.id === prev)) sel.value = prev;
  return list;
}

function filterAccountSelect(selectId, q) {
  const sel = document.getElementById(selectId);
  if (!sel || !sel._accounts) return;
  // Just filter the dropdown options as you type. Do NOT auto-pick a match —
  // that fired a selection on every keystroke before you could choose. You
  // open the dropdown and select when ready.
  _renderAccountSelectOptions(sel, q);
}

// purpl invoice SKUs
const IV_SKUS = [
  {id:'classic',   name:'Classic 12-pack'},
  {id:'blueberry', name:'Blueberry 12-pack'},
  {id:'peach',     name:'Peach 12-pack'},
  {id:'variety',   name:'Variety 12-pack'},
];

// openAddInv kept as entry-point alias (called from portal approval flows etc.)
function openAddInv(accountId=null, priceType='direct', cases=null, notesText='') {
  openInvModal(null, accountId, priceType, notesText);
}

function openInvModal(id, prefillAccountId=null, prefillTier='direct', prefillNotes='') {
  const isNew = !id;
  const inv   = id ? findInvoice(id) : null;

  qs('#iv-modal-title').textContent = isNew ? 'New purpl Invoice' : 'Edit purpl Invoice';

  if (isNew) {
    if (qs('#iv-number')) qs('#iv-number').value = peekNextInvoiceNumber();
    if (qs('#iv-date'))   qs('#iv-date').value   = today();
    const settingsTerms = DB.obj('invoice_settings',{}).terms || _payTerms();
    const defaultTermsKey = Object.entries(_TERMS_DAYS).find(([,d]) => d === settingsTerms)?.[0] || 'net30';
    if (qs('#iv-terms')) { qs('#iv-terms').value = defaultTermsKey; }
    if (qs('#iv-terms-custom-row')) qs('#iv-terms-custom-row').style.display = 'none';
    if (qs('#iv-terms-custom')) qs('#iv-terms-custom').value = '';
    const dueStr = new Date(Date.now() + settingsTerms * 864e5).toISOString().slice(0,10);
    if (qs('#iv-due'))    qs('#iv-due').value    = dueStr;
    if (qs('#iv-status')) qs('#iv-status').value = 'draft';
    if (qs('#iv-notes'))  qs('#iv-notes').value  = prefillNotes || '';
    if (qs('#iv-delivery-method'))qs('#iv-delivery-method').value = 'deliver';
    if (qs('#iv-delivery-date')) qs('#iv-delivery-date').value = '';
    if (qs('#iv-tracking'))      qs('#iv-tracking').value      = '';
    if (qs('#iv-ship-status'))   qs('#iv-ship-status').style.display = 'none';
    if (qs('#iv-delete-btn')) qs('#iv-delete-btn').style.display = 'none';
  } else if (inv) {
    if (qs('#iv-number')) qs('#iv-number').value = inv.number||'';
    if (qs('#iv-date'))   qs('#iv-date').value   = inv.date||today();
    if (qs('#iv-due'))    qs('#iv-due').value    = inv.dueDate||inv.due||'';
    if (qs('#iv-status')) qs('#iv-status').value = inv.status||'draft';
    if (qs('#iv-notes'))  qs('#iv-notes').value  = inv.notes||'';
    if (qs('#iv-delivery-method'))qs('#iv-delivery-method').value = inv.deliveryMethod||'deliver';
    if (qs('#iv-fulfillment'))   qs('#iv-fulfillment').value   = inv.fulfillmentSource||'warehouse';
    if (qs('#iv-delivery-date')) qs('#iv-delivery-date').value = inv.deliveryDate||'';
    if (qs('#iv-tracking'))      qs('#iv-tracking').value      = inv.trackingNumber||'';
    ivDeliveryMethodChange();
    const savedTerms = inv.paymentTerms || 'net30';
    if (qs('#iv-terms')) qs('#iv-terms').value = savedTerms;
    if (qs('#iv-terms-custom-row')) qs('#iv-terms-custom-row').style.display = savedTerms === 'custom' ? '' : 'none';
    if (qs('#iv-terms-custom')) qs('#iv-terms-custom').value = inv.paymentTermsCustom || '';
    if (qs('#iv-delete-btn')) {
      qs('#iv-delete-btn').style.display = '';
      qs('#iv-delete-btn').onclick = () => deleteInvRecord(id);
    }
  }

  // Account selector (searchable)
  const accounts = DB.a('ac').filter(a => a.status !== 'inactive').sort((a,b) => (a.name||'') < (b.name||'') ? -1 : 1);
  _populateAccountSelect('iv-account', accounts, inv?.accountId || prefillAccountId || '');

  // Pricing tier
  const tierSel = qs('#iv-tier');
  if (tierSel) tierSel.value = inv?.priceType || prefillTier || 'direct';

  // Line items
  _ivRenderLineRows(inv?.lineItems || []);

  qs('#iv-save-btn').onclick = _once(() => saveInv(id, isNew));

  const ivPdfBtn = qs('#iv-pdf-btn');
  if (ivPdfBtn) {
    ivPdfBtn.style.display = isNew ? 'none' : '';
    ivPdfBtn.onclick = () => generateInvoicePrint(id);
  }

  const ivSendBtn = qs('#iv-send-btn');
  if (ivSendBtn) {
    ivSendBtn.style.display = '';
    const _ivIsShip = () => qs('#iv-delivery-method')?.value === 'ship';
    const _ivIsWh = () => qs('#iv-fulfillment')?.value === 'warehouse';
    const _updateIvBtnText = () => {
      ivSendBtn.textContent = _ivIsShip() ? 'Save & Push to ShipStation' : 'Save & Send';
    };
    _updateIvBtnText();
    const dmEl = qs('#iv-delivery-method');
    if (dmEl) dmEl.onchange = _updateIvBtnText;
    const ffEl = qs('#iv-fulfillment');
    if (ffEl) ffEl.onchange = _updateIvBtnText;
    ivSendBtn.onclick = async () => {
      if (ivSendBtn.disabled) return;
      ivSendBtn.disabled = true; ivSendBtn.textContent = 'Saving…';
      try {
        // Persist first — works for brand-new invoices too (one-step send)
        const rec = await _saveInvCore(id, isNew);
        if (!rec) { ivSendBtn.disabled = false; ivSendBtn.textContent = _ivIsShip() ? 'Save & Push to ShipStation' : 'Save & Send'; return; }
        if (rec.deliveryMethod === 'ship' && !rec.shipStationOrderId) {
          await pushInvoiceToShipStation(rec.id, 'retail_invoices');
        }
        const ac = DB.a('ac').find(x => x.id === rec.accountId) || {};
        if (!ac.email) {
          toast('Saved — but no email address on file for this account');
          closeModal('modal-add-inv');
          if (currentPage === 'invoices') renderInvoicesPage();
          renderInvoiceStatus();
          return;
        }
        ivSendBtn.textContent = 'Generating link…';
        const payLink = rec.status === 'paid' ? null : await _getStripePayLink(rec, 'retail');
        const sendInv = payLink ? { ...rec, _payLink: payLink } : rec;
        const html    = buildPurplInvoiceEmailHTML(sendInv);
        const subject = `Invoice ${rec.number||''} from Pumpkin Blossom Farm — ${ac.name||rec.accountName||''}`;
        ivSendBtn.textContent = 'Sending…';
        const result = await callSendEmail(ac.email, 'lavender@pbfwholesale.com', subject, html);
        // Sending flips Draft → Sent (and deducts inventory once)
        if ((rec.status || 'draft') === 'draft') markInvoiceSent(rec.id);
        const entry = {
          id: uid(), stage: 'invoice_sent',
          sentAt: new Date().toISOString(),
          sentBy: _currentUserName(), method: 'resend',
          invoiceId: rec.id, invoiceRef: rec.number,
        };
        if (result?.id) entry.sentMessageId = result.id;
        DB.update('ac', ac.id, a => ({
          ...a, lastContacted: today(),
          cadence: _pushCadence(a.cadence, entry),
        }));
        closeModal('modal-add-inv');
        _clearReadyToSend(rec.id, 'retail_invoices');
        if (currentPage === 'invoices') renderInvoicesPage();
        renderInvoiceStatus();
        renderAccounts();
        toast('Invoice saved & sent ✓');
      } catch (e) {
        console.error('Invoice send failed:', e);
        toast('Invoice saved, but the email failed' + (e?.message ? ' (' + e.message + ')' : '') + ' — open it and try Send again', 8000);
        closeModal('modal-add-inv');
        if (currentPage === 'invoices') renderInvoicesPage();
      } finally {
        ivSendBtn.disabled = false; ivSendBtn.textContent = 'Save & Send';
      }
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
    row.className     = `sku-row inv-sku-row ${SKU_MAP[sku.id]?.bg || ''}`;
    row.dataset.skuId = sku.id;
    row.innerHTML = `
      ${skuBadge(sku.id)}
      <div class="inv-sku-inputs">
        <input class="iv-cases inv-qty-input" type="number" min="0" step="1" value="${cases}" oninput="_ivRowCalc('${sku.id}')">
        <span class="inv-line-unit">cases</span>
        <span class="inv-line-unit">= <strong class="iv-units">${cases * CANS_PER_CASE}</strong> cans</span>
        <input class="iv-ppc inv-price-input" type="number" min="0" step="0.01" value="${ppc||''}" placeholder="$/cs" oninput="_ivRowCalc('${sku.id}')">
        <span class="iv-line-total inv-line-total">${fmtC(lineTotal)}</span>
      </div>`;
    container.appendChild(row);
  });
  _ivCalcTotal();
}

const _TERMS_DAYS = { net7: 7, net15: 15, net30: 30, net45: 45, net60: 60 };

function _invTermsLabel(inv) {
  const labels = {
    due_on_receipt: 'Due on Receipt',
    net7: 'Net 7', net15: 'Net 15', net30: 'Net 30',
    net45: 'Net 45', net60: 'Net 60',
  };
  const t = inv?.paymentTerms;
  if (!t || t === 'net30') return 'Net 30';
  if (t === 'custom') return inv.paymentTermsCustom || 'Custom';
  return labels[t] || t;
}

function ivTermsChange() {
  const terms = qs('#iv-terms')?.value;
  const customRow = qs('#iv-terms-custom-row');
  if (customRow) customRow.style.display = terms === 'custom' ? '' : 'none';
  if (terms === 'custom') return;

  const dateVal = qs('#iv-date')?.value;
  const dueEl   = qs('#iv-due');
  if (!dueEl || !dateVal) return;

  if (terms === 'due_on_receipt') {
    dueEl.value = dateVal;
  } else {
    const days = _TERMS_DAYS[terms] || 30;
    dueEl.value = new Date(new Date(dateVal + 'T12:00:00').getTime() + days * 864e5)
      .toISOString().slice(0, 10);
  }
}

function ivAccountChange() {
  const acId = qs('#iv-account')?.value;
  const ac   = acId ? DB.a('ac').find(x => x.id === acId) : null;
  const tier = qs('#iv-tier')?.value || 'direct';
  const basePrice = _ivGetPrice(ac, tier);
  qs('#iv-line-items')?.querySelectorAll('[data-sku-id]').forEach(row => {
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
  qs('#iv-line-items')?.querySelectorAll('[data-sku-id]').forEach(row => {
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
  container.querySelectorAll('[data-sku-id]').forEach(row => {
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
  if (!DB._firestoreReady) return;
  // Legacy purpl invoices live in the iv collection — route by _invoiceCol or
  // the update is a silent no-op that still toasts success.
  DB.update(_invoiceCol(id), id, i=>({...i, status:'paid', paidDate:today(), paidAt:new Date().toISOString()}));
  _syncCombinedParentForChild(id); // M1
  renderInvoiceStatus();
  if (currentPage === 'invoices') renderInvoicesPage();
  toast('Marked as paid');
}

function deleteRetailInv(id) {
  if (!DB._firestoreReady) return;
  if (!_requireAdmin('delete invoices')) return;
  if (!confirm2('Delete this invoice?')) return;
  const inv = DB.a('retail_invoices').find(x => x.id === id);
  auditLog('delete', 'retail_invoice', id, inv?.invoiceNumber || inv?.number || id);
  deleteInvoiceWithCleanup(id);
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

  function stockFor(skuId) { return _onHand(skuId, null); }

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

      const avgVal = pos.reduce((s,p)=>s+(p.totalValue||0),0)/pos.length;
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
    windowOrds.forEach(o=>(o.items||[]).forEach(i=>{ totalUnits[i.sku]=(totalUnits[i.sku]||0)+(parseFloat(i.qty)||0); })); // M8: guard NaN

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
// MED-7: notes/outreach are appended with user-chosen (backdatable) dates, so
// the last array element is NOT necessarily the most recent. Scan for the max.
function _maxDate(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((m, x) => (x && x.date && x.date > m) ? x.date : m, '') || null;
}
// Returns the entry with the latest date (not the last appended) — entries can
// be backdated, so positional [length-1] reads misreport the "latest".
function _latestByDate(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((best, x) => (!best || (x?.date || '') > (best.date || '')) ? x : best, null);
}
function acLastContacted(a) {
  // Consider ALL contact signals, not just notes/outreach: the top-level
  // `lastContacted` field (written by email + invoice sends) and the latest
  // cadence entry (mass/template sends append to `cadence`, not `outreach`).
  // Without this, an account you just emailed shows "Last Contacted: —" and
  // gets falsely flagged "Needs Attention". All values normalized to YYYY-MM-DD.
  const cadenceDate = (a.cadence || []).reduce((m, c) => {
    const d = (c.sentAt || '').slice(0, 10);
    return d > m ? d : m;
  }, '');
  const candidates = [
    _maxDate(a.notes),
    _maxDate(a.outreach),
    a.lastContacted || null,
    cadenceDate || null,
  ].filter(Boolean);
  if (!candidates.length) return null;
  return candidates.reduce((m, d) => (d > m ? d : m));
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

// perf: per-render indexes (orders & invoices grouped by accountId), built
// once in renderAccounts so each card is an O(1) lookup instead of re-scanning
// all orders + rebuilding the unified invoice array per card.
let _acIdxOrders = null, _acIdxInv = null;
function _acCardHTML(a, muted) {
  const lastContact  = acLastContacted(a);
  // Pending accounts are leads who haven't placed a first order yet — don't
  // flag them as neglected ("Needs Attention" / red "Never").
  const isPending    = a.status === 'pending';
  const needsAttn    = !muted && !isPending && (daysAgo(a.lastOrder)>=30 || daysAgo(lastContact)>=30);

  const lastOrderHtml = a.lastOrder
    ? `<span class="ac-metric-val${daysAgo(a.lastOrder)>=30?' red':''}">${fmtD(a.lastOrder)} (${daysAgo(a.lastOrder)}d)</span>`
    : isPending
      ? `<span class="ac-metric-val" style="color:var(--muted)">No order yet</span>`
      : `<span class="ac-metric-val red">Never</span>`;

  const lastContactHtml = lastContact
    ? `<span class="ac-metric-val${daysAgo(lastContact)>=30?' red':''}">${fmtD(lastContact)} (${daysAgo(lastContact)}d)</span>`
    : `<span class="ac-metric-val" style="color:var(--muted)">—</span>`;

  const acOrds = (_acIdxOrders ? (_acIdxOrders.get(a.id) || [])
                               : DB.a('orders').filter(o=>o.accountId===a.id&&o.status!=='cancelled'))
    .slice().sort((x,y)=>x.dueDate>y.dueDate?1:-1);
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

  const acInvs = _acIdxInv ? (_acIdxInv.get(a.id) || [])
                           : _allInvoices({accountId: a.id, excludeChildren: true});
  const outstandingAmt = acInvs
    .filter(x => !['paid','draft','void'].includes(x.status))
    .reduce((s, x) => s + _invAmt(x), 0);
  const outstandingHtml = outstandingAmt > 0
    ? `<span class="ac-metric-val red">${fmtC(outstandingAmt)}</span>`
    : `<span class="ac-metric-val green">Clear</span>`;

  const lastNote     = _latestByDate(a.notes);
  const lastOutreach = _latestByDate(a.outreach);
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
          ${a.isPbf?`<span class="badge green" style="font-size:10px">🪻 LF</span>`:''}
          ${(a.skus||[]).map(s=>`<span class="badge ${SKU_MAP[s]?.cls||'gray'}" style="font-size:10px">${SKU_MAP[s]?.label||s}</span>`).join('')}
          
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
        ${(()=>{const ls=(a.samples||[]).slice().sort((x,y)=>y.date>x.date?1:-1)[0];if(!ls)return '';if(ls.status==='shipped'&&!ls.followUpDone)return `<span class="badge green" style="font-size:10px">📦 Sample shipped</span>`;if(ls.shipStationOrderId&&!ls.status)return `<span class="badge blue" style="font-size:10px">🧪 Sample pending ship</span>`;const pending=ls&&!ls.followUpDone&&ls.followUpDate;if(pending&&ls.followUpDate<today())return `<span class="badge red" style="font-size:10px">🧪 Follow-up overdue</span>`;if(pending)return `<span class="badge amber" style="font-size:10px">🧪 Sample sent</span>`;return `<span class="badge" style="background:#e0f2fe;color:#0369a1;font-size:10px">🧪 ${fmtD(ls.date)}</span>`;})()}
        ${a.emailOptOut?`<span class="badge gray" style="font-size:10px">✉ Unsubscribed</span>`:''}
      </div>
    </div>
    ${locs.length>1?`<div id="ac-locs-${a.id}" class="ac-locs-drawer" style="display:none">${locs.map(l=>`
      <div class="ac-loc-item">
        <div class="ac-loc-dot"></div>
        <div style="flex:1;min-width:0">
          ${l.label?`<div class="ac-loc-label">${escHtml(l.label)}</div>`:''}
          ${l.address?`<div class="ac-loc-addr">${escHtml(l.address)}</div>`:''}
          ${l.contact||l.phone?`<div class="ac-loc-addr" style="margin-top:2px">${[l.contact,l.phone].filter(Boolean).map(escHtml).join(' · ')}</div>`:''}
          ${l.dropOffRules?`<div class="ac-loc-drop">🚚 ${escHtml(l.dropOffRules)}</div>`:''}
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
    ${lastNote?.nextAction?`<div class="pr-card-nextsteps"><div class="ac-card-section-label" style="color:#1e40af">☑ Next Steps</div><div class="pr-card-nextsteps-text">${escHtml(lastNote.nextAction)}${lastNote.nextDate?' — '+fmtD(lastNote.nextDate):''}</div></div>`:''}
    ${!lastNote&&lastOutreach?`<div class="ac-card-section"><div class="ac-card-section-label">Recent Outreach</div><div style="font-size:13px">${escHtml(lastOutreach.type||'')} · ${fmtD(lastOutreach.date)}${(lastOutreach.notes||lastOutreach.note)?' — '+escHtml(lastOutreach.notes||lastOutreach.note):''}</div></div>`:''}
    ${locs.length===1&&locs[0].dropOffRules?`<div class="ac-card-rules"><div class="ac-card-section-label">🚚 Drop-Off Rules</div><div class="ac-card-rules-text">${escHtml(locs[0].dropOffRules)}</div></div>`:a.dropOffRules&&!locs.length?`<div class="ac-card-rules"><div class="ac-card-section-label">🚚 Drop-Off Rules</div><div class="ac-card-rules-text">${escHtml(a.dropOffRules)}</div></div>`:''}
    <div class="ac-card-actions">
      <button class="btn sm primary" onclick="openAccount('${a.id}')">View</button>
      <button class="btn sm" onclick="quickNote('${a.id}')">Note</button>
      <button class="btn sm" onclick="logOutreach('${a.id}')">Log Follow-Up</button>
      <button class="btn sm run" onclick="addAccountToRun('${a.id}')">+ Run</button>
      <button class="btn sm" onclick="editAccount('${a.id}')">Edit</button>
      <button class="btn sm" onclick="generateOrderLink('${a.id}')">🔗 Copy Link</button>
      ${_isAdmin()?`<button class="btn sm" style="color:#dc2626" onclick="event.stopPropagation();deleteAccount('${a.id}')">Delete</button>`:''}
    </div>
  </div>`;
}

function renderAccounts() {
  let list = DB.a('ac');
  // Populate the fulfillment filter with active distributors so "via {dist}"
  // filtering — including the dashboard drill-down — actually works (the select
  // used to have only All/Direct, so a distributor value silently no-op'd).
  const _ffSel = qs('#ac-fulfill-filter');
  if (_ffSel) {
    const _cur = _ffSel.value;
    const _dOpts = DB.a('dist_profiles').filter(d=>d.status==='active')
      .sort((a,b)=>(a.name||'')<(b.name||'')?-1:1)
      .map(d=>`<option value="${d.id}">via ${escHtml(d.name)}</option>`).join('');
    _ffSel.innerHTML = `<option value="">All Fulfillment</option><option value="direct">Direct</option><option value="__any_dist__">Via distributor (any)</option>${_dOpts}`;
    _ffSel.value = _cur;
  }
  const search        = qs('#ac-search')?.value?.toLowerCase().trim() || '';
  const typeFilter    = qs('#ac-type-filter')?.value || '';
  const fulfillFilter = qs('#ac-fulfill-filter')?.value || '';
  const statusFilter  = qs('#ac-status-filter')?.value || '';
  const sortVal       = qs('#ac-sort')?.value || 'name';

  if (search) list = list.filter(a=>
    a.name?.toLowerCase().includes(search) ||
    a.contact?.toLowerCase().includes(search) ||
    a.territory?.toLowerCase().includes(search) ||
    a.address?.toLowerCase().includes(search));
  if (typeFilter) list = list.filter(a=>a.type===typeFilter);
  if (statusFilter) list = list.filter(a=>(a.status||'active')===statusFilter);
  // isPbf = carries Lavender Fields; purpl is carried if the account has purpl SKUs.
  if (_acBrandFilter === 'lf')    list = list.filter(a=>!!a.isPbf && !(a.skus && a.skus.length)); // LF only
  else if (_acBrandFilter === 'purpl') list = list.filter(a=>!a.isPbf);                            // purpl only
  else if (_acBrandFilter === 'both')  list = list.filter(a=>!!a.isPbf && a.skus && a.skus.length > 0); // both lines
  if (fulfillFilter === 'direct') list = list.filter(a=>!a.fulfilledBy||a.fulfilledBy==='direct');
  else if (fulfillFilter === '__any_dist__') list = list.filter(a=>a.fulfilledBy && a.fulfilledBy!=='direct');
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

  // perf: index orders & invoices by account ONCE (was re-scanned/rebuilt per
  // card → O(accounts × (orders + all invoices)); ~100 accounts made this slow).
  _acIdxOrders = new Map();
  DB.a('orders').forEach(o => {
    if (o.status === 'cancelled') return;
    const arr = _acIdxOrders.get(o.accountId);
    if (arr) arr.push(o); else _acIdxOrders.set(o.accountId, [o]);
  });
  _acIdxInv = new Map();
  _allInvoices({ excludeChildren: true }).forEach(inv => {
    const arr = _acIdxInv.get(inv.accountId);
    if (arr) arr.push(inv); else _acIdxInv.set(inv.accountId, [inv]);
  });

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

// Sample status badge for the account header — see at a glance whether
// this account has been sampled, has a pending request, or never sampled.
function _sampleStatusBadge(a) {
  const samples = a.samples || [];
  const shipped = samples.find(s => s.status === 'shipped' || s.shippedAt || s.trackingNumber);
  if (shipped) {
    const when = shipped.shippedAt ? fmtD(String(shipped.shippedAt).slice(0,10)) : (shipped.date ? fmtD(shipped.date) : '');
    return `<span class="badge green" title="Sample shipped${when ? ' ' + when : ''}">🧪 Sampled${when ? ' · ' + when : ''}</span>`;
  }
  if (samples.length) {
    return `<span class="badge amber" title="Sample logged, not yet shipped">🧪 Sample pending</span>`;
  }
  // Check for an unshipped portal sample request matched to this account
  try {
    const req = (typeof PortalDB !== 'undefined' ? PortalDB.getOrders() : [])
      .find(o => o.requestSample && o.accountId === a.id && !o.sampleDeclined);
    if (req) return `<span class="badge amber" title="Sample requested via portal">🧪 Sample requested</span>`;
  } catch(e) {}
  return `<span class="badge gray" title="No sample sent yet">🧪 Not sampled</span>`;
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
      ? `<span class="badge green">🪻 Lavender Fields wholesaler + purpl</span>`
      : `<span class="badge purple">purpl only</span>`;
  }
  const sampleBadgeEl = qs('#mac-sample-badge');
  if (sampleBadgeEl) sampleBadgeEl.innerHTML = _sampleStatusBadge(a);
  const avEl = qs('#mac-avatar');
  if (avEl) {
    const initials = (a.name||'?').trim().split(/\s+/).slice(0,2).map(w => (w[0]||'').toUpperCase()).join('') || '?';
    const hues = ['#7B4FA0','#4a7c59','#b45309','#1d4ed8','#be185d','#0f766e'];
    avEl.style.background = hues[(a.name||'').length % hues.length];
    avEl.textContent = initials;
  }
  const qaEl = qs('#mac-quick-actions');
  if (qaEl) {
    qaEl.innerHTML =
      `<button class="btn xs primary" onclick="closeModal('modal-account');openAddInv('${id}')">🧾 New Invoice</button>` +
      `<button class="btn xs" onclick="_macGoToEmailsTab()">✉️ Email</button>` +
      `<button class="btn xs" onclick="printAccountStatement('${id}')">🖨 Statement</button>`;
  }

  // Overview tab
  const _contacts = a.contacts || [];
  if (_contacts.length > 1) {
    qs('#mac-contact').innerHTML = _contacts.map(c =>
      `<div style="font-size:13px${c.isPrimary?' ;font-weight:600':''}">` +
      `${escHtml(c.name||'')}${c.role?' <span style="color:var(--muted);font-size:11px">('+escHtml(c.role)+')</span>':''}` +
      `${c.isPrimary?' <span style="font-size:10px;color:var(--purpl)">★ Primary</span>':''}` +
      `</div>`
    ).join('');
  } else {
    qs('#mac-contact').textContent = a.contact||'—';
  }
  qs('#mac-phone').textContent = (_contacts.find(c=>c.isPrimary)||_contacts[0]||{}).phone || a.phone || '—';
  qs('#mac-email').textContent = (_contacts.find(c=>c.isPrimary)||_contacts[0]||{}).email || a.email || '—';
  qs('#mac-type').textContent = a.type||'—';
  qs('#mac-territory').textContent = a.territory||'—';
  qs('#mac-since').textContent = fmtD(a.since);
  qs('#mac-last-order').textContent = a.lastOrder ? `${fmtD(a.lastOrder)} (${daysAgo(a.lastOrder)}d ago)` : '—';
  qs('#mac-skus').innerHTML = (a.skus||[]).map(skuBadge).join(' ');
  qs('#mac-par').innerHTML = Object.entries(a.par||{}).map(([k,v])=>`${skuBadge(k)} par: <strong>${escHtml(String(v))}</strong>`).join('&nbsp;&nbsp;');

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
      if (t.dataset.tab === 'samples') renderMacSamplesTab(id);
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
  const REG_LABEL   = {purpl:'💜 purpl', lf:'🪻 LF', both:'Both'};
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
  order_confirmation:    'order-confirmation',
  invoice_sent:          'invoice-sent',
  invoice_reminder:      'invoice-reminder',
  payment_overdue:       'payment-overdue',
  first_order_followup:  'first-order',
  reorder_reminder:      'reorder-reminder',
  delivery_followup:     'delivery-followup',
  new_product:           'new-product',
  thank_you:             'thank-you',
  custom:                'custom',
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
    ? findInvoice(invId)
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
  // Same opt-out gate as the Emails page — this path had none, so an
  // unsubscribed account could be emailed from the Cadence tab with no warning.
  const _optAc = DB.a('ac').find(x => x.id === _currentEmailPreview.accountId);
  if (_optAc?.emailOptOut && !confirm2(`${_optAc.name} has unsubscribed from emails. Send anyway?`)) return;
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
      markCadenceEmailSent(null);
    })
    .finally(() => {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Email'; }
    });
}

function markCadenceEmailSent(sentMessageId) {
  if (!_currentEmailPreview) return;
  const {stage, accountId} = _currentEmailPreview;
  const stageId = _TEMPLATE_STAGE_IDS[stage] || stage;
  const ac = DB.a('ac').find(x => x.id === accountId);
  const recent = (ac?.cadence||[]).find(c => c.stage === stageId && (Date.now() - new Date(c.sentAt).getTime()) < 60000);
  if (recent) { toast('Already sent — duplicate blocked'); return; }
  const entry = {
    id: uid(), stage: stageId,
    sentAt: new Date().toISOString(),
    sentBy: _currentUserName(),
    method: 'manual',
  };
  if (sentMessageId) entry.sentMessageId = sentMessageId;
  // Stamp lastContacted too — cadence-tab sends were invisible to the
  // mass-send "Sent today" stamp and last-contact filters.
  DB.update('ac', accountId, a => ({...a, lastContacted: today(), cadence: _pushCadence(a.cadence, entry)}));
  closeModal('modal-email-preview');
  openAccountToEmailsTab(accountId);
  renderCadenceOverdue();
  toast('Email marked as sent');
}

// ══════════════════════════════════════════════════════════
// ── Samples Tab ───────────────────────────────────────────
function renderMacSamplesTab(accountId) {
  const a   = DB.a('ac').find(x => x.id === accountId);
  const el  = qs('#mac-samples-tab-content');
  if (!el || !a) return;

  // Wire + Log Sample / Send Sample buttons
  const btn = qs('#mac-tab-log-sample-btn');
  if (btn) btn.onclick = () => openLogSampleModal('ac', accountId);
  const shipSampleBtn = qs('#mac-tab-ship-sample-btn');
  if (shipSampleBtn) shipSampleBtn.onclick = () => {
    if (confirm2('Push a 3-can sample box to ShipStation for ' + (a.name || 'this account') + '?')) pushSampleToShipStation(accountId);
  };

  const samples = (a.samples || []).slice().sort((x, y) => (x.date > y.date ? -1 : 1));
  if (!samples.length) {
    el.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:8px 0">No samples logged yet.</div>';
    return;
  }

  const todayStr = today();
  el.innerHTML = samples.map(s => {
    const skuLabel = SKU_MAP[s.sku]?.label || s.sku || '—';
    const overdue  = !s.followUpDone && s.followUpDate && s.followUpDate < todayStr;
    const pending  = !s.followUpDone && s.followUpDate && s.followUpDate >= todayStr;
    return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <span style="font-weight:600;font-size:13px">${escHtml(skuLabel)}</span>
          ${s.qty ? `<span style="font-size:12px;color:var(--muted);margin-left:6px">${s.qty} cans</span>` : ''}
          <span style="font-size:12px;color:var(--muted);margin-left:8px">${fmtD(s.date)}</span>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${overdue ? `<span class="badge red" style="font-size:10px">Follow-up overdue</span>` : ''}
          ${pending ? `<span class="badge amber" style="font-size:10px">Follow-up ${fmtD(s.followUpDate)}</span>` : ''}
          ${s.followUpDone ? `<span class="badge green" style="font-size:10px">Done</span>` : ''}
        </div>
      </div>
      ${s.contact ? `<div style="font-size:12px;color:var(--muted);margin-top:2px">Contact: ${escHtml(s.contact)}</div>` : ''}
      ${s.notes   ? `<div style="font-size:12px;color:var(--text);margin-top:3px">${escHtml(s.notes)}</div>` : ''}
      ${(!s.followUpDone && s.followUpDate) ? `<button class="btn xs" style="margin-top:6px" onclick="markSampleFollowUpDone('ac','${accountId}','${s.id}')">Mark Done</button>` : ''}
    </div>`;
  }).join('');
}

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
      const toLabel = c.to ? `<div style="font-size:11px;color:var(--muted)">${escHtml(c.to)}</div>` : '';
      return `<tr><td>${fmtD(c.sentAt)}</td><td>${s?.label||c.stage}${toLabel}</td><td>${c.method||'—'}</td><td>${c.sentBy||'—'}</td><td>${status}</td></tr>`;
    }).join('');
    logEl.innerHTML = `<div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Email History</div>
      <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Stage</th><th>Method</th><th>Sent By</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  } else {
    logEl.innerHTML = '<div class="empty" style="padding:12px 0">No cadence emails sent yet</div>';
  }
}

function _latestAccountInvoiceId(accountId) {
  const purpl = _allPurplInvoices().filter(x=>x.accountId===accountId).sort((a,b)=>(b.created||b.date||'')>(a.created||a.date||'')?1:-1)[0];
  const lf    = DB.a('lf_invoices').filter(x=>x.accountId===accountId).sort((a,b)=>b.created>a.created?1:-1)[0];
  if (!purpl && !lf) return '';
  if (!purpl) return lf.id;
  if (!lf)   return purpl.id;
  return (purpl.created||'') >= (lf.created||'') ? purpl.id : lf.id;
}


function markCadenceSent(accountId, stageId, method, invoiceId) {
  const entry = { id: uid(), stage: stageId, sentAt: today(), sentBy: _currentUserName(), method: method||'manual' };
  if (invoiceId) entry.invoiceId = invoiceId;
  DB.update('ac', accountId, a => ({...a, cadence: _pushCadence(a.cadence, entry)}));
  renderMacEmailsTab(accountId);
  renderCadenceOverdue();
  toast('Email logged as sent');
}

// ══════════════════════════════════════════════════════════
//  AI EMAIL DRAFTING
// ══════════════════════════════════════════════════════════
function _aiSystemPrompt() { return `You are a sales assistant for Graham Biagiotti at Pumpkin Blossom Farm. Graham sells two wholesale product lines: purpl (lavender lemonade, 12-pack cases, MSRP $3.29/can) and Lavender Fields (farm lavender products including simple syrup, candles, scrunchies, sachets, roll-ons, refresh powder, dryer sachets). Write professional, warm, concise wholesale outreach emails. Never use emojis in the email body. Always end with the signature block provided. Respond with JSON only: {"subject": "...", "body": "..."}`; }

function _aiSignature() { return `Graham Biagiotti — Director of Sales\n603-748-3038 · Warner, NH\nPumpkin Blossom Farm | purpl & Lavender Fields`; }

function _SIG() { return _aiSignature(); }

const CADENCE_STAGES = [
  {
    id: 'application_received',
    label: 'Application Received',
    desc: 'Thank you for applying',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Thank you for your wholesale application — Pumpkin Blossom Farm',
    body: (a) => `Hi ${a.contact||a.name},\n\nThank you for your interest in carrying our products at ${a.name}. We've received your application and will be in touch within 1 business day.\n\nIn the meantime, feel free to reach out with any questions.\n\nWarmly,\n${_SIG()}`
  },
  {
    id: 'approved_welcome',
    label: 'Approved — Welcome + Portal',
    desc: 'Welcome + portal access + password',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Welcome to the wholesale program — your retailer portal is ready',
    body: (a) => {
      const token = a.orderPortalToken || '';
      const portalLink = token ? `https://pbfwholesale.com/order?t=${token}` : '[portal link not yet generated — use Copy Link on the account first]';
      return `Hi ${a.contact||a.name},\n\nWe're thrilled to welcome ${a.name} as a retail partner. Your wholesale account has been approved.\n\nYour retailer order portal:\n${portalLink}\n\nUse this link to place orders, view order history, and manage your account. Bookmark it for easy access.\n\nPayment terms: Net 30. Invoices from lavender@pbfwholesale.com.\n\nLooking forward to growing together.\n\nWarmly,\n${_SIG()}`;
    }
  },
  {
    id: 'rejected_decline',
    label: 'Rejected — Polite Decline',
    desc: 'Polite decline of application',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Re: Your wholesale application — Pumpkin Blossom Farm',
    body: (a) => `Hi ${a.contact||a.name},\n\nThank you for your interest in carrying our products. After reviewing your application, we don't think it's the right fit at this time — but we appreciate you reaching out and wish you all the best.\n\nPlease don't hesitate to apply again in the future if circumstances change.\n\nWarmly,\n${_SIG()}`
  },
  {
    id: 'order_confirmation',
    label: 'Order Confirmation',
    desc: 'Confirm order received, delivery coming',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Order received — Pumpkin Blossom Farm',
    body: (a) => `Hi ${a.contact||a.name},\n\nWe received your order for ${a.name} and we're on it. You'll hear from us with delivery details shortly.\n\nQuestions? Reply to this email or call 603-748-3038.\n\nWarmly,\n${_SIG()}`
  },
  {
    id: 'invoice_sent',
    label: 'Invoice Sent',
    desc: 'Invoice notification to retailer',
    from: 'lavender@pbfwholesale.com',
    subject: (inv) => `Invoice ${inv?.number||inv?.invoiceNumber||''} from Pumpkin Blossom Farm`,
    body: (a, inv) => `Hi ${a.contact||a.name},\n\nPlease find your invoice ${inv?.number||inv?.invoiceNumber||''} for ${fmtC(inv?.amount||inv?.total||0)}. Payment is due within 30 days per our Net 30 terms.\n\n${inv?.link?`View invoice: ${inv.link}\n\n`:''}Please reach out with any questions.\n\nWarmly,\n${_SIG()}`
  },
  {
    id: 'invoice_reminder',
    label: 'Invoice Reminder',
    desc: 'Payment due soon or overdue',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Friendly reminder — invoice from Pumpkin Blossom Farm',
    body: (a) => `Hi ${a.contact||a.name},\n\nJust a friendly reminder that you have an outstanding invoice from Pumpkin Blossom Farm. We'd appreciate payment at your earliest convenience.\n\nIf you've already sent payment, please disregard this message.\n\nQuestions about your invoice? Reply to this email or call 603-748-3038.\n\nThank you,\n${_SIG()}`
  },
  {
    id: 'payment_overdue',
    label: 'Payment Overdue',
    desc: 'Past-due invoice follow-up',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Payment overdue — Pumpkin Blossom Farm',
    body: (a) => `Hi ${a.contact||a.name},\n\nWe're reaching out regarding an overdue invoice for ${a.name}. Our records show payment is past the Net 30 terms.\n\nPlease arrange payment at your earliest convenience, or let us know if there's an issue we can help with.\n\nThank you for your attention to this.\n\n${_SIG()}`
  },
  {
    id: 'first_order_followup',
    label: 'First Order Follow-Up',
    desc: 'Thank you for your first order',
    from: 'lavender@pbfwholesale.com',
    subject: () => "Thanks for your order — we're on it",
    body: (a) => `Hi ${a.contact||a.name},\n\nThank you for placing your first order with us. We're getting it ready and will be in touch with delivery details shortly.\n\nWe're excited to have ${a.name} as a retail partner and look forward to supporting your success with our products on your shelves.\n\nWarmly,\n${_SIG()}`
  },
  {
    id: 'reorder_reminder',
    label: 'Reorder Reminder',
    desc: 'Time to restock?',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Time to restock? — Pumpkin Blossom Farm',
    body: (a) => {
      const token = a.orderPortalToken || '';
      const portalLink = token ? `https://pbfwholesale.com/order?t=${token}` : '';
      return `Hi ${a.contact||a.name},\n\nHope things are going well at ${a.name}! It's been a little while since your last order and we wanted to check in.\n\nRunning low on anything? ${portalLink ? `You can reorder anytime through your portal:\n${portalLink}\n\n` : '\n'}Let us know if there's anything we can do — happy to help.\n\nWarmly,\n${_SIG()}`;
    }
  },
  {
    id: 'delivery_followup',
    label: 'Post-Delivery Check-In',
    desc: 'How did the delivery go?',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Quick check-in — Pumpkin Blossom Farm',
    body: (a) => `Hi ${a.contact||a.name},\n\nJust wanted to check in after your recent delivery. Everything look good? Products shelved and selling well?\n\nIf you need anything — signage, marketing materials, or just want to chat about what's selling — don't hesitate to reach out.\n\nWarmly,\n${_SIG()}`
  },
  {
    id: 'new_product',
    label: 'New Product Announcement',
    desc: 'Announce a new product or flavor',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Something new from Pumpkin Blossom Farm',
    body: (a) => `Hi ${a.contact||a.name},\n\nWe're excited to share something new with you!\n\n[PRODUCT NAME / DESCRIPTION]\n\nWe think this would be a great fit for ${a.name}. Want to add it to your next order?\n\nLet us know if you'd like samples or more information.\n\nWarmly,\n${_SIG()}`
  },
  {
    id: 'thank_you',
    label: 'General Thank You',
    desc: 'Thank a retailer for their support',
    from: 'lavender@pbfwholesale.com',
    subject: () => 'Thank you — Pumpkin Blossom Farm',
    body: (a) => `Hi ${a.contact||a.name},\n\nJust wanted to take a moment to say thank you for your partnership with Pumpkin Blossom Farm. We really appreciate ${a.name}'s support.\n\nLooking forward to continued growth together.\n\nWarmly,\n${_SIG()}`
  },
  {
    id: 'custom',
    label: 'Custom Email',
    desc: 'Write your own message',
    from: 'lavender@pbfwholesale.com',
    subject: () => '',
    body: () => ''
  },
];

async function _callAnthropicApi(userPrompt) {
  const fn = firebase.functions().httpsCallable('callAnthropic');
  const result = await fn({ prompt: userPrompt, systemPrompt: _aiSystemPrompt() });
  const text = result.data?.text || '';
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
${_aiSignature()}`;

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
  _renderEmailsAutoSends(accounts);
  _renderEmailsRightCol();
  renderEmailsTabOverview(accounts);
  renderEmailsTabHistory(accounts);
  renderMassEmail();
}

const _AUTO_SEND_STAGES = new Set([
  'invoice_reminder', 'order_confirmation',
  'approved', 'approved_welcome',
  'rejected', 'rejected_decline',
  'application_received', 'application-received',
]);

const _AUTO_SEND_LABELS = {
  'invoice_reminder':     'Invoice Reminder',
  'order_confirmation':   'Order Confirmation',
  'approved':             'Approved — Welcome',
  'approved_welcome':     'Approved — Welcome',
  'rejected':             'Rejected — Decline',
  'rejected_decline':     'Rejected — Decline',
  'application_received': 'Application Received',
  'application-received': 'Application Received',
};

function _renderEmailsAutoSends(accounts) {
  const el = document.getElementById('emails-auto-sends');
  if (!el) return;

  const entries = [];
  (accounts || DB.a('ac')).forEach(a => {
    (a.cadence || []).forEach(c => {
      if (_AUTO_SEND_STAGES.has(c.stage)) {
        entries.push({ ...c, accountName: a.name, accountId: a.id });
      }
    });
  });
  entries.sort((a, b) => (b.sentAt || '') > (a.sentAt || '') ? 1 : -1);
  const recent = entries.slice(0, 10);

  if (!recent.length) {
    el.innerHTML = '';
    return;
  }

  const rows = recent.map(e => {
    const label = _AUTO_SEND_LABELS[e.stage] || e.stage || '—';
    const dt = e.sentAt
      ? new Date(e.sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
    const status = e.opened
      ? `<span class="badge green" style="font-size:10px">👁 Opened${e.openedAt ? ' ' + fmtD(e.openedAt) : ''}</span>`
      : e.clicked
        ? `<span class="badge green" style="font-size:10px">🔗 Clicked</span>`
        : `<span class="badge gray" style="font-size:10px">Sent</span>`;
    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--border);font-size:12px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(label)}</div>
        <div style="color:var(--muted)">${escHtml(e.accountName || '—')} · ${dt}</div>
      </div>
      <div>${status}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div style="margin-bottom:16px">
      <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Recent Auto-Sends</div>
      <div style="background:var(--card-bg,#fff);border:1px solid var(--border);border-radius:8px;overflow:hidden">${rows}</div>
    </div>`;
}

function _renderEmailsTemplatesCol() {
  const el = document.getElementById('emails-templates-col');
  if (!el) return;
  const TEMPLATES = [
    {id:'preorder-announcement', name:'Pre-Order Announcement', desc:'Introduce purpl + personalized order link'},
    {id:'application-received', name:'Application Received',    desc:'Thank you for applying'},
    {id:'approved',             name:'Approved — Welcome',      desc:'Portal link + password + catalog'},
    {id:'rejected',             name:'Rejected — Decline',      desc:'Polite decline email'},
    {id:'order-confirmation',   name:'Order Confirmation',      desc:'Order received, delivery coming'},
    {id:'invoice-sent',         name:'Invoice Sent',            desc:'Invoice notification'},
    {id:'invoice-reminder',     name:'Invoice Reminder',        desc:'Payment due soon'},
    {id:'payment-overdue',      name:'Payment Overdue',         desc:'Past-due follow-up'},
    {id:'first-order',          name:'First Order Follow-Up',   desc:'Thanks for first order'},
    {id:'reorder-reminder',     name:'Reorder Reminder',        desc:'Time to restock?'},
    {id:'delivery-followup',    name:'Post-Delivery Check-In',  desc:'How did delivery go?'},
    {id:'new-product',          name:'New Product Announcement', desc:'Announce new product'},
    {id:'thank-you',            name:'General Thank You',       desc:'Thank a retailer'},
    {id:'custom',               name:'Custom Email',            desc:'Write your own'},
  ];
  const cards = TEMPLATES.map(t => `
    <div class="email-template-card${_emailsSelectedTemplate === t.id ? ' active' : ''}"
         onclick="selectEmailTemplate('${t.id}')">
      <div class="etc-name">${t.name}</div>
      <div class="etc-desc">${t.desc}</div>
      <div class="etc-from">lavender@pbfwholesale.com</div>
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

async function _renderEmailsRightCol() {
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

  let contactPickerHtml = '';
  if (account) {
    if (account.emailOptOut) {
      contactPickerHtml += `<div style="margin-bottom:10px;padding:8px 10px;background:#fef2f2;border:1px solid #fecaca;border-radius:6px;font-size:12px;color:#991b1b">✉ This account has <strong>unsubscribed</strong> — you'll be asked to confirm before sending.</div>`;
    }
    const cts = (account.contacts || []).filter(c => c.email);
    if (cts.length > 1) {
      const opts = cts.map(c => `<option value="${escHtml(c.email)}"${c.isPrimary ? ' selected' : ''}>${escHtml(c.name || 'Contact')} — ${escHtml(c.email)}${c.role ? ' (' + escHtml(c.role) + ')' : ''}${c.isPrimary ? ' ★' : ''}</option>`).join('');
      contactPickerHtml = `<div style="margin-bottom:12px">
        <label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px">SEND TO</label>
        <select id="emails-contact-pick" style="width:100%">
          ${opts}
          <option value="__all__">All contacts (${cts.length})</option>
        </select>
      </div>`;
    } else if (cts.length === 1) {
      contactPickerHtml = `<div style="margin-bottom:8px;font-size:12px;color:var(--muted)">To: ${escHtml(cts[0].name || '')} — ${escHtml(cts[0].email)}</div>`;
    } else if (account.email) {
      contactPickerHtml = `<div style="margin-bottom:8px;font-size:12px;color:var(--muted)">To: ${escHtml(account.email)}</div>`;
    }
  }

  let previewHtml = '';
  if (account) {
    const extra = {};
    if (_emailsSelectedTemplate === 'invoice-sent') {
      const invId = _latestAccountInvoiceId(account.id);
      const inv = invId ? findInvoice(invId) : null;
      if (inv) {
        extra.invoiceNumber = inv.number || inv.invoiceNumber || '';
        extra.invoiceTotal = fmtC(inv.total || inv.grandTotal || 0);
      }
    }
    // Fetch portal password for templates that need it
    if (['preorder-announcement', 'approved'].includes(_emailsSelectedTemplate)) {
      try {
        const _cfg = await firebase.firestore().collection('portal_settings').doc('config').get();
        extra.portalPassword = _cfg.exists ? (_cfg.data().portalPassword || '') : '';
      } catch(e) { console.warn('Portal password fetch failed:', e); }
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
        ${contactPickerHtml}
        <iframe class="emails-preview-frame" srcdoc="${tpl.body.replace(/"/g,'&quot;')}"></iframe>
        ${tokenUi}
        <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;flex-wrap:wrap">
          <button class="btn xs" onclick="emailsPageCopyHTML()">Copy HTML</button>
          <button class="btn xs" onclick="emailsPageOpenGmail()">Open in Gmail</button>
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
      <input id="emails-account-search" type="search" placeholder="Type to search accounts…"
        autocomplete="off" oninput="filterAccountSelect('emails-account',this.value)"
        style="width:100%;margin-bottom:4px">
      <select id="emails-account" onchange="selectEmailsAccount(this.value)" style="width:100%">
        <option value="">Select account...</option>
        ${acctOptions}
      </select>
    </div>
    ${previewHtml}`;
  const _eSel = document.getElementById('emails-account');
  if (_eSel) {
    _eSel._accounts = accounts.map(a => ({ id: a.id, name: a.name }));
    _eSel._placeholder = 'Select account...';
    if (_emailsSelectedAccountId) _eSel.value = _emailsSelectedAccountId;
  }
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
  const addrs = _getEmailsRecipients(account);
  if (tpl) window.open(`mailto:${encodeURIComponent(addrs.join(','))}?subject=${encodeURIComponent(tpl.subject)}`, '_blank');
}

function _getEmailsRecipients(account) {
  const pick = qs('#emails-contact-pick');
  if (pick && pick.value === '__all__') {
    return (account.contacts || []).filter(c => c.email).map(c => c.email);
  }
  if (pick && pick.value) return [pick.value];
  const contacts = account.contacts || [];
  const primary = contacts.find(c => c.isPrimary) || contacts[0] || {};
  return [primary.email || account.email || ''].filter(Boolean);
}

function emailsPageSendEmail() {
  if (!_emailsSelectedTemplate || !_emailsSelectedAccountId) return;
  const account = DB.a('ac').find(x => x.id === _emailsSelectedAccountId);
  if (!account) return;
  const extra = {};
  if (_emailsSelectedTemplate === 'invoice-sent') {
    const invId = _latestAccountInvoiceId(account.id);
    const inv = invId ? findInvoice(invId) : null;
    if (inv) {
      extra.invoiceNumber = inv.number || inv.invoiceNumber || '';
      extra.invoiceTotal = fmtC(inv.total || inv.grandTotal || 0);
    }
  }
  const tpl = getCadenceEmailTemplate(_emailsSelectedTemplate, account, extra);
  if (!tpl) return;
  // The Custom template ships with a literal placeholder and this page has no
  // edit surface — block it instead of emailing "[Your message here]".
  if (tpl.body && tpl.body.includes('[Your message here]')) {
    toast('The Custom template needs a real message — edit it via the account modal Cadence tab before sending.', 7000);
    return;
  }
  const toEmails = _getEmailsRecipients(account);
  const toEmail = toEmails[0] || '';
  if (!toEmail) { toast('No recipient email on file'); return; }
  if (account.emailOptOut && !confirm2(`${account.name} has unsubscribed from emails. Send anyway?`)) return;

  const btn = document.getElementById('emails-page-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  const _sendOne = async (addr) => {
    try {
      const result = await callSendEmail(addr, 'lavender@pbfwholesale.com', tpl.subject, tpl.body);
      const stageId = _TEMPLATE_STAGE_IDS[_emailsSelectedTemplate] || _emailsSelectedTemplate;
      const entry = {id: uid(), stage: stageId, sentAt: new Date().toISOString(), sentBy: _currentUserName(), method: 'resend', to: addr};
      if (result?.id) entry.sentMessageId = result.id;
      DB.update('ac', account.id, a => ({
        ...a,
        lastContacted: today(),
        cadence: _pushCadence(a.cadence, entry)
      }));
      return true;
    } catch(_) {
      window.open(`mailto:${encodeURIComponent(addr)}?subject=${encodeURIComponent(tpl.subject)}`, '_blank');
      const stageId = _TEMPLATE_STAGE_IDS[_emailsSelectedTemplate] || _emailsSelectedTemplate;
      DB.update('ac', account.id, a => ({
        ...a,
        lastContacted: today(),
        cadence: _pushCadence(a.cadence, {id: uid(), stage: stageId, sentAt: new Date().toISOString(), sentBy: _currentUserName(), method: 'gmail', to: addr})
      }));
      return false;
    }
  };

  (async () => {
    let ok = 0, fail = 0;
    for (const addr of toEmails) {
      if (await _sendOne(addr)) ok++; else fail++;
      if (toEmails.length > 1) await new Promise(r => setTimeout(r, 300));
    }
    const msg = toEmails.length > 1 ? `Sent to ${ok} contact${ok > 1 ? 's' : ''}${fail ? `, ${fail} via Gmail` : ''}` : 'Email sent ✓';
    toast(msg);
    renderEmailsPage();
  })();
}

function emailsPageMarkSent() {
  if (!_emailsSelectedTemplate || !_emailsSelectedAccountId) return;
  const stageId = _TEMPLATE_STAGE_IDS[_emailsSelectedTemplate] || _emailsSelectedTemplate;
  DB.update('ac', _emailsSelectedAccountId, a => ({
    ...a,
    cadence: _pushCadence(a.cadence, {id: uid(), stage: stageId, sentAt: new Date().toISOString(), sentBy: _currentUserName(), method: 'manual'})
  }));
  toast('Email marked as sent');
  renderEmailsPage();
}

async function _emailsApprovedGenerateToken() {
  if (!_emailsSelectedAccountId) return;
  const account = DB.a('ac').find(x => x.id === _emailsSelectedAccountId);
  if (!account) return;
  const token = generateSecureToken(account.id);
  try {
    await firebase.firestore().collection('accounts').doc(account.id).set({
      orderPortalToken: token,
      orderPortalTokenCreatedAt: new Date().toISOString().slice(0,10)
    }, { merge: true });
    DB.update('ac', account.id, a => ({...a, orderPortalToken: token, orderPortalTokenCreatedAt: new Date().toISOString().slice(0,10)}));
    const link = 'https://pbfwholesale.com/order?t=' + token;
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
      ? '<span class="badge green">🪻 LF</span>'
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
    'invoice_reminder':     'Invoice Reminder',
    'order_confirmation':   'Order Confirmation',
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

  const engagement = e => e.clicked
    ? `<span class="badge blue" title="Clicked${e.clickedAt?' '+fmtD(e.clickedAt):''}">🔗 Clicked</span>`
    : e.opened
      ? `<span class="badge green" title="Opened${e.openedAt?' '+fmtD(e.openedAt):''}">👁 Opened</span>`
      : (e.method === 'resend' ? '<span style="color:var(--muted);font-size:12px">Not opened</span>' : '<span style="color:var(--muted);font-size:12px">—</span>');

  const rows = allEntries.map(e => `<tr>
    <td>${e.sentAt ? new Date(e.sentAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—'}</td>
    <td><strong>${escHtml(e.accountName||'?')}</strong></td>
    <td>${escHtml(STAGE_LABELS[e.stage]||e.stage||'—')}</td>
    <td>${engagement(e)}</td>
    <td><span class="badge gray">${e.method||'manual'}</span></td>
    <td><button class="btn xs" onclick="openAccount('${e.accountId}')">View Account</button></td>
  </tr>`).join('');

  const el = document.getElementById('emails-tab-history');
  if (el) el.innerHTML = `
    <div class="card">
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Date</th><th>Account</th><th>Template</th><th>Engagement</th><th>Method</th><th>Actions</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6" class="empty">No emails sent yet</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function switchEmailsTab(tab) {
  ['compose','overview','history','mass','samples'].forEach(t => {
    const el = document.getElementById('emails-tab-'+t);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  document.querySelectorAll('#page-emails .tab').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.toLowerCase().includes(tab));
  });
  if (tab === 'mass') renderMassEmail();
  if (tab === 'samples') renderEmailsSamples();
}

function renderEmailsSamples() {
  const el = qs('#emails-samples-list');
  if (!el) return;
  const groups = _dedupeSampleRequests();
  if (!groups.length) { el.innerHTML = '<div class="empty">No sample requests yet</div>'; return; }
  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>Date</th><th>Account</th><th>Email</th><th>Address</th><th>Status</th><th></th></tr></thead>
    <tbody>${groups.map(g => {
      const o = g.rep;
      const addr = o.shipAddress || {};
      const addrStr = [addr.street1, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
      const status = g.approved ? '<span class="badge green">Approved</span>'
        : g.declined ? '<span class="badge red">Declined</span>'
        : '<span class="badge amber">Pending</span>';
      return `<tr>
        <td>${_fmtPoDate(o.submittedAt)}</td>
        <td><strong>${escHtml(o.accountName||'—')}</strong></td>
        <td>${escHtml(o.billingEmail||o.contactEmail||'—')}</td>
        <td style="font-size:12px">${escHtml(addrStr||'No address')}</td>
        <td>${status}</td>
        <td style="white-space:nowrap">
          ${!g.approved && !g.declined ? `
            <button class="btn xs primary" onclick="_approveSampleRequest('${o.id}')">Approve & Ship</button>
            <button class="btn xs" onclick="_declineSampleRequest('${o.id}')">Decline</button>
          ` : ''}
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
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
  else if (status === 'pending') list = list.filter(a=>a.status==='pending');
  if (brand === 'lf')    list = list.filter(a=>a.isPbf);
  if (brand === 'purpl') list = list.filter(a=>!a.isPbf);
  if (lastContact === 'never') list = list.filter(a=>!a.lastContacted);
  else if (lastContact === '1') {
    // "Not contacted today" — exact date compare. daysAgo() pins date-only
    // strings to noon, so >=1 hid accounts contacted YESTERDAY until ~noon.
    list = list.filter(a=>a.lastContacted !== today());
  }
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
        <div style="font-size:11px">${a.lastContacted === today() ? '<span style="color:#16a34a;font-weight:600">✓ Sent today</span>' : '<span style="color:var(--muted)">'+(a.lastContacted ? fmtD(a.lastContacted) : 'Never contacted')+'</span>'}</div>
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
        <div style="font-size:11px">${a.lastContacted === today() ? '<span style="color:#16a34a;font-weight:600">✓ Sent today</span>' : '<span style="color:var(--muted)">'+(a.lastContacted ? fmtD(a.lastContacted) : 'Never contacted')+'</span>'}</div>
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
  const tplEl   = qs('#me-template-send-count'); if (tplEl)  tplEl.textContent = n;
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
  const userPrompt = `Write a broadcast wholesale email to ${n} accounts. Regarding: ${brandLabel}. ${goal ? 'Goal: ' + goal + '.' : ''} Keep it under 150 words, professional, no emojis. End with this exact signature:\n${_aiSignature()}`;
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

let _meBroadcastInFlight = false;
async function meBroadcastSend() {
  if (_meBroadcastInFlight) { toast('Send already in progress'); return; }
  const accounts = DB.a('ac').filter(a=>_meSelectedIds.has(a.id));
  if (!accounts.length) { toast('No accounts selected'); return; }
  const subject   = qs('#me-subject')?.value?.trim() || '';
  const body      = qs('#me-body')?.value?.trim()    || '';
  const regarding = qs('#me-regarding-btns')?.querySelector('.ac-brand-btn.active')?.dataset?.val || 'purpl';
  const statusEl  = qs('#me-broadcast-status');
  const sendBtn   = qs('#me-send-btn');

  if (!subject || !body) { toast('Enter a subject and body before sending'); return; }

  // Body is plain text with possible newlines
  const bodyHtml  = body.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');

  _meBroadcastInFlight = true;
  if (sendBtn) sendBtn.disabled = true;
  let sent = 0, failed = 0, skipped = 0;

  for (let i = 0; i < accounts.length; i++) {
    const a     = accounts[i];
    const email = (a.contacts||[]).find(c=>c.email)?.email || a.email || '';
    if (statusEl) statusEl.textContent = `Sending ${i+1} of ${accounts.length}…`;

    if (a.emailOptOut) { skipped++; continue; }

    // Build per-account HTML so each email has a unique unsubscribe link
    const html = buildEmailHTML(PBF_HEADER_HTML, '#8B5FBF', `<p style="white-space:pre-wrap;margin:0">${bodyHtml}</p>`, a.id);

    if (!email) { failed++; }
    else {
      try {
        const result = await callSendEmail(email, 'lavender@pbfwholesale.com', subject, html);
        const entry = {
          id: uid(), stage: 'broadcast',
          sentAt: new Date().toISOString(),
          sentBy: _currentUserName(), method: 'resend',
          invoiceRef: subject,
        };
        if (result?.id) entry.sentMessageId = result.id;
        DB.update('ac', a.id, ac => ({
          ...ac,
          lastContacted: today(),
          cadence: _pushCadence(ac.cadence, entry),
        }));
        sent++;
      } catch(_) { failed++; }
    }

    if (i < accounts.length - 1) await new Promise(r=>setTimeout(r, 300));
  }

  const summary = `Broadcast complete — ${sent} sent${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped (unsubscribed)` : ''}`;
  if (statusEl) statusEl.textContent = `✓ ${summary}`;
  _meBroadcastInFlight = false;
  if (sendBtn) sendBtn.disabled = false;
  toast(summary, 5000);
}

// ── Mass Template Send ────────────────────────────────────
function meTemplatePreview() {
  const tplId = qs('#me-template-select')?.value || '';
  const preview = qs('#me-template-preview');
  if (!preview) return;
  if (!tplId) { preview.style.display = 'none'; return; }
  const sampleAccount = DB.a('ac')[0] || {name:'Sample Account', contacts:[{name:'there'}]};
  const tpl = getCadenceEmailTemplate(tplId, sampleAccount);
  if (tpl) {
    preview.style.display = '';
    preview.innerHTML = `<div style="font-weight:600;margin-bottom:4px">${escHtml(tpl.subject)}</div>
      <div style="color:var(--muted)">Each email is personalized per account (name, portal link, etc.)</div>`;
  } else {
    preview.style.display = 'none';
  }
  const countEl = qs('#me-template-send-count');
  if (countEl) countEl.textContent = _meSelectedIds.size;
}

let _meTemplateInFlight = false;
// Templates whose body shows a "personalized order link / no password needed"
// button — every recipient needs a portal token for that link to actually work.
const _TEMPLATES_NEED_LINK = ['preorder-announcement', 'approved'];
async function meTemplateSend() {
  if (_meTemplateInFlight) { toast('Send already in progress'); return; }
  const tplId = qs('#me-template-select')?.value || '';
  if (!tplId) { toast('Select a template first'); return; }
  // Mass send has no edit surface — the Custom template would blast the
  // literal "[Your message here]" placeholder to every selected account.
  if (tplId === 'custom') {
    toast('The Custom template cannot be mass-sent — it contains a placeholder body. Use Broadcast mode to write a one-off message.', 8000);
    return;
  }
  let accounts = DB.a('ac').filter(a => _meSelectedIds.has(a.id));
  if (!accounts.length) { toast('No accounts selected'); return; }

  // Pre-flight summary so a large blast has no surprises.
  const needsLink     = _TEMPLATES_NEED_LINK.includes(tplId);
  const hasEmail      = a => (a.contacts || []).some(c => c.email) || !!a.email;
  const noEmailCount  = accounts.filter(a => !hasEmail(a)).length;
  const newLinkCount  = needsLink ? accounts.filter(a => !a.orderPortalToken && !a.emailOptOut).length : 0;
  let confirmMsg = `Send "${tplId}" to ${accounts.length} account${accounts.length > 1 ? 's' : ''}?`;
  if (noEmailCount) confirmMsg += `\n\n⚠️ ${noEmailCount} have no email address — they will be skipped.`;
  if (newLinkCount) confirmMsg += `\n\n🔗 ${newLinkCount} will get a brand-new personalized order link (generated now).`;
  if (!confirm2(confirmMsg)) return;

  _meTemplateInFlight = true;
  const statusEl = qs('#me-template-status');
  const sendBtn = qs('#me-template-send-btn');
  if (sendBtn) sendBtn.disabled = true;
  let sent = 0, failed = 0, skipped = 0;

  // Ensure every account has a portal token BEFORE sending, so the email's
  // "personalized link, no password needed" button actually works. Mirrors
  // generateOrderLink: write the token to the top-level `accounts` collection
  // (which lookupPortalToken reads) AND the local ac cache. Awaited so the
  // token is persisted server-side before the email goes out.
  if (needsLink) {
    const needTokens = accounts.filter(a => !a.orderPortalToken && !a.emailOptOut);
    let tokenFails = 0;
    for (let t = 0; t < needTokens.length; t++) {
      const a = needTokens[t];
      if (statusEl) statusEl.textContent = `Preparing links ${t + 1} of ${needTokens.length}…`;
      const token = generateSecureToken(a.id);
      const stamp = new Date().toISOString().slice(0, 10);
      try {
        await firebase.firestore().collection('accounts').doc(a.id).set({
          orderPortalToken: token, name: a.name, email: a.email || '', orderPortalTokenCreatedAt: stamp
        }, { merge: true });
        DB.update('ac', a.id, x => ({ ...x, orderPortalToken: token, orderPortalTokenCreatedAt: stamp }));
      } catch (e) { console.error('[preorder] token gen failed for', a.id, e); tokenFails++; }
    }
    if (tokenFails) {
      _meTemplateInFlight = false;
      if (sendBtn) sendBtn.disabled = false;
      if (statusEl) statusEl.textContent = '';
      toast(`⚠️ ${tokenFails} portal link(s) failed to generate. Nothing was sent — check your connection and try again.`, 9000);
      return;
    }
    // Re-fetch so the send loop sees the freshly-generated tokens.
    accounts = DB.a('ac').filter(a => _meSelectedIds.has(a.id));
  }

  let portalPassword = '';
  if (['preorder-announcement', 'approved'].includes(tplId)) {
    try {
      const cfg = await firebase.firestore().collection('portal_settings').doc('config').get();
      portalPassword = cfg.exists ? (cfg.data().portalPassword || '') : '';
    } catch(e) {}
  }

  const allContacts = qs('#me-template-all-contacts')?.checked || false;

  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    const contacts = (a.contacts || []).filter(c => c.email);
    const primary = contacts.find(c => c.isPrimary) || contacts[0] || {};
    const recipients = allContacts ? contacts.map(c => c.email) : [primary.email || a.email || ''].filter(Boolean);
    if (statusEl) statusEl.textContent = `Sending ${i + 1} of ${accounts.length}…`;

    if (a.emailOptOut) { skipped++; continue; }
    if (!recipients.length) { failed++; continue; }

    const extra = { portalPassword };
    if (tplId === 'invoice-sent') {
      const invId = _latestAccountInvoiceId(a.id);
      const inv = invId ? findInvoice(invId) : null;
      if (inv) { extra.invoiceNumber = inv.number || inv.invoiceNumber || ''; extra.invoiceTotal = fmtC(inv.total || inv.grandTotal || 0); }
    }
    const tpl = getCadenceEmailTemplate(tplId, a, extra);
    if (!tpl) { failed++; continue; }

    for (const email of recipients) {
      try {
        const result = await callSendEmail(email, tpl.from || 'lavender@pbfwholesale.com', tpl.subject, tpl.body);
        const stageId = _TEMPLATE_STAGE_IDS[tplId] || tplId;
        const entry = { id: uid(), stage: stageId, sentAt: new Date().toISOString(), sentBy: _currentUserName(), method: 'resend', to: email };
        if (result?.id) entry.sentMessageId = result.id;
        DB.update('ac', a.id, ac => ({ ...ac, lastContacted: today(), cadence: _pushCadence(ac.cadence, entry) }));
        sent++;
      } catch(_) { failed++; }
      await new Promise(r => setTimeout(r, 500)); // ~2/sec — gentle on Resend rate limits
    }
  }

  const summary = `Template send complete — ${sent} sent${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped (unsubscribed)` : ''}`;
  if (statusEl) statusEl.textContent = `✓ ${summary}`;
  _meTemplateInFlight = false;
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
        <button type="button" class="ac-brand-btn ${defaultReg==='lf'?'active':''}" data-val="lf" onclick="setMebwRegarding('lf')">🪻 LF</button>
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
    <div id="mebw-output">
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

  const userPrompt = `Write a wholesale outreach email for the following account:\n\nAccount: ${a.name}\nType: ${a.type||'Wholesale Account'}\nTerritory: ${a.territory||'New Hampshire'}\nBrand: ${brandLabel}\nLast order: ${a.lastOrder?fmtD(a.lastOrder):'Never'}\nLast contacted: ${a.lastContacted?fmtD(a.lastContacted):'Never'}\n\nRecent outreach history:\n${historyText}\n\n${context?'Goal / context: '+context+'\n':''}\nEnd the email with this exact signature:\n${_aiSignature()}`;

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
    // If this account is fulfilled by a now-INACTIVE distributor, that distId
    // won't be in the active list — inject an option for it so the select keeps
    // the real value. Otherwise opening+saving would silently revert it to
    // 'direct', changing the account's invoicing/delivery routing.
    let optHtml = '<option value="direct">Direct (self-deliver)</option>' +
      dists.map(d=>`<option value="${d.id}">${escHtml(d.name)}</option>`).join('');
    if (a.fulfilledBy && a.fulfilledBy !== 'direct' && !dists.some(d=>d.id===a.fulfilledBy)) {
      const inactive = DB.a('dist_profiles').find(d=>d.id===a.fulfilledBy);
      optHtml += `<option value="${a.fulfilledBy}">${escHtml((inactive?.name||'Distributor')+' (inactive)')}</option>`;
    }
    ffSel.innerHTML = optHtml;
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

  qs('#eac-save-btn').onclick = _once(() => saveAccount(id, isNew));
  if (!isNew) {
    const delBtn = qs('#eac-delete-btn');
    if (delBtn) { delBtn.style.display = _isAdmin() ? '' : 'none'; delBtn.onclick = ()=>deleteAccount(id); }
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
  const dupe = DB.a('ac').find(a => a.id !== id && (a.name||'').toLowerCase().trim() === name.toLowerCase());
  if (dupe && !confirm2(`An account named "${dupe.name}" already exists. Create anyway?`)) return;
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
    isPbf:        qs('#eac-ispbf')?.checked || existing?.isPbf || false,
    fulfilledBy:  qs('#eac-fulfilled-by')?.value || 'direct',
    skus, par,
    pricePerCaseDirect: (v=>isNaN(v)?null:v)(parseFloat(qs('#ac-price-direct')?.value)),
    pricePerCaseDist:   (v=>isNaN(v)?null:v)(parseFloat(qs('#ac-price-dist')?.value)),
    pricePerCaseCustom: (v=>isNaN(v)?null:v)(parseFloat(qs('#ac-price-custom')?.value)),
    notes:     existing?.notes||[],
    outreach:  existing?.outreach||[],
    lastOrder: existing?.lastOrder||null,
    created:   existing?.created || today(),
  };

  if (isNew) DB.push('ac', rec);
  else DB.update('ac', id, ()=>rec);
  auditLog(isNew ? 'create' : 'update', 'account', id, rec.name);
  closeModal('modal-edit-account');
  renderAccounts();
  toast(isNew?'Account added':'Account updated');
}

function deleteAccount(id) {
  if (!_requireAdmin('delete accounts')) return;
  if (!confirm2('Delete this account? This cannot be undone.')) return;
  const acName = DB.a('ac').find(x=>x.id===id)?.name || id;
  DB.atomicUpdate(cache => {
    cache['ac']                = (cache['ac']               ||[]).filter(r=>r.id!==id);
    cache['iv']                = (cache['iv']               ||[]).filter(r=>r.accountId!==id);
    cache['orders']            = (cache['orders']           ||[]).filter(r=>r.accountId!==id);
    cache['retail_invoices']   = (cache['retail_invoices']  ||[]).filter(r=>r.accountId!==id);
    cache['lf_invoices']       = (cache['lf_invoices']      ||[]).filter(r=>r.accountId!==id);
    cache['combined_invoices'] = (cache['combined_invoices']||[]).filter(r=>r.accountId!==id);
    cache['pending_invoices']  = (cache['pending_invoices'] ||[]).filter(r=>r.accountId!==id);
    cache['returns']           = (cache['returns']          ||[]).filter(r=>r.accountId!==id);
    cache['dist_invoices']     = (cache['dist_invoices']    ||[]).filter(r=>r.accountId!==id);
    cache['dist_pos']          = (cache['dist_pos']         ||[]).filter(r=>r.accountId!==id);
    cache['lf_wix_deductions'] = (cache['lf_wix_deductions']||[]).filter(r=>r.accountId!==id);
    cache['shipments']         = (cache['shipments']        ||[]).filter(r=>r.accountId!==id);
    cache['runs'] = (cache['runs']||[]).map(r => ({
      ...r,
      stops: (r.stops||[]).filter(s => s.accountId !== id),
    }));
    const run = cache['today_run'];
    if (run && run.stops) run.stops = run.stops.filter(s=>s.accountId!==id);
  });
  auditLog('delete', 'account', id, acName);
  // Clean up external Firestore collections (portal tokens, portal orders)
  firebase.firestore().collection('accounts').doc(id).delete()
    .catch(e => console.warn('External account doc delete failed:', e));
  firebase.firestore().collection('portal_orders').where('accountId', '==', id).get()
    .then(snap => snap.docs.forEach(doc => doc.ref.delete()))
    .catch(e => console.warn('Portal orders cleanup failed:', e));
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
  else list = list.filter(p => !['won','lost'].includes(p.status));
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
    const lastNote      = _latestByDate(p.notes);
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
    const lastOutreach  = _latestByDate(p.outreach);
    const _plc = p.lastContacted || p.lastContact;
    const lastContactStr= _plc
      ? `${fmtD(_plc)} (${daysAgo(_plc)}d)`
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
            ${p.isPbf?`<span class="badge green" style="font-size:10px">🪻 LF</span>`:''}
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
        <div class="pr-card-nextsteps-text">${p.nextAction?escHtml(p.nextAction):'<span style="color:#93c5fd">No next steps set — tap to add</span>'}${p.nextDate?' &nbsp;·&nbsp; <strong>'+fmtD(p.nextDate)+'</strong>':''}</div>
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
  const _plc2 = p.lastContacted || p.lastContact;
  qs('#mpr-last-contact').textContent = _plc2
    ? `${fmtD(_plc2)} (${daysAgo(_plc2)}d ago)` : '—';
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
    lastContacted: today(),
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
    // Carry over all history
    notes:      p.notes||[],
    outreach:   p.outreach||[],
    samples:    p.samples||[],
    cadence:    p.cadence||[],
    contacts:   p.contacts||[],
    lastOrder:  null,
    convertedFrom: 'prospect',
    convertedDate: today(),
    isPbf:      p.isPbf || false,
    // Carry the portal token — without it the next mass send saw no token on
    // the new account record and minted a NEW one, killing the personalized
    // link already emailed to this customer as a prospect.
    ...(p.orderPortalToken ? { orderPortalToken: p.orderPortalToken, orderPortalTokenCreatedAt: p.orderPortalTokenCreatedAt || null } : {}),
  };

  // Atomic: mark prospect won + create account in one Firestore write
  DB.atomicUpdate(cache => {
    cache['pr'] = (cache['pr']||[]).filter(x => x.id !== id);
    cache['ac'] = [...(cache['ac']||[]), newAc];
    // Update orders that referenced the old prospect ID
    cache['orders'] = (cache['orders']||[]).map(o =>
      o.accountId === id ? {...o, accountId: newAc.id, accountName: newAc.name} : o
    );
  });

  // Update portal orders in Firestore to reference the new account ID
  firebase.firestore().collection('portal_orders')
    .where('accountId', '==', id).get()
    .then(snap => snap.docs.forEach(doc =>
      doc.ref.update({ accountId: newAc.id, accountName: newAc.name, isProspect: false })
    ))
    .catch(e => console.warn('Portal orders migration on convert failed:', e));

  // Update external accounts doc if one exists for the prospect
  firebase.firestore().collection('accounts').doc(id).get()
    .then(doc => {
      if (doc.exists) {
        const data = doc.data();
        firebase.firestore().collection('accounts').doc(newAc.id).set({
          ...data, accountId: newAc.id, accountName: newAc.name,
        }, { merge: true });
        doc.ref.delete().catch(() => {});
      }
    })
    .catch(() => {});

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

  qs('#epr-save-btn').onclick = _once(() => saveProspect(id, isNew));
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
    lat = parseFloat(addrEl.dataset.lat) || null;
    lng = parseFloat(addrEl.dataset.lng) || null;
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
    lastContacted: existing?.lastContacted || existing?.lastContact || '',
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
  DB.update('ac', id, a=>({...a, lastContacted: today(), notes:[...(a.notes||[]),note]}));
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
      lastContacted: date,
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
  if (!DB._firestoreReady) { toast('⚠️ Database not ready yet — please wait a moment and try again.'); return; }
  const text = _importProspectsCsvText || qs('#imp-pr-paste')?.value?.trim() || '';
  if (!text) { toast('No CSV data to import'); return; }
  const rows = _parseCSV(text);
  const parsed = rows.map(_csvMapProspect).filter(Boolean);
  const existingNames = new Set(DB.a('pr').map(x => x.name.toLowerCase().trim()));
  const prospects = parsed.filter(p => !existingNames.has(p.name.toLowerCase().trim()));
  const dupes = parsed.length - prospects.length;
  const skipped = rows.length - parsed.length;
  if (!prospects.length) { toast(dupes > 0 ? `All ${parsed.length} rows already exist` : 'No valid rows — ensure a "Business Name" column is present'); return; }
  DB.atomicUpdate(cache => { cache['pr'] = [...(cache['pr'] || []), ...prospects]; });
  closeModal('modal-import-prospects');
  renderProspects();
  toast(`${prospects.length} imported${dupes ? ', ' + dupes + ' duplicates skipped' : ''}${skipped ? ', ' + skipped + ' invalid rows' : ''}`);
}

// ── Sample Tracking ─────────────────────────────────────────
let _logSampleCtx = null;

function openLogSampleModal(type, id) {
  _logSampleCtx = { type, id };
  if (qs('#lsmp-date'))    qs('#lsmp-date').value    = today();
  if (qs('#lsmp-followup')) qs('#lsmp-followup').value = '';
  if (qs('#lsmp-qty'))     qs('#lsmp-qty').value      = '';
  if (qs('#lsmp-contact')) qs('#lsmp-contact').value  = '';
  if (qs('#lsmp-notes'))   qs('#lsmp-notes').value    = '';
  // Populate SKU dropdown from purpl SKUs
  const skuSel = qs('#lsmp-sku');
  if (skuSel) {
    skuSel.innerHTML = `<option value="">— select SKU —</option>` +
      SKUS.map(s => `<option value="${s.id}">${escHtml(s.label)}</option>`).join('');
  }
  openModal('modal-log-sample');
}

function saveLogSample() {
  if (!_logSampleCtx) return;
  const { type, id } = _logSampleCtx;
  const sample = {
    id: uid(),
    date:         qs('#lsmp-date')?.value        || today(),
    sku:          qs('#lsmp-sku')?.value?.trim()  || '',
    qty:          parseInt(qs('#lsmp-qty')?.value) || null,
    contact:      qs('#lsmp-contact')?.value?.trim() || '',
    notes:        qs('#lsmp-notes')?.value?.trim()   || '',
    followUpDate: qs('#lsmp-followup')?.value    || '',
    followUpDone: false,
  };
  const col = type === 'pr' ? 'pr' : 'ac';
  DB.update(col, id, r => ({ ...r, samples: [...(r.samples || []), sample] }));
  closeModal('modal-log-sample');
  if (type === 'pr') renderProspects();
  else openAccount(id);
  toast('Sample logged');
}

async function pushSampleToShipStation(accountId) {
  const ac = DB.a('ac').find(a => a.id === accountId);
  if (!ac) { toast('Account not found'); return; }
  if (!ac.address && !ac.shipAddress) { toast('No address on file — add one first'); return; }
  const addr = _parseAddress(ac.shipAddress || ac.address || '');
  const ss = DB.obj('shipstation_settings', {});
  const sampleNum = 'SAMPLE-' + (ac.name || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toUpperCase() + '-' + Date.now().toString(36).slice(-4);

  toast('Pushing sample to ShipStation…');
  try {
    const fn = firebase.functions().httpsCallable('pushToShipStation');
    const result = await fn({
      invoiceNumber: sampleNum,
      accountName: ac.name || '',
      customerEmail: ac.email || '',
      brand: 'purpl',
      storeId: ss.storeId || null,
      notes: 'SAMPLE BOX — 3 cans Classic Lavender Lemonade',
      shipTo: { name: ac.name || '', ...addr, phone: ac.phone || '' },
      items: [{ sku: 'classic-sample', name: 'Sample Box — Classic Lavender Lemonade', quantity: 3, unitPrice: 0 }],
    });
    const d = result.data || {};
    if (d.ok) {
      const sample = {
        id: uid(), date: today(), sku: 'classic', qty: 3,
        contact: '', notes: 'Sample box pushed to ShipStation: ' + sampleNum,
        followUpDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
        followUpDone: false, shipStationOrderId: d.orderId, sampleOrderNumber: sampleNum,
        type: 'sample_box',
      };
      DB.update('ac', accountId, r => ({ ...r, samples: [...(r.samples || []), sample] }));
      auditLog('sample_push', 'account', accountId, ac.name, { shipStationOrderId: d.orderId, sampleNum });
      toast('Sample pushed to ShipStation ✓ — ' + sampleNum);
      openAccount(accountId);
    } else {
      _stickyError('Sample push failed: ' + (d.error || 'unknown'));
    }
  } catch (e) {
    _stickyError('Sample push failed: ' + (e?.message || 'unknown'));
  }
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
  if (!_requireAdmin('delete prospects')) return;
  if (!confirm2('Permanently delete this prospect? This cannot be undone.')) return;
  const prospectId = _markLostId;
  const prospectName = DB.a('pr').find(p => p.id === prospectId)?.name || prospectId;
  auditLog('delete', 'prospect', prospectId, prospectName);
  DB.remove('pr', prospectId);
  try {
    firebase.firestore().collection('prospects').doc(prospectId).delete().catch(() => {});
  } catch(e) {}
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
  draft:   {label:'Draft',   cls:'gray'},
  sent:    {label:'Sent',    cls:'blue'},
  paid:    {label:'Paid',    cls:'green'},
  void:    {label:'Void',    cls:'red'},
  unpaid:  {label:'Unpaid',  cls:'amber'},
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
  const outstanding = allInvs.filter(i=>!['paid','draft','void'].includes(i.status));
  const outstandingVal = outstanding.reduce((s,i)=>s+(i.total||0),0);

  // Cases moved this month (sum dist_pos cases where dateReceived >= first of month)
  const now = new Date();
  const fom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  const casesThisMonth = allPOs
    .filter(p=>p.dateReceived&&p.dateReceived>=fom&&p.status!=='cancelled')
    .reduce((s,p)=>{
      const c = (p.items||[]).reduce((a,i)=>a+(parseInt(i.cases)||parseInt(i.qty)||0),0);
      return s + (c || parseInt(p.totalCases)||0);
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
  const invs   = DB.a('dist_invoices').filter(i=>i.distId===d.id&&!['paid','draft','void'].includes(i.status));
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
          ${brandBadges}
        </div>
        <div class="ac-card-sub">${(d.statesCovered||[]).length ? d.statesCovered.join(', ') + ' · ' : ''}${d.territory||'No territory set'}</div>
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
  const distInvs = DB.a('dist_invoices').filter(i=>i.distId===d.id&&!['paid','draft','void'].includes(i.status));
  const outstandingInvVal = distInvs.reduce((s,i)=>s+(i.total||0),0);
  const recentPO = DB.a('dist_pos').filter(p=>p.distId===d.id).sort((a,b)=>b.dateReceived>a.dateReceived?1:-1)[0];
  const outreach = (d.outreach||[]).slice().sort((a,b)=>b.date>a.date?1:-1);
  const lastContact = outreach[0]?.date || d.lastContacted || null;
  const staleAccounts = linkedAccounts.filter(a=>a.status!=='pending'&&daysAgo(a.lastOrder)>=30);

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
  <div style="margin-bottom:12px"><span style="font-size:11px;color:var(--muted)">Territory</span><div style="margin-top:4px">${escHtml(d.territory||'—')}</div>${(d.statesCovered||[]).length ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap">${d.statesCovered.map(s=>`<span class="badge gray" style="font-size:10px">${escHtml(s)}</span>`).join('')}</div>` : ''}${d.radiusType ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">${d.territoryRadiusMiles||0} mi ${d.radiusType==='driving'?'driving':'straight-line'} from DC</div>` : ''}</div>
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
          ${r.phone?`📞 ${escHtml(r.phone)} &nbsp;`:''}
          ${r.email?`✉ ${escHtml(r.email)}`:''}
        </div>
        ${r.lastContacted?`<div style="font-size:11px;color:var(--muted);margin-top:2px">Last contacted: ${fmtD(r.lastContacted)}</div>`:''}
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        ${r.email?`<a href="mailto:${escHtml(r.email)}?subject=purpl%20Beverages" class="btn xs">✉ Gmail</a>`:''}
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
  const totalOutstanding = invs.filter(i=>!['paid','draft','void'].includes(i.status)).reduce((s,i)=>s+(i.total||0),0);
  const statusMap = {draft:'gray', sent:'blue', paid:'green', void:'red'};

  const rows = invs.map(inv=>`<tr>
    <td><a href="#" onclick="editDistInvoice('${inv.id}');return false" style="color:var(--purple);text-decoration:none;font-weight:500">${escHtml(inv.invoiceNumber||'—')}</a></td>
    <td>${fmtD(inv.dateIssued)}</td>
    <td>${inv.dueDate?fmtD(inv.dueDate):'—'}</td>
    <td>${fmtC(inv.total||0)}</td>
    <td><span class="badge ${statusMap[inv.status]||'amber'}">${inv.status||'draft'}</span></td>
    <td>${inv.externalRef?`<small style="color:var(--lavblue)">${escHtml(inv.externalRef)}</small>`:'—'}</td>
    <td>
      ${inv.status!=='paid'?`<button class="btn xs green" onclick="markDistInvoicePaid('${inv.id}','${d.id}')">✓ Paid</button>`:''}
      <button class="btn xs" onclick="editDistInvoice('${inv.id}')">Edit</button>
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
        ${c.notes?`<div style="font-size:12px;color:var(--muted)">${escHtml(c.notes)}</div>`:''}
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

let _distShipInFlight = false;
function saveDistShipment() {
  if (_distShipInFlight) return;
  _distShipInFlight = true;
  setTimeout(() => { _distShipInFlight = false; }, 2000);
  const distId  = qs('#dship-dist-id').value;
  const date    = qs('#dship-date').value || today();
  const poRef   = qs('#dship-po-ref').value.trim();
  const notes   = qs('#dship-notes').value.trim();
  const status  = qs('#dship-status').value;

  const items = SKUS.map(s=>({
    sku: s.id,
    cases: parseInt(qs(`#dship-qty-${s.id}`)?.value)||0
  })).filter(i=>i.cases>0);

  if (!items.length) { _distShipInFlight = false; toast('Add at least one SKU qty'); return; }  // LOW-5

  const totalCases = items.reduce((s,i)=>s+i.cases, 0);
  const totalCans  = totalCases * CANS_PER_CASE;

  // Build batch write: PO record + inventory deductions + stock transfer + dist lastOrder
  const shipId = uid();
  const poId   = uid();

  const dist = DB.a('dist_profiles').find(x=>x.id===distId);

  // Value the shipment from the distributor's price list (was null → showed $0
  // in every PO-value report) so shipment POs count like manually-entered ones.
  const _shipPricing = DB.a('dist_pricing').filter(x=>x.distId===distId);
  const shipmentValue = items.reduce((s,i)=>{
    const pr = _shipPricing.find(x=>x.sku===i.sku);
    return s + (pr?.pricePerCase||0) * i.cases;
  }, 0);

  const poRec = {
    id: poId,
    distId,
    poNumber: poRef || `SHIP-${date}`,
    dateReceived: date,
    expectedShipDate: date,
    items,
    totalCases,
    totalValue: shipmentValue,
    status,
    notes,
    isShipment: true,
    shipId, // links this PO to its iv deductions (ref: shipId) so delete can reverse them
  };

  // LOW-4: write the PO record, the per-SKU iv deductions, and the distributor
  // lastOrderDate as ONE atomic batch — previously three separate DB calls,
  // so a partial failure could leave a PO without deductions (or vice versa).
  // (LOW-7: the old stock_transfers write was dead and is dropped.)
  // (MED-6: distributor readers use lastOrderDate, not lastOrder.)
  DB.atomicUpdate(cache => {
    cache.dist_pos = [...(cache.dist_pos||[]), poRec];
    const ivEntries = items.map(item => ({
      id: uid(),
      sku: item.sku,
      type: 'out',
      qty: item.cases * CANS_PER_CASE,
      date,
      pool: 'warehouse',
      source: 'dist_shipment',
      ref: shipId,
      note: `Shipment to ${dist?.name||'distributor'}${poRef?' — '+poRef:''}`,
    }));
    cache.iv = [...(cache.iv||[]), ...ivEntries];
    const di = (cache.dist_profiles||[]).findIndex(x => x.id === distId);
    if (di >= 0) cache.dist_profiles[di] = { ...cache.dist_profiles[di], lastOrderDate: date };
  });

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
  if (qs('#edist-platform')) qs('#edist-platform').value = d.platformType||'other';
  qs('#edist-territory').value     = d.territory||'';
  qs('#edist-dc-address').value    = d.dcAddress||'';
  if (qs('#edist-territory-radius')) qs('#edist-territory-radius').value = d.territoryRadiusMiles||'';
  if (qs('#edist-radius-type')) qs('#edist-radius-type').value = d.radiusType||'straight';
  // States checkboxes
  const coveredStates = d.statesCovered || [];
  document.querySelectorAll('.edist-state-cb').forEach(cb => {
    cb.checked = coveredStates.includes(cb.value);
  });
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
  if (delBtn) { delBtn.style.display = (!isNew && _isAdmin()) ? '' : 'none'; delBtn.onclick=()=>deleteDistributor(d.id); }
  qs('#edist-save-btn').onclick = _once(()=>saveDistributor(d.id, isNew));
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
    // Preserve ALL existing fields first — avoids data loss on save
    ...(existing||{}),
    id, name,
    platformType:      qs('#edist-platform')?.value||'other',
    territory:         qs('#edist-territory')?.value?.trim()||'',
    dcAddress,
    dcLat, dcLng,
    territoryRadiusMiles: (v=>isNaN(v)||v<=0?0:v)(parseInt(qs('#edist-territory-radius')?.value)),
    radiusType:          qs('#edist-radius-type')?.value||'straight',
    statesCovered:       Array.from(document.querySelectorAll('.edist-state-cb:checked')).map(cb=>cb.value),
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
  if (!_requireAdmin('delete distributors')) return;
  if (!confirm2('Delete this distributor? This will also remove all associated reps, pricing, POs, and invoices.')) return;
  const distName = DB.a('dist_profiles').find(x => x.id === id)?.name || id;
  auditLog('delete', 'distributor', id, distName);
  DB.atomicUpdate(cache => {
    cache['dist_profiles'] = (cache['dist_profiles']||[]).filter(r=>r.id!==id);
    ['dist_reps','dist_pricing','dist_pos','dist_invoices','dist_chains','dist_imports'].forEach(k=>{
      cache[k] = (cache[k]||[]).filter(r=>r.distId!==id);
    });
    // Clear fulfilledBy on any accounts linked to this distributor
    cache['ac'] = (cache['ac']||[]).map(a =>
      a.fulfilledBy === id ? {...a, fulfilledBy: 'direct'} : a
    );
  });
  closeModal('modal-edit-distributor');
  renderDistributors();
  toast('Distributor deleted — linked accounts reverted to direct');
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
  const existing = isNew ? null : DB.a('dist_reps').find(x => x.id === repId);
  const rec = {
    ...(existing||{}),
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
  const po = DB.a('dist_pos').find(x => x.id === poId);
  // Shipment POs wrote warehouse deductions keyed ref:shipId — deleting the PO
  // without reversing them left the ledger permanently short (delete+re-log
  // double-deducted). Reverse them atomically with the PO removal.
  const canReverse = !!(po && po.isShipment && po.shipId);
  const msg = canReverse
    ? 'Delete this shipment PO? Its inventory deductions will be reversed.'
    : (po && po.isShipment
        ? 'Delete this shipment PO? NOTE: it predates deduction linking — its inventory deductions cannot be auto-reversed; adjust stock manually if you re-log it.'
        : 'Delete this PO?');
  if (!confirm2(msg)) return;
  DB.atomicUpdate(cache => {
    cache.dist_pos = (cache.dist_pos||[]).filter(x => x.id !== poId);
    if (canReverse) {
      cache.iv = (cache.iv||[]).filter(e => !(e.source === 'dist_shipment' && e.ref === po.shipId));
    }
  });
  const d = DB.a('dist_profiles').find(x=>x.id===distId);
  const pane = qs('#mdist-tab-orders');
  if (d&&pane) pane.innerHTML = renderDistOrdersHTML(d);
  toast(canReverse ? 'PO deleted — inventory restored ✓' : 'PO deleted');
}

// ── Invoices ──────────────────────────────────────────────
function pickDistForInvoice() {
  const dists = DB.a('dist_profiles').filter(d => d.status === 'active');
  if (!dists.length) { toast('No active distributors'); return; }
  if (dists.length === 1) { addDistInvoice(dists[0].id); return; }
  const names = dists.map((d, i) => `${i + 1}. ${d.name}`).join('\n');
  const pick = prompt('Select distributor:\n' + names);
  const idx = parseInt(pick) - 1;
  if (idx >= 0 && idx < dists.length) addDistInvoice(dists[idx].id);
}
function addDistInvoice(distId) { _openDistInvModal(distId); }
function addDistInvoiceInModal(distId) { closeModal('modal-distributor'); _openDistInvModal(distId); }

function _openDistInvModal(distId, existingId) {
  const existing = existingId ? DB.a('dist_invoices').find(x => x.id === existingId) : null;
  const isNew = !existing;
  const titleEl = qs('#mdinv-title');
  if (titleEl) titleEl.textContent = isNew ? 'New Distributor Invoice' : 'Edit Distributor Invoice';

  // Populate distributor dropdown
  const sel = qs('#mdinv-dist-sel');
  if (sel) {
    sel.innerHTML = '<option value="">Select distributor...</option>' +
      DB.a('dist_profiles').map(d => `<option value="${d.id}">${escHtml(d.name)}</option>`).join('');
    sel.value = distId || existing?.distId || '';
    sel.onchange = () => _mdinvUpdateDueDate();
  }

  const el = qs('#mdinv-sku-inputs');
  if (el) el.innerHTML = SKUS.map(s => `
    <div class="sku-row inv-sku-row ${s.bg}">
      ${skuBadge(s.id)}
      <div class="inv-sku-inputs">
        <input type="number" id="mdinv-cases-${s.id}" min="0" step="1" placeholder="0" class="inv-qty-input"
          value="${existing ? (existing.items?.find(i => i.sku === s.id)?.cases || '') : ''}">
        <span class="inv-line-unit">cases</span>
      </div>
    </div>`).join('');

  qs('#mdinv-number').value  = existing?.invoiceNumber || peekNextInvoiceNumber();
  qs('#mdinv-date').value    = existing?.dateIssued || today();
  qs('#mdinv-po-ref').value  = existing?.poRef || '';
  qs('#mdinv-ext-ref').value = existing?.externalRef || '';
  qs('#mdinv-status').value  = existing?.status || 'draft';
  qs('#mdinv-notes').value   = existing?.notes || '';

  _mdinvUpdateDueDate(existing?.dueDate);

  qs('#mdinv-save-btn').onclick = _once(() => saveDistInvoice(existingId));
  const delBtn = qs('#mdinv-delete-btn');
  if (delBtn) {
    delBtn.style.display = (!isNew && _isAdmin()) ? '' : 'none';
    delBtn.onclick = () => deleteDistInvoice(existingId);
  }
  openModal('modal-add-dist-invoice');
}

function _mdinvUpdateDueDate(override) {
  if (override) { qs('#mdinv-due').value = override; return; }
  const distId = qs('#mdinv-dist-sel')?.value;
  const terms = DB.a('dist_profiles').find(x => x.id === distId)?.paymentTermsDays || 30;
  qs('#mdinv-due').value = new Date(Date.now() + terms * 864e5).toISOString().slice(0, 10);
}

function editDistInvoice(invId) {
  const inv = DB.a('dist_invoices').find(x => x.id === invId);
  if (!inv) return;
  _openDistInvModal(inv.distId, invId);
}

async function saveDistInvoice(existingId) {
  const distId = qs('#mdinv-dist-sel')?.value;
  if (!distId) { toast('Select a distributor'); return; }
  const date = qs('#mdinv-date')?.value;
  if (!date) { toast('Date required'); return; }

  const userNum = qs('#mdinv-number')?.value?.trim();
  const invNum = userNum || await getNextInvoiceNumber('dist');

  const pricing = DB.a('dist_pricing').filter(p => p.distId === distId);
  // On EDIT, keep each line's ORIGINAL price — repricing from current
  // dist_pricing silently rewrote an old invoice's total (even a notes-only
  // save) at today's rates. Current pricing applies to new invoices/lines only.
  const _existingItems = existingId ? ((DB.a('dist_invoices').find(x => x.id === existingId) || {}).items || []) : [];
  const _unpriced = [];
  const items = SKUS.map(s => {
    const cases = parseInt(qs('#mdinv-cases-' + s.id)?.value) || 0;
    const stored = _existingItems.find(i => i.sku === s.id);
    const listPrice = parseFloat(pricing.find(p => p.sku === s.id)?.pricePerCase);
    const ppc = (stored && stored.pricePerCase > 0) ? stored.pricePerCase : (isNaN(listPrice) ? 0 : listPrice);
    if (cases > 0 && !(ppc > 0)) _unpriced.push(s.label || s.id);
    return { sku: s.id, cases, pricePerCase: ppc };
  }).filter(i => i.cases > 0);
  if (!items.length) { toast('Enter at least one SKU quantity'); return; }
  // A $0 line means no dist_pricing row exists — say so instead of silently billing $0.
  if (_unpriced.length && !confirm2(`No distributor price set for: ${_unpriced.join(', ')} — those lines will bill at $0. Save anyway? (Set prices in the distributor Pricing tab.)`)) return;

  const total = items.reduce((s, i) => s + i.cases * i.pricePerCase, 0);
  const dist = DB.a('dist_profiles').find(x => x.id === distId);

  const rec = {
    ...(existingId ? (DB.a('dist_invoices').find(x => x.id === existingId) || {}) : {}),
    id: existingId || uid(),
    distId,
    distName: dist?.name || '',
    invoiceNumber: invNum,
    number: invNum,
    dateIssued: date,
    dueDate: qs('#mdinv-due')?.value || '',
    poRef: qs('#mdinv-po-ref')?.value?.trim() || '',
    externalRef: qs('#mdinv-ext-ref')?.value?.trim() || '',
    items, total,
    status: qs('#mdinv-status')?.value || 'draft',
    notes: qs('#mdinv-notes')?.value?.trim() || '',
  };

  if (existingId) DB.update('dist_invoices', existingId, () => rec);
  else DB.push('dist_invoices', rec);

  closeModal('modal-add-dist-invoice');
  if (_currentDistId) openDistributor(_currentDistId);
  if (currentPage === 'invoices') renderInvoicesPage();
  renderDistributors();
  toast(`Invoice ${invNum} saved ✓`);
}

function markDistInvoicePaid(invId, distId) {
  DB.update('dist_invoices', invId, i => ({ ...i, status: 'paid', paidDate: today(), paidAt: new Date().toISOString() }));
  if (currentPage === 'invoices') renderInvoicesPage();
  const d = DB.a('dist_profiles').find(x => x.id === distId);
  const pane = qs('#mdist-tab-invoices');
  if (d && pane) pane.innerHTML = renderDistInvoicesHTML(d);
  if (qs('#inv-col-dist')) renderInvColDist();
  toast('Marked as paid');
}

function deleteDistInvoice(invId) {
  if (!_requireAdmin('delete invoices')) return;
  if (!confirm2('Delete this invoice?')) return;
  const inv = DB.a('dist_invoices').find(x => x.id === invId);
  auditLog('delete', 'dist_invoice', invId, inv?.invoiceNumber || invId);
  DB.atomicUpdate(cache => {
    cache['dist_invoices'] = (cache['dist_invoices']||[]).filter(x => x.id !== invId);
    cache['iv'] = (cache['iv']||[]).filter(e => !(e.invoiceId === invId && e.type === 'out'));
  });
  closeModal('modal-add-dist-invoice');
  if (_currentDistId) openDistributor(_currentDistId);
  if (currentPage === 'invoices') renderInvoicesPage();
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
  // Strip UTF-8 BOM that Excel/Windows adds to saved CSVs
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return [];
  function parseRow(line) {
    const cols = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i+1] === '"') { cur += '"'; i++; continue; }
        inQ = !inQ; continue;
      }
      if (c === ',' && !inQ) { cols.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    cols.push(cur.trim());
    return cols;
  }
  const headers = parseRow(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseRow(line);
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] || '']));
  }).filter(r => Object.values(r).some(v => v));
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
  const outstandingInvs = DB.a('dist_invoices').filter(i=>!['paid','draft','void'].includes(i.status));
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
    const totalPacks = SKUS.reduce((s,sk) => s + _onHand(sk.id, null), 0);
    const whTotal = SKUS.reduce((s,sk) => s + _onHand(sk.id, 'warehouse'), 0);
    const farmTotal = SKUS.reduce((s,sk) => s + _onHand(sk.id, 'farm'), 0);
    const totalLoose = SKUS.reduce((s,sk)=>s+loose.filter(l=>l.sku===sk.id).reduce((t,l)=>t+l.qty,0),0);
    const activePallets = pallets.filter(p=>p.status==='ready').length;
    const totalVal = SKUS.reduce((s,sk) => s + _onHand(sk.id, null) * (costs.cogs[sk.id]||2.15), 0);
    cards.innerHTML = `
      <div>${kpiHtml('Total Stock', fmt(totalPacks)+' cans', 'green')}</div>
      <div>${kpiHtml('Warehouse', fmt(whTotal)+' cans', 'blue')}</div>
      <div>${kpiHtml('Farm', fmt(farmTotal)+' cans', 'purple')}</div>
      <div>${kpiHtml('Stock Value (COGS)', fmtC(totalVal), 'amber')}</div>`;
    // Surface hidden negative pools (deduction from an empty pool) — clamping
    // silently made Warehouse + Farm stop summing to Total with no indicator.
    const negs = [];
    SKUS.forEach(sk => ['warehouse','farm'].forEach(p => {
      const raw = _onHandRaw(sk.id, p);
      if (raw < 0) negs.push(`${sk.label || sk.id} @ ${p}: ${raw} cans`);
    }));
    let negEl = document.getElementById('inv-neg-warning');
    if (negs.length) {
      if (!negEl) {
        negEl = document.createElement('div');
        negEl.id = 'inv-neg-warning';
        negEl.style.cssText = 'margin:10px 0;padding:10px 14px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;color:#991b1b';
        cards.parentNode.insertBefore(negEl, cards.nextSibling);
      }
      negEl.innerHTML = `⚠️ <strong>Pool over-deducted</strong> — more was taken from a pool than it held, so pool cards won't sum to Total Stock. Fix with a stock transfer or adjustment: ${negs.map(escHtml).join(' · ')}`;
    } else if (negEl) negEl.remove();
  }

  const el = qs('#inv-table-body');
  if (!el) return;
  el.innerHTML = SKUS.map(s=>{
    const total    = _onHand(s.id, null);
    const whStock  = _onHand(s.id, 'warehouse');
    const farmStock= _onHand(s.id, 'farm');
    const looseCt  = loose.filter(l=>l.sku===s.id).reduce((t,l)=>t+l.qty,0);
    const palletCt = pallets.filter(p=>p.status==='ready').reduce((t,p)=>t+(p.contents?.[s.id]||0),0);
    const val      = total*(costs.cogs[s.id]||2.15);
    const status   = total<24?{label:'Critical',cls:'red'}:total<48?{label:'Low',cls:'amber'}:{label:'OK',cls:'green'};
    return `<tr>
      <td>${skuBadge(s.id)}</td>
      <td>${fmt(whStock)}</td>
      <td>${fmt(farmStock)}</td>
      <td><strong>${fmt(total)}</strong></td>
      <td>${fmt(looseCt)}</td>
      <td>${fmt(palletCt)}</td>
      <td>${fmtC(val)}</td>
      <td><span class="badge ${status.cls}">${status.label}</span></td>
      <td>
        <button class="btn xs primary" onclick="invAdjust('${s.id}','in')">+ Add</button>
        <button class="btn xs" onclick="invAdjust('${s.id}','out')">- Use</button>
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
  if (!DB._firestoreReady) return;
  const sku = qs('#recv-loose-sku')?.value;
  const qty = parseInt(qs('#recv-loose-qty')?.value);
  if (!sku) { toast('Select a SKU'); return; }
  if (!qty||qty<=0) { toast('Enter a valid quantity'); return; }
  DB.push('loose_cans', {id:uid(), date:today(), sku, qty, source:qs('#recv-loose-source')?.value?.trim()||'', note:qs('#recv-loose-note')?.value?.trim()||''});
  qs('#recv-loose-qty').value=''; qs('#recv-loose-source').value=''; qs('#recv-loose-note').value='';
  _invReceive();
  toast('Loose cans logged');
}

let _recvPacksInFlight = false;
function receiveFinishedPacks() {
  if (!DB._firestoreReady) return;
  if (_recvPacksInFlight) return;
  _recvPacksInFlight = true;
  setTimeout(() => { _recvPacksInFlight = false; }, 2000);
  const sku = qs('#recv-pack-sku')?.value;
  const qty = parseInt(qs('#recv-pack-qty')?.value);
  const packType = qs('#recv-pack-type')?.value||'6pack';
  if (!sku) { _recvPacksInFlight = false; toast('Select a SKU'); return; }  // LOW-5
  if (!qty||qty<=0) { _recvPacksInFlight = false; toast('Enter a valid quantity'); return; }  // LOW-5
  const recvPool = qs('#recv-pack-pool')?.value || 'warehouse';
  // The ledger is CANS. qty is the number of PACKS (per the pack-type
  // selector) — it was pushed raw, so receiving 8 six-packs added 8 cans.
  const _packSize = ({'6pack':6, '12pack':12, '24pack':24, 'single':1})[packType] || 1;
  const cans = qty * _packSize;
  DB.push('iv', {id:uid(), date:today(), sku, type:'in', qty: cans, pool: recvPool, note:`${qty} × ${packType} = ${cans} cans — ${qs('#recv-pack-note')?.value?.trim()||''}`});
  qs('#recv-pack-qty').value=''; qs('#recv-pack-note').value='';
  _invReceive();
  toast('Finished packs logged');
}

function delLooseCan(id, form) {
  if (!DB._firestoreReady) return;
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
      <td>${skuBadge(j.outputSku)} ×${j.outputQty} cans</td>
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
  qs('#repack-save-btn').onclick = _once(saveRepackJob);
  openModal('modal-repack');
}

let _repackInFlight = false;
function saveRepackJob() {
  if (_repackInFlight) return;
  _repackInFlight = true;
  setTimeout(() => { _repackInFlight = false; }, 2000);
  const date = qs('#repack-date')?.value || today();
  const outSku = qs('#repack-out-sku')?.value;
  const outQty = parseInt(qs('#repack-out-qty')?.value);
  if (!outSku||!outQty||outQty<=0) { _repackInFlight = false; toast('Output SKU and quantity required'); return; }  // LOW-5
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
  // Add to finished packs inventory (tagged with repackId so deletion can reverse it)
  DB.push('iv', {id:uid(), date, sku:outSku, type:'in', qty:outQty, pool:'warehouse', repackId: job.id, note:`Repack job — ${Object.entries(inputs).map(([s,q])=>`${q} ${s}`).join(', ')}`});
  closeModal('modal-repack');
  _invRepack();
  toast('Repack job saved');
}

function deleteRepackJob(id) {
  if (!_requireAdmin('delete repack jobs')) return;
  if (!confirm2('Delete this repack job? Its finished-pack inventory entry will be reversed. (Consumed loose cans are not restored.)')) return;
  auditLog('delete', 'repack_job', id, '');
  DB.atomicUpdate(cache => {
    cache['repack_jobs'] = (cache['repack_jobs']||[]).filter(x => x.id !== id);
    cache['iv'] = (cache['iv']||[]).filter(e => e.repackId !== id);
  });
  _invRepack();
  toast('Job deleted · inventory reversed');
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
        <input type="number" class="input pallet-sku-input" data-sku="${s.id}" min="0" placeholder="0 cases" value="${p.contents?.[s.id]||''}" style="width:100%">
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
  const p = DB.a('pallets').find(x=>x.id===palletId);
  if (!p || p.status === 'shipped') { toast('Already shipped'); return; }
  const dest = prompt('Ship to (distributor / account):') || '';
  const shipDate = prompt('Ship date (YYYY-MM-DD):', today()) || today();
  DB.update('pallets', palletId, p=>({...p, status:'shipped', shipTo:dest||p.shipTo, shipDate}));
  // Pallet contents are entered in CASES; the iv ledger is in cans
  Object.entries(p?.contents||{}).forEach(([sku,cases])=>{
    DB.push('iv', {id:uid(), date:shipDate, sku, type:'out', qty: cases * CANS_PER_CASE, pool:'warehouse', palletId, note:`Pallet ${p.label||palletId} shipped to ${dest||p.shipTo}`});
  });
  _invPallets();
  toast('Pallet marked as shipped');
}

function deletePallet(palletId) {
  if (!_requireAdmin('delete pallets')) return;
  if (!confirm2('Delete this pallet record? Inventory deductions from shipping it will be reversed.')) return;
  const p = DB.a('pallets').find(x => x.id === palletId);
  auditLog('delete', 'pallet', palletId, p?.label || palletId);
  DB.atomicUpdate(cache => {
    cache['pallets'] = (cache['pallets']||[]).filter(x => x.id !== palletId);
    cache['iv'] = (cache['iv']||[]).filter(e => e.palletId !== palletId);
  });
  _invPallets();
  toast('Pallet deleted · inventory reversed');
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

let _saveReturnInFlight = false;
function saveReturn() {
  const accountId = qs('#ret-account')?.value;
  const skuId     = qs('#ret-sku')?.value;
  const cans      = parseInt(qs('#ret-cans')?.value)||0;
  if (!accountId) { toast('Select an account'); return; }
  if (!skuId)     { toast('Select a SKU'); return; }
  if (cans <= 0)  { toast('Enter number of cans'); return; }
  // HIGH-6: block double-click — two return entries inflate on-hand 2x.
  // Guarded AFTER validation so a failed validation doesn't lock the form.
  if (_saveReturnInFlight) return;
  _saveReturnInFlight = true;
  setTimeout(() => { _saveReturnInFlight = false; }, 2000);

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
  const returnPool = qs('#ret-pool')?.value || 'warehouse';
  const ivEntry = {
    id: uid(), date, sku: skuId,
    type: 'return', qty: cans,
    pool: returnPool,
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
  if (!DB._firestoreReady) return;
  const skuVal = sku || prompt('SKU (classic/blueberry/peach/variety):');
  if (!skuVal || !SKU_MAP[skuVal]) { if(skuVal) toast('Unknown SKU'); return; }
  const qty = parseInt(prompt(`Enter quantity to ${type==='in'?'receive':'use'} for ${SKU_MAP[skuVal]?.label}:`));
  if (!qty || qty <= 0) return;
  const note = prompt('Note (optional):') || '';
  const pool = qs('#inv-adj-pool')?.value || 'warehouse';
  DB.push('iv', {id:uid(), date:today(), sku:skuVal, type, qty, pool, note});
  _invSummary();
  toast('Inventory updated');
}

function delInvEntry(id) {
  if (!confirm2('Remove this entry?')) return;
  DB.remove('iv', id);
  _invLog();
  toast('Entry removed');
}

// ── Pool Transfers ────────────────────────────────────────
function _invLocations() {
  const skuEl = qs('#pool-xfer-sku');
  if (skuEl) skuEl.innerHTML = SKUS.map(s => `<option value="${s.id}">${s.label}</option>`).join('');
}

const _poolTransferInFlight = new Set();
function poolTransfer() {
  const dir  = qs('#pool-xfer-dir')?.value || 'wh-farm';
  const sku  = qs('#pool-xfer-sku')?.value;
  const qty  = parseInt(qs('#pool-xfer-qty')?.value || '0');
  const note = (qs('#pool-xfer-note')?.value || '').trim();
  if (!sku || !qty || qty < 1) { toast('Select SKU and enter quantity'); return; }
  const key = `${sku}-${qty}-${dir}`;
  if (_poolTransferInFlight.has(key)) return;
  _poolTransferInFlight.add(key);
  const fromPool = dir === 'wh-farm' ? 'warehouse' : 'farm';
  const toPool   = dir === 'wh-farm' ? 'farm' : 'warehouse';
  const available = _onHand(sku, fromPool);
  if (qty > available) {
    _poolTransferInFlight.delete(key);
    toast(`Not enough stock — ${fromPool} has ${available} cans of ${SKU_MAP[sku]?.label || sku}`);
    return;
  }
  const xferId = uid();
  DB.atomicUpdate(cache => {
    cache.iv = [...(cache.iv || []),
      { id: uid(), date: today(), sku, type: 'out', qty, pool: fromPool, note: `Transfer to ${toPool}${note ? ' — ' + note : ''}`, transferId: xferId },
      { id: uid(), date: today(), sku, type: 'in',  qty, pool: toPool,   note: `Transfer from ${fromPool}${note ? ' — ' + note : ''}`, transferId: xferId },
    ];
  });
  _poolTransferInFlight.delete(key);
  qs('#pool-xfer-qty').value = '';
  qs('#pool-xfer-note').value = '';
  renderInventory();
  toast(`Transferred ${qty} cans ${fromPool} → ${toPool}`);
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
let _ordFulfillFilter = 'all';
function setOrdFulfillFilter(mode) {
  _ordFulfillFilter = mode;
  qs('#orders-fulfill-filter')?.querySelectorAll('[data-fulfill]')
    .forEach(b => b.classList.toggle('active', b.dataset.fulfill === mode));
  renderOrders();
}

function renderOrders() {
  // Index accounts + distributors once (avoids a per-row .find = O(n^2)).
  const acById   = new Map(DB.a('ac').map(a=>[a.id,a]));
  const distById = new Map(DB.a('dist_profiles').map(d=>[d.id,d]));
  const _isDist  = o => { const ac = acById.get(o.accountId); return !!(ac && ac.fulfilledBy && ac.fulfilledBy !== 'direct'); };

  let list = DB.a('orders').slice().sort((a,b)=>b.created>a.created?1:-1);
  if (ordFilter !== 'all') list = list.filter(o=>o.status===ordFilter);
  // Fulfillment filter: 'direct' = orders you deliver, 'dist' = a distributor does.
  if (_ordFulfillFilter === 'direct') list = list.filter(o=>!_isDist(o));
  else if (_ordFulfillFilter === 'dist') list = list.filter(o=>_isDist(o));

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
    const ac2 = acById.get(o.accountId);
    const isOverdue = o.status==='pending' && o.dueDate < today();
    const srcBadge  = SOURCE_BADGE[o.source] || '';
    // Mark orders fulfilled by a distributor (not delivered by you).
    const fb = ac2?.fulfilledBy;
    const distName = (fb && fb !== 'direct') ? (distById.get(fb)?.name || 'Distributor') : '';
    const fulfillBadge = distName
      ? `<span class="badge amber" style="font-size:10px" title="Fulfilled by ${escHtml(distName)} — not your delivery">🚚 via ${escHtml(distName)}</span>`
      : '';
    // qty in items is CASES; show with 'cs' label
    return `<tr class="${isOverdue?'overdue-row':''}">
      <td>${fmtD(o.created)}</td>
      <td>${ac2?.name||'Unknown'} ${srcBadge} ${fulfillBadge}</td>
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
  qs('#nord-save-btn').onclick = _once(saveNewOrder);
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
  const acName = DB.a('ac').find(x=>x.id===accountId)?.name || accountId;
  auditLog('create', 'order', ord.id, acName);
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
    const ordAcName = DB.a('ac').find(x=>x.id===o.accountId)?.name || o.accountId;
    DB.a('iv').filter(e=>e.ordId===id).forEach(e=>DB.remove('iv',e.id));
    DB.remove('orders', id);
    if (o.accountId) {
      const remaining = DB.a('orders').filter(x => x.id !== id && x.accountId === o.accountId && x.status !== 'cancelled');
      const newest = remaining.sort((a,b) => (b.created || b.date || '') > (a.created || a.date || '') ? 1 : -1)[0];
      DB.update('ac', o.accountId, a => ({...a, lastOrder: newest?.created || newest?.date || ''}));
    }
    auditLog('delete', 'order', id, ordAcName);
    closeModal('modal-order-detail');
    renderOrders();
    renderInventory();
    renderDash();
    toast('Order removed');
  };
  const modStatusBtn = qs('#mod-status-btn');
  if (modStatusBtn) modStatusBtn.onclick = ()=>{ cycleOrderStatus(id); openOrderDetail(id); };
  const modReschedBtn = qs('#mod-reschedule-btn');
  if (modReschedBtn) modReschedBtn.onclick = ()=>{
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
  // Inventory deduction now happens at invoice creation, not status change
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
        ${s.notes?`<div style="font-size:12px;color:var(--muted);margin-top:6px">${escHtml(s.notes)}</div>`:''}
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

let _prodRunInFlight = false;
function saveTodayRun() {
  if (_prodRunInFlight) return;
  _prodRunInFlight = true;
  setTimeout(() => { _prodRunInFlight = false; }, 2000);
  const items = {};
  SKUS.forEach(s=>{ const v=parseInt(qs('#sched-'+s.id)?.value)||0; if(v>0) items[s.id]=v; });
  if (!Object.keys(items).length) { _prodRunInFlight = false; toast('Enter at least one quantity'); return; }  // LOW-5
  const notes = qs('#sched-notes')?.value?.trim()||'';
  const entry = {id:uid(), date:today(), notes, ...items};
  DB.push('prod_hist', entry);
  // Also update inventory — store prodId so we can clean up on delete
  Object.entries(items).forEach(([sku, qty])=>{
    DB.push('iv', {id:uid(), date:today(), sku, type:'in', qty, pool:'warehouse', note:'Production run', prodId:entry.id});
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
  if (!_requireAdmin('delete production records')) return;
  if (!confirm2('Remove this production record?')) return;
  auditLog('delete', 'prod_hist', id, '');
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
      const ac = _findAccount(null, ship.customer);
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
             || _findAccount(null, s.name);
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
            <div class="delivery-rules-text">${escHtml(rules)}</div>
          </div>` : ''}
          <div style="font-size:12px;color:var(--muted)">${escHtml(s.address||'')}</div>
          <div style="margin-top:6px">${SKUS.map(sk=>s[sk.id]>0?`${skuBadge(sk.id)} ×${s[sk.id]} cs`:'').filter(Boolean).join(' ')}</div>
          ${(s.lfItems||[]).length?`<div style="margin-top:4px;font-size:12px;color:#15803d">🪻 ${(s.lfItems).map(it=>`${escHtml(it.skuName)} ×${it.cases} cs`).join(' · ')}</div>`:''}
          ${s.notes?`<div style="font-size:12px;color:var(--muted);margin-top:4px">${escHtml(s.notes)}</div>`:''}
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

const _stopToggleBusy = new Set();
function toggleStop(i) {
  // Rapid double-click fired create-then-reverse back to back; ignore the
  // second event and re-render so the checkbox re-syncs to real state.
  if (_stopToggleBusy.has(i)) { renderDelivery(); return; }
  _stopToggleBusy.add(i);
  setTimeout(() => _stopToggleBusy.delete(i), 600);
  const run = DB.obj('today_run', {date:today(), stops:[]});
  if (!run.stops[i]) { renderDelivery(); return; }
  const wasDone = run.stops[i].done;
  run.stops[i].done = !wasDone;
  const stop = run.stops[i];

  // Look up account (prefer stored accountId, fallback to name match)
  const ac2 = (stop.accountId ? DB.a('ac').find(a=>a.id===stop.accountId) : null)
            || _findAccount(null, stop.name);

  if (!wasDone && stop.done && !ac2) {
    run.stops[i].done = false;
    DB.setObj('today_run', run);
    renderDelivery();
    toast('Cannot mark done — no matching account for "' + (stop.name||'unknown') + '"');
    return;
  }

  if (!wasDone && stop.done && ac2) {
    const ordItems = SKUS.filter(s=>stop[s.id]>0).map(s=>({sku:s.id, qty:stop[s.id]}));
    const canCount = ordItems.reduce((sum,i)=>sum + i.qty * CANS_PER_CASE, 0);
    const newOrd = {
      id: uid(), accountId: ac2.id, created: today(), dueDate: today(),
      status: 'delivered', source: 'run', items: ordItems, canCount,
      notes: stop.notes||'',
    };
    // Inventory deduction now happens at invoice creation, not delivery

    // Build LF wix deduction record for this stop (if any LF items)
    const stopLfItems = stop.lfItems || [];
    const newWixDeduction = stopLfItems.length ? {
      id: uid(), date: today(),
      runName: (DB.obj('today_run',{}).date || today()) + ' run',
      note: 'Delivery: ' + stop.name,
      items: stopLfItems,
      confirmed: false,
    } : null;

    // Link the created records to THIS stop so un-toggling reverses exactly
    // these — the old account+date matching collided when one account had two
    // stops in a day and could sweep unrelated ledger entries.
    stop.ordId = newOrd.id;
    if (newWixDeduction) stop.wixDeductionId = newWixDeduction.id;

    DB.atomicUpdate(cache => {
      cache['today_run'] = run;
      cache['ac'] = (cache['ac']||[]).map(a => a.id===ac2.id ? {...a, lastOrder:today()} : a);
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

  } else if (wasDone && !stop.done) {
    // Un-toggling from done → reverse the side-effects of THIS stop only.
    const stopOrdId = stop.ordId || null;
    const stopWixId = stop.wixDeductionId || null;
    delete stop.ordId; delete stop.wixDeductionId;
    DB.atomicUpdate(cache => {
      cache['today_run'] = run;
      const acId = ac2?.id || stop.accountId;
      // Prefer the order linked at mark-done; fall back to account+date only
      // for stops marked done before ordId linking existed.
      const deliveryOrd = stopOrdId
        ? (cache['orders']||[]).find(o => o.id === stopOrdId)
        : (cache['orders']||[]).find(o => o.source === 'run' && o.accountId === acId && o.created === today());
      if (deliveryOrd) {
        cache['orders'] = (cache['orders']||[]).filter(o => o.id !== deliveryOrd.id);
        // Remove ONLY the invoice(s) created for this order, and collect their
        // ids — the old cleanup deleted every ledger 'out' whose invoiceId
        // wasn't in retail_invoices, sweeping legacy-invoice deductions too.
        const removedInvIds = new Set();
        cache['retail_invoices'] = (cache['retail_invoices']||[]).filter(inv => {
          const mine = inv.source === 'delivery_run' &&
            (inv.orderId ? inv.orderId === deliveryOrd.id : (inv.accountId === acId && inv.date === today()));
          if (mine) removedInvIds.add(inv.id);
          return !mine;
        });
        cache['iv'] = (cache['iv']||[]).filter(e => !(e.type === 'out' && removedInvIds.has(e.invoiceId)));
      }
      // Drop this stop's unconfirmed Wix pull so no phantom pending deduction lingers
      if (stopWixId) {
        cache['lf_wix_deductions'] = (cache['lf_wix_deductions']||[]).filter(d => !(d.id === stopWixId && !d.confirmed));
      }
    });
    toast('Stop unmarked — order, invoice & inventory reversed');
  } else {
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
  const terms  = DB.obj('settings',{}).default_payment_terms || DB.obj('settings',{}).payment_terms || 30;
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

const _deliveryInvInFlight = new Set();
async function createDeliveryInvoice(accountId, ordId) {
  if (_deliveryInvInFlight.has(ordId)) return;
  _deliveryInvInFlight.add(ordId);
  const ac      = DB.a('ac').find(a=>a.id===accountId);
  const ord     = DB.a('orders').find(o=>o.id===ordId);
  if (!ac || !ord) { _deliveryInvInFlight.delete(ordId); return; }

  const terms   = _payTerms();
  const dueDate = new Date(Date.now() + terms*864e5).toISOString().slice(0,10);
  const invoiceNumber = await getNextInvoiceNumber('purpl');

  const lineItems = (ord.items||[]).map(i=>{
    const pricePerCase = _calcPricePerCase(ac);
    return {sku: i.sku, cases: i.qty, pricePerCase, amount: i.qty * pricePerCase};
  });
  const totalCases = lineItems.reduce((s,l)=>s+l.cases, 0);
  const total      = lineItems.reduce((s,l)=>s+l.amount, 0);
  if (totalCases < 1) { toast('No items to invoice'); _deliveryInvInFlight.delete(ordId); return; }
  const pricePerCase = totalCases > 0 ? total / totalCases : 0;

  const invoice = {
    id: uid(), accountId, orderId: ordId, invoiceNumber,
    date: today(), dueDate, lineItems,
    cases: totalCases, cans: totalCases * CANS_PER_CASE,
    pricePerCase, total,
    status: 'draft', source: 'delivery_run', notes: '',
    deliveryDate: today(),
    accountName: ac.name,
  };

  // Create invoice + deduct inventory in one batch
  DB.atomicUpdate(cache => {
    cache['retail_invoices'] = [...(cache['retail_invoices']||[]), invoice];
    // Deduct inventory for each line item
    const ivEntries = lineItems.map(li => ({
      id: uid(), date: today(), sku: li.sku, type: 'out',
      qty: li.cases * CANS_PER_CASE,
      pool: invoice.fulfillmentSource || 'warehouse',
      note: 'Invoice ' + invoiceNumber, invoiceId: invoice.id,
    }));
    cache['iv'] = [...(cache['iv']||[]), ...ivEntries];
    // Mark order as invoiced
    cache['orders'] = (cache['orders']||[]).map(o =>
      o.id === ordId ? {...o, invoiceStatus:'invoiced', invoiceDate:today(), invoiceNumber} : o
    );
  });

  _deliveryInvInFlight.delete(ordId);
  document.getElementById('del-invoice-offer')?.remove();
  toast(`Invoice ${invoiceNumber} created for ${ac.name}`);
}

// ── After full run — offer batch invoicing ────────────────
function offerBatchInvoice(stops) {
  const existing = document.getElementById('del-batch-invoice-offer');
  if (existing) return; // already showing

  const uninvoiced = stops.filter(s=>{
    if (!s.done) return false;
    const ac = (s.accountId ? DB.a('ac').find(a=>a.id===s.accountId) : null)
             || _findAccount(null, s.name);
    if (!ac) return false;
    const ord = DB.a('orders').find(o=>o.accountId===ac.id&&o.source==='run'&&o.created===today());
    return ord && ord.invoiceStatus !== 'invoiced' && ord.invoiceStatus !== 'paid';
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
             || _findAccount(null, s.name);
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
  const stop = run.stops[i];
  if (stop && stop.done) {
    const acId = stop.accountId || _findAccount(null, stop.name)?.id;
    if (acId) {
      DB.atomicUpdate(cache => {
        const ord = (cache['orders']||[]).find(o => o.source==='run' && o.accountId===acId && o.created===today());
        if (ord) {
          cache['orders'] = (cache['orders']||[]).filter(o => o.id !== ord.id);
          const deletedInvIds = (cache['retail_invoices']||[])
            .filter(inv => inv.source === 'delivery_run' && inv.accountId === acId && inv.date === today())
            .map(inv => inv.id);
          cache['retail_invoices'] = (cache['retail_invoices']||[]).filter(inv =>
            !(inv.source === 'delivery_run' && inv.accountId === acId && inv.date === today())
          );
          if (deletedInvIds.length) {
            const rm = new Set(deletedInvIds);
            cache['iv'] = (cache['iv']||[]).filter(e => !(e.type === 'out' && rm.has(e.invoiceId)));
          }
        }
      });
    }
  }
  run.stops = run.stops.filter((_,idx)=>idx!==i);
  DB.setObj('today_run', run);
  renderDelivery();
}

function clearRoute() {
  if (!confirm2('Clear today\'s route?')) return;
  const run = DB.obj('today_run', {stops:[]});
  // Clean up orders/invoices for completed stops before archiving
  const completedStops = (run.stops||[]).filter(s => s.done);
  if (completedStops.length) {
    DB.atomicUpdate(cache => {
      const runDate = run.date || today();
      const deletedInvIds = new Set();
      completedStops.forEach(stop => {
        const acId = stop.accountId || _findAccount(null, stop.name)?.id;
        if (!acId) return;
        const ord = (cache['orders']||[]).find(o => o.source==='run' && o.accountId===acId && o.created===runDate);
        if (ord) {
          cache['orders'] = (cache['orders']||[]).filter(o => o.id !== ord.id);
          (cache['retail_invoices']||[])
            .filter(inv => inv.source === 'delivery_run' && inv.accountId === acId && inv.date === runDate)
            .forEach(inv => deletedInvIds.add(inv.id));
          cache['retail_invoices'] = (cache['retail_invoices']||[]).filter(inv =>
            !(inv.source === 'delivery_run' && inv.accountId === acId && inv.date === runDate)
          );
        }
      });
      if (deletedInvIds.size) {
        cache['iv'] = (cache['iv']||[]).filter(e => !(e.type === 'out' && deletedInvIds.has(e.invoiceId)));
      }
    });
  }
  // Archive completed run to history
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
    // M2: exclude void so this "Total Invoiced (All Brands)" matches the
    // Invoices-page KPI (renderInvKpis), which also drops void. Without this
    // the two same-labeled totals disagreed by the voided amount.
    const allInv = _allInvoices({excludeChildren: true}).filter(x => x.status !== 'void');
    const totalInvoiced = allInv.reduce((s,x) => s + _invAmt(x), 0);
    combinedEl.innerHTML = `<div class="kpi green" style="max-width:260px">` +
      `<div class="num">${fmtC(totalInvoiced)}</div>` +
      `<div class="label">Total Invoiced (All Brands)</div>` +
      `<div style="font-size:10px;color:var(--muted);margin-top:2px">purpl + LF + distributor</div></div>`;
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
  renderSkuPerformanceReport();
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
    if (!e.lastOrder || (o.created || o.date || '') > e.lastOrder) e.lastOrder = o.created || o.date || '';
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

  const TIERS = [
    { days: 90, label: '90+ days', bg: '#fef2f2', color: '#dc2626', cls: 'red'   },
    { days: 60, label: '60+ days', bg: '#fff7ed', color: '#ea580c', cls: 'orange' },
    { days: 45, label: '45+ days', bg: '#fefce8', color: '#d97706', cls: 'amber' },
  ];

  const orders   = DB.a('orders').filter(o => o.status !== 'cancelled');
  const accounts = DB.a('ac').filter(a => a.status === 'active');

  const rows = [];
  accounts.forEach(ac => {
    const acOrds = orders.filter(o => o.accountId === ac.id);
    if (!acOrds.length) return;

    const lastOrd   = acOrds.reduce((best, o) => (!best || (o.dueDate || '') > (best.dueDate || '') ? o : best), null);
    const daysSince = lastOrd ? daysAgo(lastOrd.dueDate) : 999;
    if (daysSince < 45) return;

    const tier        = TIERS.find(t => daysSince >= t.days) || TIERS[TIERS.length - 1];
    const outstanding = _allInvoices({accountId: ac.id, excludeChildren: true}).filter(i => i.status !== 'paid' && i.status !== 'void' && i.status !== 'draft').reduce((s, i) => s + _invAmt(i), 0);
    rows.push({ name: ac.name, lastOrder: lastOrd?.created || lastOrd?.date || '', daysSince, outstanding, tier });
  });

  rows.sort((a, b) => b.daysSince - a.daysSince);

  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty">No accounts going cold &mdash; great!</td></tr>';
    return;
  }

  tb.innerHTML = rows.map(r => `<tr style="background:${r.tier.bg}">
    <td>${escHtml(r.name)}</td>
    <td>${r.lastOrder ? fmtD(r.lastOrder) : '—'}</td>
    <td><span style="color:${r.tier.color};font-weight:600">${r.daysSince}d</span></td>
    <td><span class="badge" style="background:${r.tier.bg};color:${r.tier.color};border:1px solid ${r.tier.color};font-size:10px">${r.tier.label}</span></td>
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

  // Show last 24 months so each calendar month appears across 2 years
  for (let i = 23; i >= 0; i--) {
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

  // Best / Worst month by cases (exclude months with 0 cases)
  const withData = months.filter(m => m.cases > 0);
  const bestMo   = withData.length ? withData.reduce((a, b) => b.cases > a.cases ? b : a) : null;
  const worstMo  = withData.length ? withData.reduce((a, b) => b.cases < a.cases ? b : a) : null;

  const calloutEl = qs('#rep-mom-callout');
  if (calloutEl) {
    calloutEl.innerHTML = (bestMo || worstMo) ? `
      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px">
        ${bestMo  ? `<div style="flex:1;min-width:180px;padding:12px 16px;background:#f0fdf4;border:1px solid #86efac;border-radius:6px">
          <div style="font-size:11px;font-weight:600;color:#16a34a;text-transform:uppercase;letter-spacing:0.05em">Best Month</div>
          <div style="font-size:18px;font-weight:700;margin:2px 0">${bestMo.label}</div>
          <div style="font-size:13px;color:#16a34a">${fmt(bestMo.cases)} cases &nbsp;·&nbsp; ${fmtC(bestMo.revenue)}</div>
        </div>` : ''}
        ${worstMo && worstMo.key !== bestMo?.key ? `<div style="flex:1;min-width:180px;padding:12px 16px;background:#fff7ed;border:1px solid #fdba74;border-radius:6px">
          <div style="font-size:11px;font-weight:600;color:#ea580c;text-transform:uppercase;letter-spacing:0.05em">Worst Month</div>
          <div style="font-size:18px;font-weight:700;margin:2px 0">${worstMo.label}</div>
          <div style="font-size:13px;color:#ea580c">${fmt(worstMo.cases)} cases &nbsp;·&nbsp; ${fmtC(worstMo.revenue)}</div>
        </div>` : ''}
      </div>` : '';
  }

  tb.innerHTML = months.map(m => `<tr>
    <td style="${m.key === bestMo?.key ? 'font-weight:600;color:#16a34a' : m.key === worstMo?.key ? 'font-weight:600;color:#ea580c' : ''}">${m.label}</td>
    <td>${m.orderCount}</td>
    <td>${fmt(m.cases)}</td>
    <td>${fmtC(m.revenue)}</td>
  </tr>`).join('');
}

// ── SKU Performance ───────────────────────────────────────
function renderSkuPerformanceReport() {
  const el = qs('#rep-sku-perf-body');
  if (!el) return;

  const orders   = DB.a('orders').filter(o => o.status !== 'cancelled');
  const accounts = DB.a('ac');

  // Cases per SKU, plus top 3 accounts per SKU
  const skuTotals = {}; // { skuId: { cases, acMap: { accountId: cases } } }
  SKUS.forEach(sk => { skuTotals[sk.id] = { cases: 0, acMap: {} }; });

  orders.forEach(o => {
    (o.items || []).forEach(i => {
      const entry = skuTotals[i.sku];
      if (!entry) return;
      entry.cases += (i.qty || 0);
      entry.acMap[o.accountId] = (entry.acMap[o.accountId] || 0) + (i.qty || 0);
    });
  });

  const totalCases = SKUS.reduce((s, sk) => s + skuTotals[sk.id].cases, 0);

  if (!totalCases) {
    el.innerHTML = '<div class="empty">No order data yet</div>';
    return;
  }

  el.innerHTML = `
    <div class="tbl-wrap">
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Cases Moved</th>
            <th>% of Volume</th>
            <th>Top 3 Accounts</th>
          </tr>
        </thead>
        <tbody>
          ${SKUS.map(sk => {
            const d    = skuTotals[sk.id];
            const pct  = totalCases > 0 ? (d.cases / totalCases * 100).toFixed(1) : '0.0';
            const top3 = Object.entries(d.acMap)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([id, qty]) => {
                const ac = accounts.find(a => a.id === id);
                return `${escHtml(ac?.name || '(deleted)')} (${fmt(qty)})`;
              })
              .join(', ') || '—';

            return `<tr>
              <td>${skuBadge(sk.id)}</td>
              <td>${fmt(d.cases)}</td>
              <td>
                <div style="display:flex;align-items:center;gap:8px">
                  <div style="flex:1;background:#f3f4f6;border-radius:4px;height:14px;min-width:80px">
                    <div style="background:var(--purpl);height:100%;width:${pct}%;border-radius:4px;opacity:0.7"></div>
                  </div>
                  <span style="font-size:12px;min-width:36px">${pct}%</span>
                </div>
              </td>
              <td style="font-size:12px;color:var(--muted)">${top3}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
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

// ── Audit Log Page ───────────────────────────────────────
function renderAuditLog() {
  const tbody = qs('#al-tbody');
  if (!tbody) return;

  const actionFilter = qs('#al-filter-action')?.value || 'all';
  const typeFilter   = qs('#al-filter-type')?.value   || 'all';

  let entries = DB.a('audit_log')
    .slice()
    .sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1))
    .slice(0, 100);

  if (actionFilter !== 'all') entries = entries.filter(e => e.action === actionFilter);
  if (typeFilter   !== 'all') entries = entries.filter(e => e.entityType === typeFilter);

  const actionBadge = a =>
    a === 'create' ? `<span class="badge green"  style="font-size:10px">create</span>`  :
    a === 'update' ? `<span class="badge blue"   style="font-size:10px">update</span>`  :
    a === 'delete' ? `<span class="badge red"    style="font-size:10px">delete</span>`  :
                     `<span class="badge gray"   style="font-size:10px">${escHtml(a)}</span>`;
  const typeBadge  = t =>
    t === 'account' ? `<span class="badge purple" style="font-size:10px">account</span>` :
    t === 'invoice' ? `<span class="badge amber"  style="font-size:10px">invoice</span>` :
    t === 'order'   ? `<span class="badge blue"   style="font-size:10px">order</span>`   :
                      `<span class="badge gray"   style="font-size:10px">${escHtml(t)}</span>`;

  if (tbody) {
    tbody.innerHTML = entries.length
      ? entries.map(e => `<tr>
          <td style="font-size:12px;color:var(--muted);white-space:nowrap">${e.timestamp ? new Date(e.timestamp).toLocaleString() : '—'}</td>
          <td>${actionBadge(e.action)}</td>
          <td>${typeBadge(e.entityType)}</td>
          <td style="font-size:13px">${escHtml(e.entityName || e.entityId || '—')}</td>
          <td style="font-size:12px;color:var(--muted)">${escHtml(e.changedBy || '—')}</td>
        </tr>`).join('')
      : `<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--muted)">No audit log entries found.</td></tr>`;
  }
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
  const margin = costs.target_margin || _margin();
  const markup = 1 / Math.max(0.01, 1 - margin);

  const bySkuRev={}, bySkuCases={};
  SKUS.forEach(s=>{bySkuRev[s.id]=0;bySkuCases[s.id]=0;});
  // H5: index accounts once (was DB.a('ac').find per order = O(orders×accounts)).
  const acById = new Map(DB.a('ac').map(a=>[a.id,a]));
  orders.forEach(o=>{
    const ac2 = acById.get(o.accountId);
    // MED-4: route through the canonical pricer so the pricePerCaseCustom
    // fallback leg is included — inline versions omitted it, making reports
    // disagree with invoices for custom-priced accounts.
    const acPrc = _calcPricePerCase(ac2);
    (o.items||[]).forEach(i=>{
      const pricePerCase = acPrc || PURPL_DIRECT_PER_CASE;
      const qty = parseFloat(i.qty)||0; // M8: guard NaN from malformed items
      bySkuRev[i.sku]   = (bySkuRev[i.sku]||0)   + pricePerCase * qty;
      bySkuCases[i.sku] = (bySkuCases[i.sku]||0) + qty;
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
  const margin = costs.target_margin || _margin();
  const markup = 1 / Math.max(0.01, 1 - margin);
  const acMap  = {};
  const acById = new Map(DB.a('ac').map(a=>[a.id,a])); // H5: index once
  DB.a('ac').filter(a=>a.status==='active').forEach(a=>{ acMap[a.id]={name:a.name, rev:0, qty:0, orderCount:0}; });

  orders.forEach(o=>{
    if (!acMap[o.accountId]) return;
    const ac2 = acById.get(o.accountId);
    // MED-4: route through the canonical pricer so the pricePerCaseCustom
    // fallback leg is included — inline versions omitted it, making reports
    // disagree with invoices for custom-priced accounts.
    const acPrc = _calcPricePerCase(ac2);
    acMap[o.accountId].orderCount++;
    (o.items||[]).forEach(i=>{
      const pricePerCase = acPrc || PURPL_DIRECT_PER_CASE;
      const qty = parseFloat(i.qty)||0; // M8: guard NaN
      acMap[o.accountId].rev += pricePerCase * qty;
      acMap[o.accountId].qty += qty; // cases
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

  // LOW-3: report keeps inline ins/outs for the Received/Shipped columns, but
  // net on-hand uses the canonical _onHand (single source of truth, clamped).
  const rows = SKUS.map(s=>{
    const ins  = inv.filter(i=>i.sku===s.id&&(i.type==='in'||i.type==='return')).reduce((t,i)=>t+i.qty,0);
    const outs = inv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
    const oh   = _onHand(s.id, null);
    const val  = oh*(costs.cogs[s.id]||2.15);
    const status = oh<24?'Critical':oh<48?'Low':'OK';
    return [s.label, fmt(ins), fmt(outs), fmt(oh), fmtC(val), status];
  });
  const totalOH = SKUS.reduce((s,sk)=> s + _onHand(sk.id, null), 0);
  const totalVal= SKUS.reduce((s,sk)=> s + _onHand(sk.id, null) * (costs.cogs[sk.id]||2.15), 0);

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
    // Outstanding = open invoices only; invTotal−paid counted drafts/voids,
    // contradicting the KPI above which excludes them.
    const openAmt  = inv.filter(i=>!['paid','draft','void'].includes(i.status)).reduce((s,i)=>s+(i.total||0),0);
    return [d.name, d.status, pos.length, fmtC(poTotal), fmtC(invTotal), fmtC(paid), fmtC(openAmt)];
  });

  const totalPOs = rows.reduce((s,r)=>s+parseInt(r[2])||0,0);
  const totalOut = allInv.filter(i=>!['paid','draft','void'].includes(i.status)).reduce((s,i)=>s+(i.total||0),0);

  _setKPIs(dists.filter(d=>d.status==='active').length+' active', totalPOs+' POs', fmtC(allPOs.reduce((s,p)=>s+(p.totalValue||0),0)), fmtC(totalOut)+' outstanding');

  _drawChart('bar',
    dists.map(d=>d.name),
    [{label:'PO Value', data:dists.map(d=>allPOs.filter(p=>p.distId===d.id&&p.dateReceived>=from&&p.dateReceived<=to).reduce((s,p)=>s+(p.totalValue||0),0)), backgroundColor:'rgba(75,32,130,0.75)', borderRadius:4}],
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
  const margin = costs.target_margin || _margin();
  const markup = 1 / Math.max(0.01, 1 - margin);

  const bySkuRev={}, bySkuCases={};
  SKUS.forEach(s=>{bySkuRev[s.id]=0;bySkuCases[s.id]=0;});
  const acById = new Map(DB.a('ac').map(a=>[a.id,a])); // H5: index once
  orders.forEach(o=>{
    const ac2 = acById.get(o.accountId);
    // MED-4: route through the canonical pricer so the pricePerCaseCustom
    // fallback leg is included — inline versions omitted it, making reports
    // disagree with invoices for custom-priced accounts.
    const acPrc = _calcPricePerCase(ac2);
    (o.items||[]).forEach(i=>{
      const pricePerCase = acPrc || PURPL_DIRECT_PER_CASE;
      const qty = parseFloat(i.qty)||0; // M8: guard NaN
      bySkuRev[i.sku]   = (bySkuRev[i.sku]||0)   + pricePerCase * qty;
      bySkuCases[i.sku] = (bySkuCases[i.sku]||0) + qty;
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

  // purpl invoices (deduplicate + exclude combined invoice components)
  _allPurplInvoices().filter(x => x.status === 'paid' && !x.combinedInvoiceId).forEach(x => {
    const pd = (x.paidDate || x.paidAt || '').slice(0,10);
    if (!inYear(pd)) return;
    const acName = x.accountName || acLookup[x.accountId] || x.accountId || '—';
    rows.push([pd, x.number||x.invoiceNumber, 'purpl', acName, parseFloat(x.amount||x.total||0).toFixed(2), 'Invoice']);
  });

  // LF invoices (exclude those that are part of a combined invoice)
  DB.a('lf_invoices').filter(x => x.status === 'paid' && !x.combinedInvoiceId).forEach(x => {
    const pd = (x.paidDate || x.paidAt || '').slice(0,10);
    if (!inYear(pd)) return;
    const acName = x.accountName || acLookup[x.accountId] || '—';
    rows.push([pd, x.number||'—', 'LF', acName, parseFloat(x.total||0).toFixed(2), 'Invoice']);
  });

  // Combined invoices → two rows each (purpl subtotal + LF subtotal)
  DB.a('combined_invoices').filter(x => x.status === 'paid').forEach(x => {
    const pd = (x.paidDate || x.paidAt || '').slice(0,10);
    if (!inYear(pd)) return;
    const acName = x.accountName || acLookup[x.accountId] || '—';
    rows.push([pd, x.number, 'purpl', acName, parseFloat(x.purplSubtotal||0).toFixed(2), 'Combined - purpl']);
    rows.push([pd, x.number, 'LF',    acName, parseFloat(x.lfSubtotal||0).toFixed(2),    'Combined - LF']);
  });

  // DM-1 FIX: distributor invoices were missing from tax export
  DB.a('dist_invoices').filter(x => x.status === 'paid').forEach(x => {
    const pd = (x.paidDate || x.paidAt || '').slice(0,10);
    if (!inYear(pd)) return;
    const acName = x.accountName || x.distName || acLookup[x.accountId] || '—';
    rows.push([pd, x.number||'—', 'Dist', acName, parseFloat(x.total||x.amount||0).toFixed(2), 'Distributor']);
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
  // void + draft are not receivables — they inflated Outstanding
  const outstanding = invs.filter(i => !['paid','void','draft'].includes(i.status || 'draft'));

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
          const _od = i.dueDate || i.due || '';
          const overdue = _od && _od < today();
          return `<tr>
            <td>${escHtml(i.accountName||'—')}</td>
            <td>${escHtml(i.number||i.invoiceNumber||'INV')}</td>
            <td style="${overdue?'color:var(--red);font-weight:600':''}">${fmtD(i.dueDate||i.due)}</td>
            <td>${fmtC(i.total||0)}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4" style="color:var(--muted);text-align:center">No outstanding invoices</td></tr>';
  }

  // LF Deduction Log
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
      : '<tr><td colspan="5" style="color:var(--muted);text-align:center">No LF deductions in period</td></tr>';
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
    rows = invs.filter(i=>!['paid','void','draft'].includes(i.status||'draft')).map(i=>[i.accountName||'—', i.number||i.invoiceNumber||'', i.dueDate||i.due||'', (i.total||0).toFixed(2)]);
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
    <td><strong>${escHtml(o.buyer||'Unknown')}</strong></td>
    <td>${escHtml(o.date||'')}</td>
    <td>${escHtml(o.items.map(i=>`${i.product}${i.variant?' ('+i.variant+')':''} ×${i.qty}`).join(', ')||'—')}</td>
    <td>${fmtC(o.total||o.items.reduce((s,i)=>s+i.unitPrice*i.qty,0))}</td>
    <td><span class="badge ${o.status.includes('complet')||o.status.includes('deliver')?'green':o.status.includes('cancel')?'red':'amber'}">${escHtml(o.status)}</span></td>
  </tr>`).join('') || '<tr><td colspan="5" class="empty">No orders detected</td></tr>';

  const importBtn = qs('#ll-import-btn');
  if (importBtn) importBtn.onclick = ()=>importLLOrders(orders);
  const msgEl = qs('#ll-import-msg');
  if (msgEl) msgEl.textContent = `Columns detected: ${Object.entries(colIdx).map(([k,i])=>`${k}=col${i+1}`).join(', ')}`;
}

function importLLOrders(orders) {
  if (!DB._firestoreReady) { toast('⚠️ Database not ready yet — please wait a moment and try again.'); return; }
  let newAccounts=0, newOrders=0, skipped=0;
  const existingOrders = DB.a('orders');

  orders.forEach(o=>{
    // Find or create account
    let acct = _findAccount(null, o.buyer);
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
  // Non-admins can view but not save settings
  const settingsPage = document.getElementById('page-settings');
  if (settingsPage) {
    settingsPage.querySelectorAll('button.primary, button.green').forEach(btn => {
      if (!_isAdmin()) btn.style.display = 'none';
    });
  }
  const s = DB.obj('settings', {});
  const c = DB.obj('costs', {cogs:{},overhead_monthly:1200,target_margin:.6});

  // Tab 1: Business Info
  if(qs('#set-company'))              qs('#set-company').value              = s.company||'';
  if(qs('#set-address'))              qs('#set-address').value              = s.address||'';
  if(qs('#set-warehouse-radius'))    qs('#set-warehouse-radius').value    = s.warehouseRadiusMiles||'';
  if(qs('#set-warehouse-lat'))       qs('#set-warehouse-lat').value       = s.warehouseLat||'';
  if(qs('#set-warehouse-lng'))       qs('#set-warehouse-lng').value       = s.warehouseLng||'';
  if(qs('#set-phone'))                qs('#set-phone').value                = s.phone||'';
  if(qs('#set-website'))              qs('#set-website').value              = s.website||'';
  if(qs('#set-ein'))                  qs('#set-ein').value                  = s.ein||'';
  if(qs('#set-default-state'))        qs('#set-default-state').value        = s.default_state||'';
  if(qs('#set-default-account-type')) qs('#set-default-account-type').value = s.default_account_type||'Grocery';
  if(qs('#set-default-terms'))        qs('#set-default-terms').value        = s.default_payment_terms||30;

  // Tab 3: Email
  if(qs('#set-email-sig'))            qs('#set-email-sig').value            = s.emailSignature||'';

  // Tab 4: Inventory & Production
  if(qs('#set-low-inv-threshold'))    qs('#set-low-inv-threshold').value    = s.lowStockThreshold||500;
  if(qs('#set-prod-run-size'))        qs('#set-prod-run-size').value        = s.defaultProdRunSize||'';
  if(qs('#set-lead-time'))            qs('#set-lead-time').value            = s.production_lead_time||14;
  if(qs('#set-mpg'))                  qs('#set-mpg').value                  = s.mpg||25;
  if(qs('#set-gas-price'))            qs('#set-gas-price').value            = s.gasPrice||3.50;
  if(qs('#set-cans-per-case'))        qs('#set-cans-per-case').textContent  = CANS_PER_CASE;

  // COGS
  SKUS.forEach(sk=>{
    if(qs('#cost-'+sk.id)) qs('#cost-'+sk.id).value = c.cogs?.[sk.id]||'';
  });
  if(qs('#cost-overhead'))      qs('#cost-overhead').value      = c.overhead_monthly||1200;
  if(qs('#cost-target-margin')) qs('#cost-target-margin').value = (c.target_margin||.6)*100;

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

  // Import buttons — hide once run
  const tsBtn = qs('#tradeshow-import-card');
  if (tsBtn) tsBtn.style.display = s.tradeshow_2026_imported ? 'none' : '';
  const nemBtn = qs('#nem-import-card');
  if (nemBtn) nemBtn.style.display = s.nem_show_2026_imported ? 'none' : '';

  // User list (read-only)
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

  // Wire settings tab switching
  document.querySelectorAll('#page-settings [data-stab]').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#page-settings [data-stab]').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('#page-settings .stab-pane').forEach(p => p.style.display = 'none');
      btn.classList.add('active');
      const pane = document.getElementById('stab-' + btn.dataset.stab);
      if (pane) pane.style.display = '';
      if (btn.dataset.stab === 'audit') renderAuditLog();
      if (btn.dataset.stab === 'team') renderTeamTab();
    };
  });
}

function renderTeamTab() {
  const list = qs('#team-members-list');
  const inviteSection = qs('#team-invite-section');
  if (inviteSection) inviteSection.style.display = _isAdmin() ? '' : 'none';
  if (!list) return;
  firebase.firestore().collection('users').get().then(snap => {
    const users = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    list.innerHTML = users.length ? `
      <table class="data-table" style="width:100%;font-size:13px">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th>${_isAdmin()?'<th></th>':''}</tr></thead>
        <tbody>${users.map(u => `<tr>
          <td>${escHtml(u.displayName||'—')}</td>
          <td>${escHtml(u.email||'—')}</td>
          <td><span class="badge ${u.role==='admin'?'purple':'blue'}">${u.role||'employee'}</span></td>
          <td>${u.createdAt?fmtD(u.createdAt.slice(0,10)):'—'}</td>
          ${_isAdmin()?`<td>${u.uid !== window._currentUser?.uid ? `<button class="btn xs" onclick="toggleUserRole('${u.uid}','${u.role}')">${u.role==='admin'?'Make Employee':'Make Admin'}</button>`:''}</td>`:''}
        </tr>`).join('')}</tbody>
      </table>` : '<div class="empty">No team members yet</div>';
  }).catch(() => { list.innerHTML = '<div class="empty">Could not load team members</div>'; });
}

function toggleUserRole(uid, currentRole) {
  if (!_requireAdmin('change user roles')) return;
  const newRole = currentRole === 'admin' ? 'employee' : 'admin';
  if (!confirm2(`Change this user to ${newRole}?`)) return;
  firebase.firestore().collection('users').doc(uid).update({ role: newRole })
    .then(() => { toast(`Role changed to ${newRole}`); renderTeamTab(); })
    .catch(e => toast('Failed: ' + e.message));
  auditLog('update', 'user', uid, `Role changed to ${newRole}`);
}

async function inviteEmployee() {
  if (!_requireAdmin('invite employees')) return;
  const email = qs('#invite-email')?.value?.trim();
  const name = qs('#invite-name')?.value?.trim();
  const role = qs('#invite-role')?.value || 'employee';
  if (!email) { toast('Email required'); return; }
  const resultEl = qs('#invite-result');
  try {
    const fn = firebase.functions().httpsCallable('inviteEmployee');
    const result = await fn({ email, displayName: name, role });
    if (resultEl) {
      resultEl.style.display = '';
      resultEl.innerHTML = `<strong>✓ Invite email sent to ${escHtml(email)}.</strong> They'll get a link to set their password and sign in.<br>
        <details style="margin-top:6px"><summary style="font-size:12px;color:var(--muted);cursor:pointer">Backup link (if email doesn't arrive)</summary>
        <a href="${escHtml(result.data.resetLink)}" target="_blank" style="word-break:break-all;font-size:12px">${escHtml(result.data.resetLink)}</a></details>`;
    }
    auditLog('create', 'user', result.data.uid, `Invited ${email} as ${role}`);
    qs('#invite-email').value = '';
    qs('#invite-name').value = '';
    renderTeamTab();
  } catch(e) {
    toast(e.message || 'Invite failed');
    if (resultEl) { resultEl.style.display = ''; resultEl.textContent = 'Error: ' + (e.message || 'Unknown error'); }
  }
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
  if (!_requireAdmin('change settings')) return;
  auditLog('update', 'settings', 'settings', 'Settings changed');
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
    payment_terms:         parseInt(qs('#set-default-terms')?.value)||DB.obj('settings',{}).payment_terms||30,
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

  // MED-5: only persist a COGS a user actually entered. Coercing blank to 2.15
  // baked a placeholder in as if it were real, so "unknown cost" became
  // indistinguishable from an entered $2.15. Omit blank/invalid SKUs.
  const cogs = {};
  SKUS.forEach(sk=>{ const v = parseFloat(qs('#cost-'+sk.id)?.value); if (!isNaN(v) && v > 0) cogs[sk.id] = v; });
  const c = {
    cogs,
    overhead_monthly: parseFloat(qs('#cost-overhead')?.value)||1200,
    target_margin:    (parseFloat(qs('#cost-target-margin')?.value)||60)/100,
  };
  DB.setObj('costs', c);
  toast('Settings saved');
}

function saveBusinessSettings() {
  const existing = DB.obj('settings', {});
  DB.setObj('settings', {
    ...existing,
    company:               qs('#set-company')?.value?.trim()||'',
    address:               qs('#set-address')?.value?.trim()||'',
    phone:                 qs('#set-phone')?.value?.trim()||'',
    website:               qs('#set-website')?.value?.trim()||'',
    ein:                   qs('#set-ein')?.value?.trim()||'',
    default_state:         qs('#set-default-state')?.value?.trim()||'',
    default_account_type:  qs('#set-default-account-type')?.value||'Grocery',
    default_payment_terms: parseInt(qs('#set-default-terms')?.value)||30,
    warehouseRadiusMiles:  parseFloat(qs('#set-warehouse-radius')?.value)||0,
    warehouseLat:          parseFloat(qs('#set-warehouse-lat')?.value)||null,
    warehouseLng:          parseFloat(qs('#set-warehouse-lng')?.value)||null,
  });
  toast('Business info saved ✓');
}

function saveInventorySettings() {
  const recipe = {};
  let recipeTotal = 0;
  SKUS.filter(sk=>sk.id!=='variety').forEach(sk=>{
    const v = parseInt(qs('#variety-recipe-'+sk.id)?.value)||0;
    recipe[sk.id] = v; recipeTotal += v;
  });
  if (recipeTotal > 0 && recipeTotal !== CANS_PER_CASE) {
    toast(`Variety recipe must total ${CANS_PER_CASE} cans (currently ${recipeTotal})`);
    return;
  }
  const existing = DB.obj('settings', {});
  DB.setObj('settings', {
    ...existing,
    lowStockThreshold:    parseInt(qs('#set-low-inv-threshold')?.value)||500,
    defaultProdRunSize:   parseInt(qs('#set-prod-run-size')?.value)||0,
    production_lead_time: parseInt(qs('#set-lead-time')?.value)||14,
    mpg:                  parseFloat(qs('#set-mpg')?.value)||25,
    gasPrice:             parseFloat(qs('#set-gas-price')?.value)||3.50,
    variety_recipe:       recipeTotal === CANS_PER_CASE ? recipe : (existing.variety_recipe||{}),
  });
  // MED-5: only persist a COGS a user actually entered. Coercing blank to 2.15
  // baked a placeholder in as if it were real, so "unknown cost" became
  // indistinguishable from an entered $2.15. Omit blank/invalid SKUs.
  const cogs = {};
  SKUS.forEach(sk=>{ const v = parseFloat(qs('#cost-'+sk.id)?.value); if (!isNaN(v) && v > 0) cogs[sk.id] = v; });
  DB.setObj('costs', {
    cogs,
    overhead_monthly: parseFloat(qs('#cost-overhead')?.value)||1200,
    target_margin:    (parseFloat(qs('#cost-target-margin')?.value)||60)/100,
  });
  toast('Inventory & production settings saved ✓');
}

function saveEmailSettings() {
  const existing = DB.obj('settings', {});
  DB.setObj('settings', { ...existing, emailSignature: qs('#set-email-sig')?.value||'' });
  toast('Email settings saved ✓');
}


// ══════════════════════════════════════════════════════════
//  MODAL HELPERS
// ══════════════════════════════════════════════════════════
function openModal(id) {
  document.querySelectorAll('.overlay.open').forEach(o => {
    if (o.id !== id) o.classList.remove('open');
  });
  const m = document.getElementById(id);
  if (m) m.classList.add('open');
  // Mark dirty when opening an edit modal (forms with save buttons)
  if (id && (id.includes('edit') || id.includes('add') || id.includes('new') || id.includes('log'))) {
    DB.markDirty();
  }
}
function closeModal(id) {
  DB.markClean();
  if (id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('open');
    return;
  }
  document.querySelectorAll('.overlay').forEach(o=>o.classList.remove('open'));
}

function qs(sel) { return document.querySelector(sel); }

// ── Wire filter/search controls ──────────────────────────
function setupFilters() {
  function _bindOnce(sel, fn) {
    const el = qs(sel);
    if (el && !el.dataset.filterBound) { el.addEventListener('input', fn); el.dataset.filterBound = '1'; }
  }
  ['#ac-search','#ac-type-filter','#ac-brand-filter','#ac-fulfill-filter','#ac-status-filter','#ac-sort'].forEach(sel => _bindOnce(sel, renderAccounts));
  ['#pr-search','#pr-stage-filter','#pr-brand-filter','#pr-sort'].forEach(sel => _bindOnce(sel, renderProspects));
  ['#dist-search','#dist-status-filter'].forEach(sel => _bindOnce(sel, renderDistributors));
  // Projections velocity window
  const projVelSrc = qs('#proj-velocity-source');
  if (projVelSrc) projVelSrc.addEventListener('change', renderProjectionsPage);
  // Global cross-entity search with dropdown results
  const gs = qs('#global-search');
  if (gs) {
    let _gsTimer = null;
    gs.addEventListener('input', () => {
      clearTimeout(_gsTimer);
      _gsTimer = setTimeout(_globalSearchRun, 120);
    });
    gs.addEventListener('keydown', (ev) => {
      const box = document.getElementById('global-search-results');
      if (ev.key === 'Escape') {
        gs.value = '';
        if (box) { box.style.display = 'none'; box.innerHTML = ''; }
        gs.blur();
      } else if (ev.key === 'Enter') {
        box?.querySelector('.gs-item')?.click();
      }
    });
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('#global-search-wrap')) {
        const box = document.getElementById('global-search-results');
        if (box) box.style.display = 'none';
      }
    });
    // "/" focuses search from anywhere (unless already typing somewhere)
    document.addEventListener('keydown', (ev) => {
      if (ev.key === '/' && !ev.ctrlKey && !ev.metaKey &&
          !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {
        ev.preventDefault();
        gs.focus();
      }
    });
  }
  // Dark mode toggle
  const tt = qs('#theme-toggle-btn');
  if (tt) { _syncThemeLabel(); tt.addEventListener('click', toggleTheme); }
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
    // NEM Show accounts (March 2026) — embedded here so they can never be lost again
    {id:mkId(),name:'Osbornes',type:'Farm / Country Store',contact:'Gretchen Wolfe',phone:'603-228-8561',email:'gretchen@osbornesfarm.com',address:'258 Sheep Davis Road, Concord, NH',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Poland Provisions',type:'Specialty / Gift',contact:'Sheila Foley',phone:'207-402-7123',email:'info@polandprovisions.com',address:'1220 Maine St., Poland, ME',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'New England Mercantile',type:'Specialty / Gift',contact:'Kyle Eldridge',phone:'603-772-0263',email:'keldridge.nemercantile@gmail.com',address:'Water St., Exeter, NH',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'Cash and carry. NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Wild Oats Bakery and Cafe',type:'Café',contact:'Colleen Gilliatt',phone:'207-725-6287',email:'market@wildoatsbakery.com',address:'166 Admiral Fitch Avenue, Brunswick, ME',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Douglas Brook Farm',type:'Farm / Country Store',contact:'Kim Bragdon',phone:'207-659-9581',email:'douglasbrookfarm@gmail.com',address:'21 Files Rd, Gorham, ME',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order. Mid April invoice.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'New Morning Natural Foods',type:'Specialty / Gift',contact:'Ariel Peacock',phone:'207-985-6774',email:'ariel@newmorningme.com',address:'3 York Street, Kennebunk, ME',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Harpswell Collective',type:'Specialty / Gift',contact:'Liz Negler',phone:'617-653-6960',email:'liz@harpswellcollective.com',address:'1906 Harpswell Neck Rd, Harpswell, ME',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order. Late May invoice.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Portsmouth Soap Co',type:'Specialty / Gift',contact:'Lauren',phone:'207-451-7904',email:'lauren@portsmouthsoaps.com',address:'175 Market St., Portsmouth, NH',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Enfield Shaker Museum',type:'Specialty / Gift',contact:'Carolyn Smith (Acting Director)',phone:'603-632-4346',email:'director@sharkermuseum.org',address:'477 NH Route 4A, Enfield, NH',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'Mothers Day? NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:"Singleton's Store",type:'Specialty / Gift',contact:'Allison and Danielle Singleton',phone:'802-226-7666',email:'store@singletonvt.com',address:'356 Main St, Proctorsville, VT',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Maine Homestead Market',type:'Farm / Country Store',contact:'',phone:'207-499-4292',email:'mainehomsteadstore@gmail.com',address:'1773 Alfred Rd, Lyman, ME',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Beachside Variety',type:'Specialty / Gift',contact:'Sheila Gillian',phone:'207-450-0753',email:'',address:'124 W Grand Ave, Old Orchard Beach, ME',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order. CASH ON DELIVERY — mid May. Text when close, notify before delivery.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Wild Goose Country Store',type:'Farm / Country Store',contact:'Sharon Parsons',phone:'',email:'wildgoosecountrystore@hotmail.com',address:'77 Main St, Sunapee, NH 03782',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order. CC info on order form. Ship to 511 North Road, Sunapee NH — mid May.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'The Seagull Shop',type:'Specialty / Gift',contact:'Brooke Cotter (Partner/GM)',phone:'207-677-2374',email:'seagullbrooke@gmail.com',address:'3119 Bristol Rd, New Harbor, ME',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order. May invoice.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Original General Store',type:'Specialty / Gift',contact:'Lauren Foley',phone:'802-746-8888',email:'ogs802@gmail.com',address:'3963 VT RT 100, Pittsfield, VT',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Whimsical Wishes',type:'Specialty / Gift',contact:'Joanne Meeks / Richard Torrey',phone:'508-317-0659',email:'joannemeeks@msn.com',address:'170 Water St, Plymouth, MA',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Love at First Light',type:'Specialty / Gift',contact:'Tammy Fairchild',phone:'207-213-5867',email:'loveatfirstlight@yahoo.com',address:'77 Water St, Lubec, ME',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order. May invoice.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
    {id:mkId(),name:'Nesting Dusk',type:'Specialty / Gift',contact:'Mary Thurlow and Ruth Brown',phone:'',email:'nestduck@aol.com',address:'17 Perkins Cove, Ogunquit, ME',lat:null,lng:null,territory:'',status:'active',since:'2026-03-17',dropOffRules:'',skus:[],par:{},pricing:{},notes:[{id:mkId(),date:'2026-03-17',text:'NEM show order.',author:'you',nextAction:'',nextDate:''}],outreach:[],lastOrder:null,lastContacted:'2026-03-17'},
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
  const DEMO_PR = new Set(['green earth market','fitzone studios']);

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
    cache.settings = {...(cache.settings||{}), data_restored: true, seeded: true, nem_show_2026_imported: true};
    return cache;
  });
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
  draft:   {label:'Draft',   cls:'gray'},
  sent:    {label:'Sent',    cls:'blue'},
  paid:    {label:'Paid',    cls:'green'},
  void:    {label:'Void',    cls:'red'},
  unpaid:  {label:'Unpaid',  cls:'amber'},
  overdue: {label:'Overdue', cls:'red'},
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
  if (qs('#lf-inv-kpi-wix'))         qs('#lf-inv-kpi-wix').innerHTML         = kpiHtml('Pending LF Deductions', pendingWix, pendingWix > 0 ? 'amber' : 'gray');

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
  const newStatus = inv.status === 'paid' ? 'sent' : 'paid';
  DB.update('lf_invoices', id, x => ({...x, status: newStatus, paidDate: newStatus === 'paid' ? today() : null, paidAt: newStatus === 'paid' ? new Date().toISOString() : null}));
  _syncCombinedParentForChild(id); // M1
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
    if (qs('#lfi-number')) qs('#lfi-number').value = peekNextInvoiceNumber();
    if (qs('#lfi-issued')) qs('#lfi-issued').value  = today();
    const terms  = DB.obj('invoice_settings',{}).terms || _payTerms();
    const dueStr = new Date(Date.now() + terms * 864e5).toISOString().slice(0,10);
    if (qs('#lfi-due'))    qs('#lfi-due').value    = dueStr;
    if (qs('#lfi-status')) qs('#lfi-status').value = 'draft';
    if (qs('#lfi-notes'))  qs('#lfi-notes').value  = '';
    if (qs('#lfi-link'))   qs('#lfi-link').value   = '';
    if (qs('#lfi-delivery-method'))qs('#lfi-delivery-method').value = 'deliver';
    if (qs('#lfi-fulfillment')) qs('#lfi-fulfillment').value = 'farm';
    if (qs('#lfi-delivery-date')) qs('#lfi-delivery-date').value = '';
    if (qs('#lfi-tracking'))      qs('#lfi-tracking').value      = '';
    if (qs('#lfi-ship-status'))   qs('#lfi-ship-status').style.display = 'none';
    if (qs('#lfi-delete-btn')) qs('#lfi-delete-btn').style.display = 'none';
  } else {
    if (qs('#lfi-number')) qs('#lfi-number').value = inv.number||'';
    if (qs('#lfi-issued')) qs('#lfi-issued').value  = inv.issued||inv.date||today();
    if (qs('#lfi-due'))    qs('#lfi-due').value    = inv.due||inv.dueDate||'';
    if (qs('#lfi-status')) qs('#lfi-status').value = inv.status||'draft';
    if (qs('#lfi-notes'))  qs('#lfi-notes').value  = inv.notes||'';
    if (qs('#lfi-link'))   qs('#lfi-link').value   = inv.link||'';
    if (qs('#lfi-delivery-method'))qs('#lfi-delivery-method').value = inv.deliveryMethod||'deliver';
    if (qs('#lfi-fulfillment')) qs('#lfi-fulfillment').value = inv.fulfillmentSource||'farm';
    if (qs('#lfi-delivery-date')) qs('#lfi-delivery-date').value = inv.deliveryDate||'';
    if (qs('#lfi-tracking'))      qs('#lfi-tracking').value      = inv.trackingNumber||'';
    lfiDeliveryMethodChange();
    if (qs('#lfi-delete-btn')) {
      qs('#lfi-delete-btn').style.display = _isAdmin() ? '' : 'none';
      qs('#lfi-delete-btn').onclick = () => deleteLfInvoice(id);
    }
  }

  // Account selector (all non-inactive accounts, searchable)
  const lfiAccounts = DB.a('ac').filter(a => a.status !== 'inactive').sort((a,b) => (a.name||'') < (b.name||'') ? -1 : 1);
  _populateAccountSelect('lfi-account', lfiAccounts, inv?.accountId || '');

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

  qs('#lfi-save-btn').onclick = _once(() => saveLfInvoice(id, isNew));

  const lfiPdfBtn = qs('#lfi-pdf-btn');
  if (lfiPdfBtn) {
    lfiPdfBtn.style.display = isNew ? 'none' : '';
    lfiPdfBtn.onclick = () => generateLfInvoicePrint(id);
  }

  const lfiSendBtn = qs('#lfi-send-btn');
  if (lfiSendBtn) {
    lfiSendBtn.style.display = '';
    const _lfiIsShip = () => qs('#lfi-delivery-method')?.value === 'ship';
    lfiSendBtn.textContent = _lfiIsShip() ? 'Save & Push to ShipStation' : 'Save & Send';
    const dmLf = qs('#lfi-delivery-method');
    if (dmLf) dmLf.onchange = () => {
      lfiSendBtn.textContent = _lfiIsShip() ? 'Save & Push to ShipStation' : 'Save & Send';
    };
    lfiSendBtn.onclick = async () => {
      if (lfiSendBtn.disabled) return;
      lfiSendBtn.disabled = true; lfiSendBtn.textContent = 'Saving…';
      try {
        // Persist first — works for brand-new invoices too (one-step send)
        const out = _saveLfInvoiceCore(id, isNew);
        if (!out) { lfiSendBtn.disabled = false; lfiSendBtn.textContent = _lfiIsShip() ? 'Save & Push to ShipStation' : 'Save & Send'; return; }
        const inv = out.rec;
        if (inv.deliveryMethod === 'ship' && !inv.shipStationOrderId) {
          await pushInvoiceToShipStation(inv.id, 'lf_invoices');
        }
        const ac = DB.a('ac').find(x => x.id === inv.accountId) || {};
        if (!ac.email) {
          toast('Saved — but no email address on file for this account');
          closeModal('modal-lf-invoice');
          if (currentPage === 'invoices') renderInvoicesPage();
          renderLfDashKpis();
          showWixPullModal(inv, out.deduction.id);
          return;
        }
        lfiSendBtn.textContent = 'Generating link…';
        const payLink = inv.status === 'paid' ? null : await _getStripePayLink(inv, 'lf');
        const sendInv = payLink ? { ...inv, _payLink: payLink } : inv;
        const html    = buildLfInvoiceEmailHTML(sendInv);
        const subject = `Invoice ${inv.number||''} from Lavender Fields at Pumpkin Blossom Farm — ${ac.name||inv.accountName||''}`;
        lfiSendBtn.textContent = 'Sending…';
        const result = await callSendEmail(ac.email, 'lavender@pbfwholesale.com', subject, html);
        // Sending flips Draft → Sent automatically
        if ((inv.status || 'draft') === 'draft') {
          DB.update('lf_invoices', inv.id, x => ({ ...x, status: 'sent', sentAt: today() }));
        }
        const entry = {
          id: uid(), stage: 'invoice_sent',
          sentAt: new Date().toISOString(),
          sentBy: _currentUserName(), method: 'resend',
          invoiceId: inv.id, invoiceRef: inv.number,
        };
        if (result?.id) entry.sentMessageId = result.id;
        DB.update('ac', ac.id, a => ({
          ...a, lastContacted: today(),
          cadence: _pushCadence(a.cadence, entry),
        }));
        _clearReadyToSend(inv.id, 'lf_invoices');
        closeModal('modal-lf-invoice');
        if (currentPage === 'invoices') renderInvoicesPage();
        renderLfDashKpis();
        renderAccounts();
        toast('Invoice saved & sent ✓');
        showWixPullModal(inv, out.deduction.id);
      } catch (e) {
        console.error('LF invoice send failed:', e);
        toast('Invoice saved, but the email failed' + (e?.message ? ' (' + e.message + ')' : '') + ' — open it and try Send again', 8000);
        closeModal('modal-lf-invoice');
        if (currentPage === 'invoices') renderInvoicesPage();
      } finally {
        lfiSendBtn.disabled = false; lfiSendBtn.textContent = 'Save & Send';
      }
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
  row.className     = 'inv-line-block';
  row.dataset.rowId = rowId;
  const selOpts = skus.map(s => {
    const sel = item && s.id === item.skuId ? 'selected' : '';
    return `<option value="${s.id}" data-price="${s.wholesalePrice}" data-case="${s.caseSize}" ${sel}>${escHtml(s.name)}</option>`;
  }).join('');
  row.innerHTML = `
    <div class="inv-line-head">
      <select class="lfi-sku-sel" style="flex:1;min-width:180px" onchange="_lfInvSkuChanged('${rowId}')">
        <option value="">— Select SKU —</option>${selOpts}
      </select>
      <button type="button" class="btn sm red" onclick="_lfInvRemoveRow('${rowId}')">✕</button>
    </div>
    <div class="lfi-variant-area" style="margin-top:6px"></div>
    <div style="display:flex;justify-content:flex-end;align-items:baseline;font-size:13px;margin-top:4px">
      Row total: <strong class="lfi-line-amt inv-line-total" style="margin-left:6px">${fmtC(item?.lineTotal||0)}</strong>
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
    const caseSize = parseInt(skuObj.caseSize) || 1;
    const varRows = variants.map(v => {
      const vl = item?.variantLines?.find(x => x.variantId === v.id);
      // Older invoices stored whole cases per variant — fall back to cases × caseSize
      const units = vl?.units != null ? vl.units : (vl?.cases || 0) * caseSize;
      return `
        <div class="lfi-variant-row inv-variant-row" data-variant-id="${v.id}">
          <span class="inv-variant-name">${escHtml(v.name)}${_isRefillable(v.name) ? ' <span style="font-size:11px;color:#15803d">(Refillable)</span>' : ''}</span>
          <input class="lfi-var-units inv-qty-input" type="number" min="0" step="1" value="${units||0}"
            oninput="_lfInvRowCalc('${rowId}')">
          <span class="inv-line-unit">units</span>
          <span class="lfi-var-total inv-line-total">${fmtC(vl?.lineTotal||0)}</span>
        </div>`;
    }).join('');
    area.innerHTML = `
      <div style="font-size:11.5px;color:var(--muted);margin-bottom:2px;padding-left:18px">
        $${parseFloat(skuObj.wholesalePrice).toFixed(2)}/unit · ${caseSize} units/case · mix variants to split a case
      </div>
      <div class="lfi-variants-container">${varRows}</div>
      <div class="lfi-case-summary inv-case-note"></div>`;
  } else {
    area.innerHTML = `
      <div class="inv-variant-row" style="padding-left:18px">
        <span class="inv-variant-name inv-line-unit" style="font-size:12.5px">Quantity</span>
        <input class="lfi-cases inv-qty-input" type="number" min="0" step="1" value="${item?.cases||0}"
          oninput="_lfInvRowCalc('${rowId}')">
        <span class="inv-line-unit">cases</span>
        <span class="inv-line-unit">= <strong class="lfi-units">${item?.units||0}</strong> units</span>
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
    let totalUnits = 0;
    variantRows.forEach(vr => {
      const units     = parseInt(vr.querySelector('.lfi-var-units')?.value || 0);
      const lineTotal = units * unitPrice;
      totalUnits += units;
      const ltEl = vr.querySelector('.lfi-var-total');
      if (ltEl) ltEl.textContent = fmtC(lineTotal);
      rowTotal += lineTotal;
    });
    const sumEl = row.querySelector('.lfi-case-summary');
    if (sumEl) {
      if (totalUnits > 0 && caseSize > 0) {
        const casesExact = totalUnits / caseSize;
        const whole = totalUnits % caseSize === 0;
        sumEl.innerHTML = `${totalUnits} units = ${whole ? casesExact : casesExact.toFixed(2)} case${casesExact === 1 ? '' : 's'}`
          + (whole ? '' : ` <span style="color:#d97706;font-weight:600">(partial case — ${caseSize}/case)</span>`);
      } else {
        sumEl.textContent = '';
      }
    }
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
  container.querySelectorAll('.inv-line-block').forEach(row => {
    const sel       = row.querySelector('.lfi-sku-sel');
    const opt       = sel?.options[sel?.selectedIndex];
    const unitPrice = parseFloat(opt?.dataset?.price || 0);
    const caseSize  = parseInt(opt?.dataset?.case    || 0);
    const variantRows = row.querySelectorAll('.lfi-variant-row');
    if (variantRows.length > 0) {
      variantRows.forEach(vr => {
        const units = parseInt(vr.querySelector('.lfi-var-units')?.value || 0);
        total += units * unitPrice;
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
  const out = _saveLfInvoiceCore(id, isNew);
  if (!out) return;
  closeModal('modal-lf-invoice');
  if (currentPage === 'invoices') renderInvoicesPage();
  renderLfDashKpis();
  toast(`Invoice ${out.rec.number} saved ✓`);
  showWixPullModal(out.rec, out.deduction.id);
}

// Validates + persists the LF invoice from the modal. Returns
// {rec, deduction} or null if validation failed (toast already shown).
function _saveLfInvoiceCore(id, isNew) {
  const number    = qs('#lfi-number')?.value?.trim() || '';
  const accountId = qs('#lfi-account')?.value;
  const issued    = qs('#lfi-issued')?.value || today();
  const due       = qs('#lfi-due')?.value || '';
  const status    = qs('#lfi-status')?.value || 'draft';
  const notes     = qs('#lfi-notes')?.value?.trim() || '';
  const link      = qs('#lfi-link')?.value?.trim() || '';
  const deliveryDate   = qs('#lfi-delivery-date')?.value || '';
  const trackingNumber = qs('#lfi-tracking')?.value?.trim() || '';

  if (!accountId) { toast('Select an account'); return; }

  const ac   = DB.a('ac').find(x => x.id === accountId) || {};
  const skus = DB.a('lf_skus');

  // Collect line items from DOM
  const lineItems = [];
  qs('#lfi-line-items').querySelectorAll('.inv-line-block').forEach(row => {
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
        const units      = parseInt(vr.querySelector('.lfi-var-units')?.value || 0);
        if (!units) return;
        const lineTotal = units * unitPrice;
        // cases may be fractional when a case is split across variants
        const cases = caseSize ? +(units / caseSize).toFixed(2) : 0;
        variantLines.push({variantId, variantName: variantObj?.name || '', cases, units, lineTotal});
      });
      if (!variantLines.length) return;
      const totalUnits = variantLines.reduce((s,v)=>s+v.units, 0);
      const totalCases = caseSize ? +(totalUnits / caseSize).toFixed(2) : 0;
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

  const existing = isNew ? null : DB.a('lf_invoices').find(x => x.id === id);
  const saveId   = isNew ? uid() : id;

  // Preserve the ShipStation __shipping__ line — the modal renders SKU rows
  // only, so rebuilding from the DOM dropped the shipping charge on re-edit.
  lineItems.push(...((existing?.lineItems || []).filter(li => li.skuId === '__shipping__')));

  const total    = lineItems.reduce((s, l) => s + (parseFloat(l.lineTotal != null ? l.lineTotal : l.total) || 0), 0);

  const rec = {
    ...(existing||{}),
    id: saveId, number, invoiceNumber: number,
    accountId, accountName: ac.name||'',
    issued, due, lineItems, total, status,
    wixPulled:   existing?.wixPulled   || false,
    wixPulledAt: existing?.wixPulledAt || null,
    deliveryMethod:  qs('#lfi-delivery-method')?.value || 'deliver',
    // The Fulfilled-by dropdown existed in the modal but was never read, so
    // manual LF invoices could never get the Warehouse badge / push button.
    fulfillmentSource: qs('#lfi-fulfillment')?.value || existing?.fulfillmentSource || 'farm',
    notes, link, deliveryDate, trackingNumber,
  };

  if (isNew) DB.push('lf_invoices', rec);
  else DB.update('lf_invoices', id, () => rec);

  // Generate or refresh Wix pull deduction record
  const existingDeduction = !isNew ? DB.a('lf_wix_deductions').find(d => d.invoiceId === saveId) : null;
  const deduction = {
    id: existingDeduction?.id || uid(),
    invoiceId:     saveId,
    invoiceNumber: rec.number,
    accountId:     rec.accountId,
    accountName:   rec.accountName,
    date:          existingDeduction?.date || today(),
    items:         lineItems.filter(l => l.skuId !== '__shipping__').flatMap(l => l.hasVariants
      ? l.variantLines.map(vl => ({skuName: l.skuName, variantName: vl.variantName, cases: vl.cases, units: vl.units}))
      : [{skuName: l.skuName, cases: l.cases, units: l.units}]),
    confirmed:     existingDeduction?.confirmed || false,
  };
  if (isNew) DB.push('lf_wix_deductions', deduction);
  else if (existingDeduction) DB.update('lf_wix_deductions', existingDeduction.id, () => deduction);
  else DB.push('lf_wix_deductions', deduction);

  auditLog(isNew ? 'create' : 'update', 'lf_invoice', saveId, rec.number || saveId);
  if (!isNew) _syncCombinedParentForChild(saveId); // M1: keep combined parent status+dollars in step with LF child edits
  return { rec, deduction };
}

function deleteLfInvoice(id) {
  if (!_requireAdmin('delete invoices')) return;
  if (!confirm2('Delete this LF invoice? This cannot be undone.')) return;
  const invNum = DB.a('lf_invoices').find(x => x.id === id)?.number || id;
  auditLog('delete', 'lf_invoice', id, invNum);
  deleteInvoiceWithCleanup(id);
  closeModal('modal-lf-invoice');
  if (currentPage === 'invoices') renderInvoicesPage();
  renderLfDashKpis();
  toast('Invoice deleted');
}

// ── Combined invoices (purpl + LF cross-brand) ────────────

async function createCombinedInvoice(purplInvId, lfInvId, accountId, portalOrderId=null) {
  const purplInv = findInvoice(purplInvId);
  const lfInv    = DB.a('lf_invoices').find(x => x.id === lfInvId);
  if (!purplInv || !lfInv) {
    toast('Could not find invoices to combine');
    return null;
  }
  const id = uid();
  const num = await getNextInvoiceNumber('combined');
  // amount||total: delivery-run (and legacy) purpl invoices store only `total` —
  // reading `amount` alone dropped the whole purpl half from the grand total
  // while the document still listed its line items.
  const _pSub = parseFloat(purplInv.amount != null ? purplInv.amount : purplInv.total) || 0;
  const _lSub = parseFloat(lfInv.total != null ? lfInv.total : lfInv.amount) || 0;
  const _date = purplInv.date || lfInv.issued || lfInv.date || today();
  const rec = {
    id,
    number: num,
    invoiceNumber: num,
    purplInvoiceId: purplInvId,
    lfInvoiceId:    lfInvId,
    accountId,
    accountName:    purplInv.accountName || '',
    status:         'draft',
    // date/dueDate were never set, so this parent could never show overdue
    date:           _date,
    dueDate:        purplInv.dueDate || purplInv.due || lfInv.dueDate || lfInv.due || '',
    createdAt:      new Date().toISOString(),
    sentAt:         null,
    paidAt:         null,
    portalOrderId:  portalOrderId || null,
    purplSubtotal:  _pSub,
    lfSubtotal:     _lSub,
    grandTotal:     _pSub + _lSub,
  };
  DB.atomicUpdate(cache => {
    cache.combined_invoices = [...(cache.combined_invoices||[]), rec];
    // Link purpl invoice — check retail_invoices first, then iv
    const ri = (cache.retail_invoices||[]).findIndex(x => x.id === purplInvId);
    if (ri >= 0) cache.retail_invoices[ri] = {...cache.retail_invoices[ri], combinedInvoiceId: id};
    else {
      const pi = (cache.iv||[]).findIndex(x => x.id === purplInvId);
      if (pi >= 0) cache.iv[pi] = {...cache.iv[pi], combinedInvoiceId: id};
    }
    const li = (cache.lf_invoices||[]).findIndex(x => x.id === lfInvId);
    if (li >= 0) cache.lf_invoices[li] = {...cache.lf_invoices[li], combinedInvoiceId: id};
  });
  return id;
}

function markCombinedPaid(combinedId) {
  const rec = DB.a('combined_invoices').find(x => x.id === combinedId);
  if (!rec) return;
  const now = new Date().toISOString();
  const pd = now.slice(0,10);
  DB.atomicUpdate(cache => {
    const ci = (cache.combined_invoices||[]).findIndex(x => x.id === combinedId);
    if (ci >= 0) cache.combined_invoices[ci] = {...cache.combined_invoices[ci], status:'paid', paidDate:pd, paidAt:now};
    const ri = (cache.retail_invoices||[]).findIndex(x => x.id === rec.purplInvoiceId);
    if (ri >= 0) cache.retail_invoices[ri] = {...cache.retail_invoices[ri], status:'paid', paidDate:pd, paidAt:now};
    else {
      const ii = (cache.iv||[]).findIndex(x => x.id === rec.purplInvoiceId);
      if (ii >= 0) cache.iv[ii] = {...cache.iv[ii], status:'paid', paidDate:pd, paidAt:now};
    }
    const li = (cache.lf_invoices||[]).findIndex(x => x.id === rec.lfInvoiceId);
    if (li >= 0) cache.lf_invoices[li] = {...cache.lf_invoices[li], status:'paid', paidDate:pd, paidAt:now};
  });
  renderInvoicesPage();
  toast('✓ Combined invoice marked as paid');
}

// M1: when a combined-invoice CHILD changes paid status, recompute the parent
// so reports that count the parent and reports that count the children can't
// disagree about the same money. Parent is 'paid' only when BOTH children are;
// if a child is un-paid, a previously-paid parent reverts to 'sent'. No-op for
// non-combined invoices.
function _syncCombinedParentForChild(childId) {
  const child = findInvoice(childId);
  const combinedId = child && child.combinedInvoiceId;
  if (!combinedId) return;
  const parent = DB.a('combined_invoices').find(x => x.id === combinedId);
  if (!parent) return;
  const isPaid = (invId) => { const inv = findInvoice(invId); return !!inv && inv.status === 'paid'; };
  const bothPaid = isPaid(parent.purplInvoiceId) && isPaid(parent.lfInvoiceId);
  const now = new Date().toISOString();
  // Re-derive the parent's dollars from the CURRENT children — the stored
  // subtotals were copies frozen at creation, so editing a child's quantities
  // left the parent (document Amount Due, Stripe amount, tax export) at the
  // old number while the Invoices-page KPIs (children-based) showed the new one.
  const _childAmt = (invId, lf) => {
    const inv = lf ? DB.a('lf_invoices').find(x => x.id === invId) : findInvoice(invId);
    if (!inv) return null;
    return parseFloat(lf ? (inv.total != null ? inv.total : inv.amount) : (inv.amount != null ? inv.amount : inv.total)) || 0;
  };
  const newPSub = _childAmt(parent.purplInvoiceId, false);
  const newLSub = _childAmt(parent.lfInvoiceId, true);
  DB.atomicUpdate(cache => {
    const ci = (cache.combined_invoices||[]).findIndex(x => x.id === combinedId);
    if (ci < 0) return;
    let cur = cache.combined_invoices[ci];
    if (newPSub != null && newLSub != null) {
      // Shipping lives only on the parent's grandTotal (webhook adds it there,
      // child subtotals unchanged) — preserve that delta through the recompute.
      const extra = Math.max(0, (parseFloat(cur.grandTotal) || 0) - ((parseFloat(cur.purplSubtotal) || 0) + (parseFloat(cur.lfSubtotal) || 0)));
      cur = { ...cur, purplSubtotal: newPSub, lfSubtotal: newLSub, grandTotal: newPSub + newLSub + extra };
      cache.combined_invoices[ci] = cur;
    }
    if (bothPaid && cur.status !== 'paid') {
      cache.combined_invoices[ci] = {...cur, status:'paid', paidDate: cur.paidDate || now.slice(0,10), paidAt: cur.paidAt || now};
    } else if (!bothPaid && cur.status === 'paid') {
      cache.combined_invoices[ci] = {...cur, status:'sent', paidDate:null, paidAt:null};
    }
  });
}

// ── Invoice numbering ─────────────────────────────────────

function deleteCombinedInvoice(combinedId) {
  if (!_requireAdmin('delete invoices')) return;
  if (!confirm('Delete this combined invoice and its purpl + LF components? This will reverse any inventory deductions and reset linked portal orders so you can re-confirm.')) return;
  const rec = DB.a('combined_invoices').find(x => x.id === combinedId);
  if (!rec) return;
  auditLog('delete', 'combined_invoice', combinedId, rec.number || rec.invoiceNumber || combinedId);
  const portalOrderId = rec.portalOrderId;
  DB.atomicUpdate(cache => {
    cache.combined_invoices = (cache.combined_invoices||[]).filter(x => x.id !== combinedId);
    if (rec.purplInvoiceId) {
      cache.retail_invoices = (cache.retail_invoices||[]).filter(x => x.id !== rec.purplInvoiceId);
      // Remove any iv records that were either the invoice itself or its 'out' deductions
      cache.iv = (cache.iv||[]).filter(x => !(
        x.id === rec.purplInvoiceId ||
        (x.type === 'out' && (x.invoiceId === rec.purplInvoiceId || x.invoiceId === combinedId))
      ));
      // Remove the linked order
      cache.orders = (cache.orders||[]).filter(o => !(o.linkedPortalOrderId && o.accountId === rec.accountId && o.brand === 'purpl'));
    }
    if (rec.lfInvoiceId) {
      cache.lf_invoices = (cache.lf_invoices||[]).filter(x => x.id !== rec.lfInvoiceId);
      cache.lf_wix_deductions = (cache.lf_wix_deductions||[]).filter(d => d.invoiceId !== rec.lfInvoiceId);
      cache.orders = (cache.orders||[]).filter(o => !(o.linkedPortalOrderId && o.accountId === rec.accountId && o.brand === 'lf'));
    }
  });
  // Reset the portal order(s) so they can be re-confirmed
  if (portalOrderId) {
    const primaryOrder = PortalDB.getOrders().find(o => o.id === portalOrderId);
    const primaryTime = primaryOrder?.submittedAt?.toDate
      ? primaryOrder.submittedAt.toDate().getTime()
      : (primaryOrder?.submittedAt ? new Date(primaryOrder.submittedAt).getTime() : 0);
    firebase.firestore().collection('portal_orders').doc(portalOrderId)
      .update({ status: 'new', confirmedAt: null, convertedOrderId: null })
      .catch(e => console.warn('Could not reset portal order:', e));
    // Also reset the paired portal order from the same submission (same account, within 60s, different brand)
    firebase.firestore().collection('portal_orders')
      .where('accountId', '==', rec.accountId)
      .where('status', '==', 'confirmed').get()
      .then(snap => snap.docs.forEach(d => {
        if (d.id === portalOrderId) return;
        const data = d.data();
        if (!data.convertedOrderId) return;
        const dTime = data.submittedAt?.toDate ? data.submittedAt.toDate().getTime()
                    : (data.submittedAt ? new Date(data.submittedAt).getTime() : 0);
        if (primaryTime && dTime && Math.abs(dTime - primaryTime) < 60000 && data.brand !== primaryOrder?.brand) {
          d.ref.update({ status: 'new', confirmedAt: null, convertedOrderId: null });
        }
      }))
      .catch(() => {});
  }
  closeModal('modal-combined-invoice');
  renderInvoicesPage();
  if (typeof renderPreOrders === 'function') renderPreOrders(true);
  toast('Combined invoice deleted · portal order reset');
}

// Peek at what the next invoice number would be — no side effects, safe for modal preview
function _maxCachedInvoiceNum() {
  const nums = [
    ..._allPurplInvoices(),
    ...DB.a('lf_invoices'),
    ...DB.a('combined_invoices'),
    ...DB.a('dist_invoices'),
  ].map(x => {
    const n = parseInt((x.number||x.invoiceNumber||'').replace(/[^0-9]/g,''));
    return isNaN(n) ? 0 : n;
  });
  return nums.length ? Math.max(...nums) : 0;
}

function peekNextInvoiceNumber() {
  // nextInvoiceNum = the next number to ASSIGN. Preview = max(counter, cacheMax+1).
  const settingsNext = DB.obj('invoice_settings', {}).nextInvoiceNum || 0;
  return `INV-${String(Math.max(_maxCachedInvoiceNum() + 1, settingsNext)).padStart(4,'0')}`;
}

// Claim the next invoice number atomically via Firestore transaction.
// Prevents two tabs from claiming the same INV-XXXX.
async function getNextInvoiceNumber(type) {
  const configRef = firebase.firestore().collection('workspace').doc('main')
    .collection('config').doc('main');
  try {
    const num = await firebase.firestore().runTransaction(async tx => {
      const snap = await tx.get(configRef);
      const data = snap.data() || {};
      const invSettings = data.invoice_settings || {};
      // nextInvoiceNum = the next number to ASSIGN (server-authoritative counter).
      // Reserve `assign`, then advance the counter by 1 in the SAME transaction,
      // so two concurrent confirmers can never derive the same number. The
      // cacheMax floor only seeds/repairs the counter from existing invoices; it
      // is never the sole source. (The old code stored the *used* number and
      // re-derived the next value from stale local cache — that was the collision.)
      const serverNext = invSettings.nextInvoiceNum || 0;
      const assign = Math.max(serverNext, _maxCachedInvoiceNum() + 1);
      tx.update(configRef, { 'invoice_settings.nextInvoiceNum': assign + 1 });
      return `INV-${String(assign).padStart(4, '0')}`;
    });
    const n = parseInt(num.replace(/[^0-9]/g, ''));
    DB.setObj('invoice_settings', { ...DB.obj('invoice_settings', {}), nextInvoiceNum: n + 1 });
    return num;
  } catch (e) {
    console.warn('Invoice number transaction failed, retrying once:', e);
    // Retry the transaction once before falling back to cache
    try {
      const num = await firebase.firestore().runTransaction(async tx => {
        const snap = await tx.get(configRef);
        const data = snap.data() || {};
        const invSettings = data.invoice_settings || {};
        const serverNext = invSettings.nextInvoiceNum || 0;
        const assign = Math.max(serverNext, _maxCachedInvoiceNum() + 1);
        tx.update(configRef, { 'invoice_settings.nextInvoiceNum': assign + 1 });
        return `INV-${String(assign).padStart(4, '0')}`;
      });
      const n = parseInt(num.replace(/[^0-9]/g, ''));
      DB.setObj('invoice_settings', { ...DB.obj('invoice_settings', {}), nextInvoiceNum: n + 1 });
      return num;
    } catch (e2) {
      console.error('Invoice number transaction failed twice, using cache fallback:', e2);
      const num = peekNextInvoiceNumber();
      const n = parseInt(num.replace(/[^0-9]/g, ''));
      DB.setObj('invoice_settings', { ...DB.obj('invoice_settings', {}), nextInvoiceNum: n + 1 });
      // M6: the atomic allocator (Firestore transaction) is unreachable, so this
      // number is derived from local cache and is NOT collision-safe if another
      // user is creating an invoice at the same moment. Surface it so staff can
      // verify it isn't a duplicate, rather than failing silently.
      if (window.toast) toast('⚠️ Could not reach the server to reserve invoice number ' + num + '. Generated from local data — double-check it isn\'t a duplicate.', 9000);
      return num;
    }
  }
}

// ── New combined invoice modal ────────────────────────────

function openNewCombinedModal() {
  const accts = DB.a('ac').filter(a => a.isPbf).sort((a,b) => (a.name||'') < (b.name||'') ? -1 : 1);
  _populateAccountSelect('nciv-account', accts, '', 'Select account...');

  if (qs('#nciv-number')) qs('#nciv-number').value = peekNextInvoiceNumber();
  if (qs('#nciv-date')) qs('#nciv-date').value = today();
  const terms = DB.obj('invoice_settings',{}).terms || _payTerms();
  const d = new Date(Date.now() + terms * 86400000);
  if (qs('#nciv-due')) qs('#nciv-due').value = d.toISOString().slice(0,10);
  if (qs('#nciv-status')) qs('#nciv-status').value = 'draft';
  if (qs('#nciv-notes')) qs('#nciv-notes').value = '';
  if (qs('#nciv-delivery-date')) qs('#nciv-delivery-date').value = '';
  if (qs('#nciv-tracking')) qs('#nciv-tracking').value = '';

  _ncivRenderSkuRows();
  openModal('modal-new-combined');
}

function ncivAccountChanged() {
  _ncivRenderSkuRows();
}

function _ncivRenderSkuRows() {
  const acId = qs('#nciv-account')?.value;
  const ac = acId ? DB.a('ac').find(x => x.id === acId) : null;
  const isDist = ac?.fulfilledBy && ac.fulfilledBy !== 'direct';
  const purplPrice = parseFloat(isDist ? ac?.pricePerCaseDist : (ac?.pricePerCaseDirect || ac?.pricePerCaseCustom)) || 0;
  const costs = DB.obj('costs', {cogs:{}});
  const margin = costs.target_margin || _margin();
  const markup = 1 / Math.max(0.01, 1 - margin);

  // purpl SKU rows — same colored badge rows as the purpl invoice modal
  const purplEl = document.getElementById('nciv-purpl-skus');
  if (purplEl) {
    purplEl.innerHTML = IV_SKUS.map(sku => {
      const ppc = purplPrice || PURPL_DIRECT_PER_CASE;
      return `<div class="sku-row inv-sku-row ${SKU_MAP[sku.id]?.bg || ''}" data-sku="${sku.id}">
        ${skuBadge(sku.id)}
        <div class="inv-sku-inputs">
          <input class="nciv-p-cases inv-qty-input" data-sku="${sku.id}" type="number" min="0" step="1" value="0" oninput="_ncivCalcTotals()">
          <span class="inv-line-unit">cases</span>
          <input class="nciv-p-ppc inv-price-input" data-sku="${sku.id}" type="number" min="0" step="0.01" value="${ppc.toFixed(2)}" oninput="_ncivCalcTotals()">
          <span class="inv-line-unit">$/cs</span>
          <span class="nciv-p-line inv-line-total" data-sku="${sku.id}" style="color:#8B5FBF">$0.00</span>
        </div>
      </div>`;
    }).join('');
  }

  // LF SKU rows — priced per unit, sold in cases.
  // SKUs with variants get per-variant unit inputs so a case can be split
  // across variant types (e.g. a case of 6 scrunchies in mixed scents).
  const lfSkus = DB.a('lf_skus').filter(s => !s.archived);
  const lfEl = document.getElementById('nciv-lf-skus');
  if (lfEl) {
    lfEl.innerHTML = lfSkus.map(sku => {
      const unitPrice = sku.wholesalePrice || 0;
      const cs = sku.caseSize || 1;
      const variants = (sku.variants||[]).filter(v => !v.archived);
      if (variants.length > 0) {
        const varRows = variants.map(v => `
          <div class="inv-variant-row">
            <span class="inv-variant-name">${escHtml(v.name)}${_isRefillable(v.name) ? ' <span style="font-size:11px;color:#15803d">(Refillable)</span>' : ''}</span>
            <input class="nciv-lf-var-units inv-qty-input" data-sku="${sku.id}" data-variant="${v.id}" type="number" min="0" step="1" value="0" oninput="_ncivCalcTotals()">
            <span class="inv-line-unit">units</span>
          </div>`).join('');
        return `<div class="nciv-lf-row inv-line-block" data-sku="${sku.id}" data-casesize="${cs}">
          <div class="inv-line-head">
            <span class="inv-line-name">${escHtml(sku.name)} <span class="inv-line-unit">(${cs}/case · mix variants to split a case)</span></span>
            <input class="nciv-lf-ppc inv-price-input" data-sku="${sku.id}" type="number" min="0" step="0.01" value="${unitPrice.toFixed(2)}" oninput="_ncivCalcTotals()">
            <span class="inv-line-unit">/unit</span>
            <span class="nciv-lf-line inv-line-total" data-sku="${sku.id}" style="color:#4a7c59">$0.00</span>
          </div>
          ${varRows}
          <div class="nciv-lf-casecount inv-case-note" data-sku="${sku.id}"></div>
        </div>`;
      }
      return `<div class="nciv-lf-row inv-line-block" data-sku="${sku.id}" data-casesize="${cs}">
        <div class="inv-line-head">
          <span class="inv-line-name">${escHtml(sku.name)} <span class="inv-line-unit">(${cs}/case)</span></span>
          <input class="nciv-lf-cases inv-qty-input" data-sku="${sku.id}" type="number" min="0" step="1" value="0" oninput="_ncivCalcTotals()">
          <span class="inv-line-unit">cases</span>
          <input class="nciv-lf-ppc inv-price-input" data-sku="${sku.id}" type="number" min="0" step="0.01" value="${unitPrice.toFixed(2)}" oninput="_ncivCalcTotals()">
          <span class="inv-line-unit">/unit</span>
          <span class="nciv-lf-line inv-line-total" data-sku="${sku.id}" style="color:#4a7c59">$0.00</span>
        </div>
      </div>`;
    }).join('');
  }
  _ncivCalcTotals();
}

function _ncivCalcTotals() {
  let purplSub = 0;
  document.querySelectorAll('.nciv-p-cases').forEach(el => {
    const sku = el.dataset.sku;
    const cases = parseInt(el.value) || 0;
    const ppc = parseFloat(document.querySelector(`.nciv-p-ppc[data-sku="${sku}"]`)?.value) || 0;
    const line = cases * ppc;
    purplSub += line;
    const lineEl = document.querySelector(`.nciv-p-line[data-sku="${sku}"]`);
    if (lineEl) lineEl.textContent = '$' + line.toFixed(2);
  });

  let lfSub = 0;
  document.querySelectorAll('#nciv-lf-skus .nciv-lf-row').forEach(rowEl => {
    const sku = rowEl.dataset.sku;
    const unitPrice = parseFloat(rowEl.querySelector(`.nciv-lf-ppc[data-sku="${sku}"]`)?.value) || 0;
    const caseSize = parseInt(rowEl.dataset.casesize) || 1;
    let line = 0;
    const varInputs = rowEl.querySelectorAll('.nciv-lf-var-units');
    if (varInputs.length > 0) {
      let totalUnits = 0;
      varInputs.forEach(vi => { totalUnits += parseInt(vi.value) || 0; });
      line = totalUnits * unitPrice;
      const cc = rowEl.querySelector('.nciv-lf-casecount');
      if (cc) {
        if (totalUnits > 0) {
          const casesExact = totalUnits / caseSize;
          const whole = totalUnits % caseSize === 0;
          cc.innerHTML = `${totalUnits} units = ${whole ? casesExact : casesExact.toFixed(2)} case${casesExact === 1 ? '' : 's'}`
            + (whole ? '' : ` <span style="color:#d97706;font-weight:600">(partial case)</span>`);
        } else {
          cc.textContent = '';
        }
      }
    } else {
      const cases = parseInt(rowEl.querySelector('.nciv-lf-cases')?.value) || 0;
      line = cases * caseSize * unitPrice;
    }
    lfSub += line;
    const lineEl = rowEl.querySelector(`.nciv-lf-line[data-sku="${sku}"]`);
    if (lineEl) lineEl.textContent = '$' + line.toFixed(2);
  });

  document.getElementById('nciv-purpl-sub').textContent = '$' + purplSub.toFixed(2);
  document.getElementById('nciv-lf-sub').textContent = '$' + lfSub.toFixed(2);
  document.getElementById('nciv-grand-total').textContent = '$' + (purplSub + lfSub).toFixed(2);
}

let _saveCombInFlight = false;
async function saveNewCombinedInvoice() {
  if (_saveCombInFlight) return;
  _saveCombInFlight = true;
  setTimeout(() => { _saveCombInFlight = false; }, 2000);
  const accountId = document.getElementById('nciv-account').value;
  if (!accountId) { _saveCombInFlight = false; toast('Select an account'); return; }

  // Collect purpl lines from SKU rows
  const purplLines = [];
  document.querySelectorAll('.nciv-p-cases').forEach(el => {
    const skuId = el.dataset.sku;
    const cases = parseInt(el.value) || 0;
    if (!cases) return;
    const ppc = parseFloat(document.querySelector(`.nciv-p-ppc[data-sku="${skuId}"]`)?.value) || 0;
    const skuObj = IV_SKUS.find(s => s.id === skuId);
    purplLines.push({ skuId, sku: skuObj?.name || skuId, description: skuObj?.name || skuId, qty: cases, cases, units: cases * CANS_PER_CASE, unitPrice: ppc, pricePerCase: ppc, total: cases * ppc, lineTotal: cases * ppc });
  });

  // Collect LF lines from SKU rows — LF is priced per unit, sold in cases.
  // Variant SKUs collect per-variant units so cases can be split across types.
  const lfLines = [];
  document.querySelectorAll('#nciv-lf-skus .nciv-lf-row').forEach(rowEl => {
    const skuId = rowEl.dataset.sku;
    const unitPrice = parseFloat(rowEl.querySelector(`.nciv-lf-ppc[data-sku="${skuId}"]`)?.value) || 0;
    const skuObj = DB.a('lf_skus').find(s => s.id === skuId);
    const caseSize = skuObj?.caseSize || 1;
    const varInputs = rowEl.querySelectorAll('.nciv-lf-var-units');
    if (varInputs.length > 0) {
      const variantLines = [];
      varInputs.forEach(vi => {
        const units = parseInt(vi.value) || 0;
        if (!units) return;
        const variantObj = skuObj?.variants?.find(v => v.id === vi.dataset.variant);
        variantLines.push({
          variantId: vi.dataset.variant, variantName: variantObj?.name || '',
          units, cases: +(units / caseSize).toFixed(2), lineTotal: units * unitPrice,
        });
      });
      if (!variantLines.length) return;
      const totalUnits = variantLines.reduce((s,v) => s + v.units, 0);
      const totalCases = +(totalUnits / caseSize).toFixed(2);
      const lineTotal  = variantLines.reduce((s,v) => s + v.lineTotal, 0);
      lfLines.push({ skuId, skuName: skuObj?.name || skuId, description: skuObj?.name || skuId, qty: totalCases, cases: totalCases, units: totalUnits, caseSize, unitPrice, pricePerUnit: unitPrice, pricePerCase: caseSize * unitPrice, total: lineTotal, lineTotal, hasVariants: true, variantLines });
      return;
    }
    const cases = parseInt(rowEl.querySelector('.nciv-lf-cases')?.value) || 0;
    if (!cases) return;
    const units = cases * caseSize;
    const lineTotal = units * unitPrice;
    lfLines.push({ skuId, skuName: skuObj?.name || skuId, description: skuObj?.name || skuId, qty: cases, cases, units, caseSize, unitPrice, pricePerUnit: unitPrice, pricePerCase: caseSize * unitPrice, total: lineTotal, lineTotal, hasVariants: false });
  });

  if (!purplLines.length && !lfLines.length) { _saveCombInFlight = false; toast('Add at least one case quantity'); return; }  // LOW-5

  const account  = DB.a('ac').find(x => x.id === accountId) || {};
  const due      = qs('#nciv-due')?.value || '';
  const issued   = qs('#nciv-date')?.value || today();
  const status   = qs('#nciv-status')?.value || 'draft';
  const notes    = qs('#nciv-notes')?.value || '';
  const userNum  = qs('#nciv-number')?.value?.trim() || '';
  const deliveryMethod = qs('#nciv-delivery-method')?.value || 'deliver';
  const fulfillmentSource = qs('#nciv-fulfillment')?.value || 'warehouse';
  const deliveryDate   = qs('#nciv-delivery-date')?.value || '';
  const trackingNumber = qs('#nciv-tracking')?.value?.trim() || '';
  const purplSub = purplLines.reduce((s,l) => s + (l.total||0), 0);
  const lfSub    = lfLines.reduce((s,l) => s + (l.total||0), 0);

  // Read next numbers atomically before any write
  const purplNum = await getNextInvoiceNumber('purpl');
  const lfNum    = await getNextInvoiceNumber('lf');
  const combNum  = userNum || await getNextInvoiceNumber('combined');
  const purplId  = uid();
  const lfId     = uid();
  const combId   = uid();

  const purplInv = {
    id: purplId, number: purplNum, invoiceNumber: purplNum, accountId, accountName: account.name||'',
    date: issued, dueDate: due, total: purplSub, amount: purplSub, status, lineItems: purplLines,
    notes, deliveryMethod, fulfillmentSource, deliveryDate, trackingNumber, combinedInvoiceId: combId, source: 'manual',
  };
  const lfInv = {
    id: lfId, number: lfNum, invoiceNumber: lfNum, accountId, accountName: account.name||'',
    date: issued, dueDate: due, total: lfSub, status,
    lineItems: lfLines,
    notes, deliveryMethod, fulfillmentSource, deliveryDate, trackingNumber, wixPulled: false, combinedInvoiceId: combId, source: 'manual',
  };
  const combInv = {
    id: combId, number: combNum, invoiceNumber: combNum,
    purplInvoiceId: purplId, lfInvoiceId: lfId,
    accountId, accountName: account.name||'', status,
    date: issued, dueDate: due,
    createdAt: new Date().toISOString(), sentAt: null, paidAt: null, portalOrderId: null,
    purplSubtotal: purplSub, lfSubtotal: lfSub, grandTotal: purplSub + lfSub,
    notes, deliveryMethod, fulfillmentSource, deliveryDate, trackingNumber, source: 'manual',
  };

  DB.atomicUpdate(cache => {
    cache.retail_invoices   = [...(cache.retail_invoices||[]),   purplInv];
    cache.lf_invoices       = [...(cache.lf_invoices||[]),      lfInv];
    cache.combined_invoices = [...(cache.combined_invoices||[]), combInv];
    // Deduct purpl inventory for non-draft invoices (LF inventory managed on Wix)
    // Draft invoices get deducted when marked as sent via markInvoiceSent()
    if (status !== 'draft') {
      const purplIvEntries = purplLines.map(li => ({
        id: uid(), date: issued, sku: li.skuId || li.sku, type: 'out',
        qty: (li.cases || 0) * CANS_PER_CASE,
        pool: fulfillmentSource,
        note: 'Invoice ' + combNum, invoiceId: purplId,
      })).filter(e => e.qty > 0);
      if (purplIvEntries.length) {
        cache.iv = [...(cache.iv||[]), ...purplIvEntries];
      }
    }
  });

  closeModal('modal-new-combined');
  renderInvoicesPage();
  toast('Combined invoice created — ' + combNum);
  setTimeout(() => openCombinedInvoicePreview(combId), 300);
}

// Shared payment-options HTML block used by print/PDF views and emails.
// `payLink` is the per-invoice Stripe Checkout URL (or null).
function _buildPaymentHTML(payLink) {
  const s = DB.obj('invoice_settings', {});
  // Only a per-invoice Checkout link gets a Pay button. The generic account
  // stripeLink carried no invoice metadata, so the webhook could not match
  // the payment — customer paid, CRM kept dunning them.
  const link = payLink || '';
  const otherMethods = [];
  if (s.achRouting) otherMethods.push(`<strong>ACH / Wire:</strong> Routing ${s.achRouting} · Account ${s.achAccount || '—'}`);
  if (s.checkInstructions || s.paymentInstructions) otherMethods.push(escHtml(s.checkInstructions || s.paymentInstructions));
  if (!otherMethods.length) otherMethods.push('Make checks payable to <strong>Pumpkin Blossom Farm LLC</strong>');
  return `${link ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px">
    <tr><td align="center" style="padding:0">
      <table cellpadding="0" cellspacing="0"><tr><td align="center" style="background:#1a1a2e;border-radius:6px">
        <a href="${link}" target="_blank" style="display:inline-block;padding:14px 40px;font-family:Inter,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:0.04em">Pay Online</a>
      </td></tr></table>
    </td></tr>
  </table>` : ''}
  <div style="font-size:12px;color:#6b7280;line-height:1.8;${link ? 'border-top:1px solid #e5e7eb;padding-top:10px;margin-top:2px' : ''}">
    ${otherMethods.join('<br>')}
  </div>`;
}

// ── Invoice legal terms (fine print) ──────────────────────

const DEFAULT_INVOICE_LEGAL_TERMS = `Wholesale Terms — From Our Field to Your Front Door
We're honored to have our products on your shelves!
Wholesale Payment Terms: Net 30 from the invoice date. A 2% monthly finance charge may apply to late payments.
Shipping: Calculated and included on your invoice unless other delivery methods have been arranged.
Order Issues: Please inspect your shipment upon arrival. Let us know within 7 days if anything needs our attention — we're here to make it right.
Pricing Notice: We reserve the right to update pricing with 30 days' notice, but we'll always keep you in the loop.`;

function _invoiceLegalTermsText() {
  const s = DB.obj('invoice_settings', {});
  // null/undefined = never customized → use default. Empty string = user cleared it on purpose.
  return s.legalTerms != null ? s.legalTerms : DEFAULT_INVOICE_LEGAL_TERMS;
}

// Renders the fine-print block used at the bottom of every invoice
// (emails + print/PDF). First line is the heading; "Label: text" lines
// get a bold label.
function _legalTermsHTML() {
  const text = (_invoiceLegalTermsText() || '').trim();
  if (!text) return '';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const title = lines.shift() || '';
  const body = lines.map(l => {
    const m = l.match(/^([^:]{2,40}):\s+(.*)$/);
    return m
      ? `<div style="margin-top:3px"><strong style="color:#6b7280">${escHtml(m[1])}:</strong> ${escHtml(m[2])}</div>`
      : `<div style="margin-top:3px">${escHtml(l)}</div>`;
  }).join('');
  return `<div style="font-size:10px;color:#6b7280;line-height:1.6;text-align:left">
    <div style="font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#4b5563;font-size:10px;margin-bottom:3px">${escHtml(title)}</div>
    ${body}
  </div>`;
}

// Small "Delivered / Tracking" lines for the invoice details column.
function _deliveryDetailsHTML(deliveryDate, tracking, style) {
  const fmtLong = s => { try { return new Date(s+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); } catch(e) { return s; } };
  let out = '';
  if (deliveryDate) out += `<div style="${style}">Delivery: <strong>${fmtLong(deliveryDate)}</strong></div>`;
  if (tracking)     out += `<div style="${style}">Tracking: <strong>${escHtml(tracking)}</strong></div>`;
  return out;
}

// ── Unified invoice document ──────────────────────────────
// ONE layout for every invoice (purpl-only, LF-only, combined) and every
// channel (email + print/PDF + preview). Table-based markup only — Gmail
// and Outlook strip flexbox, which used to scramble the Amount Due row.

function _normShippingLines(inv) {
  return (inv.lineItems || []).filter(li => li.skuId === '__shipping__').map(li => ({
    name: li.description || li.skuName || 'Shipping',
    sub: li.carrier ? 'via ' + li.carrier : '',
    qty: '', price: '',
    total: parseFloat(li.lineTotal || li.total || li.pricePerCase || 0),
  }));
}

function _normPurplLines(inv) {
  const raw = (inv.lineItems && inv.lineItems.length) ? inv.lineItems
    : ((inv.cases || inv.amount) ? [{ skuName: 'Classic Lavender Lemonade', cases: inv.cases || 0, pricePerCase: inv.pricePerCase || 0, lineTotal: inv.amount != null ? inv.amount : (inv.total || 0) }] : []);
  const lines = raw.filter(li => li.skuId !== '__shipping__');
  return lines.map(li => {
    const cases = li.cases || li.qty || 0;
    const ppc = parseFloat(li.pricePerCase != null ? li.pricePerCase : (li.unitPrice || 0)) || 0;
    const total = parseFloat(li.lineTotal != null ? li.lineTotal : (li.total != null ? li.total : cases * ppc)) || 0;
    return {
      name: li.skuName || li.sku || li.description || 'purpl Lemonade',
      sub: `${cases * CANS_PER_CASE} cans · 12-pack cases`,
      qty: cases + ' cs',
      price: '$' + ppc.toFixed(2) + '/cs',
      total,
    };
  });
}

function _normLfLines(inv) {
  const out = [];
  (inv.lineItems || []).filter(li => li.skuId !== '__shipping__').forEach(li => {
    const up = parseFloat(li.unitPrice != null ? li.unitPrice : (li.pricePerUnit || 0)) || 0;
    if (li.hasVariants && li.variantLines && li.variantLines.length) {
      li.variantLines.forEach(vl => {
        const units = vl.units || 0;
        out.push({
          name: `${li.skuName || 'Item'} — ${vl.variantName || ''}${_isRefillable(vl.variantName) ? ' (Refillable)' : ''}`,
          sub: '', qty: units + '', price: '$' + up.toFixed(2),
          total: parseFloat(vl.lineTotal) || units * up,
        });
      });
    } else {
      const units = li.units || 0;
      out.push({
        name: li.skuName || li.description || 'Item',
        sub: '', qty: units + '', price: '$' + up.toFixed(2),
        total: parseFloat(li.lineTotal != null ? li.lineTotal : li.total) || units * up,
      });
    }
  });
  return out;
}

function buildInvoiceDocHTML(o) {
  const fmtLong = s => { if (!s) return ''; try { return new Date(s + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); } catch (e) { return s; } };
  const issueDate = fmtLong(o.issueDate) || fmtLong(today());
  const dueDate   = fmtLong(o.dueDate);
  const isPaid    = o.status === 'paid';

  const cell = 'padding:10px 0;font-size:13px;border-bottom:1px solid #e5e7eb;color:#1a1a2e';
  const headTh = a => `text-align:${a};font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#6b7280;font-weight:600;padding:6px 0;border-bottom:1px solid #1a1a2e`;
  const tableHeader = `<thead><tr>
    <th style="${headTh('left')}">Item</th>
    <th style="${headTh('right')}">Qty</th>
    <th style="${headTh('right')}">Price</th>
    <th style="${headTh('right')}">Total</th>
  </tr></thead>`;
  const rowHtml = r => `<tr>
    <td style="${cell}">${escHtml(r.name)}${r.sub ? `<div style="font-size:11px;color:#6b7280;margin-top:2px">${escHtml(r.sub)}</div>` : ''}</td>
    <td style="${cell};text-align:right;white-space:nowrap">${escHtml(String(r.qty))}</td>
    <td style="${cell};text-align:right;white-space:nowrap">${escHtml(r.price)}</td>
    <td style="${cell};text-align:right;font-weight:600;white-space:nowrap">$${(r.total || 0).toFixed(2)}</td>
  </tr>`;

  const sectionLabel = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#6b7280;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #1a1a2e';
  const purplLines = o.purplLines || [];
  const lfLines    = o.lfLines || [];
  const both       = purplLines.length > 0 && lfLines.length > 0;

  const section = (label, shortLabel, rows, subtotal) => `
  <tr><td style="padding:0 48px">
    <div style="${sectionLabel}">${label}</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:14px">${tableHeader}<tbody>${rows.map(rowHtml).join('') || `<tr><td colspan="4" style="font-size:13px;color:#9ca3af;padding:10px 0">No items</td></tr>`}</tbody></table>
    ${both ? `<div style="text-align:right;padding:6px 0 20px">
      <span style="font-size:12px;color:#6b7280">${shortLabel} Subtotal&nbsp;&nbsp;</span>
      <span style="font-size:14px;font-weight:600;color:#1a1a2e">$${(parseFloat(subtotal != null ? subtotal : rows.reduce((s2, r) => s2 + r.total, 0)) || 0).toFixed(2)}</span>
    </div>` : `<div style="padding:0 0 10px"></div>`}
  </td></tr>`;

  const grandTotal = parseFloat(o.grandTotal || 0);

  const paymentSection = isPaid
    ? `<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:14px 20px;font-size:13px;color:#166534;text-align:center">
        This invoice has been paid${o.paidAt ? ' — ' + fmtLong(String(o.paidAt).slice(0,10)) : ''}. Thank you!
      </td></tr></table>`
    : `<table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:0">
        ${_buildPaymentHTML(o.payLink)}
      </td></tr></table>`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${escHtml(o.number || '')}</title>
<style>
  @page { size: letter; margin: 0.5in; }
  @media print {
    body { background:#fff !important; padding:0 !important; }
    .invoice-wrap { padding:0 !important; }
    .invoice-card { border:none !important; max-width:100% !important; width:100% !important; }
    .no-print { display:none !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:Inter,Arial,sans-serif;color:#1a1a2e">
${o.printButton ? `<div class="no-print" style="position:fixed;top:14px;right:14px;z-index:10"><button onclick="window.print()" style="background:#7B4FA0;color:#fff;border:none;padding:10px 22px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.2)">\ud83d\udda8\ufe0f Print / Save as PDF</button></div>` : ''}
<table class="invoice-wrap" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
<tr><td align="center">
<table class="invoice-card" width="720" cellpadding="0" cellspacing="0" style="max-width:720px;width:100%;background:#ffffff;border:1px solid #e5e7eb;border-radius:6px">

  <tr><td style="padding:36px 48px 20px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle">
        <table cellpadding="0" cellspacing="0">
          <tr>
            <td style="vertical-align:middle;padding-right:18px">
              <img src="https://static.wixstatic.com/media/81a2ff_1e3f6923c1d5495082d490b4cc229e1c~mv2.png/v1/fill/w_176,h_71,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Purpl%20Logo%20-%20Sprig%20in%20front%20-%20transparent.png"
                alt="purpl" width="140" height="56" style="display:block">
            </td>
            <td style="vertical-align:middle;padding:0 4px">
              <div style="width:1px;height:44px;background:#d1d5db"></div>
            </td>
            <td style="vertical-align:middle;padding-left:18px">
              <img src="https://purpl-crm.web.app/images/lf-logo-circle-transparent.png"
                alt="Lavender Fields" width="52" height="52" style="display:block">
            </td>
          </tr>
        </table>
      </td>
      <td align="right" style="vertical-align:middle">
        <div style="font-size:24px;font-weight:700;color:#1a1a2e;letter-spacing:1px">INVOICE</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px;letter-spacing:0.03em">${escHtml(o.number || '')}</div>
        ${isPaid ? `<div style="margin-top:6px"><span style="display:inline-block;background:#dcfce7;color:#166534;font-size:11px;font-weight:700;padding:3px 12px;border-radius:20px;letter-spacing:0.08em">PAID</span></div>` : ''}
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="padding:8px 48px 28px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:top;width:55%">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6b7280;margin-bottom:6px;font-weight:600">Billed To</div>
        <div style="font-size:15px;font-weight:600;color:#1a1a2e">${escHtml(o.accountName || '')}</div>
        ${o.accountEmail ? `<div style="font-size:13px;color:#4b5563;margin-top:3px">${escHtml(o.accountEmail)}</div>` : ''}
        ${o.accountAddress ? `<div style="font-size:13px;color:#4b5563;margin-top:2px">${escHtml(o.accountAddress)}</div>` : ''}
      </td>
      <td style="vertical-align:top;text-align:right">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6b7280;margin-bottom:6px;font-weight:600">Invoice Details</div>
        <div style="font-size:13px;color:#1a1a2e">Issued: <strong>${issueDate}</strong></div>
        ${dueDate ? `<div style="font-size:13px;color:#1a1a2e;margin-top:2px">Due: <strong>${dueDate}</strong></div>` : ''}
        ${o.terms ? `<div style="font-size:13px;color:#1a1a2e;margin-top:2px">Terms: <strong>${escHtml(o.terms)}</strong></div>` : ''}
        ${_deliveryDetailsHTML(o.deliveryDate, o.tracking, 'font-size:13px;color:#1a1a2e;margin-top:2px')}
      </td>
    </tr></table>
  </td></tr>

  ${purplLines.length ? section('purpl Lemonade', 'purpl', purplLines, o.purplSubtotal) : ''}
  ${lfLines.length ? section('Lavender Fields at Pumpkin Blossom Farm', 'LF', lfLines, o.lfSubtotal) : ''}
  ${(o.shippingLines||[]).length ? `<tr><td style="padding:0 48px 12px">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e5e7eb;padding-top:10px">
      ${o.shippingLines.map(sl => `<tr>
        <td style="font-size:13px;color:#1a1a2e;padding:4px 0">${escHtml(sl.name)}${sl.sub ? ' <span style="color:#6b7280;font-size:11px">' + escHtml(sl.sub) + '</span>' : ''}</td>
        <td style="text-align:right;font-size:13px;font-weight:600;color:#1a1a2e;padding:4px 0">$${sl.total.toFixed(2)}</td>
      </tr>`).join('')}
    </table>
  </td></tr>` : ''}

  <tr><td style="padding:0 48px 24px">
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #1a1a2e">
      <tr>
        <td style="padding-top:16px;font-size:14px;font-weight:600;color:#1a1a2e;text-transform:uppercase;letter-spacing:0.05em">Amount Due</td>
        <td style="padding-top:16px;text-align:right;font-size:26px;font-weight:700;color:#1a1a2e;white-space:nowrap">$${grandTotal.toFixed(2)}</td>
      </tr>
    </table>
    ${(o.terms || dueDate) ? `<div style="font-size:11px;color:#6b7280;margin-top:6px;text-align:right">${escHtml(o.terms || '')}${o.terms && dueDate ? ' · ' : ''}${dueDate ? 'Due ' + dueDate : ''}</div>` : ''}
  </td></tr>

  <tr><td style="padding:0 48px 24px">
    ${paymentSection}
  </td></tr>

  ${o.notes ? `<tr><td style="padding:0 48px 24px">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#6b7280;margin-bottom:6px;font-weight:600">Notes</div>
    <div style="font-size:13px;color:#1a1a2e;padding:12px 14px;background:#f9fafb;border-radius:4px;border-left:3px solid #1a1a2e;white-space:pre-wrap">${escHtml(o.notes)}</div>
  </td></tr>` : ''}

  ${o.portalLink ? `<tr><td style="padding:0 48px 20px;text-align:center"><a href="${o.portalLink}" style="font-size:13px;color:#8B5FBF;text-decoration:none">Place your next order →</a></td></tr>` : ''}

  ${_legalTermsHTML() ? `<tr><td style="padding:0 48px 24px">${_legalTermsHTML()}</td></tr>` : ''}

  ${(DB.obj('invoice_settings',{}).footerNotes||'').trim() ? `<tr><td style="padding:0 48px 16px;font-size:12px;color:#6b7280;line-height:1.6">${escHtml(DB.obj('invoice_settings',{}).footerNotes.trim())}</td></tr>` : ''}

  <tr><td style="padding:20px 48px;border-top:1px solid #e5e7eb;text-align:center;font-size:11px;color:#4b5563;line-height:1.8">
    <strong style="color:#1a1a2e">${escHtml(DB.obj('invoice_settings',{}).fromName || 'Pumpkin Blossom Farm LLC')}</strong> · ${escHtml((DB.obj('invoice_settings',{}).fromAddress || '393 Pumpkin Hill Rd, Warner, NH 03278').replace(/,\s*/g,' · '))}<br>
    <a href="mailto:lavender@pbfwholesale.com" style="color:#4b5563;text-decoration:none">lavender@pbfwholesale.com</a> · 603-748-3038
  </td></tr>

</table></td></tr></table></body></html>`;
}

// ── Per-type wrappers — all feed the same unified template ───

function buildCombinedInvoiceHTML(combinedId, payLink, opts) {
  const rec = DB.a('combined_invoices').find(x => x.id === combinedId);
  if (!rec) return '';
  if (payLink) rec._payLink = payLink;
  const purplInv = findInvoice(rec.purplInvoiceId) || {};
  const lfInv    = DB.a('lf_invoices').find(x => x.id === rec.lfInvoiceId) || {};
  const account  = DB.a('ac').find(x => x.id === rec.accountId) || {};
  return buildInvoiceDocHTML({
    number: rec.number || rec.invoiceNumber || '',
    status: rec.status,
    paidAt: rec.paidAt,
    accountName: rec.accountName || account.name || '',
    accountEmail: account.email || '',
    accountAddress: account.address || '',
    issueDate: rec.date,
    dueDate: rec.dueDate || rec.due,
    terms: rec.paymentTerms || 'Net 30',
    deliveryDate: rec.deliveryDate || purplInv.deliveryDate || lfInv.deliveryDate || '',
    tracking: rec.trackingNumber || purplInv.trackingNumber || lfInv.trackingNumber || '',
    purplLines: _normPurplLines(purplInv),
    lfLines: _normLfLines(lfInv),
    shippingLines: _normShippingLines(rec),
    purplSubtotal: rec.purplSubtotal,
    lfSubtotal: rec.lfSubtotal,
    grandTotal: rec.grandTotal,
    notes: rec.notes || '',
    payLink: rec._payLink || null,
    printButton: !!(opts && opts.printButton),
  });
}

function buildPurplInvoiceEmailHTML(inv, opts) {
  const ac = DB.a('ac').find(x => x.id === inv.accountId) || {};
  return buildInvoiceDocHTML({
    number: inv.number || inv.invoiceNumber || '',
    status: inv.status,
    paidAt: inv.paidAt,
    accountName: ac.name || inv.accountName || '',
    accountEmail: ac.email || '',
    accountAddress: ac.address || '',
    issueDate: inv.date,
    dueDate: inv.due || inv.dueDate,
    terms: _invTermsLabel(inv),
    deliveryDate: inv.deliveryDate || '',
    tracking: inv.trackingNumber || '',
    purplLines: _normPurplLines(inv),
    lfLines: [],
    shippingLines: _normShippingLines(inv),
    grandTotal: inv.amount != null ? inv.amount : (inv.total || 0),
    notes: inv.notes || '',
    payLink: inv._payLink || null,
    portalLink: ac.orderPortalToken ? `https://pbfwholesale.com/order?t=${ac.orderPortalToken}` : null,
    printButton: !!(opts && opts.printButton),
  });
}

function buildLfInvoiceEmailHTML(inv, opts) {
  const ac = DB.a('ac').find(x => x.id === inv.accountId) || {};
  const s  = DB.obj('invoice_settings', {});
  return buildInvoiceDocHTML({
    number: inv.number || inv.invoiceNumber || '',
    status: inv.status,
    paidAt: inv.paidAt,
    accountName: ac.name || inv.accountName || '',
    accountEmail: ac.email || '',
    accountAddress: ac.address || '',
    issueDate: inv.issued || inv.date,
    dueDate: inv.due || inv.dueDate,
    terms: 'Net ' + (s.terms || 30),
    deliveryDate: inv.deliveryDate || '',
    tracking: inv.trackingNumber || '',
    purplLines: [],
    lfLines: _normLfLines(inv),
    shippingLines: _normShippingLines(inv),
    grandTotal: inv.total || 0,
    notes: inv.notes || '',
    payLink: inv._payLink || null,
    printButton: !!(opts && opts.printButton),
  });
}

// Distributor invoice → the same shared branded document as retail/LF.
// Dist records store items[{sku,cases,pricePerCase}], billed-to comes from the
// distributor profile + primary rep, and the PO reference rides in the notes line.
function buildDistInvoiceEmailHTML(inv, opts) {
  const d  = DB.a('dist_profiles').find(x => x.id === inv.distId) || {};
  const rep = DB.a('dist_reps').find(r => r.distId === inv.distId && r.email) || {};
  const s  = DB.obj('invoice_settings', {});
  const lines = (inv.items || []).map(it => {
    const skuObj = SKUS.find(k => k.id === it.sku);
    const ppc = parseFloat(it.pricePerCase) || 0;
    const cases = it.cases || 0;
    return {
      name: skuObj?.label || skuObj?.name || it.sku,
      sub: `${cases * CANS_PER_CASE} cans · 12-pack cases`,
      qty: cases + ' cs',
      price: '$' + ppc.toFixed(2) + '/cs',
      total: cases * ppc,
    };
  });
  const poLine = [inv.poRef ? 'PO: ' + inv.poRef : '', inv.externalRef ? 'Ref: ' + inv.externalRef : '']
    .filter(Boolean).join(' · ');
  return buildInvoiceDocHTML({
    number: inv.number || inv.invoiceNumber || '',
    status: inv.status,
    paidAt: inv.paidAt,
    accountName: d.name || inv.distName || '',
    accountEmail: rep.email || d.email || '',
    accountAddress: d.address || '',
    issueDate: inv.dateIssued || inv.date,
    dueDate: inv.dueDate || inv.due,
    terms: 'Net ' + (s.terms || 30),
    deliveryDate: '',
    tracking: '',
    purplLines: lines,
    lfLines: [],
    shippingLines: [],
    grandTotal: parseFloat(inv.total) || 0,
    notes: [poLine, inv.notes || ''].filter(Boolean).join('\n'),
    payLink: inv._payLink || null,
    printButton: !!(opts && opts.printButton),
  });
}

// Combined invoice → same shared document as purpl/LF, with both the purpl and
// LF line sections populated from the two child invoices, so the Preview looks
// identical across all invoice types.
function buildCombinedInvoiceEmailHTML(inv, opts) {
  const ac = DB.a('ac').find(x => x.id === inv.accountId) || {};
  const s  = DB.obj('invoice_settings', {});
  const purplChild = inv.purplInvoiceId ? DB.a('retail_invoices').find(x => x.id === inv.purplInvoiceId) : null;
  const lfChild    = inv.lfInvoiceId ? DB.a('lf_invoices').find(x => x.id === inv.lfInvoiceId) : null;
  return buildInvoiceDocHTML({
    number: inv.number || inv.invoiceNumber || '',
    status: inv.status,
    paidAt: inv.paidAt,
    accountName: ac.name || inv.accountName || '',
    accountEmail: ac.email || '',
    accountAddress: ac.address || '',
    issueDate: inv.date || inv.issued,
    dueDate: inv.dueDate || inv.due,
    terms: 'Net ' + (s.terms || 30),
    deliveryDate: inv.deliveryDate || '',
    tracking: inv.trackingNumber || '',
    purplLines: purplChild ? _normPurplLines(purplChild) : [],
    lfLines:    lfChild ? _normLfLines(lfChild) : [],
    shippingLines: [
      ...(purplChild ? _normShippingLines(purplChild) : []),
      ...(lfChild ? _normShippingLines(lfChild) : []),
    ],
    grandTotal: inv.grandTotal != null ? inv.grandTotal : ((purplChild?.total || 0) + (lfChild?.total || 0)),
    notes: inv.notes || '',
    payLink: inv._payLink || null,
    printButton: !!(opts && opts.printButton),
  });
}

// Unified single-brand (purpl / LF) invoice console — reuses the combined
// modal shell so purpl and LF invoices get the same in-app document + edit +
// "Send Invoice to Customer" experience (no browser tabs). Combined delegates
// to its own tested function below.
async function openInvoicePreview(type, id) {
  if (type === 'combined') return openCombinedInvoicePreview(id);
  // _invoiceCol so legacy purpl invoices stored in the iv collection preview
  // and save to the right place instead of "Invoice not found".
  const col = type === 'dist' ? 'dist_invoices' : (type === 'lf' ? 'lf_invoices' : _invoiceCol(id));
  const rec = DB.a(col).find(x => x.id === id);
  if (!rec) { toast('Invoice not found'); return; }
  toast('Loading preview…');
  if (!rec.number && !rec.invoiceNumber) {
    const n = await getNextInvoiceNumber(type === 'dist' ? 'dist' : (type === 'lf' ? 'lf' : 'purpl'));
    DB.update(col, id, x => ({ ...x, number: n, invoiceNumber: n }));
    rec.number = n; rec.invoiceNumber = n;
  }
  // Recipient identity: accounts for retail/LF; distributor profile + primary rep for dist.
  const _distProfile = type === 'dist' ? (DB.a('dist_profiles').find(x => x.id === rec.distId) || {}) : null;
  const _distRep = type === 'dist' ? (DB.a('dist_reps').find(r => r.distId === rec.distId && r.email) || {}) : null;
  const account = type === 'dist'
    ? { name: _distProfile.name || rec.distName || '', email: _distRep.email || _distProfile.email || '' }
    : (DB.a('ac').find(x => x.id === rec.accountId) || {});
  let payLink = null;
  if (rec.status !== 'paid') { try { payLink = await _getStripePayLink(rec, type === 'dist' ? 'dist' : (type === 'lf' ? 'lf' : 'retail')); } catch (e) { payLink = null; } }
  const recForDoc = payLink ? { ...rec, _payLink: payLink } : rec;
  const buildDoc = opts => type === 'dist' ? buildDistInvoiceEmailHTML(recForDoc, opts)
    : (type === 'lf' ? buildLfInvoiceEmailHTML(recForDoc, opts) : buildPurplInvoiceEmailHTML(recForDoc, opts));
  const html = buildDoc({});
  const total = (type === 'lf' || type === 'dist') ? (parseFloat(rec.total) || 0) : (rec.amount != null ? rec.amount : (rec.total || 0));
  const st = rec.status || 'draft';
  const stColor = { draft:'gray', sent:'blue', paid:'green', overdue:'red', void:'red' };

  const h2 = document.querySelector('#modal-combined-invoice .modal-hdr h2');
  if (h2) h2.textContent = type === 'dist' ? 'Distributor Invoice' : (type === 'lf' ? 'Lavender Fields Invoice' : 'purpl Invoice');
  if (qs('#civ-account-name')) qs('#civ-account-name').textContent = rec.accountName || rec.distName || account.name || '';
  if (qs('#civ-invoice-nums')) qs('#civ-invoice-nums').innerHTML = (rec.number || rec.invoiceNumber || '') +
    ` <span class="badge ${stColor[st]||'gray'}" style="margin-left:8px;text-transform:uppercase;font-size:10px">${st}</span>`;

  // Single brand: show only this brand's subtotal row + grand total
  const purplRow = qs('#civ-purpl-sub')?.parentElement;
  const lfRow = qs('#civ-lf-sub')?.parentElement;
  if (type === 'dist') {
    // Dist has no brand subtotals — grand total only.
    if (purplRow) purplRow.style.display = 'none';
    if (lfRow) lfRow.style.display = 'none';
  } else if (type === 'lf') {
    if (purplRow) purplRow.style.display = 'none';
    if (lfRow) { lfRow.style.display = ''; qs('#civ-lf-sub').textContent = '$' + total.toFixed(2); }
  } else {
    if (lfRow) lfRow.style.display = 'none';
    if (purplRow) { purplRow.style.display = ''; qs('#civ-purpl-sub').textContent = '$' + total.toFixed(2); }
  }
  if (qs('#civ-grand-total')) qs('#civ-grand-total').textContent = '$' + total.toFixed(2);

  if (qs('#civ-edit-date')) qs('#civ-edit-date').value = rec.dateIssued || rec.date || rec.issued || today();
  if (qs('#civ-edit-due')) qs('#civ-edit-due').value = rec.dueDate || rec.due || '';
  if (qs('#civ-edit-terms')) qs('#civ-edit-terms').value = rec.paymentTerms || 'Net 30';
  if (qs('#civ-edit-notes')) qs('#civ-edit-notes').value = rec.notes || '';
  const delivSel = qs('#civ-edit-delivery');
  if (delivSel) delivSel.value = rec.deliveryMethod || 'deliver';
  const fulfillSel = qs('#civ-edit-fulfillment');
  if (fulfillSel) fulfillSel.value = rec.fulfillmentSource || 'warehouse';

  const shipBtn = qs('#civ-btn-ship');
  const whBtn = qs('#civ-btn-warehouse');
  const _updateFulfillBtns = () => {
    if (shipBtn) {
      shipBtn.style.display = delivSel?.value === 'ship' ? '' : 'none';
      if (rec.shipStationOrderId) { shipBtn.textContent = '✓ Pushed to ShipStation'; shipBtn.disabled = true; }
      else { shipBtn.textContent = '📦 Push to ShipStation'; shipBtn.disabled = false; }
    }
    if (whBtn) {
      whBtn.style.display = fulfillSel?.value === 'warehouse' ? '' : 'none';
      if (rec.warehousePushedAt) { whBtn.textContent = '✓ Sent to Warehouse'; whBtn.disabled = true; }
      else { whBtn.textContent = '🏭 Push to Warehouse'; whBtn.disabled = false; }
    }
  };
  _updateFulfillBtns();
  if (type === 'dist') {
    // Delivery/fulfillment workflow doesn't apply to distributor invoices —
    // stock moves at Log Shipment, not invoice send.
    if (delivSel?.parentElement) delivSel.parentElement.style.display = 'none';
    if (fulfillSel?.parentElement) fulfillSel.parentElement.style.display = 'none';
    if (shipBtn) shipBtn.style.display = 'none';
    if (whBtn) whBtn.style.display = 'none';
  } else {
    if (delivSel?.parentElement) delivSel.parentElement.style.display = '';
    if (fulfillSel?.parentElement) fulfillSel.parentElement.style.display = '';
  }
  if (delivSel) delivSel.onchange = _updateFulfillBtns;
  if (fulfillSel) fulfillSel.onchange = _updateFulfillBtns;
  if (shipBtn) shipBtn.onclick = async () => {
    shipBtn.disabled = true; shipBtn.textContent = 'Pushing…';
    let ok = false;
    try { ok = await pushInvoiceToShipStation(id, col); } catch (e) { ok = false; }
    if (ok) setTimeout(() => openInvoicePreview(type, id), 300);
    else { shipBtn.disabled = false; shipBtn.textContent = '📦 Push to ShipStation'; }
  };
  if (whBtn) whBtn.onclick = () => { pushToWarehouse(id, col); setTimeout(() => openInvoicePreview(type, id), 300); };

  const saveBtn = qs('#civ-btn-save');
  if (saveBtn) saveBtn.onclick = () => {
    const nd = qs('#civ-edit-date').value, ndu = qs('#civ-edit-due').value;
    const patch = type === 'dist'
      ? { dateIssued: nd, dueDate: ndu, notes: qs('#civ-edit-notes').value } // dist has no delivery/fulfillment; dates live in dateIssued/dueDate
      : {
          date: nd, dueDate: ndu, issued: nd, due: ndu,
          paymentTerms: qs('#civ-edit-terms').value, notes: qs('#civ-edit-notes').value,
          deliveryMethod: qs('#civ-edit-delivery')?.value || 'deliver',
          fulfillmentSource: qs('#civ-edit-fulfillment')?.value || 'warehouse',
        };
    DB.update(col, id, x => ({ ...x, ...patch }));
    toast('Invoice updated ✓');
    setTimeout(() => openInvoicePreview(type, id), 200);
  };

  if (qs('#civ-preview-frame')) qs('#civ-preview-frame').srcdoc = html;

  const newtabBtn = qs('#civ-btn-newtab');
  if (newtabBtn) newtabBtn.onclick = () => {
    const blob = new Blob([buildDoc({ printButton: true })], { type: 'text/html' });
    window.open(URL.createObjectURL(blob), '_blank');
  };

  const sendBtn = qs('#civ-btn-gmail');
  if (sendBtn) {
    sendBtn.disabled = false; sendBtn.textContent = 'Send Invoice to Customer';
    sendBtn.onclick = async () => {
      const to = account.email || '';
      if (!to) { toast('No email address on file for this account'); return; }
      sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
      try {
        if (rec.deliveryMethod === 'ship' && !rec.shipStationOrderId) { try { await pushInvoiceToShipStation(id, col); } catch (e) {} }
        const subject = 'Invoice from Pumpkin Blossom Farm — ' + (rec.accountName || account.name || '');
        const result = await callSendEmail(to, 'lavender@pbfwholesale.com', subject, html);
        toast('Invoice sent ✓');
        // purpl deducts inventory via markInvoiceSent; LF is Wix-managed; dist
        // stock already moved at Log Shipment — status flip only for both.
        if (type === 'lf' || type === 'dist') DB.update(col, id, x => ({ ...x, status: (x.status === 'draft' || !x.status) ? 'sent' : x.status, sentAt: new Date().toISOString() }));
        else markInvoiceSent(id);
        if (type === 'dist') auditLog('send', 'dist_invoice', id, rec.number || rec.invoiceNumber || id);
        const entry = { id: uid(), stage: 'invoice_sent', sentAt: new Date().toISOString(), sentBy: _currentUserName(), method: 'resend', invoiceId: id, invoiceRef: rec.number || rec.invoiceNumber || '' };
        if (result?.id) entry.sentMessageId = result.id;
        if (rec.accountId) DB.update('ac', rec.accountId, a => ({ ...a, lastContacted: today(), cadence: _pushCadence(a.cadence, entry) }));
        _clearReadyToSend(id, col);
        setTimeout(() => openInvoicePreview(type, id), 400);
      } catch (e) {
        console.error('Send invoice error:', e);
        sendBtn.disabled = false; sendBtn.textContent = 'Send Invoice to Customer';
        toast('Send failed — ' + (e?.message || 'try again'));
      }
    };
  }

  const paidBtn = qs('#civ-btn-paid');
  if (paidBtn) {
    paidBtn.textContent = 'Mark Paid';
    paidBtn.style.display = (st === 'paid' || st === 'void') ? 'none' : '';
    paidBtn.onclick = () => {
      if (type === 'dist') markDistInvoicePaid(id, rec.distId);
      else (type === 'lf' ? markLfInvPaid : markRetailInvPaid)(id);
      closeModal('modal-combined-invoice');
    };
  }

  const voidBtn = qs('#civ-btn-void');
  if (voidBtn) {
    voidBtn.style.display = (st === 'void') ? 'none' : '';
    voidBtn.onclick = () => {
      if (!confirm2('Void this invoice?')) return;
      DB.atomicUpdate(cache => {
        const arr = cache[col] || [];
        const i2 = arr.findIndex(x => x.id === id);
        if (i2 >= 0) arr[i2] = { ...arr[i2], status: 'void' };
        if (type !== 'lf' && type !== 'dist') cache.iv = (cache.iv || []).filter(x => !(x.type === 'out' && x.invoiceId === id)); // purpl only — dist deductions belong to the shipment PO
      });
      toast('Invoice voided');
      closeModal('modal-combined-invoice');
      renderInvoicesPage();
    };
  }

  const delBtn = qs('#civ-btn-delete');
  if (delBtn) {
    delBtn.style.display = _isAdmin() ? '' : 'none';
    delBtn.onclick = () => { closeModal('modal-combined-invoice'); (type === 'dist' ? deleteDistInvoice : (type === 'lf' ? deleteLfInvoice : deleteRetailInv))(id); };
  }

  const copyBtn = qs('#civ-btn-copy');
  if (copyBtn) copyBtn.onclick = () => navigator.clipboard.writeText(html).then(() => toast('HTML copied')).catch(() => toast('Copy failed'));

  openModal('modal-combined-invoice');
}

// ── Combined invoice preview modal ────────────────────────

async function openCombinedInvoicePreview(combinedId) {
  const rec = DB.a('combined_invoices').find(x => x.id === combinedId);
  if (!rec) return;
  toast('Loading preview…');
  // Restore shell defaults that the shared single-brand openInvoicePreview may
  // have altered (title, hidden subtotal row, "Mark Paid" label).
  const _h2 = document.querySelector('#modal-combined-invoice .modal-hdr h2');
  if (_h2) _h2.textContent = 'Combined Invoice';
  const _pr = qs('#civ-purpl-sub')?.parentElement; if (_pr) _pr.style.display = '';
  const _lr = qs('#civ-lf-sub')?.parentElement; if (_lr) _lr.style.display = '';
  const _pb = qs('#civ-btn-paid'); if (_pb) { _pb.textContent = 'Mark Both Paid'; _pb.style.display = ''; }
  const _vb = qs('#civ-btn-void'); if (_vb) _vb.style.display = '';
  // Older combined invoices were created without a number — backfill one,
  // since Stripe link generation requires it.
  if (!rec.number && !rec.invoiceNumber) {
    const n = await getNextInvoiceNumber('combined');
    DB.update('combined_invoices', combinedId, x => ({ ...x, number: n, invoiceNumber: n }));
    rec.number = n; rec.invoiceNumber = n;
  }
  const payLink = rec.status === 'paid' ? null : await _getStripePayLink(rec, 'combined');
  const html     = buildCombinedInvoiceHTML(combinedId, payLink);
  const account  = DB.a('ac').find(x => x.id === rec.accountId) || {};
  const purplInv = findInvoice(rec.purplInvoiceId) || {};
  const lfInv    = DB.a('lf_invoices').find(x => x.id === rec.lfInvoiceId) || {};

  qs('#civ-account-name').textContent = rec.accountName;
  // Build status + tracking badges
  let statusHtml = '';
  const st = rec.status || 'draft';
  const stColor = { draft:'gray', sent:'blue', paid:'green', overdue:'red', void:'red' };
  statusHtml = `<span class="badge ${stColor[st]||'gray'}" style="margin-left:8px;text-transform:uppercase;font-size:10px">${st}</span>`;
  // Find cadence entry that matches this invoice to pull open/click tracking
  const trackEntry = (account.cadence||[]).find(c => c.invoiceId === rec.id && c.stage === 'invoice_sent');
  if (trackEntry) {
    if (trackEntry.opened) statusHtml += ` <span class="badge green" style="margin-left:4px;font-size:10px" title="Opened ${fmtD(trackEntry.openedAt)}">👁 Opened</span>`;
    if (trackEntry.clicked) statusHtml += ` <span class="badge blue" style="margin-left:4px;font-size:10px" title="Clicked ${fmtD(trackEntry.clickedAt)}">🔗 Clicked</span>`;
    if (!trackEntry.opened && !trackEntry.clicked && rec.status === 'sent') statusHtml += ` <span style="margin-left:6px;font-size:11px;color:var(--muted)">Not yet opened</span>`;
  }
  qs('#civ-invoice-nums').innerHTML = (rec.number || rec.invoiceNumber || '') + statusHtml;
  qs('#civ-purpl-sub').textContent    = '$' + (rec.purplSubtotal||0).toFixed(2);
  qs('#civ-lf-sub').textContent       = '$' + (rec.lfSubtotal||0).toFixed(2);
  qs('#civ-grand-total').textContent  = '$' + (rec.grandTotal||0).toFixed(2);

  // Populate editable fields
  qs('#civ-edit-date').value = rec.date || today();
  qs('#civ-edit-due').value = rec.dueDate || rec.due || '';
  qs('#civ-edit-terms').value = rec.paymentTerms || 'Net 30';
  qs('#civ-edit-notes').value = rec.notes || '';
  const delivSel = qs('#civ-edit-delivery');
  if (delivSel) delivSel.value = rec.deliveryMethod || 'deliver';
  const fulfillSel = qs('#civ-edit-fulfillment');
  if (fulfillSel) fulfillSel.value = rec.fulfillmentSource || 'warehouse';
  const shipBtn = qs('#civ-btn-ship');
  const whBtn = qs('#civ-btn-warehouse');
  const _updateFulfillBtns = () => {
    const isShip = delivSel?.value === 'ship';
    const isWh = fulfillSel?.value === 'warehouse';
    if (shipBtn) {
      shipBtn.style.display = isShip ? '' : 'none';
      if (rec.shipStationOrderId) { shipBtn.textContent = '✓ Pushed to ShipStation'; shipBtn.disabled = true; }
    }
    if (whBtn) {
      whBtn.style.display = isWh ? '' : 'none';
      if (rec.warehousePushedAt) { whBtn.textContent = '✓ Sent to Warehouse'; whBtn.disabled = true; }
    }
  };
  _updateFulfillBtns();
  if (delivSel) delivSel.onchange = _updateFulfillBtns;
  if (fulfillSel) fulfillSel.onchange = _updateFulfillBtns;
  if (shipBtn) shipBtn.onclick = async () => {
    shipBtn.disabled = true; shipBtn.textContent = 'Pushing…';
    let ok = false;
    try { ok = await pushInvoiceToShipStation(combinedId, 'combined_invoices'); } catch(e) { ok = false; }
    // pushInvoiceToShipStation shows its own success toast / sticky error with the
    // real reason. On success re-render (button becomes "✓ Pushed"); on failure
    // ALWAYS reset the button so it can never get stuck on "Pushing…".
    if (ok) {
      setTimeout(() => openCombinedInvoicePreview(combinedId), 300);
    } else {
      shipBtn.disabled = false; shipBtn.textContent = '📦 Push to ShipStation';
    }
  };
  if (whBtn) whBtn.onclick = () => {
    pushToWarehouse(combinedId, 'combined_invoices');
    setTimeout(() => openCombinedInvoicePreview(combinedId), 300);
  };

  const saveBtn = qs('#civ-btn-save');
  if (saveBtn) saveBtn.onclick = () => {
    const newDate = qs('#civ-edit-date').value;
    const newDue = qs('#civ-edit-due').value;
    const newTerms = qs('#civ-edit-terms').value;
    const newNotes = qs('#civ-edit-notes').value;
    const newDelivery = qs('#civ-edit-delivery')?.value || 'deliver';
    const newFulfillment = qs('#civ-edit-fulfillment')?.value || 'warehouse';
    const patch = { date: newDate, dueDate: newDue, paymentTerms: newTerms, notes: newNotes, deliveryMethod: newDelivery, fulfillmentSource: newFulfillment };
    DB.atomicUpdate(cache => {
      const ci = (cache.combined_invoices||[]).findIndex(x => x.id === combinedId);
      if (ci >= 0) cache.combined_invoices[ci] = { ...cache.combined_invoices[ci], ...patch };
      if (rec.purplInvoiceId) {
        const ri = (cache.retail_invoices||[]).findIndex(x => x.id === rec.purplInvoiceId);
        if (ri >= 0) cache.retail_invoices[ri] = { ...cache.retail_invoices[ri], ...patch };
      }
      if (rec.lfInvoiceId) {
        const li = (cache.lf_invoices||[]).findIndex(x => x.id === rec.lfInvoiceId);
        if (li >= 0) cache.lf_invoices[li] = { ...cache.lf_invoices[li], ...patch, issued: newDate, due: newDue };
      }
    });
    toast('Invoice updated ✓');
    setTimeout(() => openCombinedInvoicePreview(combinedId), 200);
  };

  qs('#civ-preview-frame').srcdoc = html;

  qs('#civ-btn-newtab').onclick = () => {
    const printHtml = buildCombinedInvoiceHTML(combinedId, null, { printButton: true });
    const blob = new Blob([printHtml], {type:'text/html'});
    window.open(URL.createObjectURL(blob), '_blank');
  };
  const copyBtn = qs('#civ-btn-copy');
  if (copyBtn) copyBtn.onclick = () => {
    navigator.clipboard.writeText(html)
      .then(() => toast('HTML copied'))
      .catch(() => toast('Copy failed'));
  };
  const _gmailBtn = qs('#civ-btn-gmail');
  if (_gmailBtn) _gmailBtn.onclick = async () => {
    if (_gmailBtn.disabled) return;
    _gmailBtn.disabled = true; _gmailBtn.textContent = 'Sending…';
    try {
    const subject = 'Invoice from Pumpkin Blossom Farm — ' + rec.accountName;
    const to = account.email || '';
    if (!to) { toast('No email address on file for this account'); return; }
    if (rec.deliveryMethod === 'ship' && !rec.shipStationOrderId) {
      await pushInvoiceToShipStation(combinedId, 'combined_invoices');
    }
    const sendHtml = html;
    callSendCombinedInvoice(to, rec.accountName, subject, sendHtml, rec.accountId, rec.number || rec.invoiceNumber)
      .then((result) => {
        toast('Invoice sent ✓');
        const invoiceRef = rec.number || rec.invoiceNumber || '';
        const sentAt = new Date().toISOString();
        const sentMessageId = result?.id || null;
        // Update status to 'sent' on all 3 invoice records atomically + deduct purpl inventory
        const wasDraft = rec.status === 'draft' || !rec.status;
        let didDeduct = false;
        DB.atomicUpdate(cache => {
          const ci = (cache.combined_invoices||[]).findIndex(x => x.id === combinedId);
          const sendPatch = { status: 'sent', sentAt, sentMessageId, deliveryMethod: rec.deliveryMethod || 'deliver' };
          if (ci >= 0) cache.combined_invoices[ci] = { ...cache.combined_invoices[ci], ...sendPatch };
          if (rec.purplInvoiceId) {
            const ri = (cache.retail_invoices||[]).findIndex(x => x.id === rec.purplInvoiceId);
            if (ri >= 0) cache.retail_invoices[ri] = { ...cache.retail_invoices[ri], ...sendPatch };
            // Re-check alreadyDeducted inside atomic block to close double-send race
            const alreadyDeducted = (cache.iv||[]).some(x => x.invoiceId === rec.purplInvoiceId && x.type === 'out');
            if (wasDraft && !alreadyDeducted && ri >= 0) {
              const purplInv = cache.retail_invoices[ri];
              const invNum = purplInv.number || purplInv.invoiceNumber || '';
              (purplInv.lineItems || []).forEach(li => {
                if (li.skuId === '__shipping__') return; // shipping is not stock
                const cases = li.cases || li.qty || 0;
                if (cases > 0) {
                  cache.iv = cache.iv || [];
                  cache.iv.push({ id: uid(), date: today(), sku: li.skuId || li.sku || 'classic', type: 'out', qty: cases * CANS_PER_CASE, pool: rec.fulfillmentSource || 'warehouse', note: 'Invoice ' + invNum, invoiceId: rec.purplInvoiceId });
                  didDeduct = true;
                }
              });
            }
          }
          if (rec.lfInvoiceId) {
            const li = (cache.lf_invoices||[]).findIndex(x => x.id === rec.lfInvoiceId);
            if (li >= 0) cache.lf_invoices[li] = { ...cache.lf_invoices[li], ...sendPatch };
          }
        });
        if (didDeduct) toast('Inventory deducted ✓', 2000);
        _clearReadyToSend(combinedId, 'combined_invoices');
        // Log to account cadence
        const entry = { id: uid(), stage: 'invoice_sent', sentAt, sentBy: _currentUserName(), method: 'resend', invoiceId: rec.id, invoiceRef };
        if (sentMessageId) entry.sentMessageId = sentMessageId;
        DB.update('ac', rec.accountId, a => ({
          ...a,
          lastContacted: today(),
          cadence: _pushCadence(a.cadence, entry),
        }));
        renderAccounts();
        renderInvoicesPage();
        const updatedAc = DB.a('ac').find(x => x.id === rec.accountId);
        if (updatedAc) {
          renderAccountOutreach(updatedAc);
          renderMacEmailsTab(rec.accountId);
        }
        // Refresh modal to show updated status
        setTimeout(() => openCombinedInvoicePreview(combinedId), 200);
      })
      .catch(() => {
        window.open(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}`, '_blank');
      });
    } finally { if (_gmailBtn) { _gmailBtn.disabled = false; _gmailBtn.textContent = 'Send'; } }
  };
  const voidBtn = qs('#civ-btn-void');
  if (voidBtn) voidBtn.style.display = _isAdmin() ? '' : 'none';
  if (voidBtn) voidBtn.onclick = () => {
    if (!_requireAdmin('void invoices')) return;
    if (!confirm('Void this invoice? This marks it canceled and reverses any inventory deduction. Cannot be undone.')) return;
    auditLog('void', 'combined_invoice', combinedId, rec.number || rec.invoiceNumber || combinedId);
    const wasDeducted = DB.a('iv').some(x => (x.invoiceId === rec.purplInvoiceId || x.invoiceId === combinedId) && x.type === 'out');
    DB.atomicUpdate(cache => {
      const ci = (cache.combined_invoices||[]).findIndex(x => x.id === combinedId);
      if (ci >= 0) cache.combined_invoices[ci] = { ...cache.combined_invoices[ci], status: 'void', voidedAt: new Date().toISOString(), voidedBy: _currentUserName() };
      if (rec.purplInvoiceId) {
        const ri = (cache.retail_invoices||[]).findIndex(x => x.id === rec.purplInvoiceId);
        if (ri >= 0) cache.retail_invoices[ri] = { ...cache.retail_invoices[ri], status: 'void', voidedAt: new Date().toISOString(), voidedBy: _currentUserName() };
      }
      if (rec.lfInvoiceId) {
        const li = (cache.lf_invoices||[]).findIndex(x => x.id === rec.lfInvoiceId);
        if (li >= 0) cache.lf_invoices[li] = { ...cache.lf_invoices[li], status: 'void', voidedAt: new Date().toISOString(), voidedBy: _currentUserName() };
        cache.lf_wix_deductions = (cache.lf_wix_deductions||[]).filter(d => d.invoiceId !== rec.lfInvoiceId);
      }
      // Reverse inventory deductions
      if (wasDeducted) {
        cache.iv = (cache.iv||[]).filter(x => !(x.type === 'out' && (x.invoiceId === rec.purplInvoiceId || x.invoiceId === combinedId)));
      }
    });
    // Reset linked portal order so it can be re-confirmed with a new invoice
    const portalOrderId = rec.portalOrderId;
    if (portalOrderId) {
      firebase.firestore().collection('portal_orders').doc(portalOrderId)
        .update({ status: 'new', confirmedAt: null, convertedOrderId: null })
        .catch(e => console.warn('Could not reset portal order:', e));
    }
    toast('Invoice voided' + (wasDeducted ? ' · inventory restored' : ''));
    closeModal('modal-combined-invoice');
    renderInvoicesPage();
  };

  const delBtn = qs('#civ-btn-delete');
  if (delBtn) delBtn.style.display = _isAdmin() ? '' : 'none';
  if (delBtn) delBtn.onclick = () => {
    closeModal('modal-combined-invoice');
    deleteCombinedInvoice(combinedId);
  };

  qs('#civ-btn-paid').onclick = () => {
    markCombinedPaid(combinedId);
    closeModal('modal-combined-invoice');
  };

  openModal('modal-combined-invoice');
}

// ── Manual combined invoice creation from account detail ──

function printAccountStatement(accountId) {
  const a = DB.a('ac').find(x => x.id === accountId);
  if (!a) return;

  // Collect invoices from ALL collections for this account
  // Exclude children that are part of a combined invoice (combined parent has the total)
  const allInvs = [
    ..._allPurplInvoices().filter(x => x.accountId === accountId && !x.combinedInvoiceId)
      .map(x => ({...x, _type: 'purpl', _amt: parseFloat(x.amount||x.total||0), _date: x.date||''})),
    ...DB.a('lf_invoices').filter(x => x.accountId === accountId && !x.combinedInvoiceId)
      .map(x => ({...x, _type: 'LF', _amt: parseFloat(x.total||0), _date: x.issued||x.date||''})),
    ...DB.a('combined_invoices').filter(x => x.accountId === accountId)
      .map(x => ({...x, _type: 'Combined', _amt: parseFloat(x.grandTotal||0), _date: x.date||''})),
  ];
  const statuses  = { paid:'Paid', draft:'Draft', sent:'Sent', overdue:'Overdue', partial:'Partial', unpaid:'Unpaid', void:'Void' };

  let totalOutstanding = 0;
  const rows = allInvs
    .slice()
    .sort((x, y) => (x._date || '') > (y._date || '') ? -1 : 1)
    .map(iv => {
      // Drafts are unsent — counting them inflated the customer-facing
      // "Total Outstanding" with money never billed.
      const balance = (iv.status === 'paid' || iv.status === 'void' || (iv.status || 'draft') === 'draft') ? 0 : iv._amt;
      totalOutstanding += balance;
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${escHtml(iv.number || iv.invoiceNumber || '—')} <span style="font-size:10px;color:#9ca3af">${iv._type}</span></td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${fmtD(iv._date)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtC(iv._amt)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${statuses[iv.status] || (iv.status || 'Unpaid')}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:${balance > 0 ? '600' : '400'}">${balance > 0 ? fmtC(balance) : '—'}</td>
      </tr>`;
    }).join('');

  const locs  = a.locations || (a.address ? [{ address: a.address }] : []);
  const addr  = locs[0]?.address || a.address || '';
  const today_str = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

  const html = `<!DOCTYPE html><html><head>
<meta charset="UTF-8">
<title>Statement of Account — ${escHtml(a.name || '')}</title>
<style>
  body { font-family: Inter, Arial, sans-serif; color: #1a1a2e; margin: 0; padding: 40px; font-size: 14px; }
  h1 { font-family: 'Playfair Display', Georgia, serif; font-weight: 400; font-size: 26px; margin: 0 0 4px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 2px solid #8B5FBF; }
  .pbf-brand { color: #8B5FBF; font-size: 13px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; }
  .pbf-addr { font-size: 12px; color: #6b7280; line-height: 1.6; margin-top: 4px; }
  .ac-section { margin-bottom: 28px; }
  .ac-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #8B5FBF; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { background: #f9fafb; padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; border-bottom: 2px solid #e5e7eb; }
  thead th.right { text-align: right; }
  tfoot td { padding: 10px 12px; font-weight: 700; font-size: 15px; border-top: 2px solid #8B5FBF; }
  tfoot td.right { text-align: right; color: #8B5FBF; }
  .date-line { font-size: 12px; color: #6b7280; margin-top: 6px; }
  @media print { body { padding: 20px; } }
</style>
</head><body>
<div class="header">
  <div>
    <div class="pbf-brand">Pumpkin Blossom Farm</div>
    <h1>Statement of Account</h1>
    <div class="date-line">As of ${today_str}</div>
  </div>
  <div style="text-align:right">
    <div class="pbf-addr">
      393 Pumpkin Hill Rd · Warner, NH 03278<br>
      lavender@pbfwholesale.com · 603-748-3038
    </div>
  </div>
</div>
<div class="ac-section">
  <div class="ac-label">Account</div>
  <div style="font-size:16px;font-weight:600">${escHtml(a.name || '—')}</div>
  ${addr ? `<div style="font-size:13px;color:#6b7280;margin-top:2px">${escHtml(addr)}</div>` : ''}
  ${a.email ? `<div style="font-size:13px;color:#6b7280">${escHtml(a.email)}</div>` : ''}
</div>
<table>
  <thead>
    <tr>
      <th>Invoice #</th>
      <th>Date</th>
      <th class="right">Amount</th>
      <th>Status</th>
      <th class="right">Balance Due</th>
    </tr>
  </thead>
  <tbody>
    ${rows || '<tr><td colspan="5" style="padding:12px;color:#6b7280">No invoices found.</td></tr>'}
  </tbody>
  <tfoot>
    <tr>
      <td colspan="4">Total Outstanding</td>
      <td class="right">${fmtC(totalOutstanding)}</td>
    </tr>
  </tfoot>
</table>
<script>window.onload=()=>{window.print();}<\/script>
</body></html>`;

  const win = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
  }
}

function renderMacInvoicesTab(accountId) {
  const a       = DB.a('ac').find(x => x.id === accountId);
  const el      = qs('#mac-invoices-content');
  if (!el || !a) return;

  const purplInvs = _allPurplInvoices().filter(x => x.accountId === accountId);
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
          ${statBadge(iv.status||'draft', statColor[iv.status]||'gray')}
          <strong>${fmtC(iv.amount||iv.total||0)}</strong>
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
          ${statBadge(inv.status||'draft', LF_INV_STATUS[inv.status]?.cls||'gray')}
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
        `<option value="${iv.id}">${escHtml(iv.number||iv.invoiceNumber||iv.id)} — ${fmtC(iv.amount||iv.total||0)}</option>`).join('');
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
    <div style="display:flex;justify-content:flex-end;margin-bottom:14px">
      <button class="btn sm" onclick="printAccountStatement('${accountId}')">🖨 Statement of Account</button>
    </div>
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

async function manualCreateCombined(accountId) {
  const purplId = qs('#civ-sel-purpl')?.value;
  const lfId    = qs('#civ-sel-lf')?.value;
  if (!purplId || !lfId) { toast('Select both invoices'); return; }
  const combinedId = await createCombinedInvoice(purplId, lfId, accountId);
  if (!combinedId) return;
  toast('Combined invoice created');
  openCombinedInvoicePreview(combinedId);
}

// ── Wix pull modal ────────────────────────────────────────

function showWixPullModal(inv, deductionId) {
  inv = inv || {};
  _wixPullDeductionId = deductionId;
  _wixPullInvoiceId   = inv.id || null;
  // Delivery runs open this with inv=null — render from the deduction record
  // itself (it carries the stop's items/note) instead of a blank "—/No items".
  const ded = deductionId ? DB.a('lf_wix_deductions').find(d => d.id === deductionId) : null;
  const acEl = qs('#wix-pull-account');
  if (acEl) acEl.textContent = inv.accountName || ded?.accountName || (ded?.note || '').replace(/^Delivery: /,'') || '—';
  const numEl = qs('#wix-pull-inv-number');
  if (numEl) numEl.textContent = inv.number || ded?.invoiceNumber || ded?.runName || '—';
  const itemsEl = qs('#wix-pull-items');
  if (itemsEl) {
    itemsEl.innerHTML = ((inv.lineItems && inv.lineItems.length ? inv.lineItems : ded?.items) || []).map(l => {
      if (l.hasVariants && l.variantLines?.length) {
        const varHtml = l.variantLines.map(vl => `
          <div style="display:flex;justify-content:space-between;padding:3px 0 3px 24px;font-size:12px;color:var(--muted)">
            <span>${escHtml(vl.variantName)}${_isRefillable(vl.variantName) ? ' (Refillable)' : ''}</span>
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
          <span>${escHtml(l.skuName || l.sku || '')}${l.variantName ? ' — ' + escHtml(l.variantName) : ''}</span>
          <span><strong>${l.cases ?? l.qty ?? 0}</strong> case${(l.cases ?? l.qty) !== 1 ? 's' : ''}${l.units ? ` (${l.units} units)` : ''}</span>
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
  toast(confirmed ? '✓ Deduction confirmed' : 'Reminder set — deduct when ready');
  _wixPullDeductionId = null;
  _wixPullInvoiceId   = null;
}

// ── LF KPIs on dashboard ──────────────────────────────────

function renderLfDashKpis() {
  const el = qs('#dash-lf-kpis');
  if (!el) return;
  const lfAc       = DB.a('ac').filter(a => a.status === 'active' && !!a.isPbf).length;
  const lfInvs     = DB.a('lf_invoices');
  // Match the main dashboard's filter: outstanding = anything that isn't paid/draft/void.
  const outstanding = lfInvs
    .filter(i => !['paid','draft','void'].includes(i.status))
    .reduce((s,i) => s + (i.total||0), 0);
  const lfOverdue  = lfInvs.filter(i => !['paid','draft','void'].includes(i.status) && (i.dueDate||i.due) && (i.dueDate||i.due) < today()).length;
  const pendingWix = DB.a('lf_wix_deductions').filter(d => !d.confirmed).length;

  if (qs('#dash-kpi-lf-accounts'))    qs('#dash-kpi-lf-accounts').innerHTML    = kpiHtml('🪻 LF Accounts', lfAc, 'green');
  if (qs('#dash-kpi-lf-outstanding')) qs('#dash-kpi-lf-outstanding').innerHTML = kpiHtml('LF Outstanding', fmtC(outstanding), outstanding > 0 ? 'amber' : 'gray');
  if (qs('#dash-kpi-lf-overdue'))     qs('#dash-kpi-lf-overdue').innerHTML     = kpiHtml('LF Overdue', lfOverdue, lfOverdue > 0 ? 'red' : 'gray');
  if (qs('#dash-kpi-lf-wix'))         qs('#dash-kpi-lf-wix').innerHTML         = kpiHtml('Pending LF Deductions', pendingWix, pendingWix > 0 ? 'amber' : 'gray');
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
function migrateInvoiceStatuses() {
  if (!DB._firestoreReady) return;
  const remap = { unpaid: 'sent', overdue: 'sent' };
  ['lf_invoices', 'dist_invoices', 'retail_invoices'].forEach(col => {
    DB.a(col).forEach(inv => {
      if (remap[inv.status]) {
        DB.update(col, inv.id, x => ({ ...x, status: remap[x.status] || x.status }));
      }
    });
  });
}

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
  migrateInvoiceStatuses(); // one-time: unpaid/overdue → sent for all invoice types

  // Allow db.js real-time listener to refresh whichever page is open.
  // Also used to retry one-time migrations that were skipped because the
  // 10s startup timeout fired before Firestore data arrived.
  window.refreshCurrentPage = () => {
    migrateLfSkuVariants();
    restoreMyData();
    migrateAccountContacts();
    _checkShippedInvoices();
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

  // Handle email unsubscribe deeplink (?optout=ACCOUNT_ID)
  const _optoutId = new URLSearchParams(window.location.search).get('optout');
  if (_optoutId) {
    const _optoutAc = DB.a('ac').find(x => x.id === _optoutId);
    if (_optoutAc && !_optoutAc.emailOptOut) {
      DB.update('ac', _optoutId, ac => ({ ...ac, emailOptOut: true }));
      toast(`${_optoutAc.name || 'Account'} has been unsubscribed from marketing emails.`, 6000);
    }
    // Clean URL so refresh doesn't re-trigger
    history.replaceState(null, '', window.location.pathname);
  }

  // ── Real-time listener for portal orders ────────────────
  _listenPortalOrders();

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
        <div style="font-weight:700;font-size:14px;margin-bottom:4px">${escHtml(opts.name||'')}</div>
        <div style="font-size:12px;color:#666">${escHtml(opts.sub||'')}</div>
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

  // Warehouse pin from settings
  const settings = DB.obj('settings', {});
  const whLat = parseFloat(settings.warehouseLat);
  const whLng = parseFloat(settings.warehouseLng);
  const whRadius = parseFloat(settings.warehouseRadiusMiles) || 0;
  if (whLat && whLng && !isNaN(whLat) && !isNaN(whLng)) {
    const whMarker = new google.maps.Marker({
      position: {lat: whLat, lng: whLng},
      map: _mapInstance,
      title: 'Pumpkin Blossom Farm (Warehouse)',
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: '#4B2082', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 },
    });
    const whIw = new google.maps.InfoWindow({ content: `<div style="font-family:sans-serif"><div style="font-weight:700;font-size:14px;color:#4B2082">🏠 Warehouse</div><div style="font-size:12px;color:#666;margin-top:4px">${escHtml(settings.address||'Pumpkin Blossom Farm')}</div>${whRadius ? `<div style="font-size:12px;color:#4B2082;margin-top:4px">${whRadius} mile delivery radius</div>` : ''}</div>` });
    whMarker.addListener('click', () => whIw.open(_mapInstance, whMarker));
    _mapMarkers.push(whMarker);
    bounds.extend({lat: whLat, lng: whLng});
    hasPoints = true;
    if (whRadius > 0) {
      const whCircle = new google.maps.Circle({
        map: _mapInstance, center: {lat: whLat, lng: whLng},
        radius: whRadius * 1609.34, fillColor: '#4B2082', fillOpacity: 0.05,
        strokeColor: '#4B2082', strokeOpacity: 0.3, strokeWeight: 2,
      });
      _mapCoverageOverlays.push(whCircle);
    }
  }

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
      this._orders = ordSnap.docs.map(d => { const data = d.data(); return { ...data, id: d.id,
        submittedAt: data.submittedAt?.toDate?.() || null }; });
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
  const localKey = entityType === 'prospects' ? 'pr' : 'ac';
  try {
    // REUSE an existing token if one was already issued. Re-copying a link must
    // NOT rotate the token — doing so would silently break a link already
    // emailed to the customer. Only mint a new token if none exists yet.
    const existing = DB.a(localKey).find(x => x.id === entityId);
    // name/email are derived from the cache record so inline onclick handlers
    // only pass the id — interpolating names into JS strings broke on
    // apostrophes (escHtml entities decode back before JS parses the attribute).
    if (entityName == null) entityName = existing?.name || '';
    if (entityEmail == null) entityEmail = existing?.email || '';
    let token = existing && existing.orderPortalToken;
    const isNewToken = !token;
    if (isNewToken) {
      token = generateSecureToken(entityId);
      await firebase.firestore().collection(entityType).doc(entityId).set({
        orderPortalToken: token,
        name: entityName,
        email: entityEmail || '',
        orderPortalTokenCreatedAt: new Date().toISOString().slice(0,10)
      }, { merge: true });
      DB.update(localKey, entityId, a => ({...a, orderPortalToken: token, orderPortalTokenCreatedAt: new Date().toISOString().slice(0,10)}));
    }
    const link = 'https://pbfwholesale.com/order?t=' + token;
    await navigator.clipboard.writeText(link);
    toast(isNewToken ? 'Order link generated & copied ✓' : 'Order link copied ✓');
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
  renderApplications();
  _renderPoKpis();
  _renderPoTabs();
  _switchPoTab(_poCurrentTab);
}

function _renderPoKpis() {
  const orders = PortalDB.getOrders();
  const total   = orders.length;
  const matched = orders.filter(o => o.isMatched).length;
  const unmatched = orders.filter(o => !o.isMatched).length;
  const purplCasesTotal = orders.reduce((s,o) => {
    return s + (o.items||[]).reduce((ss,i) => ss + (i.cases||0), 0);
  }, 0);
  const lfCasesTotal = orders.reduce((s,o) => {
    return s + (o.lineItems||[]).reduce((ss,i) => ss + (i.cases||0), 0);
  }, 0);
  const totalCases = purplCasesTotal + lfCasesTotal;
  const totalCans = purplCasesTotal * CANS_PER_CASE;
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
  ['all','unmatched','confirmed','notify','links','samples'].forEach(id => {
    const el = qs(`#po-pane-${id}`);
    if (el) el.style.display = id === tab ? '' : 'none';
  });
  if (tab === 'all')       _renderPoAll();
  if (tab === 'unmatched') _renderPoUnmatched();
  if (tab === 'confirmed') _renderPoConfirmed();
  if (tab === 'notify')    _renderPoNotify();
  if (tab === 'links')     _renderPoLinks();
  if (tab === 'samples')   _renderPoSampleRequests();
}

// Dedupe sample requests: a dual-brand order creates 2 portal_order docs,
// both flagged requestSample. Group by account (or email) so each sample
// request shows ONCE. Status reflects any doc in the group being
// approved/declined. Keeps the most informative doc as the representative.
function _dedupeSampleRequests() {
  const all = PortalDB.getOrders().filter(o => o.requestSample);
  const groups = new Map();
  for (const o of all) {
    const key = o.accountId || o.billingEmail || o.contactEmail || o.id;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { rep: o, ids: [o.id], approved: !!o.sampleApproved, declined: !!o.sampleDeclined });
    } else {
      g.ids.push(o.id);
      g.approved = g.approved || !!o.sampleApproved;
      g.declined = g.declined || !!o.sampleDeclined;
      // Prefer a rep with a shipping address
      if (!(g.rep.shipAddress && g.rep.shipAddress.street1) && o.shipAddress && o.shipAddress.street1) g.rep = o;
    }
  }
  return [...groups.values()];
}

function _renderPoSampleRequests() {
  const el = qs('#po-pane-samples');
  if (!el) return;
  const groups = _dedupeSampleRequests();
  if (!groups.length) { el.innerHTML = '<div class="empty">No sample requests</div>'; return; }
  return _renderSampleTable(el, groups);
}

function _renderSampleTable(el, groups) {
  el.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>Submitted</th><th>Account</th><th>Email</th><th>Address</th><th>Status</th><th></th></tr></thead>
    <tbody>${groups.map(g => {
      const o = g.rep;
      const addr = o.shipAddress || {};
      const addrStr = [addr.street1, addr.city, addr.state, addr.zip].filter(Boolean).join(', ');
      const sampled = g.approved ? '<span class="badge green">Approved</span>'
        : g.declined ? '<span class="badge red">Declined</span>'
        : '<span class="badge amber">Pending</span>';
      return `<tr>
        <td>${_fmtPoDate(o.submittedAt)}</td>
        <td><strong>${escHtml(o.accountName||'—')}</strong>${o.isMatched?' <span class="badge green" style="font-size:10px">Matched</span>':''}</td>
        <td>${escHtml(o.billingEmail||o.contactEmail||'—')}</td>
        <td style="font-size:12px">${escHtml(addrStr||'No address')}</td>
        <td>${sampled}</td>
        <td style="white-space:nowrap">
          ${!g.approved && !g.declined ? `
            <button class="btn xs primary" onclick="_approveSampleRequest('${o.id}')">✓ Approve & Ship</button>
            <button class="btn xs" onclick="_declineSampleRequest('${o.id}')">✗ Decline</button>
          ` : ''}
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

// Find every sample-request doc that belongs to the same account/email
// group as the given order (the dual-brand pair + any resubmissions).
function _sampleSiblingIds(order) {
  const key = order.accountId || order.billingEmail || order.contactEmail || order.id;
  return PortalDB.getOrders()
    .filter(o => o.requestSample && (o.accountId || o.billingEmail || o.contactEmail || o.id) === key)
    .map(o => o.id);
}

async function _approveSampleRequest(portalOrderId) {
  const order = PortalDB.getOrders().find(o => o.id === portalOrderId);
  if (!order) return;
  const accountId = order.accountId;
  if (!accountId) { toast('No matched account — match this order to an account first'); return; }
  // Push sample to ShipStation once via the account
  await pushSampleToShipStation(accountId);
  // Mark ALL sibling docs (dual-brand pair) as approved so neither lingers
  const ts = new Date().toISOString();
  for (const id of _sampleSiblingIds(order)) {
    try { await firebase.firestore().collection('portal_orders').doc(id).update({ sampleApproved: true, sampleApprovedAt: ts }); } catch(e) {}
  }
  renderPreOrders(true);
}

async function _declineSampleRequest(portalOrderId) {
  if (!confirm2('Decline this sample request?')) return;
  const order = PortalDB.getOrders().find(o => o.id === portalOrderId);
  if (!order) return;
  for (const id of _sampleSiblingIds(order)) {
    try { await firebase.firestore().collection('portal_orders').doc(id).update({ sampleDeclined: true }); } catch(e) {}
  }
  renderPreOrders(true);
  toast('Sample request declined');
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

function _poTsMs(t) {
  if (!t) return 0;
  if (t.toDate) return t.toDate().getTime();
  if (typeof t.getTime === 'function') return t.getTime();
  return new Date(t).getTime() || 0;
}
// Whether two portal_orders are the purpl+LF halves of ONE submission.
// Requires: different brands, near-simultaneous (<60s), AND a POSITIVE shared
// identity. The old predicates paired on `accountId === accountId`, which is
// TRUE for two unmatched orders (undefined === undefined) — letting two
// different new businesses get merged onto one combined invoice. This never
// pairs on blank ids: both-matched needs equal accountId; both-unmatched needs
// the same non-empty business name AND email; one-matched-one-not never pairs.
function _samePortalSubmission(a, b) {
  if (!a || !b || a.id === b.id) return false;
  if (a.brand === b.brand) return false;
  // Strict: both halves of one checkout carry the same submissionId. If either
  // side has a submissionId, that is the ONLY thing that pairs them — orders
  // from different checkouts (even same account, same minute) never merge.
  if (a.submissionId || b.submissionId) return a.submissionId === b.submissionId;
  // Legacy fallback for orders created before submissionId existed: different
  // brands, near-simultaneous (<60s), AND a positive shared identity.
  const ta = _poTsMs(a.submittedAt), tb = _poTsMs(b.submittedAt);
  if (!ta || !tb || Math.abs(ta - tb) >= 60000) return false;
  if (a.accountId && b.accountId) return a.accountId === b.accountId;
  if (a.accountId || b.accountId) return false;
  const nameA = (a.accountName || '').trim().toLowerCase();
  const nameB = (b.accountName || '').trim().toLowerCase();
  const emA = (a.billingEmail || a.contactEmail || '').trim().toLowerCase();
  const emB = (b.billingEmail || b.contactEmail || '').trim().toLowerCase();
  return !!nameA && nameA === nameB && !!emA && emA === emB;
}

function _renderPoAll() {
  const el = qs('#po-pane-all');
  if (!el) return;
  const orders = PortalDB.getOrders();
  if (!orders.length) {
    el.innerHTML = '<div class="card"><div class="empty" style="padding:32px">No portal submissions yet.</div></div>';
    return;
  }
  // Group orders by account + timestamp (purpl + LF from same submission)
  const grouped = [];
  const used = new Set();
  orders.forEach(o => {
    if (used.has(o.id)) return;
    used.add(o.id);
    const group = { purpl: null, lf: null };
    if (o.brand === 'lf') group.lf = o; else group.purpl = o;
    // Find the opposite-brand half of the same submission (strict identity).
    orders.forEach(p => {
      if (used.has(p.id) || p.id === o.id) return;
      if (!_samePortalSubmission(o, p)) return;
      used.add(p.id);
      if (p.brand === 'lf') group.lf = p; else group.purpl = p;
    });
    grouped.push(group);
  });

  el.innerHTML = `<div class="card"><div class="tbl-wrap"><table>
    <thead><tr>
      <th>Submitted</th><th>Account</th><th>Brand</th><th>Match</th>
      <th>Cases</th><th>Cans</th><th>Delivery Window</th><th>PO#</th>
      <th>Status</th><th>Actions</th>
    </tr></thead>
    <tbody>${grouped.map(g => {
      const o = g.purpl || g.lf;
      const purplCases = g.purpl ? (g.purpl.items||[]).reduce((s,i)=>s+(i.cases||0),0) : 0;
      const lfCases = g.lf ? (g.lf.lineItems||[]).reduce((s,i)=>s+(i.cases||0),0) : 0;
      const cases = purplCases + lfCases;
      const cans  = purplCases * CANS_PER_CASE;
      const brandBadges = [
        g.purpl ? '<span class="badge purple" style="font-size:10px">💜 purpl</span>' : '',
        g.lf ? '<span class="badge green" style="font-size:10px">🪻 LF</span>' : '',
      ].filter(Boolean).join(' ');
      const acLink = o.isMatched && o.accountId
        ? `<strong style="cursor:pointer;color:var(--lavblue)" onclick="openAccount('${o.accountId}')">${escHtml(o.accountName||'')}</strong>`
        : escHtml(o.accountName||'');
      return `<tr>
        <td style="white-space:nowrap;font-size:12px">${_fmtPoDate(o.submittedAt)}</td>
        <td>${acLink}</td>
        <td>${brandBadges}${o.requestSample ? ' <span class="badge" style="font-size:10px;background:#faf5ff;color:#7B4FA0;border:1px solid #e9d5ff">🧪 Sample</span>' : ''}</td>
        <td>${o.isMatched ? '<span class="badge green">✓ Matched</span>' : '<span class="badge red">? Unmatched</span>'}</td>
        <td>${cases||'—'}</td>
        <td>${cans||'—'}</td>
        <td style="font-size:12px">${escHtml(o.deliveryWindow||'—')}</td>
        <td style="font-size:12px">${escHtml(o.poNumber||'—')}</td>
        <td>${_poStatusBadge(o.status||'new')}</td>
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
  // Group dual-brand pairs into one row (mirror the All tab) so a purpl+LF
  // order isn't shown as two rows — one of which falsely read "0 cases"
  // because it only summed o.items (purpl) and ignored o.lineItems (LF).
  const groups = [];
  const used = new Set();
  orders.forEach(o => {
    if (used.has(o.id)) return;
    used.add(o.id);
    const g = { purpl: o.brand === 'lf' ? null : o, lf: o.brand === 'lf' ? o : null };
    orders.forEach(p => {
      if (used.has(p.id) || !_samePortalSubmission(o, p)) return;
      used.add(p.id);
      if (p.brand === 'lf') g.lf = p; else g.purpl = p;
    });
    groups.push(g);
  });
  el.innerHTML = `<div class="card"><div class="tbl-wrap"><table>
    <thead><tr><th>Submitted</th><th>Account</th><th>Brand</th><th>Cases</th><th>Confirmed</th><th>Order ID</th></tr></thead>
    <tbody>${groups.map(g => {
      const o = g.purpl || g.lf;
      const purplCases = (g.purpl?.items||[]).reduce((s,i)=>s+(i.cases||0),0);
      const lfCases    = (g.lf?.lineItems||[]).reduce((s,i)=>s+(i.cases||0),0);
      const brands = [g.purpl?'💜 purpl':'', g.lf?'🪻 LF':''].filter(Boolean).join(' + ');
      const casesLabel = [g.purpl?`${purplCases} purpl`:'', g.lf?`${lfCases} LF`:''].filter(Boolean).join(' · ') || '0';
      let _cAt = o.confirmedAt;
      if (_cAt && _cAt.toDate) _cAt = _cAt.toDate(); // Firestore Timestamp → Date
      const confirmDate = _cAt instanceof Date ? fmtD(_cAt.toISOString().slice(0,10))
        : (typeof _cAt === 'string' && _cAt ? fmtD(_cAt.slice(0,10)) : '—');
      const convId = g.purpl?.convertedOrderId || g.lf?.convertedOrderId || '—';
      return `<tr>
        <td style="font-size:12px">${_fmtPoDate(o.submittedAt)}</td>
        <td>${o.isMatched&&o.accountId
          ? `<span style="cursor:pointer;color:var(--lavblue)" onclick="openAccount('${o.accountId}')">${escHtml(o.accountName||'')}</span>`
          : escHtml(o.accountName||'')}</td>
        <td style="font-size:12px">${brands}</td>
        <td style="font-size:12px">${casesLabel}</td>
        <td style="font-size:12px">${confirmDate}</td>
        <td style="font-size:11px;color:var(--muted)">${convId}</td>
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
        const url   = token ? `https://pbfwholesale.com/order?t=${token}` : null;
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
          ${url ? `<span style="cursor:pointer;color:var(--lavblue)" onclick="generateOrderLink('${a.id}')" title="${url}">${url.slice(0,50)}…</span>` : '<span style="color:var(--muted)">Not generated yet</span>'}
        </td>
        <td style="font-size:12px">${a.orderPortalTokenCreatedAt ? fmtD(a.orderPortalTokenCreatedAt) : '—'}</td>
        <td>${subCount > 0
          ? `<span class="badge green">Yes (${subCount})</span>`
          : '<span class="badge gray">No</span>'}</td>
        <td><button class="btn xs" onclick="generateOrderLink('${a.id}')">🔗 Copy Link</button></td>
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
        <div class="section-hdr" style="margin-bottom:12px"><h2>🪻 LF Form Submissions</h2></div>
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
            // Match SKU by name, then build the qty/variant area for it
            const skuSel = lastRow.querySelector('.lfi-sku-sel');
            if (skuSel && it.skuName) {
              const matchOpt = Array.from(skuSel.options).find(opt => opt.text.includes(it.skuName));
              if (matchOpt) {
                skuSel.value = matchOpt.value;
                _lfInvBuildVariantArea(rowId, null);
              }
            }
            // Simple SKUs get the case count prefilled; variant SKUs are left
            // for manual entry since the portal order doesn't say which variants
            const casesEl = lastRow.querySelector('.lfi-cases');
            if (casesEl) { casesEl.value = it.cases||0; _lfInvRowCalc(rowId); }
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

  // Find paired LF/purpl order from same submission (strict identity).
  const paired = PortalDB.getOrders().find(p => _samePortalSubmission(o, p));
  const purplOrd = o.brand === 'lf' ? paired : o;
  const lfOrd = o.brand === 'lf' ? o : paired;

  const cases = purplOrd ? (purplOrd.items||[]).reduce((s,i)=>s+(i.cases||0),0) : 0;
  const cans = cases * CANS_PER_CASE;
  const notifySkus = (o.notifyMe||[]).join(', ');

  // Build LF line items display
  let lfHtml = '';
  if (lfOrd) {
    const lfItems = lfOrd.lineItems || [];
    if (lfItems.length) {
      lfHtml = `<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
        <div style="font-size:12px;font-weight:700;color:#4a7c59;margin-bottom:8px">🪻 Lavender Fields Items</div>
        ${lfItems.map(li => {
          if (li.hasVariants && li.variantLines) {
            return `<div style="margin-bottom:6px"><strong>${escHtml(li.skuName||'')}</strong>
              ${li.variantLines.map(vl => `<div style="font-size:12px;color:var(--muted);padding-left:12px">— ${escHtml(vl.variantName||'')}${vl.units ? ': '+vl.units+' units' : ''}</div>`).join('')}
              <div style="font-size:12px;font-weight:600;color:#4a7c59;padding-left:12px">$${(li.lineTotal||0).toFixed(2)}</div>
            </div>`;
          }
          return `<div style="margin-bottom:4px"><strong>${escHtml(li.skuName||'')}</strong> — ${li.cases||0} cases · $${(li.lineTotal||0).toFixed(2)}</div>`;
        }).join('')}
        <div style="font-weight:700;color:#4a7c59;margin-top:6px">LF Total: $${(lfOrd.total||lfItems.reduce((s,l)=>s+(l.lineTotal||0),0)).toFixed(2)}</div>
      </div>`;
    }
  }

  qs('#mpr-body').innerHTML = `
    <div class="card-grid grid-2" style="gap:12px;margin-bottom:12px">
      <div><div style="font-size:11px;color:var(--muted)">Business</div><div style="font-weight:600">${escHtml(o.accountName||'—')}</div></div>
      <div><div style="font-size:11px;color:var(--muted)">Billing Email</div><div>${escHtml(o.billingEmail||o.contactEmail||'—')}</div></div>
      <div><div style="font-size:11px;color:var(--muted)">Submitted</div><div style="font-size:13px">${_fmtPoDate(o.submittedAt)}</div></div>
      <div><div style="font-size:11px;color:var(--muted)">Brands</div><div>${purplOrd ? '<span class="badge purple" style="font-size:10px">💜 purpl</span> ' : ''}${lfOrd ? '<span class="badge green" style="font-size:10px">🪻 LF</span>' : ''}</div></div>
    </div>
    ${purplOrd && cases > 0 ? `<div style="padding:10px 0;border-top:1px solid var(--border)">
      <div style="font-size:12px;font-weight:700;color:#8B5FBF;margin-bottom:6px">💜 purpl Lemonade</div>
      <div style="font-weight:600">${cases} case${cases!==1?'s':''} <span style="color:var(--muted);font-size:12px">(${cans} cans)</span></div>
    </div>` : ''}
    ${lfHtml}
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
      <div class="card-grid grid-2" style="gap:10px">
        <div><div style="font-size:11px;color:var(--muted)">PO Number</div><div>${escHtml(o.poNumber||(paired?.poNumber)||'—')}</div></div>
        <div><div style="font-size:11px;color:var(--muted)">Delivery Window</div><div>${escHtml(o.deliveryWindow||(paired?.deliveryWindow)||'—')}</div></div>
        <div><div style="font-size:11px;color:var(--muted)">Notes</div><div style="font-size:13px">${escHtml(o.notes||(paired?.notes)||'—')}</div></div>
        <div><div style="font-size:11px;color:var(--muted)">Status</div><div>${_poStatusBadge(o.status||'new')}</div></div>
        ${notifySkus?`<div><div style="font-size:11px;color:var(--muted)">Notify Me</div><div style="font-size:13px">${escHtml(notifySkus)}</div></div>`:''}
      </div>
    </div>
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
    priority:'medium', notes:[], outreach:[], lastContacted: null,
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
  // Decline BOTH halves of a dual-brand submission — declining only the
  // clicked doc left the paired other-brand doc status 'new' forever (it is
  // grouped into the same row, so it was invisible but kept the nav badge lit).
  const o = PortalDB.getOrders().find(x => x.id === id);
  const paired = o ? PortalDB.getOrders().find(p =>
    !['confirmed','declined'].includes(p.status) && _samePortalSubmission(o, p)) : null;
  await PortalDB.updateOrder(id, { status:'declined' });
  if (paired) await PortalDB.updateOrder(paired.id, { status:'declined' });
  toast('Submission declined' + (paired ? ' (both brands)' : ''));
  renderPreOrders(true);
}

async function deletePortalOrder(orderId) {
  if (!_requireAdmin('delete portal orders')) return;
  if (!confirm('Delete this submission? Cannot be undone.')) return;
  try {
    // Find the paired order (same account, within 60s, different brand) and delete both
    const order = PortalDB.getOrders().find(o => o.id === orderId);
    const toDelete = [orderId];
    if (order) {
      const oTime = order.submittedAt?.toDate ? order.submittedAt.toDate().getTime()
                  : (order.submittedAt ? new Date(order.submittedAt).getTime() : 0);
      const paired = PortalDB.getOrders().find(p => _samePortalSubmission(order, p));
      if (paired) toDelete.push(paired.id);
    }
    await Promise.all(toDelete.map(id =>
      firebase.firestore().collection('portal_orders').doc(id).delete()
    ));
    toast('Deleted ✓' + (toDelete.length > 1 ? ' (paired order also removed)' : ''));
    renderPreOrders(true);
  } catch(e) {
    console.error(e);
    toast('Error deleting');
  }
}

// ── Confirm portal order flow ─────────────────────────────

let _portalOrderId = null;

function openConfirmPortalOrder(id) {
  _portalOrderId = id;
  const o = PortalDB.getOrders().find(x => x.id === id);
  if (!o) return;
  const isUnmatched = !o.accountId;

  // Find paired order from same submission (strict identity).
  const paired = PortalDB.getOrders().find(p => _samePortalSubmission(o, p));
  const purplDoc = o.brand === 'lf' ? paired : o;
  const lfDoc    = o.brand === 'lf' ? o : paired;
  const hasPurpl = purplDoc && (purplDoc.items||[]).some(i => (i.cases||0) > 0);
  const hasLf    = lfDoc && (lfDoc.lineItems||[]).length > 0;
  const purplCases = hasPurpl ? (purplDoc.items||[]).reduce((s,i)=>s+(i.cases||0),0) : 0;

  // Show/hide account picker for unmatched orders
  const pickerEl = qs('#mcpo-account-picker');
  if (pickerEl) {
    pickerEl.style.display = isUnmatched ? '' : 'none';
    if (isUnmatched) {
      const sel = qs('#mcpo-account-select');
      if (sel) {
        const accounts = DB.a('ac').filter(a => a.status === 'active').sort((a,b) => (a.name||'') < (b.name||'') ? -1 : 1);
        sel.innerHTML = '<option value="">Select account...</option>' +
          accounts.map(a => `<option value="${a.id}">${escHtml(a.name)}</option>`).join('');
      }
    }
  }

  let brandSummary = '';
  if (hasPurpl) {
    brandSummary += `<div style="margin-top:8px;padding:8px 10px;background:#fdf9ff;border-radius:6px;border:1px solid #e9d5ff">
      <div style="font-size:11px;font-weight:700;color:#8B5FBF;margin-bottom:4px">💜 purpl Lemonade</div>
      <div style="font-size:14px;font-weight:600">${purplCases} case${purplCases!==1?'s':''} <span style="color:var(--muted);font-size:12px">(${purplCases*CANS_PER_CASE} cans)</span></div>
    </div>`;
  }
  if (hasLf) {
    const lfItems = lfDoc.lineItems || [];
    const lfTotal = lfDoc.total || lfItems.reduce((s,li)=>s+(li.lineTotal||0),0);
    brandSummary += `<div style="margin-top:8px;padding:8px 10px;background:#f0f7f1;border-radius:6px;border:1px solid #b8d4c0">
      <div style="font-size:11px;font-weight:700;color:#4a7c59;margin-bottom:4px">🪻 Lavender Fields</div>
      ${lfItems.map(li => `<div style="font-size:13px">${escHtml(li.skuName||'')} — ${li.cases||0} case${(li.cases||0)!==1?'s':''} · $${(li.lineTotal||0).toFixed(2)}</div>`).join('')}
      <div style="font-size:13px;font-weight:600;color:#4a7c59;margin-top:4px">LF Total: $${lfTotal.toFixed(2)}</div>
    </div>`;
  }
  if (hasPurpl && hasLf) {
    brandSummary += `<div style="margin-top:8px;padding:6px 10px;background:#eff6ff;border-radius:6px;font-size:12px;color:#1e40af">This will create a <strong>combined invoice</strong> for both brands.</div>`;
  }

  qs('#mcpo-body').innerHTML = `
    <div style="font-size:14px;margin-bottom:12px">
      <div style="font-weight:600;font-size:15px;margin-bottom:4px">${escHtml(o.accountName)}</div>
      <div style="font-size:12px;color:var(--muted)">Portal submission · ${_fmtPoDate(o.submittedAt)}</div>
      ${o.deliveryWindow?`<div style="font-size:12px;margin-top:4px"><strong>Delivery:</strong> ${escHtml(o.deliveryWindow)}</div>`:''}
    </div>
    ${brandSummary}
  `;

  const qtyInput = qs('#mcpo-classic-qty');
  if (qtyInput) {
    qtyInput.value = purplCases;
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

// Build a Wix pull-deduction record for an LF invoice, mirroring the shape
// _saveLfInvoiceCore writes (~11980), so confirmed LF portal invoices generate
// a Wix stock-pull instruction instead of silently deducting nothing. The LF
// save path de-dupes by invoiceId, so editing/sending later won't double it.
function _lfWixDeductionFor(invId, invNum, lfItems, accountId, accountName, dateStr) {
  return {
    id: uid(), invoiceId: invId, invoiceNumber: invNum,
    accountId, accountName, date: dateStr,
    items: (lfItems || []).flatMap(l => l.hasVariants
      ? (l.variantLines || []).map(vl => ({ skuName: l.skuName, variantName: vl.variantName, cases: vl.cases, units: vl.units }))
      : [{ skuName: l.skuName, cases: l.cases, units: l.units }]),
    confirmed: false,
  };
}

let _confirmPortalInFlight = false;
async function confirmPortalOrder() {
  if (!_portalOrderId) return;
  if (_confirmPortalInFlight) { toast('Confirming — please wait…'); return; }
  _confirmPortalInFlight = true;
  try {
    const portalRef = firebase.firestore()
      .collection('portal_orders').doc(_portalOrderId);
    const d = await firebase.firestore().runTransaction(async tx => {
      const snap = await tx.get(portalRef);
      const data = snap.data();
      if (data.status === 'confirmed') return null;
      tx.update(portalRef, { status: 'confirmed', confirmedAt: firebase.firestore.FieldValue.serverTimestamp() });
      return data;
    });
    if (!d) { toast('This order has already been confirmed'); closeModal('modal-confirm-portal-order'); return; }

    // If unmatched, use the selected account from the picker
    if (!d.accountId) {
      const selectedAcId = qs('#mcpo-account-select')?.value;
      if (!selectedAcId) {
        toast('Select an account to match this order');
        // B2: the opening transaction already flipped status to 'confirmed' to
        // claim the order. We're bailing, so restore it — otherwise the order is
        // stranded as confirmed with no account and no invoice, vanishing from
        // the queue. (`d` is the pre-flip data, so d.status is the original.)
        await portalRef.update({ status: d.status || 'new', confirmedAt: null }).catch(() => {});
        return;
      }
      d.accountId = selectedAcId;
      d.accountName = DB.a('ac').find(x => x.id === selectedAcId)?.name || d.accountName;
      await portalRef.update({ accountId: selectedAcId, accountName: d.accountName, isUnmatched: false });
    }

    // Invoice date priority: (1) the date the user picked in the confirm modal
    // ("Invoice / Delivery Date"), (2) the configured pre-order launch date,
    // (3) today. Previously the picked date was loaded into the field but never
    // read back here, so any back/post-dated value silently reverted to today.
    const pickedDate = (qs('#mcpo-due-date')?.value || '').trim();
    const portalConfig = await PortalDB.getConfig();
    const isPreorder = d.mode === 'preorder';
    const invoiceDate = pickedDate || ((isPreorder && portalConfig.launchDate) ? portalConfig.launchDate : today());
    const todayStr = invoiceDate;
    const acct = DB.a('ac').find(x => x.id === d.accountId) || {};
    const isDistFulfilled = acct.fulfilledBy && acct.fulfilledBy !== 'direct';

    // Find paired order from same submission (other brand, within 60s)
    const allPortal = PortalDB.getOrders();
    let paired = allPortal.find(p => p.status !== 'confirmed' && _samePortalSubmission(d, p));
    // #4: claim the paired (other-brand) doc TRANSACTIONALLY before building the
    // combined invoice, so two tabs converting the two halves of one submission
    // can't both succeed. If it's already been confirmed elsewhere, drop it and
    // convert this half as a single-brand order instead of double-invoicing.
    if (paired) {
      const pairedRef = firebase.firestore().collection('portal_orders').doc(paired.id);
      const claimed = await firebase.firestore().runTransaction(async tx => {
        const ps = await tx.get(pairedRef);
        if (!ps.exists || ps.data().status === 'confirmed') return false;
        tx.update(pairedRef, { status: 'confirmed', confirmedAt: firebase.firestore.FieldValue.serverTimestamp() });
        return true;
      });
      if (!claimed) paired = null;
    }

    const purplDoc = d.brand === 'lf' ? paired : d;
    const lfDoc    = d.brand === 'lf' ? d : paired;
    const hasPurpl = purplDoc && (purplDoc.items||[]).some(i => (i.cases||0) > 0);
    const hasLf    = lfDoc && (lfDoc.lineItems||[]).length > 0;
    const isDual   = hasPurpl && hasLf;

    // Merge staff notes typed in the confirm modal into the order notes — the
    // field was populated but never read. Ignore the untouched
    // "Delivery: {window}" prefill (the window is stored separately).
    const _staffNotes = qs('#mcpo-notes')?.value?.trim() || '';
    const _notePrefills = new Set([d.deliveryWindow, purplDoc?.deliveryWindow, lfDoc?.deliveryWindow]
      .filter(Boolean).map(w => 'Delivery: ' + w));
    if (_staffNotes && !_notePrefills.has(_staffNotes)) {
      d.notes = [d.notes, _staffNotes].filter(Boolean).join(' — ');
    }

    // Build purpl items
    let purplItems = [], purplCases = 0, purplCans = 0;
    if (hasPurpl) {
      const casesFromModal = parseInt(qs('#mcpo-classic-qty')?.value || 0);
      const portalItems = (purplDoc.items || []).filter(i => i.cases > 0);
      if (portalItems.length) {
        purplItems = portalItems.map(i => ({ sku: i.sku || 'classic', label: i.label || 'Classic Lavender Lemonade', qty: i.cases }));
        // The modal shows an editable Cases field — honor it. For single-item
        // orders an edited value overrides the portal quantity (it used to be
        // silently ignored, so adjusting 10→8 at confirm still invoiced 10).
        // Multi-SKU orders keep per-item portal quantities.
        if (purplItems.length === 1 && casesFromModal > 0 && casesFromModal !== purplItems[0].qty) {
          purplItems[0].qty = casesFromModal;
        }
      } else if (casesFromModal > 0) {
        purplItems = [{ sku: 'classic', label: 'Classic Lavender Lemonade', qty: casesFromModal }];
      }
      purplCases = purplItems.reduce((s, i) => s + i.qty, 0);
      purplCans = purplCases * CANS_PER_CASE;
    }

    // Build LF items
    let lfItems = [];
    let lfTotal = 0;
    if (hasLf) {
      lfItems = (lfDoc.lineItems || []).map(li => ({
        skuId: li.skuId || li.skuName || 'lf',
        skuName: li.skuName || 'Lavender Fields',
        description: li.skuName || 'Lavender Fields',
        cases: li.cases || 0,
        units: li.units || (li.cases || 0) * (li.caseSize || 1),
        caseSize: li.caseSize || 1,
        unitPrice: li.unitPrice || li.wholesalePrice || 0,
        pricePerUnit: li.unitPrice || li.wholesalePrice || 0,
        lineTotal: li.lineTotal || 0,
        total: li.lineTotal || 0,
        hasVariants: !!li.hasVariants,
        variantLines: li.variantLines || [],
      }));
      lfTotal = lfDoc.total || lfItems.reduce((s, li) => s + (li.lineTotal || 0), 0);
    }

    if (purplCases < 1 && lfItems.length < 1) {
      toast('Order has no items');
      // B2: restore claimed status on bail so the order isn't stranded as
      // confirmed-with-no-invoice. Revert the paired half too if we claimed it.
      await portalRef.update({ status: d.status || 'new', confirmedAt: null }).catch(() => {});
      if (paired) {
        await firebase.firestore().collection('portal_orders').doc(paired.id)
          .update({ status: paired.status || 'new', confirmedAt: null }).catch(() => {});
      }
      return;
    }

    // Pricing
    const effectivePrice = _calcPricePerCase(acct);
    const purplTotal = purplCases * effectivePrice;

    // Due date = chosen invoice date + terms (not "now" + terms), so a
    // back/post-dated invoice keeps its terms window relative to its own date.
    const invTerms = DB.obj('invoice_settings', { terms: 30 }).terms || _payTerms();
    const _invDateMs = new Date(invoiceDate + 'T00:00:00').getTime();
    const dueDateStr = new Date((isNaN(_invDateMs) ? Date.now() : _invDateMs) + invTerms * 864e5).toISOString().slice(0, 10);
    const deliveryMethod = qs('#mcpo-delivery-method')?.value || 'deliver';
    const fulfillmentSource = qs('#mcpo-fulfillment')?.value || 'warehouse';

    // Create order record(s)
    const purplOrderId = hasPurpl ? uid() : null;
    const lfOrderId = hasLf ? uid() : null;

    // Pre-compute invoice numbers atomically BEFORE mutating cache
    let purplNum, lfNum, combNum, purplInvId, lfInvId, combId;
    let singleInvNum, singleInvId;
    if (isDual) {
      purplNum = await getNextInvoiceNumber('purpl');
      lfNum    = await getNextInvoiceNumber('lf');
      combNum  = await getNextInvoiceNumber('combined');
      purplInvId = uid();
      lfInvId    = uid();
      combId     = uid();
    } else if (hasPurpl) {
      singleInvNum = await getNextInvoiceNumber('purpl');
      singleInvId = uid();
    } else if (hasLf) {
      singleInvNum = await getNextInvoiceNumber('lf');
      singleInvId = uid();
    }

    // Single atomicUpdate for all writes — orders + invoices together.
    // (No markDirty/markClean here: atomicUpdate guards itself via
    // _atomicInProgress, and markClean's remote-reload could wipe the
    // just-created invoice before it persists.)
    DB.atomicUpdate(cache => {
      // Orders
      if (hasPurpl) {
        cache['orders'] = [...(cache['orders'] || []), {
          id: purplOrderId, accountId: d.accountId, accountName: d.accountName,
          created: todayStr, dueDate: todayStr, items: purplItems,
          cases: purplCases, cans: purplCans, status: 'pending', source: 'portal', brand: 'purpl',
          linkedPortalOrderId: purplDoc.id || _portalOrderId,
          combinedOrderGroupId: isDual ? (combId || _portalOrderId) : null,
          notes: d.notes || '', deliveryWindow: d.deliveryWindow || purplDoc.deliveryWindow || '',
        }];
      }
      if (hasLf) {
        cache['orders'] = [...(cache['orders'] || []), {
          id: lfOrderId, accountId: d.accountId, accountName: d.accountName,
          created: todayStr, dueDate: todayStr, items: lfItems.map(li => ({ sku: li.skuId, label: li.skuName, qty: li.cases })),
          cases: lfItems.reduce((s,li)=>s+(li.cases||0),0), cans: 0, status: 'pending', source: 'portal', brand: 'lf',
          linkedPortalOrderId: lfDoc.id || _portalOrderId,
          combinedOrderGroupId: isDual ? (combId || _portalOrderId) : null,
          notes: d.notes || '', deliveryWindow: d.deliveryWindow || lfDoc?.deliveryWindow || '',
        }];
      }
      if (d.accountId) {
        const key = d.isProspect ? 'pr' : 'ac';
        cache[key] = (cache[key] || []).map(a =>
          a.id === d.accountId ? { ...a, lastOrder: todayStr } : a
        );
      }

      // Invoices — combined if dual-brand, single otherwise
      if (isDual) {
        cache.retail_invoices = [...(cache.retail_invoices||[]), {
          id: purplInvId, number: purplNum, invoiceNumber: purplNum,
          accountId: d.accountId, accountName: d.accountName,
          date: todayStr, dueDate: dueDateStr,
          total: purplTotal, amount: purplTotal, status: 'draft',
          lineItems: purplItems.map(i => ({
            skuId: i.sku, sku: i.label, description: i.label,
            qty: i.qty, cases: i.qty, units: i.qty * CANS_PER_CASE,
            unitPrice: effectivePrice, pricePerCase: effectivePrice,
            total: i.qty * effectivePrice, lineTotal: i.qty * effectivePrice,
          })),
          billingEmail: d.billingEmail || acct.email || '',
          notes: 'Auto-drafted from portal order.', deliveryMethod, fulfillmentSource,
          combinedInvoiceId: combId, source: 'portal',
          linkedPortalOrderId: purplDoc.id || _portalOrderId,
        }];
        cache.lf_invoices = [...(cache.lf_invoices||[]), {
          id: lfInvId, number: lfNum, invoiceNumber: lfNum,
          accountId: d.accountId, accountName: d.accountName,
          date: todayStr, dueDate: dueDateStr,
          total: lfTotal, amount: lfTotal, status: 'draft',
          lineItems: lfItems,
          billingEmail: d.billingEmail || acct.email || '',
          notes: 'Auto-drafted from portal order.', deliveryMethod, fulfillmentSource,
          combinedInvoiceId: combId, source: 'portal',
          linkedPortalOrderId: lfDoc.id || _portalOrderId,
        }];
        cache.lf_wix_deductions = [...(cache.lf_wix_deductions || []), _lfWixDeductionFor(lfInvId, lfNum, lfItems, d.accountId, d.accountName, todayStr)];
        cache.combined_invoices = [...(cache.combined_invoices||[]), {
          id: combId, number: combNum, invoiceNumber: combNum,
          purplInvoiceId: purplInvId, lfInvoiceId: lfInvId,
          accountId: d.accountId, accountName: d.accountName, status: 'draft',
          date: todayStr, dueDate: dueDateStr, deliveryMethod, fulfillmentSource,
          createdAt: new Date().toISOString(), sentAt: null, paidAt: null,
          purplSubtotal: purplTotal, lfSubtotal: lfTotal, grandTotal: purplTotal + lfTotal,
          notes: 'Auto-drafted from portal order.', source: 'portal',
          portalOrderId: _portalOrderId,
        }];
      } else if (hasPurpl) {
        cache.retail_invoices = [...(cache.retail_invoices||[]), {
          id: singleInvId, number: singleInvNum, invoiceNumber: singleInvNum,
          accountId: d.accountId, accountName: d.accountName,
          orderId: purplOrderId, date: todayStr, dueDate: dueDateStr,
          cases: purplCases, cans: purplCans,
          pricePerCase: effectivePrice, total: purplTotal, amount: purplTotal,
          // Include a lineItems array like manual + combined invoices so the
          // Edit modal, print/preview, and (critically) the markInvoiceSent
          // inventory deduction all see the products. Without it, this invoice
          // looked empty in Edit and would deduct zero cans on send.
          lineItems: purplItems.map(i => ({
            skuId: i.sku, sku: i.label, description: i.label,
            qty: i.qty, cases: i.qty, units: i.qty * CANS_PER_CASE,
            unitPrice: effectivePrice, pricePerCase: effectivePrice,
            total: i.qty * effectivePrice, lineTotal: i.qty * effectivePrice,
          })),
          priceType: isDistFulfilled ? 'dist' : 'direct',
          status: 'draft', source: 'portal', brand: 'purpl', deliveryMethod, fulfillmentSource,
          billingEmail: d.billingEmail || acct.email || '',
          notes: 'Auto-drafted from portal order.',
          linkedPortalOrderId: _portalOrderId,
        }];
      } else if (hasLf) {
        cache.lf_invoices = [...(cache.lf_invoices||[]), {
          id: singleInvId, number: singleInvNum, invoiceNumber: singleInvNum,
          accountId: d.accountId, accountName: d.accountName,
          orderId: lfOrderId, date: todayStr, dueDate: dueDateStr,
          total: lfTotal, amount: lfTotal, status: 'draft', source: 'portal', deliveryMethod,
          lineItems: lfItems,
          billingEmail: d.billingEmail || acct.email || '',
          notes: 'Auto-drafted from portal order.',
          linkedPortalOrderId: lfDoc.id || _portalOrderId,
        }];
        cache.lf_wix_deductions = [...(cache.lf_wix_deductions || []), _lfWixDeductionFor(singleInvId, singleInvNum, lfItems, d.accountId, d.accountName, todayStr)];
      }
    });

    // Update portal_orders — primary already confirmed in transaction above
    await portalRef.update({ convertedOrderId: purplOrderId || lfOrderId });
    if (paired) {
      const pairedRef = firebase.firestore().collection('portal_orders').doc(paired.id);
      await pairedRef.update({
        status: 'confirmed',
        confirmedAt: firebase.firestore.FieldValue.serverTimestamp(),
        convertedOrderId: paired.brand === 'lf' ? lfOrderId : purplOrderId,
      }).catch(e => console.warn('Paired order status update failed:', e));
    }

    // Auto-push to ShipStation if delivery method is 'ship'
    if (deliveryMethod === 'ship') {
      const pushInvId = isDual ? combId : singleInvId;
      const pushCol = isDual ? 'combined_invoices' : (hasPurpl ? 'retail_invoices' : 'lf_invoices');
      try { await pushInvoiceToShipStation(pushInvId, pushCol); } catch(e) { console.warn('ShipStation push failed:', e); }
    }

    closeModal('modal-confirm-portal-order');
    renderPreOrders(true);
    if (isDual) {
      toast('✓ Order confirmed · Combined invoice draft created' + (deliveryMethod === 'ship' ? ' · Pushed to ShipStation' : ''));
    } else {
      toast('✓ Order confirmed · Invoice draft created' + (deliveryMethod === 'ship' ? ' · Pushed to ShipStation' : ''));
    }

    // Note: confirmation email is NOT sent here — the customer already
    // received one from the portal at submit time. This avoid duplicates.
    // Log the confirmation to the account's cadence instead.
    if (d.accountId && !d.isProspect) {
      const entry = {
        id: uid(),
        stage: 'order_confirmation',
        sentAt: new Date().toISOString(),
        sentBy: _currentUserName(),
        method: 'crm_confirm',
      };
      DB.update('ac', d.accountId, a => ({
        ...a,
        lastContacted: today(),
        cadence: _pushCadence(a.cadence, entry),
      }));
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
  } finally {
    _confirmPortalInFlight = false;
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
  const pwEl = qs('#portal-password-setting');
  if (pwEl) pwEl.value = config.portalPassword || '';
  const dlEnabled = qs('#portal-deadline-enabled');
  if (dlEnabled) { dlEnabled.checked = !!config.deadlineEnabled; togglePortalDeadline(); }
  const dlDate = qs('#portal-deadline');
  if (dlDate) dlDate.value = config.deadline || '';
  const ldEl = qs('#portal-launch-date');
  if (ldEl) ldEl.value = config.launchDate || '';

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
  const portalPassword = qs('#portal-password-setting')?.value?.trim() || '';
  const launchDate = qs('#portal-launch-date')?.value || null;
  const config    = { mode, pricePerCase: price, portalPassword, deadlineEnabled: dlEnabled, deadline: dlEnabled ? deadline : null, launchDate };
  try {
    await PortalDB.saveConfig(config);
    // The portal reads its config via the getPortalConfig Cloud Function,
    // which reads portal_settings/config — NOT portal_config/main (where
    // saveConfig writes). Mirror the full public config there, or the price/
    // mode/launch date saved in Settings never reach the customer order form.
    // (Previously only portalPassword was mirrored, so the order form always
    // saw pricePerCase: null and showed no pricing.)
    await firebase.firestore().collection('portal_settings').doc('config')
      .set({ portalPassword, mode, pricePerCase: price, launchDate,
             deadlineEnabled: dlEnabled, deadline: dlEnabled ? deadline : null }, { merge: true });
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
  const inRetail = DB.a('retail_invoices').find(x => x.id === id);
  const inLf = DB.a('lf_invoices').find(x => x.id === id);
  if (inRetail) DB.update('retail_invoices', id, x => ({...x, status:'paid', paidDate:today(), paidAt:new Date().toISOString()}));
  else if (inLf) DB.update('lf_invoices', id, x => ({...x, status:'paid', paidDate:today(), paidAt:new Date().toISOString()}));
  else DB.update('iv', id, x => ({...x, status:'paid', paidDate:today(), paidAt:new Date().toISOString()}));
  _syncCombinedParentForChild(id); // M1
  renderInvoicesPage();
  toast('Marked as paid ✓');
}

// editInv — open invoice modal pre-filled
function editInv(id) {
  openInvModal(id);
}

let _invTypeFilter = 'all';

function setInvTypeFilter(t) {
  _invTypeFilter = t;
  document.querySelectorAll('#inv-type-pills .ac-brand-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.type === t));
  renderInvoicesPage();
}

function renderInvoicesPage() {
  const tbody = qs('#inv-unified-tbody');
  if (!DB._firestoreReady) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty">Loading…</td></tr>';
    return;
  }
  const actionsEl = qs('#inv-page-actions');
  if (actionsEl) actionsEl.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn sm primary" onclick="openInvModal()" style="font-weight:600">💜 purpl Invoice</button>
      <button class="btn sm primary" onclick="openLfInvoiceModal(null)" style="font-weight:600;background:#4a7c59;border-color:#4a7c59">🪻 LF Invoice</button>
      <button class="btn sm primary" onclick="openNewCombinedModal()" style="font-weight:600;background:#d97706;border-color:#d97706">🤝 Combined</button>
      <button class="btn sm" onclick="pickDistForInvoice()" style="font-weight:600">🚚 Distributor</button>
    </div>`;
  renderInvKpis();
  renderInvUnifiedList();
}

// One list for every invoice type — replaces the four collapsible columns.
function renderInvUnifiedList() {
  const tbody = qs('#inv-unified-tbody');
  if (!tbody) return;
  const todayStr = today();
  const q = (qs('#inv-search')?.value || '').toLowerCase().trim();
  const statusFilter = qs('#inv-status-filter')?.value || 'all';

  const effStatus = x => {
    const st = x.status || 'draft';
    if (['paid','draft','void'].includes(st)) return st;
    const due = x.dueDate || x.due || '';
    return (due && due < todayStr) ? 'overdue' : st;
  };

  const rows = [];
  const push = (x, type, opts) => rows.push({
    id: x.id, type,
    num: x.number || x.invoiceNumber || '—',
    name: opts.name,
    issued: opts.issued || '',
    due: opts.due || '',
    amt: opts.amt,
    st: effStatus(x),
    rawSt: x.status || 'draft',
    inv: x,
    edit: opts.edit, print: opts.print, paidFn: opts.paidFn,
  });

  if (_invTypeFilter === 'all' || _invTypeFilter === 'purpl') {
    _allPurplInvoices().filter(x => !x.combinedInvoiceId).forEach(x => push(x, 'purpl', {
      name: x.accountName || DB.a('ac').find(a=>a.id===x.accountId)?.name || '—',
      issued: x.date || '', due: x.dueDate || x.due || '',
      amt: parseFloat(x.amount || x.total || 0),
      edit: `openInvModal('${x.id}')`, print: `openInvoicePreview('purpl','${x.id}')`,
      paidFn: `markRetailInvPaid('${x.id}')`,
    }));
  }
  if (_invTypeFilter === 'all' || _invTypeFilter === 'lf') {
    DB.a('lf_invoices').filter(x => !x.combinedInvoiceId).forEach(x => push(x, 'lf', {
      name: x.accountName || '—',
      issued: x.issued || x.date || '', due: x.due || x.dueDate || '',
      amt: parseFloat(x.total || 0),
      edit: `openLfInvoiceModal('${x.id}')`, print: `openInvoicePreview('lf','${x.id}')`,
      paidFn: `markLfInvPaid('${x.id}')`,
    }));
  }
  if (_invTypeFilter === 'all' || _invTypeFilter === 'combined') {
    DB.a('combined_invoices').forEach(x => push(x, 'combined', {
      name: x.accountName || '—',
      issued: x.date || (x.createdAt||'').slice(0,10), due: x.dueDate || x.due || '',
      amt: parseFloat(x.grandTotal || 0),
      edit: null, print: `openInvoicePreview('combined','${x.id}')`,
      paidFn: `markCombinedPaid('${x.id}')`,
    }));
  }
  if (_invTypeFilter === 'all' || _invTypeFilter === 'dist') {
    DB.a('dist_invoices').forEach(x => push(x, 'dist', {
      name: x.distName || '—',
      issued: x.dateIssued || '', due: x.dueDate || '',
      amt: parseFloat(x.total || 0),
      edit: `editDistInvoice('${x.id}')`, print: `openInvoicePreview('dist','${x.id}')`,
      paidFn: `markDistInvoicePaid('${x.id}','${x.distId||''}')`,
    }));
  }

  let list = rows;
  if (statusFilter === 'open')        list = list.filter(r => !['paid','void'].includes(r.st));
  else if (statusFilter !== 'all')    list = list.filter(r => r.st === statusFilter);
  if (q) list = list.filter(r => (r.num + ' ' + r.name).toLowerCase().includes(q));
  list.sort((a,b) => (b.issued||'').localeCompare(a.issued||''));

  const typeBadge = {
    purpl:    '<span class="badge purple">purpl</span>',
    lf:       '<span class="badge" style="background:#dcfce7;color:#166534">LF</span>',
    combined: '<span class="badge amber">Combined</span>',
    dist:     '<span class="badge gray">Dist</span>',
  };
  const stBadge = r => {
    const cls = {paid:'green', draft:'gray', sent:'blue', overdue:'red', void:'red'}[r.st] || 'gray';
    return `<span class="badge ${cls}">${r.st}</span>`;
  };

  tbody.innerHTML = list.map(r => `<tr>
    <td style="white-space:nowrap">${typeBadge[r.type]||''} <strong style="margin-left:4px">${escHtml(r.num)}</strong>${r.inv.readyToSend?' <span class="badge green" style="font-size:10px;animation:pulse 1.5s infinite">📦 Ready to send</span>':r.inv.deliveryMethod==='ship'?' <span class="badge gray" style="font-size:10px">📦 Ship</span>':''}${r.inv.fulfillmentSource==='warehouse'?' <span class="badge" style="font-size:10px;background:#e0f2fe;color:#0369a1">🏭 Warehouse'+(r.inv.warehousePushedAt?' ✓':'')+'</span>':''}${r.inv.trackingNumber?' <span class="badge green" style="font-size:10px">🚚 '+escHtml(r.inv.trackingNumber.length>20?r.inv.trackingNumber.slice(0,18)+'…':r.inv.trackingNumber)+'</span>':''}${r.inv.paidAmountMismatch?' <span class="badge red" style="font-size:10px" title="Stripe payment amount differs from the invoice total — see invoice notes">⚠ Paid ≠ total</span>':''}${_invEmailBadge(r.inv)}</td>
    <td>${escHtml(r.name)}</td>
    <td style="white-space:nowrap">${fmtD(r.issued)}</td>
    <td style="white-space:nowrap;${r.st==='overdue' ? 'color:var(--red);font-weight:600' : ''}">${fmtD(r.due)}</td>
    <td style="text-align:right"><strong>${fmtC(r.amt)}</strong></td>
    <td>${stBadge(r)}</td>
    <td style="white-space:nowrap;text-align:right">
      ${r.print ? `<button class="btn xs" onclick="${r.print}">Preview</button>` : ''}
      ${r.edit ? `<button class="btn xs" onclick="${r.edit}">Edit</button>` : ''}
      ${r.rawSt !== 'paid' && r.rawSt !== 'void' ? `<button class="btn xs green" onclick="${r.paidFn}">✓ Paid</button>` : ''}
      ${r.inv.deliveryMethod==='ship' && !r.inv.shipStationOrderId ? `<button class="btn xs" onclick="pushInvoiceToShipStation('${r.id}','${r.type==='lf'?'lf_invoices':r.type==='combined'?'combined_invoices':'retail_invoices'}')">📦 Ship</button>` : ''}
      ${r.inv.fulfillmentSource==='warehouse' && !r.inv.warehousePushedAt && r.rawSt!=='paid' && r.rawSt!=='void' ? `<button class="btn xs" style="color:#0891b2;border-color:#0891b2" onclick="pushToWarehouse('${r.id}','${r.type==='lf'?'lf_invoices':r.type==='combined'?'combined_invoices':'retail_invoices'}')">🏭 Warehouse</button>` : ''}
    </td>
  </tr>`).join('') || `<tr><td colspan="7" class="empty">No invoices match${q ? ' "' + escHtml(q) + '"' : ''}</td></tr>`;
}

function pushToWarehouse(invoiceId, collection) {
  DB.update(collection, invoiceId, x => ({...x, fulfillmentSource: 'warehouse', warehousePushedAt: new Date().toISOString()}));
  toast('Marked for warehouse fulfillment ✓');
  renderInvoicesPage();
}

function renderInvKpis() {
  // INVARIANT: combined_invoices is intentionally excluded from these KPIs.
  // Combined invoices' child records (purplInvoiceId → retail_invoices,
  // lfInvoiceId → lf_invoices) carry the amounts. The combined parent's
  // grandTotal = purplSubtotal + lfSubtotal, so including it would double-count.
  // This works because saveNewCombinedInvoice and confirmPortalOrder always
  // write child records to their respective collections alongside the combined.
  const todayStr = today();
  const purplInvs = _allPurplInvoices();
  const lfInvs    = DB.a('lf_invoices');
  const distInvs  = DB.a('dist_invoices');

  function purplStatus(inv) {
    // void must short-circuit like paid/draft, or a voided invoice past its
    // due date evaluates to 'overdue' and re-enters the Outstanding/Overdue KPIs
    if (inv.status === 'paid' || inv.status === 'draft' || inv.status === 'void') return inv.status;
    const due = inv.due || inv.dueDate || '';
    if (due && due < todayStr) return 'overdue';
    return inv.status || 'draft';
  }

  const now = new Date();
  const fom = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

  const _pAmt = x => parseFloat(x.amount||x.total||0);
  // Dist invoices use draft/sent/paid/void (new) but may have legacy unpaid/overdue statuses
  const _distOpen = x => !['paid','draft','void'].includes(x.status);
  const totalInvoiced = purplInvs.filter(x => x.status !== 'void').reduce((s,x) => s + _pAmt(x), 0)
                      + lfInvs.filter(x => x.status !== 'void').reduce((s,x) => s + parseFloat(x.total||0), 0)
                      + distInvs.filter(x => x.status !== 'void').reduce((s,x) => s + parseFloat(x.total||0), 0);
  const outstanding   = purplInvs.filter(x => !['paid','draft','void'].includes(purplStatus(x)))
                          .reduce((s,x) => s + _pAmt(x), 0)
                      + lfInvs.filter(x => !['paid','draft','void'].includes(x.status))
                          .reduce((s,x) => s + parseFloat(x.total||0), 0)
                      + distInvs.filter(_distOpen)
                          .reduce((s,x) => s + parseFloat(x.total||0), 0);
  const overdue       = purplInvs.filter(x => purplStatus(x) === 'overdue')
                          .reduce((s,x) => s + _pAmt(x), 0)
                      + lfInvs.filter(x => { const d = x.due || x.dueDate || ''; return !['paid','draft','void'].includes(x.status) && d && d < todayStr; })
                          .reduce((s,x) => s + parseFloat(x.total||0), 0)
                      + distInvs.filter(x => _distOpen(x) && x.dueDate && x.dueDate < todayStr)
                          .reduce((s,x) => s + parseFloat(x.total||0), 0);
  const collected     = purplInvs.filter(x => x.status === 'paid' && (x.paidDate || x.paidAt || '').slice(0,10) >= fom)
                          .reduce((s,x) => s + _pAmt(x), 0)
                      + lfInvs.filter(x => x.status === 'paid' && (x.paidDate || x.paidAt || '').slice(0,10) >= fom)
                          .reduce((s,x) => s + parseFloat(x.total||0), 0)
                      + distInvs.filter(x => x.status === 'paid' && (x.paidDate || x.paidAt || '').slice(0,10) >= fom)
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
  const invs = [
    ..._allPurplInvoices(),
  ].filter(x => !x.combinedInvoiceId);

  function effectiveStatus(inv) {
    if (inv.status === 'paid' || inv.status === 'draft' || inv.status === 'void') return inv.status;
    const due = inv.due || inv.dueDate || '';
    if (due && due < todayStr) return 'overdue';
    return inv.status || 'draft';
  }

  const outstanding = invs.filter(x => !['paid','draft','void'].includes(effectiveStatus(x)))
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
            <div style="font-weight:600">${escHtml(acName)}${_invEmailBadge(iv)}</div>
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
              <td><strong>${escHtml(iv.number||iv.invoiceNumber||'—')}</strong>${_invEmailBadge(iv)}</td>
              <td>${escHtml(iv._accountName)}</td>
              <td style="color:${due&&due<todayStr&&st!=='paid'?'var(--red)':'inherit'}">${fmtD(due)}</td>
              <td><strong>${amt != null ? fmtC(amt) : '<span style="color:var(--muted)">Draft</span>'}</strong></td>
              <td><span class="badge ${statColor[st]||'gray'}">${st}</span></td>
              <td><div style="display:flex;gap:4px;flex-wrap:wrap">
                ${st!=='paid' ? `<button class="btn xs green" onclick="markPaid('${iv.id}')">✓ Paid</button>` : ''}
                ${st==='draft' ? `<button class="btn xs blue" onclick="markInvoiceSent('${iv.id}')">✉ Sent</button>` : ''}
                <button class="btn xs" onclick="generateInvoicePrint('${iv.id}')">🖨️</button>
                <button class="btn xs" onclick="editInv('${iv.id}')">Edit</button>
                ${_isAdmin()?`<button class="btn xs red" onclick="deleteInvoice('${iv.id}')">✕</button>`:''}
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
            <div style="font-weight:600">${escHtml(inv.accountName||'—')}${_invEmailBadge(inv)}</div>
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
        <th>#</th><th>Account</th><th>Due</th><th>Amount</th><th>Status</th><th>Deducted</th><th></th>
      </tr></thead>
      <tbody>${!sorted.length
        ? '<tr><td colspan="7" class="empty">No LF invoices yet</td></tr>'
        : sorted.map(inv => {
            const sc = LF_INV_STATUS[inv.status] || {label: inv.status||'—', cls:'gray'};
            const wixHtml = inv.wixPulled
              ? `<span style="color:var(--green,#16a34a);font-weight:600">✓</span>`
              : `<span style="color:#f59e0b;font-weight:600">⚠</span>`;
            return `<tr>
              <td><strong>${escHtml(inv.number||'—')}</strong>${_invEmailBadge(inv)}</td>
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
        compactEl.innerHTML = pending.map(ci => `<div class="inv-col-compact-row" style="cursor:pointer" onclick="openCombinedInvoicePreview('${ci.id}')">
          <div>
            <div style="font-weight:600">${escHtml(ci.accountName||'—')}${_invEmailBadge(ci)}</div>
            <div style="font-size:11px;color:var(--muted)">${escHtml(ci.number||ci.invoiceNumber||'')} · purpl ${fmtC(ci.purplSubtotal||0)} + LF ${fmtC(ci.lfSubtotal||0)}</div>
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
        <td><span class="badge ${ci.status==='paid'?'green':ci.status==='sent'?'blue':ci.status==='void'?'red':'amber'}">${ci.status||'draft'}</span></td>
        <td style="white-space:nowrap">
          <button class="btn xs" onclick="openCombinedInvoicePreview('${ci.id}')">View</button>
          ${ci.status!=='paid' ? `<button class="btn xs green" onclick="markCombinedPaid('${ci.id}')">✓ Paid</button>` : ''}
          ${_isAdmin()?`<button class="btn xs red" onclick="deleteCombinedInvoice('${ci.id}')">✕</button>`:''}
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
  const statusMap = {draft:'gray', sent:'blue', paid:'green', void:'red'};

  const outstandingInvs = allInvs.filter(i => !['paid','draft','void'].includes(i.status));
  const totalOut   = outstandingInvs.reduce((s,i) => s + parseFloat(i.total||0), 0);
  const overdueInvs = outstandingInvs.filter(i => i.dueDate && i.dueDate < todayStr);
  const overdueAmt = overdueInvs.reduce((s,i) => s + (i.total||0), 0);

  const summaryEl = qs('#inv-col-dist-summary');
  if (summaryEl) summaryEl.textContent = `${outstandingInvs.length} outstanding · ${fmtC(totalOut)}${overdueAmt>0?' · '+fmtC(overdueAmt)+' overdue':''}`;

  const compactEl = qs('#inv-col-dist-compact');
  if (compactEl) {
    const top5 = outstandingInvs.slice(0,5);
    compactEl.innerHTML = top5.length ? top5.map(inv=>{
      const d = dists.find(x=>x.id===inv.distId);
      const isOverdue = !['paid','void'].includes(inv.status) && inv.dueDate && inv.dueDate < todayStr;
      return `<div class="inv-col-compact-row" onclick="editDistInvoice('${inv.id}')" style="cursor:pointer">
        <div>
          <div style="font-size:13px;font-weight:500">${escHtml(d?.name||inv.distName||'—')}</div>
          <div style="font-size:11px;color:var(--muted)">${escHtml(inv.invoiceNumber||'—')} · Due ${inv.dueDate?fmtD(inv.dueDate):'—'}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:13px;font-weight:600">${fmtC(inv.total||0)}</span>
          <span class="badge ${isOverdue?'red':statusMap[inv.status]||'amber'}">${isOverdue?'overdue':inv.status||'draft'}</span>
        </div>
      </div>`;
    }).join('') : '<div class="empty" style="padding:16px">No outstanding distributor invoices</div>';
  }

  const expandedEl = qs('#inv-col-dist-expanded');
  if (expandedEl) {
    expandedEl.innerHTML = `
    <div style="padding:0 4px 8px;display:flex;justify-content:flex-end">
      <button class="btn xs primary" onclick="event.stopPropagation();_openDistInvModal()">+ New Invoice</button>
    </div>
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Invoice #</th><th>Distributor</th><th>Issued</th><th>Due</th><th>Amount</th><th>Status</th><th></th></tr></thead>
        <tbody>${allInvs.map(inv=>{
          const d = dists.find(x=>x.id===inv.distId);
          const isOverdue = !['paid','void'].includes(inv.status) && inv.dueDate && inv.dueDate < todayStr;
          return `<tr>
            <td><a href="#" onclick="editDistInvoice('${inv.id}');return false" style="color:var(--purple);text-decoration:none;font-weight:500">${escHtml(inv.invoiceNumber||'—')}</a></td>
            <td style="cursor:pointer;color:var(--lavblue)" onclick="openDistributor('${inv.distId}')">${escHtml(d?.name||inv.distName||'—')}</td>
            <td>${inv.dateIssued?fmtD(inv.dateIssued):'—'}</td>
            <td class="${isOverdue?'red':''}">${inv.dueDate?fmtD(inv.dueDate):'—'}</td>
            <td>${fmtC(inv.total||0)}</td>
            <td><span class="badge ${isOverdue?'red':statusMap[inv.status]||'amber'}">${isOverdue?'overdue':inv.status||'draft'}</span></td>
            <td style="white-space:nowrap">
              ${inv.status!=='paid'?`<button class="btn xs green" onclick="markDistInvoicePaid('${inv.id}','${inv.distId}')">✓ Paid</button>`:''}
              <button class="btn xs" onclick="editDistInvoice('${inv.id}')">Edit</button>
              <button class="btn xs" onclick="_sendDistInvoiceReminder('${inv.id}')">✉</button>
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

const _markSentInFlight = new Set();
function markInvoiceSent(id) {
  if (_markSentInFlight.has(id)) return;
  _markSentInFlight.add(id);
  const inv = findInvoice(id);
  const col = _invoiceCol(id);
  // Deduct purpl inventory when a draft is first sent — skip if already deducted
  const alreadyDeducted = DB.a('iv').some(x => x.invoiceId === id && x.type === 'out');
  const deduct = inv && inv.status === 'draft' && !alreadyDeducted;
  // M3: status flip + inventory deductions in one atomicUpdate (was two
  // independent writes that could land apart on a persistence failure).
  DB.atomicUpdate(c => {
    const arr = c[col] || [];
    const idx = arr.findIndex(x => x.id === id);
    if (idx >= 0) arr[idx] = {...arr[idx], status:'sent', sentAt: today()};
    if (deduct) {
      const invNum = inv.number || inv.invoiceNumber || '';
      const lines = inv.lineItems || inv.items || [];
      c.iv = c.iv || [];
      lines.forEach(li => {
        if (li.skuId === '__shipping__') return; // shipping is not stock — the webhook line carries cases:1
        const cases = li.cases || li.qty || 0;
        if (cases > 0) {
          c.iv.push({ id: uid(), date: today(), sku: li.skuId || li.sku || 'classic', type: 'out', qty: cases * CANS_PER_CASE, pool: inv.fulfillmentSource || 'warehouse', note: 'Invoice ' + invNum, invoiceId: id });
        }
      });
    }
  });
  _markSentInFlight.delete(id);
  renderInvoicesPage();
  toast('Marked as sent ✓');
}

function deleteInvoice(id) {
  if (!_requireAdmin('delete invoices')) return;
  if (!confirm('Delete this invoice?')) return;
  const inv = findInvoice(id);
  auditLog('delete', 'invoice', id, inv?.number || inv?.invoiceNumber || id);
  deleteInvoiceWithCleanup(id);
  renderInvoicesPage();
  toast('Deleted');
}

function saveInvoiceSettings() {
  if (!_requireAdmin('change invoice settings')) return;
  auditLog('update', 'settings', 'invoice_settings', 'Invoice settings changed');
  const get = id => document.getElementById(id);
  const existing = DB.obj('invoice_settings', {});
  const s = {
    ...existing,
    fromName:      get('inv-from-name')?.value    || 'Pumpkin Blossom Farm LLC',
    fromEmail:     get('inv-from-email')?.value   || 'lavender@pbfwholesale.com',
    fromAddress:   get('inv-from-address')?.value || '393 Pumpkin Hill Rd, Warner, NH 03278',
    terms:         parseInt(get('inv-terms')?.value)||30,
    nextInvoiceNum: parseInt(get('set-next-inv-num')?.value)||existing.nextInvoiceNum||null,
    footerNotes:   get('inv-footer-notes')?.value||'',
    legalTerms:    get('inv-legal-terms') ? get('inv-legal-terms').value : (existing.legalTerms != null ? existing.legalTerms : DEFAULT_INVOICE_LEGAL_TERMS),
    stripeLink:    get('inv-stripe-link')?.value||'',
    achRouting:    get('inv-ach-routing')?.value||'',
    achAccount:    get('inv-ach-account')?.value||'',
    checkInstructions: get('inv-payment-instructions')?.value || get('inv-check-instructions')?.value||'',
  };
  DB.setObj('invoice_settings', s);
  toast('Invoice settings saved ✓');
}

function loadInvoiceSettings() {
  const s = DB.obj('invoice_settings', {});
  const set = (id, val) => { const el=document.getElementById(id); if(el&&val!=null) el.value=val; };
  set('inv-from-name',           s.fromName);
  set('inv-from-email',          s.fromEmail);
  set('inv-from-address',        s.fromAddress);
  set('inv-terms',               s.terms);
  set('set-next-inv-num',        s.nextInvoiceNum);
  set('inv-footer-notes',        s.footerNotes);
  { const el = document.getElementById('inv-legal-terms');
    if (el) el.value = s.legalTerms != null ? s.legalTerms : DEFAULT_INVOICE_LEGAL_TERMS; }
  set('inv-stripe-link',         s.stripeLink);
  set('inv-ach-routing',         s.achRouting);
  set('inv-ach-account',         s.achAccount);
  set('inv-check-instructions',  s.checkInstructions);
  set('inv-payment-instructions', s.checkInstructions || s.paymentInstructions);
}

// Settings → Payment Methods: one-click Stripe diagnostic.
// Creates a $1 test checkout session and shows the exact result/error.
async function testStripeConnection() {
  const el = document.getElementById('stripe-test-result');
  if (!el) return;
  el.style.color = 'var(--muted)';
  el.textContent = 'Testing Stripe…';
  try {
    const fn = firebase.functions().httpsCallable('stripeStatus');
    const d = (await fn({})).data;
    const stepsHtml = (d.steps||[]).map(s => `<div style="padding:2px 0;font-size:11px;color:var(--muted)">· ${escHtml(s)}</div>`).join('');
    if (d.ok) {
      el.style.color = '#16a34a';
      el.innerHTML = '✓ Stripe is working!<br>' + stepsHtml +
        '<div style="margin-top:6px">Test checkout ($1 — do <strong>not</strong> pay): <a href="' + escHtml(d.url) + '" target="_blank" rel="noopener">open link</a></div>';
    } else {
      el.style.color = '#dc2626';
      el.innerHTML = '✗ Failed at step: <strong>' + escHtml(d.step||'?') + '</strong><br>' +
        '<div style="margin-top:4px">' + escHtml(d.msg||'unknown') + '</div>' + stepsHtml;
    }
  } catch (e) {
    const code = e?.code || '';
    if (code.includes('not-found')) {
      el.style.color = '#dc2626';
      el.textContent = '✗ stripeStatus function not found — deploy functions: firebase deploy --only functions --project default';
    } else {
      el.style.color = '#dc2626';
      el.textContent = '✗ ' + (e.code || 'error') + ': ' + (e.message || 'unknown') +
        ' — if this says "internal", the functions deploy is stale. Run: firebase deploy --only functions --project default';
    }
  }
}

function saveApiSettings() {
  toast('AI key is now managed via Firebase secrets — run: firebase functions:secrets:set ANTHROPIC_API_KEY', 5000);
}

function loadApiSettings() {
  const adminCard = document.getElementById('integrations-admin-only');
  const lockedCard = document.getElementById('integrations-locked');
  if (_isAdmin()) {
    if (adminCard) adminCard.style.display = '';
    if (lockedCard) lockedCard.style.display = 'none';
    const el = document.getElementById('set-anthropic-key');
    if (el) el.placeholder = 'Managed via Firebase secrets';
  } else {
    if (adminCard) adminCard.style.display = 'none';
    if (lockedCard) lockedCard.style.display = '';
  }
}

// ── Print / PDF — same unified template as emails ─────────
// The window opens synchronously (inside the click) so pop-up blockers
// don't eat it; content is written once the Stripe link resolves.
function _openInvoiceWindow() {
  const w = window.open('', '_blank');
  if (!w) { toast('Pop-up blocked — allow pop-ups for this site'); return null; }
  try { w.document.write('<p style="font-family:sans-serif;color:#6b7280;padding:40px;text-align:center">Generating invoice…</p>'); } catch (e) {}
  return w;
}
function _writeInvoiceWindow(w, html) {
  try {
    w.document.open();
    w.document.write(html);
    w.document.close();
  } catch (e) { console.error('Print window write failed:', e); }
}

async function generateInvoicePrint(invoiceId) {
  const iv = findInvoice(invoiceId);
  if (!iv) { toast('Invoice not found'); return; }
  const w = _openInvoiceWindow();
  if (!w) return;
  const payLink = iv.status === 'paid' ? null : await _getStripePayLink(iv, 'retail');
  const html = buildPurplInvoiceEmailHTML(payLink ? { ...iv, _payLink: payLink } : iv, { printButton: true });
  _writeInvoiceWindow(w, html);
}

async function generateLfInvoicePrint(invoiceId) {
  const inv = DB.a('lf_invoices').find(x => x.id === invoiceId);
  if (!inv) { toast('Invoice not found'); return; }
  const w = _openInvoiceWindow();
  if (!w) return;
  const payLink = inv.status === 'paid' ? null : await _getStripePayLink(inv, 'lf');
  const html = buildLfInvoiceEmailHTML(payLink ? { ...inv, _payLink: payLink } : inv, { printButton: true });
  _writeInvoiceWindow(w, html);
}

async function generateCombinedInvoicePrint(invoiceId) {
  const inv = DB.a('combined_invoices').find(x => x.id === invoiceId);
  if (!inv) { toast('Invoice not found'); return; }
  const w = _openInvoiceWindow();
  if (!w) return;
  const html = buildCombinedInvoiceEmailHTML(inv, { printButton: true });
  _writeInvoiceWindow(w, html);
}

// ── Invoice modal helpers (v2 — iv collection) ─────────────

async function saveInv(id, isNew) {
  const rec = await _saveInvCore(id, isNew);
  if (!rec) return;
  closeModal('modal-add-inv');
  if (currentPage === 'invoices') renderInvoicesPage();
  renderInvoiceStatus();
  toast('Invoice saved ✓');
}

// Validates + persists the purpl invoice from the modal (including
// inventory deduction for new non-draft invoices). Returns the saved
// record or null if validation failed (toast already shown).
let _saveInvInFlight = false;
async function _saveInvCore(id, isNew) {
  if (_saveInvInFlight) return;
  _saveInvInFlight = true;
  setTimeout(() => { _saveInvInFlight = false; }, 2000);
  const number    = qs('#iv-number')?.value?.trim() || '';
  const accountId = qs('#iv-account')?.value;
  const date      = qs('#iv-date')?.value || today();
  const due       = qs('#iv-due')?.value || '';
  const status    = qs('#iv-status')?.value || 'draft';
  const notes     = qs('#iv-notes')?.value?.trim() || '';
  const tier      = qs('#iv-tier')?.value || 'direct';
  const deliveryDate   = qs('#iv-delivery-date')?.value || '';
  const trackingNumber = qs('#iv-tracking')?.value?.trim() || '';
  const paymentTerms = qs('#iv-terms')?.value || 'net30';
  const paymentTermsCustom = paymentTerms === 'custom' ? (qs('#iv-terms-custom')?.value?.trim() || '') : undefined;

  if (!accountId) { _saveInvInFlight = false; toast('Select an account'); return; }  // LOW-5: don't 2s-lock the form on validation failure

  const ac          = DB.a('ac').find(x => x.id === accountId) || {};
  const invSettings = DB.obj('invoice_settings', {});

  // Collect line items from DOM
  const lineItems = [];
  qs('#iv-line-items')?.querySelectorAll('[data-sku-id]').forEach(row => {
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

  if (!lineItems.length) { _saveInvInFlight = false; toast('Enter at least one case quantity'); return; }  // LOW-5

  // isNew may be undefined if called from old code paths — treat missing id as new
  const _isNew   = isNew !== false && !id;
  const existing = _isNew ? null : findInvoice(id);
  const saveId   = _isNew ? uid() : id;

  // Preserve non-SKU lines (ShipStation writes a __shipping__ line after
  // shipment) — the modal only renders SKU rows, so rebuilding from the DOM
  // alone silently deleted the shipping charge on any later edit.
  const _carryLines = (existing?.lineItems || []).filter(li => li.skuId === '__shipping__');
  lineItems.push(..._carryLines);

  const totalCases = lineItems.filter(l => l.skuId !== '__shipping__').reduce((s, l) => s + l.cases, 0);
  const totalCans  = totalCases * CANS_PER_CASE;
  const totalAmt   = lineItems.reduce((s, l) => s + (parseFloat(l.lineTotal != null ? l.lineTotal : l.total) || 0), 0);

  const _invNum = number || existing?.invoiceNumber || existing?.number || await getNextInvoiceNumber('purpl');
  const rec = {
    ...(existing||{}),
    id:           saveId,
    invoiceNumber: _invNum,
    number:       _invNum,
    accountId,
    accountName:  ac.name || '',
    date,
    dueDate:      due,
    cases:        totalCases,
    cans:         totalCans,
    pricePerCase: lineItems[0]?.pricePerCase || null,
    total:        totalAmt,
    amount:       totalAmt,
    priceType:    tier,
    status,
    notes,
    deliveryMethod:  qs('#iv-delivery-method')?.value || 'deliver',
    fulfillmentSource: qs('#iv-fulfillment')?.value || 'warehouse',
    deliveryDate,
    trackingNumber,
    lineItems,
    paymentTerms,
    ...(paymentTermsCustom !== undefined ? { paymentTermsCustom } : {}),
    source:       existing?.source || 'manual',
    fromEmail:    invSettings.fromEmail || 'lavender@pbfwholesale.com',
  };

  if (_isNew) {
    // M3: write the invoice doc AND its inventory deductions in ONE atomicUpdate
    // so a partial persistence failure can't leave a billed invoice with no
    // stock deducted (which would overstate on-hand and risk overselling).
    // Draft invoices get deducted later when marked sent via markInvoiceSent().
    DB.atomicUpdate(c => {
      c.retail_invoices = c.retail_invoices || [];
      c.retail_invoices.push(rec);
      if (status !== 'draft') {
        c.iv = c.iv || [];
        lineItems.forEach(li => {
          if (li.cases > 0) {
            c.iv.push({ id: uid(), date: rec.date || today(), sku: li.skuId, type: 'out', qty: li.cases * CANS_PER_CASE, pool: rec.fulfillmentSource || 'warehouse', note: 'Invoice ' + (rec.invoiceNumber || rec.number || ''), invoiceId: saveId });
          }
        });
      }
    });
  } else {
    updateInvoice(id, () => rec);
  }
  auditLog(_isNew ? 'create' : 'update', 'invoice', saveId, rec.number || saveId);
  if (!_isNew) _syncCombinedParentForChild(saveId); // M1: modal status edit on a combined child
  return rec;
}

function deleteInvRecord(id) {
  if (!confirm2('Delete this invoice?')) return;
  const inv = findInvoice(id);
  const invNum = inv?.invoiceNumber || inv?.number || id;
  deleteInvoiceWithCleanup(id);
  auditLog('delete', 'invoice', id, invNum);
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

// ── Wholesale Application Pipeline ───────────────────────

async function renderApplications() {
  const el = qs('#pr-applications-section');
  if (!el) return;

  el.innerHTML = `<div style="font-size:13px;color:var(--muted);padding:8px 0">Loading applications…</div>`;

  let docs = [];
  try {
    const snap = await firebase.firestore()
      .collection('portal_inquiries')
      .orderBy('submittedAt', 'desc')
      .limit(50)
      .get();
    docs = snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
  } catch(e) {
    try {
      // Fallback: no orderBy if index missing
      const snap2 = await firebase.firestore().collection('portal_inquiries').get();
      docs = snap2.docs.map(d => ({ _docId: d.id, ...d.data() }))
        .sort((a, b) => (b.submittedAt || '') > (a.submittedAt || '') ? 1 : -1);
    } catch(e2) {
      el.innerHTML = `<div style="font-size:13px;color:var(--muted)">Could not load applications.</div>`;
      return;
    }
  }

  // Only show actionable applications (new + reviewed)
  const activeDocs = docs.filter(d => !d.status || d.status === 'new' || d.status === 'reviewed');
  const newCount = docs.filter(d => !d.status || d.status === 'new').length;
  _updateApplicationsBadge(newCount);

  if (!activeDocs.length) {
    el.innerHTML = '';
    return;
  }

  // Use activeDocs for rendering
  docs = activeDocs;

  const statusLabel = { new:'New', reviewed:'Reviewed', approved:'Approved', rejected:'Rejected', imported:'Imported', duplicate:'Duplicate' };
  const statusColor = { new:'#dc2626', reviewed:'#d97706', approved:'#16a34a', rejected:'#6b7280', imported:'#6b7280', duplicate:'#6b7280' };

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div style="font-size:13px;font-weight:600">📋 Wholesale Applications <span class="badge ${newCount > 0 ? 'red' : 'gray'}" style="margin-left:6px">${docs.length}</span></div>
      <button class="btn xs" onclick="renderApplications()">Refresh</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">
      ${docs.map(app => {
        const st = app.status || 'new';
        const brands = (app.brandsInterested || []).join(', ') || '—';
        const dateStr = app.submittedAt
          ? (typeof app.submittedAt === 'string' ? fmtD(app.submittedAt.slice(0,10))
             : (app.submittedAt.toDate ? fmtD(app.submittedAt.toDate().toISOString().slice(0,10)) : '—'))
          : '—';
        const isActive = st === 'new' || st === 'reviewed';
        return `<div class="card" style="padding:14px;border-left:3px solid ${statusColor[st] || '#9ca3af'}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
            <div style="font-weight:600;font-size:14px">${escHtml(app.businessName || '—')}</div>
            <span class="badge" style="background:${statusColor[st]};color:#fff;font-size:10px">${statusLabel[st] || st}</span>
          </div>
          <div style="font-size:12px;color:var(--muted);line-height:1.7">
            ${app.contactName ? `<div>👤 ${escHtml(app.contactName)}</div>` : ''}
            ${app.email ? `<div>✉ ${escHtml(app.email)}</div>` : ''}
            ${app.phone ? `<div>📞 ${escHtml(app.phone)}</div>` : ''}
            ${app.storeType ? `<div>🏪 ${escHtml(app.storeType)}</div>` : ''}
            ${app.address ? `<div>📍 ${escHtml(app.address)}</div>` : ''}
            <div>🏷 Interested in: ${escHtml(brands)}</div>
            ${app.distributorName ? `<div>🚛 Distributor: ${escHtml(app.distributorName)}</div>` : ''}
            ${app.howHeard ? `<div>📣 How heard: ${escHtml(app.howHeard)}</div>` : ''}
            ${app.socialHandle ? `<div>📱 Social: ${escHtml(app.socialHandle)}</div>` : ''}
            ${app.message ? `<div style="margin-top:6px;padding:8px;background:#f9fafb;border-radius:6px;font-size:12px;color:var(--text);white-space:pre-wrap">${escHtml(app.message)}</div>` : ''}
            <div>📅 Submitted: ${dateStr}</div>
            ${(app.emailLog||[]).length ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:11px">
              <div style="font-weight:600;color:var(--muted);margin-bottom:4px">Email History</div>
              ${(app.emailLog||[]).map(e => `<div style="display:flex;justify-content:space-between;gap:6px;margin-bottom:2px">
                <span>${escHtml(e.stage||'email')} ${e.opened ? '<span style="color:#16a34a">👁 opened</span>' : e.clicked ? '<span style="color:#2563eb">🔗 clicked</span>' : ''}</span>
                <span style="color:var(--muted)">${e.sentAt ? fmtD(e.sentAt.slice(0,10)) : ''}</span>
              </div>`).join('')}
            </div>` : ''}
          </div>
          ${isActive ? `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="btn sm primary" onclick="approveApplication('${escHtml(app._docId)}')">Approve</button>
            <button class="btn sm" onclick="convertApplicationToProspect('${escHtml(app._docId)}')">Convert to Prospect</button>
            <button class="btn sm" style="color:var(--red);border-color:var(--red)" onclick="rejectApplication('${escHtml(app._docId)}')">Reject</button>
          </div>` : ''}
        </div>`;
      }).join('')}
    </div>`;
}

function _updateApplicationsBadge(count) {
  const badge = qs('#nav-applications-badge');
  if (badge) {
    if (count > 0) { badge.textContent = count; badge.style.display = 'inline'; }
    else { badge.style.display = 'none'; }
  }
  const card = qs('#dash-applications-card');
  if (card) {
    if (count > 0) {
      card.style.display = '';
      card.innerHTML = `<div style="background:#fef2f2;border:1.5px solid #fca5a5;border-radius:10px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <div style="font-weight:600;font-size:14px;color:#991b1b;margin-bottom:2px">📋 ${count} new wholesale application${count !== 1 ? 's' : ''} pending review</div>
          <div style="font-size:13px;color:#7f1d1d">New retailers have applied through your wholesale page.</div>
        </div>
        <button class="btn xs" style="background:#dc2626;color:#fff;border:none;flex-shrink:0" onclick="nav('prospects')">Review Applications</button>
      </div>`;
    } else {
      card.style.display = 'none';
      card.innerHTML = '';
    }
  }
}

let _portalOrderIds = new Set();
let _portalOrderUnsub = null;
function _listenPortalOrders() {
  if (_portalOrderUnsub) _portalOrderUnsub();
  try {
    _portalOrderUnsub = firebase.firestore().collection('portal_orders')
      .orderBy('submittedAt', 'desc')
      // This snapshot OVERWRITES PortalDB._orders (the full load), so its
      // window is the effective cap on what the Portal Orders tabs/KPIs/badge
      // can see — at limit(50) the 51st-oldest submission silently vanished.
      .limit(500)
      .onSnapshot(snap => {
        let newCount = 0;
        const unconfirmed = [];
        snap.docs.forEach(doc => {
          const d = doc.data();
          // A sample-only request (no purchasable items) that has been approved
          // or declined is fully handled — it must stop counting as "waiting",
          // or the nav badge stays lit forever (confirm bails on no-items).
          const sampleOnly = !((d.items||[]).some(i => (i.cases||0) > 0)) && !(d.lineItems||[]).length;
          const sampleHandled = sampleOnly && (d.sampleApproved || d.sampleDeclined);
          if (d.status !== 'confirmed' && d.status !== 'rejected' && d.status !== 'declined' && !sampleHandled) unconfirmed.push(doc.id);
          if (!_portalOrderIds.has(doc.id) && _portalOrderIds.size > 0) {
            newCount++;
          }
        });
        if (newCount > 0) {
          toast(`New portal order${newCount > 1 ? 's' : ''} received!`, 5000);
          if (currentPage === 'pre-orders') renderPreOrders(true);
          renderDashQuickActions();
        }
        _portalOrderIds = new Set(snap.docs.map(d => d.id));
        _updatePortalOrdersBadge(unconfirmed.length);
        PortalDB._orders = snap.docs.map(d => {
          const data = d.data();
          return { ...data, id: d.id, submittedAt: data.submittedAt?.toDate?.() || null };
        });
        PortalDB._orders.sort((a,b) => (b.submittedAt||0) - (a.submittedAt||0));
        PortalDB._loaded = true;
      }, err => console.warn('Portal orders listener error:', err));
  } catch(e) { console.warn('Could not start portal orders listener:', e); }
}

function _updatePortalOrdersBadge(count) {
  const badge = qs('#nav-portal-orders-badge');
  if (badge) {
    if (count > 0) { badge.textContent = count; badge.style.display = 'inline'; }
    else { badge.style.display = 'none'; }
  }
  const card = qs('#dash-portal-orders-card');
  if (card) {
    if (count > 0) {
      card.style.display = '';
      card.innerHTML = `<div style="background:#f5f0ff;border:1.5px solid #D4B8F0;border-radius:10px;padding:14px 18px;margin-bottom:20px;display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <div style="flex:1;min-width:200px">
          <div style="font-weight:600;font-size:14px;color:#6B4F9A;margin-bottom:2px">${count} new portal order${count !== 1 ? 's' : ''} waiting</div>
          <div style="font-size:13px;color:#4b5563">Review and confirm incoming wholesale orders.</div>
        </div>
        <button class="btn xs" style="background:#8B5FBF;color:#fff;border:none;flex-shrink:0" onclick="nav('pre-orders')">Review Orders</button>
      </div>`;
    } else {
      card.style.display = 'none';
      card.innerHTML = '';
    }
  }
}

async function approveApplication(docId, app) {
  if (!app) { try { const d = await firebase.firestore().collection('portal_inquiries').doc(docId).get(); app = d.exists ? d.data() : {}; } catch(e) { toast('Could not load application'); return; } }
  if (!confirm2(`Approve ${app.businessName || 'this application'} and create an account?`)) return;

  const acId    = uid();
  const token   = generateSecureToken(acId);
  const isPbf   = (app.brandsInterested || []).some(b => b === 'lf' || b === 'lavender');

  const rec = {
    id:         acId,
    name:       app.businessName || app.contactName || '—',
    contact:    app.contactName  || '',
    email:      app.email        || '',
    phone:      app.phone        || '',
    address:    app.address      || '',
    lat:        typeof app.lat === 'number' ? app.lat : null,
    lng:        typeof app.lng === 'number' ? app.lng : null,
    locations:  app.address ? [{ id: uid(), label: 'Primary', address: app.address, lat: app.lat||null, lng: app.lng||null, dropOffRules: '' }] : [],
    type:       app.storeType    || 'Retail',
    status:     'active',
    isPbf,
    since:      today(),
    source:     'Wholesale Page',
    orderPortalToken: token,
    orderPortalTokenCreatedAt: today(),
    contacts:   app.contactName || app.email
      ? [{ id: uid(), name: app.contactName||'', email: app.email||'', phone: app.phone||'', isPrimary: true }]
      : [],
    notes: [],
    outreach: [],
    samples: [],
    skus: [],
    par: {},
  };

  DB.push('ac', rec);
  auditLog('create', 'account', acId, rec.name);

  // Write token to external accounts collection so lookupPortalToken Cloud Function can find it
  try {
    await firebase.firestore().collection('accounts').doc(acId).set({
      orderPortalToken: token,
      name: rec.name,
      email: rec.email,
      isPbf: rec.isPbf,
      orderPortalTokenCreatedAt: today(),
    }, { merge: true });
  } catch(e) { console.error('Token write to accounts collection failed', e); }

  // Preserve application context as first note on the new account
  const contextParts = [
    app.message ? 'Message: ' + app.message : '',
    app.howHeard ? 'How they heard: ' + app.howHeard : '',
    app.monthlyVolume ? 'Monthly volume: ' + app.monthlyVolume : '',
    app.storeDescription ? 'Store: ' + app.storeDescription : '',
    app.distributorName ? 'Distributor: ' + app.distributorName : '',
    'Brands interested: ' + (app.brandsInterested || []).join(', '),
  ].filter(Boolean).join('\n');
  if (contextParts) {
    DB.update('ac', acId, a => ({
      ...a,
      notes: [{ id: uid(), date: today(), text: 'Wholesale application:\n' + contextParts, author: 'system' }],
    }));
  }

  // Send approved cadence email and log to cadence
  if (app.email) {
    try {
      let _pw = '';
      try { const _cfg = await firebase.firestore().collection('portal_settings').doc('config').get(); _pw = _cfg.exists ? (_cfg.data().portalPassword||'') : ''; } catch(e) { console.warn('Portal password fetch failed, email sent without password:', e); }
      const tpl = getCadenceEmailTemplate('approved', rec, { portalPassword: _pw });
      const result = await callSendEmail(app.email, 'lavender@pbfwholesale.com', tpl.subject, tpl.body);
      const entry = {
        id: uid(), stage: 'approved_welcome',
        sentAt: new Date().toISOString(),
        sentBy: _currentUserName(), method: 'auto',
      };
      if (result?.id) entry.sentMessageId = result.id;
      DB.update('ac', acId, a => ({ ...a, cadence: _pushCadence(a.cadence, entry) }));
    } catch(e) { console.error('Approve email failed', e); toast('⚠️ Account created but welcome email failed — resend from Emails page'); }
  }

  // Mark application approved in Firestore
  try {
    await firebase.firestore().collection('portal_inquiries').doc(docId).update({
      status: 'approved', approvedAt: firebase.firestore.FieldValue.serverTimestamp(), accountId: acId
    });
  } catch(e) { console.error('Firestore update failed', e); }

  toast(`${rec.name} approved and added as an account`);
  renderAccounts();
  renderApplications();
}

async function rejectApplication(docId, app) {
  if (!app) { try { const d = await firebase.firestore().collection('portal_inquiries').doc(docId).get(); app = d.exists ? d.data() : {}; } catch(e) { toast('Could not load application'); return; } }
  if (!confirm2(`Reject application from ${app.businessName || 'this applicant'}?`)) return;

  let emailResult = null;
  let emailSentAt = null;
  let emailMessageId = null;
  if (app.email) {
    try {
      const tmpAc = { name: app.businessName||'', email: app.email||'', contact: app.contactName||'', contacts: [{name:app.contactName||'',email:app.email||'',isPrimary:true}], orderPortalToken: null };
      const tpl = getCadenceEmailTemplate('rejected', tmpAc);
      emailResult = await callSendEmail(app.email, 'lavender@pbfwholesale.com', tpl.subject, tpl.body);
      emailSentAt = new Date().toISOString();
      emailMessageId = emailResult?.id || null;
    } catch(e) { console.error('Reject email failed', e); }
  }

  try {
    const updatePayload = {
      status: 'rejected',
      rejectedAt: firebase.firestore.FieldValue.serverTimestamp(),
      rejectedBy: _currentUserName(),
    };
    if (emailSentAt) {
      updatePayload.emailLog = firebase.firestore.FieldValue.arrayUnion({
        stage: 'rejected', sentAt: emailSentAt, sentBy: _currentUserName(),
        method: 'resend', sentMessageId: emailMessageId, to: app.email||'',
      });
    } else {
      // Even when no email was sent (missing address or send failure), keep
      // an audit trail of the rejection decision on the inquiry doc.
      updatePayload.emailLog = firebase.firestore.FieldValue.arrayUnion({
        stage: 'rejected', sentAt: new Date().toISOString(), sentBy: _currentUserName(),
        method: 'none', to: app.email||'', reason: app.email ? 'send_failed' : 'no_email',
      });
    }
    await firebase.firestore().collection('portal_inquiries').doc(docId).update(updatePayload);
  } catch(e) { console.error('Firestore update failed', e); }

  toast('Application rejected');
  renderApplications();
}

async function convertApplicationToProspect(docId, app) {
  if (!app) { try { const d = await firebase.firestore().collection('portal_inquiries').doc(docId).get(); app = d.exists ? d.data() : {}; } catch(e) { toast('Could not load application'); return; } }
  const isPbf = (app.brandsInterested || []).some(b => b === 'lf' || b === 'lavender');
  const notes = [
    app.storeDescription ? 'Store: ' + app.storeDescription : '',
    app.howHeard         ? 'How they heard: ' + app.howHeard : '',
    app.monthlyVolume    ? 'Monthly volume: ' + app.monthlyVolume : '',
    app.distributorName  ? 'Distributor: ' + app.distributorName : '',
    app.message          ? 'Message: ' + app.message : '',
  ].filter(Boolean).join('\n');

  const prospect = {
    id:       uid(),
    name:     app.businessName || app.contactName || '—',
    contact:  app.contactName  || '',
    email:    app.email        || '',
    phone:    app.phone        || '',
    address:  app.address      || '',
    type:     app.storeType    || 'Retail',
    isPbf,
    status:   'lead',
    priority: 'medium',
    source:   'Wholesale Page',
    notes:    notes ? [{ id: uid(), text: notes, date: today() }] : [],
    outreach: [],
    samples:  [],
    createdAt: today(),
  };
  if (typeof app.lat === 'number' && typeof app.lng === 'number') {
    prospect.lat = app.lat;
    prospect.lng = app.lng;
  }
  DB.push('pr', prospect);

  try {
    await firebase.firestore().collection('portal_inquiries').doc(docId).update({
      status: 'reviewed', reviewedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) { console.error('Firestore update failed', e); }

  toast(`${app.businessName || 'Applicant'} converted to prospect`);
  renderProspects();
  renderApplications();
}
