/**
 * mail.js — 信件組裝與寄送
 * Gmail：組 RFC 822 MIME，POST 到 Gmail API 上傳端點
 * Microsoft：組 Graph sendMail JSON payload
 * 兩者都由瀏覽器直連官方 API，不經過任何第三方伺服器。
 */
(() => {
  'use strict';

  /** UTF-8 字串 → base64 */
  function b64utf8(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }

  /** base64 每 76 字元換行（MIME 規範） */
  function wrap76(b64) {
    return b64.replace(/(.{76})/g, '$1\r\n');
  }

  /** 信件標頭的中文編碼（RFC 2047 encoded-word） */
  function encWord(str) {
    return /^[\x20-\x7e]*$/.test(str) ? str : `=?UTF-8?B?${b64utf8(str)}?=`;
  }

  const fileB64Cache = new Map(); // File -> Promise<string>

  /** File → base64（有快取：同一份附件寄 50 封只讀一次） */
  function fileToB64(file) {
    if (!fileB64Cache.has(file)) {
      fileB64Cache.set(
        file,
        new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1]);
          r.onerror = () => reject(new Error(`讀取附件失敗：${file.name}`));
          r.readAsDataURL(file);
        })
      );
    }
    return fileB64Cache.get(file);
  }

  /** 組一封完整的 RFC 822 MIME 信（HTML 內文＋附件；to 可為字串或陣列） */
  function buildMime({ to, subject, html, atts }) {
    const toList = Array.isArray(to) ? to : [to];
    const boundary = 'gte_' + Math.random().toString(36).slice(2);
    const lines = [
      `To: ${toList.join(', ')}`,
      `Subject: ${encWord(subject)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(b64utf8(html)),
    ];
    for (const a of atts) {
      lines.push(
        `--${boundary}`,
        `Content-Type: ${a.type || 'application/octet-stream'}; name="${encWord(a.name)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${encWord(a.name)}"`,
        '',
        wrap76(a.b64)
      );
    }
    lines.push(`--${boundary}--`, '');
    return lines.join('\r\n');
  }

  /** 429/5xx 自動退避重試 */
  async function fetchWithRetry(url, opts, tries = 3) {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      let res;
      try {
        res = await fetch(url, opts);
      } catch (e) {
        // 寄信不是冪等操作：請求可能已送達、只是回應被擋，
        // 自動重試會重複寄出，所以網路層錯誤一律直接失敗、交人工判斷。
        const err = new Error(
          `連線異常（${e.message}）。這封信「可能已寄出」——請先到寄件備份確認，再決定是否重寄。`
        );
        err.isNetwork = true;
        throw err;
      }
      if (res.ok || res.status === 202) return res;
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`伺服器暫時無法處理（HTTP ${res.status}）`);
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      // 4xx：解析錯誤訊息後直接失敗，不重試
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = j.error?.message || j.error?.code || msg;
      } catch (_) { /* 保留預設訊息 */ }
      throw new Error(msg);
    }
    throw lastErr;
  }

  /** Gmail 寄送（自動存進寄件備份） */
  async function sendGmail(token, { to, subject, html, atts }) {
    const mime = buildMime({ to, subject, html, atts });
    const raw = b64utf8(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await fetchWithRetry('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw }),
    });
  }

  /** Microsoft Graph 寄送（saveToSentItems 明確開啟） */
  async function sendGraph(token, { to, subject, html, atts }) {
    const payload = {
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: (Array.isArray(to) ? to : [to]).map((a) => ({
          emailAddress: { address: a },
        })),
        attachments: atts.map((a) => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: a.name,
          contentType: a.type || 'application/octet-stream',
          contentBytes: a.b64,
        })),
      },
      saveToSentItems: true,
    };
    await fetchWithRetry('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  }

  window.Mail = { fileToB64, sendGmail, sendGraph };
})();
