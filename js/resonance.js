// ===== 共振：全市场欲望 / 影线分组家数推移（环境页子功能） =====
// 数据源: data/resonance_data.js（同源内置，由 scripts/update_resonance.py 云端采集）
//   盘中 8 个时点由云端任务抓取（无需 App 常开）：10:00 / 10:30 / 11:00 / 11:30 / 13:30 / 14:00 / 14:30 / 15:00
//   收盘后再用 5 分钟 K 线逐股精确复盘，覆盖盘中快照
// 口径（均以昨收为基准）:
//   1 追高欲望 开盘涨幅>=+2% 且 现价涨幅>=+5%
//   2 抄底欲望 开盘涨幅<=-2% 且 现价涨幅>=+3%
//   3 离场欲望 开盘涨幅>=+2% 且 现价涨幅<=-3%
//   4 恐慌欲望 开盘涨幅<=-2% 且 现价涨幅<=-5%
//   5 上方阻力强 (区间最高 - max(开盘,现价)) / 昨收 >= 4%
//   6 下方支撑强 (min(开盘,现价) - 区间最低) / 昨收 >= 4%
// 图表: 上图 做多(=1+2) / 做空(=3+4)，下图 上方阻力强(=5) / 下方支撑强(=6)
//   两图上下布局、X 轴共用、十字线联动。保留近 5 个交易日。

const RES_SLOTS = ['10:00', '10:30', '11:00', '11:30', '13:30', '14:00', '14:30', '15:00'];
const RES_KEEP_DAYS = 5;
const RES_CACHE_KEY = 'res_cache_v1';
const RES_HISTORY_URLS = [
  '/data/resonance_history.json',
  'https://cdn.jsdelivr.net/gh/Ronie-Liu/stock-pwa@main/data/resonance_history.json',
  'https://raw.githubusercontent.com/Ronie-Liu/stock-pwa/main/data/resonance_history.json'
];

const RES_GROUPS = [
  { key: 'long',    label: '做多',       sub: '追高欲望 + 抄底欲望（条件1+2）', color: '#ef4444', axis: 0, parts: ['c1', 'c2'] },
  { key: 'short',   label: '做空',       sub: '离场欲望 + 恐慌欲望（条件3+4）', color: '#22c55e', axis: 0, parts: ['c3', 'c4'] },
  { key: 'resist',  label: '上方阻力强', sub: '进攻失败 · 长上影（条件5）',     color: '#f59e0b', axis: 1, parts: ['c5'] },
  { key: 'support', label: '下方支撑强', sub: '防御积极 · 长下影（条件6）',     color: '#3b82f6', axis: 1, parts: ['c6'] }
];

const RES_RANGES = [
  { id: '5d', label: '近5日', days: 5 },
  { id: '3d', label: '近3日', days: 3 },
  { id: '1d', label: '当日', days: 1 }
];

let resData = null;
let resChart = null;
let resRange = '5d';
let resLoading = false;

function disposeResonance() {
  if (resChart) { try { resChart.dispose(); } catch (e) {} resChart = null; }
}

/* ---------- 数据加载 ---------- */

function resAdoptInline() {
  const d = window.RESONANCE_DATA;
  if (!d || !Array.isArray(d.days) || !d.days.length) return false;
  resData = d;
  resData._from = '内置数据';
  return true;
}

function resFromCache() {
  try {
    const t = localStorage.getItem(RES_CACHE_KEY);
    if (!t) return null;
    const d = JSON.parse(t);
    if (d && Array.isArray(d.days) && d.days.length) return d;
  } catch (e) {}
  return null;
}

async function loadResonanceData(force) {
  if (resData && !force) return resData;
  if (!force && resAdoptInline()) return resData;

  let lastErr = null;
  for (const u of RES_HISTORY_URLS) {
    try {
      const url = u + (u.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
      const resp = await fetch(url, { signal: AbortSignal.timeout(12000), cache: 'no-store' });
      if (!resp.ok) { lastErr = new Error('HTTP ' + resp.status); continue; }
      const d = await resp.json();
      if (!d || !Array.isArray(d.days) || !d.days.length) throw new Error('数据格式异常');
      resData = d;
      resData._from = '在线数据';
      try { localStorage.setItem(RES_CACHE_KEY, JSON.stringify(d)); } catch (e) {}
      return resData;
    } catch (e) { lastErr = e; }
  }
  const c = resFromCache();
  if (c) { resData = c; resData._from = '本地缓存'; resData._stale = true; return resData; }
  if (resAdoptInline()) { resData._stale = true; return resData; }
  throw lastErr || new Error('无法获取共振数据');
}

/* ---------- 页面 ---------- */

function renderResonanceSubTab() {
  const ranges = RES_RANGES.map(r =>
    `<button class="res-range" data-range="${r.id}" style="${resRange === r.id ? 'background:var(--accent);color:#fff;' : ''}">${r.label}</button>`
  ).join('');
  const legend = RES_GROUPS.map(g =>
    `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text-secondary);">
       <span style="width:9px;height:3px;border-radius:2px;background:${g.color};display:inline-block;"></span>${g.label}
     </span>`
  ).join('');

  return `
    <div class="res-wrap" style="padding:8px 12px 14px;">
      <div class="res-summary" id="res-summary" style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;">
        <div class="res-loading"><span class="spinner"></span> 正在加载共振数据…</div>
      </div>

      <div class="res-card" style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:10px 8px 6px;margin-bottom:10px;">
        <div style="display:flex;align-items:center;gap:6px;padding:0 4px 6px;">
          <div style="font-size:13px;font-weight:700;">全市场欲望 / 影线家数推移</div>
          <div style="margin-left:auto;display:flex;gap:4px;">${ranges}</div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px 12px;padding:0 6px 4px;">${legend}</div>
        <div id="res-chart" style="width:100%;height:420px;"></div>
        <div style="font-size:10px;color:var(--text-muted);padding:4px 6px 0;line-height:1.6;">
          上图为做多／做空家数，下图为上方阻力强／下方支撑强家数；两图共用时间轴，手指拖动或点击时竖线同步。每格 = 一个交易日内的 8 个时点。
        </div>
      </div>

      <div class="res-meta" id="res-meta" style="font-size:11px;color:var(--text-muted);padding:2px 6px;line-height:1.7;"></div>
    </div>`;
}

async function initResonance(container) {
  if (resLoading) return;
  const chartEl = container.querySelector('#res-chart');
  const sumEl = container.querySelector('#res-summary');
  const metaEl = container.querySelector('#res-meta');
  if (!chartEl) return;

  resLoading = true;
  try {
    const data = await loadResonanceData(false);
    if (typeof echarts === 'undefined') await loadECharts();
    renderResSummary(sumEl, data);
    renderResMeta(metaEl, data);
    drawResChart(chartEl, data);
    bindResEvents(container);
  } catch (e) {
    console.error('共振页加载失败:', e);
    if (sumEl) {
      sumEl.innerHTML = '<div style="color:var(--danger);font-size:12px;">加载失败：' + escapeHtml(e.message) + '</div>' +
        '<button class="btn btn-sm" id="res-retry" style="margin-top:8px;">重试</button>';
      const b = sumEl.querySelector('#res-retry');
      if (b) b.onclick = () => { resLoading = false; initResonance(container); };
    }
  } finally {
    resLoading = false;
  }
}

/* ---------- 汇总卡片 ---------- */

/** 取某天某档位值（无数据返回 null） */
function resVal(rec, group) {
  if (!rec) return null;
  let v = 0;
  for (const p of group.parts) v += Number(rec[p] || 0);
  return v;
}

function renderResSummary(el, data) {
  if (!el) return;
  const days = (data.days || []).slice(-RES_KEEP_DAYS);
  if (!days.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">暂无数据</div>';
    return;
  }
  const lastDay = days[days.length - 1];
  // 找到该日最后一个有数据的时点
  let lastSlot = null;
  for (const s of RES_SLOTS) if (lastDay.slots && lastDay.slots[s]) lastSlot = s;
  const rec = lastSlot ? lastDay.slots[lastSlot] : null;
  const prevRec = lastSlot ? (() => {
    const i = RES_SLOTS.indexOf(lastSlot);
    for (let k = i - 1; k >= 0; k--) if (lastDay.slots[RES_SLOTS[k]]) return lastDay.slots[RES_SLOTS[k]];
    return null;
  })() : null;

  const cells = RES_GROUPS.map(g => {
    const v = resVal(rec, g);
    const pv = resVal(prevRec, g);
    const delta = (v != null && pv != null) ? v - pv : null;
    const dTxt = delta == null ? '' :
      `<span style="font-size:10px;color:${delta > 0 ? '#ef4444' : (delta < 0 ? '#22c55e' : 'var(--text-muted)')};">${delta > 0 ? '▲' : (delta < 0 ? '▼' : '')}${delta === 0 ? '持平' : Math.abs(delta)}</span>`;
    return `<div style="border:1px solid var(--border);border-radius:8px;padding:7px 9px;">
      <div style="font-size:10px;color:var(--text-muted);white-space:nowrap;">${g.label}</div>
      <div style="font-size:19px;font-weight:700;color:${g.color};line-height:1.25;">${v == null ? '--' : v}<span style="font-size:10px;color:var(--text-muted);"> 家</span> ${dTxt}</div>
    </div>`;
  }).join('');

  const covered = (rec && rec.src === 'kline') ? '收盘复盘' : '盘中快照';
  const actual = rec && rec.actual ? rec.actual : '';
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:9px;">
      <div style="font-size:13px;font-weight:700;">今日共振结构</div>
      <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(lastDay.date)} ${escapeHtml(lastSlot || '')} · ${covered}${actual && actual !== lastSlot ? '（实际 ' + escapeHtml(actual) + '）' : ''}</div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">${cells}</div>
    <div style="font-size:10px;color:var(--text-muted);margin-top:8px;">全市场交易 ${rec && rec.total != null ? rec.total : '--'} 家（沪深京三市，已剔除停牌无成交）　▲▼ 为相对上一时点变化</div>`;
}

/* ---------- 元信息 ---------- */

function renderResMeta(el, data) {
  if (!el) return;
  const gen = data.generated_at ? new Date(data.generated_at) : null;
  const genTxt = gen && !isNaN(gen.getTime()) ? gen.toLocaleString('zh-CN', { hour12: false }) : '';
  const days = (data.days || []).length;
  const stale = data._stale ? '（本地缓存，非最新）' : '';
  const cov = (() => {
    for (let i = (data.days || []).length - 1; i >= 0; i--) {
      const c = data.days[i].coverage;
      if (c != null) return Math.round(c * 1000) / 10;
    }
    return null;
  })();
  el.innerHTML =
    '数据覆盖 <b style="color:var(--text);">' + days + '</b> 个交易日（' + RES_KEEP_DAYS + ' 日上限）' +
    (data._from ? '｜' + escapeHtml(data._from) : '') + stale +
    (genTxt ? '｜生成于 ' + escapeHtml(genTxt) : '') +
    (cov != null ? '｜K线采集覆盖率 ' + cov + '%' : '') +
    '<br><b style="color:var(--text);">更新方式：</b>云端任务在每个时点后自动抓取全市场快照（App 无需常开），' +
    '收盘后再用 5 分钟 K 线逐股精确复盘并覆盖盘中值；打开或刷新页面即可看到最新。<br>' +
    '<b style="color:var(--text);">口径：</b>全部以昨收为基准。' +
    '追高=开盘≥+2%且现价≥+5%；抄底=开盘≤-2%且现价≥+3%；离场=开盘≥+2%且现价≤-3%；恐慌=开盘≤-2%且现价≤-5%；' +
    '上方阻力强=(区间最高−max(开盘,现价))÷昨收≥4%；下方支撑强=(min(开盘,现价)−区间最低)÷昨收≥4%。' +
    '时点之间的最高/最低取「当日至该时点」的累计值。';
}

/* ---------- 图表 ---------- */

function drawResChart(chartEl, data) {
  let keepZoom = null;
  if (resChart && !resChart.isDisposed()) {
    try {
      const dz = resChart.getOption().dataZoom;
      if (dz && dz[0] && dz[0].start != null) keepZoom = { start: dz[0].start, end: dz[0].end };
    } catch (e) {}
  }

  const range = RES_RANGES.find(r => r.id === resRange) || RES_RANGES[0];
  const days = (data.days || []).slice(-Math.min(range.days, RES_KEEP_DAYS));
  if (!days.length) {
    chartEl.innerHTML = '<div class="empty-state" style="padding:24px 12px">暂无共振数据</div>';
    if (resChart) { try { resChart.dispose(); } catch (e) {} resChart = null; }
    return;
  }

  // 展平成 日 × 8 时点 的点序列
  const points = [];
  for (const d of days) {
    for (const s of RES_SLOTS) {
      points.push({ date: d.date, slot: s, rec: (d.slots && d.slots[s]) || null });
    }
  }
  const labels = points.map(p => p.date.slice(5) + ' ' + p.slot);

  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const textColor = isLight ? '#333' : '#c9ced6';
  const axisColor = isLight ? '#d5d5d5' : '#3a3f4a';

  // 每个时点的 4 个档位值
  const values = RES_GROUPS.map(g => points.map(p => resVal(p.rec, g)));

  const series = RES_GROUPS.map((g, gi) => ({
    name: g.label,
    type: 'line',
    xAxisIndex: g.axis,
    yAxisIndex: g.axis,
    smooth: false,
    symbol: 'circle',
    symbolSize: 3,
    showSymbol: true,
    connectNulls: false,
    lineStyle: { width: 1.8, color: g.color },
    itemStyle: { color: g.color },
    emphasis: { focus: 'series', scale: 1.6 },
    data: values[gi]
  }));

  const option = {
    backgroundColor: 'transparent',
    animation: false,
    legend: {
      top: 0, left: 'center', itemWidth: 12, itemHeight: 8,
      textStyle: { color: textColor, fontSize: 10 },
      data: RES_GROUPS.map(g => g.label)
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: isLight ? '#fff' : '#262b34',
      borderColor: isLight ? '#e5e5e5' : '#3a3f4a',
      textStyle: { color: textColor, fontSize: 11 },
      formatter: function (params) {
        if (!params || !params.length) return '';
        const p = points[params[0].dataIndex];
        if (!p) return '';
        const r = p.rec;
        let out = '<b>' + p.date + ' ' + p.slot + '</b>';
        if (!r) return out + '<br><span style="color:#888">该时点暂无数据</span>';
        out += '　<span style="color:#888">交易 ' + (r.total == null ? '--' : r.total) + ' 家</span>';
        out += '<br><span style="display:inline-block;width:9px;height:3px;background:#ef4444;margin-right:4px;"></span>' +
          '做多：<b>' + resVal(r, RES_GROUPS[0]) + '</b>（追高 ' + (r.c1 || 0) + ' / 抄底 ' + (r.c2 || 0) + '）';
        out += '<br><span style="display:inline-block;width:9px;height:3px;background:#22c55e;margin-right:4px;"></span>' +
          '做空：<b>' + resVal(r, RES_GROUPS[1]) + '</b>（离场 ' + (r.c3 || 0) + ' / 恐慌 ' + (r.c4 || 0) + '）';
        out += '<br><span style="display:inline-block;width:9px;height:3px;background:#f59e0b;margin-right:4px;"></span>' +
          '上方阻力强：<b>' + (r.c5 || 0) + '</b>';
        out += '<br><span style="display:inline-block;width:9px;height:3px;background:#3b82f6;margin-right:4px;"></span>' +
          '下方支撑强：<b>' + (r.c6 || 0) + '</b>';
        if (r.src === 'snap' && r.drift) {
          out += '<br><span style="color:#888;font-size:10px;">盘中快照（实际 ' + r.actual + '，偏移 ' + r.drift + ' 分钟），收盘后会被精确复盘覆盖</span>';
        }
        return out;
      }
    },
    axisPointer: {
      type: 'line',
      link: [{ xAxisIndex: [0, 1] }],
      label: { show: false },
      lineStyle: { color: isLight ? '#999999' : '#8a8f98', type: 'dashed', width: 1 }
    },
    grid: [
      { left: 8, right: 14, top: 24, height: '40%', containLabel: true },
      { left: 8, right: 14, top: '60%', bottom: 2, height: '32%', containLabel: true }
    ],
    dataZoom: [Object.assign({ type: 'inside', xAxisIndex: [0, 1], throttle: 50 }, keepZoom || {})],
    xAxis: [
      {
        type: 'category', data: labels, gridIndex: 0, boundaryGap: false,
        axisLine: { lineStyle: { color: axisColor } }, axisTick: { show: false },
        axisLabel: { show: false },
        splitLine: { show: true, interval: 8, lineStyle: { color: axisColor, type: 'dashed', opacity: 0.8 } },
        axisPointer: { show: true }
      },
      {
        type: 'category', data: labels, gridIndex: 1, boundaryGap: false,
        axisLine: { lineStyle: { color: axisColor } }, axisTick: { show: false },
        axisLabel: {
          color: textColor, fontSize: 9, interval: 0,
          formatter: function (v, i) {
            const p = points[i];
            if (!p) return '';
            if (p.slot === '10:00') return p.date.slice(5);
            if (p.slot === '15:00') return '15:00';
            return '';
          }
        },
        splitLine: { show: true, interval: 8, lineStyle: { color: axisColor, type: 'dashed', opacity: 0.8 } },
        axisPointer: { show: true }
      }
    ],
    yAxis: [
      {
        type: 'value', gridIndex: 0, name: '家', nameTextStyle: { color: textColor, fontSize: 9 },
        min: 0,
        splitLine: { lineStyle: { color: axisColor, type: 'dashed' } },
        axisLabel: { color: textColor, fontSize: 9 }
      },
      {
        type: 'value', gridIndex: 1, name: '家', nameTextStyle: { color: textColor, fontSize: 9 },
        min: 0,
        splitLine: { lineStyle: { color: axisColor, type: 'dashed' } },
        axisLabel: { color: textColor, fontSize: 9 }
      }
    ],
    series: series
  };

  if (resChart) { try { resChart.dispose(); } catch (e) {} resChart = null; }
  resChart = echarts.init(chartEl);
  resChart.setOption(option);
}

/* ---------- 事件 ---------- */

function bindResEvents(container) {
  container.querySelectorAll('.res-range').forEach(btn => {
    btn.onclick = () => {
      resRange = btn.dataset.range;
      container.querySelectorAll('.res-range').forEach(b => {
        b.style.background = b === btn ? 'var(--accent)' : 'transparent';
        b.style.color = b === btn ? '#fff' : '';
      });
      if (resData) {
        const el = container.querySelector('#res-chart');
        if (el) drawResChart(el, resData);
      }
    };
  });
}
