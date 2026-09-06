// ===== 条件选股模块 =====
// 子功能页：下影线
// 数据源：东方财富全市场实时行情（push2.eastmoney.com），MA120 用腾讯复权日K计算

const LS_COND_KEY = 'selection_lower_shadow_conditions';

let selectionSubTab = 'lower_shadow';
let lowerShadowConditions = loadLowerShadowConditions();
let lowerShadowResults = [];
let lowerShadowSort = { key: 'shadow', dir: 'desc' };
let isScreening = false;

// 列名 → 数据字段映射
const COL_FIELD = {
  code: 'code6',
  name: 'name',
  shadow: 'shadow',
  ma120: 'ma120Ratio',
  change: 'change',
  turnover: 'turnover',
  current: 'current'
};

function loadLowerShadowConditions() {
  let defaults = { shadow: '', ma120: '', change: '' };
  try {
    let raw = localStorage.getItem(LS_COND_KEY);
    if (raw) {
      let obj = JSON.parse(raw);
      return {
        shadow: (obj.shadow != null && obj.shadow !== '') ? obj.shadow : '',
        ma120: (obj.ma120 != null && obj.ma120 !== '') ? obj.ma120 : '',
        change: (obj.change != null && obj.change !== '') ? obj.change : ''
      };
    }
  } catch (e) {}
  return defaults;
}

function saveLowerShadowConditions() {
  try {
    localStorage.setItem(LS_COND_KEY, JSON.stringify(lowerShadowConditions));
  } catch (e) {}
}

// ===== 页面入口（替代 app.js 中的占位实现） =====

function renderSelectionTab() {
  let container = document.getElementById('page-selection');
  if (!container) return;

  container.innerHTML = buildSelectionSubNav();

  let body = document.createElement('div');
  body.id = 'selection-body';
  container.appendChild(body);

  if (selectionSubTab === 'low_open_high') {
    renderLowOpenHighPage(body);
  } else {
    renderLowerShadowPage(body);
  }
  bindSelectionSubNavEvents(container);
}

function buildSelectionSubNav() {
  let tabs = [
    { id: 'lower_shadow', label: '下影线' },
    { id: 'low_open_high', label: '低开高走' }
  ];
  return `
    <div class="selection-sub-nav" style="display:flex;align-items:center;gap:4px;overflow-x:auto;padding:10px 12px 0;white-space:nowrap;-webkit-overflow-scrolling:touch;">
      ${tabs.map(t => `
        <button class="selection-sub-tab" data-sel="${t.id}" style="padding:7px 14px;font-size:13px;font-weight:600;border:none;border-radius:7px 7px 0 0;cursor:pointer;white-space:nowrap;background:${selectionSubTab===t.id?'var(--bg-card)':'transparent'};color:${selectionSubTab===t.id?'var(--text)':'var(--text-muted)'};">${t.label}</button>
      `).join('')}
    </div>`;
}

function bindSelectionSubNavEvents(container) {
  container.querySelectorAll('.selection-sub-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.sel === selectionSubTab) return;
      selectionSubTab = btn.dataset.sel;
      renderSelectionTab();
    });
  });
}

// ===== 下影线子页 =====

function renderLowerShadowPage(body) {
  let c = lowerShadowConditions;
  body.innerHTML = `
    <div style="padding:12px 12px 24px;">
      <div class="condition-panel" style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">筛选条件（输入后自动保存）</div>

        <div class="cond-item" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <span style="font-size:13px;flex:1;">下影线涨幅 ≥</span>
          <input type="number" id="cond-shadow" value="${escapeHtml(c.shadow)}" step="0.01" placeholder="如 3" inputmode="decimal" style="width:90px;padding:7px 10px;font-size:14px;border:1px solid var(--border);border-radius:7px;background:var(--bg-input);color:var(--text);text-align:right;">
          <span style="font-size:13px;width:18px;text-align:right;">%</span>
        </div>

        <div class="cond-item" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <span style="font-size:13px;flex:1;">MA120乖离 ≤</span>
          <input type="number" id="cond-ma120" value="${escapeHtml(c.ma120)}" step="0.01" placeholder="如 100" inputmode="decimal" style="width:90px;padding:7px 10px;font-size:14px;border:1px solid var(--border);border-radius:7px;background:var(--bg-input);color:var(--text);text-align:right;">
          <span style="font-size:13px;width:18px;text-align:right;">%</span>
        </div>

        <div class="cond-item" style="display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:13px;flex:1;">涨幅 ≥</span>
          <input type="number" id="cond-change" value="${escapeHtml(c.change)}" step="0.01" placeholder="如 0" inputmode="decimal" style="width:90px;padding:7px 10px;font-size:14px;border:1px solid var(--border);border-radius:7px;background:var(--bg-input);color:var(--text);text-align:right;">
          <span style="font-size:13px;width:18px;text-align:right;">%</span>
        </div>

        <div style="font-size:10px;color:var(--text-muted);margin-top:8px;line-height:1.5;">
          下影线涨幅 = (min(开盘价, 现价) − 最低价) ÷ 前收价 × 100%<br>
          MA120乖离 = 现价 ÷ MA120均价 × 100%
        </div>
      </div>

      <button class="btn btn-primary" id="btn-start-screen" style="width:100%;margin-top:12px;padding:12px 0;font-size:15px;">开始筛选</button>

      <div id="screen-progress" style="margin-top:10px;font-size:12px;color:var(--text-secondary);"></div>
      <div id="screen-results" style="margin-top:10px;"></div>
    </div>`;

  // 条件输入持久化
  ['shadow', 'ma120', 'change'].forEach(k => {
    let el = body.querySelector('#cond-' + k);
    if (el) {
      el.addEventListener('input', () => {
        lowerShadowConditions[k] = el.value;
        saveLowerShadowConditions();
      });
    }
  });

  let btn = body.querySelector('#btn-start-screen');
  if (btn) btn.addEventListener('click', () => startScreen());

  // 若已有结果（切页后返回），恢复展示
  let resultsEl = body.querySelector('#screen-results');
  if (resultsEl && lowerShadowResults.length > 0) {
    renderResultsTable(resultsEl);
  }
}

// ===== 东方财富全市场实时行情 =====

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 多个行情源镜像，主源失败自动切换备用源
const EM_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com'
];

async function fetchAllAQuotes() {
  let lastErr = null;
  for (let host of EM_HOSTS) {
    try {
      return await fetchQuotesFromHost(host);
    } catch (e) {
      lastErr = e;
      console.warn('行情源 ' + host + ' 失败，尝试备用源：', e);
    }
  }
  throw lastErr || new Error('全部行情源请求失败');
}

async function fetchQuotesFromHost(host) {
  const pz = 100;
  let all = [];
  let pn = 1;

  while (true) {
    let url = `${host}/api/qt/clist/get?pn=${pn}&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=f3` +
      `&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23` +
      `&fields=f2,f3,f5,f8,f12,f13,f14,f15,f16,f17,f18`;

    let json = await fetchWithRetry(url);
    if (!json || json.data == null) {
      throw new Error('行情源返回异常(rc=' + (json && json.rc != null ? json.rc : 'null') + ')');
    }
    let data = json.data;
    if (!Array.isArray(data.diff)) break;

    all.push(...data.diff);

    let total = data.total || 0;
    if (all.length >= total || data.diff.length < pz) break;
    pn++;
    if (pn % 5 === 0) await sleep(120); // 每5页稍作停顿，降低触发限频的概率
  }

  let rows = all.map(mapEastMoneyRow).filter(r => r != null);
  if (rows.length === 0) throw new Error('未获取到任何行情数据');
  return rows;
}

async function fetchWithRetry(url, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      let controller = new AbortController();
      let timeout = setTimeout(() => controller.abort(), 20000);
      let resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      let text = await resp.text();
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        throw new Error('响应非JSON(可能被限频或网络拦截)');
      }
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) await sleep(600 * (i + 1));
    }
  }
  throw lastErr || new Error('请求失败');
}

function mapEastMoneyRow(r) {
  let code6 = String(r.f12 || '').padStart(6, '0');
  let market = (r.f13 === 1) ? 'SH' : 'SZ';
  let stdCode = code6 + '.' + market;

  let current = parseFloat(r.f2);
  let change = parseFloat(r.f3);
  let turnover = parseFloat(r.f8);
  let volume = parseFloat(r.f5);
  let high = parseFloat(r.f15);
  let low = parseFloat(r.f16);
  let open = parseFloat(r.f17);
  let prevClose = parseFloat(r.f18);

  if (isNaN(current) || current <= 0) return null;

  let shadow = null;
  let openRatio = null;
  let bodyRatio = null;
  let upperShadowRatio = null;

  if (!isNaN(open) && !isNaN(low) && !isNaN(prevClose) && prevClose > 0) {
    shadow = (Math.min(open, current) - low) / prevClose * 100;
  }

  if (!isNaN(open) && !isNaN(prevClose) && prevClose > 0) {
    openRatio = (open - prevClose) / prevClose * 100;
    if (!isNaN(current)) {
      bodyRatio = (current - open) / prevClose * 100;
      if (!isNaN(high)) {
        upperShadowRatio = (high - Math.max(open, current)) / prevClose * 100;
      }
    }
  }

  return {
    code: stdCode,
    code6: code6,
    name: String(r.f14 || code6),
    current: current,
    change: isNaN(change) ? null : change,
    turnover: isNaN(turnover) ? null : turnover,
    volume: isNaN(volume) ? null : volume,
    high: high, low: low, open: open, prevClose: prevClose,
    shadow: shadow,
    openRatio: openRatio,
    bodyRatio: bodyRatio,
    upperShadowRatio: upperShadowRatio,
    ma120: null,
    ma120Ratio: null
  };
}

// ===== 两阶段筛选 =====

async function startScreen() {
  if (isScreening) return;

  let shadowVal = parseFloat(lowerShadowConditions.shadow);
  let ma120Val = parseFloat(lowerShadowConditions.ma120);
  let changeVal = parseFloat(lowerShadowConditions.change);

  let shadowMin = isNaN(shadowVal) ? -Infinity : shadowVal;
  let ma120Max = isNaN(ma120Val) ? Infinity : ma120Val;
  let changeMin = isNaN(changeVal) ? -Infinity : changeVal;

  if (shadowMin === -Infinity && ma120Max === Infinity && changeMin === -Infinity) {
    showToast('请至少输入一个筛选条件', 'error');
    return;
  }

  let btn = document.getElementById('btn-start-screen');
  let progressEl = document.getElementById('screen-progress');
  let resultsEl = document.getElementById('screen-results');

  isScreening = true;
  if (btn) { btn.disabled = true; btn.textContent = '筛选中…'; }
  if (progressEl) progressEl.innerHTML = '<div class="loading-indicator"><span class="spinner"></span> 正在获取全市场实时行情…</div>';
  if (resultsEl) resultsEl.innerHTML = '';

  try {
    let allRows = await fetchAllAQuotes();
    setProgress(progressEl, `已获取 ${allRows.length} 只股票行情，正在进行下影线/涨幅初筛…`);

    // 阶段一：实时行情即可判断的条件（下影线涨幅、涨幅）
    let stage1 = allRows.filter(r =>
      r.shadow != null && r.shadow >= shadowMin &&
      r.change != null && r.change >= changeMin
    );

    // 阶段二：需要K线计算的 MA120 乖离
    let needMA = ma120Max !== Infinity || stage1.length <= 600;
    let final;

    if (needMA) {
      setProgress(progressEl, `初筛后剩余 ${stage1.length} 只，正在计算 MA120 乖离…`);
      let withMA = await computeMA120(stage1, (done, total) => {
        if (done % 20 === 0 || done === total) {
          setProgress(progressEl, `正在计算 MA120 乖离：${done}/${total}`);
        }
      });

      final = withMA.filter(r => {
        if (ma120Max !== Infinity) {
          return r.ma120Ratio != null && r.ma120Ratio <= ma120Max;
        }
        return true;
      });
    } else {
      final = stage1;
    }

    lowerShadowResults = final;
    lowerShadowSort = { key: 'shadow', dir: 'desc' };

    if (progressEl) progressEl.innerHTML = '';
    if (resultsEl) renderResultsTable(resultsEl);

    if (final.length === 0) {
      showToast('未找到符合条件的股票', 'error');
    } else {
      showToast(`筛选完成，共 ${final.length} 只`);
    }
  } catch (e) {
    console.error('筛选失败:', e);
    let msg = (e && e.message) ? e.message : String(e);
    if (/Failed to fetch|NetworkError|网络错误/i.test(msg)) {
      msg = '网络请求失败，请检查网络后重试';
    }
    if (progressEl) progressEl.innerHTML = `<div class="inline-msg error">筛选失败：${escapeHtml(msg)}</div>`;
    showToast('筛选失败，请重试', 'error');
  } finally {
    isScreening = false;
    if (btn) { btn.disabled = false; btn.textContent = '开始筛选'; }
  }
}

function setProgress(el, msg) {
  if (el) el.innerHTML = `<div class="loading-indicator"><span class="spinner"></span> ${escapeHtml(msg)}</div>`;
}

// 计算收盘价序列最近 120 日的简单移动平均（返回标量）。
// 注意：全局已有 charts.js 定义的 calcMA（返回数组），此处必须用独立函数名，避免被覆盖导致计算出错。
function calcMA120Value(closes) {
  let n = Math.min(closes.length, 120);
  if (n === 0) return null;
  let sum = 0;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i];
  return sum / n;
}

async function computeMA120(candidates, onProgress) {
  const CONCURRENCY = 10;
  const results = new Array(candidates.length);
  let idx = 0;
  let done = 0;

  async function worker() {
    while (idx < candidates.length) {
      let i = idx++;
      let r = candidates[i];
      let ma120 = null;
      let ma120Ratio = null;

      try {
        let kl = await fetchKLine(r.code, 120);
        if (kl && kl.candles && kl.candles.length >= 120) {
          let closes = kl.candles.map(c => c.close).filter(v => !isNaN(v));
          if (closes.length >= 120) {
            ma120 = calcMA120Value(closes);
          }
        }
      } catch (e) {
        ma120 = null;
      }

      if (ma120 && ma120 > 0 && r.current > 0) {
        ma120Ratio = r.current / ma120 * 100;
      }

      results[i] = Object.assign({}, r, { ma120: ma120, ma120Ratio: ma120Ratio });
      done++;
      if (onProgress) onProgress(done, candidates.length);
    }
  }

  let workers = [];
  for (let k = 0; k < CONCURRENCY; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ===== 结果表格 =====

function sortResults(rows) {
  let key = COL_FIELD[lowerShadowSort.key] || 'shadow';
  let dir = lowerShadowSort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let va = a[key];
    let vb = b[key];
    let aNull = va == null || (typeof va === 'number' && isNaN(va));
    let bNull = vb == null || (typeof vb === 'number' && isNaN(vb));
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (typeof va === 'string') return va.localeCompare(vb, 'zh') * dir;
    return (va - vb) * dir;
  });
}

function fmtCell(key, r) {
  switch (key) {
    case 'code': return r.code6;
    case 'name': return escapeHtml(r.name);
    case 'shadow': return r.shadow != null ? r.shadow.toFixed(2) + '%' : '--';
    case 'ma120': return r.ma120Ratio != null ? r.ma120Ratio.toFixed(2) + '%' : '--';
    case 'change': return r.change != null ? formatPercent(r.change) : '--';
    case 'turnover': return r.turnover != null ? r.turnover.toFixed(2) + '%' : '--';
    case 'current': return r.current != null ? formatPrice(r.current) : '--';
    default: return '--';
  }
}

function buildResultsHtml(rows) {
  let headers = [
    { key: 'code', label: '代码' },
    { key: 'name', label: '名称' },
    { key: 'shadow', label: '下影线涨幅' },
    { key: 'ma120', label: 'MA120乖离' },
    { key: 'change', label: '涨幅' },
    { key: 'turnover', label: '换手率' },
    { key: 'current', label: '现价' },
    { key: null, label: '操作' }
  ];

  let thead = headers.map(h => {
    if (!h.key) return `<th style="padding:7px 6px;text-align:center;position:sticky;top:0;background:var(--bg-input);z-index:1;white-space:nowrap;">${h.label}</th>`;
    let isActive = lowerShadowSort.key === h.key;
    let arrow = isActive ? (lowerShadowSort.dir === 'asc' ? '▲' : '▼') : '';
    return `<th data-sort="${h.key}" style="padding:7px 6px;text-align:right;position:sticky;top:0;background:var(--bg-input);z-index:1;white-space:nowrap;cursor:pointer;user-select:none;color:${isActive?'var(--accent)':'var(--text)'};">${h.label} ${arrow}</th>`;
  }).join('');

  let tbody = rows.map(r => {
    let changeColor = '';
    if (r.change != null) {
      changeColor = r.change > 0 ? 'color:var(--up-color);' : (r.change < 0 ? 'color:var(--down-color);' : '');
    }
    let shadowColor = (r.shadow != null && r.shadow > 0) ? 'color:var(--up-color);' : '';
    return `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:6px;text-align:right;white-space:nowrap;"><a href="javascript:void(0)" class="sel-code" data-action="detail" data-code="${r.code}" style="color:var(--accent);text-decoration:none;font-weight:600;">${r.code6}</a></td>
      <td style="padding:6px;text-align:right;white-space:nowrap;"><a href="javascript:void(0)" class="sel-name" data-action="detail" data-code="${r.code}" style="color:var(--text);text-decoration:none;">${escapeHtml(r.name)}</a></td>
      <td style="padding:6px;text-align:right;white-space:nowrap;${shadowColor}">${fmtCell('shadow', r)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap;">${fmtCell('ma120', r)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap;${changeColor}">${fmtCell('change', r)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap;">${fmtCell('turnover', r)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap;">${fmtCell('current', r)}</td>
      <td style="padding:6px;text-align:center;white-space:nowrap;"><button class="btn btn-sm btn-primary" data-action="add-watch" data-code="${r.code}" data-name="${escapeHtml(r.name)}" style="padding:3px 8px;font-size:11px;">＋自选</button></td>
    </tr>`;
  }).join('');

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <span style="font-size:12px;color:var(--text-secondary);">共 <strong style="color:var(--accent);">${rows.length}</strong> 只</span>
      <span style="font-size:10px;color:var(--text-muted);">点击列名排序 · 点击代码/名称查看详情</span>
    </div>
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:10px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap;">
        <thead><tr style="background:var(--bg-input);">${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}

function renderResultsTable(container) {
  if (!container) return;
  let sorted = sortResults(lowerShadowResults);
  container.innerHTML = buildResultsHtml(sorted);
  bindResultsEvents(container);
}

function bindResultsEvents(container) {
  // 列排序
  container.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      let key = th.dataset.sort;
      if (lowerShadowSort.key === key) {
        lowerShadowSort.dir = lowerShadowSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        lowerShadowSort.key = key;
        lowerShadowSort.dir = 'desc';
      }
      renderResultsTable(container);
    });
  });

  // 详情跳转 + 加自选
  container.addEventListener('click', (e) => {
    let detailEl = e.target.closest('[data-action="detail"]');
    if (detailEl) {
      let code = detailEl.dataset.code;
      let row = lowerShadowResults.find(r => r.code === code);
      if (row) {
        showDetailPage(
          { name: row.name, code: row.code },
          { last_px: row.current, px_change_rate: row.change, error: null }
        );
      }
      return;
    }

    let addEl = e.target.closest('[data-action="add-watch"]');
    if (addEl) {
      let code = addEl.dataset.code;
      let row = lowerShadowResults.find(r => r.code === code);
      if (row) addToWatchlist(row, addEl);
    }
  });
}

async function addToWatchlist(row, btnEl) {
  try {
    let existing = await getAllStocks('watchlist');
    if (existing.some(s => s.code === row.code)) {
      showToast(`${row.name} 已在自选股中`, 'error');
      return;
    }
    await addStock({ code: row.code, name: row.name, stock_type: 'watchlist' });
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '已添加'; }
    showToast(`已添加 ${row.name} 到自选股`);
  } catch (e) {
    console.error('添加自选股失败:', e);
    showToast('添加失败，请重试', 'error');
  }
}

// ===================== 低开高走 子页 =====================
// 条件：开盘涨幅(≤)、蜡烛实体涨幅(≥)、MA120乖离(≤)、上影线实体涨幅(≤)、成交量MA10乖离(≤)

const LS_LOW_COND_KEY = 'selection_low_open_high_conditions';

let lowOpenHighConditions = loadLowOpenHighConditions();
let lowOpenHighResults = [];
let lowOpenHighSort = { key: 'body', dir: 'desc' };
let isLowOpenScreening = false;

const LOW_COL_FIELD = {
  code: 'code6',
  name: 'name',
  open: 'openRatio',
  body: 'bodyRatio',
  ma120: 'ma120Ratio',
  upperShadow: 'upperShadowRatio',
  volMA10: 'volMA10Ratio',
  change: 'change',
  turnover: 'turnover',
  current: 'current'
};

function loadLowOpenHighConditions() {
  let defaults = { open: '', body: '', ma120: '', upperShadow: '', volMA10: '' };
  try {
    let raw = localStorage.getItem(LS_LOW_COND_KEY);
    if (raw) {
      let obj = JSON.parse(raw);
      let out = {};
      ['open', 'body', 'ma120', 'upperShadow', 'volMA10'].forEach(k => {
        out[k] = (obj[k] != null && obj[k] !== '') ? obj[k] : '';
      });
      return out;
    }
  } catch (e) {}
  return defaults;
}

function saveLowOpenHighConditions() {
  try {
    localStorage.setItem(LS_LOW_COND_KEY, JSON.stringify(lowOpenHighConditions));
  } catch (e) {}
}

function renderLowOpenHighPage(body) {
  let c = lowOpenHighConditions;

  function condItem(key, label, placeholder) {
    return `
      <div class="cond-item" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <span style="font-size:13px;flex:1;">${label}</span>
        <input type="number" id="cond-low-${key}" value="${escapeHtml(c[key])}" step="0.01" placeholder="${placeholder}" inputmode="decimal" style="width:90px;padding:7px 10px;font-size:14px;border:1px solid var(--border);border-radius:7px;background:var(--bg-input);color:var(--text);text-align:right;">
        <span style="font-size:13px;width:18px;text-align:right;">%</span>
      </div>`;
  }

  body.innerHTML = `
    <div style="padding:12px 12px 24px;">
      <div class="condition-panel" style="background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:12px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">筛选条件（输入后自动保存）</div>
        ${condItem('open', '开盘涨幅 ≤', '如 0（低开为负）')}
        ${condItem('body', '蜡烛实体涨幅 ≥', '如 2')}
        ${condItem('ma120', 'MA120乖离 ≤', '如 100（低于均线<100）')}
        ${condItem('upperShadow', '上影线实体涨幅 ≤', '如 1')}
        ${condItem('volMA10', '成交量MA10乖离 ≤', '如 100（缩量<100）')}
        <div style="font-size:10px;color:var(--text-muted);margin-top:8px;line-height:1.6;">
          开盘涨幅 = (开盘价 − 前收价) ÷ 前收价 × 100%（低开为负）<br>
          蜡烛实体涨幅 = (现价 − 开盘价) ÷ 前收价 × 100%<br>
          MA120乖离 = 现价 ÷ MA120均价 × 100%<br>
          上影线实体涨幅 = (最高价 − max(开盘价, 现价)) ÷ 前收价 × 100%<br>
          成交量MA10乖离 = 成交量 ÷ 成交量MA10均值 × 100%
        </div>
      </div>

      <button class="btn btn-primary" id="btn-low-screen" style="width:100%;margin-top:12px;padding:12px 0;font-size:15px;">开始筛选</button>

      <div id="low-screen-progress" style="margin-top:10px;font-size:12px;color:var(--text-secondary);"></div>
      <div id="low-screen-results" style="margin-top:10px;"></div>
    </div>`;

  ['open', 'body', 'ma120', 'upperShadow', 'volMA10'].forEach(k => {
    let el = body.querySelector('#cond-low-' + k);
    if (el) {
      el.addEventListener('input', () => {
        lowOpenHighConditions[k] = el.value;
        saveLowOpenHighConditions();
      });
    }
  });

  let btn = body.querySelector('#btn-low-screen');
  if (btn) btn.addEventListener('click', () => startLowOpenHighScreen());

  let resultsEl = body.querySelector('#low-screen-results');
  if (resultsEl && lowOpenHighResults.length > 0) {
    lowRenderResultsTable(resultsEl);
  }
}

function condToNum(v, defaultVal) {
  let n = parseFloat(v);
  return isNaN(n) ? defaultVal : n;
}

async function startLowOpenHighScreen() {
  if (isLowOpenScreening) return;

  let openMax = condToNum(lowOpenHighConditions.open, Infinity);
  let bodyMin = condToNum(lowOpenHighConditions.body, -Infinity);
  let ma120Max = condToNum(lowOpenHighConditions.ma120, Infinity);
  let upperShadowMax = condToNum(lowOpenHighConditions.upperShadow, Infinity);
  let volMA10Max = condToNum(lowOpenHighConditions.volMA10, Infinity);

  if (openMax === Infinity && bodyMin === -Infinity && ma120Max === Infinity &&
      upperShadowMax === Infinity && volMA10Max === Infinity) {
    showToast('请至少输入一个筛选条件', 'error');
    return;
  }

  let btn = document.getElementById('btn-low-screen');
  let progressEl = document.getElementById('low-screen-progress');
  let resultsEl = document.getElementById('low-screen-results');

  isLowOpenScreening = true;
  if (btn) { btn.disabled = true; btn.textContent = '筛选中…'; }
  if (progressEl) progressEl.innerHTML = '<div class="loading-indicator"><span class="spinner"></span> 正在获取全市场实时行情…</div>';
  if (resultsEl) resultsEl.innerHTML = '';

  try {
    let allRows = await fetchAllAQuotes();
    setProgress(progressEl, `已获取 ${allRows.length} 只股票行情，正在进行初筛…`);

    // 阶段一：实时行情可算的条件（开盘涨幅、蜡烛实体涨幅、上影线实体涨幅）
    let stage1 = allRows.filter(r => {
      if (r.openRatio == null) return false;
      if (r.openRatio > openMax) return false;
      if (r.bodyRatio == null || r.bodyRatio < bodyMin) return false;
      if (r.upperShadowRatio != null && r.upperShadowRatio > upperShadowMax) return false;
      return true;
    });

    let needKline = ma120Max !== Infinity || volMA10Max !== Infinity;
    let final;

    if (needKline && stage1.length > 0) {
      setProgress(progressEl, `初筛后剩余 ${stage1.length} 只，正在计算 MA120 / 成交量MA10…`);
      let withInd = await computeLowOpenIndicators(stage1, (done, total) => {
        if (done % 20 === 0 || done === total) {
          setProgress(progressEl, `正在计算 MA120 / 成交量MA10：${done}/${total}`);
        }
      });

      final = withInd.filter(r => {
        if (ma120Max !== Infinity && (r.ma120Ratio == null || r.ma120Ratio > ma120Max)) return false;
        if (volMA10Max !== Infinity && (r.volMA10Ratio == null || r.volMA10Ratio > volMA10Max)) return false;
        return true;
      });
    } else {
      final = stage1;
    }

    lowOpenHighResults = final;
    lowOpenHighSort = { key: 'body', dir: 'desc' };

    if (progressEl) progressEl.innerHTML = '';
    if (resultsEl) lowRenderResultsTable(resultsEl);

    if (final.length === 0) {
      showToast('未找到符合条件的股票', 'error');
    } else {
      showToast(`筛选完成，共 ${final.length} 只`);
    }
  } catch (e) {
    console.error('低开高走筛选失败:', e);
    let msg = (e && e.message) ? e.message : String(e);
    if (/Failed to fetch|NetworkError|网络错误/i.test(msg)) {
      msg = '网络请求失败，请检查网络后重试';
    }
    if (progressEl) progressEl.innerHTML = `<div class="inline-msg error">筛选失败：${escapeHtml(msg)}</div>`;
    showToast('筛选失败，请重试', 'error');
  } finally {
    isLowOpenScreening = false;
    if (btn) { btn.disabled = false; btn.textContent = '开始筛选'; }
  }
}

async function computeLowOpenIndicators(candidates, onProgress) {
  const CONCURRENCY = 10;
  const results = new Array(candidates.length);
  let idx = 0;
  let done = 0;

  async function worker() {
    while (idx < candidates.length) {
      let i = idx++;
      let r = candidates[i];
      let ma120 = null, ma120Ratio = null;
      let volMA10 = null, volMA10Ratio = null;

      try {
        let kl = await fetchKLine(r.code, 120);
        if (kl && kl.candles && kl.candles.length > 0) {
          let closes = kl.candles.map(c => c.close).filter(v => !isNaN(v));
          if (closes.length >= 120) {
            ma120 = calcMA120Value(closes);
          }
          // 成交量单位统一为"手"：K线 candle.volume 为"股"(×100)，实时 f5 为"手"
          let vols = kl.candles.map(c => (c.volume || 0) / 100);
          let recent = vols.slice(-10);
          if (recent.length > 0) {
            let sum = 0;
            for (let v of recent) sum += v;
            volMA10 = sum / recent.length;
          }
        }
      } catch (e) {
        ma120 = null;
        volMA10 = null;
      }

      if (ma120 && ma120 > 0 && r.current > 0) {
        ma120Ratio = r.current / ma120 * 100;
      }
      if (volMA10 && volMA10 > 0 && r.volume && r.volume > 0) {
        volMA10Ratio = r.volume / volMA10 * 100;
      }

      results[i] = Object.assign({}, r, { ma120: ma120, ma120Ratio: ma120Ratio, volMA10: volMA10, volMA10Ratio: volMA10Ratio });
      done++;
      if (onProgress) onProgress(done, candidates.length);
    }
  }

  let workers = [];
  for (let k = 0; k < CONCURRENCY; k++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function lowSortResults(rows) {
  let key = LOW_COL_FIELD[lowOpenHighSort.key] || 'bodyRatio';
  let dir = lowOpenHighSort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let va = a[key];
    let vb = b[key];
    let aNull = va == null || (typeof va === 'number' && isNaN(va));
    let bNull = vb == null || (typeof vb === 'number' && isNaN(vb));
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (typeof va === 'string') return va.localeCompare(vb, 'zh') * dir;
    return (va - vb) * dir;
  });
}

function lowFmtCell(key, r) {
  switch (key) {
    case 'code': return r.code6;
    case 'name': return escapeHtml(r.name);
    case 'open': return r.openRatio != null ? r.openRatio.toFixed(2) + '%' : '--';
    case 'body': return r.bodyRatio != null ? r.bodyRatio.toFixed(2) + '%' : '--';
    case 'ma120': return r.ma120Ratio != null ? r.ma120Ratio.toFixed(2) + '%' : '--';
    case 'upperShadow': return r.upperShadowRatio != null ? r.upperShadowRatio.toFixed(2) + '%' : '--';
    case 'volMA10': return r.volMA10Ratio != null ? r.volMA10Ratio.toFixed(2) + '%' : '--';
    case 'change': return r.change != null ? formatPercent(r.change) : '--';
    case 'turnover': return r.turnover != null ? r.turnover.toFixed(2) + '%' : '--';
    case 'current': return r.current != null ? formatPrice(r.current) : '--';
    default: return '--';
  }
}

function lowBuildResultsHtml(rows) {
  let headers = [
    { key: 'code', label: '代码' },
    { key: 'name', label: '名称' },
    { key: 'open', label: '开盘涨幅' },
    { key: 'body', label: '蜡烛实体涨幅' },
    { key: 'ma120', label: 'MA120乖离' },
    { key: 'upperShadow', label: '上影线实体涨幅' },
    { key: 'volMA10', label: '成交量MA10乖离' },
    { key: 'change', label: '涨幅' },
    { key: 'turnover', label: '换手率' },
    { key: 'current', label: '现价' },
    { key: null, label: '操作' }
  ];

  let thead = headers.map(h => {
    if (!h.key) return `<th style="padding:7px 6px;text-align:center;position:sticky;top:0;background:var(--bg-input);z-index:1;white-space:nowrap;">${h.label}</th>`;
    let isActive = lowOpenHighSort.key === h.key;
    let arrow = isActive ? (lowOpenHighSort.dir === 'asc' ? '▲' : '▼') : '';
    return `<th data-sort="${h.key}" style="padding:7px 6px;text-align:right;position:sticky;top:0;background:var(--bg-input);z-index:1;white-space:nowrap;cursor:pointer;user-select:none;color:${isActive?'var(--accent)':'var(--text)'};">${h.label} ${arrow}</th>`;
  }).join('');

  let tbody = rows.map(r => {
    let changeColor = '';
    if (r.change != null) {
      changeColor = r.change > 0 ? 'color:var(--up-color);' : (r.change < 0 ? 'color:var(--down-color);' : '');
    }
    let bodyColor = (r.bodyRatio != null && r.bodyRatio > 0) ? 'color:var(--up-color);' : '';
    return `<tr style="border-bottom:1px solid var(--border);">
      <td style="padding:6px;text-align:right;white-space:nowrap;"><a href="javascript:void(0)" class="sel-code" data-action="detail" data-code="${r.code}" style="color:var(--accent);text-decoration:none;font-weight:600;">${r.code6}</a></td>
      <td style="padding:6px;text-align:right;white-space:nowrap;"><a href="javascript:void(0)" class="sel-name" data-action="detail" data-code="${r.code}" style="color:var(--text);text-decoration:none;">${escapeHtml(r.name)}</a></td>
      <td style="padding:6px;text-align:right;white-space:nowrap;">${lowFmtCell('open', r)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap;${bodyColor}">${lowFmtCell('body', r)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap;">${lowFmtCell('ma120', r)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap;">${lowFmtCell('upperShadow', r)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap;">${lowFmtCell('volMA10', r)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap;${changeColor}">${lowFmtCell('change', r)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap;">${lowFmtCell('turnover', r)}</td>
      <td style="padding:6px;text-align:right;white-space:nowrap;">${lowFmtCell('current', r)}</td>
      <td style="padding:6px;text-align:center;white-space:nowrap;"><button class="btn btn-sm btn-primary" data-action="add-watch" data-code="${r.code}" data-name="${escapeHtml(r.name)}" style="padding:3px 8px;font-size:11px;">＋自选</button></td>
    </tr>`;
  }).join('');

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <span style="font-size:12px;color:var(--text-secondary);">共 <strong style="color:var(--accent);">${rows.length}</strong> 只</span>
      <span style="font-size:10px;color:var(--text-muted);">点击列名排序 · 点击代码/名称查看详情</span>
    </div>
    <div style="overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:10px;">
      <table style="width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap;">
        <thead><tr style="background:var(--bg-input);">${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
}

function lowRenderResultsTable(container) {
  if (!container) return;
  let sorted = lowSortResults(lowOpenHighResults);
  container.innerHTML = lowBuildResultsHtml(sorted);
  lowBindResultsEvents(container);
}

function lowBindResultsEvents(container) {
  container.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      let key = th.dataset.sort;
      if (lowOpenHighSort.key === key) {
        lowOpenHighSort.dir = lowOpenHighSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        lowOpenHighSort.key = key;
        lowOpenHighSort.dir = 'desc';
      }
      lowRenderResultsTable(container);
    });
  });

  container.addEventListener('click', (e) => {
    let detailEl = e.target.closest('[data-action="detail"]');
    if (detailEl) {
      let code = detailEl.dataset.code;
      let row = lowOpenHighResults.find(r => r.code === code);
      if (row) {
        showDetailPage(
          { name: row.name, code: row.code },
          { last_px: row.current, px_change_rate: row.change, error: null }
        );
      }
      return;
    }

    let addEl = e.target.closest('[data-action="add-watch"]');
    if (addEl) {
      let code = addEl.dataset.code;
      let row = lowOpenHighResults.find(r => r.code === code);
      if (row) addToWatchlist(row, addEl);
    }
  });
}
