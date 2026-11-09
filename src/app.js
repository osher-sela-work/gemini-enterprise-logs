<script>
if(typeof ChartDataLabels!=='undefined') Chart.register(ChartDataLabels);

/* ═══════════════════════════════════════════════════════════════
   Gemini Enterprise usage report — single-file, offline, no build.

   Input: the Gemini Enterprise agent logs, pulled from the Cloud Logging
   API into GCS by the sync function (sync-function/, see logSync) and
   read back from there. Two record shapes matter:

     • gen_ai.client.inference.operation.details  (severity INFO)
       Carries the whole conversation in gen_ai.input.messages,
       replayed cumulatively on every turn, plus a conversation id.

     • ModelArmorAudit                            (severity WARNING)
       Carries the raw prompt that tripped a safety filter, the
       verdict, and — crucially — the user's IAM principal.

   The two shapes do NOT share an identity key: inference rows have
   the conversation but usually no email, ModelArmor rows have the
   email but no conversation id. resolveAttribution() bridges that
   gap explicitly and never silently guesses — see the notice banner.
   ═══════════════════════════════════════════════════════════════ */

/* ── State ────────────────────────────────────────────────── */
let records   = [];    // every parsed log row
let convs     = [];    // reconstructed conversations
let users     = [];    // per-user rollup
let flagged   = [];    // ModelArmor records that matched a filter
let fileNames = [];
let gran      = 'day';
let customFrom = null, customTo = null;
let view      = 'users';
let charts    = {};
let linkedCount = 0;   // conversations attributed by time-proximity
let parseWarnings = [];

const UNATTRIBUTED = '(לא משויך)';
const LINK_WINDOW_MS   = 10 * 60 * 1000;  // identity join: armor row ↔ user
const ATTACH_WINDOW_MS =  5 * 60 * 1000;  // turn join: blocked prompt ↔ conversation
const PALETTE = ['#8AB4F8','#AB47BC','#00BFA5','#F9AB00','#EF5350','#4285F4',
                 '#34A853','#FF6D00','#26C6DA','#EC407A','#9CCC65','#7E57C2'];

/* ── Product identity ─────────────────────────────────────────
   Inline SVG rather than emoji: emoji render differently per platform and
   can't inherit the theme's colours. Both marks are single paths on a
   24-box so they scale to any size and take currentColor.               */
const PRODUCTS = {
  'Gemini Enterprise': {
    short:'Gemini', color:'#8AB4F8',
    path:'M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z',
    fill:true,
  },
  'NotebookLM': {
    short:'NotebookLM', color:'#F9AB00',
    path:'M7 3h11a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7zM7 3H5.5A1.5 1.5 0 0 0 4 4.5v15A1.5 1.5 0 0 0 5.5 21H7M10 8h6M10 12h6M10 16h3',
    fill:false,
  },
};
const prodOf = name => PRODUCTS[name] || PRODUCTS['Gemini Enterprise'];

function prodIcon(name, size){
  const p=prodOf(name), s=size||13;
  return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true" `+
    `style="flex-shrink:0;vertical-align:-2px">`+
    `<path d="${p.path}" ${p.fill
      ? `fill="currentColor"`
      : `fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`}/>`+
    `</svg>`;
}
function prodBadge(name, opts){
  const p=prodOf(name), o=opts||{};
  return `<span class="prod-chip" title="${esc(name)}" style="color:${p.color};`+
    `border-color:${p.color}55;background:${p.color}1f">`+
    prodIcon(name, o.size||12)+(o.labelled===false?'':esc(o.short?p.short:name))+`</span>`;
}
// Products actually present, in a stable order.
function availProducts(){
  const seen=new Set();
  records.forEach(r=>{ if(r.product) seen.add(r.product); });
  return Object.keys(PRODUCTS).filter(p=>seen.has(p))
    .concat([...seen].filter(p=>!PRODUCTS[p]));
}
let visProducts = null;   // null = all; otherwise Set of enabled product names
const prodOn = name => !visProducts || visProducts.has(name);

/* ── Small helpers ────────────────────────────────────────── */
const $  = id => document.getElementById(id);
const esc = s => String(s==null?'':s).replace(/[&<>"']/g,c=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtNum = n => (n==null||isNaN(n))?'—':n.toLocaleString('en-US');
const pad = n => String(n).padStart(2,'0');

function colorFor(str){
  let h=0; for(let i=0;i<String(str).length;i++) h=(h*31+String(str).charCodeAt(i))|0;
  return PALETTE[Math.abs(h)%PALETTE.length];
}
function initials(email){
  const s=(email||'?').split('@')[0].replace(/[._-]+/g,' ').trim();
  const p=s.split(/\s+/);
  return ((p[0]||'?')[0]+(p[1]?p[1][0]:'')).toUpperCase();
}
function fmtTs(ms,withSec){
  if(!ms) return '—';
  const d=new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
       + (withSec?`:${pad(d.getSeconds())}`:'');
}

function toggleTheme(){
  const light=document.documentElement.classList.toggle('light');
  $('btn-theme').textContent = light?'☀️':'🌙';
  try{ localStorage.setItem('ge-theme', light?'light':'dark'); }catch(_){}
  if(records.length) renderAll();
}
(function(){
  try{
    if(localStorage.getItem('ge-theme')==='light'){
      document.documentElement.classList.add('light');
      const b=$('btn-theme'); if(b) b.textContent='☀️';
    }
  }catch(_){}
})();

/* ── Loader ───────────────────────────────────────────────── */
function showLoader(label){
  $('loader-name').textContent=label||'';
  $('loader-bar').style.width='0%';
  $('loader').style.display='flex';
}
function setProgress(p){ $('loader-bar').style.width=Math.max(0,Math.min(100,p))+'%'; }
function hideLoader(){ setProgress(100); setTimeout(()=>{ $('loader').style.display='none'; },260); }

/* ═══ Text repair ══════════════════════════════════════════ */

// Excel writes a leading apostrophe to force text mode, and wraps some
// fields in quotes. Strip both without touching legitimate content.
function stripExcel(v){
  let s=String(v==null?'':v);
  if(s.startsWith("'")) s=s.slice(1);
  return s.trim();
}

// UTF-8 bytes decoded as Windows-1255 (Hebrew ANSI) — the classic
// Excel-on-Hebrew-Windows corruption. "ג˜€ן¸" is ☀️ mangled this way.
// Re-encode through cp1255 and decode as UTF-8 to recover the original.
const CP1255_HIGH =
  '€‚ƒ„…†‡ˆ‰T‹‘’“”•–—˜™›'+
  ' ¡¢£₪¥¦§¨©×«¬­®¯°±²³´µ¶·¸¹÷»¼½¾¿'+
  'ְֱֲֳִֵֶַָֹֺ ּֽ־ֿ׀ׁׂ׃ װױײ׳״���������'+
  'אבגדהוזחטיךכלםמןנסעףפץצקרשת��‎‏�';
let _cp1255Map=null;
function cp1255Byte(ch){
  const c=ch.charCodeAt(0);
  if(c<0x80) return c;
  if(!_cp1255Map){
    _cp1255Map={};
    for(let i=0;i<CP1255_HIGH.length;i++) _cp1255Map[CP1255_HIGH[i]]=0x80+i;
  }
  const b=_cp1255Map[ch];
  return b==null?-1:b;
}
function repairMojibake(s){
  if(!s || !/[א-ת][-״‘-”˜]|ג˜|×|ן¸/.test(s)) return s;
  const bytes=[];
  for(const ch of s){
    const b=cp1255Byte(ch);
    if(b<0) return s;                       // not representable — leave as-is
    bytes.push(b);
  }
  try{
    const out=new TextDecoder('utf-8',{fatal:true}).decode(new Uint8Array(bytes));
    return out;
  }catch(_){ return s; }
}
// Only worth attempting on short display strings; long JSON blobs are
// re-checked per extracted text fragment instead.
function fixText(s){
  if(!s) return s;
  const r=repairMojibake(s);
  return r||s;
}

/* ═══ Tabular parsing ══════════════════════════════════════ */

// Full CSV/TSV parser: quoted fields, escaped "", embedded newlines.
// Separator is sniffed from the header line.
function parseTable(text){
  const first=text.split('\n')[0]||'';
  const sep = first.split('\t').length >= first.split(',').length ? '\t' : ',';
  /* A quote only delimits when it OPENS a field (RFC 4180). Treating every
     quote as a delimiter shreds unquoted JSON payloads — gen_ai.input.messages
     arrives as bare [{"parts":...}] and came out as [{parts:...}], which then
     failed JSON.parse and silently emptied every conversation. */
  const rows=[]; let cells=[], cur='', inQ=false, fieldStart=true;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(inQ){
      if(ch==='"'){ if(text[i+1]==='"'){cur+='"';i++;} else inQ=false; }
      else cur+=ch;
    } else {
      if(ch==='"' && fieldStart){ inQ=true; fieldStart=false; }
      else if(ch===sep){ cells.push(cur); cur=''; fieldStart=true; }
      else if(ch==='\n'){ cells.push(cur); rows.push(cells); cells=[]; cur=''; fieldStart=true; }
      else if(ch!=='\r'){ cur+=ch; fieldStart=false; }
    }
  }
  if(cur!==''||cells.length){ cells.push(cur); rows.push(cells); }
  return rows.filter(r=>r.length>1||(r[0]||'').trim()!=='');
}

// Header names arrive as: 'jsonPayload."gen_ai.conversation.id"
// Normalize away the Excel quote-guard, JSON quoting and case.
/* ── Header paths → nested objects ────────────────────────────

   Cloud Logging CSV headers are the JSON paths flattened with dots, e.g.

     jsonPayload.sanitizationResult.filterResults.rai.raiFilterResult.matchState
     jsonPayload."gen_ai.conversation.id"

   Rebuilding the nested object from those headers means CSV and JSON
   exports converge on one shape, so every downstream reader is written
   once. It also means new columns work without code changes — which
   matters, because Google keeps adding filter types.                    */

// Header text as written by the console: strip the Excel quote-guard and
// JSON quoting so names can be compared case-insensitively.
const normHdr = h => String(h||'').replace(/^'+/,'').replace(/"/g,'').trim().toLowerCase();

// Split on dots, but treat a "quoted.segment" as one key.
function splitPath(h){
  const s=String(h||'').replace(/^'+/,'').trim();
  const out=[]; let cur='', inQ=false;
  for(const ch of s){
    if(ch==='"'){ inQ=!inQ; continue; }
    if(ch==='.'&&!inQ){ if(cur) out.push(cur); cur=''; continue; }
    cur+=ch;
  }
  if(cur) out.push(cur);
  return out;
}
function setPath(obj, path, val){
  const parts=splitPath(path);
  if(!parts.length) return;
  let cur=obj;
  for(let i=0;i<parts.length-1;i++){
    const k=parts[i];
    if(!cur[k] || typeof cur[k]!=='object') cur[k]={};
    cur=cur[k];
  }
  cur[parts[parts.length-1]]=val;
}
// Safe nested read: get(o,'jsonPayload.request.userQuery')
/* Cloud Logging mixes two key styles: real nesting (resource.labels.location)
   and single keys that contain dots, quoted in the header
   (jsonPayload."gen_ai.input.messages" → one key "gen_ai.input.messages").
   A lookup path can't tell them apart, so at every level try the joined
   remainder as a literal key before descending. Getting this wrong silently
   empties every Gemini conversation. */
function get(o, path){
  const parts=splitPath(path);
  const walk=(node,i)=>{
    if(node==null) return undefined;
    if(i>=parts.length) return node;
    if(typeof node!=='object') return undefined;
    const rest=parts.slice(i).join('.');
    if(node[rest]!==undefined) return node[rest];      // literal dotted key
    const k=parts[i];
    if(node[k]===undefined) return undefined;
    return walk(node[k], i+1);
  };
  return walk(o,0);
}
// First defined, non-empty value among several paths.
function getAny(o, ...paths){
  for(const p of paths){
    const v=get(o,p);
    if(v!=null && v!=='') return v;
  }
  return '';
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

function parseTs(v){
  const s=stripExcel(v);
  if(!s) return 0;
  const t=Date.parse(s);
  if(!isNaN(t)) return t;
  const m=s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if(m) return Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]);
  return 0;
}
function jsonOr(v,fallback){
  if(Array.isArray(v)||(v&&typeof v==='object')) return v;
  const s=stripExcel(v);
  if(!s) return fallback;
  try{ return JSON.parse(s); }catch(_){ return fallback; }
}

// Any email anywhere in the entry — some exports put the principal in an
// unexpected column, and missing the user is worse than a stray match.
function findEmail(node, depth){
  if(depth>6 || node==null) return '';
  if(typeof node==='string'){
    if(node.length<300 && EMAIL_RE.test(node)) return node.match(EMAIL_RE)[0].toLowerCase();
    return '';
  }
  if(typeof node!=='object') return '';
  for(const v of Object.values(node)){
    const hit=findEmail(v,(depth||0)+1);
    if(hit) return hit;
  }
  return '';
}

/* ── Streamed-response collapse ───────────────────────────────
   NotebookLM logs the streamed answer as progressive snapshots
   concatenated together — the same opening sentence repeats several
   times, each pass longer than the last. Keep the longest pass.      */
function collapseStreamed(text){
  const s=String(text||'').trim();
  // A repeated opening is the signal, not overall length — short answers
  // stream too. Need room for at least two copies of the probe.
  const plen=Math.min(60, Math.floor(s.length/3));
  if(plen<20) return s;
  const probe=s.slice(0,plen);
  if(!probe.trim()) return s;
  const idx=[]; let at=s.indexOf(probe);
  while(at>=0 && idx.length<200){ idx.push(at); at=s.indexOf(probe, at+1); }
  if(idx.length<2) return s;
  let best='';
  idx.forEach((start,i)=>{
    const seg=s.slice(start, i+1<idx.length?idx[i+1]:s.length).trim();
    if(seg.length>best.length) best=seg;
  });
  return best||s;
}

/* ── Model Armor filter results ───────────────────────────────

   The authoritative per-filter breakdown lives in
   sanitizationResult.filterResults — NOT in sanitizationMetadata, which
   only carries filter *version* config (a deprecation warning).

   Shape is family → oneFilterResultKey → { matchState, confidenceLevel }
   with Responsible AI nesting its real categories one level deeper under
   raiFilterTypeResults. Only MATCH_FOUND entries count.                */
const FILTER_LABEL = {
  rai:'Responsible AI', pi_and_jailbreak:'Prompt Injection / Jailbreak',
  sdp:'Sensitive Data', csam:'CSAM', malicious_uris:'Malicious URIs',
  hate_speech:'Hate Speech', harassment:'Harassment', dangerous:'Dangerous',
  sexually_explicit:'Sexually Explicit', virus_scan:'Virus Scan',
};
const isMatch = v => String(v==null?'':v).toUpperCase()==='MATCH_FOUND';

function matchedFilters(san){
  const out=[];
  const fr=san && san.filterResults;
  if(!fr || typeof fr!=='object') return out;
  Object.entries(fr).forEach(([family,wrap])=>{
    if(!wrap||typeof wrap!=='object') return;
    // Unwrap the single xxxFilterResult key; tolerate it being absent.
    const inner = wrap.matchState!==undefined ? wrap : (Object.values(wrap)[0]||{});
    if(!inner||typeof inner!=='object') return;
    const sub = inner.raiFilterTypeResults;
    if(sub && typeof sub==='object'){
      Object.entries(sub).forEach(([k,v])=>{
        if(v&&isMatch(v.matchState))
          out.push({key:k, label:FILTER_LABEL[k]||k, conf:v.confidenceLevel||'', family});
      });
      return;                       // don't also emit the generic "rai"
    }
    const node = inner.inspectResult || inner;
    if(isMatch(node.matchState))
      out.push({key:family, label:FILTER_LABEL[family]||family,
                conf:node.confidenceLevel||inner.confidenceLevel||'', family});
  });
  return out;
}

/* ── Entry → record ───────────────────────────────────────── */
function entryToRecord(e){
  const svcLabel = String(getAny(e,'jsonPayload.logMetadata.serviceLabel')||'');
  const logName  = String(getAny(e,'logName')||'');
  const atType   = String(getAny(e,'jsonPayload.@type')||'');
  const method   = String(getAny(e,'jsonPayload.logMetadata.methodName')||'');
  const opType   = String(getAny(e,'jsonPayload.operationType')||'');

  const san = jsonOr(get(e,'jsonPayload.sanitizationResult') ||
                     get(e,'jsonPayload.response.sanitizationResult'), null);

  const isNotebook = /NOTEBOOKLM/i.test(svcLabel) || /notebooklm/i.test(logName) ||
                     /notebooklm/i.test(String(getAny(e,'jsonPayload.logMetadata.serviceName')));
  const isArmor    = /SanitizeOperationLogEntry/i.test(atType) ||
                     /modelarmor/i.test(logName) || method==='ModelArmorAudit' ||
                     !!opType || !!san;
  const convId     = String(getAny(e,'jsonPayload.gen_ai.conversation.id')||'');
  const inputMsgs  = jsonOr(get(e,'jsonPayload.gen_ai.input.messages'), []);

  const kind = isNotebook ? 'notebooklm'
             : isArmor    ? 'armor'
             : (convId || (Array.isArray(inputMsgs)&&inputMsgs.length)) ? 'inference'
             : 'other';

  /* Model Armor sanitizes BOTH directions, and both land in the same
     sanitizationInput.text column. SANITIZE_MODEL_RESPONSE rows hold chunks
     of the model's streamed reply — treating those as user prompts fills the
     "bad questions" report with fragments like " 8]." and inflates every
     count. operationType is what separates them.                          */
  const armorOp = /RESPONSE/i.test(opType) ? 'response'
                : /PROMPT/i.test(opType)   ? 'prompt'
                : kind==='armor'           ? 'prompt' : '';

  const sanText = fixText(String(getAny(e,'jsonPayload.sanitizationInput.text')||''));
  const promptText = fixText(String(getAny(e,
    'jsonPayload.request.userQuery',
    'jsonPayload.request.userPromptData.text')||''))
    || (armorOp==='prompt' ? sanText : '');
  const responseText = armorOp==='response' ? sanText : '';

  // NotebookLM's answer is in serviceTextReply — jsonPayload.response is
  // present in the export but always empty. It arrives as concatenated
  // streaming snapshots, so collapse it back to the final pass.
  let answer=String(getAny(e,'jsonPayload.serviceTextReply')||'');
  if(!answer){
    (function deepest(node,d){
      if(d>4||node==null) return;
      if(typeof node==='string'){ if(node.length>answer.length) answer=node; return; }
      if(typeof node==='object') Object.values(node).forEach(v=>deepest(v,(d||0)+1));
    })(get(e,'jsonPayload.response'),0);
  }
  answer=collapseStreamed(fixText(answer));

  const notebookPath = String(getAny(e,'jsonPayload.request.name',
                                       'jsonPayload.logMetadata.name')||'');
  const nbMatch = notebookPath.match(/notebooks\/([^/]+)/);

  const verdict = String(getAny(e,'jsonPayload.sanitizationResult.sanitizationVerdict',
                                  'jsonPayload.response.sanitizationResult.sanitizationVerdict')||'');
  const match   = String(getAny(e,'jsonPayload.sanitizationResult.filterMatchState',
                                  'jsonPayload.response.sanitizationResult.filterMatchState')||'');
  const reason  = fixText(String(getAny(e,
    'jsonPayload.sanitizationResult.sanitizationVerdictReason',
    'jsonPayload.response.sanitizationResult.sanitizationVerdictReason')||''));

  const email = String(getAny(e,'jsonPayload.userIamPrincipal')||'').match(EMAIL_RE)?.[0]?.toLowerCase()
             || findEmail(e,0);

  const labels = get(e,'labels') || {};
  const corr = String(labels['modelarmor.googleapis.com/client_correlation_id']||'');

  return {
    kind,
    ts: parseTs(getAny(e,'timestamp','jsonPayload.logMetadata.timestamp','receiveTimestamp')),
    insertId: String(getAny(e,'insertId')||''),
    email, emailSrc: email?'direct':'',
    // Which product the event came from — drives the UI badge and filters.
    product: kind==='notebooklm' ? 'NotebookLM'
           : /NLM\|/.test(corr) ? 'NotebookLM'
           : /GEMINI/i.test(svcLabel)||kind==='inference' ? 'Gemini Enterprise'
           : 'Gemini Enterprise',
    convId,
    invocationId: String(getAny(e,'jsonPayload.gcp.vertex.agent.invocation_id')||''),
    eventId: String(getAny(e,'jsonPayload.gcp.vertex.agent.event_id')||''),
    agentName: String(getAny(e,'jsonPayload.gen_ai.agent.name',
                               'resource.labels.agent_id', 'jsonPayload.logMetadata.methodName')||''),
    engineId: String(getAny(e,'resource.labels.engine_id')||''),
    assistantId: String(getAny(e,'resource.labels.assistant_id')||''),
    location: String(getAny(e,'resource.labels.location')||''),
    severity: String(getAny(e,'severity')||'INFO').toUpperCase(),
    notebookId: nbMatch?nbMatch[1]:'',
    notebookPath,
    method, correlationId: corr, armorOp, opType, responseText,
    templateId: String(getAny(e,'resource.labels.template_id')||''),
    inputMsgs:  kind==='inference'?(Array.isArray(inputMsgs)?inputMsgs:[]):[],
    outputMsgs: kind==='inference'?jsonOr(get(e,'jsonPayload.gen_ai.output.messages'),[]):[],
    finishReasons: jsonOr(get(e,'jsonPayload.gen_ai.response.finish_reasons'),[]),
    inputTokens: parseInt(getAny(e,'jsonPayload.gen_ai.usage.input_tokens'),10)||0,
    promptText, answer,
    filterMatch: match, verdict, verdictReason: reason,
    filters: matchedFilters(san),
    matched: match==='MATCH_FOUND',
    blocked: /BLOCK/i.test(verdict),
  };
}

// Worth parsing at all?
function looksRelevant(r){
  return !!(r.ts && (r.promptText || r.convId || r.inputMsgs.length ||
                     r.verdict || r.notebookId || r.answer));
}

/* ── Google Cloud Storage ─────────────────────────────────── */
// Objects are read with the signed-in user's own OAuth token, so what they
// can load is exactly what IAM grants them on the bucket. Nothing secret
// ships in the page: an OAuth client ID is public by design.
// Setup: OAuth "Web application" client with this page's origin under
// Authorized JavaScript origins, plus a CORS rule on the bucket.
const GCS_CLIENT_ID = '569858054254-dbnl4e84molmbp75odtf144i4rb266rv.apps.googleusercontent.com';   // e.g. '1234-abc.apps.googleusercontent.com'
// The log sync (the Cloud Run function in sync-function/) saves every sync
// split into these two folders; IAM on each folder decides who can read it.
const GCS_BUCKET = 'icl-database';
const GCS_DIRS = { metrics:'metrics/', chats:'chats/' };
// The function's URL. Called every time someone opens the report, with the
// signed-in user's token; it pulls the new logs from Cloud Logging with its
// own service account, so nobody here needs access to the logs or can write.
// The publishing workflow (.github/workflows/static.yml) puts it in from the
// SYNC_URL repository secret, so it isn't in the code; the published page
// still holds it, as the browser needs it to call the function.
const SYNC_URL = '__SYNC_URL__';
const syncConfigured = ()=>/^https:\/\//.test(SYNC_URL);
const GCS_SCOPE_RO = 'https://www.googleapis.com/auth/devstorage.read_only';
const GCS_SCOPE_FC = 'https://www.googleapis.com/auth/devstorage.full_control';  // IAM edits only
// Which already-held tokens satisfy a request for each scope.
const GCS_SCOPE_COVER = {
  [GCS_SCOPE_RO]:[GCS_SCOPE_RO,GCS_SCOPE_FC],
  [GCS_SCOPE_FC]:[GCS_SCOPE_FC],
};
const GCS_API    = 'https://storage.googleapis.com/storage/v1/b/';
const GCS_EXT_RE = /\.(csv|tsv|txt|json|jsonl)$/i;
const GCS_MAX_LIST = 5000;
// Everyone gets a read-only token; full control is requested only for an
// admin's IAM edits. IAM still decides what either can touch.
const gcsTok={};            // scope -> {token, exp}
const gcsTokenClients={};   // scope -> GIS token client
let gcsPending=null;
let gcsObjects=[];
let gcsGis=null;
let gcsUser=null;           // {email} once signed in
let gcsCaps=null;           // what IAM lets this user do — see gcsLoadCaps

function gcsLoadGis(){
  if(window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  if(!gcsGis) gcsGis=new Promise((res,rej)=>{
    const s=document.createElement('script');
    s.src='https://accounts.google.com/gsi/client'; s.async=true;
    s.onload=()=>res();
    s.onerror=()=>{ gcsGis=null; rej(new Error('לא ניתן לטעון את Google Sign-In (בדוק חיבור לרשת).')); };
    document.head.appendChild(s);
  });
  return gcsGis;
}

async function gcsGetToken(scope){
  scope=scope||GCS_SCOPE_RO;
  // A wider token covers narrower requests, so reuse one if we have it.
  for(const s of GCS_SCOPE_COVER[scope]){
    const t=gcsTok[s];
    if(t && Date.now()<t.exp-60000) return t.token;
  }
  if(!GCS_CLIENT_ID) throw new Error('GCS_CLIENT_ID לא הוגדר ב-app.js.');
  if(location.protocol==='file:')
    throw new Error('התחברות Google דורשת http(s) — פתח את הדף המפורסם או הרץ serve.ps1.');
  await gcsLoadGis();
  if(!gcsTokenClients[scope]) gcsTokenClients[scope]=google.accounts.oauth2.initTokenClient({
    client_id:GCS_CLIENT_ID,
    // The sign-in doubles as identity: the email names the session.
    scope: scope===GCS_SCOPE_RO ? `${scope} openid email` : scope,
    // A later upgrade (admin) stays on the account already signed in.
    hint: gcsUser ? gcsUser.email : undefined,
    callback:r=>{
      const p=gcsPending; gcsPending=null; if(!p) return;
      if(r.error) return p.rej(new Error(r.error_description||r.error));
      gcsTok[scope]={token:r.access_token, exp:Date.now()+(parseInt(r.expires_in,10)||3600)*1000};
      if(scope===GCS_SCOPE_RO && gcsUser) gcsSaveSession();   // a re-sign-in extends the session
      p.res(r.access_token);
    },
    error_callback:e=>{
      const p=gcsPending; gcsPending=null;
      if(p) p.rej(new Error(e.type==='popup_closed'?'ההתחברות בוטלה.':(e.message||e.type)));
    },
  });
  return new Promise((res,rej)=>{
    gcsPending={res,rej};
    gcsTokenClients[scope].requestAccessToken({prompt:Object.keys(gcsTok).length?'':'select_account'});
  });
}

async function gcsFetch(url, opts, retried){
  opts=opts||{};
  const scope=opts.scope||GCS_SCOPE_RO;
  const tok=await gcsGetToken(scope);
  let r;
  try{
    r=await fetch(url,{method:opts.method||'GET', body:opts.body,
      headers:Object.assign({Authorization:`Bearer ${tok}`}, opts.headers)});
  }
  catch(_){ throw new Error('הבקשה נחסמה — כנראה חסרה הגדרת CORS על ה-bucket עבור '+location.origin); }
  if(r.status===401 && !retried){ delete gcsTok[scope]; return gcsFetch(url,opts,true); }
  if(!r.ok){
    let msg=r.statusText;
    try{ msg=(await r.json()).error.message||msg; }catch(_){}
    if(r.status===403) msg='אין הרשאה (IAM) — '+msg;
    if(r.status===404) msg='לא נמצא — '+msg;
    throw new Error(`${r.status}: ${msg}`);
  }
  return r;
}

function gcsStatus(msg,isErr){
  const s=$('gcs-status'); s.textContent=msg||''; s.classList.toggle('err',!!isErr);
}

function gcsConfigError(){
  if(!GCS_CLIENT_ID) return 'GCS_CLIENT_ID לא הוגדר ב-app.js.';
  if(!GCS_BUCKET)    return 'GCS_BUCKET לא הוגדר ב-app.js.';
  if(location.protocol==='file:')
    return 'התחברות Google דורשת http(s) — פתח את הדף המפורסם או הרץ serve.ps1.';
  return '';
}

function openGcs(){
  $('gcs-modal').classList.add('on');
  const err=gcsConfigError();
  if(err){ gcsStatus(err,true); return; }
  // Preload so the sign-in popup opens inside the click's user activation.
  gcsLoadGis().catch(()=>{});
  if(!gcsObjects.length) gcsStatus('בחר תיקייה.');
}
function closeGcs(){ $('gcs-modal').classList.remove('on'); }

async function gcsList(which){
  const err=gcsConfigError();
  if(err){ gcsStatus(err,true); return; }
  const prefix=GCS_DIRS[which];
  document.querySelectorAll('#gcs-dirs .seg').forEach(b=>b.classList.toggle('on',b.dataset.d===which));

  gcsStatus('טוען רשימת קבצים…');
  gcsObjects=[];
  $('gcs-access').style.display='none'; $('gcs-foot').style.display='flex';
  $('gcs-list').style.display='none'; $('gcs-load').disabled=true; $('gcs-count').textContent='';
  try{
    const {items, truncated}=await gcsListObjects(prefix);
    gcsObjects=items;
    gcsRenderList(truncated);
  }catch(err){
    gcsStatus(/^403/.test(err.message)?'אין לך הרשאה לתיקייה הזו.':err.message,true);
  }
}

// Newest first; only file types the report can read.
async function gcsListObjects(prefix){
  const items=[]; let pageToken='';
  do{
    const q=new URLSearchParams({prefix, maxResults:'1000',
      fields:'items(name,size,updated),nextPageToken'});
    if(pageToken) q.set('pageToken',pageToken);
    const j=await (await gcsFetch(`${GCS_API}${encodeURIComponent(GCS_BUCKET)}/o?${q}`)).json();
    // Filtered here, so the sync markers under metrics/sync/ don't count against the cap.
    items.push(...(j.items||[]).filter(o=>GCS_EXT_RE.test(o.name)));
    pageToken=j.nextPageToken;
  }while(pageToken && items.length<GCS_MAX_LIST);
  return {
    items: items.sort((a,b)=>String(b.updated).localeCompare(String(a.updated))),
    truncated: !!pageToken,
  };
}

async function gcsIngestObjects(objs, label){
  showLoader(label);
  let done=0;
  for(const o of objs){
    try{
      const r=await gcsFetch(`${GCS_API}${encodeURIComponent(GCS_BUCKET)}/o/${encodeURIComponent(o.name)}?alt=media`);
      ingestText(await r.text(), o.name.split('/').pop());
    }catch(err){ parseWarnings.push(`${o.name}: ${err.message}`); }
    setProgress(10+80*(++done)/objs.length);
  }
  finishLoad();
}

function gcsRenderList(truncated){
  const list=$('gcs-list');
  if(!gcsObjects.length){
    gcsStatus('אין קבצים בתיקייה הזו.'); list.style.display='none'; return;
  }
  const kb=n=>{ n=+n||0; return n<1048576?`${Math.ceil(n/1024)} KB`:`${(n/1048576).toFixed(1)} MB`; };
  list.innerHTML=gcsObjects.map((o,i)=>
    `<label><input type="checkbox" value="${i}" onchange="gcsSync()"/>`+
    `<span class="nm" title="${esc(o.name)}">${esc(o.name)}</span>`+
    `<span class="meta">${kb(o.size)} · ${fmtTs(Date.parse(o.updated))}</span></label>`).join('');
  list.style.display='block';
  $('gcs-all').checked=false;
  gcsStatus(`${gcsObjects.length} קבצים`+(truncated?` (מוצגים ${GCS_MAX_LIST} הראשונים)`:''));
  gcsSync();
}

function gcsToggleAll(on){
  document.querySelectorAll('#gcs-list input').forEach(c=>{ c.checked=on; });
  gcsSync();
}
function gcsSync(){
  const n=document.querySelectorAll('#gcs-list input:checked').length;
  $('gcs-count').textContent=n?`${n} נבחרו`:'';
  $('gcs-load').disabled=!n;
}

async function gcsLoad(){
  const picked=Array.from(document.querySelectorAll('#gcs-list input:checked'))
    .map(c=>gcsObjects[+c.value]).filter(Boolean);
  if(!picked.length) return;
  closeGcs();
  await gcsIngestObjects(picked, picked.length===1?picked[0].name:`${picked.length} קבצים מ-GCS`);
}

/* ── Folder access (admins only) ──────────────────────────── */
// Edits the managed folder's own IAM policy, so the page needs no server:
// Google checks that the signed-in user may change it. Only plain
// objectViewer bindings are touched — uploader grants, conditional
// bindings and every other role are passed back unchanged.
const GCS_VIEWER = 'roles/storage.objectViewer';
const GCS_ACCESS_LABEL = { chats:'💬 שיחות', metrics:'📊 מדדים' };
// Only chats access is managed here; metrics is open to the whole domain
// through a fixed grant, so new uploads are readable without anyone acting.
const GCS_MANAGED = ['chats'];
let gcsPolicies={};

const gcsFolderIam=which=>
  `${GCS_API}${encodeURIComponent(GCS_BUCKET)}/managedFolders/${encodeURIComponent(GCS_DIRS[which])}/iam`;

/* ── Session: sign-in gate, capabilities, auto-load ──────── */
// With a bucket configured the page opens on a sign-in screen, then shows
// only what this user's IAM allows and loads the data by itself. Hiding a
// button is convenience, not security: GCS refuses anything IAM doesn't
// grant regardless of what the page shows.
const GCS_SESSION_KEY = 'ge-gcs-session';
const gcsGated = ()=>!gcsConfigError();

function gcsSaveSession(){
  const t=gcsTok[GCS_SCOPE_RO];
  // Only the short-lived read-only token is kept; the admin token is
  // re-requested per page load. It expires with Google's token (~1h).
  try{ localStorage.setItem(GCS_SESSION_KEY, JSON.stringify({email:gcsUser.email, token:t.token, exp:t.exp})); }catch(_){}
}
function gcsRestoreSession(){
  try{
    const s=JSON.parse(localStorage.getItem(GCS_SESSION_KEY)||'null');
    if(s && s.token && s.email && Date.now()<s.exp-60000){
      gcsTok[GCS_SCOPE_RO]={token:s.token, exp:s.exp};
      gcsUser={email:s.email};
      return true;
    }
    localStorage.removeItem(GCS_SESSION_KEY);
  }catch(_){}
  return false;
}

function gcsGate(title, msg, btnLabel, onClick){
  $('gate-title').textContent=title||'';
  $('gate-msg').textContent=msg||'';
  const b=$('gate-btn'); b.textContent=btnLabel||''; b.onclick=onClick||null;
  $('gate').classList.add('on');
  document.body.classList.add('gated');
}
const gcsUngate=()=>{ $('gate').classList.remove('on'); document.body.classList.remove('gated'); };

// Which controls this user gets. One testPermissions call per folder,
// with the read-only token — nobody is asked for more access just to find
// out they don't have it. A folder that isn't set up yet reads as "none".
async function gcsLoadCaps(){
  const perms=['storage.managedFolders.setIamPolicy'];
  const has={};
  for(const which of Object.keys(GCS_DIRS)){
    try{
      const q=new URLSearchParams(); perms.forEach(p=>q.append('permissions',p));
      const j=await (await gcsFetch(`${gcsFolderIam(which)}/testPermissions?${q}`)).json();
      has[which]=new Set(j.permissions||[]);
    }catch(err){ console.warn(`testPermissions ${which}:`,err.message); has[which]=new Set(); }
  }
  // Read access is probed the way the auto-load uses it: list the folder,
  // then fetch one object's metadata. Listing alone isn't enough — the
  // legacy bucket-reader grant GCS gives project viewers can list but not
  // read, which would show a chats folder that then fails to load.
  const canRead=async which=>{
    try{
      const q=new URLSearchParams({prefix:GCS_DIRS[which], maxResults:'1', fields:'items(name)'});
      const j=await (await gcsFetch(`${GCS_API}${encodeURIComponent(GCS_BUCKET)}/o?${q}`)).json();
      const first=(j.items||[])[0];
      if(first) await gcsFetch(`${GCS_API}${encodeURIComponent(GCS_BUCKET)}/o/${encodeURIComponent(first.name)}?fields=name`);
      return true;
    }catch(err){ if(!/^403/.test(err.message)) console.warn(`read ${which}:`,err.message); return false; }
  };
  const can=(w,p)=>has[w].has(p);
  const mayEditIam=can('chats','storage.managedFolders.setIamPolicy');
  gcsCaps={
    readMetrics: await canRead('metrics'),
    readChats:   false,
    admin:       false,
    adminVerified: false,
  };
  if(mayEditIam){
    // Owners and Storage Admins can edit IAM too; the panel is only for
    // whoever holds the named role. If the policy can't be read yet (scope
    // or permission), the tab stays and gcsShowAccess settles it.
    try{
      gcsCaps.admin=await gcsHoldsAdminRole(GCS_SCOPE_RO);
      gcsCaps.adminVerified=true;
    }catch(err){ console.warn('admin role check:',err.message); gcsCaps.admin=true; }
  }
  // Chats need both: GCS lets them read, and they hold a named role — the
  // chats reader role, or a confirmed admin role. Owners and bucket-wide
  // readers pass the first but not the second, so the page doesn't show
  // them chats.
  let chatsRole=gcsCaps.admin && gcsCaps.adminVerified;
  if(!chatsRole){
    try{ chatsRole=await gcsHoldsRole(gcsFolderIam('chats'), GCS_CHATS_ROLE_ID, GCS_SCOPE_RO); }
    catch(err){ if(!/^403/.test(err.message)) console.warn('chats role check:',err.message); }
  }
  gcsCaps.readChats=chatsRole && await canRead('chats');
}

// The admin panel and chats follow explicit grants of these custom roles to
// the signed-in user — not raw permissions, which a project Owner has
// anyway. Admin is granted on the bucket, chats reader on the chats folder.
// Grant them to users directly; membership via a group isn't resolved.
// Matched by role id; the project id is learned from the admin's binding.
const GCS_ADMIN_ROLE_ID = 'GEStorageAdmin';
const GCS_CHATS_ROLE_ID = 'GEChatsReader';
let gcsProjectId='';

async function gcsHoldsRole(iamUrl, roleId, scope){
  const pol=await (await gcsFetch(`${iamUrl}?optionsRequestedPolicyVersion=3`,{scope})).json();
  const me='user:'+gcsUser.email;
  const b=(pol.bindings||[]).find(b=>!b.condition &&
    String(b.role).endsWith('/roles/'+roleId) &&
    (b.members||[]).some(m=>m.toLowerCase()===me));
  if(b){ const m=String(b.role).match(/^projects\/([^/]+)\/roles\//); if(m) gcsProjectId=m[1]; }
  return !!b;
}
const gcsHoldsAdminRole=scope=>
  gcsHoldsRole(`${GCS_API}${encodeURIComponent(GCS_BUCKET)}/iam`, GCS_ADMIN_ROLE_ID, scope);

// The role the panel grants: the chats reader role on chats, plain viewer
// elsewhere.
const gcsReaderRole=which=>
  which==='chats' ? `projects/${gcsProjectId}/roles/${GCS_CHATS_ROLE_ID}` : GCS_VIEWER;

function gcsApplyCaps(){
  const c=gcsCaps||{};
  $('btn-gcs').style.display=c.admin?'':'none';
  document.querySelector('#gcs-dirs [data-d="metrics"]').style.display=c.readMetrics?'':'none';
  document.querySelector('#gcs-dirs [data-d="chats"]').style.display=c.readChats?'':'none';
  $('gcs-admin-seg').style.display=c.admin?'':'none';
  $('gcs-user').innerHTML=gcsUser
    ? `<span dir="ltr">${esc(gcsUser.email)}</span>`+
      `<button class="btn" onclick="gcsLogout()" title="התנתק">התנתק</button>` : '';
}

async function gcsLogin(){
  gcsGate('מתחבר…','');
  try{
    const token=await gcsGetToken(GCS_SCOPE_RO);
    const r=await fetch('https://www.googleapis.com/oauth2/v3/userinfo',
      {headers:{Authorization:`Bearer ${token}`}});
    const info=r.ok?await r.json():{};
    if(!info.email) throw new Error('לא ניתן לזהות את החשבון.');
    gcsUser={email:String(info.email).toLowerCase()};
    gcsSaveSession();
    await gcsStart();
  }catch(err){
    gcsGate('התחברות','ההתחברות נכשלה: '+err.message,'נסה שוב',gcsLogin);
  }
}

function gcsLogout(){
  try{ localStorage.removeItem(GCS_SESSION_KEY); }catch(_){}
  const tokens=Object.values(gcsTok).map(t=>t.token);
  const done=()=>location.reload();
  if(window.google && google.accounts && google.accounts.oauth2 && tokens.length){
    let left=tokens.length;
    tokens.forEach(t=>google.accounts.oauth2.revoke(t,()=>{ if(--left===0) done(); }));
    setTimeout(done,1500);   // don't hang on a slow revoke
  } else done();
}

async function gcsStart(){
  gcsGate('טוען…','בודק הרשאות');
  await gcsLoadCaps();
  gcsApplyCaps();
  // Every opening brings the bucket up to date first; a failed sync still
  // loads what's there.
  try{ await logSync(); }
  catch(err){ console.warn('log sync:',err.message); gcsUpState('err','☁ עדכון הלוגים נכשל',err.message); }
  await gcsAutoLoad();
}

// Asks the sync function (sync-function/) to pull the logs written since the
// last sync into the bucket. It runs with its own service account; the
// user's read-only token only shows it who's asking.
async function logSync(){
  if(!syncConfigured()){ gcsUpState('err','☁ עדכון הלוגים לא הוגדר','ה-secret ‏SYNC_URL לא הוגדר ב-GitHub'); return; }
  gcsGate('מעדכן לוגים…','מושך את הלוגים החדשים מ-Cloud Logging');
  let r;
  try{
    r=await fetch(SYNC_URL,{method:'POST', headers:{Authorization:`Bearer ${await gcsGetToken(GCS_SCOPE_RO)}`}});
  }catch(_){ throw new Error('לא ניתן להגיע לפונקציית העדכון ('+SYNC_URL+')'); }
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`${r.status}`);
  gcsUpState('ok',`☁ ${j.entries} רשומות חדשות`,`${fmtTs(Date.parse(j.from),true)} – ${fmtTs(Date.parse(j.to),true)}`);
}

// Everything the user may read, metrics plus chats when allowed. The two
// halves merge back by insertId in finishLoad.
async function gcsAutoLoad(){
  const c=gcsCaps||{};
  if(!c.readMetrics && !c.readChats){
    gcsGate('אין הרשאה',
      `לחשבון ${gcsUser.email} אין הרשאה לצפות בנתונים.\nפנה למנהל המערכת.`,
      'התנתק',gcsLogout);
    return;
  }
  gcsGate('טוען נתונים…','');
  try{
    const objs=[];
    if(c.readMetrics) objs.push(...(await gcsListObjects(GCS_DIRS.metrics)).items);
    if(c.readChats)   objs.push(...(await gcsListObjects(GCS_DIRS.chats)).items);
    if(!objs.length){
      gcsGate('אין עדיין נתונים','עדיין לא נשמרו לוגים. הם יופיעו כאן אחרי העדכון הראשון מ-Cloud Logging.',
        'רענן',gcsAutoLoad);
      return;
    }
    gcsUngate();
    await gcsIngestObjects(objs, `${objs.length} קבצים מ-GCS`);
  }catch(err){
    gcsGate('הטעינה נכשלה',err.message,'נסה שוב',gcsAutoLoad);
  }
}

// After "נקה": a reload button.
function gcsAfterReset(){
  if(!gcsGated() || !gcsUser) return;
  gcsGate('הנתונים נוקו','','טען מחדש',gcsAutoLoad);
}

function gcsBoot(){
  // No bucket, or opened as file://: the report has nowhere to load from.
  if(!gcsGated()){ gcsGate('הדוח לא מוגדר',gcsConfigError()); return; }
  $('btn-gcs').style.display='none';
  gcsLoadGis().catch(()=>{});  // ready before the click, so the popup isn't blocked
  if(gcsRestoreSession()) gcsStart();
  else gcsGate('התחברות','כדי לצפות בנתונים יש להתחבר עם חשבון Google של הארגון.',
               'התחבר עם Google',gcsLogin);
}
// After the whole script has run, so every declaration below exists.
document.addEventListener('DOMContentLoaded', gcsBoot);

const gcsViewers=(pol,role)=>{
  const b=(pol.bindings||[]).find(x=>x.role===role && !x.condition);
  return b ? (b.members||[]).slice().sort() : [];
};

async function gcsShowAccess(){
  document.querySelectorAll('#gcs-dirs .seg').forEach(b=>b.classList.toggle('on',b.dataset.d==='access'));
  $('gcs-list').style.display='none'; $('gcs-foot').style.display='none';
  const panel=$('gcs-access'); panel.style.display='flex'; panel.innerHTML='';
  gcsStatus('טוען הרשאות…');
  try{
    if(!gcsCaps.adminVerified){
      let ok;
      try{ ok=await gcsHoldsAdminRole(GCS_SCOPE_FC); }
      catch(err){
        throw new Error(/^403/.test(err.message)
          ? `לא ניתן לאמת את תפקיד המנהל — לתפקיד ${GCS_ADMIN_ROLE_ID} חסרה ההרשאה storage.buckets.getIamPolicy.`
          : err.message);
      }
      gcsCaps.admin=ok; gcsCaps.adminVerified=true;
      if(!ok){
        gcsApplyCaps();
        throw new Error(`ניהול ההרשאות זמין רק למי שקיבל את התפקיד ${GCS_ADMIN_ROLE_ID}.`);
      }
    }
    if(!gcsProjectId) throw new Error('לא ניתן לזהות את הפרויקט מתוך תפקיד המנהל.');
    for(const which of GCS_MANAGED){
      gcsPolicies[which]=await (await gcsFetch(`${gcsFolderIam(which)}?optionsRequestedPolicyVersion=3`,
        {scope:GCS_SCOPE_FC})).json();
    }
    gcsStatus('');
    gcsRenderAccess();
  }catch(err){ gcsStatus(err.message,true); }
}

function gcsRenderAccess(){
  $('gcs-access').innerHTML=GCS_MANAGED.map(which=>{
    const members=gcsViewers(gcsPolicies[which]||{}, gcsReaderRole(which));
    const rows=members.length ? members.map(m=>{
      const id=m.replace(/^\w+:/,'');
      return `<div class="acc-row"><span class="acc-id" dir="ltr">${esc(id)}</span>`+
        `<button class="btn" onclick="gcsRevoke('${which}',${esc(JSON.stringify(m))})">הסר</button></div>`;
    }).join('') : `<div class="acc-empty">לאף אחד אין גישת קריאה.</div>`;
    return `<div class="acc-sec"><h4>${GCS_ACCESS_LABEL[which]} — מי יכול לקרוא</h4>`+
      `<div class="acc-list">${rows}</div>`+
      `<div class="gcs-row">`+
        // Users only: the page checks the signed-in user's own grant, so a
        // group grant would let GCS serve chats that the page won't show.
        `<input id="acc-email-${which}" dir="ltr" placeholder="name@domain.com" `+
          `onkeydown="if(event.key==='Enter')gcsGrant('${which}')"/>`+
        `<button class="btn btn-primary" onclick="gcsGrant('${which}')">הוסף</button>`+
      `</div></div>`;
  }).join('');
}

// Always re-reads the policy first so the write carries a fresh etag; a
// concurrent edit then fails cleanly instead of being overwritten.
async function gcsEditViewers(which, edit){
  const url=gcsFolderIam(which);
  const pol=await (await gcsFetch(`${url}?optionsRequestedPolicyVersion=3`,{scope:GCS_SCOPE_FC})).json();
  pol.bindings=pol.bindings||[];
  const role=gcsReaderRole(which);
  let b=pol.bindings.find(x=>x.role===role && !x.condition);
  if(!b){ b={role, members:[]}; pol.bindings.push(b); }
  b.members=edit(b.members||[]);
  pol.bindings=pol.bindings.filter(x=>(x.members||[]).length);
  try{
    gcsPolicies[which]=await (await gcsFetch(url,{method:'PUT', scope:GCS_SCOPE_FC,
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(pol)})).json();
  }catch(err){
    if(/^(409|412)/.test(err.message)) throw new Error('ההרשאות שונו במקביל — טען מחדש ונסה שוב.');
    throw err;
  }
}

async function gcsGrant(which){
  const email=$(`acc-email-${which}`).value.trim().toLowerCase();
  if(!new RegExp('^'+EMAIL_RE.source+'$').test(email)){ gcsStatus('כתובת מייל לא תקינה.',true); return; }
  const member=`user:${email}`;
  gcsStatus('שומר…');
  try{
    await gcsEditViewers(which, ms=>ms.includes(member)?ms:ms.concat(member));
    gcsRenderAccess();
    gcsStatus(`✓ ${email} נוסף ל${GCS_ACCESS_LABEL[which]}. השינוי נכנס לתוקף תוך כמה דקות.`);
  }catch(err){ gcsStatus(err.message,true); }
}

async function gcsRevoke(which, member){
  if(!confirm(`להסיר את ${member.replace(/^\w+:/,'')} מ${GCS_ACCESS_LABEL[which]}?`)) return;
  gcsStatus('שומר…');
  try{
    await gcsEditViewers(which, ms=>ms.filter(m=>m!==member));
    gcsRenderAccess();
    gcsStatus(`✓ הגישה הוסרה. השינוי נכנס לתוקף תוך כמה דקות.`);
  }catch(err){ gcsStatus(err.message,true); }
}

// Status chip in the header: how the log sync went.
function gcsUpState(kind, text, detail){
  const el=$('gcs-up');
  const color=kind==='err'?'var(--err)':kind==='ok'?'var(--ok)':'var(--muted)';
  el.innerHTML=`<span style="font-size:12px;color:${color};cursor:default" title="${esc(detail||'')}">${esc(text)}</span>`;
}

function ingestText(raw, fname){
  const text=raw.replace(/^﻿/,'').replace(/\r\n?/g,'\n').trim();
  if(!text) return;
  let added=0;

  // Both formats are reduced to the same nested entry shape, then read once.
  let entries=[];
  if(text[0]==='['||text[0]==='{'){
    const asJson=(()=>{ try{ return JSON.parse(text); }catch(_){ return null; } })();
    if(Array.isArray(asJson)) entries=asJson;
    else if(asJson && typeof asJson==='object') entries=[asJson];
    else entries=text.split('\n').map(l=>{try{return JSON.parse(l);}catch(_){return null;}}).filter(Boolean);
  } else {
    const rows=parseTable(text);
    if(rows.length<2) return;
    const hdrs=rows[0];
    // A Cloud Logging export always carries a timestamp and at least one
    // jsonPayload / resource / severity column. Anything else isn't ours.
    const flat=hdrs.map(h=>normHdr(h));
    const looksLikeLogging = flat.some(h=>h==='timestamp'||h==='insertid') &&
      flat.some(h=>h.startsWith('jsonpayload')||h.startsWith('resource')||h==='severity');
    if(!looksLikeLogging){
      parseWarnings.push(`${fname}: לא זוהו עמודות של Cloud Logging — הקובץ דולג.`);
      return;
    }
    for(let i=1;i<rows.length;i++){
      const e={};
      hdrs.forEach((h,c)=>{
        const v=stripExcel(rows[i][c]||'');
        if(v!=='') setPath(e,h,v);
      });
      entries.push(e);
    }
  }
  entries.forEach(o=>{
    const r=entryToRecord(o);
    if(looksRelevant(r)){ records.push(r); added++; }
  });
  if(added) fileNames.push(`${fname} (${added})`);
  else parseWarnings.push(`${fname}: לא נמצאו רשומות מתאימות.`);
}

function finishLoad(){
  // Drop exact duplicates — re-exports overlap constantly. The metrics and
  // chats halves of a split upload share insertIds, so fold the twin's
  // fields into the kept record instead of discarding its half.
  const seen=new Map();
  const blank=v=>v==null||v===''||v===0||v===false||(Array.isArray(v)&&!v.length);
  records=records.filter(r=>{
    const k=r.insertId || [r.kind,r.ts,r.convId,r.promptText,r.eventId].join('|');
    const prev=seen.get(k);
    if(!prev){ seen.set(k,r); return true; }
    for(const f in r){
      const a=prev[f], b=r[f];
      if(blank(b)) continue;
      // Longer string wins: a metrics row can surface a short verdict where
      // the chats row has the real answer text.
      if(blank(a) || (typeof a==='string' && typeof b==='string' && b.length>a.length)) prev[f]=b;
    }
    return false;
  });
  records.sort((a,b)=>a.ts-b.ts);
  collapseArmorDupes();
  linkArmorByText();      // must precede buildConversations — it sets blockedBy
  buildConversations();
  resolveAttribution();
  collapseReplayChains();   // after armor is attached, so it merges too
  buildUsers();
  $('controls').style.display='flex';
  $('kpi-row').style.display='grid';
  $('tabs').style.display='flex';
  setView(view);          // re-mounts the panel a prior reset unmounted
  hideLoader();
}

/* ═══ Conversation reconstruction ══════════════════════════ */

// gen_ai.input.messages is cumulative: every turn replays the whole
// thread so far. Concatenating rows would duplicate everything — the
// fullest snapshot per conversation is the one to keep.
function buildConversations(){
  const byConv={};
  records.filter(r=>r.kind==='inference').forEach(r=>{
    const id=r.convId || r.invocationId || r.insertId;
    if(!byConv[id]) byConv[id]={id, recs:[]};
    byConv[id].recs.push(r);
  });

  convs=Object.values(byConv).map(c=>{
    c.recs.sort((a,b)=>a.ts-b.ts);
    let best=c.recs[0];
    c.recs.forEach(r=>{
      const n=(r.inputMsgs||[]).length, bn=(best.inputMsgs||[]).length;
      if(n>bn || (n===bn && r.ts>best.ts)) best=r;
    });
    const last=c.recs[c.recs.length-1];
    const msgs=coalesce([...(best.inputMsgs||[]), ...(last.outputMsgs||[])]);
    const prompts=msgs.filter(m=>m.kind==='text'&&m.role==='user'&&!m.relay);
    const sources=[]; const seenSrc=new Set();
    msgs.forEach(m=>(m.sources||[]).forEach(s=>{
      const k=s.uri||s.title; if(k&&!seenSrc.has(k)){seenSrc.add(k);sources.push(s);}
    }));
    return {
      id: c.id,
      email: c.recs.find(r=>r.email)?.email || '',
      emailSrc: c.recs.find(r=>r.email) ? 'direct' : '',
      firstTs: c.recs[0].ts, lastTs: last.ts,
      agent: best.agentName||'', engineId: best.engineId||'',
      turns: prompts.length,
      tokens: c.recs.reduce((s,r)=>s+(r.inputTokens||0),0),
      errored: (last.finishReasons||[]).some(f=>/error/i.test(f)),
      msgs, prompts, sources,
      recCount: c.recs.length,
      product:'Gemini Enterprise',
      armor: [],           // ModelArmor hits joined to this conversation
    };
  });
  // NotebookLM threads live alongside conversations in every view.
  convs=convs.concat(notebookThreads()).sort((a,b)=>b.lastTs-a.lastTs);
}

// Assistant replies stream as many one-word message objects; merge those
// back into single bubbles. User messages stay discrete — two consecutive
// user texts are two real prompts (e.g. an original and its rewrite), not
// one split message.
function coalesce(messages){
  const out=[];
  (messages||[]).forEach((m,mi)=>{
    const role=m.role||'user';
    (m.parts||[]).forEach(p=>{
      const kind=p.type||'text';
      if(kind==='text'){
        const t=fixText(p.content||'');
        if(!t) return;
        const last=out[out.length-1];
        const merge = last && last.kind==='text' && last.role===role &&
                      (role==='assistant' || last._mi===mi);
        if(merge){ last.text+=t; last._mi=mi; }
        else out.push({kind:'text', role, text:t, _mi:mi, relay:role==='user'&&isRelay(t)});
      } else if(kind==='tool_call'){
        out.push({kind:'tool_call', role:'tool', _mi:mi,
          name:p.name||'tool', id:p.id||'',
          queries:(p.arguments&&p.arguments.queries)||[]});
      } else if(kind==='tool_call_response'){
        out.push({kind:'tool_resp', role:'tool', _mi:mi, id:p.id||'',
          sources: extractSources(p.response)});
      }
    });
  });
  return out;
}

// Retrieval hits carry the grounding sources — including NotebookLM
// Enterprise notebooks, which is the bridge to that dataset later.
function extractSources(resp){
  const out=[];
  const rr=(resp&&resp.retrieval_results)||[];
  (Array.isArray(rr)?rr:[]).forEach(r=>{
    out.push({
      title: fixText(r.title||'(ללא כותרת)'),
      uri: r.uri||'',
      notebook: /notebooklm/i.test(r.uri||'')||/notebooks?\//i.test(r.document_id||''),
    });
  });
  return out;
}

/* ═══ Attribution ══════════════════════════════════════════ */

const normText = s => String(s||'').replace(/\s+/g,' ').trim().toLowerCase();

/* Multi-agent orchestration relays sub-agent output back into the thread as
   role:"user" turns, so role alone does not mean "a person typed this".
   These carry unmistakable framework markers no human would type. Counting
   them as prompts inflated one real chat of ~6 questions to 204, and the
   whole export from ~31 genuine prompts to ~629. They stay visible in the
   transcript, collapsed and labelled, but never count as questions asked. */
const RELAY_RE = new RegExp(
  '<<<(?:BEGIN|END)_QUOTED_AGENT_CONTENT>>>' +
  '|below is a transcript of what another agent did' +
  '|^\\s*\\[[a-z0-9_.-]+\\]\\s+said:', 'i');
const isRelay = t => RELAY_RE.test(String(t||''));

/* Model Armor sanitizes the same prompt more than once — the sample shows
   two SANITIZE_USER_PROMPT entries 58 ms apart, identical text and verdict,
   different client_correlation_id. Counted naively every blocked prompt
   doubles. Collapse entries that share text + verdict within a few seconds,
   keeping the first and remembering how many fired.                       */
const ARMOR_DUPE_MS = 5000;
function collapseArmorDupes(){
  const kept=[], byKey={};
  records.forEach(r=>{
    if(r.kind!=='armor'){ kept.push(r); return; }
    // Key on whichever text this record actually carries: response rows put
    // theirs in responseText, so keying on promptText alone made every
    // ALLOW chunk of a streamed answer look like the same record and merged
    // genuinely different fragments together.
    const k=r.armorOp+'|'+normText(r.promptText||r.responseText)+'|'+r.verdict+'|'+r.filterMatch;
    const prev=byKey[k];
    if(prev && Math.abs(r.ts-prev.ts)<=ARMOR_DUPE_MS){
      prev.dupes=(prev.dupes||1)+1;
      if(r.correlationId) (prev.correlationIds=prev.correlationIds||[]).push(r.correlationId);
      return;
    }
    r.dupes=1;
    r.correlationIds=r.correlationId?[r.correlationId]:[];
    byKey[k]=r; kept.push(r);
  });
  records=kept;
}

/* Model Armor rows carry the verdict but no user. The product rows —
   NotebookLM's userQuery, or a Gemini prompt — carry the user and log the
   *identical* prompt string milliseconds apart. Text + time is a far
   stronger join than time proximity alone, so it runs first and separately:
   buildConversations() needs the blockedBy links it establishes.          */
let textMatchCount=0;
function linkArmorByText(){
  textMatchCount=0;
  const byText={};
  records.filter(r=>r.kind!=='armor' && r.email && r.promptText).forEach(c=>{
    const k=normText(c.promptText);
    (byText[k]=byText[k]||[]).push(c);
  });
  records.filter(r=>r.kind==='armor' && !r.email).forEach(a=>{
    const cands=byText[normText(a.promptText)];
    if(!cands||!cands.length) return;
    let best=null, gap=Infinity;
    cands.forEach(c=>{ const d=Math.abs(c.ts-a.ts); if(d<gap){gap=d;best=c;} });
    if(best && gap<=LINK_WINDOW_MS){
      a.email=best.email; a.emailSrc='text-match';
      a.notebookId=a.notebookId||best.notebookId;
      a.product=best.product;
      best.blockedBy=a;
      textMatchCount++;
    }
  });

  /* client_correlation_id ties one turn together: the SANITIZE_USER_PROMPT
     row and the SANITIZE_MODEL_RESPONSE rows for the same exchange share it.
     Once the prompt row knows its user (above), the response rows do too —
     an exact join, so blocked model output is attributed rather than
     stranded under "unattributed".                                        */
  const byCorr={};
  records.forEach(r=>{
    if(r.kind!=='armor' || !r.email || r.armorOp==='response') return;
    // Collapsing duplicates keeps one row but both correlation ids — index
    // every id it carries, or half the response rows find no owner.
    (r.correlationIds && r.correlationIds.length ? r.correlationIds : [r.correlationId])
      .filter(Boolean).forEach(id=>{ byCorr[id]=r; });
  });
  records.forEach(r=>{
    if(r.kind!=='armor' || r.email) return;
    const ids=(r.correlationIds&&r.correlationIds.length?r.correlationIds:[r.correlationId]).filter(Boolean);
    const src=ids.map(id=>byCorr[id]).find(Boolean);
    if(src){ r.email=src.email; r.emailSrc='correlation'; r.product=src.product; }
  });
}

function resolveAttribution(){
  linkedCount=0;
  // "Bad questions" means what a *user* asked. Model-response sanitizations
  // are excluded entirely — see entryToRecord's armorOp.
  flagged = records.filter(r=>r.kind==='armor' && r.armorOp!=='response'
                              && (r.matched||r.blocked));

  /* A blocked prompt belongs to a conversation only if that conversation
     actually contains it. Time proximity alone is not enough: when Model
     Armor blocks, the model is never invoked, so the chat the user typed it
     into may produce no conversation record at all. Attaching on proximity
     hid that chat behind an unrelated one and pinned the bad question to a
     thread that never held it.                                            */
  inferredTurns=0;
  records.filter(r=>r.kind==='armor' && r.armorOp!=='response'
                    && (r.matched||r.blocked)
                    && r.emailSrc!=='text-match').forEach(a=>{
    const needle=normText(a.promptText);
    if(!needle) return;
    const compatible = c => !c.blockedOnly &&
      (!c.engineId || !a.engineId || c.engineId===a.engineId) &&
      (!c.email || !a.email || c.email===a.email);

    /* Best case: a conversation already contains this exact prompt.

       The same text can appear in more than one chat — a person retypes a
       question, and cumulative replay repeats it. Identity is not exclusive:
       whoever typed it typed it in all of them, so the email propagates to
       every match. Only the armor record itself is exclusive, so that goes to
       the nearest in time. Taking just the first match here left a second,
       equally-matching chat stranded as unattributed.                      */
    const hosts=convs.filter(c=>compatible(c) && c.prompts.some(p=>normText(p.text)===needle));
    let host=null;
    if(hosts.length){
      let gap=Infinity;
      hosts.forEach(h=>{
        h.prompts.forEach(p=>{ if(normText(p.text)===needle) p.blocked=true; });
        if(!h.email && a.email){ h.email=a.email; h.emailSrc='text-match'; linkedCount++; }
        const d=Math.min(Math.abs(h.firstTs-a.ts), Math.abs(h.lastTs-a.ts));
        if(d<gap){ gap=d; host=h; }
      });
    } else {
      /* Otherwise fall back to time: a prompt blocked seconds after a
         conversation's last turn is almost always the next thing typed in
         that same chat — the model just never ran, so no turn was recorded.
         Attach it as a trailing turn, flagged as inferred so the join is
         visible rather than asserted. Only a prompt with no conversation
         anywhere near it becomes a chat of its own.                       */
      let gap=Infinity;
      convs.forEach(c=>{
        if(!compatible(c)) return;
        const d = a.ts < c.firstTs ? c.firstTs-a.ts
                : a.ts > c.lastTs  ? a.ts-c.lastTs : 0;
        if(d<=ATTACH_WINDOW_MS && d<gap){ gap=d; host=c; }
      });
      if(!host) return;                     // stays orphan — surfaced below
      const p={kind:'text', role:'user', text:a.promptText, ts:a.ts,
               blocked:true, inferred:true};
      host.msgs.push(p); host.prompts.push(p);
      host.turns++; host.lastTs=Math.max(host.lastTs,a.ts);
      inferredTurns++;
    }
    if(!host.armor.includes(a)) host.armor.push(a);
    if(!host.email && a.email){ host.email=a.email; host.emailSrc='linked'; linkedCount++; }
  });

  /* Whose chat this was, and which turn was blocked, are separate questions.
     Requiring a text match answers the second one; it must not also drop the
     first, or a conversation whose inference rows carry no email ends up
     stranded under "unattributed" even though a Model Armor row from the same
     session names the user. So: link identity on proximity (marked
     approximate), attach turns only on text.                              */
  convs.filter(c=>!c.email && !c.blockedOnly).forEach(c=>{
    let best=null, bestGap=Infinity;
    records.filter(r=>r.kind==='armor' && r.email).forEach(a=>{
      if(c.engineId && a.engineId && c.engineId!==a.engineId) return;
      const gap = a.ts < c.firstTs ? c.firstTs-a.ts
                : a.ts > c.lastTs  ? a.ts-c.lastTs : 0;
      if(gap<=LINK_WINDOW_MS && gap<bestGap){ bestGap=gap; best=a; }
    });
    if(best){ c.email=best.email; c.emailSrc='linked'; linkedCount++; }
  });

  convs=convs.concat(orphanBlockedThreads());
  convs.sort((a,b)=>b.lastTs-a.lastTs);
  tenantFallback();
  convs.forEach(c=>{ if(!c.email){ c.email=UNATTRIBUTED; c.emailSrc='none'; } });
}

/* Gemini Enterprise mints a NEW conversation.id (and a new invocation id)
   for each turn, while gen_ai.input.messages keeps replaying the whole
   history. One continuous chat therefore surfaces as a ladder of separate
   conversations — 1 turn, 2 turns, 3 turns … each containing everything
   before it. Six tabs for one session.

   Nothing in the log links them: conversation id, invocation id and trace are
   all distinct per turn. The only available signal is the prompt sequence
   itself, and a conversation whose prompts are an exact ordered prefix of
   another's is that same session logged earlier. Collapse into the longest.

   Where a shorter conversation is a prefix of two chats that later diverge,
   the parent is genuinely ambiguous, so it is left alone rather than guessed. */
let replayMerged=0;
function collapseReplayChains(){
  replayMerged=0;
  const sig=c=>c.prompts.map(p=>normText(p.text));
  const eligible=convs.filter(c=>!c.blockedOnly && !c.accessOnly && c.prompts.length);
  const sigs=new Map(eligible.map(c=>[c,sig(c)]));
  const sameSession=(a,b)=>a.email===b.email && a.product===b.product &&
                           (a.notebookId||'')===(b.notebookId||'');
  const isPrefix=(s,l)=>s.length<l.length && s.every((v,i)=>v===l[i]);

  const absorbed=new Set();
  // Longest first, so a whole ladder collapses into its maximal member.
  [...eligible].sort((a,b)=>sigs.get(b).length-sigs.get(a).length).forEach(host=>{
    if(absorbed.has(host)) return;
    const hs=sigs.get(host);
    eligible.forEach(c=>{
      if(c===host || absorbed.has(c) || !sameSession(c,host)) return;
      if(!isPrefix(sigs.get(c), hs)) return;
      // Ambiguous when another surviving chat of the same length also
      // contains it and the two differ — two real chats sharing an opening.
      const rivals=eligible.filter(o=>o!==host && !absorbed.has(o) &&
        sameSession(o,host) && sigs.get(o).length===hs.length &&
        isPrefix(sigs.get(c), sigs.get(o)) &&
        sigs.get(o).join(' ')!==hs.join(' '));
      if(rivals.length) return;

      host.firstTs=Math.min(host.firstTs,c.firstTs);
      host.lastTs =Math.max(host.lastTs, c.lastTs);
      host.recCount+=c.recCount;
      host.tokens+=c.tokens;
      c.armor.forEach(a=>{ if(!host.armor.includes(a)) host.armor.push(a); });
      c.sources.forEach(s=>{ if(!host.sources.some(x=>x.uri===s.uri)) host.sources.push(s); });
      // A turn blocked in the earlier copy is the same turn here.
      sigs.get(c).forEach((t,i)=>{
        if(c.prompts[i].blocked && host.prompts[i]) host.prompts[i].blocked=true; });
      host.mergedFrom=(host.mergedFrom||1)+1;
      absorbed.add(c);
      replayMerged++;
    });
  });
  convs=convs.filter(c=>!absorbed.has(c));
}

/* Last resort for conversations no join could reach — the inference log
   simply omits the principal, so a chat on a day with no Model Armor activity
   has nothing to match against.

   If the export names exactly one person on that engine, there is no one else
   the chat could belong to, so attribute it and mark the basis as "tenant".
   The moment a second principal appears on the engine this declines to guess
   and the chat stays unattributed — which is the honest answer, because the
   data genuinely cannot distinguish them.                                  */
let tenantCount=0;
function tenantFallback(){
  tenantCount=0;
  const byEngine={}, all=new Set();
  records.forEach(r=>{
    if(!r.email) return;
    all.add(r.email);
    const k=r.engineId||'*';
    (byEngine[k]=byEngine[k]||new Set()).add(r.email);
  });
  convs.forEach(c=>{
    if(c.email) return;
    const onEngine=byEngine[c.engineId||'*'];
    const pool=(onEngine && onEngine.size) ? onEngine : all;
    if(pool.size===1){ c.email=[...pool][0]; c.emailSrc='tenant'; tenantCount++; }
  });
}

/* A prompt Model Armor blocked before the model ran leaves no conversation
   behind — but the user still opened a chat and typed it. Give each such
   prompt its own thread so the chat is visible and the bad question is
   attached to something real instead of to a neighbouring conversation. */
let orphanCount=0, inferredTurns=0;
function orphanBlockedThreads(){
  const claimed=new Set();
  convs.forEach(c=>c.armor.forEach(a=>claimed.add(a)));
  // Model-response sanitizations are not chats — the user never typed them,
  // and their text lives in responseText, so they'd render as "(ללא טקסט)".
  // They are excluded from every user-facing count.
  const orphans=records.filter(r=>r.kind==='armor' && r.armorOp!=='response'
                                  && (r.matched||r.blocked)
                                  && r.emailSrc!=='text-match' && !claimed.has(r));
  orphanCount=orphans.length;
  return orphans.map(r=>{
    const p={kind:'text', role:'user', text:r.promptText, ts:r.ts, blocked:true};
    return {
      id:'blk:'+(r.insertId||r.ts), email:r.email||UNATTRIBUTED,
      emailSrc:r.email?'direct':'none', product:r.product||'Gemini Enterprise',
      firstTs:r.ts, lastTs:r.ts, turns:1, tokens:0, errored:false,
      agent:r.agentName||'', engineId:r.engineId||'', recCount:1,
      blockedOnly:true, msgs:[p], prompts:[p], sources:[], armor:[r],
    };
  });
}

/* ═══ NotebookLM ═══════════════════════════════════════════
   NotebookLM has no conversation id — the notebook is the thread, so each
   notebook becomes a tab in the chat view, mirroring the product's own UI. */
/* Opening a notebook is activity even when nobody types anything. NotebookLM
   logs those as their own methods with no userQuery, so filtering on prompt
   text alone made a notebook someone created and opened vanish entirely. */
const NB_ACTIONS = {
  CreateNotebook:  {label:'מחברת נוצרה',    icon:'✨'},
  GetNotebook:     {label:'מחברת נפתחה',    icon:'📂'},
  DeleteNotebook:  {label:'מחברת נמחקה',    icon:'🗑'},
  UpdateNotebook:  {label:'מחברת עודכנה',   icon:'✏️'},
  ListNotebooks:   {label:'רשימת מחברות',   icon:'📚'},
  CreateSource:    {label:'מקור נוסף',      icon:'📎'},
  UploadSource:    {label:'מקור הועלה',     icon:'📎'},
  DeleteSource:    {label:'מקור הוסר',      icon:'📎'},
};
const nbAction = m => NB_ACTIONS[m] || null;

function notebookThreads(){
  const byKey={};
  // Any NotebookLM record tied to a notebook counts, query or not.
  records.filter(r=>r.kind==='notebooklm' && (r.promptText || r.notebookId)).forEach(r=>{
    const key=(r.email||UNATTRIBUTED)+'|'+(r.notebookId||'(ללא מחברת)');
    if(!byKey[key]) byKey[key]={
      id:'nb:'+key, notebookId:r.notebookId||'', email:r.email||UNATTRIBUTED,
      emailSrc:r.email?'direct':'none', product:'NotebookLM',
      firstTs:r.ts, lastTs:r.ts, turns:0, tokens:0, errored:false,
      agent:r.method||'NotebookLM', engineId:'', recCount:0,
      msgs:[], prompts:[], sources:[], armor:[], actions:[],
    };
    const t=byKey[key];
    t.firstTs=Math.min(t.firstTs,r.ts); t.lastTs=Math.max(t.lastTs,r.ts);
    t.recCount++;

    if(!r.promptText){
      const act=nbAction(r.method);
      if(act){
        t.actions.push({method:r.method, ts:r.ts});
        t.msgs.push({kind:'action', ts:r.ts, label:act.label, icon:act.icon});
      }
      return;                       // no question was asked in this record
    }

    const p={kind:'text', role:'user', text:r.promptText, ts:r.ts, rec:r};
    t.msgs.push(p); t.prompts.push(p); t.turns++;
    // Model Armor logs every prompt it inspects, most with an ALLOW verdict.
    // Only an actual filter hit marks the turn — otherwise every benign
    // question in the notebook would show up as flagged.
    if(r.blockedBy && (r.blockedBy.matched || r.blockedBy.blocked)){
      t.armor.push(r.blockedBy);
      p.blocked=true;
    }
    if(r.answer) t.msgs.push({kind:'text', role:'assistant', text:r.answer, ts:r.ts});
  });
  return Object.values(byKey).map(t=>{
    t.msgs.sort((a,b)=>a.ts-b.ts);
    // A notebook that was opened or created but never asked anything.
    t.accessOnly = t.turns===0 && t.actions.length>0;
    return t;
  });
}

/* ═══ Users rollup ═════════════════════════════════════════ */
function buildUsers(){
  const map={};
  const touch=(email)=>{
    if(!map[email]) map[email]={
      email, prompts:0, blocked:0, flagged:0, convIds:new Set(),
      firstTs:Infinity, lastTs:0, tokens:0, agents:new Set(),
      errored:0, sources:0, linked:false,
    };
    return map[email];
  };
  convs.forEach(c=>{
    const u=touch(c.email);
    u.prompts += c.turns;
    u.convIds.add(c.id);
    u.firstTs = Math.min(u.firstTs, c.firstTs);
    u.lastTs  = Math.max(u.lastTs,  c.lastTs);
    u.tokens += c.tokens;
    u.sources += c.sources.length;
    if(c.agent) u.agents.add(c.agent);
    if(c.errored) u.errored++;
    if(c.emailSrc==='linked') u.linked=true;
  });
  flagged.forEach(r=>{
    const u=touch(r.email||UNATTRIBUTED);
    u.flagged++;
    // The prompt itself is counted via its thread (see promptEvents) — only
    // the block is tallied here.
    if(r.blocked) u.blocked++;
    u.firstTs=Math.min(u.firstTs,r.ts);
    u.lastTs =Math.max(u.lastTs, r.ts);
  });
  users=Object.values(map).map(u=>({...u, convs:u.convIds.size,
    firstTs: u.firstTs===Infinity?0:u.firstTs}))
    .sort((a,b)=>b.prompts-a.prompts || b.convs-a.convs);
}

/* ═══ Time window & bucketing ══════════════════════════════ */
function inWin(ts){
  if(customFrom!=null && ts<customFrom) return false;
  if(customTo  !=null && ts>customTo)   return false;
  return true;
}
function winConvs(){
  return convs.filter(c=>(inWin(c.lastTs)||inWin(c.firstTs)) && prodOn(c.product));
}
function winFlagged(){ return flagged.filter(r=>inWin(r.ts) && prodOn(r.product)); }
// Which products a user touched — drives the icons in the users table.
function productsOf(email){
  const out=new Set();
  convs.forEach(c=>{ if(c.email===email) out.add(c.product); });
  flagged.forEach(r=>{ if((r.email||UNATTRIBUTED)===email && r.product) out.add(r.product); });
  return [...out];
}

function renderProductFilter(){
  const wrap=$('prod-filter');
  const avail=availProducts();
  if(avail.length<2){ wrap.style.display='none'; return; }   // nothing to choose
  wrap.style.display='flex';
  const counts={};
  convs.forEach(c=>{ counts[c.product]=(counts[c.product]||0)+1; });
  wrap.innerHTML=avail.map(name=>{
    const p=prodOf(name), on=prodOn(name);
    return `<button class="prod-toggle ${on?'on':''}" onclick="toggleProduct('${esc(name)}')"
      title="${esc(name)}" style="${on?`color:${p.color};border-color:${p.color};background:${p.color}1f`:''}">
      ${prodIcon(name,13)}<span>${esc(p.short)}</span>
      <span class="prod-n">${counts[name]||0}</span>
    </button>`;
  }).join('');
}
function toggleProduct(name){
  const avail=availProducts();
  if(!visProducts) visProducts=new Set(avail);
  if(visProducts.has(name)){
    if(visProducts.size===1) return;      // never filter everything away
    visProducts.delete(name);
  } else visProducts.add(name);
  if(visProducts.size===avail.length) visProducts=null;
  chatUser=null; chatConv=null;
  renderProductFilter();
  renderAll();
}

function bucketKey(ms,g){
  const d=new Date(ms);
  const Y=d.getFullYear(), M=pad(d.getMonth()+1), D=pad(d.getDate());
  if(g==='minute') return `${Y}-${M}-${D} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if(g==='hour')   return `${Y}-${M}-${D} ${pad(d.getHours())}:00`;
  if(g==='day')    return `${Y}-${M}-${D}`;
  if(g==='week'){
    const t=new Date(d); t.setDate(t.getDate()-((t.getDay()+6)%7));
    return `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`;
  }
  return `${Y}-${M}`;
}
function bucketLabel(k,g){
  if(g==='minute'||g==='hour'){ const [d,t]=k.split(' '); const [,m,dd]=d.split('-'); return `${dd}/${m} ${t}`; }
  if(g==='day'||g==='week'){ const [,m,dd]=k.split('-'); return `${dd}/${m}`; }
  return k;
}

// Every user prompt as a flat event — the unit most charts count.
function promptEvents(){
  const out=[];
  winConvs().forEach(c=>{
    c.prompts.forEach((p,i)=>{
      // NotebookLM logs a timestamp per query. Gemini conversation turns
      // don't — only the conversation has one — so those get spread across
      // the span, keeping sub-hour buckets meaningful if approximate.
      const ts = p.ts ? p.ts
        : c.turns<2 ? c.firstTs
        : c.firstTs + Math.round((c.lastTs-c.firstTs)*(i/(c.turns-1)));
      out.push({ts, email:c.email, agent:c.agent||'(ללא)', conv:c.id,
                product:c.product||'Gemini Enterprise', text:p.text,
                flagged:!!p.blocked, approxTs:!p.ts});
    });
  });
  // Every blocked prompt is already a turn in some thread — matched into its
  // conversation, text-matched into its notebook, or given an orphan thread
  // of its own. Adding winFlagged() here again would double-count it.
  return out.sort((a,b)=>a.ts-b.ts);
}

/* ═══ Controls ═════════════════════════════════════════════ */
function setGran(g){
  gran=g;
  document.querySelectorAll('.seg').forEach(b=>b.classList.toggle('on',b.dataset.g===g));
  renderAll();
}
function toggleCustom(){
  const p=$('custom-panel');
  const open=p.style.display==='flex';
  p.style.display=open?'none':'flex';
  if(!open && !$('cf').value && records.length){
    const ts=records.map(r=>r.ts).filter(Boolean).sort((a,b)=>a-b);
    if(ts.length){ $('cf').value=toLocalInput(ts[0]); $('ct').value=toLocalInput(ts[ts.length-1]); }
  }
}
function toLocalInput(ms){
  const d=new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T`+
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function applyCustom(){
  const f=$('cf').value, t=$('ct').value;
  customFrom = f ? new Date(f).getTime() : null;
  customTo   = t ? new Date(t).getTime() : null;
  if(customFrom!=null && customTo!=null && customFrom>customTo){
    [customFrom,customTo]=[customTo,customFrom];
    $('cf').value=toLocalInput(customFrom); $('ct').value=toLocalInput(customTo);
  }
  renderAll();
}
function clearCustom(){
  customFrom=customTo=null; $('cf').value=''; $('ct').value=''; renderAll();
}
function setView(v){
  view=v;
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on',b.dataset.v===v));
  document.querySelectorAll('.view').forEach(el=>el.classList.toggle('on',el.id==='view-'+v));
  renderAll();
}
function resetAll(){
  records=[];convs=[];users=[];flagged=[];fileNames=[];parseWarnings=[];
  customFrom=customTo=null;
  linkedCount=0; textMatchCount=0; inferredTurns=0; orphanCount=0;
  visProducts=null; chatUser=null; chatConv=null; view='users'; gran='day';
  usersSort={col:'prompts',asc:false};

  Object.values(charts).forEach(c=>{try{c.destroy();}catch(_){}}); charts={};

  // The panels are hidden by the .on class, not by inline display — clearing
  // only the controls left every view still mounted and showing stale rows.
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.v==='users'));
  document.querySelectorAll('.seg').forEach(b=>b.classList.toggle('on',b.dataset.g==='day'));

  ['users-tbl','safety-list','chat-user-list',
   'conv-tabs','thread','kpi-row','safety-kpis','prod-filter','notice-slot']
    .forEach(id=>{ const el=$(id); if(el) el.innerHTML=''; });
  ['users-q','safety-q','chat-q','cf','ct'].forEach(id=>{ const el=$(id); if(el) el.value=''; });
  ['file-info','custom-info','users-sub','safety-sub','act-sub'].forEach(id=>{
    const el=$(id); if(el) el.textContent=''; });

  ['controls','kpi-row','tabs','custom-panel'].forEach(id=>{const el=$(id); if(el) el.style.display='none';});
  gcsAfterReset();
}

/* ═══ Charts ═══════════════════════════════════════════════ */
function css(v){ return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function chart(id,cfg){
  if(charts[id]){ try{charts[id].destroy();}catch(_){} }
  const el=$(id); if(!el) return;
  const grid=css('--border'), tick=css('--muted');
  cfg.options=cfg.options||{};
  cfg.options.responsive=true;
  cfg.options.maintainAspectRatio=false;
  cfg.options.plugins=Object.assign({datalabels:{display:false}}, cfg.options.plugins||{});
  if(cfg.options.plugins.legend===undefined)
    cfg.options.plugins.legend={labels:{color:tick,font:{size:11},boxWidth:12}};
  if(cfg.type!=='doughnut'&&cfg.type!=='pie'){
    cfg.options.scales=cfg.options.scales||{};
    ['x','y'].forEach(a=>{
      cfg.options.scales[a]=Object.assign({
        grid:{color:grid,drawBorder:false},
        ticks:{color:tick,font:{size:10},maxRotation:0,autoSkip:true,maxTicksLimit:a==='x'?12:6},
      }, cfg.options.scales[a]||{});
    });
    cfg.options.scales.y.beginAtZero=true;
  }
  charts[id]=new Chart(el,cfg);
}
function noData(id,msg){
  if(charts[id]){ try{charts[id].destroy();}catch(_){} delete charts[id]; }
  const el=$(id); if(!el) return;
  const ctx=el.getContext('2d');
  ctx.clearRect(0,0,el.width,el.height);
  ctx.fillStyle=css('--muted'); ctx.font='12px system-ui'; ctx.textAlign='center';
  ctx.fillText(msg||'אין נתונים', el.width/2, el.height/2);
}

/* ═══ Render ═══════════════════════════════════════════════ */
function renderAll(){
  renderNotice();
  renderProductFilter();
  renderKPIs();
  $('pill-users').textContent=users.length;
  $('pill-safety').textContent=winFlagged().length;
  $('pill-chat').textContent=winConvs().length;
  // Load failures are the one thing that still needs saying — inline, so a
  // rejected export can't look like an empty one.
  $('file-info').innerHTML=
    `${records.length.toLocaleString()} רשומות · ${convs.length} שיחות`+
    (parseWarnings.length
      ? ` &nbsp;<span class="src-badge" style="background:rgba(239,83,80,.14);`+
        `color:var(--err);border-color:rgba(239,83,80,.4)" title="${esc(parseWarnings.join('\n'))}">`+
        `⚠ ${parseWarnings.length} קבצים לא נטענו</span>`
      : '');
  $('custom-info').textContent = (customFrom!=null||customTo!=null)
    ? `מסונן: ${customFrom?fmtTs(customFrom,1):'…'} → ${customTo?fmtTs(customTo,1):'…'}` : '';

  if(view==='users')    { renderUsers(); renderUserCharts(); }
  if(view==='activity') renderActivity();
  if(view==='safety')   { renderSafetyKPIs(); renderSafetyCharts(); renderSafety(); }
  if(view==='chat')     { renderChatUsers(); renderThread(); }
}

/* The status banners that used to live here are gone by request. Nothing is
   hidden as a result: every approximate join is labelled where it appears —
   "שויך לפי זמן" on the bubble and in the users table, "נחסמה לפני הרצת
   המודל" on the tab. A caveat next to the data it qualifies beats a banner
   the reader dismisses once and never sees again. Only genuine load failures
   still surface, inline in the file-info line so a bad export can't fail
   silently. */
function renderNotice(){
  $('notice-slot').innerHTML='';
}

function kpi(label,val,sub,color){
  return `<div class="kpi"><div class="kpi-bar" style="background:${color}"></div>
    <div class="kpi-lbl">${label}</div>
    <div class="kpi-val" style="color:${color}">${val}</div>
    <div class="kpi-sub">${sub||''}</div></div>`;
}
function renderKPIs(){
  const cs=winConvs(), fl=winFlagged();
  const ev=promptEvents();
  const activeUsers=new Set(cs.map(c=>c.email).filter(e=>e!==UNATTRIBUTED));
  fl.forEach(r=>{ if(r.email) activeUsers.add(r.email); });
  const tokens=cs.reduce((s,c)=>s+c.tokens,0);
  const blocked=fl.filter(r=>r.blocked).length;
  const rate=ev.length?((blocked/ev.length)*100).toFixed(1):'0.0';
  $('kpi-row').innerHTML=[
    kpi('משתמשים פעילים', fmtNum(activeUsers.size), `${users.length} סה״כ בדוח`, css('--gem')),
    kpi('פרומפטים', fmtNum(ev.length), 'כולל נחסמים', css('--blue')),
    // Opened-but-never-asked notebooks are real activity, but they are not
    // conversations — call them out rather than folding them into the count.
    (()=>{ const opened=cs.filter(c=>c.accessOnly).length;
      return kpi('שיחות', fmtNum(cs.length-opened),
        opened?`+${fmtNum(opened)} מחברות שנפתחו ללא שאלה`
              :`${fmtNum(cs.reduce((s,c)=>s+c.recCount,0))} רשומות`,
        css('--purple')); })(),
    kpi('שאלות חריגות', fmtNum(fl.length), `${fmtNum(blocked)} נחסמו`, fl.length?css('--err'):css('--muted')),
    kpi('שיעור חסימה', rate+'%', 'מתוך כלל הפרומפטים', blocked?css('--warn'):css('--ok')),
    kpi('טוקני קלט', tokens?fmtNum(tokens):'—', 'לפי הדיווח בלוג', css('--ok')),
  ].join('');
}

/* ── Users view ───────────────────────────────────────────── */
let usersSort={col:'prompts',asc:false};
function sortUsers(col){
  usersSort = usersSort.col===col ? {col,asc:!usersSort.asc} : {col,asc:false};
  renderUsers();
}
function renderUsers(){
  const q=($('users-q').value||'').toLowerCase().trim();
  const winIds=new Set(winConvs().map(c=>c.id));
  const flByUser={}; winFlagged().forEach(r=>{
    const e=r.email||UNATTRIBUTED; flByUser[e]=(flByUser[e]||0)+1; });

  let rows=users.map(u=>{
    const cs=convs.filter(c=>c.email===u.email && winIds.has(c.id));
    const prompts=cs.reduce((s,c)=>s+c.turns,0)+(flByUser[u.email]||0);
    return {...u, wConvs:cs.length, wPrompts:prompts, wFlagged:flByUser[u.email]||0,
      wFirst: cs.length?Math.min(...cs.map(c=>c.firstTs)):u.firstTs,
      wLast:  cs.length?Math.max(...cs.map(c=>c.lastTs)):u.lastTs};
  }).filter(u=>u.wConvs||u.wFlagged);

  if(q) rows=rows.filter(u=>u.email.toLowerCase().includes(q));
  const key={user:'email',prompts:'wPrompts',convs:'wConvs',flagged:'wFlagged',
             first:'wFirst',last:'wLast',tokens:'tokens'}[usersSort.col]||'wPrompts';
  rows.sort((a,b)=>{
    const A=a[key],B=b[key];
    const r = typeof A==='string' ? String(A).localeCompare(String(B)) : (A-B);
    return usersSort.asc?r:-r;
  });

  const arrow=c=>usersSort.col===c?(usersSort.asc?' ↑':' ↓'):'';
  const th=(c,l)=>`<th onclick="sortUsers('${c}')">${l}${arrow(c)}</th>`;
  $('users-sub').textContent=`${rows.length} משתמשים`;
  $('users-tbl').innerHTML=
    `<thead><tr>${th('user','משתמש')}${th('prompts','פרומפטים')}${th('convs','שיחות')}`+
    `${th('flagged','חריגות')}<th>מוצרים</th>${th('first','ראשון')}${th('last','אחרון')}`+
    `</tr></thead><tbody>`+
    (rows.length?rows.map(u=>{
      const c=colorFor(u.email);
      const unk=u.email===UNATTRIBUTED;
      return `<tr class="row-click" onclick="gotoChat('${esc(u.email)}')">
        <td><div class="u-cell">
          <span class="avatar" style="background:${c}22;color:${c}">${unk?'?':initials(u.email)}</span>
          <span style="min-width:0"><span class="u-name">${esc(u.email.split('@')[0])}</span>
          <span class="u-mail">${esc(u.email)}</span></span></div></td>
        <td class="num">${fmtNum(u.wPrompts)}</td>
        <td class="num">${fmtNum(u.wConvs)}</td>
        <td class="num">${u.wFlagged?`<span class="tag tag-err">${u.wFlagged}</span>`:'<span style="color:var(--muted)">0</span>'}</td>
        <td><span class="u-prods">${productsOf(u.email).filter(prodOn).map(p=>{
          const d=prodOf(p);
          return `<span class="pi" title="${esc(p)}" style="color:${d.color};background:${d.color}1f">${prodIcon(p,13)}</span>`;
        }).join('')||'<span style="color:var(--muted)">—</span>'}</span></td>
        <td class="num" style="white-space:nowrap">${fmtTs(u.wFirst)}</td>
        <td class="num" style="white-space:nowrap">${fmtTs(u.wLast)}</td>
      </tr>`;
    }).join('')
    :`<tr><td colspan="7" class="empty">אין משתמשים בטווח שנבחר</td></tr>`)+
    `</tbody>`;
}

function renderUserCharts(){
  const winIds=new Set(winConvs().map(c=>c.id));
  const flByUser={}; winFlagged().forEach(r=>{
    const e=r.email||UNATTRIBUTED; flByUser[e]=(flByUser[e]||0)+1; });
  const rows=users.map(u=>({
    email:u.email,
    prompts:convs.filter(c=>c.email===u.email&&winIds.has(c.id)).reduce((s,c)=>s+c.turns,0),
    flag:flByUser[u.email]||0,
  })).filter(r=>r.prompts||r.flag);

  const top=[...rows].sort((a,b)=>b.prompts-a.prompts).slice(0,12);
  if(top.length) chart('c-user-prompts',{type:'bar',
    data:{labels:top.map(r=>r.email.split('@')[0]),
      datasets:[{label:'פרומפטים',data:top.map(r=>r.prompts),
        backgroundColor:top.map(r=>colorFor(r.email)+'cc'),borderRadius:5}]},
    options:{indexAxis:'y',plugins:{legend:{display:false}},
      scales:{y:{ticks:{autoSkip:false,font:{size:10}}}}}});
  else noData('c-user-prompts');

  const fl=[...rows].filter(r=>r.flag).sort((a,b)=>b.flag-a.flag).slice(0,12);
  if(fl.length) chart('c-user-flag',{type:'bar',
    data:{labels:fl.map(r=>r.email.split('@')[0]),
      datasets:[{label:'שאלות חריגות',data:fl.map(r=>r.flag),
        backgroundColor:'#EF5350cc',borderRadius:5}]},
    options:{indexAxis:'y',plugins:{legend:{display:false}},
      scales:{y:{ticks:{autoSkip:false,font:{size:10}}}}}});
  else noData('c-user-flag','אין שאלות חריגות 🎉');
}

/* ── Activity view ────────────────────────────────────────── */
const GRAN_HE={minute:'דקה',hour:'שעה',day:'יום',week:'שבוע',month:'חודש'};
function renderActivity(){
  const ev=promptEvents();
  $('act-title').textContent=`פעילות לפי ${GRAN_HE[gran]}`;
  $('act-sub').textContent = ev.length
    ? `${fmtNum(ev.length)} פרומפטים · ${fmtTs(ev[0].ts,1)} → ${fmtTs(ev[ev.length-1].ts,1)} · שעון מקומי`
    : 'אין נתונים בטווח';

  if(!ev.length){ ['c-timeline','c-hour','c-dow','c-uniq','c-product'].forEach(i=>noData(i)); return; }

  // timeline: prompts vs flagged
  const buckets={}, order=[];
  ev.forEach(e=>{
    const k=bucketKey(e.ts,gran);
    if(!buckets[k]){ buckets[k]={ok:0,flag:0,users:new Set()}; order.push(k); }
    buckets[k][e.flagged?'flag':'ok']++;
    if(e.email!==UNATTRIBUTED) buckets[k].users.add(e.email);
  });
  order.sort();
  const labels=order.map(k=>bucketLabel(k,gran));
  chart('c-timeline',{type:'bar',
    data:{labels,datasets:[
      {label:'פרומפטים',data:order.map(k=>buckets[k].ok),backgroundColor:'#8AB4F8cc',borderRadius:4,stack:'s'},
      {label:'חריגות',  data:order.map(k=>buckets[k].flag),backgroundColor:'#EF5350dd',borderRadius:4,stack:'s'},
    ]},
    options:{scales:{x:{stacked:true},y:{stacked:true}},
      plugins:{tooltip:{callbacks:{title:i=>order[i[0].dataIndex]}}}}});

  chart('c-uniq',{type:'line',
    data:{labels,datasets:[{label:'משתמשים ייחודיים',
      data:order.map(k=>buckets[k].users.size),borderColor:'#AB47BC',
      backgroundColor:'#AB47BC22',fill:true,tension:.32,pointRadius:2,borderWidth:2}]}});

  const hours=Array(24).fill(0);
  ev.forEach(e=>hours[new Date(e.ts).getHours()]++);
  chart('c-hour',{type:'bar',
    data:{labels:hours.map((_,i)=>pad(i)),
      datasets:[{label:'פרומפטים',data:hours,backgroundColor:'#4285F4cc',borderRadius:4}]},
    options:{plugins:{legend:{display:false}},scales:{x:{ticks:{maxTicksLimit:24}}}}});

  const DOW=['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const dow=Array(7).fill(0);
  ev.forEach(e=>dow[new Date(e.ts).getDay()]++);
  chart('c-dow',{type:'bar',
    data:{labels:DOW,datasets:[{label:'פרומפטים',data:dow,backgroundColor:'#00BFA5cc',borderRadius:4}]},
    options:{plugins:{legend:{display:false}}}});

  const byProd={};
  ev.forEach(e=>{ byProd[e.product]=(byProd[e.product]||0)+1; });
  const pr=Object.entries(byProd).sort((a,b)=>b[1]-a[1]);
  chart('c-product',{type:'doughnut',
    data:{labels:pr.map(p=>prodOf(p[0]).short),datasets:[{data:pr.map(p=>p[1]),
      backgroundColor:pr.map(p=>prodOf(p[0]).color),borderWidth:0}]},
    options:{cutout:'58%',plugins:{legend:{position:'bottom',
      labels:{color:css('--muted'),font:{size:11},boxWidth:11,padding:9}},
      tooltip:{callbacks:{title:i=>pr[i[0].dataIndex][0]}}}}});
}

/* ── Safety view ──────────────────────────────────────────── */
function renderSafetyKPIs(){
  const fl=winFlagged();
  const blocked=fl.filter(r=>r.blocked).length;
  const usersHit=new Set(fl.map(r=>r.email).filter(Boolean)).size;
  const real=hasSanMeta(fl);
  const keys=new Set(); fl.forEach(r=>verdictKeys(r).forEach(x=>keys.add(x)));
  $('safety-kpis').innerHTML=[
    kpi('שאלות שסומנו', fmtNum(fl.length), 'MATCH_FOUND', fl.length?css('--err'):css('--ok')),
    kpi('נחסמו', fmtNum(blocked), 'VERDICT_BLOCK', blocked?css('--err'):css('--ok')),
    kpi('משתמשים מעורבים', fmtNum(usersHit), 'עם לפחות סימון אחד', css('--warn')),
    kpi(real?'קטגוריות שנחסמו':'פסיקות ייחודיות', fmtNum(keys.size),
        real?'לפי filterResults':'נוסחי פסיקה שונים', css('--purple')),
  ].join('');
}
/* ModelArmor emits ONE prose verdict per prompt, e.g.

     "The prompt violated Responsible AI Safety settings
      (Hate Speech, Harassment, Dangerous), Prompt Injection
      and Jailbreak filters."

   That sentence enumerates the filter families the template has enabled —
   it is not a per-category truth table. Splitting it and counting each name
   as its own violation makes a single blocked prompt look like five, with
   every category sitting at 100%. The authoritative per-filter breakdown
   lives in sanitizationMetadata when the export carries it; when it doesn't,
   the only honest unit of count is the whole verdict.                    */

// Filters that actually matched, from sanitizationResult.filterResults.
// Parsed at ingest time into r.filters by matchedFilters().
function sanCategories(r){ return (r.filters||[]).map(f=>f.label); }

// Filter families *named* in the verdict sentence. Descriptive only — shown
// as tags next to a prompt, never summed as independent violations.
function filterFamilies(r){
  const t=r.verdictReason||'';
  const out=[];
  const paren=t.match(/\(([^)]+)\)/);
  if(paren) paren[1].split(/\s*,\s*/).forEach(x=>x.trim()&&out.push(x.trim()));
  [/Prompt Injection/i,/Jailbreak/i,/Sexually Explicit/i,/Malicious URI/i,/CSAM/i]
    .forEach(re=>{ const m=t.match(re); if(m&&!out.some(o=>re.test(o))) out.push(m[0]); });
  return [...new Set(out)];
}

// The grouping key for the reason chart: real categories when the log has
// them, otherwise the verdict sentence as a single indivisible outcome.
function verdictKeys(r){
  const cats=sanCategories(r);
  if(cats.length) return cats;
  const t=(r.verdictReason||'').trim();
  return [t || (r.verdict||'').replace(/^MODEL_ARMOR_SANITIZATION_VERDICT_/,'') || 'לא צוינה סיבה'];
}
// True when any flagged record carries a real per-filter breakdown.
function hasSanMeta(list){ return list.some(r=>sanCategories(r).length>0); }
function renderSafetyCharts(){
  const fl=winFlagged();
  if(!fl.length){ noData('c-flag-time','אין שאלות חריגות 🎉'); noData('c-flag-reason',''); return; }
  const b={}, order=[];
  fl.forEach(r=>{ const k=bucketKey(r.ts,gran); if(!b[k]){b[k]=0;order.push(k);} b[k]++; });
  order.sort();
  chart('c-flag-time',{type:'bar',
    data:{labels:order.map(k=>bucketLabel(k,gran)),
      datasets:[{label:'חריגות',data:order.map(k=>b[k]),backgroundColor:'#EF5350cc',borderRadius:4}]},
    options:{plugins:{legend:{display:false}}}});

  // One flagged prompt contributes exactly 1 — to a real category when the
  // log provides one, otherwise to its verdict sentence as a whole.
  const real=hasSanMeta(fl);
  const rc={};
  fl.forEach(r=>verdictKeys(r).forEach(x=>{ rc[x]=(rc[x]||0)+1; }));
  const rs=Object.entries(rc).sort((a,b)=>b[1]-a[1]).slice(0,10);
  const short=s=>s.length>52?s.slice(0,51)+'…':s;
  $('reason-note').textContent = real
    ? 'ספירה לפי המסננים שהופעלו בפועל (filterResults · MATCH_FOUND בלבד). '+
      'מסננים שנבדקו ולא הופעלו אינם נספרים.'
    : 'הייצוא לא כולל את filterResults, ולכן הספירה היא לפי נוסח הפסיקה המלא — '+
      'פרומפט חסום אחד נספר פעם אחת בלבד. שמות המסננים שבנוסח מוצגים כתגיות ברשימה למטה.';
  chart('c-flag-reason',{type:'bar',
    data:{labels:rs.map(r=>short(r[0])),datasets:[{label:'פרומפטים',data:rs.map(r=>r[1]),
      backgroundColor:rs.map((r,i)=>PALETTE[i%PALETTE.length]+'cc'),borderRadius:5}]},
    options:{indexAxis:'y',plugins:{legend:{display:false},
      tooltip:{callbacks:{title:i=>rs[i[0].dataIndex][0]}}},
      scales:{x:{ticks:{precision:0}},y:{ticks:{autoSkip:false,font:{size:10}}}}}});
}
function renderSafety(){
  const q=($('safety-q').value||'').toLowerCase().trim();
  let fl=winFlagged().slice().sort((a,b)=>b.ts-a.ts);
  if(q) fl=fl.filter(r=>(r.promptText||'').toLowerCase().includes(q)||
                        (r.email||'').toLowerCase().includes(q));
  $('safety-sub').textContent=`${fl.length} רשומות`;
  $('safety-list').innerHTML = fl.length ? fl.map(r=>{
    const c=colorFor(r.email||'?');
    return `<div style="padding:14px 16px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:9px">
        <span class="avatar" style="background:${c}22;color:${c}">${r.email?initials(r.email):'?'}</span>
        <b style="font-size:12.5px">${esc(r.email||UNATTRIBUTED)}</b>
        <span class="mono" style="color:var(--muted);font-size:11px">${fmtTs(r.ts,1)}</span>
        ${r.blocked?'<span class="tag tag-err">נחסם</span>':'<span class="tag tag-warn">סומן</span>'}
        ${prodBadge(r.product||'Gemini Enterprise',{short:true})}
        ${r.dupes>1?`<span class="tag tag-mute" title="Model Armor סינן את הפרומפט הזה ${r.dupes} פעמים">×${r.dupes}</span>`:''}
        ${(r.filters||[]).map(f=>`<span class="tag tag-err" title="${esc(f.family)}${f.conf?' · '+esc(f.conf):''}">${esc(f.label)}${
          f.conf?` <span style="opacity:.75;font-weight:400">${esc(String(f.conf).replace('_AND_ABOVE','+'))}</span>`:''}</span>`).join('')}
        ${(r.filters||[]).length?'':filterFamilies(r).map(x=>
          `<span class="tag tag-mute" title="מסנן שמוזכר בנוסח הפסיקה — לא בהכרח זה שהופעל">${esc(x)}</span>`).join('')}
      </div>
      <div class="flag-text">${esc(r.promptText||'(ללא טקסט)')}</div>
      ${r.verdictReason?`<div class="flag-reason">${esc(r.verdictReason)}</div>`:''}
    </div>`;
  }).join('') : '<div class="empty">אין שאלות חריגות בטווח שנבחר 🎉</div>';

}

/* ── Chat view ────────────────────────────────────────────── */
let chatUser=null, chatConv=null;
function gotoChat(email){ chatUser=email; chatConv=null; setView('chat'); }

function renderChatUsers(){
  const q=($('chat-q').value||'').toLowerCase().trim();
  const cs=winConvs();
  const map={};
  cs.forEach(c=>{
    if(!map[c.email]) map[c.email]={email:c.email,convs:0,turns:0,last:0,flag:0,prods:new Set()};
    map[c.email].convs++; map[c.email].turns+=c.turns;
    map[c.email].last=Math.max(map[c.email].last,c.lastTs);
    map[c.email].flag+=c.armor.filter(a=>a.matched||a.blocked).length;
    map[c.email].prods.add(c.product);
  });
  let list=Object.values(map).sort((a,b)=>b.last-a.last);
  if(q) list=list.filter(u=>u.email.toLowerCase().includes(q));
  if(!chatUser || !map[chatUser]) chatUser=list.length?list[0].email:null;

  $('chat-user-list').innerHTML = list.length ? list.map(u=>{
    const c=colorFor(u.email);
    return `<div class="cu-item ${u.email===chatUser?'on':''}" onclick="pickChatUser('${esc(u.email)}')">
      <div class="u-cell">
        <span class="avatar" style="background:${c}22;color:${c}">${u.email===UNATTRIBUTED?'?':initials(u.email)}</span>
        <span style="min-width:0;flex:1"><span class="u-name">${esc(u.email.split('@')[0])}</span>
        <div class="cu-meta">${u.convs} שיחות · ${u.turns} פרומפטים${u.flag?` · <span style="color:var(--err)">${u.flag} חריגות</span>`:''}</div></span>
        <span class="u-prods">${[...u.prods].map(p=>{
          const d=prodOf(p);
          return `<span class="pi" title="${esc(p)}" style="color:${d.color};background:${d.color}1f">${prodIcon(p,12)}</span>`;
        }).join('')}</span>
      </div></div>`;
  }).join('') : '<div class="empty" style="padding:24px">אין שיחות</div>';
}
function pickChatUser(e){ chatUser=e; chatConv=null; renderChatUsers(); renderThread(); }
function pickConv(id){ chatConv=id; renderThread(); }

function renderThread(){
  const cs=winConvs().filter(c=>c.email===chatUser).sort((a,b)=>b.lastTs-a.lastTs);
  if(!cs.length){
    $('conv-tabs').innerHTML='';
    $('thread').innerHTML='<div class="empty">בחר משתמש כדי לראות את היסטוריית השיחות</div>';
    return;
  }
  if(!chatConv || !cs.some(c=>c.id===chatConv)) chatConv=cs[0].id;

  // Number the real conversations 1..n oldest-first; blocked-only entries are
  // labelled, not numbered, so the sequence has no gaps.
  const numbered=cs.filter(c=>!c.blockedOnly && !c.accessOnly);
  $('conv-tabs').innerHTML=cs.map(c=>{
    const hit=c.armor.filter(a=>a.matched||a.blocked).length;
    const label = c.blockedOnly ? 'נחסמה'
      : c.accessOnly ? 'נפתחה בלבד'
      : `שיחה ${numbered.length-numbered.indexOf(c)}`;
    const p=prodOf(c.product);
    return `<button class="conv-tab ${c.id===chatConv?'on':''}" onclick="pickConv('${esc(c.id)}')"
      title="${esc(c.product)} · ${esc(c.id)}">${hit?'<span class="dot"></span>':''}
      <span style="color:${p.color};display:inline-flex">${prodIcon(c.product,13)}</span>${label}
      <span style="opacity:.7;font-weight:400">· ${fmtTs(c.lastTs)}</span></button>`;
  }).join('');

  const c=cs.find(x=>x.id===chatConv);
  const head=`<div style="display:flex;gap:16px;flex-wrap:wrap;padding-bottom:12px;
      border-bottom:1px solid var(--border);margin-bottom:6px;font-size:11px;color:var(--muted)">
    <span>${prodBadge(c.product)}</span>
    <span>🕘 ${fmtTs(c.firstTs,1)} → ${fmtTs(c.lastTs,1)}</span>
    <span>💬 ${c.turns} פרומפטים</span>
    <span>🤖 ${esc(c.agent||'—')}</span>
    ${c.tokens?`<span>🔢 ${fmtNum(c.tokens)} טוקנים</span>`:''}
    ${c.errored?'<span class="tag tag-err">הסתיים בשגיאה</span>':''}
    ${c.emailSrc==='linked'?'<span class="tag tag-warn">שיוך לפי קרבה בזמן</span>':''}
    ${c.emailSrc==='text-match'?'<span class="tag tag-ok" title="פרומפט בשיחה זהה מילה במילה לרשומת Model Armor שנושאת אימייל — שיוך ודאי">שיוך לפי התאמת טקסט</span>':''}
    ${c.emailSrc==='tenant'?'<span class="tag tag-warn" title="רשומות השיחה לא כוללות אימייל, ובייצוא הזה מופיע משתמש יחיד באותו engine — ולכן השיחה שויכה אליו">שיוך ברמת הארגון</span>':''}
    ${c.emailSrc==='none'?'<span class="tag tag-mute">ללא שיוך</span>':''}
    ${c.blockedOnly?'<span class="tag tag-err" title="Model Armor חסם את הפרומפט לפני שהמודל רץ, ולכן לא נוצרה רשומת שיחה">נחסמה לפני הרצת המודל</span>':''}
    ${c.accessOnly?'<span class="tag tag-info" title="המשתמש פתח או יצר את המחברת אך לא שאל בה דבר">ללא שאלות — גישה בלבד</span>':''}
    ${c.mergedFrom?`<span class="tag tag-info" title="Gemini Enterprise רושם מזהה שיחה חדש בכל תור וחוזר על כל ההיסטוריה. ${c.mergedFrom} רשומות שיחה זוהו כאותו שיח ואוחדו">אוחדו ${c.mergedFrom} רשומות שיחה</span>`:''}
    ${c.notebookId?`<span class="mono" style="opacity:.6">📓 ${esc(c.notebookId.slice(0,8))}</span>`:''}
    <span class="mono" style="opacity:.6">${esc(c.id)}</span>
  </div>`;

  const armorTexts=new Set(c.armor.map(a=>(a.promptText||'').trim()));
  const body=c.msgs.map(m=>{
    if(m.kind==='tool_call'){
      return `<div class="msg tool" style="align-self:center;max-width:96%">
        <div class="bub"><b>🔍 ${esc(m.name)}</b>
        ${m.queries.map(q=>`<span class="q-chip">${esc(q)}</span>`).join('')}</div></div>`;
    }
    if(m.kind==='tool_resp'){
      if(!m.sources.length) return '';
      return `<div class="msg tool" style="align-self:center;max-width:96%"><div class="bub">
        <b>📎 מקורות (${m.sources.length})</b><br>${m.sources.map(s=>
          `<span class="q-chip">${s.notebook?'📓 ':''}${esc(s.title)}</span>`).join('')}</div></div>`;
    }
    // Notebook lifecycle event — activity without a question.
    if(m.kind==='action'){
      return `<div class="msg tool" style="align-self:center;max-width:96%"><div class="bub"
        style="border-style:solid;border-color:var(--gem)55;color:var(--gem)">
        ${m.icon} ${esc(m.label)} · <span class="mono" style="opacity:.75">${fmtTs(m.ts,1)}</span>
      </div></div>`;
    }
    // Framework relay: shown so the transcript stays complete, but visually
    // demoted so it never reads as something the person asked.
    if(m.kind==='text' && m.relay){
      const n=m.text.length;
      return `<div class="msg tool" style="align-self:center;max-width:96%"><div class="bub"
        title="${esc(m.text.slice(0,300))}">🔁 תוכן שהועבר בין סוכנים · ${fmtNum(n)} תווים</div></div>`;
    }
    const isUser=m.role==='user';
    // Prefer the flag set when the thread was built (it knows the verdict);
    // fall back to text matching for conversation-style threads.
    const flag=isUser && (m.blocked || armorTexts.has((m.text||'').trim()));
    const pd=prodOf(c.product);
    return `<div class="msg ${isUser?'user':'assistant'}">
      <span class="msg-av" style="${isUser
        ? 'background:rgba(66,133,244,.2)'
        : `background:${pd.color}26;color:${pd.color}`}">${isUser?'👤':prodIcon(c.product,15)}</span>
      <div class="bub ${flag?'flagged':''}">
        <div class="bub-meta">${isUser?'משתמש':esc(pd.short)}${
          flag?' · <span style="color:var(--err)">סומן ע״י ModelArmor</span>':''}${
          m.inferred?' · <span style="color:var(--warn)" title="נחסם לפני שהמודל רץ, ולכן לא נרשם כתור בשיחה. שויך לשיחה זו לפי קרבה בזמן">שויך לפי זמן</span>':''}</div>
        ${esc(m.text)}
      </div></div>`;
  }).join('');

  const armorBlock = c.armor.length ? `<div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--border)">
    <div style="font-size:11px;color:var(--muted);margin-bottom:8px">
      🛡 רשומות ModelArmor שקושרו לשיחה זו (${c.armor.length})</div>
    ${c.armor.map(a=>`<div class="flag-text" style="margin-bottom:8px">
      <div style="font-size:10.5px;color:var(--muted);margin-bottom:5px">${fmtTs(a.ts,1)} · ${a.blocked?'נחסם':'סומן'}</div>
      ${esc(a.promptText||'(ללא טקסט)')}
      ${a.verdictReason?`<div class="flag-reason">${esc(a.verdictReason)}</div>`:''}
    </div>`).join('')}</div>` : '';

  $('thread').innerHTML=head+(body||'<div class="empty">אין הודעות בשיחה זו</div>')+armorBlock;
}

/* ═══ Export ═══════════════════════════════════════════════ */
function dlBlob(blob,name){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=name;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},800);
}
function toCSV(cols,rows){
  const q=v=>{const s=String(v==null?'':v);
    return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
  return '﻿'+[cols.map(q).join(','),...rows.map(r=>r.map(q).join(','))].join('\n');
}
function exportViewCSV(){
  if(!records.length){ alert('טרם נטענו נתונים.'); return; }
  const stamp=new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  let cols,rows,name;
  if(view==='safety'){
    cols=['תאריך','משתמש','סטטוס','קטגוריות שנחסמו','מסננים בנוסח','טקסט הפרומפט','נוסח הפסיקה'];
    rows=winFlagged().sort((a,b)=>b.ts-a.ts).map(r=>[
      fmtTs(r.ts,1), r.email||UNATTRIBUTED, r.blocked?'נחסם':'סומן',
      sanCategories(r).join(' | '), filterFamilies(r).join(' | '),
      r.promptText, r.verdictReason]);
    name=`gemini-flagged_${stamp}.csv`;
  } else if(view==='chat'){
    cols=['משתמש','שיחה','תאריך','תפקיד','טקסט'];
    rows=[];
    winConvs().forEach(c=>c.msgs.forEach(m=>{
      if(m.kind!=='text') return;
      rows.push([c.email,c.id,fmtTs(c.lastTs,1),m.role==='user'?'משתמש':'Gemini',m.text]);
    }));
    name=`gemini-chats_${stamp}.csv`;
  } else if(view==='activity'){
    cols=['תאריך','משתמש','Agent','חריג','טקסט'];
    rows=promptEvents().map(e=>[fmtTs(e.ts,1),e.email,e.agent,e.flagged?'כן':'לא',e.text]);
    name=`gemini-activity_${stamp}.csv`;
  } else {
    cols=['משתמש','פרומפטים','שיחות','חריגות','טוקנים','ראשון','אחרון','שיוך'];
    const winIds=new Set(winConvs().map(c=>c.id));
    const fb={}; winFlagged().forEach(r=>{const e=r.email||UNATTRIBUTED;fb[e]=(fb[e]||0)+1;});
    rows=users.map(u=>{
      const cs=convs.filter(c=>c.email===u.email&&winIds.has(c.id));
      return [u.email, cs.reduce((s,c)=>s+c.turns,0)+(fb[u.email]||0), cs.length,
        fb[u.email]||0, u.tokens, fmtTs(u.firstTs,1), fmtTs(u.lastTs,1),
        u.email===UNATTRIBUTED?'ללא שיוך':u.linked?'לפי זמן':'ישיר'];
    });
    name=`gemini-users_${stamp}.csv`;
  }
  dlBlob(new Blob([toCSV(cols,rows)],{type:'text/csv;charset=utf-8'}),name);
}

async function exportPNG(){
  const el=$('view-'+view);
  if(!records.length||!el){ alert('טרם נטענו נתונים.'); return; }
  const btn=document.querySelector('.btn-primary');
  const txt=btn.textContent; btn.textContent='⏳ מייצא…'; btn.disabled=true;
  try{
    const bg=css('--bg')||'#0f1117';
    const canvas=await html2canvas(el,{backgroundColor:bg,scale:2,useCORS:true,logging:false});
    const out=document.createElement('canvas');
    const PAD=26, HDR=56;
    out.width=canvas.width+PAD*2; out.height=canvas.height+HDR+PAD*2;
    const ctx=out.getContext('2d');
    ctx.fillStyle=bg; ctx.fillRect(0,0,out.width,out.height);
    ctx.fillStyle=css('--surface'); ctx.fillRect(0,0,out.width,HDR);
    ctx.fillStyle=css('--text'); ctx.font='bold 24px "Segoe UI",system-ui,sans-serif';
    ctx.fillText('Gemini Enterprise Usage Report',PAD,HDR*0.63);
    ctx.font='15px "Segoe UI",system-ui,sans-serif'; ctx.fillStyle=css('--muted');
    const sub=(customFrom||customTo)
      ? `${customFrom?fmtTs(customFrom,1):'…'}  →  ${customTo?fmtTs(customTo,1):'…'}`
      : `${GRAN_HE[gran]} · ${convs.length} conversations`;
    ctx.textAlign='right'; ctx.fillText(sub,out.width-PAD,HDR*0.63); ctx.textAlign='left';
    ctx.drawImage(canvas,PAD,HDR+PAD);
    dlBlob(await new Promise(r=>out.toBlob(r,'image/png')),
      `gemini-${view}_${new Date().toISOString().slice(0,10)}.png`);
  }catch(e){ alert('הייצוא נכשל: '+e.message); }
  finally{ btn.textContent=txt; btn.disabled=false; }
}
</script>
</body>
</html>
