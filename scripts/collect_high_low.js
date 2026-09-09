// ===== 采集 legulegu 全部A股 创新高/新低 个股数量历史数据 =====
// 用法: node scripts/collect_high_low.js
// 数据源: https://legulegu.com/stockdata/charts/985 (全部A股 创新高:High60 vs 中证红利)
//   预览接口 /api/get-aggregation-data/preview (POST) 返回近21年(5200个交易日)历史
//   免费可用的键: high_low_all_High60 / Low60 / High120 / Low120 (High20/Low20 需VIP)
// 输出: data/high_low_history.json (供 PWA 前端加载)
// 注意: 该接口同源直连、无CORS头，仅能在服务端/本地脚本调用，浏览器PWA无法跨域直连。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://legulegu.com';
const PAGE_URL = BASE + '/stockdata/charts/985';
const KEYS = ['high_low_all_High60', 'high_low_all_Low60', 'high_low_all_High120', 'high_low_all_Low120'];
const FIELD_MAP = {
  high_low_all_High60: 'high60',
  high_low_all_Low60: 'low60',
  high_low_all_High120: 'high120',
  high_low_all_Low120: 'low120'
};
const LABEL_MAP = {
  high60: '创60日新高',
  low60: '创60日新低',
  high120: '创120日新高',
  low120: '创120日新低'
};

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

// 上海时区的今日日期字符串 YYYY-MM-DD
function shDateStr(d) {
  const dt = new Date(d.getTime() + 8 * 3600 * 1000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

async function getSession() {
  // 首次访问图表页，拿到 acw_tc / JSESSIONID / LAAA 等cookie 与 _csrf
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(PAGE_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept': 'text/html' } });
    const html = await r.text();
    const setCookie = r.headers.get('set-cookie') || '';
    const jar = {};
    for (const part of setCookie.split(',')) {
      const m = part.match(/^\s*([^=;]+)=([^;]*)/);
      if (m) jar[m[1].trim()] = m[2];
    }
    const csrfM = html.match(/name=["']_csrf["']\s+content=["']([^"']+)["']/i);
    if (csrfM && csrfM[1]) {
      return {
        cookie: Object.entries(jar).map(([k, v]) => k + '=' + v).join('; '),
        csrf: csrfM[1]
      };
    }
    // 可能遇到WAF挑战，稍等重试
    await new Promise(res => setTimeout(res, 1500));
  }
  throw new Error('无法获取会话(可能被WAF拦截)，请稍后在浏览器打开 legulegu.com 后重试');
}

async function fetchKey(session, key) {
  const body = {
    requestedDataKeys: [key],
    types: ['line'],
    requestedDataColors: ['#1f97c4'],
    splitLines: [false],
    inverses: [false],
    gridIndices: [0],
    markLinesOfQuantile: [0]
  };
  // token = MD5(今日日期)，尝试今天与昨天
  const now = new Date();
  const tokens = [shDateStr(now), shDateStr(new Date(now.getTime() - 86400e3))];
  let lastErr = null;
  for (const d of tokens) {
    const url = BASE + '/api/get-aggregation-data/preview?token=' + md5(d);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-CSRF-Token': session.csrf,
          'Cookie': session.cookie,
          'Referer': PAGE_URL,
          'Origin': BASE
        },
        body: JSON.stringify(body)
      });
      const txt = await r.text();
      let j;
      try { j = JSON.parse(txt); } catch (e) { throw new Error('返回非JSON: ' + txt.slice(0, 80)); }
      if (j.restrict === true) throw new Error('该键需VIP权限');
      if (!j.xAxis || !j.series || !j.series[0]) throw new Error('无数据');
      return { dates: j.xAxis, values: j.series[0] };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('请求失败');
}

async function main() {
  const session = await getSession();
  const result = {
    generated_at: new Date().toISOString(),
    source: 'legulegu.com 全部A股 创新高/新低个股数量（剔除停牌股）',
    source_url: PAGE_URL,
    unit: '家',
    dates: null,
    series: {}
  };

  let sharedDates = null;
  for (const key of KEYS) {
    const { dates, values } = await fetchKey(session, key);
    const field = FIELD_MAP[key];
    if (sharedDates === null) {
      sharedDates = dates;
    } else if (JSON.stringify(sharedDates) !== JSON.stringify(dates)) {
      console.warn('日期轴不一致:', key, 'len', dates.length, 'vs', sharedDates.length);
    }
    result.series[field] = {
      key: key,
      label: LABEL_MAP[field],
      values: values
    };
    console.log(field, '=>', values.length, '条,', dates[0], '~', dates[dates.length - 1], '最新值', values[values.length - 1]);
  }
  result.dates = sharedDates;
  result.last_date = sharedDates[sharedDates.length - 1];

  const outDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'high_low_history.json');
  fs.writeFileSync(outFile, JSON.stringify(result), 'utf8');
  console.log('已写入', outFile, (fs.statSync(outFile).size / 1024).toFixed(1) + 'KB');
}

main().catch(e => { console.error('采集失败:', e.message); process.exit(1); });
