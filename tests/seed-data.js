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

// ─── PART 2 PLACEHOLDER — prospects, invoices, etc appended below ───────────
module.exports = { accounts, D, ISO, sid };
