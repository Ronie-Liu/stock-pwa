// ===== 个股标签体系（母线-一级簇-二级簇-二级簇属性） =====
// 数据真源: data/tag_system.json（完整体系，含概念板块/三级行业板块/个股，供后续功能使用）
// 前端查表: data/stock_tags.js（懒加载精简表：字典+下标，约 260KB）
// 生成脚本: python scripts/build_stock_tags.py
// 展示口径: 每条标签一行，文本为「母线名-一级簇名-二级簇名-二级簇属性」

const STOCK_TAGS_URL = '/data/stock_tags.js';
const STOCK_TAGS_VER = '20260919b';      // 与 index.html 中脚本版本保持一致
const STOCK_TAG_ATTR_COLOR = {
  '核心锚': '#ef4444',
  '中军': '#f59e0b',
  '弹性': '#3b82f6',
  '跟风': '#8b93a1',
  '边缘': '#6b7280'
};
const STOCK_TAG_CARD_LIMIT = 0;          // 0 = 卡片内也全部展示；设为 N 则只展示前 N 条

let stockTagsLoading = null;

function stockTagsReady() {
  return !!(window.STOCK_TAGS && Array.isArray(window.TAG_DICT));
}

/** 懒加载标签查表；返回 Promise<bool> */
function loadStockTags() {
  if (stockTagsReady()) return Promise.resolve(true);
  if (stockTagsLoading) return stockTagsLoading;
  stockTagsLoading = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = STOCK_TAGS_URL + '?v=' + STOCK_TAGS_VER;
    s.async = true;
    s.onload = () => resolve(stockTagsReady());
    s.onerror = () => { stockTagsLoading = null; resolve(false); };
    document.head.appendChild(s);
  });
  return stockTagsLoading;
}

/** 6位数字代码 */
function stockTagKey(code) {
  return (code || '').replace(/[^0-9]/g, '').padStart(6, '0');
}

/**
 * 取个股标签数组（保持体系内原始顺序：按母线分组）
 * @returns {Array<{母线,一级簇,二级簇,二级簇属性}>|null} null = 查表未加载
 */
function getStockTags(code) {
  if (!stockTagsReady()) return null;
  const arr = window.STOCK_TAGS[stockTagKey(code)];
  if (!arr || !arr.length) return [];
  const dict = window.TAG_DICT, attrs = window.TAG_ATTR || [];
  return arr.map(function (p) {
    const parts = String(dict[p[0]] || '').split('|');
    return {
      '母线': parts[0] || '',
      '一级簇': parts[1] || '',
      '二级簇': parts[2] || '',
      '二级簇属性': attrs[p[1]] || ''
    };
  });
}

/** 单条标签文本：母线名-一级簇名-二级簇名-二级簇属性 */
function stockTagText(t) {
  return [t['母线'], t['一级簇'], t['二级簇'], t['二级簇属性']].filter(function (x) { return x; }).join('-');
}

function stockTagLineHtml(t) {
  const attr = t['二级簇属性'] || '';
  const color = STOCK_TAG_ATTR_COLOR[attr] || 'var(--text-secondary)';
  const head = [t['母线'], t['一级簇'], t['二级簇']].filter(function (x) { return x; }).join('-');
  return '<div class="stock-tag-line" title="' + escapeHtml(stockTagText(t)) + '">' +
    '<span class="stock-tag-path">' + escapeHtml(head) + '</span>' +
    (attr ? '<span class="stock-tag-sep">-</span><span class="stock-tag-attr" style="color:' + color + ';">' + escapeHtml(attr) + '</span>' : '') +
    '</div>';
}

/**
 * 标签块内部 HTML。查表未就绪时返回 null（由 hydrateStockTags 处理）
 * @param {string} code
 * @param {'card'|'detail'} mode
 */
function stockTagsInnerHtml(code, mode) {
  const tags = getStockTags(code);
  if (tags === null) return null;
  if (!tags.length) {
    return mode === 'detail' ? '<div class="stock-tag-empty">暂无标签</div>' : '';
  }
  let list = tags;
  let more = 0;
  if (mode === 'card' && STOCK_TAG_CARD_LIMIT > 0 && tags.length > STOCK_TAG_CARD_LIMIT) {
    list = tags.slice(0, STOCK_TAG_CARD_LIMIT);
    more = tags.length - STOCK_TAG_CARD_LIMIT;
  }
  let html = list.map(stockTagLineHtml).join('');
  if (more > 0) html += '<div class="stock-tag-more">…还有 ' + more + ' 条</div>';
  return html;
}

/**
 * 生成标签容器（占位）。真正内容由 hydrateStockTags 回填，保证列表先出来、标签随后补齐。
 * @param {string} code 股票代码
 * @param {'card'|'detail'} mode
 */
function renderStockTags(code, mode) {
  const m = mode || 'card';
  const inner = stockTagsInnerHtml(code, m);
  if (inner !== null && !inner) return '';        // 卡片：无标签直接不占位
  return '<div class="stock-tags stock-tags--' + m + '" data-tag-code="' + escapeHtml(stockTagKey(code)) +
    '" data-tag-mode="' + m + '">' +
    (inner !== null ? inner : '<div class="stock-tag-loading">标签加载中…</div>') +
    '</div>';
}

/** 回填容器内所有标签占位（可重复调用，已回填的会跳过） */
async function hydrateStockTags(root) {
  if (!root) return;
  const nodes = root.querySelectorAll('[data-tag-code]');
  if (!nodes.length) return;
  const pending = Array.prototype.filter.call(nodes, function (n) { return n.dataset.tagFilled !== '1'; });
  if (!pending.length) return;

  const ok = stockTagsReady() || await loadStockTags();
  pending.forEach(function (n) {
    const code = n.dataset.tagCode;
    const mode = n.dataset.tagMode || 'card';
    if (!ok) {
      n.innerHTML = '<div class="stock-tag-empty">标签数据加载失败</div>';
      return;
    }
    const html = stockTagsInnerHtml(code, mode);
    if (!html) { n.remove(); return; }            // 无标签：整块移除
    n.innerHTML = html;
    n.dataset.tagFilled = '1';
  });
}

/** 应用启动后后台预热标签表，避免首次展开卡片时才下载 */
function preloadStockTags() {
  if (stockTagsReady()) return;
  if (typeof requestIdleCallback === 'function') requestIdleCallback(function () { loadStockTags(); }, { timeout: 4000 });
  else setTimeout(function () { loadStockTags(); }, 1200);
}
