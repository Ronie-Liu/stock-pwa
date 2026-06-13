// ===== 上证指数历史数据库 + 衍生计算字段 =====
// 存储: IndexedDB (market_data store, 由 db.js 管理)
// 数据源: 腾讯K线API → 换手率 = 成交量(手) / 流通股本(手)
// 字段: 10项衍生指标

const SH_INDEX_CODE = 'sh000001';
// 上证指数流通股本: 4.82万亿股 → 482亿手 (1手=100股)
const SH_OS_LOTS = 4.82e12 / 100; // 48,200,000,000 手

// ===== 可供用户自选的指标字段定义 =====
const INDICATOR_DEFS = [
  { field: 'ma20_deviation',   name: 'MA20乖离',     unit: '',   fmt: 4, desc:'收盘价/MA20均线值' },
  { field: 'ma60_deviation',   name: 'MA60乖离',     unit: '',   fmt: 4, desc:'收盘价/MA60均线值' },
  { field: 'ma20_trend_chg',   name: 'MA20趋势变化',  unit: '%', fmt: 4, desc:'MA20每日变化率' },
  { field: 'ma120_trend_chg',  name: 'MA120趋势变化', unit: '%', fmt: 4, desc:'MA120每日变化率' },
  { field: 'cheapest_10_cost', name: '筹码0-10%成本', unit: '',   fmt: 4, desc:'最低端10%筹码加权均价' },
  { field: 'cheapest_10_multiple', name: '筹码成本倍数', unit: '', fmt: 4, desc:'收盘价/筹码0-10%成本' },
  { field: 'profit_ratio_40',  name: '40%获利比例',  unit: '%', fmt: 4, desc:'40%换手区间获利比例' },
  { field: 'profit_ratio_150', name: '150%获利比例', unit: '%', fmt: 4, desc:'150%换手区间获利比例' },
  { field: 'profit_ratio_300', name: '300%获利比例', unit: '%', fmt: 4, desc:'300%换手区间获利比例' },
  { field: 'turnover_rate',    name: '换手率',       unit: '%', fmt: 2, desc:'成交量/流通股本' },
];

function getIndicatorDef(field) {
  return INDICATOR_DEFS.find(d => d.field === field);
}

// ===== 自定义配置存取（存于 app_settings.market_custom） =====

async function getMarketCustomSettings() {
  let s = await getSettings();
  try {
    return JSON.parse(s.market_custom || '{}');
  } catch(e) { return {}; }
}

async function saveMarketCustomSettings(custom) {
  await saveSettings({ market_custom: JSON.stringify(custom) });
}

function defaultMarketCustom() {
  return {
    stage_description: '',
    indicators: [
      { field: 'ma20_deviation', lower: '0.95', upper: '1.05', note: '低估/高估分界' },
      { field: 'profit_ratio_40', lower: '20', upper: '80', note: '短期超卖/超买' },
      { field: 'profit_ratio_300', lower: '30', upper: '70', note: '中长期超卖/超买' }
    ]
  };
}

// ===== 计算指标的盘中实时现值 =====
// latestRecord: DB中最新一条计算记录
// realtimeQuote: 盘中实时行情（非交易日为 null）
function computeRealtimeIndicatorValue(field, latestRecord, realtimeQuote) {
  if (!latestRecord) return null;
  let val = latestRecord[field];
  if (val == null || val === undefined) return null;

  // 如果你的盘中实时数据，调整价格依赖型指标
  if (realtimeQuote && realtimeQuote.last_px) {
    let rt = realtimeQuote.last_px;
    switch (field) {
      case 'ma20_deviation':
        if (latestRecord.ma20_deviation && latestRecord.close) {
          let ma20 = latestRecord.close / latestRecord.ma20_deviation;
          return parseFloat((rt / ma20).toFixed(4));
        }
        break;
      case 'ma60_deviation':
        if (latestRecord.ma60_deviation && latestRecord.close) {
          let ma60 = latestRecord.close / latestRecord.ma60_deviation;
          return parseFloat((rt / ma60).toFixed(4));
        }
        break;
      case 'cheapest_10_multiple':
        if (latestRecord.cheapest_10_cost) {
          return parseFloat((rt / latestRecord.cheapest_10_cost).toFixed(4));
        }
        break;
      case 'turnover_rate':
        if (realtimeQuote.volume) {
          return parseFloat((realtimeQuote.volume / SH_OS_LOTS * 100).toFixed(4));
        }
        break;
      // 其它指标盘中不变
    }
  }
  return val;
}

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

// 填充换手率 = 成交量(手) / 流通股本(手) × 100%
function fillTurnover(rawData) {
  let hit = 0;
  for (let r of rawData) {
    if (r.volume && SH_OS_LOTS) {
      let to = parseFloat((r.volume / SH_OS_LOTS * 100).toFixed(4));
      r._turnover = to;
      r.turnover_rate = to;
      hit++;
    } else {
      r._turnover = 0;
      r.turnover_rate = 0;
    }
  }
  console.log('换手率兜底计算:', hit, '条 (成交量/482亿手)');
}

// MA计算
function maRange(arr, start, len) {
  let seg = arr.slice(Math.max(0, start - len + 1), start + 1);
  let valid = seg.filter(v => isFinite(v) && !isNaN(v));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

// 筹码分布——利润比例
function computeProfitRatio(rawData, currentIdx, close, threshold) {
  let cum = 0, profitWeight = 0, totalWeight = 0;
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

// 筹码0~10%平均成本
function computeCheapest10Cost(rawData, currentIdx) {
  let chips = [], cum = 0;
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
function computeDerivedFields(rawData) {
  let len = rawData.length, result = [];
  let closes = rawData.map(r => r.close);
  let ma20All = [], ma60All = [], ma120All = [];
  for (let i = 0; i < len; i++) {
    ma20All.push(maRange(closes, i, 20));
    ma60All.push(maRange(closes, i, 60));
    ma120All.push(maRange(closes, i, 120));
  }
  for (let i = 0; i < len; i++) {
    let row = { ...rawData[i] }, close = closes[i];
    let ma20 = ma20All[i], ma60 = ma60All[i], ma120 = ma120All[i];
    row.ma20_deviation = ma20 && ma20 > 0 ? parseFloat((close / ma20).toFixed(4)) : null;
    row.ma60_deviation = ma60 && ma60 > 0 ? parseFloat((close / ma60).toFixed(4)) : null;
    row.ma20_trend_chg = (i > 0 && ma20 && ma20All[i-1] && ma20All[i-1]!==0) ? parseFloat(((ma20-ma20All[i-1])/ma20All[i-1]*100).toFixed(4)) : null;
    row.ma120_trend_chg = (i > 0 && ma120 && ma120All[i-1] && ma120All[i-1]!==0) ? parseFloat(((ma120-ma120All[i-1])/ma120All[i-1]*100).toFixed(4)) : null;
    row.turnover_rate = row.turnover_rate || 0;
    row.cheapest_10_cost = computeCheapest10Cost(rawData, i);
    row.cheapest_10_multiple = row.cheapest_10_cost ? parseFloat((close / row.cheapest_10_cost).toFixed(4)) : null;
    row.profit_ratio_40 = computeProfitRatio(rawData, i, close, 40);
    row.profit_ratio_150 = computeProfitRatio(rawData, i, close, 150);
    row.profit_ratio_300 = computeProfitRatio(rawData, i, close, 300);
    delete row._turnover;
    result.push(row);
  }
  return result;
}

// ==================== 初始化 & 增量更新 ====================

async function initMarketData() {
  let count = await getMarketCount();
  console.log('大盘数据库已有:', count, '条');
  if (count > 0) {
    let latestRecords = await getMarketRecords(1);
    let latest = latestRecords[0];
    if (latest && (!latest.turnover_rate || latest.turnover_rate <= 0) && latest.volume > 0) {
      console.log('检测到旧版坏数据（turnover_rate=0），清空重新拉取...');
      await clearMarketData();
      count = 0;
    }
  }
  if (count < 500) {
    console.log('开始加载3年历史数据...');
    let rawData = await fetchIndexKLineRaw(3);
    if (rawData.length < 100) { console.log('K线数据不足，跳过'); return; }
    fillTurnover(rawData);
    let computed = computeDerivedFields(rawData);
    let saved = await saveMarketRecords(computed);
    console.log('历史数据加载完成:', saved, '条');
    return;
  }
  let latest = await getLatestMarketDate();
  let today = new Date().toISOString().slice(0, 10);
  if (latest && latest >= today) { console.log('大盘数据已是最新(', latest, ')'); return; }
  console.log('增量更新大盘数据，最新日期:', latest);
  let rawNew = await fetchIndexKLineRaw(1);
  if (!rawNew.length) return;
  fillTurnover(rawNew);
  let newRows = latest ? rawNew.filter(r => r.date > latest) : rawNew.slice(-60);
  if (!newRows.length) { console.log('无新数据'); return; }
  let recalcWindow = latest ? [...rawNew.filter(r => r.date <= latest).slice(-250), ...newRows] : rawNew;
  let computed = computeDerivedFields(recalcWindow);
  let toSave = computed.filter(r => latest ? r.date > latest : true);
  let saved = await saveMarketRecords(toSave);
  console.log('增量更新完成:', saved, '条，新增日期:', toSave.map(r => r.date).join(', '));
}

// ==================== CSV 导出 ====================

async function exportMarketCSV() {
  let results = await getAllMarketRecords();
  let headers = ['日期','开盘','收盘','最高','最低','成交量(手)','成交额','换手率(%)',
    'MA20乖离倍数','MA60乖离倍数','MA20趋势变化率(%)','MA120趋势变化率(%)',
    '筹码0~10%平均成本','筹码成本倍数','40%获利比例','150%获利比例','300%获利比例'];
  let csv = '\uFEFF' + headers.join(',') + '\n';
  for (let r of results) {
    csv += [r.date, r.open, r.close, r.high, r.low, r.volume, r.amount, r.turnover_rate,
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
      last_px: parseFloat(fields[3]) || 0, open_px: parseFloat(fields[5]) || 0,
      high_px: parseFloat(fields[33]) || 0, low_px: parseFloat(fields[34]) || 0,
      prev_close: parseFloat(fields[4]) || 0, volume: parseInt(fields[36]) || 0,
      amount: parseFloat(fields[37]) || 0, change_pct: parseFloat(fields[32]) || 0,
      is_realtime: true
    };
  } catch (e) { return null; }
}
