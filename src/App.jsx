import React, { useState, useEffect, useRef, useCallback } from "react";
import { Home, CheckSquare, DollarSign, CalendarDays, Users, Calendar, Clock, AlertTriangle, Download, ExternalLink, Copy, Phone, Send, Camera, Sparkles, X, MessageCircle, ChevronDown, ChevronRight, Wifi, WifiOff } from "lucide-react";
import { createClient } from "@supabase/supabase-js";

// =============================================================================
// SUPABASE REALTIME CLIENT (read-only, anon key)
//
// This client is ONLY used for realtime subscriptions (WebSocket).
// The RLS policy on the database restricts this key to SELECT only.
// All writes go through the serverless function at /api/data.
// =============================================================================
var RT_URL = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_SUPABASE_URL) || "";
var RT_KEY = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_SUPABASE_KEY) || "";

var realtimeClient = null;
if (RT_URL && RT_KEY) {
  realtimeClient = createClient(RT_URL, RT_KEY);
}

// =============================================================================
// CONSTANTS
// =============================================================================
var WEDDING_DATE = new Date("2026-07-11T00:00:00");
var BACHELOR_DATE = new Date("2026-07-10T00:00:00");

// =============================================================================
// HELPERS
// =============================================================================
var daysUntil = function(t) { return Math.max(0, Math.ceil((t.getTime() - Date.now()) / 86400000)); };
var weeksUntil = function(t) { return Math.max(0, Math.ceil((t.getTime() - Date.now()) / 604800000)); };
var fmt = function(n) { return "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }); };
var todayISO = function() { return new Date().toISOString().split("T")[0]; };
var pad2 = function(n) { return String(n).padStart(2, "0"); };
var safeNum = function(val, fb) { var n = Number(val); return isNaN(n) ? (fb || 0) : n; };

var urgency = function(dateStr) {
  var diff = (new Date(dateStr + "T23:59:59").getTime() - Date.now()) / 86400000;
  if (diff < 0) return "overdue";
  if (diff < 7) return "urgent";
  if (diff < 14) return "soon";
  return "normal";
};
var isDueThisWeek = function(dateStr) {
  return (new Date(dateStr + "T23:59:59").getTime() - Date.now()) / 86400000 < 7;
};

var urgColors = { overdue: "#E53935", urgent: "#F9A825", soon: "#FFD54F", normal: "transparent" };
var catColors = {
  plan: "#F9A825", money: "#43A047", comms: "#1E88E5", book: "#8E24AA",
  attire: "#00ACC1", speech: "#E91E63", personal: "#FB8C00", dayof: "#6D4C41",
  license: "#7CB342", gifts: "#AB47BC", travel: "#5C6BC0", vows: "#EC407A"
};

// =============================================================================
// DATABASE LAYER -- Serverless Function Proxy + Offline Queue
//
// Every read/write goes to /api/data, which validates the PIN server-side
// before touching Supabase. If the request fails (offline, server error),
// writes are saved to a local mutation queue and replayed when connectivity
// returns. localStorage always serves as a backup cache.
// =============================================================================
var QUEUE_KEY = "wc:mutation-queue";

var loadQueue = function() {
  try { var q = localStorage.getItem(QUEUE_KEY); return q ? JSON.parse(q) : []; }
  catch(e) { return []; }
};

var saveQueue = function(queue) {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch(e) {}
};

// The PIN is stored in a module-level variable so the db functions can access it.
// It gets set during login and cleared on logout.
var sessionPin = "";

var db = {
  get: async function(key) {
    // Try the server first
    try {
      var resp = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get", key: key, pin: sessionPin })
      });
      if (resp.ok) {
        var json = await resp.json();
        // Cache in localStorage
        if (json.data !== null && json.data !== undefined) {
          try { localStorage.setItem("wc:" + key, JSON.stringify(json.data)); } catch(e) {}
        }
        return json.data;
      }
    } catch(e) {
      // Network error -- fall through to localStorage
    }
    // Fallback to localStorage cache
    try { var v = localStorage.getItem("wc:" + key); return v ? JSON.parse(v) : null; }
    catch(e) { return null; }
  },

  set: async function(key, value) {
    // Always save to localStorage immediately (optimistic update)
    try { localStorage.setItem("wc:" + key, JSON.stringify(value)); } catch(e) {}

    // Try the server
    try {
      var resp = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set", key: key, value: value, pin: sessionPin })
      });
      if (resp.ok) return true;
      // Server rejected (403, 500, etc.) -- queue for retry if it was a network issue
      if (!resp.ok && resp.status >= 500) {
        throw new Error("Server error");
      }
      return false;
    } catch(e) {
      // Network error -- add to mutation queue
      var queue = loadQueue();
      queue.push({ key: key, value: value, timestamp: Date.now() });
      saveQueue(queue);
      return false;
    }
  },

  setup: async function(setupKey, key, value) {
    try {
      var resp = await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setup", setupKey: setupKey, key: key, value: value })
      });
      var json = await resp.json();
      if (resp.ok) {
        try { localStorage.setItem("wc:" + key, JSON.stringify(value)); } catch(e) {}
        return { ok: true, data: json.data };
      }
      return { ok: false, error: json.error || "Setup failed" };
    } catch(e) {
      return { ok: false, error: "Cannot reach server. Check your internet connection." };
    }
  },

  // Replay any queued mutations that failed due to connectivity
  replayQueue: async function() {
    var queue = loadQueue();
    if (queue.length === 0) return;
    var remaining = [];
    for (var i = 0; i < queue.length; i++) {
      var item = queue[i];
      try {
        var resp = await fetch("/api/data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set", key: item.key, value: item.value, pin: sessionPin })
        });
        if (!resp.ok && resp.status >= 500) {
          remaining.push(item); // Keep in queue for next retry
        }
        // If 403 (invalid PIN), drop it -- stale mutation
      } catch(e) {
        remaining.push(item); // Network still down
      }
    }
    saveQueue(remaining);
  }
};

// =============================================================================
// CALENDAR EXPORT (.ics)
// =============================================================================
var makeICS = function(events) {
  var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//WeddingCrew//EN"];
  events.forEach(function(ev) {
    var d = new Date(ev.date + "T00:00:00");
    var ds = "" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
    lines.push("BEGIN:VEVENT", "DTSTART;VALUE=DATE:" + ds, "SUMMARY:" + ev.title,
      "BEGIN:VALARM", "TRIGGER:-P2D", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "END:VALARM",
      "END:VEVENT");
  });
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
};

var downloadICS = function(events, filename) {
  var blob = new Blob([makeICS(events)], { type: "text/calendar;charset=utf-8" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a"); a.href = url; a.download = filename || "reminder.ics";
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
};

// =============================================================================
// TASK DATA (unchanged from v4)
// =============================================================================
var TASKS = [
  { id: "bm1", task: "Look at all places Miles sent -- screenshot favorites, note the vibe", by: "Apr 5", date: "2026-04-05", cat: "plan", roles: ["bestman"] },
  { id: "bm2", task: "Count confirmed guys (headcount determines everything)", by: "Apr 5", date: "2026-04-05", cat: "plan", roles: ["bestman"] },
  { id: "bm3", task: "Decide the shape of the day: afternoon activity, dinner, evening", by: "Apr 12", date: "2026-04-12", cat: "plan", roles: ["bestman"] },
  { id: "bm4", task: "Draft the itinerary with specific venues and activities", by: "Apr 12", date: "2026-04-12", cat: "plan", roles: ["bestman"] },
  { id: "bm5", task: "Price out every piece -- activities, food, drinks, transport", by: "Apr 19", date: "2026-04-19", cat: "money", roles: ["bestman"] },
  { id: "bm6", task: "Calculate per-person cost (Miles pays $0) and weekly contribution", by: "Apr 19", date: "2026-04-19", cat: "money", roles: ["bestman"] },
  { id: "bm7", task: "Send the group message: itinerary + cost + weekly Venmo amount", by: "Apr 19", date: "2026-04-19", cat: "comms", roles: ["bestman"] },
  { id: "bm8", task: "Book restaurant reservation", by: "May 1", date: "2026-05-01", cat: "book", roles: ["bestman"] },
  { id: "bm9", task: "Book activity reservation (if needed)", by: "May 1", date: "2026-05-01", cat: "book", roles: ["bestman"] },
  { id: "bm10", task: "Book any transportation (party bus, rideshare, etc.)", by: "May 1", date: "2026-05-01", cat: "book", roles: ["bestman"] },
  { id: "bm11", task: "Follow up with guys who have not confirmed or paid", by: "Jun 1", date: "2026-06-01", cat: "comms", roles: ["bestman"] },
  { id: "bm12", task: "Confirm all reservations -- call each venue", by: "Jun 15", date: "2026-06-15", cat: "book", roles: ["bestman"] },
  { id: "bm13", task: "Collect remaining contributions -- everyone paid in full", by: "Jun 22", date: "2026-06-22", cat: "money", roles: ["bestman"] },
  { id: "bm14", task: "Final headcount confirmation to all venues", by: "Jul 5", date: "2026-07-05", cat: "book", roles: ["bestman"] },
  { id: "bm15", task: "Start collecting speech notes -- stories and moments", by: "May 15", date: "2026-05-15", cat: "speech", roles: ["bestman"] },
  { id: "bm16", task: "Write the toast -- 3 to 5 minutes, stories + sincerity", by: "Jun 28", date: "2026-06-28", cat: "speech", roles: ["bestman"] },
  { id: "bm17", task: "Practice toast out loud at least 3 times", by: "Jul 5", date: "2026-07-05", cat: "speech", roles: ["bestman"] },
  { id: "bm18", task: "Get fitted for your suit or tux", by: "May 1", date: "2026-05-01", cat: "attire", roles: ["bestman"] },
  { id: "bm19", task: "Pick up or confirm delivery of suit or tux", by: "Jun 28", date: "2026-06-28", cat: "attire", roles: ["bestman"] },
  { id: "bm20", task: "Try on complete outfit -- shoes, belt, socks, everything", by: "Jul 1", date: "2026-07-01", cat: "attire", roles: ["bestman"] },
  { id: "bm21", task: "Buy wedding gift for Miles and his partner", by: "Jun 15", date: "2026-06-15", cat: "gifts", roles: ["bestman"] },
  { id: "bm22", task: "Confirm your travel to Chicago (flights or drive, lodging)", by: "May 15", date: "2026-05-15", cat: "travel", roles: ["bestman"] },
  { id: "bm23", task: "Get a haircut (1-2 weeks before, NOT the day before)", by: "Jul 1", date: "2026-07-01", cat: "personal", roles: ["bestman"] },
  { id: "bm24", task: "Break in your dress shoes around the house", by: "Jun 28", date: "2026-06-28", cat: "personal", roles: ["bestman"] },
  { id: "bm25", task: "Pack: rings, speech notes, outfit, gift, emergency kit", by: "Jul 8", date: "2026-07-08", cat: "personal", roles: ["bestman"] },
  { id: "gm1", task: "RSVP to the wedding", by: "Apr 15", date: "2026-04-15", cat: "comms", roles: ["groomsman"] },
  { id: "gm2", task: "Get measured and fitted for suit or tux", by: "May 1", date: "2026-05-01", cat: "attire", roles: ["groomsman"] },
  { id: "gm3", task: "Contribute to bachelor party fund", by: "May 15", date: "2026-05-15", cat: "money", roles: ["groomsman"] },
  { id: "gm4", task: "Book travel to Chicago", by: "May 15", date: "2026-05-15", cat: "travel", roles: ["groomsman"] },
  { id: "gm5", task: "Book hotel (ask about wedding room block)", by: "May 15", date: "2026-05-15", cat: "travel", roles: ["groomsman"] },
  { id: "gm6", task: "Pick up or confirm delivery of suit or tux", by: "Jun 28", date: "2026-06-28", cat: "attire", roles: ["groomsman"] },
  { id: "gm7", task: "Try on complete outfit -- shoes, belt, socks, tie", by: "Jul 1", date: "2026-07-01", cat: "attire", roles: ["groomsman"] },
  { id: "gm8", task: "Buy wedding gift", by: "Jun 15", date: "2026-06-15", cat: "gifts", roles: ["groomsman"] },
  { id: "gm9", task: "Get a haircut (1-2 weeks before the wedding)", by: "Jul 1", date: "2026-07-01", cat: "personal", roles: ["groomsman"] },
  { id: "gm10", task: "Break in your dress shoes", by: "Jun 28", date: "2026-06-28", cat: "personal", roles: ["groomsman"] },
  { id: "gm11", task: "Pack: outfit, shoes, gift, phone charger, toiletries", by: "Jul 8", date: "2026-07-08", cat: "personal", roles: ["groomsman"] },
  { id: "gr1", task: "Check marriage license requirements (many need 30+ days)", by: "May 1", date: "2026-05-01", cat: "license", roles: ["groom"] },
  { id: "gr2", task: "Apply for marriage license with your partner", by: "Jun 1", date: "2026-06-01", cat: "license", roles: ["groom"] },
  { id: "gr3", task: "Final suit or tux fitting", by: "Jun 1", date: "2026-06-01", cat: "attire", roles: ["groom"] },
  { id: "gr4", task: "Confirm wedding rings are sized and ready", by: "Jun 15", date: "2026-06-15", cat: "personal", roles: ["groom"] },
  { id: "gr5", task: "Write personal vows (if doing personal vows)", by: "Jun 28", date: "2026-06-28", cat: "vows", roles: ["groom"] },
  { id: "gr6", task: "Practice vows out loud a few times", by: "Jul 5", date: "2026-07-05", cat: "vows", roles: ["groom"] },
  { id: "gr7", task: "Buy groomsmen gifts", by: "Jun 15", date: "2026-06-15", cat: "gifts", roles: ["groom"] },
  { id: "gr8", task: "Buy wedding day gift for your partner", by: "Jul 1", date: "2026-07-01", cat: "gifts", roles: ["groom"] },
  { id: "gr9", task: "Confirm all vendor payments", by: "Jun 28", date: "2026-06-28", cat: "money", roles: ["groom"] },
  { id: "gr10", task: "Finalize seating chart", by: "Jun 22", date: "2026-06-22", cat: "plan", roles: ["groom"] },
  { id: "gr11", task: "Confirm rehearsal dinner details", by: "Jun 28", date: "2026-06-28", cat: "book", roles: ["groom"] },
  { id: "gr12", task: "Confirm honeymoon bookings", by: "Jun 15", date: "2026-06-15", cat: "travel", roles: ["groom"] },
  { id: "gr13", task: "Practice first dance", by: "Jul 1", date: "2026-07-01", cat: "personal", roles: ["groom"] },
  { id: "gr14", task: "Get a haircut (1-2 weeks before)", by: "Jul 1", date: "2026-07-01", cat: "personal", roles: ["groom"] },
  { id: "gr15", task: "Break in dress shoes", by: "Jun 28", date: "2026-06-28", cat: "personal", roles: ["groom"] },
  { id: "gr16", task: "Prepare photography shot list", by: "Jun 28", date: "2026-06-28", cat: "plan", roles: ["groom"] },
  { id: "gr17", task: "Confirm officiant and ceremony flow", by: "Jul 1", date: "2026-07-01", cat: "book", roles: ["groom"] },
  { id: "gr18", task: "Pack wedding day bag: suit, vows, license, gift, rings", by: "Jul 8", date: "2026-07-08", cat: "personal", roles: ["groom"] },
  { id: "gr19", task: "Pack honeymoon luggage separately", by: "Jul 8", date: "2026-07-08", cat: "travel", roles: ["groom"] },
];

// =============================================================================
// STATIC DATA (packing, timeline, challenges, hype, speech tips, default config)
// =============================================================================
var PACKING = {
  bestman: ["Suit or tux (pressed)","Dress shirt","Tie or bow tie","Pocket square","Dress shoes (broken in)","Dress socks","Belt","Undershirt","THE WEDDING RINGS","Speech notes (printed backup)","Wedding gift","Phone charger","Toiletry bag","Emergency kit: safety pins, stain remover, pain reliever, breath mints, sewing kit","Cash for tips","ID"],
  groomsman: ["Suit or tux (pressed)","Dress shirt","Tie or bow tie","Pocket square","Dress shoes (broken in)","Dress socks","Belt","Undershirt","Wedding gift","Phone charger","Toiletry bag","ID"],
  groom: ["Suit or tux (pressed)","Dress shirt","Tie or bow tie","Pocket square","Dress shoes (broken in)","Dress socks","Belt","Undershirt","Wedding rings","Vows or ceremony notes (printed)","Marriage license","Gift for partner","Groomsmen gifts","Cologne","Wedding night bag (change of clothes, hotel confirmation)","Honeymoon luggage (packed separately)","Passport or ID","Phone charger","Toiletry bag","Cash for tips"]
};

var DEFAULT_TIMELINE = [
  { time: "10:00 AM", event: "Groomsmen arrive at getting-ready location", who: "all" },
  { time: "10:30 AM", event: "Breakfast and coffee -- eat now, you will forget later", who: "all" },
  { time: "11:00 AM", event: "Start getting dressed", who: "all" },
  { time: "12:00 PM", event: "Groomsmen photos", who: "all" },
  { time: "12:30 PM", event: "Best man confirms rings are in pocket", who: "bestman" },
  { time: "2:00 PM", event: "Travel to ceremony venue", who: "all" },
  { time: "3:00 PM", event: "Guests seated, groomsmen in position", who: "all" },
  { time: "3:15 PM", event: "Ceremony begins", who: "all" },
  { time: "3:45 PM", event: "Ceremony ends -- sign marriage license", who: "bestman" },
  { time: "4:00 PM", event: "Family and wedding party photos", who: "all" },
  { time: "5:00 PM", event: "Cocktail hour", who: "all" },
  { time: "6:00 PM", event: "Reception entrance", who: "all" },
  { time: "6:30 PM", event: "Dinner served", who: "all" },
  { time: "7:15 PM", event: "Best man toast", who: "bestman" },
  { time: "7:30 PM", event: "First dance", who: "groom" },
  { time: "8:00 PM", event: "Open dancing", who: "all" },
  { time: "10:00 PM", event: "Send-off", who: "all" },
];

var PHOTO_CHALLENGES = [
  "Group photo where everyone strikes a model pose","Get a stranger to take a photo with the group",
  "Take a photo of Miles laughing so hard he cannot breathe","Selfie with a bartender or server",
  "Photo that looks like an album cover","Photo where nobody is looking at the camera",
  "Group jumping photo","Re-create a famous movie scene","Photo of the whole group pointing at Miles",
  "Take a photo of something blue (for the wedding)","Candid of someone telling a story",
  "Photo from the lowest angle possible","Group photo through a reflection",
  "Photo of the best food of the night","End-of-night group photo -- however you look, that is the memory",
];

var HYPE_MESSAGES = [
  "Today you marry your best friend. Everything else is just details.",
  "The only thing you need to remember: look at her when she walks in.",
  "A year from now this will be the best decision you ever made.",
  "Every person in that room chose to be there for you. Let that sink in.",
  "You are ready. You have been ready.",
  "Today is not about being perfect. It is about being present.",
  "Breathe. Smile. This is your day.",
  "You built something real. Today the world gets to see it.",
];

var SPEECH_TIPS = [
  "Keep it between 3 and 5 minutes. Under 3 feels rushed, over 5 loses the room.",
  "Open with who you are and how you know the groom. Not everyone knows you.",
  "Tell ONE good story. One told well beats five told quickly.",
  "Make the story about who Miles IS, not just something funny.",
  "Speak to his partner directly for at least 30 seconds.",
  "End with a sincere line, then raise your glass.",
  "Practice out loud. Reading silently and speaking are different skills.",
  "Do not get drunk before your toast. Celebrate after.",
  "Print your notes. Phones lock, batteries die, hands shake.",
  "Pause after your big lines. The audience needs a beat to react.",
];

var DEFAULT_CONFIG = {
  initialized: false, crew: [], crew_pin: "", groom_pin: "0711",
  costs: [
    { name: "Afternoon activity (per person)", amount: 50 },
    { name: "Dinner (per person)", amount: 75 },
    { name: "Drinks and bar (per person)", amount: 60 },
    { name: "Transportation (split)", amount: 30 },
  ],
  guy_count: 6, venmo_handle: "",
  contacts: [
    { role: "Wedding Coordinator", name: "", phone: "" },
    { role: "Photographer", name: "", phone: "" },
    { role: "DJ / Band", name: "", phone: "" },
    { role: "Officiant", name: "", phone: "" },
    { role: "Venue Contact", name: "", phone: "" },
    { role: "Florist", name: "", phone: "" },
  ],
  timeline: DEFAULT_TIMELINE,
};

// =============================================================================
// MAIN APP
// =============================================================================
export default function App() {
  var [userName, setUserName] = useState(null);
  var [userRole, setUserRole] = useState(null);
  var [loginInput, setLoginInput] = useState("");
  var [pinInput, setPinInput] = useState("");
  var [loginError, setLoginError] = useState("");
  var [loginStep, setLoginStep] = useState("name");

  var [config, setConfig] = useState(null);
  var [checks, setChecks] = useState({});
  var [packChecks, setPackChecks] = useState({});
  var [payments, setPayments] = useState({});
  var [statuses, setStatuses] = useState({});
  var [tab, setTab] = useState("home");
  var [subTab, setSubTab] = useState("timeline");
  var [loading, setLoading] = useState(true);
  var [online, setOnline] = useState(navigator.onLine);
  var [photoIndex, setPhotoIndex] = useState(-1);
  var [hypeIndex, setHypeIndex] = useState(0);
  var [speechTimer, setSpeechTimer] = useState(0);
  var [timerOn, setTimerOn] = useState(false);
  var [editMode, setEditMode] = useState(false);
  var [msgCopied, setMsgCopied] = useState("");
  var [showCelebration, setShowCelebration] = useState(false);
  var [showUpcoming, setShowUpcoming] = useState(false);

  var [setupKey, setSetupKey] = useState("");
  var [setupGroomName, setSetupGroomName] = useState("Miles");
  var [setupBestManName, setSetupBestManName] = useState("");
  var [setupCrewPin, setSetupCrewPin] = useState("");
  var [setupGroomPin, setSetupGroomPin] = useState("0711");

  var channelRef = useRef(null);

  // --- Online/Offline tracking + queue replay ---
  useEffect(function() {
    var goOnline = function() {
      setOnline(true);
      db.replayQueue();
    };
    var goOffline = function() { setOnline(false); };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return function() {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // --- Initial load ---
  useEffect(function() {
    var savedName = null;
    try { savedName = localStorage.getItem("wc:username"); } catch(e) {}
    var savedPin = null;
    try { savedPin = localStorage.getItem("wc:pin"); } catch(e) {}

    if (savedPin) sessionPin = savedPin;

    var init = async function() {
      var cfg = await db.get("config");
      if (!cfg || !cfg.initialized) {
        setConfig(cfg || DEFAULT_CONFIG);
        setLoginStep("setup");
        setLoading(false);
        return;
      }
      setConfig(cfg);

      var pay = await db.get("payments");
      setPayments(pay || {});
      var sts = await db.get("statuses");
      setStatuses(sts || {});

      if (savedName && cfg.crew) {
        var found = cfg.crew.find(function(c) {
          return c.name && c.name.toLowerCase() === savedName.toLowerCase();
        });
        if (found) {
          setUserName(found.name);
          setUserRole(found.role);
          var uc = await db.get("checks:" + found.name);
          setChecks(uc || {});
          var pc = await db.get("pack:" + found.name);
          setPackChecks(pc || {});
        }
      }
      setLoading(false);
      // Replay any queued mutations from previous sessions
      db.replayQueue();
    };
    init();
  }, []);

  // --- Realtime subscriptions (read-only, via anon key) ---
  useEffect(function() {
    if (!realtimeClient || !userName) return;

    var channel = realtimeClient
      .channel("docs-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, function(payload) {
        var row = payload.new;
        if (!row || !row.id) return;
        if (row.id === "config") setConfig(row.data);
        else if (row.id === "payments") setPayments(row.data);
        else if (row.id === "statuses") setStatuses(row.data);
      })
      .subscribe();

    channelRef.current = channel;
    return function() {
      if (channelRef.current) realtimeClient.removeChannel(channelRef.current);
    };
  }, [userName]);

  // --- Timers ---
  useEffect(function() {
    if (!timerOn) return;
    var id = setInterval(function() { setSpeechTimer(function(t) { return t + 1; }); }, 1000);
    return function() { clearInterval(id); };
  }, [timerOn]);

  useEffect(function() {
    if (userRole !== "groom") return;
    var id = setInterval(function() { setHypeIndex(function(i) { return (i + 1) % HYPE_MESSAGES.length; }); }, 10000);
    return function() { clearInterval(id); };
  }, [userRole]);

  // =========================================================================
  // SETUP HANDLER (server-side validation)
  // =========================================================================
  var handleSetup = async function() {
    if (!setupBestManName.trim()) { setLoginError("Enter the best man name."); return; }
    var newConfig = {
      initialized: true,
      crew: [
        { name: setupGroomName.trim(), role: "groom" },
        { name: setupBestManName.trim(), role: "bestman" },
        { name: "", role: "groomsman" },
        { name: "", role: "groomsman" },
        { name: "", role: "groomsman" },
        { name: "", role: "groomsman" },
      ],
      crew_pin: setupCrewPin,
      groom_pin: setupGroomPin || "0711",
      costs: DEFAULT_CONFIG.costs,
      guy_count: 6,
      venmo_handle: "",
      contacts: DEFAULT_CONFIG.contacts,
      timeline: DEFAULT_TIMELINE,
    };
    var result = await db.setup(setupKey, "config", newConfig);
    if (!result.ok) {
      setLoginError(result.error);
      return;
    }
    setConfig(newConfig);
    sessionPin = setupCrewPin;
    try { localStorage.setItem("wc:pin", setupCrewPin); } catch(e) {}
    setUserName(setupBestManName.trim());
    setUserRole("bestman");
    try { localStorage.setItem("wc:username", setupBestManName.trim()); } catch(e) {}
    setLoginStep("name");
    setLoginError("");
  };

  // =========================================================================
  // AUTH HANDLERS
  // =========================================================================
  var handleNameSubmit = function() {
    if (!loginInput.trim()) return;
    var name = loginInput.trim();
    var cfg = config || DEFAULT_CONFIG;
    var found = (cfg.crew || []).find(function(c) {
      return c.name && c.name.toLowerCase() === name.toLowerCase();
    });
    if (!found) { setLoginError("Name not found. Ask the best man to add you."); return; }
    if (found.role === "groom") { setLoginStep("groom_pin"); setLoginError(""); setPinInput(""); return; }
    if (cfg.crew_pin) { setLoginStep("pin"); setLoginError(""); setPinInput(""); }
    else { finishLogin(found, ""); }
  };

  var handlePinSubmit = async function() {
    var cfg = config || DEFAULT_CONFIG;
    if (loginStep === "groom_pin") {
      if (pinInput === (cfg.groom_pin || "0711")) {
        var groom = (cfg.crew || []).find(function(c) { return c.role === "groom"; });
        if (groom) finishLogin(groom, pinInput);
      } else { setLoginError("Wrong password."); }
    } else if (loginStep === "pin") {
      if (pinInput === cfg.crew_pin) {
        var found = (cfg.crew || []).find(function(c) {
          return c.name && c.name.toLowerCase() === loginInput.trim().toLowerCase();
        });
        if (found) finishLogin(found, pinInput);
      } else { setLoginError("Wrong crew PIN."); }
    }
  };

  var finishLogin = async function(member, pin) {
    sessionPin = pin;
    try { localStorage.setItem("wc:pin", pin); } catch(e) {}
    setUserName(member.name);
    setUserRole(member.role);
    try { localStorage.setItem("wc:username", member.name); } catch(e) {}
    var uc = await db.get("checks:" + member.name);
    setChecks(uc || {});
    var pc = await db.get("pack:" + member.name);
    setPackChecks(pc || {});
    setLoginStep("name");
    setLoginError("");
    setPinInput("");
  };

  var logout = function() {
    sessionPin = "";
    setUserName(null); setUserRole(null); setLoginInput(""); setPinInput("");
    setLoginStep("name"); setChecks({}); setPackChecks({}); setTab("home");
    try { localStorage.removeItem("wc:username"); localStorage.removeItem("wc:pin"); } catch(e) {}
  };

  // =========================================================================
  // DATA HANDLERS
  // =========================================================================
  var saveConfig = async function(c) { setConfig(c); await db.set("config", c); };
  var toggleCheck = async function(id) {
    var n = {}; for (var k in checks) n[k] = checks[k]; n[id] = !checks[id];
    setChecks(n); await db.set("checks:" + userName, n);
  };
  var togglePack = async function(i) {
    var key = "p" + i; var n = {}; for (var k in packChecks) n[k] = packChecks[k]; n[key] = !packChecks[key];
    setPackChecks(n); await db.set("pack:" + userName, n);
  };
  var markPaid = async function(name, paid) {
    var n = {}; for (var k in payments) n[k] = payments[k]; n[name] = { paid: paid, date: todayISO() };
    setPayments(n); await db.set("payments", n);
  };
  var updateStatus = async function(status) {
    var n = {}; for (var k in statuses) n[k] = statuses[k];
    n[userName] = { status: status, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) };
    setStatuses(n); await db.set("statuses", n);
  };

  // =========================================================================
  // LOADING
  // =========================================================================
  if (loading) {
    return <div style={{ minHeight: "100vh", background: "#1a1714", color: "#c9a96e", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Georgia, serif" }}>Loading...</div>;
  }

  // =========================================================================
  // SETUP SCREEN
  // =========================================================================
  if (loginStep === "setup" || (config && !config.initialized)) {
    return (
      <div style={{ minHeight: "100vh", background: "#1a1714", color: "#e8e0d4", fontFamily: "Georgia, serif", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "30px" }}>
        <h1 style={{ color: "#c9a96e", marginBottom: "8px", fontSize: "1.5em" }}>Wedding Crew</h1>
        <p style={{ color: "#a89b8c", marginBottom: "24px", maxWidth: "300px", textAlign: "center", lineHeight: "1.5", fontSize: "0.9em" }}>First-time setup. Only the person who deployed this app should complete this.</p>
        <div style={{ width: "280px" }}>
          <label style={labelStyle}>Setup key</label>
          <input type="password" value={setupKey} onChange={function(e) { setSetupKey(e.target.value); setLoginError(""); }} placeholder="From your Vercel env vars" style={inputStyle} />
          <label style={{ ...labelStyle, marginTop: "12px" }}>Groom name</label>
          <input type="text" value={setupGroomName} onChange={function(e) { setSetupGroomName(e.target.value); }} style={inputStyle} />
          <label style={{ ...labelStyle, marginTop: "12px" }}>Your name (Best Man)</label>
          <input type="text" value={setupBestManName} onChange={function(e) { setSetupBestManName(e.target.value); setLoginError(""); }} placeholder="First + last initial" style={inputStyle} />
          <label style={{ ...labelStyle, marginTop: "12px" }}>Crew PIN (4 digits)</label>
          <input type="text" value={setupCrewPin} onChange={function(e) { setSetupCrewPin(e.target.value); }} placeholder="e.g. 7110" style={inputStyle} />
          <label style={{ ...labelStyle, marginTop: "12px" }}>Groom password</label>
          <input type="text" value={setupGroomPin} onChange={function(e) { setSetupGroomPin(e.target.value); }} style={inputStyle} />
          <button onClick={handleSetup} style={{ ...goldBtnStyle, marginTop: "16px" }}>Initialize App</button>
          {loginError && <p style={{ color: "#E53935", marginTop: "10px", fontSize: "0.85em", textAlign: "center" }}>{loginError}</p>}
        </div>
      </div>
    );
  }

  // =========================================================================
  // LOGIN SCREEN
  // =========================================================================
  if (!userName) {
    var title = loginStep === "name" ? "Enter your name" : loginStep === "pin" ? "Enter the crew PIN" : "Enter groom password";
    var ph = loginStep === "name" ? "First name + last initial" : loginStep === "groom_pin" ? "Password" : "Crew PIN";
    return (
      <div style={{ minHeight: "100vh", background: "#1a1714", color: "#e8e0d4", fontFamily: "Georgia, serif", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "30px", textAlign: "center" }}>
        <h1 style={{ color: "#c9a96e", marginBottom: "8px", fontSize: "1.6em" }}>Wedding Crew</h1>
        {!online && <div style={{ color: "#F9A825", fontSize: "0.8em", marginBottom: "8px", display: "flex", alignItems: "center", gap: "4px", justifyContent: "center" }}><WifiOff size={14} /> Offline -- using cached data</div>}
        <p style={{ color: "#a89b8c", marginBottom: "30px", maxWidth: "300px", lineHeight: "1.5" }}>{title}</p>
        <div style={{ width: "260px" }}>
          {loginStep === "name" && (
            <input type="text" value={loginInput} onChange={function(e) { setLoginInput(e.target.value); setLoginError(""); }}
              onKeyDown={function(e) { if (e.key === "Enter") handleNameSubmit(); }} placeholder={ph} style={{ ...inputStyle, textAlign: "center" }} />
          )}
          {(loginStep === "pin" || loginStep === "groom_pin") && (
            <input type="password" value={pinInput} onChange={function(e) { setPinInput(e.target.value); setLoginError(""); }}
              onKeyDown={function(e) { if (e.key === "Enter") handlePinSubmit(); }} placeholder={ph} style={{ ...inputStyle, textAlign: "center" }} />
          )}
          <button onClick={loginStep === "name" ? handleNameSubmit : handlePinSubmit} style={{ ...goldBtnStyle, marginTop: "12px" }}>Continue</button>
          {loginStep !== "name" && (
            <button onClick={function() { setLoginStep("name"); setPinInput(""); setLoginError(""); }}
              style={{ background: "none", border: "none", color: "#a89b8c", cursor: "pointer", fontSize: "0.85em", fontFamily: "Georgia, serif", marginTop: "8px" }}>Back</button>
          )}
          {loginError && <p style={{ color: "#E53935", marginTop: "12px", fontSize: "0.9em" }}>{loginError}</p>}
        </div>
      </div>
    );
  }

  // =========================================================================
  // COMPUTED VALUES
  // =========================================================================
  var myTasks = TASKS.filter(function(t) { return t.roles.indexOf(userRole) >= 0; });
  myTasks.sort(function(a, b) { return new Date(a.date).getTime() - new Date(b.date).getTime(); });
  var completedCount = myTasks.filter(function(t) { return checks[t.id]; }).length;
  var thisWeekTasks = myTasks.filter(function(t) { return !checks[t.id] && (isDueThisWeek(t.date) || urgency(t.date) === "overdue"); });
  var laterTasks = myTasks.filter(function(t) { return !checks[t.id] && !isDueThisWeek(t.date) && urgency(t.date) !== "overdue"; });
  var doneTasks = myTasks.filter(function(t) { return !!checks[t.id]; });
  var upcoming = myTasks.filter(function(t) { return !checks[t.id]; }).slice(0, 3);

  var costs = (config && config.costs) || [];
  var guyCount = (config && config.guy_count) || 6;
  var subtotal = costs.reduce(function(s, i) { return s + safeNum(i.amount, 0); }, 0);
  var buffer = Math.round(subtotal * 0.15);
  var totalCost = (subtotal + buffer) * guyCount;
  var perPerson = guyCount > 1 ? Math.ceil(totalCost / (guyCount - 1)) : 0;
  var wLeft = weeksUntil(BACHELOR_DATE);
  var weekly = wLeft > 0 ? Math.ceil(perPerson / wLeft) : perPerson;
  var venmoHandle = (config && config.venmo_handle) || "";
  var venmoLink = venmoHandle ? "https://venmo.com/" + venmoHandle + "?txn=pay&amount=" + perPerson + "&note=Bach%20Party" : "";
  var crewNonGroom = ((config && config.crew) || []).filter(function(c) { return c.role !== "groom" && c.name; });
  var paidCount = 0;
  crewNonGroom.forEach(function(c) { if (payments[c.name] && payments[c.name].paid) paidCount++; });
  var isWeddingDay = todayISO() === "2026-07-11";
  var isBachDay = todayISO() === "2026-07-10";
  var queueLen = loadQueue().length;

  var S = {
    card: { background: "rgba(255,255,255,0.03)", padding: "14px", borderRadius: "8px", marginBottom: "10px" },
    gold: { color: "#c9a96e" }, muted: { color: "#a89b8c", fontSize: "0.85em" },
    btn: { padding: "10px 16px", background: "#2a2724", border: "1px solid #3d3a37", borderRadius: "6px", color: "#a89b8c", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: "0.85em" },
    goldBtn: { padding: "12px 16px", background: "rgba(201,169,110,0.12)", border: "1px solid #c9a96e", borderRadius: "8px", color: "#c9a96e", cursor: "pointer", fontFamily: "Georgia, serif", fontSize: "0.9em", width: "100%" },
  };

  var copyText = function(text, label) { navigator.clipboard.writeText(text).then(function() { setMsgCopied(label); setTimeout(function() { setMsgCopied(""); }, 2000); }); };
  var smsLink = function(name, msg) { return "sms:&body=" + encodeURIComponent(msg); };

  var makeMessages = function() {
    return [
      { label: "Bachelor Party Announcement", text: "Hey team! Here is the plan for Miles bachelor party:\n\nDate: July 10, 2026\nLocation: Chicago\nPer person cost: " + fmt(perPerson) + " (Miles pays $0)\nWeekly payment: " + fmt(weekly) + "/week for " + wLeft + " weeks\n\n" + (venmoLink ? "Venmo: " + venmoLink + "\n\n" : "") + "Check the app for your full checklist." },
      { label: "Payment Reminder", text: "Quick reminder -- bachelor party contributions are due soon.\n" + paidCount + " of " + crewNonGroom.length + " guys have paid so far.\nAmount: " + fmt(perPerson) + "\n" + (venmoLink ? "Venmo: " + venmoLink : "") },
      { label: "Suit/Attire Reminder", text: "Hey team -- make sure you have your suit or tux fitted and picked up. Try on the full outfit at least a week before. Do NOT wait until the day of." },
      { label: "Travel Reminder", text: "Reminder to book travel and hotel for the wedding weekend in Chicago.\nBachelor party: July 10\nWedding: July 11\nAsk about the wedding room block for a discount." },
      { label: "Week-Of Heads Up", text: "Wedding week! Bachelor party: July 10. Wedding: July 11. Have your outfit ready. Check the app for your packing list. See you in Chicago." },
    ];
  };

  var renderTask = function(t) {
    var u = urgency(t.date); var done = !!checks[t.id];
    return (
      <div key={t.id} style={{ ...S.card, borderLeft: "4px solid " + (catColors[t.cat] || "#555"), display: "flex", alignItems: "flex-start", gap: "12px", borderRight: urgColors[u] !== "transparent" ? "3px solid " + urgColors[u] : "none" }}>
        <input type="checkbox" checked={done} onChange={function() { toggleCheck(t.id); }} style={{ marginTop: "2px" }} />
        <div style={{ flex: 1, opacity: done ? 0.35 : 1, textDecoration: done ? "line-through" : "none" }}>
          <div style={{ fontSize: "0.8em", color: urgColors[u] !== "transparent" ? urgColors[u] : "#a89b8c", marginBottom: "2px" }}>{u === "overdue" ? "OVERDUE -- " : ""}{t.by}</div>
          <div style={{ fontSize: "0.9em" }}>{t.task}</div>
        </div>
        {!done && <button onClick={function() { downloadICS([{ title: t.task, date: t.date }], "reminder.ics"); }} style={{ background: "none", border: "none", color: "#a89b8c", cursor: "pointer", padding: "4px", flexShrink: 0 }}><Calendar size={16} /></button>}
      </div>
    );
  };

  // =========================================================================
  // RENDER (same UI as v4, all data flows through serverless function now)
  // =========================================================================
  return (
    <div style={{ minHeight: "100vh", background: "#1a1714", color: "#e8e0d4", fontFamily: "Georgia, serif", paddingTop: "max(12px, env(safe-area-inset-top))", paddingBottom: "80px" }}>
      <style>{
        "input[type=number]{background:#2a2724;border:1px solid #3d3a37;color:white;padding:8px;border-radius:4px;width:72px;font-size:1em;font-family:Georgia,serif}" +
        " input[type=text],input[type=password],input[type=tel]{background:#2a2724;border:1px solid #3d3a37;color:white;padding:8px;border-radius:4px;font-size:1em;font-family:Georgia,serif;width:100%}" +
        " input[type=checkbox]{width:20px;height:20px;flex-shrink:0;accent-color:#c9a96e;cursor:pointer}" +
        " button{font-family:Georgia,serif}" +
        " @keyframes confetti{0%{transform:translateY(-10vh) rotate(0deg);opacity:1}100%{transform:translateY(100vh) rotate(720deg);opacity:0}}"
      }</style>

      {showCelebration && <div style={{ position: "fixed", inset: 0, zIndex: 200, pointerEvents: "none", overflow: "hidden" }}>
        {Array.from({ length: 40 }).map(function(_, i) {
          var colors = ["#c9a96e", "#E91E63", "#F9A825", "#43A047", "#1E88E5", "#8E24AA"];
          return <div key={i} style={{ position: "absolute", left: (Math.random() * 100) + "%", top: "-5%", width: "10px", height: "10px", borderRadius: Math.random() > 0.5 ? "50%" : "2px", background: colors[i % colors.length], animation: "confetti " + (2 + Math.random() * 3) + "s ease-out " + (Math.random() * 2) + "s forwards" }} />;
        })}
      </div>}

      <div style={{ maxWidth: "600px", margin: "0 auto", padding: "0 16px" }}>
        <header style={{ textAlign: "center", paddingTop: "8px", marginBottom: "16px" }}>
          {userRole === "groom" && isWeddingDay && <div style={{ ...S.card, background: "rgba(201,169,110,0.1)", borderLeft: "3px solid #c9a96e", textAlign: "left", marginBottom: "12px", fontSize: "0.9em", fontStyle: "italic", lineHeight: "1.5" }}>{HYPE_MESSAGES[hypeIndex]}</div>}
          <h1 style={{ ...S.gold, fontSize: "1.4em", margin: "0 0 4px 0" }}>Wedding Crew</h1>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
            <button onClick={logout} style={{ background: "none", border: "1px solid #3d3a37", color: "#a89b8c", padding: "3px 10px", borderRadius: "12px", fontSize: "0.75em", cursor: "pointer" }}>
              {userName} -- sign out
            </button>
            {!online && <WifiOff size={12} color="#F9A825" />}
            {queueLen > 0 && <span style={{ fontSize: "0.7em", color: "#F9A825" }}>{queueLen} pending</span>}
          </div>
        </header>

        {/* HOME */}
        {tab === "home" && <div>
          {(isBachDay || isWeddingDay) && <div style={{ ...S.card, background: isBachDay ? "rgba(201,169,110,0.15)" : "rgba(233,30,99,0.1)", border: "1px solid " + (isBachDay ? "#c9a96e" : "#E91E63"), textAlign: "center", marginBottom: "16px" }}>
            <div style={{ fontSize: "1.2em", fontWeight: "bold", color: isBachDay ? "#c9a96e" : "#E91E63" }}>{isBachDay ? "BACHELOR PARTY DAY" : "WEDDING DAY"}</div>
            <div style={S.muted}>Check the Plan tab for day-of features</div>
          </div>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "16px" }}>
            <div style={{ ...S.card, textAlign: "center" }}><div style={{ ...S.gold, fontSize: "2em", fontWeight: "bold" }}>{daysUntil(BACHELOR_DATE)}</div><div style={S.muted}>days to bach party</div></div>
            <div style={{ ...S.card, textAlign: "center" }}><div style={{ ...S.gold, fontSize: "2em", fontWeight: "bold" }}>{daysUntil(WEDDING_DATE)}</div><div style={S.muted}>days to wedding</div></div>
          </div>
          <div style={{ ...S.card, marginBottom: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}><span style={{ fontSize: "0.9em" }}>Your progress</span><span style={S.muted}>{completedCount} / {myTasks.length}</span></div>
            <div style={{ height: "6px", background: "#2a2724", borderRadius: "3px", overflow: "hidden" }}><div style={{ height: "100%", width: (myTasks.length > 0 ? (completedCount / myTasks.length * 100) : 0) + "%", background: "#c9a96e", borderRadius: "3px", transition: "width 0.3s" }} /></div>
          </div>
          <h3 style={{ ...S.gold, fontSize: "1em", marginBottom: "10px" }}>Next up</h3>
          {upcoming.length === 0 && <p style={S.muted}>All caught up.</p>}
          {upcoming.map(function(t) { var u = urgency(t.date); return <div key={t.id} style={{ ...S.card, borderLeft: "4px solid " + (catColors[t.cat] || "#555"), display: "flex", alignItems: "center", gap: "12px" }}>
            {u === "overdue" && <AlertTriangle size={16} color={urgColors.overdue} />}{u === "urgent" && <Clock size={16} color={urgColors.urgent} />}
            <div style={{ flex: 1 }}><div style={{ fontSize: "0.8em", color: urgColors[u] !== "transparent" ? urgColors[u] : "#a89b8c" }}>{u === "overdue" ? "OVERDUE -- " : ""}{t.by}</div><div style={{ fontSize: "0.9em" }}>{t.task}</div></div>
          </div>; })}
          <div style={{ marginTop: "16px" }}><button onClick={function() { var evts = myTasks.filter(function(t) { return !checks[t.id]; }).map(function(t) { return { title: t.task, date: t.date }; }); if (evts.length > 0) downloadICS(evts, "wedding-crew.ics"); }} style={{ ...S.goldBtn, display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}><Download size={16} /> Add all deadlines to calendar</button></div>
          {userRole === "bestman" && <div style={{ ...S.card, marginTop: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><div style={{ fontSize: "0.9em" }}>Payments received</div><div style={S.muted}>{paidCount} of {crewNonGroom.length}</div></div><div style={{ ...S.gold, fontSize: "1.2em", fontWeight: "bold" }}>{fmt(paidCount * perPerson)}</div></div>}
        </div>}

        {/* TASKS (phased for groom) */}
        {tab === "tasks" && <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}><h2 style={{ ...S.gold, fontSize: "1.1em", margin: 0 }}>Your Checklist</h2><span style={S.muted}>{completedCount}/{myTasks.length}</span></div>
          {thisWeekTasks.length > 0 && <div style={{ marginBottom: "8px" }}><div style={{ fontSize: "0.8em", color: "#F9A825", marginBottom: "6px", fontWeight: "bold" }}>{userRole === "groom" ? "FOCUS: This Week" : "Due soon"}</div>{thisWeekTasks.map(renderTask)}</div>}
          {laterTasks.length > 0 && <div style={{ marginBottom: "8px" }}>
            {userRole === "groom" ? <div>
              <button onClick={function() { setShowUpcoming(!showUpcoming); }} style={{ ...S.btn, width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px" }}>
                <span>Coming up ({laterTasks.length} tasks)</span>{showUpcoming ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>{showUpcoming && laterTasks.map(renderTask)}
            </div> : <div><div style={{ fontSize: "0.8em", color: "#a89b8c", marginBottom: "6px" }}>Coming up</div>{laterTasks.map(renderTask)}</div>}
          </div>}
          {doneTasks.length > 0 && <div><div style={{ fontSize: "0.8em", color: "#43A047", marginBottom: "6px" }}>Completed ({doneTasks.length})</div>{doneTasks.map(renderTask)}</div>}
        </div>}

        {/* MONEY */}
        {tab === "money" && <div>
          <h2 style={{ ...S.gold, fontSize: "1.1em", marginBottom: "12px" }}>{userRole === "bestman" ? "Budget & Payments" : "Your Costs"}</h2>
          {userRole === "bestman" && <div>
            <div style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}><span>Total guys (incl. Miles):</span><input type="number" min="2" value={guyCount} onChange={function(e) { saveConfig(Object.assign({}, config, { guy_count: Math.max(2, safeNum(e.target.value, 2)) })); }} /></div>
            {costs.map(function(item, i) { return <div key={i} style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ flex: 1, fontSize: "0.9em" }}>{item.name}</span><div style={{ display: "flex", alignItems: "center", gap: "4px" }}><span style={{ color: "#a89b8c" }}>$</span><input type="number" min="0" value={item.amount} onChange={function(e) { var next = costs.slice(); next[i] = { name: item.name, amount: safeNum(e.target.value, 0) }; saveConfig(Object.assign({}, config, { costs: next })); }} /></div></div>; })}
            <div style={{ ...S.card, display: "flex", justifyContent: "space-between", color: "#a89b8c", fontStyle: "italic" }}><span style={{ fontSize: "0.9em" }}>Tips + buffer (15%)</span><span>{fmt(buffer)} / person</span></div>
          </div>}
          <div style={{ background: "#c9a96e", color: "#1a1714", padding: "20px", borderRadius: "8px", textAlign: "center", margin: "12px 0 16px 0" }}>
            <h2 style={{ marginBottom: "4px" }}>{fmt(perPerson)} / person</h2><p style={{ fontSize: "0.9em", marginBottom: "4px" }}>(Miles pays $0 -- split among {guyCount - 1})</p><p style={{ fontSize: "0.85em", opacity: 0.8 }}>{fmt(weekly)} per week x {wLeft} weeks</p>
            {userRole === "bestman" && <p style={{ fontSize: "0.8em", opacity: 0.6, marginTop: "8px", borderTop: "1px solid rgba(0,0,0,0.15)", paddingTop: "8px" }}>Total: {fmt(totalCost)}</p>}
          </div>
          {userRole === "bestman" && <div style={{ ...S.card, marginBottom: "16px" }}>
            <div style={{ ...S.gold, fontSize: "0.9em", marginBottom: "8px" }}>Venmo Setup</div>
            <div style={{ display: "flex", gap: "4px", alignItems: "center", marginBottom: "8px" }}><span style={{ color: "#a89b8c" }}>@</span><input type="text" value={venmoHandle} placeholder="your-venmo-handle" onChange={function(e) { saveConfig(Object.assign({}, config, { venmo_handle: e.target.value.replace(/\s/g, "") })); }} /></div>
            {venmoLink && <button onClick={function() { copyText(venmoLink, "venmo"); }} style={{ ...S.goldBtn, display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}><Copy size={16} /> {msgCopied === "venmo" ? "Copied!" : "Copy Venmo link for group"}</button>}
          </div>}
          {userRole !== "bestman" && userRole !== "groom" && venmoLink && <a href={venmoLink} target="_blank" rel="noopener noreferrer" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "6px", padding: "14px", background: "#3D95CE", color: "white", borderRadius: "8px", textDecoration: "none", fontSize: "0.95em", marginBottom: "16px" }}><ExternalLink size={16} /> Pay via Venmo ({fmt(perPerson)})</a>}
          {userRole === "bestman" && <div>
            <div style={{ ...S.gold, fontSize: "0.9em", marginBottom: "10px" }}>Payment Tracker</div>
            <div style={{ ...S.muted, marginBottom: "10px" }}>Tap to toggle. Check Venmo to verify, then mark here.</div>
            {crewNonGroom.map(function(c) { var paid = payments[c.name] && payments[c.name].paid; return <div key={c.name} style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: "0.9em" }}>{c.name || "(unnamed)"}</span><button onClick={function() { markPaid(c.name, !paid); }} style={{ padding: "5px 12px", borderRadius: "12px", border: "none", background: paid ? "#43A047" : "#3d3a37", color: "white", fontSize: "0.8em", cursor: "pointer" }}>{paid ? "Paid" : "Unpaid"}</button></div>; })}
            <button onClick={function() { downloadICS([{ title: "Check Venmo for bach party payments", date: "2026-04-26" },{ title: "Check Venmo for bach party payments", date: "2026-05-10" },{ title: "Check Venmo for bach party payments", date: "2026-05-24" },{ title: "Check Venmo for bach party payments", date: "2026-06-07" },{ title: "Final bach party payments due -- check Venmo", date: "2026-06-22" }], "venmo-check-reminders.ics"); }} style={{ ...S.btn, width: "100%", marginTop: "8px", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}><Calendar size={14} /> Add bi-weekly Venmo check reminders</button>
          </div>}
          {userRole === "groomsman" && <div style={S.card}><div style={{ ...S.gold, fontSize: "0.9em", marginBottom: "8px" }}>Estimated total wedding spend</div><div style={{ fontSize: "0.85em", color: "#a89b8c", lineHeight: "1.8" }}>Bach party share: {fmt(perPerson)}<br />Suit or tux: ~$150-300<br />Travel: varies<br />Hotel (2 nights): ~$200-400<br />Wedding gift: ~$75-150<br />Meals and misc: ~$50-100</div></div>}
        </div>}

        {/* PLAN */}
        {tab === "plan" && <div>
          <div style={{ display: "flex", gap: "6px", marginBottom: "16px", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            {[{ id: "timeline", label: "Day-Of" },{ id: "packing", label: "Packing" },...(userRole === "bestman" ? [{ id: "speech", label: "Speech" }] : []),...(isBachDay ? [{ id: "bachfun", label: "Party" }] : []),...(isWeddingDay ? [{ id: "weddingfun", label: "Live" }] : [])].map(function(s) {
              return <button key={s.id} onClick={function() { setSubTab(s.id); }} style={{ ...S.btn, borderColor: subTab === s.id ? "#c9a96e" : "#3d3a37", color: subTab === s.id ? "#c9a96e" : "#a89b8c", background: subTab === s.id ? "rgba(201,169,110,0.12)" : "#2a2724", whiteSpace: "nowrap" }}>{s.label}</button>;
            })}
          </div>
          {subTab === "timeline" && <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}><h3 style={{ ...S.gold, fontSize: "1em", margin: 0 }}>Wedding Day Timeline</h3>{userRole === "bestman" && <button onClick={function() { setEditMode(!editMode); }} style={{ ...S.btn, fontSize: "0.75em" }}>{editMode ? "Done" : "Edit"}</button>}</div>
            {((config && config.timeline) || []).map(function(t, i) { if (t.who !== "all" && t.who !== userRole) return null; return <div key={i} style={{ ...S.card, display: "flex", gap: "12px", alignItems: "flex-start" }}>{editMode ? <div style={{ width: "100%", display: "flex", gap: "6px" }}><input type="text" value={t.time} style={{ width: "90px" }} onChange={function(e) { var tl = ((config && config.timeline) || []).slice(); tl[i] = Object.assign({}, tl[i], { time: e.target.value }); saveConfig(Object.assign({}, config, { timeline: tl })); }} /><input type="text" value={t.event} style={{ flex: 1 }} onChange={function(e) { var tl = ((config && config.timeline) || []).slice(); tl[i] = Object.assign({}, tl[i], { event: e.target.value }); saveConfig(Object.assign({}, config, { timeline: tl })); }} /></div> : <><div style={{ ...S.gold, fontSize: "0.85em", whiteSpace: "nowrap", minWidth: "72px" }}>{t.time}</div><div style={{ fontSize: "0.9em" }}>{t.event}</div></>}</div>; })}
          </div>}
          {subTab === "packing" && userRole && <div><h3 style={{ ...S.gold, fontSize: "1em", marginBottom: "10px" }}>Your Packing List</h3>
            {(PACKING[userRole] || []).map(function(item, i) { var done = !!packChecks["p" + i]; var isRings = item === "THE WEDDING RINGS"; return <div key={i} style={{ ...S.card, display: "flex", alignItems: "center", gap: "12px" }}><input type="checkbox" checked={done} onChange={function() { togglePack(i); }} /><span style={{ opacity: done ? 0.35 : 1, textDecoration: done ? "line-through" : "none", fontSize: "0.9em", color: isRings ? "#E53935" : "#e8e0d4", fontWeight: isRings ? "bold" : "normal" }}>{item}</span></div>; })}
          </div>}
          {subTab === "speech" && userRole === "bestman" && <div><h3 style={{ ...S.gold, fontSize: "1em", marginBottom: "10px" }}>Toast Tips</h3>
            {SPEECH_TIPS.map(function(tip, i) { return <div key={i} style={{ ...S.card, fontSize: "0.9em", lineHeight: "1.5" }}><span style={{ ...S.gold, marginRight: "8px" }}>{i + 1}.</span>{tip}</div>; })}
            <div style={{ ...S.card, textAlign: "center", marginTop: "8px" }}><div style={{ ...S.gold, fontSize: "0.9em", marginBottom: "8px" }}>Practice Timer</div><div style={{ fontSize: "2.5em", fontWeight: "bold", color: speechTimer > 300 ? "#E53935" : speechTimer > 240 ? "#F9A825" : "#e8e0d4", marginBottom: "8px" }}>{Math.floor(speechTimer / 60) + ":" + String(speechTimer % 60).padStart(2, "0")}</div><div style={{ ...S.muted, marginBottom: "12px" }}>{speechTimer <= 180 ? "Under 3 min -- keep going" : speechTimer <= 300 ? "Sweet spot (3-5 min)" : "Over 5 min -- time to trim"}</div><div style={{ display: "flex", gap: "8px", justifyContent: "center" }}><button onClick={function() { setTimerOn(!timerOn); }} style={{ padding: "10px 24px", background: timerOn ? "#E53935" : "#c9a96e", color: timerOn ? "white" : "#1a1714", border: "none", borderRadius: "6px", cursor: "pointer" }}>{timerOn ? "Stop" : "Start"}</button><button onClick={function() { setTimerOn(false); setSpeechTimer(0); }} style={S.btn}>Reset</button></div></div>
          </div>}
          {subTab === "bachfun" && <div>
            <h3 style={{ ...S.gold, fontSize: "1em", marginBottom: "10px" }}><Camera size={16} style={{ marginRight: "6px", verticalAlign: "middle" }} />Photo Challenge</h3>
            {photoIndex < 0 ? <button onClick={function() { setPhotoIndex(0); }} style={{ ...S.goldBtn, padding: "20px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}><Camera size={18} /> Draw first challenge</button>
            : <div><div style={{ ...S.card, background: "rgba(201,169,110,0.1)", border: "1px solid #c9a96e", textAlign: "center", padding: "24px", fontSize: "1.1em", lineHeight: "1.5" }}>{PHOTO_CHALLENGES[photoIndex % PHOTO_CHALLENGES.length]}</div><div style={{ textAlign: "center", ...S.muted, marginBottom: "8px" }}>{(photoIndex % PHOTO_CHALLENGES.length) + 1} of {PHOTO_CHALLENGES.length}</div><button onClick={function() { setPhotoIndex(photoIndex + 1); }} style={S.goldBtn}>{photoIndex + 1 >= PHOTO_CHALLENGES.length ? "Reshuffle deck" : "Next challenge"}</button></div>}
            <h3 style={{ ...S.gold, fontSize: "1em", margin: "24px 0 10px 0" }}>Crew Status</h3>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "12px" }}>{["On my way", "At the spot", "Having a blast", "Need a minute"].map(function(s) { var isMine = statuses[userName] && statuses[userName].status === s; return <button key={s} onClick={function() { updateStatus(s); }} style={{ ...S.btn, borderColor: isMine ? "#c9a96e" : "#3d3a37", color: isMine ? "#c9a96e" : "#a89b8c", fontSize: "0.8em" }}>{s}</button>; })}</div>
            {Object.keys(statuses).map(function(name) { return <div key={name} style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: "0.9em" }}>{name}</span><div style={{ display: "flex", alignItems: "center", gap: "8px" }}><span style={S.muted}>{statuses[name].status}</span>{userRole === "bestman" && name !== userName && <a href={smsLink(name, "Hey " + name + ", where are you? We are at the spot.")} style={{ color: "#c9a96e", padding: "4px" }}><MessageCircle size={16} /></a>}</div></div>; })}
          </div>}
          {subTab === "weddingfun" && <div>
            <h3 style={{ ...S.gold, fontSize: "1em", marginBottom: "10px" }}><Sparkles size={16} style={{ marginRight: "6px", verticalAlign: "middle" }} />Wedding Day Live</h3>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "12px" }}>{["Waking up", "Getting ready", "Dressed", "At venue", "In position"].map(function(s) { var isMine = statuses[userName] && statuses[userName].status === s; return <button key={s} onClick={function() { updateStatus(s); }} style={{ ...S.btn, borderColor: isMine ? "#c9a96e" : "#3d3a37", color: isMine ? "#c9a96e" : "#a89b8c", fontSize: "0.8em" }}>{s}</button>; })}</div>
            {Object.keys(statuses).map(function(name) { return <div key={name} style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: "0.9em" }}>{name}</span><div style={{ display: "flex", alignItems: "center", gap: "8px" }}><span style={S.muted}>{statuses[name].status}</span>{userRole === "bestman" && name !== userName && <a href={smsLink(name, "Hey " + name + ", we need you at the venue. Where are you?")} style={{ color: "#c9a96e", padding: "4px" }}><MessageCircle size={16} /></a>}</div></div>; })}
            <button onClick={function() { setShowCelebration(true); setTimeout(function() { setShowCelebration(false); }, 5000); }} style={{ ...S.goldBtn, marginTop: "16px", display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", background: "rgba(233,30,99,0.12)", borderColor: "#E91E63", color: "#E91E63" }}><Sparkles size={16} /> CELEBRATE</button>
          </div>}
        </div>}

        {/* CREW */}
        {tab === "crew" && <div>
          <h2 style={{ ...S.gold, fontSize: "1.1em", marginBottom: "12px" }}>The Crew</h2>
          {userRole === "bestman" && <div style={{ marginBottom: "20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}><h3 style={{ ...S.gold, fontSize: "0.95em", margin: 0 }}>Roster</h3><span style={S.muted}>Names control login</span></div>
            {((config && config.crew) || []).map(function(c, i) { return <div key={i} style={{ ...S.card, display: "flex", alignItems: "center", gap: "8px" }}>
              <input type="text" value={c.name} placeholder={c.role === "groom" ? "Groom" : c.role === "bestman" ? "Best man" : "First + last initial"} onChange={function(e) { var crew = ((config && config.crew) || []).slice(); crew[i] = Object.assign({}, crew[i], { name: e.target.value }); saveConfig(Object.assign({}, config, { crew: crew })); }} style={{ flex: 1 }} />
              <span style={{ ...S.muted, whiteSpace: "nowrap" }}>{c.role === "groom" ? "Groom" : c.role === "bestman" ? "Best Man" : "Groomsman"}</span>
              {c.role === "groomsman" && <button onClick={function() { var crew = ((config && config.crew) || []).slice(); crew.splice(i, 1); saveConfig(Object.assign({}, config, { crew: crew })); }} style={{ background: "none", border: "none", color: "#5a5550", cursor: "pointer", padding: "4px" }}><X size={14} /></button>}
            </div>; })}
            <button onClick={function() { var crew = ((config && config.crew) || []).slice(); crew.push({ name: "", role: "groomsman" }); saveConfig(Object.assign({}, config, { crew: crew })); }} style={{ ...S.btn, width: "100%", marginTop: "4px" }}>+ Add groomsman</button>
            <div style={{ ...S.card, marginTop: "12px" }}><div style={{ ...S.gold, fontSize: "0.85em", marginBottom: "6px" }}>Crew PIN</div><input type="text" value={(config && config.crew_pin) || ""} placeholder="e.g. 7110" onChange={function(e) { saveConfig(Object.assign({}, config, { crew_pin: e.target.value })); }} style={{ width: "120px" }} /></div>
            <div style={{ ...S.card, marginTop: "4px" }}><div style={{ ...S.gold, fontSize: "0.85em", marginBottom: "6px" }}>Groom password</div><input type="text" value={(config && config.groom_pin) || ""} placeholder="0711" onChange={function(e) { saveConfig(Object.assign({}, config, { groom_pin: e.target.value })); }} style={{ width: "120px" }} /></div>
          </div>}
          <div style={{ marginBottom: "20px" }}><h3 style={{ ...S.gold, fontSize: "0.95em", marginBottom: "10px" }}><Phone size={14} style={{ marginRight: "6px", verticalAlign: "middle" }} />Key Contacts</h3>
            {((config && config.contacts) || []).map(function(c, i) {
              if (userRole === "bestman") return <div key={i} style={S.card}><div style={{ fontSize: "0.8em", color: "#a89b8c", marginBottom: "4px" }}>{c.role}</div><div style={{ display: "flex", gap: "6px" }}><input type="text" value={c.name} placeholder="Name" onChange={function(e) { var contacts = ((config && config.contacts) || []).slice(); contacts[i] = Object.assign({}, contacts[i], { name: e.target.value }); saveConfig(Object.assign({}, config, { contacts: contacts })); }} style={{ flex: 1 }} /><input type="tel" value={c.phone} placeholder="Phone" onChange={function(e) { var contacts = ((config && config.contacts) || []).slice(); contacts[i] = Object.assign({}, contacts[i], { phone: e.target.value }); saveConfig(Object.assign({}, config, { contacts: contacts })); }} style={{ width: "120px" }} /></div></div>;
              if (!c.name) return null;
              return <div key={i} style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center" }}><div><div style={{ fontSize: "0.8em", color: "#a89b8c" }}>{c.role}</div><div style={{ fontSize: "0.9em" }}>{c.name}</div></div>{c.phone && <a href={"tel:" + c.phone} style={{ color: "#c9a96e", padding: "8px" }}><Phone size={18} /></a>}</div>;
            })}
          </div>
          {userRole === "bestman" && <div><h3 style={{ ...S.gold, fontSize: "0.95em", marginBottom: "10px" }}><Send size={14} style={{ marginRight: "6px", verticalAlign: "middle" }} />Message Templates</h3><p style={{ ...S.muted, marginBottom: "10px" }}>Pre-written with real numbers. Tap to copy, paste into group chat.</p>
            {makeMessages().map(function(msg) { return <div key={msg.label} style={S.card}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: "0.9em" }}>{msg.label}</span><button onClick={function() { copyText(msg.text, msg.label); }} style={{ ...S.btn, fontSize: "0.75em", display: "flex", alignItems: "center", gap: "4px" }}><Copy size={12} /> {msgCopied === msg.label ? "Copied!" : "Copy"}</button></div></div>; })}
          </div>}
          {userRole !== "bestman" && <div><h3 style={{ ...S.gold, fontSize: "0.95em", marginBottom: "10px" }}>Your Crew</h3>
            {((config && config.crew) || []).filter(function(c) { return c.name; }).map(function(c, i) { return <div key={i} style={{ ...S.card, display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: "0.9em" }}>{c.name}</span><span style={S.muted}>{c.role === "groom" ? "Groom" : c.role === "bestman" ? "Best Man" : "Groomsman"}</span></div>; })}
          </div>}
        </div>}
      </div>

      {/* BOTTOM NAV */}
      <nav style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#1a1714", borderTop: "1px solid #2a2724", display: "flex", justifyContent: "space-around", paddingTop: "8px", paddingBottom: "max(8px, env(safe-area-inset-bottom))", zIndex: 100 }}>
        {[{ id: "home", icon: Home, label: "Home" },{ id: "tasks", icon: CheckSquare, label: "Tasks" },{ id: "money", icon: DollarSign, label: "Money" },{ id: "plan", icon: CalendarDays, label: "Plan" },{ id: "crew", icon: Users, label: "Crew" }].map(function(t) {
          var Icon = t.icon; var active = tab === t.id;
          return <button key={t.id} onClick={function() { setTab(t.id); }} style={{ background: "none", border: "none", color: active ? "#c9a96e" : "#5a5550", display: "flex", flexDirection: "column", alignItems: "center", gap: "2px", cursor: "pointer", padding: "4px 12px", minWidth: "52px" }}><Icon size={20} /><span style={{ fontSize: "0.65em" }}>{t.label}</span></button>;
        })}
      </nav>
    </div>
  );
}

// Shared styles
var inputStyle = { width: "100%", padding: "12px", background: "#2a2724", border: "1px solid #3d3a37", borderRadius: "8px", color: "white", fontSize: "1em", fontFamily: "Georgia, serif", marginBottom: "4px" };
var labelStyle = { fontSize: "0.8em", color: "#a89b8c", display: "block", marginBottom: "4px" };
var goldBtnStyle = { width: "100%", padding: "14px", background: "rgba(201,169,110,0.15)", border: "1px solid #c9a96e", borderRadius: "8px", color: "#c9a96e", fontSize: "1em", fontFamily: "Georgia, serif", cursor: "pointer" };
