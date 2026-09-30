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
jest.mock('../src/services/claudeCodeHeadersService', () => ({}))
jest.mock('../src/models/redis', () => ({}))
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
  getPricingData: jest.fn(() => null)
}))

const claudeRelayService = require('../src/services/relay/claudeRelayService')
const metadataUserIdHelper = require('../src/utils/metadataUserIdHelper')
const claudeCodeProfile = require('../src/config/claudeCodeProfile')

describe('claudeRelayService non-real Claude Code normalization', () => {
  it('emulation 使用 CC system 形态，并把客户端 system 迁入 messages', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      system: 'Custom system instructions'
    }

    const result = claudeRelayService._processRequestBody(body, null, false)

    // system = [billing, identity, generic(ttl/scope), main(ttl)]
    expect(result.system).toHaveLength(4)
    expect(result.system[0].text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.280\.[0-9a-f]{3}; cc_entrypoint=sdk-cli;/
    )
    expect(result.system[0].text).not.toContain('cch=')
    expect(result.system[1]).toEqual({
      type: 'text',
      text: claudeRelayService.claudeCodeSystemPrompt
    })
    expect(result.system[2].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
      scope: 'global'
    })
    expect(result.system[3].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })

    // 抓包顺序：user 在前，迁移后的 system(Environment) 在后
    expect(result.messages[0].role).toBe('user')
    expect(result.messages[0].content).toHaveLength(3)
    expect(result.messages[0].content[2].text).toBe('hello')
    expect(result.messages[1].role).toBe('system')
    expect(result.messages[1].content[0].text.startsWith('# Environment')).toBe(true)
    expect(result.messages[1].content[0].text).toContain(
      '# Client Instructions\nCustom system instructions'
    )

    expect(result.max_tokens).toBe(128000)
    expect(result.temperature).toBeUndefined()
    expect(metadataUserIdHelper.isValid(result.metadata.user_id)).toBe(true)
  })

  it('preserves a captured Claude Code prompt block and removes billing markers', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      system: [
        { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.140;' },
        {
          type: 'text',
          text: claudeRelayService.claudeCodeSystemPrompt,
          cache_control: { type: 'ephemeral' }
        },
        { type: 'text', text: 'Generate a concise title.' }
      ],
      max_tokens: 1024,
      temperature: 0.2
    }

    const result = claudeRelayService._processRequestBody(body, null, false)

    // 客户端 billing 标记被剥离，服务注入自己的 billing header
    const systemText = result.system.map((b) => b.text).join('\n')
    expect(systemText).not.toContain('cc_version=2.1.140')
    expect(systemText).toContain('x-anthropic-billing-header: cc_version=2.1.280.')
    expect(result.system[1].text).toBe(claudeRelayService.claudeCodeSystemPrompt)

    // 客户端自定义指令随 system 一起迁入 messages
    expect(JSON.stringify(result.messages)).toContain('Generate a concise title.')

    expect(result.max_tokens).toBe(1024)
    // 2.1.280 顶层不发送 temperature
    expect(result.temperature).toBeUndefined()
  })

  it('rewrites the canonical OpenCode identity sentence before forwarding', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      system: 'You are OpenCode, the best coding agent on the planet.'
    }

    const result = claudeRelayService._processRequestBody(body, null, false)

    // OpenCode 身份句必须被改写为 CC 身份，且不得随迁入 messages 泄漏到上游
    expect(result.system[1].text).toBe(claudeRelayService.claudeCodeSystemPrompt)
    expect(JSON.stringify(result.messages)).not.toContain('OpenCode')
    expect(JSON.stringify(result.system)).not.toContain('OpenCode')
  })

  it('cleans fixed descriptions from known non-real Claude Code tools', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [
        {
          name: 'edit',
          description:
            'Modify existing files (REPLACES apply_patch). Requires a prior Read in this session; ensure oldString uniquely matches.',
          input_schema: {}
        },
        {
          type: 'custom',
          name: 'webfetch',
          custom: {
            description:
              'OpenCode webfetch tool. Always set format to text | markdown | html; read-only; short cache window.',
            input_schema: {}
          }
        },
        {
          name: 'bash',
          description: 'OpenClaw/QwenPaw shell tool. Run commands without a workdir parameter.',
          input_schema: {}
        },
        {
          name: 'read',
          description: 'CoPaw file reader. Reads files from the current workspace.',
          input_schema: {}
        },
        {
          name: 'business_tool',
          description: 'Call the internal business workflow.',
          input_schema: {}
        }
      ]
    }

    const result = claudeRelayService._processRequestBody(body, null, false)

    expect(result.tools[0].description).toBe('Modify existing files by replacing exact text.')
    expect(result.tools[1].custom.description).toBe('Fetch content from a URL.')
    expect(result.tools[2].description).toBe('Run shell commands in the user environment.')
    expect(result.tools[3].description).toBe('Read file contents.')
    expect(result.tools[4].description).toBe('Call the internal business workflow.')
  })

  it('统一化后：真 Claude Code 客户端请求同样被归一化（不再有例外）', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      system: claudeRelayService.claudeCodeSystemPrompt,
      tools: [
        {
          name: 'edit',
          description:
            'Modify existing files (REPLACES apply_patch). Requires a prior Read in this session.',
          input_schema: {}
        }
      ]
    }

    const result = claudeRelayService._processRequestBody(body, null, true)

    // 与第三方客户端一致：工具描述被清洗，system 被替换为中转合成形态（system[0] 为 billing header）
    expect(result.tools[0].description).toBe('Modify existing files by replacing exact text.')
    expect(result.system[0].text).toMatch(/^x-anthropic-billing-header:/)
  })

  it('maps non-Claude tools to stable MCP aliases and rewrites history symmetrically', () => {
    const body = {
      tools: [
        { name: 'sessions_list', input_schema: {} },
        { name: 'session_get', input_schema: {} },
        { type: 'web_search_20250305', name: 'web_search' }
      ],
      tool_choice: { type: 'tool', name: 'sessions_list' },
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'sessions_list', input: {} }]
        }
      ]
    }

    const map = claudeRelayService._transformToolNamesInRequestBody(body)
    const sessionsAlias = body.tools.find((tool) => tool.name.includes('sessions_list')).name
    const sessionAlias = body.tools.find((tool) => tool.name.includes('session_get')).name

    expect(sessionsAlias).toMatch(/^mcp__relay__sessions_list_[0-9a-f]{8}$/)
    expect(sessionAlias).toMatch(/^mcp__relay__session_get_[0-9a-f]{8}$/)
    expect(body.tools.find((tool) => tool.name === 'web_search')).toBeDefined()
    expect(body.tool_choice.name).toBe(sessionsAlias)
    expect(body.messages[0].content[0].name).toBe(sessionsAlias)
    expect(body.messages[0].content[0].caller).toEqual({ type: 'direct' })
    expect(map.get(sessionsAlias)).toBe('sessions_list')
    expect(map.get(sessionAlias)).toBe('session_get')
  })

  it('MCP aliases never exceed Anthropic tool-name limit 64', () => {
    const body = {
      tools: [
        {
          name: 'very_long_custom_tool_name_that_is_definitely_longer_than_fifty_characters_total',
          input_schema: {}
        },
        {
          name: `mcp__existing__${'x'.repeat(90)}`,
          input_schema: {}
        }
      ]
    }

    claudeRelayService._transformToolNamesInRequestBody(body)

    expect(body.tools[0].name.startsWith('mcp__relay__')).toBe(true)
    body.tools.forEach((tool) => expect(tool.name.length).toBeLessThanOrEqual(64))
  })

  it('uses stable MCP aliases instead of synthetic fake prefixes', () => {
    const buildBody = () => ({
      tools: ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'].map((name, index) => ({
        name,
        input_schema: {},
        ...(index === 0 ? { defer_loading: true } : {})
      }))
    })
    const first = buildBody()
    const second = buildBody()

    const firstMap = claudeRelayService._transformToolNamesInRequestBody(first)
    const secondMap = claudeRelayService._transformToolNamesInRequestBody(second)

    expect(first.tools.map((tool) => tool.name)).toEqual(second.tools.map((tool) => tool.name))
    expect(firstMap.size).toBe(6)
    expect(secondMap.size).toBe(6)
    first.tools.forEach((tool) => {
      expect(tool.name).toMatch(/^mcp__relay__[a-z]+_[0-9a-f]{8}$/)
      expect(tool.eager_input_streaming).toBe(true)
      expect(tool.defer_loading).toBeUndefined()
      expect(tool.cache_control).toBeUndefined()
    })
  })

  it('uses the captured 2.1.280 shape for a schema-compatible built-in tool', () => {
    const template = claudeCodeProfile.getProfile().tools.find((tool) => tool.name === 'Bash')
    const body = {
      tools: [
        {
          name: 'bash',
          description: 'third-party description',
          input_schema: JSON.parse(JSON.stringify(template.input_schema)),
          cache_control: { type: 'ephemeral' }
        }
      ]
    }

    const map = claudeRelayService._transformToolNamesInRequestBody(body)

    expect(body.tools[0]).toEqual(template)
    expect(map.get('Bash')).toBe('bash')
  })

  it('adds caller and tool_addition metadata for deferred MCP aliases on continued turns', () => {
    const body = {
      tools: [
        { name: 'custom_lookup', description: 'Lookup data', input_schema: {} },
        { name: 'custom_unused', description: 'Unused data tool', input_schema: {} }
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'look this up' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'custom_lookup', input: {} }]
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }
      ]
    }

    claudeRelayService._transformToolNamesInRequestBody(body)

    const usedAlias = body.tools.find((tool) => tool.name.includes('custom_lookup')).name
    const unusedAlias = body.tools.find((tool) => tool.name.includes('custom_unused')).name
    expect(usedAlias).toMatch(/^mcp__relay__custom_lookup_[0-9a-f]{8}$/)
    expect(unusedAlias).toMatch(/^mcp__relay__custom_unused_[0-9a-f]{8}$/)
    body.tools.forEach((tool) => {
      expect(tool.eager_input_streaming).toBe(true)
      expect(tool.defer_loading).toBe(true)
    })
    expect(body.messages[1].content[0]).toMatchObject({
      name: usedAlias,
      caller: { type: 'direct' }
    })
    const additionMessage = body.messages[body.messages.length - 1]
    expect(additionMessage.role).toBe('system')
    expect(additionMessage.content[1]).toEqual({
      type: 'tool_addition',
      tool: { type: 'tool_reference', name: unusedAlias },
      cache_control: { type: 'ephemeral', ttl: '1h' }
    })
  })

  it('preserves forced tool choice semantics as a system directive before whitelist serialization', () => {
    const template = claudeCodeProfile.getProfile().tools.find((tool) => tool.name === 'Bash')
    const body = {
      tools: [
        {
          name: 'bash',
          description: 'run commands',
          input_schema: JSON.parse(JSON.stringify(template.input_schema))
        }
      ],
      tool_choice: { type: 'tool', name: 'bash' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'run it' }] },
        { role: 'system', content: [{ type: 'text', text: '# Environment' }] }
      ]
    }

    claudeRelayService._transformToolNamesInRequestBody(body)

    expect(body.tool_choice.name).toBe('Bash')
    expect(body.messages[1].content.at(-1).text).toContain('Use the Bash tool')
  })

  it.each([
    ['none', 'Do not use any tools'],
    ['any', 'Use one of the available tools']
  ])('preserves tool_choice:%s semantics as a system directive', (type, expected) => {
    const body = {
      tools: [{ name: 'custom_lookup', input_schema: {} }],
      tool_choice: { type },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'run it' }] },
        { role: 'system', content: [{ type: 'text', text: '# Environment' }] }
      ]
    }

    claudeRelayService._transformToolNamesInRequestBody(body)

    expect(body.messages[1].content.at(-1).text).toContain(expected)
  })

  it('restores MCP aliases in response bytes and streaming text', () => {
    const body = {
      tools: [{ name: 'sessions_list', input_schema: {} }]
    }
    const map = claudeRelayService._transformToolNamesInRequestBody(body)
    const alias = body.tools[0].name

    const restoredBody = claudeRelayService._restoreToolNamesInResponseBody(
      JSON.stringify({
        content: [
          { type: 'text', text: `Do not rewrite ${alias} in ordinary text` },
          { type: 'tool_use', name: alias, input: { note: alias } }
        ]
      }),
      map
    )
    const parsedBody = JSON.parse(restoredBody)
    expect(parsedBody.content[0].text).toContain(alias)
    expect(parsedBody.content[1].name).toBe('sessions_list')
    expect(parsedBody.content[1].input.note).toBe(alias)

    const transform = claudeRelayService._createToolNameStripperStreamTransformer(null, map)
    const restoredStream = transform(
      `event: content_block_start\ndata: {"content_block":{"type":"tool_use","name":"${alias}"}}\n\n`
    )
    expect(restoredStream).toContain('"name":"sessions_list"')
  })
})
