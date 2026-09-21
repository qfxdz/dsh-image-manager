#!/usr/bin/env bash
# ============================================================
# dsh-image-manager 安装 / 生效脚本（幂等）
#
#   1) 把本目录作为 bundle 装进 dsh profile（已装则跳过）
#   2) 重启 dsh web（新装的 bundle 不会热加载）
#   3) 自检 HTTP 接口是否挂载
#
# 用法: ./install.sh [日志路径]     默认 /tmp/dsh-image-manager-install.log
# 环境: DSH_DIR(dsh 安装目录，默认依次尝试 $DSH_DIR、$HOME/dsh、PATH 里的 dsh)
#       DSH_PROFILE(默认 web) DSH_HOME(默认 ~/.dsh)
# ============================================================
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 定位 dsh 安装目录：显式 $DSH_DIR > $HOME/dsh > PATH 中 dsh 的上一级
if [ -z "${DSH_DIR:-}" ]; then
  if [ -x "$HOME/dsh/node_modules/.bin/dsh" ]; then
    DSH_DIR="$HOME/dsh"
  elif command -v dsh >/dev/null 2>&1; then
    DSH_DIR="$(cd "$(dirname "$(command -v dsh)")/.." && pwd)"
  else
    DSH_DIR="$HOME/dsh"
  fi
fi
PROFILE="${DSH_PROFILE:-web}"
HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
LOG="${1:-/tmp/dsh-image-manager-install.log}"
MANIFEST="$HOME_DIR/profiles/$PROFILE/package.json"

exec >>"$LOG" 2>&1
echo "===== $(date '+%F %T') dsh-image-manager install start ====="

if [ ! -x "$DSH_DIR/node_modules/.bin/dsh" ]; then
  echo "!! 找不到 dsh: $DSH_DIR/node_modules/.bin/dsh"
  echo "!! 请用 DSH_DIR=/path/to/dsh 指定 dsh 安装目录后重试"
  exit 1
fi

if grep -q '"dsh-image-manager"' "$MANIFEST" 2>/dev/null; then
  echo "== 依赖已存在，跳过 pnpm add"
else
  echo "== 安装到 profile $PROFILE"
  "$DSH_DIR/node_modules/.bin/dsh" plugin --profile "$PROFILE" add "$PLUGIN_DIR" || {
    echo "!! 安装失败"
    exit 1
  }
fi

echo "== 重启 dsh"
"$DSH_DIR/stop.sh" || true
sleep 2
"$DSH_DIR/start.sh" || true

CODE=000
for _ in $(seq 1 45); do
  sleep 2
  CODE="$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:2001/dsh-image-manager/api/sessions || true)"
  [ "$CODE" = "200" ] && break
done
echo "== 自检 /dsh-image-manager/api/sessions -> HTTP $CODE"

if [ "$CODE" = "200" ]; then
  echo "== 安装成功：侧边栏会出现「图片」入口，会话头部会出现「图片上限」输入框"
else
  echo "!! 接口未就绪：查看 $DSH_DIR/logs/dsh.log 与 dsh 自身日志；"
  echo "!! 如需回滚：dsh plugin --profile $PROFILE remove dsh-image-manager && $DSH_DIR/start.sh"
fi
echo "===== $(date '+%F %T') dsh-image-manager install done ====="
