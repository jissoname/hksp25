import { httpError } from "./errors.js";

const PB_URL = () => (process.env.PB_URL || "https://db.keson.pro").replace(/\/$/, "");

export async function pbFetch(path, opts = {}) {
  const method = opts.method || "GET";
  const token = opts.token;
  const body = opts.body;
  const form = opts.form;
  const headers = {};
  if (token) headers.Authorization = token;
  let payload = body;
  if (form) {
    payload = form;
  } else if (body != null && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(PB_URL() + path, { method, headers, body: payload });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw httpError(
      res.status,
      "PB_ERROR",
      data.message || text || "PocketBase HTTP " + res.status,
      data
    );
  }
  return data;
}

export async function authStudent(authHeader) {
  const token = String(authHeader || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw httpError(401, "UNAUTHENTICATED", "缺少學生登入憑證。");
  const data = await pbFetch("/api/collections/hksp_students/auth-refresh", {
    method: "POST",
    token
  });
  return { token, record: data.record };
}

let serviceToken = "";
let serviceExpires = 0;

export async function authService() {
  const now = Date.now();
  if (serviceToken && serviceExpires > now + 60_000) return serviceToken;
  const email = process.env.PB_SERVICE_EMAIL;
  const password = process.env.PB_SERVICE_PASSWORD;
  if (!email || !password) {
    throw httpError(500, "PB_SERVICE_MISSING", "缺少 PB_SERVICE_EMAIL / PASSWORD。");
  }
  let data;
  try {
    data = await pbFetch("/api/collections/_superusers/auth-with-password", {
      method: "POST",
      body: { identity: email, password }
    });
  } catch (_e) {
    data = await pbFetch("/api/collections/hksp_staff/auth-with-password", {
      method: "POST",
      body: { identity: email, password }
    });
  }
  serviceToken = data.token;
  serviceExpires = now + 5 * 60 * 1000;
  return serviceToken;
}

export async function getStudentContext(studentToken, studentId) {
  const memberships = await pbFetch(
    "/api/collections/hksp_memberships/records?filter=" +
      encodeURIComponent('student="' + studentId + '" && status="active"') +
      "&expand=club,activity&perPage=1&sort=-created",
    { token: studentToken }
  );
  const mem = memberships.items && memberships.items[0];
  if (!mem) throw httpError(403, "NO_MEMBERSHIP", "尚無社團綁定。");
  let club = mem.expand && mem.expand.club;
  let activity = mem.expand && mem.expand.activity;
  if (!club) {
    club = await pbFetch("/api/collections/hksp_clubs/records/" + mem.club, {
      token: studentToken
    });
  }
  if (!activity) {
    activity = await pbFetch("/api/collections/hksp_activities/records/" + mem.activity, {
      token: studentToken
    });
  }
  return { mem, club, activity };
}
