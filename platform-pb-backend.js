/**
 * PocketBase backend adapter for student MVP.
 * Returns Firebase-callable shaped { data } for platform-student-auth / platform-drive-upload.
 */
(function (root) {
  "use strict";

  var cfg = root.HKSP_PB_CONFIG;
  if (!cfg || !cfg.usePocketBase) return;
  if (typeof PocketBase === "undefined") {
    console.error("[HKSP_PB] PocketBase SDK missing");
    return;
  }

  var pb = new PocketBase(cfg.url);
  pb.autoCancellation(false);

  var authListeners = [];
  var pendingUploads = Object.create(null);
  var C = cfg.collections;

  function err(code, message, details) {
    var e = new Error(message || code || "PocketBase error");
    e.code = code || "PB_ERROR";
    e.details = details || { code: code };
    return e;
  }

  function ok(data) {
    return { data: data || {} };
  }

  function studentAuthEmail(studentId) {
    return cfg.studentIdToAuthEmail(studentId);
  }

  function currentRecord() {
    return pb.authStore.isValid ? pb.authStore.model : null;
  }

  function currentUserShim() {
    var rec = currentRecord();
    if (!rec) return null;
    return {
      uid: rec.id,
      email: rec.email || "",
      studentId: rec.student_id || "",
      pbRecord: rec
    };
  }

  function notifyAuth() {
    var user = currentUserShim();
    authListeners.slice().forEach(function (fn) {
      try { fn(user); } catch (_e) { /* ignore */ }
    });
  }

  pb.authStore.onChange(function () {
    notifyAuth();
  });

  var authShim = {
    get currentUser() {
      return currentUserShim();
    },
    signInWithEmailAndPassword: function (email, password) {
      return pb.collection(C.students).authWithPassword(String(email || ""), String(password || ""))
        .then(function () {
          return { user: currentUserShim() };
        })
        .catch(function (e) {
          throw err("auth/wrong-password", (e && e.message) || "登入失敗，請確認學號與密碼。");
        });
    },
    signOut: function () {
      pb.authStore.clear();
      return Promise.resolve();
    },
    onAuthStateChanged: function (cb) {
      if (typeof cb !== "function") return function () {};
      authListeners.push(cb);
      try { cb(currentUserShim()); } catch (_e) { /* ignore */ }
      return function unsubscribe() {
        authListeners = authListeners.filter(function (fn) { return fn !== cb; });
      };
    }
  };

  function getActivity() {
    return pb.collection(C.activities).getFirstListItem(
      'activity_id="' + cfg.activityId + '" && active=true'
    ).catch(function () {
      throw err("ACTIVITY_MISSING", "找不到進行中的評鑑活動。");
    });
  }

  function getMembershipForStudent(studentId) {
    return pb.collection(C.memberships).getList(1, 1, {
      filter: 'student="' + studentId + '" && status="active"',
      expand: "club,activity",
      sort: "-created"
    }).then(function (res) {
      return (res.items && res.items[0]) || null;
    });
  }

  function activityConfig(activity) {
    return activity && activity.config_json && typeof activity.config_json === "object"
      ? activity.config_json
      : {};
  }

  function parseTimeMs(value, fallbackMs) {
    var ms = value ? Date.parse(String(value)) : NaN;
    return Number.isFinite(ms) ? ms : fallbackMs;
  }

  /** kind: "evaluation" | "feature" — 特色活動可另用 config_json.featureDeadline */
  function openWindowFromActivity(activity, kind) {
    var now = Date.now();
    var conf = activityConfig(activity);
    var openAt = parseTimeMs(
      activity && activity.upload_open_at,
      now - 24 * 3600 * 1000
    );
    var closeRaw =
      kind === "feature"
        ? conf.featureDeadline || (activity && activity.upload_close_at)
        : conf.dataDeadline || (activity && activity.upload_close_at);
    var closeAt = parseTimeMs(closeRaw, now + 365 * 24 * 3600 * 1000);
    return {
      open: now >= openAt && now < closeAt,
      deadlineMs: closeAt,
      deadlineAt: new Date(closeAt).toISOString(),
      serverNowMs: now
    };
  }

  function ensureRootFolder(activity, club, studentId) {
    var filter =
      'activity="' + activity.id + '" && club="' + club.id +
      '" && kind="evaluation" && trashed!=true && parent=""';
    return pb.collection(C.folders).getList(1, 1, { filter: filter }).then(function (res) {
      if (res.items && res.items[0]) return res.items[0];
      return pb.collection(C.folders).create({
        activity: activity.id,
        club: club.id,
        name: club.name || "社團評選資料夾",
        kind: "evaluation",
        trashed: false,
        created_by_student: studentId || ""
      });
    });
  }

  function mapUploadFile(rec) {
    var fileName = "";
    if (rec.file) {
      fileName = Array.isArray(rec.file) ? rec.file[0] : rec.file;
    }
    var fileUrl = "";
    try {
      if (fileName) fileUrl = pb.files.getUrl(rec, fileName);
    } catch (_e) {
      fileUrl = "";
    }
    return {
      id: rec.id,
      fileId: rec.id,
      name: rec.original_name || fileName || "file",
      fileName: rec.original_name || fileName || "file",
      size: rec.size_bytes || 0,
      mimeType: rec.mime_type || "",
      uploadKind: rec.upload_kind || "evaluation",
      status: rec.status || "completed",
      folderId: rec.folder || "",
      createdAt: rec.created,
      updatedAt: rec.updated,
      uploadedAt: rec.completed_at || rec.created,
      webViewLink: rec.drive_web_view_link || fileUrl || "",
      fileUrl: fileUrl,
      driveFileId: rec.drive_file_id || ""
    };
  }

  function listActiveClubsForRegistration() {
    var categoryOrder = [
      "全校自治性",
      "自治綜合性",
      "康樂性",
      "學藝性",
      "服務性",
      "體能性"
    ];
    return getActivity().then(function (activity) {
      return Promise.all([
        pb.collection(C.clubs).getFullList({
          filter: 'activity="' + activity.id + '" && active=true',
          sort: "name"
        }),
        pb.collection(C.memberships).getFullList({
          filter: 'activity="' + activity.id + '" && status="active"',
          expand: "student"
        })
      ]).then(function (pair) {
        var clubs = pair[0] || [];
        var mems = pair[1] || [];
        var occupied = Object.create(null);
        mems.forEach(function (m) {
          if (!m || !m.club) return;
          if (membershipOccupiesSeat(m, "")) occupied[String(m.club)] = true;
        });
        var mapped = clubs.map(function (club) {
          var taken = !!occupied[String(club.id)];
          return {
            permanentClubId: club.permanent_club_id,
            clubName: club.name,
            category: cfg.mapClubCategory(club.category),
            seatStatus: taken ? "occupied" : "empty",
            seatOccupied: taken
          };
        });
        mapped.sort(function (a, b) {
          var ai = categoryOrder.indexOf(a.category);
          var bi = categoryOrder.indexOf(b.category);
          if (ai < 0) ai = 99;
          if (bi < 0) bi = 99;
          if (ai !== bi) return ai - bi;
          return String(a.clubName || "").localeCompare(String(b.clubName || ""), "zh-Hant");
        });
        return ok({
          clubs: mapped,
          categories: categoryOrder.filter(function (cat) {
            return mapped.some(function (c) { return c.category === cat; });
          })
        });
      });
    });
  }

  function isUniqueConflict(e) {
    var status = e && (e.status || e.statusCode);
    var raw = e && (e.data || e.response || {});
    var fieldErrors = (raw && raw.data) || {};
    if (
      status === 400 &&
      (fieldErrors.email || fieldErrors.student_id || fieldErrors.username)
    ) {
      return true;
    }
    var msg = String((e && e.message) || "");
    return /not_unique|unique|Failed to create record/i.test(msg);
  }

  function membershipOccupiesSeat(m, studentRecordId) {
    if (!m || m.status !== "active") return false;
    if (String(m.student) === String(studentRecordId)) return false;
    var stu = (m.expand && m.expand.student) || null;
    if (stu) {
      var sid = String(stu.student_id || "");
      // Soft-tombstoned rows from wrong-registration delete must not block seats.
      if (/^W[a-zA-Z0-9]+$/.test(sid) || /__WRR__/i.test(sid) || /^wrr/i.test(sid)) {
        return false;
      }
      // Policy A: inactive Auth still holds the seat until the account is deleted.
    }
    return true;
  }

  /** One active membership per club. Same student may keep/reclaim their own seat. */
  function assertClubSeatAvailable(activity, club, studentRecordId) {
    return pb.collection(C.memberships).getFullList({
      filter:
        'activity="' + activity.id + '" && club="' + club.id + '" && status="active"',
      expand: "student"
    }).then(function (mems) {
      var others = (mems || []).filter(function (m) {
        return membershipOccupiesSeat(m, studentRecordId);
      });
      if (others.length) {
        throw err(
          "SEAT_TAKEN",
          "此社團名額已被占用，每個社團僅能註冊一個帳號。",
          {
            code: "SEAT_TAKEN",
            permanentClubId: club.permanent_club_id || ""
          }
        );
      }
    });
  }

  function ensureStudentMembership(activity, club, student, opId, studentId, permanentClubId) {
    return pb.collection(C.memberships).getList(1, 1, {
      filter:
        'activity="' + activity.id + '" && club="' + club.id +
        '" && student="' + student.id + '"'
    }).then(function (res) {
      if (res.totalItems > 0) {
        var row = res.items[0];
        if (row.status === "active" && row.can_upload === true) {
          return ensureRootFolder(activity, club, student.id).then(function () {
            return ok({
              opId: opId,
              studentId: studentId,
              permanentClubId: permanentClubId,
              alreadyMember: true
            });
          });
        }
        return assertClubSeatAvailable(activity, club, student.id).then(function () {
          return pb.collection(C.memberships).update(row.id, {
            status: "active",
            can_upload: true
          }).then(function () {
            return ensureRootFolder(activity, club, student.id).then(function () {
              return ok({
                opId: opId,
                studentId: studentId,
                permanentClubId: permanentClubId,
                alreadyMember: true
              });
            });
          });
        });
      }
      return assertClubSeatAvailable(activity, club, student.id).then(function () {
        return pb.collection(C.memberships).create({
          activity: activity.id,
          club: club.id,
          student: student.id,
          role: "member",
          status: "active",
          can_upload: true,
          bound_at: new Date().toISOString()
        }).then(function (created) {
          // Best-effort race guard: if another active seat appeared, roll back ours.
          return assertClubSeatAvailable(activity, club, student.id)
            .then(function () {
              return ensureRootFolder(activity, club, student.id).then(function () {
                return ok({
                  opId: opId,
                  studentId: studentId,
                  permanentClubId: permanentClubId
                });
              });
            })
            .catch(function (seatErr) {
              return pb.collection(C.memberships).delete(created.id).catch(function () {
                return pb.collection(C.memberships).update(created.id, {
                  status: "revoked",
                  can_upload: false
                });
              }).then(function () {
                throw seatErr;
              });
            });
        }).catch(function (createErr) {
          // DB unique (activity, club) WHERE status=active blocks concurrent double seats.
          if (isUniqueConflict(createErr)) {
            throw err(
              "SEAT_TAKEN",
              "此社團名額已被占用，每個社團僅能註冊一個帳號。",
              {
                code: "SEAT_TAKEN",
                permanentClubId: permanentClubId || (club && club.permanent_club_id) || ""
              }
            );
          }
          throw createErr;
        });
      });
    });
  }

  function createStudentAndBind(activity, club, studentId, email, birth, opId, permanentClubId) {
    return pb.collection(C.students).create({
      email: email,
      emailVisibility: false,
      password: birth,
      passwordConfirm: birth,
      student_id: studentId,
      birth_ymd: birth,
      name: studentId,
      must_change_password: true,
      active: true,
      failed_login_count: 0,
      registered_at: new Date().toISOString()
    }).then(function (student) {
      return pb.collection(C.students).authWithPassword(email, birth).then(function () {
        return ensureStudentMembership(
          activity, club, student, opId, studentId, permanentClubId
        );
      });
    });
  }

  /**
   * Leftover Auth after admin delete/unbind: auto clear with birthday proof, then fresh register.
   * Requires ACL birth query/body rules + self-delete (scripts/pb-apply-admin-acl.ps1).
   */
  function autoClearExistingAndRegister(
    activity,
    club,
    studentId,
    email,
    birth,
    opId,
    permanentClubId
  ) {
    function recreateFresh() {
      pb.authStore.clear();
      return createStudentAndBind(
        activity, club, studentId, email, birth, opId, permanentClubId
      );
    }

    function clearAuthenticatedStudent(student) {
      if (!student || !student.id) {
        return Promise.reject(err("RECLAIM_FAILED", "找不到可清除的舊帳號。"));
      }
      // Hard self-delete cascades memberships; then create a clean account.
      return pb.collection(C.students).delete(student.id).then(function () {
        return recreateFresh();
      }).catch(function () {
        // Fallback: keep Auth, just (re)bind club seat.
        return ensureStudentMembership(
          activity, club, student, opId, studentId, permanentClubId
        ).then(function (result) {
          if (result && result.data) result.data.reclaimed = true;
          return result;
        });
      });
    }

    function authThenClear() {
      return pb.collection(C.students).authWithPassword(email, birth).then(function () {
        return clearAuthenticatedStudent(currentRecord() || pb.authStore.model);
      });
    }

    function birthProofResetThenClear() {
      return pb.collection(C.students).getFirstListItem(
        'student_id="' + studentId + '" || email="' + email + '"',
        { birth: birth }
      ).then(function (row) {
        return pb.collection(C.students).update(row.id, {
          password: birth,
          passwordConfirm: birth,
          birth_ymd: birth,
          active: true,
          must_change_password: true,
          student_id: studentId,
          email: email,
          emailVisibility: false
        }).then(function () {
          return authThenClear();
        });
      });
    }

    return authThenClear().catch(function () {
      return birthProofResetThenClear().catch(function () {
        throw err(
          "EXISTING_AUTH_REQUIRES_LOGIN",
          "此學號已有帳號，且無法以生日自動清除。請確認生日正確，或請管理員清除殘留帳號。",
          { code: "EXISTING_AUTH_REQUIRES_LOGIN", opId: opId }
        );
      });
    });
  }

  function registerClubStudent(data) {
    var permanentClubId = String((data && data.permanentClubId) || "").trim();
    var studentId = cfg.normalizeStudentId(data && data.studentId);
    var birth = String((data && data.birthYYYYMMDD) || "").trim();
    if (!permanentClubId || !studentId || !/^\d{8}$/.test(birth)) {
      return Promise.reject(err("INVALID_INPUT", "請完整填寫社團、學號與生日。"));
    }
    var email = studentAuthEmail(studentId);
    var opId = "pb-" + Date.now().toString(16);

    return getActivity().then(function (activity) {
      return pb.collection(C.clubs).getFirstListItem(
        'activity="' + activity.id + '" && permanent_club_id="' + permanentClubId + '" && active=true'
      ).then(function (club) {
        var current = currentRecord();
        // Already signed in as this student → only ensure activity membership.
        if (current && cfg.normalizeStudentId(current.student_id) === studentId) {
          return ensureStudentMembership(
            activity, club, current, opId, studentId, permanentClubId
          );
        }

        return createStudentAndBind(
          activity, club, studentId, email, birth, opId, permanentClubId
        ).catch(function (e) {
          if (isUniqueConflict(e)) {
            return autoClearExistingAndRegister(
              activity, club, studentId, email, birth, opId, permanentClubId
            );
          }
          throw err("REGISTER_FAILED", (e && e.message) || "註冊失敗，請稍後再試。");
        });
      });
    });
  }

  function getClubStudentAccessState() {
    var user = currentUserShim();
    if (!user) {
      return Promise.reject(err("UNAUTHENTICATED", "請先登入。"));
    }
    return pb.collection(C.students).authRefresh().catch(function () {
      return null;
    }).then(function () {
      var rec = currentRecord();
      if (!rec || rec.active === false) {
        return ok({
          status: "disabled",
          mustChangePassword: false,
          access: { allowed: false, code: "STUDENT_DISABLED", message: "帳號已停用。" }
        });
      }
      if (rec.must_change_password) {
        return ok({
          status: "active",
          mustChangePassword: true,
          activityId: cfg.activityId,
          access: { allowed: false, code: "MUST_CHANGE_PASSWORD", message: "請先完成強制改密。" }
        });
      }
      return getMembershipForStudent(rec.id).then(function (mem) {
        if (!mem) {
          return ok({
            status: "active",
            mustChangePassword: false,
            activityId: cfg.activityId,
            access: { allowed: false, code: "NO_MEMBERSHIP", message: "目前無法使用，請先完成註冊或聯絡學生議會。" }
          });
        }
        var club = (mem.expand && mem.expand.club) || null;
        var activity = (mem.expand && mem.expand.activity) || null;
        return ok({
          status: "active",
          mustChangePassword: false,
          activityId: (activity && activity.activity_id) || cfg.activityId,
          permanentClubId: (club && club.permanent_club_id) || "",
          clubName: (club && club.name) || "",
          access: {
            allowed: true,
            code: "OK",
            message: "ok"
          }
        });
      });
    });
  }

  function changeClubStudentPassword(data) {
    var user = currentUserShim();
    if (!user) return Promise.reject(err("UNAUTHENTICATED", "請先登入。"));
    var currentPassword = String((data && data.currentPassword) || "");
    var newPassword = String((data && data.newPassword) || "");
    if (!currentPassword || !newPassword) {
      return Promise.reject(err("INVALID_INPUT", "請輸入目前密碼與新密碼。"));
    }
    if (String(newPassword).length < 8) {
      return Promise.reject(err("INVALID_INPUT", "新密碼至少 8 個字元。"));
    }
    if (currentPassword === newPassword) {
      return Promise.reject(err("INVALID_INPUT", "新密碼不可與目前密碼相同。"));
    }
    var email = user.email || studentAuthEmail(user.studentId);
    return pb.collection(C.students).authWithPassword(email, currentPassword)
      .then(function () {
        return pb.collection(C.students).update(user.uid, {
          oldPassword: currentPassword,
          password: newPassword,
          passwordConfirm: newPassword,
          must_change_password: false,
          failed_login_count: 0
        });
      })
      .then(function () {
        pb.authStore.clear();
        return ok({ ok: true });
      })
      .catch(function (e) {
        if (e && e.code === "INVALID_INPUT") throw e;
        var msg = (e && e.message) || "改密失敗。";
        if (/Failed to authenticate|Invalid login/i.test(msg)) {
          throw err("PASSWORD_CHANGE_FAILED", "目前密碼不正確。");
        }
        throw err("PASSWORD_CHANGE_FAILED", msg);
      });
  }

  function getClubStudentForgotPasswordContact() {
    return Promise.resolve(ok({
      source: "assist",
      title: cfg.FORGOT_PASSWORD_ASSIST_LABEL || "聯絡帳號協助窗口",
      message: "請透過指定窗口核對身分後，由有權限管理員協助重設密碼。",
      channel: cfg.FORGOT_PASSWORD_ASSIST_URL
    }));
  }

  function cleanupClubStudentRegistrationOp() {
    return Promise.resolve(ok({ cleaned: true }));
  }

  function reconcileClubStudentPasswordChange() {
    return Promise.resolve(ok({ reconciled: true }));
  }

  function contextFromAuth() {
    var user = currentUserShim();
    if (!user) return Promise.reject(err("UNAUTHENTICATED", "請先登入。"));
    return getMembershipForStudent(user.uid).then(function (mem) {
      if (!mem) throw err("NO_MEMBERSHIP", "尚無社團綁定。");
      var club = mem.expand && mem.expand.club;
      var activity = mem.expand && mem.expand.activity;
      if (!club || !activity) {
        return pb.collection(C.clubs).getOne(mem.club).then(function (c) {
          return pb.collection(C.activities).getOne(mem.activity).then(function (a) {
            return { user: user, mem: mem, club: c, activity: a };
          });
        });
      }
      return { user: user, mem: mem, club: club, activity: activity };
    });
  }

  function listClubDriveUploads() {
    return contextFromAuth().then(function (ctx) {
      return ensureRootFolder(ctx.activity, ctx.club, ctx.user.uid).then(function (root) {
        // Club shared workspace: all members see the club tree, not only own uploads.
        return pb.collection(C.uploads).getFullList({
          filter: 'club="' + ctx.club.id + '" && status!="trashed"',
          sort: "-created"
        }).then(function (rows) {
          var winEval = openWindowFromActivity(ctx.activity, "evaluation");
          var winFeature = openWindowFromActivity(ctx.activity, "feature");
          return ok({
            activityId: ctx.activity.activity_id || cfg.activityId,
            permanentClubId: ctx.club.permanent_club_id,
            clubName: ctx.club.name,
            clubFolderId: root.id,
            files: rows.map(mapUploadFile),
            participation: { configured: true, evaluation: true, feature: true },
            uploadWindows: {
              serverNowMs: winEval.serverNowMs,
              evaluation: winEval,
              feature: winFeature
            },
            driveWriteEnabled: true,
            uploadGate: { envLive: true, open: true },
            storage: "pocketbase"
          });
        });
      });
    });
  }

  function listClubEvaluationFolders(data) {
    return contextFromAuth().then(function (ctx) {
      return ensureRootFolder(ctx.activity, ctx.club, ctx.user.uid).then(function (root) {
        var parentId = String((data && data.parentFolderId) || "").trim() || root.id;
        var filter =
          'club="' + ctx.club.id + '" && trashed!=true && parent="' + parentId + '"';
        if (parentId === root.id) {
          // also include children of root; parent field empty treated as root children via ensure
          filter = 'club="' + ctx.club.id + '" && trashed!=true && (parent="' + parentId + '" || (parent="" && id!="' + root.id + '"))';
        }
        return pb.collection(C.folders).getFullList({
          filter: 'club="' + ctx.club.id + '" && trashed!=true && parent="' + parentId + '"',
          sort: "name"
        }).then(function (folders) {
          return pb.collection(C.uploads).getFullList({
            filter: 'club="' + ctx.club.id + '" && folder="' + parentId + '" && status!="trashed"',
            sort: "-created"
          }).then(function (files) {
            var winEval = openWindowFromActivity(ctx.activity, "evaluation");
            var winFeature = openWindowFromActivity(ctx.activity, "feature");
            return ok({
              clubFolderId: root.id,
              parentFolderId: parentId,
              path: [
                { folderId: root.id, name: ctx.club.name || "社團評選資料夾", depth: 0 }
              ],
              folders: folders.map(function (f) {
                return {
                  folderId: f.id,
                  id: f.id,
                  name: f.name,
                  kind: f.kind || "evaluation"
                };
              }),
              files: files.map(mapUploadFile),
              driveWriteEnabled: true,
              uploadGate: { envLive: true, open: true },
              participation: { configured: true, evaluation: true, feature: true },
              uploadWindows: {
                serverNowMs: winEval.serverNowMs,
                evaluation: winEval,
                feature: winFeature
              },
              storage: "pocketbase"
            });
          });
        });
      });
    });
  }

  function createClubEvaluationFolder(data) {
    return contextFromAuth().then(function (ctx) {
      return ensureRootFolder(ctx.activity, ctx.club, ctx.user.uid).then(function (root) {
        var name = String((data && data.name) || "").trim();
        if (!name) throw err("INVALID_INPUT", "請輸入資料夾名稱。");
        var parentId = String((data && data.parentFolderId) || "").trim() || root.id;
        return pb.collection(C.folders).create({
          activity: ctx.activity.id,
          club: ctx.club.id,
          parent: parentId,
          name: name,
          kind: "evaluation",
          trashed: false,
          created_by_student: ctx.user.uid
        }).then(function (folder) {
          return ok({ folderId: folder.id, name: folder.name });
        });
      });
    });
  }

  /** Permanent delete (no trash retention on PB primary path). */
  function assertClubOwnedUpload(ctx, fileId) {
    return pb.collection(C.uploads).getOne(fileId).then(function (row) {
      if (!row || String(row.club) !== String(ctx.club.id)) {
        throw err("NOT_FOUND", "找不到此檔案，或它不屬於目前社團。");
      }
      return row;
    });
  }

  function assertClubOwnedFolder(ctx, folderId, rootId) {
    return pb.collection(C.folders).getOne(folderId).then(function (row) {
      if (!row || String(row.club) !== String(ctx.club.id)) {
        throw err("NOT_FOUND", "找不到此資料夾，或它不屬於目前社團。");
      }
      if (String(row.id) === String(rootId)) {
        throw err("FORBIDDEN", "不能刪除社團根資料夾。");
      }
      return row;
    });
  }

  function deleteUploadsInFolder(ctx, folderId) {
    return pb.collection(C.uploads).getFullList({
      filter: 'club="' + ctx.club.id + '" && folder="' + folderId + '"'
    }).then(function (rows) {
      var chain = Promise.resolve();
      (rows || []).forEach(function (row) {
        chain = chain.then(function () {
          return pb.collection(C.uploads).delete(row.id);
        });
      });
      return chain;
    });
  }

  function permanentlyDeleteFolderTree(ctx, folderId, rootId) {
    return assertClubOwnedFolder(ctx, folderId, rootId).then(function () {
      return pb.collection(C.folders).getFullList({
        filter: 'club="' + ctx.club.id + '" && parent="' + folderId + '"'
      }).then(function (children) {
        var chain = Promise.resolve();
        (children || []).forEach(function (child) {
          chain = chain.then(function () {
            return permanentlyDeleteFolderTree(ctx, child.id, rootId);
          });
        });
        return chain
          .then(function () { return deleteUploadsInFolder(ctx, folderId); })
          .then(function () { return pb.collection(C.folders).delete(folderId); });
      });
    });
  }

  function trashClubEvaluationFile(data) {
    var fileId = String((data && data.fileId) || "").trim();
    if (!fileId) return Promise.reject(err("INVALID_INPUT", "缺少檔案。"));
    return contextFromAuth().then(function (ctx) {
      return assertClubOwnedUpload(ctx, fileId).then(function () {
        return pb.collection(C.uploads).delete(fileId).then(function () {
          return ok({ deleted: true, permanent: true, fileId: fileId });
        });
      }).catch(function (e) {
        if (e && e.code) throw e;
        throw err(
          "DELETE_FAILED",
          (e && e.message) || "刪除檔案失敗（可能無權刪除他人上傳的檔案）。"
        );
      });
    });
  }

  function trashClubEvaluationFolder(data) {
    var folderId = String((data && data.folderId) || "").trim();
    if (!folderId) return Promise.reject(err("INVALID_INPUT", "缺少資料夾。"));
    return contextFromAuth().then(function (ctx) {
      return ensureRootFolder(ctx.activity, ctx.club, ctx.user.uid).then(function (root) {
        return permanentlyDeleteFolderTree(ctx, folderId, root.id).then(function () {
          return ok({ deleted: true, permanent: true, folderId: folderId });
        });
      }).catch(function (e) {
        if (e && e.code) throw e;
        throw err(
          "DELETE_FAILED",
          (e && e.message) || "刪除資料夾失敗（若含他人上傳檔可能無法整夾刪除）。"
        );
      });
    });
  }

  function listClubEvaluationTrash() {
    // PB primary path does not retain trash.
    return Promise.resolve(ok({ items: [], storage: "pocketbase", trashRetained: false }));
  }

  function restoreClubEvaluationItem() {
    return Promise.reject(err("UNIMPLEMENTED", "PocketBase 主路徑不保留垃圾桶，無法還原。"));
  }

  function escFilter(value) {
    return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function assertWriteWindowOpen(ctx, kind) {
    var win = openWindowFromActivity(ctx.activity, kind === "feature" ? "feature" : "evaluation");
    if (!win.open) {
      throw err("UPLOAD_WINDOW_CLOSED", "繳交已截止，目前為唯讀，無法重新命名／移動／複製。");
    }
    return win;
  }

  function writeKindFromUpload(row) {
    return String((row && row.upload_kind) || "evaluation") === "feature" ? "feature" : "evaluation";
  }

  function writeKindFromFolder(folder) {
    return String((folder && folder.kind) || "evaluation") === "feature" ? "feature" : "evaluation";
  }

  function preservePdfExtension(oldName, nextName) {
    var next = String(nextName || "").trim();
    if (!next) return "";
    var old = String(oldName || "");
    if (/\.pdf$/i.test(old) && !/\.pdf$/i.test(next)) return next + ".pdf";
    return next;
  }

  function conflictConfirmPayload(conflicts, action) {
    var first = (conflicts && conflicts[0]) || {};
    return ok({
      status: "replace_confirm_required",
      action: action,
      message: "目的地已有同名項目，確認後將刪除舊檔再完成操作。",
      existingFile: {
        fileName: first.original_name || first.name || null,
        fileId: first.id || null,
        size: first.size_bytes != null ? Number(first.size_bytes) : null,
        mimeType: first.mime_type || null
      },
      conflictFileIds: (conflicts || []).map(function (hit) {
        return String(hit.id);
      })
    });
  }

  function listUploadsByNameInFolder(ctx, folderId, name, exceptId) {
    var filter =
      'club="' +
      ctx.club.id +
      '" && folder="' +
      folderId +
      '" && status!="trashed" && original_name="' +
      escFilter(name) +
      '"';
    return pb.collection(C.uploads).getFullList({ filter: filter }).then(function (rows) {
      return (rows || []).filter(function (row) {
        return !exceptId || String(row.id) !== String(exceptId);
      });
    });
  }

  function listFoldersByNameInParent(ctx, parentId, name, exceptId) {
    var filter =
      'club="' +
      ctx.club.id +
      '" && trashed!=true && parent="' +
      parentId +
      '" && name="' +
      escFilter(name) +
      '"';
    return pb.collection(C.folders).getFullList({ filter: filter }).then(function (rows) {
      return (rows || []).filter(function (row) {
        return !exceptId || String(row.id) !== String(exceptId);
      });
    });
  }

  function deleteConflictUploads(rows) {
    var chain = Promise.resolve();
    (rows || []).forEach(function (row) {
      chain = chain.then(function () {
        return pb.collection(C.uploads).delete(row.id);
      });
    });
    return chain;
  }

  function clubFilesPayload(ctx) {
    return pb.collection(C.uploads).getFullList({
      filter: 'club="' + ctx.club.id + '" && status!="trashed"',
      sort: "-created"
    }).then(function (rows) {
      return (rows || []).map(mapUploadFile);
    });
  }

  function relationIdLocal(value) {
    if (value == null || value === "") return "";
    if (typeof value === "object") return String(value.id || "");
    return String(value);
  }

  function folderParentChainContains(ctx, startFolderId, needleId) {
    var guard = 0;
    function step(folderId) {
      if (!folderId) return Promise.resolve(false);
      if (String(folderId) === String(needleId)) return Promise.resolve(true);
      if (guard++ > 40) return Promise.resolve(true);
      return pb.collection(C.folders).getOne(folderId).then(function (row) {
        if (!row || String(row.club) !== String(ctx.club.id)) return false;
        var parentId = relationIdLocal(row.parent);
        if (!parentId) return false;
        return step(parentId);
      });
    }
    return step(startFolderId);
  }

  function assertDestinationFolder(ctx, destinationFolderId, rootId) {
    var destId = String(destinationFolderId || "").trim() || rootId;
    if (String(destId) === String(rootId)) {
      return Promise.resolve({ id: rootId, name: ctx.club.name || "社團評選資料夾", kind: "evaluation" });
    }
    return pb.collection(C.folders).getOne(destId).then(function (row) {
      if (!row || String(row.club) !== String(ctx.club.id) || row.trashed === true) {
        throw err("NOT_FOUND", "找不到目的地資料夾，或它不屬於目前社團。");
      }
      return row;
    });
  }

  function renameClubEvaluationFile(data) {
    var fileId = String((data && data.fileId) || "").trim();
    var nextName = String((data && (data.name || data.fileName)) || "").trim();
    var confirmReplace = !!(data && data.confirmReplace === true);
    if (!fileId) return Promise.reject(err("INVALID_INPUT", "缺少檔案。"));
    if (!nextName) return Promise.reject(err("INVALID_INPUT", "請輸入新名稱。"));
    return contextFromAuth().then(function (ctx) {
      return assertClubOwnedUpload(ctx, fileId).then(function (row) {
        assertWriteWindowOpen(ctx, writeKindFromUpload(row));
        var folderId = relationIdLocal(row.folder);
        if (!folderId) throw err("INVALID_STATE", "檔案未掛在資料夾內，無法重新命名。");
        nextName = preservePdfExtension(row.original_name || "", nextName);
        if (String(row.original_name || "") === nextName) {
          return clubFilesPayload(ctx).then(function (files) {
            return ok({
              action: "rename",
              already: true,
              fileId: fileId,
              fileName: nextName,
              files: files
            });
          });
        }
        return listUploadsByNameInFolder(ctx, folderId, nextName, fileId).then(function (conflicts) {
          if (conflicts.length && !confirmReplace) {
            return conflictConfirmPayload(conflicts, "rename");
          }
          var chain = conflicts.length && confirmReplace
            ? deleteConflictUploads(conflicts)
            : Promise.resolve();
          return chain
            .then(function () {
              return pb.collection(C.uploads).update(fileId, { original_name: nextName });
            })
            .then(function () {
              return clubFilesPayload(ctx);
            })
            .then(function (files) {
              return ok({
                action: "rename",
                fileId: fileId,
                fileName: nextName,
                parentFolderId: folderId,
                files: files
              });
            });
        });
      });
    });
  }

  function renameClubEvaluationFolder(data) {
    var folderId = String((data && data.folderId) || "").trim();
    var nextName = String((data && (data.name || data.folderName)) || "").trim();
    if (!folderId) return Promise.reject(err("INVALID_INPUT", "缺少資料夾。"));
    if (!nextName) return Promise.reject(err("INVALID_INPUT", "請輸入新名稱。"));
    return contextFromAuth().then(function (ctx) {
      return ensureRootFolder(ctx.activity, ctx.club, ctx.user.uid).then(function (root) {
        return assertClubOwnedFolder(ctx, folderId, root.id).then(function (folder) {
          assertWriteWindowOpen(ctx, writeKindFromFolder(folder));
          if (String(folder.name || "") === nextName) {
            return ok({
              action: "rename",
              already: true,
              folderId: folderId,
              name: nextName
            });
          }
          var parentId = relationIdLocal(folder.parent) || root.id;
          return listFoldersByNameInParent(ctx, parentId, nextName, folderId).then(function (conflicts) {
            if (conflicts.length) {
              throw err("FOLDER_NAME_CONFLICT", "同層已有同名資料夾。");
            }
            return pb.collection(C.folders).update(folderId, { name: nextName }).then(function () {
              return ok({
                action: "rename",
                folderId: folderId,
                name: nextName,
                parentFolderId: parentId
              });
            });
          });
        });
      });
    });
  }

  function moveClubEvaluationFile(data) {
    var fileId = String((data && data.fileId) || "").trim();
    var destinationFolderId = String((data && data.destinationFolderId) || "").trim();
    var confirmReplace = !!(data && data.confirmReplace === true);
    if (!fileId) return Promise.reject(err("INVALID_INPUT", "缺少檔案。"));
    if (!destinationFolderId) return Promise.reject(err("INVALID_INPUT", "缺少目的地資料夾。"));
    return contextFromAuth().then(function (ctx) {
      return ensureRootFolder(ctx.activity, ctx.club, ctx.user.uid).then(function (root) {
        return assertClubOwnedUpload(ctx, fileId).then(function (row) {
          assertWriteWindowOpen(ctx, writeKindFromUpload(row));
          var fromFolderId = relationIdLocal(row.folder);
          return assertDestinationFolder(ctx, destinationFolderId, root.id).then(function (dest) {
            var toFolderId = dest.id;
            if (String(fromFolderId) === String(toFolderId)) {
              return clubFilesPayload(ctx).then(function (files) {
                return ok({
                  action: "move",
                  already: true,
                  fileId: fileId,
                  fileName: row.original_name || null,
                  fromFolderId: fromFolderId,
                  toFolderId: toFolderId,
                  files: files
                });
              });
            }
            var displayName = row.original_name || "file";
            return listUploadsByNameInFolder(ctx, toFolderId, displayName, fileId).then(function (conflicts) {
              if (conflicts.length && !confirmReplace) {
                return conflictConfirmPayload(conflicts, "move");
              }
              var chain = conflicts.length && confirmReplace
                ? deleteConflictUploads(conflicts)
                : Promise.resolve();
              return chain
                .then(function () {
                  return pb.collection(C.uploads).update(fileId, { folder: toFolderId });
                })
                .then(function () {
                  return clubFilesPayload(ctx);
                })
                .then(function (files) {
                  return ok({
                    action: "move",
                    fileId: fileId,
                    fileName: displayName,
                    fromFolderId: fromFolderId,
                    toFolderId: toFolderId,
                    files: files
                  });
                });
            });
          });
        });
      });
    });
  }

  function moveClubEvaluationFolder(data) {
    var folderId = String((data && data.folderId) || "").trim();
    var destinationFolderId = String((data && data.destinationFolderId) || "").trim();
    var confirmReplace = !!(data && data.confirmReplace === true);
    if (!folderId) return Promise.reject(err("INVALID_INPUT", "缺少資料夾。"));
    if (!destinationFolderId) return Promise.reject(err("INVALID_INPUT", "缺少目的地資料夾。"));
    return contextFromAuth().then(function (ctx) {
      return ensureRootFolder(ctx.activity, ctx.club, ctx.user.uid).then(function (root) {
        return assertClubOwnedFolder(ctx, folderId, root.id).then(function (folder) {
          assertWriteWindowOpen(ctx, writeKindFromFolder(folder));
          if (String(folderId) === String(destinationFolderId)) {
            throw err("INVALID_INPUT", "不能把資料夾移動到自己裡面。");
          }
          return folderParentChainContains(ctx, destinationFolderId, folderId).then(function (cyclic) {
            if (cyclic) {
              throw err("INVALID_INPUT", "不能把資料夾移動到自己的子資料夾內。");
            }
            return assertDestinationFolder(ctx, destinationFolderId, root.id).then(function (dest) {
              var fromParent = relationIdLocal(folder.parent) || root.id;
              var toParent = dest.id;
              if (String(fromParent) === String(toParent)) {
                return ok({
                  action: "move",
                  already: true,
                  folderId: folderId,
                  name: folder.name,
                  fromFolderId: fromParent,
                  toFolderId: toParent
                });
              }
              return listFoldersByNameInParent(ctx, toParent, folder.name, folderId).then(function (conflicts) {
                if (conflicts.length && !confirmReplace) {
                  return ok({
                    status: "replace_confirm_required",
                    action: "move_folder",
                    message: "目的地已有同名資料夾，確認後將刪除舊資料夾再完成移動。",
                    existingFile: {
                      fileName: conflicts[0].name || null,
                      fileId: conflicts[0].id || null
                    },
                    conflictFileIds: conflicts.map(function (hit) {
                      return String(hit.id);
                    })
                  });
                }
                var chain = Promise.resolve();
                if (conflicts.length && confirmReplace) {
                  conflicts.forEach(function (hit) {
                    chain = chain.then(function () {
                      return permanentlyDeleteFolderTree(ctx, hit.id, root.id);
                    });
                  });
                }
                return chain
                  .then(function () {
                    return pb.collection(C.folders).update(folderId, { parent: toParent });
                  })
                  .then(function () {
                    return ok({
                      action: "move",
                      folderId: folderId,
                      name: folder.name,
                      fromFolderId: fromParent,
                      toFolderId: toParent
                    });
                  });
              });
            });
          });
        });
      });
    });
  }

  function studentAuthHeader() {
    var token = pb.authStore && pb.authStore.token;
    if (!token) throw err("UNAUTHENTICATED", "請先登入。");
    return "Bearer " + token;
  }

  function driveProxyBase() {
    return String(cfg.driveProxyUrl || "http://127.0.0.1:28223").replace(/\/$/, "");
  }

  function useDriveProxy() {
    return !!cfg.useDriveProxy;
  }

  function isAppsScriptProxy() {
    return /script\.google\.com/i.test(driveProxyBase());
  }

  function pbTokenRaw() {
    var token = pb.authStore && pb.authStore.token;
    if (!token) throw err("UNAUTHENTICATED", "請先登入。");
    return token;
  }

  function proxyPost(path, payload) {
    var base = driveProxyBase();
    if (isAppsScriptProxy()) {
      var body = Object.assign({}, payload || {}, {
        path: path,
        pbToken: pbTokenRaw()
      });
      return fetch(base + "?path=" + encodeURIComponent(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "follow"
      }).then(function (res) {
        return res.json().then(function (jsonBody) {
          if (!res.ok || (jsonBody && jsonBody.success === false)) {
            throw err(
              (jsonBody && jsonBody.code) || "PROXY_FAILED",
              (jsonBody && jsonBody.message) || "Drive proxy 失敗。"
            );
          }
          return jsonBody;
        });
      });
    }
    return fetch(base + "/" + path, {
      method: "POST",
      headers: {
        Authorization: studentAuthHeader(),
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload || {})
    }).then(function (res) {
      return res.json().then(function (jsonBody) {
        if (!res.ok || (jsonBody && jsonBody.success === false)) {
          throw err(
            (jsonBody && jsonBody.code) || "PROXY_FAILED",
            (jsonBody && jsonBody.message) || "Drive proxy 失敗。"
          );
        }
        return jsonBody;
      });
    });
  }

  function fileToBase64(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var result = String(reader.result || "");
        var idx = result.indexOf(",");
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = function () {
        reject(err("FILE_READ_FAILED", "讀取檔案失敗。"));
      };
      reader.readAsDataURL(file);
    });
  }

  function prepareClubDriveUpload(data) {
    if (useDriveProxy()) {
      return proxyPost("v1/prepare", data || {}).then(function (body) {
        var payload = (body && body.data) || body || {};
        pendingUploads[String(payload.clientAttemptId || (data && data.clientAttemptId) || "")] = payload;
        return ok(payload);
      });
    }
    return contextFromAuth().then(function (ctx) {
      return ensureRootFolder(ctx.activity, ctx.club, ctx.user.uid).then(function (root) {
        var attempt = String((data && data.clientAttemptId) || "");
        if (!attempt) throw err("INVALID_INPUT", "缺少上傳識別。");
        var kind = (data && data.uploadKind) === "feature" ? "feature" : "evaluation";
        var dest = String((data && data.destinationFolderId) || "").trim() || root.id;
        return pb.collection(C.uploads).getList(1, 1, {
          filter: 'client_attempt_id="' + attempt + '"'
        }).then(function (existing) {
          if (existing.totalItems > 0) {
            var row = existing.items[0];
            if (row.status === "completed") {
              return ok({ alreadyComplete: true, status: "completed", files: [mapUploadFile(row)] });
            }
          }
          pendingUploads[attempt] = {
            activityId: ctx.activity.id,
            clubId: ctx.club.id,
            studentId: ctx.user.uid,
            folderId: dest,
            uploadKind: kind,
            fileName: String((data && data.fileName) || "file"),
            size: Number((data && data.size) || 0),
            mimeType: String((data && data.mimeType) || "")
          };
          return ok({
            status: "ready",
            pbDirectUpload: true,
            clientAttemptId: attempt,
            fileName: pendingUploads[attempt].fileName,
            destinationFolderId: dest,
            uploadUrl: "pb://direct/" + attempt
          });
        });
      });
    });
  }

  function uploadFile(opts) {
    var attempt = String((opts && opts.attemptId) || "");
    var file = opts && opts.file;
    var meta = pendingUploads[attempt] || (opts && opts.prepared) || null;
    if (!attempt || !file || !meta) {
      return Promise.reject(err("INVALID_INPUT", "上傳參數不完整。"));
    }
    if (useDriveProxy() || meta.proxyUpload) {
      if (isAppsScriptProxy()) {
        return fileToBase64(file).then(function (b64) {
          return proxyPost("v1/upload-bytes", {
            clientAttemptId: attempt,
            fileName: file.name || meta.fileName || "upload.bin",
            mimeType: file.type || meta.mimeType || "application/octet-stream",
            fileBase64: b64
          }).then(function (body) {
            delete pendingUploads[attempt];
            return listClubDriveUploads().then(function (listed) {
              return {
                alreadyComplete: false,
                files: (listed.data && listed.data.files) || [],
                driveFileId: body.data && body.data.driveFileId,
                webViewLink: body.data && body.data.webViewLink
              };
            });
          });
        });
      }
      var form = new FormData();
      form.append("clientAttemptId", attempt);
      form.append("file", file, file.name || "upload.bin");
      return fetch(driveProxyBase() + "/v1/upload-bytes?attempt=" + encodeURIComponent(attempt), {
        method: "POST",
        headers: { Authorization: studentAuthHeader() },
        body: form
      }).then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok || (body && body.success === false)) {
            throw err((body && body.code) || "PROXY_UPLOAD_FAILED", (body && body.message) || "Drive 上傳失敗。");
          }
          delete pendingUploads[attempt];
          return listClubDriveUploads().then(function (listed) {
            return {
              alreadyComplete: false,
              files: (listed.data && listed.data.files) || [],
              driveFileId: body.data && body.data.driveFileId,
              webViewLink: body.data && body.data.webViewLink
            };
          });
        });
      });
    }
    var formPb = new FormData();
    formPb.append("activity", meta.activityId || meta.activity);
    formPb.append("club", meta.clubId || meta.club);
    formPb.append("folder", meta.folderId || meta.destinationFolderId || "");
    formPb.append("student", meta.studentId || meta.student);
    formPb.append("client_attempt_id", attempt);
    formPb.append("upload_kind", meta.uploadKind || "evaluation");
    formPb.append("original_name", file.name || meta.fileName || "file");
    formPb.append("mime_type", file.type || meta.mimeType || "application/octet-stream");
    formPb.append("size_bytes", String(file.size || meta.size || 0));
    formPb.append("status", "completed");
    formPb.append("completed_at", new Date().toISOString());
    formPb.append("file", file, file.name || "upload.bin");

    return pb.collection(C.uploads).create(formPb).then(function (rec) {
      delete pendingUploads[attempt];
      return listClubDriveUploads().then(function (listed) {
        return {
          alreadyComplete: false,
          files: (listed.data && listed.data.files) || [mapUploadFile(rec)],
          file: mapUploadFile(rec)
        };
      });
    });
  }

  function completeClubDriveUpload(data) {
    var attempt = String((data && data.clientAttemptId) || "");
    if (useDriveProxy()) {
      return proxyPost("v1/complete", { clientAttemptId: attempt }).then(function (body) {
        return {
          data: (body && body.data) || {},
          files: (body && body.data && body.data.files) || [],
          alreadyComplete: true
        };
      });
    }
    if (pendingUploads[attempt]) {
      return Promise.reject(err("UPLOAD_INCOMPLETE", "請先完成檔案傳輸。"));
    }
    return pb.collection(C.uploads).getList(1, 1, {
      filter: 'client_attempt_id="' + attempt + '"'
    }).then(function (res) {
      if (!res.totalItems) throw err("NOT_FOUND", "找不到上傳紀錄。");
      return listClubDriveUploads().then(function (listed) {
        return {
          data: listed.data,
          files: listed.data.files,
          alreadyComplete: true
        };
      });
    });
  }

  function publicRequest(payload) {
    var action = payload && payload.action;
    if (action === "getClubData") {
      return getActivity().then(function (activity) {
        return pb.collection(C.clubs).getFullList({
          filter: 'activity="' + activity.id + '" && active=true',
          sort: "name"
        }).then(function (clubs) {
          var categories = {
            "全校自治性": [],
            "自治綜合性": [],
            "康樂性": [],
            "服務性": [],
            "體能性": [],
            "學藝性": []
          };
          clubs.forEach(function (club) {
            var cat = cfg.mapClubCategory(club.category);
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push(club.name);
          });
          return { success: true, categories: categories };
        });
      }).catch(function (e) {
        return { success: false, message: (e && e.message) || "無法取得社團名單" };
      });
    }
    if (action === "getEventConfig") {
      return getActivity().then(function (activity) {
        var conf = activityConfig(activity);
        var fallback = root.FALLBACK_EVENT_CONFIG || {};
        var config = Object.assign({}, fallback, conf, {
          activityId: activity.activity_id,
          title: activity.title
        });
        if (!config.dataDeadline && activity.upload_close_at) {
          config.dataDeadline = activity.upload_close_at;
        }
        return {
          success: true,
          config: config,
          serverNow: new Date().toISOString()
        };
      }).catch(function (e) {
        return { success: false, message: (e && e.message) || "無法取得活動時程" };
      });
    }
    return Promise.resolve({ success: false, message: "未知的公開操作：" + action });
  }

  function requireJudge() {
    var rec = pb.authStore.isValid ? pb.authStore.model : null;
    if (!rec) {
      return Promise.reject(err("UNAUTHENTICATED", "請先以評審帳號登入。"));
    }
    if (rec.role !== "judge" && rec.role !== "admin") {
      return Promise.reject(err("FORBIDDEN", "此帳號不是評審／管理員。"));
    }
    if (rec.active === false) {
      return Promise.reject(err("DISABLED", "評審帳號已停用。"));
    }
    return Promise.resolve(rec);
  }

  function judgeLogin(data) {
    var email = String((data && data.email) || "").trim();
    var password = String((data && data.password) || "");
    if (!email || !password) {
      return Promise.reject(err("INVALID_INPUT", "請輸入評審帳號與密碼。"));
    }
    return pb.collection(C.staff).authWithPassword(email, password).then(function (authData) {
      var rec = authData.record;
      if (rec.active === false) {
        pb.authStore.clear();
        throw err("DISABLED", "評審帳號已停用。");
      }
      if (rec.role !== "judge" && rec.role !== "admin") {
        pb.authStore.clear();
        throw err("FORBIDDEN", "此帳號沒有評審權限。");
      }
      return ok({
        judgeId: rec.id,
        name: rec.name || email,
        role: rec.role,
        email: rec.email
      });
    });
  }

  function judgeLogout() {
    pb.authStore.clear();
    return Promise.resolve(ok({ ok: true }));
  }

  function judgeListClubs() {
    return requireJudge().then(function () {
      return getActivity().then(function (activity) {
        return pb.collection(C.clubs).getFullList({
          filter: 'activity="' + activity.id + '" && active=true',
          sort: "name"
        }).then(function (clubs) {
          return ok({
            activityId: activity.activity_id,
            clubs: clubs.map(function (c) {
              return {
                id: c.id,
                permanentClubId: c.permanent_club_id,
                clubName: c.name,
                category: c.category || ""
              };
            })
          });
        });
      });
    });
  }

  function judgeListClubFiles(data) {
    return requireJudge().then(function () {
      var clubId = String((data && (data.clubId || data.permanentClubId)) || "").trim();
      if (!clubId) return Promise.reject(err("INVALID_INPUT", "缺少社團。"));
      return getActivity().then(function (activity) {
        var clubPromise = clubId.indexOf("DEMO") >= 0 || clubId.indexOf("-") >= 0
          ? pb.collection(C.clubs).getFirstListItem(
              'activity="' + activity.id + '" && permanent_club_id="' + clubId + '"'
            ).catch(function () {
              return pb.collection(C.clubs).getOne(clubId);
            })
          : pb.collection(C.clubs).getOne(clubId).catch(function () {
              return pb.collection(C.clubs).getFirstListItem(
                'activity="' + activity.id + '" && permanent_club_id="' + clubId + '"'
              );
            });
        return clubPromise.then(function (club) {
          return pb.collection(C.uploads).getFullList({
            filter: 'club="' + club.id + '" && status="completed"',
            sort: "-created"
          }).then(function (rows) {
            return pb.collection(C.folders).getFullList({
              filter: 'club="' + club.id + '" && trashed!=true',
              sort: "name"
            }).then(function (folders) {
              return ok({
                clubId: club.id,
                permanentClubId: club.permanent_club_id,
                clubName: club.name,
                folders: folders.map(function (f) {
                  return { id: f.id, name: f.name, parent: f.parent || "", kind: f.kind };
                }),
                files: rows.map(mapUploadFile)
              });
            });
          });
        });
      });
    });
  }

  function judgeGetScore(data) {
    return requireJudge().then(function (judge) {
      var clubId = String((data && data.clubId) || "").trim();
      var sectionId = String((data && data.sectionId) || "default").trim();
      if (!clubId) return Promise.reject(err("INVALID_INPUT", "缺少社團。"));
      return pb.collection(C.scores).getList(1, 1, {
        filter:
          'club="' + clubId + '" && judge="' + judge.id + '" && section_id="' + sectionId + '"',
        sort: "-updated"
      }).then(function (res) {
        var row = (res.items && res.items[0]) || null;
        return ok({
          score: row
            ? {
                id: row.id,
                score: row.score,
                comment: row.comment || "",
                answers: row.answers_json || {},
                status: row.status,
                revision: row.revision || 1,
                submittedAt: row.submitted_at || null
              }
            : null
        });
      });
    });
  }

  function judgeSubmitScore(data) {
    return requireJudge().then(function (judge) {
      var clubId = String((data && data.clubId) || "").trim();
      var sectionId = String((data && data.sectionId) || "default").trim();
      var scoreVal = Number(data && data.score);
      var comment = String((data && data.comment) || "");
      var answers = (data && data.answers) || {};
      var status = (data && data.status) === "draft" ? "draft" : "submitted";
      if (!clubId) return Promise.reject(err("INVALID_INPUT", "缺少社團。"));
      if (!Number.isFinite(scoreVal)) {
        return Promise.reject(err("INVALID_INPUT", "分數格式錯誤。"));
      }
      return getActivity().then(function (activity) {
        return pb.collection(C.scores).getList(1, 1, {
          filter:
            'club="' + clubId + '" && judge="' + judge.id + '" && section_id="' + sectionId + '"'
        }).then(function (res) {
          var payload = {
            activity: activity.id,
            club: clubId,
            judge: judge.id,
            section_id: sectionId,
            score: scoreVal,
            comment: comment,
            answers_json: answers,
            status: status,
            revision: 1,
            submitted_at: status === "submitted" ? new Date().toISOString() : null
          };
          if (res.totalItems > 0) {
            var prev = res.items[0];
            payload.revision = Number(prev.revision || 1) + 1;
            return pb.collection(C.scores).update(prev.id, payload).then(function (row) {
              return ok({ id: row.id, revision: row.revision, status: row.status });
            });
          }
          return pb.collection(C.scores).create(payload).then(function (row) {
            return ok({ id: row.id, revision: row.revision, status: row.status });
          });
        });
      });
    });
  }

  var handlers = {
    listActiveClubsForRegistration: listActiveClubsForRegistration,
    registerClubStudent: registerClubStudent,
    getClubStudentAccessState: getClubStudentAccessState,
    changeClubStudentPassword: changeClubStudentPassword,
    getClubStudentForgotPasswordContact: getClubStudentForgotPasswordContact,
    cleanupClubStudentRegistrationOp: cleanupClubStudentRegistrationOp,
    reconcileClubStudentPasswordChange: reconcileClubStudentPasswordChange,
    listClubDriveUploads: listClubDriveUploads,
    listClubEvaluationFolders: listClubEvaluationFolders,
    createClubEvaluationFolder: createClubEvaluationFolder,
    trashClubEvaluationFile: trashClubEvaluationFile,
    trashClubEvaluationFolder: trashClubEvaluationFolder,
    renameClubEvaluationFile: renameClubEvaluationFile,
    renameClubEvaluationFolder: renameClubEvaluationFolder,
    moveClubEvaluationFile: moveClubEvaluationFile,
    moveClubEvaluationFolder: moveClubEvaluationFolder,
    listClubEvaluationTrash: listClubEvaluationTrash,
    restoreClubEvaluationItem: restoreClubEvaluationItem,
    prepareClubDriveUpload: prepareClubDriveUpload,
    completeClubDriveUpload: completeClubDriveUpload,
    judgeLogin: judgeLogin,
    judgeLogout: judgeLogout,
    judgeListClubs: judgeListClubs,
    judgeListClubFiles: judgeListClubFiles,
    judgeGetScore: judgeGetScore,
    judgeSubmitScore: judgeSubmitScore
  };

  function call(name, data) {
    var fn = handlers[name];
    if (!fn) {
      return Promise.reject(err("UNIMPLEMENTED", "PocketBase 尚未實作：" + name));
    }
    return Promise.resolve()
      .then(function () { return fn(data || {}); })
      .then(function (result) {
        // complete may already be full result
        if (result && result.data !== undefined && name === "completeClubDriveUpload") {
          return result;
        }
        return result;
      });
  }

  root.HKSP_PB_BACKEND = {
    pb: pb,
    call: call,
    publicRequest: publicRequest,
    getAuth: function () { return authShim; },
    uploadFile: uploadFile,
    isEnabled: function () { return !!cfg.usePocketBase; }
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
