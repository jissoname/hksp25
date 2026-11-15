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
  var browseClubFolderId = "";
  var browsePathLabel = "";
  var browseRequestSeq = 0;
  var evalFolderBusy = false;
  var uploadQueue = [];
  var workspaceView = "picker"; // picker | tools
  // Before first list: allow click; prepare／complete still server-gated.
  // After list: applyWindowReadOnly may force read-only.
  // 未取得 list／窗口前不得預設可操作；須等伺服器回傳後再開。
  var uploadWriteAllowed = false;
  var listedAtLocalMs = 0;
  var windowWatchTimer = null;
  var listRefreshInflight = null;
  var evalFoldersInflight = null;
  /** Short-lived folder contents cache by parent. Cleared on logout/gen/write success. */
  var evalFoldersByParent = Object.create(null);
  var EVAL_FOLDERS_TTL_MS = 60 * 1000;
  /** Expanded folder ids in the lazy sidebar tree (club root always expanded). */
  var treeExpandedIds = Object.create(null);
  var treeLoadInflight = Object.create(null);
  var browseSearchQuery = "";
  var lastBrowseSnapshot = null;
  var treeMobileOpen = true;

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

  function setBrowserState(kind, text) {
    var el = $("driveBrowserState");
    var wrap = $("driveBrowserTableWrap");
    var count = $("driveBrowserCount");
    if (!el) return;
    if (!kind) {
      el.className = "hidden";
      el.textContent = "";
      if (wrap) wrap.classList.remove("hidden");
      if (count) count.classList.remove("hidden");
      return;
    }
    el.className = "drive-browser-state drive-browser-" + kind;
    el.textContent = String(text || "");
    if (wrap) wrap.classList.add("hidden");
    if (count) count.classList.add("hidden");
  }

  function currentBrowseParentId() {
    return String(selectedEvalFolderId || browseClubFolderId || "");
  }

  function cacheKeyForFolderId(folderId) {
    var id = String(folderId || "");
    if (!id || (browseClubFolderId && id === browseClubFolderId)) return "";
    return id;
  }

  function pathLabelFromPayload(data) {
    var path = (data && data.path) || [];
    if (!path.length) {
      return (data && (data.parentName || data.clubName)) || "社團評選資料夾";
    }
    return path.map(function (step) { return step.name; }).join(" / ");
  }

  function currentFolderTitle(data) {
    var path = (data && data.path) || [];
    if (path.length) return String(path[path.length - 1].name || "資料夾");
    return (data && (data.parentName || data.clubName)) ||
      (serverCtx && serverCtx.clubName) ||
      "評選資料";
  }

  function syncUploadDestBanner() {
    var banner = $("driveUploadDestBanner");
    if (!banner) return;
    if (activeKind !== "evaluation" || workspaceView !== "tools") {
      banner.classList.add("hidden");
      banner.textContent = "";
      return;
    }
    banner.classList.remove("hidden");
    banner.innerHTML =
      "目前位置：<strong>" +
      (browsePathLabel || "社團評選資料夾") +
      "</strong><span class=\"dest-note\">新增資料夾及上傳檔案都會存放在這裡</span>";
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
    panel.classList.toggle("is-collapsed", !treeMobileOpen);
    if (!show) return;
    var createBtn = $("btnDriveEvalFolderCreate");
    var showCreateBtn = $("btnDriveShowCreateFolder");
    var pickUploadBtn = $("btnDrivePickUpload");
    var nameInput = $("driveEvalFolderName");
    var refreshBtn = $("btnDriveEvalFolderRefresh");
    var upBtn = $("btnDriveBrowserUp");
    var canWrite = uploadWriteAllowed && !evalFolderBusy;
    var canCreate = canWrite && !(lastListData && lastListData._browseCanCreate === false);
    var atRoot = !selectedEvalFolderId ||
      (browseClubFolderId && selectedEvalFolderId === browseClubFolderId);
    if (createBtn) createBtn.disabled = !canCreate;
    if (showCreateBtn) showCreateBtn.disabled = !canCreate;
    if (pickUploadBtn) pickUploadBtn.disabled = !canWrite;
    if (nameInput) nameInput.disabled = !canWrite;
    if (refreshBtn) refreshBtn.disabled = evalFolderBusy;
    if (upBtn) upBtn.disabled = evalFolderBusy || !!atRoot;
    var toggle = $("btnDriveTreeToggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", treeMobileOpen ? "true" : "false");
      toggle.textContent = treeMobileOpen ? "收合資料夾導覽" : "展開資料夾導覽";
    }
    syncUploadDestBanner();
  }

  function clearEvalFoldersCache() {
    evalFoldersByParent = Object.create(null);
    if (lastListData) lastListData._evalFolders = null;
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
    var key = String(parentId || "");
    var stamped = stampEvalFoldersCache(data, key);
    evalFoldersByParent[key] = stamped;
    if (lastListData) lastListData._evalFolders = stamped;
    return stamped;
  }

  function renderBrowserCrumbs(path, clubFolderId) {
    var nav = $("driveBrowserCrumbs");
    if (!nav) return;
    nav.replaceChildren();
    var rootBtn = document.createElement("button");
    rootBtn.type = "button";
    rootBtn.textContent = "評選資料";
    rootBtn.addEventListener("click", function () {
      openBrowseFolder("", true);
    });
    nav.appendChild(rootBtn);
    var steps = path && path.length
      ? path
      : [{ folderId: clubFolderId || "", name: (serverCtx && serverCtx.clubName) || "社團評選資料夾", depth: 0 }];
    steps.forEach(function (step, index) {
      var sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = ">";
      nav.appendChild(sep);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = step.name || step.folderId || "資料夾";
      var isLast = index === steps.length - 1;
      var targetId = String(step.folderId || "");
      if (isLast) {
        btn.disabled = true;
      } else {
        btn.addEventListener("click", function () {
          openBrowseFolder(targetId === browseClubFolderId ? "" : targetId, true);
        });
      }
      nav.appendChild(btn);
    });
  }

  function dashOr(value) {
    if (value == null || value === "") return "—";
    return value;
  }

  function formatSizeCell(size) {
    if (size == null || size === "") return "—";
    var n = Number(size);
    if (!Number.isFinite(n) || n < 0) return "—";
    return formatBytes(n);
  }

  function matchesBrowseSearch(name) {
    var q = String(browseSearchQuery || "").trim().toLowerCase();
    if (!q) return true;
    return String(name || "").toLowerCase().indexOf(q) >= 0;
  }

  function appendTableCell(tr, text, className, dataLabel) {
    var td = document.createElement("td");
    if (className) td.className = className;
    if (dataLabel) td.setAttribute("data-label", dataLabel);
    td.textContent = text;
    tr.appendChild(td);
    return td;
  }

  function renderBrowserTable(data) {
    var list = $("driveEvalFolderList");
    var countEl = $("driveBrowserCount");
    if (!list) return { empty: true, folderCount: 0, fileCount: 0 };
    var folders = ((data && data.folders) || []).filter(function (folder) {
      return matchesBrowseSearch(folder && folder.name);
    });
    var files = ((data && data.files) || []).filter(function (file) {
      return matchesBrowseSearch(file && file.name);
    });
    list.replaceChildren();
    folders.forEach(function (folder) {
      var id = folder && (folder.folderId || folder.id);
      if (!id) return;
      var tr = document.createElement("tr");
      tr.className = "is-folder";
      var nameTd = document.createElement("td");
      var nameWrap = document.createElement("div");
      nameWrap.className = "drive-cell-name";
      var ico = document.createElement("span");
      ico.className = "drive-ico-folder";
      ico.setAttribute("aria-hidden", "true");
      var nameText = document.createElement("span");
      nameText.className = "name-text";
      nameText.textContent = String(folder.name || id);
      nameWrap.appendChild(ico);
      nameWrap.appendChild(nameText);
      nameTd.appendChild(nameWrap);
      tr.appendChild(nameTd);
      appendTableCell(tr, "—", "drive-table-meta", "大小");
      appendTableCell(tr, "—", "drive-table-meta", "更新時間");
      var actionTd = document.createElement("td");
      actionTd.setAttribute("data-label", "操作");
      var openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "drive-table-action";
      openBtn.textContent = "開啟 →";
      openBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        openBrowseFolder(String(id), true);
      });
      actionTd.appendChild(openBtn);
      tr.appendChild(actionTd);
      tr.addEventListener("click", function () {
        openBrowseFolder(String(id), true);
      });
      list.appendChild(tr);
    });
    files.forEach(function (file) {
      var tr = document.createElement("tr");
      tr.className = "is-file";
      var nameTd = document.createElement("td");
      var nameWrap = document.createElement("div");
      nameWrap.className = "drive-cell-name";
      var ico = document.createElement("span");
      ico.className = "drive-ico-pdf";
      ico.setAttribute("aria-hidden", "true");
      ico.textContent = "PDF";
      var nameText = document.createElement("span");
      nameText.className = "name-text";
      nameText.textContent = String(file.name || file.fileId || "（未命名）");
      nameWrap.appendChild(ico);
      nameWrap.appendChild(nameText);
      nameTd.appendChild(nameWrap);
      tr.appendChild(nameTd);
      appendTableCell(tr, formatSizeCell(file.size), "drive-table-meta", "大小");
      appendTableCell(
        tr,
        file.modifiedTime ? formatTaipeiDateTime(file.modifiedTime) : "—",
        "drive-table-meta",
        "更新時間"
      );
      var actionTd = document.createElement("td");
      actionTd.setAttribute("data-label", "操作");
      if (file.viewUrl) {
        var link = document.createElement("a");
        link.className = "drive-table-action";
        link.href = String(file.viewUrl);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "查看";
        actionTd.appendChild(link);
      } else {
        actionTd.textContent = "—";
      }
      tr.appendChild(actionTd);
      list.appendChild(tr);
    });
    if (countEl) {
      countEl.textContent =
        folders.length + " 個資料夾　·　" + files.length + " 個檔案";
    }
    return {
      empty: folders.length + files.length === 0,
      folderCount: folders.length,
      fileCount: files.length
    };
  }

  function ensurePathExpanded(path) {
    (path || []).forEach(function (step) {
      var id = String((step && step.folderId) || "");
      if (id) treeExpandedIds[id] = true;
    });
    if (browseClubFolderId) treeExpandedIds[browseClubFolderId] = true;
  }

  function loadTreeChildren(folderId) {
    var key = cacheKeyForFolderId(folderId);
    if (evalFoldersCacheValid(evalFoldersByParent[key], key)) {
      renderSidebarTree();
      return Promise.resolve(evalFoldersByParent[key]);
    }
    if (treeLoadInflight[key]) return treeLoadInflight[key];
    var body = {};
    if (key) body.parentFolderId = key;
    var pending = call("listClubEvaluationFolders", body).then(function (result) {
      var data = (result && result.data) || {};
      rememberEvalFolders(data, key);
      renderSidebarTree();
      return data;
    }).catch(function () {
      return null;
    }).finally(function () {
      delete treeLoadInflight[key];
    });
    treeLoadInflight[key] = pending;
    return pending;
  }

  function toggleTreeExpand(folderId) {
    var id = String(folderId || "");
    if (!id) return;
    if (treeExpandedIds[id]) {
      delete treeExpandedIds[id];
      renderSidebarTree();
      return;
    }
    treeExpandedIds[id] = true;
    loadTreeChildren(id);
    renderSidebarTree();
  }

  function renderTreeNode(parentUl, folder, depth) {
    var id = String((folder && (folder.folderId || folder.id)) || "");
    if (!id) return;
    var li = document.createElement("li");
    var row = document.createElement("div");
    row.className = "drive-tree-row";
    var selectedId = currentBrowseParentId();
    if (id === selectedId || (!selectedEvalFolderId && id === browseClubFolderId)) {
      row.classList.add("is-active");
    }
    var expand = document.createElement("button");
    expand.type = "button";
    expand.className = "drive-tree-expand";
    var expanded = !!treeExpandedIds[id];
    expand.textContent = expanded ? "▾" : "▸";
    expand.setAttribute("aria-label", expanded ? "收合" : "展開");
    expand.addEventListener("click", function (event) {
      event.stopPropagation();
      toggleTreeExpand(id);
    });
    var openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "drive-tree-open";
    var ico = document.createElement("span");
    ico.className = "drive-ico-folder";
    ico.setAttribute("aria-hidden", "true");
    var name = document.createElement("span");
    name.className = "drive-tree-name";
    name.textContent = String((folder && folder.name) || id);
    openBtn.appendChild(ico);
    openBtn.appendChild(name);
    openBtn.addEventListener("click", function () {
      treeExpandedIds[id] = true;
      openBrowseFolder(id === browseClubFolderId ? "" : id, true);
    });
    row.appendChild(expand);
    row.appendChild(openBtn);
    li.appendChild(row);
    if (expanded) {
      var childKey = cacheKeyForFolderId(id);
      var cache = evalFoldersByParent[childKey];
      var childUl = document.createElement("ul");
      if (cache && cache.folders && cache.folders.length) {
        cache.folders.forEach(function (child) {
          renderTreeNode(childUl, child, depth + 1);
        });
      } else if (treeLoadInflight[childKey]) {
        var loading = document.createElement("li");
        loading.style.cssText = "color:#6a7f94;font-size:.82rem;padding:4px 8px 4px 28px";
        loading.textContent = "載入中…";
        childUl.appendChild(loading);
      }
      li.appendChild(childUl);
    }
    parentUl.appendChild(li);
  }

  function renderSidebarTree() {
    var tree = $("driveFolderTree");
    if (!tree) return;
    tree.replaceChildren();
    var clubName =
      (serverCtx && serverCtx.clubName) ||
      (lastBrowseSnapshot && lastBrowseSnapshot.clubName) ||
      "社團評選資料夾";
    var root = {
      folderId: browseClubFolderId || "root",
      name: clubName
    };
    if (browseClubFolderId) treeExpandedIds[browseClubFolderId] = true;
    renderTreeNode(tree, root, 0);
  }

  function renderBrowserContents(data) {
    var title = $("driveFolderTitle");
    if (!data) return { empty: true };
    var clubFolderId = data.clubFolderId || browseClubFolderId || "";
    browseClubFolderId = clubFolderId || browseClubFolderId;
    browsePathLabel = pathLabelFromPayload(data);
    lastBrowseSnapshot = data;
    if (title) title.textContent = currentFolderTitle(data);
    ensurePathExpanded(data.path);
    renderBrowserCrumbs(data.path, clubFolderId);
    syncUploadDestBanner();
    syncDropzoneCopy();
    renderSidebarTree();
    return renderBrowserTable(data);
  }

  function applyEvalFoldersData(data, requestedParentId, requestSeq) {
    if (!data) return null;
    if (requestSeq != null && Number(requestSeq) !== Number(browseRequestSeq)) return null;
    var parentKey = String(requestedParentId || "");
    var responseParent = String(data.parentFolderId || "");
    if (parentKey && responseParent && parentKey !== responseParent &&
      !(parentKey === "" && responseParent === String(data.clubFolderId || ""))) {
      return null;
    }
    if (lastListData && data.driveWriteEnabled === false) {
      lastListData.driveWriteEnabled = false;
      lastListData.driveUploadMode = data.driveUploadMode || "off";
    }
    if (data.clubFolderId) browseClubFolderId = String(data.clubFolderId);
    if (data.parentFolderId) {
      selectedEvalFolderId =
        String(data.parentFolderId) === String(browseClubFolderId)
          ? ""
          : String(data.parentFolderId);
    }
    lastListData = lastListData || {};
    lastListData._browseCanCreate = data.canCreateSubfolder !== false;
    rememberEvalFolders(data, parentKey || String(data.parentFolderId || ""));
    setBrowserState("", "");
    var rendered = renderBrowserContents(data);
    if (data.driveWriteEnabled === false) {
      setEvalFolderStatus("唯讀瀏覽（系統尚未開放寫入）。瀏覽到檔案不等於有效繳交。", "ok");
      setUploadControlsEnabled(false, "系統尚未開放上傳");
    } else if (rendered.empty) {
      setEvalFolderStatus("此位置目前沒有資料夾或檔案。", "ok");
    } else {
      setEvalFolderStatus("已載入目前位置內容。瀏覽到檔案不等於有效繳交。", "ok");
    }
    syncEvalFolderPanel();
    return data;
  }

  function openBrowseFolder(folderId, forceNetwork) {
    selectedEvalFolderId = String(folderId || "");
    syncUploadDestBanner();
    return refreshEvalFolders(
      { gen: generation, op: operationSeq, uid: boundUid },
      !!forceNetwork
    );
  }

  function browseUpOneLevel() {
    var cache = evalFoldersByParent[currentBrowseParentId()] ||
      evalFoldersByParent[String(selectedEvalFolderId || "")] ||
      null;
    var path = (cache && cache.path) || [];
    if (path.length >= 2) {
      var parent = path[path.length - 2];
      var id = String(parent.folderId || "");
      return openBrowseFolder(id === browseClubFolderId ? "" : id, true);
    }
    return openBrowseFolder("", true);
  }

  function refreshEvalFolders(token, force) {
    if (activeKind !== "evaluation") return Promise.resolve(null);
    var parentId = String(selectedEvalFolderId || "");
    var cacheCandidate = evalFoldersByParent[parentId] || null;
    if (!force && evalFoldersCacheValid(cacheCandidate, parentId)) {
      applyEvalFoldersData(cacheCandidate, parentId, browseRequestSeq);
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
    var requestSeq = ++browseRequestSeq;
    evalFolderBusy = true;
    syncEvalFolderPanel();
    setBrowserState("loading", "正在載入目前位置…");
    setEvalFolderStatus("正在載入目前位置…", "warn");
    var body = {};
    if (parentId) body.parentFolderId = parentId;
    var pending = call("listClubEvaluationFolders", body).then(function (result) {
      if (token && Number(token.gen) !== Number(generation)) return null;
      if (token && String(token.uid || "") !== String(boundUid || "")) return null;
      if (Number(requestSeq) !== Number(browseRequestSeq)) return null;
      return applyEvalFoldersData(result.data || {}, parentId, requestSeq);
    }).catch(function (error) {
      if (token && Number(token.gen) !== Number(generation)) return null;
      if (token && String(token.uid || "") !== String(boundUid || "")) return null;
      if (Number(requestSeq) !== Number(browseRequestSeq)) return null;
      var info = errorInfo(error);
      var list = $("driveEvalFolderList");
      if (list) list.replaceChildren();
      setBrowserState("error", "讀取失敗：" + friendlyGateMessage(info));
      setEvalFolderStatus("讀取失敗：" + friendlyGateMessage(info), "error");
      return null;
    }).then(function (data) {
      if (Number(requestSeq) !== Number(browseRequestSeq)) return data;
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
      setEvalFolderStatus("目前為唯讀狀態，無法新增資料夾。", "warn");
      return;
    }
    var nameInput = $("driveEvalFolderName");
    var name = nameInput && nameInput.value ? String(nameInput.value).trim() : "";
    if (!name) {
      setEvalFolderStatus("請輸入資料夾名稱。", "warn");
      return;
    }
    var parentFolderId = String(selectedEvalFolderId || "");
    var destLabel = browsePathLabel || "社團評選資料夾";
    evalFolderBusy = true;
    syncEvalFolderPanel();
    setEvalFolderStatus("正在於「" + destLabel + "」新增資料夾…", "warn");
    var body = { name: name };
    if (parentFolderId) body.parentFolderId = parentFolderId;
    call("createClubEvaluationFolder", body).then(function (result) {
      if (!sameOp(token)) return null;
      var data = result.data || {};
      if (nameInput) nameInput.value = "";
      clearEvalFoldersCache();
      var successText =
        (data.reused ? "已沿用同名資料夾：" : "已新增資料夾：") +
        (data.name || name) +
        "（位置：" + destLabel + "）";
      return refreshEvalFolders(token, true).then(function () {
        if (!sameOp(token)) return data;
        setEvalFolderStatus(successText, "ok");
        showCreateFolderBox(false);
        return data;
      });
    }).catch(function (error) {
      if (!sameOp(token)) return;
      var info = errorInfo(error);
      setEvalFolderStatus(friendlyGateMessage(info), "error");
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
    var folderName = currentFolderTitle(lastBrowseSnapshot) || "目前資料夾";
    if (title) {
      if (!uploadWriteAllowed) {
        title.textContent = "目前為唯讀（不可選檔上傳）";
      } else if (activeKind === "evaluation") {
        title.textContent = "將 PDF 拖曳到這裡，存入「" + folderName + "」";
      } else {
        title.textContent = "拖曳檔案到此，或點選選擇";
      }
    }
    if (sub) {
      sub.textContent = activeKind === "evaluation"
        ? "單檔上限 100 MiB；可多檔，同名須確認後才取代。"
        : hintForKind(activeKind);
    }
    var zone = $("driveDropzone");
    if (zone) zone.classList.toggle("disabled", !uploadWriteAllowed);
  }

  function showCreateFolderBox(show) {
    var box = $("driveCreateFolderBox");
    if (!box) return;
    box.classList.toggle("hidden", !show);
    if (show) {
      var nameInput = $("driveEvalFolderName");
      if (nameInput) {
        nameInput.focus();
        nameInput.select();
      }
    }
  }

  function showSuccessToast(fileName, destLabel) {
    var toast = $("driveSuccessToast");
    var pathEl = $("driveToastPath");
    var fileEl = $("driveToastFile");
    var titleEl = $("driveToastTitle");
    if (!toast) return;
    if (titleEl) titleEl.textContent = "上傳完成";
    if (pathEl) pathEl.textContent = "已儲存至：" + (destLabel || "—");
    if (fileEl) fileEl.textContent = fileName || "—";
    toast.classList.remove("hidden");
  }

  function hideSuccessToast() {
    var toast = $("driveSuccessToast");
    if (toast) toast.classList.add("hidden");
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
      browsePathLabel = "";
      browseSearchQuery = "";
      lastBrowseSnapshot = null;
      setEvalFolderStatus("", "");
      setBrowserState("", "");
      showCreateFolderBox(false);
      syncUploadDestBanner();
    } else {
      browseSearchQuery = "";
      var search = $("driveBrowserSearch");
      if (search) search.value = "";
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
    selectedEvalFolderId = "";
    browseClubFolderId = "";
    browsePathLabel = "";
    browseRequestSeq += 1;
    browseSearchQuery = "";
    lastBrowseSnapshot = null;
    treeExpandedIds = Object.create(null);
    treeLoadInflight = Object.create(null);
    treeMobileOpen = true;
    hideSuccessToast();
    showCreateFolderBox(false);
    clearEvalFoldersCache();
    evalFoldersInflight = null;
    listedAtLocalMs = 0;
    uploadWriteAllowed = false;
    clearWindowWatch();
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    clearSurface();
    var button = $("btnDriveUpload");
    if (button) button.disabled = true;
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

  function attemptKey(file, kind, destinationFolderId) {
    var dest = destinationFolderId != null
      ? String(destinationFolderId || "root")
      : (kind === "evaluation" ? (selectedEvalFolderId || "root") : "feature");
    return [
      "hkspDriveAttempt",
      kind || activeKind,
      serverCtx.uid,
      serverCtx.activityId,
      serverCtx.permanentClubId,
      kind === "evaluation" ? dest : "feature",
      file.name,
      file.size,
      file.lastModified
    ].join(":");
  }

  function attemptFor(file, kind, destinationFolderId) {
    var key = attemptKey(file, kind, destinationFolderId);
    var existing = "";
    try { existing = sessionStorage.getItem(key) || ""; } catch (error) { existing = ""; }
    if (existing) return existing;
    var id = randomAttemptId();
    if (!id) return "";
    try { sessionStorage.setItem(key, id); } catch (error) { return ""; }
    return id;
  }

  function clearAttempt(file, kind, destinationFolderId) {
    try {
      sessionStorage.removeItem(attemptKey(file, kind, destinationFolderId));
    } catch (error) { /* ignore */ }
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
    if (code === "UPLOAD_GATE_PAUSED") {
      return "管理員已暫停上傳（可唯讀瀏覽；無法開始新上傳）";
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
      if (item.destinationLabel) {
        var dest = document.createElement("div");
        dest.className = "q-dest";
        dest.textContent = "目的地：" + item.destinationLabel;
        left.appendChild(dest);
      }
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
    var destId = activeKind === "evaluation" ? String(selectedEvalFolderId || "") : "";
    var destLabel = activeKind === "evaluation"
      ? (browsePathLabel || "社團評選資料夾")
      : "特色共用資料夾";
    syncUploadDestBanner();
    if (activeKind === "feature") {
      uploadQueue = [{
        file: files[0],
        state: "等待上傳",
        destinationFolderId: "",
        destinationLabel: destLabel
      }];
    } else {
      files.forEach(function (file) {
        if (!file) return;
        uploadQueue.push({
          file: file,
          state: "等待上傳",
          destinationFolderId: destId,
          destinationLabel: destLabel
        });
      });
    }
    renderQueue();
    setStatus(
      activeKind === "feature"
        ? "已選取 1 個檔案，目的地：" + destLabel + "。按「開始上傳」送出。"
        : "已加入 " + files.length + " 個檔案至佇列（目的地已固定為：" + destLabel + "）。",
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
      title.textContent = activeKind === "feature" ? "特色資料" : "評選資料";
    }
    if (meta) {
      meta.textContent =
        (serverCtx.clubName || "社團") +
        "（" + (serverCtx.permanentClubId || "") + "）";
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
    if (!win) {
      return {
        open: false,
        code: "UPLOAD_WINDOW_NOT_CONFIGURED",
        message: "尚未取得伺服器截止窗口，無法上傳。"
      };
    }
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
      var gate = lastListData.uploadGate || null;
      var pausedByAdmin = gate && gate.envLive === true && gate.open === false;
      setUploadControlsEnabled(
        false,
        pausedByAdmin ? "管理員已暫停上傳（可唯讀瀏覽）" : "系統尚未開放上傳"
      );
      return;
    }
    var win = wins[kind] || null;
    if (!win) {
      clearWindowWatch();
      setUploadControlsEnabled(
        false,
        "尚未取得伺服器截止窗口，無法上傳。"
      );
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
      if (prevFolders && evalFoldersCacheValid(prevFolders, String(prevFolders._cacheParent || ""))) {
        lastListData._evalFolders = prevFolders;
        evalFoldersByParent[String(prevFolders._cacheParent || "")] = prevFolders;
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

  function finishUpload(token, file, kind, done, queueItem) {
    if (!sameOp(token) || !done) return;
    listRequestSeq += 1;
    renderList((done.data && done.data.files) || done.files || []);
    var destLabel = (queueItem && queueItem.destinationLabel) ||
      (kind === "evaluation" ? (browsePathLabel || "社團評選資料夾") : "特色共用資料夾");
    var fileName = (file && file.name) || "—";
    setStatus(
      done.alreadyComplete
        ? "這次上傳已經完成，沒有再新增檔案。"
        : "已由伺服器確認完成並寫入紀錄（傳輸進度 100% 不算完成）。目的地：" + destLabel,
      "ok"
    );
    if (!done.alreadyComplete) {
      showSuccessToast(fileName, destLabel);
    }
    var retry = $("btnDriveRetry");
    if (retry) retry.classList.add("hidden");
    hideReplaceConfirm();
    clearAttempt(
      file,
      kind,
      queueItem && queueItem.destinationFolderId != null
        ? queueItem.destinationFolderId
        : undefined
    );
    if (kind === "evaluation") {
      clearEvalFoldersCache();
      refreshEvalFolders(token, true);
    }
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

  function prepareAndSend(token, file, attempt, signal, allowRebuild, confirmReplace, queueItem) {
    if (!sameOp(token)) return Promise.resolve(null);
    var kind = activeKind;
    var payload = preparePayload(file, attempt, confirmReplace);
    var destId = queueItem && queueItem.destinationFolderId != null
      ? String(queueItem.destinationFolderId || "")
      : (kind === "evaluation" ? String(selectedEvalFolderId || "") : "");
    if (kind === "evaluation" && destId) {
      payload.destinationFolderId = destId;
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
          return prepareAndSend(token, file, attempt, signal, false, true, queueItem);
        }
        setTransferProgress(100);
        // Bytes may be on Drive; completion is only after completeClubDriveUpload succeeds.
        setStatus(
          "傳輸 100% 不算完成：正在向伺服器確認繳交…" +
            (queueItem && queueItem.destinationLabel
              ? "（目的地：" + queueItem.destinationLabel + "）"
              : ""),
          "warn"
        );
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
    var queueItem = pendingReplace && pendingReplace.queueItem
      ? pendingReplace.queueItem
      : uploadQueue[0];
    var file = pendingReplace && pendingReplace.file
      ? pendingReplace.file
      : (queueItem && queueItem.file);
    if (!file) {
      var inputEl = $("driveFile");
      if (inputEl && inputEl.files && inputEl.files.length) {
        addFilesFromList(inputEl.files);
        queueItem = uploadQueue[0];
        file = queueItem && queueItem.file;
      }
    }
    if (!file) {
      setStatus("請先選擇或拖曳檔案。", "warn");
      return;
    }
    if (!queueItem) {
      queueItem = {
        file: file,
        destinationFolderId: activeKind === "evaluation" ? String(selectedEvalFolderId || "") : "",
        destinationLabel: activeKind === "evaluation"
          ? (browsePathLabel || "社團評選資料夾")
          : "特色共用資料夾"
      };
    }
    var kind = activeKind;
    var attempt = (pendingReplace && pendingReplace.attempt) ||
      attemptFor(file, kind, queueItem.destinationFolderId);
    if (!attempt) {
      setStatus("這個瀏覽器無法產生上傳識別，已拒絕上傳。", "error");
      return;
    }
    busy = true;
    if (uploadQueue[0] && uploadQueue[0].file === file) uploadQueue[0].state = "上傳中";
    renderQueue();
    var button = $("btnDriveUpload");
    if (button) button.disabled = true;
    abortController = typeof AbortController === "function" ? new AbortController() : null;
    var signal = abortController ? abortController.signal : undefined;
    setStatus(
      "等候伺服器：正在核對資格、截止與目的地…" +
        (queueItem.destinationLabel ? "（" + queueItem.destinationLabel + "）" : ""),
      "warn"
    );
    setTransferProgress(0);
    prepareAndSend(token, file, attempt, signal, true, !!confirmReplace, queueItem).then(function (done) {
      if (done && done.waitingReplaceConfirm) {
        if (pendingReplace) pendingReplace.queueItem = queueItem;
        busy = false;
        if ($("btnDriveUpload")) $("btnDriveUpload").disabled = !uploadWriteAllowed;
        return { stoppedForConfirm: true };
      }
      if (uploadQueue.length && uploadQueue[0].file === file) {
        uploadQueue.shift();
        renderQueue();
      }
      finishUpload(token, file, kind, done, queueItem);
      setTransferProgress(null);
      return { continueQueue: uploadQueue.length > 0 };
    }).catch(function (error) {
      if (!sameOp(token)) return null;
      if (error && error.name === "AbortError") return null;
      if (uploadQueue[0] && uploadQueue[0].file === file) {
        uploadQueue[0].state = "失敗（原檔保留）";
      }
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
    var folderUp = $("btnDriveBrowserUp");
    var showCreate = $("btnDriveShowCreateFolder");
    var cancelCreate = $("btnDriveCancelCreateFolder");
    var pickUpload = $("btnDrivePickUpload");
    var treeToggle = $("btnDriveTreeToggle");
    var searchInput = $("driveBrowserSearch");
    var toastClose = $("btnDriveToastClose");
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
        hideSuccessToast();
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
    if (showCreate && !showCreate.dataset.bound) {
      showCreate.dataset.bound = "1";
      showCreate.addEventListener("click", function () {
        showCreateFolderBox(true);
      });
    }
    if (cancelCreate && !cancelCreate.dataset.bound) {
      cancelCreate.dataset.bound = "1";
      cancelCreate.addEventListener("click", function () {
        showCreateFolderBox(false);
      });
    }
    if (pickUpload && !pickUpload.dataset.bound) {
      pickUpload.dataset.bound = "1";
      pickUpload.addEventListener("click", function () {
        if (!uploadWriteAllowed) {
          setStatus("系統尚未開放上傳", "warn");
          return;
        }
        if (fileInput) fileInput.click();
      });
    }
    if (treeToggle && !treeToggle.dataset.bound) {
      treeToggle.dataset.bound = "1";
      treeToggle.addEventListener("click", function () {
        treeMobileOpen = !treeMobileOpen;
        syncEvalFolderPanel();
      });
    }
    if (searchInput && !searchInput.dataset.bound) {
      searchInput.dataset.bound = "1";
      searchInput.addEventListener("input", function () {
        browseSearchQuery = String(searchInput.value || "");
        if (lastBrowseSnapshot) renderBrowserTable(lastBrowseSnapshot);
      });
    }
    if (toastClose && !toastClose.dataset.bound) {
      toastClose.dataset.bound = "1";
      toastClose.addEventListener("click", hideSuccessToast);
    }
    if (folderRefresh && !folderRefresh.dataset.bound) {
      folderRefresh.dataset.bound = "1";
      folderRefresh.addEventListener("click", function () {
        refreshEvalFolders({ gen: generation, op: operationSeq, uid: boundUid }, true);
      });
    }
    if (folderUp && !folderUp.dataset.bound) {
      folderUp.dataset.bound = "1";
      folderUp.addEventListener("click", function () {
        browseUpOneLevel();
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
