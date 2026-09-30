/**
 * Claude Code 客户端能力档案 —— 「版本 → 请求形态」的唯一事实来源。
 *
 * 基线：Claude Code 2.1.280 抓包（claude -p / sdk-cli 入口，mitmproxy 全量抓包）。
 * `claude-code-2.1.280-profile.json` 存放从抓包中提取并脱敏后的 system / tools 原始模板。
 */

const capturedProfile = require('./claude-code-2.1.280-profile.json')

const DEFAULT_ENTRYPOINT = 'sdk-cli'
const TOP_LEVEL_BODY_ORDER = [
  'model',
  'messages',
  'system',
  'tools',
  'metadata',
  'max_tokens',
  'thinking',
  'context_management',
  'output_config',
  'diagnostics',
  'stream'
]

const PROFILES = {
  '2.1.280': {
    version: '2.1.280',
    entrypoint: DEFAULT_ENTRYPOINT,
    apiVersion: '2023-06-01',
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
    staticHeaders: {
      'anthropic-dispatch-id': 'v2d',
      'x-claude-code-request-class': 'main'
    },
    body: {
      topLevelOrder: TOP_LEVEL_BODY_ORDER,
      stripClientTemperature: true,
      defaultMaxTokens: 128000,
      thinking: { type: 'adaptive', display: 'omitted' },
      outputConfig: { effort: 'medium' },
      contextManagement: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
      diagnostics: true
    },
    system: {
      identity: capturedProfile.identity.text,
      genericInstructions: capturedProfile.generic.text,
      mainInstructions: capturedProfile.main.text,
      genericCacheControl: capturedProfile.generic.cache_control,
      mainCacheControl: capturedProfile.main.cache_control,
      memoryDirectoryPlaceholder: '{{CLAUDE_PROJECT_MEMORY_DIR}}',
      environmentTemplate: capturedProfile.environment.text,
      environmentCacheControl: capturedProfile.environment.cache_control
    },
    tools: capturedProfile.tools,
    userPreludeBlocks: capturedProfile.userPreludeBlocks,
    billing: {
      // 用户明确要求：cch 不传递
      includeCch: false,
      includePromptId: true,
      includeTurnOrigin: true,
      includePrevReq: true
    },
    clientSystemAsSystemMessage: true
  }
}

const DEFAULT_PROFILE_KEY = '2.1.280'
const DEFAULT_PROFILE = PROFILES[DEFAULT_PROFILE_KEY]

function getProfile(version) {
  if (version && PROFILES[version]) {
    return PROFILES[version]
  }
  return DEFAULT_PROFILE
}

function buildUserAgent(entrypoint) {
  const ep =
    typeof entrypoint === 'string' && entrypoint.trim() ? entrypoint.trim() : DEFAULT_ENTRYPOINT
  return `claude-cli/${DEFAULT_PROFILE.version} (external, ${ep})`
}

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
    .map((part) => part.trim())
    .filter(Boolean)
  const candidate = parts.length > 0 ? parts[parts.length - 1] : ''
  return candidate || null
}

function turnOriginFor(entrypoint) {
  return entrypoint === 'sdk-cli' || entrypoint === 'sdk-ts' || entrypoint === 'sdk' ? 'sdk' : 'cli'
}

module.exports = {
  DEFAULT_PROFILE_KEY,
  DEFAULT_PROFILE,
  PROFILES,
  DEFAULT_ENTRYPOINT,
  TOP_LEVEL_BODY_ORDER,
  getProfile,
  buildUserAgent,
  extractEntrypoint,
  turnOriginFor
}
