#!/usr/bin/env bash
# Relay Service 一键安装脚本 (Node + Redis + systemd + Nginx)
# 适用: Ubuntu / Debian / CentOS / RHEL / Rocky / AlmaLinux / Alibaba Cloud Linux
# 用法: sudo bash install.sh [安装目录] [应用端口]
#   例: sudo bash install.sh /opt/relay-service 13000
#
# 默认部署形态（对外 API 与后台管理分离，由 Nginx 承载）：
#   客户端  ──▶ Nginx :8080  ──▶ 127.0.0.1:13000   仅放行业务路由
#   管理员  ──▶ Nginx :28080 ──▶ 127.0.0.1:13000   放行管理台
#   应用自身只绑回环地址，不直接对外。
#   跳过 Nginx（应用端口直接对外）: NGINX_MODE=no sudo bash install.sh

set -euo pipefail

INSTALL_DIR="${1:-/opt/relay-service}"
PORT="${2:-13000}"            # 应用自身监听端口（默认只绑 127.0.0.1，由 Nginx 对外暴露）
NODE_MAJOR=20
SERVICE_USER="root"           # 服务以 root 运行 (按需求)
SERVICE_NAME="relay-service"
REPO_URL="${REPO_URL:-https://github.com/zhouzh528/llm-relay-service.git}"  # 可用环境变量覆盖

# Nginx 对外入口（对外 API / 后台管理 分离）——均可用环境变量覆盖
NGINX_PUBLIC_PORT="${NGINX_PUBLIC_PORT:-8080}"          # 对外调用端口
NGINX_ADMIN_PORT="${NGINX_ADMIN_PORT:-28080}"           # 后台管理端口
NGINX_MODE="${NGINX_MODE:-yes}"                         # yes=安装并配置 Nginx；no=不安装（应用直接对外）
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-_}"
NGINX_CLIENT_MAX_BODY_SIZE="${NGINX_CLIENT_MAX_BODY_SIZE:-100m}"
NGINX_CONF_DIR="${NGINX_CONF_DIR:-/etc/nginx/conf.d}"
NGINX_SNIPPET_PATH="${NGINX_SNIPPET_PATH:-/etc/nginx/relay_proxy.conf}"
HOST_VALUE="127.0.0.1"                                  # 由 NGINX_MODE 决定，见第 5 节

# ---------- 颜色/打印 ----------
BLUE=$'\033[0;34m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'
CYAN=$'\033[0;36m'; BOLD=$'\033[1m'; DIM=$'\033[2m'; NC=$'\033[0m'
log()  { echo -e "${BLUE}[*]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
die()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# 判断 /dev/tty 是否真的可读写 (权限位可能 OK 但打开会 ENXIO)
tty_ok() { { : </dev/tty; } 2>/dev/null && { : >/dev/tty; } 2>/dev/null; }

# ---------- 启动图标 (取自 favicon.svg 配色: #F5F5F7 / #D1D5DB + 强调蓝) ----------
show_logo() {
  local W=$'\033[38;2;245;245;247m'   # 亮白
  local G=$'\033[38;2;209;213;219m'   # 浅灰
  local A=$'\033[38;2;88;166;255m'    # 强调蓝
  local D=$'\033[38;2;100;100;110m'   # 暗灰
  local R=$'\033[0m'
  printf '\n'
  printf '  %s██████╗ ███████╗██╗      █████╗ ██╗   ██╗%s\n' "$W" "$R"
  printf '  %s██╔══██╗██╔════╝██║     ██╔══██╗╚██╗ ██╔╝%s\n' "$W" "$R"
  printf '  %s██████╔╝█████╗  ██║     ███████║ ╚████╔╝ %s\n' "$W" "$R"
  printf '  %s██╔══██╗██╔══╝  ██║     ██╔══██║  ╚██╔╝  %s\n' "$G" "$R"
  printf '  %s██║  ██║███████╗███████╗██║  ██║   ██║   %s\n' "$G" "$R"
  printf '  %s╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   %s\n' "$D" "$R"
  printf '\n  %sRelay Service%s %s·%s %s一键安装向导%s\n\n' "$A$BOLD" "$R" "$DIM" "$R" "$A" "$R"
}

# ---------- 交互菜单 (↑↓ + Enter) ----------
menu() {
  # menu <title> <opt1> <opt2> ...  —— 将选择写入全局 MENU_CHOICE (0-based)
  local title=$1; shift
  local -a options=("$@")
  local n=${#options[@]} sel=0 i key key2 key3 seq
  tty_ok || { MENU_CHOICE=0; return; }

  # 保存菜单起点，每次从同一位置清屏重画，避免中文宽度/换行导致残影。
  printf '\n' >/dev/tty
  tput sc >/dev/tty 2>/dev/null || printf '\033[s' >/dev/tty
  while :; do
    tput rc >/dev/tty 2>/dev/null || printf '\033[u' >/dev/tty
    tput ed >/dev/tty 2>/dev/null || printf '\033[J' >/dev/tty
    printf '%s%s%s  %s(↑↓ 选择, Enter 确认)%s\n' "$BOLD" "$title" "$NC" "$DIM" "$NC" >/dev/tty
    for ((i=0; i<n; i++)); do
      if (( i == sel )); then
        printf '  %s▸ %s%s\n' "$CYAN" "${options[$i]}" "$NC" >/dev/tty
      else
        printf '    %s\n' "${options[$i]}" >/dev/tty
      fi
    done

    IFS= read -rsn1 key </dev/tty || key=""
    if [[ -z $key ]]; then
      break
    fi
    if [[ $key == $'\e' ]]; then
      IFS= read -rsn1 -t 0.2 key2 </dev/tty || key2=""
      IFS= read -rsn1 -t 0.2 key3 </dev/tty || key3=""
      seq="${key2}${key3}"
      case $seq in
        '[A'|'OA') (( sel > 0 )) && sel=$((sel - 1)) || : ;;
        '[B'|'OB') (( sel < n-1 )) && sel=$((sel + 1)) || : ;;
      esac
    fi
  done
  MENU_CHOICE=$sel
  printf '\n' >/dev/tty
}

[[ $EUID -eq 0 ]] || die "请使用 root 或 sudo 运行"

# ---------- 停用残留服务 (重装时必须第一步做) ----------
# 目的: 旧的 relay-service.service 带 Restart=always, 如果 unit 文件还在,
# systemd 会在后台每 5 秒 auto-restart. 当 .env 一被新脚本写出时, 它可能
# 抢在 build:web 完成前就把服务拉起来, 导致 /admin-next 路由看不到 dist.
for u in relay-service relay-redis; do
  if systemctl cat "$u.service" >/dev/null 2>&1; then
    systemctl disable --now "$u.service" 2>/dev/null || true
    rm -f "/etc/systemd/system/${u}.service"
  fi
done
systemctl reset-failed relay-service relay-redis 2>/dev/null || true
systemctl daemon-reload

show_logo

# ---------- 0. 交互式配置 ----------
ADMIN_USERNAME_USER=""; ADMIN_PASSWORD_USER=""
REDIS_MODE=""
REDIS_HOST_USER=""; REDIS_PORT_USER=""; REDIS_PASSWORD_USER=""

if tty_ok; then
  {
    echo "════════════════════════════════════════════════════════"
    echo "  交互式配置 (回车使用默认 / 自动生成)"
    echo "════════════════════════════════════════════════════════"
  } >/dev/tty

  # 服务端口
  while :; do
    printf '应用监听端口 (仅本机, 由 Nginx 对外) [%s]: ' "$PORT" >/dev/tty
    read -r _in </dev/tty || _in=""
    [[ -z $_in ]] && break
    if [[ $_in =~ ^[0-9]+$ ]] && (( _in >= 1 && _in <= 65535 )); then PORT=$_in; break; fi
    echo "  × 端口必须是 1-65535 的整数" >/dev/tty
  done

  # Nginx 反向代理（对外 API 与后台管理分端口）—— 默认安装，不再询问
  # 如需跳过（应用端口直接对外）: NGINX_MODE=no bash install.sh
  if [[ $NGINX_MODE == yes ]]; then
    while :; do
      printf '对外 API 端口 (Nginx) [%s]: ' "$NGINX_PUBLIC_PORT" >/dev/tty
      read -r _in </dev/tty || _in=""
      [[ -z $_in ]] && break
      if [[ $_in =~ ^[0-9]+$ ]] && (( _in >= 1 && _in <= 65535 )); then NGINX_PUBLIC_PORT=$_in; break; fi
      echo "  × 端口必须是 1-65535 的整数" >/dev/tty
    done
    while :; do
      printf '后台管理端口 (Nginx) [%s]: ' "$NGINX_ADMIN_PORT" >/dev/tty
      read -r _in </dev/tty || _in=""
      [[ -z $_in ]] && break
      if [[ $_in =~ ^[0-9]+$ ]] && (( _in >= 1 && _in <= 65535 )); then NGINX_ADMIN_PORT=$_in; break; fi
      echo "  × 端口必须是 1-65535 的整数" >/dev/tty
    done
    if [[ $NGINX_PUBLIC_PORT == "$NGINX_ADMIN_PORT" ]]; then
      die "对外 API 端口与后台管理端口不能相同 (${NGINX_PUBLIC_PORT})"
    fi
    if [[ $NGINX_PUBLIC_PORT == "$PORT" || $NGINX_ADMIN_PORT == "$PORT" ]]; then
      die "Nginx 端口不能与应用监听端口 ${PORT} 相同"
    fi
  else
    NGINX_MODE=no
    warn "已跳过 Nginx: 应用会监听 0.0.0.0:${PORT}, 管理台与 API 同端口可达"
  fi

  # 管理员用户名
  printf '管理员用户名 (回车自动生成): ' >/dev/tty
  read -r ADMIN_USERNAME_USER </dev/tty || ADMIN_USERNAME_USER=""

  # 管理员密码 + 二次确认
  # 要求: ≥8 字符, 含数字 / 字母 / 特殊字符. 空=自动生成.
  while :; do
    printf '管理员密码 (>=8 字符, 须含数字/字母/特殊字符, 回车自动生成): ' >/dev/tty
    read -rs _pw1 </dev/tty || _pw1=""
    echo >/dev/tty
    if [[ -z $_pw1 ]]; then ADMIN_PASSWORD_USER=""; break; fi
    if (( ${#_pw1} < 8 )); then echo "  × 密码至少 8 字符" >/dev/tty; continue; fi
    if [[ ! $_pw1 =~ [0-9] ]];         then echo "  × 密码必须包含数字"     >/dev/tty; continue; fi
    if [[ ! $_pw1 =~ [A-Za-z] ]];      then echo "  × 密码必须包含字母"     >/dev/tty; continue; fi
    if [[ ! $_pw1 =~ [^A-Za-z0-9] ]];  then echo "  × 密码必须包含特殊字符" >/dev/tty; continue; fi
    printf '再次输入确认密码:                                            ' >/dev/tty
    read -rs _pw2 </dev/tty || _pw2=""
    echo >/dev/tty
    if [[ $_pw1 == "$_pw2" ]]; then ADMIN_PASSWORD_USER=$_pw1; break; fi
    echo "  × 两次输入不一致, 请重新输入" >/dev/tty
  done

  # Redis 选择
  menu "选择 Redis 部署方式" "新启动 Redis 实例 (仅本地访问)" "使用已有 Redis 实例"
  if [[ $NGINX_MODE == yes ]]; then
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
  warn "非交互式终端, 使用默认值 (自动选择: 新启动 Redis 实例)"
  REDIS_MODE=new
fi

# ---------- 1. 识别发行版 ----------
. /etc/os-release 2>/dev/null || die "无法识别操作系统"
OS_ID="${ID:-}"; OS_FAMILY="${ID_LIKE:-$OS_ID}"
log "检测到系统: $OS_ID"
case "$OS_FAMILY" in
  *debian*|*ubuntu*) PKG="apt" ;;
  *rhel*|*centos*|*fedora*) PKG=$(command -v dnf >/dev/null && echo dnf || echo yum) ;;
  *) die "不支持的发行版: $OS_FAMILY" ;;
esac

pkg_install() {
  if [[ $PKG == apt ]]; then DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  else $PKG install -y "$@"; fi
}

[[ $PKG == apt ]] && { log "更新软件源"; apt-get update -y >/dev/null || true; }
log "安装基础工具"
pkg_install git curl openssl ca-certificates build-essential 2>/dev/null \
  || pkg_install git curl openssl ca-certificates gcc-c++ make

# ---------- 2. Node.js ----------
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CUR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  (( CUR >= 18 )) && NEED_NODE=0 && ok "Node 已存在: $(node -v)"
fi
if (( NEED_NODE )); then
  log "安装 Node.js ${NODE_MAJOR}.x (NodeSource)"
  if [[ $PKG == apt ]]; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
    apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_${NODE_MAJOR}.x | bash -
    $PKG install -y nodejs
  fi
  ok "Node $(node -v)"
fi

# ---------- 2.5. Claude Code CLI ----------
# Token 刷新依赖 `claude -p`，binary 必须落在 systemd 服务的 PATH 内
# 强制 --prefix=/usr/local 避免 NVM 环境把全局安装挂到 ~/.nvm/.../bin（systemd 看不到）
CLAUDE_SYSTEM_PATH=/usr/local/bin/claude
if [[ -x $CLAUDE_SYSTEM_PATH ]]; then
  ok "Claude Code 已存在: $CLAUDE_SYSTEM_PATH"
elif command -v claude >/dev/null 2>&1 && [[ $(command -v claude) == /usr/bin/claude ]]; then
  ok "Claude Code 已存在: $(command -v claude)"
else
  log "安装 Claude Code CLI (@anthropic-ai/claude-code → /usr/local)"
  # env -i 避免 NVM 注入；显式 PATH + prefix 锁定到系统位置
  if env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin HOME=/root \
      /usr/bin/npm i -g --prefix=/usr/local @anthropic-ai/claude-code 2>&1 | tail -5; then
    if [[ -x $CLAUDE_SYSTEM_PATH ]]; then
      ok "Claude Code: $CLAUDE_SYSTEM_PATH ($("$CLAUDE_SYSTEM_PATH" --version 2>/dev/null | head -1))"
    else
      warn "Claude Code 安装完成但 $CLAUDE_SYSTEM_PATH 不存在；服务启动后可能命中 cli_not_found"
    fi
  else
    warn "Claude Code 安装失败，刷新 token 时会归类为 cli_not_found；可在 .env 显式设置 CLAUDE_BIN"
  fi
fi

# ---------- 3. Redis ----------
# 找一个未被监听的端口 (从 6380 起)
find_free_port() {
  local p=${1:-6380}
  while (: </dev/tcp/127.0.0.1/$p) 2>/dev/null; do ((p++)); done
  echo "$p"
}

setup_redis_new() {
  command -v redis-server >/dev/null 2>&1 || {
    log "安装 Redis"
    if [[ $PKG == apt ]]; then pkg_install redis-server
    else pkg_install redis || pkg_install redis6 || die "Redis 安装失败"; fi
  }
  REDIS_HOST_USER=127.0.0.1
  REDIS_PORT_USER=$(find_free_port 6380)
  REDIS_PASSWORD_USER=$(openssl rand -hex 16)
  log "新建独立 Redis 实例 (127.0.0.1:${REDIS_PORT_USER})"

  local RU=redis
  id redis >/dev/null 2>&1 || RU=nobody

  install -d -m 0755 /etc/relay-redis
  install -d -m 0750 -o "$RU" -g "$RU" /var/lib/relay-redis 2>/dev/null \
    || { install -d -m 0750 /var/lib/relay-redis; chown "$RU" /var/lib/relay-redis; }

  cat >/etc/relay-redis/redis.conf <<EOF
bind 127.0.0.1
protected-mode yes
port ${REDIS_PORT_USER}
requirepass ${REDIS_PASSWORD_USER}
dir /var/lib/relay-redis
appendonly yes
appendfsync everysec
logfile /var/log/relay-redis.log
pidfile /var/run/relay-redis.pid
daemonize no
EOF
  chown "root:${RU}" /etc/relay-redis/redis.conf
  chmod 640 /etc/relay-redis/redis.conf
  : >/var/log/relay-redis.log
  chown "${RU}:${RU}" /var/log/relay-redis.log 2>/dev/null || true

  cat >/etc/systemd/system/relay-redis.service <<EOF
[Unit]
Description=Relay Service dedicated Redis instance
After=network.target

[Service]
Type=simple
User=${RU}
Group=${RU}
ExecStart=/usr/bin/redis-server /etc/relay-redis/redis.conf
Restart=on-failure
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now relay-redis
  sleep 2
  local PONG
  PONG=$(redis-cli -h 127.0.0.1 -p "$REDIS_PORT_USER" -a "$REDIS_PASSWORD_USER" --no-auth-warning ping 2>/dev/null || true)
  [[ $PONG == PONG ]] \
    && ok "Relay Redis 就绪 (127.0.0.1:${REDIS_PORT_USER})" \
    || die "Relay Redis 启动失败, 查看: journalctl -u relay-redis -e"
}

setup_redis_existing() {
  log "连接已有 Redis (${REDIS_HOST_USER}:${REDIS_PORT_USER})"
  command -v redis-cli >/dev/null 2>&1 || pkg_install redis-tools 2>/dev/null || pkg_install redis 2>/dev/null || true
  local -a args=(-h "$REDIS_HOST_USER" -p "$REDIS_PORT_USER")
  [[ -n $REDIS_PASSWORD_USER ]] && args+=(-a "$REDIS_PASSWORD_USER" --no-auth-warning)
  local PONG
  PONG=$(redis-cli "${args[@]}" ping 2>/dev/null || true)
  [[ $PONG == PONG ]] || die "无法连接 Redis, 请检查地址/端口/密码"
  ok "已有 Redis 连接成功"
}

if [[ $REDIS_MODE == new ]]; then setup_redis_new; else setup_redis_existing; fi

# ---------- 4. 系统用户 + 源码 ----------
if [[ $SERVICE_USER != root ]] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "创建系统用户 $SERVICE_USER"
  useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" \
    || useradd -r -d "$INSTALL_DIR" -s /sbin/nologin "$SERVICE_USER"
fi

# 以服务身份执行命令. root 时无需 sudo (部分精简镜像里没装 sudo)
if [[ $SERVICE_USER == root ]]; then
  run_as_svc() { bash -lc "$*"; }
else
  run_as_svc() { sudo -u "$SERVICE_USER" bash -lc "$*"; }
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
  # 旧安装可能以不同用户执行, 先把归属调整到本次的 SERVICE_USER 再做 git 操作,
  # 否则 git >=2.35 对 dubious ownership 会报错
  chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR" 2>/dev/null || true
else
  log "克隆仓库到 $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
checkout_latest_release "$INSTALL_DIR"

cd "$INSTALL_DIR"
[[ -f config/config.js ]] || cp config/config.example.js config/config.js

# ---------- 5. 生成 / 同步 .env ----------
# 设计要点: JWT_SECRET / ENCRYPTION_KEY 只在首次生成 (再生成会导致旧会话、旧密文全部失效).
# 但 Redis 地址/端口/密码是基础设施状态, setup_redis_new 每次重装都会重写 redis.conf,
# 所以 .env 里的 REDIS_* 必须在这一步同步回去, 否则两边密码不一致、服务起不来.
# 管理员用户名/密码同理: 交互式输入的值应当覆盖 .env 中的旧值.
sync_env_kv() {
  local key=$1 val=$2 file=${3:-.env}
  # 用 | 作分隔符, 避免密码中含 / 破坏 sed
  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    echo "${key}=${val}" >>"$file"
  fi
}

if [[ $NGINX_MODE == yes ]]; then HOST_VALUE=127.0.0.1; else HOST_VALUE=0.0.0.0; fi

if [[ ! -f .env ]]; then
  log "生成 .env (JWT_SECRET / ENCRYPTION_KEY 自动生成)"
  JWT_SECRET=$(openssl rand -hex 32)          # 64 字符
  ENCRYPTION_KEY=$(openssl rand -hex 16)      # 固定 32 字符 (AES-256)
  cat >.env <<EOF
# 由 install.sh 自动生成 — $(date -Iseconds)
NODE_ENV=production
HOST=${HOST_VALUE}
PORT=${PORT}
# Nginx 对外入口（对外 API / 后台管理 分离）；HOST=127.0.0.1 时应用仅 Nginx 可达
NGINX_PUBLIC_PORT=${NGINX_PUBLIC_PORT}
NGINX_ADMIN_PORT=${NGINX_ADMIN_PORT}
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
  log ".env 已存在, 同步 Redis / 管理员 / 监听与 Nginx 配置 (JWT_SECRET / ENCRYPTION_KEY 保留不变)"
  sync_env_kv REDIS_HOST "$REDIS_HOST_USER"
  sync_env_kv REDIS_PORT "$REDIS_PORT_USER"
  sync_env_kv REDIS_PASSWORD "$REDIS_PASSWORD_USER"
  sync_env_kv PORT "$PORT"
  sync_env_kv HOST "$HOST_VALUE"
  sync_env_kv NGINX_PUBLIC_PORT "$NGINX_PUBLIC_PORT"
  sync_env_kv NGINX_ADMIN_PORT "$NGINX_ADMIN_PORT"
  [[ -n $ADMIN_USERNAME_USER ]] && sync_env_kv ADMIN_USERNAME "$ADMIN_USERNAME_USER"
  [[ -n $ADMIN_PASSWORD_USER ]] && sync_env_kv ADMIN_PASSWORD "$ADMIN_PASSWORD_USER"
  chmod 600 .env
fi

mkdir -p logs data temp
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ---------- 6. 依赖 + 前端构建 + 管理员初始化 ----------
log "安装后端依赖 (可能需要几分钟)"
run_as_svc "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund"
log "安装并构建前端 SPA"
# --silent 会把 prettier / ESLint 的报错藏起来, 出错时用户看不到任何线索,
# 只能手动重跑才知道错在哪. 这里改成: 全量输出重定向到日志, 失败时 tail
# 出来直接展示错误; 成功则静默.
BUILD_LOG=$(mktemp /tmp/relay-install-build.XXXXXX.log)
if ! run_as_svc "cd '$INSTALL_DIR' && npm run install:web && npm run build:web" \
      >"$BUILD_LOG" 2>&1; then
  warn "前端构建失败, 最近 60 行输出 ↓"
  echo "----------------------------------------------------------------" >&2
  tail -n 60 "$BUILD_LOG" >&2
  echo "----------------------------------------------------------------" >&2
  echo "  完整日志: $BUILD_LOG" >&2
  echo "  修复后重跑: cd $INSTALL_DIR && npm run build:web" >&2
  die "前端构建失败 — /admin-next/ 需要 dist 才能工作"
fi
rm -f "$BUILD_LOG"

# build 必须产出 dist/index.html, 否则服务启动时会 skip /admin-next 路由
[[ -f "${INSTALL_DIR}/web/admin-spa/dist/index.html" ]] \
  || die "web/admin-spa/dist/index.html 缺失, 前端构建不完整, 中止安装"
log "运行 setup 初始化管理员凭据"
run_as_svc "cd '$INSTALL_DIR' && npm run setup" || warn "setup 异常, 首次启动时会重试"

# ---------- 7. systemd 单元 ----------
log "写入 systemd 服务 ${SERVICE_NAME}"
cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Relay Service
After=network.target relay-redis.service redis-server.service redis.service
Wants=relay-redis.service

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
# 显式 PATH，确保 claude CLI（系统 npm 全局装到 /usr/local/bin 或 /usr/bin）可被 spawn
# .env 内可用 CLAUDE_BIN=/path/to/claude 显式指定绝对路径覆盖此查找
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/bin
ExecStart=/usr/bin/node ${INSTALL_DIR}/src/app.js
Restart=always
RestartSec=5
StandardOutput=append:${INSTALL_DIR}/logs/stdout.log
StandardError=append:${INSTALL_DIR}/logs/stderr.log
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
# enable --now 前, 确认 dist 仍在且服务不处于 active 状态 (防止 auto-restart
# 残留抢跑). 再次启动使用新 unit.
[[ -f "${INSTALL_DIR}/web/admin-spa/dist/index.html" ]] \
  || die "dist/index.html 在启动前消失, 中止 (检查 build:web 是否被覆盖)"
systemctl stop ${SERVICE_NAME} 2>/dev/null || true
systemctl enable --now ${SERVICE_NAME}

# ---------- 8. 等待就绪 (5 分钟倒计时) ----------
wait_for_service() {
  local timeout=300 start=$SECONDS elapsed remain
  while :; do
    elapsed=$(( SECONDS - start ))
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      printf '\r\033[K'
      ok "服务已启动 (用时 $((elapsed/60))分$((elapsed%60))秒)"
      return 0
    fi
    if (( elapsed >= timeout )); then
      printf '\r\033[K'
      warn "健康检查 5 分钟超时; 查看: journalctl -u ${SERVICE_NAME} -e"
      return 1
    fi
    remain=$(( timeout - elapsed ))
    printf '\r\033[K%s[*]%s 等待服务就绪 · 已用 %d:%02d · 剩余 %d:%02d' \
      "$BLUE" "$NC" $((elapsed/60)) $((elapsed%60)) $((remain/60)) $((remain%60))
    sleep 2
  done
}
wait_for_service || true

# ---------- 8.5 Nginx 反向代理 (对外 API / 后台管理 分离) ----------
# 应用只监听 127.0.0.1:${PORT}; 隔离在 Nginx: 对外端口只放行业务路由,
# 其余(管理面)一律 404; 管理台只从管理端口可达。
if [[ $NGINX_MODE == yes ]]; then
  log "安装 Nginx"
  if command -v nginx >/dev/null 2>&1; then
    ok "Nginx 已存在: $(nginx -v 2>&1)"
  else
    pkg_install nginx || die "Nginx 安装失败"
  fi

  # 共享代理参数: SSE 长连接友好 + 标准转发头。
  # 用引号 heredoc(不展开变量), 保留 nginx 自身的 $host / $remote_addr 等变量。
  log "写入代理参数片段 ${NGINX_SNIPPET_PATH}"
  cat >"$NGINX_SNIPPET_PATH" <<'EOF'
# Relay Service 反向代理公共参数 (由 install.sh 生成)
proxy_http_version 1.1;
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Connection "";
# 流式响应(SSE)：关闭缓冲与缓存, 放宽超时, 保持分块传输
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
chunked_transfer_encoding on;
EOF

  mkdir -p "$NGINX_CONF_DIR"
  NGINX_CONF_FILE="${NGINX_CONF_DIR}/relay-service.conf"
  log "写入 Nginx 站点配置 ${NGINX_CONF_FILE}"
  cat >"$NGINX_CONF_FILE" <<EOF
# Relay Service 反向代理 (由 install.sh 生成)
#   ${NGINX_PUBLIC_PORT} = 对外 API 中转 (客户端指向这里)
#   ${NGINX_ADMIN_PORT}  = 后台管理
# 应用监听 127.0.0.1:${PORT}
upstream relay_backend {
    server 127.0.0.1:${PORT};
    keepalive 32;
}

# ---------- 对外 API 端口：仅放行业务路由 ----------
server {
    listen ${NGINX_PUBLIC_PORT};
    server_name ${NGINX_SERVER_NAME};
    client_max_body_size ${NGINX_CLIENT_MAX_BODY_SIZE};
    # Claude Code / Codex 会发送带下划线的请求头(如 session_id)，
    # Nginx 默认丢弃，会导致粘性会话失效。
    underscores_in_headers on;

    location = /health { proxy_pass http://relay_backend; include ${NGINX_SNIPPET_PATH}; }
    location /api      { proxy_pass http://relay_backend; include ${NGINX_SNIPPET_PATH}; }
    location /claude   { proxy_pass http://relay_backend; include ${NGINX_SNIPPET_PATH}; }
    location /gemini   { proxy_pass http://relay_backend; include ${NGINX_SNIPPET_PATH}; }
    location /openai   { proxy_pass http://relay_backend; include ${NGINX_SNIPPET_PATH}; }
    location /droid    { proxy_pass http://relay_backend; include ${NGINX_SNIPPET_PATH}; }
    location /azure    { proxy_pass http://relay_backend; include ${NGINX_SNIPPET_PATH}; }

    # 管理面不在对外端口暴露
    location / { return 404; }
}

# ---------- 后台管理端口 ----------
server {
    listen ${NGINX_ADMIN_PORT};
    server_name ${NGINX_SERVER_NAME};
    client_max_body_size ${NGINX_CLIENT_MAX_BODY_SIZE};
    underscores_in_headers on;

    location / { proxy_pass http://relay_backend; include ${NGINX_SNIPPET_PATH}; }
}
EOF

  nginx -t || die "Nginx 配置校验失败, 请检查 ${NGINX_CONF_FILE}"
  systemctl enable nginx >/dev/null 2>&1 || true
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx || die "Nginx 重载失败 (端口可能被占用, 检查 ${NGINX_CONF_FILE})"
    ok "Nginx 已重载"
  else
    systemctl start nginx || die "Nginx 启动失败 (端口可能被占用, 检查 ${NGINX_CONF_FILE})"
    ok "Nginx 已启动"
  fi

  # 防火墙(仅当 firewalld 在运行时才需要)
  if systemctl is-active --quiet firewalld 2>/dev/null; then
    firewall-cmd --permanent --add-port="${NGINX_PUBLIC_PORT}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --permanent --add-port="${NGINX_ADMIN_PORT}/tcp" >/dev/null 2>&1 || true
    firewall-cmd --reload >/dev/null 2>&1 || true
    ok "firewalld 已放行 ${NGINX_PUBLIC_PORT} / ${NGINX_ADMIN_PORT}"
  fi
  warn "如使用云服务器, 还需在安全组放行 ${NGINX_PUBLIC_PORT} 与 ${NGINX_ADMIN_PORT}"
fi

# ---------- 9. 收尾 ----------
echo
echo "════════════════════════════════════════════════════════"
ok "Relay Service 安装完成"
echo "════════════════════════════════════════════════════════"
IP=$(curl -fsS --max-time 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
if [[ $NGINX_MODE == yes ]]; then
  echo "  对外 API:   http://${IP}:${NGINX_PUBLIC_PORT}/api   (客户端指向这里)"
  echo "  管理面板:   http://${IP}:${NGINX_ADMIN_PORT}/admin-next/"
  echo "  健康检查:   http://${IP}:${NGINX_PUBLIC_PORT}/health"
  echo "  应用监听:   127.0.0.1:${PORT}  (仅 Nginx 可达)"
  echo
  echo "  Nginx:"
  echo "    配置:      ${NGINX_CONF_DIR}/relay-service.conf"
  echo "    代理参数:  ${NGINX_SNIPPET_PATH}"
  echo "    重载:      nginx -t && systemctl reload nginx"
else
  echo "  管理面板:   http://${IP}:${PORT}/admin-next/"
  echo "  健康检查:   http://${IP}:${PORT}/health"
  echo "  API 端点:   http://${IP}:${PORT}/api"
fi
echo "  Redis:     ${REDIS_HOST_USER}:${REDIS_PORT_USER}"
echo
if [[ -f data/init.json ]]; then
  echo "  管理员凭据 (data/init.json):"
  sed 's/^/    /' data/init.json
else
  warn "首次初始化未完成, 请稍候: cat ${INSTALL_DIR}/data/init.json"
fi
echo
echo "  常用命令:"
echo "    systemctl status ${SERVICE_NAME}      # 状态"
echo "    systemctl restart ${SERVICE_NAME}     # 重启"
echo "    systemctl stop ${SERVICE_NAME}        # 停止"
echo "    journalctl -u ${SERVICE_NAME} -f      # 实时日志"
echo "    tail -f ${INSTALL_DIR}/logs/*.log     # 应用日志"
if [[ $REDIS_MODE == new ]]; then
  echo
  echo "  专用 Redis 实例:"
  echo "    systemctl status relay-redis"
  echo "    journalctl -u relay-redis -f"
  echo "    /etc/relay-redis/redis.conf"
fi
echo
echo "  升级 (推荐): 管理台账户菜单 → 检查更新 → 升级 (只识别 vX.Y.Z 发布 tag)"
echo "  手动升级 (<vX.Y.Z> 替换为目标版本):"
if [[ $SERVICE_USER == root ]]; then
  echo "    cd ${INSTALL_DIR} && git fetch --tags origin"
  echo "    git checkout --detach refs/tags/<vX.Y.Z>"
  echo "    npm install --omit=dev"
  echo "    npm run build:web"
else
  echo "    cd ${INSTALL_DIR} && sudo -u ${SERVICE_USER} git fetch --tags origin"
  echo "    sudo -u ${SERVICE_USER} git checkout --detach refs/tags/<vX.Y.Z>"
  echo "    sudo -u ${SERVICE_USER} npm install --omit=dev"
  echo "    sudo -u ${SERVICE_USER} npm run build:web"
fi
echo "    systemctl restart ${SERVICE_NAME}"
echo "════════════════════════════════════════════════════════"
