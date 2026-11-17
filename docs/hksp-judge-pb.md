# HKSP 評審（PocketBase）

## 現況

- **正式評審台**：[`judge.html`](../judge.html)（預設接 PocketBase；`?gas=1` 可回舊 GAS）
- **最小煙測頁**：[`judge-pb.html`](../judge-pb.html)（單分＋檔案列表）
- Adapter：[`platform-judge-pb.js`](../platform-judge-pb.js)
- 配分表：`hksp_activities.config_json.scoreConfig`（管理端可編輯／發布）
- 分數：`hksp_scores`（小項分數存 `answers_json.scores`；鎖定／解鎖語意在 `answers_json`）

## 測試帳

見 [hksp-test-accounts.md](./hksp-test-accounts.md)

| 角色 | Email | 密碼 |
|---|---|---|
| 評審／管理超管 | `hksp_6188@hk.edu.tw` | `921020` |
| 示範評審 | `judge.demo@hksp.local` | `JudgeDemo123!` |

## 操作

1. 本機靜態站：`http://127.0.0.1:28222/judge.html`
2. 登入 → 選大項 → 開社團 → 填小項 → 本機草稿／正式送出（送出後鎖定）
3. 管理員於 `admin.html` 評分進度可解鎖（`adminUnlockJudgeScore`）

## 已接 PB

- `judgeLogin` / `judgeLogout`
- `judgeScoreDashboard`
- `judgeGetScore`（回傳 `stage.criteria` + `record`）
- `judgeSubmitScore`（`scores` map）
- 管理：`adminGetScoreConfig` / `adminSaveScoreConfig` / `adminSetScorePhasePublished` / `adminUnlockJudgeScore` / `adminJudgeScoreProgress`

## 管理端（PB）

- 已接：成績彙整、排名規則／各屬性排名、各屬性排名 CSV、主辦核對 CSV
- 尚未接：評審確認單 PDF／批次 ZIP（面板仍隱藏）
- 匯出為 UTF-8 CSV（Excel 可開）；非舊版 xlsx base64 版型
