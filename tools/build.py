#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CSV / JSON / CSS / JS を 1枚の HTML に埋め込んで dist/ を出力する。

    python3 tools/build.py

出力は3つ。どれも data/schedule.csv から生成される（単一データソース）。
  dist/index.html     配布用。ダブルクリックで開く。これだけ配れば動く
  docs/index.html     GitHub Pages が配信するファイル。中身は dist/index.html と同じ
  dist/artifact.html  claude.ai で共有するとき用の断片。<html>/<head>/<body> を持たない

標準ライブラリしか使わない。Node.js も npm も要らない。
file:// で開くと fetch() が CORS に阻まれるため、配布物は必ずこれで作ること。
"""

import datetime
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src')
DATA = os.path.join(ROOT, 'data')
DIST = os.path.join(ROOT, 'dist')
DOCS = os.path.join(ROOT, 'docs')      # GitHub Pages の公開フォルダ


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def js_literal(value):
    """HTML の <script> の中に置いても壊れない JavaScript リテラルにする。"""
    text = json.dumps(value, ensure_ascii=False)
    # </script> や <!-- で HTML パーサに切られないようにエスケープする
    for ch, esc in (('<', '\\u003c'), ('>', '\\u003e'), ('&', '\\u0026'),
                    (' ', '\\u2028'), (' ', '\\u2029')):
        text = text.replace(ch, esc)
    return text


def sub_once(pattern, replacement, text, label):
    new, count = re.subn(pattern, lambda _m: replacement, text, flags=re.DOTALL)
    if count != 1:
        sys.exit('ビルド中断: %s の目印が %d 個見つかりました（1個であるべき）。'
                 'src/index.html を確認してください。' % (label, count))
    return new


def main():
    schedule = read(os.path.join(DATA, 'schedule.csv'))
    layout = json.loads(read(os.path.join(DATA, 'layout.json')))
    share = {}
    share_path = os.path.join(DATA, 'share.json')
    if os.path.exists(share_path):          # 無くても動く。その場合は共有保存を使わない。
        share = json.loads(read(share_path))
    css = read(os.path.join(SRC, 'style.css'))
    js = read(os.path.join(SRC, 'app.js'))
    html = read(os.path.join(SRC, 'index.html'))

    # 新しい版が出たことを画面が気づくための印
    build_id = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    payload = js_literal({'schedule': schedule, 'layout': layout, 'share': share,
                          'build': build_id})

    html = sub_once(r'<link rel="stylesheet" href="style\.css">',
                    '<style>\n' + css + '\n</style>', html, 'style.css の link')
    html = sub_once(r'<!--\s*BUILD:STYLE\s*-->', '', html, 'BUILD:STYLE')

    html = sub_once(r'/\* BUILD:DATA_START \*/.*?/\* BUILD:DATA_END \*/',
                    'window.EMBEDDED_DATA = ' + payload + ';', html, 'BUILD:DATA')

    html = sub_once(r'<script src="app\.js"></script>',
                    '<script>\n' + js + '\n</script>', html, 'app.js の script')
    html = sub_once(r'<!--\s*BUILD:SCRIPT\s*-->', '', html, 'BUILD:SCRIPT')

    # 外部ファイルへの参照が残っていたら、配れば動く状態になっていない
    leftovers = re.findall(r'(?:src|href)="(?!https?:|#)([^"]+)"', html)
    if leftovers:
        sys.exit('ビルド中断: 外部ファイル参照が残っています: %s' % ', '.join(leftovers))
    if 'fetch(' in html and 'window.EMBEDDED_DATA' not in html:
        sys.exit('ビルド中断: データが埋め込まれていません。')

    if not os.path.isdir(DIST):
        os.makedirs(DIST)
    out = os.path.join(DIST, 'index.html')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(html)

    rows = max(0, len([ln for ln in schedule.splitlines() if ln.strip()]) - 1)
    print('dist/index.html を出力しました（%.1f KB, CSV %d行, エリア %d箇所）'
          % (os.path.getsize(out) / 1024.0, rows, len(layout.get('areas', []))))
    print('ダブルクリックで開けます: %s' % out)

    # GitHub Pages はこのフォルダをそのまま配信する。中身は配布版と同一。
    if not os.path.isdir(DOCS):
        os.makedirs(DOCS)
    site = os.path.join(DOCS, 'index.html')
    with open(site, 'w', encoding='utf-8') as f:
        f.write(html)
    print('docs/index.html を出力しました（GitHub Pages 用）')

    art = write_artifact(html, os.path.join(DATA, 'schedule.csv'))
    print('dist/artifact.html を出力しました（%.1f KB）'
          % (os.path.getsize(art) / 1024.0))
    print('リンク共有ページを更新するときはこれを差し替えます。')


def write_artifact(html, csv_path):
    """公開ページ用に、外側の <html>/<head>/<body> を外した断片を書き出す。

    中身は dist/index.html と同一。データも見た目も二重に持たない。
    """
    def pick(pattern, label):
        m = re.search(pattern, html, re.DOTALL)
        if not m:
            sys.exit('ビルド中断: 公開用ページの %s を取り出せませんでした。' % label)
        return m.group(0) if label != 'body' else m.group(1)

    title = pick(r'<title>.*?</title>', 'title')
    style = pick(r'<style>.*?</style>', 'style')
    body = pick(r'<body[^>]*>(.*)</body>', 'body')

    # 部内向けの再ビルド手順は、リンクで見る人には関係がないので差し替える
    stamp = datetime.datetime.fromtimestamp(os.path.getmtime(csv_path)).strftime('%Y/%m/%d %H:%M')
    body = re.sub(
        r'<footer[^>]*>.*?</footer>',
        '<footer class="no-print">放送研究会　工大祭ステージ企画　／　'
        'データ更新：' + stamp + '　／　'
        '内容を直すときは部内の schedule.csv を編集してこのページを差し替えてください。</footer>',
        body, flags=re.DOTALL)

    out = os.path.join(DIST, 'artifact.html')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(title + '\n' + style + '\n' + body.strip() + '\n')
    return out


if __name__ == '__main__':
    main()
