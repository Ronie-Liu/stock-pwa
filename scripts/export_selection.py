# -*- coding: utf-8 -*-
"""
盘后自动化：运行SKILL精选池 → 导出JSON → 推送到GitHub
用法（Windows Task Scheduler 每天15:35执行）:
  py export_selection.py
"""
import os, sys, json, subprocess, shutil
from datetime import datetime, timezone, timedelta

CST = timezone(timedelta(hours=8))
SKILL_DIR = r'C:\Users\28670\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6a238975ffa592d9af446a8b\a-share-sector-collector'
GIT_DIR = r'c:\Users\28670\.trae-cn\work\6a1bafa1d33f96294df4bab3\stock-pwa-test2'
OUTPUT_FILE = 'data/selection_pools.json'

def run_cmd(cmd, cwd=None):
    print(f'  RUN: {cmd}')
    r = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        print(f'   STDERR: {r.stderr.strip()[:300]}')
    print(f'   STDOUT: {r.stdout.strip()[-300:]}')
    return r.returncode == 0

def main():
    now = datetime.now(CST)
    print(f'[{now.strftime("%Y-%m-%d %H:%M:%S")}] 开始盘后精选池导出')

    # 1. 运行SKILL全量诊断
    print('\n--- Step 1: 诊断 ---')
    if not run_cmd('py -m ashare_sectors diagnose -o ./output/daily', cwd=SKILL_DIR):
        print('诊断失败，但尝试继续...')

    # 2. 找到SKILL自己生成的精选池JSON（格式完美，直接用）
    sel_dir = os.path.join(SKILL_DIR, 'output', 'diagnosis')
    if not os.path.isdir(sel_dir):
        print('目录不存在: ' + sel_dir)
        return
    sel_files = sorted([f for f in os.listdir(sel_dir) if f.startswith('selection_') and f.endswith('.json')], reverse=True)
    if not sel_files:
        print('无精选池文件')
        return
    latest_sel = os.path.join(sel_dir, sel_files[0])
    print(f'  最新精选池: {latest_sel}')

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

    print(f'  🥇金牌: {len(pools["gold"])} | 🥈银牌: {len(pools["silver"])} | 👀观察: {len(pools["watch"])} | 🚫黑名单: {len(pools["blacklist"])}')

    # 4. 写入stock-pwa仓库
    output_path = os.path.join(GIT_DIR, OUTPUT_FILE)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(pools, f, ensure_ascii=False, indent=2)
    print(f'  已写入: {output_path}')

    # 5. Git提交推送
    print('\n--- Step 3: 推送GitHub ---')
    run_cmd(f'git add {OUTPUT_FILE}', cwd=GIT_DIR)
    run_cmd(f'git commit -m "盘后精选池更新 {now.strftime("%m/%d")}"', cwd=GIT_DIR)
    run_cmd('git push origin main', cwd=GIT_DIR)

    print(f'\n[{datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")}] 完成!')

if __name__ == '__main__':
    main()
