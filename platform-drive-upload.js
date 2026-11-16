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
  /** Expanded folder ids in the lazy sidebar tree. */
  var treeExpandedIds = Object.create(null);
  var treeLoadInflight = Object.create(null);
  var treeLoadErrors = Object.create(null);
  var browseSearchQuery = "";
  var lastBrowseSnapshot = null;
  var treeMobileOpen = true;
  var pendingFileAction = null;
  var fileOpBusy = false;
  var dragFilePayload = null;
  var selectedBrowseItems = Object.create(null);
  var browserViewMode = "browse"; // browse | trash
  var priorBrowseFolderId = "";
  var folderPickerState = null;
  var pendingRename = null;
  var pdfPreviewBlobUrl = null;
  var searchDebounceTimer = null;
  var browseSearchScope = "current";
  var clubSearchResults = null;
  var contextMenuEl = null;
  var longPressTimer = null;
  var longPressStart = null;
  var LONG_PRESS_MS = 520;
  var LONG_PRESS_MOVE_PX = 12;
  var SORT_STORAGE_KEY = "hksp.evalBrowseSort";
  var browseSort = loadBrowseSortPreference();

  function $(id) {
    return document.getElementById(id);
  }

  function loadBrowseSortPreference() {
    try {
      var raw = sessionStorage.getItem(SORT_STORAGE_KEY) || "name-asc";
      var parts = String(raw).split("-");
      var field = parts[0] || "name";
      var dir = parts[1] === "desc" ? "desc" : "asc";
      if (field !== "name" && field !== "size" && field !== "modified") field = "name";
      return { field: field, dir: dir };
    } catch (_error) {
      return { field: "name", dir: "asc" };
    }
  }

  function persistBrowseSort() {
    try {
      sessionStorage.setItem(
        SORT_STORAGE_KEY,
        String(browseSort.field || "name") + "-" + String(browseSort.dir || "asc")
      );
    } catch (_error) { /* ignore */ }
  }

  var TRANSIENT_RETRY_MAX = 2;
  var TRANSIENT_RETRY_BASE_MS = 400;
  var WRITE_CALLS = {
    prepareClubDriveUpload: true,
    completeClubDriveUpload: true,
    createClubEvaluationFolder: true,
    trashClubEvaluationFile: true,
    moveClubEvaluationFile: true,
    copyClubEvaluationFile: true,
    renameClubEvaluationFile: true,
    renameClubEvaluationFolder: true,
    trashClubEvaluationFolder: true,
    moveClubEvaluationFolder: true,
    restoreClubEvaluationItem: true
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
    var section = $("driveRecordsSection");
    if (!list) return;
    var kind = activeKind === "feature" ? "feature" : "evaluation";
    // Evaluation records are shown via the folder browser; hide the duplicate list.
    if (kind === "evaluation") {
      if (section) section.classList.add("hidden");
      list.replaceChildren();
      return;
    }
    if (section) section.classList.remove("hidden");
    var filtered = filesForActiveKind(files);
    if (head) head.textContent = "已繳交紀錄（特色）";
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
    var pickFolderUploadBtn = $("btnDrivePickFolderUpload");
    var nameInput = $("driveEvalFolderName");
    var refreshBtn = $("btnDriveEvalFolderRefresh");
    var upBtn = $("btnDriveBrowserUp");
    var viewBrowse = $("btnDriveViewBrowse");
    var viewTrash = $("btnDriveViewTrash");
    var inTrash = browserViewMode === "trash";
    var canWrite = uploadWriteAllowed && !evalFolderBusy && !inTrash;
    var canCreate = canWrite && !(lastListData && lastListData._browseCanCreate === false);
    var atRoot = !selectedEvalFolderId ||
      (browseClubFolderId && selectedEvalFolderId === browseClubFolderId);
    if (createBtn) createBtn.disabled = !canCreate;
    if (showCreateBtn) showCreateBtn.disabled = !canCreate || inTrash;
    if (pickUploadBtn) pickUploadBtn.disabled = !canWrite;
    if (pickFolderUploadBtn) pickFolderUploadBtn.disabled = !canWrite;
    if (nameInput) nameInput.disabled = !canWrite;
    if (refreshBtn) refreshBtn.disabled = evalFolderBusy;
    if (upBtn) upBtn.disabled = evalFolderBusy || !!atRoot || inTrash;
    if (viewBrowse) viewBrowse.setAttribute("aria-pressed", inTrash ? "false" : "true");
    if (viewTrash) viewTrash.setAttribute("aria-pressed", inTrash ? "true" : "false");
    var toggle = $("btnDriveTreeToggle");
    if (toggle) {
      toggle.setAttribute("aria-expanded", treeMobileOpen ? "true" : "false");
      toggle.textContent = treeMobileOpen ? "收合資料夾導覽" : "展開資料夾導覽";
    }
    syncUploadDestBanner();
    syncBatchBar();
    syncSortControls();
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
    if (browseSearchScope === "club") return true;
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

  function isCoarsePointer() {
    try {
      return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    } catch (_error) {
      return false;
    }
  }

  function sortKeyValue(item, field) {
    if (field === "size") {
      var size = item && item.size;
      if (size == null || size === "") return null;
      var n = Number(size);
      return Number.isFinite(n) ? n : null;
    }
    if (field === "modified") {
      var raw = item && (item.modifiedTime || item.trashedAt);
      if (!raw) return null;
      var ms = Date.parse(String(raw));
      return Number.isFinite(ms) ? ms : null;
    }
    return String((item && item.name) || "").toLowerCase();
  }

  function compareBrowseItems(a, b) {
    var aFolder = a.itemKind === "folder" ? 0 : 1;
    var bFolder = b.itemKind === "folder" ? 0 : 1;
    if (aFolder !== bFolder) return aFolder - bFolder;
    var field = browseSort.field || "name";
    var dir = browseSort.dir === "desc" ? -1 : 1;
    var av = sortKeyValue(a, field);
    var bv = sortKeyValue(b, field);
    if (av == null && bv == null) {
      return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant");
    }
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant");
  }

  function syncSortControls() {
    var select = $("driveBrowserSort");
    var key = String(browseSort.field || "name") + "-" + String(browseSort.dir || "asc");
    if (select && select.value !== key) select.value = key;
    ["name", "size", "modified"].forEach(function (field) {
      var btn = $(
        field === "name" ? "driveSortByName" :
          field === "size" ? "driveSortBySize" : "driveSortByModified"
      );
      if (!btn) return;
      btn.classList.toggle("is-active", browseSort.field === field);
      btn.setAttribute(
        "aria-sort",
        browseSort.field === field
          ? (browseSort.dir === "desc" ? "descending" : "ascending")
          : "none"
      );
    });
  }

  function setBrowseSort(field, dir) {
    browseSort = {
      field: field === "size" || field === "modified" ? field : "name",
      dir: dir === "desc" ? "desc" : "asc"
    };
    persistBrowseSort();
    syncSortControls();
    if (browserViewMode === "trash") {
      renderTrashTable(lastTrashSnapshot || { items: [] });
    } else if (lastBrowseSnapshot) {
      renderBrowserTable(lastBrowseSnapshot);
    }
  }

  function selectionKey(kind, id) {
    return String(kind || "file") + ":" + String(id || "");
  }

  function clearBrowseSelection() {
    selectedBrowseItems = Object.create(null);
    syncBatchBar();
  }

  function selectedItemList() {
    return Object.keys(selectedBrowseItems).map(function (key) {
      return selectedBrowseItems[key];
    }).filter(Boolean);
  }

  function pruneDescendantSelection() {
    var items = selectedItemList();
    var folderIds = Object.create(null);
    items.forEach(function (item) {
      if (item.kind === "folder") folderIds[String(item.id)] = true;
    });
    if (!Object.keys(folderIds).length) return;
    Object.keys(selectedBrowseItems).forEach(function (key) {
      var item = selectedBrowseItems[key];
      if (!item || item.kind !== "file" && item.kind !== "folder") return;
      var parent = String(item.parentFolderId || "");
      var pathIds = Array.isArray(item.pathFolderIds) ? item.pathFolderIds : [];
      var covered = !!folderIds[parent];
      if (!covered) {
        pathIds.forEach(function (fid) {
          if (folderIds[String(fid)]) covered = true;
        });
      }
      if (covered && item.kind === "folder" && folderIds[String(item.id)]) {
        // keep the ancestor folder itself
        return;
      }
      if (covered && !folderIds[String(item.id)]) {
        delete selectedBrowseItems[key];
      }
    });
  }

  function setItemSelected(item, selected) {
    if (!item || !item.id) return;
    var key = selectionKey(item.kind, item.id);
    if (selected) selectedBrowseItems[key] = item;
    else delete selectedBrowseItems[key];
    pruneDescendantSelection();
    syncBatchBar();
  }

  function syncBatchBar() {
    var bar = $("driveBatchBar");
    var countEl = $("driveBatchCount");
    var items = selectedItemList();
    if (countEl) countEl.textContent = "已選 " + items.length + " 項";
    if (!bar) return;
    var show = browserViewMode === "browse" && items.length > 0 && uploadWriteAllowed;
    bar.classList.toggle("hidden", !show);
    var copyBtn = $("btnDriveBatchCopy");
    if (copyBtn) {
      var hasFolder = items.some(function (item) { return item.kind === "folder"; });
      copyBtn.disabled = hasFolder || !items.length;
      copyBtn.title = hasFolder ? "批次複製僅支援檔案（不含整夾）" : "";
    }
  }

  function currentPathFolderIds(data) {
    var path = (data && data.path) || [];
    return path.map(function (step) { return String(step.folderId || ""); }).filter(Boolean);
  }

  function hideContextMenu() {
    if (contextMenuEl && contextMenuEl.parentNode) {
      contextMenuEl.parentNode.removeChild(contextMenuEl);
    }
    contextMenuEl = null;
  }

  function showContextMenuAt(x, y, item) {
    hideContextMenu();
    if (!item) return;
    var menu = document.createElement("div");
    menu.className = "drive-context-menu";
    menu.setAttribute("role", "menu");
    fillItemActionButtons(menu, item, function () {
      hideContextMenu();
    });
    document.body.appendChild(menu);
    var mw = menu.offsetWidth || 168;
    var mh = menu.offsetHeight || 240;
    var left = Math.max(8, Math.min(Number(x) || 0, window.innerWidth - mw - 8));
    var top = Number(y) || 0;
    if (top + mh > window.innerHeight - 8) {
      top = Math.max(8, (Number(y) || 0) - mh);
    }
    if (top + mh > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - mh - 8);
    }
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    contextMenuEl = menu;
  }

  function bindRowContextAndLongPress(tr, item) {
    if (!tr || !item) return;
    tr.addEventListener("contextmenu", function (event) {
      event.preventDefault();
      event.stopPropagation();
      showContextMenuAt(event.clientX, event.clientY, item);
    });
    tr.addEventListener("pointerdown", function (event) {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      longPressStart = { x: event.clientX, y: event.clientY, item: item };
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = setTimeout(function () {
        longPressTimer = null;
        if (!longPressStart || longPressStart.item !== item) return;
        showContextMenuAt(longPressStart.x, longPressStart.y, item);
      }, LONG_PRESS_MS);
    });
    function cancelLongPress(event) {
      if (longPressTimer && longPressStart) {
        var dx = Math.abs((event.clientX || 0) - longPressStart.x);
        var dy = Math.abs((event.clientY || 0) - longPressStart.y);
        if (event.type === "pointermove" && dx < LONG_PRESS_MOVE_PX && dy < LONG_PRESS_MOVE_PX) {
          return;
        }
      }
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = null;
      longPressStart = null;
    }
    tr.addEventListener("pointermove", cancelLongPress);
    tr.addEventListener("pointerup", cancelLongPress);
    tr.addEventListener("pointercancel", cancelLongPress);
  }

  function renderBrowserTable(data) {
    var list = $("driveEvalFolderList");
    var countEl = $("driveBrowserCount");
    var selectAll = $("driveSelectAll");
    if (!list) return { empty: true, folderCount: 0, fileCount: 0 };
    if (browserViewMode === "trash") {
      return renderTrashTable(lastTrashSnapshot || { items: [] });
    }
    var pathFolderIds = currentPathFolderIds(data);
    var folders = ((data && data.folders) || []).filter(function (folder) {
      return matchesBrowseSearch(folder && folder.name);
    }).map(function (folder) {
      return Object.assign({}, folder, {
        itemKind: "folder",
        id: String(folder.folderId || folder.id || ""),
        name: String(folder.name || folder.folderId || folder.id || "")
      });
    });
    var files = ((data && data.files) || []).filter(function (file) {
      return matchesBrowseSearch(file && file.name);
    }).map(function (file) {
      return Object.assign({}, file, {
        itemKind: "file",
        id: String(file.fileId || file.id || ""),
        name: String(file.name || file.fileId || file.id || "（未命名）"),
        parentFolderId: String(file.parentFolderId || currentBrowseParentId() || "")
      });
    });
    var rows = folders.concat(files).sort(compareBrowseItems);
    list.replaceChildren();
    rows.forEach(function (row) {
      if (!row.id) return;
      if (row.itemKind === "folder") {
        var id = row.id;
        var tr = document.createElement("tr");
        tr.className = "is-folder";
        tr.dataset.folderId = String(id);
        var folderItem = {
          kind: "folder",
          id: String(id),
          name: String(row.name || id),
          parentFolderId: String(currentBrowseParentId() || ""),
          pathFolderIds: pathFolderIds.slice()
        };
        var checkTd = document.createElement("td");
        checkTd.className = "drive-col-check";
        checkTd.setAttribute("data-label", "選取");
        var check = document.createElement("input");
        check.type = "checkbox";
        check.setAttribute("aria-label", "選取資料夾 " + folderItem.name);
        check.checked = !!selectedBrowseItems[selectionKey("folder", id)];
        if (check.checked) tr.classList.add("is-selected");
        check.addEventListener("click", function (event) { event.stopPropagation(); });
        check.addEventListener("change", function () {
          setItemSelected(folderItem, check.checked);
          tr.classList.toggle("is-selected", check.checked);
        });
        checkTd.appendChild(check);
        tr.appendChild(checkTd);
        var nameTd = document.createElement("td");
        var nameWrap = document.createElement("div");
        nameWrap.className = "drive-cell-name";
        var ico = document.createElement("span");
        ico.className = "drive-ico-folder";
        ico.setAttribute("aria-hidden", "true");
        var nameText = document.createElement("span");
        nameText.className = "name-text";
        nameText.textContent = String(row.name || id);
        nameWrap.appendChild(ico);
        nameWrap.appendChild(nameText);
        nameTd.appendChild(nameWrap);
        tr.appendChild(nameTd);
        appendTableCell(tr, "—", "drive-table-meta", "大小");
        appendTableCell(
          tr,
          row.modifiedTime ? formatTaipeiDateTime(row.modifiedTime) : "—",
          "drive-table-meta",
          "更新時間"
        );
        var actionTd = document.createElement("td");
        actionTd.setAttribute("data-label", "操作");
        var actions = document.createElement("div");
        actions.className = "drive-file-actions";
        var openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "drive-table-action";
        openBtn.textContent = "開啟 →";
        openBtn.addEventListener("click", function (event) {
          event.stopPropagation();
          openBrowseFolder(String(id), true);
        });
        actions.appendChild(openBtn);
        actions.appendChild(buildItemActionMenu(folderItem));
        actionTd.appendChild(actions);
        tr.appendChild(actionTd);
        tr.addEventListener("click", function (event) {
          if (event.target && event.target.closest && event.target.closest("input,button,details,a,summary")) {
            return;
          }
          openBrowseFolder(String(id), true);
        });
        bindFolderDropTarget(tr, String(id), String(row.name || id));
        bindRowContextAndLongPress(tr, folderItem);
        list.appendChild(tr);
        return;
      }
      var fileId = row.id;
      var trFile = document.createElement("tr");
      trFile.className = "is-file";
      trFile.dataset.fileId = fileId;
      var fileItem = {
        kind: "file",
        id: fileId,
        fileId: fileId,
        name: String(row.name || fileId),
        parentFolderId: String(row.parentFolderId || currentBrowseParentId() || ""),
        pathFolderIds: pathFolderIds.slice()
      };
      var checkTdFile = document.createElement("td");
      checkTdFile.className = "drive-col-check";
      checkTdFile.setAttribute("data-label", "選取");
      var checkFile = document.createElement("input");
      checkFile.type = "checkbox";
      checkFile.setAttribute("aria-label", "選取檔案 " + fileItem.name);
      checkFile.checked = !!selectedBrowseItems[selectionKey("file", fileId)];
      if (checkFile.checked) trFile.classList.add("is-selected");
      checkFile.addEventListener("click", function (event) { event.stopPropagation(); });
      checkFile.addEventListener("change", function () {
        setItemSelected(fileItem, checkFile.checked);
        trFile.classList.toggle("is-selected", checkFile.checked);
      });
      checkTdFile.appendChild(checkFile);
      trFile.appendChild(checkTdFile);
      var nameTdFile = document.createElement("td");
      var nameWrapFile = document.createElement("div");
      nameWrapFile.className = "drive-cell-name";
      var icoFile = document.createElement("span");
      icoFile.className = "drive-ico-pdf";
      icoFile.setAttribute("aria-hidden", "true");
      icoFile.textContent = "PDF";
      var nameTextFile = document.createElement("span");
      nameTextFile.className = "name-text";
      nameTextFile.textContent = String(row.name || fileId || "（未命名）");
      nameWrapFile.appendChild(icoFile);
      nameWrapFile.appendChild(nameTextFile);
      nameTdFile.appendChild(nameWrapFile);
      trFile.appendChild(nameTdFile);
      appendTableCell(trFile, formatSizeCell(row.size), "drive-table-meta", "大小");
      appendTableCell(
        trFile,
        row.modifiedTime ? formatTaipeiDateTime(row.modifiedTime) : "—",
        "drive-table-meta",
        "更新時間"
      );
      var actionTdFile = document.createElement("td");
      actionTdFile.setAttribute("data-label", "操作");
      var actionsFile = document.createElement("div");
      actionsFile.className = "drive-file-actions";
      actionsFile.appendChild(buildItemActionMenu(fileItem));
      actionTdFile.appendChild(actionsFile);
      trFile.appendChild(actionTdFile);
      if (!isCoarsePointer()) {
        bindFileDragSource(trFile, {
          fileId: fileId,
          name: fileItem.name,
          parentFolderId: fileItem.parentFolderId
        });
      } else {
        trFile.draggable = false;
      }
      bindRowContextAndLongPress(trFile, fileItem);
      list.appendChild(trFile);
    });
    if (selectAll) {
      var visibleKeys = rows.map(function (row) {
        return selectionKey(row.itemKind, row.id);
      });
      selectAll.checked = visibleKeys.length > 0 &&
        visibleKeys.every(function (key) { return !!selectedBrowseItems[key]; });
      selectAll.indeterminate = !selectAll.checked &&
        visibleKeys.some(function (key) { return !!selectedBrowseItems[key]; });
    }
    if (countEl) {
      countEl.textContent =
        folders.length + " 個資料夾　·　" + files.length + " 個檔案";
    }
    syncBatchBar();
    syncSortControls();
    return {
      empty: folders.length + files.length === 0,
      folderCount: folders.length,
      fileCount: files.length
    };
  }

  var lastTrashSnapshot = null;

  function renderTrashTable(data) {
    var list = $("driveEvalFolderList");
    var countEl = $("driveBrowserCount");
    var selectAll = $("driveSelectAll");
    if (!list) return { empty: true, folderCount: 0, fileCount: 0 };
    lastTrashSnapshot = data || { items: [] };
    var items = ((data && data.items) || []).slice().map(function (item) {
      return Object.assign({}, item, {
        itemKind: item.kind === "folder" ? "folder" : "file",
        id: String(item.itemId || item.id || ""),
        name: String(item.name || item.itemId || "")
      });
    }).sort(compareBrowseItems);
    list.replaceChildren();
    if (selectAll) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
      selectAll.disabled = true;
    }
    items.forEach(function (item) {
      if (!item.id) return;
      var tr = document.createElement("tr");
      tr.className = item.itemKind === "folder" ? "is-folder" : "is-file";
      var checkTd = document.createElement("td");
      checkTd.className = "drive-col-check";
      checkTd.textContent = "";
      tr.appendChild(checkTd);
      var nameTd = document.createElement("td");
      var nameWrap = document.createElement("div");
      nameWrap.className = "drive-cell-name";
      var ico = document.createElement("span");
      ico.className = item.itemKind === "folder" ? "drive-ico-folder" : "drive-ico-pdf";
      if (item.itemKind !== "folder") ico.textContent = "PDF";
      ico.setAttribute("aria-hidden", "true");
      var nameText = document.createElement("span");
      nameText.className = "name-text";
      nameText.textContent = item.name || item.id;
      nameWrap.appendChild(ico);
      nameWrap.appendChild(nameText);
      nameTd.appendChild(nameWrap);
      if (item.pathLabel) {
        var path = document.createElement("div");
        path.className = "hit-path";
        path.textContent = String(item.pathLabel);
        nameTd.appendChild(path);
      }
      tr.appendChild(nameTd);
      appendTableCell(tr, formatSizeCell(item.size), "drive-table-meta", "大小");
      appendTableCell(
        tr,
        item.trashedAt ? formatTaipeiDateTime(item.trashedAt) : "—",
        "drive-table-meta",
        "刪除時間"
      );
      var actionTd = document.createElement("td");
      actionTd.setAttribute("data-label", "操作");
      var restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "drive-table-action";
      restoreBtn.textContent = "還原";
      restoreBtn.disabled = !uploadWriteAllowed || fileOpBusy;
      restoreBtn.addEventListener("click", function (event) {
        event.stopPropagation();
        requestRestoreItem(item);
      });
      actionTd.appendChild(restoreBtn);
      tr.appendChild(actionTd);
      list.appendChild(tr);
    });
    if (countEl) countEl.textContent = items.length + " 個垃圾桶項目";
    return { empty: items.length === 0, folderCount: 0, fileCount: items.length };
  }

  function ensurePathExpanded(path) {
    (path || []).forEach(function (step) {
      var id = String((step && step.folderId) || "");
      if (id) treeExpandedIds[id] = true;
    });
    if (browseClubFolderId) treeExpandedIds[browseClubFolderId] = true;
  }

  function loadTreeChildren(folderId, forceNetwork) {
    var key = cacheKeyForFolderId(folderId);
    if (!forceNetwork && evalFoldersCacheValid(evalFoldersByParent[key], key)) {
      renderSidebarTree();
      return Promise.resolve(evalFoldersByParent[key]);
    }
    if (treeLoadInflight[key] && !forceNetwork) return treeLoadInflight[key];
    var body = {};
    if (key) body.parentFolderId = key;
    var pending = call("listClubEvaluationFolders", body).then(function (result) {
      var data = (result && result.data) || {};
      rememberEvalFolders(data, key);
      delete treeLoadErrors[key];
      renderSidebarTree();
      return data;
    }).catch(function (error) {
      treeLoadErrors[key] = errorInfo(error);
      renderSidebarTree();
      return null;
    }).finally(function () {
      if (treeLoadInflight[key] && treeLoadInflight[key] === pending) {
        delete treeLoadInflight[key];
      }
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
    renderSidebarTree();
    loadTreeChildren(id, false);
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
    var childKey = cacheKeyForFolderId(id);
    var cache = evalFoldersByParent[childKey];
    var hasCache = !!cache;
    var childFolders = (cache && cache.folders) || [];
    var knownEmpty = hasCache && childFolders.length === 0;
    var expanded = !!treeExpandedIds[id];
    var loading = !!treeLoadInflight[childKey];
    var loadError = treeLoadErrors[childKey] || null;
    var expand = document.createElement("button");
    expand.type = "button";
    expand.className = "drive-tree-expand";
    if (knownEmpty && !loading) {
      expand.textContent = "·";
      expand.disabled = true;
      expand.setAttribute("aria-label", "無子資料夾");
    } else {
      expand.textContent = expanded ? "▾" : "▸";
      expand.setAttribute("aria-label", expanded ? "收合" : "展開");
      expand.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        toggleTreeExpand(id);
      });
    }
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
    openBtn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      openBrowseFolder(id === browseClubFolderId ? "" : id, true);
    });
    row.appendChild(expand);
    row.appendChild(openBtn);
    bindFolderDropTarget(row, id, String((folder && folder.name) || id));
    li.appendChild(row);
    if (expanded) {
      var childUl = document.createElement("ul");
      if (loading && !hasCache) {
        var loadingLi = document.createElement("li");
        loadingLi.className = "drive-tree-status";
        loadingLi.textContent = "載入中…";
        childUl.appendChild(loadingLi);
      } else if (loadError && !hasCache) {
        var errLi = document.createElement("li");
        errLi.className = "drive-tree-status";
        var retry = document.createElement("button");
        retry.type = "button";
        retry.className = "drive-table-action";
        retry.textContent = "載入失敗，重試";
        retry.addEventListener("click", function (event) {
          event.preventDefault();
          event.stopPropagation();
          loadTreeChildren(id, true);
        });
        errLi.appendChild(retry);
        childUl.appendChild(errLi);
      } else if (knownEmpty) {
        var emptyLi = document.createElement("li");
        emptyLi.className = "drive-tree-status";
        emptyLi.textContent = "（無子資料夾）";
        childUl.appendChild(emptyLi);
      } else {
        childFolders.forEach(function (child) {
          renderTreeNode(childUl, child, depth + 1);
        });
        if (!hasCache && !loading) {
          loadTreeChildren(id, false);
          var pendingLi = document.createElement("li");
          pendingLi.className = "drive-tree-status";
          pendingLi.textContent = "載入中…";
          childUl.appendChild(pendingLi);
        }
      }
      li.appendChild(childUl);
    }
    parentUl.appendChild(li);
  }

  function renderSidebarTree() {
    var tree = $("driveFolderTree");
    if (!tree) return;
    tree.replaceChildren();
    if (!browseClubFolderId) return;
    var clubName =
      (serverCtx && serverCtx.clubName) ||
      (lastBrowseSnapshot && lastBrowseSnapshot.clubName) ||
      "社團評選資料夾";
    var root = {
      folderId: browseClubFolderId,
      name: clubName
    };
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
    var tableState = renderBrowserTable(data);
    renderSidebarTree();
    return tableState;
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
    // Root browse uses "" as cache key (see cacheKeyForFolderId); do not fall
    // through to clubFolderId or parentFolderId or the sidebar will miss the hit.
    rememberEvalFolders(data, parentKey);
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

  function invalidateFolderCaches(folderIds) {
    (folderIds || []).forEach(function (folderId) {
      var key = cacheKeyForFolderId(folderId);
      delete evalFoldersByParent[key];
      delete treeLoadErrors[key];
    });
  }

  function hideFileActionConfirm() {
    pendingFileAction = null;
    var box = $("driveFileActionConfirm");
    if (box) box.classList.add("hidden");
  }

  function hideFolderPicker() {
    folderPickerState = null;
    var box = $("driveFolderPicker");
    if (box) box.classList.add("hidden");
    var list = $("driveFolderPickerList");
    if (list) list.replaceChildren();
    var crumbs = $("driveFolderPickerCrumbs");
    if (crumbs) crumbs.replaceChildren();
  }

  function hideRenameDialog() {
    pendingRename = null;
    var box = $("driveRenameDialog");
    if (box) box.classList.add("hidden");
  }

  function showFileActionConfirm(action) {
    pendingFileAction = action;
    var box = $("driveFileActionConfirm");
    var title = $("driveFileActionTitle");
    var detail = $("driveFileActionDetail");
    var confirmBtn = $("btnDriveFileActionConfirm");
    if (!box || !detail) return;
    var itemKind = action.itemKind || (action.folderId && !action.fileId ? "folder" : "file");
    var labels = {
      trash: itemKind === "folder" ? "確認刪除資料夾（移入垃圾桶）" : "確認刪除（移入垃圾桶）",
      move: "確認移動",
      copy: "確認複製",
      rename: "確認重新命名",
      restore: "確認還原"
    };
    if (title) title.textContent = labels[action.kind] || "確認操作";
    if (confirmBtn) {
      if (action.kind === "trash") {
        confirmBtn.textContent = action.confirmReplace ? "確認取代並刪除" : "確認刪除";
      } else if (action.confirmReplace) {
        confirmBtn.textContent = "確認取代並繼續";
      } else {
        confirmBtn.textContent = "確認";
      }
    }
    detail.replaceChildren();
    function addLine(text, strong) {
      var p = document.createElement("p");
      p.style.margin = "0 0 6px";
      if (strong) {
        var b = document.createElement("strong");
        b.textContent = text;
        p.appendChild(b);
      } else {
        p.textContent = text;
      }
      detail.appendChild(p);
    }
    var displayName = action.fileName || action.folderName || action.name || "（未命名）";
    addLine((itemKind === "folder" ? "資料夾：" : "檔名：") + displayName, true);
    if (action.kind === "trash") {
      addLine("所在路徑：" + (action.fromPath || browsePathLabel || "社團評選資料夾"));
      if (itemKind === "folder") {
        addLine("注意：此資料夾及其子層內容可能一併移入垃圾桶；其下已完成登錄的繳交之後可能不再算有效繳交。");
      } else {
        addLine("將移入垃圾桶；取消則保留原檔。");
      }
    } else if (action.kind === "restore") {
      addLine("還原後會嘗試放回原路徑或最近可用祖先。");
      if (action.confirmReplace) {
        addLine("目的地已有同名項目，確認後才會處理衝突。");
      }
    } else {
      addLine("來源路徑：" + (action.fromPath || browsePathLabel || "社團評選資料夾"));
      addLine("目的路徑：" + (action.toPath || action.destinationFolderId || ""));
      if (action.confirmReplace) {
        addLine("目的地已有同名項目，確認後才會取代；取消則保留雙方原內容。");
      } else if (action.kind === "move") {
        addLine(itemKind === "folder"
          ? "移動資料夾會保留同一 folderId 與子項識別。"
          : "移動會保留同一 fileId，並更新位置與相關紀錄。");
      } else if (action.kind === "copy") {
        addLine("複製會產生新 fileId；僅在後端驗證並登錄成功後才更新有效繳交。");
      }
    }
    if (action.batchItems && action.batchItems.length > 1) {
      addLine("批次項目數：" + action.batchItems.length);
    }
    box.classList.remove("hidden");
    hideFolderPicker();
    hideRenameDialog();
  }

  function clubRootLabel() {
    return (serverCtx && serverCtx.clubName) ||
      (lastBrowseSnapshot && lastBrowseSnapshot.clubName) ||
      "社團評選資料夾";
  }

  function pickerCacheKey(folderId) {
    var id = String(folderId || "");
    if (!id || (browseClubFolderId && id === browseClubFolderId)) return "";
    return id;
  }

  function renderFolderPicker() {
    var box = $("driveFolderPicker");
    var list = $("driveFolderPickerList");
    var hint = $("driveFolderPickerHint");
    var crumbs = $("driveFolderPickerCrumbs");
    var confirmBtn = $("btnDriveFolderPickerConfirm");
    var upBtn = $("btnDriveFolderPickerUp");
    if (!box || !list || !folderPickerState) return;
    var state = folderPickerState;
    var currentId = String(state.currentFolderId || "");
    var atRoot = !currentId || (browseClubFolderId && currentId === browseClubFolderId);
    if (hint) {
      var label = state.fileName || state.folderName ||
        (state.batchItems && state.batchItems.length
          ? (state.batchItems.length + " 個項目")
          : "項目");
      hint.textContent =
        (state.kind === "move" ? "移動「" : "複製「") + label + "」：請進入目的資料夾後按確認。";
    }
    if (confirmBtn) {
      confirmBtn.textContent = state.kind === "copy" ? "複製到這裡" : "移動到這裡";
      confirmBtn.disabled = false;
    }
    if (upBtn) upBtn.disabled = !!atRoot;
    if (crumbs) {
      crumbs.replaceChildren();
      var rootBtn = document.createElement("button");
      rootBtn.type = "button";
      rootBtn.textContent = clubRootLabel();
      rootBtn.disabled = !!atRoot && !(state.path && state.path.length);
      rootBtn.addEventListener("click", function () {
        enterFolderPickerFolder("");
      });
      crumbs.appendChild(rootBtn);
      (state.path || []).forEach(function (step, index) {
        var sep = document.createElement("span");
        sep.className = "crumb-sep";
        sep.textContent = ">";
        crumbs.appendChild(sep);
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = step.name || step.folderId || "資料夾";
        var isLast = index === state.path.length - 1;
        btn.disabled = isLast;
        btn.addEventListener("click", function () {
          enterFolderPickerFolder(String(step.folderId || ""));
        });
        crumbs.appendChild(btn);
      });
    }
    list.replaceChildren();
    var loading = document.createElement("li");
    loading.textContent = "載入中…";
    list.appendChild(loading);
    var key = pickerCacheKey(currentId);
    var body = {};
    if (key) body.parentFolderId = key;
    call("listClubEvaluationFolders", body).then(function (result) {
      if (!folderPickerState || folderPickerState !== state) return;
      var data = (result && result.data) || {};
      rememberEvalFolders(data, key);
      state.path = (data.path || []).slice();
      state.currentFolderId = String(data.parentFolderId || browseClubFolderId || "");
      state.currentPathLabel = pathLabelFromPayload(data);
      list.replaceChildren();
      var folders = (data.folders || []).slice();
      if (crumbs) {
        crumbs.replaceChildren();
        var rootBtn2 = document.createElement("button");
        rootBtn2.type = "button";
        rootBtn2.textContent = clubRootLabel();
        var atRoot2 = !state.currentFolderId ||
          (browseClubFolderId && state.currentFolderId === browseClubFolderId);
        rootBtn2.disabled = !!atRoot2 && !(state.path && state.path.length);
        rootBtn2.addEventListener("click", function () {
          enterFolderPickerFolder("");
        });
        crumbs.appendChild(rootBtn2);
        (state.path || []).forEach(function (step, index) {
          var sep2 = document.createElement("span");
          sep2.className = "crumb-sep";
          sep2.textContent = ">";
          crumbs.appendChild(sep2);
          var btn2 = document.createElement("button");
          btn2.type = "button";
          btn2.textContent = step.name || step.folderId || "資料夾";
          btn2.disabled = index === state.path.length - 1;
          btn2.addEventListener("click", function () {
            enterFolderPickerFolder(String(step.folderId || ""));
          });
          crumbs.appendChild(btn2);
        });
      }
      if (!folders.length) {
        var empty = document.createElement("li");
        empty.textContent = "此層沒有子資料夾。可直接「到這裡」確認。";
        list.appendChild(empty);
      } else {
        folders.forEach(function (folder) {
          var id = String((folder && (folder.folderId || folder.id)) || "");
          if (!id) return;
          if (state.itemKind === "folder" && String(state.folderId) === id) return;
          var item = document.createElement("li");
          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "drive-folder-picker-item";
          btn.textContent = "進入：" + String((folder && folder.name) || id);
          btn.addEventListener("click", function () {
            enterFolderPickerFolder(id);
          });
          item.appendChild(btn);
          list.appendChild(item);
        });
      }
    }).catch(function (error) {
      if (!folderPickerState || folderPickerState !== state) return;
      list.replaceChildren();
      var err = document.createElement("li");
      err.textContent = "載入失敗：" + friendlyGateMessage(errorInfo(error));
      list.appendChild(err);
    });
    box.classList.remove("hidden");
    hideFileActionConfirm();
    hideRenameDialog();
  }

  function enterFolderPickerFolder(folderId) {
    if (!folderPickerState) return;
    folderPickerState.currentFolderId =
      String(folderId || "") === String(browseClubFolderId || "")
        ? ""
        : String(folderId || "");
    renderFolderPicker();
  }

  function confirmFolderPickerDestination() {
    if (!folderPickerState) return;
    var state = folderPickerState;
    var destId = String(state.currentFolderId || browseClubFolderId || "");
    if (!destId) {
      setEvalFolderStatus("尚未選到有效目的資料夾。", "warn");
      return;
    }
    if (String(destId) === String(state.parentFolderId || "") &&
      !(state.batchItems && state.batchItems.length)) {
      setEvalFolderStatus("目的地與來源相同。", "warn");
      return;
    }
    hideFolderPicker();
    var confirmAction = {
      kind: state.kind,
      itemKind: state.itemKind || "file",
      fileId: state.fileId,
      folderId: state.folderId,
      fileName: state.fileName,
      folderName: state.folderName,
      parentFolderId: state.parentFolderId,
      fromPath: state.fromPath || browsePathLabel,
      destinationFolderId: destId,
      toPath: state.currentPathLabel || clubRootLabel(),
      confirmReplace: false,
      batchItems: state.batchItems || null
    };
    showFileActionConfirm(confirmAction);
  }

  function openFolderPicker(action) {
    folderPickerState = {
      kind: action.kind,
      itemKind: action.itemKind || (action.folderId ? "folder" : "file"),
      fileId: action.fileId,
      folderId: action.folderId,
      fileName: action.fileName,
      folderName: action.folderName,
      parentFolderId: action.parentFolderId,
      fromPath: action.fromPath || browsePathLabel,
      batchItems: action.batchItems || null,
      currentFolderId: String(browseClubFolderId || ""),
      path: [],
      currentPathLabel: clubRootLabel()
    };
    renderFolderPicker();
  }

  function fillItemActionButtons(panel, item, onDone) {
    function addItem(label, className, handler) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      if (className) btn.className = className;
      btn.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof onDone === "function") onDone();
        handler();
      });
      panel.appendChild(btn);
    }
    var isFolder = item.kind === "folder";
    if (!isFolder) {
      addItem("預覽 PDF", "", function () {
        openPdfPreview(item);
      });
    }
    addItem("重新命名", "", function () {
      openRenameDialog(item);
    });
    addItem("刪除", "danger", function () {
      requestTrashItem(item);
    });
    addItem("移動至…", "", function () {
      openFolderPicker({
        kind: "move",
        itemKind: item.kind,
        fileId: isFolder ? undefined : item.id,
        folderId: isFolder ? item.id : undefined,
        fileName: isFolder ? undefined : item.name,
        folderName: isFolder ? item.name : undefined,
        parentFolderId: item.parentFolderId,
        fromPath: browsePathLabel
      });
    });
    if (!isFolder) {
      addItem("複製至…", "", function () {
        openFolderPicker({
          kind: "copy",
          itemKind: "file",
          fileId: item.id,
          fileName: item.name,
          parentFolderId: item.parentFolderId,
          fromPath: browsePathLabel
        });
      });
    }
  }

  function buildItemActionMenu(item) {
    var wrap = document.createElement("div");
    wrap.className = "drive-file-menu";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "drive-table-action";
    btn.setAttribute("aria-haspopup", "menu");
    btn.textContent = "操作";
    btn.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      var rect = btn.getBoundingClientRect();
      // Open as a body-level popover so table overflow cannot clip options.
      showContextMenuAt(rect.right - 160, rect.bottom + 4, item);
    });
    wrap.appendChild(btn);
    return wrap;
  }

  /** @deprecated use buildItemActionMenu */
  function buildFileActionMenu(file) {
    return buildItemActionMenu({
      kind: "file",
      id: file.fileId || file.id,
      fileId: file.fileId || file.id,
      name: file.name,
      parentFolderId: file.parentFolderId
    });
  }

  function bindFileDragSource(el, file) {
    if (!el || !file || !file.fileId) return;
    el.draggable = true;
    el.addEventListener("dragstart", function (event) {
      if (!uploadWriteAllowed) {
        event.preventDefault();
        return;
      }
      dragFilePayload = {
        fileId: file.fileId,
        name: file.name,
        parentFolderId: file.parentFolderId
      };
      try {
        event.dataTransfer.setData(
          "application/x-hksp-drive-file",
          JSON.stringify(dragFilePayload)
        );
        event.dataTransfer.effectAllowed = "copyMove";
      } catch (_error) {}
    });
    el.addEventListener("dragend", function () {
      dragFilePayload = null;
      clearDropTargetHighlights();
    });
  }

  function clearDropTargetHighlights() {
    try {
      var nodes = document.querySelectorAll
        ? document.querySelectorAll(".is-drop-target")
        : [];
      Array.prototype.forEach.call(nodes, function (node) {
        node.classList.remove("is-drop-target");
      });
    } catch (_error) {}
  }

  function bindFolderDropTarget(el, folderId, folderName) {
    if (!el || !folderId) return;
    el.addEventListener("dragenter", function (event) {
      if (!dragFilePayload || !uploadWriteAllowed) return;
      event.preventDefault();
      el.classList.add("is-drop-target");
    });
    el.addEventListener("dragover", function (event) {
      if (!dragFilePayload || !uploadWriteAllowed) return;
      event.preventDefault();
      try {
        event.dataTransfer.dropEffect = event.shiftKey ? "copy" : "move";
      } catch (_error) {}
      el.classList.add("is-drop-target");
    });
    el.addEventListener("dragleave", function () {
      el.classList.remove("is-drop-target");
    });
    el.addEventListener("drop", function (event) {
      event.preventDefault();
      event.stopPropagation();
      el.classList.remove("is-drop-target");
      var payload = dragFilePayload;
      if (!payload || !uploadWriteAllowed) return;
      if (String(payload.parentFolderId || "") === String(folderId)) {
        setEvalFolderStatus("檔案已在此資料夾。", "warn");
        return;
      }
      var kind = event.shiftKey ? "copy" : "move";
      var clubName =
        (serverCtx && serverCtx.clubName) ||
        (lastBrowseSnapshot && lastBrowseSnapshot.clubName) ||
        "社團評選資料夾";
      var toPath =
        String(folderId) === String(browseClubFolderId)
          ? clubName
          : (browsePathLabel ? browsePathLabel + " / " : "") + String(folderName || folderId);
      showFileActionConfirm({
        kind: kind,
        fileId: payload.fileId,
        fileName: payload.name,
        parentFolderId: payload.parentFolderId,
        fromPath: browsePathLabel,
        destinationFolderId: folderId,
        toPath: toPath,
        confirmReplace: false
      });
    });
  }

  function requestTrashFile(file) {
    requestTrashItem({
      kind: "file",
      id: file.fileId || file.id,
      fileId: file.fileId || file.id,
      name: file.name,
      parentFolderId: file.parentFolderId
    });
  }

  function requestTrashItem(item) {
    if (!uploadWriteAllowed) {
      setEvalFolderStatus("目前為唯讀狀態，無法刪除。", "warn");
      return;
    }
    if (!item || !item.id) return;
    var isFolder = item.kind === "folder";
    showFileActionConfirm({
      kind: "trash",
      itemKind: isFolder ? "folder" : "file",
      fileId: isFolder ? undefined : item.id,
      folderId: isFolder ? item.id : undefined,
      fileName: isFolder ? undefined : item.name,
      folderName: isFolder ? item.name : undefined,
      parentFolderId: item.parentFolderId,
      fromPath: browsePathLabel,
      confirmReplace: false
    });
  }

  function requestRestoreItem(item) {
    if (!uploadWriteAllowed) {
      setEvalFolderStatus("目前為唯讀狀態，無法還原。", "warn");
      return;
    }
    if (!item || !item.id) return;
    showFileActionConfirm({
      kind: "restore",
      itemKind: item.itemKind || item.kind || "file",
      itemId: item.id,
      fileName: item.name,
      folderName: item.kind === "folder" ? item.name : undefined,
      parentFolderId: item.parentFolderId,
      confirmReplace: false
    });
  }

  function openRenameDialog(item) {
    if (!uploadWriteAllowed) {
      setEvalFolderStatus("目前為唯讀狀態，無法重新命名。", "warn");
      return;
    }
    if (!item || !item.id) return;
    pendingRename = {
      kind: item.kind === "folder" ? "folder" : "file",
      id: item.id,
      name: item.name || "",
      parentFolderId: item.parentFolderId
    };
    var box = $("driveRenameDialog");
    var input = $("driveRenameInput");
    var title = $("driveRenameTitle");
    if (title) {
      title.textContent = pendingRename.kind === "folder" ? "重新命名資料夾" : "重新命名檔案";
    }
    if (input) {
      var seed = String(pendingRename.name || "");
      if (pendingRename.kind === "file") seed = seed.replace(/\.pdf$/i, "");
      input.value = seed;
    }
    if (box) box.classList.remove("hidden");
    hideFileActionConfirm();
    hideFolderPicker();
    if (input) {
      input.focus();
      input.select();
    }
  }

  function confirmRename() {
    if (!pendingRename || fileOpBusy) return;
    if (!uploadWriteAllowed) {
      setEvalFolderStatus("目前為唯讀狀態，無法重新命名。", "warn");
      return;
    }
    var input = $("driveRenameInput");
    var nextName = input && input.value ? String(input.value).trim() : "";
    if (!nextName) {
      setEvalFolderStatus("請輸入新名稱。", "warn");
      return;
    }
    var action = {
      kind: "rename",
      itemKind: pendingRename.kind,
      fileId: pendingRename.kind === "file" ? pendingRename.id : undefined,
      folderId: pendingRename.kind === "folder" ? pendingRename.id : undefined,
      fileName: pendingRename.kind === "file" ? nextName : undefined,
      folderName: pendingRename.kind === "folder" ? nextName : undefined,
      name: nextName,
      parentFolderId: pendingRename.parentFolderId
    };
    hideRenameDialog();
    runSingleFileOp(action).then(function (outcome) {
      if (!outcome) return;
      if (outcome.replaceRequired) return;
      setEvalFolderStatus("已重新命名。", "ok");
    });
  }

  function previewEndpointUrl(fileId) {
    var projectId = "";
    try {
      projectId = String((firebase.app().options && firebase.app().options.projectId) || "");
    } catch (_error) {
      projectId = "";
    }
    if (!projectId) throw new Error("尚未載入 Firebase 專案，無法預覽。");
    return "https://asia-east1-" + projectId +
      ".cloudfunctions.net/hkspEvalFilePreview?fileId=" + encodeURIComponent(fileId);
  }

  function closePdfPreview() {
    var box = $("drivePdfPreview");
    var frame = $("drivePdfPreviewFrame");
    var status = $("drivePdfPreviewStatus");
    if (frame) frame.removeAttribute("src");
    if (pdfPreviewBlobUrl) {
      try { URL.revokeObjectURL(pdfPreviewBlobUrl); } catch (_error) {}
      pdfPreviewBlobUrl = null;
    }
    if (status) {
      status.className = "msg";
      status.textContent = "";
    }
    if (box) box.classList.add("hidden");
  }

  function openPdfPreview(item) {
    var fileId = String((item && (item.id || item.fileId)) || "");
    if (!fileId) return;
    var box = $("drivePdfPreview");
    var frame = $("drivePdfPreviewFrame");
    var status = $("drivePdfPreviewStatus");
    var title = $("drivePdfPreviewTitle");
    if (!box || !frame) {
      setEvalFolderStatus("預覽介面尚未就緒。", "error");
      return;
    }
    closePdfPreview();
    if (title) title.textContent = "預覽：" + String((item && item.name) || fileId);
    if (status) {
      status.className = "msg warn";
      status.textContent = "正在載入預覽…";
    }
    box.classList.remove("hidden");
    var user = null;
    try { user = firebase.auth().currentUser; } catch (_error) { user = null; }
    if (!user || typeof user.getIdToken !== "function") {
      if (status) {
        status.className = "msg error";
        status.textContent = "需要登入才能預覽。";
      }
      return;
    }
    user.getIdToken().then(function (token) {
      return fetch(previewEndpointUrl(fileId), {
        method: "GET",
        headers: { Authorization: "Bearer " + token },
        credentials: "omit",
        cache: "no-store"
      });
    }).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (body) {
          var msg = (body && (body.message || body.error)) ||
            ("預覽失敗（HTTP " + response.status + "）");
          throw new Error(msg);
        });
      }
      return response.blob();
    }).then(function (blob) {
      pdfPreviewBlobUrl = URL.createObjectURL(blob);
      frame.src = pdfPreviewBlobUrl;
      if (status) {
        status.className = "msg ok";
        status.textContent = "可用瀏覽器內建控件縮放／翻頁。關閉後仍停留在目前資料夾。";
      }
    }).catch(function (error) {
      if (status) {
        status.className = "msg error";
        status.textContent = String((error && error.message) || "預覽失敗。");
      }
    });
  }

  function setBrowserViewMode(mode) {
    var next = mode === "trash" ? "trash" : "browse";
    if (browserViewMode === "browse" && next === "trash") {
      priorBrowseFolderId = String(selectedEvalFolderId || "");
    }
    browserViewMode = next;
    clearBrowseSelection();
    hideContextMenu();
    hideFolderPicker();
    hideRenameDialog();
    hideFileActionConfirm();
    var searchResults = $("driveSearchResults");
    if (searchResults && next === "trash") searchResults.classList.add("hidden");
    syncEvalFolderPanel();
    if (next === "trash") {
      return refreshTrashView(true);
    }
    selectedEvalFolderId = String(priorBrowseFolderId || "");
    return refreshEvalFolders({ gen: generation, op: operationSeq, uid: boundUid }, true);
  }

  function refreshTrashView(force) {
    if (browserViewMode !== "trash") return Promise.resolve(null);
    evalFolderBusy = true;
    syncEvalFolderPanel();
    setBrowserState("loading", "正在載入垃圾桶…");
    setEvalFolderStatus("正在載入垃圾桶…", "warn");
    return call("listClubEvaluationTrash", {}).then(function (result) {
      if (browserViewMode !== "trash") return null;
      var data = (result && result.data) || { items: [] };
      setBrowserState("", "");
      var rendered = renderTrashTable(data);
      if (rendered.empty) {
        setEvalFolderStatus("垃圾桶目前沒有項目。", "ok");
      } else {
        setEvalFolderStatus("僅顯示本社校內垃圾桶索引且仍在 Drive 垃圾桶中的項目。", "ok");
      }
      return data;
    }).catch(function (error) {
      if (browserViewMode !== "trash") return null;
      setBrowserState("error", "讀取垃圾桶失敗：" + friendlyGateMessage(errorInfo(error)));
      setEvalFolderStatus("讀取垃圾桶失敗：" + friendlyGateMessage(errorInfo(error)), "error");
      return null;
    }).then(function (data) {
      evalFolderBusy = false;
      syncEvalFolderPanel();
      return data;
    });
  }

  function hideClubSearchResults() {
    clubSearchResults = null;
    var box = $("driveSearchResults");
    if (box) {
      box.classList.add("hidden");
      box.replaceChildren();
    }
  }

  function renderClubSearchResults(data) {
    var box = $("driveSearchResults");
    if (!box) return;
    clubSearchResults = data;
    box.replaceChildren();
    var items = (data && data.items) || [];
    if (!items.length) {
      var empty = document.createElement("p");
      empty.style.margin = "0";
      empty.textContent = "沒有符合的項目。";
      box.appendChild(empty);
      box.classList.remove("hidden");
      return;
    }
    items.forEach(function (hit) {
      var row = document.createElement("div");
      row.className = "drive-search-hit";
      var meta = document.createElement("div");
      var name = document.createElement("strong");
      name.textContent = String(hit.name || hit.itemId || "");
      meta.appendChild(name);
      if (hit.pathLabel) {
        var path = document.createElement("span");
        path.className = "hit-path";
        path.textContent = String(hit.pathLabel);
        meta.appendChild(path);
      }
      row.appendChild(meta);
      var go = document.createElement("button");
      go.type = "button";
      go.className = "drive-table-action";
      go.textContent = "前往";
      go.addEventListener("click", function () {
        var parentId = String(hit.parentFolderId || "");
        var target =
          parentId && browseClubFolderId && parentId === browseClubFolderId
            ? ""
            : parentId;
        setBrowserViewMode("browse");
        openBrowseFolder(target, true);
      });
      row.appendChild(go);
      box.appendChild(row);
    });
    if (data && data.truncated) {
      var note = document.createElement("p");
      note.style.margin = "8px 0 0";
      note.style.color = "#6a7f94";
      note.style.fontSize = ".82rem";
      note.textContent = "結果已截斷（有界搜尋）。請再縮小關鍵字。";
      box.appendChild(note);
    }
    box.classList.remove("hidden");
  }

  function scheduleBrowseSearch() {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(function () {
      searchDebounceTimer = null;
      runBrowseSearchNow();
    }, 320);
  }

  function runBrowseSearchNow() {
    var q = String(browseSearchQuery || "").trim();
    if (browseSearchScope !== "club") {
      hideClubSearchResults();
      if (lastBrowseSnapshot) renderBrowserTable(lastBrowseSnapshot);
      return;
    }
    if (!q) {
      hideClubSearchResults();
      if (lastBrowseSnapshot) renderBrowserTable(lastBrowseSnapshot);
      return;
    }
    call("searchClubEvaluationItems", {
      query: q,
      scope: "club"
    }).then(function (result) {
      if (browseSearchScope !== "club") return;
      if (String(browseSearchQuery || "").trim() !== q) return;
      renderClubSearchResults((result && result.data) || { items: [] });
    }).catch(function (error) {
      var box = $("driveSearchResults");
      if (!box) return;
      box.classList.remove("hidden");
      box.replaceChildren();
      var err = document.createElement("p");
      err.style.margin = "0";
      err.textContent = "搜尋失敗：" + friendlyGateMessage(errorInfo(error));
      box.appendChild(err);
    });
  }

  function supportsDirectoryUpload() {
    var input = $("driveFolderUpload");
    return !!(input && ("webkitdirectory" in input || "directory" in input));
  }

  function queueDirectoryUpload(fileList) {
    if (!uploadWriteAllowed) {
      setStatus("系統尚未開放上傳", "warn");
      return;
    }
    if (!serverCtx || !serverCtx.activityId || !serverCtx.permanentClubId) {
      setEvalFolderStatus("尚未取得伺服器確認的活動與社團，無法整夾上傳。", "warn");
      return;
    }
    var MAX_BYTES = 100 * 1024 * 1024;
    var destRootId = String(selectedEvalFolderId || "");
    var destRootLabel = browsePathLabel || "社團評選資料夾";
    var frozenUid = boundUid;
    var frozenGen = generation;
    var allEntries = Array.prototype.slice.call(fileList || []);
    var rejected = [];
    var files = [];
    allEntries.forEach(function (file) {
      if (!file) return;
      var name = String(file.name || "");
      if (!/\.pdf$/i.test(name)) {
        rejected.push(name + "（僅支援 PDF）");
        return;
      }
      if (file.size > MAX_BYTES) {
        rejected.push(name + "（超過 100 MiB）");
        return;
      }
      files.push(file);
    });
    if (!files.length) {
      setEvalFolderStatus(
        rejected.length
          ? "沒有可上傳的 PDF。" + (rejected.length ? " 略過：" + rejected.slice(0, 5).join("、") : "")
          : "此資料夾沒有可上傳的檔案。",
        "warn"
      );
      return;
    }
    var byRel = files.map(function (file) {
      var rel = String(file.webkitRelativePath || file.name || "");
      var parts = rel.split(/[/\\]/).filter(Boolean);
      var fileName = parts.pop() || file.name;
      return { file: file, dirs: parts, fileName: fileName };
    });
    var uniqueDirs = Object.create(null);
    byRel.forEach(function (row) {
      // Fill every ancestor path so parents exist before leaf folders.
      for (var i = 1; i <= row.dirs.length; i += 1) {
        var pathKey = row.dirs.slice(0, i).join("/");
        if (pathKey) uniqueDirs[pathKey] = row.dirs.slice(0, i);
      }
    });
    var dirKeys = Object.keys(uniqueDirs).sort(function (a, b) {
      return a.split("/").length - b.split("/").length || a.localeCompare(b);
    });
    var folderIdByPath = Object.create(null);
    folderIdByPath[""] = destRootId;
    setEvalFolderStatus("正在預檢並建立資料夾結構（" + dirKeys.length + " 條路徑）…", "warn");
    var chain = Promise.resolve();
    dirKeys.forEach(function (pathKey) {
      chain = chain.then(function () {
        if (frozenGen !== generation || frozenUid !== boundUid) {
          throw new Error("登入或工作階段已變更，已中止整夾上傳預檢。");
        }
        var parts = uniqueDirs[pathKey];
        var parentKey = parts.slice(0, -1).join("/");
        if (!Object.prototype.hasOwnProperty.call(folderIdByPath, parentKey)) {
          throw new Error("找不到上層資料夾「" + (parentKey || destRootLabel) + "」，已中止以免放到錯誤位置。");
        }
        var parentId = folderIdByPath[parentKey];
        if (parentId == null || parentId === "") {
          throw new Error("上層資料夾識別不明，已中止以免默默放到根目錄。");
        }
        var name = parts[parts.length - 1];
        return call("createClubEvaluationFolder", {
          name: name,
          parentFolderId: parentId
        }).then(function (result) {
          var data = (result && result.data) || {};
          var createdId = String(data.folderId || "");
          if (!createdId) {
            throw new Error("建立「" + name + "」後未取得資料夾識別。");
          }
          folderIdByPath[pathKey] = createdId;
          return data;
        });
      });
    });
    return chain.then(function () {
      if (frozenGen !== generation || frozenUid !== boundUid) {
        throw new Error("登入或工作階段已變更，已中止整夾上傳。");
      }
      byRel.forEach(function (row) {
        var pathKey = row.dirs.join("/");
        if (!Object.prototype.hasOwnProperty.call(folderIdByPath, pathKey)) {
          throw new Error("目的資料夾「" + pathKey + "」尚未建立完成。");
        }
        var destId = folderIdByPath[pathKey];
        if (!destId) {
          throw new Error("目的資料夾識別不明，未排入「" + row.fileName + "」。");
        }
        uploadQueue.push({
          file: row.file,
          state: "等待上傳",
          destinationFolderId: String(destId),
          destinationLabel: destRootLabel +
            (pathKey ? " / " + pathKey.replace(/\//g, " / ") : "")
        });
      });
      renderQueue();
      clearEvalFoldersCache();
      var rejectNote = rejected.length
        ? "；另有 " + rejected.length + " 項未支援：" + rejected.slice(0, 5).join("、")
        : "";
      setEvalFolderStatus(
        "已排入 " + byRel.length + " 個 PDF（整夾上傳，目的地已固定）。請按「開始上傳」。" + rejectNote,
        rejected.length ? "warn" : "ok"
      );
      return refreshEvalFolders({ gen: generation, op: operationSeq, uid: boundUid }, true);
    }).catch(function (error) {
      setEvalFolderStatus("整夾上傳預檢失敗：" + friendlyGateMessage(errorInfo(error)), "error");
    });
  }

  function requestBatchTrash() {
    var items = selectedItemList();
    if (!items.length) return;
    showFileActionConfirm({
      kind: "trash",
      itemKind: "batch",
      fileName: items.length + " 個項目",
      fromPath: browsePathLabel,
      batchItems: items,
      confirmReplace: false
    });
  }

  function requestBatchMove() {
    var items = selectedItemList();
    if (!items.length) return;
    openFolderPicker({
      kind: "move",
      itemKind: "batch",
      fileName: items.length + " 個項目",
      parentFolderId: currentBrowseParentId(),
      fromPath: browsePathLabel,
      batchItems: items
    });
  }

  function requestBatchCopy() {
    var items = selectedItemList().filter(function (item) { return item.kind === "file"; });
    if (!items.length) {
      setEvalFolderStatus("批次複製僅支援檔案。", "warn");
      return;
    }
    openFolderPicker({
      kind: "copy",
      itemKind: "batch",
      fileName: items.length + " 個檔案",
      parentFolderId: currentBrowseParentId(),
      fromPath: browsePathLabel,
      batchItems: items
    });
  }

  function callableAndBodyForAction(action) {
    var itemKind = action.itemKind || (action.folderId ? "folder" : "file");
    var kind = action.kind;
    if (kind === "restore") {
      return {
        name: "restoreClubEvaluationItem",
        body: {
          itemId: action.itemId || action.fileId || action.folderId,
          confirmReplace: !!action.confirmReplace
        }
      };
    }
    if (kind === "rename") {
      if (itemKind === "folder") {
        return {
          name: "renameClubEvaluationFolder",
          body: { folderId: action.folderId, name: action.name || action.folderName }
        };
      }
      return {
        name: "renameClubEvaluationFile",
        body: { fileId: action.fileId, name: action.name || action.fileName }
      };
    }
    if (kind === "trash") {
      if (itemKind === "folder") {
        return { name: "trashClubEvaluationFolder", body: { folderId: action.folderId } };
      }
      return { name: "trashClubEvaluationFile", body: { fileId: action.fileId } };
    }
    if (kind === "copy") {
      return {
        name: "copyClubEvaluationFile",
        body: {
          fileId: action.fileId,
          destinationFolderId: action.destinationFolderId,
          confirmReplace: !!action.confirmReplace
        }
      };
    }
    if (kind === "move") {
      if (itemKind === "folder") {
        return {
          name: "moveClubEvaluationFolder",
          body: {
            folderId: action.folderId,
            destinationFolderId: action.destinationFolderId,
            confirmReplace: !!action.confirmReplace
          }
        };
      }
      return {
        name: "moveClubEvaluationFile",
        body: {
          fileId: action.fileId,
          destinationFolderId: action.destinationFolderId,
          confirmReplace: !!action.confirmReplace
        }
      };
    }
    return null;
  }

  function applyFileOpResult(data, action) {
    if (data && Array.isArray(data.files) && lastListData) {
      lastListData.files = data.files;
      renderList(data.files);
    }
    var touch = [action.parentFolderId, action.destinationFolderId, browseClubFolderId];
    if (action.folderId) touch.push(action.folderId);
    if (data && data.fromFolderId) touch.push(data.fromFolderId);
    if (data && data.toFolderId) touch.push(data.toFolderId);
    if (data && data.parentFolderId) touch.push(data.parentFolderId);
    invalidateFolderCaches(touch);
    Object.keys(treeExpandedIds).forEach(function (id) {
      if (treeExpandedIds[id]) loadTreeChildren(id, true);
    });
    clearBrowseSelection();
    if (browserViewMode === "trash") {
      return refreshTrashView(true);
    }
    return refreshEvalFolders({ gen: generation, op: operationSeq, uid: boundUid }, true);
  }

  function runSingleFileOp(action) {
    var packed = callableAndBodyForAction(action);
    if (!packed) {
      setEvalFolderStatus("未知操作。", "error");
      return Promise.resolve(null);
    }
    fileOpBusy = true;
    setEvalFolderStatus("處理中…", "warn");
    return call(packed.name, packed.body).then(function (result) {
      var data = (result && result.data) || {};
      if (data.status === "replace_confirm_required") {
        showFileActionConfirm(Object.assign({}, action, {
          confirmReplace: true,
          conflictMessage: data.message || ""
        }));
        setEvalFolderStatus(data.message || "目的地有同名項目，請確認是否取代。", "warn");
        return { replaceRequired: true, data: data };
      }
      hideFileActionConfirm();
      return Promise.resolve(applyFileOpResult(data, action)).then(function () {
        return { data: data };
      });
    }).catch(function (error) {
      var info = errorInfo(error);
      setEvalFolderStatus(friendlyGateMessage(info), "error");
      return null;
    }).then(function (outcome) {
      fileOpBusy = false;
      syncEvalFolderPanel();
      return outcome;
    });
  }

  function runBatchFileOps(action) {
    var items = (action.batchItems || []).slice();
    if (!items.length) return Promise.resolve(null);
    fileOpBusy = true;
    var ok = 0;
    var fail = 0;
    var unclear = 0;
    var pendingConfirm = null;
    function next(index) {
      if (pendingConfirm) {
        return Promise.resolve({ pendingConfirm: pendingConfirm, ok: ok, fail: fail, unclear: unclear });
      }
      if (index >= items.length) {
        return Promise.resolve({ ok: ok, fail: fail, unclear: unclear });
      }
      var item = items[index];
      var step = {
        kind: action.kind,
        itemKind: item.kind === "folder" ? "folder" : "file",
        fileId: item.kind === "folder" ? undefined : item.id,
        folderId: item.kind === "folder" ? item.id : undefined,
        fileName: item.kind === "folder" ? undefined : item.name,
        folderName: item.kind === "folder" ? item.name : undefined,
        itemId: action.kind === "restore" ? item.id : undefined,
        parentFolderId: item.parentFolderId,
        destinationFolderId: action.destinationFolderId,
        toPath: action.toPath,
        fromPath: action.fromPath,
        confirmReplace: !!action.confirmReplace
      };
      if (action.kind === "copy" && step.itemKind === "folder") {
        fail += 1;
        return next(index + 1);
      }
      setEvalFolderStatus(
        "批次處理中（" + (index + 1) + "/" + items.length + "）：" + (item.name || item.id),
        "warn"
      );
      var packed = callableAndBodyForAction(step);
      if (!packed) {
        fail += 1;
        return next(index + 1);
      }
      return call(packed.name, packed.body).then(function (result) {
        var data = (result && result.data) || {};
        if (data.status === "replace_confirm_required") {
          pendingConfirm = Object.assign({}, action, {
            batchItems: items.slice(index),
            confirmReplace: true,
            conflictMessage: data.message || "",
            fileName: item.name,
            itemKind: step.itemKind,
            fileId: step.fileId,
            folderId: step.folderId
          });
          return null;
        }
        ok += 1;
        return null;
      }).catch(function (error) {
        var code = String((error && error.code) || "");
        if (/FILE_OP_UNCLEAR|unclear/i.test(code + " " + String((error && error.message) || ""))) {
          unclear += 1;
        } else {
          fail += 1;
        }
        return null;
      }).then(function () {
        return next(index + 1);
      });
    }
    return next(0).then(function (summary) {
      hideFileActionConfirm();
      return Promise.resolve(
        browserViewMode === "trash"
          ? refreshTrashView(true)
          : refreshEvalFolders({ gen: generation, op: operationSeq, uid: boundUid }, true)
      ).then(function () {
        if (summary && summary.pendingConfirm) {
          showFileActionConfirm(summary.pendingConfirm);
          setEvalFolderStatus(
            "批次已完成 " + summary.ok + " 項；遇到同名衝突，請確認後繼續其餘項目。" +
              (summary.fail || summary.unclear
                ? "（失敗 " + summary.fail + "／待查證 " + summary.unclear + "）"
                : ""),
            "warn"
          );
          return summary;
        }
        setEvalFolderStatus(
          "批次結束：成功 " + (summary && summary.ok || 0) +
            "／失敗 " + (summary && summary.fail || 0) +
            "／待查證 " + (summary && summary.unclear || 0) +
            "。失敗項未樂觀移除，請重新整理後查證。",
          (summary && summary.fail) || (summary && summary.unclear) ? "warn" : "ok"
        );
        clearBrowseSelection();
        return summary;
      });
    }).then(function (summary) {
      fileOpBusy = false;
      syncEvalFolderPanel();
      return summary;
    });
  }

  function runPendingFileAction(confirmReplace) {
    if (!pendingFileAction || fileOpBusy) return;
    if (!uploadWriteAllowed) {
      setEvalFolderStatus("目前為唯讀狀態，無法執行此操作。", "warn");
      hideFileActionConfirm();
      return;
    }
    var action = Object.assign({}, pendingFileAction, {
      confirmReplace: !!confirmReplace || !!pendingFileAction.confirmReplace
    });
    if (action.batchItems && action.batchItems.length) {
      runBatchFileOps(action);
      return;
    }
    var okMsg =
      action.kind === "trash" ? "已移入垃圾桶。"
        : action.kind === "copy"
          ? "已複製。"
          : action.kind === "restore"
            ? "已還原。"
            : action.kind === "rename"
              ? "已重新命名。"
              : "已移動。";
    runSingleFileOp(action).then(function (outcome) {
      if (!outcome || outcome.replaceRequired) return;
      if (action.kind === "copy") {
        var data = outcome.data || {};
        okMsg = data.registeredAsSubmission
          ? "已複製並登錄有效繳交。"
          : "已複製；未登錄檔不會因此變成有效繳交。";
      }
      if (action.kind === "restore" && outcome.data && outcome.data.reactivatedSubmission) {
        okMsg = "已還原，並解除先前因刪除而 superseded 的繳交。";
      } else if (action.kind === "restore") {
        okMsg = "已還原 Drive 項目（未登錄檔不會因此變成有效繳交）。";
      }
      setEvalFolderStatus(okMsg, "ok");
    });
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
    var pathLabel = browsePathLabel || folderName;
    if (title) {
      if (!uploadWriteAllowed) {
        title.textContent = "目前為唯讀（不可上傳）";
      } else if (activeKind === "evaluation") {
        title.textContent = "放開以上傳至「" + pathLabel + "」";
      } else {
        title.textContent = "放開以上傳特色資料";
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

  function isExternalFileDrag(event) {
    if (dragFilePayload) return false;
    var dt = event && event.dataTransfer;
    if (!dt) return false;
    try {
      if (dt.types && typeof dt.types.contains === "function" &&
        dt.types.contains("application/x-hksp-drive-file")) {
        return false;
      }
      if (dt.types && typeof dt.types.indexOf === "function" &&
        dt.types.indexOf("application/x-hksp-drive-file") >= 0) {
        return false;
      }
      if (dt.types && typeof dt.types.includes === "function" &&
        dt.types.includes("application/x-hksp-drive-file")) {
        return false;
      }
    } catch (_error) { /* ignore */ }
    try {
      if (dt.files && dt.files.length) return true;
      if (dt.types) {
        if (typeof dt.types.contains === "function") return dt.types.contains("Files");
        if (typeof dt.types.indexOf === "function") return dt.types.indexOf("Files") >= 0;
        if (typeof dt.types.includes === "function") return dt.types.includes("Files");
        for (var i = 0; i < dt.types.length; i += 1) {
          if (String(dt.types[i]) === "Files") return true;
        }
      }
    } catch (_error2) { /* ignore */ }
    return false;
  }

  function setExternalDropHighlight(on) {
    var zone = $("driveDropzone");
    if (!zone) return;
    if (on && uploadWriteAllowed) {
      syncDropzoneCopy();
      zone.classList.remove("hidden");
      zone.classList.add("dragover");
      zone.setAttribute("aria-hidden", "false");
    } else {
      zone.classList.add("hidden");
      zone.classList.remove("dragover");
      zone.setAttribute("aria-hidden", "true");
    }
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

  function showReplaceConfirm(payload, file, attempt, queueItem) {
    pendingReplace = {
      payload: payload,
      file: file,
      attempt: attempt,
      uploadKind: activeKind,
      queueItem: queueItem || null
    };
    var box = $("driveReplaceConfirm");
    var detail = $("driveReplaceDetail");
    var existing = (payload && payload.existingFile) || {};
    if (detail) {
      detail.textContent =
        "原檔：" + (existing.fileName || "（未知）") +
        (existing.size != null ? "（" + existing.size + " bytes）" : "") +
        "。確認後才會以新檔取代；取消則保留舊檔。" +
        (queueItem && queueItem.destinationLabel
          ? " 目的地：" + queueItem.destinationLabel + "。"
          : "");
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
    treeLoadErrors = Object.create(null);
    treeMobileOpen = true;
    pendingFileAction = null;
    fileOpBusy = false;
    dragFilePayload = null;
    hideSuccessToast();
    hideFileActionConfirm();
    hideFolderPicker();
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
    var raw = Array.prototype.slice.call(fileList || []);
    if (!raw.length) return;
    var destId = activeKind === "evaluation" ? String(selectedEvalFolderId || "") : "";
    var destLabel = activeKind === "evaluation"
      ? (browsePathLabel || "社團評選資料夾")
      : "特色共用資料夾";
    var MAX_BYTES = 100 * 1024 * 1024;
    var rejected = [];
    var files = [];
    raw.forEach(function (file) {
      if (!file) return;
      if (activeKind === "evaluation") {
        if (!/\.pdf$/i.test(String(file.name || ""))) {
          rejected.push((file.name || "（未命名）") + "（僅支援 PDF）");
          return;
        }
        if (file.size > MAX_BYTES) {
          rejected.push((file.name || "（未命名）") + "（超過 100 MiB）");
          return;
        }
      }
      files.push(file);
    });
    if (!files.length) {
      setStatus(
        rejected.length
          ? "沒有可上傳的檔案。略過：" + rejected.slice(0, 5).join("、")
          : "沒有可上傳的檔案。",
        "warn"
      );
      return;
    }
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
        uploadQueue.push({
          file: file,
          state: "等待上傳",
          destinationFolderId: destId,
          destinationLabel: destLabel
        });
      });
    }
    renderQueue();
    var rejectNote = rejected.length
      ? "；略過 " + rejected.length + " 項：" + rejected.slice(0, 5).join("、")
      : "";
    setStatus(
      activeKind === "feature"
        ? "已選取 1 個檔案，目的地：" + destLabel + "。按「開始上傳」送出。" + rejectNote
        : "已加入 " + files.length + " 個檔案至佇列（目的地已固定為：" + destLabel + "）。" + rejectNote,
      rejected.length ? "warn" : "ok"
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
      var line =
        (serverCtx.clubName || "社團") +
        "（" + (serverCtx.permanentClubId || "") + "）";
      var windows = lastListData && lastListData.uploadWindows;
      var win = windows && windows[activeKind === "feature" ? "feature" : "evaluation"];
      if (win && win.deadlineAt) {
        line += "　截止：" + formatTaipeiDateTime(win.deadlineAt);
      } else if (lastListData) {
        line += "　截止：伺服器尚未回傳截止";
      }
      meta.textContent = line;
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
        showReplaceConfirm(data, file, attempt, queueItem);
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
        if (uploadQueue[0] && uploadQueue[0].file === file) {
          uploadQueue[0].state = "待確認取代";
          renderQueue();
        }
        busy = false;
        if ($("btnDriveUpload")) $("btnDriveUpload").disabled = !uploadWriteAllowed;
        setTransferProgress(null);
        return { stoppedForConfirm: true };
      }
      // null / stale responses must not count as success or leave the queue.
      // Transfer 100% alone never reaches here without a complete/alreadyComplete object.
      if (!done) {
        if (uploadQueue[0] && uploadQueue[0].file === file) {
          uploadQueue[0].state = "需核對（未確認）";
          renderQueue();
        }
        setTransferProgress(null);
        setStatus("這次上傳沒有取得伺服器確認結果，檔案仍留在佇列，請核對後再重試。", "warn");
        return null;
      }
      var completePayload = done.data || done;
      var confirmed = !!(
        done.alreadyComplete === true ||
        (completePayload && completePayload.alreadyComplete === true) ||
        (completePayload && Array.isArray(completePayload.files))
      );
      if (!confirmed) {
        if (uploadQueue[0] && uploadQueue[0].file === file) {
          uploadQueue[0].state = "需核對（未確認）";
          renderQueue();
        }
        setTransferProgress(null);
        setStatus("伺服器未確認完成，未移出佇列。", "warn");
        return null;
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
      clearAttempt(
        pendingReplace.file,
        pendingReplace.uploadKind || activeKind,
        pendingReplace.queueItem && pendingReplace.queueItem.destinationFolderId != null
          ? pendingReplace.queueItem.destinationFolderId
          : undefined
      );
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
    var fileActionConfirm = $("btnDriveFileActionConfirm");
    var fileActionCancel = $("btnDriveFileActionCancel");
    var folderPickerCancel = $("btnDriveFolderPickerCancel");
    var folderPickerConfirm = $("btnDriveFolderPickerConfirm");
    var folderPickerUp = $("btnDriveFolderPickerUp");
    var renameConfirm = $("btnDriveRenameConfirm");
    var renameCancel = $("btnDriveRenameCancel");
    var pdfClose = $("btnDrivePdfPreviewClose");
    var folderCreate = $("btnDriveEvalFolderCreate");
    var folderRefresh = $("btnDriveEvalFolderRefresh");
    var folderUp = $("btnDriveBrowserUp");
    var showCreate = $("btnDriveShowCreateFolder");
    var cancelCreate = $("btnDriveCancelCreateFolder");
    var pickUpload = $("btnDrivePickUpload");
    var pickFolderUpload = $("btnDrivePickFolderUpload");
    var folderUploadInput = $("driveFolderUpload");
    var treeToggle = $("btnDriveTreeToggle");
    var searchInput = $("driveBrowserSearch");
    var searchScope = $("driveBrowserSearchScope");
    var sortSelect = $("driveBrowserSort");
    var selectAll = $("driveSelectAll");
    var viewBrowse = $("btnDriveViewBrowse");
    var viewTrash = $("btnDriveViewTrash");
    var batchTrash = $("btnDriveBatchTrash");
    var batchMove = $("btnDriveBatchMove");
    var batchCopy = $("btnDriveBatchCopy");
    var batchClear = $("btnDriveBatchClear");
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
        closePdfPreview();
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
    if (fileActionConfirm && !fileActionConfirm.dataset.bound) {
      fileActionConfirm.dataset.bound = "1";
      fileActionConfirm.addEventListener("click", function () {
        runPendingFileAction(!!(pendingFileAction && pendingFileAction.confirmReplace));
      });
    }
    if (fileActionCancel && !fileActionCancel.dataset.bound) {
      fileActionCancel.dataset.bound = "1";
      fileActionCancel.addEventListener("click", function () {
        hideFileActionConfirm();
        setEvalFolderStatus("已取消，原畫面與檔案均未變更。", "ok");
      });
    }
    if (folderPickerCancel && !folderPickerCancel.dataset.bound) {
      folderPickerCancel.dataset.bound = "1";
      folderPickerCancel.addEventListener("click", function () {
        hideFolderPicker();
        setEvalFolderStatus("已取消選擇目的資料夾。", "ok");
      });
    }
    if (folderPickerConfirm && !folderPickerConfirm.dataset.bound) {
      folderPickerConfirm.dataset.bound = "1";
      folderPickerConfirm.addEventListener("click", confirmFolderPickerDestination);
    }
    if (folderPickerUp && !folderPickerUp.dataset.bound) {
      folderPickerUp.dataset.bound = "1";
      folderPickerUp.addEventListener("click", function () {
        if (!folderPickerState) return;
        var path = folderPickerState.path || [];
        if (path.length >= 2) {
          enterFolderPickerFolder(String(path[path.length - 2].folderId || ""));
        } else {
          enterFolderPickerFolder("");
        }
      });
    }
    if (renameConfirm && !renameConfirm.dataset.bound) {
      renameConfirm.dataset.bound = "1";
      renameConfirm.addEventListener("click", confirmRename);
    }
    if (renameCancel && !renameCancel.dataset.bound) {
      renameCancel.dataset.bound = "1";
      renameCancel.addEventListener("click", function () {
        hideRenameDialog();
        setEvalFolderStatus("已取消重新命名。", "ok");
      });
    }
    if (pdfClose && !pdfClose.dataset.bound) {
      pdfClose.dataset.bound = "1";
      pdfClose.addEventListener("click", closePdfPreview);
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
    if (pickFolderUpload && !pickFolderUpload.dataset.bound) {
      pickFolderUpload.dataset.bound = "1";
      pickFolderUpload.addEventListener("click", function () {
        if (!uploadWriteAllowed) {
          setStatus("系統尚未開放上傳", "warn");
          return;
        }
        if (!supportsDirectoryUpload()) {
          setEvalFolderStatus(
            "此裝置不支援整夾選擇；請改用多檔上傳，或在電腦瀏覽器使用「上傳資料夾」。",
            "warn"
          );
          if (fileInput) fileInput.click();
          return;
        }
        if (folderUploadInput) folderUploadInput.click();
      });
    }
    if (folderUploadInput && !folderUploadInput.dataset.bound) {
      folderUploadInput.dataset.bound = "1";
      folderUploadInput.addEventListener("change", function () {
        queueDirectoryUpload(folderUploadInput.files);
        folderUploadInput.value = "";
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
        if (browseSearchScope === "club") {
          scheduleBrowseSearch();
        } else {
          hideClubSearchResults();
          if (lastBrowseSnapshot) renderBrowserTable(lastBrowseSnapshot);
        }
      });
    }
    if (searchScope && !searchScope.dataset.bound) {
      searchScope.dataset.bound = "1";
      searchScope.addEventListener("change", function () {
        browseSearchScope = String(searchScope.value || "current") === "club" ? "club" : "current";
        if (browseSearchScope === "club") scheduleBrowseSearch();
        else {
          hideClubSearchResults();
          if (lastBrowseSnapshot) renderBrowserTable(lastBrowseSnapshot);
        }
      });
    }
    if (sortSelect && !sortSelect.dataset.bound) {
      sortSelect.dataset.bound = "1";
      sortSelect.value = String(browseSort.field || "name") + "-" + String(browseSort.dir || "asc");
      sortSelect.addEventListener("change", function () {
        var parts = String(sortSelect.value || "name-asc").split("-");
        setBrowseSort(parts[0], parts[1] === "desc" ? "desc" : "asc");
      });
    }
    var sortButtons = [];
    try {
      if (typeof document.querySelectorAll === "function") {
        sortButtons = Array.prototype.slice.call(document.querySelectorAll(".drive-th-sort") || []);
      }
    } catch (_error) {
      sortButtons = [];
    }
    sortButtons.forEach(function (btn) {
      if (!btn || btn.dataset && btn.dataset.bound) return;
      if (btn.dataset) btn.dataset.bound = "1";
      btn.addEventListener("click", function () {
        var field = String(btn.getAttribute("data-sort") || "name");
        if (browseSort.field === field) {
          setBrowseSort(field, browseSort.dir === "asc" ? "desc" : "asc");
        } else {
          setBrowseSort(field, "asc");
        }
      });
    });
    if (selectAll && !selectAll.dataset.bound) {
      selectAll.dataset.bound = "1";
      selectAll.addEventListener("change", function () {
        if (browserViewMode === "trash" || !lastBrowseSnapshot) return;
        var checked = !!selectAll.checked;
        var pathFolderIds = currentPathFolderIds(lastBrowseSnapshot);
        ((lastBrowseSnapshot.folders || [])).forEach(function (folder) {
          var id = String(folder.folderId || folder.id || "");
          if (!id || !matchesBrowseSearch(folder.name)) return;
          setItemSelected({
            kind: "folder",
            id: id,
            name: String(folder.name || id),
            parentFolderId: String(currentBrowseParentId() || ""),
            pathFolderIds: pathFolderIds.slice()
          }, checked);
        });
        ((lastBrowseSnapshot.files || [])).forEach(function (file) {
          var id = String(file.fileId || file.id || "");
          if (!id || !matchesBrowseSearch(file.name)) return;
          setItemSelected({
            kind: "file",
            id: id,
            fileId: id,
            name: String(file.name || id),
            parentFolderId: String(file.parentFolderId || currentBrowseParentId() || ""),
            pathFolderIds: pathFolderIds.slice()
          }, checked);
        });
        renderBrowserTable(lastBrowseSnapshot);
      });
    }
    if (viewBrowse && !viewBrowse.dataset.bound) {
      viewBrowse.dataset.bound = "1";
      viewBrowse.addEventListener("click", function () { setBrowserViewMode("browse"); });
    }
    if (viewTrash && !viewTrash.dataset.bound) {
      viewTrash.dataset.bound = "1";
      viewTrash.addEventListener("click", function () { setBrowserViewMode("trash"); });
    }
    if (batchTrash && !batchTrash.dataset.bound) {
      batchTrash.dataset.bound = "1";
      batchTrash.addEventListener("click", requestBatchTrash);
    }
    if (batchMove && !batchMove.dataset.bound) {
      batchMove.dataset.bound = "1";
      batchMove.addEventListener("click", requestBatchMove);
    }
    if (batchCopy && !batchCopy.dataset.bound) {
      batchCopy.dataset.bound = "1";
      batchCopy.addEventListener("click", requestBatchCopy);
    }
    if (batchClear && !batchClear.dataset.bound) {
      batchClear.dataset.bound = "1";
      batchClear.addEventListener("click", function () {
        clearBrowseSelection();
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
        if (browserViewMode === "trash") {
          refreshTrashView(true);
        } else {
          refreshEvalFolders({ gen: generation, op: operationSeq, uid: boundUid }, true);
        }
      });
    }
    if (folderUp && !folderUp.dataset.bound) {
      folderUp.dataset.bound = "1";
      folderUp.addEventListener("click", function () {
        browseUpOneLevel();
      });
    }
    var dropSurface = $("driveBrowserDropSurface") || $("driveWsMain") || dropzone;
    if (dropSurface && !dropSurface.dataset.boundExternalDrop) {
      dropSurface.dataset.boundExternalDrop = "1";
      ["dragenter", "dragover"].forEach(function (type) {
        dropSurface.addEventListener(type, function (event) {
          if (!isExternalFileDrag(event)) return;
          event.preventDefault();
          event.stopPropagation();
          setExternalDropHighlight(true);
        });
      });
      dropSurface.addEventListener("dragleave", function (event) {
        if (!isExternalFileDrag(event) && !dragFilePayload) {
          // Still clear highlight when leaving the surface during external drag.
        }
        var related = event.relatedTarget;
        if (related && dropSurface.contains && dropSurface.contains(related)) return;
        setExternalDropHighlight(false);
      });
      dropSurface.addEventListener("drop", function (event) {
        if (!isExternalFileDrag(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setExternalDropHighlight(false);
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
    try {
      var rootEl = document.documentElement;
      if (rootEl && rootEl.dataset && !rootEl.dataset.hkspDriveCtxBound) {
        rootEl.dataset.hkspDriveCtxBound = "1";
        document.addEventListener("click", function (event) {
          if (!contextMenuEl) return;
          if (contextMenuEl.contains && contextMenuEl.contains(event.target)) return;
          hideContextMenu();
        });
        document.addEventListener("keydown", function (event) {
          if (event.key !== "Escape") return;
          hideContextMenu();
          closePdfPreview();
          if (pendingReplace) cancelReplaceUpload();
          else if (pendingFileAction) hideFileActionConfirm();
          else if (folderPickerState) hideFolderPicker();
          else if (pendingRename) hideRenameDialog();
        });
      }
    } catch (_error) { /* behavior harness may omit documentElement.dataset */ }
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
