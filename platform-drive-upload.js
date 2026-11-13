"use strict";

/**
 * Student Drive upload surface (candidate).
 * Calls prepare/complete with uploadKind; never treats transfer 100% as complete.
 * Auth lease / binding / deadline errors surface from backend — no fake "ready to upload".
 */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  var generation = 0;
  var operationSeq = 0;
  var listRequestSeq = 0;
  var boundUid = "";
  var busy = false;
  var serverCtx = null;
  var abortController = null;
  var pendingReplace = null;
  var activeKind = "evaluation";
  var lastListData = null;
  // Before first list: allow click; prepare／complete still server-gated.
  // After list: applyWindowReadOnly may force read-only.
  var uploadWriteAllowed = true;
  var listedAtLocalMs = 0;
  var windowWatchTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function call(name, data) {
    return firebase.app().functions("asia-east1").httpsCallable(name)(data || {});
  }

  function setStatus(text, kind) {
    var el = $("driveUploadStatus");
    if (!el) return;
    el.className = "msg" + (kind ? " " + kind : "");
    el.textContent = String(text || "");
  }

  function renderList(files) {
    var list = $("driveUploadList");
    if (!list) return;
    list.replaceChildren();
    (files || []).forEach(function (file) {
      var item = document.createElement("li");
      var kindLabel =
        file.uploadKind === "feature" ? "特色" :
          file.uploadKind === "evaluation" ? "評選" : "";
      item.textContent =
        (kindLabel ? "[" + kindLabel + "] " : "") +
        (file.fileName || "") +
        " · " +
        (file.size || 0) +
        " bytes · " +
        (file.uploadedAt || "");
      list.appendChild(item);
    });
  }

  function currentUid() {
    try {
      var user = firebase.auth() && firebase.auth().currentUser;
      return user && user.uid ? String(user.uid) : "";
    } catch (error) {
      return "";
    }
  }

  function sameOp(token) {
    return !!token &&
      token.gen === generation &&
      token.op === operationSeq &&
      token.uid === boundUid;
  }

  function acceptForKind(kind) {
    return kind === "feature"
      ? ".pdf,.ppt,.pptx,.mp4,application/pdf,video/mp4"
      : ".pdf,application/pdf";
  }

  function hintForKind(kind) {
    return kind === "feature"
      ? "特色：每社一檔；PDF／PPT／PPTX ≤100 MiB，MP4 ≤300 MiB。Drive 檔名會自動加上社團全名底線前綴。"
      : "評選：僅 PDF，每檔 ≤100 MiB，可多檔。同名須確認後才取代。";
  }

  function applyKindUi(kind) {
    activeKind = kind === "feature" ? "feature" : "evaluation";
    var input = $("driveFile");
    if (input) {
      input.accept = acceptForKind(activeKind);
      input.value = "";
    }
    var hint = $("driveUploadKindHint");
    if (hint) hint.textContent = hintForKind(activeKind);
    var evalBtn = $("btnDriveKindEvaluation");
    var featureBtn = $("btnDriveKindFeature");
    if (evalBtn) evalBtn.classList.toggle("active", activeKind === "evaluation");
    if (featureBtn) featureBtn.classList.toggle("active", activeKind === "feature");
    hideReplaceConfirm();
    if (lastListData) {
      applyWindowReadOnly(lastListData.uploadWindows, lastListData.participation);
    }
  }

  function showParticipation(participation) {
    var panel = $("clubDriveUpload");
    var gate = $("driveUploadGate");
    var tools = $("driveUploadTools");
    var evalBtn = $("btnDriveKindEvaluation");
    var featureBtn = $("btnDriveKindFeature");
    if (!panel) return;
    var part = participation || {};
    var evalOk = part.evaluation === true;
    var featureOk = part.feature === true;
    if (!part.configured) {
      if (gate) {
        gate.classList.remove("hidden");
        gate.textContent = "尚未設定此社團的評選／特色參與項目，無法上傳。";
      }
      if (tools) tools.classList.add("hidden");
      return;
    }
    if (!evalOk && !featureOk) {
      if (gate) {
        gate.classList.remove("hidden");
        gate.textContent = "此社團目前未開放評選或特色上傳入口。";
      }
      if (tools) tools.classList.add("hidden");
      return;
    }
    if (gate) {
      gate.classList.add("hidden");
      gate.textContent = "";
    }
    if (tools) tools.classList.remove("hidden");
    if (evalBtn) evalBtn.classList.toggle("hidden", !evalOk);
    if (featureBtn) featureBtn.classList.toggle("hidden", !featureOk);
    if (evalOk) applyKindUi("evaluation");
    else applyKindUi("feature");
  }

  function hideReplaceConfirm() {
    pendingReplace = null;
    var box = $("driveReplaceConfirm");
    if (box) box.classList.add("hidden");
  }

  function showReplaceConfirm(payload, file, attempt) {
    pendingReplace = {
      payload: payload,
      file: file,
      attempt: attempt,
      uploadKind: activeKind
    };
    var box = $("driveReplaceConfirm");
    var detail = $("driveReplaceDetail");
    var existing = (payload && payload.existingFile) || {};
    if (detail) {
      detail.textContent =
        "原檔：" + (existing.fileName || "（未知）") +
        (existing.size != null ? "（" + existing.size + " bytes）" : "") +
        "。確認後才會以新檔取代；取消則保留舊檔。";
    }
    if (box) box.classList.remove("hidden");
    setStatus((payload && payload.message) || "請確認是否取代原檔。", "warn");
  }

  function clearSurface() {
    var input = $("driveFile");
    if (input) input.value = "";
    var list = $("driveUploadList");
    if (list) list.replaceChildren();
    setStatus("", "");
    var retry = $("btnDriveRetry");
    if (retry) retry.classList.add("hidden");
    hideReplaceConfirm();
    var ctx = $("driveUploadContext");
    if (ctx) ctx.textContent = "登入後會顯示伺服器確認的活動與社團。";
    var gate = $("driveUploadGate");
    if (gate) {
      gate.classList.add("hidden");
      gate.textContent = "";
    }
    var tools = $("driveUploadTools");
    if (tools) tools.classList.add("hidden");
  }

  function beginGeneration(uid) {
    generation += 1;
    operationSeq += 1;
    boundUid = uid || "";
    busy = false;
    serverCtx = null;
    lastListData = null;
    listedAtLocalMs = 0;
    uploadWriteAllowed = true;
    clearWindowWatch();
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    clearSurface();
    var button = $("btnDriveUpload");
    if (button) button.disabled = false;
    return { gen: generation, op: operationSeq, uid: boundUid };
  }

  function randomAttemptId() {
    var webCrypto = window.crypto;
    if (!webCrypto) return "";
    if (typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
    if (typeof webCrypto.getRandomValues !== "function") return "";
    var bytes = new Uint8Array(16);
    webCrypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    var hex = "";
    for (var i = 0; i < 16; i += 1) {
      var part = bytes[i].toString(16);
      hex += part.length === 1 ? "0" + part : part;
    }
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" +
      hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function attemptKey(file, kind) {
    return [
      "hkspDriveAttempt",
      kind || activeKind,
      serverCtx.uid,
      serverCtx.activityId,
      serverCtx.permanentClubId,
      file.name,
      file.size,
      file.lastModified
    ].join(":");
  }

  function attemptFor(file, kind) {
    var key = attemptKey(file, kind);
    var existing = "";
    try { existing = sessionStorage.getItem(key) || ""; } catch (error) { existing = ""; }
    if (existing) return existing;
    var id = randomAttemptId();
    if (!id) return "";
    try { sessionStorage.setItem(key, id); } catch (error) { return ""; }
    return id;
  }

  function clearAttempt(file, kind) {
    try { sessionStorage.removeItem(attemptKey(file, kind)); } catch (error) { /* ignore */ }
  }

  function errorInfo(error) {
    var details = error && error.details;
    return {
      code: (details && details.code) || "",
      message: (error && error.message) || "上傳失敗"
    };
  }

  function friendlyGateMessage(info) {
    var code = info.code || "";
    if (code === "DRIVE_AUTH_LEASE_EXPIRED" || /授權使用期限已到期/.test(info.message || "")) {
      return "校方授權使用期限已到期，目前無法代傳。";
    }
    if (code === "DRIVE_AUTH_LEASE_MISSING" || code === "DRIVE_WRITE_NOT_CONFIGURED") {
      return "校方 Drive 授權尚未就緒，無法上傳（不會假裝可上傳）。";
    }
    if (code === "CLOUD_NOT_CONFIGURED") {
      return "管理員尚未綁定對應雲端資料夾，無法上傳。";
    }
    if (code === "UPLOAD_WINDOW_NOT_CONFIGURED") {
      return info.message || "此項目尚未設定正式截止時間，無法上傳（以伺服器核對為準）。";
    }
    if (code === "UPLOAD_WINDOW_CLOSED") {
      return info.message || "此項目已截止，目前僅可檢視既有資料。";
    }
    if (code === "PARTICIPATION_NOT_CONFIGURED") {
      return info.message || "尚未設定此社團的評選／特色參與項目，無法上傳。";
    }
    if (code === "PARTICIPATION_NOT_ALLOWED") {
      return info.message || "此社團未開放此上傳項目。";
    }
    return (code ? code + "：" : "") + info.message;
  }

  function setUploadControlsEnabled(enabled, readOnlyReason) {
    uploadWriteAllowed = !!enabled;
    var input = $("driveFile");
    var uploadBtn = $("btnDriveUpload");
    var retry = $("btnDriveRetry");
    if (input) input.disabled = !enabled;
    if (uploadBtn) uploadBtn.disabled = !enabled;
    if (retry && !enabled) retry.classList.add("hidden");
    var gate = $("driveUploadGate");
    if (!gate) return;
    if (!enabled && readOnlyReason) {
      gate.classList.remove("hidden");
      gate.textContent = readOnlyReason;
      return;
    }
    gate.classList.add("hidden");
    gate.textContent = "";
  }

  function clearWindowWatch() {
    if (windowWatchTimer) {
      clearTimeout(windowWatchTimer);
      windowWatchTimer = null;
    }
  }

  function effectiveServerNowMs(windows) {
    var wins = windows || {};
    var base = Number(wins.serverNowMs);
    if (!Number.isFinite(base) || !listedAtLocalMs) return Date.now();
    return base + (Date.now() - listedAtLocalMs);
  }

  /** Mirror server inspect: open only while nowMs < deadlineMs (到達當下即關). */
  function evaluateWindowLocally(win, nowMs) {
    if (!win) return { open: true, code: null, message: null };
    if (win.code === "UPLOAD_WINDOW_NOT_CONFIGURED") {
      return { open: false, code: win.code, message: win.message };
    }
    var deadlineMs = win.deadlineMs != null ? Number(win.deadlineMs) : NaN;
    if (!Number.isFinite(deadlineMs) && win.deadlineAt) {
      deadlineMs = Date.parse(String(win.deadlineAt));
    }
    if (!Number.isFinite(deadlineMs)) {
      if (win.open === false) {
        return { open: false, code: win.code || "UPLOAD_WINDOW_CLOSED", message: win.message || "" };
      }
      return { open: !!win.open, code: win.code || null, message: win.message || null };
    }
    if (nowMs < deadlineMs) {
      return { open: true, code: null, message: null };
    }
    var makeupMs = win.makeupDeadlineMs != null ? Number(win.makeupDeadlineMs) : NaN;
    if (!Number.isFinite(makeupMs) && win.makeupDeadlineAt) {
      makeupMs = Date.parse(String(win.makeupDeadlineAt));
    }
    if (win.makeupEligible === true && Number.isFinite(makeupMs) && nowMs < makeupMs) {
      return { open: true, code: null, message: null };
    }
    return {
      open: false,
      code: "UPLOAD_WINDOW_CLOSED",
      message: win.message || "此項目已截止，目前僅可檢視既有資料。"
    };
  }

  function scheduleWindowWatch(windows) {
    clearWindowWatch();
    var wins = windows || {};
    var kind = activeKind === "feature" ? "feature" : "evaluation";
    var win = wins[kind];
    if (!win) return;
    var nowMs = effectiveServerNowMs(wins);
    var candidates = [];
    if (win.deadlineMs != null && Number.isFinite(Number(win.deadlineMs))) {
      candidates.push(Number(win.deadlineMs));
    }
    if (win.makeupDeadlineMs != null && Number.isFinite(Number(win.makeupDeadlineMs))) {
      candidates.push(Number(win.makeupDeadlineMs));
    }
    var next = null;
    candidates.forEach(function (ms) {
      if (ms > nowMs && (next == null || ms < next)) next = ms;
    });
    if (next == null) return;
    var delay = Math.max(0, Math.min(next - nowMs + 25, 2147483647));
    windowWatchTimer = setTimeout(function () {
      windowWatchTimer = null;
      if (!lastListData) return;
      applyWindowReadOnly(lastListData.uploadWindows, lastListData.participation);
    }, delay);
  }

  function applyWindowReadOnly(windows, participation) {
    var part = participation || {};
    var wins = windows || {};
    var kind = activeKind === "feature" ? "feature" : "evaluation";
    var allowed = kind === "feature" ? part.feature === true : part.evaluation === true;
    if (!part.configured) {
      clearWindowWatch();
      setUploadControlsEnabled(false, "尚未設定此社團的評選／特色參與項目，無法上傳。");
      return;
    }
    if (!allowed) {
      clearWindowWatch();
      setUploadControlsEnabled(false, "此社團未開放目前選取的上傳項目。");
      return;
    }
    var win = wins[kind] || null;
    if (!win) {
      clearWindowWatch();
      setUploadControlsEnabled(true, "");
      return;
    }
    var local = evaluateWindowLocally(win, effectiveServerNowMs(wins));
    if (local.open) {
      setUploadControlsEnabled(true, "");
      scheduleWindowWatch(wins);
      return;
    }
    clearWindowWatch();
    setUploadControlsEnabled(
      false,
      friendlyGateMessage({ code: local.code || "UPLOAD_WINDOW_CLOSED", message: local.message || "" })
    );
  }

  function showContext(data) {
    var ctx = $("driveUploadContext");
    if (!ctx || !data) return;
    ctx.textContent =
      "活動：" + (data.activityId || "") +
      "　社團：" + (data.clubName || "") +
      "（" + (data.permanentClubId || "") + "）";
  }

  function refresh(token) {
    var mine = ++listRequestSeq;
    return call("listClubDriveUploads", {}).then(function (result) {
      if (!sameOp(token) || mine !== listRequestSeq) return null;
      var data = result.data || {};
      serverCtx = {
        generation: token.gen,
        uid: token.uid,
        activityId: data.activityId || "",
        permanentClubId: data.permanentClubId || "",
        clubName: data.clubName || ""
      };
      lastListData = data;
      listedAtLocalMs = Date.now();
      showContext(data);
      showParticipation(data.participation);
      renderList(data.files || []);
      applyWindowReadOnly(data.uploadWindows, data.participation);
      return data;
    }).catch(function (error) {
      if (!sameOp(token) || mine !== listRequestSeq) return null;
      var info = errorInfo(error);
      setStatus(friendlyGateMessage(info), "error");
      return null;
    });
  }

  function receivedBytes(response, size) {
    var range = response.headers && response.headers.get ? (response.headers.get("Range") || "") : "";
    var match = /bytes=0-(\d+)/i.exec(range);
    if (!match) return 0;
    var next = Number(match[1]) + 1;
    if (!isFinite(next) || next < 0) return 0;
    return next > size ? size : next;
  }

  function transfer(url, file, signal) {
    return fetch(url, {
      method: "PUT",
      headers: { "Content-Range": "bytes */" + file.size },
      body: new Blob([]),
      signal: signal
    }).then(function (probe) {
      if (probe.status === 200 || probe.status === 201) return "bytes_acked";
      if (probe.status === 404 || probe.status === 410) return "expired";
      if (probe.status !== 308) {
        throw new Error("檔案沒有完整送到資料夾（HTTP " + probe.status + "）。請用同一個上傳識別重試。");
      }
      var start = receivedBytes(probe, file.size);
      if (start >= file.size) return "bytes_acked";
      return fetch(url, {
        method: "PUT",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "Content-Range": "bytes " + start + "-" + (file.size - 1) + "/" + file.size
        },
        body: start > 0 ? file.slice(start) : file,
        signal: signal
      }).then(function (response) {
        if (response.status === 200 || response.status === 201) return "bytes_acked";
        if (response.status === 308) {
          throw new Error("檔案尚未完整送到資料夾。請用同一個上傳識別續傳。");
        }
        throw new Error("檔案沒有完整送到資料夾（HTTP " + response.status + "）。請用同一個上傳識別重試。");
      });
    });
  }

  function finishUpload(token, file, kind, done) {
    if (!sameOp(token) || !done) return;
    listRequestSeq += 1;
    renderList((done.data && done.data.files) || done.files || []);
    setStatus(
      done.alreadyComplete
        ? "這次上傳已經完成，沒有再新增檔案。"
        : "已由伺服器確認完成並寫入紀錄（傳輸進度 100% 不算完成）。",
      "ok"
    );
    var retry = $("btnDriveRetry");
    if (retry) retry.classList.add("hidden");
    hideReplaceConfirm();
    clearAttempt(file, kind);
  }

  function preparePayload(file, attempt, confirmReplace) {
    return {
      uploadKind: activeKind,
      fileName: file.name,
      size: file.size,
      mimeType: file.type || "",
      clientAttemptId: attempt,
      confirmReplace: !!confirmReplace
    };
  }

  function prepareAndSend(token, file, attempt, signal, allowRebuild, confirmReplace) {
    if (!sameOp(token)) return Promise.resolve(null);
    var kind = activeKind;
    return call("prepareClubDriveUpload", preparePayload(file, attempt, confirmReplace)).then(function (prepared) {
      if (!sameOp(token)) return null;
      var data = prepared.data || {};
      if (data.status === "replace_confirm_required") {
        showReplaceConfirm(data, file, attempt);
        return { waitingReplaceConfirm: true };
      }
      if (data.alreadyComplete) return { data: data, alreadyComplete: true };
      if (data.status === "remote_complete") {
        return call("completeClubDriveUpload", { clientAttemptId: attempt });
      }
      if (!data.uploadUrl) throw new Error("伺服器沒有提供上傳位址。");
      setStatus(
        "正在把檔案直接送到社團資料夾…" +
          (data.fileName ? "（Drive 檔名：" + data.fileName + "）" : ""),
        "warn"
      );
      return transfer(data.uploadUrl, file, signal).then(function (outcome) {
        if (!sameOp(token)) return null;
        if (outcome === "expired") {
          if (!allowRebuild) throw new Error("上傳工作階段已逾期。請再用同一個識別重試。");
          return prepareAndSend(token, file, attempt, signal, false, true);
        }
        // Bytes may be on Drive; completion is only after completeClubDriveUpload succeeds.
        setStatus("檔案位元組已送達，正在向伺服器確認完成（尚未宣告成功）…", "warn");
        return call("completeClubDriveUpload", { clientAttemptId: attempt });
      });
    });
  }

  function runUpload(confirmReplace) {
    var token = { gen: generation, op: operationSeq, uid: boundUid };
    if (busy) return;
    if (!uploadWriteAllowed) {
      setStatus("目前為唯讀狀態，無法上傳（截止與資格以伺服器核對為準）。", "warn");
      return;
    }
    if (!serverCtx || serverCtx.generation !== token.gen || serverCtx.uid !== token.uid ||
      !serverCtx.activityId || !serverCtx.permanentClubId) {
      setStatus("尚未取得伺服器確認的活動與社團。", "warn");
      return;
    }
    var input = $("driveFile");
    var file = (pendingReplace && pendingReplace.file) ||
      (input && input.files && input.files[0]);
    if (!file) {
      setStatus("請先選擇檔案。", "warn");
      return;
    }
    var kind = activeKind;
    var attempt = (pendingReplace && pendingReplace.attempt) || attemptFor(file, kind);
    if (!attempt) {
      setStatus("這個瀏覽器無法產生上傳識別，已拒絕上傳。", "error");
      return;
    }
    busy = true;
    var button = $("btnDriveUpload");
    if (button) button.disabled = true;
    abortController = typeof AbortController === "function" ? new AbortController() : null;
    var signal = abortController ? abortController.signal : undefined;
    setStatus("正在向伺服器核對資格、截止與目的地…", "warn");
    prepareAndSend(token, file, attempt, signal, true, !!confirmReplace).then(function (done) {
      if (done && done.waitingReplaceConfirm) return;
      finishUpload(token, file, kind, done);
    }).catch(function (error) {
      if (!sameOp(token)) return;
      if (error && error.name === "AbortError") return;
      var info = errorInfo(error);
      setStatus(friendlyGateMessage(info), "error");
      var retry = $("btnDriveRetry");
      if (retry) retry.classList.remove("hidden");
    }).then(function () {
      if (!sameOp(token)) return;
      busy = false;
      if ($("btnDriveUpload")) $("btnDriveUpload").disabled = false;
    });
  }

  function uploadCurrent() {
    hideReplaceConfirm();
    runUpload(false);
  }

  function confirmReplaceUpload() {
    if (!pendingReplace) {
      setStatus("沒有待確認的取代。", "warn");
      return;
    }
    runUpload(true);
  }

  function cancelReplaceUpload() {
    if (pendingReplace && pendingReplace.file) {
      clearAttempt(pendingReplace.file, pendingReplace.uploadKind || activeKind);
    }
    hideReplaceConfirm();
    setStatus("已取消取代，原檔保留。", "ok");
  }

  function bind() {
    var upload = $("btnDriveUpload");
    var retry = $("btnDriveRetry");
    var evalBtn = $("btnDriveKindEvaluation");
    var featureBtn = $("btnDriveKindFeature");
    var confirmBtn = $("btnDriveReplaceConfirm");
    var cancelBtn = $("btnDriveReplaceCancel");
    if (upload && !upload.dataset.bound) {
      upload.dataset.bound = "1";
      upload.addEventListener("click", uploadCurrent);
    }
    if (retry && !retry.dataset.bound) {
      retry.dataset.bound = "1";
      retry.addEventListener("click", uploadCurrent);
    }
    if (evalBtn && !evalBtn.dataset.bound) {
      evalBtn.dataset.bound = "1";
      evalBtn.addEventListener("click", function () { applyKindUi("evaluation"); });
    }
    if (featureBtn && !featureBtn.dataset.bound) {
      featureBtn.dataset.bound = "1";
      featureBtn.addEventListener("click", function () { applyKindUi("feature"); });
    }
    if (confirmBtn && !confirmBtn.dataset.bound) {
      confirmBtn.dataset.bound = "1";
      confirmBtn.addEventListener("click", confirmReplaceUpload);
    }
    if (cancelBtn && !cancelBtn.dataset.bound) {
      cancelBtn.dataset.bound = "1";
      cancelBtn.addEventListener("click", cancelReplaceUpload);
    }
  }

  function onPageResume() {
    if (!lastListData) return;
    applyWindowReadOnly(lastListData.uploadWindows, lastListData.participation);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
  if (typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") onPageResume();
    });
  }
  if (typeof window.addEventListener === "function") {
    window.addEventListener("pageshow", onPageResume);
  }

  function accessGenerationMatches(data) {
    if (!data || data.accessAuthGeneration == null) return true;
    try {
      var authApi = window.HKSP_PLATFORM_AUTH;
      if (!authApi || typeof authApi.getAccessAuthGeneration !== "function") {
        return true;
      }
      return Number(data.accessAuthGeneration) === Number(authApi.getAccessAuthGeneration());
    } catch (error) {
      return false;
    }
  }

  function adoptConfirmedAccess(data) {
    var uid = currentUid();
    if (!uid || !data) return null;
    if (data.uid && String(data.uid) !== uid) return null;
    if (!accessGenerationMatches(data)) return null;
    var token = beginGeneration(uid);
    if (token.uid !== uid) return null;
    serverCtx = {
      generation: token.gen,
      uid: token.uid,
      activityId: data.activityId || "",
      permanentClubId: data.permanentClubId || "",
      clubName: data.clubName || ""
    };
    showContext(data);
    refresh(token);
    return token;
  }

  /**
   * Auth may finish getClubStudentAccessState before this module loads.
   * Pull server-confirmed snapshot only — never open on Firebase login alone.
   */
  function syncFromPlatformAuth() {
    try {
      var authApi = window.HKSP_PLATFORM_AUTH;
      if (!authApi || typeof authApi.getConfirmedDriveAccess !== "function") {
        return null;
      }
      var snap = authApi.getConfirmedDriveAccess();
      if (!snap) return null;
      return adoptConfirmedAccess(snap);
    } catch (error) {
      return null;
    }
  }

  function watchAuth() {
    try {
      var authObj = firebase.auth();
      if (!authObj || typeof authObj.onAuthStateChanged !== "function") return;
      authObj.onAuthStateChanged(function (user) {
        var nextUid = user && user.uid ? String(user.uid) : "";
        beginGeneration(nextUid);
        // After binding current UID, re-pull confirmed access (covers late module load).
        if (nextUid) syncFromPlatformAuth();
      });
    } catch (error) {
      /* 沒有 Auth 時不啟動上傳。 */
    }
  }

  watchAuth();

  window.HKSP_DRIVE_UPLOAD = {
    onAccess: function (data) {
      adoptConfirmedAccess(data || {});
    },
    onSignedOut: function () {
      beginGeneration("");
    },
    syncFromPlatformAuth: syncFromPlatformAuth
  };

  // If Auth already confirmed before this script ran (and Auth listener is async),
  // pull once now; watchAuth callback will also pull for the same UID.
  syncFromPlatformAuth();
})();
