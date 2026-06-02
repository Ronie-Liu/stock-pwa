# -*- coding: utf-8 -*-
"""
腾讯云函数 SCF - 股票智能推送简报
时段: 盘前(08:30) / 盘中(09:30,10:30,11:30,14:00,14:50) / 盘后(15:30)
功能: 结合自选股+持仓股，按时段推送差异化简报
"""
import json, os, sys, re
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen

CST = timezone(timedelta(hours=8))
CONFIG_URL = 'https://raw.githubusercontent.com/Ronie-Liu/stock-pwa/main/stock-config.json'

# 各时段推送配置
BRIEFING_CONFIG = {
    '08:30': {
        'name': '盘前简报',
        'emoji': '🌅',
        'focus': '隔夜消息+大盘预判+持仓重点',
        'sections': ['market_preview', 'holdings_focus', 'watchlist_alert', 'today_plan']
    },
    '09:30': {
        'name': '开盘简报',
        'emoji': '🚀',
        'focus': '开盘表现+持仓盈亏+急涨急跌提醒',
        'sections': ['market_snapshot', 'holdings_pnl', 'watchlist_alert', 'urgent']
    },
    '10:30': {
        'name': '早盘简报',
        'emoji': '📊',
        'focus': '早盘趋势+板块强弱+持仓调整建议',
        'sections': ['market_trend', 'sector_brief', 'holdings_review', 'watchlist_alert']
    },
    '11:30': {
        'name': '午盘简报',
        'emoji': '⏸️',
        'focus': '上午总结+持仓盈亏+下午策略',
        'sections': ['morning_summary', 'holdings_pnl', 'afternoon_strategy', 'watchlist_alert']
    },
    '14:00': {
        'name': '下午简报',
        'emoji': '⏩',
        'focus': '下午开盘+持仓盯盘+尾盘准备',
        'sections': ['afternoon_open', 'holdings_watch', 'watchlist_alert', 'closing_prep']
    },
    '14:50': {
        'name': '尾盘简报',
        'emoji': '⏰',
        'focus': '尾盘异动+持仓决策+次日预判',
        'sections': ['closing_alert', 'holdings_decision', 'watchlist_alert', 'tomorrow_preview']
    },
    '15:30': {
        'name': '盘后简报',
        'emoji': '📋',
        'focus': '全天复盘+持仓分析+次日计划',
        'sections': ['daily_review', 'holdings_analysis', 'watchlist_review', 'tomorrow_plan']
    }
}

def log(msg):
    print(f"[{datetime.now(CST).strftime('%H:%M:%S')}] {msg}")

def load_config():
    try:
        req = Request(CONFIG_URL, headers={'User-Agent': 'SCF-StockPush/2.0'})
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
                'turnover': float(fields[37]) if fields[37] else 0,
                'pe': fields[39] if len(fields) > 39 else '--',
                'pb': fields[46] if len(fields) > 46 else '--',
            }
            if quotes[qcode]['prev_close'] > 0:
                quotes[qcode]['change_pct'] = round((quotes[qcode]['last_px'] - quotes[qcode]['prev_close']) / quotes[qcode]['prev_close'] * 100, 2)
            else:
                quotes[qcode]['change_pct'] = 0
        except:
            continue
    return quotes

def fetch_index_quotes():
    """获取大盘指数行情"""
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
    """获取涨跌家数比"""
    try:
        url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f8,f9,f12,f14&secids=1.000001,0.399001,0.399006'
        req = Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urlopen(req, timeout=10)
        d = json.loads(resp.read())
        diffs = d.get('data', {}).get('diff', [])
        total_up = sum(int(safe_num(item.get('f8', 0))) for item in diffs)
        total_down = sum(int(safe_num(item.get('f9', 0))) for item in diffs)
        total = total_up + total_down
        ratio = round(total_up / total * 100, 1) if total > 0 else 50
        return {'up': total_up, 'down': total_down, 'ratio': ratio}
    except Exception as e:
        log(f'涨跌家数获取失败: {e}')
        return None

def safe_num(v):
    try:
        return float(v)
    except:
        return 0

def get_time_slot():
    """判断当前时段"""
    now = datetime.now(CST)
    hm = f"{now.hour:02d}:{now.minute:02d}"
    slots = list(BRIEFING_CONFIG.keys())
    for slot in slots:
        sh, sm = slot.split(':')
        slot_mins = int(sh) * 60 + int(sm)
        now_mins = now.hour * 60 + now.minute
        if abs(now_mins - slot_mins) <= 3:
            return slot
    return None

def build_briefing(slot, stocks, quotes, indices, breadth):
    """构建推送简报内容"""
    cfg = BRIEFING_CONFIG[slot]
    now_str = datetime.now(CST).strftime('%m-%d %H:%M')

    holdings = [s for s in stocks if s.get('type') == 'holdings']
    watchlist = [s for s in stocks if s.get('type') != 'holdings']

    lines = [f"## {cfg['emoji']} {cfg['name']} ({now_str})"]
    lines.append(f"> 📌 {cfg['focus']}")
    lines.append("")

    # 大盘快照
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

    # 持仓股重点
    if holdings:
        lines.append("### 💼 持仓股")
        h_lines = []
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
                ratio = round(q['last_px'] / tp * 100, 1)
                extras.append(f"目标{ratio}%")
            if bp and bp > 0:
                dist = round((q['last_px'] - bp) / bp * 100, 1)
                extras.append(f"成本{dist:+.1f}%")
            extra_str = f" ({', '.join(extras)})" if extras else ""
            h_lines.append(f"{emoji} **{q['name']}** {q['last_px']:.2f} ({chg:+.2f}%){extra_str}")
        lines.extend(h_lines)
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
                alerts.append(f"🔴 **{q['name']}** 距买入价仅 {ratio:.2f}x ({q['last_px']:.2f}/{bp:.2f})")
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

    # 时段专属内容
    if slot == '08:30':
        lines.append("### 📝 今日计划")
        lines.append("- 开盘30分钟观察大盘方向，再决定加仓节奏")
        lines.append("- 持仓股若高开超3%，考虑减仓锁定利润")
        lines.append("- 自选股接近买入价的，准备好资金待命")
    elif slot == '09:30':
        lines.append("### ⚡ 开盘要点")
        lines.append("- 观察前30分钟量能，判断今日基调")
        lines.append("- 持仓若大幅高开，评估是否止盈")
        lines.append("- 大盘高开低走则谨慎，低开高走可乐观")
    elif slot == '10:30':
        lines.append("### 📈 早盘趋势")
        lines.append("- 早盘已定调，趋势明确则顺势操作")
        lines.append("- 持仓股若强于大盘，持有观察")
        lines.append("- 弱势股考虑调仓至强势板块")
    elif slot == '11:30':
        lines.append("### ⏸️ 午间策略")
        lines.append("- 上午趋势已明，下午延续概率大")
        lines.append("- 持仓盈亏心中有数，下午做好应对")
        lines.append("- 尾盘前1小时是关键操作窗口")
    elif slot == '14:00':
        lines.append("### ⏩ 下午要点")
        lines.append("- 下午开盘观察承接力度")
        lines.append("- 2:30后注意尾盘异动")
        lines.append("- 持仓决策需在14:50前完成")
    elif slot == '14:50':
        lines.append("### ⏰ 尾盘决策")
        lines.append("- 最后10分钟，持仓去留要决断")
        lines.append("- 若今日盈利，考虑部分止盈")
        lines.append("- 为次日开盘做好准备")
    elif slot == '15:30':
        lines.append("### 📋 全天复盘")
        if indices:
            sh = indices.get('sh000001', {})
            if sh:
                trend = '上涨' if sh.get('change_pct', 0) > 0 else '下跌' if sh.get('change_pct', 0) < 0 else '平盘'
                lines.append(f"- 大盘今日{trend} {sh.get('change_pct', 0):+.2f}%，{'放量' if sh.get('change_pct', 0) > 1 else '缩量'}明显")
        lines.append("- 回顾持仓操作，记录得失")
        lines.append("- 更新自选股买入价，准备次日计划")

    lines.append("")
    lines.append("---")
    lines.append(f"<font color='grey'>数据时间: {now_str} | 来源: 腾讯行情/东方财富</font>")

    return '\n'.join(lines)

def find_quote(code, quotes):
    tc = std_to_tencent(code)
    for qcode, q in quotes.items():
        if code in qcode or qcode in code or tc in qcode:
            return q
    return None

def send_wechat(webhook_url, content):
    data = json.dumps({
        'msgtype': 'markdown',
        'markdown': {'content': content}
    }).encode('utf-8')
    try:
        req = Request(webhook_url, data=data, headers={'Content-Type': 'application/json'})
        resp = urlopen(req, timeout=15)
        result = json.loads(resp.read())
        if result.get('errcode') == 0:
            return True
        else:
            log(f'微信推送失败: {result.get("errmsg")}')
            return False
    except Exception as e:
        log(f'微信推送异常: {e}')
        return False

# ===== SCF 入口函数 =====
def main_handler(event, context):
    slot = get_time_slot()
    if not slot:
        log('不在推送时段')
        return '不在推送时段'

    log(f'时段 {slot} 触发推送')

    config = load_config()
    if not config:
        return '配置加载失败'

    stocks = config.get('stocks', [])
    if not stocks:
        return '无监控股票'

    webhook_url = os.environ.get('WECHAT_WEBHOOK_URL', '')
    if not webhook_url:
        webhook_url = config.get('webhook_url', '')
    if not webhook_url:
        log('未配置 Webhook URL')
        return '未配置 Webhook URL'

    codes = [s['code'] for s in stocks]
    quotes = fetch_quotes(codes)
    indices = fetch_index_quotes()
    breadth = fetch_market_breadth()

    content = build_briefing(slot, stocks, quotes, indices, breadth)

    if send_wechat(webhook_url, content):
        log(f'{slot} 简报推送成功')
        return f'{slot} 简报推送成功'
    else:
        return f'{slot} 简报推送失败'
