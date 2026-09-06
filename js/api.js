// ===== 股票行情 API =====
// 使用公开免费接口：腾讯行情API

/**
 * 批量获取实时行情（腾讯API）
 * 自动分批（每批最多10只），防止URL过长
 */
async function fetchStockQuotes(codes) {
  if (!codes || codes.length === 0) return [];

  let BATCH_SIZE = 10;
  let allResults = [];

  for (let i = 0; i < codes.length; i += BATCH_SIZE) {
    let batch = codes.slice(i, i + BATCH_SIZE);
    let batchResults = await fetchStockQuotesBatch(batch);
    allResults.push(...batchResults);
  }

  return allResults;
}

async function fetchStockQuotesBatch(codes) {
  let tcodes = codes.map(stdToTencent);
  let url = 'https://qt.gtimg.cn/q=' + tcodes.join(',');

  try {
    let controller = new AbortController();
    let timeout = setTimeout(() => controller.abort(), 8000);
    let resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    let text = await resp.text();
    return parseTencentQuotes(text, codes);
  } catch (e) {
    console.error('批量行情失败:', e.message);
    // 逐个重试
    let results = [];
    for (let code of codes) {
      try {
        let tcode = stdToTencent(code);
        let r = await fetch('https://qt.gtimg.cn/q=' + tcode, { signal: AbortSignal.timeout(5000) });
        let txt = await r.text();
        let parsed = parseTencentQuotes(txt, [code]);
        results.push(...parsed);
      } catch (e2) {
        results.push({ code, name: extractDigits(code), error: '查询失败' });
      }
    }
    return results;
  }
}

/**
 * 腾讯行情响应解析
 * 格式: v_sh600519="1~贵州茅台~600519~1850.00~..."
 */
function parseTencentQuotes(text, codes) {
  let results = [];
  let codeMap = new Map();
  codes.forEach(c => {
    codeMap.set(stdToTencent(c), c);
  });

  let lines = text.split('\n').filter(l => l.trim());
  for (let line of lines) {
    let match = line.match(/v_(\w+)="(.+)"/);
    if (!match) continue;
    let tencentCode = match[1];
    let stdCode = codeMap.get(tencentCode);
    if (!stdCode) continue;

    let fields = match[2].split('~');
    // 字段索引参考腾讯API文档
    // [0]=未知 [1]=名称 [2]=代码 [3]=当前价 [4]=昨收 [5]=今开 [6]=成交量(手)
    // [7]=外盘 [8]=内盘 [9]=买一 [10]=卖一 ... [31]=涨跌额 [32]=涨跌幅 [33]=最高 [34]=最低
    // [38]=换手率 [39]=市盈率 [45]=振幅
    if (fields.length < 40) {
      results.push({ code: stdCode, error: '数据格式不完整' });
      continue;
    }

    let price = parseFloat(fields[3]);
    let changeRate = parseFloat(fields[32]);
    let turnover = parseFloat(fields[38]) || null;
    let prevClose = parseFloat(fields[4]);
    let name = fields[1];
    let high = parseFloat(fields[33]);
    let low = parseFloat(fields[34]);
    let open = parseFloat(fields[5]);
    let volume = parseFloat(fields[6]);

    results.push({
      code: stdCode,
      name: name || extractDigits(stdCode),
      last_px: price,
      prev_close: prevClose,
      px_change_rate: changeRate,
      turnover_ratio: turnover,
      high: high,
      low: low,
      open: open,
      volume: volume,
      error: null
    });
  }

  // 补充未返回的股票
  for (let c of codes) {
    if (!results.find(r => r.code === c)) {
      results.push({ code: c, name: extractDigits(c), error: '查询失败' });
    }
  }

  return results;
}

/**
 * 获取K线数据（腾讯复权日K，多域名容错）
 * 注意：腾讯 WAF 会在 ifzq.gtimg.cn 与 web.ifzq.gtimg.cn 之间轮流拦截(501)，
 * 因此逐个尝试两个域名，避免单个域名被封导致历史数据失效。
 */
async function fetchKLine(code, count = 120) {
  return fetchKLineTencent(code, count);
}

/**
 * 腾讯复权K线原始数据（多域名容错）
 * 返回原始数组 [[date,open,close,high,low,volume,...], ...]
 * period: day / week / month
 */
async function fetchTencentKLineRaw(tcode, count = 120, period = 'day') {
  const hosts = ['https://ifzq.gtimg.cn', 'https://web.ifzq.gtimg.cn'];
  let lastErr = null;
  for (let host of hosts) {
    try {
      let url = host + '/appstock/app/fqkline/get?param=' + tcode + ',' + period + ',,,' + count + ',qfq';
      let controller = new AbortController();
      let timeout = setTimeout(() => controller.abort(), 15000);
      let resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      let text = await resp.text();
      // WAF 拦截页是 HTML 重定向，正常响应以 { 开头
      if (text.indexOf('waf.tencent.com') >= 0 || text.trim().charAt(0) !== '{') {
        throw new Error('被WAF拦截');
      }
      let json = JSON.parse(text);
      let sd = json.data && json.data[tcode];
      if (!sd) throw new Error('响应数据异常');

      // 北交所优先day/week，沪深优先qfqday/qfqweek
      let isBJ = tcode.startsWith('bj');
      let key = period === 'week' ? (isBJ ? 'week' : 'qfqweek')
              : period === 'month' ? (isBJ ? 'month' : 'qfqmonth')
              : (isBJ ? 'day' : 'qfqday');
      let raw = sd[key] || sd[period] || sd.qfqday || sd.day;
      if (!raw || raw.length === 0) throw new Error('无K线数据');
      return raw;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('K线获取失败');
}

/**
 * 腾讯复权日K（多域名容错）
 */
async function fetchKLineTencent(code, count) {
  let tcode = stdToTencent(code);

  try {
    let raw = await fetchTencentKLineRaw(tcode, count, 'day');

    let candles = raw.map(item => ({
      date: item[0],
      open: parseFloat(item[1]),
      close: parseFloat(item[2]),
      high: parseFloat(item[3]),
      low: parseFloat(item[4]),
      volume: (parseFloat(item[5]) || 0) * 100, // 手→股
      amount: 0,
      amplitude: 0,
      change_rate: 0,
      change: 0,
      turnover: 0,
      ma5: null, ma10: null, ma20: null, ma30: null, ma60: null
    }));

    // 补计算涨跌幅和振幅
    for (let i = 1; i < candles.length; i++) {
      let prev = candles[i - 1];
      candles[i].change = parseFloat((candles[i].close - prev.close).toFixed(3));
      candles[i].change_rate = parseFloat((candles[i].change / prev.close * 100).toFixed(2));
      if (candles[i].high && candles[i - 1].close) {
        candles[i].amplitude = parseFloat(((candles[i].high - candles[i].low) / candles[i - 1].close * 100).toFixed(2));
      }
    }

    return { code, candles, error: null };
  } catch (e) {
    console.error('腾讯K线失败:', e.message);
    return { code, candles: [], error: e.message };
  }
}

/**
 * AI分析（调用公开大模型API）
 * 使用免费/公开接口分析K线形态
 */
async function fetchAIAnalysis(code, name, candles) {
  let recent = candles.slice(-60);
  if (recent.length < 20) return 'K线数据不足（需≥20个交易日），无法进行有效分析。';

  let closes = recent.map(c => c.close);
  let highs = recent.map(c => c.high);
  let lows = recent.map(c => c.low);
  let volumes = recent.map(c => c.volume);
  let turnovers = recent.map(c => c.turnover || 0);
  let last = recent[recent.length - 1];
  let idx = recent.length - 1;

  let ma5 = calcMASeries(closes, 5);
  let ma10 = calcMASeries(closes, 10);
  let ma20 = calcMASeries(closes, 20);
  let boll = calcBOLLSeries(closes);
  let macdArr = calcMACDDataSeries(closes);
  let rsi14 = calcRSI(closes, 14);
  let kdj = calcKDJ(highs, lows, closes);
  let volMA5 = calcMASeries(volumes, 5);
  let volMA10 = calcMASeries(volumes, 10);

  // 动能分析
  let macdHist5 = macdArr.hist.slice(-5).filter(v => v != null);
  let macdMomentum = '持平', macdChange = 0;
  if (macdHist5.length >= 3) {
    macdChange = macdHist5[macdHist5.length - 1] - macdHist5[0];
    if (macdChange > 0.01) macdMomentum = '增强';
    else if (macdChange < -0.01) macdMomentum = '减弱';
  }

  let prevDiff = idx > 0 ? macdArr.diff[idx - 1] : null;
  let prevDEA = idx > 0 ? macdArr.dea[idx - 1] : null;
  let goldenCross = prevDiff != null && macdArr.dea[idx] != null && prevDiff <= prevDEA && macdArr.diff[idx] > macdArr.dea[idx];
  let deathCross = prevDiff != null && macdArr.dea[idx] != null && prevDiff >= prevDEA && macdArr.diff[idx] < macdArr.dea[idx];

  // 量价关系
  let priceChange5 = ((closes[idx] - closes[Math.max(0, idx - 4)]) / closes[Math.max(0, idx - 4)] * 100);
  let volRatio = volMA5[idx] / Math.max(volMA10[idx] || 1, 1);
  let volPricePattern = '';
  if (priceChange5 > 2 && volRatio > 1.3) volPricePattern = '放量上涨（强势信号）';
  else if (priceChange5 > 2 && volRatio < 0.8) volPricePattern = '缩量上涨（需警惕，可能动能不足）';
  else if (priceChange5 < -2 && volRatio > 1.3) volPricePattern = '放量下跌（弱势信号）';
  else if (priceChange5 < -2 && volRatio < 0.8) volPricePattern = '缩量下跌（可能是洗盘）';
  else volPricePattern = '量价正常';

  // 支撑阻力
  let resistance = findLevels(highs.slice(-20), 'high');
  let support = findLevels(lows.slice(-20), 'low');

  // 波动率
  let returns = [];
  for (let i = 1; i < closes.length; i++) returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  let avgRet = returns.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, returns.length);
  let variance = returns.slice(-20).reduce((a, b) => a + (b - avgRet) * (b - avgRet), 0) / Math.min(20, returns.length);
  let volatility = Math.sqrt(variance) * 100;
  let volDesc = volatility > 3 ? '偏高（短线波动大，适合波段操作）' : volatility < 1.5 ? '偏低（横盘整理中，等待方向选择）' : '正常';

  let deviation = ((closes[idx] - ma20[idx]) / ma20[idx] * 100);
  let devDesc = deviation > 10 ? '严重偏离20日均线（短期回调风险较大）' :
    deviation > 5 ? '偏离20日均线上方（关注是否回踩）' :
    deviation < -10 ? '严重低于20日均线（超跌反弹概率增加）' :
    deviation < -5 ? '低于20日均线（可能继续弱势）' : '紧贴20日均线运行';

  let report = `## 📊 ${name}(${extractDigits(code)}) 专业级技术分析

### 一、动能趋势分析

| 指标 | 数值 | 状态 |
|------|------|------|
| MA5/MA10/MA20 | ${ma5[idx].toFixed(2)}/${ma10[idx].toFixed(2)}/${ma20[idx].toFixed(2)} | ${ma5[idx] > ma20[idx] ? '短期偏多' : '短期偏空'} |
| RSI(14) | ${rsi14.toFixed(1)} | ${rsi14 > 70 ? '⚠ 超买区' : rsi14 < 30 ? '✅ 超卖区' : '正常区间'} |
| KDJ-K/D/J | ${kdj.k.toFixed(1)}/${kdj.d.toFixed(1)}/${kdj.j.toFixed(1)} | ${kdj.j > 80 ? '⚠ 高位钝化' : kdj.j < 20 ? '✅ 低位金叉概率大' : '中性'} |
| MACD动能 | ${macdChange.toFixed(4)} | ${macdMomentum} |
${goldenCross ? '| 🔔 MACD金叉 | 刚形成 | 短期看涨信号 |\n' : ''}${deathCross ? '| 🔔 MACD死叉 | 刚形成 | 短期看跌信号 |\n' : ''}
### 二、量价结构
- 成交量MA5/MA10比值：${volRatio.toFixed(2)} → ${volPricePattern}
- 近5日换手率均值：${(turnovers.slice(-5).reduce((a,b)=>a+b,0)/5).toFixed(2)}%
- 价格偏离MA20：${deviation.toFixed(1)}% → ${devDesc}
- 20日波动率：${volatility.toFixed(1)}% → ${volDesc}

### 三、关键位置
| 类型 | 价格 |
|------|------|
| 阻力位1（近期高点） | ${(resistance * 1.005).toFixed(2)} |
| 阻力位2（BOLL上轨） | ${boll.upper[idx]?.toFixed(2) || '--'} |
| 支撑位1（近期低点） | ${(support * 0.995).toFixed(2)} |
| 支撑位2（BOLL下轨） | ${boll.lower[idx]?.toFixed(2) || '--'} |
| BOLL中轨（MA20） | ${boll.mid[idx]?.toFixed(2) || '--'} |

### 四、机会与风险

📈 **潜在机会：**
${rsi14 < 35 ? '• RSI低位，超跌反弹动能积累中，关注成交量是否温和放大确认反弹\n' : ''}${goldenCross ? '• MACD刚形成金叉，若后续放量确认，短期上涨概率较大\n' : ''}${deviation < -8 ? '• 价格距离均线较远，存在均值回归的反弹需求\n' : ''}${volRatio > 1.5 && priceChange5 > 0 ? '• 放量配合上涨，动能充足，趋势延续性较强\n' : ''}${(!(rsi14 < 35) && !goldenCross && !(deviation < -8) && !(volRatio > 1.5 && priceChange5 > 0)) ? '• 目前无明显技术性买入信号\n' : ''}

📉 **潜在风险：**
${rsi14 > 70 ? '• RSI超买区，短期获利盘压力大，回调风险增加\n' : ''}${deathCross ? '• MACD刚形成死叉，空头动能释放中，建议等待企稳信号\n' : ''}${deviation > 8 ? '• 价格远离均线，乖离率过大，注意短期回踩风险\n' : ''}${volRatio > 1.3 && priceChange5 < -2 ? '• 放量下跌，主力资金可能正在离场，谨慎对待\n' : ''}${(!(rsi14 > 70) && !deathCross && !(deviation > 8) && !(volRatio > 1.3 && priceChange5 < -2)) ? '• 目前无明显技术性风险信号\n' : ''}

### 五、确认方法
1. **突破确认**：若价格放量突破${(resistance * 1.005).toFixed(2)}阻力位并站稳3日以上，上涨趋势确立
2. **支撑确认**：若回踩${(support * 0.995).toFixed(2)}获得支撑且出现缩量止跌，可视为短期底部
3. **动能确认**：关注MACD柱能否持续放大，若缩小则动能衰竭
4. **量能确认**：上涨需放量配合（当日量>MA5量），下跌缩量为佳

---
> ⚠️ 以上分析完全基于历史K线数据的技术指标运算，**不构成任何投资建议**。股市有风险，投资需谨慎。`;

  return report;
}

// ========== 指标辅助函数 ==========

function calcMASeries(data, period) {
  let r = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    let s = 0; for (let j = i - period + 1; j <= i; j++) s += data[j];
    r[i] = parseFloat((s / period).toFixed(3));
  }
  return r;
}

function calcBOLLSeries(closes, period = 20, mult = 2) {
  let mid = calcMASeries(closes, period);
  let upper = new Array(closes.length).fill(null), lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let sl = closes.slice(i - period + 1, i + 1);
    let mean = sl.reduce((a, b) => a + b, 0) / period;
    let vari = sl.reduce((a, b) => a + (b - mean) * (b - mean), 0) / period;
    let std = Math.sqrt(vari);
    upper[i] = parseFloat((mean + mult * std).toFixed(3));
    lower[i] = parseFloat((mean - mult * std).toFixed(3));
  }
  return { mid, upper, lower };
}

function calcMACDDataSeries(closes, fast = 12, slow = 26, signal = 9) {
  function ema(d, p) {
    let k = 2 / (p + 1), r = new Array(d.length).fill(null);
    r[p - 1] = d.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < d.length; i++) r[i] = d[i] * k + r[i - 1] * (1 - k);
    return r;
  }
  let ef = ema(closes, fast), es = ema(closes, slow);
  let diff = new Array(closes.length).fill(null), dea = new Array(closes.length).fill(null), hist = new Array(closes.length).fill(null);
  let si = Math.max(slow - 1, fast - 1);
  for (let i = si; i < closes.length; i++) { if (ef[i] != null && es[i] != null) diff[i] = parseFloat((ef[i] - es[i]).toFixed(4)); }
  let vd = diff.filter(v => v != null);
  if (vd.length >= signal) {
    let dInit = vd.slice(0, signal).reduce((a, b) => a + b, 0) / signal, k = 2 / (signal + 1), dc = 0;
    for (let i = 0; i < closes.length; i++) { if (diff[i] != null) { dc++; if (dc === signal) dea[i] = parseFloat(dInit.toFixed(4)); else if (dc > signal) dea[i] = parseFloat((diff[i] * k + dea[i - 1] * (1 - k)).toFixed(4)); } }
  }
  for (let i = 0; i < closes.length; i++) { if (diff[i] != null && dea[i] != null) hist[i] = parseFloat((2 * (diff[i] - dea[i])).toFixed(4)); }
  return { diff, dea, hist };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) { let ch = closes[i] - closes[i - 1]; if (ch > 0) gains += ch; else losses += Math.abs(ch); }
  if (losses === 0) return 100;
  return parseFloat((100 - 100 / (1 + (gains / period) / (losses / period))).toFixed(1));
}

function calcKDJ(highs, lows, closes, period = 9) {
  let idx = closes.length - 1, s = Math.max(0, idx - period + 1);
  let hh = Math.max(...highs.slice(s, idx + 1)), ll = Math.min(...lows.slice(s, idx + 1));
  let rsv = hh === ll ? 50 : ((closes[idx] - ll) / (hh - ll)) * 100;
  let k = (2 / 3) * 50 + (1 / 3) * rsv, d = (2 / 3) * 50 + (1 / 3) * k, j = 3 * k - 2 * d;
  return { k: parseFloat(k.toFixed(1)), d: parseFloat(d.toFixed(1)), j: parseFloat(j.toFixed(1)) };
}

function findLevels(prices, type) {
  let sorted = [...prices].sort((a, b) => type === 'high' ? b - a : a - b), clusters = [];
  for (let p of sorted) { let found = false; for (let c of clusters) { if (Math.abs(p - c.value) / c.value < 0.02) { c.count++; found = true; break; } } if (!found) clusters.push({ value: p, count: 1 }); }
  clusters.sort((a, b) => b.count - a.count);
  return clusters.length > 0 ? clusters[0].value : sorted[Math.floor(sorted.length / 2)];
}

function calcMA(data, period) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  function ema(data, period) {
    let k = 2 / (period + 1);
    let result = [data[0]];
    for (let i = 1; i < data.length; i++) {
      result.push(data[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  }
  let emaFast = ema(closes, fast);
  let emaSlow = ema(closes, slow);
  let diffs = emaFast.map((v, i) => v - emaSlow[i]);
  let deaArr = ema(diffs, signal);
  let len = deaArr.length;
  return {
    diff: diffs[len - 1],
    dea: deaArr[len - 1],
    hist: (diffs[len - 1] - deaArr[len - 1]) * 2
  };
}

/**
 * 客户端本地阈值检查（不依赖服务端）
 */
async function checkThresholds(stocks, quotes, settings) {
  let alerts = [];
  let watchlistThreshold = settings.watchlist_multiple_threshold || 0.9;
  let holdingsRateThreshold = settings.holdings_rate_threshold || 1.0;
  let holdingsBuyThreshold = settings.holdings_buy_ratio_threshold || 0.9;

  for (let stock of stocks) {
    let quote = quotes.find(q => q.code === stock.code);
    if (!quote || quote.error) continue;

    let lastPx = quote.last_px;
    if (!lastPx || lastPx <= 0) continue;

    if (stock.stock_type === 'watchlist') {
      if (stock.buy_price && stock.buy_price > 0) {
        let multiple = lastPx / stock.buy_price;
        if (multiple <= watchlistThreshold) {
          let alertMsg = `${stock.name}：${multiple.toFixed(2)}`;
          alerts.push({
            stock: stock,
            type: '自选股',
            multiple: multiple,
            threshold: watchlistThreshold,
            message: alertMsg
          });
        }
      }
    } else if (stock.stock_type === 'holdings') {
      // 目标达成率检查
      if (stock.target_price && stock.target_price > 0) {
        let rate = lastPx / stock.target_price;
        if (rate >= holdingsRateThreshold) {
          let alertMsg = `${stock.name}：目标${rate.toFixed(2)}`;
          alerts.push({
            stock: stock,
            type: '持仓股(目标)',
            rate: rate,
            threshold: holdingsRateThreshold,
            message: alertMsg
          });
        }
      }
      // 买入倍数检查
      if (stock.buy_price && stock.buy_price > 0) {
        let multiple = lastPx / stock.buy_price;
        if (multiple <= holdingsBuyThreshold) {
          let alertMsg = `${stock.name}：${multiple.toFixed(2)}`;
          alerts.push({
            stock: stock,
            type: '持仓股(倍数)',
            multiple: multiple,
            threshold: holdingsBuyThreshold,
            message: alertMsg
          });
        }
      }
    }
  }
  return alerts;
}

/**
 * 发送浏览器推送通知
 * 使用 ServiceWorkerRegistration.showNotification() 替代 new Notification()
 */
async function sendBrowserNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  // 优先使用 Service Worker 的 showNotification
  if ('serviceWorker' in navigator && navigator.serviceWorker.ready) {
    try {
      let reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, {
        body: body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: 'stock-alert',
        requireInteraction: true,
        vibrate: [200, 100, 200]
      });
      return;
    } catch (e) {
      console.log('SW notification failed, fallback to legacy:', e);
    }
  }

  // 降级方案：使用旧的 Notification API（部分浏览器支持）
  try {
    new Notification(title, {
      body: body,
      icon: '/icons/icon-192.png',
      tag: 'stock-alert'
    });
  } catch (e) {
    console.error('Notification failed:', e);
  }
}

/**
 * 请求通知权限
 */
async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'granted') {
    return 'granted';
  }
  let result = await Notification.requestPermission();
  return result;
}

/**
 * 企业微信机器人 Webhook 推送（Markdown 格式）
 */
async function sendWechatWebhook(webhookUrl, content) {
  if (!webhookUrl) return false;
  try {
    // 使用 no-cors 模式绕过 CORS 限制（不读回包，fire-and-forget）
    await fetch(webhookUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content: content }
      })
    });
    // no-cors 模式下无法读取响应，假设成功
    return true;
  } catch (e) {
    console.error('微信推送请求失败:', e.message);
    return false;
  }
}
