/**
 * Policy A: one active membership per club.
 * 1) Clean duplicate active seats (keep earliest created; hard-delete later students)
 * 2) Ensure UNIQUE partial index on (activity, club) WHERE status='active'
 *
 * Usage: node scripts/pb-lock-one-seat-per-club.cjs
 * Reads PB_* from .env
 */
const fs = require("fs");
const path = require("path");

function loadEnv() {
  const text = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
  const out = {};
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  });
  return out;
}

async function pb(base, token, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || res.statusText || "PB error");
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

const SEAT_INDEX =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_hksp_membership_one_active_seat ON hksp_memberships (activity, club) WHERE status = 'active'";

function isWrr(sid) {
  const s = String(sid || "");
  return /^W[a-zA-Z0-9]+$/.test(s) || /__WRR__/i.test(s) || /^wrr/i.test(s);
}

(async () => {
  const env = loadEnv();
  const PB = env.PB_URL;
  const auth = await pb(PB, null, "POST", "/api/collections/_superusers/auth-with-password", {
    identity: env.PB_ADMIN_EMAIL,
    password: env.PB_ADMIN_PASSWORD
  });
  const token = auth.token;

  const act = (
    await pb(
      PB,
      token,
      "GET",
      "/api/collections/hksp_activities/records?filter=" +
        encodeURIComponent('activity_id="115-1-club-evaluation"') +
        "&perPage=1"
    )
  ).items[0];
  if (!act) throw new Error("activity missing");

  let page = 1;
  let items = [];
  for (;;) {
    const batch = await pb(
      PB,
      token,
      "GET",
      "/api/collections/hksp_memberships/records?filter=" +
        encodeURIComponent('activity="' + act.id + '" && status="active"') +
        "&expand=club,student&perPage=200&page=" +
        page
    );
    items = items.concat(batch.items || []);
    if (!batch.items || batch.items.length < 200 || page >= (batch.totalPages || 1)) break;
    page += 1;
  }

  const byClub = new Map();
  items.forEach((m) => {
    const key = String(m.club || "");
    if (!byClub.has(key)) byClub.set(key, []);
    byClub.get(key).push(m);
  });

  const cleaned = [];
  for (const [, mems] of byClub) {
    if (mems.length <= 1) continue;
    const sorted = mems.slice().sort((a, b) =>
      String(a.created || "").localeCompare(String(b.created || ""))
    );
    const keep = sorted[0];
    const drop = sorted.slice(1);
    for (const m of drop) {
      const stu = (m.expand && m.expand.student) || null;
      const club = (m.expand && m.expand.club) || {};
      const studentId = stu && stu.student_id;
      // Prefer hard-delete student (releases Auth + memberships). Fallback: revoke membership.
      let mode = "membership_revoked";
      if (stu && stu.id && !isWrr(studentId)) {
        try {
          await pb(PB, token, "DELETE", "/api/collections/hksp_students/records/" + stu.id);
          mode = "student_hard_deleted";
        } catch (_delStu) {
          try {
            await pb(PB, token, "DELETE", "/api/collections/hksp_memberships/records/" + m.id);
            mode = "membership_deleted";
          } catch (_delMem) {
            await pb(PB, token, "PATCH", "/api/collections/hksp_memberships/records/" + m.id, {
              status: "revoked",
              can_upload: false
            });
            mode = "membership_revoked";
          }
        }
      } else {
        try {
          await pb(PB, token, "DELETE", "/api/collections/hksp_memberships/records/" + m.id);
          mode = "membership_deleted";
        } catch (_e) {
          await pb(PB, token, "PATCH", "/api/collections/hksp_memberships/records/" + m.id, {
            status: "revoked",
            can_upload: false
          });
          mode = "membership_revoked";
        }
      }
      cleaned.push({
        clubName: club.name || "",
        permanentClubId: club.permanent_club_id || "",
        keptStudentId: keep.expand && keep.expand.student && keep.expand.student.student_id,
        droppedStudentId: studentId || "",
        mode
      });
    }
  }

  // Ensure unique seat index on collection schema
  const cols = await pb(PB, token, "GET", "/api/collections?perPage=200");
  const memberships = (cols.items || []).find((c) => c.name === "hksp_memberships");
  if (!memberships) throw new Error("hksp_memberships missing");
  const indexes = Array.isArray(memberships.indexes) ? memberships.indexes.slice() : [];
  const hasSeatIdx = indexes.some(
    (idx) =>
      /idx_hksp_membership_one_active_seat/i.test(String(idx)) ||
      (/unique/i.test(String(idx)) &&
        /hksp_memberships/i.test(String(idx)) &&
        /status\s*=\s*'active'/i.test(String(idx)) &&
        /\(activity,\s*club\)/i.test(String(idx)))
  );
  let indexAdded = false;
  if (!hasSeatIdx) {
    indexes.push(SEAT_INDEX.replace(" IF NOT EXISTS", ""));
    await pb(PB, token, "PATCH", "/api/collections/" + memberships.id, {
      indexes: indexes
    });
    indexAdded = true;
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        cleanedCount: cleaned.length,
        cleaned,
        indexAdded,
        indexSql: SEAT_INDEX.replace(" IF NOT EXISTS", "")
      },
      null,
      2
    )
  );
})().catch((e) => {
  console.error(e && e.body ? JSON.stringify(e.body, null, 2) : e);
  process.exit(1);
});
