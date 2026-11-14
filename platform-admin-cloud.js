"use strict";

(function (root) {
  var editSnapshot = null;

  function enabled() {
    return new URLSearchParams(root.location.search).get("cloud") === "1";
  }

  function $(id) { return document.getElementById(id); }

  function newClientRequestId_(prefix) {
    var base = String(prefix || "club") + "_" + Date.now().toString(36);
    if (root.crypto && typeof root.crypto.randomUUID === "function") {
      return base + "_" + root.crypto.randomUUID().replace(/-/g, "").slice(0, 20);
    }
    return base + "_" + Math.random().toString(36).slice(2, 12);
  }

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
      style.textContent = ".firebase-cloud-admin .panel[hidden],.firebase-cloud-admin .stat[hidden]{display:none!important}";
      document.head.append(style);
    }
    document.querySelectorAll(".panel").forEach(function (panel) {
      if (!panel.querySelector("#clubList,#clubStudentList,#cloudList,#eventMeta,#cloudUploadMeta")) panel.hidden = true;
    });
    document.querySelectorAll(".stat").forEach(function (stat) {
      if (!stat.querySelector("#statClubs")) stat.hidden = true;
    });
    document.querySelectorAll('button[onclick*="previewHandover"],button[onclick*="executeHandover"]').forEach(function (button) {
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
    var nameEl = $("clubName");
    var categoryEl = $("clubCategory");
    var urlEl = $("clubEvaluationFolderUrl");
    var partEl = $("clubParticipation");
    if (nameEl) nameEl.readOnly = false;
    if (categoryEl) categoryEl.disabled = false;
    var clubName = club ? String(club.name || club.clubName || "") : "";
    if (club && nameEl && !String(nameEl.value || "").trim()) {
      nameEl.value = clubName || String((row && row.clubName) || "");
    }
    var cloudReady = !!(row && row.permanentClubId);
    editSnapshot = {
      club: club
        ? Object.assign({}, club, {
            permanentClubId: String(club.permanentClubId || (row && row.permanentClubId) || "").trim().toUpperCase(),
            name: clubName || String((row && row.clubName) || ""),
            category: club.category || (row && row.category) || "",
            version: club.version != null ? club.version : (row && row.version),
            sortOrder: club.sortOrder
          })
        : null,
      cloud: cloudReady ? Object.assign({}, row) : null,
      cloudReady: cloudReady
    };
    if (urlEl) {
      urlEl.value = cloudReady ? String(row.evaluationFolderUrl || "") : "";
      urlEl.readOnly = !!(club && !cloudReady);
    }
    if (partEl) {
      if (cloudReady) {
        partEl.value = row.participation ? String(row.participation) : String(partEl.value || "");
      }
      partEl.disabled = !!(club && !cloudReady);
    }
    $("clubSaveBtn").disabled = false;
    if (club && !cloudReady) {
      var loadState = String((root.S && root.S.cloudClubRowsStatus) || "");
      $("clubError").textContent = loadState === "error"
        ? ("雲端狀態讀取失敗，不能把空白當成未綁定。可改名／改屬性；參與與資料夾請先「重新載入社團雲端狀態」再存。" +
          (root.S.cloudClubRowsError ? "（" + root.S.cloudClubRowsError + "）" : ""))
        : "尚未確認雲端狀態快照；可改名／改屬性，但禁止送出參與／資料夾變更。請先重新載入雲端狀態。";
    } else {
      $("clubError").textContent = "";
    }
  }

  function findClubForEdit_(oldName) {
    var name = String(oldName || "").trim();
    var clubs = Array.isArray(root.S.clubs) ? root.S.clubs : [];
    var snapshotId = "";
    if (editSnapshot && editSnapshot.club && editSnapshot.club.permanentClubId) {
      snapshotId = String(editSnapshot.club.permanentClubId).trim().toUpperCase();
    } else if (editSnapshot && editSnapshot.cloud && editSnapshot.cloud.permanentClubId) {
      snapshotId = String(editSnapshot.cloud.permanentClubId).trim().toUpperCase();
    }
    if (snapshotId) {
      var byId = clubs.find(function (row) {
        return String(row.permanentClubId || "").trim().toUpperCase() === snapshotId;
      });
      if (byId) return byId;
      if (editSnapshot && editSnapshot.club) {
        return Object.assign({}, editSnapshot.club, { permanentClubId: snapshotId });
      }
    }
    return clubs.find(function (row) { return String(row.name || "") === name; }) || null;
  }

  function patchLocalClubAfterSave_(saved, clubName, category) {
    var state = root.S;
    var id = String((saved && saved.permanentClubId) || "").trim().toUpperCase();
    if (!id) return;
    var patch = {
      permanentClubId: id,
      name: clubName,
      clubName: clubName,
      category: category,
      active: saved.active !== false,
      version: saved.version != null ? Number(saved.version) : undefined,
      legacyClubId: saved.legacyClubId || "",
      sortOrder: saved.sortOrder != null ? Number(saved.sortOrder) : undefined
    };
    function upsert(list) {
      var rows = Array.isArray(list) ? list.slice() : [];
      var found = false;
      rows = rows.map(function (row) {
        if (String(row.permanentClubId || "").trim().toUpperCase() === id ||
          (!row.permanentClubId && String(row.name || "") === String((editSnapshot && editSnapshot.club && editSnapshot.club.name) || ""))) {
          found = true;
          return Object.assign({}, row, patch);
        }
        return row;
      }).filter(function (row) {
        return !(found && String(row.permanentClubId || "").trim().toUpperCase() === id && row !== rows.find(function (r) {
          return String(r.permanentClubId || "").trim().toUpperCase() === id;
        }));
      });
      if (!found && patch.active !== false) rows.push(Object.assign({}, patch));
      return rows.filter(function (row, index, all) {
        var rid = String(row.permanentClubId || "").trim().toUpperCase();
        if (!rid) return true;
        return all.findIndex(function (other) {
          return String(other.permanentClubId || "").trim().toUpperCase() === rid;
        }) === index;
      });
    }
    state.clubs = upsert(state.clubs).filter(function (row) { return row.active !== false; });
    if (Array.isArray(state.studentQueryClubs)) {
      state.studentQueryClubs = upsert(state.studentQueryClubs);
    }
    if (typeof root.renderClubs === "function") root.renderClubs();
    if (typeof root.initClubStudentSelectors === "function") root.initClubStudentSelectors();
    if ($("statClubs")) $("statClubs").textContent = String(state.clubs.length);
    if ($("clubMeta")) $("clubMeta").textContent = state.clubs.length + " 個社團";
  }

  function toastFolderEnsure_(folderEnsure, clubCreated) {
    if (!folderEnsure) return;
    if (folderEnsure.success === true && folderEnsure.step === "done") {
      root.toast("✅ 評選資料夾已建立／綁定");
      return;
    }
    var step = String(folderEnsure.step || "");
    var stepLabel =
      step === "need_create" ? "待建立" :
      step === "need_bind" ? "待綁定" :
      step === "conflict" ? "待核對（衝突）" : "待核對";
    var prefix = clubCreated ? "社團已建立；雲端" : "雲端";
    root.toast("⚠️ " + prefix + stepLabel + "（可於雲端狀態單獨重試，不會回滾社團）");
  }

  async function saveClub() {
    var state = root.S;
    if (state.clubSaveBusy) return;
    var oldName = String(($("clubOldName") && $("clubOldName").value) || "");
    var clubName = String(($("clubName") && $("clubName").value) || "").trim();
    var category = String(($("clubCategory") && $("clubCategory").value) || "").trim();
    var participation = String(($("clubParticipation") && $("clubParticipation").value) || "").trim();
    var url = String(($("clubEvaluationFolderUrl") && $("clubEvaluationFolderUrl").value) || "").trim();
    var isAdd = !oldName;
    var token = String(state.token || "");
    var sequence = ++state.clubSaveSeq;
    var saveBtn = $("clubSaveBtn");
    var prevLabel = saveBtn ? String(saveBtn.textContent || "儲存") : "儲存";
    var confirmedSuccess = false;
    var clientRequestId = null;
    var targetSnapshot = editSnapshot;

    $("clubError").textContent = "";
    if (!clubName || !category) {
      $("clubError").textContent = "請填寫社團全名與屬性。";
      return;
    }
    if (isAdd && !participation) {
      $("clubError").textContent = "請選擇參與項目（雲端上傳）；未選不會自動設評選或兩項皆參加。";
      return;
    }

    state.clubSaveBusy = true;
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = "儲存中…";
    }

    try {
      if (typeof root.clubSaveVerifyExistingBeforeResend_ === "function") {
        var verified = await root.clubSaveVerifyExistingBeforeResend_(
          oldName, clubName, category, sequence, token
        );
        var verifyStatus = verified && verified.status ? verified.status : "none";
        if (verifyStatus === "stale") return;
        if (verifyStatus === "verify_failed") {
          throw new Error((verified && verified.message) ||
            "儲存結果未確認，清單核對失敗；請重新載入後再存，不要再次新增。");
        }
        if (verifyStatus === "found" && verified.club && verified.club.permanentClubId) {
          confirmedSuccess = true;
          if (!verified.formChanged) {
            root.closeModal("clubModal");
            root.toast("✅ 先前新增已確認存在，未重送");
            return;
          }
          oldName = String(verified.club.name || verified.club.clubName || clubName);
          isAdd = false;
          editSnapshot = {
            club: Object.assign({}, verified.club),
            cloud: targetSnapshot && targetSnapshot.cloud || null
          };
          targetSnapshot = editSnapshot;
        }
      }

      if (isAdd) {
        clientRequestId = (state.clubSaveUnconfirmed && state.clubSaveUnconfirmed.clientRequestId) ||
          newClientRequestId_("clubAdd");
        if (typeof root.markClubSaveUnconfirmed_ === "function") {
          root.markClubSaveUnconfirmed_(oldName, clubName, category, clientRequestId);
        }
        var added = await root.api("adminAddClub", {
          clubName: clubName,
          category: category,
          active: true,
          sortOrder: 1,
          participation: participation,
          clientRequestId: clientRequestId
        });
        if (sequence !== state.clubSaveSeq || token !== String(state.token || "")) return;
        if (root.unauthorized(added)) return;
        if (!added || added.success !== true) {
          var addFail = String((added && added.message) || "新增失敗");
          if (/逾時|Failed to fetch|網路|NetworkError|未確認/i.test(addFail)) {
            if (typeof root.markClubSaveUnconfirmed_ === "function") {
              root.markClubSaveUnconfirmed_(oldName, clubName, category, clientRequestId);
            }
          }
          throw new Error(addFail);
        }
        confirmedSuccess = true;
        if (typeof root.rememberClubSaveConfirmed_ === "function") {
          root.rememberClubSaveConfirmed_(oldName, clubName, category, added.club);
        }
        if (typeof root.clearClubSavePartialState_ === "function") {
          root.clearClubSavePartialState_();
        }
        patchLocalClubAfterSave_(added.club, clubName, category);
        if (added.club && added.club.permanentClubId && state.cloudClubRowsById) {
          var newId = String(added.club.permanentClubId).toUpperCase();
          state.cloudClubRowsById[newId] = Object.assign({}, state.cloudClubRowsById[newId] || {}, {
            permanentClubId: newId,
            clubName: clubName,
            category: category,
            active: true,
            participation: participation,
            participationLabel:
              participation === "both" ? "兩項皆參加" :
              participation === "feature" ? "特色" :
              participation === "evaluation" ? "評選" : "未設定",
            evaluation: participation === "evaluation" || participation === "both",
            feature: participation === "feature" || participation === "both",
            folderEnsureStep: added.folderEnsure && added.folderEnsure.step || "need_create",
            folderEnsureLabel: "待建立",
            folderEnsureError: added.folderEnsure && (added.folderEnsure.error || added.folderEnsure.message) || "",
            canRetryFolderEnsure: true,
            evaluationFolderConfigured: false,
            evaluationFolderUrl: ""
          });
          if (Array.isArray(state.cloudClubRows)) {
            var exists = state.cloudClubRows.some(function (row) {
              return String(row.permanentClubId || "").toUpperCase() === newId;
            });
            if (!exists) state.cloudClubRows.push(state.cloudClubRowsById[newId]);
          }
          if (typeof root.renderClouds === "function") root.renderClouds();
        }
        root.closeModal("clubModal");
        root.toast("✅ 社團已建立（" + added.club.permanentClubId + "）");
        toastFolderEnsure_(added.folderEnsure, true);
        if (typeof root.loadClubs === "function") {
          root.loadClubs().catch(function () {});
        }
        return;
      }

      var club = findClubForEdit_(oldName);
      var permanentClubId = String(
        (club && club.permanentClubId) ||
        (targetSnapshot && targetSnapshot.cloud && targetSnapshot.cloud.permanentClubId) ||
        ""
      ).trim().toUpperCase();
      if (!permanentClubId) {
        throw new Error("找不到要修改的社團，請重新載入後再存。");
      }
      var originalName = String((club && (club.name || club.clubName)) ||
        (targetSnapshot && targetSnapshot.cloud && targetSnapshot.cloud.clubName) || "");
      var originalCategory = String((club && club.category) ||
        (targetSnapshot && targetSnapshot.cloud && targetSnapshot.cloud.category) || "");
      var nameChanged = clubName !== originalName || category !== originalCategory;
      var cloudReady = !!(targetSnapshot && targetSnapshot.cloudReady && targetSnapshot.cloud);
      var originalUrl = String((targetSnapshot && targetSnapshot.cloud && targetSnapshot.cloud.evaluationFolderUrl) || "");
      var originalPart = String((targetSnapshot && targetSnapshot.cloud && targetSnapshot.cloud.participation) || "");
      var cloudTouched = false;
      if (cloudReady) {
        cloudTouched = (participation && participation !== originalPart) || url !== originalUrl;
      } else if (participation || url) {
        throw new Error("雲端狀態尚未確認，禁止送出參與／資料夾變更；請先重新載入雲端狀態。若只改名稱／屬性，請清空參與與連結欄位後再存。");
      }

      if (!nameChanged && !cloudTouched) {
        throw new Error("沒有可儲存的變更。");
      }

      var savedClub = club || { permanentClubId: permanentClubId, name: clubName, category: category };
      if (nameChanged) {
        if (!club || !Number.isSafeInteger(Number(club.version))) {
          throw new Error("缺少社團版本，請重新載入後再存。");
        }
        var updated = await root.api("adminUpdateClub", {
          permanentClubId: permanentClubId,
          clubName: clubName,
          category: category,
          active: club.active !== false,
          sortOrder: Number.isSafeInteger(Number(club.sortOrder)) && Number(club.sortOrder) >= 1
            ? Number(club.sortOrder)
            : 1,
          expectedVersion: Number(club.version)
        });
        if (sequence !== state.clubSaveSeq || token !== String(state.token || "") || editSnapshot !== targetSnapshot) {
          return;
        }
        if (root.unauthorized(updated)) return;
        if (!updated || updated.success !== true) {
          var updFail = String((updated && (updated.message || updated.error)) || "修改失敗");
          if (updated && updated.error === "SETTINGS_VERSION_CONFLICT") {
            throw new Error("社團資料已更新，請重新載入後再存。");
          }
          throw new Error(updFail);
        }
        confirmedSuccess = true;
        savedClub = updated.club || club;
        patchLocalClubAfterSave_(savedClub, clubName, category);
        root.toast("ℹ️ 改名／改屬性不會自動搬夾、刪夾或靜默改綁。");
      }

      if (cloudTouched) {
        if (!cloudReady || !targetSnapshot.cloud) {
          throw new Error("雲端狀態尚未確認，拒絕以空白連結覆寫既有綁定。");
        }
        var cloudRow = targetSnapshot.cloud;
        var cloudResult = await root.api("adminSaveClubCloudConfiguration", {
          permanentClubId: permanentClubId,
          participation: participation,
          url: url,
          expectedParticipationVersion: Number.isSafeInteger(Number(cloudRow.participationVersion))
            ? Number(cloudRow.participationVersion)
            : 0,
          expectedLinkVersion: Number.isSafeInteger(Number(cloudRow.linkVersion))
            ? Number(cloudRow.linkVersion)
            : 0
        });
        if (sequence !== state.clubSaveSeq || token !== String(state.token || "") || editSnapshot !== targetSnapshot) {
          return;
        }
        if (root.unauthorized(cloudResult)) return;
        if (!cloudResult || cloudResult.success !== true) {
          if (cloudResult && cloudResult.error === "SETTINGS_VERSION_CONFLICT") {
            throw new Error(confirmedSuccess
              ? "社團已改名／改屬性，但雲端設定版本衝突，請重新載入後再存參與／連結。"
              : "雲端設定已更新，請重新載入後再存。");
          }
          throw new Error((cloudResult && cloudResult.message) ||
            (confirmedSuccess ? "社團已存，但雲端設定儲存失敗" : "雲端設定儲存失敗"));
        }
        confirmedSuccess = true;
        if (state.cloudClubRowsById) {
          var id = permanentClubId;
          var row = state.cloudClubRowsById[id] || (cloudRow ? Object.assign({}, cloudRow) : { permanentClubId: id });
          if (participation) {
            var parsed = participation === "both"
              ? { evaluation: true, feature: true, participation: "both", participationLabel: "兩項皆參加" }
              : participation === "feature"
                ? { evaluation: false, feature: true, participation: "feature", participationLabel: "特色" }
                : { evaluation: true, feature: false, participation: "evaluation", participationLabel: "評選" };
            Object.assign(row, parsed);
            row.participationVersion = Number((cloudRow && cloudRow.participationVersion) || 0) + 1;
          }
          if (url !== originalUrl) {
            row.evaluationFolderUrl = url;
            row.evaluationFolderConfigured = !!url;
            row.linkVersion = Number((cloudRow && cloudRow.linkVersion) || 0) + 1;
          }
          row.clubName = clubName;
          row.category = category;
          state.cloudClubRowsById[id] = row;
          editSnapshot = { club: Object.assign({}, savedClub, { name: clubName, category: category }), cloud: Object.assign({}, row) };
        }
        if (typeof root.renderClouds === "function") root.renderClouds();
        if (typeof root.HKSP_ADMIN_CLOUD.renderMakeupChoices === "function") {
          root.HKSP_ADMIN_CLOUD.renderMakeupChoices();
        }
      }

      root.closeModal("clubModal");
      root.toast("✅ 社團資料已儲存");
      if (typeof root.loadClubs === "function") {
        root.loadClubs().catch(function () {});
      }
    } catch (error) {
      if (sequence === state.clubSaveSeq && token === String(state.token || "")) {
        var message = String((error && error.message) || "儲存失敗");
        var uncertain = /逾時|Failed to fetch|網路|NetworkError|未確認|核對失敗/i.test(message);
        if (uncertain && !confirmedSuccess && clientRequestId && typeof root.markClubSaveUnconfirmed_ === "function") {
          root.markClubSaveUnconfirmed_(oldName, clubName, category, clientRequestId);
        }
        if (uncertain && !confirmedSuccess) {
          $("clubError").textContent = message && /核對失敗/.test(message)
            ? message
            : ("儲存結果未確認，請先核對清單" + (clientRequestId ? "（識別：" + clientRequestId + "）" : "") + "，不要直接重送新增。");
        } else {
          $("clubError").textContent = message;
        }
      }
    } finally {
      if (sequence === state.clubSaveSeq) {
        state.clubSaveBusy = false;
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = prevLabel;
        }
      }
    }
  }

  async function deleteClub(encoded) {
    var name = decodeURIComponent(encoded || "");
    var club = (Array.isArray(root.S.clubs) ? root.S.clubs : []).find(function (row) {
      return String(row.name || "") === name;
    });
    if (!club || !club.permanentClubId) {
      root.toast("⚠️ 找不到社團或缺少永久 Club_ID，請重新載入。");
      return;
    }
    if (!Number.isSafeInteger(Number(club.version))) {
      root.toast("⚠️ 缺少社團版本，請重新載入後再停用。");
      return;
    }
    if (!root.confirm(
      "確定停用「" + name + "」？\n帳號關聯、評分、檔案與歷史會保留；本輪不可重新啟用。"
    )) {
      return;
    }
    var result = await root.api("adminDeleteClub", {
      permanentClubId: club.permanentClubId,
      expectedVersion: Number(club.version)
    });
    if (root.unauthorized(result)) return;
    if (!result || result.success !== true) {
      if (result && result.error === "SETTINGS_VERSION_CONFLICT") {
        root.toast("❌ 社團資料已更新，請重新載入後再停用。");
        return;
      }
      root.toast("❌ " + ((result && result.message) || "停用失敗"));
      return;
    }
    root.S.clubs = (root.S.clubs || []).filter(function (row) {
      return String(row.permanentClubId || "").toUpperCase() !== String(club.permanentClubId).toUpperCase();
    });
    if (Array.isArray(root.S.studentQueryClubs)) {
      root.S.studentQueryClubs = root.S.studentQueryClubs.map(function (row) {
        if (String(row.permanentClubId || "").toUpperCase() === String(club.permanentClubId).toUpperCase()) {
          return Object.assign({}, row, { active: false, version: result.club && result.club.version });
        }
        return row;
      });
    }
    if ($("statClubs")) $("statClubs").textContent = String(root.S.clubs.length);
    if ($("clubMeta")) $("clubMeta").textContent = root.S.clubs.length + " 個社團";
    if (typeof root.renderClubs === "function") root.renderClubs();
    if (typeof root.initClubStudentSelectors === "function") root.initClubStudentSelectors();
    root.toast("✅ 已停用社團（資料保留）");
    if (typeof root.loadClubs === "function") root.loadClubs().catch(function () {});
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
    enabled: enabled,
    request: request,
    configureUi: configureUi,
    prepareClubEdit: prepareClubEdit,
    saveClub: saveClub,
    deleteClub: deleteClub,
    renderMakeupChoices: renderMakeupChoices
  };
  document.addEventListener("DOMContentLoaded", configureUi);
})(window);
