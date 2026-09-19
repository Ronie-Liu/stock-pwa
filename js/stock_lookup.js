// ===== 股票代码/名称查询（「输入代码或名称」都能添加） =====
// 本地索引: data/stock_names.js（由 scripts/build_stock_tags.py 从标签体系生成，覆盖全部 A 股）
// 兜底: 腾讯行情 qt.gtimg.cn（按代码反查名称/校验代码是否存在，浏览器可直连）
// 说明: 乐咕/腾讯 smartbox、东财 suggest 等联想搜索接口均无 CORS 头，浏览器无法直连，
//       故代码/名称匹配全部走本地索引，保证离线可用、零延迟。

const STOCK_NAMES_URL = '/data/stock_names.js';
const STOCK_NAMES_VER = '20260919b';
const STOCK_LOOKUP_LIMIT = 12;

let stockNamesLoading = null;

function stockNameIndexReady() {
  return !!(window.STOCK_NAMES && window.STOCK_NAME2CODE);
}

/** 懒加载代码名称索引 */
function loadStockNameIndex() {
  if (stockNameIndexReady()) return Promise.resolve(true);
  if (stockNamesLoading) return stockNamesLoading;
  stockNamesLoading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = STOCK_NAMES_URL + '?v=' + STOCK_NAMES_VER;
    s.async = true;
    s.onload = () => resolve(stockNameIndexReady());
    s.onerror = () => { stockNamesLoading = null; resolve(false); };
    document.head.appendChild(s);
  });
  return stockNamesLoading;
}

function _lkNorm(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();
}

/** 从任意输入里抽出 6 位数字代码（要求连续 6 位，用于解析确认） */
function _lkDigits(s) {
  const m = String(s == null ? '' : s).match(/\d{6}/);
  return m ? m[0] : '';
}

/** 从任意输入里抽出全部数字（用于代码前缀联想） */
function _lkAllDigits(s) {
  return String(s == null ? '' : s).replace(/[^0-9]/g, '');
}

function _lkHasCJK(s) {
  return /[\u4e00-\u9fa5]/.test(String(s || ''));
}

/** 代码 -> 名称（本地索引，未命中返回 null） */
function stockLookupName(code) {
  if (!stockNameIndexReady()) return null;
  const d = _lkDigits(code) || extractDigits(code);
  return window.STOCK_NAMES[d] || null;
}

/**
 * 联想搜索：代码前缀 / 名称包含，均返回 [{code,name,exact}]
 * 中文输入走名称匹配，其余走代码匹配
 */
function stockLookupSearch(query, limit) {
  const out = [];
  if (!stockNameIndexReady()) return out;
  const raw = String(query == null ? '' : query).trim();
  if (!raw) return out;
  const max = limit || STOCK_LOOKUP_LIMIT;
  const names = window.STOCK_NAMES;
  const seen = new Set();

  const push = (code, exact) => {
    if (seen.has(code) || out.length >= max) return;
    seen.add(code);
    out.push({ code: code, name: names[code], exact: !!exact });
  };

  if (_lkHasCJK(raw)) {
    const q = _lkNorm(raw);
    // 1) 完全相等  2) 前缀  3) 包含
    for (const code in names) { if (_lkNorm(names[code]) === q) push(code, true); }
    for (const code in names) { if (out.length >= max) break; if (_lkNorm(names[code]).indexOf(q) === 0) push(code); }
    for (const code in names) { if (out.length >= max) break; if (_lkNorm(names[code]).indexOf(q) > 0) push(code); }
  } else {
    const digits = _lkAllDigits(raw);
    if (!digits) return out;
    const prefix = digits.length >= 6 ? digits.slice(0, 6) : digits;
    if (prefix.length === 6 && names[prefix]) push(prefix, true);
    for (const code in names) { if (out.length >= max) break; if (code.indexOf(prefix) === 0) push(code); }
  }
  return out;
}

/**
 * 解析用户输入为 {code, name}（异步，必要时用行情接口反查名称/校验代码）
 * @returns {{ok:boolean, code?:string, name?:string, reason?:string, candidates?:Array}}
 */
async function stockLookupResolve(query) {
  const raw = String(query == null ? '' : query).trim();
  if (!raw) return { ok: false, reason: 'empty' };

  const ok = stockNameIndexReady() || await loadStockNameIndex();
  const isName = _lkHasCJK(raw);

  // ---- 按名称解析 ----
  if (isName) {
    if (!ok) return { ok: false, reason: 'offline' };
    const q = _lkNorm(raw);
    const exactCode = window.STOCK_NAME2CODE[raw] || window.STOCK_NAME2CODE[raw.replace(/\s+/g, '')];
    if (exactCode) return { ok: true, code: exactCode, name: window.STOCK_NAMES[exactCode] };
    const hits = stockLookupSearch(raw, 30);
    if (hits.length === 1) return { ok: true, code: hits[0].code, name: hits[0].name };
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits.slice(0, 12) };
    // 名称里可能带 ST/*ST 前缀，做一次去前缀匹配
    const stripped = q.replace(/^\*?ST/, '');
    if (stripped && stripped !== q) {
      const h2 = stockLookupSearch(stripped, 30);
      if (h2.length === 1) return { ok: true, code: h2[0].code, name: h2[0].name };
      if (h2.length > 1) return { ok: false, reason: 'ambiguous', candidates: h2.slice(0, 12) };
    }
    return { ok: false, reason: 'notfound' };
  }

  // ---- 按代码解析 ----
  const d = _lkDigits(raw);
  if (!d || d.length !== 6) return { ok: false, reason: 'badcode' };
  const localName = ok ? (window.STOCK_NAMES[d] || null) : null;
  if (localName) return { ok: true, code: d, name: localName };

  // 本地索引没有：用行情接口反查名称（同时校验代码是否有效）
  try {
    const quotes = await fetchStockQuotes([d]);
    const q0 = quotes && quotes[0];
    if (q0 && !q0.error && q0.name && !/^\d+$/.test(q0.name)) {
      return { ok: true, code: extractDigits(d), name: q0.name };
    }
  } catch (e) {}
  return { ok: false, reason: 'badcode' };
}

/** 解析失败时的中文提示 */
function stockLookupErrorText(res) {
  if (!res) return '添加失败，请重试';
  switch (res.reason) {
    case 'empty': return '请输入股票代码或名称';
    case 'badcode': return '未找到该代码的行情，请检查是否为 6 位代码';
    case 'notfound': return '未找到匹配的股票，请检查名称或改用 6 位代码';
    case 'ambiguous': return '匹配到多只股票，请从下拉列表中选择';
    case 'offline': return '股票名称索引加载失败，请联网后重试或直接输入 6 位代码';
    default: return '添加失败，请重试';
  }
}
