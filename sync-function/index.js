// Cloud Run function "sync": the report calls it (POST) every time anyone opens it, with the signed-in user's
// Google access token. The function checks that the token was issued to the report (CLIENT_ID) for a verified
// account of the organization (ALLOWED_DOMAIN), then runs the log sync (sync.js) with its own service account.
// One sync at a time: a request that arrives during one waits for it and gets its result.
//
// Settings (environment variables of the function):
//   LOG_PROJECT     the Google Cloud project the Gemini Enterprise logs are written to
//   BUCKET          the report's bucket (icl-database)
//   CLIENT_ID       the report's OAuth client ID (GCS_CLIENT_ID in src/app.js)
//   ALLOWED_DOMAIN  the organization's email domain; several: comma-separated
//   LOG_FILTER      optional; default DEFAULT_FILTER below
//
// The service account needs Logs Viewer (roles/logging.viewer) on LOG_PROJECT and Storage Object Creator plus
// Storage Object Viewer (to find the last marker) on the bucket. The function allows unauthenticated invocations:
// it checks the caller itself.
const functions = require('@google-cloud/functions-framework');
const { GoogleAuth } = require('google-auth-library');
const { sync } = require('./sync');

const { LOG_PROJECT, BUCKET, CLIENT_ID } = process.env;
const DOMAINS = String(process.env.ALLOWED_DOMAIN || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
// The Logs Explorer export query (Gemini Enterprise's gen_ai.* logs, NotebookLM Enterprise, Model Armor's checks),
// plus all of gemini_enterprise_user_activity: its StreamAssist rows (resource.type consumed_api, which the export
// query misses) are the only ones that name the user of a Gemini Enterprise chat.
const DEFAULT_FILTER =
  'resource.type="discoveryengine.googleapis.com/Agent"' +
  ' OR resource.labels.service="google.cloud.notebooklm.v1main.NotebookService"' +
  ' OR resource.type="modelarmor.googleapis.com/SanitizeOperation"' +
  ' OR log_id("discoveryengine.googleapis.com/gemini_enterprise_user_activity")';
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
  res.set('Access-Control-Allow-Headers', 'Authorization');
  res.set('Access-Control-Allow-Methods', 'POST');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (!LOG_PROJECT || !BUCKET || !CLIENT_ID || !DOMAINS.length) {
    return res.status(500).json({ error: 'The function is missing LOG_PROJECT, BUCKET, CLIENT_ID or ALLOWED_DOMAIN.' });
  }
  const caller = await callerOf(req).catch(() => null);
  if (!caller) return res.status(401).json({ error: 'Sign in with your organization\'s Google account.' });
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

// The entry point "sync", both ways the runtime looks for it.
functions.http('sync', handleSync);
exports.sync = handleSync;
