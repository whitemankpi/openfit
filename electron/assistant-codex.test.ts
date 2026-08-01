import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { createCodexService } = require('./assistant-codex.cjs') as {
  createCodexService: (options?: Record<string, unknown>) => {
    getStatus: () => Record<string, unknown>
    start: () => Promise<Record<string, unknown>>
    startTurn: (input: Record<string, unknown>) => Promise<Record<string, any>>
    dispose: () => Promise<void>
  }
}

type ProtocolMessage = {
  id?: number | string
  method?: string
  params?: Record<string, any>
  result?: Record<string, any>
  error?: Record<string, any>
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  readonly messages: ProtocolMessage[] = []
  killed = false
  exitCode: number | null = null
  signalCode: string | null = null
  private inputBuffer = ''

  constructor(private readonly onMessage: (message: ProtocolMessage, child: FakeChild) => void = () => {}) {
    super()
    this.stdin = new Writable({
      write: (chunk, _encoding, done) => {
        this.inputBuffer += chunk.toString()
        let newline: number
        while ((newline = this.inputBuffer.indexOf('\n')) >= 0) {
          const line = this.inputBuffer.slice(0, newline)
          this.inputBuffer = this.inputBuffer.slice(newline + 1)
          if (!line) continue
          const message = JSON.parse(line) as ProtocolMessage
          this.messages.push(message)
          this.onMessage(message, this)
        }
        done()
      },
    })
  }

  send(message: ProtocolMessage) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  kill(signal = 'SIGTERM') {
    this.killed = true
    this.signalCode = signal
    queueMicrotask(() => this.emit('exit', null, signal))
    return true
  }
}

const respond = (child: FakeChild, request: ProtocolMessage, result: Record<string, any> = {}) => {
  queueMicrotask(() => child.send({ id: request.id, result }))
}

/**
 * Builds a service whose thread/start and turn/start handshakes are already
 * stubbed out, so a test can focus on driving `_handleServerRequest` (via
 * `emit`) and inspecting what the service writes back to the app-server
 * (via `sent`, i.e. the fake child's captured stdin messages).
 */
function createStubbedService(options: { onToolCall?: (name: string, args: Record<string, unknown>) => Promise<any> } = {}) {
  const child = new FakeChild((message, current) => {
    if (message.method === 'initialize') respond(current, message)
    if (message.method === 'thread/start') respond(current, message, { thread: { id: 'thread-tools' } })
    if (message.method === 'turn/start') respond(current, message, { turn: { id: 'turn-tools', status: 'inProgress' } })
  })
  const service = createCodexService({
    spawn: vi.fn(() => child),
    resolveBinary: () => '/mock/codex',
    requestTimeoutMs: 250,
    turnTimeoutMs: 1_000,
  })
  return {
    service,
    sent: child.messages,
    emit: (message: ProtocolMessage) => child.send(message),
    completeTurn: () => child.send({ method: 'turn/completed', params: { threadId: 'thread-tools', turn: { id: 'turn-tools', status: 'completed' } } }),
  }
}

describe('Codex app-server service', () => {
  it('starts lazily, performs the handshake, and creates one locked-down persistent thread', async () => {
    const child = new FakeChild((message, current) => {
      if (message.method === 'initialize') respond(current, message, { userAgent: 'codex-test' })
      if (message.method === 'thread/start') respond(current, message, { thread: { id: 'thread-health' } })
    })
    const spawn = vi.fn(() => child)
    const service = createCodexService({
      spawn,
      resolveBinary: () => '/mock/Codex.app/Contents/Resources/codex',
      cwd: '/mock/openfit',
      requestTimeoutMs: 250,
    })

    expect(spawn).not.toHaveBeenCalled()
    await service.start()
    await service.start()

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn).toHaveBeenCalledWith(
      '/mock/Codex.app/Contents/Resources/codex',
      ['app-server'],
      expect.objectContaining({ cwd: '/mock/openfit', stdio: ['pipe', 'pipe', 'pipe'] }),
    )
    expect(child.messages[0]).toMatchObject({
      method: 'initialize',
      params: {
        clientInfo: { name: 'openfit_desktop', title: 'OpenFit', version: '1.0.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
    })
    expect(child.messages[1]).toEqual({ method: 'initialized' })
    expect(child.messages.filter((message) => message.method === 'thread/start')).toHaveLength(1)
    expect(child.messages[2]).toMatchObject({
      method: 'thread/start',
      params: {
        cwd: '/mock/openfit',
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ephemeral: true,
      },
    })
    expect(child.messages[2].params?.developerInstructions).toContain('health-data assistant')
    expect(service.getStatus()).toMatchObject({ state: 'ready', connected: true, threadId: 'thread-health' })

    await service.dispose()
  })

  it('sends compact health context and streams agent deltas through final completion', async () => {
    const onDelta = vi.fn()
    const onComplete = vi.fn()
    let turnRequest: ProtocolMessage | undefined
    const child = new FakeChild((message, current) => {
      if (message.method === 'initialize') respond(current, message)
      if (message.method === 'thread/start') respond(current, message, { thread: { id: 'thread-1' } })
      if (message.method === 'turn/start') {
        turnRequest = message
        respond(current, message, { turn: { id: 'turn-1', status: 'inProgress' } })
        queueMicrotask(() => queueMicrotask(() => {
          current.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1', delta: 'Hai dormito ' } })
          current.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'answer-1', delta: '7 ore.' } })
          current.send({
            method: 'item/completed',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              item: { type: 'agentMessage', id: 'answer-1', text: 'Hai dormito 7 ore.', phase: 'final_answer' },
            },
          })
          current.send({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } })
        }))
      }
    })
    const service = createCodexService({
      spawn: vi.fn(() => child),
      resolveBinary: () => '/mock/codex',
      requestTimeoutMs: 250,
      turnTimeoutMs: 1_000,
    })

    const result = await service.startTurn({
      text: 'Come ho dormito?',
      healthContext: { date: '2026-06-23', sleepMinutes: 420, missing: null },
      onDelta,
      onComplete,
    })

    expect(turnRequest?.params).toMatchObject({
      threadId: 'thread-1',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    })
    expect(turnRequest?.params?.input).toEqual([
      {
        type: 'text',
        text: '<OPENFIT_HEALTH_CONTEXT>\n{"date":"2026-06-23","sleepMinutes":420,"missing":null}\n</OPENFIT_HEALTH_CONTEXT>',
        text_elements: [],
      },
      { type: 'text', text: 'Come ho dormito?', text_elements: [] },
    ])
    expect(onDelta.mock.calls.map(([delta]) => delta)).toEqual(['Hai dormito ', '7 ore.'])
    expect(result).toEqual({ threadId: 'thread-1', turnId: 'turn-1', status: 'completed', text: 'Hai dormito 7 ore.' })
    expect(onComplete).toHaveBeenCalledWith(result)
    expect(service.getStatus()).toMatchObject({ state: 'ready', busy: false, threadId: 'thread-1' })

    await service.dispose()
  })

  it('reports a missing Codex binary without spawning', async () => {
    const spawn = vi.fn()
    const service = createCodexService({ spawn, resolveBinary: () => null, requestTimeoutMs: 50 })

    await expect(service.start()).rejects.toMatchObject({ code: 'CODEX_BINARY_NOT_FOUND' })
    expect(spawn).not.toHaveBeenCalled()
    expect(service.getStatus()).toMatchObject({ state: 'error', available: false, connected: false })
  })

  it('handles process errors without exposing stderr or authentication material', async () => {
    const child = new FakeChild()
    const spawn = vi.fn(() => {
      queueMicrotask(() => {
        child.stderr.write('Authorization: Bearer super-secret-token sk-also-secret')
        child.emit('error', Object.assign(new Error('sk-error-secret'), { code: 'ENOENT' }))
      })
      return child
    })
    const service = createCodexService({
      spawn,
      resolveBinary: () => '/mock/codex',
      requestTimeoutMs: 250,
      terminationGraceMs: 10,
    })

    let caught: any
    try { await service.start() } catch (error) { caught = error }
    expect(caught).toMatchObject({ code: 'CODEX_SPAWN_FAILED' })
    expect(caught.message).toContain('Could not start Codex app-server (ENOENT).')
    expect(caught.message).not.toContain('super-secret')
    expect(caught.message).not.toContain('sk-error-secret')
    expect(service.getStatus()).toMatchObject({ state: 'error', connected: false })
  })

  it('routes a tool call to the handler instead of refusing it', async () => {
    const onToolCall = vi.fn(async () => ({ ok: true, result: { n: 30 } }))
    const { service, sent, emit, completeTurn } = createStubbedService({ onToolCall })

    const turnPromise = service.startTurn({ text: 'x', healthContext: '{}', onToolCall })
    emit({ id: 7, method: 'item/tool/call', params: { name: 'metric_window', arguments: { metric: 'steps' } } })
    await vi.waitFor(() => expect(onToolCall).toHaveBeenCalledWith('metric_window', { metric: 'steps' }))

    const reply = await vi.waitFor(() => {
      const found = sent.find((message) => message.id === 7)
      expect(found).toBeTruthy()
      return found
    })
    expect(reply!.result?.success).toBe(true)
    expect(reply!.result?.contentItems).toEqual([{ type: 'inputText', text: JSON.stringify({ n: 30 }) }])

    completeTurn()
    await turnPromise
    await service.dispose()
  })

  it('refuses a tool call when no handler is configured', async () => {
    const { service, sent, emit, completeTurn } = createStubbedService()

    const turnPromise = service.startTurn({ text: 'x', healthContext: '{}' })
    emit({ id: 8, method: 'item/tool/call', params: { name: 'metric_window', arguments: {} } })

    const reply = await vi.waitFor(() => {
      const found = sent.find((message) => message.id === 8)
      expect(found).toBeTruthy()
      return found
    })
    expect(reply!.result?.success).toBe(false)

    completeTurn()
    await turnPromise
    await service.dispose()
  })

  it('answers with a failure result instead of crashing when the handler rejects', async () => {
    const onToolCall = vi.fn(async () => { throw new Error('boom') })
    const { service, sent, emit, completeTurn } = createStubbedService({ onToolCall })

    const turnPromise = service.startTurn({ text: 'x', healthContext: '{}', onToolCall })
    emit({ id: 9, method: 'item/tool/call', params: { name: 'metric_window', arguments: {} } })
    await vi.waitFor(() => expect(onToolCall).toHaveBeenCalled())

    const reply = await vi.waitFor(() => {
      const found = sent.find((message) => message.id === 9)
      expect(found).toBeTruthy()
      return found
    })
    expect(reply!.result?.success).toBe(false)

    completeTurn()
    await turnPromise
    await service.dispose()
  })
})
