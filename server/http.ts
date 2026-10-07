import { createReadStream, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, relative, resolve, sep } from 'node:path'
import { Store, type TimeWindow } from './store.js'

const MAX_BODY_BYTES = 2_000_000

function json(response: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data)
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  })
  response.end(body)
}

async function body(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, 'Invalid request size')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Invalid request size')
    chunks.push(bytes)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
    return value
  } catch {
    throw new HttpError(400, 'Invalid OTLP JSON')
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function timeWindow(url: URL): TimeWindow {
  const from = url.searchParams.get('from')
  const to = url.searchParams.get('to')
  if (from !== null || to !== null) {
    if (!from || !to || !/^\d+$/.test(from) || !/^\d+$/.test(to)) throw new HttpError(400, 'Invalid time range')
    const start = Number(from)
    const end = Number(to)
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) throw new HttpError(400, 'Invalid time range')
    return { start, end }
  }
  const days = url.searchParams.get('days') || '30'
  if (!['7', '30', '90', 'all'].includes(days)) throw new HttpError(400, 'Invalid period')
  return days === 'all' ? null : Number(days)
}

function localHost(request: IncomingMessage): boolean {
  try {
    const hostname = new URL(`http://${request.headers.host}`).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost'
  } catch { return false }
}

function serveFile(response: ServerResponse, pathname: string, distDir: string): void {
  if (pathname !== '/' && !pathname.startsWith('/assets/')) {
    json(response, { error: 'Not found' }, 404)
    return
  }
  const target = pathname === '/' ? resolve(distDir, 'index.html') : resolve(distDir, pathname.slice(1))
  const fromDist = relative(distDir, target)
  if (fromDist.startsWith(`..${sep}`) || fromDist === '..' || fromDist.startsWith(sep)) {
    json(response, { error: 'Not found' }, 404)
    return
  }
  let size: number
  try {
    const stat = statSync(target)
    if (!stat.isFile()) throw new Error('Not a file')
    size = stat.size
  } catch {
    json(response, { error: pathname === '/' ? 'Run npm run build first' : 'Not found' }, pathname === '/' ? 503 : 404)
    return
  }
  const contentType = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' } as Record<string, string>)[extname(target)] || 'application/octet-stream'
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
  })
  createReadStream(target).pipe(response)
}

export function createServers(store: Store, distDir: string): { otlp: Server; dashboard: Server } {
  const otlp = createServer(async (request, response) => {
    if (!localHost(request)) { json(response, { error: 'Invalid host' }, 403); return }
    if (request.method !== 'POST' || (request.url !== '/v1/metrics' && request.url !== '/v1/logs')) {
      json(response, { error: 'Not found' }, 404)
      return
    }
    if (!request.headers['content-type']?.startsWith('application/json')) {
      json(response, { error: 'Use OTLP HTTP/JSON' }, 415)
      return
    }
    try {
      const payload = await body(request)
      if (request.url === '/v1/metrics') store.ingestMetrics(payload)
      else store.ingestLogs(payload)
      json(response, {})
    } catch (error) {
      if (error instanceof HttpError) json(response, { error: error.message }, error.status)
      else {
        console.error('OTLP ingest failed:', error)
        json(response, { error: 'Internal error' }, 500)
      }
    }
  })

  const dashboard = createServer((request, response) => {
    if (!localHost(request)) { json(response, { error: 'Invalid host' }, 403); return }
    let url: URL
    try { url = new URL(request.url || '/', 'http://127.0.0.1') }
    catch { json(response, { error: 'Invalid URL' }, 400); return }
    const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname)
    if (request.method === 'DELETE' && sessionMatch) {
      try {
        const sessionId = decodeURIComponent(sessionMatch[1])
        if (!store.deleteSession(sessionId)) { json(response, { error: 'Session not found' }, 404); return }
        response.writeHead(204, { 'Cache-Control': 'no-store' })
        response.end()
      } catch (error) {
        if (error instanceof URIError) { json(response, { error: 'Invalid session ID' }, 400); return }
        console.error('Session delete failed:', error)
        json(response, { error: 'Internal error' }, 500)
      }
      return
    }
    if (request.method !== 'GET') { json(response, { error: 'Not found' }, 404); return }
    if (url.pathname === '/api/sessions') {
      try { json(response, store.sessions(timeWindow(url))) }
      catch (error) { if (error instanceof HttpError) { json(response, { error: error.message }, error.status); return }
        console.error('Dashboard query failed:', error); json(response, { error: 'Internal error' }, 500) }
      return
    }
    if (url.pathname === '/api/accounts') {
      try { json(response, store.accounts(timeWindow(url), url.searchParams.getAll('project'))) }
      catch (error) { if (error instanceof HttpError) { json(response, { error: error.message }, error.status); return }
        console.error('Account query failed:', error); json(response, { error: 'Internal error' }, 500) }
      return
    }
    const promptsMatch = /^\/api\/sessions\/([^/]+)\/prompts$/.exec(url.pathname)
    if (promptsMatch) {
      try {
        const sessionId = decodeURIComponent(promptsMatch[1])
        json(response, store.sessionPrompts(sessionId, timeWindow(url)))
      } catch (error) {
        if (error instanceof HttpError) { json(response, { error: error.message }, error.status); return }
        console.error('Prompt query failed:', error)
        json(response, { error: 'Internal error' }, 500)
      }
      return
    }
    const eventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname)
    if (eventsMatch) {
      const rawOffset = url.searchParams.get('offset') || '0'
      if (!/^\d+$/.test(rawOffset)) {
        json(response, { error: 'Invalid activity query' }, 400)
        return
      }
      try {
        const sessionId = decodeURIComponent(eventsMatch[1])
        json(response, store.sessionEvents(sessionId, timeWindow(url), Math.min(Number(rawOffset), 1_000_000)))
      } catch (error) {
        if (error instanceof HttpError) { json(response, { error: error.message }, error.status); return }
        console.error('Activity query failed:', error)
        json(response, { error: 'Internal error' }, 500)
      }
      return
    }
    serveFile(response, url.pathname, distDir)
  })
  return { otlp, dashboard }
}
