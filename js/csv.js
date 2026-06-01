// ===== CSV 导入模块 =====

let parsedCSVData = [];
let csvFileName = '';

/**
 * 解析CSV文本
 * 支持: 带BOM的UTF-8、字段内逗号（双引号括起）
 */
function parseCSV(text) {
  // 移除BOM
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
  }

  let lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    throw new Error('CSV文件至少需要包含表头和一行数据');
  }

  // 解析CSV行（处理引号内逗号）
  function parseLine(line) {
    let result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      let ch = line[i];
      if (ch === '"') {
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  let headers = parseLine(lines[0]);
  let rows = lines.slice(1).map(parseLine);
  let data = rows.map(row => {
    let obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });

  return { headers, data };
}

/**
 * 验证并规范化CSV数据
 */
function validateCSVData(rawData) {
  let validStocks = [];
  let skipped = [];

  for (let i = 0; i < rawData.length; i++) {
    let row = rawData[i];
    let code = (row.code || row.Code || row.CODE || row['代码'] || row['股票代码'] || '').trim();
    let name = (row.name || row.Name || row.NAME || row['名称'] || row['股票名称'] || '').trim();

    if (!code) {
      skipped.push({ row: i + 2, reason: '缺少股票代码' });
      continue;
    }
    if (!name) {
      skipped.push({ row: i + 2, reason: '缺少股票名称' });
      continue;
    }

    try {
      let normalizedCode = normalizeCode(code);
      let stock = {
        code: normalizedCode,
        name: name,
        buy_price: parseFloat(row.buy_price || row['买入价格'] || 0) || null,
        buy_time: (row.buy_time || row['买入时间'] || '').trim() || null,
        personal_note: (row.personal_note || row['个人评价'] || row['备注'] || '').trim() || null,
        stock_type: 'watchlist'
      };
      validStocks.push(stock);
    } catch (e) {
      skipped.push({ row: i + 2, reason: '代码解析失败: ' + code });
    }
  }

  return { validStocks, skipped };
}

/**
 * CSV预览渲染
 */
function renderCSVPreview(validStocks, skipped) {
  let tableHtml = '<table><thead><tr><th>#</th><th>代码</th><th>名称</th><th>买入价</th><th>买入时间</th><th>备注</th></tr></thead><tbody>';

  let previewCount = Math.min(validStocks.length, 10);
  for (let i = 0; i < previewCount; i++) {
    let s = validStocks[i];
    tableHtml += `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(extractDigits(s.code))}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${s.buy_price || '-'}</td>
      <td>${escapeHtml(s.buy_time || '-')}</td>
      <td>${escapeHtml((s.personal_note || '').slice(0, 15))}</td>
    </tr>`;
  }

  if (validStocks.length > 10) {
    tableHtml += `<tr><td colspan="6" style="text-align:center;color:var(--text-muted)">...共 ${validStocks.length} 条，仅显示前10条</td></tr>`;
  }

  tableHtml += '</tbody></table>';

  let statsHtml = `<div style="margin-top:10px">
    ✅ 解析成功: <strong>${validStocks.length}</strong> 条
    ${skipped.length > 0 ? ` ⚠️ 跳过: <strong>${skipped.length}</strong> 条` : ''}
  </div>`;

  if (skipped.length > 0) {
    statsHtml += '<div style="margin-top:4px; color:var(--danger); font-size:11px;">';
    skipped.forEach(s => {
      statsHtml += `第${s.row}行: ${escapeHtml(s.reason)}<br>`;
    });
    statsHtml += '</div>';
  }

  document.getElementById('csv-preview-table').innerHTML = tableHtml;
  document.getElementById('csv-import-stats').innerHTML = statsHtml;
  document.getElementById('csv-preview-area').style.display = 'block';
}

/**
 * 注册CSV页面事件
 */
function setupCSVEvents() {
  let fileInput = document.getElementById('csv-file-input');
  let selectBtn = document.getElementById('btn-select-csv');

  if (selectBtn && fileInput) {
    selectBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      let file = e.target.files[0];
      if (!file) return;

      csvFileName = file.name;
      let reader = new FileReader();
      reader.onload = (ev) => {
        try {
          let result = parseCSV(ev.target.result);
          let { validStocks, skipped } = validateCSVData(result.data);
          parsedCSVData = validStocks;
          renderCSVPreview(validStocks, skipped);
        } catch (err) {
          showToast('CSV解析失败: ' + err.message, 'error');
        }
      };
      reader.readAsText(file, 'UTF-8');
    });
  }

  let importBtn = document.getElementById('btn-import-csv');
  if (importBtn) {
    importBtn.addEventListener('click', async () => {
      if (parsedCSVData.length === 0) {
        showToast('没有可导入的数据', 'error');
        return;
      }

      // 清空现有自选股
      await clearStocksByType('watchlist');

      // 批量导入
      let imported = 0;
      for (let stock of parsedCSVData) {
        try {
          await addStock(stock);
          imported++;
        } catch (e) {
          console.error('导入失败:', stock.code, e);
        }
      }

      showToast(`成功导入 ${imported} 只自选股`);
      parsedCSVData = [];
      document.getElementById('csv-preview-area').style.display = 'none';

      // 刷新页面
      if (typeof refreshCurrentPage === 'function') {
        refreshCurrentPage();
      }
      if (typeof switchTab === 'function') {
        switchTab('watchlist');
      }
    });
  }
}
