"use strict";

(function (root) {
  var inFlightReads = new Map();
  var adminReadEpoch = 0;

  function invalidateAdminReads() {
    adminReadEpoch += 1;
    inFlightReads.clear();
  }
  var READ_ACTIONS = new Set([
    "getClubData", "getEventConfig", "adminListClubs", "adminListCloudLinks",
    "adminListClubCloudRows", "adminGetCloudUploadSettings", "adminReadActivityHandover",
    "adminListFormSubmissions", "adminGetFormSyncStamp", "adminCheckFormSubmissions"
  ]);

  function endpoint(admin) {
    var client = root.HKSP_FIREBASE_CLIENT;
    if (!client || !client.config || !client.config.projectId) {
      throw new Error("Firebase 雲端入口尚未載入，請重新整理。");
    }
    var name = admin ? "hkspCloudAdminPortal" : "hkspPublicPortal";
    if (client.isEmulatorPage()) {
      return "http://127.0.0.1:5001/" + client.config.projectId + "/asia-east1/" + name;
    }
    return "https://asia-east1-" + client.config.projectId + ".cloudfunctions.net/" + name;
  }

  async function send(admin, payload) {
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 45000);
    try {
      var response = await root.fetch(endpoint(admin), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: controller.signal, credentials: "omit", cache: "no-store"
      });
      var data;
      try { data = await response.json(); }
      catch (_) { throw new Error("Firebase 雲端服務回應格式錯誤，請稍後重試。"); }
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Firebase 雲端服務回應格式錯誤，請稍後重試。");
      }
      if (!response.ok && data.success !== false) throw new Error("Firebase 雲端服務暫時無法完成操作。");
      return data;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("操作回應逾時。寫入結果可能尚未確認，請先重新讀取再操作。");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function call(admin, payload) {
    if (!READ_ACTIONS.has(payload.action)) {
      if (admin) invalidateAdminReads();
      return send(admin, payload).finally(function () {
        if (admin) invalidateAdminReads();
      });
    }
    var key = JSON.stringify([admin, payload]);
    if (inFlightReads.has(key)) return inFlightReads.get(key);
    var epoch = adminReadEpoch;
    var promise = send(admin, payload).then(function (data) {
      if (admin && epoch !== adminReadEpoch) {
        return { success: false, error: "RESPONSE_STALE", message: "設定已變更，請重新讀取。" };
      }
      return data;
    }).finally(function () {
      if (inFlightReads.get(key) === promise) inFlightReads.delete(key);
    });
    inFlightReads.set(key, promise);
    return promise;
  }

  root.HKSP_CLOUD_API = {
    publicRequest: function (payload) { return call(false, payload); },
    adminRequest: function (payload) { return call(true, payload); }
  };
})(typeof window !== "undefined" ? window : globalThis);
