/**
 * Claude Code 客户端能力档案 —— 「版本 → 请求形态」的唯一事实来源。
 *
 * 基线：Claude Code 2.1.280 抓包（claude -p / sdk-cli 入口，mitmproxy 全量抓包）。
 * 目的：把 UA、anthropic-beta、指纹 header、body 默认值、billing header 形态
 *       从散落的硬编码收敛到一处，避免「UA 声明 2.1.280、body 却按旧版本对齐」的版本错位。
 *
 * 使用约定：
 *   - 新增/升级版本时只改本文件，其它模块一律通过 getProfile() 取值
 *   - 涉及「上游是否接受」的字段（diagnostics / cache ttl 等）都做成显式开关，
 *     便于真机验证后用一行改动回退
 */

const DEFAULT_ENTRYPOINT = 'cli'

const PROFILES = {
  '2.1.280': {
    version: '2.1.280',

    // anthropic-beta：顺序与真实 CLI 抓包一致（逗号分隔、无空格）
    betas: [
      'claude-code-20250219',
      'oauth-2025-04-20',
      'interleaved-thinking-2025-05-14',
      'thinking-token-count-2026-05-13',
      'context-management-2025-06-27',
      'prompt-caching-scope-2026-01-05',
      'mid-conversation-system-2026-04-07',
      'per-turn-control-2026-07-01',
      'mid-conversation-tool-changes-2026-07-01',
      'advisor-tool-2026-03-01',
      'advanced-tool-use-2025-11-20',
      'mid-conversation-system-clear-at-2026-08-21',
      'effort-2025-11-24',
      'thinking-binding-controls-2026-08-01',
      'extended-cache-ttl-2025-04-11',
      'cache-diagnosis-2026-04-07'
    ],

    // 与请求内容无关的固定 header
    staticHeaders: {
      'anthropic-dispatch-id': 'v2d',
      'x-claude-code-request-class': 'main'
    },

    body: {
      // 真实 CLI 顶层不发送 temperature
      stripClientTemperature: true,
      defaultMaxTokens: 128000,
      thinking: { type: 'adaptive', display: 'omitted' },
      outputConfig: { effort: 'medium' },
      contextManagement: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
      // diagnostics.previous_message_id：需要 cache-diagnosis-2026-04-07（已在上方 beta 列表中）
      diagnostics: true
    },

    system: {
      identity: "You are Claude Code, Anthropic's official CLI for Claude.",
      // 通用说明块：真实 CLI 该块为长文本（约 1.6KB），其确切内容未抓取到明文，
      // 此处使用中性文案，并允许通过 config.claude.emulationSystemPrompt 覆盖。
      // 注意：本块不承载任何自定义身份，避免成为固定指纹。
      genericInstructions:
        'You are an interactive CLI tool that helps users with software engineering tasks. ' +
        'Use the tools available to you to read, write, and edit files, run shell commands, ' +
        'search codebases, fetch web content, and delegate focused work to sub-agents. ' +
        'Prefer precise, minimal changes and verify your work before reporting it done. ' +
        'Explain your reasoning concisely and follow the instructions you are given.',
      cacheControl: { type: 'ephemeral', ttl: '1h', scope: 'global' }
    },

    billing: {
      // 用户明确要求：cch 不传递
      includeCch: false,
      includePromptId: true,
      includeTurnOrigin: true,
      includePrevReq: true
    },

    // 客户端原始 system 迁入 messages 时使用的形态：
    // true  = role:"system" 条目（与 2.1.280 抓包一致，需 mid-conversation-system beta）
    // false = 合并进首条 user 消息的 text block（兼容性更保守）
    clientSystemAsSystemMessage: true
  }
}

const DEFAULT_PROFILE_KEY = '2.1.280'
const DEFAULT_PROFILE = PROFILES[DEFAULT_PROFILE_KEY]

/**
 * 取指定版本的能力档案，未知版本回退到默认档案
 * @param {string} [version]
 */
function getProfile(version) {
  if (version && PROFILES[version]) {
    return PROFILES[version]
  }
  return DEFAULT_PROFILE
}

/**
 * 构造与声明版本一致的 User-Agent
 * @param {string} [entrypoint] - 如 cli / sdk-cli
 */
function buildUserAgent(entrypoint) {
  const ep =
    typeof entrypoint === 'string' && entrypoint.trim() ? entrypoint.trim() : DEFAULT_ENTRYPOINT
  return `claude-cli/${DEFAULT_PROFILE.version} (external, ${ep})`
}

/**
 * 从 User-Agent 中解析入口类型（括号内最后一段，如 "external, sdk-cli" → "sdk-cli"）
 * @param {string} userAgent
 * @returns {string|null}
 */
function extractEntrypoint(userAgent) {
  if (typeof userAgent !== 'string') {
    return null
  }
  const match = userAgent.match(/claude-cli\/[\d.]+[a-zA-Z0-9-]*\s*\(([^)]*)\)/i)
  if (!match) {
    return null
  }
  const parts = match[1]
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  // 形如 "external, sdk-cli" / "external, cli"：取最后一段入口标识
  const candidate = parts.length > 0 ? parts[parts.length - 1] : ''
  return candidate || null
}

/**
 * 入口对应的 cc_turn_origin 取值。
 * 抓包仅覆盖 sdk-cli → sdk；交互式 cli 的取值未抓取（文档 §7），按 cli 处理。
 * @param {string} entrypoint
 */
function turnOriginFor(entrypoint) {
  return entrypoint === 'sdk-cli' || entrypoint === 'sdk-ts' || entrypoint === 'sdk' ? 'sdk' : 'cli'
}

module.exports = {
  DEFAULT_PROFILE_KEY,
  DEFAULT_PROFILE,
  PROFILES,
  DEFAULT_ENTRYPOINT,
  getProfile,
  buildUserAgent,
  extractEntrypoint,
  turnOriginFor
}
