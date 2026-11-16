/**
 * Smoke: student -> Apps Script prepare/upload/complete -> Drive
 */
const PB = "https://db.keson.pro";
const GAS =
  "https://script.google.com/macros/s/AKfycby65eYQ-VR1SsocS8b6CMM-F0OEtqgaJ5kW5KvyLixVwlOipbWz-FhENAUhe7z081NFrQ/exec";

async function api(method, url, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = token;
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(url, { method, headers, body, redirect: "follow" });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok || data.success === false) {
    throw new Error(`${method} ${url} => ${res.status} ${text.slice(0, 500)}`);
  }
  return data;
}

async function gasPost(path, payload, pbToken) {
  return api("POST", GAS + "?path=" + encodeURIComponent(path), {
    json: Object.assign({}, payload, { path, pbToken })
  });
}

const sid = "G" + Math.floor(100000 + Math.random() * 899999);
const email = sid.toLowerCase() + "@stu.hksp25.invalid";
const birth = "20010115";
const password = "GasTest123!";

console.log("student", sid);
const clubs = await api("GET", PB + "/api/collections/hksp_clubs/records?perPage=1");
const club = clubs.items[0];
const acts = await api(
  "GET",
  PB +
    "/api/collections/hksp_activities/records?filter=" +
    encodeURIComponent('activity_id="115-1-club-evaluation"')
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
let auth = await api("POST", PB + "/api/collections/hksp_students/auth-with-password", {
  json: { identity: email, password: birth }
});
await api("POST", PB + "/api/collections/hksp_memberships/records", {
  token: auth.token,
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
await api("PATCH", PB + `/api/collections/hksp_students/records/${student.id}`, {
  token: auth.token,
  json: {
    oldPassword: birth,
    password,
    passwordConfirm: password,
    must_change_password: false
  }
});
auth = await api("POST", PB + "/api/collections/hksp_students/auth-with-password", {
  json: { identity: email, password }
});

const attempt = "gas-smoke-" + crypto.randomUUID();
const prepared = await gasPost(
  "v1/prepare",
  {
    clientAttemptId: attempt,
    uploadKind: "evaluation",
    fileName: "gas-smoke.txt",
    mimeType: "text/plain",
    size: 20
  },
  auth.token
);
console.log("prepared", prepared.data && prepared.data.driveParentId);

const content = "hello from apps script";
const b64 = Buffer.from(content, "utf8").toString("base64");
const uploaded = await gasPost(
  "v1/upload-bytes",
  {
    clientAttemptId: attempt,
    fileName: "gas-smoke.txt",
    mimeType: "text/plain",
    fileBase64: b64
  },
  auth.token
);
console.log("uploaded", uploaded.data && uploaded.data.driveFileId, uploaded.data && uploaded.data.webViewLink);

const completed = await gasPost("v1/complete", { clientAttemptId: attempt }, auth.token);
console.log("completed", completed.data && completed.data.driveFileId);
if (!uploaded.data?.driveFileId) throw new Error("missing driveFileId");
console.log("GAS_SMOKE_OK");
