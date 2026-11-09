// The log sync: Cloud Logging → GCS, run by this function's own service account, so viewers of the report need
// no access to the logs (which hold every prompt and answer) and can't write to the bucket.
//
// Pulls the Gemini Enterprise logs written since the last sync and saves them the way the report reads them:
// a Logs Explorer–style CSV, split into chats/ (what people typed and what the model answered) and metrics/
// (everything else). Where the last sync ended is the newest marker under metrics/sync/: create-only objects, never
// overwritten. Each sync starts 10 minutes before that point to catch entries that arrive late; the report folds the
// overlap away by insertId. No sync yet: the last 30 days (Cloud Logging's default retention).
//
// `request` is google-auth-library's client.request (or a test double): ({url, method, data, headers}) -> {data}.

const LOG_API = 'https://logging.googleapis.com/v2/entries:list';
const GCS_API = 'https://storage.googleapis.com/storage/v1/b/';
const GCS_UPLOAD = 'https://storage.googleapis.com/upload/storage/v1/b/';
const DIRS = { metrics: 'metrics/', chats: 'chats/' };
const SYNC_DIR = DIRS.metrics + 'sync/';
const OVERLAP_MS = 10 * 60 * 1000;
const FIRST_MS = 30 * 24 * 60 * 60 * 1000;

// ---- Which columns are text (the same rules as the report's split, src/app.js) ----

// Columns holding what a user typed or what the model answered.
const TEXT_PREFIXES = [
  'jsonpayload.gen_ai.input.messages',
  'jsonpayload.gen_ai.output.messages',
  'jsonpayload.request.userquery',
  'jsonpayload.request.userpromptdata',
  'jsonpayload.servicetextreply',
  'jsonpayload.sanitizationinput',
  'jsonpayload.response',              // NotebookLM answer body
  'jsonpayload.status.message',        // a failed call's error, which quotes the request (e.g. a source's URL)
];
// …except the Model Armor verdict, which lives under response but isn't text.
const TEXT_EXCEPTIONS = ['jsonpayload.response.sanitizationresult'];
// Catch-all for text columns the list doesn't know yet: a prompt leaking into the wider-access metrics file is the
// failure that matters, so anything that looks like content goes to chats only.
const TEXT_LIKE_RE = /(^|\.)(text|content|contents|parts|messages|query|prompt|reply|answer)(\.|$)/;
// Kept in chats as well, so a chats file still identifies, attributes and classifies each row on its own.
const CONTEXT_COLS = new Set([
  'insertid', 'timestamp', 'receivetimestamp', 'logname', 'severity',
  'trace',                               // ties a chat turn to the row that names its user
  'stats.question', 'stats.chat', 'stats.flagged', 'stats.blocked',   // so a chats-only reader counts the same (see addStats)
  'linkeduser',
  'jsonpayload.@type',
  'jsonpayload.gen_ai.conversation.id',
  'jsonpayload.useriamprincipal',
  'jsonpayload.operationtype',
  'jsonpayload.logmetadata.methodname',
  'jsonpayload.logmetadata.servicelabel',
  'jsonpayload.logmetadata.servicename',
  'jsonpayload.logmetadata.timestamp',
  'jsonpayload.logmetadata.name',
  'jsonpayload.request.name',
]);

// Exact columns that look like text by their path but hold an id: a StreamAssist turn's answer name
// (…/sessions/<chat>/assistAnswers/<turn>), which lets the report group a chat's turns without its text.
const NOT_TEXT = new Set(['jsonpayload.response.answer.name']);

const normHdr = h => String(h || '').replace(/^'+/, '').replace(/"/g, '').trim().toLowerCase();
const underAny = (h, list) => list.some(p => h === p || h.startsWith(p + '.'));
function isText(h) {
  if (NOT_TEXT.has(h)) return false;
  if (TEXT_LIKE_RE.test(h)) return true;
  if (underAny(h, TEXT_EXCEPTIONS)) return false;
  return underAny(h, TEXT_PREFIXES);
}

// ---- Entries → the two CSV files ----

// One row per entry: nested fields flattened with dots, a key that holds dots quoted
// (jsonPayload."gen_ai.input.messages"), arrays kept as JSON — the shape of a Logs Explorer CSV export.
function flatten(entry) {
  const row = {};
  const seg = k => (k.includes('.') ? `"${k}"` : k);
  const walk = (node, path) => {
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${seg(k)}` : seg(k);
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
      else row[p] = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    }
  };
  walk(entry, '');
  return row;
}

const cell = v => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
const csv = (cols, rows) => Buffer.from('﻿' + [cols, ...rows.map(r => cols.map(c => r[c] ?? ''))]
  .map(line => line.map(cell).join(',')).join('\r\n') + '\r\n', 'utf8');

// { metrics, chats } as CSV buffers; chats is null when no entry holds any text.
function splitEntries(entries) {
  const rows = entries.map(flatten);
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const textCols = cols.filter(c => isText(normHdr(c)));
  const metricCols = cols.filter(c => !textCols.includes(c));
  const chatCols = cols.filter(c => textCols.includes(c) || CONTEXT_COLS.has(normHdr(c)) || normHdr(c).startsWith('labels.'));
  // A chats row with no text in it carries nothing the metrics file lacks.
  const chatRows = rows.filter(r => textCols.some(c => (r[c] ?? '') !== ''));
  return {
    metrics: csv(metricCols, rows),
    chats: chatRows.length ? csv(chatCols, chatRows) : null,
    rows: rows.length,
    chatRows: chatRows.length,
  };
}

// ---- NotebookLM's Model Armor checks → their user ----

// A NotebookLM Model Armor check names no user, and nothing but its text ties it to the question it checked, which
// does (notebooklm_enterprise_user_activity: request.userQuery, userIamPrincipal). The text goes to chats/ only, so
// without chats access the report couldn't make that match. The sync can, while it holds both: it adds the
// question's user to the check as `linkedUser` (an email, which metrics/ holds anyway), the nearest in time within
// 10 minutes. Entries are changed in place. A question whose check flagged it is added to `flaggedQuestions`.
const isFlaggedCheck = p => p.sanitizationResult?.filterMatchState === 'MATCH_FOUND' ||
  /BLOCK/.test(p.sanitizationResult?.sanitizationVerdict || '');
const LINK_MS = 10 * 60 * 1000;
const normText = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
function linkNotebookChecks(entries, flaggedQuestions = new Set()) {
  const questions = {};
  for (const e of entries) {
    const p = e.jsonPayload || {};
    if (!/notebooklm_enterprise_user_activity/.test(e.logName || '') || !p.userIamPrincipal || !p.request?.userQuery) continue;
    (questions[normText(p.request.userQuery)] ||= []).push({ email: p.userIamPrincipal, ts: Date.parse(e.timestamp), entry: e });
  }
  let linked = 0;
  for (const e of entries) {
    const p = e.jsonPayload || {};
    const corr = String(e.labels?.['modelarmor.googleapis.com/client_correlation_id'] || '');
    if (!/SanitizeOperationLogEntry/.test(p['@type'] || '') || p.operationType !== 'SANITIZE_USER_PROMPT') continue;
    if (!corr.startsWith('NLM|') || p.userIamPrincipal) continue;
    const ts = Date.parse(e.timestamp);
    let best = null;
    for (const q of questions[normText(p.sanitizationInput?.text)] || []) {
      const gap = Math.abs(q.ts - ts);
      if (gap <= LINK_MS && (!best || gap < best.gap)) best = { ...q, gap };
    }
    if (!best) continue;
    e.linkedUser = best.email; linked++;
    if (isFlaggedCheck(p)) flaggedQuestions.add(best.entry);
  }
  return linked;
}

// ---- Stats columns ----

// The report's counts come from these, so they are the same with or without chats/ access (no text in them):
//   stats.question = 1  a user asked one question here: each Gemini Enterprise StreamAssist row (one per turn, also
//                       when Model Armor blocked it) and each NotebookLM question (GenerateFreeForm…)
//   stats.chat          the chat that question belongs to: the Gemini Enterprise session, or the NotebookLM notebook
//   stats.flagged = 1   that question's Model Armor check flagged it (Gemini Enterprise: the check's
//                       client_correlation_id ends with the turn's assistToken; NotebookLM: linkNotebookChecks)
//   stats.blocked = 1   a Model Armor check of a user prompt that blocked it
// Entries are changed in place.
function addStats(entries, flaggedQuestions = new Set()) {
  const flaggedTokens = new Set();
  for (const e of entries) {
    const p = e.jsonPayload || {};
    const corr = String(e.labels?.['modelarmor.googleapis.com/client_correlation_id'] || '');
    if (/SanitizeOperationLogEntry/.test(p['@type'] || '') && p.operationType === 'SANITIZE_USER_PROMPT'
        && corr.startsWith('AS|') && isFlaggedCheck(p)) flaggedTokens.add(corr.split('|').pop());
  }
  for (const e of entries) {
    const p = e.jsonPayload || {};
    const method = p.logMetadata?.methodName || e.resource?.labels?.method || '';
    if (method === 'StreamAssist') {
      const session = (String(p.response?.answer?.name || '').match(/\/sessions\/([^/]+)/) || [])[1] || '';
      const token = p.assistToken || p.response?.assistToken || '';
      e.stats = { question: 1, chat: session, ...(flaggedTokens.has(token) ? { flagged: 1 } : {}) };
    } else if (/notebooklm_enterprise_user_activity/.test(e.logName || '') && /^GenerateFreeForm/.test(method)) {
      const nb = (String(p.request?.name || p.logMetadata?.name || '').match(/notebooks\/([^/]+)/) || [])[1] || '';
      e.stats = { question: 1, chat: nb, ...(flaggedQuestions.has(e) ? { flagged: 1 } : {}) };
    } else if (/SanitizeOperationLogEntry/.test(p['@type'] || '') && p.operationType === 'SANITIZE_USER_PROMPT'
               && /BLOCK/.test(p.sanitizationResult?.sanitizationVerdict || '')) {
      e.stats = { blocked: 1 };
    }
  }
}

// ---- Times in object names ----

// 2026-11-09T15:32:00.123Z <-> 20261109T153200Z (an object name without colons)
const stamp = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');
function unstamp(s) {
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

// ---- The sync ----

async function lastSync(request, bucket) {
  let last = 0;
  let pageToken = '';
  do {
    const q = new URLSearchParams({ prefix: SYNC_DIR, maxResults: '1000', fields: 'items(name),nextPageToken' });
    if (pageToken) q.set('pageToken', pageToken);
    const { data } = await request({ url: `${GCS_API}${encodeURIComponent(bucket)}/o?${q}` });
    for (const o of data.items || []) last = Math.max(last, unstamp(o.name.slice(SYNC_DIR.length)));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return last;
}

// All entries of the filter in [from, to), oldest first. Cloud Logging allows about 60 reads a minute per project:
// a refused page waits and tries again.
async function readEntries(request, project, filter, fromMs, toMs, wait) {
  // The filter in parentheses: it may be several conditions joined with OR.
  const full = `(${filter}) AND timestamp>="${new Date(fromMs).toISOString()}" AND timestamp<"${new Date(toMs).toISOString()}"`;
  const entries = [];
  let pageToken = '';
  do {
    const data = { resourceNames: [`projects/${project}`], filter: full, orderBy: 'timestamp asc', pageSize: 1000 };
    if (pageToken) data.pageToken = pageToken;
    let page;
    for (let attempt = 0; ; attempt++) {
      try {
        page = (await request({ url: LOG_API, method: 'POST', data })).data;
        break;
      } catch (error) {
        const status = error.response?.status ?? error.status;
        if (status !== 429 || attempt >= 3) throw error;
        await wait(2000 * (attempt + 1));
      }
    }
    entries.push(...(page.entries || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return entries;
}

// Create-only: an object that already exists is left as it is (409/412 → false).
async function create(request, bucket, name, body, type) {
  const q = new URLSearchParams({ uploadType: 'media', name, ifGenerationMatch: '0' });
  try {
    await request({ url: `${GCS_UPLOAD}${encodeURIComponent(bucket)}/o?${q}`, method: 'POST', data: body, headers: { 'Content-Type': type } });
    return true;
  } catch (error) {
    const status = error.response?.status ?? error.status;
    if (status === 412 || status === 409) return false;
    throw error;
  }
}

async function sync({ request, project, bucket, filter, now = Date.now(), wait = ms => new Promise(r => setTimeout(r, ms)) }) {
  const to = now;
  const last = await lastSync(request, bucket);
  const from = last ? last - OVERLAP_MS : to - FIRST_MS;
  const entries = await readEntries(request, project, filter, from, to, wait);
  const result = { from: new Date(from).toISOString(), to: new Date(to).toISOString(), entries: entries.length, chatRows: 0 };
  if (entries.length) {
    const base = `auto-${stamp(from)}_${stamp(to)}.csv`;
    const flaggedQuestions = new Set();
    linkNotebookChecks(entries, flaggedQuestions);
    addStats(entries, flaggedQuestions);
    const parts = splitEntries(entries);
    // Chats first: if metrics then fails, the restricted half is the one already in place, never the other way round.
    if (parts.chats) await create(request, bucket, DIRS.chats + base, parts.chats, 'text/csv');
    await create(request, bucket, DIRS.metrics + base, parts.metrics, 'text/csv');
    result.chatRows = parts.chatRows;
  }
  // The marker last: a sync that failed halfway is done again by the next one.
  await create(request, bucket, `${SYNC_DIR}${stamp(to)}.done`, Buffer.alloc(0), 'text/plain');
  return result;
}

// ---- Access to other people's chats ----

// One create-only object per access: who opened whose chats, when, and the reason they gave. Outside chats/ and
// metrics/, so only bucket-wide readers (the admins) can read it; nobody but the function can write it.
const ACCESS_DIR = 'audit/access/';
async function recordAccess({ request, bucket, viewer, viewed, reason, now = Date.now() }) {
  const name = `${ACCESS_DIR}${stamp(now)}_${require('crypto').randomUUID()}.json`;
  const entry = { at: new Date(now).toISOString(), viewer, viewed, reason };
  await create(request, bucket, name, Buffer.from(JSON.stringify(entry, null, 2), 'utf8'), 'application/json');
  return { name, ...entry };
}

module.exports = { sync, recordAccess, linkNotebookChecks, addStats, splitEntries, flatten, isText, stamp, unstamp, SYNC_DIR, ACCESS_DIR };
