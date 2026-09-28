#!/usr/bin/env bash
# Relay Service macOS 一键安装脚本 (Homebrew + Node + Redis + LaunchAgent)
# 适用: macOS 12+
# 用法: bash install-macos.sh [安装目录] [端口]
#   例: bash install-macos.sh "$HOME/relay-service" 3000
#
# 注意:
# - 请使用普通用户运行，不要 sudo。Homebrew 与 LaunchAgent 均按当前用户安装/启动。
# - 默认安装到 ~/relay-service，服务随当前用户登录自动启动。

set -euo pipefail

INSTALL_DIR="${1:-$HOME/relay-service}"
PORT="${2:-3000}"
NODE_MAJOR=20
SERVICE_LABEL="com.relay-service.app"
REDIS_LABEL="com.relay-service.redis"
REPO_URL="${REPO_URL:-https://github.com/zhouzh528/llm-relay-service.git}"  # 可用环境变量覆盖

LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
SUPPORT_DIR="$HOME/Library/Application Support/Relay Service"
SERVICE_PLIST="${LAUNCH_AGENT_DIR}/${SERVICE_LABEL}.plist"
REDIS_PLIST="${LAUNCH_AGENT_DIR}/${REDIS_LABEL}.plist"
REDIS_DIR="${SUPPORT_DIR}/redis"
REDIS_CONF="${REDIS_DIR}/redis.conf"
REDIS_LOG="${REDIS_DIR}/redis.log"

BLUE=$'\033[0;34m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'
CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; NC=$'\033[0m'
log()  { echo "${BLUE}[*]${NC} $*"; }
ok()   { echo "${GREEN}[✓]${NC} $*"; }
warn() { echo "${YELLOW}[!]${NC} $*"; }
die()  { echo "${RED}[✗]${NC} $*" >&2; exit 1; }

tty_ok() { { : </dev/tty; } 2>/dev/null && { : >/dev/tty; } 2>/dev/null; }

show_logo() {
  local W=$'\033[38;2;245;245;247m'
  local G=$'\033[38;2;209;213;219m'
  local A=$'\033[38;2;88;166;255m'
  local D=$'\033[38;2;100;100;110m'
  local R=$'\033[0m'
  printf '\n'
  printf '  %s██████╗ ███████╗██╗      █████╗ ██╗   ██╗%s\n' "$W" "$R"
  printf '  %s██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝%s\n' "$W" "$R"
  printf '  %s██████╔╝█████╗  ██║     ███████║ ╚████╔╝ %s\n' "$W" "$R"
  printf '  %s██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝  %s\n' "$G" "$R"
  printf '  %s██║  ██║███████╗███████╗██║  ██║   ██║   %s\n' "$G" "$R"
  printf '  %s╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   %s\n' "$D" "$R"
  printf '\n  %sRelay Service%s %s·%s %smacOS 一键安装向导%s\n\n' "$A$BOLD" "$R" "$DIM" "$R" "$A" "$R"
}

menu() {
  local title=$1; shift
  local -a options=("$@")
  local n=${#options[@]} sel=0 i key key2 key3 seq
  tty_ok || { MENU_CHOICE=0; return; }

  # 标题打印一次；选项区用相对光标(上移 n 行 + 清到屏幕底)就地重画。
  # 不用 tput sc/rc(ESC 7/8 绝对光标保存/恢复)：菜单画在终端底部触发滚动时,
  # 保存的绝对坐标会失效, 导致每次按键都在新位置重画 → 出现重复文案。
  # 相对移动会随内容一起滚动, 始终对齐, 不受滚动影响。
  printf '\n%s%s%s  %s(↑↓ 选择, Enter 确认)%s\n' "$BOLD" "$title" "$NC" "$DIM" "$NC" >/dev/tty
  for ((i=0; i<n; i++)); do
    if (( i == sel )); then
      printf '  %s▸ %s%s\n' "$CYAN" "${options[$i]}" "$NC" >/dev/tty
    else
      printf '    %s\n' "${options[$i]}" >/dev/tty
    fi
  done

  while :; do
    IFS= read -rsn1 key </dev/tty || key=""
    if [[ -z $key ]]; then
      break
    fi
    if [[ $key == $'\e' ]]; then
      # macOS 自带 bash 3.2 不支持小数超时 (-t 0.2 会报 invalid timeout 而失败),
      # 导致方向键转义序列读不到、菜单永远停在第 0 项; 用整数超时兼容 3.2。
      IFS= read -rsn1 -t 1 key2 </dev/tty || key2=""
      IFS= read -rsn1 -t 1 key3 </dev/tty || key3=""
      seq="${key2}${key3}"
      case $seq in
        '[A'|'OA') (( sel > 0 )) && sel=$((sel - 1)) || : ;;
        '[B'|'OB') (( sel < n-1 )) && sel=$((sel + 1)) || : ;;
      esac
    fi
    # 回到选项区起点(上移 n 行)，清除旧选项后重画
    printf '\033[%dA\033[J' "$n" >/dev/tty
    for ((i=0; i<n; i++)); do
      if (( i == sel )); then
        printf '  %s▸ %s%s\n' "$CYAN" "${options[$i]}" "$NC" >/dev/tty
      else
        printf '    %s\n' "${options[$i]}" >/dev/tty
      fi
    done
  done
  MENU_CHOICE=$sel
  printf '\n' >/dev/tty
}

xml_escape() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
          -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

random_hex() {
  local bytes=$1
  openssl rand -hex "$bytes"
}

prepend_homebrew_path() {
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

brew_install_if_missing() {
  local pkg=$1
  if brew list --versions "$pkg" >/dev/null 2>&1; then
    return 0
  fi
  log "安装 ${pkg} (Homebrew)"
  brew install "$pkg"
}

launch_bootout() {
  local label=$1 plist=$2
  launchctl bootout "gui/${UID}" "$plist" >/dev/null 2>&1 \
    || launchctl bootout "gui/${UID}/${label}" >/dev/null 2>&1 \
    || launchctl remove "$label" >/dev/null 2>&1 \
    || true
}

launch_bootstrap() {
  local label=$1 plist=$2
  launch_bootout "$label" "$plist"
  launchctl bootstrap "gui/${UID}" "$plist" >/dev/null 2>&1 || launchctl load "$plist"
  launchctl enable "gui/${UID}/${label}" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/${UID}/${label}" >/dev/null 2>&1 || true
}

sync_env_kv() {
  local key=$1 val=$2 file=${3:-.env} tmp
  tmp=$(mktemp "${TMPDIR:-/tmp}/relay-env.XXXXXX")
  awk -v key="$key" -v val="$val" '
    BEGIN { done = 0 }
    index($0, key "=") == 1 { print key "=" val; done = 1; next }
    { print }
    END { if (!done) print key "=" val }
  ' "$file" >"$tmp"
  mv "$tmp" "$file"
}

find_free_port() {
  local p=${1:-6380}
  while (: >/dev/tcp/127.0.0.1/$p) >/dev/null 2>&1; do
    p=$((p + 1))
  done
  echo "$p"
}

ensure_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || die "此脚本仅支持 macOS"
  [[ $EUID -ne 0 ]] || die "请不要使用 sudo/root 运行；请用普通用户执行: bash install-macos.sh"
}

ensure_homebrew() {
  prepend_homebrew_path
  if command -v brew >/dev/null 2>&1; then
    ok "Homebrew 已存在: $(brew --prefix)"
    return
  fi

  command -v curl >/dev/null 2>&1 || die "缺少 curl，无法安装 Homebrew"
  log "安装 Homebrew (可能需要输入 macOS 登录密码)"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  prepend_homebrew_path
  command -v brew >/dev/null 2>&1 || die "Homebrew 安装后仍不可用，请按 Homebrew 提示配置 PATH 后重试"
  ok "Homebrew: $(brew --prefix)"
}

ensure_base_tools() {
  log "检查基础工具"
  brew_install_if_missing git
  brew_install_if_missing openssl@3
  export PATH="$(brew --prefix openssl@3)/bin:${PATH}"
  ok "Git: $(git --version)"
  ok "OpenSSL: $(openssl version | head -1)"
}

ensure_node() {
  local need_node=1 cur
  if command -v node >/dev/null 2>&1; then
    cur=$(node -v | sed 's/v\([0-9]*\).*/\1/')
    if [[ $cur =~ ^[0-9]+$ ]] && (( cur >= 18 )); then
      need_node=0
      ok "Node 已存在: $(node -v)"
    fi
  fi

  if (( need_node )); then
    log "安装 Node.js ${NODE_MAJOR}.x (Homebrew node@20)"
    brew_install_if_missing "node@${NODE_MAJOR}"
    export PATH="$(brew --prefix "node@${NODE_MAJOR}")/bin:${PATH}"
    command -v node >/dev/null 2>&1 || die "Node 安装后仍不可用"
    ok "Node: $(node -v)"
  fi
}

ensure_claude_code() {
  if command -v claude >/dev/null 2>&1; then
    ok "Claude Code 已存在: $(command -v claude)"
    return
  fi

  log "安装 Claude Code CLI (@anthropic-ai/claude-code)"
  if npm install -g @anthropic-ai/claude-code; then
    command -v claude >/dev/null 2>&1 \
      && ok "Claude Code: $(command -v claude)" \
      || warn "Claude Code 安装完成但 PATH 中找不到 claude；可在 .env 设置 CLAUDE_BIN"
  else
    warn "Claude Code 安装失败，刷新 token 时可能命中 cli_not_found；可稍后手动安装"
  fi
}

setup_redis_new() {
  brew_install_if_missing redis

  REDIS_HOST_USER=127.0.0.1
  REDIS_PORT_USER=$(find_free_port 6380)
  REDIS_PASSWORD_USER=$(random_hex 16)
  mkdir -p "$REDIS_DIR"

  log "新建独立 Redis 实例 (127.0.0.1:${REDIS_PORT_USER})"
  cat >"$REDIS_CONF" <<EOF
bind 127.0.0.1
protected-mode yes
port ${REDIS_PORT_USER}
requirepass ${REDIS_PASSWORD_USER}
dir ${REDIS_DIR}
appendonly yes
appendfsync everysec
daemonize no
supervised no
logfile ""
EOF
  chmod 600 "$REDIS_CONF"

  cat >"$REDIS_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${REDIS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$(command -v redis-server)")</string>
    <string>$(xml_escape "$REDIS_CONF")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$REDIS_DIR")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$REDIS_LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$REDIS_LOG")</string>
</dict>
</plist>
EOF

  launch_bootstrap "$REDIS_LABEL" "$REDIS_PLIST"
  sleep 2

  local pong
  pong=$(redis-cli -h 127.0.0.1 -p "$REDIS_PORT_USER" -a "$REDIS_PASSWORD_USER" --no-auth-warning ping 2>/dev/null || true)
  [[ $pong == PONG ]] \
    && ok "Relay Redis 就绪 (127.0.0.1:${REDIS_PORT_USER})" \
    || die "Relay Redis 启动失败，查看: tail -f '$REDIS_LOG'"
}

setup_redis_existing() {
  brew_install_if_missing redis
  launch_bootout "$REDIS_LABEL" "$REDIS_PLIST"

  log "连接已有 Redis (${REDIS_HOST_USER}:${REDIS_PORT_USER})"
  local -a args=(-h "$REDIS_HOST_USER" -p "$REDIS_PORT_USER")
  [[ -n $REDIS_PASSWORD_USER ]] && args+=(-a "$REDIS_PASSWORD_USER" --no-auth-warning)
  local pong
  pong=$(redis-cli "${args[@]}" ping 2>/dev/null || true)
  [[ $pong == PONG ]] || die "无法连接 Redis，请检查地址/端口/密码"
  ok "已有 Redis 连接成功"
}

write_service_plist() {
  local node_bin service_path home_dir
  node_bin=$(command -v node)
  service_path="$(dirname "$node_bin"):$(brew --prefix)/bin:$(brew --prefix)/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  home_dir="$HOME"

  mkdir -p "$LAUNCH_AGENT_DIR" "$INSTALL_DIR/logs"
  cat >"$SERVICE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node_bin")</string>
    <string>$(xml_escape "${INSTALL_DIR}/src/app.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$INSTALL_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>HOME</key><string>$(xml_escape "$home_dir")</string>
    <key>PATH</key><string>$(xml_escape "$service_path")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "${INSTALL_DIR}/logs/stdout.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "${INSTALL_DIR}/logs/stderr.log")</string>
  <key>SoftResourceLimits</key>
  <dict><key>NumberOfFiles</key><integer>65535</integer></dict>
  <key>HardResourceLimits</key>
  <dict><key>NumberOfFiles</key><integer>65535</integer></dict>
</dict>
</plist>
EOF
}

wait_for_service() {
  local timeout=300 start=$SECONDS elapsed remain
  while :; do
    elapsed=$((SECONDS - start))
    if curl -fsS --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      printf '\r\033[K'
      ok "服务已启动 (用时 $((elapsed / 60))分$((elapsed % 60))秒)"
      return 0
    fi
    if (( elapsed >= timeout )); then
      printf '\r\033[K'
      warn "健康检查 5 分钟超时；查看: tail -f '${INSTALL_DIR}/logs/stderr.log'"
      return 1
    fi
    remain=$((timeout - elapsed))
    printf '\r\033[K%s[*]%s 等待服务就绪 · 已用 %d:%02d · 剩余 %d:%02d' \
      "$BLUE" "$NC" $((elapsed / 60)) $((elapsed % 60)) $((remain / 60)) $((remain % 60))
    sleep 2
  done
}

ADMIN_USERNAME_USER=""
ADMIN_PASSWORD_USER=""
REDIS_MODE=""
REDIS_HOST_USER=""
REDIS_PORT_USER=""
REDIS_PASSWORD_USER=""

ensure_macos
show_logo

if tty_ok; then
  {
    echo "════════════════════════════════════════════════════════"
    echo "  macOS 交互式配置 (回车使用默认 / 自动生成)"
    echo "════════════════════════════════════════════════════════"
  } >/dev/tty

  while :; do
    printf '服务端口 [%s]: ' "$PORT" >/dev/tty
    read -r _in </dev/tty || _in=""
    [[ -z $_in ]] && break
    if [[ $_in =~ ^[0-9]+$ ]] && (( _in >= 1 && _in <= 65535 )); then PORT=$_in; break; fi
    echo "  × 端口必须是 1-65535 的整数" >/dev/tty
  done

  printf '管理员用户名 (回车自动生成): ' >/dev/tty
  read -r ADMIN_USERNAME_USER </dev/tty || ADMIN_USERNAME_USER=""

  while :; do
    printf '管理员密码 (>=8 字符, 须含数字/字母/特殊字符, 回车自动生成): ' >/dev/tty
    read -rs _pw1 </dev/tty || _pw1=""
    echo >/dev/tty
    if [[ -z $_pw1 ]]; then ADMIN_PASSWORD_USER=""; break; fi
    if (( ${#_pw1} < 8 )); then echo "  × 密码至少 8 字符" >/dev/tty; continue; fi
    if [[ ! $_pw1 =~ [0-9] ]]; then echo "  × 密码必须包含数字" >/dev/tty; continue; fi
    if [[ ! $_pw1 =~ [A-Za-z] ]]; then echo "  × 密码必须包含字母" >/dev/tty; continue; fi
    if [[ ! $_pw1 =~ [^A-Za-z0-9] ]]; then echo "  × 密码必须包含特殊字符" >/dev/tty; continue; fi
    printf '再次输入确认密码: ' >/dev/tty
    read -rs _pw2 </dev/tty || _pw2=""
    echo >/dev/tty
    if [[ $_pw1 == "$_pw2" ]]; then ADMIN_PASSWORD_USER=$_pw1; break; fi
    echo "  × 两次输入不一致, 请重新输入" >/dev/tty
  done

  menu "选择 Redis 部署方式" "新启动 Redis 实例 (仅本地访问)" "使用已有 Redis 实例"
  if [[ $MENU_CHOICE == 0 ]]; then
    REDIS_MODE=new
  else
    REDIS_MODE=existing
    printf 'Redis 地址 [127.0.0.1]: ' >/dev/tty
    read -r REDIS_HOST_USER </dev/tty || REDIS_HOST_USER=""
    [[ -z $REDIS_HOST_USER ]] && REDIS_HOST_USER=127.0.0.1
    while :; do
      printf 'Redis 端口 [6379]: ' >/dev/tty
      read -r _in </dev/tty || _in=""
      if [[ -z $_in ]]; then REDIS_PORT_USER=6379; break; fi
      if [[ $_in =~ ^[0-9]+$ ]] && (( _in >= 1 && _in <= 65535 )); then REDIS_PORT_USER=$_in; break; fi
      echo "  × 端口必须是 1-65535 的整数" >/dev/tty
    done
    printf 'Redis 密码 (回车表示无密码): ' >/dev/tty
    read -rs REDIS_PASSWORD_USER </dev/tty || REDIS_PASSWORD_USER=""
    echo >/dev/tty
  fi
  echo >/dev/tty
else
  warn "非交互式终端，使用默认值 (自动选择: 新启动 Redis 实例)"
  REDIS_MODE=new
fi

ensure_homebrew
ensure_base_tools
ensure_node
ensure_claude_code

mkdir -p "$LAUNCH_AGENT_DIR" "$SUPPORT_DIR"
launch_bootout "$SERVICE_LABEL" "$SERVICE_PLIST"

if [[ $REDIS_MODE == new ]]; then
  setup_redis_new
else
  setup_redis_existing
fi

# 切到最新的正式发布 tag (vX.Y.Z, 不含 -rc 等预发布), 与管理台一键升级的版本来源保持一致.
# 远端没有任何发布 tag 时停留在默认分支.
checkout_latest_release() {
  local dir=$1 tag
  git -C "$dir" fetch --tags --force --quiet origin || die "git fetch 失败: $dir"
  tag=$(git -C "$dir" tag -l 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n1 || true)
  if [[ -z $tag ]]; then
    warn "远端没有发布 tag (vX.Y.Z), 停留在默认分支"
    return 0
  fi
  git -C "$dir" checkout --quiet --detach "refs/tags/${tag}" \
    || die "切换到 ${tag} 失败 (工作区可能有本地修改, 请先处理: git -C $dir status)"
  ok "代码版本: ${tag}"
}

if [[ -d "$INSTALL_DIR/.git" ]]; then
  log "更新源码"
else
  log "克隆仓库到 $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
checkout_latest_release "$INSTALL_DIR"

cd "$INSTALL_DIR"
[[ -f config/config.js ]] || cp config/config.example.js config/config.js

if [[ ! -f .env ]]; then
  log "生成 .env (JWT_SECRET / ENCRYPTION_KEY 自动生成)"
  JWT_SECRET=$(random_hex 32)
  ENCRYPTION_KEY=$(random_hex 16)
  cat >.env <<EOF
# 由 install-macos.sh 自动生成 — $(date -Iseconds 2>/dev/null || date)
NODE_ENV=production
HOST=0.0.0.0
PORT=${PORT}
JWT_SECRET=${JWT_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
API_KEY_PREFIX=cr_
REDIS_HOST=${REDIS_HOST_USER}
REDIS_PORT=${REDIS_PORT_USER}
REDIS_PASSWORD=${REDIS_PASSWORD_USER}
REDIS_DB=0
TIMEZONE_OFFSET=8
LOG_LEVEL=info
TRUST_PROXY=true
ENABLE_CORS=true
EOF
  [[ -n $ADMIN_USERNAME_USER ]] && echo "ADMIN_USERNAME=${ADMIN_USERNAME_USER}" >>.env
  [[ -n $ADMIN_PASSWORD_USER ]] && echo "ADMIN_PASSWORD=${ADMIN_PASSWORD_USER}" >>.env
  chmod 600 .env
else
  log ".env 已存在，同步 Redis / 管理员配置 (JWT_SECRET / ENCRYPTION_KEY 保留不变)"
  sync_env_kv REDIS_HOST "$REDIS_HOST_USER"
  sync_env_kv REDIS_PORT "$REDIS_PORT_USER"
  sync_env_kv REDIS_PASSWORD "$REDIS_PASSWORD_USER"
  sync_env_kv PORT "$PORT"
  [[ -n $ADMIN_USERNAME_USER ]] && sync_env_kv ADMIN_USERNAME "$ADMIN_USERNAME_USER"
  [[ -n $ADMIN_PASSWORD_USER ]] && sync_env_kv ADMIN_PASSWORD "$ADMIN_PASSWORD_USER"
  chmod 600 .env
fi

mkdir -p logs data temp

log "安装后端依赖 (可能需要几分钟)"
npm install --omit=dev --no-audit --no-fund

log "安装并构建前端 SPA"
BUILD_LOG=$(mktemp "${TMPDIR:-/tmp}/relay-install-build.XXXXXX.log")
if ! { npm run install:web && npm run build:web; } >"$BUILD_LOG" 2>&1; then
  warn "前端构建失败，最近 60 行输出 ↓"
  echo "----------------------------------------------------------------" >&2
  tail -n 60 "$BUILD_LOG" >&2
  echo "----------------------------------------------------------------" >&2
  echo "  完整日志: $BUILD_LOG" >&2
  echo "  修复后重跑: cd $INSTALL_DIR && npm run build:web" >&2
  die "前端构建失败 — /admin-next/ 需要 dist 才能工作"
fi
rm -f "$BUILD_LOG"

[[ -f "${INSTALL_DIR}/web/admin-spa/dist/index.html" ]] \
  || die "web/admin-spa/dist/index.html 缺失，前端构建不完整，中止安装"

log "运行 setup 初始化管理员凭据"
npm run setup || warn "setup 异常，首次启动时会重试"

log "写入 LaunchAgent 服务 ${SERVICE_LABEL}"
write_service_plist
launch_bootstrap "$SERVICE_LABEL" "$SERVICE_PLIST"

wait_for_service || true

IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "localhost")

echo
echo "════════════════════════════════════════════════════════"
ok "Relay Service macOS 安装完成"
echo "════════════════════════════════════════════════════════"
echo "  管理面板:   http://${IP}:${PORT}/admin-next/"
echo "  本机访问:   http://127.0.0.1:${PORT}/admin-next/"
echo "  健康检查:   http://127.0.0.1:${PORT}/health"
echo "  API 端点:   http://127.0.0.1:${PORT}/api"
echo "  Redis:      ${REDIS_HOST_USER}:${REDIS_PORT_USER}"
echo
if [[ -f data/init.json ]]; then
  echo "  管理员凭据 (data/init.json):"
  sed 's/^/    /' data/init.json
else
  warn "首次初始化未完成，请稍候: cat '${INSTALL_DIR}/data/init.json'"
fi
echo
echo "  常用命令:"
echo "    launchctl print gui/${UID}/${SERVICE_LABEL}      # 服务状态"
echo "    launchctl kickstart -k gui/${UID}/${SERVICE_LABEL} # 重启"
echo "    launchctl bootout gui/${UID} '${SERVICE_PLIST}'  # 停止"
echo "    tail -f '${INSTALL_DIR}/logs/stderr.log'         # 应用错误日志"
echo "    tail -f '${INSTALL_DIR}/logs/stdout.log'         # 应用输出日志"
if [[ $REDIS_MODE == new ]]; then
  echo
  echo "  专用 Redis 实例:"
  echo "    launchctl print gui/${UID}/${REDIS_LABEL}"
  echo "    launchctl kickstart -k gui/${UID}/${REDIS_LABEL}"
  echo "    tail -f '${REDIS_LOG}'"
  echo "    ${REDIS_CONF}"
fi
echo
echo "  升级 (<vX.Y.Z> 替换为目标版本, 只识别发布 tag):"
echo "    cd '${INSTALL_DIR}'"
echo "    git fetch --tags origin"
echo "    git checkout --detach refs/tags/<vX.Y.Z>"
echo "    npm install --omit=dev"
echo "    npm run build:web"
echo "    launchctl kickstart -k gui/${UID}/${SERVICE_LABEL}"
echo "════════════════════════════════════════════════════════"
