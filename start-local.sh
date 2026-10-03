#!/bin/bash
# ============================================================
# RPA 门户本地服务器启动脚本(仅网页端)
# 浏览器(本机/局域网) -> server.js -> 控制各电脑上的 bot(IP:18810)
# 说明:本脚本只启动网页端;bot 请在对应电脑上手动启动
# 用法: ./start-local.sh   (或双击)
# 停止: Ctrl+C
# ============================================================
set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR"

# ---------- 运行环境 ----------
# 不绑定具体 node 版本:优先用当前 PATH,找不到时尝试 nvm 最新安装目录
if ! command -v node >/dev/null 2>&1; then
  NODE_BIN=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V 2>/dev/null | tail -1)
  [ -n "$NODE_BIN" ] || NODE_BIN=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)
  [ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "错误: 未找到 node/npm,请先安装 Node.js 18+ 并确保在 PATH 中"
  exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  echo "错误: 当前 Node.js $(node -v 2>/dev/null) 版本过低,需要 Node.js 18+"
  exit 1
fi

# 星系核目录(仅用于兜底读取 token / 本机 bot 启动);网站单独部署时可用 GALAXY_DIR 覆盖
GALAXY="${GALAXY_DIR:-$HOME/Desktop/飞书多维表格管理工具星系核}"
[ -d "$GALAXY/venv/bin" ] && export PATH="$GALAXY/venv/bin:$PATH"

# ---------- 读取 .env 中的单个值(不 source,避免特殊字符问题) ----------
read_env_value() {
  local file="$1" key="$2" line
  [ -f "$file" ] || return 0
  line=$(grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | tail -1) || return 0
  [ -n "$line" ] || return 0
  line=${line#*=}
  line=$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  case "$line" in
    \"*\") line=${line#\"}; line=${line%\"} ;;
    \'*\') line=${line#\'}; line=${line%\'} ;;
    *) line=$(printf '%s' "$line" | sed -e 's/[[:space:]]#.*$//' -e 's/[[:space:]]*$//') ;;
  esac
  printf '%s' "$line"
}

# ---------- 端口与局域网地址 ----------
# 与 server/lib/config.js 保持一致:未指定 RPA_ENV_FILE 时,项目根 .env 和 server/.env 都读
if [ -n "${RPA_ENV_FILE:-}" ]; then
  ENV_FILES=("$RPA_ENV_FILE")
else
  ENV_FILES=("$SCRIPT_DIR/.env" "$SCRIPT_DIR/server/.env")
fi

read_first_env_value() {
  local key="$1" value file
  for file in "${ENV_FILES[@]}"; do
    value=$(read_env_value "$file" "$key")
    [ -n "$value" ] && { printf '%s' "$value"; return 0; }
  done
  return 0
}

PORT_VALUE="${EXCEL_SERVER_PORT:-}"
[ -n "$PORT_VALUE" ] || PORT_VALUE=$(read_first_env_value EXCEL_SERVER_PORT)
PORT_VALUE="${PORT_VALUE:-5055}"

collect_local_ips() {
  if command -v ipconfig >/dev/null 2>&1; then
    for iface in $(ifconfig -l 2>/dev/null); do
      ipconfig getifaddr "$iface" 2>/dev/null || true
    done
  fi
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' || true
  fi
  if command -v ip >/dev/null 2>&1; then
    ip -4 addr show 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 || true
  fi
}
LOCAL_IPS=$(collect_local_ips | awk 'NF && $1 != "127.0.0.1" && $1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/' | sort -u)

# 优先使用已导出的 ALLOWED_ORIGINS,其次读项目 .env,最后自动加入本机所有 IPv4
ENV_ALLOWED_ORIGINS=$(read_first_env_value ALLOWED_ORIGINS)
if [ -n "${ALLOWED_ORIGINS:-}" ]; then
  ORIGINS="$ALLOWED_ORIGINS"
elif [ -n "$ENV_ALLOWED_ORIGINS" ]; then
  ORIGINS="$ENV_ALLOWED_ORIGINS"
else
  ORIGINS="http://localhost:$PORT_VALUE,http://127.0.0.1:$PORT_VALUE"
  for ip in $LOCAL_IPS; do
    ORIGINS="$ORIGINS,http://$ip:$PORT_VALUE"
  done
fi
export ALLOWED_ORIGINS="$ORIGINS"

# ---------- 控制接口鉴权 ----------
# 优先级: 已导出的环境变量 > 项目根 .env / server/.env(RPA_ENV_FILE) > 星系核 .env
if [ -z "${RPA_CONTROL_TOKEN:-}" ]; then
  RPA_CONTROL_TOKEN=$(read_first_env_value RPA_CONTROL_TOKEN)
fi
if [ -z "${RPA_CONTROL_TOKEN:-}" ] && [ -f "$GALAXY/.env" ]; then
  RPA_CONTROL_TOKEN=$(read_env_value "$GALAXY/.env" RPA_CONTROL_TOKEN)
fi
if [ -z "${RPA_CONTROL_TOKEN:-}" ]; then
  echo "错误: 未找到 RPA_CONTROL_TOKEN,门户无法控制任何 bot。"
  echo "  方式1: 在项目根 .env 或 server/.env 中写入 RPA_CONTROL_TOKEN=<与 bot 一致的 token>"
  echo "  方式2: 先执行 export RPA_CONTROL_TOKEN=<与 bot 一致的 token>"
  echo "  方式3: 在 $GALAXY/.env 中配置 RPA_CONTROL_TOKEN"
  exit 1
fi
export RPA_CONTROL_TOKEN

# ---------- 启动 server(仅网页端;bot 不自动启动) ----------
[ -d "$SCRIPT_DIR/dist" ] || echo "警告: 未找到 dist 构建产物,浏览器将打不开页面;请先执行 npm install && npm run build"

echo "== 启动 RPA 门户(仅网页端) =="
echo "   本机访问      = http://127.0.0.1:$PORT_VALUE"
for ip in $LOCAL_IPS; do
  echo "   局域网访问    = http://$ip:$PORT_VALUE"
done
echo "   bot 请在对应电脑上手动启动: cd <星系核目录> && venv/bin/python bot.py"
echo "   提示: 远程 bot 无法通过本页面「启动 bot」按钮启动"
echo "   停止: Ctrl+C"
echo
EXCEL_SERVER_PORT="$PORT_VALUE" npm run server
