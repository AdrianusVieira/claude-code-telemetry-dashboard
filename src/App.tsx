import { useEffect, useMemo, useState } from 'react'
import { useTheme } from './useTheme'

type Event = { name: string; timestamp: number; durationMs: number | null; toolName: string; success: string }
type TokenPoint = { timestamp: number; input: number; output: number; cacheRead: number; cacheWrite: number; promptId: string }
type TokenBar = TokenPoint & { label: string; requestCount: number; context: string }
type PromptRecord = { id: string; timestamp: number; text: string | null; requests: number; tokens: number; costUsd: number | null }
type Session = {
  id: string; title: string; project: string; email: string; firstSeen: number | null; lastSeen: number | null
  starts: number; prompts: number; inputTokens: number; outputTokens: number; cacheReadTokens: number
  cacheCreationTokens: number; activeUserSeconds: number | null; activeCliSeconds: number | null
  estimatedCostUsd: number | null; apiRequests: number; errors: number; models: string[]
  medianRequestMs: number | null; activityCount: number; recentEvents: Event[]; tokenTimeline: TokenPoint[]
}
type Period = '7' | '30' | '90' | 'all'
const fmt = new Intl.NumberFormat()
const count = (value: number) => fmt.format(Math.round(value))
const shortCount = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 10_000 ? `${(value / 1_000).toFixed(1)}k` : count(value)
const duration = (seconds: number | null) => seconds == null ? 'Unavailable' : seconds >= 3600 ? `${(seconds / 3600).toFixed(1)}h` : seconds >= 60 ? `${Math.round(seconds / 60)}m` : `${Math.round(seconds)}s`
const date = (value: number | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'
const time = (value: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value))
const tokens = (s: Session) => s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens
const pointTokens = (point: TokenPoint) => point.input + point.output + point.cacheRead + point.cacheWrite
const eventLabels: Record<string, string> = {
  user_prompt: 'Prompt sent', assistant_response: 'Response completed', api_request: 'API request',
  api_error: 'API error', api_retries_exhausted: 'Retries exhausted', tool_result: 'Tool finished',
  compaction: 'Context compacted', subagent_completed: 'Subagent completed',
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="stat"><span className="stat-label">{label}</span><strong>{value}</strong><small>{hint}</small></div>
}

function ProjectPicker({ projects, selected, onChange }: { projects: string[]; selected: string[]; onChange: (values: string[]) => void }) {
  return <div className="filter-field"><span>Project</span><details className="project-picker"><summary>{selected.length ? `${selected.length} project${selected.length === 1 ? '' : 's'}` : 'All projects'}</summary>
    <div className="project-options"><button type="button" className="picker-all" aria-label="Select all projects" onClick={() => onChange([])}>All projects</button>
      {projects.map((project) => <label key={project}><input type="checkbox" aria-label={project} checked={selected.includes(project)} onChange={(event) => onChange(event.target.checked ? [...selected, project] : selected.filter((value) => value !== project))} />{project}</label>)}
    </div></details></div>
}

function ChatRow({ session, maxTokens, onClick }: { session: Session; maxTokens: number; onClick: () => void }) {
  return <button className="session-row" type="button" onClick={onClick}>
    <div className="row-top"><strong className="row-title">{session.title}</strong><span className="row-time">{date(session.lastSeen)}</span></div>
    <div className="row-meta"><span className="project-pill">{session.project}</span><span>{session.prompts} prompts</span><span>{session.apiRequests} API requests</span><span>{session.starts} starts</span></div>
    <div className="row-bottom"><span>{shortCount(tokens(session))} tokens</span><span className="mini-track"><span className="mini-fill" style={{ width: `${Math.max(2, tokens(session) / maxTokens * 100)}%` }} /></span><span aria-hidden="true">→</span></div>
  </button>
}

function TokenBreakdown({ session }: { session: Session }) {
  const total = tokens(session)
  const parts = [
    { key: 'input', label: 'Input', value: session.inputTokens },
    { key: 'output', label: 'Output', value: session.outputTokens },
    { key: 'read', label: 'Cache read', value: session.cacheReadTokens },
    { key: 'create', label: 'Cache write', value: session.cacheCreationTokens },
  ]
  const tooltip = (part: typeof parts[number]) => `${part.label}: ${count(part.value)} tokens (${total ? (part.value / total * 100).toFixed(1) : '0.0'}%)`
  return <div className="breakdown"><h3>Token breakdown</h3><div className="token-bar" role="group" aria-label="Token breakdown">
    {parts.filter((part) => part.value > 0).map((part) => <button key={part.key} type="button" className={`bar-segment bar-${part.key}`} style={{ width: `${part.value / total * 100}%` }} data-tooltip={tooltip(part)} aria-label={tooltip(part)} />)}
  </div><div className="legend">{parts.map((part) => <button type="button" key={part.key} className="legend-item" data-tooltip={tooltip(part)} aria-label={tooltip(part)}><i className={`key ${part.key}`} />{part.label}<strong>{count(part.value)}</strong><em>{total ? (part.value / total * 100).toFixed(1) : '0.0'}%</em></button>)}</div></div>
}

function TokenTimeline({ points }: { points: TokenPoint[] }) {
  if (!points.length) return <p className="chart-empty">Token timing becomes available when API request events arrive.</p>
  const minTime = points[0].timestamp
  const maxTime = points[points.length - 1].timestamp
  const total = points.reduce((sum, point) => sum + pointTokens(point), 0)
  const maxY = Math.max(1, total)
  let running = 0
  const plot = points.map((point, index) => {
    running += pointTokens(point)
    return {
      ...point, cumulative: running,
      x: 64 + (maxTime === minTime ? (points.length === 1 ? 0.5 : index / (points.length - 1)) : (point.timestamp - minTime) / (maxTime - minTime)) * 706,
      y: 175 - running / maxY * 145,
    }
  })
  const line = plot.map((point, index) => `${index ? 'L' : 'M'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ')
  const area = `M ${plot[0].x} 175 ${line.replace(/^M/, 'L')} L ${plot[plot.length - 1].x} 175 Z`
  return <div className="timeline-chart"><svg viewBox="0 0 800 215" role="img" aria-label={`Cumulative token usage across ${points.length} API requests, ending at ${count(total)} tokens`}>
    <line className="chart-grid" x1="64" y1="30" x2="770" y2="30" /><line className="chart-grid" x1="64" y1="102" x2="770" y2="102" /><line className="chart-grid" x1="64" y1="175" x2="770" y2="175" />
    <text x="2" y="34">{shortCount(total)}</text><text x="2" y="106">{shortCount(total / 2)}</text><text x="49" y="179">0</text>
    <path className="chart-area" d={area} /><path className="chart-line" d={line} />
    {plot.map((point, index) => <circle key={`${point.timestamp}-${index}`} className="chart-point" cx={point.x} cy={point.y} r="5" tabIndex={0} aria-label={`${date(point.timestamp)}: ${count(pointTokens(point))} tokens in request; ${count(point.cumulative)} cumulative`}><title>{`${date(point.timestamp)} · ${count(pointTokens(point))} tokens in this request · ${count(point.cumulative)} cumulative`}</title></circle>)}
    <text x="64" y="204">{time(minTime)}</text><text x="770" y="204" textAnchor="end">{time(maxTime)}</text>
  </svg><p>Each point is an API request. The line shows cumulative tokens, including cache reads and writes.</p></div>
}

function TokenUsageBars({ points, level }: { points: TokenPoint[]; level: 'prompt' | 'request' }) {
  const [order, setOrder] = useState<'largest' | 'time'>('largest')
  const [page, setPage] = useState(0)
  if (!points.length) return <p className="chart-empty">Token usage appears when API request events arrive.</p>

  const promptNumbers = new Map<string, number>()
  for (const point of points) {
    if (point.promptId && !promptNumbers.has(point.promptId)) promptNumbers.set(point.promptId, promptNumbers.size + 1)
  }
  let bars: TokenBar[]
  if (level === 'prompt') {
    const groups = new Map<string, TokenBar>()
    for (const point of points) {
      const key = point.promptId || 'unlinked'
      const existing = groups.get(key)
      if (existing) {
        existing.input += point.input
        existing.output += point.output
        existing.cacheRead += point.cacheRead
        existing.cacheWrite += point.cacheWrite
        existing.requestCount += 1
      } else {
        groups.set(key, { ...point, label: point.promptId ? `P${promptNumbers.get(point.promptId)}` : 'Other', requestCount: 1,
          context: point.promptId ? `Prompt ${promptNumbers.get(point.promptId)}` : 'Requests without a prompt ID' })
      }
    }
    bars = [...groups.values()]
  } else {
    bars = points.map((point, index) => ({ ...point, label: `R${index + 1}`, requestCount: 1,
      context: point.promptId ? `Request ${index + 1} · Prompt ${promptNumbers.get(point.promptId)}` : `Request ${index + 1} · Prompt unknown` }))
  }

  const orderedBars = [...bars].sort((a, b) => order === 'largest'
    ? pointTokens(b) - pointTokens(a) || a.timestamp - b.timestamp
    : a.timestamp - b.timestamp)
  const pageSize = 20
  const pageCount = level === 'request' ? Math.ceil(orderedBars.length / pageSize) : 1
  const currentPage = Math.min(page, pageCount - 1)
  const visibleBars = level === 'request' ? orderedBars.slice(currentPage * pageSize, (currentPage + 1) * pageSize) : orderedBars
  const max = Math.max(1, ...bars.map(pointTokens))
  const total = bars.reduce((sum, bar) => sum + pointTokens(bar), 0)
  const categories = [
    { key: 'input', label: 'Input', color: 'input' },
    { key: 'output', label: 'Output', color: 'output' },
    { key: 'cacheRead', label: 'Cache read', color: 'read' },
    { key: 'cacheWrite', label: 'Cache write', color: 'create' },
  ] as const
  return <div className="usage-chart">
    <div className="usage-chart-meta"><span>{bars.length} {level === 'prompt' ? 'prompt groups' : 'API requests'} · {count(total)} tokens</span><label>Order <select value={order} onChange={(event) => { setOrder(event.target.value as 'largest' | 'time'); setPage(0) }}><option value="largest">Most tokens first</option><option value="time">Time order</option></select></label></div>
    <div className="usage-chart-scroll" role="region" aria-label={`Tokens by ${level === 'prompt' ? 'prompt' : 'API request'}`} tabIndex={0}>
      <div className="usage-bars" style={{ minWidth: `${Math.max(560, visibleBars.length * (level === 'prompt' ? 74 : 58))}px`, gridTemplateColumns: `repeat(${visibleBars.length}, minmax(0, 1fr))` }}>
        {visibleBars.map((bar) => {
          const value = pointTokens(bar)
          const detail = `${bar.context} · ${date(bar.timestamp)}\n${count(value)} tokens · ${bar.requestCount} ${bar.requestCount === 1 ? 'request' : 'requests'}\nInput ${count(bar.input)} · Output ${count(bar.output)}\nCache read ${count(bar.cacheRead)} · Cache write ${count(bar.cacheWrite)}`
          return <div className="usage-column" role="img" tabIndex={0} key={bar.label} title={detail} aria-label={detail}>
            <span className="usage-value">{shortCount(value)}</span>
            <span className="usage-plot"><span className="usage-stack" style={{ height: `${value ? Math.max(2, value / max * 100) : 0}%` }}>
              {categories.map((category) => <span key={category.key} className={`usage-segment ${category.color}`} style={{ height: `${value ? bar[category.key] / value * 100 : 0}%` }} />)}
            </span></span>
            <span className="usage-index">{bar.label}</span><span className="usage-time">{time(bar.timestamp)}</span>
          </div>
        })}
      </div>
    </div>
    {level === 'request' && pageCount > 1 && <div className="usage-page-controls"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>← Previous</button><span>{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, bars.length)} of {bars.length} requests</span><button type="button" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next →</button></div>}
    <div className="usage-legend" aria-label="Token categories">{categories.map((category) => <span key={category.key}><i className={`key ${category.color}`} />{category.label}</span>)}</div>
    <p>{level === 'prompt' ? 'Each bar totals the API requests triggered by one prompt. “Other” contains requests without a prompt ID.' : 'Each bar is one API request. Hover or focus a bar for its exact token counts and prompt group.'} Cache reads may repeat context across requests.</p>
  </div>
}

function ActivityList({ events }: { events: Event[] }) {
  return <ol className="event-list">{events.length ? events.map((event, index) => <li className="event-item" key={`${event.timestamp}-${index}`}><span className="event-dot" /><span className="event-label">{eventLabels[event.name] || event.name}{event.toolName && event.name === 'tool_result' ? ` · ${event.toolName}` : ''}</span><time className="event-time">{date(event.timestamp)}</time></li>) : <li className="event-empty">No log events received yet.</li>}</ol>
}

function PromptList({ prompts, loading, error }: { prompts: PromptRecord[]; loading: boolean; error: string }) {
  const [order, setOrder] = useState<'cost' | 'tokens' | 'time'>('cost')
  const [page, setPage] = useState(0)
  const sorted = [...prompts].sort((a, b) => order === 'time' ? b.timestamp - a.timestamp
    : order === 'tokens' ? b.tokens - a.tokens || b.timestamp - a.timestamp
      : (b.costUsd ?? -1) - (a.costUsd ?? -1) || b.tokens - a.tokens)
  const pageCount = Math.max(1, Math.ceil(sorted.length / 20))
  const currentPage = Math.min(page, pageCount - 1)
  const visible = sorted.slice(currentPage * 20, (currentPage + 1) * 20)
  return <section className="panel prompt-panel detail-chart">
    <div className="panel-head"><div><p className="eyebrow">COST DRIVERS</p><h2>Prompts and usage</h2></div><span className="count-chip">{prompts.length} prompts</span></div>
    <div className="prompt-body">
      <div className="usage-chart-meta"><span>Prompt text is sanitized locally before storage.</span><label>Order <select value={order} onChange={(event) => { setOrder(event.target.value as typeof order); setPage(0) }}><option value="cost">Highest cost</option><option value="tokens">Most tokens</option><option value="time">Newest first</option></select></label></div>
      {loading ? <p className="chart-empty">Loading prompts…</p> : error ? <p className="activity-error" role="alert">{error}</p> : !prompts.length ? <p className="chart-empty">No prompt events in this period.</p> :
        <ol className="prompt-list">{visible.map((prompt) => <li className="prompt-item" key={prompt.id}>
          <div className="prompt-meta"><time>{date(prompt.timestamp)}</time><span>{count(prompt.tokens)} tokens</span><span>{prompt.requests} {prompt.requests === 1 ? 'request' : 'requests'}</span><strong>{prompt.costUsd === null ? 'Cost unavailable' : `$${prompt.costUsd.toFixed(prompt.costUsd < 0.01 ? 4 : 2)}`}</strong></div>
          <details><summary>{prompt.text ? prompt.text.split('\n')[0].slice(0, 180) : 'Prompt text unavailable'}</summary><pre>{prompt.text || 'Enable local prompt telemetry to collect future prompts. Existing prompts are not backfilled.'}</pre></details>
        </li>)}</ol>}
      {pageCount > 1 && <div className="usage-page-controls"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>← Previous</button><span>Page {currentPage + 1} of {pageCount}</span><button type="button" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>Next →</button></div>}
      <p className="prompt-note">Per-prompt cost sums API request estimates when every linked request has a cost. Session cost metrics may differ.</p>
    </div>
  </section>
}

function SessionDetail({ session, period, onBack }: { session: Session; period: Period; onBack: () => void }) {
  const [prompts, setPrompts] = useState<PromptRecord[]>([])
  const [promptsLoading, setPromptsLoading] = useState(true)
  const [promptsError, setPromptsError] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [allEvents, setAllEvents] = useState<Event[]>([])
  const [activityTotal, setActivityTotal] = useState(session.activityCount)
  const [loading, setLoading] = useState(false)
  const [activityError, setActivityError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setPromptsLoading(true)
    setPromptsError('')
    fetch(`/api/sessions/${encodeURIComponent(session.id)}/prompts?days=${period}`, { signal: controller.signal, cache: 'no-store' })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<PromptRecord[]> })
      .then(setPrompts)
      .catch((error: unknown) => { if (!controller.signal.aborted) setPromptsError(error instanceof Error ? error.message : 'Could not load prompts') })
      .finally(() => { if (!controller.signal.aborted) setPromptsLoading(false) })
    return () => controller.abort()
  }, [session.id, period, session.activityCount])
  useEffect(() => {
    if (!showAll) return
    const controller = new AbortController()
    setLoading(true)
    setActivityError('')
    fetch(`/api/sessions/${encodeURIComponent(session.id)}/events?days=${period}&offset=0`, { signal: controller.signal, cache: 'no-store' })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<{ total: number; events: Event[] }> })
      .then((data) => { setAllEvents(data.events); setActivityTotal(data.total) })
      .catch((error: unknown) => { if (!controller.signal.aborted) setActivityError(error instanceof Error ? error.message : 'Could not load activity') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [showAll, session.id, period])
  const loadMore = async () => {
    setLoading(true)
    setActivityError('')
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}/events?days=${period}&offset=${allEvents.length}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data: { total: number; events: Event[] } = await response.json()
      setAllEvents((current) => [...current, ...data.events])
      setActivityTotal(data.total)
    } catch (error) { setActivityError(error instanceof Error ? error.message : 'Could not load activity') }
    finally { setLoading(false) }
  }
  const performance = [
    ['Prompts sent', count(session.prompts)], ['API requests', count(session.apiRequests)],
    ['Median request time', session.medianRequestMs == null ? 'Unavailable' : `${Math.round(session.medianRequestMs)} ms`],
    ['Active user time', duration(session.activeUserSeconds)], ['Active CLI time', duration(session.activeCliSeconds)],
    ['API errors', count(session.errors)], ['Session starts', count(session.starts)],
  ]
  const context = [
    ['Models', session.models.join(', ') || 'Unavailable'], ['Account email', session.email || 'Unavailable'],
    ['First seen', date(session.firstSeen)], ['Last seen', date(session.lastSeen)],
  ]
  return <>
    <button type="button" className="back-button" onClick={onBack}>← All sessions</button>
    <div className="detail-page-head"><div><p className="eyebrow">SESSION DETAILS</p><h1 className="detail-title">{session.title}</h1><div className="detail-meta"><span className="project-pill">{session.project}</span><span>{session.id}</span></div></div></div>
    <div className="detail-hero"><Stat label="Tokens used" value={count(tokens(session))} hint="Includes cache" /><Stat label="Estimated cost" value={session.estimatedCostUsd == null ? 'Unavailable' : `$${session.estimatedCostUsd.toFixed(session.estimatedCostUsd < 0.01 ? 4 : 2)}`} hint="Claude Code estimate" /><Stat label="Prompts sent" value={count(session.prompts)} hint="User prompt events" /><Stat label="API requests" value={count(session.apiRequests)} hint="Calls to Claude" /></div>
    <section className="panel chart-panel"><div className="panel-head"><div><p className="eyebrow">USAGE OVER TIME</p><h2>Token timeline</h2></div><span className="count-chip">{session.apiRequests} API requests</span></div><div className="chart-body"><TokenTimeline points={session.tokenTimeline} /></div></section>
    <section className="panel chart-panel detail-chart"><div className="panel-head"><div><p className="eyebrow">TOKEN COMPARISON</p><h2>By prompt</h2></div><span className="count-chip">Grouped API requests</span></div><div className="chart-body"><TokenUsageBars points={session.tokenTimeline} level="prompt" /></div></section>
    <PromptList key={`${session.id}-${period}`} prompts={prompts} loading={promptsLoading} error={promptsError} />
    <section className="panel chart-panel detail-chart"><div className="panel-head"><div><p className="eyebrow">TOKEN COMPARISON</p><h2>By API request</h2></div><span className="count-chip">{session.apiRequests} API requests</span></div><div className="chart-body"><TokenUsageBars points={session.tokenTimeline} level="request" /></div></section>
    <div className="detail-grid"><section className="panel detail-card"><TokenBreakdown session={session} /><div className="detail-section"><h3>Performance</h3><div className="info-grid">{performance.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div></div></section>
      <section className="panel detail-card"><h3>Context</h3><dl className="context-list">{context.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section></div>
    <section className="panel activity-panel"><details open><summary><span>Recent activity</span><span className="count-chip">{session.activityCount} events</span></summary><div className="activity-body"><ActivityList events={showAll ? allEvents : session.recentEvents} />
      {session.activityCount > 12 && !showAll && <button className="text-button" type="button" onClick={() => setShowAll(true)}>View all {session.activityCount} events</button>}
      {showAll && allEvents.length < activityTotal && <button className="text-button" type="button" disabled={loading} onClick={() => void loadMore()}>{loading ? 'Loading…' : `Load more (${allEvents.length} of ${activityTotal})`}</button>}
      {activityError && <p className="activity-error" role="alert">{activityError}</p>}
    </div></details></section>
  </>
}

export default function App() {
  const { theme, toggleTheme } = useTheme()
  const [period, setPeriod] = useState<Period>('30')
  const [selectedProjects, setSelectedProjects] = useState<string[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [route, setRoute] = useState(() => window.location.hash)
  const [sidebarVisible, setSidebarVisible] = useState(() => localStorage.getItem('dashboard-sidebar-visible') !== 'false')
  const [status, setStatus] = useState('Waiting for telemetry…')
  const [error, setError] = useState(false)
  useEffect(() => { const handler = () => setRoute(window.location.hash); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler) }, [])
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const response = await fetch(`/api/sessions?days=${period}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const data: { sessions: Session[] } = await response.json()
        if (!alive) return
        setSessions(data.sessions)
        setStatus(data.sessions.length ? `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(new Date())}` : 'Receiver ready. Waiting for Claude Code telemetry.')
        setError(false)
      } catch (reason) {
        if (!alive) return
        setStatus(`Could not load sessions: ${reason instanceof Error ? reason.message : 'Unknown error'}`)
        setError(true)
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 10_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [period])
  const projects = useMemo(() => [...new Set(sessions.map((s) => s.project))].sort(), [sessions])
  const filtered = useMemo(() => sessions.filter((s) => !selectedProjects.length || selectedProjects.includes(s.project)), [sessions, selectedProjects])
  const selectedId = route.startsWith('#/session/') ? decodeURIComponent(route.slice('#/session/'.length)) : null
  const selected = selectedId ? sessions.find((s) => s.id === selectedId) : undefined
  const navigate = (id?: string) => { window.location.hash = id ? `/session/${encodeURIComponent(id)}` : ''; setRoute(window.location.hash); window.scrollTo(0, 0) }
  const toggleSidebar = () => { setSidebarVisible((visible) => { localStorage.setItem('dashboard-sidebar-visible', String(!visible)); return !visible }) }
  const activeValues = filtered.flatMap((s) => [s.activeUserSeconds, s.activeCliSeconds]).filter((n): n is number => n != null)
  const active = activeValues.length ? duration(activeValues.reduce((a, b) => a + b, 0)) : 'Unavailable'
  const maxTokens = Math.max(1, ...filtered.map(tokens))
  const overviewPoints = useMemo(() => filtered.flatMap((session) => session.tokenTimeline).sort((a, b) => a.timestamp - b.timestamp), [filtered])
  return <div className="app-shell">
    {sidebarVisible && <aside className="sidebar" aria-label="Dashboard navigation">
      <div className="brand">Claude<span>telemetry</span></div>
      <div className="sidebar-group"><div className="group-title">WORKSPACE</div><button className="nav-item active" type="button" onClick={() => navigate()}>Sessions</button></div>
      <div className="sidebar-footer"><div className="receiver-label"><span className="live-dot" aria-hidden="true" />Local receiver</div>
        <button className="theme-toggle" type="button" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}><span className="theme-symbol" aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>{theme === 'dark' ? 'Light' : 'Dark'} mode</button>
        <button className="theme-toggle" type="button" onClick={toggleSidebar}>◧ Hide sidebar</button>
      </div>
    </aside>}
    <main className="main-area"><div className="page-content">
      <div className="top-actions">{!sidebarVisible && <><button type="button" className="plain-button" onClick={toggleSidebar}>☰ Show sidebar</button><button type="button" className="plain-button" onClick={toggleTheme}>{theme === 'dark' ? '☀ Light' : '☾ Dark'} mode</button></>}<span className="top-spacer" /><span className={`status${error ? ' error' : ''}`} role="status">{status}</span></div>
      {selectedId ? selected ? <SessionDetail key={selected.id} session={selected} period={period} onBack={() => navigate()} /> : <div className="panel missing-session"><h1>Session unavailable</h1><p>This chat may be outside the current time period.</p><button className="text-button" type="button" onClick={() => navigate()}>Back to sessions</button></div> : <>
        <div className="page-head"><div><p className="eyebrow">CLAUDE CODE / USAGE</p><h1>Sessions</h1><p className="subtitle">Tokens, active time, prompts, and requests by chat.</p></div><div className="filters">
          <ProjectPicker projects={projects} selected={selectedProjects} onChange={setSelectedProjects} />
          <label>Period <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="all">All time</option></select></label>
        </div></div>
        <section className="stats" aria-label="Summary"><Stat label="Chats" value={count(filtered.length)} hint="Distinct session IDs" /><Stat label="Prompts sent" value={count(filtered.reduce((sum, s) => sum + s.prompts, 0))} hint="User prompt events" /><Stat label="Session starts" value={count(filtered.reduce((sum, s) => sum + s.starts, 0))} hint="Includes resumes" /><Stat label="Tokens" value={shortCount(filtered.reduce((sum, s) => sum + tokens(s), 0))} hint="Input, output, and cache" /><Stat label="Active time" value={active} hint="User + Claude processing" /></section>
        <section className="panel chart-panel overview-chart" aria-labelledby="overview-chart-heading"><div className="panel-head"><div><p className="eyebrow">USAGE OVER TIME</p><h2 id="overview-chart-heading">Token timeline</h2></div><span className="count-chip">{overviewPoints.length} API requests across {filtered.length} {filtered.length === 1 ? 'chat' : 'chats'}</span></div><div className="chart-body"><TokenTimeline points={overviewPoints} /></div></section>
        <section className="panel sessions-panel" aria-labelledby="chats-heading"><div className="panel-head"><div><p className="eyebrow">ACTIVITY</p><h2 id="chats-heading">Chats</h2></div><span className="count-chip">{filtered.length} {filtered.length === 1 ? 'chat' : 'chats'}</span></div>
          {filtered.length ? <div className="session-list">{filtered.map((session) => <ChatRow key={session.id} session={session} maxTokens={maxTokens} onClick={() => navigate(session.id)} />)}</div> : <div className="empty-state"><span className="empty-icon" aria-hidden="true">↗</span><h3>No chats in this view</h3><p>Try another project or period, or send a prompt from a new Claude Code chat.</p></div>}
        </section>
      </>}
      <footer className="footnote"><span>Session starts count launches; chats count distinct IDs. Cost is Claude Code's estimate.</span><span>Created by @AdrianusVieira</span></footer>
    </div></main>
  </div>
}
