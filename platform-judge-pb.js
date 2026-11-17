/**
 * PocketBase adapter for full judge.html (GAS-shaped responses).
 * Default when HKSP_PB_CONFIG.usePocketBase=true (override with ?gas=1).
 */
"use strict";

(function (root) {
  var SESSION_RECORD_KEY = "HKSP_PB_JUDGE_RECORD";

  function qs() {
    return new URLSearchParams(root.location.search);
  }

  function enabled() {
    if (qs().get("gas") === "1") return false;
    if (qs().get("pb") === "0") return false;
    return !!(root.HKSP_PB_CONFIG && root.HKSP_PB_CONFIG.usePocketBase);
  }

  function cfg() {
    return root.HKSP_PB_CONFIG || {};
  }

  function backend() {
    return root.HKSP_PB_BACKEND || null;
  }

  function pb() {
    var b = backend();
    if (!b || !b.pb) throw new Error("PocketBase 後端尚未載入，請重新整理。");
    return b.pb;
  }

  function C() {
    return cfg().collections || {};
  }

  function activityId() {
    return cfg().activityId || "115-1-club-evaluation";
  }

  function fail(message, error) {
    return { success: false, error: error || "PB_JUDGE_ERROR", message: message || "操作失敗" };
  }

  function ok(extra) {
    return Object.assign({ success: true }, extra || {});
  }

  function parseAssign(rec) {
    var raw = rec && rec.notes;
    if (raw && typeof raw === "object") {
      return {
        categories: Array.isArray(raw.categories) ? raw.categories : [],
        scoreSectionIds: Array.isArray(raw.scoreSectionIds) ? raw.scoreSectionIds : []
      };
    }
    if (typeof raw === "string" && raw.trim()) {
      try {
        var parsed = JSON.parse(raw);
        return {
          categories: Array.isArray(parsed.categories) ? parsed.categories : [],
          scoreSectionIds: Array.isArray(parsed.scoreSectionIds) ? parsed.scoreSectionIds : []
        };
      } catch (_e) {
        return { categories: [], scoreSectionIds: [] };
      }
    }
    return { categories: [], scoreSectionIds: [] };
  }

  function mapJudge(rec) {
    var assign = parseAssign(rec);
    return {
      id: rec.id,
      judgeId: rec.id,
      email: rec.email || "",
      username: rec.email || "",
      name: rec.name || rec.email || "評審",
      displayName: rec.name || rec.email || "評審",
      role: rec.role,
      categories: assign.categories,
      scoreSectionIds: assign.scoreSectionIds
    };
  }

  async function ensureJudgeFromToken(sessionToken) {
    var client = pb();
    var token = String(sessionToken || "").trim();
    if (!token) throw new Error("JUDGE_UNAUTHORIZED");
    if (!client.authStore.isValid || client.authStore.token !== token) {
      var raw = sessionStorage.getItem(SESSION_RECORD_KEY);
      var model = null;
      try {
        model = raw ? JSON.parse(raw) : null;
      } catch (_e) {
        model = null;
      }
      client.authStore.save(token, model);
    }
    if (!client.authStore.isValid) {
      await client.collection(C().staff).authRefresh();
    }
    var rec = client.authStore.model;
    if (!rec || (rec.role !== "judge" && rec.role !== "admin") || rec.active === false) {
      throw new Error("JUDGE_UNAUTHORIZED");
    }
    try {
      sessionStorage.setItem(SESSION_RECORD_KEY, JSON.stringify(rec));
    } catch (_e2) {
      /* ignore */
    }
    return rec;
  }

  async function getActivity() {
    return pb()
      .collection(C().activities)
      .getFirstListItem('activity_id="' + activityId() + '"');
  }

  function scoreConfigOf(activity) {
    var conf = (activity && activity.config_json) || {};
    return conf.scoreConfig && typeof conf.scoreConfig === "object" ? conf.scoreConfig : null;
  }

  function scoringSections(scoreConfig, allowedIds, requirePublished) {
    var all = (scoreConfig && Array.isArray(scoreConfig.sections) ? scoreConfig.sections : []).filter(
      function (s) {
        return s && s.enabled !== false && s.scoringMode !== "manual";
      }
    );
    var sections = requirePublished
      ? all.filter(function (s) {
          return s.published === true;
        })
      : all.slice();
    // 若尚未標記 published，仍允許使用已啟用大項（避免送分／管理端雙雙空白）
    if (requirePublished && !sections.length) sections = all.slice();
    if (Array.isArray(allowedIds) && allowedIds.length) {
      var set = {};
      allowedIds.forEach(function (id) {
        set[String(id)] = true;
      });
      var filtered = sections.filter(function (s) {
        return set[String(s.id)];
      });
      if (filtered.length) sections = filtered;
    }
    return sections;
  }

  function publishedSections(scoreConfig, allowedIds) {
    return scoringSections(scoreConfig, allowedIds, true);
  }

  function flattenCriteria(section) {
    var out = [];
    (section.groups || []).forEach(function (g) {
      if (!g || g.enabled === false) return;
      (g.criteria || []).forEach(function (c) {
        if (!c || c.enabled === false) return;
        out.push({
          id: c.id,
          name: c.name || c.id,
          maxScore: Number(c.maxScore) || 0,
          groupId: g.id,
          groupName: g.name || ""
        });
      });
    });
    return out;
  }

  function ruleSignatureOf(section, configRevision) {
    var parts = [String(section.id), "rev:" + String(configRevision || 1)];
    flattenCriteria(section).forEach(function (c) {
      parts.push(String(c.id) + ":" + String(c.maxScore));
    });
    return parts.join("|");
  }

  function stageMeta(section, scoreConfig) {
    var criteria = flattenCriteria(section);
    var configRevision = Number(scoreConfig && scoreConfig.revision) || 1;
    return {
      id: section.id,
      sectionId: section.id,
      name: section.name || section.id,
      stageName: section.name || section.id,
      icon: section.icon || "📌",
      maxScore: Number(section.maxScore) || criteria.reduce(function (n, c) {
        return n + (Number(c.maxScore) || 0);
      }, 0),
      available: true,
      published: true,
      configRevision: configRevision,
      ruleSignature: ruleSignatureOf(section, configRevision),
      criteria: criteria
    };
  }

  function answersMeta(row) {
    var answers = (row && row.answers_json) || {};
    if (typeof answers !== "object" || !answers) answers = {};
    return answers;
  }

  function recordFromRow(row, club, section, scoreConfig) {
    if (!row) return null;
    var answers = answersMeta(row);
    var scores = answers.scores && typeof answers.scores === "object" ? answers.scores : {};
    var configRevision = Number(scoreConfig && scoreConfig.revision) || 1;
    var locked = row.status === "submitted" && answers.reopened !== true;
    var reopened = answers.reopened === true;
    return {
      id: row.id,
      clubName: club.name,
      permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
      sectionId: section.id,
      scores: scores,
      totalScore: Number(row.score) || 0,
      comment: row.comment || "",
      status: reopened ? "reopened" : row.status || "draft",
      locked: locked,
      reopened: reopened,
      unlockedAt: answers.unlockedAt || null,
      submissionRevision: Number(row.revision) || 1,
      configRevision: Number(answers.configRevision) || configRevision,
      ruleSignature: answers.ruleSignature || ruleSignatureOf(section, configRevision),
      submittedAt: row.submitted_at || null,
      updatedAt: row.updated || null
    };
  }

  async function findClub(activity, permanentClubId, clubName) {
    var permanent = String(permanentClubId || "").trim().toUpperCase();
    var name = String(clubName || "").trim();
    if (permanent) {
      return pb()
        .collection(C().clubs)
        .getFirstListItem(
          'activity="' + activity.id + '" && permanent_club_id="' + permanent + '"'
        );
    }
    if (name) {
      return pb()
        .collection(C().clubs)
        .getFirstListItem(
          'activity="' + activity.id + '" && name="' + name.replace(/"/g, '\\"') + '"'
        );
    }
    throw new Error("缺少社團。");
  }

  async function judgeLogin(data) {
    var username = String((data && (data.username || data.email)) || "").trim();
    var password = String((data && data.password) || "");
    if (!username || !password) return fail("請輸入評審帳號與密碼。");
    // Prefer explicit email; bare names become name@hksp.local (admin 新增評審時的慣例).
    var identities = [];
    if (username.indexOf("@") >= 0) {
      identities.push(username);
    } else {
      identities.push(username + "@hksp.local");
      identities.push(username);
    }
    var lastErr = null;
    for (var i = 0; i < identities.length; i++) {
      try {
        var auth = await pb().collection(C().staff).authWithPassword(identities[i], password);
        var rec = auth.record;
        if (rec.active === false) {
          pb().authStore.clear();
          return fail("評審帳號已停用。");
        }
        if (rec.role !== "judge" && rec.role !== "admin") {
          pb().authStore.clear();
          return fail("此帳號沒有評審權限。", "FORBIDDEN");
        }
        sessionStorage.setItem(SESSION_RECORD_KEY, JSON.stringify(rec));
        var judge = mapJudge(rec);
        var dashboard = await buildDashboard(rec);
        return ok({
          sessionToken: auth.token,
          expiresAt: null,
          judge: judge,
          dashboard: dashboard
        });
      } catch (e) {
        lastErr = e;
      }
    }
    var emsg = String((lastErr && lastErr.message) || "");
    if (/Failed to authenticate|invalid|wrong/i.test(emsg)) {
      return fail(
        "登入失敗，請確認帳號與密碼。帳號請填 Email（或後台建立時的 xxx@hksp.local），不是顯示名稱「測試一」。"
      );
    }
    return fail(emsg || "登入失敗，請確認帳號與密碼。");
  }

  async function judgeLogout() {
    try {
      pb().authStore.clear();
    } catch (_e) {
      /* ignore */
    }
    try {
      sessionStorage.removeItem(SESSION_RECORD_KEY);
    } catch (_e2) {
      /* ignore */
    }
    return ok();
  }

  async function buildDashboard(judgeRec) {
    var activity = await getActivity();
    var scoreConfig = scoreConfigOf(activity);
    if (!scoreConfig) {
      return fail("尚未設定評分機制（scoreConfig）。請先在管理後台建立並發布配分表。");
    }
    var judge = mapJudge(judgeRec);
    var sections = publishedSections(scoreConfig, judge.scoreSectionIds);
    if (!sections.length) {
      sections = publishedSections(scoreConfig, null);
    }
    var clubs = await pb().collection(C().clubs).getFullList({
      filter: 'activity="' + activity.id + '" && active=true',
      sort: "category,name"
    });
    if (judge.categories && judge.categories.length) {
      var catSet = {};
      judge.categories.forEach(function (c) {
        catSet[String(c)] = true;
      });
      clubs = clubs.filter(function (c) {
        return catSet[String(c.category || "")];
      });
    }
    var myScores = await pb().collection(C().scores).getFullList({
      filter: 'activity="' + activity.id + '" && judge="' + judgeRec.id + '"'
    });
    var scoreMap = {};
    myScores.forEach(function (row) {
      scoreMap[row.club + "::" + row.section_id] = row;
    });
    var stages = {};
    var sectionList = [];
    sections.forEach(function (section) {
      var meta = stageMeta(section, scoreConfig);
      var submittedCount = 0;
      var draftCount = 0;
      var reopenedCount = 0;
      var clubRows = clubs.map(function (club) {
        var row = scoreMap[club.id + "::" + section.id] || null;
        var answers = answersMeta(row);
        var reopened = !!(row && answers.reopened === true);
        var status = "notStarted";
        if (row) {
          if (reopened) {
            status = "reopened";
            reopenedCount += 1;
          } else if (row.status === "submitted") {
            status = "submitted";
            submittedCount += 1;
          } else if (row.status === "draft") {
            status = "draft";
            draftCount += 1;
          }
        }
        return {
          clubName: club.name,
          permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
          category: club.category || "",
          status: status,
          reopened: reopened,
          locked: status === "submitted",
          totalScore: row ? Number(row.score) || 0 : null,
          updatedAt: row ? row.updated : null
        };
      });
      stages[section.id] = Object.assign({}, meta, {
        clubs: clubRows,
        totalClubs: clubRows.length,
        submittedCount: submittedCount,
        draftCount: draftCount,
        reopenedCount: reopenedCount,
        statusPending: false
      });
      sectionList.push({
        id: section.id,
        name: section.name,
        icon: section.icon || "📌",
        maxScore: meta.maxScore
      });
    });
    return ok({
      judge: judge,
      activityId: activity.activity_id,
      scoreConfigRevision: Number(scoreConfig.revision) || 1,
      sections: sectionList,
      scoreSectionIds: sections.map(function (s) {
        return s.id;
      }),
      assignedCategories: judge.categories || [],
      assignedClubCount: clubs.length,
      stages: stages
    });
  }

  async function judgeScoreDashboard() {
    var rec = pb().authStore.model;
    return buildDashboard(rec);
  }

  async function judgeGetScore(data) {
    var judgeRec = pb().authStore.model;
    var activity = await getActivity();
    var scoreConfig = scoreConfigOf(activity);
    if (!scoreConfig) return fail("尚未設定評分機制。");
    var sectionId = String((data && (data.sectionId || data.stageKey)) || "").trim();
    var section = (scoreConfig.sections || []).find(function (s) {
      return String(s.id) === sectionId;
    });
    if (!section) return fail("找不到評分大項。");
    var club = await findClub(activity, data.permanentClubId, data.clubName);
    var res = await pb().collection(C().scores).getList(1, 1, {
      filter:
        'activity="' +
        activity.id +
        '" && club="' +
        club.id +
        '" && judge="' +
        judgeRec.id +
        '" && section_id="' +
        sectionId +
        '"'
    });
    var row = res.totalItems > 0 ? res.items[0] : null;
    var stage = stageMeta(section, scoreConfig);
    var record = recordFromRow(row, club, section, scoreConfig);
    var answers = answersMeta(row);
    var locked = !!(record && record.locked);
    return ok({
      stage: stage,
      section: stage,
      club: {
        name: club.name,
        clubName: club.name,
        permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
        category: club.category || ""
      },
      permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
      record: record,
      locked: locked,
      reopened: !!(record && record.reopened),
      scores: record ? record.scores : {},
      unlockedAt: answers.unlockedAt || null
    });
  }

  async function judgeSubmitScore(data) {
    var judgeRec = pb().authStore.model;
    if (!judgeRec || !judgeRec.id) {
      return fail("評審登入已失效，請重新登入。", "JUDGE_UNAUTHORIZED");
    }
    var activity = await getActivity();
    var scoreConfig = scoreConfigOf(activity);
    if (!scoreConfig) {
      return fail("尚未設定評分機制。請先在管理後台建立並發布配分表。", "SCORE_SECTION_REQUIRED");
    }
    var sectionId = String((data && (data.sectionId || data.stageKey)) || "").trim();
    if (!sectionId) return fail("缺少評分大項。", "SCORE_SECTION_REQUIRED");
    var section = (scoreConfig.sections || []).find(function (s) {
      return String(s.id) === sectionId;
    });
    if (!section || section.enabled === false) {
      return fail("找不到評分大項。", "SCORE_SECTION_NOT_FOUND");
    }
    var club;
    try {
      club = await findClub(activity, data.permanentClubId, data.clubName);
    } catch (clubErr) {
      return fail((clubErr && clubErr.message) || "找不到社團。", "CLUB_NOT_FOUND");
    }
    var scores = (data && data.scores) || {};
    var criteria = flattenCriteria(section);
    if (!criteria.length) {
      return fail("此大項目前沒有可評分的小項。", "SCORE_SECTION_REQUIRED");
    }
    var total = 0;
    for (var i = 0; i < criteria.length; i++) {
      var c = criteria[i];
      var v = Number(scores[c.id]);
      if (!Number.isFinite(v)) {
        return fail("請完成所有評分小項。", "SCORE_INCOMPLETE");
      }
      if (v < 0 || v > Number(c.maxScore)) {
        return fail(
          "「" + c.name + "」分數超出範圍（0–" + c.maxScore + "）。",
          "SCORE_INPUT_INVALID"
        );
      }
      total += v;
    }
    var existing = await pb().collection(C().scores).getList(1, 1, {
      filter:
        'activity="' +
        activity.id +
        '" && club="' +
        club.id +
        '" && judge="' +
        judgeRec.id +
        '" && section_id="' +
        sectionId +
        '"'
    });
    var prev = existing.totalItems > 0 ? existing.items[0] : null;
    var prevAnswers = answersMeta(prev);
    if (prev && prev.status === "submitted" && prevAnswers.reopened !== true) {
      return fail("此筆已鎖定，無法再次送出。請請管理員解鎖。", "JUDGE_SCORE_LOCKED");
    }
    var configRevision = Number(scoreConfig.revision) || 1;
    var signature = ruleSignatureOf(section, configRevision);
    var revision = prev ? Number(prev.revision || 1) + 1 : 1;
    var submittedAt = new Date().toISOString();
    var payload = {
      activity: activity.id,
      club: club.id,
      judge: judgeRec.id,
      section_id: sectionId,
      score: total,
      comment: String((data && data.comment) || ""),
      answers_json: {
        scores: scores,
        locked: true,
        reopened: false,
        unlockedAt: null,
        configRevision: configRevision,
        ruleSignature: signature,
        submittedAt: submittedAt,
        judgeId: judgeRec.id,
        permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
        clubName: club.name || "",
        sectionId: sectionId
      },
      status: "submitted",
      revision: revision,
      submitted_at: submittedAt
    };
    // Best-effort refresh; do not kick out if refresh fails but token still valid.
    try {
      await pb().collection(C().staff).authRefresh();
    } catch (_refreshErr) {
      /* keep existing authStore */
    }
    judgeRec = pb().authStore.model || judgeRec;
    if (!judgeRec || !judgeRec.id || !pb().authStore.isValid) {
      return fail("評審登入已失效，請重新登入。", "JUDGE_UNAUTHORIZED");
    }
    payload.judge = judgeRec.id;
    if (payload.answers_json) payload.answers_json.judgeId = judgeRec.id;
    if (
      (judgeRec.role !== "judge" && judgeRec.role !== "admin") ||
      judgeRec.active === false
    ) {
      return fail("此帳號沒有評分寫入權限。", "JUDGE_SCORE_SECTION_FORBIDDEN");
    }

    function writeErrorDetail(writeErr) {
      var status = writeErr && (writeErr.status || writeErr.statusCode);
      var raw = (writeErr && (writeErr.data || writeErr.response)) || {};
      var fieldErrors = raw.data || {};
      var fields = Object.keys(fieldErrors)
        .map(function (k) {
          var fe = fieldErrors[k];
          return k + ":" + String((fe && (fe.message || fe.code)) || fe || "");
        })
        .filter(Boolean)
        .join("; ");
      var wmsg = String((writeErr && writeErr.message) || writeErr || "寫入分數失敗");
      return {
        status: status,
        wmsg: wmsg,
        fields: fields,
        raw: raw
      };
    }

    function isPermissionWriteError(detail) {
      if (detail.status === 403) return true;
      var blob = (detail.wmsg + " " + detail.fields).toLowerCase();
      // Do NOT match generic "Failed to create record" — that is usually validation/unique.
      return /forbidden|permission|only superusers|didn't match.*rule|does not match.*rule/.test(
        blob
      );
    }

    function isUniqueWriteError(detail) {
      if (detail.status !== 400) return false;
      var blob = JSON.stringify(detail.raw || {}) + " " + detail.wmsg;
      return /unique|not_unique/i.test(blob);
    }

    var row;
    try {
      row = prev
        ? await pb().collection(C().scores).update(prev.id, payload)
        : await pb().collection(C().scores).create(payload);
    } catch (writeErr) {
      var detail = writeErrorDetail(writeErr);
      if (isPermissionWriteError(detail)) {
        return fail(
          "沒有權限寫入評分（請確認帳號 role=judge／admin 且 active，並已套用 hksp_scores ACL）。",
          "JUDGE_SCORE_SECTION_FORBIDDEN"
        );
      }
      // Race / list miss: record exists → update instead of create.
      if (!prev && isUniqueWriteError(detail)) {
        try {
          var again = await pb().collection(C().scores).getList(1, 1, {
            filter:
              'activity="' +
              activity.id +
              '" && club="' +
              club.id +
              '" && judge="' +
              judgeRec.id +
              '" && section_id="' +
              sectionId +
              '"'
          });
          if (again.totalItems > 0) {
            payload.revision = Number(again.items[0].revision || 1) + 1;
            row = await pb().collection(C().scores).update(again.items[0].id, payload);
          } else {
            throw writeErr;
          }
        } catch (retryErr) {
          var d2 = writeErrorDetail(retryErr);
          return fail(
            d2.wmsg + (d2.fields ? "（" + d2.fields + "）" : ""),
            "SCORE_INPUT_INVALID"
          );
        }
      } else {
        return fail(
          detail.wmsg + (detail.fields ? "（" + detail.fields + "）" : ""),
          "SCORE_INPUT_INVALID"
        );
      }
    }
    var record = recordFromRow(row, club, section, scoreConfig);
    if (!record || record.locked !== true) {
      // 保險：若回讀語意異常，仍以本次 payload 組成成功結果，避免前端誤入 confirming
      record = {
        id: row.id,
        clubName: club.name,
        permanentClubId: String(club.permanent_club_id || "").toUpperCase(),
        sectionId: sectionId,
        scores: scores,
        totalScore: total,
        comment: payload.comment,
        status: "submitted",
        locked: true,
        reopened: false,
        unlockedAt: null,
        submissionRevision: revision,
        configRevision: configRevision,
        ruleSignature: signature,
        submittedAt: submittedAt,
        updatedAt: row.updated || submittedAt
      };
    }
    return ok({
      success: true,
      record: record,
      locked: true,
      reopened: false,
      submissionRevision: revision,
      scores: scores,
      permanentClubId: record.permanentClubId,
      clubName: club.name,
      sectionId: sectionId
    });
  }

  var handlers = {
    judgeLogin: judgeLogin,
    judgeLogout: judgeLogout,
    judgeScoreDashboard: judgeScoreDashboard,
    judgeGetScore: judgeGetScore,
    judgeSubmitScore: judgeSubmitScore
  };

  async function request(payload) {
    var action = String((payload && payload.action) || "");
    if (!action) return fail("缺少 action。");
    try {
      if (action !== "judgeLogin") {
        await ensureJudgeFromToken(payload && payload.sessionToken);
      }
      var fn = handlers[action];
      if (!fn) return fail("PocketBase 評審端尚未實作：" + action, "UNIMPLEMENTED");
      return await fn(payload || {});
    } catch (e) {
      var msg = String((e && e.message) || e || "操作失敗");
      // Only map explicit session failures — do NOT match generic "authenticate" login errors.
      if (
        msg === "JUDGE_UNAUTHORIZED" ||
        /^JUDGE_UNAUTHORIZED\b/i.test(msg) ||
        /登入已失效|session.*(expired|invalid)/i.test(msg)
      ) {
        return fail("評審登入已失效，請重新登入。", "JUDGE_UNAUTHORIZED");
      }
      return fail(msg);
    }
  }

  function configureUi() {
    if (!enabled()) return;
    document.documentElement.classList.add("pocketbase-judge");
    var hint = document.querySelector(".login-card .muted, .login-sub, .sub");
    if (hint && /GAS|後端/.test(String(hint.textContent || ""))) {
      hint.textContent = "PocketBase 評審登入";
    }
    var user = document.getElementById("username");
    if (user && !String(user.value || "").trim()) {
      var pref =
        (cfg() && cfg().staffJudgeEmail) ||
        (cfg() && cfg().staffAdminEmail) ||
        "hksp_6188@hk.edu.tw";
      user.value = String(pref).trim();
      user.placeholder = String(pref).trim();
    }
  }

  root.HKSP_JUDGE_PB = {
    enabled: enabled,
    configureUi: configureUi,
    request: request
  };

  if (enabled()) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", configureUi);
    } else {
      configureUi();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
