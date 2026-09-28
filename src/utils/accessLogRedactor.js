/**
 * 访问日志（requestLogger）专用的落盘前脱敏。
 *
 * 两类问题：
 * 1. 响应体原样落盘 —— 例如 POST /web/auth/login 返回的管理员会话 token、
 *    创建 API Key 时返回的明文 key，都会被完整写进 claude-relay-*.log。
 * 2. 请求体里的对话正文（messages / system / input ...）即便截断到 80 字符，
 *    短消息仍会原样落盘，用户在对话里贴的密码、主机凭据因此进入日志。
 *
 * 原则：访问日志只保留排障需要的「结构 + 长度」，不保留对话内容和任何凭据。
 * 这里只作用于访问日志，不影响 requestDetailHelper（请求详情功能）的既有行为。
 */

const config = require('../../config/config')

// 访问日志中一律全量遮蔽的字段名（仅对字符串值生效，数字类统计如 inputTokens 保持原样）
const SECRET_KEY_PATTERN =
  /(password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|session[_-]?(id|key)|signature)/i

// 查询串中需要遮蔽的参数名
const SECRET_QUERY_PARAM_PATTERN =
  /^(key|api[_-]?key|token|access[_-]?token|auth|authorization|secret|password|pwd|code|state)$/i

// 对话正文所在的顶层字段：其中的字符串一律只保留长度
const CONVERSATION_KEYS = new Set([
  'messages',
  'system',
  'input',
  'contents',
  'prompt',
  'instructions',
  'systemInstruction',
  'system_instruction'
])

// 对话结构里允许保留原值的短字段（纯结构信息，便于排障）
const STRUCTURAL_KEYS = new Set(['role', 'type', 'name', 'id', 'tool_use_id', 'media_type'])
const STRUCTURAL_MAX_CHARS = 64

const MAX_DEPTH = 8
const MAX_ARRAY_ITEMS = 24

function getApiKeyPrefix() {
  return (
    (config && config.security && config.security.apiKeyPrefix) ||
    process.env.API_KEY_PREFIX ||
    'cr_'
  )
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 按值识别的凭据形态（不论字段名）
function looksLikeCredential(value) {
  if (typeof value !== 'string' || value.length < 20) {
    return false
  }
  const prefix = escapeRegExp(getApiKeyPrefix())
  const patterns = [
    new RegExp(`^${prefix}[A-Za-z0-9_-]{16,}$`),
    /^sk-[A-Za-z0-9_-]{16,}$/, // OpenAI / Anthropic 官方 key
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/, // JWT
    /^Bearer\s+\S+/i
  ]
  return patterns.some((re) => re.test(value))
}

function redactedLength(value) {
  return `[redacted ${value.length} chars]`
}

/**
 * 递归遮蔽凭据：字段名命中 SECRET_KEY_PATTERN 的字符串值、或值本身像凭据 → [REDACTED]
 */
function redactSecrets(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') {
    return looksLikeCredential(value) ? '[REDACTED]' : value
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (depth >= MAX_DEPTH) {
    return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]'
  }
  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1, seen))
  }

  const result = {}
  for (const [key, nested] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) && typeof nested === 'string') {
      result[key] = '[REDACTED]'
    } else {
      result[key] = redactSecrets(nested, depth + 1, seen)
    }
  }
  return result
}

/**
 * 把对话内容替换为「长度占位」，保留 role/type 等结构字段。
 * 在原始请求体上做（有数组/深度上限），保证后续截断预览里也不会出现正文。
 */
// 已脱敏的占位不再二次处理（保证幂等，重复清洗不会把长度改写成占位符自身的长度）
const PLACEHOLDER_PATTERN = /^\[(redacted \d+ chars|REDACTED)\]$/

function stripConversationValue(value, parentKey, depth, seen) {
  if (typeof value === 'string') {
    if (PLACEHOLDER_PATTERN.test(value)) {
      return value
    }
    if (STRUCTURAL_KEYS.has(parentKey) && value.length <= STRUCTURAL_MAX_CHARS) {
      return value
    }
    return redactedLength(value)
  }
  if (!value || typeof value !== 'object') {
    return value
  }
  if (depth >= MAX_DEPTH) {
    return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]'
  }
  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => stripConversationValue(item, parentKey, depth + 1, seen))
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`...[${value.length - MAX_ARRAY_ITEMS} more items]`)
    }
    return items
  }

  const result = {}
  for (const [key, nested] of Object.entries(value)) {
    result[key] = stripConversationValue(nested, key, depth + 1, seen)
  }
  return result
}

function stripConversationContent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body
  }
  let changed = false
  const result = {}
  for (const [key, nested] of Object.entries(body)) {
    if (CONVERSATION_KEYS.has(key) && nested !== null && nested !== undefined) {
      result[key] = stripConversationValue(nested, key, 0, new WeakSet())
      changed = true
    } else {
      result[key] = nested
    }
  }
  return changed ? result : body
}

/**
 * 查询串脱敏：key=xxx / token=xxx 等参数值遮蔽
 */
function redactQueryString(query) {
  if (typeof query !== 'string' || !query) {
    return query
  }
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq === -1) {
        return pair
      }
      let name = pair.slice(0, eq)
      try {
        name = decodeURIComponent(name)
      } catch (e) {
        // 保留原始参数名
      }
      return SECRET_QUERY_PARAM_PATTERN.test(name) ? `${pair.slice(0, eq)}=[REDACTED]` : pair
    })
    .join('&')
}

// 模型（非流式）响应里承载生成内容的字段
const RESPONSE_CONTENT_KEYS = new Set(['content', 'choices', 'candidates', 'output', 'output_text'])

function looksLikeModelResponse(body) {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    (body.type === 'message' || // Anthropic
      Array.isArray(body.choices) || // OpenAI chat
      Array.isArray(body.candidates) || // Gemini
      body.object === 'response') // OpenAI responses
  )
}

function stripModelResponseContent(body) {
  if (!looksLikeModelResponse(body)) {
    return body
  }
  const result = {}
  for (const [key, nested] of Object.entries(body)) {
    result[key] =
      RESPONSE_CONTENT_KEYS.has(key) && nested !== null && nested !== undefined
        ? stripConversationValue(nested, key, 0, new WeakSet())
        : nested
  }
  return result
}

/**
 * 响应体落盘前脱敏：模型生成内容只留长度、凭据遮蔽；其余不截断（保持既有「完整响应」日志行为）
 */
function buildLoggableResponseBody(body) {
  if (body === undefined || body === null) {
    return body
  }
  return redactSecrets(stripModelResponseContent(body))
}

module.exports = {
  stripConversationContent,
  redactSecrets,
  redactQueryString,
  buildLoggableResponseBody,
  looksLikeCredential
}
