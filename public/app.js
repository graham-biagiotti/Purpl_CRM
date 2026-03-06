// ═══════════════════════════════════════════════════════
//  app.js  —  purpl CRM  all business logic
//  Called via window.onAppReady() after auth + DB init
// ═══════════════════════════════════════════════════════

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
    production:'Production', delivery:'Today\'s Run', reports:'Reports', settings:'Settings'
  };
  const tb = document.getElementById('topbar-title');
  if (tb) tb.textContent = titles[page] || page;
  currentPage = page;
  renders[page]?.();
}

const renders = {
  dashboard:    renderDash,
  accounts:     renderAccounts,
  distributors: renderDistributors,
  prospects:    renderProspects,
  inventory:    renderInventory,
  orders:       renderOrders,
  production:   renderProduction,
  delivery:     renderDelivery,
  reports:      renderReports,
  settings:     renderSettings
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
  const settings = {company:'purpl Beverages',currency:'USD',territory_labels:['North','South','Central','West'],payment_terms:30};
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

  qs('#dash-kpi-revenue').innerHTML  = kpiHtml('Revenue (30d)',   fmtC(revenue30), 'green');
  qs('#dash-kpi-accounts').innerHTML = kpiHtml('Active Accounts', ac.length,       'purple');
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

// Price an order based on COGS*2.2 (or account-specific pricing if set)
function calcOrderValue(o) {
  const costs = DB.obj('costs', {cogs:{}});
  const ac2   = DB.a('ac').find(a=>a.id===o.accountId);
  return (o.items||[]).reduce((s,i)=>{
    const price = ac2?.pricing?.[i.sku] || (costs.cogs[i.sku]||2.15)*2.2;
    return s + price*i.qty;
  }, 0);
}

// ── Needs Attention (30+ days no contact) ────────────────
function renderAttention() {
  const items = [];
  const ac = DB.a('ac');

  ac.filter(a=>a.status==='active').forEach(a=>{
    const last = a.lastOrder;
    if (daysAgo(last) >= 30) {
      items.push({icon:'🕐', name:a.name, reason:`No order in ${daysAgo(last)} days`, action:`openAccount('${a.id}')`});
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

  // Overdue distributor invoices
  const todayStr = today();
  DB.a('dist_invoices').filter(i=>i.status==='unpaid'&&i.dueDate&&i.dueDate<todayStr).forEach(i=>{
    const d = DB.a('dist_profiles').find(x=>x.id===i.distId);
    items.push({icon:'💸', name:`${d?.name||'Distributor'} — Invoice Overdue`, reason:`$${fmtC(i.total)} due ${fmtD(i.dueDate)}`, action:`openDistributor('${i.distId}')`});
  });

  const el = qs('#dash-attention');
  if (!el) return;
  el.innerHTML = items.length ? items.slice(0,10).map(i=>`
    <div class="attn-item" onclick="${i.action}" style="cursor:pointer">
      <div class="attn-icon">${i.icon}</div>
      <div class="attn-info"><div class="attn-name">${i.name}</div><div class="attn-reason">${i.reason}</div></div>
    </div>`).join('') : '<div class="empty">All clear! No immediate action needed.</div>';
}

// ── Upcoming Follow-ups (next 14 days from notes / prospects) ─
function renderFollowUps() {
  const items = [];
  const now   = today();
  const in14  = new Date(Date.now()+14*864e5).toISOString().slice(0,10);

  DB.a('ac').forEach(a=>{
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
  openOrderDetail(id);
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
//  ACCOUNTS
// ══════════════════════════════════════════════════════════
function acLastContacted(a) {
  const noteDate     = a.notes?.length ? a.notes[a.notes.length-1].date : null;
  const outreachDate = a.outreach?.length ? a.outreach[a.outreach.length-1].date : null;
  if (noteDate && outreachDate) return noteDate > outreachDate ? noteDate : outreachDate;
  return noteDate || outreachDate || null;
}

function renderAccounts() {
  let list = DB.a('ac');
  const search     = qs('#ac-search')?.value?.toLowerCase().trim() || '';
  const typeFilter = qs('#ac-type-filter')?.value || '';
  const sortVal    = qs('#ac-sort')?.value || 'name';

  if (search) list = list.filter(a=>
    a.name?.toLowerCase().includes(search) ||
    a.contact?.toLowerCase().includes(search) ||
    a.territory?.toLowerCase().includes(search) ||
    a.address?.toLowerCase().includes(search));
  if (typeFilter) list = list.filter(a=>a.type===typeFilter);

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

    return `<div class="ac-card${needsAttn?' needs-attention':''}">
      <div class="ac-card-hdr">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span class="ac-card-name">${a.name}</span>
            ${(a.skus||[]).map(s=>`<span class="badge ${SKU_MAP[s]?.cls||'gray'}" style="font-size:10px">${SKU_MAP[s]?.label||s}</span>`).join('')}
          </div>
          <div class="ac-card-sub">${[a.type,a.address].filter(Boolean).join(' · ')}</div>
          ${a.contact||a.phone?`<div class="ac-card-sub">${[a.contact,a.phone].filter(Boolean).join(' · ')}</div>`:''}
          ${a.email?`<div class="ac-card-email">✉ ${a.email}</div>`:''}
          ${(a.locations||0)>1?`<div class="ac-card-sub">${a.locations} locations</div>`:''}
        </div>
        <div class="ac-card-badges">
          ${a.type?`<span class="badge gray">${a.type}</span>`:''}
          ${statusBadge(AC_STATUS,a.status)}
          ${needsAttn?`<span class="badge amber">⚠ Needs Attention</span>`:''}
        </div>
      </div>
      <div class="ac-card-metrics">
        <div><div class="ac-metric-label">Last Order</div>${lastOrderHtml}</div>
        <div><div class="ac-metric-label">Last Contacted</div>${lastContactHtml}</div>
        <div><div class="ac-metric-label">Velocity</div>${velocityHtml}</div>
        <div><div class="ac-metric-label">Outstanding</div>${outstandingHtml}</div>
      </div>
      ${lastNote?`<div class="ac-card-section"><div class="ac-card-section-label">Notes</div><div style="font-size:13px">${lastNote.text}</div></div>`:''}
      ${lastNote?.nextAction?`<div class="pr-card-nextsteps"><div class="ac-card-section-label" style="color:#1e40af">☑ Next Steps</div><div class="pr-card-nextsteps-text">${lastNote.nextAction}${lastNote.nextDate?' — '+fmtD(lastNote.nextDate):''}</div></div>`:''}
      ${!lastNote&&lastOutreach?`<div class="ac-card-section"><div class="ac-card-section-label">Recent Outreach</div><div style="font-size:13px">${lastOutreach.type} · ${fmtD(lastOutreach.date)}${lastOutreach.note?' — '+lastOutreach.note:''}</div></div>`:''}
      ${a.dropOffRules?`<div class="ac-card-rules"><div class="ac-card-section-label">🚚 Drop-Off Rules</div><div class="ac-card-rules-text">${a.dropOffRules}</div></div>`:''}
      <div class="ac-card-actions">
        <button class="btn sm primary" onclick="openAccount('${a.id}')">View</button>
        <button class="btn sm" onclick="quickNote('${a.id}')">Note</button>
        <button class="btn sm" onclick="logOutreach('${a.id}')">📞 Outreach</button>
        <button class="btn sm run" onclick="openNewOrder('${a.id}')">+ Run</button>
        <button class="btn sm" onclick="editAccount('${a.id}')">Edit</button>
      </div>
    </div>`;
  }).join('')||'<div class="empty">No accounts yet. Click "+ Add Account" to get started.</div>';
}

function openAccount(id) {
  const a = DB.a('ac').find(x=>x.id===id);
  if (!a) return;
  const m = document.getElementById('modal-account');
  if (!m) return;

  // Header
  qs('#mac-name').textContent = a.name;
  qs('#mac-status-badge').innerHTML = statusBadge(AC_STATUS, a.status);

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

  // Order history
  const acOrders = DB.a('orders').filter(o=>o.accountId===id).sort((a,b)=>b.created>a.created?1:-1).slice(0,8);
  qs('#mac-order-hist').innerHTML = acOrders.length ? acOrders.map(o=>`
    <tr><td>${fmtD(o.dueDate)}</td>
    <td>${(o.items||[]).map(i=>`${skuBadge(i.sku)} ×${i.qty}`).join(' ')}</td>
    <td>${statusBadge(ORD_STATUS,o.status)}</td>
    <td>${o.notes||''}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No orders yet</td></tr>';

  // Notes
  renderAccountNotes(a);

  // Set edit button
  qs('#mac-edit-btn').onclick = () => { closeModal('modal-account'); editAccount(id); };
  qs('#mac-order-btn').onclick = () => { closeModal('modal-account'); openNewOrder(id); };

  // Tab switching
  document.querySelectorAll('#modal-account .tab').forEach(t=>{
    t.onclick = () => {
      document.querySelectorAll('#modal-account .tab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('#modal-account .tab-pane').forEach(x=>x.style.display='none');
      t.classList.add('active');
      const pane = document.getElementById('mac-tab-'+t.dataset.tab);
      if (pane) pane.style.display='block';
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
  DB.update('ac', id, a=>({...a, notes:[...(a.notes||[]), note]}));
  if (qs('#mac-note-text')) qs('#mac-note-text').value='';
  if (qs('#mac-note-next')) qs('#mac-note-next').value='';
  if (qs('#mac-note-next-date')) qs('#mac-note-next-date').value='';
  const a = DB.a('ac').find(x=>x.id===id);
  renderAccountNotes(a);
  toast('Note saved');
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
  qs('#eac-address').value = a.address||'';
  qs('#eac-type').value = a.type||'Grocery';
  qs('#eac-territory').value = a.territory||'';
  qs('#eac-status').value = a.status||'active';
  qs('#eac-since').value = a.since||today();
  qs('#eac-locations').value = a.locations||1;
  qs('#eac-drop-rules').value = a.dropOffRules||'';

  // SKU checkboxes
  qs('#eac-skus').innerHTML = SKUS.map(s=>`
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer">
      <input type="checkbox" value="${s.id}" ${(a.skus||[]).includes(s.id)?'checked':''}> ${s.label}
    </label>`).join('');

  // Par inputs
  renderParInputs(a);

  qs('#eac-save-btn').onclick = () => saveAccount(id, isNew);
  // Re-attach address autocomplete (safe to call multiple times)
  if (window.PlacesAC) PlacesAC.reattach();
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
  const addrEl  = qs('#eac-address');
  const address = addrEl?.value?.trim()||'';

  // Silently capture lat/lng (from autocomplete or geocode fallback)
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
    contact:      qs('#eac-contact')?.value?.trim()||'',
    phone:        qs('#eac-phone')?.value?.trim()||'',
    email:        qs('#eac-email')?.value?.trim()||'',
    address,
    lat, lng,                         // stored for future map use
    type:         qs('#eac-type')?.value||'Grocery',
    territory:    qs('#eac-territory')?.value?.trim()||'',
    status:       qs('#eac-status')?.value||'active',
    since:        qs('#eac-since')?.value||today(),
    locations:    parseInt(qs('#eac-locations')?.value)||1,
    dropOffRules: qs('#eac-drop-rules')?.value?.trim()||'',
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
  const search      = qs('#pr-search')?.value?.toLowerCase().trim() || '';
  const stageFilter = qs('#pr-stage-filter')?.value || '';
  const sortVal     = qs('#pr-sort')?.value || 'priority';

  if (search) list = list.filter(p=>
    p.name?.toLowerCase().includes(search) ||
    p.contact?.toLowerCase().includes(search) ||
    p.address?.toLowerCase().includes(search));
  if (stageFilter) list = list.filter(p=>p.status===stageFilter);

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
      : '<span style="color:var(--muted)">—</span>';

    return `<div class="pr-card stage-${p.status||'lead'}">
      <div class="pr-card-hdr">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span class="pr-card-name">${p.name}</span>
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
      ${p.nextAction?`<div class="pr-card-nextsteps"><div class="ac-card-section-label" style="color:#1e40af">☑ Next Steps</div><div class="pr-card-nextsteps-text">${p.nextAction}</div></div>`:''}
      <div class="ac-card-actions">
        <button class="btn sm primary" onclick="editProspect('${p.id}')">Edit</button>
        <button class="btn sm" onclick="logProspectOutreach('${p.id}')">📞 Log Outreach</button>
        <button class="btn sm green" onclick="if(confirm2('Convert to account?'))convertProspect('${p.id}')">→ Convert to Account</button>
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
  qs('#mpr-next-date').textContent = p.nextDate ? fmtD(p.nextDate) : '—';

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
  DB.update('pr', id, x=>({...x, status:'won'}));
  const newAc = {
    id:uid(), name:p.name, contact:p.contact||'', phone:p.phone||'', email:p.email||'',
    type:p.type||'Grocery', territory:p.territory||'', status:'active',
    since:today(), skus:[], par:{}, notes:[], lastOrder:null
  };
  DB.push('ac', newAc);
  closeModal('modal-prospect');
  renderProspects();
  toast('Converted to account! Edit the account to add SKUs & par.');
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

  qs('#epr-save-btn').onclick = () => saveProspect(id, isNew);
  // Re-attach address autocomplete
  if (window.PlacesAC) PlacesAC.reattach();
  const delBtn = qs('#epr-delete-btn');
  if (delBtn) {
    delBtn.style.display = isNew ? 'none' : '';
    delBtn.onclick = () => { if(confirm2('Delete prospect?')){ DB.remove('pr',id); closeModal('modal-edit-prospect'); renderProspects(); toast('Deleted'); }};
  }

  openModal('modal-edit-prospect');
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
  const type = prompt('Outreach type (Call / Email / Visit / Text):') || 'Call';
  if (!type.trim()) return;
  const note = prompt('Notes (optional):') || '';
  const entry = {id:uid(), type:type.trim(), date:today(), note:note.trim()};
  DB.update('ac', id, a=>({...a, outreach:[...(a.outreach||[]),entry]}));
  renderAccounts();
  toast('Outreach logged');
}

function logProspectOutreach(id) {
  const type = prompt('Outreach type (Call / Email / Visit / Text):') || 'Call';
  if (!type.trim()) return;
  const note = prompt('Notes (optional):') || '';
  const entry = {id:uid(), type:type.trim(), date:today(), note:note.trim()};
  DB.update('pr', id, p=>({...p, outreach:[...(p.outreach||[]),entry], lastContact:today()}));
  renderProspects();
  toast('Outreach logged');
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

    return `<div class="ac-card">
      <div class="ac-card-hdr">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span class="ac-card-name">${d.name}</span>
            <span class="badge gray">${d.platformType||'Other'}</span>
          </div>
          <div class="ac-card-sub">${d.territory||'No territory set'}</div>
        </div>
        <div class="ac-card-badges">
          ${statusBadge(DIST_STATUS, d.status)}
        </div>
      </div>
      <div class="ac-card-metrics" style="grid-template-columns:repeat(4,1fr)">
        <div><div class="ac-metric-label">Total Doors</div><div class="ac-metric-val">${fmt(totalDoors)||'—'}</div></div>
        <div><div class="ac-metric-label">Sales Reps</div><div class="ac-metric-val">${reps.length}</div></div>
        <div><div class="ac-metric-label">Last PO</div><div class="ac-metric-val${lastPO&&daysAgo(lastPO)>60?' red':''}">${lastPO?fmtD(lastPO):'—'}</div></div>
        <div><div class="ac-metric-label">Outstanding Inv.</div><div class="ac-metric-val${pendingVal>0?' red':' green'}">${pendingVal>0?fmtC(pendingVal):'Clear'}</div></div>
      </div>
      ${d.notes?`<div class="ac-card-section"><div class="ac-card-section-label">Notes</div><div style="font-size:13px">${d.notes}</div></div>`:''}
      <div class="ac-card-actions">
        <button class="btn sm primary" onclick="openDistributor('${d.id}')">View Details</button>
        <button class="btn sm" onclick="editDistributor('${d.id}')">Edit</button>
        <button class="btn sm" onclick="addDistPO('${d.id}')">+ Log PO</button>
        <button class="btn sm" onclick="addDistInvoice('${d.id}')">+ Invoice</button>
      </div>
    </div>`;
  }).join('') || `<div class="empty">
    <div class="empty-icon">🚚</div>
    No distributors yet. Add your first distributor to get started.
  </div>`;
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
  }
}

function renderDistOverviewHTML(d) {
  const terms = d.paymentTerms==='custom' ? `Custom (${d.paymentTermsDays||'?'} days)` : d.paymentTerms||'Net 30';
  return `
  <div class="card-grid grid-2" style="margin-bottom:14px">
    <div><span style="font-size:11px;color:var(--muted)">Platform Type</span><div>${d.platformType||'—'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Payment Terms</span><div>${terms}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Contract Start</span><div>${d.contractStart?fmtD(d.contractStart):'—'}</div></div>
    <div><span style="font-size:11px;color:var(--muted)">Total Doors</span><div><strong>${fmt(d.doorCount||0)}</strong></div></div>
  </div>
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
    <div style="margin-bottom:12px;display:flex;justify-content:flex-end">
      <button class="btn sm primary" onclick="addDistPOInModal('${d.id}')">+ Log PO</button>
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
    createdAt:       DB.a('dist_profiles').find(x=>x.id===id)?.createdAt || today(),
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

  el.innerHTML = `
    <div>${kpiHtml('Active Distributors', active.length, 'purple')}</div>
    <div>${kpiHtml('Total Doors', fmt(totalDoors)||'—', 'blue')}</div>
    <div>${kpiHtml('Outstanding Inv.', fmtC(outstandingVal), outstandingVal>0?'red':'green')}</div>
    <div>${kpiHtml('Last PO', lastPO?fmtD(lastPO):'None', 'gray')}</div>`;
}

// ══════════════════════════════════════════════════════════
//  INVENTORY
// ══════════════════════════════════════════════════════════
function renderInventory() {
  const inv = DB.a('iv');
  const el = qs('#inv-table-body');
  if (!el) return;

  const rows = SKUS.map(s=>{
    const ins  = inv.filter(i=>i.sku===s.id&&i.type==='in').reduce((t,i)=>t+i.qty,0);
    const outs = inv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
    const on_hand = ins - outs;
    const status = on_hand < 24 ? {label:'Critical',cls:'red'} : on_hand < 48 ? {label:'Low',cls:'amber'} : {label:'OK',cls:'green'};
    return `<tr>
      <td>${skuBadge(s.id)}</td>
      <td><strong>${fmt(on_hand)}</strong></td>
      <td>${fmt(ins)}</td>
      <td>${fmt(outs)}</td>
      <td><span class="badge ${status.cls}">${status.label}</span></td>
      <td>
        <button class="btn xs primary" onclick="invAdjust('${s.id}','in')">+ Receive</button>
        <button class="btn xs" onclick="invAdjust('${s.id}','out')">– Use</button>
      </td>
    </tr>`;
  });
  el.innerHTML = rows.join('');

  // Recent log
  const log = inv.slice().sort((a,b)=>b.date>a.date?1:-1).slice(0,20);
  qs('#inv-log-body').innerHTML = log.map(entry=>`
    <tr>
      <td>${fmtD(entry.date)}</td>
      <td>${skuBadge(entry.sku)}</td>
      <td><span class="badge ${entry.type==='in'?'green':'red'}">${entry.type==='in'?'+Received':'−Used'}</span></td>
      <td>${fmt(entry.qty)}</td>
      <td>${entry.note||'—'}</td>
      <td><button class="btn xs red" onclick="delInvEntry('${entry.id}')">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="empty">No log entries</td></tr>';
}

function invAdjust(sku, type) {
  const qty = parseInt(prompt(`Enter quantity to ${type==='in'?'receive':'use'} for ${SKU_MAP[sku]?.label}:`));
  if (!qty || qty <= 0) return;
  const note = prompt('Note (optional):') || '';
  DB.push('iv', {id:uid(), date:today(), sku, type, qty, note});
  renderInventory();
  toast(`Inventory updated`);
}

function delInvEntry(id) {
  if (!confirm2('Remove this entry?')) return;
  DB.remove('iv', id);
  renderInventory();
  toast('Entry removed');
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
  tbody.innerHTML = list.map(o=>{
    const ac2 = DB.a('ac').find(a=>a.id===o.accountId);
    const isOverdue = o.status==='pending' && o.dueDate < today();
    return `<tr class="${isOverdue?'':''}">
      <td>${fmtD(o.created)}</td>
      <td>${ac2?.name||'Unknown'}</td>
      <td>${(o.items||[]).map(i=>`${skuBadge(i.sku)} ×${i.qty}`).join(' ')}</td>
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
    sel.innerHTML = DB.a('ac').map(a=>`<option value="${a.id}" ${a.id===accountId?'selected':''}>${a.name}</option>`).join('');
    if (accountId) sel.value = accountId;
    populateOrderSkus();
  }
  qs('#nord-due').value = '';
  qs('#nord-notes').value = '';
  qs('#nord-save-btn').onclick = saveNewOrder;
  openModal('modal-new-order');
}

function populateOrderSkus() {
  const sel = qs('#nord-account');
  const ac2 = sel ? DB.a('ac').find(a=>a.id===sel.value) : null;
  const skus = ac2?.skus?.length ? ac2.skus : SKUS.map(s=>s.id);
  const el = qs('#nord-items');
  if (!el) return;
  el.innerHTML = skus.map(s=>`
    <div class="order-item-row">
      ${skuBadge(s)}
      <input type="number" id="nord-qty-${s}" placeholder="qty" min="0" step="6" style="width:80px">
      <span style="font-size:12px;color:var(--muted)">units (par: ${ac2?.par?.[s]||'—'})</span>
      ${ac2?.par?.[s]?`<button class="btn xs" onclick="qs('#nord-qty-${s}').value=${ac2.par[s]}">Fill par</button>`:''}
    </div>`).join('');
}

function saveNewOrder() {
  const accountId = qs('#nord-account')?.value;
  const dueDate   = qs('#nord-due')?.value;
  const notes     = qs('#nord-notes')?.value?.trim()||'';
  if (!accountId || !dueDate) { toast('Account and due date required'); return; }

  const items = [];
  SKUS.forEach(s=>{
    const qty = parseInt(qs('#nord-qty-'+s.id)?.value)||0;
    if (qty > 0) items.push({sku:s.id, qty});
  });
  if (!items.length) { toast('Add at least one SKU quantity'); return; }

  const ord = {id:uid(), accountId, dueDate, notes, items, status:'pending', created:today()};
  DB.push('orders', ord);
  DB.update('ac', accountId, a=>({...a, lastOrder:today()}));

  closeModal('modal-new-order');
  renderOrders();
  toast('Order created');
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
  qs('#mod-items').innerHTML = (o.items||[]).map(i=>`<div>${skuBadge(i.sku)} × <strong>${i.qty}</strong></div>`).join('');

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

  qs('#mod-delete-btn').onclick    = ()=>{ if(confirm2('Delete this order?')){ DB.remove('orders',id); closeModal('modal-order-detail'); renderOrders(); toast('Deleted'); }};
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
  DB.update('orders', id, o=>{
    const i = seq.indexOf(o.status);
    return {...o, status: seq[Math.min(i+1, seq.length-1)]};
  });
  renderOrders();
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
  // Also update inventory
  Object.entries(items).forEach(([sku, qty])=>{
    DB.push('iv', {id:uid(), date:today(), sku, type:'in', qty, note:'Production run'});
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
  DB.remove('prod_hist', id);
  renderProduction();
  toast('Removed');
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
function renderDelivery() {
  const run = DB.obj('today_run', {date:'', stops:[]});
  const stops = run.stops || [];

  const el = qs('#del-stops');
  if (!el) return;
  el.innerHTML = stops.length ? stops.map((s,i)=>`
    <div class="order-card ${s.done?'':''}">
      <div style="display:flex;align-items:flex-start;gap:10px">
        <input type="checkbox" ${s.done?'checked':''} onchange="toggleStop(${i})" style="width:16px;height:16px;margin-top:2px;cursor:pointer">
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;${s.done?'text-decoration:line-through;opacity:.5':''}">${s.name}</div>
          <div style="font-size:12px;color:var(--muted)">${s.address||''}</div>
          <div style="margin-top:6px">${SKUS.map(sk=>s[sk.id]>0?`${skuBadge(sk.id)} ×${s[sk.id]}`:'').filter(Boolean).join(' ')}</div>
          ${s.notes?`<div style="font-size:12px;color:var(--muted);margin-top:4px">${s.notes}</div>`:''}
        </div>
        <button class="btn xs red" onclick="removeStop(${i})">✕</button>
      </div>
    </div>`).join('') : '<div class="empty">No stops on today\'s route. Add stops below.</div>';

  // Stats
  const done = stops.filter(s=>s.done).length;
  qs('#del-progress').innerHTML = stops.length ? `${done}/${stops.length} stops complete` : '';

  // Pre-fill add-stop form with accounts
  const acSel = qs('#del-account-sel');
  if (acSel && !acSel.dataset.loaded) {
    acSel.innerHTML = '<option value="">— Select account —</option>' +
      DB.a('ac').filter(a=>a.status==='active').map(a=>`<option value="${a.id}">${a.name}</option>`).join('');
    acSel.dataset.loaded = '1';
    acSel.onchange = () => prefillStop(acSel.value);
  }
}

function prefillStop(accountId) {
  const ac2 = DB.a('ac').find(a=>a.id===accountId);
  if (!ac2) return;
  if (qs('#del-stop-name')) qs('#del-stop-name').value = ac2.name;
  SKUS.forEach(s=>{
    if(qs('#del-qty-'+s.id)) qs('#del-qty-'+s.id).value = ac2.par?.[s.id]||0;
  });
}

function addStop() {
  const name = qs('#del-stop-name')?.value?.trim();
  if (!name) { toast('Name required'); return; }
  const stop = {name, address:qs('#del-stop-addr')?.value?.trim()||'', notes:qs('#del-stop-notes')?.value?.trim()||'', done:false};
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
  if (run.stops[i]) run.stops[i].done = !run.stops[i].done;
  DB.setObj('today_run', run);

  // Update last order date for the account
  const stop = run.stops[i];
  const ac2 = DB.a('ac').find(a=>a.name===stop.name);
  if (ac2 && stop.done) {
    DB.update('ac', ac2.id, a=>({...a, lastOrder:today()}));
    // Deduct inventory
    SKUS.forEach(s=>{
      if(stop[s.id]>0) DB.push('iv', {id:uid(), date:today(), sku:s.id, type:'out', qty:stop[s.id], note:'Delivery: '+stop.name});
    });
  }

  renderDelivery();
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
function renderReports() {
  renderSalesReport();
  renderInventoryReport();
}

function renderSalesReport() {
  const orders = DB.a('orders').filter(o=>o.status!=='cancelled');
  const costs = DB.obj('costs', {cogs:{},overhead_monthly:1200,target_margin:.6});

  // Revenue by SKU
  const bySkuRev = {};
  const bySkuQty = {};
  SKUS.forEach(s=>{bySkuRev[s.id]=0;bySkuQty[s.id]=0;});
  orders.forEach(o=>{
    const ac2 = DB.a('ac').find(a=>a.id===o.accountId);
    (o.items||[]).forEach(i=>{
      const price = ac2?.pricing?.[i.sku] || (costs.cogs[i.sku]||2.15)*2.2;
      bySkuRev[i.sku]=(bySkuRev[i.sku]||0)+price*i.qty;
      bySkuQty[i.sku]=(bySkuQty[i.sku]||0)+i.qty;
    });
  });

  const el = qs('#rep-sku-body');
  if (el) el.innerHTML = SKUS.map(s=>{
    const rev = bySkuRev[s.id]||0;
    const qty = bySkuQty[s.id]||0;
    const cogs = (costs.cogs[s.id]||2.15)*qty;
    const gp = rev-cogs;
    const margin = rev>0?gp/rev:0;
    return `<tr>
      <td>${skuBadge(s.id)}</td>
      <td>${fmt(qty)}</td>
      <td>${fmtC(rev)}</td>
      <td>${fmtC(cogs)}</td>
      <td>${fmtC(gp)}</td>
      <td><span class="badge ${margin>=.5?'green':margin>=.3?'amber':'red'}">${fmt(margin*100,1)}%</span></td>
    </tr>`;
  }).join('');

  const totalRev = Object.values(bySkuRev).reduce((a,b)=>a+b,0);
  const totalQty = Object.values(bySkuQty).reduce((a,b)=>a+b,0);
  const totalCogs = SKUS.reduce((s,sk)=>(s+(costs.cogs[sk.id]||2.15)*(bySkuQty[sk.id]||0)),0);
  const totalGP = totalRev-totalCogs;
  if(qs('#rep-total-rev')) qs('#rep-total-rev').textContent = fmtC(totalRev);
  if(qs('#rep-total-qty')) qs('#rep-total-qty').textContent = fmt(totalQty)+' units';
  if(qs('#rep-total-gp')) qs('#rep-total-gp').textContent = fmtC(totalGP);
  if(qs('#rep-margin')) qs('#rep-margin').textContent = totalRev>0?fmt((totalGP/totalRev)*100,1)+'%':'—';
}

function renderInventoryReport() {
  const inv = DB.a('iv');
  const el = qs('#rep-inv-body');
  if (!el) return;
  el.innerHTML = SKUS.map(s=>{
    const ins  = inv.filter(i=>i.sku===s.id&&i.type==='in').reduce((t,i)=>t+i.qty,0);
    const outs = inv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
    const on_hand = ins-outs;
    const val = on_hand*(DB.obj('costs').cogs?.[s.id]||2.15);
    const status = on_hand<24?'red':on_hand<48?'amber':'green';
    return `<tr>
      <td>${skuBadge(s.id)}</td>
      <td>${fmt(ins)}</td>
      <td>${fmt(outs)}</td>
      <td><strong>${fmt(on_hand)}</strong></td>
      <td>${fmtC(val)}</td>
      <td><span class="badge ${status}">${on_hand<24?'Critical':on_hand<48?'Low':'OK'}</span></td>
    </tr>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════
function renderSettings() {
  const s = DB.obj('settings', {});
  const c = DB.obj('costs', {cogs:{},overhead_monthly:1200,target_margin:.6});
  if(qs('#set-company')) qs('#set-company').value = s.company||'';
  if(qs('#set-payment-terms')) qs('#set-payment-terms').value = s.payment_terms||30;
  SKUS.forEach(sk=>{
    if(qs('#cost-'+sk.id)) qs('#cost-'+sk.id).value = c.cogs?.[sk.id]||'';
  });
  if(qs('#cost-overhead')) qs('#cost-overhead').value = c.overhead_monthly||1200;
  if(qs('#cost-target-margin')) qs('#cost-target-margin').value = (c.target_margin||.6)*100;
}

function saveSettings() {
  const s = {
    company: qs('#set-company')?.value?.trim()||'',
    payment_terms: parseInt(qs('#set-payment-terms')?.value)||30,
  };
  DB.setObj('settings', s);

  const cogs = {};
  SKUS.forEach(sk=>{ cogs[sk.id]=parseFloat(qs('#cost-'+sk.id)?.value)||2.15; });
  const c = {
    cogs,
    overhead_monthly: parseFloat(qs('#cost-overhead')?.value)||1200,
    target_margin: (parseFloat(qs('#cost-target-margin')?.value)||60)/100,
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
  ['#ac-search','#ac-type-filter','#ac-sort'].forEach(sel=>{
    const el = qs(sel);
    if (el) el.addEventListener('input', renderAccounts);
  });
  // Prospects
  ['#pr-search','#pr-stage-filter','#pr-sort'].forEach(sel=>{
    const el = qs(sel);
    if (el) el.addEventListener('input', renderProspects);
  });
  // Distributors
  ['#dist-search','#dist-status-filter'].forEach(sel=>{
    const el = qs(sel);
    if (el) el.addEventListener('input', renderDistributors);
  });
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
//  BOOT
// ══════════════════════════════════════════════════════════
window.onAppReady = function() {
  seedIfEmpty();

  // Initialize address autocomplete (Phase 3)
  // Fires async — no blocking. Silent if no API key set.
  if (window.PlacesAC) PlacesAC.initAll();

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
  if (acSkuBox) acSkuBox.addEventListener('change', ()=>renderParInputs({}));

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
