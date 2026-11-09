// Cloud Run function "sync": the report calls it (POST) every time anyone opens it, with the signed-in user's
// Google access token. The function checks that the token was issued to the report (CLIENT_ID) for a verified
// account of the organization (ALLOWED_DOMAIN), then runs the log sync (sync.js) with its own service account.
// One sync at a time: a request that arrives during one waits for it and gets its result.
// A POST with the JSON body {action: "access", viewed, reason} instead records that the caller opened `viewed`'s
// chats and why (sync.js recordAccess); the report shows someone else's chats only once this has succeeded.
//
// Settings (environment variables of the function):
//   LOG_PROJECT     the Google Cloud project the Gemini Enterprise logs are written to
//   BUCKET          the report's bucket
//   CLIENT_ID       the report's OAuth client ID (GCS_CLIENT_ID in src/app.js)
//   ALLOWED_DOMAIN  the organization's email domain; several: comma-separated
//   GE_APP          optional; one Gemini Enterprise app's engine id, to leave the project's other apps out
//   LOG_FILTER      optional; replaces DEFAULT_FILTER below (GE_APP then has no effect)
//
// The service account needs Logs Viewer (roles/logging.viewer) on LOG_PROJECT and Storage Object Creator plus
// Storage Object Viewer (to find the last marker) on the bucket. The function allows unauthenticated invocations:
// it checks the caller itself.
const functions = require('@google-cloud/functions-framework');
const { GoogleAuth } = require('google-auth-library');
const { sync, recordAccess } = require('./sync');

const { LOG_PROJECT, BUCKET, CLIENT_ID } = process.env;
const DOMAINS = String(process.env.ALLOWED_DOMAIN || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
// Gemini Enterprise: the gen_ai.* logs and gemini_enterprise_user_activity (its StreamAssist rows, resource.type
// consumed_api, are the only ones that name a chat's user). NotebookLM Enterprise. Model Armor's checks of both.
// With GE_APP set, Gemini Enterprise of that one app only: its engine id must appear somewhere in the entry. A Model
// Armor check names its app the same way (client_correlation_id "AS|…/engines/<app>/…"), NotebookLM's start "NLM|".
// In the Logging query language AND binds looser than OR, hence the parentheses.
const GE_APP = String(process.env.GE_APP || '').trim().replace(/"/g, '');
const GEMINI = 'resource.type="discoveryengine.googleapis.com/Agent"' +
  ' OR log_id("discoveryengine.googleapis.com/gemini_enterprise_user_activity")';
const NOTEBOOKLM = 'resource.labels.service="google.cloud.notebooklm.v1main.NotebookService"';
const ARMOR = 'resource.type="modelarmor.googleapis.com/SanitizeOperation"';
const NLM_CHECK = 'labels."modelarmor.googleapis.com/client_correlation_id"=~"^NLM\\|"';
const DEFAULT_FILTER = GE_APP
  ? `((${GEMINI}) AND "${GE_APP}") OR ${NOTEBOOKLM} OR (${ARMOR} AND ("${GE_APP}" OR ${NLM_CHECK}))`
  : `(${GEMINI}) OR ${NOTEBOOKLM} OR ${ARMOR}`;
const LOG_FILTER = process.env.LOG_FILTER || DEFAULT_FILTER;

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/logging.read', 'https://www.googleapis.com/auth/devstorage.read_write'],
});
let running = null;

// The caller's email, or null: an access token issued to the report, for a verified account of the organization.
async function callerOf(req) {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`);
  if (!r.ok) return null;
  const info = await r.json();
  if (info.aud !== CLIENT_ID && info.azp !== CLIENT_ID) return null;
  if (String(info.email_verified) !== 'true') return null;
  const email = String(info.email || '').toLowerCase();
  return DOMAINS.some(d => email.endsWith('@' + d)) ? email : null;
}

async function handleSync(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!LOG_PROJECT || !BUCKET || !CLIENT_ID || !DOMAINS.length) {
    return res.status(500).json({ error: 'The function is missing LOG_PROJECT, BUCKET, CLIENT_ID or ALLOWED_DOMAIN.' });
  }
  const caller = await callerOf(req).catch(() => null);
  if (!caller) return res.status(401).json({ error: 'Sign in with your organization\'s Google account.' });
  if (req.body?.action === 'access') return handleAccess(req, res, caller);
  try {
    running ??= (async () => {
      const client = await auth.getClient();
      return sync({ request: options => client.request(options), project: LOG_PROJECT, bucket: BUCKET, filter: LOG_FILTER });
    })().finally(() => { running = null; });
    const result = await running;
    console.log(`Sync for ${caller}: ${result.entries} entries, ${result.from} – ${result.to}`);
    return res.json(result);
  } catch (error) {
    const message = error.response?.data?.error?.message || error.message;
    console.error(`Sync for ${caller} failed:`, message);
    return res.status(502).json({ error: message });
  }
}

// Record that `caller` opened someone else's chats, with the reason they gave.
async function handleAccess(req, res, caller) {
  const viewed = String(req.body.viewed || '').trim();
  const reason = String(req.body.reason || '').trim();
  if (!viewed || viewed.length > 320) return res.status(400).json({ error: 'Whose chats is missing.' });
  if (!reason) return res.status(400).json({ error: 'A reason is required.' });
  if (reason.length > 2000) return res.status(400).json({ error: 'The reason is too long (2000 characters at most).' });
  try {
    const client = await auth.getClient();
    const entry = await recordAccess({ request: options => client.request(options), bucket: BUCKET, viewer: caller, viewed, reason });
    console.log(`Access: ${caller} opened the chats of ${viewed} (${entry.name})`);
    return res.json({ recorded: entry.name });
  } catch (error) {
    const message = error.response?.data?.error?.message || error.message;
    console.error(`Access record for ${caller} failed:`, message);
    return res.status(502).json({ error: message });
  }
}

// The entry point "sync", both ways the runtime looks for it.
functions.http('sync', handleSync);
exports.sync = handleSync;
