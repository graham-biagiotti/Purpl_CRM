'use strict';
// =============================================================
//  seed-phase1.js  —  Phase 1 time-simulation extension
//  Standalone module; merged into emulator store by global-setup.js
// =============================================================

const BASE = new Date('2026-04-02T12:00:00.000Z');
const D = (n = 0) => { const d = new Date(BASE); d.setDate(d.getDate() - n); return d.toISOString().slice(0,10); };
const ISO = (n = 0) => { const d = new Date(BASE); d.setDate(d.getDate() - n); return d.toISOString(); };
let _n = 5000; // start high to avoid collisions with seed-data.js counters
const sid = () => `s${String(_n++).padStart(5,'0')}`;
const oe = (daysAgo, type, outcome, contact, notes, regarding = 'purpl') =>
  ({ id: sid(), date: D(daysAgo), type, outcome, contact, notes, regarding });
const ne = (daysAgo, text) => ({ id: sid(), date: D(daysAgo), text });
const ce = (stage, daysAgo) => ({ id: sid(), stage, sentAt: ISO(daysAgo), sentBy: 'graham', method: 'resend' });
const cad4 = (b = 120) => [ce('application_received',b),ce('approved_welcome',b-14),ce('invoice_sent',b-35),ce('first_order_followup',b-55)];
const cad3 = (b = 120) => [ce('application_received',b),ce('approved_welcome',b-14),ce('invoice_sent',b-35)];
const cad2 = (b = 100) => [ce('application_received',b),ce('approved_welcome',b-14)];
const cad1 = (b = 90)  => [ce('application_received',b)];

// =============================================================
//  EXTRA ACCOUNTS (ac051–ac080)
// =============================================================
const extraAccounts = [
  { id:'ac051', name:'Morning Dew Farm Stand', status:'active', isPbf:true,
    email:'grace@morningdewfarm.com', phone:'603-555-0051',
    address:'12 Dew Rd, Hopkinton, NH 03229', type:'Farm / Country Store',
    since:D(220), lastContacted:D(22),
    orderPortalToken:'token-ac051', orderPortalTokenCreatedAt:D(170), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Grace Townsend',email:'grace@morningdewfarm.com',phone:'603-555-0051',isPrimary:true}],
    cadence:cad3(200),
    outreach:[oe(215,'email','Interested','Grace Townsend','Cold email — enthusiastic.','purpl'),oe(200,'call','Ordered','Grace Townsend','First order: 6 classic, 3 blueberry.','purpl'),oe(140,'in-person','Ordered','Grace Townsend','Farm visit — selling well.','both'),oe(22,'call','Needs Follow-Up','Grace Townsend','Spring restock.','both')],
    notes:[ne(215,'Great farm store — strong local customer base.')],
    samples:[{id:sid(),date:D(210),flavors:'Classic, Blueberry',notes:'Opening samples',followUpDate:D(180),followUpDone:true}],
    par:{classic:24,blueberry:12} },

  { id:'ac052', name:'Hillside Harvest Market', status:'active', isPbf:false,
    email:'orders@hillsideharvest.com', phone:'802-555-0052',
    address:'34 Harvest Ln, Montpelier, VT 05602', type:'Grocery',
    since:D(195), lastContacted:D(48),
    orderPortalToken:'token-ac052', orderPortalTokenCreatedAt:D(145), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Tom Leblanc',email:'orders@hillsideharvest.com',phone:'802-555-0052',isPrimary:true}],
    cadence:cad3(175),
    outreach:[oe(190,'email','Interested','Tom Leblanc','Local NH beverages.','purpl'),oe(175,'call','Ordered','Tom Leblanc','First order confirmed.','purpl'),oe(48,'email','Needs Follow-Up','Tom Leblanc','Summer restock.','purpl')],
    notes:[ne(190,'Likes classic + blueberry mix.')],
    samples:[{id:sid(),date:D(185),flavors:'Classic',notes:'Trial case sent',followUpDate:D(160),followUpDone:true}],
    par:{classic:12} },

  { id:'ac053', name:'Summit Natural Foods', status:'active', isPbf:true,
    email:'buy@summitnaturalfoods.com', phone:'603-555-0053',
    address:'88 Summit Ave, Hanover, NH 03755', type:'Grocery',
    since:D(250), lastContacted:D(15),
    orderPortalToken:'token-ac053', orderPortalTokenCreatedAt:D(190), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Erin Bouchard',email:'buy@summitnaturalfoods.com',phone:'603-555-0053',isPrimary:true}],
    cadence:cad4(230),
    outreach:[oe(245,'email','Interested','Erin Bouchard','Trade show intro — LF interest.','both'),oe(230,'call','Ordered','Erin Bouchard','First order confirmed.','both'),oe(165,'email','Ordered','Erin Bouchard','Added LF candles.','both'),oe(80,'in-person','Ordered','Erin Bouchard','Restocked on visit.','both'),oe(15,'call','Needs Follow-Up','Erin Bouchard','Spring lineup.','both')],
    notes:[ne(245,'Strong natural foods focus. Both lines.')],
    samples:[{id:sid(),date:D(240),flavors:'LF Candle, LF Roll-On',notes:'LF intro samples',followUpDate:D(210),followUpDone:true}],
    par:{classic:24,blueberry:12} },

  { id:'ac054', name:'Coastal Market & Deli', status:'active', isPbf:false,
    email:'info@coastalmarketme.com', phone:'207-555-0054',
    address:'5 Harbor Rd, Rockland, ME 04841', type:'Specialty / Gift',
    since:D(215), lastContacted:D(55),
    orderPortalToken:'token-ac054', orderPortalTokenCreatedAt:D(165), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Brett Desjardins',email:'info@coastalmarketme.com',phone:'207-555-0054',isPrimary:true}],
    cadence:cad3(195),
    outreach:[oe(210,'email','Interested','Brett Desjardins','Coastal tourist market.','purpl'),oe(195,'call','Ordered','Brett Desjardins','First order — classic.','purpl'),oe(55,'email','No Response','Brett Desjardins','Reorder prompt sent.','purpl')],
    notes:[ne(210,'High summer traffic.')],
    samples:[],
    par:{classic:12} },

  { id:'ac055', name:'Wildflower Wellness Spa', status:'active', isPbf:true,
    email:'orders@wildflowerwellness.com', phone:'603-555-0055',
    address:'22 Bloom Rd, New London, NH 03257', type:'Spa / Wellness',
    since:D(280), lastContacted:D(10),
    orderPortalToken:'token-ac055', orderPortalTokenCreatedAt:D(220), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Lila Gagnon',email:'orders@wildflowerwellness.com',phone:'603-555-0055',isPrimary:true}],
    cadence:cad4(260),
    outreach:[oe(275,'email','Interested','Lila Gagnon','Inbound LF inquiry.','lf'),oe(260,'call','Ordered','Lila Gagnon','First LF order.','lf'),oe(200,'email','Ordered','Lila Gagnon','Reorder scrunchies.','lf'),oe(130,'in-person','Ordered','Lila Gagnon','Added LF bath salts.','lf'),oe(10,'call','Needs Follow-Up','Lila Gagnon','Shelf expansion.','lf')],
    notes:[ne(275,'Flagship LF retail account.')],
    samples:[{id:sid(),date:D(270),flavors:'LF Scrunchie, LF Linen Spray',notes:'First LF samples',followUpDate:D(250),followUpDone:true},{id:sid(),date:D(195),flavors:'LF Bath Salts',notes:'New SKU sample',followUpDate:D(180),followUpDone:true}],
    par:{} },

  { id:'ac056', name:'Cedar Ridge Country Store', status:'active', isPbf:false,
    email:'shop@cedarridgestore.com', phone:'603-555-0056',
    address:'77 Ridge Rd, Sutton, NH 03273', type:'Farm / Country Store',
    since:D(230), lastContacted:D(62),
    orderPortalToken:'token-ac056', orderPortalTokenCreatedAt:D(180), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Jake Morin',email:'shop@cedarridgestore.com',phone:'603-555-0056',isPrimary:true}],
    cadence:cad3(210),
    outreach:[oe(225,'email','Interested','Jake Morin','NH farm brands.','purpl'),oe(210,'call','Ordered','Jake Morin','First order.','purpl'),oe(62,'email','Needs Follow-Up','Jake Morin','Reorder reminder.','purpl')],
    notes:[ne(225,'Good local traffic. Classic only.')],
    samples:[],
    par:{classic:12} },

  { id:'ac057', name:'Stone Ridge Co-op', status:'active', isPbf:true,
    email:'wholesale@stoneridgecoop.org', phone:'802-555-0057',
    address:'11 Co-op Way, Barre, VT 05641', type:'Grocery',
    since:D(200), lastContacted:D(20),
    orderPortalToken:'token-ac057', orderPortalTokenCreatedAt:D(150), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Helen Nadeau',email:'wholesale@stoneridgecoop.org',phone:'802-555-0057',isPrimary:true}],
    cadence:cad4(180),
    outreach:[oe(195,'email','Interested','Helen Nadeau','Co-op buyer — local brands.','both'),oe(180,'call','Ordered','Helen Nadeau','First order — both lines.','both'),oe(120,'email','Ordered','Helen Nadeau','Second order.','both'),oe(20,'call','Ordered','Helen Nadeau','Spring restock.','both')],
    notes:[ne(195,'Strong co-op — 800+ members.')],
    samples:[{id:sid(),date:D(190),flavors:'Classic, Blueberry, Peach',notes:'Full classic line',followUpDate:D(170),followUpDone:true}],
    par:{classic:24,blueberry:12} },

  { id:'ac058', name:'Harbor Breeze Cafe', status:'active', isPbf:false,
    email:'cafe@harborbreeze.me', phone:'207-555-0058',
    address:'3 Wharf St, Camden, ME 04843', type:'Cafe / Coffee Shop',
    since:D(210), lastContacted:D(80),
    orderPortalToken:'token-ac058', orderPortalTokenCreatedAt:D(160), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Ron Thibodeau',email:'cafe@harborbreeze.me',phone:'207-555-0058',isPrimary:true}],
    cadence:cad3(190),
    outreach:[oe(205,'call','Interested','Ron Thibodeau','Tourist cafe — high summer volume.','purpl'),oe(190,'email','Ordered','Ron Thibodeau','First order.','purpl'),oe(80,'call','Needs Follow-Up','Ron Thibodeau','Pre-season check.','purpl')],
    notes:[ne(205,'Seasonal peak June–Aug. Raspberry mover.')],
    samples:[{id:sid(),date:D(195),flavors:'Raspberry',notes:'Summer menu sample',followUpDate:D(175),followUpDone:true}],
    par:{classic:12,raspberry:12} },

  { id:'ac059', name:'Petal & Vine Boutique', status:'active', isPbf:true,
    email:'info@petalandvine.com', phone:'802-555-0059',
    address:'6 Vine St, Middlebury, VT 05753', type:'Specialty / Gift',
    since:D(260), lastContacted:D(35),
    orderPortalToken:'token-ac059', orderPortalTokenCreatedAt:D(200), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Claire Boucher',email:'info@petalandvine.com',phone:'802-555-0059',isPrimary:true}],
    cadence:cad4(240),
    outreach:[oe(255,'email','Interested','Claire Boucher','Gift boutique — lavender branding.','lf'),oe(240,'call','Ordered','Claire Boucher','First LF order.','lf'),oe(180,'email','Ordered','Claire Boucher','Holiday restock.','lf'),oe(35,'call','Needs Follow-Up','Claire Boucher','Spring gift lineup.','lf')],
    notes:[ne(255,'Gift boutique with strong LF potential.')],
    samples:[{id:sid(),date:D(250),flavors:'LF Bath Salts, LF Candle',notes:'Gift samples',followUpDate:D(230),followUpDone:true}],
    par:{} },

  { id:'ac060', name:'Northwoods General Store', status:'active', isPbf:false,
    email:'store@northwoodsgeneral.com', phone:'603-555-0060',
    address:'44 Forest Rd, Colebrook, NH 03576', type:'Farm / Country Store',
    since:D(300), lastContacted:D(95),
    orderPortalToken:null, orderPortalTokenCreatedAt:null, fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Art Brunelle',email:'store@northwoodsgeneral.com',phone:'603-555-0060',isPrimary:true}],
    cadence:cad2(280),
    outreach:[oe(295,'email','Interested','Art Brunelle','Remote NH store — ordered once.','purpl'),oe(280,'call','Ordered','Art Brunelle','First order by phone.','purpl'),oe(95,'call','No Response','Art Brunelle','Left voicemail — no callback.','purpl')],
    notes:[ne(295,'Remote location. Slow reorder cycle.')],
    samples:[],
    par:{} },
  { id:'ac061', name:'Blue Mountain Market', status:'active', isPbf:true,
    email:'orders@bluemountainmkt.com', phone:'802-555-0061',
    address:'55 Summit St, Burlington, VT 05401', type:'Grocery',
    since:D(195), lastContacted:D(28),
    orderPortalToken:'token-ac061', orderPortalTokenCreatedAt:D(145), fulfilledBy:'dist001',
    contacts:[{id:sid(),name:'Meg Cyr',email:'orders@bluemountainmkt.com',phone:'802-555-0061',isPrimary:true}],
    cadence:cad3(175),
    outreach:[oe(190,'email','Interested','Meg Cyr','Referred by NENF.','purpl'),oe(175,'call','Ordered','Meg Cyr','First dist order.','purpl'),oe(28,'email','Ordered','Meg Cyr','Reorder via NENF.','purpl')],
    notes:[ne(190,'Served by NENF. Classic cases.')],
    samples:[{id:sid(),date:D(185),flavors:'Classic, Blueberry',notes:'Sent via NENF rep',followUpDate:D(160),followUpDone:true}],
    par:{classic:12,blueberry:12} },

  { id:'ac062', name:'Pine Hollow Farm Store', status:'active', isPbf:false,
    email:'farm@pinehollowfarm.com', phone:'603-555-0062',
    address:'19 Hollow Rd, Wentworth, NH 03282', type:'Farm / Country Store',
    since:D(220), lastContacted:D(46),
    orderPortalToken:null, orderPortalTokenCreatedAt:null, fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Dale Fournier',email:'farm@pinehollowfarm.com',phone:'603-555-0062',isPrimary:true}],
    cadence:cad2(200),
    outreach:[oe(215,'call','Interested','Dale Fournier','Small farm store — local brands.','purpl'),oe(200,'email','Ordered','Dale Fournier','First order confirmed.','purpl'),oe(46,'call','Needs Follow-Up','Dale Fournier','Pre-season reorder.','purpl')],
    notes:[ne(215,'Small farm store. Classic only.')],
    samples:[],
    par:{classic:12} },

  { id:'ac063', name:'Lakeside Natural Grocery', status:'active', isPbf:true,
    email:'buy@lakesidenaturalme.com', phone:'207-555-0063',
    address:'8 Lake Rd, Rangeley, ME 04970', type:'Grocery',
    since:D(245), lastContacted:D(18),
    orderPortalToken:'token-ac063', orderPortalTokenCreatedAt:D(185), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Bea Poulin',email:'buy@lakesidenaturalme.com',phone:'207-555-0063',isPrimary:true}],
    cadence:cad4(225),
    outreach:[oe(240,'email','Interested','Bea Poulin','Both lines — natural grocery.','both'),oe(225,'call','Ordered','Bea Poulin','First order.','both'),oe(165,'email','Ordered','Bea Poulin','Second reorder.','purpl'),oe(18,'call','Ordered','Bea Poulin','Spring restock.','purpl')],
    notes:[ne(240,'Lake resort area — tourist traffic.')],
    samples:[{id:sid(),date:D(235),flavors:'Classic, Raspberry',notes:'Sample pack',followUpDate:D(215),followUpDone:true}],
    par:{classic:12,raspberry:6} },

  { id:'ac064', name:'Ridgeline Co-op', status:'active', isPbf:true,
    email:'wholesale@ridgelinecoop.org', phone:'603-555-0064',
    address:'33 Ridgeline Blvd, Keene, NH 03431', type:'Grocery',
    since:D(270), lastContacted:D(12),
    orderPortalToken:'token-ac064', orderPortalTokenCreatedAt:D(210), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Mara Pelland',email:'wholesale@ridgelinecoop.org',phone:'603-555-0064',isPrimary:true}],
    cadence:cad4(250),
    outreach:[oe(265,'email','Interested','Mara Pelland','1200-member co-op — both lines.','both'),oe(250,'call','Ordered','Mara Pelland','Large first order.','purpl'),oe(195,'email','Ordered','Mara Pelland','Second order + LF candles.','both'),oe(12,'call','Ordered','Mara Pelland','Spring restock.','purpl')],
    notes:[ne(265,'Large co-op — big volume.')],
    samples:[{id:sid(),date:D(260),flavors:'Blueberry, Classic',notes:'Board presentation samples',followUpDate:D(240),followUpDone:true}],
    par:{classic:24,blueberry:12} },

  { id:'ac065', name:'Riverside Farm Market', status:'active', isPbf:false,
    email:'market@riversidefarmvt.com', phone:'802-555-0065',
    address:'6 River Rd, Woodstock, VT 05091', type:'Farm / Country Store',
    since:D(200), lastContacted:D(65),
    orderPortalToken:'token-ac065', orderPortalTokenCreatedAt:D(150), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Paul Lajeunesse',email:'market@riversidefarmvt.com',phone:'802-555-0065',isPrimary:true}],
    cadence:cad3(180),
    outreach:[oe(195,'call','Interested','Paul Lajeunesse','Tourist farm — spring/summer traffic.','purpl'),oe(180,'email','Ordered','Paul Lajeunesse','First order.','purpl'),oe(65,'call','Needs Follow-Up','Paul Lajeunesse','Pre-season check.','purpl')],
    notes:[ne(195,'Tourist-focused. Best May–Sept.')],
    samples:[],
    par:{classic:12} },

  { id:'ac066', name:'Cedar Bluff Provisions', status:'active', isPbf:true,
    email:'info@cedarbluffprovisions.com', phone:'207-555-0066',
    address:'12 Bluff Rd, Bar Harbor, ME 04609', type:'Specialty / Gift',
    since:D(290), lastContacted:D(25),
    orderPortalToken:'token-ac066', orderPortalTokenCreatedAt:D(230), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Faye Tremblay',email:'info@cedarbluffprovisions.com',phone:'207-555-0066',isPrimary:true}],
    cadence:cad4(270),
    outreach:[oe(285,'email','Interested','Faye Tremblay','Bar Harbor gift — tourist traffic.','both'),oe(270,'call','Ordered','Faye Tremblay','First combined order.','both'),oe(210,'in-person','Ordered','Faye Tremblay','Farm visit — added LF SKUs.','lf'),oe(25,'email','Ordered','Faye Tremblay','Pre-season restock.','both')],
    notes:[ne(285,'Premium gift shop — tourist destination.')],
    samples:[{id:sid(),date:D(280),flavors:'LF Sachet, LF Roll-On',notes:'LF pack',followUpDate:D(260),followUpDone:true},{id:sid(),date:D(205),flavors:'LF Linen Spray',notes:'New product',followUpDate:D(195),followUpDone:true}],
    par:{} },

  { id:'ac067', name:'White Peak Health Foods', status:'active', isPbf:false,
    email:'orders@whitepeakhealthfoods.com', phone:'603-555-0067',
    address:'7 Peak Rd, Lincoln, NH 03251', type:'Grocery',
    since:D(215), lastContacted:D(47),
    orderPortalToken:'token-ac067', orderPortalTokenCreatedAt:D(165), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Kate Boucher',email:'orders@whitepeakhealthfoods.com',phone:'603-555-0067',isPrimary:true}],
    cadence:cad3(195),
    outreach:[oe(210,'email','Interested','Kate Boucher','Natural grocery — NH brands.','purpl'),oe(195,'call','Ordered','Kate Boucher','First order placed.','purpl'),oe(47,'email','Needs Follow-Up','Kate Boucher','Reorder prompt sent.','purpl')],
    notes:[ne(210,'Ski-season traffic Nov–Mar.')],
    samples:[],
    par:{classic:12,raspberry:12} },

  { id:'ac068', name:'Champlain Valley Market', status:'active', isPbf:true,
    email:'buy@champlainvalleymarket.com', phone:'802-555-0068',
    address:'40 Valley Rd, Shelburne, VT 05482', type:'Grocery',
    since:D(230), lastContacted:D(20),
    orderPortalToken:'token-ac068', orderPortalTokenCreatedAt:D(175), fulfilledBy:'dist001',
    contacts:[{id:sid(),name:'Dan Couture',email:'buy@champlainvalleymarket.com',phone:'802-555-0068',isPrimary:true}],
    cadence:cad4(210),
    outreach:[oe(225,'email','Interested','Dan Couture','NENF-referred. Strong buyer.','both'),oe(210,'call','Ordered','Dan Couture','First dist order.','purpl'),oe(155,'email','Ordered','Dan Couture','Added LF candles.','both'),oe(20,'call','Ordered','Dan Couture','Spring restock.','purpl')],
    notes:[ne(225,'Dist-served. High summer volume.')],
    samples:[{id:sid(),date:D(220),flavors:'Classic, LF Candle',notes:'Dist intro samples',followUpDate:D(200),followUpDone:true}],
    par:{classic:24,blueberry:12} },

  { id:'ac069', name:'Moose Brook Farm Stand', status:'active', isPbf:false,
    email:'farm@moosebrookfarm.com', phone:'603-555-0069',
    address:'11 Brook Rd, Jefferson, NH 03583', type:'Farm / Country Store',
    since:D(310), lastContacted:D(100),
    orderPortalToken:null, orderPortalTokenCreatedAt:null, fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Hank Therrien',email:'farm@moosebrookfarm.com',phone:'603-555-0069',isPrimary:true}],
    cadence:cad2(290),
    outreach:[oe(305,'email','Interested','Hank Therrien','Remote NH farm.','purpl'),oe(290,'call','Ordered','Hank Therrien','First order.','purpl'),oe(100,'email','No Response','Hank Therrien','Reorder prompt — no response.','purpl')],
    notes:[ne(305,'Very remote. Slow cycle.')],
    samples:[],
    par:{} },

  { id:'ac070', name:'Tidal Reach Market', status:'active', isPbf:true,
    email:'shop@tidalreachmarket.com', phone:'207-555-0070',
    address:'9 Shore Rd, Kennebunkport, ME 04046', type:'Specialty / Gift',
    since:D(200), lastContacted:D(30),
    orderPortalToken:'token-ac070', orderPortalTokenCreatedAt:D(150), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Pia Charest',email:'shop@tidalreachmarket.com',phone:'207-555-0070',isPrimary:true}],
    cadence:cad3(180),
    outreach:[oe(195,'email','Interested','Pia Charest','Coastal gift — strong LF.','lf'),oe(180,'call','Ordered','Pia Charest','First LF order.','lf'),oe(30,'email','Ordered','Pia Charest','Spring LF restock.','lf')],
    notes:[ne(195,'Coastal gift — LF focus.')],
    samples:[{id:sid(),date:D(190),flavors:'LF Simple Syrup, LF Candle',notes:'LF gift samples',followUpDate:D(175),followUpDone:true}],
    par:{} },

  { id:'ac071', name:'Autumn Harvest Co-op', status:'active', isPbf:true,
    email:'wholesale@autumnharvestcoop.org', phone:'802-555-0071',
    address:'21 Harvest Way, Brattleboro, VT 05301', type:'Grocery',
    since:D(195), lastContacted:D(18),
    orderPortalToken:'token-ac071', orderPortalTokenCreatedAt:D(145), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Nadia Roy',email:'wholesale@autumnharvestcoop.org',phone:'802-555-0071',isPrimary:true}],
    cadence:cad4(175),
    outreach:[oe(190,'email','Interested','Nadia Roy','Co-op — both brands.','both'),oe(175,'call','Ordered','Nadia Roy','First combined order.','both'),oe(110,'email','Ordered','Nadia Roy','Second reorder.','purpl'),oe(18,'call','Ordered','Nadia Roy','Spring restock.','purpl')],
    notes:[ne(190,'Brattleboro co-op.')],
    samples:[{id:sid(),date:D(185),flavors:'Classic, Blueberry, Variety',notes:'Full line tasting',followUpDate:D(165),followUpDone:true}],
    par:{classic:24,blueberry:12} },

  { id:'ac072', name:'Island View Market', status:'active', isPbf:false,
    email:'orders@islandviewmarket.com', phone:'207-555-0072',
    address:'15 Bay Rd, Islesboro, ME 04848', type:'Grocery',
    since:D(250), lastContacted:D(68),
    orderPortalToken:null, orderPortalTokenCreatedAt:null, fulfilledBy:'dist002',
    contacts:[{id:sid(),name:'Cal Paquin',email:'orders@islandviewmarket.com',phone:'207-555-0072',isPrimary:true}],
    cadence:cad3(230),
    outreach:[oe(245,'email','Interested','Cal Paquin','Island grocery — dist-served.','purpl'),oe(230,'call','Ordered','Cal Paquin','First dist order.','purpl'),oe(68,'email','Needs Follow-Up','Cal Paquin','Reorder check.','purpl')],
    notes:[ne(245,'Island market — dist delivery only.')],
    samples:[],
    par:{classic:12} },

  { id:'ac073', name:'Forest Edge Bakery', status:'active', isPbf:false,
    email:'cafe@forestedgebakery.com', phone:'603-555-0073',
    address:'3 Forest Dr, Jaffrey, NH 03452', type:'Cafe / Coffee Shop',
    since:D(225), lastContacted:D(43),
    orderPortalToken:'token-ac073', orderPortalTokenCreatedAt:D(175), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Lucy Comeau',email:'cafe@forestedgebakery.com',phone:'603-555-0073',isPrimary:true}],
    cadence:cad3(205),
    outreach:[oe(220,'email','Interested','Lucy Comeau','Artisan bakery — cans pair well.','purpl'),oe(205,'call','Ordered','Lucy Comeau','First order — classic + peach.','purpl'),oe(43,'email','Needs Follow-Up','Lucy Comeau','Reorder invoice sent.','purpl')],
    notes:[ne(220,'Bakery/cafe combo. Good foot traffic.')],
    samples:[],
    par:{classic:12,peach:12} },

  { id:'ac074', name:'Maple Bluff Wellness', status:'active', isPbf:true,
    email:'wellness@maplepluff.com', phone:'802-555-0074',
    address:'5 Bluff Rd, Stowe, VT 05672', type:'Spa / Wellness',
    since:D(260), lastContacted:D(15),
    orderPortalToken:'token-ac074', orderPortalTokenCreatedAt:D(200), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Simone Gervais',email:'wellness@maplepluff.com',phone:'802-555-0074',isPrimary:true}],
    cadence:cad4(240),
    outreach:[oe(255,'email','Interested','Simone Gervais','Stowe resort spa.','lf'),oe(240,'call','Ordered','Simone Gervais','Large LF intro order.','lf'),oe(180,'in-person','Ordered','Simone Gervais','Added new SKUs.','lf'),oe(15,'call','Needs Follow-Up','Simone Gervais','Spring refresh.','lf')],
    notes:[ne(255,'Premium resort spa in Stowe.')],
    samples:[{id:sid(),date:D(250),flavors:'LF Scrunchie, LF Bath Salts',notes:'Spa retail samples',followUpDate:D(235),followUpDone:true},{id:sid(),date:D(175),flavors:'LF Roll-On',notes:'New SKU sample',followUpDate:D(165),followUpDone:true}],
    par:{} },

  { id:'ac075', name:'Tidal Flat Provisions', status:'active', isPbf:true,
    email:'orders@tidalflatprovisions.com', phone:'207-555-0075',
    address:'17 Flat Rd, Portland, ME 04101', type:'Specialty / Gift',
    since:D(280), lastContacted:D(22),
    orderPortalToken:'token-ac075', orderPortalTokenCreatedAt:D(220), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Gwen Leclair',email:'orders@tidalflatprovisions.com',phone:'207-555-0075',isPrimary:true}],
    cadence:cad4(260),
    outreach:[oe(275,'email','Interested','Gwen Leclair','Portland ME gift — local brands.','both'),oe(260,'call','Ordered','Gwen Leclair','First combined order.','both'),oe(200,'email','Ordered','Gwen Leclair','Holiday restock.','both'),oe(22,'call','Ordered','Gwen Leclair','Spring restock.','both')],
    notes:[ne(275,'Strong gift shop in Portland.')],
    samples:[{id:sid(),date:D(270),flavors:'LF Candle, LF Sachet',notes:'LF gift samples',followUpDate:D(255),followUpDone:true}],
    par:{} },

  { id:'ac076', name:'Green Mountain Grocery', status:'active', isPbf:false,
    email:'buy@greenmountaingrocery.com', phone:'802-555-0076',
    address:'10 Mountain Rd, Rutland, VT 05701', type:'Grocery',
    since:D(195), lastContacted:D(38),
    orderPortalToken:null, orderPortalTokenCreatedAt:null, fulfilledBy:'dist001',
    contacts:[{id:sid(),name:'Zach Pelletier',email:'buy@greenmountaingrocery.com',phone:'802-555-0076',isPrimary:true}],
    cadence:cad3(175),
    outreach:[oe(190,'email','Interested','Zach Pelletier','VT grocery — NENF-served.','purpl'),oe(175,'call','Ordered','Zach Pelletier','First order via NENF.','purpl'),oe(38,'email','Ordered','Zach Pelletier','Reorder.','purpl')],
    notes:[ne(190,'Dist-served account.')],
    samples:[{id:sid(),date:D(185),flavors:'Classic',notes:'Sample via dist rep',followUpDate:D(170),followUpDone:true}],
    par:{classic:12} },

  { id:'ac077', name:'Sap House Market', status:'active', isPbf:false,
    email:'info@saphousemarket.com', phone:'603-555-0077',
    address:'8 Sap Lane, Center Ossipee, NH 03814', type:'Farm / Country Store',
    since:D(240), lastContacted:D(50),
    orderPortalToken:'token-ac077', orderPortalTokenCreatedAt:D(185), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Russ Labrie',email:'info@saphousemarket.com',phone:'603-555-0077',isPrimary:true}],
    cadence:cad3(220),
    outreach:[oe(235,'email','Interested','Russ Labrie','NH farm — maple focus.','purpl'),oe(220,'call','Ordered','Russ Labrie','First order.','purpl'),oe(50,'email','Needs Follow-Up','Russ Labrie','Reorder prompt.','purpl')],
    notes:[ne(235,'Maple farm with strong local focus.')],
    samples:[{id:sid(),date:D(225),flavors:'Classic, Peach',notes:'Classic + peach tasting',followUpDate:D(210),followUpDone:true}],
    par:{classic:12,peach:12} },

  { id:'ac078', name:'Birch Tree Natural Foods', status:'active', isPbf:true,
    email:'orders@birchtreenaturals.com', phone:'207-555-0078',
    address:'22 Birch St, Augusta, ME 04330', type:'Grocery',
    since:D(220), lastContacted:D(12),
    orderPortalToken:'token-ac078', orderPortalTokenCreatedAt:D(165), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Iris Gaudet',email:'orders@birchtreenaturals.com',phone:'207-555-0078',isPrimary:true}],
    cadence:cad4(200),
    outreach:[oe(215,'email','Interested','Iris Gaudet','Natural foods — NH/VT brands.','both'),oe(200,'call','Ordered','Iris Gaudet','First combined order.','both'),oe(140,'email','Ordered','Iris Gaudet','Second order.','purpl'),oe(12,'call','Ordered','Iris Gaudet','Spring restock.','purpl')],
    notes:[ne(215,'Maine natural foods — both lines.')],
    samples:[{id:sid(),date:D(210),flavors:'Classic',notes:'Classic intro sample',followUpDate:D(195),followUpDone:true},{id:sid(),date:D(195),flavors:'Blueberry, Peach',notes:'New flavor samples',followUpDate:D(185),followUpDone:true}],
    par:{classic:24,blueberry:12} },

  { id:'ac079', name:'Cobblestone Country Store', status:'active', isPbf:false,
    email:'store@cobblestonecountry.com', phone:'603-555-0079',
    address:'3 Cobble Rd, Hillsborough, NH 03244', type:'Specialty / Gift',
    since:D(310), lastContacted:D(105),
    orderPortalToken:null, orderPortalTokenCreatedAt:null, fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Mike Cormier',email:'store@cobblestonecountry.com',phone:'603-555-0079',isPrimary:true}],
    cadence:cad2(290),
    outreach:[oe(305,'call','Interested','Mike Cormier','Old NH country store.','purpl'),oe(290,'email','Ordered','Mike Cormier','First order confirmed.','purpl'),oe(105,'call','No Response','Mike Cormier','Left voicemail — no response.','purpl')],
    notes:[ne(305,'Rural NH. Slow reorder cycle.')],
    samples:[],
    par:{} },

  { id:'ac080', name:'Fox Run Co-op', status:'active', isPbf:true,
    email:'wholesale@foxruncoop.org', phone:'802-555-0080',
    address:'14 Fox Run Rd, St. Johnsbury, VT 05819', type:'Grocery',
    since:D(195), lastContacted:D(10),
    orderPortalToken:'token-ac080', orderPortalTokenCreatedAt:D(145), fulfilledBy:'direct',
    contacts:[{id:sid(),name:'Petra Michaud',email:'wholesale@foxruncoop.org',phone:'802-555-0080',isPrimary:true}],
    cadence:cad4(175),
    outreach:[oe(190,'email','Interested','Petra Michaud','NE VT co-op — both lines.','both'),oe(175,'call','Ordered','Petra Michaud','First combined order.','both'),oe(120,'email','Ordered','Petra Michaud','Second reorder.','purpl'),oe(10,'call','Ordered','Petra Michaud','Spring restock.','purpl')],
    notes:[ne(190,'St. Johnsbury co-op — loyal customers.')],
    samples:[{id:sid(),date:D(185),flavors:'Classic, Blueberry',notes:'Opening samples',followUpDate:D(170),followUpDone:true},{id:sid(),date:D(168),flavors:'LF Simple Syrup',notes:'LF intro sample',followUpDate:D(155),followUpDone:true},{id:sid(),date:D(115),flavors:'LF Candle, LF Roll-On',notes:'LF expansion samples',followUpDate:D(100),followUpDone:true}],
    par:{classic:24,blueberry:12} },
];

module.exports = { extraAccounts };

// =============================================================
//  PRODUCTION RUNS (ph021–ph028) — 8 runs back to D(360)
//  Each run: {id, date, notes, cans, ...skus(cases)}
// =============================================================
const productionRuns = [
  { id:'ph021', date:D(365), notes:'Pre-season large opening run',  classic:240, blueberry:120, raspberry:72, peach:48, variety:48, cans:(240+120+72+48+48)*12 },
  { id:'ph022', date:D(330), notes:'Late-summer batch',             classic:144, blueberry:72,  peach:48,     variety:36,             cans:(144+72+48+36)*12 },
  { id:'ph023', date:D(300), notes:'Fall classic + raspberry push', classic:120, raspberry:48,  blueberry:36,                          cans:(120+48+36)*12 },
  { id:'ph024', date:D(270), notes:'Holiday mix run',               classic:96,  blueberry:60,  peach:36,     variety:24,             cans:(96+60+36+24)*12 },
  { id:'ph025', date:D(240), notes:'Winter classic + blueberry',    classic:120, blueberry:48,  raspberry:36, variety:24,             cans:(120+48+36+24)*12 },
  { id:'ph026', date:D(210), notes:'Early spring production',       classic:96,  blueberry:60,  peach:36,     variety:12,             cans:(96+60+36+12)*12 },
  { id:'ph027', date:D(195), notes:'NENF distributor prep run',     classic:120, raspberry:48,  blueberry:36, peach:12,               cans:(120+48+36+12)*12 },
  { id:'ph028', date:D(185), notes:'Account restock run',           classic:96,  blueberry:36,  variety:24,   peach:12,               cans:(96+36+24+12)*12 },
  { id:'ph029', date:D(180), notes:'Spring demand buffer run',      classic:120, blueberry:48,  raspberry:36, peach:24, variety:24,   cans:(120+48+36+24+24)*12 },
];

module.exports = { extraAccounts, productionRuns };

// =============================================================
//  ORDERS (~265 new orders for ac025–ac080)
// =============================================================
const orders = (() => {
  const CPC = 12;
  const rows = [];
  let _on = 41;
  const oid = () => `ord${String(_on++).padStart(3,'0')}`;
  const SKUS = ['classic','blueberry','raspberry','peach','variety'];

  // ac025–ac050 (26 existing accounts without orders) + ac051–ac080 (30 new) = 56
  const pool = [
    'ac025','ac026','ac027','ac028','ac029','ac030',
    'ac031','ac032','ac033','ac034','ac035','ac036',
    'ac037','ac038','ac039','ac040','ac041','ac042',
    'ac043','ac044','ac045','ac046','ac047','ac048',
    'ac049','ac050',
    'ac051','ac052','ac053','ac054','ac055','ac056',
    'ac057','ac058','ac059','ac060','ac061','ac062',
    'ac063','ac064','ac065','ac066','ac067','ac068',
    'ac069','ac070','ac071','ac072','ac073','ac074',
    'ac075','ac076','ac077','ac078','ac079','ac080',
  ];

  // 5 orders per account — varied last-order date to exercise going-cold tiers
  const PATTERNS = [
    [[175,'delivered'],[130,'delivered'],[85,'delivered'],[40,'delivered'],[10,'pending']],   // last=10d  active
    [[175,'delivered'],[120,'delivered'],[75,'delivered'],[30,'delivered'],[15,'delivered']], // last=15d  active
    [[170,'delivered'],[125,'delivered'],[80,'delivered'],[55,'delivered'],[50,'delivered']], // last=50d  tier-1
    [[175,'delivered'],[130,'delivered'],[90,'delivered'],[75,'delivered'],[65,'delivered']], // last=65d  tier-2
    [[175,'delivered'],[135,'delivered'],[115,'delivered'],[110,'delivered'],[95,'delivered']],// last=95d  tier-3
  ];

  pool.forEach((acId, i) => {
    const pattern = PATTERNS[i % PATTERNS.length];
    pattern.forEach(([daysAgo, status], j) => {
      const sku1 = SKUS[(i + j) % 5];
      const sku2 = SKUS[(i + j + 1) % 5];
      const qty1 = 4 + (i % 4);          // 4–7 cases
      const addSku2 = (i + j) % 2 === 0;
      const qty2 = 2 + (j % 3);          // 2–4 cases
      const d = Math.max(1, daysAgo + (i % 5) - 2);
      rows.push({
        id: oid(),
        accountId: acId,
        created: D(d),
        dueDate: D(d),
        status,
        items: [
          { sku: sku1, qty: qty1 },
          ...(addSku2 ? [{ sku: sku2, qty: qty2 }] : []),
        ],
        canCount: (qty1 + (addSku2 ? qty2 : 0)) * CPC,
        source: 'manual',
        externalId: '',
        importedAt: D(d),
      });
    });
  });
  return rows;
})();

module.exports = { extraAccounts, productionRuns, orders };

// =============================================================
//  INVOICES — 200 total
//  iv031–iv130: 100 post-drop-off purpl (one per delivered order)
//  iv131–iv170:  40 manual purpl
//  lf016–lf045:  30 LF
//  dinv011–dinv040: 30 dist
// =============================================================
const invoices = (() => {
  const CPC = 12;
  const UNIT = 2.50;
  const rows = [];

  // ── AC name map for invoices ─────────────────────────────
  const NAMES = {
    ac025:'Brookside Natural Foods',  ac026:'Riverbank Cafe',
    ac027:'Skyline Farm Market',      ac028:'Harbor Light Market',
    ac029:'Fern Valley Co-op',        ac030:'Thornwood Apothecary',
    ac031:'Green Leaf Spa',           ac032:'Lavender Lane Gift Shop',
    ac033:'Wellspring Wellness Center',ac034:'Blossom & Bloom Boutique',
    ac035:'The Herbal Haven',         ac036:'Summit Sports & Cafe',
    ac037:'Millbrook Market',         ac038:'Granite State Co-op',
    ac039:'Seacoast Natural Foods',   ac040:'The Corner Store',
    ac041:'Hilltop Country Store',    ac042:'Valley Fresh Market',
    ac043:'White Mountain Grocery',   ac044:'Lakes Region Market',
    ac045:'Monadnock Co-op',          ac046:'Pioneer Valley Foods',
    ac047:'Bay State Grocery',        ac048:'Cape Ann Natural Foods',
    ac049:'Upper Valley Co-op',       ac050:'North Shore Provisions',
    ac051:'Morning Dew Farm Stand',   ac052:'Hillside Harvest Market',
    ac053:'Summit Natural Foods',     ac054:'Coastal Market & Deli',
    ac055:'Wildflower Wellness Spa',  ac056:'Cedar Ridge Country Store',
    ac057:'Stone Ridge Co-op',        ac058:'Harbor Breeze Cafe',
    ac059:'Petal & Vine Boutique',    ac060:'Northwoods General Store',
    ac061:'Blue Mountain Market',     ac062:'Pine Hollow Farm Store',
    ac063:'Lakeside Natural Grocery', ac064:'Ridgeline Co-op',
    ac065:'Riverside Farm Market',    ac066:'Cedar Bluff Provisions',
    ac067:'White Peak Health Foods',  ac068:'Champlain Valley Market',
    ac069:'Moose Brook Farm Stand',   ac070:'Tidal Reach Market',
    ac071:'Autumn Harvest Co-op',     ac072:'Island View Market',
    ac073:'Forest Edge Bakery',       ac074:'Maple Bluff Wellness',
    ac075:'Tidal Flat Provisions',    ac076:'Green Mountain Grocery',
    ac077:'Sap House Market',         ac078:'Birch Tree Natural Foods',
    ac079:'Cobblestone Country Store',ac080:'Fox Run Co-op',
  };
  const acName = id => NAMES[id] || id;

  // ── 100 post-drop-off purpl (iv031–iv130) ────────────────
  const eligible = orders.filter(o =>
    o.status === 'delivered' && o.created <= D(30)
  ).slice(0, 100);
  eligible.forEach((ord, i) => {
    const num = 31 + i;
    const issueDate = ord.created;
    const bd = new Date('2026-04-02T12:00:00Z');
    const od = new Date(issueDate + 'T12:00:00Z');
    const daysAgo = Math.round((bd - od) / 86400000);
    const dueDaysAgo = Math.max(0, daysAgo - 30);
    const lineItems = ord.items.map(it => ({
      sku: it.sku, qty: it.qty * CPC, cases: it.qty,
      unitPrice: UNIT, total: Math.round(it.qty * CPC * UNIT * 100) / 100,
      description: it.sku.charAt(0).toUpperCase() + it.sku.slice(1) + ' 12-pk',
    }));
    const amount = lineItems.reduce((s, l) => s + l.total, 0);
    rows.push({
      type: 'purpl', id: `iv${String(num).padStart(3,'0')}`,
      number: `PBF-${String(num).padStart(3,'0')}`,
      accountId: ord.accountId, accountName: acName(ord.accountId),
      issued: issueDate, due: D(dueDaysAgo),
      amount: Math.round(amount * 100) / 100,
      status: daysAgo >= 60 ? 'paid' : 'unpaid',
      lineItems, notes: '', combinedInvoiceId: null,
    });
  });

  // ── 40 manual purpl (iv131–iv170) ───────────────────────
  const MACCTS = [
    'ac025','ac026','ac028','ac029','ac031','ac033','ac038','ac039',
    'ac045','ac049','ac051','ac053','ac057','ac063','ac064','ac068',
    'ac071','ac075','ac078','ac080','ac001','ac002','ac008','ac011',
    'ac013','ac035','ac036','ac043','ac044','ac047',
  ];
  const MDAYS = [170,155,140,125,110,95,80,65,50,40,30,20,15,10,7,
                 168,152,138,122,108,93,77,62,48,38,28,18,13,8,5,
                 175,160,145,130,115,100,85,70,55,45];
  const MSKUS = ['classic','blueberry','raspberry','peach','variety'];
  for (let i = 0; i < 40; i++) {
    const num = 131 + i;
    const acId = MACCTS[i % MACCTS.length];
    const daysAgo = MDAYS[i];
    const dueDaysAgo = Math.max(0, daysAgo - 30);
    const sku = MSKUS[i % 5];
    const cases = 6 + (i % 7);
    const qty = cases * CPC;
    const total = Math.round(qty * UNIT * 100) / 100;
    rows.push({
      type: 'purpl', id: `iv${String(num).padStart(3,'0')}`,
      number: `PBF-${String(num).padStart(3,'0')}`,
      accountId: acId, accountName: acName(acId),
      issued: D(daysAgo), due: D(dueDaysAgo),
      amount: total,
      status: daysAgo >= 45 ? 'paid' : 'unpaid',
      lineItems: [{ sku, qty, cases, unitPrice: UNIT, total,
        description: sku.charAt(0).toUpperCase() + sku.slice(1) + ' 12-pk' }],
      notes: '', combinedInvoiceId: null,
    });
  }

  // ── 30 LF invoices (lf016–lf045) ────────────────────────
  const LF_ACCTS = [
    'ac051','ac053','ac055','ac057','ac059','ac061','ac063','ac064',
    'ac066','ac068','ac070','ac071','ac074','ac075','ac078','ac080',
    'ac005','ac011','ac013','ac014','ac031','ac033','ac035','ac045',
    'ac049','ac030','ac029','ac038','ac039','ac048',
  ];
  const LF_ITEMS = [
    {skuId:'lf-candle',         skuName:'Soy Candle',               price:14.99, caseSize:12},
    {skuId:'lf-roll-on',        skuName:'Aromatherapy Roll-On',     price:9.99,  caseSize:24},
    {skuId:'lf-simple-syrup-sm',skuName:'Lavender Simple Syrup 12.7oz',price:8.99,caseSize:12},
    {skuId:'lf-scrunchie',      skuName:'Aromatherapy Scrunchie',   price:7.49,  caseSize:6 },
    {skuId:'lf-sachet',         skuName:'Seatbelt Sachet',          price:4.99,  caseSize:12},
    {skuId:'lf-bath-salts',     skuName:'Lavender Bath Salts 8oz',  price:6.99,  caseSize:12},
    {skuId:'lf-linen-spray',    skuName:'Lavender Linen Spray 8oz', price:9.49,  caseSize:12},
    {skuId:'lf-refresh-powder', skuName:'Lavender Refresh Powder',  price:4.99,  caseSize:12},
  ];
  const LF_DAYS = [260,240,220,205,195,185,175,165,155,145,135,120,110,100,
                   90,80,70,60,50,45,40,35,30,25,22,18,15,12,8,5];
  LF_ACCTS.forEach((acId, i) => {
    const num = 16 + i;
    const item = LF_ITEMS[i % LF_ITEMS.length];
    const units = item.caseSize * (2 + (i % 3));
    const lineTotal = Math.round(units * item.price * 100) / 100;
    const daysAgo = LF_DAYS[i];
    const dueDaysAgo = Math.max(0, daysAgo - 30);
    rows.push({
      type: 'lf', id: `lf${String(num).padStart(3,'0')}`,
      number: `LF-${String(num).padStart(3,'0')}`,
      accountId: acId, accountName: acName(acId),
      issued: D(daysAgo), due: D(dueDaysAgo),
      total: lineTotal,
      status: daysAgo >= 45 ? 'paid' : 'unpaid',
      lineItems: [{ skuId: item.skuId, skuName: item.skuName,
        units, caseSize: item.caseSize, wholesalePrice: item.price,
        lineTotal, hasVariants: false }],
      wixPulled: false, combinedInvoiceId: null, source: 'manual', notes: '',
    });
  });

  // ── 30 dist invoices (dinv011–dinv040) ─────────────────
  const DDAYS = [175,165,155,145,135,125,115,105,95,85,75,65,55,45,35];
  const D1_SKUS = ['classic','blueberry','classic','raspberry','classic'];
  const D2_SKUS = ['raspberry','classic','blueberry','classic','peach'];
  DDAYS.forEach((daysAgo, i) => {
    // dist001
    const c1a = 24 + (i % 13) * 4, c2a = 12 + (i % 7) * 4;
    rows.push({
      type: 'dist', id: `dinv${String(11+i).padStart(3,'0')}`,
      distId: 'dist001',
      invoiceNumber: `NENF-26${String(i+1).padStart(2,'0')}`,
      dateIssued: D(daysAgo), dueDate: D(Math.max(0, daysAgo-30)),
      poRef: `PO-26${String(i+1).padStart(2,'0')}`, externalRef: '',
      status: daysAgo >= 45 ? 'paid' : 'unpaid',
      items: [{sku:D1_SKUS[i%5],cases:c1a,pricePerCase:26.00},{sku:D2_SKUS[i%5],cases:c2a,pricePerCase:26.00}],
      total: Math.round((c1a+c2a)*26.00*100)/100,
      notes: `NENF batch ${i+1}.`,
    });
    // dist002
    const c1b = 20 + (i % 11) * 4, c2b = 12 + (i % 6) * 4;
    rows.push({
      type: 'dist', id: `dinv${String(26+i).padStart(3,'0')}`,
      distId: 'dist002',
      invoiceNumber: `NEBEV-26${String(i+1).padStart(2,'0')}`,
      dateIssued: D(daysAgo), dueDate: D(Math.max(0, daysAgo-30)),
      poRef: '', externalRef: `NEB-20${String(i+1).padStart(2,'0')}`,
      status: daysAgo >= 45 ? 'paid' : 'unpaid',
      items: [{sku:D2_SKUS[i%5],cases:c1b,pricePerCase:27.00},{sku:D1_SKUS[i%5],cases:c2b,pricePerCase:27.00}],
      total: Math.round((c1b+c2b)*27.00*100)/100,
      notes: `NEBEV batch ${i+1}.`,
    });
  });

  return rows;
})();

module.exports = { extraAccounts, productionRuns, orders, invoices };

// =============================================================
//  PORTAL INQUIRIES (10 wholesale applications)
// =============================================================
const portalInquiries = [
  { id:'inq001', businessName:'Maple Hill Co-op',      contactName:'Dana Cross',    email:'dana@maplehillcoop.com',    phone:'802-555-2001', city:'St. Albans',  state:'VT', businessType:'Grocery',         message:'Interested in wholesale purpl and LF.', status:'new',      submittedAt:new Date(new Date('2026-04-02').getTime()-2*864e5),  isPbf:true  },
  { id:'inq002', businessName:'Seaport Natural Foods', contactName:'Tom Lacasse',   email:'tom@seaportnatural.com',    phone:'207-555-2002', city:'Bath',        state:'ME', businessType:'Grocery',         message:'Local NH beverages — classic + blueberry.', status:'new', submittedAt:new Date(new Date('2026-04-02').getTime()-4*864e5),  isPbf:false },
  { id:'inq003', businessName:'Granite Peak Wellness', contactName:'Amy Fortin',    email:'amy@granitpeakwellness.com',phone:'603-555-2003', city:'Concord',     state:'NH', businessType:'Spa / Wellness',  message:'Very interested in the LF line.',   status:'new',      submittedAt:new Date(new Date('2026-04-02').getTime()-5*864e5),  isPbf:true  },
  { id:'inq004', businessName:'Blue Spruce Farm Stand',contactName:'Ned Lavoie',    email:'ned@bluesprucestand.com',   phone:'603-555-2004', city:'Goffstown',   state:'NH', businessType:'Farm / Country Store',message:'Small farm stand — classic.',       status:'reviewed', submittedAt:new Date(new Date('2026-04-02').getTime()-10*864e5), isPbf:false },
  { id:'inq005', businessName:'Mountain Brook Market', contactName:'Rae Bissonette',email:'rae@mountainbrookmkt.com', phone:'802-555-2005', city:'Warren',      state:'VT', businessType:'Grocery',         message:'New market opening May. Local brands.', status:'new',  submittedAt:new Date(new Date('2026-04-02').getTime()-1*864e5),  isPbf:false },
  { id:'inq006', businessName:'Shoreline Gift & Spa',  contactName:'Vera Caron',    email:'vera@shorelinegiftspa.com', phone:'207-555-2006', city:'Ogunquit',    state:'ME', businessType:'Spa / Wellness',  message:'Resort spa — premium LF products.', status:'new',      submittedAt:new Date(new Date('2026-04-02').getTime()-3*864e5),  isPbf:true  },
  { id:'inq007', businessName:'Valley Provisions',     contactName:'Josh Hebert',   email:'josh@valleyprovisions.com', phone:'603-555-2007', city:'Hillsborough',state:'NH', businessType:'Specialty / Gift','message':'Both lines — purpl and LF.',      status:'new',      submittedAt:new Date(new Date('2026-04-02').getTime()-6*864e5),  isPbf:true  },
  { id:'inq008', businessName:'Pinewoods Natural Co.', contactName:'Bev Arsenault', email:'bev@pinewoodsnaturalco.com',phone:'603-555-2008', city:'Meredith',    state:'NH', businessType:'Grocery',         message:'Natural grocery — local beverages.', status:'reviewed',submittedAt:new Date(new Date('2026-04-02').getTime()-12*864e5), isPbf:false },
  { id:'inq009', businessName:'Autumn Moon Boutique',  contactName:'Gail Roux',     email:'gail@autumnmoonboutique.com',phone:'802-555-2009',city:'Woodstock',   state:'VT', businessType:'Specialty / Gift','message':'Gift boutique — lavender artisan.', status:'new',     submittedAt:new Date(new Date('2026-04-02').getTime()-7*864e5),  isPbf:true  },
  { id:'inq010', businessName:'Trailhead General Store',contactName:'Mike Dufresne',email:'mike@trailheadgeneral.com', phone:'603-555-2010', city:'Lincoln',     state:'NH', businessType:'Farm / Country Store',message:'Adventure store — classic cans.',   status:'new',      submittedAt:new Date(new Date('2026-04-02').getTime()-8*864e5),  isPbf:false },
];

// =============================================================
//  AUDIT LOG (80 entries spread over last 360 days)
// =============================================================
const auditLog = (() => {
  const rows = [];
  const ACTIONS = ['create','update','delete','create','update'];
  const TYPES   = ['account','invoice','order','account','invoice'];
  const ENTITIES = [
    ['ac001','Harvest Moon Co-op'],    ['ac008','Pinebrook Deli'],
    ['ac013','Heritage Farm Store'],   ['iv001','PBF-001'],
    ['iv006','PBF-006'],               ['ord001','Harvest Moon Co-op'],
    ['ac051','Morning Dew Farm Stand'],['ac053','Summit Natural Foods'],
    ['iv031','PBF-031'],               ['ord041','Brookside Natural Foods'],
    ['ac064','Ridgeline Co-op'],       ['ac071','Autumn Harvest Co-op'],
    ['iv100','PBF-100'],               ['ord099','Autumn Harvest Co-op'],
    ['ac002','Green Valley Market'],   ['iv009','PBF-009'],
    ['ac057','Stone Ridge Co-op'],     ['ac078','Birch Tree Natural Foods'],
    ['iv050','PBF-050'],               ['ord120','Champlain Valley Market'],
  ];
  for (let i = 0; i < 80; i++) {
    const entity = ENTITIES[i % ENTITIES.length];
    rows.push({
      id: `al${String(i+1).padStart(3,'0')}`,
      timestamp: new Date(new Date('2026-04-02').getTime() - Math.floor((360 - i*4.4)*864e5)).toISOString(),
      action:     ACTIONS[i % ACTIONS.length],
      entityType: TYPES[i % TYPES.length],
      entityId:   entity[0],
      entityName: entity[1],
      changedBy:  'graham',
    });
  }
  return rows;
})();

module.exports = { extraAccounts, productionRuns, orders, invoices, portalInquiries, auditLog };

// ── Flat outreach array (for existing accounts ac001–ac050) ───────────────
const outreach = (() => {
  const rows = [];
  const TYPES = ['call','email','visit','text'];
  const OUTCOMES = ['positive','neutral','no_response','left_voicemail'];
  const ACCTS = [
    ['ac001','Main St Market'],['ac002','Green Valley Market'],['ac003','Blue Sky Grocers'],
    ['ac004','Harbor Foods'],  ['ac005','Ridgeline Co-op'],   ['ac006','Summit Natural'],
    ['ac007','Maple Grove'],   ['ac008','Cedar Falls Market'],['ac009','Pine Ridge Foods'],
    ['ac010','Valley Natural'],['ac011','Lakeshore Grocery'], ['ac012','Highpoint Market'],
    ['ac013','Riverwalk Foods'],['ac014','Briarwood Coop'],   ['ac015','Elmswood Natural'],
  ];
  const NOTES = [
    'Checked in on reorder timing',
    'Followed up on last shipment',
    'Discussed summer promo opportunity',
    'Left message about new flavors',
    'Confirmed upcoming order',
    'Reviewed invoice status',
    'Asked about shelf placement',
    'Touched base after delivery',
  ];
  let daysAgo = 175;
  for (let i = 0; i < 60; i++) {
    const acct = ACCTS[i % ACCTS.length];
    rows.push({
      id: sid(),
      accountId: acct[0],
      accountName: acct[1],
      date: D(daysAgo),
      type: TYPES[i % TYPES.length],
      outcome: OUTCOMES[i % OUTCOMES.length],
      contact: 'buyer',
      notes: NOTES[i % NOTES.length],
      regarding: 'purpl',
    });
    daysAgo = Math.max(3, daysAgo - 2);
  }
  return rows;
})();

// ── Flat samples array (25 entries for existing + new accounts) ───────────
const samples = (() => {
  const rows = [];
  const SKUS = ['purpl-classic-12','purpl-blueberry-12','purpl-raspberry-12','purpl-peach-12','purpl-variety-12'];
  const ACCTS = [
    'ac001','ac003','ac005','ac008','ac011','ac014','ac017','ac020',
    'ac051','ac052','ac053','ac055','ac058','ac061','ac065','ac068',
    'ac070','ac072','ac075','ac077','ac079','ac080','ac054','ac060','ac063',
  ];
  for (let i = 0; i < 25; i++) {
    rows.push({
      id: sid(),
      accountId: ACCTS[i],
      sku: SKUS[i % SKUS.length],
      qty: (i % 3 === 0) ? 2 : 1,
      sentAt: D(170 - i * 5),
      notes: i % 4 === 0 ? 'Buyer requested follow-up sample' : '',
      result: i < 15 ? 'ordered' : i < 22 ? 'pending' : 'no_response',
    });
  }
  return rows;
})();

// ── distVelocity array (12 monthly velocity reports) ─────────────────────
const distVelocity = (() => {
  const rows = [];
  // 6 months × 2 distributors = 12 reports
  const DISTS = ['dist001','dist002'];
  const MONTHS = [5,4,3,2,1,0]; // months ago relative to BASE
  for (const distId of DISTS) {
    for (const mo of MONTHS) {
      const d = new Date(BASE);
      d.setMonth(d.getMonth() - mo);
      d.setDate(1);
      const label = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const base  = distId === 'dist001' ? 80 : 55;
      const trend = mo * 3;
      rows.push({
        id: sid(),
        distributorId: distId,
        period: label,
        casesSold: Math.max(20, base - trend + (mo % 2 === 0 ? 5 : -5)),
        topSku: mo % 2 === 0 ? 'purpl-classic-12' : 'purpl-blueberry-12',
        reportedAt: new Date(d.getFullYear(), d.getMonth()+1, 5).toISOString(),
      });
    }
  }
  return rows;
})();

module.exports = { extraAccounts, productionRuns, orders, invoices, outreach, samples, portalInquiries, auditLog, distVelocity };
