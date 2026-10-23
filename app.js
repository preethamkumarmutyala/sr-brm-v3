// SR BRM dashboard: events, riders, controls, cue sheet, One Week SR, BRM Assistant
const API_BASE = "https://sr-brm-api.secunderabadrandonneurs.workers.dev";
const AUDAX = "https://www.audaxindia.in";
const EVENT_IDS = { "600": "10047", "200": "10048", "300": "10049", "400": "10050" };
const ROUTES = {
  "600": "https://ridewithgps.com/routes/44588666",
  "200": "https://ridewithgps.com/routes/49469273",
  "300": "https://ridewithgps.com/routes/46588152",
  "400": "https://ridewithgps.com/routes/49468783"
};
// Start location on Google Maps (same link used for every event; edit here if one differs)
const MAPS = "https://maps.app.goo.gl/Fhmnyr6gbKszavAD7";
const MAP_EMBED = "https://www.google.com/maps?q=17.455080,78.494962&z=16&output=embed";
const ORDER = ["600", "200", "300", "400"];   // tile order (by ride date this week)
const ALL = ["200", "300", "400", "600"];
const REFRESH_MS = 5 * 60 * 1000;

const tilesEl = document.getElementById("tiles");
const detailEl = document.getElementById("detail");
const cache = {}, routeCache = {};
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

// ---------- data ----------
async function fetchEvent(d, force) {
  if (!force && cache[d]) return cache[d];
  const res = await fetch(`${API_BASE}/event/${d}`);
  if (!res.ok) throw new Error("Server returned " + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return (cache[d] = data);
}
async function fetchRoute(d) {          // controls and cue sheet from data/<distance>.json
  if (routeCache[d] !== undefined) return routeCache[d];
  try { const r = await fetch(`data/${d}.json`); routeCache[d] = r.ok ? await r.json() : null; }
  catch (_) { routeCache[d] = null; }
  return routeCache[d];
}
const loadAll = force => Promise.allSettled(ALL.map(d => fetchEvent(d, force)));

function srRiders() {                   // riders registered for all four events
  if (!ALL.every(d => cache[d])) return null;
  const map = {};
  ALL.forEach(d => (cache[d].riders || []).forEach(r => {
    const k = (r.air || r.name).toLowerCase();
    (map[k] ||= { air: r.air, name: r.name, club: r.club, rides: new Set() }).rides.add(d);
  }));
  return Object.values(map).filter(r => r.rides.size === ALL.length);
}

// ---------- tiles ----------
function renderTiles() {
  const sr = srRiders();
  const ev = ORDER.map(d => `<button class="tile" data-d="${d}" aria-pressed="${d === current}">
      <b>${d} km</b>
      <span>${esc(fmtTime(cache[d]?.startTime) || "Start time to be announced")}</span>
      <span>${cache[d] ? cache[d].riderCount + " registered" : "Loading…"}</span>
      ${isClosed(cache[d]) ? '<span class="closed">Registration closed</span>' : ""}</button>`).join("");
  const tools = `
    <button class="tile" data-d="sr" aria-pressed="${current === "sr"}"><b>One Week SR</b>
      <span>${sr ? sr.length + " riders in all 4 rides" : "Loading…"}</span></button>
    <button class="tile" data-d="assistant" aria-pressed="${current === "assistant"}"><b>BRM Assistant</b>
      <span>Ask about any ride</span></button>`;
  tilesEl.innerHTML = ev + tools;
}
tilesEl.addEventListener("click", e => { const t = e.target.closest(".tile"); if (t) location.hash = t.dataset.d; });

// ---------- event view ----------
const table = (heads, rows) => `<div class="scroll"><table><thead><tr>${heads.map(h => `<th>${h}</th>`).join("")}</tr></thead>
  <tbody>${rows}</tbody></table></div>`;

function renderDetail() {
  const ev = cache[current]; if (!ev) return;
  const route = routeCache[current];
  const closed = isClosed(ev);
  const riders = ev.riders || [];
  const started = hasStarted(ev);
  const count = k => riders.filter(r => statusOf(r, started) === k).length;
  const paid = riders.filter(r => /^y/i.test(r.fee)).length;
  const stats = [["Registered", riders.length], ["Fee paid", paid], ["Finished", count("finished") + count("lf")],
                 ["Did not start", count("dns")], ["Did not finish", count("dnf")]]
    .map(([l, n]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");
  const controls = (route?.controls || []).map(c => `<tr><td>${esc(c.km)}</td><td>${esc(c.location)}</td><td>${esc(c.type)}</td></tr>`).join("");
  const cues = (route?.cueSheet || []).map(c => `<tr><td>${esc(c.km)}</td><td>${esc(c.instruction)}</td></tr>`).join("");

  detailEl.innerHTML = `
    <div class="head">
      <div class="info">
        <h2>${esc(ev.title || current + " km BRM")}</h2>
        <dl class="facts">
          <dt>Start</dt><dd>${esc(fmtTime(ev.startTime) || "Not announced")}</dd>
          <dt>Starting point</dt><dd>${esc(ev.startLocation || "Not announced")}
            <a href="${MAPS}" target="_blank" rel="noopener">Open in Google Maps</a></dd>
          <dt>${closed ? "Registration closed" : "Registration closes"}</dt><dd>${esc(closeText(ev) || "Not announced")} ${closed ? '<span class="tag dns">Closed</span>' : ""}</dd>
        </dl>
        <iframe class="map" title="Start location map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${MAP_EMBED}"></iframe>
      </div>
      <div class="actions">
        <a class="btn" href="${ROUTES[current]}" target="_blank" rel="noopener">View route</a>
        ${closed ? '<span class="btn off" aria-disabled="true">Registration closed</span>'
                 : `<a class="btn alt" href="${AUDAX}/event-e-${EVENT_IDS[current]}" target="_blank" rel="noopener">Register on Audax India</a>`}
        <a class="btn alt" href="${AUDAX}/member-login.php" target="_blank" rel="noopener">Rider login</a>
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
      <thead><tr><th>#</th><th>Rider</th><th>AIR no.</th><th>Club</th><th>Fee paid</th><th>Medal</th><th>Status</th></tr></thead>
      <tbody id="rows"></tbody></table></div>
    ${controls ? `<h3 class="sec">Controls</h3>${table(["KM", "Location", "Type"], controls)}` : ""}
    ${cues ? `<h3 class="sec">Cue sheet</h3>${table(["KM", "Instruction"], cues)}` : ""}`;

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
    const s = statusOf(r, started), label = s === "finished" ? r.result : LABELS[s];
    return `<tr><td>${esc(r.seq)}</td><td>${esc(r.name)}</td><td>${esc(r.air)}</td><td>${esc(r.club)}</td>
      <td>${esc(r.fee)}</td><td>${esc(r.medal)}</td><td><span class="tag ${s}">${esc(label)}</span></td></tr>`;
  }).join("") : `<tr><td colspan="7" class="note">No riders match. Clear the search or choose "All riders".</td></tr>`;
  const t = ev.fetchedAt ? new Date(ev.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  document.getElementById("meta").textContent = `${list.length} of ${ev.riders.length} shown` + (t ? ` · updated ${t}` : "");
}

function showError(msg, retry) {
  detailEl.innerHTML = `<p class="error">${esc(msg)}</p><button class="btn alt" id="retry" type="button">Refresh</button>`;
  document.getElementById("retry").addEventListener("click", retry);
}

async function showEvent(d, force) {
  if (!cache[d] || force) detailEl.innerHTML = loading(`Loading ${d} km riders…`);
  try { await fetchEvent(d, force); }
  catch (err) { if (current === d) showError(`Could not load the ${d} km event (${err.message}). Try again in a minute.`, () => showEvent(d, true)); return; }
  await fetchRoute(d);
  if (current !== d) return;
  renderTiles(); renderDetail();
}

// ---------- One Week SR ----------
async function showSR(force) {
  detailEl.innerHTML = loading("Loading riders for all four rides…");
  const res = await loadAll(force);
  if (current !== "sr") return;
  if (res.some(r => r.status === "rejected"))
    return showError("Could not load all four events, so the list would be incomplete. Try again in a minute.", () => showSR(true));
  renderTiles(); renderSR();
}
function renderSR() {
  const list = srRiders() || [];
  const rows = list.map(r => `<tr><td>${esc(r.air)}</td><td>${esc(r.name)}</td><td>${esc(r.club)}</td>
    ${ALL.map(() => "<td>✅</td>").join("")}</tr>`).join("");
  detailEl.innerHTML = `<h2>One Week SR riders</h2>
    <p class="note">Riders registered for all four rides (200, 300, 400 and 600 km): <b>${list.length}</b></p>
    ${table(["AIR no.", "Rider", "Club", ...ALL], rows || `<tr><td colspan="7" class="note">No rider is registered for all four rides yet.</td></tr>`)}`;
}

// ---------- BRM Assistant ----------
function showAssistant() {
  detailEl.innerHTML = `<h2>BRM Assistant</h2>
    <p class="note">Try: "600 riders", "200 controls", "start time of 400", "start location of 200",
    "registration close of 300", "one week sr riders".</p>
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
  try { await Promise.all(ALL.map(d => fetchEvent(d))); }
  catch (_) { out.innerHTML = `<p class="error">Could not load rider data. Try again in a minute.</p>`; return; }

  if (q.includes("one week sr")) {
    const list = srRiders();
    out.innerHTML = `<h3>One Week SR riders (${list.length})</h3>` +
      (list.map(r => `${esc(r.air)} - ${esc(r.name)}`).join("<br>") || "No rider is registered for all four rides yet.");
    return;
  }
  const m = q.match(/(200|300|400|600)/);
  if (!m) { out.textContent = "Mention 200, 300, 400 or 600, or ask about one week sr."; return; }
  const d = m[1], ev = cache[d], head = `<h3>${esc(ev.title)}</h3>`;

  if (q.includes("riders")) out.innerHTML = `${head}Riders: <b>${ev.riderCount}</b><hr>` +
    ev.riders.map(r => `${esc(r.air)} - ${esc(r.name)}`).join("<br>");
  else if (q.includes("start time")) out.innerHTML = `${head}Start time: <b>${esc(fmtTime(ev.startTime))}</b>`;
  else if (q.includes("start location")) out.innerHTML = `${head}Start location: <b>${esc(ev.startLocation)}</b> <a href="${MAPS}" target="_blank" rel="noopener">Open in Google Maps</a>`;
  else if (q.includes("registration")) out.innerHTML = `${head}${isClosed(ev) ? "Registration closed" : "Registration closes"}: <b>${esc(closeText(ev))}</b>`;
  else if (q.includes("controls")) {
    const route = await fetchRoute(d);
    out.innerHTML = `<h3>${d} controls</h3>` + ((route?.controls || []).map(c => `${esc(c.km)} km - ${esc(c.location)}`).join("<br>") || "No controls listed yet.");
  } else out.textContent = "Question not understood. Try one of the examples above.";
}

// ---------- routing and refresh ----------
function select() {
  const d = location.hash.slice(1);
  current = EVENT_IDS[d] || d === "sr" || d === "assistant" ? d : ORDER[0];
  renderTiles();
  if (current === "sr") showSR();
  else if (current === "assistant") showAssistant();
  else showEvent(current);
}
window.addEventListener("hashchange", select);

setInterval(async () => {
  await loadAll(true);
  renderTiles();
  if (document.activeElement?.tagName === "INPUT") return;   // don't disturb typing
  if (EVENT_IDS[current] && cache[current]) renderDetail();
  else if (current === "sr") renderSR();
}, REFRESH_MS);

renderTiles();
select();
loadAll().then(renderTiles);
