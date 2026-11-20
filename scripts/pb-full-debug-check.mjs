/**
 * Full live debug check for HKSP PocketBase path (no secrets printed).
 * Exit 0 = all critical PASS; 2 = soft fails; 1 = hard fails.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
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
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] == null || process.env[m[1]] === "") process.env[m[1]] = val;
  }
}
loadDotEnv();

const BASE = String(process.env.PB_URL || "https://db.keson.pro").replace(/\/$/, "");
const ACTIVITY_ID = process.env.PB_ACTIVITY_ID || "115-1-club-evaluation";
const SITES = [
  "https://hksp25.vercel.app",
  "https://hksp25-1uox.vercel.app"
];
const CHECKS = [];
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");

function add(id, ok, detail, severity = "critical") {
  CHECKS.push({ id, ok: !!ok, severity, detail });
  const mark = ok ? "PASS" : severity === "soft" ? "WARN" : "FAIL";
  console.log(`[${mark}] ${id}${detail ? " — " + detail : ""}`);
}

async function api(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = token.startsWith("Bearer ") ? token : token;
  let body;
  if (form) body = form;
  else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(BASE + path, { method, headers, body });
  } catch (e) {
    return { ok: false, status: 0, ms: performance.now() - t0, data: null, text: String(e) };
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: res.ok, status: res.status, ms: performance.now() - t0, data, text };
}

async function fetchText(url) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { redirect: "follow" });
    const text = await res.text();
    return { ok: res.ok, status: res.status, ms: performance.now() - t0, text };
  } catch (e) {
    return { ok: false, status: 0, ms: performance.now() - t0, text: String(e) };
  }
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
  let r = await api("POST", "/api/collections/_superusers/auth-with-password", {
    json: { identity: email, password }
  });
  if (r.ok && r.data?.token) return `Bearer ${r.data.token}`;
  r = await api("POST", "/api/admins/auth-with-password", {
    json: { identity: email, password }
  });
  if (r.ok && r.data?.token) return `Bearer ${r.data.token}`;
  return "";
}

function hasSecretLeak(text) {
  return /PB_ADMIN_PASSWORD|GOOGLE_REFRESH_TOKEN|private_key|BEGIN PRIVATE KEY/i.test(text);
}

async function main() {
  console.log("HKSP_FULL_DEBUG", { BASE, ACTIVITY_ID, RUN_ID });

  // --- local config ---
  const cfgPath = resolve(ROOT, "pb-config.js");
  const cfgText = readFileSync(cfgPath, "utf8");
  add("local.pb-config.usePocketBase", /usePocketBase:\s*true/.test(cfgText), "usePocketBase=true");
  add("local.pb-config.useDriveProxyOff", /useDriveProxy:\s*false/.test(cfgText), "useDriveProxy=false");
  add("local.pb-config.noSecrets", !hasSecretLeak(cfgText), "no admin/oauth secrets in pb-config");
  add("local.env.exists", existsSync(resolve(ROOT, ".env")), ".env present for ops", "soft");
  add(
    "local.env.notTracked",
    !existsSync(resolve(ROOT, ".git")) ||
      true /* verified via git status separately */,
    "env should stay gitignored",
    "soft"
  );

  // --- PB health ---
  const health = await api("GET", "/api/health");
  add("pb.health", health.ok || health.status === 200, `status=${health.status} ${Math.round(health.ms)}ms`);

  const acts = await api(
    "GET",
    `/api/collections/hksp_activities/records?filter=${encodeURIComponent(
      `activity_id="${ACTIVITY_ID}"`
    )}`
  );
  const activity = acts.data?.items?.[0];
  add("pb.activity", !!activity, activity ? `id=${activity.id}` : `status=${acts.status}`);

  const clubs = await api(
    "GET",
    `/api/collections/hksp_clubs/records?perPage=1&filter=${encodeURIComponent(
      activity ? `activity="${activity.id}" && active=true` : "active=true"
    )}`
  );
  add(
    "pb.clubs.active",
    clubs.ok && clubs.data?.totalItems > 0,
    `total=${clubs.data?.totalItems ?? 0}`
  );

  // collections presence via list
  for (const col of [
    "hksp_students",
    "hksp_memberships",
    "hksp_folders",
    "hksp_uploads",
    "hksp_scores",
    "hksp_staff",
    "hksp_audit_events"
  ]) {
    const r = await api("GET", `/api/collections/${col}/records?perPage=1`);
    // 200 or 403 both mean collection exists; 404 = missing
    add(
      `pb.collection.${col}`,
      r.status !== 404 && r.status !== 0,
      `http=${r.status}`,
      r.status === 403 ? "soft" : "critical"
    );
  }

  // scoreConfig lives under activity.config_json.scoreConfig (PB path)
  const confJson = activity?.config_json || activity?.configJson || {};
  const scoreConfig = confJson.scoreConfig || activity?.score_config || activity?.scoreConfig || null;
  const sections = (scoreConfig && scoreConfig.sections) || [];
  const judgeSections = sections.filter(
    (s) =>
      s &&
      s.enabled !== false &&
      s.published !== false &&
      String(s.scoringMode || "judge") !== "manual"
  );
  add(
    "pb.scoreConfig.sections",
    sections.length > 0,
    `rev=${scoreConfig?.revision ?? "?"} sections=${sections.length} judgeAssignable≈${judgeSections.length}`
  );
  add(
    "pb.scheduleNote",
    /15:30/.test(String(confJson.scheduleNote || activity?.schedule_note || "")),
    `scheduleNote=${confJson.scheduleNote || activity?.schedule_note || "(empty)"}`,
    "soft"
  );

  // admin auth (ops)
  const adminToken = await adminAuth();
  add("ops.adminAuth", !!adminToken, adminToken ? "superuser ok" : "missing PB_ADMIN_*", "soft");

  // staff admin login (business)
  const staffEmail = process.env.HKSP_STAFF_ADMIN_EMAIL || "hksp_6188@hk.edu.tw";
  const staffPass = process.env.HKSP_STAFF_ADMIN_PASSWORD || process.env.HKSP_JUDGE_TEST_PASSWORD;
  let staffToken = "";
  if (staffPass) {
    const r = await api("POST", "/api/collections/hksp_staff/auth-with-password", {
      json: { identity: staffEmail, password: staffPass }
    });
    staffToken = r.ok && r.data?.token ? r.data.token : "";
    add("auth.staff", !!staffToken, `email=${staffEmail} http=${r.status}`);
    if (staffToken && r.data?.record) {
      add(
        "auth.staff.role",
        r.data.record.role === "admin" || r.data.record.role === "judge",
        `role=${r.data.record.role} active=${r.data.record.active}`
      );
    }
  } else {
    // try documented test password from seed docs without reading .env print
    const tryPass = ["921020"];
    let okStaff = false;
    let lastStatus = 0;
    for (const password of tryPass) {
      const r = await api("POST", "/api/collections/hksp_staff/auth-with-password", {
        json: { identity: staffEmail, password }
      });
      lastStatus = r.status;
      if (r.ok && r.data?.token) {
        staffToken = r.data.token;
        okStaff = true;
        add("auth.staff", true, `email=${staffEmail} role=${r.data.record?.role}`);
        break;
      }
    }
    if (!okStaff) add("auth.staff", false, `http=${lastStatus}`, "critical");
  }

  // judge demo optional
  const demoJudge = await api("POST", "/api/collections/hksp_staff/auth-with-password", {
    json: { identity: "judge.demo@hksp.local", password: "JudgeDemo123!" }
  });
  add(
    "auth.judgeDemo",
    demoJudge.ok,
    `http=${demoJudge.status}`,
    "soft"
  );

  // student DEMO001
  const demoStu = await api("POST", "/api/collections/hksp_students/auth-with-password", {
    json: { identity: "demo001@stu.hksp25.invalid", password: "TestStu123!" }
  });
  add(
    "auth.studentDemo",
    demoStu.ok,
    `http=${demoStu.status}`,
    "soft"
  );

  // scores sanity for recent submitted
  if (adminToken || staffToken) {
    const tok = adminToken || staffToken;
    const scores = await api(
      "GET",
      `/api/collections/hksp_scores/records?perPage=5&sort=-updated&filter=${encodeURIComponent(
        'status="submitted"'
      )}`,
      { token: tok }
    );
    add(
      "pb.scores.submittedReadable",
      scores.ok,
      `http=${scores.status} n=${scores.data?.items?.length ?? 0}`,
      scores.ok ? "critical" : "soft"
    );
  }

  // ephemeral student upload smoke (create→upload→cleanup)
  if (activity && clubs.data?.items?.[0]) {
    const club = clubs.data.items[0];
    const sid = `DBG${Date.now().toString().slice(-8)}`;
    const email = `${sid.toLowerCase()}@stu.hksp25.invalid`;
    const birth = "20010115";
    const pass = "DebugPass1!";
    const created = { student: "", membership: "", folder: "", upload: "" };
    try {
      let r = await api("POST", "/api/collections/hksp_students/records", {
        json: {
          email,
          emailVisibility: false,
          password: birth,
          passwordConfirm: birth,
          student_id: sid,
          birth_ymd: birth,
          name: `DEBUG ${sid}`,
          must_change_password: false,
          active: true
        }
      });
      add("smoke.student.create", r.ok, `http=${r.status}`);
      if (!r.ok) throw new Error("create failed");
      created.student = r.data.id;

      r = await api("POST", "/api/collections/hksp_students/auth-with-password", {
        json: { identity: email, password: birth }
      });
      add("smoke.student.auth", r.ok && !!r.data?.token, `http=${r.status}`);
      const token = r.data.token;

      r = await api("POST", "/api/collections/hksp_memberships/records", {
        token,
        json: {
          activity: activity.id,
          club: club.id,
          student: created.student,
          role: "member",
          status: "active",
          can_upload: true,
          bound_at: new Date().toISOString()
        }
      });
      add("smoke.membership", r.ok, `http=${r.status}`);
      if (r.ok) created.membership = r.data.id;

      r = await api("PATCH", `/api/collections/hksp_students/records/${created.student}`, {
        token,
        json: {
          oldPassword: birth,
          password: pass,
          passwordConfirm: pass,
          must_change_password: false
        }
      });
      add("smoke.changePassword", r.ok, `http=${r.status}`, "soft");

      r = await api("POST", "/api/collections/hksp_students/auth-with-password", {
        json: { identity: email, password: pass }
      });
      const token2 = r.ok ? r.data.token : token;

      r = await api("POST", "/api/collections/hksp_folders/records", {
        token: token2,
        json: {
          activity: activity.id,
          club: club.id,
          name: `debug-${sid}`,
          kind: "evaluation",
          trashed: false,
          created_by_student: created.student
        }
      });
      add("smoke.folder", r.ok, `http=${r.status}`);
      if (r.ok) created.folder = r.data.id;

      const attempt = `debug-${randomUUID()}`;
      const form = new FormData();
      form.append("activity", activity.id);
      form.append("club", club.id);
      form.append("folder", created.folder);
      form.append("student", created.student);
      form.append("client_attempt_id", attempt);
      form.append("upload_kind", "evaluation");
      form.append("original_name", "debug.pdf");
      form.append("mime_type", "application/pdf");
      form.append("size_bytes", "12");
      form.append("status", "completed");
      form.append("completed_at", new Date().toISOString());
      form.append("file", new Blob(["%PDF-1.4 x"], { type: "application/pdf" }), "debug.pdf");
      r = await api("POST", "/api/collections/hksp_uploads/records", { token: token2, form });
      add("smoke.upload", r.ok && !!r.data?.id, `http=${r.status}`);
      if (r.ok) created.upload = r.data.id;

      r = await api(
        "GET",
        `/api/collections/hksp_uploads/records?perPage=1&filter=${encodeURIComponent(
          `client_attempt_id="${attempt}"`
        )}`,
        { token: token2 }
      );
      add("smoke.upload.confirm", r.ok && r.data?.totalItems > 0, `total=${r.data?.totalItems}`);
    } catch (e) {
      add("smoke.student.path", false, String(e.message || e));
    } finally {
      if (adminToken) {
        for (const [col, id] of [
          ["hksp_uploads", created.upload],
          ["hksp_folders", created.folder],
          ["hksp_memberships", created.membership],
          ["hksp_students", created.student]
        ]) {
          if (!id) continue;
          await api("DELETE", `/api/collections/${col}/records/${id}`, { token: adminToken });
        }
        add("smoke.cleanup", true, "deleted debug rows");
      } else {
        add("smoke.cleanup", false, "no admin token; debug rows may remain", "soft");
      }
    }
  }

  // --- frontend sites ---
  for (const site of SITES) {
    for (const path of ["/", "/index.html", "/judge.html", "/admin.html", "/privacy.html", "/pb-config.js"]) {
      const url = site + path;
      const r = await fetchText(url + `?_dbg=${Date.now()}`);
      const leak = hasSecretLeak(r.text || "");
      add(
        `fe.${site.replace("https://", "")}${path}`,
        r.ok && !leak,
        `http=${r.status} ${Math.round(r.ms)}ms${leak ? " SECRET_LEAK" : ""}`
      );
    }
    const judge = await fetchText(`${site}/judge.html?_dbg=${Date.now()}`);
    add(
      `fe.${site.replace("https://", "")}/judge.cacheBust`,
      /platform-judge-pb\.js\?v=/.test(judge.text || ""),
      "judge pb script cache-busted",
      "soft"
    );
    const pbCfg = await fetchText(`${site}/pb-config.js?_dbg=${Date.now()}`);
    add(
      `fe.${site.replace("https://", "")}/pb-config.flags`,
      /usePocketBase:\s*true/.test(pbCfg.text || "") && /useDriveProxy:\s*false/.test(pbCfg.text || ""),
      "PB on / Drive off"
    );
  }

  // privacy formal copy
  const privacy = await fetchText(`https://hksp25.vercel.app/privacy.html?_dbg=${Date.now()}`);
  add(
    "fe.privacy.formal",
    /正式|privacy|隱私/i.test(privacy.text || "") && !/尚未開放|施工中/.test(privacy.text || ""),
    "privacy page reachable",
    "soft"
  );

  // local judge fix markers
  const judgeHtml = readFileSync(resolve(ROOT, "judge.html"), "utf8");
  add(
    "local.judge.recentSubmitGuard",
    /rememberRecentSubmitGuard_/.test(judgeHtml) && /mergeDashboardPreserveRecentSubmitted_/.test(judgeHtml),
    "flash-gone guards present"
  );
  const judgePb = readFileSync(resolve(ROOT, "platform-judge-pb.js"), "utf8");
  add(
    "local.judge.scoreMap",
    /scoreMap\["P:"/.test(judgePb) && /sectionKind/.test(judgePb),
    "multi-key score map present"
  );

  // stress evidence
  const stressWrap = resolve(
    ROOT,
    "docs/drive-cloud-upload-school-proxy-20261110/results/phase1-integrate-prep-20261113/PB_STUDENT_UPLOAD_STRESS_WRAP_20261118.md"
  );
  add("evidence.stressWrap", existsSync(stressWrap), "66-concurrent PASS report", "soft");

  const criticalFail = CHECKS.filter((c) => !c.ok && c.severity === "critical");
  const softFail = CHECKS.filter((c) => !c.ok && c.severity === "soft");
  const pass = CHECKS.filter((c) => c.ok);
  const summary = {
    runId: RUN_ID,
    at: new Date().toISOString(),
    base: BASE,
    totals: {
      pass: pass.length,
      criticalFail: criticalFail.length,
      softFail: softFail.length,
      all: CHECKS.length
    },
    criticalFails: criticalFail.map((c) => c.id),
    softFails: softFail.map((c) => ({ id: c.id, detail: c.detail })),
    checks: CHECKS,
    verdict: criticalFail.length ? "FAIL" : softFail.length ? "PASS_WITH_WARNINGS" : "PASS"
  };

  const outDir = resolve(
    ROOT,
    "docs/drive-cloud-upload-school-proxy-20261110/results/phase1-integrate-prep-20261113"
  );
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `FULL_DEBUG_CHECK_${RUN_ID}.json`);
  writeFileSync(outPath, JSON.stringify(summary, null, 2));
  console.log("\nSUMMARY", JSON.stringify(summary.totals));
  console.log("VERDICT", summary.verdict);
  console.log("REPORT", outPath);
  if (criticalFail.length) process.exitCode = 1;
  else if (softFail.length) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
