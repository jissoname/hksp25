/**
 * Platform homepage chrome + CS dock + same-page announcements for index.html.
 */
(function () {
  "use strict";

  var fab = document.getElementById("csFab");
  var panel = document.getElementById("csPanel");
  var closeBtn = document.getElementById("csClose");
  var newsListEl = document.getElementById("homeNewsList");
  var newsAllBtn = document.getElementById("btnNewsAll");
  var showAllNews = false;
  var expandedIds = Object.create(null);

  /** Single list for homepage announcements (append for 4th/5th later). */
  var HOME_ANNOUNCEMENTS = [
    {
      id: "eval-submit",
      category: "評選",
      tagClass: "t1",
      title: "社團評選資料繳交提醒",
      summary: "請依公告期限完成資料繳交與相關表單填寫。",
      bodyLines: function (ctx) {
        return [
          "資料繳交截止：" + ctx.dataDeadline,
          "表單填寫截止：" + ctx.formDeadline,
          "請確認本次活動的社團資料，相關表單可由首頁「相關表單」入口開啟。"
        ];
      }
    },
    {
      id: "event-schedule",
      category: "活動",
      tagClass: "t2",
      title: "評選暨社團觀摩時程",
      summary: "查看評選時間、觀摩時段與活動地點。",
      bodyLines: function (ctx) {
        return [
          "活動日期及評選起訖時間：" + ctx.eventTimeRange,
          "社團觀摩時間：" + ctx.observationWindow,
          "活動地點：" + ctx.venueName + "。"
        ];
      }
    },
    {
      id: "student-account",
      category: "服務",
      tagClass: "t3",
      title: "學生帳號註冊與密碼協助",
      summary: "首次使用請先註冊，登入後依提示修改密碼。",
      bodyLines: function () {
        return [
          "註冊時選擇社團，填寫學號與西元生日。",
          "學號為登入帳號，生日 YYYYMMDD 為初始密碼。",
          "首次登入須完成修改密碼。",
          "忘記密碼請使用登入卡的聯絡入口，核對身分後由有權限管理員協助重設。"
        ];
      }
    }
  ];

  function openCs(optionalTag) {
    if (!panel) return;
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    // 標記開啟狀態以隱藏 FAB；不鎖 body 捲動、不加全頁遮罩
    document.body.classList.add("cs-open");
    if (fab) fab.setAttribute("aria-expanded", "true");
    if (optionalTag && typeof window.clickQuickTag === "function") {
      setTimeout(function () {
        window.clickQuickTag(optionalTag);
      }, 80);
    }
  }

  function closeCs() {
    if (!panel) return;
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("cs-open");
    if (fab) fab.setAttribute("aria-expanded", "false");
  }

  function toggleCs() {
    if (panel && panel.classList.contains("open")) closeCs();
    else openCs();
  }

  if (fab) fab.addEventListener("click", function () { toggleCs(); });
  if (closeBtn) closeBtn.addEventListener("click", closeCs);

  document.querySelectorAll("[data-cs-tag]").forEach(function (el) {
    el.addEventListener("click", function () {
      openCs(el.getAttribute("data-cs-tag"));
    });
  });

  function openAccountAssist() {
    var client = window.HKSP_FIREBASE_CLIENT;
    if (client && typeof client.openForgotPasswordAssist === "function") {
      client.openForgotPasswordAssist();
      return;
    }
    openCs("聯絡帳號協助");
  }

  document.querySelectorAll("[data-home-action]").forEach(function (el) {
    el.addEventListener("click", function () {
      var action = el.getAttribute("data-home-action");
      if (action === "account-assist") openAccountAssist();
    });
  });

  var navLogin = document.getElementById("navLoginBtn");
  if (navLogin) {
    navLogin.addEventListener("click", function () {
      if (window.HKSP_PLATFORM_AUTH) window.HKSP_PLATFORM_AUTH.focusLogin();
      else {
        var card = document.getElementById("authCard");
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }

  function bindClick(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("click", fn);
  }

  bindClick("btnFooterContact", function () { openAccountAssist(); });

  function escapeHtml(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatDeadline(value) {
    if (typeof window.formatTaipeiDateTime === "function") {
      return window.formatTaipeiDateTime(value);
    }
    try {
      return new Intl.DateTimeFormat("zh-TW", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date(value));
    } catch (e) {
      return String(value || "-");
    }
  }

  function formatEventTimeRange(config) {
    if (
      typeof window.formatTaipeiDate === "function" &&
      typeof window.formatTaipeiTime === "function"
    ) {
      return (
        window.formatTaipeiDate(config.eventStart) +
        "，" +
        window.formatTaipeiTime(config.eventStart) +
        "–" +
        window.formatTaipeiTime(config.eventEnd)
      );
    }
    return "請見首頁活動時間資訊卡";
  }

  function announcementContext() {
    var config =
      (window.APP_STATE && window.APP_STATE.eventConfig) ||
      window.FALLBACK_EVENT_CONFIG ||
      {};
    var facts = window.HOME_EVENT_FACTS || {
      venueName: "毓麟館",
      observationWindow: "16:30–16:50"
    };
    return {
      dataDeadline: formatDeadline(config.dataDeadline),
      formDeadline: formatDeadline(config.formDeadline),
      eventTimeRange: formatEventTimeRange(config),
      observationWindow: facts.observationWindow || "16:30–16:50",
      venueName: facts.venueName || "毓麟館"
    };
  }

  function visibleAnnouncements() {
    if (showAllNews) return HOME_ANNOUNCEMENTS.slice();
    return HOME_ANNOUNCEMENTS.slice(0, 3);
  }

  function renderAnnouncements() {
    if (!newsListEl) return;
    var ctx = announcementContext();
    var rows = visibleAnnouncements();
    newsListEl.classList.toggle("news-list-expanded", !!showAllNews);
    newsListEl.innerHTML = rows
      .map(function (item) {
        var open = !!expandedIds[item.id];
        var bodyId = "news-body-" + item.id;
        var lines = item.bodyLines(ctx) || [];
        return (
          '<article class="news-item" role="listitem" data-news-id="' +
          escapeHtml(item.id) +
          '">' +
          '<span class="news-tag ' +
          escapeHtml(item.tagClass) +
          '">' +
          escapeHtml(item.category) +
          "</span>" +
          '<button type="button" class="news-item-title" aria-expanded="' +
          (open ? "true" : "false") +
          '" aria-controls="' +
          bodyId +
          '" data-news-toggle="' +
          escapeHtml(item.id) +
          '">' +
          escapeHtml(item.title) +
          "</button>" +
          '<p class="news-item-summary">' +
          escapeHtml(item.summary) +
          "</p>" +
          '<div id="' +
          bodyId +
          '" class="news-item-body"' +
          (open ? "" : " hidden") +
          ">" +
          "<ul>" +
          lines
            .map(function (line) {
              return "<li>" + escapeHtml(line) + "</li>";
            })
            .join("") +
          "</ul></div></article>"
        );
      })
      .join("");

    if (newsAllBtn) {
      newsAllBtn.setAttribute("aria-expanded", showAllNews ? "true" : "false");
      newsAllBtn.textContent = showAllNews ? "收合" : "查看全部";
    }
  }

  function refreshAnnouncementBodies() {
    if (!newsListEl) return;
    var ctx = announcementContext();
    HOME_ANNOUNCEMENTS.forEach(function (item) {
      var body = document.getElementById("news-body-" + item.id);
      if (!body) return;
      var lines = item.bodyLines(ctx) || [];
      body.innerHTML =
        "<ul>" +
        lines
          .map(function (line) {
            return "<li>" + escapeHtml(line) + "</li>";
          })
          .join("") +
        "</ul>";
    });
  }

  if (newsListEl) {
    newsListEl.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-news-toggle]");
      if (!btn || !newsListEl.contains(btn)) return;
      var id = btn.getAttribute("data-news-toggle");
      if (!id) return;
      expandedIds[id] = !expandedIds[id];
      var body = document.getElementById("news-body-" + id);
      if (body) {
        if (expandedIds[id]) body.removeAttribute("hidden");
        else body.setAttribute("hidden", "");
      }
      btn.setAttribute("aria-expanded", expandedIds[id] ? "true" : "false");
    });
  }

  if (newsAllBtn) {
    newsAllBtn.addEventListener("click", function () {
      showAllNews = !showAllNews;
      renderAnnouncements();
      if (showAllNews && newsListEl) {
        newsListEl.scrollTop = 0;
      }
    });
  }

  function bootstrapHomeFacts() {
    var facts = window.HOME_EVENT_FACTS || {
      venueName: "毓麟館",
      observationWindow: "16:30–16:50"
    };
    var venueEl = document.getElementById("homeInfoVenue");
    var obsEl = document.getElementById("homeInfoObservation");
    if (venueEl) venueEl.textContent = facts.venueName || "毓麟館";
    if (obsEl) obsEl.textContent = facts.observationWindow || "16:30–16:50";
    renderAnnouncements();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrapHomeFacts);
  } else {
    bootstrapHomeFacts();
  }

  var announcementSnapshot = null;

  window.HKSP_PLATFORM_HOME = {
    openCs: openCs,
    closeCs: closeCs,
    refreshAnnouncementBodies: refreshAnnouncementBodies,
    renderAnnouncements: renderAnnouncements,
    /** Test-only: append temporary items; always pair with __restoreAnnouncementsForTest. */
    __appendAnnouncementsForTest: function (extra) {
      if (!announcementSnapshot) {
        announcementSnapshot = HOME_ANNOUNCEMENTS.slice();
      }
      (Array.isArray(extra) ? extra : []).forEach(function (item) {
        HOME_ANNOUNCEMENTS.push(item);
      });
      renderAnnouncements();
    },
    __restoreAnnouncementsForTest: function () {
      if (announcementSnapshot) {
        HOME_ANNOUNCEMENTS.length = 0;
        announcementSnapshot.forEach(function (item) {
          HOME_ANNOUNCEMENTS.push(item);
        });
        announcementSnapshot = null;
      }
      showAllNews = false;
      expandedIds = Object.create(null);
      renderAnnouncements();
    },
    __getAnnouncementCountForTest: function () {
      return HOME_ANNOUNCEMENTS.length;
    },
    __setShowAllForTest: function (v) {
      showAllNews = !!v;
      renderAnnouncements();
    }
  };
})();
