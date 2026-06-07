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

    # 2. 找到最新诊断JSON
    diag_dir = os.path.join(SKILL_DIR, 'output', 'diagnosis')
    if not os.path.isdir(diag_dir):
        print('诊断目录不存在: ' + diag_dir)
        return
    diag_files = sorted([f for f in os.listdir(diag_dir) if f.startswith('diagnosis_') and f.endswith('.json')], reverse=True)
    if not diag_files:
        print('无诊断结果文件')
        return
    latest_diag = os.path.join(diag_dir, diag_files[0])
    print(f'  最新诊断: {latest_diag}')

    # 3. 加载诊断结果，提取精选池
    print('\n--- Step 2: 提取精选池 ---')
    with open(latest_diag, 'r', encoding='utf-8') as f:
        diag_data = json.load(f)
    
    all_results = diag_data.get('results', [])
    print(f'  板块总数: {len(all_results)}')

    gold, silver, watch, blacklist = [], [], [], []

    for r in all_results:
        name = r.get('name', '')
        stage = r.get('stage', 0)
        confidence = r.get('confidence', 'low')
        sub_type = r.get('sub_type', '')
        score = r.get('score', 0)
        reasons = r.get('reasons', [])

        entry = {
            'name': name,
            'stage': stage,
            'confidence': confidence,
            'sub_type': sub_type,
            'score': score,
            'reasons': reasons[:3]
        }

        if stage == 2 and confidence == 'high' and '洗盘' in sub_type:
            gold.append(entry)
        elif stage == 2 and confidence == 'high':
            silver.append(entry)
        elif stage == 1 and confidence == 'high' and any('背离' in r or '金叉' in r for r in reasons):
            watch.append(entry)
        elif stage == 4 and confidence == 'high':
            blacklist.append(entry)

    pools = {
        'updated': now.strftime('%Y-%m-%d %H:%M:%S'),
        'gold': gold[:10],
        'silver': silver[:10],
        'watch': watch[:20],
        'blacklist': blacklist[:20]
    }

    print(f'  金牌: {len(gold)} | 银牌: {len(silver)} | 观察: {len(watch)} | 黑名单: {len(blacklist)}')

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
