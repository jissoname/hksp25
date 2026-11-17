/**
 * PocketBase student upload stress (live API).
 *
 * Ladder default: 10 → 30 → 66 concurrent workers.
 * Each worker: create student → bind membership → change password →
 * folder → upload small PDF → list confirm.
 *
 * Env:
 *   PB_URL                 (default https://db.keson.pro)
 *   PB_ACTIVITY_ID         (default 115-1-club-evaluation)
 *   STRESS_LEVELS          (default "10,30,66")
 *   STRESS_FILE_BYTES      (default 4096)
 *   STRESS_CLEANUP=1       delete created rows after run (needs PB_ADMIN_*)
 *   PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD or PB_ADMIN_TOKEN
 *
 * Writes JSON report under docs/.../results/phase1-integrate-prep-20261113/
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadDotEnv() {
  const p = resolve(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") {
      process.env[key] = val;
    }
  }
}

loadDotEnv();

const BASE = String(process.env.PB_URL || "https://db.keson.pro").replace(/\/$/, "");
const ACTIVITY_ID = process.env.PB_ACTIVITY_ID || "115-1-club-evaluation";
const LEVELS = String(process.env.STRESS_LEVELS || "10,30,66")
  .split(",")
  .map((x) => Number(x.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
const FILE_BYTES = Math.max(64, Number(process.env.STRESS_FILE_BYTES || 4096) || 4096);
const DO_CLEANUP = String(process.env.STRESS_CLEANUP || "1") !== "0";
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const BIRTH = "20010115";
const NEW_PASS = "StressPass1!";

const OUT_DIR = resolve(
  ROOT,
  "docs/drive-cloud-upload-school-proxy-20261110/results/phase1-integrate-prep-20261113"
);

function pct(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(latenciesMs) {
  const sorted = [...latenciesMs].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    max: sorted[sorted.length - 1] ?? null
  };
}

async function api(method, path, { token, json, form, admin } = {}) {
  const headers = {};
  if (token) headers.Authorization = token.startsWith("Bearer ") ? token : token;
  if (admin) headers.Authorization = admin.startsWith("Bearer ") ? admin : admin;
  let body;
  if (form) body = form;
  else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const t0 = performance.now();
  const res = await fetch(BASE + path, { method, headers, body });
  const text = await res.text();
  const ms = performance.now() - t0;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, data, ms, text };
}

function tinyPdf(bytes) {
  const head = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  if (bytes <= head.length) return head;
  return Buffer.concat([head, Buffer.alloc(bytes - head.length, 0x20)]);
}

async function adminAuth() {
  if (process.env.PB_ADMIN_TOKEN) {
    return process.env.PB_ADMIN_TOKEN.startsWith("Bearer ")
      ? process.env.PB_ADMIN_TOKEN
      : `Bearer ${process.env.PB_ADMIN_TOKEN}`;
  }
  const email = process.env.PB_ADMIN_EMAIL;
  const password = process.env.PB_ADMIN_PASSWORD;
  if (!email || !password) return "";
  const r = await api("POST", "/api/collections/_superusers/auth-with-password", {
    json: { identity: email, password }
  });
  if (!r.ok || !r.data?.token) {
    // older PB admin auth path
    const r2 = await api("POST", "/api/admins/auth-with-password", {
      json: { identity: email, password }
    });
    if (!r2.ok || !r2.data?.token) return "";
    return `Bearer ${r2.data.token}`;
  }
  return `Bearer ${r.data.token}`;
}

async function loadClubs(activityRecordId) {
  const items = [];
  let page = 1;
  for (;;) {
    const r = await api(
      "GET",
      `/api/collections/hksp_clubs/records?page=${page}&perPage=100&filter=${encodeURIComponent(
        `activity="${activityRecordId}" && active=true`
      )}&sort=permanent_club_id`
    );
    if (!r.ok) throw new Error(`list clubs => ${r.status} ${r.text}`);
    items.push(...(r.data.items || []));
    if (page >= (r.data.totalPages || 1)) break;
    page += 1;
  }
  // Prefer spreading across real clubs; keep DEMO as fallback filler.
  const demo = items.filter((c) => String(c.permanent_club_id || "").startsWith("DEMO"));
  const real = items.filter((c) => !String(c.permanent_club_id || "").startsWith("DEMO"));
  return [...real, ...demo];
}

async function worker(i, club, activity, pdfBuf, created) {
  const sid = `T${String(Date.now()).slice(-6)}${String(i).padStart(3, "0")}${Math.floor(
    Math.random() * 90 + 10
  )}`;
  const email = `${sid.toLowerCase()}@stu.hksp25.invalid`;
  const attempt = `stress-${RUN_ID}-${i}-${randomUUID()}`;
  const marks = {};
  const record = {
    i,
    sid,
    clubId: club.id,
    clubName: club.name,
    permanentClubId: club.permanent_club_id,
    attempt,
    ok: false,
    stage: "start",
    error: null,
    httpStatus: null,
    latencies: {}
  };

  try {
    record.stage = "create_student";
    let r = await api("POST", "/api/collections/hksp_students/records", {
      json: {
        email,
        emailVisibility: false,
        password: BIRTH,
        passwordConfirm: BIRTH,
        student_id: sid,
        birth_ymd: BIRTH,
        name: `STRESS ${sid}`,
        must_change_password: true,
        active: true
      }
    });
    record.latencies.create_student = r.ms;
    if (!r.ok) throw Object.assign(new Error(`create_student ${r.status}`), { httpStatus: r.status, detail: r.text });
    const student = r.data;
    created.students.push(student.id);

    record.stage = "auth1";
    r = await api("POST", "/api/collections/hksp_students/auth-with-password", {
      json: { identity: email, password: BIRTH }
    });
    record.latencies.auth1 = r.ms;
    if (!r.ok || !r.data?.token) throw Object.assign(new Error(`auth1 ${r.status}`), { httpStatus: r.status, detail: r.text });
    let token = r.data.token;

    record.stage = "membership";
    r = await api("POST", "/api/collections/hksp_memberships/records", {
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
    record.latencies.membership = r.ms;
    if (!r.ok) throw Object.assign(new Error(`membership ${r.status}`), { httpStatus: r.status, detail: r.text });
    created.memberships.push(r.data.id);

    record.stage = "change_password";
    r = await api("PATCH", `/api/collections/hksp_students/records/${student.id}`, {
      token,
      json: {
        oldPassword: BIRTH,
        password: NEW_PASS,
        passwordConfirm: NEW_PASS,
        must_change_password: false
      }
    });
    record.latencies.change_password = r.ms;
    if (!r.ok) throw Object.assign(new Error(`change_password ${r.status}`), { httpStatus: r.status, detail: r.text });

    record.stage = "auth2";
    r = await api("POST", "/api/collections/hksp_students/auth-with-password", {
      json: { identity: email, password: NEW_PASS }
    });
    record.latencies.auth2 = r.ms;
    if (!r.ok || !r.data?.token) throw Object.assign(new Error(`auth2 ${r.status}`), { httpStatus: r.status, detail: r.text });
    token = r.data.token;

    record.stage = "folder";
    r = await api("POST", "/api/collections/hksp_folders/records", {
      token,
      json: {
        activity: activity.id,
        club: club.id,
        name: `stress-${sid}`,
        kind: "evaluation",
        trashed: false,
        created_by_student: student.id
      }
    });
    record.latencies.folder = r.ms;
    if (!r.ok) throw Object.assign(new Error(`folder ${r.status}`), { httpStatus: r.status, detail: r.text });
    const folder = r.data;
    created.folders.push(folder.id);

    record.stage = "upload";
    const form = new FormData();
    form.append("activity", activity.id);
    form.append("club", club.id);
    form.append("folder", folder.id);
    form.append("student", student.id);
    form.append("client_attempt_id", attempt);
    form.append("upload_kind", "evaluation");
    form.append("original_name", `stress-${sid}.pdf`);
    form.append("mime_type", "application/pdf");
    form.append("size_bytes", String(pdfBuf.length));
    form.append("status", "completed");
    form.append("completed_at", new Date().toISOString());
    form.append("file", new Blob([pdfBuf], { type: "application/pdf" }), `stress-${sid}.pdf`);
    r = await api("POST", "/api/collections/hksp_uploads/records", { token, form });
    record.latencies.upload = r.ms;
    if (!r.ok) throw Object.assign(new Error(`upload ${r.status}`), { httpStatus: r.status, detail: r.text });
    created.uploads.push(r.data.id);
    record.uploadId = r.data.id;

    record.stage = "list_confirm";
    r = await api(
      "GET",
      `/api/collections/hksp_uploads/records?perPage=1&filter=${encodeURIComponent(
        `client_attempt_id="${attempt}"`
      )}`,
      { token }
    );
    record.latencies.list_confirm = r.ms;
    if (!r.ok || !(r.data.totalItems > 0)) {
      throw Object.assign(new Error(`list_confirm missing`), { httpStatus: r.status, detail: r.text });
    }

    record.ok = true;
    record.stage = "done";
    record.totalMs = Object.values(record.latencies).reduce((a, b) => a + b, 0);
    return record;
  } catch (e) {
    record.error = String((e && e.message) || e);
    record.httpStatus = e && e.httpStatus != null ? e.httpStatus : record.httpStatus;
    if (e && e.detail) record.detail = String(e.detail).slice(0, 400);
    record.totalMs = Object.values(record.latencies).reduce((a, b) => a + (Number(b) || 0), 0);
    return record;
  }
}

async function runLevel(n, clubs, activity, pdfBuf, created) {
  const wall0 = performance.now();
  const jobs = [];
  for (let i = 0; i < n; i++) {
    const club = clubs[i % clubs.length];
    jobs.push(worker(i, club, activity, pdfBuf, created));
  }
  const results = await Promise.all(jobs);
  const wallMs = performance.now() - wall0;
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const byStage = {};
  for (const r of fail) {
    byStage[r.stage] = (byStage[r.stage] || 0) + 1;
  }
  const statusBuckets = {};
  for (const r of results) {
    const k = r.httpStatus == null ? (r.ok ? "ok" : "err") : String(r.httpStatus);
    statusBuckets[k] = (statusBuckets[k] || 0) + 1;
  }
  const uploadLat = ok.map((r) => r.latencies.upload).filter(Number.isFinite);
  const totalLat = ok.map((r) => r.totalMs).filter(Number.isFinite);
  const distinctClubs = new Set(results.map((r) => r.permanentClubId)).size;
  return {
    concurrency: n,
    wallMs: Math.round(wallMs),
    success: ok.length,
    failed: fail.length,
    successRate: ok.length / n,
    distinctClubs,
    statusBuckets,
    failByStage: byStage,
    uploadLatencyMs: summarize(uploadLat),
    endToEndLatencyMs: summarize(totalLat),
    failures: fail.slice(0, 12).map((r) => ({
      i: r.i,
      sid: r.sid,
      stage: r.stage,
      error: r.error,
      httpStatus: r.httpStatus,
      club: r.clubName
    }))
  };
}

async function cleanup(created, adminToken) {
  if (!DO_CLEANUP) return { skipped: true };
  if (!adminToken) return { skipped: true, reason: "no_admin_token" };
  const deleted = { uploads: 0, folders: 0, memberships: 0, students: 0, errors: 0 };
  async function del(col, id) {
    const r = await api("DELETE", `/api/collections/${col}/records/${id}`, { admin: adminToken });
    if (r.ok || r.status === 404) return true;
    deleted.errors += 1;
    return false;
  }
  for (const id of created.uploads) if (await del("hksp_uploads", id)) deleted.uploads += 1;
  for (const id of created.folders) if (await del("hksp_folders", id)) deleted.folders += 1;
  for (const id of created.memberships) if (await del("hksp_memberships", id)) deleted.memberships += 1;
  for (const id of created.students) if (await del("hksp_students", id)) deleted.students += 1;
  return deleted;
}

async function main() {
  console.log("PB_STUDENT_UPLOAD_STRESS", { BASE, ACTIVITY_ID, LEVELS, FILE_BYTES, RUN_ID });

  const acts = await api(
    "GET",
    `/api/collections/hksp_activities/records?filter=${encodeURIComponent(
      `activity_id="${ACTIVITY_ID}"`
    )}`
  );
  if (!acts.ok || !acts.data.items?.[0]) throw new Error("activity not found");
  const activity = acts.data.items[0];

  const clubs = await loadClubs(activity.id);
  if (!clubs.length) throw new Error("no active clubs");
  console.log("clubs_available", clubs.length);

  const maxN = Math.max(...LEVELS);
  if (clubs.length < Math.min(maxN, 30)) {
    console.warn(
      `WARN: only ${clubs.length} clubs for peak ladder (wanted distinct clubs up to ${maxN}); will reuse clubs.`
    );
  }

  const pdfBuf = tinyPdf(FILE_BYTES);
  const adminToken = await adminAuth();
  const created = { students: [], memberships: [], folders: [], uploads: [] };
  const levels = [];

  for (const n of LEVELS) {
    console.log(`\n=== level concurrency=${n} ===`);
    const summary = await runLevel(n, clubs, activity, pdfBuf, created);
    levels.push(summary);
    console.log(
      JSON.stringify(
        {
          concurrency: summary.concurrency,
          successRate: Number(summary.successRate.toFixed(4)),
          wallMs: summary.wallMs,
          upload_p95: summary.uploadLatencyMs.p95,
          e2e_p95: summary.endToEndLatencyMs.p95,
          failByStage: summary.failByStage,
          statusBuckets: summary.statusBuckets,
          distinctClubs: summary.distinctClubs
        },
        null,
        2
      )
    );
  }

  const cleanupResult = await cleanup(created, adminToken);
  console.log("cleanup", cleanupResult);

  const passGate = levels.every(
    (l) =>
      l.successRate >= 0.99 &&
      (l.uploadLatencyMs.p95 == null || l.uploadLatencyMs.p95 <= 5000) &&
      (l.endToEndLatencyMs.p95 == null || l.endToEndLatencyMs.p95 <= 15000)
  );

  const report = {
    kind: "pb_student_upload_stress",
    runId: RUN_ID,
    at: new Date().toISOString(),
    target: { BASE, ACTIVITY_ID, fileBytes: FILE_BYTES },
    criteriaNote:
      "Adapted from prior Drive peak ladder (10→30→66). PB direct upload path (useDriveProxy=false). Pass gate: success≥99%, upload p95≤5s, e2e p95≤15s.",
    clubsAvailable: clubs.length,
    levels,
    cleanup: cleanupResult,
    passGate,
    verdict: passGate ? "PASS" : "FAIL_OR_PARTIAL"
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, `PB_STUDENT_UPLOAD_STRESS_${RUN_ID}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log("\nREPORT", outPath);
  console.log("VERDICT", report.verdict);
  if (!passGate) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
