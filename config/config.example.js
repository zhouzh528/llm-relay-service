const path = require('path')
require('dotenv').config()

const config = {
  // 🌐 服务器配置
  server: {
    // 应用自身监听端口 / 地址。
    // 默认只绑回环地址：由 Nginx 按端口把「对外 API」和「后台管理」分开暴露（见下方 nginx 段）。
    // 若改成 0.0.0.0，管理台会直接暴露在该端口上（启动时会告警）。
    port: parseInt(process.env.PORT, 10) || 13000,
    host: process.env.HOST || '127.0.0.1',
    nodeEnv: process.env.NODE_ENV || 'development',
    trustProxy: process.env.TRUST_PROXY === 'true'
  },

  // 🌐 反向代理（Nginx）对外入口 —— 对外 API 与后台管理分离
  //
  // 部署形态（install.sh 会自动安装 Nginx 并按本段生成配置）：
  //   客户端  ──▶ Nginx :nginx.publicPort ──▶ 127.0.0.1:server.port   仅放行业务路由
  //   管理员  ──▶ Nginx :nginx.adminPort  ──▶ 127.0.0.1:server.port   放行管理台
  //
  // 隔离点在 Nginx：对外端口只代理 publicPathPrefixes / publicExactPaths，
  // 其余路径（/admin /users /web /apiStats /admin-next 等管理面）一律返回 404。
  nginx: {
    // 对外调用端口（Claude Code / Codex 等客户端指向这里）
    publicPort: parseInt(process.env.NGINX_PUBLIC_PORT, 10) || 8080,
    // 后台管理端口
    adminPort: parseInt(process.env.NGINX_ADMIN_PORT, 10) || 28080,
    serverName: process.env.NGINX_SERVER_NAME || '_',
    clientMaxBodySize: process.env.NGINX_CLIENT_MAX_BODY_SIZE || '100m',
    // 生成的配置文件位置
    confDir: process.env.NGINX_CONF_DIR || '/etc/nginx/conf.d',
    snippetPath: process.env.NGINX_SNIPPET_PATH || '/etc/nginx/relay_proxy.conf',
    // 对外端口只代理这些前缀（其余一律 404，管理面不在其中）
    publicPathPrefixes: ['/api', '/claude', '/gemini', '/openai', '/droid', '/azure'],
    // 对外端口额外精确匹配的路径
    publicExactPaths: ['/health']
  },

  // 🔒 HTTPS 监听配置（一把开关；启用后仅监听 HTTPS 端口，HTTP 端口不再监听）
  // 启用流程：设置 HTTPS_ENABLED=true + 填写 HTTPS_SAN → 重启进程
  // 详细说明见 README 与 openspec/changes/add-https-support/design.md
  https: {
    enabled: process.env.HTTPS_ENABLED === 'true',
    port: parseInt(process.env.HTTPS_PORT) || 3443,
    // SAN 示例：IP:203.0.113.10,DNS:localhost,IP:127.0.0.1
    san: process.env.HTTPS_SAN || '',
    certDir: process.env.HTTPS_CERT_DIR || path.join(__dirname, '..', 'data', 'certs'),
    // server 证书有效天数（私有 CA 信任链不受 Chrome 398 天限制）
    certValidDays: parseInt(process.env.HTTPS_CERT_VALID_DAYS) || 1825,
    // 根 CA 有效天数
    caValidDays: parseInt(process.env.HTTPS_CA_VALID_DAYS) || 3650,
    // 最小 TLS 版本：TLSv1.2 | TLSv1.3
    minTlsVersion: process.env.HTTPS_MIN_TLS_VERSION || 'TLSv1.2',
    // RSA 密钥位数（默认 2048；4096 更安全但生成明显更慢）
    keyBits: parseInt(process.env.HTTPS_KEY_BITS) || 2048,
    // HSTS 默认关闭——私有 CA 场景下误开易把客户端永久锁在错误状态
    hstsEnabled: process.env.HTTPS_HSTS_ENABLED === 'true'
  },

  // 🗄️ 元数据存储（账号 / API Key 的 source of truth）
  // backend=redis  → 所有元数据存 Redis（旧行为，向后兼容）
  // backend=sqlite → 元数据落 SQLite；Redis 仅作缓存与热状态；仅支持单实例部署
  metadata: {
    backend: process.env.METADATA_BACKEND || 'redis',
    sqlitePath: process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'metadata.db'),
    // API Key 累计统计 flush 到 SQLite 的间隔（秒）；0 表示每请求直写 SQLite
    statsFlushInterval: parseInt(process.env.SQLITE_STATS_FLUSH_INTERVAL) || 30
  },

  // 🔐 安全配置
  security: {
    jwtSecret: process.env.JWT_SECRET || 'CHANGE-THIS-JWT-SECRET-IN-PRODUCTION',
    adminSessionTimeout: parseInt(process.env.ADMIN_SESSION_TIMEOUT) || 86400000, // 24小时
    apiKeyPrefix: process.env.API_KEY_PREFIX || 'cr_',
    encryptionKey: process.env.ENCRYPTION_KEY || 'CHANGE-THIS-32-CHARACTER-KEY-NOW'
  },

  // 📊 Redis配置
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || '',
    db: parseInt(process.env.REDIS_DB) || 0,
    connectTimeout: 10000,
    commandTimeout: 5000,
    retryDelayOnFailover: 100,
    maxRetriesPerRequest: 3,
    lazyConnect: true,
    enableTLS: process.env.REDIS_ENABLE_TLS === 'true'
  },

  // 🔗 会话管理配置
  session: {
    // 粘性会话TTL配置（小时），默认1小时
    stickyTtlHours: parseFloat(process.env.STICKY_SESSION_TTL_HOURS) || 1,
    // 续期阈值（分钟），默认0分钟（不续期）
    renewalThresholdMinutes: parseInt(process.env.STICKY_SESSION_RENEWAL_THRESHOLD_MINUTES) || 0
  },

  // 🎯 Claude API配置
  claude: {
    apiUrl: process.env.CLAUDE_API_URL || 'https://api.anthropic.com/v1/messages',
    apiVersion: process.env.CLAUDE_API_VERSION || '2023-06-01',
    betaHeader:
      process.env.CLAUDE_BETA_HEADER ||
      'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    overloadHandling: {
      enabled: (() => {
        const minutes = parseInt(process.env.CLAUDE_OVERLOAD_HANDLING_MINUTES) || 0
        // 验证配置值：限制在0-1440分钟(24小时)内
        return Math.max(0, Math.min(minutes, 1440))
      })()
    }
  },

  // 📋 模型清单（modelCatalogService）
  models: {
    // 上游清单全局多久拉一次（默认 24h，即「全局一天一次」）
    catalogSuccessTtlMs: parseInt(process.env.MODELS_CATALOG_SUCCESS_TTL_MS) || 24 * 60 * 60 * 1000,
    // 拉取失败后最短重试间隔，避免上游异常时被每个请求各打一次
    catalogFailureRetryMs: parseInt(process.env.MODELS_CATALOG_FAILURE_RETRY_MS) || 30 * 60 * 1000,
    // models 列表端点是否按 API Key 权限分段过滤（出问题可不发版关闭）
    enforcePermissionFilter: process.env.MODELS_ENFORCE_PERMISSION_FILTER !== 'false'
  },

  // 🤖 OpenAI/Codex 调度配置
  openai: {
    // 周限用量分档档宽（百分比，1-100）：调度排序时按 codexPrimaryUsedPercent/档宽 分档，低档优先；设 100 等效关闭分档
    usageBandWidth: (() => {
      const width = parseInt(process.env.OPENAI_USAGE_BAND_WIDTH)
      if (!Number.isFinite(width) || width < 1 || width > 100) {
        return 30
      }
      return width
    })(),
    // 硬保护阈值（百分比，1-100）：用量达到阈值的账号从候选池剔除（池空时放行）；设 100 关闭硬保护
    usageHardLimit: (() => {
      const limit = parseInt(process.env.OPENAI_USAGE_HARD_LIMIT)
      if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
        return 95
      }
      return limit
    })()
  },

  // ☁️ Bedrock API配置
  bedrock: {
    enabled: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    defaultRegion: process.env.AWS_REGION || 'us-east-1',
    smallFastModelRegion: process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION,
    defaultModel: process.env.ANTHROPIC_MODEL || 'us.anthropic.claude-sonnet-4-20250514-v1:0',
    smallFastModel:
      process.env.ANTHROPIC_SMALL_FAST_MODEL || 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
    maxOutputTokens: parseInt(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) || 4096,
    maxThinkingTokens: parseInt(process.env.MAX_THINKING_TOKENS) || 1024,
    enablePromptCaching: process.env.DISABLE_PROMPT_CACHING !== '1'
  },

  // 🌐 代理配置
  proxy: {
    timeout: parseInt(process.env.DEFAULT_PROXY_TIMEOUT) || 600000, // 10分钟
    maxRetries: parseInt(process.env.MAX_PROXY_RETRIES) || 3,
    // 连接池与 Keep-Alive 配置（默认关闭，需要显式开启）
    keepAlive: (() => {
      if (process.env.PROXY_KEEP_ALIVE === undefined || process.env.PROXY_KEEP_ALIVE === '') {
        return false
      }
      return process.env.PROXY_KEEP_ALIVE === 'true'
    })(),
    maxSockets: (() => {
      if (process.env.PROXY_MAX_SOCKETS === undefined || process.env.PROXY_MAX_SOCKETS === '') {
        return undefined
      }
      const parsed = parseInt(process.env.PROXY_MAX_SOCKETS)
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
    })(),
    maxFreeSockets: (() => {
      if (
        process.env.PROXY_MAX_FREE_SOCKETS === undefined ||
        process.env.PROXY_MAX_FREE_SOCKETS === ''
      ) {
        return undefined
      }
      const parsed = parseInt(process.env.PROXY_MAX_FREE_SOCKETS)
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
    })(),
    // IP协议族配置：true=IPv4, false=IPv6, 默认IPv4（兼容性更好）
    useIPv4: process.env.PROXY_USE_IPV4 !== 'false' // 默认 true，只有明确设置为 'false' 才使用 IPv6
  },

  // ⏱️ 请求超时配置
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT) || 600000, // 默认 10 分钟

  // 📈 使用限制
  limits: {
    defaultTokenLimit: parseInt(process.env.DEFAULT_TOKEN_LIMIT) || 1000000
  },

  // 📝 日志配置
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dirname: path.join(__dirname, '..', 'logs'),
    maxSize: process.env.LOG_MAX_SIZE || '10m',
    maxFiles: parseInt(process.env.LOG_MAX_FILES) || 5
  },

  // 🔧 系统配置
  system: {
    cleanupInterval: parseInt(process.env.CLEANUP_INTERVAL) || 3600000, // 1小时
    tokenUsageRetention: parseInt(process.env.TOKEN_USAGE_RETENTION) || 2592000000, // 30天
    healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 60000, // 1分钟
    timezone: process.env.SYSTEM_TIMEZONE || 'Asia/Shanghai', // 默认UTC+8（中国时区）
    timezoneOffset: parseInt(process.env.TIMEZONE_OFFSET) || 8, // UTC偏移小时数，默认+8
    metricsWindow: parseInt(process.env.METRICS_WINDOW) || 5 // 实时指标统计窗口（分钟）
  },

  // 🎨 Web界面配置
  web: {
    title: process.env.WEB_TITLE || 'Relay Service',
    description:
      process.env.WEB_DESCRIPTION ||
      'Multi-account Claude API relay service with beautiful management interface',
    logoUrl: process.env.WEB_LOGO_URL || '/assets/logo.png',
    enableCors: process.env.ENABLE_CORS === 'true',
    sessionSecret: process.env.WEB_SESSION_SECRET || 'CHANGE-THIS-SESSION-SECRET'
  },

  // 🔐 LDAP 认证配置
  ldap: {
    enabled: process.env.LDAP_ENABLED === 'true',
    server: {
      url: process.env.LDAP_URL || 'ldap://localhost:389',
      bindDN: process.env.LDAP_BIND_DN || 'cn=admin,dc=example,dc=com',
      bindCredentials: process.env.LDAP_BIND_PASSWORD || 'admin',
      searchBase: process.env.LDAP_SEARCH_BASE || 'dc=example,dc=com',
      searchFilter: process.env.LDAP_SEARCH_FILTER || '(uid={{username}})',
      searchAttributes: process.env.LDAP_SEARCH_ATTRIBUTES
        ? process.env.LDAP_SEARCH_ATTRIBUTES.split(',')
        : ['dn', 'uid', 'cn', 'mail', 'givenName', 'sn'],
      timeout: parseInt(process.env.LDAP_TIMEOUT) || 5000,
      connectTimeout: parseInt(process.env.LDAP_CONNECT_TIMEOUT) || 10000,
      // TLS/SSL 配置
      tls: {
        // 是否忽略证书错误 (用于自签名证书)
        rejectUnauthorized: process.env.LDAP_TLS_REJECT_UNAUTHORIZED !== 'false', // 默认验证证书，设置为false则忽略
        // CA证书文件路径 (可选，用于自定义CA证书)
        ca: process.env.LDAP_TLS_CA_FILE
          ? require('fs').readFileSync(process.env.LDAP_TLS_CA_FILE)
          : undefined,
        // 客户端证书文件路径 (可选，用于双向认证)
        cert: process.env.LDAP_TLS_CERT_FILE
          ? require('fs').readFileSync(process.env.LDAP_TLS_CERT_FILE)
          : undefined,
        // 客户端私钥文件路径 (可选，用于双向认证)
        key: process.env.LDAP_TLS_KEY_FILE
          ? require('fs').readFileSync(process.env.LDAP_TLS_KEY_FILE)
          : undefined,
        // 服务器名称 (用于SNI，可选)
        servername: process.env.LDAP_TLS_SERVERNAME || undefined
      }
    },
    userMapping: {
      username: process.env.LDAP_USER_ATTR_USERNAME || 'uid',
      displayName: process.env.LDAP_USER_ATTR_DISPLAY_NAME || 'cn',
      email: process.env.LDAP_USER_ATTR_EMAIL || 'mail',
      firstName: process.env.LDAP_USER_ATTR_FIRST_NAME || 'givenName',
      lastName: process.env.LDAP_USER_ATTR_LAST_NAME || 'sn'
    }
  },

  // 👥 用户管理配置
  userManagement: {
    enabled: process.env.USER_MANAGEMENT_ENABLED === 'true',
    defaultUserRole: process.env.DEFAULT_USER_ROLE || 'user',
    userSessionTimeout: parseInt(process.env.USER_SESSION_TIMEOUT) || 86400000, // 24小时
    maxApiKeysPerUser: parseInt(process.env.MAX_API_KEYS_PER_USER) || 1,
    allowUserDeleteApiKeys: process.env.ALLOW_USER_DELETE_API_KEYS === 'true' // 默认不允许用户删除自己的API Keys
  },

  // 📢 Webhook通知配置
  webhook: {
    enabled: process.env.WEBHOOK_ENABLED !== 'false', // 默认启用
    urls: process.env.WEBHOOK_URLS
      ? process.env.WEBHOOK_URLS.split(',').map((url) => url.trim())
      : [],
    timeout: parseInt(process.env.WEBHOOK_TIMEOUT) || 10000, // 10秒超时
    retries: parseInt(process.env.WEBHOOK_RETRIES) || 3 // 重试3次
  },

  // 🛠️ 开发配置
  development: {
    debug: process.env.DEBUG === 'true',
    hotReload: process.env.HOT_RELOAD === 'true'
  },

  // 💰 账户余额相关配置
  accountBalance: {
    // 是否允许执行自定义余额脚本（安全开关）
    // 说明：脚本能力可发起任意 HTTP 请求并在服务端执行 extractor 逻辑，建议仅在受控环境开启
    // 默认保持开启；如需禁用请显式设置：BALANCE_SCRIPT_ENABLED=false
    enableBalanceScript: process.env.BALANCE_SCRIPT_ENABLED !== 'false'
  },

  // 📬 用户消息队列配置
  // 优化说明：锁在请求发送成功后立即释放（而非请求完成后），因为 Claude API 限流基于请求发送时刻计算
  userMessageQueue: {
    enabled: process.env.USER_MESSAGE_QUEUE_ENABLED === 'true', // 默认关闭
    delayMs: parseInt(process.env.USER_MESSAGE_QUEUE_DELAY_MS) || 200, // 请求间隔（毫秒）
    timeoutMs: parseInt(process.env.USER_MESSAGE_QUEUE_TIMEOUT_MS) || 5000, // 队列等待超时（毫秒），锁持有时间短，无需长等待
    lockTtlMs: parseInt(process.env.USER_MESSAGE_QUEUE_LOCK_TTL_MS) || 5000 // 锁TTL（毫秒），5秒足以覆盖请求发送
  },

  // 🎫 额度卡兑换上限配置（防盗刷）
  quotaCardLimits: {
    enabled: process.env.QUOTA_CARD_LIMITS_ENABLED !== 'false', // 默认启用
    maxExpiryDays: parseInt(process.env.QUOTA_CARD_MAX_EXPIRY_DAYS) || 90, // 最大有效期距今天数
    maxTotalCostLimit: parseFloat(process.env.QUOTA_CARD_MAX_TOTAL_COST_LIMIT) || 1000 // 最大总额度（美元）
  },

  // ⏱️ 上游错误自动暂停配置
  // 说明：此处是全局默认值。Claude 官方 OAuth 账号可在后台做账号级 503/5xx 覆盖，
  // 且可通过账号设置禁用 temp_unavailable（账号级策略优先于全局默认值）。
  upstreamError: {
    serviceUnavailableTtlSeconds: parseInt(process.env.UPSTREAM_ERROR_503_TTL_SECONDS) || 60, // 503错误暂停秒数
    serverErrorTtlSeconds: parseInt(process.env.UPSTREAM_ERROR_5XX_TTL_SECONDS) || 300, // 5xx错误暂停秒数
    overloadTtlSeconds: parseInt(process.env.UPSTREAM_ERROR_OVERLOAD_TTL_SECONDS) || 600, // 529过载暂停秒数
    authErrorTtlSeconds: parseInt(process.env.UPSTREAM_ERROR_AUTH_TTL_SECONDS) || 1800, // 401/403认证错误暂停秒数
    timeoutTtlSeconds: parseInt(process.env.UPSTREAM_ERROR_TIMEOUT_TTL_SECONDS) || 300 // 504超时暂停秒数
  }
}

module.exports = config
