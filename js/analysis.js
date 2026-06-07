// ===== 三维共振技术分析引擎 v4 =====
// 宏观: 大盘+资金+市场 | 中观: 板块四阶段诊断+精选池 | 微观: 资金面+技术面四维
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
      date: item[0], open: parseFloat(item[1]), close: parseFloat(item[2]),
      high: parseFloat(item[3]), low: parseFloat(item[4]), volume: parseFloat(item[5]) || 0
    }));
  } catch (e) { console.log('K线获取失败:', tcode, e.message); return []; }
}

async function fetchDailyRaw(code, count = 120) {
  let digits = code.replace(/\D/g, ''), prefix = code.startsWith('60') || code.startsWith('68') || code.startsWith('900') ? 'sh' : code.startsWith('920') || code.startsWith('8') ? 'bj' : 'sz';
  return await fetchKLineRaw(prefix + digits, count, 'day');
}

async function fetchWeeklyRaw(code, count = 120) {
  let digits = code.replace(/\D/g, ''), prefix = code.startsWith('60') || code.startsWith('68') || code.startsWith('900') ? 'sh' : code.startsWith('920') || code.startsWith('8') ? 'bj' : 'sz';
  return await fetchKLineRaw(prefix + digits, count, 'week');
}

function calcBB(data, period = 20, mult = 2) {
  let ma = calcMASeriesS(data, period);
  let bb = { upper: new Array(data.length).fill(null), lower: new Array(data.length).fill(null), width: new Array(data.length).fill(null), pos: new Array(data.length).fill(null) };
  for (let i = period - 1; i < data.length; i++) {
    let seg = data.slice(i - period + 1, i + 1).filter(v => isFinite(v) && !isNaN(v));
    if (seg.length < 5) continue;
    let mean = seg.reduce((a,b)=>a+b,0)/seg.length;
    let variance = seg.reduce((a,b)=>a+(b-mean)*(b-mean),0)/seg.length;
    let std = Math.sqrt(variance);
    bb.upper[i] = parseFloat((mean + mult * std).toFixed(2));
    bb.lower[i] = parseFloat((mean - mult * std).toFixed(2));
    bb.width[i] = parseFloat(((bb.upper[i] - bb.lower[i]) / mean * 100).toFixed(1));
    bb.pos[i] = parseFloat(((data[i] - bb.lower[i]) / (bb.upper[i] - bb.lower[i]) * 100).toFixed(1));
  }
  return bb;
}

// ==================== 板块数据获取 ====================

async function fetchSectorBoards(code) {
  let prefix = code.startsWith('6') ? 'SH' : 'SZ';
  let fullCode = prefix + code.replace(/\D/g, '');
  let url = 'https://emweb.securities.eastmoney.com/PC_HSF10/CoreConception/PageAjax?code=' + fullCode;
  try {
    let resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let data = await resp.json();
    let ssbk = data.ssbk || [];
    let industries = [], concepts = [];
    for (let b of ssbk) {
      let entry = { name: b.BOARD_NAME, code: b.BOARD_CODE, rank: b.BOARD_RANK, isPrecise: b.IS_PRECISE };
      if (b.BOARD_CODE && parseInt(b.BOARD_CODE) >= 1000) {
        industries.push(entry);
      } else if (b.BOARD_CODE && parseInt(b.BOARD_CODE) >= 100) {
        concepts.push(entry);
      } else {
        if (b.IS_PRECISE === '1') concepts.push(entry);
        else industries.push(entry);
      }
    }
    industries.sort((a, b) => a.rank - b.rank);
    concepts.sort((a, b) => a.rank - b.rank);
    return { industries, concepts, all: ssbk };
  } catch (e) { console.log('板块查询失败:', e.message); return { industries: [], concepts: [], all: [] }; }
}

async function fetchSectorKLine(boardCode, count = 120) {
  let url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=90.BK' + boardCode + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=0&lmt=' + count;
  try {
    let resp = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let json = await resp.json();
    if (json.rc !== 0 || !json.data || !json.data.klines) throw new Error('无数据');
    return {
      name: json.data.name || boardCode,
      dktotal: json.data.dktotal || 0,
      candles: json.data.klines.map(line => { let p = line.split(','); return { date: p[0], open: parseFloat(p[1]), close: parseFloat(p[2]), high: parseFloat(p[3]), low: parseFloat(p[4]), volume: parseFloat(p[5]) || 0, amount: parseFloat(p[6]) || 0 }; })
    };
  } catch (e) { console.log('板块K线获取失败:', boardCode, e.message); return null; }
}

// ==================== 板块四阶段诊断引擎 (JS版) ====================

function computeSectorIndicators(candles) {
  if (!candles || candles.length < 10) return { error: '数据不足' };
  let closes = candles.map(c => c.close).filter(v => v > 0);
  let volumes = candles.map(c => c.volume).filter(v => v > 0);
  let highs = candles.map(c => c.high).filter(v => v > 0);
  let lows = candles.map(c => c.low).filter(v => v > 0);
  let result = {};
  // 均线
  for (let p of [5, 10, 20, 60, 120]) {
    let ma = calcMASeriesS(closes, p);
    let idx = closes.length - 1;
    result['MA' + p + '_current'] = ma[idx] !== null ? parseFloat(ma[idx].toFixed(2)) : null;
    result['MA' + p + '_direction'] = null;
    if (idx >= 4 && ma[idx] !== null && ma[idx - 3] !== null) {
      result['MA' + p + '_direction'] = ma[idx] > ma[idx - 3] ? 'up' : (ma[idx] < ma[idx - 3] ? 'down' : 'flat');
    }
    // 降级策略
    if (result['MA' + p + '_current'] === null && p === 60) {
      for (let fb of [40, 35, 30]) {
        let fma = calcMASeriesS(closes, fb);
        if (fma[idx] !== null) { result['MA60_current'] = parseFloat(fma[idx].toFixed(2)); result['MA60_fallback'] = fb; break; }
      }
    }
    if (result['MA' + p + '_current'] === null && p === 120) {
      for (let fb of [80, 60, 50, 40]) {
        let fma = calcMASeriesS(closes, fb);
        if (fma[idx] !== null) { result['MA120_current'] = parseFloat(fma[idx].toFixed(2)); result['MA120_fallback'] = fb; break; }
      }
    }
  }
  // 均线排列
  let ma10 = result['MA10_current'], ma20 = result['MA20_current'], ma60 = result['MA60_current'], ma120 = result['MA120_current'];
  if (ma10 && ma20) {
    if (ma10 > ma20) {
      result['ma_alignment'] = ma60 && ma20 > ma60 ? (ma120 && ma60 > ma120 ? 'full_bull' : 'partial_bull') : 'partial_bull';
    } else if (ma10 < ma20) {
      result['ma_alignment'] = 'bear';
    } else { result['ma_alignment'] = 'flat'; }
  } else { result['ma_alignment'] = null; }
  result['close_vs_MA5'] = closes[closes.length - 1] > (result['MA5_current'] || 0) ? 'above' : 'below';
  result['close_vs_MA10'] = closes[closes.length - 1] > (result['MA10_current'] || 0) ? 'above' : 'below';
  result['close_vs_MA20'] = closes[closes.length - 1] > (result['MA20_current'] || 0) ? 'above' : 'below';
  result['close_vs_MA60'] = closes[closes.length - 1] > (result['MA60_current'] || 0) ? 'above' : 'below';
  result['MA5_slope'] = result['MA5_direction'] || null;

  // MACD
  let macdData = calcMACDDataSeries(closes);
  let difArr = macdData.diff, deaArr = macdData.dea;
  result['DIF_current'] = difArr[difArr.length - 1] !== undefined ? parseFloat(difArr[difArr.length - 1].toFixed(4)) : null;
  result['DEA_current'] = deaArr[deaArr.length - 1] !== undefined ? parseFloat(deaArr[deaArr.length - 1].toFixed(4)) : null;
  result['BAR_current'] = result['DIF_current'] !== null && result['DEA_current'] !== null ? parseFloat((2 * (result['DIF_current'] - result['DEA_current'])).toFixed(4)) : null;
  if (result['DIF_current'] !== null && result['DEA_current'] !== null) {
    result['macd_state'] = result['DIF_current'] > result['DEA_current'] ? 'golden' : 'dead';
    result['DIF_above_zero'] = result['DIF_current'] > 0;
  }

  // 顶底背离
  result['divergence_top'] = false; result['divergence_bottom'] = false;
  if (highs.length >= 32 && result['DIF_current'] !== null) {
    let recentHigh = Math.max(...highs.slice(-16)), prevHigh = Math.max(...highs.slice(-32, -16));
    let recentDifs = difArr.slice(-16).filter(x => x != null), prevDifs = difArr.slice(-32, -16).filter(x => x != null);
    if (recentDifs.length && prevDifs.length) {
      result['divergence_top'] = recentHigh > prevHigh * 1.01 && Math.max(...recentDifs) < Math.max(...prevDifs) * 0.95;
    }
    let recentLow = Math.min(...lows.slice(-16)), prevLow = Math.min(...lows.slice(-32, -16));
    if (recentDifs.length && prevDifs.length) {
      result['divergence_bottom'] = recentLow < prevLow * 0.99 && Math.min(...recentDifs) > Math.min(...prevDifs) * 1.05;
    }
  }

  // 距60日高低点
  if (closes.length >= 60) {
    let dCloses = closes.slice(-60);
    let maxIdx = dCloses.indexOf(Math.max(...dCloses)), minIdx = dCloses.indexOf(Math.min(...dCloses));
    result['days_from_60d_high'] = 59 - maxIdx;
    result['days_from_60d_low'] = 59 - minIdx;
    result['price_60d_high'] = parseFloat(Math.max(...dCloses).toFixed(2));
    result['price_60d_low'] = parseFloat(Math.min(...dCloses).toFixed(2));
  }

  // 量价
  if (volumes.length >= 5) { result['vol_ratio_5d'] = parseFloat((safeAvg(volumes.slice(-1)) / safeAvg(volumes.slice(-6, -1))).toFixed(2)); }
  if (volumes.length >= 20) { result['vol_ratio_20d'] = parseFloat((safeAvg(volumes.slice(-1)) / safeAvg(volumes.slice(-21, -1))).toFixed(2)); }

  // 本周变化
  if (closes.length >= 5) { result['week_pct'] = parseFloat(pct(closes[closes.length - 1], closes[closes.length - 6] || closes[closes.length - 5]).toFixed(2)); }
  if (highs.length >= 5 && lows.length >= 5) {
    let weekHigh = Math.max(...highs.slice(-5)), weekLow = Math.min(...lows.slice(-5));
    result['week_amp'] = parseFloat(((weekHigh - weekLow) / closes[closes.length - 1] * 100).toFixed(2));
  }

  // 日线异常
  result['daily_signals'] = {};
  let recent10 = candles.slice(-10);
  if (recent10.length >= 5) { result['daily_signals']['v_shape'] = _checkVShape(recent10); }
  result['daily_signals']['big_red'] = _checkBigRed(candles);

  return result;
}

function _checkVShape(recent) {
  if (recent.length < 5) return false;
  let closes = recent.map(c => c.close), volumes = recent.map(c => c.volume || 0);
  let minIdx = closes.indexOf(Math.min(...closes));
  if (minIdx >= closes.length - 4) {
    for (let i = minIdx + 1; i < recent.length; i++) {
      if (i <= minIdx + 3) {
        let pctChg = (closes[i] / closes[i - 1] - 1) * 100;
        let volRatio = volumes[i - 1] > 0 ? volumes[i] / volumes[i - 1] : 99;
        if (pctChg > 3 && volRatio > 2) return true;
      }
    }
  }
  return false;
}

function _checkBigRed(candles) {
  if (candles.length < 3) return false;
  let i = candles.length - 1, pctChg = (candles[i].close / candles[i].open - 1) * 100;
  let volToday = candles[i].volume || 0, volYesterday = candles[i - 1].volume || 0;
  return pctChg > 3 && volYesterday > 0 && volToday / volYesterday > 2;
}

function diagnoseSectorStage(name, indicators) {
  let ind = indicators;
  if (ind.error) return { stage: 0, stage_name: '数据不足', sub_type: null, confidence: 'low', reasons: [ind.error], alert: null };
  let reasons = [], alerts = [], sub_type = null;
  let ma_align = ind.ma_alignment, macd_state = ind.macd_state, dif_above = ind.DIF_above_zero;
  let days_low = ind.days_from_60d_low, days_high = ind.days_from_60d_high;

  // V形反转 - 最高优先级
  if (ind.daily_signals && ind.daily_signals.v_shape) {
    return { stage: 1, stage_name: '底部蓄势', sub_type: 'V形反转', confidence: 'medium',
      reasons: ['V形反转信号：创新低后3日内倍量阳线'], alert: '重点观察！等待缩量回踩确认。' };
  }

  // S4: 下跌趋势
  let isS4 = false, s4Reasons = [];
  if (ma_align === 'bear' && ind.close_vs_MA20 === 'below') { isS4 = true; s4Reasons.push('均线空头排列，股价在MA20下方'); }
  if (macd_state === 'dead' && dif_above === false) { isS4 = true; s4Reasons.push('MACD死叉零轴下'); }
  if (days_low !== null && days_low <= 5) { isS4 = true; s4Reasons.push('距60日最低仅' + days_low + '天，持续新低'); }
  if (isS4 && s4Reasons.length >= 2) {
    if (ind.daily_signals && ind.daily_signals.big_red) { sub_type = '诱多反弹'; alerts.push('出现放量大阳线但均线空头未改，可能诱多'); }
    return { stage: 4, stage_name: '下跌趋势', sub_type: sub_type || '标准下跌', confidence: 'high',
      reasons: s4Reasons, alert: alerts.join(';') || '禁飞区，不抄底不抢反弹。' };
  }

  // S3: 加速赶顶
  let isS3 = false, s3Reasons = [];
  if (ind.divergence_top) { isS3 = true; s3Reasons.push('⚠️ MACD顶背离：价格新高DIF不跟'); }
  if (ind.week_amp && ind.week_amp > 12 && ind.week_pct && ind.week_pct < -4) { isS3 = true; s3Reasons.push('高位异常放量下跌(周振幅' + ind.week_amp + '%)'); }
  if (macd_state === 'dead' && dif_above && ind.close_vs_MA10 === 'below') { isS3 = true; s3Reasons.push('MACD高位死叉跌破MA10'); }
  if (isS3 && s3Reasons.length >= 2) {
    return { stage: 3, stage_name: '加速赶顶', sub_type: '顶背离型', confidence: 'high',
      reasons: s3Reasons, alert: '⚠️ 建议清仓！等回踩确认再考虑。' };
  } else if (isS3) {
    return { stage: 3, stage_name: '加速赶顶', sub_type: '赶顶初期', confidence: 'medium',
      reasons: s3Reasons, alert: '高度警惕！减仓或设置紧密止损。' };
  }

  // S1: 底部蓄势
  let isS1 = false, s1Reasons = [];
  if ((ma_align === 'bear' || ma_align === 'flat') && days_low !== null && days_low >= 15) { isS1 = true; s1Reasons.push('距60日低点' + days_low + '天，跌不动磨底中'); }
  if (ind.MA5_direction && ['up', 'flat'].includes(ind.MA5_direction) && ind.close_vs_MA5 === 'above') { isS1 = true; s1Reasons.push('站上MA5，短期止跌'); }
  if (macd_state === 'dead') {
    let barNow = ind.BAR_current, barPrev = null;
    if (barNow !== null) s1Reasons.push('MACD死叉中');
  } else if (macd_state === 'golden' && dif_above === false) { isS1 = true; s1Reasons.push('MACD零轴下金叉，动能转强'); }
  if (ind.divergence_bottom) { isS1 = true; s1Reasons.push('⭐ 底背离信号'); }
  if (ind.vol_ratio_5d && ind.vol_ratio_5d > 2) { s1Reasons.push('倍量(量比' + ind.vol_ratio_5d + 'x)，资金试探建仓'); }
  let strongS1 = s1Reasons.some(r => r.includes('背离') || r.includes('金叉') || r.includes('倍量'));
  if (isS1 && strongS1) {
    return { stage: 1, stage_name: '底部蓄势', sub_type: '标准底部', confidence: 'high',
      reasons: s1Reasons, alert: '左侧候选区，按计划分批买入。' };
  } else if (isS1) {
    return { stage: 1, stage_name: '底部蓄势', sub_type: '底部初现', confidence: 'medium',
      reasons: s1Reasons, alert: '关注中，等待更多确认信号。' };
  }

  // S2: 主升浪
  let isS2 = false, s2Reasons = [];
  if (['full_bull', 'partial_bull'].includes(ma_align)) { isS2 = true; s2Reasons.push('均线多头排列'); }
  if (macd_state === 'golden' && dif_above) { isS2 = true; s2Reasons.push('MACD金叉零轴上'); }
  if (days_high !== null && days_high <= 20 && days_low !== null && days_low >= 30) { isS2 = true; s2Reasons.push('持续强势'); }
  if (isS2) {
    // 洗盘检测
    if (ind.week_pct !== null && ind.week_pct < -3 && ind.vol_ratio_5d && ind.vol_ratio_5d < 0.8 && ind.close_vs_MA20 === 'above' && macd_state === 'golden') {
      return { stage: 2, stage_name: '主升浪', sub_type: '洗盘(黄金坑)', confidence: 'high',
        reasons: s2Reasons.concat(['触发洗盘：缩量回踩MA20上方，黄金坑加仓机会']), alert: '💎 黄金坑！洗盘非见顶，可加仓。' };
    }
    return { stage: 2, stage_name: '主升浪', sub_type: '标准主升浪', confidence: 'high',
      reasons: s2Reasons, alert: '主仓位持有。新资金回踩MA20缩量时加仓。' };
  }

  // 兜底
  if (ma_align === 'bear' && ind.close_vs_MA20 === 'below') {
    return { stage: 4, stage_name: '下跌趋势', sub_type: '疑似下跌', confidence: 'low', reasons: ['均线偏空'], alert: '观望。' };
  }
  return { stage: 1, stage_name: '底部蓄势', sub_type: '疑似筑底', confidence: 'low', reasons: ['趋势转换阶段'], alert: '关注。' };
}

// ==================== SKILL 精选池（盘后静态JSON） ====================

let _selectionCache = null;
async function fetchSelectionPools() {
  if (_selectionCache) return _selectionCache;
  try {
    let url = 'https://raw.githubusercontent.com/Ronie-Liu/stock-pwa/main/data/selection_pools.json';
    let resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    _selectionCache = await resp.json();
    return _selectionCache;
  } catch (e) { console.log('精选池加载失败:', e.message); return null; }
}

function matchSelectionPool(boardName, pools) {
  if (!pools) return null;
  for (let key of ['gold', 'silver', 'watch', 'blacklist']) {
    let list = pools[key] || [];
    let found = list.find(b => b.name === boardName);
    if (found) return { pool: key, ...found };
  }
  return null;
}

function poolLabel(pool) {
  let map = { gold: '🥇金牌', silver: '🥈银牌', watch: '👀观察', blacklist: '🚫黑名单' };
  return map[pool] || pool;
}

// ==================== 宏观：大盘分析（同v3，加入四维技术面） ====================
let INDEX_CODES = { sh: 'sh000001', cyb: 'sz399006', hs300: 'sh000300' };
async function fetchIndexData() {
  let keys = ['sh', 'cyb', 'hs300'];
  let promises = keys.map(k => fetchKLineRaw(INDEX_CODES[k], 120));
  let results = await Promise.all(promises);
  let data = {};
  keys.forEach((k, i) => { data[k] = { info: { name: { sh: '上证指数', cyb: '创业板指', hs300: '沪深300' }[k], code: INDEX_CODES[k] }, candles: results[i] || [] }; });
  return data;
}

async function fetchNorthboundFlow() {
  let detail = ''; let trending = '--'; let signal = 'neutral';
  try {
    let url = 'https://push2.eastmoney.com/api/qt/kamt.kline/get?fields1=f1,f2,f3,f4&fields2=f51,f52&klt=101&lmt=5';
    let resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let d = await resp.json();
    let kls = d.data && d.data.klines ? d.data.klines : [];
    let totalNet = 0, dates = [];
    for (let l of kls.slice(-5)) { let p = l.split(','); dates.push(p[0]); totalNet += safeNum(p[1]); }
    detail = '近5日净流入: ' + totalNet.toFixed(0) + '亿 | ' + dates[0] + '~' + dates[dates.length - 1];
    if (totalNet > 50) { signal = 'green'; trending = '持续流入'; }
    else if (totalNet > 0) { signal = 'yellow'; trending = '小幅流入'; }
    else { signal = 'red'; trending = '净流出'; }
  } catch (e) { detail = '(暂不可用)'; }
  return { detail, trending, signal };
}

async function fetchMarketBreadth() {
  try {
    let url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f8,f9,f12,f14&secids=1.000001,0.399001,0.399006';
    let resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let d = await resp.json(); let diffs = d.data && d.data.diff ? d.data.diff : [];
    let totalUp = 0, totalDown = 0;
    for (let item of diffs) { totalUp += safeNum(item.f8); totalDown += safeNum(item.f9); }
    let upRatio = totalUp + totalDown > 0 ? parseFloat((totalUp / (totalUp + totalDown) * 100).toFixed(1)) : 50;
    let signal = upRatio > 55 ? 'green' : upRatio > 45 ? 'yellow' : 'red';
    let trending = upRatio > 55 ? '普涨' : upRatio > 45 ? '分化' : '普跌';
    return { signal, trending, upRatio, detail: '涨' + totalUp + '/跌' + totalDown + ' (' + upRatio + '%上涨)' };
  } catch (e) { return { signal: 'neutral', trending: '--', upRatio: 0, detail: '(暂不可用)' }; }
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
    let bb = calcBB(closes, 20, 2);
    let slope20 = 0;
    if (ma20[idx] && ma20[Math.max(0, idx - 20)]) slope20 = pct(ma20[idx], ma20[Math.max(0, idx - 20)]) / 20;
    let volMA5 = safeAvg(volumes.slice(-5)), volMA20 = safeAvg(volumes.slice(-20));
    let volRatio = volMA20 ? parseFloat((volMA5 / volMA20).toFixed(2)) : 0;
    let volTrend = volRatio > 1.2 ? '放量' : volRatio < 0.7 ? '缩量' : '持平';
    let aboveMA20 = close > (ma20[idx] || close), aboveMA60 = close > (ma60[idx] || close), aboveMA250 = close > (ma250[idx] || close);
    let dma20 = parseFloat(pct(close, ma20[idx] || close).toFixed(1));
    let dma60 = parseFloat(pct(close, ma60[idx] || close).toFixed(1));
    let dma250 = parseFloat(pct(close, ma250[idx] || close).toFixed(1));
    let bbPos = bb.pos[idx], bbWidth = bb.width[idx];
    let bbSignal = '';
    if (bbPos !== null) {
      if (bbPos < 10) { bbSignal = '触下轨超卖'; bullish += 1; }
      else if (bbPos > 90) { bbSignal = '触上轨超买'; bearish += 1; }
      else if (bbPos < 30) { bbSignal = '偏下轨'; bullish += 0.5; }
      else if (bbPos > 70) { bbSignal = '偏上轨'; bearish += 0.5; }
      else bbSignal = '中轨附近';
    }

    // 指数四维技术面
    let macdData = calcMACDDataSeries(closes);
    let difArr = macdData.diff, rsiArr = calcRSISeries(closes, 14);
    let lookback = Math.min(60, closes.length);
    let segCloses = closes.slice(-lookback), segDifs = difArr.slice(-lookback), segRSIs = rsiArr.slice(-lookback);
    let lows = findLocalLows(segCloses, 5), highs = findLocalHighs(segCloses, 5);
    let macdDiv = false, rsiDiv = false, macdTopDiv = false, rsiTopDiv = false;
    if (lows.length >= 2) {
      let l1 = lows[lows.length - 1], l2 = lows[lows.length - 2];
      let p1 = segCloses[l1], p2 = segCloses[l2], d1 = segDifs[l1] || 0, d2 = segDifs[l2] || 0, r1 = segRSIs[l1] || 50, r2 = segRSIs[l2] || 50;
      if (p1 < p2) { if (d1 > d2) macdDiv = true; if (r1 > r2) rsiDiv = true; }
    }
    if (highs.length >= 2) {
      let h1 = highs[highs.length - 1], h2 = highs[highs.length - 2];
      let p1 = segCloses[h1], p2 = segCloses[h2], d1 = segDifs[h1] || 0, d2 = segDifs[h2] || 0, r1 = segRSIs[h1] || 50, r2 = segRSIs[h2] || 50;
      if (p1 > p2) { if (d1 < d2) macdTopDiv = true; if (r1 < r2) rsiTopDiv = true; }
    }
    function slope(data, p) { if (data.length < p * 2) return 0; let r = safeAvg(data.slice(-p)), o = safeAvg(data.slice(-p * 2, -p)); return o ? ((r - o) / o * 100) / p : 0; }
    let s10 = slope(closes, 10), s20 = slope(closes, 20);
    let flattening = s10 < 0 && s20 < 0 && Math.abs(s10) < Math.abs(s20) * 0.7;
    let steepUp = s10 > 0.5 && s20 > 0.3;
    let lookback120 = Math.min(120, cs.length);
    let segH = closes.slice(-lookback120), segL = closes.slice(-lookback120);
    let swingHigh = Math.max(...segH), swingLow = Math.min(...segL);
    let range = swingHigh - swingLow;
    let fib618 = range > 0 ? swingHigh - range * 0.618 : close;
    let nearFib618 = Math.abs(close - fib618) / close < 0.03;
    let belowFib618 = close < fib618;
    let redVol = 0, greenVol = 0, redDays = 0, greenDays = 0;
    for (let c of cs.slice(-10)) {
      let v = safeNum(c.volume, 0);
      if (c.close >= c.open) { redVol += v; redDays++; } else { greenVol += v; greenDays++; }
    }
    let totalVol = redVol + greenVol, redRatio = totalVol ? parseFloat((redVol / totalVol * 100).toFixed(1)) : 50;
    let redFat = redRatio >= 55 && redDays >= greenDays;
    let priceChg10 = cs.length > 10 ? pct(cs[cs.length - 1].close, cs[cs.length - 10].close) : 0;

    let idxBullish = 0, idxBearish = 0;
    if (aboveMA20 && aboveMA60 && slope20 > 0) { idxBullish += 2; } else if (!aboveMA20 && slope20 < -0.1) { idxBearish += 2; } else { idxBullish += 1; idxBearish += 1; }
    if (macdDiv && rsiDiv) { idxBullish += 2; } else if (macdTopDiv && rsiTopDiv) { idxBearish += 2; } else if (macdDiv || rsiDiv) { idxBullish += 1; } else if (macdTopDiv || rsiTopDiv) { idxBearish += 1; }
    if (steepUp) { idxBullish += 1; } else if (s10 < 0 && !flattening) { idxBearish += 1; }
    if (nearFib618 && !belowFib618) { idxBullish += 1; } else if (belowFib618) { idxBearish += 1; }
    if (redFat && volTrend === '放量' && priceChg10 > 0) { idxBullish += 1; } else if (!redFat && volTrend === '放量' && priceChg10 < 0) { idxBearish += 1; }
    if (bbPos !== null) { if (bbPos < 10) idxBullish += 1; else if (bbPos > 90) idxBearish += 1; }
    bullish += idxBullish; bearish += idxBearish;

    let trendSignal = aboveMA20 && aboveMA60 && slope20 > 0 ? '多头排列' : (!aboveMA20 && slope20 < -0.1 ? '空头排列' : '震荡');
    let divSignal = macdDiv && rsiDiv ? '底背离✅' : macdTopDiv && rsiTopDiv ? '顶背离⚠️' : macdDiv ? 'MACD底背离' : macdTopDiv ? 'MACD顶背离' : '无背离';
    let structSignal = steepUp ? '加速上涨' : flattening ? '跌速放缓' : s10 < 0 ? '短期下跌' : '短期企稳';
    let supportSignal = nearFib618 ? (belowFib618 ? '跌破61.8%' : '考验61.8%') : '远离关键位';
    let vpSignal = redFat && volTrend === '放量' && priceChg10 > 0 ? '放量上涨' : !redFat && volTrend === '放量' && priceChg10 < 0 ? '放量下跌' : volTrend;

    rows.push({ name: info.name, code: info.code, close: close.toFixed(2),
      dma20, dma60, dma250, bbPos, bbWidth, bbSignal,
      slope20: slope20.toFixed(2), volRatio, volTrend, trendSignal,
      divSignal, structSignal, supportSignal, vpSignal,
      aboveMA20, aboveMA60, aboveMA250, dataDate: cs[idx].date });
    details.push(info.name + ': ' + close.toFixed(2) + ' | 均线:' + trendSignal + ' | 背离:' + divSignal + ' | 结构:' + structSignal + ' | 支撑:' + supportSignal + ' | 量价:' + vpSignal);
  }
  let net = bullish - bearish;
  let signal, resultText, positionAdvice;
  if (net >= 6) { signal = 'green'; resultText = '🟢 强势市场'; positionAdvice = '建议仓位 7-9成。'; }
  else if (net >= 2) { signal = 'yellow'; resultText = '🟡 震荡市场'; positionAdvice = '建议仓位 5成左右。'; }
  else { signal = 'red'; resultText = '🔴 弱势市场'; positionAdvice = '建议仓位 ≤3成。'; }
  return { signal, resultText, positionAdvice, rows, details: details.join('\n'), bullish, bearish, net, dataDate: rows.length ? rows[0].dataDate : '--' };
}

// ==================== 中观：板块四阶段诊断 + 精选池 ====================

async function analyzeMeso(stock, stockCandles, indexData) {
  // 1. 获取个股所属行业/概念板块
  let boards = await fetchSectorBoards(stock.code);
  let topIndustries = boards.industries.slice(0, 2); // 前2个行业板块
  let topConcepts = boards.concepts.slice(0, 5);     // 前5个概念板块（按rank排序）

  // 2. 获取精选池
  let pools = await fetchSelectionPools();

  // 3. 取板块K线并诊断
  let diagResults = [];
  let allDiag = [...topIndustries, ...topConcepts];
  let klinePromises = allDiag.map(b => fetchSectorKLine(b.code, 120));
  let klines = await Promise.all(klinePromises);

  for (let i = 0; i < allDiag.length; i++) {
    let board = allDiag[i], kl = klines[i];
    if (!kl || !kl.candles || kl.candles.length < 10) {
      diagResults.push({ name: board.name, code: board.code, category: i < topIndustries.length ? '行业' : '概念', diagnosis: null });
      continue;
    }
    let indicators = computeSectorIndicators(kl.candles);
    let diagnosis = diagnoseSectorStage(board.name, indicators);
    let sel = matchSelectionPool(board.name, pools);
    diagResults.push({
      name: board.name, code: board.code,
      category: i < topIndustries.length ? '行业' : '概念',
      diagnosis, indicators,
      lastClose: kl.candles[kl.candles.length - 1].close,
      lastPct: kl.candles.length > 1 ? parseFloat(pct(kl.candles[kl.candles.length - 1].close, kl.candles[kl.candles.length - 2].close).toFixed(2)) : 0,
      selection: sel
    });
  }

  // 4. 综合打分：行业权重 > 概念权重
  let bullish = 0, bearish = 0, stageNames = [];
  for (let d of diagResults) {
    if (!d.diagnosis) continue;
    let s = d.diagnosis.stage, w = d.category === '行业' ? 1.5 : 1;
    if (s === 1) bullish += 1 * w;
    else if (s === 2) bullish += 2 * w;
    else if (s === 3) bearish += 2 * w;
    else if (s === 4) bearish += 1 * w;
  }

  // 同时保留原有的相对强度分析作为参考
  let closes = stockCandles.map(c => c.close).filter(v => v > 0);
  let benchmark = indexData['sh'];
  let bmCloses = benchmark && benchmark.candles.length ? benchmark.candles.map(c => c.close).filter(v => v > 0) : [];
  let rs20 = closes.length >= 20 && bmCloses.length >= 20 ? parseFloat((pct(closes[closes.length - 1], closes[closes.length - 20]) - pct(bmCloses[bmCloses.length - 1], bmCloses[bmCloses.length - 20])).toFixed(2)) : null;

  let net = bullish - bearish;
  let signal, resultText;
  if (net >= 4) { signal = 'green'; resultText = '🟢 板块共振偏多 —— 所属板块多在S1/S2阶段'; }
  else if (net >= 0) { signal = 'yellow'; resultText = '🟡 板块信号交织 —— 择强避弱'; }
  else { signal = 'red'; resultText = '🔴 板块整体偏空 —— 观望等待板块企稳'; }

  return {
    signal, resultText, bullish: Math.round(bullish), bearish: Math.round(bearish), net,
    diagResults, rs20,
    board: topIndustries.length ? topIndustries.map(b => b.name).join('、') : '--',
    benchmarkName: benchmark ? benchmark.info.name : '--',
    dataDate: stockCandles.length ? stockCandles[stockCandles.length - 1].date : '--'
  };
}

// ==================== 微观：资金面 + 四维技术（同v3） ====================

async function fetchStockFlow(code) {
  let results = { fundFlow: [], northboundSignal: 'neutral', northboundDetail: '', fundFlowDetail: '', stockFlowType: '' };
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
      let mainNet = safeNum(parts[1]) + safeNum(parts[2]);
      results.fundFlow.push({ date: parts[0], mainNet: parseFloat((mainNet / 1e8).toFixed(2)) });
      totalNet += mainNet;
    }
    if (totalNet > 1e8) { results.northboundSignal = 'green'; results.northboundDetail = '近5日主力资金持续流入'; }
    else if (totalNet > 0) { results.northboundSignal = 'yellow'; results.northboundDetail = '近5日主力资金小幅净流入'; }
    else { results.northboundSignal = 'red'; results.northboundDetail = '近5日主力资金净流出'; }
    results.fundFlowDetail = results.fundFlow.map(f => f.date + ': ' + (f.mainNet > 0 ? '+' : '') + f.mainNet + '亿').join(' | ');
  } catch (e) { results.fundFlowDetail = '(暂不可用)'; }
  return results;
}

// ==================== 微观技术面四维（保持v3） ====================

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
  let ddStr = db.found ? '双底: 左底' + db.left + '(' + candles[db.leftIdx].date + ') 右底' + db.right + '(' + candles[db.rightIdx].date + ')' : '';
  let tl = calcDowntrendLine(candles.slice(-60));
  let tlStr = tl ? '下降趋势线: ' + tl.startDate + '(' + tl.start + ') → ' + tl.endDate + '(' + tl.end + ')' : '';
  let signal, resultText, bullish = 0, bearish = 0;
  if (flattening && db.found) { signal = 'stabilizing'; resultText = '✅ 跌速放缓+双底雏形'; bullish = 3; }
  else if (flattening) { signal = 'flattening'; resultText = '🟢 跌速明显放缓'; bullish = 2; }
  else if (s10 < 0 && Math.abs(s10) < 0.3) { signal = 'mild_decline'; resultText = '🟡 温和下跌'; bearish = 1; }
  else { signal = 'steep_decline'; resultText = '🔴 下跌结构完整'; bearish = 3; }
  return { signal, resultText, slope10: parseFloat(s10.toFixed(3)), slope20: parseFloat(s20.toFixed(3)),
    flattening, doubleBottom: db, downtrendLine: tl,
    detail: [ddStr, tlStr].filter(Boolean).join('\n'), dataDate: candles[idx].date, bullish, bearish };
}

function analyzeVolumePrice(candles) {
  if (candles.length < 20) return { signal: 'insufficient', resultText: '数据不足' };
  let idx = candles.length - 1, recent10 = candles.slice(-10);
  let redVol = 0, greenVol = 0, redDays = 0, greenDays = 0;
  for (let c of recent10) {
    let v = safeNum(c.volume, 0);
    if (c.close >= c.open) { redVol += v; redDays++; } else { greenVol += v; greenDays++; }
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

// ==================== 综合共振决策（保持+中观板块评分增强） ====================

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

  let wMacro = 0.35, wMeso = 0.30, wMicroFlow = 0.15, wMicroTech = 0.20;

  let macroScore = 5;
  if (macro.signal === 'green') macroScore += 2; else if (macro.signal === 'red') macroScore -= 2;
  if (northbound.signal === 'green') macroScore += 1.5; else if (northbound.signal === 'red') macroScore -= 1.5; else if (northbound.signal === 'yellow') macroScore += 0.5;
  if (breadth.signal === 'green') macroScore += 1; else if (breadth.signal === 'red') macroScore -= 1;
  macroScore = Math.max(0, Math.min(10, macroScore));

  let mesoScore = 5;
  if (meso.signal === 'green') mesoScore += 2.5; else if (meso.signal === 'red') mesoScore -= 2.5; else if (meso.signal === 'yellow') mesoScore += 0.5;
  if (meso.rs20 !== null) {
    if (meso.rs20 > 3) mesoScore += 2; else if (meso.rs20 > 0) mesoScore += 1; else if (meso.rs20 < -3) mesoScore -= 2;
  }
  mesoScore = Math.max(0, Math.min(10, mesoScore));

  let flowScore = 5;
  if (stockFlow.northboundSignal === 'green') flowScore += 3; else if (stockFlow.northboundSignal === 'red') flowScore -= 2.5; else flowScore += 0.5;
  flowScore = Math.max(0, Math.min(10, flowScore));

  let techScore = 5;
  let div = micro.divergence, sup = micro.support, dtr = micro.downtrend, vp = micro.volumePrice;
  if (div.signal === 'strong_bullish') techScore += 2; else if (div.signal === 'bullish') techScore += 1.5; else if (div.signal === 'mild_bullish') techScore += 0.5;
  if (sup.signal === 'strong_support') techScore += 2; else if (sup.signal === 'approaching') techScore += 1;
  if (dtr.signal === 'stabilizing') techScore += 2; else if (dtr.signal === 'flattening') techScore += 1.5; else if (dtr.signal === 'mild_decline') techScore += 0.5; else if (dtr.signal === 'steep_decline') techScore -= 2;
  if (vp.signal === 'accumulation') techScore += 2; else if (vp.signal === 'panic_cleared') techScore += 1.5; else if (vp.signal === 'mild_bullish') techScore += 0.5; else if (vp.signal === 'panic_selling') techScore -= 2; else if (vp.signal === 'grinding_down') techScore -= 1;
  techScore = Math.max(0, Math.min(10, techScore));

  let weightedTotal = parseFloat((macroScore * wMacro + mesoScore * wMeso + flowScore * wMicroFlow + techScore * wMicroTech).toFixed(1));

  let confidence = 50;
  let dataAvailable = [northbound.detail, breadth.detail, stockFlow.fundFlowDetail].filter(d => d && !d.includes('暂不可用')).length;
  confidence += dataAvailable * 10;
  if (macro.rows.length >= 3) confidence += 10;
  if (meso.rs20 !== null) confidence += 5;
  if (meso.diagResults && meso.diagResults.length >= 3) confidence += 10;
  if (div.signal !== 'insufficient') confidence += 5;
  confidence = Math.min(100, confidence);

  let macroBullish = macro.bullish + (northbound.signal === 'green' ? 2 : northbound.signal === 'red' ? 0 : 1) + (breadth.signal === 'green' ? 1 : 0);
  let macroBearish = macro.bearish + (northbound.signal === 'red' ? 2 : 0) + (breadth.signal === 'red' ? 1 : 0);

  let levels = [
    { dim: '宏观(大盘+资金)', signal: macro.signal, score: macroScore.toFixed(1), weight: '35%', resultText: macro.resultText, subdetail: '北向: ' + northbound.trending + ' | ' + macro.positionAdvice, bullish: macroBullish, bearish: macroBearish },
    { dim: '中观(板块诊断)', signal: meso.signal, score: mesoScore.toFixed(1), weight: '30%', resultText: meso.resultText, subdetail: meso.board + ' | 净分: ' + meso.net, bullish: meso.bullish || 0, bearish: meso.bearish || 0 },
    { dim: '微观资金面', signal: stockFlow.northboundSignal, score: flowScore.toFixed(1), weight: '15%', resultText: stockFlow.northboundDetail, subdetail: '', bullish: stockFlow.northboundSignal === 'green' ? 2 : 0, bearish: stockFlow.northboundSignal === 'red' ? 2 : 0 },
    { dim: '微观技术面', signal: micro.signal, score: techScore.toFixed(1), weight: '20%', resultText: micro.resultText, subdetail: '四维净分: ' + micro.net, bullish: micro.bullish || 0, bearish: micro.bearish || 0 }
  ];

  let greenCount = levels.filter(l => ['green', 'strong_bullish', 'bullish', 'strong_support', 'stabilizing', 'accumulation'].includes(l.signal)).length;
  let overallSignal, suggestion, suggestionDetail, positionAdvice;
  if (weightedTotal >= 7.0 && greenCount >= 3) {
    overallSignal = 'green'; suggestion = '🟢 三维共振 —— 可积极买入';
    suggestionDetail = '加权' + weightedTotal + '/10 | 信心' + confidence + '%';
    positionAdvice = macro.positionAdvice;
  } else if (weightedTotal >= 5.5 && greenCount >= 2) {
    overallSignal = 'yellow'; suggestion = '🟡 信号偏多 —— 按计划分批';
    suggestionDetail = '加权' + weightedTotal + '/10 | 信心' + confidence + '%';
    positionAdvice = macro.positionAdvice;
  } else if (weightedTotal >= 4.0) {
    overallSignal = 'yellow'; suggestion = '🟡 中性偏弱 —— 缩小仓位';
    suggestionDetail = '加权' + weightedTotal + '/10 | 信心' + confidence + '%';
    positionAdvice = macro.positionAdvice;
  } else {
    overallSignal = 'red'; suggestion = '🔴 多维度偏空 —— 暂停买入';
    suggestionDetail = '加权' + weightedTotal + '/10 | 信心' + confidence + '%';
    positionAdvice = macro.positionAdvice;
  }

  let suggestedPrice = buyPrice;
  if (buyPrice > 0) { if (overallSignal === 'green') suggestedPrice = buyPrice * 1.05; else if (overallSignal === 'red') suggestedPrice = buyPrice * 0.92; }

  return { levels, overallSignal, suggestion, suggestionDetail, positionAdvice,
    weightedTotal, confidence, macroScore, mesoScore, flowScore, techScore,
    originalBuyPrice: buyPrice, suggestedBuyPrice: parseFloat(suggestedPrice.toFixed(2)), currentPrice, northbound, breadth, stockFlow };
}

// ==================== 主入口 ====================

async function runAnalysisAndRender(stock, quote) {
  let loadingEl = document.getElementById('analysis-loading'), resultEl = document.getElementById('analysis-result'), btnEl = document.getElementById('btn-analysis');
  if (loadingEl) loadingEl.style.display = 'block';
  if (resultEl) resultEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">三维共振分析中：大盘→北向→板块诊断→个股资金→四维技术...请稍候</div>';
  if (btnEl) btnEl.style.display = 'none';
  try {
    let [indexData, dailyData, weeklyData, northbound, breadth, stockFlow] = await Promise.all([
      fetchIndexData(), fetchDailyRaw(stock.code, 120), fetchWeeklyRaw(stock.code, 120), fetchNorthboundFlow(), fetchMarketBreadth(), fetchStockFlow(stock.code)
    ]);
    if (!dailyData.length) { if (resultEl) resultEl.innerHTML = '<span class="error-text">K线获取失败</span>'; if (loadingEl) loadingEl.style.display = 'none'; if (btnEl) btnEl.style.display = 'inline-block'; return; }
    let macro = analyzeMacro(indexData);
    let meso = await analyzeMeso(stock, dailyData, indexData);
    let micro = analyzeMicroComprehensive(dailyData, weeklyData, quote);
    let resonance = generateResonanceDecision(macro, meso, micro, northbound, breadth, stockFlow, stock, quote);
    if (resultEl) resultEl.innerHTML = renderResonanceHTML(stock, quote, macro, meso, micro, resonance);
  } catch (e) { console.error('分析失败:', e); if (resultEl) resultEl.innerHTML = '<span class="error-text">分析失败: ' + escapeHtml(e.message) + '</span>'; }
  finally { if (loadingEl) loadingEl.style.display = 'none'; if (btnEl) btnEl.style.display = 'inline-block'; }
}

// ==================== 渲染 ====================

function stageEmoji(s) { let m = { 1: '🟢S1', 2: '🚀S2', 3: '⚠️S3', 4: '🔴S4' }; return m[s] || '❓'; }

function renderResonanceHTML(stock, quote, macro, meso, micro, resonance) {
  let div = micro.divergence, sup = micro.support, dtr = micro.downtrend, vp = micro.volumePrice;
  let lvl = resonance.levels, nb = resonance.northbound, br = resonance.breadth, sf = resonance.stockFlow;
  let lightColor = resonance.overallSignal === 'green' ? '#10b981' : resonance.overallSignal === 'yellow' ? '#f59e0b' : '#ef4444';
  let lightEmoji = resonance.overallSignal === 'green' ? '🟢' : resonance.overallSignal === 'yellow' ? '🟡' : '🔴';

  // 构建板块诊断HTML
  let diagHTML = '';
  if (meso.diagResults && meso.diagResults.length) {
    let industryDiags = meso.diagResults.filter(d => d.category === '行业');
    let conceptDiags = meso.diagResults.filter(d => d.category === '概念');
    let buildDiagTable = (title, items) => {
      if (!items.length) return '';
      let rows = items.map(d => {
        let diag = d.diagnosis;
        if (!diag) return '<tr><td>' + d.name + '</td><td colspan="3" style="color:var(--text-muted)">数据不足</td></tr>';
        let sel = d.selection ? ' ' + poolLabel(d.selection.pool) : '';
        return '<tr><td>' + d.name + sel + '</td><td>' + stageEmoji(diag.stage) + ' ' + diag.stage_name + '</td><td>' + (diag.sub_type || '--') + '</td><td style="font-size:10px;">' + (diag.reasons ? diag.reasons.slice(0, 2).join('; ') : '--') + '</td></tr>';
      }).join('');
      return '<div class="dim-section-label">' + title + '</div><table class="res-table"><tr><th>板块</th><th>阶段</th><th>子类型</th><th>理由</th></tr>' + rows + '</table>';
    };
    diagHTML = buildDiagTable('🏭 行业板块', industryDiags) + buildDiagTable('💡 概念板块', conceptDiags);
  }

  return `
<div class="resonance-card">
  <h4 style="margin:0 0 4px;font-size:17px;">📋 ${escapeHtml(stock.name)} 三维共振分析</h4>
  <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">数据: ${macro.dataDate} | 现价: ${quote.last_px.toFixed(2)} | 买入价: ${resonance.originalBuyPrice.toFixed(2)}</div>

  <div class="traffic-bar" style="background:var(--bg-input);border-radius:8px;padding:10px 14px;margin-bottom:12px;">
    <div style="display:flex;justify-content:space-around;text-align:center;gap:8px;">
      ${lvl.map(l => {
        let e = ['green','strong_bullish','bullish','strong_support','stabilizing','accumulation'].includes(l.signal) ? '🟢' : ['red','steep_decline','panic_selling'].includes(l.signal) ? '🔴' : '🟡';
        let sc = parseFloat(l.score) >= 7 ? 'var(--up-color)' : parseFloat(l.score) <= 4 ? 'var(--down-color)' : 'var(--warning)';
        return '<div style="flex:1;min-width:0"><div style="font-size:22px;">' + e + '</div><div style="font-size:9px;font-weight:600;">' + l.dim + '</div><div style="font-size:13px;font-weight:700;color:' + sc + ';">' + l.score + '<span style="font-size:8px;color:var(--text-muted);font-weight:400;">/' + l.weight + '</span></div></div>';
      }).join('')}
    </div>
    <div style="display:flex;justify-content:center;align-items:center;gap:8px;margin-top:6px;padding-top:6px;border-top:1px solid var(--border);">
      <span style="font-size:11px;color:var(--text-muted);">综合</span><span style="font-size:16px;font-weight:700;color:${lightColor};">${resonance.weightedTotal}/10</span>
      <span style="font-size:11px;color:var(--text-muted);">信心</span><span style="font-size:14px;font-weight:700;color:${lightColor};">${resonance.confidence}%</span>
    </div>
  </div>

  <div class="decision-card" style="background:${lightColor}15;border-radius:8px;padding:12px;margin-bottom:12px;border-left:3px solid ${lightColor};">
    <div style="font-size:15px;font-weight:700;margin-bottom:4px;">${resonance.suggestion}</div>
    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px;">${resonance.suggestionDetail}</div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">${resonance.positionAdvice}</div>
    <div style="display:flex;gap:16px;font-size:12px;flex-wrap:wrap;">
      <span>📌 原买入价: <strong>${resonance.originalBuyPrice.toFixed(2)}</strong></span>
      <span>🎯 建议: <strong>${resonance.suggestedBuyPrice.toFixed(2)}</strong></span>
    </div>
  </div>

  <details class="resonance-dim" open>
    <summary><span style="font-size:16px;margin-right:4px;">🌍</span> <strong>宏观</strong> <span style="font-size:11px;color:var(--text-muted)">${macro.resultText} | 北向:${nb.trending}</span></summary>
    <div class="dim-body">
      <table class="res-table"><tr><th>指数</th><th>收盘</th><th>DMA20</th><th>DMA60</th><th>背离</th><th>结构</th><th>支撑</th><th>量价</th></tr>
      ${macro.rows.map(r => '<tr><td>'+r.name+'</td><td>'+r.close+'</td><td style="color:'+(r.dma20>0?'var(--up-color)':'var(--down-color)')+'">'+(r.dma20>0?'+':'')+r.dma20+'%</td><td style="color:'+(r.dma60>0?'var(--up-color)':'var(--down-color)')+'">'+(r.dma60>0?'+':'')+r.dma60+'%</td><td>'+r.divSignal+'</td><td>'+r.structSignal+'</td><td>'+r.supportSignal+'</td><td>'+r.vpSignal+'</td></tr>').join('')}</table>
      <div style="font-size:10px;color:var(--text-muted);margin-top:2px;">📐 指数四维同个股标准</div>
      <div class="dim-detail-text" style="font-size:11px;margin-top:6px;">💰 北向近5日: ${nb.detail}<br>📊 涨跌比: ${br.detail}</div>
    </div>
  </details>

  <details class="resonance-dim" open>
    <summary><span style="font-size:16px;margin-right:4px;">🏢</span> <strong>中观 · 板块四阶段诊断</strong> <span style="font-size:11px;color:var(--text-muted)">${meso.resultText}</span></summary>
    <div class="dim-body">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">所属: ${meso.board} | 净分: ${meso.net}</div>
      ${diagHTML || '<div style="color:var(--text-muted);font-size:11px;">板块诊断中...</div>'}
      <div style="font-size:10px;color:var(--text-muted);margin-top:4px;">S1底部蓄势 S2主升浪 S3加速赶顶 S4下跌趋势 | 🥇精选池标注来自盘后全量分析</div>
    </div>
  </details>

  <details class="resonance-dim">
    <summary><span style="font-size:16px;margin-right:4px;">🔬</span> <strong>微观 · 四维技术</strong> <span style="font-size:11px;color:var(--text-muted)">${micro.resultText}</span></summary>
    <div class="dim-body">
      <div class="dim-section-label">💰 个股主力资金</div>
      <div style="font-size:11px;margin-bottom:6px;">${sf.fundFlowDetail}<br><span style="color:${sf.northboundSignal==='green'?'#10b981':sf.northboundSignal==='red'?'#ef4444':'#d97706'};">${sf.northboundDetail}</span></div>

      <div class="dim-section-label">📐 技术四维</div>
      <div class="micro-sub"><div class="micro-sub-header"><span class="signal-tag ${div.signal}">${div.signal==='strong_bullish'?'✅✅':div.signal==='bullish'?'✅':div.signal==='mild_bullish'?'🟡':'🔴'}</span> 底背离</div><div class="micro-sub-result">${div.resultText}</div><div class="micro-sub-data">RSI(14):${(div.currentRSI||50).toFixed(1)} | DIF:${(div.currentDIF||0).toFixed(4)}</div>${div.detail?'<div class="micro-sub-detail">'+div.detail.replace(/\\n/g,'<br>')+'</div>':''}</div>

      <div class="micro-sub"><div class="micro-sub-header"><span class="signal-tag ${sup.signal}">${sup.signal==='strong_support'?'✅':sup.signal==='approaching'?'🟡':'🔴'}</span> 支撑位</div><div class="micro-sub-result">${sup.resultText}</div>${sup.fibTable.length?'<table class="res-table" style="margin-top:4px;"><tr><th>位置</th><th>价格</th><th>距现价</th></tr>'+sup.fibTable.map(f=>'<tr class="'+(f.label==='61.8%'?'fib-golden':'')+'"><td>'+f.label+(f.label==='61.8%'?' 🥇':'')+'</td><td>'+f.price+'</td><td>'+(f.dist>0?'+':'')+f.dist+'</td></tr>').join('')+'</table>':''}</div>

      <div class="micro-sub"><div class="micro-sub-header"><span class="signal-tag ${dtr.signal}">${dtr.signal==='stabilizing'?'✅':dtr.signal==='flattening'?'🟢':dtr.signal==='mild_decline'?'🟡':'🔴'}</span> 下跌结构</div><div class="micro-sub-result">${dtr.resultText}</div><div class="micro-sub-data">10日:${dtr.slope10}%/日 | 20日:${dtr.slope20}%/日</div>${dtr.detail?'<div class="micro-sub-detail">'+dtr.detail.replace(/\\n/g,'<br>')+'</div>':''}</div>

      <div class="micro-sub"><div class="micro-sub-header"><span class="signal-tag ${vp.signal}">${['accumulation','panic_cleared'].includes(vp.signal)?'✅':vp.signal==='mild_bullish'?'🟡':['panic_selling','grinding_down'].includes(vp.signal)?'🔴':'🟡'}</span> 量价</div><div class="micro-sub-result">${vp.resultText}</div><div class="micro-sub-data">阳量:${vp.redRatio}% | ${vp.volTrend}(MA5/MA20=${vp.volRatio})</div><div class="micro-sub-detail">${vp.details.replace(/\\n/g,'<br>')}</div></div>
    </div>
  </details>

  <div style="font-size:13px;margin-top:12px;padding:10px;background:var(--bg-input);border-radius:8px;">
    <div style="font-weight:700;margin-bottom:6px;">📊 综合决策矩阵</div>
    <table class="res-table">
      <tr><th>维度</th><th>评分</th><th>信号</th><th>判断</th><th>行动</th></tr>
      ${resonance.levels.map(l => { let st=['green','strong_bullish','bullish'].includes(l.signal)?'🟢 绿灯':['red','steep_decline'].includes(l.signal)?'🔴 红灯':'🟡 黄灯'; let sc=parseFloat(l.score)>=7?'var(--up-color)':parseFloat(l.score)<=4?'var(--down-color)':'var(--warning)'; return '<tr><td>'+l.dim+'</td><td style="color:'+sc+';font-weight:600;">'+l.score+'<span style="font-size:8px;color:var(--text-muted);font-weight:400;">/'+l.weight+'</span></td><td>'+st+'</td><td style="font-size:11px;">'+l.resultText.slice(0,30)+'</td><td style="font-size:11px;">'+(l.signal==='green'?'可积极':'按计划')+'</td></tr>'; }).join('')}
      <tr style="font-weight:700;background:${lightColor}10;"><td>综合</td><td style="color:${lightColor};">${resonance.weightedTotal}/10</td><td>${lightEmoji} ${resonance.overallSignal==='green'?'绿灯':resonance.overallSignal==='yellow'?'黄灯':'红灯'}</td><td colspan="2">${resonance.suggestion}</td></tr>
    </table>
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

function findLocalHighs(data, period) {
  let highs = [];
  for (let i = period; i < data.length - period; i++) {
    let isHigh = true;
    for (let j = i - period; j <= i + period; j++) { if (j === i) continue; if (data[j] >= data[i]) { isHigh = false; break; } }
    if (isHigh) highs.push(i);
  }
  return highs;
}

function calcMACDDataSeries(closes) {
  let ema12 = [closes[0]], ema26 = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    ema12.push(ema12[i-1] * 11/13 + closes[i] * 2/13);
    ema26.push(ema26[i-1] * 25/27 + closes[i] * 2/27);
  }
  let diff = [], dea = [];
  for (let i = 0; i < closes.length; i++) {
    diff.push(parseFloat((ema12[i] - ema26[i]).toFixed(4)));
    if (i === 0) dea.push(diff[0]);
    else dea.push(parseFloat((dea[i-1] * 8/10 + diff[i] * 2/10).toFixed(4)));
  }
  return { diff, dea };
}

function calcRSISeries(closes, period = 14) {
  if (closes.length < period + 1) { let r = []; for (let i = 0; i < closes.length; i++) r.push(50); return r; }
  let rsi = new Array(closes.length).fill(50);
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { let chg = closes[i] - closes[i-1]; if (chg > 0) gains += chg; else losses -= chg; }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1));
  for (let i = period + 1; i < closes.length; i++) { let chg = closes[i] - closes[i-1]; avgGain = (avgGain * 13 + (chg > 0 ? chg : 0)) / 14; avgLoss = (avgLoss * 13 + (chg < 0 ? -chg : 0)) / 14; rsi[i] = avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1)); }
  return rsi;
}

function detectDoubleBottom(candles) {
  if (candles.length < 30) return { found: false };
  let closes = candles.map(c => c.close).filter(v => v > 0);
  let lows = findLocalLows(closes, 4);
  if (lows.length < 2) return { found: false };
  let l1 = lows[lows.length - 1], l2 = lows[lows.length - 2];
  let p1 = closes[l1], p2 = closes[l2];
  if (Math.abs(p1 - p2) / Math.max(p1, p2) < 0.05 && l1 - l2 >= 5) {
    return { found: true, left: p2.toFixed(2), right: p1.toFixed(2), leftIdx: l2, rightIdx: l1 };
  }
  return { found: false };
}

function calcDowntrendLine(candles) {
  if (candles.length < 20) return null;
  let highs = candles.map(c => c.high).filter(v => v > 0);
  let highIdxs = findLocalHighs(highs, 3);
  if (highIdxs.length < 2) return null;
  let h1 = highIdxs[highIdxs.length - 2], h2 = highIdxs[highIdxs.length - 1];
  let slope = (highs[h2] - highs[h1]) / (h2 - h1), intercept = highs[h1] - slope * h1;
  let startIdx = highIdxs[0], endIdx = highIdxs[highIdxs.length - 1];
  return {
    start: parseFloat(highs[startIdx].toFixed(2)), end: parseFloat(highs[endIdx].toFixed(2)),
    startDate: candles[startIdx] ? candles[startIdx].date : '',
    endDate: candles[endIdx] ? candles[endIdx].date : '',
    slope: parseFloat(slope.toFixed(3))
  };
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}