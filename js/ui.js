// ===== UI 渲染模块 =====

/**
 * 将Markdown文本转换为HTML（简化版，支持表格、标题、列表等）
 */
function markdownToHtml(md) {
  if (!md) return '';
  
  // 先提取表格块，避免被后续处理破坏
  let tables = [];
  let html = md.replace(/\|(.+)\|[\s\S]*?(?=\n\n|\n###|\n##|\n\*\*|---\n|$)/g, function(match) {
    let lines = match.trim().split('\n');
    // 找到表头和分隔行
    let headerIdx = -1, sepIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('|') && !lines[i].includes('---') && headerIdx < 0) headerIdx = i;
      if (lines[i].includes('---')) sepIdx = i;
    }
    if (headerIdx < 0 || sepIdx < 0) return match;
    
    let headers = lines[headerIdx].split('|').filter(c => c.trim()).map(c => c.trim());
    let rows = [];
    for (let i = sepIdx + 1; i < lines.length; i++) {
      if (!lines[i].includes('|')) continue;
      let cols = lines[i].split('|').filter(c => true).map(c => c.trim());
      // 去掉首尾空元素
      if (cols[0] === '') cols.shift();
      if (cols[cols.length-1] === '') cols.pop();
      if (cols.length > 0) rows.push(cols);
    }
    
    let tableHtml = '<table class="ai-table"><thead><tr>';
    headers.forEach(h => { tableHtml += `<th>${h}</th>`; });
    tableHtml += '</tr></thead><tbody>';
    rows.forEach(row => {
      tableHtml += '<tr>';
      row.forEach(cell => { tableHtml += `<td>${cell}</td>`; });
      tableHtml += '</tr>';
    });
    tableHtml += '</tbody></table>';
    
    let idx = tables.length;
    tables.push(tableHtml);
    return '%%TABLE_' + idx + '%%';
  });

  // 转换标题
  html = html.replace(/###\s*(.+)/g, '<h4 class="ai-section-title">$1</h4>');
  html = html.replace(/##\s*(.+)/g, '<h3 class="ai-main-title">$1</h3>');

  // 转换粗体
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // 转换列表项（连续的行）
  html = html.replace(/(?:^|\n)([-•]\s*.+)(?:\n([-•]\s*.+))*/gm, function(match) {
    let items = match.split('\n').filter(l => l.match(/^[-•]\s/));
    let listItems = items.map(l => '<li>' + l.replace(/^[-•]\s*/, '') + '</li>').join('');
    return '<ul class="ai-list">' + listItems + '</ul>';
  });

  // 转换引用块
  html = html.replace(/^>\s*(.+)$/gm, '<blockquote class="ai-quote">$1</blockquote>');

  // 转换分隔线
  html = html.replace(/^---$/gm, '<hr class="ai-divider">');

  // 恢复表格
  html = html.replace(/%%TABLE_(\d+)%%/g, function(m, idx) {
    return tables[parseInt(idx)] || '';
  });

  // 最后转换换行
  html = html.replace(/\n+/g, '<br>');

  // 清理多余的空br标签
  html = html.replace(/(<br>\s*)+/g, '<br>');

  return html;
}

// SVG 图标（内联以简化依赖）
const ICONS = {
  chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
  briefcase: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  edit: `✏️`,
  move: `📦`,
  delete: `🗑️`,
  back: `←`,
  plus: `+`,
  refresh: `🔄`,
  empty: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>`
};

/**
 * 渲染底部导航栏
 */
function renderBottomNav(activeTab) {
  let tabs = [
    { id: 'watchlist', icon: ICONS.chart, label: '自选股' },
    { id: 'holdings', icon: ICONS.briefcase, label: '持仓股' },
    { id: 'upload', icon: ICONS.upload, label: '上传文件' },
    { id: 'settings', icon: ICONS.settings, label: '设置' }
  ];

  return `
    <nav class="bottom-nav">
      ${tabs.map(t => `
        <button class="nav-item ${t.id === activeTab ? 'active' : ''}" data-tab="${t.id}">
          ${t.icon}
          <span>${t.label}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

// ===== Tab 1 & 2: 股票卡片列表 =====

function renderPageHeader(title, subtitle, extraButtons = '') {
  return `
    <div class="page-header">
      <div>
        <div class="page-title">${title}</div>
        ${subtitle ? `<div class="page-subtitle" id="page-subtitle">${subtitle}</div>` : ''}
      </div>
      <div class="header-actions">${extraButtons}</div>
    </div>
  `;
}

function renderStockCard(stock, quote, index, total, isHoldings) {
  let price = quote?.last_px;
  let changeRate = quote?.px_change_rate;
  let turnover = quote?.turnover_ratio;
  let changeClass = 'zero';
  let changeColor = '';

  if (changeRate != null) {
    if (changeRate > 0) { changeClass = 'up'; changeColor = 'color:var(--up-color)'; }
    else if (changeRate < 0) { changeClass = 'down'; changeColor = 'color:var(--down-color)'; }
  }

  // 计算实时倍数
  let multiple = null;
  if (price && stock.buy_price && stock.buy_price > 0) {
    multiple = price / stock.buy_price;
  }

  // 持仓股：计算目标达成率
  let targetRate = null;
  if (isHoldings && price && stock.target_price && stock.target_price > 0) {
    targetRate = price / stock.target_price;
  }

  let confirmClass = '';
  if (stock._confirmDelete) confirmClass = 'confirming-delete';
  if (stock._confirmMove) confirmClass = 'confirming-move';

  // 备注 - 支持点击弹窗
  let noteText = stock.personal_note || '';
  let noteDisplay = noteText.length > 18 ? noteText.slice(0, 18) + '...' : noteText;
  let noteHtml = noteText ? `<span class="stock-note" data-action="show-note" data-note="${escapeHtml(noteText).replace(/"/g, '&quot;')}" title="点击查看全部">${escapeHtml(noteDisplay)}</span>` : '';

  // 买入时间
  let timeHtml = stock.buy_time ? `<span class="stock-time">${ICONS.clock} ${escapeHtml(stock.buy_time)}</span>` : '';

  // 构建数据行
  let dataRowHtml = '';
  if (isHoldings) {
    dataRowHtml = `
      <div class="stock-data-row">
        <div class="data-col">
          <span class="data-label">实时价格</span>
          <span class="data-value bold" style="${changeColor}">${formatPrice(price)}</span>
        </div>
        <div class="data-col">
          <span class="data-label">实时倍数</span>
          <span class="data-badge-multiple">${multiple ? multiple.toFixed(2) + 'x' : '--'}</span>
        </div>
        <div class="data-col">
          <span class="data-label">目标达成率</span>
          <span class="data-value bold" style="color:${targetRate && targetRate >= 1 ? 'var(--accent)' : 'var(--text)'}">${targetRate ? targetRate.toFixed(2) + 'x' : '--'}</span>
        </div>
        <div class="data-col">
          <span class="data-label">换手率</span>
          <span class="data-value bold">${turnover != null ? turnover.toFixed(2) + '%' : '--'}</span>
        </div>
      </div>
    `;
  } else {
    dataRowHtml = `
      <div class="stock-data-row">
        <div class="data-col">
          <span class="data-label">实时价格</span>
          <span class="data-value bold" style="${changeColor}">${formatPrice(price)}</span>
        </div>
        <div class="data-col">
          <span class="data-label">实时倍数</span>
          <span class="data-badge-multiple">${multiple ? multiple.toFixed(2) + 'x' : '--'}</span>
        </div>
        <div class="data-col">
          <span class="data-label">换手率</span>
          <span class="data-value bold">${turnover != null ? turnover.toFixed(2) + '%' : '--'}</span>
        </div>
        <div class="data-col">
          <span class="data-label">买入价</span>
          <span class="data-value bold">${stock.buy_price ? formatPrice(stock.buy_price) : '--'}</span>
        </div>
      </div>
    `;
  }

  return `
    <div class="stock-card ${confirmClass}" data-stock-id="${stock.id}" data-stock-code="${stock.code}">
      <div class="card-main">
        <div class="card-left">
          <div class="stock-info-main">
            <span class="stock-name" data-action="detail">${escapeHtml(stock.name)}</span>
            <span class="stock-code">${extractDigits(stock.code)}</span>
          </div>
        </div>
        <div class="card-right">
          <span class="change-text ${changeClass}">${formatPercent(changeRate)}</span>
          <div class="card-actions">
            <button data-action="edit" title="编辑">${ICONS.edit}</button>
            <button data-action="${isHoldings ? 'move-back' : 'move-to-holdings'}" title="${isHoldings ? '移回自选' : '移至持仓'}">${ICONS.move}</button>
            <button data-action="delete" title="删除">${ICONS.delete}</button>
          </div>
        </div>
      </div>
      ${dataRowHtml}
      <div class="card-footer-compact">
        ${timeHtml}
        ${noteHtml}
      </div>
      ${quote?.error ? `<div class="error-text">${escapeHtml(quote.error)}</div>` : ''}
    </div>
  `;
}

function renderStockList(stocks, quotes, isHoldings) {
  if (!stocks || stocks.length === 0) {
    let typeName = isHoldings ? '持仓股' : '自选股';
    return `
      <div class="empty-state">
        ${ICONS.empty}
        <p>暂无${typeName}<br>点击添加或导入 CSV</p>
      </div>
    `;
  }

  return stocks.map((stock, i) => {
    let quote = quotes ? quotes.find(q => q.code === stock.code) : null;
    return renderStockCard(stock, quote, i + 1, stocks.length, isHoldings);
  }).join('');
}

// ===== 模态弹窗 =====

function renderModal(title, content) {
  return `
    <div class="modal-overlay show" id="modal-overlay" onclick="closeModal(event)">
      <div class="modal" onclick="event.stopPropagation()">
        <h3>${title}</h3>
        ${content}
      </div>
    </div>
  `;
}

function showAddStockModal(isHoldings) {
  let title = isHoldings ? '添加持仓股' : '添加自选股';
  let html = renderModal(title, `
    <div class="form-group">
      <label>股票代码</label>
      <input type="text" id="add-code" placeholder="如 600519 或 000001.SZ" autocomplete="off">
    </div>
    <div class="form-group">
      <label>股票名称</label>
      <input type="text" id="add-name" placeholder="如 贵州茅台" autocomplete="off">
    </div>
    <div class="form-group">
      <label>买入价格（可选）</label>
      <input type="number" id="add-price" placeholder="买入价（元）" step="0.01">
    </div>
    <div class="form-group">
      <label>买入时间（可选）</label>
      <input type="text" id="add-time" placeholder="如 今天、2024-01">
    </div>
    <div class="form-group">
      <label>个人备注（可选）</label>
      <input type="text" id="add-note" placeholder="备注信息">
    </div>
    ${isHoldings ? `
    <div class="form-group">
      <label>目标价格（可选）</label>
      <input type="number" id="add-target" placeholder="目标价（元）" step="0.01">
    </div>
    ` : ''}
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="btn-confirm-add">确认添加</button>
    </div>
  `);
  document.getElementById('app').insertAdjacentHTML('beforeend', html);

  document.getElementById('btn-confirm-add').addEventListener('click', () => {
    let code = document.getElementById('add-code').value.trim();
    let name = document.getElementById('add-name').value.trim();
    if (!code) { showToast('请输入股票代码', 'error'); return; }
    if (!name) { showToast('请输入股票名称', 'error'); return; }

    let stock = {
      code: normalizeCode(code),
      name: name,
      buy_price: parseFloat(document.getElementById('add-price').value) || null,
      buy_time: document.getElementById('add-time').value.trim() || null,
      personal_note: document.getElementById('add-note').value.trim() || null,
      stock_type: isHoldings ? 'holdings' : 'watchlist',
      target_price: isHoldings ? (parseFloat(document.getElementById('add-target')?.value) || null) : null
    };

    closeModal();
    if (typeof onAddStock === 'function') {
      onAddStock(stock);
    }
  });
}

function showEditStockModal(stock, isHoldings) {
  let title = '编辑股票信息';
  let html = renderModal(title, `
    <div class="form-group">
      <label>股票代码</label>
      <input type="text" id="edit-code" value="${escapeHtml(extractDigits(stock.code))}" readonly style="opacity:0.7">
    </div>
    <div class="form-group">
      <label>股票名称</label>
      <input type="text" id="edit-name" value="${escapeHtml(stock.name)}">
    </div>
    <div class="form-group">
      <label>买入价格（元）</label>
      <input type="number" id="edit-price" value="${stock.buy_price || ''}" step="0.01">
    </div>
    <div class="form-group">
      <label>买入时间</label>
      <input type="text" id="edit-time" value="${escapeHtml(stock.buy_time || '')}" placeholder="如 今天、2024-01">
    </div>
    <div class="form-group">
      <label>个人备注</label>
      <input type="text" id="edit-note" value="${escapeHtml(stock.personal_note || '')}">
    </div>
    ${isHoldings ? `
    <div class="form-group">
      <label>目标价格（元）</label>
      <input type="number" id="edit-target" value="${stock.target_price || ''}" step="0.01">
    </div>
    ` : ''}
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="btn-confirm-edit">保存修改</button>
    </div>
  `);
  document.getElementById('app').insertAdjacentHTML('beforeend', html);

  document.getElementById('btn-confirm-edit').addEventListener('click', () => {
    let updates = {
      name: document.getElementById('edit-name').value.trim(),
      buy_price: parseFloat(document.getElementById('edit-price').value) || null,
      buy_time: document.getElementById('edit-time').value.trim() || null,
      personal_note: document.getElementById('edit-note').value.trim() || null
    };
    if (isHoldings) {
      updates.target_price = parseFloat(document.getElementById('edit-target')?.value) || null;
    }
    if (!updates.name) { showToast('股票名称不能为空', 'error'); return; }
    closeModal();
    if (typeof onEditStock === 'function') {
      onEditStock(stock.id, updates);
    }
  });
}

// ===== 个股详情页 =====

function showDetailPage(stock, quote) {
  let priceColor = 'var(--text)';
  let changeText = '--';
  let changeColor = 'var(--text-secondary)';
  if (quote && !quote.error && quote.last_px) {
    priceColor = quote.px_change_rate >= 0 ? 'var(--up-color)' : 'var(--down-color)';
    changeColor = priceColor;
    let sign = quote.px_change_rate >= 0 ? '+' : '';
    changeText = sign + quote.px_change_rate.toFixed(2) + '%';
  }

  let html = `
    <div class="detail-page show" id="detail-page">
      <div class="detail-header">
        <button class="back-btn" id="detail-back">${ICONS.back}</button>
        <div class="stock-info">
          <div class="name">${escapeHtml(stock.name)}</div>
          <div class="code">${escapeHtml(stock.code)}</div>
        </div>
        <div class="header-price" id="header-price">
          <div class="header-price-value" style="color:${priceColor}">${quote && !quote.error ? formatPrice(quote.last_px) : '--'}</div>
          <div class="header-price-change" style="color:${changeColor}">${changeText}</div>
        </div>
      </div>
      <div class="detail-body">
        <div class="chart-before">
          <div class="chart-top-bar">
            <div class="indicator-panel" id="indicator-panel">
              <span class="ind-item">加载中...</span>
            </div>
          </div>
          <div class="chart-container" id="kline-chart"></div>
          <div class="chart-bottom-bar">
            <span class="zoom-lock-badge" id="zoom-lock-badge" title="点击切换锁定/解锁滑块">🔓 未锁定</span>
            <span class="chart-hint">点击此处切换锁定</span>
          </div>
        </div>
        <div class="ai-section">
          <h4>🔬 三维共振分析</h4>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">宏观(大盘+资金) · 中观(板块方向) · 微观(资金+技术) → 买入价调整建议</div>
          <button class="btn btn-primary btn-sm" id="btn-analysis" style="margin-bottom:10px">开始分析</button>
          <div class="ai-result" id="analysis-result"></div>
          <div class="ai-loading" id="analysis-loading" style="display:none">
            <span class="spinner"></span> 三维共振分析中（获取指数K线+北向资金+涨跌比+板块对标+个股资金+四维技术...请稍候）
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('app').insertAdjacentHTML('beforeend', html);

  // 绑定事件
  document.getElementById('detail-back').addEventListener('click', () => {
    document.getElementById('detail-page').remove();
    if (typeof onDetailClose === 'function') onDetailClose();
  });

  // 加载K线图
  if (typeof renderKLineChart === 'function') {
    renderKLineChart(stock.code);
  }

  // 三维共振分析按钮
  let analysisBtn = document.getElementById('btn-analysis');
  if (analysisBtn && typeof runAnalysisAndRender === 'function') {
    analysisBtn.addEventListener('click', () => {
      runAnalysisAndRender(stock, quote);
    });
  }
}

// ===== Tab 3: 大盘 =====

function renderMarketPage(records, realtimeQuote, loading, custom, latestRecord) {
  let html = renderPageHeader('上证指数 · 大盘数据', 
    records && records.length ? `共 ${records.length} 条（显示最近20条）` : '加载中...',
    `<button class="btn btn-sm" id="btn-edit-custom">✏️ 编辑</button>
     <button class="btn btn-sm" id="btn-refresh-market">🔄 刷新</button>
     <button class="btn btn-sm btn-primary" id="btn-export-csv">📥 导出CSV</button>`
  );

  html += '<div class="page-content" style="padding-top:4px" id="market-content">';

  if (loading) {
    html += '<div class="loading-indicator"><span class="spinner"></span> 正在加载大盘数据（首次需从网络获取3年历史K线并计算衍生指标，约需1-2分钟）...</div>';
  } else if (!records || records.length === 0) {
    html += '<div class="empty-state">暂无大盘数据，点击刷新获取</div>';
  } else {
    // 盘中实时数据行
    if (realtimeQuote) {
      let rtColor = realtimeQuote.change_pct >= 0 ? 'var(--up-color)' : 'var(--down-color)';
      let rtSign = realtimeQuote.change_pct >= 0 ? '+' : '';
      html += `
        <div class="realtime-bar" style="background:var(--bg-card);border:1px solid var(--accent);border-radius:8px;padding:10px 12px;margin-bottom:10px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;">
          <div>
            <span style="font-weight:700;font-size:15px;">🔴 盘中实时</span>
            <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">${realtimeQuote.name || '上证指数'}</span>
          </div>
          <div style="text-align:right;">
            <span style="font-weight:700;font-size:18px;color:${rtColor};">${formatPrice(realtimeQuote.last_px)}</span>
            <span style="font-size:13px;color:${rtColor};margin-left:6px;">${rtSign}${realtimeQuote.change_pct.toFixed(2)}%</span>
          </div>
          <div style="width:100%;display:flex;gap:10px;font-size:11px;color:var(--text-secondary);">
            <span>开 ${formatPrice(realtimeQuote.open_px)}</span>
            <span>高 ${formatPrice(realtimeQuote.high_px)}</span>
            <span>低 ${formatPrice(realtimeQuote.low_px)}</span>
            <span>昨收 ${formatPrice(realtimeQuote.prev_close)}</span>
            <span>额 ${(realtimeQuote.amount / 1e8).toFixed(1)}亿</span>
          </div>
        </div>`;
    }

    // ===== 用户自定义区域 =====
    html += renderMarketCustomSection(custom, latestRecord, realtimeQuote);

    // 历史数据表格
    html += '<div class="market-table-wrap" style="overflow-x:auto;-webkit-overflow-scrolling:touch;">';
    html += '<table class="market-table" style="width:100%;border-collapse:collapse;font-size:11px;white-space:nowrap;">';
    html += '<thead><tr style="background:var(--bg-input);">';
    let headers = ['日期', '收盘', '开盘', '最高', '最低', '换手%', 'MA20乖离', 'MA60乖离', 'MA20趋势%', 'MA120趋势%', '筹码0-10%', '成本倍数', '40%获利', '150%获利', '300%获利'];
    headers.forEach(h => html += `<th style="padding:6px 8px;text-align:right;position:sticky;top:0;background:var(--bg-input);z-index:1;">${h}</th>`);
    html += '</tr></thead><tbody>';

    for (let r of records) {
      let isToday = r.date === new Date().toISOString().slice(0, 10);
      let rowStyle = isToday ? 'background:rgba(0,196,140,0.08);' : '';
      html += `<tr style="${rowStyle}">`;
      html += `<td style="padding:5px 8px;font-weight:${isToday?'700':'400'};color:${isToday?'var(--accent)':'var(--text)'};">${r.date.slice(5)}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${formatPrice(r.close)}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${formatPrice(r.open)}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${formatPrice(r.high)}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${formatPrice(r.low)}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${r.turnover_rate ? r.turnover_rate.toFixed(2) : '--'}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${r.ma20_deviation != null ? r.ma20_deviation.toFixed(4) : '--'}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${r.ma60_deviation != null ? r.ma60_deviation.toFixed(4) : '--'}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${r.ma20_trend_chg != null ? r.ma20_trend_chg.toFixed(4) : '--'}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${r.ma120_trend_chg != null ? r.ma120_trend_chg.toFixed(4) : '--'}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${r.cheapest_10_cost != null ? r.cheapest_10_cost.toFixed(4) : '--'}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${r.cheapest_10_multiple != null ? r.cheapest_10_multiple.toFixed(4) : '--'}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${r.profit_ratio_40 != null ? r.profit_ratio_40.toFixed(4) : '--'}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${r.profit_ratio_150 != null ? r.profit_ratio_150.toFixed(4) : '--'}</td>`;
      html += `<td style="padding:5px 8px;text-align:right;">${r.profit_ratio_300 != null ? r.profit_ratio_300.toFixed(4) : '--'}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table></div>';
  }

  html += '</div>'; // market-content
  return html;
}

// 渲染自定义区域：阶段描述 + 周期指标表格
function renderMarketCustomSection(custom, latestRecord, realtimeQuote) {
  if (!custom) custom = defaultMarketCustom();
  if (!latestRecord) return '<div style="padding:8px;font-size:11px;color:var(--text-muted);">加载数据后显示自定义指标…</div>';

  let html = '';

  // --- 1) 周期阶段描述卡片 ---
  let desc = (custom.stage_description || '').trim();
  if (desc) {
    // 把换行转成 <br>，支持简单格式
    let descHtml = escapeHtml(desc).replace(/\n/g, '<br>');
    html += `
      <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:10px;">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">📝 周期阶段描述</div>
        <div style="font-size:13px;line-height:1.7;color:var(--text);white-space:pre-wrap;">${descHtml}</div>
      </div>`;
  }

  // --- 2) 周期提示指标表格 ---
  let indicators = custom.indicators || [];
  if (!indicators.length) return html;

  html += `
    <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:8px 6px;margin-bottom:10px;">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;padding:0 4px;">📊 周期提示指标</div>
      <table style="width:100%;border-collapse:collapse;font-size:10px;table-layout:fixed;">
        <thead>
          <tr style="border-bottom:1px solid var(--border);">
            <th style="width:18%;padding:4px 2px;text-align:left;color:var(--text-secondary);">指标</th>
            <th style="width:18%;padding:4px 2px;text-align:right;color:var(--text-secondary);">现值</th>
            <th style="width:20%;padding:4px 2px;text-align:right;color:var(--text-secondary);">下限</th>
            <th style="width:21%;padding:4px 2px;text-align:right;color:var(--text-secondary);">上限</th>
            <th style="width:23%;padding:4px 2px;text-align:left;color:var(--text-secondary);">说明</th>
          </tr>
        </thead>
        <tbody>`;

  for (let item of indicators) {
    let def = getIndicatorDef(item.field);
    if (!def) continue;

    let rawVal = computeRealtimeIndicatorValue(item.field, latestRecord, realtimeQuote);
    let valStr = rawVal != null ? rawVal.toFixed(def.fmt) : '--';
    let unit = def.unit;
    let display = valStr === '--' ? '--' : valStr + (unit ? unit : '');

    let lowerMin = parseFloat(item.lower_min), lowerMax = parseFloat(item.lower_max);
    let upperMin = parseFloat(item.upper_min), upperMax = parseFloat(item.upper_max);
    let color = '';
    if (rawVal != null && !isNaN(lowerMax)) {
      if (rawVal <= lowerMax) color = 'color:var(--down-color);font-weight:700;';
    }
    if (!color && rawVal != null && !isNaN(upperMin)) {
      if (rawVal >= upperMin) color = 'color:var(--up-color);font-weight:700;';
    }

    let lowerStr = (item.lower_min || '') + '~' + (item.lower_max || '');
    let upperStr = (item.upper_min || '') + '~' + (item.upper_max || '');
    // 说明文字 - 允许换行，字体缩小
    let noteText = (item.note || '').replace(/\n/g, '<br>');

    html += `
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:5px 2px;font-weight:600;">${escapeHtml(def.name)}</td>
            <td style="padding:5px 2px;text-align:right;${color}">${display}</td>
            <td style="padding:5px 2px;text-align:right;color:var(--text-secondary);">${lowerStr}</td>
            <td style="padding:5px 2px;text-align:right;color:var(--text-secondary);">${upperStr}</td>
            <td style="padding:5px 2px;font-size:9px;line-height:1.5;color:var(--text-secondary);word-break:break-all;">${noteText}</td>
          </tr>`;
  }
  html += `</tbody></table></div>`;

  return html;
}

// 编辑自定义内容弹窗
function showMarketEditModal(custom, onSave) {
  if (!custom) custom = defaultMarketCustom();
  // 深拷贝防止意外修改
  custom = JSON.parse(JSON.stringify(custom));
  if (!custom.indicators) custom.indicators = [];

  let indicatorRowsHtml = custom.indicators.map((item, idx) => {
    let opts = INDICATOR_DEFS.map(d =>
      `<option value="${d.field}" ${item.field === d.field ? 'selected' : ''}>${d.name}</option>`
    ).join('');
    return `
      <div class="indicator-edit-row" data-idx="${idx}" style="display:flex;align-items:center;gap:3px;padding:6px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;">
        <select class="ind-field" style="flex:0 0 auto;width:105px;font-size:11px;padding:3px;">${opts}</select>
        <input type="number" class="ind-lower-min" value="${item.lower_min || ''}" placeholder="下限起" step="0.01" style="width:44px;font-size:11px;padding:3px;text-align:center;">
        <span style="font-size:9px;color:var(--text-muted);">~</span>
        <input type="number" class="ind-lower-max" value="${item.lower_max || ''}" placeholder="下限止" step="0.01" style="width:44px;font-size:11px;padding:3px;text-align:center;">
        <input type="number" class="ind-upper-min" value="${item.upper_min || ''}" placeholder="上限起" step="0.01" style="width:44px;font-size:11px;padding:3px;text-align:center;">
        <span style="font-size:9px;color:var(--text-muted);">~</span>
        <input type="number" class="ind-upper-max" value="${item.upper_max || ''}" placeholder="上限止" step="0.01" style="width:44px;font-size:11px;padding:3px;text-align:center;">
        <input type="text" class="ind-note" value="${escapeHtml(item.note || '')}" placeholder="说明" style="flex:1;min-width:70px;font-size:11px;padding:3px;">
        <button class="btn btn-sm btn-danger ind-del" style="padding:1px 5px;font-size:10px;">×</button>
      </div>`;
  }).join('');

  let html = renderModal('编辑自定义内容', `
    <div style="margin-bottom:12px;">
      <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px;">📝 周期阶段描述</label>
      <textarea id="edit-stage-desc" rows="3" placeholder="描述当前大盘所处的周期阶段…" style="width:100%;resize:none;font-size:13px;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-input);color:var(--text);">${escapeHtml(custom.stage_description || '')}</textarea>
    </div>
    <div style="margin-bottom:12px;">
      <label style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px;">📊 周期提示指标</label>
      <div id="indicator-list" style="max-height:280px;overflow-y:auto;">${indicatorRowsHtml}</div>
      <button class="btn btn-sm" id="btn-add-indicator" style="margin-top:6px;">＋ 添加指标</button>
      <div style="font-size:10px;color:var(--text-muted);margin-top:4px;">现值 ≤ 下限最高值显示绿色，现值 ≥ 上限最低值显示红色</div>
    </div>
    <div class="form-actions">
      <button class="btn" onclick="closeModal()">取消</button>
      <button class="btn btn-primary" id="btn-save-custom">保存</button>
    </div>
  `);
  document.getElementById('app').insertAdjacentHTML('beforeend', html);

  // 绑定添加指标
  document.getElementById('btn-add-indicator').addEventListener('click', () => {
    let list = document.getElementById('indicator-list');
    let idx = list.querySelectorAll('.indicator-edit-row').length;
    let opts = INDICATOR_DEFS.map(d => `<option value="${d.field}">${d.name}</option>`).join('');
    let row = document.createElement('div');
    row.className = 'indicator-edit-row';
    row.setAttribute('data-idx', idx);
    row.style.cssText = 'display:flex;align-items:center;gap:3px;padding:6px 0;border-bottom:1px solid var(--border);flex-wrap:wrap;';
    row.innerHTML = `
      <select class="ind-field" style="flex:0 0 auto;width:105px;font-size:11px;padding:3px;">${opts}</select>
      <input type="number" class="ind-lower-min" placeholder="下限起" step="0.01" style="width:44px;font-size:11px;padding:3px;text-align:center;">
      <span style="font-size:9px;color:var(--text-muted);">~</span>
      <input type="number" class="ind-lower-max" placeholder="下限止" step="0.01" style="width:44px;font-size:11px;padding:3px;text-align:center;">
      <input type="number" class="ind-upper-min" placeholder="上限起" step="0.01" style="width:44px;font-size:11px;padding:3px;text-align:center;">
      <span style="font-size:9px;color:var(--text-muted);">~</span>
      <input type="number" class="ind-upper-max" placeholder="上限止" step="0.01" style="width:44px;font-size:11px;padding:3px;text-align:center;">
      <input type="text" class="ind-note" placeholder="说明" style="flex:1;min-width:70px;font-size:11px;padding:3px;">
      <button class="btn btn-sm btn-danger ind-del" style="padding:1px 5px;font-size:10px;">×</button>`;
    list.appendChild(row);
    bindDelBtn(row);
  });

  // 绑定删除
  function bindDelBtn(row) {
    let delBtn = row.querySelector('.ind-del');
    if (delBtn) {
      delBtn.addEventListener('click', () => row.remove());
    }
  }
  document.querySelectorAll('#indicator-list .indicator-edit-row').forEach(r => bindDelBtn(r));

  // 保存
  document.getElementById('btn-save-custom').addEventListener('click', async () => {
    let stageDesc = document.getElementById('edit-stage-desc').value.trim();
    let rows = document.querySelectorAll('#indicator-list .indicator-edit-row');
    let indicators = [];
    rows.forEach(row => {
      let field = row.querySelector('.ind-field').value;
      let lower_min = row.querySelector('.ind-lower-min').value.trim();
      let lower_max = row.querySelector('.ind-lower-max').value.trim();
      let upper_min = row.querySelector('.ind-upper-min').value.trim();
      let upper_max = row.querySelector('.ind-upper-max').value.trim();
      let note = row.querySelector('.ind-note').value.trim();
      if (field) indicators.push({ field, lower_min, lower_max, upper_min, upper_max, note });
    });
    let newCustom = { stage_description: stageDesc, indicators };
    await saveMarketCustomSettings(newCustom);
    closeModal();
    if (typeof onSave === 'function') onSave(newCustom);
    showToast('自定义内容已保存');
  });
}

// ===== Tab 4: CSV 上传页 =====

function renderCSVPage(watchlistCount, holdingsCount) {
  return `
    ${renderPageHeader('上传文件', '导入CSV自选股数据')}
    <div class="page-content" style="padding-top:8px">
      <div class="csv-info" style="text-align:center; padding:16px; background:var(--bg-card); border-radius:var(--card-radius); border:1px solid var(--border); margin-bottom:16px;">
        <div style="font-size:14px; margin-bottom:8px;">
          当前已有 <strong>${watchlistCount}</strong> 只自选股，<strong>${holdingsCount}</strong> 只持仓股
        </div>
      </div>

      <div style="text-align:center; margin:20px 0;">
        <button class="btn btn-primary" id="btn-select-csv" style="padding:12px 24px; font-size:16px;">
          📁 选择 CSV 文件
        </button>
        <input type="file" id="csv-file-input" accept=".csv" style="display:none">
      </div>

      <div id="csv-preview-area" style="display:none">
        <div class="csv-preview">
          <h4 style="margin-bottom:8px">预览结果</h4>
          <div id="csv-preview-table"></div>
          <div id="csv-import-stats" class="import-stats"></div>
        </div>
        <div style="text-align:center; margin:16px 0;">
          <button class="btn btn-primary" id="btn-import-csv">确认导入（将替换现有自选股）</button>
        </div>
      </div>

      <div style="margin-top:24px; padding:16px; background:var(--bg-card); border-radius:var(--card-radius); border:1px solid var(--border);">
        <h4 style="margin-bottom:8px; font-size:14px;">CSV 格式说明</h4>
        <div style="font-size:12px; color:var(--text-secondary); line-height:1.8;">
          <p><strong>必需列：</strong>code（股票代码）、name（股票名称）</p>
          <p><strong>可选列：</strong>buy_price（买入价）、buy_time（买入时间）、personal_note（个人评价）</p>
          <p><strong>编码：</strong>UTF-8（支持带BOM）</p>
          <p><strong>代码格式：</strong>支持 600519 或 000001.SZ（自动补零识别市场）</p>
        </div>
      </div>
    </div>
  `;
}

// ===== Tab 4: 设置页 =====

function renderSettingsPage(settings) {
  let times = [];
  try {
    times = JSON.parse(settings.schedule_times || '[]');
  } catch(e) {
    times = [];
  }

  return `
    ${renderPageHeader('设置', '推送配置 · 阈值 · 主题')}

    <!-- 推送配置 -->
    <div class="settings-section">
      <h4>📲 推送配置</h4>
      <div class="settings-item">
        <span class="label">企业微信机器人 Webhook</span>
        <input type="text" id="setting-webhook-url" value="${escapeHtml(settings.webhook_url || '')}" placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx">
      </div>
      <div style="padding:6px 0;">
        <button class="btn btn-sm btn-primary" id="btn-save-webhook">保存 Webhook</button>
        <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">在群聊中添加机器人获取地址</span>
      </div>
      <div class="settings-item">
        <span class="label">浏览器推送状态</span>
        <span class="value" id="push-status">${settings.jpush_reg_id ? '✅ 已注册' : '❌ 未注册'}</span>
      </div>
      ${settings.jpush_reg_id ? `<div class="settings-item">
        <span class="label">Registration ID</span>
        <span class="value" style="font-size:11px;word-break:break-all">${escapeHtml(settings.jpush_reg_id)}</span>
      </div>` : ''}
      <div style="padding:10px 0; display:flex; gap:8px;">
        <button class="btn btn-sm" id="btn-register-push">注册推送</button>
        <button class="btn btn-sm" id="btn-manual-check">手动触发推送检查</button>
      </div>
      <div id="push-result"></div>
    </div>

    <!-- 推送阈值 -->
    <div class="settings-section">
      <h4>⚙️ 推送阈值</h4>
      <div class="settings-item">
        <span class="label">自选股推送阈值（实时倍数 ≤ 此值推送）</span>
        <input type="number" id="setting-watchlist-threshold" value="${settings.watchlist_multiple_threshold}" step="0.01" min="0" max="10">
      </div>
      <div class="settings-item">
        <span class="label">持仓股目标达成率阈值（≥ 此值推送）</span>
        <input type="number" id="setting-holdings-rate" value="${settings.holdings_rate_threshold}" step="0.01" min="0" max="10">
      </div>
      <div class="settings-item">
        <span class="label">持仓股买入倍数阈值（≤ 此值推送）</span>
        <input type="number" id="setting-holdings-buy" value="${settings.holdings_buy_ratio_threshold}" step="0.01" min="0" max="10">
      </div>
      <div style="padding:10px 0;">
        <button class="btn btn-primary btn-sm" id="btn-save-thresholds">保存阈值</button>
      </div>
    </div>

    <!-- 执行时间 -->
    <div class="settings-section">
      <h4>⏰ 自动检查时间</h4>
      <div class="time-chips" id="time-chips">
        ${times.map(t => `
          <span class="time-chip">
            ${escapeHtml(t)}
            <span class="remove-time" data-time="${escapeHtml(t)}">×</span>
          </span>
        `).join('')}
      </div>
      <div class="add-time-row">
        <input type="number" id="add-hour" placeholder="时" min="0" max="23" style="width:50px">
        <span>:</span>
        <input type="number" id="add-minute" placeholder="分" min="0" max="59" style="width:50px">
        <button class="btn btn-sm" id="btn-add-time">+ 添加</button>
      </div>
      <div style="padding:10px 0;">
        <button class="btn btn-primary btn-sm" id="btn-save-times">保存时间</button>
      </div>
    </div>

    <!-- 主题 -->
    <div class="settings-section">
      <h4>🎨 主题</h4>
      <div class="settings-item">
        <span class="label">深色模式</span>
        <div class="toggle ${settings.theme === 'dark' ? 'active' : ''}" id="theme-toggle"></div>
      </div>
    </div>

    <!-- GitHub Actions 自动同步 -->
    <div class="settings-section">
      <h4>🔄 同步到 GitHub Actions</h4>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
        设置 GitHub Token 后，一键同步股票列表和阈值到定时监控
      </div>
      <div class="settings-item">
        <span class="label">GitHub Token</span>
        <input type="password" id="setting-github-token" value="${escapeHtml(settings.github_token || '')}" placeholder="ghp_xxxxxxxxxxxx" autocomplete="off">
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin-bottom:8px;">
        <a href="https://github.com/settings/tokens/new?scopes=repo&description=stock-pwa-sync" target="_blank" style="color:var(--accent);">点此创建Token</a>（勾选 repo 权限，不设过期）
      </div>
      <button class="btn btn-primary" id="btn-sync-config" style="width:100%;">🔄 一键同步到 GitHub</button>
      <div id="sync-result" style="margin-top:6px;font-size:12px;"></div>
    </div>

    <!-- 日志 -->
    <div class="settings-section">
      <h4>📋 近期推送日志</h4>
      <div id="push-logs">
        <div style="text-align:center; color:var(--text-muted); padding:10px;">加载中...</div>
      </div>
    </div>
  `;
}

function renderLogs(logs) {
  if (!logs || logs.length === 0) {
    return '<div style="text-align:center; color:var(--text-muted); padding:10px;">暂无推送日志</div>';
  }
  return logs.map(log => {
    let statusIcon = log.status === 'success' ? '✅' : log.status === 'failed' ? '❌' : '⏳';
    return `
      <div style="padding:8px 0; border-bottom:1px solid var(--border); font-size:12px;">
        <div style="display:flex; justify-content:space-between;">
          <span>${statusIcon} ${log.trigger_type === 'manual' ? '手动' : '自动'}</span>
          <span style="color:var(--text-muted)">${formatTime(log.triggered_at)}</span>
        </div>
        ${log.summary ? `<div style="margin-top:2px; color:var(--text-secondary)">${escapeHtml(log.summary)}</div>` : ''}
        ${log.error_msg ? `<div style="color:var(--danger)">${escapeHtml(log.error_msg)}</div>` : ''}
      </div>
    `;
  }).join('');
}

function closeModal(event) {
  if (event && event.target !== document.getElementById('modal-overlay')) return;
  let overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.remove();
}

function escapeHtml(str) {
  if (!str) return '';
  str = String(str);
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
