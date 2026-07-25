# 客製郵件群發（Mail Merge Web）

純前端的郵件合併群發工具：使用者用自己的 Google 或 Microsoft 帳號登入，貼上名單、寫模板（`{{變數}}` 填空）、逐筆對應附件，信件由使用者自己的信箱寄出（會出現在寄件備份）。**無後端、無資料庫**——名單、模板、附件、token 全部只存在使用者的瀏覽器記憶體。

## 本機啟動

OAuth 不接受 `file://`，要用本機伺服器：

```bash
cd ~/Downloads/mailmerge-web && python3 -m http.server 8000
```

然後開 `http://localhost:8000`。（下面兩個平台設定時，來源／導向 URI 都要填這個網址。）

## 一次性設定

### Google（Gmail 寄信）

1. [Google Cloud Console](https://console.cloud.google.com/) → 建立專案
2. 「API 和服務」→「程式庫」→ 啟用 **Gmail API**
3. 「OAuth 同意畫面」→ User Type 選 **External** → 填 app 名稱與聯絡信箱 → Scopes 加入 `gmail.send` → **Test users** 加入你自己的 Gmail（測試模式最多 100 人）
4. 「憑證」→ 建立憑證 → **OAuth 用戶端 ID** → 類型選「網頁應用程式」→ 「已授權的 JavaScript 來源」加 `http://localhost:8000` 與正式網域
5. 把 Client ID 填進 `config.js` 的 `GOOGLE_CLIENT_ID`

> 公開上線：`gmail.send` 是**敏感（sensitive）scope**，需要通過 Google OAuth app 驗證——網域所有權驗證＋首頁＋隱私政策＋英文示範影片，**免費**，不需 CASA 資安評估（CASA 只有 restricted scope，如 `gmail.readonly`、`mail.google.com` 才要）。開發與測試模式不受影響。送審步驟與可複製文案見 [`docs/google-verification.md`](docs/google-verification.md)。

### Microsoft（Outlook / M365 寄信）

1. [Microsoft Entra 管理中心](https://entra.microsoft.com/) →「應用程式註冊」→「新增註冊」
2. 支援的帳戶類型選「**任何組織目錄中的帳戶及個人 Microsoft 帳戶**」
3. 「重新導向 URI」平台選 **單頁應用程式（SPA）**，填 `http://localhost:8000`（正式網域另外加一筆）
4. 「API 權限」→ 新增 → Microsoft Graph → 委派權限 → **Mail.Send**
5. 把「應用程式（用戶端）識別碼」填進 `config.js` 的 `MS_CLIENT_ID`

## 部署

整個資料夾丟任何靜態託管（Cloudflare Pages / GitHub Pages / Netlify）即可，沒有環境變數與伺服器設定；記得回兩個平台把正式網域加進授權來源／導向 URI。

## 檔案

| 檔案 | 用途 |
|---|---|
| `index.html` | 版面：登入列＋三步驟（名單／模板／寄送） |
| `style.css` | 樣式 |
| `config.js` | 兩個平台的 Client ID |
| `js/auth.js` | Google GIS＋MSAL 登入、token 記憶體管理與靜默續期 |
| `js/mail.js` | MIME 組裝、Gmail API／Graph 寄送、429/5xx 退避重試 |
| `js/app.js` | 匯入解析（貼上 TSV／CSV／XLSX）、驗證、模板膠囊編輯器、預覽、寄送引擎 |

## 規格備忘

- 名單匯入：貼上（TSV）、`.csv`、`.xlsx`（SheetJS 前端解析）；第一列＝欄位名
- 收件人欄自動偵測（掃 @ 比例最高的欄）；附件欄自動抓名稱含「附件／attach」的欄
- 附件欄一格多檔用 `;` 分隔；「共同附件」每封都夾
- 單信附件上限：Gmail 15MB、Microsoft 3MB（Graph 直寄限制），超過的列會標示且不寄
- 寄送節流：每封間隔 1.1 秒；429/5xx（伺服器明確拒收）才自動退避重試；**網路層錯誤不重試**（請求可能已送達，自動重試會重複寄出），提示使用者查寄件備份後人工決定
- Gmail 走 JSON 端點（`messages/send` + base64url raw），不用 upload 端點——實測部分環境會攔 UploadServer 的回應，造成「已寄出但前端以為失敗」
- 日限額（平台方規定）：Gmail 免費帳號約 500 封/天、Workspace 約 2000 封/天、Microsoft 個人帳號約 300 封/天
