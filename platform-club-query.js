/**
 * 登入後的「社團帳號查詢」。
 * 重新確認權限、Auth 狀態變更，都會使先前的查詢失效。
 * 成功與失敗都核對登入世代、查詢序號，以及發出時的活動／社團範圍。
 */
function createClubQueryController(options) {
  var doc = options.document;
  var call = options.call;
  var getUid = options.getUid;
  var authGeneration = 0;
  var probeSeq = 0;
  var querySeq = 0;
  var serverScope = null;

  function $(id) {
    return doc.getElementById(id);
  }

  function setStatus(text, kind) {
    var el = $("clubQueryStatus");
    if (!el) return;
    el.className = "msg" + (kind ? " " + kind : "");
    el.textContent = String(text || "").replace(/\b\d{8}\b/g, "[已隱藏]");
  }

  function clearList() {
    var list = $("clubQueryList");
    if (list) list.innerHTML = "";
  }

  function hide() {
    var section = $("clubAccountQuery");
    if (section) section.classList.add("hidden");
    serverScope = null;
    clearList();
    setStatus("");
  }

  function scopeKey(scope) {
    if (!scope || !scope.activityId || !scope.permanentClubId) return "";
    return String(scope.activityId) + "|" + String(scope.permanentClubId);
  }

  function noteAuthChange() {
    authGeneration += 1;
    probeSeq += 1;
    querySeq += 1;
    hide();
  }

  function sameProbe(token) {
    if (!token) return false;
    if (token.seq !== probeSeq) return false;
    if (token.authGen !== authGeneration) return false;
    if (!token.uid || getUid() !== token.uid) return false;
    return true;
  }

  function sameQuery(token) {
    if (!token) return false;
    if (token.seq !== querySeq) return false;
    if (token.authGen !== authGeneration) return false;
    if (!token.uid || getUid() !== token.uid) return false;
    if (!token.scopeKey || token.scopeKey !== scopeKey(serverScope)) return false;
    return true;
  }

  function onAccess() {
    querySeq += 1;
    var token = {
      seq: (probeSeq += 1),
      authGen: authGeneration,
      uid: getUid() || ""
    };
    hide();
    if (!token.uid) return Promise.resolve({ stale: false, allowed: false });
    return Promise.resolve(call("getClubQueryAccess", {})).then(function (res) {
      if (!sameProbe(token)) return { stale: true };
      var data = res && res.data ? res.data : (res || {});
      if (!data.allowed || !data.activityId || !data.permanentClubId) {
        hide();
        return { stale: false, allowed: false };
      }
      serverScope = {
        activityId: String(data.activityId),
        permanentClubId: String(data.permanentClubId)
      };
      var section = $("clubAccountQuery");
      if (section) section.classList.remove("hidden");
      var ctx = $("clubQueryContext");
      if (ctx) {
        ctx.textContent = "活動 " + serverScope.activityId + "｜社團 " + serverScope.permanentClubId;
      }
      return { stale: false, allowed: true };
    }, function () {
      if (!sameProbe(token)) return { stale: true };
      hide();
      return { stale: false, allowed: false };
    });
  }

  function renderStudents(students) {
    var list = $("clubQueryList");
    if (!list) return;
    list.textContent = "";
    (students || []).forEach(function (row) {
      var item = doc.createElement("li");
      var primary = row.primaryAccount ? "主要帳號" : "非主要帳號";
      var passwordState = row.mustChangePassword ? "須改密" : "不必改密";
      item.textContent =
        String(row.studentId || "") +
        "｜帳號 " + String(row.accountStatus || "") +
        "｜membership " + String(row.membershipStatus || "") +
        "｜" + primary +
        "｜" + passwordState;
      list.appendChild(item);
    });
  }

  function runQuery() {
    var scope = serverScope;
    var token = {
      seq: (querySeq += 1),
      authGen: authGeneration,
      uid: getUid() || "",
      scopeKey: scopeKey(scope)
    };
    if (!token.uid || !token.scopeKey) return Promise.resolve({ stale: false, applied: false });
    clearList();
    setStatus("查詢中…");
    return Promise.resolve(call("queryClubStudentAccounts", {
      activityId: scope.activityId,
      permanentClubId: scope.permanentClubId
    })).then(function (res) {
      if (!sameQuery(token)) return { stale: true };
      var data = res && res.data ? res.data : (res || {});
      renderStudents(data.students || []);
      setStatus("已顯示本社團帳號狀態。", "ok");
      return { stale: false, applied: true };
    }, function (error) {
      if (!sameQuery(token)) return { stale: true };
      clearList();
      setStatus((error && error.message) || "目前不能查詢。", "error");
      return { stale: false, applied: true, error: true };
    });
  }

  return {
    onSignedOut: noteAuthChange,
    noteAuthChange: noteAuthChange,
    onAccess: onAccess,
    runQuery: runQuery
  };
}

function installClubQuery(options) {
  var controller = createClubQueryController(options);
  var auth = options.auth;
  if (auth && typeof auth.onAuthStateChanged === "function") {
    auth.onAuthStateChanged(function () {
      controller.noteAuthChange();
    });
  }
  var button = options.document && options.document.getElementById("btnClubQuery");
  if (button && typeof button.addEventListener === "function") {
    button.addEventListener("click", function () {
      controller.runQuery();
    });
  }
  return controller;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    createClubQueryController: createClubQueryController,
    installClubQuery: installClubQuery
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  window.HKSP_CLUB_QUERY = installClubQuery({
    document: document,
    auth: firebase.auth(),
    call: function (name, data) {
      return firebase.app().functions("asia-east1").httpsCallable(name)(data || {});
    },
    getUid: function () {
      try {
        var user = firebase.auth().currentUser;
        return user && user.uid ? user.uid : "";
      } catch (error) {
        return "";
      }
    }
  });
}
