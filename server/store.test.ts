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
    const start = metric('claude_code.session.count', 1, 'fresh')
    assert.equal(f.store.ingestMetrics(start), 1)
    assert.equal(f.store.ingestMetrics(start), 0)
    f.store.ingestMetrics(metric('claude_code.token.usage', 12, 'input'))
    f.store.ingestMetrics(metric('claude_code.active_time.total', 24, 'cli'))
    f.store.ingestLogs(log('api_request', { input_tokens: 12, output_tokens: 3, duration_ms: 800, cost_usd: 0.02 }))
    const result = f.store.sessions().sessions[0]
    assert.equal(result.starts, 1)
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
    f.store.ingestLogs(log('api_request', { input_tokens: 7, output_tokens: 3, cache_read_tokens: 20 }))
    for (let index = 0; index < 53; index++) f.store.ingestLogs(log('tool_result', { duration_ms: index }))
    const session = f.store.sessions().sessions[0]
    assert.equal(session.prompts, 2)
    assert.equal(session.apiRequests, 1)
    assert.equal(session.tokenTimeline[0].cacheRead, 20)
    assert.equal(session.activityCount, 56)
    assert.equal(session.recentEvents.length, 12)
    const first = f.store.sessionEvents('session-1', 30)
    const second = f.store.sessionEvents('session-1', 30, 50)
    assert.equal(first.total, 56)
    assert.equal(first.events.length, 50)
    assert.equal(second.events.length, 6)
  } finally { f.close() }
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

test('skip cumulative metrics and agents view launches', () => {
  const f = fixture()
  try {
    const cumulative = metric('claude_code.session.count', 3)
    cumulative.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.aggregationTemporality = 2
    assert.equal(f.store.ingestMetrics(cumulative), 0)
    f.store.ingestMetrics(metric('claude_code.session.count', 1, 'agents_view'))
    assert.equal(f.store.sessions().sessions.length, 0)
  } finally { f.close() }
})

test('read a custom chat title from local transcript metadata', async () => {
  const f = fixture()
  try {
    const projectDir = join(f.dir, '.claude', 'projects', 'project-a')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'session-1.jsonl'), `${JSON.stringify({ type: 'custom-title', customTitle: 'Ticket X', sessionId: 'session-1' })}\n`)
    f.store.ingestMetrics(metric('claude_code.session.count', 1))
    await new TitleScanner(f.store, join(f.dir, '.claude')).scan()
    assert.equal(f.store.sessions().sessions[0].title, 'Ticket X')
  } finally { f.close() }
})
