// ===== 全A顶部or底部（趋势周期孙页面） =====
// 数据源: legulegu.com 全部A股 创新高/新低个股数量（剔除停牌股），由 scripts/collect_high_low.js 采集为静态JSON
// 说明: 该接口同源直连、无CORS，浏览器无法跨域直连，故历史数据以静态文件形式随仓库发布。
// 口径: 创60日新高 = 收盘价 > 过去60个交易日最高收盘价（前复权），创新低同理；家数=符合条件个股数量。

const HL_SOURCE_URL = 'https://raw.githubusercontent.com/Ronie-Liu/stock-pwa/main/data/high_low_history.json';
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

let highLowData = null;      // 原始数据缓存 { dates, series:{key:{label,values}} , last_date }
let highLowChart = null;     // 图表实例
let hlRange = '3y';          // 当前区间
let hlVisible = { high60: true, low60: true, high120: false, low120: false };
let hlLoading = false;

function disposeHighLow() {
  if (highLowChart) { try { highLowChart.dispose(); } catch (e) {} highLowChart = null; }
}

/** 从GitHub静态文件加载数据（带缓存） */
async function loadHighLowData(force) {
  if (highLowData && !force) return highLowData;
  let resp = await fetch(HL_SOURCE_URL, { signal: AbortSignal.timeout(12000) });
  if (!resp.ok) throw new Error('数据源 HTTP ' + resp.status);
  let data = await resp.json();
  if (!data || !data.dates || !data.series) throw new Error('数据格式异常');
  highLowData = data;
  return data;
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

  return `
    <div class="hl-wrap" style="padding:8px 12px 14px;">
      <!-- 顶部信号卡片 -->
      <div class="hl-signal" id="hl-signal" style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;">
        <div class="hl-signal-loading"><span class="spinner"></span> 正在加载数据…</div>
      </div>

      <!-- 曲线图 -->
      <div class="hl-chart-card" style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:10px 8px 6px;margin-bottom:10px;">
        <div class="hl-toolbar" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:4px;padding:0 4px;">
          <div style="display:flex;flex-wrap:wrap;gap:6px;">${chips}</div>
          <div style="margin-left:auto;display:flex;gap:4px;">${ranges}</div>
        </div>
        <div class="hl-chart" id="hl-chart" style="width:100%;height:300px;"></div>
        <div class="hl-note" style="font-size:10px;color:var(--text-muted);padding:4px 6px 0;line-height:1.5;">
          口径：收盘价创N日新高/新低的个股家数（剔除停牌）。红线=新高（顶部动能），绿线=新低（底部压力）。手指可缩放/拖动图表横向对比。
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
  const lastDate = dates[lastIdx];
  const hNow = high60.values[lastIdx], lNow = low60.values[lastIdx];

  // 分位：近500个交易日（约2年）
  const win = Math.min(500, dates.length);
  const hArr = high60.values.slice(dates.length - win);
  const lArr = low60.values.slice(dates.length - win);
  const hPct = hlPercentile(hArr, hNow);
  const lPct = hlPercentile(lArr, lNow);

  // 信号判定
  let signalText, signalColor;
  if (lPct >= 80 && hPct <= 20) { signalText = '底部区域 · 新低极端、新高稀少'; signalColor = '#2ecc71'; }
  else if (hPct >= 80 && lPct <= 20) { signalText = '顶部区域 · 新高过热、新低稀少'; signalColor = '#e74c3c'; }
  else if (lPct >= 70) { signalText = '偏底部 · 新低偏多'; signalColor = '#7ac98f'; }
  else if (hPct >= 70) { signalText = '偏顶部 · 新高偏多'; signalColor = '#f39c12'; }
  else { signalText = '中性 · 多空均衡'; signalColor = 'var(--text-muted)'; }

  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;">
      <div style="font-size:13px;font-weight:700;">全A顶部 / 底部</div>
      <div style="font-size:12px;font-weight:700;color:${signalColor};">${signalText}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;">
        <div style="font-size:11px;color:var(--text-muted);">创60日新高（近2年分位）</div>
        <div style="font-size:20px;font-weight:700;color:#e74c3c;">${hlFmt(hNow)}<span style="font-size:11px;color:var(--text-muted);"> 家</span></div>
        <div style="font-size:11px;color:var(--text-muted);">分位 ${hPct == null ? '--' : hPct + '%'}</div>
      </div>
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;">
        <div style="font-size:11px;color:var(--text-muted);">创60日新低（近2年分位）</div>
        <div style="font-size:20px;font-weight:700;color:#2ecc71;">${hlFmt(lNow)}<span style="font-size:11px;color:var(--text-muted);"> 家</span></div>
        <div style="font-size:11px;color:var(--text-muted);">分位 ${lPct == null ? '--' : lPct + '%'}</div>
      </div>
    </div>`;
}

function renderMeta(el, data) {
  el.innerHTML = '数据截至 <b style="color:var(--text);">' + escapeHtml(data.last_date || '--') + '</b>，共 ' +
    hlFmt((data.dates || []).length) + ' 个交易日（' + escapeHtml(data.dates ? data.dates[0] : '') + ' 起）。' +
    '来源：<a href="' + escapeHtml(data.source_url || 'https://legulegu.com/stockdata/charts/985') + '" target="_blank" rel="noopener" style="color:var(--accent);">乐咕乐股·全部A股创新高/新低</a>；' +
    '历史数据随仓库静态发布，刷新数据请运行 <code style="font-size:10px;">scripts/collect_high_low.js</code>。';
}

function drawChart(chartEl, data) {
  const dates = data.dates;
  const range = HL_RANGES.find(r => r.id === hlRange) || HL_RANGES[1];
  const start = range.days === Infinity ? 0 : Math.max(0, dates.length - range.days);
  const xData = dates.slice(start);
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const textColor = isLight ? '#333' : '#c9ced6';
  const axisColor = isLight ? '#d5d5d5' : '#3a3f4a';

  let series = [];
  for (const def of HL_SERIES_DEFS) {
    if (!hlVisible[def.key]) continue;
    const s = data.series[def.key];
    if (!s) continue;
    series.push({
      name: def.label,
      type: 'line',
      smooth: false,
      symbol: 'none',
      sampling: 'lttb',
      lineStyle: { width: 1.6, color: def.color },
      itemStyle: { color: def.color },
      emphasis: { focus: 'series' },
      data: s.values.slice(start)
    });
  }

  if (highLowChart) { highLowChart.dispose(); highLowChart = null; }
  highLowChart = echarts.init(chartEl);
  highLowChart.setOption({
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis',
      backgroundColor: isLight ? '#fff' : '#262b34',
      borderColor: isLight ? '#e5e5e5' : '#3a3f4a',
      textStyle: { color: textColor, fontSize: 11 },
      formatter: function (params) {
        let lines = ['<b>' + (params[0] ? params[0].axisValueLabel : '') + '</b>'];
        for (let p of params) {
          if (p.value == null) continue;
          lines.push('<span style="display:inline-block;width:9px;height:9px;background:' + p.color + ';margin-right:5px;"></span>' +
            p.seriesName + '：<b>' + hlFmt(p.value) + '</b> 家');
        }
        return lines.join('<br>');
      }
    },
    legend: {
      top: 0, left: 'center', itemWidth: 14, itemHeight: 8,
      textStyle: { color: textColor, fontSize: 10 }
    },
    grid: { left: 8, right: 14, top: 26, bottom: 22, containLabel: true },
    dataZoom: [{ type: 'inside', throttle: 50 }],
    xAxis: {
      type: 'category', data: xData, boundaryGap: false,
      axisLine: { lineStyle: { color: axisColor } },
      axisLabel: {
        color: textColor, fontSize: 10,
        formatter: function (v) {
          if (!v) return v;
          if (range.id === '1y') return v.slice(5);          // MM-DD
          if (range.id === 'all') return v.slice(0, 4);      // YYYY
          return v.slice(2, 7);                               // YY-MM
        }
      }
    },
    yAxis: {
      type: 'value', name: '家', nameTextStyle: { color: textColor, fontSize: 10 },
      splitLine: { lineStyle: { color: axisColor, type: 'dashed' } },
      axisLabel: { color: textColor, fontSize: 10 }
    },
    series: series
  });
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
