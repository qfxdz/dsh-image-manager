#!/usr/bin/env bash
# ============================================================
# 把仓库里的 OWNER 占位符换成你的 GitHub 账号。
#
#   bash set-owner.sh <GitHub用户名> [仓库名]
#
# 会改这三个文件里的链接：package.json（repository/homepage/bugs）、
# README.md / README.en.md（CI badge）、CHANGELOG.md（版本比较链接）。
# ============================================================
set -euo pipefail

OWNER="${1:-}"
REPO="${2:-dsh-image-manager}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$OWNER" ]; then
  echo "用法: bash set-owner.sh <GitHub用户名> [仓库名]" >&2
  exit 1
fi

NEW="https://github.com/$OWNER/$REPO"
FILES=("$ROOT/package.json" "$ROOT/README.md" "$ROOT/README.en.md" "$ROOT/CHANGELOG.md")

changed=0
for file in "${FILES[@]}"; do
  [ -f "$file" ] || continue
  if grep -q "OWNER/dsh-image-manager" "$file" 2>/dev/null; then
    sed -i "s#https://github.com/OWNER/dsh-image-manager#$NEW#g; s#git+https://github.com/OWNER/dsh-image-manager.git#git+$NEW.git#g; s#OWNER/dsh-image-manager#$OWNER/$REPO#g" "$file"
    echo "== 已更新 $(basename "$file")"
    changed=1
  fi
done

if [ "$changed" = "0" ]; then
  echo "== 没有找到 OWNER 占位符（可能已经设置过）"
fi

echo "== 完成：仓库地址 = $NEW"
