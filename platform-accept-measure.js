/**
 * Workspace-only accept measure (?hkspMeasure=1 on index.html).
 * Classifies callable / portal / static / preflight. No passwords, no token export.
 * Does not alter upload behavior or mode.
 */
(function (root) {
  "use strict";
  var q = typeof location !== "undefined" ? String(location.search || "") : "";
  if (q.indexOf("hkspMeasure=1") < 0) return;

  var state = {
    startedAt: Date.now(),
    events: [],
    idle: null
  };

  function classify(url, method, bodyHint) {
    var u = String(url || "");
    var hint = String(bodyHint || "");
    if (/cloudfunctions\.net|cloudfunctions\.googleapis|run\.app/i.test(u)) {
      if (/hkspPublicPortal|hkspCloudAdminPortal/i.test(u) || /portal/i.test(hint)) {
        return "portal";
      }
      return "callable";
    }
    if (/identitytoolkit|securetoken|googleapis\.com\/identity/i.test(u)) return "auth";
    if (/firestore\.googleapis|firebaselogging|firebaseio|firebasestorage/i.test(u)) {
      return "firebase_other";
    }
    if (method === "OPTIONS") return "preflight";
    if (/\.(js|css|png|jpg|svg|ico|woff2?)(\?|$)/i.test(u)) return "static";
    if (/vercel|gstatic|fonts\.google/i.test(u)) return "static";
    return "other";
  }

  function push(kind, url, method, detail) {
    state.events.push({
      t: Date.now() - state.startedAt,
      kind: kind,
      method: method || "",
      url: String(url || "").slice(0, 220),
      detail: detail || null
    });
  }

  function wrapFetch() {
    if (typeof root.fetch !== "function" || root.fetch.__hkspMeasure) return;
    var orig = root.fetch.bind(root);
    function wrapped(input, init) {
      var url = typeof input === "string" ? input : (input && input.url) || "";
      var method = (init && init.method) || (input && input.method) || "GET";
      var bodyHint = "";
      try {
        if (init && typeof init.body === "string") bodyHint = init.body.slice(0, 120);
      } catch (_e) {}
      push(classify(url, method, bodyHint), url, method, bodyHint || null);
      return orig(input, init);
    }
    wrapped.__hkspMeasure = true;
    root.fetch = wrapped;
  }

  function wrapXhr() {
    if (!root.XMLHttpRequest || XMLHttpRequest.prototype.__hkspMeasure) return;
    var open = XMLHttpRequest.prototype.open;
    var send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__hkspM = { method: method, url: url };
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var m = this.__hkspM || {};
      push(classify(m.url, m.method, ""), m.url, m.method, null);
      return send.apply(this, arguments);
    };
    XMLHttpRequest.prototype.__hkspMeasure = true;
  }

  function wrapCallable() {
    function patch() {
      try {
        if (!root.firebase || !firebase.app) return false;
        var fns = firebase.app().functions("asia-east1");
        if (!fns || fns.__hkspMeasure) return !!fns;
        var orig = fns.httpsCallable.bind(fns);
        fns.httpsCallable = function (name) {
          var fn = orig(name);
          return function (data) {
            push("callable", name, "CALLABLE", null);
            return fn(data);
          };
        };
        fns.__hkspMeasure = true;
        return true;
      } catch (_e) {
        return false;
      }
    }
    if (!patch()) {
      var n = 0;
      var timer = setInterval(function () {
        n += 1;
        if (patch() || n > 40) clearInterval(timer);
      }, 250);
    }
  }

  function summary() {
    var counts = {};
    state.events.forEach(function (e) {
      counts[e.kind] = (counts[e.kind] || 0) + 1;
    });
    var business = state.events.filter(function (e) {
      return e.kind === "callable" || e.kind === "portal";
    });
    return {
      elapsedMs: Date.now() - state.startedAt,
      counts: counts,
      businessCount: business.length,
      business: business.slice(),
      allCount: state.events.length,
      note: "Workspace Network measure. static/preflight excluded from businessCount. Firestore docs: separate measured vs estimate."
    };
  }

  function startIdle(ms) {
    var windowMs = ms || 600000;
    state.idle = {
      startAt: Date.now(),
      windowMs: windowMs,
      markIndex: state.events.length
    };
    return state.idle;
  }

  function idleReport() {
    if (!state.idle) return null;
    var slice = state.events.slice(state.idle.markIndex);
    var business = slice.filter(function (e) {
      return e.kind === "callable" || e.kind === "portal";
    });
    return {
      windowMs: state.idle.windowMs,
      elapsedMs: Date.now() - state.idle.startAt,
      businessCount: business.length,
      business: business,
      staticOrOther: slice.length - business.length,
      note: "Idle window on index.html workspace tab only."
    };
  }

  wrapFetch();
  wrapXhr();
  wrapCallable();

  root.__HKSP_MEASURE = {
    summary: summary,
    startIdle: startIdle,
    idleReport: idleReport,
    events: function () { return state.events.slice(); },
    reset: function () {
      state.events = [];
      state.startedAt = Date.now();
      state.idle = null;
    }
  };

  try {
    console.info("[HKSP measure] active on workspace. Use __HKSP_MEASURE.summary()");
  } catch (_e) {}
})(typeof window !== "undefined" ? window : globalThis);
