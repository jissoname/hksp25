# 讓 Drive 代傳離機也能用（Cloud Run）

本機 `node server.js` 關機就停。改部署到 **Google Cloud Run** 後，學生上傳不依賴你的電腦。

## 前置

1. 安裝 [Google Cloud SDK](https://cloud.google.com/sdk/docs/install)（`gcloud`）
2. 專案建議用你已有的 OAuth 專案（例如 `keson789`）
3. 專案需開啟計費（Cloud Run 有免費額度，但仍要綁帳單）
4. `backend/drive-proxy/.env` 已填好 OAuth／Drive root／PB

```powershell
gcloud auth login
gcloud config set project keson789
```

## 一鍵部署

```powershell
cd backend\drive-proxy
powershell -File scripts\deploy-cloud-run.ps1 -ProjectId keson789 -Region asia-east1
```

成功後終端機會印出例如：

```text
SERVICE_URL=https://hksp-drive-proxy-xxxxx-de.a.run.app
```

## 部署後改前端／PB

1. [`pb-config.js`](../pb-config.js)

```js
useDriveProxy: true,
driveProxyUrl: "https://hksp-drive-proxy-xxxxx-de.a.run.app",
```

2. PocketBase `hksp_drive_config`（key=`default`）  
   - `proxy_base_url` = 同上  
   - `enabled` = true  

3. 前端靜態站可繼續放 Vercel／任何靜態託管；**不必**再開本機 proxy

## 驗證

```powershell
curl https://你的服務網址/health
```

應看到 `driveReachable: true`。

## 費用與安全

- 無流量時 Cloud Run 可縮到 0（冷啟動約 1–3 秒）
- Google Client Secret／refresh token 在 Cloud Run 環境變數，勿提交 git
- 正式上線建議再改 Secret Manager，並限制 CORS 來源
