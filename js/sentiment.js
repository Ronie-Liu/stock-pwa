// ===== 情绪偏好每日打分（环境页子功能） =====
// 数据源：东方财富实时统计接口（push2/push2ex/push2delay）+ 数据中心(JSONP)
// 口径：涨跌比 / 涨停跌停家数 / 昨日涨停板块涨幅 / 融资买入额偏离10日均 / 外部情绪(美股·A50·人民币)
// 容错：所有请求带超时，5项指标逐项容错；单项失败不阻塞整页，页面始终可渲染。

const SENTIMENT_WEIGHTS = [20, 20, 20, 20, 20]; // 5项各20分，总分100
const SENTIMENT_N = 30; // 走势图最多显示近N日
let sentimentChart = null; // 走势图实例

// ===== 基础工具 =====

/** 带超时的 fetch，超时即抛错（防止个别域名挂起导致页面卡死） */
async function fetchWithTimeout(url, timeoutMs = 7000) {
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let resp = await fetch(url, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let text = await resp.text();
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** 依次尝试多个 base host 的同一 path（东财多域名容错） */
async function fetchJSON(path, hosts, timeoutMs = 7000) {
  let lastErr = null;
  for (let base of hosts) {
    try {
      let text = await fetchWithTimeout(base + path, timeoutMs);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('请求失败');
}

const SENT_EM_HOSTS = ['https://push2delay.eastmoney.com', 'https://push2.eastmoney.com'];

/** datacenter-web 无 CORS，用 JSONP；带超时与清理 */
function fetchJSONP(url, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    let cbName = 'sent_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    let sep = url.indexOf('?') >= 0 ? '&' : '?';
    let script = document.createElement('script');
    let timer = null;
    let done = false;
    function cleanup() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    window[cbName] = (data) => { cleanup(); resolve(data); };
    timer = setTimeout(() => { cleanup(); reject(new Error('融资数据超时')); }, timeoutMs);
    script.onerror = () => { cleanup(); reject(new Error('融资数据加载失败')); };
    script.src = url + sep + 'callback=' + cbName;
    document.head.appendChild(script);
  });
}

/** 给 Promise 加总超时（最终兜底，杜绝整页无限等待） */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let timer = setTimeout(() => reject(new Error((label || '') + '超时')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function fmtAmt(v) {
  if (v == null || isNaN(v)) return '--';
  if (v >= 1e8) return (v / 1e8).toFixed(1) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return Math.round(v).toString();
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function pctSign(v) { return (v > 0 ? '+' : '') + v.toFixed(2) + '%'; }

// ===== 档位 =====
const SENT_BANDS = [
  { min: 80, label: '情绪亢奋', tip: '注意高潮风险', color: '#ef4444' },
  { min: 60, label: '情绪回暖', tip: '可积极参与', color: '#f97316' },
  { min: 40, label: '情绪中性', tip: '中性观望', color: '#94a3b8' },
  { min: 20, label: '情绪退潮', tip: '防守为主', color: '#38bdf8' },
  { min: 0, label: '情绪冰点', tip: '等待止跌信号', color: '#8b5cf6' }
];
function sentBand(total) {
  if (total == null || isNaN(total)) return SENT_BANDS[SENT_BANDS.length - 1];
  for (let b of SENT_BANDS) {
    if (total >= b.min) return b;
  }
  return SENT_BANDS[SENT_BANDS.length - 1];
}

// ===== 数据获取（每项独立容错，返回 {ok, data?, error?}） =====

/** 指标1：全市场涨跌家数、涨跌比 */
async function fetchBreadth() {
  // 上证指数 + 深证成指 的市场涨跌家数统计（f104=上涨 f105=下跌 f106=平盘）
  let url = '/api/qt/ulist.np/get?fltt=2&invt=2&fields=f104,f105,f106,f12&secids=1.000001,0.399001';
  let json = await fetchJSON(url, SENT_EM_HOSTS);
  let diff = (json && json.data && json.data.diff) || [];
  let up = 0, down = 0, flat = 0;
  for (let d of diff) {
    up += Number(d.f104) || 0;
    down += Number(d.f105) || 0;
    flat += Number(d.f106) || 0;
  }
  if (up + down === 0) throw new Error('涨跌家数为0');
  return { up, down, flat, ratio: down > 0 ? up / down : (up > 0 ? 99 : 0) };
}

/** 涨停/跌停池接口：带超时 + 自动回溯到最近交易日（最多7天） */
const EM_PUSH2EX = 'https://push2ex.eastmoney.com';
const EM_UT = '7eea3edcaed734bea9cbfc24409ed989';

function recentDateCandidates(limit = 3) {
  let arr = [];
  let d = new Date();
  for (let i = 0; i < limit; i++) {
    let y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    arr.push(y + m + day);
    d.setDate(d.getDate() - 1);
  }
  return arr;
}

async function queryLimitPool(type, date) {
  let endpoint = type === 'zt' ? 'getTopicZTPool' : 'getTopicDTPool';
  let sort = type === 'zt' ? 'fbt%3Aasc' : 'fund%3Aasc';
  let url = EM_PUSH2EX + '/' + endpoint + '?ut=' + EM_UT + '&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=' + sort + '&date=' + date;
  let text = await fetchWithTimeout(url, 6000);
  let json = JSON.parse(text);
  if (json && json.data && typeof json.data.tc === 'number' && String(json.data.qdate) === date) {
    return json.data.tc;
  }
  throw new Error('无数据');
}

/** 指标2：涨停/跌停家数 */
async function fetchLimitStats() {
  let zt = null, ztDate = null;
  for (let date of recentDateCandidates(7)) {
    try { let v = await queryLimitPool('zt', date); zt = v; ztDate = date; break; }
    catch (e) { /* 尝试更早日期 */ }
  }
  if (zt == null) throw new Error('涨停池获取失败');
  let dt = 0;
  for (let date of [ztDate, ...recentDateCandidates(7)]) {
    try { dt = await queryLimitPool('dt', date); break; }
    catch (e) { /* 尝试更早日期 */ }
  }
  return { date: ztDate, zt: zt, dt: dt };
}

/** 指标3：昨日涨停概念板块今日涨幅（BK0815 昨日涨停；BK1050 含一字参考） */
async function fetchYesterdayLimitBoard() {
  let url = '/api/qt/ulist.np/get?fltt=2&invt=2&fields=f3,f12,f14&secids=90.BK0815,90.BK1050';
  let json = await fetchJSON(url, SENT_EM_HOSTS);
  let diff = (json && json.data && json.data.diff) || [];
  let main = null, incl = null;
  for (let d of diff) {
    if (String(d.f12) === 'BK0815') main = { name: d.f14, pct: Number(d.f3) };
    if (String(d.f12) === 'BK1050') incl = { name: d.f14, pct: Number(d.f3) };
  }
  if (!main && incl) main = incl;
  if (!main || main.pct == null) throw new Error('昨日涨停板块无数据');
  return { main: main, incl: incl };
}

/** 指标4：融资买入额 当日 vs 近10日均值偏离（东财数据中心 RPTA_RZRQ_LSHJ 两市合计） */
async function fetchMargin() {
  let base = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=ALL&source=WEB&sortColumns=DIM_DATE&sortTypes=-1&pageNumber=1&pageSize=14';
  let json = await fetchJSONP(base);
  let rows = (json && json.result && json.result.data) || [];
  if (rows.length === 0) throw new Error('融资数据为空');
  let today = rows[0];
  let avg10 = rows.slice(1, 11);
  if (avg10.length === 0) throw new Error('融资10日历史不足');
  let mean = avg10.reduce((a, r) => a + (Number(r.RZMRE) || 0), 0) / avg10.length;
  if (mean <= 0) throw new Error('融资10日均值为0');
  let cur = Number(today.RZMRE) || 0;
  return {
    date: String(today.DIM_DATE || '').slice(0, 10),
    today: cur,
    mean: mean,
    deviation: (cur / mean - 1) * 100
  };
}

/** 指标5：外部情绪 美股(DJIA)/A50(XIN9)/人民币(USDCNH 升值=正) */
async function fetchExternal() {
  let out = {};
  let secids = ['100.DJIA', '100.XIN9', '133.USDCNH'];
  let url = '/api/qt/ulist.np/get?fltt=2&invt=2&fields=f3,f12,f14&secids=' + secids.join(',');
  let json = await fetchJSON(url, SENT_EM_HOSTS);
  let diff = (json && json.data && json.data.diff) || [];
  for (let d of diff) {
    if (String(d.f12) === 'DJIA') out.djia = Number(d.f3);
    if (String(d.f12) === 'XIN9') out.a50 = Number(d.f3);
    if (String(d.f12) === 'USDCNH') out.usdcnh = Number(d.f3);
  }
  // 分批补齐缺失项
  let singleMap = { DJIA: '100.DJIA', XIN9: '100.XIN9', USDCNH: '133.USDCNH' };
  for (let key of Object.keys(singleMap)) {
    if (out[key] != null) continue;
    try {
      let j = await fetchJSON('/api/qt/ulist.np/get?fltt=2&invt=2&fields=f3,f12,f14&secids=' + singleMap[key], SENT_EM_HOSTS);
      let d2 = (j.data && j.data.diff) || [];
      if (d2[0]) out[key] = Number(d2[0].f3);
    } catch (e) { /* 继续补齐其他项 */ }
  }
  if (out.djia == null || out.a50 == null || out.usdcnh == null) throw new Error('外部行情获取不完整');
  // 人民币升值(USDCNH下跌)视为正面
  return {
    djia: out.djia, a50: out.a50,
    usdcnh: out.usdcnh,
    positives: (out.djia > 0 ? 1 : 0) + (out.a50 > 0 ? 1 : 0) + (out.usdcnh < 0 ? 1 : 0)
  };
}

// ===== 打分规则（按用户表 20分制线性映射） =====

function scoreBreadth(ratio) {
  if (ratio > 3) return clamp(16 + (ratio - 3) * 4, 16, 20);       // >3 → 16-20
  if (ratio >= 2) return clamp(11 + (ratio - 2) * 4, 11, 15);       // 2-3 → 11-15
  if (ratio >= 1) return clamp(6 + (ratio - 1) * 4, 6, 10);         // 1-2 → 6-10
  if (ratio >= 0.5) return clamp(3 + (ratio - 0.5) * 4, 3, 5);      // 0.5-1 → 3-5
  return clamp((ratio / 0.5) * 2, 0, 2);                            // <0.5 → 0-2
}

function scoreLimit(zt, dt) {
  let s;
  if (zt >= 120) s = 20;
  else if (zt > 80) s = clamp(16 + ((zt - 80) / 40) * 4, 16, 20);
  else if (zt >= 50) s = clamp(11 + ((zt - 50) / 30) * 4, 11, 15);
  else if (zt >= 30) s = clamp(6 + ((zt - 30) / 20) * 4, 6, 10);
  else s = clamp((zt / 30) * 5, 0, 5);
  // 跌停家数压制（高跌停=退潮）
  if (dt > 40) s = Math.min(s, 5);
  else if (dt > 20) s = Math.min(s, 10);
  else if (dt > 10) s = Math.min(s, 15);
  return Math.round(s * 100) / 100;
}

function scoreYestBoard(pct) {
  if (pct > 3) return clamp(16 + (pct - 3) * 2, 16, 20);          // >3% → 16-20
  if (pct >= 1) return clamp(11 + (pct - 1) * 2, 11, 15);          // 1-3% → 11-15
  if (pct >= -1) return clamp(6 + (pct + 1) * 2, 6, 10);           // -1~1% → 6-10
  return clamp(5 + (pct + 1) * 5, 0, 5);                           // <-1% → 0-5
}

function scoreMargin(devPct) {
  if (devPct >= 15) return clamp(16 + ((devPct - 15) / 10) * 4, 16, 20);
  if (devPct >= 5) return clamp(11 + ((devPct - 5) / 10) * 4, 11, 15);
  if (devPct > -15) return clamp(6 + ((devPct + 15) / 20) * 4, 6, 10);
  return clamp((devPct + 25) / 10 * 5, 0, 5);
}

function scoreExternal(pos) {
  return [0, 1, 2, 3].includes(pos) ? [3, 8, 13, 18][pos] : 8; // 三负/一正/两正/三正 中值
}

// ===== 汇总打分（单项容错） =====

const SENT_FETCHERS = [
  { key: 'breadth', name: '涨跌比', fetch: () => fetchBreadth() },
  { key: 'limit', name: '涨停/跌停家数', fetch: () => fetchLimitStats() },
  { key: 'yestboard', name: '昨日涨停今日表现', fetch: () => fetchYesterdayLimitBoard() },
  { key: 'margin', name: '融资买入额占比偏离度', fetch: () => fetchMargin() },
  { key: 'external', name: '外部情绪传导', fetch: () => fetchExternal() }
];

async function computeSentimentScore() {
  // 并发请求，每项内部已容错并带超时
  let results = await Promise.all(SENT_FETCHERS.map(async (item) => {
    try {
      let data = await item.fetch();
      return { key: item.key, name: item.name, ok: true, data: data, error: null };
    } catch (e) {
      return { key: item.key, name: item.name, ok: false, data: null, error: e.message || String(e) };
    }
  }));

  let okItems = results.filter(r => r.ok);
  let okKeys = okItems.map(r => r.key);

  // 逐项算分
  let scored = [];
  for (let r of results) {
    let score = null, desc = '';
    if (r.ok) {
      try {
        if (r.key === 'breadth') {
          score = scoreBreadth(r.data.ratio);
          desc = '上涨' + r.data.up + ' / 下跌' + r.data.down + '，比值 ' + r.data.ratio.toFixed(2);
        } else if (r.key === 'limit') {
          score = scoreLimit(r.data.zt, r.data.dt);
          desc = '涨停 ' + r.data.zt + ' 家 / 跌停 ' + r.data.dt + ' 家';
        } else if (r.key === 'yestboard') {
          score = scoreYestBoard(r.data.main.pct);
          desc = (r.data.main.name || '昨日涨停') + ' 板块 ' + pctSign(r.data.main.pct) +
            (r.data.incl && r.data.incl.pct != null ? '（含一字 ' + pctSign(r.data.incl.pct) + '）' : '');
        } else if (r.key === 'margin') {
          score = scoreMargin(r.data.deviation);
          desc = '当日 ' + fmtAmt(r.data.today) + ' 元 / 10日均 ' + fmtAmt(r.data.mean) + ' 元，偏离 ' +
            pctSign(r.data.deviation) + '（占比口径近似：当日融资买入额相对10日均偏离）';
        } else if (r.key === 'external') {
          score = scoreExternal(r.data.positives);
          desc = '美股 ' + pctSign(r.data.djia) + ' / A50 ' + pctSign(r.data.a50) + ' / 人民币' +
            (r.data.usdcnh < 0 ? '升值' : '贬值') + '(' + pctSign(r.data.usdcnh) + ')，正面 ' + r.data.positives + ' 项';
        }
      } catch (e) {
        score = null;
        desc = '打分异常: ' + (e.message || e);
      }
    } else {
      desc = '数据获取失败：' + r.error;
    }
    scored.push({ key: r.key, name: r.name, score: score, desc: desc, ok: r.ok });
  }

  let complete = okKeys.length === SENT_FETCHERS.length;
  let total = complete ? Math.round(scored.reduce((a, s) => a + s.score, 0) * 10) / 10 : null;
  let band = sentBand(total);

  // 日期：涨停池回溯到的最近交易日优先；否则融资数据日期；否则今天
  let rawDate = '';
  let lp = results.find(r => r.key === 'limit');
  if (lp && lp.ok && lp.data.date) rawDate = lp.data.date;
  if (!rawDate) {
    let mf = results.find(r => r.key === 'margin');
    if (mf && mf.ok && mf.data.date) rawDate = String(mf.data.date).replace(/-/g, '');
  }
  if (!rawDate) {
    let d = new Date();
    rawDate = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }
  let dateStr = rawDate.length === 8 ? rawDate.slice(0, 4) + '-' + rawDate.slice(4, 6) + '-' + rawDate.slice(6, 8) : rawDate;

  return {
    complete: complete,
    date: dateStr,
    total: total,
    band: band,
    items: scored,
    failed: results.filter(r => !r.ok).map(r => r.name + '(' + (r.error || '') + ')'),
    updated_at: new Date().toISOString()
  };
}

// ===== 页面渲染 =====

function disposeSentiment() {
  if (sentimentChart) { sentimentChart.dispose(); sentimentChart = null; }
}

async function renderSentimentBody(container) {
  container.innerHTML = `
    <div class="sentiment-page">
      <div class="sentiment-toolbar">
        <div style="font-size:15px;font-weight:700;">情绪偏好打分（每日一次 · 满分100）</div>
        <button class="btn btn-sm" id="btn-sent-refresh">🔄 刷新打分</button>
      </div>
      <div class="sentiment-loading" id="sent-loading"><span class="spinner"></span> 正在拉取市场数据打分...</div>
      <div class="sentiment-result" id="sent-result" style="display:none"></div>
      <div class="sentiment-history-title">近${SENTIMENT_N}日走势</div>
      <div class="sentiment-chart" id="sent-chart"></div>
      <div class="sentiment-note">口径说明：涨跌比=上涨/下跌家数；涨停跌停家数为当日封板统计；昨日涨停今日表现直接取「昨日涨停」概念板块当日涨幅；融资买入额偏离度=当日融资买入额相对近10个交易日均值的偏离（因无稳定的两市成交额日度历史，作为“占比偏离”的近似）；外部情绪=美股(道指)+富时A50+离岸人民币，人民币升值记为正面。盘中查看为实时快照，建议收盘后刷新为当日定版。</div>
    </div>`;

  let loading = document.getElementById('sent-loading');
  let resultEl = document.getElementById('sent-result');

  async function refresh() {
    if (loading) { loading.style.display = 'flex'; loading.innerHTML = '<span class="spinner"></span> 正在拉取市场数据打分...'; }
    if (resultEl) { resultEl.style.display = 'none'; resultEl.innerHTML = ''; }
    let btn = document.getElementById('btn-sent-refresh');
    if (btn) btn.disabled = true;
    try {
      // 整体 30s 兜底，确保不会无限等待
      let rec = await withTimeout(computeSentimentScore(), 30000, '整体打分');
      if (rec.complete) {
        await saveSentimentRecord({
          date: rec.date, total: rec.total, band: rec.band,
          items: rec.items, updated_at: rec.updated_at
        });
      }
      renderSentimentResult(resultEl, rec);
      if (resultEl) resultEl.style.display = 'block';
      if (loading) loading.style.display = 'none';
    } catch (e) {
      console.error('情绪打分失败:', e);
      if (loading) {
        loading.style.display = 'flex';
        loading.innerHTML = '<span style="color:var(--danger)">打分失败: ' + escapeHtml(e.message) + '</span>　<button class="btn btn-sm" id="btn-sent-retry" style="margin-left:8px">重试</button>';
        let retry = document.getElementById('btn-sent-retry');
        if (retry) retry.onclick = refresh;
      }
    } finally {
      let b2 = document.getElementById('btn-sent-refresh');
      if (b2) b2.disabled = false;
      // 无论打分结果如何，都尝试渲染历史走势
      try { renderSentimentTrend(); } catch (e2) { console.error('走势渲染失败:', e2); }
    }
  }

  let btn = document.getElementById('btn-sent-refresh');
  if (btn) btn.addEventListener('click', refresh);

  await refresh();
}

function renderSentimentResult(el, rec) {
  if (!el) return;
  let band = sentBand(rec.total);
  let totalHtml = rec.complete && rec.total != null
    ? '<div class="sent-total" style="color:' + band.color + '">' + rec.total.toFixed(1) + '</div>'
    : '<div class="sent-total" style="color:#8b5cf6">--</div>';

  let html = `
    <div class="sent-band-card" style="border-left:6px solid ${band.color}">
      ${totalHtml}
      <div class="sent-band-meta">
        <div class="sent-band-label" style="background:${band.color}">${band.label}</div>
        <div class="sent-band-tip">${band.tip}</div>
        <div class="sent-date">数据日 ${escapeHtml(rec.date)}（东财实时统计）</div>
        ${!rec.complete ? '<div class="sent-warn">部分数据源不可用，总分暂缺：' + escapeHtml(rec.failed.join('；')) + '，可点刷新重试</div>' : ''}
      </div>
    </div>
    <div class="sent-items">
      ${rec.items.map(it => {
        let scoreTxt = (it.ok && it.score != null) ? it.score.toFixed(1) : '--';
        let color = (it.ok && it.score != null) ? (it.score >= 16 ? '#ef4444' : it.score >= 11 ? '#f97316' : it.score >= 6 ? '#94a3b8' : '#38bdf8') : '#8b5cf6';
        let pctW = (it.ok && it.score != null) ? clamp(it.score / 20 * 100, 0, 100) : 0;
        return `
        <div class="sent-item">
          <div class="sent-item-head">
            <span class="sent-item-name">${escapeHtml(it.name)}</span>
            <span class="sent-item-score" style="color:${color}">${scoreTxt}<i>/20</i></span>
          </div>
          <div class="sent-bar"><div class="sent-bar-fill" style="width:${pctW}%;background:${color}"></div></div>
          <div class="sent-item-desc">${escapeHtml(it.desc)}</div>
        </div>`;
      }).join('')}
    </div>`;
  el.innerHTML = html;
}

async function renderSentimentTrend() {
  let chartEl = document.getElementById('sent-chart');
  if (!chartEl) return;
  try {
    let records = await getAllSentimentRecords();
    records = records.slice(0, SENTIMENT_N).reverse();
    if (records.length < 1) { chartEl.innerHTML = '<div class="empty-state">暂无历史，每天打开本页会自动积累</div>'; return; }

    if (typeof echarts === 'undefined') { await loadECharts(); }
    chartEl.innerHTML = '';
    let isLight = document.documentElement.getAttribute('data-theme') === 'light';
    let textColor = isLight ? '#333' : '#e0e0e0';
    let dates = records.map(r => r.date);
    let totals = records.map(r => (r.total != null ? r.total : null));

    if (sentimentChart) { sentimentChart.dispose(); sentimentChart = null; }

    let markBands = [];
    [80, 60, 40, 20].forEach(v => {
      markBands.push({ yAxis: v, lineStyle: { color: '#94a3b8', type: 'dashed', width: 1 }, label: { formatter: v + '分', fontSize: 9, color: textColor } });
    });

    sentimentChart = echarts.init(chartEl);
    sentimentChart.setOption({
      backgroundColor: 'transparent',
      animation: false,
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 12, top: 18, bottom: 24 },
      xAxis: { type: 'category', data: dates, axisLabel: { color: textColor, fontSize: 9 }, axisLine: { lineStyle: { color: '#2a2a2a' } } },
      yAxis: { type: 'value', min: 0, max: 100, interval: 20, axisLabel: { color: textColor, fontSize: 9 } },
      series: [{
        type: 'line', data: totals, smooth: false, symbol: 'circle', symbolSize: 5,
        lineStyle: { color: '#f97316', width: 2 },
        itemStyle: { color: function(p) { return sentBand(p.value).color; } },
        markLine: { symbol: 'none', data: markBands, label: { show: true, fontSize: 9 } },
        areaStyle: { color: 'rgba(249,115,22,0.10)' }
      }]
    });
  } catch (e) {
    console.error('走势渲染失败:', e);
    chartEl.innerHTML = '<div class="empty-state">走势加载失败: ' + escapeHtml(e.message) + '</div>';
  }
}
