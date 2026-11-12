// Wave 34 backtests — v262 Socials: Zoe's per-account social post log.
// Owner's brief: simple. Customer accounts only (no prospects), no links,
// no approval; platforms = IG / Facebook / TikTok / Other(+text); she sets
// the stale marker herself; the owner gets ONE read-only line on the
// account card.
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../public/app.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '../../public/db.js'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '../../public/index.html'), 'utf8');
const swSrc = fs.readFileSync(path.join(__dirname, '../../public/sw.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ FAIL: ' + m); } };
const slc = (s, a, b) => { const i = s.indexOf(a); const j = s.indexOf(b, i + 1); if (i < 0 || j < 0) throw new Error('slice: ' + a); return s.slice(i, j); };

console.log('[A] wiring');
{
  const v = src.match(/APP_VERSION = '(v\d+)'/)?.[1];
  ok(v && swSrc.includes('purpl-crm-' + v), `version lockstep (${v})`);
  ok(slc(dbSrc, 'const COLLECTION_KEYS = [', '];').includes("'social_posts'"), 'social_posts is a real collection');
  ok(idx.includes('data-page="socials"') && idx.includes('id="page-socials"') && idx.includes('id="socials-content"'),
    'nav item + page shell present');
  ok(src.includes('socials:          renderSocials') && src.includes("socials:'Socials'"),
    'page registered in the render map and topbar titles');
}

console.log('[B] helpers — run the REAL functions');
{
  const helpers = slc(src, 'const SOCIAL_PLATFORMS = ', '\nlet _socialPickId');
  const mk = (ac, posts, settings) => new Function('DB', helpers +
    '\nreturn { _socialPlatformLabel, _socialStaleDays, _socialAccounts, _socialLastFor };')({
    a: k => (k === 'ac' ? ac : k === 'social_posts' ? posts : []),
    obj: () => settings,
  });
  const H = mk(
    // (gate F1: real statuses are active|pending|paused|inactive — the first
    // fixture used a non-existent 'closed' and so missed that pending leaked in)
    [{ id: 'a1', name: 'Zed Market', status: 'active' }, { id: 'a2', name: 'Alpha Foods', status: 'pending' },
     { id: 'a3', name: 'Beta Co', status: 'inactive' }, { id: 'a4', name: 'Apple Barn', status: 'paused' }],
    [{ accountId: 'a1', date: '2026-10-01', platform: 'instagram' },
     { accountId: 'a1', date: '2026-11-05', platform: 'other', platformOther: 'Pinterest' },
     { accountId: 'a4', date: '2026-09-09', platform: 'tiktok' }],
    { socialStaleDays: '45' });
  const acc = H._socialAccounts();
  ok(acc.length === 2 && acc[0].name === 'Apple Barn' && acc[1].name === 'Zed Market',
    'customers only: pending (no order yet) + inactive excluded, paused kept, sorted by name');
  const l = H._socialLastFor('a1');
  ok(l.count === 2 && l.last.date === '2026-11-05', 'last post = newest date, with a total count');
  ok(H._socialLastFor('nope').count === 0 && H._socialLastFor('nope').last === null, 'no posts → empty, no crash');
  ok(H._socialPlatformLabel(l.last) === 'Pinterest', '"Other" shows the typed platform name');
  ok(H._socialPlatformLabel({ platform: 'facebook' }) === 'Facebook', 'known platforms use their label');
  ok(H._socialStaleDays() === 45, 'stale marker reads her saved setting');
  ok(mk([], [], null)._socialStaleDays() === 60 && mk([], [], { socialStaleDays: 0 })._socialStaleDays() === 60,
    'unset/invalid stale marker falls back to 60 days');
}

console.log('[C] page behaviour contracts');
{
  const pg = slc(src, 'function renderSocials()', '\nfunction _socialStoreLookup');
  ok(pg.includes('document.activeElement') && pg.includes('return;'), 'background refresh never rebuilds the form mid-typing');
  ok((pg.match(/escHtml\(/g) || []).length >= 7, 'store names / notes / authors / platform text escaped');
  ok(!/https?:|soc-link|soc-url/.test(pg), 'no link field (owner: links not necessary)');
  ok(!/approve|pending/i.test(pg), 'no approval flow');
  ok(pg.includes("onchange=\"socialSaveStale(this.value)\""), 'stale marker editable inline by Zoe');
  ok(pg.includes('age === null || age > stale'), 'never-posted and older-than-marker stores are flagged');

  const lg = slc(src, 'function socialLogPost()', '\nasync function socialDelete');
  ok(lg.includes('_socialAccounts().find(x => x.id === _socialPickId)') && lg.includes("toast('Pick a store from the list first')"),
    'a post must be tied to a real customer account (free-typed names rejected)');
  ok(lg.includes("platform === 'other' && !platformOther"), '"Other" requires the platform text');
  ok(lg.includes('date > today()'), 'future dates rejected');
  ok(lg.includes('.slice(0, 300)') && lg.includes('.slice(0, 40)'), 'note + platform text length-capped');
  ok(src.includes("DB.setObj('settings', { ...(DB.obj('settings', {}) || {}), socialStaleDays: n })"),
    'stale marker merges into settings (never replaces the settings object)');
  ok(slc(src, 'function _socialStoreLookup()', '\nfunction socialPick').includes("_socialPickId = '';"),
    'typing after a pick invalidates it (no stale-pick mislogging)');
}

console.log('[C2] gate fixes — draft survives rebuilds');
{
  const pg2 = slc(src, 'function renderSocials()', '\nfunction _socialStoreLookup');
  ok(pg2.indexOf('const _draft = ') < pg2.indexOf('el.innerHTML = `') && pg2.includes("qs('#soc-date').value = _draft.date"),
    'date/platform/note are captured before and restored after a rebuild (gate F2/F3)');
  ok(pg2.includes("_draft.platform === 'other' ? '' : 'none'"), 'the Other text box visibility is restored too');
  ok(pg2.includes('if (Number.isNaN(age)) age = null;'), 'malformed post date reads as never, not NaNd (gate F4)');
  const lg2 = slc(src, 'function socialLogPost()', '\nasync function socialDelete');
  ok(lg2.includes("_n.value = ''") && lg2.indexOf("_n.value = ''") < lg2.indexOf('renderSocials();'),
    'note is cleared before the post-log rebuild (no carry-over into the next entry)');
}

console.log('[D] owner view — one quiet line on the account card');
{
  ok(idx.includes('id="mac-last-social"') && idx.includes('Last Social Post'), 'overview grid slot added');
  ok(src.includes("qs('#mac-last-social')") && src.includes('_socialLastFor(id)'), 'account modal fills it from the log');
  ok((idx.match(/mac-last-social/g) || []).length === 1, 'exactly one slot — nothing else added to the account card');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
