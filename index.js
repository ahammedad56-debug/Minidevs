'use strict';
/*
 * MiniDevs - single-file Express app
 *
 * npm install express multer axios form-data stripe @supabase/supabase-js
 *
 * ENV (Replit Secrets / Glitch .env):
 *   ROBLOX_API_KEY, CREATOR_ID, CREATOR_TYPE (optional: "user" | "group", default "user")
 *   STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (server-only; used by webhook)
 *   APP_URL (optional, e.g. https://your-app.repl.co)
 *
 * SUPABASE SQL (run once in the SQL editor):
 *   create table profiles (id uuid primary key references auth.users on delete cascade,
 *     is_premium boolean not null default false, stripe_customer_id text);
 *   alter table profiles enable row level security;
 *   create policy "read own profile" on profiles for select using (auth.uid() = id);
 *   create table uploads (id bigint generated always as identity primary key,
 *     user_id uuid not null references auth.users on delete cascade,
 *     asset_name text, asset_id text, created_at timestamptz not null default now());
 *   create index on uploads (user_id, created_at);
 *   alter table uploads enable row level security;
 *   create policy "read own uploads" on uploads for select using (auth.uid() = user_id);
 *   create policy "insert own uploads" on uploads for insert with check (auth.uid() = user_id);
 *
 * Stripe webhook endpoint: https://YOUR_URL/webhook
 *   events: checkout.session.completed, customer.subscription.deleted
 */

const path = require('path');
let express, multer, axios, FormData, Stripe, createClient;
try {
  express = require('express');
  multer = require('multer');
  axios = require('axios');
  FormData = require('form-data');
  Stripe = require('stripe');
  ({ createClient } = require('@supabase/supabase-js'));
} catch (e) {
  console.error('[FATAL] A required npm package is missing: ' + e.message);
  console.error('Fix: list express, multer, axios, form-data, stripe and @supabase/supabase-js under');
  console.error('"dependencies" in package.json and set the Render Build Command to: npm install');
  process.exit(1);
}

const {
  PORT = 3000, ROBLOX_API_KEY, CREATOR_ID, CREATOR_TYPE = 'user',
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, APP_URL,
} = process.env;

const FREE_DAILY_LIMIT = 3;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ASSETS_URL = 'https://apis.roblox.com/assets/v1/assets';
const OPS_URL = 'https://apis.roblox.com/assets/v1/operations/';

const log = (lvl, msg, extra) =>
  console.log('[' + new Date().toISOString() + '] [' + lvl + '] ' + msg + (extra ? ' ' + extra : ''));

// ---- Environment check: prints a clear report instead of failing silently ----
const REQUIRED_ENV = {
  SUPABASE_URL: 'Supabase project URL, like https://xxxx.supabase.co',
  SUPABASE_ANON_KEY: 'Supabase anon public key',
  SUPABASE_SERVICE_ROLE_KEY: 'Supabase service_role key (used by /webhook)',
  ROBLOX_API_KEY: 'Roblox Open Cloud API key',
  CREATOR_ID: 'Roblox user/group ID that owns uploads',
  STRIPE_SECRET_KEY: 'Stripe secret key',
  STRIPE_WEBHOOK_SECRET: 'Stripe webhook signing secret',
};
const missingEnv = Object.keys(REQUIRED_ENV).filter((k) => !String(process.env[k] || '').trim());
if (missingEnv.length) {
  console.error('================ MISSING ENVIRONMENT VARIABLES ================');
  missingEnv.forEach((k) => console.error('  [MISSING] ' + k + ' -> ' + REQUIRED_ENV[k]));
  console.error('Add them in Render: your service > Environment, then redeploy.');
  console.error('================================================================');
} else {
  log('INFO', 'All required environment variables are set.');
}

// ---- Database initialization (guarded) ----
const noSession = { persistSession: false, autoRefreshToken: false };
let anon = null;
let admin = null;
let stripe = null;
let dbReady = false;
let userClient = () => { throw new Error('Database is not initialized.'); };

try {
  const sbUrl = String(SUPABASE_URL || '').trim();
  const sbAnon = String(SUPABASE_ANON_KEY || '').trim();
  const sbService = String(SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!sbUrl || !sbAnon) throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must both be set.');
  new URL(sbUrl); // throws if the URL is malformed
  anon = createClient(sbUrl, sbAnon, { auth: noSession });
  admin = sbService ? createClient(sbUrl, sbService, { auth: noSession }) : null;
  userClient = (token) => createClient(sbUrl, sbAnon, {
    auth: noSession, global: { headers: { Authorization: 'Bearer ' + token } },
  });
  dbReady = true;
  log('INFO', 'Supabase client initialized.' + (admin ? '' : ' (no service role key: webhook disabled)'));
} catch (e) {
  console.error('[FATAL] Database initialization failed: ' + e.message);
  console.error('Check SUPABASE_URL (https://xxxx.supabase.co) and SUPABASE_ANON_KEY, then redeploy.');
  console.error('The server will stay up so you can read this log, but login/upload will return 503.');
}

try {
  if (STRIPE_SECRET_KEY && STRIPE_SECRET_KEY.trim()) stripe = new Stripe(STRIPE_SECRET_KEY.trim());
  else console.error('[WARN] STRIPE_SECRET_KEY missing: checkout and webhook are disabled.');
} catch (e) {
  console.error('[ERROR] Stripe initialization failed: ' + e.message);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === '.fbx' || ext === '.obj') return cb(null, true);
    cb(new Error('Only .fbx or .obj files are allowed.'));
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startOfUtcDay = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

async function isPremium(db, userId) {
  const { data, error } = await db.from('profiles').select('is_premium').eq('id', userId).maybeSingle();
  if (error) throw new Error('Profile lookup failed: ' + error.message);
  return !!(data && data.is_premium);
}

async function uploadsToday(db, userId) {
  const { count, error } = await db.from('uploads').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).gte('created_at', startOfUtcDay());
  if (error) throw new Error('Usage lookup failed: ' + error.message);
  return count || 0;
}

async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Please log in.' });
    const { data, error } = await anon.auth.getUser(token);
    if (error || !data || !data.user) return res.status(401).json({ error: 'Session expired. Log in again.' });
    req.user = data.user;
    req.db = userClient(token);
    next();
  } catch (e) {
    log('ERROR', 'Auth middleware', e.message);
    res.status(500).json({ error: 'Authentication error.' });
  }
}

async function uploadToRoblox(file, displayName) {
  const ext = path.extname(file.originalname).toLowerCase();
  const creator = CREATOR_TYPE === 'group'
    ? { groupId: String(CREATOR_ID) } : { userId: String(CREATOR_ID) };
  const meta = {
    assetType: 'Model', displayName,
    description: 'Uploaded via MiniDevs',
    creationContext: { creator },
  };
  const form = new FormData();
  form.append('request', JSON.stringify(meta), { contentType: 'application/json' });
  form.append('fileContent', file.buffer, {
    filename: file.originalname, contentType: ext === '.fbx' ? 'model/fbx' : 'model/obj',
  });
  const { data: op } = await axios.post(ASSETS_URL, form, {
    headers: Object.assign({ 'x-api-key': ROBLOX_API_KEY }, form.getHeaders()),
    maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 60000,
  });
  const opId = op.operationId || String(op.path || '').split('/').pop();
  if (!opId) throw new Error('Roblox did not return an operation id.');
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    const { data } = await axios.get(OPS_URL + opId, { headers: { 'x-api-key': ROBLOX_API_KEY }, timeout: 20000 });
    if (data.done) {
      if (data.error) throw new Error('Roblox rejected the asset: ' + (data.error.message || 'unknown error'));
      return (data.response && data.response.assetId) || null;
    }
  }
  return null; // still processing on Roblox's side
}

const app = express();
app.set('trust proxy', 1);

// Stripe webhook needs the raw body, so it is registered before express.json().
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    log('ERROR', 'Webhook hit but Stripe is not configured.');
    return res.status(503).send('Stripe not configured');
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    log('WARN', 'Webhook signature failed', e.message);
    return res.status(400).send('Webhook Error');
  }
  try {
    if (!admin) throw new Error('Service role key not configured.');
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const userId = s.client_reference_id || (s.metadata && s.metadata.userId);
      if (userId) {
        const { error } = await admin.from('profiles')
          .upsert({ id: userId, is_premium: true, stripe_customer_id: s.customer || null });
        if (error) throw new Error(error.message);
        log('INFO', 'Upgraded to Premium', userId);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const { error } = await admin.from('profiles').update({ is_premium: false })
        .eq('stripe_customer_id', event.data.object.customer);
      if (error) throw new Error(error.message);
      log('INFO', 'Subscription ended', String(event.data.object.customer));
    }
    res.json({ received: true });
  } catch (e) {
    log('ERROR', 'Webhook handler', e.message);
    res.status(500).send('Webhook handler failed');
  }
});

app.use(express.json({ limit: '100kb' }));

app.use(['/auth', '/status', '/upload', '/create-checkout-session'], (req, res, next) => {
  if (dbReady) return next();
  res.status(503).json({ error: 'Server database is not configured. Check the server logs.' });
});

app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 6)
      return res.status(400).json({ error: 'Valid email and a 6+ character password are required.' });
    const { data, error } = await anon.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    if (data.user) await (admin || userClient(data.session ? data.session.access_token : ''))
      .from('profiles').upsert({ id: data.user.id }, { ignoreDuplicates: true });
    res.json({
      token: data.session ? data.session.access_token : null,
      message: data.session ? 'Welcome!' : 'Check your email to confirm your account, then log in.',
    });
  } catch (e) {
    log('ERROR', 'Signup', e.message);
    res.status(500).json({ error: 'Sign up failed.' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    res.json({ token: data.session.access_token });
  } catch (e) {
    log('ERROR', 'Login', e.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.get('/status', requireAuth, async (req, res) => {
  try {
    const premium = await isPremium(req.db, req.user.id);
    const used = await uploadsToday(req.db, req.user.id);
    res.json({ email: req.user.email, premium, used, limit: premium ? null : FREE_DAILY_LIMIT });
  } catch (e) {
    log('ERROR', 'Status', e.message);
    res.status(500).json({ error: 'Could not load status.' });
  }
});

app.post('/upload', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const name = String((req.body && req.body.assetName) || '').trim().slice(0, 50);
    if (!name) return res.status(400).json({ error: 'Asset name is required.' });
    if (!req.file) return res.status(400).json({ error: 'Please choose a .fbx or .obj file.' });

    const premium = await isPremium(req.db, req.user.id);
    const used = await uploadsToday(req.db, req.user.id);
    if (!premium && used >= FREE_DAILY_LIMIT)
      return res.status(403).json({ error: 'Daily limit reached. Upgrade to Premium for unlimited uploads.' });

    log('INFO', 'Uploading "' + name + '"', req.user.id);
    const assetId = await uploadToRoblox(req.file, name);

    const { error } = await req.db.from('uploads')
      .insert({ user_id: req.user.id, asset_name: name, asset_id: assetId ? String(assetId) : null });
    if (error) log('WARN', 'Could not record upload', error.message);

    res.json({
      ok: true, assetId,
      message: assetId ? 'Uploaded! Asset ID: ' + assetId : 'Uploaded. Roblox is still processing it.',
    });
  } catch (e) {
    const detail = e.response && e.response.data ? JSON.stringify(e.response.data) : e.message;
    log('ERROR', 'Upload', detail);
    res.status(502).json({ error: 'Upload to Roblox failed. Check your file and API key permissions.' });
  }
});

app.post('/create-checkout-session', requireAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Payments are not configured.' });
    if (await isPremium(req.db, req.user.id)) return res.status(400).json({ error: 'You are already Premium.' });
    const base = APP_URL || req.protocol + '://' + req.get('host');
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      client_reference_id: req.user.id,
      customer_email: req.user.email,
      metadata: { userId: req.user.id },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd', unit_amount: 899, recurring: { interval: 'month' },
          product_data: { name: 'MiniDevs Premium', description: 'Unlimited daily uploads' },
        },
      }],
      success_url: base + '/?checkout=success',
      cancel_url: base + '/?checkout=cancel',
    });
    res.json({ url: session.url });
  } catch (e) {
    log('ERROR', 'Checkout', e.message);
    res.status(500).json({ error: 'Could not start checkout.' });
  }
});

app.get('/healthz', (req, res) => res.send('ok'));

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0b0d14">
<title>MiniDevs</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-[#0b0d14] text-slate-100 min-h-screen antialiased" style="padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)">
<div class="max-w-md mx-auto px-4 pb-16">
  <header class="py-8 text-center">
    <div class="mx-auto w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center text-3xl shadow-lg shadow-indigo-500/30">&#9651;</div>
    <h1 class="mt-4 text-3xl font-extrabold tracking-tight">Mini<span class="text-indigo-400">Devs</span></h1>
    <p class="mt-1 text-slate-400 text-sm">Upload 3D meshes to Roblox from your phone.</p>
  </header>

  <section id="authView" class="hidden bg-white/5 border border-white/10 rounded-3xl p-5">
    <h2 class="font-bold text-lg mb-3">Sign in to start</h2>
    <label class="text-xs text-slate-400" for="email">Email</label>
    <input id="email" type="email" autocomplete="email" class="w-full mb-3 mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-indigo-400">
    <label class="text-xs text-slate-400" for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" class="w-full mb-4 mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-indigo-400">
    <div class="grid grid-cols-2 gap-3">
      <button id="loginBtn" class="py-3 rounded-xl bg-indigo-500 font-semibold active:scale-95 transition">Log In</button>
      <button id="signupBtn" class="py-3 rounded-xl bg-white/10 font-semibold active:scale-95 transition">Sign Up</button>
    </div>
  </section>

  <main id="appView" class="hidden space-y-4">
    <section class="bg-white/5 border border-white/10 rounded-3xl p-5">
      <div class="flex items-center justify-between">
        <h2 class="font-bold">Daily Limit</h2>
        <span id="tierBadge" class="text-xs px-2.5 py-1 rounded-full bg-slate-700">FREE</span>
      </div>
      <div class="mt-3 h-3 rounded-full bg-black/40 overflow-hidden"><div id="bar" class="h-full w-0 rounded-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all duration-500"></div></div>
      <p id="usageText" class="mt-2 text-sm text-slate-400">Loading...</p>
    </section>

    <section class="bg-white/5 border border-white/10 rounded-3xl p-5">
      <h2 class="font-bold mb-3">Upload a mesh</h2>
      <label class="text-xs text-slate-400" for="assetName">Asset name</label>
      <input id="assetName" maxlength="50" placeholder="e.g. Castle Tower" class="w-full mb-3 mt-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-base focus:outline-none focus:border-indigo-400">
      <label class="text-xs text-slate-400" for="file">Model file (.fbx / .obj, max 20MB)</label>
      <input id="file" type="file" accept=".fbx,.obj" class="w-full mb-4 mt-1 text-sm text-slate-300 file:mr-3 file:py-2.5 file:px-4 file:rounded-xl file:border-0 file:bg-indigo-500/20 file:text-indigo-300 file:font-semibold">
      <button id="uploadBtn" class="w-full py-3.5 rounded-xl bg-gradient-to-r from-indigo-500 to-fuchsia-500 font-bold active:scale-95 transition disabled:opacity-50">Upload to Roblox</button>
    </section>

    <section id="payPanel" class="rounded-3xl p-5 border border-indigo-400/30 bg-gradient-to-br from-indigo-500/15 to-fuchsia-500/10">
      <h2 class="font-bold text-lg">Go Premium</h2>
      <p class="text-3xl font-extrabold mt-1">$8.99<span class="text-base font-medium text-slate-400">/month</span></p>
      <ul class="mt-3 text-sm text-slate-300 space-y-1">
        <li>&#10003; Unlimited daily uploads</li>
        <li>&#10003; Instant activation after checkout</li>
        <li>&#10003; Cancel anytime</li>
      </ul>
      <button id="checkoutBtn" class="mt-4 w-full py-3.5 rounded-xl bg-white text-slate-900 font-bold active:scale-95 transition">Upgrade with Stripe</button>
    </section>

    <div class="flex items-center justify-between text-sm text-slate-500 px-1">
      <span id="who"></span><button id="logoutBtn" class="underline">Log out</button>
    </div>
  </main>
</div>
<div id="toast" class="hidden"></div>

<script>
var $ = function (id) { return document.getElementById(id); };
var token = null;
try { token = localStorage.getItem('bm_token'); } catch (e) {}

function toast(msg, ok) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'fixed bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-sm text-center px-4 py-3 rounded-2xl text-sm font-medium shadow-xl ' + (ok ? 'bg-emerald-500 text-white' : 'bg-rose-500 text-white');
  setTimeout(function () { t.className = 'hidden'; }, 4500);
}
function setToken(v) {
  token = v;
  try { v ? localStorage.setItem('bm_token', v) : localStorage.removeItem('bm_token'); } catch (e) {}
}
async function api(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers || {});
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  var res = await fetch(url, opts);
  var data = {};
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401 && token) { setToken(null); show(false); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function show(loggedIn) {
  $('authView').classList.toggle('hidden', loggedIn);
  $('appView').classList.toggle('hidden', !loggedIn);
}
async function refresh() {
  if (!token) return show(false);
  try {
    var s = await api('/status');
    show(true);
    $('who').textContent = s.email;
    $('tierBadge').textContent = s.premium ? 'PREMIUM' : 'FREE';
    $('tierBadge').className = 'text-xs px-2.5 py-1 rounded-full ' + (s.premium ? 'bg-fuchsia-500 text-white' : 'bg-slate-700');
    $('payPanel').classList.toggle('hidden', s.premium);
    if (s.premium) {
      $('bar').style.width = '100%';
      $('usageText').textContent = 'Unlimited uploads. ' + s.used + ' used today.';
    } else {
      $('bar').style.width = Math.min(100, (s.used / s.limit) * 100) + '%';
      $('usageText').textContent = s.used + ' of ' + s.limit + ' free uploads used today. Resets at 00:00 UTC.';
    }
  } catch (e) { toast(e.message, false); }
}
async function auth(mode) {
  var btn = $(mode + 'Btn'); btn.disabled = true;
  try {
    var d = await api('/auth/' + mode, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value }),
    });
    if (d.token) { setToken(d.token); await refresh(); } else toast(d.message, true);
  } catch (e) { toast(e.message, false); }
  btn.disabled = false;
}
$('loginBtn').onclick = function () { auth('login'); };
$('signupBtn').onclick = function () { auth('signup'); };
$('logoutBtn').onclick = function () { setToken(null); show(false); };
$('uploadBtn').onclick = async function () {
  var name = $('assetName').value.trim(), f = $('file').files[0];
  if (!name || !f) return toast('Enter a name and choose a file.', false);
  var btn = $('uploadBtn'); btn.disabled = true; btn.textContent = 'Uploading...';
  try {
    var fd = new FormData();
    fd.append('assetName', name);
    fd.append('file', f);
    var d = await api('/upload', { method: 'POST', body: fd });
    toast(d.message, true);
    $('assetName').value = ''; $('file').value = '';
  } catch (e) { toast(e.message, false); }
  btn.disabled = false; btn.textContent = 'Upload to Roblox';
  refresh();
};
$('checkoutBtn').onclick = async function () {
  var btn = $('checkoutBtn'); btn.disabled = true;
  try {
    var d = await api('/create-checkout-session', { method: 'POST' });
    window.location.href = d.url;
  } catch (e) { toast(e.message, false); btn.disabled = false; }
};
var q = new URLSearchParams(location.search).get('checkout');
if (q === 'success') toast('Payment received! Premium activates in a few seconds.', true);
if (q === 'cancel') toast('Checkout canceled.', false);
if (q) history.replaceState({}, '', '/');
refresh();
if (q === 'success') setTimeout(refresh, 4000);
</script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').send(PAGE));

// Central error handler (covers Multer errors like file too large / wrong type).
app.use((err, req, res, next) => {
  log('WARN', 'Request error', err.message);
  if (res.headersSent) return next(err);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 20MB).' : err.message || 'Server error.';
  res.status(400).json({ error: msg });
});

process.on('unhandledRejection', (r) => log('ERROR', 'Unhandled rejection', String(r)));
process.on('uncaughtException', (e) => {
  console.error('[FATAL] Uncaught exception: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});

const server = app.listen(PORT, '0.0.0.0', () =>
  log('INFO', 'MiniDevs running on port ' + PORT + ' | database ' + (dbReady ? 'READY' : 'NOT READY')));
server.on('error', (e) => {
  console.error('[FATAL] Server failed to start on port ' + PORT + ': ' + e.message);
  process.exit(1);
});
