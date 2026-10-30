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
