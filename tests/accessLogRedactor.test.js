const {
  stripConversationContent,
  redactSecrets,
  redactQueryString,
  buildLoggableResponseBody
} = require('../src/utils/accessLogRedactor')

describe('accessLogRedactor', () => {
  test('stripConversationContent keeps structure but drops message text', () => {
    const out = stripConversationContent({
      model: 'claude-opus-5',
      stream: true,
      system: [{ type: 'text', text: 'You are a helpful assistant' }],
      messages: [
        { role: 'user', content: 'login host root pass123' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret thoughts', signature: 'abcdef' },
            { type: 'tool_use', id: 'toolu_1', name: 'exec', input: { command: 'ssh x' } }
          ]
        }
      ]
    })

    expect(out.model).toBe('claude-opus-5')
    expect(out.stream).toBe(true)
    expect(out.system[0]).toEqual({ type: 'text', text: '[redacted 27 chars]' })
    expect(out.messages[0]).toEqual({ role: 'user', content: '[redacted 23 chars]' })
    expect(out.messages[1].content[0].thinking).toBe('[redacted 15 chars]')
    expect(out.messages[1].content[1].name).toBe('exec')
    expect(out.messages[1].content[1].input.command).toBe('[redacted 5 chars]')
    expect(JSON.stringify(out)).not.toContain('pass123')
  })

  test('stripConversationContent is idempotent', () => {
    const once = stripConversationContent({
      messages: [{ role: 'user', content: 'x'.repeat(300) }]
    })
    const twice = stripConversationContent(once)
    expect(twice.messages[0].content).toBe('[redacted 300 chars]')
  })

  test('stripConversationContent caps long arrays', () => {
    const messages = Array.from({ length: 30 }, () => ({ role: 'user', content: 'hi' }))
    const out = stripConversationContent({ messages })
    expect(out.messages).toHaveLength(25)
    expect(out.messages[24]).toBe('...[6 more items]')
  })

  test('buildLoggableResponseBody redacts login token but keeps numeric stats', () => {
    const out = buildLoggableResponseBody({
      success: true,
      token: 'b'.repeat(64),
      expiresIn: 86400000,
      username: 'dipin',
      data: { inputTokens: 12, apiKey: `cr_${'a'.repeat(40)}`, note: `cr_${'z'.repeat(40)}` }
    })
    expect(out.token).toBe('[REDACTED]')
    expect(out.username).toBe('dipin')
    expect(out.expiresIn).toBe(86400000)
    expect(out.data.inputTokens).toBe(12)
    expect(out.data.apiKey).toBe('[REDACTED]')
    expect(out.data.note).toBe('[REDACTED]')
  })

  test('buildLoggableResponseBody drops model output text but keeps usage', () => {
    const out = buildLoggableResponseBody({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'here is the root password' }],
      usage: { input_tokens: 10, output_tokens: 5 }
    })
    expect(out.content[0]).toEqual({ type: 'text', text: '[redacted 25 chars]' })
    expect(out.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
    expect(out.model).toBe('claude-opus-5')

    const admin = buildLoggableResponseBody({ success: true, data: { content: 'notice' } })
    expect(admin.data.content).toBe('notice')
  })

  test('redactSecrets catches JWT and Bearer values by shape', () => {
    const out = redactSecrets({
      a: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      b: 'Bearer abcdefghijklmnopqrstuvwxyz',
      c: 'plain text value that is fine'
    })
    expect(out.a).toBe('[REDACTED]')
    expect(out.b).toBe('[REDACTED]')
    expect(out.c).toBe('plain text value that is fine')
  })

  test('redactQueryString masks key-like params only', () => {
    expect(redactQueryString('alt=sse&key=AIzaSecret123')).toBe('alt=sse&key=[REDACTED]')
    expect(redactQueryString('period=today')).toBe('period=today')
    expect(redactQueryString('token=abc&granularity=day')).toBe('token=[REDACTED]&granularity=day')
  })
})
