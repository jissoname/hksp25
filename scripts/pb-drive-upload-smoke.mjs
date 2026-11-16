/**
 * End-to-end: student auth -> drive-proxy prepare -> upload-bytes -> verify Drive file id
 */
const PB = "https://db.keson.pro";
const PROXY = process.env.DRIVE_PROXY_URL || "http://127.0.0.1:28223";

async function api(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = token.startsWith("Bearer") ? token : token;
  let body;
  if (form) body = form;
  else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url} => ${res.status} ${text}`);
  return data;
}

const sid = "D" + Math.floor(100000 + Math.random() * 899999);
const email = sid.toLowerCase() + "@stu.hksp25.invalid";
const birth = "20010115";
const password = "DriveTest123!";

console.log("student", sid);

const clubs = await api("GET", PB + "/api/collections/hksp_clubs/records?perPage=1");
const club = clubs.items[0];
const acts = await api(
  "GET",
  PB + "/api/collections/hksp_activities/records?filter=" + encodeURIComponent('activity_id="115-1-club-evaluation"')
);
const activity = acts.items[0];

const student = await api("POST", PB + "/api/collections/hksp_students/records", {
  json: {
    email,
    emailVisibility: false,
    password: birth,
    passwordConfirm: birth,
    student_id: sid,
    birth_ymd: birth,
    name: sid,
    must_change_password: false,
    active: true
  }
});
const auth = await api("POST", PB + "/api/collections/hksp_students/auth-with-password", {
  json: { identity: email, password: birth }
});
const token = auth.token;
await api("POST", PB + "/api/collections/hksp_memberships/records", {
  token,
  json: {
    activity: activity.id,
    club: club.id,
    student: student.id,
    role: "member",
    status: "active",
    can_upload: true,
    bound_at: new Date().toISOString()
  }
});

// change password optional - skip, must_change false already
await api("PATCH", PB + `/api/collections/hksp_students/records/${student.id}`, {
  token,
  json: {
    oldPassword: birth,
    password,
    passwordConfirm: password,
    must_change_password: false
  }
});
const auth2 = await api("POST", PB + "/api/collections/hksp_students/auth-with-password", {
  json: { identity: email, password }
});
const bearer = auth2.token;

const attempt = "drive-smoke-" + crypto.randomUUID();
const prepared = await api("POST", PROXY + "/v1/prepare", {
  token: bearer,
  json: {
    clientAttemptId: attempt,
    uploadKind: "evaluation",
    fileName: "drive-smoke.txt",
    mimeType: "text/plain",
    size: 22
  }
});
console.log("prepared", prepared.data && prepared.data.driveParentId);

const form = new FormData();
form.append("clientAttemptId", attempt);
form.append("file", new Blob(["hello from hksp drive smoke"], { type: "text/plain" }), "drive-smoke.txt");
const uploaded = await api("POST", PROXY + "/v1/upload-bytes?attempt=" + encodeURIComponent(attempt), {
  token: bearer,
  form
});
console.log("uploaded", uploaded.data);

const completed = await api("POST", PROXY + "/v1/complete", {
  token: bearer,
  json: { clientAttemptId: attempt }
});
console.log("completed", completed.data && completed.data.driveFileId);

if (!uploaded.data?.driveFileId) throw new Error("missing driveFileId");
console.log("SMOKE_DRIVE_OK", {
  driveFileId: uploaded.data.driveFileId,
  webViewLink: uploaded.data.webViewLink,
  parent: prepared.data?.driveParentId
});
