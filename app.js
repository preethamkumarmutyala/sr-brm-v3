// SR BRM dashboard: this week, upcoming and past rides, riders, controls, cue sheet, One Week SR, BRM Assistant
const API_BASE = "https://sr-brm-api.secunderabadrandonneurs.workers.dev";
const AUDAX = "https://www.audaxindia.in";
const LEGACY = { "10047": "600", "10048": "200", "10049": "300", "10050": "400" };   // old backup cue-sheet files: data/<distance>.json
const SR_DISTANCES = ["200", "300", "400", "600"];
const WEEK_DAYS = 7;                  // "this week" = rides within 7 days before or after today
const REFRESH_MS = 5 * 60 * 1000;
// Start location pin used when a ride starts at the usual place
const MAPS = "https://maps.app.goo.gl/Fhmnyr6gbKszavAD7";
const MAP_EMBED = "https://www.google.com/maps?q=17.455080,78.494962&z=16&output=embed";

const tilesEl = document.getElementById("tiles");
const detailEl = document.getElementById("detail");
const cache = {}, routeCache = {}, failed = new Set(), queued = new Set();
let rides = [], calendarNote = "";
let current = null, query = "", filter = "all";

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

// Past ride with no Audax page = cancelled; future ride with no page = registration not opened yet
function rideStatus(r) {
  const past = r.date < todayIST();
  if (!r.id) return past ? { k: "cancel", t: "Event cancelled" } : { k: "soon", t: "Registration not opened" };
  const ev = cache[r.id];
  if (!ev) return { k: "load", t: failed.has(r.id) ? "Couldn't load" : "Checking…" };
  if (past) return { k: "done", t: "Completed" };
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

// ---------- tiles ----------
function renderTiles() {
  const today = todayIST(), sr = srRiders(), hasSR = !!srIds();
  const wk = weekRides().map(r => {
    const ev = cache[r.id], f = dateParts(r.date);
    return `<button class="tile" data-d="e${r.id}" aria-pressed="${r.id === current}">
      <b>${esc(kmLabel(r.distance))}</b>
      <span>${f.wd} ${f.d} ${MON[f.m - 1]} · ${esc(fmtTime(ev?.startTime) || "time to be announced")}</span>
      <span>${ev ? ev.riderCount + " registered" : "Loading…"}</span>
      ${ev && isClosed(ev) ? '<span class="closed">Registration closed</span>' : ""}</button>`;
  }).join("");
  const tile = (key, title, sub) => `<button class="tile" data-d="${key}" aria-pressed="${current === key}"><b>${title}</b><span>${sub}</span></button>`;
  tilesEl.innerHTML = wk +
    tile("upcoming", "Upcoming", `${rides.filter(r => r.date >= today).length} rides planned`) +
    tile("past", "Past rides", `${rides.filter(r => r.date < today).length} rides`) +
    (hasSR ? tile("sr", "One Week SR", sr ? sr.length + " riders in all 4 rides" : "Loading…") : "") +
    tile("assistant", "BRM Assistant", "Ask about any ride");
}
tilesEl.addEventListener("click", e => { const t = e.target.closest(".tile"); if (t) location.hash = t.dataset.d; });

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

function renderDetail() {
  const ev = cache[current]; if (!ev) return;
  const route = routeCache[current];
  const ride = rides.find(r => r.id === current) || { id: current, date: ev.date || todayIST(), distance: ev.distance };
  const status = rideStatus(ride);
  const closed = isClosed(ev), over = closed || status.k === "done";
  const map = startMap(ev);
  const riders = ev.riders || [];
  const started = hasStarted(ev);
  const count = k => riders.filter(r => statusOf(r, started) === k).length;
  const paid = riders.filter(r => /^y/i.test(r.fee)).length;
  const stats = [["Registered", riders.length], ["Fee paid", paid], ["Finished", count("finished") + count("lf")],
                 ["Did not start", count("dns")], ["Did not finish", count("dnf")]]
    .map(([l, n]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");

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

  detailEl.innerHTML = `
    <div class="head">
      <div class="info">
        <h2>${esc(ev.title || kmLabel(ev.distance))} <span class="chip ${status.k}">${esc(status.t)}</span></h2>
        ${ev.rideName ? `<p class="rname-line">${esc(ev.rideName)}</p>` : ""}
        <dl class="facts">
          <dt>Start</dt><dd>${esc(fmtTime(ev.startTime) || "Not announced")}</dd>
          <dt>Starting point</dt><dd>${esc(ev.startLocation || "Not announced")}
            <a href="${map.link}" target="_blank" rel="noopener">Open in Google Maps</a></dd>
          <dt>${closed ? "Registration closed" : "Registration closes"}</dt><dd>${esc(closeText(ev) || "Not announced")} ${closed ? '<span class="tag dns">Closed</span>' : ""}</dd>
          ${route?.info?.distance ? `<dt>Distance</dt><dd>${esc(km2(route.info.distance))} km${route.info.brevet ? ` (${esc(route.info.brevet)} km brevet)` : ""}</dd>` : ""}
        </dl>
        <iframe class="map" title="Start location map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${map.embed}"></iframe>
      </div>
      <div class="actions">
        ${ev.routeMap ? `<a class="btn" href="${esc(ev.routeMap)}" target="_blank" rel="noopener">View route</a>` : ""}
        ${over ? `<span class="btn off" aria-disabled="true">${status.k === "done" ? "Ride completed" : "Registration closed"}</span>`
               : `<a class="btn alt" href="${AUDAX}/event-e-${esc(current)}" target="_blank" rel="noopener">Register on Audax India</a>`}
        <a class="btn alt" href="${AUDAX}/member-login.php" target="_blank" rel="noopener">Rider login</a>
        <a class="btn alt" href="#${status.k === "done" ? "past" : "upcoming"}">&larr; All ${status.k === "done" ? "past" : "upcoming"} rides</a>
      </div>
    </div>
    <div class="stats">${stats}</div>
    <h3 class="sec">Fellow riders</h3>
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
      <tbody id="rows"></tbody></table></div>
    ${controls ? `<h3 class="sec">Controls</h3>${table(controlHeads, controls)}` : ""}
    ${cues ? `<h3 class="sec">Cue sheet</h3>${table(cueHeads, cues)}` : (route === null ? '<p class="note">The cue sheet is not available on Audax yet.</p>' : "")}`;

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

// ---------- upcoming and past lists ----------
function cardHtml(r) {
  const s = rideStatus(r), ev = r.id ? cache[r.id] : null, f = dateParts(r.date);
  const sub = ev ? `${ev.riderCount} riders` + (s.k === "done" ? ` · ${finishedCount(ev)} finished` : "") : "";
  const inner = `<div class="rdate"><b>${f.d}</b><span>${f.wd}, ${MON[f.m - 1]}</span></div>
    <div class="rmain"><b>${esc(kmLabel(r.distance))}</b>${ev?.rideName ? `<span class="rname">${esc(ev.rideName)}</span>` : ""}${sub ? `<span class="rsub">${sub}</span>` : ""}</div>
    <span class="chip ${s.k}">${esc(s.t)}</span>`;
  return r.id ? `<a class="ride" data-ride="${r.id}" href="#e${r.id}">${inner}</a>`
              : `<div class="ride off" data-ride="u-${r.date}-${r.distance}">${inner}</div>`;
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
function renderList(kind) {
  const today = todayIST(), past = kind === "past";
  const list = rides.filter(r => (past ? r.date < today : r.date >= today)).sort((a, b) => (past ? byDate(b, a) : byDate(a, b)));
  let html = `<h2>${past ? "Past rides" : "Upcoming rides"}</h2>`;
  if (calendarNote) html += `<p class="note error">${esc(calendarNote)}</p>`;
  html += `<p class="note">${past
    ? "Rides before today. A past ride that never got an event page on Audax is shown as cancelled."
    : "Rides from today onwards. A ride switches to open for registration by itself once its event page is created on Audax."}</p>`;
  if (!list.length) html += `<p class="note">No rides to show.</p>`;
  let key = "";
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
  if (key) html += "</div>";
  detailEl.innerHTML = html;
  loadDetails(list.filter(r => r.id).map(r => r.id));
}

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
  else if (["upcoming", "past", "sr", "assistant"].includes(h)) current = h;
  else current = wk[0]?.id || "upcoming";
  renderTiles();
  if (current === "sr") showSR();
  else if (current === "assistant") showAssistant();
  else if (current === "upcoming" || current === "past") renderList(current);
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
  else if (current === "upcoming" || current === "past") renderList(current);
}, REFRESH_MS);

(async () => {
  detailEl.innerHTML = loading("Loading rides…");
  await loadCalendar();
  select();
  loadWeek().then(renderTiles);
})();
