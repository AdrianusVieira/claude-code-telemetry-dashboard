import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { Store } from './store.js'
import { TitleScanner } from './titles.js'

const attrs = (values: Record<string, string | number>) => Object.entries(values).map(([key, value]) => ({ key, value: { stringValue: String(value) } }))
const now = () => String(Date.now() * 1_000_000)

function metric(name: string, value: number, kind = '') {
  return { resourceMetrics: [{
    resource: { attributes: attrs({ 'project.id': 'project-a', 'user.email': 'me@example.com' }) },
    scopeMetrics: [{ metrics: [{ name, sum: { aggregationTemporality: 1, dataPoints: [{
      timeUnixNano: now(), ...(Number.isInteger(value) ? { asInt: String(value) } : { asDouble: value }),
      attributes: attrs({ 'session.id': 'session-1', type: kind }),
    }] } }] }],
  }] }
}

function log(name: string, fields: Record<string, string | number> = {}) {
  return { resourceLogs: [{
    resource: { attributes: attrs({ 'project.id': 'project-a', 'user.email': 'me@example.com' }) },
    scopeLogs: [{ logRecords: [{ timeUnixNano: now(),
      attributes: attrs({ 'session.id': 'session-1', 'event.name': name, model: 'claude-sonnet-test', ...fields }),
      body: { stringValue: 'private body' },
    }] }],
  }] }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'claude-dashboard-test-'))
  const dbPath = join(dir, 'telemetry.sqlite3')
  const store = new Store(dbPath)
  return { dir, dbPath, store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('aggregates metrics and events by chat without counting duplicate exports', () => {
  const f = fixture()
  try {
    const tokenMetric = metric('claude_code.token.usage', 12, 'input')
    assert.equal(f.store.ingestMetrics(tokenMetric), 1)
    assert.equal(f.store.ingestMetrics(tokenMetric), 0)
    f.store.ingestMetrics(metric('claude_code.active_time.total', 24, 'cli'))
    f.store.ingestLogs(log('api_request', { input_tokens: 12, output_tokens: 3, duration_ms: 800, cost_usd: 0.02 }))
    const result = f.store.sessions().sessions[0]
    assert.equal(result.inputTokens, 12)
    assert.equal(result.outputTokens, 3)
    assert.equal(result.activeCliSeconds, 24)
    assert.equal(result.medianRequestMs, 800)
    assert.equal(result.estimatedCostUsd, 0.02)
    assert.equal(result.project, 'project-a')
    assert.equal(result.email, 'me@example.com')
  } finally { f.close() }
})

test('cost metric takes precedence over event estimate', () => {
  const f = fixture()
  try {
    f.store.ingestLogs(log('api_request', { cost_usd: 0.1 }))
    f.store.ingestMetrics(metric('claude_code.cost.usage', 0.03))
    assert.equal(f.store.sessions().sessions[0].estimatedCostUsd, 0.03)
  } finally { f.close() }
})

test('counts prompts, builds a token timeline, and pages full activity', () => {
  const f = fixture()
  try {
    f.store.ingestLogs(log('user_prompt', { 'prompt.id': 'prompt-one' }))
    f.store.ingestLogs(log('user_prompt', { 'prompt.id': 'prompt-two' }))
    f.store.ingestLogs(log('api_request', { 'prompt.id': 'prompt-two', input_tokens: 7, output_tokens: 3, cache_read_tokens: 20 }))
    for (let index = 0; index < 53; index++) f.store.ingestLogs(log('tool_result', { duration_ms: index }))
    const session = f.store.sessions().sessions[0]
    assert.equal(session.prompts, 2)
    assert.equal(session.apiRequests, 1)
    assert.equal(session.tokenTimeline[0].cacheRead, 20)
    assert.equal(session.tokenTimeline[0].promptId, 'prompt-two')
    assert.equal(session.activityCount, 56)
    assert.equal(session.recentEvents.length, 12)
    const first = f.store.sessionEvents('session-1', 30)
    const second = f.store.sessionEvents('session-1', 30, 50)
    assert.equal(first.total, 56)
    assert.equal(first.events.length, 50)
    assert.equal(second.events.length, 6)
  } finally { f.close() }
})

test('applies a half-open custom range to sessions, prompts, and activity', () => {
  const f = fixture()
  try {
    const start = Date.now() - 60_000
    const inside = log('user_prompt', { 'prompt.id': 'inside' })
    inside.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano = String(start * 1_000_000)
    const outside = log('user_prompt', { 'prompt.id': 'outside' })
    outside.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano = String((start + 1000) * 1_000_000)
    f.store.ingestLogs(inside)
    f.store.ingestLogs(outside)
    const window = { start, end: start + 1000 }
    assert.equal(f.store.sessions(window).sessions[0].prompts, 1)
    assert.equal(f.store.sessionPrompts('session-1', window).length, 1)
    assert.equal(f.store.sessionEvents('session-1', window).total, 1)
  } finally { f.close() }
})

test('deletes a session and ignores later telemetry for its ID', () => {
  const f = fixture()
  try {
    const tokenMetric = metric('claude_code.token.usage', 12, 'input')
    const promptEvent = log('user_prompt', { 'prompt.id': 'prompt-one' })
    f.store.ingestMetrics(tokenMetric)
    f.store.ingestLogs(promptEvent)
    f.store.setTitle('session-1', 'Deleted chat', Date.now())
    assert.equal(f.store.deleteSession('session-1'), true)
    assert.equal(f.store.sessions().sessions.length, 0)
    assert.equal(f.store.sessionEvents('session-1', 30).total, 0)
    assert.equal(f.store.sessionPrompts('session-1', 30).length, 0)
    assert.equal(f.store.ingestMetrics(tokenMetric), 0)
    assert.equal(f.store.ingestLogs(promptEvent), 0)
    f.store.setTitle('session-1', 'Restored title', Date.now())
    assert.equal(f.store.deleteSession('session-1'), false)
    const db = new Database(f.dbPath, { readonly: true })
    try { assert.equal((db.prepare('SELECT COUNT(*) AS count FROM titles WHERE session_id = ?').get('session-1') as { count: number }).count, 0) }
    finally { db.close() }
    f.store.close()
    const reopened = new Store(f.dbPath)
    try {
      assert.equal(reopened.ingestMetrics(tokenMetric), 0)
      assert.equal(reopened.ingestLogs(promptEvent), 0)
      assert.equal(reopened.sessions().sessions.length, 0)
    } finally { reopened.close() }
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('discard sensitive fields and unknown events', () => {
  const f = fixture()
  try {
    f.store.ingestLogs(log('api_request', { user_prompt: 'SECRET-PROMPT', api_request_body: 'SECRET-BODY', duration_ms: 300 }))
    f.store.ingestLogs(log('api_request_body', { body: 'SECRET-BODY' }))
    const db = new Database(f.dbPath, { readonly: true })
    try {
      const rows = db.prepare('SELECT * FROM events').all()
      assert.equal(rows.length, 1)
      assert.doesNotMatch(JSON.stringify(rows), /SECRET-PROMPT|SECRET-BODY/)
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='events'").get() as { sql: string }
      assert.doesNotMatch(schema.sql, /body/)
    } finally { db.close() }
  } finally { f.close() }
})

test('stores only sanitized prompts and links request costs by prompt ID', () => {
  const f = fixture()
  try {
    const first = log('user_prompt', { 'prompt.id': 'prompt-one', prompt: 'Fix timeout. API_KEY=plain-secret-value' })
    assert.equal(f.store.ingestLogs(first), 1)
    assert.equal(f.store.ingestLogs(first), 0)
    f.store.ingestLogs(log('api_request', { 'prompt.id': 'prompt-one', input_tokens: 10, output_tokens: 5, cost_usd: 0.03 }))
    f.store.ingestLogs(log('api_request', { 'prompt.id': 'prompt-one', input_tokens: 7, cost_usd: 0.02 }))
    f.store.ingestLogs(log('user_prompt', { 'prompt.id': 'prompt-two', prompt: 'Review the query' }))
    const prompts = f.store.sessionPrompts('session-1', 30)
    assert.equal(prompts.length, 2)
    const firstPrompt = prompts.find((prompt) => prompt.id === 'prompt-one')!
    const secondPrompt = prompts.find((prompt) => prompt.id === 'prompt-two')!
    assert.equal(secondPrompt.text, 'Review the query')
    assert.equal(firstPrompt.tokens, 22)
    assert.equal(firstPrompt.costUsd, 0.05)
    assert.match(firstPrompt.text!, /Fix timeout/)
    assert.doesNotMatch(JSON.stringify(prompts), /plain-secret-value/)
    const db = new Database(f.dbPath, { readonly: true })
    try { assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM events').all()), /plain-secret-value/) }
    finally { db.close() }
  } finally { f.close() }
})

test('an unknown request cost makes the prompt cost unavailable', () => {
  const f = fixture()
  try {
    f.store.ingestLogs(log('user_prompt', { 'prompt.id': 'prompt-one', prompt: 'Review this query' }))
    f.store.ingestLogs(log('api_request', { 'prompt.id': 'prompt-one', cost_usd: 0.01 }))
    f.store.ingestLogs(log('api_request', { 'prompt.id': 'prompt-one', input_tokens: 3 }))
    assert.equal(f.store.sessionPrompts('session-1', 30)[0].costUsd, null)
  } finally { f.close() }
})

test('migrates an existing events table to add sanitized prompt storage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-dashboard-migrate-'))
  const path = join(dir, 'old.sqlite3')
  const db = new Database(path)
  db.exec(`CREATE TABLE events (
    id TEXT PRIMARY KEY, timestamp_ms INTEGER NOT NULL, name TEXT NOT NULL,
    session_id TEXT NOT NULL, project TEXT NOT NULL, user_email TEXT NOT NULL,
    model TEXT NOT NULL, duration_ms REAL, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_creation_tokens INTEGER, cost_usd REAL,
    tool_name TEXT, success TEXT, prompt_id TEXT
  )`)
  db.close()
  const store = new Store(path)
  try {
    const migrated = new Database(path, { readonly: true })
    try { assert.equal((migrated.pragma('table_info(events)') as { name: string }[]).some((column) => column.name === 'prompt_text'), true) }
    finally { migrated.close() }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('skip cumulative metrics and session start metrics', () => {
  const f = fixture()
  try {
    const cumulative = metric('claude_code.token.usage', 3, 'input')
    cumulative.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality = 2
    assert.equal(f.store.ingestMetrics(cumulative), 0)
    assert.equal(f.store.ingestMetrics(metric('claude_code.session.count', 1, 'fresh')), 0)
    assert.equal(f.store.ingestMetrics(metric('claude_code.session.count', 1, 'agents_view')), 0)
    assert.equal(f.store.sessions().sessions.length, 0)
  } finally { f.close() }
})

test('removes previously stored session start metrics', () => {
  const f = fixture()
  try {
    const db = new Database(f.dbPath)
    try {
      const insert = db.prepare(`INSERT INTO metric_points
        (id, timestamp_ms, name, session_id, project, user_email, kind, model, value)
        VALUES (?, ?, ?, ?, 'project-a', '', '', '', 1)`)
      insert.run('old-start', Date.now(), 'claude_code.session.count', 'start-only')
      insert.run('old-token', Date.now(), 'claude_code.token.usage', 'other-session')
    } finally { db.close() }
    assert.deepEqual(f.store.sessions().sessions.map((session) => session.id), ['other-session'])
    f.store.close()
    const reopened = new Store(f.dbPath)
    try {
      const data = reopened.sessions()
      assert.deepEqual(data.sessions.map((session) => session.id), ['other-session'])
      assert.equal('sessionStarts' in data, false)
      assert.equal('starts' in data.sessions[0], false)
      const db = new Database(f.dbPath, { readonly: true })
      try { assert.equal((db.prepare("SELECT COUNT(*) AS count FROM metric_points WHERE name = 'claude_code.session.count'").get() as { count: number }).count, 0) }
      finally { db.close() }
    } finally { reopened.close() }
  } finally { rmSync(f.dir, { recursive: true, force: true }) }
})

test('read a custom chat title from local transcript metadata', async () => {
  const f = fixture()
  try {
    const projectDir = join(f.dir, '.claude', 'projects', 'project-a')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'session-1.jsonl'), `${JSON.stringify({ type: 'custom-title', customTitle: 'Ticket X', sessionId: 'session-1' })}\n`)
    f.store.ingestMetrics(metric('claude_code.token.usage', 1, 'input'))
    await new TitleScanner(f.store, join(f.dir, '.claude')).scan()
    assert.equal(f.store.sessions().sessions[0].title, 'Ticket X')
  } finally { f.close() }
})
