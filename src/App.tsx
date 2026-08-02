import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ChevronsUpDown, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { AssistantConfig, AssistantProvider, DashboardData, FitbitAuthStatus, FitbitConfigInput, HealthProvider, PageId, RawHealthArchive } from '@/types'
import { createDemoData, createDemoHistory, localIso } from '@/data/demo'
import { availableDays, buildHistory, mergeTrendWindow, type RangeDays } from '@/data/history'
import { normalizeFitbitData } from '@/data/normalize'
import { formatDate, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { computeScores } from '@/lib/scores'
import { ActivityView, BodyView, DevicesView, HealthView, SleepView, TodayView } from '@/components/Views'
import { HealthAssistant } from '@/components/HealthAssistant'
import type { AssistantNavigation } from '@/lib/health-assistant'
import type { AppIcon } from '@/components/icons'
import {
  ActivityIcon,
  BodyIcon,
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  CloudIcon,
  DeviceIcon,
  DisconnectIcon,
  ExportIcon,
  ExternalIcon,
  HeartIcon,
  LoaderIcon,
  SettingsIcon,
  ShieldIcon,
  SleepIcon,
  SparkleIcon,
  StepsIcon,
  TodayIcon,
} from '@/components/icons'

type NavCategory = 'summary' | 'activity' | 'heart' | 'sleep' | 'body' | 'device'

const navItems: Array<{ id: PageId; label: string; copy: string; icon: AppIcon; category: NavCategory }> = [
  { id: 'today', label: 'Today', copy: 'The day’s essential overview.', icon: TodayIcon, category: 'summary' },
  { id: 'activity', label: 'Activity', copy: 'Goals, hourly distribution, and workouts.', icon: ActivityIcon, category: 'activity' },
  { id: 'health', label: 'Health', copy: 'Cardiac and physiological signals over time.', icon: HeartIcon, category: 'heart' },
  { id: 'sleep', label: 'Sleep', copy: 'Duration, quality, and composition of your latest night’s sleep.', icon: SleepIcon, category: 'sleep' },
  { id: 'body', label: 'Body', copy: 'Weight, composition, and daily balance.', icon: BodyIcon, category: 'body' },
  { id: 'devices', label: 'Data', copy: 'Sources, coverage, and local protection.', icon: DeviceIcon, category: 'device' },
]

const defaultStatus: FitbitAuthStatus = {
  isElectron: Boolean(window.fitbit),
  configured: false,
  connected: false,
  clientId: '',
  redirectUri: 'http://127.0.0.1:42813/oauth/callback',
  hasClientSecret: false,
  storageEncrypted: false,
  lastSyncAt: null,
  provider: 'google-health',
  googleFitAuthorized: false,
}

interface ToastState {
  tone: 'success' | 'error' | 'neutral'
  message: string
}

interface SyncProgressState {
  completed: number
  total: number
  key?: string
  date?: string
}

function shiftDate(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number)
  return localIso(new Date(year, month - 1, day + days, 12))
}

function IconButton({ label, children, ...props }: { label: string; children: ReactNode } & React.ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger asChild><Button aria-label={label} variant="ghost" size="icon" {...props}>{children}</Button></TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export default function App() {
  const [page, setPage] = useState<PageId>('today')
  const [selectedDate, setSelectedDate] = useState(localIso())
  const [data, setData] = useState<DashboardData>(() => createDemoData())
  const [status, setStatus] = useState(defaultStatus)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncTargetDate, setSyncTargetDate] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [syncProgress, setSyncProgress] = useState<SyncProgressState | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [archive, setArchive] = useState<RawHealthArchive | null>(null)
  const [rangeDays, setRangeDays] = useState<RangeDays>(30)
  const [assistantConfig, setAssistantConfig] = useState<AssistantConfig>({ provider: 'codex', hasApiKey: false, proactiveInsights: false, dailyInsights: true, weeklyInsights: true })
  const selectedDateRef = useRef(selectedDate)
  const dataDateRef = useRef(data.selectedDate)
  const syncingRef = useRef(false)
  const syncTargetDateRef = useRef<string | null>(null)
  const queuedDateRef = useRef<string | null>(null)
  const initialSyncDateRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [page])

  useEffect(() => {
    selectedDateRef.current = selectedDate
  }, [selectedDate])

  useEffect(() => {
    dataDateRef.current = data.selectedDate
  }, [data.selectedDate])

  // Trends are read from the encrypted per-day archive rather than the trailing
  // window inside a single payload, so the range selector can reach past it.
  const refreshArchive = useCallback(async () => {
    if (!window.fitbit) return
    try {
      setArchive(await window.fitbit.getCachedArchive())
    } catch (error) {
      console.warn('Unable to read the local health archive.', error)
    }
  }, [])

  const loadNativeState = useCallback(async () => {
    if (!window.fitbit) return
    void refreshArchive()
    try {
      const [nextStatus, cached] = await Promise.all([window.fitbit.getStatus(), window.fitbit.getCachedData()])
      setStatus(nextStatus)
      if (cached) {
        const normalized = normalizeFitbitData(cached)
        dataDateRef.current = normalized.selectedDate
        setData({ ...normalized, source: 'cache' })
        if (!nextStatus.connected || normalized.selectedDate >= selectedDateRef.current) {
          selectedDateRef.current = normalized.selectedDate
          setSelectedDate(normalized.selectedDate)
        }
      }
    } catch (error) {
      setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Unable to read the local status.' })
    }
    if (window.healthAssistant) {
      try {
        setAssistantConfig(await window.healthAssistant.getConfig())
      } catch (error) {
        console.warn('Unable to read the assistant configuration.', error)
      }
    }
  }, [refreshArchive])

  const runSync = useCallback(async (requestedDate?: string) => {
    if (!window.fitbit) {
      setSettingsOpen(true)
      return
    }

    const firstDate = requestedDate ?? selectedDateRef.current
    if (syncingRef.current) {
      queuedDateRef.current = firstDate
      return
    }

    syncingRef.current = true
    setSyncing(true)
    let nextDate: string | null = firstDate

    try {
      while (nextDate) {
        const date: string = nextDate
        queuedDateRef.current = null
        syncTargetDateRef.current = date
        setSyncTargetDate(date)
        setSyncProgress({ completed: 0, total: 0 })

        try {
          const payload = await window.fitbit.sync(date)
          const normalized = normalizeFitbitData(payload)

          if (selectedDateRef.current === date) {
            dataDateRef.current = normalized.selectedDate
            setData(normalized)
            setToast({
              tone: payload.cacheHit || payload.errors.length ? 'neutral' : 'success',
              message: payload.cacheHit
                ? 'Day loaded from the local archive.'
                : payload.errors.length
                ? `Updated. ${payload.errors.length} sources have no data for this period.`
                : 'Data updated.',
            })
          }

          void window.fitbit.getStatus().then(setStatus).catch(() => undefined)
        } catch (error) {
          const queuedDate = queuedDateRef.current
          const failedDateIsStillSelected = selectedDateRef.current === date
          const hasDifferentDateQueued = Boolean(queuedDate && queuedDate !== date)

          if (failedDateIsStillSelected && !hasDifferentDateQueued) {
            selectedDateRef.current = dataDateRef.current
            setSelectedDate(dataDateRef.current)
            setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Sync failed.' })
          }
        }

        const queuedDate = queuedDateRef.current
        queuedDateRef.current = null
        nextDate = queuedDate && queuedDate !== date ? queuedDate : null
      }
    } finally {
      syncingRef.current = false
      syncTargetDateRef.current = null
      queuedDateRef.current = null
      setSyncing(false)
      setSyncTargetDate(null)
      setSyncProgress(null)
      void refreshArchive()
    }
  }, [refreshArchive])

  useEffect(() => {
    const requestedDate = selectedDateRef.current
    if (!status.connected || data.source !== 'cache' || data.selectedDate >= requestedDate) return
    if (initialSyncDateRef.current === requestedDate) return
    initialSyncDateRef.current = requestedDate
    void runSync(requestedDate)
  }, [data.selectedDate, data.source, runSync, status.connected])

  useEffect(() => {
    void loadNativeState()
    const bridge = window.fitbit
    if (!bridge) return
    const unsubscribeAuth = bridge.onAuthComplete(async (result) => {
      setConnecting(false)
      if (!result.ok) {
        setToast({ tone: 'error', message: result.error ?? 'Authorization failed.' })
        return
      }
      setSettingsOpen(false)
      const authDate = selectedDateRef.current
      setToast({ tone: 'success', message: 'Account connected. Syncing data…' })
      await loadNativeState()
      selectedDateRef.current = authDate
      setSelectedDate(authDate)
      void runSync(authDate)
    })
    const unsubscribeSync = bridge.onSyncProgress((progress) => {
      if (syncingRef.current && (!progress.date || progress.date === syncTargetDateRef.current)) {
        setSyncProgress(progress)
      }
    })
    const unsubscribeDataUpdated = bridge.onDataUpdated(async (event) => {
      try {
        const nextStatus = await bridge.getStatus()
        setStatus(nextStatus)
        if (event.date !== selectedDateRef.current || syncingRef.current) return
        const nextArchive = await bridge.getCachedArchive()
        setArchive(nextArchive)
        const cached = nextArchive.days[event.date]
        if (!cached) return
        const normalized = normalizeFitbitData(cached)
        dataDateRef.current = normalized.selectedDate
        setData({ ...normalized, source: 'cache' })
        setToast({ tone: 'success', message: 'New health data arrived automatically.' })
      } catch (error) {
        console.warn('Unable to apply the background health update.', error)
      }
    })
    return () => {
      unsubscribeAuth()
      unsubscribeSync()
      unsubscribeDataUpdated()
    }
  }, [loadNativeState, runSync])

  useEffect(() => {
    if (!toast) return
    if (toast.tone === 'error') return
    const timer = window.setTimeout(() => setToast(null), 4_500)
    return () => window.clearTimeout(timer)
  }, [toast])

  const visibleNav = navItems

  const changeDate = (date: string) => {
    if (!date || date > localIso()) return
    selectedDateRef.current = date
    setSelectedDate(date)
    if (data.source === 'demo' && !status.connected) {
      const demoData = createDemoData(date)
      dataDateRef.current = demoData.selectedDate
      setData(demoData)
      return
    }
    if (status.connected) void runSync(date)
  }

  const connect = async () => {
    if (!window.fitbit) {
      setToast({ tone: 'neutral', message: 'Launch OpenFit in the Electron app to connect your health provider.' })
      return
    }
    if (!status.configured) {
      setSettingsOpen(true)
      return
    }
    setConnecting(true)
    try {
      const result = await window.fitbit.connect()
      if (!result.ok) throw new Error(result.message ?? 'Unable to start OAuth.')
      setToast({ tone: 'neutral', message: 'Complete authorization in your browser.' })
    } catch (error) {
      setConnecting(false)
      setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Connection failed.' })
    }
  }

  const connectGoogleFit = async () => {
    if (!window.fitbit) return
    setConnecting(true)
    try {
      const result = await window.fitbit.connectGoogleFit()
      if (!result.ok) throw new Error(result.message ?? 'Unable to start Google Fit OAuth.')
      setToast({ tone: 'neutral', message: 'Authorize Google Fit step access in your browser.' })
    } catch (error) {
      setConnecting(false)
      setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Google Fit connection failed.' })
    }
  }

  const saveAndConnect = async (config: FitbitConfigInput) => {
    if (!window.fitbit) return
    try {
      const nextStatus = await window.fitbit.saveConfig(config)
      setStatus(nextStatus)
      setConnecting(true)
      const result = await window.fitbit.connect()
      if (!result.ok) throw new Error(result.message ?? 'Unable to start OAuth.')
      setToast({ tone: 'neutral', message: 'Authorize OpenFit in the browser window.' })
    } catch (error) {
      setConnecting(false)
      setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Invalid configuration.' })
    }
  }

  const saveAssistantConfig = async (input: { provider: AssistantProvider; apiKey?: string; proactiveInsights?: boolean; dailyInsights?: boolean; weeklyInsights?: boolean }) => {
    if (!window.healthAssistant) return false
    try {
      const saved = await window.healthAssistant.saveConfig(input)
      setAssistantConfig(saved)
      setToast({ tone: 'success', message: 'Assistant model updated.' })
      return true
    } catch (error) {
      setToast({ tone: 'error', message: error instanceof Error ? error.message : 'Unable to save the assistant configuration.' })
      return false
    }
  }

  const disconnect = async () => {
    if (!window.fitbit) return
    setStatus(await window.fitbit.disconnect())
    setData(createDemoData(selectedDate))
    setSettingsOpen(false)
    setPage('today')
    setToast({ tone: 'success', message: 'Account disconnected and local data removed.' })
  }

  const exportData = async () => {
    if (!window.fitbit || data.source === 'demo') {
      setToast({ tone: 'neutral', message: 'Connect Google Health to export real data.' })
      return
    }
    const result = await window.fitbit.exportData()
    if (!result.canceled) setToast({ tone: 'success', message: 'JSON archive exported.' })
  }

  // Normalising every archived day is not cheap at a year of history, so it is
  // recomputed only when the archive itself changes.
  const history = useMemo(
    () => data.source === 'demo' ? createDemoHistory(data.selectedDate) : buildHistory(archive),
    [archive, data.source, data.selectedDate],
  )
  const historyDays = availableDays(history, data.selectedDate)
  const rangedData = useMemo(
    () => ({ ...data, trends: mergeTrendWindow(history, data.trends, data.selectedDate, rangeDays) }),
    [data, history, rangeDays],
  )

  // Recovery/load/sleep-quality baselines need up to 90 days of trailing history
  // regardless of the chart range the user has picked, so scores are computed
  // from their own fixed window rather than `rangedData`.
  const scoreData = useMemo(
    () => ({ ...data, trends: mergeTrendWindow(history, data.trends, data.selectedDate, 90) }),
    [data, history],
  )
  const scores = useMemo(() => computeScores(scoreData, history), [scoreData, history])

  const currentView = useMemo(() => {
    const props = {
      data: rangedData,
      status,
      navigate: setPage,
      history,
      rangeDays,
      onRangeChange: setRangeDays,
      historyDays,
      scores,
    }
    if (page === 'activity') return <ActivityView {...props} />
    if (page === 'health') return <HealthView {...props} />
    if (page === 'sleep') return <SleepView {...props} />
    if (page === 'body') return <BodyView {...props} />
    if (page === 'devices') return <DevicesView {...props} />
    return <TodayView {...props} />
  }, [history, historyDays, page, rangeDays, rangedData, scores, status])

  const isToday = selectedDate === localIso()
  const sourceLabel = status.connected
    ? status.provider === 'fitbit-legacy' ? 'Fitbit legacy' : 'Google Health'
    : data.source === 'demo' ? 'Demo data' : 'Local cache'
  const pageMeta = navItems.find((item) => item.id === page) ?? navItems[0]
  const loadingSelectedDate = syncing && data.selectedDate !== selectedDate
  const selectedDateQueued = loadingSelectedDate && syncTargetDate !== null && syncTargetDate !== selectedDate
  const syncProgressPercent = syncProgress && syncProgress.total > 0
    ? Math.round(syncProgress.completed / syncProgress.total * 100)
    : null
  const syncProgressLabel = syncProgress?.total
    ? `${syncProgress.completed} of ${syncProgress.total} sources`
    : 'Starting secure sync…'
  const batteryLevel = data.device?.batteryLevel == null
    ? null
    : Math.max(0, Math.min(100, Math.round(data.device.batteryLevel)))

  const navigate = (nextPage: PageId) => {
    setPage(nextPage)
  }

  const navigateFromAssistant = (navigation: AssistantNavigation) => {
    if (navigation.date) changeDate(navigation.date)
    if (navigation.page) setPage(navigation.page)
  }

  return (
    <SidebarProvider className={cn('app-shell', assistantOpen && 'assistant-open')}>
      <div className="window-drag-region" />
      <OpenFitSidebar
        items={visibleNav}
        page={page}
        userName={data.profile.displayName}
        userAvatar={data.profile.avatar}
        sourceLabel={sourceLabel}
        onNavigate={navigate}
        onSettings={() => setSettingsOpen(true)}
      />

      <SidebarInset className="main-area">
        <header className="topbar">
          <div className="topbar-heading">
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarTrigger className="sidebar-trigger" aria-label="Toggle navigation" />
              </TooltipTrigger>
              <TooltipContent>Toggle navigation</TooltipContent>
            </Tooltip>
            <div>
              <h1>{pageMeta.label}</h1>
              <p className="topbar-meta">
                <span>{page === 'today' ? formatDate(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' }) : pageMeta.copy}</span>
              </p>
            </div>
          </div>

          <div className="topbar-actions">
            <div className="date-control">
              <IconButton label="Previous day" onClick={() => changeDate(shiftDate(selectedDate, -1))}><ChevronLeftIcon /></IconButton>
              <label className="date-picker">
                {loadingSelectedDate ? <LoaderCircle className="spin" aria-hidden="true" /> : <CalendarIcon aria-hidden="true" />}
                <span>{isToday ? 'Today' : formatDate(selectedDate, { day: 'numeric', month: 'short' })}</span>
                <input type="date" value={selectedDate} max={localIso()} onChange={(event) => changeDate(event.target.value)} />
              </label>
              <IconButton label="Next day" disabled={isToday} onClick={() => changeDate(shiftDate(selectedDate, 1))}><ChevronRightIcon /></IconButton>
            </div>

            {batteryLevel != null && (
              <div className="fitbit-battery" role="status" aria-label={`Fitbit battery ${batteryLevel}%`}>
                <span className="battery-glyph" aria-hidden="true">
                  <span className="battery-charge" style={{ width: `${batteryLevel}%` }} />
                </span>
                <span className="battery-percent">{batteryLevel}%</span>
              </div>
            )}

            <IconButton
              label={assistantOpen ? 'Close health assistant' : 'Open health assistant'}
              className={cn('assistant-toggle', assistantOpen && 'is-active')}
              aria-controls="health-assistant"
              aria-expanded={assistantOpen}
              onClick={() => setAssistantOpen((open) => !open)}
            >
              <Sparkles />
            </IconButton>
            {status.connected ? (
              <>
                {syncing && (
                  <span className="sync-status" role="status" aria-live="polite">
                    {syncProgress?.total ? `${syncProgress.completed}/${syncProgress.total}` : 'Syncing'}
                  </span>
                )}
                <IconButton
                  label={syncProgress?.total ? `Syncing data ${syncProgress.completed} of ${syncProgress.total}` : syncing ? 'Starting data sync' : 'Refresh data'}
                  className="refresh-button"
                  onClick={() => runSync()}
                  disabled={syncing}
                >
                  {syncing ? <LoaderCircle className="spin" /> : <RefreshCw />}
                </IconButton>
              </>
            ) : (
              <Button className="connect-button" aria-label={`Connect ${status.provider === 'fitbit-legacy' ? 'Fitbit legacy' : 'Google Health'}`} onClick={connect} disabled={connecting}>
                {connecting ? <LoaderIcon className="spin" /> : <CloudIcon />}<span>Connect</span>
              </Button>
            )}
          </div>
        </header>

        <div className="page-content" key={page} aria-busy={loadingSelectedDate}>
          {loadingSelectedDate ? (
            <div className="date-loading" role="status" aria-live="polite">
              <LoaderCircle className="spin" aria-hidden="true" />
              <div>
                <strong>
                  {selectedDateQueued
                    ? `${formatDate(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' })} is next`
                    : `Loading ${formatDate(selectedDate, { weekday: 'long', day: 'numeric', month: 'long' })}`}
                </strong>
                <span>
                  {selectedDateQueued && syncTargetDate
                    ? `Finishing ${formatDate(syncTargetDate, { day: 'numeric', month: 'short' })} first · ${syncProgressLabel}`
                    : syncProgressLabel}
                </span>
                <div
                  className={cn('date-loading-progress', syncProgressPercent === null && 'is-indeterminate')}
                  role="progressbar"
                  aria-label="Data sync progress"
                  aria-valuemin={0}
                  aria-valuemax={syncProgress?.total || 100}
                  aria-valuenow={syncProgress?.total ? syncProgress.completed : undefined}
                >
                  <i style={{ width: syncProgressPercent === null ? '32%' : `${syncProgressPercent}%` }} />
                </div>
                {selectedDateQueued && <small>You can keep moving between days; the latest selection loads next.</small>}
              </div>
            </div>
          ) : currentView}
        </div>
      </SidebarInset>

      <HealthAssistant
        open={assistantOpen}
        data={data}
        history={history}
        page={page}
        onOpenChange={setAssistantOpen}
        onNavigate={navigateFromAssistant}
      />

      <SettingsDialog
        open={settingsOpen}
        status={status}
        connecting={connecting}
        onOpenChange={setSettingsOpen}
        onSave={saveAndConnect}
        onConnect={connect}
        onConnectGoogleFit={connectGoogleFit}
        onExport={exportData}
        onDisconnect={disconnect}
        assistantConfig={assistantConfig}
        onSaveAssistantConfig={saveAssistantConfig}
      />

      {toast && (
        <div className={cn('toast', `toast-${toast.tone}`)} role={toast.tone === 'error' ? 'alert' : 'status'}>
          {toast.tone === 'success' ? <CheckIcon /> : toast.tone === 'error' ? <CloseIcon /> : <SparkleIcon />}
          <span>{toast.message}</span>
          <button className="toast-close" aria-label="Close notification" onClick={() => setToast(null)}><CloseIcon /></button>
        </div>
      )}
    </SidebarProvider>
  )
}

function OpenFitSidebar({
  items,
  page,
  userName,
  userAvatar,
  sourceLabel,
  onNavigate,
  onSettings,
}: {
  items: typeof navItems
  page: PageId
  userName: string
  userAvatar: string | null
  sourceLabel: string
  onNavigate: (page: PageId) => void
  onSettings: () => void
}) {
  const { setOpenMobile } = useSidebar()
  const initials = userName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || 'PB'
  const wellbeingItems = items.filter((item) => item.id !== 'devices')
  const dataItem = items.find((item) => item.id === 'devices')

  const selectPage = (nextPage: PageId) => {
    onNavigate(nextPage)
    setOpenMobile(false)
  }

  const openSettings = () => {
    setOpenMobile(false)
    onSettings()
  }

  return (
    <Sidebar collapsible="icon" className="pulse-sidebar">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="sidebar-workspace" tooltip="OpenFit" onClick={() => selectPage('today')}>
              <span className="sidebar-workspace-mark">
                <img src="./app-icon.png" alt="" aria-hidden="true" />
              </span>
              <span className="sidebar-workspace-copy">
                <strong>OpenFit</strong>
                <small>Health dashboard</small>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Wellbeing</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu aria-label="Main navigation">
              {wellbeingItems.map(({ id, label, icon: Icon, category }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    data-category={category}
                    isActive={page === id}
                    tooltip={label}
                    aria-current={page === id ? 'page' : undefined}
                    onClick={() => selectPage(id)}
                  >
                    <Icon aria-hidden="true" />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Management</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {dataItem && (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    data-category={dataItem.category}
                    isActive={page === dataItem.id}
                    tooltip={dataItem.label}
                    aria-current={page === dataItem.id ? 'page' : undefined}
                    onClick={() => selectPage(dataItem.id)}
                  >
                    <dataItem.icon aria-hidden="true" />
                    <span>{dataItem.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
              <SidebarMenuItem>
                <SidebarMenuButton tooltip="Settings" onClick={openSettings}>
                  <SettingsIcon />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="sidebar-user" tooltip={userName} onClick={openSettings}>
              <Avatar className="sidebar-user-avatar">
                {userAvatar && <AvatarImage src={userAvatar} alt="" />}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span className="sidebar-user-copy">
                <strong>{userName}</strong>
                <small>{sourceLabel}</small>
              </span>
              <ChevronsUpDown className="sidebar-switcher-icon" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

function SettingsDialog({
  open,
  status,
  connecting,
  onOpenChange,
  onSave,
  onConnect,
  onConnectGoogleFit,
  onExport,
  onDisconnect,
  assistantConfig,
  onSaveAssistantConfig,
}: {
  open: boolean
  status: FitbitAuthStatus
  connecting: boolean
  onOpenChange: (open: boolean) => void
  onSave: (config: FitbitConfigInput) => Promise<void>
  onConnect: () => Promise<void>
  onConnectGoogleFit: () => Promise<void>
  onExport: () => Promise<void>
  onDisconnect: () => Promise<void>
  assistantConfig: AssistantConfig
  onSaveAssistantConfig: (input: { provider: AssistantProvider; apiKey?: string; proactiveInsights?: boolean; dailyInsights?: boolean; weeklyInsights?: boolean }) => Promise<boolean>
}) {
  const [clientId, setClientId] = useState(status.clientId)
  const [clientSecret, setClientSecret] = useState('')
  const [redirectUri, setRedirectUri] = useState(status.redirectUri)
  const [provider, setProvider] = useState<HealthProvider>(status.provider)
  const [editing, setEditing] = useState(!status.configured)
  const [assistantProvider, setAssistantProvider] = useState<AssistantProvider>(assistantConfig.provider)
  const [deepSeekKey, setDeepSeekKey] = useState('')
  const [savingAssistant, setSavingAssistant] = useState(false)
  const [proactiveInsights, setProactiveInsights] = useState(Boolean(assistantConfig.proactiveInsights))
  const [dailyInsights, setDailyInsights] = useState(assistantConfig.dailyInsights !== false)
  const [weeklyInsights, setWeeklyInsights] = useState(assistantConfig.weeklyInsights !== false)

  useEffect(() => {
    if (!open) return
    setClientId(status.clientId)
    setRedirectUri(status.redirectUri)
    setProvider(status.provider)
    setClientSecret('')
    setEditing(!status.configured)
  }, [open, status])

  useEffect(() => {
    if (!open) return
    setAssistantProvider(assistantConfig.provider)
    setDeepSeekKey('')
    setProactiveInsights(Boolean(assistantConfig.proactiveInsights))
    setDailyInsights(assistantConfig.dailyInsights !== false)
    setWeeklyInsights(assistantConfig.weeklyInsights !== false)
  }, [open, assistantConfig])

  const secretRequired = provider === 'google-health'
  const providerLabel = provider === 'google-health' ? 'Google Health' : 'Fitbit legacy'
  const savedSecretMatchesProvider = status.hasClientSecret && status.provider === provider
  const canSave = status.storageEncrypted
    && clientId.trim().length > 2
    && (!secretRequired || clientSecret.trim().length > 4 || savedSecretMatchesProvider)
    && redirectUri.startsWith('http://127.0.0.1:')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSave) return
    void onSave({
      provider,
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim() || undefined,
      redirectUri: redirectUri.trim(),
    })
  }

  const assistantKeyMissing = assistantProvider === 'deepseek' && !deepSeekKey.trim() && !assistantConfig.hasApiKey
  const assistantUnchanged = assistantProvider === assistantConfig.provider && !deepSeekKey.trim()
    && proactiveInsights === Boolean(assistantConfig.proactiveInsights)
    && dailyInsights === (assistantConfig.dailyInsights !== false)
    && weeklyInsights === (assistantConfig.weeklyInsights !== false)

  const submitAssistant = async () => {
    setSavingAssistant(true)
    const ok = await onSaveAssistantConfig({
      provider: assistantProvider,
      ...(deepSeekKey.trim() ? { apiKey: deepSeekKey.trim() } : {}),
      proactiveInsights,
      dailyInsights,
      weeklyInsights,
    })
    setSavingAssistant(false)
    if (ok) setDeepSeekKey('')
  }

  const openDeveloperPortal = () => {
    const url = provider === 'google-health'
      ? 'https://console.cloud.google.com/apis/library/health.googleapis.com'
      : 'https://dev.fitbit.com/apps/new'
    if (window.fitbit) void window.fitbit.openExternal(url)
    else window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog" showCloseButton>
        <DialogHeader>
          <div className="dialog-icon"><CloudIcon /></div>
          <DialogTitle>{status.connected && !editing ? `${providerLabel} connected` : `Connect ${providerLabel}`}</DialogTitle>
          <DialogDescription>Your credentials and data remain encrypted on this computer.</DialogDescription>
        </DialogHeader>

        {status.connected && !editing ? (
          <div className="connected-state">
            <div className="connection-check"><CheckIcon /></div>
            <div><h3>Sync active</h3><p>Last updated {relativeTime(status.lastSyncAt)}.{status.provider === 'google-health' ? status.googleFitAuthorized ? ' Google Fit step access is active.' : ' Authorize Google Fit steps separately below.' : ''}</p></div>
            <div className="connected-actions">
              <Button onClick={onConnect} disabled={connecting}>{connecting ? <LoaderCircle className="spin" /> : <RefreshCw />} Reauthorize Google Health</Button>
              {status.provider === 'google-health' && (
                <Button variant="outline" onClick={onConnectGoogleFit} disabled={connecting}>
                  {connecting ? <LoaderCircle className="spin" /> : <ActivityIcon />}
                  {status.googleFitAuthorized ? 'Reauthorize Google Fit steps' : 'Authorize Google Fit steps'}
                </Button>
              )}
              <Button variant="outline" onClick={() => setEditing(true)}><SettingsIcon /> Edit configuration</Button>
              <Button variant="outline" onClick={() => void onExport()}><ExportIcon /> Export data</Button>
              <Button variant="destructive" onClick={() => void onDisconnect()}><DisconnectIcon /> Disconnect and delete local data</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="settings-form">
            <div className="provider-picker" role="radiogroup" aria-label="Health provider">
              <label className={cn(provider === 'google-health' && 'active')}>
                <input className="sr-only" type="radio" name="health-provider" value="google-health" checked={provider === 'google-health'} onChange={() => setProvider('google-health')} />
                <CloudIcon /><span><strong>Google Health</strong><small>API v4 · recommended</small></span>{provider === 'google-health' && <CheckIcon />}
              </label>
              <label className={cn(provider === 'fitbit-legacy' && 'active')}>
                <input className="sr-only" type="radio" name="health-provider" value="fitbit-legacy" checked={provider === 'fitbit-legacy'} onChange={() => setProvider('fitbit-legacy')} />
                <DeviceIcon /><span><strong>Fitbit legacy</strong><small>Temporary compatibility</small></span>{provider === 'fitbit-legacy' && <CheckIcon />}
              </label>
            </div>

            <div className="form-field">
              <Label htmlFor="client-id">OAuth Client ID</Label>
              <Input id="client-id" value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" />
            </div>
            {secretRequired && (
              <div className="form-field">
                <Label htmlFor="client-secret">Client Secret {savedSecretMatchesProvider && <span>· leave blank to keep the current one</span>}</Label>
                <Input id="client-secret" type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} placeholder={savedSecretMatchesProvider ? '••••••••••••' : ''} autoComplete="new-password" />
              </div>
            )}
            <div className="form-field">
              <Label htmlFor="callback-url">Callback URL</Label>
              <Input id="callback-url" value={redirectUri} onChange={(event) => setRedirectUri(event.target.value)} spellCheck={false} />
              <p>It must exactly match the URL configured in Google Cloud.</p>
            </div>

            <button type="button" className="portal-link" onClick={openDeveloperPortal}>Open developer console <ExternalIcon /></button>
            <div className="scope-note"><ShieldIcon /><p>Read-only permissions for activity, heart, sleep, and authorized measurements.</p></div>

            <DialogFooter className="settings-footer">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={!canSave || connecting}>{connecting ? <LoaderIcon className="spin" /> : <CloudIcon />} Save and connect</Button>
            </DialogFooter>
          </form>
        )}

        <div className="settings-section">
          <Label>Assistant model</Label>
          <div className="range-selector" role="group" aria-label="Assistant model">
            {((status.isElectron ? ['codex', 'deepseek'] : ['codex']) as AssistantProvider[]).map((option) => (
              <button
                key={option}
                type="button"
                className={cn('range-option', assistantProvider === option && 'is-selected')}
                aria-pressed={assistantProvider === option}
                onClick={() => setAssistantProvider(option)}
              >
                {option === 'codex' ? 'Codex' : 'DeepSeek'}
              </button>
            ))}
          </div>
          {assistantProvider === 'deepseek' && (
            <div className="form-field">
              <Label htmlFor="deepseek-key">DeepSeek API key</Label>
              <Input
                id="deepseek-key"
                type="password"
                autoComplete="off"
                placeholder={assistantConfig.hasApiKey ? 'Stored — leave blank to keep' : 'sk-…'}
                value={deepSeekKey}
                onChange={(event) => setDeepSeekKey(event.target.value)}
              />
            </div>
          )}
          <p className="settings-note">
            {status.isElectron ? 'Both options' : 'Codex'} sends the conversation to a remote model, so health data leaves this machine while you chat.
            {proactiveInsights && !status.isElectron
              ? ' Scheduled reports also send compact evidence while the chat is closed.'
              : ' Nothing is sent until you send a message.'}
          </p>
          {!status.isElectron && (
            <div className="form-field">
              <Label>Proactive insights</Label>
              <label><input type="checkbox" checked={proactiveInsights} onChange={(event) => setProactiveInsights(event.target.checked)} /> Allow encrypted daily/weekly Codex reports</label>
              <label><input type="checkbox" checked={dailyInsights} disabled={!proactiveInsights} onChange={(event) => setDailyInsights(event.target.checked)} /> Daily briefing after 08:00</label>
              <label><input type="checkbox" checked={weeklyInsights} disabled={!proactiveInsights} onChange={(event) => setWeeklyInsights(event.target.checked)} /> Weekly review on Monday</label>
              <p className="settings-note">Scheduled reports send a compact evidence manifest and requested aggregates to Codex even when the chat is closed.</p>
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            className="settings-section-save"
            disabled={savingAssistant || assistantKeyMissing || assistantUnchanged}
            onClick={() => void submitAssistant()}
          >
            {savingAssistant ? <LoaderCircle className="spin" /> : <SettingsIcon />} Save assistant model
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
