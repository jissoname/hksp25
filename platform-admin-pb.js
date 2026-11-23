/**
 * PocketBase admin adapter for admin.html.
 * Default when HKSP_PB_CONFIG.usePocketBase=true (override with ?gas=1).
 */
"use strict";

(function (root) {
  var SESSION_RECORD_KEY = "HKSP_PB_ADMIN_RECORD";

  function qs() {
    return new URLSearchParams(root.location.search);
  }

  function enabled() {
    if (qs().get("gas") === "1") return false;
    if (qs().get("pb") === "0") return false;
    return !!(root.HKSP_PB_CONFIG && root.HKSP_PB_CONFIG.usePocketBase);
  }

  function $(id) {
    return document.getElementById(id);
  }

  function cfg() {
    return root.HKSP_PB_CONFIG || {};
  }

  function backend() {
    return root.HKSP_PB_BACKEND || null;
  }

  // Dedicated admin client + storage key. Sharing HKSP_PB_BACKEND.pb / "pocketbase_auth"
  // races with student tabs: their authStore.clear() wipes admin mid-request via storage events.
  var ADMIN_AUTH_STORAGE_KEY = "hksp_pb_admin_auth";
  var adminPb = null;

  function pb() {
    if (adminPb) return adminPb;
    var url = String((cfg().url || "")).replace(/\/$/, "");
    if (typeof root.PocketBase === "function" && url) {
      adminPb = new root.PocketBase(url);
      adminPb.autoCancellation(false);
      if (adminPb.authStore && typeof adminPb.authStore.storageKey === "string") {
        adminPb.authStore.storageKey = ADMIN_AUTH_STORAGE_KEY;
      }
      return adminPb;
    }
    var b = backend();
    if (!b || !b.pb) throw new Error("PocketBase 後端尚未載入，請重新整理。");
    if (b.pb.authStore && typeof b.pb.authStore.storageKey === "string") {
      b.pb.authStore.storageKey = ADMIN_AUTH_STORAGE_KEY;
    }
    adminPb = b.pb;
    return adminPb;
  }

  function C() {
    return cfg().collections || {};
  }

  function fail(message, error) {
    return { success: false, error: error || "PB_ADMIN_ERROR", message: message || "操作失敗" };
  }

  function ok(extra) {
    return Object.assign({ success: true }, extra || {});
  }

  function activityId() {
    return cfg().activityId || "115-1-club-evaluation";
  }

  function staffAdminEmail() {
    return String(cfg().staffAdminEmail || "hksp_6188@hk.edu.tw").trim();
  }

  function participationLabelOf(value) {
    var raw = String(value || "").trim().toLowerCase();
    if (raw === "evaluation" || raw === "eval") return "評選";
    if (raw === "feature") return "特色";
    if (raw === "both" || raw === "all") return "兩項皆參加";
    if (raw === "none" || raw === "off") return "不參加";
    return "未設定";
  }

  function mapClub(rec) {
    var meta = rec && rec.meta_json && typeof rec.meta_json === "object" ? rec.meta_json : {};
    var participation = String(meta.participation || "").trim();
    return {
      id: rec.id,
      permanentClubId: String(rec.permanent_club_id || "").toUpperCase(),
      clubId: String(rec.permanent_club_id || "").toUpperCase(),
      name: rec.name || "",
      category: rec.category || "",
      active: rec.active !== false,
      driveFolderId: rec.drive_folder_id || "",
      participation: participation,
      cloudParticipation: participation,
      participationLabel: participationLabelOf(participation),
      version: Number(meta.version) || 1,
      updated: rec.updated || "",
      created: rec.created || ""
    };
  }

  function assertExpectedUpdateTime(activity, data) {
    var expected = String((data && data.expectedUpdateTime) || "").trim();
    if (!expected) return null;
    var current = String((activity && activity.updated) || "").trim();
    if (current && expected !== current) {
      return fail(
        "設定已被其他人更新，請重新讀取後再儲存。",
        "EVALUATION_CONFLICT"
      );
    }
    return null;
  }

  function assertExpectedNumericVersion(currentVersion, expectedVersion, label) {
    if (expectedVersion == null || expectedVersion === "") return null;
    var cur = Number(currentVersion || 1) || 1;
    var exp = Number(expectedVersion);
    if (!Number.isFinite(exp)) return null;
    if (exp !== cur) {
      return fail(
        (label || "設定") + "已被其他人更新，請重新讀取後再儲存。",
        "EVALUATION_CONFLICT"
      );
    }
    return null;
  }

  function mapStudent(rec) {
    return {
      uid: rec.id,
      studentId: rec.student_id || "",
      name: rec.name || rec.student_id || "",
      email: rec.email || "",
      active: rec.active !== false,
      mustChangePassword: !!rec.must_change_password,
      birthYmd: rec.birth_ymd || ""
    };
  }

  async function ensureAdminFromToken(sessionToken) {
    var client = pb();
    var token = String(sessionToken || "").trim();
    if (!token) throw new Error("ADMIN_UNAUTHORIZED");
      var raw = sessionStorage.getItem(SESSION_RECORD_KEY);
      var model = null;
      try {
        model = raw ? JSON.parse(raw) : null;
      } catch (_e) {
        model = null;
      }
    // Always re-bind token: shared PocketBase client may be cleared by other adapters.
      client.authStore.save(token, model);
      try {
        await client.collection(C().staff).authRefresh();
      } catch (_e2) {
        throw new Error("ADMIN_UNAUTHORIZED");
    }
    var rec = client.authStore.model;
    if (!rec || rec.role !== "admin" || rec.active === false) {
      throw new Error("ADMIN_UNAUTHORIZED");
    }
    try {
      sessionStorage.setItem(SESSION_RECORD_KEY, JSON.stringify(rec));
    } catch (_e3) {
      /* ignore */
    }
    return rec;
  }

  async function getActivityRecord() {
    return pb()
      .collection(C().activities)
      .getFirstListItem('activity_id="' + activityId() + '"');
  }

  async function getActivityByActivityId(id) {
    var aid = String(id || "").trim();
    if (!aid) throw new Error("缺少活動編號。");
    return pb()
      .collection(C().activities)
      .getFirstListItem('activity_id="' + aid.replace(/"/g, '\\"') + '"');
  }

  /**
   * admin.html 社團帳號查詢會先打 adminReadActivityHandover 取 activeActivityId。
   * PB 主路徑以 activities.activity_id（或 config_json.activeActivityId）為準。
   */
  async function resolveActiveActivity() {
    var configured = String(activityId() || "").trim();
    var primary = await getActivityRecord();
    var conf =
      primary && primary.config_json && typeof primary.config_json === "object"
        ? primary.config_json
        : {};
    var activeId = String(conf.activeActivityId || primary.activity_id || configured).trim();
    if (activeId && activeId !== String(primary.activity_id || "")) {
      try {
        var other = await getActivityByActivityId(activeId);
        return { activity: other, activeActivityId: activeId, conf: conf, primary: primary };
      } catch (_e) {
        /* fall back to primary */
      }
    }
    return {
      activity: primary,
      activeActivityId: String(primary.activity_id || configured),
      conf: conf,
      primary: primary
    };
  }

  async function adminReadActivityHandover() {
    var resolved = await resolveActiveActivity();
    return ok({
      activeActivityId: resolved.activeActivityId,
      sourceActivityId: resolved.activeActivityId,
      inProgress: false,
      handoverOpId: null,
      activityVersion: String(
        (resolved.activity && resolved.activity.updated) || new Date().toISOString()
      )
    });
  }

  async function adminPreviewActivityHandover(data) {
    var resolved = await resolveActiveActivity();
    var targetId = String((data && data.targetActivityId) || "").trim();
    if (!targetId) return fail("請填寫目標活動編號。");
    if (targetId === resolved.activeActivityId) {
      return fail("目標活動與目前活動相同。");
    }
    try {
      await getActivityByActivityId(targetId);
    } catch (_e) {
      return fail("找不到目標活動「" + targetId + "」。請先建立該活動後再交接。");
    }
    var mems = await pb().collection(C().memberships).getFullList({
      filter: 'activity="' + resolved.activity.id + '" && status="active"'
    });
    var byClub = {};
    mems.forEach(function (m) {
      var key = m.club || "";
      if (!byClub[key]) byClub[key] = 0;
      byClub[key] += 1;
    });
    var clubs = Object.keys(byClub).map(function (clubId) {
      return {
        clubId: clubId,
        activeMemberships: byClub[clubId],
        seatStatus: "occupied",
        activeQueryGrants: 0
      };
    });
    return ok({
      activeActivityId: resolved.activeActivityId,
      sourceActivityId: resolved.activeActivityId,
      targetActivityId: targetId,
      inProgress: false,
      previewVersion: "pb-" + Date.now(),
      activityVersion: String(resolved.activity.updated || ""),
      clubs: clubs
    });
  }

  async function adminExecuteActivityHandover(data) {
    var resolved = await resolveActiveActivity();
    var expected = String((data && data.expectedSourceActivityId) || "").trim();
    var targetId = String((data && data.targetActivityId) || "").trim();
    if (expected && expected !== resolved.activeActivityId) {
      return fail("目前活動已變更，請重新預覽後再執行。");
    }
    if (!targetId) return fail("缺少目標活動。");
    var target;
    try {
      target = await getActivityByActivityId(targetId);
    } catch (_e) {
      return fail("找不到目標活動「" + targetId + "」。");
    }
    // PB：僅切換 config 上記錄的目前活動；不撤名額、不搬檔（與舊 GAS 交接不同）。
    var primary = resolved.primary || resolved.activity;
    var conf =
      primary.config_json && typeof primary.config_json === "object"
        ? Object.assign({}, primary.config_json)
        : {};
    conf.activeActivityId = target.activity_id;
    conf.activeActivityUpdatedAt = new Date().toISOString();
    await pb().collection(C().activities).update(primary.id, { config_json: conf });
    return ok({
      status: "completed",
      idempotent: false,
      activeActivityId: target.activity_id,
      sourceActivityId: resolved.activeActivityId,
      targetActivityId: target.activity_id,
      handoverOpId: (data && data.handoverOpId) || null,
      note: "PocketBase 僅切換目前活動標記；不會撤除來源名額或搬移上傳檔。"
    });
  }

  function eventConfigFromActivity(activity) {
    var conf =
      activity && activity.config_json && typeof activity.config_json === "object"
        ? Object.assign({}, activity.config_json)
        : {};
    var fallback = root.FALLBACK_EVENT_CONFIG || {};
    var config = Object.assign({}, fallback, conf, {
      activityId: activity.activity_id,
      title: activity.title,
      updatedAt: activity.updated || new Date().toISOString()
    });
    if (!config.dataDeadline && activity.upload_close_at) {
      config.dataDeadline = activity.upload_close_at;
    }
    if (!config.featureDeadline && conf.featureDeadline) {
      config.featureDeadline = conf.featureDeadline;
    }
    return config;
  }

  function uploadSettingsFromActivity(activity) {
    var conf =
      activity && activity.config_json && typeof activity.config_json === "object"
        ? activity.config_json
        : {};
    var gate = conf.uploadGate || { open: true, version: 1 };
    function side(kind) {
      var key = kind === "feature" ? "feature" : "evaluation";
      var deadline =
        kind === "feature"
          ? conf.featureDeadline || conf.dataDeadline || activity.upload_close_at || ""
          : conf.dataDeadline || activity.upload_close_at || "";
      var makeup = conf[key + "Makeup"] || {};
      return {
        deadlineAt: deadline || null,
        makeupDeadlineAt: makeup.deadlineAt || null,
        makeupClubIds: Array.isArray(makeup.clubIds) ? makeup.clubIds : [],
        version: Number(makeup.version || conf[key + "Version"] || 1) || 1
      };
    }
    return {
      evaluation: side("evaluation"),
      feature: side("feature"),
      gate: {
        open: gate.open !== false,
        version: Number(gate.version || 1) || 1,
        updatedAt: gate.updatedAt || activity.updated || "",
        envMode: "pocketbase",
        writesAllowed: gate.open !== false,
        effectiveLabel: gate.open !== false ? "開放上傳" : "暫停上傳",
        statusLabel: gate.open !== false ? "開放上傳" : "暫停上傳",
        envPriority: "PocketBase 主路徑（無 Drive 代傳費用）",
        folderOpsNote: "檔案存於 PocketBase。",
        pauseEffectNote: "暫停時評選／特色皆不可寫；開放後再依各截止時間分別判斷。"
      }
    };
  }

  async function adminLogin(data) {
    var email = String(data.email || staffAdminEmail()).trim();
    var password = String(data.password || "");
    if (!email || !password) return fail("請輸入管理員帳密。");
    try {
      var auth = await pb().collection(C().staff).authWithPassword(email, password);
      var rec = auth.record;
      if (!rec || rec.role !== "admin") {
        pb().authStore.clear();
        if (rec && rec.role === "service") {
          return fail(
            "service 帳號不能登入完整管理後台。請使用 admin 帳號。",
            "ADMIN_UNAUTHORIZED"
          );
        }
        return fail("此帳號沒有管理權限。", "ADMIN_UNAUTHORIZED");
      }
      if (rec.active === false) {
        pb().authStore.clear();
        return fail("管理員帳號已停用。");
      }
      try {
        await pb().collection(C().staff).update(rec.id, {
          last_login_at: new Date().toISOString()
        });
      } catch (_e) {
        /* optional */
      }
      sessionStorage.setItem(SESSION_RECORD_KEY, JSON.stringify(rec));
      return ok({
        sessionToken: auth.token,
        source: "pocketbase",
        updateTime: rec.updated || new Date().toISOString(),
        admin: { id: rec.id, email: rec.email, name: rec.name || "", role: rec.role }
      });
    } catch (e) {
      return fail((e && e.message) || "登入失敗，請確認密碼。");
    }
  }

  async function adminLogout() {
    try {
      pb().authStore.clear();
    } catch (_e) {
      /* ignore */
    }
    try {
      sessionStorage.removeItem(SESSION_RECORD_KEY);
    } catch (_e2) {
      /* ignore */
    }
    return ok();
  }

  async function adminListClubs() {
    var activity = await getActivityRecord();
    var rows = await pb().collection(C().clubs).getFullList({
      filter: 'activity="' + activity.id + '"',
      sort: "category,name"
    });
    var all = rows.map(mapClub);
    return ok({
      clubs: all.filter(function (c) {
        return c.active !== false;
      }),
      studentQueryClubs: all
    });
  }

  function withAuthFileToken_(url) {
    var href = String(url || "").trim();
    if (!href) return "";
    var token = "";
    try {
      token = String((pb().authStore && pb().authStore.token) || "").trim();
    } catch (_e) {
      token = "";
    }
    if (!token) return href;
    if (/[?&]token=/.test(href)) return href;
    return href + (href.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token);
  }

  function mapAdminUploadFile(rec) {
    var fileName = "";
    if (rec.file) {
      fileName = Array.isArray(rec.file) ? rec.file[0] : rec.file;
    }
    var fileUrl = "";
    try {
      if (fileName) fileUrl = pb().files.getURL(rec, fileName);
    } catch (_e) {
      try {
        if (fileName) fileUrl = pb().files.getUrl(rec, fileName);
      } catch (_e2) {
        fileUrl = "";
      }
    }
    fileUrl = withAuthFileToken_(fileUrl);
    return {
      id: rec.id,
      fileId: rec.id,
      name: rec.original_name || fileName || "file",
      fileName: rec.original_name || fileName || "file",
      size: rec.size_bytes || 0,
      sizeBytes: rec.size_bytes || 0,
      mimeType: rec.mime_type || "",
      uploadKind: rec.upload_kind || "evaluation",
      status: rec.status || "completed",
      folderId: rec.folder || "",
      createdAt: rec.created || "",
      updatedAt: rec.updated || "",
      uploadedAt: rec.completed_at || rec.created || "",
      fileUrl: fileUrl,
      webViewLink: withAuthFileToken_(rec.drive_web_view_link || "") || fileUrl || ""
    };
  }

  async function resolveAdminClub(activity, data) {
    var clubId = String((data && data.clubId) || "").trim();
    var permanent = String((data && data.permanentClubId) || "")
      .trim()
      .toUpperCase();
    if (clubId) {
      try {
        var byId = await pb().collection(C().clubs).getOne(clubId);
        if (byId && byId.activity === activity.id) return byId;
      } catch (_e) {
        /* try permanent */
      }
    }
    if (permanent) {
      return pb()
        .collection(C().clubs)
        .getFirstListItem(
          'activity="' + activity.id + '" && permanent_club_id="' + permanent + '"'
        );
    }
    throw new Error("缺少社團。");
  }

  async function findClubRootFolder(activity, club) {
    var roots = await pb().collection(C().folders).getFullList({
      filter:
        'activity="' +
        activity.id +
        '" && club="' +
        club.id +
        '" && trashed!=true && parent=""',
      sort: "created"
    });
    if (!roots.length) {
      var any = await pb()
        .collection(C().folders)
        .getList(1, 1, {
          filter:
            'activity="' +
            activity.id +
            '" && club="' +
            club.id +
            '" && trashed!=true',
          sort: "created"
        });
      return (any.items && any.items[0]) || null;
    }
    if (roots.length === 1) return roots[0];
    // Prefer a root that actually has children (skip empty duplicate roots).
    for (var i = 0; i < roots.length; i++) {
      var kids = await pb()
        .collection(C().folders)
        .getList(1, 1, {
          filter: 'club="' + club.id + '" && trashed!=true && parent="' + roots[i].id + '"'
        });
      if (kids.totalItems > 0) return roots[i];
    }
    for (var j = 0; j < roots.length; j++) {
      var files = await pb()
        .collection(C().uploads)
        .getList(1, 1, {
          filter: 'club="' + club.id + '" && folder="' + roots[j].id + '" && status!="trashed"'
        });
      if (files.totalItems > 0) return roots[j];
    }
    return roots[0];
  }

  function isCompletedUploadStatus_(status) {
    var s = String(status || "").trim().toLowerCase();
    return s === "completed" || s === "uploaded";
  }

  async function adminListClubUploadSummary() {
    var activity = await getActivityRecord();
    var clubs = await pb().collection(C().clubs).getFullList({
      filter: 'activity="' + activity.id + '" && active=true',
      sort: "category,name"
    });
    var uploads = await pb().collection(C().uploads).getFullList({
      filter: 'activity="' + activity.id + '" && status!="trashed"',
      sort: "-created"
    });
    var byClub = {};
    var completedTotal = 0;
    uploads.forEach(function (u) {
      var key = String(u.club || "");
      if (!key) return;
      if (!byClub[key]) {
        byClub[key] = {
          fileCount: 0,
          evaluationCount: 0,
          featureCount: 0,
          completedCount: 0,
          pendingCount: 0,
          latestUploadedAt: ""
        };
      }
      var row = byClub[key];
      if (!isCompletedUploadStatus_(u.status)) {
        row.pendingCount += 1;
        return;
      }
      row.fileCount += 1;
      row.completedCount += 1;
      completedTotal += 1;
      if (u.upload_kind === "feature") row.featureCount += 1;
      else row.evaluationCount += 1;
      var ts = String(u.completed_at || u.created || "");
      if (ts && (!row.latestUploadedAt || ts > row.latestUploadedAt)) {
        row.latestUploadedAt = ts;
      }
    });
    var summary = clubs.map(function (c) {
      var mapped = mapClub(c);
      var stats = byClub[c.id] || {
        fileCount: 0,
        evaluationCount: 0,
        featureCount: 0,
        completedCount: 0,
        pendingCount: 0,
        latestUploadedAt: ""
      };
      return Object.assign({}, mapped, stats);
    });
    return ok({
      activityId: activity.activity_id || activityId(),
      clubs: summary,
      totalFiles: completedTotal,
      pendingFiles: uploads.length - completedTotal,
      clubsWithFiles: summary.filter(function (c) {
        return c.fileCount > 0;
      }).length
    });
  }

  async function adminListFeatureUploads() {
    var activity = await getActivityRecord();
    var clubs = await pb().collection(C().clubs).getFullList({
      filter: 'activity="' + activity.id + '" && active=true',
      sort: "category,name"
    });
    var uploads = await pb().collection(C().uploads).getFullList({
      filter:
        'activity="' +
        activity.id +
        '" && upload_kind="feature" && (status="completed" || status="uploaded")',
      sort: "-created"
    });
    var byClub = {};
    uploads.forEach(function (u) {
      var key = String(u.club || "");
      if (!key) return;
      if (!byClub[key]) byClub[key] = [];
      byClub[key].push(mapAdminUploadFile(u));
    });
    var rows = clubs
      .map(function (c) {
        var files = byClub[c.id] || [];
        if (!files.length) return null;
        var mapped = mapClub(c);
        return {
          id: mapped.id,
          permanentClubId: mapped.permanentClubId,
          name: mapped.name,
          category: mapped.category,
          fileCount: files.length,
          latestUploadedAt: files[0] && (files[0].uploadedAt || files[0].createdAt) || "",
          files: files
        };
      })
      .filter(Boolean);
    var totalFiles = rows.reduce(function (n, row) {
      return n + (Number(row.fileCount) || 0);
    }, 0);
    return ok({
      activityId: activity.activity_id || activityId(),
      clubs: rows,
      clubCount: rows.length,
      totalFiles: totalFiles,
      generatedAt: new Date().toISOString()
    });
  }

  async function adminBrowseClubUploads(data) {
    var activity = await getActivityRecord();
    var club = await resolveAdminClub(activity, data || {});
    var root = await findClubRootFolder(activity, club);
    var parentId = String((data && data.parentFolderId) || "").trim();
    if (!parentId) parentId = root ? root.id : "";
    var kindFilter = String((data && data.uploadKind) || "all").trim().toLowerCase();
    if (kindFilter !== "feature" && kindFilter !== "evaluation") kindFilter = "all";

    var folders = [];
    var files = [];
    var path = [
      {
        folderId: root ? root.id : "",
        name: club.name || "社團根目錄",
        depth: 0
      }
    ];
    var atRoot = !parentId || (root && parentId === root.id);

    if (parentId) {
      folders = await pb().collection(C().folders).getFullList({
        filter:
          'club="' +
          club.id +
          '" && trashed!=true && parent="' +
          parentId +
          '"',
        sort: "name"
      });
      files = await pb().collection(C().uploads).getFullList({
        filter:
          'club="' +
          club.id +
          '" && folder="' +
          parentId +
          '" && (status="completed" || status="uploaded")',
        sort: "-created"
      });
      if (root && parentId !== root.id) {
        try {
          var current = await pb().collection(C().folders).getOne(parentId);
          path.push({
            folderId: current.id,
            name: current.name || "資料夾",
            depth: 1
          });
        } catch (_e) {
          /* keep root-only path */
        }
      }
    }

    // Root：改列社團全部檔案，避免資料夾樹對不齊時「有檔卻空白」。
    // 子資料夾：維持只看該層；若該層空白且篩選特色，再補上該社全部特色檔。
    // 預設只列 completed／uploaded，避免 prepared／failed 進下載。
    var allClubFiles = null;
    async function loadAllClubFiles() {
      if (allClubFiles) return allClubFiles;
      allClubFiles = await pb().collection(C().uploads).getFullList({
        filter:
          'club="' + club.id + '" && (status="completed" || status="uploaded")',
        sort: "-created"
      });
      return allClubFiles;
    }

    if (atRoot) {
      files = await loadAllClubFiles();
    } else if (!files.length && kindFilter === "feature") {
      files = (await loadAllClubFiles()).filter(function (u) {
        return String(u.upload_kind || "") === "feature";
      });
    }

    if (kindFilter === "feature" || kindFilter === "evaluation") {
      files = files.filter(function (u) {
        var kind = String(u.upload_kind || "evaluation");
        return kind === kindFilter;
      });
      if (kindFilter === "feature") {
        // 特色通常不靠資料夾樹管理；篩選特色時隱藏空資料夾噪音。
        folders = folders.filter(function (f) {
          return String(f.kind || "") === "feature";
        });
      }
    }

    var mappedFiles = files.map(mapAdminUploadFile);
    var featureCount = mappedFiles.filter(function (f) {
      return f.uploadKind === "feature";
    }).length;
    var evaluationCount = mappedFiles.length - featureCount;

    return ok({
      activityId: activity.activity_id || activityId(),
      clubId: club.id,
      permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
      clubName: club.name || "",
      category: club.category || "",
      clubFolderId: root ? root.id : "",
      parentFolderId: parentId,
      atRoot: !!atRoot,
      uploadKind: kindFilter,
      path: path,
      folders: folders.map(function (f) {
        return {
          folderId: f.id,
          id: f.id,
          name: f.name,
          kind: f.kind || "evaluation"
        };
      }),
      files: mappedFiles,
      featureCount: featureCount,
      evaluationCount: evaluationCount,
      storage: "pocketbase"
    });
  }

  async function adminAddClub(data) {
    var activity = await getActivityRecord();
    var name = String(data.clubName || data.name || "").trim();
    var category = String(data.category || "").trim();
    if (!name || !category) return fail("請填寫社團名稱與屬性。");
    var permanent =
      String(data.permanentClubId || "").trim().toUpperCase() ||
      "HKSP-" + Date.now().toString(36).toUpperCase();
    try {
      var created = await pb().collection(C().clubs).create({
        activity: activity.id,
        permanent_club_id: permanent,
        name: name,
        category: category,
        active: true,
        meta_json: { version: 1 }
      });
      return ok({ club: mapClub(created), permanentClubId: permanent });
    } catch (e) {
      return fail((e && e.message) || "新增社團失敗。");
    }
  }

  async function adminUpdateClub(data) {
    var activity = await getActivityRecord();
    var oldName = String(data.oldName || "").trim();
    var name = String(data.clubName || data.name || "").trim();
    var category = String(data.category || "").trim();
    if (!oldName || !name || !category) return fail("請填寫完整社團資料。");
    try {
      var existing = await pb()
        .collection(C().clubs)
        .getFirstListItem('activity="' + activity.id + '" && name="' + oldName.replace(/"/g, '\\"') + '"');
      var version = Number(existing.meta_json && existing.meta_json.version) || 1;
      var updated = await pb().collection(C().clubs).update(existing.id, {
        name: name,
        category: category,
        meta_json: Object.assign({}, existing.meta_json || {}, { version: version + 1 })
      });
      return ok({ club: mapClub(updated), permanentClubId: mapClub(updated).permanentClubId });
    } catch (e) {
      return fail((e && e.message) || "更新社團失敗。");
    }
  }

  async function adminSetClubCloudParticipation(data) {
    var activity = await getActivityRecord();
    var permanent = String(data.permanentClubId || data.clubId || "").trim().toUpperCase();
    var participation = String(data.participation || "").trim().toLowerCase();
    if (!permanent) return fail("缺少社團編號。");
    if (
      participation &&
      participation !== "evaluation" &&
      participation !== "feature" &&
      participation !== "both" &&
      participation !== "none"
    ) {
      return fail("參與項目無效（請選評選／特色／兩項皆參加）。");
    }
    try {
      var club = await pb()
        .collection(C().clubs)
        .getFirstListItem(
          'activity="' + activity.id + '" && permanent_club_id="' + permanent + '"'
        );
      var meta =
        club.meta_json && typeof club.meta_json === "object"
          ? Object.assign({}, club.meta_json)
          : {};
      if (participation) meta.participation = participation;
      else delete meta.participation;
      meta.version = Number(meta.version || 1) + 1;
      var updated = await pb().collection(C().clubs).update(club.id, { meta_json: meta });
      var mapped = mapClub(updated);
      return ok({
        club: mapped,
        permanentClubId: mapped.permanentClubId,
        participation: mapped.participation,
        participationLabel: mapped.participationLabel,
        folderEnsure: { skipped: true, reason: "pocketbase-primary" }
      });
    } catch (e) {
      return fail((e && e.message) || "儲存參與項目失敗。");
    }
  }

  async function adminListClubCloudRows(data) {
    var activity = await getActivityRecord();
    var clubs = await pb().collection(C().clubs).getFullList({
      filter: 'activity="' + activity.id + '" && active=true',
      sort: "category,name"
    });
    var requested = Array.isArray(data && data.clubs) ? data.clubs : [];
    var want = {};
    requested.forEach(function (c) {
      var id = String((c && (c.permanentClubId || c.clubId)) || "")
        .trim()
        .toUpperCase();
      if (id) want[id] = true;
    });
    var rows = clubs
      .map(function (c) {
        var mapped = mapClub(c);
        return {
          permanentClubId: mapped.permanentClubId,
          clubName: mapped.name,
          name: mapped.name,
          category: mapped.category,
          participation: mapped.participation || "",
          participationLabel: mapped.participationLabel,
          evaluationFolderConfigured: !!c.drive_folder_id,
          evaluationFolderUrl: "",
          folderEnsureLabel: "PocketBase 主路徑",
          canRetryFolderEnsure: false,
          folderEnsureError: ""
        };
      })
      .filter(function (row) {
        if (!Object.keys(want).length) return true;
        return !!want[row.permanentClubId];
      });
    return ok({
      clubs: rows,
      source: "pocketbase",
      updateTime: String(activity.updated || new Date().toISOString())
    });
  }

  async function adminDeleteClub(data) {
    var activity = await getActivityRecord();
    var name = String(data.clubName || data.name || "").trim();
    var permanent = String(data.permanentClubId || "").trim().toUpperCase();
    try {
      var filter = permanent
        ? 'activity="' + activity.id + '" && permanent_club_id="' + permanent + '"'
        : 'activity="' + activity.id + '" && name="' + name.replace(/"/g, '\\"') + '"';
      var existing = await pb().collection(C().clubs).getFirstListItem(filter);
      var updated = await pb().collection(C().clubs).update(existing.id, { active: false });
      return ok({ club: mapClub(updated) });
    } catch (e) {
      return fail((e && e.message) || "停用社團失敗。");
    }
  }

  async function adminListClubStudents(data) {
    var requestedActivityId = String((data && data.activityId) || "").trim();
    var activity;
    if (requestedActivityId) {
      try {
        activity = await getActivityByActivityId(requestedActivityId);
      } catch (_e) {
        return fail("找不到活動「" + requestedActivityId + "」。", "ACTIVITY_NOT_FOUND");
      }
    } else {
      activity = (await resolveActiveActivity()).activity;
    }
    var scope = String(data.clubScope || "all");
    var permanent = String(data.permanentClubId || "").trim().toUpperCase();
    var category = String(data.category || "").trim();
    var clubFilter = 'activity="' + activity.id + '"';
    if (scope === "single" && permanent) {
      clubFilter += ' && permanent_club_id="' + permanent + '"';
    } else if (scope === "category" && category) {
      clubFilter += ' && category="' + category.replace(/"/g, '\\"') + '"';
    }
    var clubs = await pb().collection(C().clubs).getFullList({
      filter: clubFilter,
      sort: "name"
    });
    var groups = [];
    for (var i = 0; i < clubs.length; i++) {
      var club = clubs[i];
      var mems = await pb().collection(C().memberships).getFullList({
        filter:
          'activity="' +
          activity.id +
          '" && club="' +
          club.id +
          '" && status="active"',
        expand: "student"
      });
      var students = mems
        .map(function (m) {
          var stu = (m.expand && m.expand.student) || null;
          if (!stu) return null;
          if (stu.active === false) return null;
          var sid = String(stu.student_id || "");
          if (/^W[a-zA-Z0-9]+$/.test(sid) || /__WRR__/i.test(sid) || /^wrr/i.test(sid)) {
            return null;
          }
          var row = mapStudent(stu);
          row.permanentClubId = String(club.permanent_club_id || "").toUpperCase();
          row.membershipId = m.id;
          row.canUpload = m.can_upload !== false;
          row.role = m.role || "member";
          return row;
        })
        .filter(Boolean);
      var primary = students[0] || null;
      if (primary) primary.isPrimary = true;
      var seatVersion = mems.reduce(function (max, m) {
        var t = Date.parse(String(m.updated || m.created || ""));
        return Number.isFinite(t) && t > max ? t : max;
      }, 0);
      var seatUsed = primary ? 1 : 0;
      groups.push({
        activityId: activity.activity_id,
        permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
        clubName: club.name,
        category: club.category || "",
        active: club.active !== false,
        clubDisabled: club.active === false,
        seatStatus: primary ? "occupied" : "empty",
        seatQuota: 1,
        seatUsed: seatUsed,
        seatLabel: seatUsed + "/1",
        primaryUid: primary ? primary.uid : null,
        seatVersion: seatVersion || Date.now(),
        registeredCount: students.length,
        students: students
      });
    }
    if (scope === "single" && groups[0]) {
      var g = groups[0];
      return ok({
        clubs: groups,
        activityId: g.activityId,
        permanentClubId: g.permanentClubId,
        clubName: g.clubName,
        seatStatus: g.seatStatus,
        primaryUid: g.primaryUid,
        seatVersion: g.seatVersion,
        students: g.students
      });
    }
    return ok({ clubs: groups, nextPageToken: "" });
  }

  async function adminEnrollClubStudentBirth(data) {
    var activity = await getActivityRecord();
    var permanent = String(data.permanentClubId || "").trim().toUpperCase();
    var studentId = cfg().normalizeStudentId(data.studentId);
    var birth = String(data.birthYYYYMMDD || data.birthYmd || "").trim();
    if (!permanent || !studentId || !/^\d{8}$/.test(birth)) {
      return fail("請填寫社團、學號與生日（YYYYMMDD）。");
    }
    var club = await pb()
      .collection(C().clubs)
      .getFirstListItem(
        'activity="' + activity.id + '" && permanent_club_id="' + permanent + '" && active=true'
      );
    var email = cfg().studentIdToAuthEmail(studentId);
    var student;
    try {
      student = await pb().collection(C().students).getFirstListItem('student_id="' + studentId + '"');
    } catch (_e) {
      student = await pb().collection(C().students).create({
        email: email,
        emailVisibility: false,
        password: birth,
        passwordConfirm: birth,
        student_id: studentId,
        birth_ymd: birth,
        name: studentId,
        must_change_password: true,
        active: true,
        registered_at: new Date().toISOString()
      });
    }
    var seatHolders = await pb().collection(C().memberships).getFullList({
      filter:
        'activity="' + activity.id + '" && club="' + club.id + '" && status="active"'
    });
    var otherHolder = seatHolders.some(function (m) {
      return String(m.student) !== String(student.id);
    });
    if (otherHolder) {
      return fail("此社團名額已被占用，每個社團僅能有一個帳號。", "TARGET_SEAT_OCCUPIED");
    }
    var existing = await pb().collection(C().memberships).getList(1, 1, {
      filter:
        'activity="' + activity.id + '" && club="' + club.id + '" && student="' + student.id + '"'
    });
    try {
    if (existing.totalItems === 0) {
      await pb().collection(C().memberships).create({
        activity: activity.id,
        club: club.id,
        student: student.id,
        role: "member",
        status: "active",
        can_upload: true,
        bound_at: new Date().toISOString()
      });
    } else {
      await pb().collection(C().memberships).update(existing.items[0].id, {
        status: "active",
        can_upload: true
      });
      }
    } catch (seatCreateErr) {
      var seatMsg = String((seatCreateErr && seatCreateErr.message) || "");
      if (/unique|not_unique|idx_hksp_membership_one_active_seat/i.test(seatMsg)) {
        return fail("此社團名額已被占用，每個社團僅能有一個帳號。", "TARGET_SEAT_OCCUPIED");
      }
      throw seatCreateErr;
    }
    // Race guard: another active seat may have landed between check and write.
    var afterHolders = await pb().collection(C().memberships).getFullList({
      filter:
        'activity="' + activity.id + '" && club="' + club.id + '" && status="active"'
    });
    var extras = afterHolders.filter(function (m) {
      return String(m.student) !== String(student.id);
    });
    if (extras.length) {
      try {
        var mine = afterHolders.find(function (m) {
          return String(m.student) === String(student.id);
        });
        if (mine) {
          await pb().collection(C().memberships).delete(mine.id).catch(function () {
            return pb().collection(C().memberships).update(mine.id, {
              status: "revoked",
              can_upload: false
            });
          });
        }
      } catch (_roll) {
        /* ignore */
      }
      return fail("此社團名額已被占用，每個社團僅能有一個帳號。", "TARGET_SEAT_OCCUPIED");
    }
    return ok({
      studentId: studentId,
      uid: student.id,
      permanentClubId: permanent,
      mustChangePassword: !!student.must_change_password,
      seatStatus: "occupied",
      seatQuota: 1,
      seatUsed: 1,
      seatLabel: "1/1"
    });
  }

  async function adminResetClubStudentPassword(data) {
    var uid = String(data.uid || "").trim();
    var birth = String(data.birthYYYYMMDD || data.newPassword || "").trim();
    if (!uid || !birth) return fail("缺少學生或新密碼。");
    try {
      await pb().collection(C().students).update(uid, {
        password: birth,
        passwordConfirm: birth,
        must_change_password: true,
        birth_ymd: /^\d{8}$/.test(birth) ? birth : undefined
      });
      return ok({ uid: uid, mustChangePassword: true });
    } catch (e) {
      return fail((e && e.message) || "重設密碼失敗。");
    }
  }

  async function adminUnbindClubStudent(_data) {
    // Policy A: only「刪除帳號」releases seat + account. Unbind is disabled.
    return fail(
      "已停用解除綁定。名額與帳號僅能透過「刪除帳號」一併釋放。",
      "UNBIND_DISABLED"
    );
  }

  async function adminRebindClubStudent(_data) {
    // Policy A: rebind would free the source seat without deleting the account.
    return fail(
      "已停用改綁社團。名額與帳號僅能透過「刪除帳號」一併釋放；若選錯社請刪除後重新註冊。",
      "REBIND_DISABLED"
    );
  }

  async function loadWrongRegInventory(activity, uid, studentId) {
    var student;
    try {
      student = await pb().collection(C().students).getOne(uid);
    } catch (_e) {
      student = null;
    }
    var memberships = [];
    try {
      memberships = await pb().collection(C().memberships).getFullList({
        filter: 'student="' + uid + '"',
        expand: "club,activity"
      });
    } catch (_e2) {
      memberships = [];
    }
    var activityMemberships = memberships.filter(function (m) {
      return String(m.activity) === String(activity.id);
    });
    var uploadCount = 0;
    try {
      var ups = await pb().collection(C().uploads).getList(1, 1, {
        filter: 'activity="' + activity.id + '" && student="' + uid + '"'
      });
      uploadCount = Number(ups.totalItems) || 0;
    } catch (_e3) {
      uploadCount = -1;
    }
    var primarySeats = activityMemberships
      .filter(function (m) {
        return m.status === "active";
      })
      .map(function (m) {
        var club = (m.expand && m.expand.club) || null;
        var seatVersion = Date.parse(String(m.updated || m.created || ""));
        return {
          membershipId: m.id,
          permanentClubId: club
            ? String(club.permanent_club_id || "").toUpperCase()
            : "",
          clubName: club ? club.name || "" : "",
          seatVersion: Number.isFinite(seatVersion) ? seatVersion : Date.now()
        };
      });
    return {
      student: student,
      memberships: memberships,
      activityMemberships: activityMemberships,
      primarySeats: primarySeats,
      uploadCount: uploadCount,
      authEmail: studentId ? cfg().studentIdToAuthEmail(studentId) : null
    };
  }

  async function adminPreviewWrongRegistrationReset(data) {
    var requestedActivityId = String((data && data.activityId) || "").trim();
    var uid = String((data && data.uid) || "").trim();
    var studentId = cfg().normalizeStudentId((data && data.studentId) || "");
    if (!uid) return fail("需要 UID。", "INVALID_UID");
    if (!studentId) return fail("需要學號。", "INVALID_STUDENT_ID");
    var activity;
    try {
      activity = requestedActivityId
        ? await getActivityByActivityId(requestedActivityId)
        : (await resolveActiveActivity()).activity;
    } catch (_e) {
      return fail("找不到活動。", "ACTIVITY_NOT_FOUND");
    }
    var inv = await loadWrongRegInventory(activity, uid, studentId);
    if (!inv.student) {
      return fail("找不到該帳號；請核對 UID。", "ACCOUNT_NOT_FOUND");
    }
    if (cfg().normalizeStudentId(inv.student.student_id) !== studentId) {
      return fail("帳號學號與輸入不符。", "STUDENT_ID_MISMATCH");
    }
    return ok({
      action: "previewWrongRegistrationReset",
      activityId: activity.activity_id,
      uid: uid,
      studentId: studentId,
      authEmail: inv.authEmail,
      willDelete: {
        authUser: true,
        clubStudentAccounts: true,
        memberships: inv.activityMemberships.length,
        primarySeatsToRelease: inv.primarySeats.map(function (s) {
          return {
            permanentClubId: s.permanentClubId,
            seatVersion: s.seatVersion
          };
        }),
        authCreator: false,
        birthVault: !!(inv.student && inv.student.birth_ymd)
      },
      willPreserve: {
        cloudLinks: true,
        scoresAndFormSubmissions: true,
        cloudParticipation: true,
        driveFilesAndUploadRecords: true,
        driveUploadRecordsCounted: inv.uploadCount
      },
      distinctionFromUnbind:
        "解除綁定／改綁已停用。僅「刪除帳號」會刪除 Auth／帳號並釋放名額，同學號可重新註冊。"
    });
  }

  async function releaseMembershipsForStudent(uid) {
    var mems = [];
    try {
      mems = await pb().collection(C().memberships).getFullList({
        filter: 'student="' + uid + '"'
      });
    } catch (_listErr) {
      mems = [];
    }
    var released = 0;
    var failed = [];
    for (var i = 0; i < mems.length; i++) {
      var mem = mems[i];
      var okRelease = false;
      try {
        await pb().collection(C().memberships).delete(mem.id);
        okRelease = true;
      } catch (_mDel) {
        try {
      await pb().collection(C().memberships).update(mem.id, {
        status: "revoked",
        can_upload: false
      });
          okRelease = true;
        } catch (_mUp) {
          failed.push(mem.id);
        }
      }
      if (okRelease) released += 1;
    }
    var stillActive = [];
    try {
      stillActive = await pb().collection(C().memberships).getFullList({
        filter: 'student="' + uid + '" && status="active"'
      });
    } catch (_recheckErr) {
      stillActive = [];
    }
    return {
      found: mems.length,
      released: released,
      failedIds: failed,
      stillActive: stillActive.length
    };
  }

  async function destroyStudentAccountForReregister(student, studentId) {
    var uid = student.id;
    var originalId = cfg().normalizeStudentId(studentId || student.student_id || "");
    var originalEmail = String(
      student.email || (originalId ? cfg().studentIdToAuthEmail(originalId) : "")
    ).trim().toLowerCase();

    function identifiersStillHeld(row) {
      if (!row) return false;
      var sid = cfg().normalizeStudentId(row.student_id);
      var em = String(row.email || "").trim().toLowerCase();
      var un = String(row.username || "").trim().toLowerCase();
      if (originalId && sid === originalId) return true;
      if (originalEmail && (em === originalEmail || un === originalEmail)) return true;
      return false;
    }

    // Prefer hard delete so student_id + email are fully removed (ACL now allows admin).
    try {
      await pb().collection(C().students).delete(uid);
      try {
        await pb().collection(C().students).getOne(uid);
        throw new Error("硬刪後帳號仍存在。");
      } catch (goneErr) {
        if (/硬刪後帳號仍存在/.test(String(goneErr && goneErr.message))) throw goneErr;
        // getOne failed → record gone (expected)
      }
      return { authDeleted: true, mode: "hard" };
    } catch (delErr) {
      if (/硬刪後帳號仍存在/.test(String(delErr && delErr.message))) throw delErr;

      // Soft fallback: MUST free email first (blocks re-register), then student_id.
      var stamp = String(Date.now());
      var short = String(uid || "x").replace(/[^a-zA-Z0-9]/g, "").slice(-6) || "x";
      var freedId = ("W" + short + stamp.slice(-10)).slice(0, 20);
      var freedEmail = ("w" + stamp.slice(-10) + short + "@stu.hksp25.invalid").slice(0, 120);
      var freedUser = ("w" + short + stamp).slice(0, 100);
      var randPass = "Wrr" + stamp + "x!";

      async function mustUpdate(patch, label) {
        await pb().collection(C().students).update(uid, patch);
        var after = await pb().collection(C().students).getOne(uid);
        return after;
      }

      var after;
      try {
        // Email first — historical bug left student_id renamed but email still held.
        after = await mustUpdate(
          { email: freedEmail, emailVisibility: false, username: freedUser },
          "email"
        );
        if (String(after.email || "").trim().toLowerCase() === originalEmail) {
          throw new Error("Email 未能釋放。");
        }
        after = await mustUpdate({ student_id: freedId }, "student_id");
        if (cfg().normalizeStudentId(after.student_id) === originalId) {
          throw new Error("學號未能釋放。");
        }
        try {
          after = await mustUpdate(
            {
              password: randPass,
              passwordConfirm: randPass,
              must_change_password: true,
              active: false
            },
            "lock"
          );
        } catch (_lockErr) {
          // Non-fatal if identifiers already freed.
          after = await pb().collection(C().students).getOne(uid);
        }
      } catch (softErr) {
        throw new Error(
          "無法刪除／釋放學號與 Email（" +
            ((softErr && softErr.message) || "update failed") +
            "）。硬刪也失敗：" +
            ((delErr && delErr.message) || "delete failed")
        );
      }

      if (identifiersStillHeld(after)) {
        throw new Error(
          "刪除後學號／Email 仍被占用。請到 PocketBase 超管後台刪除該學生列。"
        );
      }
      return { authDeleted: true, mode: "soft" };
    }
  }

  function studentRowMatchesId(row, normalized, email) {
    if (!row) return false;
    var want = String(normalized || "").toLowerCase();
    var sid = String(row.student_id || "").trim().toLowerCase();
    var em = String(row.email || "").trim().toLowerCase();
    var un = String(row.username || "").trim().toLowerCase();
    if (sid === want) return true;
    if (em === email || un === email) return true;
    if (un === want) return true;
    // Soft-tombstone emails / usernames that still embed the student id.
    if (want && (em.indexOf(want) >= 0 || un.indexOf(want) >= 0 || sid.indexOf(want) >= 0)) {
      return true;
    }
    return false;
  }

  async function findStudentAuthByStudentId(studentId) {
    var normalized = cfg().normalizeStudentId(studentId);
    if (!normalized) return null;
    var email = cfg().studentIdToAuthEmail(normalized);
    var candidates = [normalized, normalized.toLowerCase(), String(studentId || "").trim()];
    var seen = Object.create(null);
    for (var i = 0; i < candidates.length; i++) {
      var id = candidates[i];
      if (!id || seen[id]) continue;
      seen[id] = true;
      try {
        return await pb()
          .collection(C().students)
          .getFirstListItem('student_id="' + id + '"');
      } catch (_byId) {
        /* try next */
      }
    }
    try {
      return await pb().collection(C().students).getFirstListItem('email="' + email + '"');
    } catch (_byEmail) {
      /* continue */
    }
    try {
      return await pb().collection(C().students).getFirstListItem('username="' + email + '"');
    } catch (_byUser) {
      /* continue */
    }
    // Full scan: soft-deleted rows may have renamed student_id/email but kept username.
    try {
      var rows = await pb().collection(C().students).getFullList();
      for (var r = 0; r < rows.length; r++) {
        if (studentRowMatchesId(rows[r], normalized, email)) return rows[r];
      }
    } catch (_scanErr) {
      /* ignore */
    }
    return null;
  }

  /** Free a leftover Auth row by student_id even when club seat list is already empty. */
  async function adminPurgeStudentByStudentId(data) {
    var studentId = cfg().normalizeStudentId((data && data.studentId) || "");
    var clientRequestId = String((data && data.clientRequestId) || "").trim();
    var confirmPhrase = String((data && data.confirmPhrase) || "").trim();
    var reason = String((data && data.reason) || "purge_orphan_auth").slice(0, 200);
    if (!studentId) return fail("需要學號。", "INVALID_STUDENT_ID");
    if (!clientRequestId || clientRequestId.length < 8) {
      return fail("需要可追蹤的請求編號。", "INVALID_CLIENT_REQUEST_ID");
    }
    if (confirmPhrase !== "RESET_WRONG_REGISTRATION") {
      return fail("請確認輸入 RESET_WRONG_REGISTRATION。", "CONFIRM_PHRASE_REQUIRED");
    }

    var student = await findStudentAuthByStudentId(studentId);
    if (!student) {
      return ok({
        authDeleted: true,
        idempotent: true,
        studentId: studentId,
        seatReleased: true,
        seatStatus: "empty",
        notFound: true,
        message:
          "後台未找到此學號的 student_id／email／username。請再試註冊；若仍顯示已有帳號，到 PocketBase → hksp_students 搜尋該學號並刪除。"
      });
    }

    var uid = student.id;
    var release = await releaseMembershipsForStudent(uid);
    if (release.stillActive > 0) {
      return fail(
        "無法釋放社團名額（仍有 " + release.stillActive + " 筆有效綁定）。",
        "SEAT_RELEASE_FAILED"
      );
    }

    var destroyed;
    try {
      destroyed = await destroyStudentAccountForReregister(student, studentId);
    } catch (destroyErr) {
      return fail(
        (destroyErr && destroyErr.message) || "清除殘留帳號失敗。",
        "AUTH_DESTROY_FAILED"
      );
    }

    // Post-verify: original student_id/email/username must no longer resolve.
    var leftover = await findStudentAuthByStudentId(studentId);
    if (leftover && String(leftover.id) === String(uid) && destroyed.mode === "hard") {
      leftover = null;
    }
    if (leftover && String(leftover.id) === String(uid) && destroyed.mode === "soft") {
      var wantEmail = cfg().studentIdToAuthEmail(studentId);
      if (studentRowMatchesId(leftover, studentId, wantEmail)) {
        return fail(
          "清除後學號／Email／username 仍被占用（mode=soft）。請到 PocketBase 超管後台刪除該學生。",
          "AUTH_STILL_HELD"
        );
      }
    } else if (leftover && String(leftover.id) !== String(uid)) {
      return fail(
        "仍有另一筆帳號占用此學號／Email／username。請再到後台按一次清除，或到 PocketBase 刪除。",
        "AUTH_STILL_HELD"
      );
    }

    try {
      await pb().collection(C().audit).create({
        event_key: "purge_student_by_student_id",
        event_type: "security",
        actor_staff: pb().authStore.model && pb().authStore.model.id,
        target_type: "hksp_students",
        target_id: uid,
        payload_json: {
          studentId: studentId,
          clientRequestId: clientRequestId,
          reason: reason,
          mode: destroyed.mode,
          membershipsReleased: release.released
        },
        occurred_at: new Date().toISOString()
      });
    } catch (_auditErr) {
      /* non-blocking */
    }

    return ok({
      authDeleted: true,
      idempotent: false,
      uid: uid,
      studentId: studentId,
      clientRequestId: clientRequestId,
      reason: reason,
      mode: destroyed.mode,
      membershipsReleased: release.released,
      seatReleased: true,
      seatStatus: "empty",
      message:
        destroyed.mode === "hard"
          ? "已硬刪殘留帳號，同學號可重新註冊。"
          : "已釋放學號／Email（軟刪），同學號可重新註冊。"
    });
  }

  async function adminResetWrongRegistration(data) {
    var requestedActivityId = String((data && data.activityId) || "").trim();
    var uid = String((data && data.uid) || "").trim();
    var studentId = cfg().normalizeStudentId((data && data.studentId) || "");
    var clientRequestId = String((data && data.clientRequestId) || "").trim();
    var confirmPhrase = String((data && data.confirmPhrase) || "").trim();
    var reason = String((data && data.reason) || "wrong_registration_reset").slice(0, 200);
    var expectedSeatVersion =
      data && data.expectedSeatVersion != null && data.expectedSeatVersion !== ""
        ? Number(data.expectedSeatVersion)
        : null;

    if (!uid) return fail("需要 UID。", "INVALID_UID");
    if (!studentId) return fail("需要學號。", "INVALID_STUDENT_ID");
    if (!clientRequestId || clientRequestId.length < 8) {
      return fail("需要可追蹤的請求編號。", "INVALID_CLIENT_REQUEST_ID");
    }
    if (confirmPhrase !== "RESET_WRONG_REGISTRATION") {
      return fail("請確認輸入 RESET_WRONG_REGISTRATION。", "CONFIRM_PHRASE_REQUIRED");
    }

    var activity;
    try {
      activity = requestedActivityId
        ? await getActivityByActivityId(requestedActivityId)
        : (await resolveActiveActivity()).activity;
    } catch (_e) {
      return fail("找不到活動。", "ACTIVITY_NOT_FOUND");
    }

    var inv = await loadWrongRegInventory(activity, uid, studentId);
    if (!inv.student) {
      // Seat list may be empty while Auth row still holds student_id — purge by id.
      var byId = await adminPurgeStudentByStudentId({
        studentId: studentId,
        clientRequestId: clientRequestId,
        confirmPhrase: confirmPhrase,
        reason: reason || "wrong_registration_reset_orphan"
      });
      if (byId && byId.success) {
        return Object.assign({}, byId, {
          uid: byId.uid || uid,
          activityId: activity.activity_id
        });
      }
      return byId;
    }
    if (cfg().normalizeStudentId(inv.student.student_id) !== studentId) {
      if (!/^(W|wrr)/i.test(String(inv.student.student_id || ""))) {
        return fail("帳號學號與輸入不符。", "STUDENT_ID_MISMATCH");
      }
    }

    if (Number.isFinite(expectedSeatVersion)) {
      var currentSeatVersion = (inv.primarySeats || []).reduce(function (max, s) {
        var v = Number(s && s.seatVersion);
        return Number.isFinite(v) && v > max ? v : max;
      }, 0);
      if (!currentSeatVersion || expectedSeatVersion !== currentSeatVersion) {
        return fail(
          "座位狀態已變更，請重新整理名單後再確認刪除。",
          "SEAT_VERSION_CONFLICT"
        );
      }
    }

    // Destroy Auth first when possible (hard delete cascades memberships).
    var destroyed;
    try {
      destroyed = await destroyStudentAccountForReregister(inv.student, studentId);
    } catch (destroyErr) {
      return fail(
        (destroyErr && destroyErr.message) || "刪除帳號失敗，學號可能尚未釋放。",
        "AUTH_DESTROY_FAILED"
      );
    }

    var release = await releaseMembershipsForStudent(uid);
    if (release.stillActive > 0) {
      return fail(
        "帳號已處理，但仍有 " +
          release.stillActive +
          " 筆有效綁定未釋放。請再試一次或檢查 memberships。",
        "SEAT_RELEASE_FAILED"
      );
    }

    try {
      await pb().collection(C().audit).create({
        event_key: "wrong_registration_reset",
        event_type: "security",
        actor_staff: pb().authStore.model && pb().authStore.model.id,
        target_type: "hksp_students",
        target_id: uid,
        payload_json: {
          studentId: studentId,
          activityId: activity.activity_id,
          clientRequestId: clientRequestId,
          reason: reason,
          mode: destroyed.mode,
          membershipsReleased: release.released
        },
        occurred_at: new Date().toISOString()
      });
    } catch (_auditErr) {
      /* non-blocking */
    }

    return ok({
      authDeleted: true,
      idempotent: false,
      uid: uid,
      studentId: studentId,
      activityId: activity.activity_id,
      clientRequestId: clientRequestId,
      reason: reason,
      mode: destroyed.mode,
      membershipsReleased: release.released,
      seatReleased: true,
      seatStatus: "empty"
    });
  }

  async function getEventConfig() {
    var activity = await getActivityRecord();
    var config = eventConfigFromActivity(activity);
    return ok({
      config: config,
      source: "pocketbase",
      updateTime: String(activity.updated || new Date().toISOString()),
      serverNow: new Date().toISOString()
    });
  }

  async function adminSaveEventConfig(data) {
    var activity = await getActivityRecord();
    var conflict = assertExpectedUpdateTime(activity, data);
    if (conflict) return conflict;
    var conf = Object.assign({}, activity.config_json || {});
    ["dataDeadline", "formDeadline", "featureDeadline", "eventStart", "eventEnd"].forEach(
      function (key) {
        if (data[key]) conf[key] = data[key];
      }
    );
    conf.timezone = conf.timezone || "Asia/Taipei";
    var patch = { config_json: conf };
    if (conf.dataDeadline) {
      var ms = Date.parse(String(conf.dataDeadline));
      if (Number.isFinite(ms)) patch.upload_close_at = new Date(ms).toISOString();
    }
    var updated = await pb().collection(C().activities).update(activity.id, patch);
    return ok({
      config: eventConfigFromActivity(updated),
      source: "pocketbase",
      updateTime: String(updated.updated || new Date().toISOString())
    });
  }

  async function adminGetCloudUploadSettings() {
    var activity = await getActivityRecord();
    var settings = uploadSettingsFromActivity(activity);
    return ok({
      evaluation: settings.evaluation,
      feature: settings.feature
    });
  }

  async function adminSaveEvaluationUploadSettings(data) {
    var activity = await getActivityRecord();
    var conf = Object.assign({}, activity.config_json || {});
    var verConflict = assertExpectedNumericVersion(
      conf.evaluationVersion || 1,
      data.expectedVersion,
      "評選上傳設定"
    );
    if (verConflict) return verConflict;
    if (data.deadlineAt) conf.dataDeadline = data.deadlineAt;
    conf.evaluationMakeup = {
      deadlineAt: data.makeupDeadlineAt || null,
      clubIds: Array.isArray(data.makeupClubIds) ? data.makeupClubIds : [],
      version: Number((conf.evaluationMakeup && conf.evaluationMakeup.version) || 1) + 1
    };
    conf.evaluationVersion = Number(conf.evaluationVersion || 1) + 1;
    var patch = { config_json: conf };
    if (conf.dataDeadline) {
      var ms = Date.parse(String(conf.dataDeadline));
      if (Number.isFinite(ms)) patch.upload_close_at = new Date(ms).toISOString();
    }
    var updated = await pb().collection(C().activities).update(activity.id, patch);
    var settings = uploadSettingsFromActivity(updated);
    return ok({ evaluation: settings.evaluation, feature: settings.feature });
  }

  async function adminSaveFeatureUploadSettings(data) {
    var activity = await getActivityRecord();
    var conf = Object.assign({}, activity.config_json || {});
    var verConflict = assertExpectedNumericVersion(
      conf.featureVersion || 1,
      data.expectedVersion,
      "特色上傳設定"
    );
    if (verConflict) return verConflict;
    if (data.deadlineAt) conf.featureDeadline = data.deadlineAt;
    // Drive 共用夾已非主路徑；不再從後台寫入 featureFolderUrl。
    if (Object.prototype.hasOwnProperty.call(conf, "featureFolderUrl")) {
      delete conf.featureFolderUrl;
    }
    conf.featureMakeup = {
      deadlineAt: data.makeupDeadlineAt || null,
      clubIds: Array.isArray(data.makeupClubIds) ? data.makeupClubIds : [],
      version: Number((conf.featureMakeup && conf.featureMakeup.version) || 1) + 1
    };
    conf.featureVersion = Number(conf.featureVersion || 1) + 1;
    var updated = await pb().collection(C().activities).update(activity.id, {
      config_json: conf
    });
    var settings = uploadSettingsFromActivity(updated);
    return ok({ evaluation: settings.evaluation, feature: settings.feature });
  }

  async function adminGetUploadGate() {
    var activity = await getActivityRecord();
    return ok({
      gate: uploadSettingsFromActivity(activity).gate,
      serverNow: new Date().toISOString()
    });
  }

  async function adminSetUploadGate(data) {
    var activity = await getActivityRecord();
    var conf = Object.assign({}, activity.config_json || {});
    var prev = conf.uploadGate || { open: true, version: 1 };
    var verConflict = assertExpectedNumericVersion(
      prev.version || 1,
      data.expectedVersion,
      "上傳開關"
    );
    if (verConflict) return verConflict;
    conf.uploadGate = {
      open: data.open !== false && data.open !== "false",
      version: Number(prev.version || 1) + 1,
      updatedAt: new Date().toISOString()
    };
    var updated = await pb().collection(C().activities).update(activity.id, {
      config_json: conf
    });
    return ok({
      gate: uploadSettingsFromActivity(updated).gate,
      serverNow: new Date().toISOString()
    });
  }

  async function adminPreviewUploadGateOpen() {
    var activity = await getActivityRecord();
    return ok({
      gate: uploadSettingsFromActivity(activity).gate,
      readiness: { gaps: [] },
      serverNow: new Date().toISOString()
    });
  }

  async function adminListJudges() {
    var rows = await pb().collection(C().staff).getFullList({
      filter: 'role="judge" || role="admin"',
      sort: "email"
    });
    var judges = rows
      .filter(function (r) {
        return r.role === "judge";
      })
      .map(mapJudgeAdmin);
    var activity = null;
    var scoreConfig = defaultScoreConfig();
    try {
      activity = await getActivityRecord();
      scoreConfig = (activity.config_json && activity.config_json.scoreConfig) || scoreConfig;
    } catch (_e) {
      /* keep default */
    }
    var availableScoreSections = (scoreConfig.sections || [])
      .filter(function (s) {
        if (!s || s.enabled === false) return false;
        // 缺 scoringMode 時視為 judge（與評審端一致）
        return s.scoringMode !== "manual";
      })
      .map(function (s) {
        return {
          id: s.id,
          key: s.id,
          name: s.name || s.id,
          icon: s.icon || "📌",
          maxScore: Number(s.maxScore) || 0,
          scoringMode: s.scoringMode || "judge",
          published: s.published === true
        };
      });
    return ok({
      judges: judges,
      availableScoreSections: availableScoreSections,
      scoreSections: availableScoreSections
    });
  }

  function defaultScoreConfig() {
    return {
      revision: 1,
      totalMaxScore: 0,
      sections: []
    };
  }

  function scoreNum(v) {
    if (v === "" || v === null || v === undefined) return 0;
    var n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * 10000) / 10000;
  }

  /** Mirror admin.html validateClientScore — required by publish gate. */
  function validateScoreConfig(cfg) {
    var errors = [];
    var config = cfg && typeof cfg === "object" ? cfg : { sections: [], totalMaxScore: 0 };
    var sections = (config.sections || []).filter(function (s) {
      return s && s.enabled !== false;
    });

    if (scoreNum(config.totalMaxScore) < 0) {
      errors.push("總配分不得小於 0。");
    }

    sections.forEach(function (s) {
      if (!String(s.name || "").trim()) errors.push("有大項尚未填寫名稱。");
      if (scoreNum(s.maxScore) < 0) {
        errors.push("大項「" + (s.name || "") + "」不得為負分。");
      }
      var groups = (s.groups || []).filter(function (g) {
        return g && g.enabled !== false;
      });
      if (!groups.length) {
        errors.push("大項「" + (s.name || "") + "」至少需要一個啟用分類。");
      }
      var groupsSum = 0;
      groups.forEach(function (g) {
        if (!String(g.name || "").trim()) {
          errors.push("「" + (s.name || "") + "」有分類未命名。");
        }
        var criteria = (g.criteria || []).filter(function (c) {
          return c && c.enabled !== false;
        });
        if (!criteria.length) {
          errors.push(
            "分類「" + (s.name || "") + " → " + (g.name || "") + "」至少需要一個啟用小項。"
          );
        }
        var criteriaSum = 0;
        criteria.forEach(function (c) {
          if (!String(c.name || "").trim()) {
            errors.push(
              "「" + (s.name || "") + " → " + (g.name || "") + "」有小項未命名。"
            );
          }
          if (scoreNum(c.maxScore) < 0) {
            errors.push("小項「" + (c.name || "") + "」不得為負分。");
          }
          criteriaSum += scoreNum(c.maxScore);
        });
        if (Math.abs(criteriaSum - scoreNum(g.maxScore)) > 0.000001) {
          errors.push(
            "分類「" +
              (s.name || "") +
              " → " +
              (g.name || "") +
              "」：設定 " +
              scoreNum(g.maxScore) +
              "，小項合計 " +
              criteriaSum +
              "。"
          );
        }
        groupsSum += scoreNum(g.maxScore);
      });
      if (Math.abs(groupsSum - scoreNum(s.maxScore)) > 0.000001) {
        errors.push(
          "大項「" +
            (s.name || "") +
            "」：設定 " +
            scoreNum(s.maxScore) +
            "，分類合計 " +
            groupsSum +
            "。"
        );
      }
    });

    var sectionsSum = sections.reduce(function (a, s) {
      return a + scoreNum(s.maxScore);
    }, 0);
    if (Math.abs(sectionsSum - scoreNum(config.totalMaxScore)) > 0.000001) {
      errors.push(
        "總配分設定 " +
          scoreNum(config.totalMaxScore) +
          "，啟用大項合計 " +
          sectionsSum +
          "。"
      );
    }

    return {
      valid: errors.length === 0,
      errors: errors,
      total: sectionsSum
    };
  }

  async function adminGetScoreConfig() {
    var activity = await getActivityRecord();
    var conf = activity.config_json || {};
    var scoreConfig = conf.scoreConfig || defaultScoreConfig();
    return ok({
      config: scoreConfig,
      validation: validateScoreConfig(scoreConfig),
      source: "pocketbase",
      updateTime: String(activity.updated || new Date().toISOString())
    });
  }

  async function adminSaveScoreConfig(data) {
    var activity = await getActivityRecord();
    var conflict = assertExpectedUpdateTime(activity, data);
    if (conflict) return conflict;
    var conf = Object.assign({}, activity.config_json || {});
    var next = data.config || data.scoreConfig || null;
    if (!next || typeof next !== "object") return fail("缺少配分表內容。");
    // Validate the payload the admin editor sent (before syncing totals).
    var validation = validateScoreConfig(next);
    next.revision = Number(conf.scoreConfig && conf.scoreConfig.revision) + 1 || 1;
    next.updatedAt = new Date().toISOString();
    var total = 0;
    (next.sections || []).forEach(function (s) {
      if (s && s.enabled !== false) total += Number(s.maxScore) || 0;
    });
    // Keep totalMaxScore aligned with enabled section max scores after save.
    next.totalMaxScore = scoreNum(total);
    conf.scoreConfig = next;
    var updated = await pb().collection(C().activities).update(activity.id, {
      config_json: conf
    });
    // Re-validate saved shape (post-sync) so publish gate matches stored config.
    validation = validateScoreConfig(next);
    return ok({
      config: next,
      validation: validation,
      source: "pocketbase",
      updateTime: String(updated.updated || next.updatedAt)
    });
  }

  async function adminSetScorePhasePublished(data) {
    var activity = await getActivityRecord();
    var conflict = assertExpectedUpdateTime(activity, data);
    if (conflict) return conflict;
    var conf = Object.assign({}, activity.config_json || {});
    var scoreConfig = Object.assign({}, conf.scoreConfig || defaultScoreConfig());
    var sectionId = String(data.sectionId || data.id || "").trim();
    var published = data.published !== false && data.published !== "false";
    scoreConfig.sections = (scoreConfig.sections || []).map(function (s) {
      if (String(s.id) !== sectionId) return s;
      return Object.assign({}, s, {
        published: published,
        publishedAt: published ? new Date().toISOString() : null
      });
    });
    scoreConfig.revision = Number(scoreConfig.revision || 1) + 1;
    conf.scoreConfig = scoreConfig;
    var updated = await pb().collection(C().activities).update(activity.id, {
      config_json: conf
    });
    return ok({
      config: scoreConfig,
      source: "pocketbase",
      updateTime: String(updated.updated || new Date().toISOString())
    });
  }

  async function adminUnlockJudgeScore(data) {
    var activity = await getActivityRecord();
    var judgeId = String(data.judgeId || data.judge || "").trim();
    var sectionId = String(data.sectionId || "").trim();
    var permanent = String(data.permanentClubId || "").trim().toUpperCase();
    var clubName = String(data.clubName || "").trim();
    if (!judgeId || !sectionId) return fail("缺少評審或評分大項。");
    var club;
    if (permanent) {
      club = await pb()
        .collection(C().clubs)
        .getFirstListItem(
          'activity="' + activity.id + '" && permanent_club_id="' + permanent + '"'
        );
    } else if (clubName) {
      club = await pb()
        .collection(C().clubs)
        .getFirstListItem(
          'activity="' + activity.id + '" && name="' + clubName.replace(/"/g, '\\"') + '"'
        );
    } else {
      return fail("缺少社團。");
    }
    var res = await pb().collection(C().scores).getList(1, 1, {
      filter:
        'activity="' +
        activity.id +
        '" && club="' +
        club.id +
        '" && judge="' +
        judgeId +
        '" && section_id="' +
        sectionId +
        '"'
    });
    if (!res.totalItems) return fail("找不到已送出的評分紀錄。");
    var row = res.items[0];
    var answers =
      row.answers_json && typeof row.answers_json === "object" ? Object.assign({}, row.answers_json) : {};
    var unlockedAt = new Date().toISOString();
    var unlockReason = String(data.reason || data.unlockReason || "").trim();
    var conf = activity.config_json || {};
    var scoreConfig = conf.scoreConfig || {};
    var section =
      (scoreConfig.sections || []).find(function (s) {
        return String(s.id) === sectionId;
      }) || null;
    var history = Array.isArray(answers.history) ? answers.history.slice() : [];
    history.push({
      submissionRevision: Number(row.revision || 1) || 1,
      totalScore: Number(row.score != null ? row.score : row.total_score) || 0,
      scores: answers.scores && typeof answers.scores === "object" ? answers.scores : {},
      comment: String(row.comment || ""),
      submittedAt: answers.submittedAt || row.submitted_at || row.updated || "",
      unlockedAt: unlockedAt,
      unlockReason: unlockReason,
      capturedAt: unlockedAt,
      sectionSnapshot: section
        ? {
            id: section.id,
            name: section.name || "",
            groups: Array.isArray(section.groups) ? section.groups : []
          }
        : null
    });
    answers.history = history;
    answers.reopened = true;
    answers.locked = false;
    answers.unlockedAt = unlockedAt;
    if (unlockReason) answers.unlockReason = unlockReason;
    var updated = await pb().collection(C().scores).update(row.id, {
      answers_json: answers,
      status: "draft"
    });
    return ok({
      id: updated.id,
      reopened: true,
      unlockedAt: unlockedAt,
      historyCount: history.length
    });
  }

  async function adminGetJudgeScoreHistory(data) {
    var activity = await getActivityRecord();
    var judgeId = String(data.judgeId || data.judge || "").trim();
    var sectionId = String(data.sectionId || "").trim();
    var permanent = String(data.permanentClubId || "").trim().toUpperCase();
    var clubName = String(data.clubName || "").trim();
    if (!judgeId || !sectionId) return fail("缺少評審或評分大項。");
    var club;
    try {
      if (permanent) {
        club = await pb()
          .collection(C().clubs)
          .getFirstListItem(
            'activity="' + activity.id + '" && permanent_club_id="' + permanent + '"'
          );
      } else if (clubName) {
        club = await pb()
          .collection(C().clubs)
          .getFirstListItem(
            'activity="' + activity.id + '" && name="' + clubName.replace(/"/g, '\\"') + '"'
          );
      } else {
        return fail("缺少社團。");
      }
    } catch (_e) {
      return fail("找不到社團。");
    }
    var res = await pb().collection(C().scores).getList(1, 1, {
      filter:
        'activity="' +
        activity.id +
        '" && club="' +
        club.id +
        '" && judge="' +
        judgeId +
        '" && section_id="' +
        sectionId +
        '"'
    });
    if (!res.totalItems) {
      return ok({ history: [], historyCount: 0 });
    }
    var answers =
      res.items[0].answers_json && typeof res.items[0].answers_json === "object"
        ? res.items[0].answers_json
        : {};
    var history = Array.isArray(answers.history) ? answers.history.slice() : [];
    return ok({
      history: history,
      historyCount: history.length,
      current: {
        status: res.items[0].status || "",
        totalScore: Number(res.items[0].score != null ? res.items[0].score : 0) || 0,
        reopened: answers.reopened === true,
        locked: answers.locked === true,
        unlockedAt: answers.unlockedAt || null
      }
    });
  }

  async function adminJudgeScoreProgress() {
    var activity = await getActivityRecord();
    var conf = activity.config_json || {};
    var scoreConfig = conf.scoreConfig || defaultScoreConfig();
    var judges = (await pb().collection(C().staff).getFullList({
      filter: 'role="judge"',
      sort: "email"
    })).map(mapJudgeAdmin);
    var clubs = await pb().collection(C().clubs).getFullList({
      filter: 'activity="' + activity.id + '" && active=true',
      sort: "name"
    });
    var scores = await pb().collection(C().scores).getFullList({
      filter: 'activity="' + activity.id + '"'
    });
    var byKey = {};
    scores.forEach(function (row) {
      var jid =
        row.judge && typeof row.judge === "object" ? row.judge.id : row.judge;
      var cid = row.club && typeof row.club === "object" ? row.club.id : row.club;
      var sid = row.section_id || (row.answers_json && row.answers_json.sectionId) || "";
      if (!jid || !cid || !sid) return;
      byKey[jid + "::" + cid + "::" + sid] = row;
    });
    var sections = publishedSectionsOf(scoreConfig);
    var totalExpected = 0;
    var totalSubmitted = 0;
    var totalDraft = 0;
    var totalReopened = 0;
    var totalNotStarted = 0;

    var rows = judges.map(function (judge) {
      var allowedSections = Array.isArray(judge.scoreSectionIds) ? judge.scoreSectionIds : [];
      // 空指派＝不能評任何大項（不再退回全部）。
      var judgeSections = !allowedSections.length
        ? []
        : sections.filter(function (section) {
            return allowedSections.indexOf(section.id) >= 0;
          });

      var submittedCount = 0;
      var draftCount = 0;
      var reopenedCount = 0;
      var notStartedCount = 0;
      var expected = 0;

      var sectionProgress = judgeSections.map(function (section) {
        var sectionSubmitted = 0;
        var sectionDraft = 0;
        var sectionReopened = 0;
        var sectionNotStarted = 0;
        var clubRows = clubs
          .filter(function (club) {
            var row = byKey[judge.id + "::" + club.id + "::" + section.id];
            if (row) return true;
            var cats = Array.isArray(judge.categories) ? judge.categories : [];
            if (!cats.length) return false;
            var cat = normalizeCategoryLabel(club.category);
            var set = {};
            cats.forEach(function (c) {
              set[normalizeCategoryLabel(c)] = true;
              set[String(c || "").trim()] = true;
            });
            return !!(set[cat] || set[String(club.category || "").trim()]);
          })
          .map(function (club) {
          var row = byKey[judge.id + "::" + club.id + "::" + section.id];
          var answers = (row && row.answers_json) || {};
          var reopened = !!(answers && answers.reopened);
            var status = !row
              ? "not_started"
              : reopened
                ? "reopened"
                : row.status === "submitted"
                  ? "submitted"
                  : "draft";
            if (status === "submitted") {
              sectionSubmitted += 1;
              submittedCount += 1;
            } else if (status === "draft") {
              sectionDraft += 1;
              draftCount += 1;
            } else if (status === "reopened") {
              sectionReopened += 1;
              reopenedCount += 1;
            } else {
              sectionNotStarted += 1;
              notStartedCount += 1;
            }
            expected += 1;
            return {
              permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
              clubName: club.name,
              name: club.name,
              category: club.category || "",
              status: status,
              hasRecord: !!row,
              totalScore: row ? Number(row.score) || 0 : null,
              score: row ? Number(row.score) || 0 : null,
              submissionRevision: row ? Number(row.revision) || 1 : null,
              updatedAt: row && row.updated ? row.updated : null,
              submittedAt: row && row.submitted_at ? row.submitted_at : null
          };
        });
        return {
          sectionId: section.id,
          id: section.id,
          name: section.name || section.id,
          sectionName: section.name || section.id,
          icon: section.icon || "📌",
          maxScore: Number(section.maxScore) || 0,
          submittedCount: sectionSubmitted,
          draftCount: sectionDraft,
          reopenedCount: sectionReopened,
          notStartedCount: sectionNotStarted,
          clubs: clubRows
        };
      });

      totalExpected += expected;
      totalSubmitted += submittedCount;
      totalDraft += draftCount;
      totalReopened += reopenedCount;
      totalNotStarted += notStartedCount;

      return Object.assign({}, judge, {
        judgeId: judge.id,
        id: judge.id,
        sections: sectionProgress,
        summary: {
          totalExpected: expected,
          submittedCount: submittedCount,
          draftCount: draftCount,
          reopenedCount: reopenedCount,
          notStartedCount: notStartedCount,
          completionRate:
            expected > 0 ? Number(((submittedCount / expected) * 100).toFixed(1)) : 0
        }
      });
    });

    return ok({
      judges: rows,
      judgeCount: rows.length,
      summary: {
        totalExpected: totalExpected,
        submittedCount: totalSubmitted,
        draftCount: totalDraft,
        reopenedCount: totalReopened,
        notStartedCount: totalNotStarted,
        completionRate:
          totalExpected > 0
            ? Number(((totalSubmitted / totalExpected) * 100).toFixed(1))
            : 0
      }
    });
  }

  async function adminJudgeGetRawScore(data) {
    var judgeId = String((data && (data.judgeId || data.id)) || "").trim();
    var sectionId = String((data && data.sectionId) || "").trim();
    var clubName = String((data && (data.clubName || data.club)) || "").trim();
    var permanentClubId = String((data && data.permanentClubId) || "")
      .trim()
      .toUpperCase();
    if (!judgeId || !sectionId || (!clubName && !permanentClubId)) {
      return fail("缺少評審／大項／社團。", "RAW_SCORE_TARGET_REQUIRED");
    }
    var activity = await getActivityRecord();
    var conf = activity.config_json || {};
    var scoreConfig = conf.scoreConfig || defaultScoreConfig();
    var section =
      publishedSectionsOf(scoreConfig).find(function (s) {
        return String(s.id) === sectionId;
      }) ||
      (scoreConfig.sections || []).find(function (s) {
        return s && String(s.id) === sectionId;
      });
    if (!section) return fail("找不到評分大項。", "SECTION_NOT_FOUND");

    var judgeRec;
    try {
      judgeRec = mapJudgeAdmin(await pb().collection(C().staff).getOne(judgeId));
    } catch (_e) {
      return fail("找不到評審。", "JUDGE_NOT_FOUND");
    }

    var clubFilter = 'activity="' + activity.id + '"';
    if (permanentClubId) {
      clubFilter += ' && permanent_club_id="' + permanentClubId + '"';
    }
    var clubs = await pb().collection(C().clubs).getFullList({
      filter: clubFilter,
      sort: "name"
    });
    var club =
      clubs.find(function (c) {
        if (permanentClubId && String(c.permanent_club_id || "").toUpperCase() === permanentClubId) {
          return true;
        }
        return String(c.name || "").trim() === clubName;
      }) || null;
    if (!club && clubName) {
      clubs = await pb().collection(C().clubs).getFullList({
        filter: 'activity="' + activity.id + '"',
        sort: "name"
      });
      club =
        clubs.find(function (c) {
          return String(c.name || "").trim() === clubName;
        }) || null;
    }
    if (!club) return fail("找不到社團。", "CLUB_NOT_FOUND");

    var scoreRes = await pb().collection(C().scores).getList(1, 1, {
      filter:
        'activity="' +
        activity.id +
        '" && club="' +
        club.id +
        '" && judge="' +
        judgeId +
        '" && section_id="' +
        sectionId +
        '"'
    });
    var row = scoreRes.totalItems ? scoreRes.items[0] : null;
    var answers = (row && row.answers_json) || {};
    var reopened = !!(answers && answers.reopened);
    var status = !row
      ? "not_started"
      : reopened
        ? "reopened"
        : row.status === "submitted"
          ? "submitted"
          : "draft";
    var detail = buildJudgeConfirmDetail(section, row);
    return ok({
      judge: {
        id: judgeRec.id,
        judgeId: judgeRec.id,
        displayName: judgeRec.displayName || judgeRec.name || "",
        name: judgeRec.name || "",
        username: judgeRec.username || judgeRec.email || ""
      },
      club: {
        id: club.id,
        name: club.name,
        clubName: club.name,
        permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
        category: club.category || ""
      },
      section: {
        id: section.id,
        sectionId: section.id,
        name: section.name || section.id,
        icon: section.icon || "📌",
        maxScore: Number(section.maxScore) || 0
      },
      status: status,
      statusText: judgeConfirmStatusText(status, reopened),
      locked: status === "submitted",
      reopened: reopened,
      hasRecord: !!row,
      staleDraft: false,
      submissionRevision: row ? Number(row.revision) || 1 : null,
      submittedAt: row && row.submitted_at ? row.submitted_at : null,
      updatedAt: row && row.updated ? row.updated : null,
      unlockedAt: answers.unlockedAt || null,
      historyCount: Array.isArray(answers.history) ? answers.history.length : 0,
      detail: detail,
      totalScore: row ? Number(row.score) || 0 : null
    });
  }

  function judgeAssignNotes(data, prevNotes) {
    var prev = {};
    if (prevNotes && typeof prevNotes === "object") prev = Object.assign({}, prevNotes);
    else if (typeof prevNotes === "string" && prevNotes.trim()) {
      try {
        prev = JSON.parse(prevNotes) || {};
      } catch (_e) {
        prev = {};
      }
    }
    if (Array.isArray(data.categories)) prev.categories = data.categories;
    if (Array.isArray(data.scoreSectionIds)) prev.scoreSectionIds = data.scoreSectionIds;
    return JSON.stringify(prev);
  }

  function mapJudgeAdmin(rec) {
    var assign = { categories: [], scoreSectionIds: [] };
    try {
      var parsed =
        typeof rec.notes === "string" && rec.notes.trim()
          ? JSON.parse(rec.notes)
          : rec.notes && typeof rec.notes === "object"
            ? rec.notes
            : {};
      assign.categories = Array.isArray(parsed.categories) ? parsed.categories : [];
      assign.scoreSectionIds = Array.isArray(parsed.scoreSectionIds)
        ? parsed.scoreSectionIds
        : [];
    } catch (_e) {
      /* ignore */
    }
    return {
      id: rec.id,
      email: rec.email,
      username: rec.email,
      name: rec.name || "",
      displayName: rec.name || "",
      active: rec.active !== false,
      role: rec.role,
      categories: assign.categories,
      scoreSectionIds: assign.scoreSectionIds
    };
  }

  function staffWriteErrorMessage_(error, fallback) {
    var base = String((error && error.message) || fallback || "操作失敗");
    var raw = (error && (error.data || error.response || {})) || {};
    var fieldErrors = raw.data || {};
    var fields = Object.keys(fieldErrors)
      .map(function (key) {
        var fe = fieldErrors[key];
        return key + ":" + String((fe && (fe.message || fe.code)) || fe || "");
      })
      .filter(Boolean)
      .join("; ");
    var blob = (base + " " + fields).toLowerCase();
    if (/only superusers|didn't match.*rule|does not match.*rule|forbidden|permission/i.test(blob)) {
      return "沒有權限新增評審（請確認已套用 hksp_staff create ACL，且登入帳號為 active admin）。";
    }
    if (/email:.*unique|validation_not_unique|value must be unique/i.test(blob)) {
      return "此登入帳號已被使用（不可與管理帳或其他評審重複），請改用另一個帳號。";
    }
    if (fields) return base + "（" + fields + "）";
    return base;
  }

  async function adminAddJudge(data) {
    var email = String(data.email || data.username || "")
      .trim()
      .toLowerCase();
    if (email && email.indexOf("@") < 0) email = email + "@hksp.local";
    var password = String(data.password || "");
    var name = String(data.displayName || data.name || "").trim() || email;
    if (!email || !password) return fail("請填寫評審帳號與密碼。");
    if (password.length < 8) {
      return fail("初始密碼至少 8 個字元。", "JUDGE_PASSWORD_TOO_SHORT");
    }
    try {
      var created = await pb().collection(C().staff).create({
        email: email,
        emailVisibility: true,
        password: password,
        passwordConfirm: password,
        name: name,
        role: "judge",
        active: true,
        notes: judgeAssignNotes(data, {})
      });
      return ok({ judge: mapJudgeAdmin(created) });
    } catch (e) {
      return fail(staffWriteErrorMessage_(e, "新增評審失敗。"), "JUDGE_CREATE_FAILED");
    }
  }

  async function adminUpdateJudge(data) {
    var id = String(data.id || data.judgeId || "").trim();
    if (!id) return fail("缺少評審 ID。");
    try {
      var existing = await pb().collection(C().staff).getOne(id);
      var patch = {
        notes: judgeAssignNotes(data, existing.notes)
      };
      if (data.name != null || data.displayName != null) {
        patch.name = String(data.displayName || data.name || "");
      }
      if (data.phone != null) patch.phone = String(data.phone || "");
      var updated = await pb().collection(C().staff).update(id, patch);
      return ok({ judge: mapJudgeAdmin(updated) });
    } catch (e) {
      return fail((e && e.message) || "更新評審失敗。");
    }
  }

  async function adminSetJudgeActive(data) {
    var id = String(data.id || data.judgeId || "").trim();
    if (!id) return fail("缺少評審 ID。");
    try {
      var updated = await pb().collection(C().staff).update(id, {
        active: data.active !== false && data.active !== "false"
      });
      return ok({
        judge: {
          id: updated.id,
          email: updated.email,
          name: updated.name,
          active: updated.active !== false,
          role: updated.role
        }
      });
    } catch (e) {
      return fail((e && e.message) || "更新評審狀態失敗。");
    }
  }

  async function adminResetJudgePassword(data) {
    var id = String(data.id || data.judgeId || "").trim();
    var password = String(data.password || data.newPassword || "");
    if (!id || !password) return fail("缺少評審或新密碼。");
    try {
      await pb().collection(C().staff).update(id, {
        password: password,
        passwordConfirm: password
      });
      return ok({ id: id });
    } catch (e) {
      return fail((e && e.message) || "重設評審密碼失敗。");
    }
  }

  async function adminDeleteJudge(data) {
    var id = String(data.id || data.judgeId || "").trim();
    if (!id) return fail("缺少評審 ID。");
    try {
      await pb().collection(C().staff).update(id, { active: false });
      return ok({ id: id });
    } catch (e) {
      return fail((e && e.message) || "停用評審失敗。");
    }
  }

  async function stubOk(name) {
    return fail("PocketBase 管理端尚未實作：" + name + "（此面板已隱藏）", "UNIMPLEMENTED");
  }

  function defaultRankingConfig() {
    return {
      pass: { threshold: 70, comparator: "gte" },
      ranking: {
        // Formal ranks require pass; eligibility kept for UI compatibility.
        eligibility: "passed_only",
        incompletePolicy: "show_unranked",
        tieMode: "shared",
        rankStyle: "competition",
        unresolvedTie: "manual",
        tieBreakers: [],
        // Manual order overrides after auto ranking: { "屬性::PERMANENT_ID": rankNumber }
        manualRanks: {}
      }
    };
  }

  function rankingConfigOf(activity) {
    var conf = (activity && activity.config_json) || {};
    var base = defaultRankingConfig();
    var saved = conf.rankingConfig && typeof conf.rankingConfig === "object" ? conf.rankingConfig : {};
    var savedRanking = saved.ranking && typeof saved.ranking === "object" ? saved.ranking : {};
    return {
      pass: Object.assign({}, base.pass, saved.pass || {}),
      ranking: Object.assign({}, base.ranking, savedRanking, {
        tieBreakers: Array.isArray(savedRanking.tieBreakers)
          ? savedRanking.tieBreakers
          : [],
        manualRanks:
          savedRanking.manualRanks && typeof savedRanking.manualRanks === "object"
            ? savedRanking.manualRanks
            : {}
      })
    };
  }

  function canonicalRankingCategories_() {
    return [
      "全校自治性",
      "自治綜合性",
      "學藝性",
      "體能性",
      "服務性",
      "康樂性",
      "未分類"
    ];
  }

  function clubParticipatesEvaluation_(club) {
    var meta =
      club && club.meta_json && typeof club.meta_json === "object" ? club.meta_json : {};
    var participation = String(
      (club && club.participation) || meta.participation || ""
    )
      .trim()
      .toLowerCase();
    if (!participation) return true; // 未設定＝相容舊資料，視為參加評選
    if (participation === "none" || participation === "off") return false;
    if (participation === "feature") return false;
    return (
      participation === "evaluation" ||
      participation === "eval" ||
      participation === "both" ||
      participation === "all"
    );
  }

  function normalizeRankingCategory_(raw) {
    var key = normalizeCategoryLabel(raw);
    if (!key) return "未分類";
    var known = canonicalRankingCategories_();
    return known.indexOf(key) >= 0 ? key : key || "未分類";
  }

  function manualRankKey_(category, permanentClubId) {
    return String(category || "未分類") + "::" + String(permanentClubId || "").toUpperCase();
  }

  function exportScoreOneDecimal_(value) {
    if (value === null || value === undefined || value === "") return "";
    var n = Number(value);
    if (!Number.isFinite(n)) return "";
    return Math.round(n * 10) / 10;
  }

  function rankingActivityTitle_(activity) {
    return String(
      (activity && (activity.title || activity.name || activity.activity_id)) ||
        "115學年度第一學期全校學生社團評選暨觀摩活動"
    ).trim();
  }

  function publishedSectionsOf(scoreConfig) {
    var all = (scoreConfig.sections || []).filter(function (s) {
      return s && s.enabled !== false && s.scoringMode !== "manual";
    });
    var published = all.filter(function (s) {
      return s.published === true;
    });
    // 尚未標記 published 時，管理端仍要用啟用中的大項接收／彙整評審分數
    return published.length ? published : all;
  }

  function normalizeCategoryLabel(raw) {
    var key = String(raw || "").trim();
    if (!key) return "";
    try {
      if (cfg().mapClubCategory) return String(cfg().mapClubCategory(key) || key).trim();
    } catch (_e) {
      /* ignore */
    }
    return key;
  }

  function judgeCoversClub(judge, club, sectionId) {
    if (!judge || judge.active === false) return false;
    // 與評審端／進度面板一致：空 scoreSectionIds／categories＝不能評（不再退回全部）。
    var sections = Array.isArray(judge.scoreSectionIds) ? judge.scoreSectionIds : [];
    if (!sections.length || sections.indexOf(sectionId) < 0) return false;
    var cats = Array.isArray(judge.categories) ? judge.categories : [];
    if (!cats.length) return false;
    var cat = normalizeCategoryLabel(club.category);
    var set = {};
    cats.forEach(function (c) {
      set[normalizeCategoryLabel(c)] = true;
      set[String(c || "").trim()] = true;
    });
    return !!(set[cat] || set[String(club.category || "").trim()]);
  }

  function scoreBucket(maxScore) {
    return {
      averageScore: null,
      currentScore: null,
      finalScore: null,
      maxScore: Number(maxScore) || 0,
      complete: false,
      submittedCount: 0,
      assignedCount: 0,
      reopenedCount: 0
    };
  }

  /** Map live scoreConfig ids/names onto legacy admin column keys. */
  function aggregationColumnKind_(sectionLike) {
    var id = String(
      (sectionLike && (sectionLike.id || sectionLike.sectionId)) || ""
    ).trim();
    var name = String(
      (sectionLike && (sectionLike.name || sectionLike.sectionName)) || ""
    ).trim();
    if (id === "dataReview" || /資料審查|數位資料/.test(name)) return "dataReview";
    if (id === "fieldReview" || /實地審查|現場|詢答/.test(name)) return "fieldReview";
    if (
      id === "routinePerformance" ||
      /平時表現|平時分數|平時|課指/.test(name)
    ) {
      return "routine";
    }
    return "other";
  }

  function mergeScoreBuckets_(buckets) {
    var list = (buckets || []).filter(Boolean);
    var out = scoreBucket(0);
    if (!list.length) return out;
    var hasCurrent = false;
    var currentSum = 0;
    var hasFinal = true;
    var finalSum = 0;
    var allComplete = true;
    list.forEach(function (b) {
      out.maxScore += Number(b.maxScore) || 0;
      out.assignedCount += Number(b.assignedCount) || 0;
      out.submittedCount += Number(b.submittedCount) || 0;
      out.reopenedCount += Number(b.reopenedCount) || 0;
      if (b.currentScore !== null && b.currentScore !== undefined) {
        hasCurrent = true;
        currentSum += Number(b.currentScore) || 0;
      } else if (b.averageScore !== null && b.averageScore !== undefined) {
        hasCurrent = true;
        currentSum += Number(b.averageScore) || 0;
      }
      if (b.complete === true && b.finalScore !== null && b.finalScore !== undefined) {
        finalSum += Number(b.finalScore) || 0;
      } else {
        hasFinal = false;
        allComplete = false;
      }
    });
    if (hasCurrent) {
      out.averageScore = currentSum;
      out.currentScore = currentSum;
    }
    out.complete = allComplete && list.length > 0;
    if (out.complete && hasFinal) out.finalScore = finalSum;
    return out;
  }

  function applyLegacyAggregationAliases_(sectionScores, groupScores, sectionDetails, sections) {
    var dataBuckets = [];
    var fieldBuckets = [];
    var routineBuckets = [];
    (sections || []).forEach(function (section) {
      if (!section || !section.id) return;
      var bucket = sectionScores[section.id];
      if (!bucket) return;
      var kind = aggregationColumnKind_(section);
      if (kind === "dataReview") dataBuckets.push(bucket);
      else if (kind === "fieldReview") fieldBuckets.push(bucket);
      else routineBuckets.push(bucket);
    });
    // 名稱後備：當 sections 參數缺漏時，仍可由 sectionDetails 補對應
    if (!dataBuckets.length || !fieldBuckets.length || !routineBuckets.length) {
      (sectionDetails || []).forEach(function (detail) {
        if (!detail) return;
        var bucket =
          (detail.sectionId && sectionScores[detail.sectionId]) ||
          {
            averageScore: detail.averageScore,
            currentScore: detail.currentScore,
            finalScore: detail.finalScore,
            maxScore: detail.maxScore,
            complete: detail.complete === true,
            submittedCount: 0,
            assignedCount: 0,
            reopenedCount: 0
          };
        var kind = aggregationColumnKind_(detail);
        if (kind === "dataReview" && !dataBuckets.length) dataBuckets.push(bucket);
        else if (kind === "fieldReview" && !fieldBuckets.length) fieldBuckets.push(bucket);
        else if (kind === "routine" && !routineBuckets.length) routineBuckets.push(bucket);
      });
    }
    if (!sectionScores.dataReview && dataBuckets.length) {
      sectionScores.dataReview = mergeScoreBuckets_(dataBuckets);
    }
    if (!sectionScores.fieldReview && fieldBuckets.length) {
      sectionScores.fieldReview = mergeScoreBuckets_(fieldBuckets);
    }
    if (!groupScores.routinePerformance) {
      var routine =
        routineBuckets.length
          ? mergeScoreBuckets_(routineBuckets)
          : null;
      // 再後備：把名稱像平時的 group 加總
      if (!routine) {
        var groupRoutine = [];
        Object.keys(groupScores || {}).forEach(function (gid) {
          if (gid === "routinePerformance") return;
          if (/平時表現|平時分數|平時|課指/.test(String(gid))) {
            groupRoutine.push(groupScores[gid]);
          }
        });
        if (groupRoutine.length) routine = mergeScoreBuckets_(groupRoutine);
      }
      if (routine) groupScores.routinePerformance = routine;
    }
  }

  async function loadAggregationContext() {
    var activity = await getActivityRecord();
    var conf = activity.config_json || {};
    var scoreConfig = conf.scoreConfig || defaultScoreConfig();
    var rankingConfig = rankingConfigOf(activity);
    var judges = (await pb().collection(C().staff).getFullList({
      filter: 'role="judge" && active=true',
      sort: "email"
    })).map(mapJudgeAdmin);
    var clubs = await pb().collection(C().clubs).getFullList({
      filter: 'activity="' + activity.id + '" && active=true',
      sort: "name"
    });
    var scores = await pb().collection(C().scores).getFullList({
      filter: 'activity="' + activity.id + '"'
    });
    var byKey = {};
    scores.forEach(function (row) {
      var jid =
        row.judge && typeof row.judge === "object" ? row.judge.id : row.judge;
      var cid = row.club && typeof row.club === "object" ? row.club.id : row.club;
      var sid = row.section_id || (row.answers_json && row.answers_json.sectionId) || "";
      if (!jid || !cid || !sid) return;
      byKey[jid + "::" + cid + "::" + sid] = row;
    });
    return {
      activity: activity,
      scoreConfig: scoreConfig,
      rankingConfig: rankingConfig,
      judges: judges,
      clubs: clubs,
      byKey: byKey
    };
  }

  function buildClubAggregation(ctx) {
    var sections = publishedSectionsOf(ctx.scoreConfig);
    var totalMax = sections.reduce(function (sum, s) {
      return sum + (Number(s.maxScore) || 0);
    }, 0);
    var clubs = ctx.clubs.map(function (club) {
      var sectionScores = {};
      var groupScores = {};
      var missing = 0;
      var reopenedSectionCount = 0;
      var allComplete = sections.length > 0;
      var finalTotal = 0;
      var currentTotal = 0;
      var hasAnyCurrent = false;
      var sectionDetails = [];

      var unassignedSectionIds = [];
      var unassignedSectionNames = [];
      var pendingAssignedSectionIds = [];
      var pendingAssignedSectionNames = [];
      var provisionalTotal = 0;
      var hasCompletedSection = false;
      var participatesEvaluation = clubParticipatesEvaluation_(club);

      sections.forEach(function (section) {
        var assigned = ctx.judges.filter(function (j) {
          return judgeCoversClub(j, club, section.id);
        });
        if (!assigned.length) {
          missing += 1;
          unassignedSectionIds.push(section.id);
          unassignedSectionNames.push(section.name || section.id);
        }
        var bucket = scoreBucket(section.maxScore);
        bucket.assignedCount = assigned.length;
        var values = [];
        var judgeRows = assigned.map(function (judge) {
          var row = ctx.byKey[judge.id + "::" + club.id + "::" + section.id];
          var answers = (row && row.answers_json) || {};
          var reopened = !!(answers && answers.reopened);
          // 解鎖重評期間舊分不計入目前累計（既有規則，維持）。
          var submitted = !!(row && row.status === "submitted" && !reopened);
          if (reopened) bucket.reopenedCount += 1;
          if (submitted) {
            bucket.submittedCount += 1;
            values.push(Number(row.score) || 0);
          }
          return {
            judgeId: judge.id,
            judgeName: judge.displayName || judge.name || judge.email,
            status: !row ? "notStarted" : reopened ? "reopened" : row.status === "submitted" ? "submitted" : "draft",
            score: row ? Number(row.score) || 0 : null,
            submittedAt: row && row.submitted_at ? row.submitted_at : null
          };
        });
        if (values.length) {
          var avg = values.reduce(function (a, b) {
            return a + b;
          }, 0) / values.length;
          bucket.averageScore = avg;
          bucket.currentScore = avg;
          hasAnyCurrent = true;
          currentTotal += avg;
        }
        bucket.complete =
          assigned.length > 0 &&
          bucket.submittedCount === assigned.length &&
          bucket.reopenedCount === 0;
        if (bucket.complete) {
          bucket.finalScore = bucket.averageScore;
          finalTotal += bucket.finalScore;
          provisionalTotal += bucket.finalScore;
          hasCompletedSection = true;
        } else {
          allComplete = false;
          if (assigned.length > 0) {
            pendingAssignedSectionIds.push(section.id);
            pendingAssignedSectionNames.push(section.name || section.id);
          }
        }
        if (bucket.reopenedCount > 0) reopenedSectionCount += 1;
        sectionScores[section.id] = bucket;
        (section.groups || []).forEach(function (g) {
          if (!g || !g.id) return;
          var criteria = Array.isArray(g.criteria) ? g.criteria.filter(Boolean) : [];
          var groupBucket = scoreBucket(g.maxScore);
          groupBucket.assignedCount = assigned.length;
          var groupValues = [];
          assigned.forEach(function (judge) {
            var grow = ctx.byKey[judge.id + "::" + club.id + "::" + section.id];
            var ganswers = (grow && grow.answers_json) || {};
            var greopened = !!(ganswers && ganswers.reopened);
            var gsubmitted = !!(grow && grow.status === "submitted" && !greopened);
            if (greopened) groupBucket.reopenedCount += 1;
            if (!gsubmitted) return;
            groupBucket.submittedCount += 1;
            if (!criteria.length) return;
            var scoresMap = ganswers.scores || {};
            var gsum = 0;
            var gcomplete = true;
            criteria.forEach(function (c) {
              var gv = Number(scoresMap[c.id]);
              if (!Number.isFinite(gv)) gcomplete = false;
              else gsum += gv;
            });
            if (gcomplete) groupValues.push(gsum);
          });
          if (groupValues.length) {
            var gavg =
              groupValues.reduce(function (a, b) {
                return a + b;
              }, 0) / groupValues.length;
            groupBucket.averageScore = gavg;
            groupBucket.currentScore = gavg;
          }
          groupBucket.complete =
            assigned.length > 0 &&
            groupBucket.submittedCount === assigned.length &&
            groupBucket.reopenedCount === 0;
          if (groupBucket.complete) groupBucket.finalScore = groupBucket.averageScore;
          groupScores[g.id] = groupBucket;
        });
        sectionDetails.push({
          sectionId: section.id,
          sectionName: section.name,
          maxScore: Number(section.maxScore) || 0,
          complete: bucket.complete,
          averageScore: bucket.averageScore,
          finalScore: bucket.finalScore,
          currentScore: bucket.currentScore,
          judges: judgeRows
        });
      });

      // 舊 admin 欄位（平時／數位／現場）依 id 或名稱別名，避免自訂大項 id 對不到
      applyLegacyAggregationAliases_(
        sectionScores,
        groupScores,
        sectionDetails,
        sections
      );

      var complete = allComplete && missing === 0 && participatesEvaluation;
      var hasPendingAssigned = pendingAssignedSectionIds.length > 0;
      var provisionalEligible =
        participatesEvaluation &&
        !complete &&
        unassignedSectionIds.length > 0 &&
        !hasPendingAssigned &&
        hasCompletedSection;
      return {
        clubId: club.id,
        permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
        clubName: club.name,
        category: club.category || "",
        participation: String(
          (club.meta_json && club.meta_json.participation) || ""
        ).trim(),
        participatesEvaluation: participatesEvaluation,
        complete: complete,
        missingJudgeAssignments: missing,
        reopenedSectionCount: reopenedSectionCount,
        unassignedSectionIds: unassignedSectionIds,
        unassignedSectionNames: unassignedSectionNames,
        pendingAssignedSectionIds: pendingAssignedSectionIds,
        pendingAssignedSectionNames: pendingAssignedSectionNames,
        hasPendingAssignedJudge: hasPendingAssigned,
        provisionalEligible: provisionalEligible,
        provisionalTotalScore: provisionalEligible ? provisionalTotal : null,
        finalTotalScore: complete ? finalTotal : null,
        currentTotalScore: hasAnyCurrent ? currentTotal : null,
        totalMaxScore: totalMax || Number(ctx.scoreConfig.totalMaxScore) || 0,
        sectionScores: sectionScores,
        groupScores: groupScores,
        sections: sectionDetails
      };
    });

    var summary = {
      completeClubCount: 0,
      incompleteClubCount: 0,
      reopenedClubCount: 0,
      missingAssignmentClubCount: 0
    };
    clubs.forEach(function (c) {
      if (c.missingJudgeAssignments > 0) summary.missingAssignmentClubCount += 1;
      if (c.reopenedSectionCount > 0) summary.reopenedClubCount += 1;
      if (c.complete) summary.completeClubCount += 1;
      else summary.incompleteClubCount += 1;
    });

    return {
      clubs: clubs,
      summary: summary,
      configRevision: Number(ctx.scoreConfig.revision) || 1,
      totalMaxScore: totalMax || Number(ctx.scoreConfig.totalMaxScore) || 0,
      generatedAt: new Date().toISOString()
    };
  }

  function availableMetricsOf(scoreConfig) {
    var metrics = [
      {
        sourceType: "total",
        sourceId: "finalTotalScore",
        name: "最終總分",
        maxScore: Number(scoreConfig.totalMaxScore) || null
      }
    ];
    publishedSectionsOf(scoreConfig).forEach(function (section) {
      metrics.push({
        sourceType: "section",
        sourceId: section.id,
        name: section.name || section.id,
        maxScore: Number(section.maxScore) || 0
      });
      (section.groups || []).forEach(function (g) {
        if (!g) return;
        metrics.push({
          sourceType: "group",
          sourceId: g.id,
          name: (section.name || "") + " / " + (g.name || g.id),
          maxScore: Number(g.maxScore) || 0
        });
      });
    });
    return metrics;
  }

  function metricValue(clubAgg, sourceType, sourceId) {
    if (sourceType === "total" && sourceId === "finalTotalScore") {
      return clubAgg.finalTotalScore;
    }
    if (sourceType === "section") {
      var sec = clubAgg.sectionScores && clubAgg.sectionScores[sourceId];
      if (!sec) return null;
      if (sec.finalScore != null) return sec.finalScore;
      if (sec.currentScore != null) return sec.currentScore;
      return sec.averageScore;
    }
    if (sourceType === "group") {
      var grp = clubAgg.groupScores && clubAgg.groupScores[sourceId];
      if (!grp) return null;
      if (grp.finalScore != null) return grp.finalScore;
      if (grp.currentScore != null) return grp.currentScore;
      return grp.averageScore;
    }
    return null;
  }

  function passesThreshold(score, pass) {
    if (score === null || score === undefined || !Number.isFinite(Number(score))) return null;
    var threshold = Number(pass && pass.threshold);
    if (!Number.isFinite(threshold)) threshold = 70;
    if ((pass && pass.comparator) === "gt") return Number(score) > threshold;
    return Number(score) >= threshold;
  }

  function compareRankRows(a, b, rankingConfig, clubMap) {
    var aScore = Number(a.rankScore);
    var bScore = Number(b.rankScore);
    if (!Number.isFinite(aScore)) aScore = Number(a.finalTotalScore) || 0;
    if (!Number.isFinite(bScore)) bScore = Number(b.finalTotalScore) || 0;
    var totalDiff = bScore - aScore;
    if (totalDiff) return totalDiff;
    var mode = (rankingConfig.ranking && rankingConfig.ranking.tieMode) || "shared";
    if (mode === "rules") {
    var breakers = (rankingConfig.ranking && rankingConfig.ranking.tieBreakers) || [];
    for (var i = 0; i < breakers.length; i++) {
      var rule = breakers[i] || {};
        var clubA =
          clubMap[a.permanentClubId] ||
          clubMap[a.clubName] ||
          {};
        var clubB =
          clubMap[b.permanentClubId] ||
          clubMap[b.clubName] ||
          {};
        var av = metricValue(clubA, rule.sourceType, rule.sourceId);
        var bv = metricValue(clubB, rule.sourceType, rule.sourceId);
      var an = av === null || av === undefined ? -Infinity : Number(av);
      var bn = bv === null || bv === undefined ? -Infinity : Number(bv);
      var diff = rule.direction === "asc" ? an - bn : bn - an;
      if (diff) return diff;
    }
    }
    var manual = (rankingConfig.ranking && rankingConfig.ranking.manualRanks) || {};
    var mkA = manualRankKey_(a.category, a.permanentClubId);
    var mkB = manualRankKey_(b.category, b.permanentClubId);
    var manA = Number(manual[mkA]);
    var manB = Number(manual[mkB]);
    if (Number.isFinite(manA) && Number.isFinite(manB) && manA !== manB) {
      return manA - manB;
    }
    if (Number.isFinite(manA) && !Number.isFinite(manB)) return -1;
    if (!Number.isFinite(manA) && Number.isFinite(manB)) return 1;
    return String(a.permanentClubId || "").localeCompare(
      String(b.permanentClubId || ""),
      "en"
    );
  }

  function buildRankingRowFromClub_(club, rankingConfig) {
    var category = normalizeRankingCategory_(club.category);
    var participates = club.participatesEvaluation !== false;
    var complete = !!club.complete && participates;
          var passed = complete ? passesThreshold(club.finalTotalScore, rankingConfig.pass) : null;
    var provisionalEligible = !!club.provisionalEligible && participates;
    var hasPending = !!club.hasPendingAssignedJudge;
    var displayScore = null;
    var passStatus = "";
    var rankStatus = "incomplete";
    var statusLabel = "未完成";
    var unassignedNames = Array.isArray(club.unassignedSectionNames)
      ? club.unassignedSectionNames.slice()
      : [];

    if (!participates) {
      rankStatus = "not_participating";
      statusLabel = "未參加評選";
      passStatus = "";
      displayScore = null;
    } else if (complete && passed === true) {
      rankStatus = "rankable";
      statusLabel = "及格";
      passStatus = "及格";
      displayScore = club.finalTotalScore;
    } else if (complete && passed === false) {
      rankStatus = "failed_unranked";
      statusLabel = "未達及格";
      passStatus = "未達及格";
      displayScore = club.finalTotalScore;
    } else if (provisionalEligible) {
      rankStatus = "provisional";
      statusLabel = "暫排名";
      passStatus = "暫排名";
      displayScore = club.provisionalTotalScore;
    } else if (hasPending || !complete) {
      rankStatus = "incomplete";
      statusLabel = "未完成";
      passStatus = "未完成";
      displayScore =
        club.currentTotalScore === null || club.currentTotalScore === undefined
          ? null
          : club.currentTotalScore;
    }

    var manual = (rankingConfig.ranking && rankingConfig.ranking.manualRanks) || {};
    var manualKey = manualRankKey_(category, club.permanentClubId);
    var manualRank = Number(manual[manualKey]);
          return {
            clubName: club.clubName,
            permanentClubId: club.permanentClubId,
            category: category,
            complete: complete,
      participatesEvaluation: participates,
      eligible: complete && passed === true,
            passed: passed,
            finalTotalScore: complete ? club.finalTotalScore : null,
      currentTotalScore:
        club.currentTotalScore === null || club.currentTotalScore === undefined
          ? null
          : club.currentTotalScore,
      provisionalTotalScore: provisionalEligible ? club.provisionalTotalScore : null,
      displayScore: displayScore,
      rankScore: displayScore,
            totalMaxScore: club.totalMaxScore,
            displayRank: null,
      manualRank: Number.isFinite(manualRank) ? manualRank : null,
      rankStatus: rankStatus,
      statusLabel: statusLabel,
      passStatus: passStatus,
      unassignedSectionNames: unassignedNames,
      missingJudgeAssignments: club.missingJudgeAssignments || 0,
      hasPendingAssignedJudge: hasPending,
      provisionalEligible: provisionalEligible
    };
  }

  function assignFormalRanks_(rankable, rankingConfig, clubMap) {
        rankable.sort(function (a, b) {
          return compareRankRows(a, b, rankingConfig, clubMap);
        });
        var style = (rankingConfig.ranking && rankingConfig.ranking.rankStyle) || "competition";
    var unresolvedTie =
      (rankingConfig.ranking && rankingConfig.ranking.unresolvedTie) || "shared";
        var tieMode = (rankingConfig.ranking && rankingConfig.ranking.tieMode) || "shared";
        var i = 0;
        var denseRank = 0;
        while (i < rankable.length) {
          var j = i + 1;
          while (
            j < rankable.length &&
            compareRankRows(rankable[i], rankable[j], rankingConfig, clubMap) === 0
          ) {
            j += 1;
          }
          denseRank += 1;
          var rank = style === "dense" ? denseRank : i + 1;
          var tied = j - i > 1;
      var allHaveManual = true;
      for (var m = i; m < j; m++) {
        if (!Number.isFinite(Number(rankable[m].manualRank))) allHaveManual = false;
      }
      if (tied && allHaveManual) {
        var slice = rankable.slice(i, j).sort(function (a, b) {
          return Number(a.manualRank) - Number(b.manualRank);
        });
        for (var s = 0; s < slice.length; s++) {
          var item = slice[s];
          var idx = rankable.indexOf(item);
          var manualDisplay =
            style === "dense" ? denseRank + s : Number(item.manualRank) || rank + s;
          rankable[idx].displayRank = String(manualDisplay);
          rankable[idx].rankStatus = "ranked";
          rankable[idx].statusLabel = "及格";
        }
      } else {
          for (var k = i; k < j; k++) {
          if (Number.isFinite(Number(rankable[k].manualRank))) {
            rankable[k].displayRank = String(rankable[k].manualRank);
            rankable[k].rankStatus = "ranked";
            rankable[k].statusLabel = "及格";
            continue;
          }
            rankable[k].displayRank = String(rank);
            if (tied) {
            var pending =
              unresolvedTie === "manual" || tieMode === "manual";
            rankable[k].rankStatus = pending ? "tie_pending" : "tied";
            rankable[k].statusLabel = pending ? "待人工決定" : "同分並列";
            } else {
              rankable[k].rankStatus = "ranked";
            rankable[k].statusLabel = "及格";
          }
            }
          }
          i = j;
    }
  }

  function assignProvisionalRanks_(rows, rankingConfig, clubMap) {
    var list = rows.filter(function (r) {
      return r.rankStatus === "provisional";
    });
    list.sort(function (a, b) {
      return compareRankRows(a, b, rankingConfig, clubMap);
    });
    var style = (rankingConfig.ranking && rankingConfig.ranking.rankStyle) || "competition";
    var i = 0;
    var denseRank = 0;
    while (i < list.length) {
      var j = i + 1;
      while (
        j < list.length &&
        compareRankRows(list[i], list[j], rankingConfig, clubMap) === 0
      ) {
        j += 1;
      }
      denseRank += 1;
      var rank = style === "dense" ? denseRank : i + 1;
      for (var k = i; k < j; k++) {
        list[k].displayRank = "暫" + String(rank);
        list[k].rankStatus = "provisional";
        list[k].statusLabel = "暫排名";
        list[k].passStatus = "暫排名";
      }
      i = j;
    }
  }

  function rankingDisplayRankNumber_(row) {
    var n = parseInt(String((row && row.displayRank) || "").replace(/[^\d]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }

  function rankingDisplayScoreNumber_(row) {
    if (!row) return null;
    var raw =
      row.displayScore !== null && row.displayScore !== undefined
        ? row.displayScore
        : row.finalTotalScore !== null && row.finalTotalScore !== undefined
          ? row.finalTotalScore
          : row.currentTotalScore;
    var n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  function sortRankingRowsForDisplay_(rows) {
    var copy = rows.slice();
    copy.sort(function (a, b) {
      function bucket(row) {
        if (row.rankStatus === "ranked" || row.rankStatus === "tied" || row.rankStatus === "tie_pending") {
          return 0;
        }
        if (row.rankStatus === "provisional") return 1;
        if (row.rankStatus === "not_participating") return 3;
        return 2;
      }
      var ba = bucket(a);
      var bb = bucket(b);
      if (ba !== bb) return ba - bb;
      if (ba === 0 || ba === 1) {
        var ra = rankingDisplayRankNumber_(a);
        var rb = rankingDisplayRankNumber_(b);
        if (ra !== null && rb !== null && ra !== rb) return ra - rb;
        if (ra !== null && rb === null) return -1;
        if (ra === null && rb !== null) return 1;
      }
      // Prefer score order over club id/name so Excel opens already “by 名次/成績”.
      var sa = rankingDisplayScoreNumber_(a);
      var sb = rankingDisplayScoreNumber_(b);
      if (sa !== null && sb !== null && sa !== sb) return sb - sa;
      if (sa !== null && sb === null) return -1;
      if (sa === null && sb !== null) return 1;
      return String(a.clubName || "").localeCompare(String(b.clubName || ""), "zh-Hant");
    });
    return copy;
  }

  function buildRankingPayload(ctx, aggregation) {
    var rankingConfig = ctx.rankingConfig;
    var clubMap = {};
    aggregation.clubs.forEach(function (c) {
      clubMap[c.clubName] = c;
      if (c.permanentClubId) clubMap[c.permanentClubId] = c;
    });
    var byCategory = {};
    canonicalRankingCategories_().forEach(function (cat) {
      byCategory[cat] = [];
    });
    aggregation.clubs.forEach(function (club) {
      var cat = normalizeRankingCategory_(club.category);
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(club);
    });

    var categoryOrder = canonicalRankingCategories_().slice();
    Object.keys(byCategory).forEach(function (cat) {
      if (categoryOrder.indexOf(cat) < 0) {
        categoryOrder.splice(categoryOrder.length - 1, 0, cat);
      }
    });

    var categories = categoryOrder.map(function (category) {
      var clubList = byCategory[category] || [];
      var rows = clubList.map(function (club) {
        return buildRankingRowFromClub_(club, rankingConfig);
      });

      var rankable = rows.filter(function (r) {
        return r.rankStatus === "rankable" || (r.complete && r.passed === true);
      });
      assignFormalRanks_(rankable, rankingConfig, clubMap);
      assignProvisionalRanks_(rows, rankingConfig, clubMap);

        if ((rankingConfig.ranking && rankingConfig.ranking.incompletePolicy) === "hide") {
          rows = rows.filter(function (r) {
          return (
            r.complete ||
            r.rankStatus === "provisional" ||
            r.rankStatus === "not_participating"
          );
        });
      }

      rows = sortRankingRowsForDisplay_(rows);
        return {
          category: category,
        totalClubCount: clubList.length,
          rows: rows
        };
      });

    var summary = {
      clubCount: aggregation.clubs.length,
      completedCount: 0,
      passedCount: 0,
      failedCount: 0,
      incompleteCount: 0,
      provisionalCount: 0,
      notParticipatingCount: 0
    };
    aggregation.clubs.forEach(function (c) {
      if (c.participatesEvaluation === false) {
        summary.notParticipatingCount += 1;
        return;
      }
      if (c.provisionalEligible) summary.provisionalCount += 1;
      if (!c.complete) {
        summary.incompleteCount += 1;
        return;
      }
      summary.completedCount += 1;
      var passed = passesThreshold(c.finalTotalScore, rankingConfig.pass);
      if (passed) summary.passedCount += 1;
      else summary.failedCount += 1;
    });

    return {
      categories: categories,
      summary: summary,
      config: rankingConfig,
      availableMetrics: availableMetricsOf(ctx.scoreConfig),
      totalMaxScore: aggregation.totalMaxScore,
      activityTitle: rankingActivityTitle_(ctx.activity),
      generatedAt: new Date().toISOString(),
      source: "pocketbase",
      updateTime: String(ctx.activity.updated || new Date().toISOString())
    };
  }

  async function adminScoreAggregationSummary() {
    var ctx = await loadAggregationContext();
    return ok(buildClubAggregation(ctx));
  }

  async function adminScoreAggregation() {
    return adminScoreAggregationSummary();
  }

  async function adminRanking() {
    var ctx = await loadAggregationContext();
    var aggregation = buildClubAggregation(ctx);
    return ok(buildRankingPayload(ctx, aggregation));
  }

  async function adminSaveRankingConfig(data) {
    var activity = await getActivityRecord();
    var conflict = assertExpectedUpdateTime(activity, data);
    if (conflict) return conflict;
    var conf = Object.assign({}, activity.config_json || {});
    var next = data.config || data.rankingConfig || null;
    if (!next || typeof next !== "object") return fail("缺少排名規則。");
    var nextRanking = next.ranking && typeof next.ranking === "object" ? next.ranking : {};
    conf.rankingConfig = {
      pass: Object.assign({}, defaultRankingConfig().pass, next.pass || {}),
      ranking: Object.assign({}, defaultRankingConfig().ranking, nextRanking, {
        tieBreakers: Array.isArray(nextRanking.tieBreakers) ? nextRanking.tieBreakers : [],
        manualRanks:
          nextRanking.manualRanks && typeof nextRanking.manualRanks === "object"
            ? nextRanking.manualRanks
            : {}
      })
    };
    var updated = await pb().collection(C().activities).update(activity.id, {
      config_json: conf
    });
    var ctx = await loadAggregationContext();
    return ok({
      config: conf.rankingConfig,
      availableMetrics: availableMetricsOf(ctx.scoreConfig),
      source: "pocketbase",
      updateTime: String(updated.updated || new Date().toISOString())
    });
  }

  function csvEscape(value) {
    var s = value === null || value === undefined ? "" : String(value);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toBase64Utf8(text) {
    return btoa(unescape(encodeURIComponent(text)));
  }

  function buildCategoryRankingCsv(ranking) {
    var lines = ["社團名稱,屬性,名次,總分,及格狀態,永久社團編號,狀態"];
    (ranking.categories || []).forEach(function (cat) {
      sortRankingRowsForDisplay_((cat && cat.rows) || []).forEach(function (row) {
        var score =
          row.displayScore !== null && row.displayScore !== undefined
            ? row.displayScore
            : row.finalTotalScore;
        lines.push(
          [
            row.clubName,
            cat.category,
            exportDisplayRankText_(row),
            row.rankStatus === "not_participating" ? "" : exportScoreOneDecimal_(score),
            exportPassStatusText_(row),
            row.permanentClubId || "",
            row.rankStatus || ""
          ]
            .map(csvEscape)
            .join(",")
        );
      });
    });
    return "\uFEFF" + lines.join("\r\n");
  }

  function exportScoreNumber_(value) {
    if (value === null || value === undefined || value === "") return "";
    var n = Number(value);
    if (!Number.isFinite(n)) return "";
    return Math.round(n * 100) / 100;
  }

  function exportRankingResultText_(row) {
    if (!row || row.complete !== true) return "未完成";
    if (row.passed === true) return "及格";
    if (row.passed === false) return "不及格";
    return "未判定";
  }

  function exportScoreHeader_(name, maxScore) {
    if (maxScore === null || maxScore === undefined || maxScore === "") {
      return String(name || "");
    }
    return String(name || "") + " / " + exportScoreNumber_(maxScore);
  }

  function exportSafeSheetName_(raw, used) {
    var base = String(raw || "工作表")
      .replace(/[\\\/\*\?\:\[\]]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();
    if (!base) base = "工作表";
    if (base.length > 31) base = base.slice(0, 31);
    var name = base;
    var i = 2;
    while (used[name]) {
      var suffix = "_" + i;
      name = (base.slice(0, Math.max(1, 31 - suffix.length)) + suffix).slice(0, 31);
      i += 1;
    }
    used[name] = true;
    return name;
  }

  function findAggregationClubForExport_(aggregation, row) {
    var clubs = (aggregation && aggregation.clubs) || [];
    var permanent = String((row && row.permanentClubId) || "")
      .trim()
      .toUpperCase();
    var name = String((row && row.clubName) || "").trim();
    if (permanent) {
      for (var i = 0; i < clubs.length; i++) {
        if (String(clubs[i].permanentClubId || "").trim().toUpperCase() === permanent) {
          return clubs[i];
        }
      }
    }
    if (name) {
      for (var j = 0; j < clubs.length; j++) {
        if (String(clubs[j].clubName || "").trim() === name) return clubs[j];
      }
    }
    return null;
  }

  function exportSectionBucketByIdOrName_(clubAgg, preferredId, nameRe) {
    if (!clubAgg) return null;
    if (clubAgg.sectionScores && clubAgg.sectionScores[preferredId]) {
      return clubAgg.sectionScores[preferredId];
    }
    var sections = Array.isArray(clubAgg.sections) ? clubAgg.sections : [];
    for (var i = 0; i < sections.length; i++) {
      var sec = sections[i];
      if (!sec) continue;
      if (String(sec.sectionId || "") === preferredId || nameRe.test(String(sec.sectionName || ""))) {
        return {
          finalScore: sec.finalScore,
          currentScore: sec.currentScore,
          averageScore: sec.averageScore,
          maxScore: sec.maxScore,
          complete: sec.complete === true
        };
      }
    }
    return null;
  }

  function exportGroupBucket_(clubAgg, preferredId, nameRe) {
    if (!clubAgg) return null;
    if (clubAgg.groupScores && clubAgg.groupScores[preferredId]) {
      return clubAgg.groupScores[preferredId];
    }
    // 後備：若 groupScores 未填，仍嘗試從大項名稱推斷（與畫面對齊為主）。
    return exportSectionBucketByIdOrName_(clubAgg, preferredId, nameRe);
  }

  function exportBucketScore_(bucket) {
    if (!bucket) return null;
    if (bucket.finalScore !== null && bucket.finalScore !== undefined) return bucket.finalScore;
    if (bucket.currentScore !== null && bucket.currentScore !== undefined) return bucket.currentScore;
    if (bucket.averageScore !== null && bucket.averageScore !== undefined) {
      return bucket.averageScore;
    }
    return null;
  }

  function exportMetricMaxFromAggregation_(aggregation, picker, fallback) {
    var clubs = (aggregation && aggregation.clubs) || [];
    for (var i = 0; i < clubs.length; i++) {
      var bucket = picker(clubs[i]);
      if (bucket && bucket.maxScore !== null && bucket.maxScore !== undefined) {
        var n = Number(bucket.maxScore);
        if (Number.isFinite(n)) return n;
      }
    }
    return fallback;
  }

  function exportPassStatusText_(row) {
    if (!row) return "";
    if (row.rankStatus === "not_participating") return "";
    if (row.passStatus) return String(row.passStatus);
    if (row.rankStatus === "provisional") return "暫排名";
    if (row.passed === true) return "及格";
    if (row.passed === false) return "未達及格";
    if (row.complete !== true) return "未完成";
    return "";
  }

  function exportDisplayRankText_(row) {
    if (!row) return "";
    if (row.rankStatus === "provisional") {
      var base = String(row.displayRank || "暫");
      var names = Array.isArray(row.unassignedSectionNames)
        ? row.unassignedSectionNames.filter(Boolean)
        : [];
      if (names.length) return base + "（未指派：" + names.join("、") + "）";
      return base;
    }
    if (
      row.rankStatus === "ranked" ||
      row.rankStatus === "tied" ||
      row.rankStatus === "tie_pending"
    ) {
      return row.displayRank ? String(row.displayRank) : "";
    }
    return "";
  }

  function exportDisplayRankCell_(row) {
    var text = exportDisplayRankText_(row);
    if (text === "") return "";
    if (/^\d+$/.test(text)) return Number(text);
    return text;
  }

  function rankingExcelCoverTitle_(ranking) {
    var raw = String((ranking && ranking.activityTitle) || "").trim();
    if (/^115-1/.test(raw) || /115\s*學年/.test(raw) || !raw) {
      return "115-1 社團評鑑繳交";
    }
    return raw;
  }

  function buildCategoryRankingWorkbook(ranking, aggregation) {
    void aggregation;
    var coverTitle = rankingExcelCoverTitle_(ranking);
    var generatedAt = (ranking && ranking.generatedAt) || new Date().toISOString();
    var downloadDate = String(generatedAt).slice(0, 10);
    var headers = ["社團名稱", "屬性", "名次", "總分", "及格狀態"];
    var usedNames = {};
    var sheets = [];
    var rowCount = 0;
    var categories = (ranking && ranking.categories) || [];
    var byName = {};
    categories.forEach(function (cat) {
      byName[String((cat && cat.category) || "未分類")] = cat;
    });
    canonicalRankingCategories_().forEach(function (categoryName) {
      var cat = byName[categoryName] || { category: categoryName, rows: [] };
      var dataRows = sortRankingRowsForDisplay_((cat && cat.rows) || []);
      var sheetRows = [
        [coverTitle],
        ["屬性：" + categoryName],
        ["下載日期：" + downloadDate],
        headers
      ];
      dataRows.forEach(function (row) {
        var score =
          row.displayScore !== null && row.displayScore !== undefined
            ? row.displayScore
            : row.finalTotalScore !== null && row.finalTotalScore !== undefined
              ? row.finalTotalScore
              : row.currentTotalScore;
        var scoreCell =
          row && row.rankStatus === "not_participating"
            ? ""
            : exportScoreOneDecimal_(score);
        sheetRows.push([
          (row && row.clubName) || "",
          categoryName,
          exportDisplayRankCell_(row),
          scoreCell,
          exportPassStatusText_(row)
        ]);
        rowCount += 1;
      });
      sheets.push({
        name: exportSafeSheetName_(categoryName, usedNames),
        category: categoryName,
        headerRowIndex: 4,
        freezeRows: 4,
        filterRef: "A4:E" + String(Math.max(4, sheetRows.length)),
        columnWidths: [20, 14, 10, 10, 12],
        rows: sheetRows
      });
    });

    return {
      sheets: sheets,
      summary: {
        categoryCount: sheets.length,
        sheetCount: sheets.length,
        rowCount: rowCount
      }
    };
  }

  function buildOrganizerAuditCsv(aggregation) {
    var lines = [
      "社團,屬性,永久社團編號,完成,缺少評審,待重送大項,目前總分,正式總分,滿分"
    ];
    (aggregation.clubs || []).forEach(function (club) {
      lines.push(
        [
          club.clubName,
          club.category,
          club.permanentClubId || "",
          club.complete ? "Y" : "N",
          club.missingJudgeAssignments || 0,
          club.reopenedSectionCount || 0,
          club.currentTotalScore === null || club.currentTotalScore === undefined
            ? ""
            : club.currentTotalScore,
          club.finalTotalScore === null || club.finalTotalScore === undefined
            ? ""
            : club.finalTotalScore,
          club.totalMaxScore
        ]
          .map(csvEscape)
          .join(",")
      );
      (club.sections || []).forEach(function (sec) {
        (sec.judges || []).forEach(function (j) {
          lines.push(
            [
              club.clubName,
              sec.sectionName,
              j.judgeName,
              j.status,
              j.score === null || j.score === undefined ? "" : j.score,
              "",
              "",
              "",
              sec.maxScore
            ]
              .map(csvEscape)
              .join(",")
          );
        });
      });
    });
    return "\uFEFF" + lines.join("\r\n");
  }

  function judgeConfirmStatusText(status, reopened) {
    var value = String(status || "");
    if (value === "submitted") return "✅ 已正式送出";
    if (value === "reopened" || reopened === true) return "🔓 已解鎖待重送";
    if (value === "draft") return "📝 未送出（草稿）";
    if (value === "not_started") return "⚠️ 未評";
    return "⚠️ 尚未評分";
  }

  function normalizeJudgeConfirmSheetKind(raw) {
    var kind = String(raw || "all").trim();
    if (!kind) return "";
    if (["dataReview", "fieldReview", "total", "all"].indexOf(kind) >= 0) return kind;
    // Accept live scoreConfig section ids after admin adds/renames 大項.
    if (/^[A-Za-z0-9_\-]{1,80}$/.test(kind)) return kind;
    return "";
  }

  function judgeConfirmSheetKindLabel(kind, sections) {
    if (kind === "dataReview") return "資料審查";
    if (kind === "fieldReview") return "實地審查";
    if (kind === "total") return "總成績";
    if (kind === "all") return "全部大項";
    var list = Array.isArray(sections) ? sections : [];
    var hit = list.find(function (s) {
      return String((s && s.id) || "") === String(kind || "");
    });
    if (hit) return String(hit.name || hit.id || kind);
    return String(kind || "確認表");
  }

  function buildJudgeConfirmSectionMetaList_(records, sections) {
    var ordered = [];
    var seen = {};
    function pushMeta(id, name) {
      var sid = String(id || "").trim();
      if (!sid || seen[sid]) return;
      seen[sid] = true;
      ordered.push({
        id: sid,
        name: String(name || sid)
      });
    }
    (Array.isArray(sections) ? sections : []).forEach(function (section) {
      if (!section || section.enabled === false) return;
      if (String(section.scoringMode || "") === "manual") return;
      pushMeta(section.id, section.name);
    });
    (Array.isArray(records) ? records : []).forEach(function (record) {
      if (!record) return;
      pushMeta(record.sectionId, record.sectionName);
    });
    return ordered;
  }

  function safeExportFileName(raw) {
    return String(raw || "file")
      .replace(/[\\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 80);
  }

  function judgeConfirmSectionFullyComplete(record) {
    if (!record || String(record.status || "") !== "submitted") return false;
    var detail = record.detail || {};
    if (detail.totalScore === null || detail.totalScore === undefined) return false;
    var groups = Array.isArray(detail.groups) ? detail.groups : [];
    if (!groups.length) return false;
    var criterionCount = 0;
    for (var g = 0; g < groups.length; g += 1) {
      var criteria = Array.isArray(groups[g].criteria) ? groups[g].criteria : [];
      for (var c = 0; c < criteria.length; c += 1) {
        criterionCount += 1;
        var item = criteria[c];
        if (item.answered === false) return false;
        if (item.score === null || item.score === undefined || item.score === "") return false;
        if (!Number.isFinite(Number(item.score))) return false;
      }
    }
    return criterionCount > 0;
  }

  function buildJudgeConfirmClubTotals(records, sections) {
    var sectionMeta = buildJudgeConfirmSectionMetaList_(records, sections);
    var byClub = {};
    (records || []).forEach(function (record) {
      if (!record) return;
      var sectionId = String(record.sectionId || "");
      if (!sectionId) return;
      var key =
        String(record.permanentClubId || "").trim() ||
        "name:" + String(record.clubName || "");
      if (!byClub[key]) {
        byClub[key] = {
          clubName: String(record.clubName || ""),
          permanentClubId: String(record.permanentClubId || ""),
          category: String(record.category || ""),
          bySection: {}
        };
      }
      byClub[key].bySection[sectionId] = record;
      if (!byClub[key].clubName && record.clubName) {
        byClub[key].clubName = String(record.clubName);
      }
    });
    return Object.keys(byClub).map(function (key) {
      var row = byClub[key];
      var sectionScores = {};
      var sectionStatuses = {};
      var complete = sectionMeta.length > 0;
      var sum = 0;
      var statusParts = [];
      sectionMeta.forEach(function (meta) {
        var rec = row.bySection[meta.id] || null;
        var ok = judgeConfirmSectionFullyComplete(rec);
        var score = ok ? Number(rec.detail.totalScore) : null;
        sectionScores[meta.id] = score;
        sectionStatuses[meta.id] = rec
          ? judgeConfirmStatusText(rec.status, rec.reopened)
          : "⚠️ 未評";
        if (!ok) complete = false;
        if (score !== null && Number.isFinite(score)) sum += score;
        if (!rec) statusParts.push(String(meta.name || meta.id) + "未評");
        else statusParts.push(judgeConfirmStatusText(rec.status, rec.reopened));
      });
      var legacyDataId =
        sectionMeta.find(function (meta) {
          return (
            meta.id === "dataReview" ||
            /資料審查|數位資料/.test(String(meta.name || ""))
          );
        }) ||
        sectionMeta[0] ||
        null;
      var legacyFieldId =
        sectionMeta.find(function (meta) {
          return (
            meta.id === "fieldReview" ||
            /實地審查|現場|詢答/.test(String(meta.name || ""))
          );
        }) ||
        sectionMeta[1] ||
        null;
      var dataScore = legacyDataId ? sectionScores[legacyDataId.id] : null;
      var fieldScore = legacyFieldId ? sectionScores[legacyFieldId.id] : null;
      return {
        clubName: row.clubName,
        permanentClubId: row.permanentClubId,
        category: row.category,
        sectionMeta: sectionMeta,
        sectionScores: sectionScores,
        sectionStatuses: sectionStatuses,
        dataReviewStatus: legacyDataId
          ? sectionStatuses[legacyDataId.id]
          : "⚠️ 未評",
        fieldReviewStatus: legacyFieldId
          ? sectionStatuses[legacyFieldId.id]
          : "⚠️ 未評",
        dataReviewScore: dataScore,
        fieldReviewScore: fieldScore,
        personalTotal: complete ? sum : null,
        personalTotalText: complete ? String(sum) : "尚未完成",
        statusText: complete ? "✅ 各大項已完成" : statusParts.join("／"),
        complete: complete
      };
    });
  }

  function buildJudgeConfirmDetail(section, row) {
    var answers = (row && row.answers_json) || {};
    var scores =
      answers.scores && typeof answers.scores === "object" ? answers.scores : {};
    var groups = [];
    var calculated = 0;
    (section.groups || []).forEach(function (g) {
      if (!g || g.enabled === false) return;
      var criteria = [];
      var subtotal = 0;
      var groupMax = 0;
      (g.criteria || []).forEach(function (c) {
        if (!c || c.enabled === false) return;
        var maxScore = Number(c.maxScore) || 0;
        groupMax += maxScore;
        var raw = scores[c.id];
        var answered = raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw));
        var score = answered ? Number(raw) : null;
        if (answered) subtotal += score;
        criteria.push({
          id: c.id,
          name: c.name || c.id,
          maxScore: maxScore,
          score: score,
          answered: answered
        });
      });
      if (!criteria.length) return;
      calculated += subtotal;
      groups.push({
        id: g.id,
        name: g.name || g.id,
        maxScore: Number(g.maxScore) || groupMax,
        subtotal: subtotal,
        criteria: criteria
      });
    });
    var totalScore =
      row && row.status === "submitted"
        ? Number(row.score) || calculated
        : row
          ? Number(row.score) || calculated
          : null;
    if (!row) totalScore = null;
    return {
      sectionId: section.id,
      sectionName: section.name || section.id,
      maxScore: Number(section.maxScore) || 0,
      totalScore: totalScore,
      calculatedTotal: calculated,
      groups: groups
    };
  }

  function buildJudgeConfirmRecord(judge, section, club, row) {
    var answers = (row && row.answers_json) || {};
    var reopened = !!(answers && answers.reopened);
    var status = !row
      ? "not_started"
      : reopened
        ? "reopened"
        : row.status === "submitted"
          ? "submitted"
          : "draft";
    var detail = buildJudgeConfirmDetail(section, row);
    return {
      success: true,
      judgeId: judge.id,
      clubName: club.name,
      permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
      category: club.category || "",
      sectionId: section.id,
      sectionName: section.name || section.id,
      sectionIcon: section.icon || "📌",
      sectionMaxScore: Number(section.maxScore) || 0,
      status: status,
      statusText: judgeConfirmStatusText(status, reopened),
      locked: status === "submitted",
      reopened: reopened,
      staleDraft: false,
      hasHistory: false,
      historyCount: 0,
      history: [],
      submittedAt: row && row.submitted_at ? row.submitted_at : null,
      lastSubmittedAt: row && row.submitted_at ? row.submitted_at : null,
      updatedAt: row && row.updated ? row.updated : null,
      unlockedAt: answers.unlockedAt || null,
      submissionRevision: row ? Number(row.revision) || 1 : null,
      detail: detail
    };
  }

  function resolveConfirmSectionId(sections, kind) {
    var list = Array.isArray(sections) ? sections : [];
    var kindId = String(kind || "").trim();
    if (!kindId || kindId === "total" || kindId === "all") return "";
    var exact = list.find(function (s) {
      return String(s.id) === kindId;
    });
    if (exact) return exact.id;
    if (kindId === "dataReview") {
      var byName = list.find(function (s) {
        return /資料審查|數位資料|資料/.test(String(s.name || ""));
      });
      if (byName) return byName.id;
      return list[0] ? list[0].id : "";
    }
    if (kindId === "fieldReview") {
      var byName2 = list.find(function (s) {
        return /實地審查|現場|詢答|實地/.test(String(s.name || ""));
      });
      if (byName2) return byName2.id;
      return list[1] ? list[1].id : list[0] ? list[0].id : "";
    }
    return kindId;
  }

  function filterJudgeConfirmRecordsBySheetKind(records, sheetKind, sections) {
    var list = Array.isArray(records) ? records : [];
    if (sheetKind === "total") return [];
    if (sheetKind === "all") return list;
    var sectionId = resolveConfirmSectionId(sections, sheetKind);
    return list.filter(function (record) {
      var id = String((record && record.sectionId) || "");
      if (sectionId && id === sectionId) return true;
      if (id === sheetKind) return true;
      if (sheetKind === "dataReview" && /資料審查|數位資料|資料/.test(String(record.sectionName || ""))) {
        return true;
      }
      if (sheetKind === "fieldReview" && /實地審查|現場|詢答|實地/.test(String(record.sectionName || ""))) {
        return true;
      }
      return false;
    });
  }

  async function buildJudgeConfirmationModel(data) {
    var judgeId = String((data && data.judgeId) || "").trim();
    if (!judgeId) return fail("請選擇要匯出的評審。", "JUDGE_ID_REQUIRED");
    var sheetKind = normalizeJudgeConfirmSheetKind((data && data.sheetKind) || "all");
    if (!sheetKind) {
      return fail(
        "匯出類別無效。請選擇評分機制中的大項、總成績或全部大項。",
        "JUDGE_CONFIRM_SHEET_KIND_INVALID"
      );
    }

    var ctx = await loadAggregationContext();
    var judge =
      ctx.judges.find(function (j) {
        return String(j.id) === judgeId;
      }) || null;
    if (!judge) {
      try {
        var archived = await pb().collection(C().staff).getOne(judgeId);
        if (archived && archived.role === "judge") judge = mapJudgeAdmin(archived);
      } catch (_e) {
        judge = null;
      }
    }
    if (!judge) return fail("找不到指定的評審。", "JUDGE_NOT_FOUND");

    var sections = publishedSectionsOf(ctx.scoreConfig);
    if (Array.isArray(judge.scoreSectionIds) && judge.scoreSectionIds.length) {
      var allowed = {};
      judge.scoreSectionIds.forEach(function (id) {
        allowed[String(id)] = true;
      });
      var filtered = sections.filter(function (s) {
        return allowed[String(s.id)];
      });
      if (filtered.length) sections = filtered;
    }

    if (
      sheetKind !== "total" &&
      sheetKind !== "all" &&
      sheetKind !== "dataReview" &&
      sheetKind !== "fieldReview"
    ) {
      var knownSection = sections.some(function (s) {
        return String(s.id) === sheetKind;
      });
      if (!knownSection) {
        return fail(
          "找不到對應的評分大項。請重新整理後再選，或先確認評分機制已儲存／發布。",
          "JUDGE_CONFIRM_SHEET_KIND_INVALID"
        );
      }
    }

    var records = [];
    sections.forEach(function (section) {
      ctx.clubs.forEach(function (club) {
        var row = ctx.byKey[judge.id + "::" + club.id + "::" + section.id] || null;
        /*
         * 有實際評分紀錄一定列入；其餘仍依指派範圍列出未評佔位。
         */
        if (!row && !judgeCoversClub(judge, club, section.id)) return;
        records.push(buildJudgeConfirmRecord(judge, section, club, row));
      });
    });

    records.sort(function (a, b) {
      var clubCmp = String(a.clubName || "").localeCompare(String(b.clubName || ""), "zh-TW");
      if (clubCmp) return clubCmp;
      return String(a.sectionName || "").localeCompare(String(b.sectionName || ""), "zh-TW");
    });

    var sectionMeta = buildJudgeConfirmSectionMetaList_(records, sections);
    var clubTotals = buildJudgeConfirmClubTotals(records, sections);
    var filteredRecords = filterJudgeConfirmRecordsBySheetKind(records, sheetKind, sections);
    var submittedCount = records.filter(function (r) {
      return r.status === "submitted";
    }).length;
    var reopenedCount = records.filter(function (r) {
      return r.status === "reopened";
    }).length;
    var generatedAt = new Date().toISOString();

    return ok({
      version: "pb-1.0.0",
      generatedAt: generatedAt,
      sheetKind: sheetKind,
      sheetKindLabel: judgeConfirmSheetKindLabel(sheetKind, sections),
      layoutStatus: "html-confirmation",
      delivery: "html",
      judge: {
        id: judge.id,
        judgeId: judge.id,
        email: judge.email || "",
        username: judge.username || judge.email || "",
        name: judge.name || "",
        displayName: judge.displayName || judge.name || judge.email || "",
        active: judge.active !== false,
        categories: Array.isArray(judge.categories) ? judge.categories.slice() : [],
        scoreSectionIds: Array.isArray(judge.scoreSectionIds) ? judge.scoreSectionIds.slice() : []
      },
      summary: {
        recordCount: filteredRecords.length,
        submittedCount: submittedCount,
        reopenedCount: reopenedCount,
        errorCount: 0,
        assignedClubCount: clubTotals.length,
        completedPersonalTotalCount: clubTotals.filter(function (row) {
          return row.complete === true;
        }).length
      },
      records: filteredRecords,
      allRecords: records,
      sectionMeta: sectionMeta,
      clubTotals: clubTotals,
      errors: []
    });
  }

  function judgeConfirmFileName(model, ext) {
    var stamp = String(model.generatedAt || new Date().toISOString())
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z")
      .replace("T", "_")
      .slice(0, 15);
    var judge = model.judge || {};
    var judgeName = safeExportFileName(
      judge.displayName || judge.name || judge.username || "評審"
    );
    var judgeKey = safeExportFileName(judge.id || judge.username || "judge");
    var kindLabel = safeExportFileName(
      model.sheetKindLabel ||
        judgeConfirmSheetKindLabel(model.sheetKind, model.sectionMeta)
    );
    return (
      safeExportFileName("115學年度第一學期全校學生社團評選暨觀摩活動") +
      "_評審個人評分確認表_" +
      judgeName +
      "_" +
      judgeKey +
      "_" +
      kindLabel +
      "_" +
      stamp +
      (ext || ".html")
    );
  }

  async function adminJudgeConfirmationExport(data) {
    return buildJudgeConfirmationModel(data || {});
  }

  async function adminJudgeConfirmationPdfExport(data) {
    var model = await buildJudgeConfirmationModel(data || {});
    if (!model || model.success !== true) return model;
    var fileName = judgeConfirmFileName(model, ".pdf");
    return ok(
      Object.assign({}, model, {
        delivery: "client-pdf",
        fileName: fileName,
        mimeType: "application/pdf",
        sizeBytes: null,
        base64: null,
        note: "PocketBase：瀏覽器端產生評審個人評分確認表 PDF。"
      })
    );
  }

  async function adminJudgeConfirmationPdfBatchExport(data) {
    var sheetKind = normalizeJudgeConfirmSheetKind((data && data.sheetKind) || "all");
    if (!sheetKind) {
      return fail(
        "匯出類別無效。請選擇評分機制中的大項、總成績或全部大項。",
        "JUDGE_CONFIRM_SHEET_KIND_INVALID"
      );
    }
    var rawIds = Array.isArray(data && data.judgeIds)
      ? data.judgeIds
      : data && data.judgeIds
        ? [data.judgeIds]
        : [];
    var judgeIds = [];
    var seen = {};
    rawIds.forEach(function (item) {
      var id = String(item || "").trim();
      if (!id || seen[id]) return;
      seen[id] = true;
      judgeIds.push(id);
    });
    if (!judgeIds.length) return fail("請至少選擇一位評審。", "JUDGE_IDS_REQUIRED");
    if (judgeIds.length > 20) return fail("一次最多 20 位評審。", "JUDGE_IDS_TOO_MANY");

    var results = [];
    var successCount = 0;
    var failCount = 0;
    for (var i = 0; i < judgeIds.length; i += 1) {
      var one = await adminJudgeConfirmationPdfExport({
        judgeId: judgeIds[i],
        sheetKind: sheetKind
      });
      if (one && one.success) {
        successCount += 1;
        results.push(
          Object.assign({}, one, {
            judgeId: judgeIds[i],
            success: true
          })
        );
      } else {
        failCount += 1;
        results.push({
          success: false,
          judgeId: judgeIds[i],
          error: (one && one.error) || "PDF_FAILED",
          message: (one && one.message) || "確認表產生失敗"
        });
      }
    }
    return ok({
      sheetKind: sheetKind,
      results: results,
      successCount: successCount,
      failCount: failCount
    });
  }

  async function adminCategoryRankingExcelExport() {
    var ctx = await loadAggregationContext();
    var aggregation = buildClubAggregation(ctx);
    var ranking = buildRankingPayload(ctx, aggregation);
    var workbook = buildCategoryRankingWorkbook(ranking, aggregation);
    var stamp = new Date().toISOString().slice(0, 10);
    var title = rankingActivityTitle_(ctx.activity).replace(/[\\\/:*?"<>|]+/g, "_");
    return ok({
      delivery: "client-xlsx",
      workbook: workbook,
      // 保留舊 CSV 後備，避免舊前端只認 base64 時完全不能下載。
      base64: toBase64Utf8(buildCategoryRankingCsv(ranking)),
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileName: title + "社團排名" + stamp + ".xlsx",
      generatedAt: ranking.generatedAt,
      activityTitle: title,
      summary: {
        categoryCount: workbook.summary.categoryCount,
        sheetCount: workbook.summary.sheetCount,
        rowCount: workbook.summary.rowCount
      }
    });
  }

  async function adminOrganizerAuditExcelExport() {
    var ctx = await loadAggregationContext();
    var aggregation = buildClubAggregation(ctx);
    var csv = buildOrganizerAuditCsv(aggregation);
    var stamp = new Date().toISOString().slice(0, 10);
    return ok({
      base64: toBase64Utf8(csv),
      mimeType: "text/csv;charset=utf-8",
      fileName: "hksp-organizer-audit-" + stamp + ".csv",
      generatedAt: aggregation.generatedAt,
      summary: {
        clubCount: aggregation.clubs.length,
        completeClubCount: aggregation.summary.completeClubCount
      }
    });
  }

  var handlers = {
    adminLogin: adminLogin,
    adminLogout: adminLogout,
    adminReadActivityHandover: adminReadActivityHandover,
    adminPreviewActivityHandover: adminPreviewActivityHandover,
    adminExecuteActivityHandover: adminExecuteActivityHandover,
    adminListClubs: adminListClubs,
    adminListClubUploadSummary: adminListClubUploadSummary,
    adminListFeatureUploads: adminListFeatureUploads,
    adminBrowseClubUploads: adminBrowseClubUploads,
    adminAddClub: adminAddClub,
    adminUpdateClub: adminUpdateClub,
    adminDeleteClub: adminDeleteClub,
    adminSetClubCloudParticipation: adminSetClubCloudParticipation,
    adminListClubCloudRows: adminListClubCloudRows,
    adminListClubStudents: adminListClubStudents,
    adminEnrollClubStudentBirth: adminEnrollClubStudentBirth,
    adminResetClubStudentPassword: adminResetClubStudentPassword,
    adminUnbindClubStudent: adminUnbindClubStudent,
    adminRebindClubStudent: adminRebindClubStudent,
    adminPreviewWrongRegistrationReset: adminPreviewWrongRegistrationReset,
    adminResetWrongRegistration: adminResetWrongRegistration,
    adminPurgeStudentByStudentId: adminPurgeStudentByStudentId,
    getEventConfig: getEventConfig,
    adminSaveEventConfig: adminSaveEventConfig,
    adminGetCloudUploadSettings: adminGetCloudUploadSettings,
    adminSaveEvaluationUploadSettings: adminSaveEvaluationUploadSettings,
    adminSaveFeatureUploadSettings: adminSaveFeatureUploadSettings,
    adminGetUploadGate: adminGetUploadGate,
    adminSetUploadGate: adminSetUploadGate,
    adminPreviewUploadGateOpen: adminPreviewUploadGateOpen,
    adminListJudges: adminListJudges,
    adminAddJudge: adminAddJudge,
    adminUpdateJudge: adminUpdateJudge,
    adminSetJudgeActive: adminSetJudgeActive,
    adminResetJudgePassword: adminResetJudgePassword,
    adminDeleteJudge: adminDeleteJudge,
    adminGetScoreConfig: adminGetScoreConfig,
    adminSaveScoreConfig: adminSaveScoreConfig,
    adminSetScorePhasePublished: adminSetScorePhasePublished,
    adminUnlockJudgeScore: adminUnlockJudgeScore,
    adminGetJudgeScoreHistory: adminGetJudgeScoreHistory,
    adminJudgeScoreProgress: adminJudgeScoreProgress,
    adminJudgeGetRawScore: adminJudgeGetRawScore,
    adminScoreAggregationSummary: adminScoreAggregationSummary,
    adminScoreAggregation: adminScoreAggregation,
    adminRanking: adminRanking,
    adminSaveRankingConfig: adminSaveRankingConfig,
    adminCategoryRankingExcelExport: adminCategoryRankingExcelExport,
    adminOrganizerAuditExcelExport: adminOrganizerAuditExcelExport,
    adminJudgeConfirmationExport: adminJudgeConfirmationExport,
    adminJudgeConfirmationPdfExport: adminJudgeConfirmationPdfExport,
    adminJudgeConfirmationPdfBatchExport: adminJudgeConfirmationPdfBatchExport
  };

  async function request(payload) {
    var action = String((payload && payload.action) || "");
    if (!action) return fail("缺少 action。");
    try {
      if (action !== "adminLogin") {
        await ensureAdminFromToken(payload && payload.sessionToken);
      }
      var fn = handlers[action];
      if (!fn) return stubOk(action);
      return await fn(payload || {});
    } catch (e) {
      var msg = String((e && e.message) || e || "操作失敗");
      if (msg === "ADMIN_UNAUTHORIZED" || /unauthorized|auth/i.test(msg)) {
        return fail("管理員登入已失效，請重新登入。", "ADMIN_UNAUTHORIZED");
      }
      return fail(msg);
    }
  }

  function configureUi() {
    if (!enabled()) return;
    document.documentElement.classList.add("pocketbase-admin");
    if (!$("pocketbaseAdminStyle")) {
      var style = document.createElement("style");
      style.id = "pocketbaseAdminStyle";
      style.textContent =
        ".pocketbase-admin .panel[hidden],.pocketbase-admin .stat[hidden]{display:none!important}";
      document.head.append(style);
    }
    document.querySelectorAll(".panel").forEach(function (panel) {
      if (
        !panel.querySelector(
          "#clubList,#clubStudentList,#clubUploadList,#clubUploadBrowser,#featureUploadMeta,#featureUploadList,#eventMeta,#cloudUploadMeta,#uploadGateStatus,#judgeList,#sectionsEditor,#progressMeta,#judgeProgressList,#aggregationMeta,#rankingMeta,#categoryRankingExcelMeta,#organizerAuditExcelMeta,#judgeExportMeta,#judgeExportJudge,#judgeBatchJudgeList"
        )
      ) {
        panel.hidden = true;
      }
    });
    document.querySelectorAll(".stat").forEach(function (stat) {
      if (!stat.querySelector("#statClubs,#statJudges")) stat.hidden = true;
    });
    document
      .querySelectorAll('button[onclick*="previewHandover"],button[onclick*="executeHandover"]')
      .forEach(function (button) {
        button.disabled = true;
      });
    var previewBtn = $("judgeExportPreviewBtn");
    if (previewBtn) previewBtn.hidden = true;
    var previewBox = $("judgeExportPreview");
    if (previewBox) previewBox.hidden = true;
    var title = document.querySelector(".hero h1");
    if (title) title.textContent = "PocketBase 管理中心";
    var subtitle = document.querySelector(".hero .sub");
    if (subtitle) {
      subtitle.textContent =
        "社團、上傳資料瀏覽、評審、時程、成績彙整／排名／評審確認表與 CSV 匯出（Drive 代傳已擱置）";
    }
    var emailInput = $("adminEmail");
    if (emailInput && !String(emailInput.value || "").trim()) {
      emailInput.value = staffAdminEmail();
    }
    if (emailInput) emailInput.required = true;
    var loginSub = document.querySelector(".login-card .muted");
    if (loginSub) loginSub.textContent = "PocketBase 管理登入 · " + staffAdminEmail();
  }

  root.HKSP_ADMIN_PB = {
    enabled: enabled,
    configureUi: configureUi,
    request: request,
    staffAdminEmail: staffAdminEmail
  };

  if (enabled()) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", configureUi);
    } else {
      configureUi();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
