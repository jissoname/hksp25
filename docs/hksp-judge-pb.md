# HKSP 評審（PocketBase）

## 現況

- 學生上傳主路徑：PocketBase（`pb-config.js` → `useDriveProxy: false`）
- 評審頁：[`judge-pb.html`](../judge-pb.html)（最小可用；完整 `judge.html` 仍為舊 Firebase 原型）
- API：`platform-pb-backend.js` 的 `judgeLogin` / `judgeListClubs` / `judgeListClubFiles` / `judgeGetScore` / `judgeSubmitScore`

## 測試帳

見 [hksp-test-accounts.md](./hksp-test-accounts.md)（學生 `DEMO001`／評審 `judge.demo@hksp.local`）。

## 操作

1. 本機開靜態站（與學生 `index.html` 相同 origin）
2. 開啟 `/judge-pb.html`
3. 登入 → 選社團 → 開檔 → 存草稿／送出分數
4. 分數寫入 `hksp_scores`（唯一鍵：`activity + club + judge + section_id`）

## 權限要點

- 評審可 **list/view** 社團上傳與資料夾，可 **create/update** 自己的分數
- 學生清單改為社團共用（同社團成員可見全部已上傳檔）
- Drive Apps Script 僅備援，預設不代傳

## 與舊 judge.html

舊頁依賴 Firebase callable／本地評分草稿邏輯，尚未整頁搬遷。新流程請用 `judge-pb.html` 驗證 PB 主路徑。
