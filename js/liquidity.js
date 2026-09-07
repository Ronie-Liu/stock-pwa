// ===== 流动性晴雨表（环境页子功能 · 全自动打分） =====
// 口径：5项指标 × 20分 = 总分100；数据自动抓取，自动保存快照（IndexedDB: liquidity_daily）。
// 数据源（均浏览器直连/CORS开放，多域名回退；东财数据中心 fetch失败自动JSONP兜底）：
//   1 两市成交额20日均值趋势 —— 腾讯 newfqkline（sh000001 沪市 + sz399106 深市，行[8]=成交额万元）
//   2 M1-M2剪刀差(近3个月) —— 东财数据中心 RPT_ECONOMY_CURRENCY_SUPPLY（月度，与legulegu同源同值）
//   3 融资余额20日变化 —— 东财数据中心 RPTA_RZRQ_LSHJ（RZYE=两市融资余额,元）
//   4 10Y美债收益率趋势 —— 东财数据中心 RPTA_WEB_TREASURYYIELD（EMG00001310=美10Y，%）
//   5 央行货币政策态度 —— 代理量化：近6个月LPR1Y变动(RPTA_WEB_RATE) + 中国10Y收益率20日变动(EMM00166466)
// 容错：每项独立超时+失败降级，单项失败不阻塞整页。

const LIQ_MAX_RECORDS = 30;  // 走势图/历史最多显示近N条
const LIQ_FETCH_TIMEOUT = 12000;
const LIQ_CB_PREFIX = 'liq_cb';

let liquidityChart = null;   // ECharts 走势图实例
let liqFetchedAt = 0;        // 本次已加载的完整打分时间戳（避免重复保存）

// ===== 档位（用户表） =====
const LIQ_BANDS = [
  { min: 80, label: '流动性充裕', tip: '资金面宽裕，市场活跃度高', color: '#ef4444' },
  { min: 60, label: '中性偏好', tip: '流动性偏松，正常参与', color: '#f97316' },
  { min: 40, label: '中性偏紧', tip: '资金面收敛，注意控制节奏', color: '#94a3b8' },
  { min: 0, label: '流动性紧张', tip: '资金明显偏紧，防守为主', color: '#38bdf8' }
];

function liqBand(total) {
  if (total == null || isNaN(total)) return LIQ_BANDS[LIQ_BANDS.length - 1];
  for (let b of LIQ_BANDS) {
    if (total >= b.min) return b;
  }
  return LIQ_BANDS[LIQ_BANDS.length - 1];
}

function liqClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function liqRound1(v) { return Math.round(v * 10) / 10; }
function liqToday() {
  let d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function liqAmtY(v) { // 元 -> 亿字符串
  if (v == null || isNaN(v)) return '--';
  return (v / 1e8).toFixed(0) + '亿';
}

// ===== 基础请求（带超时） =====

async function liqFetchText(url, timeoutMs) {
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeoutMs || 12000);
  try {
    let resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function liqFetchJSON(url, timeoutMs) {
  let text = await liqFetchText(url, timeoutMs);
  let clean = text.trim();
  // 腾讯偶发返回GBK或异常；仅接受 JSON 开头
  if (clean.charAt(0) !== '{' && clean.charAt(0) !== '[') throw new Error('非JSON响应');
  return JSON.parse(clean);
}

/** 带超时与多域名回退 */
async function liqFetchFirst(urls, timeoutMs) {
  let lastErr = null;
  for (let u of urls) {
    try { return await liqFetchJSON(u, timeoutMs); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('请求失败');
}

/** 东财数据中心通用（返回 result.data 数组）；fetch失败自动用JSONP兜底 */
async function liqFetchDataCenter(reportName, sortCol, pageSize) {
  let url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=' + reportName +
    '&columns=ALL&source=WEB&sortColumns=' + sortCol + '&sortTypes=-1&pageNumber=1&pageSize=' + pageSize;
  let rows = null;
  let errMsg = '';
  try {
    rows = await liqFetchJsonRows(url);
  } catch (e) {
    errMsg = e.message || String(e);
  }
  if (!rows) {
    // 该域名部分网络环境无CORS，JSONP兜底
    try {
      rows = await liqFetchJsonpRows(url);
    } catch (e2) {
      throw new Error('数据为空' + (errMsg ? '(' + errMsg + ')' : ''));
    }
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('数据为空');
  return rows;
}

/** 解析东财数据中心 fetch 返回的 result.data */
async function liqFetchJsonRows(url) {
  let json = await liqFetchJSON(url, 12000);
  let rows = (json && json.result && json.result.data) || null;
  return rows;
}

/** 东财数据中心 JSONP 兜底（datacenter-web 支持 callback=） */
function liqFetchJsonpRows(url) {
  return new Promise((resolve, reject) => {
    let cbName = LIQ_CB_PREFIX + '_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
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
    window[cbName] = (data) => {
      cleanup();
      resolve((data && data.result && data.result.data) || null);
    };
    timer = setTimeout(() => { cleanup(); reject(new Error('数据中心超时')); }, 12000);
    script.onerror = () => { cleanup(); reject(new Error('数据中心加载失败')); };
    script.src = url + sep + 'callback=' + cbName;
    document.head.appendChild(script);
  });
}

// ===== 指标1：两市成交额20日均值 vs 半年均值 =====

const LIQ_TX_HOSTS = [
  'https://ifzq.gtimg.cn',
  'https://web.ifzq.gtimg.cn',
  'https://proxy.finance.qq.com/ifzqgtimg'
];

/** 腾讯 newfqkline 日K（含成交额，行[8]=万元）；返回 {date, amount} 升序 */
async function liqFetchTxAmount(code) {
  let urls = LIQ_TX_HOSTS.map(h => h + '/appstock/app/newfqkline/get?param=' + code + ',day,,,170,qfq');
  let json = await liqFetchFirst(urls, 12000);
  let sd = json && json.data && json.data[code];
  if (!sd) throw new Error('腾讯' + code + '无数据');
  let rows = sd.day || sd.qfqday || sd.data;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('腾讯' + code + 'K线为空');
  let out = [];
  for (let r of rows) {
    if (!r || !r[0]) continue;
    let amountWan = parseFloat(r[8]);
    if (!isNaN(amountWan) && amountWan > 0) {
      out.push({ date: String(r[0]).slice(0, 10), amount: amountWan * 1e4 });
    }
  }
  if (out.length < 30) throw new Error('腾讯' + code + '有效数据过少');
  return out;
}

/** 合并沪深两市成交额并按日期排序（去掉未收盘的当日部分行） */
async function liqFetchTwoMarketAmount() {
  let [sh, sz] = await Promise.all([liqFetchTxAmount('sh000001'), liqFetchTxAmount('sz399106')]);
  let map = {};
  for (let a of sh) map[a.date] = (map[a.date] || 0) + a.amount;
  for (let a of sz) map[a.date] = (map[a.date] || 0) + a.amount;
  let dates = Object.keys(map).sort();
  let series = dates.map(d => ({ date: d, amount: map[d] }));

  // 盘中最后一行是当日未收盘的累计值，剔除以免低估
  let now = new Date();
  let todayStr = liqToday();
  let hourMin = now.getHours() * 100 + now.getMinutes();
  let isTradingNow = (now.getDay() >= 1 && now.getDay() <= 5) && hourMin < 1505;
  if (isTradingNow && series.length && series[series.length - 1].date === todayStr) {
    series.pop();
  }
  if (series.length < 60) throw new Error('两市成交额历史不足60日');
  return series;
}

function liqScoreTurnover(ratio) {
  // >120%:16-20 / 100-120%:11-15 / 80-100%:6-10 / <80%:0-5
  let pct = ratio * 100;
  if (pct >= 120) return liqClamp(16 + ((pct - 120) / 30) * 4, 16, 20);
  if (pct >= 100) return liqClamp(11 + ((pct - 100) / 20) * 4, 11, 15);
  if (pct >= 80) return liqClamp(6 + ((pct - 80) / 20) * 4, 6, 10);
  return liqClamp(5 - ((80 - pct) / 20) * 5, 0, 5);
}

async function liqIndicatorTurnover() {
  let series = await liqFetchTwoMarketAmount();
  let len = series.length;
  let halfWin = Math.min(len, 120);
  let half = series.slice(-halfWin);
  let ma20 = half.slice(-20).reduce((a, r) => a + r.amount, 0) / 20;
  let maHalf = half.reduce((a, r) => a + r.amount, 0) / half.length;
  if (maHalf <= 0) throw new Error('成交额均值为0');
  let ratio = ma20 / maHalf;
  let score = liqScoreTurnover(ratio);
  let pct20 = (ma20 / 1e8).toFixed(0);
  let pctHalf = (maHalf / 1e8).toFixed(0);
  return {
    score: liqRound1(score),
    desc: '两市20日均成交额 ' + pct20 + '亿，近半年均值 ' + pctHalf + '亿，比值 ' + (ratio * 100).toFixed(1) + '%',
    raw: { ratio: liqRound1(ratio * 100), ma20, maHalf }
  };
}

// ===== 指标2：M1-M2剪刀差（近3个月变化，月度数据） =====

async function liqIndicatorM1M2() {
  let rows = await liqFetchDataCenter('RPT_ECONOMY_CURRENCY_SUPPLY', 'REPORT_DATE', 500);
  // CURRENCY_SAME=M1同比%, BASIC_CURRENCY_SAME=M2同比%
  let list = rows.map(r => ({
    ym: String(r.REPORT_DATE || '').slice(0, 7),
    m1: Number(r.CURRENCY_SAME),
    m2: Number(r.BASIC_CURRENCY_SAME)
  })).filter(r => !isNaN(r.m1) && !isNaN(r.m2));
  if (list.length < 4) throw new Error('M1/M2数据不足');
  let latest = list[0];
  let latestYm = latest.ym;
  let ly = parseInt(latestYm.slice(0, 4), 10), lm = parseInt(latestYm.slice(5, 7), 10);
  let target = ly * 12 + lm - 3; // 3个月前
  let prev = null;
  for (let r of list.slice(1)) {
    let ry = parseInt(r.ym.slice(0, 4), 10), rm = parseInt(r.ym.slice(5, 7), 10);
    if (ry * 12 + rm <= target) { prev = r; break; }
  }
  if (!prev) throw new Error('无3个月前M1/M2');
  let sc0 = latest.m1 - latest.m2;
  let sc1 = prev.m1 - prev.m2;
  let delta = sc0 - sc1; // 回升为正

  let score;
  if (delta >= 0.3) score = liqClamp(16 + ((delta - 0.3) / 1.2) * 4, 16, 20);
  else if (delta >= -0.3) score = liqClamp(12.5 + (delta / 0.6) * 2.5, 10, 15); // 持平 10-15
  else if (delta >= -1.0) score = liqClamp(9 + ((delta + 0.3) / 0.7) * 4, 5, 9);  // 小幅回落 5-9
  else score = liqClamp(4 + ((delta + 1.0) / 1.5) * 4, 0, 4);                    // 明显回落 0-4
  score = liqRound1(score);

  return {
    score: score,
    desc: '最新' + latestYm + '月剪刀差 ' + sc0.toFixed(1) + 'pp（M1同比' + latest.m1.toFixed(1) + '% - M2同比' + latest.m2.toFixed(1) + '%），较' + prev.ym + '月变化 ' + (delta >= 0 ? '+' : '') + delta.toFixed(1) + 'pp',
    raw: { ym: latestYm, prevYm: prev.ym, scissors: sc0, prevScissors: sc1, delta: liqRound1(delta) }
  };
}

// ===== 指标3：融资余额20日变化 =====

async function liqIndicatorMargin() {
  let rows = await liqFetchDataCenter('RPTA_RZRQ_LSHJ', 'DIM_DATE', 40);
  let list = rows.map(r => ({ date: String(r.DIM_DATE || '').slice(0, 10), ye: Number(r.RZYE) }))
    .filter(r => r.ye > 0);
  if (list.length < 21) throw new Error('融资余额数据不足');
  let now0 = list[0].ye;
  let prev20 = list[20].ye;
  let growth = (now0 / prev20 - 1) * 100; // %
  let score;
  if (growth > 3) score = liqClamp(16 + ((growth - 3) / 3) * 4, 16, 20);
  else if (growth >= 0) score = liqClamp(11 + (growth / 3) * 4, 11, 15);
  else if (growth >= -3) score = liqClamp(10 + (growth / 3) * 4, 6, 10);
  else score = liqClamp(5 + ((growth + 3) / 3) * 5, 0, 5);
  score = liqRound1(score);
  return {
    score: score,
    desc: '最新融资余额 ' + liqAmtY(now0) + '（' + list[0].date + '），较20交易日前 ' + liqAmtY(prev20) + ' 变动 ' + (growth >= 0 ? '+' : '') + growth.toFixed(2) + '%',
    raw: { date: list[0].date, growth: liqRound1(growth) }
  };
}

// ===== 指标4+5 共用的中美国债收益率 =====

async function liqFetchTreasuryYields() {
  let rows = await liqFetchDataCenter('RPTA_WEB_TREASURYYIELD', 'SOLAR_DATE', 120);
  return rows;
}

/** 取最近一段非空收益序列(降序)与两端的交易日间隔 */
function liqBuildYieldSeries(rows, field) {
  let arr = [];
  for (let r of rows) {
    let v = r[field];
    if (v == null) continue;
    let n = Number(v);
    if (isNaN(n)) continue;
    arr.push({ date: String(r.SOLAR_DATE || '').slice(0, 10), v: n });
    if (arr.length >= 40) break;
  }
  if (arr.length < 2) throw new Error('收益率数据不足');
  return arr;
}

// ===== 指标4：10Y美债收益率趋势（20交易日变化bp） =====

async function liqIndicatorUS10Y() {
  let rows = await liqFetchTreasuryYields();
  let arr = liqBuildYieldSeries(rows, 'EMG00001310'); // 美10Y %
  let horizon = arr.length >= 21 ? 20 : (arr.length >= 11 ? 10 : arr.length - 1);
  let ref = arr[horizon];
  let dbp = (arr[0].v - ref.v) * 100; // 20交易日变动，负=下行
  let score;
  if (dbp <= -20) score = liqClamp(16 + ((-20 - dbp) / 20) * 4, 16, 20);  // 持续下行16-20
  else if (dbp < 0) score = liqClamp(11 + ((0 - dbp) / 20) * 4, 11, 15);   // 小幅下行11-15
  else if (dbp <= 15) score = liqClamp(10 - (dbp / 15) * 4, 6, 10);        // 横盘6-10
  else score = liqClamp(5 - ((dbp - 15) / 15) * 5, 0, 5);                  // 持续上行0-5
  score = liqRound1(score);
  return {
    score: score,
    desc: '美10Y收益率 ' + arr[0].v.toFixed(2) + '%（' + arr[0].date + '），较' + horizon + '个交易日变动 ' + (dbp >= 0 ? '+' : '') + dbp.toFixed(0) + 'bp',
    raw: { date: arr[0].date, dbp: Math.round(dbp) }
  };
}

// ===== 指标5：央行货币政策态度（LPR近6月 + 中国10Y变动 代理量化） =====

async function liqIndicatorPolicy() {
  // LPR 近6个月是否下调
  let lprRows = await liqFetchDataCenter('RPTA_WEB_RATE', 'TRADE_DATE', 24);
  let lprList = lprRows.map(r => ({ date: String(r.TRADE_DATE || '').slice(0, 10), v: Number(r.LPR1Y) }))
    .filter(r => !isNaN(r.v));
  if (lprList.length < 2) throw new Error('LPR数据不足');

  let lprNow = lprList[0].v;
  let lprRef = lprNow;
  for (let r of lprList.slice(1)) {
    let d = new Date(r.date);
    if (Date.now() - d.getTime() <= 200 * 86400000) { // 近6个月(约180-200天)
      lprRef = Math.min(lprRef, r.v);
    }
  }
  let lprCutBp = (lprRef - lprNow) * 100; // 下调幅度bp(≥0=下调)

  // 中国10Y收益率20交易日变动（代理资金面松紧）
  let rows = await liqFetchTreasuryYields();
  let cnArr = liqBuildYieldSeries(rows, 'EMM00166466'); // 中国10Y %
  let horizon = cnArr.length >= 21 ? 20 : (cnArr.length >= 11 ? 10 : cnArr.length - 1);
  let cnRef = cnArr[horizon];
  let cnDbp = (cnArr[0].v - cnRef.v) * 100;

  let score, label;
  if (lprCutBp >= 10) {           // 近6月LPR实际下调 → 明确宽松
    label = '明确宽松';
    score = liqClamp(16 + ((lprCutBp - 10) / 30) * 4, 16, 20);
  } else if (cnDbp <= -15) {      // 债市大涨=资金面偏松
    label = '中性偏松';
    score = liqClamp(15 + ((cnDbp + 15) / 15) * 4, 11, 15);
  } else if (cnDbp >= 15) {       // 债市大跌=资金面偏紧
    label = '中性偏紧';
    score = liqClamp(10 - ((cnDbp - 15) / 15) * 4, 6, 10);
  } else {                        // 默认中性
    label = '中性';
    score = liqClamp(8 + (cnDbp / 15) * 2, 6, 10);
  }
  score = liqRound1(score);
  let lprTxt = lprCutBp > 0 ? '近6月LPR1Y下调' + lprCutBp.toFixed(0) + 'bp' : '近6月LPR1Y未调整';
  return {
    score: score,
    desc: '代理量化：' + lprTxt + '；中国10Y收益率较' + horizon + '个交易日变动 ' + (cnDbp >= 0 ? '+' : '') + cnDbp.toFixed(0) + 'bp → ' + label,
    raw: { lprCutBp: Math.round(lprCutBp), cnDbp: Math.round(cnDbp), label }
  };
}

// ===== 汇总打分（单项独立容错） =====

const LIQ_FETCHERS = [
  { key: 'turnover', name: '两市成交额20日均值趋势', weight: 20, fetch: () => liqIndicatorTurnover() },
  { key: 'm1m2', name: 'M1-M2剪刀差（近3个月变化）', weight: 20, fetch: () => liqIndicatorM1M2() },
  { key: 'margin', name: '融资余额20日变化', weight: 20, fetch: () => liqIndicatorMargin() },
  { key: 'us10y', name: '10年期美债收益率趋势', weight: 20, fetch: () => liqIndicatorUS10Y() },
  { key: 'policy', name: '央行货币政策态度', weight: 20, fetch: () => liqIndicatorPolicy() }
];

async function liqComputeScore() {
  let results = await Promise.all(LIQ_FETCHERS.map(async (item) => {
    try {
      let data = await item.fetch();
      return { key: item.key, name: item.name, ok: true, data: data, error: null };
    } catch (e) {
      return { key: item.key, name: item.name, ok: false, data: null, error: e.message || String(e) };
    }
  }));

  let items = results.map(r => {
    if (r.ok) {
      return { key: r.key, name: r.name, score: r.data.score, desc: r.data.desc, raw: r.data.raw, ok: true };
    }
    return { key: r.key, name: r.name, score: null, desc: '数据获取失败：' + r.error, ok: false };
  });

  let complete = results.every(r => r.ok);
  let total = complete ? liqRound1(items.reduce((a, s) => a + s.score, 0)) : null;
  let band = liqBand(total);

  return {
    complete: complete,
    date: liqToday(),
    total: total,
    band: band,
    items: items,
    failed: results.filter(r => !r.ok).map(r => r.name + '(' + (r.error || '') + ')'),
    updated_at: new Date().toISOString()
  };
}

// ===== 页面渲染 =====

function disposeLiquidity() {
  if (liquidityChart) { liquidityChart.dispose(); liquidityChart = null; }
}

async function renderLiquidityBody(container) {
  container.innerHTML = `
    <div class="liq-page">
      <div class="liq-toolbar">
        <div style="font-size:15px;font-weight:700;">流动性晴雨表（自动打分 · 满分100）</div>
        <button class="btn btn-sm" id="btn-liq-refresh">🔄 重新打分</button>
      </div>
      <div class="liq-loading" id="liq-loading"><span class="spinner"></span> 正在拉取成交额/宏观数据打分...</div>
      <div class="liq-band-card" id="liq-band-card" style="display:none"></div>
      <div class="liq-items" id="liq-items"></div>
      <div class="liq-note">口径说明：成交额=沪市(sh000001)+深市(sz399106)日成交额，20日均值与近半年(约120交易日)均值比；M1-M2剪刀差=M1同比-M2同比，取最新月与3个月前比较（东财数据中心数据与legulegu同源同值，月度更新）；融资余额为两市合计，取20交易日增幅；美10Y与中10Y为20交易日变动（bp）；央行态度无公告类自动接口，采用代理量化：近6月LPR1Y调整+中国10Y收益率变动推断，仅供参考。盘中查看为实时快照，收盘后刷新为当日定版；完整打分自动保存，可形成历史走势。</div>
      <div class="liq-history-title">历史打分（近${LIQ_MAX_RECORDS}条）</div>
      <div class="liq-chart" id="liq-chart"></div>
      <div class="liq-list" id="liq-list"></div>
    </div>`;

  let loading = document.getElementById('liq-loading');
  let bandCard = document.getElementById('liq-band-card');
  let itemsEl = document.getElementById('liq-items');
  let btn = document.getElementById('btn-liq-refresh');
  if (btn) btn.addEventListener('click', refresh);

  async function refresh() {
    if (loading) { loading.style.display = 'flex'; loading.innerHTML = '<span class="spinner"></span> 正在拉取成交额/宏观数据打分...'; }
    if (bandCard) bandCard.style.display = 'none';
    if (itemsEl) itemsEl.innerHTML = '';
    if (btn) btn.disabled = true;
    try {
      let rec = await liqComputeScore();
      liqRenderResult(bandCard, itemsEl, rec);
      if (rec.complete) {
        // 完整才自动存档
        await saveLiquidityRecord({
          date: rec.date, total: rec.total,
          band: rec.band.label, band_color: rec.band.color,
          items: rec.items.map(it => ({
            key: it.key, name: it.name, score: it.score, tier: it.desc
          })),
          updated_at: rec.updated_at
        });
      }
      if (loading) loading.style.display = 'none';
      try { await liqRefreshHistory(); } catch (e2) { console.error('流动性历史渲染失败:', e2); }
    } catch (e) {
      console.error('流动性打分失败:', e);
      if (loading) {
        loading.style.display = 'flex';
        loading.innerHTML = '<span style="color:var(--danger)">打分失败: ' + escapeHtml(e.message) + '</span>　<button class="btn btn-sm" id="btn-liq-retry" style="margin-left:8px">重试</button>';
        let retry = document.getElementById('btn-liq-retry');
        if (retry) retry.onclick = refresh;
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  await refresh();
}

function liqRenderResult(bandCard, itemsEl, rec) {
  let band = rec.band;
  if (bandCard) {
    bandCard.style.display = 'flex';
    let totalHtml = rec.complete && rec.total != null
      ? '<div class="liq-total" style="color:' + band.color + '">' + rec.total.toFixed(1) + '</div>'
      : '<div class="liq-total" style="color:#8b5cf6">--</div>';
    bandCard.innerHTML = `
      <div style="display:flex;align-items:center;gap:16px;width:100%">
        ${totalHtml}
        <div class="liq-band-meta">
          <div class="liq-band-label" style="background:${band.color}">${band.label}</div>
          <div class="liq-band-tip">${band.tip}</div>
          <div class="liq-date">打分日 ${escapeHtml(rec.date)}（自动快照）</div>
          ${!rec.complete ? '<div class="liq-warn">部分数据源不可用，总分暂缺：' + escapeHtml(rec.failed.join('；')) + '，可点重新打分重试</div>' : ''}
        </div>
      </div>`;
    bandCard.style.borderLeft = '6px solid ' + band.color;
  }
  if (!itemsEl) return;
  itemsEl.innerHTML = rec.items.map(it => {
    let scoreTxt = it.ok ? it.score.toFixed(1) : '--';
    let color = it.ok ? (it.score >= 16 ? '#ef4444' : it.score >= 11 ? '#f97316' : it.score >= 6 ? '#94a3b8' : '#38bdf8') : '#8b5cf6';
    let pctW = it.ok ? liqClamp(it.score / 20 * 100, 0, 100) : 0;
    return `
      <div class="liq-item">
        <div class="liq-item-head">
          <span class="liq-item-name">${escapeHtml(it.name)}<i>20分</i></span>
          <span class="liq-item-score" style="color:${color}">${scoreTxt}<i>/20</i></span>
        </div>
        <div class="liq-bar"><div class="liq-bar-fill" style="width:${pctW}%;background:${color}"></div></div>
        <div class="liq-item-desc">${escapeHtml(it.desc)}</div>
      </div>`;
  }).join('');
}

async function liqRefreshHistory() {
  let chartEl = document.getElementById('liq-chart');
  let listEl = document.getElementById('liq-list');
  if (!chartEl && !listEl) return;

  let records = await getAllLiquidityRecords();
  records = records.slice(0, LIQ_MAX_RECORDS);
  let asc = records.slice().reverse();

  if (listEl) {
    if (records.length === 0) {
      listEl.innerHTML = '<div class="empty-state" style="padding:24px 12px">暂无历史打分记录，完整打分后会自动积累</div>';
    } else {
      listEl.innerHTML = '<div class="liq-row-head"><span>日期</span><span>总分</span><span>档位</span><span></span></div>' +
        records.map((r, ri) => `
          <div class="liq-row">
            <span class="liq-row-date">${escapeHtml(r.date)}</span>
            <span class="liq-row-total" style="color:${r.band_color || liqBand(r.total).color}">${Number(r.total).toFixed(1)}</span>
            <span class="liq-row-band" style="color:${r.band_color || liqBand(r.total).color}">${escapeHtml(r.band || liqBand(r.total).label)}</span>
            <button type="button" class="btn btn-xs liq-del-btn" data-date="${escapeHtml(r.date)}">删除</button>
          </div>`).join('') + '<div class="liq-row-note">自动保存每次完整打分（同一日期覆盖），删除后当日重新刷新可再生成</div>';
      listEl.querySelectorAll('.liq-del-btn').forEach(b2 => {
        b2.addEventListener('click', async () => {
          await deleteLiquidityRecord(b2.dataset.date);
          await liqRefreshHistory();
        });
      });
    }
  }

  if (chartEl) {
    if (asc.length < 1) {
      chartEl.innerHTML = '<div class="empty-state" style="padding:24px 12px">暂无历史，完整打分后自动生成走势</div>';
      return;
    }
    try {
      if (typeof echarts === 'undefined') { await loadECharts(); }
      chartEl.innerHTML = '';
      let isLight = document.documentElement.getAttribute('data-theme') === 'light';
      let textColor = isLight ? '#333' : '#e0e0e0';
      let dates = asc.map(r => r.date);
      let totals = asc.map(r => r.total);

      if (liquidityChart) { liquidityChart.dispose(); liquidityChart = null; }

      let markBands = [];
      [80, 60, 40].forEach(v => {
        markBands.push({ yAxis: v, lineStyle: { color: '#94a3b8', type: 'dashed', width: 1 }, label: { formatter: v + '分', fontSize: 9, color: textColor } });
      });

      liquidityChart = echarts.init(chartEl);
      liquidityChart.setOption({
        backgroundColor: 'transparent',
        animation: false,
        tooltip: { trigger: 'axis' },
        grid: { left: 40, right: 12, top: 18, bottom: 24 },
        xAxis: { type: 'category', data: dates, axisLabel: { color: textColor, fontSize: 9 }, axisLine: { lineStyle: { color: '#2a2a2a' } } },
        yAxis: { type: 'value', min: 0, max: 100, interval: 20, axisLabel: { color: textColor, fontSize: 9 } },
        series: [{
          type: 'line', data: totals, smooth: false, symbol: 'circle', symbolSize: 5,
          lineStyle: { color: '#38bdf8', width: 2 },
          itemStyle: { color: function(p) { return liqBand(p.value).color; } },
          markLine: { symbol: 'none', data: markBands, label: { show: true, fontSize: 9 } },
          areaStyle: { color: 'rgba(56,189,248,0.10)' }
        }]
      });
    } catch (e) {
      console.error('流动性走势渲染失败:', e);
      chartEl.innerHTML = '<div class="empty-state">走势加载失败: ' + escapeHtml(e.message) + '</div>';
    }
  }
}
