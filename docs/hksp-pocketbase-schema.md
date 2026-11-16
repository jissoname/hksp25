# HKSP PocketBase Schema

後端：`https://db.keson.pro`  
命名空間：`hksp_*`（社團評鑑）  
注意：既有 `hk_*` 是助學金系統，**不要混用**。

## Collections

| Collection | 類型 | 用途 |
|---|---|---|
| `hksp_staff` | auth | 管理員／評審／服務帳 |
| `hksp_students` | auth | 學生帳（`student_id` 唯一） |
| `hksp_activities` | base | 活動（`activity_id` 唯一） |
| `hksp_clubs` | base | 社團（活動內 `permanent_club_id` 唯一） |
| `hksp_memberships` | base | 學生↔社團綁定 |
| `hksp_folders` | base | 評鑑資料夾樹（可對應 Drive folder id） |
| `hksp_uploads` | base | 上傳紀錄（PB file + 可選 Drive file id） |
| `hksp_scores` | base | 評審分數 |
| `hksp_audit_events` | base | 稽核事件 |
| `hksp_drive_config` | base | Drive 代傳開關／持有帳／root／proxy URL |

## Seed

- 活動：`activity_id = 115-1-club-evaluation`（已建立）
- 示範社團：`DEMO-CLUB-001`
- 示範評審：`judge.demo@hksp.local` / `JudgeDemo123!`（`hksp_staff.role=judge`）
- Drive 設定：`hksp_drive_config.key=default`（PB 為主時可不啟用代傳）

## 檔案策略

- **現行主路徑**：`hksp_uploads.file`（PocketBase，支援整夾／大檔；無需 GCP 計費）
- **後端單檔上限**：`file.maxSize = 10GiB`（前端不顯示此數字；過大僅提示「檔案過大」）
- **可選鏡射**：Apps Script／Drive proxy 回寫 `drive_file_id`／`drive_folder_id`（`useDriveProxy=false` 預設關閉）
- 布局說明：見 [hksp-backend-layout.md](./hksp-backend-layout.md)
- 評審說明：見 [hksp-judge-pb.md](./hksp-judge-pb.md)

## 前端接線

- `pb-config.js`：`usePocketBase=true`；`useDriveProxy=false`
- `platform-pb-backend.js`：學生 callable + 評審 API
- `index.html`：學生端
- `judge-pb.html`：評審最小頁（登入／清單／打分）

## 重建指令

```powershell
powershell -File scripts/pb-setup-hksp-rest.ps1
```

腳本具冪等：已存在的 collection 不會重建。
