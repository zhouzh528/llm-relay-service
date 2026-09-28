# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Relay Service — 多平台 AI API 中转服务，作为客户端与上游 AI API 之间的中间件。
支持 Claude (官方/Console)、Gemini、OpenAI Responses、AWS Bedrock、Azure OpenAI、Droid、CCR 等账户类型。
核心能力：多账户管理、API Key 认证、统一调度、代理配置、限流、成本统计。

## 架构原则

### Clean Architecture 分层映射

| 层级 | 目录 | 职责 |
|------|------|------|
| **框架层** | `src/routes/`, `src/middleware/` | HTTP 路由、请求验证、响应格式化 |
| **接口适配层** | `src/handlers/`, `src/services/openaiToClaude.js` | 请求/响应格式转换 |
| **用例层** | `src/services/*Scheduler.js`, `*RelayService.js` | 调度逻辑、转发编排 |
| **实体层** | `src/services/*AccountService.js`, `src/models/` | 账户管理、数据模型 |
| **基础设施层** | `src/utils/`, `config/` | 日志、缓存、加密、代理 |

### 开发原则

- **依赖方向**: 外层 → 内层，内层不知道外层存在
- **新增路由**: 只做参数提取和响应格式化，业务逻辑放 service
- **新增服务**: 先确定属于哪一层，遵循该层职责边界
- **格式转换**: 不同 API 格式的转换放 handlers 或专用转换服务
- **数据访问**: 通过 `src/models/redis.js` 统一访问

### 安全约束

- 敏感数据（OAuth token、refreshToken、credentials）必须 AES 加密存储（参考 `claudeAccountService.js`）
- API Key 使用 SHA-256 哈希存储，禁止明文
- 每个请求必须经过完整认证链（API Key → 权限 → 客户端限制 → 模型黑名单）
- 客户端断开时必须通过 AbortController 清理资源和并发计数
- 日志中禁止输出完整 token，使用 `tokenMask.js` 脱敏

## 项目结构

```
src/
├── routes/              # HTTP 路由
│   ├── api.js           # Claude API 主路由
│   ├── admin/           # 管理后台路由（24个子文件）
│   ├── geminiRoutes.js, standardGeminiRoutes.js
│   ├── openaiRoutes.js, openaiClaudeRoutes.js, openaiGeminiRoutes.js
│   ├── azureOpenaiRoutes.js, droidRoutes.js
│   ├── userRoutes.js, webhook.js, unified.js, apiStats.js, web.js
├── middleware/           # auth.js(认证/权限/限流), browserFallback.js
├── handlers/             # geminiHandlers.js
├── services/             # 业务服务
│   ├── relay/                 # 各平台转发服务（9个）
│   ├── account/               # 各平台账户管理（11个）
│   ├── scheduler/             # 统一调度器（4个）
│   ├── apiKeyService.js       # API Key 管理
│   ├── pricingService.js      # 定价和成本
│   └── ...                    # 其余 ~30 个业务服务
├── models/redis.js       # Redis 数据模型
├── utils/                # 35+ 工具文件（logger, proxy, oauth, cache, stream...）
config/config.js          # 主配置
scripts/                  # 运维脚本
cli/                      # CLI 工具
web/admin-spa/            # Vue SPA 管理界面
data/init.json            # 管理员凭据
```

## 核心请求流程

```
客户端(cr_前缀Key) → 路由 → auth中间件(验证/权限/限流/模型黑名单)
  → 统一调度器(选账户/粘性会话) → Token检查/刷新
  → 转发服务(通过代理发送) → 上游API
  → 流式/非流式响应 → Usage捕获 → 成本计算 → 返回客户端
```

关键机制：
- **粘性会话**: 基于请求内容 hash 绑定账户，同一会话用同一账户
- **并发控制**: Redis Sorted Set 实现，支持排队等待（非直接 429）
- **529 处理**: 自动标记过载账户，配置时长内排除
- **加密存储**: 敏感数据（OAuth token、credentials）AES 加密存于 Redis
- **流式响应**: SSE 传输，实时捕获 usage，客户端断开时 AbortController 清理资源

## 元数据存储（Redis / SQLite）

`METADATA_BACKEND` 环境变量决定账号 / API Key / 标签的 source of truth：

| backend | 职能划分 | 适合场景 |
|---|---|---|
| `sqlite`（默认） | 元数据 → `data/metadata.db` (WAL)；Redis 仅作缓存 + 热状态 | 单实例部署、Redis 是托管服务或纯缓存 |
| `redis` | 所有元数据 + 热状态都在 Redis | 多实例部署、自管 Redis、向后兼容旧行为 |

**分层边界**（仓储接口 `src/storage/repositories/`）：
- `IApiKeyRepository` / `IAccountRepository` / `ITagRepository` — 业务代码只依赖接口
- `Redis*Repository` — 现有 Redis 语义的薄封装
- `Sqlite*Repository` — SQLite 实现，Hybrid schema（核心列 + `data` JSON）
- `Caching*Repository` — 装饰器：Redis read-through cache（默认 TTL 60s）
- `repositories/index.js` — 根据 `config.metadata.backend` 装配

**保留在 Redis 的职能**（永远不迁）：并发计数、限流窗口、粘性会话、实时 usage 统计、API Key 累计统计缓冲（30 秒 flush）。

**运维脚本**：`npm run data:migrate:dry` → `npm run data:migrate`（迁移）；`npm run data:backup`（热备份）；`npm run data:rollback`（反向导出）；`npm run data:cleanup:confirm`（观察期后清理 Redis 旧数据）。

**约束**：SQLite backend 仅支持**单实例部署**。详见 `docs/metadata-storage-guide/README.md`。

## 开发规范

### 代码风格

- **无分号**、**单引号**、**100字符行宽**、**尾逗号 none**、**箭头函数始终加括号**
- 强制 `const`（`no-var`、`prefer-const`），严格相等（`eqeqeq`）
- 下划线前缀变量 `_var` 可豁免 unused 检查
- **必须使用 Prettier**: `npx prettier --write <file>`
- 前端额外安装了 `prettier-plugin-tailwindcss`

### 开发工作流

1. **理解现有代码** → 读相关文件，了解现有模式
2. **编写代码** → 重用已有服务和工具函数
3. **格式化** → `npx prettier --write <修改的文件>`
4. **检查** → `npm run lint`
5. **测试** → `npm test`
6. **验证** → `npm run cli status` 确认服务正常

### 测试规范

- 测试文件在 `tests/` 目录，命名 `*.test.js` 或 `*.spec.js`
- 使用 `jest.mock()` 模拟依赖（logger、redis、services）
- `beforeEach` 中 `jest.resetModules()`，`afterEach` 中 `jest.clearAllMocks()`

### 前端要求

- 技术栈：Vue 3 Composition API + Pinia + Element Plus + Tailwind CSS
- 响应式设计：Tailwind CSS 响应式前缀（sm:、md:、lg:、xl:）
- 暗黑模式：所有组件必须兼容，使用 `dark:` 前缀
- 主题切换：`web/admin-spa/src/stores/theme.js` 的 `useThemeStore()`
- 保持现有玻璃态设计风格

暗黑模式配色对照：

| 元素 | 明亮模式 | 暗黑模式 |
|------|----------|----------|
| 文本 | `text-gray-700` | `dark:text-gray-200` |
| 背景 | `bg-white` | `dark:bg-gray-800` |
| 边框 | `border-gray-200` | `dark:border-gray-700` |
| 状态色 | `text-blue-500` / `text-green-600` / `text-red-500` | 保持一致 |

### 代码修改原则

- 先检查现有模式和风格，重用已有服务和工具函数
- 敏感数据必须加密存储（参考 claudeAccountService.js）
- 遵循现有的错误处理和日志记录模式

### 版本与发版

- `package.json` 的 `version` 是唯一权威版本来源。`VERSION` 文件、`package-lock.json` 的 `version` 与 `packages[""].version` 都只是它的派生副本，任何读取版本的代码都必须以 `package.json` 为准。
- 发版改版本号必须走 `npm run version:bump <x.y.z>`（会同步上述三处并回读校验），禁止手工单独编辑 `VERSION` 或 `package-lock.json` 的 version 字段——单独改会让升级预检把 lock 判成「需人介入」而阻断升级。改完把 `package.json`、`package-lock.json`、`VERSION` 一并提交，tag 用 `v<x.y.z>`。

## 常用命令

```bash
npm install && npm run setup    # 初始化
npm run dev                     # 开发模式（nodemon 热重载，自动 lint）
npm start                       # 生产模式（先 lint 再启动）
npm run lint                    # ESLint 检查并自动修复
npm run lint:check              # ESLint 仅检查不修复
npm run format                  # Prettier 格式化所有后端文件
npm run format:check            # Prettier 仅检查格式
npm test                        # Jest 运行所有测试（tests/ 目录）
npm test -- <文件名>             # 运行单个测试，如: npm test -- pricingService
npm test -- --coverage          # 运行测试并生成覆盖率报告
npm run cli status              # 系统状态
npm run data:export             # 导出 Redis 数据
npm run data:debug              # 调试 Redis 键
```

### 服务管理命令（scripts/manage.js，PID + nohup，跨平台）

```bash
npm run service:start:daemon    # 启动（后台运行）
npm run service:stop            # 停止（优雅关闭，超时强制结束）
npm run service:restart         # 重启（加载最新配置）
npm run service:update          # 更新（git pull → 装依赖 → 构建前端 → 自动后台重启）
npm run service:status          # 查看状态
npm run service:logs            # 查看日志
```

### 前端命令

```bash
npm run install:web             # 安装前端依赖
npm run build:web               # 构建前端（生成 dist）
cd web/admin-spa && npm run dev # 前端开发模式（Vite HMR）
```

## 环境变量（必须）

- `JWT_SECRET` — JWT 密钥（32字符+）
- `ENCRYPTION_KEY` — AES 加密密钥（32字符固定）
- `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` — Redis 连接

其他可选环境变量见 `.env.example`。

## 故障排除

| 问题 | 排查方向 |
|------|----------|
| Redis 连接失败 | 检查 REDIS_HOST/PORT/PASSWORD |
| 管理员登录失败 | 检查 data/init.json，运行 `npm run setup` |
| API Key 格式错误 | 确保使用 `cr_` 前缀格式（可通过 API_KEY_PREFIX 配置） |
| Token 刷新失败 | 流程：解析 claude binary 路径（`CLAUDE_BIN` env > PATH 查找；找不到立即 `cli_not_found` 跳过 CLI）→ CLI 优先 3 次（每次 `claude -p hello world`，mtime 校验代替 sleep）→ 当账号 `axiosRefreshEnabled` 与 `axiosCloudflareConfirmed` 双开关同时为 `'true'` 时才进入 axios `refresh_token` grant 兜底（默认关）。失败按类别处置：`invalid_grant`/`file_path_error`/`cli_no_op`→`status=error` + 对应 webhook，`oauth_network`/`cli_subprocess`/`cli_not_found`→`temp_unavailable` 短冷却（`cli_not_found` 额外发 `CLAUDE_REFRESH_CLI_NOT_FOUND` webhook），`cloudflare_blocked`→自动关闭 axios 双开关 + 记录 `axiosLastBlockedAt`/`axiosBlockedReason`，发 `CLAUDE_REFRESH_CLOUDFLARE_BLOCKED` webhook。失败时**不**污染 token 字段缓存。查看 `logs/token-refresh-error.log` 与 `token-refresh.log`（含 `trigger`：`cache_expired`/`upstream_error`/`manual_refresh`，及 `category` 字段） |
| `spawn claude ENOENT` / `cli_not_found` | systemd 服务 PATH 找不到 claude CLI：1) 宿主验证 `command -v claude`；2) 系统级安装 `npm i -g @anthropic-ai/claude-code`，确认落在 `/usr/local/bin` 或 `/usr/bin`；3) 或在 `.env` 设 `CLAUDE_BIN=/绝对/路径/claude`；4) `systemctl restart relay-service`，启动日志应出现 `claude binary resolved at <path>` |
| Cloudflare 拦截 axios 兜底 | 部署出口被 CF WAF 屏蔽时返回 403 + `cf-ray` 头：系统识别为 `cloudflare_blocked`，自动关闭账号 axios 开关。重新启用前请用 `curl -X POST https://console.anthropic.com/v1/oauth/token ... -i` 验证不再被拦截，然后在管理后台 → Claude 账号编辑 → "直连 OAuth 兜底（高级）" 重新勾选确认 + 启用 |
| CLI 永久 no-op | 账号每次刷新都走到 `cli_no_op` 分类（webhook `CLAUDE_REFRESH_CLI_NO_OP`）：通常是 `~/.claude/.credentials.json` 中的 refresh_token 已被 OAuth 服务拒绝，需在主机上重新执行 `claude login` 同步文件状态；axios 兜底不应作为长期解药（refresh_token 漂移会让 CLI 路径退化） |
| 调度器选账户失败 | 检查账户 status:'active'，确认类型与路由匹配，查看粘性会话绑定 |
| 并发计数泄漏 | 系统每分钟自动清理，重启也会清理 |
| 粘性会话失效 | 检查 Redis 中 session 数据，Nginx 代理需添加 `underscores_in_headers on` |
| LDAP 认证失败 | 检查 LDAP_URL/BIND_DN/BIND_PASSWORD，自签名证书设 `LDAP_TLS_REJECT_UNAUTHORIZED=false` |
| Webhook 通知失败 | 确认 WEBHOOK_ENABLED=true，检查 WEBHOOK_URLS 格式，查看 `logs/webhook-*.log` |
| 成本统计不准确 | 运行 `npm run init:costs`，检查 pricingService 模型价格 |
| HTTPS 启动失败 (SAN 为空) | `.env` 检查 `HTTPS_SAN`，示例 `HTTPS_SAN=IP:203.0.113.10,DNS:localhost,IP:127.0.0.1`；修改后重启服务 |
| HTTPS 启动失败 (端口占用) | 排查 `HTTPS_PORT` 冲突；容器中 <1024 端口需 `CAP_NET_BIND_SERVICE` 或使用宿主端口映射（默认 3443 + 宿主 `443:3443`） |
| HTTPS 启动失败 (证书损坏) | 日志定位具体文件（`data/certs/*.crt/.key`）；修复后重启；删除损坏文件让进程自动再签 |
| 客户端 SDK 报 SSL 错误 | 系统已信任但 Node/Python 默认不读系统信任：设置 `NODE_EXTRA_CA_CERTS` / `REQUESTS_CA_BUNDLE` 指向 `data/certs/ca.crt` |
| 新客户端 IP 接入 | 改 `HTTPS_SAN` 追加 `IP:<addr>` → 删 `data/certs/server.{crt,key}` → 重启；CA 保持不变，已分发 `ca.crt` 继续有效 |
| HTTPS 与 TRUST_PROXY 同开警告 | 应用层 HTTPS 与反向代理做 TLS 终结通常互斥；按部署形态二选一 |

日志：`logs/` 目录。Web 界面 `/admin-next/` 可实时查看。
HTTPS 状态：管理后台 → 系统设置 → HTTPS 状态（只读，含证书到期、SAN、CA 下载）。

# important-instruction-reminders

Do what has been asked; nothing more, nothing less.
NEVER create files unless they're absolutely necessary for achieving your goal.
ALWAYS prefer editing an existing file to creating a new one.
NEVER proactively create documentation files (\*.md) or README files. Only create documentation files if explicitly requested by the User.
