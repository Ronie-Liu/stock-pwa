// ===== 老三板数据模块 =====
// 行情: qt.gtimg.cn (OHLCV + 买卖盘)
// 股本: 东方财富 RPT_F10_FINANCE_MAINFINADATA → 缓存 IndexedDB tb_shares_cache
// 存储: IndexedDB third_board store, 保留 15 天

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

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== 腾讯实时行情 (OHLCV + 买卖盘) =====

async function fetchTBQuotesBatch(codes) {
  let cs = codes.map(c => 'nq' + c).join(',');
  try {
    let resp = await fetch('https://qt.gtimg.cn/q=' + cs, {
      signal: AbortSignal.timeout(15000),
      headers: { 'Referer': 'https://gu.qq.com/' }
    });
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
      if (f.length < 38) continue;

      let name = (f[1] || '').trim();
      let close = parseFloat(f[3]) || 0;
      let prevClose = parseFloat(f[4]) || 0;
      let open = parseFloat(f[5]) || 0;
      let volume = parseInt(f[6]) || 0;
      let high = parseFloat(f[33]) || close || 0;
      let low = parseFloat(f[34]) || close || 0;
      let amount = volume ? parseFloat((volume * 100 * close).toFixed(2)) : 0;

      let buyVol = 0, sellVol = 0;
      for (let v = 0; v < 5; v++) { buyVol += (parseInt(f[10 + v*2]) || 0); }
      for (let v = 0; v < 5; v++) { sellVol += (parseInt(f[20 + v*2]) || 0); }

      let changePct = prevClose > 0 ? parseFloat(((close - prevClose) / prevClose * 100).toFixed(2)) : 0;

      let tradeDate = '';
      if (f[30] && f[30].length >= 8) {
        let td = f[30];
        tradeDate = td.slice(0, 4) + '-' + td.slice(4, 6) + '-' + td.slice(6, 8);
      }

      result[code] = { code, name, open, high, low, close, volume, amount,
        change_pct: changePct, buy_vol: buyVol, sell_vol: sellVol,
        mktcap_float: 0, mktcap_total: 0, _tradeDate: tradeDate };
    }
    return result;
  } catch(e) { console.log('行情批量获取失败:', e.message); return {}; }
}

// ===== 东方财富股本 =====

async function fetchEastMoneyShares(code) {
  try {
    let url = 'https://datacenter-web.eastmoney.com/api/data/v1/get' +
      '?reportName=RPT_F10_FINANCE_MAINFINADATA' +
      '&columns=SECURITY_CODE,A_FREE_SHARE,B_FREE_SHARE,TOTAL_SHARE' +
      '&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1' +
      '&filter=(SECURITY_CODE=%22' + code + '%22)';
    let resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    let data = await resp.json();
    let items = data && data.result && data.result.data;
    if (items && items[0]) {
      let aFree = parseFloat(items[0].A_FREE_SHARE) || 0;
      let bFree = parseFloat(items[0].B_FREE_SHARE) || 0;
      let totalS = parseFloat(items[0].TOTAL_SHARE) || 0;
      let freeS = aFree + bFree; // 流通股本 = A股流通 + B股流通
      if (freeS > 0 || totalS > 0) return { free_shares: Math.round(freeS), total_shares: Math.round(totalS) };
    }
    return null;
  } catch(e) { return null; }
}

// 预加载所有需要的股本数据（缓存优先，缺失的逐个拉取）
async function ensureSharesCache() {
  let missing = [];
  for (let code of TB_STOCK_LIST) {
    let cached = await getCachedShares(code);
    if (!cached || !cached.free_shares) { missing.push(code); }
  }
  if (!missing.length) { console.log('股本缓存完整:', TB_STOCK_LIST.length, '只'); return; }

  console.log('股本缓存缺失:', missing.length, '只，从东方财富拉取...');
  let fetched = 0;
  for (let code of missing) {
    let shares = await fetchEastMoneyShares(code);
    if (shares && (shares.free_shares > 0 || shares.total_shares > 0)) {
      await saveCachedShares(code, shares.free_shares, shares.total_shares);
      fetched++;
    }
    await _sleep(150);
  }
  console.log('股本拉取完成:', fetched, '/', missing.length);
}

// 用缓存股本计算市值
// 流通市值 = 收盘价 × (A_FREE_SHARE + B_FREE_SHARE)
// 总市值   = 收盘价 × TOTAL_SHARE
async function applySharesToRows(rows) {
  let appliedFloat = 0, appliedTotal = 0;
  for (let r of rows) {
    let cached = await getCachedShares(r.code);
    if (cached && cached.free_shares > 0) {
      r.mktcap_float = parseFloat((r.close * cached.free_shares).toFixed(2));
      appliedFloat++;
    }
    if (cached && cached.total_shares > 0) {
      r.mktcap_total = parseFloat((r.close * cached.total_shares).toFixed(2));
      appliedTotal++;
    }
  }
  console.log('市值计算: 流通' + appliedFloat + ' 总' + appliedTotal + ' /', rows.length);
}

// ===== 主采集流程 =====

async function collectThirdBoardToday() {
  // 先检查云端是否已有今天数据（优先从JSON加载，避免重复采集）
  let existing = await getThirdBoardByDate(new Date().toISOString().slice(0, 10));
  if (existing.length >= 100) {
    console.log('老三板今日已存在:', existing.length, '条，跳过');
    return { success: true, reason: 'already', count: existing.length, date: new Date().toISOString().slice(0, 10) };
  }

  // 采集前10只确定实际交易日期
  let sample = await fetchTBQuotesBatch(TB_STOCK_LIST.slice(0, 10));
  let tradeDate = '';
  for (let k in sample) {
    if (sample[k]._tradeDate) { tradeDate = sample[k]._tradeDate; break; }
  }
  if (!tradeDate) tradeDate = new Date().toISOString().slice(0, 10);

  // 再查一次按实际日期
  existing = await getThirdBoardByDate(tradeDate);
  if (existing.length >= 100) {
    console.log('老三板', tradeDate, '已存在:', existing.length, '条，跳过');
    return { success: true, reason: 'already', count: existing.length, date: tradeDate };
  }

  console.log('老三板采集开始:', tradeDate);
  let start = Date.now();
  let all = { ...sample };

  // 1) 拉取行情（与股本拉取并行）
  let quotePromise = (async () => {
    for (let i = 10; i < TB_STOCK_LIST.length; i += 50) {
      let batch = TB_STOCK_LIST.slice(i, i + 50);
      let result = await fetchTBQuotesBatch(batch);
      Object.assign(all, result);
      console.log('  行情进度:', Object.keys(all).length, '/', TB_STOCK_LIST.length);
      if (i + 50 < TB_STOCK_LIST.length) await _sleep(400);
    }
  })();

  let sharesPromise = ensureSharesCache();

  await Promise.all([quotePromise, sharesPromise]);

  // 3) 组装行
  let rows = [];
  for (let code of TB_STOCK_LIST) {
    let r = all[code];
    if (!r || (r.open === 0 && r.high === 0 && r.low === 0)) continue;
    r.date = tradeDate;
    r.id = tradeDate + '_' + code;
    delete r._tradeDate;
    rows.push(r);
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));

  // 4) 计算市值
  await applySharesToRows(rows);

  // 5) 存库
  if (rows.length > 0) await saveThirdBoardRows(rows);

  let elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log('老三板采集完成:', rows.length, '只, 日期:', tradeDate, ', 耗时:', elapsed, 's');

  await clearThirdBoardBefore(15);
  return { success: true, count: rows.length, date: tradeDate, elapsed };
}

// ===== 初始化 =====

const TB_JSON_BASE = 'https://raw.githubusercontent.com/Ronie-Liu/stock-pwa/main/data/third_board_json';

// 从 GitHub Pages 加载云函数已采集的历史 JSON（兜底用）
async function loadCloudJson(dateStr) {
  let url = TB_JSON_BASE + '/' + dateStr + '.json';
  try {
    let resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return null;
    let json = await resp.json();
    if (json && json.data && json.data.length > 0) {
      let rows = json.data.map(r => ({
        ...r,
        date: dateStr,
        id: dateStr + '_' + r.code
      }));
      await saveThirdBoardRows(rows);
      console.log('云端JSON加载:', dateStr, rows.length, '条');
      return rows.length;
    }
    return null;
  } catch(e) { return null; }
}

async function initThirdBoardData() {
  let today = new Date().toISOString().slice(0, 10);
  window._tbSource = '';

  // 步骤 1：优先从云端 JSON 加载（不走本地判断 — 云端数据最可靠）
  let cloudLoaded = await loadCloudJson(today);
  if (cloudLoaded) {
    window._tbSource = '☁️ 云端';
    console.log('☁️ 云端 JSON 加载成功:', today, cloudLoaded, '只');
  }

  // 步骤 2：补充历史空缺（云端 JSON）
  let dates = await getThirdBoardAvailableDates();
  for (let i = 1; i <= 15; i++) {
    let d = new Date();
    d.setDate(d.getDate() - i);
    let ds = d.toISOString().slice(0, 10);
    if (dates.includes(ds)) continue;
    let loaded = await loadCloudJson(ds);
    if (loaded) dates = await getThirdBoardAvailableDates();
  }

  // 步骤 3：兜底 — 浏览器实时采集（云端也没数据的日期）
  if (!cloudLoaded) {
    let collectionResult = await collectThirdBoardToday();
    if (collectionResult.success && collectionResult.date) {
      dates = await getThirdBoardAvailableDates();
      if (!window._tbSource) {
        window._tbSource = collectionResult.reason === 'already' ? '☁️ 云端' : '🖥️ 实时';
      }
    }
  } else {
    // 云端已有数据，跳过实时采集
    console.log('☁️ 云端数据已就绪，跳过实时采集');
  }

  await clearThirdBoardBefore(15);
  return await getThirdBoardAvailableDates();
}

// ===== API接口 =====

async function apiThirdBoardByDate(dateStr) { return await getThirdBoardByDate(dateStr); }
async function apiThirdBoardByCode(code) { return await getThirdBoardByCode(code); }
async function apiThirdBoardDates() { return await getThirdBoardAvailableDates(); }

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
