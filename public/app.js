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
function nav(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sb-nav a').forEach(a => a.classList.remove('active'));
  const pg = document.getElementById('page-'+page);
  if (pg) pg.classList.add('active');
  const lnk = document.querySelector(`.sb-nav a[data-page="${page}"]`);
  if (lnk) lnk.classList.add('active');
  const titles = {
    dashboard:'Dashboard', accounts:'Accounts', prospects:'Prospects',
    inventory:'Inventory', orders:'Orders', production:'Production',
    delivery:'Delivery', reports:'Reports', settings:'Settings'
  };
  const tb = document.getElementById('topbar-title');
  if (tb) tb.textContent = titles[page] || page;
  currentPage = page;
  renders[page]?.();
}

const renders = {
  dashboard:  renderDash,
  accounts:   renderAccounts,
  prospects:  renderProspects,
  inventory:  renderInventory,
  orders:     renderOrders,
  production: renderProduction,
  delivery:   renderDelivery,
  reports:    renderReports,
  settings:   renderSettings
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
  const ac = DB.a('ac').filter(x=>x.status==='active');
  const pr = DB.a('pr');
  const ord = DB.a('ord');
  const inv = DB.a('iv');

  // KPIs
  const revenue30 = ord.filter(o=>daysAgo(o.date)<=30&&o.status!=='cancelled')
    .reduce((s,o)=>{
      return s + (o.items||[]).reduce((ss,it)=>{
        const ac2 = DB.a('ac').find(a=>a.id===o.accountId);
        const price = ac2?.pricing?.[it.sku] || DB.obj('costs')?.cogs?.[it.sku]*2.2 || 5;
        return ss + price * it.qty;
      },0);
    },0);

  const pipeline = pr.filter(x=>!['won','lost'].includes(x.status)).length;
  const overdue = DB.a('orders').filter(o=>o.status==='pending'&&o.dueDate<today()).length;
  const lowStock = SKUS.filter(s=>{
    const on_hand = inv.filter(i=>i.sku===s.id&&i.type==='in').reduce((s,i)=>s+i.qty,0)
                  - inv.filter(i=>i.sku===s.id&&i.type==='out').reduce((s,i)=>s+i.qty,0);
    return on_hand < 48;
  }).length;

  qs('#dash-kpi-revenue').innerHTML = kpiHtml('Revenue (30d)', fmtC(revenue30), 'green');
  qs('#dash-kpi-accounts').innerHTML = kpiHtml('Active Accounts', ac.length, 'purple');
  qs('#dash-kpi-pipeline').innerHTML = kpiHtml('Open Prospects', pipeline, 'blue');
  qs('#dash-kpi-alerts').innerHTML = kpiHtml('Alerts', overdue + lowStock, overdue+lowStock>0?'red':'gray');

  // Attention panel
  renderAttention();

  // Recent orders
  const recentOrd = DB.a('orders').slice().sort((a,b)=>b.created>a.created?1:-1).slice(0,5);
  qs('#dash-recent-orders').innerHTML = recentOrd.length ? recentOrd.map(o=>{
    const ac2 = DB.a('ac').find(a=>a.id===o.accountId);
    return `<tr>
      <td>${ac2?.name||'—'}</td>
      <td>${(o.items||[]).map(i=>`${skuBadge(i.sku)} ×${i.qty}`).join(' ')}</td>
      <td>${fmtD(o.dueDate)}</td>
      <td>${statusBadge(ORD_STATUS,o.status)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="4" class="empty">No orders yet</td></tr>';
}

function kpiHtml(label, val, color) {
  return `<div class="kpi ${color}"><div class="num">${val}</div><div class="label">${label}</div></div>`;
}

function renderAttention() {
  const items = [];
  const ac = DB.a('ac');

  // Accounts not ordered in 21+ days
  ac.filter(a=>a.status==='active').forEach(a=>{
    const last = a.lastOrder;
    if (daysAgo(last) >= 21) {
      items.push({icon:'🕐', name:a.name, reason:`No order in ${daysAgo(last)} days`, action:`nav('accounts');openAccount('${a.id}')`});
    }
  });

  // Low stock
  SKUS.forEach(s=>{
    const inv = DB.a('iv');
    const on_hand = inv.filter(i=>i.sku===s.id&&i.type==='in').reduce((t,i)=>t+i.qty,0)
                  - inv.filter(i=>i.sku===s.id&&i.type==='out').reduce((t,i)=>t+i.qty,0);
    if (on_hand < 48) items.push({icon:'📦', name:`${s.label} — Low Stock`, reason:`${on_hand} units on hand`, action:`nav('inventory')`});
  });

  // Prospects with past-due next action
  DB.a('pr').filter(p=>p.nextDate&&p.nextDate<today()&&!['won','lost'].includes(p.status)).forEach(p=>{
    items.push({icon:'🎯', name:p.name, reason:`Follow-up overdue: ${p.nextAction||'check in'}`, action:`nav('prospects');openProspect('${p.id}')`});
  });

  const el = qs('#dash-attention');
  if (!el) return;
  el.innerHTML = items.length ? items.slice(0,8).map(i=>`
    <div class="attn-item" onclick="${i.action}" style="cursor:pointer">
      <div class="attn-icon">${i.icon}</div>
      <div class="attn-info"><div class="attn-name">${i.name}</div><div class="attn-reason">${i.reason}</div></div>
    </div>`).join('') : '<div class="empty">All clear! No immediate action needed.</div>';
}

// ══════════════════════════════════════════════════════════
//  ACCOUNTS
// ══════════════════════════════════════════════════════════
let acSort = {col:'name', dir:1};
let acSearch = '';

function renderAccounts() {
  let list = DB.a('ac');
  if (acSearch) {
    const q = acSearch.toLowerCase();
    list = list.filter(a=>a.name.toLowerCase().includes(q)||a.contact?.toLowerCase().includes(q)||a.territory?.toLowerCase().includes(q));
  }
  list = list.slice().sort((a,b)=>{
    const av = (a[acSort.col]||'').toString().toLowerCase();
    const bv = (b[acSort.col]||'').toString().toLowerCase();
    return av < bv ? -acSort.dir : av > bv ? acSort.dir : 0;
  });

  const tbody = qs('#ac-tbody');
  if (!tbody) return;
  tbody.innerHTML = list.map(a=>`
    <tr onclick="openAccount('${a.id}')" style="cursor:pointer">
      <td><strong>${a.name}</strong></td>
      <td>${a.contact||'—'}</td>
      <td>${a.type||'—'}</td>
      <td>${a.territory||'—'}</td>
      <td>${statusBadge(AC_STATUS, a.status)}</td>
      <td>${(a.skus||[]).map(skuBadge).join(' ')}</td>
      <td>${daysAgo(a.lastOrder) < 999 ? daysAgo(a.lastOrder)+'d ago' : '—'}</td>
      <td><button class="btn xs" onclick="event.stopPropagation();openAccount('${a.id}')">View</button></td>
    </tr>`).join('') || '<tr><td colspan="8" class="empty">No accounts yet</td></tr>';

  qs('#ac-count').textContent = `${list.length} account${list.length!==1?'s':''}`;
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
  qs('#eac-type').value = a.type||'Grocery';
  qs('#eac-territory').value = a.territory||'';
  qs('#eac-status').value = a.status||'active';
  qs('#eac-since').value = a.since||today();

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

function saveAccount(id, isNew) {
  const name = qs('#eac-name')?.value?.trim();
  if (!name) { toast('Account name required'); return; }
  const skus = [...document.querySelectorAll('#eac-skus input:checked')].map(x=>x.value);
  const par = {};
  skus.forEach(s=>{par[s]=parseInt(qs('#par-'+s)?.value)||24;});

  const rec = {
    id, name,
    contact: qs('#eac-contact')?.value?.trim()||'',
    phone:   qs('#eac-phone')?.value?.trim()||'',
    email:   qs('#eac-email')?.value?.trim()||'',
    type:    qs('#eac-type')?.value||'Grocery',
    territory: qs('#eac-territory')?.value?.trim()||'',
    status:  qs('#eac-status')?.value||'active',
    since:   qs('#eac-since')?.value||today(),
    skus, par,
    notes:   DB.a('ac').find(x=>x.id===id)?.notes||[],
    lastOrder: DB.a('ac').find(x=>x.id===id)?.lastOrder||null,
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
function renderProspects() {
  const pr = DB.a('pr');
  const groups = {};
  Object.keys(PR_STATUS).forEach(s=>groups[s]=[]);
  pr.forEach(p=>{(groups[p.status]||groups.lead).push(p);});

  const el = qs('#pr-kanban');
  if (!el) return;
  el.innerHTML = Object.entries(PR_STATUS).map(([status, cfg])=>{
    const cards = groups[status]||[];
    return `<div class="card" style="min-width:180px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <span class="badge ${cfg.cls}">${cfg.label}</span>
        <span style="font-size:12px;color:var(--muted)">${cards.length}</span>
      </div>
      ${cards.map(p=>`
        <div style="background:#f9fafb;border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer" onclick="openProspect('${p.id}')">
          <div style="font-size:13px;font-weight:600;margin-bottom:2px">${p.name}</div>
          <div style="font-size:11px;color:var(--muted)">${p.contact||''} · ${p.territory||''}</div>
          ${p.nextDate ? `<div style="font-size:11px;color:${p.nextDate<today()?'var(--red)':'var(--blue)'};margin-top:4px">📅 ${fmtD(p.nextDate)}</div>` : ''}
        </div>`).join('')}
    </div>`;
  }).join('');
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
  qs('#epr-type').value = p.type||'Grocery';
  qs('#epr-territory').value = p.territory||'';
  qs('#epr-status').value = p.status||'lead';
  qs('#epr-source').value = p.source||'';
  qs('#epr-next-action').value = p.nextAction||'';
  qs('#epr-next-date').value = p.nextDate||'';

  qs('#epr-save-btn').onclick = () => saveProspect(id, isNew);
  const delBtn = qs('#epr-delete-btn');
  if (delBtn) {
    delBtn.style.display = isNew ? 'none' : '';
    delBtn.onclick = () => { if(confirm2('Delete prospect?')){ DB.remove('pr',id); closeModal('modal-edit-prospect'); renderProspects(); toast('Deleted'); }};
  }

  openModal('modal-edit-prospect');
}

function saveProspect(id, isNew) {
  const name = qs('#epr-name')?.value?.trim();
  if (!name) { toast('Name required'); return; }
  const rec = {
    id, name,
    contact:    qs('#epr-contact')?.value?.trim()||'',
    phone:      qs('#epr-phone')?.value?.trim()||'',
    email:      qs('#epr-email')?.value?.trim()||'',
    type:       qs('#epr-type')?.value||'Grocery',
    territory:  qs('#epr-territory')?.value?.trim()||'',
    status:     qs('#epr-status')?.value||'lead',
    source:     qs('#epr-source')?.value?.trim()||'',
    nextAction: qs('#epr-next-action')?.value?.trim()||'',
    nextDate:   qs('#epr-next-date')?.value||'',
    notes:      DB.a('pr').find(x=>x.id===id)?.notes||[],
    lastContact: DB.a('pr').find(x=>x.id===id)?.lastContact||today(),
  };
  if (isNew) DB.push('pr', rec);
  else DB.update('pr', id, ()=>rec);
  closeModal('modal-edit-prospect');
  renderProspects();
  toast(isNew?'Prospect added':'Prospect updated');
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
  qs('#mod-delete-btn').onclick = ()=>{ if(confirm2('Delete this order?')){ DB.remove('orders',id); closeModal('modal-order-detail'); renderOrders(); toast('Deleted'); }};
  qs('#mod-status-btn').onclick = ()=>{ cycleOrderStatus(id); openOrderDetail(id); };
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

// ══════════════════════════════════════════════════════════
//  SEARCH AUTOCOMPLETE (global)
// ══════════════════════════════════════════════════════════
function setupGlobalSearch() {
  const inp = qs('#global-search');
  if (!inp) return;
  inp.addEventListener('input', () => {
    const q = inp.value.toLowerCase().trim();
    if (q.length < 2) { acSearch=''; renderAccounts(); return; }
    if (currentPage === 'accounts') { acSearch = q; renderAccounts(); }
  });
}

// ══════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════
window.onAppReady = function() {
  seedIfEmpty();

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

  setupGlobalSearch();

  // Navigate to dashboard
  nav('dashboard');
};
