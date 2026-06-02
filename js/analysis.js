// ===== 三维共振技术分析引擎 v3 =====
// 宏观: 政策+资金+市场 | 中观: 景气度+相对强度+板块结构 | 微观: 基本面+资金面+技术面+消息面
// 数据来源: 腾讯行情 + 东方财富 + 新浪 | 基于历史数据的指标运算，不构成投资建议

// ==================== 工具函数 ====================
function safeNum(v, f = 0) { let n = parseFloat(v); return isNaN(n) || !isFinite(n) ? f : n; }
function safeAvg(arr) { let v = arr.filter(x => isFinite(x) && !isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
function pct(a, b) { return b ? ((a - b) / Math.abs(b) * 100) : 0; }
function calcMASeriesS(data, period) {
  let r = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let seg = data.slice(i - period + 1, i + 1).filter(v => isFinite(v) && !isNaN(v));
    r[i] = seg.length ? parseFloat((seg.reduce((a, b) => a + b, 0) / seg.length).toFixed(3)) : null;
  }
  return r;
}

async function fetchKLineRaw(tcode, count = 120, period = 'day') {
  let url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + tcode + ',' + period + ',,,' + count + ',qfq';
  try {
    let resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let json = await resp.json();
    let sd = json.data && json.data[tcode];
    if (!sd) throw new Error('无数据');
    let isBJ = tcode.startsWith('bj');
    let key = period === 'week' ? (isBJ ? 'week' : 'qfqweek') : (isBJ ? 'day' : 'qfqday');
    let raw = sd[key] || sd[period];
    if (!raw || !raw.length) throw new Error('无' + period + '线');
    return raw.map(item => ({
      date: item[0], open: safeNum(item[1]), close: safeNum(item[2]),
      high: safeNum(item[3]), low: safeNum(item[4]), volume: safeNum(item[5]) * 100
    }));
  } catch (e) { console.error('K线获取失败:', e.message); return []; }
}

function fetchDailyRaw(code, count = 120) {
  let tc = window.stdToTencent ? window.stdToTencent(code) : ('sz' + code.replace(/\D/g, ''));
  return fetchKLineRaw(tc, count, 'day');
}
function fetchWeeklyRaw(code, count = 120) {
  let tc = window.stdToTencent ? window.stdToTencent(code) : ('sz' + code.replace(/\D/g, ''));
  return fetchKLineRaw(tc, count, 'week');
}

const INDEX_CODES = {
  sh: { name: '上证指数', code: '000001', tc: 'sh000001', ext: '1.000001' },
  sz: { name: '深证成指', code: '399001', tc: 'sz399001', ext: '0.399001' },
  cyb: { name: '创业板指', code: '399006', tc: 'sz399006', ext: '0.399006' },
  hs300: { name: '沪深300', code: '000300', tc: 'sh000300', ext: '1.000300' },
  kc50: { name: '科创50', code: '000688', tc: 'sh000688', ext: '1.000688' }
};

// ==================== 宏观：大盘指数分析（市场面） ====================
async function fetchIndexData() {
  let keys = ['sh', 'cyb', 'hs300'];
  let results = {};
  await Promise.all(keys.map(async k => {
    let info = INDEX_CODES[k];
    let candles = await fetchKLineRaw(info.tc, 250, 'day');
    results[k] = { info, candles };
  }));
  return results;
}

function analyzeMacro(indexData) {
  let rows = [], bullish = 0, bearish = 0, details = [];
  for (let key of ['sh', 'cyb', 'hs300']) {
    let entry = indexData[key];
    if (!entry || !entry.candles.length) continue;
    let cs = entry.candles, info = entry.info, idx = cs.length - 1;
    let close = cs[idx].close;
    let closes = cs.map(c => c.close).filter(v => v > 0);
    let volumes = cs.map(c => c.volume).filter(v => v > 0);
    let ma20 = calcMASeriesS(closes, 20), ma60 = calcMASeriesS(closes, 60), ma250 = calcMASeriesS(closes, 250);
    let slope20 = 0;
    if (ma20[idx] && ma20[Math.max(0, idx - 20)]) slope20 = pct(ma20[idx], ma20[Math.max(0, idx - 20)]) / 20;
    let volMA5 = safeAvg(volumes.slice(-5)), volMA20 = safeAvg(volumes.slice(-20));
    let volRatio = volMA20 ? parseFloat((volMA5 / volMA20).toFixed(2)) : 0;
    let volTrend = volRatio > 1.2 ? '放量' : volRatio < 0.7 ? '缩量' : '持平';
    let aboveMA20 = close > (ma20[idx] || close), aboveMA60 = close > (ma60[idx] || close), aboveMA250 = close > (ma250[idx] || close);
    let trendSignal = '';
    if (aboveMA20 && aboveMA60 && slope20 > 0) { trendSignal = '多头排列'; bullish += 2; }
    else if (!aboveMA20 && slope20 < -0.1) { trendSignal = '空头排列'; bearish += 2; }
    else { trendSignal = '震荡'; bullish += 1; bearish += 1; }
    if (volTrend === '放量') bullish += 1; else if (volTrend === '缩量') bearish += 1;
    rows.push({ name: info.name, code: info.code, close: close.toFixed(2),
      ma20: (ma20[idx]||'--'), ma60: (ma60[idx]||'--'), ma250: (ma250[idx]||'--'),
      slope20: slope20.toFixed(2), volRatio, volTrend, trendSignal, aboveMA20, aboveMA60, aboveMA250, dataDate: cs[idx].date });
    details.push(info.name + ': ' + close.toFixed(2) + ' | MA20' + (ma20[idx]||'--') + ' ' + (aboveMA20?'✅':'❌') + ' MA60' + (ma60[idx]||'--') + ' ' + (aboveMA60?'✅':'❌') + ' MA250' + (ma250[idx]||'--') + ' ' + (aboveMA250?'✅':'❌') + ' | ' + volTrend + '(' + volRatio + ')');
  }
  let net = bullish - bearish;
  let signal, resultText, positionAdvice;
  if (net >= 4) { signal = 'green'; resultText = '🟢 强势市场'; positionAdvice = '建议仓位 7-9成。多头排列+量能配合。'; }
  else if (net >= 1) { signal = 'yellow'; resultText = '🟡 震荡市场'; positionAdvice = '建议仓位 5成左右。注重板块选择。'; }
  else { signal = 'red'; resultText = '🔴 弱势市场'; positionAdvice = '建议仓位 ≤3成。空头排列，倾巢之下无完卵。'; }
  return { signal, resultText, positionAdvice, rows, details: details.join('\n'), bullish, bearish, net, dataDate: rows.length ? rows[0].dataDate : '--' };
}

// ==================== 宏观：资金面 ====================

async function fetchNorthboundFlow() {
  let results = { daily: [], signal: 'neutral', trending: '--', last5Net: 0, detail: '' };
  try {
    // 东方财富北向资金日线API
    let url = 'https://push2.eastmoney.com/api/qt/kamt.kline/get?secid=1.000001&fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56&klt=101&lmt=10';
    let resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let d = await resp.json();
    let kls = d.data && d.data.klines ? d.data.klines : [];
    if (kls.length < 3) throw new Error('数据不足');
    let total = 0;
    for (let l of kls.slice(-5)) {
      let parts = l.split(',');
      let date = parts[0], netFlow = safeNum(parts[4] || parts[3]) / 10000; // 万元→亿
      results.daily.push({ date, netFlow: parseFloat(netFlow.toFixed(2)) });
      total += netFlow;
    }
    results.last5Net = parseFloat(total.toFixed(1));
    if (total > 50) { results.signal = 'green'; results.trending = '持续大幅流入'; }
    else if (total > 0) { results.signal = 'yellow'; results.trending = '小幅流入'; }
    else { results.signal = 'red'; results.trending = '持续流出'; }
    results.detail = results.daily.map(d => d.date + ': ' + (d.netFlow > 0 ? '+' : '') + d.netFlow + '亿').join(' | ');
  } catch (e) {
    console.log('北向资金获取失败:', e.message);
    results.detail = '(暂不可用)';
  }
  return results;
}

async function fetchMarketBreadth() {
  let results = { data: [], signal: 'neutral', upRatio: 0, detail: '' };
  try {
    // 涨跌家数比（上证+深证+创业板）
    let url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f8,f9,f12,f14&secids=1.000001,0.399001,0.399006';
    let resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let d = await resp.json();
    let diffs = d.data && d.data.diff ? d.data.diff : [];
    let totalUp = 0, totalDown = 0;
    for (let item of diffs) {
      let up = safeNum(item.f8), down = safeNum(item.f9);
      totalUp += up; totalDown += down;
    }
    let upRatio = totalUp + totalDown > 0 ? parseFloat((totalUp / (totalUp + totalDown) * 100).toFixed(1)) : 50;
    results.upRatio = upRatio;
    if (upRatio > 55) { results.signal = 'green'; results.trending = '普涨'; }
    else if (upRatio > 45) { results.signal = 'yellow'; results.trending = '分化'; }
    else { results.signal = 'red'; results.trending = '普跌'; }
    results.detail = '涨' + totalUp + '/跌' + totalDown + ' (' + upRatio + '%上涨)';
  } catch (e) {
    console.log('涨跌家数获取失败:', e.message);
    results.detail = '(暂不可用)';
  }
  return results;
}

// ==================== 中观：板块分析 ====================

function analyzeMeso(stock, stockCandles, indexData) {
  if (!stockCandles.length) return { signal: 'neutral', resultText: '数据不足' };
  let code = (stock.code || '').replace(/\D/g, '');
  let cs = stockCandles, closes = cs.map(c => c.close).filter(v => v > 0), idx = cs.length - 1;
  let board;
  if (/^60[013]/.test(code)) board = '上海主板';
  else if (/^688/.test(code)) board = '科创板';
  else if (/^300|^301/.test(code)) board = '创业板';
  else if (/^002|^003|^001/.test(code)) board = '深圳主板/中小板';
  else if (/^000/.test(code) && code !== '000001' && code !== '000300') board = '深圳主板';
  else if (/^920|^83|^87/.test(code)) board = '北交所';
  else board = '其他';

  let benchmarkKey = (board === '创业板' || board === '科创板') ? 'cyb' : 'sh';
  let benchmark = indexData[benchmarkKey] || indexData['sh'];
  if (!benchmark || !benchmark.candles.length) return { signal: 'neutral', resultText: '无法获取对标指数' };

  let bmCloses = benchmark.candles.map(c => c.close).filter(v => v > 0);
  function calcRS(period) {
    if (closes.length < period || bmCloses.length < period) return null;
    let sChg = pct(closes[closes.length - 1], closes[closes.length - 1 - period]);
    let bChg = pct(bmCloses[bmCloses.length - 1], bmCloses[bmCloses.length - 1 - period]);
    return parseFloat((sChg - bChg).toFixed(2));
  }
  let rs10 = calcRS(10), rs20 = calcRS(20), rs60 = calcRS(60);
  let sVols = cs.map(c => c.volume).filter(v => v > 0);
  let bVols = benchmark.candles.map(c => c.volume).filter(v => v > 0);
  let sVolTrend = safeAvg(sVols.slice(-5)) / Math.max(safeAvg(sVols.slice(-20)), 1);
  let bVolTrend = safeAvg(bVols.slice(-5)) / Math.max(safeAvg(bVols.slice(-20)), 1);

  let details = [];
  details.push('对标: ' + benchmark.info.name + '(' + benchmark.info.code + ') | 板块: ' + board);
  if (rs10 !== null) details.push('RS 10日: ' + (rs10 > 0 ? '+' : '') + rs10 + '%');
  if (rs20 !== null) details.push('RS 20日: ' + (rs20 > 0 ? '+' : '') + rs20 + '%');
  if (rs60 !== null) details.push('RS 60日: ' + (rs60 > 0 ? '+' : '') + rs60 + '%');
  details.push('个股量比: ' + sVolTrend.toFixed(2) + ' | 指数量比: ' + bVolTrend.toFixed(2));

  let bullish = 0, bearish = 0;
  if (rs20 !== null) { if (rs20 > 2) bullish += 3; else if (rs20 > 0) bullish += 1; else if (rs20 < -3) bearish += 3; else if (rs20 < 0) bearish += 1; }
  if (rs60 !== null) { if (rs60 > 5) bullish += 2; else if (rs60 < -5) bearish += 2; }
  if (sVolTrend > bVolTrend * 1.2) bullish += 1; else if (sVolTrend < bVolTrend * 0.7) bearish += 1;

  let net = bullish - bearish;
  let signal, resultText;
  if (net >= 3) { signal = 'green'; resultText = '🟢 领先大盘 —— 资金关注度高，左侧等待时间短'; }
  else if (net >= 0) { signal = 'yellow'; resultText = '🟡 同步大盘 —— 按计划分批执行'; }
  else { signal = 'red'; resultText = '🔴 弱于大盘 —— 资金流出，磨底时间长'; }

  return { signal, resultText, board, benchmarkName: benchmark.info.name, rs10, rs20, rs60,
    sVolTrend: parseFloat(sVolTrend.toFixed(2)), bVolTrend: parseFloat(bVolTrend.toFixed(2)),
    details: details.join('\n'), bullish, bearish, net, dataDate: cs[idx].date };
}

// ==================== 微观：资金面（个股北向+主力） ====================

async function fetchStockFlow(code) {
  let results = { northbound: [], fundFlow: [], northboundSignal: 'neutral', northboundDetail: '', fundFlowDetail: '' };
  try {
    let extCode = code.startsWith('6') ? '1.' + code : '0.' + code;
    let url = 'https://push2.eastmoney.com/api/qt/stock/fflow/daykline/get?lmt=10&secid=' + extCode + '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54';
    let resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let d = await resp.json();
    let kls = d.data && d.data.klines ? d.data.klines : [];
    let totalNet = 0;
    for (let l of kls.slice(-5)) {
      let parts = l.split(',');
      let date = parts[0], mainNet = safeNum(parts[1]) + safeNum(parts[2]); // 主力+超大单
      results.fundFlow.push({ date, mainNet: parseFloat((mainNet / 1e8).toFixed(2)) });
      totalNet += mainNet;
    }
    if (totalNet > 1e8) { results.northboundSignal = 'green'; results.northboundDetail = '近5日主力资金持续流入'; }
    else if (totalNet > 0) { results.northboundSignal = 'yellow'; results.northboundDetail = '近5日主力资金小幅净流入'; }
    else { results.northboundSignal = 'red'; results.northboundDetail = '近5日主力资金净流出'; }
    results.fundFlowDetail = results.fundFlow.map(f => f.date + ': ' + (f.mainNet > 0 ? '+' : '') + f.mainNet + '亿').join(' | ');
  } catch (e) {
    console.log('个股资金流获取失败:', e.message);
    results.fundFlowDetail = '(暂不可用)';
  }
  return results;
}

// ==================== 微观：技术面四维（同v2） ====================

function analyzeDivergence(candles) {
  if (candles.length < 30) return { signal: 'insufficient', resultText: '数据不足' };
  let closes = candles.map(c => c.close).filter(v => v > 0);
  let macdData = calcMACDDataSeries(closes);
  let difArr = macdData.diff, rsiArr = calcRSISeries(closes, 14);
  let lookback = Math.min(60, closes.length);
  let segCloses = closes.slice(-lookback), segDifs = difArr.slice(-lookback), segRSIs = rsiArr.slice(-lookback);
  let segment = candles.slice(-lookback);
  let lows = findLocalLows(segCloses, 5);
  let macdDiv = false, rsiDiv = false, divDetail = '';
  if (lows.length >= 2) {
    let l1 = lows[lows.length - 1], l2 = lows[lows.length - 2];
    let p1 = segCloses[l1], p2 = segCloses[l2], d1 = segDifs[l1] || 0, d2 = segDifs[l2] || 0, r1 = segRSIs[l1] || 50, r2 = segRSIs[l2] || 50;
    if (p1 < p2) { if (d1 > d2) macdDiv = true; if (r1 > r2) rsiDiv = true; }
    divDetail = '低点1: ' + segment[l1].date + ' 收' + p1.toFixed(2) + ' DIF' + d1.toFixed(4) + ' RSI' + r1.toFixed(1) + ' | 低点2: ' + segment[l2].date + ' 收' + p2.toFixed(2) + ' DIF' + d2.toFixed(4) + ' RSI' + r2.toFixed(1);
  }
  let signal, resultText, bullish = 0, bearish = 0;
  if (macdDiv && rsiDiv) { signal = 'strong_bullish'; resultText = '✅ MACD+RSI双背离'; bullish = 3; }
  else if (macdDiv) { signal = 'bullish'; resultText = '🟢 MACD底背离'; bullish = 2; }
  else if (rsiDiv) { signal = 'mild_bullish'; resultText = '🟡 RSI底背离'; bullish = 1; }
  else { signal = 'none'; resultText = '🔴 未出现底背离'; bearish = 1; }
  return { signal, resultText, macdDivergence: macdDiv, rsiDivergence: rsiDiv, detail: divDetail,
    currentRSI: (rsiArr[rsiArr.length - 1] || 50), currentDIF: (difArr[difArr.length - 1] || 0),
    dataDate: candles[candles.length - 1].date, bullish, bearish };
}

function analyzeSupport(dailyCandles, weeklyCandles, currentPrice) {
  if (dailyCandles.length < 30) return { signal: 'insufficient', resultText: '数据不足' };
  let closes = dailyCandles.map(c => c.close).filter(v => v > 0), highs = dailyCandles.map(c => c.high).filter(v => v > 0), lows = dailyCandles.map(c => c.low).filter(v => v > 0);
  let lookback = Math.min(120, dailyCandles.length);
  let segH = highs.slice(-lookback), segL = lows.slice(-lookback), segC = dailyCandles.slice(-lookback);
  let hIdx = segH.indexOf(Math.max(...segH)), lIdx = segL.indexOf(Math.min(...segL));
  let swingHigh = segH[hIdx], swingLow = segL[lIdx], shDate = segC[hIdx]?.date, slDate = segC[lIdx]?.date;
  let range = swingHigh - swingLow, fibLevels = {}, fibTable = [];
  if (range > 0) {
    [0.236, 0.382, 0.5, 0.618].forEach(ratio => {
      let p = swingHigh - range * ratio;
      fibLevels['fib' + String(ratio).replace('.', '')] = parseFloat(p.toFixed(2));
      fibTable.push({ label: (ratio * 100).toFixed(1) + '%', price: parseFloat(p.toFixed(2)), dist: parseFloat((currentPrice - p).toFixed(2)) });
    });
    fibLevels.swingHigh = parseFloat(swingHigh.toFixed(2)); fibLevels.swingLow = parseFloat(swingLow.toFixed(2));
    fibLevels.shDate = shDate; fibLevels.slDate = slDate;
  }
  let denseZones = [];
  if (weeklyCandles.length >= 20) {
    let wc = weeklyCandles.map(c => c.close).filter(v => v > 0);
    let mn = Math.min(...wc), mx = Math.max(...wc), zc = 20, zs = (mx - mn) / zc;
    for (let i = 0; i < zc; i++) {
      let zl = mn + i * zs, zh = zl + zs;
      let wks = weeklyCandles.filter(c => c.close >= zl && c.close <= zh).length;
      if (wks >= 3) denseZones.push({ low: parseFloat(zl.toFixed(2)), high: parseFloat(zh.toFixed(2)), weeks: wks });
    }
    denseZones.sort((a, b) => b.weeks - a.weeks);
  }
  let signal, resultText, bullish = 0, bearish = 0;
  let nearestFib = fibTable.length ? fibTable.reduce((a, b) => Math.abs(a.dist) < Math.abs(b.dist) ? a : b) : null;
  if (nearestFib && nearestFib.dist < 0 && Math.abs(nearestFib.dist) / currentPrice < 0.05) { signal = 'strong_support'; resultText = '✅ 紧贴' + nearestFib.label + '(' + nearestFib.price + ')支撑'; bullish = 3; }
  else if (nearestFib && nearestFib.dist > 0 && nearestFib.dist / currentPrice < 0.08) { signal = 'approaching'; resultText = '🟡 接近' + nearestFib.label + '(' + nearestFib.price + ')支撑'; bullish = 1; }
  else { signal = 'far'; resultText = '🔴 距支撑位较远'; bearish = 2; }
  let denseStr = denseZones.slice(0, 3).map(z => z.low + '-' + z.high + '(' + z.weeks + '周)').join(' | ');
  return { signal, resultText, fibLevels, fibTable, denseZones, denseStr,
    weeklyRange: weeklyCandles.length ? weeklyCandles[0].date + '~' + weeklyCandles[weeklyCandles.length - 1].date : '--',
    dailyDataDate: dailyCandles[dailyCandles.length - 1].date, bullish, bearish };
}

function analyzeDowntrend(candles) {
  if (candles.length < 30) return { signal: 'insufficient', resultText: '数据不足' };
  let closes = candles.map(c => c.close).filter(v => v > 0), idx = candles.length - 1;
  function slope(data, p) { if (data.length < p * 2) return 0; let r = safeAvg(data.slice(-p)), o = safeAvg(data.slice(-p * 2, -p)); return o ? ((r - o) / o * 100) / p : 0; }
  let s10 = slope(closes, 10), s20 = slope(closes, 20);
  function segSlope(d, start, p) { let sr = safeAvg(d.slice(start, start + p)), so = safeAvg(d.slice(start - p, start)); return so ? ((sr - so) / so * 100) / p : 0; }
  let sOld = segSlope(closes, idx - 15, 10), sRecent = segSlope(closes, idx - 5, 10);
  let flattening = sRecent < 0 && sOld < 0 && Math.abs(sRecent) < Math.abs(sOld) * 0.7;
  let db = detectDoubleBottom(candles.slice(-60));
  let tl = calcDowntrendLine(candles);
  let signal, resultText, bullish = 0, bearish = 0;
  if (s10 > 0) { signal = 'stabilizing'; resultText = '🟢 短期企稳'; bullish = 3; }
  else if (flattening) { signal = 'flattening'; resultText = '🟡 跌速放缓'; bullish = 2; }
  else if (Math.abs(s10) < 0.3) { signal = 'mild_decline'; resultText = '🟡 温和下跌'; bullish = 1; }
  else { signal = 'steep_decline'; resultText = '🔴 急跌'; bearish = 3; }
  let ddStr = ''; if (db.found) ddStr = '双底: 左' + db.leftDate + ' ' + db.leftPrice + '→右' + db.rightDate + ' ' + db.rightPrice + (db.rightHigher ? '(右高✅)' : '');
  let tlStr = ''; if (tl.valid) tlStr = '下降趋势线: ' + tl.startDate + '起,突破价≈' + tl.breakPrice;
  return { signal, resultText, slope10: parseFloat(s10.toFixed(2)), slope20: parseFloat(s20.toFixed(2)),
    slopeFlattening: flattening, doubleBottom: db, trendline: tl,
    detail: [ddStr, tlStr].filter(Boolean).join('\n'), dataDate: candles[idx].date, bullish, bearish };
}

function analyzeVolumePrice(candles) {
  if (candles.length < 20) return { signal: 'insufficient', resultText: '数据不足' };
  let idx = candles.length - 1, recent10 = candles.slice(-10);
  let redVol = 0, greenVol = 0, redDays = 0, greenDays = 0;
  for (let c of recent10) {
    let v = safeNum(c.volume, 0);
    if (c.close >= c.open) { redVol += v; redDays++; }
    else { greenVol += v; greenDays++; }
  }
  let totalVol = redVol + greenVol, redRatio = totalVol ? parseFloat((redVol / totalVol * 100).toFixed(1)) : 50;
  let volumes = candles.map(c => safeNum(c.volume, 0));
  let volMA5 = safeAvg(volumes.slice(-5)), volMA20 = safeAvg(volumes.slice(-20));
  let volRatio = volMA20 > 0 ? parseFloat((volMA5 / volMA20).toFixed(2)) : 1;
  let volTrend = volRatio > 1.2 ? '放量' : volRatio < 0.7 ? '缩量' : '持平';
  let avgRecent5 = safeAvg(volumes.slice(-5)), avgPrev5 = safeAvg(volumes.slice(-10, -5));
  let volChange = avgPrev5 > 0 ? parseFloat(pct(avgRecent5, avgPrev5).toFixed(1)) : 0;
  let panicDay = null;
  for (let i = recent10.length - 1; i >= 0; i--) {
    let c = recent10[i], prevClose = i > 0 ? recent10[i - 1].close : (candles[idx - 10 + i - 1]?.close || c.open);
    let drop = pct(c.close, prevClose);
    if (safeNum(c.volume) > avgPrev5 * 2 && drop < -3) { panicDay = { date: c.date, drop: parseFloat(drop.toFixed(2)), vol: safeNum(c.volume) }; break; }
  }
  let redFat = redRatio >= 55 && redDays >= greenDays;
  let priceChg10 = recent10.length > 1 ? pct(recent10[recent10.length - 1].close, recent10[0].close) : 0;
  let details = [];
  details.push('近10日 阳量占比: ' + redRatio + '% (阳' + redDays + '/阴' + greenDays + ') | 量能比: ' + volRatio + ' | ' + volTrend);
  details.push('近5日vs前5日均量变化: ' + (volChange > 0 ? '+' : '') + volChange + '%');
  if (redFat) details.push('🟢 红肥绿瘦');
  if (panicDay) details.push('⚠️ 恐慌放量: ' + panicDay.date + ' 跌' + panicDay.drop + '%');
  let signal, resultText, bullish = 0, bearish = 0;
  if (redFat && volTrend === '缩量' && priceChg10 < 0) { signal = 'accumulation'; resultText = '🟢 红肥绿瘦+缩量下跌(吸筹)'; bullish = 3; }
  else if (panicDay && redFat) { signal = 'panic_cleared'; resultText = '🟢 恐慌释放后承接'; bullish = 2; }
  else if (volTrend === '放量' && priceChg10 < -5) { signal = 'panic_selling'; resultText = '🔴 放量急跌'; bearish = 3; }
  else if (volTrend === '缩量' && priceChg10 < 0) { signal = 'grinding_down'; resultText = '🟡 缩量阴跌'; bearish = 2; }
  else if (redFat) { signal = 'mild_bullish'; resultText = '🟡 中性偏多'; bullish = 1; }
  else { signal = 'neutral'; resultText = '🟡 中性'; }
  return { signal, resultText, redRatio, redDays, greenDays, volRatio, volTrend, volChange,
    panicDay, redFatGreenThin: redFat, details: details.join('\n'), dataDate: candles[idx].date, bullish, bearish };
}

// ==================== 综合共振决策 ====================

function analyzeMicroComprehensive(candles, weeklyCandles, quote) {
  let divergence = analyzeDivergence(candles);
  let support = analyzeSupport(candles, weeklyCandles, quote.last_px);
  let downtrend = analyzeDowntrend(candles);
  let volumePrice = analyzeVolumePrice(candles);
  let bullish = [divergence, support, downtrend, volumePrice].reduce((s, d) => s + (d.bullish || 0), 0);
  let bearish = [divergence, support, downtrend, volumePrice].reduce((s, d) => s + (d.bearish || 0), 0);
  let net = bullish - bearish;
  let signal, resultText;
  if (net >= 6) { signal = 'green'; resultText = '🟢 四维全偏多'; }
  else if (net >= 2) { signal = 'yellow'; resultText = '🟡 信号交织'; }
  else { signal = 'red'; resultText = '🔴 四维全偏空'; }
  return { signal, resultText, divergence, support, downtrend, volumePrice, bullish, bearish, net, dataDate: candles[candles.length - 1].date };
}

function generateResonanceDecision(macro, meso, micro, northbound, breadth, stockFlow, stock, quote) {
  let buyPrice = stock.buy_price || 0, currentPrice = quote ? quote.last_px : 0;
  // 宏观：融合市场面+资金面
  let macroBullish = macro.bullish + (northbound.signal === 'green' ? 2 : northbound.signal === 'red' ? 0 : 1) + (breadth.signal === 'green' ? 1 : breadth.signal === 'red' ? -1 : 0);
  let macroBearish = macro.bearish + (northbound.signal === 'red' ? 2 : northbound.signal === 'green' ? 0 : 1) + (breadth.signal === 'red' ? 1 : 0);

  let levels = [
    { dim: '宏观(大盘+资金)', signal: macro.signal, resultText: macro.resultText, subdetail: '北向: ' + northbound.trending + ' | 涨跌比: ' + breadth.trending + ' | ' + macro.positionAdvice, bullish: macroBullish, bearish: macroBearish },
    { dim: '中观(板块方向)', signal: meso.signal, resultText: meso.resultText, subdetail: meso.board + ' | 对标: ' + meso.benchmarkName + ' | RS20: ' + (meso.rs20 !== null ? (meso.rs20 > 0 ? '+' : '') + meso.rs20 + '%' : '--'), bullish: meso.bullish || 0, bearish: meso.bearish || 0 },
    { dim: '微观资金面', signal: stockFlow.northboundSignal, resultText: stockFlow.northboundDetail, subdetail: '', bullish: stockFlow.northboundSignal === 'green' ? 2 : stockFlow.northboundSignal === 'yellow' ? 1 : 0, bearish: stockFlow.northboundSignal === 'red' ? 2 : 0 },
    { dim: '微观技术面', signal: micro.signal, resultText: micro.resultText, subdetail: '四维净分: ' + micro.net + ' (偏多' + micro.bullish + '/偏空' + micro.bearish + ')', bullish: micro.bullish || 0, bearish: micro.bearish || 0 }
  ];

  let totalBullish = levels.reduce((a, l) => a + l.bullish, 0);
  let totalBearish = levels.reduce((a, l) => a + l.bearish, 0);
  let netScore = totalBullish - totalBearish;
  let greenCount = levels.filter(l => l.signal === 'green' || l.signal === 'strong_bullish' || l.signal === 'bullish' || l.signal === 'strong_support' || l.signal === 'stabilizing' || l.signal === 'accumulation' || l.signal === 'panic_cleared').length;
  let redCount = levels.filter(l => l.signal === 'red' || l.signal === 'steep_decline' || l.signal === 'panic_selling' || l.signal === 'far').length;

  let overallSignal, suggestion, suggestionDetail, positionAdvice;
  if (greenCount >= 3 && netScore >= 8) {
    overallSignal = 'green'; suggestion = '🟢 三维共振 —— 可积极买入';
    suggestionDetail = '宏观向好+资金流入+微观底部确认。可将买入动作提前，右侧放量突破即可加仓。';
    positionAdvice = macro.positionAdvice;
  } else if (greenCount >= 2 && netScore >= 3) {
    overallSignal = 'yellow'; suggestion = '🟡 信号偏多 —— 按计划分批执行';
    suggestionDetail = '多数维度偏多但未全维共振。建议维持原定分批买入计划。';
    positionAdvice = macro.positionAdvice;
  } else {
    overallSignal = 'red'; suggestion = '🔴 多维度偏空 —— 暂停买入，等待信号';
    suggestionDetail = '宏观/资金/技术多维度发出谨慎信号。拉大买入间距(如跌10%→15%)，降低单笔仓位。';
    positionAdvice = macro.positionAdvice;
  }

  let suggestedPrice = buyPrice;
  if (buyPrice > 0) {
    if (overallSignal === 'green') suggestedPrice = buyPrice * 1.05;
    else if (overallSignal === 'red') suggestedPrice = buyPrice * 0.92;
  }

  return { levels, totalBullish, totalBearish, netScore, greenCount, redCount,
    overallSignal, suggestion, suggestionDetail, positionAdvice,
    originalBuyPrice: buyPrice, suggestedBuyPrice: parseFloat(suggestedPrice.toFixed(2)), currentPrice, northbound, breadth, stockFlow };
}

// ==================== 主入口 ====================

async function runAnalysisAndRender(stock, quote) {
  let loadingEl = document.getElementById('analysis-loading');
  let resultEl = document.getElementById('analysis-result');
  let btnEl = document.getElementById('btn-analysis');
  if (loadingEl) loadingEl.style.display = 'block';
  if (resultEl) resultEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">三维共振分析中：获取指数K线→北向资金→涨跌比→板块对标→个股资金→四维技术...请稍候</div>';
  if (btnEl) btnEl.style.display = 'none';

  try {
    let [indexData, dailyData, weeklyData, northbound, breadth, stockFlow] = await Promise.all([
      fetchIndexData(),
      fetchDailyRaw(stock.code, 120),
      fetchWeeklyRaw(stock.code, 120),
      fetchNorthboundFlow(),
      fetchMarketBreadth(),
      fetchStockFlow(stock.code)
    ]);

    if (!dailyData.length) {
      if (resultEl) resultEl.innerHTML = '<span class="error-text">K线数据获取失败，请检查网络后重试</span>';
      if (loadingEl) loadingEl.style.display = 'none';
      if (btnEl) btnEl.style.display = 'inline-block';
      return;
    }

    let macro = analyzeMacro(indexData);
    let meso = analyzeMeso(stock, dailyData, indexData);
    let micro = analyzeMicroComprehensive(dailyData, weeklyData, quote);
    let resonance = generateResonanceDecision(macro, meso, micro, northbound, breadth, stockFlow, stock, quote);

    if (resultEl) resultEl.innerHTML = renderResonanceHTML(stock, quote, macro, meso, micro, resonance);
  } catch (e) {
    console.error('三维分析失败:', e);
    if (resultEl) resultEl.innerHTML = '<span class="error-text">分析失败: ' + escapeHtml(e.message) + '</span>';
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
    if (btnEl) btnEl.style.display = 'inline-block';
  }
}

// ==================== 渲染 ====================

function renderResonanceHTML(stock, quote, macro, meso, micro, resonance) {
  let div = micro.divergence, sup = micro.support, dtr = micro.downtrend, vp = micro.volumePrice;
  let lvl = resonance.levels;
  let nb = resonance.northbound, br = resonance.breadth, sf = resonance.stockFlow;
  let lightColor = resonance.overallSignal === 'green' ? '#10b981' : resonance.overallSignal === 'yellow' ? '#f59e0b' : '#ef4444';
  let lightEmoji = resonance.overallSignal === 'green' ? '🟢' : resonance.overallSignal === 'yellow' ? '🟡' : '🔴';

  return `
<div class="resonance-card">
  <h4 style="margin:0 0 4px;font-size:17px;">📋 ${escapeHtml(stock.name)} 三维共振分析</h4>
  <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">
    数据日期: ${macro.dataDate} | 现价: ${quote.last_px.toFixed(2)} | 原定买入价: ${resonance.originalBuyPrice.toFixed(2)}
  </div>

  <!-- 信号灯条 -->
  <div class="traffic-bar" style="background:var(--bg-input);border-radius:8px;padding:10px 14px;margin-bottom:12px;">
    <div class="traffic-row" style="display:flex;justify-content:space-around;text-align:center;gap:8px;">
      ${lvl.map(l => {
        let e = l.signal === 'green' || l.signal === 'strong_bullish' || l.signal === 'bullish' || l.signal === 'strong_support' || l.signal === 'stabilizing' || l.signal === 'accumulation' || l.signal === 'panic_cleared' ? '🟢' : (l.signal === 'red' || l.signal === 'steep_decline' || l.signal === 'panic_selling' || l.signal === 'far' ? '🔴' : '🟡');
        return '<div style="flex:1;min-width:0"><div style="font-size:24px;">' + e + '</div><div style="font-size:10px;font-weight:600;">' + l.dim + '</div><div style="font-size:9px;color:var(--text-muted);line-height:1.3;">' + (l.subdetail || l.resultText).slice(0, 35) + '</div></div>';
      }).join('')}
    </div>
  </div>

  <!-- 综合决策 -->
  <div class="decision-card" style="background:${lightColor}15;border-radius:8px;padding:12px;margin-bottom:12px;border-left:3px solid ${lightColor};">
    <div style="font-size:15px;font-weight:700;margin-bottom:4px;">${resonance.suggestion}</div>
    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;">${resonance.suggestionDetail}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">${resonance.positionAdvice}</div>
    <div style="display:flex;gap:16px;font-size:12px;flex-wrap:wrap;">
      <span>📌 原买入价: <strong>${resonance.originalBuyPrice.toFixed(2)}</strong></span>
      <span>🎯 建议: <strong>${resonance.suggestedBuyPrice.toFixed(2)}</strong></span>
      <span>📊 偏多 ${resonance.totalBullish} vs 偏空 ${resonance.totalBearish} (净${resonance.netScore})</span>
    </div>
  </div>

  <!-- 维度一：宏观 -->
  <details class="resonance-dim" open>
    <summary class="dim-summary"><span style="font-size:16px;margin-right:4px;">🌍</span> <strong>宏观 · 大盘定仓位</strong> <span style="font-size:11px;color:var(--text-muted)">—— ${macro.resultText} | 北向: ${nb.trending} | 涨跌: ${br.trending}</span></summary>
    <div class="dim-body">
      <!-- 市场面 -->
      <div class="dim-section-label">📊 市场面（均线+量能）</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">数据日: ${macro.dataDate} | 净分: ${macro.net}</div>
      <table class="res-table">
        <tr><th>指数</th><th>收盘</th><th>MA20</th><th>MA60</th><th>MA250</th><th>斜率(%/日)</th><th>量能</th><th>趋势</th></tr>
        ${macro.rows.map(r => '<tr><td>' + r.name + '</td><td>' + r.close + '</td><td>' + r.ma20 + ' ' + (r.aboveMA20?'✅':'❌') + '</td><td>' + r.ma60 + ' ' + (r.aboveMA60?'✅':'❌') + '</td><td>' + r.ma250 + ' ' + (r.aboveMA250?'✅':'❌') + '</td><td>' + r.slope20 + '</td><td>' + r.volRatio + '(' + r.volTrend + ')</td><td>' + r.trendSignal + '</td></tr>').join('')}
      </table>

      <!-- 资金面 -->
      <div class="dim-section-label">💰 资金面（北向+涨跌比）</div>
      <div class="dim-detail-text" style="font-size:11px;">
        北向资金近5日: ${nb.detail}<br>
        涨跌家数比: ${br.detail}<br>
        ${nb.signal === 'green' ? '🟢 资金面积极：北向流入+涨多跌少，系统性风险小' : nb.signal === 'red' ? '🔴 资金面谨慎：北向流出+普跌，降低仓位' : '🟡 资金面中性'}
      </div>
      <div class="dim-note">📌 ${macro.positionAdvice}</div>
    </div>
  </details>

  <!-- 维度二：中观 -->
  <details class="resonance-dim">
    <summary class="dim-summary"><span style="font-size:16px;margin-right:4px;">🏢</span> <strong>中观 · 板块定方向</strong> <span style="font-size:11px;color:var(--text-muted)">—— ${meso.resultText}</span></summary>
    <div class="dim-body">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">数据日: ${meso.dataDate} | 板块: ${meso.board} | 对标: ${meso.benchmarkName}</div>
      <table class="res-table">
        <tr><th>周期</th><th>相对强度</th><th>含义</th></tr>
        ${meso.rs10 !== null ? '<tr><td>10日</td><td>' + (meso.rs10 > 0 ? '+' : '') + meso.rs10 + '%</td><td>' + (meso.rs10 > 2 ? '🟢 显著强于大盘' : meso.rs10 > 0 ? '🟡 略强' : '🔴 弱于大盘') + '</td></tr>' : ''}
        ${meso.rs20 !== null ? '<tr><td>20日</td><td>' + (meso.rs20 > 0 ? '+' : '') + meso.rs20 + '%</td><td>' + (meso.rs20 > 2 ? '🟢 显著强于大盘' : meso.rs20 > 0 ? '🟡 略强' : '🔴 弱于大盘') + '</td></tr>' : ''}
        ${meso.rs60 !== null ? '<tr><td>60日</td><td>' + (meso.rs60 > 0 ? '+' : '') + meso.rs60 + '%</td><td>' + (meso.rs60 > 5 ? '🟢 长期领先，龙头效应' : meso.rs60 > 0 ? '🟡 长期持平' : '🔴 长期跑输') + '</td></tr>' : ''}
      </table>
      <div style="font-size:11px;color:var(--text-secondary);margin-top:4px;">个股量比: ${meso.sVolTrend} | 指数量比: ${meso.bVolTrend} | ${meso.sVolTrend > meso.bVolTrend * 1.2 ? '🟢 个股放量强于指数' : meso.sVolTrend > meso.bVolTrend ? '🟡 个股放量略强' : '🔴 个股缩量弱于指数'}</div>
      <div class="dim-note" style="margin-top:4px;">${meso.resultText}</div>
    </div>
  </details>

  <!-- 维度三：微观 -->
  <details class="resonance-dim">
    <summary class="dim-summary"><span style="font-size:16px;margin-right:4px;">🔬</span> <strong>微观 · 个股定击球点</strong> <span style="font-size:11px;color:var(--text-muted)">—— ${micro.resultText}</span></summary>
    <div class="dim-body">
      <!-- 资金面 -->
      <div class="dim-section-label">💰 资金面（个股主力流向）</div>
      <div class="dim-detail-text" style="font-size:11px;margin-bottom:6px;">
        ${sf.fundFlowDetail}<br>
        <span style="color:${sf.northboundSignal === 'green' ? '#10b981' : sf.northboundSignal === 'red' ? '#ef4444' : '#d97706'};">${sf.northboundDetail}</span>
        ${sf.northboundSignal === 'green' ? ' → 🟢 底部反复出现放量阳线+缩量阴线组合，主力建仓特征' : sf.northboundSignal === 'red' ? ' → 🔴 无主力关注，技术形态再好也要谨慎' : ''}
      </div>

      <!-- 技术面四维 -->
      <div class="dim-section-label">📐 技术面四维</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">数据日: ${micro.dataDate} | 四维净分: ${micro.net} (偏多${micro.bullish}/偏空${micro.bearish})</div>

      <div class="micro-sub">
        <div class="micro-sub-header"><span class="signal-tag ${div.signal}">${div.signal === 'strong_bullish' ? '✅✅' : div.signal === 'bullish' ? '✅' : div.signal === 'mild_bullish' ? '🟡' : '🔴'}</span> 底背离</div>
        <div class="micro-sub-result">${div.resultText}</div>
        <div class="micro-sub-data">RSI(14): ${(div.currentRSI||50).toFixed(1)} | MACD DIF: ${(div.currentDIF||0).toFixed(4)} | ${div.dataDate}</div>
        ${div.detail ? '<div class="micro-sub-detail">' + div.detail.replace(/\n/g, '<br>') + '</div>' : ''}
      </div>

      <div class="micro-sub">
        <div class="micro-sub-header"><span class="signal-tag ${sup.signal}">${sup.signal === 'strong_support' ? '✅' : sup.signal === 'approaching' ? '🟡' : '🔴'}</span> 支撑位</div>
        <div class="micro-sub-result">${sup.resultText}</div>
        <div class="micro-sub-data">波段高: ${sup.fibLevels.shDate||'--'} ${sup.fibLevels.swingHigh||'--'} | 波段低: ${sup.fibLevels.slDate||'--'} ${sup.fibLevels.swingLow||'--'}</div>
        ${sup.fibTable.length ? '<table class="res-table" style="margin-top:4px;"><tr><th>斐波那契位</th><th>价格</th><th>距现价</th></tr>' + sup.fibTable.map(f => '<tr class="' + (f.label === '61.8%' ? 'fib-golden' : '') + '"><td>' + f.label + (f.label === '61.8%' ? ' 🥇' : '') + '</td><td>' + f.price + '</td><td>' + (f.dist > 0 ? '+' : '') + f.dist + '</td></tr>').join('') + '</table>' : ''}
        ${sup.denseZones.length ? '<div class="micro-sub-detail">📌 历史密集区(周线 ' + sup.weeklyRange + '): ' + sup.denseStr + '</div>' : ''}
      </div>

      <div class="micro-sub">
        <div class="micro-sub-header"><span class="signal-tag ${dtr.signal}">${dtr.signal === 'stabilizing' ? '✅' : dtr.signal === 'flattening' ? '🟢' : dtr.signal === 'mild_decline' ? '🟡' : '🔴'}</span> 下跌结构</div>
        <div class="micro-sub-result">${dtr.resultText}</div>
        <div class="micro-sub-data">10日斜率: ${dtr.slope10}%/日 | 20日: ${dtr.slope20}%/日 | ${dtr.dataDate}</div>
        ${dtr.detail ? '<div class="micro-sub-detail">' + dtr.detail.replace(/\n/g, '<br>') + '</div>' : ''}
      </div>

      <div class="micro-sub">
        <div class="micro-sub-header"><span class="signal-tag ${vp.signal}">${vp.signal === 'accumulation' || vp.signal === 'panic_cleared' ? '✅' : vp.signal === 'mild_bullish' ? '🟡' : vp.signal === 'panic_selling' || vp.signal === 'grinding_down' ? '🔴' : '🟡'}</span> 量价关系</div>
        <div class="micro-sub-result">${vp.resultText}</div>
        <div class="micro-sub-data">阳量: ${vp.redRatio}% | 量能趋势: ${vp.volTrend} (MA5/MA20=${vp.volRatio}) | ${vp.dataDate}</div>
        <div class="micro-sub-detail">${vp.details.replace(/\n/g, '<br>')}</div>
      </div>
    </div>
  </details>

  <!-- 决策矩阵 -->
  <div style="font-size:13px;margin-top:12px;padding:10px;background:var(--bg-input);border-radius:8px;">
    <div style="font-weight:700;margin-bottom:6px;">📊 综合决策矩阵</div>
    <table class="res-table">
      <tr><th>维度</th><th>信号</th><th>判断</th><th>行动</th></tr>
      ${resonance.levels.map(l => {
        let state = l.signal === 'green' || l.signal === 'strong_bullish' || l.signal === 'bullish' ? '🟢 绿灯' : (l.signal === 'red' || l.signal === 'steep_decline' || l.signal === 'panic_selling' ? '🔴 红灯' : '🟡 黄灯');
        let act = l.signal === 'green' ? '可积极' : l.signal === 'red' ? '等待' : '按计划';
        return '<tr><td>' + l.dim + '</td><td>' + state + '</td><td style="font-size:11px;">' + l.resultText.slice(0, 40) + '</td><td style="font-size:11px;">' + act + '</td></tr>';
      }).join('')}
      <tr style="font-weight:700;background:${lightColor}10;">
        <td>综合</td><td>${lightEmoji} ${resonance.overallSignal === 'green' ? '绿灯' : resonance.overallSignal === 'yellow' ? '黄灯' : '红灯'}</td>
        <td colspan="2">${resonance.suggestion}</td>
      </tr>
    </table>
  </div>

  <div style="font-size:10px;color:var(--text-muted);margin-top:8px;text-align:center;">
    ⚠️ 以上基于公开数据的指标运算，不构成投资建议。数据来源：腾讯行情+东方财富。
  </div>
</div>`;
}

// ==================== 辅助函数 ====================
function findLocalLows(data, period) {
  let lows = [];
  for (let i = period; i < data.length - period; i++) {
    let isLow = true;
    for (let j = i - period; j <= i + period; j++) { if (j === i) continue; if (data[j] <= data[i]) { isLow = false; break; } }
    if (isLow) lows.push(i);
  }
  return lows;
}

function calcRSISeries(closes, period = 14) {
  if (closes.length < period + 1) return new Array(closes.length).fill(50);
  let gains = new Array(closes.length).fill(0), losses = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) { let ch = closes[i] - closes[i - 1]; if (ch > 0) gains[i] = ch; else if (ch < 0) losses[i] = Math.abs(ch); }
  let rsiArr = new Array(closes.length).fill(null);
  let avgG = gains.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  let avgL = losses.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  rsiArr[period] = avgL === 0 ? 100 : parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(1));
  for (let i = period + 1; i < closes.length; i++) {
    avgG = (avgG * (period - 1) + gains[i]) / period;
    avgL = (avgL * (period - 1) + losses[i]) / period;
    rsiArr[i] = avgL === 0 ? 100 : parseFloat((100 - 100 / (1 + avgG / avgL)).toFixed(1));
  }
  return rsiArr;
}

function detectDoubleBottom(candles) {
  if (candles.length < 20) return { found: false };
  let lowVals = candles.map(c => c.low);
  let locLows = findLocalLows(lowVals, 3);
  if (locLows.length < 2) return { found: false };
  let l1 = locLows[locLows.length - 1], l2 = locLows[locLows.length - 2];
  if (Math.abs(l1 - l2) < 5) return { found: false };
  let lp1 = lowVals[l1], lp2 = lowVals[l2], diffPct = pct(lp1, lp2);
  if (Math.abs(diffPct) > 5) return { found: false };
  return { found: true, leftDate: candles[l2].date, leftPrice: parseFloat(lp2.toFixed(2)), rightDate: candles[l1].date, rightPrice: parseFloat(lp1.toFixed(2)), rightHigher: lp1 > lp2, diffPct: parseFloat(diffPct.toFixed(1)) };
}

function calcDowntrendLine(candles) {
  if (candles.length < 30) return { valid: false };
  let highs = candles.map(c => c.high), lookback = Math.min(90, candles.length);
  let seg = candles.slice(-lookback), segH = highs.slice(-lookback);
  let maxIdx = segH.indexOf(Math.max(...segH));
  let startDate = seg[maxIdx].date, startHigh = segH[maxIdx], s2 = -Infinity, s2Idx = -1;
  for (let i = maxIdx + 10; i < seg.length - 5; i++) { if (segH[i] > s2 && segH[i] < startHigh) { s2 = segH[i]; s2Idx = i; } }
  if (s2Idx < 0) return { valid: false, startDate };
  let slp = (startHigh - s2) / (maxIdx - s2Idx);
  return { valid: slp < 0, startDate, slope: parseFloat(slp.toFixed(4)), breakPrice: parseFloat((startHigh + slp * (seg.length - 1 - maxIdx)).toFixed(2)) };
}
