# HKSP 測試帳密

活動：`115-1-club-evaluation`  
社團：`DEMO-CLUB-001`

## 學生端（`index.html`）

| 欄位 | 值 |
|---|---|
| 學號 | `DEMO001` |
| 密碼 | `TestStu123!` |
| 說明 | 已綁示範社團；`must_change_password=false`，登入後可直接上傳 |

## 評審端（`judge-pb.html`）

| 欄位 | 值 |
|---|---|
| Email | `judge.demo@hksp.local` |
| 密碼 | `JudgeDemo123!` |
| 說明 | `hksp_staff` / `role=judge` |

## 重建

```powershell
powershell -File scripts/pb-seed-test-accounts.ps1
```

需本機 `.env` 內有 `PB_URL`、`PB_ADMIN_EMAIL`、`PB_ADMIN_PASSWORD`（不會進 git）。
