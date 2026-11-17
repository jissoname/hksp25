# HKSP 測試帳密

活動：`115-1-club-evaluation`  
社團：`DEMO-CLUB-001`

## 學生端（`index.html`）

| 欄位 | 值 |
|---|---|
| 學號 | `DEMO001` |
| 密碼 | `TestStu123!` |
| 說明 | 已綁示範社團；`must_change_password=false`，登入後可直接上傳 |

| 欄位 | 值 |
|---|---|
| 學號 | `REGONLINE1` |
| 密碼 | `OnlinePass1!` |
| 說明 | 正式註冊＋改密煙測帳（已完成強制改密） |

也可在註冊頁先選屬性再選正式社團，或選 `示範社團（測試）`（`DEMO-CLUB-001`），用**未使用過的學號**＋生日自測註冊→強制改密。

重建社團名單：

```powershell
powershell -File scripts/pb-seed-clubs-115-1.ps1
```

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
