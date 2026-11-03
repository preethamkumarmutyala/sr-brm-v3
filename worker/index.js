// SR BRM API - Cloudflare Worker
//   GET /calendar       your club's rides from the Audax calendars (2025, 2026, 2027), with the event id when the ride has a page
//   GET /ev/:id         one event page: details, ride name, riders, route-map link, route-card ids
//   GET /rt/:id         official route card (View route): controls + cue sheet
//   GET /event/:dist and /route/:dist   old addresses for this week's 200/300/400/600 (kept so nothing breaks)
//   GET /crossings/:id   control times recorded by the team (public, read only)
//   /team/...            account sign-in, user administration, control times and live positions
//   /track               receives locations from the Traccar Client app (only kept for registered riders during their ride)
// Team features need a D1 database, Gmail app-password secret and configured first-admin email.

import { connect } from "cloudflare:sockets";

const SOURCE = "https://www.audaxindia.in";
const CLUB = "Secunderabad Randonneurs";
const CALENDAR_HOME = `${SOURCE}/events.php`;   // Audax's current-year calendar; it also links to the other years
const YEARS_BACK = 1;                          // past seasons to include before the current one (1 = last year; raise it to go further back)
const YEARS_AHEAD = 1;                         // upcoming rides: this many years after the current one
const LEGACY = { "600": "10047", "200": "10048", "300": "10049", "400": "10050" };
const TEST_RIDE_ID = "999999";
const TEST_AIR = "0949";

function virtualTestEvent() {
  const now = new Date(Date.now() - 10 * 60e3 + 5.5 * 3600e3);
  const date = now.toISOString().slice(0, 10), [year, month, day] = date.split("-");
  const startTime = now.toISOString().slice(11, 16);
  const monthName = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(month) - 1];
  return {
    id: TEST_RIDE_ID, year: Number(year), month: Number(month), day: Number(day), date,
    distance: "24.64", title: `Staging home–college–home GPS test on ${Number(day)}-${monthName}-${year}`,
    rideName: "Preetham's staging home–college–home test", registrationClose: "", startTime,
    startLocation: "Private staging test start", routeMap: "", calendarId: TEST_RIDE_ID, routeId: "",
    riderCount: 1, riders: [{ seq: "1", name: "Preetham Kumar", air: TEST_AIR, fee: "", medal: "", result: "", club: "Staging" }],
    fetchedAt: new Date().toISOString()
  };
}

function virtualTestRoute() {
  const controls = [
    { no: 1, km: "0.00", location: "Private staging test start", type: "START POINT", open: "", close: "" },
    { no: 2, km: "12.12", location: "College of Fine Arts, JNAFA University (turnaround)", type: "CONTROL", open: "", close: "" },
    { no: 3, km: "24.64", location: "Private staging test finish", type: "END POINT", open: "", close: "" }
  ];
  return { id: TEST_RIDE_ID, info: { routeName: "Staging home–college–home", distance: "24.64" }, controls,
    cue: controls.map((c, i) => ({ no: i + 1, control: true, location: c.location, type: c.type,
      partial: i === 0 ? "0.00" : i === 1 ? "12.12" : "12.52", km: c.km, open: "", close: "" })),
    fetchedAt: new Date().toISOString() };
}

const CACHE_TTL = 300;          // event + riders: 5 minutes (older events: 6 hours)
const ROUTE_TTL = 1800;         // route card: 30 minutes
const CALENDAR_TTL = 1800;      // calendar: 30 minutes
const FETCH_TIMEOUT_MS = 8000;
const UA = "SR-BRM-Portal/4.0 (+https://sr-brm-v3.pages.dev)";
const MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// ---- parse start ----
function clean(text) {
  return String(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

// Reads the page Audax shows for "View route" (route-card.php)
function parseRouteCard(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "");
  const flat = clean(body);
  const pick = re => ((flat.match(re) || [])[1] || "").trim();
  const info = {
    routeName: pick(/Route Name:\s*(.*?)\s+Homologation/i),
    distance: pick(/Distance:\s*([\d.]+)\s*Km/i),
    brevet: pick(/Distance:\s*[\d.]+\s*Km\s*\(\s*(\d+)\s*Km\s*\)/i),
    date: pick(/Date:\s*(\d{1,2}-[A-Za-z]{3}-\d{4})/i),
    startingHour: pick(/Starting Hour:\s*(\d{1,2}:\d{2})/i),
    map: pick(/(https?:\/\/ridewithgps\.com\/routes\/\d+)/i)
  };

  // Every numbered row of the big table. The first columns are read from the left and the two formatted time columns
  // from the right, because the page also carries two extra (hidden) plain-time columns between TOTAL and the formatted ones:
  // # | C | LOCATION | REF No. (type) | Co.Ord. (manual/auto) | ROAD NUMBER | PARTIAL KM | TOTAL | [open | close] | OPEN | CLOSE
  const cue = [];
  for (const m of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cols = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(x => clean(x[1]));
    const n = cols.length;
    if (n < 10 || !/^\d+$/.test(cols[0])) continue;
    cue.push({
      no: Number(cols[0]),
      control: cols[1].toUpperCase() === "C",
      location: cols[2],
      type: cols[3],
      coord: cols[4],
      partial: cols[6],
      km: cols[7],
      open: cols[n - 2],
      close: cols[n - 1]
    });
  }

  const marked = cue.filter(r => r.control);
  const controls = marked.map((r, i) => ({
    no: r.no,
    km: r.km,
    location: r.location,
    type: [r.type || (i === 0 ? "START POINT" : i === marked.length - 1 ? "END POINT" : ""), r.coord && `(${r.coord})`]
      .filter(Boolean).join(" "),
    open: r.open,
    close: r.close
  }));
  return { info, controls, cue };
}

// Reads one club's row of an Audax calendar page. The row is: club | JAN ... DEC | summary.
// A ride is a link ("17 - 400" pointing to event-e-NNNNN) once its event page exists, and plain text before that.
function parseCalendar(html, year, club) {
  const cells = html.split(/<t[dh][\s>]/i).slice(1);          // works even if a closing tag is missing
  const at = cells.findIndex(c => clean(c).toLowerCase().includes(club.toLowerCase()));
  if (at < 0) return [];
  const rides = [];
  const pad = n => String(n).padStart(2, "0");
  for (let month = 1; month <= 12; month++) {
    const cell = cells[at + month];
    if (cell === undefined) break;
    const found = [];
    const rest = cell.replace(/<a\b[^>]*href=["'][^"']*event-e-(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi, (_, id, inner) => {
      const t = clean(inner).match(/(\d{1,2})\s*-\s*(\d{2,4}|Fl[eè]che)\b/i);
      if (t) found.push({ id, day: Number(t[1]), dist: t[2] });
      return " ";
    });
    for (const t of clean(rest).matchAll(/(\d{1,2})\s*-\s*(\d{2,4}|Fl[eè]che)\b/gi)) {
      found.push({ id: null, day: Number(t[1]), dist: t[2] });
    }
    for (const f of found) {
      if (f.day < 1 || f.day > 31) continue;
      rides.push({
        year, month, day: f.day,
        date: `${year}-${pad(month)}-${pad(f.day)}`,
        distance: /^fl/i.test(f.dist) ? "Fleche" : f.dist,
        id: f.id
      });
    }
  }
  return rides;
}
// Finds the address of another year's calendar from the "Previous Years" / next-year links on the calendar home page
function findYearLink(html, year) {
  const m = html.match(new RegExp(`<a\\b[^>]*href=["']([^"']+)["'][^>]*>\\s*${year}\\s*<\\/a>`, "i"));
  return m ? m[1] : "";
}
// ---- parse end ----

const pad2 = n => String(n).padStart(2, "0");
const daysAgoISO = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

function extract(html, regex) {
  const match = html.match(regex);
  return match ? clean(match[1]) : "";
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const allowed =
    /^https:\/\/([a-z0-9-]+\.)?sr-brm(-v\d+)?\.pages\.dev$/i.test(origin) ||   // your site, its versions and previews
    origin.startsWith("http://localhost");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://sr-brm-v3.pages.dev",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

function json(request, data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request), ...extra }
  });
}

async function fetchText(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { "User-Agent": UA, ...(init.headers || {}) }
    });
    if (!res.ok) throw new Error(`Source site returned ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- scraping ----------

async function scrapeEvent(id) {
  const html = await fetchText(`${SOURCE}/event-e-${id}`);

  const riders = [];
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cols = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(x => clean(x[1]));
    if (cols.length >= 7 && cols[1]) {
      riders.push({ seq: cols[0], name: cols[1], air: cols[2], fee: cols[3], medal: cols[4], result: cols[5], club: cols[6] });
    }
  }

  // hidden values of the "View route" button
  const hidden = name => {
    const tag = html.match(new RegExp(`<input[^>]*name=["']${name}["'][^>]*>`, "i"));
    const v = tag && tag[0].match(/value=["']([^"']*)["']/i);
    return v ? v[1] : "";
  };

  const title = extract(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const d = title.match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  const mon = d && MONTH_NUM[d[2].toLowerCase()];

  return {
    id: String(id),
    title,
    distance: (title.match(/^\s*(\d{2,4}|Fl[eè]che)/i) || [])[1] || "",
    date: mon ? `${d[3]}-${pad2(mon)}-${pad2(d[1])}` : "",
    rideName: extract(html, /<h4[^>]*>([^<]*)<\/h4>\s*<form[^>]*route-card/i),             // the name/tag right above "View route"
    registrationClose: extract(html, /Registration closes on:\s*([\s\S]*?)<\/h4>/i),
    startTime: extract(html, /Start Time:\s*([\s\S]*?)<\/h4>/i),
    startLocation: extract(html, /Starting Point<\/strong><br ?\/?>([\s\S]*?)<\/p>/i),
    routeMap: (html.match(/https?:\/\/ridewithgps\.com\/routes\/\d+/i) || [])[0] || "",
    calendarId: hidden("calendarID") || String(id),
    routeId: hidden("routeID"),
    riderCount: riders.length,
    riders,
    fetchedAt: new Date().toISOString()
  };
}

async function scrapeRoute(id, ctx) {
  const { data: ev } = await getEvent(id, ctx);
  if (!ev.routeId) throw new Error("This event has no route card yet");
  const html = await fetchText(`${SOURCE}/route-card.php`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Origin": SOURCE,
      "Referer": `${SOURCE}/event-e-${id}`
    },
    body: new URLSearchParams({ calendarID: ev.calendarId, routeID: ev.routeId }).toString()
  });
  const card = parseRouteCard(html);
  if (!card.cue.length) throw new Error("The route card had no rows");
  return { id: String(id), ...card, fetchedAt: new Date().toISOString() };
}

async function scrapeCalendar() {
  const rides = [];
  const errors = [];
  const add = (year, html) => {
    const list = parseCalendar(html, year, CLUB);
    if (!list.length) errors.push(`${year}: no rides found for ${CLUB}`);
    rides.push(...list);
  };

  let home = "";
  try { home = await fetchText(CALENDAR_HOME); } catch (err) { errors.push(`current year: ${err.message}`); }
  const homeYear = Number((home.match(/Calendar for (\d{4})/i) || [])[1]) || new Date().getUTCFullYear();
  if (home) add(homeYear, home);

  const others = [];
  for (let y = homeYear - YEARS_BACK; y <= homeYear + YEARS_AHEAD; y++) if (y !== homeYear) others.push(y);
  await Promise.all(others.map(async year => {
    const link = findYearLink(home, year);
    const url = link ? new URL(link, `${SOURCE}/`).href : `${SOURCE}/events-ec-${year}`;
    try { add(year, await fetchText(url)); } catch (err) { errors.push(`${year}: ${err.message}`); }
  }));

  rides.sort((a, b) => a.date.localeCompare(b.date) || a.distance.localeCompare(b.distance));
  return { club: CLUB, years: [homeYear - YEARS_BACK, homeYear + YEARS_AHEAD], rides, errors, fetchedAt: new Date().toISOString() };
}

// Returns cached data when fresh, otherwise produces it and caches it.
async function cached(key, ttl, ctx, produce) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.sr-brm.internal/${key}`);
  const hit = await cache.match(cacheKey);
  if (hit) return { data: await hit.json(), cache: "HIT" };
  const data = await produce();
  const seconds = typeof ttl === "function" ? ttl(data) : ttl;
  const res = new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${seconds}` }
  });
  ctx.waitUntil(cache.put(cacheKey, res));
  return { data, cache: "MISS" };
}
const getEvent = (id, ctx) => cached(`ev2/${id}`, d => (d.date && d.date < daysAgoISO(2) ? 21600 : CACHE_TTL), ctx, () => scrapeEvent(id));
const getRoute = (id, ctx) => cached(`route-v4/${id}`, ROUTE_TTL, ctx, () => scrapeRoute(id, ctx));
const getCalendar = ctx => cached("calendar-v1", d => (d.errors.length ? 120 : CALENDAR_TTL), ctx, () => scrapeCalendar());

// ---------- team area, control times and tracking ----------
const LIMIT_H = { "100": 7.5, "150": 10.5, "200": 13.5, "300": 20, "400": 27, "600": 40, "1000": 75, "1200": 90, Fleche: 24 };   // time limit in hours
const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); if (s.length % 4 === 1) throw new Error("Invalid base64url data."); return Uint8Array.from(atob(s.padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0)); };
const same = (a, b) => { a = String(a); b = String(b); let x = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) x |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0); return x === 0; };
const sameAir = (a, b) => String(a).trim().replace(/^0+/, "") === String(b).trim().replace(/^0+/, "");
const validAir = a => /^[0-9A-Za-z-]{1,12}$/.test(a);
const newCode = () => { const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; return [...crypto.getRandomValues(new Uint8Array(8))].map(x => a[x % a.length]).join(""); };
const normEmail = s => String(s || "").trim().toLowerCase();
const randomToken = () => b64u(crypto.getRandomValues(new Uint8Array(32)));
const hash = async s => b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return b64u(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: unb64u(salt), iterations: 100000, hash: "SHA-256" }, key, 256));
}
async function whoIs(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !env.DB) return null;
  const d = await db(env), digest = await hash(token);
  const row = await d.prepare("SELECT u.email, u.role, u.status FROM team_sessions s JOIN team_users u ON u.email=s.email WHERE s.token_hash=? AND s.expires>? AND u.status='active'")
    .bind(digest, Date.now()).first();
  return row || null;
}

let dbReady = false;
async function db(env) {                  // the tables are created automatically the first time
  if (!env.DB) return null;
  if (!dbReady) {
    const q = s => env.DB.prepare(s);
    await env.DB.batch([
      q("CREATE TABLE IF NOT EXISTS crossings (id INTEGER PRIMARY KEY AUTOINCREMENT, ride_id TEXT NOT NULL, control_no INTEGER NOT NULL, air TEXT NOT NULL, ts INTEGER NOT NULL, entered_by TEXT NOT NULL, created INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)"),
      q("CREATE INDEX IF NOT EXISTS idx_crossings_ride ON crossings (ride_id, deleted)"),
      q("CREATE TABLE IF NOT EXISTS tracking_codes (token TEXT PRIMARY KEY, air TEXT NOT NULL, name TEXT, created INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1)"),
      q("CREATE TABLE IF NOT EXISTS positions (id INTEGER PRIMARY KEY AUTOINCREMENT, ride_id TEXT NOT NULL, air TEXT NOT NULL, ts INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, speed REAL, batt REAL)"),
      q("CREATE INDEX IF NOT EXISTS idx_positions_ride ON positions (ride_id, air, ts)"),
      q("CREATE TABLE IF NOT EXISTS rider_progress (ride_id TEXT NOT NULL, air TEXT NOT NULL, km REAL NOT NULL DEFAULT 0, last_lat REAL NOT NULL, last_lon REAL NOT NULL, last_ts INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (ride_id, air))"),
      q("CREATE TABLE IF NOT EXISTS ride_routes (ride_id TEXT PRIMARY KEY, points_json TEXT NOT NULL, point_count INTEGER NOT NULL, updated_by TEXT NOT NULL, updated INTEGER NOT NULL)"),
      q("CREATE TABLE IF NOT EXISTS login_fails (ip TEXT NOT NULL, ts INTEGER NOT NULL)"),
      q("CREATE TABLE IF NOT EXISTS team_users (email TEXT PRIMARY KEY, role TEXT NOT NULL, status TEXT NOT NULL, salt TEXT, password_hash TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
      q("CREATE TABLE IF NOT EXISTS team_auth_tokens (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL, created_by TEXT, created_at INTEGER NOT NULL)"),
      q("CREATE INDEX IF NOT EXISTS idx_team_auth_email ON team_auth_tokens (email, kind)"),
      q("CREATE TABLE IF NOT EXISTS team_sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL, created_at INTEGER NOT NULL)"),
      q("CREATE INDEX IF NOT EXISTS idx_team_sessions_email ON team_sessions (email)"),
      q("CREATE TABLE IF NOT EXISTS rider_marks (id INTEGER PRIMARY KEY AUTOINCREMENT, ride_id TEXT NOT NULL, air TEXT NOT NULL, mark TEXT NOT NULL, ts INTEGER NOT NULL, entered_by TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)"),
      q("CREATE INDEX IF NOT EXISTS idx_marks_ride ON rider_marks (ride_id, deleted)")
    ]);
    dbReady = true;
  }
  return env.DB;
}

// Control times: anyone can read them, only the signed-in team can add or remove
async function handleCrossings(request, env, rideId) {
  const d = await db(env);
  if (!d) return json(request, { ready: false, crossings: [] });
  const team = await whoIs(request, env);
  const { results } = await d.prepare("SELECT id, control_no, air, ts, entered_by FROM crossings WHERE ride_id = ? AND deleted = 0 ORDER BY ts").bind(rideId).all();
  const marks = (await d.prepare("SELECT air, mark FROM rider_marks WHERE ride_id = ? AND deleted = 0").bind(rideId).all()).results;   // team-set "dns" / "dnf"
  const progress = (await d.prepare("SELECT air, ROUND(km, 2) AS km, updated AS ts FROM rider_progress WHERE ride_id = ? ORDER BY km DESC").bind(rideId).all()).results;
  return json(request, {
    ready: true,
    marks,
    progress,
    crossings: results.map(r => team ? { id: r.id, no: r.control_no, air: r.air, ts: r.ts, by: r.entered_by } : { no: r.control_no, air: r.air, ts: r.ts })
  }, 200, { "Cache-Control": "no-store" });
}

async function handleTeam(request, env, b, c) {
  const d = await db(env);
  if (!d) return json(request, { error: "The database is not connected to the Worker yet." }, 503);
  const post = request.method === "POST";
  const body = post ? await request.json().catch(() => ({})) : {};
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (b === "bootstrap" && c === "status" && !post) {
    const active = await d.prepare("SELECT 1 AS active FROM team_users WHERE status='active' LIMIT 1").first();
    return json(request, { available: !active }, 200, { "Cache-Control": "no-store" });
  }
  const blocked = async () => { const r = await d.prepare("SELECT COUNT(*) AS n FROM login_fails WHERE ip=? AND ts>?").bind(ip, Date.now() - 15 * 60e3).first(); return r && r.n >= 8; };

  const sendMail = async (to, subject, token, kind) => {
    if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD || !env.APP_ORIGIN) throw new Error("Gmail email delivery is not configured yet.");
    const link = `${String(env.APP_ORIGIN).replace(/\/$/, "")}/#team?${kind}=${encodeURIComponent(token)}`;
    const action = kind === "invite" ? "Set up your SR BRM team account" : "Reset your SR BRM password";
    const html = `<p>${action}</p><p><a href="${link}">${kind === "invite" ? "Set password" : "Reset password"}</a></p><p>This link expires in 60 minutes and can only be used once.</p>`;
    const socket = connect({ hostname: "smtp.gmail.com", port: 465 }, { secureTransport: "on" });
    const reader = socket.readable.getReader(), writer = socket.writable.getWriter();
    let pending = "";
    const response = async expected => {
      const lines = [];
      for (;;) {
        const end = pending.indexOf("\r\n");
        if (end < 0) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Gmail closed the email connection.");
          pending += new TextDecoder().decode(chunk.value, { stream: true });
          continue;
        }
        const line = pending.slice(0, end); pending = pending.slice(end + 2); lines.push(line);
        if (/^\d{3} /.test(line)) {
          const code = Number(line.slice(0, 3));
          if (code !== expected) throw new Error("Gmail could not send the email (SMTP " + code + ").");
          return lines.join("\n");
        }
      }
    };
    const command = async (value, expected) => { await writer.write(enc.encode(value + "\r\n")); return response(expected); };
    try {
      await response(220);
      await command("EHLO sr-brm-v3.pages.dev", 250);
      await command("AUTH LOGIN", 334);
      await command(btoa(String(env.GMAIL_USER)), 334);
      await command(btoa(String(env.GMAIL_APP_PASSWORD).replace(/\s/g, "")), 235);
      await command(`MAIL FROM:<${env.GMAIL_USER}>`, 250);
      await command(`RCPT TO:<${to}>`, 250);
      await command("DATA", 354);
      const message = [
        `From: SR BRM Team <${env.GMAIL_USER}>`, `To: ${to}`, `Subject: ${subject}`,
        "MIME-Version: 1.0", "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "",
        html.replace(/\r?\n/g, "\r\n").replace(/\r\n\./g, "\r\n..")
      ].join("\r\n");
      await writer.write(enc.encode(message + "\r\n.\r\n"));
      await response(250);
      await command("QUIT", 221);
    } finally {
      try { reader.releaseLock(); } catch (_) {}
      try { writer.releaseLock(); } catch (_) {}
      try { await socket.close(); } catch (_) {}
    }
  };
  const issueMail = async (email, kind, who) => {
    const raw = randomToken(), expires = Date.now() + 3600e3;
    await d.prepare("DELETE FROM team_auth_tokens WHERE email=? AND kind=?").bind(email, kind).run();
    await d.prepare("INSERT INTO team_auth_tokens (token_hash,email,kind,expires,created_by,created_at) VALUES (?,?,?,?,?,?)").bind(await hash(raw), email, kind, expires, who?.email || null, Date.now()).run();
    try { await sendMail(email, kind === "invite" ? "Your SR BRM team invitation" : "Reset your SR BRM password", raw, kind); }
    catch (err) { await d.prepare("DELETE FROM team_auth_tokens WHERE token_hash=?").bind(await hash(raw)).run(); throw err; }
  };
  if (b === "bootstrap" && post) {
    if (await blocked()) return json(request, { error: "Too many requests. Try again in 15 minutes." }, 429);
    await d.prepare("INSERT INTO login_fails (ip,ts) VALUES (?,?)").bind(ip,Date.now()).run();
    if (await d.prepare("SELECT COUNT(*) AS n FROM team_users WHERE status='active'").first().then(x => x.n)) return json(request, { error: "Initial setup is already complete." }, 409);
    const email = normEmail(env.BOOTSTRAP_ADMIN_EMAIL);
    if (!email || normEmail(body.email) !== email) return json(request, { error: "This email is not configured as the initial administrator." }, 403);
    await d.prepare("INSERT OR IGNORE INTO team_users (email,role,status,created_at,updated_at) VALUES (?,'admin','invited',?,?)").bind(email, Date.now(), Date.now()).run();
    try { await issueMail(email, "invite", null); } catch (err) { return json(request, { error: err.message }, 503); }
    return json(request, { ok: true, message: "Check your email for the account setup link." });
  }
  if (b === "login" && post) {
    if (!post) return json(request, { error: "Method not allowed" }, 405);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const recent = await d.prepare("SELECT COUNT(*) AS n FROM login_fails WHERE ip = ? AND ts > ?").bind(ip, Date.now() - 15 * 60e3).first();
    if (recent && recent.n >= 8) return json(request, { error: "Too many failed attempts. Try again in 15 minutes." }, 429);
    const email = normEmail(body.email), password = String(body.password || ""), person = email.length <= 254 ? await d.prepare("SELECT email,role,status,salt,password_hash FROM team_users WHERE email=?").bind(email).first() : null;
    const candidate = await passwordHash(password.length <= 200 ? password : "", person?.salt || "AAAAAAAAAAAAAAAAAAAAAA");
    if (!person || person.status !== "active" || !same(candidate, person.password_hash || "")) {
      await d.prepare("INSERT INTO login_fails (ip, ts) VALUES (?, ?)").bind(ip, Date.now()).run();
      return json(request, { error: "Email or password is incorrect." }, 401);
    }
    const token = randomToken();
    await d.prepare("DELETE FROM team_sessions WHERE expires<=?").bind(Date.now()).run();
    await d.prepare("INSERT INTO team_sessions (token_hash,email,expires,created_at) VALUES (?,?,?,?)").bind(await hash(token), email, Date.now() + 12 * 3600e3, Date.now()).run();
    return json(request, { email, role: person.role, token });
  }

  if ((b === "activate" || b === "reset") && post) {
    const raw = String(body.token || ""), row = await d.prepare("SELECT token_hash,email,kind,expires FROM team_auth_tokens WHERE token_hash=? AND kind=? AND expires>?").bind(await hash(raw), b === "activate" ? "invite" : "reset", Date.now()).first();
    const password = String(body.password || "");
    if (!row) return json(request, { error: "This link is invalid or expired. Ask an administrator for a new one." }, 400);
    if (password.length < 12 || password.length > 200) return json(request, { error: "Use a password between 12 and 200 characters." }, 400);
    const salt = b64u(crypto.getRandomValues(new Uint8Array(16))), digest = await passwordHash(password, salt);
    await d.batch([
      d.prepare("UPDATE team_users SET salt=?,password_hash=?,status='active',updated_at=? WHERE email=?").bind(salt, digest, Date.now(), row.email),
      d.prepare("DELETE FROM team_auth_tokens WHERE email=?").bind(row.email),
      d.prepare("DELETE FROM team_sessions WHERE email=?").bind(row.email)
    ]);
    const token = randomToken();
    await d.prepare("INSERT INTO team_sessions (token_hash,email,expires,created_at) VALUES (?,?,?,?)").bind(await hash(token), row.email, Date.now() + 12 * 3600e3, Date.now()).run();
    const user = await d.prepare("SELECT role FROM team_users WHERE email=?").bind(row.email).first();
    return json(request, { email: row.email, role: user.role, token });
  }
  if (b === "forgot" && post) {
    if (await blocked()) return json(request, { error: "Too many requests. Try again in 15 minutes." }, 429);
    await d.prepare("INSERT INTO login_fails (ip,ts) VALUES (?,?)").bind(ip,Date.now()).run();
    const email = normEmail(body.email), user = await d.prepare("SELECT email,status FROM team_users WHERE email=? AND status='active'").bind(email).first();
    if (user) { try { await issueMail(email, "reset", null); } catch (_) {} }
    return json(request, { ok: true, message: "If that active account exists, a password reset link is on its way." });
  }

  const who = await whoIs(request, env);
  if (!who) return json(request, { error: "Please sign in" }, 401);
  if (b === "me") return json(request, { email: who.email, role: who.role });
  if (b === "logout" && post) { await d.prepare("DELETE FROM team_sessions WHERE token_hash=?").bind(await hash((request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, ""))).run(); return json(request, { ok: true }); }
  if (b === "password" && post) {
    const old = String(body.currentPassword || ""), user = await d.prepare("SELECT salt,password_hash FROM team_users WHERE email=?").bind(who.email).first();
    if (!same(await passwordHash(old, user.salt), user.password_hash)) return json(request, { error: "Current password is incorrect." }, 401);
    const next = String(body.password || ""); if (next.length < 12 || next.length > 200) return json(request, { error: "Use a password between 12 and 200 characters." }, 400);
    const salt = b64u(crypto.getRandomValues(new Uint8Array(16))), digest = await passwordHash(next, salt);
    await d.batch([d.prepare("UPDATE team_users SET salt=?,password_hash=?,updated_at=? WHERE email=?").bind(salt,digest,Date.now(),who.email), d.prepare("DELETE FROM team_sessions WHERE email=?").bind(who.email)]);
    return json(request, { ok: true });
  }
  if (b === "users") {
    if (who.role !== "admin") return json(request, { error: "Administrator access required." }, 403);
    if (!post) { const { results } = await d.prepare("SELECT email,role,status,created_at FROM team_users ORDER BY email").all(); return json(request, { users: results }); }
    const email = normEmail(body.email), role = body.role === "admin" ? "admin" : "editor";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(request, { error: "Enter a valid email address." }, 400);
    if (email === who.email && role !== "admin") return json(request, { error: "You cannot remove your own administrator access." }, 400);
    const existing = await d.prepare("SELECT role,status FROM team_users WHERE email=?").bind(email).first();
    if (existing?.status === "active") {
      if (existing.role === role) return json(request, { error: "This user already has that access level." }, 409);
      await d.prepare("UPDATE team_users SET role=?,updated_at=? WHERE email=?").bind(role,Date.now(),email).run();
      return json(request, { ok: true, message: "Access updated." });
    }
    await d.prepare("INSERT INTO team_users (email,role,status,created_by,created_at,updated_at) VALUES (?,?,'invited',?,?,?) ON CONFLICT(email) DO UPDATE SET role=excluded.role,status=CASE WHEN team_users.status='active' THEN team_users.status ELSE 'invited' END,updated_at=excluded.updated_at")
      .bind(email,role,who.email,Date.now(),Date.now()).run();
    try { await issueMail(email,"invite",who); } catch (err) { return json(request, { error: err.message }, 503); }
    return json(request, { ok: true });
  }
  if (b === "user" && post) {
    if (who.role !== "admin") return json(request, { error: "Administrator access required." }, 403);
    const email = normEmail(body.email);
    if (email === who.email && body.action === "disable") return json(request, { error: "You cannot disable your own account." }, 400);
    if (body.action === "disable") {
      await d.batch([d.prepare("UPDATE team_users SET status='disabled',updated_at=? WHERE email=?").bind(Date.now(),email), d.prepare("DELETE FROM team_sessions WHERE email=?").bind(email), d.prepare("DELETE FROM team_auth_tokens WHERE email=?").bind(email)]);
      return json(request, { ok: true });
    }
    const target = await d.prepare("SELECT email,status FROM team_users WHERE email=?").bind(email).first();
    if (!target) return json(request, { error: "User not found." }, 404);
    try { await issueMail(email,"invite",who); } catch (err) { return json(request, { error: err.message }, 503); }
    return json(request, { ok: true });
  }

  if (b === "crossing" && post) {                                   // record, correct or remove a control time
    if (c === "delete") {
      await d.prepare("UPDATE crossings SET deleted = 1 WHERE id = ?").bind(Number(body.id)).run();
      return json(request, { ok: true });
    }
    const rideId = String(body.rideId || ""), no = Number(body.controlNo), air = String(body.air || "").trim();
    if (!/^\d{3,6}$/.test(rideId) || !Number.isInteger(no) || no < 1 || no > 500 || !validAir(air)) return json(request, { error: "The ride, control or AIR number is not valid." }, 400);
    const ts = Number(body.ts) || Date.now();
    if (ts > Date.now() + 10 * 60e3) return json(request, { error: "That time is in the future." }, 400);
    const isFirstStart = no === 1 && !await d.prepare("SELECT 1 AS yes FROM crossings WHERE ride_id=? AND control_no=1 AND air=? AND deleted=0 LIMIT 1").bind(rideId, air).first();
    await d.batch([
      d.prepare("UPDATE crossings SET deleted = 1 WHERE ride_id = ? AND control_no = ? AND air = ? AND deleted = 0").bind(rideId, no, air),
      d.prepare("INSERT INTO crossings (ride_id, control_no, air, ts, entered_by, created) VALUES (?, ?, ?, ?, ?, ?)").bind(rideId, no, air, ts, who.email, Date.now()),
      d.prepare("UPDATE rider_marks SET deleted = 1 WHERE ride_id = ? AND air = ? AND mark = 'dns' AND deleted = 0").bind(rideId, air)
    ]);
    if (isFirstStart) await d.batch([
      d.prepare("DELETE FROM positions WHERE ride_id=? AND air=?").bind(rideId, air),
      d.prepare("DELETE FROM rider_progress WHERE ride_id=? AND air=?").bind(rideId, air)
    ]);
    return json(request, { ok: true });
  }

  if (b === "mark" && post) {                                       // team sets a rider as "did not start" / "did not finish", or clears it
    const rideId = String(body.rideId || ""), air = String(body.air || "").trim(), mark = String(body.mark || "");
    if (!/^\d{3,6}$/.test(rideId) || !validAir(air) || !["dns", "dnf", "clear"].includes(mark)) return json(request, { error: "The ride, rider or status is not valid." }, 400);
    const ops = [d.prepare("UPDATE rider_marks SET deleted = 1 WHERE ride_id = ? AND air = ? AND deleted = 0").bind(rideId, air)];
    if (mark !== "clear") ops.push(d.prepare("INSERT INTO rider_marks (ride_id, air, mark, ts, entered_by) VALUES (?, ?, ?, ?, ?)").bind(rideId, air, mark, Date.now(), who.email));
    await d.batch(ops);
    return json(request, { ok: true });
  }

  if (b === "codes") {                                              // personal tracking codes for riders who agreed to be tracked
    if (!post) {
      const { results } = await d.prepare("SELECT token, air, name, created FROM tracking_codes WHERE active = 1 ORDER BY created DESC").all();
      return json(request, { codes: results });
    }
    const air = String(body.air || "").trim();
    if (!validAir(air)) return json(request, { error: "AIR number is not valid." }, 400);
    if (c === "revoke") { await d.prepare("UPDATE tracking_codes SET active = 0 WHERE air = ?").bind(air).run(); return json(request, { ok: true }); }
    const have = await d.prepare("SELECT token FROM tracking_codes WHERE air = ? AND active = 1").bind(air).first();
    if (have) return json(request, { token: have.token });
    const token = newCode();
    await d.prepare("INSERT INTO tracking_codes (token, air, name, created) VALUES (?, ?, ?, ?)").bind(token, air, String(body.name || "").slice(0, 80), Date.now()).run();
    return json(request, { token });
  }

  if (b === "tracking" && /^\d{3,6}$/.test(c || "")) {              // latest known position of each tracked rider
    const { results } = await d.prepare(
      "SELECT p.air, p.ts, p.lat, p.lon, p.speed, p.batt, COALESCE(g.km, 0) AS km FROM positions p JOIN (SELECT air, MAX(ts) AS m FROM positions WHERE ride_id = ? GROUP BY air) x ON p.air = x.air AND p.ts = x.m LEFT JOIN rider_progress g ON g.ride_id=p.ride_id AND g.air=p.air WHERE p.ride_id = ?"
    ).bind(c, c).all();
    return json(request, { positions: results }, 200, { "Cache-Control": "no-store" });
  }
  if (b === "route" && /^\d{3,6}$/.test(c || "")) {                  // private route geometry for the team map
    if (!post) {
      const row = await d.prepare("SELECT points_json, point_count, updated, updated_by FROM ride_routes WHERE ride_id=?").bind(c).first();
      return json(request, { route: row ? { points: JSON.parse(row.points_json), pointCount: row.point_count, updated: row.updated, updatedBy: row.updated_by } : null }, 200, { "Cache-Control": "no-store" });
    }
    if (who.role !== "admin") return json(request, { error: "Only an administrator can change the route file." }, 403);
    const points = Array.isArray(body.points) ? body.points : [];
    if (points.length < 2 || points.length > 3000 || points.some(p => !Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 90 || Math.abs(p[1]) > 180))
      return json(request, { error: "The GPX route must contain 2 to 3,000 valid track points." }, 400);
    await d.prepare("INSERT INTO ride_routes (ride_id,points_json,point_count,updated_by,updated) VALUES (?,?,?,?,?) ON CONFLICT(ride_id) DO UPDATE SET points_json=excluded.points_json,point_count=excluded.point_count,updated_by=excluded.updated_by,updated=excluded.updated")
      .bind(c, JSON.stringify(points), points.length, who.email, Date.now()).run();
    return json(request, { ok: true, pointCount: points.length });
  }
  return json(request, { error: "Not found" }, 404);
}

// Is this rider registered for a ride that is running right now (start time up to the time limit, with a margin)?
async function activeRideFor(air, ctx) {
  const { data: cal } = await getCalendar(ctx);
  const now = Date.now();
  for (const r of cal.rides) {
    if (!r.id) continue;
    const day = Date.parse(`${r.date}T00:00:00+05:30`);
    if (day > now + 36 * 3600e3 || day < now - 4 * 864e5) continue;
    const { data: ev } = await getEvent(r.id, ctx);
    const t = (ev.startTime || "").match(/(\d{1,2}):(\d{2})/);
    const start = Date.parse(`${r.date}T${t ? `${pad2(t[1])}:${t[2]}` : "06:00"}:00+05:30`);
    const end = start + (LIMIT_H[r.distance] ?? 24) * 3600e3;
    if (now < start - 3 * 3600e3 || now > end + 3 * 3600e3) continue;
    if ((ev.riders || []).some(x => sameAir(x.air, air))) return { id: r.id };
  }
  return null;
}

function kmBetween(lat1, lon1, lat2, lon2) {
  const rad = x => x * Math.PI / 180, dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function trackingEnabled(d, env, rideId, air, ctx) {
  const mark = await d.prepare("SELECT mark FROM rider_marks WHERE ride_id=? AND air=? AND deleted=0 ORDER BY ts DESC LIMIT 1").bind(rideId, air).first();
  if (mark && ["dns", "dnf"].includes(mark.mark)) return false;
  const route = env.STAGING_MODE === "true" && rideId === TEST_RIDE_ID
    ? virtualTestRoute()
    : (await getRoute(rideId, ctx)).data;
  const controls = route?.controls || [];
  const startNo = Number(controls[0]?.no) || 1;
  const started = await d.prepare("SELECT 1 AS yes FROM crossings WHERE ride_id=? AND air=? AND control_no=? AND deleted=0 LIMIT 1").bind(rideId, air, startNo).first();
  if (!started) return false;
  if (controls.length > 1) {
    const lastNo = Number(controls[controls.length - 1]?.no) || controls.length;
    const finished = await d.prepare("SELECT 1 AS yes FROM crossings WHERE ride_id=? AND air=? AND control_no=? AND deleted=0 LIMIT 1").bind(rideId, air, lastNo).first();
    if (finished) return false;
  }
  return true;
}

// Location pings from the Traccar Client app (same simple request format as OsmAnd/Traccar: id, lat, lon, timestamp, speed in knots, batt)
async function handleTrack(request, env, ctx, url) {
  const ok = () => json(request, { ok: true });                    // always answer OK so the phone never piles up retries
  const d = await db(env);
  if (!d) return ok();
  const p = new URLSearchParams(url.search);
  if (request.method === "POST") {
    try {
      const text = await request.text();
      if ((request.headers.get("Content-Type") || "").includes("json")) for (const [k, v] of Object.entries(JSON.parse(text))) p.set(k, String(v));
      else for (const [k, v] of new URLSearchParams(text)) p.set(k, v);
    } catch (_) { /* use the query only */ }
  }
  const token = (p.get("id") || p.get("deviceid") || "").trim().toUpperCase();
  const lat = Number(p.get("lat")), lon = Number(p.get("lon"));
  if (!token || !isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return ok();
  const rider = await d.prepare("SELECT air FROM tracking_codes WHERE token = ? AND active = 1").bind(token).first();
  if (!rider) return ok();
  const ride = env.STAGING_MODE === "true" && rider.air === TEST_AIR
    ? { id: TEST_RIDE_ID }
    : await activeRideFor(rider.air, ctx);
  if (!ride) return ok();                                          // not registered for a ride that is on now: nothing is kept
  if (!(await trackingEnabled(d, env, ride.id, rider.air, ctx))) return ok();

  const raw = p.get("timestamp") || "";
  let ts = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * (Number(raw) < 1e12 ? 1000 : 1) : Date.parse(raw);
  const now = Date.now();
  if (!isFinite(ts) || ts > now + 5 * 60e3 || ts < now - 12 * 3600e3) ts = now;
  const speed = Number(p.get("speed")), batt = Number(p.get("batt"));
  const prev = await d.prepare("SELECT km,last_lat,last_lon,last_ts FROM rider_progress WHERE ride_id=? AND air=?").bind(ride.id, rider.air).first();
  let km = prev?.km || 0;
  if (!prev || ts > prev.last_ts) {
    if (prev) {
      const segment = kmBetween(prev.last_lat, prev.last_lon, lat, lon), hours = (ts - prev.last_ts) / 3600e3;
      // Ignore GPS jitter below 20 m and implausible jumps above 100 km/h.
      if (segment >= 0.02 && hours > 0 && segment / hours <= 100) km += segment;
    }
    await d.prepare("INSERT INTO rider_progress (ride_id,air,km,last_lat,last_lon,last_ts,updated) VALUES (?,?,?,?,?,?,?) ON CONFLICT(ride_id,air) DO UPDATE SET km=excluded.km,last_lat=excluded.last_lat,last_lon=excluded.last_lon,last_ts=excluded.last_ts,updated=excluded.updated")
      .bind(ride.id, rider.air, km, lat, lon, ts, now).run();
  }
  await d.prepare("INSERT INTO positions (ride_id, air, ts, lat, lon, speed, batt) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(ride.id, rider.air, ts, lat, lon, isFinite(speed) && p.get("speed") !== null ? speed * 1.852 : null, isFinite(batt) && p.get("batt") !== null ? batt : null).run();
  if (Math.random() < 0.01) ctx.waitUntil(d.batch([
    d.prepare("DELETE FROM positions WHERE ts < ?").bind(now - 30 * 864e5),
    d.prepare("DELETE FROM rider_progress WHERE updated < ?").bind(now - 30 * 864e5)
  ]));   // keep location and distance data for 30 days
  return ok();
}

// ---------- router ----------

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
    const url = new URL(request.url);
    const [a, b, c] = url.pathname.split("/").filter(Boolean);

    if (!a) {
      return json(request, { service: "SR BRM API", club: CLUB, endpoints: ["/calendar", "/ev/:id", "/rt/:id", "/crossings/:id"] });
    }

    try {
      if (a === "track") return await handleTrack(request, env, ctx, url);
      if (a === "team") return await handleTeam(request, env, b, c);
      if (a === "crossings" && /^\d{3,6}$/.test(b || "")) return await handleCrossings(request, env, b);
      if (request.method !== "GET") return json(request, { error: "Method not allowed" }, 405);
      if (a === "calendar") {
        const { data, cache } = await getCalendar(ctx);
        if (env.STAGING_MODE === "true") data.rides = [...data.rides.filter(r => r.id !== TEST_RIDE_ID), virtualTestEvent()];
        return json(request, data, 200, { "Cache-Control": "public, max-age=300", "X-Cache": cache });
      }

      if (env.STAGING_MODE === "true" && a === "ev" && b === TEST_RIDE_ID) return json(request, virtualTestEvent(), 200, { "Cache-Control": "no-store" });
      if (env.STAGING_MODE === "true" && a === "rt" && b === TEST_RIDE_ID) return json(request, virtualTestRoute(), 200, { "Cache-Control": "no-store" });

      let id = null;
      if ((a === "ev" || a === "rt") && /^\d{3,6}$/.test(b || "")) id = b;
      else if ((a === "event" || a === "route") && LEGACY[b]) id = LEGACY[b];   // old style /event/600
      if (id) {
        const isRoute = a === "rt" || a === "route";
        const { data, cache } = await (isRoute ? getRoute(id, ctx) : getEvent(id, ctx));
        return json(request, data, 200, { "Cache-Control": `public, max-age=${isRoute ? ROUTE_TTL : CACHE_TTL}`, "X-Cache": cache });
      }
    } catch (err) {
      return json(request, { error: err.name === "AbortError" ? "Source site timed out" : (err.message || "Could not fetch data from source site") }, 502);
    }

    return json(request, { error: "Not found" }, 404);
  }
};
