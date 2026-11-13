/**
 * Workspace accept measure (?hkspMeasure=1). mode-agnostic; does not change upload.
 * Safe log only: t, method, pathWithoutQuery, whitelisted action/name.
 * Never stores body, Authorization, passwords, tokens, or full query URLs.
 * SDK callable counts and Network fetch/XHR counts are separate (never summed).
 */
(function (root) {
  "use strict";

  var ACTION_ALLOW = {
    getClubData: true,
    getEventConfig: true,
    getClubStudentAccessState: true,
    listClubDriveUploads: true,
    listClubEvaluationFolders: true,
    listActiveClubsForRegistration: true,
    getClubStudentForgotPasswordContact: true,
    prepareClubDriveUpload: true,
    completeClubDriveUpload: true,
    createClubEvaluationFolder: true
  };

  function pathOnly(url) {
    var s = String(url || "");
    try {
      if (/^https?:\/\//i.test(s)) {
        var u = new URL(s);
        return u.origin + u.pathname;
      }
    } catch (_e) {}
    var q = s.indexOf("?");
    var h = s.indexOf("#");
    var cut = s.length;
    if (q >= 0) cut = Math.min(cut, q);
    if (h >= 0) cut = Math.min(cut, h);
    return s.slice(0, cut);
  }

  function whitelistAction(raw) {
    var a = String(raw || "").trim();
    if (!a) return null;
    if (ACTION_ALLOW[a]) return a;
    return null;
  }

  function actionFromBodyString(body) {
    if (typeof body !== "string" || !body) return null;
    // Parse only to extract allowlisted action; never retain body.
    try {
      var j = JSON.parse(body);
      if (j && typeof j.action === "string") return whitelistAction(j.action);
      if (j && j.data && typeof j.data.action === "string") return whitelistAction(j.data.action);
    } catch (_e) {}
    return null;
  }

  function classifyNetwork(path, method) {
    var m = String(method || "GET").toUpperCase();
    if (m === "OPTIONS") return "preflight";
    var p = String(path || "");
    if (/hkspPublicPortal|hkspCloudAdminPortal/i.test(p)) return "portal";
    if (/cloudfunctions\.net|run\.app/i.test(p) && /\/(listClub|prepareClub|completeClub|createClub|getClub)/i.test(p)) {
      return "callable_http";
    }
    if (/cloudfunctions\.net|run\.app/i.test(p)) return "backend_http";
    if (/identitytoolkit|securetoken/i.test(p)) return "auth";
    if (/\.(js|css|png|jpg|svg|ico|woff2?)$/i.test(p)) return "static";
    if (/gstatic|fonts\.google|vercel/i.test(p)) return "static";
    return "other";
  }

  function safeNetworkEvent(url, method, action) {
    var path = pathOnly(url);
    var kind = classifyNetwork(path, method);
    return {
      source: "network",
      t: 0,
      method: String(method || "GET").toUpperCase(),
      path: path,
      action: action || null,
      kind: kind
    };
  }

  function safeSdkEvent(name) {
    return {
      source: "sdk",
      t: 0,
      method: "CALLABLE",
      path: null,
      action: whitelistAction(name),
      kind: "sdk_callable"
    };
  }

  function buildMeasure(options) {
    var opts = options || {};
    var state = {
      startedAt: Date.now(),
      network: [],
      sdk: [],
      idle: null
    };

    function stamp(ev) {
      ev.t = Date.now() - state.startedAt;
      return ev;
    }

    function pushNetwork(url, method, bodyForActionOnly) {
      var methodU = String(method || "GET").toUpperCase();
      if (methodU === "OPTIONS") {
        state.network.push(stamp(safeNetworkEvent(url, methodU, null)));
        return;
      }
      var action = actionFromBodyString(bodyForActionOnly);
      // bodyForActionOnly discarded after action extract — never stored.
      state.network.push(stamp(safeNetworkEvent(url, methodU, action)));
    }

    function pushSdk(name) {
      state.sdk.push(stamp(safeSdkEvent(name)));
    }

    function countBy(list, keyFn) {
      var out = {};
      list.forEach(function (e) {
        var k = keyFn(e);
        out[k] = (out[k] || 0) + 1;
      });
      return out;
    }

    function summary() {
      var netNoPreflight = state.network.filter(function (e) { return e.kind !== "preflight"; });
      var netBusiness = netNoPreflight.filter(function (e) {
        return e.kind === "portal" || e.kind === "callable_http" || e.kind === "backend_http";
      });
      return {
        elapsedMs: Date.now() - state.startedAt,
        network: {
          total: state.network.length,
          excludingPreflight: netNoPreflight.length,
          preflight: state.network.length - netNoPreflight.length,
          business: netBusiness.length,
          byKind: countBy(state.network, function (e) { return e.kind; }),
          events: state.network.slice()
        },
        sdk: {
          total: state.sdk.length,
          byAction: countBy(state.sdk, function (e) { return e.action || "unknown"; }),
          events: state.sdk.slice()
        },
        note: "network and sdk counted separately — do not add. No bodies/tokens/query strings stored."
      };
    }

    function startIdle(ms) {
      state.idle = {
        startAt: Date.now(),
        windowMs: ms || 600000,
        networkMark: state.network.length,
        sdkMark: state.sdk.length
      };
      return { windowMs: state.idle.windowMs };
    }

    function idleReport() {
      if (!state.idle) return null;
      var net = state.network.slice(state.idle.networkMark).filter(function (e) {
        return e.kind !== "preflight";
      });
      var sdk = state.sdk.slice(state.idle.sdkMark);
      var netBiz = net.filter(function (e) {
        return e.kind === "portal" || e.kind === "callable_http" || e.kind === "backend_http";
      });
      return {
        windowMs: state.idle.windowMs,
        elapsedMs: Date.now() - state.idle.startAt,
        networkBusiness: netBiz.length,
        networkEvents: netBiz,
        sdkTotal: sdk.length,
        sdkEvents: sdk,
        note: "Idle on workspace tab. network vs sdk separate."
      };
    }

    return {
      pushNetwork: pushNetwork,
      pushSdk: pushSdk,
      summary: summary,
      startIdle: startIdle,
      idleReport: idleReport,
      reset: function () {
        state.network = [];
        state.sdk = [];
        state.startedAt = Date.now();
        state.idle = null;
      },
      _state: state
    };
  }

  function installBrowserHooks(api) {
    if (typeof root.fetch === "function" && !root.fetch.__hkspMeasureSafe) {
      var origFetch = root.fetch.bind(root);
      root.fetch = function (input, init) {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        var method = (init && init.method) || (input && input.method) || "GET";
        var bodyStr = null;
        try {
          if (init && typeof init.body === "string") bodyStr = init.body;
        } catch (_e) {}
        api.pushNetwork(url, method, bodyStr);
        bodyStr = null;
        return origFetch(input, init);
      };
      root.fetch.__hkspMeasureSafe = true;
    }

    if (root.XMLHttpRequest && !XMLHttpRequest.prototype.__hkspMeasureSafe) {
      var open = XMLHttpRequest.prototype.open;
      var send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__hkspSafe = { method: method, url: url };
        return open.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (body) {
        var m = this.__hkspSafe || {};
        var bodyStr = typeof body === "string" ? body : null;
        api.pushNetwork(m.url, m.method, bodyStr);
        bodyStr = null;
        return send.apply(this, arguments);
      };
      XMLHttpRequest.prototype.__hkspMeasureSafe = true;
    }

    function patchCallable() {
      try {
        if (!root.firebase || !firebase.app) return false;
        var fns = firebase.app().functions("asia-east1");
        if (!fns || fns.__hkspMeasureSafe) return !!fns;
        var orig = fns.httpsCallable.bind(fns);
        fns.httpsCallable = function (name) {
          var fn = orig(name);
          return function (data) {
            api.pushSdk(name);
            return fn(data);
          };
        };
        fns.__hkspMeasureSafe = true;
        return true;
      } catch (_e) {
        return false;
      }
    }
    if (!patchCallable()) {
      var n = 0;
      var timer = setInterval(function () {
        n += 1;
        if (patchCallable() || n > 40) clearInterval(timer);
      }, 250);
    }
  }

  var apiExports = {
    ACTION_ALLOW: ACTION_ALLOW,
    pathOnly: pathOnly,
    whitelistAction: whitelistAction,
    actionFromBodyString: actionFromBodyString,
    classifyNetwork: classifyNetwork,
    safeNetworkEvent: safeNetworkEvent,
    safeSdkEvent: safeSdkEvent,
    buildMeasure: buildMeasure
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = apiExports;
  }

  var q = typeof location !== "undefined" ? String(location.search || "") : "";
  if (typeof location !== "undefined" && q.indexOf("hkspMeasure=1") >= 0) {
    var runtime = buildMeasure();
    installBrowserHooks(runtime);
    root.__HKSP_MEASURE = {
      summary: runtime.summary,
      startIdle: runtime.startIdle,
      idleReport: runtime.idleReport,
      reset: runtime.reset,
      // No events() dumping raw — use summary() only.
      version: "safe-1"
    };
    try {
      console.info("[HKSP measure safe-1] network/sdk separate; no bodies stored");
    } catch (_e) {}
  }

  root.HKSP_ACCEPT_MEASURE = apiExports;
})(typeof window !== "undefined" ? window : globalThis);
