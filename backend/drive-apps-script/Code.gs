/**
 * HKSP Drive Proxy on Apps Script (always on, runs as holder account).
 *
 * Deploy:
 * 1. https://script.google.com → New project
 * 2. Paste this file + appsscript.json
 * 3. Project Settings → Script properties:
 *      PB_URL = https://db.keson.pro
 *      DRIVE_ROOT_FOLDER_ID = 16G4v0Xrc7t0PjjOuor-68BokJXBGl6Jg
 * 4. Deploy → New deployment → Web app
 *      Execute as: Me
 *      Who has access: Anyone
 * 5. Copy the Web App URL into pb-config.js driveProxyUrl
 */

var PROP = PropertiesService.getScriptProperties();

function jsonOutput_(obj, code) {
  var out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}

function pbUrl_() {
  return String(PROP.getProperty("PB_URL") || "https://db.keson.pro").replace(/\/$/, "");
}

function rootId_() {
  return String(
    PROP.getProperty("DRIVE_ROOT_FOLDER_ID") ||
      "16G4v0Xrc7t0PjjOuor-68BokJXBGl6Jg"
  );
}

function pbFetch_(path, opt) {
  opt = opt || {};
  var headers = {};
  if (opt.token) headers.Authorization = opt.token;
  var params = {
    method: opt.method || "get",
    headers: headers,
    muteHttpExceptions: true,
    followRedirects: true
  };
  if (opt.body != null) {
    headers["Content-Type"] = "application/json";
    params.payload = JSON.stringify(opt.body);
  }
  var res = UrlFetchApp.fetch(pbUrl_() + path, params);
  var text = res.getContentText();
  var data = {};
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = { raw: text };
  }
  if (res.getResponseCode() >= 300) {
    throw new Error(data.message || text || ("PB HTTP " + res.getResponseCode()));
  }
  return data;
}

function authStudent_(token) {
  token = String(token || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new Error("缺少學生登入憑證。");
  var data = pbFetch_("/api/collections/hksp_students/auth-refresh", {
    method: "post",
    token: token
  });
  return { token: token, record: data.record };
}

function studentContext_(token, studentId) {
  var memberships = pbFetch_(
    "/api/collections/hksp_memberships/records?filter=" +
      encodeURIComponent('student="' + studentId + '" && status="active"') +
      "&expand=club,activity&perPage=1&sort=-created",
    { token: token }
  );
  var mem = memberships.items && memberships.items[0];
  if (!mem) throw new Error("尚無社團綁定。");
  var club = (mem.expand && mem.expand.club) || pbFetch_("/api/collections/hksp_clubs/records/" + mem.club, { token: token });
  var activity =
    (mem.expand && mem.expand.activity) ||
    pbFetch_("/api/collections/hksp_activities/records/" + mem.activity, { token: token });
  return { mem: mem, club: club, activity: activity };
}

function ensureChildFolder_(parentId, name) {
  var parent = DriveApp.getFolderById(parentId);
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

function ensureClubFolder_(club, activity) {
  var root = rootId_();
  if (!root) throw new Error("未設定 DRIVE_ROOT_FOLDER_ID。");
  var activityName = activity.activity_id || activity.id || "activity";
  var activityFolder = ensureChildFolder_(root, activityName);
  var clubName =
    String(club.permanent_club_id || club.id) +
    "_" +
    String(club.name || "club").replace(/[\\/]/g, "-");
  return ensureChildFolder_(activityFolder.getId(), clubName);
}

function parseBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  var type = String((e.postData && e.postData.type) || "");
  if (type.indexOf("application/json") >= 0) {
    return JSON.parse(e.postData.contents);
  }
  // form-urlencoded fallback
  var out = {};
  if (e.parameter) {
    Object.keys(e.parameter).forEach(function (k) {
      out[k] = e.parameter[k];
    });
  }
  return out;
}

function getToken_(e, body) {
  var h = (e && e.parameter && e.parameter.authorization) || "";
  if (!h && body && body.authorization) h = body.authorization;
  if (!h && body && body.pbToken) h = body.pbToken;
  // Apps Script cannot reliably receive Authorization header from browsers; prefer body.pbToken
  return h;
}

function doGet(e) {
  var path = (e && e.parameter && e.parameter.path) || "health";
  if (path === "health") {
    var root = rootId_();
    var ok = false;
    var childCount = null;
    var err = null;
    try {
      if (root) {
        var folder = DriveApp.getFolderById(root);
        var n = 0;
        var it = folder.getFolders();
        while (it.hasNext() && n < 20) {
          it.next();
          n++;
        }
        childCount = n;
        ok = true;
      }
    } catch (ex) {
      err = String(ex.message || ex);
    }
    return jsonOutput_({
      ok: true,
      service: "hksp-drive-apps-script",
      driveEnabled: true,
      rootFolderId: root || null,
      driveReachable: ok,
      rootChildCountSample: childCount,
      error: err,
      holder: Session.getEffectiveUser().getEmail()
    });
  }
  return jsonOutput_({ success: false, code: "NOT_FOUND", message: "unknown path" });
}

function doPost(e) {
  try {
    var path = (e && e.parameter && e.parameter.path) || "";
    var body = parseBody_(e);
    if (!path && body.path) path = body.path;

    if (path === "v1/prepare") return handlePrepare_(e, body);
    if (path === "v1/upload-bytes") return handleUpload_(e, body);
    if (path === "v1/complete") return handleComplete_(e, body);
    if (path === "v1/ensure-club-folder") return handleEnsure_(e, body);

    return jsonOutput_({ success: false, code: "NOT_FOUND", message: "unknown path: " + path });
  } catch (err) {
    return jsonOutput_({
      success: false,
      code: "PROXY_ERROR",
      message: String(err.message || err)
    });
  }
}

function handlePrepare_(e, body) {
  var auth = authStudent_(getToken_(e, body));
  var ctx = studentContext_(auth.token, auth.record.id);
  var clubFolder = ensureClubFolder_(ctx.club, ctx.activity);
  var attempt = String(body.clientAttemptId || ("attempt-" + Date.now()));
  var kind = body.uploadKind === "feature" ? "feature" : "evaluation";
  var fileName = String(body.fileName || "upload.bin");
  var mimeType = String(body.mimeType || "application/octet-stream");
  var size = Number(body.size || 0);

  var row = pbFetch_("/api/collections/hksp_uploads/records", {
    method: "post",
    token: auth.token,
    body: {
      activity: ctx.activity.id,
      club: ctx.club.id,
      student: auth.record.id,
      folder: body.destinationFolderId || "",
      client_attempt_id: attempt,
      upload_kind: kind,
      original_name: fileName,
      mime_type: mimeType,
      size_bytes: size,
      status: "prepared",
      meta_json: {
        driveParentId: clubFolder.getId(),
        via: "drive-apps-script"
      }
    }
  });

  // stash attempt meta briefly in CacheService (student scoped)
  CacheService.getScriptCache().put(
    "attempt:" + attempt,
    JSON.stringify({
      uploadId: row.id,
      studentId: auth.record.id,
      driveParentId: clubFolder.getId(),
      fileName: fileName,
      mimeType: mimeType
    }),
    3600
  );

  return jsonOutput_({
    success: true,
    data: {
      status: "ready",
      proxyUpload: true,
      pbDirectUpload: false,
      clientAttemptId: attempt,
      fileName: fileName,
      driveParentId: clubFolder.getId(),
      permanentClubId: ctx.club.permanent_club_id,
      clubName: ctx.club.name,
      activityId: ctx.activity.activity_id
    }
  });
}

function handleUpload_(e, body) {
  var auth = authStudent_(getToken_(e, body));
  var attempt = String(body.clientAttemptId || body.attempt || "");
  if (!attempt) throw new Error("缺少 clientAttemptId。");

  var cached = CacheService.getScriptCache().get("attempt:" + attempt);
  var meta = cached ? JSON.parse(cached) : null;
  if (!meta) {
    var listed = pbFetch_(
      "/api/collections/hksp_uploads/records?filter=" +
        encodeURIComponent('client_attempt_id="' + attempt + '"') +
        "&perPage=1",
      { token: auth.token }
    );
    var row0 = listed.items && listed.items[0];
    if (!row0) throw new Error("找不到上傳工作階段，請重新 prepare。");
    meta = {
      uploadId: row0.id,
      studentId: auth.record.id,
      driveParentId: row0.meta_json && row0.meta_json.driveParentId,
      fileName: row0.original_name,
      mimeType: row0.mime_type
    };
  }
  if (meta.studentId !== auth.record.id) throw new Error("不可使用他人的上傳工作階段。");
  if (!meta.driveParentId) throw new Error("缺少 Drive 目的資料夾。");

  var b64 = body.fileBase64 || body.contentBase64;
  if (!b64) throw new Error("缺少 fileBase64（Apps Script 路徑請用 Base64）。");
  var bytes = Utilities.base64Decode(b64);
  var blob = Utilities.newBlob(
    bytes,
    body.mimeType || meta.mimeType || "application/octet-stream",
    body.fileName || meta.fileName || "upload.bin"
  );
  var folder = DriveApp.getFolderById(meta.driveParentId);
  var file = folder.createFile(blob);

  var patched = pbFetch_("/api/collections/hksp_uploads/records/" + meta.uploadId, {
    method: "patch",
    token: auth.token,
    body: {
      status: "completed",
      drive_file_id: file.getId(),
      drive_web_view_link: file.getUrl(),
      original_name: file.getName(),
      mime_type: file.getMimeType(),
      size_bytes: bytes.length,
      completed_at: new Date().toISOString()
    }
  });

  return jsonOutput_({
    success: true,
    data: {
      status: "completed",
      clientAttemptId: attempt,
      driveFileId: file.getId(),
      webViewLink: file.getUrl(),
      upload: patched
    }
  });
}

function handleComplete_(e, body) {
  var auth = authStudent_(getToken_(e, body));
  var attempt = String(body.clientAttemptId || "");
  var listed = pbFetch_(
    "/api/collections/hksp_uploads/records?filter=" +
      encodeURIComponent('client_attempt_id="' + attempt + '"') +
      "&perPage=1",
    { token: auth.token }
  );
  var row = listed.items && listed.items[0];
  if (!row) throw new Error("找不到上傳紀錄。");
  if (row.status !== "completed" || !row.drive_file_id) {
    throw new Error("檔案尚未完成 Drive 上傳。");
  }
  return jsonOutput_({
    success: true,
    data: {
      alreadyComplete: true,
      status: "completed",
      driveFileId: row.drive_file_id,
      webViewLink: row.drive_web_view_link || "",
      files: [
        {
          id: row.id,
          name: row.original_name,
          driveFileId: row.drive_file_id,
          webViewLink: row.drive_web_view_link || "",
          status: row.status,
          uploadKind: row.upload_kind
        }
      ]
    }
  });
}

function handleEnsure_(e, body) {
  var auth = authStudent_(getToken_(e, body));
  var ctx = studentContext_(auth.token, auth.record.id);
  var folder = ensureClubFolder_(ctx.club, ctx.activity);
  return jsonOutput_({
    success: true,
    data: {
      clubFolderId: folder.getId(),
      permanentClubId: ctx.club.permanent_club_id,
      clubName: ctx.club.name
    }
  });
}
