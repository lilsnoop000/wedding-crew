# Wedding Crew v5 -- Setup Guide

## Architecture Overview

This app uses a secure three-layer architecture:

1. Frontend (React) -- handles UI, reads data via API, subscribes to realtime updates
2. Serverless Function (/api/data) -- validates PINs server-side, proxies writes to database
3. Supabase (database) -- stores all shared data, pushes realtime updates via WebSocket

The Supabase service role key NEVER touches the browser. The anon key (in the browser)
can only SELECT data via Row Level Security. All writes require the PIN and go through
the serverless function. The setup key is validated server-side and never appears in
the frontend bundle.

---

## Step 1: Create GitHub Repo and Add Files

1. Create a new GitHub repo (e.g. "wedding-crew")
2. Unzip the download and upload the contents of miles-bach-v5
3. Make sure the file structure looks like this:

```
/api/data.js          <-- serverless function
/src/App.jsx          <-- main app
/src/main.jsx         <-- React entry
/index.html           <-- HTML shell
/package.json         <-- dependencies
/vite.config.js       <-- build config
```

The /api folder MUST be at the project root (not inside /src).

---

## Step 2: Create Supabase Project

1. Go to https://supabase.com and sign up (free tier)
2. Click "New Project", name it "wedding-crew"
3. Set a database password (save it, but the app does not need it)
4. Pick a region (East US is fine)
5. Wait about 1 minute for initialization

### Create the database with secure RLS

1. Click "SQL Editor" in the left sidebar
2. Click "New Query"
3. Paste this ENTIRE block and click "Run":

```sql
-- Main data table
create table if not exists docs (
  id text primary key,
  data jsonb not null default '{}',
  updated_at timestamptz default now()
);

-- Row Level Security: anon key can only SELECT, never write
alter table docs enable row level security;

create policy "Anon can read"
  on docs for select
  using (true);

-- No INSERT, UPDATE, or DELETE policies for anon.
-- All writes go through the serverless function using the service role key.

-- Enable realtime for live updates
alter publication supabase_realtime add table docs;
```

4. You should see "Success. No rows returned."

### Get your credentials

In "Project Settings" > "API":

- Copy the "Project URL" (e.g. https://xxxxx.supabase.co)
- Copy the "anon public" key (starts with "eyJ..." -- this is the read-only key)
- Copy the "service_role" key (starts with "eyJ..." -- this is the write key, keep it secret)

---

## Step 3: Configure Vercel

1. Go to vercel.com, click "Add New Project"
2. Select your GitHub repo
3. BEFORE deploying, click "Environment Variables" and add ALL of these:

| Variable Name        | Value                              | Notes                              |
|---------------------|------------------------------------|------------------------------------|
| SETUP_KEY           | (any secret phrase you choose)     | For first-time app initialization  |
| SUPABASE_URL        | https://xxxxx.supabase.co          | Server-side only                   |
| SUPABASE_SERVICE_KEY | eyJ... (service_role key)          | Server-side only, NEVER in browser |
| VITE_SUPABASE_URL   | https://xxxxx.supabase.co          | Same URL, exposed for realtime     |
| VITE_SUPABASE_KEY   | eyJ... (anon key)                  | Read-only, safe for browser        |

CRITICAL: SUPABASE_SERVICE_KEY and SETUP_KEY must NOT have the VITE_ prefix.
The VITE_ prefix means "include in browser bundle." Without it, the variable
is only available to the serverless function on the server.

4. Deploy the project

---

## Step 4: First-Time Setup

1. Open your deployed app URL
2. You will see the "First-time setup" screen
3. Enter your SETUP_KEY (the secret phrase from your Vercel env vars)
4. Enter the groom name, your name, crew PIN, and groom password
5. Click "Initialize App"
6. The serverless function validates the setup key server-side
7. You are logged in as Best Man

---

## Step 5: Add the Crew

1. Go to the Crew tab
2. Fill in groomsmen names (first + last initial to avoid duplicates)
3. Fill in vendor contacts and phone numbers
4. Share the app URL and crew PIN with your group chat
5. Each guy types their name, then the crew PIN

---

## Security Architecture

- Setup key: validated server-side only. Never in browser bundle.
- Crew PIN: validated server-side by the serverless function before every write.
- Groom password: also validated server-side.
- Supabase anon key: can only SELECT (read). Cannot INSERT, UPDATE, or DELETE.
- Supabase service role key: only accessible to the serverless function on Vercel.
- Offline writes: queued in localStorage, replayed automatically when connectivity returns.
- Realtime: uses read-only anon key via WebSocket. Safe to expose.
- The GitHub repo contains NO secrets. It can be public.

---

## Offline Behavior

- If someone loses connectivity, the app continues working from localStorage cache
- Any writes (checking tasks, updating status) are saved to a local mutation queue
- When connectivity returns, the queue replays automatically
- A small "pending" indicator appears in the header when queued writes exist
- A wifi-off icon appears when the device is offline

---

## iOS Shortcut for Emergency Broadcast (Optional, Advanced)

For the wedding day, you can create an iOS Shortcut that bypasses the web app entirely:

1. Open the Shortcuts app on your iPhone
2. Create a new shortcut
3. Add "Get Contents of URL" action:
   - URL: https://xxxxx.supabase.co/rest/v1/docs?id=eq.statuses
   - Method: GET
   - Headers: apikey = (your anon key), Authorization = Bearer (your anon key)
4. Add "Get Text from Input" to parse the JSON response
5. Add logic to filter for anyone not "At venue" or "In position"
6. Add "Send Message" action to text the stragglers

This lets you tap one button on your home screen to automatically message anyone
who is running late, without opening the app at all.
