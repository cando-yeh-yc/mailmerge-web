/**
 * auth.js — Google / Microsoft 登入
 * Token 只存在記憶體變數，不寫 localStorage、不傳伺服器；關掉分頁即失效。
 * Scope 最小化：Google 只要 gmail.send（＋email 顯示帳號），Microsoft 只要 Mail.Send。
 */
(() => {
  'use strict';

  const state = {
    provider: null, // 'google' | 'ms'
    email: null,
    token: null,
    exp: 0, // token 到期時間（ms epoch）
    _gClient: null,
    _msal: null,
    _msAccount: null,
  };

  // ---------- Google ----------

  function googleReady() {
    return typeof google !== 'undefined' && google.accounts?.oauth2;
  }

  function requestGoogleToken(promptMode) {
    return new Promise((resolve, reject) => {
      if (!state._gClient) {
        state._gClient = google.accounts.oauth2.initTokenClient({
          client_id: window.APP_CONFIG.GOOGLE_CLIENT_ID,
          scope: 'https://www.googleapis.com/auth/gmail.send openid email',
          callback: () => {},
        });
      }
      state._gClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        state.token = resp.access_token;
        state.exp = Date.now() + (resp.expires_in - 60) * 1000;
        resolve();
      };
      state._gClient.error_callback = (err) =>
        reject(new Error(err.message || '登入視窗被關閉'));
      state._gClient.requestAccessToken({ prompt: promptMode });
    });
  }

  async function loginGoogle() {
    if (!window.APP_CONFIG.GOOGLE_CLIENT_ID) throw new Error('CONFIG_GOOGLE');
    if (!googleReady()) throw new Error('Google 登入元件尚未載入，請稍候再試');
    await requestGoogleToken('consent');
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    const info = await res.json();
    state.provider = 'google';
    state.email = info.email || '（未知帳號）';
  }

  // ---------- Microsoft ----------

  function getMsal() {
    if (!state._msal) {
      state._msal = new msal.PublicClientApplication({
        auth: {
          clientId: window.APP_CONFIG.MS_CLIENT_ID,
          authority: 'https://login.microsoftonline.com/common',
          redirectUri: location.origin + location.pathname,
        },
        cache: { cacheLocation: 'memoryStorage' },
      });
    }
    return state._msal;
  }

  async function loginMS() {
    if (!window.APP_CONFIG.MS_CLIENT_ID) throw new Error('CONFIG_MS');
    const app = getMsal();
    await app.initialize();
    const result = await app.loginPopup({ scopes: ['Mail.Send'] });
    state._msAccount = result.account;
    state.provider = 'ms';
    state.email = result.account.username;
    await acquireMsToken();
  }

  async function acquireMsToken() {
    const app = getMsal();
    const req = { scopes: ['Mail.Send'], account: state._msAccount };
    let result;
    try {
      result = await app.acquireTokenSilent(req);
    } catch (_) {
      result = await app.acquireTokenPopup(req);
    }
    state.token = result.accessToken;
    state.exp = result.expiresOn
      ? result.expiresOn.getTime() - 60 * 1000
      : Date.now() + 50 * 60 * 1000;
  }

  // ---------- 共用 ----------

  /** 取有效 token；快到期就靜默續期 */
  async function getToken() {
    if (!state.provider) throw new Error('尚未登入');
    if (Date.now() < state.exp) return state.token;
    if (state.provider === 'google') await requestGoogleToken('');
    else await acquireMsToken();
    return state.token;
  }

  function logout() {
    if (state.provider === 'google' && state.token && googleReady()) {
      google.accounts.oauth2.revoke(state.token, () => {});
    }
    state.provider = null;
    state.email = null;
    state.token = null;
    state.exp = 0;
    state._msAccount = null;
  }

  window.Auth = {
    loginGoogle,
    loginMS,
    logout,
    getToken,
    get provider() { return state.provider; },
    get email() { return state.email; },
  };
})();
