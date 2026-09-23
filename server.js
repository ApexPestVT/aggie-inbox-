// aggie-inbox v1.0 — Apex Pest Solutions
//
// THE INBOX OFF GOOGLE APPS SCRIPT (owner, Sept 21 2026: "i spend my whole day in my
// inbox and this ap feels like im running dial up internet").
//
// What this is: a small always-on service that keeps the unified inbox READY. Emails
// come straight from Gmail (history-delta sync every 10s, no Apps Script in the read
// path). Calls / texts / FB / IG rows and the owner's state maps (handled, filed,
// folders, stars, machine drawer, mutes) are pulled from the APS kit in the
// background every 30s. The app reads /inbox in ~100ms. Every action is answered
// here instantly (Gmail acted on directly; kit-owned state forwarded behind, with a
// retrying outbox) and the mirror is overlaid at once, so nothing snaps back.
//
// Rows are built to the exact shape the kit's getUnifiedInbox returns (mailRow_ +
// the state overlay), so the existing renderer needs no changes.
//
// Deliberately NOT the memory server: that is Aggie's mind and the experiment's
// substrate. This is business plumbing with its own database and blast radius.
//
// Env: PORT, INBOX_KEY, DB_PATH (/data/inbox.db), GAS_URL (the /exec url), GAS_KEY
// (the kit's WEBHOOK_KEY), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
// GOOGLE_REFRESH_TOKEN (a refresh token minted as Sales@ — see README), TZ_NAME
// (America/New_York), SELF_DOMAIN (apexpestsolutionsllc.com), MAIL_CAP (400).
'use strict';
const http = require('http');
const https = require('https');
const url = require('url');
const zlib = require('zlib');
const Database = require('better-sqlite3');

const VERSION = '1.3';
const PORT = process.env.PORT || 10000;
const KEY = process.env.INBOX_KEY || '';
const DB_PATH = process.env.DB_PATH || '/data/inbox.db';
const GAS_URL = (process.env.GAS_URL || '').replace(/\/+$/, '');
const GAS_KEY = process.env.GAS_KEY || '';
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || '';
const TZ = process.env.TZ_NAME || 'America/New_York';
const SELF_DOMAIN = (process.env.SELF_DOMAIN || 'apexpestsolutionsllc.com').toLowerCase();
const MAIL_CAP = Math.max(100, Math.min(500, Number(process.env.MAIL_CAP) || 400));
const SELF_RX = new RegExp(SELF_DOMAIN.replace(/\./g, '\\.'), 'i');

// ---------------------------------------------------------------- db
try { require('fs').mkdirSync(require('path').dirname(DB_PATH), { recursive: true }); } catch (e) { }   // v1.0.1: never die on a missing folder (Render without the /data disk mounted)
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS rows(id TEXT PRIMARY KEY, lane TEXT NOT NULL, ts INTEGER DEFAULT 0, json TEXT NOT NULL, updatedAt INTEGER);
CREATE INDEX IF NOT EXISTS rows_lane ON rows(lane);
CREATE TABLE IF NOT EXISTS state(k TEXT PRIMARY KEY, v TEXT NOT NULL, at INTEGER);
CREATE TABLE IF NOT EXISTS intent(id TEXT NOT NULL, field TEXT NOT NULL, val TEXT, at INTEGER, PRIMARY KEY(id, field));
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, tries INTEGER DEFAULT 0, at INTEGER, lastErr TEXT);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS wo(id TEXT PRIMARY KEY, date TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS wo_date ON wo(date);
`);
const q = {
  upsert: db.prepare('INSERT INTO rows(id,lane,ts,json,updatedAt) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET lane=excluded.lane, ts=excluded.ts, json=excluded.json, updatedAt=excluded.updatedAt'),
  del: db.prepare('DELETE FROM rows WHERE id=?'),
  delLane: db.prepare('DELETE FROM rows WHERE lane=?'),
  all: db.prepare('SELECT id, lane, ts, json FROM rows ORDER BY ts DESC'),
  mailIds: db.prepare("SELECT id FROM rows WHERE lane='mail'"),
  one: db.prepare('SELECT id, lane, ts, json FROM rows WHERE id=?'),
  stateGet: db.prepare('SELECT v, at FROM state WHERE k=?'),
  stateSet: db.prepare('INSERT INTO state(k,v,at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, at=excluded.at'),
  metaGet: db.prepare('SELECT v FROM meta WHERE k=?'),
  metaSet: db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'),
  intentSet: db.prepare('INSERT INTO intent(id,field,val,at) VALUES(?,?,?,?) ON CONFLICT(id,field) DO UPDATE SET val=excluded.val, at=excluded.at'),
  intentAll: db.prepare('SELECT id, field, val, at FROM intent'),
  intentDelOld: db.prepare('DELETE FROM intent WHERE at < ?'),
  intentDelId: db.prepare('DELETE FROM intent WHERE id=?'),
  outAdd: db.prepare('INSERT INTO outbox(payload, tries, at) VALUES(?,0,?)'),
  outNext: db.prepare('SELECT id, payload, tries FROM outbox ORDER BY id LIMIT 5'),
  outDel: db.prepare('DELETE FROM outbox WHERE id=?'),
  outFail: db.prepare('UPDATE outbox SET tries=tries+1, lastErr=? WHERE id=?'),
  outCount: db.prepare('SELECT COUNT(*) n FROM outbox'),
  woUp: db.prepare('INSERT INTO wo(id,date,json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET date=excluded.date, json=excluded.json'),
  woAll: db.prepare('SELECT json FROM wo ORDER BY date'),
  woClear: db.prepare('DELETE FROM wo'),
  woCount: db.prepare('SELECT COUNT(*) n FROM wo'),
};
const meta = { get: (k) => { const r = q.metaGet.get(k); return r ? r.v : ''; }, set: (k, v) => q.metaSet.run(k, String(v)) };
const state = {
  get: (k, dflt) => { const r = q.stateGet.get(k); if (!r) return dflt; try { return JSON.parse(r.v); } catch (e) { return dflt; } },
  set: (k, v) => q.stateSet.run(k, JSON.stringify(v), Date.now()),
  at: (k) => { const r = q.stateGet.get(k); return r ? r.at : 0; },
};

// ---------------------------------------------------------------- http helpers
function fetchJson(u, opt) {
  opt = opt || {};
  return new Promise((resolve, reject) => {
    const U = new URL(u);
    const body = opt.body == null ? null : (typeof opt.body === 'string' ? opt.body : JSON.stringify(opt.body));
    const headers = Object.assign({}, opt.headers || {});
    if (body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (body != null) headers['Content-Length'] = Buffer.byteLength(body);
    const req = (U.protocol === 'http:' ? http : https).request({ hostname: U.hostname, port: U.port || undefined, path: U.pathname + U.search, method: opt.method || (body != null ? 'POST' : 'GET'), headers, timeout: opt.timeout || 25000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        // Apps Script answers with a 302 to googleusercontent — follow once.
        if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307) && res.headers.location && (opt._hops || 0) < 4) {   // v1.1.1: Apps Script can bounce twice
          return fetchJson(res.headers.location, Object.assign({}, opt, { _hops: (opt._hops || 0) + 1, method: 'GET', body: null })).then(resolve, reject);
        }
        let j = null; try { j = JSON.parse(raw); } catch (e) { }
        resolve({ status: res.statusCode, json: j, raw });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}
function fetchForm(u, form) {
  const body = Object.keys(form).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(form[k])).join('&');
  return fetchJson(u, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
}

// ---------------------------------------------------------------- gmail
let _tok = { v: '', exp: 0 };
async function token() {
  if (_tok.v && Date.now() < _tok.exp - 60000) return _tok.v;
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) throw new Error('gmail credentials missing');
  const r = await fetchForm('https://oauth2.googleapis.com/token', { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: REFRESH_TOKEN, grant_type: 'refresh_token' });
  if (!r.json || !r.json.access_token) throw new Error('token refresh failed: ' + (r.raw || '').slice(0, 200));
  _tok = { v: r.json.access_token, exp: Date.now() + (Number(r.json.expires_in) || 3500) * 1000 };
  return _tok.v;
}
async function gapi(method, path, query, body) {
  const t = await token();
  const qs = query ? ('?' + Object.keys(query).filter((k) => query[k] != null).map((k) => Array.isArray(query[k]) ? query[k].map((v) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&') : encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&')) : '';
  const r = await fetchJson('https://gmail.googleapis.com/gmail/v1/users/me' + path + qs, { method, body: body == null ? null : body, headers: { Authorization: 'Bearer ' + t } });
  if (r.status === 401) { _tok = { v: '', exp: 0 }; }
  if (r.status >= 400) { const e = new Error('gmail ' + r.status + ' ' + path + ' ' + (r.raw || '').slice(0, 160)); e.status = r.status; throw e; }
  return r.json || {};
}
async function pmap(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __err: String(e && e.message || e) }; } } }));
  return out;
}

// ---------------------------------------------------------------- row shape (ports of the kit)
function hdr(msg, name) { const hs = (msg && msg.payload && msg.payload.headers) || []; name = name.toLowerCase(); for (const h of hs) { if (String(h.name).toLowerCase() === name) return String(h.value || ''); } return ''; }
function fmtDate(ms) { // Utilities.formatDate(d, tz, 'MM/dd h:mm a')
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(Number(ms) || 0));
    const g = (t) => (p.find((x) => x.type === t) || {}).value || '';
    return g('month') + '/' + g('day') + ' ' + g('hour') + ':' + g('minute') + ' ' + g('dayPeriod').toUpperCase();
  } catch (e) { return ''; }
}
function inboxSource(from, subj) {
  const f = String(from || '').toLowerCase(), s = String(subj || '').toLowerCase();
  if (f.indexOf('facebookmail') >= 0 || f.indexOf('facebook.com') >= 0) return 'fb';
  if (f.indexOf('instagram') >= 0) return 'ig';
  if (f.indexOf('yelp') >= 0) return 'yelp';
  if (f.indexOf('gorilladesk') >= 0 || s.indexOf('gorilladesk') >= 0) return 'gd';
  return 'email';
}
const aggieEcho = (subj) => /Aggie (flagged a text thread|handled a call)/i.test(String(subj || ''));
const selfEmail = (em) => SELF_RX.test(String(em || ''));
function clientsByEmail() { const m = {}; for (const c of state.get('clients', [])) { const e = String(c.email || '').toLowerCase().trim(); if (e) m[e] = c; } return m; }
function mailRow(t, draftT, byEmail) {
  const msgsA = t.messages || []; if (!msgsA.length) return null;
  const labs = {}; msgsA.forEach((x) => { (x.labelIds || []).forEach((L) => { labs[L] = 1; }); });
  if (!labs.INBOX) return null;   // left the inbox (trashed / archived) — not a row
  let mA = msgsA[msgsA.length - 1];
  for (let i = msgsA.length - 1; i >= 0; i--) { if (((msgsA[i].labelIds) || []).indexOf('DRAFT') < 0) { mA = msgsA[i]; break; } }
  const fromA = hdr(mA, 'From');
  const emA = ((fromA.match(/<([^>]+)>/) || [])[1] || fromA).toLowerCase().trim();
  let pFrom = '', pEm = '';
  for (let i = msgsA.length - 1; i >= 0; i--) { const f2 = hdr(msgsA[i], 'From'); if (!SELF_RX.test(f2)) { pFrom = f2; pEm = ((f2.match(/<([^>]+)>/) || [])[1] || f2).toLowerCase().trim(); break; } }
  const subj0 = hdr(msgsA[0], 'Subject');
  if (aggieEcho(subj0)) return null;
  const cli = selfEmail(pEm || emA) ? null : (byEmail[pEm || emA] || byEmail[emA] || null);
  return {
    cat: '', tkey: 'mail|' + t.id,
    mach: !!(labs.CATEGORY_PROMOTIONS || labs.CATEGORY_SOCIAL || labs.CATEGORY_FORUMS),
    id: t.id, from: fromA, email: emA, pFrom, pEmail: pEm,
    subject: subj0,
    snippet: String(mA.snippet || '').replace(/\s+/g, ' ').slice(0, 180),
    date: fmtDate(mA.internalDate),
    unread: !!labs.UNREAD, starred: !!labs.STARRED,
    answered: SELF_RX.test(fromA),
    hasDraft: (!!labs.DRAFT || !!draftT[String(t.id)]),
    ts: Number(mA.internalDate) || 0,
    count: msgsA.length,
    source: inboxSource(fromA, subj0),
    clientId: cli ? cli.id : '', clientName: cli ? cli.name : '',
  };
}

// ---------------------------------------------------------------- gmail sync
const sync = { busy: false, lastAt: 0, lastErr: '', full: 0, delta: 0, changed: 0 };
async function draftMap() {
  const draftT = {};
  try { const dl = await gapi('GET', '/drafts', { maxResults: 100 }); (dl.drafts || []).forEach((d) => { if (d.message && d.message.threadId) draftT[String(d.message.threadId)] = 1; }); } catch (e) { }
  return draftT;
}
async function upsertThreads(ids, draftT) {
  const byEmail = clientsByEmail();
  // v1.0.1: gentle on Gmail's per-user per-minute budget (the first full pull of 400 threads at 8-wide tripped a 403)
  const got = await pmap(ids, ids.length > 60 ? 3 : 8, async (id, k) => { if (ids.length > 60 && k % 50 === 49) await new Promise((r) => setTimeout(r, 4000)); return gapi('GET', '/threads/' + encodeURIComponent(id), { format: 'metadata', metadataHeaders: ['From', 'Subject'] }); });
  const now = Date.now();
  const tx = db.transaction(() => {
    got.forEach((t, i) => {
      const id = ids[i];
      if (!t || t.__err) { if (t && /gmail 404/.test(t.__err)) q.del.run(id); return; }
      const r = mailRow(t, draftT, byEmail);
      if (r) q.upsert.run(id, 'mail', r.ts, JSON.stringify(r), now); else q.del.run(id);
    });
  });
  tx();
  sync.changed += ids.length;
}
async function fullSync() {
  const draftT = await draftMap();
  const prof = await gapi('GET', '/profile');
  const lst = await gapi('GET', '/threads', { q: 'in:inbox', maxResults: MAIL_CAP });
  const ids = (lst.threads || []).map((t) => String(t.id));
  const keep = {}; ids.forEach((id) => { keep[id] = 1; });
  await upsertThreads(ids, draftT);
  const tx = db.transaction(() => { for (const r of q.mailIds.all()) { if (!keep[r.id]) q.del.run(r.id); } });
  tx();
  meta.set('historyId', prof.historyId || '');
  sync.full++;
}
async function deltaSync() {
  const start = meta.get('historyId');
  if (!start) return fullSync();
  let pageToken = null, ids = {}, newest = start, pages = 0;
  do {
    let h;
    try { h = await gapi('GET', '/history', { startHistoryId: start, pageToken, maxResults: 500 }); }
    catch (e) { if (e.status === 404) { return fullSync(); } throw e; }   // history expired — rebuild
    (h.history || []).forEach((ev) => {
      ['messagesAdded', 'messagesDeleted', 'labelsAdded', 'labelsRemoved'].forEach((k) => { (ev[k] || []).forEach((x) => { if (x.message && x.message.threadId) ids[String(x.message.threadId)] = 1; }); });
    });
    if (h.historyId) newest = h.historyId;
    pageToken = h.nextPageToken || null; pages++;
  } while (pageToken && pages < 10);
  const list = Object.keys(ids);
  if (list.length) { const draftT = await draftMap(); await upsertThreads(list, draftT); }
  meta.set('historyId', newest);
  sync.delta++;
}
async function syncTick() {
  if (sync.busy) return; sync.busy = true;
  try { await deltaSync(); sync.lastAt = Date.now(); sync.lastErr = ''; }
  catch (e) { sync.lastErr = String(e && e.message || e).slice(0, 300); console.error('[sync]', sync.lastErr); }
  finally { sync.busy = false; }
}
// the draft flag has no history event of its own — refresh it on a slow beat
async function draftTick() {
  try {
    const draftT = await draftMap();
    const now = Date.now();
    const tx = db.transaction(() => { for (const r of q.all.all()) { if (r.lane !== 'mail') continue; const j = JSON.parse(r.json); const hd = !!draftT[r.id]; if (!!j.hasDraft !== hd) { j.hasDraft = hd; q.upsert.run(r.id, 'mail', j.ts || 0, JSON.stringify(j), now); } } });
    tx();
  } catch (e) { }
}

// ---------------------------------------------------------------- kit (GAS) mirror
// v1.2 PHASE 2 - THE LANES COME IN INCREMENTALLY. Every 10s: 'what moved since <last>?' (the kit reads only its newest
// rows - seconds, not 50). Every 10 minutes: the full build with the clients list, replacing the lane whole (that is
// how rows that fell out of the kit's window leave). Overlap of 90s on the incremental so nothing slips between beats.
// The kit is a single slow web app - never ask it two things at once (kitCall serializes every kit request).
const gas = { lastAt: 0, lastErr: '', pulls: 0, ms: 0, lastFull: 0, incs: 0, lastLanes: null, lastRows: 0, busy: false, skipped: 0 };
const _kitQueues = { lanes: Promise.resolve(), wo: Promise.resolve() };
function kitCall(fn, lane) { lane = lane || 'lanes'; const p = _kitQueues[lane].then(fn, fn); _kitQueues[lane] = p.catch(() => { }); return p; }   // v1.2: board pulls have their own line - a 50s lane build never holds a drag's fresh read
async function gasPull(mode) {
  if (!GAS_URL) return;
  // v1.3 ONE ASK AT A TIME. The 10s beat used to queue a new ask whether or not the last one had come back; with the kit
  // answering in ~38s the line grew 18 minutes deep (health lastMs 1115113, Sept 23). A beat that finds an ask in flight
  // now steps aside; an explicit 'full' (the app's resync, the /inbox/pull door) still waits its turn.
  if (gas.busy && mode !== 'full') { gas.skipped++; return; }
  gas.busy = true;
  const full = (mode === 'full') || !gas.lastFull || (Date.now() - gas.lastFull > 10 * 60000);
  let t0 = Date.now();
  try {
    const since = full ? '' : String(Math.max(0, (gas.lastAt || 0) - 90000));
    const r = await kitCall(() => { t0 = Date.now(); return fetchJson(GAS_URL + '?hook=ibxlanes&k=' + encodeURIComponent(GAS_KEY) + (full ? '&clients=1' : '&since=' + since), { timeout: 150000 }); });   // v1.3: ms measures the kit's answer, not the wait in line
    if (!r.json || !r.json.ok) throw new Error('ibxlanes ' + r.status + ' ' + (r.raw || '').slice(0, 160));
    const j = r.json, now = Date.now();
    const tx = db.transaction(() => {
      if (full) q.delLane.run('gas');
      (j.rows || []).forEach((row) => { if (row && row.id) q.upsert.run(String(row.id), 'gas', Number(row.ts) || 0, JSON.stringify(row), now); });
      const M = j.maps || {};
      ['done', 'filed', 'triage', 'stars', 'ops', 'machOvr', 'machSenders', 'mute'].forEach((k) => { if (M[k]) state.set(k, M[k]); });
      if (j.folders) state.set('folders', j.folders);
      if (j.clients) state.set('clients', j.clients);
    });
    tx();
    gas.lastAt = now; gas.lastErr = ''; gas.pulls++; gas.ms = now - t0; gas.lastLanes = j._lanes || null; gas.lastRows = (j.rows || []).length;
    if (full) gas.lastFull = now; else gas.incs++;
    q.intentDelOld.run(now - 10 * 60000);
  } catch (e) { gas.lastErr = String(e && e.message || e).slice(0, 300); console.error('[gas]', gas.lastErr); }
  finally { gas.busy = false; }
}
// ---------------------------------------------------------------- work orders + clients mirror (v1.1, phase 1)
// The kit stays the writer. Every few seconds we ask hook=wofeed 'anything new since <gen>?' (two cache stamps on the
// kit side, ~1s). On a change we take the full slim feed - the exact payload getWorkOrdersData hands the app - and the
// clients list, and replace the mirror whole. The app reads /wo in ~100ms. /wo?fresh=1 pulls first, so a reload that
// follows the owner's own save never sees the pre-save world.
const wo = { busy: null, lastAt: 0, lastFull: 0, err: '', gen: '', peeks: 0, fulls: 0, ms: 0 };
async function woPull(force) {
  if (!GAS_URL) return;
  if (wo.busy) return wo.busy;
  wo.busy = (async () => {
    const t0 = Date.now();
    try {
      const r = await kitCall(() => fetchJson(GAS_URL + '?hook=wofeed&k=' + encodeURIComponent(GAS_KEY) + '&since=' + encodeURIComponent(force ? '' : (meta.get('wo_gen') || '')), { timeout: 150000 }), 'wo');
      if (!r.json || !r.json.ok) throw new Error('wofeed ' + r.status + ' ' + (r.raw || '').slice(0, 160));
      const j = r.json; wo.peeks++;
      if (j.same) { wo.lastAt = Date.now(); wo.err = ''; return; }
      const rows = (j.wo && j.wo.workOrders) || [];
      const extra = {}; Object.keys(j.wo || {}).forEach((k) => { if (k !== 'workOrders') extra[k] = j.wo[k]; });
      const tx = db.transaction(() => {
        q.woClear.run();
        rows.forEach((w) => { if (w && w.id) q.woUp.run(String(w.id), String(w.scheduledDate || ''), JSON.stringify(w)); });
        state.set('wo_extra', extra);
        if (j.clients) state.set('clients_full', j.clients);
      });
      tx();
      meta.set('wo_gen', j.gen || '');
      wo.gen = j.gen || ''; wo.lastAt = wo.lastFull = Date.now(); wo.err = ''; wo.fulls++; wo.ms = Date.now() - t0;
    } catch (e) { wo.err = String(e && e.message || e).slice(0, 300); console.error('[wo]', wo.err); }
    finally { wo.busy = null; }
  })();
  return wo.busy;
}
function woPayload() {
  const rows = q.woAll.all().map((r) => { try { return JSON.parse(r.json); } catch (e) { return null; } }).filter(Boolean);
  const extra = state.get('wo_extra', {});
  return Object.assign({}, extra, { workOrders: rows, _via: 'data-svc', gen: meta.get('wo_gen') || '', syncedAt: wo.lastAt, lastFull: wo.lastFull, err: wo.err });
}
async function outboxTick() {
  if (!GAS_URL) return;
  for (const row of q.outNext.all()) {
    try {
      const r = await kitCall(() => fetchJson(GAS_URL + '?hook=ibxact&k=' + encodeURIComponent(GAS_KEY), { method: 'POST', body: row.payload, timeout: 60000 }));
      if (r.json && r.json.ok) q.outDel.run(row.id);
      else if (row.tries >= 20) { q.outDel.run(row.id); console.error('[outbox] dropped after 20 tries', row.payload.slice(0, 120)); }
      else q.outFail.run(String((r.raw || '').slice(0, 200)), row.id);
    } catch (e) { if (row.tries >= 20) q.outDel.run(row.id); else q.outFail.run(String(e && e.message || e).slice(0, 200), row.id); }
  }
}
function forward(payload) { q.outAdd.run(JSON.stringify(payload), Date.now()); setTimeout(() => { outboxTick().catch(() => { }); }, 50); }

// ---------------------------------------------------------------- the overlay (port of getUnifiedInbox's tail)
const phoneKey = (p) => 'ph|' + String(p || '').replace(/[^0-9]/g, '').slice(-10);
function assemble() {
  const tm = state.get('triage', {}), st = state.get('stars', {}), op = state.get('ops', {}), dn = state.get('done', {}), fl = state.get('filed', {}), mu = state.get('mute', {});
  const mo = state.get('machOvr', {}), ms = state.get('machSenders', {});
  const intents = {}; const now = Date.now();
  for (const it of q.intentAll.all()) { if (now - it.at > 15 * 60000) continue; (intents[it.id] = intents[it.id] || {})[it.field] = it.val; }
  let out = [];
  for (const r of q.all.all()) {
    let j; try { j = JSON.parse(r.json); } catch (e) { continue; }
    const I = intents[String(j.id)] || {};
    if (I.gone === '1') continue;
    if (j.tkey) j.cat = tm[j.tkey] || '';
    if (st[String(j.id)]) j.starred = true;
    if (op[String(j.id)]) j.ops = true;
    const v = dn[String(j.id)];
    const dAt = (v === 1 || v === '1') ? 0 : (Number(v) || 0);
    if (v && Number(v) !== 0) { if (Number(j.ts || 0) > dAt && (j.unread || !j.answered)) j.done = false; else j.done = true; }
    else if (v === 0 || v === '0') j.reopened = true;
    const k = String(j.tkey || ''); if (k && fl[k]) j.filed = fl[k];
    if (mu[String(j.id).toLowerCase()] || (j.email && mu[String(j.email).toLowerCase()])) j.muted = true;
    else { let p = String(j.id || '').split('|')[1] || ''; p = p.replace(/[^0-9]/g, '').slice(-10); if (p && mu[p]) j.muted = true; }
    // the owner's own taps, until the kit confirms them
    if ('done' in I) { j.done = (I.done === '1'); if (I.done === '0') j.reopened = true; if (j.done) j._unh = false; }
    if ('filed' in I) j.filed = I.filed || '';
    if ('unread' in I) j.unread = (I.unread === '1');
    if ('starred' in I) j.starred = (I.starred === '1');
    out.push(j);
  }
  const seen = {}; out = out.filter((j) => { const k2 = String(j.tkey || j.id || ''); if (!k2) return true; if (seen[k2]) return false; seen[k2] = 1; return true; });
  out.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
  if (out.length) { out[0]._machOvr = mo; out[0]._machSenders = ms; }
  return out;
}

// ---------------------------------------------------------------- thread reader (port of inboxThreadAdv_)
const b64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
function findParts(p, pred, acc) { if (!p) return acc; if (pred(p)) acc.push(p); (p.parts || []).forEach((x) => findParts(x, pred, acc)); return acc; }
function plainOf(m) {
  const tp = findParts(m.payload, (p) => p.mimeType === 'text/plain' && p.body && p.body.data, []);
  let txt = tp.length ? b64(tp[0].body.data).toString('utf8') : '';
  const hp = findParts(m.payload, (p) => p.mimeType === 'text/html' && p.body && p.body.data, []);
  const stripped = hp.length ? b64(hp[0].body.data).toString('utf8').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+\n/g, '\n').replace(/[ \t]+/g, ' ').trim() : '';
  if (stripped.length > txt.length) txt = stripped;
  if (!txt && m.payload && m.payload.body && m.payload.body.data) txt = b64(m.payload.body.data).toString('utf8');
  return txt || String(m.snippet || '');
}
async function mailThread(threadId) {
  const t0 = Date.now(); let fetched = 0;
  const t = await gapi('GET', '/threads/' + encodeURIComponent(threadId), { format: 'full' });
  const msgsA = (t.messages || []).slice(-25);
  const lastTwo = {}; msgsA.slice(-2).forEach((m) => { lastTwo[String(m.id)] = 1; });
  let budget = 1200000;
  const out = [];
  for (const m of msgsA) {
    const htmlParts = findParts(m.payload, (p) => p.mimeType === 'text/html' && p.body && p.body.data, []);
    let html = htmlParts.length ? b64(htmlParts[0].body.data).toString('utf8') : '';
    html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    const attParts = findParts(m.payload, (p) => p.body && p.body.attachmentId, []);
    const atts = [];
    for (const p of attParts) {
      const name = String(p.filename || 'file'), type = String(p.mimeType || ''), size = Number((p.body && p.body.size) || 0);
      const entry = { name, size, type };
      let cid = ''; (p.headers || []).forEach((h) => { if (String(h.name).toLowerCase() === 'content-id') cid = String(h.value || '').replace(/[<>]/g, ''); });
      const wantInline = cid && type.indexOf('image/') === 0 && lastTwo[String(m.id)] && fetched < 4;
      if (wantInline && size < 400000 && budget > size) {
        try { const a = await gapi('GET', '/messages/' + encodeURIComponent(m.id) + '/attachments/' + encodeURIComponent(p.body.attachmentId)); entry.dataB64 = b64(a.data).toString('base64'); budget -= size; fetched++; html = html.split('cid:' + cid).join('data:' + type + ';base64,' + entry.dataB64); } catch (e) { }
      }
      if (!entry.dataB64) { entry.gmMsgId = String(m.id); entry.attId = String(p.body.attachmentId); }
      atts.push(entry);
    }
    html = html.replace(/src="cid:[^"]*"/gi, 'src=""');
    const isDraft = (m.labelIds || []).indexOf('DRAFT') >= 0;
    out.push({ isDraft, from: (isDraft ? '👻 DRAFT — not sent · ' : '') + hdr(m, 'From'), date: fmtDate(m.internalDate), body: plainOf(m).slice(0, 3000), html: html.slice(0, 900000), atts });
  }
  return { id: threadId, subject: hdr((t.messages || [{}])[0], 'Subject'), msgs: out, _tookMs: Date.now() - t0, _attInline: fetched, _via: 'inbox-svc', gmailUrl: 'https://mail.google.com/mail/?authuser=Sales@ApexPestSolutionsllc.com#all/' + threadId };
}

// ---------------------------------------------------------------- actions
const isMail = (id) => id.indexOf('|') < 0;
async function act(body) {
  const a = String(body.act || ''), ids = (body.ids || []).map(String).filter(Boolean), now = Date.now();
  if (!ids.length) return { ok: false, message: 'no ids' };
  const mail = ids.filter(isMail), other = ids.filter((id) => !isMail(id));
  const res = { ok: true, act: a, n: ids.length, gmail: 0, failed: [] };
  const tx = db.transaction((fn) => fn());
  if (a === 'trash' || a === 'archive') {
    // the row leaves NOW; Gmail is told in parallel; a Gmail failure puts the row back and says so
    tx(() => { ids.forEach((id) => q.intentSet.run(id, 'gone', '1', now)); });
    if (mail.length) {
      const r = await pmap(mail, 10, (id) => a === 'trash' ? gapi('POST', '/threads/' + encodeURIComponent(id) + '/trash') : gapi('POST', '/threads/' + encodeURIComponent(id) + '/modify', null, { removeLabelIds: ['INBOX'] }));
      tx(() => { r.forEach((x, i) => { if (x && x.__err && !/gmail 404/.test(x.__err)) { res.failed.push(mail[i]); q.intentDelId.run(mail[i]); } else { res.gmail++; q.del.run(mail[i]); } }); });
    }
    if (other.length) { // comms delete = handled-forever (kit law v38.439): the words stay on record
      tx(() => { other.forEach((id) => { q.intentSet.run(id, 'gone', '0', now); q.intentSet.run(id, 'done', '1', now); }); });
      forward({ act: 'done', ids: other });
    }
    if (res.failed.length) { res.ok = false; res.message = res.failed.length + ' did not delete in Gmail'; }
    return res;
  }
  if (a === 'star' || a === 'unstar' || a === 'read' || a === 'unread') {
    const on = (a === 'star' || a === 'unread');
    tx(() => { ids.forEach((id) => q.intentSet.run(id, a === 'star' || a === 'unstar' ? 'starred' : 'unread', on ? '1' : '0', now)); });
    if (mail.length) {
      const lab = (a === 'star' || a === 'unstar') ? 'STARRED' : 'UNREAD';
      const r = await pmap(mail, 10, (id) => gapi('POST', '/threads/' + encodeURIComponent(id) + '/modify', null, on ? { addLabelIds: [lab] } : { removeLabelIds: [lab] }));
      r.forEach((x, i) => { if (x && x.__err) res.failed.push(mail[i]); else res.gmail++; });
      // reflect in the stored rows without waiting for the next delta
      tx(() => { mail.forEach((id) => { const row = q.one.get(id); if (!row) return; const j = JSON.parse(row.json); if (lab === 'STARRED') j.starred = on; else j.unread = on; q.upsert.run(id, 'mail', j.ts || 0, JSON.stringify(j), now); }); });
    }
    if (other.length) forward({ act: a, ids: other });
    return res;
  }
  if (a === 'done' || a === 'undone') {
    tx(() => { ids.forEach((id) => q.intentSet.run(id, 'done', a === 'done' ? '1' : '0', now)); });
    forward({ act: a, ids });
    return res;
  }
  if (a === 'filed') {   // folder '' = back to Unsorted; keys are triage keys, ids are row ids (both species, like bulkTriage)
    const folder = String(body.folder || ''), keys = (body.keys || []).map(String).filter(Boolean);
    tx(() => { ids.forEach((id) => { q.intentSet.run(id, 'filed', folder, now); if (!folder) q.intentSet.run(id, 'done', '0', now); }); });
    forward({ act: 'filed', ids, keys, folder, examples: (body.examples || []).slice(0, 20) });
    return res;
  }
  if (a === 'mach' || a === 'unmach' || a === 'mute' || a === 'unmute' || a === 'ops' || a === 'unops') { forward({ act: a, ids, items: body.items || null }); return res; }
  return { ok: false, message: 'unknown act ' + a };
}

// ---------------------------------------------------------------- server
function send(res, code, obj, req) {
  const s = JSON.stringify(obj);
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Inbox-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' };
  if (req && /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && s.length > 2048) { h['Content-Encoding'] = 'gzip'; res.writeHead(code, h); res.end(zlib.gzipSync(Buffer.from(s))); return; }
  res.writeHead(code, h); res.end(s);
}
function readBody(req) { return new Promise((resolve) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8') || '{}')); } catch (e) { resolve({}); } }); }); }
let _etag = '';
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  if (req.method === 'OPTIONS') return send(res, 204, {}, req);
  if (u.pathname === '/health') return send(res, 200, { inbox: VERSION, db: DB_PATH, diskLooksMounted: (function () { try { const st = require('fs').statSync(require('path').dirname(DB_PATH)); const root = require('fs').statSync('/'); return st.dev !== root.dev; } catch (e) { return false; } })(), rows: q.all.all().length, gmail: { lastAt: sync.lastAt, err: sync.lastErr, full: sync.full, delta: sync.delta, changed: sync.changed, historyId: meta.get('historyId'), creds: !!(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN) }, kit: { url: !!GAS_URL, lastAt: gas.lastAt, lastFull: gas.lastFull, err: gas.lastErr, pulls: gas.pulls, incs: gas.incs, lastMs: gas.ms, lastRows: gas.lastRows, busy: gas.busy, skipped: gas.skipped, lanes: gas.lastLanes, outbox: q.outCount.get().n }, wo: { rows: q.woCount.get().n, clients: (state.get('clients_full', []) || []).length, lastAt: wo.lastAt, lastFull: wo.lastFull, err: wo.err, peeks: wo.peeks, fulls: wo.fulls, lastMs: wo.ms, gen: meta.get('wo_gen') || '' } }, req);
  const key = u.query.key || req.headers['x-inbox-key'] || '';
  if (!KEY || key !== KEY) return send(res, 403, { ok: false, message: 'forbidden' }, req);
  try {
    if (u.pathname === '/inbox') {
      const rows = assemble();
      const body = { ok: true, rows, folders: state.get('folders', []), ver: VERSION, syncedAt: sync.lastAt, kitAt: gas.lastAt, gmailErr: sync.lastErr, kitErr: gas.lastErr };
      const et = require('crypto').createHash('md5').update(JSON.stringify(rows) + '|' + gas.lastAt).digest('hex');
      if (u.query.etag && u.query.etag === et) return send(res, 200, { ok: true, same: true, etag: et, syncedAt: sync.lastAt, kitAt: gas.lastAt }, req);
      body.etag = et; return send(res, 200, body, req);
    }
    if (u.pathname === '/inbox/thread') {
      const id = String(u.query.id || '').replace(/^mail\|/, '');
      if (!id) return send(res, 200, { error: 'no id' }, req);
      if (isMail(id)) { if (!/^[0-9a-f]{8,}$/i.test(id)) return send(res, 200, { error: 'This one was a phone call, not an email — there’s no message thread to open.' }, req); return send(res, 200, await mailThread(id), req); }
      const r = await fetchJson(GAS_URL + '?hook=ibxthread&k=' + encodeURIComponent(GAS_KEY) + '&id=' + encodeURIComponent(id), { timeout: 40000 });
      return send(res, 200, r.json || { error: 'kit did not answer' }, req);
    }
    if (u.pathname === '/inbox/att') {
      const a = await gapi('GET', '/messages/' + encodeURIComponent(String(u.query.msg || '')) + '/attachments/' + encodeURIComponent(String(u.query.att || '')));
      return send(res, 200, { success: true, dataB64: b64(a.data).toString('base64') }, req);
    }
    if (u.pathname === '/wo') {
      if (String(u.query.fresh || '') === '1' || !wo.lastFull) { if (wo.busy) { try { await wo.busy; } catch (e) { } } await woPull(false); }   // v1.2: the in-flight pull may predate the save - wait it out, then pull again
      const body = woPayload();
      const et = require('crypto').createHash('md5').update(body.gen + '|' + wo.lastFull).digest('hex');
      if (u.query.etag && u.query.etag === et) return send(res, 200, { ok: true, same: true, etag: et, gen: body.gen, syncedAt: wo.lastAt }, req);
      body.etag = et; body.ok = true; return send(res, 200, body, req);
    }
    if (u.pathname === '/wo/peek') {   // the app's 15s doorbell: {ok, token, changes:[]} - a new token with no changes makes the app reload from /wo (100ms)
      const tok = meta.get('wo_gen') || '';
      return send(res, 200, { ok: true, token: tok, changes: [], changed: String(u.query.since || '') !== tok, syncedAt: wo.lastAt }, req);
    }
    if (u.pathname === '/clients') { return send(res, 200, { clients: state.get('clients_full', []), _via: 'data-svc', syncedAt: wo.lastFull }, req); }
    if (req.method === 'POST' && u.pathname === '/wo/pull') { await woPull(String(u.query.full || '') === '1'); return send(res, 200, { ok: true, gen: wo.gen, err: wo.err, rows: q.woCount.get().n }, req); }
    if (req.method === 'POST' && u.pathname === '/inbox/act') { const b = await readBody(req); return send(res, 200, await act(b), req); }
    if (req.method === 'POST' && u.pathname === '/inbox/pull') { await gasPull('full'); return send(res, 200, { ok: true, kitAt: gas.lastAt, err: gas.lastErr, rows: gas.lastRows }, req); }
    if (req.method === 'POST' && u.pathname === '/inbox/resync') { await fullSync(); return send(res, 200, { ok: true, rows: q.all.all().length }, req); }
    return send(res, 404, { ok: false, message: 'no such door' }, req);
  } catch (e) { return send(res, 500, { ok: false, message: String(e && e.message || e).slice(0, 300) }, req); }
});
if (require.main === module) {
  server.listen(PORT, () => { console.log('aggie-inbox v' + VERSION + ' on ' + PORT + ' db=' + DB_PATH); });
  // ---------------------------------------------------------------- beats
  setTimeout(() => { syncTick(); gasPull('full'); }, 500);
  setInterval(syncTick, 10000);
  setInterval(() => { gasPull(); }, 10000);
  setInterval(() => { outboxTick().catch(() => { }); }, 5000);
  setInterval(draftTick, 60000);
  setTimeout(() => { woPull(true); }, 1500);
  setInterval(() => { woPull(false); }, 5000);
} else {
  module.exports = { mailRow, fmtDate, inboxSource, assemble, plainOf, state, q };
}
