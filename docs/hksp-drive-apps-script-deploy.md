# 離機也能上傳：Google Apps Script 代傳（免開本機、免 Cloud Run 計費）

你的 GCP 專案目前**沒開 Billing**，Cloud Run 部署不了。  
改用 **Apps Script Web App**：跑在 Google 雲端，身分就是持有帳，關電腦也可用。

## 部署步驟（約 5 分鐘）

1. 開啟 [script.google.com](https://script.google.com) → **新增專案**
2. 刪除預設 `Code.gs` 內容，貼上本倉 [`backend/drive-apps-script/Code.gs`](../backend/drive-apps-script/Code.gs)
3. 左側「專案設定」→ **指令碼屬性** 新增：
   - `PB_URL` = `https://db.keson.pro`
   - `DRIVE_ROOT_FOLDER_ID` = `16G4v0Xrc7t0PjjOuor-68BokJXBGl6Jg`
4. **部署** → **新增部署作業** → 類型選 **網頁應用程式**
   - 執行身分：**我**
   - 具有存取權的使用者：**任何人**
5. 授權（用 `keson3179@gmail.com`，需對測試資料夾有編輯權）
6. 複製 **網頁應用程式網址**（形如 `https://script.google.com/macros/s/XXXX/exec`）

## 告訴我網址後我會改

- `pb-config.js` 的 `driveProxyUrl`
- 前端改走 Apps Script（`pbToken` + Base64 上傳，因瀏覽器不易帶 Authorization 給 GAS）

## 限制（先知道）

- 單檔建議 **≤ 25–40MB**（Apps Script 配額較緊；大檔之後再上 Cloud Run）
- 冷啟動偶發較慢

## 之後若要開 Cloud Run

開好專案計費後再跑：

```powershell
cd backend\drive-proxy
powershell -File scripts\deploy-cloud-run.ps1 -ProjectId hksp-514915
```
