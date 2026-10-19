/* Service Runner control panel — vanilla JS, no build step. */
"use strict";

/* ================= bootstrap ================= */

function readBootstrap() {
  const el = document.getElementById("sr-bootstrap");
  if (!el) return {};
  const raw = (el.textContent || "").trim();
  if (!raw || raw === "%%BOOTSTRAP%%") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const SR = Object.assign({}, window.__SR__, readBootstrap());
window.__SR__ = SR;
const TOKEN = SR.token;

const $ = (id) => document.getElementById(id);
const field = (form, name) => form.elements.namedItem(name);
const ACTIVE = new Set(["running", "starting"]);

const state = {
  services: [],
  groups: [],
  tab: "all",
  filter: "",
  cursor: null, // keyboard-highlighted service id
  stats: null,
  view: "services",
  portal: null, // GET /api/v1/portal payload, false = endpoint missing
  promptInfo: null,
  revealPrompt: false,
};

/* ================= helpers ================= */

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    if (res.status === 401) err.message = "The master token changed — reload this page.";
    throw err;
  }
  return data;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const icon = (name, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

function formatUptime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function formatMb(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  if (n >= 1024) return `${(n / 1024).toFixed(2)} GB`;
  return `${Math.round(n)} MB`;
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const diff = (Date.now() - t) / 1000;
  if (diff < 90) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 86400 * 30) return `${Math.round(diff / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function uaSummary(ua) {
  ua = String(ua || "");
  if (!ua) return "Unknown browser";
  let b = "Browser";
  if (/Edg\//.test(ua)) b = "Edge";
  else if (/OPR\/|Opera/.test(ua)) b = "Opera";
  else if (/SamsungBrowser/.test(ua)) b = "Samsung Internet";
  else if (/Firefox\/|FxiOS/.test(ua)) b = "Firefox";
  else if (/CriOS|Chrome\//.test(ua)) b = "Chrome";
  else if (/Safari\//.test(ua)) b = "Safari";
  let os = "";
  if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua)) os = "iPad";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Mac OS X|Macintosh/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";
  return os ? `${b} on ${os}` : b;
}

function lines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function envLinesToObject(text) {
  const env = {};
  for (const line of (text || "").split(/\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const envToLines = (env) => (env ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") : "");

function uniqueOrigins(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls || []) {
    const n = String(u).replace(/\/$/, "");
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function toast(msg, kind = "ok") {
  const text = msg instanceof Error ? msg.message : String(msg);
  const el = document.createElement("div");
  el.className = "toast" + (kind === "err" || msg instanceof Error ? " err" : "");
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 220);
  }, kind === "err" || msg instanceof Error ? 5200 : 2600);
}
const fail = (err) => toast(err instanceof Error ? err : new Error(String(err)), "err");

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function flashLabel(btn, text, ms = 1400) {
  const label = btn.querySelector("span") || btn;
  const prev = label.textContent;
  label.textContent = text;
  setTimeout(() => (label.textContent = prev), ms);
}

/* Dialog helpers (native <dialog>: focus trap + Esc for free) */
function openDialog(id) {
  const d = $(id);
  if (!d.open) d.showModal();
  return d;
}
function closeDialog(id) {
  const d = $(id);
  if (d.open) d.close();
}
document.addEventListener("click", (e) => {
  const c = e.target.closest("[data-close]");
  if (c) c.closest("dialog")?.close();
});
// Click on the backdrop closes simple dialogs
for (const d of document.querySelectorAll("dialog")) {
  d.addEventListener("mousedown", (e) => {
    if (e.target === d) d.dataset.downOnBackdrop = "1";
  });
  d.addEventListener("click", (e) => {
    if (e.target === d && d.dataset.downOnBackdrop === "1" && d.id !== "dlg-token") d.close("cancel");
    delete d.dataset.downOnBackdrop;
  });
}

function confirmDialog({ title, body, ok = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const d = $("dlg-confirm");
    $("confirm-title").textContent = title;
    $("confirm-body").textContent = body || "";
    const okBtn = $("confirm-ok");
    okBtn.textContent = ok;
    okBtn.className = "btn " + (danger ? "danger" : "primary");
    d.returnValue = "";
    const done = () => {
      d.removeEventListener("close", done);
      resolve(d.returnValue === "ok");
    };
    d.addEventListener("close", done);
    d.showModal();
    (danger ? $("confirm-cancel") : okBtn).focus();
  });
}

/* ================= theme ================= */

function setTheme(t, persist = true) {
  document.documentElement.setAttribute("data-theme", t);
  if (persist) {
    try {
      localStorage.setItem("sr-theme", t);
    } catch {
      /* ignore */
    }
  }
}
function toggleTheme() {
  setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
}
$("btn-theme").addEventListener("click", toggleTheme);
window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", (e) => {
  let stored = null;
  try {
    stored = localStorage.getItem("sr-theme");
  } catch {
    /* ignore */
  }
  if (!stored) setTheme(e.matches ? "light" : "dark", false);
});

/* ================= routing ================= */

function parseHash() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (!h || h === "/" || h === "/services") return { view: "services" };
  if (h === "/portal") return { view: "portal" };
  if (h === "/agent") return { view: "agent" };
  const m = h.match(/^\/logs\/(.+)$/);
  if (m) return { view: "services", logs: m[1] };
  if (!h.startsWith("/")) return { view: "services", logs: h }; // legacy #<service-id>
  return { view: "services" };
}

function setHash(h) {
  if (location.hash !== h) history.replaceState(null, "", h);
}

function applyRoute() {
  const r = parseHash();
  showView(r.view);
  if (r.logs) {
    const s = state.services.find((x) => x.id === r.logs);
    if (s && Con.id !== s.id) openConsole(s);
  }
}

function showView(view) {
  state.view = view;
  for (const sec of document.querySelectorAll(".view")) sec.hidden = sec.dataset.view !== view;
  for (const a of document.querySelectorAll(".view-tab")) {
    if (a.dataset.view === view) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (view === "portal") loadPortal();
  if (view === "agent") renderPrompt();
}

/* ================= stats ================= */

function renderStats() {
  const s = state.stats;
  const running = state.services.filter((x) => ACTIVE.has(x.runtime.status)).length;
  const crashed = state.services.filter((x) => x.runtime.status === "crashed").length;
  $("m-running").textContent = running;
  $("m-total").textContent = state.services.length;
  const c = $("m-crashed");
  c.textContent = crashed;
  c.classList.toggle("crashed", crashed > 0);
  if (s) {
    $("m-uptime").textContent = formatUptime(s.uptimeSec);
    $("m-mem-services").textContent = formatMb(s.memory.servicesMb);
    $("m-mem-runner").textContent = formatMb(s.memory.runnerMb);
    $("m-mem-total").textContent = formatMb(s.memory.totalMb);
    $("m-cpu").textContent = `${s.cpuPct}%`;
    $("m-cpu-bar").style.width = `${Math.max(2, Math.min(100, s.cpuPct))}%`;
    $("status-meta").textContent = `127.0.0.1:${s.port} · ${s.memory.serviceProcs} proc${s.memory.serviceProcs === 1 ? "" : "s"} · ${s.groups} group${s.groups === 1 ? "" : "s"}`;
  }
}

async function loadStats() {
  if (document.hidden) return;
  try {
    state.stats = await api("/api/v1/stats");
    renderStats();
  } catch {
    /* keep last snapshot */
  }
}

/* ================= services list ================= */

function isExternal(s) {
  return s.kind === "external";
}

function visibleServices() {
  const q = state.filter.trim().toLowerCase();
  return state.services.filter((s) => {
    if (state.tab === "ungrouped" ? s.groupId : state.tab !== "all" && s.groupId !== state.tab) return false;
    if (!q) return true;
    return [s.name, s.id, s.cwd, s.command, s.url, s.publish?.path].some((v) => v && String(v).toLowerCase().includes(q));
  });
}

function renderTabs() {
  const tabs = $("group-tabs");
  const count = (fn) => state.services.filter(fn).length;
  const items = [
    { id: "all", name: "All", n: state.services.length },
    ...state.groups.map((g) => ({ id: g.id, name: g.name, n: count((s) => s.groupId === g.id), running: count((s) => s.groupId === g.id && ACTIVE.has(s.runtime.status)) })),
  ];
  const ungrouped = count((s) => !s.groupId);
  if (state.groups.length && ungrouped) items.push({ id: "ungrouped", name: "Ungrouped", n: ungrouped });
  if (!items.some((t) => t.id === state.tab)) state.tab = "all";
  tabs.innerHTML = items
    .map(
      (t) =>
        `<button type="button" class="tab" role="tab" data-tab="${esc(t.id)}" aria-selected="${state.tab === t.id}">${esc(t.name)}<span class="n">${
          t.running !== undefined ? `${t.running}/${t.n}` : t.n
        }</span></button>`,
    )
    .join("");

  const g = state.groups.find((x) => x.id === state.tab);
  $("group-bar").hidden = !g;
  if (g) {
    const members = state.services.filter((s) => s.groupId === g.id);
    const running = members.filter((s) => ACTIVE.has(s.runtime.status)).length;
    $("group-name").textContent = g.name;
    $("group-count").textContent = `${running}/${members.length} running`;
    $("btn-group-start").disabled = !members.length || running === members.length;
    $("btn-group-stop").disabled = !running;
  }
}

function rowHtml(s) {
  const st = s.runtime.status;
  const ext = isExternal(s);
  const active = ACTIVE.has(st);
  const group = state.groups.find((g) => g.id === s.groupId);
  const urlList = uniqueOrigins(ext ? [s.url, ...(s.runtime.urls || [])].filter(Boolean) : s.runtime.urls);
  const urls = urlList
    .map((u) => `<a class="url" href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}">${esc(u.replace(/^https?:\/\//, ""))}</a>`)
    .join("");
  const tags = [
    ext ? `<span class="tag ext" title="Managed outside Service Runner">external</span>` : "",
    s.publish ? `<span class="tag public" title="Published at ${esc(s.publish.path)}/">${icon("globe")}public</span>` : "",
    st === "crashed" ? `<span class="tag crashed">crashed</span>` : "",
    group && state.tab === "all" ? `<span class="tag grp">${esc(group.name)}</span>` : "",
  ].join("");
  const sub = ext
    ? `<span class="cmd">${esc(s.url || "no url")}</span>`
    : `<span class="path" title="${esc(s.cwd)}"><bdi>${esc(s.cwd)}</bdi></span><span class="sep">›</span><span class="cmd" title="${esc(fullCommand(s))}">${esc(fullCommand(s))}</span>`;
  const startBtn = ext
    ? ""
    : active
      ? `<button type="button" class="icon-btn act-stop" data-act="stop" title="Stop (x)" aria-label="Stop ${esc(s.name)}">${icon("stop")}</button>`
      : `<button type="button" class="icon-btn act-start" data-act="start" title="Start (s)" aria-label="Start ${esc(s.name)}">${icon("play")}</button>`;
  const restartBtn = ext ? "" : `<button type="button" class="icon-btn" data-act="restart" title="Restart (r)" aria-label="Restart ${esc(s.name)}" ${st === "stopped" ? "disabled" : ""}>${icon("restart")}</button>`;
  const cls = ["svc", state.cursor === s.id ? "cursor" : "", Con.id === s.id ? "open" : ""].join(" ");
  return `<div class="${cls}" role="listitem" data-id="${esc(s.id)}">
    <i class="dot" data-s="${esc(st)}" title="${esc(st)}"></i>
    <div class="svc-main"><span class="svc-name">${esc(s.name)}</span><span class="svc-id">${esc(s.id)}</span>${tags}</div>
    <div class="svc-sub">${sub}</div>
    <div class="svc-side">
      <div class="svc-urls">${urls}</div>
      <span class="svc-up" data-started="${active && s.runtime.startedAt ? esc(s.runtime.startedAt) : ""}">${uptimeLabel(s)}</span>
      <div class="svc-acts">
        ${startBtn}${restartBtn}
        <button type="button" class="icon-btn" data-act="logs" title="Logs (Enter)" aria-label="Logs for ${esc(s.name)}">${icon("terminal")}</button>
        <button type="button" class="icon-btn act-edit" data-act="edit" title="Edit (e)" aria-label="Edit ${esc(s.name)}">${icon("edit")}</button>
      </div>
    </div>
  </div>`;
}

function fullCommand(s) {
  return s.args?.length ? `${s.command} ${s.args.join(" ")}` : s.command || "";
}

function uptimeLabel(s) {
  const st = s.runtime.status;
  if (ACTIVE.has(st) && s.runtime.startedAt) return formatUptime((Date.now() - Date.parse(s.runtime.startedAt)) / 1000);
  if (st === "crashed" && s.runtime.exitCode !== null && s.runtime.exitCode !== undefined) return `exit ${s.runtime.exitCode}`;
  return st === "running" ? "up" : st;
}

function render() {
  renderStats();
  renderTabs();
  const list = visibleServices();
  const wrap = $("svc-list");
  // Keep keyboard focus stable across re-renders
  const ae = document.activeElement;
  const focusKey = ae && wrap.contains(ae) ? [ae.closest(".svc")?.dataset.id, ae.dataset.act] : null;
  wrap.innerHTML = list.map(rowHtml).join("");
  if (focusKey?.[0]) {
    wrap.querySelector(`.svc[data-id="${CSS.escape(focusKey[0])}"] [data-act="${focusKey[1]}"]`)?.focus();
  }
  const none = list.length === 0;
  $("empty").hidden = !none;
  if (none) {
    const filtered = state.services.length > 0;
    $("empty-title").textContent = filtered ? "Nothing matches" : "No services yet";
    $("empty-body").hidden = filtered;
    $("btn-add-empty").hidden = filtered;
  }
  fillGroupSelect();
  if (Con.id) renderConsoleHead();
}

function fillGroupSelect() {
  const gsel = field($("form-service"), "groupId");
  const current = gsel.value;
  gsel.innerHTML = `<option value="">— none —</option>` + state.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join("");
  gsel.value = current;
}

function tickUptimes() {
  for (const el of document.querySelectorAll(".svc-up[data-started]")) {
    const t = el.dataset.started;
    if (t) el.textContent = formatUptime((Date.now() - Date.parse(t)) / 1000);
  }
  if (Con.id) renderConsoleChip();
}

$("group-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  state.tab = b.dataset.tab;
  render();
});

$("svc-list").addEventListener("click", (e) => {
  const row = e.target.closest(".svc");
  if (!row) return;
  const s = state.services.find((x) => x.id === row.dataset.id);
  if (!s) return;
  if (e.target.closest("a")) return;
  const btn = e.target.closest("[data-act]");
  state.cursor = s.id;
  if (!btn) {
    if (Con.id === s.id && window.getSelection()?.toString()) return;
    openConsole(s);
    return;
  }
  e.stopPropagation();
  serviceAction(s, btn.dataset.act);
});

function serviceAction(s, act) {
  if (!s) return;
  const ext = isExternal(s);
  if ((act === "start" || act === "stop" || act === "restart") && ext) {
    toast("External services are managed outside Service Runner.", "err");
    return;
  }
  const call = (verb, label) =>
    api(`/api/v1/services/${encodeURIComponent(s.id)}/${verb}`, { method: "POST" })
      .then(() => toast(`${label} ${s.name}`))
      .catch(fail);
  if (act === "start") return call("start", "Starting");
  if (act === "stop") return call("stop", "Stopping");
  if (act === "restart") return call("restart", "Restarting");
  if (act === "logs") return openConsole(s);
  if (act === "edit") return openEditor(s);
}

async function refresh() {
  const data = await api("/api/v1/services");
  state.services = data.services;
  state.groups = data.groups;
  render();
}

let refreshTimer = 0;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(() => {}), 250);
}

$("svc-filter").addEventListener("input", (e) => {
  state.filter = e.target.value;
  render();
});
$("svc-filter").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.target.value = "";
    state.filter = "";
    render();
    e.target.blur();
  }
  if (e.key === "Enter" || e.key === "ArrowDown") {
    const first = visibleServices()[0];
    if (first) {
      state.cursor = first.id;
      e.target.blur();
      if (e.key === "Enter") openConsole(first);
      else render();
    }
  }
});

/* group actions */
$("btn-group").addEventListener("click", () => openGroupDialog());
$("btn-group-start").addEventListener("click", () => {
  const g = state.tab;
  api(`/api/v1/groups/${encodeURIComponent(g)}/start`, { method: "POST" }).then(() => toast("Starting group")).catch(fail);
});
$("btn-group-stop").addEventListener("click", () => {
  const g = state.tab;
  api(`/api/v1/groups/${encodeURIComponent(g)}/stop`, { method: "POST" }).then(() => toast("Stopping group")).catch(fail);
});
$("btn-group-rename").addEventListener("click", () => {
  const g = state.groups.find((x) => x.id === state.tab);
  if (g) openGroupDialog(g);
});
$("btn-group-delete").addEventListener("click", async () => {
  const g = state.groups.find((x) => x.id === state.tab);
  if (!g) return;
  const ok = await confirmDialog({
    title: `Delete group “${g.name}”?`,
    body: "Services in it stay registered and keep running; they just become ungrouped.",
    ok: "Delete group",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/v1/groups/${encodeURIComponent(g.id)}`, { method: "DELETE" });
    state.tab = "all";
    await refresh();
    toast(`Deleted group ${g.name}`);
  } catch (err) {
    fail(err);
  }
});
$("btn-stop-all").addEventListener("click", async () => {
  const running = state.services.filter((s) => ACTIVE.has(s.runtime.status) && !isExternal(s)).length;
  const ok = await confirmDialog({
    title: "Stop all services?",
    body: running ? `${running} running service${running === 1 ? "" : "s"} will be stopped. Service Runner itself keeps running.` : "Nothing is running right now.",
    ok: "Stop all",
    danger: true,
  });
  if (!ok) return;
  api("/api/v1/stop-all", { method: "POST" }).then(() => toast("Stopping everything")).catch(fail);
});

function openGroupDialog(g) {
  const f = $("form-group");
  f.reset();
  f.dataset.id = g ? g.id : "";
  $("group-title").textContent = g ? "Rename group" : "New group";
  $("btn-group-save").textContent = g ? "Save" : "Create";
  $("group-id-field").hidden = Boolean(g);
  field(f, "name").value = g ? g.name : "";
  $("group-error").hidden = true;
  openDialog("dlg-group");
  field(f, "name").focus();
}

$("form-group").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const name = field(f, "name").value.trim();
  if (!name) {
    field(f, "name").focus();
    return;
  }
  try {
    if (f.dataset.id) {
      await api(`/api/v1/groups/${encodeURIComponent(f.dataset.id)}`, { method: "PATCH", body: { name } });
    } else {
      const g = await api("/api/v1/groups", { method: "POST", body: { name, id: field(f, "id").value.trim() || undefined } });
      if (g?.id) state.tab = g.id;
    }
    closeDialog("dlg-group");
    await refresh();
  } catch (err) {
    $("group-error").hidden = false;
    $("group-error").textContent = err.message;
  }
});

/* ================= service editor ================= */

const fs = () => $("form-service");

function setKind(kind) {
  const f = fs();
  for (const r of f.querySelectorAll('input[name="kind"]')) r.checked = r.value === kind;
  f.querySelector(".managed-only").hidden = kind === "external";
  f.querySelector(".external-only").hidden = kind !== "external";
}
for (const r of document.querySelectorAll('#form-service input[name="kind"]')) {
  r.addEventListener("change", () => setKind(r.value));
}

function setPublishEnabled(on) {
  const f = fs();
  field(f, "pubEnabled").checked = on;
  $("pub-fields").disabled = !on;
  $("pub-state").textContent = on ? "public" : "local only";
  $("pub-state").classList.toggle("on", on);
}
field(fs(), "pubEnabled").addEventListener("change", (e) => {
  setPublishEnabled(e.target.checked);
  if (e.target.checked) {
    const f = fs();
    if (!field(f, "pubPath").value) field(f, "pubPath").value = slug(field(f, "id").value || field(f, "name").value);
    if (!field(f, "pubUpstream").value) field(f, "pubUpstream").value = guessUpstream();
    updatePreview();
    field(f, "pubPath").focus();
  }
});

function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function guessUpstream() {
  const f = fs();
  if (field(f, "kind").value === "external" && field(f, "url").value) return field(f, "url").value.trim();
  const s = state.services.find((x) => x.id === f.dataset.id);
  const u = (s?.runtime.urls || []).find((x) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(x));
  return u ? u.replace(/\/$/, "").replace(/^(https?:\/\/[^/]+).*$/, "$1") : "";
}

const isEmojiish = (v) => v && !/^(https?:\/\/|\/)/i.test(v);

function renderIcon(target, iconVal, name, color) {
  target.textContent = "";
  const v = (iconVal || "").trim();
  if (v && !isEmojiish(v)) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = v;
    img.referrerPolicy = "no-referrer";
    target.appendChild(img);
  } else {
    target.textContent = v || (name || "?").trim().charAt(0).toUpperCase();
  }
  if (color) target.parentElement?.style.setProperty("--c", color);
}

function updatePreview() {
  const f = fs();
  const color = validColor(field(f, "pubColor").value) || "#7c9cff";
  const name = field(f, "pubTitle").value.trim() || field(f, "name").value.trim() || "My App";
  $("tile-prev").style.setProperty("--c", color);
  renderIcon($("tp-ico"), field(f, "pubIcon").value, name);
  $("tp-name").textContent = name;
  $("tp-desc").textContent = field(f, "pubDesc").value.trim() || "One short line";
  const p = field(f, "pubPath").value.trim().replace(/^\/+/, "") || "my-app";
  $("strip-help").innerHTML = field(f, "pubStrip").checked
    ? `On: <span class="mono">/${esc(p)}/x</span> → upstream <span class="mono">/x</span>. Turn off if the app is base-path aware.`
    : `Off: <span class="mono">/${esc(p)}/x</span> is forwarded unchanged — the app must serve under <span class="mono">/${esc(p)}/</span>.`;
  const pub = state.portal && state.portal.publicUrl ? state.portal.publicUrl.replace(/\/$/, "") : "";
  $("pub-path-help").innerHTML = pub
    ? `Opens at <span class="mono">${esc(pub)}/${esc(p)}/</span>`
    : "One lowercase segment: a–z, 0–9, dashes.";
}

function validColor(v) {
  v = String(v || "").trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : "";
}

for (const n of ["pubTitle", "pubDesc", "pubIcon", "pubColor", "pubPath", "name", "pubStrip"]) {
  field(fs(), n).addEventListener("input", () => {
    if (n === "pubColor") {
      const c = validColor(field(fs(), "pubColor").value);
      if (c && c.length === 7) field(fs(), "pubColorPick").value = c;
    }
    updatePreview();
  });
}
field(fs(), "pubStrip").addEventListener("change", updatePreview);
field(fs(), "pubColorPick").addEventListener("input", (e) => {
  field(fs(), "pubColor").value = e.target.value;
  updatePreview();
});

function openEditor(s) {
  const f = fs();
  f.reset();
  $("form-error").hidden = true;
  fillGroupSelect();
  f.dataset.mode = s ? "edit" : "create";
  f.dataset.id = s ? s.id : "";
  $("form-title").textContent = s ? `Edit ${s.name}` : "Add service";
  $("btn-delete-svc").hidden = !s;
  field(f, "id").disabled = Boolean(s);
  setKind(s && isExternal(s) ? "external" : "managed");
  if (s) {
    field(f, "name").value = s.name;
    field(f, "id").value = s.id;
    field(f, "cwd").value = s.cwd || "";
    field(f, "command").value = fullCommand(s);
    field(f, "venv").value = s.venv || "";
    field(f, "pathPrepend").value = (s.pathPrepend || []).join("\n");
    field(f, "groupId").value = s.groupId || "";
    field(f, "autoStart").checked = Boolean(s.autoStart);
    field(f, "restartOnCrash").checked = Boolean(s.restartOnCrash);
    field(f, "env").value = envToLines(s.env);
    field(f, "url").value = s.url || "";
  } else if (state.groups.some((g) => g.id === state.tab)) {
    field(f, "groupId").value = state.tab;
  }
  const p = s?.publish;
  setPublishEnabled(Boolean(p));
  field(f, "pubPath").value = p ? String(p.path || "").replace(/^\/+/, "") : "";
  field(f, "pubUpstream").value = p?.upstream || "";
  field(f, "pubStrip").checked = p ? p.stripPrefix !== false : true;
  field(f, "pubTitle").value = p?.title || "";
  field(f, "pubDesc").value = p?.description || "";
  field(f, "pubIcon").value = p?.icon || "";
  field(f, "pubColor").value = p?.color || "";
  field(f, "pubColorPick").value = validColor(p?.color)?.length === 7 ? p.color : "#7c9cff";
  field(f, "pubOrder").value = p?.order ?? "";
  field(f, "pubBypass").value = (p?.bypass || []).join("\n");
  field(f, "pubAliases").value = (p?.rootAliases || []).join("\n");
  $("publish").open = Boolean(p);
  updatePreview();
  openDialog("dlg-service");
  field(f, "name").focus();
}

$("btn-add").addEventListener("click", () => openEditor(null));
$("btn-add-empty").addEventListener("click", () => openEditor(null));

function formError(msg, focusName) {
  $("form-error").hidden = false;
  $("form-error").textContent = msg;
  if (focusName) {
    const el = field(fs(), focusName);
    if (el?.closest("details")) el.closest("details").open = true;
    el?.focus();
  }
}

function buildPublish(f) {
  if (!field(f, "pubEnabled").checked) return { value: null };
  const path = "/" + field(f, "pubPath").value.trim().replace(/^\/+|\/+$/g, "");
  if (!/^\/[a-z0-9-]+$/.test(path) || path === "/_portal") return { error: "Public path must be one lowercase segment (a–z, 0–9, dashes).", focus: "pubPath" };
  const upstream = field(f, "pubUpstream").value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(upstream)) {
    return { error: "Upstream must be a loopback origin like http://127.0.0.1:3000.", focus: "pubUpstream" };
  }
  const color = field(f, "pubColor").value.trim();
  if (color && !validColor(color)) return { error: "Accent must be a hex color like #7c9cff.", focus: "pubColor" };
  const abs = (arr) => arr.map((x) => (x.startsWith("/") ? x : "/" + x));
  const out = {
    path,
    upstream,
    stripPrefix: field(f, "pubStrip").checked,
    title: field(f, "pubTitle").value.trim() || undefined,
    description: field(f, "pubDesc").value.trim() || undefined,
    icon: field(f, "pubIcon").value.trim() || undefined,
    color: color || undefined,
    bypass: abs(lines(field(f, "pubBypass").value)),
    rootAliases: abs(lines(field(f, "pubAliases").value)),
  };
  const order = field(f, "pubOrder").value.trim();
  if (order) out.order = Number(order);
  return { value: out };
}

$("form-service").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const kind = f.querySelector('input[name="kind"]:checked').value;
  const name = field(f, "name").value.trim();
  if (!name) return formError("Give the service a name.", "name");
  const id = field(f, "id").value.trim();
  if (id && !field(f, "id").checkValidity()) return formError("Id may use letters, digits, dot, dash and underscore.", "id");
  const pub = buildPublish(f);
  if (pub.error) return formError(pub.error, pub.focus);

  const body = { name, kind, groupId: field(f, "groupId").value || null, publish: pub.value };
  if (kind === "external") {
    const url = field(f, "url").value.trim();
    if (!/^https?:\/\//i.test(url)) return formError("External apps need a URL like http://127.0.0.1:8090.", "url");
    body.url = url;
    body.autoStart = false;
    body.restartOnCrash = false;
  } else {
    const cwd = field(f, "cwd").value.trim();
    const command = field(f, "command").value.trim();
    if (!cwd) return formError("Project folder is required for managed processes.", "cwd");
    if (!command) return formError("Command is required (e.g. pnpm dev).", "command");
    const env = envLinesToObject(field(f, "env").value);
    Object.assign(body, {
      cwd,
      command,
      args: [],
      venv: field(f, "venv").value.trim() || undefined,
      pathPrepend: lines(field(f, "pathPrepend").value),
      env,
      autoStart: field(f, "autoStart").checked,
      restartOnCrash: field(f, "restartOnCrash").checked,
    });
  }
  if (id) body.id = id;
  const btn = $("btn-save-svc");
  btn.disabled = true;
  try {
    $("form-error").hidden = true;
    let saved;
    if (f.dataset.mode === "edit") saved = await api(`/api/v1/services/${encodeURIComponent(f.dataset.id)}`, { method: "PUT", body });
    else if (id) saved = await api(`/api/v1/services/${encodeURIComponent(id)}`, { method: "PUT", body });
    else saved = await api("/api/v1/services", { method: "POST", body });
    closeDialog("dlg-service");
    await refresh();
    if (saved?.id) state.cursor = saved.id;
    toast(f.dataset.mode === "edit" ? `Saved ${name}` : `Added ${name}`);
    if (state.portal) loadPortal();
  } catch (err) {
    formError(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("btn-delete-svc").addEventListener("click", async () => {
  const f = fs();
  const s = state.services.find((x) => x.id === f.dataset.id);
  if (!s) return;
  const ok = await confirmDialog({
    title: `Remove ${s.name}?`,
    body: "It's stopped and unregistered from Service Runner. Project files and old logs stay on disk.",
    ok: "Remove service",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/v1/services/${encodeURIComponent(s.id)}`, { method: "DELETE" });
    closeDialog("dlg-service");
    if (Con.id === s.id) closeConsole();
    await refresh();
    toast(`Removed ${s.name}`);
  } catch (err) {
    formError(err.message);
  }
});

/* ================= settings ================= */

let tokenShown = false;
$("btn-settings").addEventListener("click", async () => {
  try {
    const s = await api("/api/v1/settings");
    const f = $("form-settings");
    field(f, "logRetentionDays").value = s.logRetentionDays;
    field(f, "port").value = s.port;
    f.dataset.port = s.port;
    field(f, "autoStartOnBoot").checked = s.autoStartOnBoot;
    field(f, "openDashboardOnLaunch").checked = s.openDashboardOnLaunch;
    tokenShown = false;
    $("set-token").textContent = "•".repeat(24);
    $("settings-error").hidden = true;
    $("config-dir").textContent = SR.configDir || "%LOCALAPPDATA%\\ServiceRunner";
    openDialog("dlg-settings");
  } catch (err) {
    fail(err);
  }
});
$("btn-token-reveal").addEventListener("click", () => {
  tokenShown = !tokenShown;
  $("set-token").textContent = tokenShown ? TOKEN : "•".repeat(24);
});
$("btn-token-copy").addEventListener("click", async () => {
  if (await copyText(TOKEN)) toast("Master token copied");
});
$("btn-token-regen").addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Regenerate the master token?",
    body: "Agents and scripts using the old token stop working until you paste the new prompt. This page reloads to pick up the new token.",
    ok: "Regenerate",
    danger: true,
  });
  if (!ok) return;
  try {
    await api("/api/v1/settings", { method: "PATCH", body: { regenerateToken: true } });
    toast("Token regenerated — reloading");
    setTimeout(() => location.reload(), 700);
  } catch (err) {
    fail(err);
  }
});
$("form-settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    logRetentionDays: Number(field(f, "logRetentionDays").value),
    autoStartOnBoot: field(f, "autoStartOnBoot").checked,
    openDashboardOnLaunch: field(f, "openDashboardOnLaunch").checked,
  };
  const port = Number(field(f, "port").value);
  if (port && String(port) !== f.dataset.port) body.port = port;
  try {
    const res = await api("/api/v1/settings", { method: "PATCH", body });
    const prompt = await api("/api/v1/prompt").catch(() => null);
    if (prompt) {
      SR.prompt = prompt.text;
      SR.logRetentionDays = prompt.logRetentionDays;
      state.promptInfo = prompt;
      renderPrompt();
    }
    closeDialog("dlg-settings");
    toast(res.restartRequired ? `Saved — restart Service Runner to move to port ${port}` : "Settings saved");
  } catch (err) {
    $("settings-error").hidden = false;
    $("settings-error").textContent = err.message;
  }
});

/* ================= agent prompt ================= */

function renderPrompt() {
  const text = SR.prompt || "";
  const pre = $("prompt-text");
  if (state.revealPrompt || !TOKEN) {
    pre.textContent = text;
  } else {
    pre.innerHTML = esc(text).split(esc(TOKEN)).join(`<span class="tok">••••••••••••</span>`);
  }
  const btn = $("btn-reveal-prompt");
  btn.setAttribute("aria-pressed", String(state.revealPrompt));
  btn.querySelector("span").textContent = state.revealPrompt ? "Hide token" : "Show token";
  btn.querySelector("use").setAttribute("href", state.revealPrompt ? "#i-eye-off" : "#i-eye");

  const info = state.promptInfo;
  if (info?.endpoints) {
    $("endpoints-card").hidden = false;
    $("endpoints").innerHTML = Object.entries(info.endpoints)
      .map(([k, v]) => {
        const [m, ...rest] = String(v).split(" ");
        return `<li><span class="ep-m ${esc(m.toLowerCase())}">${esc(m)}</span><span class="ep-p">${esc(rest.join(" "))}</span><span class="ep-k">${esc(k)}</span></li>`;
      })
      .join("");
  }
}
$("btn-reveal-prompt").addEventListener("click", () => {
  state.revealPrompt = !state.revealPrompt;
  renderPrompt();
});
$("btn-copy").addEventListener("click", async () => {
  if (await copyText(SR.prompt || "")) flashLabel($("btn-copy"), "Copied");
});

/* ================= portal ================= */

let portalLoading = null;
function loadPortal() {
  if (portalLoading) return portalLoading;
  portalLoading = api("/api/v1/portal")
    .then((p) => {
      state.portal = p;
      $("portal-missing").hidden = true;
      $("portal-error").hidden = true;
      $("portal-body").hidden = false;
      renderPortal();
    })
    .catch((err) => {
      if (err.status === 404) {
        state.portal = false;
        $("portal-missing").hidden = false;
        $("portal-error").hidden = true;
      } else {
        $("portal-error").hidden = false;
        $("portal-error-msg").textContent = err.message;
      }
      $("portal-body").hidden = true;
      $("portal-dot").hidden = true;
    })
    .finally(() => {
      portalLoading = null;
    });
  return portalLoading;
}
$("portal-retry").addEventListener("click", loadPortal);

/** Tailscale strip in the Gateway card: install → sign in → expose → live. */
function renderTunnel(t) {
  const el = $("p-tunnel");
  if (!t) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.classList.toggle("ok", t.funnelToPortal);
  el.classList.toggle("warn", !t.funnelToPortal);
  let body;
  let action = "";
  if (!t.installed) {
    body = `<b>Tailscale isn't installed</b><p class="muted">It gives this machine a free, permanent HTTPS address (Funnel) so the portal is reachable from any browser.</p>`;
    action = `<a class="btn sm primary" href="${esc(t.installUrl)}" target="_blank" rel="noopener">Install Tailscale ${icon("external")}</a>`;
  } else if (!t.running) {
    body = `<b>Tailscale isn't connected</b><p class="muted">Open Tailscale from the tray and sign in, then come back here.</p>`;
  } else if (!t.funnelToPortal) {
    body = `<b>Tailscale is connected as <span class="mono">${esc(t.dnsName)}</span></b><p class="muted">Run this once to put the portal on the internet — it survives reboots: <code>${esc(t.command)}</code></p>`;
    action = `<button type="button" class="btn sm" id="p-tunnel-copy">${icon("copy")} Copy</button>`;
  } else {
    body = `<b>Live via Tailscale Funnel</b><p class="muted"><a class="url" href="${esc(t.publicUrl)}" target="_blank" rel="noopener">${esc(t.publicUrl.replace(/^https:\/\//, ""))} ${icon("external")}</a></p>`;
  }
  el.innerHTML = `${icon("globe")}<div>${body}</div>${action}`;
  $("p-tunnel-copy")?.addEventListener("click", async () => {
    if (await copyText(t.command)) toast("Command copied");
  });
}

function renderPortal() {
  const p = state.portal;
  if (!p) return;
  $("portal-dot").hidden = !(p.enabled && p.listening);
  $("p-enabled").checked = Boolean(p.enabled);

  const gw = $("gw-state");
  const dot = gw.querySelector(".dot");
  const listening = p.enabled && p.listening;
  dot.dataset.s = listening ? "running" : p.enabled ? "crashed" : "stopped";
  $("gw-label").textContent = listening ? "Listening" : p.enabled ? "Enabled, not listening" : "Off";
  $("gw-sub").textContent = listening
    ? p.localUrl || `127.0.0.1:${p.port}`
    : p.enabled
      ? `Port ${p.port} may be in use — check Service Runner's log.`
      : "Turn it on to serve the login page and published apps.";
  const links = [];
  if (listening && p.localUrl) links.push(`<a class="url" href="${esc(p.localUrl)}" target="_blank" rel="noopener">local ${icon("external")}</a>`);
  if (p.publicUrl) links.push(`<a class="url" href="${esc(p.publicUrl)}" target="_blank" rel="noopener">${esc(p.publicUrl.replace(/^https?:\/\//, ""))} ${icon("external")}</a>`);
  $("gw-links").innerHTML = links.join("");
  renderTunnel(p.tunnel);

  const f = $("p-form");
  if (!f.dataset.dirty) {
    field(f, "title").value = p.title || "";
    field(f, "publicUrl").value = p.publicUrl || "";
    field(f, "port").value = p.port || "";
    field(f, "sessionDays").value = p.sessionDays || "";
    $("p-save").disabled = true;
  }

  const sessions = p.sessions || [];
  $("tok-pill").textContent = p.tokenSet ? "set" : "not set";
  $("tok-pill").classList.toggle("ok", Boolean(p.tokenSet));
  $("btn-gen-token-label").textContent = p.tokenSet ? "Generate new token" : "Generate access token";
  $("tok-desc").textContent = p.tokenSet
    ? `People sign in once per device. ${sessions.length} device${sessions.length === 1 ? " is" : "s are"} signed in.`
    : "No token yet — nobody can sign in until you generate one.";

  const apps = p.apps || [];
  $("apps-count").textContent = apps.length;
  const pub = (p.publicUrl || "").replace(/\/$/, "");
  const local = (p.localUrl || "").replace(/\/$/, "");
  $("p-apps").innerHTML = apps.length
    ? apps
        .map((a) => {
          const href = pub ? pub + a.path : listening && local ? local + a.path : "";
          return `<li class="app-item" data-id="${esc(a.id)}">
            <span class="app-ico" data-color="${esc(validColor(a.color))}" data-icon="${esc(a.icon || "")}" data-name="${esc(a.name)}"></span>
            <div class="app-meta"><b>${esc(a.name)} <i class="dot" data-s="${a.status === "up" ? "running" : "stopped"}" title="${a.status === "up" ? "up" : "down"}"></i></b><span class="mono">${esc(a.path)}${a.description ? ` · <span class="desc">${esc(a.description)}</span>` : ""}</span></div>
            <div class="app-acts">
              ${href ? `<a class="icon-btn" href="${esc(href)}" target="_blank" rel="noopener" title="Open ${esc(href)}" aria-label="Open ${esc(a.name)}">${icon("external")}</a>` : ""}
              ${state.services.some((s) => s.id === a.id) ? `<button type="button" class="icon-btn" data-edit="${esc(a.id)}" title="Edit publishing" aria-label="Edit ${esc(a.name)}">${icon("edit")}</button>` : ""}
            </div>
          </li>`;
        })
        .join("")
    : `<li class="list-empty">Nothing published yet. Open a service's editor and expand “Publish to portal”.</li>`;
  for (const el of $("p-apps").querySelectorAll(".app-ico")) {
    if (el.dataset.color) el.style.setProperty("--c", el.dataset.color);
    renderIcon(el, el.dataset.icon, el.dataset.name);
  }

  $("dev-count").textContent = sessions.length;
  $("btn-revoke-all").disabled = !sessions.length;
  const sorted = [...sessions].sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0));
  $("p-devices").innerHTML = sorted.length
    ? sorted
        .map((d) => {
          const fresh = Date.now() - Date.parse(d.lastSeenAt) < 5 * 60 * 1000;
          return `<li class="dev-item">
            <span class="dev-ico">${icon("devices")}</span>
            <div class="dev-meta"><b>${esc(d.deviceName || uaSummary(d.userAgent))}</b><span>${esc(uaSummary(d.userAgent))} · <span class="mono">${esc(d.ip || "—")}</span></span></div>
            <div class="dev-when"><div class="${fresh ? "now" : ""}" title="${esc(d.lastSeenAt)}">${fresh ? "active now" : "seen " + esc(relTime(d.lastSeenAt))}</div><div title="${esc(d.createdAt)}">since ${esc(relTime(d.createdAt))}</div></div>
            <div class="dev-acts"><button type="button" class="btn sm ghost danger-hover" data-revoke="${esc(d.id)}">Revoke</button></div>
          </li>`;
        })
        .join("")
    : `<li class="list-empty">${p.tokenSet ? "No devices are signed in." : "Generate a token, then sign in at the portal from your phone or laptop."}</li>`;
}

$("p-apps").addEventListener("click", (e) => {
  const b = e.target.closest("[data-edit]");
  if (!b) return;
  const s = state.services.find((x) => x.id === b.dataset.edit);
  if (s) openEditor(s);
});

$("p-enabled").addEventListener("change", async (e) => {
  const on = e.target.checked;
  try {
    state.portal = await api("/api/v1/portal", { method: "PATCH", body: { enabled: on } });
    renderPortal();
    toast(on ? "Portal enabled" : "Portal disabled");
  } catch (err) {
    e.target.checked = !on;
    fail(err);
  }
});

$("p-form").addEventListener("input", () => {
  $("p-form").dataset.dirty = "1";
  $("p-save").disabled = false;
});
$("p-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const publicUrl = field(f, "publicUrl").value.trim().replace(/\/+$/, "");
  if (publicUrl && !/^https?:\/\/[^\s/]+$/i.test(publicUrl)) {
    toast("Public URL should be an origin like https://box.example.ts.net", "err");
    field(f, "publicUrl").focus();
    return;
  }
  const body = {
    title: field(f, "title").value.trim(),
    publicUrl,
    port: Number(field(f, "port").value) || undefined,
    sessionDays: Number(field(f, "sessionDays").value) || undefined,
  };
  try {
    $("p-save").disabled = true;
    state.portal = await api("/api/v1/portal", { method: "PATCH", body });
    delete f.dataset.dirty;
    renderPortal();
    toast("Portal settings saved");
  } catch (err) {
    $("p-save").disabled = false;
    fail(err);
  }
});

$("btn-gen-token").addEventListener("click", async () => {
  const p = state.portal || {};
  const n = (p.sessions || []).length;
  const ok = await confirmDialog({
    title: p.tokenSet ? "Generate a new access token?" : "Generate an access token?",
    body: p.tokenSet
      ? `The current token stops working and ${n ? `all ${n} signed-in device${n === 1 ? "" : "s"} are signed out` : "every device is signed out"} immediately.`
      : "You'll see it once. Anyone with it can sign in to the portal, so share it only with people you trust.",
    ok: "Generate token",
    danger: Boolean(p.tokenSet),
  });
  if (!ok) return;
  try {
    const { token } = await api("/api/v1/portal/token", { method: "POST" });
    $("new-token").textContent = token;
    openDialog("dlg-token");
    loadPortal();
  } catch (err) {
    fail(err);
  }
});
$("btn-new-token-copy").addEventListener("click", async () => {
  if (await copyText($("new-token").textContent)) flashLabel($("btn-new-token-copy"), "Copied");
});
$("dlg-token").addEventListener("close", () => {
  $("new-token").textContent = "";
});
$("dlg-token").addEventListener("cancel", (e) => {
  // Make the user acknowledge with the button; Esc is fine too but keep the token visible until then.
  e.preventDefault();
});

$("p-devices").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-revoke]");
  if (!b) return;
  const d = (state.portal?.sessions || []).find((x) => x.id === b.dataset.revoke);
  const ok = await confirmDialog({
    title: `Sign out ${d?.deviceName || "this device"}?`,
    body: "It will need the access token to sign in again.",
    ok: "Revoke",
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/v1/portal/sessions/${encodeURIComponent(b.dataset.revoke)}`, { method: "DELETE" });
    toast("Device signed out");
    loadPortal();
  } catch (err) {
    fail(err);
  }
});
$("btn-revoke-all").addEventListener("click", async () => {
  const n = (state.portal?.sessions || []).length;
  const ok = await confirmDialog({
    title: "Sign out every device?",
    body: `${n} device${n === 1 ? "" : "s"} will need the access token to sign in again. The token itself stays valid.`,
    ok: "Revoke all",
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api("/api/v1/portal/sessions", { method: "DELETE" });
    toast(`Signed out ${r.revoked ?? n} device${(r.revoked ?? n) === 1 ? "" : "s"}`);
    loadPortal();
  } catch (err) {
    fail(err);
  }
});

/* ================= log console ================= */

const CHUNK = 200;
const MAX_LINES = 20000;
const TAIL = 5000;

const Con = {
  id: null,
  date: null, // null = today (live)
  files: [],
  lines: [],
  counts: { stdout: 0, stderr: 0, sys: 0 },
  q: "",
  ql: "",
  only: false,
  streams: { stdout: true, stderr: true, sys: true },
  wrap: false,
  follow: true,
  unseen: 0,
  loading: false,
  pending: [],
  queue: [],
  raf: 0,
  cur: -1,
  shown: 0,
  lastChunk: null,
  lastCount: 0,
  seq: 0,
};

try {
  Con.wrap = localStorage.getItem("sr-wrap") === "1";
} catch {
  /* ignore */
}

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+\[(stdout|stderr|sys)\]\s?(.*)$/;
const pad = (n, w = 2) => String(n).padStart(w, "0");
function clock(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}<i>.${pad(d.getMilliseconds(), 3)}</i>`;
}
function makeLine(ts, stream, text) {
  return { ts, t: clock(ts), stream, text, lower: null };
}
function parseLine(raw) {
  const m = LINE_RE.exec(raw);
  if (!m) return makeLine("", "stdout", raw);
  return makeLine(m[1], m[2], m[3]);
}
const rawOf = (l) => (l.ts ? `${l.ts} [${l.stream}] ${l.text}` : l.text);
const lowerOf = (l) => (l.lower ??= l.text.toLowerCase());
const passes = (l) => Con.streams[l.stream] && (!Con.only || !Con.ql || lowerOf(l).includes(Con.ql));

const LOG_URL_RE = /https?:\/\/[^\s<>"'\\]+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s<>"'\\]*)?/gi;
const trimUrl = (raw) => raw.replace(/[),.;\]]+$/g, "");
const hrefFor = (raw) => (/^https?:\/\//i.test(raw) ? raw : "http://" + raw);

function hl(s) {
  if (!Con.ql) return esc(s);
  const lower = s.toLowerCase();
  const q = Con.ql;
  let out = "";
  let i = 0;
  let j;
  while ((j = lower.indexOf(q, i)) !== -1) {
    out += esc(s.slice(i, j)) + "<mark>" + esc(s.slice(j, j + q.length)) + "</mark>";
    i = j + q.length;
  }
  return out + esc(s.slice(i));
}

function textHtml(s) {
  let out = "";
  let last = 0;
  LOG_URL_RE.lastIndex = 0;
  let m;
  while ((m = LOG_URL_RE.exec(s))) {
    const raw = trimUrl(m[0]);
    out += hl(s.slice(last, m.index));
    out += `<a href="${esc(hrefFor(raw))}" target="_blank" rel="noopener">${hl(raw)}</a>`;
    last = m.index + raw.length;
    LOG_URL_RE.lastIndex = last;
  }
  return out + hl(s.slice(last));
}

const STREAM_TAG = { stdout: "", stderr: "err", sys: "sys" };
function lineHtml(l) {
  return `<div class="ln ${l.stream}"><span class="lt">${l.t}</span><span class="ls">${STREAM_TAG[l.stream]}</span><span class="lx">${textHtml(l.text)}</span></div>`;
}

const body = () => $("log-body");

function rebuild() {
  const vis = Con.lines.filter(passes);
  Con.shown = vis.length;
  const el = body();
  el.classList.toggle("wrap", Con.wrap);
  if (!vis.length) {
    el.innerHTML = Con.lines.length
      ? `<div class="con-empty">No lines match the current filters.</div>`
      : Con.loading
        ? `<div class="con-empty">Loading…</div>`
        : `<div class="con-empty"><b>No log lines yet.</b><br/>Output from the process appears here live.</div>`;
    Con.lastChunk = null;
    Con.lastCount = 0;
  } else {
    const parts = [];
    for (let i = 0; i < vis.length; i += CHUNK) {
      let h = "";
      const end = Math.min(vis.length, i + CHUNK);
      for (let k = i; k < end; k++) h += lineHtml(vis[k]);
      parts.push(`<div class="chunk">${h}</div>`);
    }
    el.innerHTML = parts.join("");
    Con.lastChunk = el.lastElementChild;
    Con.lastCount = vis.length % CHUNK || CHUNK;
  }
  Con.cur = -1;
  updateMeta();
  if (Con.follow) scrollBottom();
}

function scrollBottom() {
  const el = body();
  el.scrollTop = el.scrollHeight;
  // content-visibility may refine heights after layout; settle on the next frame
  requestAnimationFrame(() => {
    if (Con.follow) el.scrollTop = el.scrollHeight;
  });
  Con.unseen = 0;
  updateJump();
}

function pushLine(l) {
  Con.lines.push(l);
  Con.counts[l.stream]++;
  if (Con.lines.length > MAX_LINES) {
    const drop = Con.lines.splice(0, Math.floor(MAX_LINES / 10));
    for (const d of drop) Con.counts[d.stream]--;
    Con.queue = [];
    cancelAnimationFrame(Con.raf);
    Con.raf = requestAnimationFrame(() => {
      Con.raf = 0;
      rebuild();
    });
    return;
  }
  if (!passes(l)) {
    updateCounts();
    return;
  }
  Con.queue.push(l);
  if (!Con.raf) Con.raf = requestAnimationFrame(flushQueue);
}

function flushQueue() {
  Con.raf = 0;
  const q = Con.queue;
  Con.queue = [];
  if (!q.length) return;
  const el = body();
  if (!Con.lastChunk) {
    el.innerHTML = "";
  }
  let i = 0;
  while (i < q.length) {
    if (!Con.lastChunk || Con.lastCount >= CHUNK) {
      Con.lastChunk = document.createElement("div");
      Con.lastChunk.className = "chunk";
      el.appendChild(Con.lastChunk);
      Con.lastCount = 0;
    }
    const room = CHUNK - Con.lastCount;
    const slice = q.slice(i, i + room);
    Con.lastChunk.insertAdjacentHTML("beforeend", slice.map(lineHtml).join(""));
    Con.lastCount += slice.length;
    i += slice.length;
  }
  Con.shown += q.length;
  if (Con.follow) scrollBottom();
  else {
    Con.unseen += q.length;
    updateJump();
  }
  updateMeta();
}

function updateCounts() {
  for (const k of ["stdout", "stderr", "sys"]) $("n-" + k).textContent = Con.counts[k] > 999 ? `${(Con.counts[k] / 1000).toFixed(1)}k` : Con.counts[k];
}

function updateMeta() {
  updateCounts();
  const total = Con.lines.length;
  const day = Con.date || "today";
  $("log-meta").textContent = `${Con.shown.toLocaleString()}${Con.shown !== total ? ` of ${total.toLocaleString()}` : ""} lines · ${day}${Con.date ? "" : " · live"}`;
  const marks = body().getElementsByTagName("mark").length;
  $("log-count").textContent = Con.ql ? (marks ? `${Con.cur >= 0 ? Con.cur + 1 + "/" : ""}${marks}` : "0") : "";
  const st = $("log-state");
  if (Con.date) {
    st.textContent = "history";
    st.className = "";
  } else {
    st.textContent = Con.follow ? "● following" : "❚❚ paused";
    st.className = Con.follow ? "following" : "paused";
  }
  $("log-follow").setAttribute("aria-pressed", String(Con.follow));
}

function updateJump() {
  const j = $("log-jump");
  j.hidden = Con.follow;
  $("log-jump-label").textContent = Con.unseen ? `${Con.unseen.toLocaleString()} new line${Con.unseen === 1 ? "" : "s"}` : "Jump to latest";
}

function setFollow(on) {
  Con.follow = on;
  if (on) scrollBottom();
  updateJump();
  updateMeta();
}

let lastScrollTop = 0;
$("log-body").addEventListener(
  "scroll",
  () => {
    const el = body();
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    const goingUp = el.scrollTop < lastScrollTop;
    lastScrollTop = el.scrollTop;
    if (atBottom && !Con.follow) setFollow(true);
    else if (!atBottom && Con.follow && goingUp) setFollow(false);
  },
  { passive: true },
);

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

async function loadLogs() {
  const id = Con.id;
  if (!id) return;
  const seq = ++Con.seq;
  Con.loading = true;
  Con.pending = [];
  Con.lines = [];
  Con.counts = { stdout: 0, stderr: 0, sys: 0 };
  rebuild();
  try {
    const q = new URLSearchParams({ tail: String(TAIL) });
    if (Con.date) q.set("date", Con.date);
    const data = await api(`/api/v1/services/${encodeURIComponent(id)}/logs?${q}`);
    if (seq !== Con.seq) return;
    Con.files = data.files || [];
    renderDates();
    const raw = String(data.text || "").split("\n");
    const out = [];
    for (const r of raw) if (r) out.push(parseLine(r));
    Con.lines = out;
    for (const l of out) Con.counts[l.stream]++;
    // Lines that streamed in while we fetched
    const lastTs = out.length ? out[out.length - 1].ts : "";
    for (const l of Con.pending) if (!lastTs || l.ts > lastTs) {
      Con.lines.push(l);
      Con.counts[l.stream]++;
    }
  } catch (err) {
    if (seq === Con.seq) fail(err);
  } finally {
    if (seq === Con.seq) {
      Con.loading = false;
      Con.pending = [];
      Con.follow = true;
      rebuild();
    }
  }
}

function renderDates() {
  const sel = $("log-date");
  const today = todayStamp();
  const files = Con.files.includes(today) ? Con.files : [today, ...Con.files];
  sel.innerHTML = files.map((d) => `<option value="${esc(d)}">${d === today ? "today · live" : esc(d)}</option>`).join("");
  sel.value = Con.date || today;
}

function statusLabel(s) {
  const st = s.runtime.status;
  const pid = s.runtime.pid ? ` · pid ${s.runtime.pid}` : "";
  const up = ACTIVE.has(st) && s.runtime.startedAt ? ` · up ${formatUptime((Date.now() - Date.parse(s.runtime.startedAt)) / 1000)}` : "";
  return `${st}${pid}${up}`;
}

function renderConsoleChip() {
  const s = state.services.find((x) => x.id === Con.id);
  if (s) $("con-status").textContent = statusLabel(s);
}

function renderConsoleHead() {
  const s = state.services.find((x) => x.id === Con.id);
  if (!s) return;
  $("con-dot").dataset.s = s.runtime.status;
  $("con-name").textContent = s.name;
  $("con-sub").textContent = isExternal(s) ? s.url || "" : s.cwd;
  $("con-sub").title = isExternal(s) ? s.url || "" : `${s.cwd}\n${fullCommand(s)}`;
  renderConsoleChip();
  const ext = isExternal(s);
  const active = ACTIVE.has(s.runtime.status);
  const sb = $("con-start");
  sb.hidden = ext;
  $("con-restart").hidden = ext;
  sb.querySelector("use").setAttribute("href", active ? "#i-stop" : "#i-play");
  sb.title = active ? "Stop (x)" : "Start (s)";
  sb.setAttribute("aria-label", sb.title);
}

function openConsole(s) {
  const changed = Con.id !== s.id;
  Con.id = s.id;
  state.cursor = s.id;
  $("console").hidden = false;
  $("split").classList.add("has-console");
  setHash(`#/logs/${s.id}`);
  if (changed) {
    Con.date = null;
    Con.files = [];
    $("log-q").value = Con.q;
    renderDates();
    loadLogs();
  }
  render();
  document.querySelector(`.svc[data-id="${CSS.escape(s.id)}"]`)?.scrollIntoView({ block: "nearest" });
}

function closeConsole() {
  Con.id = null;
  Con.seq++;
  $("console").hidden = true;
  $("split").classList.remove("has-console");
  body().innerHTML = "";
  Con.lines = [];
  setHash("#/services");
  render();
}

$("con-close").addEventListener("click", closeConsole);
$("con-start").addEventListener("click", () => {
  const s = state.services.find((x) => x.id === Con.id);
  if (s) serviceAction(s, ACTIVE.has(s.runtime.status) ? "stop" : "start");
});
$("con-restart").addEventListener("click", () => serviceAction(state.services.find((x) => x.id === Con.id), "restart"));
$("log-date").addEventListener("change", (e) => {
  Con.date = e.target.value === todayStamp() ? null : e.target.value;
  loadLogs();
});
$("log-refresh").addEventListener("click", loadLogs);
$("log-clear").addEventListener("click", () => {
  Con.lines = [];
  Con.counts = { stdout: 0, stderr: 0, sys: 0 };
  rebuild();
  toast("View cleared — log files are untouched. Reload to bring them back.");
});
$("log-wrap").addEventListener("click", () => toggleWrap());
function toggleWrap() {
  Con.wrap = !Con.wrap;
  $("log-wrap").setAttribute("aria-pressed", String(Con.wrap));
  body().classList.toggle("wrap", Con.wrap);
  try {
    localStorage.setItem("sr-wrap", Con.wrap ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (Con.follow) scrollBottom();
}
$("log-wrap").setAttribute("aria-pressed", String(Con.wrap));
$("log-follow").addEventListener("click", () => setFollow(!Con.follow));
$("log-jump").addEventListener("click", () => setFollow(true));
$("log-only").addEventListener("click", () => {
  Con.only = !Con.only;
  $("log-only").setAttribute("aria-pressed", String(Con.only));
  rebuild();
});
for (const b of document.querySelectorAll("[data-stream]")) {
  b.addEventListener("click", () => {
    const k = b.dataset.stream;
    Con.streams[k] = !Con.streams[k];
    b.setAttribute("aria-pressed", String(Con.streams[k]));
    rebuild();
  });
}

let qTimer = 0;
$("log-q").addEventListener("input", (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => {
    Con.q = e.target.value;
    Con.ql = Con.q.toLowerCase();
    const wasFollow = Con.follow;
    rebuild();
    if (Con.ql && !Con.only) jumpMatch(1, !wasFollow);
  }, 120);
});
$("log-q").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    jumpMatch(e.shiftKey ? -1 : 1);
  } else if (e.key === "Escape") {
    e.stopPropagation();
    if (e.target.value) {
      e.target.value = "";
      Con.q = Con.ql = "";
      rebuild();
    } else e.target.blur();
  }
});
$("log-next").addEventListener("click", () => jumpMatch(1));
$("log-prev").addEventListener("click", () => jumpMatch(-1));

function jumpMatch(dir, fromTop = false) {
  const marks = body().getElementsByTagName("mark");
  if (!marks.length) {
    updateMeta();
    return;
  }
  if (Con.cur >= 0 && marks[Con.cur]) marks[Con.cur].classList.remove("cur");
  if (Con.cur < 0) Con.cur = dir > 0 ? (fromTop ? 0 : marks.length - 1) : marks.length - 1;
  else Con.cur = (Con.cur + dir + marks.length) % marks.length;
  const m = marks[Con.cur];
  m.classList.add("cur");
  Con.follow = false;
  m.scrollIntoView({ block: "center", inline: "nearest" });
  updateJump();
  updateMeta();
}

$("log-copy").addEventListener("click", async () => {
  const sel = window.getSelection();
  const picked = sel && body().contains(sel.anchorNode) && sel.toString() ? sel.toString() : "";
  const text = picked || Con.lines.filter(passes).map(rawOf).join("\n");
  if (!text) return;
  if (await copyText(text)) toast(picked ? "Copied selection" : `Copied ${Con.shown.toLocaleString()} lines`);
});
$("log-download").addEventListener("click", () => {
  const text = Con.lines.filter(passes).map(rawOf).join("\n") + "\n";
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${Con.id}_${Con.date || todayStamp()}.log`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 500);
});

function onLogEvent(ev) {
  if (ev.serviceId !== Con.id || Con.date) return;
  const l = makeLine(ev.ts, ev.stream, ev.line);
  if (Con.loading) Con.pending.push(l);
  else pushLine(l);
}

/* ================= live events (SSE over fetch, so we can send the bearer) ================= */

function setConn(s) {
  $("conn").dataset.state = s;
  $("conn-label").textContent = s;
}

let sseBackoff = 1000;
function connectEvents() {
  setConn("connecting");
  fetch("/api/v1/events", { headers: { Authorization: `Bearer ${TOKEN}` } })
    .then(async (res) => {
      if (!res.ok || !res.body) throw new Error("events " + res.status);
      setConn("live");
      sseBackoff = 1000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new Error("closed");
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const block of parts) {
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          onEvent(ev);
        }
      }
    })
    .catch(() => {
      setConn("offline");
      setTimeout(connectEvents, sseBackoff);
      sseBackoff = Math.min(sseBackoff * 1.6, 10000);
    });
}

function onEvent(ev) {
  switch (ev.type) {
    case "hello":
      state.services = ev.services;
      state.groups = ev.groups;
      render();
      applyRouteOnce();
      break;
    case "config":
      refreshSoon();
      break;
    case "status": {
      const s = state.services.find((x) => x.id === ev.serviceId);
      if (!s) {
        refreshSoon();
        break;
      }
      const prev = s.runtime.status;
      s.runtime.status = ev.status;
      s.runtime.pid = ev.pid;
      if (ACTIVE.has(ev.status) && !ACTIVE.has(prev)) s.runtime.startedAt = new Date().toISOString();
      render();
      refreshSoon(); // pick up startedAt / exitCode from the server
      break;
    }
    case "urls": {
      const s = state.services.find((x) => x.id === ev.serviceId);
      if (s) {
        s.runtime.urls = ev.urls;
        render();
      }
      break;
    }
    case "log":
      onLogEvent(ev);
      break;
    case "portal":
      if (state.portal !== false) loadPortal();
      break;
  }
}

let routed = false;
function applyRouteOnce() {
  if (routed) return;
  routed = true;
  applyRoute();
}

/* ================= keyboard ================= */

function typingIn(el) {
  if (!el) return false;
  if (el.tagName === "INPUT") return !/^(checkbox|radio|button|submit|reset|color)$/i.test(el.type);
  return el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

function moveCursor(d) {
  const list = visibleServices();
  if (!list.length) return;
  let i = list.findIndex((s) => s.id === state.cursor);
  i = i < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + d));
  state.cursor = list[i].id;
  render();
  document.querySelector(`.svc[data-id="${CSS.escape(state.cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  if (Con.id && Con.id !== state.cursor) {
    clearTimeout(moveCursor.t);
    moveCursor.t = setTimeout(() => {
      const s = state.services.find((x) => x.id === state.cursor);
      if (s) openConsole(s);
    }, 180);
  }
}

document.addEventListener("keydown", (e) => {
  if (!TOKEN) return;
  if (document.querySelector("dialog[open]")) return;
  if (e.ctrlKey && e.key.toLowerCase() === "f" && Con.id && state.view === "services") {
    e.preventDefault();
    $("log-q").focus();
    $("log-q").select();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (typingIn(e.target)) return;
  const sel = state.services.find((x) => x.id === (state.cursor || Con.id));
  const k = e.key;
  if (k === "?") return void openDialog("dlg-keys");
  if (k === "t") return toggleTheme();
  if (k === "1") return void (location.hash = "#/services");
  if (k === "2") return void (location.hash = "#/portal");
  if (k === "3") return void (location.hash = "#/agent");
  if (state.view !== "services") return;
  if (k === "/") {
    e.preventDefault();
    if (Con.id) {
      $("log-q").focus();
      $("log-q").select();
    } else $("svc-filter").focus();
    return;
  }
  if (k === "j" || k === "ArrowDown") {
    if (k === "ArrowDown" && e.target === body()) return;
    e.preventDefault();
    return moveCursor(1);
  }
  if (k === "k" || k === "ArrowUp") {
    if (k === "ArrowUp" && e.target === body()) return;
    e.preventDefault();
    return moveCursor(-1);
  }
  if (k === "n") {
    e.preventDefault();
    return openEditor(null);
  }
  if (k === "Escape") {
    if (Con.id) closeConsole();
    else if (state.filter) {
      state.filter = "";
      $("svc-filter").value = "";
      render();
    }
    return;
  }
  if (Con.id && k === "w") return toggleWrap();
  if (Con.id && k === "f") return setFollow(!Con.follow);
  if (Con.id && (k === "G" || k === "End") && e.target !== body()) return setFollow(true);
  if (!sel) return;
  if (k === "Enter" || k === "l") {
    if (e.target.closest?.("button, a")) return;
    e.preventDefault();
    return openConsole(sel);
  }
  if (k === "s") return serviceAction(sel, "start");
  if (k === "x") return serviceAction(sel, "stop");
  if (k === "r") return serviceAction(sel, "restart");
  if (k === "e") {
    e.preventDefault();
    return openEditor(sel);
  }
});
$("btn-keys").addEventListener("click", () => openDialog("dlg-keys"));

/* ================= boot ================= */

function boot() {
  if (SR.version) $("brand-ver").textContent = `v${SR.version}`;
  window.addEventListener("hashchange", applyRoute);
  showView(parseHash().view);
  renderPrompt();
  refresh()
    .then(applyRouteOnce)
    .catch(fail);
  api("/api/v1/prompt")
    .then((p) => {
      state.promptInfo = p;
      if (p.text) SR.prompt = p.text;
      renderPrompt();
    })
    .catch(() => {});
  loadStats();
  setInterval(loadStats, 3000);
  setInterval(tickUptimes, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) loadStats();
  });
  // Probe the portal once so the nav dot and publish helper know the public URL.
  loadPortal();
  connectEvents();
}

if (!TOKEN) {
  $("offline").hidden = false;
  $("statbar").hidden = true;
  document.querySelector(".views").hidden = true;
  $("conn").hidden = true;
  $("btn-settings").hidden = true;
  $("btn-keys").hidden = true;
  for (const v of document.querySelectorAll(".view")) v.hidden = true;
} else {
  boot();
}
