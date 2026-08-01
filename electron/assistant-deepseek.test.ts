import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createDeepSeekService, DEEPSEEK_BASE_URL } = require('./assistant-deepseek.cjs') as {
  createDeepSeekService: (options: any) => any
  DEEPSEEK_BASE_URL: string
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

const reply = (content: string) => jsonResponse({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
})

const toolReply = (name: string, args: unknown) => jsonResponse({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    finish_reason: 'tool_calls',
  }],
})

describe('DeepSeek adapter', () => {
  it('posts to the fixed endpoint with the key in the header', async () => {
    const fetchImpl = vi.fn(async () => reply('Fine.'))
    const service = createDeepSeekService({ apiKey: 'sk-test-key', fetchImpl })

    await service.startTurn({ text: 'How did I sleep?', healthContext: '{}', tools: [] })

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, any]
    expect(url).toBe(`${DEEPSEEK_BASE_URL}/chat/completions`)
    expect(init.headers.Authorization).toBe('Bearer sk-test-key')
    expect(DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com')
  })

  it('sends the tool definitions it was given', async () => {
    const fetchImpl = vi.fn(async () => reply('Fine.'))
    const tools = [{ name: 'metric_window', description: 'x', schema: { type: 'object', properties: {}, required: [] } }]
    const service = createDeepSeekService({ apiKey: 'sk-test-key', fetchImpl })

    await service.startTurn({ text: 'hi', healthContext: '{}', tools })

    const body = JSON.parse((fetchImpl.mock.calls[0] as any)[1].body)
    expect(body.tools[0].function.name).toBe('metric_window')
  })

  it('runs a tool call and feeds the result back for a second round', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(toolReply('metric_window', { metric: 'steps' }))
      .mockResolvedValueOnce(reply('You averaged 8 000 steps.'))
    const onToolCall = vi.fn(async () => ({ ok: true, result: { median: 8000, n: 30 } }))
    const service = createDeepSeekService({ apiKey: 'sk-test-key', fetchImpl })

    const result = await service.startTurn({ text: 'steps?', healthContext: '{}', tools: [], onToolCall })

    expect(onToolCall).toHaveBeenCalledWith('metric_window', { metric: 'steps' })
    expect(result.text).toContain('8 000 steps')
    const secondBody = JSON.parse((fetchImpl.mock.calls[1] as any)[1].body)
    const toolMessage = secondBody.messages.at(-1)
    expect(toolMessage.role).toBe('tool')
    expect(JSON.parse(toolMessage.content).median).toBe(8000)
  })

  it('passes a tool failure back to the model instead of aborting the turn', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(toolReply('metric_window', { metric: 'nope' }))
      .mockResolvedValueOnce(reply('That metric is not available.'))
    const onToolCall = vi.fn(async () => ({ ok: false, error: 'Unknown metric "nope".' }))
    const service = createDeepSeekService({ apiKey: 'sk-test-key', fetchImpl })

    const result = await service.startTurn({ text: 'x', healthContext: '{}', tools: [], onToolCall })

    expect(result.text).toContain('not available')
    const toolMessage = JSON.parse((fetchImpl.mock.calls[1] as any)[1].body).messages.at(-1)
    expect(toolMessage.content).toContain('Unknown metric')
  })

  it('reports a rejected key as a settings problem', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'Invalid key' } }, 401))
    const service = createDeepSeekService({ apiKey: 'sk-bad', fetchImpl })

    await expect(service.startTurn({ text: 'x', healthContext: '{}', tools: [] }))
      .rejects.toMatchObject({ code: 'DEEPSEEK_UNAUTHORIZED' })
  })

  it('retries once on a server error before giving up', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'boom' } }, 500))
      .mockResolvedValueOnce(reply('Recovered.'))
    const service = createDeepSeekService({ apiKey: 'sk-test-key', fetchImpl })

    const result = await service.startTurn({ text: 'x', healthContext: '{}', tools: [] })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(result.text).toBe('Recovered.')
  })

  it('never puts the key in an error message', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('connect failed for sk-test-key-12345678') })
    const service = createDeepSeekService({ apiKey: 'sk-test-key-12345678', fetchImpl })

    await expect(service.startTurn({ text: 'x', healthContext: '{}', tools: [] }))
      .rejects.toSatisfy((error: Error) => !error.message.includes('sk-test-key-12345678'))
  })

  it('carries the first turn exchange into the second turn, without duplicating the system prompt or the manifest', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply('You slept 7 hours.'))
      .mockResolvedValueOnce(reply('The week before you averaged 6.5 hours.'))
    const service = createDeepSeekService({ apiKey: 'sk-test-key', fetchImpl })

    await service.startTurn({ text: 'How did I sleep last night?', healthContext: '{"a":1}', tools: [] })
    await service.startTurn({ text: 'and the week before?', healthContext: '{"a":2}', tools: [] })

    const secondBody = JSON.parse((fetchImpl.mock.calls[1] as any)[1].body)
    const roles = secondBody.messages.map((message: any) => message.role)

    expect(roles.filter((role: string) => role === 'system')).toHaveLength(1)
    const manifestMessages = secondBody.messages.filter((message: any) =>
      typeof message.content === 'string' && message.content.startsWith('<OPENFIT_HEALTH_CONTEXT>'))
    expect(manifestMessages).toHaveLength(1)
    expect(manifestMessages[0].content).toContain('"a":2')

    expect(secondBody.messages).toContainEqual({ role: 'user', content: 'How did I sleep last night?' })
    expect(secondBody.messages).toContainEqual({ role: 'assistant', content: 'You slept 7 hours.' })
    expect(secondBody.messages.at(-1)).toEqual({ role: 'user', content: 'and the week before?' })
  })

  it('reset() clears the conversation history so the next turn starts fresh', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(reply('You slept 7 hours.'))
      .mockResolvedValueOnce(reply('No prior context here.'))
    const service = createDeepSeekService({ apiKey: 'sk-test-key', fetchImpl })

    await service.startTurn({ text: 'How did I sleep last night?', healthContext: '{}', tools: [] })
    await service.reset()
    await service.startTurn({ text: 'and the week before?', healthContext: '{}', tools: [] })

    const secondBody = JSON.parse((fetchImpl.mock.calls[1] as any)[1].body)
    expect(secondBody.messages).not.toContainEqual({ role: 'assistant', content: 'You slept 7 hours.' })
  })

  it('stops after the tool round limit rather than looping forever', async () => {
    const fetchImpl = vi.fn(async () => toolReply('metric_window', { metric: 'steps' }))
    const onToolCall = vi.fn(async () => ({ ok: true, result: { n: 1 } }))
    const service = createDeepSeekService({ apiKey: 'sk-test-key', fetchImpl, maxToolRounds: 3 })

    await service.startTurn({ text: 'x', healthContext: '{}', tools: [], onToolCall })

    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(4)
  })
})
