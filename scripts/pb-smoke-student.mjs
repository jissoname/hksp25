/**
 * Smoke-test PocketBase student MVP against live API (no browser).
 */
const BASE = "https://db.keson.pro";
const ACTIVITY_ID = "115-1-club-evaluation";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function api(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = token;
  let body;
  if (form) {
    body = form;
  } else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, { method, headers, body });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${path} => ${res.status} ${text}`);
  return data;
}

const sid = "S" + Math.floor(100000 + Math.random() * 899999);
const email = sid.toLowerCase() + "@stu.hksp25.invalid";
const birth = "20010115";
const newPass = "NewPass123!";
console.log("student", sid);

const clubs = await api("GET", "/api/collections/hksp_clubs/records?perPage=20");
assert(clubs.totalItems > 0, "no clubs");
const club = clubs.items[0];
console.log("club", club.name);

const acts = await api(
  "GET",
  `/api/collections/hksp_activities/records?filter=${encodeURIComponent(`activity_id="${ACTIVITY_ID}"`)}`
);
const activity = acts.items[0];
assert(activity, "no activity");

const student = await api("POST", "/api/collections/hksp_students/records", {
  json: {
    email,
    emailVisibility: false,
    password: birth,
    passwordConfirm: birth,
    student_id: sid,
    birth_ymd: birth,
    name: sid,
    must_change_password: true,
    active: true
  }
});

const auth = await api("POST", "/api/collections/hksp_students/auth-with-password", {
  json: { identity: email, password: birth }
});
const token = auth.token;

await api("POST", "/api/collections/hksp_memberships/records", {
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

const folder = await api("POST", "/api/collections/hksp_folders/records", {
  token,
  json: {
    activity: activity.id,
    club: club.id,
    name: club.name,
    kind: "evaluation",
    trashed: false,
    created_by_student: student.id
  }
});

const form = new FormData();
form.append("activity", activity.id);
form.append("club", club.id);
form.append("folder", folder.id);
form.append("student", student.id);
form.append("client_attempt_id", "smoke-" + crypto.randomUUID());
form.append("upload_kind", "evaluation");
form.append("original_name", "smoke.pdf");
form.append("mime_type", "application/pdf");
form.append("size_bytes", "12");
form.append("status", "completed");
form.append("completed_at", new Date().toISOString());
form.append("file", new Blob(["%PDF-1.4 x"], { type: "application/pdf" }), "smoke.pdf");
const upload = await api("POST", "/api/collections/hksp_uploads/records", { token, form });
assert(upload.file, "upload missing file");

await api("PATCH", `/api/collections/hksp_students/records/${student.id}`, {
  token,
  json: {
    oldPassword: birth,
    password: newPass,
    passwordConfirm: newPass,
    must_change_password: false
  }
});

const auth2 = await api("POST", "/api/collections/hksp_students/auth-with-password", {
  json: { identity: email, password: newPass }
});
assert(auth2.token, "relogin failed");

// public endpoints used by homepage
const publicClubs = await api("GET", "/api/collections/hksp_clubs/records?perPage=5");
assert(publicClubs.totalItems > 0, "public clubs failed");

console.log("SMOKE_OK", {
  student: student.id,
  upload: upload.id,
  folder: folder.id,
  clubs: publicClubs.totalItems
});
