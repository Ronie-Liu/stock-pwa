// ===== IndexedDB 数据库层 =====
// 本地存储：stocks表、app_settings表、task_logs表

const DB_NAME = 'StockMonitorDB';
const DB_VERSION = 3;
const STOCKS_STORE = 'stocks';
const SETTINGS_STORE = 'app_settings';
const LOGS_STORE = 'task_logs';
const MARKET_STORE = 'market_data';
const THIRD_BOARD_STORE = 'third_board';

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    let request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      let database = e.target.result;
      // stocks 表
      if (!database.objectStoreNames.contains(STOCKS_STORE)) {
        let store = database.createObjectStore(STOCKS_STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('stock_type', 'stock_type', { unique: false });
        store.createIndex('code', 'code', { unique: false });
      }
      // app_settings 表
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
        database.createObjectStore(SETTINGS_STORE, { keyPath: 'id' });
      }
      // task_logs 表
      if (!database.objectStoreNames.contains(LOGS_STORE)) {
        let logStore = database.createObjectStore(LOGS_STORE, { keyPath: 'id', autoIncrement: true });
        logStore.createIndex('triggered_at', 'triggered_at', { unique: false });
      }
      // market_data 表（上证指数历史K线+衍生字段）
      if (!database.objectStoreNames.contains(MARKET_STORE)) {
        let mktStore = database.createObjectStore(MARKET_STORE, { keyPath: 'date' });
        mktStore.createIndex('date_idx', 'date', { unique: true });
      }
      // third_board 表（老三板每日行情，复合主键 date+code）
      if (!database.objectStoreNames.contains(THIRD_BOARD_STORE)) {
        let tbStore = database.createObjectStore(THIRD_BOARD_STORE, { keyPath: 'id' });
        tbStore.createIndex('date_idx', 'date', { unique: false });
        tbStore.createIndex('code_idx', 'code', { unique: false });
      }
    };
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = (e) => {
      reject(e.target.error);
    };
  });
}

function getStore(storeName, mode = 'readonly') {
  let tx = db.transaction(storeName, mode);
  return tx.objectStore(storeName);
}

// ===== Stocks CRUD =====

async function getAllStocks(type) {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(STOCKS_STORE);
    let req = store.index('stock_type').getAll(type || IDBKeyRange.only(type));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function addStock(stock) {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(STOCKS_STORE, 'readwrite');
    let data = {
      code: stock.code || '',
      name: stock.name || '',
      buy_price: stock.buy_price || null,
      buy_time: stock.buy_time || null,
      personal_note: stock.personal_note || null,
      stock_type: stock.stock_type || 'watchlist',
      target_price: stock.target_price || null,
      created_at: stock.created_at || new Date().toISOString()
    };
    let req = store.add(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function updateStock(id, updates) {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(STOCKS_STORE, 'readwrite');
    let reqGet = store.get(id);
    reqGet.onsuccess = () => {
      let stock = reqGet.result;
      if (!stock) return reject(new Error('Stock not found'));
      Object.assign(stock, updates);
      let reqPut = store.put(stock);
      reqPut.onsuccess = () => resolve(reqPut.result);
      reqPut.onerror = () => reject(reqPut.error);
    };
    reqGet.onerror = () => reject(reqGet.error);
  });
}

async function deleteStock(id) {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(STOCKS_STORE, 'readwrite');
    let req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getStockCount(type) {
  let stocks = await getAllStocks(type);
  return stocks.length;
}

async function clearStocksByType(type) {
  await openDB();
  let stocks = await getAllStocks(type);
  let store = getStore(STOCKS_STORE, 'readwrite');
  for (let s of stocks) {
    store.delete(s.id);
  }
  return stocks.length;
}

// ===== Settings CRUD =====

async function getSettings() {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(SETTINGS_STORE);
    let req = store.get(1);
    req.onsuccess = () => {
      if (req.result) {
        resolve(req.result);
      } else {
        // 返回默认设置（需要在新的readwrite事务中初始化）
        let defaults = {
          id: 1,
          watchlist_multiple_threshold: 0.9,
          holdings_rate_threshold: 1.0,
          holdings_buy_ratio_threshold: 0.9,
          theme: 'dark',
          schedule_times: JSON.stringify(["10:00","11:00","11:40","14:00","14:30","14:50","15:10"]),
          jpush_reg_id: ''
        };
        let rwStore = getStore(SETTINGS_STORE, 'readwrite');
        let putReq = rwStore.put(defaults);
        putReq.onsuccess = () => resolve(defaults);
        putReq.onerror = () => reject(putReq.error);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

async function saveSettings(updates) {
  await openDB();
  return new Promise(async (resolve, reject) => {
    let current = await getSettings();
    Object.assign(current, updates, { updated_at: new Date().toISOString() });
    let store = getStore(SETTINGS_STORE, 'readwrite');
    let req = store.put(current);
    req.onsuccess = () => resolve(current);
    req.onerror = () => reject(req.error);
  });
}

// ===== Task Logs CRUD =====

async function addLog(log) {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(LOGS_STORE, 'readwrite');
    let data = {
      triggered_at: log.triggered_at || new Date().toISOString(),
      trigger_type: log.trigger_type || 'manual',
      status: log.status || 'pending',
      summary: log.summary || null,
      error_msg: log.error_msg || null,
      notes: log.notes || null
    };
    let req = store.add(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getRecentLogs(limit = 10) {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(LOGS_STORE);
    let req = store.index('triggered_at').openCursor(null, 'prev');
    let logs = [];
    req.onsuccess = (e) => {
      let cursor = e.target.result;
      if (cursor && logs.length < limit) {
        logs.push(cursor.value);
        cursor.continue();
      } else {
        resolve(logs);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

async function clearAllLogs() {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(LOGS_STORE, 'readwrite');
    let req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ===== Market Data (上证指数历史K线+衍生字段) =====

async function getMarketCount() {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(MARKET_STORE);
    let req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(0);
  });
}

async function getLatestMarketDate() {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(MARKET_STORE);
    let req = store.index('date_idx').openCursor(null, 'prev');
    req.onsuccess = (e) => {
      let cursor = e.target.result;
      resolve(cursor ? cursor.value.date : null);
    };
    req.onerror = () => resolve(null);
  });
}

async function saveMarketRecords(rows) {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(MARKET_STORE, 'readwrite');
    let count = 0, total = rows.length;
    if (total === 0) { resolve(0); return; }
    for (let r of rows) {
      let req = store.put(r);
      req.onsuccess = () => { count++; if (count >= total) resolve(total); };
      req.onerror = () => reject(req.error);
    }
  });
}

async function getMarketRecords(limit = 20) {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(MARKET_STORE);
    let results = [];
    let req = store.index('date_idx').openCursor(null, 'prev');
    req.onsuccess = (e) => {
      let cursor = e.target.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = () => resolve([]);
  });
}

async function getAllMarketRecords() {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(MARKET_STORE);
    let results = [];
    let req = store.index('date_idx').openCursor();
    req.onsuccess = (e) => {
      let cursor = e.target.result;
      if (cursor) { results.push(cursor.value); cursor.continue(); }
      else { resolve(results.sort((a, b) => a.date < b.date ? -1 : 1)); }
    };
    req.onerror = () => resolve([]);
  });
}

async function clearMarketData() {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(MARKET_STORE, 'readwrite');
    let req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ===== Third Board（老三板每日行情） =====

async function saveThirdBoardRows(rows) {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(THIRD_BOARD_STORE, 'readwrite');
    let count = 0, total = rows.length;
    if (total === 0) { resolve(0); return; }
    for (let r of rows) {
      let req = store.put(r);
      req.onsuccess = () => { count++; if (count >= total) resolve(total); };
      req.onerror = () => reject(req.error);
    }
  });
}

async function getThirdBoardByDate(dateStr) {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(THIRD_BOARD_STORE);
    let req = store.index('date_idx').getAll(IDBKeyRange.only(dateStr));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function getThirdBoardByCode(code) {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(THIRD_BOARD_STORE);
    let req = store.index('code_idx').getAll(IDBKeyRange.only(code));
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function getThirdBoardAvailableDates() {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(THIRD_BOARD_STORE);
    let dates = new Set();
    let req = store.index('date_idx').openCursor(null, 'next');
    req.onsuccess = (e) => {
      let cursor = e.target.result;
      if (cursor) { dates.add(cursor.value.date); cursor.continue(); }
      else { resolve([...dates].sort().reverse()); }
    };
    req.onerror = () => resolve([]);
  });
}

async function clearThirdBoardBefore(days = 15) {
  let cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  let cutoffStr = cutoff.toISOString().slice(0, 10);
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(THIRD_BOARD_STORE, 'readwrite');
    let index = store.index('date_idx');
    let range = IDBKeyRange.upperBound(cutoffStr, true);
    let req = index.openCursor(range);
    let deleted = 0;
    req.onsuccess = (e) => {
      let cursor = e.target.result;
      if (cursor) { cursor.delete(); deleted++; cursor.continue(); }
      else { resolve(deleted); }
    };
    req.onerror = () => reject(req.error);
  });
}

async function getThirdBoardAllRecords() {
  await openDB();
  return new Promise((resolve, reject) => {
    let store = getStore(THIRD_BOARD_STORE);
    let results = [];
    let req = store.openCursor();
    req.onsuccess = (e) => {
      let cursor = e.target.result;
      if (cursor) { results.push(cursor.value); cursor.continue(); }
      else { resolve(results); }
    };
    req.onerror = () => resolve([]);
  });
}
