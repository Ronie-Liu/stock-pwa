# -*- coding: utf-8 -*-
"""
腾讯云函数 SCF - 股票阈值监控
触发: 每5分钟
功能: 在 check_times 检查阈值 + 附上证指数/沪深300
"""
import json, os, sys
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen

CST = timezone(timedelta(hours=8))
CONFIG_URL = 'https://raw.githubusercontent.com/Ronie-Liu/stock-pwa/main/stock-config.json'

def log(msg):
    print(f"[{datetime.now(CST).strftime('%H:%M:%S')}] {msg}")

def load_config():
    try:
        req = Request(CONFIG_URL, headers={'User-Agent': 'SCF-StockMonitor/3.0'})
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
                'prev_close': float(fields[4]) if fields[4] else 0,
            }
            if quotes[qcode]['prev_close'] > 0:
                quotes[qcode]['change_pct'] = round((quotes[qcode]['last_px'] - quotes[qcode]['prev_close']) / quotes[qcode]['prev_close'] * 100, 2)
            else:
                quotes[qcode]['change_pct'] = 0
        except:
            continue
    return quotes

def fetch_index_quotes():
    """仅获取上证指数 + 沪深300"""
    index_codes = ['sh000001', 'sh000300']
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
    name_map = {'sh000001': '上证指数', 'sh000300': '沪深300'}
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

def find_quote(code, quotes):
    tc = std_to_tencent(code)
    for qcode, q in quotes.items():
        if code in qcode or qcode in code or tc in qcode:
            return q
    return None

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

def build_index_line(indices):
    """构建指数一行信息"""
    if not indices:
        return ''
    parts = []
    for k, v in indices.items():
        emoji = '🟢' if v['change_pct'] > 0 else '🔴' if v['change_pct'] < 0 else '⚪'
        parts.append(f"{emoji}**{v['name']}** {v['px']:.2f} ({v['change_pct']:+.2f}%)")
    return ' | '.join(parts)

def send_wechat(webhook_url, alerts, indices):
    now_str = datetime.now(CST).strftime('%Y-%m-%d %H:%M:%S')
    lines = []
    for a in alerts:
        color = 'warning' if a['type'] == 'watchlist' else 'info'
        label = '买入' if a['type'] == 'watchlist' else ('目标' if a['type'] == 'holdings_target' else '加仓')
        lines.append(f'- **{a["name"]}**（{a["code"]}）{label}: <font color="{color}">{a["value"]}</font>')

    idx_line = build_index_line(indices)

    content = (
        f'## 📈 股票阈值提醒\n'
        f'> 触发时间：{now_str}\n'
        f'> 触发数量：<font color="warning">{len(alerts)}</font> 只\n'
        + (f'> {idx_line}\n' if idx_line else '')
        + '\n'
        + '\n'.join(lines)
    )

    data = json.dumps({'msgtype': 'markdown', 'markdown': {'content': content}}).encode('utf-8')
    try:
        req = Request(webhook_url, data=data, headers={'Content-Type': 'application/json'})
        resp = urlopen(req, timeout=15)
        result = json.loads(resp.read())
        return result.get('errcode') == 0
    except Exception as e:
        log(f'推送异常: {e}')
        return False

def match_check_time(check_times, tolerance=2):
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
    log(f'触发 {now.strftime("%H:%M")}')

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

    check_times = config.get('check_times', [])
    matched_time = match_check_time(check_times, tolerance=2)
    if not matched_time:
        log('非监控时间')
        return '非监控时间'

    log(f'匹配监控时间: {matched_time}')

    codes = [s['code'] for s in stocks]
    quotes = fetch_quotes(codes)
    if not quotes:
        log('行情获取失败')
        return '行情获取失败'

    alerts = check_thresholds(stocks, quotes, config)
    if not alerts:
        log('无股票触发提醒')
        return '无触发'

    indices = fetch_index_quotes()

    names = ', '.join(a['name'] + '(' + a['value'] + ')' for a in alerts)
    log(f'触发 {len(alerts)} 只: {names}')

    if send_wechat(webhook_url, alerts, indices):
        log('推送成功')
        return f'触发{len(alerts)}只,推送成功'
    else:
        return '推送失败'
