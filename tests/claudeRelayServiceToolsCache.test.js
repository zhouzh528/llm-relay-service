/**
 * Tests for PR-1: tools cache_control auto injection
 *
 * 验证目标：
 *   1. 非真 Claude Code 请求 (shouldEmulate=true) 自动给 tools[last] 注入 cache_control
 *   2. tools 内已存在 cache_control 时不再覆盖（与上游自带共存）
 *   3. tools 注入与 system/messages 注入互不干扰
 *   4. _enforceCacheControlLimit 现在能正确统计 tools，并优先保护 tools 上的断点
 *   5. 真 Claude Code 请求路径（shouldEmulate=false）的行为不变
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

// ---------------------------------------------------------------------------
// 工具函数：构造一个含 N 个工具的请求体
// ---------------------------------------------------------------------------
function makeTools(n) {
  return Array.from({ length: n }, (_, i) => ({
    name: `tool_${i}`,
    description: `Tool number ${i}`,
    input_schema: { type: 'object', properties: {} }
  }))
}

function makeBody({ tools = [], extras = {} } = {}) {
  return {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    system: 'Custom system instructions',
    tools,
    ...extras
  }
}

// ---------------------------------------------------------------------------
// _injectToolsCacheControl 单元测试
// ---------------------------------------------------------------------------
describe('_hasMessagesCacheControl', () => {
  it('messages 内有 cache_control 时返回 true', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }]
        }
      ]
    }
    expect(claudeRelayService._hasMessagesCacheControl(body)).toBe(true)
  })

  it('messages 内无 cache_control 时返回 false', () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }]
    }
    expect(claudeRelayService._hasMessagesCacheControl(body)).toBe(false)
  })

  it('body 无 messages 字段时返回 false', () => {
    expect(claudeRelayService._hasMessagesCacheControl({})).toBe(false)
  })

  it('body 为 null 时安全返回 false', () => {
    expect(claudeRelayService._hasMessagesCacheControl(null)).toBe(false)
  })

  it('system 有 cache_control 但 messages 没有时仍返回 false', () => {
    const body = {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }]
    }
    expect(claudeRelayService._hasMessagesCacheControl(body)).toBe(false)
  })
})

describe('_injectToolsCacheControl', () => {
  it('在 tools 最后一项注入 cache_control 并返回路径', () => {
    const body = { tools: makeTools(3) }
    const path = claudeRelayService._injectToolsCacheControl(body)

    expect(path).toBe('tools[2]')
    expect(body.tools[2].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tools[0].cache_control).toBeUndefined()
    expect(body.tools[1].cache_control).toBeUndefined()
  })

  it('tools 为空数组时返回 null 且不改动 body', () => {
    const body = { tools: [] }
    const before = JSON.stringify(body)
    expect(claudeRelayService._injectToolsCacheControl(body)).toBeNull()
    expect(JSON.stringify(body)).toBe(before)
  })

  it('body 无 tools 字段时返回 null', () => {
    const body = { messages: [] }
    expect(claudeRelayService._injectToolsCacheControl(body)).toBeNull()
  })

  it('tools 内已有 cache_control（任意位置）则跳过', () => {
    const tools = makeTools(3)
    tools[0].cache_control = { type: 'ephemeral' }
    const body = { tools }
    expect(claudeRelayService._injectToolsCacheControl(body)).toBeNull()
    // 最后一项不应被改动
    expect(body.tools[2].cache_control).toBeUndefined()
  })

  it('tools 嵌套 input_schema 内含 cache_control 也算已有', () => {
    const tools = makeTools(2)
    tools[0].input_schema.cache_control = { type: 'ephemeral' }
    const body = { tools }
    expect(claudeRelayService._injectToolsCacheControl(body)).toBeNull()
  })

  it('body 为非对象时安全返回 null', () => {
    expect(claudeRelayService._injectToolsCacheControl(null)).toBeNull()
    expect(claudeRelayService._injectToolsCacheControl(undefined)).toBeNull()
    expect(claudeRelayService._injectToolsCacheControl('str')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// _injectClaudeCodeStyleCacheControl 集成行为测试
// ---------------------------------------------------------------------------
describe('_injectClaudeCodeStyleCacheControl with tools', () => {
  it('完整注入：system / messages / tools 各自打断点', () => {
    const body = {
      system: [{ type: 'text', text: 'sys' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
        { role: 'user', content: [{ type: 'text', text: 'q2' }] }
      ],
      tools: makeTools(3)
    }
    claudeRelayService._injectClaudeCodeStyleCacheControl(body)

    // tools 最后一项
    expect(body.tools[2].cache_control).toEqual({ type: 'ephemeral' })
    // system 最后一项
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' })
    // messages 末尾两条
    expect(body.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.messages[2].content[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('仅 system 已有 cache_control（messages 无）→ 补 tools + messages 锚点', () => {
    // 典型 qwenpaw 场景：system 打了 cache_control 但 messages 完全没有
    // 修复后 relay 应补充 messages 末尾锚点，否则 messages 完全不进缓存
    const body = {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      tools: makeTools(2)
    }
    claudeRelayService._injectClaudeCodeStyleCacheControl(body)

    // tools 被注入
    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' })
    // 既有的 system cache_control 保持
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' })
    // messages 现在也会被补上锚点（修复前是 undefined）
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('messages 已有 cache_control → 不再重复注入', () => {
    // messages 已经有锚点时，_hasMessagesCacheControl 命中，跳过注入
    const body = {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }]
        }
      ],
      tools: makeTools(2)
    }
    claudeRelayService._injectClaudeCodeStyleCacheControl(body)

    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' })
    // messages 不应被重复修改
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' })
    // 只有一个 cache_control 在 content[0] 上（没有被覆盖）
    expect(body.messages[0].content.length).toBe(1)
  })

  it('tools 自带 cache_control 时不覆盖，且也不再注入 system/messages（保持旧契约）', () => {
    const tools = makeTools(2)
    tools[1].cache_control = { type: 'ephemeral', ttl: '5m' }
    const body = {
      system: [{ type: 'text', text: 'sys' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      tools
    }
    claudeRelayService._injectClaudeCodeStyleCacheControl(body)

    expect(body.tools[1].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' })
    // 因为 _hasExistingCacheControl 命中（tools 也算），system/messages 不动
    expect(body.system[0].cache_control).toBeUndefined()
    expect(body.messages[0].content[0].cache_control).toBeUndefined()
  })

  it('无 tools 时退化到原行为（仅 system + messages）', () => {
    const body = {
      system: [{ type: 'text', text: 'sys' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q1' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a1' }] }
      ]
    }
    claudeRelayService._injectClaudeCodeStyleCacheControl(body)

    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.messages[1].content[0].cache_control).toEqual({ type: 'ephemeral' })
  })
})

// ---------------------------------------------------------------------------
// _enforceCacheControlLimit 与 tools 配合
// ---------------------------------------------------------------------------
describe('_enforceCacheControlLimit with tools', () => {
  it('总数 ≤ 4 时不动任何 cache_control', () => {
    const body = {
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }]
        }
      ],
      tools: [{ name: 't', input_schema: {}, cache_control: { type: 'ephemeral' } }]
    }
    claudeRelayService._enforceCacheControlLimit(body)

    expect(body.system[0].cache_control).toBeDefined()
    expect(body.messages[0].content[0].cache_control).toBeDefined()
    expect(body.tools[0].cache_control).toBeDefined()
  })

  it('总数 > 4 时优先削减 messages，再 system，最后才动 tools', () => {
    // 构造：3 个 messages + 1 system + 1 tools = 5 个 cache_control
    const body = {
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'q1', cache_control: { type: 'ephemeral' } }]
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'a1', cache_control: { type: 'ephemeral' } }]
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'q2', cache_control: { type: 'ephemeral' } }]
        }
      ],
      tools: [{ name: 't', input_schema: {}, cache_control: { type: 'ephemeral' } }]
    }
    claudeRelayService._enforceCacheControlLimit(body)

    // 应该恰好删了 1 个 messages 上的 cache_control
    const remaining = body.messages.filter((m) => m.content[0].cache_control).length
    expect(remaining).toBe(2)
    expect(body.system[0].cache_control).toBeDefined()
    expect(body.tools[0].cache_control).toBeDefined() // tools 优先保留
  })

  it('超额很多时按 messages -> system -> tools 顺序削减', () => {
    // 构造 6 个：4 messages + 1 system + 1 tools
    const msgs = []
    for (let i = 0; i < 4; i++) {
      msgs.push({
        role: 'user',
        content: [{ type: 'text', text: `q${i}`, cache_control: { type: 'ephemeral' } }]
      })
    }
    const body = {
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: msgs,
      tools: [{ name: 't', input_schema: {}, cache_control: { type: 'ephemeral' } }]
    }
    claudeRelayService._enforceCacheControlLimit(body)

    // 6 -> 4: 删 2 个 messages
    const remainingMsgs = msgs.filter((m) => m.content[0].cache_control).length
    expect(remainingMsgs).toBe(2)
    expect(body.system[0].cache_control).toBeDefined()
    expect(body.tools[0].cache_control).toBeDefined()
  })

  it('messages/system 都没有可删时才动 tools', () => {
    // 5 个全在 tools
    const tools = Array.from({ length: 5 }, (_, i) => ({
      name: `t${i}`,
      input_schema: {},
      cache_control: { type: 'ephemeral' }
    }))
    const body = { tools }
    claudeRelayService._enforceCacheControlLimit(body)

    const remaining = tools.filter((t) => t.cache_control).length
    expect(remaining).toBe(4)
    // 末尾应优先保留（最后一项是 `_injectToolsCacheControl` 的注入点）
    expect(tools[tools.length - 1].cache_control).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// _processRequestBody 端到端（非真 Claude Code）
// ---------------------------------------------------------------------------
describe('_processRequestBody — tools cache_control injection (non-real Claude Code)', () => {
  it('非真 Claude Code 请求带 tools，处理后 tools 末尾被注入', () => {
    const body = makeBody({ tools: makeTools(5) })
    const result = claudeRelayService._processRequestBody(body, null, false)

    expect(result.tools).toBeDefined()
    expect(result.tools).toHaveLength(5)
    expect(result.tools[4].cache_control).toEqual({ type: 'ephemeral' })
    expect(result.tools[0].cache_control).toBeUndefined()
  })

  it('统一化后：真 Claude Code 客户端请求同样注入 tools cache_control', () => {
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      system: [{ type: 'text', text: claudeRelayService.claudeCodeSystemPrompt }],
      tools: makeTools(3)
    }
    const result = claudeRelayService._processRequestBody(body, null, true)

    // 统一化：所有请求走同一路径，tools 末尾同样被注入
    expect(result.tools[2].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('非真 Claude Code 请求无 tools 时其他行为不变', () => {
    const body = makeBody()
    delete body.tools
    const result = claudeRelayService._processRequestBody(body, null, false)
    // 不应崩溃，也不应注入 tools
    expect(result.tools).toBeUndefined()
  })
})
