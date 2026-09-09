#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
增量更新 data/high_low_history.json + data/high_low_data.js
============================================================
主数据: 乐咕乐股 全部A股 创新高/新低个股家数
- 基期(2005-02-01 起): 由 scripts/collect_high_low.js 从预览接口采集(匿名预览冻结在 2026-07-01)
- 滚动增量: 本脚本用 akshare.stock_a_high_low_statistics(symbol="all") 拉最近500交易日,
            先与主数据重叠区间做数值一致性校验(必须全等), 再逐日追加到最新交易日。
用法: python scripts/update_high_low.py
依赖: pip install akshare pandas
"""
import json
import os
import re
import sys
import datetime

try:
    import akshare as ak
    import pandas as pd
except Exception as e:  # pragma: no cover
    print('缺少依赖 akshare/pandas，请先: pip install akshare pandas ->', e)
    sys.exit(2)

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_JSON = os.path.normpath(os.path.join(HERE, '..', 'data', 'high_low_history.json'))
DATA_JS = os.path.normpath(os.path.join(HERE, '..', 'data', 'high_low_data.js'))
IDX_HTML = os.path.normpath(os.path.join(HERE, '..', 'index.html'))
KEYS = ['high60', 'low60', 'high120', 'low120']


def main():
    with open(DATA_JSON, 'r', encoding='utf-8') as f:
        cur = json.load(f)
    series = cur['series']
    dates = cur['dates']
    idx = {d: i for i, d in enumerate(dates)}

    df = ak.stock_a_high_low_statistics(symbol='all')
    df['date'] = df['date'].astype(str)
    print('源数据窗口:', df['date'].iloc[0], '~', df['date'].iloc[-1], '共', len(df), '个交易日')

    # ---- 重叠一致性校验（防止源口径变化污染历史） ----
    mism = checked = 0
    for d in df['date']:
        i = idx.get(d)
        if i is None:
            continue
        checked += 1
        for k in KEYS:
            try:
                a = int(df.loc[df['date'] == d, k].iloc[0])
            except Exception:
                a = None
            b = series[k]['values'][i]
            if a != b:
                mism += 1
                if mism <= 6:
                    print('不一致:', d, k, '新源=', a, '现有=', b)
    if checked and mism:
        print('重叠校验失败 %d/%d 处不一致，中止更新（避免污染历史数据）' % (mism, checked))
        return 1
    if checked:
        print('重叠校验通过:', checked, '个交易日完全一致')

    # ---- 追加新交易日 ----
    tail = df[df['date'] > cur['last_date']]
    n = len(tail)
    if n == 0:
        print('无新数据，当前已更新至', cur['last_date'])
        return 0
    for _, row in tail.iterrows():
        dates.append(row['date'])
        for k in KEYS:
            series[k]['values'].append(int(row[k]))
    cur['last_date'] = dates[-1]
    cur['generated_at'] = pd.Timestamp.now(tz='Asia/Shanghai').isoformat()
    cur['appended_note'] = '滚动增量由 scripts/update_high_low.py 追加（akshare stock_a_high_low_statistics）'

    with open(DATA_JSON, 'w', encoding='utf-8') as f:
        json.dump(cur, f, ensure_ascii=False, separators=(',', ':'))
    js = ('// 全A顶部or底部 历史数据（由 scripts/update_high_low.py 自动生成，勿手改；随仓库发布）\n'
          'window.HL_HISTORY_DATA=' + json.dumps(cur, ensure_ascii=False, separators=(',', ':')) + ';\n')
    with open(DATA_JS, 'w', encoding='utf-8') as f:
        f.write(js)

    # ---- 顺手把 index.html 里内置数据脚本的版本号改为当天日期(北京时间)，强制各端拉到新数据 ----
    try:
        today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).strftime('%Y%m%d')
        html = open(IDX_HTML, encoding='utf-8').read()
        html2 = re.sub(r'(/data/high_low_data\.js\?v=)\d+', lambda m: m.group(1) + today, html)
        if html2 != html:
            open(IDX_HTML, 'w', encoding='utf-8').write(html2)
            print('index.html 数据版本已更新为', today)
    except Exception as e:
        print('index.html 版本更新失败(可忽略):', e)

    print('OK: 追加 %d 个交易日 %s ~ %s，现共 %d 日，最新 %s'
          % (n, tail['date'].iloc[0], tail['date'].iloc[-1], len(dates), cur['last_date']))
    print('最新值 high60=%d low60=%d high120=%d low120=%d'
          % (series['high60']['values'][-1], series['low60']['values'][-1],
             series['high120']['values'][-1], series['low120']['values'][-1]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
