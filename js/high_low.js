// ===== 全A顶部or底部（趋势周期孙页面） =====
// 数据源: legulegu.com 全部A股 创新高/新低个股数量（剔除停牌股）+ 上证指数收盘。
//   基期历史(2005-02-01起)由 scripts/collect_high_low.js 采集，之后每个交易日由 scripts/update_high_low.py 增量追加。
// 口径: 创60日新高 = 收盘价 > 过去60个交易日最高收盘价（前复权），创新低同理；家数=符合条件个股数量。
// 图表: 上图=创60日新高家数(按情绪区间动态变色，参考线 600/200/120/35)，下图=上证指数收盘，双图联动缩放+十字线。
// 加载策略: 页面同源内置 data/high_low_data.js(随仓库发布、离线可用) 优先，其次在线镜像，最后本地缓存。

const HL_SOURCE_URLS = [
  'https://cdn.jsdelivr.net/gh/Ronie-Liu/stock-pwa@main/data/high_low_history.json',
  'https://raw.githubusercontent.com/Ronie-Liu/stock-pwa/main/data/high_low_history.json',
  'https://raw.gitmirror.com/Ronie-Liu/stock-pwa/main/data/high_low_history.json'
];
const HL_CACHE_KEY = 'hl_history_cache_v1';
const HL_SERIES_DEFS = [
  { key: 'high60',  label: '创60日新高', color: '#e74c3c' },
  { key: 'low60',   label: '创60日新低', color: '#2ecc71' },
  { key: 'high120', label: '创120日新高', color: '#f39c12' },
  { key: 'low120',  label: '创120日新低', color: '#16a085' }
];
const HL_RANGES = [
  { id: '1y', label: '近1年', days: 244 },
  { id: '3y', label: '近3年', days: 732 },
  { id: '5y', label: '近5年', days: 1220 },
  { id: 'all', label: '全部', days: Infinity }
];
// 创60日新高家数 → 情绪区间（数值越低越冷，越高越热）
const HL_EMOTION = [
  { max: 35,   label: '透心凉 <35',  color: '#0f7a3d' },
  { min: 35,   max: 120, label: '情绪看空 35~120', color: '#2ecc71' },
  { min: 120,  max: 200, label: '情绪修复 120~200', color: '#3b82f6' },
  { min: 200,  max: 600, label: '200~600', color: '#f1c40f' },
  { min: 600,  label: '情绪沸腾 >600', color: '#e74c3c' }
];
const HL_INDEX_COLOR = '#a78bfa';   // 上证指数曲线颜色

let highLowData = null;      // 原始数据缓存 { dates, series:{key:{label,values}} , last_date }
let highLowChart = null;     // 图表实例
let hlRange = '3y';          // 当前区间
let hlVisible = { high60: true, low60: false, high120: false, low120: false };
let hlLoading = false;

function disposeHighLow() {
  if (highLowChart) { try { highLowChart.dispose(); } catch (e) {} highLowChart = null; }
}

/** 根据家数取情绪区间颜色 */
function hlEmotionColor(v) {
  if (v == null) return '#888888';
  for (const b of HL_EMOTION) {
    if ((b.min == null || v > b.min) && (b.max == null || v <= b.max)) return b.color;
  }
  return '#888888';
}

/** 采用页面内置数据（同源 data/high_low_data.js，随仓库发布，离线可用） */
function hlAdoptInline() {
  const d = window.HL_HISTORY_DATA;
  if (!d || !d.dates || !d.series) return false;
  highLowData = d;
  highLowData._from = '内置数据';
  highLowData._loadedAt = d.generated_at || '';
  return true;
}

function hlFromLocalStorage() {
  try {
    const cached = localStorage.getItem(HL_CACHE_KEY);
    if (cached) {
      const d = JSON.parse(cached);
      if (d && d.dates && d.series) return d;
    }
  } catch (e) {}
  return null;
}

function hlSaveLocal(data) {
  try { localStorage.setItem(HL_CACHE_KEY, JSON.stringify(data)); } catch (e) {}
}

/** 加载数据：内置数据(同源) → 在线镜像 → 本地缓存 */
async function loadHighLowData(force) {
  if (highLowData && !force) return highLowData;

  if (!force) {
    if (hlAdoptInline()) { highLowData._stale = false; return highLowData; }
    const ls = hlFromLocalStorage();
    if (ls) { ls._stale = true; highLowData = ls; return highLowData; }
  }

  let lastErr = null;
  for (const url of HL_SOURCE_URLS) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!resp.ok) { lastErr = new Error('数据源 HTTP ' + resp.status); continue; }
      const data = await resp.json();
      if (!data || !data.dates || !data.series) throw new Error('数据格式异常');
      highLowData = data;
      highLowData._stale = false;
      highLowData._loadedAt = data.generated_at || new Date().toISOString();
      highLowData._from = '在线数据';
      hlSaveLocal(data);
      return highLowData;
    } catch (e) { lastErr = e; }
  }

  const ls = hlFromLocalStorage();
  if (ls) { ls._stale = true; highLowData = ls; return highLowData; }
  if (hlAdoptInline()) { highLowData._stale = true; return highLowData; }

  throw lastErr || new Error('无法连接数据源，请检查网络后重试');
}

/** 计算 v 在 arr 中的分位（0~100，累计占比） */
function hlPercentile(arr, v) {
  if (!arr || !arr.length) return null;
  let less = 0, total = 0;
  for (let x of arr) { if (x == null) continue; total++; if (x <= v) less++; }
  if (!total) return null;
  return Math.round(less / total * 1000) / 10;
}

function hlFmt(n) {
  if (n == null) return '--';
  return Number(n).toLocaleString('zh-CN');
}

/** 渲染入口：返回HTML（由 app.js 注入），随后调用 initHighLow 拉数据画图 */
function renderHighLowSubTab() {
  const chips = HL_SERIES_DEFS.map(d => {
    const on = hlVisible[d.key];
    return `<button class="hl-chip" data-key="${d.key}" style="${on ? 'background:' + d.color + ';color:#fff;border-color:' + d.color + ';' : 'color:' + d.color + ';border-color:' + d.color + ';'}">${d.label}</button>`;
  }).join('');
  const ranges = HL_RANGES.map(r => {
    const on = hlRange === r.id;
    return `<button class="hl-range" data-range="${r.id}" style="${on ? 'background:var(--accent);color:#fff;' : ''}">${r.label}</button>`;
  }).join('');
  const scale = HL_EMOTION.map(b =>
    `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;color:var(--text-secondary);"><span style="width:8px;height:8px;border-radius:50%;background:${b.color};flex:none;"></span>${b.label}</span>`
  ).join('');

  return `
    <div class="hl-wrap" style="padding:8px 12px 14px;">
      <!-- 顶部信号卡片 -->
      <div class="hl-signal" id="hl-signal" style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;">
        <div class="hl-signal-loading"><span class="spinner"></span> 正在加载数据…</div>
      </div>

      <!-- 曲线图（上：创60日新高情绪曲线 下：上证指数，联动缩放） -->
      <div class="hl-chart-card" style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:10px 8px 6px;margin-bottom:10px;">
        <div class="hl-toolbar" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:4px;padding:0 4px;">
          <div style="display:flex;flex-wrap:wrap;gap:6px;">${chips}</div>
          <div style="margin-left:auto;display:flex;gap:4px;">${ranges}</div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px 12px;padding:2px 6px 6px;">${scale}</div>
        <div class="hl-chart" id="hl-chart" style="width:100%;height:460px;"></div>
        <div class="hl-note" style="font-size:10px;color:var(--text-muted);padding:4px 6px 0;line-height:1.5;">
          上图：创60日新高家数，曲线随家数在情绪区间动态变色，虚线为 600/200/120/35 参考线（红线=新高等可点色块叠加）。下图：上证指数收盘。上下两图横向缩放、拖动与十字线同步。手指双指缩放/拖动查看。
        </div>
      </div>

      <!-- 数据说明 -->
      <div class="hl-meta" id="hl-meta" style="font-size:11px;color:var(--text-muted);padding:2px 6px;line-height:1.6;"></div>
    </div>`;
}

/** 加载数据、计算信号、画图、绑定事件 */
async function initHighLow(container) {
  if (hlLoading) return;
  let chartEl = container.querySelector('#hl-chart');
  let signalEl = container.querySelector('#hl-signal');
  let metaEl = container.querySelector('#hl-meta');
  if (!chartEl || !signalEl) return;

  hlLoading = true;
  try {
    const data = await loadHighLowData(false);
    renderSignal(signalEl, data);
    renderMeta(metaEl, data);
    if (typeof echarts === 'undefined') await loadECharts();
    drawChart(chartEl, data);
    bindHLEvents(container);
  } catch (e) {
    console.error('全A顶底加载失败:', e);
    signalEl.innerHTML = '<div style="color:var(--danger);font-size:12px;">加载失败：' + escapeHtml(e.message) + '</div>' +
      '<button class="btn btn-sm" id="hl-retry" style="margin-top:8px;">重试</button>';
    let retry = signalEl.querySelector('#hl-retry');
    if (retry) retry.onclick = () => { hlLoading = false; signalEl.innerHTML = '<div class="hl-signal-loading"><span class="spinner"></span> 正在加载数据…</div>'; initHighLow(container); };
  } finally {
    hlLoading = false;
  }
}

function renderSignal(el, data) {
  const high60 = data.series.high60, low60 = data.series.low60;
  const dates = data.dates;
  if (!high60 || !low60) { el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">暂无数据</div>'; return; }
  const lastIdx = dates.length - 1;
  const hNow = high60.values[lastIdx], lNow = low60.values[lastIdx];

  const win = Math.min(500, dates.length);
  const hArr = high60.values.slice(dates.length - win);
  const lArr = low60.values.slice(dates.length - win);
  const hPct = hlPercentile(hArr, hNow);
  const lPct = hlPercentile(lArr, lNow);

  let signalText, signalColor;
  if (lPct >= 80 && hPct <= 20) { signalText = '底部区域 · 新低极端、新高稀少'; signalColor = '#2ecc71'; }
  else if (hPct >= 80 && lPct <= 20) { signalText = '顶部区域 · 新高过热、新低稀少'; signalColor = '#e74c3c'; }
  else if (lPct >= 70) { signalText = '偏底部 · 新低偏多'; signalColor = '#7ac98f'; }
  else if (hPct >= 70) { signalText = '偏顶部 · 新高偏多'; signalColor = '#f39c12'; }
  else { signalText = '中性 · 多空均衡'; signalColor = 'var(--text-muted)'; }

  const zone = HL_EMOTION.find(b => (b.min == null || hNow > b.min) && (b.max == null || hNow <= b.max));

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;">
      <div style="font-size:13px;font-weight:700;">全A顶部 / 底部</div>
      <div style="font-size:12px;font-weight:700;color:${signalColor};">${signalText}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;">
        <div style="font-size:11px;color:var(--text-muted);">创60日新高（近2年分位 ${hPct == null ? '--' : hPct + '%'}）</div>
        <div style="font-size:20px;font-weight:700;color:${hlEmotionColor(hNow)};">${hlFmt(hNow)}<span style="font-size:11px;color:var(--text-muted);"> 家</span></div>
        <div style="font-size:11px;color:var(--text-muted);">情绪：${zone ? zone.label.split(' ')[0] : '--'}</div>
      </div>
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;">
        <div style="font-size:11px;color:var(--text-muted);">创60日新低（近2年分位 ${lPct == null ? '--' : lPct + '%'}）</div>
        <div style="font-size:20px;font-weight:700;color:#2ecc71;">${hlFmt(lNow)}<span style="font-size:11px;color:var(--text-muted);"> 家</span></div>
      </div>
    </div>`;
}

function renderMeta(el, data) {
  const gen = data._loadedAt ? new Date(data._loadedAt) : null;
  const genText = gen && !isNaN(gen.getTime()) ? gen.toLocaleString('zh-CN', { hour12: false }) : '';
  const staleNote = data._stale
    ? '（本地缓存，非最新；请联网后点右上角刷新）'
    : (genText ? '（更新于 ' + genText + '）' : '');
  el.innerHTML = '数据截至 <b style="color:var(--text);">' + escapeHtml(data.last_date || '--') + '</b>，共 ' +
    hlFmt((data.dates || []).length) + ' 个交易日（' + escapeHtml(data.dates ? data.dates[0] : '') + ' 起）' +
    (data._from ? '｜' + escapeHtml(data._from) : '') + staleNote +
    '。创新高/新低来源：<a href="' + escapeHtml(data.source_url || 'https://legulegu.com/stockdata/high-low-statistics') + '" target="_blank" rel="noopener" style="color:var(--accent);">乐咕乐股</a>；上证指数收盘来源：新浪财经。' +
    '每日收盘后运行 <code style="font-size:10px;">python scripts/update_high_low.py</code> 可自动续更。';
}

function hlAxisDateFmt(v, range) {
  if (!v) return v;
  if (range.id === '1y') return v.slice(5);
  if (range.id === 'all') return v.slice(0, 4);
  return v.slice(2, 7);
}

function drawChart(chartEl, data) {
  const dates = data.dates;
  const range = HL_RANGES.find(r => r.id === hlRange) || HL_RANGES[1];
  const start = range.days === Infinity ? 0 : Math.max(0, dates.length - range.days);
  const xData = dates.slice(start);
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const textColor = isLight ? '#333' : '#c9ced6';
  const axisColor = isLight ? '#d5d5d5' : '#3a3f4a';
  const slice = (arr) => (arr && arr.length === dates.length) ? arr.slice(start) : null;

  // 上证指数是否存在
  const sh = data.series && data.series.shindex;
  const idxVals = (sh && Array.isArray(sh.values)) ? slice(sh.values) : null;
  const dual = !!(idxVals && idxVals.length === xData.length);

  const grids = dual
    ? [{ left: 8, right: 12, top: 6, height: '44%', containLabel: true },
       { left: 8, right: 12, top: '58%', bottom: 0, height: '36%', containLabel: true }]
    : [{ left: 8, right: 12, top: 6, bottom: 0, containLabel: true }];

  const xAxes = dual
    ? [
        { type: 'category', data: xData, boundaryGap: false, gridIndex: 0,
          axisLine: { lineStyle: { color: axisColor } }, axisTick: { show: false },
          axisLabel: { show: false }, splitLine: { show: false } },
        { type: 'category', data: xData, boundaryGap: false, gridIndex: 1,
          axisLine: { lineStyle: { color: axisColor } }, axisTick: { show: false },
          axisLabel: { color: textColor, fontSize: 9, formatter: (v) => hlAxisDateFmt(v, range) } }
      ]
    : [{ type: 'category', data: xData, boundaryGap: false,
         axisLine: { lineStyle: { color: axisColor } }, axisTick: { show: false },
         axisLabel: { color: textColor, fontSize: 9, formatter: (v) => hlAxisDateFmt(v, range) } }];

  const yAxes = dual
    ? [{ type: 'value', gridIndex: 0, name: '家', nameTextStyle: { color: textColor, fontSize: 9 },
         splitLine: { lineStyle: { color: axisColor, type: 'dashed' } },
         axisLabel: { color: textColor, fontSize: 9 } },
       { type: 'value', gridIndex: 1, scale: true, name: '上证', nameTextStyle: { color: textColor, fontSize: 9 },
         splitLine: { lineStyle: { color: axisColor, type: 'dashed' } },
         axisLabel: { color: textColor, fontSize: 9 } }]
    : [{ type: 'value', name: '家', nameTextStyle: { color: textColor, fontSize: 9 },
         splitLine: { lineStyle: { color: axisColor, type: 'dashed' } },
         axisLabel: { color: textColor, fontSize: 9 } }];

  // ---- 组装 series ----
  const series = [];
  let emotionIdx = -1;   // 创60日新高所在 series 序号（用于 visualMap 分段变色）
  const topVisible = HL_SERIES_DEFS.filter(d => hlVisible[d.key] && data.series[d.key]);
  for (const def of topVisible) {
    const vals = slice(data.series[def.key].values);
    if (!vals) continue;
    const isEmo = def.key === 'high60';
    const s = {
      name: def.label,
      type: 'line',
      xAxisIndex: dual ? 0 : 0,
      yAxisIndex: dual ? 0 : 0,
      smooth: false,
      symbol: 'none',
      lineStyle: { width: isEmo ? 2.2 : 1.4, color: isEmo ? undefined : def.color },
      emphasis: { focus: 'series' },
      data: vals
    };
    if (isEmo) {
      emotionIdx = series.length;
      // 情绪参考分隔线
      s.markLine = {
        silent: true,
        symbol: ['none', 'none'],
        label: { show: true, position: 'end', color: textColor, fontSize: 8, formatter: (p) => String(p.value) },
        lineStyle: { color: axisColor, type: 'dashed', width: 1, opacity: 0.9 },
        data: [{ yAxis: 600 }, { yAxis: 200 }, { yAxis: 120 }, { yAxis: 35 }]
      };
    }
    series.push(s);
  }

  // 上证指数（下图）
  if (dual) {
    series.push({
      name: '上证指数',
      type: 'line',
      xAxisIndex: 1,
      yAxisIndex: 1,
      smooth: false,
      symbol: 'none',
      sampling: 'lttb',
      lineStyle: { width: 1.4, color: HL_INDEX_COLOR },
      emphasis: { focus: 'series' },
      data: idxVals
    });
  }

  // ---- tooltip 行定义（与上图/下图同步显示同一日期数值） ----
  const rows = [];
  for (const def of topVisible) {
    const vals = slice(data.series[def.key].values);
    if (!vals) continue;
    rows.push({
      label: def.label,
      unit: '家',
      values: vals,
      color: def.key === 'high60' ? (v) => hlEmotionColor(v) : () => def.color
    });
  }
  if (dual) rows.push({ label: '上证指数', unit: '点', values: idxVals, color: () => HL_INDEX_COLOR, dec: 2 });
  const dateIdx = new Map(xData.map((d, i) => [d, i]));
  const numFmt = (v, dec) => Number(v).toLocaleString('zh-CN', dec ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : undefined);

  const option = {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', link: [{ xAxisIndex: 'all' }] },
      backgroundColor: isLight ? '#fff' : '#262b34',
      borderColor: isLight ? '#e5e5e5' : '#3a3f4a',
      textStyle: { color: textColor, fontSize: 11 },
      formatter: function (params) {
        if (!params || !params.length) return '';
        const i = dateIdx.get(params[0].axisValue);
        if (i == null) return '';
        let lines = ['<b>' + params[0].axisValue + '</b>'];
        for (const r of rows) {
          const v = r.values[i];
          if (v == null || isNaN(v)) continue;
          const c = (typeof r.color === 'function') ? r.color(v) : r.color;
          lines.push('<span style="display:inline-block;width:9px;height:9px;background:' + c + ';margin-right:5px;"></span>' +
            r.label + '：<b>' + numFmt(v, r.dec) + '</b> ' + r.unit);
        }
        return lines.join('<br>');
      }
    },
    grid: grids,
    dataZoom: [{ type: 'inside', xAxisIndex: dual ? [0, 1] : 0, throttle: 50 }],
    xAxis: xAxes,
    yAxis: yAxes,
    series: series
  };

  // 创60日新高曲线：按情绪区间分段变色
  if (emotionIdx >= 0) {
    option.visualMap = {
      show: false,
      seriesIndex: emotionIdx,
      pieces: [
        { lte: 35, color: '#0f7a3d' },
        { gt: 35, lte: 120, color: '#2ecc71' },
        { gt: 120, lte: 200, color: '#3b82f6' },
        { gt: 200, lte: 600, color: '#f1c40f' },
        { gt: 600, color: '#e74c3c' }
      ],
      outOfRange: { color: '#888888' }
    };
  }

  if (highLowChart) { highLowChart.dispose(); highLowChart = null; }
  highLowChart = echarts.init(chartEl);
  highLowChart.setOption(option);
}

function bindHLEvents(container) {
  container.querySelectorAll('.hl-chip').forEach(btn => {
    btn.onclick = () => {
      const key = btn.dataset.key;
      hlVisible[key] = !hlVisible[key];
      const def = HL_SERIES_DEFS.find(d => d.key === key);
      if (hlVisible[key]) {
        btn.style.background = def.color; btn.style.color = '#fff'; btn.style.borderColor = def.color;
      } else {
        btn.style.background = 'transparent'; btn.style.color = def.color; btn.style.borderColor = def.color;
      }
      if (highLowData) { const el = container.querySelector('#hl-chart'); if (el) drawChart(el, highLowData); }
    };
  });

  container.querySelectorAll('.hl-range').forEach(btn => {
    btn.onclick = () => {
      hlRange = btn.dataset.range;
      container.querySelectorAll('.hl-range').forEach(b => {
        b.style.background = b === btn ? 'var(--accent)' : 'transparent';
        b.style.color = b === btn ? '#fff' : '';
      });
      if (highLowData) { const el = container.querySelector('#hl-chart'); if (el) drawChart(el, highLowData); }
    };
  });
}
