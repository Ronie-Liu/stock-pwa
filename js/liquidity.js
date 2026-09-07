// ===== 流动性晴雨表（环境页子功能 · 每周手动打分） =====
// 口径：5项指标 × 20分 = 总分100；每周手动打分一次，纯本地记录（IndexedDB: liquidity_daily）。
// 指标3按用户口径使用「融资余额20日变化」替代北向资金。
// 设计：每项先点档位快捷按钮选区间中值，再拖滑块微调；总分与档位实时联动，支持按日切换/编辑/覆盖保存。

const LIQ_WEIGHTS = [20, 20, 20, 20, 20]; // 每项满分20
const LIQ_N = 30;                          // 走势图最多显示近N条记录

let liquidityChart = null;                 // ECharts 走势图实例
let liqScores = [10, 10, 10, 10, 10];      // 当前编辑的5项分数（0-20，步长0.5）
let liqEditingDate = '';                   // 当前打分日期 YYYY-MM-DD

// ===== 指标定义（档位自上而下：最优→最差，与用户打分表一致） =====

const LIQ_INDICATORS = [
  {
    key: 'turnover', name: '两市成交额20日均值趋势', basis: '与过去半年均值对比',
    tiers: [
      { lo: 16, hi: 20, label: '显著放量', sub: '20日均额 > 半年均值 ×120%' },
      { lo: 11, hi: 15, label: '温和放量', sub: '半年均值 ×100%~120%' },
      { lo: 6, hi: 10, label: '基本持平', sub: '半年均值 ×80%~100%' },
      { lo: 0, hi: 5, label: '明显缩量', sub: '20日均额 < 半年均值 ×80%' }
    ]
  },
  {
    key: 'm1m2', name: 'M1-M2剪刀差（近3个月变化）', basis: '反映企业活期存款意愿，领先指标；数据每月公布，周度打分参考最近一个月变化',
    tiers: [
      { lo: 16, hi: 20, label: '剪刀差回升', sub: 'M1增速 - M2增速 扩大' },
      { lo: 10, hi: 15, label: '基本持平', sub: '剪刀差变化不大' },
      { lo: 5, hi: 9, label: '小幅回落', sub: '剪刀差略有收窄' },
      { lo: 0, hi: 4, label: '明显回落', sub: '剪刀差显著收窄' }
    ]
  },
  {
    key: 'margin', name: '融资余额20日变化', basis: '两市融资余额20日增幅（杠杆资金进出）',
    tiers: [
      { lo: 16, hi: 20, label: '明显加杠杆', sub: '20日增幅 > 3%' },
      { lo: 11, hi: 15, label: '温和加杠杆', sub: '20日增幅 0%~3%' },
      { lo: 6, hi: 10, label: '小幅降杠杆', sub: '20日增幅 -3%~0' },
      { lo: 0, hi: 5, label: '明显降杠杆', sub: '20日增幅 < -3%' }
    ]
  },
  {
    key: 'us10y', name: '10年期美债收益率趋势', basis: '全球风险资产定价锚，影响外资流向与成长股估值',
    tiers: [
      { lo: 16, hi: 20, label: '持续下行', sub: '较前期回落 20bp 以上' },
      { lo: 11, hi: 15, label: '小幅下行', sub: '收益率温和走低' },
      { lo: 6, hi: 10, label: '横盘震荡', sub: '收益率区间盘整' },
      { lo: 0, hi: 5, label: '持续上行', sub: '收益率趋势走高' }
    ]
  },
  {
    key: 'policy', name: '央行货币政策态度', basis: '降准降息/MLF放量/公开市场操作等信号',
    tiers: [
      { lo: 16, hi: 20, label: '明确宽松', sub: '降准降息 / MLF放量' },
      { lo: 11, hi: 15, label: '中性偏松', sub: '呵护流动性的操作偏多' },
      { lo: 6, hi: 10, label: '中性', sub: '正常对冲，无方向性表态' },
      { lo: 0, hi: 5, label: '偏紧', sub: '回笼资金 / 边际收紧' }
    ]
  }
];

// ===== 总分档位（用户表：80-100 充裕 / 60-79 中性偏好 / 40-59 中性偏紧 / <40 紧张） =====

const LIQ_BANDS = [
  { min: 80, label: '流动性充裕', tip: '资金面宽裕，市场活跃度高', color: '#ef4444' },
  { min: 60, label: '中性偏好', tip: '流动性偏松，正常参与', color: '#f97316' },
  { min: 40, label: '中性偏紧', tip: '资金面收敛，注意控制节奏', color: '#94a3b8' },
  { min: 0, label: '流动性紧张', tip: '资金明显偏紧，防守为主', color: '#38bdf8' }
];

function liqBand(total) {
  if (total == null || isNaN(total)) return LIQ_BANDS[LIQ_BANDS.length - 1];
  for (let b of LIQ_BANDS) {
    if (total >= b.min) return b;
  }
  return LIQ_BANDS[LIQ_BANDS.length - 1];
}

/** 分数所在档位序号（0=最优），用于上色 */
function liqTierIdx(item, score) {
  for (let i = 0; i < item.tiers.length; i++) {
    let t = item.tiers[i];
    if (score >= t.lo && score <= t.hi) return i;
  }
  return score > item.tiers[0].hi ? 0 : item.tiers.length - 1;
}

const LIQ_TIER_COLORS = ['#ef4444', '#f97316', '#94a3b8', '#38bdf8'];

function liqClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function liqToday() {
  let d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function liqFmt(v) { return (Math.round(v * 2) / 2).toFixed(1); }

// ===== 页面渲染 =====

function disposeLiquidity() {
  if (liquidityChart) { liquidityChart.dispose(); liquidityChart = null; }
}

async function renderLiquidityBody(container) {
  liqEditingDate = liqToday();

  container.innerHTML = `
    <div class="liq-page">
      <div class="liq-toolbar">
        <div style="font-size:15px;font-weight:700;">流动性晴雨表（每周打分一次 · 满分100）</div>
        <span style="font-size:11px;color:var(--text-muted)">手动打分 · 本地保存</span>
      </div>
      <div class="liq-band-card" id="liq-band-card"></div>
      <div class="liq-form">
        <label class="liq-date-label">打分日期
          <input type="date" id="liq-date" class="liq-date-input" value="${liqEditingDate}">
        </label>
        <button class="btn btn-sm" id="btn-liq-save">保存本周打分</button>
        <span class="liq-msg" id="liq-msg"></span>
      </div>
      <div class="liq-items" id="liq-items"></div>
      <div class="liq-note">打分说明：先点击指标下方的档位按钮快速定位（自动取该档中值），再用滑块微调（0.5步长）。M1-M2剪刀差为月度公布，周度打分参考最近一个月的变化；成交额20日均值是最直接的市场资金活跃度指标；美债收益率是全球风险资产定价的锚。</div>
      <div class="liq-history-title">历史打分（近${LIQ_N}条）</div>
      <div class="liq-chart" id="liq-chart"></div>
      <div class="liq-list" id="liq-list"></div>
    </div>`;

  let itemsEl = document.getElementById('liq-items');
  itemsEl.innerHTML = LIQ_INDICATORS.map((item, idx) => `
    <div class="liq-item" data-idx="${idx}">
      <div class="liq-item-head">
        <span class="liq-item-name">${idx + 1}. ${escapeHtml(item.name)} <i>${LIQ_WEIGHTS[idx]}分</i></span>
        <span class="liq-item-score" id="liq-chip-${idx}">${liqFmt(liqScores[idx])}<i>/20</i></span>
      </div>
      <div class="liq-item-basis">${escapeHtml(item.basis)}</div>
      <input type="range" min="0" max="20" step="0.5" value="${liqScores[idx]}" class="liq-slider" id="liq-slider-${idx}" aria-label="${escapeHtml(item.name)}得分">
      <div class="liq-tier-row" id="liq-tiers-${idx}">
        ${item.tiers.map((t, ti) => `
          <button type="button" class="liq-tier-btn" data-idx="${idx}" data-tier="${ti}" data-lo="${t.lo}" data-hi="${t.hi}" title="${escapeHtml(t.sub)}">
            <b>${t.lo}-${t.hi}</b><span>${escapeHtml(t.label)}</span>
          </button>`).join('')}
      </div>
    </div>`).join('');

  // 事件：档位按钮 / 滑块 / 日期切换 / 保存
  itemsEl.querySelectorAll('.liq-tier-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      let idx = Number(btn.dataset.idx);
      let lo = Number(btn.dataset.lo), hi = Number(btn.dataset.hi);
      liqSetScore(idx, (lo + hi) / 2);
    });
  });
  for (let idx = 0; idx < LIQ_INDICATORS.length; idx++) {
    let slider = document.getElementById('liq-slider-' + idx);
    if (slider) slider.addEventListener('input', () => liqSetScore(idx, Number(slider.value)));
  }

  let dateInput = document.getElementById('liq-date');
  if (dateInput) dateInput.addEventListener('change', async () => {
    liqEditingDate = dateInput.value || liqToday();
    // 若该日期已有记录则载入编辑；否则保留当前分数仅切换日期
    let records = await getAllLiquidityRecords();
    let found = records.find(r => r.date === liqEditingDate);
    if (found && Array.isArray(found.items) && found.items.length === LIQ_INDICATORS.length) {
      liqScores = found.items.map(it => Number(it.score));
      liqSetMsg('已载入该日期记录，可修改后重新保存覆盖', 'success');
    } else {
      liqSetMsg('该日期暂无记录，调整分数后保存即可', '');
    }
    liqSyncUI();
    liqRecompute();
  });

  let saveBtn = document.getElementById('btn-liq-save');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      let ok = await liqSave();
      if (ok) liqSetMsg('已保存 ' + liqEditingDate + ' 的打分', 'success');
      else liqSetMsg('保存失败，请重试', 'error');
    } catch (e) {
      console.error('流动性打分保存失败:', e);
      liqSetMsg('保存异常: ' + (e.message || e), 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  liqSyncUI();
  liqRecompute();
  await liqRefreshHistory();
}

/** 设置某项分数并联动UI */
function liqSetScore(idx, val) {
  liqScores[idx] = liqClamp(Math.round(val * 2) / 2, 0, 20);
  let slider = document.getElementById('liq-slider-' + idx);
  if (slider) slider.value = liqScores[idx];
  liqSyncUI();
  liqRecompute();
}

/** 分数变化后刷新当前得分徽标 */
function liqSyncUI() {
  for (let idx = 0; idx < LIQ_INDICATORS.length; idx++) {
    let item = LIQ_INDICATORS[idx];
    let score = liqScores[idx];
    let tierIdx = liqTierIdx(item, score);
    let color = LIQ_TIER_COLORS[tierIdx];
    let chip = document.getElementById('liq-chip-' + idx);
    if (chip) { chip.style.color = color; chip.innerHTML = liqFmt(score) + '<i>/20</i>'; }
    let row = document.getElementById('liq-tiers-' + idx);
    if (row) {
      row.querySelectorAll('.liq-tier-btn').forEach((btn, ti) => {
        btn.classList.toggle('active', ti === tierIdx);
        btn.style.borderColor = ti === tierIdx ? color : '';
      });
    }
  }
}

/** 实时总分与档位卡 */
function liqRecompute() {
  let total = Math.round(liqScores.reduce((a, b) => a + b, 0) * 2) / 2;
  let band = liqBand(total);
  let card = document.getElementById('liq-band-card');
  if (!card) return;
  card.innerHTML = `
    <div class="liq-total" style="color:${band.color}">${liqFmt(total)}</div>
    <div class="liq-band-meta">
      <div class="liq-band-label" style="background:${band.color}">${band.label}</div>
      <div class="liq-band-tip">${band.tip}　（${liqEditingDate || '--'}）</div>
    </div>`;
  card.style.borderLeft = '6px solid ' + band.color;
}

/** 保存当前分数 */
async function liqSave() {
  let total = Math.round(liqScores.reduce((a, b) => a + b, 0) * 2) / 2;
  let band = liqBand(total);
  let record = {
    date: liqEditingDate,
    total: total,
    band: band.label,
    band_color: band.color,
    items: liqScores.map((score, idx) => ({
      key: LIQ_INDICATORS[idx].key,
      name: LIQ_INDICATORS[idx].name,
      score: score,
      tier: LIQ_INDICATORS[idx].tiers[liqTierIdx(LIQ_INDICATORS[idx], score)].label
    })),
    updated_at: new Date().toISOString()
  };
  let ok = await saveLiquidityRecord(record);
  if (ok) await liqRefreshHistory();
  return ok;
}

function liqSetMsg(text, type) {
  let el = document.getElementById('liq-msg');
  if (!el) return;
  el.textContent = text;
  el.className = 'liq-msg' + (type ? ' ' + type : '');
}

/** 刷新走势图 + 历史记录列表 */
async function liqRefreshHistory() {
  let chartEl = document.getElementById('liq-chart');
  let listEl = document.getElementById('liq-list');
  if (!chartEl && !listEl) return;

  let records = await getAllLiquidityRecords();
  records = records.slice(0, LIQ_N);
  let asc = records.slice().reverse();

  if (listEl) {
    if (records.length === 0) {
      listEl.innerHTML = '<div class="empty-state" style="padding:24px 12px">暂无历史打分记录，每周保存一次会自动积累</div>';
    } else {
      listEl.innerHTML = '<div class="liq-row-head"><span>日期</span><span>总分</span><span>档位</span><span></span></div>' +
        records.map((r, ri) => `
          <div class="liq-row">
            <span class="liq-row-date">${escapeHtml(r.date)}</span>
            <span class="liq-row-total" style="color:${r.band_color || liqBand(r.total).color}">${Number(r.total).toFixed(1)}</span>
            <span class="liq-row-band" style="color:${r.band_color || liqBand(r.total).color}">${escapeHtml(r.band || liqBand(r.total).label)}</span>
            <button type="button" class="btn btn-xs liq-load-btn" data-ri="${ri}">载入</button>
          </div>`).join('') + '<div class="liq-row-note">点击「载入」可回看/修改该周打分</div>';
      listEl.querySelectorAll('.liq-load-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          let rec = asc[Number(btn.dataset.ri)];
          if (!rec || !Array.isArray(rec.items)) return;
          liqEditingDate = rec.date;
          let dateInput = document.getElementById('liq-date');
          if (dateInput) dateInput.value = rec.date;
          liqScores = LIQ_INDICATORS.map((item, i) => {
            let it = rec.items.find(x => x.key === item.key);
            return it ? Number(it.score) : 10;
          });
          liqSyncUI();
          liqRecompute();
          liqSetMsg('已载入 ' + rec.date + '，可修改后重新保存', 'success');
          let top = document.querySelector('.liq-page');
          if (top) top.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });
    }
  }

  // 走势图
  if (chartEl) {
    if (asc.length < 1) {
      chartEl.innerHTML = '<div class="empty-state" style="padding:24px 12px">暂无历史，保存打分后自动生成走势</div>';
      return;
    }
    try {
      if (typeof echarts === 'undefined') { await loadECharts(); }
      chartEl.innerHTML = '';
      let isLight = document.documentElement.getAttribute('data-theme') === 'light';
      let textColor = isLight ? '#333' : '#e0e0e0';
      let dates = asc.map(r => r.date);
      let totals = asc.map(r => r.total);

      if (liquidityChart) { liquidityChart.dispose(); liquidityChart = null; }

      let markBands = [];
      [80, 60, 40].forEach(v => {
        markBands.push({ yAxis: v, lineStyle: { color: '#94a3b8', type: 'dashed', width: 1 }, label: { formatter: v + '分', fontSize: 9, color: textColor } });
      });

      liquidityChart = echarts.init(chartEl);
      liquidityChart.setOption({
        backgroundColor: 'transparent',
        animation: false,
        tooltip: { trigger: 'axis' },
        grid: { left: 40, right: 12, top: 18, bottom: 24 },
        xAxis: { type: 'category', data: dates, axisLabel: { color: textColor, fontSize: 9 }, axisLine: { lineStyle: { color: '#2a2a2a' } } },
        yAxis: { type: 'value', min: 0, max: 100, interval: 20, axisLabel: { color: textColor, fontSize: 9 } },
        series: [{
          type: 'line', data: totals, smooth: false, symbol: 'circle', symbolSize: 5,
          lineStyle: { color: '#38bdf8', width: 2 },
          itemStyle: { color: function(p) { return liqBand(p.value).color; } },
          markLine: { symbol: 'none', data: markBands, label: { show: true, fontSize: 9 } },
          areaStyle: { color: 'rgba(56,189,248,0.10)' }
        }]
      });
    } catch (e) {
      console.error('流动性走势渲染失败:', e);
      chartEl.innerHTML = '<div class="empty-state">走势加载失败: ' + escapeHtml(e.message) + '</div>';
    }
  }
}
