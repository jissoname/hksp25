# HKSP 正式上線收斂（115-1）

## 範圍

| 項目 | 狀態 |
|---|---|
| 學生／評審／管理靜態站 | PocketBase 主路徑 |
| 檔案上傳 | PocketBase（非整站依賴 Drive Proxy） |
| Drive 代傳／Secret Manager | **不做**（已擱置） |
| 隱私權政策 | `privacy.html` 改為正式開放文案 |

## 前端公開 vs 密鑰

| 位置 | 可放 | 不可放 |
|---|---|---|
| `pb-config.js`、HTML／JS | PB URL、activityId、collection 名、開關 | 超管密碼、OAuth secret、refresh token |
| 本機 `.env`（gitignored） | `PB_ADMIN_*` 供 seed／維運腳本 | 勿複製進 repo／Vercel 公開環境 |
| `backend/drive-proxy/.env` | 僅本機實驗 Drive 時使用 | 正式站不部署此服務 |

## 靜態站託管（Vercel）

專案根目錄已含 `vercel.json`、`.vercelignore`。

```powershell
# 首次：登入後綁專案
npx vercel login
npx vercel --yes

# 正式環境
npx vercel --prod --yes
```

部署後請確認：

1. `https://<你的網域>/index.html` 可註冊／登入  
2. `/judge.html`、`/admin.html`、`/privacy.html` 可開  
3. 瀏覽器 Network 對 `https://db.keson.pro` 無 CORS 阻擋  
4. 頁面原始碼／Response **不含** `PB_ADMIN_PASSWORD`

若 PocketBase 拒跨網域，到 PB Admin → Settings → 確認 API 規則／CORS 允許該靜態網域。

## 上線檢查清單

- [ ] `privacy.html` 文案已是「正式開放」
- [ ] `pb-config.js`：`usePocketBase=true`、`useDriveProxy=false`
- [ ] `.env` 僅本機；未進 git
- [ ] 靜態站已部署且 HTTPS
- [ ] 測試帳可登入；正式截止時間正確
- [ ] 管理／評審入口勿公開貼到公告（或另設簡易門禁）

## 入口

| 角色 | 路徑 |
|---|---|
| 學生 | `/index.html` |
| 評審 | `/judge.html` |
| 管理 | `/admin.html` |
| 隱私 | `/privacy.html` |
