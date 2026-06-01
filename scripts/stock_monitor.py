#!/usr/bin/env python3
"""股票定时监控 - GitHub Actions 定时执行"""
import json, os, sys, time
from datetime import datetime, timezone, timedelta
from urllib.request import Request, urlopen

CST = timezone(timedelta(hours=8))

def log(msg):
    print(f"[{datetime.now(CST).strftime('%H:%M:%S')}] {msg}")

def load_config():
    with open('stock-config.json', 'r', encoding='utf-8') as f:
        return json.load(f)

def fetch_quotes(codes):
    """从腾讯API批量获取行情"""
    tcodes = []
    for code in codes:
        digits = ''.join(c for c in code if c.isdigit())
        if code.startswith('60') or code.startswith('68') or code.startswith('900'):
            tcodes.append('sh' + digits)
        elif code.startswith('920') or code.startswith('8'):
            tcodes.append('bj' + digits)
        else:
            tcodes.append('sz' + digits)
    
    url = 'https://qt.gtimg.cn/q=' + ','.join(tcodes)
    try:
        req = Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        resp = urlopen(req, timeout=15)
        data = resp.read()
        # 腾讯API返回GBK编码
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
        code_part = parts[0].replace('v_', '')
        data_part = parts[1].rstrip('";\n')
        fields = data_part.split('~')
        if len(fields) < 40:
            continue
        
        try:
            quote = {
                'name': fields[1],
                'code': code_part,
                'last_px': float(fields[3]) if fields[3] else 0,
                'open': float(fields[5]) if fields[5] else 0,
                'pre_close': float(fields[4]) if fields[4] else 0,
                'px_change': float(fields[31]) if fields[31] else 0,
                'px_change_rate': float(fields[32]) if fields[32] else 0,
            }
            quotes[code_part] = quote
        except (ValueError, IndexError) as e:
            log(f'解析 {code_part} 失败: {e}')
            continue
    
    return quotes

def check_thresholds(stocks, quotes, config):
    """检查阈值"""
    alerts = []
    watchlist_threshold = config.get('watchlist_threshold', 0.9)
    holdings_rate_threshold = config.get('holdings_rate_threshold', 1.0)
    holdings_buy_threshold = config.get('holdings_buy_threshold', 0.9)
    
    for stock in stocks:
        # 匹配行情
        matched = None
        for qcode, quote in quotes.items():
            if stock['code'] in qcode or qcode in stock['code']:
                matched = quote
                break
        
        if not matched:
            continue
        
        last_px = matched.get('last_px', 0)
        if not last_px or last_px <= 0:
            continue
        
        stock_type = stock.get('type', 'watchlist')
        
        if stock_type == 'watchlist':
            buy_price = stock.get('buy_price', 0)
            if buy_price and buy_price > 0:
                multiple = last_px / buy_price
                if multiple <= watchlist_threshold:
                    alerts.append({
                        'name': stock['name'],
                        'code': stock['code'],
                        'type': '自选',
                        'value': f'{multiple:.2f}'
                    })
        
        elif stock_type == 'holdings':
            # 目标达成率
            target_price = stock.get('target_price', 0)
            if target_price and target_price > 0:
                rate = last_px / target_price
                if rate >= holdings_rate_threshold:
                    alerts.append({
                        'name': stock['name'],
                        'code': stock['code'],
                        'type': '目标',
                        'value': f'{rate:.2f}'
                    })
            # 买入倍数
            buy_price = stock.get('buy_price', 0)
            if buy_price and buy_price > 0:
                multiple = last_px / buy_price
                if multiple <= holdings_buy_threshold:
                    alerts.append({
                        'name': stock['name'],
                        'code': stock['code'],
                        'type': '倍数',
                        'value': f'{multiple:.2f}'
                    })
    
    return alerts

def send_webhook(webhook_url, alerts, trigger_type='定时'):
    """发送企业微信Webhook消息"""
    now_str = datetime.now(CST).strftime('%Y-%m-%d %H:%M:%S')
    
    lines = [f'- **{a["name"]}**（{a["code"]}）：<font color="info">{a["value"]}</font>' for a in alerts]
    content = f'## 📈 股票{trigger_type}提醒\n> 触发时间：{now_str}\n> 触发数量：<font color="warning">{len(alerts)}</font> 只\n\n' + '\n'.join(lines)
    
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

def is_trading_time():
    """判断是否交易时间（含盘前盘后）"""
    now = datetime.now(CST)
    weekday = now.weekday()  # 0=Monday, 6=Sunday
    if weekday >= 5:
        return False
    
    time_str = now.strftime('%H%M')
    return '0915' <= time_str <= '1535'

def main():
    # 加载配置
    config = load_config()
    stocks = config.get('stocks', [])
    
    if not stocks:
        log('无监控股票，退出')
        return
    
    # 检查交易日
    if not is_trading_time():
        log('非交易时间，跳过检查')
        return
    
    # 获取Webhook URL（优先从环境变量读取）
    webhook_url = os.environ.get('WECHAT_WEBHOOK_URL', '')
    if not webhook_url:
        log('⚠ 未设置 WECHAT_WEBHOOK_URL 环境变量')
        # 尝试从config读取（不推荐，公开仓库会泄露）
        webhook_url = config.get('webhook_url', '')
    
    if not webhook_url:
        log('❌ 无Webhook URL，无法推送')
        return
    
    # 获取行情
    codes = [s['code'] for s in stocks]
    log(f'开始检查 {len(stocks)} 只股票...')
    quotes = fetch_quotes(codes)
    log(f'获取到 {len(quotes)} 只行情')
    
    # 检查阈值
    alerts = check_thresholds(stocks, quotes, config)
    
    if alerts:
        log(f'✅ 触发 {len(alerts)} 只: {", ".join(a["name"] for a in alerts)}')
        send_webhook(webhook_url, alerts)
    else:
        log('无股票触发提醒')
    
    sys.exit(0)

if __name__ == '__main__':
    main()
