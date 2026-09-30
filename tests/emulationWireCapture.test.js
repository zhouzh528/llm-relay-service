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

// 即使旧账号打开 useUnifiedUserAgent，也不得再让客户端 UA 覆盖固定 2.1.280 profile。
const ACCOUNT = { id: 'acct-wire', useUnifiedUserAgent: 'true' }
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
      system: 'You are a helpful third party agent.',
      temperature: 0.4,
      top_p: 0.9,
      stop_sequences: ['third-party-only'],
      unsupported_client_field: true
    }

    const processed = claudeRelayService._processRequestBody(clientBody, ACCOUNT, false, {
      entrypoint: 'cli'
    })
    const prepared = await claudeRelayService._prepareRequestHeadersAndPayload(
      processed,
      // 客户端声明的 header 均不得覆盖 canonical profile
      {
        accept: 'text/plain',
        'content-type': 'text/plain',
        connection: 'close',
        'anthropic-version': '2099-01-01',
        'anthropic-beta': 'context-1m-2025-08-07',
        'user-agent': 'third-party-client/9.9.9'
      },
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

    const rawHeaderNames = received.rawHeaders.filter((_, index) => index % 2 === 0)
    expect(rawHeaderNames).toEqual([
      'Accept',
      'Authorization',
      'Content-Type',
      'User-Agent',
      'X-Claude-Code-Session-Id',
      'X-Stainless-Arch',
      'X-Stainless-Lang',
      'X-Stainless-OS',
      'X-Stainless-Package-Version',
      'X-Stainless-Retry-Count',
      'X-Stainless-Runtime',
      'X-Stainless-Runtime-Version',
      'X-Stainless-Timeout',
      'anthropic-beta',
      'anthropic-dangerous-direct-browser-access',
      'anthropic-dispatch-id',
      'anthropic-version',
      'x-app',
      'x-claude-code-request-class',
      'x-client-request-id',
      'Connection',
      'Host',
      'Accept-Encoding',
      'Content-Length'
    ])

    const headers = {}
    for (let i = 0; i < received.rawHeaders.length; i += 2) {
      headers[received.rawHeaders[i].toLowerCase()] = received.rawHeaders[i + 1]
    }
    const profile = claudeCodeProfile.getProfile()
    const sent = JSON.parse(received.body)

    // ——— 版本声明 / 身份类 header ———
    expect(headers['user-agent']).toBe(`claude-cli/${EXPECTED_VERSION} (external, sdk-cli)`)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
    expect(headers.connection).toBe('keep-alive')
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
    expect(Object.keys(sent)).toEqual([
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
    ])
    expect(sent.tools).toEqual([])
    expect(sent.diagnostics).toEqual({ previous_message_id: null })
    expect(sent.stop_sequences).toBeUndefined()
    expect(sent.unsupported_client_field).toBeUndefined()

    // ——— system[0]：2.1.280 字段顺序，且不含 cch ———
    const billing = sent.system[0].text
    expect(billing).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cc_prompt_id=[0-9a-f-]{36}; cc_turn_origin=sdk;$/
    )
    expect(billing).not.toContain('cch=')
    expect(sent.system[1].text).toBe(profile.system.identity)
    expect(sent.system).toHaveLength(4)
    expect(sent.system[2].text).toBe(profile.system.genericInstructions)
    expect(sent.system[2].cache_control).toEqual({ type: 'ephemeral', ttl: '1h', scope: 'global' })
    expect(sent.system[3].text).toContain('<total_tokens>15000000 tokens left</total_tokens>')
    expect(sent.system[3].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })

    // ——— 第一轮 messages 顺序为 user → system(Environment) ———
    expect(sent.messages[0].role).toBe('user')
    expect(sent.messages[0].content).toHaveLength(3)
    expect(sent.messages[0].content.map((block) => block.type)).toEqual(['text', 'text', 'text'])
    sent.messages[0].content.forEach((block) => expect(block.cache_control).toBeUndefined())
    expect(sent.messages[1].role).toBe('system')
    expect(sent.messages[1].content[0].text.startsWith('# Environment')).toBe(true)
    expect(sent.messages[1].content[0].text).toContain(
      '# Client Instructions\nYou are a helpful third party agent.'
    )
    expect(sent.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
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

    // 所有客户端固定为 sdk-cli 基线；固定头与 beta 由中转统一注入
    expect(headers['user-agent']).toBe(`claude-cli/${EXPECTED_VERSION} (external, sdk-cli)`)
    expect(headers['anthropic-dispatch-id']).toBe('v2d')
    expect(headers['anthropic-beta']).toBe(profile.betas.join(','))

    // 真 CC 自带的 system 被迁入 messages，system 换成中转合成形态
    expect(JSON.stringify(sent.system)).not.toContain('GENUINE CLI MAIN PROMPT')
    expect(JSON.stringify(sent.messages)).toContain('GENUINE CLI MAIN PROMPT')
    expect(sent.system[0].text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;/
    )
    expect(sent.system).toHaveLength(4)
    expect(sent.system[0].text).toContain('cc_turn_origin=sdk;')
    expect(sent.system[0].text).not.toContain('cch=')
    expect(sent.temperature).toBeUndefined()
  })

  it('schema-compatible 工具目录按抓包的 12 个名称/顺序/额外字段发出', async () => {
    const profile = claudeCodeProfile.getProfile()
    const processed = claudeRelayService._processRequestBody(
      {
        model: 'claude-opus-5-5',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'tool catalog payload' }] }],
        tools: JSON.parse(JSON.stringify(profile.tools))
      },
      ACCOUNT,
      false
    )
    const prepared = await claudeRelayService._prepareRequestHeadersAndPayload(
      processed,
      {},
      ACCOUNT.id,
      'sk-ant-oat0-tools-test',
      {
        account: ACCOUNT,
        requestOptions: {},
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

    const sent = JSON.parse(received.body)
    expect(sent.tools.map((tool) => tool.name)).toEqual(profile.tools.map((tool) => tool.name))
    expect(sent.tools).toHaveLength(12)
    expect(sent.tools.find((tool) => tool.name === 'Bash').eager_input_streaming).toBe(true)
    expect(sent.tools.find((tool) => tool.name === 'DeferredToolPlaceholder')).toMatchObject({
      defer_loading: true
    })
    expect(sent.tools.find((tool) => tool.name === 'advisor')).toMatchObject({
      type: 'advisor_20260301',
      model: 'claude-opus-5-5',
      defer_loading: true
    })
    sent.tools.forEach((tool) => expect(tool.cache_control).toBeUndefined())
  })

  it('重试计数与上一轮工具耗时按抓包位置写入 header', async () => {
    const durationSpy = jest
      .spyOn(claudeRelayService, '_getPreviousToolDurationsHeader')
      .mockResolvedValue('Read=11')
    try {
      const processed = claudeRelayService._processRequestBody(
        {
          model: 'claude-opus-5-5',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'retry payload' }] }]
        },
        ACCOUNT,
        false
      )
      const prepared = await claudeRelayService._prepareRequestHeadersAndPayload(
        processed,
        { connection: 'close', accept: 'text/plain' },
        ACCOUNT.id,
        'sk-ant-oat0-retry-test',
        {
          account: ACCOUNT,
          requestOptions: { stainlessRetryCount: 2 },
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

      const names = received.rawHeaders.filter((_, index) => index % 2 === 0)
      const values = {}
      for (let index = 0; index < received.rawHeaders.length; index += 2) {
        values[received.rawHeaders[index]] = received.rawHeaders[index + 1]
      }
      expect(values['X-Stainless-Retry-Count']).toBe('2')
      expect(values['x-claude-code-prev-tool-durations']).toBe('Read=11')
      expect(names.indexOf('x-claude-code-prev-tool-durations')).toBe(
        names.indexOf('x-claude-code-request-class') - 1
      )
      expect(values.Connection).toBe('keep-alive')
      expect(values.Accept).toBe('application/json')
    } finally {
      durationSpy.mockRestore()
    }
  })
})
