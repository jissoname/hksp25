# 全系統 Debug 檢查（2026-11-18）

腳本：`scripts/pb-full-debug-check.mjs`  
證據：`FULL_DEBUG_CHECK_2026-11-17T20-13-52-769Z.json`

## 總評

**PASS（50／50）** — PocketBase 主路徑、雙站前端、帳號、學生上傳煙測、評審 flash-gone 標記皆過。

## 通過摘要

| 區塊 | 結果 |
| --- | --- |
| 本機設定 | `usePocketBase=true`、`useDriveProxy=false`、無密鑰外洩 |
| PB | health 200；活動存在；70 啟用社團；7 collections 可達 |
| 配分表 | `config_json.scoreConfig` rev **46**、**5** 大項皆 judge／published |
| 時程文案 | 含觀摩 `15:30–16:00` |
| 登入 | staff admin、judge demo、student DEMO001 皆可 |
| 學生上傳煙測 | create→auth→membership→folder→upload→confirm→cleanup |
| 前端雙站 | `hksp25`／`hksp25-1uox`：index／judge／admin／privacy／pb-config 200 |
| 評審 cache | 雙站 `platform-judge-pb.js?v=score-persist-4` |
| 本地修正 | `rememberRecentSubmitGuard_`／score map 在庫 |
| 壓測證據 | 10→30→66 先前 PASS |

## 觀察（非阻擋）

- 目前 `submitted` 分數 **1** 筆：`sec-materials`／學生會／40 分／locked（對得上現行 section id，無 orphan）。
- 大項名稱現況：資料審查、**課指組**、學生會、學生議會、實地審查（max 50／16／7／7／20）。
- 已清掉殘留煙測帳 `S549227`。

## 重跑

```powershell
node scripts/pb-full-debug-check.mjs
```
