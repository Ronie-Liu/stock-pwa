// ===== 三维共振技术分析引擎 =====
//  宏观定仓位 → 中观定方向 → 微观定击球点
//  基于历史K线数据的技术指标，不构成投资建议

// ==================== 工具函数 ====================

function safeNum(v, fallback = 0) { let n = parseFloat(v); return isNaN(n) || !isFinite(n) ? fallback : n; }
function safeAvg(arr) { let valid = arr.filter(v => isFinite(v) && !isNaN(v)); return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0; }
function pct(a, b) { return b ? ((a - b) / Math.abs(b) * 100) : 0; }

function calcMASeriesS(data, period) {
  let r = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let seg = data.slice(i - period + 1, i + 1).filter(v => isFinite(v) && !isNaN(v));
    r[i] = seg.length ? parseFloat((seg.reduce((a, b) => a + b, 0) / seg.length).toFixed(3)) : null;
  }
  return r;
}

async function fetchKLineRaw(tencentCode, count = 120, period = 'day') {
  let url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentCode},${period},,,${count},qfq`;
  try {
    let resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let json = await resp.json();
    let sd = json.data && json.data[tencentCode];
    if (!sd) throw new Error('无数据');
    let isBJ = tencentCode.startsWith('bj');
    let key = period === 'week' ? (isBJ ? 'week' : 'qfqweek') : (isBJ ? 'day' : 'qfqday');
    let raw = sd[key] || sd[period];
    if (!raw || !raw.length) throw new Error('无' + period + '线数据');
    return raw.map(item => ({
      date: item[0],
      open: safeNum(item[1]),
      close: safeNum(item[2]),
      high: safeNum(item[3]),
      low: safeNum(item[4]),
      volume: safeNum(item[5]) * 100
    }));
  } catch (e) {
    console.error('K线获取失败(' + tencentCode + '):', e.message);
    return [];
  }
}

function fetchWeeklyRaw(code, count = 120) {
  let tcode = window.stdToTencent ? window.stdToTencent(code) : ('sz' + code.replace(/\D/g, ''));
  return fetchKLineRaw(tcode, count, 'week');
}

function fetchDailyRaw(code, count = 120) {
  let tcode = window.stdToTencent ? window.stdToTencent(code) : ('sz' + code.replace(/\D/g, ''));
  return fetchKLineRaw(tcode, count, 'day');
}

// ==================== 宏观：大盘指数分析 ====================

// 大类指数腾讯代码（不用 stdToTencent 因为它会把 000001 映射错）
const INDEX_CODES = {
  sh: { name: '上证指数', code: '000001', tc: 'sh000001' },
  sz: { name: '深证成指', code: '399001', tc: 'sz399001' },
  cyb: { name: '创业板指', code: '399006', tc: 'sz399006' },
  hs300: { name: '沪深300', code: '000300', tc: 'sh000300' },
  kc50: { name: '科创50', code: '000688', tc: 'sh000688' }
};

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
  let rows = [];
  let bullish = 0, bearish = 0;
  let details = [];

  for (let key of ['sh', 'cyb', 'hs300']) {
    let entry = indexData[key];
    if (!entry || !entry.candles.length) continue;
    let cs = entry.candles;
    let info = entry.info;
    let idx = cs.length - 1;
    let close = cs[idx].close;
    let closes = cs.map(c => c.close).filter(v => v > 0);
    let volumes = cs.map(c => c.volume).filter(v => v > 0);

    let ma20 = calcMASeriesS(closes, 20);
    let ma60 = calcMASeriesS(closes, 60);
    let ma250 = calcMASeriesS(closes, 250);

    let slope20 = 0;
    if (ma20[idx] && ma20[Math.max(0, idx - 20)]) {
      slope20 = pct(ma20[idx], ma20[Math.max(0, idx - 20)]) / 20;
    }

    let volMA5 = safeAvg(volumes.slice(-5));
    let volMA20 = safeAvg(volumes.slice(-20));
    let volRatio = volMA20 ? parseFloat((volMA5 / volMA20).toFixed(2)) : 0;
    let volTrend = volRatio > 1.2 ? '放量' : volRatio < 0.7 ? '缩量' : '持平';

    let aboveMA20 = close > (ma20[idx] || close) ? '✅' : '❌';
    let aboveMA60 = close > (ma60[idx] || close) ? '✅' : '❌';
    let aboveMA250 = close > (ma250[idx] || close) ? '✅' : '❌';

    let trendSignal = '';
    if (close > (ma20[idx] || 0) && (ma20[idx] || 0) > (ma60[idx] || 0) && slope20 > 0) {
      trendSignal = '🟢 多头排列'; bullish += 2;
    } else if (close < (ma20[idx] || 0) && slope20 < -0.1) {
      trendSignal = '🔴 空头排列'; bearish += 2;
    } else {
      trendSignal = '🟡 均线缠绕(震荡)'; bullish += 1; bearish += 1;
    }

    if (volTrend === '放量') bullish += 1;
    else if (volTrend === '缩量') bearish += 1;

    rows.push({ name: info.name, code: info.code, close: close.toFixed(2),
      ma20: ma20[idx]?.toFixed(2) || '--', ma60: ma60[idx]?.toFixed(2) || '--', ma250: ma250[idx]?.toFixed(2) || '--',
      slope20: slope20.toFixed(2), volRatio, volTrend, trendSignal, aboveMA20, aboveMA60, aboveMA250,
      dataDate: cs[idx].date });
    details.push(`${info.name}: 收盘 ${close.toFixed(2)} | MA20 ${ma20[idx]?.toFixed(2)||'--'} ${aboveMA20} MA60 ${ma60[idx]?.toFixed(2)||'--'} ${aboveMA60} MA250 ${ma250[idx]?.toFixed(2)||'--'} ${aboveMA250} | 斜率 ${slope20.toFixed(2)}%/日 | 量 ${volTrend}(${volRatio})`);
  }

  // 整体信号
  let signal, resultText, positionAdvice;
  let net = bullish - bearish;
  if (net >= 4) {
    signal = 'green'; resultText = '🟢 强势市场'; positionAdvice = '建议仓位: 7-9成。大盘多头排列，量能配合，适合积极操作。个股出现信号可右侧确认加仓。';
  } else if (net >= 1) {
    signal = 'yellow'; resultText = '🟡 震荡市场'; positionAdvice = '建议仓位: 5成左右。结构性行情，注重板块选择，严格执行分批计划。';
  } else {
    signal = 'red'; resultText = '🔴 弱势市场'; positionAdvice = '建议仓位: 3成以下。空头排列+缩量，倾巢之下无完卵。拉大买入间距，降低单笔仓位。';
  }

  return { signal, resultText, positionAdvice, rows, details: details.join('\n'), bullish, bearish, net,
    dataDate: rows.length ? rows[0].dataDate : '--' };
}

// ==================== 中观：板块/相对强度 ====================

function analyzeMeso(stock, stockCandles, indexData) {
  if (!stockCandles.length) return { signal: 'neutral', resultText: 'K线数据不足，无法计算相对强度' };

  let code = (stock.code || '').replace(/\D/g, '');
  let cs = stockCandles;
  let closes = cs.map(c => c.close).filter(v => v > 0);
  let idx = cs.length - 1;

  // 归属板块
  let board;
  if (/^60[013]/.test(code)) board = '上海主板';
  else if (/^688/.test(code)) board = '科创板';
  else if (/^300|^301/.test(code)) board = '创业板';
  else if (/^002|^003|^001/.test(code)) board = '深圳主板/中小板';
  else if (/^000/.test(code) && code !== '000001' && code !== '000300') board = '深圳主板';
  else if (/^920|^83|^87/.test(code)) board = '北交所';
  else board = '其他';

  // 选对标指数：创业板/科创板 → 创业板指，其他 → 上证
  let benchmarkKey = (board === '创业板' || board === '科创板') ? 'cyb' : 'sh';
  let benchmark = indexData[benchmarkKey];
  if (!benchmark || !benchmark.candles.length) {
    benchmark = indexData['sh']; // fallback
  }
  if (!benchmark || !benchmark.candles.length) return { signal: 'neutral', resultText: '无法获取对标指数数据' };

  let bmCloses = benchmark.candles.map(c => c.close).filter(v => v > 0);

  // 计算不同周期的相对强度
  function calcRS(period) {
    if (closes.length < period || bmCloses.length < period) return null;
    let sChg = pct(closes[closes.length - 1], closes[closes.length - 1 - period]);
    let bChg = pct(bmCloses[bmCloses.length - 1], bmCloses[bmCloses.length - 1 - period]);
    return parseFloat((sChg - bChg).toFixed(2));
  }

  let rs10 = calcRS(10);
  let rs20 = calcRS(20);
  let rs60 = calcRS(60);

  // 量能对比较
  let sVols = cs.map(c => c.volume).filter(v => v > 0);
  let bVols = benchmark.candles.map(c => c.volume).filter(v => v > 0);
  let sVolTrend = safeAvg(sVols.slice(-5)) / Math.max(safeAvg(sVols.slice(-20)), 1);
  let bVolTrend = safeAvg(bVols.slice(-5)) / Math.max(safeAvg(bVols.slice(-20)), 1);

  let details = [];
  details.push(`对标指数: ${benchmark.info.name}（${benchmark.info.code}）`);
  if (rs10 !== null) details.push(`相对强度 10日: ${rs10 > 0 ? '+' : ''}${rs10}%`);
  if (rs20 !== null) details.push(`相对强度 20日: ${rs20 > 0 ? '+' : ''}${rs20}%`);
  if (rs60 !== null) details.push(`相对强度 60日: ${rs60 > 0 ? '+' : ''}${rs60}%`);
  details.push(`个股量能比(5/20MA): ${sVolTrend.toFixed(2)} | 指数量能比: ${bVolTrend.toFixed(2)}`);

  // 判断
  let bullish = 0, bearish = 0;
  if (rs20 !== null) { if (rs20 > 2) bullish += 3; else if (rs20 > 0) bullish += 1; else if (rs20 < -3) bearish += 3; else if (rs20 < 0) bearish += 1; }
  if (rs60 !== null) { if (rs60 > 5) bullish += 2; else if (rs60 < -5) bearish += 2; }
  if (sVolTrend > bVolTrend * 1.2) bullish += 1;
  else if (sVolTrend < bVolTrend * 0.7) bearish += 1;

  let net = bullish - bearish;
  let signal, resultText;
  if (net >= 3) { signal = 'green'; resultText = `🟢 领先大盘 —— ${board}，相对强度远超指数，资金关注度高。板块内龙头效应明显，左侧等待时间短。`; }
  else if (net >= 0) { signal = 'yellow'; resultText = `🟡 同步大盘 —— ${board}，与市场走势基本一致。按计划分批执行，无需特别调整节奏。`; }
  else { signal = 'red'; resultText = `🔴 弱于大盘 —— ${board}，持续跑输指数，资金流出明显。即使个股出现底部信号也需打折扣，拉大买入间距。`; }

  return { signal, resultText, board, benchmarkName: benchmark.info.name, rs10, rs20, rs60,
    sVolTrend: parseFloat(sVolTrend.toFixed(2)), bVolTrend: parseFloat(bVolTrend.toFixed(2)),
    details: details.join('\n'), bullish, bearish, net,
    dataDate: cs[idx].date };
}

// ==================== 微观：四维技术分析（修订版） ====================

function analyzeDivergence(candles) {
  if (candles.length < 30) return { signal: 'insufficient', resultText: '数据不足（需≥30日K线）' };
  let closes = candles.map(c => c.close).filter(v => v > 0);
  let macdData = calcMACDDataSeries(closes);
  let difArr = macdData.diff;
  let rsiArr = calcRSISeries(closes, 14);
  let lookback = Math.min(60, closes.length);
  let segCloses = closes.slice(-lookback);
  let segDifs = difArr.slice(-lookback);
  let segRSIs = rsiArr.slice(-lookback);
  let segment = candles.slice(-lookback);
  let lows = findLocalLows(segCloses, 5);
  let macdDiv = false, rsiDiv = false, divDetail = '';
  if (lows.length >= 2) {
    let l1 = lows[lows.length - 1], l2 = lows[lows.length - 2];
    let p1 = segCloses[l1], p2 = segCloses[l2];
    let d1 = segDifs[l1] || 0, d2 = segDifs[l2] || 0;
    let r1 = segRSIs[l1] || 50, r2 = segRSIs[l2] || 50;
    if (p1 < p2) {
      if (d1 > d2) macdDiv = true;
      if (r1 > r2) rsiDiv = true;
    }
    divDetail = `低点1: ${segment[l1].date} 收 ${p1.toFixed(2)} DIF ${d1.toFixed(4)} RSI ${r1.toFixed(1)} | 低点2: ${segment[l2].date} 收 ${p2.toFixed(2)} DIF ${d2.toFixed(4)} RSI ${r2.toFixed(1)}`;
  }
  let signal, resultText, bullish = 0, bearish = 0;
  if (macdDiv && rsiDiv) { signal = 'strong_bullish'; resultText = '✅ MACD+RSI双背离 —— 下跌动能衰竭信号强烈'; bullish = 3; }
  else if (macdDiv) { signal = 'bullish'; resultText = '🟢 MACD底背离 —— 下跌动能正在减弱'; bullish = 2; }
  else if (rsiDiv) { signal = 'mild_bullish'; resultText = '🟡 RSI底背离 —— 有企稳迹象但需MACD确认'; bullish = 1; }
  else { signal = 'none'; resultText = '🔴 未出现底背离 —— 下跌动能尚未明确衰竭'; bearish = 1; }
  return { signal, resultText, macdDivergence: macdDiv, rsiDivergence: rsiDiv, detail: divDetail,
    currentRSI: (rsiArr[rsiArr.length - 1] || 50), currentDIF: (difArr[difArr.length - 1] || 0),
    dataDate: candles[candles.length - 1].date, bullish, bearish };
}

function analyzeSupport(dailyCandles, weeklyCandles, currentPrice) {
  if (dailyCandles.length < 30) return { signal: 'insufficient', resultText: '数据不足' };
  let closes = dailyCandles.map(c => c.close).filter(v => v > 0);
  let highs = dailyCandles.map(c => c.high).filter(v => v > 0);
  let lows = dailyCandles.map(c => c.low).filter(v => v > 0);
  let lookback = Math.min(120, dailyCandles.length);
  let segH = highs.slice(-lookback), segL = lows.slice(-lookback);
  let segC = dailyCandles.slice(-lookback);
  let hIdx = segH.indexOf(Math.max(...segH));
  let lIdx = segL.indexOf(Math.min(...segL));
  let swingHigh, swingLow, shDate, slDate;
  if (hIdx < lIdx) { swingHigh = segH[hIdx]; swingLow = segL[lIdx]; shDate = segC[hIdx]?.date; slDate = segC[lIdx]?.date; }
  else { swingHigh = segH[hIdx]; swingLow = segL[lIdx]; shDate = segC[hIdx]?.date; slDate = segC[lIdx]?.date; }
  let range = swingHigh - swingLow;
  let fibLevels = {}, fibTable = [];
  if (range > 0) {
    [0.236, 0.382, 0.5, 0.618].forEach(ratio => {
      let p = swingHigh - range * ratio;
      let key = 'fib' + String(ratio).replace('.', '');
      fibLevels[key] = parseFloat(p.toFixed(2));
      fibTable.push({ label: (ratio * 100).toFixed(1) + '%', price: parseFloat(p.toFixed(2)), dist: parseFloat((currentPrice - p).toFixed(2)) });
    });
    fibLevels.swingHigh = parseFloat(swingHigh.toFixed(2));
    fibLevels.swingLow = parseFloat(swingLow.toFixed(2));
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
  if (nearestFib && nearestFib.dist < 0 && Math.abs(nearestFib.dist) / currentPrice < 0.05) {
    signal = 'strong_support'; resultText = `✅ 紧贴斐波那契 ${nearestFib.label}(${nearestFib.price}) 支撑 | 距现价 ${nearestFib.dist}`; bullish = 3;
  } else if (nearestFib && nearestFib.dist > 0 && nearestFib.dist / currentPrice < 0.08) {
    signal = 'approaching'; resultText = `🟡 接近斐波那契 ${nearestFib.label}(${nearestFib.price}) | 距支撑 ${nearestFib.dist.toFixed(2)} (${(nearestFib.dist/currentPrice*100).toFixed(1)}%)`; bullish = 1;
  } else {
    signal = 'far'; resultText = `🔴 距主要支撑位较远，等待回落`; bearish = 2;
  }
  let denseStr = denseZones.slice(0, 3).map(z => `${z.low}-${z.high}(横盘${z.weeks}周)`).join(' | ');
  return { signal, resultText, fibLevels, fibTable, denseZones, denseStr,
    weeklyRange: weeklyCandles.length ? `${weeklyCandles[0].date}~${weeklyCandles[weeklyCandles.length-1].date}` : '--',
    dailyDataDate: dailyCandles[dailyCandles.length - 1].date, bullish, bearish };
}

function analyzeDowntrend(candles) {
  if (candles.length < 30) return { signal: 'insufficient', resultText: '数据不足' };
  let closes = candles.map(c => c.close).filter(v => v > 0);
  let idx = candles.length - 1;
  function slope(data, p) { if (data.length < p * 2) return 0; let r = safeAvg(data.slice(-p)), o = safeAvg(data.slice(-p * 2, -p)); return o ? ((r - o) / o * 100) / p : 0; }
  let s10 = slope(closes, 10), s20 = slope(closes, 20);
  function segSlope(d, start, p) { let seg = d.slice(start, start + p), old = d.slice(start - p, start); let sr = safeAvg(seg), so = safeAvg(old); return so ? ((sr - so) / so * 100) / p : 0; }
  let sOld = segSlope(closes, idx - 15, 10), sRecent = segSlope(closes, idx - 5, 10);
  let flattening = sRecent < 0 && sOld < 0 && Math.abs(sRecent) < Math.abs(sOld) * 0.7;
  let db = detectDoubleBottom(candles.slice(-60));
  let tl = calcDowntrendLine(candles);
  let signal, resultText, bullish = 0, bearish = 0;
  if (s10 > 0) { signal = 'stabilizing'; resultText = '🟢 短期企稳 —— 均线斜率转正'; bullish = 3; }
  else if (flattening) { signal = 'flattening'; resultText = '🟡 跌速放缓 —— 急跌→缓跌转换中，空方衰减'; bullish = 2; }
  else if (Math.abs(s10) < 0.3) { signal = 'mild_decline'; resultText = '🟡 温和下跌 —— 斜率较平缓'; bullish = 1; }
  else { signal = 'steep_decline'; resultText = '🔴 急跌 —— 斜率陡峭，不宜接飞刀'; bearish = 3; }
  let ddStr = ''; if (db.found) ddStr = `双底: 左${db.leftDate} ${db.leftPrice} → 右${db.rightDate} ${db.rightPrice} ${db.rightHigher ? '(右底高于左底✅)' : ''}`;
  let tlStr = ''; if (tl.valid) tlStr = `下降趋势线: ${tl.startDate}起, 突破价≈${tl.breakPrice}`;
  return { signal, resultText, slope10: parseFloat(s10.toFixed(2)), slope20: parseFloat(s20.toFixed(2)),
    slopeFlattening: flattening, doubleBottom: db, trendline: tl,
    detail: [ddStr, tlStr].filter(Boolean).join('\n'),
    dataDate: candles[idx].date, bullish, bearish };
}

function analyzeVolumePrice(candles) {
  if (candles.length < 20) return { signal: 'insufficient', resultText: '数据不足' };
  let idx = candles.length - 1;
  let recent10 = candles.slice(-10);
  let redVol = 0, greenVol = 0, redDays = 0, greenDays = 0;
  for (let c of recent10) {
    let v = safeNum(c.volume, 0);
    if (c.close >= c.open) { redVol += v; redDays++; }
    else { greenVol += v; greenDays++; }
  }
  let totalVol = redVol + greenVol;
  let redRatio = totalVol ? parseFloat((redVol / totalVol * 100).toFixed(1)) : 50;

  let volumes = candles.map(c => safeNum(c.volume, 0));
  let volMA5 = safeAvg(volumes.slice(-5));
  let volMA20 = safeAvg(volumes.slice(-20));
  let volRatio = volMA20 > 0 ? parseFloat((volMA5 / volMA20).toFixed(2)) : 1;
  let volTrend = volRatio > 1.2 ? '放量' : volRatio < 0.7 ? '缩量' : '持平';

  let avgRecent5 = safeAvg(volumes.slice(-5));
  let avgPrev5 = safeAvg(volumes.slice(-10, -5));
  let volChange = avgPrev5 > 0 ? parseFloat((pct(avgRecent5, avgPrev5)).toFixed(1)) : 0;

  // 恐慌放量检测
  let panicDay = null;
  for (let i = recent10.length - 1; i >= 0; i--) {
    let c = recent10[i];
    let prevClose = i > 0 ? recent10[i - 1].close : (candles[idx - 10 + i - 1]?.close || c.open);
    let drop = pct(c.close, prevClose);
    if (safeNum(c.volume) > avgPrev5 * 2 && drop < -3) {
      panicDay = { date: c.date, drop: parseFloat(drop.toFixed(2)), vol: safeNum(c.volume) }; break;
    }
  }
  let redFat = redRatio >= 55 && redDays >= greenDays;
  let priceChg10 = recent10.length > 1 ? pct(recent10[recent10.length - 1].close, recent10[0].close) : 0;

  let details = [];
  details.push(`近10日 阳量占比: ${redRatio}% (阳${redDays}/阴${greenDays}) | 量能比(5/20MA): ${volRatio} | ${volTrend}`);
  details.push(`近5日vs前5日均量变化: ${volChange > 0 ? '+' : ''}${volChange}%`);
  if (redFat) details.push('🟢 红肥绿瘦 → 买盘积蓄,卖盘衰竭');
  if (panicDay) details.push(`⚠️ 恐慌放量: ${panicDay.date} 跌${panicDay.drop}% 量异常放大`);

  let signal, resultText, bullish = 0, bearish = 0;
  if (redFat && volTrend === '缩量' && priceChg10 < 0) { signal = 'accumulation'; resultText = '🟢 红肥绿瘦+缩量下跌 —— 底部吸筹特征'; bullish = 3; }
  else if (panicDay && redFat) { signal = 'panic_cleared'; resultText = '🟢 恐慌释放后红肥绿瘦 —— 卖压集中释放,多头承接'; bullish = 2; }
  else if (volTrend === '放量' && priceChg10 < -5) { signal = 'panic_selling'; resultText = '🔴 放量急跌 —— 卖压仍强,等待缩量'; bearish = 3; }
  else if (volTrend === '缩量' && priceChg10 < 0) { signal = 'grinding_down'; resultText = '🟡 缩量阴跌 —— 买盘不足,底部可能较远'; bearish = 2; }
  else if (redFat) { signal = 'mild_bullish'; resultText = '🟡 量价中性偏多'; bullish = 1; }
  else { signal = 'neutral'; resultText = '🟡 量价中性'; }
  return { signal, resultText, redRatio, redDays, greenDays, volRatio, volTrend, volChange,
    panicDay, redFatGreenThin: redFat, details: details.join('\n'),
    dataDate: candles[idx].date, bullish, bearish };
}

// ==================== 综合共振决策 ====================

function generateResonanceDecision(macro, meso, micro, stock, quote) {
  let buyPrice = stock.buy_price || 0;
  let currentPrice = quote ? quote.last_px : 0;

  // 汇总三维信号
  let levels = [
    { dim: '宏观(大盘)', signal: macro.signal, resultText: macro.resultText, bullish: macro.bullish, bearish: macro.bearish },
    { dim: '中观(板块)', signal: meso.signal, resultText: meso.resultText, bullish: meso.bullish || 0, bearish: meso.bearish || 0 },
    { dim: '微观(个股)', signal: micro.signal, resultText: micro.resultText, bullish: micro.bullish || 0, bearish: micro.bearish || 0 },
  ];

  let totalBullish = levels.reduce((a, l) => a + l.bullish, 0);
  let totalBearish = levels.reduce((a, l) => a + l.bearish, 0);
  let netScore = totalBullish - totalBearish;
  let greenCount = levels.filter(l => l.signal === 'green' || l.signal === 'strong_bullish' || l.signal === 'bullish' || l.signal === 'strong_support' || l.signal === 'stabilizing' || l.signal === 'accumulation' || l.signal === 'panic_cleared').length;
  let redCount = levels.filter(l => l.signal === 'red' || l.signal === 'steep_decline' || l.signal === 'panic_selling' || l.signal === 'far').length;

  let overallSignal, suggestion, suggestionDetail, positionAdvice;
  if (greenCount >= 2 && netScore >= 6) {
    overallSignal = 'green'; suggestion = '🟢 三顺共振 —— 可积极买入';
    suggestionDetail = `宏观向好+中观领先+微观底部确认，三维共振最强信号。可将买入动作提前，右侧放量突破即可加仓。`;
    positionAdvice = macro.positionAdvice;
  } else if (greenCount >= 1 && netScore >= 2) {
    overallSignal = 'yellow'; suggestion = '🟡 信号分化 —— 按计划分批执行';
    suggestionDetail = `部分维度偏多但未全维度共振。建议维持原定分批买入计划，不加急、不放缓。`;
    positionAdvice = macro.positionAdvice;
  } else {
    overallSignal = 'red'; suggestion = '🔴 多维度偏空 —— 暂停买入，等待更好时机';
    suggestionDetail = `宏观+中观+微观多个维度发出谨慎信号。建议拉大买入间距(如跌10%→15%)，降低单笔仓位，保留弹药。`;
    positionAdvice = macro.positionAdvice;
  }

  // 买入价调整
  let suggestedPrice = buyPrice;
  if (buyPrice > 0) {
    if (overallSignal === 'green') suggestedPrice = buyPrice * 1.05;
    else if (overallSignal === 'red') suggestedPrice = buyPrice * 0.92;
    // yellow: 维持不变
  }

  return { levels, totalBullish, totalBearish, netScore, greenCount, redCount,
    overallSignal, suggestion, suggestionDetail, positionAdvice,
    originalBuyPrice: buyPrice, suggestedBuyPrice: parseFloat(suggestedPrice.toFixed(2)), currentPrice };
}

// ==================== 微观四维综合 ====================

function analyzeMicroComprehensive(candles, weeklyCandles, quote) {
  let divergence = analyzeDivergence(candles);
  let support = analyzeSupport(candles, weeklyCandles, quote.last_px);
  let downtrend = analyzeDowntrend(candles);
  let volumePrice = analyzeVolumePrice(candles);
  let bullish = [divergence, support, downtrend, volumePrice].reduce((s, d) => s + (d.bullish || 0), 0);
  let bearish = [divergence, support, downtrend, volumePrice].reduce((s, d) => s + (d.bearish || 0), 0);
  let net = bullish - bearish;
  let signal, resultText;
  if (net >= 6) { signal = 'green'; resultText = '🟢 四维全偏多 —— 高胜率底部区域'; }
  else if (net >= 2) { signal = 'yellow'; resultText = '🟡 信号交织 —— 形势不明朗'; }
  else { signal = 'red'; resultText = '🔴 四维全偏空 —— 下跌趋势未确认反转'; }
  return { signal, resultText, divergence, support, downtrend, volumePrice, bullish, bearish, net,
    dataDate: candles[candles.length - 1].date };
}

// ==================== 主入口 ====================

async function runAnalysisAndRender(stock, quote) {
  let loadingEl = document.getElementById('analysis-loading');
  let resultEl = document.getElementById('analysis-result');
  let btnEl = document.getElementById('btn-analysis');
  if (loadingEl) loadingEl.style.display = 'block';
  if (resultEl) resultEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">三维共振分析中：获取大盘指数 → 板块对标 → 个股四维...请稍候</div>';
  if (btnEl) btnEl.style.display = 'none';

  try {
    // 并行获取：指数 + 个股日K + 个股周K
    let [indexData, dailyData, weeklyData] = await Promise.all([
      fetchIndexData(),
      fetchDailyRaw(stock.code, 120),
      fetchWeeklyRaw(stock.code, 120)
    ]);

    if (!dailyData.length) {
      if (resultEl) resultEl.innerHTML = '<span class="error-text">K线数据获取失败，请检查网络后重试</span>';
      if (loadingEl) loadingEl.style.display = 'none';
      if (btnEl) btnEl.style.display = 'inline-block';
      return;
    }

    // 三维分析
    let macro = analyzeMacro(indexData);
    let meso = analyzeMeso(stock, dailyData, indexData);
    let micro = analyzeMicroComprehensive(dailyData, weeklyData, quote);
    let resonance = generateResonanceDecision(macro, meso, micro, stock, quote);

    if (resultEl) resultEl.innerHTML = renderResonanceHTML(stock, quote, macro, meso, micro, resonance);
  } catch (e) {
    console.error('三维分析失败:', e);
    if (resultEl) resultEl.innerHTML = `<span class="error-text">分析失败: ${escapeHtml(e.message)}</span>`;
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
    if (btnEl) btnEl.style.display = 'inline-block';
  }
}

// ==================== 渲染 ====================

function renderResonanceHTML(stock, quote, macro, meso, micro, resonance) {
  // 微观子维度快捷引用
  let div = micro.divergence, sup = micro.support, dtr = micro.downtrend, vp = micro.volumePrice;
  let lvl = resonance.levels;

  // 决策灯
  let lightColor = resonance.overallSignal === 'green' ? '#10b981' : resonance.overallSignal === 'yellow' ? '#f59e0b' : '#ef4444';
  let lightEmoji = resonance.overallSignal === 'green' ? '🟢' : resonance.overallSignal === 'yellow' ? '🟡' : '🔴';

  return `
<div class="resonance-card">
  <h4 style="margin:0 0 4px;font-size:17px;">📋 ${escapeHtml(stock.name)} 三维共振分析</h4>
  <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">
    数据日期: ${macro.dataDate} | 现价: ${quote.last_px.toFixed(2)} | 原定买入价: ${resonance.originalBuyPrice.toFixed(2)}
  </div>

  <!-- 三维信号灯条 -->
  <div class="traffic-bar" style="background:var(--bg-input);border-radius:8px;padding:10px 14px;margin-bottom:12px;">
    <div class="traffic-row" style="display:flex;justify-content:space-around;text-align:center;gap:8px;">
      ${lvl.map(l => {
        let e = l.signal === 'green' || l.signal === 'strong_bullish' || l.signal === 'bullish' || l.signal === 'strong_support' || l.signal === 'stabilizing' || l.signal === 'accumulation' || l.signal === 'panic_cleared' ? '🟢'
          : (l.signal === 'red' || l.signal === 'steep_decline' || l.signal === 'panic_selling' || l.signal === 'far' ? '🔴' : '🟡');
        return `<div style="flex:1;min-width:0"><div style="font-size:24px;">${e}</div><div style="font-size:10px;font-weight:600;">${l.dim}</div><div style="font-size:10px;color:var(--text-muted);line-height:1.3;">${l.resultText.length > 30 ? l.resultText.slice(0,30)+'...' : l.resultText}</div></div>`;
      }).join('')}
    </div>
  </div>

  <!-- 综合决策卡片 -->
  <div class="decision-card" style="background:${lightColor}15;border-radius:8px;padding:12px;margin-bottom:12px;border-left:3px solid ${lightColor};">
    <div style="font-size:15px;font-weight:700;margin-bottom:4px;">${resonance.suggestion}</div>
    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">${resonance.suggestionDetail}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">${resonance.positionAdvice}</div>
    <div style="display:flex;gap:16px;font-size:12px;flex-wrap:wrap;">
      <span>📌 原买入价: <strong>${resonance.originalBuyPrice.toFixed(2)}</strong></span>
      <span>🎯 建议: <strong>${resonance.suggestedBuyPrice.toFixed(2)}</strong></span>
      <span>📊 偏多 ${resonance.totalBullish} vs 偏空 ${resonance.totalBearish} (净${resonance.netScore})</span>
    </div>
  </div>

  <!-- 维度一：宏观 -->
  <details class="resonance-dim" open>
    <summary class="dim-summary"><span style="font-size:16px;margin-right:4px;">${resonance.levels[0] && (resonance.levels[0].signal === 'green' ? '🟢' : resonance.levels[0].signal === 'red' ? '🔴' : '🟡')}</span> <strong>宏观 · 大盘定仓位</strong> <span style="font-size:11px;color:var(--text-muted)">—— ${macro.resultText}</span></summary>
    <div class="dim-body">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">数据日: ${macro.dataDate} | 净分: ${macro.net}</div>
      <div class="dim-detail-text">${macro.details.replace(/\n/g, '<br>')}</div>
      <table class="res-table">
        <tr><th>指数</th><th>收盘</th><th>MA20</th><th>MA60</th><th>MA250</th><th>斜率(%/日)</th><th>量能</th><th>趋势</th></tr>
        ${macro.rows.map(r => `
          <tr>
            <td>${r.name}</td><td>${r.close}</td><td>${r.ma20} ${r.aboveMA20}</td><td>${r.ma60} ${r.aboveMA60}</td><td>${r.ma250} ${r.aboveMA250}</td>
            <td>${r.slope20}</td><td>${r.volRatio}(${r.volTrend})</td><td>${r.trendSignal}</td>
          </tr>`).join('')}
      </table>
      <div class="dim-note">📌 ${macro.positionAdvice}</div>
    </div>
  </details>

  <!-- 维度二：中观 -->
  <details class="resonance-dim">
    <summary class="dim-summary"><span style="font-size:16px;margin-right:4px;">${resonance.levels[1] && (resonance.levels[1].signal === 'green' ? '🟢' : resonance.levels[1].signal === 'red' ? '🔴' : '🟡')}</span> <strong>中观 · 板块定方向</strong> <span style="font-size:11px;color:var(--text-muted)">—— ${meso.resultText.length > 40 ? meso.resultText.slice(0,40)+'...' : meso.resultText}</span></summary>
    <div class="dim-body">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">数据日: ${meso.dataDate || '--'} | 所属板块: ${meso.board || '--'} | 净分: ${meso.net || 0}</div>
      <div class="dim-detail-text">${(meso.details || '').replace(/\n/g, '<br>')}</div>
      ${meso.rs20 !== null ? `
      <div style="font-size:12px;margin-top:4px;color:var(--text-secondary);">
        相对强度解读：${meso.rs20 > 3 ? '近20日显著强于大盘 → 🟢 资金流入，板块龙头效应明显' : meso.rs20 > 0 ? '近20日略强于大盘 → 🟡 有一定抗跌性，但优势不明显' : meso.rs20 > -3 ? '近20日略弱于大盘 → 🟡 需关注是否持续走弱' : '近20日显著弱于大盘 → 🔴 资金流出，磨底时间可能更长'}
      </div>` : ''}
      <div class="dim-note" style="margin-top:4px;">${meso.resultText}</div>
    </div>
  </details>

  <!-- 维度三：微观 -->
  <details class="resonance-dim">
    <summary class="dim-summary"><span style="font-size:16px;margin-right:4px;">${resonance.levels[2] && (resonance.levels[2].signal === 'green' ? '🟢' : resonance.levels[2].signal === 'red' ? '🔴' : '🟡')}</span> <strong>微观 · 个股定击球点</strong> <span style="font-size:11px;color:var(--text-muted)">—— ${micro.resultText}</span></summary>
    <div class="dim-body">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">数据日: ${micro.dataDate} | 四维净分: ${micro.net} (偏多${micro.bullish}/偏空${micro.bearish})</div>

      <!-- 子维度1: 底背离 -->
      <div class="micro-sub">
        <div class="micro-sub-header"><span class="signal-tag ${div.signal}">${div.signal === 'strong_bullish' ? '✅✅' : div.signal === 'bullish' ? '✅' : div.signal === 'mild_bullish' ? '🟡' : '🔴'}</span> 底背离</div>
        <div class="micro-sub-result">${div.resultText}</div>
        <div class="micro-sub-data">RSI(14): ${(div.currentRSI||50).toFixed(1)} | MACD DIF: ${(div.currentDIF||0).toFixed(4)} | ${div.dataDate}</div>
        ${div.detail ? `<div class="micro-sub-detail">${div.detail.replace(/\n/g, '<br>')}</div>` : ''}
      </div>

      <!-- 子维度2: 支撑位 -->
      <div class="micro-sub">
        <div class="micro-sub-header"><span class="signal-tag ${sup.signal}">${sup.signal === 'strong_support' ? '✅' : sup.signal === 'approaching' ? '🟡' : sup.signal === 'far' ? '🔴' : '🟡'}</span> 支撑位</div>
        <div class="micro-sub-result">${sup.resultText}</div>
        <div class="micro-sub-data">波段高: ${sup.fibLevels.shDate||'--'} ${sup.fibLevels.swingHigh||'--'} | 波段低: ${sup.fibLevels.slDate||'--'} ${sup.fibLevels.swingLow||'--'}</div>
        ${sup.fibTable.length ? `
        <table class="res-table" style="margin-top:4px;">
          <tr><th>斐波那契位</th><th>价格</th><th>距现价</th></tr>
          ${sup.fibTable.map(f => `<tr class="${f.label === '61.8%' ? 'fib-golden' : ''}"><td>${f.label}${f.label === '61.8%' ? ' 🥇' : ''}</td><td>${f.price}</td><td>${f.dist > 0 ? '+' : ''}${f.dist}</td></tr>`).join('')}
        </table>` : ''}
        ${sup.denseZones.length ? `<div class="micro-sub-detail">📌 历史成交密集区（周线 ${sup.weeklyRange}）: ${sup.denseStr}</div>` : ''}
      </div>

      <!-- 子维度3: 下跌结构 -->
      <div class="micro-sub">
        <div class="micro-sub-header"><span class="signal-tag ${dtr.signal}">${dtr.signal === 'stabilizing' ? '✅' : dtr.signal === 'flattening' ? '🟢' : dtr.signal === 'mild_decline' ? '🟡' : '🔴'}</span> 下跌结构</div>
        <div class="micro-sub-result">${dtr.resultText}</div>
        <div class="micro-sub-data">10日斜率: ${dtr.slope10}%/日 | 20日斜率: ${dtr.slope20}%/日 | ${dtr.dataDate}</div>
        ${dtr.detail ? `<div class="micro-sub-detail">${dtr.detail.replace(/\n/g, '<br>')}</div>` : ''}
      </div>

      <!-- 子维度4: 量价关系 -->
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
    <div class="decision-matrix">
      <div style="font-weight:700;margin-bottom:6px;">📊 综合决策矩阵</div>
      <table class="res-table">
        <tr><th>维度</th><th>状态</th><th>判断</th><th>行动</th></tr>
        ${resonance.levels.map(l => {
          let state = l.signal === 'green' || l.signal === 'strong_bullish' || l.signal === 'bullish' || l.signal === 'strong_support' || l.signal === 'stabilizing' || l.signal === 'accumulation' || l.signal === 'panic_cleared' ? '🟢 绿灯'
            : (l.signal === 'red' || l.signal === 'steep_decline' || l.signal === 'panic_selling' || l.signal === 'far' ? '🔴 红灯' : '🟡 黄灯');
          return `<tr><td>${l.dim}</td><td>${state}</td><td style="font-size:11px;">${l.resultText.length > 40 ? l.resultText.slice(0,40)+'...' : l.resultText}</td><td style="font-size:11px;">${l.signal === 'green' ? '可积极' : l.signal === 'red' ? '等待' : '按计划'}</td></tr>`;
        }).join('')}
        <tr style="font-weight:700;background:${lightColor}10;">
          <td>综合</td><td>${lightEmoji} ${resonance.overallSignal === 'green' ? '绿灯' : resonance.overallSignal === 'yellow' ? '黄灯' : '红灯'}</td>
          <td colspan="2">${resonance.suggestion}</td>
        </tr>
      </table>
    </div>
  </div>

  <div style="font-size:10px;color:var(--text-muted);margin-top:8px;text-align:center;">
    ⚠️ 以上基于历史K线数据的技术指标运算，不构成投资建议。数据来源：腾讯行情API。
  </div>
</div>`;
}

// ==================== 辅助：找局部低点 ====================
function findLocalLows(data, period) {
  let lows = [];
  for (let i = period; i < data.length - period; i++) {
    let isLow = true;
    for (let j = i - period; j <= i + period; j++) {
      if (j === i) continue;
      if (data[j] <= data[i]) { isLow = false; break; }
    }
    if (isLow) lows.push(i);
  }
  return lows;
}

// ==================== 辅助：RSI序列 ====================
function calcRSISeries(closes, period = 14) {
  if (closes.length < period + 1) return new Array(closes.length).fill(50);
  let gains = new Array(closes.length).fill(0), losses = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    let ch = closes[i] - closes[i - 1];
    if (ch > 0) gains[i] = ch; else if (ch < 0) losses[i] = Math.abs(ch);
  }
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

// 辅助：双底检测
function detectDoubleBottom(candles) {
  if (candles.length < 20) return { found: false };
  let lowVals = candles.map(c => c.low);
  let locLows = findLocalLows(lowVals, 3);
  if (locLows.length < 2) return { found: false };
  let l1 = locLows[locLows.length - 1], l2 = locLows[locLows.length - 2];
  if (Math.abs(l1 - l2) < 5) return { found: false };
  let lp1 = lowVals[l1], lp2 = lowVals[l2];
  let diffPct = pct(lp1, lp2);
  if (Math.abs(diffPct) > 5) return { found: false };
  return { found: true, leftDate: candles[l2].date, leftPrice: parseFloat(lp2.toFixed(2)),
    rightDate: candles[l1].date, rightPrice: parseFloat(lp1.toFixed(2)),
    rightHigher: lp1 > lp2, diffPct: parseFloat(diffPct.toFixed(1)) };
}

// 辅助：下降趋势线
function calcDowntrendLine(candles) {
  if (candles.length < 30) return { valid: false };
  let highs = candles.map(c => c.high);
  let lookback = Math.min(90, candles.length);
  let seg = candles.slice(-lookback), segH = highs.slice(-lookback);
  let maxIdx = segH.indexOf(Math.max(...segH));
  let startDate = seg[maxIdx].date, startHigh = segH[maxIdx];
  let s2 = -Infinity, s2Idx = -1;
  for (let i = maxIdx + 10; i < seg.length - 5; i++) {
    if (segH[i] > s2 && segH[i] < startHigh) { s2 = segH[i]; s2Idx = i; }
  }
  if (s2Idx < 0) return { valid: false, startDate };
  let slp = (startHigh - s2) / (maxIdx - s2Idx);
  let brk = startHigh + slp * (seg.length - 1 - maxIdx);
  return { valid: slp < 0, startDate, slope: parseFloat(slp.toFixed(4)), breakPrice: parseFloat(brk.toFixed(2)) };
}
