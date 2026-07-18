/**
 * 老三板云端采集脚本（Node.js）
 * 部署到腾讯云函数 SCF，cron: 0 40 15 * * 1-5 (15:40 周一至周五)
 * 
 * 流程:
 *   1. qt.gtimg.cn 拉取 248 只老三板实时行情
 *   2. 东方财富 API 拉取 A/B 股流通股本 + 总股本
 *   3. 将数据写入 GitHub Pages 仓库 data/third_board_json/YYYY-MM-DD.json
 * 
 * 环境变量:
 *   GITHUB_TOKEN - GitHub Personal Access Token (repo 权限)
 */

const https = require('https');
const http = require('http');
const zlib = require('zlib');
const iconv = require('iconv-lite');  // npm install iconv-lite

// ===== 配置 =====
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_OWNER = 'Ronie-Liu';
const GITHUB_REPO = 'stock-pwa';
const GITHUB_BRANCH = 'main';

const TB_STOCK_LIST = [
  "400002","400005","400008","400010","400012","400016","400018","400021","400022","400023",
  "400025","400027","400028","400029","400030","400031","400033","400035","400036","400039",
  "400040","400041","400045","400046","400050","400051","400053","400055","400057","400059",
  "400065","400066","400067","400068","400069","400070","400071","400072","400073","400078",
  "400080","400081","400082","400083","400084","400088","400089","400093","400094","400095",
  "400096","400097","400098","400099","400100","400101","400102","400104","400107","400108",
  "400110","400113","400114","400116","400117","400118","400119","400120","400121","400122",
  "400123","400124","400125","400126","400127","400128","400129","400130","400131","400132",
  "400133","400134","400135","400136","400137","400138","400139","400140","400141","400142",
  "400143","400144","400145","400146","400147","400148","400149","400150","400151","400152",
  "400153","400154","400155","400156","400157","400159","400160","400161","400162","400163",
  "400164","400165","400166","400167","400168","400169","400170","400171","400172","400173",
  "400174","400175","400176","400177","400179","400180","400181","400182","400183","400184",
  "400185","400186","400188","400189","400190","400191","400192","400193","400194","400195",
  "400196","400197","400198","400199","400200","400201","400202","400203","400204","400205",
  "400206","400207","400208","400209","400210","400211","400212","400213","400214","400215",
  "400216","400217","400218","400219","400220","400221","400222","400224","400225","400226",
  "400227","400228","400229","400230","400231","400232","400233","400234","400235","400236",
  "400237","400238","400239","400240","400241","400242","400243","400245","400246","400247",
  "400248","400249","400250","400251","400252","400253","400254","400255","400256","400257",
  "400258","400259","400260","400261","400262","400263","400264","400265","400267","400268",
  "400269","400270","400271","400272","400274","400275","400276","400277","400278","400279",
  "400280","400281","400282","400283","400284","400285","400286","400287","400288","400289",
  "400290","400291","420008","420016","420063","420073","420085","420103","420108","420120",
  "420140","420153","420178","420223","420244","420254","420273","420280",
];

// ===== HTTP 工具 =====

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Encoding': 'gzip, deflate',
        ...(options.headers || {})
      },
      timeout: options.timeout || 15000
    };
    const req = mod.request(reqOptions, (res) => {
      let chunks = [];
      let stream = res;
      const encoding = res.headers['content-encoding'];
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (options.raw) resolve(buf);
        else resolve(buf.toString('utf-8'));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ===== 腾讯行情采集 =====

async function fetchQuotesBatch(codes) {
  const cs = codes.map(c => 'nq' + c).join(',');
  const buf = await httpGet('https://qt.gtimg.cn/q=' + cs, {
    headers: { 'Referer': 'https://gu.qq.com/' },
    raw: true
  });
  const text = iconv.decode(buf, 'gbk');
  const result = {};
  const lines = text.trim().split('\n');
  for (const line of lines) {
    const m = line.match(/nq(\d{6})/);
    if (!m) continue;
    const code = m[1];
    const idx = line.indexOf('"');
    const idx2 = line.lastIndexOf('"');
    if (idx < 0 || idx2 <= idx) continue;
    const parts = line.substring(idx + 1, idx2);
    const f = parts.split('~');
    if (f.length < 38) continue;

    const name = (f[1] || '').trim();
    const close = parseFloat(f[3]) || 0;
    const prevClose = parseFloat(f[4]) || 0;
    const open = parseFloat(f[5]) || 0;
    const volume = parseInt(f[6]) || 0;
    const high = parseFloat(f[33]) || close || 0;
    const low = parseFloat(f[34]) || close || 0;
    const amount = volume ? +(volume * 100 * close).toFixed(2) : 0;
    let buyVol = 0, sellVol = 0;
    for (let v = 0; v < 5; v++) { buyVol += (parseInt(f[10 + v*2]) || 0); }
    for (let v = 0; v < 5; v++) { sellVol += (parseInt(f[20 + v*2]) || 0); }
    const changePct = prevClose > 0 ? +((close - prevClose) / prevClose * 100).toFixed(2) : 0;

    let tradeDate = f[30] && f[30].length >= 8
      ? f[30].slice(0,4) + '-' + f[30].slice(4,6) + '-' + f[30].slice(6,8)
      : '';

    result[code] = { code, name, open, high, low, close, volume, amount,
      change_pct: changePct, buy_vol: buyVol, sell_vol: sellVol,
      mktcap_float: 0, mktcap_total: 0, _tradeDate: tradeDate };
  }
  return result;
}

// ===== 东方财富股本 =====

async function fetchShares(code) {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get' +
    '?reportName=RPT_F10_FINANCE_MAINFINADATA' +
    '&columns=SECURITY_CODE,A_FREE_SHARE,B_FREE_SHARE,TOTAL_SHARE' +
    '&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1' +
    '&filter=(SECURITY_CODE=%22' + code + '%22)';
  try {
    const text = await httpGet(url, { timeout: 10000 });
    const data = JSON.parse(text);
    const items = data && data.result && data.result.data;
    if (items && items[0]) {
      const aFree = parseFloat(items[0].A_FREE_SHARE) || 0;
      const bFree = parseFloat(items[0].B_FREE_SHARE) || 0;
      const total = parseFloat(items[0].TOTAL_SHARE) || 0;
      return { free_shares: Math.round(aFree + bFree), total_shares: Math.round(total) };
    }
  } catch(e) {}
  return null;
}

// ===== GitHub API =====

function githubApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const reqOptions = {
      hostname: 'api.github.com',
      path: path,
      method: method,
      headers: {
        'Authorization': 'token ' + GITHUB_TOKEN,
        'User-Agent': 'stock-pwa-cloud-collector',
        'Accept': 'application/vnd.github.v3+json',
        ...(bodyStr ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      },
      timeout: 30000
    };
    const req = https.request(reqOptions, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(text));
        } else {
          reject(new Error(`GitHub API ${res.statusCode}: ${text.substring(0, 200)}`));
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('GitHub API timeout')); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function uploadJsonFile(filePath, content, commitMsg) {
  const base64Content = Buffer.from(content, 'utf-8').toString('base64');
  const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;

  // 先检查文件是否存在（获取 SHA）
  let existingSha = null;
  try {
    const existing = await githubApi('GET', apiPath + '?ref=' + GITHUB_BRANCH);
    existingSha = existing.sha;
    console.log('  文件已存在，更新...');
  } catch(e) {
    console.log('  新文件，创建...');
  }

  const body = {
    message: commitMsg,
    content: base64Content,
    branch: GITHUB_BRANCH
  };
  if (existingSha) body.sha = existingSha;

  return await githubApi('PUT', apiPath, body);
}

// ===== 主流程 =====

async function main() {
  const startTime = Date.now();

  if (!GITHUB_TOKEN) {
    console.error('错误: 环境变量 GITHUB_TOKEN 未设置');
    process.exit(1);
  }

  // 1) 先采集前 10 只确定交易日期
  console.log('[1/4] 采集行情...');
  let all = await fetchQuotesBatch(TB_STOCK_LIST.slice(0, 10));
  let tradeDate = '';
  for (const k in all) {
    if (all[k]._tradeDate) { tradeDate = all[k]._tradeDate; break; }
  }
  if (!tradeDate) {
    const now = new Date();
    tradeDate = now.toISOString().slice(0, 10);
  }
  console.log('  交易日期:', tradeDate);

  // 2) 采集剩余行情
  for (let i = 10; i < TB_STOCK_LIST.length; i += 50) {
    const batch = TB_STOCK_LIST.slice(i, i + 50);
    const result = await fetchQuotesBatch(batch);
    Object.assign(all, result);
    console.log('  行情进度:', Object.keys(all).length, '/', TB_STOCK_LIST.length);
    if (i + 50 < TB_STOCK_LIST.length) await sleep(400);
  }

  // 3) 组装有效行
  const rows = [];
  for (const code of TB_STOCK_LIST) {
    const r = all[code];
    if (!r || (r.open === 0 && r.high === 0 && r.low === 0)) continue;
    rows.push(r);
  }
  rows.sort((a, b) => a.code.localeCompare(b.code));
  console.log('  有效股票:', rows.length, '只（未交易:', TB_STOCK_LIST.length - rows.length, '只）');

  // 4) 拉取股本 + 计算市值
  console.log('[2/4] 拉取股本...');
  let sharesDone = 0;
  for (const r of rows) {
    const shares = await fetchShares(r.code);
    if (shares && shares.free_shares > 0) {
      r.mktcap_float = +(r.close * shares.free_shares).toFixed(2);
    }
    if (shares && shares.total_shares > 0) {
      r.mktcap_total = +(r.close * shares.total_shares).toFixed(2);
    }
    sharesDone++;
    if (sharesDone % 50 === 0) console.log('  股本进度:', sharesDone, '/', rows.length);
    await sleep(150);
  }
  console.log('  股本完成:', sharesDone, '/', rows.length);

  // 5) 生成 JSON
  console.log('[3/4] 生成 JSON...');
  const cleanRows = rows.map(r => ({
    code: r.code,
    name: r.name,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    amount: r.amount,
    change_pct: r.change_pct,
    buy_vol: r.buy_vol,
    sell_vol: r.sell_vol,
    mktcap_float: r.mktcap_float,
    mktcap_total: r.mktcap_total
  }));
  const jsonContent = JSON.stringify({ date: tradeDate, count: rows.length, data: cleanRows }, null, 2);

  // 6) 上传到 GitHub Pages
  console.log('[4/4] 上传到 GitHub...');
  const fileDate = tradeDate.replace(/-/g, '');
  const filePath = `data/third_board_json/${tradeDate}.json`;
  await uploadJsonFile(filePath, jsonContent, `老三板 ${tradeDate} 自动采集 (${rows.length}只)`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`完成! ${rows.length} 只, 日期: ${tradeDate}, 耗时: ${elapsed}s`);
  return { success: true, date: tradeDate, count: rows.length, elapsed };
}

main().then(r => {
  console.log('Done:', JSON.stringify(r));
  process.exit(0);
}).catch(e => {
  console.error('Failed:', e.message);
  process.exit(1);
});
