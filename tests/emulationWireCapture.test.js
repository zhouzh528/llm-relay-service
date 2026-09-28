/**
 * emulation 出站请求「线上形态」校验（wire-level）
 *
 * 与 claudeCodeEmulationVersion.test.js 的分工：
 *   - 那个文件断言内部字段；
 *   - 本文件把 _prepareRequestHeadersAndPayload 产出的真实 headers + bodyString
 *     实际通过 HTTP 发出去，再从接收端拿到的原始字节（req.rawHeaders 保留顺序与大小写）
 *     核对，等价于对出站请求做一次抓包比对。
 *
 * 基线：Claude Code 2.1.280 抓包（claude -p / sdk-cli 入口）。
 * 注意：此处用明文 HTTP 打到本机端口，故校验的是请求形态（header 集合/顺序无关项、
 * body 字段与顺序无关项），不覆盖 TLS 协商本身。
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

const http = require('http')
const claudeRelayService = require('../src/services/relay/claudeRelayService')
const claudeCodeProfile = require('../src/config/claudeCodeProfile')

const ACCOUNT = { id: 'acct-wire', useUnifiedUserAgent: 'false' }
const EXPECTED_VERSION = '2.1.280'

describe('emulation outbound request wire shape (v2.1.280 baseline)', () => {
  let server = null
  let received = null
  let port = 0

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        received = { rawHeaders: req.rawHeaders, method: req.method, url: req.url, body: raw }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      })
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    ;({ port } = server.address())
  })

  afterAll(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('实际发出后，请求头与 body 与 2.1.280 基线一致', async () => {
    const clientBody = {
      model: 'claude-opus-5-5',
      max_tokens: 128000,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'wire capture payload example text' }] }
      ],
      system: 'You are a helpful third party agent.'
    }

    const processed = claudeRelayService._processRequestBody(clientBody, ACCOUNT, false, {
      entrypoint: 'cli'
    })
    const prepared = await claudeRelayService._prepareRequestHeadersAndPayload(
      processed,
      // 客户端声明了一个额外的 beta：统一化后不得透传给上游
      { 'anthropic-beta': 'context-1m-2025-08-07' },
      ACCOUNT.id,
      'sk-ant-oat0-wire-test',
      {
        account: ACCOUNT,
        requestOptions: { isRealClaudeCodeRequest: false },
        isStream: true,
        sessionHash: null
      }
    )

    // —— 真正把请求发出去（接收端保留原始 header 顺序与大小写）——
    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/messages?beta=true',
          headers: prepared.headers
        },
        (res) => {
          res.resume()
          res.on('end', resolve)
        }
      )
      req.on('error', reject)
      req.end(prepared.bodyString)
    })

    expect(received).not.toBeNull()
    expect(received.method).toBe('POST')
    expect(received.url).toBe('/v1/messages?beta=true')

    const headers = {}
    for (let i = 0; i < received.rawHeaders.length; i += 2) {
      headers[received.rawHeaders[i].toLowerCase()] = received.rawHeaders[i + 1]
    }
    const profile = claudeCodeProfile.getProfile()
    const sent = JSON.parse(received.body)

    // ——— 版本声明 / 身份类 header ———
    expect(headers['user-agent']).toBe(`claude-cli/${EXPECTED_VERSION} (external, cli)`)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['x-app']).toBe('cli')
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    expect(headers['accept']).toBe('application/json')
    expect(headers['accept-encoding']).toBe('gzip, deflate, br, zstd')

    // ——— 2.1.280 新增的固定头 / 每请求 id ———
    expect(headers['anthropic-dispatch-id']).toBe('v2d')
    expect(headers['x-claude-code-request-class']).toBe('main')
    expect(headers['x-client-request-id']).toMatch(/^[0-9a-f-]{36}$/)

    // ——— beta：16 个、顺序与基线一致，且客户端声明的额外 beta 已被丢弃 ———
    expect(headers['anthropic-beta']).toBe(profile.betas.join(','))
    expect(headers['anthropic-beta']).not.toContain('context-1m-2025-08-07')

    // ——— 会话 id 三方一致（header = body metadata）———
    const bodySessionId = JSON.parse(sent.metadata.user_id).session_id
    expect(headers['x-claude-code-session-id']).toBe(bodySessionId)

    // ——— body 顶层：无 temperature，thinking/output_config/context_management 齐备 ———
    expect(sent.temperature).toBeUndefined()
    expect(sent.thinking).toEqual({ type: 'adaptive', display: 'omitted' })
    expect(sent.output_config).toEqual({ effort: 'medium' })
    expect(sent.context_management).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }]
    })
    expect(sent.max_tokens).toBe(128000)

    // ——— system[0]：2.1.280 字段顺序，且不含 cch ———
    const billing = sent.system[0].text
    expect(billing).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=cli; cc_prompt_id=[0-9a-f-]{36}; cc_turn_origin=cli;$/
    )
    expect(billing).not.toContain('cch=')
    expect(sent.system[1].text).toBe(profile.system.identity)
    expect(sent.system[2].cache_control).toEqual({ type: 'ephemeral', ttl: '1h', scope: 'global' })

    // ——— 客户端 system 迁入 messages，且不残留自造常量 ———
    expect(sent.messages[0].role).toBe('system')
    expect(sent.messages[0].content[0].text).toBe('You are a helpful third party agent.')
    const flat = JSON.stringify(sent)
    expect(flat).not.toContain('[System Instructions]')
    expect(flat).not.toContain('Understood. I will follow these instructions')
    expect(flat).not.toContain(
      'Always explain your reasoning concisely and prefer safe, incremental changes'
    )
  })

  it('真 Claude Code 形态的请求同样被归一化后发出（禁止透传）', async () => {
    const profile = claudeCodeProfile.getProfile()
    const clientBody = {
      model: 'claude-opus-5-5',
      max_tokens: 128000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'genuine cc wire payload' }] }],
      system: [
        { type: 'text', text: profile.system.identity },
        { type: 'text', text: 'GENUINE CLI MAIN PROMPT' }
      ]
    }
    // 客户端本身就声称是 Claude Code（自身即真 CC 指纹）
    const clientHeaders = {
      'user-agent': `claude-cli/${EXPECTED_VERSION} (external, sdk-cli)`,
      'x-app': 'cli'
    }

    const processed = claudeRelayService._processRequestBody(clientBody, ACCOUNT, true, {
      entrypoint: 'sdk-cli'
    })
    const prepared = await claudeRelayService._prepareRequestHeadersAndPayload(
      processed,
      clientHeaders,
      ACCOUNT.id,
      'sk-ant-oat0-realcc',
      {
        account: ACCOUNT,
        requestOptions: { isRealClaudeCodeRequest: true },
        isStream: true,
        sessionHash: null
      }
    )

    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/messages?beta=true',
          headers: prepared.headers
        },
        (res) => {
          res.resume()
          res.on('end', resolve)
        }
      )
      req.on('error', reject)
      req.end(prepared.bodyString)
    })

    const headers = {}
    for (let i = 0; i < received.rawHeaders.length; i += 2) {
      headers[received.rawHeaders[i].toLowerCase()] = received.rawHeaders[i + 1]
    }
    const sent = JSON.parse(received.body)

    // 入口跟随客户端 → UA 声明 sdk-cli；固定头与 beta 仍由中转统一注入
    expect(headers['user-agent']).toBe(`claude-cli/${EXPECTED_VERSION} (external, sdk-cli)`)
    expect(headers['anthropic-dispatch-id']).toBe('v2d')
    expect(headers['anthropic-beta']).toBe(profile.betas.join(','))

    // 真 CC 自带的 system 被迁入 messages，system 换成中转合成形态
    expect(JSON.stringify(sent.system)).not.toContain('GENUINE CLI MAIN PROMPT')
    expect(JSON.stringify(sent.messages)).toContain('GENUINE CLI MAIN PROMPT')
    expect(sent.system[0].text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;/
    )
    expect(sent.system[0].text).toContain('cc_turn_origin=sdk;')
    expect(sent.system[0].text).not.toContain('cch=')
    expect(sent.temperature).toBeUndefined()
  })
})
