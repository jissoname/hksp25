/**
 * Firebase Web 客戶端設定（hksp25-web）
 * 學號登入映射（前後端一致）：
 *   authEmail = `${normalize(studentId).toLowerCase()}@stu.hksp25.invalid`
 * 畫面只收集學號／密碼；勿要求學生另填電子郵件。
 * Emulator：URL 含 emulator=1 或 localhost 時改連 demo-hksp-student。
 */
(function (root) {
  var STUDENT_AUTH_EMAIL_DOMAIN = "stu.hksp25.invalid";
  var CURRENT_ACTIVITY_ID = "115-1-club-evaluation";
  var DEMO_PROJECT_ID = "demo-hksp-student";
  /** 忘記密碼：對外聯絡／核身（密碼重設仍由有權限管理員執行） */
  var FORGOT_PASSWORD_ASSIST_URL = "https://www.instagram.com/bs_kai_0102/";
  var FORGOT_PASSWORD_ASSIST_LABEL = "忘記密碼？聯絡帳號協助窗口";

  var productionConfig = {
    apiKey: "AIzaSyCqKEvzH2FJk0WNMX80YkCQHjvluaxt_8k",
    authDomain: "hksp25-club-platform.firebaseapp.com",
    projectId: "hksp25-club-platform",
    storageBucket: "hksp25-club-platform.firebasestorage.app",
    messagingSenderId: "354462005967",
    appId: "1:354462005967:web:5e8971d2d0936305dad5ba",
    measurementId: "G-JH5RE960DD"
  };

  function isEmulatorPage() {
    if (typeof location === "undefined") return false;
    var q = location.search || "";
    if (q.indexOf("emulator=1") >= 0) return true;
    var host = location.hostname || "";
    return host === "localhost" || host === "127.0.0.1";
  }

  function getConfig() {
    if (!isEmulatorPage()) return productionConfig;
    return {
      apiKey: "demo-api-key",
      authDomain: "localhost",
      projectId: DEMO_PROJECT_ID,
      storageBucket: DEMO_PROJECT_ID + ".appspot.com",
      messagingSenderId: "123456789012",
      appId: "1:123456789012:web:demo"
    };
  }

  function normalizeStudentId(studentId) {
    return String(studentId || "").trim().toUpperCase();
  }

  function studentIdToAuthEmail(studentId) {
    return normalizeStudentId(studentId).toLowerCase() + "@" + STUDENT_AUTH_EMAIL_DOMAIN;
  }

  function connectEmulatorsIfNeeded(auth, functions, firestore) {
    if (!isEmulatorPage()) return false;
    if (auth && typeof auth.useEmulator === "function") {
      auth.useEmulator("http://127.0.0.1:9099");
    }
    if (functions && typeof functions.useEmulator === "function") {
      functions.useEmulator("127.0.0.1", 5001);
    }
    if (firestore && typeof firestore.useEmulator === "function") {
      firestore.useEmulator("127.0.0.1", 8080);
    }
    return true;
  }

  function openForgotPasswordAssist() {
    if (typeof window === "undefined" || !window.open) return false;
    window.open(FORGOT_PASSWORD_ASSIST_URL, "_blank", "noopener,noreferrer");
    return true;
  }

  var api = {
    config: getConfig(),
    productionConfig: productionConfig,
    DEMO_PROJECT_ID: DEMO_PROJECT_ID,
    CURRENT_ACTIVITY_ID: CURRENT_ACTIVITY_ID,
    STUDENT_AUTH_EMAIL_DOMAIN: STUDENT_AUTH_EMAIL_DOMAIN,
    FORGOT_PASSWORD_ASSIST_URL: FORGOT_PASSWORD_ASSIST_URL,
    FORGOT_PASSWORD_ASSIST_LABEL: FORGOT_PASSWORD_ASSIST_LABEL,
    isEmulatorPage: isEmulatorPage,
    normalizeStudentId: normalizeStudentId,
    studentIdToAuthEmail: studentIdToAuthEmail,
    connectEmulatorsIfNeeded: connectEmulatorsIfNeeded,
    openForgotPasswordAssist: openForgotPasswordAssist
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.HKSP_FIREBASE_CLIENT = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
