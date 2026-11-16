# HKSP Drive Proxy

校方 Google Drive 代傳服務骨架。

## 原則

- 學生只用 PocketBase 登入
- Google token 只留在這個服務
- 持有帳預期：`hk_activity@hk.edu.tw`

## 本機

```bash
cp .env.example .env
npm start
curl http://127.0.0.1:8787/health
```

目前 `DRIVE_ENABLED=false`：`/v1/prepare` 等會回 `DRIVE_NOT_ENABLED`（布局階段正常）。

## API

| Method | Path | 說明 |
|---|---|---|
| GET | `/health` | 健康檢查 |
| POST | `/v1/prepare` | 建立上傳工作階段（待接 Drive） |
| POST | `/v1/complete` | 確認檔案並寫回 PB |
| POST | `/v1/ensure-club-folder` | 確保社團 Drive 資料夾 |

請求需帶：`Authorization: Bearer <hksp_students_token>`
