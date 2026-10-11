import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { type Server } from 'node:http'
import { createServers } from './http.js'
import { Store } from './store.js'
import { TitleScanner } from './titles.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const { values } = parseArgs({ options: {
  'dashboard-port': { type: 'string', default: '41300' },
  'otlp-port': { type: 'string', default: '4318' },
  db: { type: 'string', default: join(root, 'data', 'telemetry.sqlite3') },
  'claude-dir': { type: 'string', default: join(homedir(), '.claude') },
} })

function port(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error(`Invalid port: ${value}`)
  return parsed
}

function listen(server: Server, value: number): Promise<void> {
  return new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(value, '127.0.0.1', () => { server.removeListener('error', fail); done() })
  })
}

const dashboardPort = port(values['dashboard-port'])
const otlpPort = port(values['otlp-port'])
const store = new Store(resolve(values.db!))
const scanner = new TitleScanner(store, resolve(values['claude-dir']!))
const servers = createServers(store, join(root, 'dist'))

try {
  await listen(servers.otlp, otlpPort)
  await listen(servers.dashboard, dashboardPort)
  console.log(`Dashboard: http://127.0.0.1:${dashboardPort}`)
  console.log(`OTLP HTTP/JSON: http://127.0.0.1:${otlpPort}`)
  void scanner.scan().catch((error) => console.error('Title scan failed:', error))
  const scanInterval = setInterval(() => void scanner.scan().catch((error) => console.error('Title scan failed:', error)), 30_000)
  const stop = () => {
    clearInterval(scanInterval)
    servers.dashboard.close()
    servers.otlp.close()
    store.close()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
} catch (error) {
  servers.dashboard.close()
  servers.otlp.close()
  store.close()
  console.error(error)
  process.exitCode = 1
}
