#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
构建标签数据：data/tag_system.json (完整原始体系) + data/stock_tags.js (前端精简查表)
=================================================================================
输入: 原始「板块与个股标签体系.json」
输出:
  1) data/tag_system.json  —— 完整原始 JSON，作为标签体系唯一真源，供后续功能使用
  2) data/stock_tags.js    —— 前端懒加载的精简查表（字典+下标，约 250KB，gzip 后 ~60KB）
     结构:
       window.TAG_META  = {generated, stocks, labels, dictSize}
       window.TAG_ATTR  = ["核心锚","中军","弹性","跟风","边缘"]      // 属性字典
       window.TAG_DICT  = ["母线|一级簇|二级簇", ...]                 // 簇字典(下标即 id)
       window.STOCK_TAGS= {"000001":[[12,1],[45,1],...], ...}         // 每只股票的 [簇id, 属性id]
  3) data/stock_names.js   —— 代码 <-> 名称 索引（约 110KB），供「输入代码或名称」添加股票时查询
     结构:
       window.STOCK_NAME_META = {generated, count}
       window.STOCK_NAMES     = {"600519":"贵州茅台", ...}
用法: python scripts/build_stock_tags.py [原始json路径]
依赖: 无（标准库）
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))
OUT_FULL = os.path.join(ROOT, 'data', 'tag_system.json')
OUT_JS = os.path.join(ROOT, 'data', 'stock_tags.js')
OUT_NAMES = os.path.join(ROOT, 'data', 'stock_names.js')

DEFAULT_SRC = (r'c:\Users\28670\.trae-cn\attachments\6a1bafa1d33f96294df4bab3'
               r'\992fc963-d39e-44fb-b399-9c82b14f1125_ed02dd4e-8bc8-49f3-8223-697d9582c6f4'
               r'_板块与个股标签体系.json')


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    if not os.path.isfile(src):
        print('找不到源文件:', src)
        return 2
    with open(src, encoding='utf-8') as f:
        d = json.load(f)

    meta = d.get('meta', {})
    stocks = d.get('个股', {})
    print('源文件: 概念板块 %d / 三级行业板块 %d / 个股 %d'
          % (len(d.get('概念板块', {})), len(d.get('三级行业板块', {})), len(stocks)))

    ATTRS = ['核心锚', '中军', '弹性', '跟风', '边缘']
    attr_id = {a: i for i, a in enumerate(ATTRS)}

    cluster_id = {}
    clusters = []
    out = {}
    n_labels = 0
    skipped_attr = 0
    attr_seen = {}
    bus_seen = {}

    for code, obj in stocks.items():
        labels = (obj or {}).get('标签') or []
        arr = []
        for L in labels:
            bus = (L.get('母线') or '').strip()
            l1 = (L.get('一级簇') or '').strip()
            l2 = (L.get('二级簇') or '').strip()
            attr = (L.get('二级簇属性') or '').strip()
            if not l2 or not attr:
                skipped_attr += 1
                continue
            ai = attr_id.get(attr)
            if ai is None:
                ATTRS.append(attr)
                ai = attr_id[attr] = len(ATTRS) - 1
            key = bus + '|' + l1 + '|' + l2
            ci = cluster_id.get(key)
            if ci is None:
                ci = cluster_id[key] = len(clusters)
                clusters.append(key)
            arr.append([ci, ai])
            n_labels += 1
            attr_seen[attr] = attr_seen.get(attr, 0) + 1
            bus_seen[bus] = bus_seen.get(bus, 0) + 1
        if arr:
            out[code] = arr

    print('写入标签条数: %d（跳过缺属性 %d）' % (n_labels, skipped_attr))
    print('簇字典: %d 条；属性分布: %s' % (len(clusters), attr_seen))
    print('母线数: %d' % len(bus_seen))

    # 1) 完整原始 JSON
    os.makedirs(os.path.dirname(OUT_FULL), exist_ok=True)
    with open(src, encoding='utf-8') as f:
        raw = f.read()
    with open(OUT_FULL, 'w', encoding='utf-8') as f:
        f.write(raw)
    print('已保存完整体系 -> data/tag_system.json (%.1f MB)' % (os.path.getsize(OUT_FULL) / 1048576.0))

    # 2) 前端精简查表
    jmeta = {
        'generated': meta.get('生成时间', ''),
        'snapshot': meta.get('行情快照', ''),
        'stocks': len(out),
        'labels': n_labels,
        'clusters': len(clusters),
        'spec_note': meta.get('计分口径', {}).get('板块特异性', '')
    }
    js = ('// 个股标签查表（由 scripts/build_stock_tags.py 自动生成，勿手改）\n'
          '// 完整标签体系见 data/tag_system.json；本文件仅提供个股 -> 簇 的最简查表\n'
          'window.TAG_META=' + json.dumps(jmeta, ensure_ascii=False, separators=(',', ':')) + ';\n'
          'window.TAG_ATTR=' + json.dumps(ATTRS, ensure_ascii=False, separators=(',', ':')) + ';\n'
          'window.TAG_DICT=' + json.dumps(clusters, ensure_ascii=False, separators=(',', ':')) + ';\n'
          'window.STOCK_TAGS=' + json.dumps(out, ensure_ascii=False, separators=(',', ':')) + ';\n')
    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write(js)
    print('已生成前端查表 -> data/stock_tags.js (%.0f KB)' % (os.path.getsize(OUT_JS) / 1024.0))

    # 3) 代码 <-> 名称 索引（供添加股票时"输入代码或名称"解析）
    codes = {}
    dup = 0
    for code, obj in stocks.items():
        nm = ((obj or {}).get('名称') or '').strip()
        if not nm:
            continue
        if nm in codes and codes[nm] != code:
            dup += 1          # 同名(如 A/B 股)，保留先出现的
            continue
        codes[nm] = code
    names = {c: ((stocks[c] or {}).get('名称') or '').strip() for c in stocks}
    njs = ('// 股票代码 <-> 名称 索引（由 scripts/build_stock_tags.py 自动生成，勿手改）\n'
           'window.STOCK_NAME_META=' + json.dumps(
               {'generated': meta.get('生成时间', ''), 'count': len(names)}, ensure_ascii=False,
               separators=(',', ':')) + ';\n'
           'window.STOCK_NAMES=' + json.dumps(names, ensure_ascii=False, separators=(',', ':')) + ';\n'
           'window.STOCK_NAME2CODE=' + json.dumps(codes, ensure_ascii=False, separators=(',', ':')) + ';\n')
    with open(OUT_NAMES, 'w', encoding='utf-8') as f:
        f.write(njs)
    print('已生成代码名称索引 -> data/stock_names.js (%.0f KB, %d 只, 重名跳过 %d)'
          % (os.path.getsize(OUT_NAMES) / 1024.0, len(names), dup))
    return 0


if __name__ == '__main__':
    sys.exit(main())
