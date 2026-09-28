/**
 * Claude Code emulation 版本一致性回归测试
 *
 * 验证目标（对齐真实 CLI v2.1.280）：
 *   1. claudeCodeHeadersService.defaultHeaders 的 user-agent 声明版本 = 2.1.280
 *   2. claudeRelayService 导出的 CLAUDE_CODE_EMULATION_VERSION = 2.1.280，
 *      且与 defaultHeaders 的 UA 版本严格一致（避免 x-stainless / UA / cc_version 错位）
 *   3. _injectDynamicBillingHeader 注入的 system[0] 形如
 *      `x-anthropic-billing-header: cc_version=2.1.280.<3位hex>; cc_entrypoint=cli;`
 *      且不带 cch= 字段
 *   4. cc_version 指纹后缀随首条 user 文本变化、同文本下稳定
 */

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  api: jest.fn()
}))

jest.mock('../config/config', () => ({
  claude: {
    apiVersion: '2023-06-01',
    betaHeader:
      'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    systemPrompt: ''
  },
  proxy: {},
  requestTimeout: 600000
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({}))
jest.mock('../src/utils/sessionHelper', () => ({}))
jest.mock('../src/models/redis', () => ({
  getClient: jest.fn(),
  scanKeys: jest.fn()
}))
jest.mock('../src/services/requestIdentityService', () => ({
  transform: jest.fn(({ body, headers }) => ({ body, headers }))
}))
jest.mock('../src/utils/testPayloadHelper', () => ({
  createClaudeTestPayload: jest.fn()
}))
jest.mock('../src/services/userMessageQueueService', () => ({}))
jest.mock('../src/utils/streamHelper', () => ({
  isStreamWritable: jest.fn(() => true)
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({
  parseRetryAfter: jest.fn()
}))
jest.mock('../src/utils/performanceOptimizer', () => ({
  getHttpsAgentForStream: jest.fn(),
  getHttpsAgentForNonStream: jest.fn(),
  getPricingData: jest.fn(() => null),
  getCachedConfig: jest.fn(() => null),
  setCachedConfig: jest.fn(),
  deleteCachedConfig: jest.fn()
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')
const claudeCodeHeadersService = require('../src/services/claudeCodeHeadersService')
const claudeCodeProfile = require('../src/config/claudeCodeProfile')
const metadataUserIdHelper = require('../src/utils/metadataUserIdHelper')

const EXPECTED_VERSION = '2.1.280'
// 2.1.280 抓包形态（cch 按用户要求不传递）：
//   cc_version=<ver>.<3hex>; cc_entrypoint=<ep>; cc_prompt_id=<uuid>; cc_turn_origin=<cli|sdk>;
const BILLING_RE =
  /^x-anthropic-billing-header: cc_version=(\d+\.\d+\.\d+)\.([0-9a-f]{3}); cc_entrypoint=([a-z-]+); cc_prompt_id=([0-9a-f-]{36}); cc_turn_origin=(cli|sdk);$/

const buildBody = (firstUserText) => ({
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: [{ type: 'text', text: firstUserText }] }],
  system: [{ type: 'text', text: 'existing system block' }]
})

describe('Claude Code emulation version (v2.1.280)', () => {
  it('defaultHeaders user-agent declares claude-cli/2.1.280', () => {
    const ua = claudeCodeHeadersService.defaultHeaders['user-agent']
    expect(ua).toBe(`claude-cli/${EXPECTED_VERSION} (external, cli)`)
    expect(claudeCodeHeadersService.extractVersionFromUserAgent(ua)).toBe(EXPECTED_VERSION)
  })

  it('relay service emulation version equals headers service declared version', () => {
    expect(claudeRelayService.CLAUDE_CODE_EMULATION_VERSION).toBe(EXPECTED_VERSION)
    const declared = claudeCodeHeadersService.extractVersionFromUserAgent(
      claudeCodeHeadersService.defaultHeaders['user-agent']
    )
    expect(
      claudeCodeHeadersService.compareVersions(
        claudeRelayService.CLAUDE_CODE_EMULATION_VERSION,
        declared
      )
    ).toBe(0)
  })

  it('injects a 2.1.280 dynamic billing header as system[0] without cch field', () => {
    const body = buildBody('hello from a regression test payload')

    claudeRelayService._injectDynamicBillingHeader(body)

    expect(Array.isArray(body.system)).toBe(true)
    expect(body.system).toHaveLength(2)
    expect(body.system[0].type).toBe('text')
    const match = body.system[0].text.match(BILLING_RE)
    expect(match).not.toBeNull()
    expect(match[1]).toBe(EXPECTED_VERSION)
    expect(match[3]).toBe('cli')
    expect(match[5]).toBe('cli')
    expect(body.system[0].text).not.toContain('cch=')
    // 首轮不应出现 cc_prev_req（链式引用由 _applyTurnChaining 在后续轮次补）
    expect(body.system[0].text).not.toContain('cc_prev_req=')
    expect(body.system[1]).toEqual({ type: 'text', text: 'existing system block' })
  })

  it('follows the declared entrypoint in UA / cc_entrypoint / cc_turn_origin', () => {
    const body = buildBody('entrypoint alignment payload')

    claudeRelayService._injectDynamicBillingHeader(body, { entrypoint: 'sdk-cli' })

    expect(body.system[0].text).toContain('cc_entrypoint=sdk-cli;')
    expect(body.system[0].text).toContain('cc_turn_origin=sdk;')
    expect(claudeCodeProfile.buildUserAgent('sdk-cli')).toBe(
      `claude-cli/${EXPECTED_VERSION} (external, sdk-cli)`
    )
  })

  it('wraps a string system prompt with the billing header first', () => {
    const body = { messages: [{ role: 'user', content: 'plain string content' }], system: 'sys' }

    claudeRelayService._injectDynamicBillingHeader(body)

    expect(body.system).toHaveLength(2)
    expect(body.system[0].text).toMatch(BILLING_RE)
    expect(body.system[0].text).toContain(`cc_version=${EXPECTED_VERSION}.`)
    expect(body.system[1]).toEqual({ type: 'text', text: 'sys' })
  })

  it('cc_version fingerprint is stable per first user text and differs across texts', () => {
    const a1 = claudeRelayService._computeCcFingerprint(
      buildBody('alpha message body text'),
      EXPECTED_VERSION
    )
    const a2 = claudeRelayService._computeCcFingerprint(
      buildBody('alpha message body text'),
      EXPECTED_VERSION
    )
    const b = claudeRelayService._computeCcFingerprint(
      buildBody('bravo different content here'),
      EXPECTED_VERSION
    )

    expect(a1).toEqual(a2)
    expect(a1.fp).toMatch(/^[0-9a-f]{3}$/)
    expect(a1.fp).not.toBe(b.fp)
    // 版本参与哈希：同文本换版本应产生不同指纹
    const prev = claudeRelayService._computeCcFingerprint(
      buildBody('alpha message body text'),
      '2.1.259'
    )
    expect(prev.fp === a1.fp && prev.cch === a1.cch).toBe(false)
  })

  // ——— 以下为「版本能力单一事实来源 + 抓包字段对齐」的回归断言 ———

  it('anthropic-beta 列表与 2.1.280 抓包一致（16 个、顺序固定）', () => {
    const profile = claudeCodeProfile.getProfile()
    expect(profile.version).toBe(EXPECTED_VERSION)
    expect(profile.betas).toHaveLength(16)
    expect(profile.betas[0]).toBe('claude-code-20250219')
    expect(profile.betas).toContain('cache-diagnosis-2026-04-07')
    expect(profile.betas).toContain('extended-cache-ttl-2025-04-11')

    // 🔒 禁止透传：beta 恒等于档案集合，与客户端声明无关
    expect(claudeRelayService._getBetaHeader()).toBe(profile.betas.join(','))
  })

  it('缺失的固定头已补齐（dispatch-id / request-class / 每请求 id）', () => {
    const profile = claudeCodeProfile.getProfile()
    expect(profile.staticHeaders['anthropic-dispatch-id']).toBe('v2d')
    expect(profile.staticHeaders['x-claude-code-request-class']).toBe('main')
  })

  it('body 默认值对齐：不发 temperature、thinking 带 display、注入 output_config', () => {
    const body = buildBody('body defaults payload')
    body.temperature = 0.7

    claudeRelayService._applyNonRealClaudeCodeDefaults(body)

    expect(body.temperature).toBeUndefined()
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
    expect(body.output_config).toEqual({ effort: 'medium' })
    expect(body.context_management).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }]
    })
    expect(body.max_tokens).toBe(128000)
  })

  it('system 块带 ttl/scope，且不含自造的固定文案', () => {
    const blocks = claudeRelayService._buildClaudeCodeSystem(null)

    expect(blocks).toHaveLength(2)
    expect(blocks[0].text).toBe(claudeCodeProfile.getProfile().system.identity)
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral', ttl: '1h', scope: 'global' })
    expect(blocks[1].text).toBe(claudeCodeProfile.getProfile().system.genericInstructions)
    // 自造的 expansion 常量必须已从服务上移除（它是跨部署共享的固定指纹）
    expect(claudeRelayService.claudeCodeSystemPromptExpansion).toBeUndefined()
  })

  it('客户端 system 迁入 messages 后不再使用自造前缀与固定应答句', () => {
    const body = {
      system: 'third party system instructions',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    }

    claudeRelayService._moveSystemToMessages(body)

    const flattened = JSON.stringify(body.messages)
    expect(flattened).not.toContain('[System Instructions]')
    expect(flattened).not.toContain('Understood. I will follow these instructions.')
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content[0].text).toBe('third party system instructions')
  })

  it('emulation 请求头：UA/会话 id 与 body 自洽，且带上版本声明头', async () => {
    const account = { id: 'acct-test', useUnifiedUserAgent: 'false' }
    const raw = buildBody('header assembly payload for emulation')
    const processed = claudeRelayService._processRequestBody(raw, account, false, {
      entrypoint: 'cli'
    })

    const prepared = await claudeRelayService._prepareRequestHeadersAndPayload(
      processed,
      {},
      'acct-test',
      'sk-ant-oat0-test',
      {
        account,
        requestOptions: { isRealClaudeCodeRequest: false },
        isStream: true,
        sessionHash: null
      }
    )

    const { headers } = prepared
    const bodySessionId = metadataUserIdHelper.extractSessionId(processed.metadata.user_id)

    expect(headers['User-Agent']).toBe(`claude-cli/${EXPECTED_VERSION} (external, cli)`)
    expect(headers['anthropic-dispatch-id']).toBe('v2d')
    expect(headers['x-claude-code-request-class']).toBe('main')
    expect(headers['x-client-request-id']).toMatch(/^[0-9a-f-]{36}$/)
    // header 与 body 必须是同一个会话 id（真实 CLI 三者一致）
    expect(headers['x-claude-code-session-id']).toBe(bodySessionId)
    expect(headers['anthropic-beta']).toBe(claudeCodeProfile.getProfile().betas.join(','))
  })

  it('统一化：真 Claude Code 客户端请求同样被归一化（禁止透传）', () => {
    const account = { id: 'acct-realcc', useUnifiedUserAgent: 'false' }
    const profile = claudeCodeProfile.getProfile()
    const raw = {
      model: 'claude-opus-5-5',
      max_tokens: 128000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'real cc style payload' }] }],
      system: [
        { type: 'text', text: profile.system.identity },
        {
          type: 'text',
          text: 'GENUINE CLI MAIN PROMPT',
          cache_control: { type: 'ephemeral', ttl: '1h' }
        }
      ],
      tools: [{ name: 'Bash', description: 'Genuine Bash tool description.', input_schema: {} }]
    }

    const processed = claudeRelayService._processRequestBody(raw, account, true, {
      entrypoint: 'cli'
    })

    // 真 CC 自带的 system 被迁入 messages，system 被替换为中转合成形态
    expect(processed.system[0].text).toMatch(/^x-anthropic-billing-header: cc_version=2\.1\.280\./)
    expect(processed.system[1].text).toBe(profile.system.identity)
    expect(JSON.stringify(processed.messages)).toContain('GENUINE CLI MAIN PROMPT')
    expect(JSON.stringify(processed.system)).not.toContain('GENUINE CLI MAIN PROMPT')
    // 真 CC 自带的 metadata 同样被统一覆盖
    expect(metadataUserIdHelper.isValid(processed.metadata.user_id)).toBe(true)
    // 工具名改写只针对 sessions_ 前缀，真 CC 的工具名保持原样
    expect(processed.tools[0].name).toBe('Bash')
  })
})
