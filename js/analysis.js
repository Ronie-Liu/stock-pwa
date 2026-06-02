// ===== 四维技术分析引擎 =====
// 基于K线数据：底背离 / 支撑位 / 下跌结构 / 量价关系
// 输出买入价调整建议，所有数据标注日期和关键值

/**
 * 获取周线数据（用于斐波那契和历史密集区计算）
 */
async function fetchWeeklyKLine(code, count = 120) {
  let tcode = stdToTencent(code);
  let url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + tcode + ',week,,,' + count + ',qfq';
  try {
    let resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let json = await resp.json();
    let stockData = json.data && json.data[tcode];
    if (!stockData) throw new Error('无周线数据');
    let isBJ = tcode.startsWith('bj');
    let raw = isBJ ? (stockData.week || stockData.qfqweek) : (stockData.qfqweek || stockData.week);
    if (!raw || raw.length === 0) throw new Error('无周线数据');
    return raw.map(item => ({
      date: item[0],
      open: parseFloat(item[1]),
      close: parseFloat(item[2]),
      high: parseFloat(item[3]),
      low: parseFloat(item[4]),
      volume: parseFloat(item[5]) * 100
    }));
  } catch (e) {
    console.error('获取周线失败:', e.message);
    return [];
  }
}

// ==================== 维度一：底背离分析 ====================

function analyzeDivergence(candles) {
  if (candles.length < 30) return { signal: 'insufficient', text: '数据不足（需≥30日K线）' };

  let closes = candles.map(c => c.close);
  let highs = candles.map(c => c.high);

  // MACD 数据
  let macdData = calcMACDDataSeries(closes);
  let difArr = macdData.diff;

  // RSI(14) 数据
  let rsiArr = calcRSISeries(closes, 14);

  // 找最近两个价格低点（60日内）
  let lookback = Math.min(60, candles.length);
  let segment = candles.slice(-lookback);
  let segCloses = closes.slice(-lookback);
  let segDifs = difArr.slice(-lookback);
  let segRSIs = rsiArr.slice(-lookback);

  let lows = findLocalLows(segCloses, 5);
  let macdDivergence = false, rsiDivergence = false;
  let divDetail = '';

  if (lows.length >= 2) {
    // 取最近两个低点
    let low1 = lows[lows.length - 1]; // 最近的低点
    let low2 = lows[lows.length - 2]; // 上一个低点

    let price1 = segCloses[low1], price2 = segCloses[low2];
    let dif1 = segDifs[low1] || 0, dif2 = segDifs[low2] || 0;
    let rsi1 = segRSIs[low1] || 50, rsi2 = segRSIs[low2] || 50;

    // 底背离：价格创新低，但MACD DIF 或 RSI 抬高
    if (price1 < price2) {
      if (dif1 > dif2) {
        macdDivergence = true;
      }
      if (rsi1 > rsi2) {
        rsiDivergence = true;
      }
    }

    let date1 = segment[low1].date, date2 = segment[low2].date;
    divDetail =
      `📌 低点1: ${date1} 收盘 ${price1.toFixed(2)} → MACD DIF ${(dif1||0).toFixed(4)} RSI ${(rsi1||50).toFixed(1)}\n` +
      `📌 低点2: ${date2} 收盘 ${price2.toFixed(2)} → MACD DIF ${(dif2||0).toFixed(4)} RSI ${(rsi2||50).toFixed(1)}`;
  }

  let signal, resultText;
  if (macdDivergence && rsiDivergence) {
    signal = 'strong_bullish';
    resultText = '✅ MACD + RSI 双重底背离 —— 下跌动能衰竭信号强烈';
  } else if (macdDivergence) {
    signal = 'bullish';
    resultText = '🟢 MACD 底背离 —— 下跌动能正在减弱';
  } else if (rsiDivergence) {
    signal = 'mild_bullish';
    resultText = '🟡 RSI 底背离 —— 有企稳迹象但需MACD确认';
  } else {
    signal = 'none';
    resultText = '🔴 未出现底背离 —— 下跌动能尚未明确衰竭';
  }

  return {
    signal,
    resultText,
    macdDivergence,
    rsiDivergence,
    detail: divDetail,
    currentRSI: rsiArr[rsiArr.length - 1],
    currentDIF: difArr[difArr.length - 1],
    dataDate: candles[candles.length - 1].date
  };
}

// 找局部低点（至少相隔 period 根K线的低点）
function findLocalLows(data, period = 5) {
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

// RSI序列计算
function calcRSISeries(closes, period = 14) {
  if (closes.length < period + 1) return new Array(closes.length).fill(50);
  let gains = new Array(closes.length).fill(0);
  let losses = new Array(closes.length).fill(0);
  for (let i = 1; i < closes.length; i++) {
    let ch = closes[i] - closes[i - 1];
    if (ch > 0) gains[i] = ch; else if (ch < 0) losses[i] = Math.abs(ch);
  }
  let rsiArr = new Array(closes.length).fill(null);
  let avgGain = gains.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  rsiArr[period] = avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1));
  for (let i = period + 1; i < closes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    rsiArr[i] = avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1));
  }
  return rsiArr;
}

// ==================== 维度二：支撑位分析 ====================

function analyzeSupport(dailyCandles, weeklyCandles, currentPrice) {
  if (dailyCandles.length < 30) return { signal: 'insufficient', text: '数据不足' };

  // ---- 斐波那契回调 ----
  let closes = dailyCandles.map(c => c.close);
  let highs = dailyCandles.map(c => c.high);
  let lows = dailyCandles.map(c => c.low);
  let lookback = Math.min(120, dailyCandles.length);
  let segHighs = highs.slice(-lookback);
  let segLows = lows.slice(-lookback);
  let segCloses = closes.slice(-lookback);
  let segCandles = dailyCandles.slice(-lookback);

  let highIdx = segHighs.indexOf(Math.max(...segHighs));
  let lowIdx = segLows.indexOf(Math.min(...segLows));
  // 确保高点在低点之前（下跌趋势）
  let swingHigh, swingLow, swingHighDate, swingLowDate;
  if (highIdx < lowIdx) {
    swingHigh = segHighs[highIdx];
    swingLow = segLows[lowIdx];
    swingHighDate = segCandles[highIdx].date;
    swingLowDate = segCandles[lowIdx].date;
  } else {
    // 高点在低点之后 = 上涨趋势，用整个区间的极值
    swingHigh = segHighs[highIdx];
    swingLow = segLows[lowIdx];
    swingHighDate = segCandles[highIdx].date;
    swingLowDate = segCandles[lowIdx].date;
  }

  let range = swingHigh - swingLow;
  let fibLevels = {};
  if (range > 0) {
    let fib238 = swingHigh - range * 0.236;
    let fib382 = swingHigh - range * 0.382;
    let fib500 = swingHigh - range * 0.500;
    let fib618 = swingHigh - range * 0.618;

    fibLevels = {
      swingHigh: { date: swingHighDate, price: parseFloat(swingHigh.toFixed(2)) },
      swingLow: { date: swingLowDate, price: parseFloat(swingLow.toFixed(2)) },
      fib238: parseFloat(fib238.toFixed(2)),
      fib382: parseFloat(fib382.toFixed(2)),
      fib500: parseFloat(fib500.toFixed(2)),
      fib618: parseFloat(fib618.toFixed(2)),
      currentPrice: parseFloat(currentPrice.toFixed(2))
    };

    // 当前价在哪个区间
    let nearestFib, nearestDist;
    let levels = [
      { label: '23.6%', price: fib238 },
      { label: '38.2%', price: fib382 },
      { label: '50.0%', price: fib500 },
      { label: '61.8%', price: fib618 }
    ];
    for (let l of levels) {
      let dist = currentPrice - l.price;
      if (nearestFib === undefined || Math.abs(dist) < Math.abs(nearestDist)) {
        nearestFib = l.label;
        nearestDist = dist;
      }
    }
    fibLevels.nearestFib = nearestFib;
    fibLevels.nearestDist = parseFloat(nearestDist.toFixed(2));
  }

  // ---- 历史成交密集区（用周线） ----
  let denseZones = [];
  if (weeklyCandles.length >= 20) {
    // 将价格分成多段，找横盘最久的区间
    let wCloses = weeklyCandles.map(c => c.close);
    let minP = Math.min(...wCloses), maxP = Math.max(...wCloses);
    let zoneCount = 20;
    let zoneSize = (maxP - minP) / zoneCount;
    let zones = [];
    for (let i = 0; i < zoneCount; i++) {
      let zLow = minP + i * zoneSize;
      let zHigh = zLow + zoneSize;
      let weeksInZone = weeklyCandles.filter(c => c.close >= zLow && c.close <= zHigh).length;
      if (weeksInZone >= 3) {
        zones.push({ low: parseFloat(zLow.toFixed(2)), high: parseFloat(zHigh.toFixed(2)), weeks: weeksInZone });
      }
    }
    zones.sort((a, b) => b.weeks - a.weeks);
    denseZones = zones.slice(0, 3);
  }

  // 综合判断
  let signal = 'neutral', resultText = '';
  if (fibLevels.nearestDist < 0) {
    // 当前价低于最近斐波那契位
    let distPct = Math.abs(fibLevels.nearestDist / fibLevels.fib618 * 100);
    if (distPct < 3) {
      resultText = `✅ 当前价 ${currentPrice.toFixed(2)} 紧贴斐波那契 ${fibLevels.nearestFib} (${fibLevels[fibLevels.nearestFib.toLowerCase().replace('.','').replace('%','')] || fibLevels.fib618}) 支撑位，下方空间有限`;
      signal = 'strong_support';
    } else {
      resultText = `🟡 当前价 ${currentPrice.toFixed(2)} 低于斐波那契 ${fibLevels.nearestFib} 支撑，需关注是否有效跌破`;
      signal = 'weak_support';
    }
  } else if (fibLevels.nearestDist > 0) {
    let distPct = fibLevels.nearestDist / currentPrice * 100;
    if (distPct < 5) {
      resultText = `🟡 距最近斐波那契支撑 (${fibLevels.nearestFib}) 还有 ${fibLevels.nearestDist.toFixed(2)} (${distPct.toFixed(1)}%)，可能继续下探`;
      signal = 'approaching';
    } else {
      resultText = `🔴 距支撑位较远 (${distPct.toFixed(1)}%)，等待回落至支撑区再评估`;
      signal = 'far';
    }
  }

  let denseStr = denseZones.map(z => `💰 ${z.low}-${z.high} (横盘${z.weeks}周)`).join('\n');

  return {
    signal,
    resultText,
    fibLevels,
    denseZones,
    denseStr,
    weeklyDataRange: weeklyCandles.length > 0 ?
      `${weeklyCandles[0].date} ~ ${weeklyCandles[weeklyCandles.length-1].date}` : '无周线数据',
    dailyDataDate: dailyCandles[dailyCandles.length - 1].date
  };
}

// ==================== 维度三：下跌结构分析 ====================

function analyzeDowntrend(candles) {
  if (candles.length < 30) return { signal: 'insufficient', text: '数据不足' };

  let closes = candles.map(c => c.close);
  let idx = candles.length - 1;

  // 计算不同周期斜率
  let slope10 = calcSlope(closes, 10);
  let slope20 = calcSlope(closes, 20);
  let slope60 = calcSlope(closes, 60);

  // 近期斜率变化
  let slope5_10daysAgo = calcSlopeSegment(closes, idx - 15, 10);
  let slope5_recent = calcSlopeSegment(closes, idx - 5, 10);
  let slopeFlattening = false;
  if (slope5_recent < 0 && slope5_10daysAgo < 0) {
    // 同为下跌，但近期斜率更平缓 = 缓跌
    if (Math.abs(slope5_recent) < Math.abs(slope5_10daysAgo) * 0.7) {
      slopeFlattening = true;
    }
  }

  // 二次探底检测
  let doubleBottom = detectDoubleBottom(candles.slice(-60));

  // 下降趋势线
  let trendline = calcDowntrendLine(candles);

  let signal, resultText, details = [];

  // 斜率解读
  if (slope10 < -0.5 && slope20 < -0.3) {
    details.push(`📉 下跌斜率: 10日 ${slope10.toFixed(2)}%/日, 20日 ${slope20.toFixed(2)}%/日 → 处于急跌阶段`);
    signal = 'steep_decline';
  } else if (slope10 < 0 && Math.abs(slope10) < 0.3) {
    if (slopeFlattening) {
      details.push(`📊 下跌斜率: 10日 ${slope10.toFixed(2)}%/日 → 跌速放缓，急跌→缓跌转换中`);
      signal = 'flattening';
    } else {
      details.push(`📊 下跌斜率: 10日 ${slope10.toFixed(2)}%/日 → 温和下跌`);
      signal = 'mild_decline';
    }
  } else if (slope10 > 0) {
    details.push(`📈 10日均价: 已转涨 ${slope10.toFixed(2)}%/日 → 短期企稳`);
    signal = 'stabilizing';
  }

  // 双底解读
  if (doubleBottom.found) {
    details.push(`🔄 双底雏形: 左底 ${doubleBottom.leftDate} ${doubleBottom.leftPrice.toFixed(2)} / 右底 ${doubleBottom.rightDate} ${doubleBottom.rightPrice.toFixed(2)} (差幅 ${Math.abs(doubleBottom.diffPct).toFixed(1)}%)`);
    if (doubleBottom.rightHigher) {
      details.push('   ↳ 右底高于左底 → 二次探底未创新低，底部确认概率 ↑');
    }
  }

  // 趋势线
  if (trendline.valid) {
    details.push(`🔽 下降趋势线: ${trendline.startDate}~今, 突破价 ≈ ${trendline.breakPrice ? trendline.breakPrice.toFixed(2) : '--'}`);
  }

  switch (signal) {
    case 'steep_decline':
      resultText = '🔴 急跌阶段 —— 下跌斜率陡峭，动能充沛，不宜提前接飞刀。等待斜率放缓再评估';
      break;
    case 'flattening':
      resultText = '🟡 跌速放缓 —— 从急跌转为缓跌，空方力量衰减中。可开始关注，但需确认底部结构';
      break;
    case 'mild_decline':
      resultText = '🟡 温和下跌 —— 处于下降通道但已有减速迹象';
      break;
    case 'stabilizing':
      resultText = '🟢 短期企稳 —— 均线斜率转正，可能已进入底部区域';
      break;
    default:
      resultText = '🔴 急跌阶段';
      signal = 'steep_decline';
  }

  return {
    signal,
    resultText,
    slope10: parseFloat(slope10.toFixed(2)),
    slope20: parseFloat(slope20.toFixed(2)),
    slope60: parseFloat(slope60.toFixed(2)),
    slopeFlattening,
    doubleBottom,
    trendline,
    details: details.join('\n'),
    dataDate: candles[idx].date
  };
}

function calcSlope(data, period) {
  if (data.length < period) return 0;
  let recent = data.slice(-period);
  let avgRecent = recent.reduce((a, b) => a + b, 0) / period;
  let old = data.slice(-period * 2, -period);
  let avgOld = old.reduce((a, b) => a + b, 0) / period;
  if (avgOld === 0) return 0;
  return ((avgRecent - avgOld) / avgOld * 100) / period;
}

function calcSlopeSegment(data, startIdx, period) {
  let seg = data.slice(startIdx, startIdx + period);
  if (seg.length < period) return 0;
  let avgRecent = seg.reduce((a, b) => a + b, 0) / period;
  let old = data.slice(startIdx - period, startIdx);
  let avgOld = old.reduce((a, b) => a + b, 0) / period;
  if (avgOld === 0) return 0;
  return ((avgRecent - avgOld) / avgOld * 100) / period;
}

function detectDoubleBottom(candles) {
  if (candles.length < 20) return { found: false };
  let lows = candles.map(c => c.low);
  let localLows = findLocalLows(lows, 3);
  if (localLows.length < 2) return { found: false };
  // 最近两个低点
  l1 = localLows[localLows.length - 1];
  l2 = localLows[localLows.length - 2];
  if (Math.abs(l1 - l2) < 5) return { found: false }; // 太近
  let lp1 = lows[l1], lp2 = lows[l2];
  let diffPct = (lp1 - lp2) / lp2 * 100;
  if (Math.abs(diffPct) > 5) return { found: false }; // 差距太大
  return {
    found: true,
    leftDate: candles[l2].date, leftPrice: parseFloat(lp2.toFixed(2)),
    rightDate: candles[l1].date, rightPrice: parseFloat(lp1.toFixed(2)),
    rightHigher: lp1 > lp2,
    diffPct: parseFloat(diffPct.toFixed(1))
  };
}

function calcDowntrendLine(candles) {
  if (candles.length < 30) return { valid: false };
  let highs = candles.map(c => c.high);
  let lookback = Math.min(90, candles.length);
  let seg = candles.slice(-lookback);
  let segHighs = highs.slice(-lookback);
  // 找阶段高点的最高点
  let maxHighIdx = segHighs.indexOf(Math.max(...segHighs));
  let startDate = seg[maxHighIdx].date;
  let startHigh = segHighs[maxHighIdx];
  // 找之后另一个显著高点
  let secondHigh = -Infinity, secondIdx = -1;
  for (let i = maxHighIdx + 10; i < seg.length - 5; i++) {
    if (segHighs[i] > secondHigh && segHighs[i] < startHigh) {
      secondHigh = segHighs[i];
      secondIdx = i;
    }
  }
  if (secondIdx < 0) return { valid: false, startDate };
  // 计算趋势线: y = slope * x + intercept
  let slope = (startHigh - secondHigh) / (maxHighIdx - secondIdx);
  let intercept = startHigh - slope * maxHighIdx;
  let lastIdx = seg.length - 1 + (candles.length - lookback);
  let breakPrice = slope * lastIdx + intercept;
  let valid = slope < 0; // 必须向下

  return { valid, startDate, slope: parseFloat(slope.toFixed(4)), breakPrice: parseFloat(breakPrice.toFixed(2)) };
}

// ==================== 维度四：量价关系分析 ====================

function analyzeVolumePrice(candles) {
  if (candles.length < 20) return { signal: 'insufficient', text: '数据不足' };

  let idx = candles.length - 1;

  // 近10日红绿比例
  let recent10 = candles.slice(-10);
  let redVol = 0, greenVol = 0, redDays = 0, greenDays = 0;
  for (let c of recent10) {
    if (c.close >= c.open) { redVol += c.volume; redDays++; }
    else { greenVol += c.volume; greenDays++; }
  }
  let totalVol = redVol + greenVol;
  let redRatio = totalVol > 0 ? (redVol / totalVol * 100) : 50;

  // 量能趋势（5日MA vs 20日MA）
  let volumes = candles.map(c => c.volume);
  let volMA5 = calcMA(volumes, 5);
  let volMA20 = calcMA(volumes, 20);
  let volRatio = volMA20 ? volMA5 / volMA20 : 1;
  let volTrend = volRatio > 1.2 ? '放量' : volRatio < 0.7 ? '缩量' : '持平';

  // 近5日换手率趋势（如果有数据）
  let volRecent5 = volumes.slice(-5);
  let volPrev5 = volumes.slice(-10, -5);
  let avgRecent = volRecent5.reduce((a, b) => a + b, 0) / 5;
  let avgPrev = volPrev5.reduce((a, b) => a + b, 0) / 5;
  let volChange = avgPrev > 0 ? ((avgRecent - avgPrev) / avgPrev * 100) : 0;

  // 恐慌放量检测（最近5日有无单日放量+大跌）
  let panicDay = null;
  for (let i = recent10.length - 1; i >= 0; i--) {
    let c = recent10[i];
    let prevClose = i > 0 ? recent10[i - 1].close : candles[idx - 10 + i - 1]?.close;
    if (prevClose && c.volume > avgPrev * 2 && (c.close - prevClose) / prevClose < -0.03) {
      panicDay = { date: c.date, drop: parseFloat(((c.close - prevClose) / prevClose * 100).toFixed(2)), vol: c.volume };
      break;
    }
  }

  // 红肥绿瘦判断
  let redFatGreenThin = redRatio >= 55 && redDays >= greenDays;

  // 量价背离（价跌量增 vs 价跌量缩）
  let priceChange10 = (recent10[recent10.length - 1].close - recent10[0].close) / recent10[0].close * 100;

  let signal, resultText, details = [];

  details.push(`📊 近10日 阳线量占比: ${redRatio.toFixed(1)}% (阳${redDays}日/阴${greenDays}日)`);
  details.push(`📊 量能比(MA5/MA20): ${volRatio.toFixed(2)} → ${volTrend}`);
  details.push(`📊 近5日vs前5日均量变化: ${volChange > 0 ? '+' : ''}${volChange.toFixed(1)}%`);

  if (redFatGreenThin) {
    details.push(`🟢 红肥绿瘦 → 买盘力量积蓄中，卖盘衰竭`);
  }

  if (panicDay) {
    details.push(`⚠️ 恐慌放量: ${panicDay.date} 跌幅 ${panicDay.drop}% 成交量异常放大 → 恐慌盘集中释放`);
  }

  // 综合解读
  if (redFatGreenThin && volTrend === '缩量' && priceChange10 < 0) {
    signal = 'accumulation';
    resultText = '🟢 红肥绿瘦 + 缩量下跌 —— 底部吸筹特征，主力在低位收集筹码';
  } else if (panicDay && redFatGreenThin) {
    signal = 'panic_cleared';
    resultText = '🟢 恐慌放量后出现红肥绿瘦 —— 卖压集中释放后多头开始承接，底部概率↑';
  } else if (volTrend === '放量' && priceChange10 < -5) {
    signal = 'panic_selling';
    resultText = '🔴 放量急跌 —— 卖压仍然强劲，等待缩量信号再评估';
  } else if (volTrend === '缩量' && priceChange10 < 0) {
    signal = 'grinding_down';
    resultText = '🟡 缩量阴跌 —— 买盘不足，卖盘也不大，底部可能较远。需耐心等待放量信号';
  } else if (redFatGreenThin) {
    signal = 'mild_bullish';
    resultText = '🟡 量价中性偏多 —— 红肥绿瘦但趋势还不明确';
  } else {
    signal = 'neutral';
    resultText = '🟡 量价中性 —— 无明显吸筹或出货迹象';
  }

  return {
    signal,
    resultText,
    redRatio: parseFloat(redRatio.toFixed(1)),
    redDays, greenDays,
    volRatio: parseFloat(volRatio.toFixed(2)),
    volTrend,
    volChange: parseFloat(volChange.toFixed(1)),
    panicDay,
    redFatGreenThin,
    details: details.join('\n'),
    dataDate: candles[idx].date
  };
}

// ==================== 综合建议引擎 ====================

function generateSuggestion(stock, quote, analysis) {
  let { divergence, support, downtrend, volumePrice } = analysis;
  let buyPrice = stock.buy_price || 0;
  let currentPrice = quote ? quote.last_px : 0;

  // 给每个信号打分
  let scores = { bullish: 0, bearish: 0 };

  // 底背离
  if (divergence.signal === 'strong_bullish') scores.bullish += 3;
  else if (divergence.signal === 'bullish') scores.bullish += 2;
  else if (divergence.signal === 'mild_bullish') scores.bullish += 1;
  else scores.bearish += 1;

  // 支撑位
  if (support.signal === 'strong_support') scores.bullish += 3;
  else if (support.signal === 'approaching') scores.bullish += 1;
  else if (support.signal === 'far') scores.bearish += 2;
  else if (support.signal === 'weak_support') scores.bearish += 1;

  // 下跌结构
  if (downtrend.signal === 'stabilizing') scores.bullish += 3;
  else if (downtrend.signal === 'flattening') scores.bullish += 2;
  else if (downtrend.signal === 'mild_decline') scores.bullish += 1;
  else if (downtrend.signal === 'steep_decline') scores.bearish += 3;

  // 量价关系
  if (volumePrice.signal === 'accumulation') scores.bullish += 3;
  else if (volumePrice.signal === 'panic_cleared') scores.bullish += 2;
  else if (volumePrice.signal === 'mild_bullish') scores.bullish += 1;
  else if (volumePrice.signal === 'panic_selling') scores.bearish += 3;
  else if (volumePrice.signal === 'grinding_down') scores.bearish += 2;

  let totalBullish = scores.bullish;
  let totalBearish = scores.bearish;
  let netScore = totalBullish - totalBearish;

  // 生成建议
  let suggestion, suggestionDetail, adjustment;

  if (netScore >= 6) {
    suggestion = '🟢 强烈建议上浮买入价';
    suggestionDetail = '四个维度全维度偏多，当前区域是高胜率买入区。即便现价略高于原定买入价，也可考虑适当上浮 3-8%。';
    adjustment = 'up_strong';
  } else if (netScore >= 3) {
    suggestion = '🟢 建议维持或小幅上浮';
    suggestionDetail = '多数维度偏多，当前价位已有较强支撑。可维持原买入价，若出现回踩确认可小幅上浮 2-5%。';
    adjustment = 'up_mild';
  } else if (netScore >= 0) {
    suggestion = '🟡 建议维持当前买入价';
    suggestionDetail = '多空信号交织，形势不明朗。维持机械式分批计划，不加不减，等待更多信号。';
    adjustment = 'hold';
  } else if (netScore >= -3) {
    suggestion = '🟡 建议小幅下移买入价';
    suggestionDetail = '空方信号略多，股价可能继续下探。考虑将买入价下移 3-8%，或拉大分批间隔。';
    adjustment = 'down_mild';
  } else {
    suggestion = '🔴 建议下移买入价或暂停买入';
    suggestionDetail = '四个维度全维度偏空，下跌趋势未确认反转。建议下移买入价 5-10% 或暂停等待放量企稳信号。';
    adjustment = 'down_strong';
  }

  // 建议的新买入价
  let suggestedPrice = buyPrice;
  if (buyPrice > 0) {
    if (adjustment === 'up_strong') suggestedPrice = buyPrice * 1.05;
    else if (adjustment === 'up_mild') suggestedPrice = buyPrice * 1.03;
    else if (adjustment === 'down_mild') suggestedPrice = buyPrice * 0.94;
    else if (adjustment === 'down_strong') suggestedPrice = buyPrice * 0.90;
  }

  return {
    netScore,
    totalBullish,
    totalBearish,
    suggestion,
    suggestionDetail,
    adjustment,
    originalBuyPrice: buyPrice,
    suggestedBuyPrice: parseFloat(suggestedPrice.toFixed(2)),
    currentPrice
  };
}

// ==================== 分析报告 HTML 渲染 ====================

async function runAnalysisAndRender(stock, quote) {
  let loadingEl = document.getElementById('analysis-loading');
  let resultEl = document.getElementById('analysis-result');
  let btnEl = document.getElementById('btn-analysis');

  if (loadingEl) loadingEl.style.display = 'block';
  if (resultEl) resultEl.innerHTML = '';
  if (btnEl) btnEl.style.display = 'none';

  try {
    // 获取日线+周线
    let dailyData = await fetchKLine(stock.code, 120);
    if (!dailyData || dailyData.candles.length < 30) {
      if (resultEl) resultEl.innerHTML = '<span class="error-text">K线数据不足（需≥30日），无法运行分析</span>';
      if (loadingEl) loadingEl.style.display = 'none';
      if (btnEl) btnEl.style.display = 'inline-block';
      return;
    }

    let weeklyData = await fetchWeeklyKLine(stock.code, 120);

    let candles = dailyData.candles;
    let weeklyCandles = weeklyData;

    // 四维分析
    let divergence = analyzeDivergence(candles);
    let support = analyzeSupport(candles, weeklyCandles, quote.last_px);
    let downtrend = analyzeDowntrend(candles);
    let volumePrice = analyzeVolumePrice(candles);

    let analysis = { divergence, support, downtrend, volumePrice };
    let suggestion = generateSuggestion(stock, quote, analysis);

    // 渲染 HTML
    let html = renderAnalysisHTML(stock, quote, analysis, suggestion);
    if (resultEl) resultEl.innerHTML = html;
  } catch (e) {
    console.error('分析失败:', e);
    if (resultEl) resultEl.innerHTML = `<span class="error-text">分析失败: ${escapeHtml(e.message)}</span>`;
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
    if (btnEl) btnEl.style.display = 'inline-block';
  }
}

function renderAnalysisHTML(stock, quote, analysis, suggestion) {
  let { divergence, support, downtrend, volumePrice } = analysis;

  return `
<div class="analysis-card">
  <h4 style="margin:0 0 4px 0;font-size:17px;">📋 ${escapeHtml(stock.name)} 四维技术分析</h4>
  <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">
    数据日期: ${divergence.dataDate} | 现价: ${quote.last_px.toFixed(2)} | 原定买入价: ${suggestion.originalBuyPrice.toFixed(2)}
  </div>

  <!-- 综合建议 -->
  <div style="background:var(--accent-bg, rgba(99,102,241,0.1));border-radius:8px;padding:12px;margin-bottom:12px;border-left:3px solid var(--accent);">
    <div style="font-size:15px;font-weight:700;margin-bottom:4px;">${suggestion.suggestion}</div>
    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:6px;">${suggestion.suggestionDetail}</div>
    <div style="display:flex;gap:16px;font-size:12px;">
      <span>📌 原买入价: <strong>${suggestion.originalBuyPrice.toFixed(2)}</strong></span>
      <span>🎯 建议调整至: <strong>${suggestion.suggestedBuyPrice.toFixed(2)}</strong></span>
      <span>📊 信号分: 偏多 ${suggestion.totalBullish} vs 偏空 ${suggestion.totalBearish} (净${suggestion.netScore})</span>
    </div>
  </div>

  <!-- 维度一: 底背离 -->
  <div class="analysis-dim">
    <div class="dim-header">🔍 维度一：底背离（下跌动能衰竭）</div>
    <div class="dim-result dim-${divergence.signal}">${divergence.resultText}</div>
    <div class="dim-data">
      <span>RSI(14): ${divergence.currentRSI?.toFixed(1) || '--'}</span>
      <span>MACD DIF: ${divergence.currentDIF?.toFixed(4) || '--'}</span>
      <span>数据日: ${divergence.dataDate}</span>
    </div>
    ${divergence.detail ? `<div class="dim-detail">${escapeHtml(divergence.detail).replace(/\n/g, '<br>')}</div>` : ''}
  </div>

  <!-- 维度二: 支撑位 -->
  <div class="analysis-dim">
    <div class="dim-header">📍 维度二：关键支撑位</div>
    <div class="dim-result dim-${support.signal}">${support.resultText}</div>
    <div class="dim-data">
      ${support.fibLevels.swingHigh ? `<span>波段高点: ${support.fibLevels.swingHigh.date} ${support.fibLevels.swingHigh.price}</span>` : ''}
      ${support.fibLevels.swingLow ? `<span>波段低点: ${support.fibLevels.swingLow.date} ${support.fibLevels.swingLow.price}</span>` : ''}
    </div>
    <table class="fib-table">
      <tr><th>斐波那契位</th><th>价格</th><th>距现价</th></tr>
      ${support.fibLevels.fib238 ? `<tr><td>23.6%</td><td>${support.fibLevels.fib238}</td><td>${(quote.last_px - support.fibLevels.fib238).toFixed(2)}</td></tr>` : ''}
      ${support.fibLevels.fib382 ? `<tr><td>38.2%</td><td>${support.fibLevels.fib382}</td><td>${(quote.last_px - support.fibLevels.fib382).toFixed(2)}</td></tr>` : ''}
      ${support.fibLevels.fib500 ? `<tr><td>50.0%</td><td>${support.fibLevels.fib500}</td><td>${(quote.last_px - support.fibLevels.fib500).toFixed(2)}</td></tr>` : ''}
      ${support.fibLevels.fib618 ? `<tr class="fib-key"><td>61.8% (黄金分割)</td><td>${support.fibLevels.fib618}</td><td>${(quote.last_px - support.fibLevels.fib618).toFixed(2)}</td></tr>` : ''}
    </table>
    ${support.denseZones.length > 0 ? `<div class="dim-detail">📌 历史成交密集区（周线 ${support.weeklyDataRange}）:<br>${support.denseStr.replace(/\n/g, '<br>')}</div>` : ''}
  </div>

  <!-- 维度三: 下跌结构 -->
  <div class="analysis-dim">
    <div class="dim-header">📐 维度三：下跌结构</div>
    <div class="dim-result dim-${downtrend.signal}">${downtrend.resultText}</div>
    <div class="dim-data">
      <span>10日均价斜率: ${downtrend.slope10}%/日</span>
      <span>20日均价斜率: ${downtrend.slope20}%/日</span>
      <span>数据日: ${downtrend.dataDate}</span>
    </div>
    ${downtrend.doubleBottom?.found ? `<div class="dim-detail">🔄 双底: 左${downtrend.doubleBottom.leftDate} ${downtrend.doubleBottom.leftPrice} → 右${downtrend.doubleBottom.rightDate} ${downtrend.doubleBottom.rightPrice}</div>` : ''}
    ${downtrend.trendline?.valid ? `<div class="dim-detail">📏 下降趋势线: ${downtrend.trendline.startDate}起，突破价约 ${downtrend.trendline.breakPrice}</div>` : ''}
  </div>

  <!-- 维度四: 量价关系 -->
  <div class="analysis-dim">
    <div class="dim-header">📊 维度四：量价关系</div>
    <div class="dim-result dim-${volumePrice.signal}">${volumePrice.resultText}</div>
    <div class="dim-data">
      <span>阳量占比: ${volumePrice.redRatio}%</span>
      <span>量能趋势: ${volumePrice.volTrend} (MA5/MA20=${volumePrice.volRatio})</span>
      <span>数据日: ${volumePrice.dataDate}</span>
    </div>
    <div class="dim-detail">${volumePrice.details.replace(/\n/g, '<br>')}</div>
  </div>

  <div style="font-size:10px;color:var(--text-muted);margin-top:8px;text-align:center;">
    ⚠️ 以上分析基于历史K线数据的技术指标，不构成投资建议。数据来源：腾讯行情API。
  </div>
</div>`;
}
