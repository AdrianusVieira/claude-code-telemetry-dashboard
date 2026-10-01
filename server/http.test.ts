import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { request as httpRequest, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createServers } from './http.js'
import { Store } from './store.js'

const listen = (server: Server) => new Promise<number>((done) => server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP address')
  done(address.port)
}))
const close = (server: Server) => new Promise<void>((done) => server.close(() => done()))

test('OTLP HTTP/JSON reaches SQLite and the dashboard API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-dashboard-http-'))
  const store = new Store(join(dir, 'db.sqlite3'))
  const { otlp, dashboard } = createServers(store, join(process.cwd(), 'dist'))
  try {
    const otlpPort = await listen(otlp)
    const dashboardPort = await listen(dashboard)
    const timestamp = String(Date.now() * 1_000_000)
    const payload = { resourceMetrics: [{
      resource: { attributes: [{ key: 'project.id', value: { stringValue: 'pilot' } }] },
      scopeMetrics: [{ metrics: [{ name: 'claude_code.session.count', sum: { aggregationTemporality: 1, dataPoints: [{
        timeUnixNano: timestamp, asInt: '1', attributes: [{ key: 'session.id', value: { stringValue: 'pilot-chat' } }],
      }] } }] }],
    }] }
    const posted = await fetch(`http://127.0.0.1:${otlpPort}/v1/metrics`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    assert.equal(posted.status, 200)
    const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/sessions?days=30`)
    const data = await response.json() as { sessions: { project: string; starts: number }[] }
    assert.equal(data.sessions[0].project, 'pilot')
    assert.equal(data.sessions[0].starts, 1)
    const page = await fetch(`http://127.0.0.1:${dashboardPort}/`)
    assert.equal(page.status, 200)
    assert.match(await page.text(), /Claude Code telemetry/)
    const invalid = await fetch(`http://127.0.0.1:${dashboardPort}/api/sessions?days=banana`)
    assert.equal(invalid.status, 400)
    const secret = 'sensitive-local-value'
    const logPayload = { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: [{
      timeUnixNano: timestamp, attributes: [
        { key: 'event.name', value: { stringValue: 'user_prompt' } },
        { key: 'session.id', value: { stringValue: 'pilot-chat' } },
        { key: 'prompt.id', value: { stringValue: 'prompt-1' } },
        { key: 'prompt', value: { stringValue: `Investigate latency. API_KEY=${secret}` } },
      ],
    }] }] }] }
    const logPosted = await fetch(`http://127.0.0.1:${otlpPort}/v1/logs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(logPayload) })
    assert.equal(logPosted.status, 200)
    const prompts = await fetch(`http://127.0.0.1:${dashboardPort}/api/sessions/pilot-chat/prompts?days=30`)
    assert.equal(prompts.status, 200)
    const promptBody = await prompts.text()
    assert.match(promptBody, /Investigate latency/)
    assert.doesNotMatch(promptBody, /sensitive-local-value/)
    const rebindingStatus = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: dashboardPort, path: '/api/sessions/pilot-chat/prompts', headers: { Host: 'attacker.example' } }, (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode || 0))
      })
      request.on('error', reject)
      request.end()
    })
    assert.equal(rebindingStatus, 403)
  } finally {
    await Promise.all([close(otlp), close(dashboard)])
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
