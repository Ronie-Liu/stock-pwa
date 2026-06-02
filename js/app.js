// ===== 主应用控制器 =====

// 全局状态
let currentTab = 'watchlist';
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
}

// ===== 定时检查 =====
let lastCheckedMinute = null;

function startScheduledCheck() {
  // 每分钟检查一次
  setInterval(async () => {
    if (!appSettings) return;
    
    let times = [];
    try { times = JSON.parse(appSettings.schedule_times || '[]'); } catch(e) { times = []; }
    if (times.length === 0) return;
    
    let now = new Date();
    let currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    
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
  } else if (currentTab === 'upload') {
    renderUploadPage();
  } else if (currentTab === 'settings') {
    renderSettings();
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
  } else if (tabId === 'upload') {
    renderUploadPage();
  } else if (tabId === 'settings') {
    await renderSettings();
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
        <p>暂无自选股<br>点击「添加」或切换到「上传文件」导入 CSV</p>
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

// ===== Tab 3: 上传文件 =====

function renderUploadPage() {
  let container = document.getElementById('page-upload');
  if (!container) return;

  container.innerHTML = renderCSVPage(watchlistStocks.length, holdingsStocks.length);
  setupCSVEvents();
}

// ===== Tab 4: 设置 =====

async function renderSettings() {
  let container = document.getElementById('page-settings');
  if (!container) return;

  appSettings = await getSettings();
  container.innerHTML = renderSettingsPage(appSettings);

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
        await renderSettings();
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
    if (deltaY > 60 && (currentTab === 'watchlist' || currentTab === 'holdings')) {
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
    return navigator.serviceWorker.register('/sw.js?v=20260602');
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
