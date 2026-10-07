import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { sanitizePrompt } from './sanitize.js'

type ObjectValue = Record<string, unknown>
type Scalar = string | number | boolean

const METRICS = new Set([
  'claude_code.token.usage',
  'claude_code.active_time.total', 'claude_code.cost.usage',
])
const EVENTS = new Set([
  'user_prompt', 'assistant_response', 'api_request', 'api_error',
  'api_retries_exhausted', 'tool_result', 'compaction', 'subagent_completed',
])

function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function attributes(value: unknown): Record<string, Scalar> {
  const result: Record<string, Scalar> = {}
  for (const item of array(value)) {
    const entry = object(item)
    if (typeof entry.key !== 'string') continue
    const data = object(entry.value)
    for (const key of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) {
      const scalar = data[key]
      if (typeof scalar === 'string' || typeof scalar === 'number' || typeof scalar === 'boolean') {
        result[entry.key] = scalar
        break
      }
    }
  }
  return result
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function integer(value: unknown): number | null {
  const parsed = numeric(value)
  return parsed === null ? null : Math.trunc(parsed)
}

function millis(nanos: unknown): number {
  if (typeof nanos === 'string' && /^\d+$/.test(nanos)) return Number(BigInt(nanos) / 1_000_000n)
  const parsed = numeric(nanos)
  return parsed === null ? Date.now() : Math.trunc(parsed / 1_000_000)
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]))
  }
  return value
}

function fingerprint(kind: string, value: unknown): string {
  return createHash('sha256').update(kind).update(JSON.stringify(stable(value))).digest('hex')
}

function identity(attrs: Record<string, Scalar>) {
  return {
    sessionId: String(attrs['session.id'] || ''),
    project: String(attrs['project.id'] || attrs['vcs.repository.name'] || 'Unknown'),
    email: String(attrs['user.email'] || ''),
  }
}

type MetricRow = {
  id: string; timestamp_ms: number; name: string; session_id: string; project: string;
  user_email: string; kind: string; model: string; value: number
}
type EventRow = {
  id: string; timestamp_ms: number; name: string; session_id: string; project: string;
  user_email: string; model: string; duration_ms: number | null;
  input_tokens: number | null; output_tokens: number | null;
  cache_read_tokens: number | null; cache_creation_tokens: number | null;
  cost_usd: number | null; tool_name: string; success: string; prompt_id: string;
  prompt_text: string | null
}
type Activity = { name: string; timestamp: number; durationMs: number | null; toolName: string; success: string }
type WorkingSession = {
  id: string; title: string; project: string; email: string; emails: Map<string, number>;
  emailLastSeen: number | null; firstSeen: number | null;
  lastSeen: number | null; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheCreationTokens: number; activeUserSeconds: number | null;
  activeCliSeconds: number | null; estimatedCostUsd: number | null; apiRequests: number;
  errors: number; prompts: number; models: Set<string>; latencies: number[]; recentEvents: Activity[];
  tokenTimeline: { timestamp: number; input: number; output: number; cacheRead: number; cacheWrite: number; promptId: string }[];
  metricTokens: Record<string, number>; eventCostUsd: number; eventCostSeen: boolean
}

export type TimeWindow = number | null | { start: number; end: number }

type AccountSlice = {
  email: string; project: string; sessionId: string; firstSeen: number; lastSeen: number
  prompts: number; apiRequests: number; inputTokens: number; outputTokens: number
  cacheReadTokens: number; cacheCreationTokens: number; activeUserSeconds: number | null
  activeCliSeconds: number | null; estimatedCostUsd: number | null
  metricTokens: Record<string, number>; eventCostUsd: number; eventCostSeen: boolean
}

function bounds(window: TimeWindow): { start: number; end: number } {
  return typeof window === 'object' && window !== null
    ? window
    : { start: window === null ? 0 : Date.now() - window * 86_400_000, end: Number.MAX_SAFE_INTEGER }
}

function median(values: number[]): number | null {
  if (!values.length) return null
  values.sort((a, b) => a - b)
  const middle = Math.floor(values.length / 2)
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
}

export class Store {
  private db: Database.Database
  private deletedSessions: Set<string>

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metric_points (
        id TEXT PRIMARY KEY, timestamp_ms INTEGER NOT NULL, name TEXT NOT NULL,
        session_id TEXT NOT NULL, project TEXT NOT NULL, user_email TEXT NOT NULL,
        kind TEXT NOT NULL, model TEXT NOT NULL, value REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS metric_session_time ON metric_points(session_id, timestamp_ms);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, timestamp_ms INTEGER NOT NULL, name TEXT NOT NULL,
        session_id TEXT NOT NULL, project TEXT NOT NULL, user_email TEXT NOT NULL,
        model TEXT NOT NULL, duration_ms REAL, input_tokens INTEGER, output_tokens INTEGER,
        cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cost_usd REAL,
        tool_name TEXT, success TEXT, prompt_id TEXT, prompt_text TEXT
      );
      CREATE INDEX IF NOT EXISTS event_session_time ON events(session_id, timestamp_ms);
      CREATE TABLE IF NOT EXISTS titles (
        session_id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL,
        updated_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deleted_sessions (
        session_id TEXT PRIMARY KEY, deleted_ms INTEGER NOT NULL
      );
    `)
    if (!(this.db.pragma('table_info(events)') as { name: string }[]).some((column) => column.name === 'prompt_text')) {
      this.db.exec('ALTER TABLE events ADD COLUMN prompt_text TEXT')
    }
    this.db.prepare("DELETE FROM metric_points WHERE name = 'claude_code.session.count'").run()
    this.deletedSessions = new Set((this.db.prepare('SELECT session_id FROM deleted_sessions').all() as { session_id: string }[]).map((row) => row.session_id))
  }

  close(): void { this.db.close() }

  deleteSession(sessionId: string): boolean {
    if (!sessionId || this.deletedSessions.has(sessionId)) return false
    const removed = this.db.transaction(() => {
      const exists = this.db.prepare(`SELECT 1 FROM metric_points WHERE session_id = ?
        UNION SELECT 1 FROM events WHERE session_id = ?
        UNION SELECT 1 FROM titles WHERE session_id = ? LIMIT 1`).get(sessionId, sessionId, sessionId)
      if (!exists) return false
      this.db.prepare('INSERT INTO deleted_sessions (session_id, deleted_ms) VALUES (?, ?)').run(sessionId, Date.now())
      this.db.prepare('DELETE FROM metric_points WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM events WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM titles WHERE session_id = ?').run(sessionId)
      return true
    })()
    if (removed) this.deletedSessions.add(sessionId)
    return removed
  }

  ingestMetrics(payload: unknown): number {
    const rows: MetricRow[] = []
    for (const groupValue of array(object(payload).resourceMetrics)) {
      const group = object(groupValue)
      const resource = attributes(object(group.resource).attributes)
      for (const scopeValue of array(group.scopeMetrics)) {
        for (const metricValue of array(object(scopeValue).metrics)) {
          const metric = object(metricValue)
          const name = metric.name
          if (typeof name !== 'string' || !METRICS.has(name)) continue
          const series = object(metric.sum || metric.gauge)
          if ([2, '2', 'AGGREGATION_TEMPORALITY_CUMULATIVE'].includes(series.aggregationTemporality as string | number)) continue
          for (const pointValue of array(series.dataPoints)) {
            const point = object(pointValue)
            const attrs = { ...resource, ...attributes(point.attributes) }
            const { sessionId, project, email } = identity(attrs)
            const value = numeric(point.asDouble ?? point.asInt)
            if (!sessionId || this.deletedSessions.has(sessionId) || value === null) continue
            rows.push({
              id: fingerprint('metric', [name, resource, point]),
              timestamp_ms: millis(point.timeUnixNano), name, session_id: sessionId,
              project, user_email: email, kind: String(attrs.type || attrs.start_type || ''),
              model: String(attrs.model || ''), value,
            })
          }
        }
      }
    }
    const statement = this.db.prepare(`INSERT OR IGNORE INTO metric_points
      (id, timestamp_ms, name, session_id, project, user_email, kind, model, value)
      VALUES (@id, @timestamp_ms, @name, @session_id, @project, @user_email, @kind, @model, @value)`)
    return this.db.transaction(() => rows.reduce((total, row) => total + statement.run(row).changes, 0))()
  }

  ingestLogs(payload: unknown): number {
    const rows: EventRow[] = []
    for (const groupValue of array(object(payload).resourceLogs)) {
      const group = object(groupValue)
      const resource = attributes(object(group.resource).attributes)
      for (const scopeValue of array(group.scopeLogs)) {
        for (const recordValue of array(object(scopeValue).logRecords)) {
          const record = object(recordValue)
          const attrs = { ...resource, ...attributes(record.attributes) }
          const name = String(attrs['event.name'] || record.eventName || object(record.body).stringValue || '').replace(/^claude_code\./, '')
          if (!EVENTS.has(name)) continue
          const { sessionId, project, email } = identity(attrs)
          if (!sessionId || this.deletedSessions.has(sessionId)) continue
          let promptText: string | null = null
          if (name === 'user_prompt') {
            try { promptText = sanitizePrompt(attrs.prompt) }
            catch { /* Keep the event count, but never persist text on sanitizer failure. */ }
          }
          const row = {
            timestamp_ms: millis(record.timeUnixNano), name, session_id: sessionId,
            project, user_email: email, model: String(attrs.model || ''),
            duration_ms: numeric(attrs.duration_ms), input_tokens: integer(attrs.input_tokens),
            output_tokens: integer(attrs.output_tokens), cache_read_tokens: integer(attrs.cache_read_tokens),
            cache_creation_tokens: integer(attrs.cache_creation_tokens), cost_usd: numeric(attrs.cost_usd),
            tool_name: String(attrs.tool_name || ''), success: String(attrs.success || ''),
            prompt_id: String(attrs['prompt.id'] || ''),
            prompt_text: promptText,
          }
          rows.push({ ...row, id: fingerprint('event', [row, attrs['event.sequence'], attrs['message.uuid']]) })
        }
      }
    }
    const statement = this.db.prepare(`INSERT OR IGNORE INTO events
      (id, timestamp_ms, name, session_id, project, user_email, model, duration_ms,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd,
       tool_name, success, prompt_id, prompt_text)
      VALUES (@id, @timestamp_ms, @name, @session_id, @project, @user_email, @model,
       @duration_ms, @input_tokens, @output_tokens, @cache_read_tokens,
       @cache_creation_tokens, @cost_usd, @tool_name, @success, @prompt_id, @prompt_text)`)
    return this.db.transaction(() => rows.reduce((total, row) => total + statement.run(row).changes, 0))()
  }

  setTitle(sessionId: string, title: string, updatedMs: number): void {
    if (!sessionId || this.deletedSessions.has(sessionId) || !title.trim()) return
    this.db.prepare(`INSERT INTO titles(session_id, title, source, updated_ms)
      VALUES (?, ?, 'local-transcript', ?)
      ON CONFLICT(session_id) DO UPDATE SET title=excluded.title, updated_ms=excluded.updated_ms
      WHERE excluded.updated_ms >= titles.updated_ms`).run(sessionId, title.trim().slice(0, 200), updatedMs)
  }

  sessions(window: TimeWindow = 30) {
    const { start, end } = bounds(window)
    const metrics = this.db.prepare("SELECT * FROM metric_points WHERE timestamp_ms >= ? AND timestamp_ms < ? AND name != 'claude_code.session.count'").all(start, end) as MetricRow[]
    const events = this.db.prepare('SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?').all(start, end) as EventRow[]
    const titles = new Map((this.db.prepare('SELECT session_id, title FROM titles').all() as { session_id: string; title: string }[]).map((row) => [row.session_id, row.title]))
    const sessions = new Map<string, WorkingSession>()

    function get(sessionId: string): WorkingSession {
      let item = sessions.get(sessionId)
      if (!item) {
        item = {
          id: sessionId, title: titles.get(sessionId) || `Session ${sessionId.slice(0, 8)}`,
          project: 'Unknown', email: '', emails: new Map(), emailLastSeen: null,
          firstSeen: null, lastSeen: null,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          activeUserSeconds: null, activeCliSeconds: null, estimatedCostUsd: null,
          apiRequests: 0, errors: 0, prompts: 0, models: new Set(), latencies: [], recentEvents: [], tokenTimeline: [],
          metricTokens: {}, eventCostUsd: 0, eventCostSeen: false,
        }
        sessions.set(sessionId, item)
      }
      return item
    }

    function stamp(item: WorkingSession, row: MetricRow | EventRow): void {
      item.firstSeen = Math.min(item.firstSeen ?? row.timestamp_ms, row.timestamp_ms)
      item.lastSeen = Math.max(item.lastSeen ?? row.timestamp_ms, row.timestamp_ms)
      if (row.project !== 'Unknown') item.project = row.project
      if (row.user_email) {
        const firstSeen = item.emails.get(row.user_email)
        if (firstSeen === undefined || row.timestamp_ms < firstSeen) item.emails.set(row.user_email, row.timestamp_ms)
        if (item.emailLastSeen === null || row.timestamp_ms > item.emailLastSeen ||
          (row.timestamp_ms === item.emailLastSeen && row.user_email > item.email)) {
          item.email = row.user_email
          item.emailLastSeen = row.timestamp_ms
        }
      }
      if (row.model) item.models.add(row.model)
    }

    for (const row of metrics) {
      const item = get(row.session_id)
      stamp(item, row)
      if (row.name === 'claude_code.token.usage') {
        const field = ({ input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadTokens', cacheCreation: 'cacheCreationTokens' } as const)[row.kind as 'input' | 'output' | 'cacheRead' | 'cacheCreation']
        if (field) item.metricTokens[field] = (item.metricTokens[field] || 0) + row.value
      } else if (row.name === 'claude_code.active_time.total') {
        if (row.kind === 'user') item.activeUserSeconds = (item.activeUserSeconds || 0) + row.value
        if (row.kind === 'cli') item.activeCliSeconds = (item.activeCliSeconds || 0) + row.value
      } else if (row.name === 'claude_code.cost.usage') {
        item.estimatedCostUsd = (item.estimatedCostUsd || 0) + row.value
      }
    }

    for (const row of events) {
      const item = get(row.session_id)
      stamp(item, row)
      if (row.name === 'api_request') {
        item.apiRequests += 1
        item.inputTokens += row.input_tokens || 0
        item.outputTokens += row.output_tokens || 0
        item.cacheReadTokens += row.cache_read_tokens || 0
        item.cacheCreationTokens += row.cache_creation_tokens || 0
        item.tokenTimeline.push({
          timestamp: row.timestamp_ms, input: row.input_tokens || 0, output: row.output_tokens || 0,
          cacheRead: row.cache_read_tokens || 0, cacheWrite: row.cache_creation_tokens || 0,
          promptId: row.prompt_id,
        })
        if (row.duration_ms !== null) item.latencies.push(row.duration_ms)
        if (row.cost_usd !== null) {
          item.eventCostUsd += row.cost_usd
          item.eventCostSeen = true
        }
      } else if (row.name === 'api_error') item.errors += 1
      else if (row.name === 'user_prompt') item.prompts += 1
      item.recentEvents.push({ name: row.name, timestamp: row.timestamp_ms, durationMs: row.duration_ms, toolName: row.tool_name, success: row.success })
    }

    const output = [...sessions.values()].map((item) => {
      if (!item.apiRequests) {
        item.inputTokens = item.metricTokens.inputTokens || 0
        item.outputTokens = item.metricTokens.outputTokens || 0
        item.cacheReadTokens = item.metricTokens.cacheReadTokens || 0
        item.cacheCreationTokens = item.metricTokens.cacheCreationTokens || 0
      }
      if (item.estimatedCostUsd === null && item.eventCostSeen) item.estimatedCostUsd = item.eventCostUsd
      const { metricTokens: _metricTokens, eventCostUsd: _eventCostUsd, eventCostSeen: _eventCostSeen,
        emailLastSeen: _emailLastSeen, latencies, models, emails, ...visible } = item
      return {
        ...visible,
        emails: [...emails].sort(([emailA, timeA], [emailB, timeB]) => timeA - timeB || emailA.localeCompare(emailB)).map(([email]) => email),
        models: [...models].sort(),
        medianRequestMs: median(latencies), activityCount: item.recentEvents.length,
        recentEvents: item.recentEvents.sort((a, b) => b.timestamp - a.timestamp).slice(0, 12),
        tokenTimeline: item.tokenTimeline.sort((a, b) => a.timestamp - b.timestamp),
      }
    }).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    return { periodDays: typeof window === 'number' ? window : null, sessions: output }
  }

  accounts(window: TimeWindow = 30, projects: string[] = []) {
    const { start, end } = bounds(window)
    const metrics = this.db.prepare("SELECT * FROM metric_points WHERE timestamp_ms >= ? AND timestamp_ms < ? AND name != 'claude_code.session.count'").all(start, end) as MetricRow[]
    const events = this.db.prepare('SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ?').all(start, end) as EventRow[]
    const slices = new Map<string, AccountSlice>()
    const included = (row: MetricRow | EventRow) => !projects.length || projects.includes(row.project)
    const get = (row: MetricRow | EventRow): AccountSlice => {
      const key = JSON.stringify([row.user_email, row.project, row.session_id])
      let slice = slices.get(key)
      if (!slice) {
        slice = { email: row.user_email, project: row.project, sessionId: row.session_id,
          firstSeen: row.timestamp_ms, lastSeen: row.timestamp_ms, prompts: 0, apiRequests: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          activeUserSeconds: null, activeCliSeconds: null, estimatedCostUsd: null,
          metricTokens: {}, eventCostUsd: 0, eventCostSeen: false }
        slices.set(key, slice)
      }
      slice.firstSeen = Math.min(slice.firstSeen, row.timestamp_ms)
      slice.lastSeen = Math.max(slice.lastSeen, row.timestamp_ms)
      return slice
    }
    for (const row of metrics) {
      if (!included(row)) continue
      const slice = get(row)
      if (row.name === 'claude_code.token.usage') {
        const field = ({ input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadTokens', cacheCreation: 'cacheCreationTokens' } as const)[row.kind as 'input' | 'output' | 'cacheRead' | 'cacheCreation']
        if (field) slice.metricTokens[field] = (slice.metricTokens[field] || 0) + row.value
      } else if (row.name === 'claude_code.active_time.total') {
        if (row.kind === 'user') slice.activeUserSeconds = (slice.activeUserSeconds || 0) + row.value
        if (row.kind === 'cli') slice.activeCliSeconds = (slice.activeCliSeconds || 0) + row.value
      } else if (row.name === 'claude_code.cost.usage') {
        slice.estimatedCostUsd = (slice.estimatedCostUsd || 0) + row.value
      }
    }
    for (const row of events) {
      if (!included(row)) continue
      const slice = get(row)
      if (row.name === 'user_prompt') slice.prompts += 1
      if (row.name !== 'api_request') continue
      slice.apiRequests += 1
      slice.inputTokens += row.input_tokens || 0
      slice.outputTokens += row.output_tokens || 0
      slice.cacheReadTokens += row.cache_read_tokens || 0
      slice.cacheCreationTokens += row.cache_creation_tokens || 0
      if (row.cost_usd !== null) { slice.eventCostUsd += row.cost_usd; slice.eventCostSeen = true }
    }
    const accounts = new Map<string, {
      email: string; sessions: Set<string>; projects: Set<string>; prompts: number; apiRequests: number
      inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number
      activeUserSeconds: number | null; activeCliSeconds: number | null; estimatedCostUsd: number | null
      missingCostSlices: number; firstSeen: number; lastSeen: number
    }>()
    for (const slice of slices.values()) {
      let account = accounts.get(slice.email)
      if (!account) {
        account = { email: slice.email, sessions: new Set(), projects: new Set(), prompts: 0, apiRequests: 0,
          inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
          activeUserSeconds: null, activeCliSeconds: null, estimatedCostUsd: null,
          missingCostSlices: 0, firstSeen: slice.firstSeen, lastSeen: slice.lastSeen }
        accounts.set(slice.email, account)
      }
      account.sessions.add(slice.sessionId)
      account.projects.add(slice.project)
      account.prompts += slice.prompts
      account.apiRequests += slice.apiRequests
      for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const) {
        account[field] += slice.apiRequests ? slice[field] : slice.metricTokens[field] || 0
      }
      for (const field of ['activeUserSeconds', 'activeCliSeconds'] as const) {
        if (slice[field] !== null) account[field] = (account[field] || 0) + slice[field]
      }
      const sliceCost = slice.estimatedCostUsd ?? (slice.eventCostSeen ? slice.eventCostUsd : null)
      if (sliceCost === null) account.missingCostSlices += 1
      else account.estimatedCostUsd = (account.estimatedCostUsd || 0) + sliceCost
      account.firstSeen = Math.min(account.firstSeen, slice.firstSeen)
      account.lastSeen = Math.max(account.lastSeen, slice.lastSeen)
    }
    return { accounts: [...accounts.values()].map(({ sessions, projects, ...account }) => ({
      ...account, sessions: sessions.size, projects: [...projects].sort(),
    })).sort((a, b) => (b.estimatedCostUsd || 0) - (a.estimatedCostUsd || 0) || a.email.localeCompare(b.email)) }
  }

  sessionEvents(sessionId: string, window: TimeWindow, offset = 0, limit = 50) {
    const { start, end } = bounds(window)
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND timestamp_ms >= ? AND timestamp_ms < ?').get(sessionId, start, end) as { count: number }).count
    const rows = this.db.prepare(`SELECT name, timestamp_ms, duration_ms, tool_name, success FROM events
      WHERE session_id = ? AND timestamp_ms >= ? AND timestamp_ms < ? ORDER BY timestamp_ms DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(sessionId, start, end, limit, offset) as Pick<EventRow, 'name' | 'timestamp_ms' | 'duration_ms' | 'tool_name' | 'success'>[]
    return { total, events: rows.map((row) => ({ name: row.name, timestamp: row.timestamp_ms, durationMs: row.duration_ms, toolName: row.tool_name, success: row.success })) }
  }

  sessionPrompts(sessionId: string, window: TimeWindow) {
    const { start, end } = bounds(window)
    const rows = this.db.prepare(`SELECT id, name, timestamp_ms, prompt_id, prompt_text,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd
      FROM events WHERE session_id = ? AND timestamp_ms >= ? AND timestamp_ms < ? AND name IN ('user_prompt', 'api_request')
      ORDER BY timestamp_ms, rowid`).all(sessionId, start, end) as EventRow[]
    const prompts = new Map<string, {
      id: string; timestamp: number; text: string | null; requests: number; tokens: number;
      costUsd: number | null
    }>()
    const missingCost = new Set<string>()
    for (const row of rows) {
      if (row.name !== 'user_prompt') continue
      const key = row.prompt_id || row.id
      prompts.set(key, { id: key, timestamp: row.timestamp_ms, text: row.prompt_text,
        requests: 0, tokens: 0, costUsd: null })
    }
    for (const row of rows) {
      if (row.name !== 'api_request' || !row.prompt_id) continue
      const prompt = prompts.get(row.prompt_id)
      if (!prompt) continue
      prompt.requests += 1
      prompt.tokens += (row.input_tokens || 0) + (row.output_tokens || 0) +
        (row.cache_read_tokens || 0) + (row.cache_creation_tokens || 0)
      if (row.cost_usd === null) missingCost.add(row.prompt_id)
      else if (!missingCost.has(row.prompt_id)) prompt.costUsd = (prompt.costUsd || 0) + row.cost_usd
    }
    for (const id of missingCost) {
      const prompt = prompts.get(id)
      if (prompt) prompt.costUsd = null
    }
    return [...prompts.values()].sort((a, b) => b.timestamp - a.timestamp)
  }
}
