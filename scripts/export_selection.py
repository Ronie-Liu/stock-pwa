# -*- coding: utf-8 -*-
"""
盘后自动化：SKILL全量输出 → 导出到GitHub → PWA可用
用法（每天16:00 SCHEDULED自动执行或手动）:
  py scripts\export_selection.py
"""
import os, sys, json, subprocess, shutil
from datetime import datetime, timezone, timedelta

CST = timezone(timedelta(hours=8))
SKILL_DIR = r'C:\Users\28670\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6a238975ffa592d9af446a8b\a-share-sector-collector'
DIAG_DIR = os.path.join(SKILL_DIR, 'output', 'diagnosis')
GIT_DIR = r'c:\Users\28670\.trae-cn\work\6a1bafa1d33f96294df4bab3\stock-pwa-test2'
DATA_DIR = os.path.join(GIT_DIR, 'data')

def run_cmd(cmd, cwd=None):
    print(f'  RUN: {cmd}')
    r = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        print(f'   ERR: {r.stderr.strip()[:300]}')
    print(f'   OUT: {r.stdout.strip()[-200:]}')
    return r.returncode == 0

def main():
    now = datetime.now(CST)
    print(f'[{now.strftime("%Y-%m-%d %H:%M:%S")}] 开始盘后导出')

    # 1. 跑SKILL诊断（确保数据是最新的）
    print('\n--- Step 1: SKILL诊断 ---')
    if not run_cmd('py -m ashare_sectors diagnose -o ./output/daily', cwd=SKILL_DIR):
        print('诊断可能已存在，继续...')

    # 2. 找到最新诊断和精选池文件
    diag_files = {k: sorted([f for f in os.listdir(DIAG_DIR) if f.startswith(k) and f.endswith('.json')], reverse=True) for k in ['diagnosis_', 'selection_']}
    
    if not diag_files['diagnosis_'] or not diag_files['selection_']:
        print('缺少诊断或精选池文件')
        return

    latest_diag = os.path.join(DIAG_DIR, diag_files['diagnosis_'][0])
    latest_sel = os.path.join(DIAG_DIR, diag_files['selection_'][0])
    print(f'  诊断: {diag_files["diagnosis_"][0]} ({os.path.getsize(latest_diag)/1024:.0f}KB)')
    print(f'  精选: {diag_files["selection_"][0]} ({os.path.getsize(latest_sel)/1024:.0f}KB)')

    # 3. 生成板块诊断摘要（轻量版，给PWA用）
    print('\n--- Step 2: 生成轻量诊断摘要 ---')
    with open(latest_diag, 'r', encoding='utf-8') as f:
        diag_data = json.load(f)

    results = diag_data.get('results', [])
    summary = {}
    for r in results:
        name = r.get('name', '')
        if not name:
            continue
        summary[name] = {
            's': r.get('stage', 0),
            'sn': r.get('stage_name', ''),
            'st': r.get('sub_type', ''),
            'c': r.get('confidence', 'low'),
            'rs': r.get('reasons', [])[:3],
            'sc': r.get('score', 0)
        }

    summary_path = os.path.join(DATA_DIR, 'sector_diagnosis.json')
    os.makedirs(DATA_DIR, exist_ok=True)
    summary_data = {
        'updated': now.strftime('%Y-%m-%d %H:%M:%S'),
        'total': len(summary),
        'sectors': summary
    }
    with open(summary_path, 'w', encoding='utf-8') as f:
        json.dump(summary_data, f, ensure_ascii=False, separators=(',', ':'))
    orig_kb = os.path.getsize(latest_diag) / 1024
    new_kb = os.path.getsize(summary_path) / 1024
    print(f'  诊断摘要: {new_kb:.0f}KB (原{orig_kb:.0f}KB) | {len(summary)}板块')

    # 4. 复制精选池
    print('\n--- Step 3: 导出精选池 ---')
    with open(latest_sel, 'r', encoding='utf-8') as f:
        sel_data = json.load(f)
    pools_raw = sel_data.get('pools', {})
    pools = {
        'updated': now.strftime('%Y-%m-%d %H:%M:%S'),
        'gold': pools_raw.get('gold', [])[:10],
        'silver': pools_raw.get('silver', [])[:10],
        'watch': pools_raw.get('watch', [])[:20],
        'blacklist': pools_raw.get('blacklist', [])[:20]
    }
    pool_path = os.path.join(DATA_DIR, 'selection_pools.json')
    with open(pool_path, 'w', encoding='utf-8') as f:
        json.dump(pools, f, ensure_ascii=False, indent=2)
    print(f'  🥇{len(pools["gold"])} 🥈{len(pools["silver"])} 👀{len(pools["watch"])} 🚫{len(pools["blacklist"])}')

    # 5. 推送GitHub
    print('\n--- Step 4: 推送GitHub ---')
    cnt = len(pools['gold']) + len(pools['silver']) + len(pools['watch']) + len(pools['blacklist'])
    run_cmd('git add data/', cwd=GIT_DIR)
    run_cmd(f'git commit -m "盘后数据更新 {now.strftime("%m/%d")} 诊断{len(summary)}板块 精选{cnt}只"', cwd=GIT_DIR)
    run_cmd('git push origin main', cwd=GIT_DIR)

    print(f'\n[{datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")}] 完成!')

if __name__ == '__main__':
    main()
