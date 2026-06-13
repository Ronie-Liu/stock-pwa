// ===== 上证指数历史数据库 + 衍生计算字段 =====
// 存储: IndexedDB (market_data store, 由 db.js 管理)
// 数据源: 腾讯K线API + 东方财富换手率
// 字段: 10项衍生指标

const SH_INDEX_CODE = 'sh000001';
// 上证指数流通股本: 4.82万亿股 → 482亿手 (1手=100股)
const SH_OS_LOTS = 4.82e12 / 100; // 48,200,000,000 手

// 获取上证K线（3年）
async function fetchIndexKLineRaw(years = 3) {
  let count = years * 250;
  let url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + SH_INDEX_CODE + ',day,,,' + count + ',qfq';
  try {
    let resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    let json = await resp.json();
    let data = json.data && json.data[SH_INDEX_CODE];
    let raw = data ? (data.qfqday || data.day || []) : [];
    return raw.map(r => ({
      date: r[0],
      open: parseFloat(r[1]), close: parseFloat(r[2]),
      high: parseFloat(r[3]), low: parseFloat(r[4]),
      volume: parseFloat(r[5]) || 0,
      amount: parseFloat(r[6]) || 0
    }));
  } catch (e) { console.error('指数K线获取失败:', e.message); return []; }
}

// 获取指数换手率（东方财富接口）
async function fetchIndexTurnover() {
  try {
    let url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?' +
      'secid=1.000001&fields1=f1,f2,f3,f4&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=0&lmt=750';
    let resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
    let json = await resp.json();
    let kls = json.data && json.data.klines ? json.data.klines : [];
    let map = {};
    for (let l of kls) {
      let p = l.split(',');
      map[p[0]] = parseFloat(p[6]) || 0;
    }
    return map;
  } catch (e) { console.error('换手率获取失败:', e.message); return {}; }
}

// 填充换手率：优先用API数据，无数据则用 成交量/流通股本 兜底
function fillTurnover(rawData, turnoverMap) {
  let apiHits = 0, fallbackHits = 0;
  for (let r of rawData) {
    let apiVal = turnoverMap[r.date];
    if (apiVal && apiVal > 0) {
      r._turnover = apiVal;
      r.turnover_rate = apiVal;
      apiHits++;
    } else {
      // 兜底：换手率 = 成交量(手) / 流通股本(手) × 100%
      let fallback = r.volume && SH_OS_LOTS ? parseFloat((r.volume / SH_OS_LOTS * 100).toFixed(4)) : 0;
      r._turnover = fallback;
      r.turnover_rate = fallback;
      fallbackHits++;
    }
  }
  console.log('换手率: API命中', apiHits, '条, 兜底计算', fallbackHits, '条');
}

// MA计算
function maRange(arr, start, len) {
  let seg = arr.slice(Math.max(0, start - len + 1), start + 1);
  let valid = seg.filter(v => isFinite(v) && !isNaN(v));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

// ===== 筹码分布：按阈值累积换手率，计算获利比例 =====
// 从 currentIdx 向前累加换手率直至 threshold(%)，返回该区间内成本<close的比例
function computeProfitRatio(rawData, currentIdx, close, threshold) {
  let cum = 0;
  let profitWeight = 0, totalWeight = 0;
  for (let i = currentIdx; i >= 0 && cum < threshold; i--) {
    let to = rawData[i]._turnover || 0;
    if (to <= 0) continue;
    let take = Math.min(to, threshold - cum);
    totalWeight += take;
    if (rawData[i].close < close) profitWeight += take;
    cum += to;
  }
  return totalWeight > 0 ? parseFloat((profitWeight / totalWeight * 100).toFixed(4)) : null;
}

// 计算筹码0~10%平均成本：累计300%换手率，按成本升序，取0-10%区间的加权均价
function computeCheapest10Cost(rawData, currentIdx) {
  let chips = [];
  let cum = 0;
  for (let i = currentIdx; i >= 0 && cum < 300; i--) {
    let to = rawData[i]._turnover || 0;
    if (to <= 0) continue;
    let take = Math.min(to, 300 - cum);
    chips.push({ cost: rawData[i].close, weight: take });
    cum += to;
  }
  if (!chips.length) return null;
  chips.sort((a, b) => a.cost - b.cost);
  let total = chips.reduce((s, c) => s + c.weight, 0);
  let target10 = total * 0.10, acc = 0, costSum = 0, weightSum = 0;
  for (let c of chips) {
    let take = Math.min(c.weight, target10 - acc);
    if (take <= 0) break;
    costSum += c.cost * take;
    weightSum += take;
    acc += take;
  }
  return weightSum > 0 ? parseFloat((costSum / weightSum).toFixed(4)) : null;
}

// 计算所有衍生字段
function computeDerivedFields(rawData, turnoverMap) {
  let len = rawData.length, result = [];
  let closes = rawData.map(r => r.close);
  let ma20All = [], ma60All = [], ma120All = [];

  for (let i = 0; i < len; i++) {
    ma20All.push(maRange(closes, i, 20));
    ma60All.push(maRange(closes, i, 60));
    ma120All.push(maRange(closes, i, 120));
  }

  for (let i = 0; i < len; i++) {
    let row = { ...rawData[i] };
    let close = closes[i];
    let date = row.date;

    // ① MA20乖离倍数
    let ma20 = ma20All[i];
    row.ma20_deviation = ma20 && ma20 > 0 ? parseFloat((close / ma20).toFixed(4)) : null;

    // ② MA60乖离倍数
    let ma60 = ma60All[i];
    row.ma60_deviation = ma60 && ma60 > 0 ? parseFloat((close / ma60).toFixed(4)) : null;

    // ③ MA20趋势变化率(%)
    row.ma20_trend_chg = null;
    if (i > 0 && ma20 && ma20All[i - 1] && ma20All[i - 1] !== 0) {
      row.ma20_trend_chg = parseFloat(((ma20 - ma20All[i - 1]) / ma20All[i - 1] * 100).toFixed(4));
    }

    // ④ MA120趋势变化率(%)
    row.ma120_trend_chg = null;
    let ma120 = ma120All[i];
    if (i > 0 && ma120 && ma120All[i - 1] && ma120All[i - 1] !== 0) {
      row.ma120_trend_chg = parseFloat(((ma120 - ma120All[i - 1]) / ma120All[i - 1] * 100).toFixed(4));
    }

    // 换手率（由 fillTurnover 统一填充）
    row.turnover_rate = row.turnover_rate || 0;

    // ⑤ 筹码0~10%平均成本
    row.cheapest_10_cost = computeCheapest10Cost(rawData, i);
    // ⑥ 筹码0~10%成本倍数
    row.cheapest_10_multiple = row.cheapest_10_cost ? parseFloat((close / row.cheapest_10_cost).toFixed(4)) : null;
    // ⑦⑧⑨ 筹码获利比例
    row.profit_ratio_40 = computeProfitRatio(rawData, i, close, 40);
    row.profit_ratio_150 = computeProfitRatio(rawData, i, close, 150);
    row.profit_ratio_300 = computeProfitRatio(rawData, i, close, 300);

    // 清理临时字段
    delete row._turnover;

    result.push(row);
  }
  return result;
}

// ==================== 初始化 & 增量更新 ====================

async function initMarketData() {
  let count = await getMarketCount();
  console.log('大盘数据库已有:', count, '条');

  // 1. 全量加载（空库或数据太少）
  if (count < 500) {
    console.log('开始加载3年历史数据...');
    let rawData = await fetchIndexKLineRaw(3);
    if (rawData.length < 100) {
      console.log('K线数据不足，跳过');
      return;
    }
    let turnoverMap = await fetchIndexTurnover();
    fillTurnover(rawData, turnoverMap);
    let computed = computeDerivedFields(rawData, turnoverMap);
    let saved = await saveMarketRecords(computed);
    console.log('历史数据加载完成:', saved, '条');
    return;
  }

  // 2. 增量更新
  let latest = await getLatestMarketDate();
  let today = new Date().toISOString().slice(0, 10);
  if (latest && latest >= today) {
    console.log('大盘数据已是最新(', latest, ')');
    return;
  }

  console.log('增量更新大盘数据，最新日期:', latest);
  let rawNew = await fetchIndexKLineRaw(1);
  if (!rawNew.length) return;

  let turnoverMap = await fetchIndexTurnover();
  fillTurnover(rawNew, turnoverMap);

  // 只处理新数据
  let newRows = latest ? rawNew.filter(r => r.date > latest) : rawNew.slice(-60);
  if (!newRows.length) {
    console.log('无新数据');
    return;
  }

  // 需要对最后一段数据重新计算（MA和筹码依赖历史）
  // 取最近250条+新数据作为计算窗口
  let recalcWindow = latest
    ? [...rawNew.filter(r => r.date <= latest).slice(-250), ...newRows]
    : rawNew;
  let computed = computeDerivedFields(recalcWindow, turnoverMap);
  // 只保存新增的行
  let toSave = computed.filter(r => latest ? r.date > latest : true);
  let saved = await saveMarketRecords(toSave);
  console.log('增量更新完成:', saved, '条，新增日期:', toSave.map(r => r.date).join(', '));
}

// ==================== CSV 导出 ====================

async function exportMarketCSV() {
  let results = await getAllMarketRecords();
  let headers = ['日期', '开盘', '收盘', '最高', '最低', '成交量(手)', '成交额',
    '换手率(%)', 'MA20乖离倍数', 'MA60乖离倍数', 'MA20趋势变化率(%)', 'MA120趋势变化率(%)',
    '筹码0~10%平均成本', '筹码成本倍数', '40%获利比例', '150%获利比例', '300%获利比例'];
  let csv = '\uFEFF' + headers.join(',') + '\n';
  for (let r of results) {
    csv += [
      r.date, r.open, r.close, r.high, r.low, r.volume, r.amount, r.turnover_rate,
      r.ma20_deviation, r.ma60_deviation, r.ma20_trend_chg, r.ma120_trend_chg,
      r.cheapest_10_cost, r.cheapest_10_multiple, r.profit_ratio_40, r.profit_ratio_150, r.profit_ratio_300
    ].map(v => v != null ? v : '').join(',') + '\n';
  }
  return csv;
}

// ==================== 今日盘中实时数据 ====================

async function fetchTodayIndexQuote() {
  try {
    let url = 'https://qt.gtimg.cn/q=' + SH_INDEX_CODE;
    let resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    let text = await resp.text();
    let match = text.match(/"([^"]*)"/);
    if (!match) return null;
    let fields = match[1].split('~');
    if (fields.length < 40) return null;
    return {
      name: fields[1], code: SH_INDEX_CODE,
      last_px: parseFloat(fields[3]) || 0,
      open_px: parseFloat(fields[5]) || 0,
      high_px: parseFloat(fields[33]) || 0,
      low_px: parseFloat(fields[34]) || 0,
      prev_close: parseFloat(fields[4]) || 0,
      volume: parseInt(fields[36]) || 0,
      amount: parseFloat(fields[37]) || 0,
      change_pct: parseFloat(fields[32]) || 0,
      is_realtime: true
    };
  } catch (e) { return null; }
}
