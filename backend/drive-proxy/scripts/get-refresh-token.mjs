/**
 * 本機取得 Google OAuth refresh token（持有帳）。
 *
 * 前置：
 * 1. Google Cloud 專案已啟用 Google Drive API
 * 2. 建立 OAuth 用戶端「電腦應用程式」(Desktop)
 * 3. 把 Client ID / Secret 填進下方或環境變數
 *
 * 用法：
 *   set GOOGLE_CLIENT_ID=xxx
 *   set GOOGLE_CLIENT_SECRET=yyy
 *   node scripts/get-refresh-token.mjs
 */
import http from "node:http";
import { URL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const REDIRECT = "http://127.0.0.1:53682/oauth2callback";
const SCOPE = [
  "https://www.googleapis.com/auth/drive",
  "openid",
  "email",
  "profile"
].join(" ");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("請先設定環境變數 GOOGLE_CLIENT_ID 與 GOOGLE_CLIENT_SECRET");
  process.exit(1);
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: SCOPE
  }).toString();

console.log("\n1) 用「持有帳」Google 登入並同意授權：\n");
console.log(authUrl);
console.log("\n2) 授權後瀏覽器會跳回本機，腳本會自動收下 code。\n");

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url || "/", REDIRECT);
      if (u.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const err = u.searchParams.get("error");
      const c = u.searchParams.get("code");
      if (err) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("授權失敗：" + err);
        reject(new Error(err));
        server.close();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<h3>授權成功，可關閉此分頁回到終端機。</h3>");
      resolve(c);
      server.close();
    } catch (e) {
      reject(e);
      server.close();
    }
  });
  server.listen(53682, "127.0.0.1", () => {
    console.log("等待 OAuth callback：http://127.0.0.1:53682/oauth2callback");
  });
});

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT,
    grant_type: "authorization_code"
  })
});
const tokenJson = await tokenRes.json();
if (!tokenRes.ok) {
  console.error("換 token 失敗：", tokenJson);
  process.exit(1);
}

console.log("\n=== 請把下列內容寫入 backend/drive-proxy/.env ===\n");
console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`);
console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`);
console.log(`GOOGLE_REFRESH_TOKEN=${tokenJson.refresh_token || "(本次沒有 refresh_token，請用 prompt=consent 重試)"}`);
console.log(`GOOGLE_HOLDER_EMAIL=(授權時使用的 Gmail，稍後可用 /health 核對)`);
console.log(`DRIVE_ROOT_FOLDER_ID=16G4v0Xrc7t0PjjOuor-68BokJXBGl6Jg`);
console.log(`DRIVE_ENABLED=true`);
console.log(`PB_URL=https://db.keson.pro`);
console.log("\naccess_token 會過期，Proxy 會用 refresh_token 自動換新，不必手抄 access_token。\n");

if (!tokenJson.refresh_token) {
  const rl = createInterface({ input, output });
  await rl.question("沒拿到 refresh_token。到 Cloud Console 撤銷測試授權後再跑一次。按 Enter 結束…");
  rl.close();
}
