"use strict";

(function (root) {
  var editSnapshot = null;

  function enabled() {
    return new URLSearchParams(root.location.search).get("cloud") === "1";
  }

  function $(id) { return document.getElementById(id); }

  async function request(payload) {
    if (!root.HKSP_CLOUD_API) throw new Error("Firebase 雲端入口尚未載入，請重新整理。");
    var capturedToken = String(payload.sessionToken || "");
    var data = Object.assign({}, payload);
    if (data.action === "adminSetCloudLink" || data.action === "adminClearCloudLink") {
      var row = (root.S.clouds || []).find(function (item) { return item.club === data.clubName; });
      if (!row || !Number.isSafeInteger(row.version)) throw new Error("請先重新讀取社團資料夾清單。");
      data.permanentClubId = row.permanentClubId;
      data.expectedVersion = row.version;
    }
    var result = await root.HKSP_CLOUD_API.adminRequest(data);
    if (capturedToken && capturedToken !== String(root.S.token || "")) {
      return { success: false, error: "ADMIN_RESPONSE_STALE", message: "登入狀態已變更，請重新操作。" };
    }
    return result;
  }

  function configureUi() {
    if (!enabled()) return;
    document.documentElement.classList.add("firebase-cloud-admin");
    if (!$("firebaseCloudAdminStyle")) {
      var style = document.createElement("style");
      style.id = "firebaseCloudAdminStyle";
      style.textContent = '.firebase-cloud-admin .panel[hidden],.firebase-cloud-admin .stat[hidden],.firebase-cloud-admin #clubList button[onclick*="deleteClub"]{display:none!important}';
      document.head.append(style);
    }
    document.querySelectorAll(".panel").forEach(function (panel) {
      if (!panel.querySelector("#clubList,#clubStudentList,#cloudList,#eventMeta,#cloudUploadMeta")) panel.hidden = true;
    });
    document.querySelectorAll(".stat").forEach(function (stat) {
      if (!stat.querySelector("#statClubs")) stat.hidden = true;
    });
    document.querySelectorAll('button[onclick*="deleteClub"],button[onclick="openClubModal()"],button[onclick*="previewHandover"],button[onclick*="executeHandover"]').forEach(function (button) {
      button.disabled = true;
    });
    var title = document.querySelector(".hero h1");
    if (title) title.textContent = "社團與雲端管理";
    var subtitle = document.querySelector(".hero .sub");
    if (subtitle) subtitle.textContent = "參與項目、學生帳號、資料夾、上傳期限與補交";
    var box = $("clubCloudFolderField");
    if (box) box.hidden = false;
    ["eval", "feature"].forEach(function (prefix) {
      var input = $(prefix + "MakeupClubs");
      if (input) input.readOnly = true;
    });
    var meta = $("cloudUploadMeta");
    if (meta) {
      var note = document.createElement("div");
      note.className = "notice";
      note.textContent = "截止與補交皆以台灣時間設定，所選分鐘仍可繳交，下一分鐘起關閉。";
      meta.closest(".panel").querySelector(".panel-body").prepend(note);
    }
  }

  function prepareClubEdit(club, row) {
    if (!enabled()) return;
    $("clubName").readOnly = true;
    $("clubCategory").disabled = true;
    editSnapshot = row ? Object.assign({}, row) : null;
    $("clubEvaluationFolderUrl").value = row && row.evaluationFolderUrl || "";
    $("clubSaveBtn").disabled = !club || !editSnapshot;
    if (!editSnapshot) $("clubError").textContent = "請先載入社團雲端狀態，再編輯設定。";
  }

  async function saveClub() {
    var state = root.S;
    if (state.clubSaveBusy) return;
    if (!editSnapshot) { $("clubError").textContent = "請先讀取社團設定。"; return; }
    var target = editSnapshot;
    var token = String(state.token || "");
    var sequence = ++state.clubSaveSeq;
    state.clubSaveBusy = true;
    $("clubSaveBtn").disabled = true;
    $("clubError").textContent = "";
    try {
      var result = await root.api("adminSaveClubCloudConfiguration", {
        permanentClubId: target.permanentClubId,
        participation: $("clubParticipation").value,
        url: $("clubEvaluationFolderUrl").value.trim(),
        expectedParticipationVersion: target.participationVersion,
        expectedLinkVersion: target.linkVersion
      });
      if (sequence !== state.clubSaveSeq || token !== String(state.token || "") || editSnapshot !== target) return;
      if (root.unauthorized(result)) return;
      if (!result || result.success !== true) throw new Error(result && result.message || "儲存失敗，請重新讀取確認。");
      root.closeModal("clubModal");
      root.toast("社團雲端設定已儲存");
      // Narrow local patch only — do not reload all panels / full club directory.
      var participation = String($("clubParticipation").value || "");
      var url = String($("clubEvaluationFolderUrl").value || "").trim();
      var id = String(target.permanentClubId || "").trim().toUpperCase();
      if (id && state.cloudClubRowsById && state.cloudClubRowsById[id]) {
        var row = state.cloudClubRowsById[id];
        var nextPart = participation;
        var parsed = nextPart === "both" || nextPart === "兩項皆參加"
          ? { evaluation: true, feature: true, participation: "both" }
          : nextPart === "feature" || nextPart === "特色"
            ? { evaluation: false, feature: true, participation: "feature" }
            : nextPart === "evaluation" || nextPart === "評選"
              ? { evaluation: true, feature: false, participation: "evaluation" }
              : null;
        if (parsed) {
          row.participation = parsed.participation;
          row.evaluation = parsed.evaluation;
          row.feature = parsed.feature;
          row.participationLabel = parsed.evaluation && parsed.feature
            ? "兩項皆參加"
            : parsed.feature ? "特色" : "評選";
          row.participationVersion = Number(target.participationVersion || 0) + 1;
        }
        if (url !== String(target.evaluationFolderUrl || "")) {
          row.evaluationFolderUrl = url;
          row.evaluationFolderConfigured = !!url;
          row.linkVersion = Number(target.linkVersion || 0) + 1;
        }
        editSnapshot = Object.assign({}, row);
      }
      if (typeof root.renderClouds === "function") root.renderClouds();
      if (typeof root.HKSP_ADMIN_CLOUD.renderMakeupChoices === "function") {
        root.HKSP_ADMIN_CLOUD.renderMakeupChoices();
      }
    } catch (error) {
      if (sequence === state.clubSaveSeq && token === String(state.token || "") && editSnapshot === target) {
        $("clubError").textContent = error.message;
      }
    } finally {
      if (sequence === state.clubSaveSeq) {
        state.clubSaveBusy = false;
        $("clubSaveBtn").disabled = !editSnapshot;
      }
    }
  }

  function renderMakeupChoices() {
    if (!enabled()) return;
    var state = root.S;
    ["evaluation", "feature"].forEach(function (kind) {
      var prefix = kind === "evaluation" ? "eval" : "feature";
      var input = $(prefix + "MakeupClubs");
      if (!input) return;
      var id = prefix + "MakeupPicker";
      var picker = $(id);
      if (!picker) {
        picker = document.createElement("details");
        picker.id = id;
        input.after(picker);
      }
      picker.replaceChildren();
      var selected = new Set(root.parseClubIdList(input.value));
      var summary = document.createElement("summary");
      summary.textContent = "選擇補交社團（已選 " + selected.size + "）";
      picker.append(summary);
      var choices = [];
      var buttons = document.createElement("div");
      buttons.className = "toolbar";
      function syncInput() {
        var ids = choices.filter(function (choice) { return choice.box.checked; }).map(function (choice) { return choice.id; });
        input.value = ids.join(",");
        summary.textContent = "選擇補交社團（已選 " + ids.length + "）";
      }
      [["全選符合資格社團", true], ["清空選取", false]].forEach(function (item) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "btn";
        button.textContent = item[0];
        button.addEventListener("click", function () {
          choices.forEach(function (choice) { choice.box.checked = item[1] && choice.eligible; });
          syncInput();
        });
        buttons.append(button);
      });
      picker.append(buttons);
      var rows = (state.cloudClubRows || []).slice();
      selected.forEach(function (clubId) {
        if (!rows.some(function (row) { return row.permanentClubId === clubId; })) {
          rows.push({ permanentClubId: clubId, clubName: clubId, active: false });
        }
      });
      rows.forEach(function (row) {
        var eligible = row.active !== false && row[kind] === true;
        if (!eligible && !selected.has(row.permanentClubId)) return;
        var label = document.createElement("label");
        label.style.display = "block";
        var checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(row.permanentClubId);
        checkbox.addEventListener("change", syncInput);
        label.append(checkbox, document.createTextNode(" " + row.clubName + "（" + row.permanentClubId + "）" + (eligible ? "" : "，目前無本項資格")));
        choices.push({ id: row.permanentClubId, box: checkbox, eligible: eligible });
        picker.append(label);
      });
    });
  }

  root.HKSP_ADMIN_CLOUD = {
    enabled: enabled, request: request, configureUi: configureUi,
    prepareClubEdit: prepareClubEdit, saveClub: saveClub, renderMakeupChoices: renderMakeupChoices
  };
  document.addEventListener("DOMContentLoaded", configureUi);
})(window);
