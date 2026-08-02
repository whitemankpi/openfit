import { WebSocket } from 'ws'

const REQUEST_TIMEOUT_MS = 15_000
const TURN_TIMEOUT_MS = 3 * 60_000

type Pending = {
  method: string
  timer: NodeJS.Timeout
  resolve: (value: any) => void
  reject: (error: Error) => void
}

type ActiveTurn = {
  threadId: string
  turnId: string | null
  streamed: string
  final: string | null
  onDelta?: (delta: string) => void
  timer: NodeJS.Timeout
  resolve: (value: { text: string }) => void
  reject: (error: Error) => void
}

export type CodexClientOptions = {
  url: string
  token?: string
  cwd?: string
  developerInstructions: string
}

/** Minimal JSON-RPC client for a separately hosted Codex app-server. */
export class CodexWsClient {
  readonly #options: CodexClientOptions
  #socket: WebSocket | null = null
  #connectPromise: Promise<void> | null = null
  #nextId = 1
  #pending = new Map<string, Pending>()
  #threadId: string | null = null
  #lastContext: string | null = null
  #active: ActiveTurn | null = null

  constructor(options: CodexClientOptions) {
    this.#options = options
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN
  }

  async startTurn(input: { text: string; context: string; onDelta?: (delta: string) => void }): Promise<{ text: string }> {
    if (this.#active) throw new Error('A Codex turn is already running.')
    await this.#ensureThread()
    const threadId = this.#threadId as string
    const items: Array<{ type: 'text'; text: string; text_elements: never[] }> = []
    if (input.context && input.context !== this.#lastContext) {
      items.push({ type: 'text', text: `<OPENFIT_HEALTH_CONTEXT>\n${input.context}\n</OPENFIT_HEALTH_CONTEXT>`, text_elements: [] })
    }
    items.push({ type: 'text', text: input.text, text_elements: [] })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const active = this.#active
        this.#active = null
        reject(new Error('Codex turn timed out.'))
        if (active?.turnId) void this.#request('turn/interrupt', { threadId, turnId: active.turnId }).catch(() => undefined)
      }, TURN_TIMEOUT_MS)
      timer.unref()
      this.#active = { threadId, turnId: null, streamed: '', final: null, onDelta: input.onDelta, timer, resolve, reject }
      void this.#request('turn/start', {
        threadId,
        input: items,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      }).then((response) => {
        if (!this.#active) return
        const turnId = response?.turn?.id
        if (!turnId) throw new Error('Codex returned an invalid turn.')
        this.#active.turnId = turnId
        if (items.length > 1) this.#lastContext = input.context
      }).catch((error) => this.#failActive(error))
    })
  }

  async reset(): Promise<void> {
    await this.cancel()
    this.#threadId = null
    this.#lastContext = null
  }

  async cancel(): Promise<void> {
    const active = this.#active
    if (!active) return
    this.#active = null
    clearTimeout(active.timer)
    if (active.turnId) await this.#request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }).catch(() => undefined)
    active.reject(Object.assign(new Error('Codex turn was cancelled.'), { name: 'AbortError' }))
  }

  close(): void {
    void this.cancel()
    this.#threadId = null
    this.#lastContext = null
    this.#socket?.close()
    this.#socket = null
    this.#rejectPending(new Error('Codex connection closed.'))
  }

  async #ensureThread(): Promise<void> {
    await this.#connect()
    if (this.#threadId) return
    const response = await this.#request('thread/start', {
      cwd: this.#options.cwd || '/data',
      approvalPolicy: 'never',
      sandbox: 'read-only',
      developerInstructions: this.#options.developerInstructions,
      ephemeral: true,
    })
    if (!response?.thread?.id) throw new Error('Codex returned an invalid thread.')
    this.#threadId = response.thread.id
  }

  async #connect(): Promise<void> {
    if (this.connected) return
    if (this.#connectPromise) return this.#connectPromise
    const promise = new Promise<void>((resolve, reject) => {
      const headers = this.#options.token ? { Authorization: `Bearer ${this.#options.token}` } : undefined
      const socket = new WebSocket(this.#options.url, { headers })
      this.#socket = socket
      const fail = (error: Error) => {
        if (this.#socket === socket) this.#socket = null
        reject(error)
      }
      socket.once('error', fail)
      socket.once('open', () => {
        socket.off('error', fail)
        socket.on('error', (error) => this.#fatal(error))
        socket.on('close', () => this.#fatal(new Error('Codex app-server disconnected.')))
        socket.on('message', (data) => this.#message(String(data)))
        void this.#request('initialize', {
          clientInfo: { name: 'openfit_hosted', title: 'OpenFit hosted', version: '1.0.0' },
          capabilities: { experimentalApi: false, requestAttestation: false },
        }).then(() => {
          this.#notify('initialized')
          resolve()
        }).catch(reject)
      })
    })
    this.#connectPromise = promise
    try { await promise } finally {
      if (this.#connectPromise === promise) this.#connectPromise = null
    }
  }

  #message(raw: string): void {
    let message: any
    try { message = JSON.parse(raw) } catch { this.#fatal(new Error('Codex sent malformed JSON.')); return }
    if (typeof message?.method === 'string') {
      if (Object.prototype.hasOwnProperty.call(message, 'id')) this.#serverRequest(message)
      else this.#notification(message.method, message.params || {})
      return
    }
    const pending = this.#pending.get(String(message?.id))
    if (!pending) return
    this.#pending.delete(String(message.id))
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(`Codex rejected ${pending.method}: ${String(message.error.message || 'unknown error').slice(0, 400)}`))
    else pending.resolve(message.result)
  }

  #serverRequest(message: any): void {
    const method = String(message.method)
    const result = method.includes('requestApproval') || method === 'applyPatchApproval' || method === 'execCommandApproval'
      ? { decision: 'denied' }
      : method === 'item/permissions/requestApproval'
        ? { permissions: {}, scope: 'turn' }
        : method === 'item/tool/requestUserInput'
          ? { answers: {} }
          : null
    if (result) this.#write({ id: message.id, result })
    else this.#write({ id: message.id, error: { code: -32601, message: 'Unsupported by OpenFit.' } })
  }

  #notification(method: string, params: any): void {
    const active = this.#active
    if (!active) return
    const incomingTurn = params.turnId || params.turn?.id
    if (incomingTurn && active.turnId && incomingTurn !== active.turnId) return
    if (incomingTurn && !active.turnId) active.turnId = incomingTurn
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      active.streamed += params.delta
      active.onDelta?.(params.delta)
    } else if (method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
      active.final = params.item.text
    } else if (method === 'turn/completed') {
      this.#active = null
      clearTimeout(active.timer)
      if (params.turn?.status === 'failed') active.reject(new Error(String(params.turn?.error?.message || 'Codex turn failed.').slice(0, 400)))
      else active.resolve({ text: active.final ?? active.streamed })
    }
  }

  #request(method: string, params: unknown): Promise<any> {
    if (!this.connected) return Promise.reject(new Error('Codex app-server is not connected.'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(String(id))
        reject(new Error(`Codex timed out handling ${method}.`))
      }, REQUEST_TIMEOUT_MS)
      timer.unref()
      this.#pending.set(String(id), { method, timer, resolve, reject })
      this.#write({ id, method, params })
    })
  }

  #notify(method: string, params?: unknown): void {
    this.#write(params === undefined ? { method } : { method, params })
  }

  #write(message: unknown): void {
    if (!this.connected) throw new Error('Codex app-server is not connected.')
    this.#socket?.send(JSON.stringify(message))
  }

  #failActive(error: unknown): void {
    const active = this.#active
    if (!active) return
    this.#active = null
    clearTimeout(active.timer)
    active.reject(error instanceof Error ? error : new Error('Codex turn failed.'))
  }

  #fatal(error: Error): void {
    this.#socket = null
    this.#threadId = null
    this.#lastContext = null
    this.#rejectPending(error)
    this.#failActive(error)
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}
