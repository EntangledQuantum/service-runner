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
let state = { services: [], groups: [], tab: "all", selected: null, stats: null };

const $ = (id) => document.getElementById(id);
const field = (form, name) => form.elements.namedItem(name);

if (!TOKEN) {
  $("offline").hidden = false;
  $("status-panel").hidden = true;
  $("prompt-card").hidden = true;
  document.querySelector(".dash-toolbar").hidden = true;
} else {
  boot();
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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

function envToLines(env) {
  if (!env) return "";
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function setPrompt() {
  if ($("prompt-text")) $("prompt-text").textContent = SR.prompt || "";
  if ($("config-dir")) $("config-dir").textContent = SR.configDir || "%LOCALAPPDATA%\\ServiceRunner";
}

function formatUptime(sec) {
  if (!Number.isFinite(sec)) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${sec}s`;
}

function formatMb(n) {
  if (n === undefined || n === null || Number.isNaN(n)) return "—";
  return `${n} MB`;
}

function renderStats() {
  const s = state.stats;
  const running = state.services.filter((x) => x.runtime.status === "running" || x.runtime.status === "starting").length;
  const crashed = state.services.filter((x) => x.runtime.status === "crashed").length;
  const live = $("status-live");
  live.classList.toggle("live", running > 0);
  $("status-live-label").textContent = running ? "Live" : "Idle";
  $("m-running").textContent = s ? s.running : running;
  $("m-total").textContent = s ? s.total : state.services.length;
  $("m-crashed").textContent = s ? s.crashed : crashed;
  if (s) {
    $("m-uptime").textContent = formatUptime(s.uptimeSec);
    $("m-mem-services").textContent = formatMb(s.memory.servicesMb);
    $("m-mem-runner").textContent = formatMb(s.memory.runnerMb);
    $("m-mem-total").textContent = formatMb(s.memory.totalMb);
    $("m-cpu").textContent = `${s.cpuPct}%`;
    $("status-meta").textContent = `127.0.0.1:${s.port} · ${s.memory.serviceProcs} app process${s.memory.serviceProcs === 1 ? "" : "es"} · ${s.groups} group${s.groups === 1 ? "" : "s"}`;
  }
}

function render() {
  renderStats();
  const tabs = $("group-tabs");
  const items = [{ id: "all", name: "All" }, ...state.groups, { id: "ungrouped", name: "Ungrouped" }];
  tabs.innerHTML = "";
  for (const g of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab" + (state.tab === g.id ? " active" : "");
    b.textContent = g.name;
    b.addEventListener("click", () => {
      state.tab = g.id;
      render();
    });
    tabs.appendChild(b);
  }

  const list = state.services.filter((s) => {
    if (state.tab === "all") return true;
    if (state.tab === "ungrouped") return !s.groupId;
    return s.groupId === state.tab;
  });

  const wrap = $("services");
  wrap.innerHTML = "";
  $("empty").hidden = list.length > 0;
  for (const s of list) wrap.appendChild(card(s));

  const gsel = document.querySelector("#form-service select[name=groupId]");
  const current = gsel.value;
  gsel.innerHTML = `<option value="">— none —</option>` + state.groups.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join("");
  gsel.value = current;
}

function uniqueOrigins(urls) {
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    const n = String(u).replace(/\/$/, "");
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function card(s) {
  const el = document.createElement("article");
  el.className = "card" + (state.selected === s.id ? " selected" : "");
  el.dataset.id = s.id;
  const st = s.runtime.status;
  const urls = uniqueOrigins(s.runtime.urls || [])
    .map((u) => `<a class="url" href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, ""))}</a>`)
    .join("");
  const group = state.groups.find((g) => g.id === s.groupId);
  el.innerHTML = `
    <div class="card-top">
      <div>
        <h3>${esc(s.name)}</h3>
        <p class="muted">${esc(s.id)}${group ? " · " + esc(group.name) : ""}</p>
      </div>
      <span class="badge ${esc(st)}">${esc(st)}</span>
    </div>
    <div class="path">${esc(s.cwd)}</div>
    <div class="cmd">${esc(s.command)}${s.args?.length ? " " + esc(s.args.join(" ")) : ""}</div>
    <div class="urls">${urls}</div>
    <div class="card-actions">
      <button type="button" class="btn primary" data-act="start" ${st === "running" || st === "starting" ? "disabled" : ""}>Start</button>
      <button type="button" class="btn" data-act="stop" ${st === "stopped" ? "disabled" : ""}>Stop</button>
      <button type="button" class="btn" data-act="restart">Restart</button>
      <button type="button" class="btn ghost" data-act="logs">Logs</button>
      <button type="button" class="btn ghost" data-act="edit">Edit</button>
      <button type="button" class="btn danger ghost" data-act="delete">Delete</button>
    </div>
  `;
  el.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) {
      state.selected = s.id;
      location.hash = s.id;
      render();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === "start") api(`/api/v1/services/${s.id}/start`, { method: "POST" }).catch(toast);
    if (act === "stop") api(`/api/v1/services/${s.id}/stop`, { method: "POST" }).catch(toast);
    if (act === "restart") api(`/api/v1/services/${s.id}/restart`, { method: "POST" }).catch(toast);
    if (act === "logs") openLogs(s);
    if (act === "edit") openEdit(s);
    if (act === "delete" && confirm(`Remove ${s.name} from Service Runner? The project files stay on disk.`)) {
      api(`/api/v1/services/${s.id}`, { method: "DELETE" }).then(refresh).catch(toast);
    }
  });
  return el;
}

function toast(err) {
  alert(err.message || String(err));
}

async function refresh() {
  const data = await api("/api/v1/services");
  state.services = data.services;
  state.groups = data.groups;
  render();
}

async function loadStats() {
  try {
    state.stats = await api("/api/v1/stats");
    renderStats();
  } catch {
    /* keep last snapshot */
  }
}

function openModal(id, show) {
  $(id).hidden = !show;
}

function boot() {
  setPrompt();
  $("btn-copy").addEventListener("click", async () => {
    const text = $("prompt-text").textContent;
    try {
      await navigator.clipboard.writeText(text);
      $("btn-copy").textContent = "Copied";
      setTimeout(() => {
        $("btn-copy").textContent = "Copy prompt";
      }, 1400);
    } catch {
      const r = document.createRange();
      r.selectNodeContents($("prompt-text"));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
  });

  $("btn-add").addEventListener("click", () => {
    $("form-title").textContent = "Add service";
    $("form-service").reset();
    $("form-service").dataset.mode = "create";
    field($("form-service"), "id").disabled = false;
    $("form-error").hidden = true;
    openModal("modal-bg", true);
    field($("form-service"), "name").focus();
  });
  $("btn-cancel").addEventListener("click", () => openModal("modal-bg", false));
  $("btn-group").addEventListener("click", () => {
    $("form-group").reset();
    $("group-error").hidden = true;
    openModal("group-bg", true);
  });
  $("btn-group-cancel").addEventListener("click", () => openModal("group-bg", false));
  $("btn-settings").addEventListener("click", async () => {
    const s = await api("/api/v1/settings");
    const f = $("form-settings");
    field(f, "logRetentionDays").value = s.logRetentionDays;
    field(f, "autoStartOnBoot").checked = s.autoStartOnBoot;
    field(f, "openDashboardOnLaunch").checked = s.openDashboardOnLaunch;
    openModal("settings-bg", true);
  });
  $("btn-settings-cancel").addEventListener("click", () => openModal("settings-bg", false));

  $("form-service").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    const env = envLinesToObject(field(f, "env").value);
    const body = {
      name: field(f, "name").value.trim(),
      cwd: field(f, "cwd").value.trim(),
      command: field(f, "command").value.trim(),
      venv: field(f, "venv").value.trim() || undefined,
      groupId: field(f, "groupId").value || null,
      autoStart: field(f, "autoStart").checked,
      restartOnCrash: field(f, "restartOnCrash").checked,
      args: [],
      env: Object.keys(env).length ? env : undefined,
    };
    const id = field(f, "id").value.trim();
    if (id) body.id = id;
    try {
      $("form-error").hidden = true;
      if (f.dataset.mode === "edit") {
        await api(`/api/v1/services/${f.dataset.id}`, { method: "PUT", body });
      } else if (id) {
        await api(`/api/v1/services/${id}`, { method: "PUT", body });
      } else {
        await api("/api/v1/services", { method: "POST", body });
      }
      openModal("modal-bg", false);
      await refresh();
    } catch (err) {
      $("form-error").hidden = false;
      $("form-error").textContent = err.message;
    }
  });

  $("form-group").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api("/api/v1/groups", {
        method: "POST",
        body: { name: field(f, "name").value.trim(), id: field(f, "id").value.trim() || undefined },
      });
      openModal("group-bg", false);
      await refresh();
    } catch (err) {
      $("group-error").hidden = false;
      $("group-error").textContent = err.message;
    }
  });

  $("form-settings").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target;
    await api("/api/v1/settings", {
      method: "PATCH",
      body: {
        logRetentionDays: Number(field(f, "logRetentionDays").value),
        autoStartOnBoot: field(f, "autoStartOnBoot").checked,
        openDashboardOnLaunch: field(f, "openDashboardOnLaunch").checked,
      },
    });
    const prompt = await api("/api/v1/prompt");
    SR.prompt = prompt.text;
    SR.logRetentionDays = prompt.logRetentionDays;
    setPrompt();
    openModal("settings-bg", false);
  });

  $("btn-close-drawer").addEventListener("click", () => {
    $("drawer").hidden = true;
  });
  $("btn-copy-logs").addEventListener("click", copyLogs);
  $("btn-refresh-logs").addEventListener("click", () => {
    if (state.selected) loadLogs(state.selected, $("log-date").value || undefined);
  });
  $("log-date").addEventListener("change", () => {
    if (state.selected) loadLogs(state.selected, $("log-date").value);
  });

  window.addEventListener("hashchange", () => {
    const id = location.hash.replace(/^#/, "");
    if (id) {
      const s = state.services.find((x) => x.id === id);
      if (s) openLogs(s);
    }
  });

  refresh()
    .then(() => {
      const id = location.hash.replace(/^#/, "");
      if (id) {
        const s = state.services.find((x) => x.id === id);
        if (s) openLogs(s);
      }
    })
    .catch(toast);
  loadStats();
  setInterval(loadStats, 3000);
  sseWithAuth();
}

function openEdit(s) {
  const f = $("form-service");
  f.reset();
  f.dataset.mode = "edit";
  f.dataset.id = s.id;
  $("form-title").textContent = "Edit " + s.name;
  field(f, "name").value = s.name;
  field(f, "id").value = s.id;
  field(f, "id").disabled = true;
  field(f, "cwd").value = s.cwd;
  field(f, "command").value = s.args?.length ? `${s.command} ${s.args.join(" ")}` : s.command;
  field(f, "venv").value = s.venv || "";
  field(f, "groupId").value = s.groupId || "";
  field(f, "autoStart").checked = s.autoStart;
  field(f, "restartOnCrash").checked = s.restartOnCrash;
  field(f, "env").value = envToLines(s.env);
  $("form-error").hidden = true;
  openModal("modal-bg", true);
}

async function openLogs(s) {
  state.selected = s.id;
  $("drawer").hidden = false;
  $("drawer-title").textContent = s.name;
  $("drawer-sub").textContent = s.cwd;
  await loadLogs(s.id);
  render();
}

async function loadLogs(id, date) {
  const q = date ? `?date=${encodeURIComponent(date)}` : "";
  const data = await api(`/api/v1/services/${id}/logs${q}`);
  const sel = $("log-date");
  sel.innerHTML = (data.files.length ? data.files : ["(today)"]).map((d) => `<option>${esc(d)}</option>`).join("");
  if (date) sel.value = date;
  setLogText(data.text || "");
}

function setLogText(text) {
  const view = $("log-view");
  if (!text) {
    view.dataset.empty = "1";
    view.textContent = "(no log lines yet)";
    return;
  }
  view.dataset.empty = "0";
  view.innerHTML = text.split(/\n/).map(linkifyLine).join("\n");
  view.scrollTop = view.scrollHeight;
}

function appendLogLine(line) {
  const view = $("log-view");
  if (view.dataset.empty === "1") {
    view.dataset.empty = "0";
    view.innerHTML = "";
  }
  view.insertAdjacentHTML("beforeend", linkifyLine(line) + "\n");
  view.scrollTop = view.scrollHeight;
}

const LOG_URL_RE =
  /https?:\/\/[^\s<>"'\\]+|(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s<>"'\\]*)?/gi;

function trimUrl(raw) {
  return raw.replace(/[),.;]+$/g, "");
}

function hrefFor(raw) {
  const cleaned = trimUrl(raw);
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  return "http://" + cleaned;
}

function linkifyLine(text) {
  const s = String(text);
  let out = "";
  let last = 0;
  LOG_URL_RE.lastIndex = 0;
  let m;
  while ((m = LOG_URL_RE.exec(s))) {
    out += esc(s.slice(last, m.index));
    const raw = trimUrl(m[0]);
    const href = hrefFor(raw);
    out += `<a class="log-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(raw)}</a>`;
    if (raw.length < m[0].length) out += esc(m[0].slice(raw.length));
    last = m.index + m[0].length;
  }
  out += esc(s.slice(last));
  return out;
}

async function copyLogs() {
  const view = $("log-view");
  const sel = getSelection();
  const picked =
    sel && view.contains(sel.anchorNode) && sel.toString() ? sel.toString() : view.innerText || "";
  const text = picked.replace(/^\(no log lines yet\)\s*$/, "");
  if (!text) return;
  const btn = $("btn-copy-logs");
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied";
    setTimeout(() => {
      btn.textContent = "Copy";
    }, 1400);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(view);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

function sseWithAuth() {
  fetch("/api/v1/events", { headers: { Authorization: `Bearer ${TOKEN}` } }).then(async (res) => {
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        setTimeout(sseWithAuth, 1500);
        return;
      }
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const block of parts) {
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          /* ignore */
        }
      }
    }
  }).catch(() => setTimeout(sseWithAuth, 2000));
}

function onEvent(ev) {
  if (ev.type === "hello") {
    state.services = ev.services;
    state.groups = ev.groups;
    render();
    return;
  }
  if (ev.type === "config") {
    refresh().catch(() => {});
    return;
  }
  if (ev.type === "status") {
    const s = state.services.find((x) => x.id === ev.serviceId);
    if (s) {
      s.runtime.status = ev.status;
      s.runtime.pid = ev.pid;
      render();
    } else {
      refresh().catch(() => {});
    }
  }
  if (ev.type === "urls") {
    const s = state.services.find((x) => x.id === ev.serviceId);
    if (s) {
      s.runtime.urls = ev.urls;
      render();
    }
  }
  if (ev.type === "log" && state.selected === ev.serviceId && !$("drawer").hidden) {
    appendLogLine(`${ev.ts} [${ev.stream}] ${ev.line}`);
  }
}
