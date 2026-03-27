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
    'pre-orders':'Pre-Orders'
  };
  const tb = document.getElementById('topbar-title');
  if (tb) tb.textContent = titles[page] || page;
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

// ── Default demo data (first run only) ──────────────────
function seedIfEmpty() {
  // SAFETY: never seed if Firestore hasn't confirmed document state yet.
  // The 10-second startup timeout can fire before the snapshot arrives — without
  // this guard, seedIfEmpty would see an empty cache and overwrite real data.
  if (!DB._firestoreReady) return;
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

  renderWelcomeHeader(ac, ord, inv);
  renderAttention();
  renderFollowUps();
  renderPendingOrders();
  renderInvoiceStatus();
  renderProjections();
  renderVelocities();
  renderDistDashKPIs();
  renderQuickNotes();
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

function renderWelcomeHeader(ac, ord, inv) {
  const el = qs('#dash-welcome-hdr');
  if (!el) return;

  const dateStr = new Date().toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric'});

  // Today's run stops
  const run = DB.obj('today_run', {stops:[]});
  const stopsToday = (run.stops||[]).length;

  // Overdue invoices
  const terms = DB.obj('settings',{payment_terms:30}).payment_terms || 30;
  const overdueInv = ord.filter(o=>o.status==='delivered'&&(o.invoiceStatus||'none')==='invoiced'&&daysAgo(o.invoiceDate||o.dueDate)>terms).length;

  // Total can stock
  const totalCans = SKUS.reduce((sum,s)=>{
    const ins  = inv.filter(i=>i.sku===s.id&&i.type==='in').reduce((t,i)=>t+i.qty,0);
    const outs = inv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
    return sum + Math.max(0, ins-outs);
  }, 0);

  const summaryParts = [];
  if (stopsToday > 0) summaryParts.push(`<strong>${stopsToday} stop${stopsToday!==1?'s':''}</strong> on today's run`);
  if (overdueInv > 0) summaryParts.push(`<strong>${overdueInv} invoice${overdueInv!==1?'s':''}</strong> overdue`);
  if (totalCans > 0)  summaryParts.push(`<strong>${fmt(totalCans)}</strong> cans in stock`);
  const summary = summaryParts.length ? summaryParts.join(' &nbsp;·&nbsp; ') : 'Everything looks good — have a great day!';

  el.innerHTML = `
    <div class="dash-welcome">
      <div class="dash-welcome-left">
        <div class="dw-date">${dateStr}</div>
        <div class="dw-greeting">Welcome back to purpl CRM</div>
      </div>
      <div class="dash-welcome-right">
        <div class="dw-summary">${summary}</div>
      </div>
    </div>`;
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

  ac.filter(a=>a.status==='active').forEach(a=>{
    const last = a.lastOrder;
    if (daysAgo(last) >= 30) {
      const isDistFulfilled = a.fulfilledBy && a.fulfilledBy !== 'direct';
      if (isDistFulfilled) {
        const dist = DB.a('dist_profiles').find(d=>d.id===a.fulfilledBy);
        items.push({
          icon:'⚠️',
          name: a.name,
          reason: `No order in ${daysAgo(last)} days — fulfilled via ${dist?.name||'distributor'}`,
          action: `openAccount('${a.id}')`,
          color: '#d97706',
        });
      } else {
        items.push({icon:'🕐', name:a.name, reason:`No order in ${daysAgo(last)} days`, action:`openAccount('${a.id}')`});
      }
    }
  });

  SKUS.forEach(s=>{
    const inv = DB.a('iv');
    const oh = inv.filter(i=>i.sku===s.id&&i.type==='in').reduce((t,i)=>t+i.qty,0)
             - inv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
    if (oh < 48) items.push({icon:'📦', name:`${s.label} — Low Stock`, reason:`${oh} units on hand`, action:`nav('inventory')`});
  });

  DB.a('pr').filter(p=>p.nextDate&&p.nextDate<today()&&!['won','lost'].includes(p.status)).forEach(p=>{
    items.push({icon:'🎯', name:p.name, reason:`Follow-up overdue: ${p.nextAction||'check in'}`, action:`openProspect('${p.id}')`});
  });

  // Accounts with overdue follow-up dates and no newer contact logged
  const todayNow = today();
  ac.filter(a=>a.status==='active'&&a.nextFollowUp&&a.nextFollowUp<todayNow).forEach(a=>{
    const lastContact = acLastContacted(a);
    if (!lastContact || lastContact < a.nextFollowUp) {
      items.push({icon:'📅', name:a.name, reason:`Follow-up overdue — was due ${fmtD(a.nextFollowUp)}`, action:`openAccount('${a.id}')`});
    }
  });

  // Overdue distributor invoices
  const todayStr = today();
  DB.a('dist_invoices').filter(i=>i.status==='unpaid'&&i.dueDate&&i.dueDate<todayStr).forEach(i=>{
    const d = DB.a('dist_profiles').find(x=>x.id===i.distId);
    items.push({icon:'💸', name:`${d?.name||'Distributor'} — Invoice Overdue`, reason:`${fmtC(i.total)} due ${fmtD(i.dueDate)}`, action:`openDistributor('${i.distId}')`});
  });

  // Distributors with no contact in 30+ days (phase 7: lowered from 60 to 30)
  DB.a('dist_profiles').filter(d=>d.status==='active').forEach(d=>{
    const out = (d.outreach||[]).slice().sort((a,b)=>b.date>a.date?1:-1);
    const lastDate = out[0]?.date || d.lastContacted || null;
    if (daysAgo(lastDate) >= 30) {
      items.push({icon:'🚚', name:`${d.name} — No Recent Contact`, reason:`Last contacted ${lastDate?daysAgo(lastDate)+' days ago':'never'}`, action:`openDistributor('${d.id}')`});
    }
  });

  // Overdue distributor follow-ups
  DB.a('dist_profiles').filter(d=>d.nextFollowup&&d.nextFollowup<todayStr).forEach(d=>{
    items.push({icon:'📅', name:`${d.name} — Follow-Up Overdue`, reason:`Scheduled ${fmtD(d.nextFollowup)}`, action:`openDistributor('${d.id}')`});
  });

  const el = qs('#dash-attention');
  if (!el) return;
  el.innerHTML = items.length ? items.slice(0,10).map(i=>`
    <div class="attn-item" onclick="${i.action}" style="cursor:pointer${i.color?';border-left:3px solid '+i.color:''}">
      <div class="attn-icon">${i.icon}</div>
      <div class="attn-info"><div class="attn-name">${i.name}</div><div class="attn-reason" style="${i.color?'color:'+i.color:''}">${i.reason}</div></div>
    </div>`).join('') : '<div class="empty">All clear! No immediate action needed.</div>';
}

// ── Upcoming Follow-ups (next 14 days from notes / prospects) ─
function renderFollowUps() {
  const items = [];
  const now   = today();
  const in14  = new Date(Date.now()+14*864e5).toISOString().slice(0,10);

  DB.a('ac').forEach(a=>{
    // Prefer nextFollowUp field (set by log follow-up), fall back to note-based date
    if (a.nextFollowUp && a.nextFollowUp >= now && a.nextFollowUp <= in14) {
      const daysUntil = Math.max(0, Math.ceil((new Date(a.nextFollowUp+'T12:00:00')-Date.now())/864e5));
      items.push({type:'account', name:a.name, date:a.nextFollowUp, action:'Follow up', id:a.id, daysUntil});
      return;
    }
    if (!a.notes?.length) return;
    const ln = a.notes[a.notes.length-1];
    if (ln?.nextDate && ln.nextDate >= now && ln.nextDate <= in14) {
      const daysUntil = Math.max(0, Math.ceil((new Date(ln.nextDate+'T12:00:00')-Date.now())/864e5));
      items.push({type:'account', name:a.name, date:ln.nextDate, action:ln.nextAction||'Follow up', id:a.id, daysUntil});
    }
  });

  DB.a('pr').filter(p=>!['won','lost'].includes(p.status)).forEach(p=>{
    if (p.nextDate && p.nextDate >= now && p.nextDate <= in14) {
      const daysUntil = Math.max(0, Math.ceil((new Date(p.nextDate+'T12:00:00')-Date.now())/864e5));
      items.push({type:'prospect', name:p.name, date:p.nextDate, action:p.nextAction||'Follow up', id:p.id, daysUntil});
    }
  });

  items.sort((a,b)=>a.date>b.date?1:-1);

  const el = qs('#dash-followups');
  if (!el) return;
  el.innerHTML = items.length ? items.map(i=>`
    <div class="attn-item" onclick="${i.type==='account'?`openAccount('${i.id}')`:`openProspect('${i.id}')`}" style="cursor:pointer">
      <div class="attn-icon">${i.type==='account'?'📅':'🎯'}</div>
      <div class="attn-info">
        <div class="attn-name">${i.name}</div>
        <div class="attn-reason">${i.action} &middot; <strong>${i.daysUntil===0?'Today':i.daysUntil===1?'Tomorrow':'in '+i.daysUntil+'d'}</strong> (${fmtD(i.date)})</div>
      </div>
    </div>`).join('') : '<div class="empty">No follow-ups scheduled in the next 14 days</div>';
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
        <div class="attn-name">${ac2?.name||'Unknown'}</div>
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
        <div class="attn-info"><div class="attn-name">${ac2?.name||'Unknown'}</div><div class="attn-reason">Invoice overdue &middot; ${fmtD(o.dueDate)}</div></div>
        <button class="btn xs green" onclick="setInvStatus('${o.id}','paid')">Mark Paid</button>
      </div>`;
    }).join('') : '<div class="empty">No invoice issues</div>'}`;
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
      const gap   = d30u - stock;
      const daysSupply = wk > 0 ? Math.round(stock/(wk/7)) : null;
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

function renderAccounts() {
  _populateFulfillFilter();
  let list = DB.a('ac');
  const search        = qs('#ac-search')?.value?.toLowerCase().trim() || '';
  const typeFilter    = qs('#ac-type-filter')?.value || '';
  const brandFilter   = qs('#ac-brand-filter')?.value || '';
  const fulfillFilter = qs('#ac-fulfill-filter')?.value || '';
  const sortVal       = qs('#ac-sort')?.value || 'name';

  if (search) list = list.filter(a=>
    a.name?.toLowerCase().includes(search) ||
    a.contact?.toLowerCase().includes(search) ||
    a.territory?.toLowerCase().includes(search) ||
    a.address?.toLowerCase().includes(search));
  if (typeFilter) list = list.filter(a=>a.type===typeFilter);
  if (brandFilter === 'lf')    list = list.filter(a=>!!a.isPbf);
  if (brandFilter === 'purpl') list = list.filter(a=>!a.isPbf);
  if (fulfillFilter === 'direct') list = list.filter(a=>!a.fulfilledBy||a.fulfilledBy==='direct');
  else if (fulfillFilter) list = list.filter(a=>a.fulfilledBy===fulfillFilter);

  list = list.slice().sort((a,b)=>{
    if (sortVal==='name')          return (a.name||'') < (b.name||'') ? -1 : 1;
    if (sortVal==='lastOrder')     return (a.lastOrder||'') < (b.lastOrder||'') ? 1 : -1;
    if (sortVal==='lastContacted') return (acLastContacted(a)||'') < (acLastContacted(b)||'') ? 1 : -1;
    if (sortVal==='territory')     return (a.territory||'') < (b.territory||'') ? -1 : 1;
    return 0;
  });

  const el = qs('#ac-cards');
  if (!el) return;
  if (qs('#ac-count')) qs('#ac-count').textContent = `${list.length} account${list.length!==1?'s':''}`;

  el.innerHTML = list.map(a=>{
    const lastContact  = acLastContacted(a);
    const needsAttn    = daysAgo(a.lastOrder)>=30 || daysAgo(lastContact)>=30;

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

    // Next follow-up date with color coding
    const nfu = a.nextFollowUp;
    let nfuHtml = '';
    if (nfu) {
      const nfuColor = nfu < today() ? '#dc2626' : nfu === today() ? '#d97706' : '#1d4ed8';
      const nfuLabel = nfu < today() ? 'Overdue' : nfu === today() ? 'Today' : fmtD(nfu);
      nfuHtml = `<div class="pr-card-nextsteps" style="border-left-color:${nfuColor}"><div class="ac-card-section-label" style="color:${nfuColor}">📅 Next Follow-Up</div><div class="pr-card-nextsteps-text" style="color:${nfuColor};font-weight:600">${nfuLabel}${nfu < today() || nfu === today() ? ' — '+fmtD(nfu) : ''}</div></div>`;
    }

    return `<div class="ac-card${needsAttn?' needs-attention':''}">
      <div class="ac-card-hdr">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;flex-wrap:wrap">
            <span class="ac-card-name">${a.name}</span>
            ${a.isPbf?`<span class="badge green" style="font-size:10px">🌿 LF</span>`:''}
            ${(a.skus||[]).map(s=>`<span class="badge ${SKU_MAP[s]?.cls||'gray'}" style="font-size:10px">${SKU_MAP[s]?.label||s}</span>`).join('')}
            ${_getFulfillBadge(a)}
          </div>
          <div class="ac-card-sub">${[a.type, locs.length===1&&locs[0].address ? locs[0].address : ''].filter(Boolean).join(' · ')}</div>
          ${a.contact||a.phone?`<div class="ac-card-sub">${[a.contact,a.phone].filter(Boolean).join(' · ')}</div>`:''}
          ${a.email?`<div class="ac-card-email">✉ ${a.email}</div>`:''}
          ${locs.length>1?`<button id="ac-locs-btn-${a.id}" class="btn sm" style="margin-top:4px" onclick="toggleAcLocs('${a.id}')">▼ ${locs.length} Locations</button>`:''}
        </div>
        <div class="ac-card-badges">
          ${a.type?`<span class="badge gray">${a.type}</span>`:''}
          ${statusBadge(AC_STATUS,a.status)}
          ${needsAttn?`<span class="badge amber">⚠ Needs Attention</span>`:''}
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
      ${lastNote?`<div class="ac-card-section"><div class="ac-card-section-label">Notes</div><div style="font-size:13px">${lastNote.text}</div></div>`:''}
      ${lastNote?.nextAction?`<div class="pr-card-nextsteps"><div class="ac-card-section-label" style="color:#1e40af">☑ Next Steps</div><div class="pr-card-nextsteps-text">${lastNote.nextAction}${lastNote.nextDate?' — '+fmtD(lastNote.nextDate):''}</div></div>`:''}
      ${!lastNote&&lastOutreach?`<div class="ac-card-section"><div class="ac-card-section-label">Recent Outreach</div><div style="font-size:13px">${lastOutreach.type} · ${fmtD(lastOutreach.date)}${(lastOutreach.notes||lastOutreach.note)?' — '+(lastOutreach.notes||lastOutreach.note):''}</div></div>`:''}
      ${locs.length===1&&locs[0].dropOffRules?`<div class="ac-card-rules"><div class="ac-card-section-label">🚚 Drop-Off Rules</div><div class="ac-card-rules-text">${locs[0].dropOffRules}</div></div>`:a.dropOffRules&&!locs.length?`<div class="ac-card-rules"><div class="ac-card-section-label">🚚 Drop-Off Rules</div><div class="ac-card-rules-text">${a.dropOffRules}</div></div>`:''}
      <div class="ac-card-actions">
        <button class="btn sm primary" onclick="openAccount('${a.id}')">View</button>
        <button class="btn sm" onclick="quickNote('${a.id}')">Note</button>
        <button class="btn sm" onclick="logOutreach('${a.id}')">Log Follow-Up</button>
        <button class="btn sm run" onclick="openNewOrder('${a.id}')">+ Run</button>
        <button class="btn sm" onclick="editAccount('${a.id}')">Edit</button>
        <button class="btn sm" onclick="copyOrderLink('${a.id}')">🔗 Copy Link</button>
      </div>
    </div>`;
  }).join('')||'<div class="empty">No accounts yet. Click "+ Add Account" to get started.</div>';
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

  // Outreach tab
  renderAccountOutreach(a);
  const logOutreachBtn = qs('#mac-log-outreach-btn');
  if (logOutreachBtn) logOutreachBtn.onclick = () => openLogOutreachModal('ac', id);

  // Set edit button
  qs('#mac-edit-btn').onclick = () => { closeModal('modal-account'); editAccount(id); };
  qs('#mac-order-btn').onclick = () => { closeModal('modal-account'); openNewOrder(id); };

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
      // Lazy-load portal orders tab
      if (t.dataset.tab === 'portal-orders') renderMacPortalOrdersTab(id);
    };
  });
  // Default to first tab
  document.querySelectorAll('#modal-account .tab')[0]?.click();

  openModal('modal-account');
}

function renderAccountNotes(a) {
  const nl = qs('#mac-notes-list');
  if (!nl) return;
  nl.innerHTML = (a.notes||[]).slice().reverse().map((n,i)=>`
    <div class="note-item">
      <div class="note-date">${fmtD(n.date)} — ${n.author||'you'}</div>
      <div>${n.text}</div>
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
  ol.innerHTML = entries.map(e=>`
    <div class="note-item">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
        <span style="font-size:12px;color:var(--muted)">${fmtD(e.date)}</span>
        <span class="badge ${TYPE_CLS[e.type]||'gray'}" style="font-size:10px">${TYPE_LABELS[e.type]||e.type||'Other'}</span>
        ${e.outcome?`<span class="badge ${OUT_CLS[e.outcome]||'gray'}" style="font-size:10px">${e.outcome}</span>`:''}
      </div>
      ${e.contact?`<div style="font-size:13px;color:var(--muted);margin-bottom:2px">Spoke with: <strong>${e.contact}</strong></div>`:''}
      ${(e.notes||e.note)?`<div style="font-size:13px">${e.notes||e.note}</div>`:''}
      ${e.nextFollowUp?`<div style="font-size:12px;color:#1d4ed8;margin-top:4px">📅 Next follow-up: <strong>${fmtD(e.nextFollowUp)}</strong></div>`:''}
    </div>`).join('');
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

function editAccount(id) {
  const a = DB.a('ac').find(x=>x.id===id) || {id:uid()};
  const isNew = !DB.a('ac').find(x=>x.id===id);
  const m = document.getElementById('modal-edit-account');
  if (!m) return;

  qs('#eac-name').value = a.name||'';
  qs('#eac-contact').value = a.contact||'';
  qs('#eac-phone').value = a.phone||'';
  qs('#eac-email').value = a.email||'';
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

  const rec = {
    // Preserve ALL existing fields first — avoids data loss on save
    ...(existing||{}),
    id, name,
    contact:      qs('#eac-contact')?.value?.trim()||'',
    phone:        qs('#eac-phone')?.value?.trim()||'',
    email:        qs('#eac-email')?.value?.trim()||'',
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
  DB.remove('ac', id);
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

  el.innerHTML = list.map(p=>{
    const priCfg        = PRIORITY_CFG[p.priority||'medium']||PRIORITY_CFG.medium;
    const lastNote      = p.notes?.length ? p.notes[p.notes.length-1] : null;
    const lastOutreach  = p.outreach?.length ? p.outreach[p.outreach.length-1] : null;
    const lastContactStr= p.lastContact
      ? `${fmtD(p.lastContact)} (${daysAgo(p.lastContact)}d)`
      : (lastOutreach ? `${fmtD(lastOutreach.date)} (${daysAgo(lastOutreach.date)}d)` : '—');
    const nextFollowHtml= p.nextDate
      ? `<span style="color:${p.nextDate<today()?'var(--red)':'var(--blue)'}">${fmtD(p.nextDate)}</span>`
      : (p.nextFollowUpLabel
          ? `<span style="color:var(--blue);font-style:italic">${p.nextFollowUpLabel}</span>`
          : '<span style="color:var(--muted)">—</span>');

    return `<div class="pr-card stage-${p.status||'lead'}">
      <div class="pr-card-hdr">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span class="pr-card-name">${p.name}</span>
            ${p.isPbf?`<span class="badge green" style="font-size:10px">🌿 LF</span>`:''}
          </div>
          <div class="ac-card-sub">${[p.type,p.address||p.territory].filter(Boolean).join(' · ')}</div>
          ${p.contact||p.phone?`<div class="ac-card-sub">${[p.contact,p.phone].filter(Boolean).join(' · ')}</div>`:''}
          ${p.email?`<div class="ac-card-email">✉ ${p.email}</div>`:''}
        </div>
        <div class="ac-card-badges">
          ${statusBadge(PR_STATUS,p.status)}
          <span class="badge ${priCfg.cls}">${priCfg.label}</span>
        </div>
      </div>
      <div class="ac-card-metrics cols3">
        <div><div class="ac-metric-label">Last Contacted</div><div class="ac-metric-val">${lastContactStr}</div></div>
        <div><div class="ac-metric-label">Next Follow-Up</div><div class="ac-metric-val">${nextFollowHtml}</div></div>
        <div><div class="ac-metric-label">Stage</div><div class="ac-metric-val">${PR_STATUS[p.status]?.label||p.status||'—'}</div></div>
      </div>
      ${lastNote?`<div class="ac-card-section"><div class="ac-card-section-label">Notes</div><div style="font-size:13px">${lastNote.text}</div></div>`:''}
      ${!lastNote&&lastOutreach?`<div class="ac-card-section"><div class="ac-card-section-label">Recent Outreach</div><div style="font-size:13px">${lastOutreach.type} · ${fmtD(lastOutreach.date)}</div></div>`:''}
      <div class="pr-card-nextsteps pr-card-nextsteps-tap" onclick="openLogOutreachModal('pr','${p.id}')">
        <div class="ac-card-section-label" style="color:#1e40af">☑ Next Steps <span style="font-size:10px;color:#93c5fd">(tap to log)</span></div>
        <div class="pr-card-nextsteps-text">${p.nextAction||'<span style="color:#93c5fd">No next steps set — tap to add</span>'}${p.nextDate?' &nbsp;·&nbsp; <strong>'+fmtD(p.nextDate)+'</strong>':''}</div>
      </div>
      <div class="ac-card-actions">
        <button class="btn sm primary" onclick="logProspectOutreach('${p.id}')">📞 Log Follow-Up</button>
        <button class="btn sm" onclick="editProspect('${p.id}')">Edit</button>
        <button class="btn sm green" onclick="if(confirm2('Convert to account?'))convertProspect('${p.id}')">→ Convert</button>
        <button class="btn sm red" onclick="deleteProspect('${p.id}')">✕</button>
      </div>
    </div>`;
  }).join('')||'<div class="empty">No prospects yet. Click "+ Add Prospect" to get started.</div>';
}

function openProspect(id) {
  const p = DB.a('pr').find(x=>x.id===id);
  if (!p) return;
  const m = document.getElementById('modal-prospect');
  if (!m) return;

  qs('#mpr-name').textContent = p.name;
  qs('#mpr-status-badge').innerHTML = statusBadge(PR_STATUS, p.status);
  qs('#mpr-contact').textContent = p.contact||'—';
  qs('#mpr-phone').textContent = p.phone||'—';
  qs('#mpr-email').textContent = p.email||'—';
  qs('#mpr-type').textContent = p.type||'—';
  qs('#mpr-territory').textContent = p.territory||'—';
  qs('#mpr-source').textContent = p.source||'—';
  qs('#mpr-last-contact').textContent = fmtD(p.lastContact);
  qs('#mpr-next-action').textContent = p.nextAction||'—';
  qs('#mpr-next-date').textContent = p.nextDate ? fmtD(p.nextDate) : (p.nextFollowUpLabel || '—');

  // Notes
  const nl = qs('#mpr-notes-list');
  if (nl) nl.innerHTML = (p.notes||[]).slice().reverse().map(n=>`
    <div class="note-item">
      <div class="note-date">${fmtD(n.date)}</div>
      <div>${n.text}</div>
    </div>`).join('') || '<div class="empty" style="padding:12px">No notes yet</div>';

  qs('#mpr-edit-btn').onclick = () => { closeModal('modal-prospect'); editProspect(id); };
  qs('#mpr-add-note-btn').onclick = () => addProspectNote(id);
  qs('#mpr-convert-btn').onclick = () => { if(confirm2('Convert to active account?')) convertProspect(id); };

  openModal('modal-prospect');
}

function addProspectNote(id) {
  const text = qs('#mpr-note-text')?.value?.trim();
  if (!text) return;
  const note = {id:uid(), date:today(), text};
  DB.update('pr', id, p=>({...p, notes:[...(p.notes||[]),note], lastContact:today()}));
  if (qs('#mpr-note-text')) qs('#mpr-note-text').value='';
  openProspect(id);
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
    delBtn.onclick = () => { if(confirm2('Delete prospect?')){ DB.remove('pr',id); closeModal('modal-edit-prospect'); renderProspects(); toast('Deleted'); }};
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

  const rec = {
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
    notes:      DB.a('pr').find(x=>x.id===id)?.notes||[],
    outreach:   DB.a('pr').find(x=>x.id===id)?.outreach||[],
    lastContact: DB.a('pr').find(x=>x.id===id)?.lastContact||today(),
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

function openLogOutreachModal(kind, id) {
  const name = kind === 'ac'
    ? DB.a('ac').find(x=>x.id===id)?.name
    : DB.a('pr').find(x=>x.id===id)?.name;
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
  const isAccount  = kind === 'ac';
  const isProspect = kind === 'pr';
  // contact + outcome: accounts only
  const contactRow = qs('#mlo-contact-row');
  const outcomeRow = qs('#mlo-outcome-row');
  if (contactRow) contactRow.style.display = isAccount ? '' : 'none';
  if (outcomeRow) outcomeRow.style.display = isAccount ? '' : 'none';
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

  if (kind === 'ac') {
    const entry = {
      id: uid(),
      date,
      type,
      contact,
      outcome,
      notes: note,
      nextFollowUp: nextDate || null,
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
    const entry = {id:uid(), type, date, note};
    DB.update('pr', id, p=>({
      ...p,
      outreach:[...(p.outreach||[]),entry],
      lastContact: date,
      ...(next ? {nextAction: next} : {}),
      ...(nextDate ? {nextDate} : {}),
    }));
    renderProspects();
    closeModal('modal-log-outreach');
    toast('Outreach logged');
  }
}

function deleteProspect(id) {
  if (!confirm2('Delete this prospect?')) return;
  DB.remove('pr', id);
  renderProspects();
  toast('Prospect deleted');
}

// ══════════════════════════════════════════════════════════
//  DISTRIBUTORS  (Phase 4)
// ══════════════════════════════════════════════════════════

const DIST_STATUS = {
  active:      {label:'Active',      cls:'green'},
  negotiating: {label:'Negotiating', cls:'amber'},
  on_hold:     {label:'On Hold',     cls:'gray'},
  inactive:    {label:'Inactive',    cls:'red'},
};

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

  const totalDoors = all.reduce((s,d)=>{
    const dc = chains.filter(c=>c.distId===d.id).reduce((a,c)=>a+(c.doorCount||0),0);
    return s + (dc||d.doorCount||0);
  }, 0);
  const outstanding = allInvs.filter(i=>['unpaid','overdue'].includes(i.status));
  const outstandingVal = outstanding.reduce((s,i)=>s+(i.total||0),0);
  const lastPO  = allPOs.sort((a,b)=>b.dateReceived>a.dateReceived?1:-1)[0]?.dateReceived||null;

  if (kpiEl) {
    kpiEl.innerHTML = `
      <div>${kpiHtml('Active Distributors', active.length, 'purple')}</div>
      <div>${kpiHtml('Total Doors', fmt(totalDoors)||'—', 'blue')}</div>
      <div>${kpiHtml('Outstanding Inv.', fmtC(outstandingVal), outstandingVal>0?'red':'green')}</div>
      <div>${kpiHtml('Last PO', lastPO?fmtD(lastPO):'None', 'gray')}</div>`;
  }

  if (attnEl) {
    const items = [];
    // Overdue invoices
    outstanding.filter(i=>i.dueDate&&i.dueDate<today()).forEach(i=>{
      const d = all.find(x=>x.id===i.distId);
      items.push(`<div class="attn-item" onclick="openDistributor('${i.distId}')" style="cursor:pointer">
        <div class="attn-icon">💸</div>
        <div class="attn-info">
          <div class="attn-name">${d?.name||'Distributor'}</div>
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
            <div class="attn-name">${d.name}</div>
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

  // ── KPI Cards (Phase 4) ──────────────────────────────────
  _renderDistListKPIs();

  const el = qs('#dist-cards');
  if (!el) return;

  el.innerHTML = list.map(d=>{
    const reps  = DB.a('dist_reps').filter(r=>r.distId===d.id);
    const pos   = DB.a('dist_pos').filter(p=>p.distId===d.id).sort((a,b)=>b.dateReceived>a.dateReceived?1:-1);
    const invs  = DB.a('dist_invoices').filter(i=>i.distId===d.id&&['unpaid','overdue'].includes(i.status));
    const lastPO = pos[0]?.dateReceived || null;
    const chains = DB.a('dist_chains').filter(c=>c.distId===d.id);
    const totalDoors = chains.reduce((s,c)=>s+(c.doorCount||0),0) || d.doorCount || 0;
    const pendingVal = invs.reduce((s,i)=>s+(i.total||0),0);
    // Outreach
    const outreach = (d.outreach||[]).slice().sort((a,b)=>b.date>a.date?1:-1);
    const lastContact = outreach[0]?.date || null;
    const lastContactDays = lastContact ? daysAgo(lastContact) : null;
    const nextFollowup = d.nextFollowup || null;

    const linkedAcCount = DB.a('ac').filter(a=>a.fulfilledBy===d.id).length;
    return `<div class="ac-card${lastContactDays!==null&&lastContactDays>30?' needs-attention':''}">
      <div class="ac-card-hdr">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span class="ac-card-name">${d.name}</span>
            <span class="badge gray">${d.platformType||'Other'}</span>
            ${linkedAcCount>0?`<span class="badge amber" style="font-size:10px">${linkedAcCount} account${linkedAcCount!==1?'s':''}</span>`:''}
          </div>
          <div class="ac-card-sub">${d.territory||'No territory set'}</div>
        </div>
        <div class="ac-card-badges">
          ${statusBadge(DIST_STATUS, d.status)}
          ${lastContactDays!==null&&lastContactDays>30?'<span class="badge amber">⚠ Needs Attention</span>':''}
        </div>
      </div>
      <div class="ac-card-metrics" style="grid-template-columns:repeat(${nextFollowup?5:4},1fr)">
        <div><div class="ac-metric-label">Total Doors</div><div class="ac-metric-val">${fmt(totalDoors)||'—'}</div></div>
        <div><div class="ac-metric-label">Sales Reps</div><div class="ac-metric-val">${reps.length}</div></div>
        <div><div class="ac-metric-label">Last Contacted</div><div class="ac-metric-val${lastContactDays!==null&&lastContactDays>30?' red':''}">${lastContact?`${fmtD(lastContact)} (${lastContactDays}d)`:'—'}</div></div>
        <div><div class="ac-metric-label">Last PO</div><div class="ac-metric-val${lastPO&&daysAgo(lastPO)>60?' red':''}">${lastPO?fmtD(lastPO):'—'}</div></div>
        ${nextFollowup?`<div><div class="ac-metric-label">Next Follow-Up</div><div class="ac-metric-val${nextFollowup<today()?' red':nextFollowup===today()?' amber':''}">${fmtD(nextFollowup)}</div></div>`:''}
      </div>
      ${outreach[0]?`<div class="ac-card-section"><div class="ac-card-section-label">Last Contact</div><div style="font-size:13px">${outreach[0].type} · ${fmtD(outreach[0].date)}${outreach[0].note?' — '+outreach[0].note:''}</div></div>`:''}
      ${pendingVal>0?`<div class="ac-card-section"><div class="ac-card-section-label">Outstanding Invoices</div><div style="font-size:13px;color:var(--red)">${fmtC(pendingVal)}</div></div>`:''}
      ${d.notes?`<div class="ac-card-section"><div class="ac-card-section-label">Notes</div><div style="font-size:13px">${d.notes}</div></div>`:''}
      <div class="ac-card-actions">
        <button class="btn sm primary" onclick="logDistContact('${d.id}')">📞 Log Contact</button>
        <button class="btn sm" onclick="openDistributor('${d.id}')">View Details</button>
        <button class="btn sm" onclick="editDistributor('${d.id}')">Edit</button>
        <button class="btn sm" onclick="addDistPO('${d.id}')">+ Log PO</button>
      </div>
    </div>`;
  }).join('') || `<div class="empty">
    <div class="empty-icon">🚚</div>
    No distributors yet. Add your first distributor to get started.
  </div>`;
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
  }
}

function renderDistOverviewHTML(d) {
  const terms = d.paymentTerms==='custom' ? `Custom (${d.paymentTermsDays||'?'} days)` : d.paymentTerms||'Net 30';
  const linkedAccounts = DB.a('ac').filter(a=>a.fulfilledBy===d.id);
  const linkedCount = linkedAccounts.length;
  const outstandingInvCount = DB.a('dist_invoices').filter(i=>i.distId===d.id&&['unpaid','overdue'].includes(i.status)).length;
  const outstandingInvVal = DB.a('dist_invoices').filter(i=>i.distId===d.id&&['unpaid','overdue'].includes(i.status)).reduce((s,i)=>s+(i.total||0),0);
  const recentPO = DB.a('dist_pos').filter(p=>p.distId===d.id).sort((a,b)=>b.dateReceived>a.dateReceived?1:-1)[0];
  const outreach = (d.outreach||[]).slice().sort((a,b)=>b.date>a.date?1:-1);
  const lastContact = outreach[0]?.date || d.lastContacted || null;

  // Warning: any linked account with no order in 30+ days
  const staleAccounts = linkedAccounts.filter(a=>daysAgo(a.lastOrder)>=30);

  return `
  <div class="card-grid grid-2" style="margin-bottom:14px">
    <div><span style="font-size:11px;color:var(--muted)">Platform Type</span><div>${d.platformType||'—'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Payment Terms</span><div>${terms}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Contract Start</span><div>${d.contractStart?fmtD(d.contractStart):'—'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Total Doors</span><div><strong>${fmt(d.doorCount||0)}</strong></div></div>
    <div><span style="font-size:11px;color:var(--muted)">Linked Accounts</span><div><strong style="cursor:pointer;color:var(--lavblue)" onclick="_switchDistTab('accounts')">${linkedCount}</strong></div></div>
    <div><span style="font-size:11px;color:var(--muted)">Outstanding Invoices</span><div>${outstandingInvCount>0?`<span style="color:var(--red);font-weight:600">${fmtC(outstandingInvVal)}</span>`:'<span style="color:var(--green)">Clear</span>'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Most Recent Shipment</span><div>${recentPO?fmtD(recentPO.dateReceived):'—'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Last Contacted</span><div>${lastContact?`${fmtD(lastContact)} (${daysAgo(lastContact)}d ago)`:'—'}</div></div>
  </div>
  ${staleAccounts.length>0?`<div style="background:#fef3c7;border:1px solid #d97706;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px">⚠ ${staleAccounts.length} linked account${staleAccounts.length!==1?'s have':' has'} not ordered in 30+ days: ${staleAccounts.map(a=>`<strong>${a.name}</strong>`).join(', ')}</div>`:''}
  <div style="margin-bottom:12px"><span style="font-size:11px;color:var(--muted)">Territory</span><div style="margin-top:4px">${d.territory||'—'}</div></div>
  ${d.notes?`<div class="highlight-box" style="margin-bottom:0"><div class="ac-card-section-label">Internal Notes</div><div style="font-size:13px;margin-top:4px">${d.notes}</div></div>`:''}`;
}

function renderDistRepsHTML(d) {
  const reps = DB.a('dist_reps').filter(r=>r.distId===d.id);
  const rows = reps.map(r=>`
    <div class="attn-item" style="flex-wrap:wrap;gap:8px">
      <div class="attn-info" style="flex:1;min-width:180px">
        <div class="attn-name">${r.name}</div>
        <div class="attn-reason">${[r.title, r.territory].filter(Boolean).join(' · ')}</div>
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
    const pricePerCan  = pricePerCase ? pricePerCase/12 : null;
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
        <div class="attn-name">${c.chainName}</div>
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
  qs('#edist-name').value     = d.name||'';
  qs('#edist-platform').value = d.platformType||'Local Line';
  qs('#edist-territory').value= d.territory||'';
  qs('#edist-doors').value    = d.doorCount||'';
  qs('#edist-contract').value = d.contractStart||'';
  qs('#edist-status').value   = d.status||'active';
  qs('#edist-terms').value    = d.paymentTerms||'Net 30';
  qs('#edist-terms-days').value= d.paymentTermsDays||30;
  qs('#edist-notes').value    = d.notes||'';

  const delBtn = qs('#edist-delete-btn');
  if (delBtn) { delBtn.style.display = isNew?'none':''; delBtn.onclick=()=>deleteDistributor(d.id); }
  qs('#edist-save-btn').onclick = ()=>saveDistributor(d.id, isNew);
  openModal('modal-edit-distributor');
}

function saveDistributor(id, isNew) {
  const name = qs('#edist-name')?.value?.trim();
  if (!name) { toast('Distributor name required'); return; }
  const terms = qs('#edist-terms')?.value||'Net 30';
  const existing = DB.a('dist_profiles').find(x=>x.id===id);
  const rec = {
    id, name,
    platformType:    qs('#edist-platform')?.value||'other',
    territory:       qs('#edist-territory')?.value?.trim()||'',
    doorCount:       parseInt(qs('#edist-doors')?.value)||0,
    contractStart:   qs('#edist-contract')?.value||'',
    status:          qs('#edist-status')?.value||'active',
    paymentTerms:    terms,
    paymentTermsDays: terms==='custom'?(parseInt(qs('#edist-terms-days')?.value)||30):parseInt(terms.replace('Net ','')||30),
    notes:           qs('#edist-notes')?.value?.trim()||'',
    createdAt:       existing?.createdAt || today(),
    // Preserve contact-history fields that are not editable in this form
    outreach:        existing?.outreach || [],
    nextFollowup:    existing?.nextFollowup || '',
    lastContact:     existing?.lastContact || '',
  };
  if (isNew) DB.push('dist_profiles', rec);
  else DB.update('dist_profiles', id, ()=>rec);
  closeModal('modal-edit-distributor');
  renderDistributors();
  toast(isNew?'Distributor added':'Distributor updated');
}

function deleteDistributor(id) {
  if (!confirm2('Delete this distributor? This will also remove all associated reps, pricing, POs, and invoices.')) return;
  DB.remove('dist_profiles', id);
  // Clean up related records
  ['dist_reps','dist_pricing','dist_pos','dist_invoices','dist_chains','dist_imports'].forEach(k=>{
    DB.set(k, DB.a(k).filter(r=>r.distId!==id));
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
    pricePerCase: pricing.find(p=>p.sku===s.id)?.pricePerCase||0
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
    doorCount:    parseInt(qs('#mchain-doors')?.value)||0,
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
  ['summary','locations','receive','repack','pallets','supplies','log'].forEach(t=>{
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
  const log = inv.slice().sort((a,b)=>b.date>a.date?1:-1).slice(0,40);
  const tbody = qs('#inv-log-body');
  if (!tbody) return;
  tbody.innerHTML = log.map(entry=>`
    <tr>
      <td>${fmtD(entry.date)}</td>
      <td>${skuBadge(entry.sku)}</td>
      <td><span class="badge ${entry.type==='in'?'green':'red'}">${entry.type==='in'?'+In':'−Out'}</span></td>
      <td>${fmt(entry.qty)}</td>
      <td>${entry.note||'—'}</td>
      <td><button class="btn xs red" onclick="delInvEntry('${entry.id}')">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No log entries</td></tr>';
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
}

// ══════════════════════════════════════════════════════════
//  DELIVERY
// ══════════════════════════════════════════════════════════
let _deliveryFulfillFilter = 'direct';

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
}

function addStop() {
  const name = qs('#del-stop-name')?.value?.trim();
  if (!name) { toast('Name required'); return; }
  const accountId = qs('#del-account-sel')?.value || null;
  const stop = {name, address:qs('#del-stop-addr')?.value?.trim()||'', notes:qs('#del-stop-notes')?.value?.trim()||'', done:false, accountId};
  SKUS.forEach(s=>{ stop[s.id]=parseInt(qs('#del-qty-'+s.id)?.value)||0; });

  const run = DB.obj('today_run', {date:today(), stops:[]});
  run.stops = [...(run.stops||[]), stop];
  DB.setObj('today_run', run);

  // Clear form
  if(qs('#del-stop-name')) qs('#del-stop-name').value='';
  if(qs('#del-stop-addr')) qs('#del-stop-addr').value='';
  if(qs('#del-stop-notes')) qs('#del-stop-notes').value='';
  SKUS.forEach(s=>{ if(qs('#del-qty-'+s.id)) qs('#del-qty-'+s.id).value=''; });
  if(qs('#del-account-sel')) { qs('#del-account-sel').value=''; }

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

    DB.atomicUpdate(cache => {
      cache['today_run'] = run;
      cache['ac'] = (cache['ac']||[]).map(a => a.id===ac2.id ? {...a, lastOrder:today()} : a);
      cache['iv'] = [...(cache['iv']||[]), ...newIvEntries];
      cache['orders'] = [...(cache['orders']||[]), newOrd];
    });

    // Offer invoice (non-blocking — renders after DB write)
    setTimeout(()=>offerDeliveryInvoice(stop, ac2, newOrd.id), 200);

    // Check if all stops are now done — offer batch invoicing
    const updatedRun = DB.obj('today_run', {stops:[]});
    const allDone = updatedRun.stops.length > 0 && updatedRun.stops.every(s=>s.done);
    if (allDone) setTimeout(()=>offerBatchInvoice(updatedRun.stops), 800);

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

  // Auto-increment invoice number
  const existing = DB.a('inv_log_v2');
  const lastNum  = existing.reduce((max,inv)=>{
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
  const total = lineItems.reduce((s,l)=>s+l.amount, 0);

  const invoice = {
    id: uid(), accountId, orderId: ordId, invoiceNumber,
    date: today(), dueDate, lineItems, total,
    status: 'pending', source: 'delivery_run', notes: '',
    accountName: ac.name,
  };

  DB.push('inv_log_v2', invoice);
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
  DB.setObj('today_run', {date:today(), stops:[]});
  const acSel = qs('#del-account-sel');
  if (acSel) acSel.dataset.loaded = '';
  renderDelivery();
  toast('Route cleared');
}

// ══════════════════════════════════════════════════════════
//  REPORTS
// ══════════════════════════════════════════════════════════
// ── Report Builder (Phase 6) ──────────────────────────────
let _reportChart = null;
let _reportType  = 'revenue';
let _reportData  = null; // cached for CSV export

function renderReports() {
  // Set default date range if blank (last 90 days)
  const fromEl = qs('#rep-date-from');
  const toEl   = qs('#rep-date-to');
  if (fromEl && !fromEl.value) fromEl.value = new Date(Date.now()-90*864e5).toISOString().slice(0,10);
  if (toEl   && !toEl.value)   toEl.value   = today();

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

  _reportType = tabs?.querySelector('.tab.active')?.dataset.rep || 'revenue';
  renderReportContent();
  renderSavedReports();
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
  const handlers = {
    revenue:     repRevenue,
    accounts:    repAccounts,
    inventory:   repInventory,
    distributor: repDistributor,
    profit:      repProfit,
  };
  (handlers[_reportType]||repRevenue)();
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
  if(qs('#set-company'))       qs('#set-company').value       = s.company||'';
  if(qs('#set-payment-terms')) qs('#set-payment-terms').value = s.payment_terms||30;
  if(qs('#set-lead-time'))     qs('#set-lead-time').value     = s.production_lead_time||14;

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
    // Preserve existing fields (known_users etc.)
    ...Object.fromEntries(
      Object.entries(DB.obj('settings',{})).filter(([k])=>!['company','payment_terms','production_lead_time','default_state','default_account_type','default_payment_terms','variety_recipe'].includes(k))
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
//  BOOT
// ══════════════════════════════════════════════════════════
window.onAppReady = function() {
  seedIfEmpty();
  restoreMyData(); // one-time: restores real accounts/prospects; guarded by _firestoreReady

  // Allow db.js real-time listener to refresh whichever page is open.
  // Also used to retry one-time migrations that were skipped because the
  // 10s startup timeout fired before Firestore data arrived.
  window.refreshCurrentPage = () => {
    restoreMyData();
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

  if (hasPoints) _mapInstance.fitBounds(bounds);
  _updateRunModeBar();
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

// Unit constant — defined separately from CANS_PER_CASE so either
// can change independently. Currently both equal 12.
const PORTAL_CANS_PER_CASE = 12;

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

async function generateOrderLink(accountId) {
  const a = DB.a('ac').find(x => x.id === accountId);
  if (!a) return null;
  let token = a.orderPortalToken;
  if (!token) {
    const salt = Math.random().toString(36).slice(2);
    const raw  = accountId + ':' + salt;
    token = btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    await firebase.firestore().collection('accounts').doc(accountId).update({
      orderPortalToken: token,
      orderPortalTokenCreatedAt: today()
    });
    DB.update('ac', accountId, ac => ({
      ...ac, orderPortalToken: token, orderPortalTokenCreatedAt: today()
    }));
    await PortalDB.setToken(token, {
      accountId, accountName: a.name, email: a.email || ''
    });
  }
  return `https://purpl-crm.web.app/order?t=${token}`;
}

async function copyOrderLink(accountId) {
  const url = await generateOrderLink(accountId);
  if (!url) { toast('Account not found'); return; }
  try {
    await navigator.clipboard.writeText(url);
  } catch(_) {
    const inp = document.createElement('input');
    inp.value = url; document.body.appendChild(inp);
    inp.select(); document.execCommand('copy');
    document.body.removeChild(inp);
  }
  toast('Link copied to clipboard ✓');
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
  const totalCans = totalCases * PORTAL_CANS_PER_CASE;
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
    kpiHtml('Total Cases', fmt(totalCases), `${fmt(totalCans)} cans · ${PORTAL_CANS_PER_CASE} cans/case`, 'blue') +
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
  ['all','unmatched','confirmed','notify','links'].forEach(id => {
    const el = qs(`#po-pane-${id}`);
    if (el) el.style.display = id === tab ? '' : 'none';
  });
  if (tab === 'all')       _renderPoAll();
  if (tab === 'unmatched') _renderPoUnmatched();
  if (tab === 'confirmed') _renderPoConfirmed();
  if (tab === 'notify')    _renderPoNotify();
  if (tab === 'links')     _renderPoLinks();
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
      <th>Status</th><th>Flags</th><th>Actions</th>
    </tr></thead>
    <tbody>${orders.map(o => {
      const cases = (o.items||[]).reduce((s,i)=>s+(i.cases||0),0);
      const cans  = cases * PORTAL_CANS_PER_CASE;
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
        <td>${_poStatusBadge(o.status||'new')}</td>
        <td>${multiFlag}</td>
        <td style="white-space:nowrap">
          <button class="btn xs" onclick="reviewPortalOrder('${o.id}')">Review</button>
          ${o.status!=='confirmed'&&o.status!=='declined'&&o.isMatched
            ? `<button class="btn xs primary" onclick="openConfirmPortalOrder('${o.id}')">Confirm</button>` : ''}
          ${o.status!=='declined'&&o.status!=='confirmed'
            ? `<button class="btn xs red" onclick="declinePortalOrder('${o.id}')">Decline</button>` : ''}
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
  const accounts = DB.a('ac').filter(a => a.orderPortalToken);
  const orders   = PortalDB.getOrders();
  const allAc    = DB.a('ac');

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
          ${url ? `<span style="cursor:pointer;color:var(--lavblue)" onclick="copyOrderLink('${a.id}')" title="${url}">${url.slice(0,50)}…</span>` : '<span style="color:var(--muted)">Not generated yet</span>'}
        </td>
        <td style="font-size:12px">${a.orderPortalTokenCreatedAt ? fmtD(a.orderPortalTokenCreatedAt) : '—'}</td>
        <td>${subCount > 0
          ? `<span class="badge green">Yes (${subCount})</span>`
          : '<span class="badge gray">No</span>'}</td>
        <td><button class="btn xs" onclick="copyOrderLink('${a.id}')">🔗 Copy Link</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
  </div>`;
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
  const cans  = cases * PORTAL_CANS_PER_CASE;
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

// ── Confirm portal order flow ─────────────────────────────

let _confirmPortalOrderId = null;

function openConfirmPortalOrder(id) {
  _confirmPortalOrderId = id;
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
    </div>
  `;

  const qtyInput = qs('#mcpo-classic-qty');
  if (qtyInput) {
    qtyInput.value = cases;
    qtyInput.oninput = () => {
      const q = parseInt(qtyInput.value)||0;
      const cc = qs('#mcpo-can-count');
      if (cc) cc.textContent = q > 0 ? `= ${q * PORTAL_CANS_PER_CASE} cans` : '';
    };
    qtyInput.oninput();
  }

  const notesInput = qs('#mcpo-notes');
  if (notesInput) notesInput.value = o.deliveryWindow ? `Delivery: ${o.deliveryWindow}` : '';

  const dueDateInput = qs('#mcpo-due-date');
  if (dueDateInput) dueDateInput.value = today();

  const saveBtn = qs('#mcpo-save-btn');
  if (saveBtn) saveBtn.onclick = () => _confirmPortalOrderSave();

  openModal('modal-confirm-portal-order');
}

async function _confirmPortalOrderSave() {
  const o = PortalDB.getOrders().find(x => x.id === _confirmPortalOrderId);
  if (!o) return;
  const cases   = parseInt(qs('#mcpo-classic-qty')?.value)||0;
  const dueDate = qs('#mcpo-due-date')?.value || today();
  const notes   = qs('#mcpo-notes')?.value?.trim()||'';
  if (cases < 1) { toast('Enter at least 1 case'); return; }
  if (!o.accountId) { toast('Account not linked'); return; }

  // Build real order in orders collection
  const orderId = uid();
  const cans    = cases * PORTAL_CANS_PER_CASE;
  const newOrder = {
    id: orderId,
    accountId: o.accountId,
    created: new Date().toISOString(),
    dueDate,
    status: 'pending',
    source: 'portal',
    linkedPortalOrderId: o.id,
    items: [{ sku:'classic', qty: cases }],
    canCount: cans,
    notes,
    invoiceStatus: 'none',
    invoiceDate: null,
    paidDate: null,
    poNumber: o.poNumber||'',
  };

  DB.push('orders', newOrder);

  // Update account lastOrder
  DB.update('ac', o.accountId, a => ({
    ...a, lastOrder: dueDate
  }));

  // Update portal_orders doc
  const nowIso = new Date().toISOString();
  await PortalDB.updateOrder(o.id, {
    status: 'confirmed',
    confirmedAt: new Date(),
    convertedOrderId: orderId,
  });

  closeModal('modal-confirm-portal-order');
  toast('Order confirmed and added to orders ✓');
  renderPreOrders(true);
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
        const cans  = cases * PORTAL_CANS_PER_CASE;
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
// Extend renderSettings to also load portal settings
const _origRenderSettings = renderSettings;
function renderSettings() {
  _origRenderSettings();
  renderPortalSettings();
}

