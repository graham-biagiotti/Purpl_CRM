'use strict';
// =============================================================
//  seed-data.js  —  Test fixture data for Purpl CRM emulator
//  isPbf: false = purpl-only  |  isPbf: true = carries LF
// =============================================================

// ── Date helpers (anchored to 2026-04-02) ────────────────────
const BASE = new Date('2026-04-02T12:00:00.000Z');
const D = (offsetDays = 0) => {
  const d = new Date(BASE); d.setDate(d.getDate() - offsetDays);
  return d.toISOString().slice(0, 10);
};
const ISO = (offsetDays = 0) => {
  const d = new Date(BASE); d.setDate(d.getDate() - offsetDays);
  return d.toISOString();
};

// ── ID counter ───────────────────────────────────────────────
let _n = 1;
const sid = () => `s${String(_n++).padStart(5, '0')}`;

// ── Cadence entry factory ────────────────────────────────────
const ce = (stage, daysAgo, method = 'resend') =>
  ({ id: sid(), stage, sentAt: ISO(daysAgo), sentBy: 'graham', method });

// ── Outreach entry factory ───────────────────────────────────
const oe = (daysAgo, type, outcome, contact, notes, regarding = 'purpl') =>
  ({ id: sid(), date: D(daysAgo), type, outcome, contact, notes, regarding });

// ── Note factory ─────────────────────────────────────────────
const ne = (daysAgo, text) => ({ id: sid(), date: D(daysAgo), text });

// ── Standard cadence sets ────────────────────────────────────
const cad4 = (base = 120) => [
  ce('application_received', base),
  ce('approved_welcome',     base - 14),
  ce('invoice_sent',         base - 35),
  ce('first_order_followup', base - 55),
];
const cad3 = (base = 120) => [
  ce('application_received', base),
  ce('approved_welcome',     base - 14),
  ce('invoice_sent',         base - 35),
];
const cad2 = (base = 100) => [
  ce('application_received', base),
  ce('approved_welcome',     base - 14),
];
const cad1 = (base = 90) => [
  ce('application_received', base),
];

// Generate a block of outreach entries
const manyOutreach = (count, suffix) => {
  const types    = ['call','email','in-person','text','call','email'];
  const outcomes = ['Interested','Needs Follow-Up','No Response','Left Voicemail','Ordered','Interested'];
  const regards  = ['purpl','lf','both','purpl','purpl','lf'];
  return Array.from({ length: count }, (_, i) => ({
    id: sid(),
    date: D(120 - i * 4),
    type: types[i % types.length],
    outcome: outcomes[i % outcomes.length],
    contact: i % 3 === 0 ? 'Owner' : i % 3 === 1 ? 'Store Manager' : 'Buyer',
    notes: `Outreach #${i + 1} for ${suffix}. Discussed summer pricing and case minimums.`,
    regarding: regards[i % regards.length],
    nextFollowUp: i === 0 ? D(-7) : '',
  }));
};

// ── ACCOUNTS (30) ────────────────────────────────────────────
const accounts = [

  // ── ac001 — Harvest Moon Co-op ───────────────────────────
  // active, both brands (isPbf:true), has token, all 4 cadence stages
  {
    id: 'ac001', name: 'Harvest Moon Co-op', status: 'active', isPbf: true,
    email: 'orders@harvestmoon.com', phone: '603-555-0101',
    address: '14 Mill St, Concord, NH 03301', type: 'Grocery',
    since: D(180), lastContacted: D(40),
    orderPortalToken: 'token-ac001', orderPortalTokenCreatedAt: D(100),
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Sarah Kimball', email: 'orders@harvestmoon.com', phone: '603-555-0101', isPrimary: true }],
    cadence: cad4(120),
    outreach: [
      oe(118, 'call',      'Interested',     'Sarah Kimball', 'Initial call — very enthusiastic about purpl. Wants to sample.', 'purpl'),
      oe(105, 'email',     'Ordered',        'Sarah Kimball', 'Sent welcome packet and invoice. They placed first order.', 'both'),
      oe(40,  'in-person', 'Interested',     'Sarah Kimball', 'Stopped by during delivery. Shelves look great, selling well.', 'both'),
    ],
    notes: [ne(118, 'Great fit — organic focus aligns well with our branding.'), ne(40, 'Reorder every 3-4 weeks.')],
    samples: [],
    par: { classic: 24, blueberry: 12, peach: 12 },
  },

  // ── ac002 — Green Valley Market ──────────────────────────
  // active, purpl-only (isPbf:false), has token, 3/5 cadence
  {
    id: 'ac002', name: 'Green Valley Market', status: 'active', isPbf: false,
    email: 'gvm@greenvalley.coop', phone: '802-555-0102',
    address: '88 River Rd, Burlington, VT 05401', type: 'Grocery',
    since: D(150), lastContacted: D(35),
    orderPortalToken: 'token-ac002', orderPortalTokenCreatedAt: D(90),
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Tom Archer', email: 'gvm@greenvalley.coop', phone: '802-555-0102', isPrimary: true }],
    cadence: cad3(110),
    outreach: [oe(108, 'email', 'Interested', 'Tom Archer', 'Responded to our wholesale inquiry. Very interested in classic + blueberry.', 'purpl')],
    notes: [ne(108, 'Prefers email communication. Orders in cases of 12.')],
    samples: [],
    par: { classic: 24, blueberry: 24 },
  },

  // ── ac003 — The Lavender Shop ─────────────────────────────
  // active, LF-only (isPbf:true), NO token, ZERO cadence — KEY OVERDUE TEST ACCOUNT
  {
    id: 'ac003', name: 'The Lavender Shop', status: 'active', isPbf: true,
    email: 'hello@thelavendershop.com', phone: '603-555-0103',
    address: '22 Blossom Ln, Peterborough, NH 03458', type: 'Specialty / Gift',
    since: D(14), lastContacted: '',
    orderPortalToken: null, orderPortalTokenCreatedAt: null,
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Mary Fontaine', email: 'hello@thelavendershop.com', phone: '603-555-0103', isPrimary: true }],
    cadence: [],
    outreach: [],
    notes: [],
    samples: [],
    par: {},
  },

  // ── ac004 — Blue Ridge Grocery ───────────────────────────
  // active, purpl-only (isPbf:false), no token, ZERO cadence, never contacted
  {
    id: 'ac004', name: 'Blue Ridge Grocery', status: 'active', isPbf: false,
    email: 'info@blueridgegrocery.com', phone: '207-555-0104',
    address: '45 Main St, Portland, ME 04101', type: 'Grocery',
    since: D(60), lastContacted: '',
    orderPortalToken: null, orderPortalTokenCreatedAt: null,
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Dan Proulx', email: 'info@blueridgegrocery.com', phone: '207-555-0104', isPrimary: true }],
    cadence: [],
    outreach: [],
    notes: [ne(60, 'Met at farmers market expo. Left business card.')],
    samples: [],
    par: {},
  },

  // ── ac005 — Sunrise Wellness ─────────────────────────────
  // active, both (isPbf:true), has token, all 4 cadence
  {
    id: 'ac005', name: 'Sunrise Wellness', status: 'active', isPbf: true,
    email: 'orders@sunrisewellness.net', phone: '603-555-0105',
    address: '7 Wellness Way, Keene, NH 03431', type: 'Spa / Wellness',
    since: D(160), lastContacted: D(30),
    orderPortalToken: 'token-ac005', orderPortalTokenCreatedAt: D(110),
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Claire Bouchard', email: 'orders@sunrisewellness.net', phone: '603-555-0105', isPrimary: true }],
    cadence: cad4(130),
    outreach: [oe(128, 'call', 'Interested', 'Claire Bouchard', 'Called about wholesale pricing. Very interested in LF spa products.', 'lf')],
    notes: [],
    samples: [],
    par: {},
  },

  // ── ac006 — Cedar Creek Farm ─────────────────────────────
  // paused, both (isPbf:true), has token, 2/5 cadence
  {
    id: 'ac006', name: 'Cedar Creek Farm', status: 'paused', isPbf: true,
    email: 'store@cedarcreekfarm.com', phone: '802-555-0106',
    address: '300 Creek Rd, Stowe, VT 05672', type: 'Farm / Country Store',
    since: D(200), lastContacted: D(90),
    orderPortalToken: 'token-ac006', orderPortalTokenCreatedAt: D(150),
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Jim Hebert', email: 'store@cedarcreekfarm.com', phone: '802-555-0106', isPrimary: true }],
    cadence: cad2(170),
    outreach: [oe(168, 'in-person', 'Interested', 'Jim Hebert', 'Farm store visit — great location, summer season focus.', 'both')],
    notes: [ne(90, 'Paused for winter — will reactivate in April.')],
    samples: [],
    par: {},
  },

  // ── ac007 — Willow Springs Spa ───────────────────────────
  // inactive, LF-only (isPbf:true), no token, 1 cadence entry
  {
    id: 'ac007', name: 'Willow Springs Spa', status: 'inactive', isPbf: true,
    email: 'info@willowsprings.spa', phone: '603-555-0107',
    address: '55 Spa Ln, Hanover, NH 03755', type: 'Spa / Wellness',
    since: D(300), lastContacted: D(200),
    orderPortalToken: null, orderPortalTokenCreatedAt: null,
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Nina Cross', email: 'info@willowsprings.spa', phone: '603-555-0107', isPrimary: true }],
    cadence: cad1(290),
    outreach: [oe(288, 'email', 'No Response', 'Nina Cross', 'Sent intro email, no reply.', 'lf')],
    notes: [],
    samples: [],
    par: {},
  },

  // ── ac008 — Pinebrook Deli ──────────────────────────────
  // active, purpl-only (isPbf:false), token, all 4 cadence, 5 outreach entries
  {
    id: 'ac008', name: 'Pinebrook Deli', status: 'active', isPbf: false,
    email: 'owner@pinebrookdeli.com', phone: '603-555-0108',
    address: '10 Pinebrook Rd, Manchester, NH 03101', type: 'Cafe / Coffee Shop',
    since: D(200), lastContacted: D(15),
    orderPortalToken: 'token-ac008', orderPortalTokenCreatedAt: D(140),
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Ray Pelletier', email: 'owner@pinebrookdeli.com', phone: '603-555-0108', isPrimary: true }],
    cadence: cad4(180),
    outreach: [
      oe(178, 'call',      'Interested',     'Ray Pelletier', 'Great first call. Wants classic and raspberry.', 'purpl'),
      oe(150, 'email',     'Ordered',        'Ray Pelletier', 'Placed first order — 2 cases classic, 1 case raspberry.', 'purpl'),
      oe(100, 'call',      'Ordered',        'Ray Pelletier', 'Reorder call. Moving well at the register.', 'purpl'),
      oe(60,  'in-person', 'Interested',     'Ray Pelletier', 'Stopped by. Display looks great. Asked about variety pack.', 'purpl'),
      oe(15,  'call',      'Ordered',        'Ray Pelletier', 'Phone order — 3 cases classic, 2 blueberry, 1 variety.', 'purpl'),
    ],
    notes: [ne(178, 'Best mover in Manchester area.'), ne(15, 'Considering adding a cooler display for summer.')],
    samples: [],
    par: { classic: 24, blueberry: 12, raspberry: 12, variety: 12 },
  },

  // ── ac009 — O'Brien & Sons "Local" Market ────────────────
  // active, both (isPbf:true), token, 2/5 cadence — special chars test
  {
    id: 'ac009', name: "O'Brien & Sons \"Local\" Market", status: 'active', isPbf: true,
    email: 'buy@obrienlocal.com', phone: '978-555-0109',
    address: '8 Market Sq, Lowell, MA 01852', type: 'Grocery',
    since: D(130), lastContacted: D(70),
    orderPortalToken: 'token-ac009', orderPortalTokenCreatedAt: D(100),
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: "Patrick O'Brien", email: 'buy@obrienlocal.com', phone: '978-555-0109', isPrimary: true }],
    cadence: cad2(120),
    outreach: [oe(118, 'call', 'Interested', "Patrick O'Brien", 'Good conversation about local sourcing. Likes our NH farm story.', 'both')],
    notes: [],
    samples: [],
    par: {},
  },

  // ── ac010 — No Email Store ───────────────────────────────
  // active, purpl-only (isPbf:false), no token, 0 cadence, NO email
  {
    id: 'ac010', name: 'No Email Store', status: 'active', isPbf: false,
    email: '', phone: '603-555-0110',
    address: '3 Old Rd, Newport, NH 03773', type: 'Specialty / Gift',
    since: D(50), lastContacted: '',
    orderPortalToken: null, orderPortalTokenCreatedAt: null,
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Liz Foss', email: '', phone: '603-555-0110', isPrimary: true }],
    cadence: [],
    outreach: [],
    notes: [ne(50, 'Phone-only contact. No email on file.')],
    samples: [],
    par: {},
  },

  // ── ac011 — Birchwood Co-op ──────────────────────────────
  // active, both (isPbf:true), token, all 4 cadence
  {
    id: 'ac011', name: 'Birchwood Co-op', status: 'active', isPbf: true,
    email: 'wholesale@birchwoodcoop.org', phone: '603-555-0111',
    address: '77 Birch Ave, Nashua, NH 03060', type: 'Grocery',
    since: D(170), lastContacted: D(25),
    orderPortalToken: 'token-ac011', orderPortalTokenCreatedAt: D(120),
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Greta Nilsson', email: 'wholesale@birchwoodcoop.org', phone: '603-555-0111', isPrimary: true }],
    cadence: cad4(145),
    outreach: [oe(143, 'email', 'Interested', 'Greta Nilsson', 'Replied immediately — co-op members love local products.', 'both')],
    notes: [],
    samples: [],
    par: { classic: 12, blueberry: 12 },
  },

  // ── ac012 — Autumn Ridge Bakery ─────────────────────────
  // active, purpl-only (isPbf:false), token, 3/5 cadence
  {
    id: 'ac012', name: 'Autumn Ridge Bakery', status: 'active', isPbf: false,
    email: 'cafe@autumnridge.com', phone: '603-555-0112',
    address: '2 Ridge Rd, Laconia, NH 03246', type: 'Cafe / Coffee Shop',
    since: D(140), lastContacted: D(45),
    orderPortalToken: 'token-ac012', orderPortalTokenCreatedAt: D(95),
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Brenda Marsh', email: 'cafe@autumnridge.com', phone: '603-555-0112', isPrimary: true }],
    cadence: cad3(125),
    outreach: [oe(123, 'call', 'Interested', 'Brenda Marsh', 'Sells canned beverages alongside baked goods. Perfect fit.', 'purpl')],
    notes: [],
    samples: [],
    par: { classic: 12, peach: 12 },
  },

  // ── ac013 — Heritage Farm Store ─────────────────────────
  // active, both (isPbf:true), token, all 4 cadence, isPbf:true (PBF direct)
  {
    id: 'ac013', name: 'Heritage Farm Store', status: 'active', isPbf: true,
    email: 'store@heritagefarms.com', phone: '603-555-0113',
    address: '101 Heritage Ln, Warner, NH 03278', type: 'Farm / Country Store',
    since: D(190), lastContacted: D(10),
    orderPortalToken: 'token-ac013', orderPortalTokenCreatedAt: D(140),
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Bob Steele', email: 'store@heritagefarms.com', phone: '603-555-0113', isPrimary: true }],
    cadence: cad4(160),
    outreach: [
      oe(158, 'in-person', 'Interested', 'Bob Steele', 'Neighbor farm — very excited about cross-promotion.', 'both'),
      oe(50,  'in-person', 'Ordered',    'Bob Steele', 'Dropped off restocking order in person.', 'both'),
    ],
    notes: [ne(10, 'Local pick-up only — no delivery needed.')],
    samples: [],
    par: { classic: 24, blueberry: 12, peach: 12 },
  },

  // ── ac014 — Meadowbrook Spa ──────────────────────────────
  // active, LF-only (isPbf:true), token, 3/5 cadence
  {
    id: 'ac014', name: 'Meadowbrook Spa', status: 'active', isPbf: true,
    email: 'orders@meadowbrookspa.com', phone: '603-555-0114',
    address: '50 Spa Circle, Plymouth, NH 03264', type: 'Spa / Wellness',
    since: D(155), lastContacted: D(50),
    orderPortalToken: 'token-ac014', orderPortalTokenCreatedAt: D(105),
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Helena Roy', email: 'orders@meadowbrookspa.com', phone: '603-555-0114', isPrimary: true }],
    cadence: cad3(135),
    outreach: [oe(133, 'email', 'Interested', 'Helena Roy', 'Looking for lavender retail products for spa boutique.', 'lf')],
    notes: [],
    samples: [],
    par: {},
  },

  // ── ac015 — Heavy Outreach Store ────────────────────────
  // active, purpl-only (isPbf:false), no token, 3/5 cadence, 25 outreach entries
  {
    id: 'ac015', name: 'Heavy Outreach Store', status: 'active', isPbf: false,
    email: 'buy@heavyoutreach.com', phone: '617-555-0115',
    address: '200 Comm Ave, Boston, MA 02134', type: 'Grocery',
    since: D(200), lastContacted: D(5),
    orderPortalToken: null, orderPortalTokenCreatedAt: null,
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Alex Dumont', email: 'buy@heavyoutreach.com', phone: '617-555-0115', isPrimary: true }],
    cadence: cad3(180),
    outreach: manyOutreach(25, 'ac015'),
    notes: [ne(180, 'Long sales cycle — busy buyer.')],
    samples: [],
    par: { classic: 12 },
  },

  // ── ac016 — Rolling Hills Farm Stand ────────────────────
  // active, both (isPbf:true), token, 4/5 cadence (missing first_order_followup)
  {
    id: 'ac016', name: 'Rolling Hills Farm Stand', status: 'active', isPbf: true,
    email: 'farm@rollinghills.farm', phone: '802-555-0116',
    address: '18 Hills Rd, Middlebury, VT 05753', type: 'Farm / Country Store',
    since: D(165), lastContacted: D(35),
    orderPortalToken: 'token-ac016', orderPortalTokenCreatedAt: D(115),
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Walt Girard', email: 'farm@rollinghills.farm', phone: '802-555-0116', isPrimary: true }],
    cadence: [
      ce('application_received', 150),
      ce('approved_welcome',     136),
      ce('invoice_sent',         115),
    ],
    outreach: [oe(148, 'in-person', 'Interested', 'Walt Girard', 'Farm visit — great seasonal location.', 'both')],
    notes: [],
    samples: [],
    par: {},
  },

  // ── ac017 — Morning Dew Cafe ─────────────────────────────
  // active, purpl-only (isPbf:false), no token, 0 cadence, never contacted
  {
    id: 'ac017', name: 'Morning Dew Cafe', status: 'active', isPbf: false,
    email: 'hello@morningdewcafe.com', phone: '603-555-0117',
    address: '3 Dew St, Claremont, NH 03743', type: 'Cafe / Coffee Shop',
    since: D(45), lastContacted: '',
    orderPortalToken: null, orderPortalTokenCreatedAt: null,
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Fiona Wells', email: 'hello@morningdewcafe.com', phone: '603-555-0117', isPrimary: true }],
    cadence: [],
    outreach: [],
    notes: [],
    samples: [],
    par: {},
  },

  // ── ac018 — Maple Grove Market ───────────────────────────
  // active, LF-only (isPbf:true), no token, 0 cadence, never contacted
  {
    id: 'ac018', name: 'Maple Grove Market', status: 'active', isPbf: true,
    email: 'info@maplegrovemarket.com', phone: '603-555-0118',
    address: '12 Grove St, Hillsborough, NH 03244', type: 'Specialty / Gift',
    since: D(30), lastContacted: '',
    orderPortalToken: null, orderPortalTokenCreatedAt: null,
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Cora Lemay', email: 'info@maplegrovemarket.com', phone: '603-555-0118', isPrimary: true }],
    cadence: [],
    outreach: [],
    notes: [],
    samples: [],
    par: {},
  },

  // ── ac019 — Clover Valley Farms (via distributor) ───────
  // active, purpl-only (isPbf:false), token, 3/5 cadence, fulfilledBy:dist001
  {
    id: 'ac019', name: 'Clover Valley Farms', status: 'active', isPbf: false,
    email: 'orders@clovervalley.com', phone: '603-555-0119',
    address: '95 Valley Rd, Franklin, NH 03235', type: 'Farm / Country Store',
    since: D(145), lastContacted: D(40),
    orderPortalToken: 'token-ac019', orderPortalTokenCreatedAt: D(100),
    fulfilledBy: 'dist001',
    contacts: [{ id: sid(), name: 'Marc Tessier', email: 'orders@clovervalley.com', phone: '603-555-0119', isPrimary: true }],
    cadence: cad3(130),
    outreach: [oe(128, 'call', 'Interested', 'Marc Tessier', 'Referred by New England Natural Foods rep.', 'purpl')],
    notes: [],
    samples: [],
    par: { classic: 24, raspberry: 12 },
  },

  // ── ac020 — Crystal Springs Wellness ────────────────────
  // paused, LF-only (isPbf:true), no token, 2 cadence
  {
    id: 'ac020', name: 'Crystal Springs Wellness', status: 'paused', isPbf: true,
    email: 'spa@crystalsprings.com', phone: '603-555-0120',
    address: '40 Springs Ave, Wolfeboro, NH 03894', type: 'Spa / Wellness',
    since: D(180), lastContacted: D(100),
    orderPortalToken: null, orderPortalTokenCreatedAt: null,
    fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Renee Gagne', email: 'spa@crystalsprings.com', phone: '603-555-0120', isPrimary: true }],
    cadence: cad2(165),
    outreach: [oe(163, 'email', 'Needs Follow-Up', 'Renee Gagne', 'Interested but renovating — follow up in spring.', 'lf')],
    notes: [ne(100, 'Paused — remodeling spa. Check back May 2026.')],
    samples: [],
    par: {},
  },

  // ── ac021–ac030: supporting cast accounts ────────────────
  // NOTE: ac019 (dist001) and ac026 (dist001) are already distributor-served.
  {
    id: 'ac021', name: 'Stonecroft Grocery', status: 'inactive', isPbf: false,
    email: 'info@stonecroft.com', phone: '603-555-0121', address: '5 Stone St, Milford, NH 03055',
    type: 'Grocery', since: D(250), lastContacted: D(180),
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Ed Moreau', email: 'info@stonecroft.com', phone: '603-555-0121', isPrimary: true }],
    cadence: cad1(240), outreach: [], notes: [], samples: [], par: {},
  },
  {
    id: 'ac022', name: 'Foxglove Garden Center', status: 'active', isPbf: false,
    email: 'shop@foxglove.com', phone: '603-555-0122', address: '20 Garden Way, Derry, NH 03038',
    type: 'Specialty / Gift', since: D(80), lastContacted: '',
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Iris Tang', email: 'shop@foxglove.com', phone: '603-555-0122', isPrimary: true }],
    cadence: [], outreach: [], notes: [], samples: [], par: {},
  },
  {
    id: 'ac023', name: 'Pinecrest Market', status: 'active', isPbf: true,
    email: 'orders@pinecrest.market', phone: '603-555-0123', address: '8 Crest Rd, Exeter, NH 03833',
    type: 'Grocery', since: D(175), lastContacted: D(20),
    orderPortalToken: 'token-ac023', orderPortalTokenCreatedAt: D(125), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Amy Liu', email: 'orders@pinecrest.market', phone: '603-555-0123', isPrimary: true }],
    cadence: cad4(155), outreach: [], notes: [], samples: [], par: { classic: 12 },
  },
  {
    id: 'ac024', name: 'Cliffside Provisions', status: 'active', isPbf: false,
    email: 'hello@cliffsideprov.com', phone: '207-555-0124', address: '33 Cliff Rd, Bar Harbor, ME 04609',
    type: 'Specialty / Gift', since: D(120), lastContacted: D(60),
    orderPortalToken: 'token-ac024', orderPortalTokenCreatedAt: D(80), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Nora Flynn', email: 'hello@cliffsideprov.com', phone: '207-555-0124', isPrimary: true }],
    cadence: cad3(105), outreach: [], notes: [], samples: [], par: { classic: 12, peach: 12 },
  },
  {
    id: 'ac025', name: 'Brookside Natural Foods', status: 'active', isPbf: true,
    email: 'buy@brooksidenaturals.com', phone: '603-555-0125', address: '67 Brook St, Dover, NH 03820',
    type: 'Grocery', since: D(135), lastContacted: D(55),
    orderPortalToken: 'token-ac025', orderPortalTokenCreatedAt: D(90), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Sam Okafor', email: 'buy@brooksidenaturals.com', phone: '603-555-0125', isPrimary: true }],
    cadence: cad4(120), outreach: [], notes: [], samples: [], par: {},
  },
  {
    id: 'ac026', name: 'Riverbank Cafe', status: 'active', isPbf: false,
    email: 'info@riverbankcafe.com', phone: '603-555-0126', address: '14 River Rd, Concord, NH 03301',
    type: 'Cafe / Coffee Shop', since: D(110), lastContacted: D(50),
    orderPortalToken: 'token-ac026', orderPortalTokenCreatedAt: D(75), fulfilledBy: 'dist001',
    contacts: [{ id: sid(), name: 'Tara Moody', email: 'info@riverbankcafe.com', phone: '603-555-0126', isPrimary: true }],
    cadence: cad3(95), outreach: [], notes: [], samples: [], par: { classic: 24 },
  },
  {
    id: 'ac027', name: 'Skyline Farm Market', status: 'paused', isPbf: true,
    email: 'farm@skylinefarm.net', phone: '802-555-0127', address: '88 Sky Hill Rd, Brattleboro, VT 05301',
    type: 'Farm / Country Store', since: D(220), lastContacted: D(130),
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Carl Boutin', email: 'farm@skylinefarm.net', phone: '802-555-0127', isPrimary: true }],
    cadence: cad2(200), outreach: [], notes: [], samples: [], par: {},
  },
  {
    id: 'ac028', name: 'Harbor Light Market', status: 'active', isPbf: false,
    email: 'orders@harborlightmkt.com', phone: '207-555-0128', address: '9 Harbor St, Rockland, ME 04841',
    type: 'Grocery', since: D(160), lastContacted: D(70),
    orderPortalToken: 'token-ac028', orderPortalTokenCreatedAt: D(110), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Phil Cyr', email: 'orders@harborlightmkt.com', phone: '207-555-0128', isPrimary: true }],
    cadence: cad4(140), outreach: [], notes: [], samples: [], par: { classic: 12, blueberry: 12 },
  },
  {
    id: 'ac029', name: 'Fern Valley Co-op', status: 'active', isPbf: true,
    email: 'wholesale@fernvalley.org', phone: '603-555-0129', address: '24 Fern Way, Lebanon, NH 03766',
    type: 'Grocery', since: D(145), lastContacted: D(30),
    orderPortalToken: 'token-ac029', orderPortalTokenCreatedAt: D(100), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Diana Cross', email: 'wholesale@fernvalley.org', phone: '603-555-0129', isPrimary: true }],
    cadence: cad4(130), outreach: [], notes: [], samples: [], par: {},
  },
  {
    id: 'ac030', name: 'Thornwood Apothecary', status: 'active', isPbf: true,
    email: 'buy@thornwoodapo.com', phone: '603-555-0130', address: '6 Thorn St, Keene, NH 03431',
    type: 'Specialty / Gift', since: D(95), lastContacted: D(40),
    orderPortalToken: 'token-ac030', orderPortalTokenCreatedAt: D(65), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Vera Swan', email: 'buy@thornwoodapo.com', phone: '603-555-0130', isPrimary: true }],
    cadence: cad3(80), outreach: [], notes: [], samples: [], par: {},
  },

  // ── ac031–ac035: isPbf:true LF Wholesale direct accounts ─
  {
    id: 'ac031', name: 'Green Leaf Spa', status: 'active', isPbf: true,
    email: 'orders@greenleafspa.com', phone: '603-555-0131',
    address: '15 Spa Way, Exeter, NH 03833', type: 'Spa / Wellness',
    since: D(185), lastContacted: D(22),
    orderPortalToken: 'token-ac031', orderPortalTokenCreatedAt: D(130), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Pam Leary', email: 'orders@greenleafspa.com', phone: '603-555-0131', isPrimary: true }],
    cadence: cad3(165), outreach: [oe(163, 'email', 'Interested', 'Pam Leary', 'LF wholesale — spa retail section.', 'lf')],
    notes: [], samples: [], par: {},
  },
  {
    id: 'ac032', name: 'Lavender Lane Gift Shop', status: 'active', isPbf: true,
    email: 'hello@lavenderlane.com', phone: '603-555-0132',
    address: '8 Lane St, Wolfeboro, NH 03894', type: 'Specialty / Gift',
    since: D(170), lastContacted: D(18),
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Ruth Elkins', email: 'hello@lavenderlane.com', phone: '603-555-0132', isPrimary: true }],
    cadence: cad2(150), outreach: [oe(148, 'in-person', 'Interested', 'Ruth Elkins', 'Gift shop exclusively focused on lavender products.', 'lf')],
    notes: [], samples: [], par: {},
  },
  {
    id: 'ac033', name: 'Wellspring Wellness Center', status: 'active', isPbf: true,
    email: 'buy@wellspringctr.com', phone: '603-555-0133',
    address: '30 Spring Rd, Laconia, NH 03246', type: 'Spa / Wellness',
    since: D(140), lastContacted: D(35),
    orderPortalToken: 'token-ac033', orderPortalTokenCreatedAt: D(100), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Donna Hebert', email: 'buy@wellspringctr.com', phone: '603-555-0133', isPrimary: true }],
    cadence: cad4(125), outreach: [oe(123, 'call', 'Ordered', 'Donna Hebert', 'Wellness center — stocks LF roll-on and candles.', 'lf')],
    notes: [], samples: [], par: {},
  },
  {
    id: 'ac034', name: 'Blossom & Bloom Boutique', status: 'active', isPbf: true,
    email: 'info@blossombloomboutique.com', phone: '603-555-0134',
    address: '4 Garden St, Meredith, NH 03253', type: 'Specialty / Gift',
    since: D(200), lastContacted: '',   // overdue follow-up
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Lily Forrest', email: 'info@blossombloomboutique.com', phone: '603-555-0134', isPrimary: true }],
    cadence: cad1(185),
    outreach: [oe(183, 'email', 'Interested', 'Lily Forrest', 'Interested in full LF line for boutique.', 'lf')],
    notes: [ne(183, 'Strong LF fit — needs follow-up after initial interest.')], samples: [], par: {},
  },
  {
    id: 'ac035', name: 'The Herbal Haven', status: 'active', isPbf: true,
    email: 'orders@theherbalhaven.com', phone: '802-555-0135',
    address: '22 Herb Row, Burlington, VT 05401', type: 'Specialty / Gift',
    since: D(160), lastContacted: D(28),
    orderPortalToken: 'token-ac035', orderPortalTokenCreatedAt: D(110), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Sage Ellison', email: 'orders@theherbalhaven.com', phone: '802-555-0135', isPrimary: true }],
    cadence: cad3(145), outreach: [oe(143, 'call', 'Ordered', 'Sage Ellison', 'Herbal / apothecary shop — loves the LF brand story.', 'lf')],
    notes: [], samples: [], par: {},
  },

  // ── ac036–ac042: additional direct accounts ──────────────
  {
    id: 'ac036', name: 'Summit Sports & Cafe', status: 'active', isPbf: false,
    email: 'cafe@summitsports.com', phone: '603-555-0136',
    address: '11 Summit Dr, North Conway, NH 03860', type: 'Cafe / Coffee Shop',
    since: D(120), lastContacted: D(55),
    orderPortalToken: 'token-ac036', orderPortalTokenCreatedAt: D(80), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Jake Moreau', email: 'cafe@summitsports.com', phone: '603-555-0136', isPrimary: true }],
    cadence: cad3(105), outreach: [], notes: [], samples: [], par: { classic: 12, raspberry: 12 },
  },
  {
    id: 'ac037', name: 'Millbrook Market', status: 'active', isPbf: false,
    email: 'info@millbrookmkt.com', phone: '603-555-0137',
    address: '5 Mill Rd, Hillsborough, NH 03244', type: 'Grocery',
    since: D(95), lastContacted: '',   // overdue follow-up
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Rosa Diaz', email: 'info@millbrookmkt.com', phone: '603-555-0137', isPrimary: true }],
    cadence: [], outreach: [], notes: [], samples: [], par: {},
  },
  {
    id: 'ac038', name: 'Granite State Co-op', status: 'active', isPbf: true,
    email: 'wholesale@granitecoop.org', phone: '603-555-0138',
    address: '66 Main St, Concord, NH 03301', type: 'Grocery',
    since: D(175), lastContacted: D(12),
    orderPortalToken: 'token-ac038', orderPortalTokenCreatedAt: D(120), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Owen Burke', email: 'wholesale@granitecoop.org', phone: '603-555-0138', isPrimary: true }],
    cadence: cad4(155), outreach: [], notes: [], samples: [], par: { classic: 24, blueberry: 12 },
  },
  {
    id: 'ac039', name: 'Seacoast Natural Foods', status: 'active', isPbf: true,
    email: 'buy@seacoastnaturals.com', phone: '603-555-0139',
    address: '14 Ocean Ave, Portsmouth, NH 03801', type: 'Grocery',
    since: D(145), lastContacted: D(40),
    orderPortalToken: 'token-ac039', orderPortalTokenCreatedAt: D(95), fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Clara Vance', email: 'buy@seacoastnaturals.com', phone: '603-555-0139', isPrimary: true }],
    cadence: cad3(130), outreach: [], notes: [], samples: [], par: { classic: 12 },
  },
  {
    id: 'ac040', name: 'The Corner Store', status: 'active', isPbf: false,
    email: 'store@thecornernh.com', phone: '603-555-0140',
    address: '3 Corner Rd, Bradford, NH 03221', type: 'Specialty / Gift',
    since: D(55), lastContacted: '',   // overdue follow-up — new account, never contacted
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Pete Labrie', email: 'store@thecornernh.com', phone: '603-555-0140', isPrimary: true }],
    cadence: [], outreach: [], notes: [ne(55, 'Small general store, good foot traffic. Follow up.')], samples: [], par: {},
  },
  {
    id: 'ac041', name: 'Hilltop Country Store', status: 'active', isPbf: false,
    email: 'orders@hilltopcountry.com', phone: '603-555-0141',
    address: '99 Hilltop Rd, Deering, NH 03244', type: 'Farm / Country Store',
    since: D(80), lastContacted: D(50),  // overdue
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Earl Doucette', email: 'orders@hilltopcountry.com', phone: '603-555-0141', isPrimary: true }],
    cadence: cad1(70), outreach: [oe(68, 'call', 'Interested', 'Earl Doucette', 'Country store with strong beverage section.', 'purpl')],
    notes: [], samples: [], par: {},
  },
  {
    id: 'ac042', name: 'Valley Fresh Market', status: 'active', isPbf: false,
    email: 'fresh@valleyfreshnh.com', phone: '603-555-0142',
    address: '7 Valley Blvd, Henniker, NH 03242', type: 'Grocery',
    since: D(65), lastContacted: D(45),  // overdue
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'direct',
    contacts: [{ id: sid(), name: 'Nick Cormier', email: 'fresh@valleyfreshnh.com', phone: '603-555-0142', isPrimary: true }],
    cadence: cad1(60), outreach: [], notes: [], samples: [], par: {},
  },

  // ── ac043–ac050: distributor-served accounts ─────────────
  {
    id: 'ac043', name: 'White Mountain Grocery', status: 'active', isPbf: false,
    email: 'orders@whitemtngrocery.com', phone: '603-555-0143',
    address: '20 Mountain Rd, Plymouth, NH 03264', type: 'Grocery',
    since: D(130), lastContacted: D(30),
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'dist001',
    contacts: [{ id: sid(), name: 'Ann Brodeur', email: 'orders@whitemtngrocery.com', phone: '603-555-0143', isPrimary: true }],
    cadence: cad2(115), outreach: [], notes: [], samples: [], par: { classic: 24 },
  },
  {
    id: 'ac044', name: 'Lakes Region Market', status: 'active', isPbf: false,
    email: 'buy@lakesregionmkt.com', phone: '603-555-0144',
    address: '88 Lakeshore Dr, Laconia, NH 03246', type: 'Grocery',
    since: D(110), lastContacted: D(25),
    orderPortalToken: 'token-ac044', orderPortalTokenCreatedAt: D(75), fulfilledBy: 'dist001',
    contacts: [{ id: sid(), name: 'Greg Fontaine', email: 'buy@lakesregionmkt.com', phone: '603-555-0144', isPrimary: true }],
    cadence: cad3(95), outreach: [], notes: [], samples: [], par: { classic: 12, blueberry: 12 },
  },
  {
    id: 'ac045', name: 'Monadnock Co-op', status: 'active', isPbf: true,
    email: 'wholesale@monadnockcoop.org', phone: '603-555-0145',
    address: '34 Co-op Way, Keene, NH 03431', type: 'Grocery',
    since: D(155), lastContacted: D(20),
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'dist001',
    contacts: [{ id: sid(), name: 'Iris Pelerin', email: 'wholesale@monadnockcoop.org', phone: '603-555-0145', isPrimary: true }],
    cadence: cad3(140), outreach: [], notes: [], samples: [], par: {},
  },
  {
    id: 'ac046', name: 'Pioneer Valley Foods', status: 'active', isPbf: false,
    email: 'orders@pioneervalleyfoods.com', phone: '413-555-0146',
    address: '100 Pioneer Rd, Northampton, MA 01060', type: 'Grocery',
    since: D(120), lastContacted: D(35),
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'dist002',
    contacts: [{ id: sid(), name: 'Steve Marchand', email: 'orders@pioneervalleyfoods.com', phone: '413-555-0146', isPrimary: true }],
    cadence: cad2(105), outreach: [], notes: [], samples: [], par: { classic: 24, raspberry: 12 },
  },
  {
    id: 'ac047', name: 'Bay State Grocery', status: 'active', isPbf: false,
    email: 'buy@baystate.market', phone: '617-555-0147',
    address: '55 Bay Rd, Newton, MA 02459', type: 'Grocery',
    since: D(135), lastContacted: D(28),
    orderPortalToken: 'token-ac047', orderPortalTokenCreatedAt: D(90), fulfilledBy: 'dist002',
    contacts: [{ id: sid(), name: 'Tina Rhodes', email: 'buy@baystate.market', phone: '617-555-0147', isPrimary: true }],
    cadence: cad3(120), outreach: [], notes: [], samples: [], par: { classic: 12 },
  },
  {
    id: 'ac048', name: 'Cape Ann Natural Foods', status: 'active', isPbf: true,
    email: 'orders@capeannnaturals.com', phone: '978-555-0148',
    address: '12 Harbor St, Gloucester, MA 01930', type: 'Grocery',
    since: D(100), lastContacted: D(42),  // borderline overdue
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'dist002',
    contacts: [{ id: sid(), name: 'Joel Landry', email: 'orders@capeannnaturals.com', phone: '978-555-0148', isPrimary: true }],
    cadence: cad2(88), outreach: [], notes: [], samples: [], par: {},
  },
  {
    id: 'ac049', name: 'Upper Valley Co-op', status: 'active', isPbf: true,
    email: 'wholesale@uppervalleycoop.org', phone: '802-555-0149',
    address: '77 River Rd, White River Junction, VT 05001', type: 'Grocery',
    since: D(160), lastContacted: D(15),
    orderPortalToken: 'token-ac049', orderPortalTokenCreatedAt: D(110), fulfilledBy: 'dist001',
    contacts: [{ id: sid(), name: 'Molly Tremblay', email: 'wholesale@uppervalleycoop.org', phone: '802-555-0149', isPrimary: true }],
    cadence: cad4(140), outreach: [], notes: [], samples: [], par: { classic: 12, blueberry: 12 },
  },
  {
    id: 'ac050', name: 'North Shore Provisions', status: 'active', isPbf: false,
    email: 'orders@northshoreprov.com', phone: '978-555-0150',
    address: '9 Shore Rd, Newburyport, MA 01950', type: 'Specialty / Gift',
    since: D(90), lastContacted: D(45),  // overdue
    orderPortalToken: null, orderPortalTokenCreatedAt: null, fulfilledBy: 'dist002',
    contacts: [{ id: sid(), name: 'Chris Audet', email: 'orders@northshoreprov.com', phone: '978-555-0150', isPrimary: true }],
    cadence: cad2(78), outreach: [], notes: [], samples: [], par: {},
  },
];

// =============================================================
//  PROSPECTS (12)
// =============================================================
const prospects = [
  {
    id: 'pr001', name: 'Sunrise Boutique', contact: 'Amy Rand', email: 'amy@sunriseboutique.com',
    phone: '603-555-1001', address: 'Portsmouth, NH', type: 'Specialty / Gift',
    status: 'lead', priority: 'medium', isPbf: false,
    notes: [], outreach: [], samples: [], lastContact: '', since: D(30),
  },
  {
    id: 'pr002', name: 'Valley View Grocery', contact: 'Leo Garneau', email: 'leo@valleyview.com',
    phone: '802-555-1002', address: 'Montpelier, VT', type: 'Grocery',
    status: 'contacted', priority: 'high', isPbf: false,
    notes: [ne(25, 'Good fit — local grocery looking to add NH brands.')],
    outreach: [
      oe(27, 'email', 'Interested',     'Leo Garneau', 'Sent intro email with pricing sheet.', 'purpl'),
      oe(20, 'call',  'Needs Follow-Up','Leo Garneau', 'Called — needs to run by owner first.', 'purpl'),
    ],
    samples: [], lastContact: D(20), since: D(40),
  },
  {
    id: 'pr003', name: 'Mountain Spring Market', contact: 'Jen Fortin', email: 'jen@mtspring.com',
    phone: '603-555-1003', address: 'North Conway, NH', type: 'Grocery',
    status: 'sampling', priority: 'high', isPbf: true,
    notes: [ne(15, 'Tourist-heavy area — great seasonal volume potential.')],
    outreach: [oe(18, 'call', 'Interested', 'Jen Fortin', 'Very interested in both lines. Sending samples.', 'both')],
    samples: [{
      id: sid(), date: D(14), flavors: 'Classic, Blueberry', notes: 'Sent 2 of each flavor',
      followUpDate: D(-3), followUpDone: false,
    }],
    lastContact: D(14), since: D(60),
  },
  {
    id: 'pr004', name: 'Harbor View Cafe', contact: 'Dean Cote', email: 'dean@harborviewcafe.com',
    phone: '207-555-1004', address: 'Camden, ME', type: 'Cafe / Coffee Shop',
    status: 'negotiating', priority: 'high', isPbf: true,
    notes: [ne(10, 'Close to a deal — working out minimum order qty.')],
    outreach: [
      oe(35, 'email',  'Interested',     'Dean Cote', 'Sent wholesale packet.', 'lf'),
      oe(25, 'call',   'Interested',     'Dean Cote', 'Follow-up call — wants LF spa products.', 'lf'),
      oe(10, 'email',  'Needs Follow-Up','Dean Cote', 'Sent revised pricing. Waiting on decision.', 'lf'),
    ],
    samples: [], lastContact: D(10), since: D(50),
  },
  {
    id: 'pr005', name: 'Lighthouse Farm Stand', contact: 'Carol Trent', email: 'carol@lighthousefarm.com',
    phone: '207-555-1005', address: 'Kennebunkport, ME', type: 'Farm / Country Store',
    status: 'won', priority: 'high', isPbf: true,
    notes: [ne(5, 'Won! Converting to active account.')],
    outreach: [oe(20, 'in-person', 'Ordered', 'Carol Trent', 'Farm visit — signed up on the spot.', 'both')],
    samples: [], lastContact: D(5), since: D(45),
  },
  {
    id: 'pr006', name: 'Rocky Mountain Spa', contact: 'Greg Plante', email: 'greg@rockymtnspa.com',
    phone: '603-555-1006', address: 'Lincoln, NH', type: 'Spa / Wellness',
    status: 'lost', priority: 'low', isPbf: false,
    lostReason: 'No response', lostAt: D(30),
    notes: [],
    outreach: [
      oe(60, 'email', 'No Response', 'Greg Plante', 'Sent intro — no reply.', 'purpl'),
      oe(45, 'call',  'No Response', 'Greg Plante', 'Left voicemail — no callback.', 'purpl'),
    ],
    samples: [], lastContact: D(45), since: D(75),
  },
  {
    id: 'pr007', name: 'Desert Bloom Wellness', contact: 'Kate Rioux', email: 'kate@desertbloom.com',
    phone: '603-555-1007', address: 'Concord, NH', type: 'Spa / Wellness',
    status: 'lost', priority: 'medium', isPbf: true,
    lostReason: 'Price too high', lostAt: D(20),
    notes: [ne(20, 'Price point too high for their budget.')],
    outreach: [
      oe(50, 'call',  'Interested',    'Kate Rioux', 'Great call — interested in LF products.', 'lf'),
      oe(22, 'email', 'Not Interested', 'Kate Rioux', 'Replied — cost per unit too high vs. current vendor.', 'lf'),
    ],
    samples: [], lastContact: D(20), since: D(65),
  },
  {
    id: 'pr008', name: 'Forest Edge Co-op', contact: 'Ben Lavoie', email: 'ben@forestedge.org',
    phone: '603-555-1008', address: 'Amherst, NH', type: 'Grocery',
    status: 'lead', priority: 'medium', isPbf: true,
    notes: [],
    outreach: [],
    samples: [{
      id: sid(), date: D(21), flavors: 'Classic, Peach, LF Scrunchie',
      notes: 'Multi-product sample pack sent',
      followUpDate: D(7), followUpDone: false,   // follow-up was 7 days ago — overdue
    }],
    lastContact: D(21), since: D(35),
  },
  {
    id: 'pr009', name: 'Riverbend Market', contact: 'Sue Nadeau', email: 'sue@riverbendmkt.com',
    phone: '603-555-1009', address: 'Rochester, NH', type: 'Grocery',
    status: 'contacted', priority: 'high', isPbf: false,
    notes: [],
    outreach: [oe(12, 'call', 'Interested', 'Sue Nadeau', 'Warm call — they stock several local NH beverages.', 'purpl')],
    samples: [], lastContact: D(12), since: D(20),
  },
  {
    id: 'pr010', name: 'Blue Sky Deli', contact: 'Vince Auger', email: 'vince@blueskydeli.com',
    phone: '603-555-1010', address: 'Jaffrey, NH', type: 'Cafe / Coffee Shop',
    status: 'sampling', priority: 'medium', isPbf: true,
    notes: [],
    outreach: [oe(18, 'email', 'Interested', 'Vince Auger', 'Interested in LF products for gift section.', 'lf')],
    samples: [{
      id: sid(), date: D(10), flavors: 'LF Candle, LF Syrup',
      notes: 'Two LF items sent for evaluation', followUpDate: D(-5), followUpDone: false,
    }],
    lastContact: D(10), since: D(30),
  },
  {
    id: 'pr011', name: 'Golden Valley Farm', contact: 'Hal Petit', email: 'hal@goldenvalley.farm',
    phone: '802-555-1011', address: 'Woodstock, VT', type: 'Farm / Country Store',
    status: 'lead', priority: 'low', isPbf: true,
    notes: [
      ne(40, 'Beautiful farm store — met at local farm bureau meeting.'),
      ne(20, 'Sent email follow-up, no reply yet.'),
    ],
    outreach: [], samples: [], lastContact: D(20), since: D(50),
  },
  {
    id: 'pr012', name: 'Cliffside Gallery', contact: 'Mira Chase', email: 'mira@cliffsidegallery.com',
    phone: '207-555-1012', address: 'Ogunquit, ME', type: 'Specialty / Gift',
    status: 'contacted', priority: 'medium', isPbf: true,
    notes: [
      ne(30, 'Art gallery with gift shop — loves the aesthetic of our packaging.'),
      ne(22, 'Sent wholesale catalog.'),
      ne(15, 'Followed up by phone — will present to owner next week.'),
    ],
    outreach: [oe(16, 'call', 'Needs Follow-Up', 'Mira Chase', 'Spoke with Mira — owner makes final call.', 'both')],
    samples: [], lastContact: D(16), since: D(40),
  },

  // ── pr013–pr020: additional prospects ───────────────────────
  {
    id: 'pr013', name: 'Serenity Spa & Boutique', contact: 'Rachel Morin', email: 'rachel@serenityspa.vt',
    phone: '802-555-1013', address: 'Burlington, VT', type: 'Spa / Wellness',
    status: 'lead', priority: 'low', isPbf: true,
    notes: [ne(10, 'Found them at VT Farmers Market. Asked us to follow up in spring.')],
    outreach: [], samples: [], lastContact: D(10), since: D(20),
  },
  {
    id: 'pr014', name: 'Millstone Natural Market', contact: 'Pete Gagnon', email: 'pete@millstonenatural.com',
    phone: '603-555-1014', address: 'Lebanon, NH', type: 'Grocery',
    status: 'contacted', priority: 'high', isPbf: false,
    notes: [ne(22, 'Strong local-brand buyer. Stocks other NH beverages.')],
    outreach: [
      oe(25, 'email', 'Interested',      'Pete Gagnon', 'Cold email — responded within hours. Wants pricing sheet.', 'purpl'),
      oe(18, 'call',  'Needs Follow-Up', 'Pete Gagnon', 'Good call — waiting for owner approval on new vendors.', 'purpl'),
      oe(8,  'email', 'No Response',     'Pete Gagnon', 'Sent follow-up email with case pricing. No reply yet.', 'purpl'),
    ],
    samples: [], lastContact: D(8), since: D(35),
  },
  {
    id: 'pr015', name: 'Kettle Pond Farm Store', contact: 'Lynn Arsenault', email: 'lynn@kettlepondfarm.com',
    phone: '802-555-1015', address: 'Groton, VT', type: 'Farm / Country Store',
    status: 'sampling', priority: 'high', isPbf: true,
    notes: [ne(30, 'Beautiful roadside farm store — heavy tourist traffic May–Oct.')],
    outreach: [
      oe(32, 'in-person', 'Interested',  'Lynn Arsenault', 'Farm visit — loved the branding. Wants to try both lines.', 'both'),
      oe(20, 'email',     'Interested',  'Lynn Arsenault', 'Confirmed sample shipment incoming.', 'both'),
    ],
    samples: [{
      id: sid(), date: D(18), flavors: 'Classic, Blueberry, LF Scrunchie, LF Candle',
      notes: 'Full sample assortment', followUpDate: D(-2), followUpDone: false,
    }],
    lastContact: D(18), since: D(45),
  },
  {
    id: 'pr016', name: 'Trailhead Brew & Cafe', contact: 'Sam Bouley', email: 'sam@trailheadcafe.com',
    phone: '603-555-1016', address: 'Lincoln, NH', type: 'Cafe / Coffee Shop',
    status: 'negotiating', priority: 'medium', isPbf: false,
    notes: [ne(12, 'Trail-side cafe — big volume in ski season. MOQ is the sticking point.')],
    outreach: [
      oe(45, 'call',  'Interested',     'Sam Bouley', 'Inbound call — saw us at trail expo.', 'purpl'),
      oe(30, 'email', 'Interested',     'Sam Bouley', 'Sent wholesale pack and pricing.', 'purpl'),
      oe(12, 'call',  'Needs Follow-Up','Sam Bouley', 'Price OK but wants 6-case MOQ instead of 12.', 'purpl'),
    ],
    samples: [], lastContact: D(12), since: D(55),
  },
  {
    id: 'pr017', name: 'Granite Peak Co-op', contact: 'Dana Moreau', email: 'dana@granitepeakcoop.org',
    phone: '603-555-1017', address: 'Plymouth, NH', type: 'Grocery',
    status: 'won', priority: 'high', isPbf: true,
    notes: [ne(3, 'Won! Converting to active account this week.')],
    outreach: [
      oe(55, 'email',     'Interested',  'Dana Moreau', 'Reached out after seeing us at trade show.', 'both'),
      oe(40, 'call',      'Interested',  'Dana Moreau', 'Long call — very excited about both lines.', 'both'),
      oe(20, 'in-person', 'Ordered',     'Dana Moreau', 'Site visit — placed opening order on the spot.', 'both'),
      oe(3,  'email',     'Ordered',     'Dana Moreau', 'Confirmed terms — net-30, 12-case MOQ.', 'both'),
    ],
    samples: [], lastContact: D(3), since: D(60),
  },
  {
    id: 'pr018', name: 'Blue Harbor Gift Co.', contact: 'Fran Tardif', email: 'fran@blueharborg.com',
    phone: '207-555-1018', address: 'Bar Harbor, ME', type: 'Specialty / Gift',
    status: 'lost', priority: 'medium', isPbf: true,
    lostReason: 'Went with competitor', lostAt: D(25),
    notes: [ne(25, 'Chose a competing local brand — already locked in for the season.')],
    outreach: [
      oe(60, 'email', 'Interested',    'Fran Tardif', 'Cold email — expressed interest in summer placement.', 'both'),
      oe(45, 'call',  'Interested',    'Fran Tardif', 'Good call — likes the LF line especially.', 'lf'),
      oe(25, 'email', 'Not Interested','Fran Tardif', 'Replied — committed to another vendor this season.', 'both'),
    ],
    samples: [], lastContact: D(25), since: D(70),
  },
  {
    id: 'pr019', name: 'Iron Mountain Yoga', contact: 'Bev Cayer', email: 'bev@ironmtnyoga.com',
    phone: '603-555-1019', address: 'Nashua, NH', type: 'Spa / Wellness',
    status: 'contacted', priority: 'high', isPbf: true,
    notes: [ne(9, 'Yoga studio with retail shelf — very interested in LF self-care line.')],
    outreach: [
      oe(14, 'email', 'Interested',      'Bev Cayer', 'Replied to our intro email — wants wholesale catalog.', 'lf'),
      oe(9,  'call',  'Needs Follow-Up', 'Bev Cayer', 'Spoke with Bev — needs to see sell-through on samples first.', 'lf'),
    ],
    samples: [{
      id: sid(), date: D(8), flavors: 'LF Roll-On, LF Linen Spray, LF Bath Salts',
      notes: 'LF wellness sample set', followUpDate: D(-7), followUpDone: false,
    }],
    lastContact: D(8), since: D(25),
  },
  {
    id: 'pr020', name: 'Riverside Natural Goods', contact: 'Cal Charest', email: 'cal@riversidenaturalgoods.com',
    phone: '802-555-1020', address: 'Brattleboro, VT', type: 'Grocery',
    status: 'lead', priority: 'medium', isPbf: false,
    notes: [ne(5, 'Met at Brattleboro Farmers Market. Has 3 stores — big opportunity if we land it.')],
    outreach: [], samples: [], lastContact: D(5), since: D(10),
  },
];

// =============================================================
//  PURPL INVOICES (18)
// =============================================================
const iv = [
  // ac001 — 2 invoices (iv001 used in ci001)
  { id:'iv001', number:'PBF-001', accountId:'ac001', accountName:'Harvest Moon Co-op',
    issued:D(100), due:D(70), amount:432.00, status:'paid',
    lineItems:[
      {id:sid(),sku:'classic',   qty:144,cases:12,unitPrice:2.50,total:360.00,description:'Classic 12-pk'},
      {id:sid(),sku:'blueberry', qty:72, cases:6, unitPrice:2.50,total:180.00,description:'Blueberry 12-pk'},
    ],
    notes:'First order — paid via check.', combinedInvoiceId:'ci001' },

  { id:'iv002', number:'PBF-002', accountId:'ac001', accountName:'Harvest Moon Co-op',
    issued:D(45), due:D(15), amount:216.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'classic',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'}],
    notes:'', combinedInvoiceId:null },

  // ac002 — 1 invoice (iv003 used in ci002)
  { id:'iv003', number:'PBF-003', accountId:'ac002', accountName:'Green Valley Market',
    issued:D(80), due:D(50), amount:288.00, status:'unpaid',
    lineItems:[
      {id:sid(),sku:'classic',  qty:96,cases:8,unitPrice:2.50,total:240.00,description:'Classic 12-pk'},
      {id:sid(),sku:'blueberry',qty:48,cases:4,unitPrice:2.50,total:120.00,description:'Blueberry 12-pk'},
    ],
    notes:'', combinedInvoiceId:'ci002' },

  // ac008 — 3 invoices
  { id:'iv004', number:'PBF-004', accountId:'ac008', accountName:'Pinebrook Deli',
    issued:D(160), due:D(130), amount:180.00, status:'paid',
    lineItems:[{id:sid(),sku:'classic',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'}],
    notes:'', combinedInvoiceId:null },

  { id:'iv005', number:'PBF-005', accountId:'ac008', accountName:'Pinebrook Deli',
    issued:D(90), due:D(60), amount:270.00, status:'paid',
    lineItems:[
      {id:sid(),sku:'classic',  qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'},
      {id:sid(),sku:'raspberry',qty:36,cases:3,unitPrice:2.50,total:90.00, description:'Raspberry 12-pk'},
    ],
    notes:'', combinedInvoiceId:null },

  { id:'iv006', number:'PBF-006', accountId:'ac008', accountName:'Pinebrook Deli',
    issued:D(20), due:D(10), amount:360.00, status:'unpaid',
    lineItems:[
      {id:sid(),sku:'classic',  qty:96,cases:8,unitPrice:2.50,total:240.00,description:'Classic 12-pk'},
      {id:sid(),sku:'blueberry',qty:48,cases:4,unitPrice:2.50,total:120.00,description:'Blueberry 12-pk'},
    ],
    notes:'', combinedInvoiceId:null },

  // ac011 — 1 invoice (iv007 used in ci003)
  { id:'iv007', number:'PBF-007', accountId:'ac011', accountName:'Birchwood Co-op',
    issued:D(110), due:D(80), amount:360.00, status:'paid',
    lineItems:[
      {id:sid(),sku:'classic',  qty:96,cases:8,unitPrice:2.50,total:240.00,description:'Classic 12-pk'},
      {id:sid(),sku:'blueberry',qty:48,cases:4,unitPrice:2.50,total:120.00,description:'Blueberry 12-pk'},
    ],
    notes:'', combinedInvoiceId:'ci003' },

  // ac013 — 2 invoices (iv008 used in ci004)
  { id:'iv008', number:'PBF-008', accountId:'ac013', accountName:'Heritage Farm Store',
    issued:D(140), due:D(110), amount:540.00, status:'paid',
    lineItems:[
      {id:sid(),sku:'classic',  qty:144,cases:12,unitPrice:2.50,total:360.00,description:'Classic 12-pk'},
      {id:sid(),sku:'peach',    qty:72, cases:6, unitPrice:2.50,total:180.00,description:'Peach 12-pk'},
    ],
    notes:'', combinedInvoiceId:'ci004' },

  { id:'iv009', number:'PBF-009', accountId:'ac013', accountName:'Heritage Farm Store',
    issued:D(30), due:D(0), amount:360.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'classic',qty:144,cases:12,unitPrice:2.50,total:360.00,description:'Classic 12-pk'}],
    notes:'', combinedInvoiceId:null },

  // ac016 — 1 invoice (iv010 used in ci005 — overdue 60 days)
  { id:'iv010', number:'PBF-010', accountId:'ac016', accountName:'Rolling Hills Farm Stand',
    issued:D(90), due:D(60), amount:216.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'classic',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'}],
    notes:'60 days overdue.', combinedInvoiceId:'ci005' },

  // ac019 — 1 invoice
  { id:'iv011', number:'PBF-011', accountId:'ac019', accountName:'Clover Valley Farms',
    issued:D(95), due:D(65), amount:270.00, status:'paid',
    lineItems:[
      {id:sid(),sku:'classic',  qty:96, cases:8,unitPrice:2.50,total:240.00,description:'Classic 12-pk'},
      {id:sid(),sku:'raspberry',qty:36, cases:3,unitPrice:2.50,total:90.00, description:'Raspberry 12-pk'},
    ],
    notes:'Via NENF distributor.', combinedInvoiceId:null },

  // Additional invoices — ac023, ac024, ac025, ac028, ac029, ac012, ac014
  { id:'iv012', number:'PBF-012', accountId:'ac023', accountName:'Pinecrest Market',
    issued:D(70), due:D(40), amount:180.00, status:'paid',
    lineItems:[{id:sid(),sku:'classic',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'}],
    notes:'', combinedInvoiceId:null },

  { id:'iv013', number:'PBF-013', accountId:'ac024', accountName:'Cliffside Provisions',
    issued:D(55), due:D(25), amount:180.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'peach',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Peach 12-pk'}],
    notes:'', combinedInvoiceId:null },

  { id:'iv014', number:'PBF-014', accountId:'ac025', accountName:'Brookside Natural Foods',
    issued:D(85), due:D(55), amount:360.00, status:'paid',
    lineItems:[
      {id:sid(),sku:'classic',  qty:96,cases:8,unitPrice:2.50,total:240.00,description:'Classic'},
      {id:sid(),sku:'blueberry',qty:48,cases:4,unitPrice:2.50,total:120.00,description:'Blueberry'},
    ],
    notes:'', combinedInvoiceId:null },

  { id:'iv015', number:'PBF-015', accountId:'ac028', accountName:'Harbor Light Market',
    issued:D(65), due:D(35), amount:216.00, status:'paid',
    lineItems:[{id:sid(),sku:'classic',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'}],
    notes:'', combinedInvoiceId:null },

  { id:'iv016', number:'PBF-016', accountId:'ac012', accountName:'Autumn Ridge Bakery',
    issued:D(50), due:D(20), amount:144.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'peach',qty:48,cases:4,unitPrice:2.50,total:120.00,description:'Peach 12-pk'}],
    notes:'', combinedInvoiceId:null },

  { id:'iv017', number:'PBF-017', accountId:'ac029', accountName:'Fern Valley Co-op',
    issued:D(40), due:D(10), amount:180.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'classic',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'}],
    notes:'', combinedInvoiceId:null },

  { id:'iv018', number:'PBF-018', accountId:'ac026', accountName:'Riverbank Cafe',
    issued:D(35), due:D(5), amount:144.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'variety',qty:48,cases:4,unitPrice:2.50,total:120.00,description:'Variety 12-pk'}],
    notes:'', combinedInvoiceId:null },

  // ── iv019–iv030: stress-test expansion ──────────────────────
  // 5 paid this month (iv019–iv023), others mix paid/unpaid/overdue

  // Paid this month — ac003, ac004, ac006, ac009, ac010
  { id:'iv019', number:'PBF-019', accountId:'ac003', accountName:'The Lavender Shop',
    issued:D(28), due:D(-2), amount:180.00, status:'paid',
    lineItems:[{id:sid(),sku:'classic',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'}],
    notes:'Paid by check same day.', combinedInvoiceId:null },

  { id:'iv020', number:'PBF-020', accountId:'ac004', accountName:'Blue Ridge Grocery',
    issued:D(22), due:D(8), amount:270.00, status:'paid',
    lineItems:[
      {id:sid(),sku:'classic',  qty:72, cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'},
      {id:sid(),sku:'raspberry',qty:36, cases:3,unitPrice:2.50,total:90.00, description:'Raspberry 12-pk'},
    ],
    notes:'', combinedInvoiceId:null },

  { id:'iv021', number:'PBF-021', accountId:'ac006', accountName:'Cedar Creek Farm',
    issued:D(18), due:D(-12), amount:216.00, status:'paid',
    lineItems:[{id:sid(),sku:'classic',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'}],
    notes:'Spring restock — paid early.', combinedInvoiceId:null },

  { id:'iv022', number:'PBF-022', accountId:'ac009', accountName:"O'Brien & Sons Market",
    issued:D(12), due:D(-18), amount:360.00, status:'paid',
    lineItems:[
      {id:sid(),sku:'classic',  qty:96,cases:8,unitPrice:2.50,total:240.00,description:'Classic 12-pk'},
      {id:sid(),sku:'blueberry',qty:48,cases:4,unitPrice:2.50,total:120.00,description:'Blueberry 12-pk'},
    ],
    notes:'', combinedInvoiceId:null },

  { id:'iv023', number:'PBF-023', accountId:'ac010', accountName:'Maple Leaf Market',
    issued:D(5), due:D(-25), amount:180.00, status:'paid',
    lineItems:[{id:sid(),sku:'variety',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Variety 12-pk'}],
    notes:'Paid via Venmo.', combinedInvoiceId:null },

  // Overdue / unpaid
  { id:'iv024', number:'PBF-024', accountId:'ac015', accountName:'Lakeshore Market',
    issued:D(75), due:D(45), amount:216.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'classic',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'}],
    notes:'45 days overdue — send reminder.', combinedInvoiceId:null },

  { id:'iv025', number:'PBF-025', accountId:'ac017', accountName:'Stonewall Farm Market',
    issued:D(65), due:D(35), amount:270.00, status:'unpaid',
    lineItems:[
      {id:sid(),sku:'classic',   qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'},
      {id:sid(),sku:'peach',     qty:36,cases:3,unitPrice:2.50,total:90.00, description:'Peach 12-pk'},
    ],
    notes:'35 days overdue.', combinedInvoiceId:null },

  { id:'iv026', number:'PBF-026', accountId:'ac020', accountName:'Pine Street Co-op',
    issued:D(55), due:D(25), amount:180.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'blueberry',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Blueberry 12-pk'}],
    notes:'25 days overdue.', combinedInvoiceId:null },

  { id:'iv027', number:'PBF-027', accountId:'ac031', accountName:'Green Leaf Spa',
    issued:D(50), due:D(20), amount:144.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'classic',qty:48,cases:4,unitPrice:2.50,total:120.00,description:'Classic 12-pk'}],
    notes:'20 days overdue.', combinedInvoiceId:null },

  { id:'iv028', number:'PBF-028', accountId:'ac032', accountName:'Lavender Lane Gift Shop',
    issued:D(40), due:D(10), amount:180.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'classic',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'}],
    notes:'10 days overdue.', combinedInvoiceId:null },

  // ci006 anchor: iv029 + lf009
  { id:'iv029', number:'PBF-029', accountId:'ac033', accountName:'Wellspring Wellness Center',
    issued:D(95), due:D(65), amount:360.00, status:'paid',
    lineItems:[
      {id:sid(),sku:'classic',  qty:96,cases:8,unitPrice:2.50,total:240.00,description:'Classic 12-pk'},
      {id:sid(),sku:'blueberry',qty:48,cases:4,unitPrice:2.50,total:120.00,description:'Blueberry 12-pk'},
    ],
    notes:'', combinedInvoiceId:'ci006' },

  // ci007 anchor: iv030 + lf010
  { id:'iv030', number:'PBF-030', accountId:'ac034', accountName:'Blossom & Bloom Boutique',
    issued:D(60), due:D(30), amount:216.00, status:'unpaid',
    lineItems:[{id:sid(),sku:'classic',qty:72,cases:6,unitPrice:2.50,total:180.00,description:'Classic 12-pk'}],
    notes:'30 days overdue.', combinedInvoiceId:'ci007' },
];

// =============================================================
//  LF INVOICES (8)
// =============================================================
const lf_invoices = [
  // ac001 (lf001 used in ci001)
  { id:'lf001', number:'LF-001', accountId:'ac001', accountName:'Harvest Moon Co-op',
    issued:D(100), due:D(70), total:215.88, status:'paid',
    lineItems:[
      {id:sid(),skuId:'lf-simple-syrup-sm',skuName:'Lavender Simple Syrup 12.7oz',units:12,caseSize:12,wholesalePrice:8.99,lineTotal:107.88,hasVariants:false},
      {id:sid(),skuId:'lf-candle',         skuName:'Soy Candle',                   units:12,caseSize:12,wholesalePrice:14.99,lineTotal:179.88,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:'ci001', source:'manual', notes:'' },

  // ac005 (lf002 used in ci002)
  { id:'lf002', number:'LF-002', accountId:'ac005', accountName:'Sunrise Wellness',
    issued:D(80), due:D(50), total:107.88, status:'unpaid',
    lineItems:[
      {id:sid(),skuId:'lf-roll-on',skuName:'Aromatherapy Roll-On',units:24,caseSize:24,wholesalePrice:9.99,lineTotal:239.76,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:'ci002', source:'manual', notes:'' },

  // ac011 (lf003 used in ci003)
  { id:'lf003', number:'LF-003', accountId:'ac011', accountName:'Birchwood Co-op',
    issued:D(110), due:D(80), total:143.76, status:'paid',
    lineItems:[
      {id:sid(),skuId:'lf-sachet',skuName:'Seatbelt Sachet',units:12,caseSize:12,wholesalePrice:4.99,lineTotal:59.88,hasVariants:false},
      {id:sid(),skuId:'lf-scrunchie',skuName:'Aromatherapy Scrunchie',units:12,caseSize:6,wholesalePrice:7.49,lineTotal:89.88,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:'ci003', source:'manual', notes:'' },

  // ac013 (lf004 used in ci004)
  { id:'lf004', number:'LF-004', accountId:'ac013', accountName:'Heritage Farm Store',
    issued:D(140), due:D(110), total:323.64, status:'paid',
    lineItems:[
      {id:sid(),skuId:'lf-simple-syrup-sm',skuName:'Lavender Simple Syrup 12.7oz',units:12,caseSize:12,wholesalePrice:8.99,lineTotal:107.88,hasVariants:false},
      {id:sid(),skuId:'lf-candle',         skuName:'Soy Candle',                   units:12,caseSize:12,wholesalePrice:14.99,lineTotal:179.88,hasVariants:false},
      {id:sid(),skuId:'lf-sachet',         skuName:'Seatbelt Sachet',               units:12,caseSize:12,wholesalePrice:4.99, lineTotal:59.88, hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:'ci004', source:'manual', notes:'' },

  // ac016 (lf005 used in ci005)
  { id:'lf005', number:'LF-005', accountId:'ac016', accountName:'Rolling Hills Farm Stand',
    issued:D(90), due:D(60), total:89.88, status:'unpaid',
    lineItems:[
      {id:sid(),skuId:'lf-scrunchie',skuName:'Aromatherapy Scrunchie',units:12,caseSize:6,wholesalePrice:7.49,lineTotal:89.88,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:'ci005', source:'manual', notes:'Overdue 60 days.' },

  // ac014 (standalone LF invoices)
  { id:'lf006', number:'LF-006', accountId:'ac014', accountName:'Meadowbrook Spa',
    issued:D(95), due:D(65), total:239.76, status:'paid',
    lineItems:[
      {id:sid(),skuId:'lf-roll-on',skuName:'Aromatherapy Roll-On',units:24,caseSize:24,wholesalePrice:9.99,lineTotal:239.76,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:null, source:'manual', notes:'' },

  { id:'lf007', number:'LF-007', accountId:'ac014', accountName:'Meadowbrook Spa',
    issued:D(35), due:D(5), total:179.88, status:'unpaid',
    lineItems:[
      {id:sid(),skuId:'lf-candle',skuName:'Soy Candle',units:12,caseSize:12,wholesalePrice:14.99,lineTotal:179.88,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:null, source:'manual', notes:'' },

  // ac030
  { id:'lf008', number:'LF-008', accountId:'ac030', accountName:'Thornwood Apothecary',
    issued:D(50), due:D(20), total:179.76, status:'unpaid',
    lineItems:[
      {id:sid(),skuId:'lf-refresh-powder',skuName:'Lavender Refresh Powder',units:24,caseSize:12,wholesalePrice:4.99,lineTotal:119.76,hasVariants:false},
      {id:sid(),skuId:'lf-dryer-sachet',  skuName:'Dryer Sachet 2-Pack',   units:12,caseSize:12,wholesalePrice:5.49,lineTotal:65.88, hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:null, source:'manual', notes:'' },

  // ── lf009–lf015: stress-test expansion ──────────────────────
  // ac031 Green Leaf Spa (combined ci006 with iv029)
  { id:'lf009', number:'LF-009', accountId:'ac033', accountName:'Wellspring Wellness Center',
    issued:D(95), due:D(65), total:263.76, status:'paid',
    lineItems:[
      {id:sid(),skuId:'lf-roll-on',    skuName:'Aromatherapy Roll-On', units:24,caseSize:24,wholesalePrice:9.99,lineTotal:239.76,hasVariants:false},
      {id:sid(),skuId:'lf-linen-spray',skuName:'Lavender Linen Spray 8oz',units:24,caseSize:12,wholesalePrice:9.49,lineTotal:227.76,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:'ci006', source:'manual', notes:'' },

  // ac034 Blossom & Bloom (combined ci007 with iv030)
  { id:'lf010', number:'LF-010', accountId:'ac034', accountName:'Blossom & Bloom Boutique',
    issued:D(60), due:D(30), total:143.76, status:'unpaid',
    lineItems:[
      {id:sid(),skuId:'lf-sachet',   skuName:'Seatbelt Sachet',        units:12,caseSize:12,wholesalePrice:4.99,lineTotal:59.88, hasVariants:false},
      {id:sid(),skuId:'lf-scrunchie',skuName:'Aromatherapy Scrunchie', units:12,caseSize:6, wholesalePrice:7.49,lineTotal:89.88, hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:'ci007', source:'manual', notes:'30 days overdue.' },

  // ac035 The Herbal Haven — standalone overdue
  { id:'lf011', number:'LF-011', accountId:'ac035', accountName:'The Herbal Haven',
    issued:D(85), due:D(55), total:359.64, status:'unpaid',
    lineItems:[
      {id:sid(),skuId:'lf-candle',         skuName:'Soy Candle',            units:12,caseSize:12,wholesalePrice:14.99,lineTotal:179.88,hasVariants:false},
      {id:sid(),skuId:'lf-simple-syrup-sm',skuName:'Lavender Simple Syrup 12.7oz',units:12,caseSize:12,wholesalePrice:8.99,lineTotal:107.88,hasVariants:false},
      {id:sid(),skuId:'lf-roll-on',        skuName:'Aromatherapy Roll-On',  units:12,caseSize:24,wholesalePrice:9.99,lineTotal:119.88,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:null, source:'manual', notes:'55 days overdue.' },

  // ac031 Green Leaf Spa — paid this month
  { id:'lf012', number:'LF-012', accountId:'ac031', accountName:'Green Leaf Spa',
    issued:D(20), due:D(-10), total:239.76, status:'paid',
    lineItems:[
      {id:sid(),skuId:'lf-roll-on',skuName:'Aromatherapy Roll-On',units:24,caseSize:24,wholesalePrice:9.99,lineTotal:239.76,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:null, source:'manual', notes:'Paid promptly.' },

  // ac032 Lavender Lane Gift Shop — paid
  { id:'lf013', number:'LF-013', accountId:'ac032', accountName:'Lavender Lane Gift Shop',
    issued:D(110), due:D(80), total:179.88, status:'paid',
    lineItems:[
      {id:sid(),skuId:'lf-candle',skuName:'Soy Candle',units:12,caseSize:12,wholesalePrice:14.99,lineTotal:179.88,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:null, source:'manual', notes:'' },

  // ac003 The Lavender Shop — combined ci008 anchor
  { id:'lf014', number:'LF-014', accountId:'ac003', accountName:'The Lavender Shop',
    issued:D(28), due:D(-2), total:107.88, status:'paid',
    lineItems:[
      {id:sid(),skuId:'lf-simple-syrup-sm',skuName:'Lavender Simple Syrup 12.7oz',units:12,caseSize:12,wholesalePrice:8.99,lineTotal:107.88,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:'ci008', source:'manual', notes:'' },

  // ac005 Sunrise Wellness — standalone paid
  { id:'lf015', number:'LF-015', accountId:'ac005', accountName:'Sunrise Wellness',
    issued:D(15), due:D(-15), total:59.88, status:'paid',
    lineItems:[
      {id:sid(),skuId:'lf-sachet',skuName:'Seatbelt Sachet',units:12,caseSize:12,wholesalePrice:4.99,lineTotal:59.88,hasVariants:false},
    ],
    wixPulled:false, combinedInvoiceId:null, source:'manual', notes:'Paid same day.' },
];

// =============================================================
//  COMBINED INVOICES (5)
// =============================================================
const combined_invoices = [
  { id:'ci001', number:'COMB-001', purplInvoiceId:'iv001', lfInvoiceId:'lf001',
    accountId:'ac001', accountName:'Harvest Moon Co-op',
    status:'paid', createdAt:ISO(100), sentAt:ISO(99), paidAt:ISO(90),
    portalOrderId:null, purplSubtotal:432.00, lfSubtotal:215.88, grandTotal:647.88, notes:'' },

  { id:'ci002', number:'COMB-002', purplInvoiceId:'iv003', lfInvoiceId:'lf002',
    accountId:'ac005', accountName:'Sunrise Wellness',
    status:'unpaid', createdAt:ISO(80), sentAt:ISO(79), paidAt:null,
    portalOrderId:null, purplSubtotal:288.00, lfSubtotal:239.76, grandTotal:527.76, notes:'' },

  { id:'ci003', number:'COMB-003', purplInvoiceId:'iv007', lfInvoiceId:'lf003',
    accountId:'ac011', accountName:'Birchwood Co-op',
    status:'paid', createdAt:ISO(110), sentAt:ISO(109), paidAt:ISO(100),
    portalOrderId:null, purplSubtotal:360.00, lfSubtotal:143.76, grandTotal:503.76, notes:'' },

  { id:'ci004', number:'COMB-004', purplInvoiceId:'iv008', lfInvoiceId:'lf004',
    accountId:'ac013', accountName:'Heritage Farm Store',
    status:'paid', createdAt:ISO(140), sentAt:ISO(139), paidAt:ISO(130),
    portalOrderId:null, purplSubtotal:540.00, lfSubtotal:323.64, grandTotal:863.64, notes:'' },

  { id:'ci005', number:'COMB-005', purplInvoiceId:'iv010', lfInvoiceId:'lf005',
    accountId:'ac016', accountName:'Rolling Hills Farm Stand',
    status:'unpaid', createdAt:ISO(90), sentAt:ISO(89), paidAt:null,
    portalOrderId:null, purplSubtotal:216.00, lfSubtotal:89.88, grandTotal:305.88, notes:'OVERDUE 60 days.' },

  // ── ci006–ci008: stress-test expansion ──────────────────────
  { id:'ci006', number:'COMB-006', purplInvoiceId:'iv029', lfInvoiceId:'lf009',
    accountId:'ac033', accountName:'Wellspring Wellness Center',
    status:'paid', createdAt:ISO(95), sentAt:ISO(94), paidAt:ISO(85),
    portalOrderId:null, purplSubtotal:360.00, lfSubtotal:263.76, grandTotal:623.76, notes:'' },

  { id:'ci007', number:'COMB-007', purplInvoiceId:'iv030', lfInvoiceId:'lf010',
    accountId:'ac034', accountName:'Blossom & Bloom Boutique',
    status:'unpaid', createdAt:ISO(60), sentAt:ISO(59), paidAt:null,
    portalOrderId:null, purplSubtotal:216.00, lfSubtotal:143.76, grandTotal:359.76, notes:'30 days overdue.' },

  { id:'ci008', number:'COMB-008', purplInvoiceId:'iv019', lfInvoiceId:'lf014',
    accountId:'ac003', accountName:'The Lavender Shop',
    status:'paid', createdAt:ISO(28), sentAt:ISO(27), paidAt:ISO(20),
    portalOrderId:null, purplSubtotal:180.00, lfSubtotal:107.88, grandTotal:287.88, notes:'New account opening order.' },
];

// =============================================================
//  DISTRIBUTORS
// =============================================================
const dist_profiles = [
  { id:'dist001', name:'New England Natural Foods', status:'active',
    territory:'New England', email:'orders@nenf.com', phone:'603-555-9001',
    notes:'Primary regional distributor. Net-30 terms.', since: D(300),
    dcAddress:'45 Industrial Dr, Concord, NH 03301',
    territoryRadiusMiles: 80,
    velocityReports: [
      { id:'vr001', date:D(90), sku:'classic',   doors:18, cases:72,  units:864,  notes:'Q1 restock across NH accounts' },
      { id:'vr002', date:D(60), sku:'blueberry', doors:12, cases:36,  units:432,  notes:'Spring intro push' },
      { id:'vr003', date:D(30), sku:'classic',   doors:20, cases:90,  units:1080, notes:'April reorder — strong sell-through' },
    ],
  },
  { id:'dist002', name:'Northeast Beverage Co', status:'active',
    territory:'Northeast', email:'wholesale@nebev.com', phone:'617-555-9002',
    notes:'Secondary distributor — Maine and Mass.', since: D(200),
    dcAddress:'200 Commerce Way, Newton, MA 02459',
    territoryRadiusMiles: 60,
    velocityReports: [
      { id:'vr004', date:D(85), sku:'classic',   doors:10, cases:48,  units:576,  notes:'Initial MA placement' },
      { id:'vr005', date:D(55), sku:'raspberry', doors:8,  cases:24,  units:288,  notes:'Raspberry trial — good response in Boston suburbs' },
      { id:'vr006', date:D(20), sku:'classic',   doors:12, cases:60,  units:720,  notes:'Q2 restock — added 2 new doors' },
    ],
  },
];

const dist_reps = [
  { id:'rep001', distId:'dist001', name:'Mark Bouchard', email:'mark@nenf.com', phone:'603-555-9011', territory:'NH/VT' },
  { id:'rep002', distId:'dist002', name:'Donna Pierce',  email:'donna@nebev.com', phone:'617-555-9021', territory:'MA/ME' },
];

// =============================================================
//  DISTRIBUTOR INVOICES (10)
// =============================================================
const dist_invoices_data = [
  // dist001 — 5 invoices
  { id:'dinv001', distId:'dist001', invoiceNumber:'NENF-2501', dateIssued:D(120), dueDate:D(90),
    poRef:'PO-2501', externalRef:'', status:'paid',
    items:[
      { sku:'classic',   cases:60, pricePerCase:26.00 },
      { sku:'blueberry', cases:24, pricePerCase:26.00 },
    ],
    total: 2184.00, notes:'Q1 opening order.' },

  { id:'dinv002', distId:'dist001', invoiceNumber:'NENF-2502', dateIssued:D(90), dueDate:D(60),
    poRef:'PO-2502', externalRef:'', status:'paid',
    items:[
      { sku:'classic',   cases:48, pricePerCase:26.00 },
      { sku:'raspberry', cases:24, pricePerCase:26.00 },
    ],
    total: 1872.00, notes:'' },

  { id:'dinv003', distId:'dist001', invoiceNumber:'NENF-2503', dateIssued:D(60), dueDate:D(30),
    poRef:'PO-2503', externalRef:'', status:'unpaid',
    items:[
      { sku:'classic',   cases:72, pricePerCase:26.00 },
      { sku:'blueberry', cases:36, pricePerCase:26.00 },
    ],
    total: 2808.00, notes:'30 days overdue.' },

  { id:'dinv004', distId:'dist001', invoiceNumber:'NENF-2504', dateIssued:D(35), dueDate:D(5),
    poRef:'PO-2504', externalRef:'', status:'unpaid',
    items:[
      { sku:'classic', cases:48, pricePerCase:26.00 },
      { sku:'variety', cases:12, pricePerCase:26.00 },
    ],
    total: 1560.00, notes:'5 days overdue.' },

  { id:'dinv005', distId:'dist001', invoiceNumber:'NENF-2505', dateIssued:D(10), dueDate:D(-20),
    poRef:'PO-2505', externalRef:'', status:'unpaid',
    items:[
      { sku:'classic',   cases:36, pricePerCase:26.00 },
      { sku:'blueberry', cases:24, pricePerCase:26.00 },
    ],
    total: 1560.00, notes:'Due in 20 days.' },

  // dist002 — 5 invoices
  { id:'dinv006', distId:'dist002', invoiceNumber:'NEBEV-2501', dateIssued:D(110), dueDate:D(80),
    poRef:'', externalRef:'NEB-1001', status:'paid',
    items:[
      { sku:'classic',   cases:48, pricePerCase:27.00 },
      { sku:'raspberry', cases:12, pricePerCase:27.00 },
    ],
    total: 1620.00, notes:'Initial MA order.' },

  { id:'dinv007', distId:'dist002', invoiceNumber:'NEBEV-2502', dateIssued:D(80), dueDate:D(50),
    poRef:'', externalRef:'NEB-1002', status:'paid',
    items:[
      { sku:'classic',   cases:36, pricePerCase:27.00 },
      { sku:'blueberry', cases:24, pricePerCase:27.00 },
    ],
    total: 1620.00, notes:'' },

  { id:'dinv008', distId:'dist002', invoiceNumber:'NEBEV-2503', dateIssued:D(55), dueDate:D(25),
    poRef:'', externalRef:'NEB-1003', status:'unpaid',
    items:[
      { sku:'classic', cases:48, pricePerCase:27.00 },
      { sku:'peach',   cases:12, pricePerCase:27.00 },
    ],
    total: 1620.00, notes:'25 days overdue.' },

  { id:'dinv009', distId:'dist002', invoiceNumber:'NEBEV-2504', dateIssued:D(30), dueDate:D(0),
    poRef:'', externalRef:'NEB-1004', status:'unpaid',
    items:[
      { sku:'classic',   cases:24, pricePerCase:27.00 },
      { sku:'raspberry', cases:24, pricePerCase:27.00 },
    ],
    total: 1296.00, notes:'Due today.' },

  { id:'dinv010', distId:'dist002', invoiceNumber:'NEBEV-2505', dateIssued:D(8), dueDate:D(-22),
    poRef:'', externalRef:'NEB-1005', status:'unpaid',
    items:[
      { sku:'classic', cases:36, pricePerCase:27.00 },
    ],
    total: 972.00, notes:'Due in 22 days.' },
];

// =============================================================
//  LF SKUs (10)
// =============================================================
const lf_skus = [
  { id:'lf-simple-syrup-sm', name:'Lavender Simple Syrup 12.7oz', wholesalePrice:8.99,  caseSize:12, msrp:17.99, archived:false },
  { id:'lf-simple-syrup-lg', name:'Lavender Simple Syrup 1 gal',  wholesalePrice:49.99, caseSize:1,  msrp:null,  archived:false },
  { id:'lf-scrunchie',       name:'Aromatherapy Scrunchie',        wholesalePrice:7.49,  caseSize:6,  msrp:14.99, archived:false },
  { id:'lf-sachet',          name:'Seatbelt Sachet',               wholesalePrice:4.99,  caseSize:12, msrp:9.99,  archived:false },
  { id:'lf-candle',          name:'Soy Candle',                    wholesalePrice:14.99, caseSize:12, msrp:24.99, archived:false },
  { id:'lf-refresh-powder',  name:'Lavender Refresh Powder',       wholesalePrice:4.99,  caseSize:12, msrp:9.99,  archived:false },
  { id:'lf-roll-on',         name:'Aromatherapy Roll-On',          wholesalePrice:9.99,  caseSize:24, msrp:19.99, archived:false },
  { id:'lf-dryer-sachet',    name:'Dryer Sachet 2-Pack',           wholesalePrice:5.49,  caseSize:12, msrp:9.99,  archived:false },
  { id:'lf-linen-spray',     name:'Lavender Linen Spray 8oz',      wholesalePrice:9.49,  caseSize:12, msrp:18.99, archived:false },
  { id:'lf-bath-salts',      name:'Lavender Bath Salts 8oz',       wholesalePrice:6.99,  caseSize:12, msrp:13.99, archived:false },
];

// =============================================================
//  ORDERS (40) — spread across 20 accounts, last 6 months
// =============================================================
// Structure: {id, accountId, created, dueDate, status, items:[{sku,qty}], canCount, source, externalId, importedAt}
// qty = cases; canCount = sum(qty * 12)
const orders_data = [
  // ac001 — 2 orders
  { id:'ord001', accountId:'ac001', created:D(170), dueDate:D(170), status:'delivered',
    items:[{sku:'classic',qty:12},{sku:'blueberry',qty:6}], canCount:216,
    source:'manual', externalId:'', importedAt:D(170) },
  { id:'ord002', accountId:'ac001', created:D(60), dueDate:D(60), status:'delivered',
    items:[{sku:'classic',qty:12},{sku:'blueberry',qty:6},{sku:'raspberry',qty:3}], canCount:252,
    source:'manual', externalId:'', importedAt:D(60) },

  // ac002 — 2 orders
  { id:'ord003', accountId:'ac002', created:D(155), dueDate:D(155), status:'delivered',
    items:[{sku:'classic',qty:8},{sku:'blueberry',qty:8}], canCount:192,
    source:'manual', externalId:'', importedAt:D(155) },
  { id:'ord004', accountId:'ac002', created:D(45), dueDate:D(45), status:'delivered',
    items:[{sku:'classic',qty:8},{sku:'blueberry',qty:4}], canCount:144,
    source:'manual', externalId:'', importedAt:D(45) },

  // ac003 — 2 orders
  { id:'ord005', accountId:'ac003', created:D(25), dueDate:D(25), status:'delivered',
    items:[{sku:'classic',qty:6}], canCount:72,
    source:'manual', externalId:'', importedAt:D(25) },
  { id:'ord006', accountId:'ac003', created:D(5), dueDate:D(5), status:'pending',
    items:[{sku:'classic',qty:4},{sku:'blueberry',qty:2}], canCount:72,
    source:'manual', externalId:'', importedAt:D(5) },

  // ac004 — 2 orders
  { id:'ord007', accountId:'ac004', created:D(140), dueDate:D(140), status:'delivered',
    items:[{sku:'classic',qty:6}], canCount:72,
    source:'manual', externalId:'', importedAt:D(140) },
  { id:'ord008', accountId:'ac004', created:D(20), dueDate:D(20), status:'delivered',
    items:[{sku:'classic',qty:6},{sku:'raspberry',qty:3}], canCount:108,
    source:'manual', externalId:'', importedAt:D(20) },

  // ac005 — 2 orders
  { id:'ord009', accountId:'ac005', created:D(160), dueDate:D(160), status:'delivered',
    items:[{sku:'classic',qty:4}], canCount:48,
    source:'manual', externalId:'', importedAt:D(160) },
  { id:'ord010', accountId:'ac005', created:D(55), dueDate:D(55), status:'delivered',
    items:[{sku:'classic',qty:4},{sku:'blueberry',qty:4}], canCount:96,
    source:'manual', externalId:'', importedAt:D(55) },

  // ac006 — 2 orders
  { id:'ord011', accountId:'ac006', created:D(175), dueDate:D(175), status:'delivered',
    items:[{sku:'classic',qty:8}], canCount:96,
    source:'manual', externalId:'', importedAt:D(175) },
  { id:'ord012', accountId:'ac006', created:D(95), dueDate:D(95), status:'delivered',
    items:[{sku:'classic',qty:6},{sku:'blueberry',qty:4}], canCount:120,
    source:'manual', externalId:'', importedAt:D(95) },

  // ac008 — 2 orders
  { id:'ord013', accountId:'ac008', created:D(150), dueDate:D(150), status:'delivered',
    items:[{sku:'classic',qty:6},{sku:'raspberry',qty:3}], canCount:108,
    source:'manual', externalId:'', importedAt:D(150) },
  { id:'ord014', accountId:'ac008', created:D(15), dueDate:D(15), status:'delivered',
    items:[{sku:'classic',qty:8},{sku:'blueberry',qty:4},{sku:'variety',qty:4}], canCount:192,
    source:'manual', externalId:'', importedAt:D(15) },

  // ac009 — 2 orders
  { id:'ord015', accountId:'ac009', created:D(130), dueDate:D(130), status:'delivered',
    items:[{sku:'classic',qty:12}], canCount:144,
    source:'manual', externalId:'', importedAt:D(130) },
  { id:'ord016', accountId:'ac009', created:D(12), dueDate:D(12), status:'delivered',
    items:[{sku:'classic',qty:8},{sku:'blueberry',qty:8}], canCount:192,
    source:'manual', externalId:'', importedAt:D(12) },

  // ac010 — 2 orders
  { id:'ord017', accountId:'ac010', created:D(120), dueDate:D(120), status:'delivered',
    items:[{sku:'classic',qty:6},{sku:'variety',qty:3}], canCount:108,
    source:'manual', externalId:'', importedAt:D(120) },
  { id:'ord018', accountId:'ac010', created:D(5), dueDate:D(5), status:'delivered',
    items:[{sku:'classic',qty:6},{sku:'variety',qty:6}], canCount:144,
    source:'manual', externalId:'', importedAt:D(5) },

  // ac011 — 2 orders
  { id:'ord019', accountId:'ac011', created:D(110), dueDate:D(110), status:'delivered',
    items:[{sku:'classic',qty:8},{sku:'blueberry',qty:4}], canCount:144,
    source:'manual', externalId:'', importedAt:D(110) },
  { id:'ord020', accountId:'ac011', created:D(40), dueDate:D(40), status:'delivered',
    items:[{sku:'classic',qty:6},{sku:'blueberry',qty:6}], canCount:144,
    source:'manual', externalId:'', importedAt:D(40) },

  // ac012 — 2 orders
  { id:'ord021', accountId:'ac012', created:D(100), dueDate:D(100), status:'delivered',
    items:[{sku:'peach',qty:4}], canCount:48,
    source:'manual', externalId:'', importedAt:D(100) },
  { id:'ord022', accountId:'ac012', created:D(50), dueDate:D(50), status:'delivered',
    items:[{sku:'peach',qty:4},{sku:'classic',qty:2}], canCount:72,
    source:'manual', externalId:'', importedAt:D(50) },

  // ac013 — 2 orders
  { id:'ord023', accountId:'ac013', created:D(135), dueDate:D(135), status:'delivered',
    items:[{sku:'classic',qty:12},{sku:'peach',qty:6}], canCount:216,
    source:'manual', externalId:'', importedAt:D(135) },
  { id:'ord024', accountId:'ac013', created:D(30), dueDate:D(30), status:'pending',
    items:[{sku:'classic',qty:12}], canCount:144,
    source:'manual', externalId:'', importedAt:D(30) },

  // ac015 — 2 orders
  { id:'ord025', accountId:'ac015', created:D(105), dueDate:D(105), status:'delivered',
    items:[{sku:'classic',qty:6}], canCount:72,
    source:'manual', externalId:'', importedAt:D(105) },
  { id:'ord026', accountId:'ac015', created:D(75), dueDate:D(75), status:'delivered',
    items:[{sku:'classic',qty:6},{sku:'blueberry',qty:3}], canCount:108,
    source:'manual', externalId:'', importedAt:D(75) },

  // ac016 — 2 orders
  { id:'ord027', accountId:'ac016', created:D(90), dueDate:D(90), status:'delivered',
    items:[{sku:'classic',qty:6}], canCount:72,
    source:'manual', externalId:'', importedAt:D(90) },
  { id:'ord028', accountId:'ac016', created:D(30), dueDate:D(30), status:'pending',
    items:[{sku:'classic',qty:4}], canCount:48,
    source:'manual', externalId:'', importedAt:D(30) },

  // ac017 — 2 orders
  { id:'ord029', accountId:'ac017', created:D(85), dueDate:D(85), status:'delivered',
    items:[{sku:'classic',qty:4},{sku:'peach',qty:4}], canCount:96,
    source:'manual', externalId:'', importedAt:D(85) },
  { id:'ord030', accountId:'ac017', created:D(55), dueDate:D(55), status:'delivered',
    items:[{sku:'classic',qty:6},{sku:'peach',qty:3}], canCount:108,
    source:'manual', externalId:'', importedAt:D(55) },

  // ac018 — 2 orders
  { id:'ord031', accountId:'ac018', created:D(80), dueDate:D(80), status:'delivered',
    items:[{sku:'classic',qty:12}], canCount:144,
    source:'manual', externalId:'', importedAt:D(80) },
  { id:'ord032', accountId:'ac018', created:D(25), dueDate:D(25), status:'delivered',
    items:[{sku:'classic',qty:8},{sku:'blueberry',qty:4}], canCount:144,
    source:'manual', externalId:'', importedAt:D(25) },

  // ac019 — 2 orders
  { id:'ord033', accountId:'ac019', created:D(95), dueDate:D(95), status:'delivered',
    items:[{sku:'classic',qty:8},{sku:'raspberry',qty:3}], canCount:132,
    source:'manual', externalId:'', importedAt:D(95) },
  { id:'ord034', accountId:'ac019', created:D(38), dueDate:D(38), status:'delivered',
    items:[{sku:'classic',qty:6},{sku:'raspberry',qty:3}], canCount:108,
    source:'manual', externalId:'', importedAt:D(38) },

  // ac020 — 2 orders
  { id:'ord035', accountId:'ac020', created:D(70), dueDate:D(70), status:'delivered',
    items:[{sku:'classic',qty:6}], canCount:72,
    source:'manual', externalId:'', importedAt:D(70) },
  { id:'ord036', accountId:'ac020', created:D(55), dueDate:D(55), status:'delivered',
    items:[{sku:'classic',qty:4},{sku:'blueberry',qty:4}], canCount:96,
    source:'manual', externalId:'', importedAt:D(55) },

  // ac021–ac022 — 1 each to fill to 40
  { id:'ord037', accountId:'ac021', created:D(65), dueDate:D(65), status:'delivered',
    items:[{sku:'classic',qty:4}], canCount:48,
    source:'manual', externalId:'', importedAt:D(65) },
  { id:'ord038', accountId:'ac022', created:D(50), dueDate:D(50), status:'delivered',
    items:[{sku:'classic',qty:4},{sku:'blueberry',qty:2}], canCount:72,
    source:'manual', externalId:'', importedAt:D(50) },

  // ac023–ac024 — 1 each
  { id:'ord039', accountId:'ac023', created:D(68), dueDate:D(68), status:'delivered',
    items:[{sku:'classic',qty:6}], canCount:72,
    source:'manual', externalId:'', importedAt:D(68) },
  { id:'ord040', accountId:'ac024', created:D(52), dueDate:D(52), status:'pending',
    items:[{sku:'peach',qty:6}], canCount:72,
    source:'manual', externalId:'', importedAt:D(52) },
];

// =============================================================
//  PRODUCTION HISTORY (20)
// =============================================================
// Structure: {id, date, notes, ...skus:qty} — qty = cases
const prod_hist_data = [
  { id:'ph001', date:D(175), notes:'Large spring production run', classic:36, blueberry:24, raspberry:12 },
  { id:'ph002', date:D(160), notes:'Blueberry and variety restock',  blueberry:36, variety:18 },
  { id:'ph003', date:D(148), notes:'Classic top-off for May demand', classic:48 },
  { id:'ph004', date:D(135), notes:'Peach season launch',           peach:24, classic:24 },
  { id:'ph005', date:D(120), notes:'Mixed summer run',              classic:36, blueberry:18, peach:12, raspberry:12 },
  { id:'ph006', date:D(108), notes:'Classic only — distributor PO', classic:72 },
  { id:'ph007', date:D(95),  notes:'Raspberry push for summer accounts', raspberry:36, classic:24 },
  { id:'ph008', date:D(82),  notes:'Replenish all flavors',         classic:48, blueberry:24, peach:12, variety:12 },
  { id:'ph009', date:D(70),  notes:'Variety and classic',           classic:36, variety:24 },
  { id:'ph010', date:D(58),  notes:'Blueberry restock',             blueberry:48, classic:24 },
  { id:'ph011', date:D(48),  notes:'Pre-harvest run — classic focus', classic:60 },
  { id:'ph012', date:D(40),  notes:'Distributor top-off — NENF',    classic:48, raspberry:24 },
  { id:'ph013', date:D(33),  notes:'Peach and variety mix',         peach:36, variety:24, classic:12 },
  { id:'ph014', date:D(26),  notes:'Blueberry + classic for NH accounts', classic:36, blueberry:36 },
  { id:'ph015', date:D(20),  notes:'Raspberry season end batch',    raspberry:48, classic:24 },
  { id:'ph016', date:D(15),  notes:'April restock run',             classic:60, blueberry:36 },
  { id:'ph017', date:D(10),  notes:'Small variety fill run',        variety:24, peach:12 },
  { id:'ph018', date:D(7),   notes:'NEBEV distributor order prep',  classic:48, raspberry:24, blueberry:24 },
  { id:'ph019', date:D(4),   notes:'Classic emergency restock',     classic:36 },
  { id:'ph020', date:D(1),   notes:'Fresh spring batch — all flavors', classic:48, blueberry:24, peach:12, raspberry:12, variety:12 },
];

// =============================================================
//  SETTINGS
// =============================================================
const settings = {
  defaultFromEmail: 'lavender@pbfwholesale.com',
  farmName: 'Pumpkin Blossom Farm',
  farmPhone: '603-748-3038',
  farmAddress: '393 Pumpkin Hill Rd, Warner, NH 03278',
  seeded: true,
  data_restored: true,
  nem_show_2026_imported: true,
  tradeshow_2026_imported: true,
};

const invoice_settings = {
  nextPurplNumber:    31,
  nextLfNumber:       16,
  nextCombinedNumber: 9,
  prefix:             'PBF',
  lfPrefix:           'LF',
  combinedPrefix:     'COMB',
  defaultDueDays:     30,
  defaultNotes:       'Payment due within 30 days. Thank you for your business!',
};

const api_settings = {
  resendApiKey: '',
};

// =============================================================
//  PORTAL ORDERS (separate Firestore collections)
// =============================================================
const PORTAL_ORDERS = [
  { id:'portal-order-001', accountId:'ac005', accountName:'Sunrise Wellness',
    status:'submitted', notes:'Summer restock',
    items:[
      { skuId:'lf-candle',    skuName:'Soy Candle',    cases:2, caseSize:12, unitPrice:14.99 },
      { skuId:'lf-roll-on',   skuName:'Aromatherapy Roll-On', cases:1, caseSize:24, unitPrice:9.99 },
    ],
    submittedAt: new Date(BASE.getTime() - 3 * 864e5),   // 3 days ago
    total: 359.76 },
  { id:'portal-order-002', accountId:'ac013', accountName:'Heritage Farm Store',
    status:'processed', notes:'',
    items:[
      { skuId:'lf-sachet', skuName:'Seatbelt Sachet', cases:2, caseSize:12, unitPrice:4.99 },
    ],
    submittedAt: new Date(BASE.getTime() - 20 * 864e5),  // 20 days ago
    total: 119.76 },
];

const PORTAL_NOTIFY = [
  { id:'notify-001', accountId:'ac005', accountName:'Sunrise Wellness',
    orderId:'portal-order-001', status:'pending',
    submittedAt: new Date(BASE.getTime() - 3 * 864e5),
    message:'New portal order from Sunrise Wellness' },
];

// =============================================================
//  FULL SEED OBJECT
// =============================================================
const SEED = {
  ac:                accounts,
  pr:                prospects,
  iv,
  lf_invoices,
  combined_invoices,
  dist_profiles,
  dist_reps,
  dist_invoices:     dist_invoices_data,
  lf_skus,
  settings,
  invoice_settings,
  api_settings,
  orders:            orders_data,
  prod_hist:         prod_hist_data,
  // unused keys — empty arrays to avoid DB layer warnings
  prod_sched:[], shipments:[],
  dist:[], rem:[], pack_types:[], runs:[],
  dist_pricing:[], dist_pos:[], dist_chains:[], dist_imports:[],
  saved_reports:[], loose_cans:[], repack_jobs:[], pallets:[], pack_supply:[],
  quick_notes:[], stock_locations:[], stock_transfers:[],
  lf_wix_deductions:[], retail_invoices:[], pending_invoices:[], returns:[],
  costs: null, today_run: null,
};

module.exports = { SEED, PORTAL_ORDERS, PORTAL_NOTIFY };
