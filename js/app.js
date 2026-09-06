// ===== 主应用控制器 =====

// 全局状态
let currentTab = 'watchlist';
let envSubTab = 'trend';      // 环境页子功能: resonance | liquidity | sentiment | trend | settings
let marketSubTab = 'index';   // 趋势周期子导航: index | third_board
let watchlistStocks = [];
let holdingsStocks = [];
let watchlistQuotes = [];
let holdingsQuotes = [];
let appSettings = null;
let isRefreshing = false;
let confirmingStockId = null;
let confirmingAction = null;

// ===== 初始化 =====

async function initApp() {
  // 加载设置
  appSettings = await getSettings();

  // 应用主题
  applyTheme(appSettings.theme || 'dark');

  // 加载数据
  await loadAllData();

  // 渲染初始页面
  await switchTab('watchlist');

  // 注册Service Worker
  registerSW();

  // 设置全局事件委托
  setupGlobalEvents();

  // 启动定时检查（每分钟检查一次）
  startScheduledCheck();

  // 后台初始化大盘数据（不阻塞UI）
  initMarketData().catch(e => console.log('大盘数据初始化失败:', e));
  // 后台初始化老三板数据，完成后自动刷新老三板页面
  initThirdBoardData().then((r) => {
    console.log('老三板初始化完成:', r);
    // 如果当前正在看环境-趋势周期-老三板，重新渲染
    if (currentTab === 'environment' && envSubTab === 'trend' && marketSubTab === 'third_board') {
      renderEnvironmentTab();
    }
  }).catch(e => console.log('老三板数据初始化失败:', e));
}

// ===== 定时检查 =====
let lastCheckedMinute = null;
let lastTBCollectedDate = null;

function startScheduledCheck() {
  setInterval(async () => {
    let now = new Date();
    let currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

    // --- 老三板独立采集：每日 15:40（周一至周五）---
    if (currentTime === '15:40' && lastTBCollectedDate !== now.toISOString().slice(0,10)) {
      let dw = now.getDay();
      if (dw >= 1 && dw <= 5) {
        lastTBCollectedDate = now.toISOString().slice(0,10);
        console.log('老三板定时采集触发: 15:40');
        collectThirdBoardToday().then(r => console.log('老三板采集结果:', r));
        // 同时刷新大盘数据
        initMarketData().catch(e => {});
      }
    }

    // --- 原有的用户自定义定时推送 ---
    if (!appSettings) return;
    let times = [];
    try { times = JSON.parse(appSettings.schedule_times || '[]'); } catch(e) { times = []; }
    if (times.length === 0) return;

    // 避免同一分钟重复检查
    if (currentTime === lastCheckedMinute) return;
    lastCheckedMinute = currentTime;

    // 检查是否匹配设定的时间
    if (!times.includes(currentTime)) return;

    console.log('定时检查触发:', currentTime);
    await runScheduledCheck();
  }, 30000); // 每30秒检查一次，确保不会错过整点
}

async function runScheduledCheck() {
  try {
    // 获取所有股票
    let allStocks = [...watchlistStocks, ...holdingsStocks];
    if (allStocks.length === 0) return;
    
    let allCodes = allStocks.map(s => s.code);
    let quotes = await fetchStockQuotes(allCodes);
    let alerts = await checkThresholds(allStocks, quotes, appSettings);
    
    if (alerts.length > 0) {
      // 浏览器通知
      let messages = alerts.map(a => a.message).join('\n');
      sendBrowserNotification('股票定时提醒', messages).catch(() => {});
      
      // 微信推送
      if (appSettings.webhook_url) {
        let nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        // 修复：a.message 已经包含股票名，这里只取倍数/达成率部分
        let wxContent = `## 📈 股票定时提醒\n> 触发时间：${nowStr}\n> 触发数量：<font color="warning">${alerts.length}</font> 只\n\n${alerts.map(a => {
          // 从 message 中提取数值部分（去掉前面的股票名）
          let valuePart = a.message.replace(/^[^:]+[:：]/, '').trim();
          return `- **${a.stock.name}**（${extractDigits(a.stock.code)}）：<font color="info">${valuePart}</font>`;
        }).join('\n')}`;
        sendWechatWebhook(appSettings.webhook_url, wxContent).catch(() => {});
      }
      
      // 记录日志
      let summary = alerts.map(a => a.message).join(', ');
      addLog({
        triggered_at: new Date().toISOString(),
        trigger_type: 'schedule',
        status: 'success',
        summary: `定时触发 ${alerts.length} 只: ${summary}`
      });
    } else {
      addLog({
        triggered_at: new Date().toISOString(),
        trigger_type: 'schedule',
        status: 'success',
        summary: '定时检查：无股票触发'
      });
    }
  } catch (e) {
    console.error('定时检查失败:', e);
    addLog({
      triggered_at: new Date().toISOString(),
      trigger_type: 'schedule',
      status: 'error',
      summary: '定时检查失败: ' + e.message
    });
  }
}

// ===== 主题管理 =====

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  let newTheme = appSettings.theme === 'dark' ? 'light' : 'dark';
  appSettings.theme = newTheme;
  applyTheme(newTheme);
  saveSettings({ theme: newTheme });
  // 更新图表主题
  if (klineChart) {
    klineChart.dispose();
    klineChart = null;
    let detailPage = document.getElementById('detail-page');
    if (detailPage && currentKlineData.length > 0) {
      // 需要重新渲染K线
    }
  }
}

// ===== 数据加载 =====

async function loadAllData() {
  watchlistStocks = await getAllStocks('watchlist');
  holdingsStocks = await getAllStocks('holdings');
}

async function refreshCurrentPage() {
  await loadAllData();
  if (currentTab === 'watchlist') {
    await renderWatchlistPage();
  } else if (currentTab === 'holdings') {
    await renderHoldingsPage();
  } else if (currentTab === 'selection') {
    renderSelectionTab();
  } else if (currentTab === 'environment') {
    await renderEnvironmentTab();
  }
}

// ===== 页面切换 =====

async function switchTab(tabId) {
  currentTab = tabId;

  // 更新底部导航激活状态
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tabId);
  });

  // 显示对应页面
  document.querySelectorAll('.page').forEach(el => {
    el.classList.toggle('active', el.id === 'page-' + tabId);
  });

  // 渲染页面内容
  if (tabId === 'watchlist') {
    await renderWatchlistPage();
  } else if (tabId === 'holdings') {
    await renderHoldingsPage();
  } else if (tabId === 'selection') {
    renderSelectionTab();
  } else if (tabId === 'environment') {
    await renderEnvironmentTab();
  }
}

// ===== Tab 1: 自选股监控 =====

async function renderWatchlistPage() {
  let container = document.getElementById('page-watchlist');
  if (!container) return;

  let subtitle = `共 ${watchlistStocks.length} 只自选股`;
  container.innerHTML = renderPageHeader('自选股监控', subtitle,
    `<button class="btn btn-sm btn-primary" id="btn-add-watchlist">＋ 添加</button>
     <button class="btn btn-sm" id="btn-refresh-watchlist">🔄 刷新</button>`
  );

  let listContainer = document.createElement('div');
  listContainer.id = 'watchlist-content';
  container.appendChild(listContainer);

  if (watchlistStocks.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        ${ICONS.empty}
        <p>暂无自选股<br>点击「添加」添加自选股</p>
      </div>`;
  } else {
    listContainer.innerHTML = '<div class="loading-indicator"><span class="spinner"></span> 加载行情中...</div>';
    await refreshWatchlistQuotes();
  }

  // 绑定事件
  bindWatchlistEvents(container);
}

async function refreshWatchlistQuotes() {
  if (watchlistStocks.length === 0) return;

  let listContainer = document.getElementById('watchlist-content');
  if (!listContainer) return;

  let codes = watchlistStocks.map(s => s.code);
  watchlistQuotes = await fetchStockQuotes(codes);

  // 更新副标题
  let successCount = watchlistQuotes.filter(q => !q.error).length;
  let now = new Date();
  let timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  let subtitle = document.getElementById('page-subtitle');
  if (subtitle) {
    subtitle.textContent = `更新于 ${timeStr} · ${successCount}/${codes.length} 成功 · 共 ${watchlistStocks.length} 只`;
  }

  // 排序股票
  let sorted = sortWatchlistStocks(watchlistStocks, watchlistQuotes);

  // 渲染卡片
  listContainer.innerHTML = renderStockList(sorted, watchlistQuotes, false);

  // 重新绑定卡片事件
  bindCardEvents(listContainer, false);
}

function sortWatchlistStocks(stocks, quotes) {
  let quoteMap = new Map();
  quotes.forEach(q => quoteMap.set(q.code, q));

  return [...stocks].sort((a, b) => {
    let qa = quoteMap.get(a.code);
    let qb = quoteMap.get(b.code);

    // 失败的排最后
    let aFailed = !qa || !!qa.error;
    let bFailed = !qb || !!qb.error;
    if (aFailed && !bFailed) return 1;
    if (!aFailed && bFailed) return -1;

    // 今天买入的排最前
    let aToday = isToday(a.buy_time);
    let bToday = isToday(b.buy_time);
    if (aToday && !bToday) return -1;
    if (!aToday && bToday) return 1;

    // 按实时倍数升序
    let aMult = (qa && qa.last_px && a.buy_price) ? qa.last_px / a.buy_price : Infinity;
    let bMult = (qb && qb.last_px && b.buy_price) ? qb.last_px / b.buy_price : Infinity;
    return aMult - bMult;
  });
}

function bindWatchlistEvents(container) {
  let addBtn = container.querySelector('#btn-add-watchlist');
  let refreshBtn = container.querySelector('#btn-refresh-watchlist');

  if (addBtn) {
    addBtn.addEventListener('click', () => showAddStockModal(false));
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      let content = document.getElementById('watchlist-content');
      if (content) {
        content.innerHTML = '<div class="loading-indicator"><span class="spinner"></span> 刷新中...</div>';
      }
      await loadAllData();
      await refreshWatchlistQuotes();
    });
  }
}

// ===== Tab 2: 持仓股管理 =====

async function renderHoldingsPage() {
  let container = document.getElementById('page-holdings');
  if (!container) return;

  let subtitle = `共 ${holdingsStocks.length} 只持仓股`;
  container.innerHTML = renderPageHeader('持仓股管理', subtitle,
    `<button class="btn btn-sm btn-primary" id="btn-add-holdings">＋ 添加</button>
     <button class="btn btn-sm" id="btn-refresh-holdings">🔄 刷新</button>`
  );

  let listContainer = document.createElement('div');
  listContainer.id = 'holdings-content';
  container.appendChild(listContainer);

  if (holdingsStocks.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        ${ICONS.empty}
        <p>暂无持仓股<br>点击「添加」录入持仓信息</p>
      </div>`;
  } else {
    listContainer.innerHTML = '<div class="loading-indicator"><span class="spinner"></span> 加载行情中...</div>';
    await refreshHoldingsQuotes();
  }

  bindHoldingsEvents(container);
}

async function refreshHoldingsQuotes() {
  if (holdingsStocks.length === 0) return;

  let listContainer = document.getElementById('holdings-content');
  if (!listContainer) return;

  let codes = holdingsStocks.map(s => s.code);
  holdingsQuotes = await fetchStockQuotes(codes);

  let successCount = holdingsQuotes.filter(q => !q.error).length;
  let now = new Date();
  let timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  let subtitle = document.getElementById('page-subtitle');
  if (subtitle) {
    subtitle.textContent = `更新于 ${timeStr} · ${successCount}/${codes.length} 成功 · 共 ${holdingsStocks.length} 只`;
  }

  let sorted = sortHoldingsStocks(holdingsStocks, holdingsQuotes);
  listContainer.innerHTML = renderStockList(sorted, holdingsQuotes, true);

  bindCardEvents(listContainer, true);
}

function sortHoldingsStocks(stocks, quotes) {
  let quoteMap = new Map();
  quotes.forEach(q => quoteMap.set(q.code, q));

  return [...stocks].sort((a, b) => {
    let qa = quoteMap.get(a.code);
    let qb = quoteMap.get(b.code);

    let aFailed = !qa || !!qa.error;
    let bFailed = !qb || !!qb.error;
    if (aFailed && !bFailed) return 1;
    if (!aFailed && bFailed) return -1;

    let aToday = isToday(a.buy_time);
    let bToday = isToday(b.buy_time);
    if (aToday && !bToday) return -1;
    if (!aToday && bToday) return 1;

    // 按目标达成率升序
    let aRate = (qa && qa.last_px && a.target_price) ? qa.last_px / a.target_price : Infinity;
    let bRate = (qb && qb.last_px && b.target_price) ? qb.last_px / b.target_price : Infinity;
    return aRate - bRate;
  });
}

function bindHoldingsEvents(container) {
  let addBtn = container.querySelector('#btn-add-holdings');
  let refreshBtn = container.querySelector('#btn-refresh-holdings');

  if (addBtn) {
    addBtn.addEventListener('click', () => showAddStockModal(true));
  }
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      let content = document.getElementById('holdings-content');
      if (content) {
        content.innerHTML = '<div class="loading-indicator"><span class="spinner"></span> 刷新中...</div>';
      }
      await loadAllData();
      await refreshHoldingsQuotes();
    });
  }
}

// ===== 卡片事件绑定 =====

function bindCardEvents(container, isHoldings) {
  // 点击股票名称 → 个股详情
  container.querySelectorAll('.stock-name[data-action="detail"]').forEach(el => {
    el.addEventListener('click', async (e) => {
      let card = e.target.closest('.stock-card');
      let stockId = parseInt(card.dataset.stockId);
      let stocks = isHoldings ? holdingsStocks : watchlistStocks;
      let quotes = isHoldings ? holdingsQuotes : watchlistQuotes;
      let stock = stocks.find(s => s.id === stockId);
      let quote = quotes.find(q => q.code === stock?.code);
      if (stock) {
        showDetailPage(stock, quote);
      }
    });
  });

  // 编辑
  container.querySelectorAll('[data-action="edit"]').forEach(el => {
    el.addEventListener('click', (e) => {
      let card = e.target.closest('.stock-card');
      let stockId = parseInt(card.dataset.stockId);
      let stocks = isHoldings ? holdingsStocks : watchlistStocks;
      let stock = stocks.find(s => s.id === stockId);
      if (stock) {
        showEditStockModal(stock, isHoldings);
      }
    });
  });

  // 备注弹窗
  container.querySelectorAll('[data-action="show-note"]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      let noteText = el.dataset.note || '';
      showNoteDialog(noteText);
    });
  });

  // 移至持仓 / 移回自选
  let moveAction = isHoldings ? 'move-back' : 'move-to-holdings';
  container.querySelectorAll(`[data-action="${moveAction}"]`).forEach(el => {
    el.addEventListener('click', async (e) => {
      let card = e.target.closest('.stock-card');
      let stockId = parseInt(card.dataset.stockId);
      let stocks = isHoldings ? holdingsStocks : watchlistStocks;
      let stock = stocks.find(s => s.id === stockId);
      if (!stock) return;

      // 二次确认
      if (confirmingStockId === stockId && confirmingAction === moveAction) {
        let newType = isHoldings ? 'watchlist' : 'holdings';
        await updateStock(stockId, { stock_type: newType });
        showToast(isHoldings ? '已移回自选股' : '已移至持仓股');
        confirmingStockId = null;
        confirmingAction = null;
        await refreshCurrentPage();
        return;
      }

      // 第一次点击：标记确认状态
      confirmingStockId = stockId;
      confirmingAction = moveAction;
      card.classList.add('confirming-move');
      showToast(isHoldings ? '再次点击确认移回自选股' : '再次点击确认移至持仓股', 'error');

      // 3秒后重置
      setTimeout(() => {
        if (confirmingStockId === stockId) {
          confirmingStockId = null;
          confirmingAction = null;
          card.classList.remove('confirming-move');
        }
      }, 3000);
    });
  });

  // 删除
  container.querySelectorAll('[data-action="delete"]').forEach(el => {
    el.addEventListener('click', async (e) => {
      let card = e.target.closest('.stock-card');
      let stockId = parseInt(card.dataset.stockId);

      if (confirmingStockId === stockId && confirmingAction === 'delete') {
        await deleteStock(stockId);
        showToast('已删除');
        confirmingStockId = null;
        confirmingAction = null;
        await refreshCurrentPage();
        return;
      }

      confirmingStockId = stockId;
      confirmingAction = 'delete';
      card.classList.add('confirming-delete');
      showToast('再次点击确认删除', 'error');

      setTimeout(() => {
        if (confirmingStockId === stockId) {
          confirmingStockId = null;
          confirmingAction = null;
          card.classList.remove('confirming-delete');
        }
      }, 3000);
    });
  });
}

// ===== Tab: 条件选股（由 js/selection.js 实现，含子功能页「下影线」） =====
// renderSelectionTab() 定义在 selection.js

// ===== Tab: 环境（子功能：共振/流动性/情绪偏好/趋势周期/系统设置） =====

async function renderEnvironmentTab() {
  let container = document.getElementById('page-environment');
  if (!container) return;

  container.innerHTML = buildEnvSubNav();

  if (envSubTab === 'trend') {
    let body = document.createElement('div');
    body.id = 'env-body';
    container.appendChild(body);
    await renderMarketBody(body);
  } else if (envSubTab === 'settings') {
    let body = document.createElement('div');
    body.id = 'env-body';
    container.appendChild(body);
    await renderSettingsBody(body);
  } else {
    container.innerHTML += renderEnvPlaceholder(envSubTab);
  }

  bindEnvSubNavEvents(container);
}

function buildEnvSubNav() {
  let tabs = [
    { id: 'resonance', label: '共振' },
    { id: 'liquidity', label: '流动性' },
    { id: 'sentiment', label: '情绪偏好' },
    { id: 'trend', label: '趋势周期' },
    { id: 'settings', label: '系统设置' }
  ];
  return `
    <div class="env-sub-nav" style="display:flex;align-items:center;gap:4px;overflow-x:auto;padding:10px 12px 0;white-space:nowrap;-webkit-overflow-scrolling:touch;">
      ${tabs.map(t => `
        <button class="env-sub-tab" data-env="${t.id}" style="padding:7px 14px;font-size:13px;font-weight:600;border:none;border-radius:7px 7px 0 0;cursor:pointer;white-space:nowrap;background:${envSubTab===t.id?'var(--bg-card)':'transparent'};color:${envSubTab===t.id?'var(--text)':'var(--text-muted)'};">${t.label}</button>
      `).join('')}
    </div>`;
}

function renderEnvPlaceholder(subTab) {
  let labels = { resonance: '共振', liquidity: '流动性', sentiment: '情绪偏好' };
  let desc = {
    resonance: '多周期多维度共振分析',
    liquidity: '市场资金与流动性监测',
    sentiment: '市场情绪与风险偏好'
  };
  return `
    <div class="empty-state" style="min-height:320px;display:flex;flex-direction:column;justify-content:center;">
      ${ICONS.empty}
      <p>「${labels[subTab] || ''}」功能开发中<br><span style="font-size:12px;color:var(--text-muted);">${desc[subTab] || ''}</span></p>
    </div>`;
}

function bindEnvSubNavEvents(container) {
  container.querySelectorAll('.env-sub-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.env === envSubTab) return;
      envSubTab = btn.dataset.env;
      await renderEnvironmentTab();
    });
  });
}

// ===== Tab: 系统设置（环境子功能） =====

async function renderSettingsBody(body) {
  appSettings = await getSettings();
  body.innerHTML = renderSettingsPage(appSettings);

  // 主题切换
  let themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      themeToggle.classList.toggle('active');
      toggleTheme();
    });
  }

  // 注册推送
  let registerBtn = document.getElementById('btn-register-push');
  if (registerBtn) {
    registerBtn.addEventListener('click', async () => {
      let result = await requestNotificationPermission();
      if (result === 'granted') {
        let regId = 'web-push-' + generateId();
        await saveSettings({ jpush_reg_id: regId });
        appSettings.jpush_reg_id = regId;
        let statusEl = document.getElementById('push-status');
        if (statusEl) statusEl.textContent = '✅ 已注册';
        showToast('推送注册成功');
        // 刷新设置页
        await renderSettingsBody(body);
      } else if (result === 'denied') {
        showToast('推送权限被拒绝，请在浏览器设置中开启', 'error');
      } else if (result === 'unsupported') {
        showToast('当前浏览器不支持推送通知', 'error');
      } else {
        showToast('推送注册已取消', 'error');
      }
    });
  }

  // 手动触发检查
  let manualBtn = document.getElementById('btn-manual-check');
  if (manualBtn) {
    manualBtn.addEventListener('click', async () => {
      let resultDiv = document.getElementById('push-result');
      if (resultDiv) resultDiv.innerHTML = '<div class="loading-indicator"><span class="spinner"></span> 检查中...</div>';

      try {
        // 获取所有股票
        let allStocks = [...watchlistStocks, ...holdingsStocks];
        let allCodes = allStocks.map(s => s.code);

        // 查询行情
        let quotes = await fetchStockQuotes(allCodes);

        // 检查阈值
        let alerts = await checkThresholds(allStocks, quotes, appSettings);

        // 发送通知（不等待，防止挂起）
        if (alerts.length > 0) {
          // 格式化通知内容：【股票名：倍数】或【股票名：目标达成率】
          let messages = alerts.map(a => a.message).join('\n');
          // 不await，防止service worker showNotification挂起
          sendBrowserNotification('股票提醒', messages).catch(() => {});

          // 企业微信机器人推送
          if (appSettings.webhook_url) {
            let nowStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            // 修复：a.message 已经包含股票名，这里只取倍数/达成率部分
            let wxContent = `## 📈 股票监控提醒\n> 触发时间：${nowStr}\n> 触发数量：<font color="warning">${alerts.length}</font> 只\n\n${alerts.map(a => {
              // 从 message 中提取数值部分（去掉前面的股票名）
              let valuePart = a.message.replace(/^[^:]+[:：]/, '').trim();
              return `- **${a.stock.name}**（${extractDigits(a.stock.code)}）：<font color="info">${valuePart}</font>`;
            }).join('\n')}`;
            sendWechatWebhook(appSettings.webhook_url, wxContent).catch(() => {});
          }

          // 记录日志 - 同样使用【股票名：倍数】格式
          let summary = alerts.map(a => a.message).join(', ');
          addLog({
            triggered_at: new Date().toISOString(),
            trigger_type: 'manual',
            status: 'success',
            summary: `触发 ${alerts.length} 只: ${summary}`
          });

          if (resultDiv) resultDiv.innerHTML = `<div class="inline-msg success">✅ 检查完成：${alerts.length} 只股票触发提醒${appSettings.webhook_url ? '，已推送微信' : ''}</div>`;
        } else {
          addLog({
            triggered_at: new Date().toISOString(),
            trigger_type: 'manual',
            status: 'success',
            summary: '无股票触发提醒'
          });

          if (resultDiv) resultDiv.innerHTML = '<div class="inline-msg success">✅ 检查完成：无股票触发提醒</div>';
        }
      } catch (e) {
        addLog({
          triggered_at: new Date().toISOString(),
          trigger_type: 'manual',
          status: 'failed',
          error_msg: e.message
        });
        if (resultDiv) resultDiv.innerHTML = `<div class="inline-msg error">❌ 检查失败: ${escapeHtml(e.message)}</div>`;
      }

      // 刷新日志
      renderLogsSection();
    });
  }

  // 保存 Webhook
  let saveWebhookBtn = document.getElementById('btn-save-webhook');
  if (saveWebhookBtn) {
    saveWebhookBtn.addEventListener('click', async () => {
      let url = document.getElementById('setting-webhook-url').value.trim();
      if (!url) {
        showToast('请输入 Webhook 地址', 'error');
        return;
      }
      if (!url.startsWith('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=')) {
        showToast('Webhook 地址格式不正确', 'error');
        return;
      }
      await saveSettings({ webhook_url: url });
      appSettings.webhook_url = url;
      showToast('Webhook 已保存 ✅ 阈值触发时将自动推送微信消息');
    });
  }

  // 保存阈值
  let saveThresholdsBtn = document.getElementById('btn-save-thresholds');
  if (saveThresholdsBtn) {
    saveThresholdsBtn.addEventListener('click', async () => {
      let watchlist = parseFloat(document.getElementById('setting-watchlist-threshold').value);
      let rate = parseFloat(document.getElementById('setting-holdings-rate').value);
      let buy = parseFloat(document.getElementById('setting-holdings-buy').value);

      if (isNaN(watchlist) || isNaN(rate) || isNaN(buy)) {
        showToast('请输入有效数值', 'error');
        return;
      }

      await saveSettings({
        watchlist_multiple_threshold: watchlist,
        holdings_rate_threshold: rate,
        holdings_buy_ratio_threshold: buy
      });
      appSettings = await getSettings();
      showToast('阈值已保存');
    });
  }

  // 添加时间
  let addTimeBtn = document.getElementById('btn-add-time');
  if (addTimeBtn) {
    addTimeBtn.addEventListener('click', () => {
      let hour = document.getElementById('add-hour').value.padStart(2, '0');
      let minute = document.getElementById('add-minute').value.padStart(2, '0');
      let timeStr = hour + ':' + minute;

      let times = [];
      try { times = JSON.parse(appSettings.schedule_times || '[]'); } catch(e) { times = []; }

      if (times.length >= 10) {
        showToast('最多设置10个时间点', 'error');
        return;
      }
      if (times.includes(timeStr)) {
        showToast('该时间已存在', 'error');
        return;
      }

      times.push(timeStr);
      times.sort();
      appSettings.schedule_times = JSON.stringify(times);
      updateTimeChips(times);
    });
  }

  // 删除时间
  let timeChips = document.getElementById('time-chips');
  if (timeChips) {
    timeChips.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-time')) {
        let time = e.target.dataset.time;
        let times = [];
        try { times = JSON.parse(appSettings.schedule_times || '[]'); } catch(e) { times = []; }
        times = times.filter(t => t !== time);
        appSettings.schedule_times = JSON.stringify(times);
        updateTimeChips(times);
      }
    });
  }

  // 保存时间
  let saveTimesBtn = document.getElementById('btn-save-times');
  if (saveTimesBtn) {
    saveTimesBtn.addEventListener('click', async () => {
      await saveSettings({ schedule_times: appSettings.schedule_times });
      showToast('时间设置已保存');
    });
  }

  // 同步配置到 GitHub Actions（通过 API 自动更新）
  let syncConfigBtn = document.getElementById('btn-sync-config');
  if (syncConfigBtn) {
    syncConfigBtn.addEventListener('click', async () => {
      let resultDiv = document.getElementById('sync-result');
      let tokenEl = document.getElementById('setting-github-token');
      let token = (tokenEl ? tokenEl.value : '').trim();

      if (!token) {
        if (resultDiv) resultDiv.innerHTML = '<span style="color:var(--danger)">❌ 请先设置 GitHub Token</span>';
        return;
      }

      if (resultDiv) resultDiv.innerHTML = '<span style="color:var(--text-secondary)">⏳ 同步中...</span>';

      try {
        // 保存 token
        await saveSettings({ github_token: token });
        appSettings.github_token = token;

        // 读取所有股票
        let watchlist = await getAllStocks('watchlist');
        let holdings = await getAllStocks('holdings');

        let stocks = [];
        for (let s of watchlist) {
          stocks.push({ code: extractDigits(s.code), name: s.name, type: 'watchlist', buy_price: s.buy_price || 0 });
        }
        for (let s of holdings) {
          stocks.push({ code: extractDigits(s.code), name: s.name, type: 'holdings', buy_price: s.buy_price || 0, target_price: s.target_price || 0 });
        }

        let config = {
          check_times: JSON.parse(appSettings.schedule_times || '["08:30","09:30","10:00","10:30","11:00","11:30","11:40","14:00","14:30","14:50","15:10","15:30"]'),
          watchlist_threshold: appSettings.watchlist_multiple_threshold || 0.9,
          holdings_rate_threshold: appSettings.holdings_rate_threshold || 1.0,
          holdings_buy_threshold: appSettings.holdings_buy_ratio_threshold || 0.9,
          stocks: stocks
        };

        // Base64 编码（浏览器兼容写法）
        let jsonStr = JSON.stringify(config, null, 2);
        let content = btoa(unescape(encodeURIComponent(jsonStr)));

        // 先获取文件 SHA
        let getResp = await fetch('https://api.github.com/repos/Ronie-Liu/stock-pwa/contents/stock-config.json', {
          headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json' }
        });
        let getData = await getResp.json();
        let sha = getData.sha;

        if (!sha) {
          if (resultDiv) resultDiv.innerHTML = '<span style="color:var(--danger)">❌ 无法获取文件信息，请检查 Token 是否正确</span>';
          return;
        }

        // 更新文件
        let putResp = await fetch('https://api.github.com/repos/Ronie-Liu/stock-pwa/contents/stock-config.json', {
          method: 'PUT',
          headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: '从APP同步股票配置 [skip ci]',
            content: content,
            sha: sha
          })
        });

        let putData = await putResp.json();

        if (putData.content) {
          if (resultDiv) resultDiv.innerHTML = '<span style="color:var(--up-color)">✅ 同步成功！定时监控已更新（' + stocks.length + ' 只股票）</span>';
          showToast('✅ 同步成功');
        } else {
          if (resultDiv) resultDiv.innerHTML = '<span style="color:var(--danger)">❌ 同步失败: ' + (putData.message || '未知错误') + '</span>';
        }
      } catch (e) {
        if (resultDiv) resultDiv.innerHTML = '<span style="color:var(--danger)">❌ 同步异常: ' + e.message + '</span>';
      }
    });
  }

  // 渲染日志
  renderLogsSection();
}

function updateTimeChips(times) {
  let chips = document.getElementById('time-chips');
  if (!chips) return;
  chips.innerHTML = times.map(t => `
    <span class="time-chip">
      ${escapeHtml(t)}
      <span class="remove-time" data-time="${escapeHtml(t)}">×</span>
    </span>
  `).join('');
}

async function renderLogsSection() {
  let logsContainer = document.getElementById('push-logs');
  if (!logsContainer) return;

  let logs = await getRecentLogs(10);
  logsContainer.innerHTML = renderLogs(logs);
}

// ===== Tab: 趋势周期（环境子功能，原大盘功能） =====

async function renderMarketBody(body) {
  body.innerHTML = '<div class="loading-indicator"><span class="spinner"></span> 加载中…</div>';

  let custom = await getMarketCustomSettings();
  if (!custom || !custom.indicators) custom = defaultMarketCustom();

  try {
    let records = await getMarketRecords(20);
    let latestRecord = records.length > 0 ? records[0] : null;
    let realtimeQuote = null;
    try { realtimeQuote = await fetchTodayIndexQuote(); } catch(e) {}
    let now = new Date();
    let dayOfWeek = now.getDay(), hour = now.getHours(), minute = now.getMinutes();
    let isTrading = dayOfWeek >= 1 && dayOfWeek <= 5 &&
        (hour > 9 || (hour === 9 && minute >= 30)) && (hour < 15 || (hour === 15 && minute === 0));
    if (!realtimeQuote && latestRecord) {
      realtimeQuote = { name: '上证指数', last_px: latestRecord.close, open_px: latestRecord.open,
        high_px: latestRecord.high, low_px: latestRecord.low, prev_close: latestRecord.open,
        amount: latestRecord.amount, volume: latestRecord.volume,
        change_pct: latestRecord.open ? ((latestRecord.close - latestRecord.open) / latestRecord.open * 100) : 0,
        is_realtime: false, _is_trading: isTrading };
    }
    if (realtimeQuote) realtimeQuote._is_trading = isTrading;

    let headerHtml = buildMarketSubNav();
    let contentHtml = '';
    if (marketSubTab === 'third_board') {
      contentHtml = await renderThirdBoardSubTab();
    } else {
      contentHtml = renderMarketPage(records, realtimeQuote, false, custom, latestRecord);
    }
    body.innerHTML = '<div class="market-header" style="padding:8px 12px 0;">' + headerHtml + '</div>' + contentHtml;
    bindMarketEvents(body, records, realtimeQuote, custom, latestRecord);
  } catch (e) {
    body.innerHTML = '<div class="empty-state">加载失败: ' + escapeHtml(e.message) + '<br><button class="btn btn-sm" onclick="switchTab(\'environment\')">重试</button></div>';
  }
}

function buildMarketSubNav() {
  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
      <div style="display:flex;align-items:center;gap:2px;">
        <button class="market-sub-tab" data-sub="index" style="padding:6px 14px;font-size:13px;font-weight:600;border:none;border-radius:7px 7px 0 0;cursor:pointer;background:${marketSubTab==='index'?'var(--bg-card)':'transparent'};color:${marketSubTab==='index'?'var(--text)':'var(--text-muted)'};">上证大盘</button>
        <button class="market-sub-tab" data-sub="third_board" style="padding:6px 14px;font-size:13px;font-weight:600;border:none;border-radius:7px 7px 0 0;cursor:pointer;background:${marketSubTab==='third_board'?'var(--bg-card)':'transparent'};color:${marketSubTab==='third_board'?'var(--text)':'var(--text-muted)'};">老三板</button>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        ${marketSubTab==='index'?`<button class="btn btn-sm" id="btn-edit-custom" title="编辑自定义" style="padding:5px 10px;font-size:12px;border-radius:7px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>`:''}
        <button class="btn btn-sm" id="btn-refresh-market" title="刷新" style="padding:5px 10px;font-size:12px;border-radius:7px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg></button>
        <button class="btn btn-sm btn-primary" id="btn-export-csv" title="导出CSV" style="padding:5px 10px;font-size:12px;border-radius:7px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg></button>
      </div>
    </div>`;
}

function bindMarketEvents(container, records, realtimeQuote, custom, latestRecord) {
  container.querySelectorAll('.market-sub-tab').forEach(btn => {
    btn.addEventListener('click', async () => {
      marketSubTab = btn.dataset.sub;
      await renderMarketBody(container);
    });
  });

  if (marketSubTab === 'index') {
    let editBtn = container.querySelector('#btn-edit-custom');
    if (editBtn) editBtn.addEventListener('click', () => {
      showMarketEditModal(custom, async () => { marketSubTab = 'index'; await renderMarketBody(container); });
    });
    let exportBtn = container.querySelector('#btn-export-csv');
    if (exportBtn) exportBtn.addEventListener('click', async () => {
      try {
        showToast('正在导出CSV...');
        let csv = marketSubTab === 'third_board' ? await exportThirdBoardAllCSV() : await exportMarketCSV();
        if (!csv) return showToast('无数据', 'error');
        let blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        let url = URL.createObjectURL(blob);
        let a = document.createElement('a');
        a.href = url; a.download = (marketSubTab === 'third_board' ? '老三板全部' : '上证指数') + '_' + new Date().toISOString().slice(0,10) + '.csv';
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        showToast('导出成功');
      } catch(e) { showToast('导出失败: ' + e.message, 'error'); }
    });
  }

  if (marketSubTab === 'third_board') bindThirdBoardEvents(container);

  let refreshBtn = container.querySelector('#btn-refresh-market');
  if (refreshBtn) refreshBtn.addEventListener('click', async () => {
    container.innerHTML = '<div class="loading-indicator"><span class="spinner"></span> 刷新中…</div>';
    try {
      if (marketSubTab === 'third_board') await initThirdBoardData();
      else await initMarketData();
      await renderMarketBody(container);
    } catch(e) { container.innerHTML = '<div class="empty-state">刷新失败: ' + escapeHtml(e.message) + '</div>'; }
  });
}

// ===== 老三板子Tab =====

async function renderThirdBoardSubTab() {
  let dates = await apiThirdBoardDates();
  let selectedDate = dates.length > 0 ? dates[0] : '';
  let rows = selectedDate ? await apiThirdBoardByDate(selectedDate) : [];
  return renderThirdBoardUI(rows, dates, selectedDate, false);
}

function bindThirdBoardEvents(container) {
  let dateSelect = container.querySelector('#tb-date-select');
  if (dateSelect) dateSelect.addEventListener('change', async () => {
    let ds = dateSelect.value, rows = await apiThirdBoardByDate(ds);
    let dates = await apiThirdBoardDates();
    let old = container.querySelector('div[style*="padding:0 14px 14px"]');
    if (old) old.outerHTML = renderThirdBoardUI(rows, dates, ds, false);
    bindThirdBoardEvents(container);
  });

  let exportBtn = container.querySelector('#btn-tb-export-csv');
  if (exportBtn) exportBtn.addEventListener('click', async () => {
    let ds = (container.querySelector('#tb-date-select') || {}).value || '';
    if (!ds) return showToast('请先选择日期', 'error');
    try {
      let csv = await exportThirdBoardCSV(ds);
      if (!csv) return showToast('无数据', 'error');
      let blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      let url = URL.createObjectURL(blob); let a = document.createElement('a');
      a.href = url; a.download = '老三板' + ds.replace(/-/g,'') + '.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      showToast('导出成功');
    } catch(e) { showToast('导出失败: ' + e.message, 'error'); }
  });
}

// ===== 全局回调（给模态弹窗用） =====

async function onAddStock(stock) {
  await addStock(stock);
  await refreshCurrentPage();
  showToast(`已添加 ${stock.name}(${extractDigits(stock.code)})`);
}

async function onEditStock(id, updates) {
  await updateStock(id, updates);
  await refreshCurrentPage();
  showToast('股票信息已更新');
}

async function onDetailClose() {
  disposeChart();
  // 返回后刷新当前页
  await refreshCurrentPage();
}

// ===== 全局事件 =====

function setupGlobalEvents() {
  // 底部导航切换
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      let tabId = item.dataset.tab;
      if (tabId !== currentTab) {
        switchTab(tabId);
      }
    });
  });

  // 下拉刷新（所有列表页）
  let touchStartY = 0;
  let isPulling = false;
  document.addEventListener('touchstart', (e) => {
    if (e.target.closest('.page') && e.target.closest('.page').scrollTop === 0) {
      touchStartY = e.touches[0].clientY;
      isPulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!isPulling) return;
    let deltaY = e.touches[0].clientY - touchStartY;
    if (deltaY > 60 && (currentTab === 'watchlist' || currentTab === 'holdings' || currentTab === 'environment')) {
      isPulling = false;
      if (currentTab === 'watchlist') {
        (async () => {
          await loadAllData();
          await refreshWatchlistQuotes();
        })();
      } else if (currentTab === 'holdings') {
        (async () => {
          await loadAllData();
          await refreshHoldingsQuotes();
        })();
      } else if (currentTab === 'environment') {
        (async () => {
          await renderEnvironmentTab();
        })();
      }
    }
  }, { passive: true });

  document.addEventListener('touchend', () => { isPulling = false; });
}

// ===== Service Worker =====

function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  // 先注销所有旧 SW，再注册新的（确保版本切换）
  navigator.serviceWorker.getRegistrations().then((regs) => {
    return Promise.all(regs.map(r => r.unregister()));
  }).then(() => {
    return navigator.serviceWorker.register('/sw.js?v=20260906e');
  }).then((reg) => {
    console.log('SW 注册成功:', reg.scope);

    // 监听 SW 消息（版本更新通知）
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'SW_UPDATED') {
        console.log('SW 版本更新，即将刷新页面...');
        setTimeout(() => window.location.reload(), 500);
      }
    });

    // 检测 SW 更新
    reg.addEventListener('updatefound', () => {
      let newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // 新 SW 已就绪 → 通知用户刷新
          console.log('新版本已就绪，即将刷新...');
          setTimeout(() => window.location.reload(), 1000);
        }
      });
    });
  }).catch((err) => {
    console.log('SW 注册失败:', err);
  });
}

// ===== 启动应用 =====

document.addEventListener('DOMContentLoaded', () => {
  initApp();
});
