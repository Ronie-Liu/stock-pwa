// ===== K线图渲染（ECharts CDN） =====

let klineChart = null;
let minuteChart = null;
let currentKlineData = [];
let dataZoomLocked = false;

/**
 * 计算MA均线
 */
function calcMA(data, period) {
  let result = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result[i] = parseFloat((sum / period).toFixed(3));
  }
  return result;
}

/**
 * 计算BOLL线
 */
function calcBOLL(closes, period = 20, multiplier = 2) {
  let mid = calcMA(closes, period);
  let upper = new Array(closes.length).fill(null);
  let lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let slice = closes.slice(i - period + 1, i + 1);
    let mean = slice.reduce((a, b) => a + b, 0) / period;
    let variance = slice.reduce((a, b) => a + (b - mean) * (b - mean), 0) / period;
    let std = Math.sqrt(variance);
    upper[i] = parseFloat((mean + multiplier * std).toFixed(3));
    lower[i] = parseFloat((mean - multiplier * std).toFixed(3));
  }
  return { mid, upper, lower };
}

/**
 * 计算MACD
 */
function calcMACDData(closes, fast = 12, slow = 26, signal = 9) {
  function ema(data, period) {
    let k = 2 / (period + 1);
    let r = new Array(data.length).fill(null);
    r[period - 1] = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) r[i] = data[i] * k + r[i - 1] * (1 - k);
    return r;
  }
  let ef = ema(closes, fast), es = ema(closes, slow);
  let diff = new Array(closes.length).fill(null);
  let dea = new Array(closes.length).fill(null);
  let hist = new Array(closes.length).fill(null);
  let si = Math.max(slow - 1, fast - 1);
  for (let i = si; i < closes.length; i++) {
    if (ef[i] != null && es[i] != null) diff[i] = parseFloat((ef[i] - es[i]).toFixed(4));
  }
  let vd = diff.filter(v => v != null);
  if (vd.length >= signal) {
    let dInit = vd.slice(0, signal).reduce((a, b) => a + b, 0) / signal;
    let k = 2 / (signal + 1), dc = 0;
    for (let i = 0; i < closes.length; i++) {
      if (diff[i] != null) {
        dc++;
        if (dc === signal) dea[i] = parseFloat(dInit.toFixed(4));
        else if (dc > signal) dea[i] = parseFloat((diff[i] * k + dea[i - 1] * (1 - k)).toFixed(4));
      }
    }
  }
  for (let i = 0; i < closes.length; i++) {
    if (diff[i] != null && dea[i] != null) hist[i] = parseFloat((2 * (diff[i] - dea[i])).toFixed(4));
  }
  return { diff, dea, hist };
}

/**
 * 更新K线上方的指标面板（美化为4行分层显示）
 */
function updateIndicatorPanel(candles, idx) {
  let panel = document.getElementById('indicator-panel');
  if (!panel || !candles || idx < 0 || idx >= candles.length) return;

  let c = candles[idx];
  let closes = candles.map(k => k.close);

  let prevClose = idx > 0 ? candles[idx - 1].close : c.open;
  let changeRate = ((c.close - prevClose) / prevClose * 100);

  // 优先使用API返回的MA数据
  let ma5 = c.ma5;
  let ma10 = c.ma10;
  let ma20 = c.ma20;
  let ma120 = c.ma120;
  let ma60 = c.ma60;

  // 如果API没返回，本地计算
  if (ma5 == null) ma5 = calcMA(closes, 5)[idx];
  if (ma10 == null) ma10 = calcMA(closes, 10)[idx];
  if (ma20 == null) ma20 = calcMA(closes, 20)[idx];
  if (ma120 == null) ma120 = calcMA(closes, Math.min(120, closes.length))[idx];
  if (ma60 == null) ma60 = calcMA(closes, Math.min(60, closes.length))[idx];
  let boll = calcBOLL(closes);
  let macdArr = calcMACDData(closes);

  let bollU = boll.upper[idx];
  let bollM = boll.mid[idx];
  let bollL = boll.lower[idx];
  let dif = macdArr.diff[idx];
  let dea = macdArr.dea[idx];
  let macdH = macdArr.hist[idx];

  let rateColor = changeRate >= 0 ? 'var(--up-color)' : 'var(--down-color)';
  let rateSign = changeRate >= 0 ? '+' : '';
  let d = c.date;

  panel.innerHTML = `
    <div class="ind-line ind-line-date">📅 ${d}</div>
    <div class="ind-line ind-line-quote">
      <span class="ind-tag ind-tag-close">收 <b style="color:${rateColor}">${c.close.toFixed(2)}</b></span>
      <span class="ind-tag ind-tag-change">涨 <b style="color:${rateColor}">${rateSign}${changeRate.toFixed(2)}%</b></span>
      <span class="ind-tag ind-tag-vol">量 <b>${(c.volume/100).toFixed(0)}手</b></span>
    </div>
    <div class="ind-line ind-line-ma">
      <span class="ind-tag ind-tag-ma5" style="border-left:3px solid #ff9800">MA5 <b>${ma5!=null?ma5.toFixed(2):'--'}</b></span>
      <span class="ind-tag ind-tag-ma10" style="border-left:3px solid #2196f3">MA10 <b>${ma10!=null?ma10.toFixed(2):'--'}</b></span>
      <span class="ind-tag ind-tag-ma20" style="border-left:3px solid #9c27b0">MA20 <b>${ma20!=null?ma20.toFixed(2):'--'}</b></span>
      <span class="ind-tag ind-tag-ma120" style="border-left:3px solid #00bcd4">MA120 <b>${ma120!=null?ma120.toFixed(2):'--'}</b></span>
      <span class="ind-tag ind-tag-ma60" style="border-left:3px solid #795548">MA60 <b>${ma60!=null?ma60.toFixed(2):'--'}</b></span>
    </div>
    <div class="ind-line ind-line-boll">
      <span class="ind-tag ind-tag-bollu" style="border-left:3px solid #e91e63">BOLL上 <b>${bollU!=null?bollU.toFixed(2):'--'}</b></span>
      <span class="ind-tag ind-tag-bollm" style="border-left:3px solid #9c27b0">中 <b>${bollM!=null?bollM.toFixed(2):'--'}</b></span>
      <span class="ind-tag ind-tag-bolll" style="border-left:3px solid #e91e63">下 <b>${bollL!=null?bollL.toFixed(2):'--'}</b></span>
    </div>
    <div class="ind-line ind-line-macd">
      <span class="ind-tag ind-tag-dif" style="border-left:3px solid #f5c542">DIF <b>${dif!=null?dif.toFixed(3):'--'}</b></span>
      <span class="ind-tag ind-tag-dea" style="border-left:3px solid #4da6ff">DEA <b>${dea!=null?dea.toFixed(3):'--'}</b></span>
      <span class="ind-tag ind-tag-macdh" style="border-left:3px solid ${macdH!=null&&macdH>=0?'#ef4444':'#22c55e'}">MACD <b>${macdH!=null?macdH.toFixed(3):'--'}</b></span>
    </div>
  `;
}

/**
 * 渲染K线图
 */
async function renderKLineChart(code) {
  let container = document.getElementById('kline-chart');
  if (!container) return;

  container.innerHTML = '<div style="text-align:center;padding-top:140px;color:var(--text-secondary)"><span class="spinner"></span> 加载K线数据...</div>';

  if (typeof echarts === 'undefined') {
    try {
      await loadECharts();
    } catch (e) {
      container.innerHTML = '<div style="text-align:center;padding-top:140px;color:var(--danger)">图表组件加载失败，请检查网络后重试</div>';
      return;
    }
  }

  try {
    let result = await fetchKLine(code, 250);
    if (result.error || !result.candles || result.candles.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding-top:140px;color:var(--text-secondary)">暂无K线数据</div>';
      return;
    }

    currentKlineData = result.candles;
    let closes = currentKlineData.map(c => c.close);
    let dates = currentKlineData.map(c => c.date);
    let volumes = currentKlineData.map(c => c.volume);

    // 优先使用新浪API直接返回的MA数据，不完整时回退到本地计算
    let ma5 = currentKlineData.map(c => c.ma5);
    let ma10 = currentKlineData.map(c => c.ma10);
    let ma20 = currentKlineData.map(c => c.ma20);
    let ma120 = currentKlineData.map(c => c.ma120);
    let ma60 = currentKlineData.map(c => c.ma60);

    // 如果API没返回MA数据（非新浪API），本地计算
    if (ma5.every(v => v == null)) ma5 = calcMA(closes, 5);
    if (ma10.every(v => v == null)) ma10 = calcMA(closes, 10);
    if (ma20.every(v => v == null)) ma20 = calcMA(closes, 20);
    if (ma120.every(v => v == null)) ma120 = calcMA(closes, Math.min(120, closes.length));
    if (ma60.every(v => v == null)) ma60 = calcMA(closes, Math.min(60, closes.length));

    // 计算指标
    let boll = calcBOLL(closes);
    let macdArr = calcMACDData(closes);

    container.innerHTML = '';
    let isLight = document.documentElement.getAttribute('data-theme') === 'light';
    let textColor = isLight ? '#333' : '#e0e0e0';
    let bgColor = isLight ? '#ffffff' : '#1e1e1e';
    let borderColor = isLight ? '#e0e0e0' : '#2a2a2a';

    // 更新指标面板（显示最新数据）
    updateIndicatorPanel(currentKlineData, currentKlineData.length - 1);

    let option = {
      backgroundColor: bgColor,
      animation: false,
      // 保留十字线（虚线），但隐藏浮窗内容
      tooltip: {
        show: true,
        trigger: 'axis',
        triggerOn: 'mousemove|click',
        axisPointer: {
          type: 'cross',
          crossStyle: { color: textColor, width: 1, type: 'dashed' },
          label: {
            show: true,
            backgroundColor: isLight ? '#f0f0f0' : '#333',
            color: textColor,
            fontSize: 10
          }
        },
        formatter: function(params) {
          // 只保留日期显示在轴上，tooltip浮窗内容为空（仅用于触发十字线）
          return '';
        }
      },
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: [0, 1, 2, 3],
          start: 50, end: 100,
          minValueSpan: 5,
          zoomOnMouseWheel: true,
          moveOnMouseMove: true,
          moveOnMouseWheel: false,
          preventDefaultMouseMove: false,
          disabled: dataZoomLocked
        },
        {
          type: 'slider',
          xAxisIndex: [0, 1, 2, 3],
          start: 50, end: 100,
          height: 24,
          bottom: 5,
          borderColor: borderColor,
          fillerColor: isLight ? 'rgba(0,196,140,0.2)' : 'rgba(0,196,140,0.3)',
          handleStyle: { color: '#00c48c' },
          textStyle: { color: textColor, fontSize: 10 },
          showDataShadow: false,
          showDetail: true
        }
      ],
      grid: [
        // 0: K线主图（K线+均线，无BOLL）
        { left: '10%', right: '5%', top: '8%', height: '30%' },
        // 1: 成交量柱形图
        { left: '10%', right: '5%', top: '41%', height: '12%' },
        // 2: MACD
        { left: '10%', right: '5%', top: '56%', height: '12%' },
        // 3: BOLL + K线蜡烛图（与主流金融软件一致）
        { left: '10%', right: '5%', top: '71%', height: '14%' }
      ],
      legend: {
        data: ['K线', 'MA5', 'MA10', 'MA20', 'MA120', 'MA60', '成交量', 'DIF', 'DEA', 'MACD', 'BOLL上轨', 'BOLL中轨', 'BOLL下轨'],
        top: 2,
        left: 5,
        right: 5,
        textStyle: { color: textColor, fontSize: 9 },
        itemWidth: 10,
        itemHeight: 6,
        itemGap: 6,
        type: 'scroll'
      },
      xAxis: [
        { type: 'category', data: dates, gridIndex: 0, axisLine: { lineStyle: { color: borderColor } }, axisLabel: { show: false }, axisTick: { show: false } },
        { type: 'category', data: dates, gridIndex: 1, axisLine: { show: false }, axisLabel: { show: false }, axisTick: { show: false } },
        { type: 'category', data: dates, gridIndex: 2, axisLine: { lineStyle: { color: borderColor } }, axisLabel: { show: false }, axisTick: { show: false } },
        { type: 'category', data: dates, gridIndex: 3, axisLine: { lineStyle: { color: borderColor } }, axisLabel: { color: textColor, fontSize: 9 }, axisTick: { show: false } }
      ],
      yAxis: [
        // 0: K线
        { scale: true, gridIndex: 0, splitLine: { lineStyle: { color: borderColor, type: 'dashed' } }, axisLabel: { color: textColor, fontSize: 9 } },
        // 1: 成交量
        { scale: true, gridIndex: 1, splitLine: { show: false }, axisLabel: { color: textColor, fontSize: 8, formatter: v => v >= 1e8 ? (v/1e8).toFixed(1)+'亿' : v >= 1e4 ? (v/1e4).toFixed(0)+'万' : v } },
        // 2: MACD
        { scale: true, gridIndex: 2, splitLine: { lineStyle: { color: borderColor, type: 'dashed' } }, axisLabel: { color: textColor, fontSize: 8 } },
        // 3: BOLL + K线
        { scale: true, gridIndex: 3, splitLine: { show: false }, axisLabel: { color: textColor, fontSize: 8 } }
      ],
      series: [
        // === Grid 0: K线主图 ===
        {
          name: 'K线', type: 'candlestick',
          xAxisIndex: 0, yAxisIndex: 0,
          data: currentKlineData.map(c => [c.open, c.close, c.low, c.high]),
          itemStyle: { color: '#ef4444', color0: '#22c55e', borderColor: '#ef4444', borderColor0: '#22c55e' }
        },
        { name: 'MA5', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma5, symbol: 'none', lineStyle: { color: '#ff9800', width: 1 } },
        { name: 'MA10', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma10, symbol: 'none', lineStyle: { color: '#2196f3', width: 1 } },
        { name: 'MA20', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma20, symbol: 'none', lineStyle: { color: '#9c27b0', width: 1 } },
        { name: 'MA120', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma120, symbol: 'none', lineStyle: { color: '#00bcd4', width: 1 } },
        { name: 'MA60', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma60, symbol: 'none', lineStyle: { color: '#795548', width: 1 } },

        // === Grid 1: 成交量柱形图 ===
        {
          name: '成交量', type: 'bar',
          xAxisIndex: 1, yAxisIndex: 1,
          data: volumes.map((v, i) => {
            let isUp = currentKlineData[i].close >= currentKlineData[i].open;
            return { value: v, itemStyle: { color: isUp ? 'rgba(239,68,68,0.6)' : 'rgba(34,197,94,0.6)' } };
          })
        },

        // === Grid 2: MACD ===
        { name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: macdArr.diff, symbol: 'none', lineStyle: { color: '#f5c542', width: 1 }, smooth: true },
        { name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: macdArr.dea, symbol: 'none', lineStyle: { color: '#4da6ff', width: 1 }, smooth: true },
        {
          name: 'MACD', type: 'bar',
          xAxisIndex: 2, yAxisIndex: 2,
          data: macdArr.hist.map(v => v != null ? { value: v, itemStyle: { color: v >= 0 ? '#ef4444' : '#22c55e' } } : null)
        },

        // === Grid 3: BOLL + K线蜡烛图 ===
        { name: 'BOLL上轨', type: 'line', xAxisIndex: 3, yAxisIndex: 3, data: boll.upper, symbol: 'none', lineStyle: { color: '#e91e63', width: 1 } },
        { name: 'BOLL中轨', type: 'line', xAxisIndex: 3, yAxisIndex: 3, data: boll.mid, symbol: 'none', lineStyle: { color: '#9c27b0', width: 1.5, type: 'dashed' } },
        { name: 'BOLL下轨', type: 'line', xAxisIndex: 3, yAxisIndex: 3, data: boll.lower, symbol: 'none', lineStyle: { color: '#e91e63', width: 1 } },
        {
          name: 'K线(BOLL)', type: 'candlestick',
          xAxisIndex: 3, yAxisIndex: 3,
          data: currentKlineData.map(c => [c.open, c.close, c.low, c.high]),
          itemStyle: { 
            color: '#ef4444', color0: '#22c55e', 
            borderColor: '#ef4444', borderColor0: '#22c55e',
            opacity: 0.7
          },
          barWidth: '60%'
        }
      ]
    };

    klineChart = echarts.init(container);
    klineChart.setOption(option);

    // 十字线移动时更新指标面板
    klineChart.on('updateAxisPointer', function(params) {
      if (params.dataIndex != null) {
        updateIndicatorPanel(currentKlineData, params.dataIndex);
      }
    });

    // 点击K线区域仅用于切换十字线数据的显示（锁定不影响点击）
    klineChart.on('click', function(params) {
      if (params.dataIndex != null) {
        updateIndicatorPanel(currentKlineData, params.dataIndex);
      }
    });

    // 锁定按钮直接绑定到DOM元素
    let lockBadge = document.getElementById('zoom-lock-badge');
    if (lockBadge) {
      lockBadge.onclick = function(e) {
        e.stopPropagation();
        toggleZoomLock();
      };
    }

    window.addEventListener('resize', () => { if (klineChart) klineChart.resize(); });

  } catch (e) {
    container.innerHTML = '<div style="text-align:center;padding-top:140px;color:var(--danger)">K线加载失败: ' + escapeHtml(e.message) + '</div>';
  }
}

// ===== 分时图渲染（经典金融软件样式） =====

function formatMinuteTime(hhmm) {
  if (!hhmm || String(hhmm).length < 4) return hhmm || '';
  let s = String(hhmm);
  return s.slice(0, 2) + ':' + s.slice(2, 4);
}

function formatVolHand(vol) {
  if (vol == null || isNaN(vol)) return '--';
  if (vol >= 1e8) return (vol / 1e8).toFixed(2) + '亿手';
  if (vol >= 1e4) return (vol / 1e4).toFixed(2) + '万手';
  return Math.round(vol) + '手';
}

function formatAmount(amt) {
  if (amt == null || isNaN(amt)) return '--';
  if (amt >= 1e8) return (amt / 1e8).toFixed(2) + '亿';
  if (amt >= 1e4) return (amt / 1e4).toFixed(2) + '万';
  return Math.round(amt) + '元';
}

/**
 * 渲染个股分时图（现价线 + 均价线 + 成交量柱）
 * 信息栏含：现价/涨跌幅/均价/开/高/低/昨收/量/额/换手
 */
async function renderMinuteChart(code, quote) {
  let container = document.getElementById('minute-chart');
  let infoEl = document.getElementById('minute-info');
  if (!container) return;

  if (infoEl) infoEl.innerHTML = '<div class="minute-info-loading"><span class="spinner"></span> 加载分时数据...</div>';

  if (typeof echarts === 'undefined') {
    try { await loadECharts(); }
    catch (e) {
      if (infoEl) infoEl.innerHTML = '<div class="minute-info-empty">图表组件加载失败</div>';
      return;
    }
  }

  try {
    let result = await fetchMinute(code);
    if (result.error || !result.points || result.points.length === 0) {
      if (infoEl) infoEl.innerHTML = '<div class="minute-info-empty">暂无分时数据' + (result.error ? '（' + escapeHtml(result.error) + '）' : '') + '</div>';
      return;
    }

    let points = result.points;
    let times = points.map(p => p.time);
    let prices = points.map(p => p.price);
    let avgs = points.map(p => p.avgPrice);

    // 昨收（涨跌幅基准）
    let prevClose = (quote && !quote.error && quote.prev_close) ? parseFloat(quote.prev_close) : null;
    if (!prevClose || prevClose <= 0) prevClose = prices[0];

    let last = prices[prices.length - 1];
    let open = prices[0];
    let high = Math.max(...prices);
    let low = Math.min(...prices);
    let change = last - prevClose;
    let changeRate = (change / prevClose) * 100;
    let avgLast = avgs[avgs.length - 1];
    let lastP = points[points.length - 1];
    let totalVol = lastP.cumVol || points.reduce((a, p) => a + p.volume, 0);   // 手
    let totalAmt = lastP.cumAmt || points.reduce((a, p) => a + p.volume * p.price * 100, 0); // 元
    let turnover = (quote && !quote.error && quote.turnover_ratio != null) ? quote.turnover_ratio : null;

    let up = changeRate >= 0;
    let mainColor = up ? '#ef4444' : '#22c55e';
    let sign = up ? '+' : '';

    // 信息栏渲染
    if (infoEl) {
      infoEl.innerHTML = `
        <div class="minute-info-main">
          <div class="minute-info-price" style="color:${mainColor}">${last.toFixed(2)}</div>
          <div class="minute-info-change">
            <span style="color:${mainColor}">${sign}${change.toFixed(2)}</span>
            <span class="minute-info-rate" style="background:${mainColor}">${sign}${changeRate.toFixed(2)}%</span>
          </div>
        </div>
        <div class="minute-info-grid">
          <div class="minute-info-cell"><span class="k">均价</span><span class="v">${avgLast.toFixed(2)}</span></div>
          <div class="minute-info-cell"><span class="k">今开</span><span class="v">${open.toFixed(2)}</span></div>
          <div class="minute-info-cell"><span class="k">最高</span><span class="v">${high.toFixed(2)}</span></div>
          <div class="minute-info-cell"><span class="k">最低</span><span class="v">${low.toFixed(2)}</span></div>
          <div class="minute-info-cell"><span class="k">昨收</span><span class="v">${prevClose.toFixed(2)}</span></div>
          <div class="minute-info-cell"><span class="k">成交量</span><span class="v">${formatVolHand(totalVol)}</span></div>
          <div class="minute-info-cell"><span class="k">成交额</span><span class="v">${formatAmount(totalAmt)}</span></div>
          <div class="minute-info-cell"><span class="k">换手率</span><span class="v">${turnover != null ? turnover.toFixed(2) + '%' : '--'}</span></div>
        </div>
        ${result.date ? `<div class="minute-info-date">${escapeHtml(result.date)}</div>` : ''}
      `;
    }

    container.innerHTML = '';
    let isLight = document.documentElement.getAttribute('data-theme') === 'light';
    let textColor = isLight ? '#333' : '#e0e0e0';
    let bgColor = isLight ? '#ffffff' : '#1e1e1e';
    let borderColor = isLight ? '#e0e0e0' : '#2a2a2a';
    let lineColor = isLight ? '#333333' : '#e0e0e0';
    let avgLineColor = '#f5a623'; // 均价线（经典黄色）
    let upColor = '#ef4444', downColor = '#22c55e';

    // 价格轴范围（含均价）
    let priceMin = Math.min(low, Math.min(...avgs), prevClose);
    let priceMax = Math.max(high, Math.max(...avgs), prevClose);
    let pad = (priceMax - priceMin) * 0.06 || prevClose * 0.01 || 0.01;
    priceMin = priceMin - pad;
    priceMax = priceMax + pad;

    // 成交量柱颜色：与前一分钟价格比较
    let volData = points.map((p, i) => {
      let isUpBar = i === 0 ? p.price >= prevClose : p.price >= points[i - 1].price;
      return { value: p.volume, itemStyle: { color: isUpBar ? upColor : downColor } };
    });

    let option = {
      backgroundColor: bgColor,
      animation: false,
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', crossStyle: { color: textColor, width: 1, type: 'dashed' }, label: { backgroundColor: isLight ? '#f0f0f0' : '#333', color: textColor, fontSize: 10 } },
        formatter: function(params) {
          let idx = params[0] && params[0].dataIndex;
          if (idx == null) return '';
          let p = points[idx];
          let dChange = p.price - prevClose;
          let dRate = (dChange / prevClose) * 100;
          let s = dRate >= 0 ? '+' : '';
          let c = dRate >= 0 ? upColor : downColor;
          return '<div style="font-size:11px;line-height:1.7">'
            + '<div>' + formatMinuteTime(p.time) + '</div>'
            + '<div style="color:' + c + '">现价 ' + p.price.toFixed(2) + '（' + s + dRate.toFixed(2) + '%）</div>'
            + '<div>均价 ' + p.avgPrice.toFixed(2) + '</div>'
            + '<div>量 ' + formatVolHand(p.cumVol) + '</div>'
            + '</div>';
        }
      },
      grid: [
        { left: '2%', right: '8%', top: '2%', height: '60%' },
        { left: '2%', right: '8%', top: '70%', height: '22%' }
      ],
      xAxis: [
        { type: 'category', data: times, boundaryGap: false, gridIndex: 0, axisLine: { lineStyle: { color: borderColor } }, axisLabel: { show: false }, axisTick: { show: false } },
        { type: 'category', data: times, boundaryGap: false, gridIndex: 1, axisLine: { lineStyle: { color: borderColor } }, axisLabel: { color: textColor, fontSize: 9, interval: Math.max(0, Math.floor(times.length / 5) - 1), formatter: v => formatMinuteTime(v) }, axisTick: { show: false } }
      ],
      yAxis: [
        { scale: true, position: 'left', min: priceMin, max: priceMax, gridIndex: 0, splitLine: { lineStyle: { color: borderColor, type: 'dashed' } }, axisLabel: { color: textColor, fontSize: 9, formatter: v => v.toFixed(2) } },
        { scale: true, position: 'right', min: (priceMin - prevClose) / prevClose * 100, max: (priceMax - prevClose) / prevClose * 100, gridIndex: 0, splitLine: { show: false }, axisLabel: { color: textColor, fontSize: 9, formatter: v => v.toFixed(1) + '%' } },
        { scale: true, gridIndex: 1, splitLine: { show: false }, axisLabel: { color: textColor, fontSize: 8, formatter: v => v >= 1e4 ? (v / 1e4).toFixed(0) + '万' : v } }
      ],
      series: [
        { name: '分时', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: prices, symbol: 'none', lineStyle: { color: lineColor, width: 1.4 },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [ { offset: 0, color: up ? 'rgba(239,68,68,0.28)' : 'rgba(34,197,94,0.28)' }, { offset: 1, color: 'rgba(0,0,0,0)' } ] } } },
        { name: '均价', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: avgs, symbol: 'none', lineStyle: { color: avgLineColor, width: 1.2 } },
        { name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 2, data: volData, barWidth: '70%' }
      ]
    };

    minuteChart = echarts.init(container);
    minuteChart.setOption(option);
    window.addEventListener('resize', () => { if (minuteChart) minuteChart.resize(); });
  } catch (e) {
    container.innerHTML = '';
    if (infoEl) infoEl.innerHTML = '<div class="minute-info-empty">分时加载失败: ' + escapeHtml(e.message) + '</div>';
  }
}

/**
 * 切换缩放锁定状态
 */
function toggleZoomLock() {
  dataZoomLocked = !dataZoomLocked;
  let lockBadge = document.getElementById('zoom-lock-badge');
  if (lockBadge) {
    lockBadge.textContent = dataZoomLocked ? '🔒 已锁定' : '🔓 未锁定';
    lockBadge.className = 'zoom-lock-badge' + (dataZoomLocked ? ' locked' : '');
  }
  if (klineChart) {
    klineChart.setOption({
      dataZoom: [{ type: 'inside', disabled: dataZoomLocked }]
    });
  }
}

const ECHARTS_CDNS = [
  'https://cdn.staticfile.org/echarts/5.5.0/echarts.min.js',
  'https://registry.npmmirror.com/echarts/5.5.0/files/dist/echarts.min.js',
  'https://cdn.bootcdn.net/ajax/libs/echarts/5.5.0/echarts.min.js',
  'https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js'
];

function loadECharts() {
  return new Promise((resolve, reject) => {
    if (typeof echarts !== 'undefined') return resolve();
    let idx = 0;
    function tryNext() {
      if (typeof echarts !== 'undefined') return resolve();
      if (idx >= ECHARTS_CDNS.length) return reject(new Error('ECharts加载失败'));
      let script = document.createElement('script');
      let settled = false;
      function done(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) resolve();
        else tryNext();
      }
      let timer = setTimeout(() => { script.remove(); done(false); }, 8000);
      script.onload = () => done(true);
      script.onerror = () => { script.remove(); done(false); };
      script.src = ECHARTS_CDNS[idx++];
      document.head.appendChild(script);
    }
    tryNext();
  });
}

function disposeChart() {
  if (klineChart) { klineChart.dispose(); klineChart = null; }
  if (minuteChart) { minuteChart.dispose(); minuteChart = null; }
}
