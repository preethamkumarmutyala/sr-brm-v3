// SR BRM API - Cloudflare Worker
//   GET /calendar       your club's rides from the Audax calendars (2025, 2026, 2027), with the event id when the ride has a page
//   GET /ev/:id         one event page: details, ride name, riders, route-map link, route-card ids
//   GET /rt/:id         official route card (View route): controls + cue sheet
//   GET /event/:dist and /route/:dist   old addresses for this week's 200/300/400/600 (kept so nothing breaks)
//   GET /crossings/:id   control times recorded by the team (public, read only)
//   /team/...            team sign-in, recording control times, tracking codes, live positions (PIN protected)
//   /track               receives locations from the Traccar Client app (only kept for registered riders during their ride)
// Team features need: a D1 database bound as "DB" and a secret named TEAM_PINS (like  Preetham:482913,Ravi:775310 ).

const SOURCE = "https://www.audaxindia.in";
const CLUB = "Secunderabad Randonneurs";
const CALENDAR_HOME = `${SOURCE}/events.php`;   // Audax's current-year calendar; it also links to the other years
const YEARS_BACK = 1;                          // past seasons to include before the current one (1 = last year; raise it to go further back)
const YEARS_AHEAD = 1;                         // upcoming rides: this many years after the current one
const LEGACY = { "600": "10047", "200": "10048", "300": "10049", "400": "10050" };

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
const same = (a, b) => a.length === b.length && [...a].reduce((x, c, i) => x | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;   // constant-time compare
const sameAir = (a, b) => String(a).trim().replace(/^0+/, "") === String(b).trim().replace(/^0+/, "");
const validAir = a => /^[0-9A-Za-z-]{1,12}$/.test(a);
const newCode = () => { const a = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; return [...crypto.getRandomValues(new Uint8Array(8))].map(x => a[x % a.length]).join(""); };
const teamList = env => String(env.TEAM_PINS || "").split(",").map(x => x.trim()).filter(Boolean)
  .map(x => { const i = x.indexOf(":"); return i > 0 ? { name: x.slice(0, i).trim(), pin: x.slice(i + 1).trim() } : null; }).filter(Boolean);
async function sign(env, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(String(env.TEAM_PINS)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
}
async function makeToken(env, name) {
  const body = `${encodeURIComponent(name)}.${Date.now() + 12 * 3600e3}`;          // valid for 12 hours; changing TEAM_PINS signs everyone out
  return `${body}.${await sign(env, body)}`;
}
async function whoIs(request, env) {
  const [n, exp, sig] = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").split(".");
  if (!sig || !env.TEAM_PINS || Number(exp) < Date.now()) return null;
  return same(await sign(env, `${n}.${exp}`), sig) ? decodeURIComponent(n) : null;
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
      q("CREATE TABLE IF NOT EXISTS login_fails (ip TEXT NOT NULL, ts INTEGER NOT NULL)"),
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
  return json(request, {
    ready: true,
    marks,
    crossings: results.map(r => team ? { id: r.id, no: r.control_no, air: r.air, ts: r.ts, by: r.entered_by } : { no: r.control_no, air: r.air, ts: r.ts })
  }, 200, { "Cache-Control": "no-store" });
}

async function handleTeam(request, env, b, c) {
  if (!env.TEAM_PINS) return json(request, { error: "Team sign-in is not set up yet (the TEAM_PINS secret is missing)." }, 503);
  const d = await db(env);
  if (!d) return json(request, { error: "The database is not connected to the Worker yet." }, 503);
  const post = request.method === "POST";
  const body = post ? await request.json().catch(() => ({})) : {};

  if (b === "login") {
    if (!post) return json(request, { error: "Method not allowed" }, 405);
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const recent = await d.prepare("SELECT COUNT(*) AS n FROM login_fails WHERE ip = ? AND ts > ?").bind(ip, Date.now() - 15 * 60e3).first();
    if (recent && recent.n >= 8) return json(request, { error: "Too many wrong PINs. Try again in 15 minutes." }, 429);
    const person = teamList(env).find(p => same(p.pin, String(body.pin || "").trim()));
    if (!person) {
      await d.prepare("INSERT INTO login_fails (ip, ts) VALUES (?, ?)").bind(ip, Date.now()).run();
      return json(request, { error: "Wrong PIN" }, 401);
    }
    return json(request, { name: person.name, token: await makeToken(env, person.name) });
  }

  const who = await whoIs(request, env);
  if (!who) return json(request, { error: "Please sign in" }, 401);
  if (b === "me") return json(request, { name: who });

  if (b === "crossing" && post) {                                   // record, correct or remove a control time
    if (c === "delete") {
      await d.prepare("UPDATE crossings SET deleted = 1 WHERE id = ?").bind(Number(body.id)).run();
      return json(request, { ok: true });
    }
    const rideId = String(body.rideId || ""), no = Number(body.controlNo), air = String(body.air || "").trim();
    if (!/^\d{3,6}$/.test(rideId) || !Number.isInteger(no) || no < 1 || no > 500 || !validAir(air)) return json(request, { error: "The ride, control or AIR number is not valid." }, 400);
    const ts = Number(body.ts) || Date.now();
    if (ts > Date.now() + 10 * 60e3 || ts < Date.now() - 72 * 3600e3) return json(request, { error: "That time is not valid (in the future or more than 3 days ago)." }, 400);
    await d.batch([
      d.prepare("UPDATE crossings SET deleted = 1 WHERE ride_id = ? AND control_no = ? AND air = ? AND deleted = 0").bind(rideId, no, air),
      d.prepare("INSERT INTO crossings (ride_id, control_no, air, ts, entered_by, created) VALUES (?, ?, ?, ?, ?, ?)").bind(rideId, no, air, ts, who, Date.now()),
      d.prepare("UPDATE rider_marks SET deleted = 1 WHERE ride_id = ? AND air = ? AND mark = 'dns' AND deleted = 0").bind(rideId, air)
    ]);
    return json(request, { ok: true });
  }

  if (b === "mark" && post) {                                       // team sets a rider as "did not start" / "did not finish", or clears it
    const rideId = String(body.rideId || ""), air = String(body.air || "").trim(), mark = String(body.mark || "");
    if (!/^\d{3,6}$/.test(rideId) || !validAir(air) || !["dns", "dnf", "clear"].includes(mark)) return json(request, { error: "The ride, rider or status is not valid." }, 400);
    const ops = [d.prepare("UPDATE rider_marks SET deleted = 1 WHERE ride_id = ? AND air = ? AND deleted = 0").bind(rideId, air)];
    if (mark !== "clear") ops.push(d.prepare("INSERT INTO rider_marks (ride_id, air, mark, ts, entered_by) VALUES (?, ?, ?, ?, ?)").bind(rideId, air, mark, Date.now(), who));
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
      "SELECT p.air, p.ts, p.lat, p.lon, p.speed, p.batt FROM positions p JOIN (SELECT air, MAX(ts) AS m FROM positions WHERE ride_id = ? GROUP BY air) x ON p.air = x.air AND p.ts = x.m WHERE p.ride_id = ?"
    ).bind(c, c).all();
    return json(request, { positions: results }, 200, { "Cache-Control": "no-store" });
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
  const ride = await activeRideFor(rider.air, ctx);
  if (!ride) return ok();                                          // not registered for a ride that is on now: nothing is kept

  const raw = p.get("timestamp") || "";
  let ts = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * (Number(raw) < 1e12 ? 1000 : 1) : Date.parse(raw);
  const now = Date.now();
  if (!isFinite(ts) || ts > now + 5 * 60e3 || ts < now - 12 * 3600e3) ts = now;
  const speed = Number(p.get("speed")), batt = Number(p.get("batt"));
  await d.prepare("INSERT INTO positions (ride_id, air, ts, lat, lon, speed, batt) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(ride.id, rider.air, ts, lat, lon, isFinite(speed) && p.get("speed") !== null ? speed * 1.852 : null, isFinite(batt) && p.get("batt") !== null ? batt : null).run();
  if (Math.random() < 0.01) ctx.waitUntil(d.prepare("DELETE FROM positions WHERE ts < ?").bind(now - 30 * 864e5).run());   // keep 30 days
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
        return json(request, data, 200, { "Cache-Control": "public, max-age=300", "X-Cache": cache });
      }

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