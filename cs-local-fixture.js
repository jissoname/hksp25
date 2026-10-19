/**
 * Local / Emulator CS fixture: never call production Apps Script from localhost.
 */
(function (root) {
  "use strict";

  function isLocalPreview() {
    if (typeof location === "undefined") return false;
    var host = location.hostname || "";
    var q = location.search || "";
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      q.indexOf("emulator=1") >= 0 ||
      q.indexOf("cs_fixture=1") >= 0
    );
  }

  var EVENT_CONFIG = {
    timezone: "Asia/Taipei",
    dataDeadline: "2026-11-19T23:59:00+08:00",
    formDeadline: "2026-12-07T23:59:00+08:00",
    eventStart: "2026-12-10T10:30:00+08:00",
    eventEnd: "2026-12-10T17:30:00+08:00"
  };

  function buildResponse(payload) {
    var action = payload && payload.action ? String(payload.action) : "";
    if (action === "getEventConfig") {
      return {
        success: true,
        config: EVENT_CONFIG,
        serverNow: new Date().toISOString(),
        mode: "local-fixture"
      };
    }
    if (action === "getMyCloudLink" || action === "bindClub" || action === "getMyBinding") {
      return {
        success: false,
        code: "LINE_BINDING_RETIRED",
        message:
          "本頁已停用 LINE 社團綁定／雲端入口。請改用首頁學生帳號登入；歷史綁定資料仍保留。",
        mode: "local-fixture"
      };
    }
    return {
      success: true,
      mode: "local-fixture",
      note: "本機／Emulator 使用本地 fixture，不連正式 Apps Script。"
    };
  }

  async function fixtureFetch(url, options) {
    void url;
    var payload = {};
    try {
      payload = JSON.parse((options && options.body) || "{}");
    } catch (_e) {
      payload = {};
    }
    await new Promise(function (r) {
      setTimeout(r, 30);
    });
    var body = buildResponse(payload);
    return {
      ok: true,
      json: async function () {
        return body;
      },
      text: async function () {
        return JSON.stringify(body);
      }
    };
  }

  root.HKSP_CS_LOCAL = {
    isLocalPreview: isLocalPreview,
    fixtureFetch: fixtureFetch,
    EVENT_CONFIG: EVENT_CONFIG
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
