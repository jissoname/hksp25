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

  function publishedSections(scoreConfig, allowedIds) {
    var sections = (scoreConfig && Array.isArray(scoreConfig.sections) ? scoreConfig.sections : []).filter(
      function (s) {
        return s && s.enabled !== false && s.published === true && s.scoringMode !== "manual";
      }
    );
    if (Array.isArray(allowedIds) && allowedIds.length) {
      var set = {};
      allowedIds.forEach(function (id) {
        set[String(id)] = true;
      });
      sections = sections.filter(function (s) {
        return set[String(s.id)];
      });
    }
    return sections;
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
    var email = username.indexOf("@") >= 0 ? username : username + "@hksp.local";
    try {
      var auth = await pb().collection(C().staff).authWithPassword(email, password);
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
      return fail((e && e.message) || "登入失敗，請確認帳號與密碼。");
    }
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
    var activity = await getActivity();
    var scoreConfig = scoreConfigOf(activity);
    if (!scoreConfig) return fail("尚未設定評分機制。");
    var sectionId = String((data && (data.sectionId || data.stageKey)) || "").trim();
    var section = (scoreConfig.sections || []).find(function (s) {
      return String(s.id) === sectionId;
    });
    if (!section) return fail("找不到評分大項。");
    var club = await findClub(activity, data.permanentClubId, data.clubName);
    var scores = (data && data.scores) || {};
    var criteria = flattenCriteria(section);
    var total = 0;
    for (var i = 0; i < criteria.length; i++) {
      var c = criteria[i];
      var v = Number(scores[c.id]);
      if (!Number.isFinite(v)) return fail("請完成所有評分小項。");
      if (v < 0 || v > Number(c.maxScore)) {
        return fail("「" + c.name + "」分數超出範圍（0–" + c.maxScore + "）。");
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
      return fail("此筆已鎖定，無法再次送出。請請管理員解鎖。", "SCORE_LOCKED");
    }
    var configRevision = Number(scoreConfig.revision) || 1;
    var signature = ruleSignatureOf(section, configRevision);
    var revision = prev ? Number(prev.revision || 1) + 1 : 1;
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
        ruleSignature: signature
      },
      status: "submitted",
      revision: revision,
      submitted_at: new Date().toISOString()
    };
    var row = prev
      ? await pb().collection(C().scores).update(prev.id, payload)
      : await pb().collection(C().scores).create(payload);
    var record = recordFromRow(row, club, section, scoreConfig);
    return ok({
      record: record,
      locked: true,
      submissionRevision: revision,
      scores: scores
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
      if (msg === "JUDGE_UNAUTHORIZED" || /unauth|auth/i.test(msg)) {
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
      user.value = "judge.demo@hksp.local";
      user.placeholder = "judge.demo@hksp.local";
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
