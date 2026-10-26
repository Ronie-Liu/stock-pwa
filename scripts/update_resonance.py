#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
共振数据采集：沪深京全市场「欲望 / 影线」分组家数，8 个盘中时点
=============================================================
输出 data/resonance_history.json + data/resonance_data.js（随仓库发布，前端直读）

数据源（全部支持北交所，无需东财）：
  股票池 + 盘中快照 : 新浪 Market_Center.getHQNodeData(node=hs_a)，分页一次拉全市场（约 56 请求）
  收盘复盘 5 分钟线 : 新浪 CN_MarketDataService.getKLineData(scale=5)，逐股 1 请求，失败回退腾讯 m5

两种模式（脚本按北京时间自动选择，也可用 --mode 强制）：
  snap      盘中快照。以「当前价」作为收盘价、以「当日至今最高/最低」作为影线基准，
            写入距离当前时间最近的一个计划时点。轻量（约 56 请求），用于盘中实时出点。
  backfill  收盘复盘。逐股拉 5 分钟 K 线（datalen=400，约 8 个交易日），
            按 5 分钟 bar 精确对齐 8 个时点，重算当日全部时点并覆盖 snap 结果。
            权威口径，可修复 cron 延迟 / 漏跑 / 数据漂移。

统计口径（全部以「昨收」为基准）：
  1 追高欲望（高开高走）：开盘涨幅 >= +2% 且 现价涨幅 >= +5%
  2 抄底欲望（低开高走）：开盘涨幅 <= -2% 且 现价涨幅 >= +3%
  3 离场欲望（高开低走）：开盘涨幅 >= +2% 且 现价涨幅 <= -3%
  4 恐慌欲望（低开低走）：开盘涨幅 <= -2% 且 现价涨幅 <= -5%
  5 上方阻力强（长上影）：(区间最高 - max(开盘, 现价)) / 昨收 >= 4%
  6 下方支撑强（长下影）：(min(开盘, 现价) - 区间最低) / 昨收 >= 4%

  第1组 做多 = c1 + c2    第2组 做空 = c3 + c4
  第3组 上方阻力强 = c5   第4组 下方支撑强 = c6

用法:
  python scripts/update_resonance.py                     # 自动判断模式
  python scripts/update_resonance.py --mode backfill
  python scripts/update_resonance.py --mode snap --limit 300    # 调试（默认不写文件）
"""
import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
DATA_JSON = os.path.join(ROOT, 'data', 'resonance_history.json')
DATA_JS = os.path.join(ROOT, 'data', 'resonance_data.js')
IDX_HTML = os.path.join(ROOT, 'index.html')

TZ = datetime.timezone(datetime.timedelta(hours=8))
SLOTS = ['10:00', '10:30', '11:00', '11:30', '13:30', '14:00', '14:30', '15:00']
SLOT_SET = set(SLOTS)
KEEP_DAYS = 5
SHADOW_PCT = 4.0          # 影线阈值（百分点，相对昨收）

SINA_LIST = ('https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/'
             'Market_Center.getHQNodeData')
SINA_K5 = ('https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData')
TX_K5_REAL = 'https://ifzq.gtimg.cn/appstock/app/kline/mkline'

UA = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept': '*/*'}
SINA_REF = dict(UA, Referer='https://finance.sina.com.cn/')


# ---------- 基础 ----------

def now_bj():
    return datetime.datetime.now(TZ)


def http_get(url, timeout=20, retries=3, headers=None):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers or UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode('utf-8', 'ignore')
        except Exception as e:
            last = e
            time.sleep(0.5 * (i + 1))
    raise last


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def load_store():
    if os.path.exists(DATA_JSON):
        try:
            with open(DATA_JSON, encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print('历史文件读取失败，将重建:', e)
    return {'generated_at': None, 'slots': SLOTS, 'days': []}


def find_day(store, date):
    for d in store['days']:
        if d['date'] == date:
            return d
    d = {'date': date, 'slots': {}}
    store['days'].append(d)
    return d


def prune(store):
    store['days'] = sorted(store['days'], key=lambda d: d['date'])[-KEEP_DAYS:]
    return store


# ---------- 股票池（新浪 hs_a，含北交所） ----------

def fetch_universe(limit=0):
    """分页拉全市场。返回 [{symbol, code, name, price, prev, open, high, low, vol}]
    symbol 已带 sh/sz/bj 前缀，可直接用于 K 线接口。"""
    out = []
    page = 1
    while True:
        url = '%s?page=%d&num=100&sort=symbol&asc=1&node=hs_a' % (SINA_LIST, page)
        try:
            arr = json.loads(http_get(url, timeout=25, retries=3, headers=SINA_REF))
        except Exception as e:
            print('  列表页 %d 拉取失败: %s' % (page, e))
            if out:
                break                    # 已有部分数据，尽力继续
            raise
        if not arr:
            break
        for r in arr:
            sym = str(r.get('symbol') or '')
            if len(sym) < 8:
                continue
            out.append({
                'symbol': sym,
                'code': str(r.get('code') or sym[-6:]),
                'name': r.get('name') or '',
                'price': fnum(r.get('trade')),
                'prev': fnum(r.get('settlement')),
                'open': fnum(r.get('open')),
                'high': fnum(r.get('high')),
                'low': fnum(r.get('low')),
                'vol': fnum(r.get('volume')),
            })
        if limit and len(out) >= limit:
            out = out[:limit]
            break
        if len(arr) < 100:
            break
        page += 1
        time.sleep(0.05)
    print('全市场股票池: %d 只（%d 页）' % (len(out), page))
    return out


# ---------- 六条条件 ----------

def classify(open_p, price, high, low, prev_close):
    """返回 (c1..c6) 元组；任一价格无效时返回 None"""
    if not prev_close or prev_close <= 0 or open_p <= 0 or price <= 0:
        return None
    po = (open_p / prev_close - 1.0) * 100.0           # 开盘涨幅(%)
    pc = (price / prev_close - 1.0) * 100.0            # 现价涨幅(%)
    body_top = max(open_p, price)
    body_bottom = min(open_p, price)
    upper = max(0.0, (high - body_top) / prev_close * 100.0) if high > 0 else 0.0
    lower = max(0.0, (body_bottom - low) / prev_close * 100.0) if low > 0 else 0.0
    return (
        1 if (po >= 2.0 and pc >= 5.0) else 0,    # 1 追高欲望
        1 if (po <= -2.0 and pc >= 3.0) else 0,   # 2 抄底欲望
        1 if (po >= 2.0 and pc <= -3.0) else 0,   # 3 离场欲望
        1 if (po <= -2.0 and pc <= -5.0) else 0,  # 4 恐慌欲望
        1 if upper >= SHADOW_PCT else 0,          # 5 上方阻力强
        1 if lower >= SHADOW_PCT else 0,          # 6 下方支撑强
    )


def slot_record(counts, total, src, actual, drift=0):
    c1, c2, c3, c4, c5, c6 = counts
    return {'total': total, 'c1': c1, 'c2': c2, 'c3': c3, 'c4': c4, 'c5': c5, 'c6': c6,
            'src': src, 'actual': actual, 'drift': drift}


def nearest_slot(now):
    hhmm = now.strftime('%H:%M')
    best = None
    for s in SLOTS:
        if s <= hhmm:
            best = s
    if best is None:
        return None, None
    sh, sm = map(int, best.split(':'))
    target = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
    return best, int((now - target).total_seconds() // 60)


# ---------- 模式一：盘中快照 ----------

def run_snap(store, limit=0):
    now = now_bj()
    slot, drift = nearest_slot(now)
    if slot is None:
        print('当前 %s 尚未到首个时点 %s，快照跳过' % (now.strftime('%H:%M'), SLOTS[0]))
        return 0
    print('盘中快照：目标时点 %s（实际 %s，偏移 %d 分钟）'
          % (slot, now.strftime('%H:%M'), drift))

    stocks = fetch_universe(limit)
    counts = [0] * 6
    traded = 0
    for s in stocks:
        if s['vol'] <= 0 or s['price'] <= 0:
            continue                            # 当日未产生交易 / 停牌
        cls = classify(s['open'], s['price'], s['high'], s['low'], s['prev'])
        if cls is None:
            continue
        traded += 1
        for i, v in enumerate(cls):
            counts[i] += v

    date = now.strftime('%Y-%m-%d')
    day = find_day(store, date)
    day['slots'][slot] = slot_record(counts, traded, 'snap', now.strftime('%H:%M'), drift)
    day['total'] = traded
    print('快照完成：%s %s 交易家数 %d | c1..c6=%s' % (date, slot, traded, counts))
    return 1


# ---------- 模式二：5 分钟 K 线复盘 ----------

def fetch_k5_sina(symbol):
    url = '%s?symbol=%s&scale=5&ma=no&datalen=400' % (SINA_K5, symbol)
    txt = http_get(url, timeout=25, retries=2, headers=SINA_REF).strip()
    if not txt or txt in ('null', '[]'):
        return []
    arr = json.loads(txt)
    bars = []
    for r in arr:
        day = str(r.get('day') or '')
        if len(day) < 16:
            continue
        bars.append((day[:10], day[11:16], fnum(r.get('open')), fnum(r.get('close')),
                     fnum(r.get('high')), fnum(r.get('low')), fnum(r.get('volume'))))
    return bars


def fetch_k5_tx(symbol):
    url = '%s?param=%s,m5,,400' % (TX_K5_REAL, symbol)
    txt = http_get(url, timeout=25, retries=2).strip()
    j = json.loads(txt)
    d = (j.get('data') or {}).get(symbol) or {}
    kl = d.get('m5') or []
    bars = []
    for row in kl:
        if len(row) < 6:
            continue
        ts = str(row[0])                       # 202610231505
        if len(ts) < 12:
            continue
        date = '%s-%s-%s' % (ts[0:4], ts[4:6], ts[6:8])
        tm = '%s:%s' % (ts[8:10], ts[10:12])
        try:
            bars.append((date, tm, float(row[1]), float(row[2]),
                         float(row[3]), float(row[4]), float(row[5])))
        except (TypeError, ValueError):
            continue
    return bars


def fetch_bars(symbol):
    """新浪优先，腾讯兜底；返回按时间升序的 bar 列表"""
    try:
        bars = fetch_k5_sina(symbol)
        if bars:
            return bars
    except Exception:
        pass
    bars = fetch_k5_tx(symbol)
    return bars


def group_by_day(bars):
    days = {}
    for (date, tm, o, c, h, lo, v) in bars:
        days.setdefault(date, []).append((tm, o, c, h, lo, v))
    for d in days:
        days[d].sort(key=lambda x: x[0])
    return days


def compute_day_points(days, date, prev_close):
    """按 8 个 5 分钟时点统计单只股票 → {slot: (c1..c6)}
    每个时点的最高/最低取「当日开盘至该时点」的累计值（与盘中快照同口径）。"""
    bars = days.get(date) or []
    if not bars:
        return None
    if sum(b[5] for b in bars) <= 0:
        return None                              # 当日无成交
    day_open = bars[0][1]
    if day_open <= 0 or not prev_close or prev_close <= 0:
        return None
    res = {}
    run_high = None
    run_low = None
    for (tm, o, c, h, lo, v) in bars:
        run_high = h if run_high is None else max(run_high, h)
        run_low = lo if run_low is None else min(run_low, lo)
        if tm in SLOT_SET:
            cls = classify(day_open, c, run_high, run_low, prev_close)
            if cls is not None:
                res[tm] = cls
    return res


def run_backfill(store, limit=0, workers=8):
    t0 = time.time()
    print('收盘复盘：5 分钟 K 线逐股重算')
    stocks = fetch_universe(limit)
    if not stocks:
        print('股票池为空，终止')
        return 0
    print('待处理: %d 只，并发 %d' % (len(stocks), workers))

    agg = {}          # date -> {slots:{slot:[6]}, total}
    ok = 0
    failed = 0
    done = 0

    def work(s):
        try:
            return s, fetch_bars(s['symbol'])
        except Exception:
            return s, []

    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(work, s) for s in stocks]
        for fu in as_completed(futs):
            s, bars = fu.result()
            done += 1
            if not bars:
                failed += 1
            else:
                ok += 1
                days = group_by_day(bars)
                dates = sorted(days.keys())
                for i in range(1, len(dates)):        # i=0 无前一日收盘，跳过
                    d = dates[i]
                    prev_close = days[dates[i - 1]][-1][2]   # 前一日最后 5 分钟收盘
                    pts = compute_day_points(days, d, prev_close)
                    if not pts:
                        continue
                    bucket = agg.setdefault(d, {'slots': {x: [0] * 6 for x in SLOTS}, 'total': 0})
                    bucket['total'] += 1
                    for slot, cls in pts.items():
                        arr = bucket['slots'][slot]
                        for k in range(6):
                            arr[k] += cls[k]
            if done % 500 == 0:
                print('  进度 %d/%d  失败 %d  用时 %.0fs'
                      % (done, len(stocks), failed, time.time() - t0))

    coverage = ok / max(1, len(stocks))
    print('抓取完成：成功 %d / 失败 %d，覆盖率 %.1f%%，用时 %.0fs'
          % (ok, failed, coverage * 100, time.time() - t0))

    if coverage < 0.90:
        print('覆盖率不足 90%，为避免家数被低估，本次不写入（保留快照数据）')
        return 0

    if not agg:
        print('未获得任何 K 线统计数据')
        return 0

    now = now_bj()
    today = now.strftime('%Y-%m-%d')
    now_min = now.hour * 60 + now.minute

    keep = sorted(agg.keys())[-KEEP_DAYS:]
    for d in keep:
        day = find_day(store, d)
        day['total'] = agg[d]['total']
        day['coverage'] = round(coverage, 4)
        for slot in SLOTS:
            if d == today:
                sh, sm = map(int, slot.split(':'))
                if sh * 60 + sm + 3 > now_min:
                    continue          # 今日尚未走到的时点不写入，前端留空而非画 0
            arr = agg[d]['slots'][slot]
            day['slots'][slot] = slot_record(arr, agg[d]['total'], 'kline', slot, 0)

    print('复盘覆盖日期: %s' % ', '.join(keep))
    for d in keep:
        b = agg[d]
        last_slot = '15:00'
        for s in SLOTS:
            if any(b['slots'][s]):
                last_slot = s
        last = b['slots'][last_slot]
        print('  %s 交易 %5d 家（截至 %s）| 做多 %4d 做空 %4d | 上方阻力 %4d 下方支撑 %4d'
              % (d, b['total'], last_slot, last[0] + last[1], last[2] + last[3], last[4], last[5]))
    return len(keep)


# ---------- 写文件 ----------

def write_files(store):
    store['slots'] = SLOTS
    prune(store)
    store['generated_at'] = now_bj().isoformat()
    store['note'] = ('8 个时点：' + ' / '.join(SLOTS) +
                     '。snap 为盘中快照（cron 可能偏移，actual/drift 记录实际时间），'
                     'kline 为收盘后 5 分钟 K 线精确复盘。除权除息日可能导致个别股票涨幅偏差。')
    with open(DATA_JSON, 'w', encoding='utf-8') as f:
        json.dump(store, f, ensure_ascii=False, separators=(',', ':'))
    js = ('// 共振分组家数数据（由 scripts/update_resonance.py 自动生成，勿手改；随仓库发布）\n'
          'window.RESONANCE_DATA=' + json.dumps(store, ensure_ascii=False, separators=(',', ':')) + ';\n')
    with open(DATA_JS, 'w', encoding='utf-8') as f:
        f.write(js)

    # 内容哈希版本号：内容一变 URL 就变，强制各端（含 Service Worker）拉到新数据
    try:
        import hashlib
        ver = hashlib.md5(js.encode('utf-8')).hexdigest()[:10]
        html = open(IDX_HTML, encoding='utf-8').read()
        html2 = re.sub(r'(/data/resonance_data\.js\?v=)[0-9a-zA-Z_]+',
                       lambda m: m.group(1) + ver, html)
        if html2 != html:
            open(IDX_HTML, 'w', encoding='utf-8').write(html2)
            print('index.html 数据版本已更新为', ver)
    except Exception as e:
        print('index.html 版本更新失败(可忽略):', e)
    print('已写入 %s（%d 个交易日）' % (os.path.relpath(DATA_JS, ROOT), len(store['days'])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', choices=['auto', 'snap', 'backfill'], default='auto')
    ap.add_argument('--limit', type=int, default=0, help='只处理前 N 只（调试，默认不写文件）')
    ap.add_argument('--write', action='store_true', help='配合 --limit 强制写文件')
    ap.add_argument('--workers', type=int, default=8)
    args = ap.parse_args()

    now = now_bj()
    mode = args.mode
    if mode == 'auto':
        hm = now.strftime('%H:%M')
        mode = 'backfill' if '15:20' <= hm <= '23:59' else 'snap'
        print('自动模式: %s（北京时间 %s）' % (mode, now.strftime('%Y-%m-%d %H:%M')))
        if now.weekday() >= 5 and not args.limit:
            print('非交易日，跳过')
            return 0

    store = load_store()
    n = run_snap(store, args.limit) if mode == 'snap' else run_backfill(store, args.limit, args.workers)

    if n:
        if args.limit and not args.write:
            print('调试模式（--limit），不写入文件；如需写入请加 --write')
        else:
            write_files(store)
    return 0


if __name__ == '__main__':
    sys.exit(main())
