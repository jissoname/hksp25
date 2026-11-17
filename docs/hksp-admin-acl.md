# HKSP 後端超管權限（`hksp_staff` / `role=admin`）

適用後端：`https://db.keson.pro`  
集合命名空間：`hksp_*`（勿與助學金 `hk_*` 混用）

## 兩層帳號（勿混）

| 層 | 身分 | 用途 | 本機變數 |
|---|---|---|---|
| A. PocketBase 超管 | `_superusers` | 建 schema、改 collection rules、用腳本 seed | `PB_ADMIN_EMAIL` / `PB_ADMIN_PASSWORD` |
| B. 業務超管 | `hksp_staff` + `role=admin` + `active=true` | 前台／API 管理社團、學生、活動、上傳稽核 | `HKSP_STAFF_ADMIN_EMAIL` / `HKSP_STAFF_ADMIN_PASSWORD` |

- A 繞過 API rules，**不要**放進前端。
- B 完全受下列 API rules 約束；首筆 B 帳須由 A（或 Admin UI）建立（`hksp_staff.createRule = null`）。

## 角色對照

| `role` | 能力摘要 |
|---|---|
| `admin` | 業務超管：活動／社團／綁定／資料夾／上傳／分數刪除／稽核讀取 |
| `judge` | 評審：讀上傳、寫自己的分數 |
| `service` | 服務帳：稽核讀取、部分 staff 檢視 |

## Collection API rules（`admin` 視角）

規則字串以 `scripts/pb-setup-hksp.ps1` 為準；可用 `scripts/pb-apply-admin-acl.ps1` 冪等套用到 live。

| Collection | list / view | create | update | delete |
|---|---|---|---|---|
| `hksp_staff` | 已登入且 active 的 staff 可 list；view 限本人，或 admin／service | **僅 A 層**（`null`） | 本人，或 admin | **僅 A 層**（`null`） |
| `hksp_students` | 本人或任一 active staff | 公開自助註冊（`""`） | 本人或 admin | 僅 A |
| `hksp_activities` | active 公開，或任一 active staff | **admin** | **admin** | **admin** |
| `hksp_clubs` | active 公開，或任一 active staff | **admin** | **admin** | **admin** |
| `hksp_memberships` | staff 或本人學生 | 學生自綁或 **admin** | **admin** | **admin** |
| `hksp_folders` | 已登入者 | admin 或學生 | admin 或學生 | admin 或學生 |
| `hksp_uploads` | staff 或**同社有效成員**（含上傳者） | 學生本人或 **admin** | 同社有效成員或任一 active staff | **admin** 或同社有效成員 |
| `hksp_scores` | admin／judge／service | admin／judge | admin／judge | **admin** |
| `hksp_audit_events` | admin／service | 任一已登入者可寫事件 | 不可改 | 不可刪 |

## 前端／API

- 評審頁 `judge-pb.html`：`platform-pb-backend.js` 允許 `role=judge` **或** `admin` 登入評審流程。
- 完整 `admin.html` 尚未遷到 PB；業務超管先以 API／Admin UI／後續管理頁操作。

## 建立順序

1. 填 `.env` 的 `PB_ADMIN_*`（A 層；若已有 token 可只填 `PB_ADMIN_TOKEN`）
2. 執行 `powershell -File scripts/pb-apply-admin-acl.ps1`（寫入／校正權限）
3. 填 `HKSP_STAFF_ADMIN_EMAIL`／`HKSP_STAFF_ADMIN_PASSWORD`（B 層）
4. 執行 `powershell -File scripts/pb-seed-staff-admin.ps1`（建立或更新業務超管）
