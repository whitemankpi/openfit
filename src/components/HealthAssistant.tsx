import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAssistantRuntime,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
} from '@assistant-ui/react'
import { ArrowDown, ArrowUp, Plus, Sparkles, Square, X } from 'lucide-react'
import type { History } from '@/data/history'
import {
  parseAssistantNavigation,
  stripAssistantNavigation,
  visibleAssistantText,
  type AssistantNavigation,
} from '@/lib/health-assistant'
import { ASSISTANT_TOOLS, TOOL_NAMES, runTool } from '@/lib/assistant-tools'
import { buildAssistantManifest } from '@/lib/assistant-manifest'
import type {
  DashboardData,
  HealthAssistantEvent,
  HealthAssistantStatus,
  PageId,
} from '@/types'

const unavailableStatus: HealthAssistantStatus = {
  provider: null,
  available: false,
  connected: false,
  authenticated: false,
  version: null,
}

function providerName(provider: HealthAssistantStatus['provider']) {
  return provider === 'deepseek' ? 'DeepSeek' : 'Codex'
}

function messageText(message: ThreadMessage | undefined) {
  if (!message) return ''
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
}

function statusLabel(status: HealthAssistantStatus, hasBridge: boolean) {
  if (!hasBridge) return 'Desktop only'
  const name = providerName(status.provider)
  if (!status.available) return `${name} not found`
  if (!status.authenticated) return status.provider === 'deepseek' ? 'Check DeepSeek API key' : 'Sign in to Codex'
  return status.connected ? `${name} connected` : `${name} ready`
}

function createQueue() {
  const events: HealthAssistantEvent[] = []
  let wake: ((event: HealthAssistantEvent) => void) | null = null

  return {
    push(event: HealthAssistantEvent) {
      if (wake) {
        const resolve = wake
        wake = null
        resolve(event)
      } else {
        events.push(event)
      }
    },
    next() {
      const event = events.shift()
      if (event) return Promise.resolve(event)
      return new Promise<HealthAssistantEvent>((resolve) => { wake = resolve })
    },
  }
}

export function HealthAssistant({
  open,
  data,
  history,
  page,
  onOpenChange,
  onNavigate,
}: {
  open: boolean
  data: DashboardData
  history: History
  page: PageId
  onOpenChange: (open: boolean) => void
  onNavigate: (navigation: AssistantNavigation) => void
}) {
  const dataRef = useRef(data)
  const historyRef = useRef(history)
  const pageRef = useRef(page)
  const navigateRef = useRef(onNavigate)
  const [status, setStatus] = useState(unavailableStatus)
  const statusRef = useRef(status)
  const [toolActivity, setToolActivity] = useState<string[]>([])

  useEffect(() => { dataRef.current = data }, [data])
  useEffect(() => { historyRef.current = history }, [history])
  useEffect(() => { pageRef.current = page }, [page])
  useEffect(() => { navigateRef.current = onNavigate }, [onNavigate])
  useEffect(() => { statusRef.current = status }, [status])

  useEffect(() => window.healthAssistant?.onToolRequest(async (request) => {
    try {
      const result = runTool(request.name, request.args, {
        data: dataRef.current,
        history: historyRef.current,
      })
      await window.healthAssistant?.respondToTool({ callId: request.callId, result })
    } catch (error) {
      await window.healthAssistant?.respondToTool({
        callId: request.callId,
        error: error instanceof Error ? error.message : 'Tool failed.',
      })
    }
  }), [])

  const refreshStatus = useCallback(async () => {
    if (!window.healthAssistant) {
      setStatus(unavailableStatus)
      return
    }
    try {
      setStatus(await window.healthAssistant.getStatus())
    } catch (error) {
      setStatus({
        ...unavailableStatus,
        error: error instanceof Error ? error.message : 'The health assistant is unavailable.',
      })
    }
  }, [])

  useEffect(() => { void refreshStatus() }, [refreshStatus])
  useEffect(() => {
    if (open) void refreshStatus()
  }, [open, refreshStatus])

  const modelAdapter = useMemo<ChatModelAdapter>(() => ({
    async *run({ messages, abortSignal }) {
      const bridge = window.healthAssistant
      if (!bridge) throw new Error('Launch OpenFit in the desktop app to use the health assistant.')

      const prompt = messageText(messages.at(-1))
      if (!prompt) throw new Error('Write a question before sending it.')

      const healthContext = buildAssistantManifest(dataRef.current, historyRef.current, pageRef.current)
      const requestId = crypto.randomUUID()
      const queue = createQueue()
      let fullText = ''
      let lastVisibleText = ''
      let completed = false

      setToolActivity([])
      const unsubscribe = bridge.onEvent((event) => {
        if (event.requestId === requestId) queue.push(event)
      })
      const onAbort = () => queue.push({ requestId, type: 'cancelled' })
      abortSignal.addEventListener('abort', onAbort, { once: true })

      try {
        await bridge.startTurn({
          requestId,
          message: prompt,
          healthContext,
          tools: ASSISTANT_TOOLS.map((tool) => ({ name: tool.name, description: tool.description, schema: tool.schema })),
          toolNames: TOOL_NAMES,
        })
        void refreshStatus()

        while (!completed) {
          const event = await queue.next()
          if (event.type === 'delta') {
            fullText += event.delta
            const visible = visibleAssistantText(fullText)
            if (visible && visible !== lastVisibleText) {
              lastVisibleText = visible
              yield { content: [{ type: 'text', text: visible }] }
            }
          } else if (event.type === 'complete') {
            completed = true
            if (event.text) fullText = event.text
          } else if (event.type === 'error') {
            throw new Error(event.message)
          } else if (event.type === 'tool') {
            setToolActivity((entries) => [...entries, `${event.name}${event.ok ? '' : ' failed'}`])
          } else {
            return
          }
        }

        const navigation = parseAssistantNavigation(fullText)
        const finalText = stripAssistantNavigation(fullText)
        if (navigation) navigateRef.current(navigation)
        if (!finalText) throw new Error(`${providerName(statusRef.current.provider)} completed the turn without a response.`)
        if (finalText !== lastVisibleText) {
          yield { content: [{ type: 'text', text: finalText }] }
        }
      } finally {
        abortSignal.removeEventListener('abort', onAbort)
        unsubscribe()
        if (!completed || abortSignal.aborted) void bridge.cancel(requestId)
        void refreshStatus()
      }
    },
  }), [refreshStatus])

  const runtime = useLocalRuntime(modelAdapter)
  const ready = Boolean(window.healthAssistant && status.available && status.authenticated)

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <aside
        id="health-assistant"
        className={`health-assistant ${open ? 'is-open' : ''}`}
        aria-label="Health assistant"
        aria-hidden={!open}
        inert={!open}
      >
        <AssistantHeader
          status={status}
          ready={ready}
          onClose={() => onOpenChange(false)}
          onStatusRefresh={refreshStatus}
        />
        <AssistantThread ready={ready} toolActivity={toolActivity} status={status} />
      </aside>
      {open && <button className="assistant-scrim" aria-label="Close health assistant" onClick={() => onOpenChange(false)} />}
    </AssistantRuntimeProvider>
  )
}

function AssistantHeader({
  status,
  ready,
  onClose,
  onStatusRefresh,
}: {
  status: HealthAssistantStatus
  ready: boolean
  onClose: () => void
  onStatusRefresh: () => Promise<void>
}) {
  const runtime = useAssistantRuntime()

  const newConversation = async () => {
    runtime.thread.cancelRun()
    runtime.thread.reset()
    await window.healthAssistant?.reset()
    await onStatusRefresh()
  }

  return (
    <header className="assistant-header">
      <div className="assistant-title">
        <span className="assistant-mark"><Sparkles aria-hidden="true" /></span>
        <span>
          <strong>Health assistant</strong>
          <small><i className={ready ? 'is-ready' : ''} />{statusLabel(status, Boolean(window.healthAssistant))}</small>
        </span>
      </div>
      <div className="assistant-header-actions">
        <button type="button" aria-label="New conversation" title="New conversation" onClick={() => void newConversation()}>
          <Plus aria-hidden="true" />
        </button>
        <button type="button" aria-label="Close assistant" title="Close" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}

function AssistantThread({
  ready,
  toolActivity,
  status,
}: {
  ready: boolean
  toolActivity: string[]
  status: HealthAssistantStatus
}) {
  return (
    <ThreadPrimitive.Root className="assistant-thread">
      <ThreadPrimitive.Viewport className="assistant-viewport">
        <AuiIf condition={(state) => state.thread.isEmpty}>
          <div className="assistant-welcome">
            <h2>Ask your health data.</h2>
            <p>I can compare days, explain trends, and take you to the relevant view.</p>
            <div className="assistant-suggestions" aria-label="Suggested questions">
              <ThreadPrimitive.Suggestion prompt="How did I sleep last night?" send disabled={!ready}>How did I sleep?</ThreadPrimitive.Suggestion>
              <ThreadPrimitive.Suggestion prompt="Compare my activity over the last seven days." send disabled={!ready}>Compare this week</ThreadPrimitive.Suggestion>
              <ThreadPrimitive.Suggestion prompt="Show me my heart health data." send disabled={!ready}>Open heart data</ThreadPrimitive.Suggestion>
            </div>
          </div>
        </AuiIf>

        {toolActivity.length > 0 && (
          <ul className="assistant-tool-activity">
            {toolActivity.map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)}
          </ul>
        )}

        <div className="assistant-messages">
          <ThreadPrimitive.Messages>
            {({ message }) => message.role === 'user' ? <UserMessage /> : <AssistantMessage />}
          </ThreadPrimitive.Messages>
        </div>

        <ThreadPrimitive.ViewportFooter className="assistant-viewport-footer">
          <ThreadPrimitive.ScrollToBottom className="assistant-scroll-bottom" aria-label="Scroll to latest response">
            <ArrowDown aria-hidden="true" />
          </ThreadPrimitive.ScrollToBottom>
          <ComposerPrimitive.Root className="assistant-composer">
            <ComposerPrimitive.Input
              className="assistant-composer-input"
              rows={1}
              disabled={!ready}
              placeholder={ready
                ? 'Ask about your health…'
                : status.provider === 'deepseek' ? 'Add a DeepSeek API key to chat' : 'Connect Codex Desktop to chat'}
              aria-label="Message health assistant"
            />
            <AuiIf condition={(state) => !state.thread.isRunning}>
              <ComposerPrimitive.Send className="assistant-send" disabled={!ready} aria-label="Send message">
                <ArrowUp aria-hidden="true" />
              </ComposerPrimitive.Send>
            </AuiIf>
            <AuiIf condition={(state) => state.thread.isRunning}>
              <ComposerPrimitive.Cancel className="assistant-send is-cancel" aria-label="Stop response">
                <Square aria-hidden="true" />
              </ComposerPrimitive.Cancel>
            </AuiIf>
          </ComposerPrimitive.Root>
          <p className="assistant-disclaimer">Health context, not medical advice.</p>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="assistant-user-message">
      <div><MessagePrimitive.Parts /></div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="assistant-ai-message">
      <span className="assistant-response-mark" aria-hidden="true">+</span>
      <div><MessagePrimitive.Parts /></div>
    </MessagePrimitive.Root>
  )
}
