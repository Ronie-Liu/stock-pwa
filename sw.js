// Service Worker - 自选股价格监控 PWA
// 🔄 网络优先策略：确保每次打开都获取最新代码
const CACHE_NAME = 'stock-monitor-v15';

// 需要缓存的路径（离线回退用）
const CACHE_WHITELIST = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// 安装：跳过等待，立即激活
self.addEventListener('install', () => {
  self.skipWaiting();
});

// 激活：清理所有旧缓存，确保干净状态
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(keys.map((key) => caches.delete(key)));
    }).then(() => {
      // 通知所有打开的页面刷新
      return self.clients.matchAll({ type: 'window' }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'SW_UPDATED' }));
        return self.clients.claim();
      });
    })
  );
});

// 网络优先策略：HTML/JS/CSS 始终从网络获取，失败才用缓存
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;

  // API请求不走SW
  if (url.hostname.includes('qt.gtimg.cn') ||
      url.hostname.includes('eastmoney.com') ||
      url.hostname.includes('hq.sinajs.cn') ||
      url.hostname.includes('ifzq.gtimg.cn') ||
      url.hostname.includes('web.ifzq.gtimg.cn') ||
      url.pathname.includes('/api/') ||
      url.hostname.includes('qyapi.weixin.qq.com')) {
    return;
  }

  // 核心资源：网络优先，失败才用缓存
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' }).then((response) => {
      if (response && response.status === 200) {
        let clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => {
      return caches.match(event.request);
    })
  );
});

// SW更新通知 → 客户端自动刷新
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 推送通知
self.addEventListener('push', (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || '自选股提醒', {
      body: data.body || '股票价格提醒',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      vibrate: [200, 100, 200],
      tag: data.tag || 'stock-alert',
      data: data.url || '/',
      requireInteraction: true
    })
  );
});

// 通知点击
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(event.notification.data || '/');
    })
  );
});
