// ===== 老三板数据模块 =====
// 数据源: /data/third_board/老三板YYYYMMDD.csv（由 collect_third_board.py 生成）
// 存储: IndexedDB third_board store（复合主键 date+code）
// 自动保留最近 15 个交易日

const TB_CSV_BASE = '/data/third_board';

// 生成最近N个自然日的日期列表（用于尝试加载CSV）
function generateDateList(days = 15) {
  let dates = [];
  let d = new Date();
  for (let i = 0; i < days; i++) {
    let ds = d.toISOString().slice(0, 10);
    dates.push(ds);
    d.setDate(d.getDate() - 1);
  }
  return dates;
}

// 解析CSV行，返回标准化对象
function parseThirdBoardRow(row) {
  // CSV列: 代码,名称,开盘,最高,最低,收盘,成交量(手),成交额(元),涨跌幅(%),买量(手),卖量(手),流通市值(元),总市值(元)
  let code = (row[0] || '').trim();
  if (!code || code === '代码') return null;
  return {
    code: code,
    name: (row[1] || '').trim(),
    open: parseFloat(row[2]) || 0,
    high: parseFloat(row[3]) || 0,
    low: parseFloat(row[4]) || 0,
    close: parseFloat(row[5]) || 0,
    volume: parseInt(row[6]) || 0,
    amount: parseFloat(row[7]) || 0,
    change_pct: parseFloat(row[8]) || 0,
    buy_vol: parseInt(row[9]) || 0,
    sell_vol: parseInt(row[10]) || 0,
    mktcap_float: parseFloat(row[11]) || 0,
    mktcap_total: parseFloat(row[12]) || 0
  };
}

// 尝试从服务器拉取指定日期的CSV
async function fetchThirdBoardCSV(dateStr) {
  let fileDate = dateStr.replace(/-/g, '');
  let url = TB_CSV_BASE + '/老三板' + fileDate + '.csv';
  try {
    let resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) return null;
    let text = await resp.text();
    let lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    let rows = [];
    for (let i = 1; i < lines.length; i++) {
      let cols = parseCSVLine(lines[i]);
      if (!cols.length) continue;
      let parsed = parseThirdBoardRow(cols);
      if (parsed) {
        parsed.date = dateStr;
        parsed.id = dateStr + '_' + parsed.code;
        rows.push(parsed);
      }
    }
    return rows;
  } catch (e) {
    console.log('老三板CSV获取失败:', dateStr, e.message);
    return null;
  }
}

// CSV行解析（处理逗号分隔，简单实现）
function parseCSVLine(line) {
  let cols = [];
  let current = '';
  let inQuotes = false;
  for (let ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { cols.push(current); current = ''; continue; }
    current += ch;
  }
  cols.push(current);
  return cols;
}

// 初始化老三板数据（启动时调用）
async function initThirdBoardData() {
  let dates = await getThirdBoardAvailableDates();
  console.log('老三板数据库已有:', dates.length, '个交易日');

  // 查找最近15天内缺失的日期
  let allDates = generateDateList(15);
  let missing = allDates.filter(d => !dates.includes(d));

  if (missing.length > 0) {
    console.log('加载缺失的三板数据:', missing.length, '个日期');
    let loaded = 0;
    for (let d of missing) {
      let rows = await fetchThirdBoardCSV(d);
      if (rows && rows.length > 0) {
        await saveThirdBoardRows(rows);
        loaded++;
      }
    }
    console.log('老三板数据加载完成:', loaded, '个新日期');
  }

  // 清理15天前的数据
  let deleted = await clearThirdBoardBefore(15);
  if (deleted > 0) console.log('过期老三板数据清理:', deleted, '条');

  return await getThirdBoardAvailableDates();
}

// ===== API接口 =====

// 获取指定日期的老三板行情（JSON数组）
async function apiThirdBoardByDate(dateStr) {
  return await getThirdBoardByDate(dateStr);
}

// 获取指定股票的跨日行情
async function apiThirdBoardByCode(code) {
  return await getThirdBoardByCode(code);
}

// 获取所有可用日期
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
