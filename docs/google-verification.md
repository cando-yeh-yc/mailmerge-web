# Google OAuth 驗證送審備忘

**結論先講**：`gmail.send` 是 **sensitive（敏感）scope**，不是 restricted。
→ 只需通過 **OAuth app 驗證**，**免費**、**不需 CASA 資安評估**、**不需年度續審費**。
（CASA 只有 restricted scope 才要，如 `gmail.readonly`、`gmail.modify`、`mail.google.com`。）

本 app 是純前端、無伺服器、不儲存 Google 使用者資料 → 表單裡關於「伺服器如何保護資料」的題目全部答「不經過伺服器」，是最容易過的一類案子。

---

## 送審資產現況

| 項目 | 狀態 | 位置 |
|---|---|---|
| 首頁（說明功能＋品牌歸屬，非純登入頁） | ✅ 已補 | `index.html` `.hero` 區塊（中英雙語） |
| 隱私政策（同網域、首頁可連到、含 Limited Use 聲明） | ✅ | https://mailmerge-web.ycfinance.tw/privacy.html |
| 使用條款 | ✅ | https://mailmerge-web.ycfinance.tw/terms.html |
| In-product 資料揭露（app 內顯著說明資料處理方式） | ✅ 已補 | `index.html` `.hero-points` |
| 官方 Google logo 登入按鈕 | ✅ | `js/app.js` `PROVIDER_ICON.google`（官方四色 G） |
| app 名稱三處一致 | ✅ 已統一為「客製郵件群發 Mail Merge」 | index / privacy / terms |
| 網域所有權驗證 | ⬜ 待辦 | Search Console |
| OAuth 同意畫面設定 | ⬜ 待辦 | Google Auth Platform |
| 英文示範影片 | ⬜ 待辦 | YouTube unlisted |

---

## 待辦步驟

### 1. Search Console 驗證網域
用**擁有 GCP 專案 `896057810062` 的那個 Google 帳號**登入 [Search Console](https://search.google.com/search-console)
→ 新增資源 → 選 **網域（Domain）** → 輸入 `ycfinance.tw` → 依指示加一筆 DNS TXT 記錄。
（Domain property 一次涵蓋所有子網域，含 `mailmerge-web.ycfinance.tw`。）

⚠️ 驗證網域的帳號與 GCP 專案的 owner/editor 必須是**同一個帳號**，否則直接退件。

### 2. Google Auth Platform 設定
Google Cloud Console → **Google Auth Platform**

**Branding（品牌）**
- 應用程式名稱：`客製郵件群發 Mail Merge`（必須與首頁、隱私政策一致；名稱內不得出現 Gmail / Google）
- 使用者支援電子郵件：`cando.yeh@ycfinance.tw`
- 應用程式首頁：`https://mailmerge-web.ycfinance.tw/`
- 隱私權政策：`https://mailmerge-web.ycfinance.tw/privacy.html`
- 服務條款：`https://mailmerge-web.ycfinance.tw/terms.html`
- 已授權網域：`ycfinance.tw`
- 開發人員聯絡資訊：`cando.yeh@ycfinance.tw`

**Data Access（scope）**：只留 `gmail.send`、`openid`、`email`（`openid`／`email` 非敏感，不影響審查）

**Audience（對象）**：External → **Publish app**（狀態變 In production）

**Verification Center**：送出驗證申請，填下面的 justification 與影片連結

### 3. Scope justification（直接複製）

```
The app requires https://www.googleapis.com/auth/gmail.send solely to send
mail-merge emails from the user's own Gmail account, initiated explicitly by the
user in the browser. There is no narrower Gmail scope that permits sending.

The app is entirely client-side and static: there is no backend server and no
database. Recipient lists, templates, attachments, and the OAuth access token
exist only in the browser tab's memory and are discarded when the tab is closed.
Nothing is written to localStorage, uploaded, logged, or transmitted to any
server other than Google's own API endpoints. Consequently the app neither
stores nor transmits Google user data on any server we control, and no third
party ever receives Google user data.

We do not request read access of any kind. The only other scopes requested are
openid and email, used solely to display which account is signed in.
```

### 4. 示範影片（YouTube 不公開連結）
全程英文旁白或字幕，2–3 分鐘。分鏡：

1. 網址列露出 `https://mailmerge-web.ycfinance.tw/`，捲過首頁說明（讓 app 名稱、隱私政策連結入鏡）
2. 點 **使用 Google 登入** → **把授權彈窗拉到最寬**，讓網址列的 `client_id` 清楚可見
3. 同意畫面：**左下角語言切成 English**，完整拍到 app 名稱與 `Send email on your behalf`（`gmail.send`）這一項，停留 3 秒以上
4. 授權完成，右上角顯示登入帳號
5. 貼上 2–3 筆測試名單 → 寫含 `{{變數}}` 的模板 → 看預覽逐筆替換
6. 按「開始寄送」，拍到寄送成功的 log
7. **關鍵**：切到 Gmail 的「寄件備份（Sent）」與收件人信箱，證明 `gmail.send` 確實只用於寄出使用者自己撰寫的信

旁白重點句（英文）：
- "The app requests only the gmail.send scope — send-only. It never reads the mailbox."
- "Everything runs in the browser. There is no server and no database."
- "The message now appears in the user's own Sent folder, sent from their own account."

### 5. 送審後
審查員會用 email 一來一往，通常 2–4 週。**回信有期限，逾期會被關案**，收到信要盡快回。

過審前若已 publish，使用者會看到「Google 尚未驗證這個應用程式」警告，且新授權用戶數有上限（約 100 人）。

---

## 參考
- [Gmail API scopes（sensitive / restricted 分類）](https://developers.google.com/gmail/api/auth/scopes)
- [Verification requirements](https://support.google.com/cloud/answer/13464321)
- [Demo video requirements](https://support.google.com/cloud/answer/13804565)
- [Restricted scope verification（本案不適用，供對照）](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
