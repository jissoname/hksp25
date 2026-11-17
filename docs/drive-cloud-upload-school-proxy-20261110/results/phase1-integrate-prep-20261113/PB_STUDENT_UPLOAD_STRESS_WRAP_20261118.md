# 學生上傳壓力測試（PocketBase 主路徑）2026-11-18

腳本：`scripts/pb-student-upload-stress.mjs`  
證據：`PB_STUDENT_UPLOAD_STRESS_2026-11-17T20-04-21-601Z.json`

## 範圍

- 正式站目前為 **PocketBase 直傳**（`useDriveProxy=false`），非舊 Firebase Drive 代傳尖峰。
- 階梯：**10 → 30 → 66** 並發；盡量不同社（本輪 66 社）。
- 每 worker：建帳 → 綁 membership → 改密 → 建夾 → 上傳 4KiB PDF → list 確認。
- 結束後已用超管清理 106 組測試列（upload／folder／membership／student）。

## 結果

| 並發 | 成功率 | wall | upload p95 | e2e p95 | 不同社 |
| --- | --- | --- | --- | --- | --- |
| 10 | **100%** | 4.9s | 0.44s | 4.9s | 10 |
| 30 | **100%** | 6.8s | 0.67s | 6.7s | 30 |
| 66 | **100%** | 12.3s | 1.10s | 12.3s | 66 |

閘門（本輪訂標）：成功率 ≥ 99%、upload p95 ≤ 5s、e2e p95 ≤ 15s → **PASS**

## 重跑

```powershell
node scripts/pb-student-upload-stress.mjs
# 可調：STRESS_LEVELS=10,30  STRESS_FILE_BYTES=1048576  STRESS_CLEANUP=0
```
