/**
 * app.js — 匯入名單 → 模板編輯 → 逐封寄送
 * 所有資料只存在此頁面的記憶體中。
 */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // Gmail 走 JSON 端點，MIME 會再包一層 base64，附件上限抓保守的 15MB
  const CAPS = { google: 15 * 1024 * 1024, ms: 3 * 1024 * 1024 };
  const SEND_INTERVAL = 1100; // ms，每封間隔

  const state = {
    headers: [],
    rows: [],        // Array<Object> header -> value（字串）
    emailCol: '',
    attachCol: '',
    pool: new Map(),   // 逐筆附件池 filename -> File
    globalFiles: [],   // 共同附件 File[]
    recips: [],        // 每列解析出的收件人（與 rows 同索引），由 rebuildIndex() 維護
    dupFirst: new Map(), // 收件人組合 -> 第一次出現的列索引
    previewIdx: 0,
    statuses: [],      // {state:'idle'|'sending'|'sent'|'failed'|'skipped', error}
    sending: false,
    stopFlag: false,
  };

  // ==================== 匯入解析 ====================

  function parseDelimited(text, delim) {
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  function ingestMatrix(matrix) {
    if (!matrix.length || matrix.length < 2) {
      alert('至少需要一列欄位名＋一列資料'); return;
    }
    const seen = new Set();
    const headers = matrix[0].map((h, i) => {
      let name = String(h).trim() || `欄位${i + 1}`;
      while (seen.has(name)) name += '_';
      seen.add(name);
      return name;
    });
    const rows = matrix.slice(1).map((r) => {
      const o = {};
      headers.forEach((h, i) => (o[h] = String(r[i] ?? '').trim()));
      return o;
    });
    state.headers = headers;
    state.rows = rows;
    state.statuses = rows.map(() => ({ state: 'idle', error: '' }));
    state.previewIdx = 0;
    autoDetectColumns();
    renderAll();
  }

  function autoDetectColumns() {
    // 用跟驗證同一套解析器計分：該欄能解析出 email 的列數最多者當收件人欄
    let best = '', bestScore = 0;
    for (const h of state.headers) {
      const score = state.rows.filter((r) => parseRecipients(r[h]).length > 0).length;
      if (score > bestScore) { bestScore = score; best = h; }
    }
    state.emailCol = best;
    state.attachCol =
      state.headers.find((h) => /附件|attach/i.test(h)) || '';
  }

  // ==================== 驗證 ====================

  /**
   * 解析收件人欄：支援「姓名 <email>」、多收件人（, ; 、 或空白分隔）、純 email 混用。
   * 每個地址都必須通過 EMAIL_RE 才會採用，驗不過的整段捨棄（該列會被標為有問題、不寄）。
   * 例：Rakesh Jain <r@x.com>, Alexei <a@x.com>, finance@x.com
   */
  function parseRecipients(str) {
    if (!str) return [];
    const out = [];
    // 先收 <...> 裡的 email，並把該段移除
    let rest = str.replace(/<([^<>\s]+@[^<>\s]+)>/g, (_, em) => {
      // 角括號內也要驗：`[^<>\s]+` 沒排除逗號，<a@x.com,b@y.com> 若直接採用會變成
      // 一個含逗號的「地址」塞進 To: 標頭 → 實際寄給兩個人。
      // 驗不過就吐回原字串，交給下面的分隔符切開再逐段驗，切不出有效 email 時該列會報錯。
      if (EMAIL_RE.test(em)) { out.push(em); return ' '; }
      return ` ${em} `; // 佔位，讓前面的姓名跟著下面的分隔切掉
    });
    // 剩餘部分依分隔符切開，撿出裸 email
    rest.split(/[,;、 ]/).forEach((tok) => {
      const t = tok.trim();
      if (EMAIL_RE.test(t)) out.push(t);
    });
    // 去重（不分大小寫）
    const seen = new Set();
    return out.filter((e) => {
      const k = e.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function rowRecipients(row) {
    return state.emailCol ? parseRecipients(row[state.emailCol]) : [];
  }

  function rowAttachNames(row) {
    if (!state.attachCol || !row[state.attachCol]) return [];
    return row[state.attachCol].split(/[;；]/).map((s) => s.trim()).filter(Boolean);
  }

  /**
   * 重算收件人快取與重複索引。
   * 每次重繪／寄送前跑一次即可；沒有這層，rowError 會逐列掃全表比對重複，
   * 全表驗證變成 O(n²)（2000 列時單次重繪要數秒，而編輯任一格都會觸發重繪）。
   */
  function rebuildIndex() {
    state.recips = state.rows.map(rowRecipients);
    state.dupFirst = new Map();
    state.recips.forEach((rs, i) => {
      if (!rs.length) return;
      const key = rs.join(',').toLowerCase();
      if (!state.dupFirst.has(key)) state.dupFirst.set(key, i);
    });
  }

  function rowError(row, i) {
    const raw = state.emailCol ? row[state.emailCol] : '';
    if (!raw.trim()) return '缺少收件人 email';
    const recips = state.recips[i] || parseRecipients(raw);
    if (!recips.length) return '解析不出有效的 email';
    const first = state.dupFirst.get(recips.join(',').toLowerCase());
    // 只標第二次以後出現的：第一筆照常寄出，否則重複的收件人一封都收不到
    if (first !== undefined && first !== i) return `收件人重複（同第 ${first + 1} 筆）`;
    const missing = rowAttachNames(row).filter((n) => !state.pool.has(n));
    if (missing.length) return `找不到附件：${missing.join('、')}`;
    return '';
  }

  function validCount() {
    return state.rows.filter((r, i) => !rowError(r, i)).length;
  }

  // ==================== 模板渲染 ====================

  function fillClone(editorEl, row, markMissing) {
    const clone = editorEl.cloneNode(true);
    clone.querySelectorAll('.pill').forEach((p) => {
      const f = p.dataset.f;
      const v = row[f] ?? '';
      if (v === '' && markMissing) {
        const m = document.createElement('span');
        m.className = 'miss';
        m.textContent = `[${f} 無資料]`;
        p.replaceWith(m);
      } else {
        p.replaceWith(document.createTextNode(v));
      }
    });
    return clone;
  }

  function renderSubject(row) {
    return fillClone($('subjectEditor'), row, false).textContent.replace(/\s+/g, ' ').trim();
  }

  function renderBodyHTML(row) {
    return fillClone($('bodyEditor'), row, false).innerHTML;
  }

  function rowMissingFields(row) {
    const used = new Set(
      [...document.querySelectorAll('#subjectEditor .pill, #bodyEditor .pill')].map((p) => p.dataset.f)
    );
    return [...used].filter((f) => !(row[f] ?? '').trim());
  }

  // ==================== UI：渲染 ====================

  function fmtSize(bytes) {
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function renderAll() {
    rebuildIndex();
    const has = state.rows.length > 0;
    $('dataArea').hidden = !has;
    $('pasteZone').style.display = has ? 'none' : '';
    $('step2').hidden = !has;
    $('step3').hidden = !has;
    if (!has) return;
    renderMappings();
    renderPools();
    renderTable();
    renderChips();
    renderPreview();
    renderSendSummary();
  }

  function renderMappings() {
    const mk = (sel, val, allowEmpty) => {
      sel.innerHTML = '';
      if (allowEmpty) sel.appendChild(new Option('（不使用）', ''));
      else if (!val) {
        const ph = new Option('（請選擇收件人欄位）', '');
        ph.disabled = true;
        sel.appendChild(ph);
      }
      state.headers.forEach((h) => sel.appendChild(new Option(h, h)));
      sel.value = val;
    };
    mk($('selEmailCol'), state.emailCol, false);
    mk($('selAttachCol'), state.attachCol, true);
  }

  function renderPools() {
    const render = (listEl, items, onRemove) => {
      listEl.innerHTML = '';
      items.forEach(({ name, size, key }) => {
        const el = document.createElement('span');
        el.className = 'file-item';
        el.append(`${name}（${fmtSize(size)}）`);
        const x = document.createElement('button');
        x.textContent = '✕';
        x.title = '移除';
        x.addEventListener('click', () => onRemove(key));
        el.appendChild(x);
        listEl.appendChild(el);
      });
    };
    render(
      $('poolList'),
      [...state.pool.entries()].map(([k, f]) => ({ name: k, size: f.size, key: k })),
      (k) => { state.pool.delete(k); renderAll(); }
    );
    render(
      $('globalList'),
      state.globalFiles.map((f, i) => ({ name: f.name, size: f.size, key: i })),
      (i) => { state.globalFiles.splice(i, 1); renderAll(); }
    );
  }

  function renderTable() {
    const errs = state.rows.map((r, i) => rowError(r, i));
    const bad = errs.filter(Boolean).length;
    $('statOk').textContent = `${state.rows.length - bad} 筆有效`;
    $('statBad').hidden = bad === 0;
    $('statBad').textContent = `${bad} 筆有問題`;
    $('statCols').textContent = `欄位：${state.headers.join('・')}`;

    const LIMIT = 100;
    const t = document.createElement('table');
    const thead = t.createTHead().insertRow();
    thead.appendChild(document.createElement('th'));
    state.headers.forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      if (h === state.emailCol) th.textContent += '（收件人）';
      if (h === state.attachCol) th.textContent += '（附件）';
      thead.appendChild(th);
    });
    thead.appendChild(document.createElement('th'));
    const tb = t.createTBody();
    state.rows.slice(0, LIMIT).forEach((row, i) => {
      const tr = tb.insertRow();
      const err = errs[i];
      if (err) tr.className = 'row-bad';
      const c0 = tr.insertCell();
      c0.textContent = err ? '⚠ ' + err : '✓';
      state.headers.forEach((h) => {
        const td = tr.insertCell();
        td.textContent = row[h];
        td.title = '點一下即可編輯';
        td.setAttribute('contenteditable', 'plaintext-only');
        td.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
          if (e.key === 'Escape') { td.textContent = row[h]; td.blur(); }
        });
        td.addEventListener('blur', () => {
          const v = td.textContent.trim();
          if (v !== row[h]) { row[h] = v; renderAll(); }
        });
      });
      const tdDel = tr.insertCell();
      const del = document.createElement('button');
      del.className = 'row-del';
      del.textContent = '✕';
      del.title = '刪除這一筆';
      del.addEventListener('click', () => {
        state.rows.splice(i, 1);
        state.statuses.splice(i, 1);
        renderAll();
      });
      tdDel.appendChild(del);
    });
    const wrap = $('tableWrap');
    const keepScroll = wrap.scrollTop;
    wrap.innerHTML = '';
    wrap.appendChild(t);
    wrap.scrollTop = keepScroll;
    if (state.rows.length > LIMIT) {
      const more = document.createElement('div');
      more.className = 'muted';
      more.style.padding = '8px 10px';
      more.textContent = `…僅顯示前 ${LIMIT} 筆，共 ${state.rows.length} 筆`;
      $('tableWrap').appendChild(more);
    }
  }

  function renderChips() {
    const bar = $('chipBar');
    bar.innerHTML = '';
    state.headers.forEach((h) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = `{{${h}}}`;
      b.title = `插入 ${h}`;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // 不搶編輯器焦點
      b.addEventListener('click', () => insertPill(h));
      bar.appendChild(b);
    });
  }

  function renderPreview() {
    if (!state.rows.length) return;
    state.previewIdx = Math.min(state.previewIdx, state.rows.length - 1);
    const i = state.previewIdx;
    const row = state.rows[i];
    $('pvCounter').textContent = `預覽 ${i + 1} / ${state.rows.length}`;
    const recips = state.recips[i] || rowRecipients(row);
    $('pvTo').textContent = recips.length ? recips.join('、') : '（未指定收件人欄）';
    $('pvSubject').textContent = renderSubject(row) || '（無主旨）';
    $('pvBody').innerHTML = fillClone($('bodyEditor'), row, true).innerHTML || '<span class="muted">（內文空白）</span>';

    const atts = $('pvAtts');
    atts.innerHTML = '';
    const names = rowAttachNames(row);
    [...names.map((n) => ({ n, ok: state.pool.has(n) })),
     ...state.globalFiles.map((f) => ({ n: f.name + '（共同）', ok: true }))]
      .forEach(({ n, ok }) => {
        const el = document.createElement('span');
        el.className = 'file-item';
        el.textContent = (ok ? '📎 ' : '⚠ 找不到：') + n;
        if (!ok) el.classList.add('err-text');
        atts.appendChild(el);
      });

    const problems = [];
    const err = rowError(row, i);
    if (err) problems.push(err);
    const miss = rowMissingFields(row);
    if (miss.length) problems.push(`這一筆的「${miss.join('、')}」沒有資料，寄出時該處會是空白`);
    $('pvWarn').hidden = problems.length === 0;
    $('pvWarn').textContent = problems.join('；');
  }

  function estimateTraffic() {
    let total = 0;
    const globalSize = state.globalFiles.reduce((s, f) => s + f.size, 0);
    state.rows.forEach((row, i) => {
      if (rowError(row, i)) return;
      total += globalSize;
      for (const n of rowAttachNames(row)) total += state.pool.get(n)?.size || 0;
    });
    return total;
  }

  function renderSendSummary() {
    const ok = validCount();
    const bad = state.rows.length - ok;
    const cap = Auth.provider ? CAPS[Auth.provider] : CAPS.ms;
    let over = 0;
    const globalSize = state.globalFiles.reduce((s, f) => s + f.size, 0);
    state.rows.forEach((row, i) => {
      if (rowError(row, i)) return;
      const size = globalSize + rowAttachNames(row).reduce((s, n) => s + (state.pool.get(n)?.size || 0), 0);
      if (size > cap) over++;
    });
    const parts = [`將寄出 ${ok} 封`];
    if (bad) parts.push(`略過 ${bad} 筆有問題的`);
    const traffic = estimateTraffic();
    if (traffic) parts.push(`附件上傳流量約 ${fmtSize(traffic)}`);
    if (over) parts.push(`⚠ ${over} 封附件超過單信上限（${fmtSize(cap)}），將無法寄出`);
    if (!Auth.provider) parts.push('（請先登入）');
    $('sendSummary').textContent = parts.join('，');
    $('btnSend').disabled = !Auth.provider || ok === 0 || state.sending;
    $('btnTest').disabled = !Auth.provider || state.sending;
  }

  // ==================== 模板編輯器 ====================

  let savedRange = null;

  function editorOf(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el ? el.closest('#subjectEditor, #bodyEditor') : null;
  }

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editorOf(sel.getRangeAt(0).startContainer)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  });

  function makePill(field) {
    const s = document.createElement('span');
    s.className = 'pill';
    s.contentEditable = 'false';
    s.dataset.f = field;
    s.textContent = field;
    return s;
  }

  function insertPill(field) {
    let range = savedRange;
    if (!range || !editorOf(range.startContainer)) {
      const ed = $('bodyEditor');
      ed.focus();
      range = document.createRange();
      range.selectNodeContents(ed);
      range.collapse(false);
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    range.deleteContents();
    const pill = makePill(field);
    range.insertNode(pill);
    // 游標移到膠囊後面（補一個零寬字元讓 caret 有落點）
    const zw = document.createTextNode('​');
    pill.after(zw);
    range.setStartAfter(zw);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    savedRange = range.cloneRange();
    onTemplateChange();
  }

  // {{ 自動完成
  const ac = { open: false, items: [], active: 0 };

  function closeAC() {
    ac.open = false;
    $('acMenu').hidden = true;
  }

  function maybeOpenAC() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return closeAC();
    const range = sel.getRangeAt(0);
    if (!editorOf(range.startContainer)) return closeAC();
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return closeAC();
    const before = node.textContent.slice(0, range.startOffset);
    if (!before.endsWith('{{')) return closeAC();

    ac.open = true;
    ac.items = state.headers;
    ac.active = 0;
    const menu = $('acMenu');
    menu.innerHTML = '';
    ac.items.forEach((h, i) => {
      const b = document.createElement('button');
      b.textContent = h;
      if (i === 0) b.className = 'active';
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => pickAC(h));
      menu.appendChild(b);
    });
    const r = range.getBoundingClientRect();
    const pane = document.querySelector('.editor-pane').getBoundingClientRect();
    menu.style.left = Math.max(0, r.left - pane.left) + 'px';
    menu.style.top = r.bottom - pane.top + 4 + 'px';
    menu.hidden = false;
  }

  function pickAC(field) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE && node.textContent.slice(0, range.startOffset).endsWith('{{')) {
        range.setStart(node, range.startOffset - 2);
        range.deleteContents();
        savedRange = range.cloneRange();
      }
    }
    closeAC();
    insertPill(field);
  }

  function onTemplateChange() {
    renderPreview();
  }

  function setupEditors() {
    for (const id of ['subjectEditor', 'bodyEditor']) {
      const ed = $(id);
      ed.addEventListener('input', () => { maybeOpenAC(); onTemplateChange(); });
      ed.addEventListener('blur', () => setTimeout(closeAC, 150));
      // 貼上一律轉純文字，避免把外部樣式帶進模板
      ed.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
      });
      ed.addEventListener('keydown', (e) => {
        if (ac.open) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            ac.active = (ac.active + (e.key === 'ArrowDown' ? 1 : ac.items.length - 1)) % ac.items.length;
            [...$('acMenu').children].forEach((b, i) => b.classList.toggle('active', i === ac.active));
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            pickAC(ac.items[ac.active]);
            return;
          }
          if (e.key === 'Escape') { closeAC(); return; }
        }
        if (id === 'subjectEditor' && e.key === 'Enter') e.preventDefault();
      });
    }
    // 預設模板
    $('bodyEditor').innerHTML = '您好：<br><br><br>';
  }

  // ==================== 寄送 ====================

  async function buildAtts(row) {
    const files = [
      ...rowAttachNames(row).map((n) => state.pool.get(n)).filter(Boolean),
      ...state.globalFiles,
    ];
    const cap = CAPS[Auth.provider];
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > cap) throw new Error(`附件共 ${fmtSize(total)}，超過單信上限 ${fmtSize(cap)}`);
    return Promise.all(
      files.map(async (f) => ({
        name: f.name,
        type: f.type || 'application/octet-stream',
        b64: await Mail.fileToB64(f),
      }))
    );
  }

  async function sendOne(row) {
    const token = await Auth.getToken();
    const msg = {
      to: rowRecipients(row),
      subject: renderSubject(row),
      html: renderBodyHTML(row),
      atts: await buildAtts(row),
    };
    if (Auth.provider === 'google') await Mail.sendGmail(token, msg);
    else await Mail.sendGraph(token, msg);
  }

  function logLine(text, cls) {
    const el = document.createElement('div');
    el.className = 'log-row ' + (cls || '');
    el.textContent = text;
    $('sendLog').prepend(el);
  }

  async function runSend(indexes) {
    rebuildIndex(); // 寄送期間名單不會變動，開跑前算一次即可
    state.sending = true;
    state.stopFlag = false;
    $('btnStop').hidden = false;
    $('btnRetry').hidden = true;
    $('progressBar').hidden = false;
    renderSendSummary();

    let done = 0;
    for (const i of indexes) {
      if (state.stopFlag) break;
      const row = state.rows[i];
      const st = state.statuses[i];
      const err = rowError(row, i);
      if (err) {
        st.state = 'skipped'; st.error = err;
        logLine(`− 第 ${i + 1} 筆 ${row[state.emailCol] || ''}：略過（${err}）`, '');
      } else {
        st.state = 'sending';
        try {
          await sendOne(row);
          st.state = 'sent'; st.error = '';
          logLine(`✓ 第 ${i + 1} 筆 ${row[state.emailCol]}：已寄出`, 'log-ok');
        } catch (e) {
          st.state = 'failed'; st.error = e.message;
          logLine(`✕ 第 ${i + 1} 筆 ${row[state.emailCol]}：${e.message}`, 'log-bad');
        }
        await new Promise((r) => setTimeout(r, SEND_INTERVAL));
      }
      done++;
      $('progressFill').style.width = Math.round((done / indexes.length) * 100) + '%';
    }

    state.sending = false;
    $('btnStop').hidden = true;
    const failed = state.statuses.filter((s) => s.state === 'failed').length;
    $('btnRetry').hidden = failed === 0;
    const sent = state.statuses.filter((s) => s.state === 'sent').length;
    logLine(state.stopFlag ? `⏹ 已停止：共寄出 ${sent} 封` : `🏁 完成：寄出 ${sent} 封，失敗 ${failed} 封`, '');
    renderSendSummary();
  }

  // ==================== 事件接線 ====================

  /**
   * 登入供應商的識別圖示。內嵌 SVG，不對外部請求——
   * 這頁記憶體裡有寄信 token，能少一個外部來源就少一個。
   */
  const PROVIDER_ICON = {
    google:
      '<svg class="oauth-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
      '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
      '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
      '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.28-3.14.76-4.59l-7.97-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
      '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.97 6.19C6.51 42.62 14.62 48 24 48z"/>' +
      '</svg>',
    ms:
      '<svg class="oauth-icon" viewBox="0 0 23 23" aria-hidden="true" focusable="false">' +
      '<path fill="#F35325" d="M1 1h10v10H1z"/>' +
      '<path fill="#81BC06" d="M12 1h10v10H12z"/>' +
      '<path fill="#05A6F0" d="M1 12h10v10H1z"/>' +
      '<path fill="#FFBA08" d="M12 12h10v10H12z"/>' +
      '</svg>',
  };

  /** 產生「圖示＋文字」的登入按鈕；圖示是上面的常數字串，不含任何使用者資料 */
  function makeProviderButton(provider, label, id) {
    const b = document.createElement('button');
    b.className = 'btn btn-oauth';
    b.id = id;
    b.innerHTML = PROVIDER_ICON[provider];
    b.appendChild(document.createTextNode(label));
    b.addEventListener('click', () => doLogin(provider));
    return b;
  }

  function updateAuthUI() {
    const area = $('authArea');
    area.innerHTML = '';
    if (Auth.provider) {
      const chip = document.createElement('span');
      chip.className = 'account-chip';
      chip.textContent = (Auth.provider === 'google' ? 'Google｜' : 'Microsoft｜') + Auth.email;
      const out = document.createElement('button');
      out.className = 'btn btn-sm';
      out.textContent = '登出';
      out.addEventListener('click', () => { Auth.logout(); updateAuthUI(); });
      area.append(chip, out);
    } else {
      area.append(
        makeProviderButton('google', '使用 Google 登入', 'btnGoogle'),
        makeProviderButton('ms', '使用 Microsoft 登入', 'btnMS')
      );
    }
    renderSendSummary();
  }

  async function doLogin(which) {
    try {
      if (which === 'google') await Auth.loginGoogle();
      else await Auth.loginMS();
      updateAuthUI();
    } catch (e) {
      if (e.message === 'CONFIG_GOOGLE' || e.message === 'CONFIG_MS') {
        const hint = $('setupHint');
        hint.hidden = false;
        hint.innerHTML =
          e.message === 'CONFIG_GOOGLE'
            ? '尚未設定 Google Client ID：請照 <code>README.md</code> 在 Google Cloud Console 建立 OAuth 用戶端，把 ID 填進 <code>config.js</code> 的 <code>GOOGLE_CLIENT_ID</code>。'
            : '尚未設定 Microsoft Client ID：請照 <code>README.md</code> 在 Microsoft Entra 註冊應用程式，把 ID 填進 <code>config.js</code> 的 <code>MS_CLIENT_ID</code>。';
      } else if (/popup/i.test(e.message)) {
        alert('登入視窗被瀏覽器擋下了。請點網址列右側的「彈出式視窗已封鎖」圖示允許本站的彈出視窗，再重新登入。');
      } else {
        alert('登入失敗：' + e.message);
      }
    }
  }

  function addPoolFiles(files) {
    for (const f of files) state.pool.set(f.name, f);
    renderAll();
  }
  function addGlobalFiles(files) {
    state.globalFiles.push(...files);
    renderAll();
  }

  function setupDropZone(zoneId, inputId, pickBtnId, onFiles) {
    const zone = $(zoneId);
    const input = $(inputId);
    $(pickBtnId).addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
    input.addEventListener('change', () => { onFiles([...input.files]); input.value = ''; });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('armed'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('armed'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('armed');
      onFiles([...e.dataTransfer.files]);
    });
  }

  function handleDataFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.xlsx')) {
      const r = new FileReader();
      r.onload = () => {
        const wb = XLSX.read(r.result, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
        ingestMatrix(matrix);
      };
      r.readAsArrayBuffer(file);
    } else {
      const r = new FileReader();
      r.onload = () => {
        const text = String(r.result);
        const delim = name.endsWith('.tsv') || text.includes('\t') ? '\t' : ',';
        ingestMatrix(parseDelimited(text, delim));
      };
      r.readAsText(file);
    }
  }

  function init() {
    // 名單匯入
    const pz = $('pasteZone');
    pz.addEventListener('click', () => pz.focus());
    pz.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      if (!text.trim()) return;
      ingestMatrix(parseDelimited(text, text.includes('\t') ? '\t' : ','));
    });
    pz.addEventListener('dragover', (e) => { e.preventDefault(); pz.classList.add('armed'); });
    pz.addEventListener('dragleave', () => pz.classList.remove('armed'));
    pz.addEventListener('drop', (e) => {
      e.preventDefault();
      pz.classList.remove('armed');
      if (e.dataTransfer.files.length) handleDataFile(e.dataTransfer.files[0]);
    });
    $('btnPickFile').addEventListener('click', (e) => { e.stopPropagation(); $('fileInput').click(); });
    $('fileInput').addEventListener('change', () => {
      if ($('fileInput').files.length) handleDataFile($('fileInput').files[0]);
      $('fileInput').value = '';
    });
    $('btnClearData').addEventListener('click', () => {
      if (!confirm('清除目前的名單？（附件檔案池會保留）')) return;
      state.headers = []; state.rows = []; state.statuses = [];
      renderAll();
    });

    // 欄位對應
    $('selEmailCol').addEventListener('change', (e) => { state.emailCol = e.target.value; renderAll(); });
    $('selAttachCol').addEventListener('change', (e) => { state.attachCol = e.target.value; renderAll(); });

    // 附件池
    setupDropZone('poolZone', 'poolInput', 'btnPoolPick', addPoolFiles);
    setupDropZone('globalZone', 'globalInput', 'btnGlobalPick', addGlobalFiles);

    // 編輯器與預覽
    setupEditors();
    $('pvPrev').addEventListener('click', () => { state.previewIdx = Math.max(0, state.previewIdx - 1); renderPreview(); });
    $('pvNext').addEventListener('click', () => { state.previewIdx = Math.min(state.rows.length - 1, state.previewIdx + 1); renderPreview(); });

    // 寄送
    $('btnSend').addEventListener('click', () => {
      const ok = validCount();
      if (!confirm(
        `確定寄出 ${ok} 封？寄出後無法收回。\n\n` +
        '提醒：請確認收件人與你有既有的業務或聯絡關係。' +
        '未經同意的大量寄信違反 Gmail／Microsoft 使用條款，可能導致你的帳號被停權。'
      )) return;
      state.statuses = state.rows.map(() => ({ state: 'idle', error: '' }));
      $('sendLog').innerHTML = '';
      $('progressFill').style.width = '0';
      runSend(state.rows.map((_, i) => i));
    });
    $('btnStop').addEventListener('click', () => { state.stopFlag = true; });
    $('btnRetry').addEventListener('click', () => {
      const idx = state.statuses.map((s, i) => (s.state === 'failed' ? i : -1)).filter((i) => i >= 0);
      runSend(idx);
    });
    $('btnTest').addEventListener('click', async () => {
      const row = state.rows[state.previewIdx];
      if (!row) return;
      const btn = $('btnTest');
      btn.disabled = true; btn.textContent = '寄送中…';
      try {
        const token = await Auth.getToken();
        const msg = {
          to: Auth.email,
          subject: '【測試】' + renderSubject(row),
          html: renderBodyHTML(row),
          atts: await buildAtts(row),
        };
        if (Auth.provider === 'google') await Mail.sendGmail(token, msg);
        else await Mail.sendGraph(token, msg);
        logLine(`✓ 測試信已寄到 ${Auth.email}（套用第 ${state.previewIdx + 1} 筆資料）`, 'log-ok');
      } catch (e) {
        logLine(`✕ 測試信失敗：${e.message}`, 'log-bad');
      }
      btn.disabled = false; btn.textContent = '寄測試信給自己';
      renderSendSummary();
    });

    // 寄送中關頁警告
    window.addEventListener('beforeunload', (e) => {
      if (state.sending) { e.preventDefault(); e.returnValue = ''; }
    });

    updateAuthUI();
    renderAll();
  }

  init();
})();
