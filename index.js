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
    const base = APP_URL || req.protocol + '://' + req.get('host');
    const { data, error } = await anon.auth.signUp({
      email, password, options: { emailRedirectTo: base + '/' },
    });
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

app.post('/auth/verify', async (req, res) => {
  try {
    const { email, code } = req.body || {};
    const token = String(code || '').trim();
    if (!email || !/^\d{6,10}$/.test(token)) return res.status(400).json({ error: 'Enter the numeric code from your email.' });
    const { data, error } = await anon.auth.verifyOtp({ email, token, type: 'signup' });
    if (error || !data.session) return res.status(400).json({ error: 'Invalid or expired code.' });
    if (admin) await admin.from('profiles').upsert({ id: data.user.id }, { ignoreDuplicates: true });
    log('INFO', 'Email confirmed', data.user.id);
    res.json({ token: data.session.access_token });
  } catch (e) {
    log('ERROR', 'Verify', e.message);
    res.status(500).json({ error: 'Confirmation failed.' });
  }
});

app.post('/auth/resend', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    const base = APP_URL || req.protocol + '://' + req.get('host');
    const { error } = await anon.auth.resend({ type: 'signup', email, options: { emailRedirectTo: base + '/' } });
    if (error) return res.status(400).json({ error: error.message });
    res.json({ ok: true });
  } catch (e) {
    log('ERROR', 'Resend', e.message);
    res.status(500).json({ error: 'Could not resend code.' });
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
<meta name="theme-color" content="#e10600">
<title>MiniDevs</title>
<script>
(function(){var t=null;try{t=localStorage.getItem('md_theme');}catch(e){}
var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark',d);})();
</script>
<script src="https://cdn.tailwindcss.com"></script>
<style>
:root{--bg:#fff;--fg:#000;--red:#e10600;--mut:.7}
html.dark{--bg:#000;--fg:#fff}
body{background:var(--bg);color:var(--fg);font-family:Impact,'Arial Black',system-ui,sans-serif}
.card{border:2px solid var(--fg);background:var(--bg);position:relative;padding:1.5rem 1.25rem 1.25rem}
.card:before{content:"";position:absolute;left:-2px;right:-2px;top:-2px;height:7px;background:var(--red)}
.h{font-size:1.5rem;font-weight:900;letter-spacing:.18em;text-transform:uppercase;margin:0 0 1rem}
.lbl{display:block;font-size:11px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;margin:0 0 .35rem}
.inp{width:100%;background:transparent;color:var(--fg);border:2px solid var(--fg);padding:.85rem 1rem;font-size:16px;border-radius:0;outline:none;margin-bottom:1rem;font-family:system-ui,sans-serif}
.inp:focus{border-color:var(--red)}
.code{text-align:center;font-size:2rem;letter-spacing:.6em;font-weight:900}
.btn{display:block;width:100%;padding:1rem;font-weight:900;letter-spacing:.28em;text-transform:uppercase;border:2px solid var(--red);border-radius:0;background:var(--red);color:#fff}
.btn:active{transform:scale(.98)}
.btn:disabled{opacity:.5}
.btn-o{background:transparent;color:var(--fg);border-color:var(--fg)}
.lnk{background:none;border:0;color:var(--fg);font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;text-decoration:underline;text-underline-offset:5px;padding:.5rem 0}
.mut{opacity:var(--mut);font-family:system-ui,sans-serif;font-size:.875rem}
.tag{font-size:11px;font-weight:900;letter-spacing:.2em;padding:.3rem .6rem;border:2px solid var(--fg)}
.tag-p{background:var(--red);border-color:var(--red);color:#fff}
.track{height:18px;border:2px solid var(--fg)}
.fill{height:100%;width:0;background:var(--red);transition:width .5s}
.toast{position:fixed;bottom:1.5rem;left:5%;right:5%;max-width:24rem;margin:0 auto;text-align:center;padding:1rem;font:800 12px/1.4 system-ui,sans-serif;letter-spacing:.1em;text-transform:uppercase;z-index:50}
.toast-ok{background:var(--fg);color:var(--bg);border:2px solid var(--red)}
.toast-err{background:var(--red);color:#fff;border:2px solid var(--fg)}
input[type=file]::file-selector-button{background:var(--red);color:#fff;border:0;padding:.6rem 1rem;margin-right:.8rem;font-weight:900;letter-spacing:.12em;text-transform:uppercase;border-radius:0}
</style>
</head>
<body class="min-h-screen antialiased" style="padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)">
<div class="max-w-md mx-auto px-5 pb-16">
  <div class="flex justify-end pt-4"><button id="themeBtn" class="lnk">Light / Dark</button></div>
  <header class="pt-2 pb-8 text-center">
    <svg class="mx-auto" width="96" height="70" viewBox="100 360 860 570" fill="none" stroke="#e10600" stroke-width="30" stroke-linecap="round" aria-label="MiniDevs logo">
      <ellipse cx="552" cy="475" rx="198" ry="93"/>
      <path d="M310 659 C262 715 180 790 133 861"/>
      <path d="M769 701 L880 830 C905 858 918 880 928 906"/>
    </svg>
    <h1 class="mt-4 text-4xl font-black tracking-[.22em] uppercase">Mini<span style="color:var(--red)">Devs</span></h1>
    <p class="mt-2 text-xs font-black tracking-[.3em] uppercase" style="opacity:.75">Restricted access // Builders only</p>
  </header>

  <section id="loginView" class="card hidden">
    <h2 class="h">Log In</h2>
    <label class="lbl" for="lEmail">Gmail</label>
    <input id="lEmail" type="email" autocomplete="email" class="inp" placeholder="you@gmail.com">
    <label class="lbl" for="lPass">Password</label>
    <input id="lPass" type="password" autocomplete="current-password" class="inp">
    <button id="loginBtn" class="btn">Log In</button>
    <div class="mt-4 flex items-center justify-between"><span class="mut">No account?</span><button id="toSignup" class="lnk">Sign up</button></div>
  </section>

  <section id="signupView" class="card hidden">
    <h2 class="h">Create Account</h2>
    <label class="lbl" for="sEmail">Your Gmail</label>
    <input id="sEmail" type="email" autocomplete="email" class="inp" placeholder="you@gmail.com">
    <label class="lbl" for="sPass">Create password</label>
    <input id="sPass" type="password" autocomplete="new-password" class="inp">
    <label class="lbl" for="sPass2">Confirm password</label>
    <input id="sPass2" type="password" autocomplete="new-password" class="inp">
    <button id="signupBtn" class="btn">Create Account</button>
    <div class="mt-4"><button id="toLogin1" class="lnk">&larr; Back to log in</button></div>
  </section>

  <section id="verifyView" class="card hidden">
    <h2 class="h">Check Your Gmail</h2>
    <p class="mut mb-4">We sent a confirmation code to <b id="vEmail"></b>. Enter it below to activate your account.</p>
    <label class="lbl" for="vCode">Confirmation code</label>
    <input id="vCode" inputmode="numeric" autocomplete="one-time-code" maxlength="8" class="inp code" placeholder="000000">
    <button id="verifyBtn" class="btn">Confirm</button>
    <div class="mt-4 flex items-center justify-between"><button id="resendBtn" class="lnk">Resend code</button><button id="toSignup2" class="lnk">Wrong email?</button></div>
  </section>

  <main id="appView" class="hidden space-y-6">
    <section class="card">
      <div class="flex items-center justify-between mb-4"><h2 class="h" style="margin:0">Daily Limit</h2><span id="tierBadge" class="tag">FREE</span></div>
      <div class="track"><div id="bar" class="fill"></div></div>
      <p id="usageText" class="mut mt-3">Loading...</p>
    </section>

    <section class="card">
      <h2 class="h">Upload Mesh</h2>
      <label class="lbl" for="assetName">Asset name</label>
      <input id="assetName" maxlength="50" class="inp" placeholder="Castle Tower">
      <label class="lbl" for="file">Model file (.fbx / .obj, max 20MB)</label>
      <input id="file" type="file" accept=".fbx,.obj" class="inp" style="padding:.6rem">
      <button id="uploadBtn" class="btn">Upload to Roblox</button>
    </section>

    <section id="payPanel" class="card" style="border-color:var(--red)">
      <h2 class="h">Go Premium</h2>
      <p style="font-size:2.75rem;font-weight:900;line-height:1">$8.99<span class="mut"> /month</span></p>
      <ul class="mut mt-3 mb-4" style="line-height:1.8"><li>&#9632; Unlimited daily uploads</li><li>&#9632; Instant activation after checkout</li><li>&#9632; Cancel anytime</li></ul>
      <button id="checkoutBtn" class="btn">Upgrade with Stripe</button>
    </section>

    <div class="flex items-center justify-between"><span id="who" class="mut"></span><button id="logoutBtn" class="lnk">Log out</button></div>
  </main>
</div>
<div id="toast" class="hidden"></div>

<script>
var $ = function (id) { return document.getElementById(id); };
var token = null, pending = '';
try { token = localStorage.getItem('md_token'); } catch (e) {}
var VIEWS = ['loginView', 'signupView', 'verifyView', 'appView'];

function toast(msg, ok) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + (ok ? 'toast-ok' : 'toast-err');
  clearTimeout(toast.h);
  toast.h = setTimeout(function () { t.className = 'hidden'; }, 4500);
}
function view(n) {
  VIEWS.forEach(function (v) { $(v).classList.toggle('hidden', v !== n); });
  window.scrollTo(0, 0);
}
function setToken(v) {
  token = v;
  try { v ? localStorage.setItem('md_token', v) : localStorage.removeItem('md_token'); } catch (e) {}
}
async function api(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers || {});
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  var res = await fetch(url, opts);
  var data = {};
  try { data = await res.json(); } catch (e) {}
  if (res.status === 401 && token) { setToken(null); view('loginView'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function post(url, body) {
  return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function run(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, false); }
  btn.disabled = false;
}
async function refresh() {
  if (!token) return view('loginView');
  try {
    var s = await api('/status');
    view('appView');
    $('who').textContent = s.email;
    $('tierBadge').textContent = s.premium ? 'PREMIUM' : 'FREE';
    $('tierBadge').className = 'tag' + (s.premium ? ' tag-p' : '');
    $('payPanel').classList.toggle('hidden', s.premium);
    if (s.premium) {
      $('bar').style.width = '100%';
      $('usageText').textContent = 'Unlimited uploads. ' + s.used + ' used today.';
    } else {
      $('bar').style.width = Math.min(100, (s.used / s.limit) * 100) + '%';
      $('usageText').textContent = s.used + ' of ' + s.limit + ' free uploads used today. Resets 00:00 UTC.';
    }
  } catch (e) { toast(e.message, false); }
}

$('themeBtn').onclick = function () {
  var d = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('md_theme', d ? 'dark' : 'light'); } catch (e) {}
};
$('toSignup').onclick = $('toSignup2').onclick = function () { view('signupView'); };
$('toLogin1').onclick = function () { view('loginView'); };
$('logoutBtn').onclick = function () { setToken(null); view('loginView'); };

$('loginBtn').onclick = function () {
  run(this, async function () {
    var d = await post('/auth/login', { email: $('lEmail').value.trim(), password: $('lPass').value });
    setToken(d.token);
    await refresh();
  });
};
$('signupBtn').onclick = function () {
  run(this, async function () {
    var e = $('sEmail').value.trim(), p = $('sPass').value;
    if (!e) throw new Error('Enter your Gmail.');
    if (p.length < 6) throw new Error('Password needs 6+ characters.');
    if (p !== $('sPass2').value) throw new Error('Passwords do not match.');
    var d = await post('/auth/signup', { email: e, password: p });
    if (d.token) { setToken(d.token); await refresh(); return; }
    pending = e;
    $('vEmail').textContent = e;
    $('vCode').value = '';
    view('verifyView');
    toast('Code sent. Check your Gmail.', true);
  });
};
$('verifyBtn').onclick = function () {
  run(this, async function () {
    var d = await post('/auth/verify', { email: pending, code: $('vCode').value.trim() });
    setToken(d.token);
    toast('Account confirmed. Welcome.', true);
    await refresh();
  });
};
$('resendBtn').onclick = function () {
  run(this, async function () {
    await post('/auth/resend', { email: pending });
    toast('New code sent.', true);
  });
};
$('uploadBtn').onclick = function () {
  run(this, async function () {
    var name = $('assetName').value.trim(), f = $('file').files[0];
    if (!name || !f) throw new Error('Enter a name and choose a file.');
    var fd = new FormData();
    fd.append('assetName', name);
    fd.append('file', f);
    var d = await api('/upload', { method: 'POST', body: fd });
    toast(d.message, true);
    $('assetName').value = ''; $('file').value = '';
    refresh();
  });
};
$('checkoutBtn').onclick = function () {
  run(this, async function () {
    var d = await api('/create-checkout-session', { method: 'POST' });
    window.location.href = d.url;
  });
};

var h = location.hash || '';
if (h.indexOf('error=') > -1) { toast('That confirmation link expired. Sign up again.', false); history.replaceState({}, '', '/'); }
else if (h.indexOf('access_token') > -1 || h.indexOf('type=signup') > -1) { toast('Email confirmed. Please log in.', true); history.replaceState({}, '', '/'); }
var q = new URLSearchParams(location.search).get('checkout');
if (q === 'success') toast('Payment received. Premium activates in seconds.', true);
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
