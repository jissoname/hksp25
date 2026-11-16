/**
 * Google OAuth + Drive helpers (holder account).
 */
import { httpError } from "./errors.js";

let cached = { accessToken: "", expiresAt: 0 };

export async function getAccessToken() {
  const now = Date.now();
  if (cached.accessToken && cached.expiresAt > now + 60_000) {
    return cached.accessToken;
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw httpError(500, "GOOGLE_ENV_MISSING", "缺少 Google OAuth 環境變數。");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw httpError(
      502,
      "GOOGLE_TOKEN_FAILED",
      data.error_description || data.error || "無法刷新 Google access token。"
    );
  }
  cached = {
    accessToken: data.access_token,
    expiresAt: now + Number(data.expires_in || 3600) * 1000
  };
  return cached.accessToken;
}

export async function getTokenEmail(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: "Bearer " + accessToken }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return "";
  return String(data.email || "");
}

async function driveFetch(accessToken, path, init = {}) {
  const headers = Object.assign(
    { Authorization: "Bearer " + accessToken },
    init.headers || {}
  );
  const res = await fetch("https://www.googleapis.com/drive/v3" + path, {
    ...init,
    headers
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (data.error && data.error.message) || text || "Drive HTTP " + res.status;
    throw httpError(502, "DRIVE_API_ERROR", msg, data);
  }
  return data;
}

export async function ensureChildFolder(accessToken, parentId, name) {
  const safeName = String(name || "untitled").replace(/'/g, "\\'");
  const q =
    "mimeType='application/vnd.google-apps.folder' and name='" +
    safeName +
    "' and '" +
    parentId +
    "' in parents and trashed=false";
  const found = await driveFetch(
    accessToken,
    "/files?q=" +
      encodeURIComponent(q) +
      "&fields=files(id,name)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true"
  );
  if (found.files && found.files[0]) return found.files[0];

  return driveFetch(
    accessToken,
    "/files?fields=id,name,webViewLink&supportsAllDrives=true",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: String(name || "untitled"),
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId]
      })
    }
  );
}

export async function uploadFileMultipart(accessToken, opts) {
  const parentId = opts.parentId;
  const fileName = opts.fileName;
  const mimeType = opts.mimeType;
  const buffer = opts.buffer;
  const metadata = {
    name: fileName,
    parents: [parentId]
  };
  const boundary = "hksp_" + Date.now().toString(16);
  const metaPart =
    "--" +
    boundary +
    "\r\n" +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify(metadata) +
    "\r\n";
  const fileHeader =
    "--" +
    boundary +
    "\r\n" +
    "Content-Type: " +
    (mimeType || "application/octet-stream") +
    "\r\n\r\n";
  const end = "\r\n--" + boundary + "--";

  const metaBuf = Buffer.from(metaPart, "utf8");
  const headBuf = Buffer.from(fileHeader, "utf8");
  const endBuf = Buffer.from(end, "utf8");
  const body = Buffer.concat([metaBuf, headBuf, buffer, endBuf]);

  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,size,mimeType&supportsAllDrives=true",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "multipart/related; boundary=" + boundary,
        "Content-Length": String(body.length)
      },
      body
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw httpError(
      502,
      "DRIVE_UPLOAD_FAILED",
      (data.error && data.error.message) || "Drive 上傳失敗。"
    );
  }
  return data;
}

export async function listChildren(accessToken, parentId, pageSize = 20) {
  const q = "'" + parentId + "' in parents and trashed=false";
  return driveFetch(
    accessToken,
    "/files?q=" +
      encodeURIComponent(q) +
      "&fields=files(id,name,mimeType,modifiedTime)&pageSize=" +
      pageSize +
      "&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=modifiedTime desc"
  );
}
