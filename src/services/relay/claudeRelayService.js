const https = require('https')
const zlib = require('zlib')
const { Transform } = require('stream')
const path = require('path')
const crypto = require('crypto')
const ProxyHelper = require('../../utils/proxyHelper')
const { filterForClaude } = require('../../utils/headerFilter')
const claudeAccountService = require('../account/claudeAccountService')
const unifiedClaudeScheduler = require('../scheduler/unifiedClaudeScheduler')
const sessionHelper = require('../../utils/sessionHelper')
const logger = require('../../utils/logger')
const config = require('../../../config/config')
const claudeCodeHeadersService = require('../claudeCodeHeadersService')
const claudeCodeProfile = require('../../config/claudeCodeProfile')
const redis = require('../../models/redis')
const ClaudeCodeValidator = require('../../validators/clients/claudeCodeValidator')
const { formatDateWithTimezone } = require('../../utils/dateHelper')
const requestIdentityService = require('../requestIdentityService')
const { createClaudeTestPayload } = require('../../utils/testPayloadHelper')
const userMessageQueueService = require('../userMessageQueueService')
const { isStreamWritable } = require('../../utils/streamHelper')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const metadataUserIdHelper = require('../../utils/metadataUserIdHelper')
const {
  getHttpsAgentForStream,
  getHttpsAgentForNonStream,
  getPricingData
} = require('../../utils/performanceOptimizer')

// 🔢 emulation 对齐的真实 Claude Code CLI 版本（UA / cc_version 指纹统一来源）
// 单一事实来源：src/config/claudeCodeProfile.js（升级版本只改那里）
const CLAUDE_CODE_EMULATION_VERSION = claudeCodeProfile.DEFAULT_PROFILE.version

// structuredClone polyfill for Node < 17
const safeClone =
  typeof structuredClone === 'function' ? structuredClone : (obj) => JSON.parse(JSON.stringify(obj))

class ClaudeRelayService {
  constructor() {
    this.claudeApiUrl = 'https://api.anthropic.com/v1/messages?beta=true'
    // 🧹 内存优化：用于存储请求体字符串，避免闭包捕获
    this.bodyStore = new Map()
    this._bodyStoreIdCounter = 0
    this.apiVersion = config.claude.apiVersion
    this.betaHeader = config.claude.betaHeader
    this.systemPrompt = config.claude.systemPrompt
    this.claudeCodeSystemPrompt = claudeCodeProfile.getProfile().system.identity
    // ⚠️ 已移除自造的 expansion 常量：它在所有部署中字节相同，本身即是固定指纹。
    // 通用说明块改由 _getGenericInstructions() 提供（支持 config 覆盖）。
    this.toolNameSuffix = null
    this.toolNameSuffixGeneratedAt = 0
    this.toolNameSuffixTtlMs = 60 * 60 * 1000
    this.staticToolNameRewrites = new Map([
      ['sessions_', 'cc_sess_'],
      ['session_', 'cc_ses_']
    ])
    this.fakeToolNamePrefixes = [
      'analyze_',
      'compute_',
      'fetch_',
      'generate_',
      'lookup_',
      'modify_',
      'process_',
      'query_',
      'render_',
      'resolve_',
      'sync_',
      'update_',
      'validate_',
      'convert_',
      'extract_',
      'manage_',
      'monitor_',
      'parse_',
      'review_',
      'search_',
      'transform_',
      'handle_',
      'invoke_',
      'notify_'
    ]
    this.dynamicToolMapThreshold = 5
    this.nonRealClaudeCodeToolDescriptions = new Map([
      ['apply_patch', 'Apply a patch to modify files.'],
      ['bash', 'Run shell commands in the user environment.'],
      ['edit', 'Modify existing files by replacing exact text.'],
      ['glob', 'Find files by glob pattern.'],
      ['grep', 'Search file contents by pattern.'],
      ['list', 'List directory contents.'],
      ['read', 'Read file contents.'],
      ['task', 'Launch a focused sub-agent task.'],
      ['todoread', 'Read the current task plan.'],
      ['todowrite', 'Update the task plan.'],
      ['webfetch', 'Fetch content from a URL.'],
      ['write', 'Create or overwrite files.']
    ])
    this.nonRealClaudeCodeToolAliases = new Map([
      ['applypatch', 'apply_patch'],
      ['ls', 'list'],
      ['read_file', 'read'],
      ['readfile', 'read'],
      ['read_plan', 'todoread'],
      ['readplan', 'todoread'],
      ['run_shell_command', 'bash'],
      ['shell', 'bash'],
      ['todo_read', 'todoread'],
      ['todo_write', 'todowrite'],
      ['update_plan', 'todowrite'],
      ['updateplan', 'todowrite'],
      ['web_fetch', 'webfetch'],
      ['web_fetch_url', 'webfetch'],
      ['write_file', 'write'],
      ['writefile', 'write']
    ])
    this.nonRealClaudeCodeToolDescriptionFingerprints = [
      'opencode',
      'codex cli',
      'gemini cli',
      'factory droid',
      'replaces apply_patch',
      'apply_patch does not exist',
      'replaces update_plan',
      'update_plan does not exist',
      'requires a prior read',
      'oldstring',
      'replaceall',
      'tool, not bash grep',
      'no workdir parameter',
      'do not use cd',
      'do not use ls/cat',
      'always include a short description',
      'always set format',
      'short cache window',
      'functions.task',
      'sub-agents',
      'mcp tools are prefixed'
    ]
    this.nonRealClaudeCodeToolDescriptionPatterns = [/\b(?:openclaw|[a-z0-9_-]+paw)\b/i]
  }

  // 🔧 anthropic-beta 取值
  //
  // 🔒 统一化：只发送档案声明的固定集合（Claude Code 2.1.280 抓包的 16 个 flag，
  // 顺序与抓包一致），唯一事实来源为 src/config/claudeCodeProfile.js。
  // **不再合并客户端额外声明的 beta** —— 避免把客户端的能力声明透传给上游，形成可识别的差异。
  // 代价：客户端原本依赖的额外能力不会再生效（典型如 context-1m-2025-08-07 的 1M 上下文、
  // fine-grained-tool-streaming）。如确需，请在档案 betas 中显式补上对应 flag（不要在这里恢复透传）。
  // 注意：beta 与 body 字段必须成对增删（如 cache-diagnosis ↔ diagnostics），
  // 单个 flag 的增删在部分模型上会直接 400。
  _getBetaHeader() {
    return claudeCodeProfile.getProfile().betas.join(',')
  }

  _buildStandardRateLimitMessage(resetTime) {
    if (!resetTime) {
      return '此专属账号已触发 Anthropic 限流控制。'
    }
    const formattedReset = formatDateWithTimezone(resetTime)
    return `此专属账号已触发 Anthropic 限流控制，将于 ${formattedReset} 自动恢复。`
  }

  _buildOpusLimitMessage(resetTime) {
    if (!resetTime) {
      return '此专属账号的Opus模型已达到周使用限制，请尝试切换其他模型后再试。'
    }
    const formattedReset = formatDateWithTimezone(resetTime)
    return `此专属账号的Opus模型已达到周使用限制，将于 ${formattedReset} 自动恢复，请尝试切换其他模型后再试。`
  }

  // 🧾 提取错误消息文本
  _extractErrorMessage(body) {
    if (!body) {
      return ''
    }

    if (typeof body === 'string') {
      const trimmed = body.trim()
      if (!trimmed) {
        return ''
      }
      try {
        const parsed = JSON.parse(trimmed)
        return this._extractErrorMessage(parsed)
      } catch (error) {
        return trimmed
      }
    }

    if (typeof body === 'object') {
      if (typeof body.error === 'string') {
        return body.error
      }
      if (body.error && typeof body.error === 'object') {
        if (typeof body.error.message === 'string') {
          return body.error.message
        }
        if (typeof body.error.error === 'string') {
          return body.error.error
        }
      }
      if (typeof body.message === 'string') {
        return body.message
      }
    }

    return ''
  }

  // 🚫 检查是否为组织被禁用/封禁错误
  // 支持两种场景：
  //   1. HTTP 400 + "this organization has been disabled"（原有）
  //   2. HTTP 403 + "OAuth authentication is currently not allowed for this organization"（封禁后新返回格式）
  _isOrganizationDisabledError(statusCode, body) {
    if (statusCode !== 400 && statusCode !== 403) {
      return false
    }
    const message = this._extractErrorMessage(body)
    if (!message) {
      return false
    }
    const lowerMessage = message.toLowerCase()
    return (
      lowerMessage.includes('this organization has been disabled') ||
      lowerMessage.includes('oauth authentication is currently not allowed')
    )
  }

  // 🔍 判断是否是真实的 Claude Code 请求
  isRealClaudeCodeRequest(requestBody) {
    return ClaudeCodeValidator.includesClaudeCodeSystemPrompt(requestBody, 1)
  }

  _isClaudeCodeUserAgent(clientHeaders) {
    const userAgent = clientHeaders?.['user-agent'] || clientHeaders?.['User-Agent']
    return typeof userAgent === 'string' && /^claude-cli\/[^\s]+\s+\(/i.test(userAgent)
  }

  _isActualClaudeCodeRequest(requestBody, clientHeaders) {
    return this.isRealClaudeCodeRequest(requestBody) && this._isClaudeCodeUserAgent(clientHeaders)
  }

  _getHeaderValueCaseInsensitive(headers, key) {
    if (!headers || typeof headers !== 'object') {
      return undefined
    }
    const lowerKey = key.toLowerCase()
    for (const candidate of Object.keys(headers)) {
      if (candidate.toLowerCase() === lowerKey) {
        return headers[candidate]
      }
    }
    return undefined
  }

  _isClaudeCodeCredentialError(body) {
    const message = this._extractErrorMessage(body)
    if (!message) {
      return false
    }
    const lower = message.toLowerCase()
    return (
      lower.includes('only authorized for use with claude code') ||
      lower.includes('cannot be used for other api requests')
    )
  }

  // 💰 检查是否为 "Extra usage required" 的非限流 429
  // Anthropic 对未开启 Extra Usage 的账户请求长上下文模型时返回此错误
  // 这不是真正的限流，不应标记账户为 rate limited
  _isExtraUsageRequired429(statusCode, body) {
    if (statusCode !== 429) {
      return false
    }
    const message = this._extractErrorMessage(body)
    if (!message) {
      return false
    }
    return message.toLowerCase().includes('extra usage')
  }

  _sanitizeSystemText(text) {
    if (typeof text !== 'string' || text.length === 0) {
      return text
    }

    // 对齐 sub2api：只替换固定 OpenCode 身份句，避免误改用户自定义指令。
    return text.replaceAll(
      'You are OpenCode, the best coding agent on the planet.',
      this.claudeCodeSystemPrompt
    )
  }

  _getToolNameSuffix() {
    const now = Date.now()
    if (!this.toolNameSuffix || now - this.toolNameSuffixGeneratedAt > this.toolNameSuffixTtlMs) {
      this.toolNameSuffix = Math.random().toString(36).substring(2, 8)
      this.toolNameSuffixGeneratedAt = now
    }
    return this.toolNameSuffix
  }

  _toRandomizedToolName(name) {
    const suffix = this._getToolNameSuffix()
    return `${name}_${suffix}`
  }

  _shouldMimicToolName(tool) {
    if (!tool || typeof tool !== 'object') {
      return false
    }

    const toolType = typeof tool.type === 'string' ? tool.type : ''
    return toolType === '' || toolType === 'function' || toolType === 'custom'
  }

  _shuffleToolNamePrefixes(toolNames) {
    const prefixes = [...this.fakeToolNamePrefixes]
    const seedMaterial = toolNames.join('\0')

    for (let index = prefixes.length - 1; index > 0; index -= 1) {
      const digest = crypto.createHash('sha256').update(seedMaterial).update(`:${index}`).digest()
      const swapIndex = digest.readUInt32BE(0) % (index + 1)
      const current = prefixes[index]
      prefixes[index] = prefixes[swapIndex]
      prefixes[swapIndex] = current
    }

    return prefixes
  }

  _buildDynamicToolNameMap(toolNames) {
    if (!Array.isArray(toolNames) || toolNames.length <= this.dynamicToolMapThreshold) {
      return null
    }

    const prefixes = this._shuffleToolNamePrefixes(toolNames)
    const mapping = new Map()

    toolNames.forEach((name, index) => {
      const prefix = prefixes[index % prefixes.length]
      const head = name.slice(0, Math.min(3, name.length))
      mapping.set(name, `${prefix}${head}${String(index).padStart(2, '0')}`)
    })

    return mapping
  }

  _sanitizeToolName(name, dynamicMap) {
    if (dynamicMap?.has(name)) {
      return dynamicMap.get(name)
    }

    for (const [prefix, replacement] of this.staticToolNameRewrites.entries()) {
      if (name.startsWith(prefix)) {
        return `${replacement}${name.slice(prefix.length)}`
      }
    }

    return name
  }

  _normalizeToolCatalogName(name) {
    if (typeof name !== 'string' || !name.trim()) {
      return ''
    }

    const normalized = name.trim().toLowerCase()
    return this.nonRealClaudeCodeToolAliases.get(normalized) || normalized
  }

  _hasNonRealClaudeCodeToolDescriptionFingerprint(description) {
    if (typeof description !== 'string' || !description.trim()) {
      return false
    }

    const lower = description.toLowerCase()
    return (
      this.nonRealClaudeCodeToolDescriptionFingerprints.some((marker) => lower.includes(marker)) ||
      this.nonRealClaudeCodeToolDescriptionPatterns.some((pattern) => pattern.test(description))
    )
  }

  _cleanNonRealClaudeCodeToolDescription(name, description) {
    if (typeof description !== 'string' || !description.trim()) {
      return description
    }

    const normalizedName = this._normalizeToolCatalogName(name)
    const fallbackDescription = this.nonRealClaudeCodeToolDescriptions.get(normalizedName)
    const hasFingerprint = this._hasNonRealClaudeCodeToolDescriptionFingerprint(description)

    if (fallbackDescription && hasFingerprint) {
      return fallbackDescription
    }

    if (!fallbackDescription && hasFingerprint) {
      return 'Tool available to the assistant.'
    }

    return description
  }

  _sanitizeNonRealClaudeCodeToolDescriptions(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.tools)) {
      return
    }

    body.tools.forEach((tool) => {
      if (!tool || typeof tool !== 'object') {
        return
      }

      if (typeof tool.description === 'string') {
        tool.description = this._cleanNonRealClaudeCodeToolDescription(tool.name, tool.description)
      }

      if (
        tool.custom &&
        typeof tool.custom === 'object' &&
        typeof tool.custom.description === 'string'
      ) {
        tool.custom.description = this._cleanNonRealClaudeCodeToolDescription(
          tool.name,
          tool.custom.description
        )
      }
    })
  }

  _buildToolNameRewrite(body, options = {}) {
    if (!Array.isArray(body?.tools)) {
      return null
    }

    const toolNames = []
    body.tools.forEach((tool) => {
      if (!this._shouldMimicToolName(tool) || typeof tool.name !== 'string' || !tool.name) {
        return
      }
      toolNames.push(tool.name)
    })

    const dynamicMap =
      options.useRandomizedToolNames === true
        ? new Map(toolNames.map((name) => [name, this._toRandomizedToolName(name)]))
        : this._buildDynamicToolNameMap(toolNames)

    const forwardMap = new Map()
    const reverseMap = new Map()

    toolNames.forEach((name) => {
      const transformed =
        options.useRandomizedToolNames === true
          ? dynamicMap.get(name)
          : this._sanitizeToolName(name, dynamicMap)

      if (transformed && transformed !== name) {
        forwardMap.set(name, transformed)
        reverseMap.set(transformed, name)
      }
    })

    if (reverseMap.size === 0) {
      return null
    }

    return { forwardMap, reverseMap }
  }

  _transformToolNamesInRequestBody(body, options = {}) {
    if (!body || typeof body !== 'object') {
      return null
    }

    const rewrite = this._buildToolNameRewrite(body, options)
    if (!rewrite) {
      return null
    }

    body.tools.forEach((tool) => {
      if (!this._shouldMimicToolName(tool) || typeof tool.name !== 'string') {
        return
      }

      if (rewrite.forwardMap.has(tool.name)) {
        tool.name = rewrite.forwardMap.get(tool.name)
      }
    })

    if (
      body.tool_choice &&
      typeof body.tool_choice === 'object' &&
      body.tool_choice.type === 'tool' &&
      typeof body.tool_choice.name === 'string'
    ) {
      if (rewrite.forwardMap.has(body.tool_choice.name)) {
        body.tool_choice.name = rewrite.forwardMap.get(body.tool_choice.name)
      }
    }

    return rewrite.reverseMap
  }

  _restoreToolNamesInText(text, toolNameMap, includeStatic = true) {
    if (typeof text !== 'string' || text.length === 0) {
      return text
    }

    let restored = text

    if (toolNameMap && toolNameMap.size > 0) {
      const orderedEntries = [...toolNameMap.entries()].sort(
        ([leftFake], [rightFake]) => rightFake.length - leftFake.length
      )

      orderedEntries.forEach(([fake, real]) => {
        if (fake && fake !== real && restored.includes(fake)) {
          restored = restored.split(fake).join(real)
        }
      })
    }

    if (includeStatic) {
      this.staticToolNameRewrites.forEach((replacement, prefix) => {
        if (restored.includes(replacement)) {
          restored = restored.split(replacement).join(prefix)
        }
      })
    }

    return restored
  }

  _restoreToolName(name, toolNameMap) {
    if (!toolNameMap || toolNameMap.size === 0) {
      return name
    }
    return toolNameMap.get(name) || name
  }

  _restoreToolNamesInContentBlocks(content, toolNameMap) {
    if (!Array.isArray(content)) {
      return
    }

    content.forEach((block) => {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        block.name = this._restoreToolName(block.name, toolNameMap)
      }
    })
  }

  _restoreToolNamesInResponseObject(responseBody, toolNameMap) {
    if (!responseBody || typeof responseBody !== 'object') {
      return
    }

    if (Array.isArray(responseBody.content)) {
      this._restoreToolNamesInContentBlocks(responseBody.content, toolNameMap)
    }

    if (responseBody.message && Array.isArray(responseBody.message.content)) {
      this._restoreToolNamesInContentBlocks(responseBody.message.content, toolNameMap)
    }
  }

  _restoreToolNamesInResponseBody(responseBody, toolNameMap) {
    if (!responseBody) {
      return responseBody
    }

    if (typeof responseBody === 'string') {
      try {
        const restored = this._restoreToolNamesInText(responseBody, toolNameMap, true)
        const parsed = JSON.parse(restored)
        return JSON.stringify(parsed)
      } catch (error) {
        return this._restoreToolNamesInText(responseBody, toolNameMap, true)
      }
    }

    if (typeof responseBody === 'object') {
      try {
        const restored = this._restoreToolNamesInText(
          JSON.stringify(responseBody),
          toolNameMap,
          true
        )
        return JSON.parse(restored)
      } catch (error) {
        this._restoreToolNamesInResponseObject(responseBody, toolNameMap)
      }
    }

    return responseBody
  }

  _restoreToolNamesInStreamEvent(event, toolNameMap) {
    if (!event || typeof event !== 'object') {
      return
    }

    if (event.content_block && event.content_block.type === 'tool_use') {
      if (typeof event.content_block.name === 'string') {
        event.content_block.name = this._restoreToolName(event.content_block.name, toolNameMap)
      }
    }

    if (event.delta && event.delta.type === 'tool_use') {
      if (typeof event.delta.name === 'string') {
        event.delta.name = this._restoreToolName(event.delta.name, toolNameMap)
      }
    }

    if (event.message && Array.isArray(event.message.content)) {
      this._restoreToolNamesInContentBlocks(event.message.content, toolNameMap)
    }

    if (Array.isArray(event.content)) {
      this._restoreToolNamesInContentBlocks(event.content, toolNameMap)
    }
  }

  _createToolNameStripperStreamTransformer(streamTransformer, toolNameMap, includeStatic = false) {
    if ((!toolNameMap || toolNameMap.size === 0) && !includeStatic) {
      return streamTransformer
    }

    return (payload) => {
      const transformed = streamTransformer ? streamTransformer(payload) : payload
      if (!transformed || typeof transformed !== 'string') {
        return transformed
      }

      return this._restoreToolNamesInText(transformed, toolNameMap, includeStatic)
    }
  }

  // 🚀 转发请求到Claude API
  async relayRequest(
    requestBody,
    apiKeyData,
    clientRequest,
    clientResponse,
    clientHeaders,
    options = {}
  ) {
    let upstreamRequest = null
    let queueLockAcquired = false
    let queueRequestId = null
    let selectedAccountId = null
    let bodyStoreIdNonStream = null // 🧹 在 try 块外声明，以便 finally 清理

    try {
      // 调试日志：查看API Key数据
      logger.info('🔍 API Key data received:', {
        apiKeyName: apiKeyData.name,
        enableModelRestriction: apiKeyData.enableModelRestriction,
        restrictedModels: apiKeyData.restrictedModels,
        requestedModel: requestBody.model
      })

      const isOpusModelRequest =
        typeof requestBody?.model === 'string' && requestBody.model.toLowerCase().includes('opus')

      // 生成会话哈希用于sticky会话
      const sessionHash = sessionHelper.generateSessionHash(requestBody)

      // 选择可用的Claude账户（支持专属绑定和sticky会话）
      let accountSelection
      try {
        accountSelection = await unifiedClaudeScheduler.selectAccountForApiKey(
          apiKeyData,
          sessionHash,
          requestBody.model
        )
      } catch (error) {
        if (error.code === 'CLAUDE_DEDICATED_RATE_LIMITED') {
          const limitMessage = this._buildStandardRateLimitMessage(error.rateLimitEndAt)
          logger.warn(
            `🚫 Dedicated account ${error.accountId} is rate limited for API key ${apiKeyData.name}, returning 403`
          )
          return {
            statusCode: 403,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              error: 'upstream_rate_limited',
              message: limitMessage
            }),
            accountId: error.accountId
          }
        }
        throw error
      }
      const { accountId } = accountSelection
      const { accountType } = accountSelection
      selectedAccountId = accountId

      logger.info(
        `📤 Processing API request for key: ${apiKeyData.name || apiKeyData.id}, account: ${accountId} (${accountType})${sessionHash ? `, session: ${sessionHash}` : ''}`
      )

      // 📬 用户消息队列处理：如果是用户消息请求，需要获取队列锁
      if (userMessageQueueService.isUserMessageRequest(requestBody)) {
        // 校验 accountId 非空，避免空值污染队列锁键
        if (!accountId || accountId === '') {
          logger.error('❌ accountId missing for queue lock in relayRequest')
          throw new Error('accountId missing for queue lock')
        }
        // 获取账户信息以检查账户级串行队列配置
        const accountForQueue = await claudeAccountService.getAccount(accountId)
        const accountConfig = accountForQueue
          ? { maxConcurrency: parseInt(accountForQueue.maxConcurrency || '0', 10) }
          : null
        const queueResult = await userMessageQueueService.acquireQueueLock(
          accountId,
          null,
          null,
          accountConfig
        )
        if (!queueResult.acquired && !queueResult.skipped) {
          // 区分 Redis 后端错误和队列超时
          const isBackendError = queueResult.error === 'queue_backend_error'
          const errorCode = isBackendError ? 'QUEUE_BACKEND_ERROR' : 'QUEUE_TIMEOUT'
          const errorType = isBackendError ? 'queue_backend_error' : 'queue_timeout'
          const errorMessage = isBackendError
            ? 'Queue service temporarily unavailable, please retry later'
            : 'User message queue wait timeout, please retry later'
          const statusCode = isBackendError ? 500 : 503

          // 结构化性能日志，用于后续统计
          logger.performance('user_message_queue_error', {
            errorType,
            errorCode,
            accountId,
            statusCode,
            apiKeyName: apiKeyData.name,
            backendError: isBackendError ? queueResult.errorMessage : undefined
          })

          logger.warn(
            `📬 User message queue ${errorType} for account ${accountId}, key: ${apiKeyData.name}`,
            isBackendError ? { backendError: queueResult.errorMessage } : {}
          )
          return {
            statusCode,
            headers: {
              'Content-Type': 'application/json',
              'x-user-message-queue-error': errorType
            },
            body: JSON.stringify({
              type: 'error',
              error: {
                type: errorType,
                code: errorCode,
                message: errorMessage
              }
            }),
            accountId
          }
        }
        if (queueResult.acquired && !queueResult.skipped) {
          queueLockAcquired = true
          queueRequestId = queueResult.requestId
          logger.debug(
            `📬 User message queue lock acquired for account ${accountId}, requestId: ${queueRequestId}`
          )
        }
      }

      // 获取账户信息
      let account = await claudeAccountService.getAccount(accountId)

      if (isOpusModelRequest) {
        await claudeAccountService.clearExpiredOpusRateLimit(accountId)
        account = await claudeAccountService.getAccount(accountId)
      }

      const isDedicatedOfficialAccount =
        accountType === 'claude-official' &&
        apiKeyData.claudeAccountId &&
        !apiKeyData.claudeAccountId.startsWith('group:') &&
        apiKeyData.claudeAccountId === accountId

      let opusRateLimitActive = false
      let opusRateLimitEndAt = null
      if (isOpusModelRequest) {
        opusRateLimitActive = await claudeAccountService.isAccountOpusRateLimited(accountId)
        opusRateLimitEndAt = account?.opusRateLimitEndAt || null
      }

      if (isOpusModelRequest && isDedicatedOfficialAccount && opusRateLimitActive) {
        const limitMessage = this._buildOpusLimitMessage(opusRateLimitEndAt)
        logger.warn(
          `🚫 Dedicated account ${account?.name || accountId} is under Opus weekly limit until ${opusRateLimitEndAt}`
        )
        return {
          statusCode: 403,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'opus_weekly_limit',
            message: limitMessage
          }),
          accountId
        }
      }

      // 获取有效的访问token
      const accessToken = await claudeAccountService.getValidAccessToken(accountId)

      // 🎓 该识别结果仅用于 header 缓存学习（storeAccountHeaders），不影响转发行为
      const isRealClaudeCodeRequest = this._isActualClaudeCodeRequest(requestBody, clientHeaders)
      const processedBody = this._processRequestBody(
        requestBody,
        account,
        isRealClaudeCodeRequest,
        {
          entrypoint: this._resolveEntrypoint(clientHeaders, account)
        }
      )
      // 🔗 注入同会话上一轮的链式引用（cc_prev_req / diagnostics.previous_message_id）——对所有请求生效
      await this._applyTurnChaining(processedBody)
      // 🧹 内存优化：存储到 bodyStore，避免闭包捕获
      const originalBodyString = JSON.stringify(processedBody)
      bodyStoreIdNonStream = ++this._bodyStoreIdCounter
      this.bodyStore.set(bodyStoreIdNonStream, originalBodyString)

      // 获取代理配置
      const proxyAgent = await this._getProxyAgent(accountId)

      // 设置客户端断开监听器
      const handleClientDisconnect = () => {
        logger.info('🔌 Client disconnected, aborting upstream request')
        if (upstreamRequest && !upstreamRequest.destroyed) {
          upstreamRequest.destroy()
        }
      }

      // 监听客户端断开事件
      if (clientRequest) {
        clientRequest.once('close', handleClientDisconnect)
      }
      if (clientResponse) {
        clientResponse.once('close', handleClientDisconnect)
      }

      const makeRequestWithRetries = async (requestOptions) => {
        const maxRetries = this._shouldRetryOn403(accountType) ? 2 : 0
        let retryCount = 0
        let response
        let shouldRetry = false

        do {
          // 🧹 每次重试从 bodyStore 解析新对象，避免闭包捕获
          let retryRequestBody
          try {
            retryRequestBody = JSON.parse(this.bodyStore.get(bodyStoreIdNonStream))
          } catch (parseError) {
            logger.error(`❌ Failed to parse body for retry: ${parseError.message}`)
            throw new Error(`Request body parse failed: ${parseError.message}`)
          }
          response = await this._makeClaudeRequest(
            retryRequestBody,
            accessToken,
            proxyAgent,
            clientHeaders,
            accountId,
            (req) => {
              upstreamRequest = req
            },
            {
              ...requestOptions,
              isRealClaudeCodeRequest
            }
          )

          shouldRetry = response.statusCode === 403 && retryCount < maxRetries
          if (shouldRetry) {
            retryCount++
            logger.warn(
              `🔄 403 error for account ${accountId}, retry ${retryCount}/${maxRetries} after 2s`
            )
            await this._sleep(2000)
          }
        } while (shouldRetry)

        return { response, retryCount }
      }

      let requestOptions = options
      let { response, retryCount } = await makeRequestWithRetries(requestOptions)

      if (
        this._isClaudeCodeCredentialError(response.body) &&
        requestOptions.useRandomizedToolNames !== true
      ) {
        requestOptions = { ...requestOptions, useRandomizedToolNames: true }
        ;({ response, retryCount } = await makeRequestWithRetries(requestOptions))
      }

      // 如果进行了重试，记录最终结果
      if (retryCount > 0) {
        if (response.statusCode === 403) {
          logger.error(`🚫 403 error persists for account ${accountId} after ${retryCount} retries`)
        } else {
          logger.info(
            `✅ 403 retry successful for account ${accountId} on attempt ${retryCount}, got status ${response.statusCode}`
          )
        }
      }

      // 📬 请求已发送成功，立即释放队列锁（无需等待响应处理完成）
      // 因为 Claude API 限流基于请求发送时刻计算（RPM），不是请求完成时刻
      if (queueLockAcquired && queueRequestId && selectedAccountId) {
        try {
          await userMessageQueueService.releaseQueueLock(selectedAccountId, queueRequestId)
          queueLockAcquired = false // 标记已释放，防止 finally 重复释放
          logger.debug(
            `📬 User message queue lock released early for account ${selectedAccountId}, requestId: ${queueRequestId}`
          )
        } catch (releaseError) {
          logger.error(
            `❌ Failed to release user message queue lock early for account ${selectedAccountId}:`,
            releaseError.message
          )
        }
      }

      response.accountId = accountId
      response.accountType = accountType

      // 移除监听器（请求成功完成）
      if (clientRequest) {
        clientRequest.removeListener('close', handleClientDisconnect)
      }
      if (clientResponse) {
        clientResponse.removeListener('close', handleClientDisconnect)
      }

      // 检查响应是否为限流错误或认证错误
      if (response.statusCode !== 200 && response.statusCode !== 201) {
        let isRateLimited = false
        let rateLimitResetTimestamp = null
        let dedicatedRateLimitMessage = null
        const organizationDisabledError = this._isOrganizationDisabledError(
          response.statusCode,
          response.body
        )

        // 检查是否为401状态码（未授权）
        if (response.statusCode === 401) {
          logger.warn(`🔐 Unauthorized error (401) detected for account ${accountId}`)

          // 🔄 尝试通过 credentials 文件刷新 token
          let refreshSuccess = false
          let refreshedAccessToken = null
          try {
            logger.info(
              `🔄 Attempting credentials-based token refresh for account ${accountId} due to 401...`
            )
            const refreshResult = await claudeAccountService.refreshTokenViaCredentials(
              accountId,
              'upstream_error'
            )
            if (refreshResult && refreshResult.success && refreshResult.accessToken) {
              logger.success(
                `✅ Token refreshed successfully via credentials for account ${accountId}`
              )
              refreshSuccess = true
              refreshedAccessToken = refreshResult.accessToken
            }
          } catch (refreshError) {
            logger.warn(
              `⚠️ Credentials-based refresh failed for account ${accountId}: ${refreshError.message}`
            )
          }

          // 🔄 如果刷新成功，重试请求
          if (refreshSuccess) {
            logger.info(`🔄 Retrying request after token refresh for account ${accountId}...`)
            try {
              // 使用 refresh 直接返回的新 token，避免重复调用 getValidAccessToken
              const newAccessToken = refreshedAccessToken
              // 从 bodyStore 获取请求体
              const retryRequestBody = JSON.parse(this.bodyStore.get(bodyStoreIdNonStream))
              // 重试请求
              response = await this._makeClaudeRequest(
                retryRequestBody,
                newAccessToken,
                proxyAgent,
                clientHeaders,
                accountId,
                (req) => {
                  upstreamRequest = req
                },
                { ...requestOptions, isRealClaudeCodeRequest }
              )
              response.accountId = accountId
              response.accountType = accountType
              logger.success(
                `✅ Request retry successful after token refresh for account ${accountId}, status: ${response.statusCode}`
              )

              // 如果重试成功（200/201），跳过错误处理
              if (response.statusCode === 200 || response.statusCode === 201) {
                // 移除监听器
                if (clientRequest) {
                  clientRequest.removeListener('close', handleClientDisconnect)
                }
                if (clientResponse) {
                  clientResponse.removeListener('close', handleClientDisconnect)
                }
                // 清理 bodyStore
                this.bodyStore.delete(bodyStoreIdNonStream)
                return response
              }
            } catch (retryError) {
              logger.error(
                `❌ Request retry failed after token refresh for account ${accountId}: ${retryError.message}`
              )
            }
          }

          // 记录401错误
          await this.recordUnauthorizedError(accountId)

          // 检查是否需要标记为异常（遇到1次401就停止调度）
          const errorCount = await this.getUnauthorizedErrorCount(accountId)
          logger.info(
            `🔐 Account ${accountId} has ${errorCount} consecutive 401 errors in the last 5 minutes`
          )

          if (errorCount >= 1) {
            logger.error(
              `❌ Account ${accountId} encountered 401 error (${errorCount} errors), temporarily pausing`
            )
          }
          await upstreamErrorHelper.markTempUnavailable(accountId, accountType, 401).catch(() => {})
          // 清除粘性会话，让后续请求路由到其他账户
          if (sessionHash) {
            await unifiedClaudeScheduler.clearSessionMapping(sessionHash).catch(() => {})
          }
        }
        // 检查是否为组织被禁用/封禁错误（400 或 403）
        // 必须在通用 403 处理之前检测，否则会被截断
        else if (organizationDisabledError) {
          logger.error(
            `🚫 Organization disabled/banned error (${response.statusCode}) detected for account ${accountId}, marking as blocked`
          )
          await unifiedClaudeScheduler.markAccountBlocked(accountId, accountType, sessionHash)
        }
        // 检查是否为403状态码（禁止访问，非封禁类）
        // 注意：如果进行了重试，retryCount > 0；这里的 403 是重试后最终的结果
        else if (response.statusCode === 403) {
          logger.error(
            `🚫 Forbidden error (403) detected for account ${accountId}${retryCount > 0 ? ` after ${retryCount} retries` : ''}, temporarily pausing`
          )
          await upstreamErrorHelper.markTempUnavailable(accountId, accountType, 403).catch(() => {})
          // 清除粘性会话，让后续请求路由到其他账户
          if (sessionHash) {
            await unifiedClaudeScheduler.clearSessionMapping(sessionHash).catch(() => {})
          }
        }
        // 检查是否为529状态码（服务过载）
        else if (response.statusCode === 529) {
          logger.warn(`🚫 Overload error (529) detected for account ${accountId}`)

          // 检查是否启用了529错误处理
          if (config.claude.overloadHandling.enabled > 0) {
            try {
              await claudeAccountService.markAccountOverloaded(accountId)
              logger.info(
                `🚫 Account ${accountId} marked as overloaded for ${config.claude.overloadHandling.enabled} minutes`
              )
            } catch (overloadError) {
              logger.error(`❌ Failed to mark account as overloaded: ${accountId}`, overloadError)
            }
          } else {
            logger.info(`🚫 529 error handling is disabled, skipping account overload marking`)
          }
          await upstreamErrorHelper.markTempUnavailable(accountId, accountType, 529).catch(() => {})
        }
        // 检查是否为5xx状态码
        else if (response.statusCode >= 500 && response.statusCode < 600) {
          logger.warn(`🔥 Server error (${response.statusCode}) detected for account ${accountId}`)
          await this._handleServerError(accountId, response.statusCode, sessionHash)
        }
        // 检查是否为429状态码
        else if (response.statusCode === 429) {
          // 💰 先检查是否为 "Extra usage required" 的非限流 429
          if (this._isExtraUsageRequired429(response.statusCode, response.body)) {
            logger.info(
              `💰 [Non-Stream] "Extra usage required" 429 for account ${accountId}, skipping rate limit marking`
            )
          } else {
            const resetHeader = response.headers
              ? response.headers['anthropic-ratelimit-unified-reset']
              : null
            const parsedResetTimestamp = resetHeader ? parseInt(resetHeader, 10) : NaN

            if (isOpusModelRequest && !Number.isNaN(parsedResetTimestamp)) {
              await claudeAccountService.markAccountOpusRateLimited(accountId, parsedResetTimestamp)
              logger.warn(
                `🚫 Account ${accountId} hit Opus limit, resets at ${new Date(parsedResetTimestamp * 1000).toISOString()}`
              )

              if (isDedicatedOfficialAccount) {
                const limitMessage = this._buildOpusLimitMessage(parsedResetTimestamp)
                return {
                  statusCode: 403,
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    error: 'opus_weekly_limit',
                    message: limitMessage
                  }),
                  accountId
                }
              }
            } else {
              isRateLimited = true
              if (!Number.isNaN(parsedResetTimestamp)) {
                rateLimitResetTimestamp = parsedResetTimestamp
                logger.info(
                  `🕐 Extracted rate limit reset timestamp: ${rateLimitResetTimestamp} (${new Date(rateLimitResetTimestamp * 1000).toISOString()})`
                )
              }
              if (isDedicatedOfficialAccount) {
                dedicatedRateLimitMessage = this._buildStandardRateLimitMessage(
                  rateLimitResetTimestamp || account?.rateLimitEndAt
                )
              }
            }
          }
        } else {
          // 检查响应体中的错误信息
          try {
            const responseBody =
              typeof response.body === 'string' ? JSON.parse(response.body) : response.body
            if (
              responseBody &&
              responseBody.error &&
              responseBody.error.message &&
              responseBody.error.message.toLowerCase().includes("exceed your account's rate limit")
            ) {
              isRateLimited = true
            }
          } catch (e) {
            // 如果解析失败，检查原始字符串
            if (
              response.body &&
              response.body.toLowerCase().includes("exceed your account's rate limit")
            ) {
              isRateLimited = true
            }
          }
        }

        if (isRateLimited) {
          if (isDedicatedOfficialAccount && !dedicatedRateLimitMessage) {
            dedicatedRateLimitMessage = this._buildStandardRateLimitMessage(
              rateLimitResetTimestamp || account?.rateLimitEndAt
            )
          }
          logger.warn(
            `🚫 Rate limit detected for account ${accountId}, status: ${response.statusCode}`
          )
          // 标记账号为限流状态并删除粘性会话映射，传递准确的重置时间戳
          await unifiedClaudeScheduler.markAccountRateLimited(
            accountId,
            accountType,
            sessionHash,
            rateLimitResetTimestamp
          )
          await upstreamErrorHelper
            .markTempUnavailable(
              accountId,
              accountType,
              429,
              upstreamErrorHelper.parseRetryAfter(response.headers)
            )
            .catch(() => {})

          if (dedicatedRateLimitMessage) {
            return {
              statusCode: 403,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                error: 'upstream_rate_limited',
                message: dedicatedRateLimitMessage
              }),
              accountId
            }
          }
        }
      } else if (response.statusCode === 200 || response.statusCode === 201) {
        // 提取5小时会话窗口状态
        // 使用大小写不敏感的方式获取响应头
        const get5hStatus = (headers) => {
          if (!headers) {
            return null
          }
          // HTTP头部名称不区分大小写，需要处理不同情况
          return (
            headers['anthropic-ratelimit-unified-5h-status'] ||
            headers['Anthropic-Ratelimit-Unified-5h-Status'] ||
            headers['ANTHROPIC-RATELIMIT-UNIFIED-5H-STATUS']
          )
        }

        const sessionWindowStatus = get5hStatus(response.headers)
        if (sessionWindowStatus) {
          logger.info(`📊 Session window status for account ${accountId}: ${sessionWindowStatus}`)
          // 保存会话窗口状态到账户数据
          await claudeAccountService.updateSessionWindowStatus(accountId, sessionWindowStatus)
        }

        // 请求成功，清除401和500错误计数
        await this.clearUnauthorizedErrors(accountId)
        await claudeAccountService.clearInternalErrors(accountId)
        // 如果请求成功，检查并移除限流状态
        const isRateLimited = await unifiedClaudeScheduler.isAccountRateLimited(
          accountId,
          accountType
        )
        if (isRateLimited) {
          await unifiedClaudeScheduler.removeAccountRateLimit(accountId, accountType)
        }

        // 如果请求成功，检查并移除过载状态
        try {
          const isOverloaded = await claudeAccountService.isAccountOverloaded(accountId)
          if (isOverloaded) {
            await claudeAccountService.removeAccountOverload(accountId)
          }
        } catch (overloadError) {
          logger.error(
            `❌ Failed to check/remove overload status for account ${accountId}:`,
            overloadError
          )
        }

        // 只有真实的 Claude Code 请求才更新 headers
        if (
          clientHeaders &&
          Object.keys(clientHeaders).length > 0 &&
          this.isRealClaudeCodeRequest(requestBody)
        ) {
          await claudeCodeHeadersService.storeAccountHeaders(accountId, clientHeaders)
        }
      }

      // 记录成功的API调用并打印详细的usage数据
      let responseBody = null
      try {
        responseBody = typeof response.body === 'string' ? JSON.parse(response.body) : response.body
      } catch (e) {
        logger.debug('Failed to parse response body for usage logging')
      }

      if (responseBody && responseBody.usage) {
        const { usage } = responseBody
        // 打印原始usage数据为JSON字符串
        logger.info(
          `📊 === Non-Stream Request Usage Summary === Model: ${requestBody.model}, Usage: ${JSON.stringify(usage)}`
        )
      } else {
        // 如果没有usage数据，使用估算值
        const inputTokens = requestBody.messages
          ? requestBody.messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) / 4
          : 0
        const outputTokens = response.content
          ? response.content.reduce((sum, content) => sum + (content.text?.length || 0), 0) / 4
          : 0

        logger.info(
          `✅ API request completed - Key: ${apiKeyData.name}, Account: ${accountId}, Model: ${requestBody.model}, Input: ~${Math.round(inputTokens)} tokens (estimated), Output: ~${Math.round(outputTokens)} tokens (estimated)`
        )
      }

      // 在响应中添加accountId，以便调用方记录账户级别统计
      response.accountId = accountId
      return response
    } catch (error) {
      logger.error(
        `❌ Claude relay request failed for key: ${apiKeyData.name || apiKeyData.id}:`,
        error.message
      )
      throw error
    } finally {
      // 🧹 清理 bodyStore
      if (bodyStoreIdNonStream !== null) {
        this.bodyStore.delete(bodyStoreIdNonStream)
      }
      // 📬 释放用户消息队列锁（兜底，正常情况下已在请求发送后提前释放）
      if (queueLockAcquired && queueRequestId && selectedAccountId) {
        try {
          await userMessageQueueService.releaseQueueLock(selectedAccountId, queueRequestId)
          logger.debug(
            `📬 User message queue lock released in finally for account ${selectedAccountId}, requestId: ${queueRequestId}`
          )
        } catch (releaseError) {
          logger.error(
            `❌ Failed to release user message queue lock for account ${selectedAccountId}:`,
            releaseError.message
          )
        }
      }
    }
  }

  // 🔧 修补孤立的 tool_use（缺少对应 tool_result）
  // 客户端在长对话中可能截断历史消息，导致 tool_use 丢失对应的 tool_result，
  // 上游 Claude API 严格校验每个 tool_use 必须紧跟 tool_result，否则返回 400。
  _patchOrphanedToolUse(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return messages
    }

    const SYNTHETIC_TEXT = '[tool_result missing; tool execution interrupted]'
    const makeSyntheticResult = (toolUseId) => ({
      type: 'tool_result',
      tool_use_id: toolUseId,
      is_error: true,
      content: [{ type: 'text', text: SYNTHETIC_TEXT }]
    })

    const pendingToolUseIds = []
    const patched = []

    for (const message of messages) {
      if (!message || !Array.isArray(message.content)) {
        patched.push(message)
        continue
      }

      if (message.role === 'assistant') {
        if (pendingToolUseIds.length > 0) {
          patched.push({
            role: 'user',
            content: pendingToolUseIds.map(makeSyntheticResult)
          })
          logger.warn(
            `🔧 Patched ${pendingToolUseIds.length} orphaned tool_use(s): ${pendingToolUseIds.join(', ')}`
          )
          pendingToolUseIds.length = 0
        }

        const toolUseIds = message.content
          .filter((part) => part?.type === 'tool_use' && typeof part.id === 'string')
          .map((part) => part.id)
        if (toolUseIds.length > 0) {
          pendingToolUseIds.push(...toolUseIds)
        }

        patched.push(message)
        continue
      }

      if (message.role === 'user' && pendingToolUseIds.length > 0) {
        const toolResultIds = new Set(
          message.content
            .filter((p) => p?.type === 'tool_result' && typeof p.tool_use_id === 'string')
            .map((p) => p.tool_use_id)
        )
        const missing = pendingToolUseIds.filter((id) => !toolResultIds.has(id))

        if (missing.length > 0) {
          const synthetic = missing.map(makeSyntheticResult)
          logger.warn(
            `🔧 Patched ${missing.length} missing tool_result(s) in user message: ${missing.join(', ')}`
          )
          message.content = [...synthetic, ...message.content]
        }

        pendingToolUseIds.length = 0
      }

      patched.push(message)
    }

    if (pendingToolUseIds.length > 0) {
      patched.push({
        role: 'user',
        content: pendingToolUseIds.map(makeSyntheticResult)
      })
      logger.warn(
        `🔧 Patched ${pendingToolUseIds.length} trailing orphaned tool_use(s): ${pendingToolUseIds.join(', ')}`
      )
    }

    return patched
  }

  // 🧠 预过滤无效签名的 thinking 块（P1：只删无效，保留有效，避免上下文丢失）。
  //
  // 背景：Anthropic 扩展思考要求历史 assistant 轮的 thinking/redacted_thinking 块携带
  // 有效 signature，否则整个请求 400 "Invalid signature in thinking block"。
  // 客户端（OpenClaw/SDK 等）回传历史时常丢失或置空 signature。
  //
  // 策略（对齐 sub2api filterThinkingBlocksInternal）：
  //   - 仅当 thinking.type 为 enabled/adaptive 时处理；
  //   - 仅对 role=assistant 的消息：thinking/redacted_thinking 块，signature 有效
  //     （非空、非 dummy 占位）才保留，否则丢弃；
  //   - 若某消息内容被清空，补一个占位 text，避免上游 400 "content must be non-empty"。
  // 与「删除全部 thinking 的 retry 兜底」互补：本预过滤在发送前主动清理，尽量不触发 400。
  _filterInvalidThinkingBlocks(body) {
    if (!body || !Array.isArray(body.messages)) {
      return
    }
    const thinkingType = body.thinking && body.thinking.type
    const thinkingEnabled = thinkingType === 'enabled' || thinkingType === 'adaptive'
    if (!thinkingEnabled) {
      return
    }

    const DUMMY_SIGNATURES = new Set(['', 'dummy', 'DUMMY', 'placeholder'])
    const isValidSignature = (sig) =>
      typeof sig === 'string' && sig.trim().length > 0 && !DUMMY_SIGNATURES.has(sig.trim())

    let removed = 0
    for (const message of body.messages) {
      if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) {
        continue
      }
      const before = message.content.length
      message.content = message.content.filter((block) => {
        if (!block || typeof block !== 'object') {
          return true
        }
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          // redacted_thinking 用 data 字段（无 signature 校验）→ 保留；
          // thinking 块必须有有效 signature，否则丢弃。
          if (block.type === 'redacted_thinking') {
            return true
          }
          return isValidSignature(block.signature)
        }
        return true
      })
      const removedHere = before - message.content.length
      if (removedHere > 0) {
        removed += removedHere
        if (message.content.length === 0) {
          message.content = [{ type: 'text', text: '(thinking redacted)' }]
        }
      }
    }
    if (removed > 0) {
      logger.info(`🧠 Pre-filtered ${removed} thinking block(s) with invalid/missing signature`)
    }
  }

  _normalizeSystemEntry(entry) {
    if (typeof entry === 'string') {
      const text = this._sanitizeSystemText(entry)
      return text.trim() ? { type: 'text', text } : null
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null
    }

    if (typeof entry.text !== 'string') {
      return null
    }

    if (!entry.text.trim()) {
      return null
    }

    const text = this._sanitizeSystemText(entry.text)

    return {
      ...entry,
      type: 'text',
      text
    }
  }

  // 🏷️ 取当前 emulation 能力档案（版本 → 请求形态的唯一事实来源）
  _getProfile() {
    return claudeCodeProfile.getProfile()
  }

  // 📄 通用说明块文案。优先级：
  //   1) config.claude.emulationSystemPrompt —— 专门用于覆盖该块的配置项
  //   2) config.claude.systemPrompt          —— 历史配置项，统一化后并入本块（不再追加成额外 system 块）
  //   3) 档案默认文案
  // 不使用自造的固定长句（那会形成跨部署共享指纹）。
  _getGenericInstructions() {
    const candidates = [
      config.claude && config.claude.emulationSystemPrompt,
      config.claude && config.claude.systemPrompt
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim()
      }
    }
    return this._getProfile().system.genericInstructions
  }

  // 🧭 解析本次请求应声明的 Claude Code 入口类型（cli / sdk-cli…）。
  // 客户端本身就是 Claude Code 时跟随其 UA；否则用档案默认入口。
  _resolveEntrypoint(clientHeaders, account = null) {
    if (account && account.claudeCodeEntrypoint) {
      return String(account.claudeCodeEntrypoint).trim() || claudeCodeProfile.DEFAULT_ENTRYPOINT
    }
    const ua = this._getHeaderValueCaseInsensitive(clientHeaders, 'user-agent')
    const fromUA = claudeCodeProfile.extractEntrypoint(ua)
    if (fromUA) {
      return fromUA
    }
    return claudeCodeProfile.DEFAULT_ENTRYPOINT
  }

  // P0: build clean system blocks（identity + 通用说明）。
  // Anthropic detects third-party apps via system content. Original client system
  // must be moved to messages (see _moveSystemToMessages). Billing header injected
  // later by _injectDynamicBillingHeader as system[0].
  // cache_control 的 ttl / scope 按档案给出（2.1.280 抓包为 ttl:1h，通用块额外带 scope:global）。
  _buildClaudeCodeSystem(_system) {
    const profile = this._getProfile()
    return [
      { type: 'text', text: this.claudeCodeSystemPrompt },
      {
        type: 'text',
        text: this._getGenericInstructions(),
        cache_control: { ...profile.system.cacheControl }
      }
    ]
  }

  // P0: 把客户端原始 system 迁入 messages，避免第三方身份泄漏在 system 字段。
  //
  // 形态由档案 clientSystemAsSystemMessage 决定：
  //   true  → role:"system" 条目（与 2.1.280 抓包一致，messages 中出现 role:"system"；
  //           依赖 mid-conversation-system-2026-04-07 beta，已在该档案 beta 列表中）
  //   false → 合并进首条 user 消息的 text block（更保守的兼容形态）
  // 说明：此处不再插入自造的 "[System Instructions]" 前缀与固定应答句——
  //       这两者在所有部署中字节相同，本身即构成固定指纹。
  _moveSystemToMessages(body) {
    if (!body || !body.system) {
      return body
    }

    let originalText = ''
    const system = body.system

    if (typeof system === 'string') {
      originalText = this._sanitizeSystemText(system).trim()
    } else if (Array.isArray(system)) {
      const parts = []
      for (const entry of system) {
        if (!entry) continue
        let raw = ''
        if (typeof entry === 'string') {
          raw = entry.trim()
        } else if (typeof entry === 'object' && typeof entry.text === 'string') {
          raw = entry.text.trim()
        }
        if (!raw || raw.startsWith('x-anthropic-billing-header')) {
          continue
        }
        // 复用身份句改写：避免第三方身份（如 OpenCode）随 system 迁入 messages 后泄漏给上游
        const t = this._sanitizeSystemText(raw).trim()
        if (t && t !== this.claudeCodeSystemPrompt) {
          parts.push(t)
        }
      }
      originalText = parts.join('\n\n')
    }

    // Skip if no meaningful content or already pure Claude Code identity
    if (!originalText || originalText === this.claudeCodeSystemPrompt.trim()) {
      return body
    }

    if (!Array.isArray(body.messages)) {
      body.messages = []
    }

    if (this._getProfile().clientSystemAsSystemMessage) {
      body.messages = [
        { role: 'system', content: [{ type: 'text', text: originalText }] },
        ...body.messages
      ]
      return body
    }

    // 保守形态：并入首条 user 消息（无 user 消息时新建一条）
    const firstUser = body.messages.find((m) => m && m.role === 'user')
    if (firstUser) {
      if (typeof firstUser.content === 'string') {
        firstUser.content = [
          { type: 'text', text: originalText },
          { type: 'text', text: firstUser.content }
        ]
      } else if (Array.isArray(firstUser.content)) {
        firstUser.content = [{ type: 'text', text: originalText }, ...firstUser.content]
      } else {
        firstUser.content = [{ type: 'text', text: originalText }]
      }
    } else {
      body.messages = [
        { role: 'user', content: [{ type: 'text', text: originalText }] },
        ...body.messages
      ]
    }
    return body
  }

  // 🔤 提取 messages 中第一条 role=user 消息的首段 text（兼容 string / block[] 两种 content）。
  _extractFirstUserText(body) {
    if (!body || !Array.isArray(body.messages)) {
      return ''
    }
    for (const msg of body.messages) {
      if (!msg || msg.role !== 'user') {
        continue
      }
      const content = msg.content
      if (typeof content === 'string') {
        return content
      }
      if (Array.isArray(content)) {
        const textBlock = content.find((b) => b && b.type === 'text' && typeof b.text === 'string')
        return textBlock ? textBlock.text : ''
      }
      return ''
    }
    return ''
  }

  // 🆔 从 account 记录解析 Claude 真实 account_uuid（来自 /api/oauth/profile，存于 subscriptionInfo）。
  // 支持直接字段 account.accountUuid / account.account_uuid，或 subscriptionInfo(JSON 字符串/对象)。
  _getAccountUuid(account) {
    if (!account) {
      return ''
    }
    if (typeof account.accountUuid === 'string' && account.accountUuid.trim()) {
      return account.accountUuid.trim()
    }
    if (typeof account.account_uuid === 'string' && account.account_uuid.trim()) {
      return account.account_uuid.trim()
    }
    const sub = account.subscriptionInfo
    if (sub) {
      try {
        const parsed = typeof sub === 'string' ? JSON.parse(sub) : sub
        if (parsed && typeof parsed.accountUuid === 'string' && parsed.accountUuid.trim()) {
          return parsed.accountUuid.trim()
        }
      } catch (_e) {
        // ignore malformed subscriptionInfo
      }
    }
    return ''
  }

  // 🎲 由种子确定性派生一个格式合法的 UUID v4（同一种子恒定 → 会话稳定）。
  _deriveStableUuid(seed) {
    const h = crypto.createHash('sha256').update(String(seed)).digest('hex')
    const c = h.slice(0, 32).split('')
    c[12] = '4' // version 4
    c[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16) // variant 10xx
    const s = c.join('')
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
  }

  // 🔢 复刻真实 Claude Code CLI 的 cc_version 指纹后缀（每请求随首条 user 文本变化）。
  //
  // 算法源自 Parrot / sub2api 逆向：取 messages 中第一条 role=user 首段 text 的
  // 第 4/7/20 字符（不足以 '0' 补齐），SHA256(salt + chars + version) 取 hex 前 3 位。
  // 注：抓包的 fp 无法用该 salt 精确复现（真实算法未解出，见调研文档 §6），本实现的
  // 核心价值是「fp 随内容变化」——消除固定指纹这一 bot 特征，而非字节级复刻不可验证的值。
  // 返回的 cch 仅保留给回归测试使用；按用户要求 cch 不写入请求（见 _injectDynamicBillingHeader）。
  _computeCcFingerprint(body, version) {
    const salt = '59cf53e54c78'
    const firstText = this._extractFirstUserText(body)
    const indices = [4, 7, 20]
    const chars = indices.map((i) => (i < firstText.length ? firstText[i] : '0')).join('')
    const digest = crypto
      .createHash('sha256')
      .update(salt + chars + version)
      .digest('hex')
    return { fp: digest.slice(0, 3), cch: digest.slice(3, 8) }
  }

  // 🆔 emulation 会话标识。
  // 真实 CLI 中 X-Claude-Code-Session-Id、X-Mcp-Client-Session-Id、metadata.user_id.session_id
  // 三者为同一个 UUID。这里以 sessionHelper 的会话哈希（与 sticky 会话同源）为主种子，
  // 保证同一会话稳定；header 与 body 均取自该值，不再各自随机。
  // 注意：必须以「未被改写的原始请求体」调用，否则 _moveSystemToMessages 会改变哈希。
  _getEmulationSessionId(body, account = null) {
    const accountKey = (account && (account.id || account.name)) || 'relay'
    let sessionHash = null
    try {
      sessionHash = sessionHelper.generateSessionHash(body)
    } catch (_e) {
      sessionHash = null
    }
    const seed = sessionHash || this._extractFirstUserText(body) || 'default'
    return this._deriveStableUuid(`cc-session:${accountKey}:${seed}`)
  }

  // 🔗 同会话上一轮的链式引用状态（request-id / message id）
  _getTurnStateKey(sessionId) {
    return `cc_emulation_turn:${sessionId}`
  }

  async _getPreviousTurnState(sessionId) {
    if (!sessionId) {
      return null
    }
    try {
      const raw = await redis.client.get(this._getTurnStateKey(sessionId))
      return raw ? JSON.parse(raw) : null
    } catch (error) {
      logger.debug(
        `🎫 Failed to read previous turn state for session ${sessionId}: ${error.message}`
      )
      return null
    }
  }

  async _saveTurnState(sessionId, state) {
    if (!sessionId || !state) {
      return
    }
    try {
      await redis.client.setex(
        this._getTurnStateKey(sessionId),
        86400,
        JSON.stringify({ ...state, updatedAt: new Date().toISOString() })
      )
    } catch (error) {
      logger.debug(`🎫 Failed to save turn state for session ${sessionId}: ${error.message}`)
    }
  }

  // 🔗 从上游非流式响应中提取本轮 request-id / message id 并落库
  // （供同会话下一轮的 cc_prev_req / diagnostics.previous_message_id 使用）
  async _captureTurnStateFromResponse(body, upstreamHeaders, responseBody) {
    try {
      const sessionId = metadataUserIdHelper.extractSessionId(body?.metadata?.user_id)
      if (!sessionId) {
        return
      }
      const requestId = (upstreamHeaders && upstreamHeaders['request-id']) || null
      let messageId = null
      if (typeof responseBody === 'string' && responseBody.trim()) {
        try {
          const parsed = JSON.parse(responseBody)
          messageId = (parsed && parsed.id) || null
        } catch (_e) {
          messageId = null
        }
      }
      if (requestId || messageId) {
        await this._saveTurnState(sessionId, { requestId, messageId })
      }
    } catch (error) {
      logger.debug(`🎫 Failed to capture turn state: ${error.message}`)
    }
  }

  // 💳 为 emulation 请求注入动态 billing header 作为 system[0]（对齐真实 CLI v2.1.280 形态）：
  //   x-anthropic-billing-header: cc_version=<ver>.<fp>; cc_entrypoint=<ep>; cc_prompt_id=<uuid>; cc_turn_origin=<origin>;
  // 第 2 轮起由 _applyTurnChaining 在 cc_entrypoint 之后插入 cc_prev_req（与抓包字段顺序一致）。
  // 必须在 _removeBillingHeaderFromSystem 之后调用，避免被误剥离。
  // cch 按用户要求不传递（档案 billing.includeCch = false）。
  _injectDynamicBillingHeader(body, context = {}) {
    if (!body) {
      return
    }
    const profile = this._getProfile()
    const { version } = profile
    const { fp } = this._computeCcFingerprint(body, version)
    const entrypoint = context.entrypoint || claudeCodeProfile.DEFAULT_ENTRYPOINT

    const fields = [`cc_version=${version}.${fp}`, `cc_entrypoint=${entrypoint}`]
    if (profile.billing.includePromptId) {
      const promptSeed = context.sessionId || this._getEmulationSessionId(body, context.account)
      fields.push(`cc_prompt_id=${this._deriveStableUuid(`cc-prompt:${promptSeed}`)}`)
    }
    if (profile.billing.includeTurnOrigin) {
      fields.push(`cc_turn_origin=${claudeCodeProfile.turnOriginFor(entrypoint)}`)
    }

    const billingEntry = {
      type: 'text',
      text: `x-anthropic-billing-header: ${fields.join('; ')};`
    }
    if (Array.isArray(body.system)) {
      body.system.unshift(billingEntry)
    } else if (typeof body.system === 'string' && body.system.trim()) {
      body.system = [billingEntry, { type: 'text', text: body.system }]
    } else {
      body.system = [billingEntry]
    }
  }

  // 🔗 依据同会话上一轮状态注入链式字段：
  //   - system[0] 的 cc_prev_req（上一轮响应头 request-id，插在 cc_entrypoint 之后）
  //   - body.diagnostics.previous_message_id（上一轮 message_start.message.id）
  // 无历史状态时保持首轮形态：不写 cc_prev_req，previous_message_id 为 null。
  async _applyTurnChaining(body) {
    if (!body) {
      return
    }
    const profile = this._getProfile()
    const sessionId = metadataUserIdHelper.extractSessionId(body?.metadata?.user_id)
    const prev = await this._getPreviousTurnState(sessionId)

    if (profile.body.diagnostics) {
      if (!body.diagnostics || typeof body.diagnostics !== 'object') {
        body.diagnostics = {}
      }
      body.diagnostics.previous_message_id = (prev && prev.messageId) || null
    }

    if (profile.billing.includePrevReq && prev && prev.requestId) {
      const billingEntry = Array.isArray(body.system) ? body.system[0] : null
      if (
        billingEntry &&
        typeof billingEntry.text === 'string' &&
        billingEntry.text.startsWith('x-anthropic-billing-header')
      ) {
        if (billingEntry.text.includes('cc_prev_req=')) {
          billingEntry.text = billingEntry.text.replace(
            /cc_prev_req=[^;]*;\s*/,
            `cc_prev_req=${prev.requestId}; `
          )
        } else {
          billingEntry.text = billingEntry.text.replace(
            /(cc_entrypoint=[^;]*;\s*)/,
            `$1cc_prev_req=${prev.requestId}; `
          )
        }
      }
    }
  }

  _applyNonRealClaudeCodeDefaults(body) {
    const profile = this._getProfile()

    // max_tokens：真实 CLI 默认 128000
    if (body.max_tokens === undefined || body.max_tokens === null) {
      body.max_tokens = profile.body.defaultMaxTokens
    }

    // temperature：2.1.280 顶层不发送 temperature。
    // 此前实现按旧版本（sub2api v2.1.220）强制注入 temperature:1，属版本错位，已移除。
    if (profile.body.stripClientTemperature) {
      delete body.temperature
    }

    // thinking：adaptive + display:omitted（2.1.280 抓包形态）
    if (!body.thinking) {
      body.thinking = { ...profile.body.thinking }
    } else if (
      body.thinking &&
      typeof body.thinking === 'object' &&
      !Array.isArray(body.thinking) &&
      !body.thinking.display
    ) {
      body.thinking.display = profile.body.thinking.display
    }

    // Ensure stream is set
    if (body.stream === undefined) {
      body.stream = true
    }

    // output_config：2.1.280 抓包带 effort（由 effort-2025-11-24 beta 授权，已在档案 beta 列表中）
    if (body.output_config === undefined || body.output_config === null) {
      body.output_config = { ...profile.body.outputConfig }
    }

    // context_management：thinking 为 enabled/adaptive 时，真实 CLI 附带 clear_thinking 策略。
    // 需要 context-management-2025-06-27 beta（已在档案 beta 列表中）。
    const thinkingType = body.thinking && body.thinking.type
    if (
      (thinkingType === 'enabled' || thinkingType === 'adaptive') &&
      body.context_management === undefined
    ) {
      body.context_management = safeClone(profile.body.contextManagement)
    }

    // 注意：diagnostics 由 _applyTurnChaining 注入（需要同会话上一轮 message id），
    // 不在此处写死；fallbacks 依旧不注入（sonnet 不支持，注入会 400）。
  }

  // 🔄 处理请求体
  // 📅 Rewrite "Today's date is YYYY-MM-DD." (or YYYY/MM/DD) inside system + user messages
  // to reflect the CURRENT SERVER LOCAL DATE. Strictly emits YYYY-MM-DD.
  _rewriteTodayDate(body) {
    if (!body || typeof body !== 'object') {
      return
    }
    const serverDate = new Date().toLocaleDateString('en-CA') // en-CA gives YYYY-MM-DD, uses system TZ
    const replacement = "Today's date is " + serverDate + '.'
    // Accept both YYYY-MM-DD and YYYY/MM/DD, with any whitespace between tokens
    const dateRegex = /Today's date is \d{4}[-/]\d{2}[-/]\d{2}\./g
    const rewriteText = (t) => (typeof t === 'string' ? t.replace(dateRegex, replacement) : t)
    // system entries
    if (Array.isArray(body.system)) {
      for (const entry of body.system) {
        if (entry && typeof entry.text === 'string') {
          entry.text = rewriteText(entry.text)
        }
      }
    } else if (typeof body.system === 'string') {
      body.system = rewriteText(body.system)
    }
    // messages content blocks
    if (Array.isArray(body.messages)) {
      for (const msg of body.messages) {
        if (!msg) continue
        const content = msg.content
        if (typeof content === 'string') {
          msg.content = rewriteText(content)
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block.text === 'string') {
              block.text = rewriteText(block.text)
            }
          }
        }
      }
    }
  }

  // 注：第 3 个参数保留仅为签名兼容（历史调用方/测试会传），统一化后不再影响任何行为。
  _processRequestBody(body, account = null, _isRealClaudeCodeOverride = undefined, context = {}) {
    if (!body) {
      return body
    }

    // 🆔 emulation 会话标识：必须从「未被改写的原始请求体」派生，
    // 并与请求头 X-Claude-Code-Session-Id 保持同值（真实 CLI 二者一致）。
    const emulationSessionId = this._getEmulationSessionId(body, account)

    // 使用 safeClone 替代 JSON.parse(JSON.stringify()) 提升性能
    const processedBody = safeClone(body)
    // 🕰️ Overwrite any "Today's date is …" strings with server local date (strict YYYY-MM-DD.)
    this._rewriteTodayDate(processedBody)

    processedBody.messages = this._patchOrphanedToolUse(processedBody.messages)

    // 验证并限制max_tokens参数
    this._validateAndLimitMaxTokens(processedBody)

    // 移除cache_control中的ttl字段
    this._stripTtlFromCacheControl(processedBody)

    // 🔒 统一化：不再区分「真 Claude Code 客户端 / 第三方客户端」。
    // 所有请求一律走同一套归一化 + 转发逻辑，禁止透传——真 CC 客户端自带的 system
    // 同样会被迁入 messages，并被中转合成的身份块替换。
    // 注：识别真 CC 客户端的能力仍然保留，但只用于从真客户端学习 header 缓存
    // （见 storeAccountHeaders），不再影响任何转发行为。

    // P0: Move client system to messages FIRST, then build clean CC system
    this._moveSystemToMessages(processedBody)
    processedBody.system = this._buildClaudeCodeSystem(processedBody.system)
    this._applyNonRealClaudeCodeDefaults(processedBody)
    this._sanitizeNonRealClaudeCodeToolDescriptions(processedBody)

    // metadata.user_id：这是 Anthropic 判定「第一方 Claude Code vs 第三方 app」的关键信号。
    // 真实 CLI 发送 {"device_id":<64hex 机器指纹>,"account_uuid":<账号真实 UUID>,"session_id":<会话稳定 UUID>}，
    // 其中 account_uuid 必须与 OAuth token 所属账号一致（来自 /api/oauth/profile，存于 account.subscriptionInfo）。
    // 之前 emulation 注入 account_uuid:''（空）+ 每请求随机 session_id → 被判第三方 → 计费走 extra usage 池。
    // 修复（对齐 sub2api buildOAuthMetadataUserID）：
    //   - account_uuid = 账号真实 UUID（从 subscriptionInfo 解析）
    //   - device_id = 按 account.id 派生的稳定 64hex（模拟单账号单机，避免全量流量共用一个 device）
    //   - session_id = emulationSessionId（由原始请求体派生的稳定 UUID；与请求头同值）
    //   - 统一化后始终覆盖客户端自带的 metadata：第三方客户端的 account_uuid 必然不正确，
    //     真 CLI 客户端自带的 device_id / session_id 也不应上行（统一为按账号派生的稳定值）
    if (!processedBody.metadata || typeof processedBody.metadata !== 'object') {
      processedBody.metadata = {}
    }
    const accountUuid = this._getAccountUuid(account)
    const accountKey = (account && (account.id || account.name)) || 'relay'
    const deviceId = crypto.createHash('sha256').update(`cc-device:${accountKey}`).digest('hex')
    processedBody.metadata.user_id = JSON.stringify({
      device_id: deviceId,
      account_uuid: accountUuid,
      session_id: emulationSessionId
    })
    if (!accountUuid) {
      logger.warn(
        `⚠️ Emulation metadata missing account_uuid for account ${accountKey}; request may be billed as third-party. Run fetchAndUpdateAccountProfile.`
      )
    }

    // 移除 x-anthropic-billing-header 系统元素，避免将客户端 billing 标识传递给上游 API
    this._removeBillingHeaderFromSystem(processedBody)

    // 💳 在剥离客户端 billing 之后，注入本服务动态派生的 billing header 作为 system[0]，
    // 对齐真实 CLI v2.1.280（cc_version 后缀随首条 user 文本每请求变化，消除固定指纹特征；
    // cc_entrypoint / cc_turn_origin 跟随本次请求声明的入口，cch 不传递）。
    this._injectDynamicBillingHeader(processedBody, {
      entrypoint: context.entrypoint,
      sessionId: emulationSessionId,
      account
    })

    this._enforceCacheControlLimit(processedBody)

    // 统一化：system 固定为 [billing, identity, generic] 形态，不再把 relay 的
    // config.claude.systemPrompt 追加成额外 system 块（如需自定义，见 _getGenericInstructions）。
    // 仅保留兜底清理：system 若无有效内容则删除。
    if (processedBody.system && Array.isArray(processedBody.system)) {
      const hasValidContent = processedBody.system.some(
        (item) => item && item.text && item.text.trim()
      )
      if (!hasValidContent) {
        delete processedBody.system
      }
    }

    this._injectClaudeCodeStyleCacheControl(processedBody)
    this._enforceCacheControlLimit(processedBody)

    // Claude API只允许temperature或top_p其中之一，优先使用temperature
    if (processedBody.top_p !== undefined && processedBody.top_p !== null) {
      delete processedBody.top_p
    }

    // 处理统一的客户端标识
    if (account && account.useUnifiedClientId === 'true' && account.unifiedClientId) {
      this._replaceClientId(processedBody, account.unifiedClientId)
    }

    // 🧠 P1：发送前预过滤无效签名的 thinking 块（保留有效签名，只删无效/缺失）。
    // 放在最后，确保 body.thinking 已反映最终状态（emulation 注入 adaptive 之后）。
    this._filterInvalidThinkingBlocks(processedBody)

    return processedBody
  }

  // 🔄 替换请求中的客户端标识
  _replaceClientId(body, unifiedClientId) {
    if (!body?.metadata?.user_id || !unifiedClientId) {
      return
    }

    const parsed = metadataUserIdHelper.parse(body.metadata.user_id)
    if (!parsed) {
      return
    }

    body.metadata.user_id = metadataUserIdHelper.build({
      ...parsed,
      deviceId: unifiedClientId
    })
    logger.info(`🔄 Replaced client ID with unified ID: ${body.metadata.user_id}`)
  }

  // 🧹 移除 billing header 系统提示元素
  _removeBillingHeaderFromSystem(processedBody) {
    if (!processedBody || !processedBody.system) {
      return
    }

    if (typeof processedBody.system === 'string') {
      if (processedBody.system.trim().startsWith('x-anthropic-billing-header')) {
        logger.debug('🧹 Removed billing header from string system prompt')
        delete processedBody.system
      }
      return
    }

    if (Array.isArray(processedBody.system)) {
      const originalLength = processedBody.system.length
      processedBody.system = processedBody.system.filter(
        (item) =>
          !(
            item &&
            item.type === 'text' &&
            typeof item.text === 'string' &&
            item.text.trim().startsWith('x-anthropic-billing-header')
          )
      )
      if (processedBody.system.length < originalLength) {
        logger.debug(
          `🧹 Removed ${originalLength - processedBody.system.length} billing header element(s) from system array`
        )
      }
    }
  }

  // 🔢 验证并限制max_tokens参数
  _validateAndLimitMaxTokens(body) {
    if (!body || !body.max_tokens) {
      return
    }

    try {
      // 使用缓存的定价数据
      const pricingFilePath = path.join(__dirname, '../../data/model_pricing.json')
      const pricingData = getPricingData(pricingFilePath)

      if (!pricingData) {
        logger.warn('⚠️ Model pricing file not found, skipping max_tokens validation')
        return
      }

      const model = body.model || 'claude-sonnet-4-20250514'

      // 查找对应模型的配置
      const modelConfig = pricingData[model]

      if (!modelConfig) {
        // 如果找不到模型配置，直接透传客户端参数，不进行任何干预
        logger.info(
          `📝 Model ${model} not found in pricing file, passing through client parameters without modification`
        )
        return
      }

      // 获取模型的最大token限制
      const maxLimit = modelConfig.max_tokens || modelConfig.max_output_tokens

      if (!maxLimit) {
        logger.debug(`🔍 No max_tokens limit found for model ${model}, skipping validation`)
        return
      }

      // 检查并调整max_tokens
      if (body.max_tokens > maxLimit) {
        logger.warn(
          `⚠️ max_tokens ${body.max_tokens} exceeds limit ${maxLimit} for model ${model}, adjusting to ${maxLimit}`
        )
        body.max_tokens = maxLimit
      }
    } catch (error) {
      logger.error('❌ Failed to validate max_tokens from pricing file:', error)
      // 如果文件读取失败，不进行校验，让请求继续处理
    }
  }

  // 🧹 移除TTL字段
  _stripTtlFromCacheControl(body) {
    if (!body || typeof body !== 'object') {
      return
    }

    const processContentArray = (contentArray) => {
      if (!Array.isArray(contentArray)) {
        return
      }

      contentArray.forEach((item) => {
        if (item && typeof item === 'object' && item.cache_control) {
          if (item.cache_control.ttl) {
            delete item.cache_control.ttl
            logger.debug('🧹 Removed ttl from cache_control')
          }
        }
      })
    }

    if (Array.isArray(body.system)) {
      processContentArray(body.system)
    }

    if (Array.isArray(body.messages)) {
      body.messages.forEach((message) => {
        if (message && Array.isArray(message.content)) {
          processContentArray(message.content)
        }
      })
    }
  }

  _hasExistingCacheControl(body) {
    if (!body || typeof body !== 'object') {
      return false
    }

    const stack = []
    if (body.system) {
      stack.push(body.system)
    }
    if (body.messages) {
      stack.push(body.messages)
    }
    if (body.tools) {
      stack.push(body.tools)
    }

    while (stack.length > 0) {
      const current = stack.pop()
      if (!current || typeof current !== 'object') {
        continue
      }
      if (current.cache_control) {
        return true
      }
      if (Array.isArray(current)) {
        current.forEach((item) => stack.push(item))
      } else {
        Object.values(current).forEach((value) => stack.push(value))
      }
    }

    return false
  }

  _tryAddCacheControlToLastTextContent(message) {
    if (!message || typeof message !== 'object') {
      return null
    }

    // P0/P1 fix: never inject cache_control into an assistant turn that carries a
    // thinking or redacted_thinking block. Extended thinking requires each historical
    // assistant turn to stay byte-identical to what the model emitted; adding a field
    // to a sibling block invalidates the thinking signature, and the upstream then
    // rejects the request with HTTP 400 Invalid signature in thinking block.
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const hasThinking = message.content.some(
        (b) =>
          b && typeof b === 'object' && (b.type === 'thinking' || b.type === 'redacted_thinking')
      )
      if (hasThinking) {
        return null
      }
    }

    if (typeof message.content === 'string') {
      message.content = [
        {
          type: 'text',
          text: message.content,
          cache_control: { type: 'ephemeral' }
        }
      ]
      return 'content[0]'
    }

    if (!Array.isArray(message.content)) {
      return null
    }

    for (let index = message.content.length - 1; index >= 0; index -= 1) {
      const item = message.content[index]
      if (item && typeof item === 'object' && item.type === 'text' && !item.cache_control) {
        item.cache_control = { type: 'ephemeral' }
        return `content[${index}]`
      }
    }

    return null
  }

  // 🧰 给 tools 数组的最后一项打 cache_control，让 system + tools 整段进入缓存前缀
  // 仅当 tools 数组内不存在任何 cache_control 时才注入（与上游已自带的设置共存）
  // 返回被注入的路径（如 'tools[23]'）或 null
  _injectToolsCacheControl(body) {
    if (!body || typeof body !== 'object') {
      return null
    }
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      return null
    }
    // 检测 tools 数组内是否已有任何 cache_control（包括嵌套 input_schema / custom 等）
    const stack = [...body.tools]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current || typeof current !== 'object') {
        continue
      }
      if (current.cache_control) {
        return null
      }
      if (Array.isArray(current)) {
        current.forEach((item) => stack.push(item))
      } else {
        Object.values(current).forEach((value) => stack.push(value))
      }
    }
    const lastIndex = body.tools.length - 1
    const lastTool = body.tools[lastIndex]
    if (!lastTool || typeof lastTool !== 'object') {
      return null
    }
    lastTool.cache_control = { type: 'ephemeral' }
    return `tools[${lastIndex}]`
  }

  _injectClaudeCodeStyleCacheControl(body) {
    if (!body || typeof body !== 'object') {
      return
    }

    const injected = []

    // 在判断 system/messages 是否已自带 cache_control 之前，先快照检测，
    // 避免把"我们即将注入到 tools 上的 cache_control"误当成"上游已设"。
    const skipSystemAndMessages = this._hasExistingCacheControl(body)

    // 1. 先注入 tools 缓存断点（独立路径，与 system/messages 解耦）
    //    tools 一般是长期不变的大块（OpenClaw 等 runtime 常带 30~60KB schema），
    //    单独打一个断点即可让 system+tools 整段进入缓存前缀。
    const toolsPath = this._injectToolsCacheControl(body)
    if (toolsPath) {
      injected.push(toolsPath)
    }

    // 2. 细化检测：system / messages / tools 各自是否有 cache_control
    const hasSystemAnchor = this._hasSystemCacheControl(body)
    const hasMessagesAnchor = this._hasMessagesCacheControl(body)

    // 3. cache_control 仅在 tools 上（如 Claude Code 原生请求）→ 保持旧契约
    //    不注入 system/messages，由客户端自行管理
    if (skipSystemAndMessages && !hasSystemAnchor && !hasMessagesAnchor) {
      if (injected.length > 0) {
        logger.info(`🎯 Auto-injected cache_control at: ${injected.join(', ')}`)
      }
      return
    }

    // 4. system 和 messages 都已有 cache_control → 保持旧契约，不再覆盖
    if (hasSystemAnchor && hasMessagesAnchor) {
      if (injected.length > 0) {
        logger.info(`🎯 Auto-injected cache_control at: ${injected.join(', ')}`)
      } else {
        logger.debug('🎯 Skipping auto cache_control injection: request already has cache_control')
      }
      return
    }

    // 5. system 有 cache_control 但 messages 缺锚点（典型 qwenpaw 场景）→ 补 messages
    //    或完全没有 cache_control → 正常注入 system + messages
    if (Array.isArray(body.system) && body.system.length > 0 && !hasSystemAnchor) {
      for (let index = body.system.length - 1; index >= 0; index -= 1) {
        const item = body.system[index]
        if (item && typeof item === 'object' && item.type === 'text' && !item.cache_control) {
          item.cache_control = { type: 'ephemeral' }
          injected.push(`system[${index}]`)
          break
        }
      }
    }

    if (Array.isArray(body.messages) && body.messages.length >= 2) {
      const index = body.messages.length - 2
      const contentPath = this._tryAddCacheControlToLastTextContent(body.messages[index])
      if (contentPath) {
        injected.push(`messages[${index}].${contentPath}`)
      }
    }

    if (Array.isArray(body.messages) && body.messages.length >= 1) {
      const index = body.messages.length - 1
      const contentPath = this._tryAddCacheControlToLastTextContent(body.messages[index])
      if (contentPath) {
        injected.push(`messages[${index}].${contentPath}`)
      }
    }

    if (injected.length > 0) {
      logger.info(`🎯 Auto-injected cache_control at: ${injected.join(', ')}`)
    } else {
      logger.debug('🎯 Auto cache_control injection skipped: no cacheable text blocks found')
    }
  }

  // 检查 messages 数组中是否已有 cache_control 锚点
  _hasMessagesCacheControl(body) {
    if (!body || !Array.isArray(body.messages)) {
      return false
    }
    const stack = [...body.messages]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current || typeof current !== 'object') {
        continue
      }
      if (current.cache_control) {
        return true
      }
      if (Array.isArray(current)) {
        current.forEach((item) => stack.push(item))
      } else {
        Object.values(current).forEach((value) => stack.push(value))
      }
    }
    return false
  }

  // 检查 system 数组中是否已有 cache_control 锚点
  _hasSystemCacheControl(body) {
    if (!body || !Array.isArray(body.system)) {
      return false
    }
    const stack = [...body.system]
    while (stack.length > 0) {
      const current = stack.pop()
      if (!current || typeof current !== 'object') {
        continue
      }
      if (current.cache_control) {
        return true
      }
      if (Array.isArray(current)) {
        current.forEach((item) => stack.push(item))
      } else {
        Object.values(current).forEach((value) => stack.push(value))
      }
    }
    return false
  }

  // ⚖️ 限制带缓存控制的内容数量
  _enforceCacheControlLimit(body) {
    const MAX_CACHE_CONTROL_BLOCKS = 4

    if (!body || typeof body !== 'object') {
      return
    }

    const countCacheControlBlocks = () => {
      let total = 0

      if (Array.isArray(body.messages)) {
        body.messages.forEach((message) => {
          if (!message || !Array.isArray(message.content)) {
            return
          }
          message.content.forEach((item) => {
            if (item && item.cache_control) {
              total += 1
            }
          })
        })
      }

      if (Array.isArray(body.system)) {
        body.system.forEach((item) => {
          if (item && item.cache_control) {
            total += 1
          }
        })
      }

      if (Array.isArray(body.tools)) {
        body.tools.forEach((item) => {
          if (item && item.cache_control) {
            total += 1
          }
        })
      }

      return total
    }

    // 只移除 cache_control 属性，保留内容本身，避免丢失用户消息
    const removeCacheControlFromMessages = () => {
      if (!Array.isArray(body.messages)) {
        return false
      }

      for (let messageIndex = 0; messageIndex < body.messages.length; messageIndex += 1) {
        const message = body.messages[messageIndex]
        if (!message || !Array.isArray(message.content)) {
          continue
        }

        for (let contentIndex = 0; contentIndex < message.content.length; contentIndex += 1) {
          const contentItem = message.content[contentIndex]
          if (contentItem && contentItem.cache_control) {
            // 只删除 cache_control 属性，保留内容
            delete contentItem.cache_control
            return true
          }
        }
      }

      return false
    }

    // 只移除 cache_control 属性，保留 system 内容
    const removeCacheControlFromSystem = () => {
      if (!Array.isArray(body.system)) {
        return false
      }

      for (let index = 0; index < body.system.length; index += 1) {
        const systemItem = body.system[index]
        if (systemItem && systemItem.cache_control) {
          // 只删除 cache_control 属性，保留内容
          delete systemItem.cache_control
          return true
        }
      }

      return false
    }

    // 兜底：从 tools 中移除 cache_control（仅当 messages/system 都已无可删时才动）
    // 优先删除非末尾的 tool（保留 `_injectToolsCacheControl` 注入的最后一项）
    const removeCacheControlFromTools = () => {
      if (!Array.isArray(body.tools)) {
        return false
      }
      for (let index = 0; index < body.tools.length - 1; index += 1) {
        const tool = body.tools[index]
        if (tool && tool.cache_control) {
          delete tool.cache_control
          return true
        }
      }
      const last = body.tools[body.tools.length - 1]
      if (last && last.cache_control) {
        delete last.cache_control
        return true
      }
      return false
    }

    let total = countCacheControlBlocks()

    while (total > MAX_CACHE_CONTROL_BLOCKS) {
      // 优先从 messages 中移除 cache_control，再从 system 中移除，
      // 最后才动 tools（tools 上的断点稳定且收益最大）
      if (removeCacheControlFromMessages()) {
        total -= 1
        continue
      }

      if (removeCacheControlFromSystem()) {
        total -= 1
        continue
      }

      if (removeCacheControlFromTools()) {
        total -= 1
        continue
      }

      break
    }
  }

  // 🌐 获取代理Agent（使用统一的代理工具）
  async _getProxyAgent(accountId, account = null) {
    try {
      // 优先使用传入的 account 对象，避免重复查询
      const accountData = account || (await claudeAccountService.getAccount(accountId))

      if (!accountData || !accountData.proxy) {
        logger.debug('🌐 No proxy configured for Claude account')
        return null
      }

      const proxyAgent = ProxyHelper.createProxyAgent(accountData.proxy)
      if (proxyAgent) {
        logger.info(
          `🌐 Using proxy for Claude request: ${ProxyHelper.getProxyDescription(accountData.proxy)}`
        )
      }
      return proxyAgent
    } catch (error) {
      logger.warn('⚠️ Failed to create proxy agent:', error)
      return null
    }
  }

  // 🔧 过滤客户端请求头
  _filterClientHeaders(clientHeaders) {
    // 使用统一的 headerFilter 工具类
    // 同时伪装成正常的直接客户端请求，避免触发上游 API 的安全检查
    return filterForClaude(clientHeaders)
  }

  // 🗜️ 根据 content-encoding 创建解压流（支持 gzip/deflate/br/zstd；Node 22.15+/24 内置 zstd）
  _createDecompressStream(encoding) {
    switch ((encoding || '').toLowerCase()) {
      case 'gzip':
      case 'x-gzip':
        return zlib.createGunzip()
      case 'deflate':
        return zlib.createInflate()
      case 'br':
        return zlib.createBrotliDecompress()
      case 'zstd':
        return typeof zlib.createZstdDecompress === 'function' ? zlib.createZstdDecompress() : null
      default:
        return null
    }
  }

  // 🗜️ 同步解压响应体；content-encoding 缺失时按魔数嗅探
  // （兜底 issue #1030：上游经 Cloudflare 可能压缩但未带 Content-Encoding 头）
  _decompressBufferSync(buffer, encoding) {
    const enc = (encoding || '').toLowerCase()
    try {
      switch (enc) {
        case 'gzip':
        case 'x-gzip':
          return zlib.gunzipSync(buffer)
        case 'deflate':
          return zlib.inflateSync(buffer)
        case 'br':
          return zlib.brotliDecompressSync(buffer)
        case 'zstd':
          return zlib.zstdDecompressSync(buffer)
        default:
          break
      }
      // 魔数嗅探兜底（gzip: 1f 8b；zstd: 28 b5 2f fd）
      if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
        return zlib.gunzipSync(buffer)
      }
      if (
        buffer.length >= 4 &&
        buffer[0] === 0x28 &&
        buffer[1] === 0xb5 &&
        buffer[2] === 0x2f &&
        buffer[3] === 0xfd
      ) {
        return zlib.zstdDecompressSync(buffer)
      }
    } catch (err) {
      logger.error(`❌ Failed to decompress ${enc || 'sniffed'} response:`, err)
    }
    return buffer
  }

  // 🗜️ 返回自适应解压流：有可解压的 content-encoding 头则直接按头解压；
  // 头缺失时按首个数据块魔数嗅探（兜底 issue #1030 在流式场景下的二进制损坏）
  _createAdaptiveDecompressStream(contentEncoding) {
    const enc = (contentEncoding || '').toLowerCase()
    if (enc) {
      // 头存在：可解压类型返回对应流，其它（identity 等）返回 null 透传
      return this._createDecompressStream(enc)
    }
    // 无 content-encoding 头：首块魔数嗅探，必要时插入解压器
    const self = this
    let inner = null
    let decided = false
    const transform = new Transform({
      transform(chunk, _e, cb) {
        if (!decided) {
          decided = true
          let sniffEnc = null
          if (chunk.length >= 2 && chunk[0] === 0x1f && chunk[1] === 0x8b) {
            sniffEnc = 'gzip'
          } else if (
            chunk.length >= 4 &&
            chunk[0] === 0x28 &&
            chunk[1] === 0xb5 &&
            chunk[2] === 0x2f &&
            chunk[3] === 0xfd
          ) {
            sniffEnc = 'zstd'
          }
          if (sniffEnc) {
            inner = self._createDecompressStream(sniffEnc)
            logger.warn(
              `🗜️ Stream missing Content-Encoding header, sniffed ${sniffEnc} (issue #1030 fallback)`
            )
            inner.on('data', (d) => transform.push(d))
            inner.on('error', (e) => transform.destroy(e))
          }
        }
        if (inner) {
          inner.write(chunk)
          cb()
        } else {
          cb(null, chunk)
        }
      },
      flush(cb) {
        if (inner) {
          inner.end()
          inner.on('end', () => cb())
        } else {
          cb()
        }
      }
    })
    return transform
  }

  // 🔧 准备请求头和 payload（抽离公共逻辑）
  async _prepareRequestHeadersAndPayload(
    body,
    clientHeaders,
    accountId,
    accessToken,
    options = {}
  ) {
    const { account, accountType, sessionHash, requestOptions = {}, isStream = false } = options

    // 获取统一的 User-Agent
    const unifiedUA = await this.captureAndGetUnifiedUserAgent(clientHeaders, account)

    // 获取过滤后的客户端 headers
    const filteredHeaders = this._filterClientHeaders(clientHeaders)

    // 🔒 统一化：所有请求（包括真 Claude Code 客户端）一律使用精确、版本自洽的 CLI header 集合，
    // 不再做客户端 header 透传。识别真 CC 客户端仅用于 header 缓存学习（storeAccountHeaders）。
    let finalHeaders = { ...filteredHeaders }
    let requestPayload = body

    // P2：只发送精确、版本自洽的 CLI header 集合。
    // 优先使用账号 Redis 缓存中「与当前声明 UA 同版本」的真实抓取 headers；
    // 否则回退到 canonical defaultHeaders（已与原生 CLI v2.1.280 抓包字节对齐）。
    // 关键：不沿用旧版本缓存（避免 x-stainless 与 UA 版本错位），也不保留客户端多余头。
    const declaredVersion = claudeCodeHeadersService.extractVersionFromUserAgent(
      claudeCodeHeadersService.defaultHeaders['user-agent']
    )
    const cachedHeaders = await claudeCodeHeadersService.getAccountHeaders(accountId)
    const cachedVersion = claudeCodeHeadersService.extractVersionFromUserAgent(
      cachedHeaders && cachedHeaders['user-agent']
    )
    // 仅当缓存版本恰好等于当前声明版本时才采用缓存（真实同版本抓取），否则用 default。
    const emulationHeaders =
      cachedVersion && declaredVersion && cachedVersion === declaredVersion
        ? cachedHeaders
        : claudeCodeHeadersService.defaultHeaders

    // 用精确集合覆盖客户端遗留头：先删除已知的非 CLI 泄漏头，再仅注入 CLI header keys。
    const CLI_HEADER_KEYS = claudeCodeHeadersService.claudeCodeHeaderKeys
    const LEAK_HEADERS = [
      'accept-language',
      'sec-fetch-mode',
      'sec-fetch-site',
      'sec-fetch-dest',
      'sec-ch-ua',
      'sec-ch-ua-mobile',
      'sec-ch-ua-platform',
      'x-stainless-helper-method'
    ]
    LEAK_HEADERS.forEach((k) => {
      delete finalHeaders[k]
      delete finalHeaders[k.toLowerCase()]
    })
    CLI_HEADER_KEYS.forEach((key) => {
      if (emulationHeaders[key] !== undefined) {
        finalHeaders[key] = emulationHeaders[key]
      }
    })

    // 🧭 UA 入口类型跟随客户端（sdk-cli / cli），避免 UA 与 billing header 的
    // cc_entrypoint / cc_turn_origin 相互错位。
    const emulationEntrypoint = this._resolveEntrypoint(clientHeaders, account)
    finalHeaders['user-agent'] = claudeCodeProfile.buildUserAgent(emulationEntrypoint)

    // 🏷️ 2.1.280 抓包中存在、此前完全缺失的固定头 + 每请求 id
    const profile = this._getProfile()
    Object.entries(profile.staticHeaders || {}).forEach(([key, value]) => {
      finalHeaders[key] = value
    })
    finalHeaders['x-client-request-id'] = crypto.randomUUID()

    // 🆔 会话 id 与 body.metadata.user_id.session_id 保持同值
    // （真实 CLI：X-Claude-Code-Session-Id === X-Mcp-Client-Session-Id === metadata.user_id.session_id）。
    // 以 body 中已写入的值为准，确保「发出去的 body 与 header」自洽。
    const emulationSessionId =
      metadataUserIdHelper.extractSessionId(requestPayload?.metadata?.user_id) ||
      this._getEmulationSessionId(requestPayload, account)
    finalHeaders['x-claude-code-session-id'] = emulationSessionId

    // 应用请求身份转换
    const extensionResult = this._applyRequestIdentityTransform(requestPayload, finalHeaders, {
      account,
      accountId,
      accountType,
      sessionHash,
      clientHeaders,
      requestOptions,
      isStream
    })

    if (extensionResult.abortResponse) {
      return { abortResponse: extensionResult.abortResponse }
    }

    requestPayload = extensionResult.body
    finalHeaders = extensionResult.headers

    // 统一化：工具描述清洗（幂等）与工具名改写对所有请求生效
    this._sanitizeNonRealClaudeCodeToolDescriptions(requestPayload)
    const toolNameMap = this._transformToolNamesInRequestBody(requestPayload, {
      useRandomizedToolNames: requestOptions.useRandomizedToolNames === true
    })

    // 序列化请求体，计算 content-length
    const bodyString = JSON.stringify(requestPayload)
    const contentLength = Buffer.byteLength(bodyString, 'utf8')

    // 构建最终请求头（包含认证、版本、User-Agent、Beta 等）
    // 与真实 Claude Code 一致地协商压缩编码（避免 identity 成为指纹破绽）。
    // Node 22.15+/24 的 zlib 已内置 zstd，响应侧 _createAdaptiveDecompressStream /
    // _decompressBufferSync 支持 gzip/deflate/br/zstd，并在上游漏发 Content-Encoding 头时
    // 按魔数嗅探兜底（历史 issue #1030 的二进制损坏问题已由嗅探逻辑覆盖）。
    const ACCEPT_ENCODING = 'gzip, deflate, br, zstd'
    const headers = {
      host: 'api.anthropic.com',
      connection: 'keep-alive',
      'content-type': 'application/json',
      'content-length': String(contentLength),
      'accept-encoding': ACCEPT_ENCODING,
      authorization: `Bearer ${accessToken}`,
      'anthropic-version': this.apiVersion,
      ...finalHeaders
    }

    // finalHeaders 可能携带客户端或 Redis 缓存中的 accept-encoding，统一覆盖为
    // 我们确定能解压的编码集合，保证 spread 后值稳定
    headers['accept-encoding'] = ACCEPT_ENCODING

    // 使用统一 User-Agent 或客户端提供的，最后使用档案默认 UA
    const userAgent =
      unifiedUA ||
      headers['user-agent'] ||
      claudeCodeProfile.buildUserAgent(this._resolveEntrypoint(clientHeaders, account))
    const acceptHeader = headers['accept'] || 'application/json'
    delete headers['user-agent']
    delete headers['accept']
    headers['User-Agent'] = userAgent
    headers['Accept'] = acceptHeader

    logger.debug(`🔗 Request User-Agent: ${headers['User-Agent']}`)

    // anthropic-beta：固定使用档案集合，不合并客户端声明（禁止透传）
    headers['anthropic-beta'] = this._getBetaHeader()

    return {
      requestPayload,
      bodyString,
      headers,
      // 统一化后所有请求都经过伪装/改写，故恒为 true（响应侧据此做工具名反向还原等对称处理）
      emulationApplied: true,
      toolNameMap
    }
  }

  _applyRequestIdentityTransform(body, headers, context = {}) {
    const normalizedHeaders = headers && typeof headers === 'object' ? { ...headers } : {}

    try {
      const payload = {
        body,
        headers: normalizedHeaders,
        ...context
      }

      const result = requestIdentityService.transform(payload)
      if (!result || typeof result !== 'object') {
        return { body, headers: normalizedHeaders }
      }

      const nextBody = result.body && typeof result.body === 'object' ? result.body : body
      const nextHeaders =
        result.headers && typeof result.headers === 'object' ? result.headers : normalizedHeaders
      const abortResponse =
        result.abortResponse && typeof result.abortResponse === 'object'
          ? result.abortResponse
          : null

      return { body: nextBody, headers: nextHeaders, abortResponse }
    } catch (error) {
      logger.warn('⚠️ 应用请求身份转换失败:', error)
      return { body, headers: normalizedHeaders }
    }
  }

  // 🔗 发送请求到Claude API
  async _makeClaudeRequest(
    body,
    accessToken,
    proxyAgent,
    clientHeaders,
    accountId,
    onRequest,
    requestOptions = {}
  ) {
    const url = new URL(this.claudeApiUrl)

    // 获取账户信息用于统一 User-Agent
    const account = await claudeAccountService.getAccount(accountId)

    // 使用公共方法准备请求头和 payload
    const prepared = await this._prepareRequestHeadersAndPayload(
      body,
      clientHeaders,
      accountId,
      accessToken,
      {
        account,
        requestOptions,
        isStream: false
      }
    )

    if (prepared.abortResponse) {
      return prepared.abortResponse
    }

    let { bodyString } = prepared
    const { headers, emulationApplied, toolNameMap } = prepared

    return new Promise((resolve, reject) => {
      // 支持自定义路径（如 count_tokens）
      let requestPath = url.pathname
      if (requestOptions.customPath) {
        const baseUrl = new URL('https://api.anthropic.com')
        const customUrl = new URL(requestOptions.customPath, baseUrl)
        requestPath = customUrl.pathname
      }

      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: requestPath + (url.search || ''),
        method: 'POST',
        headers,
        agent: proxyAgent || getHttpsAgentForNonStream(),
        timeout: config.requestTimeout || 600000
      }

      const req = https.request(options, (res) => {
        // 使用数组收集 chunks，避免 O(n²) 的 Buffer.concat
        const chunks = []

        res.on('data', (chunk) => {
          chunks.push(chunk)
        })

        res.on('end', async () => {
          try {
            // 一次性合并所有 chunks
            const responseData = Buffer.concat(chunks)
            let responseBody = ''

            // 根据 Content-Encoding 处理响应数据（gzip/deflate/br/zstd，缺失时魔数嗅探）
            const contentEncoding = res.headers['content-encoding']
            responseBody = this._decompressBufferSync(responseData, contentEncoding).toString(
              'utf8'
            )

            if (emulationApplied) {
              responseBody = this._restoreToolNamesInResponseBody(responseBody, toolNameMap)
            }

            const response = {
              statusCode: res.statusCode,
              headers: res.headers,
              body: responseBody
            }

            logger.debug(`🔗 Claude API response: ${res.statusCode}`)

            // 🔗 emulation：记录本轮 request-id / message id，供同会话下一轮链式引用
            if (emulationApplied) {
              await this._captureTurnStateFromResponse(body, res.headers, responseBody)
            }

            resolve(response)
          } catch (error) {
            logger.error(`❌ Failed to parse Claude API response (Account: ${accountId}):`, error)
            reject(error)
          }
        })
      })

      // 如果提供了 onRequest 回调，传递请求对象
      if (onRequest && typeof onRequest === 'function') {
        onRequest(req)
      }

      req.on('error', async (error) => {
        logger.error(`❌ Claude API request error (Account: ${accountId}):`, error.message, {
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
          address: error.address,
          port: error.port
        })

        // 根据错误类型提供更具体的错误信息
        let errorMessage = 'Upstream request failed'
        if (error.code === 'ECONNRESET') {
          errorMessage = 'Connection reset by Claude API server'
        } else if (error.code === 'ENOTFOUND') {
          errorMessage = 'Unable to resolve Claude API hostname'
        } else if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused by Claude API server'
        } else if (error.code === 'ETIMEDOUT') {
          errorMessage = 'Connection timed out to Claude API server'

          await this._handleServerError(accountId, 504, null, 'Network')
        }

        reject(new Error(errorMessage))
      })

      req.on('timeout', async () => {
        req.destroy()
        logger.error(`❌ Claude API request timeout (Account: ${accountId})`)

        await this._handleServerError(accountId, 504, null, 'Request')

        reject(new Error('Request timeout'))
      })

      // 写入请求体
      req.write(bodyString)
      // 🧹 内存优化：立即清空 bodyString 引用，避免闭包捕获
      bodyString = null
      req.end()
    })
  }

  // 🌊 处理流式响应（带usage数据捕获）
  async relayStreamRequestWithUsageCapture(
    requestBody,
    apiKeyData,
    responseStream,
    clientHeaders,
    usageCallback,
    streamTransformer = null,
    options = {}
  ) {
    let queueLockAcquired = false
    let queueRequestId = null
    let selectedAccountId = null

    try {
      // 调试日志：查看API Key数据（流式请求）
      logger.info('🔍 [Stream] API Key data received:', {
        apiKeyName: apiKeyData.name,
        enableModelRestriction: apiKeyData.enableModelRestriction,
        restrictedModels: apiKeyData.restrictedModels,
        requestedModel: requestBody.model
      })

      const isOpusModelRequest =
        typeof requestBody?.model === 'string' && requestBody.model.toLowerCase().includes('opus')

      // 生成会话哈希用于sticky会话
      const sessionHash = sessionHelper.generateSessionHash(requestBody)

      // 选择可用的Claude账户（支持专属绑定和sticky会话）
      let accountSelection
      try {
        accountSelection = await unifiedClaudeScheduler.selectAccountForApiKey(
          apiKeyData,
          sessionHash,
          requestBody.model
        )
      } catch (error) {
        if (error.code === 'CLAUDE_DEDICATED_RATE_LIMITED') {
          const limitMessage = this._buildStandardRateLimitMessage(error.rateLimitEndAt)
          if (!responseStream.headersSent) {
            responseStream.status(403)
            responseStream.setHeader('Content-Type', 'application/json')
          }
          responseStream.write(
            JSON.stringify({
              error: 'upstream_rate_limited',
              message: limitMessage
            })
          )
          responseStream.end()
          return
        }
        throw error
      }
      const { accountId } = accountSelection
      const { accountType } = accountSelection
      selectedAccountId = accountId

      // 📬 用户消息队列处理：如果是用户消息请求，需要获取队列锁
      if (userMessageQueueService.isUserMessageRequest(requestBody)) {
        // 校验 accountId 非空，避免空值污染队列锁键
        if (!accountId || accountId === '') {
          logger.error('❌ accountId missing for queue lock in relayStreamRequestWithUsageCapture')
          throw new Error('accountId missing for queue lock')
        }
        // 获取账户信息以检查账户级串行队列配置
        const accountForQueue = await claudeAccountService.getAccount(accountId)
        const accountConfig = accountForQueue
          ? { maxConcurrency: parseInt(accountForQueue.maxConcurrency || '0', 10) }
          : null
        const queueResult = await userMessageQueueService.acquireQueueLock(
          accountId,
          null,
          null,
          accountConfig
        )
        if (!queueResult.acquired && !queueResult.skipped) {
          // 区分 Redis 后端错误和队列超时
          const isBackendError = queueResult.error === 'queue_backend_error'
          const errorCode = isBackendError ? 'QUEUE_BACKEND_ERROR' : 'QUEUE_TIMEOUT'
          const errorType = isBackendError ? 'queue_backend_error' : 'queue_timeout'
          const errorMessage = isBackendError
            ? 'Queue service temporarily unavailable, please retry later'
            : 'User message queue wait timeout, please retry later'
          const statusCode = isBackendError ? 500 : 503

          // 结构化性能日志，用于后续统计
          logger.performance('user_message_queue_error', {
            errorType,
            errorCode,
            accountId,
            statusCode,
            stream: true,
            apiKeyName: apiKeyData.name,
            backendError: isBackendError ? queueResult.errorMessage : undefined
          })

          logger.warn(
            `📬 User message queue ${errorType} for account ${accountId} (stream), key: ${apiKeyData.name}`,
            isBackendError ? { backendError: queueResult.errorMessage } : {}
          )
          if (!responseStream.headersSent) {
            const existingConnection = responseStream.getHeader
              ? responseStream.getHeader('Connection')
              : null
            responseStream.writeHead(statusCode, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: existingConnection || 'keep-alive',
              'x-user-message-queue-error': errorType
            })
          }
          const errorEvent = `event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: {
              type: errorType,
              code: errorCode,
              message: errorMessage
            }
          })}\n\n`
          responseStream.write(errorEvent)
          responseStream.write('data: [DONE]\n\n')
          responseStream.end()
          return
        }
        if (queueResult.acquired && !queueResult.skipped) {
          queueLockAcquired = true
          queueRequestId = queueResult.requestId
          logger.debug(
            `📬 User message queue lock acquired for account ${accountId} (stream), requestId: ${queueRequestId}`
          )
        }
      }

      logger.info(
        `📡 Processing streaming API request with usage capture for key: ${apiKeyData.name || apiKeyData.id}, account: ${accountId} (${accountType})${sessionHash ? `, session: ${sessionHash}` : ''}`
      )

      // 获取账户信息
      let account = await claudeAccountService.getAccount(accountId)

      if (isOpusModelRequest) {
        await claudeAccountService.clearExpiredOpusRateLimit(accountId)
        account = await claudeAccountService.getAccount(accountId)
      }

      const isDedicatedOfficialAccount =
        accountType === 'claude-official' &&
        apiKeyData.claudeAccountId &&
        !apiKeyData.claudeAccountId.startsWith('group:') &&
        apiKeyData.claudeAccountId === accountId

      let opusRateLimitActive = false
      if (isOpusModelRequest) {
        opusRateLimitActive = await claudeAccountService.isAccountOpusRateLimited(accountId)
      }

      if (isOpusModelRequest && isDedicatedOfficialAccount && opusRateLimitActive) {
        const limitMessage = this._buildOpusLimitMessage(account?.opusRateLimitEndAt)
        if (!responseStream.headersSent) {
          responseStream.status(403)
          responseStream.setHeader('Content-Type', 'application/json')
        }
        responseStream.write(
          JSON.stringify({
            error: 'opus_weekly_limit',
            message: limitMessage
          })
        )
        responseStream.end()
        return
      }

      // 获取有效的访问token
      const accessToken = await claudeAccountService.getValidAccessToken(accountId)

      // 🎓 该识别结果仅用于 header 缓存学习（storeAccountHeaders），不影响转发行为
      const isRealClaudeCodeRequest = this._isActualClaudeCodeRequest(requestBody, clientHeaders)
      const processedBody = this._processRequestBody(
        requestBody,
        account,
        isRealClaudeCodeRequest,
        {
          entrypoint: this._resolveEntrypoint(clientHeaders, account)
        }
      )
      // 🔗 注入同会话上一轮的链式引用（cc_prev_req / diagnostics.previous_message_id）——对所有请求生效
      await this._applyTurnChaining(processedBody)
      // 🧹 内存优化：存储到 bodyStore，不放入 requestOptions 避免闭包捕获
      const originalBodyString = JSON.stringify(processedBody)
      const bodyStoreId = ++this._bodyStoreIdCounter
      this.bodyStore.set(bodyStoreId, originalBodyString)

      // 获取代理配置
      const proxyAgent = await this._getProxyAgent(accountId)

      // 发送流式请求并捕获usage数据
      await this._makeClaudeStreamRequestWithUsageCapture(
        processedBody,
        accessToken,
        proxyAgent,
        clientHeaders,
        responseStream,
        (usageData) => {
          // 在usageCallback中添加accountId
          if (usageCallback && typeof usageCallback === 'function') {
            usageCallback({ ...usageData, accountId })
          }
        },
        accountId,
        accountType,
        sessionHash,
        streamTransformer,
        {
          ...options,
          bodyStoreId,
          isRealClaudeCodeRequest
        },
        isDedicatedOfficialAccount,
        // 📬 新增回调：在收到响应头时释放队列锁
        async () => {
          if (queueLockAcquired && queueRequestId && selectedAccountId) {
            try {
              await userMessageQueueService.releaseQueueLock(selectedAccountId, queueRequestId)
              queueLockAcquired = false // 标记已释放，防止 finally 重复释放
              logger.debug(
                `📬 User message queue lock released early for stream account ${selectedAccountId}, requestId: ${queueRequestId}`
              )
            } catch (releaseError) {
              logger.error(
                `❌ Failed to release user message queue lock early for stream account ${selectedAccountId}:`,
                releaseError.message
              )
            }
          }
        }
      )
    } catch (error) {
      // 客户端主动断开连接是正常情况，使用 INFO 级别
      if (error.message === 'Client disconnected') {
        logger.info(`🔌 Claude stream relay ended: Client disconnected`)
      } else {
        logger.error(`❌ Claude stream relay with usage capture failed:`, error)
      }
      throw error
    } finally {
      // 📬 释放用户消息队列锁（兜底，正常情况下已在收到响应头后提前释放）
      if (queueLockAcquired && queueRequestId && selectedAccountId) {
        try {
          await userMessageQueueService.releaseQueueLock(selectedAccountId, queueRequestId)
          logger.debug(
            `📬 User message queue lock released in finally for stream account ${selectedAccountId}, requestId: ${queueRequestId}`
          )
        } catch (releaseError) {
          logger.error(
            `❌ Failed to release user message queue lock for stream account ${selectedAccountId}:`,
            releaseError.message
          )
        }
      }
    }
  }

  // 🌊 发送流式请求到Claude API（带usage数据捕获）
  async _makeClaudeStreamRequestWithUsageCapture(
    body,
    accessToken,
    proxyAgent,
    clientHeaders,
    responseStream,
    usageCallback,
    accountId,
    accountType,
    sessionHash,
    streamTransformer = null,
    requestOptions = {},
    isDedicatedOfficialAccount = false,
    onResponseStart = null, // 📬 新增：收到响应头时的回调，用于提前释放队列锁
    retryCount = 0 // 🔄 403 重试计数器
  ) {
    const maxRetries = 2 // 最大重试次数
    // 获取账户信息用于统一 User-Agent
    const account = await claudeAccountService.getAccount(accountId)

    const isOpusModelRequest =
      typeof body?.model === 'string' && body.model.toLowerCase().includes('opus')

    // 使用公共方法准备请求头和 payload
    const prepared = await this._prepareRequestHeadersAndPayload(
      body,
      clientHeaders,
      accountId,
      accessToken,
      {
        account,
        accountType,
        sessionHash,
        requestOptions,
        isStream: true
      }
    )

    if (prepared.abortResponse) {
      return prepared.abortResponse
    }

    let { bodyString } = prepared
    const { headers, emulationApplied, toolNameMap } = prepared
    // 流式响应反向还原：仅当请求侧实际进行了伪装时才做（保持对称）
    const toolNameStreamTransformer = this._createToolNameStripperStreamTransformer(
      streamTransformer,
      toolNameMap,
      emulationApplied
    )

    return new Promise((resolve, reject) => {
      const url = new URL(this.claudeApiUrl)
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + (url.search || ''),
        method: 'POST',
        headers,
        agent: proxyAgent || getHttpsAgentForStream(),
        timeout: config.requestTimeout || 600000
      }

      const req = https.request(options, async (res) => {
        logger.debug(`🌊 Claude stream response status: ${res.statusCode}`)

        // 错误响应处理
        if (res.statusCode !== 200) {
          if (res.statusCode === 429) {
            // 💰 先读取完整 body 以区分 "Extra usage required" 和真正的限流
            const bodyChunks429 = []
            await new Promise((resolveBody) => {
              res.on('data', (chunk) => bodyChunks429.push(chunk))
              res.on('end', resolveBody)
              res.on('error', resolveBody)
            })
            const errorBody429 = this._decodeUpstreamErrorBody(bodyChunks429, res.headers)

            // 检查是否为 "Extra usage required" 的非限流 429
            if (this._isExtraUsageRequired429(res.statusCode, errorBody429)) {
              logger.info(
                `💰 [Stream] "Extra usage required" 429 for account ${accountId}, skipping rate limit marking`
              )
              logger.error(
                `❌ Claude API returned error status: 429 | Account: ${account?.name || accountId}`
              )
              logger.error(
                `❌ Claude API error response (429) (Account: ${account?.name || accountId}): ${(errorBody429 || '').slice(0, 2000)}`
              )
              if (isStreamWritable(responseStream)) {
                let errorMessage = `Claude API error: 429`
                try {
                  const parsedError = JSON.parse(errorBody429)
                  if (parsedError.error?.message) {
                    errorMessage = parsedError.error.message
                  } else if (parsedError.message) {
                    errorMessage = parsedError.message
                  }
                } catch {
                  // 使用默认错误消息
                }
                if (toolNameStreamTransformer) {
                  responseStream.write(
                    `data: ${JSON.stringify({ type: 'error', error: errorMessage })}\n\n`
                  )
                } else {
                  responseStream.write('event: error\n')
                  responseStream.write(
                    `data: ${JSON.stringify({
                      error: 'Claude API error',
                      status: 429,
                      details: errorBody429,
                      timestamp: new Date().toISOString()
                    })}\n\n`
                  )
                }
                responseStream.end()
              }
              reject(new Error(`Claude API error: 429`))
              return
            }

            // 真正的限流处理
            const resetHeader = res.headers
              ? res.headers['anthropic-ratelimit-unified-reset']
              : null
            const parsedResetTimestamp = resetHeader ? parseInt(resetHeader, 10) : NaN

            if (isOpusModelRequest) {
              if (!Number.isNaN(parsedResetTimestamp)) {
                await claudeAccountService.markAccountOpusRateLimited(
                  accountId,
                  parsedResetTimestamp
                )
                logger.warn(
                  `🚫 [Stream] Account ${accountId} hit Opus limit, resets at ${new Date(parsedResetTimestamp * 1000).toISOString()}`
                )
              }

              if (isDedicatedOfficialAccount) {
                const limitMessage = this._buildOpusLimitMessage(parsedResetTimestamp)
                if (!responseStream.headersSent) {
                  responseStream.status(403)
                  responseStream.setHeader('Content-Type', 'application/json')
                }
                responseStream.write(
                  JSON.stringify({
                    error: 'opus_weekly_limit',
                    message: limitMessage
                  })
                )
                responseStream.end()
                resolve()
                return
              }
            } else {
              const rateLimitResetTimestamp = Number.isNaN(parsedResetTimestamp)
                ? null
                : parsedResetTimestamp
              await unifiedClaudeScheduler.markAccountRateLimited(
                accountId,
                accountType,
                sessionHash,
                rateLimitResetTimestamp
              )
              await upstreamErrorHelper
                .markTempUnavailable(
                  accountId,
                  accountType,
                  429,
                  upstreamErrorHelper.parseRetryAfter(res.headers)
                )
                .catch(() => {})
              logger.warn(`🚫 [Stream] Rate limit detected for account ${accountId}, status 429`)

              if (isDedicatedOfficialAccount) {
                const limitMessage = this._buildStandardRateLimitMessage(
                  rateLimitResetTimestamp || account?.rateLimitEndAt
                )
                if (!responseStream.headersSent) {
                  responseStream.status(403)
                  responseStream.setHeader('Content-Type', 'application/json')
                }
                responseStream.write(
                  JSON.stringify({
                    error: 'upstream_rate_limited',
                    message: limitMessage
                  })
                )
                responseStream.end()
                resolve()
                return
              }
            }

            // 非专属账户的真正限流：透传错误给客户端（body 已读完，无需 fall-through）
            logger.error(
              `❌ Claude API returned error status: 429 | Account: ${account?.name || accountId}`
            )
            logger.error(
              `❌ Claude API error response (429) (Account: ${account?.name || accountId}): ${(errorBody429 || '').slice(0, 2000)}`
            )
            if (isStreamWritable(responseStream)) {
              let errorMessage = `Claude API error: 429`
              try {
                const parsedError = JSON.parse(errorBody429)
                if (parsedError.error?.message) {
                  errorMessage = parsedError.error.message
                } else if (parsedError.message) {
                  errorMessage = parsedError.message
                }
              } catch {
                // 使用默认错误消息
              }
              if (toolNameStreamTransformer) {
                responseStream.write(
                  `data: ${JSON.stringify({ type: 'error', error: errorMessage })}\n\n`
                )
              } else {
                responseStream.write('event: error\n')
                responseStream.write(
                  `data: ${JSON.stringify({
                    error: 'Claude API error',
                    status: 429,
                    details: errorBody429,
                    timestamp: new Date().toISOString()
                  })}\n\n`
                )
              }
              responseStream.end()
            }
            reject(new Error(`Claude API error: 429`))
            return
          }

          // 🔄 403 重试机制（必须在设置 res.on('data')/res.on('end') 之前处理）
          // 否则重试时旧响应的 on('end') 会与新请求产生竞态条件
          if (res.statusCode === 403) {
            const canRetry =
              this._shouldRetryOn403(accountType) &&
              retryCount < maxRetries &&
              !responseStream.headersSent

            if (canRetry) {
              logger.warn(
                `🔄 [Stream] 403 error for account ${accountId}, retry ${retryCount + 1}/${maxRetries} after 2s`
              )
              // 消费当前响应并销毁请求
              res.resume()
              req.destroy()

              // 等待 2 秒后递归重试
              await this._sleep(2000)

              try {
                // 递归调用自身进行重试
                // 🧹 从 bodyStore 获取字符串用于重试
                if (
                  !requestOptions.bodyStoreId ||
                  !this.bodyStore.has(requestOptions.bodyStoreId)
                ) {
                  throw new Error('529 retry requires valid bodyStoreId')
                }
                let retryBody
                try {
                  retryBody = JSON.parse(this.bodyStore.get(requestOptions.bodyStoreId))
                } catch (parseError) {
                  logger.error(`❌ Failed to parse body for 529 retry: ${parseError.message}`)
                  throw new Error(`529 retry body parse failed: ${parseError.message}`)
                }
                // 🧹 移除当前层的 close 监听，递归层会注册自己的，避免堆积
                responseStream.removeListener('close', onResponseStreamClose)
                const retryResult = await this._makeClaudeStreamRequestWithUsageCapture(
                  retryBody,
                  accessToken,
                  proxyAgent,
                  clientHeaders,
                  responseStream,
                  usageCallback,
                  accountId,
                  accountType,
                  sessionHash,
                  streamTransformer,
                  requestOptions,
                  isDedicatedOfficialAccount,
                  onResponseStart,
                  retryCount + 1
                )
                resolve(retryResult)
              } catch (retryError) {
                reject(retryError)
              }
              return // 重要：提前返回，不设置后续的错误处理器
            }
          }

          // 将错误处理逻辑封装在一个异步函数中
          const handleErrorResponse = async () => {
            if (res.statusCode === 401) {
              logger.warn(`🔐 [Stream] Unauthorized error (401) detected for account ${accountId}`)

              // 🛡️ 401 重试上限守卫（与 403 路径共用 maxRetries），防止无限递归
              const canRetryOn401 = retryCount < maxRetries
              if (!canRetryOn401) {
                logger.error(
                  `🚫 [Stream] 401 retries exhausted (${retryCount}/${maxRetries}) for account ${accountId}, giving up refresh`
                )
              }

              // 🔄 尝试通过 credentials 文件刷新 token
              let refreshSuccess = false
              let refreshedAccessToken = null
              if (canRetryOn401) {
                try {
                  logger.info(
                    `🔄 [Stream] Attempting credentials-based token refresh for account ${accountId} due to 401...`
                  )
                  const refreshResult = await claudeAccountService.refreshTokenViaCredentials(
                    accountId,
                    'upstream_error'
                  )
                  if (refreshResult && refreshResult.success && refreshResult.accessToken) {
                    logger.success(
                      `✅ [Stream] Token refreshed successfully via credentials for account ${accountId}`
                    )
                    refreshSuccess = true
                    refreshedAccessToken = refreshResult.accessToken
                  }
                } catch (refreshError) {
                  logger.warn(
                    `⚠️ [Stream] Credentials-based refresh failed for account ${accountId}: ${refreshError.message}`
                  )
                }
              }

              // 🔄 如果刷新成功，重试请求
              if (refreshSuccess) {
                logger.info(
                  `🔄 [Stream] Retrying request after token refresh for account ${accountId}...`
                )
                try {
                  // 使用 refresh 直接返回的新 token，避免再次调用 getValidAccessToken 触发重复刷新
                  const newAccessToken = refreshedAccessToken
                  // 从 bodyStore 获取请求体
                  if (
                    !requestOptions.bodyStoreId ||
                    !this.bodyStore.has(requestOptions.bodyStoreId)
                  ) {
                    throw new Error('401 retry requires valid bodyStoreId')
                  }
                  let retryBody
                  try {
                    retryBody = JSON.parse(this.bodyStore.get(requestOptions.bodyStoreId))
                  } catch (parseError) {
                    logger.error(
                      `❌ [Stream] Failed to parse body for 401 retry: ${parseError.message}`
                    )
                    throw new Error(`401 retry body parse failed: ${parseError.message}`)
                  }
                  // 🧹 移除当前层的 close 监听，递归层会注册自己的，避免堆积
                  responseStream.removeListener('close', onResponseStreamClose)
                  // 递归调用重试
                  const retryResult = await this._makeClaudeStreamRequestWithUsageCapture(
                    retryBody,
                    newAccessToken,
                    proxyAgent,
                    clientHeaders,
                    responseStream,
                    usageCallback,
                    accountId,
                    accountType,
                    sessionHash,
                    streamTransformer,
                    requestOptions,
                    isDedicatedOfficialAccount,
                    onResponseStart,
                    retryCount + 1
                  )
                  resolve(retryResult)
                  return // 重要：提前返回，不执行后续错误处理
                } catch (retryError) {
                  logger.error(
                    `❌ [Stream] Request retry failed after token refresh for account ${accountId}: ${retryError.message}`
                  )
                }
              }

              await this.recordUnauthorizedError(accountId)

              const errorCount = await this.getUnauthorizedErrorCount(accountId)
              logger.info(
                `🔐 [Stream] Account ${accountId} has ${errorCount} consecutive 401 errors in the last 5 minutes`
              )

              if (errorCount >= 1) {
                logger.error(
                  `❌ [Stream] Account ${accountId} encountered 401 error (${errorCount} errors), temporarily pausing`
                )
              }
              await upstreamErrorHelper
                .markTempUnavailable(accountId, accountType, 401)
                .catch(() => {})
              // 清除粘性会话，让后续请求路由到其他账户
              if (sessionHash) {
                await unifiedClaudeScheduler.clearSessionMapping(sessionHash).catch(() => {})
              }
            } else if (res.statusCode === 403) {
              // 403 处理：先检查是否为封禁性质的 403（组织被禁用/OAuth 被禁止）
              // 注意：重试逻辑已在 handleErrorResponse 外部提前处理
              if (this._isOrganizationDisabledError(res.statusCode, errorData)) {
                logger.error(
                  `🚫 [Stream] Organization disabled/banned error (403) detected for account ${accountId}, marking as blocked`
                )
                await unifiedClaudeScheduler
                  .markAccountBlocked(accountId, accountType, sessionHash)
                  .catch((markError) => {
                    logger.error(
                      `❌ [Stream] Failed to mark account ${accountId} as blocked:`,
                      markError
                    )
                  })
              } else {
                logger.error(
                  `🚫 [Stream] Forbidden error (403) detected for account ${accountId}${retryCount > 0 ? ` after ${retryCount} retries` : ''}, temporarily pausing`
                )
                await upstreamErrorHelper
                  .markTempUnavailable(accountId, accountType, 403)
                  .catch(() => {})
              }
              // 清除粘性会话，让后续请求路由到其他账户
              if (sessionHash) {
                await unifiedClaudeScheduler.clearSessionMapping(sessionHash).catch(() => {})
              }
            } else if (res.statusCode === 529) {
              logger.warn(`🚫 [Stream] Overload error (529) detected for account ${accountId}`)

              // 检查是否启用了529错误处理
              if (config.claude.overloadHandling.enabled > 0) {
                try {
                  await claudeAccountService.markAccountOverloaded(accountId)
                  logger.info(
                    `🚫 [Stream] Account ${accountId} marked as overloaded for ${config.claude.overloadHandling.enabled} minutes`
                  )
                } catch (overloadError) {
                  logger.error(
                    `❌ [Stream] Failed to mark account as overloaded: ${accountId}`,
                    overloadError
                  )
                }
              } else {
                logger.info(
                  `🚫 [Stream] 529 error handling is disabled, skipping account overload marking`
                )
              }
              await upstreamErrorHelper
                .markTempUnavailable(accountId, accountType, 529)
                .catch(() => {})
            } else if (res.statusCode >= 500 && res.statusCode < 600) {
              logger.warn(
                `🔥 [Stream] Server error (${res.statusCode}) detected for account ${accountId}`
              )
              await this._handleServerError(accountId, res.statusCode, sessionHash, '[Stream]')
            }
          }

          // 调用异步错误处理函数
          handleErrorResponse().catch((err) => {
            logger.error('❌ Error in stream error handler:', err)
          })

          logger.error(
            `❌ Claude API returned error status: ${res.statusCode} | Account: ${account?.name || accountId}`
          )
          const _errChunks = []

          res.on('data', (chunk) => {
            try {
              _errChunks.push(Buffer.from(chunk))
            } catch (e) {}
          })

          res.on('end', async () => {
            const errorData = this._decodeUpstreamErrorBody(_errChunks, res.headers)
            logger.error(
              `❌ Claude API error response (${res.statusCode}) (Account: ${account?.name || accountId}): ${(errorData || '').slice(0, 2000)}`
            )
            if (
              this._isClaudeCodeCredentialError(errorData) &&
              requestOptions.useRandomizedToolNames !== true &&
              requestOptions.bodyStoreId &&
              this.bodyStore.has(requestOptions.bodyStoreId)
            ) {
              let retryBody
              try {
                retryBody = JSON.parse(this.bodyStore.get(requestOptions.bodyStoreId))
              } catch (parseError) {
                logger.error(`❌ Failed to parse body for 403 retry: ${parseError.message}`)
                reject(new Error(`403 retry body parse failed: ${parseError.message}`))
                return
              }
              try {
                // 🧹 移除当前层的 close 监听，递归层会注册自己的，避免堆积
                responseStream.removeListener('close', onResponseStreamClose)
                const retryResult = await this._makeClaudeStreamRequestWithUsageCapture(
                  retryBody,
                  accessToken,
                  proxyAgent,
                  clientHeaders,
                  responseStream,
                  usageCallback,
                  accountId,
                  accountType,
                  sessionHash,
                  streamTransformer,
                  { ...requestOptions, useRandomizedToolNames: true },
                  isDedicatedOfficialAccount,
                  onResponseStart,
                  retryCount
                )
                resolve(retryResult)
              } catch (retryError) {
                reject(retryError)
              }
              return
            }
            if (this._isOrganizationDisabledError(res.statusCode, errorData)) {
              ;(async () => {
                try {
                  logger.error(
                    `🚫 [Stream] Organization disabled error (400) detected for account ${accountId}, marking as blocked`
                  )
                  await unifiedClaudeScheduler.markAccountBlocked(
                    accountId,
                    accountType,
                    sessionHash
                  )
                } catch (markError) {
                  logger.error(
                    `❌ [Stream] Failed to mark account ${accountId} as blocked after organization disabled error:`,
                    markError
                  )
                }
              })()
            }
            if (isStreamWritable(responseStream)) {
              // 解析 Claude API 返回的错误详情
              let errorMessage = `Claude API error: ${res.statusCode}`
              try {
                const parsedError = JSON.parse(errorData)
                if (parsedError.error?.message) {
                  errorMessage = parsedError.error.message
                } else if (parsedError.message) {
                  errorMessage = parsedError.message
                }
              } catch {
                // 使用默认错误消息
              }

              // 如果有 streamTransformer（如测试请求），使用前端期望的格式
              if (toolNameStreamTransformer) {
                responseStream.write(
                  `data: ${JSON.stringify({ type: 'error', error: errorMessage })}\n\n`
                )
              } else {
                // 标准 Anthropic SSE 错误事件格式：透传上游 error.type/message，
                // 使 OpenClaw / SDK 等客户端能正确解析并展示真实失败原因
                // （如 "Third-party apps now draw from your extra usage…"），
                // 而不是收到非标准包裹后表现为空白/异常。
                let errorType = 'api_error'
                let finalMessage = errorMessage
                try {
                  const parsed = JSON.parse(errorData)
                  if (parsed.error?.type) {
                    errorType = parsed.error.type
                  }
                  if (parsed.error?.message) {
                    finalMessage = parsed.error.message
                  }
                } catch {
                  // 保留默认
                }
                responseStream.write('event: error\n')
                responseStream.write(
                  `data: ${JSON.stringify({
                    type: 'error',
                    error: { type: errorType, message: finalMessage }
                  })}\n\n`
                )
              }
              responseStream.end()
            }
            reject(new Error(`Claude API error: ${res.statusCode}`))
          })
          return
        }

        // 📬 收到成功响应头（HTTP 200），立即调用回调释放队列锁
        // 此时请求已被 Claude API 接受并计入 RPM 配额，无需等待响应完成
        if (onResponseStart && typeof onResponseStart === 'function') {
          try {
            await onResponseStart()
          } catch (callbackError) {
            logger.error('❌ Error in onResponseStart callback:', callbackError.message)
          }
        }

        let buffer = ''
        const allUsageData = [] // 收集所有的usage事件
        let currentUsageData = {} // 当前正在收集的usage数据
        let rateLimitDetected = false // 限流检测标志

        // 监听数据块，解析SSE并寻找usage信息
        // 🧹 内存优化：在闭包创建前提取需要的值，避免闭包捕获 body 和 requestOptions
        // body 和 requestOptions 只在闭包外使用，闭包内只引用基本类型
        const requestedModel = body?.model || 'unknown'
        const { isRealClaudeCodeRequest } = requestOptions

        // 🔗 emulation：本轮会话标识（body 已处理完毕，metadata.user_id.session_id 即最终值）
        const emulationSessionId = emulationApplied
          ? metadataUserIdHelper.extractSessionId(body?.metadata?.user_id)
          : null
        const upstreamRequestId = (res.headers && res.headers['request-id']) || null

        // 🔧 处理上游压缩：Anthropic (经 Cloudflare) 可能返回 gzip/deflate/br/zstd 压缩响应；
        // Content-Encoding 头缺失时由自适应流按首块魔数嗅探（兜底 issue #1030）
        const upstreamEncoding = res.headers['content-encoding']
        let dataSource = res
        const decompressStream = this._createAdaptiveDecompressStream(upstreamEncoding)
        if (decompressStream) {
          decompressStream.on('error', (err) => {
            logger.error(
              `❌ Decompression error in stream (${upstreamEncoding || 'sniffed'}):`,
              err.message
            )
            if (isStreamWritable(responseStream)) {
              responseStream.end()
            }
          })
          dataSource = res.pipe(decompressStream)
        }

        dataSource.on('data', (chunk) => {
          try {
            const chunkStr = chunk.toString()

            buffer += chunkStr

            // 处理完整的SSE行
            const lines = buffer.split('\n')
            buffer = lines.pop() || '' // 保留最后的不完整行

            // 转发已处理的完整行到客户端
            if (lines.length > 0) {
              if (isStreamWritable(responseStream)) {
                const linesToForward = lines.join('\n') + (lines.length > 0 ? '\n' : '')
                // 如果有流转换器，应用转换
                if (toolNameStreamTransformer) {
                  const transformed = toolNameStreamTransformer(linesToForward)
                  if (transformed) {
                    responseStream.write(transformed)
                  }
                } else {
                  responseStream.write(linesToForward)
                }
              } else {
                // 客户端连接已断开，记录警告（但仍继续解析usage）
                logger.warn(
                  `⚠️ [Official] Client disconnected during stream, skipping ${lines.length} lines for account: ${accountId}`
                )
              }
            }

            for (const line of lines) {
              // 解析SSE数据寻找usage信息
              if (line.startsWith('data:')) {
                const jsonStr = line.slice(5).trimStart()
                if (!jsonStr || jsonStr === '[DONE]') {
                  continue
                }
                try {
                  const data = JSON.parse(jsonStr)

                  // 收集来自不同事件的usage数据
                  if (data.type === 'message_start' && data.message && data.message.usage) {
                    // 新的消息开始，如果之前有数据，先保存
                    if (
                      currentUsageData.input_tokens !== undefined &&
                      currentUsageData.output_tokens !== undefined
                    ) {
                      allUsageData.push({ ...currentUsageData })
                      currentUsageData = {}
                    }

                    // message_start包含input tokens、cache tokens和模型信息
                    currentUsageData.input_tokens = data.message.usage.input_tokens || 0
                    currentUsageData.cache_creation_input_tokens =
                      data.message.usage.cache_creation_input_tokens || 0
                    currentUsageData.cache_read_input_tokens =
                      data.message.usage.cache_read_input_tokens || 0
                    currentUsageData.model = data.message.model

                    // 检查是否有详细的 cache_creation 对象
                    if (
                      data.message.usage.cache_creation &&
                      typeof data.message.usage.cache_creation === 'object'
                    ) {
                      currentUsageData.cache_creation = {
                        ephemeral_5m_input_tokens:
                          data.message.usage.cache_creation.ephemeral_5m_input_tokens || 0,
                        ephemeral_1h_input_tokens:
                          data.message.usage.cache_creation.ephemeral_1h_input_tokens || 0
                      }
                      logger.debug(
                        '📊 Collected detailed cache creation data:',
                        JSON.stringify(currentUsageData.cache_creation)
                      )
                    }

                    logger.debug(
                      '📊 Collected input/cache data from message_start:',
                      JSON.stringify(currentUsageData)
                    )

                    // 🔗 emulation：记录本轮 request-id / message id，供同会话下一轮链式引用
                    if (emulationSessionId) {
                      this._saveTurnState(emulationSessionId, {
                        requestId: upstreamRequestId,
                        messageId: data.message.id || null
                      }).catch(() => {})
                    }
                  }

                  // message_delta包含最终的output tokens
                  if (
                    data.type === 'message_delta' &&
                    data.usage &&
                    data.usage.output_tokens !== undefined
                  ) {
                    currentUsageData.output_tokens = data.usage.output_tokens || 0

                    logger.debug(
                      '📊 Collected output data from message_delta:',
                      JSON.stringify(currentUsageData)
                    )

                    // 如果已经收集到了input数据和output数据，这是一个完整的usage
                    if (currentUsageData.input_tokens !== undefined) {
                      logger.debug(
                        '🎯 Complete usage data collected for model:',
                        currentUsageData.model,
                        '- Input:',
                        currentUsageData.input_tokens,
                        'Output:',
                        currentUsageData.output_tokens
                      )
                      // 保存到列表中，但不立即触发回调
                      allUsageData.push({ ...currentUsageData })
                      // 重置当前数据，准备接收下一个
                      currentUsageData = {}
                    }
                  }

                  // 检查是否有限流错误
                  if (
                    data.type === 'error' &&
                    data.error &&
                    data.error.message &&
                    data.error.message.toLowerCase().includes("exceed your account's rate limit")
                  ) {
                    rateLimitDetected = true
                    logger.warn(`🚫 Rate limit detected in stream for account ${accountId}`)
                  }
                } catch (parseError) {
                  // 忽略JSON解析错误，继续处理
                  logger.debug('🔍 SSE line not JSON or no usage data:', line.slice(0, 100))
                }
              }
            }
          } catch (error) {
            logger.error('❌ Error processing stream data:', error)
            // 发送错误但不破坏流，让它自然结束
            if (isStreamWritable(responseStream)) {
              responseStream.write('event: error\n')
              responseStream.write(
                `data: ${JSON.stringify({
                  error: 'Stream processing error',
                  message: error.message,
                  timestamp: new Date().toISOString()
                })}\n\n`
              )
            }
          }
        })

        dataSource.on('end', async () => {
          try {
            // 处理缓冲区中剩余的数据
            if (buffer.trim() && isStreamWritable(responseStream)) {
              if (toolNameStreamTransformer) {
                const transformed = toolNameStreamTransformer(buffer)
                if (transformed) {
                  responseStream.write(transformed)
                }
              } else {
                responseStream.write(buffer)
              }
            }

            // 确保流正确结束
            if (isStreamWritable(responseStream)) {
              responseStream.end()
              logger.debug(
                `🌊 Stream end called | bytesWritten: ${responseStream.bytesWritten || 'unknown'}`
              )
            } else {
              // 连接已断开，记录警告
              logger.warn(
                `⚠️ [Official] Client disconnected before stream end, data may not have been received | account: ${account?.name || accountId}`
              )
            }
          } catch (error) {
            logger.error('❌ Error processing stream end:', error)
          }

          // 如果还有未完成的usage数据，尝试保存
          if (currentUsageData.input_tokens !== undefined) {
            if (currentUsageData.output_tokens === undefined) {
              currentUsageData.output_tokens = 0 // 如果没有output，设为0
            }
            allUsageData.push(currentUsageData)
          }

          // 检查是否捕获到usage数据
          if (allUsageData.length === 0) {
            logger.warn(
              '⚠️ Stream completed but no usage data was captured! This indicates a problem with SSE parsing or Claude API response format.'
            )
          } else {
            // 打印此次请求的所有usage数据汇总
            const totalUsage = allUsageData.reduce(
              (acc, usage) => ({
                input_tokens: (acc.input_tokens || 0) + (usage.input_tokens || 0),
                output_tokens: (acc.output_tokens || 0) + (usage.output_tokens || 0),
                cache_creation_input_tokens:
                  (acc.cache_creation_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
                cache_read_input_tokens:
                  (acc.cache_read_input_tokens || 0) + (usage.cache_read_input_tokens || 0),
                models: [...(acc.models || []), usage.model].filter(Boolean)
              }),
              {}
            )

            // 打印原始的usage数据为JSON字符串，避免嵌套问题
            logger.info(
              `📊 === Stream Request Usage Summary === Model: ${requestedModel}, Total Events: ${allUsageData.length}, Usage Data: ${JSON.stringify(allUsageData)}`
            )

            // 一般一个请求只会使用一个模型，即使有多个usage事件也应该合并
            // 计算总的usage
            const finalUsage = {
              input_tokens: totalUsage.input_tokens,
              output_tokens: totalUsage.output_tokens,
              cache_creation_input_tokens: totalUsage.cache_creation_input_tokens,
              cache_read_input_tokens: totalUsage.cache_read_input_tokens,
              model: allUsageData[allUsageData.length - 1].model || requestedModel // 使用最后一个模型或请求模型
            }

            // 如果有详细的cache_creation数据，合并它们
            let totalEphemeral5m = 0
            let totalEphemeral1h = 0
            allUsageData.forEach((usage) => {
              if (usage.cache_creation && typeof usage.cache_creation === 'object') {
                totalEphemeral5m += usage.cache_creation.ephemeral_5m_input_tokens || 0
                totalEphemeral1h += usage.cache_creation.ephemeral_1h_input_tokens || 0
              }
            })

            // 如果有详细的缓存数据，添加到finalUsage
            if (totalEphemeral5m > 0 || totalEphemeral1h > 0) {
              finalUsage.cache_creation = {
                ephemeral_5m_input_tokens: totalEphemeral5m,
                ephemeral_1h_input_tokens: totalEphemeral1h
              }
              logger.info(
                '📊 Detailed cache creation breakdown:',
                JSON.stringify(finalUsage.cache_creation)
              )
            }

            // 调用一次usageCallback记录合并后的数据
            if (usageCallback && typeof usageCallback === 'function') {
              usageCallback(finalUsage)
            }
          }

          // 提取5小时会话窗口状态
          // 使用大小写不敏感的方式获取响应头
          const get5hStatus = (resHeaders) => {
            if (!resHeaders) {
              return null
            }
            // HTTP头部名称不区分大小写，需要处理不同情况
            return (
              resHeaders['anthropic-ratelimit-unified-5h-status'] ||
              resHeaders['Anthropic-Ratelimit-Unified-5h-Status'] ||
              resHeaders['ANTHROPIC-RATELIMIT-UNIFIED-5H-STATUS']
            )
          }

          const sessionWindowStatus = get5hStatus(res.headers)
          if (sessionWindowStatus) {
            logger.info(`📊 Session window status for account ${accountId}: ${sessionWindowStatus}`)
            // 保存会话窗口状态到账户数据
            await claudeAccountService.updateSessionWindowStatus(accountId, sessionWindowStatus)
          }

          // 处理限流状态
          if (rateLimitDetected || res.statusCode === 429) {
            const resetHeader = res.headers
              ? res.headers['anthropic-ratelimit-unified-reset']
              : null
            const parsedResetTimestamp = resetHeader ? parseInt(resetHeader, 10) : NaN

            if (isOpusModelRequest && !Number.isNaN(parsedResetTimestamp)) {
              await claudeAccountService.markAccountOpusRateLimited(accountId, parsedResetTimestamp)
              logger.warn(
                `🚫 [Stream] Account ${accountId} hit Opus limit, resets at ${new Date(parsedResetTimestamp * 1000).toISOString()}`
              )
            } else {
              const rateLimitResetTimestamp = Number.isNaN(parsedResetTimestamp)
                ? null
                : parsedResetTimestamp

              if (!Number.isNaN(parsedResetTimestamp)) {
                logger.info(
                  `🕐 Extracted rate limit reset timestamp from stream: ${parsedResetTimestamp} (${new Date(parsedResetTimestamp * 1000).toISOString()})`
                )
              }

              await unifiedClaudeScheduler.markAccountRateLimited(
                accountId,
                accountType,
                sessionHash,
                rateLimitResetTimestamp
              )
              await upstreamErrorHelper
                .markTempUnavailable(
                  accountId,
                  accountType,
                  429,
                  upstreamErrorHelper.parseRetryAfter(res.headers)
                )
                .catch(() => {})
            }
          } else if (res.statusCode === 200) {
            // 请求成功，清除401和500错误计数
            await this.clearUnauthorizedErrors(accountId)
            await claudeAccountService.clearInternalErrors(accountId)
            // 如果请求成功，检查并移除限流状态
            const isRateLimited = await unifiedClaudeScheduler.isAccountRateLimited(
              accountId,
              accountType
            )
            if (isRateLimited) {
              await unifiedClaudeScheduler.removeAccountRateLimit(accountId, accountType)
            }

            // 如果流式请求成功，检查并移除过载状态
            try {
              const isOverloaded = await claudeAccountService.isAccountOverloaded(accountId)
              if (isOverloaded) {
                await claudeAccountService.removeAccountOverload(accountId)
              }
            } catch (overloadError) {
              logger.error(
                `❌ [Stream] Failed to check/remove overload status for account ${accountId}:`,
                overloadError
              )
            }

            // 只有真实的 Claude Code 请求才更新 headers（流式请求）
            if (clientHeaders && Object.keys(clientHeaders).length > 0 && isRealClaudeCodeRequest) {
              await claudeCodeHeadersService.storeAccountHeaders(accountId, clientHeaders)
            }
          }

          // 🧹 清理 bodyStore
          if (requestOptions.bodyStoreId) {
            this.bodyStore.delete(requestOptions.bodyStoreId)
          }
          logger.debug('🌊 Claude stream response with usage capture completed')
          resolve()
        })
      })

      req.on('error', async (error) => {
        logger.error(
          `❌ Claude stream request error (Account: ${account?.name || accountId}):`,
          error.message,
          {
            code: error.code,
            errno: error.errno,
            syscall: error.syscall
          }
        )

        // 根据错误类型提供更具体的错误信息
        let errorMessage = 'Upstream request failed'
        let statusCode = 500
        if (error.code === 'ECONNRESET') {
          errorMessage = 'Connection reset by Claude API server'
          statusCode = 502
        } else if (error.code === 'ENOTFOUND') {
          errorMessage = 'Unable to resolve Claude API hostname'
          statusCode = 502
        } else if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused by Claude API server'
          statusCode = 502
        } else if (error.code === 'ETIMEDOUT') {
          errorMessage = 'Connection timed out to Claude API server'
          statusCode = 504
        }

        if (!responseStream.headersSent) {
          const existingConnection = responseStream.getHeader
            ? responseStream.getHeader('Connection')
            : null
          responseStream.writeHead(statusCode, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: existingConnection || 'keep-alive'
          })
        }

        if (isStreamWritable(responseStream)) {
          // 发送 SSE 错误事件
          responseStream.write('event: error\n')
          responseStream.write(
            `data: ${JSON.stringify({
              error: errorMessage,
              code: error.code,
              timestamp: new Date().toISOString()
            })}\n\n`
          )
          responseStream.end()
        }
        // 🧹 清理 bodyStore
        if (requestOptions.bodyStoreId) {
          this.bodyStore.delete(requestOptions.bodyStoreId)
        }
        reject(error)
      })

      req.on('timeout', async () => {
        req.destroy()
        logger.error(`❌ Claude stream request timeout | Account: ${account?.name || accountId}`)

        if (!responseStream.headersSent) {
          const existingConnection = responseStream.getHeader
            ? responseStream.getHeader('Connection')
            : null
          responseStream.writeHead(504, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: existingConnection || 'keep-alive'
          })
        }
        if (isStreamWritable(responseStream)) {
          // 发送 SSE 错误事件
          responseStream.write('event: error\n')
          responseStream.write(
            `data: ${JSON.stringify({
              error: 'Request timeout',
              code: 'TIMEOUT',
              timestamp: new Date().toISOString()
            })}\n\n`
          )
          responseStream.end()
        }
        // 🧹 清理 bodyStore
        if (requestOptions.bodyStoreId) {
          this.bodyStore.delete(requestOptions.bodyStoreId)
        }
        reject(new Error('Request timeout'))
      })

      // 处理客户端断开连接（命名 handler，递归重试前需移除以避免监听器堆积）
      const onResponseStreamClose = () => {
        logger.debug('🔌 Client disconnected, cleaning up stream')
        if (!req.destroyed) {
          req.destroy(new Error('Client disconnected'))
        }
      }
      responseStream.on('close', onResponseStreamClose)

      // 写入请求体
      req.write(bodyString)
      // 🧹 内存优化：立即清空 bodyString 引用，避免闭包捕获
      bodyString = null
      req.end()
    })
  }

  _decodeUpstreamErrorBody(chunks, headers) {
    try {
      const raw = Buffer.isBuffer(chunks) ? chunks : Buffer.concat(chunks || [])
      if (!raw || raw.length === 0) {
        return ''
      }
      const zlib = require('zlib')
      const enc = String(
        (headers && (headers['content-encoding'] || headers['Content-Encoding'])) || ''
      ).toLowerCase()
      let out = raw
      if (enc.includes('gzip')) {
        out = zlib.gunzipSync(raw)
      } else if (enc.includes('br')) {
        out = zlib.brotliDecompressSync(raw)
      } else if (enc.includes('deflate')) {
        out = zlib.inflateSync(raw)
      } else if (enc.includes('zstd') && typeof zlib.zstdDecompressSync === 'function') {
        out = zlib.zstdDecompressSync(raw)
      } else if (raw[0] === 0x1f && raw[1] === 0x8b) {
        out = zlib.gunzipSync(raw)
      }
      return out.toString('utf8')
    } catch (e) {
      try {
        const raw = Buffer.isBuffer(chunks) ? chunks : Buffer.concat(chunks || [])
        return raw.toString('utf8')
      } catch (e2) {
        return ''
      }
    }
  }

  // 🛠️ 统一的错误处理方法
  async _handleServerError(
    accountId,
    statusCode,
    sessionHash = null,
    context = '',
    accountType = 'claude-official'
  ) {
    try {
      await claudeAccountService.recordServerError(accountId, statusCode)
      const errorCount = await claudeAccountService.getServerErrorCount(accountId)

      // 根据错误类型设置不同的阈值和日志前缀
      const isTimeout = statusCode === 504
      const threshold = 3 // 统一使用3次阈值
      const prefix = context ? `${context} ` : ''

      logger.warn(
        `⏱️ ${prefix}${isTimeout ? 'Timeout' : 'Server'} error for account ${accountId}, error count: ${errorCount}/${threshold}`
      )

      // 标记账户为临时不可用（TTL 由 upstreamError 配置决定）
      try {
        await unifiedClaudeScheduler.markAccountTemporarilyUnavailable(
          accountId,
          accountType,
          sessionHash,
          null,
          statusCode
        )
      } catch (markError) {
        logger.error(`❌ Failed to mark account temporarily unavailable: ${accountId}`, markError)
      }

      if (errorCount > threshold) {
        const errorTypeLabel = isTimeout ? 'timeout' : '5xx'
        // ⚠️ 只记录5xx/504告警，不再自动停止调度，避免上游抖动导致误停
        logger.error(
          `❌ ${prefix}Account ${accountId} exceeded ${errorTypeLabel} error threshold (${errorCount} errors), please investigate upstream stability`
        )
      }
    } catch (handlingError) {
      logger.error(`❌ Failed to handle ${context} server error:`, handlingError)
    }
  }

  // 🔄 重试逻辑
  async _retryRequest(requestFunc, maxRetries = 3) {
    let lastError

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await requestFunc()
      } catch (error) {
        lastError = error

        if (i < maxRetries - 1) {
          const delay = Math.pow(2, i) * 1000 // 指数退避
          logger.warn(`⏳ Retry ${i + 1}/${maxRetries} in ${delay}ms: ${error.message}`)
          await new Promise((resolve) => setTimeout(resolve, delay))
        }
      }
    }

    throw lastError
  }

  // 🔐 记录401未授权错误
  async recordUnauthorizedError(accountId) {
    try {
      const key = `claude_account:${accountId}:401_errors`

      // 增加错误计数，设置5分钟过期时间
      await redis.client.incr(key)
      await redis.client.expire(key, 300) // 5分钟

      logger.info(`📝 Recorded 401 error for account ${accountId}`)
    } catch (error) {
      logger.error(`❌ Failed to record 401 error for account ${accountId}:`, error)
    }
  }

  // 🔍 获取401错误计数
  async getUnauthorizedErrorCount(accountId) {
    try {
      const key = `claude_account:${accountId}:401_errors`

      const count = await redis.client.get(key)
      return parseInt(count) || 0
    } catch (error) {
      logger.error(`❌ Failed to get 401 error count for account ${accountId}:`, error)
      return 0
    }
  }

  // 🧹 清除401错误计数
  async clearUnauthorizedErrors(accountId) {
    try {
      const key = `claude_account:${accountId}:401_errors`

      await redis.client.del(key)
      logger.info(`✅ Cleared 401 error count for account ${accountId}`)
    } catch (error) {
      logger.error(`❌ Failed to clear 401 errors for account ${accountId}:`, error)
    }
  }

  // 🔧 动态捕获并获取统一的 User-Agent
  async captureAndGetUnifiedUserAgent(clientHeaders, account) {
    if (account.useUnifiedUserAgent !== 'true') {
      return null
    }

    const CACHE_KEY = 'claude_code_user_agent:daily'
    const TTL = 90000 // 25小时

    // ⚠️ 重要：这里通过正则表达式判断是否为 Claude Code 客户端
    // 如果未来 Claude Code 的 User-Agent 格式发生变化，需要更新这个正则表达式
    // 当前已知格式：claude-cli/1.0.102 (external, cli)
    const CLAUDE_CODE_UA_PATTERN = /^claude-cli\/[\d.]+\s+\(/i

    const clientUA = clientHeaders?.['user-agent'] || clientHeaders?.['User-Agent']
    let cachedUA = await redis.client.get(CACHE_KEY)

    if (clientUA && CLAUDE_CODE_UA_PATTERN.test(clientUA)) {
      if (!cachedUA) {
        // 没有缓存，直接存储
        await redis.client.setex(CACHE_KEY, TTL, clientUA)
        logger.info(`📱 Captured unified Claude Code User-Agent: ${clientUA}`)
        cachedUA = clientUA
      } else {
        // 有缓存，比较版本号，保存更新的版本
        const shouldUpdate = this.compareClaudeCodeVersions(clientUA, cachedUA)
        if (shouldUpdate) {
          await redis.client.setex(CACHE_KEY, TTL, clientUA)
          logger.info(`🔄 Updated to newer Claude Code User-Agent: ${clientUA} (was: ${cachedUA})`)
          cachedUA = clientUA
        } else {
          // 当前版本不比缓存版本新，仅刷新TTL
          await redis.client.expire(CACHE_KEY, TTL)
        }
      }
    }

    return cachedUA // 没有缓存返回 null
  }

  // 🔄 比较Claude Code版本号，判断是否需要更新
  // 返回 true 表示 newUA 版本更新，需要更新缓存
  compareClaudeCodeVersions(newUA, cachedUA) {
    try {
      // 提取版本号：claude-cli/1.0.102 (external, cli) -> 1.0.102
      // 支持多段版本号格式，如 1.0.102、2.1.0.beta1 等
      const newVersionMatch = newUA.match(/claude-cli\/([\d.]+(?:[a-zA-Z0-9-]*)?)/i)
      const cachedVersionMatch = cachedUA.match(/claude-cli\/([\d.]+(?:[a-zA-Z0-9-]*)?)/i)

      if (!newVersionMatch || !cachedVersionMatch) {
        // 无法解析版本号，优先使用新的
        logger.warn(`⚠️ Unable to parse Claude Code versions: new=${newUA}, cached=${cachedUA}`)
        return true
      }

      const newVersion = newVersionMatch[1]
      const cachedVersion = cachedVersionMatch[1]

      // 比较版本号 (semantic version)
      const compareResult = this.compareSemanticVersions(newVersion, cachedVersion)

      logger.debug(`🔍 Version comparison: ${newVersion} vs ${cachedVersion} = ${compareResult}`)

      return compareResult > 0 // 新版本更大则返回 true
    } catch (error) {
      logger.warn(`⚠️ Error comparing Claude Code versions, defaulting to update: ${error.message}`)
      return true // 出错时优先使用新的
    }
  }

  // 🔢 比较版本号
  // 返回：1 表示 v1 > v2，-1 表示 v1 < v2，0 表示相等
  compareSemanticVersions(version1, version2) {
    // 将版本号字符串按"."分割成数字数组
    const arr1 = version1.split('.')
    const arr2 = version2.split('.')

    // 获取两个版本号数组中的最大长度
    const maxLength = Math.max(arr1.length, arr2.length)

    // 循环遍历，逐段比较版本号
    for (let i = 0; i < maxLength; i++) {
      // 如果某个版本号的某一段不存在，则视为0
      const num1 = parseInt(arr1[i] || 0, 10)
      const num2 = parseInt(arr2[i] || 0, 10)

      if (num1 > num2) {
        return 1 // version1 大于 version2
      }
      if (num1 < num2) {
        return -1 // version1 小于 version2
      }
    }

    return 0 // 两个版本号相等
  }

  // 🧪 创建测试用的流转换器，将 Claude API SSE 格式转换为前端期望的格式
  _createTestStreamTransformer() {
    let testStartSent = false

    return (rawData) => {
      const lines = rawData.split('\n')
      const outputLines = []

      for (const line of lines) {
        if (!line.startsWith('data: ')) {
          // 保留空行用于 SSE 分隔
          if (line.trim() === '') {
            outputLines.push('')
          }
          continue
        }

        const jsonStr = line.substring(6).trim()
        if (!jsonStr || jsonStr === '[DONE]') {
          continue
        }

        try {
          const data = JSON.parse(jsonStr)

          // 发送 test_start 事件（只在第一次 message_start 时发送）
          if (data.type === 'message_start' && !testStartSent) {
            testStartSent = true
            outputLines.push(`data: ${JSON.stringify({ type: 'test_start' })}`)
            outputLines.push('')
          }

          // 转换 content_block_delta 为 content
          if (data.type === 'content_block_delta' && data.delta && data.delta.text) {
            outputLines.push(`data: ${JSON.stringify({ type: 'content', text: data.delta.text })}`)
            outputLines.push('')
          }

          // 转换 message_stop 为 test_complete
          if (data.type === 'message_stop') {
            outputLines.push(`data: ${JSON.stringify({ type: 'test_complete', success: true })}`)
            outputLines.push('')
          }

          // 处理错误事件
          if (data.type === 'error') {
            const errorMsg = data.error?.message || data.message || '未知错误'
            outputLines.push(`data: ${JSON.stringify({ type: 'error', error: errorMsg })}`)
            outputLines.push('')
          }
        } catch {
          // 忽略解析错误
        }
      }

      return outputLines.length > 0 ? outputLines.join('\n') : null
    }
  }

  // 🔧 准备测试请求的公共逻辑（供 testAccountConnection 和 testAccountConnectionSync 共用）
  async _prepareAccountForTest(accountId) {
    // 获取账户信息
    const account = await claudeAccountService.getAccount(accountId)
    if (!account) {
      throw new Error('Account not found')
    }

    // 获取有效的访问token
    const accessToken = await claudeAccountService.getValidAccessToken(accountId)
    if (!accessToken) {
      throw new Error('Failed to get valid access token')
    }

    // 获取代理配置
    const proxyAgent = await this._getProxyAgent(accountId)

    return { account, accessToken, proxyAgent }
  }

  // 🧪 测试账号连接（供Admin API使用，直接复用 _makeClaudeStreamRequestWithUsageCapture）
  async testAccountConnection(accountId, responseStream, model = 'claude-sonnet-4-5-20250929') {
    const testRequestBody = createClaudeTestPayload(model, { stream: true })

    try {
      const { account, accessToken, proxyAgent } = await this._prepareAccountForTest(accountId)

      logger.info(`🧪 Testing Claude account connection: ${account.name} (${accountId})`)

      // 设置响应头
      if (!responseStream.headersSent) {
        const existingConnection = responseStream.getHeader
          ? responseStream.getHeader('Connection')
          : null
        responseStream.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: existingConnection || 'keep-alive',
          'X-Accel-Buffering': 'no'
        })
      }

      // 创建流转换器，将 Claude API 格式转换为前端测试页面期望的格式
      const streamTransformer = this._createTestStreamTransformer()

      // 直接复用现有的流式请求方法
      await this._makeClaudeStreamRequestWithUsageCapture(
        testRequestBody,
        accessToken,
        proxyAgent,
        {}, // clientHeaders - 测试不需要客户端headers
        responseStream,
        null, // usageCallback - 测试不需要统计
        accountId,
        'claude-official', // accountType
        null, // sessionHash - 测试不需要会话
        streamTransformer, // 使用转换器将 Claude API 格式转为前端期望格式
        {}, // requestOptions
        false // isDedicatedOfficialAccount
      )

      logger.info(`✅ Test request completed for account: ${account.name}`)
    } catch (error) {
      logger.error(`❌ Test account connection failed:`, error)
      // 发送错误事件给前端
      if (isStreamWritable(responseStream)) {
        try {
          const errorMsg = error.message || '测试失败'
          responseStream.write(`data: ${JSON.stringify({ type: 'error', error: errorMsg })}\n\n`)
        } catch {
          // 忽略写入错误
        }
      }
      throw error
    }
  }

  // 🧪 非流式测试账号连接（供定时任务使用）
  // 复用流式请求方法，收集结果后返回
  async testAccountConnectionSync(accountId, model = 'claude-sonnet-4-5-20250929') {
    const testRequestBody = createClaudeTestPayload(model, { stream: true })
    const startTime = Date.now()

    try {
      // 使用公共方法准备测试所需的账户信息、token 和代理
      const { account, accessToken, proxyAgent } = await this._prepareAccountForTest(accountId)

      logger.info(`🧪 Testing Claude account connection (sync): ${account.name} (${accountId})`)

      // 创建一个收集器来捕获流式响应
      let responseText = ''
      let capturedUsage = null
      let capturedModel = model
      let hasError = false
      let errorMessage = ''

      // 创建模拟的响应流对象
      const mockResponseStream = {
        headersSent: true, // 跳过设置响应头
        write: (data) => {
          // 解析 SSE 数据
          if (typeof data === 'string' && data.startsWith('data: ')) {
            try {
              const jsonStr = data.replace('data: ', '').trim()
              if (jsonStr && jsonStr !== '[DONE]') {
                const parsed = JSON.parse(jsonStr)
                // 提取文本内容
                if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                  responseText += parsed.delta.text
                }
                // 提取 usage 信息
                if (parsed.type === 'message_delta' && parsed.usage) {
                  capturedUsage = parsed.usage
                }
                // 提取模型信息
                if (parsed.type === 'message_start' && parsed.message?.model) {
                  capturedModel = parsed.message.model
                }
                // 检测错误
                if (parsed.type === 'error') {
                  hasError = true
                  errorMessage = parsed.error?.message || 'Unknown error'
                }
              }
            } catch {
              // 忽略解析错误
            }
          }
          return true
        },
        end: () => {},
        on: () => {},
        once: () => {},
        emit: () => {},
        writable: true
      }

      // 复用流式请求方法
      await this._makeClaudeStreamRequestWithUsageCapture(
        testRequestBody,
        accessToken,
        proxyAgent,
        {}, // clientHeaders - 测试不需要客户端headers
        mockResponseStream,
        null, // usageCallback - 测试不需要统计
        accountId,
        'claude-official', // accountType
        null, // sessionHash - 测试不需要会话
        null, // streamTransformer - 不需要转换，直接解析原始格式
        {}, // requestOptions
        false // isDedicatedOfficialAccount
      )

      const latencyMs = Date.now() - startTime

      if (hasError) {
        logger.warn(`⚠️ Test completed with error for account: ${account.name} - ${errorMessage}`)
        return {
          success: false,
          error: errorMessage,
          latencyMs,
          timestamp: new Date().toISOString()
        }
      }

      logger.info(`✅ Test completed for account: ${account.name} (${latencyMs}ms)`)

      return {
        success: true,
        message: responseText.substring(0, 200), // 截取前200字符
        latencyMs,
        model: capturedModel,
        usage: capturedUsage,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      const latencyMs = Date.now() - startTime
      logger.error(`❌ Test account connection (sync) failed:`, error.message)

      // 提取错误详情
      let errorMessage = error.message
      if (error.response) {
        errorMessage =
          error.response.data?.error?.message || error.response.statusText || error.message
      }

      return {
        success: false,
        error: errorMessage,
        statusCode: error.response?.status,
        latencyMs,
        timestamp: new Date().toISOString()
      }
    }
  }

  // 🎯 健康检查
  async healthCheck() {
    try {
      const accounts = await claudeAccountService.getAllAccounts()
      const activeAccounts = accounts.filter((acc) => acc.isActive && acc.status === 'active')

      return {
        healthy: activeAccounts.length > 0,
        activeAccounts: activeAccounts.length,
        totalAccounts: accounts.length,
        timestamp: new Date().toISOString()
      }
    } catch (error) {
      logger.error('❌ Health check failed:', error)
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      }
    }
  }

  // 🔄 判断账户是否应该在 403 错误时进行重试
  // 仅 claude-official 类型账户（OAuth 或 Setup Token 授权）需要重试
  _shouldRetryOn403(accountType) {
    return accountType === 'claude-official'
  }

  // ⏱️ 等待指定毫秒数
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

module.exports = new ClaudeRelayService()
module.exports.CLAUDE_CODE_EMULATION_VERSION = CLAUDE_CODE_EMULATION_VERSION
