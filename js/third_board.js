// ===== 老三板数据模块 =====
// 数据源: qt.gtimg.cn 实时行情 (OHLCV + 买卖盘 + 流通股本)
// 存储: IndexedDB third_board store, 保留 15 天
// 定时: 交易日 15:40 自动采集

const TB_STOCK_LIST = [
  "400002","400005","400008","400010","400012","400016","400018","400021","400022","400023",
  "400025","400027","400028","400029","400030","400031","400033","400035","400036","400039",
  "400040","400041","400045","400046","400050","400051","400053","400055","400057","400059",
  "400065","400066","400067","400068","400069","400070","400071","400072","400073","400078",
  "400080","400081","400082","400083","400084","400088","400089","400093","400094","400095",
  "400096","400097","400098","400099","400100","400101","400102","400104","400107","400108",
  "400110","400113","400114","400116","400117","400118","400119","400120","400121","400122",
  "400123","400124","400125","400126","400127","400128","400129","400130","400131","400132",
  "400133","400134","400135","400136","400137","400138","400139","400140","400141","400142",
  "400143","400144","400145","400146","400147","400148","400149","400150","400151","400152",
  "400153","400154","400155","400156","400157","400159","400160","400161","400162","400163",
  "400164","400165","400166","400167","400168","400169","400170","400171","400172","400173",
  "400174","400175","400176","400177","400179","400180","400181","400182","400183","400184",
  "400185","400186","400188","400189","400190","400191","400192","400193","400194","400195",
  "400196","400197","400198","400199","400200","400201","400202","400203","400204","400205",
  "400206","400207","400208","400209","400210","400211","400212","400213","400214","400215",
  "400216","400217","400218","400219","400220","400221","400222","400224","400225","400226",
  "400227","400228","400229","400230","400231","400232","400233","400234","400235","400236",
  "400237","400238","400239","400240","400241","400242","400243","400245","400246","400247",
  "400248","400249","400250","400251","400252","400253","400254","400255","400256","400257",
  "400258","400259","400260","400261","400262","400263","400264","400265","400267","400268",
  "400269","400270","400271","400272","400274","400275","400276","400277","400278","400279",
  "400280","400281","400282","400283","400284","400285","400286","400287","400288","400289",
  "400290","400291","420008","420016","420063","420073","420085","420103","420108","420120",
  "420140","420153","420178","420223","420244","420254","420273","420280",
];

// ===== 实时行情采集 =====

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 批量获取实时行情 (最多50只一批)
async function fetchTBQuotesBatch(codes) {
  let cs = codes.map(c => 'nq' + c).join(',');
  let url = 'https://qt.gtimg.cn/q=' + cs;
  try {
    let resp = await fetch(url, { signal: AbortSignal.timeout(15000),
      headers: { 'Referer': 'https://gu.qq.com/' } });
    // 腾讯接口为 GBK 编码，用 TextDecoder 解码
    let buf = await resp.arrayBuffer();
    let text = new TextDecoder('gbk').decode(buf);
    let result = {};
    let lines = text.trim().split('\n');
    for (let line of lines) {
      let m = line.match(/nq(\d{6})/);
      if (!m) continue;
      let code = m[1];
      let parts = line.split('"')[1];
      if (!parts) continue;
      let f = parts.split('~');
      if (f.length < 45) continue;

      let name = (f[1] || '').trim();
      let close = parseFloat(f[3]) || 0;
      let prevClose = parseFloat(f[4]) || 0;
      let open = parseFloat(f[5]) || 0;
      let volume = parseInt(f[6]) || 0;           // 成交量（手）
      let high = parseFloat(f[33]) || close || 0;
      let low = parseFloat(f[34]) || close || 0;
      // 成交额 = 量(手) × 100(股/手) × 收盘价
      let amount = volume ? parseFloat((volume * 100 * close).toFixed(2)) : 0;
      // 流通股本：腾讯接口位置不固定，扫描尾部连续大数
      let circulateShares = 0;
      for (let i = f.length - 1; i >= 50; i--) {
        let v = parseFloat(f[i]);
        if (v > 1000000) { circulateShares = Math.round(v); break; }
      }

      // 买盘5档
      let buyVol = 0;
      for (let v = 0; v < 5; v++) {
        let idx = 10 + v * 2;
        buyVol += (parseInt(f[idx]) || 0);
      }
      // 卖盘5档
      let sellVol = 0;
      for (let v = 0; v < 5; v++) {
        let idx = 20 + v * 2;
        sellVol += (parseInt(f[idx]) || 0);
      }

      let changePct = prevClose > 0 ? parseFloat(((close - prevClose) / prevClose * 100).toFixed(2)) : 0;
      let mktcapFloat = circulateShares > 0 ? parseFloat((close * circulateShares).toFixed(2)) : 0;

      // 从 API 解析实际交易日期 (f[30] = YYYYMMDDHHMMSS)
      let tradeDate = '';
      if (f[30] && f[30].length >= 8) {
        let td = f[30];
        tradeDate = td.slice(0, 4) + '-' + td.slice(4, 6) + '-' + td.slice(6, 8);
      }

      result[code] = { code, name, open, high, low, close, volume, amount,
        change_pct: changePct, buy_vol: buyVol, sell_vol: sellVol,
        mktcap_float: mktcapFloat, mktcap_total: 0, circulate_shares: circulateShares,
        _tradeDate: tradeDate };
    }
    return result;
  } catch(e) {
    console.log('实时行情批量获取失败:', e.message);
    return {};
  }
}

// 获取最新交易日行情（周末/节假日自动获取最近交易日）
async function collectThirdBoardToday() {
  // 先采集一批确定实际交易日期
  let sample = await fetchTBQuotesBatch(TB_STOCK_LIST.slice(0, 10));
  let tradeDate = '';
  for (let k in sample) {
    if (sample[k]._tradeDate) { tradeDate = sample[k]._tradeDate; break; }
  }
  if (!tradeDate) {
    // 兜底：用今天
    tradeDate = new Date().toISOString().slice(0, 10);
  }

  // 已存在的检查（按实际交易日期查）
  let existing = await getThirdBoardByDate(tradeDate);
  if (existing.length >= 100) {
    console.log('老三板', tradeDate, '数据已存在:', existing.length, '条，跳过');
    return { success: true, reason: 'already', count: existing.length, date: tradeDate };
  }

  console.log('开始采集老三板行情，实际交易日期:', tradeDate);
  let start = Date.now();
  let all = { ...sample };

  let batchSize = 50;
  for (let i = 10; i < TB_STOCK_LIST.length; i += batchSize) {
    let batch = TB_STOCK_LIST.slice(i, i + batchSize);
    let result = await fetchTBQuotesBatch(batch);
    Object.assign(all, result);
    console.log('  进度:', Object.keys(all).length, '/', TB_STOCK_LIST.length);
    if (i + batchSize < TB_STOCK_LIST.length) await _sleep(400);
  }

  // 过滤无效行
  let rows = [];
  for (let code of TB_STOCK_LIST) {
    let r = all[code];
    if (!r) continue;
    if (r.open === 0 && r.high === 0 && r.low === 0) continue; // 未交易
    r.date = tradeDate;
    r.id = tradeDate + '_' + code;
    delete r._tradeDate;
    rows.push(r);
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));

  if (rows.length > 0) {
    await saveThirdBoardRows(rows);
  }

  // 总股本（可选）
  try {
    let totalSharesPatched = 0;
    for (let r of rows) {
      try {
        let ts = await fetchTBTotalShares(r.code);
        if (ts > 0) {
          r.mktcap_total = parseFloat((r.close * ts).toFixed(2));
          r.id = tradeDate + '_' + r.code;
          totalSharesPatched++;
        }
        await _sleep(100);
      } catch(e) { /* skip */ }
    }
    if (totalSharesPatched > 0) {
      await saveThirdBoardRows(rows);
      console.log('  总市值更新:', totalSharesPatched, '只');
    }
  } catch(e) { /* skip */ }

  let elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('老三板采集完成:', rows.length, '只, 实际日期:', tradeDate, ', 耗时:', elapsed, 's');

  await clearThirdBoardBefore(15);

  return { success: true, count: rows.length, date: tradeDate, elapsed };
}

// 获取总股本（东方财富）
async function fetchTBTotalShares(code) {
  try {
    let url = 'https://datacenter-web.eastmoney.com/api/data/v1/get' +
      '?reportName=RPT_F10_FINANCE_MAINFINADATA' +
      '&columns=SECURITY_CODE,TOTAL_SHARE' +
      '&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1' +
      '&filter=(SECURITY_CODE=%22' + code + '%22)';
    let resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    let data = await resp.json();
    let items = data && data.result && data.result.data;
    return items && items[0] && items[0].TOTAL_SHARE ? parseFloat(items[0].TOTAL_SHARE) : 0;
  } catch(e) { return 0; }
}

// ===== 初始化 & 增量  =====

async function initThirdBoardData() {
  let existingDates = await getThirdBoardAvailableDates();
  console.log('老三板数据库已有:', existingDates.length, '天');

  // 始终尝试采集（周末自动获取最近交易日数据）
  let result = await collectThirdBoardToday();
  if (result.success && result.date && !existingDates.includes(result.date)) {
    existingDates = await getThirdBoardAvailableDates();
  }

  await clearThirdBoardBefore(15);

  return existingDates;
}

// ===== API接口 =====

async function apiThirdBoardByDate(dateStr) {
  return await getThirdBoardByDate(dateStr);
}

async function apiThirdBoardByCode(code) {
  return await getThirdBoardByCode(code);
}

async function apiThirdBoardDates() {
  return await getThirdBoardAvailableDates();
}

// CSV导出（按日期）
async function exportThirdBoardCSV(dateStr) {
  let rows = await getThirdBoardByDate(dateStr);
  if (!rows.length) return null;
  let headers = ['代码','名称','开盘','最高','最低','收盘','成交量(手)','成交额(元)','涨跌幅(%)','买量(手)','卖量(手)','流通市值(元)','总市值(元)'];
  let csv = '\uFEFF' + headers.join(',') + '\n';
  for (let r of rows) {
    csv += [r.code, r.name, r.open, r.high, r.low, r.close, r.volume, r.amount,
      r.change_pct, r.buy_vol, r.sell_vol, r.mktcap_float, r.mktcap_total
    ].map(v => v != null ? v : '').join(',') + '\n';
  }
  return csv;
}

// 全文导出（所有日期）
async function exportThirdBoardAllCSV() {
  let records = await getThirdBoardAllRecords();
  let headers = ['日期','代码','名称','开盘','最高','最低','收盘','成交量(手)','成交额(元)','涨跌幅(%)','买量(手)','卖量(手)','流通市值(元)','总市值(元)'];
  let csv = '\uFEFF' + headers.join(',') + '\n';
  for (let r of records) {
    csv += [r.date, r.code, r.name, r.open, r.high, r.low, r.close, r.volume, r.amount,
      r.change_pct, r.buy_vol, r.sell_vol, r.mktcap_float, r.mktcap_total
    ].map(v => v != null ? v : '').join(',') + '\n';
  }
  return csv;
}
