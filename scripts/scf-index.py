# -*- coding: utf-8 -*-
"""
腾讯云函数 SCF - 股票定时监控
每 5 分钟由定时触发器调用，读取 GitHub 上的配置后检查行情并推送微信
"""
import json, os, sys
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen

CST = timezone(timedelta(hours=8))
CONFIG_URL = 'https://raw.githubusercontent.com/Ronie-Liu/stock-pwa/main/stock-config.json'

def log(msg):
    print(f"[{datetime.now(CST).strftime('%H:%M:%S')}] {msg}")

def load_config():
    """从 GitHub 公开仓库读取股票配置"""
    try:
        req = Request(CONFIG_URL, headers={'User-Agent': 'SCF-StockMonitor/1.0'})
        resp = urlopen(req, timeout=10)
        return json.loads(resp.read())
    except Exception as e:
        log(f'配置加载失败: {e}')
        return None

def fetch_quotes(codes):
    """从腾讯行情 API 批量获取"""
    tcodes = []
    for code in codes:
        digits = ''.join(c for c in code if c.isdigit())
        if code.startswith(('60', '68', '900')):
            tcodes.append('sh' + digits)
        elif code.startswith(('920', '8')):
            tcodes.append('bj' + digits)
        else:
            tcodes.append('sz' + digits)

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
                'last_px': float(fields[3]) if fields[3] else 0
            }
        except:
            continue

    return quotes

def check_thresholds(stocks, quotes, config):
    """检查阈值，返回触发列表"""
    wt = config.get('watchlist_threshold', 0.9)      # 自选股倍数阈值
    hr = config.get('holdings_rate_threshold', 1.0)   # 持仓目标达成率
    hb = config.get('holdings_buy_threshold', 0.9)    # 持仓买入倍数
    alerts = []

    for stock in stocks:
        # 匹配行情
        matched = None
        for qcode, quote in quotes.items():
            if stock['code'] in qcode or qcode in stock['code']:
                matched = quote
                break
        if not matched:
            continue

        px = matched.get('last_px', 0)
        if not px or px <= 0:
            continue

        st = stock.get('type', 'watchlist')

        if st == 'watchlist':
            bp = stock.get('buy_price', 0)
            if bp and bp > 0 and px / bp <= wt:
                alerts.append({
                    'name': stock['name'],
                    'code': stock['code'],
                    'value': f'{px / bp:.2f}'
                })

        elif st == 'holdings':
            tp = stock.get('target_price', 0)
            if tp and tp > 0 and px / tp >= hr:
                alerts.append({
                    'name': stock['name'],
                    'code': stock['code'],
                    'value': f'{px / tp:.2f}'
                })
            bp = stock.get('buy_price', 0)
            if bp and bp > 0 and px / bp <= hb:
                alerts.append({
                    'name': stock['name'],
                    'code': stock['code'],
                    'value': f'{px / bp:.2f}'
                })

    return alerts

def send_wechat(webhook_url, alerts):
    """发送企业微信 Markdown 消息"""
    now_str = datetime.now(CST).strftime('%Y-%m-%d %H:%M:%S')
    lines = [
        f'- **{a["name"]}**（{a["code"]}）：<font color="info">{a["value"]}</font>'
        for a in alerts
    ]
    content = (
        f'## 📈 股票定时提醒\n'
        f'> 触发时间：{now_str}\n'
        f'> 触发数量：<font color="warning">{len(alerts)}</font> 只\n\n'
        + '\n'.join(lines)
    )

    data = json.dumps({
        'msgtype': 'markdown',
        'markdown': {'content': content}
    }).encode('utf-8')

    try:
        req = Request(webhook_url, data=data, headers={'Content-Type': 'application/json'})
        resp = urlopen(req, timeout=15)
        result = json.loads(resp.read())
        if result.get('errcode') == 0:
            log(f'微信推送成功: {len(alerts)} 只')
        else:
            log(f'微信推送失败: {result.get("errmsg")}')
    except Exception as e:
        log(f'微信推送异常: {e}')

# ===== SCF 入口函数 =====
def main_handler(event, context):
    # 1. 加载配置
    config = load_config()
    if not config:
        return '配置加载失败'

    stocks = config.get('stocks', [])
    if not stocks:
        return '无监控股票'

    # 2. 时间点过滤（±2 分钟容差）
    check_times = config.get('check_times', [])
    if check_times:
        now = datetime.now(CST)
        matched = False
        for t in check_times:
            parts = t.split(':')
            if len(parts) == 2:
                try:
                    th, tm = int(parts[0]), int(parts[1])
                    if now.hour == th and abs(now.minute - tm) <= 2:
                        matched = True
                        break
                except:
                    continue
        if not matched:
            # 不是设定时间点，正常返回（不推送）
            return

    log(f'时间点 {datetime.now(CST).strftime("%H:%M")} 触发检查')

    # 3. 获取 Webhook URL（从环境变量）
    webhook_url = os.environ.get('WECHAT_WEBHOOK_URL', '')
    if not webhook_url:
        webhook_url = config.get('webhook_url', '')
    if not webhook_url:
        log('未配置 Webhook URL')
        return '未配置 Webhook URL'

    # 4. 获取行情
    codes = [s['code'] for s in stocks]
    quotes = fetch_quotes(codes)
    if not quotes:
        log('行情获取失败')
        return '行情获取失败'

    # 5. 检查阈值
    alerts = check_thresholds(stocks, quotes, config)

    if alerts:
        names = ', '.join(a['name'] + '(' + a['value'] + ')' for a in alerts)
        log(f'触发 {len(alerts)} 只: {names}')
        send_wechat(webhook_url, alerts)
        return f'触发 {len(alerts)} 只: {names}'
    else:
        log('无股票触发提醒')
        return '无股票触发提醒'
