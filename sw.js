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
