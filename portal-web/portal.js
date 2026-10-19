/* Portal home — tiny, no framework, CSP-safe (no inline styles/scripts, no eval). */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var API = "/_portal/api/";
  var apps = [];
  var pollTimer = 0;
  var clockTimer = 0;

  function show(id) {
    $("boot").hidden = true;
    $("login").hidden = id !== "login";
    $("home").hidden = id !== "home";
  }

  function req(path, opts) {
    opts = opts || {};
    return fetch(API + path, {
      method: opts.method || "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: opts.body ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { status: res.status, ok: res.ok, data: data };
      });
    });
  }

  /* ---------- device name ---------- */
  function deviceName() {
    var ua = navigator.userAgent || "";
    var b = "Browser";
    if (/Edg(A|iOS)?\//.test(ua)) b = "Edge";
    else if (/OPR\/|Opera/.test(ua)) b = "Opera";
    else if (/SamsungBrowser/.test(ua)) b = "Samsung Internet";
    else if (/Firefox\/|FxiOS/.test(ua)) b = "Firefox";
    else if (/CriOS|Chrome\//.test(ua)) b = "Chrome";
    else if (/Safari\//.test(ua)) b = "Safari";
    var os = "";
    if (/iPhone/.test(ua)) os = "iPhone";
    else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) os = "iPad";
    else if (/Android/.test(ua)) os = "Android";
    else if (/Windows/.test(ua)) os = "Windows";
    else if (/CrOS/.test(ua)) os = "ChromeOS";
    else if (/Mac OS X|Macintosh/.test(ua)) os = "Mac";
    else if (/Linux/.test(ua)) os = "Linux";
    return os ? b + " on " + os : b;
  }

  /* ---------- next= handling ---------- */
  function safeNext() {
    var n;
    try { n = new URLSearchParams(location.search).get("next"); } catch (e) { return ""; }
    if (!n || n.charAt(0) !== "/" || n.charAt(1) === "/" || n.charAt(1) === "\\") return "";
    if (/[\u0000-\u001f\\]/.test(n)) return "";
    try {
      var u = new URL(n, location.origin);
      if (u.origin !== location.origin) return "";
      if (u.pathname.indexOf("/_portal/api") === 0) return "";
      return u.pathname + u.search + u.hash;
    } catch (e) {
      return "";
    }
  }

  /* ---------- login ---------- */
  function setErr(msg) {
    var el = $("login-err");
    el.textContent = msg || "";
    el.hidden = !msg;
    $("token").setAttribute("aria-invalid", msg ? "true" : "false");
  }

  function minutes(sec) {
    var m = Math.ceil((Number(sec) || 60) / 60);
    return m <= 1 ? "a minute" : m + " minutes";
  }

  function onLogin(e) {
    e.preventDefault();
    var token = $("token").value.trim();
    if (!token) {
      setErr("Paste your access token to continue.");
      $("token").focus();
      return;
    }
    var btn = $("login-btn");
    btn.disabled = true;
    btn.classList.add("busy");
    setErr("");
    req("login", { method: "POST", body: { token: token, deviceName: $("device").value.trim() || deviceName() } })
      .then(function (r) {
        if (r.ok) {
          $("token").value = "";
          var next = safeNext();
          if (next) {
            location.replace(next);
            return;
          }
          if (location.search) history.replaceState(null, "", "/");
          return enterHome({ deviceName: $("device").value.trim() || deviceName() });
        }
        if (r.status === 429) {
          setErr("Too many attempts. Try again in " + minutes(r.data.retryAfterSec) + ".");
        } else if (r.status === 401 || r.status === 403) {
          setErr("That token didn't work. Check it and try again.");
          $("token").select();
        } else {
          setErr((r.data && r.data.error) || "Something went wrong. Please try again.");
        }
      })
      .catch(function () {
        setErr("Can't reach the server. Check your connection and try again.");
      })
      .then(function () {
        btn.disabled = false;
        btn.classList.remove("busy");
      });
  }

  function showLogin() {
    stopTimers();
    show("login");
    if (!$("device").value) $("device").value = deviceName();
    document.title = "Sign in";
    setTimeout(function () { $("token").focus(); }, 30);
  }

  /* ---------- home ---------- */
  function greet() {
    var d = new Date();
    var h = d.getHours();
    var g = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : h < 22 ? "Good evening" : "Good night";
    $("greeting").textContent = g;
    var when = "";
    try {
      when = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) +
        " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      when = d.toDateString();
    }
    $("when").textContent = when;
  }

  var PALETTE = ["#7c9cff", "#3ee6a2", "#f6b04d", "#ff7a90", "#b69cff", "#4cc9f0", "#f08a5d"];
  function colorFor(a) {
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(a.color || "")) return a.color;
    var h = 0;
    var s = a.name || a.id || "";
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }

  function iconEl(a) {
    var span = document.createElement("span");
    span.className = "ico";
    var v = (a.icon || "").trim();
    if (v && /^(https?:\/\/|\/)/i.test(v)) {
      var img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.src = v;
      img.onerror = function () {
        span.textContent = (a.name || "?").charAt(0).toUpperCase();
        span.classList.add("letter");
      };
      span.appendChild(img);
    } else if (v) {
      span.textContent = v;
    } else {
      span.textContent = (a.name || "?").trim().charAt(0).toUpperCase();
      span.classList.add("letter");
    }
    return span;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderTiles() {
    var ul = $("tiles");
    ul.textContent = "";
    $("empty").hidden = apps.length > 0;
    apps.forEach(function (a, i) {
      var li = el("li");
      var link = el("a", "tile" + (a.status === "up" ? "" : " down"));
      link.href = a.path;
      link.target = "_blank";
      link.rel = "noopener";
      link.style.setProperty("--c", colorFor(a));
      link.style.setProperty("--i", String(Math.min(i, 12)));
      link.setAttribute("aria-label", a.name + (a.status === "up" ? "" : " (offline)") + " — opens in a new tab");

      var top = el("span", "tile-top");
      top.appendChild(iconEl(a));
      var arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      arrow.setAttribute("viewBox", "0 0 24 24");
      arrow.setAttribute("class", "go-arrow");
      arrow.setAttribute("aria-hidden", "true");
      var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
      p.setAttribute("d", "M8 16 16 8M9.5 8H16v6.5");
      arrow.appendChild(p);
      top.appendChild(arrow);
      link.appendChild(top);

      link.appendChild(el("span", "name", a.name));
      if (a.description) link.appendChild(el("span", "desc", a.description));
      var st = el("span", "state");
      st.appendChild(el("i"));
      st.appendChild(document.createTextNode(a.status === "up" ? "Online" : "Offline"));
      link.appendChild(st);

      li.appendChild(link);
      ul.appendChild(li);
    });
  }

  function loadApps(first) {
    return req("apps").then(function (r) {
      if (r.status === 401) {
        showLogin();
        return;
      }
      if (!r.ok) {
        if (first) {
          $("home-err").textContent = "Couldn't load your apps. Pull to refresh or try again shortly.";
          $("home-err").hidden = false;
        }
        return;
      }
      $("home-err").hidden = true;
      var title = (r.data.title || "").trim() || "Apps";
      $("title").textContent = title;
      document.title = title;
      apps = Array.isArray(r.data.apps) ? r.data.apps : [];
      var up = apps.filter(function (a) { return a.status === "up"; }).length;
      $("summary").textContent = apps.length
        ? (up === apps.length ? (apps.length === 1 ? "Your app is online." : "All " + apps.length + " apps are online.") : up + " of " + apps.length + " apps online.")
        : "";
      renderTiles();
    }).catch(function () {
      if (first) {
        $("home-err").textContent = "Can't reach the server right now.";
        $("home-err").hidden = false;
      }
    });
  }

  function stopTimers() {
    clearInterval(pollTimer);
    clearInterval(clockTimer);
    pollTimer = clockTimer = 0;
  }

  function enterHome(session) {
    show("home");
    greet();
    if (session && session.deviceName) $("foot").textContent = "Signed in as " + session.deviceName;
    stopTimers();
    clockTimer = setInterval(greet, 30000);
    pollTimer = setInterval(function () {
      if (!document.hidden) loadApps(false);
    }, 30000);
    return loadApps(true);
  }

  function signOut() {
    var b = $("signout");
    b.disabled = true;
    req("logout", { method: "POST" })
      .catch(function () {})
      .then(function () {
        b.disabled = false;
        apps = [];
        $("tiles").textContent = "";
        $("foot").textContent = "";
        showLogin();
      });
  }

  /* ---------- boot ---------- */
  function init() {
    $("login-form").addEventListener("submit", onLogin);
    $("signout").addEventListener("click", signOut);
    $("token").addEventListener("input", function () { if (!$("login-err").hidden) setErr(""); });
    $("reveal").addEventListener("click", function () {
      var t = $("token");
      var on = t.type === "password";
      t.type = on ? "text" : "password";
      this.setAttribute("aria-pressed", String(on));
      this.setAttribute("aria-label", on ? "Hide token" : "Show token");
      t.focus();
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && !$("home").hidden) {
        greet();
        loadApps(false);
      }
    });

    // Only show the spinner if the check is slow, so fast loads don't flash.
    var slow = setTimeout(function () { $("boot").classList.add("show"); }, 250);
    req("me")
      .then(function (r) {
        clearTimeout(slow);
        if (r.ok && r.data && r.data.ok) return enterHome(r.data.session);
        showLogin();
      })
      .catch(function () {
        clearTimeout(slow);
        showLogin();
        setErr("Can't reach the server. Check your connection and try again.");
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
