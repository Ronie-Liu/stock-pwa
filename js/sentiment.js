// ===== 情绪偏好每日打分（环境页子功能） =====
// 数据源：东方财富实时统计接口（push2/push2ex）+ 数据中心(JSONP)
// 口径：涨跌比 / 涨停跌停家数 / 昨日涨停板块涨幅 / 融资买入额偏离10日均 / 外部情绪(美股·A50·人民币)
// 说明：第4项由于无法稳定取得两市成交额日度历史，
//       以「当日融资买入额 vs 近10个交易日均值偏离」作为占比偏离的近似口径。

const SENTIMENT_WEIGHTS = [20, 20, 20, 20, 20]; // 5项各20分，总分100
const SENTIMENT_N = 30; // 走势图最多显示近N日
let sentimentChart = null; // 走势图实例

// ===== 基础工具 =====

/** 在多个 base host 上重试同一 path（东财 push2delay/push2 互相容错） */
async function fetchJSON(path, hosts, timeoutMs = 10000) {
  let lastErr = null;
  for (let base of hosts) {
    try {
      let controller = new AbortController();
      let timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp = await fetch(base + path, { signal: controller.signal, headers: { 'Accept': 'application/json' } });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      let text = await resp.text();
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('请求失败');
}

const EM_HOSTS = ['https://push2delay.eastmoney.com', 'https://push2.eastmoney.com'];

/** datacenter-web 无 CORS，但支持 JSONP callback */
function fetchJSONP(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let cbName = 'sent_cb_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
    let sep = url.indexOf('?') >= 0 ? '&' : '?';
    let script = document.createElement('script');
    let timer = null;
    window[cbName] = (data) => { cleanup(); resolve(data); };
    function cleanup() {
      clearTimeout(timer);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }
    timer = setTimeout(() => { cleanup(); reject(new Error('JSONP超时')); }, timeoutMs);
    script.src = url + sep + 'callback=' + cbName;
    script.onerror = () => { cleanup(); reject(new Error('JSONP加载失败')); };
    document.head.appendChild(script);
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
  { min: -Infinity, label: '情绪冰点', tip: '等待止跌信号', color: '#8b5cf6' }
];
function sentBand(total) {
  for (let b of SENT_BANDS) {
    if (total >= b.min) return b;
  }
  return SENT_BANDS[SENT_BANDS.length - 1];
}

// ===== 数据获取 =====

/** 指标1+2：全市场涨跌家数、涨跌比 */
async function fetchBreadth() {
  // 上证指数 + 深证成指 的市场涨跌家数统计（f104=上涨 f105=下跌 f106=平盘）
  let url = '/api/qt/ulist.np/get?fltt=2&invt=2&fields=f104,f105,f106,f12&secids=1.000001,0.399001';
  let json = await fetchJSON(url, EM_HOSTS);
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

/** 指标2：涨停/跌停家数（含北交所由接口自动汇总） */
function latestTradeDateCandidates() {
  let arr = [];
  let d = new Date();
  for (let i = 0; i < 12; i++) {
    let y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    arr.push(y + m + day);
    d.setDate(d.getDate() - 1);
  }
  return arr;
}

/** 指标2：涨停/跌停家数（东财 push2ex 涨停/跌停池 tc 字段） */
async function fetchLimitStats() {
  const HOST = 'https://push2ex.eastmoney.com';
  let zt = null;
  for (let date of latestTradeDateCandidates()) {
    try {
      let url = HOST + '/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt%3Aasc&date=' + date;
      let resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) continue;
      let json = await resp.json();
      if (json && json.data && typeof json.data.tc === 'number' && String(json.data.qdate) === date) {
        zt = { date: date, tc: json.data.tc };
        break;
      }
    } catch (e) { /* 尝试更早日期 */ }
  }
  if (!zt) throw new Error('涨停池获取失败');

  let dt = 0;
  for (let date of [zt.date, ...latestTradeDateCandidates()]) {
    try {
      let url = HOST + '/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fund%3Aasc&date=' + date;
      let resp = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!resp.ok) continue;
      let json = await resp.json();
      if (json && json.data && typeof json.data.tc === 'number' && String(json.data.qdate) === date) {
        dt = json.data.tc;
        break;
      }
    } catch (e) { }
  }
  return { date: zt.date, zt: zt.tc, dt: dt };
}

/** 指标3：昨日涨停概念板块今日涨幅（东财 BK0815 昨日涨停；BK1050 含一字作参考） */
async function fetchYesterdayLimitBoard() {
  let url = '/api/qt/ulist.np/get?fltt=2&invt=2&fields=f3,f12,f14&secids=90.BK0815,90.BK1050';
  let json = await fetchJSON(url, EM_HOSTS);
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
  let json = await fetchJSON(url, EM_HOSTS);
  let diff = (json && json.data && json.data.diff) || [];
  for (let d of diff) {
    if (String(d.f12) === 'DJIA') out.djia = Number(d.f3);
    if (String(d.f12) === 'XIN9') out.a50 = Number(d.f3);
    if (String(d.f12) === 'USDCNH') out.usdcnh = Number(d.f3);
  }
  if (out.djia == null) {
    let j2 = await fetchJSON('/api/qt/ulist.np/get?fltt=2&invt=2&fields=f3,f12,f14&secids=100.DJIA', EM_HOSTS);
    let d2 = (j2.data && j2.data.diff) || [];
    if (d2[0]) out.djia = Number(d2[0].f3);
  }
  if (out.a50 == null) {
    let j3 = await fetchJSON('/api/qt/ulist.np/get?fltt=2&invt=2&fields=f3,f12,f14&secids=100.XIN9', EM_HOSTS);
    let d3 = (j3.data && j3.data.diff) || [];
    if (d3[0]) out.a50 = Number(d3[0].f3);
  }
  if (out.usdcnh == null) {
    let j4 = await fetchJSON('/api/qt/ulist.np/get?fltt=2&invt=2&fields=f3,f12,f14&secids=133.USDCNH', EM_HOSTS);
    let d4 = (j4.data && j4.data.diff) || [];
    if (d4[0]) out.usdcnh = Number(d4[0].f3);
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

// ===== 汇总打分 =====

async function computeSentimentScore() {
  let [b, lp, yb, mf, ext] = await Promise.all([
    fetchBreadth(),
    fetchLimitStats(),
    fetchYesterdayLimitBoard(),
    fetchMargin(),
    fetchExternal()
  ]);

  let s1 = scoreBreadth(b.ratio);
  let s2 = scoreLimit(lp.zt, lp.dt);
  let s3 = scoreYestBoard(yb.main.pct);
  let s4 = scoreMargin(mf.deviation);
  let s5 = scoreExternal(ext.positives);
  let total = Math.round((s1 + s2 + s3 + s4 + s5) * 10) / 10;
  let band = sentBand(total);

  // 日期统一为 YYYY-MM-DD（存储与走势图展示）
  let rawDate = lp.date || String(mf.date || '').replace(/-/g, '');
  let dateStr = rawDate.length === 8 ? rawDate.slice(0, 4) + '-' + rawDate.slice(4, 6) + '-' + rawDate.slice(6, 8) : rawDate;

  return {
    date: dateStr,
    total: total,
    band: band,
    items: [
      { key: 'breadth', name: '涨跌比', score: s1, desc: '上涨' + b.up + ' / 下跌' + b.down + '，比值 ' + b.ratio.toFixed(2) },
      { key: 'limit', name: '涨停/跌停家数', score: s2, desc: '涨停 ' + lp.zt + ' 家 / 跌停 ' + lp.dt + ' 家' },
      { key: 'yestboard', name: '昨日涨停今日表现', score: s3, desc: (yb.main.name || '昨日涨停') + ' 板块 ' + pctSign(yb.main.pct) + (yb.incl && yb.incl.pct != null ? '（含一字 ' + pctSign(yb.incl.pct) + '）' : '') },
      { key: 'margin', name: '融资买入额占比偏离度', score: s4, desc: '当日 ' + fmtAmt(mf.today) + ' 元 / 10日均 ' + fmtAmt(mf.mean) + ' 元，偏离 ' + pctSign(mf.deviation) + '（占比口径近似：当日融资买入额相对10日均偏离）' },
      { key: 'external', name: '外部情绪传导', score: s5, desc: '美股 ' + pctSign(ext.djia) + ' / A50 ' + pctSign(ext.a50) + ' / 人民币' + (ext.usdcnh < 0 ? '升值' : '贬值') + '(' + pctSign(ext.usdcnh) + ')，正面 ' + ext.positives + ' 项' }
    ],
    detail: {
      breadth: b, limit: lp, yestBoard: yb, margin: mf, external: ext
    },
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

  async function refresh() {
    let loading = document.getElementById('sent-loading');
    let resultEl = document.getElementById('sent-result');
    if (loading) loading.style.display = 'flex';
    if (resultEl) resultEl.style.display = 'none';
    try {
      let rec = await computeSentimentScore();
      await saveSentimentRecord(rec);
      if (loading) loading.style.display = 'none';
      if (resultEl) {
        renderSentimentResult(resultEl, rec);
        resultEl.style.display = 'block';
      }
      renderSentimentTrend();
    } catch (e) {
      console.error('情绪打分失败:', e);
      if (loading) {
        loading.innerHTML = '<span style="color:var(--danger)">打分失败: ' + escapeHtml(e.message) + '</span>　<button class="btn btn-sm" id="btn-sent-retry" style="margin-left:8px">重试</button>';
        let retry = document.getElementById('btn-sent-retry');
        if (retry) retry.onclick = refresh;
      }
    }
  }

  let btn = document.getElementById('btn-sent-refresh');
  if (btn) btn.addEventListener('click', refresh);

  await refresh();
}

function renderSentimentResult(el, rec) {
  let band = rec.band;
  let html = `
    <div class="sent-band-card" style="border-left:6px solid ${band.color}">
      <div class="sent-total" style="color:${band.color}">${rec.total.toFixed(1)}</div>
      <div class="sent-band-meta">
        <div class="sent-band-label" style="background:${band.color}">${band.label}</div>
        <div class="sent-band-tip">${band.tip}</div>
        <div class="sent-date">数据日 ${rec.date}（东财实时统计）</div>
      </div>
    </div>
    <div class="sent-items">
      ${rec.items.map(it => {
        let pctW = clamp(it.score / 20 * 100, 0, 100);
        let color = it.score >= 16 ? '#ef4444' : it.score >= 11 ? '#f97316' : it.score >= 6 ? '#94a3b8' : '#38bdf8';
        return `
        <div class="sent-item">
          <div class="sent-item-head">
            <span class="sent-item-name">${escapeHtml(it.name)}</span>
            <span class="sent-item-score" style="color:${color}">${it.score.toFixed(1)}<i>/20</i></span>
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
    let totals = records.map(r => r.total);

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
    window.addEventListener('resize', () => { if (sentimentChart) sentimentChart.resize(); });
  } catch (e) {
    console.error('走势渲染失败:', e);
    chartEl.innerHTML = '<div class="empty-state">走势加载失败: ' + escapeHtml(e.message) + '</div>';
  }
}
