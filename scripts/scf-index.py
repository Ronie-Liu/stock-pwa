# -*- coding: utf-8 -*-
"""
腾讯云函数 SCF - 股票监控+智能简报 (合并版)
触发: 每5分钟
功能:
  1. 阈值监控: 在用户配置的 check_times 检查自选股/持仓股阈值
  2. 智能简报: 在7个固定时段推送差异化简报
"""
import json, os, sys
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen

CST = timezone(timedelta(hours=8))
CONFIG_URL = 'https://raw.githubusercontent.com/Ronie-Liu/stock-pwa/main/stock-config.json'

# 简报时段配置
BRIEFING_SLOTS = {
    '08:30': {'name': '盘前简报', 'emoji': '🌅', 'focus': '隔夜消息+大盘预判+持仓重点'},
    '09:30': {'name': '开盘简报', 'emoji': '🚀', 'focus': '开盘表现+持仓盈亏+急涨急跌'},
    '10:30': {'name': '早盘简报', 'emoji': '📊', 'focus': '早盘趋势+板块强弱+持仓调整'},
    '11:30': {'name': '午盘简报', 'emoji': '⏸️', 'focus': '上午总结+持仓盈亏+下午策略'},
    '14:00': {'name': '下午简报', 'emoji': '⏩', 'focus': '下午开盘+持仓盯盘+尾盘准备'},
    '14:50': {'name': '尾盘简报', 'emoji': '⏰', 'focus': '尾盘异动+持仓决策+次日预判'},
    '15:30': {'name': '盘后简报', 'emoji': '📋', 'focus': '全天复盘+持仓分析+次日计划'},
}

def log(msg):
    print(f"[{datetime.now(CST).strftime('%H:%M:%S')}] {msg}")

def load_config():
    try:
        req = Request(CONFIG_URL, headers={'User-Agent': 'SCF-StockMonitor/2.0'})
        resp = urlopen(req, timeout=10)
        return json.loads(resp.read())
    except Exception as e:
        log(f'配置加载失败: {e}')
        return None

def std_to_tencent(code):
    digits = ''.join(c for c in code if c.isdigit())
    if code.startswith(('60', '68', '900')):
        return 'sh' + digits
    elif code.startswith(('920', '8')):
        return 'bj' + digits
    else:
        return 'sz' + digits

def fetch_quotes(codes):
    tcodes = [std_to_tencent(c) for c in codes]
    url = 'https://qt.gtimg.cn/q=' + ','.join(tcodes)
    try:
        req = Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urlopen(req, timeout=15)
        data = resp.read()
        for enc in ['gbk', 'gb18030', 'gb2312']:
            try:
                text = data.decode(enc)
                break
            except:
                continue
        else:
            text = data.decode('latin-1')
    except Exception as e:
        log(f'行情获取失败: {e}')
        return {}

    quotes = {}
    for line in text.strip().split('\n'):
        if '="' not in line:
            continue
        parts = line.split('="', 1)
        if len(parts) != 2:
            continue
        qcode = parts[0].replace('v_', '')
        fields = parts[1].rstrip('";\n').split('~')
        if len(fields) < 40:
            continue
        try:
            quotes[qcode] = {
                'name': fields[1],
                'code': qcode,
                'last_px': float(fields[3]) if fields[3] else 0,
                'open_px': float(fields[5]) if fields[5] else 0,
                'high_px': float(fields[33]) if fields[33] else 0,
                'low_px': float(fields[34]) if fields[34] else 0,
                'prev_close': float(fields[4]) if fields[4] else 0,
                'volume': int(fields[36]) if fields[36] else 0,
            }
            if quotes[qcode]['prev_close'] > 0:
                quotes[qcode]['change_pct'] = round((quotes[qcode]['last_px'] - quotes[qcode]['prev_close']) / quotes[qcode]['prev_close'] * 100, 2)
            else:
                quotes[qcode]['change_pct'] = 0
        except:
            continue
    return quotes

def fetch_index_quotes():
    index_codes = ['sh000001', 'sz399001', 'sz399006', 'sh000300']
    url = 'https://qt.gtimg.cn/q=' + ','.join(index_codes)
    try:
        req = Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urlopen(req, timeout=10)
        data = resp.read()
        for enc in ['gbk', 'gb18030']:
            try:
                text = data.decode(enc)
                break
            except:
                continue
        else:
            text = data.decode('latin-1')
    except:
        return {}

    indices = {}
    name_map = {'sh000001': '上证指数', 'sz399001': '深证成指', 'sz399006': '创业板指', 'sh000300': '沪深300'}
    for line in text.strip().split('\n'):
        if '="' not in line:
            continue
        parts = line.split('="', 1)
        qcode = parts[0].replace('v_', '')
        fields = parts[1].rstrip('";\n').split('~')
        if len(fields) < 40:
            continue
        try:
            px = float(fields[3]) if fields[3] else 0
            prev = float(fields[4]) if fields[4] else 0
            chg = round((px - prev) / prev * 100, 2) if prev > 0 else 0
            indices[qcode] = {'name': name_map.get(qcode, qcode), 'px': px, 'change_pct': chg}
        except:
            continue
    return indices

def fetch_market_breadth():
    try:
        url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f8,f9,f12,f14&secids=1.000001,0.399001,0.399006'
        req = Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urlopen(req, timeout=10)
        d = json.loads(resp.read())
        diffs = d.get('data', {}).get('diff', [])
        total_up = sum(int(float(item.get('f8', 0))) for item in diffs)
        total_down = sum(int(float(item.get('f9', 0))) for item in diffs)
        total = total_up + total_down
        ratio = round(total_up / total * 100, 1) if total > 0 else 50
        return {'up': total_up, 'down': total_down, 'ratio': ratio}
    except Exception as e:
        log(f'涨跌家数获取失败: {e}')
        return None

def find_quote(code, quotes):
    tc = std_to_tencent(code)
    for qcode, q in quotes.items():
        if code in qcode or qcode in code or tc in qcode:
            return q
    return None

# ==================== 阈值监控逻辑 ====================

def check_thresholds(stocks, quotes, config):
    wt = config.get('watchlist_threshold', 0.9)
    hr = config.get('holdings_rate_threshold', 1.0)
    hb = config.get('holdings_buy_threshold', 0.9)
    alerts = []

    for stock in stocks:
        matched = find_quote(stock['code'], quotes)
        if not matched:
            continue
        px = matched.get('last_px', 0)
        if not px or px <= 0:
            continue
        st = stock.get('type', 'watchlist')

        if st == 'watchlist':
            bp = stock.get('buy_price', 0)
            if bp and bp > 0 and px / bp <= wt:
                alerts.append({'name': stock['name'], 'code': stock['code'], 'value': f'{px / bp:.2f}', 'type': 'watchlist'})
        elif st == 'holdings':
            tp = stock.get('target_price', 0)
            if tp and tp > 0 and px / tp >= hr:
                alerts.append({'name': stock['name'], 'code': stock['code'], 'value': f'{px / tp:.2f}', 'type': 'holdings_target'})
            bp = stock.get('buy_price', 0)
            if bp and bp > 0 and px / bp <= hb:
                alerts.append({'name': stock['name'], 'code': stock['code'], 'value': f'{px / bp:.2f}', 'type': 'holdings_buy'})

    return alerts

def send_alert_wechat(webhook_url, alerts):
    now_str = datetime.now(CST).strftime('%Y-%m-%d %H:%M:%S')
    lines = []
    for a in alerts:
        color = 'warning' if a['type'] == 'watchlist' else 'info'
        label = '买入' if a['type'] == 'watchlist' else ('目标' if a['type'] == 'holdings_target' else '加仓')
        lines.append(f'- **{a["name"]}**（{a["code"]}）{label}: <font color="{color}">{a["value"]}</font>')

    content = (
        f'## 📈 股票阈值提醒\n'
        f'> 触发时间：{now_str}\n'
        f'> 触发数量：<font color="warning">{len(alerts)}</font> 只\n\n'
        + '\n'.join(lines)
    )

    data = json.dumps({'msgtype': 'markdown', 'markdown': {'content': content}}).encode('utf-8')
    try:
        req = Request(webhook_url, data=data, headers={'Content-Type': 'application/json'})
        resp = urlopen(req, timeout=15)
        result = json.loads(resp.read())
        return result.get('errcode') == 0
    except Exception as e:
        log(f'阈值推送异常: {e}')
        return False

# ==================== 简报推送逻辑 ====================

def build_briefing(slot, stocks, quotes, indices, breadth):
    cfg = BRIEFING_SLOTS[slot]
    now_str = datetime.now(CST).strftime('%m-%d %H:%M')
    holdings = [s for s in stocks if s.get('type') == 'holdings']
    watchlist = [s for s in stocks if s.get('type') != 'holdings']

    lines = [f"## {cfg['emoji']} {cfg['name']} ({now_str})"]
    lines.append(f"> 📌 {cfg['focus']}")
    lines.append("")

    # 大盘
    if indices:
        idx_lines = []
        for k, v in indices.items():
            emoji = '🟢' if v['change_pct'] > 0 else '🔴' if v['change_pct'] < 0 else '⚪'
            idx_lines.append(f"{emoji} **{v['name']}**: {v['px']:.2f} ({v['change_pct']:+.2f}%)")
        lines.append("### 📊 大盘")
        lines.append(' | '.join(idx_lines))
        if breadth:
            be = '🟢' if breadth['ratio'] > 55 else '🔴' if breadth['ratio'] < 45 else '🟡'
            lines.append(f"> 涨跌: 涨{breadth['up']}/跌{breadth['down']} ({be} {breadth['ratio']}%上涨)")
        lines.append("")

    # 持仓股
    if holdings:
        lines.append("### 💼 持仓股")
        for h in holdings:
            q = find_quote(h['code'], quotes)
            if not q:
                continue
            chg = q.get('change_pct', 0)
            emoji = '🟢' if chg > 0 else '🔴' if chg < 0 else '⚪'
            tp = h.get('target_price', 0)
            bp = h.get('buy_price', 0)
            extras = []
            if tp and tp > 0:
                extras.append(f"目标{round(q['last_px']/tp*100,1)}%")
            if bp and bp > 0:
                extras.append(f"成本{round((q['last_px']-bp)/bp*100,1):+.1f}%")
            extra_str = f" ({', '.join(extras)})" if extras else ""
            lines.append(f"{emoji} **{q['name']}** {q['last_px']:.2f} ({chg:+.2f}%){extra_str}")
        lines.append("")

    # 自选股提醒
    alerts = []
    for s in watchlist:
        q = find_quote(s['code'], quotes)
        if not q:
            continue
        bp = s.get('buy_price', 0)
        if bp and bp > 0:
            ratio = q['last_px'] / bp
            if ratio <= 0.92:
                alerts.append(f"🔴 **{q['name']}** 距买入价仅 {ratio:.2f}x")
            elif ratio <= 0.95:
                alerts.append(f"🟡 **{q['name']}** 接近买入价 {ratio:.2f}x")
            elif ratio <= 1.0:
                alerts.append(f"🟢 **{q['name']}** 已达买入区间 {ratio:.2f}x")

    if alerts:
        lines.append("### ⭐ 自选股提醒")
        lines.extend(alerts)
        lines.append("")
    elif watchlist:
        wl_lines = []
        for s in watchlist[:5]:
            q = find_quote(s['code'], quotes)
            if not q:
                continue
            chg = q.get('change_pct', 0)
            emoji = '🟢' if chg > 2 else '🔴' if chg < -2 else '⚪'
            wl_lines.append(f"{emoji} {q['name']} {q['last_px']:.2f} ({chg:+.2f}%)")
        if wl_lines:
            lines.append("### ⭐ 自选股概况")
            lines.extend(wl_lines)
            lines.append("")

    # 时段专属策略
    tips = {
        '08:30': ["- 开盘30分钟观察大盘方向，再决定加仓节奏", "- 持仓股若高开超3%，考虑减仓锁定利润", "- 自选股接近买入价的，准备好资金待命"],
        '09:30': ["- 观察前30分钟量能，判断今日基调", "- 持仓若大幅高开，评估是否止盈", "- 大盘高开低走则谨慎，低开高走可乐观"],
        '10:30': ["- 早盘已定调，趋势明确则顺势操作", "- 持仓股若强于大盘，持有观察", "- 弱势股考虑调仓至强势板块"],
        '11:30': ["- 上午趋势已明，下午延续概率大", "- 持仓盈亏心中有数，下午做好应对", "- 尾盘前1小时是关键操作窗口"],
        '14:00': ["- 下午开盘观察承接力度", "- 2:30后注意尾盘异动", "- 持仓决策需在14:50前完成"],
        '14:50': ["- 最后10分钟，持仓去留要决断", "- 若今日盈利，考虑部分止盈", "- 为次日开盘做好准备"],
        '15:30': ["- 回顾持仓操作，记录得失", "- 更新自选股买入价，准备次日计划"],
    }
    if slot in tips:
        lines.append(f"### 📝 {cfg['name']}策略")
        lines.extend(tips[slot])
        if slot == '15:30' and indices:
            sh = indices.get('sh000001', {})
            if sh:
                trend = '上涨' if sh.get('change_pct', 0) > 0 else '下跌'
                lines.insert(-2, f"- 大盘今日{trend} {sh.get('change_pct', 0):+.2f}%")
        lines.append("")

    lines.append("---")
    lines.append(f"<font color='grey'>数据时间: {now_str} | 来源: 腾讯行情/东方财富</font>")
    return '\n'.join(lines)

def send_briefing_wechat(webhook_url, content):
    data = json.dumps({'msgtype': 'markdown', 'markdown': {'content': content}}).encode('utf-8')
    try:
        req = Request(webhook_url, data=data, headers={'Content-Type': 'application/json'})
        resp = urlopen(req, timeout=15)
        result = json.loads(resp.read())
        return result.get('errcode') == 0
    except Exception as e:
        log(f'简报推送异常: {e}')
        return False

# ==================== 时间判断 ====================

def match_time_slot(tolerance=2):
    """匹配简报时段"""
    now = datetime.now(CST)
    for slot in BRIEFING_SLOTS:
        sh, sm = slot.split(':')
        slot_mins = int(sh) * 60 + int(sm)
        now_mins = now.hour * 60 + now.minute
        if abs(now_mins - slot_mins) <= tolerance:
            return slot
    return None

def match_check_time(check_times, tolerance=2):
    """匹配用户配置的监控时间"""
    now = datetime.now(CST)
    for t in check_times:
        parts = t.split(':')
        if len(parts) == 2:
            try:
                th, tm = int(parts[0]), int(parts[1])
                if now.hour == th and abs(now.minute - tm) <= tolerance:
                    return t
            except:
                continue
    return None

# ===== SCF 入口函数 =====
def main_handler(event, context):
    now = datetime.now(CST)
    log(f'触发检查 {now.strftime("%H:%M")}')

    # 1. 加载配置
    config = load_config()
    if not config:
        return '配置加载失败'

    stocks = config.get('stocks', [])
    if not stocks:
        return '无监控股票'

    # 2. 获取 Webhook
    webhook_url = os.environ.get('WECHAT_WEBHOOK_URL', '')
    if not webhook_url:
        webhook_url = config.get('webhook_url', '')
    if not webhook_url:
        log('未配置 Webhook URL')
        return '未配置 Webhook URL'

    results = []

    # ===== 3A. 简报推送判断 =====
    briefing_slot = match_time_slot(tolerance=2)
    if briefing_slot:
        log(f'匹配简报时段: {briefing_slot}')
        codes = [s['code'] for s in stocks]
        quotes = fetch_quotes(codes)
        indices = fetch_index_quotes()
        breadth = fetch_market_breadth()
        content = build_briefing(briefing_slot, stocks, quotes, indices, breadth)
        if send_briefing_wechat(webhook_url, content):
            log(f'{briefing_slot} 简报推送成功')
            results.append(f'简报:{briefing_slot}✅')
        else:
            results.append(f'简报:{briefing_slot}❌')

    # ===== 3B. 阈值监控判断 =====
    check_times = config.get('check_times', [])
    matched_time = match_check_time(check_times, tolerance=2)
    if matched_time:
        log(f'匹配监控时间: {matched_time}')
        codes = [s['code'] for s in stocks]
        quotes = fetch_quotes(codes)
        if not quotes:
            log('行情获取失败')
            results.append('阈值:行情失败')
        else:
            alerts = check_thresholds(stocks, quotes, config)
            if alerts:
                names = ', '.join(a['name'] + '(' + a['value'] + ')' for a in alerts)
                log(f'触发 {len(alerts)} 只: {names}')
                if send_alert_wechat(webhook_url, alerts):
                    results.append(f'阈值:{len(alerts)}只✅')
                else:
                    results.append(f'阈值:推送失败')
            else:
                log('无股票触发提醒')
                results.append('阈值:无触发')

    if not results:
        log('非推送时段，跳过')
        return '非推送时段'

    return ' | '.join(results)
