/**
 * HKSP Drive Proxy — holder-account uploads into test/root Drive folder.
 * Students auth with PocketBase token; Google token never leaves this service.
 */
import http from "node:http";
import { URL } from "node:url";
import { loadEnvFile } from "./env.js";
import { httpError } from "./errors.js";
import * as google from "./google.js";
import * as pb from "./pb.js";

loadEnvFile();

const PORT = Number(process.env.PORT || 28223);
const HOST = process.env.HOST || "0.0.0.0";
const DRIVE_ENABLED = String(process.env.DRIVE_ENABLED || "false") === "true";
const ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || "";
const HOLDER = process.env.GOOGLE_HOLDER_EMAIL || "";
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(
  /\/$/,
  ""
);

/** @type {Map<string, any>} */
const attempts = new Map();

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(raw);
}

async function readRaw(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readRaw(req);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8"));
}

function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ""));
  if (!m) throw httpError(400, "BAD_MULTIPART", "缺少 multipart boundary。");
  const boundary = m[1] || m[2];
  const parts = [];
  const sep = Buffer.from("--" + boundary);
  let start = buffer.indexOf(sep) + sep.length;
  while (start < buffer.length) {
    if (buffer[start] === 45 && buffer[start + 1] === 45) break; // --
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const next = buffer.indexOf(sep, start);
    if (next < 0) break;
    let part = buffer.subarray(start, next - 2); // strip \r\n
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const header = part.subarray(0, headerEnd).toString("utf8");
      const body = part.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]+)"/i.exec(header);
      const fileMatch = /filename="([^"]*)"/i.exec(header);
      const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(header);
      parts.push({
        name: nameMatch ? nameMatch[1] : "",
        filename: fileMatch ? fileMatch[1] : "",
        contentType: typeMatch ? typeMatch[1].trim() : "",
        body
      });
    }
    start = next + sep.length;
  }
  return parts;
}

async function ensureDriveClubFolder(accessToken, club, activity) {
  if (!ROOT_FOLDER_ID) throw httpError(500, "NO_ROOT", "未設定 DRIVE_ROOT_FOLDER_ID。");
  const activityFolder = await google.ensureChildFolder(
    accessToken,
    ROOT_FOLDER_ID,
    activity.activity_id || activity.id || "activity"
  );
  const clubFolderName =
    String(club.permanent_club_id || club.id) +
    "_" +
    String(club.name || "club").replace(/[\\/]/g, "-");
  const clubFolder = await google.ensureChildFolder(
    accessToken,
    activityFolder.id,
    clubFolderName
  );

  // best-effort write-back with service credentials
  try {
    const svc = await pb.authService();
    if (!club.drive_folder_id || club.drive_folder_id !== clubFolder.id) {
      await pb.pbFetch(`/api/collections/hksp_clubs/records/${club.id}`, {
        method: "PATCH",
        token: svc,
        body: { drive_folder_id: clubFolder.id }
      });
    }
    if (!activity.drive_root_folder_id) {
      await pb.pbFetch(`/api/collections/hksp_activities/records/${activity.id}`, {
        method: "PATCH",
        token: svc,
        body: { drive_root_folder_id: ROOT_FOLDER_ID }
      });
    }
  } catch (_e) {
    // non-fatal for upload path
  }
  return { activityFolder, clubFolder };
}

async function handleHealth(_req, res) {
  let tokenEmail = "";
  let driveOk = false;
  let listCount = null;
  let errMsg = "";
  if (DRIVE_ENABLED && process.env.GOOGLE_REFRESH_TOKEN) {
    try {
      const access = await google.getAccessToken();
      tokenEmail = await google.getTokenEmail(access);
      if (ROOT_FOLDER_ID) {
        const listed = await google.listChildren(access, ROOT_FOLDER_ID, 5);
        listCount = (listed.files || []).length;
        driveOk = true;
      }
    } catch (e) {
      errMsg = e.message || e.code || "token/drive check failed";
    }
  }
  json(res, 200, {
    ok: true,
    service: "hksp-drive-proxy",
    driveEnabled: DRIVE_ENABLED,
    rootFolderId: ROOT_FOLDER_ID || null,
    holderEmailConfigured: HOLDER || null,
    tokenEmail: tokenEmail || null,
    driveReachable: driveOk,
    rootChildCountSample: listCount,
    error: errMsg || null,
    pbUrl: process.env.PB_URL || null
  });
}

async function handlePrepare(req, res) {
  if (!DRIVE_ENABLED) throw httpError(503, "DRIVE_NOT_ENABLED", "Drive 代傳未啟用。");
  const auth = await pb.authStudent(req.headers.authorization);
  const body = await readJson(req);
  const ctx = await pb.getStudentContext(auth.token, auth.record.id);
  const access = await google.getAccessToken();
  const folders = await ensureDriveClubFolder(access, ctx.club, ctx.activity);
  const attempt = String(body.clientAttemptId || ("attempt-" + Date.now()));
  const kind = body.uploadKind === "feature" ? "feature" : "evaluation";
  const fileName = String(body.fileName || "upload.bin");
  const mimeType = String(body.mimeType || "application/octet-stream");
  const size = Number(body.size || 0);

  // create PB upload row (prepared)
  const row = await pb.pbFetch("/api/collections/hksp_uploads/records", {
    method: "POST",
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
        driveParentId: folders.clubFolder.id,
        via: "drive-proxy"
      }
    }
  });

  attempts.set(attempt, {
    uploadId: row.id,
    studentId: auth.record.id,
    studentToken: auth.token,
    driveParentId: folders.clubFolder.id,
    fileName,
    mimeType,
    kind,
    clubId: ctx.club.id,
    activityId: ctx.activity.id
  });

  json(res, 200, {
    success: true,
    data: {
      status: "ready",
      pbDirectUpload: false,
      proxyUpload: true,
      clientAttemptId: attempt,
      fileName,
      uploadUrl: `${PUBLIC_BASE_URL}/v1/upload-bytes?attempt=${encodeURIComponent(attempt)}`,
      driveParentId: folders.clubFolder.id,
      permanentClubId: ctx.club.permanent_club_id,
      clubName: ctx.club.name,
      activityId: ctx.activity.activity_id
    }
  });
}

async function handleUploadBytes(req, res) {
  if (!DRIVE_ENABLED) throw httpError(503, "DRIVE_NOT_ENABLED", "Drive 代傳未啟用。");
  const auth = await pb.authStudent(req.headers.authorization);
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  let attempt = url.searchParams.get("attempt") || "";
  const contentType = String(req.headers["content-type"] || "");
  const raw = await readRaw(req);

  let fileBuf = raw;
  let fileName = "";
  let mimeType = "";

  if (/multipart\/form-data/i.test(contentType)) {
    const parts = parseMultipart(raw, contentType);
    const filePart = parts.find((p) => p.filename) || parts.find((p) => p.name === "file");
    const attemptPart = parts.find((p) => p.name === "clientAttemptId" || p.name === "attempt");
    if (attemptPart) attempt = attemptPart.body.toString("utf8");
    if (!filePart) throw httpError(400, "NO_FILE", "缺少檔案。");
    fileBuf = filePart.body;
    fileName = filePart.filename || "upload.bin";
    mimeType = filePart.contentType || "application/octet-stream";
  } else {
    fileName = decodeURIComponent(String(req.headers["x-file-name"] || "upload.bin"));
    mimeType = contentType || "application/octet-stream";
  }

  if (!attempt) throw httpError(400, "NO_ATTEMPT", "缺少 clientAttemptId。");
  let meta = attempts.get(attempt);
  if (!meta) {
    // recover from PB row
    const listed = await pb.pbFetch(
      `/api/collections/hksp_uploads/records?filter=${encodeURIComponent(`client_attempt_id="${attempt}"`)}&perPage=1`,
      { token: auth.token }
    );
    const row = listed.items && listed.items[0];
    if (!row) throw httpError(404, "ATTEMPT_NOT_FOUND", "找不到上傳工作階段，請重新 prepare。");
    const parentId = row.meta_json && row.meta_json.driveParentId;
    if (!parentId) throw httpError(409, "NO_DRIVE_PARENT", "上傳紀錄缺少 Drive 目的資料夾。");
    meta = {
      uploadId: row.id,
      studentId: auth.record.id,
      studentToken: auth.token,
      driveParentId: parentId,
      fileName: row.original_name || fileName,
      mimeType: row.mime_type || mimeType,
      kind: row.upload_kind || "evaluation"
    };
    attempts.set(attempt, meta);
  }
  if (meta.studentId !== auth.record.id) {
    throw httpError(403, "FORBIDDEN", "不可使用他人的上傳工作階段。");
  }

  const access = await google.getAccessToken();
  const uploaded = await google.uploadFileMultipart(access, {
    parentId: meta.driveParentId,
    fileName: fileName || meta.fileName,
    mimeType: mimeType || meta.mimeType,
    buffer: fileBuf
  });

  const patched = await pb.pbFetch(`/api/collections/hksp_uploads/records/${meta.uploadId}`, {
    method: "PATCH",
    token: auth.token,
    body: {
      status: "completed",
      drive_file_id: uploaded.id,
      drive_web_view_link: uploaded.webViewLink || "",
      original_name: uploaded.name || fileName || meta.fileName,
      mime_type: uploaded.mimeType || mimeType || meta.mimeType,
      size_bytes: Number(uploaded.size || fileBuf.length),
      completed_at: new Date().toISOString()
    }
  });

  meta.done = true;
  meta.driveFileId = uploaded.id;
  attempts.set(attempt, meta);

  json(res, 200, {
    success: true,
    data: {
      status: "completed",
      clientAttemptId: attempt,
      driveFileId: uploaded.id,
      webViewLink: uploaded.webViewLink || "",
      upload: patched
    }
  });
}

async function handleComplete(req, res) {
  if (!DRIVE_ENABLED) throw httpError(503, "DRIVE_NOT_ENABLED", "Drive 代傳未啟用。");
  const auth = await pb.authStudent(req.headers.authorization);
  const body = await readJson(req);
  const attempt = String(body.clientAttemptId || "");
  if (!attempt) throw httpError(400, "NO_ATTEMPT", "缺少 clientAttemptId。");
  const listed = await pb.pbFetch(
    `/api/collections/hksp_uploads/records?filter=${encodeURIComponent(`client_attempt_id="${attempt}"`)}&perPage=1`,
    { token: auth.token }
  );
  const row = listed.items && listed.items[0];
  if (!row) throw httpError(404, "NOT_FOUND", "找不到上傳紀錄。");
  if (row.status !== "completed" || !row.drive_file_id) {
    throw httpError(409, "UPLOAD_INCOMPLETE", "檔案尚未完成 Drive 上傳。");
  }
  json(res, 200, {
    success: true,
    data: {
      alreadyComplete: true,
      status: "completed",
      driveFileId: row.drive_file_id,
      webViewLink: row.drive_web_view_link || "",
      files: [
        {
          id: row.id,
          fileId: row.id,
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

async function handleEnsureClubFolder(req, res) {
  if (!DRIVE_ENABLED) throw httpError(503, "DRIVE_NOT_ENABLED", "Drive 代傳未啟用。");
  const auth = await pb.authStudent(req.headers.authorization);
  await readJson(req);
  const ctx = await pb.getStudentContext(auth.token, auth.record.id);
  const access = await google.getAccessToken();
  const folders = await ensureDriveClubFolder(access, ctx.club, ctx.activity);
  json(res, 200, {
    success: true,
    data: {
      activityFolderId: folders.activityFolder.id,
      clubFolderId: folders.clubFolder.id,
      permanentClubId: ctx.club.permanent_club_id,
      clubName: ctx.club.name
    }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") return handleHealth(req, res);
    if (req.method === "POST" && url.pathname === "/v1/prepare") return handlePrepare(req, res);
    if (req.method === "POST" && url.pathname === "/v1/upload-bytes") return handleUploadBytes(req, res);
    if (req.method === "POST" && url.pathname === "/v1/complete") return handleComplete(req, res);
    if (req.method === "POST" && url.pathname === "/v1/ensure-club-folder") {
      return handleEnsureClubFolder(req, res);
    }
    json(res, 404, { success: false, code: "NOT_FOUND", message: "unknown route" });
  } catch (error) {
    const status = error && error.status ? error.status : 500;
    json(res, status, {
      success: false,
      code: (error && error.code) || "PROXY_ERROR",
      message: (error && error.message) || "proxy error"
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `[hksp-drive-proxy] http://${HOST}:${PORT} public=${PUBLIC_BASE_URL} driveEnabled=${DRIVE_ENABLED} root=${ROOT_FOLDER_ID}`
  );
});
