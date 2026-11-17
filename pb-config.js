/**
 * PocketBase 公開前端設定（不含超管密鑰）。
 * usePocketBase=true 時，學生端改走 HKSP_PB_BACKEND。
 */
(function (root) {
  var STUDENT_AUTH_EMAIL_DOMAIN = "stu.hksp25.invalid";
  var ACTIVITY_ID = "115-1-club-evaluation";

  var api = {
    usePocketBase: true,
    url: "https://db.keson.pro",
    /** admin.html PocketBase 管理登入預設帳（密碼不寫進前端） */
    staffAdminEmail: "admin@hksp.local",
    /**
     * 正式上線：上傳主路徑 = PocketBase。
     * Drive 代傳已擱置（非主路徑、避免 API 費用）；保持 false。
     */
    useDriveProxy: false,
    driveProxyUrl: "",
    activityId: ACTIVITY_ID,
    collections: {
      staff: "hksp_staff",
      students: "hksp_students",
      activities: "hksp_activities",
      clubs: "hksp_clubs",
      memberships: "hksp_memberships",
      folders: "hksp_folders",
      uploads: "hksp_uploads",
      scores: "hksp_scores",
      audit: "hksp_audit_events"
    },
    STUDENT_AUTH_EMAIL_DOMAIN: STUDENT_AUTH_EMAIL_DOMAIN,
    FORGOT_PASSWORD_ASSIST_URL: "https://www.instagram.com/bs_kai_0102/",
    FORGOT_PASSWORD_ASSIST_LABEL: "忘記密碼？聯絡帳號協助窗口",
    normalizeStudentId: function (studentId) {
      return String(studentId || "").trim().toUpperCase();
    },
    studentIdToAuthEmail: function (studentId) {
      return api.normalizeStudentId(studentId).toLowerCase() + "@" + STUDENT_AUTH_EMAIL_DOMAIN;
    },
    openForgotPasswordAssist: function () {
      if (typeof window === "undefined" || !window.open) return false;
      window.open(api.FORGOT_PASSWORD_ASSIST_URL, "_blank", "noopener,noreferrer");
      return true;
    },
    mapClubCategory: function (raw) {
      var key = String(raw || "").trim();
      var map = {
        "自治": "自治綜合性",
        "學藝": "學藝性",
        "體能": "體能性",
        "服務": "服務性",
        "康樂": "康樂性",
        "其他": "學藝性",
        "全校自治性": "全校自治性",
        "自治綜合性": "自治綜合性",
        "康樂性": "康樂性",
        "服務性": "服務性",
        "體能性": "體能性",
        "學藝性": "學藝性"
      };
      return map[key] || "學藝性";
    }
  };

  root.HKSP_PB_CONFIG = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
