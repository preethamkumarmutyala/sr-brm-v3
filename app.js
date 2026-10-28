// SR BRM dashboard: Now, current / next / past seasons, ride pages, One Week SR, BRM Assistant
const API_BASE = "https://sr-brm-api.secunderabadrandonneurs.workers.dev";
const AUDAX = "https://www.audaxindia.in";
const LEGACY = { "10047": "600", "10048": "200", "10049": "300", "10050": "400" };   // old backup cue-sheet files: data/<distance>.json
const SR_DISTANCES = ["200", "300", "400", "600"];
const WEEK_DAYS = 7;                  // "this week" = rides within 7 days before or after today
const REFRESH_MS = 5 * 60 * 1000;
const CANCELLED = ["2026-11-21"];     // dates whose rides without an Audax page are cancelled (not just "not opened yet")
const LIMIT_H = { "100": 7.5, "150": 10.5, "200": 13.5, "300": 20, "400": 27, "600": 40, "1000": 75, "1200": 90, Fleche: 24 };   // time limit in hours
// Start location pin used when a ride starts at the usual place
const MAPS = "https://maps.app.goo.gl/Fhmnyr6gbKszavAD7";
const MAP_EMBED = "https://www.google.com/maps?q=17.455080,78.494962&z=16&output=embed";

const tilesEl = document.getElementById("tiles");
const detailEl = document.getElementById("detail");
const cache = {}, routeCache = {}, failed = new Set(), queued = new Set();
let rides = [], calendarNote = "";
let current = null, origin = null, query = "", filter = "all";   // origin = the list you came from (for the back button)
let flt = { season: "", status: "all", dist: "all", month: "all" };   // filters on a season page
const secOpen = { riders: true, controls: false, cue: false, map: false };   // which sections of a ride page are open

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "22-Oct-2026 at 23:59 hours" (Audax shows Indian time) -> Date, or null if it can't be read
function closeDate(ev) {
  const m = (ev?.registrationClose || "").match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+at\s+(\d{1,2}):(\d{2})/);
  const mon = m && MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  const p = n => String(n).padStart(2, "0");
  const d = new Date(`${m[3]}-${p(mon)}-${p(m[1])}T${p(m[4])}:${m[5]}:00+05:30`);
  return isNaN(d) ? null : d;
}
// just the "22-Oct-2026 at 23:59 hours" part, without any stray HTML from the source page
const closeText = ev => {
  const t = ev?.registrationClose || "";
  const m = t.match(/\d{1,2}-[A-Za-z]{3}-\d{4}\s+at\s+\d{1,2}:\d{2}(?:\s*hours)?/);
  return m ? m[0] : t.replace(/<[^>]+>/g, "").trim();
};
// Ride start (Indian time) from "600 BRM on 24-Oct-2026" + "06:00"; null if it can't be read
function startDate(ev) {
  const d = (ev?.title || "").match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  const t = (ev?.startTime || "").match(/(\d{1,2}):(\d{2})/);
  const mon = d && MONTHS[d[2].toLowerCase()];
  if (!mon || !t) return null;
  const p = n => String(n).padStart(2, "0");
  const x = new Date(`${d[3]}-${p(mon)}-${p(d[1])}T${p(t[1])}:${t[2]}:00+05:30`);
  return isNaN(x) ? null : x;
}
const hasStarted = ev => { const d = startDate(ev); return !d || Date.now() >= d.getTime(); };
const isClosed = ev => { const d = closeDate(ev); return !!d && Date.now() >= d.getTime() + 60000; };
// "06:00" -> "06:00 AM", "14:30" -> "02:30 PM" (leaves text alone if AM/PM is already there)
const fmtTime = t => {
  t = String(t || "");
  if (/\b(am|pm)\b/i.test(t)) return t;
  return t.replace(/(\d{1,2}):(\d{2})/, (_, h, m) => `${String(+h % 12 || 12).padStart(2, "0")}:${m} ${+h >= 12 ? "PM" : "AM"}`);
};
const loading = msg => `<p class="note">${esc(msg)}</p>`;
const LABELS = { registered: "Registered", ytc: "Yet to confirm", dns: "Did not start",
                 dnf: "Did not finish", lf: "Late finish", finished: "Finished" };

function statusOf(r, started = true) {
  const x = (r.result || "").trim().toUpperCase();
  if (!x) return "registered";
  if (!started && x === "DNS") return "registered";   // Audax lists everyone as DNS until the ride starts
  if (["DNS", "DNF", "LF", "YTC"].includes(x)) return x.toLowerCase();
  return "finished";   // a finishing time such as "12h 07m"
}


// ---------- dates and ride status ----------
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const todayIST = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const dayDiff = iso => Math.round((Date.parse(iso) - Date.parse(todayIST())) / 864e5);
function dateParts(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d, wd: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] };
}
const kmLabel = d => (/^\d/.test(d) ? `${d} km` : d);
const byDate = (a, b) => a.date.localeCompare(b.date) || String(a.distance).localeCompare(String(b.distance));

const pad2 = n => String(n).padStart(2, "0");
function rideWindow(r) {                  // start and end (ms, Indian time): ride date + start time + the time limit of its distance
  const t = ((r.id && cache[r.id]?.startTime) || "").match(/(\d{1,2}):(\d{2})/);
  const start = Date.parse(`${r.date}T${t ? `${pad2(t[1])}:${t[2]}` : "06:00"}:00+05:30`);
  return [start, start + (LIMIT_H[r.distance] ?? 24) * 3600e3];
}
// No Audax page: past (or marked in CANCELLED) = cancelled, future = registration not opened yet.
// With a page: before the start = open/closed, during the time limit = ongoing, afterwards = completed.
function rideStatus(r) {
  if (!r.id) return (r.date < todayIST() || CANCELLED.includes(r.date)) ? { k: "cancel", t: "Event cancelled" } : { k: "soon", t: "Registration not opened" };
  const [start, end] = rideWindow(r), now = Date.now();
  if (now > end) return { k: "done", t: "Completed" };
  if (now >= start) return { k: "ongoing", t: "Ongoing" };
  const ev = cache[r.id];
  if (!ev) return { k: "load", t: failed.has(r.id) ? "Couldn't load" : "Checking…" };
  return isClosed(ev) ? { k: "closed", t: "Registration closed" } : { k: "open", t: "Registration open" };
}
const finishedCount = ev => (ev.riders || []).filter(x => ["finished", "lf"].includes(statusOf(x, true))).length;

// ---------- data ----------
async function fetchEvent(id, force) {
  if (!force && cache[id]) return cache[id];
  const res = await fetch(`${API_BASE}/ev/${id}`);
  if (!res.ok) throw new Error("Server returned " + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  failed.delete(id);
  return (cache[id] = data);
}
async function fetchRoute(id, force) {   // controls + cue sheet from the Audax route card (via the Worker)
  if (!force && routeCache[id] !== undefined) return routeCache[id];
  try {
    const r = await fetch(`${API_BASE}/rt/${id}?v=2`);
    const j = r.ok ? await r.json() : null;
    if (j && !j.error && j.cue?.length) return (routeCache[id] = j);
  } catch (_) { /* try the backup file below */ }
  routeCache[id] = null;
  if (LEGACY[id]) {                       // backup files exist only for the first four rides
    try {
      const r = await fetch(`data/${LEGACY[id]}.json`);
      const j = r.ok ? await r.json() : null;
      if (j) routeCache[id] = {
        controls: (j.controls || []).map(c => ({ location: c.location, type: c.type, km: c.km })),
        cue: (j.cueSheet || []).map(c => ({ location: c.instruction, km: c.km }))
      };
    } catch (_) { /* leave null */ }
  }
  return routeCache[id];
}
async function loadCalendar() {
  try {
    const r = await fetch(`${API_BASE}/calendar`);
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.error || "Server returned " + r.status);
    rides = (j.rides || []).slice().sort(byDate);
    calendarNote = (j.errors || []).join("; ");
  } catch (err) {
    calendarNote = "Could not load the ride calendar (" + err.message + ").";
  }
}
const weekRides = () => rides.filter(r => r.id && Math.abs(dayDiff(r.date)) <= WEEK_DAYS);
const loadWeek = force => Promise.allSettled(weekRides().map(r => fetchEvent(r.id, force)));

function srIds() {                      // the four One Week SR distances among this week's rides, or null if one is missing
  const wk = weekRides(), ids = {};
  for (const d of SR_DISTANCES) { const r = wk.find(x => x.distance === d); if (!r) return null; ids[d] = r.id; }
  return ids;
}
function srRiders() {                   // riders registered for all four
  const ids = srIds();
  if (!ids || !SR_DISTANCES.every(d => cache[ids[d]])) return null;
  const map = {};
  SR_DISTANCES.forEach(d => (cache[ids[d]].riders || []).forEach(r => {
    const k = (r.air || r.name).toLowerCase();
    (map[k] ||= { air: r.air, name: r.name, club: r.club, rides: new Set() }).rides.add(d);
  }));
  return Object.values(map).filter(r => r.rides.size === SR_DISTANCES.length);
}

// ---------- navigation: Now, Current season, Next season, Past seasons ----------
const isSeason = v => /^y\d{4}$/.test(v || "");
const isList = v => v === "dashboard" || v === "past" || isSeason(v);
const thisYear = () => Number(todayIST().slice(0, 4));
const navKey = v => (isSeason(v) && Number(v.slice(1)) < thisYear() ? "past" : v);     // old seasons all light up "Past seasons"
const lit = () => navKey(isList(current) || current === "sr" || current === "assistant" ? current : origin);
function renderTiles() {
  const today = todayIST(), f = dateParts(today), cy = thisYear(), on = lit();
  const years = [...new Set(rides.map(r => Number(r.date.slice(0, 4))))].sort((a, b) => a - b);
  const past = years.filter(y => y < cy);
  const n = y => rides.filter(r => r.date.startsWith(String(y))).length;
  const main = (key, title, sub) => `<button class="mainbtn" data-d="${key}" aria-pressed="${on === key}"><b>${title}</b><span>${sub}</span></button>`;
  const tool = (key, title) => `<button class="subbtn" data-d="${key}" aria-pressed="${on === key}">${title}</button>`;
  tilesEl.innerHTML = `<div class="mainnav">` +
    main("dashboard", "Now", `${MONTH_NAMES[f.m - 1]} ${f.y} · ${rides.filter(r => r.date.slice(0, 7) === today.slice(0, 7)).length} rides`) +
    main("y" + cy, "Current season", `${cy} · ${n(cy)} rides`) +
    main("y" + (cy + 1), "Next season", `${cy + 1} · ${n(cy + 1)} rides`) +
    (past.length ? main("past", "Past seasons", past.length > 1 ? `${past[0]} to ${past[past.length - 1]}` : `${past[0]}`) : "") +
    `</div><div class="subnav">${srIds() ? tool("sr", "One Week SR") : ""}${tool("assistant", "BRM Assistant")}</div>`;
}
tilesEl.addEventListener("click", e => { const b = e.target.closest("[data-d]"); if (b) location.hash = b.dataset.d; });

// ---------- event view ----------
// copy each column heading onto its cells so tables can turn into stacked cards on phones
function labelCells(root) {
  root.querySelectorAll("table").forEach(t => {
    const heads = [...t.querySelectorAll("thead th")].map(h => h.textContent.trim());
    t.querySelectorAll("tbody tr").forEach(tr => [...tr.children].forEach((td, i) => {
      if (heads[i] && td.colSpan === 1) td.dataset.label = heads[i];
    }));
  });
}
// heads: "Name" or ["Name", "num"] (num = right-aligned number column)
const table = (heads, rows) => `<div class="scroll"><table><thead><tr>${heads.map(h => {
  const [t, c] = [].concat(h); return `<th${c ? ` class="${c}"` : ""}>${t}</th>`; }).join("")}</tr></thead>
  <tbody>${rows}</tbody></table></div>`;
const km2 = v => (v !== "" && v != null && isFinite(+v)) ? (+v).toFixed(2) : (v ?? "");   // 89.7 -> 89.70, like the official sheet

function startMap(ev) {                  // the usual start has an exact pin; other starts are searched by name
  if (!ev.startLocation || /kendriya/i.test(ev.startLocation)) return { link: MAPS, embed: MAP_EMBED };
  const q = encodeURIComponent(ev.startLocation + ", Secunderabad");
  return { link: `https://www.google.com/maps/search/?api=1&query=${q}`, embed: `https://www.google.com/maps?q=${q}&output=embed` };
}

const cleanName = n => (n && n.length <= 80 ? n : "");        // ignore a ride name that is clearly page text
const sec = (key, title, count, body) => `<details class="sect" data-sec="${key}" ${secOpen[key] ? "open" : ""}>
  <summary>${title}${count != null ? ` <span class="count">${count}</span>` : ""}</summary>${body}</details>`;

function renderDetail() {
  const ev = cache[current]; if (!ev) return;
  const route = routeCache[current];
  const ride = rides.find(r => r.id === current) || { id: current, date: ev.date || todayIST(), distance: ev.distance };
  const status = rideStatus(ride);
  const closed = isClosed(ev), over = closed || status.k === "done" || status.k === "ongoing";
  const map = startMap(ev), name = cleanName(ev.rideName);
  const f = dateParts(ev.date || ride.date);
  const dateStr = `${f.wd} ${f.d} ${MON[f.m - 1]} ${f.y}`;
  const riders = ev.riders || [];
  const started = hasStarted(ev);
  const count = k => riders.filter(r => statusOf(r, started) === k).length;
  const paid = riders.filter(r => /^y/i.test(r.fee)).length;
  const stats = [["Registered", riders.length], ["Fee paid", paid], ["Finished", count("finished") + count("lf")],
                 ["Did not start", count("dns")], ["Did not finish", count("dnf")]]
    .map(([l, n]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");
  const say = {
    open: `Registration is open until ${closeText(ev)}. Use “Register on Audax India” to sign up.`,
    closed: `Registration is closed. The ride starts on ${dateStr} at ${fmtTime(ev.startTime) || "the announced time"}.`,
    ongoing: "This ride is happening now. Results appear in the table below as riders finish.",
    done: "This ride is finished. The results are in the table below."
  }[status.k] || "";

  // Controls and cue sheet come from the Audax route card: Location, Type, then distances and times
  const ctl = route?.controls || [];
  const ctlTimes = ctl.some(c => c.open || c.close);
  const when = v => (v ? esc(fmtTime(v)) : "");
  const controls = ctl.map(c => `<tr><td>${esc(c.location)}</td><td>${esc(c.type)}</td><td class="num">${esc(km2(c.km))}</td>` +
    (ctlTimes ? `<td class="num">${when(c.open)}</td><td class="num">${when(c.close)}</td>` : "") + `</tr>`).join("");
  const controlHeads = ["Location", "Type", ["KM", "num"], ...(ctlTimes ? [["Opens", "num"], ["Closes", "num"]] : [])];
  const cue = route?.cue || [];
  const cueType = cue.some(c => c.type);
  const cues = cue.map((c, i) => {
    const prev = i ? +cue[i - 1].km : 0;
    const partial = c.partial ? c.partial : (isFinite(+c.km) && isFinite(prev) ? (+c.km - prev).toFixed(2) : "");
    return `<tr${c.control ? ' class="ctl"' : ""}><td>${esc(c.location)}</td>${cueType ? `<td>${esc(c.type)}</td>` : ""}<td class="num">${esc(km2(partial))}</td><td class="num">${esc(km2(c.km))}</td></tr>`;
  }).join("");
  const cueHeads = ["Location", ...(cueType ? ["Type"] : []), ["Partial km", "num"], ["Total km", "num"]];
  const back = origin && origin !== "dashboard" ? `${origin.slice(1)} season` : "Now";

  detailEl.innerHTML = `
    <a class="back" href="#${origin || "dashboard"}">&larr; Back to ${back}</a>
    <div class="head">
      <div class="info">
        <h2>${esc(name || ev.title || kmLabel(ev.distance))} <span class="chip ${status.k}">${esc(status.t)}</span></h2>
        <p class="rname-line">${esc(ev.title || "")}</p>
        ${say ? `<div class="banner ${status.k}">${esc(say)}</div>` : ""}
        <dl class="facts">
          <dt>Date</dt><dd>${dateStr}</dd>
          <dt>Start time</dt><dd>${esc(fmtTime(ev.startTime) || "Not announced")}</dd>
          <dt>Starting point</dt><dd>${esc(ev.startLocation || "Not announced")} <a href="${map.link}" target="_blank" rel="noopener">Open in Google Maps</a></dd>
          <dt>${closed ? "Registration closed" : "Registration closes"}</dt><dd>${esc(closeText(ev) || "Not announced")}</dd>
          ${route?.info?.distance ? `<dt>Distance</dt><dd>${esc(km2(route.info.distance))} km${route.info.brevet ? ` (${esc(route.info.brevet)} km brevet)` : ""}</dd>` : ""}
        </dl>
      </div>
      <div class="actions">
        ${ev.routeMap ? `<a class="btn" href="${esc(ev.routeMap)}" target="_blank" rel="noopener">View route</a>` : ""}
        ${over ? `<span class="btn off" aria-disabled="true">${status.k === "done" ? "Ride completed" : status.k === "ongoing" ? "Ride in progress" : "Registration closed"}</span>`
               : `<a class="btn alt" href="${AUDAX}/event-e-${esc(current)}" target="_blank" rel="noopener">Register on Audax India</a>`}
        <a class="btn alt" href="${AUDAX}/member-login.php" target="_blank" rel="noopener">Rider login</a>
      </div>
    </div>
    ${sec("riders", "Riders and results", riders.length, `
      <div class="stats">${stats}</div>
      <div class="tools">
        <input id="q" type="search" placeholder="Search name, AIR number or club" aria-label="Search riders" value="${esc(query)}">
        <select id="f" aria-label="Filter by status">
          ${["all", "registered", "finished", "lf", "ytc", "dns", "dnf"].map(k =>
            `<option value="${k}" ${k === filter ? "selected" : ""}>${k === "all" ? "All riders" : LABELS[k]}</option>`).join("")}
        </select>
        <span class="meta" id="meta"></span>
        <button class="btn alt" id="refresh" type="button">Refresh</button>
      </div>
      <div class="scroll"><table>
        <thead><tr><th>#</th><th>Rider</th><th>AIR no.</th><th>Club</th><th>Fee paid</th><th>Medal</th><th>Result</th><th>Status</th></tr></thead>
        <tbody id="rows"></tbody></table></div>`)}
    ${controls ? sec("controls", "Controls (check-points)", ctl.length, table(controlHeads, controls)) : ""}
    ${cues ? sec("cue", "Cue sheet (turn by turn)", cue.length, table(cueHeads, cues)) : (route === null ? '<p class="note">Controls and cue sheet are not on Audax yet.</p>' : "")}
    ${sec("map", "Start location map", null, `<iframe class="map" title="Start location map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${map.embed}"></iframe>`)}`;

  document.getElementById("q").addEventListener("input", e => { query = e.target.value; renderRows(); });
  document.getElementById("f").addEventListener("change", e => { filter = e.target.value; renderRows(); });
  document.getElementById("refresh").addEventListener("click", () => showEvent(current, true));
  renderRows();
}

function renderRows() {
  const ev = cache[current]; if (!ev) return;
  const q = query.trim().toLowerCase();
  const started = hasStarted(ev);
  const list = ev.riders.filter(r => (filter === "all" || statusOf(r, started) === filter) &&
    (!q || [r.name, r.air, r.club].some(v => (v || "").toLowerCase().includes(q))));
  document.getElementById("rows").innerHTML = list.length ? list.map(r => {
    const s = statusOf(r, started), label = LABELS[s];
    const res = (r.result || "").trim();   // exactly what Audax shows in its Result column
    return `<tr><td>${esc(r.seq)}</td><td>${esc(r.name)}</td><td>${esc(r.air)}</td><td>${esc(r.club)}</td>
      <td>${esc(r.fee)}</td><td>${esc(r.medal)}</td><td class="res">${esc(res)}</td><td><span class="tag ${s}">${esc(label)}</span></td></tr>`;
  }).join("") : `<tr><td colspan="8" class="note">No riders match. Clear the search or choose "All riders".</td></tr>`;
  const t = ev.fetchedAt ? new Date(ev.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  document.getElementById("meta").textContent = `${list.length} of ${ev.riders.length} shown` + (t ? ` · updated ${t}` : "");
  labelCells(detailEl);
}

function showError(msg, retry) {
  detailEl.innerHTML = `<p class="error">${esc(msg)}</p><button class="btn alt" id="retry" type="button">Refresh</button>`;
  document.getElementById("retry").addEventListener("click", retry);
}

async function showEvent(id, force) {
  if (!cache[id] || force) detailEl.innerHTML = loading("Loading ride details…");
  try { await fetchEvent(id, force); }
  catch (err) {
    failed.add(id);
    if (current === id) showError(`Could not load this ride (${err.message}). Try again in a minute.`, () => showEvent(id, true));
    return;
  }
  await fetchRoute(id, force);
  if (current !== id) return;
  renderTiles(); renderDetail();
}

// ---------- ride cards, Now page, season pages ----------
const NOTES = {
  soon: "Registration has not opened yet. This ride will switch to open by itself as soon as its page is created on Audax.",
  cancel: "This ride was cancelled."
};
function cardHtml(r) {
  const s = rideStatus(r), ev = r.id ? cache[r.id] : null, f = dateParts(r.date), name = cleanName(ev?.rideName);
  const sub = ev ? `${ev.riderCount} riders` + (s.k === "done" ? ` · ${finishedCount(ev)} finished` : "") : "";
  const inner = `<div class="rdate"><b>${f.d}</b><span>${f.wd}, ${MON[f.m - 1]}</span></div>
    <div class="rmain"><b>${esc(kmLabel(r.distance))}</b>${name ? `<span class="rname">${esc(name)}</span>` : ""}${sub ? `<span class="rsub">${sub}</span>` : ""}</div>
    <span class="chip ${s.k}">${esc(s.t)}</span>`;
  return r.id
    ? `<a class="ride" data-ride="${r.id}" href="#e${r.id}">${inner}</a>`
    : `<button type="button" class="ride off" data-toggle data-ride="u-${r.date}-${r.distance}">${inner}<span class="rnote">${esc(NOTES[s.k] || "")}</span></button>`;
}
function updateCard(id) {
  const r = rides.find(x => x.id === id), el = document.querySelector(`[data-ride="${id}"]`);
  if (!r || !el) return;
  const t = document.createElement("template");
  t.innerHTML = cardHtml(r).trim();
  el.replaceWith(t.content.firstElementChild);
}
async function loadDetails(ids) {         // fills in names, rider counts and status a few rides at a time
  const todo = ids.filter(id => !cache[id] && !queued.has(id));
  todo.forEach(id => queued.add(id));
  let i = 0;
  const lane = async () => {
    while (i < todo.length) {
      const id = todo[i++];
      try { await fetchEvent(id); } catch (_) { failed.add(id); }
      queued.delete(id);
      updateCard(id);
    }
  };
  await Promise.all([lane(), lane(), lane()]);
}
function monthGroups(list) {              // cards under month headings (list is in date order)
  let html = "", key = "";
  for (const r of list) {
    const k = r.date.slice(0, 7);
    if (k !== key) {
      if (key) html += "</div>";
      key = k;
      const [y, m] = k.split("-").map(Number);
      html += `<h3 class="sec">${MONTH_NAMES[m - 1]} ${y}</h3><div class="rides">`;
    }
    html += cardHtml(r);
  }
  return key ? html + "</div>" : html;
}
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// NOW: this month's rides sorted by what matters today
function renderDashboard() {
  const today = todayIST(), f = dateParts(today);
  const list = rides.filter(r => r.date.slice(0, 7) === today.slice(0, 7));
  const k = r => rideStatus(r).k;
  const groups = [
    ["Happening now", list.filter(r => k(r) === "ongoing")],
    ["Coming up this month", list.filter(r => ["open", "closed", "load", "soon"].includes(k(r)))],
    ["Completed this month", list.filter(r => k(r) === "done")],
    ["Cancelled", list.filter(r => k(r) === "cancel")]
  ];
  let html = `<h2>Now</h2><p class="note">Today is ${f.wd} ${f.d} ${MON[f.m - 1]} ${f.y}. ` +
    (list.length ? groups.filter(g => g[1].length).map(g => `${g[1].length} ${g[0].toLowerCase()}`).join(", ") + "." : "There are no rides this month.") + `</p>`;
  if (calendarNote) html += `<p class="note error">${esc(calendarNote)}</p>`;
  for (const [title, items] of groups) if (items.length) html += `<h3 class="sec">${title}</h3><div class="rides">${items.map(cardHtml).join("")}</div>`;
  const next = rides.find(r => r.date.slice(0, 7) > today.slice(0, 7));
  if (next) { const n = dateParts(next.date); html += `<p class="note">After this month: ${n.wd} ${n.d} ${MON[n.m - 1]} ${n.y}, ${esc(kmLabel(next.distance))} (${esc(rideStatus(next).t.toLowerCase())}).</p>`; }
  detailEl.innerHTML = html;
  loadDetails(list.filter(r => r.id).map(r => r.id));
}

// SEASON: every ride of one year, with tap-to-filter summary, month strip and distance chips
const groupOf = r => ({ done: "done", cancel: "cancel", soon: "soon" }[rideStatus(r).k] || "live");
const distOf = r => (r.distance === "Fleche" ? "Fleche" : Number(r.distance) >= 1000 ? "1000+" : r.distance);
const GROUPS = [["all", "All rides"], ["done", "Completed"], ["live", "On now / coming up"], ["soon", "Not opened yet"], ["cancel", "Cancelled"]];
function renderSeason(year) {
  if (flt.season !== year) flt = { season: year, status: "all", dist: "all", month: "all" };
  const cy = thisYear(), y = Number(year);
  const label = y === cy ? "Current season" : y > cy ? "Next season" : "Past season";
  const about = y === cy ? "Everything planned this year. Tap a ride for details, or tap the boxes, months and distances below to narrow the list."
    : y > cy ? "The plan for next season. Rides show “Registration not opened” until they are created on Audax; they open here by themselves."
    : "A finished season. Tap a ride to see its riders and results.";
  const all = rides.filter(r => r.date.startsWith(year));
  const list = all.filter(r => (flt.status === "all" || groupOf(r) === flt.status) && (flt.dist === "all" || distOf(r) === flt.dist) &&
                               (flt.month === "all" || r.date.slice(5, 7) === flt.month));
  const dists = ["200", "300", "400", "600", "1000+", "Fleche"].filter(d => all.some(r => distOf(r) === d));
  const active = flt.status !== "all" || flt.dist !== "all" || flt.month !== "all";
  const chipSt = ([g, t]) => `<button type="button" class="fchip" data-st="${g}" aria-pressed="${flt.status === g}"><b>${g === "all" ? all.length : all.filter(r => groupOf(r) === g).length}</b><span>${t}</span></button>`;
  const months = MON.map((m, i) => { const mm = String(i + 1).padStart(2, "0"), c = all.filter(r => r.date.slice(5, 7) === mm).length;
    return `<button type="button" class="mchip" data-month="${mm}" aria-pressed="${flt.month === mm}" ${c ? "" : "disabled"}>${m}<small>${c || ""}</small></button>`; }).join("");

  detailEl.innerHTML = `<h2>${year} season <span class="chip">${label}</span></h2><p class="note">${about}</p>
    ${calendarNote ? `<p class="note error">${esc(calendarNote)}</p>` : ""}
    <div class="fchips">${GROUPS.map(chipSt).join("")}</div>
    <div class="flabel">Month</div><div class="months">${months}</div>
    ${dists.length > 1 ? `<div class="flabel">Distance</div><div class="dchips">${dists.map(d =>
      `<button type="button" class="dchip" data-dist="${d}" aria-pressed="${flt.dist === d}">${d === "Fleche" ? "Fleche" : d + " km"}</button>`).join("")}</div>` : ""}
    ${active ? `<p class="note">Showing ${plural(list.length, "ride", "rides")} of ${all.length}. <button type="button" class="linkbtn" data-clear>Show all rides</button></p>` : ""}
    ${list.length ? monthGroups(list) : `<p class="note">No rides match these choices. <button type="button" class="linkbtn" data-clear>Show all rides</button></p>`}`;
  loadDetails(list.filter(r => r.id).map(r => r.id));
}

// PAST SEASONS: pick a year
function renderPast() {
  const cy = thisYear();
  const years = [...new Set(rides.map(r => Number(r.date.slice(0, 4))))].filter(y => y < cy).sort((a, b) => b - a);
  detailEl.innerHTML = `<h2>Past seasons</h2><p class="note">Seasons before ${cy}. Pick a season to see all of its rides.</p>` +
    (years.length ? `<div class="seasons">${years.map(y => {
      const l = rides.filter(r => r.date.startsWith(String(y))), s = l.map(r => rideStatus(r).k);
      const d = s.filter(x => x === "done").length, c = s.filter(x => x === "cancel").length;
      return `<a class="seasonlink" href="#y${y}"><b>${y} season</b><span>${plural(l.length, "ride", "rides")} · ${d} completed${c ? ` · ${c} cancelled` : ""}</span></a>`;
    }).join("")}</div>` : `<p class="note">No past seasons on the calendar yet.</p>`);
}
const renderCurrentList = () => (current === "dashboard" ? renderDashboard() : current === "past" ? renderPast() : renderSeason(current.slice(1)));

// taps inside the page: filters, "not opened / cancelled" cards, remembered open sections
detailEl.addEventListener("click", e => {
  const t = e.target.closest("[data-st],[data-dist],[data-month],[data-clear],[data-toggle]");
  if (!t) return;
  if (t.hasAttribute("data-toggle")) { t.classList.toggle("open"); return; }
  if (!isSeason(current)) return;
  const flip = (key, v) => { flt[key] = flt[key] === v ? "all" : v; };
  if (t.dataset.clear !== undefined) flt = { season: flt.season, status: "all", dist: "all", month: "all" };
  else if (t.dataset.st) flip("status", t.dataset.st);
  else if (t.dataset.dist) flip("dist", t.dataset.dist);
  else if (t.dataset.month) flip("month", t.dataset.month);
  renderSeason(current.slice(1));
});
detailEl.addEventListener("toggle", e => { const k = e.target.dataset?.sec; if (k) secOpen[k] = e.target.open; }, true);

// ---------- One Week SR ----------
async function showSR(force) {
  detailEl.innerHTML = loading("Loading riders for all four rides…");
  const res = await loadWeek(force);
  if (current !== "sr") return;
  if (!srIds()) { detailEl.innerHTML = `<h2>One Week SR riders</h2><p class="note">One Week SR needs a 200, 300, 400 and 600 km ride in the same week, and that isn't the case right now.</p>`; return; }
  if (res.some(r => r.status === "rejected"))
    return showError("Could not load all four events, so the list would be incomplete. Try again in a minute.", () => showSR(true));
  renderTiles(); renderSR();
}
function renderSR() {
  const list = srRiders() || [];
  const rows = list.map(r => `<tr><td>${esc(r.air)}</td><td>${esc(r.name)}</td><td>${esc(r.club)}</td>
    ${SR_DISTANCES.map(() => "<td>✅</td>").join("")}</tr>`).join("");
  detailEl.innerHTML = `<h2>One Week SR riders</h2>
    <p class="note">Riders registered for all four rides (200, 300, 400 and 600 km): <b>${list.length}</b></p>
    ${table(["AIR no.", "Rider", "Club", ...SR_DISTANCES], rows || `<tr><td colspan="7" class="note">No rider is registered for all four rides yet.</td></tr>`)}`;
  labelCells(detailEl);
}

// ---------- BRM Assistant ----------
function showAssistant() {
  detailEl.innerHTML = `<h2>BRM Assistant</h2>
    <p class="note">Try: "600 riders", "200 controls", "start time of 400", "start location of 200",
    "registration close of 300", "one week sr riders", "next rides".</p>
    <div class="ask"><input id="qa" type="text" placeholder="Ask BRM Assistant…" aria-label="Your question">
    <button class="btn" id="askBtn" type="button">Ask</button></div>
    <div id="answer" aria-live="polite"></div>`;
  document.getElementById("askBtn").addEventListener("click", ask);
  document.getElementById("qa").addEventListener("keydown", e => { if (e.key === "Enter") ask(); });
}
async function ask() {
  const q = document.getElementById("qa").value.toLowerCase().trim();
  const out = document.getElementById("answer");
  if (!q) return;
  out.textContent = "Loading…";

  if (/\b(next|upcoming|calendar)\b/.test(q)) {
    const next = rides.filter(r => r.date >= todayIST()).slice(0, 6);
    out.innerHTML = `<h3>Next rides</h3>` + (next.map(r => { const f = dateParts(r.date);
      return `${f.wd} ${f.d} ${MON[f.m - 1]} ${f.y} - ${esc(kmLabel(r.distance))} - ${esc(rideStatus(r).t)}`; }).join("<br>") || "No rides on the calendar.");
    return;
  }
  await loadWeek();
  const wk = weekRides();

  if (q.includes("one week sr")) {
    const list = srRiders();
    out.innerHTML = list
      ? `<h3>One Week SR riders (${list.length})</h3>` + (list.map(r => `${esc(r.air)} - ${esc(r.name)}`).join("<br>") || "No rider is registered for all four rides yet.")
      : "One Week SR needs a 200, 300, 400 and 600 km ride in the same week.";
    return;
  }
  const m = q.match(/(200|300|400|600|1000|1200)/);
  if (!m) { out.textContent = "Mention a distance such as 200, 300, 400 or 600, or ask about one week sr or the next rides."; return; }
  const d = m[1], ride = wk.find(x => x.distance === d), ev = ride && cache[ride.id];
  if (!ev) { out.textContent = `There is no ${d} km ride this week (or it could not be loaded). Try "next rides".`; return; }
  const head = `<h3>${esc(ev.title)}</h3>`;

  if (q.includes("riders")) out.innerHTML = `${head}Riders: <b>${ev.riderCount}</b><hr>` + ev.riders.map(r => `${esc(r.air)} - ${esc(r.name)}`).join("<br>");
  else if (q.includes("start time")) out.innerHTML = `${head}Start time: <b>${esc(fmtTime(ev.startTime))}</b>`;
  else if (q.includes("start location")) out.innerHTML = `${head}Start location: <b>${esc(ev.startLocation)}</b> <a href="${startMap(ev).link}" target="_blank" rel="noopener">Open in Google Maps</a>`;
  else if (q.includes("registration")) out.innerHTML = `${head}${isClosed(ev) ? "Registration closed" : "Registration closes"}: <b>${esc(closeText(ev))}</b>`;
  else if (q.includes("controls")) {
    const route = await fetchRoute(ride.id);
    out.innerHTML = `<h3>${d} controls</h3>` + ((route?.controls || []).map(c => `${esc(km2(c.km))} km - ${esc(c.location)}`).join("<br>") || "No controls listed yet.");
  } else out.textContent = "Question not understood. Try one of the examples above.";
}

// ---------- routing and refresh ----------
function select() {
  const h = location.hash.slice(1), wk = weekRides();
  const byDistance = /^(200|300|400|600)$/.test(h) ? wk.find(r => r.distance === h) : null;   // old links like #600
  if (/^e\d+$/.test(h)) current = h.slice(1);
  else if (byDistance) current = byDistance.id;
  else if (isList(h) || h === "sr" || h === "assistant") current = h;
  else current = "dashboard";
  if (current === "dashboard" || isSeason(current)) origin = current;
  else if (!origin && !["sr", "assistant", "past"].includes(current)) {                      // opened a ride link directly
    const r = rides.find(x => x.id === current);
    origin = r ? (r.date.slice(0, 7) === todayIST().slice(0, 7) ? "dashboard" : "y" + r.date.slice(0, 4)) : "dashboard";
  }
  renderTiles();
  window.scrollTo?.(0, 0);
  if (current === "sr") showSR();
  else if (current === "assistant") showAssistant();
  else if (isList(current)) renderCurrentList();
  else showEvent(current);
}
window.addEventListener("hashchange", select);

setInterval(async () => {
  await loadCalendar();
  await loadWeek(true);
  renderTiles();
  if (document.activeElement?.tagName === "INPUT") return;   // don't disturb typing
  if (cache[current]) renderDetail();
  else if (current === "sr") renderSR();
  else if (isList(current)) renderCurrentList();
}, REFRESH_MS);

(async () => {
  detailEl.innerHTML = loading("Loading rides…");
  await loadCalendar();
  select();
  loadWeek().then(renderTiles);
})();
