# Relay Service

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Redis](https://img.shields.io/badge/Redis-6+-red.svg)](https://redis.io/)

**🔐 自行搭建 Claude API 中转服务，支持多账户管理**

[English](README_EN.md)

</div>

> 本项目基于 **MIT 协议** 开源，源自上游项目 [Wei-Shaw/claude-relay-service](https://github.com/Wei-Shaw/claude-relay-service) **v1.1.300** 版本。
> 原始版权信息保留于 [LICENSE](LICENSE)。

---

## ⚠️ 重要提醒

**使用本项目前请仔细阅读：**

🚨 **服务条款风险**: 使用本项目可能违反Anthropic的服务条款。请在使用前仔细阅读Anthropic的用户协议，使用本项目的一切风险由用户自行承担。

📖 **免责声明**: 本项目仅供技术学习和研究使用，作者不对因使用本项目导致的账户封禁、服务中断或其他损失承担任何责任。


## 🤔 这个项目适合你吗？

- 🌍 **地区限制**: 所在地区无法直接访问Claude Code服务？
- 🔒 **隐私担忧**: 担心第三方镜像服务会记录或泄露你的对话内容？
- 👥 **成本分摊**: 想和朋友一起分摊Claude Code Max订阅费用？
- ⚡ **稳定性**: 第三方镜像站经常故障不稳定，影响效率 ？

如果有以上困惑，那这个项目可能适合你。

### 适合的场景

✅ **找朋友拼车**: 三五好友一起分摊Claude Code Max订阅  
✅ **隐私敏感**: 不想让第三方镜像看到你的对话内容  
✅ **技术折腾**: 有基本的技术基础，愿意自己搭建和维护  
✅ **稳定需求**: 需要长期稳定的Claude访问，不想受制于镜像站  
✅ **地区受限**: 无法直接访问Claude官方服务

---

## 💭 为什么要自己搭？

### 现有镜像站可能的问题

- 🕵️ **隐私风险**: 你的对话内容都被人家看得一清二楚，商业机密什么的就别想了
- 🐌 **性能不稳**: 用的人多了就慢，高峰期经常卡死
- 💰 **价格不透明**: 不知道实际成本

### 自建的好处

- 🔐 **数据安全**: 所有接口请求都只经过你自己的服务器，直连Anthropic API
- ⚡ **性能可控**: 就你们几个人用，Max 200刀套餐基本上可以爽用Opus
- 💰 **成本透明**: 用了多少token一目了然，按官方价格换算了具体费用
- 📊 **监控完整**: 使用情况、成本分析、性能监控全都有

---

## 🚀 核心功能

### 基础功能

- ✅ **多账户管理**: 可以添加多个Claude账户自动轮换
- ✅ **自定义API Key**: 给每个人分配独立的Key
- ✅ **使用统计**: 详细记录每个人用了多少token

### 高级功能

- 🔄 **智能切换**: 账户出问题自动换下一个
- 🚀 **性能优化**: 连接池、缓存，减少延迟
- 📊 **监控面板**: Web界面查看所有数据
- 🛡️ **安全控制**: 访问限制、速率控制、客户端限制
- 🌐 **代理支持**: 支持HTTP/SOCKS5代理

---

## 🖼️ 界面预览

> 以下截图中的账号、用量与费用均为演示数据。

### 实时观测 · 看板

流式响应中实时捕获 Token 使用与成本，仪表盘秒级刷新。

![看板](web/admin-spa/public/screenshots/dashboard.jpg)

### 精细计量 · API Keys

给每个人发独立 Key，费用、用量与最后使用时间逐条入账。

![API Keys](web/admin-spa/public/screenshots/api-keys.jpg)

### 智能调度 · 账户管理

Claude、Gemini、OpenAI 等账户集中管理，会话窗口一目了然。

![账户管理](web/admin-spa/public/screenshots/accounts.jpg)

---

## 📋 部署要求

### 硬件要求（最低配置）

- **CPU**: 1核心就够了
- **内存**: 512MB（建议1GB）
- **硬盘**: 30GB可用空间
- **网络**: 能访问到Anthropic API（建议使用US地区的机器）
- **建议**: 2核4G的基本够了，网络尽量选回国线路快一点的（为了提高速度，建议不要开代理或者设置服务器的IP直连）
- **经验**: 阿里云、腾讯云的海外主机经测试会被Cloudflare拦截，无法直接访问claude api

### 软件要求

- **Node.js** 18或更高版本
- **Redis** 6或更高版本
- **操作系统**: 建议Linux

### 费用估算

- **服务器**: 轻量云服务器，一个月30-60块
- **Claude订阅**: 看你怎么分摊了
- **其他**: 域名（可选）

---

## ⚡ 一键安装（推荐）

仓库根目录提供 `install.sh`，适用于 **Ubuntu / Debian / CentOS / RHEL / Rocky / AlmaLinux / 阿里云 Linux**。脚本会自动安装 Node.js 20、Redis、克隆仓库、构建前端 SPA、生成 `.env`、写入 systemd 单元并启动服务。


### 一行拉起

```bash
curl -fsSL https://raw.githubusercontent.com/zhouzh528/llm-relay-service/main/install.sh | sudo bash
```

或先下载再执行（方便查看/自定义参数）：

```bash
curl -fsSL https://raw.githubusercontent.com/zhouzh528/llm-relay-service/main/install.sh -o install.sh
sudo bash install.sh                          # 默认: /opt/relay-service, 应用端口 13000, Nginx 对外 8080 / 管理 28080
sudo bash install.sh /opt/relay-service 14000  # 自定义安装目录与应用监听端口
```

### 交互式 / 非交互式

- **交互式终端**：脚本会提示应用监听端口、Nginx 对外/管理端口、管理员用户名/密码（>=8 字符，含数字/字母/特殊字符）、Redis 部署方式（已有实例 / 新启独立实例）。回车可跳过用自动生成的值。
- **非交互式终端**（如管道执行）：自动走默认值——新建一个仅本地访问的独立 Redis 实例（随机密码、端口 6380 起自动避让），管理员账号密码随机生成。安装完成后从 `data/init.json` 查看凭据。

### 安装完成后

```bash
systemctl status relay-service     # 服务状态
systemctl restart relay-service    # 重启
journalctl -u relay-service -f     # 实时日志
cat /opt/relay-service/data/init.json  # 首次管理员凭据
```

管理面板访问：`http://<服务器IP>:<端口>/admin-next/`。

### 升级

安装脚本会把代码切到最新的正式发布 tag（`vX.Y.Z`）。之后推荐直接在管理台升级：账户菜单 → **检查更新**，确认变更清单后点击升级。服务端会拉取目标 tag、按需安装依赖和构建前端，再由 systemd 以新代码重新拉起；任一步失败都会回退，服务继续以旧版本运行。

> 只有推送到仓库的 `vX.Y.Z` tag 才会被识别为新版本，`main` 上未打 tag 的提交不会触发升级提示；`-rc` 等预发布 tag 默认也不提示。

手动升级（`<vX.Y.Z>` 替换为目标版本）：

```bash
cd /opt/relay-service
git fetch --tags origin
git checkout --detach refs/tags/<vX.Y.Z>
npm install --omit=dev
npm run build:web
systemctl restart relay-service
```

### 重装行为（重要）

重复运行 `install.sh` 是安全的：
- `JWT_SECRET` / `ENCRYPTION_KEY` **保留不变**（否则旧会话、旧 AES 密文将全部失效）
- Redis 地址/端口/密码会根据本次执行结果同步回 `.env`（`setup_redis_new` 每次会生成新的 Redis 密码并覆盖 `redis.conf`，同步这一步避免两边不一致）
- 旧 systemd unit 会被先禁用再替换，防止 `Restart=always` 的残留实例干扰

### 一键安装失败时

前端构建失败是最常见问题（lint / prettier）。脚本会把 `npm run install:web && npm run build:web` 的完整输出记在 `/tmp/relay-install-build.XXXXXX.log`，失败时自动打印最后 60 行到 stderr 并给出修复命令。

如需手动控制流程，见下方"📦 手动部署"。

---

## 📦 手动部署

### 第一步：环境准备

**Ubuntu/Debian用户：**

```bash
# 安装Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装Redis
sudo apt update
sudo apt install redis-server
sudo systemctl start redis-server
```

**CentOS/RHEL用户：**

```bash
# 安装Node.js
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# 安装Redis
sudo yum install redis
sudo systemctl start redis
```

### 第二步：下载和配置

```bash
# 下载项目
git clone https://github.com/zhouzh528/llm-relay-service.git
cd llm-relay-service

# 安装依赖
npm install

# 复制配置文件（重要！）
cp config/config.example.js config/config.js
cp .env.example .env
```

### 第三步：配置文件设置

**编辑 `.env` 文件：**

```bash
# 这两个密钥随便生成，但要记住
JWT_SECRET=你的超级秘密密钥
ENCRYPTION_KEY=32位的加密密钥随便写

# Redis配置
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

```

**编辑 `config/config.js` 文件：**

```javascript
module.exports = {
  server: {
    port: 13000, // 应用监听端口（默认只绑 127.0.0.1，由 Nginx 对外）
    host: '0.0.0.0' // 不用改
  },
  redis: {
    host: '127.0.0.1', // Redis地址
    port: 6379 // Redis端口
  }
  // 其他配置保持默认就行
}
```

### 第四步：安装前端依赖并构建

```bash
# 安装前端依赖
npm run install:web

# 构建前端（生成 dist 目录）
npm run build:web
```

### 第五步：启动服务

```bash
# 初始化
npm run setup # 会随机生成后台账号密码信息，存储在 data/init.json
# 或者通过环境变量预设管理员凭据：
# export ADMIN_USERNAME=cr_admin_custom
# export ADMIN_PASSWORD=your-secure-password

# 启动服务
npm run service:start:daemon   # 后台运行

# 查看状态
npm run service:status
```

### 服务管理命令

通过 `scripts/manage.js`（PID + nohup，跨平台）管理服务进程：

```bash
npm run service:start:daemon   # 启动（后台运行，终端可安全关闭）
npm run service:stop           # 停止（优雅关闭，超时自动强制结束）
npm run service:restart        # 重启（加载最新配置）
npm run service:update         # 更新（git pull → 装依赖 → 构建前端 → 自动后台重启）
npm run service:status         # 查看状态
npm run service:logs           # 查看日志
```

> 元数据默认持久化到 **SQLite**（`data/metadata.db`），Redis 仅作缓存与热状态，仅支持单实例部署。如需放回 Redis，在 `.env` 设 `METADATA_BACKEND=redis`；从已有 Redis 数据迁移到 SQLite 见 `docs/metadata-storage-guide`。

---

## 🔀 Claude Code 使用 GPT 模型（Anthropic → OpenAI 适配）

让 Claude Code（只会说 Anthropic Messages API）经中转由 GPT（OpenAI Chat Completions 兼容端点）承载推理。

**工作方式**：新增路由 `POST /claude/openai/v1/messages` 接收 Anthropic 请求 → 转换为 OpenAI Chat Completions → 转发到 `openai-compatible` 账号的 `{baseUrl}/v1/chat/completions` → 响应/流式转回 Anthropic 格式。原生 `/v1/messages → Claude` 链路不受影响。

**1. 创建 openai-compatible 账号**（暂无管理后台表单，先用脚本/REPL）：

```js
await require('./src/services/account/openaiCompatibleAccountService').createAccount({
  name: 'gpt',
  baseUrl: 'https://api.openai.com', // 任意 OpenAI 兼容端点
  apiKey: 'sk-...',
  defaultModel: 'gpt-4o-mini',
  // 可选：claude 模型名 → 目标 GPT 模型（支持 * 前缀通配）
  modelMapping: { 'claude-3-5-haiku-*': 'gpt-4o-mini', 'claude-sonnet-*': 'gpt-4o' }
})
```

**2. 给 API Key 赋予 `openai` 权限**（管理后台编辑 Key 的权限）。

**3. 配置 Claude Code** 指向该前缀：

```bash
export ANTHROPIC_BASE_URL=http://<host>:<port>/claude/openai
export ANTHROPIC_API_KEY=cr_你的key
```

**目标模型解析顺序**：请求头 `x-target-model`（或 body `target_model`）覆盖 → 账号 `modelMapping`（精确/前缀）→ 出厂默认（haiku→gpt-4o-mini、sonnet/opus→gpt-4o）→ 账号 `defaultModel`。客户端的 `claude-*` 名不会透传给上游。

> 说明：`thinking`、`cache_control`、1M 上下文等 Anthropic 专有特性在 Chat Completions 无对应，会被安全忽略；成本按实际 GPT 模型由 `pricingService` 计算。

---

## 🎮 开始使用

### 1. 打开管理界面

浏览器访问：`http://你的服务器IP:28080/admin-next/`

管理员账号：

- 自动生成：查看 data/init.json
- 环境变量预设：通过 ADMIN_USERNAME 和 ADMIN_PASSWORD 设置

### 2. 添加Claude账户

这一步比较关键，需要OAuth授权：

1. 点击「Claude账户」标签
2. 如果你担心多个账号共用1个IP怕被封禁，可以选择设置静态代理IP（可选）
3. 点击「添加账户」
4. 点击「生成授权链接」，会打开一个新页面
5. 在新页面完成Claude登录和授权
6. 复制返回的Authorization Code
7. 粘贴到页面完成添加

**注意**: 如果你在国内，这一步可能需要科学上网。

### 2.1 临时暂停（503/5xx）与账号级 TTL 覆盖

系统会在上游异常时临时暂停账号路由，默认由全局配置控制（见 `.env.example`）：

- `UPSTREAM_ERROR_503_TTL_SECONDS`
- `UPSTREAM_ERROR_5XX_TTL_SECONDS`
- `UPSTREAM_ERROR_OVERLOAD_TTL_SECONDS`
- `UPSTREAM_ERROR_AUTH_TTL_SECONDS`
- `UPSTREAM_ERROR_TIMEOUT_TTL_SECONDS`

在管理后台编辑 **Claude 官方 OAuth 账号** 时，可做账号级覆盖：

- `禁用该账号临时冷却`：该账号不再因 503/5xx 进入临时暂停
- `503 冷却秒数`：留空=跟随全局，`0`=关闭该账号 503 冷却
- `5xx 冷却秒数`：留空=跟随全局，`0`=关闭该账号 5xx 冷却

优先级从高到低：

1. 账号级“禁用临时冷却”
2. 账号级 503/5xx 冷却秒数
3. 代码调用时传入的自定义 TTL（若有）
4. 全局环境变量默认值

账户列表会显示“不可路由原因”，包含错误类型、HTTP 状态码、内部冷却总时长、剩余时间和预计恢复时间；点击 `重置状态` 可清除异常状态并恢复参与路由。

### 3. 创建API Key

给每个使用者分配一个Key：

1. 点击「API Keys」标签
2. 点击「创建新Key」
3. 给Key起个名字，比如「张三的Key」
4. 设置使用限制（可选）：
   - **速率限制**: 限制每个时间窗口的请求次数和Token使用量
   - **并发限制**: 限制同时处理的请求数
   - **模型限制**: 限制可访问的模型列表
   - **客户端限制**: 限制只允许特定客户端使用（如ClaudeCode、Gemini-CLI等）
5. 保存，记下生成的Key

### 4. 开始使用 Claude Code 和 Gemini CLI

现在你可以用自己的服务替换官方API了：

**Claude Code 设置环境变量：**


**使用标准 Claude 账号池**

默认使用标准 Claude 账号池：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080/api/" # 根据实际填写你服务器的ip地址或者域名
export ANTHROPIC_AUTH_TOKEN="后台创建的API密钥"
```

**使用 Antigravity 账户池**

适用于通过 Antigravity 渠道使用 Claude 模型（如 `claude-opus-4-5` 等）。

```bash
# 1. 设置 Base URL 为 Antigravity 专用路径
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080/antigravity/api/"

# 2. 设置 API Key（在后台创建，权限需包含 'all' 或 'gemini'）
export ANTHROPIC_AUTH_TOKEN="后台创建的API密钥"

# 3. 指定模型名称（直接使用短名，无需前缀！）
export ANTHROPIC_MODEL="claude-opus-4-5"

# 4. 启动
claude
```

**VSCode Claude 插件配置：**

如果使用 VSCode 的 Claude 插件，需要在 `~/.claude/config.json` 文件中配置：

```json
{
    "primaryApiKey": "crs"
}
```

如果该文件不存在，请手动创建。Windows 用户路径为 `C:\Users\你的用户名\.claude\config.json`。

> 💡 **IntelliJ IDEA 用户推荐**：[Claude Code Plus](https://github.com/touwaeriol/claude-code-plus) - 将 Claude Code 直接集成到 IDE，支持代码理解、文件读写、命令执行。插件市场搜索 `Claude Code Plus` 即可安装。

**Gemini CLI 设置环境变量：**

**方式一（推荐）：通过 Gemini Assist API 方式访问**

```bash
CODE_ASSIST_ENDPOINT="http://127.0.0.1:8080/gemini"  # 根据实际填写你服务器的ip地址或者域名
GOOGLE_CLOUD_ACCESS_TOKEN="后台创建的API密钥"
GOOGLE_GENAI_USE_GCA="true"
GEMINI_MODEL="gemini-2.5-pro" # 如果你有gemini3权限可以填： gemini-3-pro-preview
```

> **认证**：只能选 ```Login with Google``` 进行认证，如果跳 Google请删除 ```~/.gemini/settings.json``` 后再尝试启动```gemini```。  
> **注意**：gemini-cli 控制台会提示 `Failed to fetch user info: 401 Unauthorized`，但使用不受任何影响。  

**方式二：通过 Gemini API 方式访问**


```bash
GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:8080/gemini"  # 根据实际填写你服务器的ip地址或者域名
GEMINI_API_KEY="后台创建的API密钥"
GEMINI_MODEL="gemini-2.5-pro" # 如果你有gemini3权限可以填： gemini-3-pro-preview
```

> **认证**：只能选 ```Use Gemini API Key``` 进行认证，如果提示 ```Enter Gemini API Key``` 请直接留空按回车。如果一打开就跳 Google请删除 ```~/.gemini/settings.json``` 后再尝试启动```gemini```。

> 💡 **进阶用法**：想在 Claude Code 中直接使用 Gemini 3 模型？请参考 [Claude Code 调用 Gemini 3 模型指南](docs/claude-code-gemini3-guide/README.md)

**使用 Claude Code：**

```bash
claude
```

**使用 Gemini CLI：**

```bash
gemini  # 或其他 Gemini CLI 命令
```

**Codex 配置：**

在 `~/.codex/config.toml` 文件**开头**添加以下配置：

```toml
model_provider = "crs"
model = "gpt-5.1-codex-max"
model_reasoning_effort = "high"
disable_response_storage = true
preferred_auth_method = "apikey"

[model_providers.crs]
name = "crs"
base_url = "http://127.0.0.1:8080/openai"  # 根据实际填写你服务器的ip地址或者域名
wire_api = "responses"
requires_openai_auth = true
```

在 `~/.codex/auth.json` 文件中配置API密钥为 null：

```json
{
    "OPENAI_API_KEY": "后台创建的API密钥"  
}
```

> ⚠️ 在通过 Nginx 反向代理 CRS 服务并使用 Codex CLI 时，需要在 http 块中添加 underscores_in_headers on;。因为 Nginx 默认会移除带下划线的请求头（如 session_id），一旦该头被丢弃，多账号环境下的粘性会话功能将失效。

**Droid CLI 配置：**

Droid CLI 读取 `~/.factory/config.json`。可以在该文件中添加自定义模型以指向本服务的新端点：

```json
{
  "custom_models": [
    {
      "model_display_name": "Opus 4.5 [crs]",
      "model": "claude-opus-4-5-20251101",
      "base_url": "http://127.0.0.1:8080/droid/claude",
      "api_key": "后台创建的API密钥",
      "provider": "anthropic",
      "max_tokens": 64000
    },
    {
      "model_display_name": "GPT5-Codex [crs]",
      "model": "gpt-5-codex",
      "base_url": "http://127.0.0.1:8080/droid/openai",
      "api_key": "后台创建的API密钥",
      "provider": "openai",
      "max_tokens": 16384
    },
    {
      "model_display_name": "Gemini-3-Pro [crs]",
      "model": "gemini-3-pro-preview",
      "base_url": "http://127.0.0.1:8080/droid/comm/v1/",
      "api_key": "后台创建的API密钥",
      "provider": "generic-chat-completion-api",
      "max_tokens": 65535
    },
    {
      "model_display_name": "GLM-4.6 [crs]",
      "model": "glm-4.6",
      "base_url": "http://127.0.0.1:8080/droid/comm/v1/",
      "api_key": "后台创建的API密钥",
      "provider": "generic-chat-completion-api",
      "max_tokens": 202800
    }
  ]
}
```

> 💡 将示例中的 `http://127.0.0.1:8080` 替换为你的服务域名或公网地址，并写入后台生成的 API 密钥（cr_ 开头）。

### 5. 第三方工具API接入

本服务支持多种API端点格式，方便接入不同的第三方工具（如Cherry Studio等）。

#### Cherry Studio 接入示例

Cherry Studio支持多种AI服务的接入，下面是不同账号类型的详细配置：

**1. Claude账号接入：**

```
# API地址
http://你的服务器:8080/claude

# 模型ID示例
claude-sonnet-4-5-20250929 # Claude Sonnet 4.5
claude-opus-4-20250514     # Claude Opus 4
```

配置步骤：
- 供应商类型选择"Anthropic"
- API地址填入：`http://你的服务器:8080/claude`
- API Key填入：后台创建的API密钥（cr_开头）

**2. Gemini账号接入：**

```
# API地址
http://你的服务器:8080/gemini

# 模型ID示例
gemini-2.5-pro             # Gemini 2.5 Pro
```

配置步骤：
- 供应商类型选择"Gemini"
- API地址填入：`http://你的服务器:8080/gemini`
- API Key填入：后台创建的API密钥（cr_开头）

**3. Codex接入：**

```
# API地址
http://你的服务器:8080/openai

# 模型ID（固定）
gpt-5                      # Codex使用固定模型ID
```

配置步骤：
- 供应商类型选择"Openai-Response"
- API地址填入：`http://你的服务器:8080/openai`
- API Key填入：后台创建的API密钥（cr_开头）
- **重要**：Codex只支持Openai-Response标准


**Cherry Studio 地址格式重要说明：**

- ✅ **推荐格式**：`http://你的服务器:8080/claude`（不加结尾 `/`，让 Cherry Studio 自动加上 v1）
- ✅ **等效格式**：`http://你的服务器:8080/claude/v1/`（手动指定 v1 并加结尾 `/`）
- 💡 **说明**：这两种格式在 Cherry Studio 中是完全等效的
- ❌ **错误格式**：`http://你的服务器:8080/claude/`（单独的 `/` 结尾会被 Cherry Studio 忽略 v1 版本）

#### 其他第三方工具接入

**接入要点：**

- 所有账号类型都使用相同的API密钥（在后台统一创建）
- 根据不同的路由前缀自动识别账号类型
- `/claude/` - 使用Claude账号池
- `/antigravity/api/` - 使用Antigravity账号池（推荐用于Claude Code）
- `/droid/claude/` - 使用Droid类型Claude账号池（只建议api调用或Droid Cli中使用）
- `/gemini/` - 使用Gemini账号池
- `/openai/` - 使用Codex账号（只支持Openai-Response格式）
- `/droid/openai/` - 使用Droid类型OpenAI兼容账号池（只建议api调用或Droid Cli中使用）
- 支持所有标准API端点（messages、models等）

**重要说明：**

- 确保在后台已添加对应类型的账号（Claude/Gemini/Codex）
- API密钥可以通用，系统会根据路由自动选择账号类型
- 建议为不同用户创建不同的API密钥便于使用统计

---

## 🔧 日常维护

### 服务管理

```bash
# 查看服务状态
npm run service:status

# 查看日志
npm run service:logs

# 重启服务
npm run service:restart:daemon

# 停止服务
npm run service:stop
```

### 监控使用情况

- **Web界面**: `http://你的域名:8080/web` - 查看使用统计
- **健康检查**: `http://你的域名:8080/health` - 确认服务正常
- **日志文件**: `logs/` 目录下的各种日志文件

### 灾备与恢复

元数据（API Keys、各平台账户、tags、管理员凭据）有两条互补的备份/恢复路径：

**文件级**（SQLite 整库，适合整机灾备）：

```bash
npm run data:backup                                        # 热备份 → data/backup/，自动保留最近 14 份
systemctl stop relay-app                                   # 恢复须先停服
npm run data:restore -- --input=data/backup/metadata-<ts>.db
systemctl start relay-app
```

已部署 `relay-backup.timer` 每日 02:00 自动备份（`systemctl list-timers relay-backup.timer` 查看）。

**条目级**（Web 管理端，适合部分恢复/跨实例迁移，在线执行）：

管理界面「备份导出/导入」（`/admin/backup/export` / `/admin/backup/import`），跳过已存在条目，
导入后自动同步 SQLite 并清理索引/缓存。

两条路径的取舍与恢复后动作详见 [docs/metadata-storage-guide](docs/metadata-storage-guide/README.md)。

#### 跨机迁移与 ENCRYPTION_KEY

备份文件里的账户凭据是密文，且与**导出机**的 `ENCRYPTION_KEY` 硬绑定。目标机若用自己的密钥，
导入会「成功」、账户在管理台也「可见」，但每一次上游调用都是 401，后台只显示「账号异常」——
全链路没有一处会告诉你问题在密钥上。所以迁移的顺序不能反：

```bash
# 目标机：先把 ENCRYPTION_KEY 设成源机的值，且必须在建立任何数据之前
grep '^ENCRYPTION_KEY=' /path/to/源机/.env      # 取源机的值
vi .env                                         # 覆盖目标机的 ENCRYPTION_KEY
systemctl restart relay-app                     # 再启动，然后才导入备份
```

一键安装脚本（`scripts/manage.sh`）会为新装机器生成一个随机 `ENCRYPTION_KEY`，这是最容易踩反的
一步：先起了服务、建了管理员和账户，再回头改密钥就晚了 —— 那批新数据会连同旧备份一起解不开。

启动时服务会抽样试解库中已有密文，在日志里给出结论，迁移后看这一行即可确认：

```
🔑 ENCRYPTION_KEY self-check passed (抽样 3 条，平台 claude、openai，200ms，指纹 87389747817f)
🔑 ENCRYPTION_KEY 与库中已有密文不匹配：openai(失败 4 条: openaiOauth)。当前密钥指纹 ...
🔑 ENCRYPTION_KEY self-check skipped：库中暂无可抽样的密文字段（新装实例的正常状态）
```

自检只读、不阻断启动。出现 error 那行就说明密钥错配，此时**不要**继续往里灌数据，先把密钥改回去。
日志只输出平台、账户标识与字段名，不含密钥、密文与解密所得明文；其中的指纹经独立 salt 派生并截断，
不等于任何平台实际使用的密钥。

本服务**不提供**跨密钥重加密，也不在导入时做密钥闸门（错配时闸门本身也无从判断该拦谁）。已知只有
两个场景确实需要重加密：旧密钥泄露必须轮换，以及两台各自都有数据的实例要合并 —— 这两种情况下的做法
是在源机上把凭据重新录一遍，而不是搬密文。

最后，备份文件含可解密的账户凭据与明文管理员凭据，须按机密文件保管，不要放进代码仓库或对象存储的
公开桶。

### 升级指南

当有新版本发布时，按照以下步骤升级服务：

```bash
# 1. 进入项目目录
cd llm-relay-service

# 2. 拉取最新代码
git pull origin main

# 如果遇到 package-lock.json 冲突，使用远程版本
git checkout --theirs package-lock.json
git add package-lock.json

# 3. 安装新的依赖（如果有）
npm install

# 4. 安装并构建前端
npm run install:web
npm run build:web

# 5. 重启服务
npm run service:restart:daemon

# 6. 检查服务状态
npm run service:status
```

**注意事项：**

- 升级前建议备份重要配置文件（.env, config/config.js）
- 查看更新日志了解是否有破坏性变更
- 如果有数据库结构变更，会自动迁移

---

## 🔒 客户端限制功能

### 功能说明

客户端限制功能允许你控制每个API Key可以被哪些客户端使用，通过User-Agent识别客户端，提高API的安全性。

### 使用方法

1. **在创建或编辑API Key时启用客户端限制**：
   - 勾选"启用客户端限制"
   - 选择允许的客户端（支持多选）

2. **预定义客户端**：
   - **ClaudeCode**: 官方Claude CLI（匹配 `claude-cli/x.x.x (external, cli)` 格式）
   - **Gemini-CLI**: Gemini命令行工具（匹配 `GeminiCLI/vx.x.x (platform; arch)` 格式）

3. **调试和诊断**：
   - 系统会在日志中记录所有请求的User-Agent
   - 客户端验证失败时会返回403错误并记录详细信息
   - 通过日志可以查看实际的User-Agent格式，方便配置自定义客户端


### 日志示例

认证成功时的日志：

```
🔓 Authenticated request from key: 测试Key (key-id) in 5ms
   User-Agent: "claude-cli/1.0.58 (external, cli)"
```

客户端限制检查日志：

```
🔍 Checking client restriction for key: key-id (测试Key)
   User-Agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
   Allowed clients: claude_code, gemini_cli
🚫 Client restriction failed for key: key-id (测试Key) from 127.0.0.1, User-Agent: Mozilla/5.0...
```

### 常见问题处理

**Redis连不上？**

```bash
# 检查Redis是否启动
redis-cli ping

# 应该返回 PONG
```

**OAuth授权失败？**

- 检查代理设置是否正确
- 确保能正常访问 claude.ai
- 清除浏览器缓存重试

**API请求失败？**

- 检查API Key是否正确
- 查看日志文件找错误信息
- 确认Claude账户状态正常

---

## 🛠️ 进阶

### 应用层 HTTPS（私有 CA，适合内部/固定 IP 部署）

若部署环境**没有公网域名**（例如仅通过固定 IP 对内部团队暴露），可直接由应用层开启 HTTPS。启用后服务会自动生成一套**私有 CA + server 证书**，管理员在后台下载根 CA 分发给各客户端导入系统信任库。

> 📖 **完整文档**：[应用层 HTTPS（私有 CA）使用指南](docs/https-private-ca-guide/README.md) — 含工作原理、系统级/SDK 级信任分发、环境变量速查、常见错误排查。

**最小启用步骤：**

1. 在 `.env` 中追加：
   ```env
   HTTPS_ENABLED=true
   HTTPS_SAN=IP:<公网IP>,DNS:localhost,IP:127.0.0.1
   ```
2. 重启服务（首次启动自动生成 CA + server 证书，日志会打印生成耗时与文件路径）
3. 登录管理后台 → 系统设置 → **HTTPS 状态** → 下载 `ca.crt`
4. 将 `ca.crt` 分发到各客户端：
   - **macOS**：双击导入钥匙串 → 始终信任
   - **Windows**：`certmgr.msc` → 受信任的根证书颁发机构 → 导入
   - **Linux**：`sudo cp ca.crt /usr/local/share/ca-certificates/relay-ca.crt && sudo update-ca-certificates`
5. 对 Node/Python 等 SDK（默认不读系统信任 store），额外设置环境变量：
   - **Node**：`NODE_EXTRA_CA_CERTS=/path/to/ca.crt`
   - **Python requests/httpx**：`REQUESTS_CA_BUNDLE=/path/to/ca.crt`
6. 客户端改用 `https://<IP>:3443`（或通过 `443:3443` 映射的宿主端口）访问

**SAN 变更**（新增客户端 IP）：改 `HTTPS_SAN` → 删 `data/certs/server.*` → 重启（CA 保持不变，客户端无需重新导入）。
**回滚**：`HTTPS_ENABLED=false` + 重启，服务恢复 HTTP 监听。

> ⚠️ **注意事项**：
>
> - 若前面已经挂了反向代理（Nginx/Caddy）做 TLS 终结，**不要**同时启用应用层 HTTPS——这通常属于误配。参考下文"反向代理部署指南"。
> - **`ca.key` 永远不会通过任何后台接口对外返回**；仅 `ca.crt`（公钥）可下载。请妥善保管 `data/certs/ca.key`——泄露等同于整条私有信任链失陷。
> - 切换 HTTP ↔ HTTPS 后，已配置的 OAuth 账号（Claude / Gemini / Antigravity 等）其回调 URL 若基于旧协议，可能需要在账号管理中重新绑定授权。

---

### 元数据存储（Redis vs SQLite）

默认 `METADATA_BACKEND=redis`，账号 / API Key / 标签都放在 Redis 里。如果你的 Redis 是托管服务或纯缓存（不能依赖其持久化），可切换到 `sqlite`：

```
METADATA_BACKEND=sqlite
SQLITE_PATH=./data/metadata.db
SQLITE_STATS_FLUSH_INTERVAL=30
```

切换后 Redis 仍在使用，但降级为**缓存层 + 热状态**（并发计数、限流、会话、实时 usage 统计），即使 Redis 被重启 / 清空也不会丢失任何账号或 API Key。

**切换步骤**：`npm run data:migrate:dry` → `npm run data:migrate` → 改 `.env` → 重启。详细流程见 [元数据存储运维指南](docs/metadata-storage-guide/README.md)。

> ⚠️ SQLite 后端**仅支持单实例部署**；多进程同时写入会导致文件锁冲突。

---

### 反向代理部署指南

在生产环境中，建议通过反向代理进行连接，以便使用自动 HTTPS、安全头部和性能优化。下面提供三种方案：**install.sh 内置 Nginx（推荐，自动完成）**、**Caddy** 和 **Nginx Proxy Manager (NPM)**。

---

## Nginx 方案（install.sh 内置，推荐）

`install.sh` 默认会安装并配置 Nginx，把 **对外 API** 与 **后台管理** 拆到两个端口；应用自身只监听回环地址，两个入口的隔离由 Nginx 完成。

| 入口 | 默认端口 | 说明 |
|---|---|---|
| 对外 API | `8080` | Claude Code / Codex 等客户端指向这里。仅放行 `/api` `/claude` `/gemini` `/openai` `/droid` `/azure` 与 `/health`，**其余路径（含管理面）一律 404** |
| 后台管理 | `28080` | 管理台 `/admin-next/` 与全部管理 API |
| 应用监听 | `13000` | 仅绑定 `127.0.0.1`，不直接对外 |

生成的文件：

- `/etc/nginx/conf.d/relay-service.conf` —— 两个 `server` 块 + `upstream relay_backend`
- `/etc/nginx/relay_proxy.conf` —— 公共代理参数（SSE 友好：`proxy_buffering off`、`proxy_read_timeout 3600s`、`Connection ""`、`chunked_transfer_encoding on`）

端口可在安装时交互修改，也可用环境变量覆盖：

```bash
# 默认：装 Nginx，对外 8080 / 管理 28080，应用监听 13000
sudo bash install.sh /opt/relay-service 13000

# 自定义两个对外端口
NGINX_PUBLIC_PORT=8080 NGINX_ADMIN_PORT=28080 sudo -E bash install.sh /opt/relay-service 13000

# 不装 Nginx：应用端口直接对外（管理台与 API 同端口可达）
NGINX_MODE=no sudo -E bash install.sh
```

对应的配置项在 `config/config.js` 的 `server` 与 `nginx` 两段，`.env` 中为 `PORT` / `HOST` / `NGINX_PUBLIC_PORT` / `NGINX_ADMIN_PORT`。

> ⚠️ 两点注意：
> 1. 生成的配置带有 `underscores_in_headers on;`。Nginx 默认会丢弃带下划线的请求头（如 Codex CLI 的 `session_id`），缺了它多账号下的粘性会话会失效。
> 2. 若手动把 `HOST` 改成 `0.0.0.0`，管理台会绕过 Nginx 直接暴露在应用端口上——启动日志会打印告警。

---

## Caddy 方案

Caddy 是一款自动管理 HTTPS 证书的 Web 服务器，配置简单、性能优秀，很适合不需要额外依赖的部署方案。

**1. 安装 Caddy**

```bash
# Ubuntu/Debian
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# CentOS/RHEL/Fedora
sudo yum install yum-plugin-copr
sudo yum copr enable @caddy/caddy
sudo yum install caddy
```

**2. Caddy 配置**

编辑 `/etc/caddy/Caddyfile` ：

```caddy
your-domain.com {
    # 反向代理到本地服务
    reverse_proxy 127.0.0.1:13000 {
        # 支持流式响应或 SSE
        flush_interval -1

        # 传递真实 IP
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}

        # 长读/写超时配置
        transport http {
            read_timeout 300s
            write_timeout 300s
            dial_timeout 30s
        }
    }

    # 安全头部
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        -Server
    }
}
```

**3. 启动 Caddy**

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl start caddy
sudo systemctl enable caddy
sudo systemctl status caddy
```

**4. 服务配置**

Caddy 会自动管理 HTTPS，因此可以将服务限制在本地进行监听：

```javascript
// config/config.js
module.exports = {
  server: {
    port: 13000,
    host: '127.0.0.1' // 只监听本地
  }
}
```

**Caddy 特点**

* 🔒 自动 HTTPS，零配置证书管理
* 🛡️ 安全默认配置，启用现代 TLS 套件
* ⚡ HTTP/2 和流式传输支持
* 🔧 配置文件简洁，易于维护

---

## Nginx Proxy Manager (NPM) 方案

Nginx Proxy Manager 通过图形化界面管理反向代理和 HTTPS 证书，並以 Docker 容器部署。

> 注意：默认 `HOST=127.0.0.1` 时应用只监听宿主机回环地址，容器内的 NPM 无法直连。
> 用 NPM 时需把 `HOST` 改为 `0.0.0.0`（这会把管理台一并暴露，请配合防火墙/安全组限制），
> 或让 NPM 使用宿主机网络。推荐直接使用上面的内置 Nginx 方案。

**1. 在 NPM 创建新的 Proxy Host**

Details 配置如下：

| 项目                    | 设置                      |
| --------------------- | ----------------------- |
| Domain Names          | relay.example.com       |
| Scheme                | http                    |
| Forward Hostname / IP | 192.168.0.1 (docker 机器 IP) |
| Forward Port          | 13000                   |
| Block Common Exploits | ☑️                      |
| Websockets Support    | ❌ **关闭**                |
| Cache Assets          | ❌ **关闭**                |
| Access List           | Publicly Accessible     |

> 注意：
> - 请确保 Relay Service **监听 host 为 `0.0.0.0` 、容器 IP 或本机 IP**，以便 NPM 实现内网连接。
> - **Websockets Support 和 Cache Assets 必须关闭**，否则会导致 SSE / 流式响应失败。

**2. Custom locations**

無需添加任何内容，保持为空。

**3. SSL 设置**

* **SSL Certificate**: Request a new SSL Certificate (Let's Encrypt) 或已有证书
* ☑️ **Force SSL**
* ☑️ **HTTP/2 Support**
* ☑️ **HSTS Enabled**
* ☑️ **HSTS Subdomains**

**4. Advanced 配置**

Custom Nginx Configuration 中添加以下内容：

```nginx
# 传递真实用户 IP
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;

# 支持 WebSocket / SSE 等流式通信
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_buffering off;

# 长连接 / 超时设置（适合 AI 聊天流式传输）
proxy_read_timeout 300s;
proxy_send_timeout 300s;
proxy_connect_timeout 30s;

# ---- 安全性设置 ----
# 严格 HTTPS 策略 (HSTS)
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# 阻挡点击劫持与内容嗅探
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;

# Referrer / Permissions 限制策略
add_header Referrer-Policy "no-referrer-when-downgrade" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

# 隐藏服务器信息（等效于 Caddy 的 `-Server`）
proxy_hide_header Server;

# ---- 性能微调 ----
# 关闭代理端缓存，确保即时响应（SSE / Streaming）
proxy_cache_bypass $http_upgrade;
proxy_no_cache $http_upgrade;
proxy_request_buffering off;
```

**4. 启动和验证**

* 保存后等待 NPM 自动申请 Let's Encrypt 证书（如果有）。
* Dashboard 中查看 Proxy Host 状态，确保显示为 "Online"。
* 访问 `https://relay.example.com`，如果显示绿色锁图标即表示 HTTPS 正常。

**NPM 特点**

* 🔒 自动申请和续期证书
* 🔧 图形化界面，方便管理多服务
* ⚡ 原生支持 HTTP/2 / HTTPS

---

上述方案均可用于生产部署。

---

## 💡 使用建议

### 账户管理

- **定期检查**: 每周看看账户状态，及时处理异常
- **合理分配**: 可以给不同的人分配不同的apikey，可以根据不同的apikey来分析用量

### 安全建议

- **使用HTTPS**: 强烈建议使用Caddy反向代理（自动HTTPS），确保数据传输安全
- **定期备份**: 重要配置和数据要备份
- **监控日志**: 定期查看异常日志
- **更新密钥**: 定期更换JWT和加密密钥
- **防火墙设置**: 只开放必要的端口（80, 443），隐藏直接服务端口

---

## 🆘 遇到问题怎么办？

### 自助排查

1. **查看日志**: `logs/` 目录下的日志文件
2. **检查配置**: 确认配置文件设置正确
3. **测试连通性**: 用 curl 测试API是否正常
4. **重启服务**: 有时候重启一下就好了

### 寻求帮助

- **GitHub Issues**: 提交详细的错误信息
- **查看文档**: 仔细阅读错误信息和文档
- **社区讨论**: 看看其他人是否遇到类似问题

---

## 📄 许可证

本项目采用 [MIT 许可证](LICENSE)。

### 来源声明

本仓库 fork 自 [Wei-Shaw/claude-relay-service](https://github.com/Wei-Shaw/claude-relay-service) **v1.1.300** 版本，遵循 MIT 协议继续开源分发。
原版权声明 `Copyright (c) 2025 Wesley Liddick` 及 MIT 许可全文保留于 [LICENSE](LICENSE) 文件中。

---

<div align="center">

**🤝 有问题欢迎提 Issue，有改进建议欢迎 PR**

</div>
