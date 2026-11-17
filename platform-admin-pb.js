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

  function mapClub(rec) {
    return {
      id: rec.id,
      permanentClubId: String(rec.permanent_club_id || "").toUpperCase(),
      clubId: String(rec.permanent_club_id || "").toUpperCase(),
      name: rec.name || "",
      category: rec.category || "",
      active: rec.active !== false,
      driveFolderId: rec.drive_folder_id || "",
      version: Number(rec.meta_json && rec.meta_json.version) || 1,
      updated: rec.updated || "",
      created: rec.created || ""
    };
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
    if (!rec || (rec.role !== "admin" && rec.role !== "service") || rec.active === false) {
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
        version: Number(makeup.version || conf[key + "Version"] || 1) || 1,
        url: kind === "feature" ? conf.featureFolderUrl || "" : ""
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
        pauseEffectNote: "暫停時前端上傳窗口會關閉。"
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
      if (!rec || (rec.role !== "admin" && rec.role !== "service")) {
        pb().authStore.clear();
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
      webViewLink: rec.drive_web_view_link || fileUrl || ""
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
    uploads.forEach(function (u) {
      var key = String(u.club || "");
      if (!key) return;
      if (!byClub[key]) {
        byClub[key] = {
          fileCount: 0,
          evaluationCount: 0,
          featureCount: 0,
          completedCount: 0,
          latestUploadedAt: ""
        };
      }
      var row = byClub[key];
      row.fileCount += 1;
      if (u.upload_kind === "feature") row.featureCount += 1;
      else row.evaluationCount += 1;
      if (u.status === "completed" || u.status === "uploaded") row.completedCount += 1;
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
        latestUploadedAt: ""
      };
      return Object.assign({}, mapped, stats);
    });
    return ok({
      activityId: activity.activity_id || activityId(),
      clubs: summary,
      totalFiles: uploads.length,
      clubsWithFiles: summary.filter(function (c) {
        return c.fileCount > 0;
      }).length
    });
  }

  async function adminBrowseClubUploads(data) {
    var activity = await getActivityRecord();
    var club = await resolveAdminClub(activity, data || {});
    var root = await findClubRootFolder(activity, club);
    var parentId = String((data && data.parentFolderId) || "").trim();
    if (!parentId) parentId = root ? root.id : "";

    var folders = [];
    var files = [];
    var path = [
      {
        folderId: root ? root.id : "",
        name: club.name || "社團根目錄",
        depth: 0
      }
    ];

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
          '" && status!="trashed"',
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
    } else {
      // No folder tree yet: still show club-level uploads (folder empty / unset).
      files = await pb().collection(C().uploads).getFullList({
        filter: 'club="' + club.id + '" && status!="trashed"',
        sort: "-created"
      });
    }

    return ok({
      activityId: activity.activity_id || activityId(),
      clubId: club.id,
      permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
      clubName: club.name || "",
      category: club.category || "",
      clubFolderId: root ? root.id : "",
      parentFolderId: parentId,
      path: path,
      folders: folders.map(function (f) {
        return {
          folderId: f.id,
          id: f.id,
          name: f.name,
          kind: f.kind || "evaluation"
        };
      }),
      files: files.map(mapAdminUploadFile),
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
      var seatVersion = mems.reduce(function (max, m) {
        var t = Date.parse(String(m.updated || m.created || ""));
        return Number.isFinite(t) && t > max ? t : max;
      }, 0);
      groups.push({
        activityId: activity.activity_id,
        permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
        clubName: club.name,
        category: club.category || "",
        active: club.active !== false,
        clubDisabled: club.active === false,
        seatStatus: primary ? "occupied" : "empty",
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
    return ok({
      studentId: studentId,
      uid: student.id,
      permanentClubId: permanent,
      mustChangePassword: !!student.must_change_password,
      seatStatus: "occupied"
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

  async function adminUnbindClubStudent(data) {
    var activity = await getActivityRecord();
    var permanent = String(data.permanentClubId || "").trim().toUpperCase();
    var uid = String(data.uid || "").trim();
    if (!permanent || !uid) return fail("缺少社團或學生。");
    try {
      var club = await pb()
        .collection(C().clubs)
        .getFirstListItem('activity="' + activity.id + '" && permanent_club_id="' + permanent + '"');
      var mem = await pb()
        .collection(C().memberships)
        .getFirstListItem(
          'activity="' + activity.id + '" && club="' + club.id + '" && student="' + uid + '"'
        );
      await pb().collection(C().memberships).update(mem.id, {
        status: "revoked",
        can_upload: false
      });
      return ok({
        uid: uid,
        permanentClubId: permanent,
        seatReleased: true,
        seatStatus: "empty"
      });
    } catch (e) {
      return fail((e && e.message) || "解除綁定失敗。");
    }
  }

  async function adminRebindClubStudent(data) {
    var activity = await getActivityRecord();
    var fromId = String(data.fromPermanentClubId || data.permanentClubId || "").trim().toUpperCase();
    var toId = String(data.toPermanentClubId || "").trim().toUpperCase();
    var uid = String(data.uid || "").trim();
    if (!fromId || !toId || !uid) return fail("缺少改綁參數。");
    try {
      var fromClub = await pb()
        .collection(C().clubs)
        .getFirstListItem('activity="' + activity.id + '" && permanent_club_id="' + fromId + '"');
      var toClub = await pb()
        .collection(C().clubs)
        .getFirstListItem(
          'activity="' + activity.id + '" && permanent_club_id="' + toId + '" && active=true'
        );
      var targetHolders = await pb().collection(C().memberships).getFullList({
        filter:
          'activity="' + activity.id + '" && club="' + toClub.id + '" && status="active"'
      });
      var targetTaken = targetHolders.some(function (m) {
        return String(m.student) !== String(uid);
      });
      if (targetTaken) {
        return fail("目標社團名額已被占用，每個社團僅能有一個帳號。", "TARGET_SEAT_OCCUPIED");
      }
      try {
        var oldMem = await pb()
          .collection(C().memberships)
          .getFirstListItem(
            'activity="' + activity.id + '" && club="' + fromClub.id + '" && student="' + uid + '"'
          );
        await pb().collection(C().memberships).update(oldMem.id, {
          status: "revoked",
          can_upload: false
        });
      } catch (_e) {
        /* ignore missing old membership */
      }
      var existing = await pb().collection(C().memberships).getList(1, 1, {
        filter:
          'activity="' + activity.id + '" && club="' + toClub.id + '" && student="' + uid + '"'
      });
      if (existing.totalItems > 0) {
        await pb().collection(C().memberships).update(existing.items[0].id, {
          status: "active",
          can_upload: true
        });
      } else {
        await pb().collection(C().memberships).create({
          activity: activity.id,
          club: toClub.id,
          student: uid,
          role: "member",
          status: "active",
          can_upload: true,
          bound_at: new Date().toISOString()
        });
      }
      return ok({
        uid: uid,
        fromPermanentClubId: fromId,
        toPermanentClubId: toId,
        seatReleasedFrom: fromId,
        seatOccupiedTo: toId
      });
    } catch (e) {
      return fail((e && e.message) || "改綁失敗。");
    }
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
        "解綁保留 Auth／帳號／密碼並釋放名額；錯誤註冊重設會刪除 Auth 與帳號，使同學號可重新註冊。"
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
    if (data.deadlineAt) conf.featureDeadline = data.deadlineAt;
    if (data.url != null) conf.featureFolderUrl = String(data.url || "");
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
    return ok({ judges: judges });
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
    answers.reopened = true;
    answers.locked = false;
    answers.unlockedAt = new Date().toISOString();
    var updated = await pb().collection(C().scores).update(row.id, {
      answers_json: answers,
      status: "draft"
    });
    return ok({
      id: updated.id,
      reopened: true,
      unlockedAt: answers.unlockedAt
    });
  }

  async function adminJudgeScoreProgress() {
    var activity = await getActivityRecord();
    var conf = activity.config_json || {};
    var scoreConfig = conf.scoreConfig || defaultScoreConfig();
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
      byKey[row.judge + "::" + row.club + "::" + row.section_id] = row;
    });
    var sections = publishedSectionsOf(scoreConfig);
    var progress = judges.map(function (judge) {
      var sectionProgress = sections.map(function (section) {
        var rows = clubs.map(function (club) {
          var row = byKey[judge.id + "::" + club.id + "::" + section.id];
          var answers = (row && row.answers_json) || {};
          var reopened = !!(answers && answers.reopened);
          return {
            permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
            clubName: club.name,
            status: !row
              ? "notStarted"
              : reopened
                ? "reopened"
                : row.status === "submitted"
                  ? "submitted"
                  : "draft",
            score: row ? Number(row.score) || 0 : null
          };
        });
        return {
          sectionId: section.id,
          sectionName: section.name,
          clubs: rows
        };
      });
      return { judge: judge, sections: sectionProgress };
    });
    return ok({ progress: progress, judges: judges });
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

  async function adminAddJudge(data) {
    var email = String(data.email || data.username || "")
      .trim()
      .toLowerCase();
    if (email && email.indexOf("@") < 0) email = email + "@hksp.local";
    var password = String(data.password || "");
    var name = String(data.displayName || data.name || "").trim() || email;
    if (!email || !password) return fail("請填寫評審 Email 與密碼。");
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
      return fail((e && e.message) || "新增評審失敗。");
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
        eligibility: "all_completed",
        incompletePolicy: "show_unranked",
        tieMode: "shared",
        rankStyle: "competition",
        unresolvedTie: "shared",
        tieBreakers: []
      }
    };
  }

  function rankingConfigOf(activity) {
    var conf = (activity && activity.config_json) || {};
    var base = defaultRankingConfig();
    var saved = conf.rankingConfig && typeof conf.rankingConfig === "object" ? conf.rankingConfig : {};
    return {
      pass: Object.assign({}, base.pass, saved.pass || {}),
      ranking: Object.assign({}, base.ranking, saved.ranking || {}, {
        tieBreakers: Array.isArray((saved.ranking || {}).tieBreakers)
          ? saved.ranking.tieBreakers
          : []
      })
    };
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
    var sections = Array.isArray(judge.scoreSectionIds) ? judge.scoreSectionIds : [];
    if (sections.length && sections.indexOf(sectionId) < 0) return false;
    var cats = Array.isArray(judge.categories) ? judge.categories : [];
    if (!cats.length) return true;
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
      byKey[row.judge + "::" + row.club + "::" + row.section_id] = row;
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

      sections.forEach(function (section) {
        var assigned = ctx.judges.filter(function (j) {
          return judgeCoversClub(j, club, section.id);
        });
        if (!assigned.length) missing += 1;
        var bucket = scoreBucket(section.maxScore);
        bucket.assignedCount = assigned.length;
        var values = [];
        var judgeRows = assigned.map(function (judge) {
          var row = ctx.byKey[judge.id + "::" + club.id + "::" + section.id];
          var answers = (row && row.answers_json) || {};
          var reopened = !!(answers && answers.reopened);
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
        } else {
          allComplete = false;
        }
        if (bucket.reopenedCount > 0) reopenedSectionCount += 1;
        sectionScores[section.id] = bucket;
        // 舊 UI 欄位相容：若大項／分類 id 剛好對上就一併填
        if (section.id === "dataReview" || section.id === "fieldReview") {
          sectionScores[section.id] = bucket;
        }
        (section.groups || []).forEach(function (g) {
          if (g && g.id === "routinePerformance") {
            groupScores.routinePerformance = Object.assign({}, bucket, {
              maxScore: Number(g.maxScore) || bucket.maxScore
            });
          }
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

      return {
        clubId: club.id,
        permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
        clubName: club.name,
        category: club.category || "",
        complete: allComplete && missing === 0,
        missingJudgeAssignments: missing,
        reopenedSectionCount: reopenedSectionCount,
        finalTotalScore: allComplete && missing === 0 ? finalTotal : null,
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
    var totalDiff = (Number(b.finalTotalScore) || 0) - (Number(a.finalTotalScore) || 0);
    if (totalDiff) return totalDiff;
    var mode = (rankingConfig.ranking && rankingConfig.ranking.tieMode) || "shared";
    if (mode !== "rules") return 0;
    var breakers = (rankingConfig.ranking && rankingConfig.ranking.tieBreakers) || [];
    for (var i = 0; i < breakers.length; i++) {
      var rule = breakers[i] || {};
      var av = metricValue(clubMap[a.clubName] || {}, rule.sourceType, rule.sourceId);
      var bv = metricValue(clubMap[b.clubName] || {}, rule.sourceType, rule.sourceId);
      var an = av === null || av === undefined ? -Infinity : Number(av);
      var bn = bv === null || bv === undefined ? -Infinity : Number(bv);
      var diff = rule.direction === "asc" ? an - bn : bn - an;
      if (diff) return diff;
    }
    return 0;
  }

  function buildRankingPayload(ctx, aggregation) {
    var rankingConfig = ctx.rankingConfig;
    var clubMap = {};
    aggregation.clubs.forEach(function (c) {
      clubMap[c.clubName] = c;
    });
    var byCategory = {};
    aggregation.clubs.forEach(function (club) {
      var cat = club.category || "未分類";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(club);
    });
    var categories = Object.keys(byCategory)
      .sort(function (a, b) {
        return a.localeCompare(b, "zh-Hant");
      })
      .map(function (category) {
        var rows = byCategory[category].map(function (club) {
          var complete = !!club.complete;
          var eligible =
            (rankingConfig.ranking && rankingConfig.ranking.eligibility) === "all_completed"
              ? complete
              : true;
          var passed = complete ? passesThreshold(club.finalTotalScore, rankingConfig.pass) : null;
          return {
            clubName: club.clubName,
            permanentClubId: club.permanentClubId,
            category: category,
            complete: complete,
            eligible: eligible,
            passed: passed,
            finalTotalScore: complete ? club.finalTotalScore : null,
            totalMaxScore: club.totalMaxScore,
            displayRank: null,
            rankStatus: !complete
              ? "incomplete"
              : !eligible
                ? "not_eligible"
                : "ranked"
          };
        });

        var rankable = rows.filter(function (r) {
          return r.complete && r.eligible;
        });
        rankable.sort(function (a, b) {
          return compareRankRows(a, b, rankingConfig, clubMap);
        });

        var style = (rankingConfig.ranking && rankingConfig.ranking.rankStyle) || "competition";
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
          for (var k = i; k < j; k++) {
            rankable[k].displayRank = String(rank);
            if (tied) {
              rankable[k].rankStatus = tieMode === "manual" ? "tie_pending" : "tied";
            } else {
              rankable[k].rankStatus = "ranked";
            }
          }
          i = j;
        }

        if ((rankingConfig.ranking && rankingConfig.ranking.incompletePolicy) === "hide") {
          rows = rows.filter(function (r) {
            return r.complete;
          });
        }

        return {
          category: category,
          totalClubCount: byCategory[category].length,
          rows: rows
        };
      });

    var summary = {
      clubCount: aggregation.clubs.length,
      completedCount: 0,
      passedCount: 0,
      failedCount: 0,
      incompleteCount: 0
    };
    aggregation.clubs.forEach(function (c) {
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
    var conf = Object.assign({}, activity.config_json || {});
    var next = data.config || data.rankingConfig || null;
    if (!next || typeof next !== "object") return fail("缺少排名規則。");
    conf.rankingConfig = {
      pass: Object.assign({}, defaultRankingConfig().pass, next.pass || {}),
      ranking: Object.assign({}, defaultRankingConfig().ranking, next.ranking || {}, {
        tieBreakers: Array.isArray((next.ranking || {}).tieBreakers)
          ? next.ranking.tieBreakers
          : []
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
    var lines = ["屬性,名次,社團,永久社團編號,總分,滿分,完成,及格,狀態"];
    (ranking.categories || []).forEach(function (cat) {
      (cat.rows || []).forEach(function (row) {
        lines.push(
          [
            cat.category,
            row.displayRank || "",
            row.clubName,
            row.permanentClubId || "",
            row.finalTotalScore === null || row.finalTotalScore === undefined
              ? ""
              : row.finalTotalScore,
            row.totalMaxScore,
            row.complete ? "Y" : "N",
            row.passed === true ? "及格" : row.passed === false ? "不及格" : "",
            row.rankStatus || ""
          ]
            .map(csvEscape)
            .join(",")
        );
      });
    });
    return "\uFEFF" + lines.join("\r\n");
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

  async function adminCategoryRankingExcelExport() {
    var ctx = await loadAggregationContext();
    var aggregation = buildClubAggregation(ctx);
    var ranking = buildRankingPayload(ctx, aggregation);
    var csv = buildCategoryRankingCsv(ranking);
    var stamp = new Date().toISOString().slice(0, 10);
    return ok({
      base64: toBase64Utf8(csv),
      mimeType: "text/csv;charset=utf-8",
      fileName: "hksp-category-ranking-" + stamp + ".csv",
      generatedAt: ranking.generatedAt,
      summary: {
        categoryCount: (ranking.categories || []).length,
        rowCount: aggregation.clubs.length
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
    adminBrowseClubUploads: adminBrowseClubUploads,
    adminAddClub: adminAddClub,
    adminUpdateClub: adminUpdateClub,
    adminDeleteClub: adminDeleteClub,
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
    adminJudgeScoreProgress: adminJudgeScoreProgress,
    adminScoreAggregationSummary: adminScoreAggregationSummary,
    adminScoreAggregation: adminScoreAggregation,
    adminRanking: adminRanking,
    adminSaveRankingConfig: adminSaveRankingConfig,
    adminCategoryRankingExcelExport: adminCategoryRankingExcelExport,
    adminOrganizerAuditExcelExport: adminOrganizerAuditExcelExport
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
          "#clubList,#clubStudentList,#clubUploadList,#clubUploadBrowser,#eventMeta,#cloudUploadMeta,#uploadGateStatus,#judgeList,#sectionsEditor,#progressMeta,#judgeProgressList,#aggregationMeta,#rankingMeta,#categoryRankingExcelMeta,#organizerAuditExcelMeta"
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
    var title = document.querySelector(".hero h1");
    if (title) title.textContent = "PocketBase 管理中心";
    var subtitle = document.querySelector(".hero .sub");
    if (subtitle) {
      subtitle.textContent =
        "社團、上傳資料瀏覽、評審、時程、成績彙整／排名與 CSV 匯出（Drive 代傳已擱置）";
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
