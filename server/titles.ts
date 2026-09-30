import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Store } from './store.js'

function entries(path: string) {
  try { return readdirSync(path, { withFileTypes: true }) }
  catch { return [] }
}

export class TitleScanner {
  private seen = new Map<string, number>()
  private scanning = false

  constructor(private store: Store, private claudeDir: string) {}

  async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const projects = join(this.claudeDir, 'projects')
      for (const project of entries(projects)) {
        if (!project.isDirectory()) continue
        const projectPath = join(projects, project.name)
        for (const entry of entries(projectPath)) {
          const path = join(projectPath, entry.name)
          if (entry.isFile() && entry.name.endsWith('.jsonl')) await this.scanTranscript(path, entry.name.slice(0, -6))
          if (entry.isDirectory()) this.scanCustomTitle(join(path, 'custom-title.json'), entry.name)
        }
      }
    } finally {
      this.scanning = false
    }
  }

  private async scanTranscript(path: string, sessionId: string): Promise<void> {
    try {
      const modified = statSync(path).mtimeMs
      if (this.seen.get(path) === modified) return
      let title: string | undefined
      const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
      for await (const line of lines) {
        if (!line.includes('"custom-title"')) continue
        try {
          const record = JSON.parse(line)
          if (record.type === 'custom-title' && typeof record.customTitle === 'string' &&
              (record.sessionId === undefined || record.sessionId === sessionId)) title = record.customTitle
        } catch { /* Ignore incomplete transcript lines. */ }
      }
      if (title) this.store.setTitle(sessionId, title, modified)
      this.seen.set(path, modified)
    } catch { /* A transcript can disappear while Claude Code rotates files. */ }
  }

  private scanCustomTitle(path: string, sessionId: string): void {
    try {
      const modified = statSync(path).mtimeMs
      if (this.seen.get(path) === modified) return
      const record = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof record.customTitle === 'string') this.store.setTitle(sessionId, record.customTitle, modified)
      this.seen.set(path, modified)
    } catch { /* This title format is optional. */ }
  }
}
