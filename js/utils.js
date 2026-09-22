// ===== 工具函数 =====

/**
 * 股票代码规范化
 * 输入 → 清理空格 → 大写 → 提取纯数字 → 补零到6位 → 判断市场 → 输出完整代码
 */
function normalizeCode(input) {
  if (!input) return '';
  let code = String(input).trim().toUpperCase();
  // 提取纯数字
  let digits = code.replace(/[^0-9]/g, '');
  // 补零到6位
  digits = digits.padStart(6, '0');
  // 如果已包含后缀，保留后缀
  if (code.includes('.SH') || code.includes('.SZ')) {
    let suffix = code.includes('.SH') ? '.SH' : '.SZ';
    return digits + suffix;
  }
  // 判断市场（沪市SH / 深市SZ / 北交所BJ）
  const shPrefixes = ['600', '601', '603', '605', '688', '900'];
  const bjPrefixes = ['920', '830', '831', '832', '833', '834', '835', '836', '837', '838', '839', '870', '871', '872', '873'];
  let market;
  if (shPrefixes.some(p => digits.startsWith(p))) market = 'SH';
  else if (bjPrefixes.some(p => digits.startsWith(p))) market = 'BJ';
  else market = 'SZ';
  return digits + '.' + market;
}

/**
 * 从完整代码中提取6位数字部分
 */
function extractDigits(code) {
  return (code || '').replace(/[^0-9]/g, '').padStart(6, '0');
}

/**
 * 格式化价格
 */
function formatPrice(price) {
  if (price == null || isNaN(price)) return '--';
  return Number(price).toFixed(2);
}

/**
 * 格式化百分比
 */
function formatPercent(val) {
  if (val == null || isNaN(val)) return '--';
  let v = Number(val);
  let sign = v > 0 ? '+' : '';
  return sign + v.toFixed(2) + '%';
}

/**
 * 格式化倍数
 */
function formatMultiple(val) {
  if (val == null || isNaN(val)) return '--';
  return Number(val).toFixed(4);
}

/**
 * 判断是否"今天"（用于排序）
 */
function isToday(dateStr) {
  if (!dateStr) return false;
  if (dateStr === '今天' || dateStr === '即时') return true;
  let d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  let today = new Date();
  return d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
}

/**
 * Toast 提示
 */
function showToast(msg, type = 'success') {
  let existing = document.querySelector('.toast');
  if (existing) existing.remove();
  let toast = document.createElement('div');
  toast.className = 'toast ' + type;
  if (msg.length > 60) toast.classList.add('toast-long');
  toast.textContent = msg;
  document.body.appendChild(toast);
  let duration = msg.length > 60 ? 5000 : 2000;
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, duration);
}

/**
 * 显示备注内容弹窗（长文本）
 */
function showNoteDialog(noteText) {
  let existing = document.querySelector('.note-dialog');
  if (existing) existing.remove();
  let dialog = document.createElement('div');
  dialog.className = 'note-dialog';
  dialog.innerHTML = `
    <div class="note-dialog-content">
      <div class="note-dialog-text">${escapeHtml(noteText).replace(/\n/g, '<br>')}</div>
      <button class="btn btn-sm note-dialog-close" onclick="this.closest('.note-dialog').remove()">关闭</button>
    </div>
  `;
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.remove();
  });
  document.body.appendChild(dialog);
}

/**
 * 生成唯一 ID
 */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 防抖
 */
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/**
 * 格式化时间戳
 */
function formatTime(isoStr) {
  if (!isoStr) return '--';
  try {
    let d = new Date(isoStr);
    let h = String(d.getHours()).padStart(2, '0');
    let m = String(d.getMinutes()).padStart(2, '0');
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' + h + ':' + m;
  } catch(e) {
    return isoStr;
  }
}

/**
 * 将腾讯股票API代码转为标准代码
 * 腾讯API: sh600519 → 600519.SH
 */
function tencentToStd(tencentCode) {
  let market = tencentCode.startsWith('sh') ? 'SH' : 'SZ';
  let digits = tencentCode.replace(/[^0-9]/g, '').padStart(6, '0');
  return digits + '.' + market;
}

/**
 * 标准代码转腾讯API代码
 */
function stdToTencent(code) {
  let digits = extractDigits(code);
  if (code.includes('.SH') || code.match(/^(600|601|603|605|688|900)/)) return 'sh' + digits;
  if (code.includes('.BJ') || code.match(/^(920|830|831|832|833|834|835|836|837|838|839|870|871|872|873)/)) return 'bj' + digits;
  return 'sz' + digits;
}

// ===== JSONP 通用传输层 =====
// 背景：部分第三方接口（如东财 push2 系列）不带 CORS 响应头，
// 且其 WAF 会对携带 Origin/Referer 的“非白名单来源”直接断开连接（浏览器表现为 ERR_EMPTY_RESPONSE）。
// 方案：用 <script> 发起 JSONP，并显式设置 referrerPolicy='no-referrer'，
// 使请求既不携带 Origin 也不携带 Referer，从而绕过拦截；同时天然规避 CORS。

/**
 * 通用 JSONP 请求
 * @param {string} url 完整地址（会被追加回调参数）
 * @param {object} [opts]
 * @param {number} [opts.timeout] 超时毫秒，默认 9000
 * @param {string} [opts.callbackParam] 回调参数名，默认 'cb'（东财 datacenter 用 'callback'）
 * @param {string} [opts.callbackName] 自定义全局回调名（一般无需传）
 * @returns {Promise<any>} 接口返回的 JSON 对象
 */
function jsonpGet(url, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeout || 9000;
  const cbParam = opts.callbackParam || 'cb';
  const cbName = opts.callbackName || ('jp_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
  const sep = url.indexOf('?') >= 0 ? '&' : '?';
  const finalUrl = url + sep + cbParam + '=' + cbName + (opts.extra ? '&' + opts.extra : '');

  return new Promise(function (resolve, reject) {
    const script = document.createElement('script');
    let done = false;
    let timer = null;

    function cleanup() {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[cbName] = function (data) { cleanup(); resolve(data); };
    timer = setTimeout(function () { cleanup(); reject(new Error('JSONP 请求超时')); }, timeoutMs);
    script.onerror = function () { cleanup(); reject(new Error('JSONP 网络错误')); };
    // 关键：去掉 Referer，避免被接口方 WAF 拦截
    try { script.referrerPolicy = 'no-referrer'; } catch (e) { /* 老浏览器忽略 */ }
    script.src = finalUrl;
    document.head.appendChild(script);
  });
}

/**
 * JSONP 多域名容错：依次尝试多个 base host 的同一 path
 * @param {string} path 以 / 开头的接口路径（含 query）
 * @param {string[]} hosts base host 数组
 * @param {object} [opts] 透传给 jsonpGet
 * @returns {Promise<any>}
 */
async function jsonpGetHosts(path, hosts, opts) {
  let lastErr = null;
  for (let i = 0; i < hosts.length; i++) {
    try {
      return await jsonpGet(hosts[i] + path, opts);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('JSONP 请求失败');
}
