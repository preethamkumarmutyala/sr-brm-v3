// ===== CONFIG: set this to your Cloudflare Worker URL (no trailing slash) =====
const API_BASE = "https://YOUR-WORKER.workers.dev";
// ===============================================================================

const AUDAX = "https://www.audaxindia.in";
const EVENT_IDS = { "600": "10047", "200": "10048", "300": "10049", "400": "10050" };
const ORDER = ["600", "200", "300", "400"];   // order of the tiles (by ride date this week)
const REFRESH_MS = 5 * 60 * 1000;

const tilesEl = document.getElementById("tiles");
const detailEl = document.getElementById("detail");
const cache = {};          // distance -> event data
let summaries = {};        // distance -> summary from /events
let current = null;        // selected distance
let query = "", filter = "all";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function statusOf(r) {
  const x = (r.result || "").trim().toUpperCase();
  if (!x) return "registered";
  if (["DNS", "DNF", "LF", "YTC"].includes(x)) return x.toLowerCase();
  return "finished";   // a finishing time such as "12h 07m"
}
const LABELS = { registered: "Registered", ytc: "Yet to confirm", dns: "Did not start",
                 dnf: "Did not finish", lf: "Late finish", finished: "Finished" };

async function getJSON(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error("Server returned " + res.status);
  return res.json();
}

// ---------- tiles ----------
function renderTiles() {
  tilesEl.innerHTML = ORDER.map(d => {
    const s = summaries[d] || {};
    return `<button class="tile" data-d="${d}" aria-pressed="${d === current}">
      <b>${d} km</b>
      <span>${esc(s.startTime || "Start time to be announced")}</span>
      <span>${s.riderCount != null ? s.riderCount + " registered" : "Loading…"}</span>
    </button>`;
  }).join("");
}
tilesEl.addEventListener("click", e => {
  const t = e.target.closest(".tile");
  if (t) location.hash = t.dataset.d;
});

// ---------- detail ----------
function renderDetail() {
  const ev = cache[current];
  if (!ev) { detailEl.innerHTML = `<p class="note">Loading ${esc(current)} km riders…</p>`; return; }

  const riders = ev.riders || [];
  const count = k => riders.filter(r => statusOf(r) === k).length;
  const paid = riders.filter(r => /^y/i.test(r.fee)).length;
  const regUrl = `${AUDAX}/event-e-${EVENT_IDS[current]}`;

  const stats = [
    ["Registered", riders.length], ["Fee paid", paid], ["Finished", count("finished") + count("lf")],
    ["Did not start", count("dns")], ["Did not finish", count("dnf")]
  ].map(([l, n]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");

  detailEl.innerHTML = `
    <div class="head">
      <div>
        <h2>${esc(ev.title || current + " km BRM")}</h2>
        <dl class="facts">
          <dt>Start</dt><dd>${esc(ev.startTime || "Not announced")}</dd>
          <dt>Starting point</dt><dd>${esc(ev.startLocation || "Not announced")}</dd>
          <dt>Registration closes</dt><dd>${esc(ev.registrationClose || "Not announced")}</dd>
        </dl>
      </div>
      <div class="actions">
        <a class="btn" href="${regUrl}" target="_blank" rel="noopener">Register on Audax India</a>
        <a class="btn alt" href="${AUDAX}/member-login.php" target="_blank" rel="noopener">Rider login</a>
      </div>
    </div>
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
      <thead><tr><th>#</th><th>Rider</th><th>AIR no.</th><th>Club</th><th>Fee paid</th><th>Medal</th><th>Status</th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>`;

  document.getElementById("q").addEventListener("input", e => { query = e.target.value; renderRows(); });
  document.getElementById("f").addEventListener("change", e => { filter = e.target.value; renderRows(); });
  document.getElementById("refresh").addEventListener("click", () => load(current, true));
  renderRows();
}

function renderRows() {
  const ev = cache[current]; if (!ev) return;
  const q = query.trim().toLowerCase();
  const list = ev.riders.filter(r =>
    (filter === "all" || statusOf(r) === filter) &&
    (!q || [r.name, r.air, r.club].some(v => (v || "").toLowerCase().includes(q))));

  document.getElementById("rows").innerHTML = list.length ? list.map(r => {
    const s = statusOf(r);
    const label = s === "finished" ? r.result : LABELS[s];
    return `<tr><td>${esc(r.seq)}</td><td>${esc(r.name)}</td><td>${esc(r.air)}</td><td>${esc(r.club)}</td>
      <td>${esc(r.fee)}</td><td>${esc(r.medal)}</td><td><span class="tag ${s}">${esc(label)}</span></td></tr>`;
  }).join("") : `<tr><td colspan="7" class="note">No riders match. Clear the search or choose "All riders".</td></tr>`;

  const t = ev.fetchedAt ? new Date(ev.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  document.getElementById("meta").textContent = `${list.length} of ${ev.riders.length} shown` + (t ? ` · updated ${t}` : "");
}

// ---------- loading ----------
async function load(d, force) {
  if (!force && cache[d]) return renderDetail();
  try {
    cache[d] = await getJSON("/event/" + d);
    summaries[d] = cache[d];
  } catch (err) {
    if (!cache[d]) {
      detailEl.innerHTML = `<p class="error">Could not load the ${esc(d)} km event (${esc(err.message)}). Try Refresh in a minute.</p>
        <button class="btn alt" id="retry" type="button">Refresh</button>`;
      document.getElementById("retry").addEventListener("click", () => load(d, true));
      return;
    }
  }
  renderTiles();
  if (d === current) renderDetail();
}

async function loadSummaries() {
  try {
    const { events } = await getJSON("/events");
    events.forEach(e => { if (!e.error) summaries[e.distance] = e; });
  } catch (_) { /* tiles just stay on "Loading…"; detail view still works */ }
  renderTiles();
}

function select() {
  const d = location.hash.slice(1);
  current = EVENT_IDS[d] ? d : ORDER[0];
  renderTiles();
  load(current);
}

window.addEventListener("hashchange", select);
setInterval(() => { loadSummaries(); if (current) load(current, true); }, REFRESH_MS);

renderTiles();
loadSummaries();
select();
