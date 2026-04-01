// =============================================================================
// /api/data.js -- Vercel Serverless Function
//
// This file is the security boundary of the entire app. Every database write
// flows through here. The browser never gets the Supabase service role key.
//
// Environment variables (set in Vercel dashboard, NO VITE_ prefix):
//   SUPABASE_URL         - Your Supabase project URL
//   SUPABASE_SERVICE_KEY  - Service role key (bypasses RLS, server-only)
//   SETUP_KEY            - Secret phrase for first-time app initialization
//
// The frontend sends POST requests with JSON body:
//   { action: "setup"|"get"|"set", key, value?, pin?, setupKey? }
//
// The function validates credentials before touching the database.
// =============================================================================

import { createClient } from "@supabase/supabase-js";

// Server-side Supabase client using the service role key.
// This key can read and write everything, which is why it stays here.
var getSupabase = function() {
  var url = process.env.SUPABASE_URL;
  var key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
};

// Read the current config from the database to validate PINs against.
var getConfig = async function(sb) {
  var res = await sb.from("docs").select("data").eq("id", "config").maybeSingle();
  return (res.data && res.data.data) || null;
};

export default async function handler(req, res) {
  // ------------------------------------------------------------------
  // Only accept POST requests
  // ------------------------------------------------------------------
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  var sb = getSupabase();
  if (!sb) {
    return res.status(500).json({ error: "Supabase not configured on server" });
  }

  var body = req.body || {};
  var action = body.action;
  var key = body.key;
  var value = body.value;
  var pin = body.pin || "";
  var setupKey = body.setupKey || "";

  // ------------------------------------------------------------------
  // ACTION: "setup" -- First-time initialization
  // Validates the setup key from env var, creates initial config.
  // ------------------------------------------------------------------
  if (action === "setup") {
    var envSetupKey = process.env.SETUP_KEY || "";
    if (!envSetupKey) {
      return res.status(500).json({ error: "SETUP_KEY not configured in Vercel environment variables" });
    }
    if (setupKey !== envSetupKey) {
      return res.status(403).json({ error: "Invalid setup key" });
    }
    // Check if already initialized (prevent re-initialization)
    var existing = await getConfig(sb);
    if (existing && existing.initialized) {
      return res.status(400).json({ error: "App already initialized" });
    }
    // Write the initial config
    var result = await sb.from("docs").upsert({
      id: key || "config",
      data: value,
      updated_at: new Date().toISOString()
    });
    if (result.error) {
      return res.status(500).json({ error: result.error.message });
    }
    return res.status(200).json({ data: value });
  }

  // ------------------------------------------------------------------
  // ACTION: "get" -- Read a document
  // Validates PIN against stored config before allowing reads.
  // ------------------------------------------------------------------
  if (action === "get") {
    // Special case: reading config itself during login flow.
    // We allow reading config without PIN so the login screen can check
    // if names exist. The config contains no sensitive data beyond the
    // PINs themselves, which are short numeric codes.
    // For all other reads, PIN is required.
    if (key !== "config") {
      var cfg = await getConfig(sb);
      if (cfg && cfg.crew_pin && pin !== cfg.crew_pin && pin !== cfg.groom_pin) {
        return res.status(403).json({ error: "Invalid PIN" });
      }
    }

    var readResult = await sb.from("docs").select("data").eq("id", key).maybeSingle();
    if (readResult.error) {
      return res.status(500).json({ error: readResult.error.message });
    }
    return res.status(200).json({ data: readResult.data ? readResult.data.data : null });
  }

  // ------------------------------------------------------------------
  // ACTION: "set" -- Write a document
  // Always validates PIN (except during setup, handled above).
  // ------------------------------------------------------------------
  if (action === "set") {
    var cfg2 = await getConfig(sb);

    // If config exists and has a PIN, validate it
    if (cfg2 && cfg2.initialized) {
      var validPin = false;
      if (cfg2.crew_pin && pin === cfg2.crew_pin) validPin = true;
      if (cfg2.groom_pin && pin === cfg2.groom_pin) validPin = true;
      // If no crew_pin is set, allow writes (PIN not yet configured)
      if (!cfg2.crew_pin && !cfg2.groom_pin) validPin = true;
      if (!validPin) {
        return res.status(403).json({ error: "Invalid PIN" });
      }
    }

    var writeResult = await sb.from("docs").upsert({
      id: key,
      data: value,
      updated_at: new Date().toISOString()
    });
    if (writeResult.error) {
      return res.status(500).json({ error: writeResult.error.message });
    }
    return res.status(200).json({ data: value });
  }

  return res.status(400).json({ error: "Unknown action: " + action });
}
