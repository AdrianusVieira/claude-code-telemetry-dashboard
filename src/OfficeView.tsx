import { useEffect, useState } from 'react'
import OfficeWorldCanvas from './OfficeWorldCanvas'
import './office.css'

type OfficeEvent = { name: string; timestamp: number; toolName: string }
export type OfficeSession = {
  id: string; title: string; project: string; lastSeen: number | null
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number
  estimatedCostUsd: number | null; prompts: number; apiRequests: number; recentEvents: OfficeEvent[]
}

type OfficeProject = { name: string; sessions: OfficeSession[]; recentCount: number }

const recentWindowMs = 2 * 60 * 1000
const number = new Intl.NumberFormat()

function tokenCount(session: OfficeSession): number {
  return session.inputTokens + session.outputTokens + session.cacheReadTokens + session.cacheCreationTokens
}

function shortNumber(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 10_000 ? `${(value / 1_000).toFixed(1)}k` : number.format(value)
}

function timeSince(timestamp: number | null, now: number): string {
  if (timestamp === null) return 'No timestamp'
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function lastActivity(session: OfficeSession): string {
  const latest = session.recentEvents[0]
  if (!latest) return 'No event details'
  if (latest.name === 'tool_result') {
    const tool = latest.toolName.toLowerCase()
    if (/^(read|grep|glob|ls)$/.test(tool)) return 'Last: read files'
    if (/^(edit|write|multiedit|notebookedit)$/.test(tool)) return 'Last: edited files'
    if (tool === 'bash') return 'Last: ran a command'
    if (/websearch|webfetch/.test(tool)) return 'Last: used the web'
    return latest.toolName ? `Last: ${latest.toolName} finished` : 'Last: tool finished'
  }
  const labels: Record<string, string> = {
    user_prompt: 'Last: prompt sent', assistant_response: 'Last: response completed',
    api_request: 'Last: model request', api_error: 'Last: API error',
    api_retries_exhausted: 'Last: retries exhausted', compaction: 'Last: context compacted',
    subagent_completed: 'Last: subagent completed',
  }
  return labels[latest.name] || `Last: ${latest.name.replaceAll('_', ' ')}`
}

const createPreviewSessions = (now: number): OfficeSession[] => [
  { id: 'preview-one', title: 'Improve dashboard layout', project: 'Telemetry dashboard', lastSeen: now - 1_000, inputTokens: 2840, outputTokens: 740, cacheReadTokens: 9100, cacheCreationTokens: 1200, estimatedCostUsd: 0.18, prompts: 4, apiRequests: 12, recentEvents: [{ name: 'tool_result', timestamp: now - 1_000, toolName: 'Edit' }] },
  { id: 'preview-two', title: 'Review API routes', project: 'Telemetry dashboard', lastSeen: now - 3_000, inputTokens: 1900, outputTokens: 320, cacheReadTokens: 4100, cacheCreationTokens: 800, estimatedCostUsd: 0.08, prompts: 2, apiRequests: 7, recentEvents: [{ name: 'tool_result', timestamp: now - 3_000, toolName: 'Read' }] },
  { id: 'preview-three', title: 'Update project notes', project: 'Study notes', lastSeen: now - 3_600_000, inputTokens: 1250, outputTokens: 530, cacheReadTokens: 2600, cacheCreationTokens: 400, estimatedCostUsd: 0.06, prompts: 3, apiRequests: 5, recentEvents: [{ name: 'assistant_response', timestamp: now - 3_600_000, toolName: '' }] },
]


export default function OfficeView({ sessions, onOpenSession }: { sessions: OfficeSession[]; onOpenSession: (id: string) => void }) {
  const [now, setNow] = useState(Date.now)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [previewSessions, setPreviewSessions] = useState<OfficeSession[]>([])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000)
    return () => window.clearInterval(timer)
  }, [])

  const showingPreview = preview
  const source = showingPreview ? previewSessions : sessions
  const beginPreview = () => { setPreviewSessions(createPreviewSessions(Date.now())); setSelectedId(null); setPreview(true) }
  const projects: OfficeProject[] = [...new Set(source.map((session) => session.project || 'Unknown project'))].map((name) => {
    const projectSessions = source.filter((session) => (session.project || 'Unknown project') === name)
    return { name, sessions: projectSessions, recentCount: projectSessions.filter((session) => session.lastSeen !== null && now - session.lastSeen <= recentWindowMs).length }
  })
  const selected = source.find((session) => session.id === selectedId)
  const recentCount = projects.reduce((total, project) => total + project.recentCount, 0)

  return <section className="office-view" aria-label="Office view">
    <div className="office-lead">
      <div><p className="eyebrow">CLAUDE CODE / OFFICE</p><h1>All offices</h1><p className="subtitle">Move freely through the workspace. Each seated person represents one session.</p></div>
      <div className="office-lead-stats"><span><strong>{projects.length}</strong> offices</span><span><strong>{source.length}</strong> sessions</span><span><strong>{recentCount}</strong> recent signals</span></div>
    </div>
    {showingPreview && <div className="office-preview-note">Preview with sample sessions <button type="button" onClick={() => { setPreview(false); setSelectedId(null) }}>Exit preview</button></div>}
    {!source.length ? <div className="office-empty panel"><div className="office-empty-art" aria-hidden="true"><span className="office-empty-monitor" /><span className="office-empty-desk" /></div><h2>The office is quiet</h2><p>Sessions appear here when Claude Code telemetry reaches this dashboard.</p><button type="button" className="office-action" onClick={beginPreview}>Preview the offices</button></div> : <>
      <div className="office-layout">
        <div className="office-floor">
          <div className="office-floor-heading"><span>{projects.length} project {projects.length === 1 ? 'office' : 'offices'}</span><span>Click an office name to focus · Drag to move · Zoom for names{!showingPreview && recentCount === 0 && <button type="button" className="office-preview-link" onClick={beginPreview}>Preview activity</button>}</span></div>
          <OfficeWorldCanvas projects={projects} selectedId={selected?.id || null} onSelectSession={setSelectedId} />
        </div>
        {selected && <aside className="office-inspector" aria-label="Selected session">
          <p className="eyebrow">SELECTED SESSION</p><h2>{selected.title}</h2><span className="office-inspector-project">{selected.project}</span>
          <div className="office-activity"><span className="office-activity-label">LATEST OBSERVED EVENT</span><strong>{lastActivity(selected)}</strong><small>{timeSince(selected.recentEvents[0]?.timestamp ?? selected.lastSeen, now)}</small></div>
          <dl className="office-inspector-stats"><div><dt>Tokens</dt><dd>{shortNumber(tokenCount(selected))}</dd></div><div><dt>Estimated cost</dt><dd>{selected.estimatedCostUsd === null ? 'Unavailable' : `$${selected.estimatedCostUsd.toFixed(selected.estimatedCostUsd < 0.01 ? 4 : 2)}`}</dd></div><div><dt>Prompts</dt><dd>{number.format(selected.prompts)}</dd></div><div><dt>API requests</dt><dd>{number.format(selected.apiRequests)}</dd></div></dl>
          {!showingPreview && <button type="button" className="office-action" onClick={() => onOpenSession(selected.id)}>Open session details <span aria-hidden="true">→</span></button>}
          <p className="office-inspector-note">A recent signal means telemetry arrived within two minutes. It does not confirm the session is still running.</p>
        </aside>}
      </div>
    </>}
  </section>
}
