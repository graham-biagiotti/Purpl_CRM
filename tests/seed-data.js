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
];

// =============================================================
//  DISTRIBUTORS
// =============================================================
const dist_profiles = [
  { id:'dist001', name:'New England Natural Foods', status:'active',
    territory:'New England', email:'orders@nenf.com', phone:'603-555-9001',
    notes:'Primary regional distributor. Net-30 terms.', since: D(300) },
  { id:'dist002', name:'Northeast Beverage Co', status:'active',
    territory:'Northeast', email:'wholesale@nebev.com', phone:'617-555-9002',
    notes:'Secondary distributor — Maine and Mass.', since: D(200) },
];

const dist_reps = [
  { id:'rep001', distributorId:'dist001', name:'Mark Bouchard', email:'mark@nenf.com', phone:'603-555-9011', territory:'NH/VT' },
  { id:'rep002', distributorId:'dist002', name:'Donna Pierce',  email:'donna@nebev.com', phone:'617-555-9021', territory:'MA/ME' },
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
//  SETTINGS
// =============================================================
const settings = {
  defaultFromEmail: 'lavender@pbfwholesale.com',
  farmName: 'Pumpkin Blossom Farm',
  farmPhone: '603-748-3038',
  farmAddress: '393 Pumpkin Hill Rd, Warner, NH 03278',
};

const invoice_settings = {
  nextPurplNumber:    19,
  nextLfNumber:       9,
  nextCombinedNumber: 6,
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
  lf_skus,
  settings,
  invoice_settings,
  api_settings,
  // unused keys — empty arrays to avoid DB layer warnings
  orders:[], prod_hist:[], prod_sched:[], shipments:[],
  dist:[], rem:[], pack_types:[], runs:[],
  dist_pricing:[], dist_pos:[], dist_invoices:[], dist_chains:[], dist_imports:[],
  saved_reports:[], loose_cans:[], repack_jobs:[], pallets:[], pack_supply:[],
  quick_notes:[], stock_locations:[], stock_transfers:[],
  lf_wix_deductions:[], retail_invoices:[], pending_invoices:[], returns:[],
  costs: null, today_run: null,
};

module.exports = { SEED, PORTAL_ORDERS, PORTAL_NOTIFY };
