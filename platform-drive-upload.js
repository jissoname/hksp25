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
  var selectedEvalFolderId = "";
  var evalFolderBusy = false;
  var uploadQueue = [];
  var workspaceView = "picker"; // picker | tools
  // Before first list: allow click; prepare／complete still server-gated.
  // After list: applyWindowReadOnly may force read-only.
  var uploadWriteAllowed = true;
  var listedAtLocalMs = 0;
  var windowWatchTimer = null;
  var listRefreshInflight = null;
  var evalFoldersInflight = null;
  /** Short-lived folder list cache (uid+gen+activity+club+parent). Cleared on logout/gen. */
  var evalFoldersCache = null;
  var EVAL_FOLDERS_TTL_MS = 60 * 1000;

  function $(id) {
    return document.getElementById(id);
  }

  var TRANSIENT_RETRY_MAX = 2;
  var TRANSIENT_RETRY_BASE_MS = 400;
  var WRITE_CALLS = {
    prepareClubDriveUpload: true,
    completeClubDriveUpload: true,
    createClubEvaluationFolder: true
  };

  function errorCode(error) {
    return String(
      (error && (error.code || (error.details && error.details.code))) || ""
    ).toLowerCase();
  }

  function isPermissionOrAuthError(error) {
    var code = errorCode(error);
    var msg = String((error && error.message) || "");
    return /unauthenticated|permission-denied|auth|forbidden|not.?allowed|未登入|權限|資格|mode.?off|尚未開放/i.test(
      code + " " + msg
    );
  }

  function isTransientError(error) {
    if (isPermissionOrAuthError(error)) return false;
    var code = errorCode(error);
    var msg = String((error && error.message) || "");
    return /unavailable|deadline-exceeded|resource-exhausted|internal|failed.?to.?fetch|network|timeout|逾時|暫時/i.test(
      code + " " + msg
    );
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function callOnce(name, data) {
    return firebase.app().functions("asia-east1").httpsCallable(name)(data || {});
  }

  /** Reads: limited backoff. Writes: never auto-retry (permission / unclear outcome). */
  function call(name, data) {
    if (WRITE_CALLS[name]) return callOnce(name, data);
    var attempt = 0;
    function run() {
      return callOnce(name, data).catch(function (error) {
        if (attempt >= TRANSIENT_RETRY_MAX || !isTransientError(error)) throw error;
        attempt += 1;
        return sleep(TRANSIENT_RETRY_BASE_MS * attempt).then(run);
      });
    }
    return run();
  }

  function setStatus(text, kind) {
    var el = $("driveUploadStatus");
    if (!el) return;
    el.className = "msg" + (kind ? " " + kind : "");
    el.textContent = String(text || "");
  }

  function formatTaipeiDateTime(value) {
    if (value == null || value === "") return "—";
    var d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    try {
      return new Intl.DateTimeFormat("zh-TW", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(d);
    } catch (error) {
      return "—";
    }
  }

  function formatBytes(size) {
    var n = Number(size);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 1024) return n + " bytes";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KiB";
    return (n / (1024 * 1024)).toFixed(1) + " MiB";
  }

  function filesForActiveKind(files) {
    var kind = activeKind === "feature" ? "feature" : "evaluation";
    return (files || []).filter(function (file) {
      // Legacy rows without uploadKind count as evaluation (not feature).
      var fileKind = String((file && file.uploadKind) || "").trim() || "evaluation";
      return fileKind === kind;
    });
  }

  function renderList(files) {
    var list = $("driveUploadList");
    var head = $("driveRecordsHead");
    if (!list) return;
    var kind = activeKind === "feature" ? "feature" : "evaluation";
    var filtered = filesForActiveKind(files);
    if (head) {
      head.textContent =
        kind === "feature" ? "已繳交紀錄（特色）" : "已繳交紀錄（評選）";
    }
    list.replaceChildren();
    if (!filtered.length) {
      var empty = document.createElement("li");
      empty.textContent = "此項目目前沒有已確認的繳交紀錄。";
      list.appendChild(empty);
      return;
    }
    filtered.forEach(function (file) {
      var item = document.createElement("li");
      var name = document.createElement("span");
      name.className = "rec-name";
      name.textContent = file.fileName || "（未命名）";
      var meta = document.createElement("span");
      meta.className = "rec-meta";
      meta.textContent =
        formatTaipeiDateTime(file.uploadedAt) +
        " · " +
        formatBytes(file.size) +
        " · 已確認";
      item.appendChild(name);
      item.appendChild(meta);
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

  function setEvalFolderStatus(text, kind) {
    var el = $("driveEvalFolderStatus");
    if (!el) return;
    el.className = "msg" + (kind ? " " + kind : "");
    el.textContent = String(text || "");
  }

  function syncEvalFolderPanel() {
    var panel = $("driveEvalFolderPanel");
    if (!panel) return;
    var show = activeKind === "evaluation" &&
      lastListData &&
      lastListData.participation &&
      lastListData.participation.evaluation === true;
    panel.classList.toggle("hidden", !show);
    panel.classList.toggle("is-readonly", !uploadWriteAllowed);
    if (!show) return;
    var createBtn = $("btnDriveEvalFolderCreate");
    var nameInput = $("driveEvalFolderName");
    var select = $("driveEvalFolderSelect");
    var refreshBtn = $("btnDriveEvalFolderRefresh");
    var canWrite = uploadWriteAllowed && !evalFolderBusy;
    if (createBtn) createBtn.disabled = !canWrite;
    if (nameInput) nameInput.disabled = !canWrite;
    if (select) select.disabled = evalFolderBusy;
    if (refreshBtn) refreshBtn.disabled = evalFolderBusy;
  }

  function renderEvalFolderOptions(payload) {
    var select = $("driveEvalFolderSelect");
    var list = $("driveEvalFolderList");
    var folders = (payload && payload.folders) || [];
    var clubFolderId = (payload && payload.clubFolderId) || "";
    var keep = selectedEvalFolderId;
    var entries = [{ id: "", name: "社團核定資料夾（根層）" }];
    folders.forEach(function (folder) {
      var id = folder && (folder.folderId || folder.id);
      if (!id) return;
      if (clubFolderId && id === clubFolderId) return;
      entries.push({ id: String(id), name: String(folder.name || id) });
    });
    var found = false;
    entries.forEach(function (entry) {
      if (entry.id === keep) found = true;
    });
    selectedEvalFolderId = found ? keep : "";
    if (select) {
      select.replaceChildren();
      entries.forEach(function (entry) {
        var opt = document.createElement("option");
        opt.value = entry.id;
        opt.textContent = entry.name;
        select.appendChild(opt);
      });
      select.value = selectedEvalFolderId;
    }
    if (list) {
      list.replaceChildren();
      entries.forEach(function (entry) {
        var li = document.createElement("li");
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = entry.name;
        btn.dataset.folderId = entry.id;
        if (entry.id === selectedEvalFolderId) btn.classList.add("active");
        btn.addEventListener("click", function () {
          selectedEvalFolderId = entry.id;
          if (select) select.value = entry.id;
          renderEvalFolderOptions({
            folders: folders,
            clubFolderId: clubFolderId
          });
        });
        li.appendChild(btn);
        list.appendChild(li);
      });
    }
    return entries.length <= 1;
  }

  function evalFoldersCacheKey(parentId) {
    if (!boundUid || !serverCtx) return "";
    return [
      String(boundUid),
      String(generation),
      String(serverCtx.activityId || ""),
      String(serverCtx.permanentClubId || ""),
      String(parentId || "")
    ].join("|");
  }

  function evalFoldersCacheValid(cache, parentId) {
    if (!cache || !boundUid || !serverCtx) return false;
    if (String(cache._cacheKey || "") !== evalFoldersCacheKey(parentId)) return false;
    if (cache._cacheAtMs == null) return false;
    if (Date.now() - Number(cache._cacheAtMs) > EVAL_FOLDERS_TTL_MS) return false;
    return true;
  }

  function stampEvalFoldersCache(data, parentId) {
    return Object.assign({}, data || {}, {
      _cacheKey: evalFoldersCacheKey(parentId),
      _cacheAtMs: Date.now(),
      _cacheParent: String(parentId || "")
    });
  }

  function rememberEvalFolders(data, parentId) {
    var stamped = stampEvalFoldersCache(data, parentId);
    evalFoldersCache = stamped;
    if (lastListData) lastListData._evalFolders = stamped;
    return stamped;
  }

  function applyEvalFoldersData(data) {
    if (!data) return null;
    if (lastListData && data.driveWriteEnabled === false) {
      lastListData.driveWriteEnabled = false;
      lastListData.driveUploadMode = data.driveUploadMode || "off";
    }
    rememberEvalFolders(data, "");
    var emptyOnlyRoot = renderEvalFolderOptions(data);
    if (data.driveWriteEnabled === false) {
      setEvalFolderStatus(
        emptyOnlyRoot ? "目前沒有子分類（根層，唯讀可瀏覽）。" : "已載入分類（唯讀可瀏覽）。",
        "ok"
      );
      setUploadControlsEnabled(false, "系統尚未開放上傳");
    } else if (emptyOnlyRoot) {
      setEvalFolderStatus("目前沒有子分類，可使用根層或建立新分類。", "ok");
    } else {
      setEvalFolderStatus("已載入分類資料夾。", "ok");
    }
    return data;
  }

  function refreshEvalFolders(token, force) {
    if (activeKind !== "evaluation") return Promise.resolve(null);
    // List is club-root categories; selectedEvalFolderId is upload target only, not list parent.
    var parentId = "";
    var cacheCandidate = evalFoldersCache || (lastListData && lastListData._evalFolders) || null;
    // Fence by login generation + club scope, not upload operationSeq
    // (kind switch bumps operationSeq and must not discard a good folder cache).
    if (!force && evalFoldersCacheValid(cacheCandidate, parentId)) {
      applyEvalFoldersData(cacheCandidate);
      return Promise.resolve(cacheCandidate);
    }
    var inflightKey = evalFoldersCacheKey(parentId);
    if (
      evalFoldersInflight &&
      !force &&
      evalFoldersInflight.key === inflightKey
    ) {
      return evalFoldersInflight.promise;
    }
    evalFolderBusy = true;
    syncEvalFolderPanel();
    setEvalFolderStatus("正在載入分類資料夾…", "warn");
    var pending = call("listClubEvaluationFolders", {}).then(function (result) {
      if (token && Number(token.gen) !== Number(generation)) return null;
      if (token && String(token.uid || "") !== String(boundUid || "")) return null;
      return applyEvalFoldersData(result.data || {});
    }).catch(function (error) {
      if (token && Number(token.gen) !== Number(generation)) return null;
      if (token && String(token.uid || "") !== String(boundUid || "")) return null;
      var info = errorInfo(error);
      var list = $("driveEvalFolderList");
      if (list) list.replaceChildren();
      setEvalFolderStatus("分類讀取失敗：" + friendlyGateMessage(info), "error");
      return null;
    }).then(function (data) {
      evalFolderBusy = false;
      syncEvalFolderPanel();
      return data;
    }).finally(function () {
      if (evalFoldersInflight && evalFoldersInflight.promise === pending) {
        evalFoldersInflight = null;
      }
    });
    evalFoldersInflight = { key: inflightKey, promise: pending };
    return pending;
  }

  function createEvalFolder() {
    var token = { gen: generation, op: operationSeq, uid: boundUid };
    if (!uploadWriteAllowed) {
      setEvalFolderStatus("目前為唯讀狀態，無法建立分類。", "warn");
      return;
    }
    var nameInput = $("driveEvalFolderName");
    var name = nameInput && nameInput.value ? String(nameInput.value).trim() : "";
    if (!name) {
      setEvalFolderStatus("請輸入分類名稱。", "warn");
      return;
    }
    var parentFolderId = selectedEvalFolderId || "";
    evalFolderBusy = true;
    syncEvalFolderPanel();
    setEvalFolderStatus("正在建立分類…", "warn");
    var body = { name: name };
    if (parentFolderId) body.parentFolderId = parentFolderId;
    call("createClubEvaluationFolder", body).then(function (result) {
      if (!sameOp(token)) return null;
      var data = result.data || {};
      if (data.folderId) selectedEvalFolderId = String(data.folderId);
      if (nameInput) nameInput.value = "";
      evalFoldersCache = null;
      if (lastListData) lastListData._evalFolders = null;
      setEvalFolderStatus(
        data.reused ? "已沿用同名分類。" : "已建立分類。",
        "ok"
      );
      return refreshEvalFolders(token, true);
    }).catch(function (error) {
      if (!sameOp(token)) return;
      var info = errorInfo(error);
      setEvalFolderStatus(friendlyGateMessage(info), "error");
      // Permission / mode-off: do not blind-retry create.
    }).then(function () {
      if (!sameOp(token)) return;
      evalFolderBusy = false;
      syncEvalFolderPanel();
    });
  }

  function setWorkspaceView(view) {
    workspaceView = view === "tools" ? "tools" : "picker";
    var picker = $("driveKindPicker");
    var tools = $("driveUploadTools");
    if (picker) picker.classList.toggle("hidden", workspaceView !== "picker");
    if (tools) tools.classList.toggle("hidden", workspaceView !== "tools");
  }

  function syncDropzoneCopy() {
    var title = $("driveDropzoneTitle");
    var sub = $("driveDropzoneSub");
    var input = $("driveFile");
    if (input) {
      input.accept = acceptForKind(activeKind);
      input.multiple = activeKind === "evaluation";
    }
    if (title) {
      title.textContent = uploadWriteAllowed
        ? "拖曳檔案到此，或點選選擇"
        : "目前為唯讀（不可選檔上傳）";
    }
    if (sub) sub.textContent = hintForKind(activeKind);
    var zone = $("driveDropzone");
    if (zone) zone.classList.toggle("disabled", !uploadWriteAllowed);
  }

  function applyKindUi(kind, enterTools) {
    activeKind = kind === "feature" ? "feature" : "evaluation";
    // Invalidate in-flight ops from the other kind; keep lastListData for local filter.
    operationSeq += 1;
    var input = $("driveFile");
    if (input) {
      input.accept = acceptForKind(activeKind);
      input.multiple = activeKind === "evaluation";
      input.value = "";
    }
    uploadQueue = [];
    renderQueue();
    var hint = $("driveUploadKindHint");
    if (hint) hint.textContent = hintForKind(activeKind);
    var panel = $("driveWsPanel");
    if (panel) panel.classList.toggle("feature-mode", activeKind === "feature");
    var evalBtn = $("btnDriveKindEvaluation");
    var featureBtn = $("btnDriveKindFeature");
    if (evalBtn) evalBtn.classList.toggle("active", activeKind === "evaluation");
    if (featureBtn) featureBtn.classList.toggle("active", activeKind === "feature");
    hideReplaceConfirm();
    if (activeKind !== "evaluation") {
      selectedEvalFolderId = "";
      setEvalFolderStatus("", "");
    }
    // Re-render records for this kind immediately from last snapshot (no network).
    if (lastListData) renderList(lastListData.files || []);
    else renderList([]);
    syncEvalFolderPanel();
    syncDropzoneCopy();
    updateWorkspaceMeta();
    if (enterTools) setWorkspaceView("tools");
    if (lastListData) {
      applyWindowReadOnly(lastListData.uploadWindows, lastListData.participation);
    }
    if (activeKind === "evaluation" && lastListData && boundUid && workspaceView === "tools") {
      // Reuse stamped folder cache; network only on miss / manual refresh / create.
      refreshEvalFolders({ gen: generation, op: operationSeq, uid: boundUid }, false);
    }
  }

  function showParticipation(participation) {
    var panel = $("driveWorkspace");
    var gate = $("driveUploadGate");
    var tools = $("driveUploadTools");
    var picker = $("driveKindPicker");
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
      if (picker) picker.classList.add("hidden");
      return;
    }
    if (!evalOk && !featureOk) {
      if (gate) {
        gate.classList.remove("hidden");
        gate.textContent = "此社團目前未開放評選或特色上傳入口。";
      }
      if (tools) tools.classList.add("hidden");
      if (picker) picker.classList.add("hidden");
      return;
    }
    if (evalBtn) evalBtn.classList.toggle("hidden", !evalOk);
    if (featureBtn) featureBtn.classList.toggle("hidden", !featureOk);
    if (evalOk && featureOk) {
      setWorkspaceView("picker");
      return;
    }
    if (evalOk) applyKindUi("evaluation", true);
    else applyKindUi("feature", true);
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
    uploadQueue = [];
    renderQueue();
    var list = $("driveUploadList");
    if (list) list.replaceChildren();
    setStatus("", "");
    setTransferProgress(null);
    var retry = $("btnDriveRetry");
    if (retry) retry.classList.add("hidden");
    hideReplaceConfirm();
    setWorkspaceView("picker");
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
    evalFoldersCache = null;
    evalFoldersInflight = null;
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
      kind === "evaluation" ? (selectedEvalFolderId || "root") : "feature",
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
    if (code === "DRIVE_UPLOAD_MODE_OFF") {
      return "系統尚未開放上傳";
    }
    if (code === "DRIVE_AUTH_LEASE_MISSING") {
      return "校方 Drive 授權尚未就緒，無法上傳（不會假裝可上傳）。";
    }
    if (code === "DRIVE_WRITE_NOT_CONFIGURED") {
      return "系統尚未開放上傳";
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
    syncEvalFolderPanel();
    syncDropzoneCopy();
    updateWorkspaceMeta();
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

  function setTransferProgress(pct) {
    var wrap = $("driveTransferProgress");
    var bar = $("driveTransferBar");
    if (!wrap || !bar) return;
    if (pct == null || !Number.isFinite(Number(pct))) {
      wrap.classList.add("hidden");
      bar.style.width = "0%";
      return;
    }
    wrap.classList.remove("hidden");
    bar.style.width = Math.max(0, Math.min(100, Number(pct))) + "%";
  }

  function renderQueue() {
    var list = $("driveUploadQueue");
    if (!list) return;
    list.replaceChildren();
    uploadQueue.forEach(function (item, index) {
      var li = document.createElement("li");
      li.className = "drive-queue-item";
      var left = document.createElement("div");
      var name = document.createElement("div");
      name.className = "q-name";
      name.textContent = item.file && item.file.name ? item.file.name : "（未命名）";
      var meta = document.createElement("div");
      meta.className = "q-meta";
      meta.textContent =
        (item.file && item.file.size != null ? item.file.size + " bytes" : "") +
        (item.state ? " · " + item.state : "");
      left.appendChild(name);
      left.appendChild(meta);
      var remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "移除";
      remove.disabled = busy || !uploadWriteAllowed;
      remove.addEventListener("click", function () {
        if (busy) return;
        uploadQueue.splice(index, 1);
        renderQueue();
      });
      li.appendChild(left);
      li.appendChild(remove);
      list.appendChild(li);
    });
  }

  function addFilesFromList(fileList) {
    if (!uploadWriteAllowed) {
      setStatus("系統尚未開放上傳", "warn");
      return;
    }
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    if (activeKind === "feature") {
      uploadQueue = [{ file: files[0], state: "等待上傳" }];
    } else {
      files.forEach(function (file) {
        if (!file) return;
        uploadQueue.push({ file: file, state: "等待上傳" });
      });
    }
    renderQueue();
    setStatus(
      activeKind === "feature"
        ? "已選取 1 個檔案，按「開始上傳」送出。"
        : "已加入 " + files.length + " 個檔案至佇列。",
      "ok"
    );
  }

  function updateWorkspaceMeta() {
    var title = $("driveWsClubTitle");
    var meta = $("driveWsMeta");
    if (!serverCtx) {
      if (title) title.textContent = "社團資料上傳";
      if (meta) meta.textContent = "登入後會顯示伺服器確認的活動、社團與截止。";
      return;
    }
    if (title) {
      title.textContent =
        (serverCtx.clubName || "社團") +
        "（" + (serverCtx.permanentClubId || "") + "）";
    }
    var wins = (lastListData && lastListData.uploadWindows) || {};
    var kind = activeKind === "feature" ? "feature" : "evaluation";
    var win = wins[kind] || null;
    var deadlineText = win && win.deadlineAt
      ? formatTaipeiDateTime(win.deadlineAt)
      : "（伺服器尚未回傳截止）";
    var kindLabel = activeKind === "feature" ? "特色" : "評選";
    if (meta) {
      meta.textContent =
        "活動：" + (serverCtx.activityId || "") +
        "　目前項目：" + kindLabel +
        "　截止：" + deadlineText;
    }
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
    if (lastListData && lastListData.driveWriteEnabled === false) {
      clearWindowWatch();
      setUploadControlsEnabled(false, "系統尚未開放上傳");
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
    if (ctx && data) {
      ctx.textContent =
        "活動：" + (data.activityId || "") +
        "　社團：" + (data.clubName || "") +
        "（" + (data.permanentClubId || "") + "）";
    }
    updateWorkspaceMeta();
  }

  function refresh(token) {
    if (
      listRefreshInflight &&
      listRefreshInflight.uid === token.uid &&
      listRefreshInflight.gen === token.gen
    ) {
      return listRefreshInflight.promise;
    }
    var mine = ++listRequestSeq;
    var prevFolders = lastListData && lastListData._evalFolders
      ? lastListData._evalFolders
      : null;
    var pending = call("listClubDriveUploads", {}).then(function (result) {
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
      if (prevFolders && evalFoldersCacheValid(prevFolders, "")) {
        lastListData._evalFolders = prevFolders;
        evalFoldersCache = prevFolders;
      } else if (evalFoldersCache && evalFoldersCacheValid(evalFoldersCache, "")) {
        lastListData._evalFolders = evalFoldersCache;
      }
      listedAtLocalMs = Date.now();
      showContext(data);
      showParticipation(data.participation);
      renderList(data.files || []);
      applyWindowReadOnly(data.uploadWindows, data.participation);
      if (activeKind === "evaluation" && workspaceView === "tools") {
        refreshEvalFolders(token, false);
      }
      return data;
    }).catch(function (error) {
      if (!sameOp(token) || mine !== listRequestSeq) return null;
      var info = errorInfo(error);
      setStatus(friendlyGateMessage(info), "error");
      // Auth / permission failures: no automatic resend.
      return null;
    }).finally(function () {
      if (listRefreshInflight && listRefreshInflight.promise === pending) {
        listRefreshInflight = null;
      }
    });
    listRefreshInflight = { uid: token.uid, gen: token.gen, promise: pending };
    return pending;
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
    var payload = preparePayload(file, attempt, confirmReplace);
    if (kind === "evaluation" && selectedEvalFolderId) {
      payload.destinationFolderId = selectedEvalFolderId;
    }
    return call("prepareClubDriveUpload", payload).then(function (prepared) {
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
        "傳輸中：正在把檔案直接送到社團資料夾…" +
          (data.fileName ? "（Drive 檔名：" + data.fileName + "）" : ""),
        "warn"
      );
      setTransferProgress(5);
      return transfer(data.uploadUrl, file, signal).then(function (outcome) {
        if (!sameOp(token)) return null;
        if (outcome === "expired") {
          if (!allowRebuild) throw new Error("上傳工作階段已逾期。請再用同一個識別重試。");
          return prepareAndSend(token, file, attempt, signal, false, true);
        }
        setTransferProgress(100);
        // Bytes may be on Drive; completion is only after completeClubDriveUpload succeeds.
        setStatus("傳輸 100% 不算完成：正在向伺服器確認繳交…", "warn");
        return call("completeClubDriveUpload", { clientAttemptId: attempt });
      });
    });
  }

  function runUpload(confirmReplace) {
    var token = { gen: generation, op: operationSeq, uid: boundUid };
    if (busy) return;
    if (!uploadWriteAllowed) {
      setStatus("系統尚未開放上傳", "warn");
      return;
    }
    if (!serverCtx || serverCtx.generation !== token.gen || serverCtx.uid !== token.uid ||
      !serverCtx.activityId || !serverCtx.permanentClubId) {
      setStatus("尚未取得伺服器確認的活動與社團。", "warn");
      return;
    }
    var file = pendingReplace && pendingReplace.file
      ? pendingReplace.file
      : (uploadQueue[0] && uploadQueue[0].file);
    if (!file) {
      var inputEl = $("driveFile");
      if (inputEl && inputEl.files && inputEl.files.length) {
        addFilesFromList(inputEl.files);
        file = uploadQueue[0] && uploadQueue[0].file;
      }
    }
    if (!file) {
      setStatus("請先選擇或拖曳檔案。", "warn");
      return;
    }
    var kind = activeKind;
    var attempt = (pendingReplace && pendingReplace.attempt) || attemptFor(file, kind);
    if (!attempt) {
      setStatus("這個瀏覽器無法產生上傳識別，已拒絕上傳。", "error");
      return;
    }
    busy = true;
    if (uploadQueue[0]) uploadQueue[0].state = "上傳中";
    renderQueue();
    var button = $("btnDriveUpload");
    if (button) button.disabled = true;
    abortController = typeof AbortController === "function" ? new AbortController() : null;
    var signal = abortController ? abortController.signal : undefined;
    setStatus("等候伺服器：正在核對資格、截止與目的地…", "warn");
    setTransferProgress(0);
    prepareAndSend(token, file, attempt, signal, true, !!confirmReplace).then(function (done) {
      if (done && done.waitingReplaceConfirm) {
        busy = false;
        if ($("btnDriveUpload")) $("btnDriveUpload").disabled = !uploadWriteAllowed;
        return { stoppedForConfirm: true };
      }
      if (uploadQueue.length && uploadQueue[0].file === file) {
        uploadQueue.shift();
        renderQueue();
      }
      finishUpload(token, file, kind, done);
      setTransferProgress(null);
      return { continueQueue: uploadQueue.length > 0 };
    }).catch(function (error) {
      if (!sameOp(token)) return null;
      if (error && error.name === "AbortError") return null;
      if (uploadQueue[0]) uploadQueue[0].state = "失敗（原檔保留）";
      renderQueue();
      var info = errorInfo(error);
      setStatus("失敗：" + friendlyGateMessage(info), "error");
      setTransferProgress(null);
      var retry = $("btnDriveRetry");
      if (retry) retry.classList.remove("hidden");
      return null;
    }).then(function (outcome) {
      if (!sameOp(token)) return;
      busy = false;
      if ($("btnDriveUpload")) $("btnDriveUpload").disabled = !uploadWriteAllowed;
      if (outcome && outcome.continueQueue) runUpload(false);
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
    var backKinds = $("btnDriveBackToKinds");
    var confirmBtn = $("btnDriveReplaceConfirm");
    var cancelBtn = $("btnDriveReplaceCancel");
    var folderCreate = $("btnDriveEvalFolderCreate");
    var folderRefresh = $("btnDriveEvalFolderRefresh");
    var folderSelect = $("driveEvalFolderSelect");
    var dropzone = $("driveDropzone");
    var fileInput = $("driveFile");
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
      evalBtn.addEventListener("click", function () { applyKindUi("evaluation", true); });
    }
    if (featureBtn && !featureBtn.dataset.bound) {
      featureBtn.dataset.bound = "1";
      featureBtn.addEventListener("click", function () { applyKindUi("feature", true); });
    }
    if (backKinds && !backKinds.dataset.bound) {
      backKinds.dataset.bound = "1";
      backKinds.addEventListener("click", function () {
        hideReplaceConfirm();
        uploadQueue = [];
        renderQueue();
        setWorkspaceView("picker");
      });
    }
    if (confirmBtn && !confirmBtn.dataset.bound) {
      confirmBtn.dataset.bound = "1";
      confirmBtn.addEventListener("click", confirmReplaceUpload);
    }
    if (cancelBtn && !cancelBtn.dataset.bound) {
      cancelBtn.dataset.bound = "1";
      cancelBtn.addEventListener("click", cancelReplaceUpload);
    }
    if (folderCreate && !folderCreate.dataset.bound) {
      folderCreate.dataset.bound = "1";
      folderCreate.addEventListener("click", createEvalFolder);
    }
    if (folderRefresh && !folderRefresh.dataset.bound) {
      folderRefresh.dataset.bound = "1";
      folderRefresh.addEventListener("click", function () {
        refreshEvalFolders({ gen: generation, op: operationSeq, uid: boundUid }, true);
      });
    }
    if (folderSelect && !folderSelect.dataset.bound) {
      folderSelect.dataset.bound = "1";
      folderSelect.addEventListener("change", function () {
        selectedEvalFolderId = String(folderSelect.value || "");
        if (lastListData) {
          renderEvalFolderOptions({
            folders: (lastListData._evalFolders && lastListData._evalFolders.folders) || [],
            clubFolderId: (lastListData._evalFolders && lastListData._evalFolders.clubFolderId) || ""
          });
        }
      });
    }
    if (dropzone && !dropzone.dataset.bound) {
      dropzone.dataset.bound = "1";
      dropzone.addEventListener("click", function () {
        if (!uploadWriteAllowed) {
          setStatus("系統尚未開放上傳", "warn");
          return;
        }
        if (fileInput) fileInput.click();
      });
      dropzone.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          dropzone.click();
        }
      });
      ["dragenter", "dragover"].forEach(function (type) {
        dropzone.addEventListener(type, function (event) {
          event.preventDefault();
          event.stopPropagation();
          if (uploadWriteAllowed) dropzone.classList.add("dragover");
        });
      });
      ["dragleave", "drop"].forEach(function (type) {
        dropzone.addEventListener(type, function (event) {
          event.preventDefault();
          event.stopPropagation();
          dropzone.classList.remove("dragover");
        });
      });
      dropzone.addEventListener("drop", function (event) {
        addFilesFromList(event.dataTransfer && event.dataTransfer.files);
      });
    }
    if (fileInput && !fileInput.dataset.bound) {
      fileInput.dataset.bound = "1";
      fileInput.addEventListener("change", function () {
        addFilesFromList(fileInput.files);
        fileInput.value = "";
      });
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
    syncFromPlatformAuth: syncFromPlatformAuth,
    focusWorkspace: function () {
      var ws = $("driveWorkspace");
      if (ws) ws.scrollIntoView({ behavior: "smooth", block: "start" });
      updateWorkspaceMeta();
    }
  };

  // If Auth already confirmed before this script ran (and Auth listener is async),
  // pull once now; watchAuth callback will also pull for the same UID.
  syncFromPlatformAuth();
})();
