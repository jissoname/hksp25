# HKSP 測試帳密

活動：`115-1-club-evaluation`  
社團：`DEMO-CLUB-001`

## 學生端（`index.html`；舊 `student.html` 已改導向至此）

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

## 管理端（`admin.html` · PocketBase 預設）

| 欄位 | 值 |
|---|---|
| Email | `hksp_6188@hk.edu.tw` |
| 密碼 | `921020` |
| 說明 | `hksp_staff` / `role=admin`（`admin.html` 後台總管理員）。驗收上傳：登入後開「社團上傳資料」面板瀏覽／下載，不必進 PB 後台；可用 `?gas=1` 回舊 GAS |

## 評審端（`judge.html` 完整 UI · PocketBase 預設）

| 欄位 | 值 |
|---|---|
| Email | `hksp_6188@hk.edu.tw` |
| 密碼 | `921020` |
| 說明 | 與後台同帳；`role=admin` 亦可登入評審端。示範評審 `judge.demo@hksp.local` / `JudgeDemo123!` 仍可用 |

正式入口請用 `judge.html`。可選煙測頁：`judge-pb.html`（同上帳密）。

## 業務超管（`hksp_staff` / `role=admin`）

帳密不進 git。於 `.env` 填 `HKSP_STAFF_ADMIN_EMAIL`／`HKSP_STAFF_ADMIN_PASSWORD` 後：

```powershell
powershell -File scripts/pb-apply-admin-acl.ps1
powershell -File scripts/pb-seed-staff-admin.ps1
```

權限矩陣：見 [hksp-admin-acl.md](./hksp-admin-acl.md)。建立業務超管前需先有 PocketBase `_superusers`（`.env` 的 `PB_ADMIN_*`）。

## 重建

```powershell
powershell -File scripts/pb-seed-test-accounts.ps1
```

需本機 `.env` 內有 `PB_URL`、`PB_ADMIN_EMAIL`、`PB_ADMIN_PASSWORD`（不會進 git）。
