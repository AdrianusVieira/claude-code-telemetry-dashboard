export type UsageRequest = { input: number; output: number; cacheRead: number; cacheWrite: number }
export type UsagePrompt = { id: string; text: string | null; requests: number; tokens: number }

export type SimilarPromptPair = { first: UsagePrompt; second: UsagePrompt; score: number }

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const stopWords = new Set([
  'and', 'are', 'can', 'for', 'from', 'how', 'please', 'that', 'the', 'this', 'with', 'you',
  'com', 'como', 'dos', 'das', 'esse', 'essa', 'este', 'esta', 'para', 'por', 'que', 'uma',
  'redacted',
])

function words(text: string): Set<string> {
  return new Set((text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])
    .filter((word) => !stopWords.has(word)))
}

function wordingSimilarity(first: Set<string>, second: Set<string>): number {
  if (first.size < 2 || second.size < 2) return 0
  let common = 0
  for (const word of first) if (second.has(word)) common += 1
  return common / (first.size + second.size - common)
}

export function summarizeUsage(requests: UsageRequest[], prompts: UsagePrompt[]) {
  const requestValues = requests.map((request) => request.input + request.output + request.cacheRead + request.cacheWrite)
  const linkedPrompts = prompts.filter((prompt) => prompt.requests > 0)
  const promptValues = linkedPrompts.map((prompt) => prompt.tokens)
  const requestTotal = requestValues.reduce((sum, value) => sum + value, 0)
  const promptTotal = promptValues.reduce((sum, value) => sum + value, 0)
  const requestAverage = requestValues.length ? requestTotal / requestValues.length : null
  const promptAverage = promptValues.length ? promptTotal / promptValues.length : null
  const aboveAverage = promptAverage === null ? [] : linkedPrompts.filter((prompt) => prompt.tokens > promptAverage)
    .sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id))
  const aboveTotal = aboveAverage.reduce((sum, prompt) => sum + prompt.tokens, 0)
  const candidates = aboveAverage.filter((prompt) => prompt.text && words(prompt.text).size >= 2).slice(0, 50)
  const wordSets = candidates.map((prompt) => words(prompt.text!))
  const similarPairs: SimilarPromptPair[] = []
  for (let first = 0; first < candidates.length; first++) {
    for (let second = first + 1; second < candidates.length; second++) {
      const score = wordingSimilarity(wordSets[first], wordSets[second])
      if (score >= 0.4) similarPairs.push({ first: candidates[first], second: candidates[second], score })
    }
  }
  similarPairs.sort((a, b) => b.score - a.score || b.first.tokens + b.second.tokens - a.first.tokens - a.second.tokens)
  return {
    requestCount: requestValues.length, requestAverage, requestMedian: median(requestValues),
    linkedPromptCount: linkedPrompts.length, promptCount: prompts.length,
    promptAverage, promptMedian: median(promptValues),
    aboveAverage, aboveTotal, promptTotal, comparableCount: candidates.length,
    similarPairs: similarPairs.slice(0, 3),
  }
}
