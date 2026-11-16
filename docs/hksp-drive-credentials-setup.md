# 持有帳 Google 憑證設定（測試）

目標：讓 **Drive Proxy** 用「一個持有帳」把檔案寫進測試資料夾  
`16G4v0Xrc7t0PjjOuor-68BokJXBGl6Jg`  
學生不必被加成編輯者。

## 你要準備什麼

- 對該測試資料夾有**編輯權**的 Google 帳號（建議就是資料夾擁有者）
- 可開 [Google Cloud Console](https://console.cloud.google.com/) 的權限

## 步驟

### 1. 建立／選用 Cloud 專案
1. 開啟 Google Cloud Console  
2. 新建專案（例如 `hksp-drive-test`）或選既有專案

### 2. 啟用 Drive API
1.「API 和服務」→「資料庫」／「已啟用的 API」  
2. 搜尋並啟用 **Google Drive API**

### 3. 設定 OAuth 同意畫面
1.「API 和服務」→「OAuth 同意畫面」  
2. User type 選 **外部**（個人 Gmail 測試用）  
3. 填應用程式名稱（例如 HKSP Drive Proxy）  
4. 測試使用者：把持有帳 Gmail 加進去  
5. Scope 稍後用腳本請求 `drive` + `openid/email/profile` 即可

### 4. 建立 OAuth 用戶端
1.「憑證」→「建立憑證」→「OAuth 用戶端 ID」  
2. 應用程式類型選 **電腦應用程式（Desktop）**  
3. 名稱隨意，建立後複製：
   - Client ID  
   - Client Secret  

> 不要選「網頁應用程式」除非你自己會改 redirect URI。Desktop + 本機 callback 最省事。

### 5. 本機換取 refresh token
在專案目錄執行（PowerShell）：

```powershell
cd backend\drive-proxy
$env:GOOGLE_CLIENT_ID="你的ClientID"
$env:GOOGLE_CLIENT_SECRET="你的ClientSecret"
node scripts\get-refresh-token.mjs
```

瀏覽器會跳出 Google 登入：
- **一定要用持有帳**（對測試資料夾有編輯權的那個）
- 同意 Drive 權限
- 終端機會印出要寫入 `.env` 的內容

### 6. 寫入 `backend/drive-proxy/.env`
最少需要：

```env
PORT=28223
PB_URL=https://db.keson.pro
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
GOOGLE_HOLDER_EMAIL=你的持有帳@gmail.com
DRIVE_ROOT_FOLDER_ID=16G4v0Xrc7t0PjjOuor-68BokJXBGl6Jg
DRIVE_ENABLED=true
```

### 7. 回報我
跟我說「憑證好了」，我會：
1. 接上 Proxy 真上傳（在測試 root 下建社團子資料夾）  
2. 把前端 `prepare/complete` 改打 Proxy  
3. 用一支測試檔驗證出現在你的 Drive 資料夾

## 注意

- `refresh_token`、Client Secret **只放** `backend/drive-proxy/.env`，不要貼到聊天、不要進 git  
- 正式環境再改成校方 `hk_activity@hk.edu.tw` 持有帳  
- Service Account 也行，但要把測試資料夾「共用給服務帳號 email」；個人測試用 OAuth 較直覺  
