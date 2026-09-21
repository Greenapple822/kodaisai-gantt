#!/bin/sh
# 予定を直したあと、これ1つで全員の画面に反映する。
#
#     sh tools/publish.sh
#
# やっていること：
#   1. data/schedule.csv から dist/ と docs/ を作り直す
#   2. 変更を git に記録する
#   3. GitHub に送る（1〜2分で公開ページが新しくなる）

set -e
cd "$(dirname "$0")/.."

echo "== 1/3 図を作り直しています =="
python3 tools/build.py

if [ -z "$(git status --porcelain)" ]; then
  echo "変更はありません。公開ページはすでに最新です。"
  exit 0
fi

echo "== 2/3 変更を記録しています =="
git add -A
git commit -m "${1:-予定を更新}"

echo "== 3/3 GitHub に送っています =="
git push

echo
echo "== 公開されるまで待っています（1〜2分）=="
HEAD=$(git rev-parse HEAD)
i=0
while [ $i -lt 20 ]; do
  STATE=$(gh api repos/{owner}/{repo}/pages/builds/latest --jq '.status + " " + .commit' 2>/dev/null || echo "")
  case "$STATE" in
    "built $HEAD") echo "公開されました。"; break ;;
    "errored"*) echo "GitHub 側のビルドが失敗しました。リポジトリの Actions を見てください。"; break ;;
  esac
  sleep 10
  i=$((i + 1))
done

echo
git remote get-url origin | sed -E 's#.*github.com[:/]([^/]+)/(.+)\.git#https://\1.github.io/\2/#'
echo "（部員にはこのURLを渡してください）"
