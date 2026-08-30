<script>
if(typeof ChartDataLabels!=='undefined') Chart.register(ChartDataLabels);

/* ═══════════════════════════════════════════════════════════════
   Gemini Enterprise usage report — single-file, offline, no build.

   Input: Cloud Logging exports (CSV / TSV / JSON / NDJSON) of the
   Gemini Enterprise agent logs. Two record shapes matter:

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

function openHelp(){
  alert(
    'איך מוציאים את הנתונים:\n\n'+
    '1. Google Cloud Console → Logging → Logs Explorer\n'+
    '2. שאילתה, למשל:\n'+
    '   resource.type="discoveryengine.googleapis.com/Agent"\n'+
    '3. בוחרים טווח זמן ולוחצים Run query\n'+
    '4. Actions → Download → CSV או JSON\n\n'+
    'מומלץ JSON: ייצוא ל-CSV שנפתח ב-Excel פוגם בשדות ארוכים '+
    '(מספרי פרויקט הופכים לכתיב מדעי, וטקסט מקבל גרש מוביל).\n\n'+
    'אפשר להעלות כמה קבצים יחד — שיחות ממוזגות לפי conversation id.'
  );
}

/* ── Loader ───────────────────────────────────────────────── */
function showLoader(label){
  $('loader-name').textContent=label||'';
  $('loader-bar').style.width='0%';
  $('loader').style.display='flex';
}
function setProgress(p){ $('loader-bar').style.width=Math.max(0,Math.min(100,p))+'%'; }
function hideLoader(){ setProgress(100); setTimeout(()=>{ $('loader').style.display='none'; },260); }

/* ── Drag & drop ──────────────────────────────────────────── */
function dz(e,on){ e.preventDefault(); $('upload-zone').classList.toggle('drag',!!on); }
function dzDrop(e){ e.preventDefault(); $('upload-zone').classList.remove('drag'); handleFiles(e.dataTransfer.files); }

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
/* ── File ingestion ───────────────────────────────────────── */
function handleFiles(files){
  const list=Array.from(files||[]);
  if(!list.length) return;
  showLoader(list.length===1?list[0].name:`${list.length} קבצים`);
  let done=0;
  const step=()=>{ done++; setProgress(10+80*done/list.length);
    if(done===list.length){ finishLoad(); } };
  list.forEach(f=>{
    const r=new FileReader();
    r.onerror=step;
    r.onload=e=>{
      try{ ingestText(String(e.target.result||''), f.name); }
      catch(err){ parseWarnings.push(`${f.name}: ${err.message}`); }
      step();
    };
    r.readAsText(f,'utf-8');
  });
  $('file-input').value='';
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
  // Drop exact duplicates — re-exports overlap constantly.
  const seen=new Set();
  records=records.filter(r=>{
    const k=r.insertId || [r.kind,r.ts,r.convId,r.promptText,r.eventId].join('|');
    if(seen.has(k)) return false; seen.add(k); return true;
  });
  records.sort((a,b)=>a.ts-b.ts);
  collapseArmorDupes();
  linkArmorByText();      // must precede buildConversations — it sets blockedBy
  buildConversations();
  resolveAttribution();
  buildUsers();
  $('upload-zone').style.display='none';
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
    const prompts=msgs.filter(m=>m.kind==='text'&&m.role==='user');
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
        else out.push({kind:'text', role, text:t, _mi:mi});
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

    // Best case: the conversation already contains this exact prompt.
    let host=convs.find(c=>compatible(c) && c.prompts.some(p=>normText(p.text)===needle));
    if(host){
      host.prompts.forEach(p=>{ if(normText(p.text)===needle) p.blocked=true; });
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
  convs.forEach(c=>{ if(!c.email){ c.email=UNATTRIBUTED; c.emailSrc='none'; } });
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
function notebookThreads(){
  const byKey={};
  records.filter(r=>r.kind==='notebooklm' && r.promptText).forEach(r=>{
    const key=(r.email||UNATTRIBUTED)+'|'+(r.notebookId||'(ללא מחברת)');
    if(!byKey[key]) byKey[key]={
      id:'nb:'+key, notebookId:r.notebookId||'', email:r.email||UNATTRIBUTED,
      emailSrc:r.email?'direct':'none', product:'NotebookLM',
      firstTs:r.ts, lastTs:r.ts, turns:0, tokens:0, errored:false,
      agent:r.method||'NotebookLM', engineId:'', recCount:0,
      msgs:[], prompts:[], sources:[], armor:[],
    };
    const t=byKey[key];
    t.firstTs=Math.min(t.firstTs,r.ts); t.lastTs=Math.max(t.lastTs,r.ts);
    t.recCount++;
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

  $('upload-zone').style.display='';
  ['controls','kpi-row','tabs','custom-panel'].forEach(id=>{const el=$(id); if(el) el.style.display='none';});
  $('file-input').value='';
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
    kpi('שיחות', fmtNum(cs.length), `${fmtNum(cs.reduce((s,c)=>s+c.recCount,0))} רשומות`, css('--purple')),
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
    `<th>סטטוס</th></tr></thead><tbody>`+
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
        <td>${unk?'<span class="tag tag-mute">ללא שיוך</span>'
             :u.linked?'<span class="tag tag-warn">שויך לפי זמן</span>'
             :'<span class="tag tag-ok">מזוהה</span>'}</td>
      </tr>`;
    }).join('')
    :`<tr><td colspan="8" class="empty">אין משתמשים בטווח שנבחר</td></tr>`)+
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
  const numbered=cs.filter(c=>!c.blockedOnly);
  $('conv-tabs').innerHTML=cs.map(c=>{
    const hit=c.armor.filter(a=>a.matched||a.blocked).length;
    const label = c.blockedOnly ? 'נחסמה'
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
    ${c.emailSrc==='none'?'<span class="tag tag-mute">ללא שיוך</span>':''}
    ${c.blockedOnly?'<span class="tag tag-err" title="Model Armor חסם את הפרומפט לפני שהמודל רץ, ולכן לא נוצרה רשומת שיחה">נחסמה לפני הרצת המודל</span>':''}
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
