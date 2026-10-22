/**
 * Same-page student Auth for index.html platform card.
 * Reuses Firebase Auth + asia-east1 callables from student.html (no parallel account logic).
 *
 * createStudentAccessFence / createRequireStudentAccess are exported for Node behavioral tests.
 * studentAccessRequestSeq is independent of refreshAccess's accessRequestSeq.
 */
function createStudentAccessFence() {
  var accessAuthGeneration = 0;
  var studentAccessRequestSeq = 0;
  return {
    getAuthGeneration: function () {
      return accessAuthGeneration;
    },
    getRequestSeq: function () {
      return studentAccessRequestSeq;
    },
    /** Logout / auth-state change: invalidate in-flight requireStudentAccess. */
    bumpAuthGeneration: function () {
      accessAuthGeneration += 1;
      studentAccessRequestSeq += 1;
    },
    beginRequest: function (expectedUid) {
      var seq = (studentAccessRequestSeq += 1);
      return {
        seq: seq,
        gen: accessAuthGeneration,
        expectedUid: expectedUid || null
      };
    },
    isStale: function (token, currentUid) {
      if (!token) return true;
      if (token.seq !== studentAccessRequestSeq) return true;
      if (token.gen !== accessAuthGeneration) return true;
      if (!currentUid || !token.expectedUid || currentUid !== token.expectedUid) {
        return true;
      }
      return false;
    }
  };
}

function createRequireStudentAccess(deps) {
  var fence = deps.fence;
  var call = deps.call;
  var getCurrentUser = deps.getCurrentUser;
  return function requireStudentAccess() {
    var user = getCurrentUser();
    if (!user) {
      return Promise.resolve({
        allowed: false,
        code: "UNAUTHENTICATED",
        message: "請先在首頁登入社團學生帳號。"
      });
    }
    var token = fence.beginRequest(user.uid);
    return call("getClubStudentAccessState")
      .then(function (res) {
        var current = getCurrentUser();
        var currentUid = current && current.uid;
        if (fence.isStale(token, currentUid)) {
          return {
            allowed: false,
            code: "AUTH_CHANGED",
            stale: true,
            reason: "superseded_or_auth_changed",
            message: "登入狀態已變更，請重新確認。"
          };
        }
        var data = (res && res.data) || {};
        if (data.status === "disabled") {
          return {
            allowed: false,
            code: "STUDENT_DISABLED",
            message: "帳號已停用。"
          };
        }
        if (data.mustChangePassword) {
          return {
            allowed: false,
            code: "MUST_CHANGE_PASSWORD",
            message: "請先完成強制改密。"
          };
        }
        if (!data.access || !data.access.allowed) {
          return {
            allowed: false,
            code: (data.access && data.access.code) || "DENIED",
            message:
              (data.access && data.access.message) || "尚無合法社團活動帳號。"
          };
        }
        current = getCurrentUser();
        currentUid = current && current.uid;
        if (fence.isStale(token, currentUid)) {
          return {
            allowed: false,
            code: "AUTH_CHANGED",
            stale: true,
            reason: "superseded_before_apply",
            message: "登入狀態已變更，請重新確認。"
          };
        }
        return {
          allowed: true,
          uid: token.expectedUid,
          activityId: data.activityId,
          permanentClubId: data.permanentClubId,
          clubName: data.clubName,
          status: data.status
        };
      })
      .catch(function (error) {
        var current = getCurrentUser();
        var currentUid = current && current.uid;
        if (fence.isStale(token, currentUid)) {
          return {
            allowed: false,
            code: "AUTH_CHANGED",
            stale: true,
            reason: "superseded_rejection",
            message: "登入狀態已變更，請重新確認。"
          };
        }
        return {
          allowed: false,
          code: "ACCESS_CHECK_FAILED",
          message:
            (error && error.message) || "無法完成學生權限檢查，請稍後再試。"
        };
      });
  };
}

(function () {
  "use strict";

  if (typeof window === "undefined") return;

  var client = window.HKSP_FIREBASE_CLIENT;
  if (!client) {
    var statusEl = document.getElementById("status");
    if (statusEl) statusEl.textContent = "缺少 firebase-client.js";
    return;
  }
  if (typeof firebase === "undefined") return;

  var app = firebase.apps && firebase.apps.length
    ? firebase.app()
    : firebase.initializeApp(client.config);
  var auth = firebase.auth();
  var functions = firebase.app().functions("asia-east1");
  var usingEmulator = client.connectEmulatorsIfNeeded(auth, functions, null);

  var envMeta = document.getElementById("envMeta");
  if (envMeta) {
    envMeta.textContent =
      (usingEmulator ? "本機 Emulator 驗證環境" : "正式／本機畫面") +
      " · 身分以伺服器確認為準";
  }

  var pendingClientRequestId = null;
  var pendingOpId = null;
  var lastNewPasswordForReconcile = null;
  var pendingRegisterAfterLogin = null;
  var busy = false;
  var accessRequestSeq = 0;
  var accessAuthGeneration = 0;
  var studentAccessFence = createStudentAccessFence();
  var requireStudentAccess = null;

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text, kind) {
    var el = $("status");
    if (!el) return;
    el.className = "msg" + (kind ? " " + kind : "");
    el.textContent = String(text || "");
  }

  function setBusy(flag) {
    busy = !!flag;
    ["btnLogin", "btnRegister", "btnChangePassword"].forEach(function (id) {
      var btn = $(id);
      if (btn) btn.disabled = busy;
    });
  }

  function safeError(error) {
    var code = (error && (error.code || (error.details && error.details.code))) || "";
    var message = (error && error.message) || "操作失敗";
    message = String(message).replace(/\b\d{8}\b/g, "[已隱藏]");
    return (code ? code + "：" : "") + message;
  }

  function showTab(name) {
    ["login", "register", "forgot"].forEach(function (tab) {
      var panel = $("panel-" + tab);
      if (panel) panel.classList.toggle("active", tab === name);
    });
    var title = $("authCardTitle");
    var sub = $("authCardSub");
    if (name === "register") {
      if (title) title.textContent = "立即註冊";
      if (sub) sub.textContent = "選擇社團、學號與生日完成註冊（社團選單不授予登入權限）";
    } else {
      if (title) title.textContent = "登入平台";
      if (sub) sub.textContent = "學生與社團幹部專屬入口";
    }
  }

  function setShell(mode) {
    var authShell = $("authShell");
    var change = $("changePasswordShell");
    var home = $("homeShell");
    if (authShell) authShell.classList.toggle("hidden", mode !== "auth");
    if (change) change.classList.toggle("hidden", mode !== "change");
    if (home) home.classList.toggle("hidden", mode !== "home");
  }

  function call(name, data) {
    return functions.httpsCallable(name)(data || {});
  }

  requireStudentAccess = createRequireStudentAccess({
    fence: studentAccessFence,
    call: call,
    getCurrentUser: function () {
      return auth.currentUser;
    }
  });

  function loadClubs() {
    var select = $("regClub");
    if (!select) return Promise.resolve();
    return call("listActiveClubsForRegistration")
      .then(function (res) {
        var clubs = (res.data && res.data.clubs) || [];
        select.innerHTML = "";
        if (!clubs.length) {
          select.innerHTML = "<option value=\"\">目前沒有可註冊社團</option>";
          return;
        }
        select.appendChild(new Option("請選擇社團", ""));
        clubs.forEach(function (club) {
          select.appendChild(
            new Option(
              club.clubName + "（" + club.permanentClubId + "）",
              club.permanentClubId
            )
          );
        });
      })
      .catch(function (error) {
        select.innerHTML = "<option value=\"\">社團名單載入失敗</option>";
        setStatus(safeError(error), "error");
      });
  }

  function loadForgot() {
    var box = $("forgotBox");
    if (!box) return Promise.resolve();
    return call("getClubStudentForgotPasswordContact")
      .then(function (res) {
        var data = res.data || {};
        if (data.source === "default" || !data.channel) {
          box.className = "msg warn";
          box.textContent =
            (data.title || "聯絡學生議會") +
            "\n" +
            (data.message || "請聯絡學生議會協助重設密碼。") +
            "\n\n正式聯絡方式：待設定（上線前待填，系統未編造聯絡管道）。";
        } else {
          box.className = "msg";
          box.textContent =
            (data.title || "聯絡學生議會") +
            "\n" +
            (data.message || "") +
            "\n聯絡方式：" +
            data.channel;
        }
      })
      .catch(function (error) {
        box.className = "msg warn";
        box.textContent = "正式聯絡方式：待設定。\n（" + safeError(error) + "）";
      });
  }

  function isStaleAccessResponse(seq, gen, expectedUid) {
    if (seq !== accessRequestSeq) return true;
    if (gen !== accessAuthGeneration) return true;
    var user = auth.currentUser;
    if (!user || !expectedUid || user.uid !== expectedUid) return true;
    return false;
  }

  function refreshAccess() {
    var user = auth.currentUser;
    if (!user) {
      setShell("auth");
      return Promise.resolve(null);
    }
    var seq = (accessRequestSeq += 1);
    var gen = accessAuthGeneration;
    var expectedUid = user.uid;
    return call("getClubStudentAccessState").then(function (res) {
      if (isStaleAccessResponse(seq, gen, expectedUid)) {
        return { stale: true, reason: "superseded_or_auth_changed" };
      }
      var data = res.data || {};
      var bar = $("sessionBar");
      if (bar) {
        bar.classList.remove("hidden");
      }
      if (data.status === "disabled") {
        setShell("auth");
        showTab("login");
        if (bar) {
          bar.className = "msg error";
          bar.textContent = "帳號已停用，無法使用正式功能。請聯絡管理員／帳號協助窗口。";
        }
        setStatus("帳號已停用，無法使用正式功能。", "error");
        return auth.signOut().then(function () {
          return data;
        });
      }
      if (data.mustChangePassword) {
        setShell("change");
        if (bar) {
          bar.className = "msg warn";
          bar.textContent = "首次登入：請先完成修改密碼（正式功能已鎖定）。";
        }
        setStatus("首次登入：請先完成修改密碼。", "warn");
        return data;
      }
      if (!data.access || !data.access.allowed) {
        setShell("auth");
        showTab("login");
        var msg =
          (data.access && data.access.message) || "尚無合法社團活動帳號。";
        if (bar) {
          bar.className = "msg error";
          bar.textContent = msg;
        }
        setStatus(msg, "error");
        return data;
      }
      if (isStaleAccessResponse(seq, gen, expectedUid)) {
        return { stale: true, reason: "superseded_before_apply" };
      }
      setShell("home");
      if (bar) {
        bar.className = "msg ok";
        bar.textContent = "伺服器已確認可使用正式功能。";
      }
      setStatus("登入成功", "ok");
      if ($("homeStatus")) $("homeStatus").textContent = "登入成功。";
      var clubLabel = data.clubName
        ? data.clubName + "（" + (data.permanentClubId || "") + "）"
        : data.permanentClubId || "（無）";
      if ($("homeIdentity")) {
        $("homeIdentity").textContent =
          "活動：" +
          (data.activityId || "（伺服器確認）") +
          "\n社團：" +
          clubLabel +
          "\n帳號狀態：" +
          (data.status || "（未知）");
      }
      return data;
    });
  }

  function errorCode(error) {
    return (error && ((error.details && error.details.code) || error.code)) || "";
  }

  function continueRegisterWhileSignedIn() {
    if (!pendingRegisterAfterLogin || !auth.currentUser) return Promise.resolve();
    var payload = pendingRegisterAfterLogin;
    setStatus("已登入既有帳號，正在為本活動完成註冊…", "warn");
    return call("registerClubStudent", payload).then(function () {
      pendingRegisterAfterLogin = null;
      pendingClientRequestId = null;
      pendingOpId = null;
      setStatus("本活動註冊完成。", "ok");
      return refreshAccess();
    });
  }

  function showRetryCleanup(show) {
    var btn = $("btnRetryCleanup");
    if (!btn) return;
    btn.style.display = show ? "inline" : "none";
    btn.classList.toggle("hidden", !show);
  }

  function bind(id, evt, fn) {
    var el = $(id);
    if (el) el.addEventListener(evt, fn);
  }

  bind("linkToRegister", "click", function () {
    showTab("register");
  });
  bind("linkToLogin", "click", function () {
    showTab("login");
  });
  bind("linkForgotToLogin", "click", function () {
    showTab("login");
  });
  bind("linkToForgot", "click", function () {
    if (client.openForgotPasswordAssist) {
      client.openForgotPasswordAssist();
    } else {
      window.open(
        client.FORGOT_PASSWORD_ASSIST_URL ||
          "https://www.instagram.com/bs_kai_0102/",
        "_blank",
        "noopener,noreferrer"
      );
    }
  });
  var forgotLabel = $("linkToForgot");
  if (forgotLabel && client.FORGOT_PASSWORD_ASSIST_LABEL) {
    forgotLabel.textContent = client.FORGOT_PASSWORD_ASSIST_LABEL;
  }

  bind("btnRegister", "click", function () {
    if (busy) return;
    var permanentClubId = $("regClub").value;
    var studentId = client.normalizeStudentId($("regStudentId").value);
    var birthYYYYMMDD = String($("regBirth").value || "").trim();
    if (!permanentClubId || !studentId || !/^\d{8}$/.test(birthYYYYMMDD)) {
      setStatus("請完整填寫社團、學號與生日。", "error");
      return;
    }
    pendingClientRequestId =
      pendingClientRequestId ||
      "web-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    setBusy(true);
    setStatus("註冊處理中…", "warn");
    showRetryCleanup(false);
    var registerPayload = {
      permanentClubId: permanentClubId,
      studentId: studentId,
      birthYYYYMMDD: birthYYYYMMDD,
      clientRequestId: pendingClientRequestId
    };
    call("registerClubStudent", registerPayload)
      .then(function (res) {
        var data = res.data || {};
        pendingOpId = data.opId || pendingOpId;
        $("regBirth").value = "";
        if (auth.currentUser) {
          pendingClientRequestId = null;
          pendingOpId = null;
          setStatus("註冊成功。", "ok");
          return refreshAccess();
        }
        setStatus("註冊成功，正在以學號與初始密碼登入…", "ok");
        return auth
          .signInWithEmailAndPassword(
            client.studentIdToAuthEmail(studentId),
            birthYYYYMMDD
          )
          .then(function () {
            pendingClientRequestId = null;
            pendingOpId = null;
            return refreshAccess();
          });
      })
      .catch(function (error) {
        var details = error && error.details;
        if (details && details.opId) pendingOpId = details.opId;
        var code = errorCode(error);
        if (
          code === "EXISTING_AUTH_REQUIRES_LOGIN" ||
          /先.*登入|既有帳號/.test(String((error && error.message) || ""))
        ) {
          pendingRegisterAfterLogin = {
            permanentClubId: permanentClubId,
            studentId: studentId,
            birthYYYYMMDD: birthYYYYMMDD,
            clientRequestId:
              pendingClientRequestId ||
              "web-" + Date.now() + "-" + Math.random().toString(16).slice(2)
          };
          pendingClientRequestId = pendingRegisterAfterLogin.clientRequestId;
          $("loginStudentId").value = studentId;
          showTab("login");
          setStatus(
            "此學號已有帳號。請先以目前密碼登入後，系統會自動完成本活動註冊（不會再用生日自動建檔）。",
            "warn"
          );
          showRetryCleanup(!!(pendingClientRequestId && pendingOpId));
          return;
        }
        showRetryCleanup(!!(pendingClientRequestId && pendingOpId));
        setStatus(
          safeError(error) +
            (pendingClientRequestId ? "\n可按下方清理後以新請求重試。" : ""),
          "error"
        );
      })
      .then(function () {
        setBusy(false);
      });
  });

  bind("btnRetryCleanup", "click", function () {
    if (!pendingClientRequestId || !pendingOpId || busy) return;
    setBusy(true);
    setStatus("正在清理本操作占用的名額／暫存帳號…", "warn");
    call("cleanupClubStudentRegistrationOp", {
      opId: pendingOpId,
      clientRequestId: pendingClientRequestId
    })
      .then(function () {
        pendingClientRequestId = null;
        pendingOpId = null;
        showRetryCleanup(false);
        setStatus("已清理未完成註冊。請再次註冊（將使用新的請求編號）。", "ok");
      })
      .catch(function (error) {
        setStatus(safeError(error), "error");
      })
      .then(function () {
        setBusy(false);
      });
  });

  bind("btnLogin", "click", function () {
    if (busy) return;
    var studentId = client.normalizeStudentId($("loginStudentId").value);
    var password = $("loginPassword").value;
    if (!studentId || !password) {
      setStatus("請輸入學號與密碼。", "error");
      return;
    }
    setBusy(true);
    setStatus("登入中…", "warn");
    auth
      .signInWithEmailAndPassword(client.studentIdToAuthEmail(studentId), password)
      .then(function () {
        $("loginPassword").value = "";
        if (
          pendingRegisterAfterLogin &&
          client.normalizeStudentId(pendingRegisterAfterLogin.studentId) ===
            studentId
        ) {
          return continueRegisterWhileSignedIn();
        }
        return refreshAccess();
      })
      .catch(function (error) {
        setStatus(safeError(error), "error");
      })
      .then(function () {
        setBusy(false);
      });
  });

  function tryReconcilePassword() {
    if (!lastNewPasswordForReconcile) {
      setStatus("沒有可復原的改密狀態，請重新輸入新密碼後再試。", "warn");
      return Promise.resolve();
    }
    var btn = $("btnRetryReconcile");
    if (btn) btn.classList.remove("hidden");
    return call("reconcileClubStudentPasswordChange", {
      newPassword: lastNewPasswordForReconcile
    })
      .then(function () {
        lastNewPasswordForReconcile = null;
        if (btn) btn.classList.add("hidden");
        setStatus("改密狀態已復原。請以新密碼重新登入。", "ok");
        return auth.signOut().then(function () {
          setShell("auth");
          showTab("login");
        });
      })
      .catch(function (err2) {
        if (btn) btn.classList.remove("hidden");
        setStatus(
          "復原失敗：" + safeError(err2) + "\n可按「改密狀態復原重試」。",
          "error"
        );
      });
  }

  bind("btnChangePassword", "click", function () {
    if (busy) return;
    var currentPassword = $("curPassword").value;
    var newPassword = $("newPassword").value;
    var newPassword2 = $("newPassword2").value;
    if (!currentPassword || !newPassword) {
      setStatus("請輸入目前密碼與新密碼。", "error");
      return;
    }
    if (newPassword !== newPassword2) {
      setStatus("兩次新密碼不一致。", "error");
      return;
    }
    if (currentPassword === newPassword) {
      setStatus("新密碼不可與目前密碼相同。", "error");
      return;
    }
    setBusy(true);
    setStatus("改密處理中…", "warn");
    lastNewPasswordForReconcile = newPassword;
    call("changeClubStudentPassword", {
      currentPassword: currentPassword,
      newPassword: newPassword
    })
      .then(function () {
        $("curPassword").value = "";
        $("newPassword").value = "";
        $("newPassword2").value = "";
        lastNewPasswordForReconcile = null;
        var btn = $("btnRetryReconcile");
        if (btn) btn.classList.add("hidden");
        setStatus("改密完成。請以新密碼重新登入。", "ok");
        return auth.signOut().then(function () {
          setShell("auth");
          showTab("login");
        });
      })
      .catch(function (error) {
        var code = errorCode(error);
        if (
          code === "RECENT_AUTH_REQUIRED" ||
          /近期登入|登入時效/.test(String((error && error.message) || ""))
        ) {
          setStatus("登入時效不足。請重新登入後再改密。", "warn");
          return auth.signOut().then(function () {
            setShell("auth");
            showTab("login");
          });
        }
        if (code === "PASSWORD_STATE_UPDATE_FAILED" && lastNewPasswordForReconcile) {
          return tryReconcilePassword();
        }
        setStatus(safeError(error), "error");
      })
      .then(function () {
        setBusy(false);
      });
  });

  bind("btnRetryReconcile", "click", function () {
    if (busy) return;
    setBusy(true);
    tryReconcilePassword().then(function () {
      setBusy(false);
    });
  });

  bind("btnReloginForPassword", "click", function () {
    auth.signOut().then(function () {
      setShell("auth");
      showTab("login");
      setStatus("請重新登入後再進行改密。", "warn");
    });
  });

  function doLogout() {
    accessAuthGeneration += 1;
    accessRequestSeq += 1;
    studentAccessFence.bumpAuthGeneration();
    return auth.signOut().then(function () {
      setShell("auth");
      showTab("login");
      var bar = $("sessionBar");
      if (bar) bar.classList.add("hidden");
      setStatus("已登出。", "ok");
    });
  }
  bind("btnLogout", "click", doLogout);
  bind("btnLogoutFromChange", "click", doLogout);

  auth.onAuthStateChanged(function (user) {
    accessAuthGeneration += 1;
    studentAccessFence.bumpAuthGeneration();
    if (!user) {
      setShell("auth");
      return;
    }
    refreshAccess().catch(function (error) {
      setStatus(safeError(error), "error");
    });
  });

  window.HKSP_PLATFORM_AUTH = {
    showTab: showTab,
    focusLogin: function () {
      showTab("login");
      var card = $("authCard");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    refreshAccess: refreshAccess,
    getAuth: function () { return auth; },
    requireStudentAccess: requireStudentAccess
  };

  loadClubs();
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    createStudentAccessFence: createStudentAccessFence,
    createRequireStudentAccess: createRequireStudentAccess
  };
}