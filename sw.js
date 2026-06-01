// Service Worker - 自选股价格监控 PWA
const CACHE_NAME = 'stock-monitor-v1';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/utils.js',
  '/js/db.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/charts.js',
  '/js/csv.js',
  '/js/notifications.js',
  '/js/app.js',
  '/manifest.json'
];

// 安装：预缓存静态资源
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// 激活：清理旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// 网络优先策略（API请求不缓存）
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 跳过非GET请求
  if (event.request.method !== 'GET') return;

  // API请求使用网络优先，不缓存
  if (url.pathname.includes('/api/') ||
      url.hostname.includes('qt.gtimg.cn') ||
      url.hostname.includes('push2his.eastmoney.com') ||
      url.hostname.includes('hq.sinajs.cn')) {
    return;
  }

  // 静态资源：缓存优先，网络回退
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// 推送通知
self.addEventListener('push', (event) => {
  if (!event.data) return;

  const data = event.data.json();
  const options = {
    body: data.body || '股票价格提醒',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [200, 100, 200],
    tag: data.tag || 'stock-alert',
    data: data.url || '/',
    requireInteraction: true
  };

  event.waitUntil(
    self.registration.showNotification(data.title || '自选股提醒', options)
  );
});

// 通知点击
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data || '/');
      }
    })
  );
});

// 后台定时同步（Android Chrome 锁屏也会触发）
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'stock-check') {
    event.waitUntil(runBackgroundCheck());
  }
});

async function runBackgroundCheck() {
  try {
    let clients = await self.clients.matchAll({ type: 'window' });
    // 如果有打开的窗口，发消息让前台处理
    if (clients.length > 0) {
      clients[0].postMessage({ type: 'trigger-check' });
      return;
    }

    // 无打开窗口：SW 自行处理
    // 打开 IndexedDB 读取配置
    let db = await openStockDB();
    let settings = await getSettingsFromDB(db);
    if (!settings || !settings.webhook_url) {
      db.close();
      return;
    }

    // 获取自动检查的时间点
    let checkTimes = [];
    try { checkTimes = JSON.parse(settings.schedule_times || '[]'); } catch(e) {}
    let now = new Date();
    let hours = now.getHours().toString().padStart(2, '0');
    let mins = now.getMinutes().toString().padStart(2, '0');
    let currentTime = hours + ':' + mins;
    
    // 只检查 ±1 分钟内的设置时间
    let shouldCheck = checkTimes.some(t => {
      let [th, tm] = t.split(':').map(Number);
      return Math.abs(now.getHours() - th) === 0 && Math.abs(now.getMinutes() - tm) <= 1;
    });
    if (!shouldCheck) { db.close(); return; }

    // 读取股票列表
    let stocks = await getAllStocksFromDB(db);
    if (!stocks || stocks.length === 0) { db.close(); return; }
    db.close();

    // 获取行情
    let quotes = await fetchStockQuotesSW(stocks.map(s => s.code));
    
    // 检查阈值并推送
    let alerts = checkThresholdsSW(stocks, quotes, settings);
    if (alerts.length === 0) return;

    // 发送微信 webhook
    let nowStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    let wxLines = alerts.map(a => '- **' + a.name + '**（' + a.code + '）：<font color="info">' + a.value + '</font>').join('\n');
    let wxContent = '## 📈 股票后台提醒\n> 触发时间：' + nowStr + '\n> 触发数量：<font color="warning">' + alerts.length + '</font> 只\n\n' + wxLines;
    
    await fetch(settings.webhook_url, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content: wxContent } })
    });

    // 浏览器通知
    self.registration.showNotification('股票提醒', {
      body: alerts.map(a => a.name + ': ' + a.value).join(', '),
      icon: '/icons/icon-192.png',
      requireInteraction: true
    });
  } catch (e) {
    console.error('后台检查失败:', e);
  }
}

// === SW 内嵌的轻量检查逻辑 ===

function openStockDB() {
  return new Promise((resolve, reject) => {
    let request = indexedDB.open('StockMonitorDB', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = (e) => {
      let db = e.target.result;
      if (!db.objectStoreNames.contains('stocks')) db.createObjectStore('stocks', { keyPath: 'code' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
    };
  });
}

function getSettingsFromDB(db) {
  return new Promise((resolve) => {
    let tx = db.transaction('settings', 'readonly');
    let store = tx.objectStore('settings');
    let req = store.get('user_settings');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function getAllStocksFromDB(db) {
  return new Promise((resolve) => {
    let tx = db.transaction('stocks', 'readonly');
    let store = tx.objectStore('stocks');
    let req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve([]);
  });
}

async function fetchStockQuotesSW(codes) {
  // 用东方财富 API（简单快速）
  let codeStr = codes.join(',');
  let url = 'https://push2his.eastmoney.com/api/qt/ulist.np/get?fltt=2&fields=f2,f3,f12,f14&secids=' + 
    codes.map(c => {
      if (c.startsWith('6') || c.startsWith('68') || c.startsWith('9')) return '1.' + c;
      return '0.' + c;
    }).join(',');
  
  try {
    let resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    let data = await resp.json();
    if (!data || !data.data || !data.data.diff) return [];
    return data.data.diff.map(d => ({
      code: d.f12,
      name: d.f14,
      last_px: d.f2 ? parseFloat(d.f2) / 100 : 0,
      px_change_rate: d.f3 || 0
    }));
  } catch(e) {
    console.error('SW行情获取失败:', e.message);
    return [];
  }
}

function checkThresholdsSW(stocks, quotes, settings) {
  let alerts = [];
  let watchlistThreshold = settings.watchlist_multiple_threshold || 0.9;
  let holdingsRateThreshold = settings.holdings_rate_threshold || 1.0;
  let holdingsBuyThreshold = settings.holdings_buy_ratio_threshold || 0.9;

  for (let stock of stocks) {
    let quote = quotes.find(q => {
      let sc = stock.code.replace(/[^0-9]/g, '');
      let qc = (q.code || '').replace(/[^0-9]/g, '');
      return sc === qc;
    });
    if (!quote || !quote.last_px) continue;

    if (stock.stock_type === 'watchlist' && stock.buy_price) {
      let multiple = quote.last_px / stock.buy_price;
      if (multiple <= watchlistThreshold) {
        alerts.push({ name: stock.name, code: stock.code.replace(/[^0-9]/g, ''), value: multiple.toFixed(2) });
      }
    } else if (stock.stock_type === 'holdings') {
      if (stock.target_price) {
        let rate = quote.last_px / stock.target_price;
        if (rate >= holdingsRateThreshold) {
          alerts.push({ name: stock.name, code: stock.code.replace(/[^0-9]/g, ''), value: rate.toFixed(2) });
        }
      }
      if (stock.buy_price) {
        let multiple = quote.last_px / stock.buy_price;
        if (multiple <= holdingsBuyThreshold) {
          alerts.push({ name: stock.name, code: stock.code.replace(/[^0-9]/g, ''), value: multiple.toFixed(2) });
        }
      }
    }
  }
  return alerts;
}
