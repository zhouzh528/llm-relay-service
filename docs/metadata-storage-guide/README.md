# 元数据存储（Redis / SQLite）运维指南

Relay Service 支持两种元数据后端：

| backend | 存储位置 | 适合场景 |
|---|---|---|
| `redis`（默认） | 所有元数据 + 热状态都在 Redis | Redis 可控、可靠持久化的传统部署 |
| `sqlite` | 账号 / API Key / 标签在本地 SQLite；Redis 仅作缓存和热状态 | Redis 是托管/共享/纯缓存，不能依赖其持久化 |

**切换后端不是热操作**：需要修改 `.env` 并重启进程。

## 1. 切换到 SQLite

### 1.1 前置

- 仅支持**单实例**部署（SQLite 文件不能被多进程共享写入）
- 服务进程对 `data/` 目录有 `0700` 权限；`metadata.db` 将写成 `0600`
- 必须保留 Redis：并发计数、限流、会话、实时 usage 仍然依赖它

### 1.2 执行迁移（服务可保持运行）

```bash
# 1) 先 dry-run 查看计划
npm run data:migrate:dry

# 2) 正式迁移
npm run data:migrate

# 输出末尾会打印对比报告：
#   api_keys : N (src) → N (dst)
#   accounts : N (src) → N (dst)
#   tags     : N (src) → N (dst)
#   sample diff (up to 5 keys): ✓ ✓ ✓ ✓ ✓
```

迁移脚本**幂等**，可安全重跑；不会修改 Redis 数据。

### 1.3 切换 backend

```bash
# .env
METADATA_BACKEND=sqlite
# SQLITE_PATH=./data/metadata.db            # 可选
# SQLITE_STATS_FLUSH_INTERVAL=30            # 可选
```

重启服务。启动日志出现：

```
🗄️  SQLite metadata ready at .../data/metadata.db (WAL, foreign_keys=ON)
🗄️  repositories wired with SQLite backend (Redis used as read-through cache)
🗄️  metadata backend: sqlite
```

### 1.4 观察期（推荐 ≥ 72 小时）

- 检查错误日志 `logs/` 中是否出现 SQLite / flusher 相关错误
- 监控 API 路径的 p99 延迟是否稳定
- 管理后台的"系统设置 → 存储健康"（阶段 10）可实时查看 row count 与 flusher 状态

观察期内不要运行 `data:cleanup`——Redis 旧数据是你的回滚安全网。

### 1.5 回退到 Redis backend（若发现问题）

```bash
# 1) .env 改回
METADATA_BACKEND=redis
# 2) 重启

# 如果此时 Redis 仍保留原始 metadata（尚未 cleanup），可直接运行
#
# 如果 Redis 已被 cleanup，需要先从 SQLite 反向导出：
npm run data:rollback
```

### 1.6 清理 Redis 中的旧 metadata（观察期结束后）

```bash
# dry-run：只列出将要删除的 key
npm run data:cleanup

# 实际删除：要求 --confirm
npm run data:cleanup:confirm
```

被清理的 key 前缀：
- `apikey:<id>`、`apikey:hash_map`、`apikey:tags:all`
- 各平台账号 hash（`claude:account:*`、`claude_console_account:*` 等）
- 平台索引 set（`claude:account:index` 等）

**保留**（热状态，不能清）：
- `apikey:runtime:*` — flusher 待 flush 的统计累加
- `apikey:cache:*` — Repository 缓存
- `usage:*` — 实时 usage 计数
- `session:*`、`concurrency:*`、`ratelimit:*` — 会话/并发/限流

## 2. 备份与恢复（灾备与恢复）

### 2.1 创建备份

```bash
npm run data:backup
# → data/backup/metadata-2026-04-22T03-15-00.db
```

使用 SQLite 内置 `.backup` API，**支持热备份**（服务可继续运行）。
备份成功后自动清理旧文件，仅保留最近 14 份（可用环境变量 `METADATA_BACKUP_KEEP` 调整）。

### 2.2 恢复备份

```bash
# 1) 停服务
systemctl stop relay-app

# 2) 还原（自动做 integrity_check、备份现库为 metadata.db.pre-restore.<ts>、清理陈旧 WAL/SHM）
npm run data:restore -- --input=data/backup/metadata-<timestamp>.db

# 3) 启动服务
systemctl start relay-app
```

脚本安全护栏：备份文件先过 `PRAGMA integrity_check`；检测到 relay-app 仍在运行会拒绝执行；
覆盖前把现库复制为 `data/metadata.db.pre-restore.<ts>` 保留现场。
SQLite 启动时会做完整性自检；损坏时 fail-fast 退出。

**恢复后动作**：启动后 metadataSync 以 Redis 为准对账。若 Redis 数据仍在，SQLite 会被对账回
Redis 当前状态；若 Redis 已被清空，空 Redis 护栏会跳过对账保住 SQLite 数据，此时用 Web 端
「备份导入」（条目级备份 JSON）恢复 Redis，导入完成会自动 reconcile 落库。

### 2.3 周期性备份（systemd timer，已随部署启用）

`relay-backup.timer` 每日 02:00 触发 `relay-backup.service` 跑一次 `npm run data:backup`：

```ini
# /etc/systemd/system/relay-backup.service
[Unit]
Description=Claude Relay Service metadata backup (SQLite file-level)
# 备份用 SQLite .backup API 热备，不要求停服；relay-app 未运行时同样可备份。

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=/opt/relay-service
# 与 relay-app.service 一致：npm/node 来自 nvm default（better-sqlite3 ABI 绑定 node 主版本）
ExecStart=/bin/bash -lc 'set -e; NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; exec npm run data:backup'
StandardOutput=append:/opt/relay-service/logs/backup.log
StandardError=append:/opt/relay-service/logs/backup.log
```

```ini
# /etc/systemd/system/relay-backup.timer
[Unit]
Description=Daily metadata backup for Claude Relay Service

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```bash
systemctl daemon-reload && systemctl enable --now relay-backup.timer
systemctl list-timers relay-backup.timer   # 查看下次执行时间
systemctl start relay-backup.service       # 手动触发一次
```

### 2.4 两条恢复路径的取舍

| | 文件级（data:backup / data:restore） | 条目级（Web 导出/导入） |
|---|---|---|
| 内容 | 整个 metadata.db 原样回档（含 usage_daily 统计） | API Keys + 11 类账户 + tags + 管理员凭据 |
| 适用 | 整机灾备、误删全量数据、SQLite 损坏 | 部分恢复、跨实例迁移、误删个别条目 |
| 要求 | 同版本 schema；须停服执行 | 跨版本兼容（2.0/2.1）；在线执行 |
| 冲突 | 整库覆盖（现库自动留 pre-restore 副本） | 跳过已存在条目（不覆盖） |
| 恢复后 | 起服后以 Redis 为准对账（见 2.2 恢复后动作） | 自动 reconcile 落 SQLite、清索引空标记与读缓存 |

遗留 CLI `scripts/data-transfer.js` / `data-transfer-enhanced.js` 已标记 **deprecated**（只覆盖
claude+gemini 且假设全部 hash 存储），请改用上述两条路径。

## 3. 数据结构参考

**SQLite 主表**（完整 DDL 见 `src/storage/schema.js`）：

- `api_keys(id PK, hashed_key UNIQUE, name, owner_user_id, status, data JSON, last_used_at, request_count, total_cost, created_at, updated_at)`
- `accounts(id PK, platform, name, status, data JSON, created_at, updated_at)`
- `tags(name PK, created_at)`
- `api_key_tags(api_key_id, tag_name)`  with ON DELETE CASCADE
- `usage_daily(scope, id, model, date, request_count, input_tokens, output_tokens, cost)`  PK (scope, id, model, date)

`data` JSON 列与 Redis hash 字段 1:1 对应（camelCase 保持不变），新字段无需 schema 变更。

## 4. 常见问题

| 问题 | 处理 |
|---|---|
| 启动日志看不到 `metadata backend: sqlite` | `.env` 里 `METADATA_BACKEND` 没设或拼错；默认仍是 `redis` |
| "falling back to Redis backend" | SQLite 打开失败（权限/目录）；查日志定位 `data/metadata.db` 相关错误 |
| flusher 连续失败 | 查 `logs/`；存储健康面板会标红；一般是 SQLite 磁盘/权限问题 |
| 多实例部署 | **不支持**；会出现文件锁冲突与数据分裂 |

---

本文档对应 OpenSpec 变更：`migrate-source-of-truth-to-sqlite`（archive 后归入主 specs 的 `metadata-storage` capability）。
