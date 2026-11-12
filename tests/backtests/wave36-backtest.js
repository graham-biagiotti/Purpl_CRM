// Wave 36 backtests — v264 Socials reorganisation: three tabs (Stores / Log a
// post / Posts), filter chips + search + sortable columns on the store list,
// click-to-expand post history per store, store names that open the account
// card, and a filterable Posts tab with no 40-row ceiling.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] filter + sort — run the REAL functions');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  const code = slc(src, 'function _socDaysAgo(', '\n// One row per customer store')
    + '\n' + slc(src, 'function _socFilterRows(', '\nfunction _socArrow');
  const H = new Function('_socialPlatformLabel', code +
    '\nreturn { _socDaysAgo, _socFilterRows, _socSortRows, _socFilterPosts, _socSortPosts };')(
    p => (p.platform === 'other' ? p.platformOther : p.platform) || '');

  ok(H._socDaysAgo('2026-11-01', '2026-11-12') === 11, 'age in whole days');
  ok(H._socDaysAgo('garbage', '2026-11-12') === null && H._socDaysAgo('', '2026-11-12') === null,
    'a malformed date reads as never (null), not NaN');
  ok(H._socDaysAgo('2026-11-20', '2026-11-12') === 0, 'a future-dated post never shows a negative age');

  const rows = [
    { a: { id: '1', name: 'Zed Market', territory: 'North' }, l: { date: '2026-11-01' }, age: 11, count: 3, isStale: false },
    { a: { id: '2', name: 'apple Barn', territory: 'South' }, l: null, age: null, count: 0, isStale: true },
    { a: { id: '3', name: 'Mill Store', territory: 'North' }, l: { date: '2026-08-01' }, age: 103, count: 1, isStale: true },
  ];
  const ids = rs => rs.map(r => r.a.id).join('');
  ok(ids(H._socFilterRows(rows, 'needs', '')) === '23', 'Needs a post = stale + never-posted');
  ok(ids(H._socFilterRows(rows, 'never', '')) === '2', 'Never posted = zero posts only');
  ok(ids(H._socFilterRows(rows, 'recent', '')) === '1', 'Posted recently = not stale');
  ok(ids(H._socFilterRows(rows, 'all', 'north')) === '13', 'search matches territory as well as name');
  ok(ids(H._socFilterRows(rows, 'all', '  APPLE ')) === '2', 'search is case- and space-insensitive');

  ok(ids(H._socSortRows(rows, 'age', 'desc')) === '231', 'age desc: never-posted first, then longest-waiting');
  ok(ids(H._socSortRows(rows, 'age', 'asc')) === '132', 'age asc: most recently posted first');
  ok(ids(H._socSortRows(rows, 'name', 'asc')) === '231', 'name sort ignores case');
  ok(ids(H._socSortRows(rows, 'count', 'desc')) === '132', 'post-count sort');
  ok(ids(H._socSortRows(rows, 'territory', 'asc')) === '312', 'territory sort, ties broken by name');
  ok(ids(H._socSortRows(rows, 'last', 'desc')) === '132', 'last-post sort puts never-posted last when newest-first');
  ok(ids(rows) === '123', 'sorting never mutates the source rows');

  const posts = [
    { id: 'a', accountName: 'Zed Market', date: '2026-11-03', platform: 'instagram', note: 'reel' },
    { id: 'b', accountName: 'Apple Barn', date: '2026-10-20', platform: 'tiktok', note: 'demo day' },
    { id: 'c', accountName: 'Zed Market', date: '2026-10-02', platform: 'other', platformOther: 'Pinterest', note: '' },
  ];
  const pid = ps => ps.map(p => p.id).join('');
  ok(pid(H._socFilterPosts(posts, 'zed', '', '')) === 'ac', 'post search by store');
  ok(pid(H._socFilterPosts(posts, 'demo', '', '')) === 'b', 'post search also matches the note');
  ok(pid(H._socFilterPosts(posts, '', 'tiktok', '')) === 'b', 'platform filter');
  ok(pid(H._socFilterPosts(posts, '', '', '2026-10')) === 'bc', 'month filter');
  ok(pid(H._socFilterPosts(posts, 'zed', 'other', '2026-10')) === 'c', 'filters combine');
  ok(pid(H._socSortPosts(posts, 'date', 'desc')) === 'abc' && pid(H._socSortPosts(posts, 'date', 'asc')) === 'cba', 'date sort both ways');
  ok(pid(H._socSortPosts(posts, 'store', 'asc')) === 'bac' || pid(H._socSortPosts(posts, 'store', 'asc')) === 'bca', 'store sort');
}

console.log('[B] page structure');
{
  const pg = slc(src, 'function renderSocials()', '\n// List bodies render separately');
  ok(pg.includes("tabBtn('stores', 'Stores')") && pg.includes("tabBtn('log', 'Log a post')") && pg.includes("tabBtn('posts', 'Posts')"),
    'three tabs');
  ok(pg.includes("chip('needs'") && pg.includes("chip('never'") && pg.includes("chip('recent'") && pg.includes("chip('all'"),
    'four quick filters with counts');
  ok(pg.includes('oninput="_socQ = this.value; _renderSocStores()"') && pg.includes('oninput="_socPostQ = this.value; _renderSocPosts()"'),
    'search boxes refresh only the list body (never rebuild themselves mid-typing)');
  ok(pg.includes('value="${escHtml(_socQ)}"') && pg.includes('value="${escHtml(_socPostQ)}"'),
    'search text survives a rebuild and is escaped');
  ok(pg.includes("if (qs('#soc-date')) {") && pg.includes('_socDraft = {') && pg.includes('const _draft = _socDraft;'),
    'half-filled log form survives tab switches as well as refreshes');
  ok(pg.includes("sth('name', 'Store')") && pg.includes("sth('territory', 'Territory')") && pg.includes("sth('age', 'Age')"),
    'store columns are sortable');

  const st = slc(src, 'function _renderSocStores()', '\nfunction _renderSocPosts');
  ok(st.includes("socOpenAccount('${r.a.id}')") && st.includes('event.stopPropagation()'),
    'store name opens the account card without also toggling the row');
  ok(st.includes('onclick="socToggle(') && st.includes('colspan="6"') && st.includes('No posts logged for this store yet.'),
    'clicking a row expands that store\'s post history');
  ok((st.match(/escHtml\(/g) || []).length >= 5, 'store list escapes names, territory, platform, notes, authors');

  const ps = slc(src, 'function _renderSocPosts()', '\nfunction _socRerender');
  ok(ps.includes('all.slice(0, 300)') && ps.includes('showing 300 of'), 'posts view shows up to 300 with an honest count (was a silent 40)');
  ok(ps.includes('live.has(p.accountId)'), 'a post whose account was deleted shows as plain text, not a dead link');
  ok((ps.match(/escHtml\(/g) || []).length >= 5, 'posts table escapes every text field');

  const oa = slc(src, 'function socOpenAccount(', '\nfunction _socialStoreLookup');
  ok(oa.includes('openAccount(accountId)') && oa.includes('That account no longer exists'),
    'account card opens via the existing openAccount, guarded against a missing account');
  const pk = slc(src, 'function socialPick(', '\nfunction socialLogPost');
  ok(pk.includes("_socTab = 'log';") && pk.includes('_socRerender();'), '"Log post" on a store row lands on the form with the store filled in');
  ok(!/https?:\/\//.test(slc(src, 'let _socTab = ', '\nfunction renderInventory()')), 'still no post links anywhere');
}

console.log('[C] gate fixes — run the REAL socialPick');
{
  const pk = slc(src, 'function socialPick(', '\nfunction socialLogPost');
  const run = (startPick, formOnScreen, pickId) => {
    const note = { value: 'note for A', focus() {} }, other = { value: 'x' };
    const env = new Function('qs', '_socialAccounts', '_socRerender',
      "let _socialPickId = arguments[3]; let _socTab = 'stores'; let _socDraft = { note: 'note for A', other: 'x', date: '2026-10-01', platform: 'tiktok' };\n"
      + pk + "\nsocialPick(arguments[4]);\nreturn { _socialPickId, _socTab, _socDraft };")(
      sel => sel === '#soc-date' ? (formOnScreen ? {} : null) : sel === '#soc-note' ? note : sel === '#soc-platform-other' ? other : null,
      () => [{ id: 'A', name: 'Store A' }, { id: 'B', name: 'Store B' }],
      () => {}, startPick, pickId);
    return { ...env, noteBox: note.value };
  };
  let r = run('A', true, 'B');
  ok(r._socDraft.note === '' && r.noteBox === '' && r._socialPickId === 'B',
    'picking a DIFFERENT store drops the note typed for the previous one (gate F1)');
  ok(r._socDraft.date === '2026-10-01' && r._socDraft.platform === 'tiktok', 'on the form itself, date + platform stay for batch logging');
  r = run('', false, 'B');
  ok(r._socDraft.note === '' && r._socDraft.date === '' && r._socTab === 'log',
    'a pick from the Stores tab starts clean: no carried note, date back to today');
  r = run('', true, 'A');
  ok(r._socDraft.note === 'note for A' && r.noteBox === 'note for A',
    'typing a note first and THEN picking the store keeps the note');
  r = run('A', true, 'A');
  ok(r._socDraft.note === 'note for A', 're-picking the same store keeps the note');

  ok(src.includes("if (_socPostMonth && !months.includes(_socPostMonth)) _socPostMonth = '';"),
    'a month filter with no posts left resets itself (gate F2)');
  ok(slc(src, 'function socialSaveStale(', '\nfunction renderInventory()').includes('setTimeout(_socRerender, 0);'),
    'stale-marker save defers its rebuild so the click that triggered it still lands (gate F3)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
