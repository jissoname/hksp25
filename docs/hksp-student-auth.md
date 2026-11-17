# HKSP 學生註冊／改密（正式上線）

入口：[`index.html`](../index.html)（PocketBase）

## 註冊

1. 先選「社團屬性」，再選「社團名稱」（資料來源：`scripts/hksp-clubs-115-1.json`／`listActiveClubsForRegistration`）
2. 填學號 + 西元生日 `YYYYMMDD`（初始密碼）
3. 建立 `hksp_students` 後自動登入，並綁定 `hksp_memberships`
4. `must_change_password=true` → 強制進入改密頁，完成前不可上傳

既有學號再註冊：會提示先登入；登入後自動補綁本活動社團（不再用生日重建帳號）。

## 改密

- 須已登入
- 新密碼至少 8 碼，且不可與目前密碼相同
- 成功後清除 session，需以新密碼重新登入

## 忘記密碼

登入卡「忘記密碼」開啟協助窗口（`pb-config.js` 的 `FORGOT_PASSWORD_ASSIST_URL`）。

## PocketBase 規則要點

| Collection | 重點 |
|---|---|
| `hksp_students` | `createRule=""`（可自助註冊）；本人可 update／改密 |
| `hksp_memberships` | 僅可為 **自己的** `student` 建立／讀取；管理員除外 |
| `hksp_clubs` / `hksp_activities` | `active=true` 可公開列出供註冊選單 |

## 測試帳

見 [hksp-test-accounts.md](./hksp-test-accounts.md)。新註冊流程可另用未使用過的學號自測。
