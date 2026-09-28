/**
 * 统一的 CDN Headers 过滤列表
 *
 * 用于各服务在原有过滤逻辑基础上，额外移除 Cloudflare CDN 和代理相关的 headers
 * 避免触发上游 API（如 88code）的安全检查
 */

const claudeCodeProfile = require('../config/claudeCodeProfile')

// Cloudflare CDN headers（橙色云代理模式会添加这些）
const cdnHeaders = [
  'x-real-ip',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-accel-buffering',
  'cf-ray',
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-visitor',
  'cf-request-id',
  'cdn-loop',
  'true-client-ip'
]

/**
 * 为 OpenAI/Responses API 过滤 headers
 * 在原有 skipHeaders 基础上添加 CDN headers
 */
function filterForOpenAI(headers) {
  const skipHeaders = [
    'host',
    'content-length',
    'authorization',
    'x-api-key',
    'x-cr-api-key',
    'connection',
    'upgrade',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
    ...cdnHeaders // 添加 CDN headers
  ]

  const filtered = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!skipHeaders.includes(key.toLowerCase())) {
      filtered[key] = value
    }
  }
  return filtered
}

/**
 * 为 Claude/Anthropic API 过滤 headers
 * 使用白名单模式，只允许指定的 headers 通过
 * 同时注入 Claude Code CLI 特征 headers，使请求与 CLI 指纹一致
 */
function filterForClaude(headers, options = {}) {
  // 白名单模式：只允许以下 headers
  // 注意：移除了 'sec-fetch-mode'（浏览器专有，CLI 不发送）
  // 注意：移除了 'user-agent'（由 account.userAgent 或上层逻辑控制，避免透传客户端 UA 覆盖伪装）
  const allowedHeaders = [
    'accept',
    'x-stainless-retry-count',
    'x-stainless-timeout',
    'x-stainless-lang',
    'x-stainless-package-version',
    'x-stainless-os',
    'x-stainless-arch',
    'x-stainless-runtime',
    'x-stainless-runtime-version',
    'x-stainless-helper-method',
    'anthropic-dangerous-direct-browser-access',
    'anthropic-version',
    // 'x-app' — 不从客户端透传，下方强制注入 'cli'
    'anthropic-beta',
    'accept-language',
    // 注意：不透传 accept-encoding —— 由转发层统一设置为可解压的编码集合
    // （gzip/deflate/br/zstd，Node 22.15+/24 已内置 zstd，见 claudeRelayService 响应解压逻辑）
    'content-type',
    'connection'
  ]

  const filtered = {}
  Object.keys(headers || {}).forEach((key) => {
    const lowerKey = key.toLowerCase()
    if (allowedHeaders.includes(lowerKey)) {
      filtered[key] = headers[key]
    }
  })

  if (options.injectClaudeCodeHeaders === false) {
    return filtered
  }

  // === Claude Code CLI 指纹注入 ===
  // 1. 强制设置 x-app: cli（CLI 特有标识）
  filtered['x-app'] = 'cli'

  // 2. 注入 x-claude-code-session-id（CLI 每次会话生成一个 UUID）
  filtered['x-claude-code-session-id'] = require('crypto').randomUUID()

  // 3. 确保 anthropic-beta 包含完整的 Claude Code CLI beta flags
  //    单一事实来源：src/config/claudeCodeProfile.js（此前此处硬编码了 v2.1.143 的 6 个 flag，
  //    与 claudeRelayService 的列表不一致，已统一）
  const existingBeta = filtered['anthropic-beta'] || ''
  const claudeCodeBeta = 'claude-code-20250219'
  if (!existingBeta.includes(claudeCodeBeta)) {
    const betaFlags = [...claudeCodeProfile.getProfile().betas]
    if (existingBeta) {
      // 合并已有的 beta flags（去重）
      const existing = existingBeta.split(',').map((s) => s.trim())
      existing.forEach((f) => {
        if (f && !betaFlags.includes(f)) {
          betaFlags.push(f)
        }
      })
    }
    filtered['anthropic-beta'] = betaFlags.join(',')
  }

  return filtered
}

/**
 * 为 Gemini API 过滤 headers（如果需要转发客户端 headers 时使用）
 * 目前 Gemini 服务不转发客户端 headers，仅提供此方法备用
 */
function filterForGemini(headers) {
  const skipHeaders = [
    'host',
    'content-length',
    'authorization',
    'x-api-key',
    'connection',
    ...cdnHeaders // 添加 CDN headers
  ]

  const filtered = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!skipHeaders.includes(key.toLowerCase())) {
      filtered[key] = value
    }
  }
  return filtered
}

module.exports = {
  cdnHeaders,
  filterForOpenAI,
  filterForClaude,
  filterForGemini
}
